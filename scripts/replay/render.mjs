import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { loadReplayFixture } from './fixture.mjs';
import { createReplayServer } from './server.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function parseArgs(argv) {
  const options = {
    input: path.join(repoRoot, 'replays/checkout-latency.json'),
    output: path.join(repoRoot, 'out/replay-sample.mp4'),
    proof: path.join(repoRoot, 'out/replay-proof.png'),
    fps: 30,
    width: 1920,
    height: 1080,
    keepFrames: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') options.input = path.resolve(argv[++index]);
    else if (arg === '--output') options.output = path.resolve(argv[++index]);
    else if (arg === '--proof') options.proof = path.resolve(argv[++index]);
    else if (arg === '--fps') options.fps = Number(argv[++index]);
    else if (arg === '--width') options.width = Number(argv[++index]);
    else if (arg === '--height') options.height = Number(argv[++index]);
    else if (arg === '--keep-frames') options.keepFrames = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (![24, 30, 60].includes(options.fps)) throw new Error('--fps must be 24, 30, or 60');
  return options;
}

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    chromium.executablePath(),
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('Chrome/Chromium not found. Set CHROME_PATH to an executable.');
  return found;
}

function run(command, args, cwd = repoRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const expanded = loadReplayFixture(options.input);
  const fixture = expanded.fixture;
  const webRoot = path.join(repoRoot, 'web/dist');
  if (!fs.existsSync(path.join(webRoot, 'index.html'))) {
    throw new Error('web/dist is missing. Run `pnpm build:web` before the recorder.');
  }

  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.mkdirSync(path.dirname(options.proof), { recursive: true });
  const framesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'macaron-replay-frames-'));
  const server = createReplayServer({ expanded, webRoot });
  const origin = await server.listen();
  const browser = await chromium.launch({
    executablePath: chromePath(),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: options.width, height: options.height },
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
      colorScheme: 'light',
    });
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = new Set();
    const responseErrors = new Set();
    page.on('pageerror', (error) => pageErrors.push(error));
    page.on('response', (response) => {
      if (response.status() < 400) return;
      const failure = `${response.status()} ${response.url()}`;
      responseErrors.add(failure);
      process.stderr.write(`[browser] ${failure}\n`);
    });
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
        consoleErrors.add(message.text());
        process.stderr.write(`[browser] ${message.text()}\n`);
      }
    });

    const canvas = {
      tiles: [{ sid: fixture.workspace.sessionId, colSpan: 12, rowSpan: 14 }],
      focusedSid: fixture.workspace.sessionId,
    };
    await page.addInitScript(({ project, value }) => {
      localStorage.setItem(`macaron.canvas.${project}`, JSON.stringify(value));
      localStorage.setItem('macaron.theme', 'light');
    }, { project: fixture.workspace.project, value: canvas });

    const route = `/#/w/${encodeURIComponent(fixture.workspace.project)}/s/${encodeURIComponent(fixture.workspace.sessionId)}`;
    await page.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ws-tile .session-view', { state: 'visible', timeout: 15_000 });
    await server.waitForLiveClient();

    const frameCount = Math.round(fixture.duration * options.fps);
    for (let frame = 0; frame < frameCount; frame += 1) {
      const time = frame / options.fps;
      const emitted = server.advance(time);
      if (emitted.length > 0) {
        const finalRender = emitted.some((item) => item.event.type === 'tool_input_done');
        const renderChunk = emitted.some((item) => item.event.type === 'tool_input_delta');
        await page.waitForTimeout(finalRender ? 420 : renderChunk ? 110 : 45);
        const visibleRendererErrors = await page
          .locator('.ti-genui [data-genui-render-host]:visible')
          .allTextContents();
        if (visibleRendererErrors.some((text) => text.trim() === 'ERROR')) {
          throw new Error(`Production GenUI exposed a transient ERROR frame at ${time.toFixed(3)}s`);
        }
      }
      const filename = path.join(framesDir, `${String(frame).padStart(6, '0')}.jpg`);
      await page.screenshot({ path: filename, type: 'jpeg', quality: 90 });
      if (frame % options.fps === 0) {
        process.stdout.write(`Captured ${frame}/${frameCount} frames (${time.toFixed(1)}s)\n`);
      }
    }

    await page.screenshot({ path: options.proof, type: 'png' });
    if (pageErrors.length > 0) throw new AggregateError(pageErrors, 'The production web app raised browser errors during replay');
    if (consoleErrors.size > 0) throw new Error(`The production web app logged browser errors during replay:\n${[...consoleErrors].join('\n')}`);
    const localResponseErrors = [...responseErrors].filter((failure) => failure.includes(origin));
    if (localResponseErrors.length > 0) {
      throw new Error(`The production web app requested missing replay resources:\n${localResponseErrors.join('\n')}`);
    }
    await context.close();

    await run('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-framerate', String(options.fps),
      '-i', path.join(framesDir, '%06d.jpg'),
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      options.output,
    ]);
    process.stdout.write(`Rendered the production Macaron UI to ${options.output}\n`);
  } finally {
    await browser.close();
    await server.close();
    if (!options.keepFrames) fs.rmSync(framesDir, { recursive: true, force: true });
    else process.stdout.write(`Kept frames at ${framesDir}\n`);
  }
}

await main();

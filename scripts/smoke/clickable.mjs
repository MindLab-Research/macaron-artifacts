// Clickability check for model-generated GenUI widgets.
//
// Takes TSX files (as produced by a real render_ui call) and, for each one:
//   1. compiles + mounts it through the production renderer (web/clickable.html)
//   2. asserts a real <button> exists and is visible/enabled
//   3. dispatches a REAL Playwright click and asserts sendUserMessage fired
//      with a non-empty prompt
//   4. asserts the page logged no errors
//
// This is the part jsdom can't cover: whether the import map resolves
// '$macaron/ui' and '$macaron/chat' for code the model wrote, and whether a
// click on a real styled Button reaches the host.
//
// With --countdown <seconds>, a file is instead checked for the useAutoSend
// branch: the remaining seconds must visibly tick DOWN on the button and the
// prompt must auto-fire exactly once, with no click at all.
//
// Usage: node scripts/smoke/clickable.mjs <file.tsx> [more.tsx …]
//        node scripts/smoke/clickable.mjs --countdown 4 <file.tsx>
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = path.join(repoRoot, 'web/dist');
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
};

function chromePath() {
  const found = [process.env.CHROME_PATH, '/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser']
    .filter(Boolean)
    .find((p) => fs.existsSync(p));
  if (!found) throw new Error('Chromium not found; set CHROME_PATH');
  return found;
}

function serveDist() {
  const server = http.createServer((req, res) => {
    let p = path.join(DIST, decodeURIComponent(req.url.split('?')[0]));
    if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(DIST, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] ?? 'application/octet-stream' });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, port: server.address().port })));
}

const argv = process.argv.slice(2);
const countdownAt = argv.indexOf('--countdown');
const countdownSeconds = countdownAt === -1 ? 0 : Number(argv[countdownAt + 1]);
// Guard the -1 case explicitly: `i !== countdownAt + 1` alone drops argv[0] when
// the flag is absent, silently skipping the first file in every plain run.
const files = argv.filter((_, i) => countdownAt === -1 || (i !== countdownAt && i !== countdownAt + 1));
if (files.length === 0) {
  console.error('usage: node scripts/smoke/clickable.mjs <file.tsx> […]');
  process.exit(2);
}

const { server, port } = await serveDist();
const browser = await chromium.launch({ executablePath: chromePath(), args: ['--no-sandbox'] });
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text());
});

await page.goto(`http://127.0.0.1:${port}/clickable.html`, { waitUntil: 'load' });
await page.waitForFunction(() => !!window.__harness, { timeout: 30_000 });

let failed = 0;
for (const file of files) {
  const name = path.basename(file);
  const code = fs.readFileSync(path.resolve(file), 'utf8');
  pageErrors.length = 0;
  // Unmount the previous widget and WAIT for its button to detach first. Without
  // this the waitForSelector below matches the widget still on screen, so every
  // file after the first silently re-tests file #1 and the batch always passes.
  await page.evaluate(() => window.__harness.reset());
  await page.waitForSelector('.genui-host button', { state: 'detached', timeout: 10_000 });
  await page.evaluate((c) => window.__harness.setCode(c), code);

  // Mounted = a real button exists in the rendered widget. The TSX compiler and
  // import-map resolution both have to succeed to get here.
  let mounted = true;
  try {
    await page.waitForSelector('.genui-host button', { state: 'visible', timeout: 30_000 });
  } catch {
    mounted = false;
  }
  if (!mounted) {
    const status = await page.evaluate(() => document.querySelector('.genui-host')?.textContent?.slice(0, 200) ?? '');
    console.log(`✖ ${name}: no button mounted — ${status}`);
    console.log(`   errors: ${pageErrors.slice(0, 3).join(' | ')}`);
    failed += 1;
    continue;
  }

  const buttons = page.locator('.genui-host button');
  const count = await buttons.count();

  if (countdownSeconds) {
    // Sample the button label across the countdown window. Two different values
    // with the last lower than the first is the real assertion: a frozen or
    // re-arming timer shows one constant number and never reaches zero.
    const labels = [];
    for (let i = 0; i < countdownSeconds * 2 + 2; i++) {
      const text = await page.evaluate(() => document.querySelector('.genui-host')?.textContent ?? '');
      const m = text.match(/\((\d+)s\)/);
      if (m) labels.push(Number(m[1]));
      await page.waitForTimeout(700);
    }
    const sent = await page.evaluate(() => window.__harness.sent);
    const errors = pageErrors.filter((e) => !/favicon|manifest|sw\.js|preload/i.test(e));
    const ok = labels.length >= 2 && labels[0] > labels.at(-1) && sent.length === 1 && errors.length === 0;
    if (!ok) failed += 1;
    console.log(`${ok ? '✔' : '✖'} ${name}: countdown ${labels.join('→')}, auto-sent ${JSON.stringify(sent)} (no click)`);
    if (errors.length) console.log(`   errors: ${errors.slice(0, 3).join(' | ')}`);
    continue;
  }

  // Click the FIRST button — the default/primary action in every gate the model
  // produced. Playwright's click is a real trusted event with hit-testing, so a
  // button covered by another element or disabled fails here.
  await buttons.first().click({ timeout: 10_000 });
  const sent = await page.evaluate(() => window.__harness.sent);
  const errors = pageErrors.filter((e) => !/favicon|manifest|sw\.js|preload/i.test(e));

  const ok = sent.length === 1 && typeof sent[0] === 'string' && sent[0].trim().length > 0 && errors.length === 0;
  if (!ok) failed += 1;
  console.log(`${ok ? '✔' : '✖'} ${name}: ${count} button(s), click → sent ${JSON.stringify(sent)}`);
  if (errors.length) console.log(`   errors: ${errors.slice(0, 3).join(' | ')}`);
}

await browser.close();
server.close();
console.log(failed === 0 ? `\nall ${files.length} widget(s) clickable` : `\n${failed}/${files.length} failed`);
process.exit(failed === 0 ? 0 : 1);


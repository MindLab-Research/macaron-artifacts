import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDir = dirname(fileURLToPath(import.meta.url)), root = resolve(siteDir, '..'), artifactsDir = resolve(root, 'artifacts'), output = resolve(siteDir, 'build/client/app');
rmSync(output, { recursive: true, force: true }); mkdirSync(output, { recursive: true });
execFileSync(resolve(artifactsDir, 'node_modules/.bin/vite'), ['build', '--base=/app/', '--outDir', output, '--emptyOutDir'], { cwd: artifactsDir, stdio: 'inherit' });
if (!existsSync(resolve(output, 'index.html'))) throw new Error('Hosted WebUI build did not emit app/index.html');
console.log(`[host-webui] staged shared WebUI at ${output}`);

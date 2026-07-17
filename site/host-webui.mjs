// Build the Macaron WebUI (the /web SPA) and stage it under the docs site's
// build output at /app, so artifacts.macaron.im can HOST the exact same
// front-end that `mcc`/`mcx` serve locally — not redirect to a server origin.
//
// It reuses /web's existing vite build verbatim (no source fork): the only
// override is `--base=/app/`, which rewrites every asset URL to /app/assets/*.
// All three SPA entries ship: index.html (Claude Code), codex.html (Codex) and
// kimi.html (Kimi). Their hash router keeps deep links inside the '#' fragment,
// so no server-side SPA fallback is needed under /app — the static HTML files
// are enough.
//
// Run after `react-router build`: the docs client lands in build/client, then
// we drop web/dist alongside it at build/client/app.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(siteDir, '..');
const webDir = path.join(repoRoot, 'web');
// Build the hosted bundle into its OWN outDir, never web/dist. web/dist is the
// root-based ('/') bundle that local `mcc`/`mcx` serve at `/`; overwriting it
// with a `/app/`-based build would make the local WebUI request /app/assets/*
// (404 → blank). Keep the two artifacts fully separate.
const webDistApp = path.join(webDir, 'dist-app');
const target = path.join(siteDir, 'build', 'client', 'app');

// Vercel's install step runs only in `site/` (site/vercel.json installCommand),
// so the app workspace (`web` + its `@macaron/shared` build dep) is uninstalled
// and unbuilt when we get here. Bootstrap the repo-root workspace ourselves so a
// clean CI/Vercel build can produce web/dist — the `site` install stays isolated
// by site/pnpm-workspace.yaml, so this is the only place the app deps come from.
console.log('[host-webui] installing app workspace deps (web + shared) …');
execFileSync('pnpm', ['install', '--frozen-lockfile'], { cwd: repoRoot, stdio: 'inherit' });
console.log('[host-webui] building @macaron/shared (web imports it) …');
execFileSync('pnpm', ['--filter', '@macaron/shared', 'build'], { cwd: repoRoot, stdio: 'inherit' });

console.log('[host-webui] building /web with base=/app/ into dist-app …');
execFileSync('pnpm', ['exec', 'vite', 'build', '--base=/app/', '--outDir=dist-app', '--emptyOutDir'], { cwd: webDir, stdio: 'inherit' });

if (!existsSync(path.join(webDistApp, 'index.html')) || !existsSync(path.join(webDistApp, 'codex.html')) || !existsSync(path.join(webDistApp, 'kimi.html'))) {
  throw new Error('[host-webui] web/dist-app is missing index.html, codex.html or kimi.html after build');
}

if (existsSync(target)) rmSync(target, { recursive: true });
cpSync(webDistApp, target, { recursive: true });
console.log(`[host-webui] staged WebUI at ${path.relative(repoRoot, target)} (Claude Code: /app, Codex: /app/codex, Kimi: /app/kimi)`);

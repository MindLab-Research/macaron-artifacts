import { execSync } from 'node:child_process';

// Injected by Vite's `define` (see vite.config.ts) — the short SHA of the build commit.
declare global {
  const __COMMIT_SHA__: string;
}

// Short commit SHA for pinning install commands. Vercel injects the full SHA as
// VERCEL_GIT_COMMIT_SHA; locally we fall back to git. If neither is available
// (e.g. a shallow copy with no git), keep the literal `<sha>` placeholder.
export function resolveCommitSha(): string {
  const fromEnv = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA;
  if (fromEnv) return fromEnv.slice(0, 7);
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return '<sha>';
  }
}

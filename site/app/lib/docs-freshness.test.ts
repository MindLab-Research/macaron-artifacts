import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const docsRoot = join(import.meta.dirname, '../../content/docs');
function markdownFiles(directory: string): string[] { return readdirSync(directory, { withFileTypes: true }).flatMap(entry => { const file = join(directory, entry.name); return entry.isDirectory() ? markdownFiles(file) : entry.name.endsWith('.mdx') ? [file] : []; }); }

test('active docs describe the unified application', () => {
  const content = markdownFiles(docsRoot).map(file => readFileSync(file, 'utf8')).join('\n');
  for (const stale of [/\bv0\b/i, /\bmcc\b/i, /\bmcx\b/i, /\bmkx\b/i, /server\/src/i, /web\/src/i, /Fastify/i]) assert.doesNotMatch(content, stale);
  for (const harness of ['Claude Code', 'Codex', 'OpenCode', 'pi', 'Hermes', 'OpenClaw']) assert.match(content, new RegExp(harness.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
});

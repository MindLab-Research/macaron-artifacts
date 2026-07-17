// Read-only reader for the `hooks` block of Claude Code settings.json files.
//
// Claude Code lets settings define hooks — shell commands / HTTP endpoints /
// prompts that fire at lifecycle events (PreToolUse, PostToolUse, Stop, …).
// They silently mutate agent behaviour, so the WebUI surfaces them for
// debugging. We only READ; editing stays in the user's editor of choice.
//
// Precedence mirrors Claude Code's own layering (see hooks docs):
//   user     ~/.claude/settings.json          (all projects)
//   project  <cwd>/.claude/settings.json       (committed, shared)
//   local    <cwd>/.claude/settings.local.json (per-machine, git-ignored)
//
// The on-disk schema is three levels deep:
//   { hooks: { <Event>: [ { matcher, hooks: [ { type, command, if, url } ] } ] } }
// We flatten it to one HookHandlerView per leaf handler so the client renders
// a flat table without re-implementing the nesting.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HOME } from '../config.js';
import type { HookHandlerView, HookScope, HooksResponse } from '@macaron/shared';

type RawHandler = {
  type?: string;
  command?: string;
  url?: string;
  if?: string;
  prompt?: string;
  agent?: string;
  server?: string;
  tool?: string;
};
type RawMatcherGroup = { matcher?: string; hooks?: Array<RawHandler | null> };
type RawSettings = { hooks?: Record<string, RawMatcherGroup[]> };

// Best identifier of what a handler actually runs, per kind. Command hooks
// carry a `command`; HTTP hooks a `url`; prompt/agent hooks a short label.
function describeRun(h: RawHandler | null): string {
  if (!h) return '';
  if (h.command) return h.command;
  if (h.url) return h.url;
  if (h.server || h.tool) return [h.server, h.tool].filter(Boolean).join(' · ');
  if (h.prompt) return h.prompt;
  if (h.agent) return h.agent;
  return '';
}

function flattenSettings(raw: RawSettings, scope: HookScope, source: string): HookHandlerView[] {
  const out: HookHandlerView[] = [];
  const hooks = raw.hooks;
  if (!hooks || typeof hooks !== 'object') return out;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const matcher = String(group?.matcher ?? '');
      const handlers = Array.isArray(group?.hooks) ? group.hooks : [];
      for (const h of handlers) {
        if (!h) continue;
        out.push({
          event,
          matcher,
          scope,
          source,
          type: String(h?.type || 'command'),
          run: describeRun(h),
          ...(h?.if ? { condition: String(h.if) } : {}),
        });
      }
    }
  }
  return out;
}

type ReadSettingsResult =
  | { kind: 'ok'; settings: RawSettings }
  | { kind: 'missing' }
  | { kind: 'parseError'; error: string };

async function readSettingsFile(p: string): Promise<ReadSettingsResult> {
  let raw: string;
  try {
    raw = await fs.readFile(p, 'utf8');
  } catch {
    return { kind: 'missing' };
  }
  try {
    return { kind: 'ok', settings: JSON.parse(raw) as RawSettings };
  } catch (e) {
    return { kind: 'parseError', error: (e as Error).message };
  }
}

// Resolve the three settings.json locations. `cwd` is optional: without it,
// only user-scope hooks are returned (the /hooks page before a workspace is
// picked).
function sourcePaths(cwd?: string): Array<{ scope: HookScope; path: string }> {
  const paths: Array<{ scope: HookScope; path: string }> = [
    { scope: 'user', path: path.join(HOME, '.claude', 'settings.json') },
  ];
  if (cwd) {
    paths.push({ scope: 'project', path: path.join(cwd, '.claude', 'settings.json') });
    paths.push({ scope: 'local', path: path.join(cwd, '.claude', 'settings.local.json') });
  }
  return paths;
}

export async function readHooks(cwd?: string): Promise<HooksResponse> {
  const wanted = sourcePaths(cwd);
  const results = await Promise.all(
    wanted.map(async ({ scope, path: p }) => {
      const raw = await readSettingsFile(p);
      const present = raw.kind !== 'missing';
      return {
        scope,
        path: p,
        present,
        ...(raw.kind === 'parseError' ? { error: raw.error } : {}),
        handlers: raw.kind === 'ok' ? flattenSettings(raw.settings, scope, p) : [],
      };
    }),
  );
  return {
    handlers: results.flatMap((r) => r.handlers),
    sources: results.map(({ scope, path, present, error }) => ({ scope, path, present, ...(error ? { error } : {}) })),
  };
}

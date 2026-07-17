// Generate a short sidebar title for a Codex thread from its opening exchange,
// then persist it via codex-titles.ts. Mirrors codex-web-ui's approach: one
// output-schema-constrained model turn returning `{ title }`.
//
// Engine note: mcx drives Codex through @openai/codex-sdk (thread.run with
// TurnOptions.outputSchema), not `codex app-server`. The SDK spawns
// `codex exec` under the hood, which writes its OWN rollout into
// ~/.codex/sessions — a naming-turn byproduct that would otherwise show up as
// a junk row in the sidebar. We capture the naming thread's id and delete that
// rollout once the title lands.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import type { CodexOptions, ThreadOptions } from '@openai/codex-sdk';
import type { Message } from '@macaron/shared';
import { getActiveCodexProvider } from './codex-config.js';
import { CODEX_BINARY } from './codex-runner.js';
import { findCodexRolloutFile, readCodexSessionMessages } from './codex-store.js';
import { getCodexTitle, setCodexTitle } from './codex-titles.js';

const MAX_TITLE_CHARS = 80;
const MAX_SOURCE_CHARS = 6000;
const TITLE_TIMEOUT_MS = 60_000;

const TITLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { title: { type: 'string', minLength: 1, maxLength: MAX_TITLE_CHARS } },
  required: ['title'],
};

const TITLE_INSTRUCTIONS = `You are generating a concise sidebar title for a Codex coding session.
Infer the user's real task from the opening user/assistant exchange below.
Use the same language as the user; for Chinese prefer 4-12 chars, for English 3-7 Title Case words.
Preserve important product, API, repo, file, and branch names.
No punctuation, quotes, emojis, markdown, or trailing period.
Return exactly JSON: {"title": string}.`;

// Reuse the active provider's auth exactly as codex-runner does, but leaner:
// read-only sandbox, no macaron MCP, low reasoning — a title needs none of it.
function buildTitleOptions(): { codex: CodexOptions; thread: ThreadOptions } {
  const p = getActiveCodexProvider();
  const thread: ThreadOptions = { sandboxMode: 'read-only', approvalPolicy: 'never', skipGitRepoCheck: true, modelReasoningEffort: 'low' };
  if (!p) return { codex: { codexPathOverride: CODEX_BINARY }, thread };
  return {
    codex: {
      codexPathOverride: CODEX_BINARY,
      apiKey: p.apiKey || undefined,
      baseUrl: p.baseUrl || undefined,
      config: {
        model_provider: p.modelProvider,
        model: p.model,
        disable_response_storage: p.disableResponseStorage,
        [`model_providers.${p.modelProvider}.name`]: p.modelProvider,
        [`model_providers.${p.modelProvider}.base_url`]: p.baseUrl,
        [`model_providers.${p.modelProvider}.wire_api`]: p.wireApi,
        [`model_providers.${p.modelProvider}.experimental_bearer_token`]: p.apiKey,
      },
    },
    thread: { ...thread, model: p.model },
  };
}

function firstText(messages: Message[], role: 'user' | 'assistant'): string {
  const m = messages.find((msg) => msg.role === role);
  if (!m) return '';
  return m.blocks.filter((b) => b.kind === 'text').map((b) => (b as { text: string }).text).join('\n').trim();
}

function clip(text: string): string {
  return text.length > MAX_SOURCE_CHARS ? text.slice(0, MAX_SOURCE_CHARS) : text;
}

function normalizeTitle(raw: string): string | null {
  let title = raw.trim();
  // The turn's finalResponse is JSON when outputSchema is honored; fall back to
  // the raw text if a provider ignores the schema and returns a bare title.
  try {
    const parsed = JSON.parse(title) as { title?: unknown };
    if (typeof parsed.title === 'string') title = parsed.title;
  } catch { /* not JSON — treat as the title itself */ }
  title = title.replace(/^[\s"'`*_#\-—–:：]+|[\s"'`*_#\-—–:：。.!?！？]+$/g, '').replace(/\s+/g, ' ').trim();
  return title ? title.slice(0, MAX_TITLE_CHARS) : null;
}

// Delete the naming turn's byproduct rollout so it never surfaces in the sidebar.
async function cleanupNamingRollout(namingSid: string | null): Promise<void> {
  if (!namingSid) return;
  const file = await findCodexRolloutFile(namingSid).catch(() => null);
  if (file) await fs.unlink(file).catch(() => { /* already gone */ });
}

// Fire-and-forget entry point: name `sid` from its opening exchange unless it
// already has a title. Best-effort — any failure is swallowed by the caller.
export async function maybeGenerateCodexTitle(sid: string): Promise<void> {
  if (getCodexTitle(sid)) return;
  const detail = await readCodexSessionMessages(sid);
  const userText = firstText(detail.messages, 'user');
  if (!userText) return;
  const assistantText = firstText(detail.messages, 'assistant');
  const prompt = `${TITLE_INSTRUCTIONS}\n\nUSER:\n"""\n${clip(userText)}\n"""\n\nASSISTANT:\n"""\n${clip(assistantText)}\n"""`;

  // Lazy-import so the default (claude) engine never loads @openai/codex-sdk —
  // the bundled server tarball has no node_modules and a top-level import would
  // crash boot with ERR_MODULE_NOT_FOUND.
  const { Codex } = await import('@openai/codex-sdk');
  const { codex: codexOpts, thread: threadOpts } = buildTitleOptions();
  const thread = new Codex(codexOpts).startThread({ ...threadOpts, workingDirectory: os.tmpdir() });

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TITLE_TIMEOUT_MS);
  try {
    const result = await thread.run(prompt, { outputSchema: TITLE_SCHEMA, signal: abort.signal });
    const title = normalizeTitle(result.finalResponse || '');
    if (title) await setCodexTitle(sid, title);
  } finally {
    clearTimeout(timer);
    await cleanupNamingRollout(thread.id);
  }
}

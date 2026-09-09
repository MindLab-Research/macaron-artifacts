import type { HarnessId } from '../../shared/types.js';
import type { HarnessAdapter } from './types.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { openCodeAdapter } from './opencode.js';
import { piAdapter } from './pi.js';

export const adapters: Record<HarnessId, HarnessAdapter> = { 'claude-code': claudeAdapter, codex: codexAdapter, opencode: openCodeAdapter, pi: piAdapter };

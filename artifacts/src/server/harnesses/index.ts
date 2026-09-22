import type { HarnessId } from '../../shared/types.js';
import type { HarnessAdapter } from './types.js';
import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { openCodeAdapter } from './opencode.js';
import { openCodeV2Adapter } from './opencode-v2.js';
import { piAdapter } from './pi.js';
import { hermesAdapter } from './hermes.js';
import { openClawAdapter } from './openclaw.js';

export const adapters: Record<HarnessId, HarnessAdapter> = { 'claude-code': claudeAdapter, codex: codexAdapter, opencode: openCodeAdapter, 'opencode-v2': openCodeV2Adapter, pi: piAdapter, hermes: hermesAdapter, openclaw: openClawAdapter };

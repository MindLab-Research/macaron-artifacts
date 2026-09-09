import type { Options, Settings } from '@anthropic-ai/claude-agent-sdk';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProfileOptions } from '../../shared/profiles.js';
import type { ResolvedProfile } from './types.js';

const efforts = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
const aliases = ['fable', 'opus', 'sonnet', 'haiku'] as const;
const providerFlags = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS', 'CLAUDE_CODE_USE_MANTLE'];

export function claudeNativeModel(settings: Pick<Settings, 'model' | 'env'>, inheritedEnv: NodeJS.ProcessEnv = process.env): string {
  const env = { ...inheritedEnv, ...settings.env };
  return env.ANTHROPIC_MODEL || settings.model || env.ANTHROPIC_DEFAULT_MODEL || 'default';
}

export async function resolveClaudeProfile(cwd: string, profile: ResolvedProfile, readSettings = async () => (await import('@anthropic-ai/claude-agent-sdk')).resolveSettings({ cwd })): Promise<ResolvedProfile> {
  if (profile.config.model) return profile;
  // Resume remembers the last explicit model. Capture today's native default once, so clearing a profile really resets it and metadata keeps this turn's choice.
  const { effective } = await readSettings();
  return { ...profile, nativeConfig: { ...profile.nativeConfig, model: claudeNativeModel(effective) } };
}

/** CLI names and precedence: https://code.claude.com/docs/en/env-vars and /settings-reference#env. */
export function claudeProfileEnvironment(profile?: ResolvedProfile): Record<string, string> {
  if (!profile) return {};
  const { config } = profile, env: Record<string, string> = {};
  if (config.effort) {
    if (!efforts.includes(config.effort)) throw new Error('Unsupported Claude Code effort level');
    env.CLAUDE_CODE_EFFORT_LEVEL = config.effort;
  }
  if (config.subagentModel) env.CLAUDE_CODE_SUBAGENT_MODEL = config.subagentModel;
  // Since CLI 2.1.251 the model variable is only a default. FORCE (2.1.257+) also covers Explore and Plan.
  if (config.forceSubagentModel !== undefined || config.subagentModel) env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE = (config.forceSubagentModel ?? true) ? '1' : '0';
  for (const alias of aliases) if (config.modelAliases?.[alias]) env[`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`] = config.modelAliases[alias]!;
  if (config.fineGrainedToolStreaming !== undefined) env.CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING = config.fineGrainedToolStreaming ? '1' : '0';
  if (config.baseUrl) env.ANTHROPIC_BASE_URL = config.baseUrl;
  const customAuth = config.authMode === 'api-key' || config.authMode === 'auth-token';
  if (config.baseUrl || customAuth) for (const name of providerFlags) env[name] = '';
  if (customAuth) {
    const secret = config.authMode === 'api-key' ? profile.apiKey : profile.authToken;
    if (!secret) throw new Error(config.authMode === 'api-key' ? 'This Claude Code profile needs an API key' : 'This Claude Code profile needs a bearer token');
    // Bearer credentials outrank API keys. Empty flag-layer values cancel inherited settings as well as shell exports.
    env.ANTHROPIC_API_KEY = config.authMode === 'api-key' ? secret : '';
    env.ANTHROPIC_AUTH_TOKEN = config.authMode === 'auth-token' ? secret : '';
  }
  return env;
}

export type PreparedClaudeProfile = { options: Pick<Options, 'env' | 'settings'>; dispose(): Promise<void> };

export async function prepareClaudeProfile(profile?: ResolvedProfile, inheritedEnv: NodeJS.ProcessEnv = process.env): Promise<PreparedClaudeProfile> {
  const env = claudeProfileEnvironment(profile);
  if (!Object.keys(env).length) return { options: {}, dispose: async () => {} };
  const directory = await mkdtemp(join(tmpdir(), 'macaron-claude-profile-'));
  const dispose = () => rm(directory, { recursive: true, force: true });
  try {
    const path = join(directory, 'settings.json');
    // Settings env overrides subprocess env. Use the flag layer without editing native settings or exposing secrets in argv.
    // Managed policy remains higher priority; disabling native settingSources would also remove project skills and CLAUDE.md.
    await writeFile(path, JSON.stringify({ env }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return { options: { env: { ...inheritedEnv, ...env }, settings: path }, dispose };
  } catch (error) { await dispose(); throw error; }
}

export async function claudeProfileOptions(_cwd: string, profile?: ResolvedProfile): Promise<ProfileOptions> {
  // Opening settings must not start a model session. Aliases remain stable as Claude updates their resolved model versions.
  const models = new Map<string, ProfileOptions['models'][number]>([...aliases, 'opusplan'].map(id => [id, { id, name: id === 'opusplan' ? 'Opus Plan' : id[0].toUpperCase() + id.slice(1) }]));
  for (const id of [profile?.config.model, profile?.config.subagentModel, ...Object.values(profile?.config.modelAliases ?? {})]) if (id && !models.has(id)) models.set(id, { id, name: id });
  return { models: [...models.values()], efforts: [...efforts] };
}

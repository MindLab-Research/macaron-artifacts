import type { ConnectionRequest, ConnectionState, ConnectionTarget, ConnectionTargetEnvField } from '../shared/types.js';
import type { ConnectionResponse } from './harnesses/types.js';
import { record, string } from './harnesses/common.js';

const ACTIONS = new Set(['authorize', 'connect', 'enable', 'install', 'reconnect']);
const STATES = new Set(['pending', 'initiated', 'connected', 'skipped', 'failed', 'expired', 'not_connected']);
const SETTLED_BY = new Set(['all_resolved', 'continue', 'deadline', 'interrupt']);
const TERMINAL = new Set(['connected', 'skipped', 'expired']);
/** MCP servers are installed or enabled locally. Every other action is owned by a hosted provider handshake. */
const APPROVABLE = new Set(['install', 'enable']);

export class ConnectionInputError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const text = (value: unknown, limit = 2000) => { const raw = string(value).replace(/[\0\r]/g, '').trim(); return raw ? raw.slice(0, limit) : undefined; };
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const identifier = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 200 && value === value.trim() && !/[\0\r\n]/.test(value) ? value : undefined;

/** Only an absolute http(s) location can be handed to the browser; anything else is dropped, never rendered. */
export function safeLink(value: unknown): string | undefined {
  const raw = typeof value === 'string' && value === value.trim() && value.length <= 4000 ? value : undefined;
  if (!raw) return undefined;
  try { const url = new URL(raw); return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password ? raw : undefined; }
  catch { return undefined; }
}

function envField(value: unknown): ConnectionTargetEnvField | undefined {
  const field = record(value), name = identifier(field.name);
  if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
  return { name, required: Boolean(field.required), secret: Boolean(field.secret), default: string(field.default).slice(0, 4000), ...(text(field.prompt) ? { prompt: text(field.prompt) } : {}) };
}

function target(value: unknown): ConnectionTarget | undefined {
  const row = record(value), name = identifier(row.name), kind = string(row.kind), action = string(row.action), state = string(row.state);
  if (!name || (kind !== 'connector' && kind !== 'mcp') || !ACTIONS.has(action) || !STATES.has(state)) return undefined;
  const env = Array.isArray(row.required_env) ? row.required_env.map(envField).filter((field): field is ConnectionTargetEnvField => Boolean(field)) : undefined;
  if (row.required_env != null && (!Array.isArray(row.required_env) || env?.length !== row.required_env.length || new Set(env?.map(field => field.name)).size !== env?.length)) return undefined;
  const tools = Array.isArray(row.tools) ? row.tools.map(tool => text(tool, 200)).filter((tool): tool is string => Boolean(tool)).slice(0, 100) : undefined;
  const link = safeLink(row.connect_url);
  return {
    name, kind, action: action as ConnectionTarget['action'], state: state as ConnectionTarget['state'],
    ...(text(row.detail) ? { detail: text(row.detail) } : {}),
    ...(text(row.instructions) ? { instructions: text(row.instructions) } : {}),
    ...(text(row.discovery_error) ? { discovery_error: text(row.discovery_error) } : {}),
    ...(link ? { connect_url: link } : {}),
    ...(text(row.connection_id, 200) ? { connection_id: text(row.connection_id, 200) } : {}),
    ...(text(row.attempt, 200) ? { attempt: text(row.attempt, 200) } : {}),
    ...(env?.length ? { required_env: env } : {}),
    ...(tools?.length ? { tools } : {}),
    ...(text(row.hint) ? { hint: text(row.hint) } : {}),
  };
}

/**
 * One normalizer for connection.request and connection.update. A snapshot that cannot be trusted
 * end to end is dropped entirely: a half-parsed operation would render controls that can never settle.
 */
export function normalizeConnection(payload: unknown, previous?: ConnectionState): ConnectionState | undefined {
  const raw = record(payload), opId = identifier(raw.op_id);
  if (!opId) return undefined;
  const seq = count(raw.seq);
  if (seq === undefined || !Number.isInteger(seq) || seq < 0) return undefined;
  const deadline = count(raw.deadline_at);
  if (deadline === undefined || deadline <= 0) return undefined;
  if (!Array.isArray(raw.targets)) return undefined;
  const targets: ConnectionTarget[] = [], names = new Set<string>();
  for (const row of raw.targets) {
    const parsed = target(row);
    // A blank or repeated name makes every later answer ambiguous.
    if (!parsed || names.has(parsed.name)) return undefined;
    names.add(parsed.name); targets.push(parsed);
  }
  if (!targets.length) return undefined;
  const timeout = count(raw.timeout_seconds);
  const settledBy = string(raw.settled_by);
  if (raw.settled !== undefined && typeof raw.settled !== 'boolean') return undefined;
  const settled = raw.settled === true;
  // Updates omit the originating tool call; the card stays attached to the tool row that produced it.
  const toolCallId = text(raw.tool_call_id, 200) ?? previous?.tool_call_id;
  return {
    op_id: opId, seq, deadline_at: deadline,
    timeout_seconds: timeout !== undefined && timeout > 0 ? timeout : previous?.timeout_seconds ?? 300,
    targets,
    ...(toolCallId ? { tool_call_id: toolCallId } : {}),
    ...(settled ? { settled: true } : {}),
    ...(count(raw.settled_at) ? { settled_at: count(raw.settled_at) } : {}),
    ...(SETTLED_BY.has(settledBy) ? { settled_by: settledBy as ConnectionState['settled_by'] } : {}),
  };
}

/** Terminal targets and a settled operation are the two ways an operation stops accepting answers. */
export const connectionClosed = (state: ConnectionState) => Boolean(state.settled) || state.deadline_at * 1000 <= Date.now();
export const connectionActionable = (state: ConnectionState) => !connectionClosed(state);

/**
 * Validates a browser answer against the advertised snapshot. Approval of a hosted provider is never
 * accepted from a client: only the backend can report a connector as connected.
 */
export function validateConnectionResponse(input: unknown, state: ConnectionState): ConnectionResponse {
  const raw = record(input);
  if (connectionClosed(state)) throw new ConnectionInputError('This connection operation is no longer open.', 409);
  if (!Array.isArray(raw.targets)) throw new ConnectionInputError('targets must be an array.');
  if (raw.settled_by !== undefined && raw.settled_by !== null && raw.settled_by !== 'continue') throw new ConnectionInputError('settled_by only accepts "continue".');
  const targets: ConnectionResponse['targets'] = [], seen = new Set<string>();
  for (const row of raw.targets) {
    const answer = record(row), name = identifier(answer.name), status = string(answer.status);
    if (!name) throw new ConnectionInputError('Every answer needs a target name.');
    if (seen.has(name)) throw new ConnectionInputError(`Target ${name} was answered twice.`);
    seen.add(name);
    const advertised = state.targets.find(candidate => candidate.name === name);
    if (!advertised) throw new ConnectionInputError('This target is not part of the connection operation.');
    if (status !== 'approved' && status !== 'skipped') throw new ConnectionInputError('status must be "approved" or "skipped".');
    if (TERMINAL.has(advertised.state)) throw new ConnectionInputError(`Target ${name} already finished.`);
    if (status === 'approved' && (advertised.kind !== 'mcp' || !APPROVABLE.has(advertised.action))) {
      throw new ConnectionInputError(`Only the agent backend can confirm ${name}; from here it can only be skipped.`);
    }
    const env: Record<string, string> = {};
    if (answer.env !== undefined && answer.env !== null) {
      if (status !== 'approved') throw new ConnectionInputError('Environment values only apply to an approved MCP target.');
      if (typeof answer.env !== 'object' || Array.isArray(answer.env)) throw new ConnectionInputError('Environment values must be an object.');
      const provided = record(answer.env), advertisedEnv = advertised.required_env ?? [];
      for (const [key, value] of Object.entries(provided)) {
        const field = advertisedEnv.find(candidate => candidate.name === key);
        if (!field) throw new ConnectionInputError(`${key} is not requested by ${name}.`);
        if (typeof value !== 'string' || value.length > 4000 || /[\0\r\n]/.test(value)) throw new ConnectionInputError(`${key} has an invalid value.`);
        if (value.trim()) env[key] = value;
      }
    }
    if (status === 'approved') {
      for (const field of advertised.required_env ?? []) {
        if (!field.required || env[field.name]?.trim()) continue;
        // An advertised default is the backend's own value; it stays server-side rather than round-tripping.
        if (field.default.trim()) { env[field.name] = field.default; continue; }
        throw new ConnectionInputError(`${field.name} is required for ${name}.`);
      }
    }
    targets.push({ name, status, ...(text(answer.detail) ? { detail: text(answer.detail) } : {}), ...(Object.keys(env).length ? { env } : {}) });
  }
  if (!targets.length && raw.settled_by !== 'continue') throw new ConnectionInputError('Answer at least one target or continue the turn.');
  return { targets, ...(raw.settled_by === 'continue' ? { settled_by: 'continue' as const } : {}) };
}

/**
 * Disk journal and session snapshots keep the historical shape of an operation, never a replayable
 * authorization URL nor any credential the backend advertised or the user typed.
 */
export function redactConnection<T extends ConnectionState>(state: T, removeLinks = true): T {
  return {
    ...state,
    targets: state.targets.map(({ connect_url, required_env, ...row }) => ({
      ...row,
      ...(!removeLinks && connect_url ? { connect_url } : {}),
      ...(required_env?.length ? { required_env: required_env.map(field => ({ ...field, hasDefault: field.hasDefault || Boolean(field.default.trim()), default: field.secret ? '' : field.default })) } : {}),
    })),
  };
}

export type { ConnectionRequest };

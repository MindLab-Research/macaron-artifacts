import type { ChatChunk } from '../../shared/types.js';
import type { HarnessAdapter, HarnessTurn } from './types.js';
import { abortable, abortError, EventQueue, executableVersion, record, safeProfileError, string } from './common.js';
import { CodexEventMapper } from './codex-events.js';
import { CodexRpc, type CodexConnection } from './codex-rpc.js';
import { codexProfileRuntime, initializeCodex, readCodexProfileOptions } from './codex-profiles.js';

export function codexThreadParams(turn: HarnessTurn): Record<string, unknown> {
  const config = codexProfileRuntime(turn.profile).config, model = turn.model || string(config.model);
  const common = { cwd: turn.cwd, developerInstructions: turn.instructions, ...(model ? { model } : {}), ...(Object.keys(config).length ? { config } : {}), ...(config.model_provider ? { modelProvider: config.model_provider } : {}), approvalPolicy: 'on-request', approvalsReviewer: 'user' };
  if (turn.enrichment) return { ...common, threadId: turn.nativeId, ephemeral: true, excludeTurns: true, sandbox: 'read-only' };
  return turn.nativeId ? { ...common, threadId: turn.nativeId, excludeTurns: true, sandbox: 'workspace-write' } : { ...common, sandbox: 'workspace-write' };
}

export async function codexServerRequest(turn: HarnessTurn, method: string, value: unknown): Promise<unknown> {
  const params = record(value), id = `${string(params.threadId)}:${string(params.itemId) || crypto.randomUUID()}`;
  if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval' || method === 'item/permissions/requestApproval') {
    const approved = !turn.enrichment && await abortable(turn.approve({ id, tool: method, input: params }), turn.signal);
    if (method === 'item/permissions/requestApproval') return { permissions: approved ? params.permissions : {}, scope: 'turn' };
    return { decision: approved ? 'accept' : 'decline' };
  }
  if (method === 'item/tool/call') return { contentItems: [{ type: 'inputText', text: 'This client does not execute dynamic tools' }], success: false };
  if (method === 'item/tool/requestUserInput') return { answers: {} };
  if (method === 'mcpServer/elicitation/request') return { action: 'decline', content: null, _meta: null };
  throw new Error(`Unsupported Codex request: ${method}`);
}

/** Kept separate from process startup so raw protocol replay tests exercise the actual orchestration. */
export async function* runCodexConnection(turn: HarnessTurn, connection: CodexConnection): AsyncGenerator<ChatChunk> {
  const queue = new EventQueue<ChatChunk>(), mapper = new CodexEventMapper();
  const diagnostic = (value: unknown) => safeProfileError(value, turn.profile);
  let nativeId = '', nativeTurnId = '', streaming = false, terminal = false;
  let finish!: () => void, reject!: (error: Error) => void;
  let turnAvailable!: () => void, nativeSettled!: () => void, cancellation: Promise<void> | undefined;
  const turnReady = new Promise<void>(resolve => { turnAvailable = resolve; });
  const nativeDone = new Promise<void>(resolve => { nativeSettled = resolve; });
  const done = new Promise<void>((resolve, fail) => { finish = resolve; reject = fail; });
  // A transport may fail during initialize, before the producer reaches await done.
  void done.catch(() => {});
  connection.failure = (error) => { nativeSettled(); reject(error); queue.fail(error); };
  connection.serverRequest = (method, params) => codexServerRequest(turn, method, params);
  connection.notification = (method, raw) => {
    const params = record(raw);
    if (!streaming || (params.threadId && params.threadId !== nativeId)) return;
    if (method === 'turn/started') { nativeTurnId = string(record(params.turn).id); if (nativeTurnId) turnAvailable(); }
    for (const chunk of mapper.map(method, params)) queue.push(chunk);
    if (method === 'turn/completed') {
      terminal = true;
      nativeSettled();
      for (const chunk of mapper.finish()) queue.push(chunk);
      const result = record(params.turn);
      if (turn.signal.aborted || result.status === 'interrupted') reject(abortError());
      else if (result.status === 'failed') reject(new Error(diagnostic(record(result.error).message || 'Codex turn failed')));
      else finish();
    } else if (method === 'error' && !params.willRetry) reject(new Error(diagnostic(record(params.error).message || params.message || 'Codex stream failed')));
  };
  const abort = () => {
    if (streaming && !terminal && !cancellation) {
      // Interrupt acknowledgement only accepts cancellation; turn/completed confirms
      // the native turn actually settled. Keep the process alive for that event, bounded
      // even when cancellation races a turn/start response that never arrives.
      let timer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, 2000); });
      const interrupt = (async () => {
        await turnReady;
        if (!terminal) await connection.request('turn/interrupt', { threadId: nativeId, turnId: nativeTurnId });
        await nativeDone;
      })();
      cancellation = Promise.race([interrupt.catch(() => {}), nativeDone, deadline]).finally(() => clearTimeout(timer));
    }
    queue.fail(abortError()); reject(abortError());
  };
  turn.signal.addEventListener('abort', abort, { once: true });
  const producer = (async () => {
    if (turn.signal.aborted) throw abortError();
    if (turn.enrichment && !turn.nativeId) throw new Error('Metadata generation requires a completed native Codex thread');
    await initializeCodex(connection);
    const method = turn.enrichment ? 'thread/fork' : turn.nativeId ? 'thread/resume' : 'thread/start';
    const result = await connection.request(method, codexThreadParams(turn));
    nativeId = string(record(result.thread).id);
    if (!nativeId) throw new Error('Codex did not return a native thread id');
    if (turn.enrichment && nativeId === turn.nativeId) throw new Error('Codex failed to create an isolated metadata fork');
    if (!turn.enrichment) turn.onNativeSession(nativeId);
    if (turn.signal.aborted) throw abortError();
    streaming = true;
    const response = await connection.request('turn/start', { threadId: nativeId, input: turn.retry ? [] : [{ type: 'text', text: turn.prompt, text_elements: [] }], ...(turn.profile?.config.effort ? { effort: turn.profile.config.effort } : {}) });
    nativeTurnId ||= string(record(response.turn).id);
    if (nativeTurnId) turnAvailable();
    await done;
  })();
  void producer.then(() => queue.end(), (error) => queue.fail(error));
  try { yield* queue; }
  finally {
    turn.signal.removeEventListener('abort', abort);
    reject(abortError());
    await cancellation;
    await connection.close();
    await producer.catch(() => {});
  }
}

export const codexAdapter: HarnessAdapter = {
  id: 'codex',
  async info() {
    const version = await executableVersion(process.env.MACARON_CODEX_PATH || 'codex');
    return { id: 'codex', name: 'Codex', available: Boolean(version), detail: version || 'Install the Codex CLI', capabilities: { textDeltas: true, reasoningDeltas: true, toolInputDeltas: false, commandOutputDeltas: true, approvals: true, fork: true } };
  },
  async profileOptions(cwd, profile) {
    const runtime = codexProfileRuntime(profile), connection = new CodexRpc(process.env.MACARON_CODEX_PATH || 'codex', { cwd, env: runtime.env, config: runtime.startup, secrets: runtime.secrets });
    try { return await readCodexProfileOptions(connection, cwd, profile); }
    finally { await connection.close(); }
  },
  async *run(turn) {
    if (turn.signal.aborted) throw abortError();
    const runtime = codexProfileRuntime(turn.profile);
    yield* runCodexConnection(turn, new CodexRpc(process.env.MACARON_CODEX_PATH || 'codex', { cwd: turn.cwd, env: runtime.env, config: runtime.startup, secrets: runtime.secrets }));
  },
};

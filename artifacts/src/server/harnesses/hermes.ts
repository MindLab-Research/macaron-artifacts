import type { ChatChunk, ConnectionState } from '../../shared/types.js';
import type { ConnectionControls, ConnectionResponse, HarnessAdapter, HarnessTurn, ResolvedProfile } from './types.js';
import type { ProfileOptions } from '../../shared/profiles.js';
import { abortError, executableVersion, record, safeError, string, EventQueue, abortable } from './common.js';
import { connectionActionable, normalizeConnection, redactConnection, safeLink } from '../connections.js';
import { HermesRpc, rpcPayload } from './hermes-server.js';

type NativeRef = { sessionId: string; storedId?: string; profile?: string; submittedMessageId?: string };
const encode = (value: NativeRef) => `hermes:${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
const decode = (value: string): NativeRef => { if (!value.startsWith('hermes:')) return { sessionId: value }; try { return JSON.parse(Buffer.from(value.slice(7), 'base64url').toString('utf8')) as NativeRef; } catch { return { sessionId: value }; } };
const gatewayUrl = (profile: HarnessTurn['profile']) => profile?.config.gatewayUrl || process.env.MACARON_HERMES_URL;
const profileName = (profile: HarnessTurn['profile']) => profile?.config.nativeProfile;
const connections = new Map<string, HermesRpc>();
const CHALLENGE_KEY = 'free_tier.challenge';
// Sessions currently showing a sticky challenge notice, oldest first. Re-notifying refreshes an
// entry so a still-blocked session is never the one evicted; a notice may never be retired at all.
const challengeNoticeSessions = new Set<string>();
const rememberChallengeNotice = (sessionKey: string) => {
  if (!sessionKey) return;
  challengeNoticeSessions.delete(sessionKey); challengeNoticeSessions.add(sessionKey);
  if (challengeNoticeSessions.size > 1000) challengeNoticeSessions.delete(challengeNoticeSessions.values().next().value!);
};
const connectionKey = (turn: HarnessTurn) => `${turn.cwd}\0${gatewayUrl(turn.profile) || 'managed'}\0${profileName(turn.profile) || ''}`;
const connectionFor = (turn: Pick<HarnessTurn, 'cwd' | 'profile'>, token?: string) => {
  const key = connectionKey(turn as HarnessTurn), existing = connections.get(key);
  if (existing) return existing;
  const rpc = new HermesRpc({ cwd: turn.cwd, binary: process.env.MACARON_HERMES_PATH || 'hermes', profile: profileName(turn.profile), token, url: gatewayUrl(turn.profile), secrets: token ? [token] : [], onFailure: () => { if (connections.get(key) === rpc) connections.delete(key); } });
  connections.set(key, rpc); return rpc;
};
function hermesQuestions(value: unknown) {
  if (!Array.isArray(value) || !value.length) throw new Error('Hermes returned an empty clarify request');
  return value.map(item => {
    const question = record(item), id = string(question.qid), text = string(question.question), choices = Array.isArray(question.choices) ? question.choices.map(string).filter(Boolean) : [];
    if (!id || !text) throw new Error('Hermes returned an invalid clarify question');
    return { id, question: text, options: choices.map(label => ({ label })), multiple: question.multi_select === true, custom: choices.length === 0 };
  });
}
// Hermes takes a lone single-select value bare and everything else as a JSON array.
const encodeAnswer = (values: string[], multiple: boolean) => multiple || values.length !== 1 ? JSON.stringify(values) : values[0];
function hermesAnswer(values: string[] | undefined, multiple = false) { return !values?.length ? '' : encodeAnswer(values, multiple); }
function hermesAnswers(answers: Record<string, string[]>, questions: { id: string; multiple?: boolean }[]) {
  const multiSelect = new Set(questions.filter(question => question.multiple).map(question => question.id));
  return Object.fromEntries(Object.entries(answers).map(([id, values]) => [id, encodeAnswer(values, multiSelect.has(id))]));
}
/** Native display strings reach a persisted card or an on-screen notice; keep them single-line and bounded. */
const safeText = (value: unknown, limit = 2000) => string(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit);
function vaultHeader(params: Record<string, unknown>) {
  // `origin` is the only native field that is URL-shaped. Use its hostname rather than
  // echoing userinfo, paths, query strings or fragments into a persisted question card.
  const origin = string(params.origin);
  try {
    const hostname = new URL(origin).hostname;
    if (hostname) return hostname;
  } catch { /* vault.code has no required origin; use its display site below. */ }
  const site = safeText(params.site, 120);
  return site || '网站';
}
function vaultQuestions(request: { method: string; params: Record<string, unknown> }) {
  const site = vaultHeader(request.params);
  if (request.method === 'vault.save_login') return [
    // The identifier is sensitive account data too. Marking both fields secret keeps the
    // browser draft out of sessionStorage and masks the completed response in the journal/SSE.
    { id: 'identifier', header: site, question: '登录账号或邮箱', options: [], custom: true, secret: true, placeholder: '输入账号或邮箱' },
    { id: 'password', header: site, question: '登录密码', options: [], custom: true, secret: true, placeholder: '输入密码' },
  ];
  return [{ id: 'code', header: site, question: '一次性验证码', options: [], custom: true, secret: true, placeholder: '输入验证码' }];
}
function vaultValue(method: string, response: { answers: Record<string, string[]> } | { cancelled: true }) {
  if (!('answers' in response)) return '';
  if (method === 'vault.save_login') return JSON.stringify({ identifier: response.answers.identifier?.[0] || '', password: response.answers.password?.[0] || '' });
  return response.answers.code?.[0] || '';
}
/**
 * A free-tier challenge blocks the native turn until it is solved in a browser, so a required one
 * becomes a sticky notice carrying the upstream message and its location. An optional challenge is
 * the gateway's own retry hint: it never interrupts the turn. The backend polls for the result, so
 * there is nothing for this client to answer.
 */
function challengeNotification(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  if (payload.required !== true) return undefined;
  return { text: safeText(payload.message) || '需要在浏览器中完成验证后才能继续', level: 'warn', kind: 'sticky', key: CHALLENGE_KEY, link: payload.url };
}

export async function closeHermesConnections() { const values = [...connections.values()]; connections.clear(); challengeNoticeSessions.clear(); await Promise.allSettled(values.map(value => value.close())); }

function assertSupported(profile: HarnessTurn['profile']) {
  if (profile?.config.baseUrl || profile?.apiKey) throw new Error('Hermes uses its own profile/provider credentials; base URL and API-key overrides are not supported by the native gateway adapter');
}

export const hermesAdapter: HarnessAdapter = {
  id: 'hermes' as HarnessAdapter['id'],
  async info(profile) {
    const url = gatewayUrl(profile), capabilities = { textDeltas: true, reasoningDeltas: true, toolInputDeltas: false, commandOutputDeltas: false, approvals: true, fork: false };
    if (url) {
      let available = false;
      try { available = ['ws:', 'wss:', 'http:', 'https:'].includes(new URL(url).protocol); } catch { /* Invalid configured URL; do not silently switch to the local CLI. */ }
      return { id: 'hermes', name: 'Hermes', available, source: 'gateway', detail: available ? '已配置外部 Gateway，无需本机 CLI；连接和认证尚未检查' : 'Gateway URL 无效，需要 ws://, wss://, http://, 或 https:// 地址', capabilities };
    }
    const version = await executableVersion(process.env.MACARON_HERMES_PATH || 'hermes');
    return { id: 'hermes', name: 'Hermes', available: Boolean(version), source: 'native-cli', detail: version ? `外部 CLI · ${version}` : 'Hermes CLI 不可用，或可在 Profile 配置外部 Gateway', capabilities };
  },
  async profileOptions(cwd: string, profile?: ResolvedProfile): Promise<ProfileOptions> {
    const rpc = connectionFor({ cwd, profile });
    const payload = rpcPayload(await rpc.request('model.options', { explicit_only: true }, AbortSignal.timeout(15_000)));
    const models = [] as ProfileOptions['models'];
    for (const row of Array.isArray(payload.providers) ? payload.providers : []) {
      const provider = record(row), slug = string(provider.slug), name = string(provider.name) || slug;
      for (const model of Array.isArray(provider.models) ? provider.models : []) { const id = string(model); if (id) models.push({ id: slug ? `${slug}/${id}` : id, name: `${name} · ${id}`, provider: slug }); }
    }
    return { models, efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] };
  },
  async *run(turn: HarnessTurn): AsyncGenerator<ChatChunk> {
    if (turn.signal.aborted) throw abortError(); assertSupported(turn.profile);
    const ref = turn.nativeId ? decode(turn.nativeId) : undefined;
    if (ref?.profile && ref.profile !== profileName(turn.profile)) throw new Error('Hermes session belongs to a different native profile; start a new session before switching Hermes profiles');
    const token = turn.profile?.authToken;
    const rpc = connectionFor(turn, token);
    let nativeId = ref?.sessionId || '', storedId = ref?.storedId, activeTurn = false, done = false, textStarted = false, thoughtId = '', thoughtSequence = 0, streamed = false, metadataText = '', pending: ConnectionState | undefined, resolveDone!: () => void, rejectDone!: (error: Error) => void;
    const completed = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    void completed.catch(() => {});
    const queue = new EventQueue<ChatChunk>();
    const push = (items: ChatChunk[]) => { for (const item of items) queue.push(item); };
    // Preserve the tool/text boundary when the next native thinking delta starts a new segment.
    const endThought = () => { if (thoughtId) { push([{ type: 'reasoning-end', id: thoughtId }]); thoughtId = ''; } };
    const fail = (error: Error) => { closeConnections(); queue.fail(error); rejectDone(error); };
    type Tracked = { state: ConnectionState; browserId: string; owner: string; controls: ConnectionControls };
    const activeConnections = new Map<string, Tracked>();
    const pendingServerRequests = new Map<string, AbortController>();
    const deadlines = new Set<ReturnType<typeof setTimeout>>();
    let turnClosed = false;
    const delayedQueueEnds = new Set<ReturnType<typeof setTimeout>>();
    const endQueueSoon = () => {
      if (delayedQueueEnds.size) return;
      const timer = setTimeout(() => { delayedQueueEnds.delete(timer); queue.end(); }, 0);
      delayedQueueEnds.add(timer);
    };
    let drainingPrevious = false, submittedMessageId = ref?.submittedMessageId;
    let openRequests: unknown;
    const checkpoint = () => turn.onNativeSession(encode({ sessionId: nativeId, storedId, profile: profileName(turn.profile), ...(submittedMessageId ? { submittedMessageId } : {}) }));
    const submitPrompt = async () => {
      // Persist the identity before sending: a retry of an accepted but interrupted request must not duplicate it.
      submittedMessageId = turn.messageId; checkpoint();
      await rpc.request('prompt.submit', { session_id: nativeId, text: turn.prompt }, turn.signal);
    };
    let bindingSession = true;
    const earlyConnections: Record<string, unknown>[] = [];
    const earlyNotifications: { type: 'notification.show' | 'notification.clear'; sessionId: string; payload: Record<string, unknown> }[] = [];
    let notificationSequence = 0;
    const challengeSessionKey = () => storedId || nativeId;
    const publishNotification = (type: 'notification.show' | 'notification.clear', payload: Record<string, unknown>) => {
      if (type === 'notification.show') {
        const text = string(payload.text), level = string(payload.level), kind = string(payload.kind);
        if (!text || !level || !kind) return;
        const data: Extract<ChatChunk, { type: 'data-notification' }>['data'] = { action: 'show', text, level, kind };
        if (payload.ttl_ms === null || typeof payload.ttl_ms === 'number') data.ttl_ms = payload.ttl_ms;
        if (typeof payload.key === 'string') data.key = payload.key;
        if (typeof payload.id === 'string') data.id = payload.id;
        // Masked server-side so an unsafe location never reaches the browser; the notice still shows without it.
        const link = safeLink(payload.link);
        if (link) data.link = link;
        const identity = data.id || data.key || `event-${++notificationSequence}`;
        // Also remember a masked-link notice: it is on screen and still needs retiring on a later turn.
        if (data.key === CHALLENGE_KEY) rememberChallengeNotice(challengeSessionKey());
        push([{ type: 'data-notification', id: `hermes-notification:${identity}`, data, transient: true }]);
      } else {
        const key = string(payload.key);
        if (key) push([{ type: 'data-notification', id: `hermes-notification-clear:${key}`, data: { action: 'clear', key }, transient: true }]);
      }
    };
    const receiveNotification = (event: { type: 'notification.show' | 'notification.clear'; sessionId: string; payload: Record<string, unknown> }) => {
      if (bindingSession || !nativeId) {
        if (earlyNotifications.length < 100) earlyNotifications.push(event);
        return;
      }
      if (event.sessionId && event.sessionId !== nativeId) return;
      publishNotification(event.type, event.payload);
    };
    const flushEarlyNotifications = () => {
      for (const event of earlyNotifications.splice(0)) if (!event.sessionId || event.sessionId === nativeId) publishNotification(event.type, event.payload);
    };
    // A sticky notice has no expiry of its own. A turn that reached its terminal message is the
    // gateway saying the block is gone, which is the one chance to retire it, so do it exactly once.
    const clearChallengeNotice = () => {
      if (challengeNoticeSessions.delete(challengeSessionKey())) publishNotification('notification.clear', { key: CHALLENGE_KEY });
    };
    const publishConnection = (tracked: Tracked) => {
      const actionable = !turnClosed && !turn.signal.aborted && connectionActionable(tracked.state);
      // Re-register on every snapshot so the API validates answers against what the browser last saw.
      turn.connection?.(tracked.browserId, tracked.state, tracked.controls, actionable);
      push([{ type: 'data-connection', id: tracked.browserId, data: { ...redactConnection(tracked.state, !actionable), id: tracked.browserId, actionable } }]);
    };
    // Owner is the native session that produced the operation; the browser never supplies it.
    const operation = (tracked: Tracked) => ({ owner: { type: 'session', session_id: tracked.owner }, op_id: tracked.state.op_id, ...(profileName(turn.profile) ? { profile: profileName(turn.profile) } : {}) });
    const openConnection = (state: ConnectionState, owner: string) => {
      const tracked = { state, browserId: crypto.randomUUID(), owner } as Tracked;
      tracked.controls = {
        status: async () => {
          const view = normalizeConnection(rpcPayload(await rpc.request('connectors.operation.status', operation(tracked), undefined, 15_000)), tracked.state);
          if (!view || view.op_id !== tracked.state.op_id || view.seq <= tracked.state.seq || tracked.state.settled || turnClosed) return tracked.state;
          tracked.state = view; publishConnection(tracked);
          return view;
        },
        wake: async () => { await rpc.request('connectors.operation.wake', operation(tracked), undefined, 15_000); },
        respond: async (response: ConnectionResponse) => {
          // The caller's promise resolves only after the gateway accepted the answer; a rejected
          // response leaves the operation usable so the card can be corrected and resubmitted.
          await rpc.request('connection.respond', {
            ...operation(tracked),
            result: { targets: response.targets, ...(response.settled_by ? { settled_by: response.settled_by } : {}) },
          }, undefined, 30_000);
        },
      };
      activeConnections.set(state.op_id, tracked);
      // The gateway normally announces its own timeout; this re-publishes a closed card if it cannot.
      const remaining = state.deadline_at * 1000 - Date.now();
      if (remaining > 0 && remaining < 2 ** 31) {
        const timer = setTimeout(() => { if (activeConnections.get(state.op_id) === tracked) publishConnection(tracked); }, remaining + 250);
        deadlines.add(timer);
      }
      publishConnection(tracked);
      return tracked;
    };
    const acceptConnection = (event: Record<string, unknown>) => {
      const sid = string(event.session_id), payload = record(event.payload), owner = record(payload.owner);
      if (!sid || sid !== nativeId || turnClosed) return;
      if (payload.owner !== undefined && (owner.type !== 'session' || owner.session_id !== nativeId)) return;
      const tracked = activeConnections.get(string(payload.op_id));
      if (event.type === 'connection.update' && !tracked) return;
      const state = normalizeConnection(payload, tracked?.state);
      if (!state || tracked && (state.seq <= tracked.state.seq || tracked.state.settled)) return;
      if (tracked) { tracked.state = state; publishConnection(tracked); }
      else openConnection(state, sid);
    };
    // Own the request for its lifetime: track its abort controller, then reply once with the produced
    // result or a redacted error. request.cancel and turn teardown abort the signal to suppress the reply.
    const answerServerRequest = (id: string, produce: (signal: AbortSignal) => Promise<Record<string, unknown>>, errorMessage?: string) => {
      const controller = new AbortController(); pendingServerRequests.set(id, controller);
      void produce(controller.signal)
        .then(result => { if (!controller.signal.aborted) rpc.respond(id, result); })
        .catch(error => { if (!controller.signal.aborted) rpc.respondError(id, -32603, errorMessage || safeError(error)); })
        .finally(() => pendingServerRequests.delete(id));
    };
    // Cancellation reaches us as either a server request or a plain event; both just drop the reply.
    const cancelServerRequest = (id: string) => { const controller = pendingServerRequests.get(id); if (!controller) return; pendingServerRequests.delete(id); controller.abort(); };
    const unsubscribeServerRequests = rpc.onServerRequest(request => {
      const sid = string(request.params.session_id);
      if (!nativeId || sid !== nativeId) return false;
      if (request.method === 'request.cancel') {
        cancelServerRequest(string(request.params.request_id) || string(request.params.id));
        rpc.respond(request.id, {});
        return true;
      }
      if (request.method === 'clarify') {
        answerServerRequest(request.id, async signal => {
          // A batch request answers by question id; the single-question shape answers with one bare value.
          const batch = Array.isArray(request.params.questions) && request.params.questions.length > 0;
          const questions = hermesQuestions(batch ? request.params.questions : [{ qid: 'single', question: request.params.question, choices: request.params.choices, multi_select: request.params.multi_select }]);
          const response = await turn.ask({ questions }, signal);
          if (!('answers' in response)) return batch ? {} : { answer: '' };
          return batch ? { answers: hermesAnswers(response.answers, questions) } : { answer: hermesAnswer(response.answers.single, questions[0]?.multiple) };
        });
        return true;
      }
      if (request.method === 'approval') {
        answerServerRequest(request.id, async signal => {
          const approved = await turn.approve({ id: string(request.params.request_id) || request.id, tool: string(request.params.tool_name) || 'terminal', input: request.params }, signal);
          return { choice: approved ? 'once' : 'deny' };
        });
        return true;
      }
      if (request.method === 'vault.save_login' || request.method === 'vault.code') {
        answerServerRequest(request.id, async signal => {
          const response = await turn.ask({ questions: vaultQuestions(request) }, signal);
          return { value: vaultValue(request.method, response) };
        }, 'Hermes vault request failed');
        return true;
      }
      return false;
    });
    const unsub = rpc.onEvent(event => {
      const type = string(event.type), sid = string(event.session_id), payload = record(event.payload);
      if (type === 'connection.request' || type === 'connection.update') {
        if (turn.enrichment) return;
        if (bindingSession) { if (earlyConnections.length < 100) earlyConnections.push(event); }
        else acceptConnection(event);
        return;
      }
      if (nativeId && sid && sid !== nativeId) return;
      if (type === 'notification.show' || type === 'notification.clear') {
        receiveNotification({ type, sessionId: sid, payload });
        return;
      }
      // Rides the notification path on purpose: a challenge is raised around session binding, before
      // the turn is streaming, and must survive the same early-buffer and grace-period windows.
      if (type === 'free_tier.challenge') {
        const notification = challengeNotification(payload);
        if (notification) receiveNotification({ type: 'notification.show', sessionId: sid, payload: notification });
        return;
      }
      // Once the native turn has completed, only notification events may still be
      // delivered during the one-macrotask queue-end grace period. Do not let a
      // late error/delta reopen or fail an already completed browser turn.
      if (done) return;
      if (type === 'request.cancel') { cancelServerRequest(string(payload.id) || string(payload.request_id)); return; }
      if (turn.enrichment && type === 'btw.complete') { metadataText += string(payload.text); if (metadataText) push([{ type: 'text-start', id: 'hermes-metadata' }, { type: 'text-delta', id: 'hermes-metadata', delta: metadataText }, { type: 'text-end', id: 'hermes-metadata' }]); done = true; endQueueSoon(); resolveDone(); return; }
      if (turn.enrichment) return;

      if (!activeTurn) return;
      if (drainingPrevious && !['approval.request', 'error', 'connection.error'].includes(type)) {
        // This recovered operation belongs to an older native turn, not this new user message.
        // Keep its authorization UI, but do not pass its reply off as the new message's answer.
        if (type === 'message.complete') {
          closeConnections(true); drainingPrevious = false;
          void submitPrompt().catch(error => fail(error instanceof Error ? error : new Error(String(error))));
        }
        return;
      }
      if (type === 'message.start') { push([]); return; }
      if (type === 'message.delta') { const text = string(payload.text); if (text) endThought(); if (text && !textStarted) { textStarted = true; push([{ type: 'text-start', id: 'hermes-message' }]); } if (text) { streamed = true; push([{ type: 'text-delta', id: 'hermes-message', delta: text }]); } }
      else if (type === 'reasoning.delta' || type === 'thinking.delta') { const text = string(payload.text); if (text && !thoughtId) { thoughtId = `hermes-reasoning-${++thoughtSequence}`; push([{ type: 'reasoning-start', id: thoughtId }]); } if (text) push([{ type: 'reasoning-delta', id: thoughtId, delta: text }]); }
      else if (type === 'tool.start') { endThought(); push([{ type: 'tool-input-available', toolCallId: string(payload.tool_id), toolName: string(payload.name), input: payload.args ?? {}, dynamic: true, providerExecuted: true }]); }
      else if (type === 'tool.complete') { const id = string(payload.tool_id); push([{ type: 'tool-output-available', toolCallId: id, output: payload.result ?? payload.result_text ?? '', dynamic: true, providerExecuted: true }]); }
      else if (type === 'message.complete') { endThought(); const text = string(payload.text); if (!streamed && text) { textStarted = true; push([{ type: 'text-start', id: 'hermes-message' }, { type: 'text-delta', id: 'hermes-message', delta: text }]); } if (textStarted) push([{ type: 'text-end', id: 'hermes-message' }]); clearChallengeNotice(); closeConnections(); done = true; endQueueSoon(); resolveDone(); }
      else if (type === 'error' || type === 'connection.error') fail(new Error(string(payload.message) || 'Hermes turn failed'));
      else if (type === 'approval.request') {
        void abortable(turn.approve({ id: string(payload.request_id), tool: 'terminal', input: payload }), turn.signal)
          .then(approved => rpc.request('approval.respond', { session_id: nativeId, request_id: payload.request_id, choice: approved ? 'once' : 'deny' }))
          .catch(error => fail(error instanceof Error ? error : new Error(String(error))));
      }
    });
    // Stop, deadline and the end of the turn all take the controls away; the card keeps its summary.
    const closeConnections = (reopen = false) => {
      const open = [...activeConnections.values()].filter(tracked => connectionActionable(tracked.state));
      turnClosed = true;
      for (const tracked of open) publishConnection(tracked);
      activeConnections.clear();
      if (reopen) turnClosed = false;
    };
    const abort = () => { if (!turn.enrichment) void rpc.request('session.interrupt', { session_id: nativeId }).catch(() => {}); closeConnections(); fail(abortError()); };
    turn.signal.addEventListener('abort', abort, { once: true });
    try {
      if (turn.enrichment) {
        if (!nativeId) throw new Error('Hermes metadata generation requires a completed native session');
        activeTurn = true;
        bindingSession = false;
        flushEarlyNotifications();
        await rpc.request('prompt.btw', { session_id: nativeId, text: turn.prompt }, turn.signal);
      } else {
        if (!nativeId) {
          const seed = turn.instructions ? [{ role: 'system', content: turn.instructions, display_kind: 'hidden' }] : [];
          const result = rpcPayload(await rpc.request('session.create', { cwd: turn.cwd, messages: seed, ...(turn.model ? { model: turn.model } : {}), ...(turn.profile?.config.effort ? { reasoning_effort: turn.profile.config.effort } : {}) }, turn.signal));
          nativeId = string(result.session_id); storedId = string(result.stored_session_id) || nativeId; if (!nativeId) throw new Error('Hermes did not return a session id'); checkpoint();
        } else {
          const resumed = rpcPayload(await rpc.request('session.resume', { session_id: storedId || nativeId, omit_messages: true }, turn.signal));
          nativeId = string(resumed.session_id) || nativeId; storedId = storedId || string(resumed.stored_session_id) || nativeId;
          checkpoint();
          pending = normalizeConnection(resumed.pending_connection);
          openRequests = resumed.open_requests;
        }
        if (turn.model) await rpc.request('config.set', { session_id: nativeId, key: 'model', value: `${turn.model} --session` }, turn.signal);
        if (turn.profile?.config.effort) await rpc.request('config.set', { session_id: nativeId, key: 'reasoning', value: `${turn.profile.config.effort} --session` }, turn.signal);
        activeTurn = true;
        // A still-open operation means the native turn never finished. Publish its card and attach to
        // that turn; submitting a new prompt here would be rejected and would lose the operation.
        if (pending) openConnection(pending, nativeId);
        bindingSession = false;
        flushEarlyNotifications();
        for (const event of earlyConnections.splice(0)) acceptConnection(event);
        const attached = rpc.replayOpenRequests(openRequests) > 0 || [...activeConnections.values()].some(tracked => connectionActionable(tracked.state));
        drainingPrevious = attached && (submittedMessageId ? submittedMessageId !== turn.messageId : !turn.retry);
        if (!attached) await submitPrompt();
      }
      yield* queue;
      await completed;
    } catch (error) { if (turn.signal.aborted) throw abortError(); throw new Error(safeError(error)); }
    finally { turnClosed = true; for (const timer of delayedQueueEnds) clearTimeout(timer); delayedQueueEnds.clear(); for (const controller of pendingServerRequests.values()) controller.abort(); pendingServerRequests.clear(); for (const timer of deadlines) clearTimeout(timer); deadlines.clear(); activeConnections.clear(); turn.signal.removeEventListener('abort', abort); unsub(); unsubscribeServerRequests(); }
  },
};

export { decode as decodeHermesNativeId, encode as encodeHermesNativeId };

import { useEffect, useRef, useState } from 'react';
import type { ConnectionCommand, ConnectionTarget, ConnectionView } from '../../../shared/types';
import { Button } from '../ui4a-ui';
import { Icon } from '../Icon';
import { MorphHeight } from '../MorphHeight';

/** Everything else is confirmed by the agent backend, never by a click in this card. */
const approvable = (target: ConnectionTarget) => target.kind === 'mcp' && (target.action === 'install' || target.action === 'enable');
const finished = (target: ConnectionTarget) => ['connected', 'skipped', 'expired'].includes(target.state);
const label: Record<string, string> = { connected: '已连接', skipped: '已跳过', expired: '已超时', failed: '未成功', not_connected: '未连接', initiated: '等待确认', pending: '待处理' };
const settlement: Record<string, string> = { all_resolved: '已全部处理', continue: '已继续对话', deadline: '已超时', interrupt: '已中止' };

export function ConnectionCard({ connection, onCommand }: { connection: ConnectionView; onCommand: (command: ConnectionCommand) => Promise<unknown> }) {
  const [env, setEnv] = useState<Record<string, Record<string, string>>>({});

  const [busy, setBusy] = useState('');
  const [error, setError] = useState<string>();
  const [motion, setMotion] = useState(false);
  const sending = useRef(false);
  const card = useRef<HTMLDivElement>(null);
  const result = useRef<HTMLParagraphElement>(null);
  const restoreFocus = useRef(false);

  const open = connection.actionable;
  const pending = connection.targets.filter(target => !finished(target));
  const closed = !open;

  useEffect(() => {
    // A closed operation must not keep a typed secret alive in component state.
    if (closed) setEnv({});
  }, [closed]);

  useEffect(() => {
    if (!closed || !restoreFocus.current) return;
    restoreFocus.current = false;
    result.current?.focus({ preventScroll: true });
  }, [closed]);

  useEffect(() => {
    if (!open) return;
    // Returning from the provider tab is the moment to ask the backend, once, with no polling loop.
    const onFocus = () => { void run({ action: 'check' }, 'check'); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  });

  const run = async (command: ConnectionCommand, tag: string) => {
    if (sending.current || !open) return;
    restoreFocus.current = Boolean(card.current?.contains(document.activeElement));
    sending.current = true; setBusy(tag); setError(undefined);
    try { await onCommand(command); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { sending.current = false; setBusy(''); }
  };

  type Answer = { name: string; status: 'approved' | 'skipped'; env?: Record<string, string> };
  const submit = (targets: Answer[], tag: string, settle = false) =>
    run({ action: 'respond', targets, ...(settle ? { settled_by: 'continue' as const } : {}) }, tag);

  const approve = (target: ConnectionTarget) => {
    const values = env[target.name] ?? {};
    const missing = target.required_env?.find(field => field.required && !field.hasDefault && !field.default.trim() && !values[field.name]?.trim());
    if (missing) { setError(`请先填写 ${missing.prompt || missing.name}`); return; }
    const provided = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim()));
    // Only after the backend confirms does this row change state; nothing is marked done locally.
    void submit([{ name: target.name, status: 'approved', ...(Object.keys(provided).length ? { env: provided } : {}) }], `approve:${target.name}`);
  };

  const skip = (names: string[], tag: string) => {

    void submit(names.map(name => ({ name, status: 'skipped' as const })), tag);
  };

  return <section ref={card} aria-label="连接授权" aria-busy={Boolean(busy)} data-motion={motion} data-settled={closed || undefined}
    className="connection-card w-full max-w-80 rounded-[10px] border border-border bg-surface shadow-sm data-[settled]:bg-transparent"
    onPointerDownCapture={() => setMotion(true)} onPointerMoveCapture={() => setMotion(true)} onKeyDownCapture={() => setMotion(false)}>
    <MorphHeight change={closed} animate={motion}>
      {open ? <div className="p-3">
        <p className="mb-2.5 text-sm font-medium">需要连接以下服务</p>
        {connection.targets.map(target => <TargetRow key={target.name} target={target} busy={busy}
          env={env[target.name] ?? {}}

          onEnv={(field, value) => setEnv(current => ({ ...current, [target.name]: { ...current[target.name], [field]: value } }))}
          onApprove={() => approve(target)}
          onSkip={() => skip([target.name], `skip:${target.name}`)} />)}
        {error ? <p role="alert" className="pt-1 text-xs text-danger">{error}</p> : null}
        <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-border pt-2.5">
          {/* Wake first, then read the authoritative state; the backend owns whether a target is connected. */}
          <Button size="sm" variant="secondary" style={{ height: 28, borderRadius: 999 }} className="px-3 text-xs" disabled={Boolean(busy)} onClick={() => void run({ action: 'check' }, 'check')}>
            {busy === 'check' ? '检查中…' : '检查状态'}
          </Button>
          {pending.length ? <Button size="sm" variant="ghost" style={{ height: 28, borderRadius: 999 }} className="px-3 text-xs" disabled={Boolean(busy)} onClick={() => skip(pending.map(target => target.name), 'skip-all')}>
            {busy === 'skip-all' ? '提交中…' : '全部跳过'}
          </Button> : null}
          {/* Continue settles the operation regardless of what is still unresolved. */}
          <Button size="sm" style={{ height: 28, borderRadius: 999 }} className="ml-auto px-3 text-xs" disabled={Boolean(busy)} onClick={() => void submit([], 'continue', true)}>
            {busy === 'continue' ? '提交中…' : '继续对话'}
          </Button>
        </div>
      </div> : <div className="p-3 text-xs">
        <p ref={result} role="status" aria-atomic="true" tabIndex={-1} className="flex items-center gap-1.5 text-muted outline-none">
          <Icon name={connection.settled_by === 'all_resolved' ? 'check' : 'x'} className="size-3.5" />
          连接操作{connection.settled_by ? settlement[connection.settled_by] : '已结束'}
        </p>
        <dl className="mt-2 space-y-1">{connection.targets.map(target => <div key={target.name} className="flex gap-2">
          <dt className="min-w-0 flex-1 truncate">{target.name}</dt>
          <dd className={target.state === 'connected' ? 'text-success' : 'text-muted'}>{label[target.state] ?? target.state}</dd>
        </div>)}</dl>
      </div>}
    </MorphHeight>
  </section>;
}

function TargetRow({ target, env, busy, onEnv, onApprove, onSkip }: {
  target: ConnectionTarget; env: Record<string, string>; busy: string;
  onEnv: (field: string, value: string) => void; onApprove: () => void; onSkip: () => void;
}) {
  if (finished(target)) return <div className="mb-1.5 flex gap-2 rounded-lg bg-surface-2 px-2 py-1.5 text-xs">
    <span className="min-w-0 flex-1 truncate font-medium">{target.name}</span>
    <span className={target.state === 'connected' ? 'text-success' : 'text-muted'}>{label[target.state] ?? target.state}</span>
  </div>;
  const disabled = Boolean(busy);
  return <fieldset disabled={disabled} className="mb-2 min-w-0 rounded-lg border border-border p-2.5">
    <legend className="float-left mb-1 w-full text-[13px] font-medium">{target.name}</legend>
    {target.instructions ? <p className="mb-1.5 text-xs text-muted">{target.instructions}</p> : null}
    {target.detail && (target.state === 'failed' || target.discovery_error) ? <p className="mb-1.5 text-xs text-danger">{target.detail}</p> : null}
    {/* Rendered only when the server already proved this is an absolute http(s) location. */}
    {target.connect_url ? <a href={target.connect_url} target="_blank" rel="noopener noreferrer" className="mb-1.5 inline-flex items-center gap-1 text-xs text-link hover:underline">
      打开授权页面 <Icon name="chevronRight" className="size-3" />
    </a> : null}
    {approvable(target) && target.required_env?.length ? <div className="mb-1.5 space-y-1.5">{target.required_env.map(field => <label key={field.name} className="block">
      <span className="mb-0.5 block text-[11px] text-muted">{field.prompt || field.name}{field.required ? ' *' : ''}</span>
      <input type={field.secret ? 'password' : 'text'} value={env[field.name] ?? ''} autoComplete="off" maxLength={4000}
        placeholder={field.hasDefault || field.default.trim() ? (field.secret ? '已有默认值' : field.default) : undefined}
        onChange={event => onEnv(field.name, event.target.value)}
        className="w-full min-w-0 rounded-lg border border-input-border bg-input-bg px-2 py-1 text-xs text-input-fg placeholder:text-input-placeholder focus:border-input-focus focus:outline-none" />
    </label>)}</div> : null}
    <div className="flex items-center gap-2">
      {/* No approve button for a hosted provider: the handshake happens in the provider's own page. */}
      {approvable(target) ? <Button size="sm" style={{ height: 26, borderRadius: 999 }} className="px-2.5 text-xs" disabled={disabled} onClick={onApprove}>
        {busy === `approve:${target.name}` ? '提交中…' : target.action === 'install' ? '安装' : '启用'}
      </Button> : null}
      <Button size="sm" variant="ghost" style={{ height: 26, borderRadius: 999 }} className="px-2.5 text-xs" disabled={disabled} onClick={onSkip}>
        {busy === `skip:${target.name}` ? '提交中…' : '跳过'}
      </Button>

    </div>
  </fieldset>;
}

import { useState } from 'react';
import type { Approval } from '../../../shared/types';
import { Button } from '../ui4a-ui';
import { CodeBlock } from '../code/CodeBlock';
import { Collapsible } from '../code/Collapsible';

export function ApprovalCard({ approval, onDecide }: { approval: Approval & { resolved?: boolean }; onDecide: (approved: boolean) => Promise<unknown> }) {
  const [decision, setDecision] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const decide = async (approved: boolean) => { setBusy(true); setError(undefined); try { await onDecide(approved); setDecision(approved); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); } };
  if (approval.resolved || decision !== undefined) return <p className="text-xs text-muted">{approval.tool} · {decision === false ? '已拒绝' : '已处理'}</p>;
  return <section className="rounded-xl border border-border p-3" aria-label="操作确认"><p className="mb-2 text-sm font-medium">允许 {approval.tool}？</p><Collapsible><CodeBlock code={JSON.stringify(approval.input, null, 2)} lang="json" /></Collapsible>{error ? <p role="alert" className="mt-2 text-xs text-danger">{error}</p> : null}<div className="mt-3 flex gap-2"><Button size="sm" disabled={busy} onClick={() => void decide(true)}>允许这次</Button><Button size="sm" variant="secondary" disabled={busy} onClick={() => void decide(false)}>拒绝</Button></div></section>;
}

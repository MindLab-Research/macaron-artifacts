import { useState } from 'react';
import type { ProviderReview } from '../../../shared/types';
import { Button } from '../ui4a-ui';

export function ProviderReviewBanner({ review, onRefresh }: { review: ProviderReview; onRefresh: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const refresh = async () => {
    setBusy(true); setError('');
    try { await onRefresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <section aria-label="服务商复核" className="mx-3 mb-2 flex flex-col gap-2 rounded-xl border border-contrast bg-surface-2 p-3 text-sm">
    <strong>会话已暂停，等待服务商复核</strong>
    <p className="whitespace-pre-wrap break-words text-muted">{review.explanation || '服务商要求人工复核，本会话暂时不能继续发送。'}</p>
    <p className="text-xs text-muted">{review.canContinue ? '请在 OpenClaw 官方界面完成复核，再回来检查状态。' : '服务商当前未提供继续入口，请在 OpenClaw 官方界面查看处理说明。'}</p>
    <div className="flex flex-wrap items-center gap-3">
      {review.controlUrl ? <a href={review.controlUrl} target="_blank" rel="noopener noreferrer" className="underline">在 OpenClaw 查看同一会话</a> : <span className="text-xs text-muted">请手动打开 OpenClaw，按当前原生会话查看复核；可用 OPENCLAW_CONTROL_URL 配置官方界面地址。</span>}
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>{busy ? '检查中…' : '检查复核状态'}</Button>
    </div>
    {error ? <p role="alert" className="break-words text-xs text-danger">{error}</p> : null}
  </section>;
}

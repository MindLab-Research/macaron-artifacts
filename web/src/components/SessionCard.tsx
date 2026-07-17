import { ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, fmtAgo, type SessionDetail, type Message } from '../lib/api';

type SessionStatus = 'completed' | 'running' | 'awaiting';

function getStatus(mtime: number): SessionStatus {
  if (Date.now() - mtime < 60_000) return 'running';
  return 'completed';
}

function statusColor(s: SessionStatus): string {
  if (s === 'running') return 'var(--accent)';
  if (s === 'awaiting') return 'var(--warn)';
  return 'var(--good)';
}

function statusLabel(s: SessionStatus): string {
  if (s === 'running') return 'Running...';
  if (s === 'awaiting') return 'Awaiting input';
  return 'Completed';
}

type LastMessages = Array<{
  id: string;
  kind: 'assistant' | 'tool' | 'user';
  text: string;
  toolName?: string;
}>;

function extractLast(messages: Message[], max = 5): LastMessages {
  const out: LastMessages = [];
  for (let i = messages.length - 1; i >= 0 && out.length < max; i--) {
    const m = messages[i]!;
    for (let j = m.blocks.length - 1; j >= 0 && out.length < max; j--) {
      const b = m.blocks[j]!;
      if (m.role === 'assistant' && b.kind === 'text' && b.text.trim()) {
        out.unshift({ id: `a${i}-${j}`, kind: 'assistant', text: b.text.slice(0, 200) });
      } else if (m.role === 'assistant' && b.kind === 'tool_use') {
        out.unshift({ id: `t${i}-${j}`, kind: 'tool', text: '', toolName: b.name });
      } else if (m.role === 'user' && b.kind === 'text' && b.text.trim() && !b.text.startsWith('<')) {
        out.unshift({ id: `u${i}-${j}`, kind: 'user', text: b.text.slice(0, 150) });
      }
    }
  }
  return out;
}

type Props = {
  project: string;
  sessionId: string;
  preview: string;
  mtime: number;
  gitBranch?: string;
  messageCount: number;
  focused?: boolean;
  onFocus?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
};

export function SessionCard({
  project,
  sessionId,
  preview,
  mtime,
  gitBranch,
  messageCount,
  focused,
  onFocus,
  onContextMenu,
}: Props) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [lastMsgs, setLastMsgs] = useState<LastMessages>([]);
  const status = getStatus(mtime);

  useEffect(() => {
    api
      .session(project, sessionId)
      .then((d) => {
        setDetail(d);
        setLastMsgs(extractLast(d.messages));
      })
      .catch(() => {});
  }, [project, sessionId]);

  return (
    <div
      className={'sc-card' + (focused ? ' sc-focused' : '')}
      onClick={onFocus}
      onContextMenu={onContextMenu}
    >
      <div className="sc-head">
        <div className="sc-head-left">
          <span className="sc-dot" style={{ background: statusColor(status) }} />
          <span className="sc-title">{preview || sessionId.slice(0, 8)}</span>
        </div>
        <div className="sc-head-right">
          {gitBranch && <span className="sc-branch">{gitBranch}</span>}
          <span className="sc-msgs">{messageCount} msgs</span>
        </div>
      </div>

      <div className="sc-thread">
        {lastMsgs.map((m) => {
          if (m.kind === 'tool') {
            return (
              <div key={m.id} className="sc-tool-row">
                <span className="sc-tool-dot" />
                <span className="sc-tool-name">{m.toolName}</span>
              </div>
            );
          }
          if (m.kind === 'user') {
            return (
              <div key={m.id} className="sc-user-row">
                <span className="sc-user-chevron"><ChevronRight size={14} aria-hidden="true" /></span>
                <span className="sc-user-text">{m.text}</span>
              </div>
            );
          }
          return (
            <div key={m.id} className="sc-assist-row">
              {m.text}
            </div>
          );
        })}
        {lastMsgs.length === 0 && !detail && (
          <div className="sc-loading">Loading...</div>
        )}
      </div>

      <div className={'sc-status sc-status-' + status}>
        <span className="sc-status-dot" style={{ background: statusColor(status) }} />
        <span className="sc-status-label">{statusLabel(status)}</span>
        {!focused && <span className="sc-status-hint">· click to focus</span>}
      </div>
    </div>
  );
}

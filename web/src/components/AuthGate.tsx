import { useEffect, useState, type ReactNode, type CSSProperties } from 'react';
import type { AuthStatusResponse } from '@macaron/shared';
import { authedFetch, getToken, setToken } from '../lib/auth';

// Gates the app behind the server's shared token when it's reachable from the
// network. On mount it asks the server whether this caller must authenticate;
// loopback callers (and servers with auth off) pass straight through. Uses
// self-contained inline styles so it renders identically in the claude paper
// theme and the codex zinc theme without depending on either's stylesheet.

type Phase = 'checking' | 'needed' | 'ok';

export function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [token, setTokenInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function check() {
    try {
      const r = await authedFetch('/api/auth/status');
      const j = (await r.json()) as AuthStatusResponse;
      setPhase(j.required ? 'needed' : 'ok');
    } catch {
      // Server unreachable — don't lock the user out of a purely local UI.
      setPhase('ok');
    }
  }

  useEffect(() => { void check(); }, []);

  // An expired / wrong token anywhere in the app re-arms the gate.
  useEffect(() => {
    const onRequired = () => setPhase('needed');
    window.addEventListener('macaron:auth-required', onRequired);
    return () => window.removeEventListener('macaron:auth-required', onRequired);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await authedFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
      });
      if (!r.ok) { setError('Invalid token'); setBusy(false); return; }
      setToken(token.trim());
      setPhase('ok');
    } catch {
      setError('Could not reach the server');
      setBusy(false);
    }
  }

  if (phase === 'ok') return <>{children}</>;
  if (phase === 'checking') return null;

  return (
    <div style={S.backdrop}>
      <form style={S.card} onSubmit={submit}>
        <div style={S.title}>Authentication required</div>
        <div style={S.subtitle}>This macaron server is protected. Enter its access token to continue.</div>
        <input
          style={S.input}
          type="password"
          autoFocus
          placeholder="Access token"
          value={token}
          onChange={(e) => setTokenInput(e.target.value)}
        />
        {error && <div style={S.error}>{error}</div>}
        <button style={{ ...S.button, ...(busy ? S.buttonBusy : null) }} type="submit" disabled={busy}>
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}

const S: Record<string, CSSProperties> = {
  backdrop: {
    position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: '#faf9f5', fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif', padding: 20,
  },
  card: {
    width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 12,
    background: '#fff', border: '1px solid #e8e6dc', borderRadius: 14, padding: '28px 24px',
    boxShadow: '0 8px 30px rgba(60,57,41,0.10)',
  },
  title: { fontSize: 17, fontWeight: 600, color: '#3d3929' },
  subtitle: { fontSize: 13, lineHeight: 1.5, color: '#8a8473', marginBottom: 4 },
  input: {
    width: '100%', boxSizing: 'border-box', padding: '10px 12px', fontSize: 14,
    border: '1px solid #d9d5c7', borderRadius: 8, background: '#faf9f5', color: '#3d3929', outline: 'none',
  },
  error: { fontSize: 12.5, color: '#c0524a' },
  button: {
    width: '100%', padding: '10px 12px', fontSize: 14, fontWeight: 600, cursor: 'pointer',
    border: '1px solid #c96442', borderRadius: 8, background: '#c96442', color: '#fff',
  },
  buttonBusy: { opacity: 0.6, cursor: 'default' },
};

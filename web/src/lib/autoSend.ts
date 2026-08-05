// Countdown auto-send for GenUI confirm widgets ("Commit / Don't commit", with
// one option as the default). The widget arms it via the `useAutoSend` hook from
// '$macaron/chat' and the HOST owns the timer, because the two things that make
// an auto-fire wrong are invisible from inside the widget: reopening a session
// re-mounts the very same TSX (a widget-local setTimeout would then auto-commit
// every time you revisit an old transcript), and a send issued while a turn is
// still streaming is silently dropped by send().

export type AutoSendTick = (remaining: number | null) => void;
export type ScheduleBridge = (prompt: string, seconds: number, onTick?: AutoSendTick) => () => void;

let pending: { interval: ReturnType<typeof setInterval>; onKey: () => void; token: object } | null = null;

export function cancelAutoSend(): void {
  if (!pending) return;
  const { interval, onKey } = pending;
  pending = null;
  clearInterval(interval);
  document.removeEventListener('keydown', onKey, true);
}

export function createScheduleBridge(host: {
  send: (prompt: string) => void;
  /** A turn is streaming — hold the countdown rather than fire into a send() that gets dropped. */
  isBusy: () => boolean;
  /** False until the user has spoken on this mount (reopened transcript, canvas replay): show the widget, never fire it. */
  isLive: () => boolean;
}): ScheduleBridge {
  return (prompt, seconds, onTick) => {
    cancelAutoSend();
    if (!host.isLive()) return () => {};
    let remaining = Math.max(1, Math.round(seconds));
    const token = {};
    const stop = () => {
      if (pending?.token !== token) return; // a later widget owns the timer now
      cancelAutoSend();
      onTick?.(null);
    };
    const interval = setInterval(() => {
      if (host.isBusy()) return; // the countdown starts once the turn it belongs to ends
      remaining -= 1;
      if (remaining > 0) return onTick?.(remaining);
      cancelAutoSend();
      onTick?.(null);
      host.send(prompt);
    }, 1000);
    pending = { interval, onKey: stop, token };
    document.addEventListener('keydown', stop, true); // typing = answering by hand
    onTick?.(remaining);
    return stop;
  };
}

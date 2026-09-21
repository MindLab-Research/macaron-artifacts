import { memo, useEffect, useState } from 'react';
import './LoadingState.css';

// Adapted from Beautiful UI's Drive loader (Shane Levine, MIT); notice ships in public/third-party-licenses/beautiful-ui.txt.
const pixels = Array.from({ length: 9 }, (_, index) => <span key={index} style={{ animationDelay: `${(index % 3 + Math.abs(Math.floor(index / 3) - 1)) * 90}ms` }} />);

export const LoadingState = memo(function LoadingState({ label }: { label: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = performance.now();
    let timer: ReturnType<typeof setInterval> | undefined;
    // Read the clock rather than counting ticks: background throttling must not lose waiting time.
    const update = () => setElapsed(Math.floor((performance.now() - started) / 100));
    const resume = () => { clearInterval(timer); if (!document.hidden) { update(); timer = setInterval(update, 100); } };
    resume(); document.addEventListener('visibilitychange', resume);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', resume); };
  }, []);
  const seconds = `${((elapsed % 600) / 10).toFixed(1)}s`;
  return <div className="loading-state" role="status" data-export-control>
    <span className="loading-state-grid" aria-hidden="true">{pixels}</span>
    <span className="loading-state-label">{label}</span>
    {/* A ticking live region would repeatedly interrupt screen readers; only the status label is announced. */}
    <span className="loading-state-elapsed" aria-hidden="true">{elapsed < 600 ? seconds : `${Math.floor(elapsed / 600)}m ${seconds}`}</span>
  </div>;
});

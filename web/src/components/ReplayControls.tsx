import { Pause, Play, RotateCcw, Settings2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { Message } from '@macaron/shared';
import { createReplayTimeline, replayFrame, type ReplayTiming } from '../lib/replay';

const SPEEDS = [1, 2, 5] as const;

export function useReplay(messages: Message[], disabled = false) {
  const [active, setActive] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const [timing, setTiming] = useState<ReplayTiming>('natural');
  const signature = `${messages.length}:${messages.at(-1)?.sourceLine ?? ''}:${messages.at(-1)?.timestamp ?? ''}`;
  const timeline = useMemo(() => createReplayTimeline(messages, timing), [signature, timing]);
  const duration = timeline.at(-1)?.end ?? 0;
  const visibleMessages = useMemo(() => active ? replayFrame(timeline, position) : messages, [active, messages, position, timeline]);

  useEffect(() => {
    setActive(false);
    setPlaying(false);
    setPosition(0);
  }, [signature]);

  useEffect(() => {
    if (!active || !playing) return;
    let animationFrame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const delta = now - previous;
      previous = now;
      setPosition((value) => Math.min(duration, value + delta * speed));
      animationFrame = window.requestAnimationFrame(tick);
    };
    animationFrame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [active, duration, playing, speed]);

  useEffect(() => {
    if (active && playing && position >= duration) setPlaying(false);
  }, [active, duration, playing, position]);

  const start = () => { setActive(true); setPosition(0); setPlaying(true); };
  const stop = () => { setActive(false); setPlaying(false); setPosition(0); };
  return {
    messages: visibleMessages,
    controls: disabled || messages.length < 2 ? null : (
      <div className="replay-controls" role="group" aria-label="Session replay">
        <button className="replay-button" onClick={active ? () => setPlaying((value) => !value) : start} title={active && playing ? 'Pause replay' : 'Play replay'} aria-label={active && playing ? 'Pause replay' : 'Play replay'}>
          {active && playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
        </button>
        <details className="replay-settings">
          <summary className="replay-button" title="Replay timing" aria-label="Replay timing"><Settings2 size={14} aria-hidden="true" /></summary>
          <div className="replay-settings-menu">
            <label htmlFor="replay-timing">Timing</label>
            <select id="replay-timing" value={timing} onChange={(event) => { setTiming(event.target.value as ReplayTiming); setPosition(0); setPlaying(false); }}>
              <option value="exact">Exact</option>
              <option value="natural">Natural (log)</option>
              <option value="compact">Compact (2s max)</option>
            </select>
            <span>{timing === 'exact' ? 'Original event timing' : timing === 'natural' ? 'Long waits use a logarithmic curve' : 'Every wait is capped at 2 seconds'}</span>
          </div>
        </details>
        {active && <button className="replay-button" onClick={stop} title="Exit replay" aria-label="Exit replay"><RotateCcw size={14} aria-hidden="true" /></button>}
        <input type="range" min={0} max={Math.max(1, duration)} value={active ? position : duration} onChange={(event) => { setActive(true); setPlaying(false); setPosition(Number(event.target.value)); }} aria-label="Replay position" />
        <span className="replay-count">{visibleMessages.length}/{messages.length}</span>
        <button className="replay-button replay-speed" onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length]!)} title="Replay speed">{speed}×</button>
      </div>
    ),
  };
}

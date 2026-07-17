import { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';

type GenUI = 'bar' | 'line' | 'scatter' | 'radar';
type Entry = { side: 'agent' | 'human'; w: number; tall?: boolean } | { genui: GenUI };

// One full loop of the placeholder conversation: plain alternating bubbles
// with an accent GenUI chart after every exchange. The feed cycles through
// this script forever, so the loop is seamless by construction.
const SCRIPT: Entry[] = [
  { side: 'human', w: 150 },
  { side: 'agent', w: 210, tall: true },
  { side: 'human', w: 96 },
  { genui: 'bar' },
  { side: 'human', w: 170 },
  { side: 'agent', w: 128 },
  { side: 'human', w: 84 },
  { genui: 'line' },
  { side: 'human', w: 112, tall: true },
  { side: 'agent', w: 190 },
  { side: 'human', w: 76 },
  { genui: 'scatter' },
  { side: 'human', w: 160 },
  { side: 'agent', w: 122, tall: true },
  { side: 'human', w: 140 },
  { genui: 'radar' },
];

const KEEP = 10;
const INITIAL = 4;

// Bars and dots grow from the baseline on mount; the springy overshoot lives
// in the easing so mount growth and later data changes share one transition.
const SPRING = 'cubic-bezier(0.34, 1.4, 0.64, 1)';

function useRaised() {
  const [raised, setRaised] = useState(false);
  useEffect(() => setRaised(true), []);
  return raised;
}

const BARS = [42, 68, 34, 88, 56, 74, 48, 62, 30, 80];

function BarChart() {
  const raised = useRaised();
  const [active, setActive] = useState(3);
  return (
    <div className="flex h-28 items-end gap-1.5">
      {BARS.map((h, i) => (
        <button
          key={i}
          type="button"
          aria-label={`Bar ${i + 1}`}
          onClick={() => setActive(i)}
          className={cn('flex-1 cursor-pointer rounded-t-md', i === active ? 'bg-genui' : 'bg-genui/40 hovered:bg-genui/60')}
          style={{ height: raised ? `${h}%` : '4%', transition: `height 0.6s ${SPRING}, background-color 0.2s`, transitionDelay: raised ? `${i * 40}ms` : '0ms' }}
        />
      ))}
    </div>
  );
}

const LINE = [22, 48, 38, 66, 55, 84, 68, 92];

function LineChart() {
  const raised = useRaised();
  const [active, setActive] = useState(5);
  const pts = LINE.map((v, i) => [(i / (LINE.length - 1)) * 100, 100 - v] as const);
  const d = `M${pts.map((p) => p.join(' ')).join(' L')}`;
  return (
    <div className="relative mx-2 h-28">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
        <path d={`${d} L100 100 L0 100 Z`} fill="var(--genui)" opacity={raised ? 0.12 : 0} style={{ transition: 'opacity 0.7s 0.5s' }} />
        {/* pathLength=1 normalizes the dash so a single dashoffset sweep draws the line */}
        <path
          d={d}
          fill="none"
          stroke="var(--genui)"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          pathLength={1}
          strokeDasharray="1"
          strokeDashoffset={raised ? 0 : 1}
          style={{ transition: 'stroke-dashoffset 1s cubic-bezier(0.5, 0, 0.3, 1)' }}
        />
      </svg>
      {pts.map(([x, y], i) => (
        <button
          key={i}
          type="button"
          aria-label={`Point ${i + 1}`}
          onClick={() => setActive(i)}
          className="absolute -translate-x-1/2 -translate-y-1/2 cursor-pointer p-1.5"
          style={{ left: `${x}%`, top: `${y}%` }}
        >
          {/* dot pop is timed to trail the ~1s line sweep across 8 points */}
          <span
            className={cn('chat-dot block size-2.5 rounded-full transition-all duration-200', i === active ? 'scale-125 bg-genui' : 'bg-genui/55 hovered:bg-genui/80')}
            style={{ animationDelay: `${i * 120}ms` }}
          />
        </button>
      ))}
    </div>
  );
}

// [x%, y%, size tier]
const SCATTER: [number, number, number][] = [
  [6, 62, 2], [13, 38, 3], [21, 55, 2], [28, 24, 2], [35, 48, 3], [42, 72, 2], [48, 16, 2],
  [55, 42, 3], [62, 62, 2], [68, 30, 2], [75, 52, 3], [82, 20, 2], [89, 45, 2], [95, 68, 2],
];

function ScatterChart() {
  const [active, setActive] = useState(7);
  return (
    <div className="relative h-28">
      {SCATTER.map(([x, y, s], i) => (
        <button
          key={i}
          type="button"
          aria-label={`Dot ${i + 1}`}
          onClick={() => setActive(i)}
          className="absolute -translate-x-1/2 -translate-y-1/2 cursor-pointer p-1.5"
          style={{ left: `${x}%`, top: `${y}%` }}
        >
          <span
            className={cn('chat-dot block rounded-full transition-all duration-200', s === 3 ? 'size-3' : 'size-2', i === active ? 'scale-150 bg-genui' : 'bg-genui/45 hovered:bg-genui/70')}
            style={{ animationDelay: `${i * 55}ms` }}
          />
        </button>
      ))}
    </div>
  );
}

const RADAR = [
  [0.85, 0.6, 0.75, 0.5, 0.9],
  [0.55, 0.85, 0.45, 0.8, 0.6],
  [0.7, 0.5, 0.9, 0.65, 0.45],
];

function radarPath(values: number[]) {
  const pts = values.map((v, i) => {
    const a = (Math.PI * 2 * i) / values.length - Math.PI / 2;
    return `${(50 + Math.cos(a) * 44 * v).toFixed(2)} ${(50 + Math.sin(a) * 44 * v).toFixed(2)}`;
  });
  return `M${pts.join(' L')} Z`;
}

function RadarChart() {
  const raised = useRaised();
  const [sel, setSel] = useState(0);
  const axes = RADAR[0].length;
  const d = radarPath(RADAR[sel]);
  return (
    <button type="button" aria-label="Radar dataset" onClick={() => setSel((s) => (s + 1) % RADAR.length)} className="mx-auto block h-28 cursor-pointer">
      <svg viewBox="0 0 100 100" className="size-full overflow-visible">
        {[1, 0.66, 0.33].map((r) => (
          <path key={r} d={radarPath(Array(axes).fill(r))} fill="none" stroke="currentColor" strokeWidth={0.75} className="text-fd-muted-foreground/30" />
        ))}
        {Array.from({ length: axes }, (_, i) => {
          const a = (Math.PI * 2 * i) / axes - Math.PI / 2;
          return <line key={i} x1={50} y1={50} x2={50 + Math.cos(a) * 44} y2={50 + Math.sin(a) * 44} stroke="currentColor" strokeWidth={0.75} className="text-fd-muted-foreground/30" />;
        })}
        {/* CSS `d` interpolates in Chromium, so clicking morphs the polygon springily */}
        <path
          d={d}
          fill="var(--genui)"
          fillOpacity={0.35}
          stroke="var(--genui)"
          strokeWidth={2}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          style={{
            d: `path("${d}")`,
            transform: raised ? 'scale(1)' : 'scale(0)',
            transformOrigin: '50px 50px',
            transition: `transform 0.7s ${SPRING}, d 0.5s ${SPRING}`,
          }}
        />
      </svg>
    </button>
  );
}

function GenUICard({ kind }: { kind: GenUI }) {
  return (
    <div className="w-full rounded-2xl rounded-bl-md bg-genui/10 p-4">
      {kind === 'bar' ? <BarChart /> : kind === 'line' ? <LineChart /> : kind === 'scatter' ? <ScatterChart /> : <RadarChart />}
    </div>
  );
}

function Row({ entry, animate }: { entry: Entry; animate: boolean }) {
  const human = 'side' in entry && entry.side === 'human';
  return (
    <div className={cn('grid', animate && 'chat-grow')}>
      <div className="min-h-0 overflow-hidden">
        <div className={cn('flex pt-3', human ? 'justify-end' : 'justify-start')}>
          <div className={cn(animate && 'chat-pop', human ? 'origin-bottom-right' : 'origin-bottom-left', 'genui' in entry ? 'w-[85%]' : 'max-w-[75%]')}>
            {'genui' in entry ? (
              <GenUICard kind={entry.genui} />
            ) : (
              <div
                className={cn('max-w-full rounded-2xl', human ? 'rounded-br-md bg-fd-foreground/10' : 'rounded-bl-md bg-fd-secondary')}
                style={{ width: entry.w, height: entry.tall ? 52 : 36 }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ChatShowcase() {
  const [rows, setRows] = useState(() => SCRIPT.slice(0, INITIAL).map((entry, id) => ({ id, entry, animate: false })));

  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let index = INITIAL;
    let id = INITIAL;
    let timer: number;
    const tick = () => {
      const entry = SCRIPT[index % SCRIPT.length];
      setRows((prev) => [...prev.slice(1 - KEEP), { id: id++, entry, animate: true }]);
      index++;
      // Dwell on GenUI blocks so they can be poked at before the chat moves on.
      timer = window.setTimeout(tick, 'genui' in entry ? 3400 : 950);
    };
    timer = window.setTimeout(tick, 1200);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="chat-mask relative h-105 overflow-hidden">
      <div className="absolute inset-x-0 bottom-0">
        {rows.map(({ id, entry, animate }) => (
          <Row key={id} entry={entry} animate={animate} />
        ))}
      </div>
    </div>
  );
}

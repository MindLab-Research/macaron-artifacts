import { createContext, memo, useContext, useEffect, useId, useRef, type ComponentProps, type ComponentType, type ReactElement } from 'react';
import { useGenUIRenderContext } from 'partial-react/render-context';
import { dequal } from 'dequal';
import * as Recharts from 'recharts';

export { CartesianGrid, Cell, Legend, ReferenceDot, ReferenceLine, Tooltip } from 'recharts';

const snapshots = new Map<string, ReactElement>();
const dataSnapshots = new Map<string, unknown>();
const ChartKey = createContext<string | undefined>(undefined);
function remember<T>(registry: Map<string, T>, key: string, value: T) {
  registry.delete(key); registry.set(key, value);
  if (registry.size > 256) registry.delete(registry.keys().next().value!);
}

export type ChartContainerProps = Omit<ComponentProps<'div'>, 'children'> & { children?: ReactElement; height?: number };
export function ChartContainer({ id, children, height = 240, className = '', style, ...props }: ChartContainerProps) {
  const fallback = useId();
  const { rendererScope, streamingPartialFrame, nextStreamingRenderKey } = useGenUIRenderContext();
  const key = `${rendererScope}:${id ?? nextStreamingRenderKey?.() ?? fallback}`;
  // A partial module can reopen the container before its series arrive. Keep the last complete chart visible.
  const content = streamingPartialFrame ? snapshots.get(key) ?? children : children;
  useEffect(() => { if (!streamingPartialFrame && children) remember(snapshots, key, children); }, [key, children, streamingPartialFrame]);
  return <ChartKey.Provider value={key}><div {...props} id={id} className={`ui4a-chart ${className}`} style={{ width: '100%', minWidth: 0, height, ...style }}>
    <Recharts.ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 320, height }}>{content ?? <span />}</Recharts.ResponsiveContainer>
  </div></ChartKey.Provider>;
}

function streamingChart<P extends object>(Component: ComponentType<P>, series = false) {
  const name = Component.displayName ?? Component.name;
  const Chart = memo(function StreamingChart(props: P) {
    const fallback = useId(), container = useContext(ChartKey);
    const { rendererScope, streamingPartialFrame, nextStreamingRenderKey } = useGenUIRenderContext();
    const supplied = props as P & { id?: string; data?: unknown; isAnimationActive?: boolean };
    const key = `${container ?? rendererScope}:${name}:${supplied.id ?? nextStreamingRenderKey?.() ?? fallback}`;
    const mounted = useRef(false), previous = dataSnapshots.get(key);
    const replay = streamingPartialFrame && !mounted.current && previous !== undefined;
    const data = replay || dequal(previous, supplied.data) ? previous : supplied.data;
    useEffect(() => { mounted.current = true; if (supplied.data !== undefined) remember(dataSnapshots, key, replay ? supplied.data : data); }, [data, supplied.data, key, replay]);
    return <Component {...props} {...('data' in props || replay ? { data } : {})} {...(series ? { isAnimationActive: !streamingPartialFrame && (supplied.isAnimationActive ?? false) } : {})} />;
  });
  // Recharts still uses displayName to recognize certain child primitives.
  Chart.displayName = name;
  return Chart;
}

export const LineChart = streamingChart(Recharts.LineChart);
export const AreaChart = streamingChart(Recharts.AreaChart);
export const BarChart = streamingChart(Recharts.BarChart);
export const ComposedChart = streamingChart(Recharts.ComposedChart);
export const PieChart = streamingChart(Recharts.PieChart);
export const Line = streamingChart(Recharts.Line, true);
export const Area = streamingChart(Recharts.Area, true);
export const Bar = streamingChart(Recharts.Bar, true);
export const Pie = streamingChart(Recharts.Pie, true);

function streamingAxis<P extends object>(Component: ComponentType<P>) {
  function Axis(props: P) {
    const { streamingPartialFrame } = useGenUIRenderContext();
    const functions = useRef<Map<string, { source: string; latest: (...args: unknown[]) => unknown; dispatch: (...args: unknown[]) => unknown }> | undefined>(undefined);
    const previousDomain = useRef<unknown[]>(undefined);
    const stable = { ...props } as Record<string, unknown>;
    function pin(key: string, value: unknown): unknown {
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      const entries = functions.current ??= new Map();
      let entry = entries.get(key);
      if (!entry || (entry.latest !== fn && entry.source !== fn.toString())) {
        const created = { source: fn.toString(), latest: fn, dispatch: (...args: unknown[]): unknown => created.latest(...args) };
        entries.set(key, entry = created);
      }
      entry.latest = fn;
      return entry.dispatch;
    }
    // Only pin while source is arriving: after completion, closures over slider state must invalidate the axis normally.
    if (streamingPartialFrame) {
      for (const key of ['tickFormatter', 'tick', 'label']) stable[key] = pin(key, stable[key]);
      if (Array.isArray(stable.domain)) {
        const domain = stable.domain.map((value, index) => pin(`domain:${index}`, value)), previous = previousDomain.current;
        if (!previous || domain.length !== previous.length || domain.some((value, index) => value !== previous[index])) previousDomain.current = domain;
        stable.domain = previousDomain.current;
      } else stable.domain = pin('domain', stable.domain);
    }
    return <Component {...stable as P} />;
  }
  Axis.displayName = Component.displayName ?? Component.name;
  return Axis;
}

export const XAxis = streamingAxis(Recharts.XAxis);
export const YAxis = streamingAxis(Recharts.YAxis);

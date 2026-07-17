import { ChartContainer as BaseChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartContainerProps } from "@/components/ui/chart";
import { useGenUIRenderContext } from "partial-react/render-context";
import {
  Area as RechartsArea,
  AreaChart as RechartsAreaChart,
  Bar as RechartsBar,
  BarChart as RechartsBarChart,
  CartesianGrid as RechartsCartesianGrid,
  ComposedChart as RechartsComposedChart,
  Label as RechartsLabel,
  LabelList as RechartsLabelList,
  Legend,
  Line as RechartsLine,
  LineChart as RechartsLineChart,
  Pie as RechartsPie,
  PieChart as RechartsPieChart,
  PolarAngleAxis as RechartsPolarAngleAxis,
  PolarGrid as RechartsPolarGrid,
  Radar as RechartsRadar,
  RadarChart as RechartsRadarChart,
  RadialBar as RechartsRadialBar,
  RadialBarChart as RechartsRadialBarChart,
  Sector as RechartsSector,
  Tooltip,
  XAxis as RechartsXAxis,
  YAxis as RechartsYAxis,
  type AreaProps,
  type BarProps,
  type LineProps,
  type PieProps,
  type RadarProps,
  type RadialBarProps,
} from "recharts";
import { createContext, memo, useContext, useEffect, useId, useMemo, useState, type ComponentType, type ReactNode } from "react";
import type { CartesianChartProps, PolarChartProps } from "recharts/types/util/types";
import type { Props as CartesianGridProps } from "recharts/types/cartesian/CartesianGrid";
import type { Props as LabelProps } from "recharts/types/component/Label";
import type { Props as LabelListProps } from "recharts/types/component/LabelList";
import type { RenderableText } from "recharts/types/component/Text";
import type { Props as PolarAngleAxisProps } from "recharts/types/polar/PolarAngleAxis";
import type { Props as PolarGridProps } from "recharts/types/polar/PolarGrid";
import type { Props as SectorProps } from "recharts/types/shape/Sector";
import type { Props as XAxisProps } from "recharts/types/cartesian/XAxis";
import type { Props as YAxisProps } from "recharts/types/cartesian/YAxis";

export type CartesianChartRootProps = CartesianChartProps<unknown> & { ref?: React.Ref<SVGSVGElement> };
export type PolarChartRootProps = PolarChartProps<unknown> & { ref?: React.Ref<SVGSVGElement> };
export type CartesianGridComponentProps = CartesianGridProps;
export type ChartAnimationProps = { isAnimationActive?: boolean | "auto" };
export type LabelComponentProps = LabelProps;
export type LabelListComponentProps = Omit<LabelListProps, "formatter"> & { formatter?: ((label: RenderableText) => RenderableText) | ((label: number) => RenderableText) | ((label: string) => RenderableText) };
export type PolarAngleAxisComponentProps = PolarAngleAxisProps;
export type PolarGridComponentProps = PolarGridProps;
export type SectorComponentProps = SectorProps;
export type StreamingChartDataProps = { data?: unknown };
export type XAxisComponentProps = XAxisProps;
export type YAxisComponentProps = YAxisProps;
type StreamingChartState = { previousData?: unknown; streamingPartialFrame: boolean; mounted: boolean };

const STREAMING_CHART_REGISTRY_LIMIT = 256;
const streamingChartRegistry = new Map<string, unknown>();
const streamingChartContainerRegistry = new Map<string, ReactNode>();
const StreamingChartKeyContext = createContext<string | undefined>(undefined);
const StreamingChartContext = createContext({ replayingPreviousData: false });
export const resolveStreamingChartAnimation = <T extends ChartAnimationProps>(props: T, replayingPreviousData: boolean): T => (replayingPreviousData ? { ...props, isAnimationActive: false } : props);
export const resolveStreamingChartData = <T extends StreamingChartDataProps>(props: T, state: StreamingChartState): T => (state.streamingPartialFrame && !state.mounted && state.previousData !== undefined ? { ...props, data: state.previousData } : props);
export const resolveStreamingChartFrame = <T extends StreamingChartDataProps>(props: T, state: StreamingChartState) => {
  const resolvedProps = resolveStreamingChartData(props, state);
  return { props: resolvedProps, replayingPreviousData: resolvedProps.data !== props.data, dataToRemember: props.data };
};

const getStreamingChartRegistryKey = (rendererScope: string, id: string | undefined, fallbackId: string) => `${rendererScope}:${id ?? fallbackId}`;
const getStreamingChartItemRegistryKey = (registryKey: string, item: string, props: { id?: unknown; dataKey?: unknown; nameKey?: unknown }, fallbackId: string) => `${registryKey}:${item}:${String(props.id ?? "")}:${String(props.dataKey ?? "")}:${String(props.nameKey ?? "")}:${fallbackId}`;
export const sanitizeChartId = (id: string) => id.replace(/:/g, "");
const rememberInBoundedRegistry = <V,>(registryKey: string, value: V, registry: Map<string, V>) => {
  if (registry.has(registryKey)) registry.delete(registryKey);
  registry.set(registryKey, value);
  while (registry.size > STREAMING_CHART_REGISTRY_LIMIT) {
    const oldestKey = registry.keys().next().value;
    if (oldestKey === undefined) break;
    registry.delete(oldestKey);
  }
};
export const rememberStreamingChartData = (registryKey: string, data: unknown, registry = streamingChartRegistry) => {
  if (data === undefined) return;
  rememberInBoundedRegistry(registryKey, data, registry);
};
export const rememberStreamingChartContainerSnapshot = (registryKey: string, children: ReactNode, registry = streamingChartContainerRegistry) => rememberInBoundedRegistry(registryKey, children, registry);
export const resolveStreamingChartChildren = (children: ReactNode, state: { previousChildren?: ReactNode; streamingPartialFrame: boolean }) => (state.streamingPartialFrame && state.previousChildren !== undefined ? state.previousChildren : children);

const useStreamingChartFrame = <P extends StreamingChartDataProps>(props: P, registryKeyPart?: string) => {
  const fallbackId = useId();
  const containerKey = useContext(StreamingChartKeyContext);
  const { rendererScope, streamingPartialFrame, nextStreamingRenderKey } = useGenUIRenderContext();
  const explicitId = (props as { id?: string }).id;
  let stableFallbackId: string | undefined;
  const getStableFallbackId = () => (stableFallbackId ??= nextStreamingRenderKey?.() ?? fallbackId);
  const registryKeyBase = containerKey ?? (explicitId === undefined ? getStreamingChartRegistryKey(rendererScope, undefined, getStableFallbackId()) : getStreamingChartRegistryKey(rendererScope, explicitId, ""));
  const registryKey = registryKeyPart ? getStreamingChartItemRegistryKey(registryKeyBase, registryKeyPart, props as { id?: unknown; dataKey?: unknown; nameKey?: unknown }, getStableFallbackId()) : registryKeyBase;
  const previousData = streamingChartRegistry.get(registryKey);
  const [mounted, setMounted] = useState(false);
  const frame = resolveStreamingChartFrame(props, { previousData, streamingPartialFrame, mounted });

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    rememberStreamingChartData(registryKey, frame.dataToRemember);
  }, [frame.dataToRemember, registryKey]);

  return frame;
};

/**
 * Local shadcn chart wrapper around a Recharts chart. Always give it a stable visible height such as className='h-44 min-h-44 w-full'; never place it in a zero-height, hidden, or absolute-only container.
 * @param config Maps series keys to labels/colors used by ChartTooltipContent and ChartLegendContent.
 */
function ChartContainer({ id, children, ...props }: ChartContainerProps) {
  const fallbackId = useId();
  const { rendererScope, streamingPartialFrame, nextStreamingRenderKey } = useGenUIRenderContext();
  const stableId = id ?? nextStreamingRenderKey?.() ?? fallbackId;
  const registryKey = getStreamingChartRegistryKey(rendererScope, id, stableId);
  // Partial TSX can reopen ChartContainer before its bars/lines arrive; replay complete children so Recharts does not blank and regrow.
  const resolvedChildren = resolveStreamingChartChildren(children, { previousChildren: streamingChartContainerRegistry.get(registryKey), streamingPartialFrame });
  useEffect(() => {
    if (!streamingPartialFrame) rememberStreamingChartContainerSnapshot(registryKey, children);
  }, [children, registryKey, streamingPartialFrame]);
  return (
    <StreamingChartKeyContext.Provider value={registryKey}>
      <BaseChartContainer id={id ?? sanitizeChartId(stableId)} {...props}>
        {resolvedChildren}
      </BaseChartContainer>
    </StreamingChartKeyContext.Provider>
  );
}

const withStreamingChartData = <P extends StreamingChartDataProps>(Component: ComponentType<P>) => {
  const StreamingAwareChartRoot = memo(function StreamingAwareChartRoot(props: P) {
    const frame = useStreamingChartFrame(props);
    const contextValue = useMemo(() => ({ replayingPreviousData: frame.replayingPreviousData }), [frame.replayingPreviousData]);

    return (
      <StreamingChartContext.Provider value={contextValue}>
        <Component {...frame.props} />
      </StreamingChartContext.Provider>
    );
  });
  StreamingAwareChartRoot.displayName = (Component as ComponentType<P> & { displayName?: string }).displayName ?? Component.name;
  return StreamingAwareChartRoot;
};

const withStreamingChartAnimation = <P extends ChartAnimationProps>(Component: ComponentType<P>) => {
  const StreamingAwareChartPrimitive = memo(function StreamingAwareChartPrimitive(props: P) {
    const { replayingPreviousData } = useContext(StreamingChartContext);
    return <Component {...resolveStreamingChartAnimation(props, replayingPreviousData)} />;
  });
  // Recharts still has displayName-based child lookup paths; wrapped primitives must remain recognizable.
  StreamingAwareChartPrimitive.displayName = (Component as ComponentType<P> & { displayName?: string }).displayName ?? Component.name;
  return StreamingAwareChartPrimitive;
};

const withStreamingChartDataAnimation = <P extends ChartAnimationProps & StreamingChartDataProps>(Component: ComponentType<P>, registryKeyPart: string) => {
  const StreamingAwareChartPrimitive = memo(function StreamingAwareChartPrimitive(props: P) {
    const { replayingPreviousData } = useContext(StreamingChartContext);
    const frame = useStreamingChartFrame(props, registryKeyPart);
    return <Component {...resolveStreamingChartAnimation(frame.props, replayingPreviousData || frame.replayingPreviousData)} />;
  });
  // Recharts still has displayName-based child lookup paths; wrapped primitives must remain recognizable.
  StreamingAwareChartPrimitive.displayName = (Component as ComponentType<P> & { displayName?: string }).displayName ?? Component.name;
  return StreamingAwareChartPrimitive;
};

/**
 * One-series compact metric trends, filled trend areas, or soft background trend charts.
 * @param data Array of row objects shared by child Area/XAxis/YAxis via dataKey.
 */
const AreaChart = withStreamingChartData<CartesianChartRootProps>(RechartsAreaChart);
/**
 * Category comparisons, rankings, and single-year/country comparisons.
 * @param data Array of row objects shared by child Bar/XAxis/YAxis via dataKey.
 */
const BarChart = withStreamingChartData<CartesianChartRootProps>(RechartsBarChart);
/**
 * Mixed bars and lines when magnitude/volume and rate/index need one panel.
 * @param data Array of row objects; set yAxisId on child series when units differ.
 */
const ComposedChart = withStreamingChartData<CartesianChartRootProps>(RechartsComposedChart);
/**
 * Time-series comparisons, multi-year comparisons, and trend lines.
 * @param data Array of row objects shared by child Line/XAxis/YAxis via dataKey.
 */
const LineChart = withStreamingChartData<CartesianChartRootProps>(RechartsLineChart);
/**
 * Composition or percentage share when a compact part-to-whole view is clearer than bars.
 * @param data Array of slice objects; child Pie needs dataKey for value and nameKey for label.
 */
const PieChart = withStreamingChartData<PolarChartRootProps>(RechartsPieChart);
/**
 * Multivariate profile/radar comparisons.
 * @param data Array of axis/category objects shared by Radar and PolarAngleAxis.
 */
const RadarChart = withStreamingChartData<PolarChartRootProps>(RechartsRadarChart);
/**
 * Radial progress or radial magnitude charts.
 * @param data Array of radial segment objects shared by RadialBar.
 */
const RadialBarChart = withStreamingChartData<PolarChartRootProps>(RechartsRadialBarChart);
/**
 * Filled series inside AreaChart.
 * @param dataKey Series key in the chart data rows.
 * @param fill Use var(--color-key) from ChartContainer config for shadcn color binding.
 */
const Area = withStreamingChartDataAnimation<AreaProps<unknown, unknown>>(RechartsArea, "Area");
/**
 * Bar series inside BarChart or ComposedChart.
 * @param dataKey Series key in the chart data rows.
 * @param yAxisId Match a YAxis id when using dual-axis ComposedChart layouts.
 */
const Bar = withStreamingChartDataAnimation<BarProps<unknown, unknown>>(RechartsBar, "Bar");
/**
 * Line series inside LineChart or ComposedChart.
 * @param dataKey Series key in the chart data rows.
 * @param yAxisId Match a YAxis id when using dual-axis ComposedChart layouts.
 */
const Line = withStreamingChartDataAnimation<LineProps<unknown, unknown>>(RechartsLine, "Line");
/**
 * Slice series inside PieChart.
 * @param dataKey Numeric value key for each slice.
 * @param nameKey Label key for each slice.
 */
const Pie = withStreamingChartDataAnimation<PieProps<unknown, unknown>>(RechartsPie, "Pie");
/**
 * Radar series inside RadarChart.
 * @param dataKey Numeric value key for each radar axis.
 */
const Radar = withStreamingChartAnimation<RadarProps<unknown, unknown>>(RechartsRadar);
/**
 * Radial series inside RadialBarChart.
 * @param dataKey Numeric value key for each radial segment.
 */
const RadialBar = withStreamingChartAnimation<RadialBarProps<unknown, unknown>>(RechartsRadialBar);
function LabelList(props: LabelListComponentProps) {
  return <RechartsLabelList {...(props as LabelListProps)} />;
}
LabelList.displayName = "LabelList";

export { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, Legend, Tooltip };
export type { ChartConfig } from "@/components/ui/chart";
export { Area, AreaChart, Bar, BarChart, ComposedChart, Line, LineChart, Pie, PieChart, Radar, RadarChart, RadialBar, RadialBarChart };
/** Subtle grid lines for cartesian charts. */
export const CartesianGrid = RechartsCartesianGrid;
/** Recharts label renderer for chart primitives. Import from '$macaron/ui/charts' to avoid confusing it with the macaron form Label. */
export const Label = RechartsLabel;
/** Direct labels on bar, radial, or other Recharts series when axes/tooltips are not enough. */
export { LabelList };
/**
 * Category labels around RadarChart.
 * @param dataKey Category label key in the chart data rows.
 */
export const PolarAngleAxis = RechartsPolarAngleAxis;
/** Radial grid lines for RadarChart or polar charts. */
export const PolarGrid = RechartsPolarGrid;
/** Custom active pie sectors or custom pie shapes. */
export const Sector = RechartsSector;
/**
 * Horizontal axis for cartesian charts.
 * @param dataKey Category/time key in the chart data rows.
 * @param hide Removes the visual axis while preserving layout.
 */
export const XAxis = RechartsXAxis;
/**
 * Vertical axis for cartesian charts.
 * @param yAxisId Must match child series yAxisId for dual-axis ComposedChart layouts.
 * @param orientation Use "right" for the secondary axis in dual-axis layouts.
 */
export const YAxis = RechartsYAxis;
export type { PieSectorShapeProps } from "recharts/types/polar/Pie";

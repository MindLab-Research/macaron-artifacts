"use client";

import React from "react";
import { Legend, ResponsiveContainer, Tooltip, type DefaultLegendContentProps, type DefaultTooltipContentProps, type LegendProps, type TooltipProps, type TooltipValueType } from "recharts";
import { cn } from "@/lib/style";

const THEMES = { light: "", dark: ".dark" } as const;
const INITIAL_DIMENSION = { width: 320, height: 200 } as const;
type TooltipNameType = number | string;

/**
 * Maps chart data keys to labels, icons, and colors shared by ChartContainer, ChartTooltipContent, and ChartLegendContent. Keys should match series dataKey/nameKey/labelKey; use either color or theme, not both.
 * @example const chartConfig = { revenue: { label: "Revenue", color: "var(--chart-1)" } } satisfies ChartConfig
 * @see https://ui.shadcn.com/charts
 */
export type ChartConfig = Record<string, { label?: React.ReactNode; icon?: React.ComponentType } & ({ color?: string; theme?: never } | { color?: never; theme: Record<keyof typeof THEMES, string> })>;
export type ChartContainerProps = React.ComponentProps<"div"> & { config: ChartConfig; children: React.ComponentProps<typeof ResponsiveContainer>["children"]; initialDimension?: { width: number; height: number } };
export type ChartTooltipProps = TooltipProps<TooltipValueType, TooltipNameType>;
export type ChartLegendProps = LegendProps;
export type ChartTooltipContentProps = TooltipProps<TooltipValueType, TooltipNameType> &
  React.ComponentProps<"div"> & { hideLabel?: boolean; hideIndicator?: boolean; indicator?: "line" | "dot" | "dashed"; nameKey?: string; labelKey?: string } & Omit<DefaultTooltipContentProps<TooltipValueType, TooltipNameType>, "accessibilityLayer">;
export type ChartLegendContentProps = React.ComponentProps<"div"> & { hideIcon?: boolean; nameKey?: string } & DefaultLegendContentProps;

type ChartContextProps = { config: ChartConfig };

const ChartContext = React.createContext<ChartContextProps | null>(null);

function useChart() {
  const context = React.useContext(ChartContext);
  if (!context) throw new Error("useChart must be used within a <ChartContainer />");
  return context;
}

/**
 * Local shadcn chart wrapper around a Recharts chart. Always give it a stable visible height such as className='h-44 min-h-44 w-full'; never place it in a zero-height, hidden, or absolute-only container.
 * @param config Maps series keys to labels/colors consumed by tooltip and legend content.
 * @param initialDimension Fallback size for first render before ResponsiveContainer measures.
 */
function ChartContainer({ id, className, children, config, initialDimension = INITIAL_DIMENSION, ...props }: ChartContainerProps) {
  const uniqueId = React.useId();
  const chartId = `chart-${id ?? uniqueId.replaceAll(":", "")}`;
  const contextValue = React.useMemo(() => ({ config }), [config]);

  return (
    <ChartContext.Provider value={contextValue}>
      <div
        data-slot="chart"
        data-chart={chartId}
        className={cn(
          "flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-none [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border [&_.recharts-sector]:outline-none [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-surface]:outline-none",
          className,
        )}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <ResponsiveContainer initialDimension={initialDimension}>{children}</ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

const ChartStyle = ({ id, config }: { id: string; config: ChartConfig }) => {
  const css = React.useMemo(() => {
    const colorConfig = Object.entries(config).filter(([, config]) => config.theme ?? config.color);
    if (colorConfig.length === 0) return "";

    return Object.entries(THEMES)
      .map(
        ([theme, prefix]) => `
${prefix} [data-chart=${id}] {
${colorConfig
  .map(([key, itemConfig]) => {
    const color = itemConfig.theme?.[theme as keyof typeof itemConfig.theme] ?? itemConfig.color;
    return color ? `  --color-${key}: ${color};` : null;
  })
  .join("\n")}
}
`,
      )
      .join("\n");
  }, [config, id]);

  if (!css) return null;

  return <style dangerouslySetInnerHTML={{ __html: css }} />;
};

/** Shadcn-styled Tooltip wrapper. Prefer it over raw Recharts Tooltip unless a custom Recharts-only behavior is required. */
const ChartTooltip: React.ComponentType<ChartTooltipProps> = Tooltip;

/**
 * Content renderer for ChartTooltip.
 * @param nameKey Overrides which payload field maps to ChartContainer config.
 * @param labelKey Overrides the heading label lookup.
 * @param indicator Visual marker style for each series row.
 */
function ChartTooltipContent({ active, payload, className, indicator = "dot", hideLabel = false, hideIndicator = false, label, labelFormatter, labelClassName, formatter, color, nameKey, labelKey }: ChartTooltipContentProps) {
  const { config } = useChart();

  const tooltipLabel = React.useMemo(() => {
    if (hideLabel || !payload?.length) return null;
    const [item] = payload;
    const key = `${labelKey ?? item?.dataKey ?? item?.name ?? "value"}`;
    const itemConfig = getPayloadConfigFromPayload(config, item, key);
    const value = !labelKey && typeof label === "string" ? (config[label]?.label ?? label) : itemConfig?.label;

    if (labelFormatter) return <div className={cn("font-medium", labelClassName)}>{labelFormatter(value, payload)}</div>;
    if (!value) return null;
    return <div className={cn("font-medium", labelClassName)}>{value}</div>;
  }, [label, labelFormatter, payload, hideLabel, labelClassName, config, labelKey]);

  if (!active || !payload?.length) return null;

  const nestLabel = payload.length === 1 && indicator !== "dot";

  return (
    <div className={cn("grid min-w-32 items-start rounded-xl border border-black/[0.08] bg-white/95 px-3 py-2 text-xs text-[#3d352f] shadow-[0_12px_36px_rgba(61,53,47,0.12)] backdrop-blur-md", className)}>
      {!nestLabel ? tooltipLabel : null}
      <div className="grid gap-1.5">
        {payload
          .filter((item) => item.type !== "none")
          .map((item, index) => {
            const key = `${nameKey ?? item.name ?? item.dataKey ?? "value"}`;
            const itemConfig = getPayloadConfigFromPayload(config, item, key);
            const indicatorColor = color ?? item.payload?.fill ?? item.color;
            const itemKey = `${item.dataKey ?? item.name ?? index}`;

            return (
              <div key={itemKey} className={cn("flex w-full flex-wrap items-stretch gap-2 [&>svg]:h-2.5 [&>svg]:w-2.5 [&>svg]:text-muted-foreground", indicator === "dot" && "items-center")}>
                {formatter && item?.value !== undefined && item.name ? (
                  formatter(item.value, item.name, item, index, item.payload)
                ) : (
                  <>
                    {itemConfig?.icon ? (
                      <itemConfig.icon />
                    ) : (
                      !hideIndicator && (
                        <div
                          className={cn("shrink-0 rounded-[2px] border [background-color:var(--color-bg)] [border-color:var(--color-border)]", {
                            "h-2.5 w-2.5": indicator === "dot",
                            "w-1": indicator === "line",
                            "w-0 border-[1.5px] border-dashed bg-transparent": indicator === "dashed",
                            "my-0.5": nestLabel && indicator === "dashed",
                          })}
                          style={{ "--color-bg": indicatorColor, "--color-border": indicatorColor } as React.CSSProperties}
                        />
                      )
                    )}
                    <div className={cn("flex flex-1 justify-between leading-none", nestLabel ? "items-end" : "items-center")}>
                      <div className="grid gap-1.5">
                        {nestLabel ? tooltipLabel : null}
                        <span className="text-muted-foreground">{itemConfig?.label ?? item.name}</span>
                      </div>
                      {item.value !== null && item.value !== undefined && <span className="font-mono font-medium text-foreground tabular-nums">{typeof item.value === "number" ? item.value.toLocaleString() : String(item.value)}</span>}
                    </div>
                  </>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}

/** Shadcn-styled Legend wrapper. Prefer it over raw Recharts Legend unless a custom Recharts-only behavior is required. */
const ChartLegend: React.ComponentType<ChartLegendProps> = Legend;

/**
 * Content renderer for ChartLegend.
 * @param nameKey Overrides which payload field maps to ChartContainer config.
 * @param hideIcon Hides config icons but keeps color swatches.
 */
function ChartLegendContent({ className, hideIcon = false, payload, verticalAlign = "bottom", nameKey }: ChartLegendContentProps) {
  const { config } = useChart();
  if (!payload?.length) return null;

  return (
    <div className={cn("flex items-center justify-center gap-4 text-xs text-[#8a7e72]", verticalAlign === "top" ? "pb-3" : "pt-3", className)}>
      {payload
        .filter((item) => item.type !== "none")
        .map((item, index) => {
          const key = `${nameKey ?? item.dataKey ?? "value"}`;
          const itemConfig = getPayloadConfigFromPayload(config, item, key);
          const itemKey = `${item.dataKey ?? item.value ?? index}`;

          return (
            <div key={itemKey} className="flex items-center gap-1.5 [&>svg]:h-3 [&>svg]:w-3 [&>svg]:text-muted-foreground">
              {itemConfig?.icon && !hideIcon ? <itemConfig.icon /> : <div className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: item.color }} />}
              {itemConfig?.label}
            </div>
          );
        })}
    </div>
  );
}

function getPayloadConfigFromPayload(config: ChartConfig, payload: unknown, key: string) {
  if (typeof payload !== "object" || payload === null) return;

  const payloadPayload = "payload" in payload && typeof payload.payload === "object" && payload.payload !== null ? payload.payload : undefined;
  let configLabelKey = key;

  if (key in payload && typeof payload[key as keyof typeof payload] === "string") configLabelKey = payload[key as keyof typeof payload] as string;
  else if (payloadPayload && key in payloadPayload && typeof payloadPayload[key as keyof typeof payloadPayload] === "string") configLabelKey = payloadPayload[key as keyof typeof payloadPayload] as string;

  return configLabelKey in config ? config[configLabelKey] : config[key];
}

export { ChartContainer, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent, ChartStyle };

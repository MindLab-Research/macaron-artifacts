// $macaron/ui/charts shim — re-exports the real vendored library via window.
const C = globalThis.__macaron_Charts;
if (!C) throw new Error('[genui-shim/charts] window.__macaron_Charts not set');

export const {
  ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent,
  Legend, Tooltip,
  Area, AreaChart, Bar, BarChart, ComposedChart, Line, LineChart,
  Pie, PieChart, Radar, RadarChart, RadialBar, RadialBarChart,
  CartesianGrid, Label, LabelList, PolarAngleAxis, PolarGrid, Sector,
  XAxis, YAxis,
} = C;

export default C;

/**
 * Pure derivations over the {@link MetricsView} — filtering and number formatting
 * for the Metrics screen, unit-testable without React.
 */
import type { MetricSeriesView } from "../fleet/metric-series-store";

/** Apply the component filter (undefined = all), preserving the store's sort. */
export function filterSeries(
  series: MetricSeriesView[],
  componentId: string | undefined,
): MetricSeriesView[] {
  if (componentId === undefined) return series;
  return series.filter((s) => s.componentId === componentId);
}

/** The distinct component ids across the metric surface, sorted — the filter's options. */
export function seriesComponentIds(series: MetricSeriesView[]): string[] {
  const ids = new Set<string>();
  for (const s of series) ids.add(s.componentId);
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/**
 * Compact value formatting for the Latest column and sparkline hover: integers
 * verbatim with thousands grouping, fractions to at most 2 decimals (trailing
 * zeros trimmed by Intl), so `42`, `1,234`, `3.14`, `0.5` — never `42.00`.
 */
const NUMBER_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function formatMetricValue(value: number): string {
  return NUMBER_FORMAT.format(value);
}

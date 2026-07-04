/**
 * Sparkline — a hand-rolled inline-SVG trend mark (no chart dependency), following
 * the dataviz mark specs: a thin 1.5 px line over a subtle area fill anchored to
 * the plot floor, with the ENDPOINT emphasized (a marker dot on the latest sample —
 * the value the adjacent cell states). No grid, no axes: a sparkline is context for
 * the printed latest value, not a read-off-able chart. The single-series hue is the
 * Carbon g100 `support-info` blue (#4589ff), validated against the g100 surface
 * (lightness band, chroma, 3:1 contrast) with the palette validator; the adjacent
 * value text wears text tokens, never the series color.
 *
 * X is TIME-scaled (honest spacing for irregular cadences), Y spans the series'
 * own [min, max] with padding; degenerate series (one point, or all-equal values /
 * zero time span) render as a centered flat line + endpoint dot. A native SVG
 * `<title>` carries the min/max/latest summary as the lightweight hover layer, and
 * `role="img"` + `aria-label` state the trend for assistive tech.
 *
 * A generic mark (shared across screens — e.g. the Events "per minute" tile);
 * relocated to `common/` when the off-contract Metrics page was removed in R0.
 */
import type { MetricPoint } from "@edgecommons/edge-console-protocol";

export interface SparklineProps {
  /** Ascending time, newest last. */
  points: MetricPoint[];
  width?: number;
  height?: number;
  /** Accessible naming for the trend (e.g. "cpu trend, latest 42"). */
  ariaLabel: string;
  /** Compact value formatter for the hover summary (defaults to `String`). */
  formatValue?: (value: number) => string;
}

/** Geometry paddings: room for the 2.5 px endpoint dot at every edge. */
const PAD = 3;

export function Sparkline({
  points,
  width = 120,
  height = 32,
  ariaLabel,
  formatValue = String,
}: SparklineProps): React.JSX.Element | null {
  if (points.length === 0) return null;

  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const t0 = points[0]!.at;
  const t1 = points[points.length - 1]!.at;

  const x = (at: number): number =>
    t1 === t0 ? width / 2 : PAD + ((at - t0) / (t1 - t0)) * (width - 2 * PAD);
  const y = (value: number): number =>
    max === min
      ? height / 2
      : PAD + ((max - value) / (max - min)) * (height - 2 * PAD);

  const coords = points.map((p) => [x(p.at), y(p.value)] as const);
  const line = coords.map(([px, py]) => `${round(px)},${round(py)}`).join(" ");
  const floor = height - PAD;
  const area =
    `${round(coords[0]![0])},${floor} ` +
    line +
    ` ${round(coords[coords.length - 1]![0])},${floor}`;
  const [endX, endY] = coords[coords.length - 1]!;

  const summary =
    points.length === 1
      ? `latest ${formatValue(values[values.length - 1]!)}`
      : `min ${formatValue(min)} · max ${formatValue(max)} · latest ${formatValue(values[values.length - 1]!)}`;

  return (
    <svg
      className="ec-spark"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${ariaLabel} — ${summary}`}
      data-testid="sparkline"
    >
      <title>{summary}</title>
      {points.length > 1 && (
        <>
          <polygon points={area} fill="currentColor" fillOpacity={0.12} stroke="none" />
          <polyline
            points={line}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </>
      )}
      <circle cx={round(endX)} cy={round(endY)} r={2.5} fill="currentColor" stroke="none" />
    </svg>
  );
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

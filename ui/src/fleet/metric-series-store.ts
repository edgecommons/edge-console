/**
 * MetricSeriesStore (browser) — the pure fold core for the C6 metric frames, the
 * client-side mirror of the server's MetricStore: latest value + a bounded recent
 * series per `(component, metric, measure)`. No IO, no clock reads; the
 * {@link FleetClient} feeds it frames; identity-stable derived view for React.
 *
 * Fold rules:
 *  - `metrics` (the `subscribe-metrics` snapshot) REPLACES all series — the fresh
 *    snapshot after (re)subscribe self-heals any divergence.
 *  - `metric` update batches append per series, bounded to the SHARED cap
 *    ({@link DEFAULT_METRIC_SERIES_POINTS} — the same drop-oldest retention the
 *    server keeps), starting unseen series from scratch; a sample older than the
 *    series tail is stale (a reordered frame) and is dropped, and an equal-time
 *    sample replaces the tail (latest-wins).
 */
import type {
  ComponentKey,
  MetricPoint,
  MetricSeriesSnapshot,
  MetricSeriesUpdate,
} from "@edgecommons/edge-console-protocol";
import { DEFAULT_METRIC_SERIES_POINTS, componentKeyId } from "@edgecommons/edge-console-protocol";

/** One series as the UI renders it. */
export interface MetricSeriesView {
  key: ComponentKey;
  /** Canonical `device/component/instance` id (grouping/filtering). */
  componentId: string;
  /** Stable per-series id (React key). */
  seriesId: string;
  metric: string;
  measure: string;
  latest: number;
  /** Console receipt time of the latest sample (server-clock ms). */
  receivedAt: number;
  sourceTimestamp?: string;
  /** Ascending time, newest last (includes the latest sample). */
  points: MetricPoint[];
}

/** The derived view: every series, sorted `(component, metric, measure)`. */
export interface MetricsView {
  series: MetricSeriesView[];
}

const EMPTY_VIEW: MetricsView = { series: [] };

/** Mutable internal series record. */
interface SeriesState {
  key: ComponentKey;
  componentId: string;
  seriesId: string;
  metric: string;
  measure: string;
  receivedAt: number;
  sourceTimestamp?: string;
  points: MetricPoint[];
}

/** Readable client-side series id (React keys, testids) — not a wire shape. */
function seriesIdOf(componentId: string, metric: string, measure: string): string {
  return `${componentId}::${metric}::${measure}`;
}

/** The pure client metric store: snapshot/update folds + derived view. */
export class MetricSeriesStore {
  private readonly series = new Map<string, SeriesState>();

  private version = 0;
  private cachedView: MetricsView = EMPTY_VIEW;
  private cachedVersion = 0;

  constructor(private readonly maxPoints: number = DEFAULT_METRIC_SERIES_POINTS) {}

  /** Fold a `metrics` snapshot frame: replaces every series wholesale. */
  applySnapshot(snapshot: MetricSeriesSnapshot[]): void {
    this.series.clear();
    for (const s of snapshot) {
      if (s.points.length === 0) continue; // a series exists only with samples — defensive
      const componentId = componentKeyId(s.key);
      const seriesId = seriesIdOf(componentId, s.metric, s.measure);
      this.series.set(seriesId, {
        key: { ...s.key },
        componentId,
        seriesId,
        metric: s.metric,
        measure: s.measure,
        receivedAt: s.receivedAt,
        ...(s.sourceTimestamp !== undefined ? { sourceTimestamp: s.sourceTimestamp } : {}),
        points: s.points.slice(-this.maxPoints).map((p) => ({ ...p })),
      });
    }
    this.bump();
  }

  /** Fold a `metric` update batch: bounded append (latest-wins on equal time). */
  applyUpdates(updates: MetricSeriesUpdate[]): void {
    let changed = false;
    for (const u of updates) {
      const componentId = componentKeyId(u.key);
      const seriesId = seriesIdOf(componentId, u.metric, u.measure);
      let state = this.series.get(seriesId);
      if (state === undefined) {
        state = {
          key: { ...u.key },
          componentId,
          seriesId,
          metric: u.metric,
          measure: u.measure,
          receivedAt: u.point.at,
          points: [],
        };
        this.series.set(seriesId, state);
      }
      const tail = state.points[state.points.length - 1];
      if (tail !== undefined && u.point.at < tail.at) continue; // stale/reordered — drop
      if (tail !== undefined && u.point.at === tail.at) {
        tail.value = u.point.value; // latest-wins
      } else {
        state.points.push({ ...u.point });
        if (state.points.length > this.maxPoints) state.points.shift();
      }
      state.receivedAt = u.point.at;
      if (u.sourceTimestamp !== undefined) state.sourceTimestamp = u.sourceTimestamp;
      else delete state.sourceTimestamp;
      changed = true;
    }
    if (changed) this.bump();
  }

  /** The immutable derived view (cached; identity changes only when the store does). */
  view(): MetricsView {
    if (this.cachedVersion === this.version) return this.cachedView;
    const series = [...this.series.values()]
      .map((s) => ({
        key: { ...s.key },
        componentId: s.componentId,
        seriesId: s.seriesId,
        metric: s.metric,
        measure: s.measure,
        latest: s.points[s.points.length - 1]!.value,
        receivedAt: s.receivedAt,
        ...(s.sourceTimestamp !== undefined ? { sourceTimestamp: s.sourceTimestamp } : {}),
        points: s.points.map((p) => ({ ...p })),
      }))
      .sort(
        (a, b) =>
          a.componentId.localeCompare(b.componentId) ||
          a.metric.localeCompare(b.metric) ||
          a.measure.localeCompare(b.measure),
      );
    this.cachedView = { series };
    this.cachedVersion = this.version;
    return this.cachedView;
  }

  private bump(): void {
    this.version++;
  }
}

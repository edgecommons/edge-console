/**
 * MetricStore (browser) — pure fold core for the C6 `metrics`/`metric` frames. It mirrors the
 * server MetricStore surface: one series per `(component, instance, metric, measure)` with latest
 * value plus a bounded recent numeric series.
 */
import type {
  ComponentKey,
  MetricPoint,
  MetricSeriesSnapshot,
  MetricSeriesUpdate,
} from "@edgecommons/edge-console-protocol";
import { DEFAULT_METRIC_SERIES_POINTS, componentKeyId } from "@edgecommons/edge-console-protocol";

export interface MetricStoreOptions {
  /** Recent points kept per series (drop-oldest). Default {@link DEFAULT_METRIC_SERIES_POINTS}. */
  maxSeriesPoints: number;
  /** Max distinct `(component, instance, metric, measure)` series; overflow series are dropped. */
  maxSeries: number;
}

export const DEFAULT_METRIC_STORE_OPTIONS: MetricStoreOptions = {
  maxSeriesPoints: DEFAULT_METRIC_SERIES_POINTS,
  maxSeries: 5000,
};

export interface MetricsView {
  series: MetricSeriesSnapshot[];
}

const EMPTY_VIEW: MetricsView = { series: [] };

function seriesId(componentId: string, metric: string, measure: string): string {
  return `${componentId} ${metric} ${measure}`;
}

function bySeriesOrder(a: MetricSeriesSnapshot, b: MetricSeriesSnapshot): number {
  return (
    componentKeyId(a.key).localeCompare(componentKeyId(b.key)) ||
    a.instance.localeCompare(b.instance) ||
    a.metric.localeCompare(b.metric) ||
    a.measure.localeCompare(b.measure)
  );
}

export class MetricStore {
  private readonly opts: MetricStoreOptions;
  private series = new Map<string, MetricSeriesSnapshot>();
  private dropped = 0;
  private version = 0;
  private cachedView: MetricsView = EMPTY_VIEW;
  private cachedVersion = -1;

  constructor(opts?: Partial<MetricStoreOptions>) {
    this.opts = { ...DEFAULT_METRIC_STORE_OPTIONS, ...opts };
  }

  /** Fold a `metrics` frame: replaces every known series wholesale. */
  applySnapshot(series: MetricSeriesSnapshot[]): void {
    this.series = new Map(
      series.map((s) => [seriesId(`${componentKeyId(s.key)}/${s.instance}`, s.metric, s.measure), cloneSeries(s)]),
    );
    this.dropped = 0;
    this.version++;
  }

  /** Fold a `metric` push: append bounded points, creating unseen series within the cap. */
  applyUpdates(updates: MetricSeriesUpdate[]): void {
    if (updates.length === 0) return;
    for (const update of updates) {
      const componentId = `${componentKeyId(update.key)}/${update.instance}`;
      const id = seriesId(componentId, update.metric, update.measure);
      let state = this.series.get(id);
      if (state === undefined) {
        if (this.series.size >= this.opts.maxSeries) {
          this.dropped++;
          continue;
        }
        state = {
          key: { ...update.key },
          instance: update.instance,
          metric: update.metric,
          measure: update.measure,
          latest: update.point.value,
          receivedAt: update.point.at,
          points: [],
        };
        this.series.set(id, state);
      }
      const point: MetricPoint = { ...update.point };
      state.latest = point.value;
      state.receivedAt = point.at;
      if (update.sourceTimestamp !== undefined) state.sourceTimestamp = update.sourceTimestamp;
      else delete state.sourceTimestamp;
      state.points.push(point);
      if (state.points.length > this.opts.maxSeriesPoints) state.points.shift();
    }
    this.version++;
  }

  get(key: ComponentKey, metric: string, measure: string, instance = "main"): MetricSeriesSnapshot | undefined {
    return this.series.get(seriesId(`${componentKeyId(key)}/${instance}`, metric, measure));
  }

  seriesCount(): number {
    return this.series.size;
  }

  droppedSeries(): number {
    return this.dropped;
  }

  view(): MetricsView {
    if (this.cachedVersion === this.version) return this.cachedView;
    this.cachedView = { series: [...this.series.values()].sort(bySeriesOrder) };
    this.cachedVersion = this.version;
    return this.cachedView;
  }
}

function cloneSeries(s: MetricSeriesSnapshot): MetricSeriesSnapshot {
  return {
    key: { ...s.key },
    instance: s.instance,
    metric: s.metric,
    measure: s.measure,
    latest: s.latest,
    receivedAt: s.receivedAt,
    ...(s.sourceTimestamp !== undefined ? { sourceTimestamp: s.sourceTimestamp } : {}),
    points: s.points.map((p) => ({ ...p })),
  };
}

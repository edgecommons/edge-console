/**
 * MetricStore — the console's metric surface (slice C6): the latest value plus a
 * small bounded recent series per `(component, metric name, measure)`.
 *
 * The `metric` class carries numeric measures on `metric/{name}`. The body is
 * typically the library's EMF object (measure values flattened to the top level
 * next to string dimensions and the `_aws` metadata block — see the lib's
 * `metrics/emf.ts`), but the store is payload-lenient: every top-level finite
 * number folds as a measure (non-numerics and `_`-prefixed keys — the `_aws`
 * block — are skipped), and a bare numeric body folds as the measure `"value"`.
 * When an EMF body carries an `instance` dimension, that dimension owns the
 * series grouping; the UNS metric topic itself is library-owned under `main`.
 *
 * Same side-store reasoning as C5's ConfigStore / C6's EventStore: the liveness
 * stream carries no bodies; the WS gateway serves this store's `snapshot()` to a
 * `subscribe-metrics` client and pushes the per-ingest update batches.
 *
 * Pure core, no IO, injected clock. Series are bounded two ways: points per
 * series (drop-oldest, the sparkline window) and distinct series overall (new
 * series past the cap are dropped + counted — the FleetModel's channel-cap
 * pattern, so a hostile/buggy publisher can't grow memory unboundedly).
 */
import type {
  ComponentKey,
  MetricPoint,
  MetricSeriesSnapshot,
  MetricSeriesUpdate,
} from "@edgecommons/edge-console-protocol";
import { DEFAULT_METRIC_SERIES_POINTS, componentKeyId } from "@edgecommons/edge-console-protocol";
import type { IngressEvent } from "../ingress/normalizer";
import type { Clock } from "./fleet-model";

/** The metric-surface bounds. */
export interface MetricStoreOptions {
  /** Recent points kept per series (drop-oldest). Default {@link DEFAULT_METRIC_SERIES_POINTS}. */
  maxSeriesPoints: number;
  /** Max distinct `(component, metric, measure)` series; overflow dropped + counted. Default 2000. */
  maxSeries: number;
}

export const DEFAULT_METRIC_STORE_OPTIONS: MetricStoreOptions = {
  maxSeriesPoints: DEFAULT_METRIC_SERIES_POINTS,
  maxSeries: 2000,
};

/** Notified with each ingest's update batch (one bus arrival = one batch). */
export type MetricUpdateListener = (updates: MetricSeriesUpdate[]) => void;

/** Mutable internal series record. */
interface SeriesState {
  key: ComponentKey;
  instance: string;
  metric: string;
  measure: string;
  receivedAt: number;
  sourceTimestamp?: string;
  points: MetricPoint[];
}

/** Series-map key. `\u0000` never appears in topic tokens or JSON field names in practice. */
function seriesId(componentId: string, metric: string, measure: string): string {
  return `${componentId}\u0000${metric}\u0000${measure}`;
}

/**
 * Extract the measure values from a metric body: top-level finite numbers of an
 * object body (skipping `_`-prefixed keys — the EMF `_aws` block), or a bare
 * finite number as `"value"`. Anything else contributes nothing.
 */
export function extractMeasures(body: unknown): Array<[string, number]> {
  if (typeof body === "number" && Number.isFinite(body)) return [["value", body]];
  if (body === null || typeof body !== "object" || Array.isArray(body)) return [];
  const measures: Array<[string, number]> = [];
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (k.startsWith("_")) continue;
    if (typeof v === "number" && Number.isFinite(v)) measures.push([k, v]);
  }
  return measures;
}

function stringDimension(body: unknown, key: string): string | undefined {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The metric surface: `metric` ingest tee + bounded series + snapshot/update fanout. */
export class MetricStore {
  private readonly opts: MetricStoreOptions;
  private readonly series = new Map<string, SeriesState>();
  private readonly listeners: MetricUpdateListener[] = [];
  private dropped = 0;

  constructor(
    private readonly clock: Clock,
    opts?: Partial<MetricStoreOptions>,
  ) {
    this.opts = { ...DEFAULT_METRIC_STORE_OPTIONS, ...opts };
  }

  /**
   * Tee one ingress event into the store. Only attributable, NAMED `metric`
   * envelopes with at least one numeric measure fold (the grammar is
   * `metric/{name}` — an unnamed metric is unattributable to a series).
   */
  ingest(event: IngressEvent): void {
    if (event.kind !== "envelope" || event.cls !== "metric") return;
    if (event.channel === undefined || event.channel === "") return;
    const last = event.identity.hier[event.identity.hier.length - 1];
    const device = last?.value;
    if (device === undefined || device === "") return; // unattributable — defensive (G11)
    const measures = extractMeasures(event.body);
    if (measures.length === 0) return;

    const key: ComponentKey = {
      device,
      component: event.identity.component,
    };
    const instance = stringDimension(event.body, "instance") ?? event.identity.instance;
    // Series key includes the source instance so filler1's and kep2's same-named metric don't collide.
    const componentId = `${componentKeyId(key)}/${instance}`;
    const at = this.clock();
    const updates: MetricSeriesUpdate[] = [];

    for (const [measure, value] of measures) {
      const id = seriesId(componentId, event.channel, measure);
      let state = this.series.get(id);
      if (state === undefined) {
        if (this.series.size >= this.opts.maxSeries) {
          this.dropped++;
          continue; // overflow guard — existing series keep updating
        }
        state = { key, instance, metric: event.channel, measure, receivedAt: at, points: [] };
        this.series.set(id, state);
      }
      state.receivedAt = at;
      if (event.sourceTimestamp !== undefined) state.sourceTimestamp = event.sourceTimestamp;
      else delete state.sourceTimestamp;
      state.points.push({ at, value });
      if (state.points.length > this.opts.maxSeriesPoints) state.points.shift(); // drop-oldest
      updates.push({
        key,
        instance,
        metric: event.channel,
        measure,
        point: { at, value },
        ...(event.sourceTimestamp !== undefined ? { sourceTimestamp: event.sourceTimestamp } : {}),
      });
    }

    if (updates.length === 0) return;
    for (const listener of [...this.listeners]) listener(updates);
  }

  /**
   * Every known series (latest + bounded recent points), sorted by
   * `(component id, metric, measure)` — the `subscribe-metrics` reply.
   */
  snapshot(): MetricSeriesSnapshot[] {
    return [...this.series.values()]
      .map((s) => ({
        key: { ...s.key },
        instance: s.instance,
        metric: s.metric,
        measure: s.measure,
        latest: s.points[s.points.length - 1]!.value,
        receivedAt: s.receivedAt,
        ...(s.sourceTimestamp !== undefined ? { sourceTimestamp: s.sourceTimestamp } : {}),
        points: s.points.map((p) => ({ ...p })),
      }))
      .sort(
        (a, b) =>
          componentKeyId(a.key).localeCompare(componentKeyId(b.key)) ||
          a.instance.localeCompare(b.instance) ||
          a.metric.localeCompare(b.metric) ||
          a.measure.localeCompare(b.measure),
      );
  }

  /** Distinct series currently tracked (diagnostics/tests). */
  seriesCount(): number {
    return this.series.size;
  }

  /** New series dropped by the series cap (diagnostics/tests). */
  droppedSeries(): number {
    return this.dropped;
  }

  /** Register an update-batch listener; returns the unsubscribe function. */
  onUpdate(listener: MetricUpdateListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
}

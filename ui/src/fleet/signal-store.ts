/**
 * SignalStore (browser) — the pure fold core for the R0 `signals`/`signal` frames, the
 * client-side mirror of the server {@link SignalStore}: the DATA plane. One record per
 * `(component, signal)` series carrying the latest value + quality plus a small bounded
 * recent series, the exact shape the server snapshot ships. It powers the Signals screen
 * (R5) — the data-plane browser.
 *
 * No IO, no clock reads; the {@link FleetClient} feeds it the `signals` snapshot (a full
 * replace of every known series) and each `signal` push (a bounded append per series,
 * latest-wins on value/quality/receipt time). Retention mirrors the server exactly
 * (`DEFAULT_SIGNAL_SERIES_POINTS`, drop-oldest; distinct series capped + counted) so the
 * client fold never diverges from what the gateway holds. Identity-stable derived view for
 * React — the series list is re-materialized (sorted by component id then signal, same as
 * the server) only when the store actually changes.
 */
import type {
  ComponentKey,
  SignalPoint,
  SignalPointsResult,
  SignalSeriesSnapshot,
  SignalSeriesUpdate,
} from "@edgecommons/edge-console-protocol";
import { DEFAULT_SIGNAL_SERIES_POINTS, componentKeyId } from "@edgecommons/edge-console-protocol";

/** The client-fold retention bounds (mirror the server's {@link SignalStoreOptions}). */
export interface SignalStoreOptions {
  /** Recent points kept per series (drop-oldest). Default {@link DEFAULT_SIGNAL_SERIES_POINTS}. */
  maxSeriesPoints: number;
  /** Max distinct `(component, signal)` series; a new overflow series is dropped + counted. Default 5000. */
  maxSeries: number;
}

export const DEFAULT_SIGNAL_STORE_OPTIONS: SignalStoreOptions = {
  maxSeriesPoints: DEFAULT_SIGNAL_SERIES_POINTS,
  maxSeries: 5000,
};

/** The derived view: every known series, sorted by `(component id, signal)`. */
export interface SignalsView {
  series: SignalSeriesSnapshot[];
}

const EMPTY_VIEW: SignalsView = { series: [] };

/** Series-map key. A space never appears in a topic token in practice (matches the server). */
function seriesId(componentId: string, signal: string): string {
  return `${componentId} ${signal}`;
}

/** Order two series by component id then signal (the server's snapshot order). */
function bySeriesOrder(a: SignalSeriesSnapshot, b: SignalSeriesSnapshot): number {
  return (
    componentKeyId(a.key).localeCompare(componentKeyId(b.key)) || a.signal.localeCompare(b.signal)
  );
}

/** The pure client signal store: snapshot replace + per-series bounded-append updates. */
export class SignalStore {
  private readonly opts: SignalStoreOptions;
  private series = new Map<string, SignalSeriesSnapshot>();
  private dropped = 0;
  private version = 0;
  private cachedView: SignalsView = EMPTY_VIEW;
  private cachedVersion = -1;

  constructor(opts?: Partial<SignalStoreOptions>) {
    this.opts = { ...DEFAULT_SIGNAL_STORE_OPTIONS, ...opts };
  }

  /** Fold a `signals` frame: replaces every known series wholesale (a fresh baseline). */
  applySnapshot(series: SignalSeriesSnapshot[]): void {
    this.series = new Map(
      series.map((s) => [seriesId(`${componentKeyId(s.key)}/${s.instance}`, s.signal), cloneSeries(s)]),
    );
    this.dropped = 0;
    this.version++;
  }

  /**
   * Fold a `signal` push: for each update, append its point to the matching series
   * (creating the series if new — respecting the distinct-series cap), latest-wins on
   * value / quality / receipt time, bounded drop-oldest. An empty batch is a no-op.
   */
  applyUpdates(updates: SignalSeriesUpdate[]): void {
    if (updates.length === 0) return;
    for (const update of updates) {
      const componentId = `${componentKeyId(update.key)}/${update.instance}`;
      const id = seriesId(componentId, update.signal);
      let state = this.series.get(id);
      if (state === undefined) {
        if (this.series.size >= this.opts.maxSeries) {
          this.dropped++;
          continue; // overflow guard — existing series keep updating
        }
        state = {
          key: { ...update.key },
          instance: update.instance,
          signal: update.signal,
          latest: update.point.value,
          receivedAt: update.point.at,
          points: [],
        };
        this.series.set(id, state);
      }
      const point: SignalPoint = { ...update.point };
      state.latest = point.value;
      state.receivedAt = point.at;
      if (point.quality !== undefined) state.quality = point.quality;
      else delete state.quality;
      if (update.sourceTimestamp !== undefined) state.sourceTimestamp = update.sourceTimestamp;
      else delete state.sourceTimestamp;
      // WP-G verbatim pair: the series-level sourceTs/serverTs describe the LATEST sample — set
      // or cleared on every fold from the point's own pair (per-sample facts, like `quality`;
      // NOT latest-wins-retained like the identity metadata below).
      if (point.sourceTs !== undefined) state.sourceTs = point.sourceTs;
      else delete state.sourceTs;
      if (point.serverTs !== undefined) state.serverTs = point.serverTs;
      else delete state.serverTs;
      // R5 latest-wins metadata: publish timestamp always latest-wins; name/signalId ride only a
      // (re)labelling batch, so keep the prior label when this batch omits them.
      if (update.publishedTs !== undefined) state.publishedTs = update.publishedTs;
      if (update.name !== undefined) state.name = update.name;
      if (update.signalId !== undefined) state.signalId = update.signalId;
      // A summary-mode series has no `points` array yet — accumulate live samples into one.
      (state.points ??= []).push(point);
      if (state.points.length > this.opts.maxSeriesPoints) state.points.shift(); // drop-oldest
    }
    this.version++;
  }

  /**
   * Fold a `signal-points` reply (R5 backfill): replace the recent points of each named series
   * with the fetched, bounded series. A result for an unknown series (never seen in the summary
   * snapshot) is ignored — the store only backfills series it already tracks.
   */
  applyPoints(results: SignalPointsResult[]): void {
    if (results.length === 0) return;
    let changed = false;
    for (const result of results) {
      const id = seriesId(`${componentKeyId(result.key)}/${result.instance}`, result.signal);
      const state = this.series.get(id);
      if (state === undefined) continue;
      const points = result.points.map((p) => ({ ...p }));
      if (points.length > this.opts.maxSeriesPoints) {
        points.splice(0, points.length - this.opts.maxSeriesPoints); // keep the newest cap
      }
      state.points = points;
      changed = true;
    }
    if (changed) this.version++;
  }

  /** The latest record for one series, or `undefined` (nothing reported yet). */
  get(key: ComponentKey, signal: string, instance = "main"): SignalSeriesSnapshot | undefined {
    return this.series.get(seriesId(`${componentKeyId(key)}/${instance}`, signal));
  }

  /** Distinct series currently tracked (diagnostics/tests). */
  seriesCount(): number {
    return this.series.size;
  }

  /** New series dropped by the series cap (diagnostics/tests). */
  droppedSeries(): number {
    return this.dropped;
  }

  /** The immutable derived view (cached; identity changes only when the store does). */
  view(): SignalsView {
    if (this.cachedVersion === this.version) return this.cachedView;
    this.cachedView = { series: [...this.series.values()].sort(bySeriesOrder) };
    this.cachedVersion = this.version;
    return this.cachedView;
  }
}

/** A deep-enough clone of a snapshot series (key + points copied so folds never alias the frame). */
function cloneSeries(s: SignalSeriesSnapshot): SignalSeriesSnapshot {
  return {
    key: { ...s.key },
    instance: s.instance,
    signal: s.signal,
    latest: s.latest,
    ...(s.quality !== undefined ? { quality: s.quality } : {}),
    receivedAt: s.receivedAt,
    ...(s.sourceTimestamp !== undefined ? { sourceTimestamp: s.sourceTimestamp } : {}),
    // WP-G verbatim latest-sample timestamps (set-or-cleared per ingest, server-side).
    ...(s.sourceTs !== undefined ? { sourceTs: s.sourceTs } : {}),
    ...(s.serverTs !== undefined ? { serverTs: s.serverTs } : {}),
    // R5 series metadata (all optional, latest-wins) — carried verbatim into the client fold.
    ...(s.name !== undefined ? { name: s.name } : {}),
    ...(s.signalId !== undefined ? { signalId: s.signalId } : {}),
    ...(s.address !== undefined ? { address: s.address } : {}),
    ...(s.adapter !== undefined ? { adapter: s.adapter } : {}),
    ...(s.endpoint !== undefined ? { endpoint: s.endpoint } : {}),
    ...(s.qualityRaw !== undefined ? { qualityRaw: s.qualityRaw } : {}),
    ...(s.publishedTs !== undefined ? { publishedTs: s.publishedTs } : {}),
    // Summary-mode series omit `points` entirely — start an empty ring the live/backfill folds grow.
    points: (s.points ?? []).map((p) => ({ ...p })),
  };
}

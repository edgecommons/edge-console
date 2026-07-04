/**
 * ThroughputMeter — the console's own bus-ingest rate counter (slice R1).
 *
 * The Overview "Edge bus msgs/s" tile is the console's OWN throughput (the console is
 * itself a ggcommons component): a small rolling meter the ingress tee `mark()`s once
 * per normalized envelope. `ratePerSec()` is a simple average over a bounded window of
 * per-second buckets — cheap and memory-bounded (at most `windowSecs` buckets, regardless
 * of message rate), with an injected clock so it is unit-testable without sleeps.
 *
 * The C2 WS gateway reads `ratePerSec()` when it emits a `heartbeat` and stamps it as
 * `busMsgsPerSec` (optional, additive — a gateway with no meter simply omits it), and
 * {@link ThroughputMeter.recentRates} for the tile's SPARKLINE ring (R1). This is the honest
 * source: a real value in the live console AND in the demo gateway's ingest tee, never a
 * fabricated number. It refreshes on the heartbeat cadence.
 */
import type { Clock } from "./fleet-model";

/** A bounded rolling-window messages/second meter with a recent-rate ring for the tile sparkline. */
export class ThroughputMeter {
  private readonly windowSecs: number;
  private readonly historySecs: number;
  /** Per-second buckets: `floor(ms/1000) -> count`. Pruned to `historySecs` on every touch. */
  private readonly buckets = new Map<number, number>();

  constructor(
    private readonly clock: Clock,
    windowSecs = 10,
    /** How many trailing per-second buckets the sparkline ring keeps (also the map's bound). Default 24. */
    historySecs = 24,
  ) {
    this.windowSecs = Math.max(1, Math.floor(windowSecs));
    this.historySecs = Math.max(this.windowSecs, Math.floor(historySecs));
  }

  /** Record `count` ingested messages at the current instant (default 1). */
  mark(count = 1): void {
    if (count <= 0) return;
    const sec = Math.floor(this.clock() / 1000);
    this.buckets.set(sec, (this.buckets.get(sec) ?? 0) + count);
    this.prune(sec);
  }

  /** The average messages/second over the trailing window (0 when idle). */
  ratePerSec(): number {
    const sec = Math.floor(this.clock() / 1000);
    this.prune(sec);
    let total = 0;
    for (const bucketSec of this.buckets.keys()) {
      if (bucketSec > sec - this.windowSecs) total += this.buckets.get(bucketSec)!;
    }
    return total / this.windowSecs;
  }

  /**
   * The last `count` per-second bus rates (msgs that second), oldest→newest, zero-filled for
   * idle seconds — the Overview "Edge bus" tile's sparkline ring. The most recent bucket is the
   * still-accumulating current second (partial), which is the expected sparkline behavior. Bounded
   * to `historySecs` regardless of `count`.
   */
  recentRates(count = this.historySecs): number[] {
    const nowSec = Math.floor(this.clock() / 1000);
    this.prune(nowSec);
    const n = Math.max(1, Math.min(Math.floor(count), this.historySecs));
    const rates: number[] = [];
    for (let sec = nowSec - n + 1; sec <= nowSec; sec++) {
      rates.push(this.buckets.get(sec) ?? 0);
    }
    return rates;
  }

  /** Drop buckets older than the history window (keeps the map ≤ historySecs entries). */
  private prune(nowSec: number): void {
    const oldest = nowSec - this.historySecs + 1;
    for (const sec of this.buckets.keys()) {
      if (sec < oldest) this.buckets.delete(sec);
    }
  }
}

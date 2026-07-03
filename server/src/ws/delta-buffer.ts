/**
 * DeltaBuffer — a bounded, contiguous ring of the most recent {@link FleetDelta}s, the
 * C2 gateway's resume source (reconciliation §4, C2 row: "a bounded recent-delta buffer
 * is fine; on any gap/uncertainty, just re-snapshot — correctness over cleverness").
 *
 * Pure; no IO. The FleetModel's `seq` is a single global counter incremented exactly
 * once per emitted delta (see `fleet-model.ts` `push()`), so the buffered deltas are
 * always contiguous by `seq` - there is never an internal hole to reason about, only
 * "do we still have the requested range, or has it been evicted".
 */
import type { FleetDelta } from "@edgecommons/edge-console-protocol";

export class DeltaBuffer {
  private readonly buf: FleetDelta[] = [];

  /**
   * The seq immediately BEFORE the oldest buffered delta - the resume floor. A resume
   * request at or below this floor cannot be proven gap-free (either evicted by the
   * ring, or from before this buffer existed) and must fall back to a fresh snapshot.
   */
  private floorSeq: number;

  /** @param capacity max deltas retained (oldest evicted first). @param startSeq the model's `seq` at gateway construction — the initial floor (nothing before it was ever buffered). */
  constructor(
    private readonly capacity: number,
    startSeq: number,
  ) {
    this.floorSeq = startSeq;
  }

  /** Append one delta, evicting the oldest if over capacity. */
  push(delta: FleetDelta): void {
    this.buf.push(delta);
    if (this.buf.length > this.capacity) {
      const evicted = this.buf.shift();
      if (evicted !== undefined) this.floorSeq = evicted.seq;
    }
  }

  /**
   * Deltas strictly after `resumeSeq`, in order - or `undefined` if the buffer cannot
   * prove contiguous coverage from `resumeSeq` forward (the caller must re-snapshot).
   */
  since(resumeSeq: number): FleetDelta[] | undefined {
    if (resumeSeq < this.floorSeq) return undefined;
    return this.buf.filter((d) => d.seq > resumeSeq);
  }
}

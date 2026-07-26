/**
 * CommandStore (browser) — the pure fold core for the C4 command frames, the client
 * side of `invoke-command`/`command-result`. Same discipline as the other stores: no IO,
 * no clock reads (the {@link FleetClient} IO shell owns the socket + the backstop timer),
 * an identity-stable derived view for React.
 *
 * One entry per outgoing command, keyed by the CLIENT-chosen `requestId`:
 *  - `notePending`      — an `invoke-command` went out; the entry is `pending` until the
 *    gateway's `command-result` (or a client-side failure) settles it. The entry records
 *    the `instance` the invoke args carried (if any) AT REQUEST TIME — the requestId →
 *    `{key, verb, instance}` correlation that partitions multi-instance panel results.
 *  - `applyResult`      — the gateway's `command-result`: `ok` ⇒ phase `ok` with `result`;
 *    `!ok` ⇒ phase `error` with the {@link CommandError} (the component's own code OR a
 *    console-synthesized one — `FORBIDDEN`/`TIMEOUT`/…). The reply settles into the entry
 *    it was sent for, so it lands under THAT instance's slot even if the operator has
 *    since selected another instance (stale replies never cross-talk).
 *  - `failClient`       — a client-side settle (the connection dropped before a reply, or
 *    the backstop timer fired): phase `error` with a client code.
 *
 * Two derived surfaces the UI needs: `latestByComponentVerb` (the last command per
 * `${componentId}::${verb}::${instanceOrEmpty}` — drives a button's pending spinner /
 * inline last-result / FORBIDDEN-disable, per instance; component-scoped invocations use
 * the empty-instance slot) and `recent` (newest-first, bounded — drives the toast feed).
 */
import type { CommandError, ComponentKey } from "@edgecommons/edge-console-protocol";
import { componentKeyId } from "@edgecommons/edge-console-protocol";

/** Where one command stands. */
export type CommandPhase = "pending" | "ok" | "error";

/** One command's immutable state (handed to React). */
export interface CommandEntry {
  requestId: string;
  /** Monotonic insertion order — newest-first ordering + a stable React key. */
  seq: number;
  key: ComponentKey;
  /** Canonical `device/component/instance` id. */
  componentId: string;
  verb: string;
  /**
   * The component instance the invoke args named at request time (`args.instance`);
   * absent for a component-scoped invocation. Fixes the entry's result slot — a reply
   * records under the instance it was sent for.
   */
  instance?: string;
  phase: CommandPhase;
  /** The verb's result object (present iff `ok`). */
  result?: unknown;
  /** The coded failure (present iff `error`). */
  error?: CommandError;
  /** Gateway-measured round-trip (ms), when the answer carried one. */
  elapsedMs?: number;
}

/** The derived view (identity-stable between folds). */
export interface CommandView {
  /** Every entry by requestId. */
  byId: Record<string, CommandEntry>;
  /** The latest entry per `${componentId}::${verb}::${instanceOrEmpty}` (per-button state). */
  latestByComponentVerb: Record<string, CommandEntry>;
  /** Newest-first, bounded (the toast feed). */
  recent: CommandEntry[];
}

/** How many recent commands the toast feed retains. */
export const DEFAULT_MAX_RECENT_COMMANDS = 50;

const EMPTY_VIEW: CommandView = { byId: {}, latestByComponentVerb: {}, recent: [] };

/**
 * The `${componentId}::${verb}::${instanceOrEmpty}` key for the per-button latest lookup.
 * A component-scoped command (no `instance` in the invoke args) lives in the empty-instance
 * slot; an instance-scoped one in its own instance's slot — widgets look up with their
 * currently-selected instance.
 */
export function commandSlot(componentId: string, verb: string, instance?: string): string {
  return `${componentId}::${verb}::${instance ?? ""}`;
}

/** The pure client command store. */
export class CommandStore {
  private readonly entries = new Map<string, CommandEntry>();
  private seqCounter = 0;
  private readonly maxRecent: number;

  private version = 0;
  private cachedView: CommandView = EMPTY_VIEW;
  private cachedVersion = -1;

  constructor(maxRecent = DEFAULT_MAX_RECENT_COMMANDS) {
    this.maxRecent = Math.max(1, maxRecent);
  }

  /**
   * Record an outgoing `invoke-command` as pending. `instance` is the instance the invoke
   * args carried (absent for component-scoped commands) — it fixes the entry's result slot.
   * Re-using a requestId resets it.
   */
  notePending(requestId: string, key: ComponentKey, verb: string, instance?: string): void {
    this.entries.set(requestId, {
      requestId,
      seq: ++this.seqCounter,
      key: { ...key },
      componentId: componentKeyId(key),
      verb,
      ...(instance !== undefined ? { instance } : {}),
      phase: "pending",
    });
    this.trim();
    this.bump();
  }

  /**
   * Fold a `command-result` frame into its pending entry (creating one if unknown). The
   * entry keeps the `instance` recorded at request time — the result frame itself carries
   * none, and the correlation map is what partitions per-instance slots.
   */
  applyResult(result: {
    requestId: string;
    key: ComponentKey;
    verb: string;
    ok: boolean;
    result?: unknown;
    error?: CommandError;
    elapsedMs: number;
  }): void {
    const entry = this.ensure(result.requestId, result.key, result.verb);
    entry.phase = result.ok ? "ok" : "error";
    if (result.ok) {
      entry.result = result.result;
      delete entry.error;
    } else {
      entry.error = result.error ?? { code: "ERROR", message: "" };
      delete entry.result;
    }
    entry.elapsedMs = result.elapsedMs;
    this.bump();
  }

  /** Settle a pending command from the client side (disconnect / backstop timeout). */
  failClient(requestId: string, error: CommandError): void {
    const entry = this.entries.get(requestId);
    if (entry === undefined || entry.phase !== "pending") return;
    entry.phase = "error";
    entry.error = error;
    this.bump();
  }

  /** Fail EVERY still-pending command (e.g. the connection dropped). */
  failAllPending(error: CommandError): void {
    let changed = false;
    for (const entry of this.entries.values()) {
      if (entry.phase === "pending") {
        entry.phase = "error";
        entry.error = error;
        changed = true;
      }
    }
    if (changed) this.bump();
  }

  /** The requestIds still in flight (the IO shell clears their backstop timers on settle). */
  pendingIds(): string[] {
    const ids: string[] = [];
    for (const [id, entry] of this.entries) if (entry.phase === "pending") ids.push(id);
    return ids;
  }

  /** The immutable derived view (cached; identity changes only when the store does). */
  view(): CommandView {
    if (this.cachedVersion === this.version) return this.cachedView;
    const byId: Record<string, CommandEntry> = {};
    const latestByComponentVerb: Record<string, CommandEntry> = {};
    const all: CommandEntry[] = [];
    for (const entry of this.entries.values()) {
      const snap: CommandEntry = { ...entry, key: { ...entry.key } };
      byId[entry.requestId] = snap;
      all.push(snap);
      const slot = commandSlot(entry.componentId, entry.verb, entry.instance);
      const prev = latestByComponentVerb[slot];
      if (prev === undefined || entry.seq > prev.seq) latestByComponentVerb[slot] = snap;
    }
    const recent = all.sort((a, b) => b.seq - a.seq);
    this.cachedView = { byId, latestByComponentVerb, recent };
    this.cachedVersion = this.version;
    return this.cachedView;
  }

  // ------------------------------------------------------------------ internals

  private ensure(requestId: string, key: ComponentKey, verb: string): CommandEntry {
    let entry = this.entries.get(requestId);
    if (entry === undefined) {
      // Defensive: a result whose pending record is gone — its request-time instance is
      // unknowable, so it lands in the component-scoped (empty-instance) slot.
      entry = {
        requestId,
        seq: ++this.seqCounter,
        key: { ...key },
        componentId: componentKeyId(key),
        verb,
        phase: "pending",
      };
      this.entries.set(requestId, entry);
    }
    return entry;
  }

  /** Drop the oldest settled entries beyond the cap (never a pending one). */
  private trim(): void {
    if (this.entries.size <= this.maxRecent) return;
    const settled = [...this.entries.values()]
      .filter((e) => e.phase !== "pending")
      .sort((a, b) => a.seq - b.seq);
    let over = this.entries.size - this.maxRecent;
    for (const entry of settled) {
      if (over <= 0) break;
      this.entries.delete(entry.requestId);
      over--;
    }
  }

  private bump(): void {
    this.version++;
  }
}

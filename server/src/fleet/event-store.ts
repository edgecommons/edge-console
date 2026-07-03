/**
 * EventStore — the console's rolling `evt` history (slice C6): a bounded
 * newest-first ring of recent component events, fleet-wide AND per component.
 *
 * Why a side store and not the FleetModel: same reasoning as the C5 ConfigStore —
 * the liveness snapshot/delta stream carries no bodies, and events are
 * NOTIFICATIONS (a rolling recent-history log, not a last-known value): the
 * FleetModel's LKV cache would keep only the latest `evt` per channel. BusIngress
 * tees every ingress event here; `evt` envelopes append (drop-oldest past the
 * caps) and fan out to the WS gateway's per-connection event subscriptions.
 *
 * Pure core, no IO, injected clock — the FleetModel/ConfigStore discipline. The
 * `evt/{severity}/{type}` channel convention is split leniently via the shared
 * protocol helper (the class is open: any channel shape is stored, never dropped).
 */
import type { ComponentKey, ConsoleEvent } from "@edgecommons/edge-console-protocol";
import { componentKeyId, splitEventChannel } from "@edgecommons/edge-console-protocol";
import type { IngressEvent } from "../ingress/normalizer";
import type { Clock } from "./fleet-model";

/** The rolling-buffer bounds (both drop-oldest). */
export interface EventStoreOptions {
  /** Fleet-wide ring capacity. Default 1000 (mirrors the bridge's evt replay bound). */
  maxEvents: number;
  /** Per-component ring capacity — a noisy component can't evict the fleet's history view of the others. Default 100. */
  maxPerComponent: number;
}

export const DEFAULT_EVENT_STORE_OPTIONS: EventStoreOptions = {
  maxEvents: 1000,
  maxPerComponent: 100,
};

/** Notified with each stored event (arrival order — the gateway's live-push feed). */
export type EventListener = (event: ConsoleEvent) => void;

/** The rolling recent-events store: `evt` ingest tee + bounded rings + fanout hook. */
export class EventStore {
  private readonly opts: EventStoreOptions;
  /** Oldest-first append ring (reads reverse it — newest-first is the read shape). */
  private readonly ring: ConsoleEvent[] = [];
  /** Oldest-first per-component rings, independently bounded. */
  private readonly byComponent = new Map<string, ConsoleEvent[]>();
  private readonly listeners: EventListener[] = [];
  private nextId = 1;

  constructor(
    private readonly clock: Clock,
    opts?: Partial<EventStoreOptions>,
  ) {
    this.opts = { ...DEFAULT_EVENT_STORE_OPTIONS, ...opts };
  }

  /**
   * Tee one ingress event into the store. Only attributable `evt` envelopes are
   * kept; everything else (other classes, raw, unattributable) is a no-op.
   */
  ingest(event: IngressEvent): void {
    if (event.kind !== "envelope" || event.cls !== "evt") return;
    const last = event.identity.hier[event.identity.hier.length - 1];
    const device = last?.value;
    if (device === undefined || device === "") return; // unattributable — defensive (G11)
    const key: ComponentKey = {
      device,
      component: event.identity.component,
      instance: event.identity.instance,
    };
    const { severity, type } = splitEventChannel(event.channel);
    const entry: ConsoleEvent = {
      id: this.nextId++,
      key,
      ...(severity !== undefined ? { severity } : {}),
      type,
      ...(event.channel !== undefined ? { channel: event.channel } : {}),
      body: event.body,
      ...(event.tags !== undefined ? { tags: event.tags } : {}),
      receivedAt: this.clock(),
      ...(event.sourceTimestamp !== undefined ? { sourceTimestamp: event.sourceTimestamp } : {}),
    };

    this.ring.push(entry);
    if (this.ring.length > this.opts.maxEvents) this.ring.shift(); // drop-oldest

    const id = componentKeyId(key);
    let compRing = this.byComponent.get(id);
    if (compRing === undefined) {
      compRing = [];
      this.byComponent.set(id, compRing);
    }
    compRing.push(entry);
    if (compRing.length > this.opts.maxPerComponent) compRing.shift();

    for (const listener of [...this.listeners]) listener(entry);
  }

  /** The fleet-wide recent history, NEWEST-FIRST (optionally capped at `limit`). */
  recent(limit?: number): ConsoleEvent[] {
    const newestFirst = [...this.ring].reverse();
    return limit !== undefined && limit < newestFirst.length
      ? newestFirst.slice(0, limit)
      : newestFirst;
  }

  /** One component's recent history, NEWEST-FIRST (optionally capped at `limit`). */
  recentFor(key: ComponentKey, limit?: number): ConsoleEvent[] {
    const ring = this.byComponent.get(componentKeyId(key)) ?? [];
    const newestFirst = [...ring].reverse();
    return limit !== undefined && limit < newestFirst.length
      ? newestFirst.slice(0, limit)
      : newestFirst;
  }

  /** Events currently held fleet-wide (diagnostics/tests). */
  size(): number {
    return this.ring.length;
  }

  /** Register an arrival listener; returns the unsubscribe function. */
  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
}

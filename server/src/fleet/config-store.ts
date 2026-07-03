/**
 * ConfigStore — the console's retained-`cfg` cache (slice C5): the latest `cfg`
 * envelope BODY per component `(device, component, instance)`, timestamped on receipt.
 *
 * Why a side store and not the FleetModel: the liveness snapshot/delta stream
 * deliberately carries no message bodies (a `value-updated` delta is a change
 * notification, and re-snapshotting per body would be the wrong tool) — config-review
 * instead delivers the body ON DEMAND over the C5 `get-config`/`config` frames. This
 * store is the server half of that: BusIngress tees every ingress event here (next to
 * the FleetModel's `ingest`), `cfg` envelopes are retained latest-wins, and the WS
 * gateway reads `get()` / subscribes `onUpdate()` to push fresh arrivals to
 * interested clients.
 *
 * Pure core, no IO, injected clock — the same discipline as the FleetModel. Bodies are
 * kept VERBATIM: the library's redaction v1 already ran at the publisher (`"***"`
 * values, `$secret` refs untouched), so what is stored is exactly what may be shown.
 */
import type { ComponentKey } from "@edgecommons/edge-console-protocol";
import { componentKeyId } from "@edgecommons/edge-console-protocol";
import type { IngressEvent } from "../ingress/normalizer";
import type { Clock } from "./fleet-model";

/** One retained effective-config announcement. */
export interface StoredConfig {
  key: ComponentKey;
  /** The `cfg` envelope body verbatim (`{"config": {...}}`, lib-redacted). */
  body: unknown;
  /** Console receipt time (server-clock ms epoch) — the "last received" stamp. */
  receivedAt: number;
  /** The publisher's `header.timestamp` claim, when present (display only). */
  sourceTimestamp?: string;
}

/** Notified with the fresh entry on every retained `cfg` arrival (latest-wins commit). */
export type ConfigUpdateListener = (entry: StoredConfig) => void;

/** The retained-cfg cache: `cfg` ingest tee + latest-wins + on-update fanout hook. */
export class ConfigStore {
  private readonly byId = new Map<string, StoredConfig>();
  private readonly listeners: ConfigUpdateListener[] = [];

  constructor(private readonly clock: Clock) {}

  /**
   * Tee one ingress event into the store. Only attributable `cfg` envelopes are
   * retained (latest-wins — per-class serial dispatch in BusIngress preserves bus
   * order); everything else (other classes, raw/LWT, unattributable) is a no-op.
   */
  ingest(event: IngressEvent): void {
    if (event.kind !== "envelope" || event.cls !== "cfg") return;
    const last = event.identity.hier[event.identity.hier.length - 1];
    const device = last?.value;
    if (device === undefined || device === "") return; // unattributable — defensive (G11)
    const key: ComponentKey = {
      device,
      component: event.identity.component,
      instance: event.identity.instance,
    };
    const entry: StoredConfig = {
      key,
      body: event.body,
      receivedAt: this.clock(),
      ...(event.sourceTimestamp !== undefined ? { sourceTimestamp: event.sourceTimestamp } : {}),
    };
    this.byId.set(componentKeyId(key), entry);
    for (const listener of [...this.listeners]) listener(entry);
  }

  /** The latest retained cfg for a component, or `undefined` if it never pushed one. */
  get(key: ComponentKey): StoredConfig | undefined {
    return this.byId.get(componentKeyId(key));
  }

  /** Number of components with a retained cfg (diagnostics/tests). */
  size(): number {
    return this.byId.size;
  }

  /** Register an update listener; returns the unsubscribe function. */
  onUpdate(listener: ConfigUpdateListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
}

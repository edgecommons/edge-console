/**
 * ConfigStore (browser) — the pure fold core for the C5 config-review frames, the
 * client-side mirror of the server's retained-cfg cache. Same discipline as the
 * FleetStore: no IO, no clock reads (the {@link FleetClient} IO shell feeds it frames
 * and owns timers/sockets), an identity-stable derived view for React.
 *
 * Entry lifecycle per component key:
 *  - `noteRequested`   — a `get-config` went out (or will, on reconnect): the entry
 *    exists as `loading` until the gateway answers. A re-request of an already-loaded
 *    entry keeps the loaded body (the answer will overwrite it — no flicker).
 *  - `applyConfig`     — the gateway's `config` frame (reply or push): latest-wins,
 *    body VERBATIM (already lib-redacted: `"***"` values, `$secret` refs), stamped
 *    with the server-clock `receivedAt`; clears any pending `refreshing` flag.
 *  - `applyUnavailable`— the gateway holds no cfg for the key: phase `unavailable`
 *    (the honest server answer wins — a previously shown body is dropped, e.g. after
 *    a console restart emptied the server cache). Not terminal: a later push flips
 *    it back to `loaded`.
 *  - `noteRefreshRequested`/`clearRefreshing` — the Refresh action's UX flag; the
 *    client sets it when `refresh-config` goes out and clears it on the next config
 *    arrival or on its own timeout (a device-side republish listener may not exist
 *    yet — absence is silent by protocol design).
 */
import type { ComponentKey } from "@edgecommons/edge-console-protocol";
import { componentKeyId } from "@edgecommons/edge-console-protocol";

/** Where an entry stands. `loading` = requested, no answer yet. */
export type ConfigPhase = "loading" | "loaded" | "unavailable";

/** One component's config-review state (immutable snapshot handed to React). */
export interface ConfigEntryView {
  key: ComponentKey;
  /** Canonical `device/component/instance` id (stable React key / lookup). */
  id: string;
  phase: ConfigPhase;
  /** The retained `cfg` envelope body verbatim (present iff `loaded`). */
  body?: unknown;
  /** Console receipt time (server-clock ms) — the "last received Ns ago" stamp. */
  receivedAt?: number;
  /** The publisher's own header timestamp claim (display only). */
  sourceTimestamp?: string;
  /** A `refresh-config` is in flight for this entry's device. */
  refreshing: boolean;
}

/** The derived view: entries by component-key id (identity-stable between folds). */
export interface ConfigView {
  entriesById: Record<string, ConfigEntryView>;
}

/** Mutable internal entry. */
interface ConfigEntryState {
  key: ComponentKey;
  id: string;
  phase: ConfigPhase;
  body?: unknown;
  receivedAt?: number;
  sourceTimestamp?: string;
  refreshing: boolean;
}

const EMPTY_VIEW: ConfigView = { entriesById: {} };

/** The pure client config store: request/answer/refresh folds + derived view. */
export class ConfigStore {
  private readonly entries = new Map<string, ConfigEntryState>();

  private version = 0;
  private cachedView: ConfigView = EMPTY_VIEW;
  private cachedVersion = 0;

  /** Record an outgoing `get-config`. Loaded entries keep their body (no flicker). */
  noteRequested(key: ComponentKey): void {
    const id = componentKeyId(key);
    if (this.entries.has(id)) return; // loaded/unavailable/loading — the answer updates it
    this.entries.set(id, { key: { ...key }, id, phase: "loading", refreshing: false });
    this.bump();
  }

  /** Fold a `config` frame (reply or push): latest-wins, clears `refreshing`. */
  applyConfig(key: ComponentKey, cfg: unknown, receivedAt: number, sourceTimestamp?: string): void {
    const entry = this.ensure(key);
    entry.phase = "loaded";
    entry.body = cfg;
    entry.receivedAt = receivedAt;
    if (sourceTimestamp !== undefined) entry.sourceTimestamp = sourceTimestamp;
    else delete entry.sourceTimestamp;
    entry.refreshing = false;
    this.bump();
  }

  /** Fold a `config-unavailable` frame: the server's honest answer wins. */
  applyUnavailable(key: ComponentKey): void {
    const entry = this.ensure(key);
    entry.phase = "unavailable";
    delete entry.body;
    delete entry.receivedAt;
    delete entry.sourceTimestamp;
    entry.refreshing = false;
    this.bump();
  }

  /** Record an outgoing `refresh-config` covering this entry. */
  noteRefreshRequested(key: ComponentKey): void {
    const entry = this.ensure(key);
    if (entry.refreshing) return;
    entry.refreshing = true;
    this.bump();
  }

  /** The refresh window closed without an answer (client-side timeout). */
  clearRefreshing(key: ComponentKey): void {
    const entry = this.entries.get(componentKeyId(key));
    if (entry === undefined || !entry.refreshing) return;
    entry.refreshing = false;
    this.bump();
  }

  /** The immutable derived view (cached; identity changes only when the store does). */
  view(): ConfigView {
    if (this.cachedVersion === this.version) return this.cachedView;
    const entriesById: Record<string, ConfigEntryView> = {};
    for (const [id, e] of this.entries) {
      entriesById[id] = {
        key: { ...e.key },
        id,
        phase: e.phase,
        ...(e.phase === "loaded" ? { body: e.body } : {}),
        ...(e.receivedAt !== undefined ? { receivedAt: e.receivedAt } : {}),
        ...(e.sourceTimestamp !== undefined ? { sourceTimestamp: e.sourceTimestamp } : {}),
        refreshing: e.refreshing,
      };
    }
    this.cachedView = { entriesById };
    this.cachedVersion = this.version;
    return this.cachedView;
  }

  // ------------------------------------------------------------------ internals

  private ensure(key: ComponentKey): ConfigEntryState {
    const id = componentKeyId(key);
    let entry = this.entries.get(id);
    if (entry === undefined) {
      entry = { key: { ...key }, id, phase: "loading", refreshing: false };
      this.entries.set(id, entry);
    }
    return entry;
  }

  private bump(): void {
    this.version++;
  }
}

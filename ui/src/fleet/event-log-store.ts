/**
 * EventLogStore (browser) — the pure fold core for the C6 event frames, the
 * client-side mirror of the server's rolling `evt` history. Same discipline as the
 * FleetStore/ConfigStore: no IO, no clock reads (the {@link FleetClient} IO shell
 * feeds it frames), an identity-stable derived view for React.
 *
 * Fold rules:
 *  - `events` (the `subscribe-events` backlog) REPLACES the list — the server ring
 *    is the truth of "recent", so a fresh backlog after reconnect self-heals any
 *    divergence (including a server restart, which resets event ids).
 *  - `event` (live push) prepends, deduped by the monotonic id (a push racing the
 *    backlog reply arrives with an id the backlog already contains — skipped).
 *  - The list is bounded (drop-oldest) with the same default cap as the server
 *    ring, so a long-lived tab can't grow unboundedly.
 */
import type { ConsoleEvent } from "@edgecommons/edge-console-protocol";

/** The derived view: recent events, NEWEST-FIRST (identity-stable between folds). */
export interface EventsView {
  entries: ConsoleEvent[];
}

const EMPTY_VIEW: EventsView = { entries: [] };

/** The client cap mirrors the server's default fleet-wide ring. */
export const DEFAULT_CLIENT_EVENT_CAP = 1000;

/** The pure client event-log store: backlog/live folds + derived view. */
export class EventLogStore {
  /** Newest-first, bounded. */
  private entries: ConsoleEvent[] = [];

  private version = 0;
  private cachedView: EventsView = EMPTY_VIEW;
  private cachedVersion = 0;

  constructor(private readonly cap: number = DEFAULT_CLIENT_EVENT_CAP) {}

  /** Fold an `events` backlog frame (newest-first): replaces the list wholesale. */
  applyBacklog(events: ConsoleEvent[]): void {
    // Defensive re-sort: the wire contract says newest-first, but the fold must
    // not depend on it (ids are the arrival order).
    this.entries = [...events].sort((a, b) => b.id - a.id).slice(0, this.cap);
    this.bump();
  }

  /** Fold a live `event` push: prepend unless the id is already held (dedup). */
  applyEvent(event: ConsoleEvent): void {
    if (this.entries.some((e) => e.id === event.id)) return;
    this.entries = [event, ...this.entries].slice(0, this.cap);
    this.bump();
  }

  /** The immutable derived view (cached; identity changes only when the store does). */
  view(): EventsView {
    if (this.cachedVersion === this.version) return this.cachedView;
    this.cachedView = { entries: [...this.entries] };
    this.cachedVersion = this.version;
    return this.cachedView;
  }

  private bump(): void {
    this.version++;
  }
}

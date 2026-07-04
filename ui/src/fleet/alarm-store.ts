/**
 * AlarmStore (browser) — the pure fold core for the R0 `alarms` frame, the client-side
 * mirror of the server AlarmTracker: the active-alarm list + counts. No IO, no clock
 * reads; the {@link FleetClient} feeds it frames; identity-stable derived view for React.
 *
 * The server sends ONE replace-`alarms` frame as the `subscribe-alarms` reply AND on
 * every later change (raise/clear/ack/containment) — alarm volume is low and a single
 * ack or a device-containment transition can move many rows at once, so a full replace
 * is simpler and always correct. This store therefore just holds the latest snapshot.
 * It powers the app-bar notifications badge (`counts.active`) in R0 and the Overview
 * "Active alerts" tile (R1) + the Events & Alarms screen (R4) later.
 */
import type { AlarmCounts, AlarmSnapshot, ConsoleAlarm } from "@edgecommons/edge-console-protocol";

/** The empty active-alarm counts. */
export const EMPTY_ALARM_COUNTS: AlarmCounts = {
  critical: 0,
  warning: 0,
  active: 0,
  contained: 0,
  acked: 0,
};

/** The derived view: active alarms + counts. */
export interface AlarmsView {
  active: ConsoleAlarm[];
  counts: AlarmCounts;
}

const EMPTY_VIEW: AlarmsView = { active: [], counts: EMPTY_ALARM_COUNTS };

/** The pure client alarm store: snapshot replace + derived view. */
export class AlarmStore {
  private snapshot: AlarmSnapshot | undefined;
  private version = 0;
  private cachedView: AlarmsView = EMPTY_VIEW;
  private cachedVersion = -1;

  /** Fold an `alarms` frame: replaces the active list + counts wholesale. */
  applySnapshot(snapshot: AlarmSnapshot): void {
    this.snapshot = snapshot;
    this.version++;
  }

  /** The immutable derived view (cached; identity changes only when the store does). */
  view(): AlarmsView {
    if (this.cachedVersion === this.version) return this.cachedView;
    this.cachedView =
      this.snapshot === undefined
        ? EMPTY_VIEW
        : { active: this.snapshot.active, counts: this.snapshot.counts };
    this.cachedVersion = this.version;
    return this.cachedView;
  }
}

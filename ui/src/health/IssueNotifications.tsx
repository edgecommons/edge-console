/**
 * The Overview inline-notification strip (mockup `.note` pattern), faithful to the hi-fi:
 *
 *  - the ACTIVE-ALARM notes — the AlarmTracker's non-contained active alarms, each an actionable
 *    `note err` / `note warn` with **View** (→ Events & Alarms) and **Ack** (→ the `ack-alarm`
 *    frame; the alarm carries the ack target). These are the "active alerts as actionable notes";
 *  - the device CONTAINMENT note(s) — one `note unreach` per UNREACHABLE device ("the road is
 *    down, not the houses"), with a **Details** action. Non-ackable (a whole-device rollup).
 *
 * Capped at {@link MAX_VISIBLE_ISSUES} with a "+N more" line so a bad day stays readable. The two
 * Carbon `Button`s per alarm note (View + Ack) are why this is the mockup's custom `.note` element
 * rather than Carbon's single-action `ActionableNotification`.
 */
import { Button } from "@carbon/react";
import { CloudOffline, ErrorFilled, WarningAltFilled } from "@carbon/react/icons";
import type { AlarmNote, FleetIssue } from "../fleet/selectors";

/** Max notes shown before collapsing to "+N more". */
export const MAX_VISIBLE_ISSUES = 4;

export interface IssueNotificationsProps {
  /** The actionable active-alarm notes (AlarmTracker) — View + Ack. */
  alerts: AlarmNote[];
  /** The whole-device containment notes (unreachable devices) — Details only. */
  containment: FleetIssue[];
  /** Open the Events & Alarms screen (the per-note "View" / "Details" action). */
  onView?: () => void;
  /** Acknowledge an active alarm (the per-note "Ack" action → the `ack-alarm` frame). */
  onAck?: (alarmId: string) => void;
}

export function IssueNotifications({
  alerts,
  containment,
  onView,
  onAck,
}: IssueNotificationsProps): React.JSX.Element | null {
  const total = alerts.length + containment.length;
  if (total === 0) return null;

  // Render alarm notes first, then the containment rollup — but the containment note is a key,
  // distinct signal ("the road is down"), so it is PRIORITIZED for visibility: reserve it, then
  // fill the remaining budget with alarm notes (excess alarms collapse to "+N more").
  const visibleContainment = containment.slice(0, MAX_VISIBLE_ISSUES);
  const alertBudget = Math.max(0, MAX_VISIBLE_ISSUES - visibleContainment.length);
  const visibleAlerts = alerts.slice(0, alertBudget);
  const hidden = total - visibleAlerts.length - visibleContainment.length;

  return (
    <div className="ec-issues" data-testid="issue-notifications">
      {visibleAlerts.map((note) => (
        <AlarmNoteRow key={note.id} note={note} onView={onView} onAck={onAck} />
      ))}
      {visibleContainment.map((note) => (
        <ContainmentNoteRow key={note.id} note={note} onView={onView} />
      ))}
      {hidden > 0 && (
        <p className="ec-dim ec-issues__more">
          +{hidden} more alert{hidden === 1 ? "" : "s"} — see Events &amp; Alarms.
        </p>
      )}
    </div>
  );
}

/** One active-alarm note: `note err`/`note warn` with View + Ack. */
function AlarmNoteRow({
  note,
  onView,
  onAck,
}: {
  note: AlarmNote;
  onView?: () => void;
  onAck?: (alarmId: string) => void;
}): React.JSX.Element {
  const kind = note.severity === "warning" ? "warn" : "err";
  const Icon = note.severity === "warning" ? WarningAltFilled : ErrorFilled;
  return (
    <div
      className={`ec-note ec-note--${kind}`}
      data-testid={`alarm-note-${note.id}`}
      role="status"
    >
      <span className="ec-note__icon" aria-hidden="true">
        <Icon size={16} />
      </span>
      <div className="ec-note__body">
        <b>{note.title}</b>
        <small>{note.subtitle}</small>
      </div>
      <div className="ec-note__actions">
        {onView !== undefined && (
          <Button kind="ghost" size="sm" onClick={onView}>
            View
          </Button>
        )}
        {onAck !== undefined && (
          <Button
            kind="tertiary"
            size="sm"
            disabled={note.acked}
            data-testid={`ack-${note.id}`}
            onClick={() => onAck(note.id)}
          >
            {note.acked ? "Acked" : "Ack"}
          </Button>
        )}
      </div>
    </div>
  );
}

/** One device-containment note: `note unreach` with a Details action. */
function ContainmentNoteRow({
  note,
  onView,
}: {
  note: FleetIssue;
  onView?: () => void;
}): React.JSX.Element {
  return (
    <div className="ec-note ec-note--unreach" data-testid={`containment-note-${note.id}`}>
      <span className="ec-note__icon" aria-hidden="true">
        <CloudOffline size={16} />
      </span>
      <div className="ec-note__body">
        <b>{note.title}</b>
        <small>{note.subtitle}</small>
      </div>
      <div className="ec-note__actions">
        {onView !== undefined && (
          <Button kind="ghost" size="sm" onClick={onView}>
            Details
          </Button>
        )}
      </div>
    </div>
  );
}

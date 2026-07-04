/**
 * Events & Alarms feed selectors (slice R4) — the pure split/merge behind the
 * upgraded screen. Two data sources, one chronological table:
 *
 *  - ALARMS are STATEFUL and ackable (from the R0 {@link AlarmTracker} via the
 *    `alarms` snapshot): a raise/clear/ack/containment state machine. Each active
 *    alarm becomes a feed row with a lifecycle STATE (`active` / `acked` /
 *    `contained`) and, while `active`, an Ack action.
 *  - EVENTS are the INFORMATIONAL feed (from the EventStore): the NON-alarming
 *    `evt`s (info / debug / unknown). The alarming-severity `evt`s (critical /
 *    error / warning) are deliberately EXCLUDED here because they are already
 *    represented as their alarm — no double-listing ("keep the live event feed for
 *    non-alarm evts").
 *
 * Everything here is pure + unit-testable without React; the view renders it.
 */
import type {
  ComponentKey,
  ConsoleAlarm,
  ConsoleEvent,
} from "@edgecommons/edge-console-protocol";
import {
  classifyEventSeverity,
  componentKeyId,
  isAlarmingSeverity,
} from "@edgecommons/edge-console-protocol";
import type { EventFilters, SeverityFilter } from "./selectors";
import { severityBucket, summarizeBody } from "./selectors";

/** A feed row's lifecycle state — an alarm's, or the informational `event` marker. */
export type FeedState = "active" | "acked" | "contained" | "event";

/** The human label for each {@link FeedState} (the mockup's State column). */
export const FEED_STATE_LABEL: Record<FeedState, string> = {
  active: "Active",
  acked: "Acked",
  contained: "Contained",
  event: "Event",
};

/** One unified row of the Events & Alarms table (an alarm OR an informational event). */
export interface FeedRow {
  kind: "alarm" | "event";
  /** Stable id (React key + expansion identity): `alarm:${alarmId}` / `event:${eventId}`. */
  id: string;
  /** The sort timestamp (server-clock ms): an alarm's latest raise, an event's receipt. */
  at: number;
  /** The severity bucket for the chip (alarms map directly; events via their token). */
  severity: SeverityFilter;
  componentId: string;
  key: ComponentKey;
  /** The alarm/event type (the channel remainder). */
  title: string;
  /** A one-line body/message summary. */
  summary: string;
  state: FeedState;
  /** Whether an Ack action applies (an active, un-acked, un-contained alarm). */
  ackable: boolean;
  /** Suppressed under an UNREACHABLE device (alarms only). */
  contained: boolean;
  /** Re-raise count since the alarm became active (alarms only). */
  count?: number;
  /** The underlying alarm (present iff `kind === "alarm"`). */
  alarm?: ConsoleAlarm;
  /** The underlying event (present iff `kind === "event"`). */
  event?: ConsoleEvent;
  /** The source instance for an event row (the connection that raised it); absent for alarms. */
  instance?: string;
}

/**
 * Merge the active alarms and the informational events into one newest-first feed.
 * Alarming-severity events are dropped (surfaced as alarms instead); ties break on id
 * for a stable order.
 */
export function feedRows(alarms: ConsoleAlarm[], events: ConsoleEvent[]): FeedRow[] {
  const rows: FeedRow[] = [];
  for (const a of alarms) {
    rows.push({
      kind: "alarm",
      id: `alarm:${a.id}`,
      at: a.lastAt,
      severity: a.severity,
      componentId: a.componentId,
      key: a.key,
      title: a.type,
      summary: a.message ?? "",
      state: a.contained ? "contained" : a.acked ? "acked" : "active",
      ackable: !a.contained && !a.acked,
      contained: a.contained,
      count: a.count,
      alarm: a,
    });
  }
  for (const e of events) {
    if (isAlarmingSeverity(classifyEventSeverity(e.severity))) continue; // shown as an alarm, not here
    rows.push({
      kind: "event",
      id: `event:${e.id}`,
      at: e.receivedAt,
      severity: severityBucket(e),
      componentId: componentKeyId(e.key),
      key: e.key,
      instance: e.instance,
      title: e.type,
      summary: summarizeBody(e.body),
      state: "event",
      ackable: false,
      contained: false,
      event: e,
    });
  }
  rows.sort((x, y) => y.at - x.at || x.id.localeCompare(y.id));
  return rows;
}

/** The distinct feed sources (componentKeyIds), sorted — the component filter's options. */
export function feedSourceIds(rows: FeedRow[]): string[] {
  const ids = new Set<string>();
  for (const r of rows) ids.add(r.componentId);
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/** Apply the component/severity filters to the merged feed (AND-combined, order preserved). */
export function filterFeed(rows: FeedRow[], filters: EventFilters): FeedRow[] {
  return rows.filter((r) => {
    if (filters.componentId !== undefined && r.componentId !== filters.componentId) return false;
    if (filters.severity !== undefined && r.severity !== filters.severity) return false;
    return true;
  });
}

/** Console-side ack audit: who acked an alarm and when (this console's own action). */
export interface AckAuditEntry {
  /** Client-clock ms of the local Ack click. */
  at: number;
  /** The acking connection's RBAC role, when known. */
  by?: string;
}

/** The ack-audit map (alarmId → who/when), owned console-side. */
export type AckAudit = Record<string, AckAuditEntry>;

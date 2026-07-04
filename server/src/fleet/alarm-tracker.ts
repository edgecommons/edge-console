/**
 * AlarmTracker — the console-side ALARM state machine (slice R0): the data behind the
 * Overview "Active alerts" tile (R1), the app-bar notifications badge, and the Events &
 * Alarms screen (R4). Pure core, no IO, injected clock — the FleetModel/side-store
 * discipline.
 *
 * Alarms are DERIVED from the `evt` severity stream (the console owns this; the library
 * has no alarm facade). Keyed by `(component, type)`:
 *  - a critical/error/warning `evt` RAISES (or re-raises, bumping the count) an active
 *    alarm — see {@link isAlarmingSeverity};
 *  - a normal-severity (info/debug/unknown) `evt` on the SAME `(component, type)` CLEARS
 *    it into history (a "resolve" convention: `evt/info/connection-lost` clears the
 *    `connection-lost` alarm raised by `evt/critical/connection-lost`);
 *  - `ack` is console-side state (it does not clear the alarm);
 *  - a device UNREACHABLE CONTAINS its components' alarms — they stay active but are
 *    flagged `contained` and excluded from the active counts ("the road is down, not the
 *    houses"): the caller drives {@link setDeviceContainment} from the FleetModel's
 *    `device-reachability-changed` deltas.
 *
 * Every mutation (`ingest`/`ack`/`setDeviceContainment`) recomputes the {@link AlarmSnapshot}
 * and notifies listeners with the fresh snapshot — the WS gateway pushes it as one
 * replace-`alarms` frame (alarm volume is low; ack/containment can move many rows at once).
 */
import type {
  AlarmCounts,
  AlarmSnapshot,
  ComponentKey,
  ConsoleAlarm,
  EventSeverityLevel,
} from "@edgecommons/edge-console-protocol";
import {
  classifyEventSeverity,
  componentKeyId,
  isAlarmingSeverity,
  splitEventChannel,
} from "@edgecommons/edge-console-protocol";
import type { EnvelopeEvent, IngressEvent } from "../ingress/normalizer";
import type { Clock } from "./fleet-model";

/** The tracker's bounds. */
export interface AlarmTrackerOptions {
  /** Resolved-alarm history ring capacity (drop-oldest). Default 500. */
  maxHistory: number;
  /** Max distinct active alarms; overflow raises are dropped + counted. Default 2000. */
  maxActive: number;
}

export const DEFAULT_ALARM_TRACKER_OPTIONS: AlarmTrackerOptions = {
  maxHistory: 500,
  maxActive: 2000,
};

/** Notified with the fresh full snapshot on every change (raise/clear/ack/containment). */
export type AlarmListener = (snapshot: AlarmSnapshot) => void;

/** Mutable active-alarm record. */
interface AlarmState {
  id: string;
  key: ComponentKey;
  componentId: string;
  severity: EventSeverityLevel;
  type: string;
  message?: string;
  raisedAt: number;
  lastAt: number;
  count: number;
  acked: boolean;
  contained: boolean;
  channel?: string;
}

/** The console-side alarm state machine over the `evt` severity stream. */
export class AlarmTracker {
  private readonly opts: AlarmTrackerOptions;
  private readonly active = new Map<string, AlarmState>();
  private readonly containedDevices = new Set<string>();
  private readonly historyRing: ConsoleAlarm[] = [];
  private readonly listeners: AlarmListener[] = [];
  private dropped = 0;

  constructor(
    private readonly clock: Clock,
    opts?: Partial<AlarmTrackerOptions>,
  ) {
    this.opts = { ...DEFAULT_ALARM_TRACKER_OPTIONS, ...opts };
  }

  /**
   * Tee one ingress event into the tracker. Only attributable `evt` envelopes act; an
   * alarming severity raises/re-raises, a normal severity clears the matching alarm.
   */
  ingest(event: IngressEvent): void {
    if (event.kind !== "envelope" || event.cls !== "evt") return;
    const last = event.identity.hier[event.identity.hier.length - 1];
    const device = last?.value;
    if (device === undefined || device === "") return; // unattributable — defensive (G11)
    const { severity, type } = splitEventChannel(event.channel);
    const level = classifyEventSeverity(severity);
    const key: ComponentKey = {
      device,
      component: event.identity.component,
    };
    const componentId = componentKeyId(key);
    const id = `${componentId}::${type}`;

    if (isAlarmingSeverity(level)) {
      this.raise(id, key, componentId, level!, type, event);
    } else {
      this.clear(id);
    }
  }

  /**
   * Contain (or release) a device's component alarms — driven by the FleetModel's
   * `device-reachability-changed` delta. Contained alarms stay active but leave the
   * active counts (the "+N contained" rollup). Idempotent; notifies only on a change.
   */
  setDeviceContainment(device: string, contained: boolean): void {
    if (contained) this.containedDevices.add(device);
    else this.containedDevices.delete(device);
    let changed = false;
    for (const alarm of this.active.values()) {
      if (alarm.key.device === device && alarm.contained !== contained) {
        alarm.contained = contained;
        changed = true;
      }
    }
    if (changed) this.notify();
  }

  /** Acknowledge an active alarm (console-side; does not clear it). Returns whether it changed. */
  ack(alarmId: string): boolean {
    const alarm = this.active.get(alarmId);
    if (alarm === undefined || alarm.acked) return false;
    alarm.acked = true;
    this.notify();
    return true;
  }

  /** The active-alarm surface (active list newest-raise-first + counts). */
  snapshot(): AlarmSnapshot {
    const active = [...this.active.values()]
      .sort((a, b) => b.raisedAt - a.raisedAt || a.id.localeCompare(b.id))
      .map((a) => alarmOf(a));
    return { active, counts: this.counts() };
  }

  /** The resolved-alarm history, NEWEST-FIRST (optionally capped at `limit`). */
  history(limit?: number): ConsoleAlarm[] {
    const newestFirst = [...this.historyRing].reverse();
    return limit !== undefined && limit < newestFirst.length
      ? newestFirst.slice(0, limit)
      : newestFirst;
  }

  /** Active alarms currently tracked (diagnostics/tests). */
  activeCount(): number {
    return this.active.size;
  }

  /** Raises dropped by the active cap (diagnostics/tests). */
  droppedAlarms(): number {
    return this.dropped;
  }

  /** Register a snapshot listener; returns the unsubscribe function. */
  onUpdate(listener: AlarmListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  // ------------------------------------------------------------------ internals

  private raise(
    id: string,
    key: ComponentKey,
    componentId: string,
    level: EventSeverityLevel,
    type: string,
    event: EnvelopeEvent,
  ): void {
    const now = this.clock();
    const message = messageOf(event.body);
    const existing = this.active.get(id);
    if (existing !== undefined) {
      existing.count++;
      existing.lastAt = now;
      existing.severity = level;
      if (message !== undefined) existing.message = message;
      else delete existing.message;
      if (event.channel !== undefined) existing.channel = event.channel;
      this.notify();
      return;
    }
    if (this.active.size >= this.opts.maxActive) {
      this.dropped++;
      return; // overflow guard — existing alarms keep updating
    }
    this.active.set(id, {
      id,
      key,
      componentId,
      severity: level,
      type,
      ...(message !== undefined ? { message } : {}),
      raisedAt: now,
      lastAt: now,
      count: 1,
      acked: false,
      contained: this.containedDevices.has(key.device),
      ...(event.channel !== undefined ? { channel: event.channel } : {}),
    });
    this.notify();
  }

  private clear(id: string): void {
    const alarm = this.active.get(id);
    if (alarm === undefined) return; // nothing active to clear — no-op
    this.active.delete(id);
    const resolved: ConsoleAlarm = { ...alarmOf(alarm), resolvedAt: this.clock() };
    this.historyRing.push(resolved);
    if (this.historyRing.length > this.opts.maxHistory) this.historyRing.shift();
    this.notify();
  }

  private counts(): AlarmCounts {
    let critical = 0;
    let warning = 0;
    let activeN = 0;
    let contained = 0;
    let acked = 0;
    for (const a of this.active.values()) {
      if (a.contained) {
        contained++;
        continue;
      }
      activeN++;
      if (a.severity === "critical") critical++;
      else warning++; // warning + error share the warning bucket (the mockup's crit/warn split)
      if (a.acked) acked++;
    }
    return { critical, warning, active: activeN, contained, acked };
  }

  private notify(): void {
    if (this.listeners.length === 0) return;
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) listener(snapshot);
  }
}

/** Project the mutable record into the wire {@link ConsoleAlarm} (active — no `resolvedAt`). */
function alarmOf(a: AlarmState): ConsoleAlarm {
  return {
    id: a.id,
    key: { ...a.key },
    componentId: a.componentId,
    severity: a.severity,
    type: a.type,
    ...(a.message !== undefined ? { message: a.message } : {}),
    raisedAt: a.raisedAt,
    lastAt: a.lastAt,
    count: a.count,
    acked: a.acked,
    contained: a.contained,
    ...(a.channel !== undefined ? { channel: a.channel } : {}),
  };
}

/** The `message` string from an event body, when present. */
function messageOf(body: unknown): string | undefined {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const m = (body as Record<string, unknown>).message;
    if (typeof m === "string") return m;
  }
  return undefined;
}

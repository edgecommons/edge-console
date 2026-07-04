/**
 * AlarmTracker (R0): the console-side alarm state machine over the `evt` severity
 * stream — raise/re-raise/clear keyed by `(component, type)`, device-UNREACHABLE
 * containment, console-side ack, counts, and the resolved-alarm history.
 */
import { describe, expect, it } from "vitest";
import type { AlarmSnapshot, ComponentKey } from "@edgecommons/edge-console-protocol";
import { AlarmTracker } from "../src/fleet/alarm-tracker";
import type { IngressEvent } from "../src/ingress/normalizer";

class TestClock {
  now = 1_000_000;
  tick(ms: number): void {
    this.now += ms;
  }
  fn = (): number => this.now;
}

const OPCUA: ComponentKey = { device: "gw-01", component: "opcua-adapter" };
const MODBUS: ComponentKey = { device: "gw-01", component: "modbus-adapter" };

function evtEvent(key: ComponentKey, channel: string | undefined, body: unknown = {}): IngressEvent {
  return {
    kind: "envelope",
    cls: "evt",
    ...(channel !== undefined ? { channel } : {}),
    identity: {
      hier: [
        { level: "site", value: "dallas" },
        { level: "device", value: key.device },
      ],
      path: `dallas/${key.device}`,
      component: key.component,
      instance: "main",
    },
    body,
    topic: `ecv1/${key.device}/${key.component}/main/evt/${channel ?? ""}`,
  };
}

describe("AlarmTracker - raise / re-raise / clear", () => {
  it("raises an alarm on an alarming severity, re-raises (count++), and clears on a normal follow-up", () => {
    const clock = new TestClock();
    const tracker = new AlarmTracker(clock.fn);
    const snaps: AlarmSnapshot[] = [];
    tracker.onUpdate((s) => snaps.push(s));

    tracker.ingest(evtEvent(OPCUA, "critical/connection-lost", { message: "session dropped" }));
    let snap = tracker.snapshot();
    expect(snap.active).toHaveLength(1);
    expect(snap.active[0]).toMatchObject({
      id: "gw-01/opcua-adapter::connection-lost",
      severity: "critical",
      type: "connection-lost",
      message: "session dropped",
      count: 1,
      acked: false,
      contained: false,
    });
    expect(snap.counts).toEqual({ critical: 1, warning: 0, active: 1, contained: 0, acked: 0 });

    clock.tick(1000);
    tracker.ingest(evtEvent(OPCUA, "critical/connection-lost", { message: "still down" }));
    snap = tracker.snapshot();
    expect(snap.active[0]!.count).toBe(2);
    expect(snap.active[0]!.message).toBe("still down");

    // A normal-severity follow-up on the SAME (component, type) clears it into history.
    clock.tick(1000);
    tracker.ingest(evtEvent(OPCUA, "info/connection-lost", { message: "reconnected" }));
    snap = tracker.snapshot();
    expect(snap.active).toHaveLength(0);
    expect(snap.counts.active).toBe(0);
    const history = tracker.history();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ type: "connection-lost", resolvedAt: 1_002_000 });

    // The listener saw every mutation (raise, re-raise, clear).
    expect(snaps).toHaveLength(3);
  });

  it("buckets warning + error together; a clear with no active alarm is a silent no-op", () => {
    const clock = new TestClock();
    const tracker = new AlarmTracker(clock.fn);
    tracker.ingest(evtEvent(OPCUA, "warning/slave-retry"));
    tracker.ingest(evtEvent(MODBUS, "error/pipeline-lag"));
    expect(tracker.snapshot().counts).toMatchObject({ critical: 0, warning: 2, active: 2 });

    const before = tracker.snapshot();
    tracker.ingest(evtEvent(OPCUA, "info/never-raised")); // nothing active for this type
    expect(tracker.snapshot().active).toEqual(before.active);
    expect(tracker.history()).toHaveLength(0);
  });
});

describe("AlarmTracker - containment", () => {
  it("a device going UNREACHABLE contains its alarms (out of active counts); recovery releases them", () => {
    const clock = new TestClock();
    const tracker = new AlarmTracker(clock.fn);
    tracker.ingest(evtEvent(OPCUA, "critical/connection-lost"));
    tracker.ingest(evtEvent(MODBUS, "warning/slave-retry"));
    expect(tracker.snapshot().counts).toMatchObject({ active: 2, contained: 0 });

    tracker.setDeviceContainment("gw-01", true);
    let snap = tracker.snapshot();
    expect(snap.counts).toEqual({ critical: 0, warning: 0, active: 0, contained: 2, acked: 0 });
    expect(snap.active.every((a) => a.contained)).toBe(true);

    // A NEW raise while contained is created already-contained.
    tracker.ingest(evtEvent(OPCUA, "critical/overtemp"));
    expect(tracker.snapshot().counts).toMatchObject({ active: 0, contained: 3 });

    // Recovery releases them back into the active counts.
    tracker.setDeviceContainment("gw-01", false);
    snap = tracker.snapshot();
    expect(snap.counts).toMatchObject({ active: 3, contained: 0 });
    expect(snap.active.every((a) => !a.contained)).toBe(true);
  });

  it("setDeviceContainment is idempotent (no notify when nothing changes)", () => {
    const clock = new TestClock();
    const tracker = new AlarmTracker(clock.fn);
    const snaps: AlarmSnapshot[] = [];
    tracker.ingest(evtEvent(OPCUA, "critical/x"));
    tracker.onUpdate((s) => snaps.push(s));
    tracker.setDeviceContainment("gw-99", true); // no alarms on gw-99
    expect(snaps).toHaveLength(0);
  });
});

describe("AlarmTracker - ack, ignores, bounds, history", () => {
  it("ack marks an active alarm (idempotent) and counts it; unknown ack is a no-op", () => {
    const clock = new TestClock();
    const tracker = new AlarmTracker(clock.fn);
    tracker.ingest(evtEvent(OPCUA, "critical/connection-lost"));
    const id = "gw-01/opcua-adapter::connection-lost";
    expect(tracker.ack(id)).toBe(true);
    expect(tracker.snapshot().counts).toMatchObject({ active: 1, acked: 1 });
    expect(tracker.ack(id)).toBe(false); // already acked
    expect(tracker.ack("nope")).toBe(false); // unknown
    expect(tracker.snapshot().active[0]!.acked).toBe(true);
  });

  it("ignores non-evt classes and unattributable envelopes", () => {
    const clock = new TestClock();
    const tracker = new AlarmTracker(clock.fn);
    tracker.ingest({ ...evtEvent(OPCUA, "critical/x"), cls: "metric" });
    tracker.ingest({ kind: "device-unreachable", device: "gw-01", topic: "x" });
    tracker.ingest({
      ...evtEvent(OPCUA, "critical/x"),
      identity: { hier: [{ level: "device", value: "" }], path: "", component: "c", instance: "main" },
    });
    expect(tracker.snapshot().active).toHaveLength(0);
  });

  it("caps active alarms and counts the overflow", () => {
    const clock = new TestClock();
    const tracker = new AlarmTracker(clock.fn, { maxActive: 1 });
    tracker.ingest(evtEvent(OPCUA, "critical/a"));
    tracker.ingest(evtEvent(OPCUA, "critical/b")); // overflow — dropped
    expect(tracker.activeCount()).toBe(1);
    expect(tracker.droppedAlarms()).toBe(1);
  });

  it("bounds the resolved-alarm history ring (newest-first, limit honored)", () => {
    const clock = new TestClock();
    const tracker = new AlarmTracker(clock.fn, { maxHistory: 2 });
    // Raise+clear three distinct types (one at a time) to exercise the history bound.
    for (const type of ["c1", "c2", "c3"]) {
      tracker.ingest(evtEvent(MODBUS, `critical/${type}`));
      tracker.ingest(evtEvent(MODBUS, `info/${type}`));
    }
    const history = tracker.history();
    expect(history).toHaveLength(2); // bounded
    expect(history.map((h) => h.type)).toEqual(["c3", "c2"]); // newest-first
    expect(tracker.history(1).map((h) => h.type)).toEqual(["c3"]);
  });
});

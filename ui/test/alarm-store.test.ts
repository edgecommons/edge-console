/**
 * AlarmStore (browser) — the R0 alarm fold: a replace `alarms` snapshot in, an
 * identity-stable {active, counts} view out.
 */
import { describe, expect, it } from "vitest";
import { AlarmStore, EMPTY_ALARM_COUNTS } from "../src/fleet/alarm-store";
import { alarmSnapshot, consoleAlarm, key } from "./_fixtures";

describe("AlarmStore", () => {
  it("starts empty (no counts, no active alarms)", () => {
    const store = new AlarmStore();
    expect(store.view()).toEqual({ active: [], counts: EMPTY_ALARM_COUNTS });
  });

  it("replaces on each snapshot and caches the view until the next change", () => {
    const store = new AlarmStore();
    const empty = store.view();
    expect(store.view()).toBe(empty); // cached identity

    store.applySnapshot(
      alarmSnapshot([
        consoleAlarm({ key: key("gw-01", "opcua-adapter"), type: "connection-lost", severity: "critical" }),
        consoleAlarm({ key: key("gw-01", "modbus-adapter"), type: "slave-retry", severity: "warning" }),
      ]),
    );
    const v1 = store.view();
    expect(v1).not.toBe(empty);
    expect(v1.active).toHaveLength(2);
    expect(v1.counts).toMatchObject({ critical: 1, warning: 1, active: 2 });
    expect(store.view()).toBe(v1); // cached until the next apply

    // A later snapshot supersedes wholesale (e.g. one cleared + one acked).
    store.applySnapshot(
      alarmSnapshot([
        consoleAlarm({ key: key("gw-01", "opcua-adapter"), type: "connection-lost", acked: true }),
      ]),
    );
    const v2 = store.view();
    expect(v2).not.toBe(v1);
    expect(v2.active).toHaveLength(1);
    expect(v2.counts).toMatchObject({ critical: 1, active: 1, acked: 1 });
  });
});

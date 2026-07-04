/**
 * Events & Alarms feed selectors (R4) — the pure alarm/event split + merge, State
 * mapping, ack-ability, filters, and sources. No React.
 */
import { describe, expect, it } from "vitest";
import {
  FEED_STATE_LABEL,
  feedRows,
  feedSourceIds,
  filterFeed,
} from "../src/events/alarm-selectors";
import { T0, consoleAlarm, consoleEvent, key } from "./_fixtures";

const OPCUA = key("gw-01", "opcua-adapter");
const MODBUS = key("gw-02", "modbus-adapter");

describe("feedRows - the alarm/event split + merge", () => {
  it("turns active alarms into stateful rows and events into informational rows, newest-first", () => {
    const alarms = [
      consoleAlarm({ key: OPCUA, type: "connection-lost", severity: "critical", lastAt: T0 - 1000, count: 3 }),
    ];
    const events = [
      consoleEvent({ id: 9, key: OPCUA, severity: "info", type: "scan-cycle", receivedAt: T0 - 500 }),
    ];
    const rows = feedRows(alarms, events);
    expect(rows.map((r) => r.id)).toEqual(["event:9", "alarm:gw-01/opcua-adapter/main::connection-lost"]);
    const [ev, al] = rows;
    expect(al!.kind).toBe("alarm");
    expect(al!.state).toBe("active");
    expect(al!.ackable).toBe(true);
    expect(al!.count).toBe(3);
    expect(ev!.kind).toBe("event");
    expect(ev!.state).toBe("event");
    expect(ev!.ackable).toBe(false);
  });

  it("EXCLUDES alarming-severity events from the feed (they are represented as alarms)", () => {
    const events = [
      consoleEvent({ id: 1, severity: "critical", type: "overtemp", receivedAt: T0 }),
      consoleEvent({ id: 2, severity: "warning", type: "retry", receivedAt: T0 }),
      consoleEvent({ id: 3, severity: "error", type: "lag", receivedAt: T0 }),
      consoleEvent({ id: 4, severity: "info", type: "cycle", receivedAt: T0 }),
      consoleEvent({ id: 5, severity: "debug", type: "trace", receivedAt: T0 }),
      consoleEvent({ id: 6, severity: "weird", type: "misc", receivedAt: T0 }), // unknown -> other -> kept
    ];
    const rows = feedRows([], events);
    // Only the non-alarming ones (info/debug/other) survive as event rows.
    expect(rows.map((r) => r.id).sort()).toEqual(["event:4", "event:5", "event:6"]);
  });

  it("maps alarm lifecycle to State: active / acked / contained (+ ackable only when active)", () => {
    const rows = feedRows(
      [
        consoleAlarm({ key: OPCUA, type: "a", acked: false, contained: false }),
        consoleAlarm({ key: MODBUS, type: "b", acked: true, contained: false }),
        consoleAlarm({ key: key("gw-03", "x"), type: "c", contained: true }),
      ],
      [],
    );
    const byType = Object.fromEntries(rows.map((r) => [r.title, r]));
    expect([byType.a!.state, byType.a!.ackable]).toEqual(["active", true]);
    expect([byType.b!.state, byType.b!.ackable]).toEqual(["acked", false]);
    expect([byType.c!.state, byType.c!.ackable]).toEqual(["contained", false]);
    expect(FEED_STATE_LABEL.active).toBe("Active");
    expect(FEED_STATE_LABEL.contained).toBe("Contained");
  });
});

describe("feedSourceIds / filterFeed", () => {
  const rows = feedRows(
    [consoleAlarm({ key: OPCUA, type: "conn", severity: "critical" })],
    [consoleEvent({ id: 1, key: MODBUS, severity: "info", type: "cycle", receivedAt: T0 })],
  );

  it("lists distinct sources across alarms AND events, sorted", () => {
    expect(feedSourceIds(rows)).toEqual([
      "gw-01/opcua-adapter/main",
      "gw-02/modbus-adapter/main",
    ]);
  });

  it("filters the merged feed by component and severity (AND)", () => {
    expect(filterFeed(rows, { componentId: "gw-02/modbus-adapter/main" }).map((r) => r.kind)).toEqual(["event"]);
    expect(filterFeed(rows, { severity: "critical" }).map((r) => r.kind)).toEqual(["alarm"]);
    expect(filterFeed(rows, { severity: "info" }).map((r) => r.kind)).toEqual(["event"]);
    expect(filterFeed(rows, {})).toHaveLength(2);
  });
});

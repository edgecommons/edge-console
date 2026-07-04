/**
 * Events-view selectors (C6): filtering, severity bucketing, header-tile
 * derivations (counts, noisiest, events/min), body summaries, and time format —
 * pure functions, no React.
 */
import { describe, expect, it } from "vitest";
import {
  eventSourceIds,
  eventsPerMinute,
  filterEvents,
  formatClockTime,
  noisiestSource,
  prettyBody,
  severityBucket,
  severityCounts,
  summarizeBody,
} from "../src/events/selectors";
import { T0, consoleEvent, key } from "./_fixtures";

const A = key("gw-01", "opcua-adapter");
const B = key("gw-02", "modbus-adapter");

const ENTRIES = [
  consoleEvent({ id: 4, key: B, severity: "crit", receivedAt: T0 - 1000 }), // synonym token
  consoleEvent({ id: 3, key: A, severity: "warning", receivedAt: T0 - 2000 }),
  consoleEvent({ id: 2, key: A, severity: "machine1", receivedAt: T0 - 3000 }), // unknown -> other
  consoleEvent({ id: 1, key: A, severity: undefined, receivedAt: T0 - 10 * 60_000 }), // old + none
];

describe("severityBucket / severityCounts", () => {
  it("classifies raw tokens (synonyms included) and falls back to 'other'", () => {
    expect(ENTRIES.map(severityBucket)).toEqual(["critical", "warning", "other", "other"]);
    expect(severityCounts(ENTRIES)).toEqual({
      critical: 1,
      error: 0,
      warning: 1,
      info: 0,
      debug: 0,
      other: 2,
    });
  });
});

describe("filterEvents", () => {
  it("filters by component, severity, and both (AND), preserving order", () => {
    expect(filterEvents(ENTRIES, {}).map((e) => e.id)).toEqual([4, 3, 2, 1]);
    expect(filterEvents(ENTRIES, { componentId: "gw-01/opcua-adapter" }).map((e) => e.id)).toEqual([3, 2, 1]);
    expect(filterEvents(ENTRIES, { severity: "critical" }).map((e) => e.id)).toEqual([4]);
    expect(filterEvents(ENTRIES, { severity: "other" }).map((e) => e.id)).toEqual([2, 1]);
    expect(
      filterEvents(ENTRIES, { componentId: "gw-01/opcua-adapter", severity: "warning" }).map((e) => e.id),
    ).toEqual([3]);
  });
});

describe("eventSourceIds / noisiestSource", () => {
  it("lists distinct sources sorted", () => {
    expect(eventSourceIds(ENTRIES)).toEqual([
      "gw-01/opcua-adapter",
      "gw-02/modbus-adapter",
    ]);
    expect(eventSourceIds([])).toEqual([]);
  });

  it("finds the noisiest source within the window only", () => {
    // Within 5 min: A has 2 (ids 3, 2 — id 1 is 10 min old), B has 1.
    expect(noisiestSource(ENTRIES, T0)).toEqual({
      componentId: "gw-01/opcua-adapter",
      count: 2,
    });
    expect(noisiestSource([], T0)).toBeUndefined();
    expect(noisiestSource(ENTRIES, T0, 500)).toBeUndefined(); // window excludes everything
  });
});

describe("eventsPerMinute", () => {
  it("buckets arrivals per trailing minute, ascending time, zero-filled", () => {
    const points = eventsPerMinute(ENTRIES, T0, 3);
    expect(points).toHaveLength(3);
    expect(points.map((p) => p.at)).toEqual([T0 - 120_000, T0 - 60_000, T0]);
    // The three recent events all landed within the last minute; the 10-min-old one outside.
    expect(points.map((p) => p.value)).toEqual([0, 0, 3]);
  });

  it("yields an all-zero series for an empty history", () => {
    expect(eventsPerMinute([], T0, 2).map((p) => p.value)).toEqual([0, 0]);
  });
});

describe("summarizeBody / prettyBody", () => {
  it("prefers the conventional message field, else compact JSON, string bodies verbatim", () => {
    expect(summarizeBody({ message: "boom", code: 7 })).toBe("boom");
    expect(summarizeBody({ reason: "why" })).toBe("why");
    expect(summarizeBody({ code: 7 })).toBe('{"code":7}');
    expect(summarizeBody("plain text")).toBe("plain text");
    expect(summarizeBody(null)).toBe("");
    expect(summarizeBody(42)).toBe("42");
  });

  it("ellipsizes past the cap", () => {
    const long = "x".repeat(300);
    const summary = summarizeBody(long, 20);
    expect(summary).toHaveLength(20);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("pretty-prints the detail body and never throws on hostile values", () => {
    expect(prettyBody({ a: 1 })).toBe('{\n  "a": 1\n}');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(typeof prettyBody(circular)).toBe("string"); // fell back, no throw
  });
});

describe("formatClockTime", () => {
  it("renders HH:MM:SS with zero padding", () => {
    expect(formatClockTime(new Date(2026, 6, 3, 9, 5, 7).getTime())).toBe("09:05:07");
  });
});

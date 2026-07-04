import { describe, expect, it } from "vitest";
import {
  filterSignalRows,
  formatSignalValue,
  qualityBucket,
  signalComponentIds,
  signalRow,
  signalRows,
  signalSeries as toSparkSeries,
} from "../src/signals/selectors";
import { key, signalPoints, signalSeries } from "./_fixtures";

describe("qualityBucket", () => {
  it("maps the canonical tokens case-insensitively", () => {
    expect(qualityBucket("GOOD")).toBe("good");
    expect(qualityBucket("good")).toBe("good");
    expect(qualityBucket(" Uncertain ")).toBe("uncertain");
    expect(qualityBucket("BAD")).toBe("bad");
  });
  it("is `other` for a non-canonical token and `none` for absent/empty (never faked GOOD)", () => {
    expect(qualityBucket("STALE")).toBe("other");
    expect(qualityBucket(undefined)).toBe("none");
    expect(qualityBucket("")).toBe("none");
    expect(qualityBucket("   ")).toBe("none");
  });
});

describe("formatSignalValue", () => {
  it("formats numbers compactly (integers bare, else <=2 decimals)", () => {
    expect(formatSignalValue(310)).toBe("310");
    expect(formatSignalValue(72.4)).toBe("72.4");
    expect(formatSignalValue(4.126)).toBe("4.13");
  });
  it("returns undefined (an em dash upstream) for value-less / non-finite samples", () => {
    expect(formatSignalValue(null)).toBeUndefined();
    expect(formatSignalValue(undefined)).toBeUndefined();
    expect(formatSignalValue("")).toBeUndefined();
    expect(formatSignalValue(Number.NaN)).toBeUndefined();
    expect(formatSignalValue(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
  it("shows booleans / strings verbatim and objects as compact JSON", () => {
    expect(formatSignalValue(true)).toBe("true");
    expect(formatSignalValue("ON")).toBe("ON");
    expect(formatSignalValue({ x: 1 })).toBe('{"x":1}');
  });
  it("ellipsizes long strings", () => {
    expect(formatSignalValue("x".repeat(60), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("signalSeries (sparkline input)", () => {
  it("keeps only numeric samples, ascending time", () => {
    const points = [
      { at: 1, value: 10 },
      { at: 2, value: null },
      { at: 3, value: 12 },
      { at: 4, value: "bad" },
    ];
    expect(toSparkSeries(points)).toEqual([
      { at: 1, value: 10 },
      { at: 3, value: 12 },
    ]);
  });
  it("yields [] for an all-non-numeric series (no sparkline, honestly)", () => {
    expect(toSparkSeries(signalPoints([]).concat([{ at: 1, value: null }]))).toEqual([]);
  });
});

describe("signalRow / signalRows", () => {
  it("projects a series to a row with a stable id, quality bucket, and value", () => {
    const row = signalRow(
      signalSeries(key("gw-01", "opcua-adapter"), "Temp", {
        latest: 72.4,
        quality: "GOOD",
        points: signalPoints([70, 71, 72.4], { quality: "GOOD" }),
      }),
    );
    expect(row.id).toBe("gw-01/opcua-adapter/main Temp");
    expect(row.componentId).toBe("gw-01/opcua-adapter");
    expect(row.device).toBe("gw-01");
    expect(row.signal).toBe("Temp");
    expect(row.value).toBe("72.4");
    expect(row.qualityBucket).toBe("good");
    expect(row.series).toHaveLength(3);
  });

  it("a value-less BAD signal has no value and an empty sparkline series", () => {
    const row = signalRow(
      signalSeries(key("gw-02", "opcua-adapter"), "Flow_A", {
        latest: null,
        quality: "BAD",
        points: [{ at: 1, value: null, quality: "BAD" }],
      }),
    );
    expect(row.value).toBeUndefined();
    expect(row.qualityBucket).toBe("bad");
    expect(row.series).toEqual([]);
  });

  it("maps a whole list", () => {
    const rows = signalRows([
      signalSeries(key("gw-01", "a"), "s1"),
      signalSeries(key("gw-01", "a"), "s2"),
    ]);
    expect(rows.map((r) => r.signal)).toEqual(["s1", "s2"]);
  });
});

describe("filterSignalRows / signalComponentIds", () => {
  const rows = signalRows([
    signalSeries(key("press-gw-01", "opcua-adapter"), "Temp_01"),
    signalSeries(key("press-gw-01", "opcua-adapter"), "Pressure"),
    signalSeries(key("pack-gw-01", "modbus-adapter"), "conveyor_speed"),
  ]);

  it("filters by free-text query across signal + component id (case-insensitive)", () => {
    expect(filterSignalRows(rows, { query: "temp" }).map((r) => r.signal)).toEqual(["Temp_01"]);
    expect(filterSignalRows(rows, { query: "PACK" }).map((r) => r.signal)).toEqual([
      "conveyor_speed",
    ]);
    expect(filterSignalRows(rows, { query: "  " })).toHaveLength(3); // blank query = no filter
  });

  it("scopes by component id", () => {
    expect(
      filterSignalRows(rows, { componentId: "press-gw-01/opcua-adapter" }).map((r) => r.signal),
    ).toEqual(["Temp_01", "Pressure"]);
  });

  it("AND-combines query + scope", () => {
    expect(
      filterSignalRows(rows, {
        componentId: "press-gw-01/opcua-adapter",
        query: "pressure",
      }).map((r) => r.signal),
    ).toEqual(["Pressure"]);
  });

  it("lists the distinct component ids, sorted", () => {
    expect(signalComponentIds(rows)).toEqual([
      "pack-gw-01/modbus-adapter",
      "press-gw-01/opcua-adapter",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLLAPSE_THRESHOLD,
  LAG_WARN_MS,
  NO_PATH_LABEL,
  SignalRateMeter,
  UNKNOWN_SOURCE_LABEL,
  cascadeComponentScope,
  componentDeviceOf,
  componentOwnedByDevice,
  filterSignalRows,
  formatSignalValue,
  groupSignals,
  qualityBucket,
  qualityCounts,
  signalComponentIds,
  signalComponentOptions,
  signalDevices,
  signalLagMs,
  signalRow,
  signalRows,
  signalSeries as toSparkSeries,
  signalStats,
  valueKind,
} from "../src/signals/selectors";
import { key, signalPoints, signalSeries } from "./_fixtures";

describe("qualityBucket", () => {
  it("maps the canonical tokens case-insensitively; other/none never faked GOOD", () => {
    expect(qualityBucket("GOOD")).toBe("good");
    expect(qualityBucket(" Uncertain ")).toBe("uncertain");
    expect(qualityBucket("BAD")).toBe("bad");
    expect(qualityBucket("STALE")).toBe("other");
    expect(qualityBucket(undefined)).toBe("none");
    expect(qualityBucket("")).toBe("none");
  });
});

describe("valueKind", () => {
  it("classifies the latest value for display typography", () => {
    expect(valueKind(63.4)).toBe("number");
    expect(valueKind(Number.NaN)).toBe("none");
    expect(valueKind(true)).toBe("boolean");
    expect(valueKind("ON")).toBe("string");
    expect(valueKind("")).toBe("none");
    expect(valueKind(null)).toBe("none");
    expect(valueKind({ x: 1 })).toBe("json");
  });
});

describe("formatSignalValue", () => {
  it("formats numbers / booleans / strings / objects; value-less ⇒ undefined", () => {
    expect(formatSignalValue(310)).toBe("310");
    expect(formatSignalValue(4.126)).toBe("4.13");
    expect(formatSignalValue(true)).toBe("true");
    expect(formatSignalValue("ON")).toBe("ON");
    expect(formatSignalValue({ x: 1 })).toBe('{"x":1}');
    expect(formatSignalValue(null)).toBeUndefined();
    expect(formatSignalValue("")).toBeUndefined();
    expect(formatSignalValue(Number.NaN)).toBeUndefined();
  });
});

describe("signalSeries + signalStats", () => {
  it("keeps only numeric samples for the sparkline", () => {
    expect(
      toSparkSeries([
        { at: 1, value: 10 },
        { at: 2, value: null },
        { at: 3, value: 12 },
        { at: 4, value: "bad" },
      ]),
    ).toEqual([
      { at: 1, value: 10 },
      { at: 3, value: 12 },
    ]);
  });
  it("computes min/max/avg/Δ over the numeric series (undefined when empty)", () => {
    const stats = signalStats([
      { at: 1, value: 48.9 },
      { at: 2, value: 55 },
      { at: 3, value: 63.4 },
    ])!;
    expect(stats.min).toBe(48.9);
    expect(stats.max).toBe(63.4);
    expect(stats.avg).toBeCloseTo(55.766, 2);
    expect(stats.delta).toBeCloseTo(14.5, 5);
    expect(signalStats([])).toBeUndefined();
  });
});

describe("signalLagMs (verbatim pair — WP-G)", () => {
  const PUB = "2026-07-10T14:32:07.992Z";
  const SRC = "2026-07-10T14:32:07.812Z"; // measured
  const SRV = "2026-07-10T14:32:07.940Z"; // server refresh

  it("OPC-UA-like (full pair): lag = publishedTs − sourceTs (sourceTs wins over serverTs)", () => {
    expect(signalLagMs(PUB, SRC, SRV)).toBe(180);
  });
  it("Modbus-like (serverTs only): lag = publishedTs − serverTs", () => {
    expect(signalLagMs(PUB, undefined, SRV)).toBe(52);
    expect(signalLagMs("2026-07-10T14:32:15.100Z", undefined, "2026-07-10T14:32:06.800Z")).toBe(8300);
  });
  it("legacy (neither verbatim timestamp) ⇒ undefined — an honest 'lag —', never a fabricated 0", () => {
    expect(signalLagMs(PUB, undefined, undefined)).toBeUndefined();
    expect(signalLagMs(PUB)).toBeUndefined();
  });
  it("absent publishedTs / unparseable used pair ⇒ undefined", () => {
    expect(signalLagMs(undefined, SRC, SRV)).toBeUndefined();
    expect(signalLagMs("not-a-date", SRC)).toBeUndefined();
    expect(signalLagMs(PUB, "not-a-date", SRV)).toBeUndefined(); // sourceTs is the used side
  });
  it("the 8.3 s lag is over the 5 s warn threshold; 0.18 s is under", () => {
    expect(signalLagMs("2026-07-10T14:32:15.100Z", undefined, "2026-07-10T14:32:06.800Z")! >= LAG_WARN_MS).toBe(true);
    expect(signalLagMs(PUB, SRC)! >= LAG_WARN_MS).toBe(false);
  });
});

describe("signalRow", () => {
  it("projects path/leaf/channel, R5 metadata, lag, and value kind", () => {
    const row = signalRow(
      signalSeries(key("dal-line1-gw", "opcua-adapter"), "filler/tank_level", {
        latest: 63.4,
        quality: "GOOD",
        name: "Filler Tank Level",
        signalId: "ns=3;i=1021",
        adapter: "opcua",
        endpoint: "opc.tcp://kep:49320",
        qualityRaw: "Good (0x0)",
        sourceTs: "2026-07-10T14:32:07.812Z",
        serverTs: "2026-07-10T14:32:07.940Z",
        publishedTs: "2026-07-10T14:32:07.992Z",
        points: signalPoints([61, 62, 63.4], { quality: "GOOD" }),
      }),
    );
    expect(row.id).toBe("dal-line1-gw/opcua-adapter/main filler/tank_level");
    expect(row.pathSegment).toBe("filler");
    expect(row.leaf).toBe("tank_level");
    expect(row.channel).toBe("data/filler/tank_level");
    expect(row.name).toBe("Filler Tank Level");
    expect(row.signalId).toBe("ns=3;i=1021");
    expect(row.valueKind).toBe("number");
    expect(row.sourceTs).toBe("2026-07-10T14:32:07.812Z"); // verbatim, no fold
    expect(row.serverTs).toBe("2026-07-10T14:32:07.940Z");
    expect(row.lagMs).toBe(180); // published − sourceTs (measured wins)
    expect(row.pointCount).toBe(3);
    expect(row.series).toHaveLength(3);
  });

  it("a Modbus-like series (serverTs only) computes lag from serverTs", () => {
    const row = signalRow(
      signalSeries(key("gw", "modbus-adapter"), "line/speed", {
        latest: 612,
        serverTs: "2026-07-10T14:32:07.940Z",
        publishedTs: "2026-07-10T14:32:07.992Z",
      }),
    );
    expect(row.sourceTs).toBeUndefined();
    expect(row.serverTs).toBe("2026-07-10T14:32:07.940Z");
    expect(row.lagMs).toBe(52);
  });

  it("a pathless legacy signal: no pathSegment, no verbatim pair, no lag — even with the folded compat field", () => {
    const row = signalRow(
      signalSeries(key("gw", "a"), "loose", {
        latest: 1,
        // The folded compat field (which falls back to the envelope header) must NOT drive lag.
        sourceTimestamp: "2026-07-10T14:32:07.992Z",
        publishedTs: "2026-07-10T14:32:07.992Z",
      }),
    );
    expect(row.pathSegment).toBeUndefined();
    expect(row.leaf).toBe("loose");
    expect(row.sourceTs).toBeUndefined();
    expect(row.serverTs).toBeUndefined();
    expect(row.lagMs).toBeUndefined(); // honest "lag —", not a fabricated 0
    expect(row.name).toBeUndefined(); // legacy publisher — no invented label
  });
});

describe("filterSignalRows", () => {
  const rows = signalRows([
    signalSeries(key("press-gw-01", "opcua-adapter"), "filler/Temp_01", { quality: "GOOD" }),
    signalSeries(key("press-gw-01", "opcua-adapter"), "filler/Pressure", { quality: "UNCERTAIN" }),
    signalSeries(key("pack-gw-01", "modbus-adapter"), "line/conveyor_speed", { quality: "GOOD" }),
  ]);

  it("filters by device, component, quality, and free-text (AND-combined)", () => {
    expect(filterSignalRows(rows, { deviceId: "pack-gw-01" }).map((r) => r.signal)).toEqual(["line/conveyor_speed"]);
    expect(filterSignalRows(rows, { componentId: "press-gw-01/opcua-adapter" })).toHaveLength(2);
    expect(filterSignalRows(rows, { quality: "uncertain" }).map((r) => r.signal)).toEqual(["filler/Pressure"]);
    expect(filterSignalRows(rows, { query: "temp" }).map((r) => r.signal)).toEqual(["filler/Temp_01"]);
    expect(
      filterSignalRows(rows, { componentId: "press-gw-01/opcua-adapter", quality: "good" }).map((r) => r.signal),
    ).toEqual(["filler/Temp_01"]);
  });

  it("search matches name / signal id too", () => {
    const named = signalRows([
      signalSeries(key("gw", "a"), "x/y", { name: "Filler Tank Level", signalId: "ns=3;i=1021" }),
    ]);
    expect(filterSignalRows(named, { query: "tank" })).toHaveLength(1);
    expect(filterSignalRows(named, { query: "i=1021" })).toHaveLength(1);
  });
});

describe("device / component cascade", () => {
  const rows = signalRows([
    signalSeries(key("dal-line1-gw", "opcua-adapter"), "a"),
    signalSeries(key("dal-line1-gw", "modbus-adapter"), "b"),
    signalSeries(key("dal-chiller-gw", "modbus-adapter"), "c"),
  ]);

  it("lists distinct devices sorted", () => {
    expect(signalDevices(rows)).toEqual(["dal-chiller-gw", "dal-line1-gw"]);
  });

  it("narrows + short-labels component options for a selected device", () => {
    expect(signalComponentOptions(rows).map((o) => o.label)).toEqual([
      "dal-chiller-gw/modbus-adapter",
      "dal-line1-gw/modbus-adapter",
      "dal-line1-gw/opcua-adapter",
    ]);
    expect(signalComponentOptions(rows, "dal-line1-gw")).toEqual([
      { id: "dal-line1-gw/modbus-adapter", label: "modbus-adapter" },
      { id: "dal-line1-gw/opcua-adapter", label: "opcua-adapter" },
    ]);
  });

  it("ownership + cascade reset: a component not owned by the new device resets to All", () => {
    expect(componentDeviceOf("dal-line1-gw/opcua-adapter")).toBe("dal-line1-gw");
    expect(componentOwnedByDevice("dal-line1-gw/opcua-adapter", "dal-line1-gw")).toBe(true);
    expect(componentOwnedByDevice("dal-line1-gw/opcua-adapter", "dal-chiller-gw")).toBe(false);
    // keep when still owned / when selecting All devices; reset when the device changes away.
    expect(cascadeComponentScope("dal-line1-gw/opcua-adapter", "dal-line1-gw")).toBe("dal-line1-gw/opcua-adapter");
    expect(cascadeComponentScope("dal-line1-gw/opcua-adapter", undefined)).toBe("dal-line1-gw/opcua-adapter");
    expect(cascadeComponentScope("dal-line1-gw/opcua-adapter", "dal-chiller-gw")).toBeUndefined();
    expect(cascadeComponentScope(undefined, "dal-line1-gw")).toBeUndefined();
  });
});

describe("qualityCounts", () => {
  it("tallies each bucket; `all` is the true total (other rows included)", () => {
    const rows = signalRows([
      signalSeries(key("gw", "a"), "s1", { quality: "GOOD" }),
      signalSeries(key("gw", "a"), "s2", { quality: "GOOD" }),
      signalSeries(key("gw", "a"), "s3", { quality: "UNCERTAIN" }),
      signalSeries(key("gw", "a"), "s4", { quality: "BAD" }),
      signalSeries(key("gw", "a"), "s5", { quality: "STALE" }), // non-canonical ⇒ other
      signalSeries(key("gw", "a"), "s6"), // no quality
    ]);
    expect(qualityCounts(rows)).toEqual({ all: 6, good: 2, uncertain: 1, bad: 1, other: 1, none: 1 });
  });
});

describe("groupSignals", () => {
  function bigPathRows() {
    return signalRows([
      signalSeries(key("gw", "a"), "filler/l1", { quality: "GOOD", receivedAt: 1000 }),
      signalSeries(key("gw", "a"), "filler/l2", { quality: "GOOD", receivedAt: 5000 }),
      signalSeries(key("gw", "a"), "carbo/c1", { quality: "BAD", qualityRaw: "GW_FAILED", name: "CO₂ Header", receivedAt: 2000 }),
      signalSeries(key("gw", "a"), "carbo/c2", { quality: "GOOD", receivedAt: 2500 }),
      signalSeries(key("gw", "a"), "chiller/x", { quality: "UNCERTAIN", name: "Glycol Temp", qualityRaw: "STALE_READ", receivedAt: 3000 }),
      signalSeries(key("gw", "a"), "leaf_only", { quality: "GOOD", receivedAt: 100 }),
    ]);
  }

  it("groups by first path segment, folds pathless into a trailing (no path), sorts the rest by label", () => {
    const groups = groupSignals(bigPathRows(), "path");
    expect(groups.map((g) => g.label)).toEqual(["carbo/", "chiller/", "filler/", NO_PATH_LABEL]);
    expect(groups.at(-1)!.fold).toBe(true);
  });

  it("collapses every group by default once the page holds more than 5 signals", () => {
    const many = groupSignals(bigPathRows(), "path"); // 6 rows > 5
    expect(many.every((g) => g.defaultCollapsed)).toBe(true);
    const few = groupSignals(bigPathRows().slice(0, 3), "path"); // 3 rows ≤ 5
    expect(few.every((g) => g.defaultCollapsed)).toBe(false);
    expect(DEFAULT_COLLAPSE_THRESHOLD).toBe(5);
  });

  it("rollups: bad/uncertain counts, worst offender, freshest receipt", () => {
    const groups = groupSignals(bigPathRows(), "path");
    const carbo = groups.find((g) => g.label === "carbo/")!;
    expect(carbo.bad).toBe(1);
    expect(carbo.worstBad).toEqual({ label: "CO₂ Header", raw: "GW_FAILED" });
    expect(carbo.freshestAt).toBe(2500);
    const chiller = groups.find((g) => g.label === "chiller/")!;
    expect(chiller.uncertain).toBe(1);
    expect(chiller.worstUncertain).toEqual({ label: "Glycol Temp", raw: "STALE_READ" });
  });

  it("Source axis folds adapterless series into (unknown source); pair-labels the rest", () => {
    const rows = signalRows([
      signalSeries(key("gw", "a"), "s1", { adapter: "opcua", endpoint: "opc.tcp://kep" }),
      signalSeries(key("gw", "a"), "s2", { adapter: "modbus" }),
      signalSeries(key("gw", "a"), "s3"), // no adapter
    ]);
    const groups = groupSignals(rows, "source");
    expect(groups.map((g) => g.label)).toEqual(["modbus", "opcua · opc.tcp://kep", UNKNOWN_SOURCE_LABEL]);
    expect(groups.at(-1)!.fold).toBe(true);
  });

  it("None axis yields one headerless, never-collapsed group", () => {
    const groups = groupSignals(bigPathRows(), "none");
    expect(groups).toHaveLength(1);
    expect(groups[0]!.headerless).toBe(true);
    expect(groups[0]!.defaultCollapsed).toBe(false);
    expect(groups[0]!.count).toBe(6);
  });

  it("Component axis groups by component id", () => {
    const rows = signalRows([
      signalSeries(key("gw", "opcua-adapter"), "s1"),
      signalSeries(key("gw", "modbus-adapter"), "s2"),
    ]);
    expect(groupSignals(rows, "component").map((g) => g.label)).toEqual(["gw/modbus-adapter", "gw/opcua-adapter"]);
  });

  it("signalComponentIds lists distinct ids sorted", () => {
    expect(signalComponentIds(bigPathRows())).toEqual(["gw/a"]);
  });
});

describe("SignalRateMeter", () => {
  it("sums a group's live arrivals over the 10 s window, to one decimal", () => {
    const meter = new SignalRateMeter(10_000);
    // 8 arrivals for s1 + 2 for s2 in the window ⇒ 10 msgs / 10 s = 1.0 msg/s across both.
    for (let i = 0; i < 8; i++) meter.record("s1", 1, 1000 + i * 100);
    meter.record("s2", 2, 1500);
    expect(meter.ratePerSec(["s1", "s2"], 2000)).toBe(1.0);
    // A single series' rate is just its own arrivals.
    expect(meter.ratePerSec(["s2"], 2000)).toBe(0.2);
    // An unseen series contributes nothing.
    expect(meter.ratePerSec(["nope"], 2000)).toBe(0);
  });

  it("drops arrivals outside the window (and prune bounds memory)", () => {
    const meter = new SignalRateMeter(10_000);
    meter.record("s1", 5, 1000);
    meter.record("s1", 5, 20_000); // fresh
    // At now=25_000 only the second batch is within [15_000, 25_000].
    expect(meter.ratePerSec(["s1"], 25_000)).toBe(0.5);
    meter.prune(25_000);
    expect(meter.ratePerSec(["s1"], 25_000)).toBe(0.5); // prune keeps the in-window batch
    meter.prune(40_000);
    expect(meter.ratePerSec(["s1"], 40_000)).toBe(0); // everything aged out
  });
});

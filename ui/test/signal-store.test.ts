import { describe, expect, it } from "vitest";
import { componentKeyId } from "@edgecommons/edge-console-protocol";
import type { SignalSeriesUpdate } from "@edgecommons/edge-console-protocol";
import { SignalStore } from "../src/fleet/signal-store";
import { T0, key, signalPoints, signalSeries } from "./_fixtures";

describe("SignalStore (browser fold)", () => {
  it("starts empty and stays identity-stable until it changes", () => {
    const store = new SignalStore();
    const v1 = store.view();
    expect(v1.series).toEqual([]);
    expect(store.view()).toBe(v1); // cached identity
    expect(store.seriesCount()).toBe(0);
  });

  it("replaces the whole surface on a snapshot, sorted by component id then signal", () => {
    const store = new SignalStore();
    store.applySnapshot([
      signalSeries(key("gw-01", "opcua-adapter"), "Pressure", { latest: 4.1, quality: "UNCERTAIN" }),
      signalSeries(key("gw-01", "opcua-adapter"), "Temp", { latest: 72.4, quality: "GOOD" }),
      signalSeries(key("gw-02", "modbus-adapter"), "flow", { latest: 3, quality: "GOOD" }),
    ]);
    const v = store.view();
    // Sorted: gw-01/opcua/Pressure, gw-01/opcua/Temp, gw-02/modbus/flow.
    expect(v.series.map((s) => `${componentKeyId(s.key)}/${s.signal}`)).toEqual([
      "gw-01/opcua-adapter/Pressure",
      "gw-01/opcua-adapter/Temp",
      "gw-02/modbus-adapter/flow",
    ]);
    expect(store.get(key("gw-01", "opcua-adapter"), "Temp")!.latest).toBe(72.4);
    expect(store.get(key("gw-01", "opcua-adapter"), "missing")).toBeUndefined();

    // A second snapshot fully replaces (drops the previous set).
    store.applySnapshot([signalSeries(key("gw-03", "x"), "s", { latest: 1 })]);
    expect(store.view().series).toHaveLength(1);
    expect(store.seriesCount()).toBe(1);
  });

  it("does not alias the incoming frame (fold owns its own copies)", () => {
    const store = new SignalStore();
    const src = signalSeries(key("gw-01", "a"), "s", { points: signalPoints([1, 2]) });
    store.applySnapshot([src]);
    // Mutating the source array/point after the fold must not change the store.
    src.points!.push({ at: T0 + 99, value: 999 });
    expect(store.get(key("gw-01", "a"), "s")!.points).toHaveLength(2);
  });

  it("appends a live point to an existing series (latest-wins on value/quality/receipt)", () => {
    const store = new SignalStore();
    store.applySnapshot([
      signalSeries(key("gw-01", "a"), "s", { points: signalPoints([10], { quality: "GOOD" }) }),
    ]);
    const before = store.view();

    const update: SignalSeriesUpdate = {
      key: key("gw-01", "a"),
      instance: "main", signal: "s",
      point: { at: T0 + 5000, value: 22, quality: "UNCERTAIN" },
      sourceTimestamp: "2026-07-04T00:00:05.000Z",
    };
    store.applyUpdates([update]);

    const after = store.view();
    expect(after).not.toBe(before); // version bumped
    const s = store.get(key("gw-01", "a"), "s")!;
    expect(s.latest).toBe(22);
    expect(s.quality).toBe("UNCERTAIN");
    expect(s.receivedAt).toBe(T0 + 5000);
    expect(s.sourceTimestamp).toBe("2026-07-04T00:00:05.000Z");
    expect(s.points).toHaveLength(2);
  });

  it("creates a brand-new series from a live update (no prior snapshot entry)", () => {
    const store = new SignalStore();
    store.applyUpdates([
      { key: key("gw-01", "a"), instance: "main", signal: "fresh", point: { at: T0, value: 7 } },
    ]);
    const s = store.get(key("gw-01", "a"), "fresh")!;
    expect(s.latest).toBe(7);
    expect(s.points).toEqual([{ at: T0, value: 7 }]);
    expect(s.quality).toBeUndefined();
  });

  it("clears a stale quality/sourceTimestamp when a later point omits it", () => {
    const store = new SignalStore();
    store.applyUpdates([
      { key: key("gw-01", "a"), instance: "main", signal: "s", point: { at: T0, value: 1, quality: "GOOD" }, sourceTimestamp: "x" },
    ]);
    expect(store.get(key("gw-01", "a"), "s")!.quality).toBe("GOOD");
    store.applyUpdates([{ key: key("gw-01", "a"), instance: "main", signal: "s", point: { at: T0 + 1, value: 2 } }]);
    const s = store.get(key("gw-01", "a"), "s")!;
    expect(s.quality).toBeUndefined();
    expect(s.sourceTimestamp).toBeUndefined();
  });

  it("bounds the recent series drop-oldest at maxSeriesPoints", () => {
    const store = new SignalStore({ maxSeriesPoints: 3 });
    for (let i = 0; i < 6; i++) {
      store.applyUpdates([{ key: key("gw-01", "a"), instance: "main", signal: "s", point: { at: T0 + i, value: i } }]);
    }
    const s = store.get(key("gw-01", "a"), "s")!;
    expect(s.points!.map((p) => p.value)).toEqual([3, 4, 5]); // oldest three dropped
    expect(s.latest).toBe(5);
  });

  it("caps distinct series and counts the overflow", () => {
    const store = new SignalStore({ maxSeries: 2 });
    store.applyUpdates([
      { key: key("gw-01", "a"), instance: "main", signal: "s1", point: { at: T0, value: 1 } },
      { key: key("gw-01", "a"), instance: "main", signal: "s2", point: { at: T0, value: 2 } },
      { key: key("gw-01", "a"), instance: "main", signal: "s3", point: { at: T0, value: 3 } }, // dropped
    ]);
    expect(store.seriesCount()).toBe(2);
    expect(store.droppedSeries()).toBe(1);
    // Existing series keep updating even at the cap.
    store.applyUpdates([{ key: key("gw-01", "a"), instance: "main", signal: "s1", point: { at: T0 + 1, value: 11 } }]);
    expect(store.get(key("gw-01", "a"), "s1")!.latest).toBe(11);
  });

  it("an empty update batch is a no-op (no version churn)", () => {
    const store = new SignalStore();
    store.applySnapshot([signalSeries(key("gw-01", "a"), "s")]);
    const v = store.view();
    store.applyUpdates([]);
    expect(store.view()).toBe(v);
  });

  it("folds a summary-mode series (no `points` key) into an empty ring that live samples grow", () => {
    const store = new SignalStore();
    // A summary snapshot omits `points` entirely (latest + metadata only).
    const summary = signalSeries(key("gw-01", "a"), "s", { latest: 5, quality: "GOOD" });
    delete (summary as { points?: unknown }).points;
    store.applySnapshot([summary]);
    const s0 = store.get(key("gw-01", "a"), "s")!;
    expect(s0.points).toEqual([]); // point-less until backfill / live
    expect(s0.latest).toBe(5);

    store.applyUpdates([
      { key: key("gw-01", "a"), instance: "main", signal: "s", point: { at: T0 + 1, value: 6 } },
    ]);
    expect(store.get(key("gw-01", "a"), "s")!.points).toHaveLength(1);
  });

  it("backfills a series' points via applyPoints (bounded, unknown series ignored)", () => {
    const store = new SignalStore({ maxSeriesPoints: 3 });
    store.applySnapshot([signalSeries(key("gw-01", "a"), "s", { latest: 9 })]);
    store.applyPoints([
      {
        key: key("gw-01", "a"),
        instance: "main",
        signal: "s",
        points: signalPoints([1, 2, 3, 4]), // over the cap → newest three kept
      },
      // A series the store has never seen is silently ignored (no phantom series).
      { key: key("gw-02", "z"), instance: "main", signal: "missing", points: signalPoints([1]) },
    ]);
    expect(store.get(key("gw-01", "a"), "s")!.points!.map((p) => p.value)).toEqual([2, 3, 4]);
    expect(store.get(key("gw-02", "z"), "missing")).toBeUndefined();
    expect(store.seriesCount()).toBe(1);
  });

  it("carries R5 series metadata + latest-wins publishedTs / name / signalId", () => {
    const store = new SignalStore();
    store.applySnapshot([
      signalSeries(key("gw-01", "opcua-adapter"), "filler/level", {
        latest: 63.4,
        quality: "GOOD",
        name: "Filler Tank Level",
        signalId: "ns=3;i=1021",
        address: { ns: 3, nodeId: "ns=3;i=1021" },
        adapter: "opcua",
        endpoint: "opc.tcp://kep:49320",
        qualityRaw: "Good (0x0)",
        publishedTs: "2026-07-10T14:32:07.992Z",
      }),
    ]);
    const s = store.get(key("gw-01", "opcua-adapter"), "filler/level")!;
    expect(s.name).toBe("Filler Tank Level");
    expect(s.signalId).toBe("ns=3;i=1021");
    expect(s.adapter).toBe("opcua");
    expect(s.publishedTs).toBe("2026-07-10T14:32:07.992Z");

    // A relabelling update overwrites name/signalId/publishedTs; a plain update keeps the label.
    store.applyUpdates([
      {
        key: key("gw-01", "opcua-adapter"),
        instance: "main",
        signal: "filler/level",
        point: { at: T0 + 1, value: 64 },
        publishedTs: "2026-07-10T14:32:09.000Z",
        name: "Filler Level",
        signalId: "ns=3;i=2000",
      },
    ]);
    const relabelled = store.get(key("gw-01", "opcua-adapter"), "filler/level")!;
    expect(relabelled.name).toBe("Filler Level");
    expect(relabelled.signalId).toBe("ns=3;i=2000");
    expect(relabelled.publishedTs).toBe("2026-07-10T14:32:09.000Z");

    store.applyUpdates([
      { key: key("gw-01", "opcua-adapter"), instance: "main", signal: "filler/level", point: { at: T0 + 2, value: 65 } },
    ]);
    const kept = store.get(key("gw-01", "opcua-adapter"), "filler/level")!;
    expect(kept.name).toBe("Filler Level"); // label persists when a batch omits it
    expect(kept.signalId).toBe("ns=3;i=2000");
  });

  it("folds the WP-G verbatim sourceTs/serverTs pair: snapshot carry + set-or-cleared per live point", () => {
    const store = new SignalStore();
    // Snapshot carries the series-level verbatim pair.
    store.applySnapshot([
      signalSeries(key("gw-01", "opcua-adapter"), "filler/level", {
        latest: 63.4,
        sourceTs: "2026-07-10T14:32:07.812Z",
        serverTs: "2026-07-10T14:32:07.940Z",
      }),
    ]);
    let s = store.get(key("gw-01", "opcua-adapter"), "filler/level")!;
    expect(s.sourceTs).toBe("2026-07-10T14:32:07.812Z");
    expect(s.serverTs).toBe("2026-07-10T14:32:07.940Z");

    // A Modbus-like live point (serverTs only): series sourceTs is CLEARED, serverTs replaced —
    // per-sample facts (set-or-cleared), unlike the latest-wins identity metadata.
    store.applyUpdates([
      {
        key: key("gw-01", "opcua-adapter"),
        instance: "main",
        signal: "filler/level",
        point: { at: T0 + 1, value: 64, serverTs: "2026-07-10T14:32:09.500Z" },
      },
    ]);
    s = store.get(key("gw-01", "opcua-adapter"), "filler/level")!;
    expect(s.sourceTs).toBeUndefined();
    expect(s.serverTs).toBe("2026-07-10T14:32:09.500Z");
    // The point itself carries the verbatim value too.
    expect(s.points!.at(-1)).toEqual({ at: T0 + 1, value: 64, serverTs: "2026-07-10T14:32:09.500Z" });

    // A legacy live point (neither): both series fields cleared.
    store.applyUpdates([
      { key: key("gw-01", "opcua-adapter"), instance: "main", signal: "filler/level", point: { at: T0 + 2, value: 65 } },
    ]);
    s = store.get(key("gw-01", "opcua-adapter"), "filler/level")!;
    expect(s.sourceTs).toBeUndefined();
    expect(s.serverTs).toBeUndefined();
  });
});

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
      "gw-01/opcua-adapter/main/Pressure",
      "gw-01/opcua-adapter/main/Temp",
      "gw-02/modbus-adapter/main/flow",
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
    src.points.push({ at: T0 + 99, value: 999 });
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
      signal: "s",
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
      { key: key("gw-01", "a"), signal: "fresh", point: { at: T0, value: 7 } },
    ]);
    const s = store.get(key("gw-01", "a"), "fresh")!;
    expect(s.latest).toBe(7);
    expect(s.points).toEqual([{ at: T0, value: 7 }]);
    expect(s.quality).toBeUndefined();
  });

  it("clears a stale quality/sourceTimestamp when a later point omits it", () => {
    const store = new SignalStore();
    store.applyUpdates([
      { key: key("gw-01", "a"), signal: "s", point: { at: T0, value: 1, quality: "GOOD" }, sourceTimestamp: "x" },
    ]);
    expect(store.get(key("gw-01", "a"), "s")!.quality).toBe("GOOD");
    store.applyUpdates([{ key: key("gw-01", "a"), signal: "s", point: { at: T0 + 1, value: 2 } }]);
    const s = store.get(key("gw-01", "a"), "s")!;
    expect(s.quality).toBeUndefined();
    expect(s.sourceTimestamp).toBeUndefined();
  });

  it("bounds the recent series drop-oldest at maxSeriesPoints", () => {
    const store = new SignalStore({ maxSeriesPoints: 3 });
    for (let i = 0; i < 6; i++) {
      store.applyUpdates([{ key: key("gw-01", "a"), signal: "s", point: { at: T0 + i, value: i } }]);
    }
    const s = store.get(key("gw-01", "a"), "s")!;
    expect(s.points.map((p) => p.value)).toEqual([3, 4, 5]); // oldest three dropped
    expect(s.latest).toBe(5);
  });

  it("caps distinct series and counts the overflow", () => {
    const store = new SignalStore({ maxSeries: 2 });
    store.applyUpdates([
      { key: key("gw-01", "a"), signal: "s1", point: { at: T0, value: 1 } },
      { key: key("gw-01", "a"), signal: "s2", point: { at: T0, value: 2 } },
      { key: key("gw-01", "a"), signal: "s3", point: { at: T0, value: 3 } }, // dropped
    ]);
    expect(store.seriesCount()).toBe(2);
    expect(store.droppedSeries()).toBe(1);
    // Existing series keep updating even at the cap.
    store.applyUpdates([{ key: key("gw-01", "a"), signal: "s1", point: { at: T0 + 1, value: 11 } }]);
    expect(store.get(key("gw-01", "a"), "s1")!.latest).toBe(11);
  });

  it("an empty update batch is a no-op (no version churn)", () => {
    const store = new SignalStore();
    store.applySnapshot([signalSeries(key("gw-01", "a"), "s")]);
    const v = store.view();
    store.applyUpdates([]);
    expect(store.view()).toBe(v);
  });
});

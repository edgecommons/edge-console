import { describe, expect, it } from "vitest";
import { componentKeyId } from "@edgecommons/edge-console-protocol";
import type { MetricSeriesUpdate } from "@edgecommons/edge-console-protocol";
import { MetricStore } from "../src/fleet/metric-store";
import { T0, key, metricPoints, metricSeries } from "./_fixtures";

describe("MetricStore (browser fold)", () => {
  it("starts empty and stays identity-stable until it changes", () => {
    const store = new MetricStore();
    const v1 = store.view();
    expect(v1.series).toEqual([]);
    expect(store.view()).toBe(v1);
    expect(store.seriesCount()).toBe(0);
  });

  it("replaces the whole surface on a snapshot, sorted by component, instance, metric, measure", () => {
    const store = new MetricStore();
    store.applySnapshot([
      metricSeries(key("gw-01", "opcua-adapter"), "packaging.throughput", "bottlesPerMin", { latest: 4.1 }),
      metricSeries(key("gw-01", "opcua-adapter"), "packaging.throughput", "rejects", { latest: 1 }),
      metricSeries(key("gw-02", "modbus-adapter"), "energy", "kw", { latest: 3 }),
    ]);
    const v = store.view();
    expect(v.series.map((s) => `${componentKeyId(s.key)}/${s.instance}/${s.metric}/${s.measure}`)).toEqual([
      "gw-01/opcua-adapter/main/packaging.throughput/bottlesPerMin",
      "gw-01/opcua-adapter/main/packaging.throughput/rejects",
      "gw-02/modbus-adapter/main/energy/kw",
    ]);
    expect(store.get(key("gw-01", "opcua-adapter"), "packaging.throughput", "rejects")!.latest).toBe(1);

    store.applySnapshot([metricSeries(key("gw-03", "x"), "m", "value", { latest: 9 })]);
    expect(store.view().series).toHaveLength(1);
    expect(store.seriesCount()).toBe(1);
  });

  it("does not alias the incoming frame", () => {
    const store = new MetricStore();
    const src = metricSeries(key("gw-01", "a"), "m", "value", { points: metricPoints([1, 2]) });
    store.applySnapshot([src]);
    src.points.push({ at: T0 + 99, value: 999 });
    expect(store.get(key("gw-01", "a"), "m", "value")!.points).toHaveLength(2);
  });

  it("appends a live point to an existing series", () => {
    const store = new MetricStore();
    store.applySnapshot([metricSeries(key("gw-01", "a"), "m", "value", { points: metricPoints([10]) })]);
    const before = store.view();

    const update: MetricSeriesUpdate = {
      key: key("gw-01", "a"),
      instance: "main",
      metric: "m",
      measure: "value",
      point: { at: T0 + 5000, value: 22 },
      sourceTimestamp: "2026-07-04T00:00:05.000Z",
    };
    store.applyUpdates([update]);

    const after = store.view();
    expect(after).not.toBe(before);
    const s = store.get(key("gw-01", "a"), "m", "value")!;
    expect(s.latest).toBe(22);
    expect(s.receivedAt).toBe(T0 + 5000);
    expect(s.sourceTimestamp).toBe("2026-07-04T00:00:05.000Z");
    expect(s.points).toHaveLength(2);
  });

  it("creates, bounds, and caps live update series", () => {
    const store = new MetricStore({ maxSeriesPoints: 3, maxSeries: 2 });
    for (let i = 0; i < 6; i++) {
      store.applyUpdates([
        { key: key("gw-01", "a"), instance: "main", metric: "m1", measure: "value", point: { at: T0 + i, value: i } },
      ]);
    }
    expect(store.get(key("gw-01", "a"), "m1", "value")!.points.map((p) => p.value)).toEqual([3, 4, 5]);

    store.applyUpdates([
      { key: key("gw-01", "a"), instance: "main", metric: "m2", measure: "value", point: { at: T0, value: 2 } },
      { key: key("gw-01", "a"), instance: "main", metric: "m3", measure: "value", point: { at: T0, value: 3 } },
    ]);
    expect(store.seriesCount()).toBe(2);
    expect(store.droppedSeries()).toBe(1);
  });

  it("an empty update batch is a no-op", () => {
    const store = new MetricStore();
    store.applySnapshot([metricSeries(key("gw-01", "a"), "m", "value")]);
    const v = store.view();
    store.applyUpdates([]);
    expect(store.view()).toBe(v);
  });
});

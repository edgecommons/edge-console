/**
 * MetricSeriesStore (C6 client fold core): snapshot replace, bounded point
 * appends (latest-wins on equal time, stale drops), unseen-series starts, and
 * view identity/sorting. Pure — no sockets.
 */
import { describe, expect, it } from "vitest";
import type { MetricSeriesSnapshot, MetricSeriesUpdate } from "@edgecommons/edge-console-protocol";
import { MetricSeriesStore } from "../src/fleet/metric-series-store";
import { T0, key } from "./_fixtures";

const KEY = key("gw-01", "opcua-adapter");

function snap(overrides: Partial<MetricSeriesSnapshot> = {}): MetricSeriesSnapshot {
  return {
    key: KEY,
    metric: "sys",
    measure: "cpu",
    latest: 20,
    receivedAt: T0,
    points: [
      { at: T0 - 5000, value: 10 },
      { at: T0, value: 20 },
    ],
    ...overrides,
  };
}

function update(at: number, value: number, overrides: Partial<MetricSeriesUpdate> = {}): MetricSeriesUpdate {
  return { key: KEY, metric: "sys", measure: "cpu", point: { at, value }, ...overrides };
}

describe("MetricSeriesStore - snapshot fold", () => {
  it("replaces every series wholesale and derives ids/latest", () => {
    const store = new MetricSeriesStore();
    store.applyUpdates([update(T0 - 99_000, 1, { metric: "old" })]);

    store.applySnapshot([snap(), snap({ measure: "memory", latest: 41, points: [{ at: T0, value: 41 }] })]);

    const { series } = store.view();
    expect(series.map((s) => s.measure)).toEqual(["cpu", "memory"]);
    expect(series[0]).toMatchObject({
      componentId: "gw-01/opcua-adapter/main",
      seriesId: "gw-01/opcua-adapter/main::sys::cpu",
      latest: 20,
      receivedAt: T0,
    });
    expect(series.find((s) => s.metric === "old")).toBeUndefined(); // replaced
  });

  it("skips degenerate empty-points entries rather than crashing the view", () => {
    const store = new MetricSeriesStore();
    store.applySnapshot([snap({ points: [] }), snap({ measure: "memory", points: [{ at: T0, value: 1 }] })]);
    expect(store.view().series.map((s) => s.measure)).toEqual(["memory"]);
  });

  it("re-bounds oversized snapshot series to the client cap", () => {
    const store = new MetricSeriesStore(2);
    store.applySnapshot([
      snap({
        points: [
          { at: T0 - 10_000, value: 1 },
          { at: T0 - 5000, value: 2 },
          { at: T0, value: 3 },
        ],
      }),
    ]);
    expect(store.view().series[0]!.points.map((p) => p.value)).toEqual([2, 3]);
  });
});

describe("MetricSeriesStore - update fold", () => {
  it("appends bounded (drop-oldest) and updates latest/receivedAt", () => {
    const store = new MetricSeriesStore(3);
    store.applySnapshot([snap()]);

    store.applyUpdates([update(T0 + 5000, 30)]);
    store.applyUpdates([update(T0 + 10_000, 40)]);

    const [series] = store.view().series;
    expect(series!.points.map((p) => p.value)).toEqual([20, 30, 40]); // capped at 3
    expect(series!.latest).toBe(40);
    expect(series!.receivedAt).toBe(T0 + 10_000);
  });

  it("starts an unseen series from scratch (a metric born after the snapshot)", () => {
    const store = new MetricSeriesStore();
    store.applyUpdates([update(T0, 7, { metric: "relay_dropped", measure: "value" })]);
    expect(store.view().series[0]).toMatchObject({
      metric: "relay_dropped",
      latest: 7,
      points: [{ at: T0, value: 7 }],
    });
  });

  it("drops stale (older-than-tail) samples and latest-wins on equal time", () => {
    const store = new MetricSeriesStore();
    store.applySnapshot([snap()]);

    store.applyUpdates([update(T0 - 10_000, 99)]); // stale — reordered frame
    expect(store.view().series[0]!.points.map((p) => p.value)).toEqual([10, 20]);

    store.applyUpdates([update(T0, 25)]); // equal time — replace the tail
    const [series] = store.view().series;
    expect(series!.points.map((p) => p.value)).toEqual([10, 25]);
    expect(series!.latest).toBe(25);
  });

  it("sorts the view by (component, metric, measure)", () => {
    const store = new MetricSeriesStore();
    const other = key("aa-gw", "bridge");
    store.applyUpdates([
      update(T0, 1, { metric: "sys", measure: "memory" }),
      update(T0, 2, { key: other, metric: "relay_dropped", measure: "value" }),
      update(T0, 3, { metric: "sys", measure: "cpu" }),
    ]);
    expect(store.view().series.map((s) => s.seriesId)).toEqual([
      "aa-gw/bridge/main::relay_dropped::value",
      "gw-01/opcua-adapter/main::sys::cpu",
      "gw-01/opcua-adapter/main::sys::memory",
    ]);
  });
});

describe("MetricSeriesStore - view identity", () => {
  it("is identity-stable between folds; a no-op update batch does not bump", () => {
    const store = new MetricSeriesStore();
    store.applySnapshot([snap()]);
    const v1 = store.view();
    expect(store.view()).toBe(v1);

    store.applyUpdates([update(T0 - 99_000, 1)]); // entirely stale — nothing changed
    expect(store.view()).toBe(v1);

    store.applyUpdates([update(T0 + 1000, 30)]);
    expect(store.view()).not.toBe(v1);
  });
});

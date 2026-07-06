/**
 * MetricStore (C6) — the metric surface: EMF-shaped and lenient body folding,
 * latest-wins + the bounded per-series points, the distinct-series cap, sorted
 * snapshots, and the per-ingest update-batch fanout. Pure, injected clock.
 */
import { describe, expect, it } from "vitest";
import type { ComponentKey, MetricSeriesUpdate } from "@edgecommons/edge-console-protocol";

import { MetricStore, extractMeasures } from "../src/fleet/metric-store";
import type { IngressEvent } from "../src/ingress/normalizer";

class TestClock {
  now = 1_000_000;
  tick(ms: number): void {
    this.now += ms;
  }
  fn = (): number => this.now;
}

const KEY: ComponentKey = { device: "gw-01", component: "opcua-adapter" };

function metricEvent(
  channel: string | undefined,
  body: unknown,
  key: ComponentKey = KEY,
): IngressEvent {
  return {
    kind: "envelope",
    cls: "metric",
    ...(channel !== undefined ? { channel } : {}),
    identity: {
      hier: [{ level: "device", value: key.device }],
      path: key.device,
      component: key.component,
      instance: "main",
    },
    body,
    sourceTimestamp: "2026-07-03T00:00:00.000Z",
    topic: `ecv1/${key.device}/${key.component}/main/metric${channel !== undefined ? `/${channel}` : ""}`,
  };
}

/** An EMF-shaped `sys` body, the library publisher's real shape. */
function emfBody(cpu: number, memory: number): Record<string, unknown> {
  return {
    coreName: "gw-01",
    category: "sys",
    component: "opcua-adapter",
    cpu_usage: cpu,
    memory_usage: memory,
    _aws: { Timestamp: 1, CloudWatchMetrics: [] }, // metadata — never a measure
  };
}

describe("extractMeasures", () => {
  it("folds top-level finite numbers, skipping strings and _-prefixed keys", () => {
    expect(extractMeasures(emfBody(12.5, 41))).toEqual([
      ["cpu_usage", 12.5],
      ["memory_usage", 41],
    ]);
  });

  it("folds a bare finite number as the measure 'value'", () => {
    expect(extractMeasures(7)).toEqual([["value", 7]]);
  });

  it.each([
    ["a string body", "hot"],
    ["null", null],
    ["an array", [1, 2]],
    ["NaN", NaN],
    ["Infinity", Infinity],
    ["an object with no numerics", { note: "x", _aws: {} }],
    ["nested-only numerics (top-level rule)", { inner: { cpu: 1 } }],
  ])("contributes nothing for %s", (_label, body) => {
    expect(extractMeasures(body)).toEqual([]);
  });

  it("skips non-finite fields but keeps the finite ones", () => {
    expect(extractMeasures({ good: 1, bad: NaN, worse: Infinity, note: "x" })).toEqual([
      ["good", 1],
    ]);
  });
});

describe("MetricStore - folding", () => {
  it("tracks latest-wins per (component, metric, measure) with the receipt stamp", () => {
    const clock = new TestClock();
    const store = new MetricStore(clock.fn);

    store.ingest(metricEvent("sys", emfBody(10, 40)));
    clock.tick(5000);
    store.ingest(metricEvent("sys", emfBody(20, 41)));

    const snap = store.snapshot();
    expect(snap).toHaveLength(2); // cpu_usage + memory_usage
    expect(snap[0]).toMatchObject({
      key: KEY,
      metric: "sys",
      measure: "cpu_usage",
      latest: 20,
      receivedAt: 1_005_000,
      sourceTimestamp: "2026-07-03T00:00:00.000Z",
    });
    expect(snap[0]!.points).toEqual([
      { at: 1_000_000, value: 10 },
      { at: 1_005_000, value: 20 },
    ]);
    expect(snap[1]).toMatchObject({ measure: "memory_usage", latest: 41 });
  });

  it("bounds each series to maxSeriesPoints, dropping the oldest", () => {
    const clock = new TestClock();
    const store = new MetricStore(clock.fn, { maxSeriesPoints: 3 });
    for (let i = 1; i <= 5; i++) {
      store.ingest(metricEvent("counter", i));
      clock.tick(1000);
    }
    const [series] = store.snapshot();
    expect(series!.points.map((p) => p.value)).toEqual([3, 4, 5]);
    expect(series!.latest).toBe(5);
  });

  it("caps distinct series (drop + count new ones; existing keep updating)", () => {
    const clock = new TestClock();
    const store = new MetricStore(clock.fn, { maxSeries: 2 });
    store.ingest(metricEvent("sys", emfBody(1, 2))); // cpu_usage + memory_usage = the 2 slots
    store.ingest(metricEvent("extra", 1)); // over the cap — dropped
    store.ingest(metricEvent("sys", emfBody(3, 4))); // existing series still update

    expect(store.seriesCount()).toBe(2);
    expect(store.droppedSeries()).toBe(1);
    expect(store.snapshot().map((s) => s.latest)).toEqual([3, 4]);
  });

  it("sorts the snapshot by (component id, metric, measure)", () => {
    const clock = new TestClock();
    const store = new MetricStore(clock.fn);
    const other: ComponentKey = { device: "aa-gw", component: "bridge" };
    store.ingest(metricEvent("sys", emfBody(1, 2)));
    store.ingest(metricEvent("relay_dropped", 7, other));

    expect(store.snapshot().map((s) => `${s.key.device}/${s.metric}/${s.measure}`)).toEqual([
      "aa-gw/relay_dropped/value",
      "gw-01/sys/cpu_usage",
      "gw-01/sys/memory_usage",
    ]);
  });

  it("ignores non-metric classes, unnamed metrics, unattributable identities, and non-numeric bodies", () => {
    const clock = new TestClock();
    const store = new MetricStore(clock.fn);

    store.ingest({ ...metricEvent("sys", emfBody(1, 2)), cls: "evt" } as IngressEvent);
    store.ingest(metricEvent(undefined, 5)); // no channel — no metric name
    store.ingest(metricEvent("sys", "not-numeric"));
    store.ingest({ kind: "device-unreachable", device: "gw-01", topic: "t" });
    const noDevice = metricEvent("sys", emfBody(1, 2));
    (noDevice as { identity: { hier: unknown[] } }).identity.hier = [];
    store.ingest(noDevice);

    expect(store.seriesCount()).toBe(0);
  });
});

describe("MetricStore - update fanout", () => {
  it("notifies one batch per ingest with every folded measure, and honors unsubscribe", () => {
    const clock = new TestClock();
    const store = new MetricStore(clock.fn);
    const batches: MetricSeriesUpdate[][] = [];
    const off = store.onUpdate((u) => batches.push(u));

    store.ingest(metricEvent("sys", emfBody(10, 40)));
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([
      {
        key: KEY,
        instance: "main",
        metric: "sys",
        measure: "cpu_usage",
        point: { at: 1_000_000, value: 10 },
        sourceTimestamp: "2026-07-03T00:00:00.000Z",
      },
      {
        key: KEY,
        instance: "main",
        metric: "sys",
        measure: "memory_usage",
        point: { at: 1_000_000, value: 40 },
        sourceTimestamp: "2026-07-03T00:00:00.000Z",
      },
    ]);

    off();
    store.ingest(metricEvent("sys", emfBody(11, 41)));
    expect(batches).toHaveLength(1);
  });

  it("does not notify when nothing folded (dropped body / capped series)", () => {
    const clock = new TestClock();
    const store = new MetricStore(clock.fn, { maxSeries: 0 });
    let calls = 0;
    store.onUpdate(() => calls++);

    store.ingest(metricEvent("sys", "nope")); // non-numeric
    store.ingest(metricEvent("sys", 5)); // capped out (maxSeries 0)
    expect(calls).toBe(0);
    expect(store.droppedSeries()).toBe(1);
  });
});

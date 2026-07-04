/**
 * SignalStore (R0 data plane): the `data`-class projection — latest value + quality +
 * a bounded recent series per `(component, signal)`, snapshot + live update fanout.
 */
import { describe, expect, it } from "vitest";
import type { ComponentKey, SignalSeriesUpdate } from "@edgecommons/edge-console-protocol";
import { extractSignalSample } from "@edgecommons/edge-console-protocol";
import { SignalStore } from "../src/fleet/signal-store";
import type { IngressEvent } from "../src/ingress/normalizer";

class TestClock {
  now = 1_000_000;
  tick(ms: number): void {
    this.now += ms;
  }
  fn = (): number => this.now;
}

const KEY: ComponentKey = { device: "gw-01", component: "opcua-adapter", instance: "main" };

function dataEvent(channel: string | undefined, body: unknown, sourceTimestamp?: string): IngressEvent {
  return {
    kind: "envelope",
    cls: "data",
    ...(channel !== undefined ? { channel } : {}),
    identity: {
      hier: [
        { level: "site", value: "dallas" },
        { level: "device", value: KEY.device },
      ],
      path: `dallas/${KEY.device}`,
      component: KEY.component,
      instance: KEY.instance,
    },
    body,
    ...(sourceTimestamp !== undefined ? { sourceTimestamp } : {}),
    topic: `ecv1/${KEY.device}/${KEY.component}/${KEY.instance}/data/${channel ?? ""}`,
  };
}

describe("extractSignalSample", () => {
  it("splits {value, quality}, a bare scalar, and a value-less object", () => {
    expect(extractSignalSample({ value: 42.5, quality: "GOOD" })).toEqual({ value: 42.5, quality: "GOOD" });
    expect(extractSignalSample(42.5)).toEqual({ value: 42.5 });
    expect(extractSignalSample("open")).toEqual({ value: "open" });
    // no `value` key -> the whole body is the value; a non-string quality is ignored.
    expect(extractSignalSample({ temp: 20, quality: 1 })).toEqual({ value: { temp: 20, quality: 1 } });
  });
});

describe("SignalStore", () => {
  it("folds latest value + quality + a bounded series, and streams updates", () => {
    const clock = new TestClock();
    const store = new SignalStore(clock.fn, { maxSeriesPoints: 3 });
    const updates: SignalSeriesUpdate[][] = [];
    store.onUpdate((u) => updates.push(u));

    store.ingest(dataEvent("Temp_01", { value: 20.1, quality: "GOOD" }, "2026-07-03T00:00:00.000Z"));
    clock.tick(1000);
    store.ingest(dataEvent("Temp_01", { value: 20.4, quality: "UNCERTAIN" }));
    clock.tick(1000);
    store.ingest(dataEvent("Temp_01", 20.9)); // bare scalar — no quality
    clock.tick(1000);
    store.ingest(dataEvent("Temp_01", { value: 21.2, quality: "BAD" })); // 4th → drop-oldest

    const snap = store.snapshot();
    expect(snap).toHaveLength(1);
    const series = snap[0]!;
    expect(series.signal).toBe("Temp_01");
    expect(series.latest).toBe(21.2);
    expect(series.quality).toBe("BAD");
    expect(series.points.map((p) => p.value)).toEqual([20.4, 20.9, 21.2]); // bounded to 3
    expect(series.points.map((p) => p.quality)).toEqual(["UNCERTAIN", undefined, "BAD"]);
    // A sourceTimestamp only present on the first sample is cleared by later ones.
    expect(series.sourceTimestamp).toBeUndefined();
    expect(updates).toHaveLength(4);
    expect(updates[0]![0]).toMatchObject({
      signal: "Temp_01",
      point: { value: 20.1, quality: "GOOD" },
      sourceTimestamp: "2026-07-03T00:00:00.000Z",
    });
  });

  it("ignores non-data classes, unnamed signals, and unattributable envelopes", () => {
    const clock = new TestClock();
    const store = new SignalStore(clock.fn);
    store.ingest({ ...dataEvent("s", 1), cls: "metric" }); // wrong class
    store.ingest(dataEvent(undefined, 1)); // unnamed
    store.ingest(dataEvent("", 1)); // empty channel
    store.ingest({ kind: "device-unreachable", device: "gw-01", topic: "x" });
    store.ingest({ kind: "ignored", cls: "data", topic: "x", reason: "missing-identity" });
    // an envelope whose last hier value is empty is unattributable
    store.ingest({
      ...dataEvent("s", 1),
      identity: { hier: [{ level: "device", value: "" }], path: "", component: "c", instance: "main" },
    });
    expect(store.snapshot()).toHaveLength(0);
    expect(store.seriesCount()).toBe(0);
  });

  it("caps distinct series and counts the overflow", () => {
    const clock = new TestClock();
    const store = new SignalStore(clock.fn, { maxSeries: 2 });
    store.ingest(dataEvent("a", 1));
    store.ingest(dataEvent("b", 2));
    store.ingest(dataEvent("c", 3)); // overflow — dropped
    store.ingest(dataEvent("a", 9)); // existing series still updates
    expect(store.seriesCount()).toBe(2);
    expect(store.droppedSeries()).toBe(1);
    expect(store.snapshot().find((s) => s.signal === "a")!.latest).toBe(9);
  });
});

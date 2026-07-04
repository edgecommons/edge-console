/**
 * AttributeStore (R0): the runtime-attribute projection over the `metric` class — `sys`
 * cpu/memory/threads/fds and `southbound_health` connectionState/readErrors/writeErrors,
 * latest-wins per field, snapshot + live update fanout.
 */
import { describe, expect, it } from "vitest";
import type { ComponentKey, RuntimeAttributes } from "@edgecommons/edge-console-protocol";
import { AttributeStore } from "../src/fleet/attribute-store";
import type { IngressEvent } from "../src/ingress/normalizer";

class TestClock {
  now = 1_000_000;
  tick(ms: number): void {
    this.now += ms;
  }
  fn = (): number => this.now;
}

const KEY: ComponentKey = { device: "gw-01", component: "opcua-adapter", instance: "main" };

function metricEvent(channel: string, body: unknown, key: ComponentKey = KEY): IngressEvent {
  return {
    kind: "envelope",
    cls: "metric",
    channel,
    identity: {
      hier: [
        { level: "site", value: "dallas" },
        { level: "device", value: key.device },
      ],
      path: `dallas/${key.device}`,
      component: key.component,
      instance: key.instance,
    },
    body,
    topic: `ecv1/${key.device}/${key.component}/${key.instance}/metric/${channel}`,
  };
}

describe("AttributeStore", () => {
  it("projects sys measures and southbound_health into one per-component record (latest-wins)", () => {
    const clock = new TestClock();
    const store = new AttributeStore(clock.fn);
    const updates: RuntimeAttributes[][] = [];
    store.onUpdate((u) => updates.push(u));

    store.ingest(metricEvent("sys", { cpu: 22.5, memory: 180, threads: 12, fds: 40, coreName: "x", _aws: {} }));
    store.ingest(
      metricEvent("southbound_health", { connectionState: "CONNECTED", readErrors: 3, writeErrors: 0 }),
    );
    clock.tick(1000);
    store.ingest(metricEvent("sys", { cpu: 41.1 })); // partial — only cpu updates

    const snap = store.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({
      key: KEY,
      cpuPercent: 41.1, // latest-wins
      memoryMb: 180, // untouched by the partial update
      threads: 12,
      fds: 40,
      connectionState: "CONNECTED",
      readErrors: 3,
      writeErrors: 0,
    });
    // Every contributing ingest fired an update (sys, southbound_health, sys).
    expect(updates).toHaveLength(3);
    expect(updates[2]![0]!.cpuPercent).toBe(41.1);
  });

  it("ignores other metric channels, non-metric classes, and non-numeric measures", () => {
    const clock = new TestClock();
    const store = new AttributeStore(clock.fn);
    store.ingest(metricEvent("relay_dropped_data", { dropped: 5 })); // not sys/southbound_health
    store.ingest({ ...metricEvent("sys", { cpu: 1 }), cls: "data" }); // wrong class
    store.ingest(metricEvent("sys", { cpu: "hot" })); // non-numeric → no change, no record
    store.ingest(metricEvent("southbound_health", { connectionState: 5 })); // non-string → skipped
    expect(store.snapshot()).toHaveLength(0);
    expect(store.componentCount()).toBe(0);
  });

  it("tracks multiple components and caps the total, counting overflow", () => {
    const clock = new TestClock();
    const store = new AttributeStore(clock.fn, { maxComponents: 1 });
    store.ingest(metricEvent("sys", { cpu: 1 }, KEY));
    store.ingest(metricEvent("sys", { cpu: 2 }, { device: "gw-02", component: "c", instance: "main" }));
    expect(store.componentCount()).toBe(1);
    expect(store.droppedComponents()).toBe(1);
  });
});

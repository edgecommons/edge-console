import { describe, expect, it } from "vitest";
import type { FleetDelta } from "@edgecommons/edge-console-protocol";

import { FleetModel } from "../src/fleet/fleet-model";
import type { EnvelopeEvent, IngressEvent } from "../src/ingress/normalizer";

/** A manually-advanced clock (ms) — no sleeps anywhere. */
class TestClock {
  now = 1_000_000;
  tick(ms: number): void {
    this.now += ms;
  }
  fn = (): number => this.now;
}

/** EnvelopeEvent factory (defaults: gw-01 / press-17 / main, single-level hierarchy). */
function env(over: Partial<EnvelopeEvent> = {}): EnvelopeEvent {
  const device = over.identity?.hier?.at(-1)?.value ?? "gw-01";
  return {
    kind: "envelope",
    cls: "state",
    identity: {
      hier: [{ level: "device", value: device }],
      path: device,
      component: "press-17",
      instance: "main",
    },
    body: { status: "RUNNING", uptimeSecs: 10 },
    topic: `ecv1/${device}/press-17/main/state`,
    ...over,
  };
}

function state(status: string, uptimeSecs?: number, component = "press-17"): EnvelopeEvent {
  return env({
    cls: "state",
    body: uptimeSecs === undefined ? { status } : { status, uptimeSecs },
    identity: {
      hier: [{ level: "device", value: "gw-01" }],
      path: "gw-01",
      component,
      instance: "main",
    },
  });
}

function cfg(intervalSecs: unknown): EnvelopeEvent {
  return env({ cls: "cfg", body: { config: { heartbeat: { intervalSecs } } } });
}

const unreachable = (device = "gw-01"): IngressEvent => ({
  kind: "device-unreachable",
  device,
  topic: `ecv1/${device}/uns-bridge/main/state`,
});

function types(deltas: FleetDelta[]): string[] {
  return deltas.map((d) => d.type);
}

describe("FleetModel - discovery + LKV cache", () => {
  it("discovers device + component on the first envelope and caches the value with the receipt timestamp", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    const deltas = model.ingest(state("RUNNING", 5));
    expect(types(deltas)).toEqual(["device-discovered", "component-discovered", "value-updated"]);

    const snap = model.snapshot();
    expect(snap.devices).toHaveLength(1);
    const comp = snap.devices[0]!.components[0]!;
    expect(comp.key).toEqual({ device: "gw-01", component: "press-17", instance: "main" });
    expect(comp.liveness).toBe("FRESH");
    expect(comp.status).toBe("RUNNING");
    expect(comp.uptimeSecs).toBe(5);
    expect(comp.values).toEqual([
      expect.objectContaining({ cls: "state", body: { status: "RUNNING", uptimeSecs: 5 }, receivedAt: clock.now }),
    ]);
  });

  it("keys the cache by (class, channel) and keeps one timestamped entry per key", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    model.ingest(env({ cls: "data", channel: "temp", body: { v: 1 } }));
    clock.tick(500);
    model.ingest(env({ cls: "data", channel: "temp", body: { v: 2 } }));
    model.ingest(env({ cls: "data", channel: "pressure", body: { v: 9 } }));
    model.ingest(env({ cls: "metric", channel: "sys", body: { cpu: 0.2 } }));

    const comp = model.snapshot().devices[0]!.components[0]!;
    expect(comp.values).toHaveLength(3);
    const temp = comp.values.find((v) => v.cls === "data" && v.channel === "temp")!;
    expect(temp.body).toEqual({ v: 2 });
    expect(temp.receivedAt).toBe(clock.now);
  });

  it("caps distinct channels per component, counting drops but still updating known keys", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn, { maxChannelsPerComponent: 2 });
    model.ingest(env({ cls: "data", channel: "a", body: 1 }));
    model.ingest(env({ cls: "data", channel: "b", body: 2 }));
    const dropped = model.ingest(env({ cls: "data", channel: "c", body: 3 }));
    expect(types(dropped)).toEqual([]); // no value-updated for the dropped channel
    const updated = model.ingest(env({ cls: "data", channel: "a", body: 4 }));
    expect(types(updated)).toEqual(["value-updated"]);

    const comp = model.snapshot().devices[0]!.components[0]!;
    expect(comp.droppedChannels).toBe(1);
    expect(comp.values.find((v) => v.channel === "a")!.body).toBe(4);
    expect(comp.values.find((v) => v.channel === "c")).toBeUndefined();
  });

  it("keeps tags (including reserved _-keys) on the cached value without acting on them", () => {
    const model = new FleetModel(new TestClock().fn);
    model.ingest(env({ cls: "evt", channel: "warn/overtemp", body: { m: "hot" }, tags: { _relay: ["gw-01/uns-bridge"] } }));
    const comp = model.snapshot().devices[0]!.components[0]!;
    expect(comp.values[0]!.tags).toEqual({ _relay: ["gw-01/uns-bridge"] });
  });

  it("ignores 'ignored' ingress events and unattributable identities", () => {
    const model = new FleetModel(new TestClock().fn);
    expect(model.ingest({ kind: "ignored", cls: "state", topic: "t", reason: "raw-non-lwt" })).toEqual([]);
    expect(
      model.ingest(env({ identity: { hier: [], path: "", component: "x", instance: "main" } })),
    ).toEqual([]);
    expect(model.snapshot().devices).toHaveLength(0);
  });
});

describe("FleetModel - cadence derivation (Q3: console-side, from cfg)", () => {
  it("defaults the expected interval to 5s until the component's cfg arrives", () => {
    const model = new FleetModel(new TestClock().fn);
    model.ingest(state("RUNNING", 1));
    const comp = model.snapshot().devices[0]!.components[0]!;
    expect(comp.expectedIntervalSecs).toBe(5);
    expect(comp.cadenceSource).toBe("default");
  });

  it("derives the cadence from cfg heartbeat.intervalSecs (floats truncated, like the lib)", () => {
    const model = new FleetModel(new TestClock().fn);
    model.ingest(state("RUNNING", 1));
    model.ingest(cfg(2.0));
    const comp = model.snapshot().devices[0]!.components[0]!;
    expect(comp.expectedIntervalSecs).toBe(2);
    expect(comp.cadenceSource).toBe("cfg");
  });

  it("keeps the current cadence on invalid cfg values (0, negative, non-numeric, absent)", () => {
    const model = new FleetModel(new TestClock().fn);
    model.ingest(state("RUNNING", 1));
    model.ingest(cfg(0));
    model.ingest(cfg(-3));
    model.ingest(cfg("fast"));
    model.ingest(env({ cls: "cfg", body: { config: {} } }));
    model.ingest(env({ cls: "cfg", body: "not-an-object" }));
    const comp = model.snapshot().devices[0]!.components[0]!;
    expect(comp.expectedIntervalSecs).toBe(5);
    expect(comp.cadenceSource).toBe("default");
  });
});

describe("FleetModel - miss-detection ladder (warn 2x / stale 2.5x / offline 5x)", () => {
  it("walks FRESH -> WARN -> STALE -> OFFLINE from the last state receipt", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    model.ingest(state("RUNNING", 1)); // interval default 5s

    clock.tick(9_000); // 9s < 2x5s
    expect(types(model.sweep())).toEqual([]);

    clock.tick(1_500); // 10.5s > 10s
    let deltas = model.sweep();
    expect(deltas).toEqual([expect.objectContaining({ type: "liveness-changed", from: "FRESH", to: "WARN" })]);

    clock.tick(2_100); // 12.6s > 12.5s
    deltas = model.sweep();
    expect(deltas).toEqual([expect.objectContaining({ type: "liveness-changed", from: "WARN", to: "STALE" })]);

    clock.tick(13_000); // 25.6s > 25s
    deltas = model.sweep();
    expect(deltas).toEqual([expect.objectContaining({ type: "liveness-changed", from: "STALE", to: "OFFLINE" })]);

    expect(model.snapshot().devices[0]!.components[0]!.liveness).toBe("OFFLINE");
  });

  it("scales the thresholds with the cfg-derived cadence", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    model.ingest(state("RUNNING", 1));
    model.ingest(cfg(2)); // 2s cadence: warn > 4s, stale > 5s, offline > 10s

    clock.tick(4_100);
    expect(model.sweep()).toEqual([expect.objectContaining({ to: "WARN" })]);
    clock.tick(1_000); // 5.1s
    expect(model.sweep()).toEqual([expect.objectContaining({ to: "STALE" })]);
    clock.tick(5_000); // 10.1s
    expect(model.sweep()).toEqual([expect.objectContaining({ to: "OFFLINE" })]);
  });

  it("recovers to FRESH on the next keepalive", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    model.ingest(state("RUNNING", 1));
    clock.tick(30_000);
    model.sweep();
    const deltas = model.ingest(state("RUNNING", 31));
    expect(deltas).toEqual([
      expect.objectContaining({ type: "value-updated" }),
      expect.objectContaining({ type: "liveness-changed", from: "OFFLINE", to: "FRESH" }),
    ]);
  });

  it("degrades a component that never sent state from its discovery time (honest 'missing')", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    model.ingest(env({ cls: "metric", channel: "sys", body: { cpu: 0.1 } }));
    const before = model.snapshot().devices[0]!.components[0]!;
    expect(before.liveness).toBe("FRESH");
    expect(before.status).toBeUndefined();

    clock.tick(10_500); // > 2x default 5s from firstSeenAt
    expect(model.sweep()).toEqual([expect.objectContaining({ to: "WARN" })]);
  });

  it("detects a restart as an uptimeSecs decrease (G4), not as a gap", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    model.ingest(state("RUNNING", 100));
    const deltas = model.ingest(state("RUNNING", 3));
    expect(deltas).toEqual([
      expect.objectContaining({ type: "value-updated" }),
      expect.objectContaining({ type: "component-restarted", previousUptimeSecs: 100, uptimeSecs: 3 }),
    ]);
    const comp = model.snapshot().devices[0]!.components[0]!;
    expect(comp.restarts).toBe(1);
    expect(comp.uptimeSecs).toBe(3);
    expect(comp.liveness).toBe("FRESH");
  });

  it("holds a graceful STOPPED without staleness decay until the next RUNNING state", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    model.ingest(state("RUNNING", 50));
    const stopDeltas = model.ingest(state("STOPPED"));
    expect(stopDeltas).toEqual([
      expect.objectContaining({ type: "value-updated" }),
      expect.objectContaining({ type: "liveness-changed", from: "FRESH", to: "STOPPED" }),
    ]);

    clock.tick(3_600_000); // an hour later: still STOPPED, not OFFLINE
    expect(model.sweep()).toEqual([]);
    expect(model.snapshot().devices[0]!.components[0]!.liveness).toBe("STOPPED");

    const restart = model.ingest(state("RUNNING", 2));
    expect(restart).toEqual([
      expect.objectContaining({ type: "value-updated" }),
      expect.objectContaining({ type: "component-restarted" }),
      expect.objectContaining({ type: "liveness-changed", from: "STOPPED", to: "FRESH" }),
    ]);
  });
});

describe("FleetModel - whole-device UNREACHABLE (bridge LWT, G5)", () => {
  it("freezes and overlays the whole device subtree, with the containment count", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    model.ingest(state("RUNNING", 1, "press-17"));
    model.ingest(state("RUNNING", 1, "opcua-adapter"));

    const deltas = model.ingest(unreachable());
    expect(deltas).toEqual([
      expect.objectContaining({
        type: "device-reachability-changed",
        device: "gw-01",
        unreachable: true,
        componentCount: 2,
      }),
    ]);

    const device = model.snapshot().devices[0]!;
    expect(device.unreachable).toBe(true);
    expect(device.unreachableSince).toBe(clock.now);
    expect(device.components.map((c) => c.liveness)).toEqual(["UNREACHABLE", "UNREACHABLE"]);

    // Frozen: the sweeper never degrades an unreachable device's components.
    clock.tick(3_600_000);
    expect(model.sweep()).toEqual([]);
  });

  it("is idempotent (a repeated LWT changes nothing)", () => {
    const model = new FleetModel(new TestClock().fn);
    model.ingest(state("RUNNING", 1));
    model.ingest(unreachable());
    expect(model.ingest(unreachable())).toEqual([]);
  });

  it("stays terminal through non-state traffic and clears only on the next state envelope", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    model.ingest(state("RUNNING", 1));
    model.ingest(unreachable());

    // Cached (still useful data) but NOT a reachability proof.
    const metricDeltas = model.ingest(env({ cls: "metric", channel: "sys", body: { cpu: 0.5 } }));
    expect(types(metricDeltas)).toEqual(["value-updated"]);
    expect(model.snapshot().devices[0]!.unreachable).toBe(true);

    // A state envelope from the device proves the uplink again.
    const deltas = model.ingest(state("RUNNING", 60));
    expect(deltas).toEqual([
      expect.objectContaining({ type: "value-updated" }),
      expect.objectContaining({ type: "device-reachability-changed", unreachable: false }),
    ]);
    const device = model.snapshot().devices[0]!;
    expect(device.unreachable).toBe(false);
    expect(device.unreachableSince).toBeUndefined();
    expect(device.components[0]!.liveness).toBe("FRESH");
  });

  it("discovers a device from its LWT alone (bridge dies before anything else was seen)", () => {
    const model = new FleetModel(new TestClock().fn);
    const deltas = model.ingest(unreachable("gw-99"));
    expect(types(deltas)).toEqual(["device-discovered", "device-reachability-changed"]);
    expect(model.devices()).toEqual(["gw-99"]);
    expect(model.snapshot().devices[0]!).toMatchObject({ device: "gw-99", unreachable: true, components: [] });
  });
});

describe("FleetModel - snapshot/delta contract (the C2 seam)", () => {
  it("stamps monotonic seq numbers across batches and reports the last folded seq on the snapshot", () => {
    const model = new FleetModel(new TestClock().fn);
    const a = model.ingest(state("RUNNING", 1));
    const b = model.ingest(env({ cls: "data", channel: "t", body: 1 }));
    const seqs = [...a, ...b].map((d) => d.seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
    expect(model.snapshot().seq).toBe(4);
  });

  it("notifies delta listeners with each non-empty batch; unsubscribe detaches", () => {
    const model = new FleetModel(new TestClock().fn);
    const batches: FleetDelta[][] = [];
    const off = model.onDelta((d) => batches.push(d));
    model.ingest(state("RUNNING", 1));
    model.ingest({ kind: "ignored", cls: "state", topic: "t", reason: "raw-non-lwt" }); // empty batch: no callback
    expect(batches).toHaveLength(1);
    off();
    model.ingest(state("RUNNING", 2));
    expect(batches).toHaveLength(1);
  });

  it("orders devices and components deterministically and deep-copies records", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    model.ingest(env({ identity: { hier: [{ level: "device", value: "gw-02" }], path: "gw-02", component: "b", instance: "main" } }));
    model.ingest(env({ identity: { hier: [{ level: "device", value: "gw-01" }], path: "gw-01", component: "z", instance: "main" } }));
    model.ingest(env({ identity: { hier: [{ level: "device", value: "gw-01" }], path: "gw-01", component: "a", instance: "main" } }));

    const snap = model.snapshot();
    expect(snap.devices.map((d) => d.device)).toEqual(["gw-01", "gw-02"]);
    expect(snap.devices[0]!.components.map((c) => c.key.component)).toEqual(["a", "z"]);
    expect(snap.takenAt).toBe(clock.now);

    // Mutating the snapshot must not touch the model.
    snap.devices[0]!.components[0]!.key.component = "hacked";
    expect(model.snapshot().devices[0]!.components[0]!.key.component).toBe("a");
  });

  it("lists known devices sorted (the republish-broadcast iteration set)", () => {
    const model = new FleetModel(new TestClock().fn);
    model.ingest(unreachable("gw-09"));
    model.ingest(state("RUNNING", 1));
    expect(model.devices()).toEqual(["gw-01", "gw-09"]);
  });
});

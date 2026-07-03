import { describe, expect, it } from "vitest";
import type { FleetDelta } from "@edgecommons/edge-console-protocol";
import { FleetStore, ladderForAge, DEFAULT_LADDER_OPTIONS } from "../src/fleet/store";
import { T0, compSnap, deviceSnap, key, seqRun, snapshot } from "./_fixtures";

/** A store pre-loaded with one healthy component at seq 10. */
function liveStore(): FleetStore {
  const store = new FleetStore();
  store.applySnapshot(snapshot([deviceSnap("gw-01", [compSnap()])]), T0 + 50);
  return store;
}

function firstComp(store: FleetStore) {
  const comp = store.view().devices[0]?.components[0];
  expect(comp).toBeDefined();
  return comp!;
}

describe("FleetStore - snapshot apply", () => {
  it("mirrors the snapshot: devices, components, seq baseline and clock offset", () => {
    const store = new FleetStore();
    expect(store.hasSnapshot()).toBe(false);
    store.applySnapshot(
      snapshot(
        [
          deviceSnap("gw-02", [compSnap({ key: key("gw-02", "b") })]),
          deviceSnap("gw-01", [compSnap()]),
        ],
        42,
        T0,
      ),
      T0 + 500,
    );
    const view = store.view();
    expect(store.hasSnapshot()).toBe(true);
    expect(store.lastAppliedSeq()).toBe(42);
    expect(view.seq).toBe(42);
    expect(view.devices.map((d) => d.device)).toEqual(["gw-01", "gw-02"]); // sorted
    expect(view.clockOffsetMs).toBe(500);
    expect(view.lastUpdatedAt).toBe(T0 + 500);
    const comp = firstComp(store);
    expect(comp.liveness).toBe("FRESH");
    expect(comp.status).toBe("RUNNING");
    expect(comp.uptimeSecs).toBe(100);
    expect(comp.uptimeAnchorAt).toBe(T0); // uptime anchored to the reporting state
  });

  it("a later snapshot replaces the store wholesale", () => {
    const store = liveStore();
    store.applySnapshot(snapshot([deviceSnap("gw-09", [compSnap({ key: key("gw-09") })])], 99), T0 + 1000);
    const view = store.view();
    expect(view.devices.map((d) => d.device)).toEqual(["gw-09"]);
    expect(view.seq).toBe(99);
  });

  it("caches the view object between folds (identity-stable for React)", () => {
    const store = liveStore();
    const a = store.view();
    expect(store.view()).toBe(a);
    store.applyDeltas(
      seqRun(11, [{ type: "value-updated", at: T0 + 100, key: key(), cls: "state" }]),
      T0 + 120,
    );
    expect(store.view()).not.toBe(a);
  });
});

describe("FleetStore - delta fold (seq order)", () => {
  it("folds a contiguous batch and advances seq", () => {
    const store = liveStore();
    const result = store.applyDeltas(
      seqRun(11, [
        { type: "device-discovered", at: T0 + 100, device: "gw-02" },
        { type: "component-discovered", at: T0 + 100, key: key("gw-02", "new-comp"), path: "dallas/gw-02" },
      ]),
      T0 + 150,
    );
    expect(result).toEqual({ applied: 2, gap: false });
    expect(store.lastAppliedSeq()).toBe(12);
    const view = store.view();
    expect(view.devices.map((d) => d.device)).toEqual(["gw-01", "gw-02"]);
    const discovered = view.devices[1]!.components[0]!;
    expect(discovered.liveness).toBe("FRESH"); // the server's discovery default
    expect(discovered.expectedIntervalSecs).toBe(5);
    expect(discovered.cadenceSource).toBe("default");
    expect(view.lastUpdatedAt).toBe(T0 + 150);
    expect(view.clockOffsetMs).toBe(50); // receivedAt - last delta at
  });

  it("skips already-applied seqs (resume overlap) without gap", () => {
    const store = liveStore(); // seq 10
    const result = store.applyDeltas(
      seqRun(9, [
        { type: "device-discovered", at: T0, device: "ignored" }, // seq 9 - old
        { type: "device-discovered", at: T0, device: "ignored-too" }, // seq 10 - old
        { type: "device-discovered", at: T0 + 100, device: "gw-02" }, // seq 11 - new
      ]),
      T0 + 150,
    );
    expect(result).toEqual({ applied: 1, gap: false });
    expect(store.view().devices.map((d) => d.device)).toEqual(["gw-01", "gw-02"]);
  });

  it("reports a gap when the batch starts past seq+1 and applies nothing after it", () => {
    const store = liveStore(); // seq 10
    const result = store.applyDeltas(
      seqRun(13, [{ type: "device-discovered", at: T0, device: "gw-09" }]),
      T0 + 150,
    );
    expect(result).toEqual({ applied: 0, gap: true });
    expect(store.lastAppliedSeq()).toBe(10);
    expect(store.view().devices).toHaveLength(1);
  });

  it("applies the contiguous prefix, then stops at a mid-batch gap", () => {
    const store = liveStore(); // seq 10
    const deltas: FleetDelta[] = [
      { type: "device-discovered", seq: 11, at: T0 + 100, device: "gw-02" },
      { type: "device-discovered", seq: 15, at: T0 + 100, device: "gw-09" }, // hole
    ];
    const result = store.applyDeltas(deltas, T0 + 150);
    expect(result).toEqual({ applied: 1, gap: true });
    expect(store.view().devices.map((d) => d.device)).toEqual(["gw-01", "gw-02"]);
  });

  it("a delta batch before any snapshot is a gap (no baseline)", () => {
    const store = new FleetStore();
    const result = store.applyDeltas(
      seqRun(1, [{ type: "device-discovered", at: T0, device: "gw-01" }]),
      T0,
    );
    expect(result).toEqual({ applied: 0, gap: true });
  });
});

describe("FleetStore - per-delta semantics", () => {
  it("value-updated (state) refreshes lastStateAt and the cached value timestamp, keeping the body", () => {
    const store = new FleetStore();
    store.applySnapshot(
      snapshot([
        deviceSnap("gw-01", [
          compSnap({
            values: [{ cls: "state", body: { status: "RUNNING" }, receivedAt: T0 }],
          }),
        ]),
      ]),
      T0,
    );
    store.applyDeltas(
      seqRun(11, [{ type: "value-updated", at: T0 + 5000, key: key(), cls: "state" }]),
      T0 + 5000,
    );
    const comp = firstComp(store);
    expect(comp.lastStateAt).toBe(T0 + 5000);
    const state = comp.values.find((v) => v.cls === "state")!;
    expect(state.receivedAt).toBe(T0 + 5000);
    expect(state.body).toEqual({ status: "RUNNING" }); // bodies do not travel in deltas
  });

  it("value-updated for an unseen channel creates a body-less placeholder entry", () => {
    const store = liveStore();
    store.applyDeltas(
      seqRun(11, [
        { type: "value-updated", at: T0 + 100, key: key(), cls: "metric", channel: "sys" },
      ]),
      T0 + 100,
    );
    const comp = firstComp(store);
    const entry = comp.values.find((v) => v.cls === "metric" && v.channel === "sys")!;
    expect(entry.receivedAt).toBe(T0 + 100);
    expect(entry.body).toBeUndefined();
  });

  it("liveness-changed drives the ladder and implies the status the client never sees", () => {
    const store = liveStore();
    store.applyDeltas(
      seqRun(11, [
        { type: "liveness-changed", at: T0 + 20_000, key: key(), from: "FRESH", to: "STALE" },
      ]),
      T0 + 20_000,
    );
    expect(firstComp(store).liveness).toBe("STALE");
    expect(firstComp(store).status).toBe("RUNNING"); // unchanged by decay

    store.applyDeltas(
      seqRun(12, [
        { type: "liveness-changed", at: T0 + 30_000, key: key(), from: "STALE", to: "STOPPED" },
      ]),
      T0 + 30_000,
    );
    expect(firstComp(store).liveness).toBe("STOPPED");
    expect(firstComp(store).status).toBe("STOPPED"); // only a graceful stop reports STOPPED

    store.applyDeltas(
      seqRun(13, [
        { type: "liveness-changed", at: T0 + 40_000, key: key(), from: "STOPPED", to: "FRESH" },
      ]),
      T0 + 40_000,
    );
    expect(firstComp(store).liveness).toBe("FRESH");
    expect(firstComp(store).status).toBe("RUNNING"); // only a RUNNING keepalive yields FRESH
  });

  it("component-restarted bumps restarts and re-anchors uptime", () => {
    const store = liveStore();
    store.applyDeltas(
      seqRun(11, [
        {
          type: "component-restarted",
          at: T0 + 60_000,
          key: key(),
          previousUptimeSecs: 100,
          uptimeSecs: 3,
        },
      ]),
      T0 + 60_000,
    );
    const comp = firstComp(store);
    expect(comp.restarts).toBe(1);
    expect(comp.uptimeSecs).toBe(3);
    expect(comp.uptimeAnchorAt).toBe(T0 + 60_000);
    expect(comp.status).toBe("RUNNING");
  });

  it("device-reachability-changed overlays UNREACHABLE on every component, then releases", () => {
    const store = new FleetStore();
    store.applySnapshot(
      snapshot([
        deviceSnap("gw-01", [
          compSnap(),
          compSnap({ key: key("gw-01", "comp-b"), liveness: "STALE" }),
        ]),
      ]),
      T0,
    );
    store.applyDeltas(
      seqRun(11, [
        {
          type: "device-reachability-changed",
          at: T0 + 1000,
          device: "gw-01",
          unreachable: true,
          componentCount: 2,
        },
      ]),
      T0 + 1000,
    );
    let device = store.view().devices[0]!;
    expect(device.unreachable).toBe(true);
    expect(device.unreachableSince).toBe(T0 + 1000);
    expect(device.components.map((c) => c.liveness)).toEqual(["UNREACHABLE", "UNREACHABLE"]);

    store.applyDeltas(
      seqRun(12, [
        {
          type: "device-reachability-changed",
          at: T0 + 5000,
          device: "gw-01",
          unreachable: false,
          componentCount: 2,
        },
      ]),
      T0 + 5000,
    );
    device = store.view().devices[0]!;
    expect(device.unreachable).toBe(false);
    expect(device.unreachableSince).toBeUndefined();
    // The pre-outage ladders were never lost - the overlay lifts cleanly.
    expect(device.components.map((c) => c.liveness)).toEqual(["FRESH", "STALE"]);
  });

  it("fills in overlay-hidden ladders when a snapshot was taken during the outage", () => {
    const store = new FleetStore();
    // Snapshot DURING the outage: the server overlay reports UNREACHABLE, hiding
    // the underlying ladder from the client.
    store.applySnapshot(
      snapshot([
        deviceSnap(
          "gw-01",
          [
            // graceful stop before the outage - must come back as STOPPED
            compSnap({ key: key("gw-01", "stopped"), liveness: "UNREACHABLE", status: "STOPPED" }),
            // fresh keepalive just before recovery - must come back FRESH
            compSnap({ key: key("gw-01", "fresh"), liveness: "UNREACHABLE", lastStateAt: T0 + 59_000 }),
            // ancient last state - must come back OFFLINE (>5x5s)
            compSnap({ key: key("gw-01", "old"), liveness: "UNREACHABLE", lastStateAt: T0 }),
            // never reported a state - no age baseline, degrade to OFFLINE
            compSnap({
              key: key("gw-01", "silent"),
              liveness: "UNREACHABLE",
              status: undefined,
              lastStateAt: undefined,
              uptimeSecs: undefined,
            }),
          ],
          { unreachable: true, unreachableSince: T0 },
        ),
      ]),
      T0 + 30_000,
    );
    expect(store.view().devices[0]!.components.every((c) => c.liveness === "UNREACHABLE")).toBe(true);

    store.applyDeltas(
      seqRun(11, [
        {
          type: "device-reachability-changed",
          at: T0 + 60_000,
          device: "gw-01",
          unreachable: false,
          componentCount: 4,
        },
      ]),
      T0 + 60_000,
    );
    const byName = new Map(store.view().devices[0]!.components.map((c) => [c.key.component, c]));
    expect(byName.get("stopped")!.liveness).toBe("STOPPED");
    expect(byName.get("fresh")!.liveness).toBe("FRESH");
    expect(byName.get("old")!.liveness).toBe("OFFLINE");
    expect(byName.get("silent")!.liveness).toBe("OFFLINE");
  });

  it("a state arrival re-commits FRESH even when the server sends no liveness delta (post-outage divergence heal)", () => {
    // The live-run regression: connect DURING a device outage (ladder hidden by the
    // overlay), reachability clears via ANOTHER component's state, the fill-in ages
    // this one to OFFLINE - but the server's frozen ladder was FRESH all along, so
    // no correcting liveness-changed ever comes. The next keepalive must heal it.
    const store = new FleetStore();
    store.applySnapshot(
      snapshot([
        deviceSnap(
          "gw-01",
          [
            compSnap({ key: key("gw-01", "a"), liveness: "UNREACHABLE", lastStateAt: T0 - 60_000 }),
            compSnap({ key: key("gw-01", "b"), liveness: "UNREACHABLE", lastStateAt: T0 - 60_000 }),
          ],
          { unreachable: true, unreachableSince: T0 - 55_000 },
        ),
      ]),
      T0,
    );
    // Component "a" comes back: its state clears reachability (server batch order:
    // value-updated, then device-reachability-changed) - "b" gets aged to OFFLINE.
    store.applyDeltas(
      seqRun(11, [
        { type: "value-updated", at: T0 + 1000, key: key("gw-01", "a"), cls: "state" },
        {
          type: "device-reachability-changed",
          at: T0 + 1000,
          device: "gw-01",
          unreachable: false,
          componentCount: 2,
        },
      ]),
      T0 + 1000,
    );
    let byName = new Map(store.view().devices[0]!.components.map((c) => [c.key.component, c]));
    expect(byName.get("a")!.liveness).toBe("FRESH"); // its own state anchored the age
    expect(byName.get("b")!.liveness).toBe("OFFLINE"); // fill-in guess from a stale age
    // "b"'s keepalive arrives with NO liveness delta (the server never left FRESH).
    store.applyDeltas(
      seqRun(13, [{ type: "value-updated", at: T0 + 2000, key: key("gw-01", "b"), cls: "state" }]),
      T0 + 2000,
    );
    byName = new Map(store.view().devices[0]!.components.map((c) => [c.key.component, c]));
    expect(byName.get("b")!.liveness).toBe("FRESH"); // converged
  });

  it("a state arrival never un-stops a held STOPPED component by itself", () => {
    const store = liveStore();
    store.applyDeltas(
      seqRun(11, [
        { type: "liveness-changed", at: T0 + 1000, key: key(), from: "FRESH", to: "STOPPED" },
      ]),
      T0 + 1000,
    );
    // A duplicate graceful-stop state (value-updated with no transition) holds STOPPED.
    store.applyDeltas(
      seqRun(12, [{ type: "value-updated", at: T0 + 2000, key: key(), cls: "state" }]),
      T0 + 2000,
    );
    expect(firstComp(store).liveness).toBe("STOPPED");
    // A real restart carries the explicit STOPPED -> FRESH transition in-batch.
    store.applyDeltas(
      seqRun(13, [
        { type: "value-updated", at: T0 + 3000, key: key(), cls: "state" },
        { type: "liveness-changed", at: T0 + 3000, key: key(), from: "STOPPED", to: "FRESH" },
      ]),
      T0 + 3000,
    );
    expect(firstComp(store).liveness).toBe("FRESH");
    expect(firstComp(store).status).toBe("RUNNING");
  });

  it("deltas for a component the client has never seen create it defensively", () => {
    const store = liveStore();
    store.applyDeltas(
      seqRun(11, [
        {
          type: "liveness-changed",
          at: T0 + 100,
          key: key("gw-03", "surprise"),
          from: "FRESH",
          to: "WARN",
        },
      ]),
      T0 + 100,
    );
    const gw03 = store.view().devices.find((d) => d.device === "gw-03")!;
    expect(gw03.components[0]!.liveness).toBe("WARN");
  });

  it("noteHeartbeat refreshes the clock offset without touching the fleet", () => {
    const store = liveStore();
    const devicesBefore = store.view().devices;
    store.noteHeartbeat(T0 + 10_000, T0 + 10_250);
    const view = store.view();
    expect(view.clockOffsetMs).toBe(250);
    expect(view.devices).toEqual(devicesBefore);
  });
});

describe("ladderForAge", () => {
  it("applies the D5 thresholds around the expected interval", () => {
    const opts = DEFAULT_LADDER_OPTIONS;
    expect(ladderForAge(0, 5, opts)).toBe("FRESH");
    expect(ladderForAge(10_000, 5, opts)).toBe("FRESH"); // exactly 2x is not yet WARN
    expect(ladderForAge(10_001, 5, opts)).toBe("WARN");
    expect(ladderForAge(12_501, 5, opts)).toBe("STALE");
    expect(ladderForAge(25_001, 5, opts)).toBe("OFFLINE");
  });
});

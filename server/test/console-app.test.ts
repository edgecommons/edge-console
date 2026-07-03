import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageBuilder, MessageIdentity, Uns } from "@edgecommons/ggcommons";
import type { FleetDelta } from "@edgecommons/edge-console-protocol";

import { startConsole } from "../src/console-app";
import type { ConsoleApp } from "../src/console-app";
import { FakeBus, RAW_LWT, makeIdentity, wireEnvelope } from "./_fakes";

const CONSOLE_IDENTITY = new MessageIdentity([{ level: "device", value: "gw-01" }], "edge-console");

function start(bus: FakeBus, globalConfig: unknown = {}): Promise<ConsoleApp> {
  return startConsole({
    messaging: bus,
    uns: new Uns(CONSOLE_IDENTITY, false),
    newMessage: (name) => MessageBuilder.create(name, "1.0"),
    globalConfig,
    // clock defaults to Date.now, which vitest's fake timers control.
  });
}

describe("startConsole - the C1 composition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("wires bus -> normalizer -> FleetModel and auto-broadcasts republish per discovered device", async () => {
    const bus = new FakeBus();
    const app = await start(bus);

    await bus.emitWire(
      "ecv1/gw-02/press-17/main/state",
      wireEnvelope("state", makeIdentity("gw-02", "press-17"), { status: "RUNNING", uptimeSecs: 7 }),
    );

    const snap = app.model.snapshot();
    expect(snap.devices.map((d) => d.device)).toEqual(["gw-02"]);
    expect(snap.devices[0]!.components[0]!).toMatchObject({
      key: { device: "gw-02", component: "press-17", instance: "main" },
      liveness: "FRESH",
      uptimeSecs: 7,
    });

    // The G1 bootstrap: first sight of a device fires its republish pair.
    await vi.runOnlyPendingTimersAsync();
    expect(bus.published.map((p) => p.topic)).toEqual([
      "ecv1/gw-02/_bcast/main/cmd/republish-state",
      "ecv1/gw-02/_bcast/main/cmd/republish-cfg",
    ]);

    // A second device discovered via LWT gets its own broadcast too.
    await bus.emitWire("ecv1/gw-03/uns-bridge/main/state", RAW_LWT);
    await vi.runOnlyPendingTimersAsync();
    expect(bus.published.map((p) => p.topic)).toContain("ecv1/gw-03/_bcast/main/cmd/republish-state");

    await app.stop();
  });

  it("runs the sweeper on the configured cadence so components decay without traffic", async () => {
    const bus = new FakeBus();
    const app = await start(bus, {
      console: { staleness: { sweepIntervalMs: 250 } },
    });
    const deltas: FleetDelta[] = [];
    app.model.onDelta((batch) => deltas.push(...batch));

    await bus.emitWire(
      "ecv1/gw-02/press-17/main/state",
      wireEnvelope("state", makeIdentity("gw-02", "press-17"), { status: "RUNNING", uptimeSecs: 1 }),
    );

    // Default cadence 5 s: 26 s of silence crosses warn (10 s), stale (12.5 s), offline (25 s).
    await vi.advanceTimersByTimeAsync(26_000);
    const liveness = deltas.filter((d) => d.type === "liveness-changed");
    expect(liveness.map((d) => (d.type === "liveness-changed" ? d.to : ""))).toEqual([
      "WARN",
      "STALE",
      "OFFLINE",
    ]);

    await app.stop();
    // Stopped: no more sweeping, subscriptions gone.
    const count = deltas.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deltas.length).toBe(count);
    expect(bus.subscriptions.size).toBe(0);
    await app.stop(); // idempotent
  });

  it("applies component.global.console overrides to the model and exposes the parsed config", async () => {
    const bus = new FakeBus();
    const app = await start(bus, {
      console: {
        ws: { port: 9001, bindAddress: "127.0.0.1" },
        staleness: { defaultIntervalSecs: 1, sweepIntervalMs: 100 },
        cache: { maxChannelsPerComponent: 1 },
      },
    });
    expect(app.config.ws).toEqual({ port: 9001, bindAddress: "127.0.0.1" });

    await bus.emitWire(
      "ecv1/gw-02/press-17/main/data/a",
      wireEnvelope("d", makeIdentity("gw-02", "press-17"), { v: 1 }),
    );
    await bus.emitWire(
      "ecv1/gw-02/press-17/main/data/b",
      wireEnvelope("d", makeIdentity("gw-02", "press-17"), { v: 2 }),
    );
    const comp = app.model.snapshot().devices[0]!.components[0]!;
    expect(comp.values).toHaveLength(1); // capped at 1 distinct entry
    expect(comp.droppedChannels).toBe(1);

    // defaultIntervalSecs 1 => offline after > 5 s of silence.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(app.model.snapshot().devices[0]!.components[0]!.liveness).toBe("OFFLINE");

    await app.stop();
  });
});

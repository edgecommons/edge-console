import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageBuilder, MessageIdentity, Uns } from "@edgecommons/ggcommons";
import { PROTOCOL_VERSION } from "@edgecommons/edge-console-protocol";
import type { FleetDelta, ServerMessage } from "@edgecommons/edge-console-protocol";

import { startConsole } from "../src/console-app";
import type { ConsoleApp } from "../src/console-app";
import type { ClientTransport } from "../src/ws/gateway";
import { FakeBus, RAW_LWT, makeIdentity, wireEnvelope } from "./_fakes";

const CONSOLE_IDENTITY = new MessageIdentity([{ level: "device", value: "gw-01" }], "edge-console");

/**
 * The `console.ws` section every test below merges in: loopback (never `0.0.0.0`,
 * which some Windows configurations firewall-prompt on) so binding the real WS
 * gateway during these otherwise-pure composition tests is safe. Port `0` (OS-assigned
 * ephemeral - see `ws-server.test.ts`) isn't usable here: `consoleConfigFromGlobal`'s
 * `port()` validator correctly rejects `0` as a configured port (falls back to the
 * 8443 default) - that's production-correct (an operator-facing config must name a
 * real port), so tests instead use a fixed, unlikely-to-collide high port. Tests
 * within this file run sequentially (each awaits `app.stop()` before the next starts),
 * so reusing one port across them is safe.
 */
const SAFE_WS = { bindAddress: "127.0.0.1", port: 18743 };

/** Drain the microtask+macrotask queue (the C4 command result settles asynchronously). */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function start(bus: FakeBus, globalConfig: unknown = {}): Promise<ConsoleApp> {
  const g = globalConfig as { console?: Record<string, unknown> };
  const consoleSection = { ...g.console, ws: { ...SAFE_WS, ...(g.console?.ws as object | undefined) } };
  return startConsole({
    messaging: bus,
    uns: new Uns(CONSOLE_IDENTITY, false),
    newMessage: (name) => MessageBuilder.create(name, "1.0"),
    globalConfig: { ...g, console: consoleSection },
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
        ws: { heartbeatIntervalMs: 5000 },
        staleness: { defaultIntervalSecs: 1, sweepIntervalMs: 100 },
        cache: { maxChannelsPerComponent: 1 },
      },
    });
    expect(app.config.ws).toEqual({ ...SAFE_WS, heartbeatIntervalMs: 5000 });
    // The real WS gateway actually bound (ephemeral port assigned, > 0).
    expect(app.wsServer.address()?.port).toBeGreaterThan(0);
    expect(app.gateway.clientCount()).toBe(0);

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

  it("serves the C5 get/refresh round-trip: cfg retained from the bus, answered and pushed over the gateway, refresh fires the republish broadcast", async () => {
    const bus = new FakeBus();
    const app = await start(bus);
    const KEY = { device: "gw-02", component: "modbus-adapter", instance: "main" };
    const cfgBody = {
      config: {
        heartbeat: { intervalSecs: 5 },
        messaging: { local: { credentials: { password: "***" } } }, // lib-redacted
      },
    };

    // An in-memory transport straight into the app's REAL gateway (the ws socket
    // edge is ws-server.test.ts's concern).
    const sent: ServerMessage[] = [];
    const transport: ClientTransport = {
      id: "browser-1",
      send: (data) => sent.push(JSON.parse(data) as ServerMessage),
      bufferedAmount: () => 0,
      close: () => undefined,
    };
    const session = app.gateway.connect(transport);
    session.onMessage(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION }));

    // 1. Absence is answered honestly: nothing retained for the key yet.
    session.onMessage(
      JSON.stringify({ type: "get-config", protocolVersion: PROTOCOL_VERSION, key: KEY }),
    );
    expect(sent.at(-1)).toEqual({
      type: "config-unavailable",
      protocolVersion: PROTOCOL_VERSION,
      key: KEY,
    });

    // 2. The component announces cfg on the bus -> retained AND pushed to the
    //    interested client (interest was registered by the get-config above).
    await bus.emitWire("ecv1/gw-02/modbus-adapter/main/cfg", wireEnvelope("cfg", makeIdentity("gw-02", "modbus-adapter"), cfgBody));
    expect(app.configs.get(KEY)?.body).toEqual(cfgBody); // verbatim, redaction pass-through
    const push = sent.at(-1)!;
    expect(push).toMatchObject({ type: "config", key: KEY, cfg: cfgBody });
    expect(push.type === "config" && push.receivedAt).toBe(Date.now()); // fake-timer clock

    // 3. A later get-config is answered from retention.
    session.onMessage(
      JSON.stringify({ type: "get-config", protocolVersion: PROTOCOL_VERSION, key: KEY }),
    );
    expect(sent.at(-1)).toMatchObject({ type: "config", key: KEY, cfg: cfgBody });

    // 4. refresh-config drives the per-device republish broadcast on the bus (the
    //    re-pull; the device-discovery bootstrap already fired one pair — count both).
    await vi.runOnlyPendingTimersAsync(); // flush the discovery broadcast first
    const before = bus.published.filter((p) => p.topic === "ecv1/gw-02/_bcast/main/cmd/republish-cfg").length;
    session.onMessage(
      JSON.stringify({ type: "refresh-config", protocolVersion: PROTOCOL_VERSION, device: "gw-02" }),
    );
    await vi.runOnlyPendingTimersAsync();
    const after = bus.published.filter((p) => p.topic === "ecv1/gw-02/_bcast/main/cmd/republish-cfg").length;
    expect(after).toBe(before + 1);

    // 5. The re-pushed cfg (a component answering the broadcast) flows back as a push.
    const freshBody = { config: { heartbeat: { intervalSecs: 10 } } };
    await bus.emitWire("ecv1/gw-02/modbus-adapter/main/cfg", wireEnvelope("cfg", makeIdentity("gw-02", "modbus-adapter"), freshBody));
    expect(sent.at(-1)).toMatchObject({ type: "config", key: KEY, cfg: freshBody });

    await app.stop();
  });

  it("serves the C6 activity round-trip: evt/metric from the bus into the stores, backlog/snapshot answers, live streaming to subscribed clients", async () => {
    const bus = new FakeBus();
    const app = await start(bus);
    const identity = makeIdentity("gw-02", "opcua-adapter");
    const KEY = { device: "gw-02", component: "opcua-adapter", instance: "main" };

    // Bus -> stores, BEFORE any client: the rolling history / series accumulate.
    await bus.emitWire(
      "ecv1/gw-02/opcua-adapter/main/evt/warning/connection-retry",
      wireEnvelope("evt", identity, { message: "endpoint timeout, retrying" }),
    );
    await bus.emitWire(
      "ecv1/gw-02/opcua-adapter/main/metric/sys",
      wireEnvelope("Metric", identity, { coreName: "gw-02", cpu: 12.5, memory: 40, _aws: {} }),
    );
    expect(app.events.recent()).toHaveLength(1);
    expect(app.metrics.seriesCount()).toBe(2); // cpu + memory

    const sent: ServerMessage[] = [];
    const transport: ClientTransport = {
      id: "browser-1",
      send: (data) => sent.push(JSON.parse(data) as ServerMessage),
      bufferedAmount: () => 0,
      close: () => undefined,
    };
    const session = app.gateway.connect(transport);
    session.onMessage(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION }));

    // 1. subscribe-events answers the newest-first backlog.
    session.onMessage(
      JSON.stringify({ type: "subscribe-events", protocolVersion: PROTOCOL_VERSION }),
    );
    const backlog = sent.at(-1)!;
    expect(backlog).toMatchObject({ type: "events" });
    if (backlog.type !== "events") throw new Error("unreachable");
    expect(backlog.events[0]).toMatchObject({
      key: KEY,
      severity: "warning",
      type: "connection-retry",
      body: { message: "endpoint timeout, retrying" },
    });

    // 2. subscribe-metrics answers the latest+series snapshot.
    session.onMessage(
      JSON.stringify({ type: "subscribe-metrics", protocolVersion: PROTOCOL_VERSION }),
    );
    const snap = sent.at(-1)!;
    expect(snap).toMatchObject({ type: "metrics" });
    if (snap.type !== "metrics") throw new Error("unreachable");
    expect(snap.series.map((s) => s.measure)).toEqual(["cpu", "memory"]);
    expect(snap.series[0]).toMatchObject({ key: KEY, metric: "sys", latest: 12.5 });

    // 3. Later bus arrivals stream live to the subscribed client.
    await bus.emitWire(
      "ecv1/gw-02/opcua-adapter/main/evt/critical/overtemp",
      wireEnvelope("evt", identity, { valueC: 91 }),
    );
    expect(sent.at(-1)).toMatchObject({
      type: "event",
      event: { severity: "critical", type: "overtemp", body: { valueC: 91 } },
    });
    await bus.emitWire(
      "ecv1/gw-02/opcua-adapter/main/metric/sys",
      wireEnvelope("Metric", identity, { cpu: 20, memory: 41 }),
    );
    expect(sent.at(-1)).toMatchObject({
      type: "metric",
      updates: [
        { metric: "sys", measure: "cpu", point: { value: 20 } },
        { metric: "sys", measure: "memory", point: { value: 41 } },
      ],
    });

    // 4. Unsubscribing stops the streams (the connection stays up; the C2 delta
    //    stream continues — the same arrivals still tick the liveness cache, so
    //    only the ACTIVITY frames must stop).
    session.onMessage(
      JSON.stringify({ type: "unsubscribe-events", protocolVersion: PROTOCOL_VERSION }),
    );
    session.onMessage(
      JSON.stringify({ type: "unsubscribe-metrics", protocolVersion: PROTOCOL_VERSION }),
    );
    const activityCount = sent.filter((m) => m.type === "event" || m.type === "metric").length;
    await bus.emitWire(
      "ecv1/gw-02/opcua-adapter/main/evt/info/x",
      wireEnvelope("evt", identity, {}),
    );
    await bus.emitWire(
      "ecv1/gw-02/opcua-adapter/main/metric/sys",
      wireEnvelope("Metric", identity, { cpu: 1 }),
    );
    expect(sent.filter((m) => m.type === "event" || m.type === "metric")).toHaveLength(
      activityCount,
    );

    await app.stop();
  });

  it("serves the R0 round-trip: data→signals, metric→attributes, evt→alarms, and device-LWT containment", async () => {
    const bus = new FakeBus();
    const app = await start(bus);
    const identity = makeIdentity("gw-03", "opcua-adapter");
    const KEY = { device: "gw-03", component: "opcua-adapter", instance: "main" };

    // Bus -> the R0 stores (the same ingress tee that feeds the C1/C6 stores).
    await bus.emitWire(
      "ecv1/gw-03/opcua-adapter/main/data/Temp_01",
      wireEnvelope("data", identity, { value: 20.4, quality: "GOOD" }),
    );
    await bus.emitWire(
      "ecv1/gw-03/opcua-adapter/main/metric/sys",
      wireEnvelope("Metric", identity, { cpu: 33, memory: 128, _aws: {} }),
    );
    await bus.emitWire(
      "ecv1/gw-03/opcua-adapter/main/evt/critical/connection-lost",
      wireEnvelope("evt", identity, { message: "session dropped" }),
    );
    expect(app.signals.seriesCount()).toBe(1);
    expect(app.attributes.componentCount()).toBe(1);
    expect(app.alarms.activeCount()).toBe(1);

    const sent: ServerMessage[] = [];
    const transport: ClientTransport = {
      id: "browser-1",
      send: (data) => sent.push(JSON.parse(data) as ServerMessage),
      bufferedAmount: () => 0,
      close: () => undefined,
    };
    const session = app.gateway.connect(transport);
    session.onMessage(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION }));

    // subscribe-signals -> the data-plane snapshot.
    session.onMessage(JSON.stringify({ type: "subscribe-signals", protocolVersion: PROTOCOL_VERSION }));
    const sig = sent.at(-1)!;
    expect(sig.type).toBe("signals");
    if (sig.type !== "signals") throw new Error("unreachable");
    expect(sig.series[0]).toMatchObject({ key: KEY, signal: "Temp_01", latest: 20.4, quality: "GOOD" });

    // subscribe-attributes -> the runtime-attribute projection.
    session.onMessage(JSON.stringify({ type: "subscribe-attributes", protocolVersion: PROTOCOL_VERSION }));
    const attr = sent.at(-1)!;
    expect(attr.type).toBe("attributes");
    if (attr.type !== "attributes") throw new Error("unreachable");
    expect(attr.components[0]).toMatchObject({ key: KEY, cpuPercent: 33, memoryMb: 128 });

    // subscribe-alarms -> the active alarm + counts.
    session.onMessage(JSON.stringify({ type: "subscribe-alarms", protocolVersion: PROTOCOL_VERSION }));
    const al = sent.at(-1)!;
    expect(al.type).toBe("alarms");
    if (al.type !== "alarms") throw new Error("unreachable");
    expect(al.snapshot.counts).toMatchObject({ critical: 1, active: 1, contained: 0 });

    // The bridge LWT marks the device UNREACHABLE -> the FleetModel reachability delta
    // drives alarm CONTAINMENT (the alarm leaves the active counts, streamed live as a
    // fresh `alarms` frame — the C2 `delta` frame for the same transition follows it).
    await bus.emitWire("ecv1/gw-03/uns-bridge/main/state", RAW_LWT);
    const contained = sent.filter((m) => m.type === "alarms").at(-1)!;
    if (contained.type !== "alarms") throw new Error("unreachable");
    expect(contained.snapshot.counts).toMatchObject({ active: 0, contained: 1 });

    await app.stop();
  });
});

describe("startConsole - the C4 command round-trip", () => {
  // Real timers here: the command result settles across microtasks/`setImmediate`.
  it("invoke-command → messaging.request on the site bus → command-result", async () => {
    const bus = new FakeBus();
    bus.requestHandler = () =>
      MessageBuilder.create("ping", "1.0")
        .withPayload({ ok: true, result: { status: "RUNNING", uptimeSecs: 99 } })
        .build();
    const app = await start(bus);
    const KEY = { device: "gw-02", component: "opcua-adapter", instance: "main" };

    const sent: ServerMessage[] = [];
    const transport: ClientTransport = {
      id: "browser-1",
      send: (data) => sent.push(JSON.parse(data) as ServerMessage),
      bufferedAmount: () => 0,
      close: () => undefined,
    };
    const session = app.gateway.connect(transport, "operator");
    session.onMessage(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION }));
    session.onMessage(
      JSON.stringify({
        type: "invoke-command",
        protocolVersion: PROTOCOL_VERSION,
        requestId: "c1",
        key: KEY,
        verb: "ping",
      }),
    );

    await flush();
    const result = sent.find((m) => m.type === "command-result");
    expect(result).toMatchObject({
      type: "command-result",
      requestId: "c1",
      key: KEY,
      verb: "ping",
      ok: true,
      result: { status: "RUNNING", uptimeSecs: 99 },
    });
    // The request was addressed to the target's own cmd inbox on the site bus.
    expect(bus.requests[0]!.topic).toBe("ecv1/gw-02/opcua-adapter/main/cmd/ping");

    await app.stop();
  });

  it("a viewer-default deployment forbids reload-config before the bus", async () => {
    const bus = new FakeBus();
    const app = await start(bus, {
      console: {
        rbac: {
          defaultRole: "viewer",
          roles: { viewer: { allow: ["ping", "get-configuration"] }, operator: { allow: ["*"] } },
        },
      },
    });

    const sent: ServerMessage[] = [];
    const transport: ClientTransport = {
      id: "browser-1",
      send: (data) => sent.push(JSON.parse(data) as ServerMessage),
      bufferedAmount: () => 0,
      close: () => undefined,
    };
    // No explicit role ⇒ the gateway falls back to the RBAC defaultRole ("viewer").
    const session = app.gateway.connect(transport);
    session.onMessage(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION }));
    session.onMessage(
      JSON.stringify({
        type: "invoke-command",
        protocolVersion: PROTOCOL_VERSION,
        requestId: "c2",
        key: { device: "gw-02", component: "opcua-adapter", instance: "main" },
        verb: "reload-config",
      }),
    );
    await flush();

    expect(sent.find((m) => m.type === "command-result")).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN" },
    });
    expect(bus.requests).toHaveLength(0); // denied before any request

    await app.stop();
  });
});

describe("startConsole - end-to-end static UI serving (console.ws.webRoot)", () => {
  // Real timers: this drives the real bound WsServer over an actual loopback socket.
  it("wires config.ws.webRoot through to the real WsServer AND into the settings projection", async () => {
    const root = mkdtempSync(join(tmpdir(), "edge-console-app-ui-"));
    writeFileSync(join(root, "index.html"), "<!doctype html><body>hi</body>", "utf8");
    try {
      const bus = new FakeBus();
      const app = await start(bus, { console: { ws: { webRoot: root } } });
      expect(app.config.ws.webRoot).toBe(root);

      const addr = app.wsServer.address();
      expect(addr).not.toBeNull();
      const res = await fetch(`http://127.0.0.1:${addr!.port}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("<!doctype html><body>hi</body>");

      // The R6 Settings projection reflects it honestly.
      const sent: ServerMessage[] = [];
      const transport: ClientTransport = {
        id: "browser-1",
        send: (data) => sent.push(JSON.parse(data) as ServerMessage),
        bufferedAmount: () => 0,
        close: () => undefined,
      };
      const session = app.gateway.connect(transport, "operator");
      session.onMessage(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION }));
      const settingsMsg = sent.find((m) => m.type === "settings");
      expect(settingsMsg?.type === "settings" && settingsMsg.settings.connection.servesUi).toBe(true);

      await app.stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

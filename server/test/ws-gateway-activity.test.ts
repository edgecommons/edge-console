/**
 * The C6 activity message family on the WS gateway: `subscribe-events` answered
 * with the newest-first backlog + live `event` streaming to subscribed clients
 * only, `subscribe-metrics` answered with the latest+series snapshot + live
 * `metric` batches, both unsubscribable and per-connection. (`ws-gateway.test.ts`
 * owns the C2 surface; `ws-gateway-config.test.ts` the C5 family.)
 */
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@edgecommons/edge-console-protocol";
import type { ComponentKey, ServerMessage } from "@edgecommons/edge-console-protocol";

import { EventStore } from "../src/fleet/event-store";
import { MetricStore } from "../src/fleet/metric-store";
import { LogStore } from "../src/fleet/log-store";
import { FleetModel } from "../src/fleet/fleet-model";
import type { IngressEvent } from "../src/ingress/normalizer";
import { FleetWsGateway } from "../src/ws/gateway";
import type { ClientTransport } from "../src/ws/gateway";

class TestClock {
  now = 1_000_000;
  tick(ms: number): void {
    this.now += ms;
  }
  fn = (): number => this.now;
}

class FakeTransport implements ClientTransport {
  readonly sent: string[] = [];
  closed: { code: number; reason: string } | undefined;
  buffered = 0;

  constructor(readonly id: string) {}

  send(data: string): void {
    this.sent.push(data);
  }
  bufferedAmount(): number {
    return this.buffered;
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  messages(): ServerMessage[] {
    return this.sent.map((s) => JSON.parse(s) as ServerMessage);
  }
}

const KEY: ComponentKey = { device: "gw-01", component: "opcua-adapter", instance: "main" };

function evtEvent(channel: string, body: unknown = {}): IngressEvent {
  return {
    kind: "envelope",
    cls: "evt",
    channel,
    identity: {
      hier: [{ level: "device", value: KEY.device }],
      path: KEY.device,
      component: KEY.component,
      instance: KEY.instance,
    },
    body,
    topic: `ecv1/${KEY.device}/${KEY.component}/${KEY.instance}/evt/${channel}`,
  };
}

function metricEvent(name: string, body: unknown): IngressEvent {
  return {
    ...evtEvent("x", body),
    cls: "metric",
    channel: name,
    topic: `ecv1/${KEY.device}/${KEY.component}/${KEY.instance}/metric/${name}`,
  };
}

function logEvent(level: string, message: string, sequence: number, key: ComponentKey = KEY): IngressEvent {
  return {
    ...evtEvent(level, {
      schema: "edgecommons.log.v1",
      timestamp: "2026-07-03T00:00:00.000Z",
      logger: "opcua.session",
      message,
      sequence,
    }),
    cls: "log",
    channel: level,
    identity: {
      hier: [{ level: "device", value: key.device }],
      path: key.device,
      component: key.component,
      instance: key.instance ?? "main",
    },
    topic: `ecv1/${key.device}/${key.component}/${key.instance ?? "main"}/log/${level}`,
  };
}

function frame(msg: Record<string, unknown>): string {
  return JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...msg });
}

/** A gateway wired the composition-root way: model + event + metric stores. */
function rig() {
  const clock = new TestClock();
  const model = new FleetModel(clock.fn);
  const events = new EventStore(clock.fn);
  const metrics = new MetricStore(clock.fn);
  const logs = new LogStore(clock.fn);
  const gateway = new FleetWsGateway(model, { clock: clock.fn }, undefined, { events, metrics, logs });
  return { clock, model, events, metrics, logs, gateway };
}

function connectReady(gateway: FleetWsGateway, id: string) {
  const t = new FakeTransport(id);
  const session = gateway.connect(t);
  session.onMessage(frame({ type: "hello" }));
  return { t, session };
}

describe("FleetWsGateway - subscribe-events", () => {
  it("answers the newest-first backlog (limit honored) and streams later arrivals", () => {
    const { events, gateway } = rig();
    events.ingest(evtEvent("info/e1"));
    events.ingest(evtEvent("warning/e2"));
    events.ingest(evtEvent("critical/e3"));

    const { t, session } = connectReady(gateway, "c1");
    session.onMessage(frame({ type: "subscribe-events", limit: 2 }));

    const backlog = t.messages().at(-1)!;
    expect(backlog.type).toBe("events");
    if (backlog.type !== "events") throw new Error("unreachable");
    expect(backlog.events.map((e) => e.type)).toEqual(["e3", "e2"]); // newest-first, capped

    // A live arrival streams as an `event` frame.
    events.ingest(evtEvent("error/e4", { message: "live" }));
    const push = t.messages().at(-1)!;
    expect(push).toMatchObject({
      type: "event",
      protocolVersion: PROTOCOL_VERSION,
      event: { severity: "error", type: "e4", body: { message: "live" } },
    });
  });

  it("streams only to subscribed clients; unsubscribe stops the stream", () => {
    const { events, gateway } = rig();
    const a = connectReady(gateway, "a");
    const b = connectReady(gateway, "b");
    a.session.onMessage(frame({ type: "subscribe-events" }));

    const aBefore = a.t.sent.length;
    const bBefore = b.t.sent.length;
    events.ingest(evtEvent("info/one"));
    expect(a.t.sent.length).toBe(aBefore + 1);
    expect(b.t.sent.length).toBe(bBefore); // never subscribed — nothing

    a.session.onMessage(frame({ type: "unsubscribe-events" }));
    const aAfterUnsub = a.t.sent.length;
    events.ingest(evtEvent("info/two"));
    expect(a.t.sent.length).toBe(aAfterUnsub); // unsubscribed — stream stopped
    expect(a.t.closed).toBeUndefined(); // unsubscribe is not an error
  });

  it("interest dies with the connection (onClose) and with stop()", () => {
    const { events, gateway } = rig();
    const a = connectReady(gateway, "a");
    a.session.onMessage(frame({ type: "subscribe-events" }));
    a.session.onClose();
    events.ingest(evtEvent("info/one"));
    expect(a.t.messages().filter((m) => m.type === "event")).toHaveLength(0);

    const b = connectReady(gateway, "b");
    b.session.onMessage(frame({ type: "subscribe-events" }));
    gateway.stop();
    const after = b.t.sent.length;
    events.ingest(evtEvent("info/two"));
    expect(b.t.sent.length).toBe(after); // detached from the store entirely
  });
});

describe("FleetWsGateway - subscribe-metrics", () => {
  it("answers the latest+series snapshot and streams later sample batches", () => {
    const { clock, metrics, gateway } = rig();
    metrics.ingest(metricEvent("sys", { cpu_usage: 10, memory_usage: 40 }));
    clock.tick(5000);

    const { t, session } = connectReady(gateway, "c1");
    session.onMessage(frame({ type: "subscribe-metrics" }));

    const snap = t.messages().at(-1)!;
    expect(snap.type).toBe("metrics");
    if (snap.type !== "metrics") throw new Error("unreachable");
    expect(snap.series.map((s) => s.measure)).toEqual(["cpu_usage", "memory_usage"]);
    expect(snap.series[0]).toMatchObject({ metric: "sys", latest: 10 });

    metrics.ingest(metricEvent("sys", { cpu_usage: 22, memory_usage: 41 }));
    const push = t.messages().at(-1)!;
    expect(push).toMatchObject({
      type: "metric",
      updates: [
        { metric: "sys", measure: "cpu_usage", point: { at: 1_005_000, value: 22 } },
        { metric: "sys", measure: "memory_usage", point: { at: 1_005_000, value: 41 } },
      ],
    });
  });

  it("streams only to subscribed clients; unsubscribe stops the stream", () => {
    const { metrics, gateway } = rig();
    const a = connectReady(gateway, "a");
    const b = connectReady(gateway, "b");
    a.session.onMessage(frame({ type: "subscribe-metrics" }));

    const bBefore = b.t.sent.length;
    metrics.ingest(metricEvent("sys", { cpu_usage: 1 }));
    expect(a.t.messages().at(-1)!.type).toBe("metric");
    expect(b.t.sent.length).toBe(bBefore);

    a.session.onMessage(frame({ type: "unsubscribe-metrics" }));
    const aAfter = a.t.sent.length;
    metrics.ingest(metricEvent("sys", { cpu_usage: 2 }));
    expect(a.t.sent.length).toBe(aAfter);
  });
});

describe("FleetWsGateway - subscribe-logs", () => {
  it("answers a component log tail snapshot and streams later matching records", () => {
    const { logs, gateway } = rig();
    logs.ingest(logEvent("info", "adapter ready", 1));
    logs.ingest(logEvent("warn", "browse slow", 2));

    const { t, session } = connectReady(gateway, "c1");
    session.onMessage(
      frame({ type: "subscribe-logs", key: KEY, limit: 5, levels: ["warn", "error"] }),
    );

    const snap = t.messages().at(-1)!;
    expect(snap.type).toBe("logs");
    if (snap.type !== "logs") throw new Error("unreachable");
    expect(snap.key).toEqual({ device: KEY.device, component: KEY.component });
    expect(snap.records.map((r) => r.message)).toEqual(["browse slow"]);

    const afterSnap = t.sent.length;
    logs.ingest(logEvent("info", "filtered out", 3));
    expect(t.sent.length).toBe(afterSnap);

    logs.ingest(logEvent("error", "live failure", 4));
    const push = t.messages().at(-1)!;
    expect(push).toMatchObject({
      type: "log",
      key: { device: KEY.device, component: KEY.component },
      records: [{ level: "error", message: "live failure" }],
    });
  });

  it("streams only to subscribed component keys; unsubscribe stops the stream", () => {
    const { logs, gateway } = rig();
    const a = connectReady(gateway, "a");
    const b = connectReady(gateway, "b");
    a.session.onMessage(frame({ type: "subscribe-logs", key: KEY }));

    const beforeB = b.t.sent.length;
    logs.ingest(logEvent("info", "one", 1));
    expect(a.t.messages().at(-1)!.type).toBe("log");
    expect(b.t.sent.length).toBe(beforeB);

    a.session.onMessage(frame({ type: "unsubscribe-logs", key: KEY }));
    const afterUnsub = a.t.sent.length;
    logs.ingest(logEvent("info", "two", 2));
    expect(a.t.sent.length).toBe(afterUnsub);
  });

  it("refreshes a skipped live log subscription with a snapshot on heartbeat", () => {
    const { logs, gateway } = rig();
    const { t, session } = connectReady(gateway, "c1");
    session.onMessage(frame({ type: "subscribe-logs", key: KEY }));
    const afterSnapshot = t.sent.length;

    t.buffered = 2_000_000;
    logs.ingest(logEvent("error", "missed while buffered", 1));
    expect(t.sent.length).toBe(afterSnapshot);

    t.buffered = 0;
    gateway.tick();
    const messages = t.messages();
    expect(messages.at(-2)).toMatchObject({ type: "heartbeat" });
    expect(messages.at(-1)).toMatchObject({
      type: "logs",
      records: [{ message: "missed while buffered" }],
    });
  });
});

describe("FleetWsGateway - activity handshake and degraded modes", () => {
  it("rejects subscribe-events before hello", () => {
    const { gateway } = rig();
    const t = new FakeTransport("c1");
    gateway.connect(t).onMessage(frame({ type: "subscribe-events" }));
    expect(t.messages()[0]).toMatchObject({ type: "error", code: "malformed" });
    expect(t.closed?.code).toBe(4000);
  });

  it("rejects a malformed subscribe-events limit", () => {
    const { gateway } = rig();
    const { t, session } = connectReady(gateway, "c1");
    session.onMessage(frame({ type: "subscribe-events", limit: 0 }));
    expect(t.messages().at(-1)).toMatchObject({ type: "error", code: "malformed" });
  });

  it("rejects a version-skewed subscribe-metrics distinctly", () => {
    const { gateway } = rig();
    const { t, session } = connectReady(gateway, "c1");
    session.onMessage(
      JSON.stringify({ type: "subscribe-metrics", protocolVersion: PROTOCOL_VERSION + 1 }),
    );
    expect(t.messages().at(-1)).toMatchObject({ type: "error", code: "unsupported-protocol-version" });
  });

  it("without the activity seam the gateway still answers honestly: empty backlog/snapshot, no pushes", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    const gateway = new FleetWsGateway(model, { clock: clock.fn }); // no ActivityGatewayDeps
    const { t, session } = connectReady(gateway, "c1");

    session.onMessage(frame({ type: "subscribe-events" }));
    expect(t.messages().at(-1)).toEqual({
      type: "events",
      protocolVersion: PROTOCOL_VERSION,
      events: [],
    });

    session.onMessage(frame({ type: "subscribe-metrics" }));
    expect(t.messages().at(-1)).toEqual({
      type: "metrics",
      protocolVersion: PROTOCOL_VERSION,
      series: [],
    });

    session.onMessage(frame({ type: "unsubscribe-events" })); // must not throw
    session.onMessage(frame({ type: "unsubscribe-metrics" }));
    session.onMessage(frame({ type: "subscribe-logs", key: KEY }));
    expect(t.messages().at(-1)).toMatchObject({
      type: "logs-unavailable",
      key: { device: KEY.device, component: KEY.component },
      code: "UNAVAILABLE",
    });
    session.onMessage(frame({ type: "unsubscribe-logs", key: KEY }));
    expect(t.closed).toBeUndefined();
  });
});

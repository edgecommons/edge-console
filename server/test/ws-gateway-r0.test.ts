/**
 * The R0 activity families on the WS gateway: `subscribe-signals` (data plane),
 * `subscribe-attributes` (runtime attributes), and `subscribe-alarms` + `ack-alarm`
 * (console-side alarms) — snapshot reply + per-connection live streaming, plus the
 * degraded modes when a given source is absent. (`ws-gateway-activity.test.ts` owns the
 * C6 events/metrics families; this file owns the R0 additions.)
 */
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@edgecommons/edge-console-protocol";
import type { ComponentKey, ConsumerClass, ServerMessage } from "@edgecommons/edge-console-protocol";

import { FleetModel } from "../src/fleet/fleet-model";
import { EventStore } from "../src/fleet/event-store";
import { MetricStore } from "../src/fleet/metric-store";
import { SignalStore } from "../src/fleet/signal-store";
import { AttributeStore } from "../src/fleet/attribute-store";
import { AlarmTracker } from "../src/fleet/alarm-tracker";
import type { IngressEvent } from "../src/ingress/normalizer";
import { FleetWsGateway } from "../src/ws/gateway";
import type { ClientTransport } from "../src/ws/gateway";

class TestClock {
  now = 1_000_000;
  fn = (): number => this.now;
}

class FakeTransport implements ClientTransport {
  readonly sent: string[] = [];
  closed: { code: number; reason: string } | undefined;
  constructor(readonly id: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  bufferedAmount(): number {
    return 0;
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  messages(): ServerMessage[] {
    return this.sent.map((s) => JSON.parse(s) as ServerMessage);
  }
}

const KEY: ComponentKey = { device: "gw-01", component: "opcua-adapter", instance: "main" };

function envelope(cls: ConsumerClass, channel: string, body: unknown): IngressEvent {
  return {
    kind: "envelope",
    cls,
    channel,
    identity: {
      hier: [{ level: "device", value: KEY.device }],
      path: KEY.device,
      component: KEY.component,
      instance: KEY.instance,
    },
    body,
    topic: `ecv1/${KEY.device}/${KEY.component}/${KEY.instance}/${cls}/${channel}`,
  };
}

function frame(msg: Record<string, unknown>): string {
  return JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...msg });
}

function rig() {
  const clock = new TestClock();
  const model = new FleetModel(clock.fn);
  const events = new EventStore(clock.fn);
  const metrics = new MetricStore(clock.fn);
  const signals = new SignalStore(clock.fn);
  const attributes = new AttributeStore(clock.fn);
  const alarms = new AlarmTracker(clock.fn);
  const gateway = new FleetWsGateway(model, { clock: clock.fn }, undefined, {
    events,
    metrics,
    signals,
    attributes,
    alarms,
  });
  return { clock, model, signals, attributes, alarms, gateway };
}

function connectReady(gateway: FleetWsGateway, id: string, role?: string) {
  const t = new FakeTransport(id);
  const session = gateway.connect(t, role);
  session.onMessage(frame({ type: "hello" }));
  return { t, session };
}

describe("FleetWsGateway - welcome handshake", () => {
  it("sends the connection's role in a welcome frame on hello", () => {
    const { gateway } = rig();
    const { t } = connectReady(gateway, "c1", "viewer");
    expect(t.messages()[0]).toEqual({ type: "welcome", protocolVersion: PROTOCOL_VERSION, role: "viewer" });
  });
});

describe("FleetWsGateway - subscribe-signals (R0 data plane)", () => {
  it("answers the snapshot and streams later samples to subscribed clients only", () => {
    const { signals, gateway } = rig();
    signals.ingest(envelope("data", "Temp_01", { value: 20, quality: "GOOD" }));

    const a = connectReady(gateway, "a");
    const b = connectReady(gateway, "b");
    a.session.onMessage(frame({ type: "subscribe-signals" }));

    const snap = a.t.messages().at(-1)!;
    expect(snap.type).toBe("signals");
    if (snap.type !== "signals") throw new Error("unreachable");
    expect(snap.series[0]).toMatchObject({ signal: "Temp_01", latest: 20, quality: "GOOD" });

    const bBefore = b.t.sent.length;
    signals.ingest(envelope("data", "Temp_01", { value: 21, quality: "GOOD" }));
    expect(a.t.messages().at(-1)).toMatchObject({ type: "signal", updates: [{ signal: "Temp_01" }] });
    expect(b.t.sent.length).toBe(bBefore); // never subscribed

    a.session.onMessage(frame({ type: "unsubscribe-signals" }));
    const aAfter = a.t.sent.length;
    signals.ingest(envelope("data", "Temp_01", { value: 22, quality: "GOOD" }));
    expect(a.t.sent.length).toBe(aAfter);
  });
});

describe("FleetWsGateway - subscribe-attributes (R0)", () => {
  it("answers the snapshot and streams attribute updates", () => {
    const { attributes, gateway } = rig();
    attributes.ingest(envelope("metric", "sys", { cpu: 22, memory: 180 }));

    const { t, session } = connectReady(gateway, "c1");
    session.onMessage(frame({ type: "subscribe-attributes" }));
    const snap = t.messages().at(-1)!;
    expect(snap.type).toBe("attributes");
    if (snap.type !== "attributes") throw new Error("unreachable");
    expect(snap.components[0]).toMatchObject({ cpuPercent: 22, memoryMb: 180 });

    attributes.ingest(envelope("metric", "sys", { cpu: 40 }));
    expect(t.messages().at(-1)).toMatchObject({ type: "attribute", updates: [{ cpuPercent: 40 }] });

    session.onMessage(frame({ type: "unsubscribe-attributes" }));
    const after = t.sent.length;
    attributes.ingest(envelope("metric", "sys", { cpu: 50 }));
    expect(t.sent.length).toBe(after);
  });
});

describe("FleetWsGateway - subscribe-alarms + ack-alarm (R0)", () => {
  it("answers the snapshot, streams changes, and ack re-pushes the fresh snapshot", () => {
    const { alarms, gateway } = rig();
    alarms.ingest(envelope("evt", "critical/connection-lost", { message: "down" }));

    const { t, session } = connectReady(gateway, "c1");
    session.onMessage(frame({ type: "subscribe-alarms" }));
    const snap = t.messages().at(-1)!;
    expect(snap.type).toBe("alarms");
    if (snap.type !== "alarms") throw new Error("unreachable");
    expect(snap.snapshot.counts).toMatchObject({ critical: 1, active: 1 });
    const alarmId = snap.snapshot.active[0]!.id;

    // A live raise streams as a fresh `alarms` frame.
    alarms.ingest(envelope("evt", "warning/slave-retry"));
    expect(t.messages().at(-1)).toMatchObject({ type: "alarms", snapshot: { counts: { active: 2 } } });

    // ack-alarm re-pushes with the alarm now acked (no separate reply frame).
    session.onMessage(frame({ type: "ack-alarm", alarmId }));
    const acked = t.messages().at(-1)!;
    expect(acked.type).toBe("alarms");
    if (acked.type !== "alarms") throw new Error("unreachable");
    expect(acked.snapshot.counts.acked).toBe(1);

    session.onMessage(frame({ type: "unsubscribe-alarms" }));
    const after = t.sent.length;
    alarms.ingest(envelope("evt", "critical/overtemp"));
    expect(t.sent.length).toBe(after);
  });
});

describe("FleetWsGateway - R0 degraded modes (no sources)", () => {
  it("without the R0 sources the gateway answers honestly: empty snapshots, no pushes, ack is a no-op", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    const events = new EventStore(clock.fn);
    const metrics = new MetricStore(clock.fn);
    // Activity seam present but WITHOUT the R0 sources.
    const gateway = new FleetWsGateway(model, { clock: clock.fn }, undefined, { events, metrics });
    const { t, session } = connectReady(gateway, "c1");

    session.onMessage(frame({ type: "subscribe-signals" }));
    expect(t.messages().at(-1)).toEqual({ type: "signals", protocolVersion: PROTOCOL_VERSION, series: [] });
    session.onMessage(frame({ type: "subscribe-attributes" }));
    expect(t.messages().at(-1)).toEqual({
      type: "attributes",
      protocolVersion: PROTOCOL_VERSION,
      components: [],
    });
    session.onMessage(frame({ type: "subscribe-alarms" }));
    expect(t.messages().at(-1)).toEqual({
      type: "alarms",
      protocolVersion: PROTOCOL_VERSION,
      snapshot: { active: [], counts: { critical: 0, warning: 0, active: 0, contained: 0, acked: 0 } },
    });
    session.onMessage(frame({ type: "ack-alarm", alarmId: "x" })); // must not throw
    session.onMessage(frame({ type: "unsubscribe-signals" }));
    session.onMessage(frame({ type: "unsubscribe-attributes" }));
    session.onMessage(frame({ type: "unsubscribe-alarms" }));
    expect(t.closed).toBeUndefined();
  });
});

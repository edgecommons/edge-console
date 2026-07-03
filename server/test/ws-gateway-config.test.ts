/**
 * The C5 config message family on the WS gateway: `get-config` answered from the
 * retained-cfg cache (or `config-unavailable`), per-connection interest + push on
 * fresh `cfg` arrivals, and `refresh-config` -> the injected re-pull trigger.
 * (`ws-gateway.test.ts` owns the C2 snapshot/delta/backpressure surface.)
 */
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, componentKeyId } from "@edgecommons/edge-console-protocol";
import type { ComponentKey, ServerMessage } from "@edgecommons/edge-console-protocol";

import { ConfigStore } from "../src/fleet/config-store";
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

const KEY: ComponentKey = { device: "gw-01", component: "modbus-adapter", instance: "main" };

function cfgEvent(body: unknown, key: ComponentKey = KEY): IngressEvent {
  return {
    kind: "envelope",
    cls: "cfg",
    identity: {
      hier: [{ level: "device", value: key.device }],
      path: key.device,
      component: key.component,
      instance: key.instance,
    },
    body,
    topic: `ecv1/${key.device}/${key.component}/${key.instance}/cfg`,
  };
}

function hello(): string {
  return JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION });
}
function getConfig(key: ComponentKey = KEY, protocolVersion = PROTOCOL_VERSION): string {
  return JSON.stringify({ type: "get-config", protocolVersion, key });
}
function refreshConfig(device: string): string {
  return JSON.stringify({ type: "refresh-config", protocolVersion: PROTOCOL_VERSION, device });
}

/** A gateway wired the composition-root way: model + config store + refresh recorder. */
function rig() {
  const clock = new TestClock();
  const model = new FleetModel(clock.fn);
  const configs = new ConfigStore(clock.fn);
  const refreshed: string[] = [];
  const gateway = new FleetWsGateway(
    model,
    { clock: clock.fn },
    { configs, refreshDevice: (device) => refreshed.push(device) },
  );
  return { clock, model, configs, refreshed, gateway };
}

describe("FleetWsGateway - get-config", () => {
  it("answers config-unavailable for a component that never pushed cfg", () => {
    const { gateway } = rig();
    const t = new FakeTransport("c1");
    const session = gateway.connect(t);
    session.onMessage(hello());
    session.onMessage(getConfig());

    const last = t.messages().at(-1)!;
    expect(last).toEqual({
      type: "config-unavailable",
      protocolVersion: PROTOCOL_VERSION,
      key: KEY,
    });
    expect(t.closed).toBeUndefined(); // absence is an answer, not an error
  });

  it("answers the retained cfg body verbatim with its receipt stamp", () => {
    const { clock, configs, gateway } = rig();
    configs.ingest(cfgEvent({ config: { heartbeat: { intervalSecs: 5 }, password: "***" } }));
    const receivedAt = clock.now;
    clock.tick(60_000); // the answer carries the RECEIPT time, not "now"

    const t = new FakeTransport("c1");
    const session = gateway.connect(t);
    session.onMessage(hello());
    session.onMessage(getConfig());

    expect(t.messages().at(-1)).toEqual({
      type: "config",
      protocolVersion: PROTOCOL_VERSION,
      key: KEY,
      cfg: { config: { heartbeat: { intervalSecs: 5 }, password: "***" } },
      receivedAt,
    });
  });

  it("pushes a fresh cfg arrival to clients that requested that key - and only that key", () => {
    const { configs, gateway } = rig();
    const otherKey: ComponentKey = { device: "gw-02", component: "opcua-adapter", instance: "main" };

    const a = new FakeTransport("a"); // interested in KEY
    const b = new FakeTransport("b"); // interested in a different key
    const c = new FakeTransport("c"); // never interested
    const sa = gateway.connect(a);
    const sb = gateway.connect(b);
    const sc = gateway.connect(c);
    sa.onMessage(hello());
    sb.onMessage(hello());
    sc.onMessage(hello());
    sa.onMessage(getConfig(KEY));
    sb.onMessage(getConfig(otherKey));

    const aBefore = a.sent.length;
    const bBefore = b.sent.length;
    const cBefore = c.sent.length;

    configs.ingest(cfgEvent({ config: { rev: 7 } }));

    expect(a.sent.length).toBe(aBefore + 1);
    expect(a.messages().at(-1)).toMatchObject({
      type: "config",
      key: KEY,
      cfg: { config: { rev: 7 } },
    });
    expect(b.sent.length).toBe(bBefore); // different key — no push
    expect(c.sent.length).toBe(cBefore); // never interested — no push
  });

  it("a config-unavailable answer still registers interest: the first push flips it", () => {
    const { configs, gateway } = rig();
    const t = new FakeTransport("c1");
    const session = gateway.connect(t);
    session.onMessage(hello());
    session.onMessage(getConfig());
    expect(t.messages().at(-1)!.type).toBe("config-unavailable");

    configs.ingest(cfgEvent({ config: { arrived: true } }));
    expect(t.messages().at(-1)).toMatchObject({ type: "config", cfg: { config: { arrived: true } } });
  });

  it("interest dies with the connection (onClose) and with stop()", () => {
    const { configs, gateway } = rig();
    const t = new FakeTransport("c1");
    const session = gateway.connect(t);
    session.onMessage(hello());
    session.onMessage(getConfig());
    session.onClose();

    configs.ingest(cfgEvent({ config: { rev: 1 } }));
    expect(t.messages().filter((m) => m.type === "config")).toHaveLength(0);

    // stop() detaches the ConfigStore listener entirely.
    const t2 = new FakeTransport("c2");
    const s2 = gateway.connect(t2);
    s2.onMessage(hello());
    s2.onMessage(getConfig());
    gateway.stop();
    const countAfterStop = t2.sent.length;
    configs.ingest(cfgEvent({ config: { rev: 2 } }));
    expect(t2.sent.length).toBe(countAfterStop);
  });
});

describe("FleetWsGateway - refresh-config", () => {
  it("triggers the injected per-device re-pull (fire-and-forget, no direct reply)", () => {
    const { gateway, refreshed } = rig();
    const t = new FakeTransport("c1");
    const session = gateway.connect(t);
    session.onMessage(hello());
    const before = t.sent.length;

    session.onMessage(refreshConfig("gw-01"));

    expect(refreshed).toEqual(["gw-01"]);
    expect(t.sent.length).toBe(before); // no direct reply frame
    expect(t.closed).toBeUndefined();
  });
});

describe("FleetWsGateway - config-family handshake and validation", () => {
  it("rejects get-config before hello (hello must be the first frame)", () => {
    const { gateway } = rig();
    const t = new FakeTransport("c1");
    gateway.connect(t).onMessage(getConfig());

    const [msg] = t.messages();
    expect(msg).toMatchObject({ type: "error", code: "malformed" });
    expect(t.closed?.code).toBe(4000);
    expect(gateway.clientCount()).toBe(0);
  });

  it("rejects a malformed get-config key", () => {
    const { gateway } = rig();
    const t = new FakeTransport("c1");
    const session = gateway.connect(t);
    session.onMessage(hello());
    session.onMessage(
      JSON.stringify({ type: "get-config", protocolVersion: PROTOCOL_VERSION, key: { device: "gw-01" } }),
    );
    expect(t.messages().at(-1)).toMatchObject({ type: "error", code: "malformed" });
    expect(t.closed).toBeDefined();
  });

  it("rejects a version-skewed get-config distinctly", () => {
    const { gateway } = rig();
    const t = new FakeTransport("c1");
    const session = gateway.connect(t);
    session.onMessage(hello());
    session.onMessage(getConfig(KEY, PROTOCOL_VERSION + 1));
    expect(t.messages().at(-1)).toMatchObject({ type: "error", code: "unsupported-protocol-version" });
  });

  it("without the config seam the gateway still answers honestly: unavailable + no-op refresh", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    const gateway = new FleetWsGateway(model, { clock: clock.fn }); // no ConfigGatewayDeps
    const t = new FakeTransport("c1");
    const session = gateway.connect(t);
    session.onMessage(hello());

    session.onMessage(getConfig());
    expect(t.messages().at(-1)).toMatchObject({ type: "config-unavailable", key: KEY });

    session.onMessage(refreshConfig("gw-01")); // must not throw
    expect(t.closed).toBeUndefined();
  });

  it("componentKeyId drives interest matching (device/component/instance triplet)", () => {
    // Guard the id shape the gateway keys interest with.
    expect(componentKeyId(KEY)).toBe("gw-01/modbus-adapter/main");
  });
});

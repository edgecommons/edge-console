/**
 * The C4 command family on the WS gateway: `invoke-command` → RBAC → the injected
 * CommandGateway's request/reply → exactly one `command-result` correlated by
 * `requestId`, delivered only to the still-connected originating client. Uses a REAL
 * CommandGateway over a deferred fake `request` so the whole seam (frame handling +
 * RBAC + mapping + drop-on-disconnect + concurrency) is exercised end to end.
 * (`command-gateway.test.ts` owns the pure mapping surface.)
 */
import { describe, expect, it } from "vitest";
import { Message, MessageBuilder, MessageIdentity, Uns } from "@edgecommons/ggcommons";
import { PROTOCOL_VERSION } from "@edgecommons/edge-console-protocol";
import type { ComponentKey, ServerMessage } from "@edgecommons/edge-console-protocol";

import { FleetModel } from "../src/fleet/fleet-model";
import { CommandGateway } from "../src/command/command-gateway";
import type { CommandRequestFn } from "../src/command/command-gateway";
import { ConfigRbacPolicy, DEFAULT_RBAC_CONFIG } from "../src/command/rbac";
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
  results(): Extract<ServerMessage, { type: "command-result" }>[] {
    return this.messages().filter(
      (m): m is Extract<ServerMessage, { type: "command-result" }> => m.type === "command-result",
    );
  }
}

const CONSOLE_IDENTITY = new MessageIdentity([{ level: "device", value: "console-dev" }], "edge-console");
const KEY: ComponentKey = { device: "gw-01", component: "opcua-adapter", instance: "main" };

function reply(verb: string, body: unknown): Message {
  return MessageBuilder.create(verb, "1.0").withPayload(body).build();
}

/** Flush the microtask queue (the command result is delivered in a `.then`). */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

interface DeferredCall {
  topic: string;
  msg: Message;
  timeoutMs: number;
  resolve: (m: Message) => void;
  reject: (e: unknown) => void;
}

/** A gateway wired with a real CommandGateway over a DEFERRED fake request. */
function rig(withSeam = true) {
  const clock = new TestClock();
  const model = new FleetModel(clock.fn);
  const calls: DeferredCall[] = [];
  const request: CommandRequestFn = (topic, msg, timeoutMs) =>
    new Promise<Message>((resolve, reject) => calls.push({ topic, msg, timeoutMs, resolve, reject }));
  const rbac = new ConfigRbacPolicy(DEFAULT_RBAC_CONFIG);
  const commandGateway = new CommandGateway({
    uns: new Uns(CONSOLE_IDENTITY, false),
    newMessage: (name) => MessageBuilder.create(name, "1.0"),
    request,
    rbac,
    clock: clock.fn,
  });
  const gateway = new FleetWsGateway(
    model,
    { clock: clock.fn },
    undefined,
    undefined,
    withSeam ? { gateway: commandGateway, rbac } : undefined,
  );
  return { clock, model, calls, gateway, rbac };
}

function hello(): string {
  return JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION });
}
function invoke(
  requestId: string,
  key: ComponentKey,
  verb: string,
  args?: Record<string, unknown>,
  protocolVersion = PROTOCOL_VERSION,
): string {
  return JSON.stringify({
    type: "invoke-command",
    protocolVersion,
    requestId,
    key,
    verb,
    ...(args !== undefined ? { args } : {}),
  });
}

describe("FleetWsGateway - invoke-command happy path", () => {
  it("issues the request and answers exactly one command-result correlated by requestId", async () => {
    const { gateway, calls } = rig();
    const t = new FakeTransport("c1");
    const session = gateway.connect(t, "operator");
    session.onMessage(hello());
    session.onMessage(invoke("r1", KEY, "ping"));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.topic).toBe("ecv1/gw-01/opcua-adapter/main/cmd/ping");
    calls[0]!.resolve(reply("ping", { ok: true, result: { status: "RUNNING", uptimeSecs: 42 } }));
    await flush();

    expect(t.results()).toHaveLength(1);
    expect(t.results()[0]).toMatchObject({
      type: "command-result",
      requestId: "r1",
      key: KEY,
      verb: "ping",
      ok: true,
      result: { status: "RUNNING", uptimeSecs: 42 },
    });
    expect(t.closed).toBeUndefined(); // a command answer never closes the connection
  });

  it("passes args through and reports a component error reply as ok:false", async () => {
    const { gateway, calls } = rig();
    const t = new FakeTransport("c1");
    const session = gateway.connect(t, "operator");
    session.onMessage(hello());
    session.onMessage(invoke("r2", KEY, "reload-config", { force: true }));

    expect(calls[0]!.msg.getBody()).toEqual({ force: true });
    calls[0]!.resolve(reply("reload-config", { ok: false, error: { code: "RELOAD_FAILED", message: "nope" } }));
    await flush();
    expect(t.results()[0]).toMatchObject({ requestId: "r2", ok: false, error: { code: "RELOAD_FAILED" } });
  });
});

describe("FleetWsGateway - invoke-command RBAC", () => {
  it("denies by policy → FORBIDDEN, and never issues a request", async () => {
    const { gateway, calls } = rig();
    const t = new FakeTransport("viewer-client");
    const session = gateway.connect(t, "viewer"); // read-only role
    session.onMessage(hello());
    session.onMessage(invoke("r", KEY, "reload-config"));
    await flush();

    expect(calls).toHaveLength(0);
    expect(t.results()[0]).toMatchObject({ ok: false, error: { code: "FORBIDDEN" }, elapsedMs: 0 });
  });

  it("a connection with no explicit role falls back to the RBAC defaultRole (operator ⇒ allowed)", async () => {
    const { gateway, calls } = rig();
    const t = new FakeTransport("c1");
    const session = gateway.connect(t); // no role ⇒ defaultRole "operator"
    session.onMessage(hello());
    session.onMessage(invoke("r", KEY, "reload-config"));
    expect(calls).toHaveLength(1); // operator may reload-config
  });
});

describe("FleetWsGateway - invoke-command without the seam", () => {
  it("answers UNAVAILABLE honestly (no bus request path configured)", () => {
    const { gateway } = rig(false);
    const t = new FakeTransport("c1");
    const session = gateway.connect(t, "operator");
    session.onMessage(hello());
    session.onMessage(invoke("r", KEY, "ping"));
    expect(t.results()[0]).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
    expect(t.closed).toBeUndefined();
  });
});

describe("FleetWsGateway - invoke-command handshake + validation", () => {
  it("rejects invoke-command before hello (hello must be the first frame)", () => {
    const { gateway } = rig();
    const t = new FakeTransport("c1");
    gateway.connect(t).onMessage(invoke("r", KEY, "ping"));
    expect(t.messages()[0]).toMatchObject({ type: "error", code: "malformed" });
    expect(t.closed?.code).toBe(4000);
  });

  it("rejects a malformed invoke-command (missing verb) and closes", () => {
    const { gateway } = rig();
    const t = new FakeTransport("c1");
    const session = gateway.connect(t, "operator");
    session.onMessage(hello());
    session.onMessage(
      JSON.stringify({ type: "invoke-command", protocolVersion: PROTOCOL_VERSION, requestId: "r", key: KEY }),
    );
    expect(t.messages().at(-1)).toMatchObject({ type: "error", code: "malformed" });
    expect(t.closed).toBeDefined();
  });

  it("rejects a version-skewed invoke-command distinctly", () => {
    const { gateway } = rig();
    const t = new FakeTransport("c1");
    const session = gateway.connect(t, "operator");
    session.onMessage(hello());
    session.onMessage(invoke("r", KEY, "ping", undefined, PROTOCOL_VERSION + 1));
    expect(t.messages().at(-1)).toMatchObject({ type: "error", code: "unsupported-protocol-version" });
  });
});

describe("FleetWsGateway - invoke-command isolation + concurrency", () => {
  it("drops a command whose client disconnected before the reply arrived", async () => {
    const { gateway, calls } = rig();
    const t = new FakeTransport("c1");
    const session = gateway.connect(t, "operator");
    session.onMessage(hello());
    session.onMessage(invoke("r", KEY, "ping"));
    session.onClose(); // the browser navigated away mid-flight

    calls[0]!.resolve(reply("ping", { ok: true, result: { status: "RUNNING", uptimeSecs: 1 } }));
    await flush();
    expect(t.results()).toHaveLength(0); // never delivered to the gone session
  });

  it("keeps two concurrent commands correlated, resolving out of order", async () => {
    const { gateway, calls } = rig();
    const t = new FakeTransport("c1");
    const session = gateway.connect(t, "operator");
    session.onMessage(hello());
    session.onMessage(invoke("a", KEY, "ping"));
    session.onMessage(invoke("b", KEY, "get-configuration"));
    expect(calls).toHaveLength(2);

    calls[1]!.resolve(reply("get-configuration", { ok: true, result: { config: { rev: 9 } } }));
    calls[0]!.resolve(reply("ping", { ok: true, result: { status: "RUNNING", uptimeSecs: 5 } }));
    await flush();

    const byId = Object.fromEntries(t.results().map((r) => [r.requestId, r]));
    expect(byId.a).toMatchObject({ verb: "ping", result: { status: "RUNNING", uptimeSecs: 5 } });
    expect(byId.b).toMatchObject({ verb: "get-configuration", result: { config: { rev: 9 } } });
  });

  it("delivers a result only to the originating client (not to other connections)", async () => {
    const { gateway, calls } = rig();
    const a = new FakeTransport("a");
    const b = new FakeTransport("b");
    const sa = gateway.connect(a, "operator");
    const sb = gateway.connect(b, "operator");
    sa.onMessage(hello());
    sb.onMessage(hello());
    sa.onMessage(invoke("r", KEY, "ping"));

    calls[0]!.resolve(reply("ping", { ok: true, result: {} }));
    await flush();
    expect(a.results()).toHaveLength(1);
    expect(b.results()).toHaveLength(0);
  });
});

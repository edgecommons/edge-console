/**
 * The C4 pure command core (`CommandGateway`): invoke → request → result mapping,
 * timeout → TIMEOUT, component error/malformed-reply passthrough, RBAC deny → FORBIDDEN,
 * INVALID_TARGET, per-verb timeout selection + the ≤ bridge-TTL clamp, elapsedMs, and
 * concurrent correlation. The ONLY IO is the injected `request` fn (a fake here), so this
 * runs with no bus and no sleeps.
 */
import { describe, expect, it } from "vitest";
import { Message, MessageBuilder, MessageIdentity, RequestTimeoutError, Uns } from "@edgecommons/ggcommons";
import type { ComponentKey } from "@edgecommons/edge-console-protocol";
import { CommandGateway } from "../src/command/command-gateway";
import type { CommandGatewayDeps, CommandRequestFn } from "../src/command/command-gateway";
import { ConfigRbacPolicy, DEFAULT_RBAC_CONFIG } from "../src/command/rbac";

/** The timeout knobs a test may override on the rig. */
type TimeoutOpts = Partial<Pick<CommandGatewayDeps, "defaultTimeoutMs" | "maxTimeoutMs" | "timeoutForVerb">>;

const CONSOLE_IDENTITY = new MessageIdentity([{ level: "device", value: "console-dev" }], "edge-console");
const KEY: ComponentKey = { device: "gw-01", component: "opcua-adapter", instance: "main" };

/** A reply envelope carrying `body` (the responder's identity is irrelevant to mapping). */
function reply(verb: string, body: unknown): Message {
  return MessageBuilder.create(verb, "1.0").withPayload(body).build();
}

interface RequestCall {
  topic: string;
  msg: Message;
  timeoutMs: number;
}

/** A gateway over fakes; `setRequest` scripts the IO edge; `calls` records what was issued. */
function rig(opts: TimeoutOpts = {}) {
  const clock = { now: 1_000 };
  const calls: RequestCall[] = [];
  let impl: CommandRequestFn = () => new Promise<Message>(() => undefined); // never settles by default
  const request: CommandRequestFn = (topic, msg, timeoutMs) => {
    calls.push({ topic, msg, timeoutMs });
    return impl(topic, msg, timeoutMs);
  };
  const gateway = new CommandGateway({
    uns: new Uns(CONSOLE_IDENTITY, false),
    newMessage: (name) => MessageBuilder.create(name, "1.0"),
    request,
    rbac: new ConfigRbacPolicy(DEFAULT_RBAC_CONFIG),
    clock: () => clock.now,
    ...opts,
  });
  return {
    gateway,
    calls,
    clock,
    setRequest: (fn: CommandRequestFn) => {
      impl = fn;
    },
  };
}

describe("CommandGateway.invoke - success mapping", () => {
  it("issues the request to the target's cmd inbox (topic + header.name=verb + body=args) and maps ok:true", async () => {
    const { gateway, calls, clock, setRequest } = rig();
    setRequest(() => {
      clock.now += 7; // measurable round-trip
      return Promise.resolve(reply("ping", { ok: true, result: { status: "RUNNING", uptimeSecs: 42 } }));
    });

    const result = await gateway.invoke({ requestId: "r1", key: KEY, verb: "ping" }, "operator");

    expect(calls).toHaveLength(1);
    expect(calls[0]!.topic).toBe("ecv1/gw-01/opcua-adapter/main/cmd/ping");
    expect(calls[0]!.msg.header.name).toBe("ping");
    expect(calls[0]!.msg.getBody()).toEqual({}); // no args ⇒ empty body
    expect(result).toEqual({
      requestId: "r1",
      key: KEY,
      verb: "ping",
      ok: true,
      result: { status: "RUNNING", uptimeSecs: 42 },
      elapsedMs: 7,
    });
  });

  it("carries the args object as the request body verbatim", async () => {
    const { gateway, calls, setRequest } = rig();
    setRequest(() => Promise.resolve(reply("set-log-level", { ok: true, result: {} })));

    await gateway.invoke(
      { requestId: "r2", key: KEY, verb: "set-log-level", args: { level: "DEBUG" } },
      "operator",
    );
    expect(calls[0]!.msg.getBody()).toEqual({ level: "DEBUG" });
    expect(calls[0]!.topic).toBe("ecv1/gw-01/opcua-adapter/main/cmd/set-log-level");
  });
});

describe("CommandGateway.invoke - failure mapping", () => {
  it("maps a RequestTimeoutError to a TIMEOUT result", async () => {
    const { gateway, setRequest } = rig();
    setRequest(() => Promise.reject(new RequestTimeoutError("request timed out after 10000 ms")));

    const result = await gateway.invoke({ requestId: "r", key: KEY, verb: "ping" }, "operator");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TIMEOUT");
  });

  it("maps a generic transport error to REQUEST_FAILED", async () => {
    const { gateway, setRequest } = rig();
    setRequest(() => Promise.reject(new Error("broker not connected")));

    const result = await gateway.invoke({ requestId: "r", key: KEY, verb: "ping" }, "operator");
    expect(result).toMatchObject({ ok: false, error: { code: "REQUEST_FAILED", message: "broker not connected" } });
  });

  it("passes a component's coded error reply through verbatim (UNKNOWN_VERB)", async () => {
    const { gateway, setRequest } = rig();
    setRequest(() =>
      Promise.resolve(
        reply("no-such-verb", {
          ok: false,
          error: { code: "UNKNOWN_VERB", message: "verb 'no-such-verb' is not registered on this component" },
        }),
      ),
    );

    const result = await gateway.invoke({ requestId: "r", key: KEY, verb: "no-such-verb" }, "operator");
    expect(result).toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_VERB", message: expect.stringContaining("not registered") },
    });
  });

  it("maps a reply that is not the {ok, result|error} shape to MALFORMED_REPLY", async () => {
    const { gateway, setRequest } = rig();
    setRequest(() => Promise.resolve(reply("ping", { surprising: true })));
    const result = await gateway.invoke({ requestId: "r", key: KEY, verb: "ping" }, "operator");
    expect(result.error?.code).toBe("MALFORMED_REPLY");
  });

  it("tolerates a raw (non-envelope) reply body without the error object", async () => {
    const { gateway, setRequest } = rig();
    setRequest(() => Promise.resolve(reply("ping", { ok: false }))); // no error field
    const result = await gateway.invoke({ requestId: "r", key: KEY, verb: "ping" }, "operator");
    expect(result).toMatchObject({ ok: false, error: { code: "ERROR" } });
  });
});

describe("CommandGateway.invoke - RBAC", () => {
  it("denies a verb the role cannot invoke → FORBIDDEN, and never touches the bus", async () => {
    const { gateway, calls } = rig();
    const result = await gateway.invoke({ requestId: "r", key: KEY, verb: "reload-config" }, "viewer");
    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" }, elapsedMs: 0 });
    expect(calls).toHaveLength(0); // short-circuited before request()
  });

  it("allows a read-only verb for the same restricted role", async () => {
    const { gateway, setRequest } = rig();
    setRequest(() => Promise.resolve(reply("ping", { ok: true, result: { status: "RUNNING", uptimeSecs: 1 } })));
    const result = await gateway.invoke({ requestId: "r", key: KEY, verb: "ping" }, "viewer");
    expect(result.ok).toBe(true);
  });
});

describe("CommandGateway.invoke - target validation", () => {
  it("rejects a verb that cannot form a valid UNS topic → INVALID_TARGET (no bus round-trip)", async () => {
    const { gateway, calls } = rig();
    // '#' is a forbidden UNS token character (§2.2 token rule) — topicFor throws.
    const result = await gateway.invoke({ requestId: "r", key: KEY, verb: "bad#verb" }, "operator");
    expect(result.error?.code).toBe("INVALID_TARGET");
    expect(calls).toHaveLength(0);
  });
});

describe("CommandGateway.invoke - per-verb timeout + clamp", () => {
  const scripted = (): CommandRequestFn => () => Promise.resolve(reply("ping", { ok: true, result: {} }));

  it("selects the per-verb timeout, falling back to the default", async () => {
    const { gateway, calls, setRequest } = rig({
      defaultTimeoutMs: 30_000,
      maxTimeoutMs: 60_000,
      timeoutForVerb: (verb: string) => (verb === "ping" ? 10_000 : undefined),
    });
    setRequest(scripted());
    await gateway.invoke({ requestId: "a", key: KEY, verb: "ping" }, "operator");
    await gateway.invoke({ requestId: "b", key: KEY, verb: "reload-config" }, "operator");
    expect(calls[0]!.timeoutMs).toBe(10_000);
    expect(calls[1]!.timeoutMs).toBe(30_000);
  });

  it("clamps a too-large timeout to the max (bridge TTL) and a zero to at least 1 ms", async () => {
    const big = rig({ maxTimeoutMs: 60_000, timeoutForVerb: () => 999_999 });
    big.setRequest(scripted());
    await big.gateway.invoke({ requestId: "a", key: KEY, verb: "ping" }, "operator");
    expect(big.calls[0]!.timeoutMs).toBe(60_000);

    const zero = rig({ timeoutForVerb: () => 0 });
    zero.setRequest(scripted());
    await zero.gateway.invoke({ requestId: "a", key: KEY, verb: "ping" }, "operator");
    expect(zero.calls[0]!.timeoutMs).toBe(1);
  });
});

describe("CommandGateway.invoke - concurrent correlation", () => {
  it("keeps two in-flight commands independent, resolving out of order with the right requestId/verb", async () => {
    const resolvers: Array<(m: Message) => void> = [];
    const { gateway, setRequest } = rig();
    setRequest(() => new Promise<Message>((resolve) => resolvers.push(resolve)));

    const pa = gateway.invoke({ requestId: "a", key: KEY, verb: "ping" }, "operator");
    const pb = gateway.invoke(
      { requestId: "b", key: { ...KEY, component: "modbus-adapter" }, verb: "get-configuration" },
      "operator",
    );
    expect(resolvers).toHaveLength(2);

    // Resolve B first, then A — the results must not cross.
    resolvers[1]!(reply("get-configuration", { ok: true, result: { config: { rev: 9 } } }));
    resolvers[0]!(reply("ping", { ok: true, result: { status: "RUNNING", uptimeSecs: 5 } }));

    const [ra, rb] = await Promise.all([pa, pb]);
    expect(ra).toMatchObject({ requestId: "a", verb: "ping", ok: true, result: { status: "RUNNING", uptimeSecs: 5 } });
    expect(rb).toMatchObject({ requestId: "b", verb: "get-configuration", ok: true, result: { config: { rev: 9 } } });
    expect(rb.key.component).toBe("modbus-adapter");
  });
});

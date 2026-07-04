import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@edgecommons/edge-console-protocol";
import type { ServerMessage } from "@edgecommons/edge-console-protocol";

import { FleetModel } from "../src/fleet/fleet-model";
import type { IngressEvent } from "../src/ingress/normalizer";
import { FleetWsGateway } from "../src/ws/gateway";
import type { ClientTransport } from "../src/ws/gateway";

/** A manually-advanced clock (ms) — no sleeps anywhere (matches fleet-model.test.ts). */
class TestClock {
  now = 1_000_000;
  tick(ms: number): void {
    this.now += ms;
  }
  fn = (): number => this.now;
}

/** A minimal `data` envelope event — one call seeds a device+component (3 deltas: device-discovered, component-discovered, value-updated); subsequent distinct channels yield exactly one value-updated delta each. */
function dataEvent(channel: string, device = "gw-01"): IngressEvent {
  return {
    kind: "envelope",
    cls: "data",
    channel,
    identity: { hier: [{ level: "device", value: device }], path: device, component: "comp", instance: "main" },
    body: { v: channel },
    topic: `ecv1/${device}/comp/main/data/${channel}`,
  };
}

/** An in-memory {@link ClientTransport} — records every sent frame, simulates backpressure via a settable `bufferedAmount`. */
class FakeTransport implements ClientTransport {
  readonly sent: string[] = [];
  closed: { code: number; reason: string } | undefined;
  private buffered = 0;

  constructor(readonly id: string) {}

  send(data: string): void {
    this.sent.push(data);
  }
  bufferedAmount(): number {
    return this.buffered;
  }
  setBufferedAmount(n: number): void {
    this.buffered = n;
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  /** All frames, INCLUDING the R0 `welcome` handshake frame. */
  rawMessages(): ServerMessage[] {
    return this.sent.map((s) => JSON.parse(s) as ServerMessage);
  }
  /** Frames excluding the `welcome` handshake (the C2 fanout tests assert over these). */
  messages(): ServerMessage[] {
    return this.rawMessages().filter((m) => m.type !== "welcome");
  }
}

function hello(resumeSeq?: number, protocolVersion = PROTOCOL_VERSION): string {
  return JSON.stringify({
    type: "hello",
    protocolVersion,
    ...(resumeSeq !== undefined ? { resumeSeq } : {}),
  });
}

describe("FleetWsGateway - snapshot-then-deltas on connect", () => {
  it("sends exactly one snapshot for a fresh hello (no resumeSeq)", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    model.ingest(dataEvent("a"));
    const gateway = new FleetWsGateway(model, { clock: clock.fn });

    const t = new FakeTransport("c1");
    const session = gateway.connect(t);
    expect(t.sent).toHaveLength(0); // nothing before hello
    session.onMessage(hello());

    expect(t.messages()).toHaveLength(1);
    const [msg] = t.messages();
    expect(msg).toEqual({
      type: "snapshot",
      protocolVersion: PROTOCOL_VERSION,
      snapshot: model.snapshot(),
    });
  });

  it("streams every subsequent delta batch in order, seq-stamped", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    model.ingest(dataEvent("a"));
    const gateway = new FleetWsGateway(model, { clock: clock.fn });
    const t = new FakeTransport("c1");
    gateway.connect(t).onMessage(hello());
    expect(t.messages()).toHaveLength(1); // the snapshot

    model.ingest(dataEvent("b"));
    model.ingest(dataEvent("c"));

    const deltaMsgs = t.messages().slice(1);
    expect(deltaMsgs).toHaveLength(2);
    expect(deltaMsgs.every((m) => m.type === "delta")).toBe(true);
    const seqs = deltaMsgs.flatMap((m) => (m.type === "delta" ? m.deltas.map((d) => d.seq) : []));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // strictly increasing / in order
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicates
  });

  it("sends the welcome frame (the connection's role) right before the snapshot (R0)", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    const gateway = new FleetWsGateway(model, { clock: clock.fn });
    const t = new FakeTransport("c1");
    gateway.connect(t, "operator").onMessage(hello());

    const raw = t.rawMessages();
    expect(raw[0]).toEqual({ type: "welcome", protocolVersion: PROTOCOL_VERSION, role: "operator" });
    expect(raw[1]!.type).toBe("snapshot");
  });

  it("a pre-hello client gets nothing, not even deltas", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    const gateway = new FleetWsGateway(model, { clock: clock.fn });
    const t = new FakeTransport("c1");
    gateway.connect(t); // never sends hello
    model.ingest(dataEvent("a"));
    expect(t.sent).toHaveLength(0);
  });
});

describe("FleetWsGateway - resume-from-seq", () => {
  it("resumes with only the missed deltas when the buffer proves contiguous coverage", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    model.ingest(dataEvent("a"));
    const gateway = new FleetWsGateway(model, { clock: clock.fn, deltaBufferSize: 1000 });

    const first = new FakeTransport("first");
    gateway.connect(first).onMessage(hello());
    const baselineSeq = model.snapshot().seq;

    model.ingest(dataEvent("b"));
    model.ingest(dataEvent("c"));

    const second = new FakeTransport("second");
    gateway.connect(second).onMessage(hello(baselineSeq));

    expect(second.messages()).toHaveLength(1);
    const [msg] = second.messages();
    expect(msg.type).toBe("delta");
    expect(msg.type === "delta" && msg.deltas.every((d) => d.seq > baselineSeq)).toBe(true);
    expect(msg.type === "delta" && msg.deltas.length).toBe(2); // one value-updated per ingest
  });

  it("resuming exactly at the current seq yields no message (already caught up, live stream continues)", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    model.ingest(dataEvent("a"));
    const gateway = new FleetWsGateway(model, { clock: clock.fn });
    const currentSeq = model.snapshot().seq;

    const t = new FakeTransport("c1");
    gateway.connect(t).onMessage(hello(currentSeq));
    expect(t.messages()).toHaveLength(0); // only the welcome frame; no snapshot/delta

    model.ingest(dataEvent("b"));
    expect(t.messages()).toHaveLength(1);
    expect(t.messages()[0]!.type).toBe("delta");
  });

  it("falls back to a fresh snapshot when the resume range has been evicted from the buffer", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    model.ingest(dataEvent("a"));
    const baselineSeq = model.snapshot().seq;
    // Capacity 1: only the very last delta stays buffered.
    const gateway = new FleetWsGateway(model, { clock: clock.fn, deltaBufferSize: 1 });

    model.ingest(dataEvent("b"));
    model.ingest(dataEvent("c"));
    model.ingest(dataEvent("d")); // evicts everything but the newest delta

    const t = new FakeTransport("c1");
    gateway.connect(t).onMessage(hello(baselineSeq));

    expect(t.messages()).toHaveLength(1);
    expect(t.messages()[0]).toMatchObject({ type: "snapshot", snapshot: { seq: model.snapshot().seq } });
  });

  it("falls back to a fresh snapshot when resumeSeq is ahead of the server (stale/uncertain client state)", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    model.ingest(dataEvent("a"));
    const gateway = new FleetWsGateway(model, { clock: clock.fn });

    const t = new FakeTransport("c1");
    gateway.connect(t).onMessage(hello(model.snapshot().seq + 1000));

    expect(t.messages()).toHaveLength(1);
    expect(t.messages()[0]!.type).toBe("snapshot");
  });
});

describe("FleetWsGateway - multi-client fanout", () => {
  it("delivers the same delta batch to every ready client", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    model.ingest(dataEvent("a"));
    const gateway = new FleetWsGateway(model, { clock: clock.fn });

    const a = new FakeTransport("a");
    const b = new FakeTransport("b");
    gateway.connect(a).onMessage(hello());
    gateway.connect(b).onMessage(hello());
    expect(gateway.clientCount()).toBe(2);

    model.ingest(dataEvent("b"));

    const aDelta = a.messages().at(-1);
    const bDelta = b.messages().at(-1);
    expect(aDelta).toEqual(bDelta);
    expect(aDelta!.type).toBe("delta");
  });
});

describe("FleetWsGateway - slow-client isolation / backpressure", () => {
  it("a backpressured client is skipped (not stalled-into) while others keep receiving every delta, then force-resynced", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    model.ingest(dataEvent("seed"));
    const gateway = new FleetWsGateway(model, {
      clock: clock.fn,
      maxBufferedBytes: 10,
      maxMissedPushes: 2,
    });

    const slow = new FakeTransport("slow");
    const fast = new FakeTransport("fast");
    gateway.connect(slow).onMessage(hello());
    gateway.connect(fast).onMessage(hello());
    slow.setBufferedAmount(1_000_000); // always "backpressured"
    const fastCountAfterHello = fast.sent.length;
    // Message-count baselines (welcome filtered out) for the `.messages().slice()` below.
    const slowMsgsAfterHello = slow.messages().length;
    const fastMsgsAfterHello = fast.messages().length;

    // 3 pushes > maxMissedPushes(2): the 3rd push forces a resnapshot for `slow`.
    model.ingest(dataEvent("p1"));
    model.ingest(dataEvent("p2"));
    model.ingest(dataEvent("p3"));

    // `fast` never missed anything: one delta message per ingest.
    expect(fast.sent.length - fastCountAfterHello).toBe(3);
    expect(
      fast
        .messages()
        .slice(fastMsgsAfterHello)
        .every((m) => m.type === "delta"),
    ).toBe(true);

    // `slow` got NO delta messages while backpressured, but exactly one forced
    // snapshot once it exceeded maxMissedPushes.
    const slowNew = slow.messages().slice(slowMsgsAfterHello);
    expect(slowNew).toHaveLength(1);
    expect(slowNew[0]!.type).toBe("snapshot");

    // Recovery: once unblocked, `slow` resumes receiving live deltas normally.
    slow.setBufferedAmount(0);
    model.ingest(dataEvent("p4"));
    expect(slow.messages().at(-1)!.type).toBe("delta");
  });
});

describe("FleetWsGateway - malformed client messages", () => {
  function expectRejected(raw: string, codeSubstring?: string): void {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    const gateway = new FleetWsGateway(model, { clock: clock.fn });
    const t = new FakeTransport("c1");
    gateway.connect(t).onMessage(raw);

    expect(t.messages()).toHaveLength(1);
    const [msg] = t.messages();
    expect(msg.type).toBe("error");
    if (codeSubstring !== undefined && msg.type === "error") {
      expect(msg.code).toBe(codeSubstring);
    }
    expect(t.closed).toBeDefined();
    expect(t.closed!.code).toBe(4000); // rejection close code, regardless of the specific WsErrorCode
    expect(gateway.clientCount()).toBe(0);
  }

  it("rejects invalid JSON", () => {
    expectRejected("not json{{{", "malformed");
  });

  it("rejects a non-object frame", () => {
    expectRejected("42", "malformed");
  });

  it("rejects an unknown message type", () => {
    expectRejected(JSON.stringify({ type: "bogus", protocolVersion: PROTOCOL_VERSION }), "malformed");
  });

  it("rejects a missing/non-integer protocolVersion", () => {
    expectRejected(JSON.stringify({ type: "hello" }), "malformed");
    expectRejected(JSON.stringify({ type: "hello", protocolVersion: "1" }), "malformed");
    expectRejected(JSON.stringify({ type: "hello", protocolVersion: 1.5 }), "malformed");
  });

  it("rejects a negative/non-integer resumeSeq", () => {
    expectRejected(hello(-1), "malformed");
    expectRejected(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, resumeSeq: 1.5 }), "malformed");
  });

  it("rejects an unsupported protocolVersion distinctly from a malformed frame", () => {
    expectRejected(hello(undefined, PROTOCOL_VERSION + 1), "unsupported-protocol-version");
  });

  it("a rejected client never receives anything else and stops being fanned out to", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    const gateway = new FleetWsGateway(model, { clock: clock.fn });
    const t = new FakeTransport("c1");
    gateway.connect(t).onMessage("garbage");
    const before = t.sent.length;
    model.ingest(dataEvent("a"));
    expect(t.sent.length).toBe(before);
  });
});

describe("FleetWsGateway - tick(): heartbeats + hello-timeout eviction", () => {
  it("sends a heartbeat to ready clients on tick()", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    const gateway = new FleetWsGateway(model, { clock: clock.fn });
    const t = new FakeTransport("c1");
    gateway.connect(t).onMessage(hello());

    clock.tick(5000);
    gateway.tick();

    const last = t.messages().at(-1)!;
    expect(last).toEqual({ type: "heartbeat", protocolVersion: PROTOCOL_VERSION, at: clock.now });
  });

  it("stamps the console's own bus-ingest throughput on the heartbeat when a meter is wired (R1)", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    const gateway = new FleetWsGateway(model, { clock: clock.fn, busThroughput: () => 4.2 });
    const t = new FakeTransport("c1");
    gateway.connect(t).onMessage(hello());

    gateway.tick();
    expect(t.messages().at(-1)).toEqual({
      type: "heartbeat",
      protocolVersion: PROTOCOL_VERSION,
      at: clock.now,
      busMsgsPerSec: 4.2,
    });
  });

  it("evicts a client that never sends hello within helloTimeoutMs", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    const gateway = new FleetWsGateway(model, { clock: clock.fn, helloTimeoutMs: 1000 });
    const t = new FakeTransport("c1");
    gateway.connect(t); // no hello

    clock.tick(500);
    gateway.tick();
    expect(t.closed).toBeUndefined(); // not yet

    clock.tick(600); // total 1100 > 1000
    gateway.tick();
    expect(t.closed).toBeDefined();
    expect(gateway.clientCount()).toBe(0);
    expect(t.messages().at(-1)!.type).toBe("error");
  });

  it("does not heartbeat a client that hasn't said hello yet", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    const gateway = new FleetWsGateway(model, { clock: clock.fn, helloTimeoutMs: 10_000 });
    const t = new FakeTransport("c1");
    gateway.connect(t);
    gateway.tick();
    expect(t.sent).toHaveLength(0);
  });
});

describe("FleetWsGateway - stop()", () => {
  it("closes every client and detaches from the FleetModel", () => {
    const clock = new TestClock();
    const model = new FleetModel(clock.fn);
    const gateway = new FleetWsGateway(model, { clock: clock.fn });
    const a = new FakeTransport("a");
    const b = new FakeTransport("b");
    gateway.connect(a).onMessage(hello());
    gateway.connect(b).onMessage(hello());

    gateway.stop();

    expect(a.closed).toEqual({ code: 1001, reason: "server shutting down" });
    expect(b.closed).toEqual({ code: 1001, reason: "server shutting down" });
    expect(gateway.clientCount()).toBe(0);

    // Detached: further FleetModel activity produces no more sends.
    const aCountBefore = a.sent.length;
    model.ingest(dataEvent("post-stop"));
    expect(a.sent.length).toBe(aCountBefore);
  });
});

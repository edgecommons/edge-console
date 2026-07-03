import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@edgecommons/edge-console-protocol";
import type { ServerMessage } from "@edgecommons/edge-console-protocol";
import { FleetClient, browserSocketFactory } from "../src/fleet/client";
import type { SocketLike } from "../src/fleet/client";
import { T0, compSnap, deviceSnap, seqRun, snapshot } from "./_fixtures";

/** An in-memory {@link SocketLike} the tests drive from the "server" side. */
class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }

  // -- server-side drivers --
  open(): void {
    this.onopen?.();
  }
  frame(msg: ServerMessage): void {
    this.onmessage?.(JSON.stringify(msg));
  }
  text(raw: string): void {
    this.onmessage?.(raw);
  }
  serverClose(): void {
    this.onclose?.();
  }
  helloFrames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

/** A test rig: manual clock + recorded sockets + a started client. */
function rig(opts: { start?: boolean } = {}) {
  const clock = { now: T0 };
  const sockets: FakeSocket[] = [];
  const client = new FleetClient({
    url: "ws://console.test/ws",
    socketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    now: () => clock.now,
  });
  if (opts.start !== false) client.start();
  return { client, sockets, clock };
}

const SNAPSHOT: ServerMessage = {
  type: "snapshot",
  protocolVersion: PROTOCOL_VERSION,
  snapshot: snapshot([deviceSnap("gw-01", [compSnap()])], 10, T0),
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("FleetClient - connect + hello + snapshot", () => {
  it("dials on start and sends a version-stamped hello without resumeSeq", () => {
    const { client, sockets } = rig();
    expect(client.getState().status).toBe("connecting");
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    expect(sockets[0]!.helloFrames()).toEqual([
      { type: "hello", protocolVersion: PROTOCOL_VERSION },
    ]);
    expect(client.getState().status).toBe("connected");
    client.stop();
  });

  it("applies the snapshot, then folds delta batches into the fleet view", () => {
    const { client, sockets, clock } = rig();
    sockets[0]!.open();
    sockets[0]!.frame(SNAPSHOT);
    expect(client.getState().hasSnapshot).toBe(true);
    expect(client.getState().fleet.devices.map((d) => d.device)).toEqual(["gw-01"]);

    clock.now = T0 + 1000;
    sockets[0]!.frame({
      type: "delta",
      protocolVersion: PROTOCOL_VERSION,
      deltas: seqRun(11, [{ type: "device-discovered", at: T0 + 900, device: "gw-02" }]),
    });
    expect(client.getState().fleet.devices.map((d) => d.device)).toEqual(["gw-01", "gw-02"]);
    expect(client.getState().fleet.seq).toBe(11);
    client.stop();
  });

  it("heartbeats refresh the clock offset; junk frames are ignored", () => {
    const { client, sockets, clock } = rig();
    sockets[0]!.open();
    sockets[0]!.frame(SNAPSHOT);
    clock.now = T0 + 5300;
    sockets[0]!.frame({ type: "heartbeat", protocolVersion: PROTOCOL_VERSION, at: T0 + 5000 });
    expect(client.getState().fleet.clockOffsetMs).toBe(300);
    sockets[0]!.text("not json at all");
    sockets[0]!.text('"a bare string"');
    expect(client.getState().status).toBe("connected");
    client.stop();
  });

  it("getState is identity-stable until something changes", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();
    sockets[0]!.frame(SNAPSHOT);
    const a = client.getState();
    expect(client.getState()).toBe(a);
    sockets[0]!.frame({ type: "heartbeat", protocolVersion: PROTOCOL_VERSION, at: T0 + 1 });
    expect(client.getState()).not.toBe(a);
    client.stop();
  });
});

describe("FleetClient - reconnect + resume", () => {
  it("reconnects with backoff after a drop and resumes from the last applied seq", () => {
    const { client, sockets, clock } = rig();
    sockets[0]!.open();
    sockets[0]!.frame(SNAPSHOT); // seq 10
    const listener = vi.fn();
    client.subscribe(listener);

    sockets[0]!.serverClose();
    expect(client.getState().status).toBe("reconnecting");
    expect(listener).toHaveBeenCalled();

    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1); // not yet - first backoff is 1000 ms
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    sockets[1]!.open();
    expect(sockets[1]!.helloFrames()).toEqual([
      { type: "hello", protocolVersion: PROTOCOL_VERSION, resumeSeq: 10 },
    ]);
    expect(client.getState().status).toBe("connected");

    // The gateway resumes with only the missed deltas - no snapshot needed.
    clock.now = T0 + 10_000;
    sockets[1]!.frame({
      type: "delta",
      protocolVersion: PROTOCOL_VERSION,
      deltas: seqRun(11, [{ type: "device-discovered", at: T0 + 9000, device: "gw-02" }]),
    });
    expect(client.getState().fleet.devices).toHaveLength(2);
    client.stop();
  });

  it("doubles the backoff on consecutive failures and resets it after a good frame", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();
    sockets[0]!.serverClose(); // failure #1 -> 1000 ms
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    sockets[1]!.serverClose(); // failure #2 -> 2000 ms
    vi.advanceTimersByTime(1999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);

    sockets[2]!.open();
    sockets[2]!.frame(SNAPSHOT); // a good frame resets the backoff
    sockets[2]!.serverClose();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(4);
    client.stop();
  });

  it("forces a resync (new dial with resumeSeq) when the delta stream has a gap", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();
    sockets[0]!.frame(SNAPSHOT); // seq 10
    sockets[0]!.frame({
      type: "delta",
      protocolVersion: PROTOCOL_VERSION,
      deltas: seqRun(14, [{ type: "device-discovered", at: T0, device: "gw-09" }]), // hole: 11-13 missing
    });
    expect(sockets[0]!.closed).toBe(true); // never fold past a hole
    expect(sockets).toHaveLength(2); // immediate redial
    sockets[1]!.open();
    expect(sockets[1]!.helloFrames()[0]).toMatchObject({ resumeSeq: 10 });
    // The gateway's answer (resumed deltas or a fresh snapshot) heals the store.
    sockets[1]!.frame(SNAPSHOT);
    expect(client.getState().fleet.devices).toHaveLength(1);
    client.stop();
  });

  it("treats a silent connection as dead (watchdog) and redials", () => {
    const { client, sockets, clock } = rig();
    sockets[0]!.open();
    sockets[0]!.frame(SNAPSHOT);
    // No frames for > idleTimeoutMs (45 s): the watchdog tears down + schedules.
    clock.now = T0 + 46_000;
    vi.advanceTimersByTime(46_000);
    expect(sockets[0]!.closed).toBe(true);
    expect(client.getState().status).toBe("reconnecting");
    vi.advanceTimersByTime(1000);
    expect(sockets.length).toBeGreaterThanOrEqual(2);
    client.stop();
  });
});

describe("FleetClient - fatal + lifecycle", () => {
  it("an unsupported-protocol-version error is fatal: no retry, surfaced to the UI", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();
    sockets[0]!.frame({
      type: "error",
      protocolVersion: PROTOCOL_VERSION,
      code: "unsupported-protocol-version",
      message: "gateway is protocol v2, client sent v1",
    });
    expect(client.getState().status).toBe("disconnected");
    expect(client.getState().fatalError).toContain("protocol v2");
    expect(sockets[0]!.closed).toBe(true);
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1); // no reconnect loop against a version skew
    client.stop();
  });

  it("a non-fatal error frame is followed by the server close, which retries normally", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();
    sockets[0]!.frame({
      type: "error",
      protocolVersion: PROTOCOL_VERSION,
      code: "malformed",
      message: "bad frame",
    });
    sockets[0]!.serverClose();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2);
    client.stop();
  });

  it("stop() closes the socket, cancels retries and unsubscribes listeners cleanly", () => {
    const { client, sockets } = rig();
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);
    sockets[0]!.open();
    client.stop();
    expect(sockets[0]!.closed).toBe(true);
    expect(client.getState().status).toBe("disconnected");
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1); // stopped - no reconnects
    unsubscribe();
    client.stop(); // idempotent
    client.start(); // restartable
    expect(sockets).toHaveLength(2);
    client.stop();
  });

  it("browserSocketFactory adapts a real WebSocket onto SocketLike", () => {
    class StubWebSocket {
      static last: StubWebSocket | undefined;
      readonly sent: string[] = [];
      closed: { code?: number; reason?: string } | undefined;
      onopen: (() => void) | null = null;
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(readonly url: string) {
        StubWebSocket.last = this;
      }
      send(data: string): void {
        this.sent.push(data);
      }
      close(code?: number, reason?: string): void {
        this.closed = { code, reason };
      }
    }
    vi.stubGlobal("WebSocket", StubWebSocket);
    try {
      const like = browserSocketFactory("ws://console.test/ws");
      const ws = StubWebSocket.last!;
      expect(ws.url).toBe("ws://console.test/ws");
      const events: string[] = [];
      like.onopen = () => events.push("open");
      like.onmessage = (d) => events.push(`msg:${d}`);
      like.onclose = () => events.push("close");
      like.onerror = () => events.push("error");
      ws.onopen?.();
      ws.onmessage?.({ data: "hi" });
      ws.onerror?.();
      ws.onclose?.();
      like.send("out");
      like.close(1000, "done");
      expect(events).toEqual(["open", "msg:hi", "error", "close"]);
      expect(ws.sent).toEqual(["out"]);
      expect(ws.closed).toEqual({ code: 1000, reason: "done" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a socket factory throw schedules a retry instead of crashing", () => {
    vi.useFakeTimers();
    let calls = 0;
    const sockets: FakeSocket[] = [];
    const client = new FleetClient({
      url: "ws://console.test/ws",
      socketFactory: () => {
        calls++;
        if (calls === 1) throw new Error("dial refused");
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      now: () => T0,
    });
    client.start();
    expect(client.getState().status).toBe("connecting");
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(1);
    client.stop();
  });
});

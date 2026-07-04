/**
 * The FleetClient's C5 config surface: `requestConfig`/`refreshConfig` frames out,
 * `config`/`config-unavailable` frames folded in, and the refresh UX timeout — all
 * over the injected fake socket (no network, fake timers, no sleeps).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@edgecommons/edge-console-protocol";
import type { ServerMessage } from "@edgecommons/edge-console-protocol";
import { FleetClient } from "../src/fleet/client";
import type { SocketLike } from "../src/fleet/client";
import { T0, key } from "./_fixtures";

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
  open(): void {
    this.onopen?.();
  }
  frame(msg: ServerMessage): void {
    this.onmessage?.(JSON.stringify(msg));
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

function rig(opts: { refreshTimeoutMs?: number } = {}) {
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
    ...(opts.refreshTimeoutMs !== undefined ? { refreshTimeoutMs: opts.refreshTimeoutMs } : {}),
  });
  client.start();
  return { client, sockets, clock };
}

const KEY = key("gw-01", "modbus-adapter");
const ID = "gw-01/modbus-adapter";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("FleetClient - requestConfig", () => {
  it("marks the entry loading and sends a version-stamped get-config when connected", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();

    client.requestConfig(KEY);

    expect(client.getState().configs.entriesById[ID]).toMatchObject({ phase: "loading" });
    expect(sockets[0]!.frames().at(-1)).toEqual({
      type: "get-config",
      protocolVersion: PROTOCOL_VERSION,
      key: KEY,
    });
    client.stop();
  });

  it("while disconnected: still marks loading, sends nothing (the view re-requests on reconnect)", () => {
    const { client, sockets } = rig();
    // never opened — status is "connecting"
    client.requestConfig(KEY);
    expect(client.getState().configs.entriesById[ID]).toMatchObject({ phase: "loading" });
    expect(sockets[0]!.sent).toHaveLength(0);
    client.stop();
  });

  it("folds the config answer (body verbatim) and the unavailable answer", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();
    client.requestConfig(KEY);

    const body = { config: { credentials: { password: "***" } } };
    sockets[0]!.frame({
      type: "config",
      protocolVersion: PROTOCOL_VERSION,
      key: KEY,
      cfg: body,
      receivedAt: T0 - 500,
      sourceTimestamp: "2026-07-03T00:00:00.000Z",
    });
    expect(client.getState().configs.entriesById[ID]).toMatchObject({
      phase: "loaded",
      body,
      receivedAt: T0 - 500,
      sourceTimestamp: "2026-07-03T00:00:00.000Z",
    });

    const other = key("gw-02", "opcua-adapter");
    client.requestConfig(other);
    sockets[0]!.frame({ type: "config-unavailable", protocolVersion: PROTOCOL_VERSION, key: other });
    expect(client.getState().configs.entriesById["gw-02/opcua-adapter"]).toMatchObject({
      phase: "unavailable",
    });
    client.stop();
  });

  it("an unsolicited config push folds too (server-side interest push)", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();
    sockets[0]!.frame({
      type: "config",
      protocolVersion: PROTOCOL_VERSION,
      key: KEY,
      cfg: { config: { pushed: true } },
      receivedAt: T0,
    });
    expect(client.getState().configs.entriesById[ID]).toMatchObject({
      phase: "loaded",
      body: { config: { pushed: true } },
    });
    client.stop();
  });
});

describe("FleetClient - refreshConfig", () => {
  it("sends refresh-config for the key's DEVICE and flags the entry refreshing", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();
    client.requestConfig(KEY);

    client.refreshConfig(KEY);

    expect(sockets[0]!.frames().at(-1)).toEqual({
      type: "refresh-config",
      protocolVersion: PROTOCOL_VERSION,
      device: "gw-01",
    });
    expect(client.getState().configs.entriesById[ID]!.refreshing).toBe(true);
    client.stop();
  });

  it("a config arrival ends the refresh (flag cleared, body updated)", () => {
    const { client, sockets } = rig({ refreshTimeoutMs: 10_000 });
    sockets[0]!.open();
    client.requestConfig(KEY);
    client.refreshConfig(KEY);

    sockets[0]!.frame({
      type: "config",
      protocolVersion: PROTOCOL_VERSION,
      key: KEY,
      cfg: { config: { fresh: true } },
      receivedAt: T0 + 800,
    });
    const entry = client.getState().configs.entriesById[ID]!;
    expect(entry.refreshing).toBe(false);
    expect(entry.body).toEqual({ config: { fresh: true } });

    // The canceled timeout must not clear a LATER refresh early.
    client.refreshConfig(KEY);
    vi.advanceTimersByTime(9_000);
    expect(client.getState().configs.entriesById[ID]!.refreshing).toBe(true);
    client.stop();
  });

  it("without any answer the refresh flag clears on the client-side timeout (absence is silent)", () => {
    const { client, sockets } = rig({ refreshTimeoutMs: 10_000 });
    sockets[0]!.open();
    client.requestConfig(KEY);
    client.refreshConfig(KEY);
    expect(client.getState().configs.entriesById[ID]!.refreshing).toBe(true);

    vi.advanceTimersByTime(10_001);
    expect(client.getState().configs.entriesById[ID]!.refreshing).toBe(false);
    client.stop();
  });

  it("stop() cancels pending refresh timers", () => {
    const { client, sockets } = rig({ refreshTimeoutMs: 10_000 });
    sockets[0]!.open();
    client.refreshConfig(KEY);
    client.stop();
    vi.advanceTimersByTime(20_000); // must not fire into a stopped client
    expect(client.getState().configs.entriesById[ID]!.refreshing).toBe(true); // frozen as-is
  });
});

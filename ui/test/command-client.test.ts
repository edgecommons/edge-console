/**
 * The C4 FleetClient IO shell around the CommandStore: `invokeCommand` sends the frame +
 * marks pending, a `command-result` folds in, a disconnect settles in-flight commands, and
 * the backstop timer settles a command the gateway never answered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@edgecommons/edge-console-protocol";
import type { ComponentKey, ServerMessage } from "@edgecommons/edge-console-protocol";
import { FleetClient } from "../src/fleet/client";
import type { SocketLike } from "../src/fleet/client";
import { T0 } from "./_fixtures";

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
  serverClose(): void {
    this.onclose?.();
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

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

const KEY: ComponentKey = { device: "gw-01", component: "opcua-adapter" };

function result(requestId: string, over: Partial<Extract<ServerMessage, { type: "command-result" }>> = {}): ServerMessage {
  return {
    type: "command-result",
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    key: KEY,
    verb: "ping",
    ok: true,
    result: { status: "RUNNING", uptimeSecs: 42 },
    elapsedMs: 12,
    ...over,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("FleetClient - invokeCommand", () => {
  it("sends an invoke-command frame and marks the command pending", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();
    const requestId = client.invokeCommand(KEY, "ping");

    const last = sockets[0]!.frames().at(-1)!;
    expect(last).toMatchObject({ type: "invoke-command", requestId, key: KEY, verb: "ping" });
    expect(client.getState().commands.byId[requestId]?.phase).toBe("pending");
    client.stop();
  });

  it("carries args and folds a matching command-result into the store", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();
    const requestId = client.invokeCommand(KEY, "set-log-level", { level: "DEBUG" });
    expect(sockets[0]!.frames().at(-1)).toMatchObject({ args: { level: "DEBUG" } });

    sockets[0]!.frame(result(requestId, { verb: "set-log-level", result: { applied: true } }));
    expect(client.getState().commands.byId[requestId]).toMatchObject({
      phase: "ok",
      result: { applied: true },
    });
    client.stop();
  });

  it("folds an error command-result (e.g. FORBIDDEN) as an error phase", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();
    const requestId = client.invokeCommand(KEY, "reload-config");
    sockets[0]!.frame(
      result(requestId, {
        verb: "reload-config",
        ok: false,
        error: { code: "FORBIDDEN", message: "not permitted" },
        result: undefined,
      }),
    );
    expect(client.getState().commands.byId[requestId]).toMatchObject({
      phase: "error",
      error: { code: "FORBIDDEN" },
    });
    client.stop();
  });

  it("settles immediately (DISCONNECTED) when invoked without a live connection", () => {
    const { client, sockets } = rig();
    // not opened yet ⇒ status is "connecting", no socket send
    const requestId = client.invokeCommand(KEY, "ping");
    expect(client.getState().commands.byId[requestId]).toMatchObject({
      phase: "error",
      error: { code: "DISCONNECTED" },
    });
    // No invoke-command frame was sent.
    expect(sockets[0]!.frames().some((f) => f.type === "invoke-command")).toBe(false);
    client.stop();
  });

  it("fails in-flight commands when the connection drops", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();
    const requestId = client.invokeCommand(KEY, "ping");
    expect(client.getState().commands.byId[requestId]?.phase).toBe("pending");

    sockets[0]!.serverClose();
    expect(client.getState().commands.byId[requestId]).toMatchObject({
      phase: "error",
      error: { code: "DISCONNECTED" },
    });
    client.stop();
  });

  it("fires a backstop TIMEOUT when the gateway never answers", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();
    const requestId = client.invokeCommand(KEY, "ping");

    vi.advanceTimersByTime(65_000); // the default commandTimeoutMs
    expect(client.getState().commands.byId[requestId]).toMatchObject({
      phase: "error",
      error: { code: "TIMEOUT" },
    });
    client.stop();
  });

  it("a command-result clears the backstop timer (no late spurious failure)", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();
    const requestId = client.invokeCommand(KEY, "ping");
    sockets[0]!.frame(result(requestId));
    expect(client.getState().commands.byId[requestId]?.phase).toBe("ok");

    vi.advanceTimersByTime(120_000); // the backstop must NOT flip the settled entry
    expect(client.getState().commands.byId[requestId]?.phase).toBe("ok");
    client.stop();
  });
});

describe("FleetClient - descriptor discovery", () => {
  it("sends get-descriptor / refresh-descriptor frames and folds descriptor replies", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();

    client.requestDescriptor(KEY);
    expect(sockets[0]!.frames().at(-1)).toMatchObject({ type: "get-descriptor", key: KEY });
    expect(client.getState().descriptions.entriesById["gw-01/opcua-adapter"]?.phase).toBe("loading");

    sockets[0]!.frame({
      type: "descriptor",
      protocolVersion: PROTOCOL_VERSION,
      key: KEY,
      receivedAt: T0 - 10,
      manifest: {
        schema: "edgecommons.component.describe.v1",
        commands: [{ verb: "describe", builtIn: true }],
        panels: { schema: "edgecommons.panels.v2", provider: "opcua-adapter", renderer: "descriptor", views: [] },
      },
    });
    expect(client.getState().descriptions.entriesById["gw-01/opcua-adapter"]).toMatchObject({
      phase: "ready",
      receivedAt: T0 - 10,
      manifest: { panels: { provider: "opcua-adapter" } },
    });

    client.refreshDescriptor(KEY);
    expect(sockets[0]!.frames().at(-1)).toMatchObject({ type: "refresh-descriptor", key: KEY });
    expect(client.getState().descriptions.entriesById["gw-01/opcua-adapter"]).toMatchObject({
      phase: "ready",
      refreshing: true,
    });

    sockets[0]!.frame({
      type: "descriptor-unavailable",
      protocolVersion: PROTOCOL_VERSION,
      key: KEY,
      code: "REQUEST_FAILED",
      reason: "describe timed out",
    });
    expect(client.getState().descriptions.entriesById["gw-01/opcua-adapter"]).toMatchObject({
      phase: "unavailable",
      code: "REQUEST_FAILED",
      reason: "describe timed out",
      manifest: { panels: { provider: "opcua-adapter" } },
    });
    client.stop();
  });
});

/**
 * The FleetClient's R6 `settings` capture — the console's own effective policy +
 * configuration, folded into the client state from the server-pushed `settings` frame
 * (no client request), over the injected fake socket.
 */
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@edgecommons/edge-console-protocol";
import type { ServerMessage } from "@edgecommons/edge-console-protocol";
import { FleetClient } from "../src/fleet/client";
import type { SocketLike } from "../src/fleet/client";
import { T0, consoleSettings } from "./_fixtures";

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
}

function rig() {
  const sockets: FakeSocket[] = [];
  const client = new FleetClient({
    url: "ws://console.test/ws",
    socketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    now: () => T0,
  });
  client.start();
  return { client, sockets };
}

describe("FleetClient — settings (R6)", () => {
  it("is undefined until a settings frame arrives, then holds the pushed policy", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();
    expect(client.getState().settings).toBeUndefined();

    const settings = consoleSettings();
    sockets[0]!.frame({ type: "settings", protocolVersion: PROTOCOL_VERSION, settings });
    expect(client.getState().settings).toEqual(settings);
  });

  it("replaces the held settings on a later frame (reconnect self-heals)", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();
    sockets[0]!.frame({ type: "settings", protocolVersion: PROTOCOL_VERSION, settings: consoleSettings() });

    const updated = consoleSettings({
      rbac: { defaultRole: "viewer", roles: [{ name: "viewer", allow: ["ping"], deny: [], isDefault: true }] },
    });
    sockets[0]!.frame({ type: "settings", protocolVersion: PROTOCOL_VERSION, settings: updated });
    expect(client.getState().settings?.rbac.defaultRole).toBe("viewer");
  });

  it("keeps a stable state identity when nothing changed", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();
    sockets[0]!.frame({ type: "settings", protocolVersion: PROTOCOL_VERSION, settings: consoleSettings() });
    const a = client.getState();
    const b = client.getState();
    expect(a).toBe(b);
    expect(a.settings).toBeDefined();
  });
});

/**
 * The FleetClient's R0/R1 runtime-attribute surface + the bus-throughput on the
 * heartbeat — subscribe/unsubscribe frames out, `attributes`/`attribute` folded in, and
 * the heartbeat's `busMsgsPerSec` captured onto the client state. All over the injected
 * fake socket (no network, no sleeps).
 */
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@edgecommons/edge-console-protocol";
import type { ServerMessage } from "@edgecommons/edge-console-protocol";
import { FleetClient } from "../src/fleet/client";
import type { SocketLike } from "../src/fleet/client";
import { T0, key, runtimeAttrs } from "./_fixtures";

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

describe("FleetClient — runtime attributes", () => {
  it("sends subscribe/unsubscribe-attributes when connected", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();
    client.subscribeAttributes();
    client.unsubscribeAttributes();
    expect(sockets[0]!.frames().slice(1)).toEqual([
      { type: "subscribe-attributes", protocolVersion: PROTOCOL_VERSION },
      { type: "unsubscribe-attributes", protocolVersion: PROTOCOL_VERSION },
    ]);
  });

  it("folds an attributes snapshot then latest-wins attribute updates into state", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();

    sockets[0]!.frame({
      type: "attributes",
      protocolVersion: PROTOCOL_VERSION,
      components: [
        runtimeAttrs(key("gw-01", "opcua-adapter"), { cpuPercent: 12, memoryMb: 210, connectionState: "CONNECTED" }),
      ],
    });
    let attrs = client.getState().attributes.byId["gw-01/opcua-adapter"];
    expect(attrs?.cpuPercent).toBe(12);
    expect(attrs?.connectionState).toBe("CONNECTED");

    sockets[0]!.frame({
      type: "attribute",
      protocolVersion: PROTOCOL_VERSION,
      updates: [runtimeAttrs(key("gw-01", "opcua-adapter"), { cpuPercent: 33, connectionState: "RECONNECTING" })],
    });
    attrs = client.getState().attributes.byId["gw-01/opcua-adapter"];
    expect(attrs?.cpuPercent).toBe(33);
    expect(attrs?.connectionState).toBe("RECONNECTING");
  });
});

describe("FleetClient — bus throughput on the heartbeat", () => {
  it("captures busMsgsPerSec from the heartbeat frame (undefined until it arrives)", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();
    expect(client.getState().busMsgsPerSec).toBeUndefined();

    sockets[0]!.frame({ type: "heartbeat", protocolVersion: PROTOCOL_VERSION, at: T0, busMsgsPerSec: 4.2 });
    expect(client.getState().busMsgsPerSec).toBe(4.2);

    // A heartbeat without the field leaves the last-known rate untouched.
    sockets[0]!.frame({ type: "heartbeat", protocolVersion: PROTOCOL_VERSION, at: T0 + 1000 });
    expect(client.getState().busMsgsPerSec).toBe(4.2);
  });
});

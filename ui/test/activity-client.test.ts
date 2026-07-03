/**
 * The FleetClient's C6 activity surface: subscribe/unsubscribe frames out,
 * `events`/`event`/`metrics`/`metric` frames folded in — all over the injected
 * fake socket (no network, no sleeps).
 */
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@edgecommons/edge-console-protocol";
import type { ServerMessage } from "@edgecommons/edge-console-protocol";
import { FleetClient } from "../src/fleet/client";
import type { SocketLike } from "../src/fleet/client";
import { T0, consoleEvent, key } from "./_fixtures";

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

const KEY = key("gw-01", "opcua-adapter");

describe("FleetClient - activity subscriptions", () => {
  it("sends version-stamped subscribe/unsubscribe frames when connected", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();

    client.subscribeEvents(50);
    client.subscribeMetrics();
    client.unsubscribeEvents();
    client.unsubscribeMetrics();

    expect(sockets[0]!.frames().slice(1)).toEqual([
      { type: "subscribe-events", protocolVersion: PROTOCOL_VERSION, limit: 50 },
      { type: "subscribe-metrics", protocolVersion: PROTOCOL_VERSION },
      { type: "unsubscribe-events", protocolVersion: PROTOCOL_VERSION },
      { type: "unsubscribe-metrics", protocolVersion: PROTOCOL_VERSION },
    ]);
    client.stop();
  });

  it("while disconnected the frames are quietly skipped (the view re-subscribes on reconnect)", () => {
    const { client, sockets } = rig();
    // never opened — status is "connecting"
    client.subscribeEvents();
    client.subscribeMetrics();
    expect(sockets[0]!.sent).toHaveLength(0);
    client.stop();
  });

  it("folds the events backlog then live event pushes (deduped) into the state", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();

    sockets[0]!.frame({
      type: "events",
      protocolVersion: PROTOCOL_VERSION,
      events: [consoleEvent({ id: 2, type: "b" }), consoleEvent({ id: 1, type: "a" })],
    });
    expect(client.getState().events.entries.map((e) => e.type)).toEqual(["b", "a"]);

    sockets[0]!.frame({
      type: "event",
      protocolVersion: PROTOCOL_VERSION,
      event: consoleEvent({ id: 3, type: "c" }),
    });
    sockets[0]!.frame({
      type: "event",
      protocolVersion: PROTOCOL_VERSION,
      event: consoleEvent({ id: 2, type: "b-dup" }), // already in the backlog — dropped
    });
    expect(client.getState().events.entries.map((e) => e.type)).toEqual(["c", "b", "a"]);
    client.stop();
  });

  it("folds the metrics snapshot then live update batches into the state", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();

    sockets[0]!.frame({
      type: "metrics",
      protocolVersion: PROTOCOL_VERSION,
      series: [
        {
          key: KEY,
          metric: "sys",
          measure: "cpu",
          latest: 10,
          receivedAt: T0,
          points: [{ at: T0, value: 10 }],
        },
      ],
    });
    expect(client.getState().metrics.series[0]).toMatchObject({ metric: "sys", latest: 10 });

    sockets[0]!.frame({
      type: "metric",
      protocolVersion: PROTOCOL_VERSION,
      updates: [{ key: KEY, metric: "sys", measure: "cpu", point: { at: T0 + 5000, value: 22 } }],
    });
    const [series] = client.getState().metrics.series;
    expect(series!.latest).toBe(22);
    expect(series!.points.map((p) => p.value)).toEqual([10, 22]);
    client.stop();
  });

  it("state identity: activity folds refresh getState, unrelated frames leave it stable", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();
    const before = client.getState();

    sockets[0]!.frame({
      type: "event",
      protocolVersion: PROTOCOL_VERSION,
      event: consoleEvent({ id: 1 }),
    });
    const after = client.getState();
    expect(after).not.toBe(before);
    expect(after.events.entries).toHaveLength(1);
    expect(client.getState()).toBe(after); // cached until the next change
    client.stop();
  });
});

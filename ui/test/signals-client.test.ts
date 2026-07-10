/**
 * The FleetClient's R0 DATA-plane signal surface — subscribe/unsubscribe frames out,
 * `signals`/`signal` folded into the client state, all over the injected fake socket
 * (no network, no sleeps). Mirrors the attributes-client wiring test.
 */
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, componentKeyId } from "@edgecommons/edge-console-protocol";
import type { ServerMessage } from "@edgecommons/edge-console-protocol";
import { FleetClient } from "../src/fleet/client";
import type { SocketLike } from "../src/fleet/client";
import { T0, key, signalPoints, signalSeries } from "./_fixtures";

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

describe("FleetClient — data-plane signals", () => {
  it("sends subscribe/unsubscribe-signals when connected", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();
    client.subscribeSignals();
    client.unsubscribeSignals();
    expect(sockets[0]!.frames().slice(1)).toEqual([
      { type: "subscribe-signals", protocolVersion: PROTOCOL_VERSION },
      { type: "unsubscribe-signals", protocolVersion: PROTOCOL_VERSION },
    ]);
  });

  it("folds a signals snapshot then a live signal push into state", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();
    expect(client.getState().signals.series).toEqual([]);

    sockets[0]!.frame({
      type: "signals",
      protocolVersion: PROTOCOL_VERSION,
      series: [
        signalSeries(key("gw-01", "opcua-adapter"), "Temp", {
          latest: 72.4,
          quality: "GOOD",
          points: signalPoints([72.4], { quality: "GOOD" }),
        }),
      ],
    });
    let series = client.getState().signals.series;
    expect(series).toHaveLength(1);
    expect(series[0]!.latest).toBe(72.4);
    expect(series[0]!.quality).toBe("GOOD");

    sockets[0]!.frame({
      type: "signal",
      protocolVersion: PROTOCOL_VERSION,
      updates: [
        {
          key: key("gw-01", "opcua-adapter"),
          instance: "main", signal: "Temp",
          point: { at: T0 + 1000, value: 73.1, quality: "UNCERTAIN" },
        },
      ],
    });
    series = client.getState().signals.series;
    const s = series.find((x) => componentKeyId(x.key) === "gw-01/opcua-adapter" && x.signal === "Temp")!;
    expect(s.latest).toBe(73.1);
    expect(s.quality).toBe("UNCERTAIN");
    expect(s.points).toHaveLength(2);
  });

  it("subscribe-signals carries the summary mode when asked (R5)", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();
    client.subscribeSignals("summary");
    client.subscribeSignals(); // no arg ⇒ no mode key (full)
    expect(sockets[0]!.frames().slice(1)).toEqual([
      { type: "subscribe-signals", protocolVersion: PROTOCOL_VERSION, mode: "summary" },
      { type: "subscribe-signals", protocolVersion: PROTOCOL_VERSION },
    ]);
  });

  it("backfills points from a signal-points reply, and folds a point-less summary series", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();
    // Summary snapshot: a series with NO points key.
    const summary = signalSeries(key("gw-01", "opcua-adapter"), "filler/level", { latest: 63 });
    delete (summary as { points?: unknown }).points;
    sockets[0]!.frame({ type: "signals", protocolVersion: PROTOCOL_VERSION, series: [summary] });
    expect(client.getState().signals.series[0]!.points).toEqual([]);

    client.getSignalPoints([{ key: key("gw-01", "opcua-adapter"), instance: "main", signal: "filler/level" }]);
    expect(sockets[0]!.frames().at(-1)).toEqual({
      type: "get-signal-points",
      protocolVersion: PROTOCOL_VERSION,
      series: [{ key: key("gw-01", "opcua-adapter"), instance: "main", signal: "filler/level" }],
    });

    sockets[0]!.frame({
      type: "signal-points",
      protocolVersion: PROTOCOL_VERSION,
      series: [
        {
          key: key("gw-01", "opcua-adapter"),
          instance: "main",
          signal: "filler/level",
          points: signalPoints([61, 62, 63]),
        },
      ],
    });
    expect(client.getState().signals.series[0]!.points).toHaveLength(3);
  });

  it("getSignalPoints chunks selectors at the 200 ceiling", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();
    const selectors = Array.from({ length: 250 }, (_, i) => ({
      key: key("gw-01", "opcua-adapter"),
      instance: "main",
      signal: `s${i}`,
    }));
    client.getSignalPoints(selectors);
    const frames = sockets[0]!.frames().slice(1).filter((f) => f.type === "get-signal-points");
    expect(frames).toHaveLength(2);
    expect((frames[0]!.series as unknown[]).length).toBe(200);
    expect((frames[1]!.series as unknown[]).length).toBe(50);
  });

  it("onSignalUpdate observers see the raw live batch (the msg/s meter's source)", () => {
    const { client, sockets } = rig();
    sockets[0]!.open();
    const seen: number[] = [];
    const off = client.onSignalUpdate((updates) => seen.push(updates.length));
    sockets[0]!.frame({
      type: "signal",
      protocolVersion: PROTOCOL_VERSION,
      updates: [
        { key: key("gw-01", "opcua-adapter"), instance: "main", signal: "a", point: { at: T0, value: 1 } },
        { key: key("gw-01", "opcua-adapter"), instance: "main", signal: "b", point: { at: T0, value: 2 } },
      ],
    });
    off();
    sockets[0]!.frame({
      type: "signal",
      protocolVersion: PROTOCOL_VERSION,
      updates: [{ key: key("gw-01", "opcua-adapter"), instance: "main", signal: "a", point: { at: T0 + 1, value: 3 } }],
    });
    expect(seen).toEqual([2]); // the first batch only; unsubscribed before the second
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PROTOCOL_VERSION } from "@edgecommons/edge-console-protocol";
import type { ServerMessage } from "@edgecommons/edge-console-protocol";
import App from "../src/App";
import { FleetClient } from "../src/fleet/client";
import type { SocketLike } from "../src/fleet/client";
import { T0, compSnap, deviceSnap, key, snapshot } from "./_fixtures";

afterEach(cleanup);

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
}

describe("App shell", () => {
  it("mounts the Carbon g100 shell and drives the edge-health view from the injected client", () => {
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

    render(<App client={client} />);

    // Shell chrome: header brand + the (only-real-views) side rail.
    expect(screen.getByText("Edge Console")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Overview/ })).toBeTruthy();
    // The client was started by the view lifecycle and dialed the gateway.
    expect(sockets).toHaveLength(1);
    expect(screen.getByText("Connecting to the console gateway…")).toBeTruthy();

    // Server side: open -> hello -> snapshot; the fleet renders live.
    act(() => {
      sockets[0]!.onopen?.();
    });
    expect(JSON.parse(sockets[0]!.sent[0]!)).toEqual({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
    });
    act(() => {
      const msg: ServerMessage = {
        type: "snapshot",
        protocolVersion: PROTOCOL_VERSION,
        snapshot: snapshot([deviceSnap("gw-01", [compSnap({ key: key("gw-01", "opcua-adapter") })])]),
      };
      sockets[0]!.onmessage?.(JSON.stringify(msg));
    });
    const row = screen.getByTestId("component-row-gw-01/opcua-adapter/main");
    expect(within(row).getByText("Healthy")).toBeTruthy();
  });

  it("navigates Overview <-> Configuration over the ONE shared client (no socket churn)", () => {
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

    render(<App client={client} />);
    act(() => {
      sockets[0]!.onopen?.();
      const msg: ServerMessage = {
        type: "snapshot",
        protocolVersion: PROTOCOL_VERSION,
        snapshot: snapshot([deviceSnap("gw-01", [compSnap({ key: key("gw-01", "opcua-adapter") })])]),
      };
      sockets[0]!.onmessage?.(JSON.stringify(msg));
    });

    // To the config view: the second nav destination renders the C5 screen.
    fireEvent.click(screen.getByRole("link", { name: /Configuration/ }));
    expect(screen.getByText("Configuration review")).toBeTruthy();
    expect(screen.getByTestId("config-picker")).toBeTruthy();

    // Selecting a component issues get-config on the SAME socket (no second dial).
    fireEvent.click(screen.getByTestId("config-pick-gw-01/opcua-adapter/main"));
    expect(sockets).toHaveLength(1);
    const frames = sockets[0]!.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    expect(frames.at(-1)).toMatchObject({
      type: "get-config",
      key: { device: "gw-01", component: "opcua-adapter", instance: "main" },
    });

    // And back: the health view returns, the socket still lives.
    fireEvent.click(screen.getByRole("link", { name: /Overview/ }));
    expect(screen.getByText("Edge health")).toBeTruthy();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(false);
  });

  it("navigates to Events and Metrics (C6): mount subscribes, unmount unsubscribes, same socket", () => {
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

    render(<App client={client} />);
    act(() => {
      sockets[0]!.onopen?.();
    });
    const frames = () => sockets[0]!.sent.map((s) => JSON.parse(s) as Record<string, unknown>);

    // Events: mounting the view subscribes the stream on the shared socket.
    fireEvent.click(screen.getByRole("link", { name: /Events/ }));
    expect(screen.getByText("No events yet")).toBeTruthy();
    expect(frames().at(-1)).toMatchObject({ type: "subscribe-events" });

    // A live backlog + push renders rows without any refetch.
    act(() => {
      const backlog: ServerMessage = {
        type: "events",
        protocolVersion: PROTOCOL_VERSION,
        events: [
          {
            id: 1,
            key: key("gw-01", "opcua-adapter"),
            severity: "warning",
            type: "connection-retry",
            channel: "warning/connection-retry",
            body: { message: "retrying" },
            receivedAt: T0,
          },
        ],
      };
      sockets[0]!.onmessage?.(JSON.stringify(backlog));
    });
    expect(screen.getByTestId("event-row-1")).toBeTruthy();

    // To Metrics: events unsubscribes, metrics subscribes — still ONE socket.
    fireEvent.click(screen.getByRole("link", { name: /Metrics/ }));
    expect(screen.getByText("No metrics yet")).toBeTruthy();
    const sent = frames();
    expect(sent.at(-2)).toMatchObject({ type: "unsubscribe-events" });
    expect(sent.at(-1)).toMatchObject({ type: "subscribe-metrics" });

    act(() => {
      const snapMsg: ServerMessage = {
        type: "metrics",
        protocolVersion: PROTOCOL_VERSION,
        series: [
          {
            key: key("gw-01", "opcua-adapter"),
            metric: "sys",
            measure: "cpu",
            latest: 12.5,
            receivedAt: T0,
            points: [{ at: T0, value: 12.5 }],
          },
        ],
      };
      sockets[0]!.onmessage?.(JSON.stringify(snapMsg));
    });
    expect(screen.getByTestId("metric-row-gw-01/opcua-adapter/main::sys::cpu")).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: /Overview/ }));
    expect(frames().at(-1)).toMatchObject({ type: "unsubscribe-metrics" });
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(false);
  });
});

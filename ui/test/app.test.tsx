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

  it("navigates to Events (C6): mount subscribes, same socket, no Metrics nav (R0)", () => {
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

    // The off-contract Metrics page is gone from the nav (R0).
    expect(screen.queryByRole("link", { name: /Metrics/ })).toBeNull();

    // On connect the shell subscribes the global alarm surface (the notifications badge).
    expect(frames().some((f) => f.type === "subscribe-alarms")).toBe(true);

    // Events: mounting the view subscribes the stream on the shared socket.
    fireEvent.click(screen.getByRole("link", { name: /Events/ }));
    expect(screen.getByText("No events yet")).toBeTruthy();
    expect(frames().at(-1)).toMatchObject({ type: "subscribe-events" });

    // A live backlog renders rows without any refetch.
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

    fireEvent.click(screen.getByRole("link", { name: /Overview/ }));
    expect(screen.getByText("Edge health")).toBeTruthy();
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(false);
  });

  it("navigates to Components (R2): the dynamic tree renders, and Open detail shows the detail breadcrumb", () => {
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

    // The Components nav lands; the tree is built from the identity hierarchy.
    fireEvent.click(screen.getByRole("link", { name: /Components/ }));
    expect(screen.getByText("Browse the site inventory and drill into any component.")).toBeTruthy();
    expect(screen.getByTestId("component-tree")).toBeTruthy();

    // Select the component leaf → its summary → Open detail: same shared socket, no second dial.
    fireEvent.click(screen.getByTestId("tree-node-gw-01/opcua-adapter/main"));
    fireEvent.click(screen.getByTestId("open-detail"));
    expect(sockets).toHaveLength(1);
    const crumbs = screen.getByTestId("detail-crumbs");
    expect(within(crumbs).getByText("opcua-adapter")).toBeTruthy();
    // The detail requested this component's cfg on the SAME socket (embedded Configuration tab).
    const frames = sockets[0]!.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
    expect(frames.some((f) => f.type === "get-config")).toBe(true);

    // Back to Components via the breadcrumb.
    fireEvent.click(screen.getByTestId("crumb-components"));
    expect(screen.getByTestId("component-tree")).toBeTruthy();
    expect(sockets[0]!.closed).toBe(false);
  });

  it("filters the fleet from the app-bar global search (shared SearchContext → Overview)", () => {
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
        snapshot: snapshot([
          deviceSnap("gw-01", [
            compSnap({ key: key("gw-01", "opcua-adapter") }),
            compSnap({ key: key("gw-01", "modbus-adapter") }),
          ]),
        ]),
      };
      sockets[0]!.onmessage?.(JSON.stringify(msg));
    });

    // Both rows are visible before searching.
    expect(screen.getByTestId("component-row-gw-01/opcua-adapter/main")).toBeTruthy();
    expect(screen.getByTestId("component-row-gw-01/modbus-adapter/main")).toBeTruthy();

    // Typing "opcua" in the app-bar search filters the fleet table live.
    fireEvent.change(screen.getByTestId("appbar-search"), { target: { value: "opcua" } });
    expect(screen.getByTestId("component-row-gw-01/opcua-adapter/main")).toBeTruthy();
    expect(screen.queryByTestId("component-row-gw-01/modbus-adapter/main")).toBeNull();
  });

  it("renders the app-bar chrome: search, theme toggle (g100↔g10), alarm badge, account role", () => {
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

    const { container } = render(<App client={client} />);

    // Global search box present.
    expect(screen.getByTestId("appbar-search")).toBeTruthy();

    // Theme starts g100 (dark) and the toggle flips it to g10 (light).
    expect(container.querySelector(".cds--g100")).toBeTruthy();
    fireEvent.click(screen.getByTestId("appbar-theme"));
    expect(container.querySelector(".cds--g10")).toBeTruthy();
    expect(container.querySelector(".cds--g100")).toBeNull();

    // Connect, then a welcome + alarms frame drive the account role + notifications badge.
    act(() => {
      sockets[0]!.onopen?.();
      const welcome: ServerMessage = { type: "welcome", protocolVersion: PROTOCOL_VERSION, role: "operator" };
      const alarms: ServerMessage = {
        type: "alarms",
        protocolVersion: PROTOCOL_VERSION,
        snapshot: {
          active: [
            {
              id: "gw-01/opcua-adapter/main::connection-lost",
              key: key("gw-01", "opcua-adapter"),
              componentId: "gw-01/opcua-adapter/main",
              severity: "critical",
              type: "connection-lost",
              raisedAt: T0,
              lastAt: T0,
              count: 1,
              acked: false,
              contained: false,
            },
          ],
          counts: { critical: 1, warning: 0, active: 1, contained: 0, acked: 0 },
        },
      };
      sockets[0]!.onmessage?.(JSON.stringify(welcome));
      sockets[0]!.onmessage?.(JSON.stringify(alarms));
    });

    expect(screen.getByTestId("appbar-role").textContent).toBe("operator");
    expect(screen.getByTestId("appbar-alarm-count").textContent).toBe("1");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
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
});

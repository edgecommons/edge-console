/**
 * The Signals view (R5) — presentational tests (state in, DOM out, callbacks observed)
 * plus App-level integration (nav mounts + subscribes the signal stream, live frames
 * render rows, the app-bar search filters, Read fires the `sb.read` command, and the
 * Component-Detail "Signals" deep-link scopes the screen). The projection/quality/filter
 * logic itself is covered in `signals-selectors.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PROTOCOL_VERSION } from "@edgecommons/edge-console-protocol";
import type { ServerMessage, SignalSeriesSnapshot } from "@edgecommons/edge-console-protocol";
import App from "../src/App";
import { SignalsView } from "../src/signals/SignalsView";
import { FleetClient } from "../src/fleet/client";
import type { SocketLike } from "../src/fleet/client";
import {
  T0,
  clientState,
  compSnap,
  deviceSnap,
  fleetView,
  key,
  signalPoints,
  signalSeries,
  snapshot,
} from "./_fixtures";

afterEach(cleanup);

const PRESS = key("press-gw-01", "opcua-adapter");
const PACK = key("pack-gw-01", "modbus-adapter");

/** The mockup's three rows + a no-quality bare-scalar signal. */
function demoSeries(): SignalSeriesSnapshot[] {
  return [
    signalSeries(PRESS, "Temp_01", {
      latest: 72.4,
      quality: "GOOD",
      receivedAt: T0 - 2000,
      points: signalPoints([70, 71, 72.4], { quality: "GOOD", startAt: T0 - 4000 }),
    }),
    signalSeries(PRESS, "Pressure", {
      latest: 4.1,
      quality: "UNCERTAIN",
      receivedAt: T0 - 1000,
      points: signalPoints([4.0, 4.2, 4.1], { quality: "UNCERTAIN", startAt: T0 - 3000 }),
    }),
    signalSeries(PACK, "Flow_A", {
      latest: null,
      quality: "BAD",
      receivedAt: T0 - 840_000, // 14 minutes ago
      points: [{ at: T0 - 840_000, value: null, quality: "BAD" }],
    }),
    signalSeries(PRESS, "raw_count", {
      latest: 5,
      receivedAt: T0 - 3000,
      points: signalPoints([3, 4, 5], { startAt: T0 - 5000 }), // no quality token
    }),
  ];
}

function renderView(overrides: Partial<Parameters<typeof SignalsView>[0]> = {}) {
  const onRead = vi.fn();
  const onComponentScopeChange = vi.fn();
  render(
    <SignalsView
      state={clientState(fleetView([]), { signals: { series: demoSeries() } })}
      now={T0}
      query=""
      onComponentScopeChange={onComponentScopeChange}
      onRead={onRead}
      {...overrides}
    />,
  );
  return { onRead, onComponentScopeChange };
}

describe("SignalsView (presentational)", () => {
  it("lists a row per signal with the mockup columns (value · quality · trend · age)", () => {
    renderView();
    const table = screen.getByTestId("signals-table");
    expect(within(table).getAllByTestId(/^signal-row-/)).toHaveLength(4);

    // GOOD Temp_01: formatted value, a GOOD chip, a sparkline, "2s" age.
    const temp = screen.getByTestId("signal-row-press-gw-01/opcua-adapter/main Temp_01");
    expect(within(temp).getByText("72.4")).toBeTruthy();
    expect(within(temp).getByTestId("quality-good")).toBeTruthy();
    expect(within(temp).getByTestId("sparkline")).toBeTruthy();
    expect(within(temp).getByText("press-gw-01 / Temp_01")).toBeTruthy();
    expect(within(temp).getByTestId("signal-age-press-gw-01/opcua-adapter/main Temp_01").textContent).toBe("2s");

    // UNCERTAIN Pressure: a warn chip showing the raw token.
    const press = screen.getByTestId("signal-row-press-gw-01/opcua-adapter/main Pressure");
    expect(within(press).getByTestId("quality-uncertain").textContent).toContain("UNCERTAIN");

    // BAD Flow_A: value-less (em dash), a BAD chip, NO sparkline, "14m" age.
    const flow = screen.getByTestId("signal-row-pack-gw-01/modbus-adapter/main Flow_A");
    expect(within(flow).getByTestId("quality-bad")).toBeTruthy();
    expect(within(flow).queryByTestId("sparkline")).toBeNull();
    expect(within(flow).getByTestId("signal-age-pack-gw-01/modbus-adapter/main Flow_A").textContent).toBe("14m");

    // A bare-scalar signal with no quality token: an honest em dash, not a faked GOOD.
    const raw = screen.getByTestId("signal-row-press-gw-01/opcua-adapter/main raw_count");
    expect(within(raw).getByTestId("quality-none")).toBeTruthy();
  });

  it("honestly flags units / name / limits as pending (not on the data body)", () => {
    renderView();
    expect(screen.getByTestId("signals-pending-note").textContent).toMatch(/units.*limits pending/i);
  });

  it("shows the Live chip when connected and filters via the app-bar query", () => {
    const { rerender } = renderWithQuery("");
    expect(screen.getByTestId("signals-live").textContent).toContain("Live");
    expect(screen.getAllByTestId(/^signal-row-/)).toHaveLength(4);

    rerender("temp");
    expect(screen.getAllByTestId(/^signal-row-/)).toHaveLength(1);
    expect(screen.getByTestId("signal-filter-count").textContent).toBe("1 of 4 signals");
  });

  it("scopes to one component and fires Read for a row", () => {
    const { onRead } = renderView({ componentScope: "pack-gw-01/modbus-adapter" });
    const rows = screen.getAllByTestId(/^signal-row-/);
    expect(rows).toHaveLength(1);
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "Read" }));
    expect(onRead).toHaveBeenCalledWith(PACK, "Flow_A");
  });

  it("renders the connecting empty state with no signals", () => {
    render(
      <SignalsView
        state={clientState(fleetView([]), { signals: { series: [] }, status: "connecting" })}
        now={T0}
        query=""
        onComponentScopeChange={vi.fn()}
        onRead={vi.fn()}
      />,
    );
    expect(screen.getByTestId("signals-empty")).toBeTruthy();
    expect(screen.getByText("Connecting to the console gateway…")).toBeTruthy();
  });

  it("warns (but keeps the last signals) when the connection drops", () => {
    render(
      <SignalsView
        state={clientState(fleetView([]), { signals: { series: demoSeries() }, status: "reconnecting" })}
        now={T0}
        query=""
        onComponentScopeChange={vi.fn()}
        onRead={vi.fn()}
      />,
    );
    expect(screen.getByText("Gateway connection lost — reconnecting")).toBeTruthy();
    expect(screen.getAllByTestId(/^signal-row-/)).toHaveLength(4);
  });
});

/** Re-render helper that flips only the query prop (the app-bar filter path). */
function renderWithQuery(initial: string) {
  const props = {
    state: clientState(fleetView([]), { signals: { series: demoSeries() } }),
    now: T0,
    onComponentScopeChange: vi.fn(),
    onRead: vi.fn(),
  };
  const { rerender: raw } = render(<SignalsView {...props} query={initial} />);
  return { rerender: (q: string) => raw(<SignalsView {...props} query={q} />) };
}

// ---------------------------------------------------------------- App integration

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

function appRig() {
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
  const frames = () => sockets[0]!.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  return { sockets, frames };
}

describe("App — Signals screen (R5) integration", () => {
  it("mounts on nav (subscribes the signal stream on the shared socket), renders live rows, search + Read wired", () => {
    const { sockets, frames } = appRig();
    act(() => sockets[0]!.onopen?.());

    fireEvent.click(screen.getByRole("link", { name: /Signals/ }));
    expect(frames().at(-1)).toMatchObject({ type: "subscribe-signals" });

    // A live `signals` snapshot renders the rows without any refetch.
    act(() => {
      const msg: ServerMessage = {
        type: "signals",
        protocolVersion: PROTOCOL_VERSION,
        series: demoSeries(),
      };
      sockets[0]!.onmessage?.(JSON.stringify(msg));
    });
    expect(screen.getAllByTestId(/^signal-row-/)).toHaveLength(4);

    // The app-bar search filters the signals live.
    fireEvent.change(screen.getByTestId("appbar-search"), { target: { value: "flow" } });
    expect(screen.getAllByTestId(/^signal-row-/)).toHaveLength(1);
    fireEvent.change(screen.getByTestId("appbar-search"), { target: { value: "" } });

    // Read fires an sb.read command on the SAME socket (no second dial).
    fireEvent.click(screen.getAllByRole("button", { name: "Read" })[0]!);
    expect(sockets).toHaveLength(1);
    expect(frames().some((f) => f.type === "invoke-command" && f.verb === "sb.read")).toBe(true);

    // Leaving unsubscribes.
    fireEvent.click(screen.getByRole("link", { name: /Overview/ }));
    expect(frames().at(-1)).toMatchObject({ type: "unsubscribe-signals" });
  });

  it("deep-links from Component Detail scoped to that component", () => {
    const { sockets } = appRig();
    act(() => {
      sockets[0]!.onopen?.();
      const snap: ServerMessage = {
        type: "snapshot",
        protocolVersion: PROTOCOL_VERSION,
        snapshot: snapshot([deviceSnap("press-gw-01", [compSnap({ key: PRESS })])]),
      };
      sockets[0]!.onmessage?.(JSON.stringify(snap));
      // Signals for two different components arrive on the wire.
      const sig: ServerMessage = {
        type: "signals",
        protocolVersion: PROTOCOL_VERSION,
        series: demoSeries(),
      };
      sockets[0]!.onmessage?.(JSON.stringify(sig));
    });

    // Components → select the leaf → inline detail → click the "Signals" deep-link.
    fireEvent.click(screen.getByRole("link", { name: /Components/ }));
    fireEvent.click(screen.getByTestId("tree-node-press-gw-01/opcua-adapter"));
    fireEvent.click(screen.getByTestId("detail-open-signals"));

    // Scoped to press-gw-01/opcua-adapter: only its three signals, not pack-gw-01's Flow_A.
    // (Order is the store's component-id-then-signal localeCompare: Pressure, raw_count, Temp_01.)
    const rows = screen.getAllByTestId(/^signal-row-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "signal-row-press-gw-01/opcua-adapter/main Pressure",
      "signal-row-press-gw-01/opcua-adapter/main raw_count",
      "signal-row-press-gw-01/opcua-adapter/main Temp_01",
    ]);
    expect(screen.queryByTestId("signal-row-pack-gw-01/modbus-adapter/main Flow_A")).toBeNull();
  });
});

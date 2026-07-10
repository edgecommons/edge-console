/**
 * The Signals view (R5 — rev-4 mockup): presentational tests (state in, DOM out, callbacks
 * observed) plus App-level integration (nav mounts + subscribes, live frames render grouped
 * rows, the app-bar search filters, the expansion links to Component Detail, and Read is gone)
 * and capability gating (summary subscribe + points backfill vs the full fallback). The
 * grouping / lag / cascade / meter logic itself is covered in `signals-selectors.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { PROTOCOL_VERSION } from "@edgecommons/edge-console-protocol";
import type { ConsoleSettings, ServerMessage, SignalSeriesSnapshot } from "@edgecommons/edge-console-protocol";
import App from "../src/App";
import { SignalsView } from "../src/signals/SignalsView";
import { FleetClient } from "../src/fleet/client";
import type { SocketLike } from "../src/fleet/client";
import {
  T0,
  clientState,
  compSnap,
  consoleSettings,
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

/** A small (≤5) two-device fleet across three signal-path groups — groups load expanded. */
function demoSeries(): SignalSeriesSnapshot[] {
  return [
    signalSeries(PRESS, "filler/tank_level", {
      latest: 63.4,
      quality: "GOOD",
      name: "Filler Tank Level",
      signalId: "ns=3;i=1021",
      adapter: "opcua",
      endpoint: "opc.tcp://192.168.1.180:49320",
      qualityRaw: "Good (0x00000000)",
      address: { ns: 3, nodeId: "ns=3;i=1021" },
      receivedAt: T0 - 2000,
      // OPC-UA-like: the full verbatim pair (+ the folded compat field the wire still sends).
      sourceTs: "2026-07-10T14:32:07.812Z",
      serverTs: "2026-07-10T14:32:07.940Z",
      sourceTimestamp: "2026-07-10T14:32:07.812Z",
      publishedTs: "2026-07-10T14:32:07.992Z", // lag 0.18 s (published − sourceTs)
      points: signalPoints([61, 62, 63.4], { quality: "GOOD", startAt: T0 - 4000 }),
    }),
    signalSeries(PRESS, "filler/head_pressure", {
      latest: 2.06,
      quality: "GOOD",
      name: "Fill Head Pressure",
      receivedAt: T0 - 2000,
      points: signalPoints([2.0, 2.1, 2.06], { quality: "GOOD", startAt: T0 - 4000 }),
    }),
    signalSeries(PACK, "chiller/glycol_temp", {
      latest: -1.8,
      quality: "UNCERTAIN",
      name: "Glycol Supply Temp",
      qualityRaw: "STALE_READ",
      receivedAt: T0 - 14000,
      // Modbus-like: serverTs only (Modbus never has a sourceTs); folded compat field = serverTs.
      serverTs: "2026-07-10T14:32:06.800Z",
      sourceTimestamp: "2026-07-10T14:32:06.800Z",
      publishedTs: "2026-07-10T14:32:15.100Z", // lag 8.3 s (published − serverTs, warn)
      points: signalPoints([-2, -1.9, -1.8], { quality: "UNCERTAIN", startAt: T0 - 16000 }),
    }),
    signalSeries(PACK, "line/valve_open", {
      latest: true, // bool ⇒ no numeric trend
      quality: "GOOD",
      name: "Fill Valve Open",
      receivedAt: T0 - 1000,
      // Legacy-like: no verbatim pair; the folded compat field fell back to the envelope header
      // (== publishedTs) — the WP-F shape that used to fabricate `lag 0`.
      sourceTimestamp: "2026-07-10T14:32:14.000Z",
      publishedTs: "2026-07-10T14:32:14.000Z",
      points: [{ at: T0 - 1000, value: true, quality: "GOOD" }],
    }),
  ];
}

function renderView(overrides: Partial<Parameters<typeof SignalsView>[0]> = {}) {
  const onDeviceScopeChange = vi.fn();
  const onComponentScopeChange = vi.fn();
  const onOpenComponentDetail = vi.fn();
  render(
    <SignalsView
      state={clientState(fleetView([]), { signals: { series: demoSeries() } })}
      now={T0}
      query=""
      onDeviceScopeChange={onDeviceScopeChange}
      onComponentScopeChange={onComponentScopeChange}
      onOpenComponentDetail={onOpenComponentDetail}
      {...overrides}
    />,
  );
  return { onDeviceScopeChange, onComponentScopeChange, onOpenComponentDetail };
}

describe("SignalsView (presentational)", () => {
  it("groups by signal path and renders name-led rows with the mockup columns", () => {
    renderView();
    // Three path groups (chiller/, filler/, line/) — sorted by label.
    const groups = screen.getAllByTestId(/^signal-group-/);
    expect(groups.map((g) => within(g).getByRole("button").textContent)).toEqual(
      expect.arrayContaining(["▾"]),
    );
    expect(screen.getByTestId("signal-group-p:filler")).toBeTruthy();
    expect(screen.getByTestId("signal-group-p:chiller")).toBeTruthy();
    expect(screen.getByTestId("signal-group-p:line")).toBeTruthy();

    // 4 rows across the groups (all expanded — total ≤ 5).
    expect(screen.getAllByTestId(/^signal-row-/)).toHaveLength(4);

    const tank = screen.getByTestId("signal-row-press-gw-01/opcua-adapter/main filler/tank_level");
    expect(within(tank).getByText("Filler Tank Level")).toBeTruthy(); // name-led
    expect(within(tank).getByText(/ns=3;i=1021 · data\/filler\/tank_level/)).toBeTruthy(); // id line
    expect(within(tank).getByText("63.4")).toBeTruthy();
    expect(within(tank).getByTestId("quality-good")).toBeTruthy();
    expect(within(tank).getByTestId("sparkline")).toBeTruthy();
    expect(within(tank).getByTestId("signal-lag-press-gw-01/opcua-adapter/main filler/tank_level").textContent).toBe(
      "lag 0.18 s",
    );

    // A bool signal: no numeric trend (em dash, not a sparkline).
    const valve = screen.getByTestId("signal-row-pack-gw-01/modbus-adapter/main line/valve_open");
    expect(within(valve).queryByTestId("sparkline")).toBeNull();
    expect(within(valve).getByText("true")).toBeTruthy();
  });

  it("renders the over-5s lag warning-toned (Modbus-like: computed from serverTs)", () => {
    renderView();
    const table = within(screen.getByTestId("signals-table"));
    const lag = table.getByTestId("signal-lag-pack-gw-01/modbus-adapter/main chiller/glycol_temp");
    expect(lag.textContent).toBe("lag 8.3 s");
    expect(lag.className).toMatch(/ec-lag--warn/);
  });

  it("a legacy publisher (no verbatim pair) shows 'lag —' even though the folded compat field is present", () => {
    renderView();
    const table = within(screen.getByTestId("signals-table"));
    const lag = table.getByTestId("signal-lag-pack-gw-01/modbus-adapter/main line/valve_open");
    expect(lag.textContent).toBe("lag —"); // never a fabricated lag 0
    expect(lag.className).not.toMatch(/ec-lag--warn/);
  });

  it("has NO Read action anywhere on the screen", () => {
    renderView();
    expect(screen.queryByRole("button", { name: "Read" })).toBeNull();
    expect(screen.queryByTestId(/signal-read-/)).toBeNull();
  });

  it("flags units / limits as pending (not on the data body)", () => {
    renderView();
    expect(screen.getByTestId("signals-pending-note").textContent).toMatch(/units.*limits pending/i);
  });

  it("shows the quality triage strip and filters on click", () => {
    renderView();
    expect(screen.getByTestId("triage-all").textContent).toContain("4");
    expect(screen.getByTestId("triage-good").textContent).toContain("3");
    expect(screen.getByTestId("triage-uncertain").textContent).toContain("1");

    fireEvent.click(screen.getByTestId("triage-uncertain"));
    const rows = screen.getAllByTestId(/^signal-row-/);
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText("Glycol Supply Temp")).toBeTruthy();
  });

  it("shows the device dropdown on a multi-device fleet and hides it on a single-device one", () => {
    const { rerender } = render(
      <SignalsView
        state={clientState(fleetView([]), { signals: { series: demoSeries() } })}
        now={T0}
        query=""
        onDeviceScopeChange={vi.fn()}
        onComponentScopeChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("signals-device")).toBeTruthy();

    rerender(
      <SignalsView
        state={clientState(fleetView([]), {
          signals: { series: [signalSeries(PRESS, "filler/only", { latest: 1 })] },
        })}
        now={T0}
        query=""
        onDeviceScopeChange={vi.fn()}
        onComponentScopeChange={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("signals-device")).toBeNull();
  });

  it("collapses a group's rows and re-expands them via the header toggle", () => {
    renderView();
    // filler/ has 2 rows visible initially.
    expect(screen.getByTestId("signal-row-press-gw-01/opcua-adapter/main filler/tank_level")).toBeTruthy();
    fireEvent.click(screen.getByTestId("group-toggle-p:filler"));
    expect(screen.queryByTestId("signal-row-press-gw-01/opcua-adapter/main filler/tank_level")).toBeNull();
    // The collapsed header still shows the count rollup.
    expect(within(screen.getByTestId("signals-table")).getByTestId("group-count-p:filler").textContent).toContain("2");
    fireEvent.click(screen.getByTestId("group-toggle-p:filler"));
    expect(screen.getByTestId("signal-row-press-gw-01/opcua-adapter/main filler/tank_level")).toBeTruthy();
  });

  it("expands a row to its detail panel (identity, address, the four labeled timestamps + lag) and links to Component Detail", () => {
    const { onOpenComponentDetail } = renderView();
    const rowId = "press-gw-01/opcua-adapter/main filler/tank_level";
    fireEvent.click(screen.getByTestId(`signal-expand-${rowId}`));
    const detail = screen.getByTestId(`signal-detail-${rowId}`);
    expect(within(detail).getByText("data/filler/tank_level")).toBeTruthy();
    expect(within(detail).getByTestId(`signal-address-${rowId}`).textContent).toContain("nodeId");
    // The rev-4 timestamp block: Source ts (measured, verbatim) / Server ts (server refresh,
    // verbatim) / Published (adapter → bus) / Lag — plus the approved Received (console) row.
    expect(within(detail).getByTestId(`signal-source-ts-${rowId}`).textContent).toContain("2026-07-10T14:32:07.812Z");
    expect(within(detail).getByTestId(`signal-server-ts-${rowId}`).textContent).toContain("2026-07-10T14:32:07.940Z");
    expect(within(detail).getByText("2026-07-10T14:32:07.992Z")).toBeTruthy(); // published
    expect(within(detail).getByText("console")).toBeTruthy(); // the retained Received row
    expect(within(detail).getByTestId(`signal-detail-lag-${rowId}`).textContent).toContain("0.18 s");

    fireEvent.click(within(detail).getByTestId(`signal-open-detail-${rowId}`));
    expect(onOpenComponentDetail).toHaveBeenCalledWith(PRESS);
  });

  it("the expansion renders em dashes for an absent Source ts (Modbus-like) and both (legacy)", () => {
    renderView();
    // Modbus-like: Source ts —, Server ts present.
    const glycolId = "pack-gw-01/modbus-adapter/main chiller/glycol_temp";
    fireEvent.click(screen.getByTestId(`signal-expand-${glycolId}`));
    const glycol = screen.getByTestId(`signal-detail-${glycolId}`);
    expect(within(glycol).getByTestId(`signal-source-ts-${glycolId}`).textContent).toContain("—");
    expect(within(glycol).getByTestId(`signal-server-ts-${glycolId}`).textContent).toContain("2026-07-10T14:32:06.800Z");
    expect(within(glycol).getByTestId(`signal-detail-lag-${glycolId}`).textContent).toContain("8.3 s");

    // Legacy: both verbatim timestamps —, lag —.
    const valveId = "pack-gw-01/modbus-adapter/main line/valve_open";
    fireEvent.click(screen.getByTestId(`signal-expand-${valveId}`));
    const valve = screen.getByTestId(`signal-detail-${valveId}`);
    expect(within(valve).getByTestId(`signal-source-ts-${valveId}`).textContent).toContain("—");
    expect(within(valve).getByTestId(`signal-server-ts-${valveId}`).textContent).toContain("—");
    expect(within(valve).getByTestId(`signal-detail-lag-${valveId}`).textContent).toContain("—");
  });

  it("renders the per-group msg/s rollup when a meter is wired", () => {
    renderView({ rateFor: () => 48.2 });
    expect(within(screen.getByTestId("signals-table")).getByTestId("group-rate-p:filler").textContent).toBe(
      "48.2 msg/s",
    );
  });

  it("renders the connecting empty state with no signals", () => {
    render(
      <SignalsView
        state={clientState(fleetView([]), { signals: { series: [] }, status: "connecting" })}
        now={T0}
        query=""
        onDeviceScopeChange={vi.fn()}
        onComponentScopeChange={vi.fn()}
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
        onDeviceScopeChange={vi.fn()}
        onComponentScopeChange={vi.fn()}
      />,
    );
    expect(screen.getByText("Gateway connection lost — reconnecting")).toBeTruthy();
    expect(screen.getAllByTestId(/^signal-row-/)).toHaveLength(4);
  });
});

describe("SignalsView — collapse-default + paging at scale", () => {
  function bigGroup(n: number): SignalSeriesSnapshot[] {
    return Array.from({ length: n }, (_, i) =>
      signalSeries(PRESS, `filler/s${String(i).padStart(3, "0")}`, {
        latest: i,
        quality: "GOOD",
        points: signalPoints([i], { quality: "GOOD" }),
      }),
    );
  }

  it("loads groups collapsed past 5 signals, then pages the expanded rows (first 50, +200)", () => {
    render(
      <SignalsView
        state={clientState(fleetView([]), { signals: { series: bigGroup(52) } })}
        now={T0}
        query=""
        onDeviceScopeChange={vi.fn()}
        onComponentScopeChange={vi.fn()}
      />,
    );
    // Collapsed by default (52 > 5) — no rows, header shows the count.
    expect(screen.queryAllByTestId(/^signal-row-/)).toHaveLength(0);
    expect(within(screen.getByTestId("signals-table")).getByTestId("group-count-p:filler").textContent).toContain(
      "52",
    );

    // Expand → first 50 rows + a "Show 2 more" row.
    fireEvent.click(screen.getByTestId("group-toggle-p:filler"));
    expect(screen.getAllByTestId(/^signal-row-/)).toHaveLength(50);
    const more = screen.getByTestId("signal-more-p:filler");
    expect(more.textContent).toContain("Show 2 more");

    fireEvent.click(within(more).getByRole("button"));
    expect(screen.getAllByTestId(/^signal-row-/)).toHaveLength(52);
  });

  it("a search auto-expands the matching groups", () => {
    const { rerender } = render(
      <SignalsView
        state={clientState(fleetView([]), { signals: { series: bigGroup(52) } })}
        now={T0}
        query=""
        onDeviceScopeChange={vi.fn()}
        onComponentScopeChange={vi.fn()}
      />,
    );
    expect(screen.queryAllByTestId(/^signal-row-/)).toHaveLength(0); // collapsed
    rerender(
      <SignalsView
        state={clientState(fleetView([]), { signals: { series: bigGroup(52) } })}
        now={T0}
        query="filler/s001"
        onDeviceScopeChange={vi.fn()}
        onComponentScopeChange={vi.fn()}
      />,
    );
    // The matching group is force-expanded; only the matching row shows.
    const rows = screen.getAllByTestId(/^signal-row-/);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute("data-testid")).toBe("signal-row-press-gw-01/opcua-adapter/main filler/s001");
  });
});

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
  it("subscribes on nav, renders grouped rows, search filters, no sb.read, and unsubscribes on leave", () => {
    const { sockets, frames } = appRig();
    act(() => sockets[0]!.onopen?.());

    fireEvent.click(screen.getByRole("link", { name: /Signals/ }));
    expect(frames().some((f) => f.type === "subscribe-signals")).toBe(true);
    // No capability advertised ⇒ a full subscribe (no `mode`).
    expect(frames().filter((f) => f.type === "subscribe-signals").every((f) => f.mode === undefined)).toBe(true);

    act(() => {
      const msg: ServerMessage = { type: "signals", protocolVersion: PROTOCOL_VERSION, series: demoSeries() };
      sockets[0]!.onmessage?.(JSON.stringify(msg));
    });
    expect(screen.getAllByTestId(/^signal-row-/)).toHaveLength(4);

    fireEvent.change(screen.getByTestId("appbar-search"), { target: { value: "glycol" } });
    expect(screen.getAllByTestId(/^signal-row-/)).toHaveLength(1);
    fireEvent.change(screen.getByTestId("appbar-search"), { target: { value: "" } });

    // No command surface on this screen at all.
    expect(screen.queryByRole("button", { name: "Read" })).toBeNull();

    fireEvent.click(screen.getByRole("link", { name: /Overview/ }));
    expect(frames().at(-1)).toMatchObject({ type: "unsubscribe-signals" });
    // Never issued a southbound read command.
    expect(frames().some((f) => f.type === "invoke-command" && f.verb === "sb.read")).toBe(false);
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
      const sig: ServerMessage = { type: "signals", protocolVersion: PROTOCOL_VERSION, series: demoSeries() };
      sockets[0]!.onmessage?.(JSON.stringify(sig));
    });

    fireEvent.click(screen.getByRole("link", { name: /Components/ }));
    fireEvent.click(screen.getByTestId("tree-node-press-gw-01/opcua-adapter"));
    fireEvent.click(screen.getByTestId("detail-open-signals"));

    // Scoped to press-gw-01/opcua-adapter: only its two filler signals, not pack-gw-01's rows.
    const rows = screen.getAllByTestId(/^signal-row-/);
    expect(rows.map((r) => r.getAttribute("data-testid"))).toEqual([
      "signal-row-press-gw-01/opcua-adapter/main filler/head_pressure",
      "signal-row-press-gw-01/opcua-adapter/main filler/tank_level",
    ]);
    expect(screen.queryByTestId("signal-row-pack-gw-01/modbus-adapter/main chiller/glycol_temp")).toBeNull();
  });

  it("uses summary mode + backfills points on expand when the gateway advertises the capability", () => {
    const { sockets, frames } = appRig();
    const settings: ConsoleSettings = consoleSettings({ capabilities: { signalsSummary: true } });
    act(() => {
      sockets[0]!.onopen?.();
      sockets[0]!.onmessage?.(
        JSON.stringify({ type: "settings", protocolVersion: PROTOCOL_VERSION, settings } satisfies ServerMessage),
      );
    });

    fireEvent.click(screen.getByRole("link", { name: /Signals/ }));
    // Capability present ⇒ a summary subscribe is issued.
    expect(frames().some((f) => f.type === "subscribe-signals" && f.mode === "summary")).toBe(true);

    // A summary snapshot omits `points`; a small (≤5) fleet loads expanded, so the visible rows
    // trigger a points backfill.
    act(() => {
      const summary = demoSeries().map((s) => {
        const { points: _points, ...rest } = s;
        return rest;
      });
      sockets[0]!.onmessage?.(
        JSON.stringify({ type: "signals", protocolVersion: PROTOCOL_VERSION, series: summary } satisfies ServerMessage),
      );
    });
    expect(frames().some((f) => f.type === "get-signal-points")).toBe(true);
  });
});

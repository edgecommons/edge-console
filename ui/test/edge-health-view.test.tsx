import { describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach } from "vitest";
import { EdgeHealthView } from "../src/health/EdgeHealthView";
import { StatusTag, RollupTag } from "../src/health/StatusTag";
import { T0, clientState, commandEntry, commandView, compView, deviceView, fleetView, key } from "./_fixtures";

afterEach(cleanup);

/** Client-clock "now" for renders (offset 0 in fixtures ⇒ server time == client time). */
const NOW = T0 + 10_000;

describe("EdgeHealthView - the live fleet", () => {
  const view = fleetView([
    deviceView("pack-gw-01", [
      compView({ key: key("pack-gw-01", "opcua-adapter"), liveness: "STALE", lastStateAt: T0 - 33_000 }),
      compView({ key: key("pack-gw-01", "modbus-adapter"), liveness: "OFFLINE", lastStateAt: undefined, uptimeSecs: undefined }),
    ]),
    deviceView("press-gw-01", [
      compView({ key: key("press-gw-01", "opcua-adapter") }),
      compView({ key: key("press-gw-01", "telemetry-processor"), liveness: "WARN", cadenceSource: "cfg", expectedIntervalSecs: 10 }),
      compView({ key: key("press-gw-01", "stopper"), liveness: "STOPPED", status: "STOPPED" }),
      compView({ key: key("press-gw-01", "opcua-adapter", "kep1") }),
    ]),
  ]);

  it("renders summary-before-detail: header, tiles, then the grouped fleet table", () => {
    render(<EdgeHealthView state={clientState(view)} now={NOW} />);
    expect(screen.getByRole("heading", { name: "Edge health" })).toBeTruthy();
    expect(screen.getByText("6 components across 2 devices")).toBeTruthy();
    expect(screen.getByTestId("ws-status").textContent).toContain("WS Live");

    // Tiles: 2 healthy of 6; attention = STALE + OFFLINE + WARN = 3.
    expect(screen.getByTestId("healthy-count").textContent).toBe("2/6 healthy");
    expect(screen.getByTestId("attention-count").textContent).toBe("3");
    expect(screen.getByTestId("device-count").textContent).toBe("2");
    expect(screen.getByTestId("stream-status").textContent).toBe("Live");

    // The fleet table, grouped by device, with the Carbon status treatment.
    expect(screen.getByTestId("device-group-pack-gw-01")).toBeTruthy();
    expect(screen.getByTestId("device-group-press-gw-01")).toBeTruthy();
    const staleRow = screen.getByTestId("component-row-pack-gw-01/opcua-adapter/main");
    expect(within(staleRow).getByText("Stale")).toBeTruthy();
    expect(within(staleRow).getByText("43s ago")).toBeTruthy(); // NOW - lastStateAt
    const offlineRow = screen.getByTestId("component-row-pack-gw-01/modbus-adapter/main");
    expect(within(offlineRow).getByText("Offline")).toBeTruthy();
    expect(within(offlineRow).getByText("never")).toBeTruthy();
    const warnRow = screen.getByTestId("component-row-press-gw-01/telemetry-processor/main");
    expect(within(warnRow).getByText("Warning")).toBeTruthy();
    expect(within(warnRow).getByText("10s")).toBeTruthy(); // cfg-derived cadence
    expect(within(warnRow).getByText("· cfg")).toBeTruthy();
    const stoppedRow = screen.getByTestId("component-row-press-gw-01/stopper/main");
    expect(within(stoppedRow).getByText("Stopped")).toBeTruthy();
    const instanceRow = screen.getByTestId("component-row-press-gw-01/opcua-adapter/kep1");
    expect(within(instanceRow).getByText("kep1")).toBeTruthy(); // non-main instance chip
  });

  it("raises the issue notes: offline as error, stale as warning", () => {
    render(<EdgeHealthView state={clientState(view)} now={NOW} />);
    const strip = screen.getByTestId("issue-notifications");
    expect(within(strip).getByText("modbus-adapter — offline")).toBeTruthy();
    expect(within(strip).getByText("opcua-adapter — state keepalive stale")).toBeTruthy();
    expect(within(strip).queryByText(/telemetry-processor/)).toBeNull(); // WARN is shading, not an alarm
  });

  it("collapses and expands a device group with a keyboard-focusable button", () => {
    render(<EdgeHealthView state={clientState(view)} now={NOW} />);
    const toggle = screen.getByRole("button", { name: "Collapse device pack-gw-01" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.queryByTestId("component-row-pack-gw-01/opcua-adapter/main")).toBeNull();
    const reopened = screen.getByRole("button", { name: "Expand device pack-gw-01" });
    fireEvent.click(reopened);
    expect(screen.getByTestId("component-row-pack-gw-01/opcua-adapter/main")).toBeTruthy();
  });

  it("extrapolates uptime for live components and freezes it for stale ones", () => {
    const uptimeView = fleetView([
      deviceView("gw-01", [
        compView({ key: key("gw-01", "alive"), uptimeSecs: 100, uptimeAnchorAt: T0 }),
        compView({ key: key("gw-01", "stale"), liveness: "STALE", uptimeSecs: 100, uptimeAnchorAt: T0 }),
      ]),
    ]);
    render(<EdgeHealthView state={clientState(uptimeView)} now={T0 + 30_000} />);
    const alive = screen.getByTestId("component-row-gw-01/alive/main");
    expect(within(alive).getByText("2m 10s")).toBeTruthy(); // 100s + 30s elapsed
    const stale = screen.getByTestId("component-row-gw-01/stale/main");
    expect(within(stale).getByText("1m 40s")).toBeTruthy(); // frozen at the last report
  });
});

describe("EdgeHealthView - whole-device unreachability", () => {
  const view = fleetView([
    deviceView(
      "asm-gw-01",
      [
        compView({ key: key("asm-gw-01", "a"), liveness: "UNREACHABLE" }),
        compView({ key: key("asm-gw-01", "b"), liveness: "UNREACHABLE" }),
      ],
      { unreachable: true, unreachableSince: T0 - 110_000 },
    ),
  ]);

  it("shows the containment note and freezes the device subtree", () => {
    render(<EdgeHealthView state={clientState(view)} now={NOW} />);
    expect(screen.getByText("asm-gw-01 — device unreachable for 2m 00s")).toBeTruthy();
    expect(screen.getByText(/2 components frozen at last-known values/)).toBeTruthy();
    const group = screen.getByTestId("device-group-asm-gw-01");
    expect(within(group).getByText("Unreachable")).toBeTruthy();
    expect(within(group).getByText(/bridge offline 2m 00s/)).toBeTruthy();
    // Both component rows carry the UNREACHABLE treatment.
    expect(screen.getAllByText("Unreachable")).toHaveLength(3); // group tag + 2 rows
  });

  it("caps the issue strip and reports the rest as +N more", () => {
    const noisy = fleetView([
      deviceView(
        "gw-01",
        Array.from({ length: 6 }, (_, i) =>
          compView({ key: key("gw-01", `dead-${i}`), liveness: "OFFLINE" }),
        ),
      ),
    ]);
    render(<EdgeHealthView state={clientState(noisy)} now={NOW} />);
    const strip = screen.getByTestId("issue-notifications");
    expect(within(strip).getAllByText(/— offline/)).toHaveLength(4);
    expect(within(strip).getByText(/\+2 more issues/)).toBeTruthy();
  });
});

describe("EdgeHealthView - empty, connecting and degraded-connection states", () => {
  it("shows a connecting state before the first snapshot", () => {
    const state = clientState(fleetView([], { lastUpdatedAt: undefined }), {
      status: "connecting",
      hasSnapshot: false,
    });
    render(<EdgeHealthView state={state} now={NOW} />);
    expect(screen.getByTestId("empty-state")).toBeTruthy();
    expect(screen.getByText("Connecting to the console gateway…")).toBeTruthy();
  });

  it("shows the not-connected state when disconnected without data", () => {
    const state = clientState(fleetView([], { lastUpdatedAt: undefined }), {
      status: "disconnected",
      hasSnapshot: false,
    });
    render(<EdgeHealthView state={state} now={NOW} />);
    expect(screen.getByText("Not connected")).toBeTruthy();
  });

  it("shows the empty-fleet guidance when connected with zero devices", () => {
    render(<EdgeHealthView state={clientState(fleetView([]))} now={NOW} />);
    expect(screen.getByTestId("empty-fleet")).toBeTruthy();
    expect(screen.getByText("No components discovered yet")).toBeTruthy();
  });

  it("keeps last-known data visible under a reconnect banner", () => {
    const view = fleetView([deviceView("gw-01", [compView()])]);
    render(<EdgeHealthView state={clientState(view, { status: "reconnecting" })} now={NOW} />);
    expect(screen.getByText("Gateway connection lost — reconnecting")).toBeTruthy();
    expect(screen.getByTestId("component-row-gw-01/comp-a/main")).toBeTruthy();
    expect(screen.getByTestId("ws-status").textContent).toContain("WS Reconnecting");
  });

  it("surfaces a protocol version skew as a fatal, reload-me error", () => {
    const state = clientState(fleetView([], { lastUpdatedAt: undefined }), {
      status: "disconnected",
      hasSnapshot: false,
      fatalError: "gateway is protocol v2, client sent v1",
    });
    render(<EdgeHealthView state={state} now={NOW} />);
    expect(screen.getByText("Protocol version mismatch")).toBeTruthy();
    expect(screen.getByText(/reload the page/)).toBeTruthy();
  });
});

describe("EdgeHealthView - C4 command controls", () => {
  const CID = "gw-01/opcua-adapter/main";
  const view = fleetView([deviceView("gw-01", [compView({ key: key("gw-01", "opcua-adapter") })])]);

  it("reveals the per-component controls on expand and fires a command", () => {
    const onInvoke = vi.fn();
    render(<EdgeHealthView state={clientState(view)} now={NOW} onInvoke={onInvoke} />);

    // Controls are hidden until the row is expanded (the table stays compact).
    expect(screen.queryByTestId(`cmd-controls-${CID}`)).toBeNull();
    fireEvent.click(screen.getByTestId(`controls-toggle-${CID}`));
    expect(screen.getByTestId(`cmd-controls-${CID}`)).toBeTruthy();

    fireEvent.click(screen.getByTestId(`cmd-btn-ping-${CID}`));
    expect(onInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ device: "gw-01", component: "opcua-adapter" }),
      "ping",
    );
  });

  it("surfaces a settled command outcome as a toast", () => {
    const state = clientState(view, {
      commands: commandView([]),
    });
    const { rerender } = render(<EdgeHealthView state={state} now={NOW} />);
    // A ping settles ⇒ a success toast appears (mirrors the inline row result).
    rerender(
      <EdgeHealthView
        state={clientState(view, {
          commands: commandView([commandEntry({ requestId: "r1", verb: "ping", phase: "ok" })]),
        })}
        now={NOW}
      />,
    );
    expect(screen.getByTestId("cmd-toast-r1")).toBeTruthy();
  });
});

describe("status tag building blocks", () => {
  it("maps every liveness to its Carbon treatment", () => {
    render(
      <>
        <StatusTag liveness="FRESH" />
        <StatusTag liveness="WARN" />
        <StatusTag liveness="STALE" />
        <StatusTag liveness="OFFLINE" />
        <StatusTag liveness="STOPPED" />
        <StatusTag liveness="UNREACHABLE" />
      </>,
    );
    for (const label of ["Healthy", "Warning", "Stale", "Offline", "Stopped", "Unreachable"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("Warning").closest(".ec-tag--warn")).toBeTruthy();
    expect(screen.getByText("Stale").closest(".ec-tag--stale")).toBeTruthy();
    expect(screen.getByText("Unreachable").closest(".ec-tag--unreach")).toBeTruthy();
  });

  it("maps every rollup level", () => {
    render(
      <>
        <RollupTag level="healthy" />
        <RollupTag level="degraded" />
        <RollupTag level="critical" />
        <RollupTag level="stopped" />
        <RollupTag level="empty" />
      </>,
    );
    for (const label of ["Healthy", "Degraded", "Critical", "Stopped", "No components"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });
});

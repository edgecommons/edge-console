/**
 * The Component Detail screen (R2) — presentational tests: the breadcrumb, the tab set, the
 * real Health / Instances / Configuration / Events tabs (built from live data), and the HONEST
 * Phase-2 pending states (Panel + opcua sub-tabs, Logs, language/version) that depend on the
 * deferred describe/panels manifest. State in, DOM out, callbacks observed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ConfigEntryView } from "../src/fleet/config-store";
import { ComponentDetailView } from "../src/components/ComponentDetailView";
import {
  T0,
  alarmSnapshot,
  attributesView,
  clientState,
  compView,
  consoleAlarm,
  consoleEvent,
  deviceView,
  fleetView,
  hier,
  key,
  runtimeAttrs,
} from "./_fixtures";

afterEach(cleanup);

const DKEY = key("pack-gw-01", "opcua-adapter");
const ID = "pack-gw-01/opcua-adapter";

function loadedConfig(): ConfigEntryView {
  return {
    key: DKEY,
    id: ID,
    phase: "loaded",
    body: { config: { heartbeat: { intervalSecs: 5 }, endpoint: { url: "opc.tcp://x:49320" } } },
    receivedAt: T0 - 3000,
    refreshing: false,
  };
}

function detailState(overrides = {}) {
  return clientState(
    fleetView([
      deviceView("pack-gw-01", [
        compView({
          key: DKEY,
          hier: hier(["site", "dallas"], ["line", "packaging"], ["device", "pack-gw-01"]),
          liveness: "STALE",
          lastStateAt: T0 - 43_000,
          expectedIntervalSecs: 5,
        }),
      ]),
    ]),
    {
      attributes: attributesView([
        runtimeAttrs(DKEY, {
          cpuPercent: 22,
          memoryMb: 210,
          diskTotalGb: 100,
          diskUsedGb: 42,
          diskFreeGb: 58,
          threads: 24,
          openFiles: 14,
          fds: 96,
          connectionState: "CONNECTED",
          platform: "HOST",
          cpuSeries: [18, 20, 22, 21, 24],
        }),
      ]),
      alarms: alarmSnapshot([consoleAlarm({ key: DKEY, type: "connection-lost" })]),
      events: {
        entries: [
          consoleEvent({ id: 2, key: DKEY, severity: "info", type: "scan-cycle-complete", channel: "info/scan-cycle-complete" }),
          consoleEvent({ id: 1, key: key("pack-gw-01", "modbus-adapter"), type: "slave-retry" }),
        ],
      },
      configs: { entriesById: { [ID]: loadedConfig() } },
      ...overrides,
    },
  );
}

function renderDetail(props = {}) {
  const cbs = {
    onBack: vi.fn(),
    onOpenOverview: vi.fn(),
    onViewConfig: vi.fn(),
    onOpenEvents: vi.fn(),
  };
  render(<ComponentDetailView state={detailState()} now={T0} detailKey={DKEY} {...cbs} {...props} />);
  return cbs;
}

describe("ComponentDetailView — breadcrumb + header", () => {
  it("renders the breadcrumb 'Overview / Components / {hier path} / {component}' with working links", () => {
    const cbs = renderDetail();
    const crumbs = screen.getByTestId("detail-crumbs");
    expect(within(crumbs).getByText("packaging")).toBeTruthy();
    expect(within(crumbs).getByText("pack-gw-01")).toBeTruthy();
    expect(within(crumbs).getByText("opcua-adapter")).toBeTruthy(); // the bold leaf

    fireEvent.click(screen.getByTestId("crumb-overview"));
    expect(cbs.onOpenOverview).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("crumb-components"));
    expect(cbs.onBack).toHaveBeenCalled();
  });

  it("flags language + version as Phase-2 pending in the subtitle (no fabricated 'java · v1.4.2')", () => {
    renderDetail();
    expect(screen.getByText(/language · version pending/i)).toBeTruthy();
    // The mockup's fabricated implementation language / app version are NOT shown.
    expect(screen.queryByText(/v1\.4\.2/)).toBeNull();
  });

  it("routes the header 'View config' to the full Configuration screen", () => {
    const cbs = renderDetail();
    fireEvent.click(screen.getByTestId("detail-view-config"));
    expect(cbs.onViewConfig).toHaveBeenCalled();
  });
});

describe("ComponentDetailView — the real (data-backed) tabs", () => {
  it("Health: renders the runtime-attribute tiles + console health checks from live data", () => {
    renderDetail();
    const tiles = screen.getByTestId("health-tiles");
    expect(within(tiles).getByText("22%")).toBeTruthy();
    expect(within(tiles).getByText("210", { exact: false })).toBeTruthy();
    expect(within(tiles).getByText("42 / 100", { exact: false })).toBeTruthy();
    expect(within(tiles).getByText("58 GB free")).toBeTruthy();
    expect(within(tiles).getByText("24 / 14 / 96")).toBeTruthy();

    const checks = screen.getByTestId("health-checks");
    expect(within(checks).getByText("CONNECTED")).toBeTruthy();
    expect(within(checks).getByText("stale")).toBeTruthy(); // freshness from liveness
    expect(screen.getByTestId("liveness-state")).toBeTruthy();
  });

  it("Instances: a single-instance (main-only) component shows the no-per-instance-connectivity note", () => {
    renderDetail();
    fireEvent.click(screen.getByTestId("tab-instances"));
    expect(screen.getByTestId("instances-empty")).toBeTruthy();
  });

  it("Instances: renders state.instances[] connectivity (connected/disconnected + detail)", () => {
    const state = clientState(
      fleetView([
        deviceView("pack-gw-01", [
          compView({
            key: DKEY,
            instances: [
              { instance: "filler1", connected: true, detail: "opc.tcp://kep:49320" },
              { instance: "kep2", connected: false },
            ],
          }),
        ]),
      ]),
    );
    renderDetail({ state });
    fireEvent.click(screen.getByTestId("tab-instances"));
    const list = screen.getByTestId("instances-list");
    expect(within(list).getByTestId("instance-filler1")).toBeTruthy();
    expect(within(list).getByTestId("instance-kep2")).toBeTruthy();
    expect(within(list).getByText("connected")).toBeTruthy();
    expect(within(list).getByText("disconnected")).toBeTruthy();
    expect(within(list).getByText("opc.tcp://kep:49320")).toBeTruthy();
  });

  it("Configuration: embeds a read-only effective-config view + a link to the full screen", () => {
    const cbs = renderDetail();
    fireEvent.click(screen.getByTestId("tab-config"));
    expect(screen.getByTestId("config-embed-rows")).toBeTruthy();
    expect(screen.getByText("endpoint.url")).toBeTruthy();
    fireEvent.click(screen.getByTestId("view-full-config"));
    expect(cbs.onViewConfig).toHaveBeenCalled();
  });

  it("Events: shows only THIS component's events + a link to Events & Alarms", () => {
    const cbs = renderDetail();
    fireEvent.click(screen.getByTestId("tab-events"));
    const list = screen.getByTestId("events-embed-list");
    // id 2 is this component's; id 1 (modbus) must be filtered out.
    expect(within(list).getByTestId("events-embed-row-2")).toBeTruthy();
    expect(within(list).queryByTestId("events-embed-row-1")).toBeNull();
    fireEvent.click(screen.getByTestId("view-full-events"));
    expect(cbs.onOpenEvents).toHaveBeenCalled();
  });
});

describe("ComponentDetailView — honest Phase-2 pending surfaces", () => {
  it("Panel: renders a pending state + the inert opcua sub-tabs (Overview/Address Space/Signals/Diagnostics)", () => {
    renderDetail();
    fireEvent.click(screen.getByTestId("tab-panel"));
    const pending = screen.getByTestId("phase2-panel");
    expect(within(pending).getByText(/Available in Phase 2/i)).toBeTruthy();
    const subtabs = screen.getByTestId("panel-subtabs");
    expect(within(subtabs).getByText("Address Space")).toBeTruthy();
    expect(within(subtabs).getByText("Diagnostics")).toBeTruthy();
    expect(subtabs.getAttribute("aria-disabled")).toBe("true");
  });

  it("Logs: renders a pending state (no log-class surface ships yet)", () => {
    renderDetail();
    fireEvent.click(screen.getByTestId("tab-logs"));
    expect(within(screen.getByTestId("phase2-logs")).getByText(/Available in Phase 2/i)).toBeTruthy();
  });
});

describe("ComponentDetailView — edge cases", () => {
  it("shows a not-found state when the component left the fleet (breadcrumb still renders)", () => {
    render(
      <ComponentDetailView
        state={clientState(fleetView([]))}
        now={T0}
        detailKey={DKEY}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByTestId("detail-not-found")).toBeTruthy();
    expect(screen.getByTestId("detail-crumbs")).toBeTruthy();
  });

  it("Configuration tab shows the honest unavailable state when no cfg was received", () => {
    render(
      <ComponentDetailView
        state={detailState({ configs: { entriesById: { [ID]: { ...loadedConfig(), phase: "unavailable", body: undefined } } } })}
        now={T0}
        detailKey={DKEY}
      />,
    );
    fireEvent.click(screen.getByTestId("tab-config"));
    expect(screen.getByTestId("config-embed-unavailable")).toBeTruthy();
  });
});

/**
 * The Components screen (R2) — presentational tests: the dynamic tree, the roster (group
 * selected), the inline component detail (leaf selected), and the app-bar search
 * filtering the tree. State in, DOM out, callbacks observed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ComponentsView } from "../src/components/ComponentsView";
import {
  T0,
  alarmSnapshot,
  attributesView,
  clientState,
  compView,
  consoleAlarm,
  deviceView,
  fleetView,
  hier,
  key,
  runtimeAttrs,
} from "./_fixtures";

afterEach(cleanup);

/** A dallas site: packaging line with two devices' worth of components. */
function siteFleet() {
  return fleetView([
    deviceView("pack-gw-01", [
      compView({
        key: key("pack-gw-01", "opcua-adapter"),
        hier: hier(["site", "dallas"], ["line", "packaging"], ["device", "pack-gw-01"]),
        liveness: "STALE",
      }),
      compView({
        key: key("pack-gw-01", "modbus-adapter"),
        hier: hier(["site", "dallas"], ["line", "packaging"], ["device", "pack-gw-01"]),
        liveness: "OFFLINE",
      }),
    ]),
    deviceView("press-gw-01", [
      compView({
        key: key("press-gw-01", "opcua-adapter"),
        hier: hier(["site", "dallas"], ["line", "stamping"], ["device", "press-gw-01"]),
        liveness: "FRESH",
      }),
    ]),
  ]);
}

function stateWith(overrides = {}) {
  return clientState(siteFleet(), {
    attributes: attributesView([
      runtimeAttrs(key("pack-gw-01", "opcua-adapter"), {
        cpuPercent: 22,
        memoryMb: 210,
        platform: "HOST",
        cpuSeries: [18, 20, 22, 21, 24],
      }),
    ]),
    alarms: alarmSnapshot([
      consoleAlarm({ key: key("pack-gw-01", "opcua-adapter"), type: "connection-lost" }),
    ]),
    ...overrides,
  });
}

describe("ComponentsView", () => {
  it("renders the DYNAMIC hierarchy tree (site → line → device → component)", () => {
    render(<ComponentsView state={stateWith()} now={T0} />);
    const tree = screen.getByTestId("component-tree");
    // Site root + two dynamic line groups + devices + component leaves — none hardcoded.
    expect(screen.getByTestId("tree-node-site=dallas")).toBeTruthy();
    expect(screen.getByTestId("tree-node-site=dallas/line=packaging")).toBeTruthy();
    expect(screen.getByTestId("tree-node-site=dallas/line=stamping")).toBeTruthy();
    expect(screen.getByTestId("tree-node-site=dallas/line=packaging/device=pack-gw-01")).toBeTruthy();
    expect(within(tree).getByTestId("tree-node-pack-gw-01/opcua-adapter")).toBeTruthy();
  });

  it("rosters everything beneath the default (site) selection — the tree doubles as inventory", () => {
    render(<ComponentsView state={stateWith()} now={T0} />);
    const roster = screen.getByTestId("components-roster");
    for (const column of ["Health", "Component", "Device", "Heartbeat", "Action"]) {
      expect(within(roster).getByText(column)).toBeTruthy();
    }
    // All three components are listed beneath the site.
    expect(within(roster).getByTestId("roster-row-pack-gw-01/opcua-adapter")).toBeTruthy();
    expect(within(roster).getByTestId("roster-row-pack-gw-01/modbus-adapter")).toBeTruthy();
    expect(within(roster).getByTestId("roster-row-press-gw-01/opcua-adapter")).toBeTruthy();
  });

  it("scopes the roster to a selected device node", () => {
    render(<ComponentsView state={stateWith()} now={T0} />);
    fireEvent.click(screen.getByTestId("tree-node-site=dallas/line=packaging/device=pack-gw-01"));
    const roster = screen.getByTestId("components-roster");
    expect(within(roster).getByTestId("roster-row-pack-gw-01/opcua-adapter")).toBeTruthy();
    // press-gw-01's component is NOT under pack-gw-01.
    expect(within(roster).queryByTestId("roster-row-press-gw-01/opcua-adapter")).toBeNull();
  });

  it("shows the inline component detail when a leaf is selected", () => {
    render(<ComponentsView state={stateWith()} now={T0} />);
    fireEvent.click(screen.getByTestId("tree-node-pack-gw-01/opcua-adapter"));

    expect(screen.getByTestId("tab-health")).toBeTruthy();
    expect(screen.getByTestId("tab-config")).toBeTruthy();
    const tiles = screen.getByTestId("health-tiles");
    expect(within(tiles).getByText("22%")).toBeTruthy();
    expect(within(tiles).getByText("210", { exact: false })).toBeTruthy();
    expect(screen.queryByTestId("open-detail")).toBeNull();
  });

  it("opens inline detail from a roster row's Open button", () => {
    const onSelectedComponentChange = vi.fn();
    render(<ComponentsView state={stateWith()} now={T0} onSelectedComponentChange={onSelectedComponentChange} />);
    fireEvent.click(screen.getByTestId("roster-open-press-gw-01/opcua-adapter"));
    expect(screen.getByTestId("tab-health")).toBeTruthy();
    expect(onSelectedComponentChange).toHaveBeenCalledWith(key("press-gw-01", "opcua-adapter"));
  });

  it("filters the tree from the query (app-bar search) and mirrors it in the filter box", () => {
    const onSearchChange = vi.fn();
    const { rerender } = render(
      <ComponentsView state={stateWith()} now={T0} query="" onSearchChange={onSearchChange} />,
    );
    fireEvent.change(screen.getByTestId("tree-filter"), { target: { value: "modbus" } });
    expect(onSearchChange).toHaveBeenCalledWith("modbus");

    // With the query applied, only the matching branch survives.
    rerender(<ComponentsView state={stateWith()} now={T0} query="modbus" onSearchChange={onSearchChange} />);
    const tree = screen.getByTestId("component-tree");
    expect(within(tree).getByTestId("tree-node-pack-gw-01/modbus-adapter")).toBeTruthy();
    expect(within(tree).queryByTestId("tree-node-pack-gw-01/opcua-adapter")).toBeNull();
    expect(within(tree).queryByTestId("tree-node-site=dallas/line=stamping")).toBeNull();
  });

  it("collapses / expands a group via its twistie", () => {
    render(<ComponentsView state={stateWith()} now={T0} />);
    // Collapsing the packaging line hides its device + component nodes.
    fireEvent.click(screen.getByTestId("tree-toggle-site=dallas/line=packaging"));
    expect(screen.queryByTestId("tree-node-pack-gw-01/opcua-adapter")).toBeNull();
    fireEvent.click(screen.getByTestId("tree-toggle-site=dallas/line=packaging"));
    expect(screen.getByTestId("tree-node-pack-gw-01/opcua-adapter")).toBeTruthy();
  });

  it("shows the not-connected empty state before a snapshot", () => {
    render(
      <ComponentsView
        state={clientState(fleetView([]), { hasSnapshot: false, status: "disconnected" })}
        now={T0}
      />,
    );
    expect(screen.getByTestId("empty-state")).toBeTruthy();
  });
});

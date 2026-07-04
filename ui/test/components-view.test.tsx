/**
 * The Components screen (R2) — presentational tests: the dynamic tree, the roster (group
 * selected), the component summary (leaf selected) + Open detail, and the app-bar search
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
    expect(within(tree).getByTestId("tree-node-pack-gw-01/opcua-adapter/main")).toBeTruthy();
  });

  it("rosters everything beneath the default (site) selection — the tree doubles as inventory", () => {
    render(<ComponentsView state={stateWith()} now={T0} />);
    const roster = screen.getByTestId("components-roster");
    // All three components are listed beneath the site.
    expect(within(roster).getByTestId("roster-row-pack-gw-01/opcua-adapter/main")).toBeTruthy();
    expect(within(roster).getByTestId("roster-row-pack-gw-01/modbus-adapter/main")).toBeTruthy();
    expect(within(roster).getByTestId("roster-row-press-gw-01/opcua-adapter/main")).toBeTruthy();
  });

  it("scopes the roster to a selected device node", () => {
    render(<ComponentsView state={stateWith()} now={T0} />);
    fireEvent.click(screen.getByTestId("tree-node-site=dallas/line=packaging/device=pack-gw-01"));
    const roster = screen.getByTestId("components-roster");
    expect(within(roster).getByTestId("roster-row-pack-gw-01/opcua-adapter/main")).toBeTruthy();
    // press-gw-01's component is NOT under pack-gw-01.
    expect(within(roster).queryByTestId("roster-row-press-gw-01/opcua-adapter/main")).toBeNull();
  });

  it("shows a component summary (+ Open detail) when a leaf is selected", () => {
    const onOpenDetail = vi.fn();
    render(<ComponentsView state={stateWith()} now={T0} onOpenDetail={onOpenDetail} />);
    fireEvent.click(screen.getByTestId("tree-node-pack-gw-01/opcua-adapter/main"));

    const summary = screen.getByTestId("component-summary");
    expect(within(summary).getByText("opcua-adapter")).toBeTruthy();
    // Vitals come from the runtime attributes + alarms (real data).
    expect(within(summary).getByTestId("summary-alerts").textContent).toBe("1");
    expect(within(summary).getByText("210", { exact: false })).toBeTruthy();

    fireEvent.click(screen.getByTestId("open-detail"));
    expect(onOpenDetail).toHaveBeenCalledWith(key("pack-gw-01", "opcua-adapter"));
  });

  it("opens detail from a roster row's Open button", () => {
    const onOpenDetail = vi.fn();
    render(<ComponentsView state={stateWith()} now={T0} onOpenDetail={onOpenDetail} />);
    fireEvent.click(screen.getByTestId("roster-open-press-gw-01/opcua-adapter/main"));
    // Roster "Open" selects the component (shows its summary); Open detail then hands off.
    fireEvent.click(screen.getByTestId("open-detail"));
    expect(onOpenDetail).toHaveBeenCalledWith(key("press-gw-01", "opcua-adapter"));
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
    expect(within(tree).getByTestId("tree-node-pack-gw-01/modbus-adapter/main")).toBeTruthy();
    expect(within(tree).queryByTestId("tree-node-pack-gw-01/opcua-adapter/main")).toBeNull();
    expect(within(tree).queryByTestId("tree-node-site=dallas/line=stamping")).toBeNull();
  });

  it("collapses / expands a group via its twistie", () => {
    render(<ComponentsView state={stateWith()} now={T0} />);
    // Collapsing the packaging line hides its device + component nodes.
    fireEvent.click(screen.getByTestId("tree-toggle-site=dallas/line=packaging"));
    expect(screen.queryByTestId("tree-node-pack-gw-01/opcua-adapter/main")).toBeNull();
    fireEvent.click(screen.getByTestId("tree-toggle-site=dallas/line=packaging"));
    expect(screen.getByTestId("tree-node-pack-gw-01/opcua-adapter/main")).toBeTruthy();
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

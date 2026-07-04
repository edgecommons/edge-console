/**
 * The Site-Topology screen (R3) — presentational tests: the SVG graph renders the dynamic
 * hierarchy + endpoint edges, a component node navigates to Detail, the cross-component-flow
 * layer is surfaced as pending, and the empty/disconnected states are honest. State in, DOM
 * out, callbacks observed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentKey } from "@edgecommons/edge-console-protocol";
import type { ConfigView } from "../src/fleet/config-store";
import { TopologyView } from "../src/topology/TopologyView";
import {
  attributesView,
  clientState,
  compView,
  deviceView,
  fleetView,
  hier,
  key,
  runtimeAttrs,
} from "./_fixtures";

afterEach(cleanup);

function cfgView(entries: Array<[ComponentKey, Record<string, unknown>]>): ConfigView {
  const entriesById: ConfigView["entriesById"] = {};
  for (const [k, config] of entries) {
    const id = `${k.device}/${k.component}`;
    entriesById[id] = { key: k, id, phase: "loaded", body: { config }, receivedAt: 0, refreshing: false };
  }
  return { entriesById };
}

const opcua = key("press-gw-01", "opcua-adapter");
const modbus = key("press-gw-01", "modbus-adapter");
const proc = key("press-gw-01", "telemetry-processor");
const h = hier(["site", "dallas"], ["line", "stamping"], ["device", "press-gw-01"]);

function topoState(overrides = {}) {
  return clientState(
    fleetView([
      deviceView("press-gw-01", [
        compView({ key: opcua, hier: h, liveness: "FRESH" }),
        compView({ key: modbus, hier: h, liveness: "FRESH" }),
        compView({ key: proc, hier: h, liveness: "FRESH" }),
      ]),
    ]),
    {
      configs: cfgView([
        [opcua, { endpoint: { url: "opc.tcp://192.168.1.180:49320" } }],
        [modbus, { slave: { host: "192.168.1.224", port: 5020, unitId: 1 } }],
        [proc, { streams: { northbound: { kind: "kinesis" } } }],
      ]),
      attributes: attributesView([
        runtimeAttrs(opcua, { platform: "GREENGRASS", connectionState: "CONNECTED" }),
        runtimeAttrs(modbus, { connectionState: "DISCONNECTED" }),
      ]),
      ...overrides,
    },
  );
}

describe("TopologyView", () => {
  it("renders the SVG graph with component, field, cloud and bus nodes", () => {
    const { container } = render(<TopologyView state={topoState()} />);
    expect(screen.getByTestId("topology-graph")).toBeTruthy();
    expect(container.querySelectorAll(".ec-gnode--comp").length).toBe(3);
    expect(container.querySelectorAll(".ec-gnode--field").length).toBe(2);
    expect(container.querySelectorAll(".ec-gnode--cloud").length).toBe(1);
    expect(container.querySelectorAll(".ec-gnode--infra").length).toBe(1);
    // the dynamic group caption + the kinesis cloud node label are present (SVG <text>)
    expect(container.querySelector(".ec-grplab")?.textContent).toBe("stamping · press-gw-01 · Greengrass");
    const cloudLabel = container.querySelector(".ec-gnode--cloud .ec-nlab")?.textContent;
    expect(cloudLabel).toBe("Kinesis");
  });

  it("navigates to Detail when a component node is clicked", () => {
    const onOpenDetail = vi.fn();
    render(<TopologyView state={topoState()} onOpenDetail={onOpenDetail} />);
    fireEvent.click(screen.getByTestId("topo-comp-press-gw-01/opcua-adapter"));
    expect(onOpenDetail).toHaveBeenCalledWith(opcua);
  });

  it("opens Detail on keyboard activation of a component node", () => {
    const onOpenDetail = vi.fn();
    render(<TopologyView state={topoState()} onOpenDetail={onOpenDetail} />);
    fireEvent.keyDown(screen.getByTestId("topo-comp-press-gw-01/modbus-adapter"), { key: "Enter" });
    expect(onOpenDetail).toHaveBeenCalledWith(modbus);
  });

  it("draws the disconnected southbound edge dashed with a ✕ marker (up but link down)", () => {
    const { container } = render(<TopologyView state={topoState()} />);
    expect(container.querySelectorAll(".ec-edge--err").length).toBeGreaterThanOrEqual(1);
    expect(container.querySelectorAll(".ec-edge-x").length).toBeGreaterThanOrEqual(1);
  });

  it("surfaces the cross-component data-flow layer as pending, never faked", () => {
    render(<TopologyView state={topoState()} />);
    const pending = screen.getByTestId("topo-flow-pending");
    expect(pending.textContent).toMatch(/not derivable/i);
    expect(pending.textContent).toMatch(/flow metadata/i);
  });

  it("renders the legend + the derived stats", () => {
    render(<TopologyView state={topoState()} />);
    const legend = screen.getByTestId("topo-legend");
    expect(legend.textContent).toMatch(/connected/);
    expect(legend.textContent).toMatch(/disconnected/);
    expect(legend.textContent).toMatch(/internal dataflow/);
    const stats = screen.getByTestId("topo-stats").textContent ?? "";
    expect(stats).toMatch(/3 components/);
    expect(stats).toMatch(/1 device/);
    expect(stats).toMatch(/2 field/);
    expect(stats).toMatch(/1 cloud endpoint/);
  });

  it("shows a connecting empty state before the first snapshot", () => {
    const state = clientState(fleetView([]), { hasSnapshot: false, status: "connecting" });
    render(<TopologyView state={state} />);
    expect(screen.getByTestId("empty-state")).toBeTruthy();
  });

  it("shows an empty-fleet state when connected with no components", () => {
    const state = clientState(fleetView([]), { hasSnapshot: true, status: "connected" });
    render(<TopologyView state={state} />);
    expect(screen.getByTestId("empty-fleet")).toBeTruthy();
  });
});

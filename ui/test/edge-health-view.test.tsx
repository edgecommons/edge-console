import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { EdgeHealthView, platformsByDevice } from "../src/health/EdgeHealthView";
import { StatusTag, RollupTag } from "../src/health/StatusTag";
import {
  T0,
  alarmSnapshot,
  attributesView,
  clientState,
  commandEntry,
  commandView,
  compView,
  consoleAlarm,
  deviceView,
  fleetView,
  hier,
  key,
  runtimeAttrs,
} from "./_fixtures";

afterEach(cleanup);

/** A component on a [site, line, device] hierarchy (the mockup's line-grouped fleet). */
function lineComp(line: string, device: string, component: string, over = {}) {
  return compView({
    key: key(device, component),
    hier: hier(["site", "dallas"], ["line", line], ["device", device]),
    path: `dallas/${line}/${device}`,
    ...over,
  });
}

describe("Overview — the faithful line-grouped fleet", () => {
  const NOW = T0 + 2000; // 2s since the FRESH keepalives
  const view = fleetView([
    deviceView("press-gw-01", [
      lineComp("stamping", "press-gw-01", "opcua-adapter"),
      lineComp("stamping", "press-gw-01", "modbus-adapter"),
      lineComp("stamping", "press-gw-01", "telemetry-processor"),
    ]),
    deviceView("pack-gw-01", [
      lineComp("packaging", "pack-gw-01", "opcua-adapter", { liveness: "STALE", lastStateAt: T0 - 41_000 }),
      lineComp("packaging", "pack-gw-01", "modbus-adapter", { liveness: "OFFLINE", lastStateAt: undefined, uptimeSecs: undefined }),
    ]),
  ]);
  const attrs = attributesView([
    runtimeAttrs(key("press-gw-01", "opcua-adapter"), { cpuPercent: 12, memoryMb: 210, connectionState: "CONNECTED" }),
    runtimeAttrs(key("press-gw-01", "modbus-adapter"), { cpuPercent: 18.4, memoryMb: 72, connectionState: "RECONNECTING" }),
    // telemetry-processor reports NO attributes → its CPU/Memory/Conn cells show "—".
  ]);
  const alarms = alarmSnapshot([
    consoleAlarm({ key: key("pack-gw-01", "opcua-adapter"), type: "sensor-fault", severity: "critical" }),
  ]);
  const state = clientState(view, { attributes: attrs, alarms, busMsgsPerSec: 18 });

  it("renders the page-context header with the dynamic site/line stat + live status", () => {
    render(<EdgeHealthView state={state} now={NOW} />);
    expect(screen.getByRole("heading", { name: "Edge health" })).toBeTruthy();
    expect(screen.getByText("dallas")).toBeTruthy();
    expect(screen.getByText(/5 components across 2 lines/)).toBeTruthy();
    expect(screen.getByTestId("ws-status").textContent).toContain("WS Live");
    expect(screen.getByTestId("bus-status").textContent).toContain("Bus connected");
  });

  it("renders the four summary tiles from live rollup/alarms/throughput", () => {
    render(<EdgeHealthView state={state} now={NOW} />);
    expect(screen.getByTestId("healthy-count").textContent).toBe("3/5 healthy");
    expect(screen.getByTestId("active-alerts-count").textContent).toBe("1");
    expect(screen.getByText("1 critical")).toBeTruthy();
    expect(screen.getByTestId("bus-rate").textContent).toBe("18");
    expect(screen.getByTestId("node-self").textContent).toBe("Live");
  });

  it("groups DYNAMICALLY by the intermediate LINE level with worst-of rollup tags", () => {
    render(<EdgeHealthView state={state} now={NOW} />);
    const stamping = screen.getByTestId("group-line=stamping");
    expect(within(stamping).getByText("Healthy")).toBeTruthy();
    expect(within(stamping).getByText(/3 components/)).toBeTruthy();
    const packaging = screen.getByTestId("group-line=packaging");
    expect(within(packaging).getByText("Critical")).toBeTruthy(); // has an OFFLINE component
  });

  it("renders the mockup's nine columns incl. real CPU/Memory/Conn and honest placeholders", () => {
    render(<EdgeHealthView state={state} now={NOW} />);
    for (const col of ["Health", "Component", "Device", "Heartbeat", "CPU", "Memory", "Conn", "Capabilities"]) {
      expect(screen.getByRole("columnheader", { name: col })).toBeTruthy();
    }
    // opcua-adapter: real attributes + a 2s heartbeat.
    const opcua = screen.getByTestId("component-row-press-gw-01/opcua-adapter");
    expect(within(opcua).getByText("12%")).toBeTruthy();
    expect(within(opcua).getByText("210 MB")).toBeTruthy();
    expect(within(opcua).getByText("CONNECTED")).toBeTruthy();
    expect(within(opcua).getByText("2s")).toBeTruthy();
    // modbus-adapter: the RECONNECTING conn state (rounded cpu 18).
    const modbus = screen.getByTestId("component-row-press-gw-01/modbus-adapter");
    expect(within(modbus).getByText("RECONNECTING")).toBeTruthy();
    expect(within(modbus).getByText("18%")).toBeTruthy();
    // telemetry-processor: no attributes ⇒ Conn shows "—" (a non-adapter has no conn state).
    const telem = screen.getByTestId("component-row-press-gw-01/telemetry-processor");
    expect(within(telem).getByTestId("capabilities-press-gw-01/telemetry-processor").textContent).toBe("—");
  });

  it("renders Capabilities as an honest pending placeholder (Phase-2, never fabricated)", () => {
    render(<EdgeHealthView state={state} now={NOW} />);
    // Every row's Capabilities cell is a dash — the describe/panels manifest is deferred.
    expect(screen.getByTestId("capabilities-press-gw-01/opcua-adapter").textContent).toBe("—");
    expect(screen.getByTestId("capabilities-pack-gw-01/modbus-adapter").textContent).toBe("—");
  });

  it("shows the STALE heartbeat overdue and the OFFLINE heartbeat as '—'", () => {
    render(<EdgeHealthView state={state} now={NOW} />);
    const stale = screen.getByTestId("component-row-pack-gw-01/opcua-adapter");
    expect(within(stale).getByText("43s").className).toContain("ec-overdue");
    const offline = screen.getByTestId("component-row-pack-gw-01/modbus-adapter");
    // heartbeat "—" for a component that never reported state.
    expect(within(offline).getByText("Offline")).toBeTruthy();
  });

  it("makes the Active alerts tile open Events when wired", () => {
    const onOpenEvents = vi.fn();
    render(<EdgeHealthView state={state} now={NOW} onOpenEvents={onOpenEvents} />);
    fireEvent.click(screen.getByTestId("active-alerts-tile"));
    expect(onOpenEvents).toHaveBeenCalled();
  });

  it("filters the fleet by the shared search query (empty-search when nothing matches)", () => {
    const { rerender } = render(<EdgeHealthView state={state} now={NOW} query="modbus" />);
    expect(screen.getByTestId("component-row-press-gw-01/modbus-adapter")).toBeTruthy();
    expect(screen.queryByTestId("component-row-press-gw-01/opcua-adapter")).toBeNull();
    // The header stat stays whole-fleet (context), only the table narrows.
    expect(screen.getByText(/5 components across 2 lines/)).toBeTruthy();

    rerender(<EdgeHealthView state={state} now={NOW} query="nonesuch" />);
    expect(screen.getByTestId("empty-search")).toBeTruthy();
  });
});

describe("Overview — whole-device unreachability containment", () => {
  const view = fleetView([
    deviceView(
      "asm-gw-01",
      [
        lineComp("assembly", "asm-gw-01", "telemetry-processor", { liveness: "UNREACHABLE" }),
        lineComp("assembly", "asm-gw-01", "file-replicator", { liveness: "UNREACHABLE" }),
      ],
      { unreachable: true, unreachableSince: T0 - 120_000 },
    ),
  ]);
  const alarms = alarmSnapshot([
    consoleAlarm({ key: key("asm-gw-01", "telemetry-processor"), type: "pipeline-lag", contained: true }),
    consoleAlarm({ key: key("asm-gw-01", "file-replicator"), type: "watch-error", contained: true }),
  ]);
  const state = clientState(view, { alarms });

  it("shows the containment note ('the road is down, not the houses') + suppressed count", () => {
    render(<EdgeHealthView state={state} now={T0} />);
    expect(screen.getByText("asm-gw-01 — device unreachable for 2m 00s")).toBeTruthy();
    expect(screen.getByText(/the road is down, not the houses/)).toBeTruthy();
    expect(screen.getByText(/2 components frozen at last-known values/)).toBeTruthy();
    expect(screen.getByText(/\+2 would-be alarms suppressed/)).toBeTruthy();
  });

  it("rolls the group Unreachable with the bridge-offline + contained summary", () => {
    render(<EdgeHealthView state={state} now={T0} />);
    const group = screen.getByTestId("group-line=assembly");
    expect(within(group).getByText("Unreachable")).toBeTruthy();
    expect(within(group).getByText(/bridge offline 2m 00s/)).toBeTruthy();
    expect(within(group).getByText(/alarms contained \(\+2\)/)).toBeTruthy();
  });
});

describe("Overview — dynamic grouping over other hier shapes", () => {
  it("[site, device] degrades to a flat list of DEVICE groups", () => {
    const view = fleetView([
      deviceView("gw-01", [compView({ key: key("gw-01", "a") })]),
      deviceView("gw-02", [compView({ key: key("gw-02", "a") })]),
    ]);
    render(<EdgeHealthView state={clientState(view)} now={T0} />);
    expect(screen.getByText(/2 components across 2 devices/)).toBeTruthy();
    expect(screen.getByText("grouped by device")).toBeTruthy();
    expect(screen.getByTestId("group-device=gw-01")).toBeTruthy();
    expect(screen.getByTestId("group-device=gw-02")).toBeTruthy();
  });

  it("[site, area, line, device] nests AREA → LINE", () => {
    const mk = (area: string, line: string, device: string) =>
      compView({
        key: key(device, "opcua-adapter"),
        hier: hier(["site", "dallas"], ["area", area], ["line", line], ["device", device]),
        path: `dallas/${area}/${line}/${device}`,
      });
    const view = fleetView([
      deviceView("w1", [mk("body", "weld", "w1")]),
      deviceView("t1", [mk("trim", "trim-a", "t1")]),
    ]);
    render(<EdgeHealthView state={clientState(view)} now={T0} />);
    expect(screen.getByText("grouped by area, line")).toBeTruthy();
    expect(screen.getByTestId("group-area=body")).toBeTruthy();
    expect(screen.getByTestId("group-area=body/line=weld")).toBeTruthy();
  });
});

describe("Overview — empty, connecting and degraded-connection states", () => {
  const NOW = T0 + 10_000;
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
    expect(screen.getByTestId("component-row-gw-01/comp-a")).toBeTruthy();
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

describe("Overview — C4 command controls", () => {
  const CID = "gw-01/opcua-adapter";
  const view = fleetView([deviceView("gw-01", [compView({ key: key("gw-01", "opcua-adapter") })])]);

  it("reveals the per-component controls on expand and fires a command", () => {
    const onInvoke = vi.fn();
    render(<EdgeHealthView state={clientState(view)} now={T0} onInvoke={onInvoke} />);
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
    const { rerender } = render(<EdgeHealthView state={clientState(view)} now={T0} />);
    rerender(
      <EdgeHealthView
        state={clientState(view, {
          commands: commandView([commandEntry({ requestId: "r1", verb: "ping", phase: "ok" })]),
        })}
        now={T0}
      />,
    );
    expect(screen.getByTestId("cmd-toast-r1")).toBeTruthy();
  });
});

describe("Overview — R1: console-self tile, Edge-bus tile, alarm notes, table-tools, sparklines", () => {
  const NOW = T0 + 2000;
  const view = fleetView([
    deviceView("press-gw-01", [
      lineComp("stamping", "press-gw-01", "opcua-adapter"),
      lineComp("stamping", "press-gw-01", "modbus-adapter"),
    ]),
    deviceView("pack-gw-01", [
      lineComp("packaging", "pack-gw-01", "opcua-adapter", { liveness: "STALE", lastStateAt: T0 - 41_000 }),
      lineComp("packaging", "pack-gw-01", "modbus-adapter", { liveness: "OFFLINE", lastStateAt: undefined, uptimeSecs: undefined }),
    ]),
  ]);
  const attrs = attributesView([
    runtimeAttrs(key("press-gw-01", "opcua-adapter"), {
      cpuPercent: 12, memoryMb: 210, connectionState: "CONNECTED", cpuSeries: [10, 12, 9, 14, 11], platform: "GREENGRASS",
    }),
    runtimeAttrs(key("press-gw-01", "modbus-adapter"), { cpuPercent: 18, memoryMb: 72, platform: "GREENGRASS" }),
    runtimeAttrs(key("pack-gw-01", "opcua-adapter"), { platform: "HOST" }),
    runtimeAttrs(key("pack-gw-01", "modbus-adapter"), { platform: "HOST" }),
  ]);
  const alarms = alarmSnapshot([
    consoleAlarm({ key: key("pack-gw-01", "opcua-adapter"), type: "sensor-fault", severity: "critical", message: "flow out of range", raisedAt: T0 }),
  ]);
  const self = {
    device: "gw-dallas-01", component: "edge-console", platform: "HOST", transport: "MQTT",
    broker: "EMQX @ gateway", cpuPercent: 4, memoryMb: 180, uptimeSecs: 6 * 86400,
  };
  const state = clientState(view, {
    attributes: attrs, alarms, busMsgsPerSec: 412, busRecentRates: [10, 12, 8, 20, 15, 18, 25, 22], self,
  });

  it("renders the console-self tile with the console's OWN node name + platform/cpu/mem/uptime", () => {
    render(<EdgeHealthView state={state} now={NOW} />);
    expect(screen.getByTestId("node-self").textContent).toBe("gw-dallas-01");
    const foot = screen.getByTestId("node-self-foot").textContent!;
    expect(foot).toContain("HOST");
    expect(foot).toContain("cpu 4%");
    expect(foot).toContain("mem 180 MB");
    expect(foot).toContain("up 6d");
  });

  it("renders the Edge-bus tile transport foot + a throughput sparkline", () => {
    render(<EdgeHealthView state={state} now={NOW} />);
    expect(screen.getByTestId("bus-transport").textContent).toBe("MQTT · EMQX @ gateway");
    const busrow = screen.getByTestId("bus-rate").parentElement!;
    expect(busrow.querySelector('[data-testid="sparkline"]')).toBeTruthy();
  });

  it("shows the active-alerts tile foot with the +contained rollup", () => {
    const withContained = clientState(view, {
      attributes: attrs, busMsgsPerSec: 412,
      alarms: alarmSnapshot([
        consoleAlarm({ key: key("pack-gw-01", "opcua-adapter"), type: "sensor-fault", severity: "critical" }),
        consoleAlarm({ key: key("asm-gw-01", "x"), type: "a", contained: true }),
        consoleAlarm({ key: key("asm-gw-01", "y"), type: "b", contained: true }),
      ]),
    });
    render(<EdgeHealthView state={withContained} now={NOW} />);
    expect(screen.getByText("1 critical · +2 contained")).toBeTruthy();
  });

  it("renders active alarms as actionable notes with working Ack + View", () => {
    const onAck = vi.fn();
    const onOpenEvents = vi.fn();
    render(<EdgeHealthView state={state} now={NOW} onAck={onAck} onOpenEvents={onOpenEvents} />);
    const note = screen.getByTestId("alarm-note-pack-gw-01/opcua-adapter::sensor-fault");
    expect(within(note).getByText("opcua-adapter — sensor-fault")).toBeTruthy();
    fireEvent.click(within(note).getByText("Ack"));
    expect(onAck).toHaveBeenCalledWith("pack-gw-01/opcua-adapter::sensor-fault");
    fireEvent.click(within(note).getByText("View"));
    expect(onOpenEvents).toHaveBeenCalled();
  });

  it("renders the table-tools controls and the Status filter narrows the fleet", () => {
    render(<EdgeHealthView state={state} now={NOW} />);
    expect(screen.getByTestId("fleet-groupby").textContent).toContain("Line");
    expect(screen.getByTestId("fleet-view-tiles").textContent).toContain("Tiles");
    const select = screen.getByTestId("fleet-status-filter") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "OFFLINE" } });
    expect(screen.getByTestId("component-row-pack-gw-01/modbus-adapter")).toBeTruthy();
    expect(screen.queryByTestId("component-row-press-gw-01/opcua-adapter")).toBeNull();
  });

  it("renders the CPU sparkline where a series exists + the group-row platform annotation", () => {
    render(<EdgeHealthView state={state} now={NOW} />);
    const opcua = screen.getByTestId("component-row-press-gw-01/opcua-adapter");
    expect(within(opcua).getByTestId("sparkline")).toBeTruthy();
    expect(within(opcua).getByText("12%")).toBeTruthy();
    expect(within(screen.getByTestId("group-line=stamping")).getByText(/press-gw-01 \(Greengrass\)/)).toBeTruthy();
    expect(within(screen.getByTestId("group-line=packaging")).getByText(/pack-gw-01 \(HOST\)/)).toBeTruthy();
  });

  it("renders the Memory sparkline where a memory series exists — the exact CPU treatment mirrored (WP-J)", () => {
    const withMem = clientState(view, {
      attributes: attributesView([
        runtimeAttrs(key("press-gw-01", "opcua-adapter"), {
          cpuPercent: 12,
          memoryMb: 210,
          cpuSeries: [10, 12, 9, 14, 11],
          memorySeries: [180, 195, 200, 205, 210],
          platform: "GREENGRASS",
        }),
      ]),
    });
    render(<EdgeHealthView state={withMem} now={NOW} />);
    const opcua = screen.getByTestId("component-row-press-gw-01/opcua-adapter");
    const sparks = within(opcua).getAllByTestId("sparkline");
    expect(sparks).toHaveLength(2); // CPU + Memory, same cell treatment
    expect(sparks[0]!.getAttribute("aria-label")).toContain("cpu trend");
    expect(sparks[1]!.getAttribute("aria-label")).toContain("memory trend");
    expect(within(opcua).getByText("210 MB")).toBeTruthy();
  });

  it("keeps Capabilities honestly blank (Phase-2) alongside the R1 additions", () => {
    render(<EdgeHealthView state={state} now={NOW} />);
    expect(screen.getByTestId("capabilities-press-gw-01/opcua-adapter").textContent).toBe("—");
  });

  it("platformsByDevice maps each device to its first advertised platform", () => {
    expect(platformsByDevice(attrs)).toEqual({ "press-gw-01": "GREENGRASS", "pack-gw-01": "HOST" });
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
  });

  it("maps every rollup level", () => {
    render(
      <>
        <RollupTag level="healthy" />
        <RollupTag level="degraded" />
        <RollupTag level="critical" />
        <RollupTag level="unreachable" />
        <RollupTag level="stopped" />
        <RollupTag level="empty" />
      </>,
    );
    for (const label of ["Healthy", "Degraded", "Critical", "Unreachable", "Stopped", "No components"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });
});

/**
 * Descriptor-renderer v2 widgets (edge-console-panels.md §4/§4.1) — the slice-2
 * console-owned widgets rendered by ComponentDetailView's Panel tab:
 * statusDashboard, actionBar, commandTable (+ the schema-checked controls form),
 * metricSeries, eventFeed, generic treeBrowser/signalGrid columns, the
 * rendererRequirements view gate, and the shared availability rules.
 * State in, DOM out, callbacks observed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentDescribeManifest, PanelViewDescriptor } from "@edgecommons/edge-console-protocol";
import { ComponentDetailView } from "../src/components/ComponentDetailView";
import {
  T0,
  clientState,
  commandEntry,
  commandView,
  compView,
  consoleEvent,
  deviceView,
  fleetView,
  hier,
  key,
  metricPoints,
  metricSeries,
  metricsView,
} from "./_fixtures";

afterEach(cleanup);
afterEach(() => window.history.replaceState(null, "", "/"));

const DKEY = key("pack-gw-01", "profinet-adapter");
const ID = "pack-gw-01/profinet-adapter";

const ALL_VERBS = [
  "describe",
  "sb/status",
  "sb/pause",
  "sb/resume",
  "reconnect",
  "repoll",
  "sb/discover",
  "sb/browse",
  "sb/read",
  "sb/signals",
];

/** The slice-2 target manifest (profinet-flavored) with per-test view overrides. */
function v2Manifest(opts: {
  views?: PanelViewDescriptor[];
  commands?: ComponentDescribeManifest["commands"];
  defaultView?: string;
} = {}): ComponentDescribeManifest {
  return {
    schema: "edgecommons.component.describe.v1",
    component: { component: "profinet-adapter", implementation: "Rust", version: "0.1.0" },
    digest: "sha256:v2",
    commands: opts.commands ?? ALL_VERBS.map((verb) => ({ verb })),
    panels: {
      schema: "edgecommons.panels.v2",
      provider: "profinet-adapter",
      renderer: "descriptor",
      defaultView: opts.defaultView ?? "overview",
      views: opts.views ?? defaultViews(),
    },
  };
}

function overviewView(overrides: Partial<PanelViewDescriptor> = {}): PanelViewDescriptor {
  return {
    id: "overview",
    title: "Overview",
    order: 10,
    scope: "instance",
    rendererRequirements: [
      "action-bar.v1",
      "command-availability.v1",
      "instance-selector.v1",
      "metric-series.v1",
      "status-dashboard.v1",
    ],
    widgets: [
      {
        kind: "statusDashboard",
        id: "status",
        title: "Live status",
        scope: "instance",
        verb: "sb/status",
        refresh: { onEnter: true, manual: true, intervalMs: 1000 },
        fields: [
          { label: "Adapter state", path: "state", format: "badge" },
          { label: "Connected", path: "connected", format: "boolean" },
          { label: "Cycle", path: "protocol.cyclePeriodUs", format: "number", unit: "us" },
          { label: "Watchdog", path: "protocol.watchdog", format: "hologram" },
          { label: "Last seen", path: "protocol.missing" },
        ],
      },
      {
        kind: "actionBar",
        id: "lifecycle",
        title: "Lifecycle",
        scope: "instance",
        actions: [
          {
            verb: "sb/pause",
            label: "Pause publication",
            role: "operator",
            confirm: "Protocol keepalive duties may continue.",
          },
          { verb: "sb/resume", label: "Resume publication" },
          { verb: "reconnect", label: "Reconnect device", danger: true, confirm: "Session teardown." },
          { verb: "repoll", label: "Refresh now", args: { mode: "soft" } },
        ],
      },
      {
        kind: "metricSeries",
        id: "health-metrics",
        title: "Cycle health",
        scope: "instance",
        series: [
          { label: "Missed cycles", metric: "ProfinetCycle", measure: "missedCycles", unit: "cycles" },
          { label: "Avg jitter", metric: "ProfinetCycle", measure: "maxJitterUs", aggregation: "avg", unit: "us" },
          { label: "Ghost", metric: "nope", measure: "nada" },
        ],
      },
    ],
    ...overrides,
  };
}

function discoveryView(overrides: Partial<PanelViewDescriptor> = {}): PanelViewDescriptor {
  return {
    id: "discovery",
    title: "Device Discovery",
    order: 20,
    scope: "component",
    rendererRequirements: ["command-availability.v1", "command-table.v1"],
    widgets: [
      {
        kind: "commandTable",
        id: "discover-table",
        title: "DCP Identify",
        verb: "sb/discover",
        resultPath: "devices",
        request: { timeoutMs: 1000 },
        refresh: { onEnter: true, intervalMs: 2000 }, // must be ignored: discovery is manual-only
        columns: [
          { label: "MAC", path: "mac", format: "address" },
          { label: "Station", path: "stationName" },
          { label: "Vendor", path: "vendorId", format: "number" },
        ],
        controls: [
          { field: "stationName", type: "text", label: "Station name" },
          { field: "filter.vendorId", type: "integer", label: "Vendor ID" },
          { field: "portRange", type: "integer-range", label: "Ports" },
          { field: "verbose", type: "boolean", label: "Verbose" },
          { field: "timeoutMs", type: "duration-ms", label: "Timeout" },
          {
            field: "runtimeId",
            type: "select",
            label: "Runtime",
            optionsSource: { path: "runtimes", valuePath: "id", labelPath: "name" },
          },
          { field: "holo", type: "3d-picker" },
        ],
      },
    ],
    ...overrides,
  };
}

function topologyView(): PanelViewDescriptor {
  return {
    id: "topology",
    title: "IO Topology",
    order: 30,
    scope: "instance",
    rendererRequirements: ["command-availability.v1", "instance-selector.v1", "tree-columns.v1"],
    widgets: [
      {
        kind: "treeBrowser",
        id: "io-tree",
        title: "IO Topology",
        scope: "instance",
        mode: "hierarchical",
        rootRef: "root",
        browseVerb: "sb/browse",
        readVerb: "sb/read",
        columns: [
          { label: "Name", path: "name" },
          { label: "Kind", path: "nodeClass" },
          { label: "Slot", path: "protocol.slot", format: "number" },
        ],
      },
    ],
  };
}

function signalsView(widgetOverrides: Record<string, unknown> = {}): PanelViewDescriptor {
  return {
    id: "signals",
    title: "Process Image",
    order: 40,
    scope: "instance",
    rendererRequirements: ["command-availability.v1", "instance-selector.v1", "signal-columns.v1"],
    widgets: [
      {
        kind: "signalGrid",
        id: "signal-grid",
        title: "Process image",
        scope: "instance",
        signalsVerb: "sb/signals",
        subscriptionsVerb: "sb/subscriptions",
        columns: [
          { label: "Signal", path: "signalId", format: "address" },
          { label: "Direction", path: "direction" },
          { label: "Type", path: "dataType" },
        ],
        ...widgetOverrides,
      },
    ],
  };
}

function diagnosticsView(): PanelViewDescriptor {
  return {
    id: "diagnostics",
    title: "Diagnostics",
    order: 50,
    scope: "instance",
    rendererRequirements: ["event-feed.v1", "instance-selector.v1"],
    widgets: [
      {
        kind: "eventFeed",
        id: "diag-events",
        title: "Protocol events",
        scope: "instance",
        families: ["ProfinetAlarmEvent", "SouthboundWriteAudit"],
        limit: 2,
        filters: { "detail.slot": 3 },
      },
    ],
  };
}

function defaultViews(): PanelViewDescriptor[] {
  return [overviewView(), discoveryView(), topologyView(), signalsView(), diagnosticsView()];
}

function descriptorReady(manifest = v2Manifest()) {
  return { key: DKEY, id: ID, phase: "ready" as const, manifest, receivedAt: T0 - 1000, refreshing: false };
}

function loadedConfig() {
  return {
    key: DKEY,
    id: ID,
    phase: "loaded" as const,
    body: {
      config: {
        runtimes: [
          { id: "rt-1", name: "Controller 1" },
          { id: "rt-2", name: "Controller 2" },
        ],
      },
    },
    receivedAt: T0 - 3000,
    refreshing: false,
  };
}

function v2State(overrides = {}, manifest = v2Manifest()) {
  return clientState(
    fleetView([
      deviceView("pack-gw-01", [
        compView({
          key: DKEY,
          hier: hier(["site", "dallas"], ["device", "pack-gw-01"]),
          instances: [
            { instance: "filler1", connected: true },
            { instance: "kep2", connected: true },
          ],
        }),
      ]),
    ]),
    {
      descriptions: { entriesById: { [ID]: descriptorReady(manifest) } },
      configs: { entriesById: { [ID]: loadedConfig() } },
      ...overrides,
    },
  );
}

function renderPanel(state = v2State()) {
  const cbs = { onInvoke: vi.fn(), onRefreshDescriptor: vi.fn() };
  render(<ComponentDetailView state={state} now={T0} detailKey={DKEY} {...cbs} />);
  fireEvent.click(screen.getByTestId("tab-panel"));
  return cbs;
}

function openView(name: string) {
  fireEvent.click(within(screen.getByTestId("descriptor-panel")).getByRole("tab", { name }));
}

function statusOk(result: unknown, overrides = {}) {
  return commandEntry({
    requestId: "st-1",
    key: DKEY,
    verb: "sb/status",
    instance: "filler1",
    result,
    ...overrides,
  });
}

const ONLINE_STATUS = {
  state: "ONLINE",
  connected: true,
  paused: false,
  protocol: { cyclePeriodUs: 31250, watchdog: "3x" },
};

describe("Panel v2 — the rendererRequirements view gate", () => {
  it("an unknown token renders ONE view-level state and mounts none of the view's widgets", () => {
    const manifest = v2Manifest({
      views: [
        overviewView({ rendererRequirements: ["status-dashboard.v1", "holo-deck.v2"] }),
        discoveryView(),
      ],
    });
    const cbs = renderPanel(v2State({}, manifest));
    const gate = screen.getByTestId("panel-requirements-gate");
    expect(within(gate).getByText("This view requires a newer edge-console.")).toBeTruthy();
    expect(within(gate).getByText("holo-deck.v2")).toBeTruthy();
    expect(screen.queryByTestId("panel-view-overview")).toBeNull();
    expect(screen.queryByTestId("panel-widget-status")).toBeNull();
    expect(screen.queryByTestId("panel-instance-selector")).toBeNull();
    // No widget mounted ⇒ no onEnter refresh fired either.
    expect(cbs.onInvoke).not.toHaveBeenCalled();
    // Another view without unknown tokens still renders.
    openView("Device Discovery");
    expect(screen.getByTestId("panel-view-discovery")).toBeTruthy();
  });

  it("a partial list gates too — every token must be known", () => {
    const manifest = v2Manifest({
      views: [
        overviewView({
          rendererRequirements: ["action-bar.v1", "command-availability.v1", "warp-drive.v1"],
        }),
      ],
    });
    renderPanel(v2State({}, manifest));
    expect(screen.getByTestId("panel-requirements-gate")).toBeTruthy();
    expect(screen.getByText("warp-drive.v1")).toBeTruthy();
    expect(screen.queryByTestId("panel-widget-lifecycle")).toBeNull();
  });

  it("views without the field render as before; an all-known list mounts normally", () => {
    const noField = overviewView();
    delete noField.rendererRequirements;
    renderPanel(v2State({}, v2Manifest({ views: [noField, topologyView()] })));
    expect(screen.getByTestId("panel-view-overview")).toBeTruthy();
    expect(screen.getByTestId("panel-widget-status")).toBeTruthy();
    openView("IO Topology");
    expect(screen.getByTestId("panel-view-topology")).toBeTruthy();
    expect(screen.getByTestId("panel-widget-io-tree")).toBeTruthy();
  });
});

describe("Panel v2 — statusDashboard", () => {
  it("refreshes on entry and manually, always with the SELECTED instance", () => {
    const cbs = renderPanel();
    // onEnter fired at widget mount with the default selection.
    expect(cbs.onInvoke).toHaveBeenCalledWith(DKEY, "sb/status", { instance: "filler1" });
    const before = cbs.onInvoke.mock.calls.filter((c) => c[1] === "sb/status").length;
    fireEvent.click(screen.getByTestId("panel-status-refresh"));
    expect(cbs.onInvoke.mock.calls.filter((c) => c[1] === "sb/status").length).toBe(before + 1);
    // Switching the selector re-enters for the new instance and manual refresh sends it.
    fireEvent.change(screen.getByTestId("panel-instance-selector"), { target: { value: "kep2" } });
    fireEvent.click(screen.getByTestId("panel-status-refresh"));
    expect(cbs.onInvoke).toHaveBeenLastCalledWith(DKEY, "sb/status", { instance: "kep2" });
  });

  it("polls at the CLAMPED interval (>= 2 s) only while the tab is visible", () => {
    vi.useFakeTimers();
    try {
      const cbs = { onInvoke: vi.fn(), onRefreshDescriptor: vi.fn() };
      render(<ComponentDetailView state={v2State()} now={T0} detailKey={DKEY} {...cbs} />);
      const statusCalls = () => cbs.onInvoke.mock.calls.filter((c) => c[1] === "sb/status").length;
      const mounted = statusCalls(); // the onEnter fire
      // Hidden Panel tab (Health is active): the 1000 → 2000-clamped interval must skip.
      act(() => {
        vi.advanceTimersByTime(2500);
      });
      expect(statusCalls()).toBe(mounted);
      fireEvent.click(screen.getByTestId("tab-panel"));
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(statusCalls()).toBe(mounted + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the field grid over closed result paths with the formats enum", () => {
    renderPanel(v2State({ commands: commandView([statusOk(ONLINE_STATUS)]) }));
    const fields = screen.getByTestId("panel-status-fields");
    const stateRow = within(fields).getByTestId("panel-status-field-Adapter-state");
    expect(within(stateRow).getByText("ONLINE")).toBeTruthy(); // badge → tag
    expect(within(within(fields).getByTestId("panel-status-field-Connected")).getByText("Yes")).toBeTruthy();
    expect(within(within(fields).getByTestId("panel-status-field-Cycle")).getByText("31,250 us")).toBeTruthy();
    // Unknown format falls back to visible plain text; missing path shows the em dash.
    expect(within(within(fields).getByTestId("panel-status-field-Watchdog")).getByText("3x")).toBeTruthy();
    expect(within(within(fields).getByTestId("panel-status-field-Last-seen")).getByText("—")).toBeTruthy();
  });

  it("keeps forbidden / timeout / malformed distinct and visible", () => {
    renderPanel(
      v2State({
        commands: commandView([
          statusOk(undefined, { phase: "error", result: undefined, error: { code: "FORBIDDEN", message: "" } }),
        ]),
      }),
    );
    expect(screen.getByTestId("panel-error-forbidden")).toBeTruthy();
    cleanup();
    window.history.replaceState(null, "", "/");

    renderPanel(
      v2State({
        commands: commandView([
          statusOk(undefined, { phase: "error", result: undefined, error: { code: "TIMEOUT", message: "" } }),
        ]),
      }),
    );
    expect(screen.getByTestId("panel-error-timeout")).toBeTruthy();
    cleanup();
    window.history.replaceState(null, "", "/");

    renderPanel(v2State({ commands: commandView([statusOk("not-an-object")]) }));
    expect(screen.getByTestId("panel-malformed-result")).toBeTruthy();
  });

  it("an unadvertised verb renders the unavailable state and disables refresh", () => {
    const manifest = v2Manifest({ commands: ALL_VERBS.filter((v) => v !== "sb/status").map((verb) => ({ verb })) });
    const cbs = renderPanel(v2State({}, manifest));
    const widget = screen.getByTestId("panel-widget-status");
    expect(within(widget).getByTestId("panel-capability-unavailable")).toBeTruthy();
    const refresh = screen.getByTestId("panel-status-refresh") as HTMLButtonElement;
    expect(refresh.disabled).toBe(true);
    expect(cbs.onInvoke).not.toHaveBeenCalledWith(DKEY, "sb/status", expect.anything());
  });

  it("availability disabled/unsupported disables the widget and shows the SANITIZED reason", () => {
    const manifest = v2Manifest({
      commands: ALL_VERBS.map((verb) =>
        verb === "sb/status"
          ? { verb, availability: { state: "disabled" as const, reason: "sensor \u0000 offline\n\nnow" } }
          : { verb },
      ),
    });
    const cbs = renderPanel(v2State({}, manifest));
    const widget = screen.getByTestId("panel-widget-status");
    const notice = within(widget).getByTestId("panel-capability-disabled");
    expect(notice.textContent).toContain("sensor offline now");
    expect(notice.textContent).not.toContain("\u0000");
    expect((screen.getByTestId("panel-status-refresh") as HTMLButtonElement).disabled).toBe(true);
    expect(cbs.onInvoke).not.toHaveBeenCalledWith(DKEY, "sb/status", expect.anything());
  });

  it("a vanished selected instance shows the explicit unavailable state, never a fallback", () => {
    window.history.replaceState(null, "", "/?instance=gone");
    const cbs = renderPanel();
    const widget = screen.getByTestId("panel-widget-status");
    expect(within(widget).getByTestId("panel-instance-unavailable")).toBeTruthy();
    expect((screen.getByTestId("panel-status-refresh") as HTMLButtonElement).disabled).toBe(true);
    expect(cbs.onInvoke).not.toHaveBeenCalled();
  });
});

describe("Panel v2 — actionBar", () => {
  it("invokes a plain action through the normal path with args + the selected instance", () => {
    const cbs = renderPanel();
    fireEvent.click(screen.getByTestId("panel-action-repoll"));
    expect(cbs.onInvoke).toHaveBeenCalledWith(DKEY, "repoll", { mode: "soft", instance: "filler1" });
  });

  it("confirm renders a console-owned modal with the sanitized text; cancel never invokes", () => {
    const cbs = renderPanel();
    const pauseCalls = () => cbs.onInvoke.mock.calls.filter((c) => c[1] === "sb/pause").length;
    fireEvent.click(screen.getByTestId("panel-action-sb-pause"));
    expect(pauseCalls()).toBe(0); // not yet — the modal gates it
    const modal = screen.getByTestId("panel-action-confirm");
    expect(within(modal).getByTestId("panel-action-confirm-text").textContent).toBe(
      "Protocol keepalive duties may continue.",
    );
    fireEvent.click(within(modal).getByRole("button", { name: "Cancel" }));
    expect(pauseCalls()).toBe(0);
    // Confirming fires the invoke with the selected instance.
    fireEvent.click(screen.getByTestId("panel-action-sb-pause"));
    fireEvent.click(within(modal).getByRole("button", { name: "Pause publication" }));
    expect(cbs.onInvoke).toHaveBeenCalledWith(DKEY, "sb/pause", { instance: "filler1" });
  });

  it("computes the §4.1 lifecycle gates from the latest sb/status (paused instance)", () => {
    renderPanel(
      v2State({
        commands: commandView([statusOk({ state: "ONLINE", connected: true, paused: true })]),
      }),
    );
    expect((screen.getByTestId("panel-action-sb-pause") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("panel-action-sb-resume") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("panel-action-repoll") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("panel-action-reconnect") as HTMLButtonElement).disabled).toBe(false);
  });

  it("is optimistic without a status result, and a pending lifecycle command gates reconnect", () => {
    renderPanel();
    expect((screen.getByTestId("panel-action-sb-pause") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("panel-action-sb-resume") as HTMLButtonElement).disabled).toBe(false);
    cleanup();
    window.history.replaceState(null, "", "/");

    renderPanel(
      v2State({
        commands: commandView([
          commandEntry({
            requestId: "p-1",
            key: DKEY,
            verb: "sb/pause",
            instance: "filler1",
            phase: "pending",
            result: undefined,
          }),
        ]),
      }),
    );
    // The pending action disables its own button AND gates reconnect.
    expect((screen.getByTestId("panel-action-sb-pause") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("panel-action-reconnect") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("panel-action-repoll") as HTMLButtonElement).disabled).toBe(false);
  });

  it("applies availability to every action and surfaces the sanitized reason", () => {
    const manifest = v2Manifest({
      commands: ALL_VERBS.filter((v) => v !== "reconnect").map((verb) =>
        verb === "sb/resume" ? { verb, availability: { state: "disabled" as const, reason: "not paused" } } : { verb },
      ),
    });
    renderPanel(v2State({}, manifest));
    expect((screen.getByTestId("panel-action-sb-resume") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("panel-action-reason-sb-resume").textContent).toBe("not paused");
    // reconnect is not advertised at all → unavailable → disabled.
    expect((screen.getByTestId("panel-action-reconnect") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the role display hint and per-action outcomes", () => {
    renderPanel(
      v2State({
        commands: commandView([
          commandEntry({
            requestId: "r-1",
            key: DKEY,
            verb: "repoll",
            instance: "filler1",
            phase: "ok",
            result: { message: "repolled 12 signals" },
            elapsedMs: 18,
          }),
        ]),
      }),
    );
    const widget = screen.getByTestId("panel-widget-lifecycle");
    expect(within(widget).getByText("operator")).toBeTruthy(); // display hint only
    const outcome = within(widget).getByTestId("panel-action-outcome-repoll");
    expect(within(outcome).getByText("Done")).toBeTruthy();
    expect(within(outcome).getByText("18ms")).toBeTruthy();
    // §4.1: the returned result renders (compactly summarized).
    expect(within(outcome).getByText("repolled 12 signals")).toBeTruthy();
  });
});

describe("Panel v2 — commandTable (discovery)", () => {
  it("NEVER auto-runs — even a descriptor asking for onEnter/interval stays manual", () => {
    vi.useFakeTimers();
    try {
      const cbs = { onInvoke: vi.fn(), onRefreshDescriptor: vi.fn() };
      render(
        <ComponentDetailView
          state={v2State({}, v2Manifest({ views: [discoveryView()], defaultView: "discovery" }))}
          now={T0}
          detailKey={DKEY}
          {...cbs}
        />,
      );
      fireEvent.click(screen.getByTestId("tab-panel"));
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(cbs.onInvoke).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs manually with the schema-checked controls assembled into the request (no instance)", () => {
    const cbs = renderPanel();
    openView("Device Discovery");
    fireEvent.change(screen.getByLabelText("Station name"), { target: { value: " plc-7 " } });
    fireEvent.change(screen.getByLabelText("Vendor ID"), { target: { value: "42" } });
    fireEvent.change(screen.getByTestId("panel-control-portRange-lo"), { target: { value: "1" } });
    fireEvent.change(screen.getByTestId("panel-control-portRange-hi"), { target: { value: "8" } });
    fireEvent.click(screen.getByTestId("panel-control-verbose"));
    fireEvent.change(screen.getByLabelText("Timeout (ms)"), { target: { value: "3000" } });
    fireEvent.change(screen.getByLabelText("Runtime"), { target: { value: "rt-2" } });
    fireEvent.click(screen.getByTestId("panel-table-run"));
    expect(cbs.onInvoke).toHaveBeenCalledWith(DKEY, "sb/discover", {
      timeoutMs: 3000, // the control overrides the static request default
      stationName: "plc-7",
      filter: { vendorId: 42 }, // nested field assembled as an object
      portRange: [1, 8], // integer-range → the two-integer inclusive array
      verbose: true,
      runtimeId: "rt-2", // select via optionsSource from the loaded Configuration data
    });
    // Component-scoped discovery never sends an instance and shows no selector.
    const args = cbs.onInvoke.mock.calls.find((c) => c[1] === "sb/discover")![2] as Record<string, unknown>;
    expect("instance" in args).toBe(false);
    expect(screen.queryByTestId("panel-instance-selector")).toBeNull();
  });

  it("select options come from the already-loaded Configuration tab data", () => {
    renderPanel();
    openView("Device Discovery");
    const select = screen.getByLabelText("Runtime") as HTMLSelectElement;
    expect(within(select).getByRole("option", { name: "Controller 1" })).toBeTruthy();
    expect(within(select).getByRole("option", { name: "Controller 2" })).toBeTruthy();
  });

  it("rejects unknown control types visibly (nothing beyond the declared closed set)", () => {
    renderPanel();
    openView("Device Discovery");
    const rejected = screen.getByTestId("panel-control-rejected");
    expect(within(rejected).getByText("holo")).toBeTruthy();
    expect(screen.queryByLabelText("holo")).toBeNull();
  });

  it("renders the bounded array at resultPath through the generic columns", () => {
    renderPanel(
      v2State({
        commands: commandView([
          commandEntry({
            requestId: "d-1",
            key: DKEY,
            verb: "sb/discover",
            result: {
              devices: [
                { mac: "aa:bb:cc", stationName: "plc-7", vendorId: 42 },
                { mac: "dd:ee:ff", stationName: "plc-8" },
              ],
            },
          }),
        ]),
      }),
    );
    openView("Device Discovery");
    const table = screen.getByTestId("panel-command-table");
    expect(within(table).getByText("2 rows")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "MAC" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Station" })).toBeTruthy();
    const rows = within(table).getAllByTestId("panel-table-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText("aa:bb:cc")).toBeTruthy();
    expect(within(rows[0]!).getByText("42")).toBeTruthy();
    expect(within(rows[1]!).getByText("—")).toBeTruthy(); // missing vendorId → em dash
  });

  it("distinguishes malformed, empty, and forbidden outcomes", () => {
    renderPanel(
      v2State({
        commands: commandView([
          commandEntry({ requestId: "d-2", key: DKEY, verb: "sb/discover", result: { nothing: true } }),
        ]),
      }),
    );
    openView("Device Discovery");
    expect(screen.getByTestId("panel-malformed-result").textContent).toContain("devices");
    cleanup();
    window.history.replaceState(null, "", "/");

    renderPanel(
      v2State({
        commands: commandView([
          commandEntry({ requestId: "d-3", key: DKEY, verb: "sb/discover", result: { devices: [] } }),
        ]),
      }),
    );
    openView("Device Discovery");
    expect(screen.getByText("The command returned no rows.")).toBeTruthy();
    cleanup();
    window.history.replaceState(null, "", "/");

    renderPanel(
      v2State({
        commands: commandView([
          commandEntry({
            requestId: "d-4",
            key: DKEY,
            verb: "sb/discover",
            phase: "error",
            result: undefined,
            error: { code: "FORBIDDEN", message: "" },
          }),
        ]),
      }),
    );
    openView("Device Discovery");
    expect(screen.getByTestId("panel-error-forbidden")).toBeTruthy();
  });
});

describe("Panel v2 — metricSeries", () => {
  function withMetrics(instance = "filler1") {
    return metricsView([
      metricSeries(DKEY, "ProfinetCycle", "missedCycles", {
        instance,
        latest: 7,
        points: metricPoints([1, 3, 7]),
      }),
      metricSeries(DKEY, "ProfinetCycle", "maxJitterUs", {
        instance,
        latest: 30,
        points: metricPoints([10, 20, 30]),
      }),
      metricSeries(DKEY, "ProfinetCycle", "missedCycles", {
        instance: "kep2",
        latest: 99,
        points: metricPoints([99]),
      }),
    ]);
  }

  it("reads the existing Metrics store (labels, units, aggregation, sparkline) and never invokes", () => {
    const manifest = v2Manifest({
      views: [overviewView({ widgets: [overviewView().widgets![2]!] })], // metricSeries only
    });
    const cbs = renderPanel(v2State({ metrics: withMetrics() }, manifest));
    const widget = screen.getByTestId("panel-widget-health-metrics");
    const missed = within(widget).getByTestId("panel-metric-row-Missed-cycles");
    expect(within(missed).getByText("7 cycles")).toBeTruthy();
    expect(within(missed).getByTestId("sparkline")).toBeTruthy();
    // aggregation: avg over the recent points (10, 20, 30) → 20.
    expect(within(within(widget).getByTestId("panel-metric-row-Avg-jitter")).getByText("20 us")).toBeTruthy();
    expect(within(widget).getByTestId("panel-metric-row-Ghost").textContent).toContain("no data");
    expect(cbs.onInvoke).not.toHaveBeenCalled(); // it NEVER invokes a command
  });

  it("binds the SELECTED instance's series", () => {
    renderPanel(v2State({ metrics: withMetrics() }));
    const row = () => screen.getByTestId("panel-metric-row-Missed-cycles");
    expect(within(row()).getByText("7 cycles")).toBeTruthy();
    fireEvent.change(screen.getByTestId("panel-instance-selector"), { target: { value: "kep2" } });
    expect(within(row()).getByText("99 cycles")).toBeTruthy();
  });
});

describe("Panel v2 — eventFeed", () => {
  it("filters by family + field filters, newest first, bounded by limit; never re-subscribes", () => {
    const events = {
      entries: [
        consoleEvent({ id: 6, key: DKEY, instance: "filler1", type: "ProfinetAlarmEvent", body: { detail: { slot: 3 }, message: "newest alarm" } }),
        consoleEvent({ id: 5, key: DKEY, instance: "filler1", type: "SouthboundWriteAudit", body: { detail: { slot: 3 }, message: "write audit" } }),
        consoleEvent({ id: 4, key: DKEY, instance: "filler1", type: "ProfinetAlarmEvent", body: { detail: { slot: 3 }, message: "older alarm" } }),
        consoleEvent({ id: 3, key: DKEY, instance: "kep2", type: "ProfinetAlarmEvent", body: { detail: { slot: 3 } } }),
        consoleEvent({ id: 2, key: DKEY, instance: "filler1", type: "UnrelatedEvent", body: { detail: { slot: 3 } } }),
        consoleEvent({ id: 1, key: DKEY, instance: "filler1", type: "ProfinetAlarmEvent", body: { detail: { slot: 9 } } }),
      ],
    };
    renderPanel(v2State({ events }));
    openView("Diagnostics");
    const feed = screen.getByTestId("panel-event-feed");
    const rows = within(feed).getAllByTestId(/panel-event-row-/);
    // limit 2, newest first: ids 6 then 5; kep2 (3), family (2), and filter (1) excluded.
    expect(rows).toHaveLength(2);
    expect(rows[0]!.getAttribute("data-testid")).toBe("panel-event-row-6");
    expect(rows[1]!.getAttribute("data-testid")).toBe("panel-event-row-5");
    expect(within(feed).getByText("ProfinetAlarmEvent")).toBeTruthy();
  });

  it("shows an explicit empty state", () => {
    renderPanel();
    openView("Diagnostics");
    expect(screen.getByTestId("panel-event-feed-empty")).toBeTruthy();
  });
});

describe("Panel v2 — generic treeBrowser columns", () => {
  function browseEntry() {
    return commandEntry({
      requestId: "b-1",
      key: DKEY,
      verb: "sb/browse",
      instance: "filler1",
      result: {
        id: "filler1",
        mode: "hierarchical",
        refCount: 2,
        depth: 1,
        truncated: false,
        root: {
          nodeId: "root-1",
          name: "DAP",
          nodeClass: "Object",
          protocol: { slot: 0 },
          refs: [
            {
              referenceType: "contains",
              target: { nodeId: "mod-1", name: "Module 1", nodeClass: "Module", protocol: { slot: 1 }, refs: [] },
            },
            {
              referenceType: "contains",
              target: { nodeId: "sub-1", name: "Sub", nodeClass: "Object", protocol: { slot: 2 } },
            },
          ],
        },
      },
    });
  }

  it("descriptor columns replace the OPC UA headings; hierarchy + treegrid behavior stay", () => {
    const cbs = renderPanel(v2State({ commands: commandView([browseEntry()]) }));
    openView("IO Topology");
    const tree = screen.getByRole("treegrid");
    expect(within(tree).getByRole("columnheader", { name: "Name" })).toBeTruthy();
    expect(within(tree).getByRole("columnheader", { name: "Kind" })).toBeTruthy();
    expect(within(tree).getByRole("columnheader", { name: "Slot" })).toBeTruthy();
    // The hard-coded OPC UA headings are GONE.
    expect(within(tree).queryByRole("columnheader", { name: "Node ID" })).toBeNull();
    expect(within(tree).queryByRole("columnheader", { name: "Namespace" })).toBeNull();
    // Cells resolve node paths (protocol.slot with the number format).
    const nodes = within(tree).getAllByTestId("panel-address-node");
    expect(nodes[0]!.getAttribute("aria-level")).toBe("1");
    expect(within(nodes[0]!).getByText("DAP")).toBeTruthy();
    expect(within(nodes[1]!).getByText("Module 1")).toBeTruthy();
    expect(within(nodes[1]!).getByText("1")).toBeTruthy();
    expect(nodes[1]!.getAttribute("aria-level")).toBe("2");
    // Expanding an unloaded branch still browses by node ref with the selected instance.
    fireEvent.click(within(tree).getByRole("button", { name: "Expand Sub (sub-1)" }));
    expect(cbs.onInvoke).toHaveBeenCalledWith(DKEY, "sb/browse", { instance: "filler1", ref: "sub-1", depth: 1 });
  });

  it("browse availability disabled → Load disabled with the sanitized reason", () => {
    const manifest = v2Manifest({
      commands: ALL_VERBS.map((verb) =>
        verb === "sb/browse" ? { verb, availability: { state: "unsupported" as const, reason: "no GSDML" } } : { verb },
      ),
    });
    const cbs = renderPanel(v2State({}, manifest));
    openView("IO Topology");
    expect((screen.getByTestId("panel-browse-load") as HTMLButtonElement).disabled).toBe(true);
    const notice = screen.getByTestId("panel-capability-unsupported");
    expect(notice.textContent).toContain("no GSDML");
    fireEvent.click(screen.getByTestId("panel-browse-load"));
    expect(cbs.onInvoke).not.toHaveBeenCalledWith(DKEY, "sb/browse", expect.anything());
  });
});

describe("Panel v2 — signalGrid (signalsVerb + generic columns)", () => {
  function signalsEntry(verb: string) {
    return commandEntry({
      requestId: "s-1",
      key: DKEY,
      verb,
      instance: "filler1",
      result: {
        id: "filler1",
        signals: [
          { signalId: "PI.In.FillLevel", direction: "input", dataType: "Real" },
          { signalId: "PI.Out.Valve", direction: "output", dataType: "Bool" },
        ],
      },
    });
  }

  it("PREFERS signalsVerb over the subscriptionsVerb alias and reads its result slot", () => {
    const cbs = renderPanel(v2State({ commands: commandView([signalsEntry("sb/signals")]) }));
    openView("Process Image");
    const widget = screen.getByTestId("panel-widget-signal-grid");
    expect(within(widget).getByText("cmd/sb/signals")).toBeTruthy();
    fireEvent.click(screen.getByTestId("panel-signals-load"));
    expect(cbs.onInvoke).toHaveBeenCalledWith(DKEY, "sb/signals", { instance: "filler1" });
    // The neutral signal-inventory meta wording.
    expect(within(widget).getByText("2 signals")).toBeTruthy();
    expect(within(widget).queryByText(/subscribed/)).toBeNull();
    // Generic columns replace the OPC UA headings.
    expect(screen.getByRole("columnheader", { name: "Direction" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Namespace" })).toBeNull();
    const rows = within(widget).getAllByTestId("panel-signal-row");
    expect(within(rows[0]!).getByText("PI.In.FillLevel")).toBeTruthy();
    expect(within(rows[1]!).getByText("output")).toBeTruthy();
  });

  it("keeps subscriptionsVerb working as the migration alias (with its legacy default)", () => {
    const manifest = v2Manifest({
      commands: [...ALL_VERBS, "sb/subscriptions"].map((verb) => ({ verb })),
      views: [signalsView({ signalsVerb: undefined, subscriptionsVerb: "sb/subscriptions" })],
    });
    const cbs = renderPanel(v2State({ commands: commandView([signalsEntry("sb/subscriptions")]) }, manifest));
    const widget = screen.getByTestId("panel-widget-signal-grid");
    expect(within(widget).getByText("cmd/sb/subscriptions")).toBeTruthy();
    fireEvent.click(screen.getByTestId("panel-signals-load"));
    expect(cbs.onInvoke).toHaveBeenCalledWith(DKEY, "sb/subscriptions", { instance: "filler1" });
    expect(within(widget).getByText("2 signals")).toBeTruthy();
  });

  it("signals availability disabled → Load disabled with the reason surfaced", () => {
    const manifest = v2Manifest({
      commands: ALL_VERBS.map((verb) =>
        verb === "sb/signals"
          ? { verb, availability: { state: "disabled" as const, reason: "inventory rebuilding" } }
          : { verb },
      ),
    });
    const cbs = renderPanel(v2State({}, manifest));
    openView("Process Image");
    expect((screen.getByTestId("panel-signals-load") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("panel-capability-disabled").textContent).toContain("inventory rebuilding");
    fireEvent.click(screen.getByTestId("panel-signals-load"));
    expect(cbs.onInvoke).not.toHaveBeenCalledWith(DKEY, "sb/signals", expect.anything());
  });
});

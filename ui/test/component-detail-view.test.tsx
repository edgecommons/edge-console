/**
 * The Component Detail screen (R2) — presentational tests: the breadcrumb, the tab set, the
 * real Health / Panel / Instances / Configuration / Events / Logs tabs (built from live data).
 * State in, DOM out, callbacks observed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentDescribeManifest, ConsoleLogRecord } from "@edgecommons/edge-console-protocol";
import type { ConfigEntryView } from "../src/fleet/config-store";
import { ComponentDetailView } from "../src/components/ComponentDetailView";
import {
  T0,
  alarmSnapshot,
  attributesView,
  clientState,
  compView,
  commandEntry,
  commandView,
  consoleAlarm,
  consoleEvent,
  deviceView,
  fleetView,
  hier,
  key,
  logsView,
  metricSeries,
  metricsView,
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

function opcuaManifest(): ComponentDescribeManifest {
  return {
    schema: "edgecommons.component.describe.v1",
    component: { component: "opcua-adapter", implementation: "Java", version: "0.1.0" },
    digest: "sha256:test",
    commands: [
      { verb: "describe", builtIn: true },
      { verb: "sb/browse", builtIn: false },
      { verb: "sb/read", builtIn: false },
      { verb: "sb/status", builtIn: false },
      { verb: "sb/subscriptions", builtIn: false },
    ],
    panels: {
      schema: "edgecommons.panels.v2",
      provider: "opcua-adapter",
      renderer: "descriptor",
      defaultView: "overview",
      views: [
        {
          id: "overview",
          title: "Overview",
          order: 10,
          widgets: [
            {
              kind: "summary",
              id: "opcua-summary",
              title: "OPC UA adapter",
              rows: [
                { label: "Mode", value: "Discovery" },
                { label: "Browse", value: "Hierarchical" },
              ],
            },
            {
              kind: "commandSummary",
              id: "opcua-commands",
              title: "Command bindings",
              verbs: ["sb/status", "sb/browse", "sb/read", "sb/write"],
            },
          ],
        },
        {
          id: "address-space",
          title: "Address Space",
          order: 20,
          widgets: [
            {
              kind: "treeBrowser",
              id: "address-space-tree",
              title: "Address space",
              mode: "hierarchical",
              rootRef: "root",
              browseVerb: "sb/browse",
              readVerb: "sb/read",
              writeVerb: "sb/write",
            },
          ],
        },
        {
          id: "signals",
          title: "Signals",
          order: 30,
          widgets: [
            {
              kind: "signalGrid",
              id: "signal-grid",
              title: "Configured signals",
              subscriptionsVerb: "sb/subscriptions",
            },
          ],
        },
        {
          id: "diagnostics",
          title: "Diagnostics",
          order: 40,
          widgets: [{ kind: "commandSummary", id: "diagnostic-commands", verbs: ["sb/status", "sb/rescan"] }],
        },
      ],
    },
  };
}

function descriptorReady() {
  return {
    key: DKEY,
    id: ID,
    phase: "ready" as const,
    manifest: opcuaManifest(),
    receivedAt: T0 - 1000,
    refreshing: false,
  };
}

function descriptorReadyWithLogLevel() {
  const entry = descriptorReady();
  return {
    ...entry,
    manifest: {
      ...entry.manifest,
      commands: [...(entry.manifest.commands ?? []), { verb: "set-log-level", builtIn: true }],
    },
  };
}

function logRecord(overrides: Partial<ConsoleLogRecord> = {}): ConsoleLogRecord {
  return {
    id: 1,
    key: DKEY,
    instance: "main",
    level: "info",
    logger: "opcua.session",
    message: "adapter ready",
    receivedAt: T0 - 500,
    sourceTimestamp: "2026-07-03T00:00:00.000Z",
    ...overrides,
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
    onRefreshConfig: vi.fn(),
    onRefreshDescriptor: vi.fn(),
    onOpenEvents: vi.fn(),
    onInvoke: vi.fn(),
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

  it("does not fabricate implementation metadata before describe advertises it", () => {
    renderDetail();
    expect(screen.getByText(/implementation pending/i)).toBeTruthy();
    // The mockup's fabricated implementation language / app version are NOT shown.
    expect(screen.queryByText(/v1\.4\.2/)).toBeNull();
  });

  it("uses implementation metadata once describe advertises it", () => {
    renderDetail({ state: detailState({ descriptions: { entriesById: { [ID]: descriptorReady() } } }) });
    expect(screen.getByText("Java · 0.1.0")).toBeTruthy();
  });

  it("keeps configuration in the Configuration tab (no separate review handoff)", () => {
    renderDetail();
    expect(screen.queryByTestId("detail-view-config")).toBeNull();
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
    expect(within(checks).getByText("Operational checks")).toBeTruthy();
    expect(within(checks).getByText("Connected")).toBeTruthy();
    expect(within(checks).getByText("Stale")).toBeTruthy(); // freshness from liveness
    expect(within(checks).queryByText("connectionState")).toBeNull();
    expect(within(checks).queryByText("readErrors")).toBeNull();
    expect(screen.queryByText("computed by console")).toBeNull();
    expect(screen.getByTestId("liveness-state")).toBeTruthy();
    expect(screen.getByTestId("health-connection-state")).toBeTruthy();
  });

  it("Health: Memory mirrors CPU — its own memorySeries sparkline and Live chit (WP-J)", () => {
    renderDetail({
      state: detailState({
        attributes: attributesView([
          runtimeAttrs(DKEY, {
            cpuPercent: 22,
            memoryMb: 210,
            cpuSeries: [18, 20, 22, 21, 24],
            memorySeries: [190, 200, 205, 208, 210],
          }),
        ]),
      }),
    });
    const tiles = screen.getByTestId("health-tiles");
    // Fresh attributes (receivedAt = T0, 5 s interval, now = T0) ⇒ BOTH chits render.
    expect(within(tiles).getByTestId("cpu-live-chit")).toBeTruthy();
    expect(within(tiles).getByTestId("memory-live-chit")).toBeTruthy();
    // Two tile sparklines — CPU and Memory, the same treatment.
    const sparks = within(tiles).getAllByTestId("sparkline");
    expect(sparks).toHaveLength(2);
    expect(sparks[0]!.getAttribute("aria-label")).toContain("cpu trend");
    expect(sparks[1]!.getAttribute("aria-label")).toContain("memory trend");
  });

  it("Health: 'Live' means FRESH — stale attributes keep their values but lose both chits", () => {
    renderDetail({
      state: detailState({
        attributes: attributesView([
          runtimeAttrs(DKEY, {
            cpuPercent: 22,
            memoryMb: 210,
            receivedAt: T0 - 16_000, // beyond 3 × 5 s
          }),
        ]),
      }),
    });
    const tiles = screen.getByTestId("health-tiles");
    expect(within(tiles).getByText("22%")).toBeTruthy(); // the values stay
    expect(within(tiles).getByText("210", { exact: false })).toBeTruthy();
    expect(within(tiles).queryByTestId("cpu-live-chit")).toBeNull(); // the chits do not
    expect(within(tiles).queryByTestId("memory-live-chit")).toBeNull();
  });

  it("Health: fresh attributes render both Live chits (the ever-reported defect is gone)", () => {
    renderDetail(); // the default fixture: receivedAt = T0, expected interval 5 s, now = T0
    const tiles = screen.getByTestId("health-tiles");
    expect(within(tiles).getByTestId("cpu-live-chit")).toBeTruthy();
    expect(within(tiles).getByTestId("memory-live-chit")).toBeTruthy();
  });

  it("Health: aggregates connection state from component instances", () => {
    const state = clientState(
      fleetView([
        deviceView("pack-gw-01", [
          compView({
            key: DKEY,
            instances: [
              { instance: "filler1", connected: true },
              { instance: "kep2", connected: false },
            ],
          }),
        ]),
      ]),
    );
    renderDetail({ state });
    const connection = screen.getByTestId("health-connection-state");
    expect(within(connection).getByText("Partially connected")).toBeTruthy();
    expect(within(connection).getByText("1 of 2 instances connected")).toBeTruthy();
  });

  it("Health: a paused instance is not counted as a connection fault", () => {
    const state = clientState(
      fleetView([
        deviceView("pack-gw-01", [
          compView({
            key: DKEY,
            instances: [
              { instance: "filler1", connected: true, state: "ONLINE" },
              { instance: "kep2", connected: false, state: "PAUSED" },
            ],
          }),
        ]),
      ]),
    );
    renderDetail({ state });
    const connection = screen.getByTestId("health-connection-state");
    expect(within(connection).getByText("Connected")).toBeTruthy();
    expect(within(connection).getByText("1 of 1 instance connected, 1 paused")).toBeTruthy();
  });

  it("Instances: renders the keepalive state vocabulary, marking PAUSED as expected quiet", () => {
    const state = clientState(
      fleetView([
        deviceView("pack-gw-01", [
          compView({
            key: DKEY,
            instances: [
              { instance: "filler1", connected: true, state: "ONLINE" },
              { instance: "kep2", connected: false, state: "CONNECTING" },
              { instance: "kep3", connected: false, state: "BACKOFF", detail: "retry in 4s" },
              { instance: "kep4", connected: false, state: "PAUSED" },
              // Unknown token ⇒ today's connectivity-only rendering, never a crash.
              { instance: "kep5", connected: true, state: "HIBERNATING" },
            ],
          }),
        ]),
      ]),
    );
    renderDetail({ state });
    fireEvent.click(screen.getByTestId("tab-instances"));
    const list = screen.getByTestId("instances-list");
    expect(within(within(list).getByTestId("instance-filler1")).getByText("online")).toBeTruthy();
    expect(within(within(list).getByTestId("instance-kep2")).getByText("connecting")).toBeTruthy();
    expect(within(within(list).getByTestId("instance-kep3")).getByText("backoff")).toBeTruthy();
    expect(within(within(list).getByTestId("instance-kep3")).getByText("retry in 4s")).toBeTruthy();
    expect(within(within(list).getByTestId("instance-kep4")).getByText("paused")).toBeTruthy();
    expect(within(list).getByTestId("instance-quiet-kep4")).toBeTruthy();
    expect(within(within(list).getByTestId("instance-kep5")).getByText("connected")).toBeTruthy();
    // Only the paused instance carries the expected-quiet note.
    expect(within(list).queryByTestId("instance-quiet-kep3")).toBeNull();
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

  it("Configuration: embeds the full structured/raw effective-config inspector", () => {
    const cbs = renderDetail();
    fireEvent.click(screen.getByTestId("tab-config"));
    const tree = screen.getByTestId("config-tree");
    expect(within(tree).getByTestId("config-node-heartbeat")).toBeTruthy();
    expect(within(tree).getByTestId("config-node-endpoint.url")).toBeTruthy();
    expect(within(tree).getByText("opc.tcp://x:49320")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Raw JSON" }));
    expect(screen.getByTestId("config-json").textContent).toContain('"url": "opc.tcp://x:49320"');

    fireEvent.click(screen.getByTestId("refresh-config"));
    expect(cbs.onRefreshConfig).toHaveBeenCalledWith(DKEY);
    expect(screen.queryByTestId("view-full-config")).toBeNull();
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

  it("Metrics: shows custom non-system metrics for this component", () => {
    renderDetail({
      state: detailState({
        metrics: metricsView([
          metricSeries(DKEY, "packaging.throughput", "bottlesPerMin", { latest: 142.25 }),
          metricSeries(DKEY, "sys", "cpu_usage", { latest: 22 }),
          metricSeries(DKEY, "southbound_health", "readErrors", { latest: 0 }),
          metricSeries(key("pack-gw-01", "modbus-adapter"), "packaging.throughput", "bottlesPerMin", { latest: 50 }),
        ]),
      }),
    });
    fireEvent.click(screen.getByTestId("tab-metrics"));
    const table = screen.getByTestId("metrics-table");
    expect(within(table).getByText("packaging.throughput")).toBeTruthy();
    expect(within(table).getByText("bottlesPerMin")).toBeTruthy();
    expect(within(table).getByText("142.25")).toBeTruthy();
    expect(within(table).getByText("southbound_health")).toBeTruthy();
    expect(within(table).getByText("readErrors")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Metrics · 2" })).toBeTruthy();
    expect(within(table).queryByText("sys")).toBeNull();
    expect(within(table).queryByText("50")).toBeNull();
  });
});

describe("ComponentDetailView — descriptor-driven panel + pending surfaces", () => {
  it("Panel: shows a loading state while cmd/describe is in flight", () => {
    renderDetail();
    fireEvent.click(screen.getByTestId("tab-panel"));
    expect(screen.getByTestId("descriptor-loading")).toBeTruthy();
    expect(screen.queryByText(/Available in Phase 2/i)).toBeNull();
  });

  it("Panel: renders descriptor views and invokes only advertised command bindings", () => {
    const cbs = renderDetail({
      state: detailState({ descriptions: { entriesById: { [ID]: descriptorReady() } } }),
    });
    fireEvent.click(screen.getByTestId("tab-panel"));
    const panel = screen.getByTestId("descriptor-panel");
    expect(screen.getByRole("tab", { name: "Panel · 4 views" })).toBeTruthy();
    expect(within(panel).getByText("Overview")).toBeTruthy();
    expect(within(panel).getByText("Address Space")).toBeTruthy();
    expect(within(panel).getByText("Signals")).toBeTruthy();
    expect(within(panel).getByText("Diagnostics")).toBeTruthy();

    const overview = screen.getByTestId("panel-view-overview");
    expect(within(overview).getByText("cmd/sb/browse")).toBeTruthy();
    expect(within(overview).getByText("cmd/sb/write")).toBeTruthy();
    expect(within(overview).getAllByText("Unavailable").length).toBeGreaterThan(0);

    fireEvent.click(within(panel).getByRole("tab", { name: "Address Space" }));
    fireEvent.click(screen.getByTestId("panel-browse-load"));
    expect(cbs.onInvoke).toHaveBeenCalledWith(DKEY, "sb/browse", { ref: "root", depth: 1 });
    expect(screen.getByText("Read enabled")).toBeTruthy();
    expect(screen.getByText("Write unavailable")).toBeTruthy();
  });

  it("Panel: renders treeBrowser browse results as a tree instead of raw JSON", () => {
    renderDetail({
      state: detailState({
        descriptions: { entriesById: { [ID]: descriptorReady() } },
        commands: commandView([
          commandEntry({
            requestId: "browse-1",
            key: DKEY,
            verb: "sb/browse",
            result: {
              id: "filler1",
              mode: "hierarchical",
              ref: "ns=0;i=84",
              depth: 1,
              maxRefs: 500,
              refCount: 1,
              truncated: true,
              root: {
                nodeId: "ns=0;i=84",
                signalId: "84",
                namespace: 0,
                idType: "Numeric",
                name: "Root",
                nodeClass: "Object",
                refs: [
                  {
                    referenceType: "Organizes",
                    referenceTypeId: "ns=0;i=35",
                    targetNodeId: "ns=2;s=Line1.FillLevel",
                    target: {
                      nodeId: "ns=2;s=Line1.FillLevel",
                      signalId: "Line1.FillLevel",
                      namespace: 2,
                      namespaceUri: "urn:kepware:packaging",
                      idType: "String",
                      name: "Fill Level",
                      browseName: "FillLevel",
                      nodeClass: "Variable",
                      dataType: "Double",
                      refs: [],
                    },
                  },
                ],
              },
            },
          }),
        ]),
      }),
    });
    fireEvent.click(screen.getByTestId("tab-panel"));
    fireEvent.click(within(screen.getByTestId("descriptor-panel")).getByRole("tab", { name: "Address Space" }));

    const tree = screen.getByTestId("panel-address-tree");
    expect(within(tree).getByText("Instance")).toBeTruthy();
    expect(within(tree).getByText("filler1")).toBeTruthy();
    expect(within(tree).getByText("1 hierarchical refs loaded")).toBeTruthy();
    expect(within(tree).getByText("Depth 1")).toBeTruthy();
    expect(within(tree).getByText("More available")).toBeTruthy();
    expect(within(tree).getByText("Root")).toBeTruthy();
    expect(within(tree).getByText("Fill Level")).toBeTruthy();
    expect(within(tree).getByText("ns=2;s=Line1.FillLevel")).toBeTruthy();
    expect(within(tree).getByText("Organizes")).toBeTruthy();
    expect(screen.queryByTestId("panel-command-result")).toBeNull();
  });

  it("Panel: expands address-space branches by browsing the selected node ref", () => {
    const cbs = {
      onBack: vi.fn(),
      onOpenOverview: vi.fn(),
      onRefreshConfig: vi.fn(),
      onRefreshDescriptor: vi.fn(),
      onOpenEvents: vi.fn(),
      onInvoke: vi.fn(),
    };
    const rootEntry = commandEntry({
      requestId: "browse-root",
      seq: 1,
      key: DKEY,
      verb: "sb/browse",
      result: {
        id: "filler1",
        mode: "hierarchical",
        ref: "ns=0;i=84",
        depth: 1,
        refCount: 1,
        truncated: false,
        root: {
          nodeId: "ns=0;i=84",
          namespace: 0,
          name: "Root",
          nodeClass: "Object",
          refs: [
            {
              referenceType: "Organizes",
              targetNodeId: "ns=0;i=85",
              target: {
                nodeId: "ns=0;i=85",
                namespace: 0,
                name: "Objects",
                nodeClass: "Object",
              },
            },
          ],
        },
      },
    });
    const { rerender } = render(
      <ComponentDetailView
        state={detailState({
          descriptions: { entriesById: { [ID]: descriptorReady() } },
          commands: commandView([rootEntry]),
        })}
        now={T0}
        detailKey={DKEY}
        {...cbs}
      />,
    );

    fireEvent.click(screen.getByTestId("tab-panel"));
    fireEvent.click(within(screen.getByTestId("descriptor-panel")).getByRole("tab", { name: "Address Space" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand Objects (ns=0;i=85)" }));
    expect(cbs.onInvoke).toHaveBeenCalledWith(DKEY, "sb/browse", { ref: "ns=0;i=85", depth: 1 });
    expect(screen.getByTestId("panel-tree-status").textContent).toContain("Loading Objects...");
    expect(screen.getByTestId("panel-tree-status").parentElement?.className).toContain("ec-panel-result-meta--address-tree");
    expect(screen.getByTestId("panel-tree-status").querySelector(".ec-panel-tree-status__loading")).not.toBeNull();
    expect(document.querySelector(".ec-panel-tree__row--note")).toBeNull();

    rerender(
      <ComponentDetailView
        state={detailState({
          descriptions: { entriesById: { [ID]: descriptorReady() } },
          commands: commandView([
            rootEntry,
            commandEntry({
              requestId: "browse-objects",
              seq: 2,
              key: DKEY,
              verb: "sb/browse",
              result: {
                id: "filler1",
                mode: "hierarchical",
                ref: "ns=0;i=85",
                depth: 1,
                refCount: 1,
                truncated: false,
                root: {
                  nodeId: "ns=0;i=85",
                  namespace: 0,
                  name: "Objects",
                  nodeClass: "Object",
                  refs: [
                    {
                      referenceType: "Organizes",
                      targetNodeId: "ns=2;s=Line1.DeviceSet",
                      target: {
                        nodeId: "ns=2;s=Line1.DeviceSet",
                        namespace: 2,
                        name: "Device Set",
                        nodeClass: "Object",
                      },
                    },
                  ],
                },
              },
            }),
          ]),
        })}
        now={T0}
        detailKey={DKEY}
        {...cbs}
      />,
    );

    const tree = screen.getByTestId("panel-address-tree");
    expect(within(tree).getByText("Root")).toBeTruthy();
    expect(within(tree).getByText("Objects")).toBeTruthy();
    expect(within(tree).getByText("Device Set")).toBeTruthy();
    expect(within(tree).getByText("ns=2;s=Line1.DeviceSet")).toBeTruthy();
  });

  it("Panel: renders signalGrid subscriptions as a table instead of raw JSON", () => {
    renderDetail({
      state: detailState({
        descriptions: { entriesById: { [ID]: descriptorReady() } },
        commands: commandView([
          commandEntry({
            requestId: "subscriptions-1",
            key: DKEY,
            verb: "sb/subscriptions",
            result: {
              id: "filler1",
              signals: [
                {
                  signalId: "ns=2;s=Line1.FillLevel",
                  namespace: 2,
                  namespaceUri: "urn:kepware:packaging",
                  idType: "String",
                  match: "exact",
                },
              ],
            },
          }),
        ]),
      }),
    });
    fireEvent.click(screen.getByTestId("tab-panel"));
    fireEvent.click(within(screen.getByTestId("descriptor-panel")).getByRole("tab", { name: "Signals" }));

    const grid = screen.getByTestId("panel-signal-grid");
    expect(within(grid).getByText("Instance")).toBeTruthy();
    expect(within(grid).getByText("filler1")).toBeTruthy();
    // The signal-inventory-neutral meta wording ("N signals", not "subscribed signals").
    expect(within(grid).getByText("1 signal")).toBeTruthy();
    expect(within(grid).queryByText(/subscribed/)).toBeNull();
    expect(within(grid).getByText("Signal")).toBeTruthy();
    expect(within(grid).getByText("ns=2;s=Line1.FillLevel")).toBeTruthy();
    expect(within(grid).getByText("ns=2")).toBeTruthy();
    expect(within(grid).getByText("String")).toBeTruthy();
    expect(within(grid).getByText("exact")).toBeTruthy();
    expect(screen.queryByTestId("panel-command-result")).toBeNull();
  });

  it("Panel: shows descriptor-unavailable with an explicit refresh action", () => {
    const cbs = renderDetail({
      state: detailState({
        descriptions: {
          entriesById: {
            [ID]: {
              key: DKEY,
              id: ID,
              phase: "unavailable",
              code: "UNAVAILABLE",
              reason: "the console command gateway is not configured",
              refreshing: false,
            },
          },
        },
      }),
    });
    fireEvent.click(screen.getByTestId("tab-panel"));
    expect(screen.getByTestId("descriptor-unavailable")).toBeTruthy();
    expect(screen.getByText(/UNAVAILABLE/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reload panel" }));
    expect(cbs.onRefreshDescriptor).toHaveBeenCalledWith(DKEY);
  });

  it("Logs: renders retained records with filters and a descriptor-gated runtime level action", () => {
    const cbs = renderDetail({
      state: detailState({
        logs: logsView({
          [ID]: {
            key: DKEY,
            records: [
              logRecord({
                id: 2,
                level: "error",
                logger: "opcua.browse",
                message: "browse failed",
                receivedAt: T0 - 100,
                sequence: 42,
                thread: "worker-1",
                fields: { endpoint: "opc.tcp://kep:49320" },
                error: { type: "TimeoutError", message: "browse timed out" },
                truncated: true,
              }),
              logRecord({ id: 1, level: "info", message: "adapter ready", receivedAt: T0 - 500 }),
            ],
            dropped: 3,
          },
        }),
      }),
    });
    const hiddenLogsPanel = screen.getByTestId("logs-tab").closest('[role="tabpanel"]');
    expect(hiddenLogsPanel?.hasAttribute("hidden")).toBe(true);

    fireEvent.click(screen.getByTestId("tab-logs"));
    const logs = screen.getByTestId("logs-tab");
    expect(logs.closest('[role="tabpanel"]')?.hasAttribute("hidden")).toBe(false);
    expect(screen.getByRole("tab", { name: "Logs · 2" })).toBeTruthy();
    expect(within(logs).getByText("browse failed")).toBeTruthy();
    expect(within(logs).getByText("adapter ready")).toBeTruthy();
    const rows = within(screen.getByTestId("logs-tail")).getAllByTestId("logs-row");
    expect(within(rows[0]!).getByText("browse failed")).toBeTruthy();
    expect(within(rows[1]!).getByText("adapter ready")).toBeTruthy();
    expect(within(logs).getByText("3 dropped")).toBeTruthy();
    expect((screen.getByTestId("logs-apply-level") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("logs-apply-level"));
    expect(cbs.onInvoke).not.toHaveBeenCalledWith(DKEY, "set-log-level", expect.anything());

    fireEvent.change(screen.getByTestId("logs-text-filter"), { target: { value: "ready" } });
    expect(within(logs).getByText("adapter ready")).toBeTruthy();
    expect(within(logs).queryByText("browse failed")).toBeNull();

    fireEvent.change(screen.getByTestId("logs-text-filter"), { target: { value: "" } });
    fireEvent.change(screen.getByTestId("logs-level-filter"), { target: { value: "error" } });
    expect(within(logs).getByText("browse failed")).toBeTruthy();
    expect(within(logs).queryByText("adapter ready")).toBeNull();

    fireEvent.click(screen.getByTestId("logs-clear"));
    expect(screen.getByTestId("logs-filter-empty")).toBeTruthy();
  });

  it("Logs: invokes set-log-level only when the descriptor advertises it", () => {
    const cbs = renderDetail({
      state: detailState({
        descriptions: { entriesById: { [ID]: descriptorReadyWithLogLevel() } },
        logs: logsView({ [ID]: { key: DKEY, records: [logRecord()] } }),
      }),
    });
    fireEvent.click(screen.getByTestId("tab-logs"));
    expect((screen.getByTestId("logs-apply-level") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByTestId("logs-runtime-level"), { target: { value: "debug" } });
    fireEvent.click(screen.getByTestId("logs-apply-level"));
    expect(cbs.onInvoke).toHaveBeenCalledWith(DKEY, "set-log-level", {
      level: "DEBUG",
      ttlSecs: 300,
      publish: true,
    });
  });

  it("Logs: resets local filters and clear state when switching components", () => {
    const otherKey = key("pack-gw-01", "modbus-adapter");
    const otherId = "pack-gw-01/modbus-adapter";
    const state = clientState(
      fleetView([
        deviceView("pack-gw-01", [
          compView({
            key: DKEY,
            hier: hier(["site", "dallas"], ["line", "packaging"], ["device", "pack-gw-01"]),
          }),
          compView({
            key: otherKey,
            hier: hier(["site", "dallas"], ["line", "packaging"], ["device", "pack-gw-01"]),
          }),
        ]),
      ]),
      {
        logs: logsView({
          [ID]: { key: DKEY, records: [logRecord({ id: 500, message: "opcua noisy" })] },
          [otherId]: {
            key: otherKey,
            records: [
              logRecord({
                id: 20,
                key: otherKey,
                logger: "modbus.connection",
                message: "modbus connected",
              }),
            ],
          },
        }),
      },
    );

    const props = {
      state,
      now: T0,
      onInvoke: vi.fn(),
    };
    const { rerender } = render(<ComponentDetailView {...props} detailKey={DKEY} />);
    fireEvent.click(screen.getByTestId("tab-logs"));
    fireEvent.click(screen.getByTestId("logs-clear"));
    expect(screen.getByTestId("logs-filter-empty")).toBeTruthy();

    rerender(<ComponentDetailView {...props} detailKey={otherKey} />);
    fireEvent.click(screen.getByTestId("tab-logs"));
    expect(screen.getByText("modbus connected")).toBeTruthy();
  });

  it("Logs: shows an unavailable state from the gateway", () => {
    renderDetail({
      state: detailState({
        logs: logsView({
          [ID]: {
            key: DKEY,
            records: [],
            unavailable: { code: "UNAVAILABLE", reason: "the console log store is not configured" },
          },
        }),
      }),
    });
    fireEvent.click(screen.getByTestId("tab-logs"));
    expect(screen.getByTestId("logs-unavailable")).toBeTruthy();
    expect(screen.getByText("the console log store is not configured")).toBeTruthy();
  });
});

/** A manifest whose browse/signal views are instance-scoped (the §3.1 selector cases). */
function scopedManifest(): ComponentDescribeManifest {
  return {
    schema: "edgecommons.component.describe.v1",
    component: { component: "opcua-adapter", implementation: "Java", version: "0.1.0" },
    digest: "sha256:test-scoped",
    commands: [
      { verb: "describe", builtIn: true },
      { verb: "sb/browse", builtIn: false },
      { verb: "sb/subscriptions", builtIn: false },
    ],
    panels: {
      schema: "edgecommons.panels.v2",
      provider: "opcua-adapter",
      renderer: "descriptor",
      defaultView: "address-space",
      views: [
        {
          id: "overview",
          title: "Overview",
          order: 10,
          widgets: [{ kind: "summary", id: "sum", title: "Summary", rows: [{ label: "Mode", value: "Discovery" }] }],
        },
        {
          id: "address-space",
          title: "Address Space",
          order: 20,
          scope: "instance",
          widgets: [
            {
              kind: "treeBrowser",
              id: "tree",
              title: "Address space",
              scope: "instance",
              mode: "hierarchical",
              rootRef: "root",
              browseVerb: "sb/browse",
            },
          ],
        },
        {
          id: "signals",
          title: "Signals",
          order: 30,
          widgets: [
            {
              kind: "signalGrid",
              id: "grid",
              title: "Signals",
              scope: "instance",
              subscriptionsVerb: "sb/subscriptions",
            },
          ],
        },
      ],
    },
  };
}

function scopedDescriptorReady() {
  return {
    key: DKEY,
    id: ID,
    phase: "ready" as const,
    manifest: scopedManifest(),
    receivedAt: T0 - 1000,
    refreshing: false,
  };
}

/** A minimal hierarchical browse result attributable to one instance. */
function browseResult(instance: string, rootName: string) {
  return {
    id: instance,
    mode: "hierarchical",
    refCount: 0,
    depth: 1,
    truncated: false,
    root: { nodeId: `${instance}-root`, name: rootName, nodeClass: "Object", refs: [] },
  };
}

function multiInstanceState(overrides = {}) {
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
      descriptions: { entriesById: { [ID]: scopedDescriptorReady() } },
      ...overrides,
    },
  );
}

describe("ComponentDetailView — the Panel instance selector (§3.1)", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("renders ONE selector for instance-scoped views, defaults to the first configured instance, and sends it", () => {
    const cbs = renderDetail({ state: multiInstanceState() });
    fireEvent.click(screen.getByTestId("tab-panel"));
    // defaultView = address-space, which is instance-scoped.
    const select = screen.getByTestId("panel-instance-selector") as HTMLSelectElement;
    expect(select.value).toBe("filler1");
    expect(within(select).getByRole("option", { name: "filler1" })).toBeTruthy();
    expect(within(select).getByRole("option", { name: "kep2" })).toBeTruthy();
    expect(screen.getAllByTestId("panel-instance-selector")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("panel-browse-load"));
    expect(cbs.onInvoke).toHaveBeenCalledWith(DKEY, "sb/browse", { instance: "filler1", ref: "root", depth: 1 });
  });

  it("changing the selection sends the newly selected instance and persists it in ?instance=", () => {
    const cbs = renderDetail({ state: multiInstanceState() });
    fireEvent.click(screen.getByTestId("tab-panel"));
    const select = screen.getByTestId("panel-instance-selector") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "kep2" } });
    expect(window.location.search).toContain("instance=kep2");
    fireEvent.click(screen.getByTestId("panel-browse-load"));
    expect(cbs.onInvoke).toHaveBeenLastCalledWith(DKEY, "sb/browse", { instance: "kep2", ref: "root", depth: 1 });
  });

  it("widgets read the SELECTED instance's result slot — two instances never cross-talk", () => {
    renderDetail({
      state: multiInstanceState({
        commands: commandView([
          commandEntry({
            requestId: "b1",
            seq: 1,
            key: DKEY,
            verb: "sb/browse",
            instance: "filler1",
            result: browseResult("filler1", "FillerRoot"),
          }),
          commandEntry({
            requestId: "b2",
            seq: 2,
            key: DKEY,
            verb: "sb/browse",
            instance: "kep2",
            result: browseResult("kep2", "KepRoot"),
          }),
        ]),
      }),
    });
    fireEvent.click(screen.getByTestId("tab-panel"));
    // filler1 (the default) shows only its own result...
    let tree = screen.getByTestId("panel-address-tree");
    expect(within(tree).getByText("FillerRoot")).toBeTruthy();
    expect(within(tree).queryByText("KepRoot")).toBeNull();
    // ...and switching instances swaps to kep2's slot.
    fireEvent.change(screen.getByTestId("panel-instance-selector"), { target: { value: "kep2" } });
    tree = screen.getByTestId("panel-address-tree");
    expect(within(tree).getByText("KepRoot")).toBeTruthy();
    expect(within(tree).queryByText("FillerRoot")).toBeNull();
  });

  it("switching instances resets per-widget state — an instance without results starts empty", () => {
    renderDetail({
      state: multiInstanceState({
        commands: commandView([
          commandEntry({
            requestId: "b1",
            seq: 1,
            key: DKEY,
            verb: "sb/browse",
            instance: "filler1",
            result: browseResult("filler1", "FillerRoot"),
          }),
        ]),
      }),
    });
    fireEvent.click(screen.getByTestId("tab-panel"));
    expect(within(screen.getByTestId("panel-address-tree")).getByText("FillerRoot")).toBeTruthy();
    fireEvent.change(screen.getByTestId("panel-instance-selector"), { target: { value: "kep2" } });
    // kep2 has no recorded result: the remounted widget shows the fresh empty prompt.
    expect(screen.getByText("Load the address-space root to inspect hierarchical refs.")).toBeTruthy();
    expect(screen.queryByText("FillerRoot")).toBeNull();
  });

  it("restores a deep-linked ?instance= selection on mount", () => {
    window.history.replaceState(null, "", "/?instance=kep2");
    const cbs = renderDetail({ state: multiInstanceState() });
    fireEvent.click(screen.getByTestId("tab-panel"));
    expect((screen.getByTestId("panel-instance-selector") as HTMLSelectElement).value).toBe("kep2");
    fireEvent.click(screen.getByTestId("panel-browse-load"));
    expect(cbs.onInvoke).toHaveBeenCalledWith(DKEY, "sb/browse", { instance: "kep2", ref: "root", depth: 1 });
  });

  it("a selected instance that disappeared renders the explicit unavailable state — never a silent fallback", () => {
    window.history.replaceState(null, "", "/?instance=gone");
    const cbs = renderDetail({ state: multiInstanceState() });
    fireEvent.click(screen.getByTestId("tab-panel"));
    const select = screen.getByTestId("panel-instance-selector") as HTMLSelectElement;
    expect(select.value).toBe("gone");
    expect(within(select).getByRole("option", { name: "gone (unavailable)" })).toBeTruthy();
    expect(screen.getByTestId("panel-instance-unavailable")).toBeTruthy();
    const load = screen.getByTestId("panel-browse-load") as HTMLButtonElement;
    expect(load.disabled).toBe(true);
    fireEvent.click(load);
    expect(cbs.onInvoke).not.toHaveBeenCalled();
    // Picking a live instance recovers.
    fireEvent.change(select, { target: { value: "filler1" } });
    expect(screen.queryByTestId("panel-instance-unavailable")).toBeNull();
  });

  it("component-scoped views show no selector", () => {
    renderDetail({ state: multiInstanceState() });
    fireEvent.click(screen.getByTestId("tab-panel"));
    fireEvent.click(within(screen.getByTestId("descriptor-panel")).getByRole("tab", { name: "Overview" }));
    expect(screen.queryByTestId("panel-instance-selector")).toBeNull();
  });

  it("keeps the legacy no-instances behavior: no selector, no instance arg (firstInstanceArg fallback)", () => {
    // The same scoped manifest on a component with no real instances (the `main` sentinel).
    const cbs = renderDetail({
      state: clientState(
        fleetView([deviceView("pack-gw-01", [compView({ key: DKEY })])]),
        { descriptions: { entriesById: { [ID]: scopedDescriptorReady() } } },
      ),
    });
    fireEvent.click(screen.getByTestId("tab-panel"));
    expect(screen.queryByTestId("panel-instance-selector")).toBeNull();
    fireEvent.click(screen.getByTestId("panel-browse-load"));
    expect(cbs.onInvoke).toHaveBeenCalledWith(DKEY, "sb/browse", { ref: "root", depth: 1 });
  });

  it("clears the ?instance= param when the operator leaves the component", () => {
    render(
      <ComponentDetailView
        state={multiInstanceState()}
        now={T0}
        detailKey={DKEY}
        onInvoke={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("tab-panel"));
    fireEvent.change(screen.getByTestId("panel-instance-selector"), { target: { value: "kep2" } });
    expect(window.location.search).toContain("instance=kep2");
    cleanup(); // unmount = leaving the component
    expect(window.location.search).not.toContain("instance=");
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
    expect(screen.getByTestId("config-unavailable")).toBeTruthy();
  });
});

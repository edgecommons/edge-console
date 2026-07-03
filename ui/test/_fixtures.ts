/**
 * Shared UI test fixtures — snapshot/delta/view builders with pinned timestamps
 * (no sleeps; the server-clock base is T0). Mock data lives ONLY here (tests) —
 * the shipped view renders exclusively from the live gateway stream.
 */
import type {
  ComponentKey,
  ComponentSnapshot,
  ConsoleEvent,
  DeviceSnapshot,
  FleetDelta,
  FleetSnapshot,
} from "@edgecommons/edge-console-protocol";
import type { ClientState } from "../src/fleet/client";
import type { CommandEntry, CommandView } from "../src/fleet/command-store";
import type { MetricSeriesView } from "../src/fleet/metric-series-store";
import type { ComponentView, DeviceView, FleetView } from "../src/fleet/store";

/** The pinned server-clock base for all fixtures (ms epoch). */
export const T0 = 1_750_000_000_000;

export function key(device = "gw-01", component = "comp-a", instance = "main"): ComponentKey {
  return { device, component, instance };
}

/** A ComponentSnapshot with sensible defaults (site dallas / device gw-01, FRESH). */
export function compSnap(overrides: Partial<ComponentSnapshot> = {}): ComponentSnapshot {
  const k = overrides.key ?? key();
  return {
    key: k,
    path: `dallas/${k.device}`,
    hier: [
      { level: "site", value: "dallas" },
      { level: "device", value: k.device },
    ],
    liveness: "FRESH",
    status: "RUNNING",
    uptimeSecs: 100,
    lastStateAt: T0,
    expectedIntervalSecs: 5,
    cadenceSource: "default",
    restarts: 0,
    values: [],
    droppedChannels: 0,
    ...overrides,
  };
}

export function deviceSnap(
  device: string,
  components: ComponentSnapshot[],
  overrides: Partial<DeviceSnapshot> = {},
): DeviceSnapshot {
  return { device, unreachable: false, components, ...overrides };
}

export function snapshot(
  devices: DeviceSnapshot[],
  seq = 10,
  takenAt = T0,
): FleetSnapshot {
  return { seq, takenAt, devices };
}

/** A {@link FleetDelta} before its seq is stamped (distributive Omit over the union). */
export type DeltaSeed = FleetDelta extends infer D
  ? D extends FleetDelta
    ? Omit<D, "seq">
    : never
  : never;

/** Stamp a run of deltas with consecutive seqs starting at `firstSeq`. */
export function seqRun(firstSeq: number, seeds: DeltaSeed[]): FleetDelta[] {
  return seeds.map((seed, i) => ({ ...seed, seq: firstSeq + i }) as FleetDelta);
}

/** A ComponentView with defaults (for presentational-component tests). */
export function compView(overrides: Partial<ComponentView> = {}): ComponentView {
  const k = overrides.key ?? key();
  return {
    key: k,
    id: `${k.device}/${k.component}/${k.instance}`,
    path: `dallas/${k.device}`,
    hier: [
      { level: "site", value: "dallas" },
      { level: "device", value: k.device },
    ],
    liveness: "FRESH",
    status: "RUNNING",
    uptimeSecs: 100,
    uptimeAnchorAt: T0,
    lastStateAt: T0,
    expectedIntervalSecs: 5,
    cadenceSource: "default",
    restarts: 0,
    values: [],
    droppedChannels: 0,
    ...overrides,
  };
}

export function deviceView(
  device: string,
  components: ComponentView[],
  overrides: Partial<DeviceView> = {},
): DeviceView {
  return { device, unreachable: false, components, ...overrides };
}

export function fleetView(devices: DeviceView[], overrides: Partial<FleetView> = {}): FleetView {
  return { seq: 10, devices, clockOffsetMs: 0, lastUpdatedAt: T0, ...overrides };
}

/** A ClientState around a view (for presentational-component tests). */
export function clientState(
  fleet: FleetView,
  overrides: Partial<ClientState> = {},
): ClientState {
  return {
    status: "connected",
    hasSnapshot: true,
    fleet,
    configs: { entriesById: {} },
    events: { entries: [] },
    metrics: { series: [] },
    commands: { byId: {}, latestByComponentVerb: {}, recent: [] },
    wsUrl: "ws://console.test/ws",
    ...overrides,
  };
}

/** A {@link CommandEntry} with defaults (for command-UI tests). */
export function commandEntry(overrides: Partial<CommandEntry> = {}): CommandEntry {
  const k = overrides.key ?? key();
  return {
    requestId: "cmd-1",
    seq: 1,
    key: k,
    componentId: `${k.device}/${k.component}/${k.instance}`,
    verb: "ping",
    phase: "ok",
    result: { status: "RUNNING", uptimeSecs: 42 },
    elapsedMs: 12,
    ...overrides,
  };
}

/** Build a {@link CommandView} from a list of entries (latest-by-slot derived by seq). */
export function commandView(entries: CommandEntry[]): CommandView {
  const byId: Record<string, CommandEntry> = {};
  const latestByComponentVerb: Record<string, CommandEntry> = {};
  for (const e of entries) {
    byId[e.requestId] = e;
    const slot = `${e.componentId}::${e.verb}`;
    const prev = latestByComponentVerb[slot];
    if (prev === undefined || e.seq > prev.seq) latestByComponentVerb[slot] = e;
  }
  return { byId, latestByComponentVerb, recent: [...entries].sort((a, b) => b.seq - a.seq) };
}

/** A {@link ConsoleEvent} with sensible defaults (id/type/severity overridable). */
export function consoleEvent(overrides: Partial<ConsoleEvent> = {}): ConsoleEvent {
  const k = overrides.key ?? key();
  return {
    id: 1,
    key: k,
    severity: "warning",
    type: "overtemp",
    channel: "warning/overtemp",
    body: { message: "temperature above threshold", limitC: 80, valueC: 84.2 },
    receivedAt: T0,
    sourceTimestamp: "2026-07-03T00:00:00.000Z",
    ...overrides,
  };
}

/** A {@link MetricSeriesView} with defaults; points derived from `values` at 5 s spacing. */
export function metricSeries(
  values: number[],
  overrides: Partial<MetricSeriesView> = {},
): MetricSeriesView {
  const k = overrides.key ?? key();
  const componentId = `${k.device}/${k.component}/${k.instance}`;
  const metric = overrides.metric ?? "sys";
  const measure = overrides.measure ?? "cpu";
  const points = values.map((value, i) => ({
    at: T0 - (values.length - 1 - i) * 5000,
    value,
  }));
  return {
    key: k,
    componentId,
    seriesId: `${componentId}::${metric}::${measure}`,
    metric,
    measure,
    latest: values[values.length - 1] ?? 0,
    receivedAt: T0,
    points,
    ...overrides,
  };
}

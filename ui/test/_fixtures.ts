/**
 * Shared UI test fixtures — snapshot/delta/view builders with pinned timestamps
 * (no sleeps; the server-clock base is T0). Mock data lives ONLY here (tests) —
 * the shipped view renders exclusively from the live gateway stream.
 */
import type {
  AlarmSnapshot,
  ComponentKey,
  ComponentSnapshot,
  ConsoleAlarm,
  ConsoleEvent,
  ConsoleSettings,
  DeviceSnapshot,
  FleetDelta,
  FleetSnapshot,
  RuntimeAttributes,
  SignalPoint,
  SignalSeriesSnapshot,
  WireHierLevel,
} from "@edgecommons/edge-console-protocol";
import { componentKeyId } from "@edgecommons/edge-console-protocol";
import type { ClientState } from "../src/fleet/client";
import { EMPTY_ALARM_COUNTS } from "../src/fleet/alarm-store";
import type { AttributesView } from "../src/fleet/attribute-store";
import type { CommandEntry, CommandView } from "../src/fleet/command-store";
import type { ComponentView, DeviceView, FleetView } from "../src/fleet/store";

/** The pinned server-clock base for all fixtures (ms epoch). */
export const T0 = 1_750_000_000_000;

export function key(device = "gw-01", component = "comp-a", _instance = "main"): ComponentKey {
  return { device, component };
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
    id: `${k.device}/${k.component}`,
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

/** A hierarchy `[{level,value}]` from level names + values (last = device). */
export function hier(...pairs: [string, string][]): WireHierLevel[] {
  return pairs.map(([level, value]) => ({ level, value }));
}

/** RuntimeAttributes for one component (all runtime fields optional). */
export function runtimeAttrs(
  k: ComponentKey,
  overrides: Partial<RuntimeAttributes> = {},
): RuntimeAttributes {
  return { key: k, receivedAt: T0, ...overrides };
}

/** A bounded recent series of signal points (ascending time), values + optional quality. */
export function signalPoints(
  values: number[],
  opts: { quality?: string; startAt?: number; stepMs?: number } = {},
): SignalPoint[] {
  const { quality, startAt = T0, stepMs = 1000 } = opts;
  return values.map((value, i) => ({
    at: startAt + i * stepMs,
    value,
    ...(quality !== undefined ? { quality } : {}),
  }));
}

/** A {@link SignalSeriesSnapshot} for one `(component, signal)` series (sensible defaults). */
export function signalSeries(
  k: ComponentKey,
  signal: string,
  overrides: Partial<SignalSeriesSnapshot> = {},
): SignalSeriesSnapshot {
  const points = overrides.points ?? signalPoints([1, 2, 3]);
  const last = points[points.length - 1];
  return {
    key: k,
    instance: overrides.instance ?? "main",
    signal,
    latest: overrides.latest ?? last?.value,
    ...(overrides.quality !== undefined ? { quality: overrides.quality } : last?.quality !== undefined ? { quality: last.quality } : {}),
    receivedAt: overrides.receivedAt ?? last?.at ?? T0,
    ...(overrides.sourceTimestamp !== undefined ? { sourceTimestamp: overrides.sourceTimestamp } : {}),
    points,
    ...overrides,
  };
}

/** An {@link AttributesView} keyed by component id, from a list of attributes. */
export function attributesView(list: RuntimeAttributes[]): AttributesView {
  const byId: Record<string, RuntimeAttributes> = {};
  for (const a of list) byId[componentKeyId(a.key)] = a;
  return { byId };
}

export function fleetView(devices: DeviceView[], overrides: Partial<FleetView> = {}): FleetView {
  return { seq: 10, devices, clockOffsetMs: 0, lastUpdatedAt: T0, ...overrides };
}

/** A {@link ConsoleSettings} with realistic defaults (the demo's two-role policy + gw-dallas-01). */
export function consoleSettings(overrides: Partial<ConsoleSettings> = {}): ConsoleSettings {
  return {
    rbac: {
      defaultRole: "operator",
      roles: [
        { name: "operator", allow: ["*"], deny: ["reboot"], isDefault: true },
        { name: "viewer", allow: ["ping", "get-configuration"], deny: [], isDefault: false },
      ],
    },
    connection: {
      device: "gw-dallas-01",
      component: "edge-console",
      platform: "HOST",
      transport: "MQTT",
      broker: "EMQX @ gateway",
      wsPort: 8443,
      wsBindAddress: "0.0.0.0",
      heartbeatIntervalMs: 15000,
      servesUi: false,
    },
    staleness: {
      warnMultiplier: 2,
      staleMultiplier: 2.5,
      offlineMultiplier: 5,
      defaultIntervalSecs: 5,
      sweepIntervalMs: 1000,
    },
    commands: {
      defaultTimeoutMs: 30000,
      maxTimeoutMs: 60000,
      verbTimeouts: [{ verb: "ping", ms: 10000 }],
    },
    retention: {
      maxChannelsPerComponent: 1024,
      maxEvents: 1000,
      maxPerComponent: 100,
      maxSeriesPoints: 60,
      maxSeries: 2000,
    },
    ...overrides,
  };
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
    alarms: { active: [], counts: EMPTY_ALARM_COUNTS },
    attributes: { byId: {} },
    signals: { series: [] },
    commands: { byId: {}, latestByComponentVerb: {}, recent: [] },
    wsUrl: "ws://console.test/ws",
    ...overrides,
  };
}

/** A {@link ConsoleAlarm} with sensible defaults (active critical alarm). */
export function consoleAlarm(overrides: Partial<ConsoleAlarm> = {}): ConsoleAlarm {
  const k = overrides.key ?? key();
  const componentId = `${k.device}/${k.component}`;
  const type = overrides.type ?? "connection-lost";
  return {
    id: `${componentId}::${type}`,
    key: k,
    componentId,
    severity: "critical",
    type,
    message: "southbound connection dropped",
    raisedAt: T0,
    lastAt: T0,
    count: 1,
    acked: false,
    contained: false,
    ...overrides,
  };
}

/** An {@link AlarmSnapshot} from a list of alarms (counts derived over the active set). */
export function alarmSnapshot(alarms: ConsoleAlarm[]): AlarmSnapshot {
  let critical = 0;
  let warning = 0;
  let active = 0;
  let contained = 0;
  let acked = 0;
  for (const a of alarms) {
    if (a.contained) {
      contained++;
      continue;
    }
    active++;
    if (a.severity === "critical") critical++;
    else warning++;
    if (a.acked) acked++;
  }
  return { active: alarms, counts: { critical, warning, active, contained, acked } };
}

/** A {@link CommandEntry} with defaults (for command-UI tests). */
export function commandEntry(overrides: Partial<CommandEntry> = {}): CommandEntry {
  const k = overrides.key ?? key();
  return {
    requestId: "cmd-1",
    seq: 1,
    key: k,
    componentId: `${k.device}/${k.component}`,
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
    instance: overrides.instance ?? "main",
    severity: "warning",
    type: "overtemp",
    channel: "warning/overtemp",
    body: { message: "temperature above threshold", limitC: 80, valueC: 84.2 },
    receivedAt: T0,
    sourceTimestamp: "2026-07-03T00:00:00.000Z",
    ...overrides,
  };
}

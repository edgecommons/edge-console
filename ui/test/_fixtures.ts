/**
 * Shared UI test fixtures — snapshot/delta/view builders with pinned timestamps
 * (no sleeps; the server-clock base is T0). Mock data lives ONLY here (tests) —
 * the shipped view renders exclusively from the live gateway stream.
 */
import type {
  ComponentKey,
  ComponentSnapshot,
  DeviceSnapshot,
  FleetDelta,
  FleetSnapshot,
} from "@edgecommons/edge-console-protocol";
import type { ClientState } from "../src/fleet/client";
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
    wsUrl: "ws://console.test/ws",
    ...overrides,
  };
}

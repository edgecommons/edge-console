/**
 * Pure derivations over the {@link FleetView} — everything the edge-health screen
 * computes from the store (summary counts, device rollups, the issue list, display
 * uptime/age) lives here so it is unit-testable without React.
 */
import type { Liveness } from "@edgecommons/edge-console-protocol";
import type { ComponentView, DeviceView, FleetView } from "./store";

/** Summary counts for the fleet-health header tiles. */
export interface FleetCounts {
  total: number;
  byLiveness: Record<Liveness, number>;
  /** FRESH components (the "N/M healthy" numerator). */
  healthy: number;
  /** Components needing attention: WARN + STALE + OFFLINE + UNREACHABLE. */
  attention: number;
  devices: number;
  unreachableDevices: number;
}

/** Count components by (effective) liveness plus device reachability. */
export function summarize(view: FleetView): FleetCounts {
  const byLiveness: Record<Liveness, number> = {
    FRESH: 0,
    WARN: 0,
    STALE: 0,
    OFFLINE: 0,
    STOPPED: 0,
    UNREACHABLE: 0,
  };
  let total = 0;
  let unreachableDevices = 0;
  for (const device of view.devices) {
    if (device.unreachable) unreachableDevices++;
    for (const comp of device.components) {
      byLiveness[comp.liveness]++;
      total++;
    }
  }
  return {
    total,
    byLiveness,
    healthy: byLiveness.FRESH,
    attention: byLiveness.WARN + byLiveness.STALE + byLiveness.OFFLINE + byLiveness.UNREACHABLE,
    devices: view.devices.length,
    unreachableDevices,
  };
}

/** A device's worst-of health rollup (the fleet table group row's tag). */
export type RollupLevel = "healthy" | "degraded" | "critical" | "unreachable" | "stopped" | "empty";

/** Worst-of rollup: unreachable > any OFFLINE > any WARN/STALE > all-STOPPED > healthy. */
export function deviceRollup(device: DeviceView): RollupLevel {
  if (device.unreachable) return "unreachable";
  if (device.components.length === 0) return "empty";
  let sawWarnish = false;
  let sawRunning = false;
  for (const comp of device.components) {
    if (comp.liveness === "OFFLINE") return "critical";
    if (comp.liveness === "WARN" || comp.liveness === "STALE") sawWarnish = true;
    if (comp.liveness !== "STOPPED") sawRunning = true;
  }
  if (sawWarnish) return "degraded";
  return sawRunning ? "healthy" : "stopped";
}

/** One entry of the edge-health notification strip. */
export interface FleetIssue {
  /** Stable identity for React keys / dedup. */
  id: string;
  severity: "critical" | "warning";
  title: string;
  subtitle: string;
}

/**
 * The notification strip's content, mirroring the hi-fi mockup's inline notes:
 * OFFLINE components are critical, STALE components warn, and each UNREACHABLE
 * device gets ONE containment note ("the road is down, not the houses") instead of
 * per-component alarms. WARN is shading, not an alarm (D5) — table-only.
 */
export function fleetIssues(view: FleetView, nowServerMs: number): FleetIssue[] {
  const critical: FleetIssue[] = [];
  const warnings: FleetIssue[] = [];
  for (const device of view.devices) {
    if (device.unreachable) {
      const frozen = device.components.length;
      const since =
        device.unreachableSince !== undefined
          ? ` for ${formatDurationMs(Math.max(0, nowServerMs - device.unreachableSince))}`
          : "";
      warnings.push({
        id: `unreachable:${device.device}`,
        severity: "warning",
        title: `${device.device} — device unreachable${since}`,
        subtitle:
          `bridge link down — ${frozen} component${frozen === 1 ? "" : "s"} frozen at ` +
          `last-known values; component alarms contained`,
      });
      continue; // containment: no per-component issues under an unreachable device
    }
    for (const comp of device.components) {
      if (comp.liveness !== "OFFLINE" && comp.liveness !== "STALE") continue;
      const age =
        comp.lastStateAt !== undefined
          ? `last seen ${formatDurationMs(Math.max(0, nowServerMs - comp.lastStateAt))} ago`
          : "no state received yet";
      const issue: FleetIssue = {
        id: `${comp.liveness.toLowerCase()}:${comp.id}`,
        severity: comp.liveness === "OFFLINE" ? "critical" : "warning",
        title: `${comp.key.component} — ${comp.liveness === "OFFLINE" ? "offline" : "state keepalive stale"}`,
        subtitle: `${device.device} · ${age}, expected ~${comp.expectedIntervalSecs}s`,
      };
      (issue.severity === "critical" ? critical : warnings).push(issue);
    }
  }
  return [...critical, ...warnings];
}

/**
 * Display uptime: extrapolated 1:1 with wall clock while the component is provably
 * alive (RUNNING and FRESH/WARN — a keepalive-backed claim), frozen at the last
 * reported value otherwise (a STALE/OFFLINE/STOPPED uptime must not keep growing).
 */
export function displayUptimeSecs(comp: ComponentView, nowServerMs: number): number | undefined {
  if (comp.uptimeSecs === undefined) return undefined;
  if (
    comp.status === "RUNNING" &&
    (comp.liveness === "FRESH" || comp.liveness === "WARN") &&
    comp.uptimeAnchorAt !== undefined
  ) {
    return comp.uptimeSecs + Math.max(0, (nowServerMs - comp.uptimeAnchorAt) / 1000);
  }
  return comp.uptimeSecs;
}

/**
 * The hierarchy prefix above the device (e.g. `dallas` for path `dallas/gw-01`) —
 * the group row's context breadcrumb. Falls back to hier levels when present.
 */
export function hierPrefix(device: DeviceView): string {
  const first = device.components[0];
  if (first === undefined) return "";
  if (first.hier.length > 1) {
    return first.hier
      .slice(0, -1)
      .map((e) => e.value)
      .join(" / ");
  }
  const path = first.path;
  const suffix = `/${device.device}`;
  if (path.endsWith(suffix)) {
    return path.slice(0, -suffix.length).split("/").join(" / ");
  }
  return "";
}

/** Compact duration, mockup-style: `43s`, `5m 12s`, `3h 04m`, `6d 04h`. */
export function formatDurationMs(ms: number): string {
  const totalSecs = Math.max(0, Math.floor(ms / 1000));
  if (totalSecs < 60) return `${totalSecs}s`;
  const mins = Math.floor(totalSecs / 60);
  if (mins < 60) return `${mins}m ${pad2(totalSecs % 60)}s`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${pad2(mins % 60)}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${pad2(hours % 24)}h`;
}

/** Duration from seconds (uptime display). */
export function formatDurationSecs(secs: number): string {
  return formatDurationMs(secs * 1000);
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * Pure projections for the Component Detail screen (slice R2) — the breadcrumb path, the
 * subtitle facts, the sibling instances, the per-component alarm slice, and the Health-tab
 * "health checks" — everything the detail computes from the shipped stores, so it is
 * unit-testable without React.
 *
 * The projections deliberately draw ONLY on data the console actually holds (identity /
 * liveness / runtime attributes / alarms). Facts that need the deferred `describe`/panels
 * capability manifest — the component's implementation LANGUAGE and app VERSION, its custom
 * command surface, its panels — are NOT fabricated here; the view renders those as an honest
 * Phase-2 pending state instead.
 */
import type {
  ComponentKey,
  ConsoleAlarm,
  Liveness,
  RuntimeAttributes,
} from "@edgecommons/edge-console-protocol";
import { componentKeyId } from "@edgecommons/edge-console-protocol";
import type { ComponentView } from "../fleet/store";
import { connLevel } from "../fleet/grouping";
import type { ConnLevel } from "../fleet/grouping";
import { displayUptimeSecs, formatDurationMs } from "../fleet/selectors";

/**
 * The full identity path values for the Components-screen breadcrumb (full hierarchy → device),
 * i.e. every hier value (the component name is appended by the caller). Falls back to the
 * bare device when no hierarchy was advertised.
 */
export function componentFullPath(comp: ComponentView): string[] {
  if (comp.hier.length > 0) return comp.hier.map((e) => e.value);
  return [comp.key.device];
}

/**
 * The Detail breadcrumb's MIDDLE segment values — everything below the named site (intermediate
 * levels + device), which the mockup renders between "Components" and the component name
 * (e.g. `packaging / pack-gw-01`). With no intermediate tier this is just the device.
 */
export function componentDetailPath(comp: ComponentView): string[] {
  const siteIndex = comp.hier.findIndex((entry) => entry.level === "site");
  if (siteIndex >= 0 && siteIndex < comp.hier.length - 1) {
    return comp.hier.slice(siteIndex + 1).map((e) => e.value);
  }
  if (comp.hier.length > 1) return comp.hier.map((e) => e.value);
  return [comp.key.device];
}

/** The active (non-resolved) alarms attributed to one component, newest raise first. */
export function alarmsForComponent(active: ConsoleAlarm[], key: ComponentKey): ConsoleAlarm[] {
  const id = componentKeyId(key);
  return active.filter((a) => a.componentId === id);
}

/**
 * The subtitle facts under the detail title, built from real data (mockup:
 * "line packaging · pack-gw-01 · HOST · … · keepalive 5s · last state 43s ago"). The
 * implementation language + app version the mockup also shows are OMITTED here — they need
 * the deferred capability manifest, so the view flags them as pending rather than inventing them.
 */
export function detailSubtitleParts(
  comp: ComponentView,
  attrs: RuntimeAttributes | undefined,
  instanceCount: number,
  nowServerMs: number,
): string[] {
  const parts: string[] = [];
  // Intermediate levels below the named site and above the device (e.g. "line packaging").
  if (comp.hier.length > 1) {
    const siteIndex = comp.hier.findIndex((entry) => entry.level === "site");
    const start = siteIndex >= 0 ? siteIndex + 1 : 0;
    for (const level of comp.hier.slice(start, comp.hier.length - 1)) {
      parts.push(`${level.level} ${level.value}`);
    }
  }
  parts.push(comp.key.device);
  if (attrs?.platform !== undefined && attrs.platform !== "") parts.push(attrs.platform);
  parts.push(`${instanceCount} instance${instanceCount === 1 ? "" : "s"}`);
  parts.push(`keepalive ${comp.expectedIntervalSecs}s`);
  parts.push(
    comp.lastStateAt !== undefined
      ? `last state ${formatDurationMs(Math.max(0, nowServerMs - comp.lastStateAt))} ago`
      : "no state received yet",
  );
  return parts;
}

/** One row of the Health tab's "health checks" structured list. */
export interface HealthCheck {
  label: string;
  /** The rendered value: a liveness label, connection state, count, or unavailable text. */
  value: string;
  /** Optional supporting text shown beside the value. */
  detail?: string;
  /** A severity hint the view colors the value chip with; `plain` = no chip. */
  tone: "ok" | "warn" | "err" | "unknown" | "plain";
  /** True when the datum is not available at all. */
  pending?: boolean;
}

/** Liveness → the freshness check's value + tone. */
function freshnessCheck(liveness: Liveness): HealthCheck {
  const label = "Heartbeat freshness";
  switch (liveness) {
    case "FRESH":
      return { label, value: "Fresh", tone: "ok" };
    case "WARN":
      return { label, value: "Warning", tone: "warn" };
    case "STALE":
      return { label, value: "Stale", tone: "warn" };
    case "OFFLINE":
      return { label, value: "Offline", tone: "err" };
    case "STOPPED":
      return { label, value: "Stopped", tone: "plain" };
    case "UNREACHABLE":
      return { label, value: "Unreachable", tone: "unknown" };
  }
}

const CONN_TONE: Record<ConnLevel, HealthCheck["tone"]> = {
  ok: "ok",
  warn: "warn",
  err: "err",
  unknown: "unknown",
};

function pluralInstance(n: number): string {
  return `${n} instance${n === 1 ? "" : "s"}`;
}

function humanConnectionState(state: string): string {
  const normalized = state.trim().toUpperCase();
  if (normalized === "CONNECTED" || normalized === "OK" || normalized === "UP" || normalized === "GOOD" || normalized === "ONLINE") {
    return "Connected";
  }
  if (normalized === "DISCONNECTED" || normalized === "DOWN" || normalized === "ERROR" || normalized === "FAULTED" || normalized === "FAILED" || normalized === "LOST") {
    return "Disconnected";
  }
  return normalized
    .toLowerCase()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

/** Aggregate connection state from per-instance state, falling back to runtime attributes. */
export function connectionStateCheck(
  comp: ComponentView,
  attrs: RuntimeAttributes | undefined,
): HealthCheck {
  const instances = comp.instances ?? [];
  if (instances.length > 0) {
    const connected = instances.filter((inst) => inst.connected).length;
    const detail = `${connected} of ${pluralInstance(instances.length)} connected`;
    if (connected === instances.length) {
      return { label: "Connection state", value: "Connected", detail, tone: "ok" };
    }
    if (connected > 0) {
      return { label: "Connection state", value: "Partially connected", detail, tone: "warn" };
    }
    return { label: "Connection state", value: "Disconnected", detail, tone: "err" };
  }

  if (attrs?.connectionState !== undefined && attrs.connectionState !== "") {
    return {
      label: "Connection state",
      value: humanConnectionState(attrs.connectionState),
      detail: "Reported by component telemetry",
      tone: CONN_TONE[connLevel(attrs.connectionState)],
    };
  }

  return {
    label: "Connection state",
    value: "Not reported",
    detail: "No instance status is available",
    tone: "plain",
    pending: true,
  };
}

/**
 * The Health tab's operational checks: heartbeat freshness, messaging readiness
 * (not reported yet), aggregate connection state, cumulative read errors, and this
 * component's open-alarm count. Everything is derived from data the console holds.
 */
export function healthChecks(
  comp: ComponentView,
  attrs: RuntimeAttributes | undefined,
  openAlarms: number,
): HealthCheck[] {
  const checks: HealthCheck[] = [freshnessCheck(comp.liveness)];

  // messaging/ready is a component-reported readiness the console has no surface for yet.
  checks.push({ label: "Messaging readiness", value: "Not reported", tone: "unknown", pending: true });
  checks.push(connectionStateCheck(comp, attrs));

  checks.push({
    label: "Read errors",
    value: attrs?.readErrors !== undefined ? String(attrs.readErrors) : "Not reported",
    tone: attrs?.readErrors !== undefined && attrs.readErrors > 0 ? "warn" : "plain",
    ...(attrs?.readErrors === undefined ? { pending: true } : {}),
  });

  checks.push({
    label: "Open alarms",
    value: String(openAlarms),
    tone: openAlarms > 0 ? "err" : "plain",
  });

  return checks;
}

/** The Health tab's uptime datum (display uptime, frozen when not provably alive), or undefined. */
export function detailUptimeSecs(comp: ComponentView, nowServerMs: number): number | undefined {
  return displayUptimeSecs(comp, nowServerMs);
}

/** Freshness window fallback (ms) when the component's expected heartbeat interval is unknown. */
export const ATTRIBUTES_FRESH_FALLBACK_MS = 60_000;

/**
 * Whether an attribute record is FRESH: its `receivedAt` within 3× the component's expected
 * heartbeat interval (fallback 60 s when the interval is unknown/non-positive). This is what the
 * Health tiles' "Live" chit means — fresh, not ever-reported; stale data shows the value without
 * the chit. Applied to CPU and Memory identically.
 */
export function attributesFresh(
  receivedAt: number | undefined,
  expectedIntervalSecs: number | undefined,
  nowServerMs: number,
): boolean {
  if (receivedAt === undefined) return false;
  const windowMs =
    expectedIntervalSecs !== undefined && expectedIntervalSecs > 0
      ? expectedIntervalSecs * 3 * 1000
      : ATTRIBUTES_FRESH_FALLBACK_MS;
  return nowServerMs - receivedAt <= windowMs;
}

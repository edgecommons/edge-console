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
import type { ComponentView, FleetView } from "../fleet/store";
import { connLevel } from "../fleet/grouping";
import type { ConnLevel } from "../fleet/grouping";
import { displayUptimeSecs, formatDurationMs } from "../fleet/selectors";

/**
 * The full identity path values for the Components-screen breadcrumb (site → … → device),
 * i.e. every hier value (the component name is appended by the caller). Falls back to the
 * bare device when no hierarchy was advertised.
 */
export function componentFullPath(comp: ComponentView): string[] {
  if (comp.hier.length > 0) return comp.hier.map((e) => e.value);
  return [comp.key.device];
}

/**
 * The Detail breadcrumb's MIDDLE segment values — everything below the site (intermediate
 * levels + device), which the mockup renders between "Components" and the component name
 * (e.g. `packaging / pack-gw-01`). With no intermediate tier this is just the device.
 */
export function componentDetailPath(comp: ComponentView): string[] {
  if (comp.hier.length > 1) return comp.hier.slice(1).map((e) => e.value);
  return [comp.key.device];
}

/** Every instance of the same (device, component) across the fleet, sorted by instance token. */
export function instancesOf(view: FleetView, key: ComponentKey): ComponentView[] {
  const out: ComponentView[] = [];
  for (const device of view.devices) {
    for (const comp of device.components) {
      if (comp.key.device === key.device && comp.key.component === key.component) out.push(comp);
    }
  }
  return out.sort((a, b) => a.key.instance.localeCompare(b.key.instance));
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
  // Intermediate levels above the device (e.g. "line packaging"), verbatim from the hierarchy.
  if (comp.hier.length > 2) {
    for (const level of comp.hier.slice(1, comp.hier.length - 1)) {
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
  /** The rendered value (a liveness label, a connection state, a number, or "—"/"?"). */
  value: string;
  /** A severity hint the view colors the value chip with; `plain` = no chip. */
  tone: "ok" | "warn" | "err" | "unknown" | "plain";
  /** True when the datum is not available at all (the honest "?"/"—" state). */
  pending?: boolean;
}

/** Liveness → the freshness check's value + tone. */
function freshnessCheck(liveness: Liveness): HealthCheck {
  const label = "heartbeat freshness";
  switch (liveness) {
    case "FRESH":
      return { label, value: "fresh", tone: "ok" };
    case "WARN":
      return { label, value: "warn", tone: "warn" };
    case "STALE":
      return { label, value: "stale", tone: "warn" };
    case "OFFLINE":
      return { label, value: "offline", tone: "err" };
    case "STOPPED":
      return { label, value: "stopped", tone: "plain" };
    case "UNREACHABLE":
      return { label, value: "unreachable", tone: "unknown" };
  }
}

const CONN_TONE: Record<ConnLevel, HealthCheck["tone"]> = {
  ok: "ok",
  warn: "warn",
  err: "err",
  unknown: "unknown",
};

/**
 * The Health tab's console-computed health checks (mockup slist): heartbeat freshness,
 * messaging/ready (a component self-report the console does not receive yet — honest "?"),
 * the southbound connection state, cumulative read errors, and this component's open-alarm
 * count. Everything is derived from data the console actually holds.
 */
export function healthChecks(
  comp: ComponentView,
  attrs: RuntimeAttributes | undefined,
  openAlarms: number,
): HealthCheck[] {
  const checks: HealthCheck[] = [freshnessCheck(comp.liveness)];

  // messaging/ready is a component-reported readiness the console has no surface for yet.
  checks.push({ label: "messaging / ready", value: "?", tone: "unknown", pending: true });

  if (attrs?.connectionState !== undefined && attrs.connectionState !== "") {
    checks.push({
      label: "connectionState",
      value: attrs.connectionState,
      tone: CONN_TONE[connLevel(attrs.connectionState)],
    });
  } else {
    checks.push({ label: "connectionState", value: "—", tone: "plain", pending: true });
  }

  checks.push({
    label: "readErrors",
    value: attrs?.readErrors !== undefined ? String(attrs.readErrors) : "—",
    tone: attrs?.readErrors !== undefined && attrs.readErrors > 0 ? "warn" : "plain",
    ...(attrs?.readErrors === undefined ? { pending: true } : {}),
  });

  checks.push({
    label: "open alerts",
    value: String(openAlarms),
    tone: openAlarms > 0 ? "err" : "plain",
  });

  return checks;
}

/** The Health tab's uptime datum (display uptime, frozen when not provably alive), or undefined. */
export function detailUptimeSecs(comp: ComponentView, nowServerMs: number): number | undefined {
  return displayUptimeSecs(comp, nowServerMs);
}

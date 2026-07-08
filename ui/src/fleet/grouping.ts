/**
 * Dynamic fleet grouping (slice R1) — the Overview's "Fleet, grouped by …" tree, built
 * DYNAMICALLY from each component's `hier` (never a hardcoded "line" tier).
 *
 * The UNS identity hierarchy may include levels above site, for example
 * `[enterprise, site, line, device]` (last level = the device the component runs on).
 * The Overview groups the fleet by the levels BELOW the named `site` and above the device,
 * nesting when there is more than one:
 *   - `[enterprise, site, line, device]` → one tier, grouped by line;
 *   - `[site, line, device]`             → one tier, grouped by line;
 *   - `[site, area, line, device]`       → area → line nested;
 *   - `[site, device]`                   → no intermediate tier ⇒ a flat list of device groups.
 * The site is the page context (the header), not a group tier. Each group's status tag is
 * the WORST-OF rollup over every component beneath it, and a group whose device is
 * UNREACHABLE contains its components (the "road is down, not the houses" treatment).
 *
 * Pure, no IO/clock — unit-tested over several `hier` shapes. The optional `query` filters
 * the fleet (component / device / hierarchy match) BEFORE grouping, so empty groups vanish;
 * this is where the app-bar global search meets the table.
 */
import type { Liveness } from "@edgecommons/edge-console-protocol";
import type { ComponentView, FleetView } from "./store";
import type { RollupLevel } from "./selectors";

/** One node of the group tree — a group header with either nested groups or component rows. */
export interface GroupNode {
  /** The hierarchy level name for this tier (e.g. `line`, or `device` in the flat fallback). */
  level: string;
  /** The value at this level (e.g. `stamping`). */
  value: string;
  /** Stable path key (e.g. `line=stamping`, `area=body/line=weld`) — the React key. */
  key: string;
  /** Nesting depth (0 = outermost tier) — drives the row's indent. */
  depth: number;
  /** Worst-of rollup over every component beneath this group. */
  rollup: RollupLevel;
  /** How many components beneath (all tiers). */
  count: number;
  /** Distinct devices beneath, sorted (the "· press-gw-01" / "· 2 devices" summary). */
  devices: string[];
  /** Whether any device beneath is UNREACHABLE (containment). */
  unreachable: boolean;
  /** Earliest server-clock ms a device beneath became unreachable (present while contained). */
  unreachableSince?: number;
  /** Nested sub-groups (empty at the innermost tier). */
  children: GroupNode[];
  /** Component rows (present only at the innermost tier), sorted by id. */
  components: ComponentView[];
}

/** The whole grouping result the Overview renders. */
export interface FleetGrouping {
  /** The named `site` hierarchy value, the page-context label — undefined when no component carries it. */
  site?: string;
  /** The grouping level names, outer→inner (e.g. `["line"]`, `["area","line"]`, or `["device"]`). */
  levelNames: string[];
  /** The innermost grouping unit name (e.g. `line`/`device`) — the header stat's noun. */
  unit: string;
  /** Distinct innermost groups (the header stat's count — "across N lines"). */
  unitCount: number;
  /** Total components (across every group). */
  total: number;
  /** The group tree (outermost tier). */
  groups: GroupNode[];
}

/** A flattened component plus its device's reachability (grouping input). */
interface Entry {
  comp: ComponentView;
  /** The intermediate/device path segments this component groups under (outer→inner). */
  path: { level: string; value: string }[];
  siteValue?: string;
  deviceUnreachable: boolean;
  deviceUnreachableSince?: number;
}

function siteIndex(h: ComponentView["hier"]): number {
  return h.findIndex((entry) => entry.level === "site");
}

function siteValueOf(comp: ComponentView): string | undefined {
  const index = siteIndex(comp.hier);
  return index >= 0 ? comp.hier[index]!.value : undefined;
}

/** The grouping path for one component: the intermediate levels, or the device (flat fallback). */
function groupPathOf(comp: ComponentView): { level: string; value: string }[] {
  const h = comp.hier;
  if (h.length >= 2) {
    // [possibly-above-site, site, …intermediate…, device] → levels between site and device.
    const site = siteIndex(h);
    const start = site >= 0 ? site + 1 : 0;
    if (start < h.length - 1) {
      return h.slice(start, h.length - 1).map((e) => ({ level: e.level, value: e.value }));
    }
  }
  // No intermediate tier → group by the device itself (the "flat device list").
  const deviceLevel = h.length >= 2 ? h[h.length - 1]!.level : "device";
  return [{ level: deviceLevel, value: comp.key.device }];
}

/** Worst-of rollup over a set of components: unreachable > offline > warn/stale > stopped > healthy. */
export function rollupOfComponents(comps: ComponentView[]): RollupLevel {
  if (comps.length === 0) return "empty";
  let unreachable = false;
  let offline = false;
  let warnish = false;
  let running = false;
  for (const c of comps) {
    switch (c.liveness) {
      case "UNREACHABLE":
        unreachable = true;
        break;
      case "OFFLINE":
        offline = true;
        running = true;
        break;
      case "WARN":
      case "STALE":
        warnish = true;
        running = true;
        break;
      case "FRESH":
        running = true;
        break;
      case "STOPPED":
        break;
    }
  }
  if (unreachable) return "unreachable";
  if (offline) return "critical";
  if (warnish) return "degraded";
  return running ? "healthy" : "stopped";
}

/** Does a component match the free-text query (component / device / hierarchy values)? */
export function matchesQuery(comp: ComponentView, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  if (comp.key.component.toLowerCase().includes(q)) return true;
  if (comp.key.device.toLowerCase().includes(q)) return true;
  if (comp.path.toLowerCase().includes(q)) return true;
  return comp.hier.some((e) => e.value.toLowerCase().includes(q));
}

/** Aggregate rollup/count/devices/containment over a group's members. */
function aggregate(members: Entry[]): Pick<
  GroupNode,
  "rollup" | "count" | "devices" | "unreachable" | "unreachableSince"
> {
  const devices = [...new Set(members.map((m) => m.comp.key.device))].sort((a, b) =>
    a.localeCompare(b),
  );
  let unreachable = false;
  let unreachableSince: number | undefined;
  for (const m of members) {
    if (m.deviceUnreachable) {
      unreachable = true;
      if (
        m.deviceUnreachableSince !== undefined &&
        (unreachableSince === undefined || m.deviceUnreachableSince < unreachableSince)
      ) {
        unreachableSince = m.deviceUnreachableSince;
      }
    }
  }
  return {
    rollup: rollupOfComponents(members.map((m) => m.comp)),
    count: members.length,
    devices,
    unreachable,
    ...(unreachableSince !== undefined ? { unreachableSince } : {}),
  };
}

/** Recursively build the group tree from a level `depth` downward. */
function buildNodes(members: Entry[], depth: number, parentKey: string): GroupNode[] {
  const byValue = new Map<string, Entry[]>();
  const levelOf = new Map<string, string>();
  for (const e of members) {
    const seg = e.path[depth];
    if (seg === undefined) continue; // defensive: terminates above here (handled by caller)
    if (!byValue.has(seg.value)) {
      byValue.set(seg.value, []);
      levelOf.set(seg.value, seg.level);
    }
    byValue.get(seg.value)!.push(e);
  }
  const nodes: GroupNode[] = [];
  for (const [value, group] of byValue) {
    const level = levelOf.get(value)!;
    const key = parentKey === "" ? `${level}=${value}` : `${parentKey}/${level}=${value}`;
    const leaf = group.filter((m) => m.path.length === depth + 1);
    const deeper = group.filter((m) => m.path.length > depth + 1);
    nodes.push({
      level,
      value,
      key,
      depth,
      ...aggregate(group),
      children: deeper.length > 0 ? buildNodes(deeper, depth + 1, key) : [],
      components: leaf
        .map((m) => m.comp)
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
  }
  return nodes.sort((a, b) => a.value.localeCompare(b.value));
}

/**
 * Build the dynamic group tree + header stats from the fleet view. Two optional filters run
 * BEFORE grouping (so empty groups vanish): the free-text `query` (component/device/hierarchy
 * match) and `statusFilter` (keep only components at a given effective liveness — the fleet-tools
 * "Status ▾" control; `undefined` = all statuses).
 */
export function groupFleet(
  view: FleetView,
  query = "",
  statusFilter?: Liveness,
): FleetGrouping {
  const entries: Entry[] = [];
  for (const device of view.devices) {
    for (const comp of device.components) {
      if (!matchesQuery(comp, query)) continue;
      if (statusFilter !== undefined && comp.liveness !== statusFilter) continue;
      entries.push({
        comp,
        path: groupPathOf(comp),
        ...(siteValueOf(comp) !== undefined ? { siteValue: siteValueOf(comp)! } : {}),
        deviceUnreachable: device.unreachable,
        ...(device.unreachableSince !== undefined
          ? { deviceUnreachableSince: device.unreachableSince }
          : {}),
      });
    }
  }

  // The site = the most common named `site` hierarchy value (one console = one site in practice).
  const site = mostCommon(entries.map((e) => e.siteValue).filter((s): s is string => s !== undefined));

  // The grouping level names (deepest path wins) + the innermost unit noun.
  const deepest = entries.reduce<{ level: string; value: string }[]>(
    (best, e) => (e.path.length > best.length ? e.path : best),
    [],
  );
  const levelNames = deepest.map((s) => s.level);
  const unit = levelNames.length > 0 ? levelNames[levelNames.length - 1]! : "device";

  // Distinct innermost groups (the "across N lines" count) = distinct full group paths.
  const unitCount = new Set(
    entries.map((e) => e.path.map((s) => s.value).join(" ")),
  ).size;

  return {
    ...(site !== undefined ? { site } : {}),
    levelNames,
    unit,
    unitCount,
    total: entries.length,
    groups: buildNodes(entries, 0, ""),
  };
}

/** The most frequent string in a list, or undefined for an empty list. */
function mostCommon(values: string[]): string | undefined {
  const counts = new Map<string, number>();
  let best: string | undefined;
  let bestN = 0;
  for (const v of values) {
    const n = (counts.get(v) ?? 0) + 1;
    counts.set(v, n);
    if (n > bestN) {
      bestN = n;
      best = v;
    }
  }
  return best;
}

/** The English plural of a level noun for the header stat ("line" → "lines"). */
export function pluralizeUnit(unit: string, n: number): string {
  if (n === 1) return unit;
  if (/[^aeiou]y$/i.test(unit)) return `${unit.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(unit)) return `${unit}es`;
  return `${unit}s`;
}

/**
 * Runtime-attribute column projections (CPU / Memory / Conn). Kept pure + here so the
 * cell rendering has no logic of its own.
 */
export type ConnLevel = "ok" | "warn" | "err" | "unknown";

/** Classify a southbound `connectionState` string into a Conn-cell severity. */
export function connLevel(state: string | undefined): ConnLevel {
  if (state === undefined || state === "") return "unknown";
  const s = state.toUpperCase();
  if (["CONNECTED", "OK", "UP", "GOOD", "ONLINE"].includes(s)) return "ok";
  if (["DISCONNECTED", "DOWN", "ERROR", "FAULTED", "FAILED", "LOST"].includes(s)) return "err";
  // RECONNECTING / CONNECTING / DEGRADED / anything unrecognized → cautious warn.
  return "warn";
}

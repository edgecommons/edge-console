/**
 * Pure derivations over the console's own {@link ConsoleSettings} + the fleet view — every
 * value the read-only Settings screen (R6) renders lives here so it is unit-testable without
 * React: the ms/duration formatters, the staleness-ladder summary string (the mockup's
 * "2× warn / 2.5× stale / 5× offline"), and the identity-derived site-map (device → line),
 * which is what makes the mockup's "Site-map (thing → line)" editor unnecessary today.
 *
 * HONEST by construction: nothing here invents a value. The site-map is derived from the
 * live UNS identity hierarchy (not a stored mapping), and the view flags anything the console
 * genuinely does not hold (panel-trust / redaction-rule policy) as pending rather than faking it.
 */
import type { ConsoleSettings } from "@edgecommons/edge-console-protocol";
import type { FleetView } from "../fleet/store";

/**
 * Format a millisecond duration for display: whole/︎fractional seconds at ≥ 1 s (e.g.
 * `30000` → `30 s`, `2500` → `2.5 s`), bare milliseconds below (e.g. `500` → `500 ms`).
 */
export function formatMs(ms: number): string {
  if (ms >= 1000) {
    const s = ms / 1000;
    return `${Number.isInteger(s) ? s : Math.round(s * 10) / 10} s`;
  }
  return `${ms} ms`;
}

/** The staleness ladder as the mockup states it: "2× warn / 2.5× stale / 5× offline". */
export function stalenessSummary(s: ConsoleSettings["staleness"]): string {
  return `${s.warnMultiplier}× warn / ${s.staleMultiplier}× stale / ${s.offlineMultiplier}× offline`;
}

/** One device's identity-derived placement — the read-only "thing → line" row. */
export interface SiteMapEntry {
  device: string;
  /** The identity-derived grouping path (the intermediate hier levels, outer→inner). Empty ⇒ no line tier. */
  path: { level: string; value: string }[];
  /** How many components run on the device (across the current fleet view). */
  componentCount: number;
}

/** The identity-derived site map — the read-only substitute for a stored device→line mapping. */
export interface SiteMap {
  /** The site value (`hier[0]`) — the page context — when any component carries one. */
  site?: string;
  /** The identity hierarchy level names, outer→inner (e.g. `["site","line","device"]`). */
  levelNames: string[];
  /** The innermost intermediate level name (e.g. `line`) — the "→ line" noun; undefined when flat. */
  groupingLevel?: string;
  /** One entry per device, sorted by device name. */
  entries: SiteMapEntry[];
}

/**
 * Build the identity-derived site map from the fleet view: each device's placement is taken
 * from its components' UNS `hier` (`[site, …intermediate…, device]`), so the "thing → line"
 * mapping is READ from the running identities — the console needs no stored site-map. A fleet
 * with no intermediate tier (`[site, device]`) yields empty paths (flat), flagged by the view.
 */
export function siteMap(fleet: FleetView): SiteMap {
  const entries: SiteMapEntry[] = [];
  let deepest: { level: string; value: string }[] = [];
  const siteCounts = new Map<string, number>();

  for (const device of fleet.devices) {
    // A representative hierarchy for the device (the first component that carries one).
    const rep = device.components.find((c) => c.hier.length > 0)?.hier ?? [];
    if (rep.length > deepest.length) deepest = rep.map((e) => ({ level: e.level, value: e.value }));
    if (rep.length >= 1) {
      const site = rep[0]!.value;
      siteCounts.set(site, (siteCounts.get(site) ?? 0) + 1);
    }
    // Intermediate levels between site and device (the grouping path); empty when flat.
    const path =
      rep.length >= 3 ? rep.slice(1, rep.length - 1).map((e) => ({ level: e.level, value: e.value })) : [];
    entries.push({ device: device.device, path, componentCount: device.components.length });
  }

  entries.sort((a, b) => a.device.localeCompare(b.device));
  const levelNames = deepest.map((e) => e.level);
  const groupingLevel = levelNames.length >= 3 ? levelNames[levelNames.length - 2] : undefined;

  let site: string | undefined;
  let bestN = 0;
  for (const [value, n] of siteCounts) {
    if (n > bestN) {
      bestN = n;
      site = value;
    }
  }

  return {
    ...(site !== undefined ? { site } : {}),
    levelNames,
    ...(groupingLevel !== undefined ? { groupingLevel } : {}),
    entries,
  };
}

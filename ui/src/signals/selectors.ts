/**
 * Pure derivations over the browser {@link SignalStore}'s view — everything the Signals
 * screen (R5) computes lives here so it is unit-testable without React: the per-signal row
 * projection, the data-quality mapping, the value formatter/kind, the sparkline series +
 * trend stats, publish lag, the signal-path/component/source grouping with collapse-default
 * and rollups, the quality-triage counts, the device→component cascade, and the per-group
 * message-rate meter.
 *
 * HONEST by construction: a row shows only what the `data` body / SignalStore carries. The
 * canonical `SouthboundSignalUpdate` metadata (name, signal id, address, adapter, endpoint,
 * qualityRaw, publish timestamp) is surfaced when the adapter published it and left blank
 * otherwise — never invented. A legacy `{value, quality}` publisher gets a mono channel
 * fallback for its name, not a fabricated label. The quality bucket is derived from the token
 * the publisher stamped; an absent token is surfaced as "none" (never faked GOOD).
 */
import type {
  ComponentKey,
  MetricPoint,
  SignalPoint,
  SignalPointSelector,
  SignalSeriesSnapshot,
} from "@edgecommons/edge-console-protocol";
import { componentKeyId } from "@edgecommons/edge-console-protocol";

/** The data-quality display buckets (semantic — drive the status chip color). */
export type QualityBucket = "good" | "uncertain" | "bad" | "other" | "none";

/**
 * Map a raw quality token to a display bucket (case-insensitive on the canonical
 * `GOOD`/`UNCERTAIN`/`BAD`). A non-canonical token is `other` (shown verbatim, not
 * recolored); an absent/empty token is `none` (quality not reported — never faked GOOD).
 */
export function qualityBucket(quality?: string): QualityBucket {
  if (quality === undefined || quality.trim() === "") return "none";
  switch (quality.trim().toUpperCase()) {
    case "GOOD":
      return "good";
    case "UNCERTAIN":
      return "uncertain";
    case "BAD":
      return "bad";
    default:
      return "other";
  }
}

/** The display kind of the latest value — drives the Latest cell's typography (mono-numeric vs text). */
export type ValueKind = "number" | "boolean" | "string" | "json" | "none";

/** Classify the latest value for rendering (a value-less / non-finite sample is `none` — an em dash). */
export function valueKind(value: unknown): ValueKind {
  if (value === null || value === undefined) return "none";
  if (typeof value === "number") return Number.isFinite(value) ? "number" : "none";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return value === "" ? "none" : "string";
  return "json";
}

/**
 * Format a signal's latest value for the "Latest" cell. Returns `undefined` when there is
 * nothing displayable (null/undefined, an empty string, a non-finite number) — the view
 * renders that as an em dash, matching the mockup's `—` for the value-less BAD signal.
 * Numbers are shown compactly (integers bare, else up to two decimals); booleans and
 * strings verbatim; objects/arrays as ellipsized compact JSON (the class is open).
 */
export function formatSignalValue(value: unknown, maxChars = 48): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value === "" ? undefined : ellipsize(value, maxChars);
  return ellipsize(safeStringify(value), maxChars);
}

/**
 * The numeric points of a series as the shared {@link Sparkline}'s input (`{at,value}`,
 * ascending time). Non-numeric samples (an open-class object/string body, a BAD null) are
 * dropped — an all-non-numeric series yields `[]` (no sparkline, honestly).
 */
export function signalSeries(points: SignalPoint[]): MetricPoint[] {
  const out: MetricPoint[] = [];
  for (const p of points) {
    if (typeof p.value === "number" && Number.isFinite(p.value)) out.push({ at: p.at, value: p.value });
  }
  return out;
}

/** min / max / avg over the trend + the window delta (last − first) — the expansion's stats row. */
export interface SignalStats {
  min: number;
  max: number;
  avg: number;
  delta: number;
}

/** Trend statistics over the numeric sparkline series, or `undefined` for an empty series. */
export function signalStats(series: MetricPoint[]): SignalStats | undefined {
  if (series.length === 0) return undefined;
  let min = series[0]!.value;
  let max = series[0]!.value;
  let sum = 0;
  for (const p of series) {
    if (p.value < min) min = p.value;
    if (p.value > max) max = p.value;
    sum += p.value;
  }
  return { min, max, avg: sum / series.length, delta: series[series.length - 1]!.value - series[0]!.value };
}

/** Lag renders warning-toned above this threshold (`LAG_WARN_MS`). */
export const LAG_WARN_MS = 5000;

/**
 * Publish lag (ms) = `publishedTs − (sourceTs ?? serverTs)` over the series' VERBATIM timestamp
 * pair — both sides from the adapter's clock domain (no bus transit, no console skew). The folded
 * compat `sourceTimestamp` is deliberately NOT an input: its envelope-header fallback would
 * fabricate a `lag 0` for legacy publishers that never sent a sample timestamp. Returns
 * `undefined` when `publishedTs` is absent, both verbatim timestamps are absent, or the used pair
 * is unparseable — the view renders "lag —".
 */
export function signalLagMs(
  publishedTs?: string,
  sourceTs?: string,
  serverTs?: string,
): number | undefined {
  const measuredTs = sourceTs ?? serverTs;
  if (publishedTs === undefined || measuredTs === undefined) return undefined;
  const published = Date.parse(publishedTs);
  const measured = Date.parse(measuredTs);
  if (Number.isNaN(published) || Number.isNaN(measured)) return undefined;
  return published - measured;
}

/** One projected Signals-table row (everything the view renders for a series). */
export interface SignalRow {
  /** Stable unique id: component id + instance + signal (also the SignalStore series key). */
  id: string;
  key: ComponentKey;
  componentId: string;
  device: string;
  component: string;
  instance: string;
  /** The UNS signal channel under `data/` (may contain `/`). */
  signal: string;
  /** First path segment of the channel (the grouping folder); absent for a pathless signal. */
  pathSegment?: string;
  /** The channel leaf (last `/` segment) — the short signal name / mono fallback. */
  leaf: string;
  /** `data/{signal}` — the full UNS channel (the id line / mono fallback name). */
  channel: string;
  /** The raw latest value (verbatim from the body). */
  latest: unknown;
  /** The formatted display value, or `undefined` when nothing is displayable (em dash). */
  value?: string;
  /** The latest value's display kind (drives the Latest cell typography). */
  valueKind: ValueKind;
  /** The raw quality token, when the body carried one. */
  quality?: string;
  qualityBucket: QualityBucket;
  /** The native status code behind the normalized quality (`qualityRaw`) — the chip hover. */
  qualityRaw?: string;
  /** The canonical `signal.name` — the human display label (name-led rows). */
  name?: string;
  /** The canonical `signal.id` — the stable protocol-native id. */
  signalId?: string;
  /** The canonical `signal.address` — protocol-native, opaque (rendered verbatim in the expansion). */
  address?: unknown;
  /** The southbound adapter (`opcua`/`modbus`/…) — the Source grouping + expansion. */
  adapter?: string;
  /** The southbound endpoint (`opc.tcp://…`) — the expansion's source detail. */
  endpoint?: string;
  /** Console receipt time of the latest sample (server-clock ms) — the Updated freshness. */
  receivedAt: number;
  /** The latest sample's MEASURED timestamp (`sourceTs`), verbatim — the expansion's "Source ts". */
  sourceTs?: string;
  /** The latest sample's protocol-server REFRESH timestamp (`serverTs`), verbatim — "Server ts". */
  serverTs?: string;
  /** The envelope publish time (`header.timestamp`), when present. */
  publishedTs?: string;
  /** Publish lag (ms) over the verbatim pair, when computable (see {@link signalLagMs}). */
  lagMs?: number;
  /** The numeric recent series for the trend sparkline (may be empty). */
  series: MetricPoint[];
  /** How many recent points the series carries (0 in summary mode until backfill/live). */
  pointCount: number;
}

/** Project one series snapshot to a table row. */
export function signalRow(s: SignalSeriesSnapshot): SignalRow {
  const componentId = componentKeyId(s.key);
  const value = formatSignalValue(s.latest);
  const slash = s.signal.indexOf("/");
  const pathSegment = slash > 0 ? s.signal.slice(0, slash) : undefined;
  const leaf = slash >= 0 ? s.signal.slice(s.signal.lastIndexOf("/") + 1) : s.signal;
  const points = s.points ?? [];
  const lagMs = signalLagMs(s.publishedTs, s.sourceTs, s.serverTs);
  return {
    id: `${componentId}/${s.instance} ${s.signal}`,
    key: s.key,
    componentId,
    device: s.key.device,
    component: s.key.component,
    instance: s.instance,
    signal: s.signal,
    ...(pathSegment !== undefined ? { pathSegment } : {}),
    leaf,
    channel: `data/${s.signal}`,
    latest: s.latest,
    ...(value !== undefined ? { value } : {}),
    valueKind: valueKind(s.latest),
    ...(s.quality !== undefined ? { quality: s.quality } : {}),
    qualityBucket: qualityBucket(s.quality),
    ...(s.qualityRaw !== undefined ? { qualityRaw: s.qualityRaw } : {}),
    ...(s.name !== undefined ? { name: s.name } : {}),
    ...(s.signalId !== undefined ? { signalId: s.signalId } : {}),
    ...(s.address !== undefined ? { address: s.address } : {}),
    ...(s.adapter !== undefined ? { adapter: s.adapter } : {}),
    ...(s.endpoint !== undefined ? { endpoint: s.endpoint } : {}),
    receivedAt: s.receivedAt,
    ...(s.sourceTs !== undefined ? { sourceTs: s.sourceTs } : {}),
    ...(s.serverTs !== undefined ? { serverTs: s.serverTs } : {}),
    ...(s.publishedTs !== undefined ? { publishedTs: s.publishedTs } : {}),
    ...(lagMs !== undefined ? { lagMs } : {}),
    series: signalSeries(points),
    pointCount: points.length,
  };
}

/** Project every series to a row (input is already component-id/signal sorted by the store). */
export function signalRows(series: SignalSeriesSnapshot[]): SignalRow[] {
  return series.map(signalRow);
}

/** The `get-signal-points` selector for one row (backfill request in summary mode). */
export function pointSelector(row: SignalRow): SignalPointSelector {
  return { key: row.key, instance: row.instance, signal: row.signal };
}

/** The active Signals filters (all optional, AND-combined). */
export interface SignalFilters {
  /** Free-text query — matches name / channel / signal id / component id / device (case-insensitive). */
  query?: string;
  /** Scope to one UNS gateway device. */
  deviceId?: string;
  /** Scope to one component id. */
  componentId?: string;
  /** Scope to one quality bucket (the triage strip). */
  quality?: QualityBucket;
}

/** Apply the device + component + quality + search filters (order preserved). */
export function filterSignalRows(rows: SignalRow[], filters: SignalFilters): SignalRow[] {
  const q = filters.query?.trim().toLowerCase();
  return rows.filter((r) => {
    if (filters.deviceId !== undefined && r.device !== filters.deviceId) return false;
    if (filters.componentId !== undefined && r.componentId !== filters.componentId) return false;
    if (filters.quality !== undefined && r.qualityBucket !== filters.quality) return false;
    if (q !== undefined && q !== "") {
      const hay = `${r.name ?? ""} ${r.signal} ${r.signalId ?? ""} ${r.componentId} ${r.device}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** The distinct component ids across the rows, sorted — a stable component list. */
export function signalComponentIds(rows: SignalRow[]): string[] {
  const ids = new Set<string>();
  for (const r of rows) ids.add(r.componentId);
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/** The distinct UNS gateway devices across the rows, sorted (the device dropdown's options). */
export function signalDevices(rows: SignalRow[]): string[] {
  const devices = new Set<string>();
  for (const r of rows) devices.add(r.device);
  return [...devices].sort((a, b) => a.localeCompare(b));
}

/** One component-dropdown option (full id for filtering + a display label). */
export interface ComponentOption {
  id: string;
  label: string;
}

/**
 * The component-dropdown options, sorted. Cascades: when `deviceId` is set the list narrows to
 * that device's components and labels them by their short name (the device prefix is fixed);
 * with no device selected the labels are the full component ids (disambiguated across devices).
 */
export function signalComponentOptions(rows: SignalRow[], deviceId?: string): ComponentOption[] {
  const seen = new Map<string, ComponentOption>();
  for (const r of rows) {
    if (deviceId !== undefined && r.device !== deviceId) continue;
    if (!seen.has(r.componentId)) {
      seen.set(r.componentId, { id: r.componentId, label: deviceId !== undefined ? r.component : r.componentId });
    }
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** The device token of a `device/component` id. */
export function componentDeviceOf(componentId: string): string {
  const slash = componentId.indexOf("/");
  return slash >= 0 ? componentId.slice(0, slash) : componentId;
}

/** Whether a component id belongs to `deviceId` (always true for the "all devices" sentinel). */
export function componentOwnedByDevice(componentId: string, deviceId?: string): boolean {
  return deviceId === undefined || componentDeviceOf(componentId) === deviceId;
}

/**
 * The component scope after a device change (the cascade reset rule): keep the current component
 * scope if it belongs to the newly selected device, otherwise reset to All components.
 */
export function cascadeComponentScope(
  componentId: string | undefined,
  newDeviceId: string | undefined,
): string | undefined {
  if (componentId === undefined) return undefined;
  return componentOwnedByDevice(componentId, newDeviceId) ? componentId : undefined;
}

/** Live quality-triage counts over a row set (the strip chips; the selected quality is NOT applied). */
export interface QualityCounts {
  all: number;
  good: number;
  uncertain: number;
  bad: number;
  /** Non-canonical tokens (shown verbatim, not recolored). */
  other: number;
  /** No quality token on the body. */
  none: number;
}

/** Count rows by quality bucket (fold `other` into its own tally; `all` is the total). */
export function qualityCounts(rows: SignalRow[]): QualityCounts {
  const counts: QualityCounts = { all: rows.length, good: 0, uncertain: 0, bad: 0, other: 0, none: 0 };
  for (const r of rows) counts[r.qualityBucket]++;
  return counts;
}

/* --------------------------------------------------------------------------- grouping */

/** The Group-by axes (mockup filter dropdown). */
export type SignalGroupBy = "path" | "component" | "source" | "none";

/** The trailing fold label for pathless signals (Signal-path axis). */
export const NO_PATH_LABEL = "(no path)";
/** The trailing fold label for signals with no advertised adapter (Source axis). */
export const UNKNOWN_SOURCE_LABEL = "(unknown source)";
/** Groups load collapsed when the page holds more than this many signals. */
export const DEFAULT_COLLAPSE_THRESHOLD = 5;

/** One rollup worst-offender (the collapsed pill's hover): a signal label + its raw status code. */
export interface WorstOffender {
  label: string;
  raw?: string;
}

/** One signal group (a signal-path folder, a component, a source, or the ungrouped list). */
export interface SignalGroup {
  /** Stable group key (React key, collapse state). */
  key: string;
  /** Display label (`filler/`, a component id, `adapter · endpoint`, or "" for the None axis). */
  label: string;
  /** The None-axis single group renders headerless (no toggle) and never collapses. */
  headerless: boolean;
  /** A trailing fold group (`(no path)` / `(unknown source)`) — sorts last. */
  fold: boolean;
  rows: SignalRow[];
  count: number;
  bad: number;
  uncertain: number;
  noQuality: number;
  /** The first BAD signal (the pill hover names it) — present iff `bad > 0`. */
  worstBad?: WorstOffender;
  /** The first UNCERTAIN signal — present iff `uncertain > 0`. */
  worstUncertain?: WorstOffender;
  /** Freshest receipt time across the group (server-clock ms) — the "updated Ns" rollup. */
  freshestAt: number;
  /** Whether this group loads collapsed by default (the >5-signals page rule). */
  defaultCollapsed: boolean;
}

/** Options for {@link groupSignals} (the collapse-default threshold is injectable for tests). */
export interface GroupOptions {
  collapseThreshold?: number;
}

function offender(r: SignalRow): WorstOffender {
  return { label: r.name ?? r.leaf, ...(r.qualityRaw !== undefined ? { raw: r.qualityRaw } : {}) };
}

function buildGroup(
  key: string,
  label: string,
  headerless: boolean,
  fold: boolean,
  rows: SignalRow[],
  defaultCollapsed: boolean,
): SignalGroup {
  let bad = 0;
  let uncertain = 0;
  let noQuality = 0;
  let freshestAt = 0;
  let worstBad: WorstOffender | undefined;
  let worstUncertain: WorstOffender | undefined;
  for (const r of rows) {
    if (r.receivedAt > freshestAt) freshestAt = r.receivedAt;
    if (r.qualityBucket === "bad") {
      bad++;
      worstBad ??= offender(r);
    } else if (r.qualityBucket === "uncertain") {
      uncertain++;
      worstUncertain ??= offender(r);
    } else if (r.qualityBucket === "none") {
      noQuality++;
    }
  }
  return {
    key,
    label,
    headerless,
    fold,
    rows,
    count: rows.length,
    bad,
    uncertain,
    noQuality,
    ...(worstBad !== undefined ? { worstBad } : {}),
    ...(worstUncertain !== undefined ? { worstUncertain } : {}),
    freshestAt,
    defaultCollapsed,
  };
}

/** The (key, label, fold) a row groups under, per axis. */
function groupKeyFor(r: SignalRow, groupBy: SignalGroupBy): { key: string; label: string; fold: boolean } {
  switch (groupBy) {
    case "component":
      return { key: `c:${r.componentId}`, label: r.componentId, fold: false };
    case "source": {
      if (r.adapter !== undefined && r.adapter !== "") {
        const label = r.endpoint !== undefined && r.endpoint !== "" ? `${r.adapter} · ${r.endpoint}` : r.adapter;
        return { key: `s:${r.adapter} ${r.endpoint ?? ""}`, label, fold: false };
      }
      return { key: "s:__unknown__", label: UNKNOWN_SOURCE_LABEL, fold: true };
    }
    case "path":
    default:
      return r.pathSegment !== undefined
        ? { key: `p:${r.pathSegment}`, label: `${r.pathSegment}/`, fold: false }
        : { key: "p:__nopath__", label: NO_PATH_LABEL, fold: true };
  }
}

/**
 * Group rows by the chosen axis. Real groups sort by label; the fold group (`(no path)` /
 * `(unknown source)`) sorts last. Every group loads collapsed by default when the page holds
 * more than the collapse threshold (default 5). The `none` axis yields one headerless,
 * always-expanded group (a flat list has nothing to collapse into — the collapse rule targets
 * the multi-group scale problem).
 */
export function groupSignals(
  rows: SignalRow[],
  groupBy: SignalGroupBy,
  opts: GroupOptions = {},
): SignalGroup[] {
  const threshold = opts.collapseThreshold ?? DEFAULT_COLLAPSE_THRESHOLD;
  if (groupBy === "none") {
    return [buildGroup("__all__", "", true, false, rows, false)];
  }
  const collapseByDefault = rows.length > threshold;
  const map = new Map<string, { label: string; fold: boolean; rows: SignalRow[] }>();
  for (const r of rows) {
    const { key, label, fold } = groupKeyFor(r, groupBy);
    let g = map.get(key);
    if (g === undefined) {
      g = { label, fold, rows: [] };
      map.set(key, g);
    }
    g.rows.push(r);
  }
  const groups = [...map.entries()].map(([key, g]) =>
    buildGroup(key, g.label, false, g.fold, g.rows, collapseByDefault),
  );
  groups.sort((a, b) => (a.fold !== b.fold ? (a.fold ? 1 : -1) : a.label.localeCompare(b.label)));
  return groups;
}

/* ------------------------------------------------------------------ per-group message rate */

/** The sliding window (ms) the per-group msg/s meter averages over. */
export const SIGNAL_RATE_WINDOW_MS = 10_000;

/**
 * A client-side sliding-window message-rate meter (the group header's msg/s rollup). Records
 * live `signal` update arrivals per series; a group's rate is the sum of its member series'
 * arrivals in the window, divided by the window seconds (one decimal). Pure + injectable-clock,
 * so it unit-tests without timers.
 */
export class SignalRateMeter {
  private readonly windowMs: number;
  private readonly events = new Map<string, Array<{ at: number; count: number }>>();

  constructor(windowMs = SIGNAL_RATE_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /** Record `count` arrivals for a series at time `at` (client-clock ms). */
  record(seriesId: string, count: number, at: number): void {
    if (count <= 0) return;
    const arr = this.events.get(seriesId);
    if (arr === undefined) this.events.set(seriesId, [{ at, count }]);
    else arr.push({ at, count });
  }

  /** Drop arrivals older than the window relative to `now` (bounds memory). */
  prune(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [id, arr] of this.events) {
      const kept = arr.filter((e) => e.at >= cutoff);
      if (kept.length === 0) this.events.delete(id);
      else this.events.set(id, kept);
    }
  }

  /** msgs/sec across `seriesIds` over the window ending at `now`, to one decimal. */
  ratePerSec(seriesIds: Iterable<string>, now: number): number {
    const cutoff = now - this.windowMs;
    let total = 0;
    for (const id of seriesIds) {
      const arr = this.events.get(id);
      if (arr === undefined) continue;
      for (const e of arr) if (e.at >= cutoff) total += e.count;
    }
    return Math.round((total / (this.windowMs / 1000)) * 10) / 10;
  }
}

function ellipsize(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value); // circular / BigInt — never throw into a render
  }
}

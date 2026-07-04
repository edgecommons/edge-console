/**
 * Pure derivations over the browser {@link SignalStore}'s view — everything the Signals
 * screen (R5) computes lives here so it is unit-testable without React: the per-signal
 * row projection, the data-quality mapping, the display-value formatter, the sparkline
 * series extraction, and the search / component-scope filtering.
 *
 * HONEST by construction: a row shows only what the `data` body / SignalStore carries.
 * Engineering units, a friendly display name, and alarm limits are NOT on the `data()`
 * wire (they would come from the signal body or a `describe` the console does not consume
 * yet), so this projection never invents them — the view marks them pending. The quality
 * bucket is derived from the token the `data()` facade stamps (its honest GOOD default),
 * and an absent token is surfaced as "none" (not fabricated as GOOD).
 */
import type {
  ComponentKey,
  MetricPoint,
  SignalPoint,
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

/** One projected Signals-table row (everything the view renders for a series). */
export interface SignalRow {
  /** Stable unique id: component id + signal (a series is unique per that pair). */
  id: string;
  key: ComponentKey;
  componentId: string;
  device: string;
  component: string;
  instance: string;
  signal: string;
  /** The raw latest value (verbatim from the body). */
  latest: unknown;
  /** The formatted display value, or `undefined` when nothing is displayable (em dash). */
  value?: string;
  /** The raw quality token, when the body carried one. */
  quality?: string;
  qualityBucket: QualityBucket;
  /** Console receipt time of the latest sample (server-clock ms) — the Age cell. */
  receivedAt: number;
  /** The publisher's own timestamp, when present. */
  sourceTimestamp?: string;
  /** The numeric recent series for the trend sparkline (may be empty). */
  series: MetricPoint[];
}

/** Project one series snapshot to a table row. */
export function signalRow(s: SignalSeriesSnapshot): SignalRow {
  const componentId = componentKeyId(s.key);
  const value = formatSignalValue(s.latest);
  return {
    id: `${componentId} ${s.signal}`,
    key: s.key,
    componentId,
    device: s.key.device,
    component: s.key.component,
    instance: s.key.instance,
    signal: s.signal,
    latest: s.latest,
    ...(value !== undefined ? { value } : {}),
    ...(s.quality !== undefined ? { quality: s.quality } : {}),
    qualityBucket: qualityBucket(s.quality),
    receivedAt: s.receivedAt,
    ...(s.sourceTimestamp !== undefined ? { sourceTimestamp: s.sourceTimestamp } : {}),
    series: signalSeries(s.points),
  };
}

/** Project every series to a row (input is already component-id/signal sorted by the store). */
export function signalRows(series: SignalSeriesSnapshot[]): SignalRow[] {
  return series.map(signalRow);
}

/** The active Signals filters (both optional, AND-combined). */
export interface SignalFilters {
  /** Free-text query (the app-bar search) — matches signal / component / device (case-insensitive). */
  query?: string;
  /** Scope to one component id (the component dropdown + a Component-Detail deep-link). */
  componentId?: string;
}

/** Apply the search + component-scope filters (order preserved). */
export function filterSignalRows(rows: SignalRow[], filters: SignalFilters): SignalRow[] {
  const q = filters.query?.trim().toLowerCase();
  return rows.filter((r) => {
    if (filters.componentId !== undefined && r.componentId !== filters.componentId) return false;
    if (q !== undefined && q !== "") {
      const hay = `${r.signal} ${r.componentId}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** The distinct component ids across the rows, sorted — the component-scope dropdown's options. */
export function signalComponentIds(rows: SignalRow[]): string[] {
  const ids = new Set<string>();
  for (const r of rows) ids.add(r.componentId);
  return [...ids].sort((a, b) => a.localeCompare(b));
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

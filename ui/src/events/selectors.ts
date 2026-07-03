/**
 * Pure derivations over the {@link EventsView} — everything the Events screen
 * computes (filtering, header tiles, body summaries, the events/min series) lives
 * here so it is unit-testable without React.
 */
import type { ConsoleEvent, EventSeverityLevel, MetricPoint } from "@edgecommons/edge-console-protocol";
import { classifyEventSeverity, componentKeyId } from "@edgecommons/edge-console-protocol";

/** The severity filter's value space: canonical buckets + unclassified. */
export type SeverityFilter = EventSeverityLevel | "other";

/** The effective severity bucket of one event (`other` = unknown/absent token). */
export function severityBucket(event: ConsoleEvent): SeverityFilter {
  return classifyEventSeverity(event.severity) ?? "other";
}

/** The active event filters (both optional, AND-combined). */
export interface EventFilters {
  /** Canonical `device/component/instance` id. */
  componentId?: string;
  severity?: SeverityFilter;
}

/** Apply the component/severity filters (order preserved — newest-first in, newest-first out). */
export function filterEvents(entries: ConsoleEvent[], filters: EventFilters): ConsoleEvent[] {
  return entries.filter((e) => {
    if (filters.componentId !== undefined && componentKeyId(e.key) !== filters.componentId) {
      return false;
    }
    if (filters.severity !== undefined && severityBucket(e) !== filters.severity) return false;
    return true;
  });
}

/** The distinct event sources (componentKeyIds), sorted — the component filter's options. */
export function eventSourceIds(entries: ConsoleEvent[]): string[] {
  const ids = new Set<string>();
  for (const e of entries) ids.add(componentKeyId(e.key));
  return [...ids].sort((a, b) => a.localeCompare(b));
}

/** Per-severity counts over the (unfiltered) recent history — the header tile legend. */
export function severityCounts(entries: ConsoleEvent[]): Record<SeverityFilter, number> {
  const counts: Record<SeverityFilter, number> = {
    critical: 0,
    error: 0,
    warning: 0,
    info: 0,
    debug: 0,
    other: 0,
  };
  for (const e of entries) counts[severityBucket(e)]++;
  return counts;
}

/** The noisiest source over the last `windowMs` (mockup: "Noisiest"), or undefined. */
export function noisiestSource(
  entries: ConsoleEvent[],
  nowServerMs: number,
  windowMs = 5 * 60_000,
): { componentId: string; count: number } | undefined {
  const counts = new Map<string, number>();
  for (const e of entries) {
    if (nowServerMs - e.receivedAt > windowMs) continue;
    const id = componentKeyId(e.key);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  let best: { componentId: string; count: number } | undefined;
  for (const [componentId, count] of counts) {
    if (best === undefined || count > best.count) best = { componentId, count };
  }
  return best;
}

/**
 * The events-per-minute series for the header sparkline: per-minute arrival counts
 * over the trailing `minutes` window (ascending time, newest last — the shared
 * sparkline's input shape). Empty history yields an all-zero series.
 */
export function eventsPerMinute(
  entries: ConsoleEvent[],
  nowServerMs: number,
  minutes = 10,
): MetricPoint[] {
  const points: MetricPoint[] = [];
  for (let i = minutes - 1; i >= 0; i--) {
    const bucketEnd = nowServerMs - i * 60_000;
    const bucketStart = bucketEnd - 60_000;
    let count = 0;
    for (const e of entries) {
      if (e.receivedAt > bucketStart && e.receivedAt <= bucketEnd) count++;
    }
    points.push({ at: bucketEnd, value: count });
  }
  return points;
}

/**
 * A compact one-line summary of the event body for the log row: a string body
 * verbatim; an object's conventional message field (`message`/`msg`/`reason`/
 * `description`/`detail`) when present, else compact JSON — always ellipsized.
 */
export function summarizeBody(body: unknown, maxChars = 120): string {
  let text: string;
  if (typeof body === "string") {
    text = body;
  } else if (body === null || body === undefined) {
    text = "";
  } else if (typeof body === "object" && !Array.isArray(body)) {
    const obj = body as Record<string, unknown>;
    const messageField = ["message", "msg", "reason", "description", "detail"].find(
      (f) => typeof obj[f] === "string" && (obj[f] as string) !== "",
    );
    text = messageField !== undefined ? (obj[messageField] as string) : safeStringify(body);
  } else {
    text = safeStringify(body);
  }
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

/** Pretty JSON of the event body for the expanded detail pane. */
export function prettyBody(body: unknown): string {
  return safeStringify(body, 2);
}

function safeStringify(value: unknown, indent?: number): string {
  try {
    return JSON.stringify(value, undefined, indent) ?? String(value);
  } catch {
    return String(value); // circular/BigInt — never throw into a render
  }
}

/** Wall-clock `HH:MM:SS` for a server-clock ms timestamp (the log's time column). */
export function formatClockTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

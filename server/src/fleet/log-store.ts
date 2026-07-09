/**
 * LogStore — the console's rolling component log tails. The UNS `log` class is
 * high-rate, body-bearing activity data, so it is intentionally kept out of the
 * FleetModel LKV/delta stream and served through component-scoped subscribe frames.
 *
 * Pure core, no IO, injected clock. Rings are drop-oldest both fleet-wide and per
 * component. Ingest is deliberately strict about attribution and `log/{level}` so
 * malformed records do not become operator-visible noise.
 */
import type {
  ComponentKey,
  ConsoleLogError,
  ConsoleLogRecord,
  LogLevel,
} from "@edgecommons/edge-console-protocol";
import { componentKeyId, parseLogLevel } from "@edgecommons/edge-console-protocol";
import type { IngressEvent } from "../ingress/normalizer";
import type { Clock } from "./fleet-model";

export interface LogStoreOptions {
  /** Fleet-wide log ring capacity. Default 5000. */
  maxRecords: number;
  /** Per-component log ring capacity. Default 1000. */
  maxPerComponent: number;
}

export interface LogQuery {
  limit?: number;
  levels?: readonly LogLevel[];
  sinceId?: number;
}

export const DEFAULT_LOG_STORE_OPTIONS: LogStoreOptions = {
  maxRecords: 5000,
  maxPerComponent: 1000,
};

export type LogListener = (key: ComponentKey, records: ConsoleLogRecord[], dropped?: number) => void;

interface ComponentLogState {
  ring: ConsoleLogRecord[];
  dropped: number;
  seen: string[];
  seenSet: Set<string>;
}

const SEEN_CAP = 2048;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordObject(value: unknown): Record<string, unknown> | undefined {
  return asObject(value);
}

function logError(value: unknown): ConsoleLogError | undefined {
  const src = asObject(value);
  if (src === undefined) return undefined;
  const error: ConsoleLogError = {};
  const type = nonEmptyString(src.type);
  const message = nonEmptyString(src.message);
  const stack = nonEmptyString(src.stack);
  if (type !== undefined) error.type = type;
  if (message !== undefined) error.message = message;
  if (stack !== undefined) error.stack = stack;
  return Object.keys(error).length > 0 ? error : undefined;
}

function channelLevel(channel: string | undefined): LogLevel | undefined {
  if (channel === undefined || channel === "") return undefined;
  return parseLogLevel(channel.split("/")[0]);
}

function dedupeKey(record: Omit<ConsoleLogRecord, "id" | "receivedAt">): string {
  return [
    componentKeyId(record.key),
    record.instance,
    record.level,
    record.sequence ?? "",
    record.sourceTimestamp ?? "",
    record.logger,
    record.message,
  ].join("\u0000");
}

function newestFirst(records: ConsoleLogRecord[], query?: LogQuery): ConsoleLogRecord[] {
  let rows = [...records].reverse();
  if (query?.sinceId !== undefined) rows = rows.filter((r) => r.id > query.sinceId!);
  if (query?.levels !== undefined && query.levels.length > 0) {
    const levels = new Set(query.levels);
    rows = rows.filter((r) => levels.has(r.level));
  }
  return query?.limit !== undefined && query.limit < rows.length ? rows.slice(0, query.limit) : rows;
}

/** Rolling per-component log tails plus fanout hook. */
export class LogStore {
  private readonly opts: LogStoreOptions;
  private readonly ring: ConsoleLogRecord[] = [];
  private readonly byComponent = new Map<string, ComponentLogState>();
  private readonly listeners: LogListener[] = [];
  private nextId = 1;
  private malformedDrops = 0;

  constructor(
    private readonly clock: Clock,
    opts?: Partial<LogStoreOptions>,
  ) {
    this.opts = { ...DEFAULT_LOG_STORE_OPTIONS, ...opts };
  }

  ingest(event: IngressEvent): void {
    if (event.kind !== "envelope" || event.cls !== "log") return;
    const level = channelLevel(event.channel);
    if (level === undefined) {
      this.malformedDrops++;
      return;
    }
    const last = event.identity.hier[event.identity.hier.length - 1];
    const device = last?.value;
    if (device === undefined || device === "") {
      this.malformedDrops++;
      return;
    }
    const body = asObject(event.body);
    if (body === undefined) {
      this.malformedDrops++;
      return;
    }
    const logger = nonEmptyString(body.logger);
    const message = nonEmptyString(body.message);
    if (logger === undefined || message === undefined) {
      this.malformedDrops++;
      return;
    }

    const key: ComponentKey = { device, component: event.identity.component };
    const sourceTimestamp = nonEmptyString(body.timestamp) ?? event.sourceTimestamp;
    const sequence = finiteNumber(body.sequence);
    const thread = nonEmptyString(body.thread);
    const fields = recordObject(body.fields);
    const error = logError(body.error);
    const base: Omit<ConsoleLogRecord, "id" | "receivedAt"> = {
      key,
      instance: event.identity.instance,
      level,
      logger,
      message,
      ...(sourceTimestamp !== undefined ? { sourceTimestamp } : {}),
      ...(sequence !== undefined ? { sequence } : {}),
      ...(thread !== undefined ? { thread } : {}),
      ...(fields !== undefined ? { fields } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(typeof body.truncated === "boolean" ? { truncated: body.truncated } : {}),
      ...(event.channel !== undefined ? { channel: event.channel } : {}),
      ...(event.tags !== undefined ? { tags: event.tags } : {}),
    };
    const componentId = componentKeyId(key);
    const state = this.componentState(componentId);
    const seenKey = dedupeKey(base);
    if (state.seenSet.has(seenKey)) return;
    state.seen.push(seenKey);
    state.seenSet.add(seenKey);
    if (state.seen.length > SEEN_CAP) {
      const old = state.seen.shift();
      if (old !== undefined) state.seenSet.delete(old);
    }

    const record: ConsoleLogRecord = {
      id: this.nextId++,
      receivedAt: this.clock(),
      ...base,
    };

    this.ring.push(record);
    if (this.ring.length > this.opts.maxRecords) this.ring.shift();
    state.ring.push(record);
    if (state.ring.length > this.opts.maxPerComponent) {
      state.ring.shift();
      state.dropped++;
    }

    for (const listener of [...this.listeners]) listener(key, [record], state.dropped);
  }

  recentFor(key: ComponentKey, query?: LogQuery): ConsoleLogRecord[] {
    const state = this.byComponent.get(componentKeyId(key));
    return newestFirst(state?.ring ?? [], query);
  }

  droppedFor(key: ComponentKey): number {
    return this.byComponent.get(componentKeyId(key))?.dropped ?? 0;
  }

  size(): number {
    return this.ring.length;
  }

  malformedDropped(): number {
    return this.malformedDrops;
  }

  onLog(listener: LogListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private componentState(id: string): ComponentLogState {
    let state = this.byComponent.get(id);
    if (state === undefined) {
      state = { ring: [], dropped: 0, seen: [], seenSet: new Set() };
      this.byComponent.set(id, state);
    }
    return state;
  }
}

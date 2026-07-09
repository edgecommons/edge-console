/**
 * LogStore (browser) — pure fold core for the C6 `logs`/`log` frames. It mirrors
 * the server's component-scoped LogStore: each component has a newest-first tail
 * replaced by snapshots and prepended by live pushes, deduped by server id.
 */
import type { ComponentKey, ConsoleLogRecord } from "@edgecommons/edge-console-protocol";
import { componentKeyId } from "@edgecommons/edge-console-protocol";

export interface ComponentLogsView {
  key: ComponentKey;
  records: ConsoleLogRecord[];
  dropped?: number;
  unavailable?: {
    code: "FORBIDDEN" | "UNAVAILABLE";
    reason: string;
  };
}

export interface LogsView {
  byId: Record<string, ComponentLogsView>;
}

const EMPTY_VIEW: LogsView = { byId: {} };

export const DEFAULT_CLIENT_LOG_CAP = 1000;

export class LogStore {
  private byId = new Map<string, ComponentLogsView>();
  private version = 0;
  private cachedView: LogsView = EMPTY_VIEW;
  private cachedVersion = -1;

  constructor(private readonly cap: number = DEFAULT_CLIENT_LOG_CAP) {}

  applySnapshot(key: ComponentKey, records: ConsoleLogRecord[], dropped?: number): void {
    this.byId.set(componentKeyId(key), {
      key: { ...key },
      records: [...records].sort((a, b) => b.id - a.id).slice(0, this.cap),
      ...(dropped !== undefined ? { dropped } : {}),
    });
    this.bump();
  }

  applyRecords(key: ComponentKey, records: ConsoleLogRecord[], dropped?: number): void {
    if (records.length === 0 && dropped === undefined) return;
    const id = componentKeyId(key);
    const current = this.byId.get(id) ?? { key: { ...key }, records: [] };
    const known = new Set(current.records.map((r) => r.id));
    const fresh = records.filter((r) => !known.has(r.id));
    const nextRecords =
      fresh.length > 0
        ? [...fresh, ...current.records].sort((a, b) => b.id - a.id).slice(0, this.cap)
        : current.records;
    this.byId.set(id, {
      key: { ...key },
      records: nextRecords,
      ...(dropped !== undefined ? { dropped } : current.dropped !== undefined ? { dropped: current.dropped } : {}),
    });
    this.bump();
  }

  applyUnavailable(key: ComponentKey, code: "FORBIDDEN" | "UNAVAILABLE", reason: string): void {
    this.byId.set(componentKeyId(key), {
      key: { ...key },
      records: [],
      unavailable: { code, reason },
    });
    this.bump();
  }

  view(): LogsView {
    if (this.cachedVersion === this.version) return this.cachedView;
    const byId: Record<string, ComponentLogsView> = {};
    for (const [id, entry] of this.byId) {
      byId[id] = {
        key: { ...entry.key },
        records: entry.records.map((r) => ({ ...r })),
        ...(entry.dropped !== undefined ? { dropped: entry.dropped } : {}),
        ...(entry.unavailable !== undefined ? { unavailable: { ...entry.unavailable } } : {}),
      };
    }
    this.cachedView = { byId };
    this.cachedVersion = this.version;
    return this.cachedView;
  }

  private bump(): void {
    this.version++;
  }
}

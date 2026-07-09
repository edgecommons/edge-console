import { describe, expect, it } from "vitest";
import type { ConsoleLogRecord } from "@edgecommons/edge-console-protocol";
import { componentKeyId } from "@edgecommons/edge-console-protocol";
import { LogStore } from "../src/fleet/log-store";
import { T0, key } from "./_fixtures";

const KEY = key("gw-01", "opcua-adapter");

function row(id: number, message = `message-${id}`): ConsoleLogRecord {
  return {
    id,
    key: KEY,
    instance: "main",
    level: id % 2 === 0 ? "error" : "info",
    logger: "app",
    message,
    receivedAt: T0 + id,
  };
}

describe("LogStore (browser fold)", () => {
  it("starts empty and stays identity-stable until it changes", () => {
    const store = new LogStore();
    const v1 = store.view();
    expect(v1.byId).toEqual({});
    expect(store.view()).toBe(v1);
  });

  it("replaces one component tail on snapshot, newest-first and bounded", () => {
    const store = new LogStore(2);
    store.applySnapshot(KEY, [row(1), row(3), row(2)], 4);

    const entry = store.view().byId[componentKeyId(KEY)]!;
    expect(entry.records.map((r) => r.id)).toEqual([3, 2]);
    expect(entry.dropped).toBe(4);

    store.applySnapshot(key("gw-02", "modbus-adapter"), [row(4)]);
    expect(Object.keys(store.view().byId).sort()).toEqual([
      "gw-01/opcua-adapter",
      "gw-02/modbus-adapter",
    ]);
  });

  it("prepends live records, dedupes by id, and preserves dropped count", () => {
    const store = new LogStore(3);
    store.applySnapshot(KEY, [row(2), row(1)], 1);
    const before = store.view();

    store.applyRecords(KEY, [row(3), row(2, "duplicate")]);
    const after = store.view();
    expect(after).not.toBe(before);
    expect(after.byId[componentKeyId(KEY)]!.records.map((r) => r.id)).toEqual([3, 2, 1]);
    expect(after.byId[componentKeyId(KEY)]!.dropped).toBe(1);
  });

  it("folds unavailable into a visible component entry", () => {
    const store = new LogStore();
    store.applyUnavailable(KEY, "UNAVAILABLE", "no log store");
    expect(store.view().byId[componentKeyId(KEY)]).toMatchObject({
      key: KEY,
      records: [],
      unavailable: { code: "UNAVAILABLE", reason: "no log store" },
    });
  });
});

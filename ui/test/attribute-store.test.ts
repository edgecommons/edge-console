import { describe, expect, it } from "vitest";
import { componentKeyId } from "@edgecommons/edge-console-protocol";
import { AttributeStore } from "../src/fleet/attribute-store";
import { key, runtimeAttrs } from "./_fixtures";

describe("AttributeStore (browser fold)", () => {
  it("starts empty and stays identity-stable until it changes", () => {
    const store = new AttributeStore();
    const v1 = store.view();
    expect(v1.byId).toEqual({});
    expect(store.view()).toBe(v1); // cached identity
  });

  it("replaces the whole surface on a snapshot", () => {
    const store = new AttributeStore();
    store.applySnapshot([
      runtimeAttrs(key("gw-01", "opcua-adapter"), {
        cpuPercent: 12,
        memoryMb: 210,
        diskTotalGb: 100,
        diskUsedGb: 40,
        diskFreeGb: 60,
        openFiles: 8,
        connectionState: "CONNECTED",
      }),
      runtimeAttrs(key("gw-01", "modbus-adapter"), { cpuPercent: 18 }),
    ]);
    const v = store.view();
    expect(Object.keys(v.byId)).toHaveLength(2);
    expect(v.byId[componentKeyId(key("gw-01", "opcua-adapter"))]!.cpuPercent).toBe(12);
    expect(v.byId[componentKeyId(key("gw-01", "opcua-adapter"))]!.diskFreeGb).toBe(60);
    expect(v.byId[componentKeyId(key("gw-01", "opcua-adapter"))]!.openFiles).toBe(8);
    expect(store.get(key("gw-01", "modbus-adapter"))!.cpuPercent).toBe(18);
    expect(store.get(key("gw-01", "missing"))).toBeUndefined();

    // A second snapshot fully replaces (drops the previous set).
    store.applySnapshot([runtimeAttrs(key("gw-02", "x"), { cpuPercent: 5 })]);
    expect(Object.keys(store.view().byId)).toEqual([componentKeyId(key("gw-02", "x"))]);
  });

  it("latest-wins upserts on an update batch", () => {
    const store = new AttributeStore();
    store.applySnapshot([runtimeAttrs(key("gw-01", "a"), { cpuPercent: 10 })]);
    const before = store.view();
    store.applyUpdates([
      runtimeAttrs(key("gw-01", "a"), { cpuPercent: 22, connectionState: "RECONNECTING" }),
      runtimeAttrs(key("gw-01", "b"), { memoryMb: 64 }),
    ]);
    const after = store.view();
    expect(after).not.toBe(before); // version bumped
    expect(store.get(key("gw-01", "a"))!.cpuPercent).toBe(22);
    expect(store.get(key("gw-01", "a"))!.connectionState).toBe("RECONNECTING");
    expect(store.get(key("gw-01", "b"))!.memoryMb).toBe(64);
  });

  it("an empty update batch is a no-op (no version churn)", () => {
    const store = new AttributeStore();
    store.applySnapshot([runtimeAttrs(key("gw-01", "a"))]);
    const v = store.view();
    store.applyUpdates([]);
    expect(store.view()).toBe(v);
  });
});

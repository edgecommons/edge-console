/**
 * The C4 client command store (pure fold): pending → ok/error, client-side failure,
 * per-button latest (`latestByComponentVerb`), the newest-first bounded `recent` feed,
 * and pendingIds.
 */
import { describe, expect, it } from "vitest";
import { CommandStore, commandSlot } from "../src/fleet/command-store";
import { key } from "./_fixtures";

const KEY = key("gw-01", "opcua-adapter");
const ID = "gw-01/opcua-adapter";

describe("CommandStore", () => {
  it("records a pending command and derives the view surfaces", () => {
    const s = new CommandStore();
    s.notePending("r1", KEY, "ping");
    const v = s.view();
    expect(v.byId.r1).toMatchObject({ requestId: "r1", verb: "ping", phase: "pending", componentId: ID });
    expect(v.latestByComponentVerb[commandSlot(ID, "ping")]?.requestId).toBe("r1");
    expect(v.recent.map((e) => e.requestId)).toEqual(["r1"]);
    expect(s.pendingIds()).toEqual(["r1"]);
  });

  it("folds an ok result into its entry", () => {
    const s = new CommandStore();
    s.notePending("r1", KEY, "ping");
    s.applyResult({
      requestId: "r1",
      key: KEY,
      verb: "ping",
      ok: true,
      result: { status: "RUNNING", uptimeSecs: 42 },
      elapsedMs: 12,
    });
    expect(s.view().byId.r1).toMatchObject({
      phase: "ok",
      result: { status: "RUNNING", uptimeSecs: 42 },
      elapsedMs: 12,
    });
    expect(s.pendingIds()).toEqual([]);
  });

  it("folds an error result and clears any prior result", () => {
    const s = new CommandStore();
    s.notePending("r1", KEY, "reload-config");
    s.applyResult({
      requestId: "r1",
      key: KEY,
      verb: "reload-config",
      ok: false,
      error: { code: "FORBIDDEN", message: "nope" },
      elapsedMs: 0,
    });
    const e = s.view().byId.r1!;
    expect(e.phase).toBe("error");
    expect(e.error).toEqual({ code: "FORBIDDEN", message: "nope" });
    expect(e.result).toBeUndefined();
  });

  it("creates an entry for a result whose pending record is gone (defensive)", () => {
    const s = new CommandStore();
    s.applyResult({ requestId: "x", key: KEY, verb: "ping", ok: true, result: {}, elapsedMs: 1 });
    expect(s.view().byId.x?.phase).toBe("ok");
  });

  it("failClient only settles a pending entry", () => {
    const s = new CommandStore();
    s.notePending("r1", KEY, "ping");
    s.applyResult({ requestId: "r1", key: KEY, verb: "ping", ok: true, result: {}, elapsedMs: 1 });
    s.failClient("r1", { code: "TIMEOUT", message: "late" }); // already settled — no-op
    expect(s.view().byId.r1?.phase).toBe("ok");

    s.notePending("r2", KEY, "ping");
    s.failClient("r2", { code: "DISCONNECTED", message: "gone" });
    expect(s.view().byId.r2).toMatchObject({ phase: "error", error: { code: "DISCONNECTED" } });
  });

  it("failAllPending settles every in-flight command", () => {
    const s = new CommandStore();
    s.notePending("r1", KEY, "ping");
    s.notePending("r2", KEY, "reload-config");
    s.applyResult({ requestId: "r2", key: KEY, verb: "reload-config", ok: true, result: {}, elapsedMs: 1 });
    s.failAllPending({ code: "DISCONNECTED", message: "dropped" });
    expect(s.view().byId.r1?.phase).toBe("error");
    expect(s.view().byId.r2?.phase).toBe("ok"); // was already settled
    expect(s.pendingIds()).toEqual([]);
  });

  it("latestByComponentVerb tracks the newest command per (component, verb)", () => {
    const s = new CommandStore();
    s.notePending("r1", KEY, "ping");
    s.notePending("r2", KEY, "ping"); // newer ping for the same component
    expect(s.view().latestByComponentVerb[commandSlot(ID, "ping")]?.requestId).toBe("r2");
  });

  it("recent is newest-first and bounded (drops oldest settled beyond the cap)", () => {
    const s = new CommandStore(2);
    s.notePending("r1", KEY, "ping");
    s.applyResult({ requestId: "r1", key: KEY, verb: "ping", ok: true, result: {}, elapsedMs: 1 });
    s.notePending("r2", KEY, "reload-config");
    s.applyResult({ requestId: "r2", key: KEY, verb: "reload-config", ok: true, result: {}, elapsedMs: 1 });
    s.notePending("r3", KEY, "get-configuration"); // over the cap ⇒ drop oldest settled (r1)
    const ids = s.view().recent.map((e) => e.requestId);
    expect(ids[0]).toBe("r3"); // newest first
    expect(ids).not.toContain("r1");
  });

  it("never drops a still-pending entry to satisfy the cap", () => {
    const s = new CommandStore(1);
    s.notePending("r1", KEY, "ping"); // pending
    s.notePending("r2", KEY, "reload-config"); // pending — cannot evict r1 (also pending)
    expect(s.pendingIds().sort()).toEqual(["r1", "r2"]);
  });
});

describe("CommandStore — per-instance result partitioning", () => {
  it("keys results by componentId::verb::instance — interleaved instances never cross-talk", () => {
    const s = new CommandStore();
    s.notePending("r1", KEY, "sb/browse", "filler1");
    s.notePending("r2", KEY, "sb/browse", "kep2");
    // Replies arrive interleaved (kep2's first):
    s.applyResult({ requestId: "r2", key: KEY, verb: "sb/browse", ok: true, result: { id: "kep2" }, elapsedMs: 2 });
    s.applyResult({ requestId: "r1", key: KEY, verb: "sb/browse", ok: true, result: { id: "filler1" }, elapsedMs: 4 });
    const v = s.view();
    expect(v.latestByComponentVerb[commandSlot(ID, "sb/browse", "filler1")]).toMatchObject({
      requestId: "r1",
      phase: "ok",
      result: { id: "filler1" },
      instance: "filler1",
    });
    expect(v.latestByComponentVerb[commandSlot(ID, "sb/browse", "kep2")]).toMatchObject({
      requestId: "r2",
      phase: "ok",
      result: { id: "kep2" },
      instance: "kep2",
    });
    // Neither leaked into the component-scoped (empty-instance) slot.
    expect(v.latestByComponentVerb[commandSlot(ID, "sb/browse")]).toBeUndefined();
  });

  it("a stale reply settles under the instance it was SENT for, not a later selection", () => {
    const s = new CommandStore();
    s.notePending("r1", KEY, "sb/browse", "filler1"); // sent while filler1 was selected
    s.notePending("r2", KEY, "sb/browse", "kep2"); // the operator switched to kep2
    // filler1's reply arrives late — it must not touch kep2's slot:
    s.applyResult({ requestId: "r1", key: KEY, verb: "sb/browse", ok: true, result: { id: "filler1" }, elapsedMs: 900 });
    const v = s.view();
    expect(v.latestByComponentVerb[commandSlot(ID, "sb/browse", "kep2")]?.phase).toBe("pending");
    expect(v.latestByComponentVerb[commandSlot(ID, "sb/browse", "filler1")]?.phase).toBe("ok");
  });

  it("component-scoped commands (no instance arg) live in the empty-instance slot", () => {
    const s = new CommandStore();
    s.notePending("r1", KEY, "ping");
    expect(commandSlot(ID, "ping")).toBe(`${ID}::ping::`);
    expect(s.view().latestByComponentVerb[commandSlot(ID, "ping")]?.requestId).toBe("r1");
    expect(s.view().byId.r1?.instance).toBeUndefined();
  });

  it("latest-per-slot is per instance: a newer command for another instance leaves the slot alone", () => {
    const s = new CommandStore();
    s.notePending("r1", KEY, "sb/status", "filler1");
    s.applyResult({ requestId: "r1", key: KEY, verb: "sb/status", ok: true, result: { state: "ONLINE" }, elapsedMs: 1 });
    s.notePending("r2", KEY, "sb/status", "kep2"); // newer, different instance
    const v = s.view();
    expect(v.latestByComponentVerb[commandSlot(ID, "sb/status", "filler1")]?.requestId).toBe("r1");
    expect(v.latestByComponentVerb[commandSlot(ID, "sb/status", "kep2")]?.requestId).toBe("r2");
  });
});

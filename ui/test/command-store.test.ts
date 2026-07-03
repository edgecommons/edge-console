/**
 * The C4 client command store (pure fold): pending → ok/error, client-side failure,
 * per-button latest (`latestByComponentVerb`), the newest-first bounded `recent` feed,
 * and pendingIds.
 */
import { describe, expect, it } from "vitest";
import { CommandStore, commandSlot } from "../src/fleet/command-store";
import { key } from "./_fixtures";

const KEY = key("gw-01", "opcua-adapter");
const ID = "gw-01/opcua-adapter/main";

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

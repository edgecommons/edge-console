import { describe, expect, it } from "vitest";
import { ConfigStore } from "../src/fleet/config-store";
import { key } from "./_fixtures";

const KEY = key("gw-01", "modbus-adapter");
const ID = "gw-01/modbus-adapter";

describe("ConfigStore (client) - entry lifecycle", () => {
  it("noteRequested creates a loading entry once (idempotent)", () => {
    const store = new ConfigStore();
    store.noteRequested(KEY);
    store.noteRequested(KEY);
    const view = store.view();
    expect(Object.keys(view.entriesById)).toEqual([ID]);
    expect(view.entriesById[ID]).toEqual({
      key: KEY,
      id: ID,
      phase: "loading",
      refreshing: false,
    });
  });

  it("applyConfig folds the answer: loaded, body verbatim (redaction pass-through), stamped", () => {
    const store = new ConfigStore();
    store.noteRequested(KEY);
    const body = { config: { credentials: { password: "***" }, apiKey: "$secret:x" } };
    store.applyConfig(KEY, body, 1_000_500, "2026-07-03T00:00:00.000Z");

    expect(store.view().entriesById[ID]).toEqual({
      key: KEY,
      id: ID,
      phase: "loaded",
      body, // exactly as the gateway sent it — "***" stays "***"
      receivedAt: 1_000_500,
      sourceTimestamp: "2026-07-03T00:00:00.000Z",
      refreshing: false,
    });
  });

  it("latest-wins: a pushed update replaces the body and drops a stale sourceTimestamp", () => {
    const store = new ConfigStore();
    store.applyConfig(KEY, { config: { rev: 1 } }, 1000, "2026-07-03T00:00:00.000Z");
    store.applyConfig(KEY, { config: { rev: 2 } }, 2000); // no sourceTimestamp this time

    const entry = store.view().entriesById[ID]!;
    expect(entry.body).toEqual({ config: { rev: 2 } });
    expect(entry.receivedAt).toBe(2000);
    expect(entry).not.toHaveProperty("sourceTimestamp");
  });

  it("a re-request of a loaded entry keeps the loaded body (no flicker)", () => {
    const store = new ConfigStore();
    store.applyConfig(KEY, { config: { rev: 1 } }, 1000);
    store.noteRequested(KEY);
    const entry = store.view().entriesById[ID]!;
    expect(entry.phase).toBe("loaded");
    expect(entry.body).toEqual({ config: { rev: 1 } });
  });

  it("applyUnavailable is the server's honest answer: drops any shown body; a later push flips it back", () => {
    const store = new ConfigStore();
    store.applyConfig(KEY, { config: { rev: 1 } }, 1000);
    store.applyUnavailable(KEY);
    let entry = store.view().entriesById[ID]!;
    expect(entry.phase).toBe("unavailable");
    expect(entry).not.toHaveProperty("body");
    expect(entry).not.toHaveProperty("receivedAt");

    store.applyConfig(KEY, { config: { rev: 2 } }, 3000);
    entry = store.view().entriesById[ID]!;
    expect(entry.phase).toBe("loaded");
    expect(entry.body).toEqual({ config: { rev: 2 } });
  });
});

describe("ConfigStore (client) - refresh flag", () => {
  it("noteRefreshRequested sets the flag; a config arrival clears it", () => {
    const store = new ConfigStore();
    store.applyConfig(KEY, { config: {} }, 1000);
    store.noteRefreshRequested(KEY);
    expect(store.view().entriesById[ID]!.refreshing).toBe(true);

    store.applyConfig(KEY, { config: { fresh: true } }, 2000);
    expect(store.view().entriesById[ID]!.refreshing).toBe(false);
  });

  it("clearRefreshing (the client-side timeout) clears without touching the body", () => {
    const store = new ConfigStore();
    store.applyConfig(KEY, { config: { rev: 1 } }, 1000);
    store.noteRefreshRequested(KEY);
    store.clearRefreshing(KEY);
    const entry = store.view().entriesById[ID]!;
    expect(entry.refreshing).toBe(false);
    expect(entry.body).toEqual({ config: { rev: 1 } });

    store.clearRefreshing(KEY); // idempotent, no entry churn
    store.clearRefreshing(key("gw-09", "nobody")); // unknown key — no-op
  });

  it("a refresh on a never-requested key creates a loading entry (defensive)", () => {
    const store = new ConfigStore();
    store.noteRefreshRequested(KEY);
    expect(store.view().entriesById[ID]).toMatchObject({ phase: "loading", refreshing: true });
  });
});

describe("ConfigStore (client) - view identity", () => {
  it("view() is identity-stable until the store changes", () => {
    const store = new ConfigStore();
    store.noteRequested(KEY);
    const a = store.view();
    const b = store.view();
    expect(a).toBe(b);

    store.applyConfig(KEY, { config: {} }, 1000);
    const c = store.view();
    expect(c).not.toBe(a);
    expect(store.view()).toBe(c);
  });
});

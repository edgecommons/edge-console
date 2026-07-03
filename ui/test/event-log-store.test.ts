/**
 * EventLogStore (C6 client fold core): backlog replace, live prepend with id
 * dedup, the client-side cap, and view identity stability. Pure — no sockets.
 */
import { describe, expect, it } from "vitest";
import { EventLogStore } from "../src/fleet/event-log-store";
import { consoleEvent } from "./_fixtures";

describe("EventLogStore - backlog fold", () => {
  it("replaces the list wholesale, normalized newest-first", () => {
    const store = new EventLogStore();
    store.applyEvent(consoleEvent({ id: 99, type: "stale-local" }));

    // Out-of-order wire input still folds newest-first (ids are arrival order).
    store.applyBacklog([
      consoleEvent({ id: 1, type: "first" }),
      consoleEvent({ id: 3, type: "third" }),
      consoleEvent({ id: 2, type: "second" }),
    ]);

    expect(store.view().entries.map((e) => e.type)).toEqual(["third", "second", "first"]);
  });

  it("an empty backlog (server restarted) clears the log", () => {
    const store = new EventLogStore();
    store.applyEvent(consoleEvent({ id: 5 }));
    store.applyBacklog([]);
    expect(store.view().entries).toEqual([]);
  });

  it("caps the backlog to the client bound (newest kept)", () => {
    const store = new EventLogStore(2);
    store.applyBacklog([1, 2, 3].map((id) => consoleEvent({ id, type: `e${id}` })));
    expect(store.view().entries.map((e) => e.type)).toEqual(["e3", "e2"]);
  });
});

describe("EventLogStore - live fold", () => {
  it("prepends live events, dedups by id, and honors the cap", () => {
    const store = new EventLogStore(3);
    store.applyBacklog([consoleEvent({ id: 2, type: "b" }), consoleEvent({ id: 1, type: "a" })]);

    store.applyEvent(consoleEvent({ id: 3, type: "c" }));
    store.applyEvent(consoleEvent({ id: 3, type: "c-again" })); // duplicate id — dropped
    expect(store.view().entries.map((e) => e.type)).toEqual(["c", "b", "a"]);

    store.applyEvent(consoleEvent({ id: 4, type: "d" })); // cap 3 — oldest drops
    expect(store.view().entries.map((e) => e.type)).toEqual(["d", "c", "b"]);
  });
});

describe("EventLogStore - view identity", () => {
  it("is identity-stable between folds and fresh after one", () => {
    const store = new EventLogStore();
    const v1 = store.view();
    expect(store.view()).toBe(v1);

    store.applyEvent(consoleEvent({ id: 1 }));
    const v2 = store.view();
    expect(v2).not.toBe(v1);
    expect(store.view()).toBe(v2);

    store.applyEvent(consoleEvent({ id: 1 })); // dedup: no change, no bump
    expect(store.view()).toBe(v2);
  });
});

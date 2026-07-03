/**
 * EventStore (C6) — the rolling `evt` history: attribution, the lenient
 * severity/type channel split, the fleet-wide and per-component drop-oldest caps,
 * newest-first reads, and the arrival-listener fanout. Pure, injected clock.
 */
import { describe, expect, it } from "vitest";
import type { ComponentKey, ConsoleEvent } from "@edgecommons/edge-console-protocol";

import { EventStore } from "../src/fleet/event-store";
import type { IngressEvent } from "../src/ingress/normalizer";

class TestClock {
  now = 1_000_000;
  tick(ms: number): void {
    this.now += ms;
  }
  fn = (): number => this.now;
}

const KEY: ComponentKey = { device: "gw-01", component: "opcua-adapter", instance: "main" };

function evtEvent(
  channel: string | undefined,
  body: unknown = { message: "boom" },
  key: ComponentKey = KEY,
): IngressEvent {
  return {
    kind: "envelope",
    cls: "evt",
    ...(channel !== undefined ? { channel } : {}),
    identity: {
      hier: [
        { level: "site", value: "dallas" },
        { level: "device", value: key.device },
      ],
      path: `dallas/${key.device}`,
      component: key.component,
      instance: key.instance,
    },
    body,
    sourceTimestamp: "2026-07-03T00:00:00.000Z",
    topic: `ecv1/${key.device}/${key.component}/${key.instance}/evt${channel !== undefined ? `/${channel}` : ""}`,
  };
}

describe("EventStore - ingest and attribution", () => {
  it("stores an evt envelope with the severity/type split, receipt stamp, and monotonic ids", () => {
    const clock = new TestClock();
    const store = new EventStore(clock.fn);

    store.ingest(evtEvent("critical/overtemp", { valueC: 91 }));
    clock.tick(1000);
    store.ingest(evtEvent("warning/slave-retry"));

    const recent = store.recent();
    expect(recent).toHaveLength(2);
    // Newest first.
    expect(recent[0]).toMatchObject({
      id: 2,
      severity: "warning",
      type: "slave-retry",
      channel: "warning/slave-retry",
      receivedAt: 1_001_000,
    });
    expect(recent[1]).toMatchObject({
      id: 1,
      key: KEY,
      severity: "critical",
      type: "overtemp",
      body: { valueC: 91 },
      receivedAt: 1_000_000,
      sourceTimestamp: "2026-07-03T00:00:00.000Z",
    });
  });

  it("splits open-class channel shapes leniently", () => {
    const clock = new TestClock();
    const store = new EventStore(clock.fn);
    store.ingest(evtEvent("overtemp")); // bare type — not a known severity
    store.ingest(evtEvent("critical")); // bare KNOWN severity, unnamed type
    store.ingest(evtEvent("machine1/started/now")); // multi-token type remainder
    store.ingest(evtEvent(undefined)); // no channel at all

    const [noChannel, multi, sevOnly, bareType] = store.recent();
    expect(bareType).toMatchObject({ type: "overtemp" });
    expect(bareType!.severity).toBeUndefined();
    expect(sevOnly).toMatchObject({ severity: "critical", type: "(unnamed)" });
    expect(multi).toMatchObject({ severity: "machine1", type: "started/now" });
    expect(noChannel).toMatchObject({ type: "(unnamed)" });
    expect(noChannel!.channel).toBeUndefined();
  });

  it("ignores non-evt classes, raw messages, and unattributable identities", () => {
    const clock = new TestClock();
    const store = new EventStore(clock.fn);

    store.ingest({ ...evtEvent("warning/x"), cls: "metric" } as IngressEvent);
    store.ingest({ kind: "device-unreachable", device: "gw-01", topic: "t" });
    store.ingest({ kind: "ignored", cls: "evt", topic: "t", reason: "raw-non-lwt" });
    const noDevice = evtEvent("warning/x");
    (noDevice as { identity: { hier: unknown[] } }).identity.hier = [];
    store.ingest(noDevice);

    expect(store.size()).toBe(0);
  });
});

describe("EventStore - rolling caps (drop-oldest)", () => {
  it("caps the fleet-wide ring, dropping the oldest", () => {
    const clock = new TestClock();
    const store = new EventStore(clock.fn, { maxEvents: 3 });
    for (let i = 1; i <= 5; i++) store.ingest(evtEvent(`info/e${i}`));

    expect(store.size()).toBe(3);
    expect(store.recent().map((e) => e.type)).toEqual(["e5", "e4", "e3"]); // newest first
  });

  it("caps per component independently — a noisy component can't evict the quiet one's history", () => {
    const clock = new TestClock();
    const store = new EventStore(clock.fn, { maxEvents: 100, maxPerComponent: 2 });
    const quiet: ComponentKey = { device: "gw-02", component: "modbus-adapter", instance: "main" };

    store.ingest(evtEvent("info/quiet-1", {}, quiet));
    for (let i = 1; i <= 5; i++) store.ingest(evtEvent(`info/noisy-${i}`));

    expect(store.recentFor(KEY).map((e) => e.type)).toEqual(["noisy-5", "noisy-4"]);
    expect(store.recentFor(quiet).map((e) => e.type)).toEqual(["quiet-1"]);
    // The fleet ring keeps everything within its own (larger) cap.
    expect(store.size()).toBe(6);
  });

  it("honors the read limits (newest-first prefixes)", () => {
    const clock = new TestClock();
    const store = new EventStore(clock.fn);
    for (let i = 1; i <= 4; i++) store.ingest(evtEvent(`info/e${i}`));

    expect(store.recent(2).map((e) => e.type)).toEqual(["e4", "e3"]);
    expect(store.recentFor(KEY, 1).map((e) => e.type)).toEqual(["e4"]);
    expect(store.recent(99)).toHaveLength(4); // limit past the size — everything
    expect(store.recentFor({ ...KEY, device: "nope" })).toEqual([]);
  });
});

describe("EventStore - listener fanout", () => {
  it("notifies each stored event and honors unsubscribe", () => {
    const clock = new TestClock();
    const store = new EventStore(clock.fn);
    const seen: ConsoleEvent[] = [];
    const off = store.onEvent((e) => seen.push(e));

    store.ingest(evtEvent("warning/one"));
    expect(seen.map((e) => e.type)).toEqual(["one"]);

    off();
    store.ingest(evtEvent("warning/two"));
    expect(seen).toHaveLength(1);
  });

  it("does not notify for dropped (non-evt) ingests", () => {
    const clock = new TestClock();
    const store = new EventStore(clock.fn);
    let calls = 0;
    store.onEvent(() => calls++);
    store.ingest({ kind: "ignored", cls: "evt", topic: "t", reason: "missing-identity" });
    expect(calls).toBe(0);
  });
});

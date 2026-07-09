/**
 * LogStore (C6) — folds UNS `log/{level}` envelopes into bounded, component-scoped
 * tails and fans out live arrivals without polluting the FleetModel LKV stream.
 */
import { describe, expect, it } from "vitest";
import type { ComponentKey } from "@edgecommons/edge-console-protocol";

import { LogStore } from "../src/fleet/log-store";
import type { IngressEvent } from "../src/ingress/normalizer";

class TestClock {
  now = 1_000_000;
  tick(ms: number): void {
    this.now += ms;
  }
  fn = (): number => this.now;
}

const KEY: ComponentKey = { device: "gw-01", component: "opcua-adapter" };

function logEvent(
  channel: string | undefined,
  body: unknown,
  key: ComponentKey = KEY,
): IngressEvent {
  return {
    kind: "envelope",
    cls: "log",
    ...(channel !== undefined ? { channel } : {}),
    identity: {
      hier: [{ level: "device", value: key.device }],
      path: key.device,
      component: key.component,
      instance: "main",
    },
    body,
    tags: { source: "test" },
    sourceTimestamp: "2026-07-03T00:00:00.000Z",
    topic: `ecv1/${key.device}/${key.component}/main/log${channel !== undefined ? `/${channel}` : ""}`,
  };
}

function body(message: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "edgecommons.log.v1",
    timestamp: "2026-07-03T00:00:01.000Z",
    logger: "opcua.session",
    message,
    sequence: 7,
    thread: "worker-1",
    fields: { endpoint: "opc.tcp://kep:49320" },
    error: { type: "TimeoutError", message: "browse timed out" },
    ...extra,
  };
}

describe("LogStore - ingest", () => {
  it("folds structured log envelopes into newest-first component tails", () => {
    const clock = new TestClock();
    const store = new LogStore(clock.fn);

    store.ingest(logEvent("warn", body("browse slow")));
    clock.tick(1000);
    store.ingest(logEvent("error", body("browse failed", { sequence: 8, truncated: true })));

    const rows = store.recentFor(KEY);
    expect(rows.map((r) => r.message)).toEqual(["browse failed", "browse slow"]);
    expect(rows[0]).toMatchObject({
      id: 2,
      key: KEY,
      instance: "main",
      level: "error",
      logger: "opcua.session",
      receivedAt: 1_001_000,
      sourceTimestamp: "2026-07-03T00:00:01.000Z",
      sequence: 8,
      thread: "worker-1",
      fields: { endpoint: "opc.tcp://kep:49320" },
      error: { type: "TimeoutError", message: "browse timed out" },
      truncated: true,
      channel: "error",
      tags: { source: "test" },
    });
  });

  it("honors level, sinceId, and limit queries", () => {
    const store = new LogStore(new TestClock().fn);
    store.ingest(logEvent("info", body("ready", { sequence: 1 })));
    store.ingest(logEvent("warn", body("retry", { sequence: 2 })));
    store.ingest(logEvent("error", body("failed", { sequence: 3 })));

    expect(store.recentFor(KEY, { levels: ["warn", "error"] }).map((r) => r.message)).toEqual([
      "failed",
      "retry",
    ]);
    expect(store.recentFor(KEY, { sinceId: 1 }).map((r) => r.message)).toEqual(["failed", "retry"]);
    expect(store.recentFor(KEY, { limit: 1 }).map((r) => r.message)).toEqual(["failed"]);
  });

  it("dedupes publisher retries and tracks per-component retention drops", () => {
    const store = new LogStore(new TestClock().fn, { maxPerComponent: 2 });
    store.ingest(logEvent("info", body("same", { sequence: 1 })));
    store.ingest(logEvent("info", body("same", { sequence: 1 })));
    store.ingest(logEvent("info", body("next", { sequence: 2 })));
    store.ingest(logEvent("info", body("last", { sequence: 3 })));

    expect(store.recentFor(KEY).map((r) => r.message)).toEqual(["last", "next"]);
    expect(store.droppedFor(KEY)).toBe(1);
  });

  it("counts malformed or unattributable log envelopes without throwing", () => {
    const store = new LogStore(new TestClock().fn);
    store.ingest(logEvent("banana", body("bad level")));
    store.ingest(logEvent("info", { logger: "app" }));
    const noDevice = logEvent("info", body("no device"));
    (noDevice as { identity: { hier: unknown[] } }).identity.hier = [];
    store.ingest(noDevice);
    store.ingest({ ...logEvent("info", body("wrong class")), cls: "evt" } as IngressEvent);

    expect(store.recentFor(KEY)).toEqual([]);
    expect(store.malformedDropped()).toBe(3);
  });
});

describe("LogStore - fanout", () => {
  it("notifies live listeners and detaches cleanly", () => {
    const store = new LogStore(new TestClock().fn);
    const batches: string[][] = [];
    const off = store.onLog((_key, records) => batches.push(records.map((r) => r.message)));

    store.ingest(logEvent("info", body("one", { sequence: 1 })));
    off();
    store.ingest(logEvent("info", body("two", { sequence: 2 })));

    expect(batches).toEqual([["one"]]);
  });
});

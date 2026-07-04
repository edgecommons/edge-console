import { describe, expect, it } from "vitest";

import { ConfigStore } from "../src/fleet/config-store";
import type { StoredConfig } from "../src/fleet/config-store";
import type { IngressEvent } from "../src/ingress/normalizer";

/** A manually-advanced clock (matches fleet-model.test.ts). */
class TestClock {
  now = 1_000_000;
  tick(ms: number): void {
    this.now += ms;
  }
  fn = (): number => this.now;
}

/** A `cfg` envelope event, as the normalizer emits it. */
function cfgEvent(
  body: unknown,
  {
    device = "gw-01",
    component = "modbus-adapter",
    instance = "main",
    sourceTimestamp,
  }: { device?: string; component?: string; instance?: string; sourceTimestamp?: string } = {},
): IngressEvent {
  return {
    kind: "envelope",
    cls: "cfg",
    identity: {
      hier: [
        { level: "site", value: "dallas" },
        { level: "device", value: device },
      ],
      path: `dallas/${device}`,
      component,
      instance,
    },
    body,
    ...(sourceTimestamp !== undefined ? { sourceTimestamp } : {}),
    topic: `ecv1/${device}/${component}/${instance}/cfg`,
  };
}

const KEY = { device: "gw-01", component: "modbus-adapter" };

describe("ConfigStore - cfg retention", () => {
  it("retains a cfg envelope body VERBATIM (redaction pass-through), stamped with the clock", () => {
    const clock = new TestClock();
    const store = new ConfigStore(clock.fn);
    const body = {
      config: {
        heartbeat: { intervalSecs: 5 },
        messaging: { local: { credentials: { password: "***" } } }, // lib-redacted
        apiKey: "$secret:northbound", // vault ref, untouched
      },
    };
    store.ingest(cfgEvent(body, { sourceTimestamp: "2026-07-03T00:00:00.000Z" }));

    expect(store.size()).toBe(1);
    expect(store.get(KEY)).toEqual({
      key: KEY,
      body, // exact same shape — nothing stripped, nothing un-redacted
      receivedAt: clock.now,
      sourceTimestamp: "2026-07-03T00:00:00.000Z",
    });
  });

  it("latest-wins: a newer announcement replaces the older one wholesale", () => {
    const clock = new TestClock();
    const store = new ConfigStore(clock.fn);
    store.ingest(cfgEvent({ config: { rev: 1, old: true } }));
    clock.tick(5000);
    store.ingest(cfgEvent({ config: { rev: 2 } }));

    const entry = store.get(KEY);
    expect(entry?.body).toEqual({ config: { rev: 2 } }); // no merge — replacement
    expect(entry?.receivedAt).toBe(clock.now);
    expect(store.size()).toBe(1);
  });

  it("keys by (device, component) — a component has ONE config (a stray instance-token cfg folds to it)", () => {
    const clock = new TestClock();
    const store = new ConfigStore(clock.fn);
    store.ingest(cfgEvent({ config: { i: "main" } }));
    store.ingest(cfgEvent({ config: { i: "line2" } }, { instance: "line2" }));

    // Config is per-component (published under `main`); any instance-token cfg folds to the one entry.
    expect(store.size()).toBe(1);
    expect(store.get(KEY)?.body).toEqual({ config: { i: "line2" } });
  });

  it("omits sourceTimestamp when the publisher sent none", () => {
    const store = new ConfigStore(new TestClock().fn);
    store.ingest(cfgEvent({ config: {} }));
    expect(store.get(KEY)).not.toHaveProperty("sourceTimestamp");
  });

  it("get() for a component that never pushed cfg is undefined", () => {
    const store = new ConfigStore(new TestClock().fn);
    expect(store.get(KEY)).toBeUndefined();
  });

  it("ignores everything that is not an attributable cfg envelope", () => {
    const clock = new TestClock();
    const store = new ConfigStore(clock.fn);

    // Another class:
    store.ingest({ ...cfgEvent({ v: 1 }), cls: "state" } as IngressEvent);
    // Raw-LWT path:
    store.ingest({ kind: "device-unreachable", device: "gw-01", topic: "ecv1/gw-01/uns-bridge/main/state" });
    // Dropped/unattributable:
    store.ingest({ kind: "ignored", cls: "cfg", topic: "ecv1/x/y/z/cfg", reason: "missing-identity" });
    // Envelope with an empty hierarchy (no device to attribute to):
    const noHier = cfgEvent({ config: {} });
    (noHier as { identity: { hier: unknown[] } }).identity.hier = [];
    store.ingest(noHier);

    expect(store.size()).toBe(0);
  });
});

describe("ConfigStore - onUpdate fanout hook", () => {
  it("notifies listeners with the fresh entry on every retained cfg; unsubscribe detaches", () => {
    const clock = new TestClock();
    const store = new ConfigStore(clock.fn);
    const seen: StoredConfig[] = [];
    const off = store.onUpdate((entry) => seen.push(entry));

    store.ingest(cfgEvent({ config: { rev: 1 } }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ key: KEY, body: { config: { rev: 1 } } });

    // Non-cfg ingest never notifies.
    store.ingest({ kind: "ignored", cls: "cfg", topic: "t", reason: "raw-non-lwt" });
    expect(seen).toHaveLength(1);

    off();
    store.ingest(cfgEvent({ config: { rev: 2 } }));
    expect(seen).toHaveLength(1); // detached
    expect(store.get(KEY)?.body).toEqual({ config: { rev: 2 } }); // retention unaffected
  });
});

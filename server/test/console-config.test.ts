import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { Config, validate } from "@edgecommons/ggcommons";

import {
  DEFAULT_CONSOLE_CONFIG,
  DEFAULT_STALENESS,
  consoleConfigFromGlobal,
} from "../src/console-config";

describe("consoleConfigFromGlobal", () => {
  it("returns full defaults for an absent/empty/non-object global subtree", () => {
    for (const global of [undefined, null, {}, { console: {} }, "nope", 42]) {
      expect(consoleConfigFromGlobal(global)).toEqual(DEFAULT_CONSOLE_CONFIG);
    }
  });

  it("applies explicit overrides field-by-field", () => {
    const parsed = consoleConfigFromGlobal({
      console: {
        ws: { port: 9443, bindAddress: "10.0.0.5", heartbeatIntervalMs: 30000 },
        staleness: {
          warnMultiplier: 1.5,
          staleMultiplier: 3,
          offlineMultiplier: 6,
          defaultIntervalSecs: 10,
          sweepIntervalMs: 500,
        },
        cache: { maxChannelsPerComponent: 64 },
        events: { maxEvents: 200, maxPerComponent: 20 },
        metrics: { maxSeriesPoints: 30, maxSeries: 500 },
      },
    });
    expect(parsed).toEqual({
      ws: { port: 9443, bindAddress: "10.0.0.5", heartbeatIntervalMs: 30000 },
      staleness: {
        warnMultiplier: 1.5,
        staleMultiplier: 3,
        offlineMultiplier: 6,
        defaultIntervalSecs: 10,
        sweepIntervalMs: 500,
      },
      cache: { maxChannelsPerComponent: 64 },
      events: { maxEvents: 200, maxPerComponent: 20 },
      metrics: { maxSeriesPoints: 30, maxSeries: 500 },
    });
  });

  it("falls back per-field on malformed values (lenient, lib house style)", () => {
    const parsed = consoleConfigFromGlobal({
      console: {
        ws: { port: 999999, bindAddress: "", heartbeatIntervalMs: -1 },
        staleness: { defaultIntervalSecs: "-1", sweepIntervalMs: 0.4 },
        cache: { maxChannelsPerComponent: -5 },
        events: { maxEvents: 0, maxPerComponent: "lots" },
        metrics: { maxSeriesPoints: null, maxSeries: -1 },
      },
    });
    expect(parsed).toEqual(DEFAULT_CONSOLE_CONFIG);
  });

  it("rejects a non-increasing staleness ladder wholesale back to the defaults", () => {
    const parsed = consoleConfigFromGlobal({
      console: { staleness: { warnMultiplier: 5, staleMultiplier: 2.5, offlineMultiplier: 5 } },
    });
    expect(parsed.staleness).toEqual(DEFAULT_STALENESS);
  });

  it("keeps a valid custom ladder", () => {
    const parsed = consoleConfigFromGlobal({
      console: { staleness: { warnMultiplier: 1.1, staleMultiplier: 1.2, offlineMultiplier: 1.3 } },
    });
    expect(parsed.staleness.warnMultiplier).toBe(1.1);
    expect(parsed.staleness.staleMultiplier).toBe(1.2);
    expect(parsed.staleness.offlineMultiplier).toBe(1.3);
  });
});

describe("test-configs/config.json - the shipped sample", () => {
  const raw: unknown = JSON.parse(
    readFileSync(join(__dirname, "..", "..", "test-configs", "config.json"), "utf8"),
  );

  it("validates against the canonical ggcommons config schema", () => {
    expect(() => validate(raw)).not.toThrow();
  });

  it("resolves the console's identity and parses the console section", () => {
    const config = Config.fromValue("com.edgecommons.edge-console", "gw-01", raw);
    expect(config.componentIdentity.component).toBe("edge-console");
    expect(config.componentIdentity.device).toBe("gw-01");

    const parsed = consoleConfigFromGlobal(config.global());
    expect(parsed.ws.port).toBe(8443);
    expect(parsed.ws.heartbeatIntervalMs).toBe(DEFAULT_CONSOLE_CONFIG.ws.heartbeatIntervalMs);
    expect(parsed.staleness).toEqual(DEFAULT_STALENESS);
    expect(parsed.cache.maxChannelsPerComponent).toBe(1024);
  });
});

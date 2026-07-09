import { readFileSync } from "fs";
import { join, resolve } from "path";
import { describe, expect, it } from "vitest";
import { Config, validate } from "@edgecommons/edgecommons";

import {
  BRIDGE_REPLY_TTL_MS,
  DEFAULT_COMMANDS_CONFIG,
  DEFAULT_CONSOLE_CONFIG,
  DEFAULT_STALENESS,
  consoleConfigFromGlobal,
} from "../src/console-config";
import { DEFAULT_RBAC_CONFIG } from "../src/command/rbac";

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
        logs: { maxRecords: 800, maxPerComponent: 80, defaultTail: 40, maxTail: 400 },
        rbac: {
          defaultRole: "viewer",
          roles: {
            operator: { allow: ["*"], deny: ["reboot"] },
            viewer: { allow: ["ping"] },
          },
        },
        commands: {
          defaultTimeoutMs: 20000,
          maxTimeoutMs: 40000,
          verbTimeouts: { ping: 8000 },
        },
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
      logs: { maxRecords: 800, maxPerComponent: 80, defaultTail: 40, maxTail: 400 },
      rbac: {
        defaultRole: "viewer",
        roles: {
          operator: { allow: ["*"], deny: ["reboot"] },
          viewer: { allow: ["ping"], deny: [] },
        },
      },
      commands: {
        defaultTimeoutMs: 20000,
        maxTimeoutMs: 40000,
        verbTimeouts: { ping: 8000 },
      },
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

describe("consoleConfigFromGlobal - the static-UI web root (console.ws.webRoot)", () => {
  it("is absent by default - the opt-in, backward-compatible default (no static serving)", () => {
    expect(consoleConfigFromGlobal({}).ws.webRoot).toBeUndefined();
    expect(consoleConfigFromGlobal({ console: { ws: {} } }).ws.webRoot).toBeUndefined();
  });

  it("resolves a relative path against the process cwd", () => {
    const parsed = consoleConfigFromGlobal({ console: { ws: { webRoot: "ui/dist" } } });
    expect(parsed.ws.webRoot).toBe(resolve(process.cwd(), "ui/dist"));
  });

  it("normalizes (but keeps) an already-absolute path", () => {
    const abs = resolve(process.cwd(), "some", "..", "other", "dist");
    const parsed = consoleConfigFromGlobal({ console: { ws: { webRoot: abs } } });
    expect(parsed.ws.webRoot).toBe(resolve(abs));
  });

  it("treats an empty string the same as absent", () => {
    expect(consoleConfigFromGlobal({ console: { ws: { webRoot: "" } } }).ws.webRoot).toBeUndefined();
  });

  it("ignores a non-string value", () => {
    expect(consoleConfigFromGlobal({ console: { ws: { webRoot: 42 } } }).ws.webRoot).toBeUndefined();
  });
});

describe("consoleConfigFromGlobal - the C4 rbac policy", () => {
  it("defaults to the permissive built-in policy when absent", () => {
    expect(consoleConfigFromGlobal({}).rbac).toEqual(DEFAULT_RBAC_CONFIG);
  });

  it("parses declared roles, cleaning allow/deny to string arrays", () => {
    const parsed = consoleConfigFromGlobal({
      console: {
        rbac: {
          defaultRole: "operator",
          roles: {
            operator: { allow: ["*"] },
            viewer: { allow: ["ping", 3, "get-configuration"], deny: ["reload-config"] },
          },
        },
      },
    });
    expect(parsed.rbac.defaultRole).toBe("operator");
    expect(parsed.rbac.roles.operator).toEqual({ allow: ["*"], deny: [] });
    // The non-string `3` is dropped; deny preserved.
    expect(parsed.rbac.roles.viewer).toEqual({
      allow: ["ping", "get-configuration"],
      deny: ["reload-config"],
    });
  });

  it("falls back to the default policy when defaultRole names an undeclared role (footgun guard)", () => {
    const parsed = consoleConfigFromGlobal({
      console: { rbac: { defaultRole: "ghost", roles: { operator: { allow: ["*"] } } } },
    });
    expect(parsed.rbac).toEqual(DEFAULT_RBAC_CONFIG);
  });
});

describe("consoleConfigFromGlobal - the C4 command timeouts", () => {
  it("defaults to 30 s / 60 s cap / 10 s ping", () => {
    expect(consoleConfigFromGlobal({}).commands).toEqual(DEFAULT_COMMANDS_CONFIG);
  });

  it("caps every timeout at the bridge reply-map TTL and floors default at the max", () => {
    const parsed = consoleConfigFromGlobal({
      console: {
        commands: {
          defaultTimeoutMs: 999999, // above the (also-capped) max
          maxTimeoutMs: 999999, // capped to 60 s
          verbTimeouts: { ping: 5000, "slow-verb": 999999 },
        },
      },
    });
    expect(parsed.commands.maxTimeoutMs).toBe(BRIDGE_REPLY_TTL_MS);
    expect(parsed.commands.defaultTimeoutMs).toBe(BRIDGE_REPLY_TTL_MS);
    expect(parsed.commands.verbTimeouts).toEqual({ ping: 5000, "slow-verb": BRIDGE_REPLY_TTL_MS });
  });

  it("drops non-positive verb timeouts and keeps the ping default when the section is empty", () => {
    const parsed = consoleConfigFromGlobal({
      console: { commands: { verbTimeouts: {} } },
    });
    expect(parsed.commands.verbTimeouts).toEqual({ ping: 10000 });
  });
});

describe("test-configs/config.json - the shipped sample", () => {
  const raw: unknown = JSON.parse(
    readFileSync(join(__dirname, "..", "..", "test-configs", "config.json"), "utf8"),
  );

  it("validates against the canonical edgecommons config schema", () => {
    expect(() => validate(raw)).not.toThrow();
  });

  it("resolves the console's identity and parses the console section", () => {
    const config = Config.fromValue("com.mbreissi.edgecommons.EdgeConsole", "gw-01", raw);
    expect(config.componentIdentity.component).toBe("edge-console");
    expect(config.componentIdentity.device).toBe("gw-01");

    const parsed = consoleConfigFromGlobal(config.global());
    expect(parsed.ws.port).toBe(8443);
    expect(parsed.ws.heartbeatIntervalMs).toBe(DEFAULT_CONSOLE_CONFIG.ws.heartbeatIntervalMs);
    expect(parsed.staleness).toEqual(DEFAULT_STALENESS);
    expect(parsed.cache.maxChannelsPerComponent).toBe(1024);
  });
});

import { describe, expect, it } from "vitest";

import { consoleSettings } from "../src/fleet/console-settings";
import { DEFAULT_CONSOLE_CONFIG, consoleConfigFromGlobal } from "../src/console-config";
import type { ConsoleSelfInfo } from "../src/fleet/console-self";

const SELF: ConsoleSelfInfo = {
  device: "gw-dallas-01",
  component: "edge-console",
  platform: "HOST",
  transport: "MQTT",
  broker: "EMQX @ gateway",
};

describe("consoleSettings projector", () => {
  it("projects the default config into the read-only settings shape", () => {
    const s = consoleSettings(DEFAULT_CONSOLE_CONFIG, SELF);

    // RBAC: default role + both built-in roles (sorted), the default flagged.
    expect(s.rbac.defaultRole).toBe("operator");
    expect(s.rbac.roles.map((r) => r.name)).toEqual(["operator", "viewer"]);
    expect(s.rbac.roles.find((r) => r.name === "operator")).toEqual({
      name: "operator",
      allow: ["*"],
      deny: [],
      isDefault: true,
    });
    expect(s.rbac.roles.find((r) => r.name === "viewer")?.isDefault).toBe(false);

    // Connection: the self-identity is folded in, plus the WS listener from the config.
    // servesUi is false: DEFAULT_CONSOLE_CONFIG has no ws.webRoot configured.
    expect(s.connection).toEqual({
      device: "gw-dallas-01",
      component: "edge-console",
      platform: "HOST",
      transport: "MQTT",
      broker: "EMQX @ gateway",
      wsPort: 8443,
      wsBindAddress: "0.0.0.0",
      heartbeatIntervalMs: 15000,
      servesUi: false,
    });

    // Thresholds / commands / retention mirror the config verbatim.
    expect(s.staleness).toEqual({
      warnMultiplier: 2,
      staleMultiplier: 2.5,
      offlineMultiplier: 5,
      defaultIntervalSecs: 5,
      sweepIntervalMs: 1000,
    });
    expect(s.commands).toEqual({
      defaultTimeoutMs: 30000,
      maxTimeoutMs: 60000,
      verbTimeouts: [{ verb: "ping", ms: 10000 }],
    });
    expect(s.retention).toEqual({
      maxChannelsPerComponent: 1024,
      maxEvents: 1000,
      maxPerComponent: 100,
      maxSeriesPoints: 60,
      maxSeries: 2000,
      maxLogRecords: 5000,
      maxLogsPerComponent: 1000,
      defaultLogTail: 500,
      maxLogTail: 2000,
    });
  });

  it("omits connection-identity fields the console does not know (no fabrication)", () => {
    const s = consoleSettings(DEFAULT_CONSOLE_CONFIG);
    expect(s.connection.device).toBeUndefined();
    expect(s.connection.platform).toBeUndefined();
    expect(s.connection.transport).toBeUndefined();
    expect(s.connection.broker).toBeUndefined();
    // The WS listener is always known (it is the console's own config).
    expect(s.connection.wsPort).toBe(8443);
    expect(s.connection.heartbeatIntervalMs).toBe(15000);
  });

  it("flags servesUi true once console.ws.webRoot is configured", () => {
    const config = consoleConfigFromGlobal({ console: { ws: { webRoot: "/srv/console/ui-dist" } } });
    expect(consoleSettings(config).connection.servesUi).toBe(true);
    expect(consoleSettings(DEFAULT_CONSOLE_CONFIG).connection.servesUi).toBe(false);
  });

  it("reflects overridden config (roles sorted, default flagged, verb timeouts sorted)", () => {
    const config = consoleConfigFromGlobal({
      console: {
        rbac: {
          defaultRole: "viewer",
          roles: {
            operator: { allow: ["*"], deny: ["reboot"] },
            viewer: { allow: ["ping", "get-configuration"] },
          },
        },
        commands: { verbTimeouts: { reload: 20000, ping: 10000 } },
        ws: { port: 9443, bindAddress: "10.0.0.5", heartbeatIntervalMs: 30000 },
      },
    });
    const s = consoleSettings(config, SELF);

    expect(s.rbac.defaultRole).toBe("viewer");
    expect(s.rbac.roles.map((r) => r.name)).toEqual(["operator", "viewer"]);
    expect(s.rbac.roles.find((r) => r.name === "viewer")?.isDefault).toBe(true);
    expect(s.rbac.roles.find((r) => r.name === "operator")?.deny).toEqual(["reboot"]);
    // verbTimeouts sorted by verb name.
    expect(s.commands.verbTimeouts).toEqual([
      { verb: "ping", ms: 10000 },
      { verb: "reload", ms: 20000 },
    ]);
    expect(s.connection.wsPort).toBe(9443);
    expect(s.connection.wsBindAddress).toBe("10.0.0.5");
  });

  it("returns fresh arrays (mutating the projection does not touch the config)", () => {
    const config = consoleConfigFromGlobal({});
    const s = consoleSettings(config, SELF);
    s.rbac.roles[0]!.allow.push("mutated");
    expect(config.rbac.roles["operator"]!.allow).toEqual(["*"]);
  });
});

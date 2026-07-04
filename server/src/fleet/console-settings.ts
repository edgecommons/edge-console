/**
 * The console's own effective policy + configuration projection (slice R6).
 *
 * The console read its `component.global.console` subtree at startup ({@link ConsoleConfig})
 * and knows its own static self-identity + site-bus transport ({@link ConsoleSelfInfo}); the
 * read-only Settings screen shows both. This pure function projects those two honestly-sourced
 * inputs into the wire {@link ConsoleSettings} — a curated, order-stable copy (roles sorted, the
 * default role flagged; per-verb timeouts sorted) that the WS gateway pushes on connect.
 *
 * Pure, no IO/clock — unit-testable in isolation, and safe to call once per `hello`.
 */
import type { ConsoleSettings, ConsoleSettingsRole } from "@edgecommons/edge-console-protocol";
import type { ConsoleConfig } from "../console-config";
import type { ConsoleSelfInfo } from "./console-self";

/**
 * Project the console's parsed config (+ optional static self-identity) into the read-only
 * {@link ConsoleSettings} the Settings screen renders. The connection-identity fields are
 * included only when `self` supplies them (a console with no self-identity wired omits them
 * honestly, rather than fabricating a host).
 */
export function consoleSettings(config: ConsoleConfig, self?: ConsoleSelfInfo): ConsoleSettings {
  const roles: ConsoleSettingsRole[] = Object.entries(config.rbac.roles)
    .map(([name, policy]) => ({
      name,
      allow: [...policy.allow],
      deny: [...policy.deny],
      isDefault: name === config.rbac.defaultRole,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const verbTimeouts = Object.entries(config.commands.verbTimeouts)
    .map(([verb, ms]) => ({ verb, ms }))
    .sort((a, b) => a.verb.localeCompare(b.verb));

  return {
    rbac: { defaultRole: config.rbac.defaultRole, roles },
    connection: {
      ...(self?.device !== undefined ? { device: self.device } : {}),
      ...(self?.component !== undefined ? { component: self.component } : {}),
      ...(self?.platform !== undefined ? { platform: self.platform } : {}),
      ...(self?.transport !== undefined ? { transport: self.transport } : {}),
      ...(self?.broker !== undefined ? { broker: self.broker } : {}),
      wsPort: config.ws.port,
      wsBindAddress: config.ws.bindAddress,
      heartbeatIntervalMs: config.ws.heartbeatIntervalMs,
    },
    staleness: {
      warnMultiplier: config.staleness.warnMultiplier,
      staleMultiplier: config.staleness.staleMultiplier,
      offlineMultiplier: config.staleness.offlineMultiplier,
      defaultIntervalSecs: config.staleness.defaultIntervalSecs,
      sweepIntervalMs: config.staleness.sweepIntervalMs,
    },
    commands: {
      defaultTimeoutMs: config.commands.defaultTimeoutMs,
      maxTimeoutMs: config.commands.maxTimeoutMs,
      verbTimeouts,
    },
    retention: {
      maxChannelsPerComponent: config.cache.maxChannelsPerComponent,
      maxEvents: config.events.maxEvents,
      maxPerComponent: config.events.maxPerComponent,
      maxSeriesPoints: config.metrics.maxSeriesPoints,
      maxSeries: config.metrics.maxSeries,
    },
  };
}

/**
 * The console's own configuration, read from **`component.global.console`** in the
 * component config document (reconciliation G12: component-specific knobs live in the
 * component's own permissive `component.global` subtree — the bridge precedent — so no
 * canonical-schema change is needed; the old M12 "console section" mandate dissolved).
 *
 * Parsing is deliberately lenient with defaults, matching the ggcommons config-model
 * house style (`HeartbeatConfig` et al.): a missing/malformed section or field falls
 * back to its default rather than failing the component.
 */
import { logger } from "@edgecommons/ggcommons";

/** Staleness/miss-detection thresholds (DESIGN §6.2 / D5: warn 2x, stale 2.5x, offline 5x). */
export interface StalenessConfig {
  /** Age > warnMultiplier x expected interval => WARN. Default 2. */
  warnMultiplier: number;
  /** Age > staleMultiplier x expected interval => STALE. Default 2.5. */
  staleMultiplier: number;
  /** Age > offlineMultiplier x expected interval => OFFLINE. Default 5. */
  offlineMultiplier: number;
  /** Expected keepalive interval (seconds) until a component's `cfg` announces one. Default 5. */
  defaultIntervalSecs: number;
  /** The liveness sweeper period (ms). Default 1000. */
  sweepIntervalMs: number;
}

/** The C2 WS gateway endpoint + timing settings. */
export interface WsConfig {
  /** TCP port the HTTP+WS gateway binds. Default 8443. */
  port: number;
  /** Bind address. Default "0.0.0.0". */
  bindAddress: string;
  /** Server->client heartbeat cadence (ms); also the tick granularity for evicting a client that never sends `hello`. Default 15000. */
  heartbeatIntervalMs: number;
}

/** FleetModel cache bounds. */
export interface CacheConfig {
  /** Max distinct `(class, channel)` cache entries per component; overflow is dropped + counted. Default 1024. */
  maxChannelsPerComponent: number;
}

/** The parsed `component.global.console` section. */
export interface ConsoleConfig {
  ws: WsConfig;
  staleness: StalenessConfig;
  cache: CacheConfig;
}

/** The default staleness trio + cadence default (DESIGN §6.2 / reconciliation G4). */
export const DEFAULT_STALENESS: StalenessConfig = {
  warnMultiplier: 2,
  staleMultiplier: 2.5,
  offlineMultiplier: 5,
  defaultIntervalSecs: 5,
  sweepIntervalMs: 1000,
};

/** The full console-config defaults. */
export const DEFAULT_CONSOLE_CONFIG: ConsoleConfig = {
  ws: { port: 8443, bindAddress: "0.0.0.0", heartbeatIntervalMs: 15000 },
  staleness: DEFAULT_STALENESS,
  cache: { maxChannelsPerComponent: 1024 },
};

function obj(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A finite positive number, or the default. */
function positiveNumber(value: unknown, dflt: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : dflt;
}

/** A positive integer (floats truncated, matching the lib's lenient numerics), or the default. */
function positiveInt(value: unknown, dflt: number): number {
  const n = positiveNumber(value, dflt);
  return Math.trunc(n) >= 1 ? Math.trunc(n) : dflt;
}

/** A 1-65535 TCP port, or the default. */
function port(value: unknown, dflt: number): number {
  const n = positiveInt(value, dflt);
  return n >= 1 && n <= 65535 ? n : dflt;
}

/**
 * Parses the console section out of the component's `component.global` subtree
 * (i.e. pass `gg.config().global()`). Lenient with per-field defaults; a staleness
 * trio that is not strictly increasing (warn < stale < offline) is rejected wholesale
 * back to the defaults (a misordered ladder would make transitions nonsensical).
 */
export function consoleConfigFromGlobal(global: unknown): ConsoleConfig {
  const console_ = obj(obj(global).console);
  const ws = obj(console_.ws);
  const staleness = obj(console_.staleness);
  const cache = obj(console_.cache);

  let warnMultiplier = positiveNumber(staleness.warnMultiplier, DEFAULT_STALENESS.warnMultiplier);
  let staleMultiplier = positiveNumber(staleness.staleMultiplier, DEFAULT_STALENESS.staleMultiplier);
  let offlineMultiplier = positiveNumber(
    staleness.offlineMultiplier,
    DEFAULT_STALENESS.offlineMultiplier,
  );
  if (!(warnMultiplier < staleMultiplier && staleMultiplier < offlineMultiplier)) {
    logger.warn(
      `console.staleness multipliers must be strictly increasing (warn < stale < offline); ` +
        `got ${warnMultiplier}/${staleMultiplier}/${offlineMultiplier} - using defaults`,
    );
    warnMultiplier = DEFAULT_STALENESS.warnMultiplier;
    staleMultiplier = DEFAULT_STALENESS.staleMultiplier;
    offlineMultiplier = DEFAULT_STALENESS.offlineMultiplier;
  }

  return {
    ws: {
      port: port(ws.port, DEFAULT_CONSOLE_CONFIG.ws.port),
      bindAddress:
        typeof ws.bindAddress === "string" && ws.bindAddress !== ""
          ? ws.bindAddress
          : DEFAULT_CONSOLE_CONFIG.ws.bindAddress,
      heartbeatIntervalMs: positiveInt(
        ws.heartbeatIntervalMs,
        DEFAULT_CONSOLE_CONFIG.ws.heartbeatIntervalMs,
      ),
    },
    staleness: {
      warnMultiplier,
      staleMultiplier,
      offlineMultiplier,
      defaultIntervalSecs: positiveInt(
        staleness.defaultIntervalSecs,
        DEFAULT_STALENESS.defaultIntervalSecs,
      ),
      sweepIntervalMs: positiveInt(staleness.sweepIntervalMs, DEFAULT_STALENESS.sweepIntervalMs),
    },
    cache: {
      maxChannelsPerComponent: positiveInt(
        cache.maxChannelsPerComponent,
        DEFAULT_CONSOLE_CONFIG.cache.maxChannelsPerComponent,
      ),
    },
  };
}

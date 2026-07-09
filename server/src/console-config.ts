/**
 * The console's own configuration, read from **`component.global.console`** in the
 * component config document (reconciliation G12: component-specific knobs live in the
 * component's own permissive `component.global` subtree — the bridge precedent — so no
 * canonical-schema change is needed; the old M12 "console section" mandate dissolved).
 *
 * Parsing is deliberately lenient with defaults, matching the edgecommons config-model
 * house style (`HeartbeatConfig` et al.): a missing/malformed section or field falls
 * back to its default rather than failing the component.
 */
import { resolve } from "node:path";
import { logger } from "@edgecommons/edgecommons";
import { DEFAULT_RBAC_CONFIG } from "./command/rbac";
import type { RbacConfig, RolePolicy } from "./command/rbac";

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
  /**
   * Absolute filesystem path to the built UI (`ui/dist`) to serve on this same HTTP+WS
   * origin, resolved against the process cwd when given as a relative path. **Opt-in**:
   * absent (the default) means the console serves ONLY `/healthz` + the `/ws` upgrade,
   * exactly as before this option existed — no static serving, `/` still 404s. Set it to
   * make the console a genuinely self-contained deployment (no nginx/Vite sidecar needed).
   */
  webRoot?: string;
}

/** FleetModel cache bounds. */
export interface CacheConfig {
  /** Max distinct `(class, channel)` cache entries per component; overflow is dropped + counted. Default 1024. */
  maxChannelsPerComponent: number;
}

/** The C6 rolling-event-history bounds (both drop-oldest). */
export interface EventsConfig {
  /** Fleet-wide recent-events ring capacity. Default 1000. */
  maxEvents: number;
  /** Per-component recent-events ring capacity. Default 100. */
  maxPerComponent: number;
}

/** The C6 metric-surface bounds. */
export interface MetricsConfig {
  /** Recent points kept per `(component, metric, measure)` series. Default 60. */
  maxSeriesPoints: number;
  /** Max distinct series overall; overflow is dropped + counted. Default 2000. */
  maxSeries: number;
}

/** The component log-tail bounds. */
export interface LogsConfig {
  /** Fleet-wide recent-log ring capacity. Default 5000. */
  maxRecords: number;
  /** Per-component recent-log ring capacity. Default 1000. */
  maxPerComponent: number;
  /** Default rows requested by a component detail tail. Default 500. */
  defaultTail: number;
  /** Maximum rows a client may request in one tail snapshot. Default 2000. */
  maxTail: number;
}

/** The C4 command-gateway timeout policy (all ms; every value ≤ the bridge reply-map TTL). */
export interface CommandsConfig {
  /** Default per-command deadline when a verb has no specific override. Default 30000. */
  defaultTimeoutMs: number;
  /** The hard ceiling — the uns-bridge reply-map TTL (paired-knob rule). Default & cap 60000. */
  maxTimeoutMs: number;
  /** Per-verb deadline overrides (ms). Default `{ ping: 10000 }`. */
  verbTimeouts: Record<string, number>;
}

/** The parsed `component.global.console` section. */
export interface ConsoleConfig {
  ws: WsConfig;
  staleness: StalenessConfig;
  cache: CacheConfig;
  events: EventsConfig;
  metrics: MetricsConfig;
  logs: LogsConfig;
  /** The C4 command authorization policy (`console.rbac`). */
  rbac: RbacConfig;
  /** The C4 command timeout policy (`console.commands`). */
  commands: CommandsConfig;
}

/** The absolute command-timeout ceiling — the uns-bridge reply-map TTL (D-B9). */
export const BRIDGE_REPLY_TTL_MS = 60_000;

/** The command-gateway timeout defaults (30 s default / 60 s cap / 10 s ping). */
export const DEFAULT_COMMANDS_CONFIG: CommandsConfig = {
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: BRIDGE_REPLY_TTL_MS,
  verbTimeouts: { ping: 10_000 },
};

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
  events: { maxEvents: 1000, maxPerComponent: 100 },
  metrics: { maxSeriesPoints: 60, maxSeries: 2000 },
  logs: { maxRecords: 5000, maxPerComponent: 1000, defaultTail: 500, maxTail: 2000 },
  rbac: DEFAULT_RBAC_CONFIG,
  commands: DEFAULT_COMMANDS_CONFIG,
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

/** A non-empty string, or the default. */
function nonEmptyString(value: unknown, dflt: string): string {
  return typeof value === "string" && value !== "" ? value : dflt;
}

/**
 * The static web-root path, resolved against the process cwd (relative) or normalized
 * (absolute); `undefined` for an absent/malformed value — the opt-in "no static serving"
 * default (`path.resolve` with a single argument already falls back to `process.cwd()`
 * for a relative input, and passes an absolute input through normalized).
 */
function webRootPath(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? resolve(value) : undefined;
}

/** The string entries of an array (non-strings dropped), or `[]` for a non-array. */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Parse the `console.rbac` section into a normalized {@link RbacConfig}. Lenient: an
 * absent/malformed section is the permissive default; each role's `allow`/`deny` are
 * cleaned to string arrays. A `defaultRole` naming a role that does not exist would deny
 * everything (a footgun), so that misconfiguration falls back wholesale to the defaults
 * (the staleness-ladder precedent).
 */
function parseRbac(value: unknown): RbacConfig {
  const rbac = obj(value);
  const rolesRaw = obj(rbac.roles);
  const roleNames = Object.keys(rolesRaw);
  if (roleNames.length === 0) {
    // No roles declared: keep the whole default policy (its defaultRole is guaranteed valid).
    return DEFAULT_RBAC_CONFIG;
  }
  const roles: Record<string, RolePolicy> = {};
  for (const name of roleNames) {
    const policy = obj(rolesRaw[name]);
    roles[name] = { allow: stringArray(policy.allow), deny: stringArray(policy.deny) };
  }
  const defaultRole = nonEmptyString(rbac.defaultRole, DEFAULT_RBAC_CONFIG.defaultRole);
  if (roles[defaultRole] === undefined) {
    logger.warn(
      `console.rbac.defaultRole '${defaultRole}' is not one of the declared roles ` +
        `(${roleNames.join(", ")}) - using the default RBAC policy`,
    );
    return DEFAULT_RBAC_CONFIG;
  }
  return { defaultRole, roles };
}

/**
 * Parse the `console.commands` section. Lenient with per-field defaults; every timeout is
 * capped at {@link BRIDGE_REPLY_TTL_MS} (the paired-knob rule — a per-command deadline
 * above the bridge's reply-map TTL could outlive the reply path).
 */
function parseCommands(value: unknown): CommandsConfig {
  const commands = obj(value);
  const cap = (ms: number): number => Math.min(BRIDGE_REPLY_TTL_MS, ms);
  const maxTimeoutMs = cap(positiveInt(commands.maxTimeoutMs, DEFAULT_COMMANDS_CONFIG.maxTimeoutMs));
  const defaultTimeoutMs = Math.min(
    maxTimeoutMs,
    positiveInt(commands.defaultTimeoutMs, DEFAULT_COMMANDS_CONFIG.defaultTimeoutMs),
  );
  const verbTimeouts: Record<string, number> = {};
  const rawVerbs = obj(commands.verbTimeouts);
  const source = Object.keys(rawVerbs).length > 0 ? rawVerbs : DEFAULT_COMMANDS_CONFIG.verbTimeouts;
  for (const [verb, ms] of Object.entries(source)) {
    if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) {
      verbTimeouts[verb] = cap(Math.trunc(ms));
    }
  }
  return { defaultTimeoutMs, maxTimeoutMs, verbTimeouts };
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
  const events = obj(console_.events);
  const metrics = obj(console_.metrics);
  const logs = obj(console_.logs);
  const rbac = parseRbac(console_.rbac);
  const commands = parseCommands(console_.commands);

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

  const webRoot = webRootPath(ws.webRoot);

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
      ...(webRoot !== undefined ? { webRoot } : {}),
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
    events: {
      maxEvents: positiveInt(events.maxEvents, DEFAULT_CONSOLE_CONFIG.events.maxEvents),
      maxPerComponent: positiveInt(
        events.maxPerComponent,
        DEFAULT_CONSOLE_CONFIG.events.maxPerComponent,
      ),
    },
    metrics: {
      maxSeriesPoints: positiveInt(
        metrics.maxSeriesPoints,
        DEFAULT_CONSOLE_CONFIG.metrics.maxSeriesPoints,
      ),
      maxSeries: positiveInt(metrics.maxSeries, DEFAULT_CONSOLE_CONFIG.metrics.maxSeries),
    },
    logs: {
      maxRecords: positiveInt(logs.maxRecords, DEFAULT_CONSOLE_CONFIG.logs.maxRecords),
      maxPerComponent: positiveInt(
        logs.maxPerComponent,
        DEFAULT_CONSOLE_CONFIG.logs.maxPerComponent,
      ),
      defaultTail: Math.min(
        positiveInt(logs.defaultTail, DEFAULT_CONSOLE_CONFIG.logs.defaultTail),
        positiveInt(logs.maxTail, DEFAULT_CONSOLE_CONFIG.logs.maxTail),
      ),
      maxTail: positiveInt(logs.maxTail, DEFAULT_CONSOLE_CONFIG.logs.maxTail),
    },
    rbac,
    commands,
  };
}

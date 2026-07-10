use serde_json::{Map, Value, json};

use crate::RuntimeInfo;

pub const BRIDGE_REPLY_TTL_MS: u64 = 60_000;

#[derive(Debug, Clone)]
pub struct StalenessConfig {
    pub warn_multiplier: f64,
    pub stale_multiplier: f64,
    pub offline_multiplier: f64,
    pub default_interval_secs: u64,
    pub sweep_interval_ms: u64,
}

#[derive(Debug, Clone)]
pub struct WsConfig {
    pub port: u16,
    pub bind_address: String,
    pub heartbeat_interval_ms: u64,
    pub web_root: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CacheConfig {
    pub max_channels_per_component: usize,
}

#[derive(Debug, Clone)]
pub struct EventsConfig {
    pub max_events: usize,
    pub max_per_component: usize,
}

#[derive(Debug, Clone)]
pub struct MetricsConfig {
    pub max_series_points: usize,
    pub max_series: usize,
}

#[derive(Debug, Clone)]
pub struct LogsConfig {
    pub max_records: usize,
    pub max_per_component: usize,
    pub default_tail: usize,
    pub max_tail: usize,
}

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    pub worker_threads: usize,
    pub malloc_arena_max: Option<usize>,
    pub event_buffer_capacity: usize,
}

#[derive(Debug, Clone)]
pub struct RolePolicy {
    pub allow: Vec<String>,
    pub deny: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct RbacConfig {
    pub default_role: String,
    pub roles: Map<String, Value>,
}

#[derive(Debug, Clone)]
pub struct CommandsConfig {
    pub default_timeout_ms: u64,
    pub max_timeout_ms: u64,
    pub verb_timeouts: Map<String, Value>,
}

/// Clock-fault detection: the backward-step alarm threshold and the quiet window that
/// clears the alarm.
#[derive(Debug, Clone)]
pub struct ClockConfig {
    pub step_alarm_threshold_ms: u64,
    pub clear_after_quiet_secs: u64,
}

#[derive(Debug, Clone)]
pub struct ConsoleConfig {
    pub ws: WsConfig,
    pub staleness: StalenessConfig,
    pub cache: CacheConfig,
    pub events: EventsConfig,
    pub metrics: MetricsConfig,
    pub logs: LogsConfig,
    pub runtime: RuntimeConfig,
    pub rbac: RbacConfig,
    pub commands: CommandsConfig,
    pub clock: ClockConfig,
}

impl Default for ConsoleConfig {
    fn default() -> Self {
        Self {
            ws: WsConfig {
                port: 8443,
                bind_address: "0.0.0.0".to_string(),
                heartbeat_interval_ms: 15_000,
                web_root: None,
            },
            staleness: StalenessConfig {
                warn_multiplier: 2.0,
                stale_multiplier: 2.5,
                offline_multiplier: 5.0,
                default_interval_secs: 5,
                sweep_interval_ms: 1_000,
            },
            cache: CacheConfig {
                max_channels_per_component: 1024,
            },
            events: EventsConfig {
                max_events: 1000,
                max_per_component: 100,
            },
            metrics: MetricsConfig {
                max_series_points: 60,
                max_series: 2000,
            },
            logs: LogsConfig {
                max_records: 5000,
                max_per_component: 1000,
                default_tail: 500,
                max_tail: 2000,
            },
            runtime: RuntimeConfig {
                worker_threads: 4,
                malloc_arena_max: Some(2),
                event_buffer_capacity: 512,
            },
            rbac: RbacConfig {
                default_role: "operator".to_string(),
                roles: default_roles(),
            },
            commands: CommandsConfig {
                default_timeout_ms: 30_000,
                max_timeout_ms: BRIDGE_REPLY_TTL_MS,
                verb_timeouts: Map::from_iter([("ping".to_string(), Value::from(10_000))]),
            },
            // 250 ms: NTP slews stay < 128 ms, so anything >= 250 ms backward is unambiguous
            // clock trouble. 600 s of quiet clears the alarm.
            clock: ClockConfig {
                step_alarm_threshold_ms: 250,
                clear_after_quiet_secs: 600,
            },
        }
    }
}

impl ConsoleConfig {
    pub fn from_global(global: &Value) -> Self {
        let defaults = ConsoleConfig::default();
        let console = object(object(Some(global)).get("console"));
        let ws = object(console.get("ws"));
        let staleness = object(console.get("staleness"));
        let cache = object(console.get("cache"));
        let events = object(console.get("events"));
        let metrics = object(console.get("metrics"));
        let logs = object(console.get("logs"));
        let runtime = object(console.get("runtime"));
        let clock = object(console.get("clock"));

        let mut warn = positive_f64(
            staleness.get("warnMultiplier"),
            defaults.staleness.warn_multiplier,
        );
        let mut stale = positive_f64(
            staleness.get("staleMultiplier"),
            defaults.staleness.stale_multiplier,
        );
        let mut offline = positive_f64(
            staleness.get("offlineMultiplier"),
            defaults.staleness.offline_multiplier,
        );
        if !(warn < stale && stale < offline) {
            warn = defaults.staleness.warn_multiplier;
            stale = defaults.staleness.stale_multiplier;
            offline = defaults.staleness.offline_multiplier;
            tracing::warn!(
                "console.staleness multipliers must be strictly increasing; using defaults"
            );
        }

        let max_tail = positive_usize(logs.get("maxTail"), defaults.logs.max_tail);
        let default_tail =
            positive_usize(logs.get("defaultTail"), defaults.logs.default_tail).min(max_tail);
        let mut config = Self {
            ws: WsConfig {
                port: port(ws.get("port"), defaults.ws.port),
                bind_address: non_empty(ws.get("bindAddress"), &defaults.ws.bind_address),
                heartbeat_interval_ms: positive_u64(
                    ws.get("heartbeatIntervalMs"),
                    defaults.ws.heartbeat_interval_ms,
                ),
                web_root: ws
                    .get("webRoot")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(resolve_path),
            },
            staleness: StalenessConfig {
                warn_multiplier: warn,
                stale_multiplier: stale,
                offline_multiplier: offline,
                default_interval_secs: positive_u64(
                    staleness.get("defaultIntervalSecs"),
                    defaults.staleness.default_interval_secs,
                ),
                sweep_interval_ms: positive_u64(
                    staleness.get("sweepIntervalMs"),
                    defaults.staleness.sweep_interval_ms,
                ),
            },
            cache: CacheConfig {
                max_channels_per_component: positive_usize(
                    cache.get("maxChannelsPerComponent"),
                    defaults.cache.max_channels_per_component,
                ),
            },
            events: EventsConfig {
                max_events: positive_usize(events.get("maxEvents"), defaults.events.max_events),
                max_per_component: positive_usize(
                    events.get("maxPerComponent"),
                    defaults.events.max_per_component,
                ),
            },
            metrics: MetricsConfig {
                max_series_points: positive_usize(
                    metrics.get("maxSeriesPoints"),
                    defaults.metrics.max_series_points,
                ),
                max_series: positive_usize(metrics.get("maxSeries"), defaults.metrics.max_series),
            },
            logs: LogsConfig {
                max_records: positive_usize(logs.get("maxRecords"), defaults.logs.max_records),
                max_per_component: positive_usize(
                    logs.get("maxPerComponent"),
                    defaults.logs.max_per_component,
                ),
                default_tail,
                max_tail,
            },
            runtime: RuntimeConfig {
                worker_threads: positive_usize(
                    runtime.get("workerThreads"),
                    defaults.runtime.worker_threads,
                )
                .min(128),
                malloc_arena_max: optional_positive_usize(runtime.get("mallocArenaMax"))
                    .or(defaults.runtime.malloc_arena_max),
                event_buffer_capacity: positive_usize(
                    runtime.get("eventBufferCapacity"),
                    defaults.runtime.event_buffer_capacity,
                )
                .clamp(16, 4096),
            },
            rbac: parse_rbac(console.get("rbac")).unwrap_or(defaults.rbac),
            commands: parse_commands(console.get("commands"), defaults.commands),
            clock: ClockConfig {
                step_alarm_threshold_ms: positive_u64(
                    clock.get("stepAlarmThresholdMs"),
                    defaults.clock.step_alarm_threshold_ms,
                ),
                clear_after_quiet_secs: positive_u64(
                    clock.get("clearAfterQuietSecs"),
                    defaults.clock.clear_after_quiet_secs,
                ),
            },
        };
        config.commands.max_timeout_ms = config.commands.max_timeout_ms.min(BRIDGE_REPLY_TTL_MS);
        config.commands.default_timeout_ms = config
            .commands
            .default_timeout_ms
            .min(config.commands.max_timeout_ms);
        config
    }

    /// The `settings` frame body — a curated, read-only projection of the parsed console policy.
    /// The connection identity and the *effective* launch-latched runtime values come from
    /// [`RuntimeInfo`] (built once at startup, right where this is encoded once into the frame).
    pub fn settings(&self, runtime: &RuntimeInfo) -> Value {
        let mut roles: Vec<Value> = self
            .rbac
            .roles
            .iter()
            .map(|(name, policy)| {
                let policy = object(Some(policy));
                json!({
                    "name": name,
                    "allow": string_array(policy.get("allow")),
                    "deny": string_array(policy.get("deny")),
                    "isDefault": name == &self.rbac.default_role,
                })
            })
            .collect();
        roles.sort_by(|a, b| {
            a.get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .cmp(b.get("name").and_then(Value::as_str).unwrap_or(""))
        });
        let mut verb_timeouts: Vec<Value> = self
            .commands
            .verb_timeouts
            .iter()
            .filter_map(|(verb, ms)| ms.as_u64().map(|ms| json!({ "verb": verb, "ms": ms })))
            .collect();
        verb_timeouts.sort_by(|a, b| {
            a.get("verb")
                .and_then(Value::as_str)
                .unwrap_or("")
                .cmp(b.get("verb").and_then(Value::as_str).unwrap_or(""))
        });

        let mut runtime_block = Map::from_iter([
            (
                "workerThreads".to_string(),
                Value::from(self.runtime.worker_threads),
            ),
            (
                "effectiveWorkerThreads".to_string(),
                Value::from(runtime.worker_threads),
            ),
            (
                "eventBufferCapacity".to_string(),
                Value::from(self.runtime.event_buffer_capacity),
            ),
            ("launchLatched".to_string(), Value::from(true)),
        ]);
        if let Some(n) = self.runtime.malloc_arena_max {
            runtime_block.insert("mallocArenaMax".to_string(), Value::from(n));
        }
        if let Some(n) = runtime.malloc_arena_max {
            runtime_block.insert("effectiveMallocArenaMax".to_string(), Value::from(n));
        }

        json!({
            // Feature detection: the UI enables summary-mode subscribe + get-signal-points
            // only when this capability is advertised (protocol version stays 7).
            "capabilities": {
                "signalsSummary": true,
            },
            "rbac": {
                "defaultRole": self.rbac.default_role,
                "roles": roles,
            },
            "connection": {
                "device": runtime.device,
                "component": runtime.component,
                "platform": runtime.platform,
                "transport": runtime.transport,
                "broker": runtime.broker,
                "wsPort": self.ws.port,
                "wsBindAddress": self.ws.bind_address,
                "heartbeatIntervalMs": self.ws.heartbeat_interval_ms,
                "servesUi": self.ws.web_root.is_some(),
            },
            "staleness": {
                "warnMultiplier": self.staleness.warn_multiplier,
                "staleMultiplier": self.staleness.stale_multiplier,
                "offlineMultiplier": self.staleness.offline_multiplier,
                "defaultIntervalSecs": self.staleness.default_interval_secs,
                "sweepIntervalMs": self.staleness.sweep_interval_ms,
            },
            "commands": {
                "defaultTimeoutMs": self.commands.default_timeout_ms,
                "maxTimeoutMs": self.commands.max_timeout_ms,
                "verbTimeouts": verb_timeouts,
            },
            "runtime": Value::Object(runtime_block),
            "retention": {
                "maxChannelsPerComponent": self.cache.max_channels_per_component,
                "maxEvents": self.events.max_events,
                "maxPerComponent": self.events.max_per_component,
                "maxSeriesPoints": self.metrics.max_series_points,
                "maxSeries": self.metrics.max_series,
                "maxLogRecords": self.logs.max_records,
                "maxLogsPerComponent": self.logs.max_per_component,
                "defaultLogTail": self.logs.default_tail,
                "maxLogTail": self.logs.max_tail,
            },
        })
    }
}

pub fn rbac_can(rbac: &RbacConfig, role: &str, verb: &str) -> bool {
    let Some(policy) = rbac.roles.get(role).map(|v| object(Some(v))) else {
        return false;
    };
    let deny = string_array(policy.get("deny"));
    if deny.iter().any(|v| v == "*" || v == verb) {
        return false;
    }
    let allow = string_array(policy.get("allow"));
    allow.iter().any(|v| v == "*" || v == verb)
}

fn parse_rbac(value: Option<&Value>) -> Option<RbacConfig> {
    let rbac = object(value);
    let roles = object(rbac.get("roles"));
    if roles.is_empty() {
        return None;
    }
    let default_role = rbac
        .get("defaultRole")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("operator");
    if !roles.contains_key(default_role) {
        tracing::warn!(
            default_role,
            "console.rbac.defaultRole is not declared; using default RBAC policy"
        );
        return None;
    }
    Some(RbacConfig {
        default_role: default_role.to_string(),
        roles: roles.clone(),
    })
}

fn parse_commands(value: Option<&Value>, defaults: CommandsConfig) -> CommandsConfig {
    let commands = object(value);
    let max_timeout_ms = positive_u64(commands.get("maxTimeoutMs"), defaults.max_timeout_ms)
        .min(BRIDGE_REPLY_TTL_MS);
    let default_timeout_ms = positive_u64(
        commands.get("defaultTimeoutMs"),
        defaults.default_timeout_ms,
    )
    .min(max_timeout_ms);
    let verbs = object(commands.get("verbTimeouts"));
    let source = if verbs.is_empty() {
        defaults.verb_timeouts
    } else {
        verbs.clone()
    };
    let mut verb_timeouts = Map::new();
    for (verb, value) in source {
        if let Some(ms) = value.as_u64().filter(|ms| *ms > 0) {
            verb_timeouts.insert(verb, Value::from(ms.min(BRIDGE_REPLY_TTL_MS)));
        }
    }
    CommandsConfig {
        default_timeout_ms,
        max_timeout_ms,
        verb_timeouts,
    }
}

fn default_roles() -> Map<String, Value> {
    Map::from_iter([
        (
            "operator".to_string(),
            json!({ "allow": ["*"], "deny": [] }),
        ),
        (
            "viewer".to_string(),
            json!({
                "allow": ["ping", "describe", "get-configuration", "sb/status", "sb/browse", "sb/read"],
                "deny": [],
            }),
        ),
    ])
}

fn object(value: Option<&Value>) -> &Map<String, Value> {
    match value.and_then(Value::as_object) {
        Some(map) => map,
        None => empty_map(),
    }
}

fn empty_map() -> &'static Map<String, Value> {
    static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
    EMPTY.get_or_init(Map::new)
}

fn positive_f64(value: Option<&Value>, default: f64) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n > 0.0)
        .unwrap_or(default)
}

fn positive_u64(value: Option<&Value>, default: u64) -> u64 {
    value
        .and_then(Value::as_u64)
        .filter(|n| *n > 0)
        .unwrap_or(default)
}

fn positive_usize(value: Option<&Value>, default: usize) -> usize {
    value
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
        .filter(|n| *n > 0)
        .unwrap_or(default)
}

fn optional_positive_usize(value: Option<&Value>) -> Option<usize> {
    value
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
        .filter(|n| *n > 0)
}

fn port(value: Option<&Value>, default: u16) -> u16 {
    value
        .and_then(Value::as_u64)
        .and_then(|n| u16::try_from(n).ok())
        .filter(|n| *n > 0)
        .unwrap_or(default)
}

fn non_empty(value: Option<&Value>, default: &str) -> String {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(default)
        .to_string()
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn resolve_path(value: &str) -> String {
    let path = std::path::Path::new(value);
    if path.is_absolute() {
        path.to_string_lossy().to_string()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from("."))
            .join(path)
            .to_string_lossy()
            .to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_runtime() -> RuntimeInfo {
        RuntimeInfo {
            device: "gw-01".to_string(),
            component: "com.mbreissi.edgecommons.EdgeConsole".to_string(),
            platform: Some("HOST".to_string()),
            transport: Some("MQTT".to_string()),
            broker: Some("emqx:1883".to_string()),
            started_at: std::time::Instant::now(),
            worker_threads: 6,
            malloc_arena_max: Some(3),
        }
    }

    #[test]
    fn settings_frame_projects_identity_and_effective_runtime() {
        let config = ConsoleConfig::from_global(&json!({
            "console": { "runtime": { "workerThreads": 4, "mallocArenaMax": 2 } }
        }));
        let settings = config.settings(&sample_runtime());

        // Connection identity comes from RuntimeInfo.
        assert_eq!(settings["connection"]["device"], "gw-01");
        assert_eq!(settings["connection"]["platform"], "HOST");
        assert_eq!(settings["connection"]["transport"], "MQTT");
        assert_eq!(settings["connection"]["broker"], "emqx:1883");
        assert_eq!(settings["connection"]["wsPort"], 8443);

        // Configured (parsed) vs effective (launch-latched) runtime values are both present.
        let rt = &settings["runtime"];
        assert_eq!(rt["workerThreads"], 4);
        assert_eq!(rt["effectiveWorkerThreads"], 6);
        assert_eq!(rt["mallocArenaMax"], 2);
        assert_eq!(rt["effectiveMallocArenaMax"], 3);
        assert_eq!(rt["launchLatched"], true);

        // Curated policy sections exist.
        assert!(settings["rbac"]["roles"].is_array());
        assert!(settings["staleness"]["warnMultiplier"].is_number());
        assert!(settings["retention"]["maxEvents"].is_number());
    }

    /// §7.1a: `console.clock` parses leniently — defaults 250 ms / 600 s, explicit positive
    /// values honored, invalid or non-positive values fall back to the defaults.
    #[test]
    fn clock_config_defaults_and_lenience() {
        let config = ConsoleConfig::from_global(&json!({}));
        assert_eq!(config.clock.step_alarm_threshold_ms, 250);
        assert_eq!(config.clock.clear_after_quiet_secs, 600);

        let config = ConsoleConfig::from_global(&json!({
            "console": { "clock": { "stepAlarmThresholdMs": 1000, "clearAfterQuietSecs": 60 } }
        }));
        assert_eq!(config.clock.step_alarm_threshold_ms, 1000);
        assert_eq!(config.clock.clear_after_quiet_secs, 60);

        let config = ConsoleConfig::from_global(&json!({
            "console": { "clock": { "stepAlarmThresholdMs": "soon", "clearAfterQuietSecs": 0 } }
        }));
        assert_eq!(config.clock.step_alarm_threshold_ms, 250);
        assert_eq!(config.clock.clear_after_quiet_secs, 600);
    }

    /// §4.1d: the settings frame advertises the summary-snapshot capability the UI
    /// feature-detects on (protocol version stays 7).
    #[test]
    fn settings_advertise_signals_summary_capability() {
        let config = ConsoleConfig::from_global(&json!({}));
        let settings = config.settings(&sample_runtime());
        assert_eq!(settings["capabilities"]["signalsSummary"], true);
    }

    #[test]
    fn defaults_match_protocol_contract() {
        let config = ConsoleConfig::from_global(&json!({}));
        assert_eq!(config.ws.port, 8443);
        assert!(rbac_can(&config.rbac, "operator", "sb/write"));
        assert!(rbac_can(&config.rbac, "viewer", "sb/read"));
        assert!(!rbac_can(&config.rbac, "viewer", "sb/write"));
        assert_eq!(config.runtime.worker_threads, 4);
        assert_eq!(config.runtime.malloc_arena_max, Some(2));
        assert_eq!(config.runtime.event_buffer_capacity, 512);
    }

    #[test]
    fn command_timeouts_are_clamped() {
        let config = ConsoleConfig::from_global(&json!({
            "console": { "commands": { "maxTimeoutMs": 120000, "defaultTimeoutMs": 90000 } }
        }));
        assert_eq!(config.commands.max_timeout_ms, BRIDGE_REPLY_TTL_MS);
        assert_eq!(config.commands.default_timeout_ms, BRIDGE_REPLY_TTL_MS);
    }

    #[test]
    fn runtime_settings_are_launch_latched_and_lenient() {
        let config = ConsoleConfig::from_global(&json!({
            "console": { "runtime": { "workerThreads": 8, "mallocArenaMax": 3 } }
        }));
        assert_eq!(config.runtime.worker_threads, 8);
        assert_eq!(config.runtime.malloc_arena_max, Some(3));
        assert_eq!(config.runtime.event_buffer_capacity, 512);

        let fallback = ConsoleConfig::from_global(&json!({
            "console": { "runtime": { "workerThreads": 0, "mallocArenaMax": 0, "eventBufferCapacity": 0 } }
        }));
        assert_eq!(fallback.runtime.worker_threads, 4);
        assert_eq!(fallback.runtime.malloc_arena_max, Some(2));
        assert_eq!(fallback.runtime.event_buffer_capacity, 512);

        let clamped = ConsoleConfig::from_global(&json!({
            "console": { "runtime": { "eventBufferCapacity": 999_999 } }
        }));
        assert_eq!(clamped.runtime.event_buffer_capacity, 4096);
    }
}

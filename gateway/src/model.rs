use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::ws::Utf8Bytes;
use edgecommons::messaging::message::{Message, MessageIdentity};
use serde::ser::SerializeSeq;
use serde::{Serialize, Serializer};
use serde_json::{Map, Value, json};

use crate::config::ConsoleConfig;
use crate::protocol::{
    ComponentKey, LogQuery, PROTOCOL_VERSION, SignalSelector, SignalsMode, is_log_level,
};

const DELTA_RING_CAP: usize = 1000;
const ATTRIBUTE_CPU_POINTS: usize = 30;
const BRIDGE_COMPONENT: &str = "uns-bridge";

#[derive(Debug, Clone)]
pub struct IngressEvent {
    pub cls: String,
    pub channel: Option<String>,
    pub identity: MessageIdentity,
    pub body: Value,
    pub tags: Option<Map<String, Value>>,
    pub received_at: u64,
    pub source_timestamp: Option<String>,
}

/// Pre-encoded fanout payloads. Each variant carrying `Utf8Bytes` holds a frame that was
/// serialized exactly once inside the Model; `.clone()` on the bytes is a refcount bump, so
/// one frame is shared across every session (G1). `Config`/`Logs` stay structured because a
/// per-session filter (`key_id`, level/sinceId) runs before the frame is emitted.
#[derive(Debug, Clone)]
pub enum GatewayEvent {
    /// Pre-encoded `{"type":"delta","protocolVersion":7,"deltas":[...]}` frame.
    Deltas(Utf8Bytes),
    /// Retained-cfg push; sessions filter on `key_id` (== `ComponentKey::id()`) before sending.
    Config { key_id: Arc<str>, frame: Utf8Bytes },
    /// Pre-encoded `{"type":"event",...}` frame.
    Event(Utf8Bytes),
    /// Pre-encoded `{"type":"metric","updates":[...]}` frame.
    Metrics(Utf8Bytes),
    /// Structured on purpose: per-session level/sinceId filters apply before encoding.
    /// Exactly one record per event (matches `ingest_log`).
    Logs {
        key_id: Arc<str>,
        record: Arc<LogRecord>,
        dropped: Option<u64>,
    },
    /// Pre-encoded `{"type":"signal","updates":[...]}` frame.
    Signals(Utf8Bytes),
    /// Pre-encoded `{"type":"attribute","updates":[...]}` frame.
    Attributes(Utf8Bytes),
    /// Pre-encoded `{"type":"alarms","snapshot":{...}}` frame.
    Alarms(Utf8Bytes),
}

/// One observed backward wall-clock step (§7.1) — surfaced once per episode; the IO edge
/// answers it with the front-door `evt/warning/clock-step` publish.
#[derive(Debug, Clone, Copy)]
pub struct ClockStepObservation {
    /// Magnitude of the backward step against the clamped receipt timeline (ms).
    pub step_ms: u64,
    /// The receipt-timeline stamp at which the step was observed.
    pub at: u64,
}

/// The result of folding one ingress event into the model.
pub struct IngestOutcome {
    pub events: Vec<GatewayEvent>,
    /// Devices first seen during this ingest — drives the republish broadcast (replaces
    /// ingress.rs's JSON-sniffing of delta frames).
    pub discovered_devices: Vec<String>,
    /// A backward clock step observed while stamping this ingest (one per episode).
    pub clock_step: Option<ClockStepObservation>,
}

/// The result of one staleness sweep tick.
pub struct SweepOutcome {
    pub events: Vec<GatewayEvent>,
    /// A backward clock step observed by the sweep's own clamped clock read.
    pub clock_step: Option<ClockStepObservation>,
    /// One-shot: the wall clock has been quiet for `console.clock.clearAfterQuietSecs`
    /// after a reported fault — the IO edge answers with the `active:false` clearing event.
    pub clock_recovered: bool,
}

// ------------------------------------------------------------------ typed records

/// A single log record, shared (`Arc`) between the global ring, the per-component ring, and
/// the live `GatewayEvent::Logs` push. Serializes to the current v7 `logs`/`log` record shape.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRecord {
    pub id: u64,
    pub key: ComponentKey,
    pub instance: String,
    pub level: String,
    pub logger: String,
    pub message: String,
    pub received_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sequence: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fields: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EventRecord {
    id: u64,
    key: ComponentKey,
    instance: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    severity: Option<String>,
    #[serde(rename = "type")]
    ty: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel: Option<String>,
    body: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    tags: Option<Map<String, Value>>,
    received_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_timestamp: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedValue {
    instance: String,
    cls: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel: Option<String>,
    body: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    tags: Option<Map<String, Value>>,
    received_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_timestamp: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
struct MetricPoint {
    at: u64,
    value: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SignalPoint {
    at: u64,
    value: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    quality: Option<String>,
    /// The sample's `sourceTs` (measured/device time), verbatim — no fold.
    /// `at` stays console receipt time for every point — one consistent time base.
    #[serde(skip_serializing_if = "Option::is_none")]
    source_ts: Option<String>,
    /// The sample's `serverTs` (protocol-server refresh time), verbatim.
    #[serde(skip_serializing_if = "Option::is_none")]
    server_ts: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MetricSeries {
    key: ComponentKey,
    instance: String,
    metric: String,
    measure: String,
    latest: f64,
    received_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_timestamp: Option<String>,
    points: VecDeque<MetricPoint>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SignalSeries {
    key: ComponentKey,
    instance: String,
    signal: String,
    latest: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    quality: Option<String>,
    received_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_timestamp: Option<String>,
    // Verbatim timestamps of the LATEST valid sample — per-sample facts, set or CLEARED on
    // every ingest (like `quality`), never latest-wins-retained. Summary-mode rows compute
    // lag from these without points.
    #[serde(skip_serializing_if = "Option::is_none")]
    source_ts: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_ts: Option<String>,
    // Canonical SouthboundSignalUpdate metadata — latest-wins, all optional.
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signal_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    address: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    adapter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    quality_raw: Option<String>,
    /// Envelope header timestamp of the latest publish (latest-wins) — the client's lag
    /// baseline (`publishedTs − (sourceTs ?? serverTs)`).
    #[serde(skip_serializing_if = "Option::is_none")]
    published_ts: Option<String>,
    points: VecDeque<SignalPoint>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AttributeState {
    key: ComponentKey,
    #[serde(skip_serializing_if = "Option::is_none")]
    cpu_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    memory_mb: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    disk_total_gb: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    disk_used_gb: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    disk_free_gb: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    threads: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    open_files: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    connection_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    read_errors: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    write_errors: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    platform: Option<String>,
    #[serde(skip_serializing_if = "VecDeque::is_empty")]
    cpu_series: VecDeque<f64>,
    /// Memory sparkline ring — the exact `cpu_series` discipline (§8.1a).
    #[serde(skip_serializing_if = "VecDeque::is_empty")]
    memory_series: VecDeque<f64>,
    received_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_timestamp: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AlarmState {
    id: String,
    key: ComponentKey,
    component_id: String,
    severity: String,
    #[serde(rename = "type")]
    ty: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    raised_at: u64,
    last_at: u64,
    count: u64,
    acked: bool,
    contained: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel: Option<String>,
}

/// A resolved alarm kept in the history ring. Never serialized to a frame today (no history
/// frame exists), but held typed rather than as `Value` per the encode-once invariant.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedAlarm {
    #[serde(flatten)]
    alarm: AlarmState,
    resolved_at: u64,
}

// ------------------------------------------------------------------ mutable records

#[derive(Debug, Clone)]
struct ComponentRecord {
    key: ComponentKey,
    path: String,
    hier: Value,
    liveness: String,
    status: Option<String>,
    uptime_secs: Option<f64>,
    last_state_at: Option<u64>,
    /// Discovery time — the staleness baseline until a first `state` arrives (B3).
    first_seen_at: u64,
    expected_interval_secs: u64,
    cadence_source: String,
    restarts: u64,
    instances: Option<Value>,
    /// LKV cache keyed by `{instance}|{cls}|{channel_or_empty}` (BTreeMap → snapshot values
    /// come out in deterministic key order).
    values: BTreeMap<String, CachedValue>,
    dropped_channels: u64,
}

#[derive(Debug, Clone)]
struct DeviceRecord {
    unreachable: bool,
    unreachable_since: Option<u64>,
    components: BTreeMap<String, ComponentRecord>,
}

/// The result of folding one event into the fleet model.
struct FleetOutcome {
    deltas: Vec<FleetDeltaBody>,
    discovered_device: Option<String>,
    /// Whether a reachability transition flipped any alarm's containment (B2) — the caller
    /// appends a fresh `Alarms` frame when set.
    alarms_changed: bool,
}

#[derive(Debug)]
pub struct Model {
    config: ConsoleConfig,
    seq: u64,
    devices: BTreeMap<String, DeviceRecord>,
    /// Recent deltas: `(seq, pre-encoded stamped-delta JSON object)`. Frames are assembled by
    /// string concatenation — each delta is serialized exactly once, at creation (1.8).
    deltas: VecDeque<(u64, Box<str>)>,
    /// Pre-encoded `config` frames keyed by `ComponentKey::id()` (1.7).
    configs: HashMap<String, Utf8Bytes>,
    events: VecDeque<Arc<EventRecord>>,
    events_by_component: HashMap<String, VecDeque<Arc<EventRecord>>>,
    next_event_id: u64,
    metrics: BTreeMap<String, MetricSeries>,
    dropped_metric_series: u64,
    logs: VecDeque<Arc<LogRecord>>,
    logs_by_component: HashMap<String, VecDeque<Arc<LogRecord>>>,
    log_drops_by_component: HashMap<String, u64>,
    log_seen: VecDeque<String>,
    log_seen_set: HashSet<String>,
    next_log_id: u64,
    signals: BTreeMap<String, SignalSeries>,
    dropped_signal_series: u64,
    attributes: BTreeMap<String, AttributeState>,
    dropped_attributes: u64,
    alarms: BTreeMap<String, AlarmState>,
    contained_devices: HashSet<String>,
    alarm_history: VecDeque<ResolvedAlarm>,
    dropped_alarms: u64,
    bus_rate: ThroughputMeter,
    /// High-water mark of the console's own receipt timeline (ms) — see [`Model::stamp`].
    last_stamp_ms: u64,
    /// A backward-step EPISODE is currently open (the wall is behind the clamped timeline).
    clock_episode_open: bool,
    /// Deepest regression seen within the open episode (tracked, never re-observed — §7.1b).
    clock_episode_max_step_ms: u64,
    /// The one observation of the currently/most-recently opened episode, until the next
    /// `ingest`/`sweep` outcome drains it.
    clock_pending_step: Option<ClockStepObservation>,
    /// Timeline stamp of the last over-threshold regressing reading — the quiet-clear baseline.
    clock_last_fault_at: u64,
    /// A clock-step fault has been reported and not yet cleared by the quiet window.
    clock_alarm_active: bool,
}

impl Model {
    pub fn new(config: ConsoleConfig) -> Self {
        Self {
            config,
            seq: 0,
            devices: BTreeMap::new(),
            deltas: VecDeque::with_capacity(DELTA_RING_CAP),
            configs: HashMap::new(),
            events: VecDeque::new(),
            events_by_component: HashMap::new(),
            next_event_id: 1,
            metrics: BTreeMap::new(),
            dropped_metric_series: 0,
            logs: VecDeque::new(),
            logs_by_component: HashMap::new(),
            log_drops_by_component: HashMap::new(),
            log_seen: VecDeque::with_capacity(2048),
            log_seen_set: HashSet::new(),
            next_log_id: 1,
            signals: BTreeMap::new(),
            dropped_signal_series: 0,
            attributes: BTreeMap::new(),
            dropped_attributes: 0,
            alarms: BTreeMap::new(),
            contained_devices: HashSet::new(),
            alarm_history: VecDeque::new(),
            dropped_alarms: 0,
            bus_rate: ThroughputMeter::default(),
            last_stamp_ms: 0,
            clock_episode_open: false,
            clock_episode_max_step_ms: 0,
            clock_pending_step: None,
            clock_last_fault_at: 0,
            clock_alarm_active: false,
        }
    }

    /// Clamp a wall-clock reading onto the console's own NON-DECREASING receipt timeline.
    /// The deployment host's wall clock can step backward (VM clock sawtooth); receipt time
    /// must never regress or the signal/points rings go non-monotonic. During a backward-step
    /// window successive events legitimately share one clamped stamp — flat time until the
    /// wall catches up — which is expected and honest.
    ///
    /// The clamp is not silent (§7.1): a reading at least `console.clock.stepAlarmThresholdMs`
    /// behind the timeline opens a backward-step EPISODE and surfaces ONE observation (drained
    /// into the next `ingest`/`sweep` outcome). While the episode is open, deeper regressions
    /// only update its tracked maximum; the episode closes when the wall catches back up to
    /// the clamped timeline, and the next over-threshold step is a new episode.
    fn stamp(&mut self, wall: u64) -> u64 {
        if wall + self.config.clock.step_alarm_threshold_ms <= self.last_stamp_ms {
            let step_ms = self.last_stamp_ms - wall;
            self.clock_last_fault_at = self.last_stamp_ms;
            if !self.clock_episode_open {
                self.clock_episode_open = true;
                self.clock_episode_max_step_ms = step_ms;
                self.clock_pending_step = Some(ClockStepObservation {
                    step_ms,
                    at: self.last_stamp_ms,
                });
                self.clock_alarm_active = true;
            } else if step_ms > self.clock_episode_max_step_ms {
                self.clock_episode_max_step_ms = step_ms;
            }
        } else if self.clock_episode_open && wall >= self.last_stamp_ms {
            // The wall caught back up to the clamped timeline — the episode closes.
            self.clock_episode_open = false;
        }
        let stamped = wall.max(self.last_stamp_ms);
        self.last_stamp_ms = stamped;
        stamped
    }

    pub fn ingest(&mut self, mut event: IngressEvent) -> IngestOutcome {
        // One clamp point under the model's single-writer discipline covers every store
        // (fleet last_state_at, points, logs, events, attributes, alarms, bus_rate).
        event.received_at = self.stamp(event.received_at);
        self.bus_rate.record(event.received_at);
        let mut events = Vec::new();
        let mut discovered_devices = Vec::new();

        let fleet = self.ingest_fleet(&event);
        if let Some(device) = fleet.discovered_device {
            discovered_devices.push(device);
        }
        if let Some(frame) = self.stamp_and_store(fleet.deltas, event.received_at) {
            events.push(GatewayEvent::Deltas(frame));
        }
        if fleet.alarms_changed {
            events.push(GatewayEvent::Alarms(self.alarms_frame()));
        }

        if event.cls == "cfg" {
            let key = key_from_identity(&event.identity);
            let frame = encode_config_frame(
                &key,
                &event.body,
                event.received_at,
                event.source_timestamp.as_deref(),
            );
            self.configs.insert(key.id(), frame.clone());
            events.push(GatewayEvent::Config {
                key_id: Arc::from(key.id()),
                frame,
            });
        }
        if event.cls == "evt"
            && let Some(evt_frame) = self.ingest_event(&event)
        {
            let alarm_changed = self.ingest_alarm_event(&event);
            events.push(GatewayEvent::Event(evt_frame));
            if alarm_changed {
                events.push(GatewayEvent::Alarms(self.alarms_frame()));
            }
        }
        if let Some(frame) = self.ingest_metrics(&event) {
            events.push(GatewayEvent::Metrics(frame));
        }
        if let Some((key_id, record, dropped)) = self.ingest_log(&event) {
            events.push(GatewayEvent::Logs {
                key_id,
                record,
                dropped,
            });
        }
        if let Some(frame) = self.ingest_signal(&event) {
            events.push(GatewayEvent::Signals(frame));
        }
        if let Some(frame) = self.ingest_attribute(&event) {
            events.push(GatewayEvent::Attributes(frame));
        }
        IngestOutcome {
            events,
            discovered_devices,
            clock_step: self.clock_pending_step.take(),
        }
    }

    pub fn sweep(&mut self) -> SweepOutcome {
        // Staleness ages on the same monotonic timeline as receipt stamps: a backward wall
        // step must not un-age (flip degraded components back FRESH) or double-age. This
        // clamped read can open/close a clock episode too (§7.1c).
        let now = self.stamp(now_ms());
        let clock_step = self.clock_pending_step.take();
        let mut bodies = Vec::new();
        for device in self.devices.values_mut() {
            if device.unreachable {
                continue;
            }
            for component in device.components.values_mut() {
                if component.status.as_deref() == Some("STOPPED") {
                    continue;
                }
                // B3: components that never sent a state age from their discovery time.
                let baseline = component.last_state_at.unwrap_or(component.first_seen_at);
                let age_secs = now.saturating_sub(baseline) as f64 / 1000.0;
                let expected = component.expected_interval_secs as f64;
                let next = if age_secs > expected * self.config.staleness.offline_multiplier {
                    "OFFLINE"
                } else if age_secs > expected * self.config.staleness.stale_multiplier {
                    "STALE"
                } else if age_secs > expected * self.config.staleness.warn_multiplier {
                    "WARN"
                } else {
                    "FRESH"
                };
                if component.liveness != next {
                    let from = component.liveness.clone();
                    component.liveness = next.to_string();
                    bodies.push(FleetDeltaBody::LivenessChanged {
                        key: component.key.clone(),
                        from,
                        to: next.to_string(),
                    });
                }
            }
        }
        let mut events = Vec::new();
        if let Some(frame) = self.stamp_and_store(bodies, now) {
            events.push(GatewayEvent::Deltas(frame));
        }
        // Quiet-clear (§7.1d): one-shot recovery once the wall has been quiet for the
        // configured window after a reported fault (and no episode is currently open).
        let clock_recovered = self.clock_alarm_active
            && !self.clock_episode_open
            && now.saturating_sub(self.clock_last_fault_at)
                >= self
                    .config
                    .clock
                    .clear_after_quiet_secs
                    .saturating_mul(1000);
        if clock_recovered {
            self.clock_alarm_active = false;
        }
        SweepOutcome {
            events,
            clock_step,
            clock_recovered,
        }
    }

    pub fn ack_alarm(&mut self, alarm_id: &str) -> Option<GatewayEvent> {
        {
            let alarm = self.alarms.get_mut(alarm_id)?;
            if alarm.acked {
                return None;
            }
            alarm.acked = true;
        }
        Some(GatewayEvent::Alarms(self.alarms_frame()))
    }

    // ------------------------------------------------------------------ read API

    /// Full `{"type":"snapshot","protocolVersion":7,"snapshot":{seq,takenAt,devices:[...]}}`,
    /// serialized single-pass through borrowing view structs (no intermediate `Value` forest).
    pub fn snapshot_frame(&self) -> Utf8Bytes {
        let devices: Vec<DeviceSnapshotView> = self
            .devices
            .iter()
            .map(|(device_id, device)| {
                let components: Vec<ComponentSnapshotView> = device
                    .components
                    .values()
                    .map(|comp| {
                        let liveness = if device.unreachable {
                            "UNREACHABLE"
                        } else {
                            comp.liveness.as_str()
                        };
                        ComponentSnapshotView {
                            key: &comp.key,
                            path: &comp.path,
                            hier: &comp.hier,
                            liveness,
                            status: comp.status.as_deref(),
                            uptime_secs: comp.uptime_secs,
                            last_state_at: comp.last_state_at,
                            expected_interval_secs: comp.expected_interval_secs,
                            cadence_source: &comp.cadence_source,
                            restarts: comp.restarts,
                            instances: comp.instances.as_ref(),
                            values: comp.values.values().collect(),
                            dropped_channels: comp.dropped_channels,
                        }
                    })
                    .collect();
                DeviceSnapshotView {
                    device: device_id,
                    unreachable: device.unreachable,
                    unreachable_since: device.unreachable_since,
                    components,
                }
            })
            .collect();
        frame(
            "snapshot",
            SnapshotBody {
                snapshot: SnapshotView {
                    seq: self.seq,
                    // Read-only clamp onto the receipt timeline (no store: &self) so a snapshot
                    // taken during a backward-step window never dates before its own deltas.
                    taken_at: now_ms().max(self.last_stamp_ms),
                    devices,
                },
            },
        )
    }

    /// The complete hello resync decision (replaces `deltas_since` + snapshot fallback):
    /// - resume provable and up-to-date  -> `None`            (send NOTHING — matches TS)
    /// - resume provable with deltas     -> `Some(delta frame)`
    /// - no `resume_seq` / gap / ahead   -> `Some(snapshot frame)`
    pub fn resync_frame(&self, resume_seq: Option<u64>) -> Option<Utf8Bytes> {
        if let Some(resume_seq) = resume_seq {
            if resume_seq == self.seq {
                return None; // up-to-date: send nothing
            }
            if resume_seq < self.seq
                && let Some((first_seq, _)) = self.deltas.front()
                && resume_seq + 1 >= *first_seq
            {
                // provable contiguous coverage — replay strictly-after deltas
                return Some(self.replay_delta_frame(resume_seq));
            }
            // resume_seq ahead of us, or a gap in the ring — fall through to a fresh snapshot.
        }
        Some(self.snapshot_frame())
    }

    /// get-config reply: the stored pre-encoded config frame (1.7). `None` => caller sends
    /// `config-unavailable`.
    pub fn config_frame_for(&self, key: &ComponentKey) -> Option<Utf8Bytes> {
        self.configs.get(&key.id()).cloned()
    }

    /// `{"type":"events","protocolVersion":7,"events":[...]}` — newest-first, capped at `limit`.
    pub fn events_frame(&self, limit: Option<usize>) -> Utf8Bytes {
        frame(
            "events",
            EventsBody {
                events: NewestFirst {
                    ring: &self.events,
                    limit: limit.unwrap_or(usize::MAX),
                },
            },
        )
    }

    /// `{"type":"metrics","protocolVersion":7,"series":[...]}`.
    pub fn metrics_frame(&self) -> Utf8Bytes {
        let series: Vec<&MetricSeries> = self.metrics.values().collect();
        frame("metrics", SeriesBody { series })
    }

    /// `{"type":"signals","protocolVersion":7,"series":[...]}`. `Summary` mode serves the same
    /// series objects with the `points` key omitted entirely (§4.1b).
    pub fn signals_frame(&self, mode: SignalsMode) -> Utf8Bytes {
        match mode {
            SignalsMode::Full => {
                let series: Vec<&SignalSeries> = self.signals.values().collect();
                frame("signals", SeriesBody { series })
            }
            SignalsMode::Summary => {
                let series: Vec<SignalSeriesSummaryView> = self
                    .signals
                    .values()
                    .map(SignalSeriesSummaryView::of)
                    .collect();
                frame("signals", SeriesBody { series })
            }
        }
    }

    /// `{"type":"signal-points","protocolVersion":7,"series":[...]}` — the `get-signal-points`
    /// reply: found series only, in request order (§4.1c).
    pub fn signal_points_frame(&self, selectors: &[SignalSelector]) -> Utf8Bytes {
        let series: Vec<SignalPointsView> = selectors
            .iter()
            .filter_map(|selector| {
                let id = format!(
                    "{}|{}|{}",
                    selector.key.id(),
                    selector.instance,
                    selector.signal
                );
                self.signals.get(&id).map(|series| SignalPointsView {
                    key: &series.key,
                    instance: &series.instance,
                    signal: &series.signal,
                    points: &series.points,
                })
            })
            .collect();
        frame("signal-points", SeriesBody { series })
    }

    /// `{"type":"attributes","protocolVersion":7,"components":[...]}`.
    pub fn attributes_frame(&self) -> Utf8Bytes {
        let components: Vec<&AttributeState> = self.attributes.values().collect();
        frame("attributes", ComponentsBody { components })
    }

    /// `{"type":"alarms","protocolVersion":7,"snapshot":{active:[...],counts:{...}}}` (also
    /// used for `GatewayEvent::Alarms`).
    pub fn alarms_frame(&self) -> Utf8Bytes {
        let mut active: Vec<&AlarmState> = self.alarms.values().collect();
        active.sort_by(|a, b| b.raised_at.cmp(&a.raised_at).then_with(|| a.id.cmp(&b.id)));
        let mut counts = AlarmCounts::default();
        for alarm in self.alarms.values() {
            if alarm.contained {
                counts.contained += 1;
                continue;
            }
            counts.active += 1;
            if alarm.severity == "critical" {
                counts.critical += 1;
            } else {
                counts.warning += 1;
            }
            if alarm.acked {
                counts.acked += 1;
            }
        }
        frame(
            "alarms",
            SnapshotBody {
                snapshot: AlarmSnapshotView { active, counts },
            },
        )
    }

    /// `{"type":"logs",...}` incl. `dropped` — newest-first, applying sinceId + levels + limit.
    pub fn logs_frame(&self, key: &ComponentKey, query: &LogQuery) -> Utf8Bytes {
        let ring = self.logs_by_component.get(&key.id());
        let dropped = self
            .log_drops_by_component
            .get(&key.id())
            .copied()
            .filter(|n| *n > 0);
        frame(
            "logs",
            LogsFrameBody {
                key,
                records: LogsView { ring, query },
                dropped,
            },
        )
    }

    pub fn bus_msgs_per_sec(&self) -> f64 {
        self.bus_rate.rate(now_ms())
    }

    pub fn bus_recent_rates(&self) -> Vec<f64> {
        self.bus_rate.recent(now_ms())
    }

    // ------------------------------------------------------------------ ingest internals

    fn ingest_fleet(&mut self, event: &IngressEvent) -> FleetOutcome {
        let mut deltas = Vec::new();
        let mut discovered_device = None;
        let mut alarms_changed = false;
        let key = key_from_identity(&event.identity);
        let device_id = key.device.clone();
        let component_id = key.component.clone();

        // 1. Ensure the device record exists (device-discovered first for a new device — TS order).
        let is_new_device = !self.devices.contains_key(&device_id);
        self.devices
            .entry(device_id.clone())
            .or_insert_with(|| DeviceRecord {
                unreachable: false,
                unreachable_since: None,
                components: BTreeMap::new(),
            });
        if is_new_device {
            deltas.push(FleetDeltaBody::DeviceDiscovered {
                device: device_id.clone(),
            });
            discovered_device = Some(device_id.clone());
        }

        // 2. Bridge LWT UNREACHABLE (B1): contain the device and return early — no component
        //    record is created/updated, nothing is cached, no state handling runs.
        if is_bridge_unreachable(event) {
            let transitioned = {
                let device = self
                    .devices
                    .get_mut(&device_id)
                    .expect("device just ensured");
                if device.unreachable {
                    false // already contained — idempotent
                } else {
                    device.unreachable = true;
                    device.unreachable_since = Some(event.received_at);
                    true
                }
            };
            if transitioned {
                let component_count = self.devices[&device_id].components.len();
                if self.set_device_containment(&device_id, true) {
                    alarms_changed = true;
                }
                deltas.push(FleetDeltaBody::DeviceReachabilityChanged {
                    device: device_id.clone(),
                    unreachable: true,
                    component_count,
                });
            }
            return FleetOutcome {
                deltas,
                discovered_device,
                alarms_changed,
            };
        }

        // 3. Otherwise: a `state` from any component of an unreachable device clears the flag
        //    and releases alarm containment.
        let cleared = {
            let device = self
                .devices
                .get_mut(&device_id)
                .expect("device just ensured");
            if device.unreachable && event.cls == "state" {
                device.unreachable = false;
                device.unreachable_since = None;
                true
            } else {
                false
            }
        };
        if cleared {
            let component_count = self.devices[&device_id].components.len();
            if self.set_device_containment(&device_id, false) {
                alarms_changed = true;
            }
            deltas.push(FleetDeltaBody::DeviceReachabilityChanged {
                device: device_id.clone(),
                unreachable: false,
                component_count,
            });
        }

        // 4. Ensure component / cache value / state / cfg handling.
        let default_interval = self.config.staleness.default_interval_secs;
        let max_channels = self.config.cache.max_channels_per_component;
        let device = self
            .devices
            .get_mut(&device_id)
            .expect("device just ensured");
        let device_unreachable = device.unreachable;
        let is_new_component = !device.components.contains_key(&component_id);
        let component = device
            .components
            .entry(component_id.clone())
            .or_insert_with(|| ComponentRecord {
                key: key.clone(),
                path: event.identity.path().to_string(),
                hier: hier_json(&event.identity),
                liveness: if device_unreachable {
                    "UNREACHABLE".to_string()
                } else {
                    "FRESH".to_string()
                },
                status: None,
                uptime_secs: None,
                last_state_at: None,
                first_seen_at: event.received_at,
                expected_interval_secs: default_interval,
                cadence_source: "default".to_string(),
                restarts: 0,
                instances: None,
                values: BTreeMap::new(),
                dropped_channels: 0,
            });
        if is_new_component {
            deltas.push(FleetDeltaBody::ComponentDiscovered {
                key: key.clone(),
                path: component.path.clone(),
                hier: component.hier.clone(),
            });
        }

        // B4: logs are high-rate tail data — kept out of the LKV cache (they'd flood the delta
        // stream with a value-updated per line and pin log bodies in the snapshot). The
        // LogStore path (ingest_log) is the only log surface — matches TS cacheValue.
        if event.cls != "log" {
            update_cache(component, event, &mut deltas, max_channels);
        }
        if event.cls == "state" {
            update_state(component, event, device_unreachable, &mut deltas);
        }
        if event.cls == "cfg" {
            update_cadence(component, event, &mut deltas);
        }
        FleetOutcome {
            deltas,
            discovered_device,
            alarms_changed,
        }
    }

    fn ingest_event(&mut self, event: &IngressEvent) -> Option<Utf8Bytes> {
        if event.cls != "evt" {
            return None;
        }
        let key = key_from_identity(&event.identity);
        let (severity, ty) = split_event_channel(event.channel.as_deref());
        let record = Arc::new(EventRecord {
            id: self.next_event_id,
            key: key.clone(),
            instance: event.identity.instance().to_string(),
            severity,
            ty,
            channel: event.channel.clone(),
            body: event.body.clone(),
            tags: event.tags.clone(),
            received_at: event.received_at,
            source_timestamp: event.source_timestamp.clone(),
        });
        self.next_event_id += 1;
        let out = frame("event", EventBody { event: &record });

        self.events.push_back(record.clone());
        while self.events.len() > self.config.events.max_events {
            self.events.pop_front();
        }
        let by_component = self.events_by_component.entry(key.id()).or_default();
        by_component.push_back(record);
        while by_component.len() > self.config.events.max_per_component {
            by_component.pop_front();
        }
        Some(out)
    }

    fn ingest_metrics(&mut self, event: &IngressEvent) -> Option<Utf8Bytes> {
        if event.cls != "metric" {
            return None;
        }
        let metric = event.channel.as_ref().filter(|s| !s.is_empty())?;
        let key = key_from_identity(&event.identity);
        let instance = event
            .body
            .get("instance")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or(event.identity.instance())
            .to_string();
        let measures = extract_metric_measures(&event.body);
        let max_points = self.config.metrics.max_series_points;
        let max_series = self.config.metrics.max_series;
        let mut updates: Vec<MetricUpdate> = Vec::new();
        for (measure, value) in &measures {
            let id = format!("{}|{}|{}|{}", key.id(), instance, metric, measure);
            if !self.metrics.contains_key(&id) && self.metrics.len() >= max_series {
                self.dropped_metric_series += 1;
                continue;
            }
            let point = MetricPoint {
                at: event.received_at,
                value: *value,
            };
            let series = self.metrics.entry(id).or_insert_with(|| MetricSeries {
                key: key.clone(),
                instance: instance.clone(),
                metric: metric.to_string(),
                measure: measure.clone(),
                latest: *value,
                received_at: event.received_at,
                source_timestamp: event.source_timestamp.clone(),
                points: VecDeque::new(),
            });
            series.latest = *value;
            series.received_at = event.received_at;
            series.source_timestamp = event.source_timestamp.clone();
            series.points.push_back(point.clone());
            while series.points.len() > max_points {
                series.points.pop_front();
            }
            updates.push(MetricUpdate {
                key: &key,
                instance: &instance,
                metric,
                measure,
                point,
                source_timestamp: event.source_timestamp.as_deref(),
            });
        }
        if updates.is_empty() {
            return None;
        }
        Some(frame("metric", UpdatesBody { updates }))
    }

    fn ingest_log(
        &mut self,
        event: &IngressEvent,
    ) -> Option<(Arc<str>, Arc<LogRecord>, Option<u64>)> {
        if event.cls != "log" {
            return None;
        }
        let body = event.body.as_object()?;
        let level = event
            .channel
            .as_deref()
            .and_then(|c| c.split('/').next())
            .filter(|s| is_log_level(s))
            .or_else(|| {
                body.get("level")
                    .and_then(Value::as_str)
                    .filter(|s| is_log_level(s))
            })?;
        let logger = body.get("logger").and_then(Value::as_str)?.to_string();
        let message = body.get("message").and_then(Value::as_str)?.to_string();
        if logger.is_empty() || message.is_empty() {
            return None;
        }
        let key = key_from_identity(&event.identity);
        let source_timestamp = body
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| event.source_timestamp.clone());
        let sequence = body.get("sequence").and_then(Value::as_u64);
        let dedupe = format!(
            "{}|{}|{}|{}|{}|{}|{}",
            key.id(),
            event.identity.instance(),
            level,
            sequence.unwrap_or(0),
            source_timestamp.as_deref().unwrap_or(""),
            logger,
            message
        );
        if self.log_seen_set.contains(&dedupe) {
            return None;
        }
        self.log_seen_set.insert(dedupe.clone());
        self.log_seen.push_back(dedupe);
        while self.log_seen.len() > 2048 {
            if let Some(old) = self.log_seen.pop_front() {
                self.log_seen_set.remove(&old);
            }
        }
        let record = Arc::new(LogRecord {
            id: self.next_log_id,
            key: key.clone(),
            instance: event.identity.instance().to_string(),
            level: level.to_string(),
            logger,
            message,
            received_at: event.received_at,
            source_timestamp,
            sequence,
            thread: body.get("thread").cloned(),
            fields: body.get("fields").cloned(),
            error: body.get("error").cloned(),
            truncated: body.get("truncated").cloned(),
            channel: event.channel.clone(),
            tags: event.tags.clone(),
        });
        self.next_log_id += 1;

        self.logs.push_back(record.clone());
        while self.logs.len() > self.config.logs.max_records {
            self.logs.pop_front();
        }
        let id = key.id();
        let comp = self.logs_by_component.entry(id.clone()).or_default();
        comp.push_back(record.clone());
        let mut dropped = None;
        if comp.len() > self.config.logs.max_per_component {
            comp.pop_front();
            let n = self.log_drops_by_component.entry(id).or_default();
            *n += 1;
            dropped = Some(*n);
        } else if let Some(n) = self
            .log_drops_by_component
            .get(&key.id())
            .copied()
            .filter(|n| *n > 0)
        {
            dropped = Some(n);
        }
        Some((Arc::from(key.id()), record, dropped))
    }

    fn ingest_signal(&mut self, event: &IngressEvent) -> Option<Utf8Bytes> {
        if event.cls != "data" {
            return None;
        }
        let signal = event.channel.as_ref().filter(|s| !s.is_empty())?;
        let extraction = extract_signal_samples(&event.body);
        if extraction.samples.is_empty() {
            // A canonical body with zero valid samples is a no-op: no series, no frame.
            return None;
        }
        let key = key_from_identity(&event.identity);
        let instance = event.identity.instance().to_string();
        let id = format!("{}|{}|{}", key.id(), instance, signal);
        if !self.signals.contains_key(&id) && self.signals.len() >= 5000 {
            self.dropped_signal_series += 1;
            return None;
        }
        // Latest = the LAST valid sample of the batch; the folded display timestamp falls back
        // sourceTs -> serverTs -> envelope header timestamp (WP-D compat, untouched).
        let last = extraction
            .samples
            .last()
            .expect("samples checked non-empty");
        let last_value = last.value.clone();
        let last_quality = last.quality.clone();
        let last_source_ts = last.source_ts.clone();
        let last_server_ts = last.server_ts.clone();
        let last_quality_raw = last.quality_raw.clone();

        let series = self.signals.entry(id).or_insert_with(|| SignalSeries {
            key: key.clone(),
            instance: instance.clone(),
            signal: signal.to_string(),
            latest: Value::Null,
            quality: None,
            received_at: event.received_at,
            source_timestamp: None,
            source_ts: None,
            server_ts: None,
            name: None,
            signal_id: None,
            address: None,
            adapter: None,
            endpoint: None,
            quality_raw: None,
            published_ts: None,
            points: VecDeque::new(),
        });
        series.latest = last_value;
        series.quality = last_quality;
        series.received_at = event.received_at;
        series.source_timestamp = last_source_ts
            .clone()
            .or_else(|| last_server_ts.clone())
            .or_else(|| event.source_timestamp.clone());
        // The verbatim pair describes the latest sample only: set or CLEARED every ingest
        // (per-sample facts, like `quality` — never latest-wins-retained).
        series.source_ts = last_source_ts;
        series.server_ts = last_server_ts;
        // publishedTs = the envelope header timestamp, verbatim, latest-wins when non-empty.
        if event.source_timestamp.is_some() {
            series.published_ts = event.source_timestamp.clone();
        }
        // Metadata is latest-wins; a changed name/signalId this ingest (first arrival or
        // re-label) is attached to every update entry of the batch so a live-only client can
        // label a series born after its subscribe.
        let mut label_changed = false;
        if let Some(name) = extraction.meta.name
            && series.name.as_deref() != Some(name.as_str())
        {
            series.name = Some(name);
            label_changed = true;
        }
        if let Some(signal_id) = extraction.meta.signal_id
            && series.signal_id.as_deref() != Some(signal_id.as_str())
        {
            series.signal_id = Some(signal_id);
            label_changed = true;
        }
        if let Some(address) = extraction.meta.address {
            series.address = Some(address);
        }
        if let Some(adapter) = extraction.meta.adapter {
            series.adapter = Some(adapter);
        }
        if let Some(endpoint) = extraction.meta.endpoint {
            series.endpoint = Some(endpoint);
        }
        if let Some(quality_raw) = last_quality_raw {
            series.quality_raw = Some(quality_raw);
        }
        let update_name = if label_changed {
            series.name.clone()
        } else {
            None
        };
        let update_signal_id = if label_changed {
            series.signal_id.clone()
        } else {
            None
        };

        // One point per valid sample in array order, one update entry per sample in the single
        // pre-encoded push frame. Every point shares the console receipt `at`.
        let mut updates = Vec::with_capacity(extraction.samples.len());
        for sample in extraction.samples {
            let point = SignalPoint {
                at: event.received_at,
                value: sample.value,
                quality: sample.quality,
                source_ts: sample.source_ts,
                server_ts: sample.server_ts,
            };
            series.points.push_back(point.clone());
            while series.points.len() > 60 {
                series.points.pop_front();
            }
            // Folded per-entry display timestamp — exact WP-D semantics (compat).
            let source_timestamp = point
                .source_ts
                .clone()
                .or_else(|| point.server_ts.clone())
                .or_else(|| event.source_timestamp.clone());
            updates.push(SignalUpdate {
                key: &key,
                instance: &instance,
                signal,
                point,
                source_timestamp,
                published_ts: event.source_timestamp.as_deref(),
                name: update_name.as_deref(),
                signal_id: update_signal_id.as_deref(),
            });
        }
        Some(frame("signal", UpdatesBody { updates }))
    }

    fn ingest_attribute(&mut self, event: &IngressEvent) -> Option<Utf8Bytes> {
        let key = key_from_identity(&event.identity);
        let platform = event
            .tags
            .as_ref()
            .and_then(|tags| tags.get("platform"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let mut patch = AttributePatch::default();
        if event.cls == "metric" && event.channel.as_deref() == Some("sys") {
            patch.cpu_percent = finite_number(event.body.get("cpu_usage"));
            patch.memory_mb = finite_number(event.body.get("memory_usage"));
            patch.disk_total_gb = finite_number(event.body.get("disk_total"));
            patch.disk_used_gb = finite_number(event.body.get("disk_used"));
            patch.disk_free_gb = finite_number(event.body.get("disk_free"));
            patch.threads = finite_number(event.body.get("threads"));
            patch.open_files = finite_number(event.body.get("files"));
            patch.fds = finite_number(event.body.get("fds"));
        } else if event.cls == "metric" && event.channel.as_deref() == Some("southbound_health") {
            patch.connection_state = event
                .body
                .get("connectionState")
                .and_then(Value::as_str)
                .map(str::to_string);
            patch.read_errors = finite_number(event.body.get("readErrors"));
            patch.write_errors = finite_number(event.body.get("writeErrors"));
        }
        if patch.is_empty() && platform.is_none() {
            return None;
        }
        let id = key.id();
        if !self.attributes.contains_key(&id) && self.attributes.len() >= 5000 {
            self.dropped_attributes += 1;
            return None;
        }
        let state = self.attributes.entry(id).or_insert_with(|| AttributeState {
            key: key.clone(),
            cpu_percent: None,
            memory_mb: None,
            disk_total_gb: None,
            disk_used_gb: None,
            disk_free_gb: None,
            threads: None,
            open_files: None,
            fds: None,
            connection_state: None,
            read_errors: None,
            write_errors: None,
            platform: None,
            cpu_series: VecDeque::new(),
            memory_series: VecDeque::new(),
            received_at: event.received_at,
            source_timestamp: event.source_timestamp.clone(),
        });
        patch.apply(state);
        if let Some(platform) = platform {
            state.platform = Some(platform);
        }
        if let Some(cpu) = patch.cpu_percent {
            state.cpu_series.push_back(cpu);
            while state.cpu_series.len() > ATTRIBUTE_CPU_POINTS {
                state.cpu_series.pop_front();
            }
        }
        if let Some(memory) = patch.memory_mb {
            state.memory_series.push_back(memory);
            while state.memory_series.len() > ATTRIBUTE_CPU_POINTS {
                state.memory_series.pop_front();
            }
        }
        state.received_at = event.received_at;
        state.source_timestamp = event.source_timestamp.clone();
        Some(frame(
            "attribute",
            UpdatesBody {
                updates: vec![&*state],
            },
        ))
    }

    fn ingest_alarm_event(&mut self, event: &IngressEvent) -> bool {
        let key = key_from_identity(&event.identity);
        let (severity_token, ty) = split_event_channel(event.channel.as_deref());
        let level = severity_token.as_deref().and_then(classify_severity);
        let id = format!("{}::{}", key.id(), ty);
        if active_flag(&event.body) == Some(false) {
            return self.clear_alarm(&id);
        }
        if let Some(level) = level.filter(|l| matches!(*l, "critical" | "error" | "warning")) {
            self.raise_alarm(id, key, level, ty, event)
        } else {
            self.clear_alarm(&id)
        }
    }

    fn raise_alarm(
        &mut self,
        id: String,
        key: ComponentKey,
        severity: &str,
        ty: String,
        event: &IngressEvent,
    ) -> bool {
        let now = event.received_at;
        if let Some(alarm) = self.alarms.get_mut(&id) {
            alarm.count += 1;
            alarm.last_at = now;
            alarm.severity = severity.to_string();
            alarm.message = event
                .body
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string);
            alarm.channel = event.channel.clone();
            return true;
        }
        if self.alarms.len() >= 2000 {
            self.dropped_alarms += 1;
            return false;
        }
        self.alarms.insert(
            id.clone(),
            AlarmState {
                id,
                component_id: key.id(),
                // Raise-time containment: a fresh alarm on an already-contained device starts
                // contained.
                contained: self.contained_devices.contains(&key.device),
                key,
                severity: severity.to_string(),
                ty,
                message: event
                    .body
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                raised_at: now,
                last_at: now,
                count: 1,
                acked: false,
                channel: event.channel.clone(),
            },
        );
        true
    }

    fn clear_alarm(&mut self, id: &str) -> bool {
        let Some(alarm) = self.alarms.remove(id) else {
            return false;
        };
        self.alarm_history.push_back(ResolvedAlarm {
            alarm,
            resolved_at: now_ms(),
        });
        while self.alarm_history.len() > 500 {
            self.alarm_history.pop_front();
        }
        true
    }

    /// Flip `contained` on every alarm of `device`; maintain `contained_devices`; return
    /// whether any alarm changed (B2). Called from both reachability transitions in B1.
    fn set_device_containment(&mut self, device: &str, contained: bool) -> bool {
        if contained {
            self.contained_devices.insert(device.to_string());
        } else {
            self.contained_devices.remove(device);
        }
        let mut changed = false;
        for alarm in self.alarms.values_mut() {
            if alarm.key.device == device && alarm.contained != contained {
                alarm.contained = contained;
                changed = true;
            }
        }
        changed
    }

    /// Stamp each delta body with a monotonic `seq` + shared `at`, encode it exactly once, push
    /// it to the ring, and assemble the live `delta` frame by string concatenation. Returns
    /// `None` for an empty batch (never emits an empty delta frame). `at` is the caller's
    /// already-clamped receipt stamp (the ingested event's / the sweep's) — deltas take no
    /// wall reading of their own, so the ring's `at`s share the monotonic timeline.
    fn stamp_and_store(&mut self, bodies: Vec<FleetDeltaBody>, at: u64) -> Option<Utf8Bytes> {
        if bodies.is_empty() {
            return None;
        }
        let mut frame =
            format!(r#"{{"type":"delta","protocolVersion":{PROTOCOL_VERSION},"deltas":["#);
        for (i, body) in bodies.iter().enumerate() {
            self.seq += 1;
            let json = encode_delta(body, self.seq, at);
            if i > 0 {
                frame.push(',');
            }
            frame.push_str(&json);
            self.deltas.push_back((self.seq, json.into_boxed_str()));
            while self.deltas.len() > DELTA_RING_CAP {
                self.deltas.pop_front();
            }
        }
        frame.push_str("]}");
        Some(Utf8Bytes::from(frame))
    }

    /// Assemble a `delta` frame from the stored deltas with `seq > resume_seq` (string concat).
    fn replay_delta_frame(&self, resume_seq: u64) -> Utf8Bytes {
        let mut frame =
            format!(r#"{{"type":"delta","protocolVersion":{PROTOCOL_VERSION},"deltas":["#);
        let mut first = true;
        for (seq, json) in &self.deltas {
            if *seq > resume_seq {
                if !first {
                    frame.push(',');
                }
                first = false;
                frame.push_str(json);
            }
        }
        frame.push_str("]}");
        Utf8Bytes::from(frame)
    }
}

// ------------------------------------------------------------------ live-log helpers

/// Per-session live-push filter. Matches TS `filterLogRecords` — sinceId + levels ONLY;
/// `limit` does NOT apply to live pushes (the `logs` backlog reply applies it, live `log`
/// pushes do not).
pub fn log_matches(record: &LogRecord, query: &LogQuery) -> bool {
    if let Some(since_id) = query.since_id
        && record.id <= since_id
    {
        return false;
    }
    if let Some(levels) = &query.levels
        && !levels.iter().any(|l| l == &record.level)
    {
        return false;
    }
    true
}

/// Live log push frame builder (`{"type":"log",...}`) — called by http.rs AFTER per-session
/// filtering, only for sessions actually subscribed.
pub fn log_push_frame(record: &LogRecord, dropped: Option<u64>) -> Utf8Bytes {
    frame(
        "log",
        LogPushBody {
            key: &record.key,
            records: [record],
            dropped: dropped.filter(|n| *n > 0),
        },
    )
}

// ------------------------------------------------------------------ fleet deltas

/// The delta body (its `type` tag + payload); `seq`/`at` are stamped at encode time.
/// Variant names yield today's `type` strings under kebab-case; per-variant camelCase covers
/// the remaining field renames.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum FleetDeltaBody {
    DeviceDiscovered {
        device: String,
    },
    ComponentDiscovered {
        key: ComponentKey,
        path: String,
        hier: Value,
    },
    ValueUpdated {
        key: ComponentKey,
        instance: String,
        cls: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        channel: Option<String>,
    },
    LivenessChanged {
        key: ComponentKey,
        from: String,
        to: String,
    },
    #[serde(rename_all = "camelCase")]
    CadenceChanged {
        key: ComponentKey,
        expected_interval_secs: u64,
        cadence_source: &'static str,
    },
    #[serde(rename_all = "camelCase")]
    ComponentRestarted {
        key: ComponentKey,
        previous_uptime_secs: f64,
        uptime_secs: f64,
    },
    InstancesChanged {
        key: ComponentKey,
        instances: Value,
    },
    #[serde(rename_all = "camelCase")]
    DeviceReachabilityChanged {
        device: String,
        unreachable: bool,
        component_count: usize,
    },
}

/// A delta body stamped with its sequence number and timestamp — encoded once per delta.
#[derive(Serialize)]
struct StampedDelta<'a> {
    #[serde(flatten)]
    body: &'a FleetDeltaBody,
    seq: u64,
    at: u64,
}

fn encode_delta(body: &FleetDeltaBody, seq: u64, at: u64) -> String {
    serde_json::to_string(&StampedDelta { body, seq, at })
        .expect("delta serialization is infallible: all stored floats are finite")
}

// ------------------------------------------------------------------ frame views

/// Single pass straight to a `String`; invariant: all stored floats are finite, so the only
/// other `serde_json` error modes (non-string map keys, custom `Serialize` errors) cannot
/// occur — `encode_frame` is infallible.
fn encode_frame<T: Serialize>(value: &T) -> Utf8Bytes {
    Utf8Bytes::from(
        serde_json::to_string(value)
            .expect("frame serialization is infallible: all stored floats are finite"),
    )
}

#[derive(Serialize)]
struct Frame<T: Serialize> {
    #[serde(rename = "type")]
    ty: &'static str,
    #[serde(rename = "protocolVersion")]
    protocol_version: i64,
    #[serde(flatten)]
    body: T,
}

fn frame<T: Serialize>(ty: &'static str, body: T) -> Utf8Bytes {
    encode_frame(&Frame {
        ty,
        protocol_version: PROTOCOL_VERSION,
        body,
    })
}

#[derive(Serialize)]
struct SnapshotBody<T: Serialize> {
    snapshot: T,
}

#[derive(Serialize)]
struct SeriesBody<T: Serialize> {
    series: Vec<T>,
}

#[derive(Serialize)]
struct ComponentsBody<T: Serialize> {
    components: Vec<T>,
}

#[derive(Serialize)]
struct UpdatesBody<T: Serialize> {
    updates: Vec<T>,
}

#[derive(Serialize)]
struct EventsBody<T: Serialize> {
    events: T,
}

#[derive(Serialize)]
struct EventBody<'a> {
    event: &'a EventRecord,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigBody<'a> {
    key: &'a ComponentKey,
    cfg: &'a Value,
    received_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_timestamp: Option<&'a str>,
}

fn encode_config_frame(
    key: &ComponentKey,
    cfg: &Value,
    received_at: u64,
    source_timestamp: Option<&str>,
) -> Utf8Bytes {
    frame(
        "config",
        ConfigBody {
            key,
            cfg,
            received_at,
            source_timestamp,
        },
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogsFrameBody<'a> {
    key: &'a ComponentKey,
    records: LogsView<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dropped: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LogPushBody<'a> {
    key: &'a ComponentKey,
    records: [&'a LogRecord; 1],
    #[serde(skip_serializing_if = "Option::is_none")]
    dropped: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MetricUpdate<'a> {
    key: &'a ComponentKey,
    instance: &'a str,
    metric: &'a str,
    measure: &'a str,
    point: MetricPoint,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_timestamp: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SignalUpdate<'a> {
    key: &'a ComponentKey,
    instance: &'a str,
    signal: &'a str,
    point: SignalPoint,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_timestamp: Option<String>,
    /// The envelope header timestamp, verbatim — the client's lag baseline.
    #[serde(skip_serializing_if = "Option::is_none")]
    published_ts: Option<&'a str>,
    // Attached only on the batch that changed the series label (first arrival or re-label).
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signal_id: Option<&'a str>,
}

/// §4.1b summary view of a series: every snapshot field except `points` (the key is omitted
/// entirely, never emitted empty).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SignalSeriesSummaryView<'a> {
    key: &'a ComponentKey,
    instance: &'a str,
    signal: &'a str,
    latest: &'a Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    quality: Option<&'a str>,
    received_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_timestamp: Option<&'a str>,
    // The latest sample's verbatim timestamps — summary rows compute lag from these.
    #[serde(skip_serializing_if = "Option::is_none")]
    source_ts: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_ts: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    signal_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    address: Option<&'a Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    adapter: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    endpoint: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    quality_raw: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    published_ts: Option<&'a str>,
}

impl<'a> SignalSeriesSummaryView<'a> {
    fn of(series: &'a SignalSeries) -> Self {
        Self {
            key: &series.key,
            instance: &series.instance,
            signal: &series.signal,
            latest: &series.latest,
            quality: series.quality.as_deref(),
            received_at: series.received_at,
            source_timestamp: series.source_timestamp.as_deref(),
            source_ts: series.source_ts.as_deref(),
            server_ts: series.server_ts.as_deref(),
            name: series.name.as_deref(),
            signal_id: series.signal_id.as_deref(),
            address: series.address.as_ref(),
            adapter: series.adapter.as_deref(),
            endpoint: series.endpoint.as_deref(),
            quality_raw: series.quality_raw.as_deref(),
            published_ts: series.published_ts.as_deref(),
        }
    }
}

/// One `signal-points` reply entry — the series identity triple plus its points ring.
#[derive(Serialize)]
struct SignalPointsView<'a> {
    key: &'a ComponentKey,
    instance: &'a str,
    signal: &'a str,
    points: &'a VecDeque<SignalPoint>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotView<'a> {
    seq: u64,
    taken_at: u64,
    devices: Vec<DeviceSnapshotView<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceSnapshotView<'a> {
    device: &'a str,
    unreachable: bool,
    // Emitted even when absent (null) — matches the current v7 device snapshot shape.
    unreachable_since: Option<u64>,
    components: Vec<ComponentSnapshotView<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ComponentSnapshotView<'a> {
    key: &'a ComponentKey,
    path: &'a str,
    hier: &'a Value,
    liveness: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    uptime_secs: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_state_at: Option<u64>,
    expected_interval_secs: u64,
    cadence_source: &'a str,
    restarts: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    instances: Option<&'a Value>,
    values: Vec<&'a CachedValue>,
    dropped_channels: u64,
}

#[derive(Serialize)]
struct AlarmSnapshotView<'a> {
    active: Vec<&'a AlarmState>,
    counts: AlarmCounts,
}

#[derive(Serialize, Default)]
struct AlarmCounts {
    critical: u64,
    warning: u64,
    active: u64,
    contained: u64,
    acked: u64,
}

/// Serializes an `Arc<T>` drop-oldest ring newest-first, capped at `limit`, without collecting
/// or truncating an intermediate vector.
struct NewestFirst<'a, T> {
    ring: &'a VecDeque<Arc<T>>,
    limit: usize,
}

impl<T: Serialize> Serialize for NewestFirst<'_, T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(None)?;
        for item in self.ring.iter().rev().take(self.limit) {
            seq.serialize_element(item.as_ref())?;
        }
        seq.end()
    }
}

/// Serializes a per-component log ring newest-first, applying sinceId + levels (via
/// `log_matches`) then `limit` — the `logs` backlog reply shape.
struct LogsView<'a> {
    ring: Option<&'a VecDeque<Arc<LogRecord>>>,
    query: &'a LogQuery,
}

impl Serialize for LogsView<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(None)?;
        if let Some(ring) = self.ring {
            let limit = self.query.limit.unwrap_or(usize::MAX);
            let mut emitted = 0usize;
            for record in ring.iter().rev() {
                if emitted >= limit {
                    break;
                }
                if !log_matches(record, self.query) {
                    continue;
                }
                seq.serialize_element(record.as_ref())?;
                emitted += 1;
            }
        }
        seq.end()
    }
}

// ------------------------------------------------------------------ mutation helpers

fn update_cache(
    component: &mut ComponentRecord,
    event: &IngressEvent,
    deltas: &mut Vec<FleetDeltaBody>,
    max_channels: usize,
) {
    let instance = event.identity.instance().to_string();
    let id = value_cache_key(&instance, &event.cls, event.channel.as_deref());
    // Cap check: a new distinct channel over the cap is dropped + counted (no delta); an
    // update to an existing channel always refreshes and emits.
    if !component.values.contains_key(&id) && component.values.len() >= max_channels {
        component.dropped_channels += 1;
        return;
    }
    component.values.insert(
        id,
        CachedValue {
            instance: instance.clone(),
            cls: event.cls.clone(),
            channel: event.channel.clone(),
            body: event.body.clone(),
            tags: event.tags.clone(),
            received_at: event.received_at,
            source_timestamp: event.source_timestamp.clone(),
        },
    );
    deltas.push(FleetDeltaBody::ValueUpdated {
        key: component.key.clone(),
        instance,
        cls: event.cls.clone(),
        channel: event.channel.clone(),
    });
}

fn value_cache_key(instance: &str, cls: &str, channel: Option<&str>) -> String {
    format!("{}|{}|{}", instance, cls, channel.unwrap_or(""))
}

fn update_state(
    component: &mut ComponentRecord,
    event: &IngressEvent,
    device_unreachable: bool,
    deltas: &mut Vec<FleetDeltaBody>,
) {
    let status = event
        .body
        .get("status")
        .and_then(Value::as_str)
        .map(str::to_string);
    component.status = status.clone();
    component.last_state_at = Some(event.received_at);
    let previous_uptime = component.uptime_secs;
    if let Some(uptime) = finite_number(event.body.get("uptimeSecs")) {
        if let Some(prev) = previous_uptime
            && uptime < prev
        {
            component.restarts += 1;
            deltas.push(FleetDeltaBody::ComponentRestarted {
                key: component.key.clone(),
                previous_uptime_secs: prev,
                uptime_secs: uptime,
            });
        }
        component.uptime_secs = Some(uptime);
    }
    if let Some(instances) = event.body.get("instances").and_then(Value::as_array) {
        let normalized: Vec<Value> = instances
            .iter()
            .filter_map(normalize_instance_status)
            .collect();
        let normalized_value = Value::Array(normalized);
        if component.instances.as_ref() != Some(&normalized_value) {
            component.instances = Some(normalized_value.clone());
            deltas.push(FleetDeltaBody::InstancesChanged {
                key: component.key.clone(),
                instances: normalized_value,
            });
        }
    }
    let next_liveness = if device_unreachable {
        "UNREACHABLE"
    } else if status.as_deref() == Some("STOPPED") {
        "STOPPED"
    } else {
        "FRESH"
    };
    if component.liveness != next_liveness {
        let from = component.liveness.clone();
        component.liveness = next_liveness.to_string();
        deltas.push(FleetDeltaBody::LivenessChanged {
            key: component.key.clone(),
            from,
            to: next_liveness.to_string(),
        });
    }
}

fn update_cadence(
    component: &mut ComponentRecord,
    event: &IngressEvent,
    deltas: &mut Vec<FleetDeltaBody>,
) {
    let interval = event
        .body
        .pointer("/config/heartbeat/intervalSecs")
        .and_then(Value::as_u64)
        .or_else(|| {
            event
                .body
                .pointer("/heartbeat/intervalSecs")
                .and_then(Value::as_u64)
        });
    if let Some(interval) = interval.filter(|n| *n > 0) {
        let changed =
            component.expected_interval_secs != interval || component.cadence_source != "cfg";
        component.expected_interval_secs = interval;
        component.cadence_source = "cfg".to_string();
        if changed {
            deltas.push(FleetDeltaBody::CadenceChanged {
                key: component.key.clone(),
                expected_interval_secs: interval,
                cadence_source: "cfg",
            });
        }
    }
}

#[derive(Default)]
struct AttributePatch {
    cpu_percent: Option<f64>,
    memory_mb: Option<f64>,
    disk_total_gb: Option<f64>,
    disk_used_gb: Option<f64>,
    disk_free_gb: Option<f64>,
    threads: Option<f64>,
    open_files: Option<f64>,
    fds: Option<f64>,
    connection_state: Option<String>,
    read_errors: Option<f64>,
    write_errors: Option<f64>,
}

impl AttributePatch {
    fn is_empty(&self) -> bool {
        self.cpu_percent.is_none()
            && self.memory_mb.is_none()
            && self.disk_total_gb.is_none()
            && self.disk_used_gb.is_none()
            && self.disk_free_gb.is_none()
            && self.threads.is_none()
            && self.open_files.is_none()
            && self.fds.is_none()
            && self.connection_state.is_none()
            && self.read_errors.is_none()
            && self.write_errors.is_none()
    }

    fn apply(&self, state: &mut AttributeState) {
        macro_rules! set {
            ($field:ident) => {
                if self.$field.is_some() {
                    state.$field = self.$field;
                }
            };
        }
        set!(cpu_percent);
        set!(memory_mb);
        set!(disk_total_gb);
        set!(disk_used_gb);
        set!(disk_free_gb);
        set!(threads);
        set!(open_files);
        set!(fds);
        if let Some(value) = &self.connection_state {
            state.connection_state = Some(value.clone());
        }
        set!(read_errors);
        set!(write_errors);
    }
}

#[derive(Debug, Default)]
struct ThroughputMeter {
    seconds: VecDeque<(u64, u64)>,
}

impl ThroughputMeter {
    fn record(&mut self, at_ms: u64) {
        let sec = at_ms / 1000;
        if let Some((last_sec, count)) = self.seconds.back_mut()
            && *last_sec == sec
        {
            *count += 1;
            return;
        }
        self.seconds.push_back((sec, 1));
        while self.seconds.len() > 60 {
            self.seconds.pop_front();
        }
    }

    fn rate(&self, now_ms: u64) -> f64 {
        let now_sec = now_ms / 1000;
        self.seconds
            .iter()
            .find(|(sec, _)| *sec == now_sec)
            .map(|(_, count)| *count as f64)
            .unwrap_or(0.0)
    }

    fn recent(&self, now_ms: u64) -> Vec<f64> {
        let now_sec = now_ms / 1000;
        let start = now_sec.saturating_sub(29);
        (start..=now_sec)
            .map(|sec| {
                self.seconds
                    .iter()
                    .find(|(s, _)| *s == sec)
                    .map(|(_, count)| *count as f64)
                    .unwrap_or(0.0)
            })
            .collect()
    }
}

// ------------------------------------------------------------------ free helpers

pub fn normalize_message(cls: &str, topic: &str, msg: Message) -> Option<IngressEvent> {
    if msg.is_raw() {
        return None;
    }
    let identity = msg.identity?;
    let channel = channel_from_topic(cls, topic);
    let tags = msg
        .tags
        .map(|tags| tags.extra.into_iter().collect::<Map<String, Value>>());
    let source_timestamp = if msg.header.timestamp.is_empty() {
        None
    } else {
        Some(msg.header.timestamp)
    };
    Some(IngressEvent {
        cls: cls.to_string(),
        channel,
        identity,
        body: msg.body,
        tags,
        received_at: now_ms(),
        source_timestamp,
    })
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn is_bridge_unreachable(event: &IngressEvent) -> bool {
    event.identity.component() == BRIDGE_COMPONENT
        && event.cls == "state"
        && event.body.get("status").and_then(Value::as_str) == Some("UNREACHABLE")
}

fn channel_from_topic(cls: &str, topic: &str) -> Option<String> {
    let parts: Vec<&str> = topic.split('/').collect();
    let idx = if parts.get(4).copied() == Some(cls) {
        Some(4)
    } else if parts.get(5).copied() == Some(cls) {
        Some(5)
    } else {
        parts.iter().position(|p| *p == cls)
    }?;
    let channel = parts.get(idx + 1..).unwrap_or(&[]).join("/");
    if channel.is_empty() {
        None
    } else {
        Some(channel)
    }
}

fn key_from_identity(identity: &MessageIdentity) -> ComponentKey {
    ComponentKey {
        device: identity.device().to_string(),
        component: identity.component().to_string(),
    }
}

fn hier_json(identity: &MessageIdentity) -> Value {
    Value::Array(
        identity
            .hier()
            .iter()
            .map(|h| json!({ "level": h.level, "value": h.value }))
            .collect(),
    )
}

fn normalize_instance_status(value: &Value) -> Option<Value> {
    let obj = value.as_object()?;
    let instance = obj
        .get("instance")
        .or_else(|| obj.get("id"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?;
    let connected = obj
        .get("connected")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let mut out = Map::new();
    out.insert("instance".to_string(), Value::String(instance.to_string()));
    out.insert("connected".to_string(), Value::Bool(connected));
    if let Some(detail) = obj.get("detail").and_then(Value::as_str) {
        out.insert("detail".to_string(), Value::String(detail.to_string()));
    }
    Some(Value::Object(out))
}

fn finite_number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|n| n.is_finite())
}

fn extract_metric_measures(body: &Value) -> Vec<(String, f64)> {
    if let Some(n) = finite_number(Some(body)) {
        return vec![("value".to_string(), n)];
    }
    body.as_object()
        .map(|obj| {
            obj.iter()
                .filter(|(k, _)| !k.starts_with('_'))
                .filter_map(|(k, v)| finite_number(Some(v)).map(|n| (k.clone(), n)))
                .collect()
        })
        .unwrap_or_default()
}

/// One valid sample extracted from a `data` body. Both timestamps ride verbatim — no early
/// fold; the folded WP-D `sourceTimestamp` compat fields are computed where they are emitted.
struct ExtractedSample {
    value: Value,
    quality: Option<String>,
    /// The sample's `sourceTs` (measured/device time), verbatim.
    source_ts: Option<String>,
    /// The sample's `serverTs` (protocol-server refresh time), verbatim.
    server_ts: Option<String>,
    quality_raw: Option<String>,
}

/// Canonical `SouthboundSignalUpdate` series metadata (empty for legacy/bare bodies).
#[derive(Default)]
struct SignalMeta {
    name: Option<String>,
    signal_id: Option<String>,
    address: Option<Value>,
    adapter: Option<String>,
    endpoint: Option<String>,
}

struct SignalExtraction {
    samples: Vec<ExtractedSample>,
    meta: SignalMeta,
}

/// Split a `data` body into signal samples. Three shapes, tried in order (the `data` class is
/// open — all three are supported):
/// 1. canonical `SouthboundSignalUpdate` (object carrying `samples`): one sample per array
///    element that is an object with a `value` key (lenient — invalid elements are skipped;
///    zero valid samples means the caller must treat the ingest as a no-op), plus latest-wins
///    series metadata from `signal{id,name,address}` / `device{adapter,endpoint}`;
/// 2. legacy object without `samples`: one sample — `value` if the key exists, else the whole
///    body, with `quality` when present;
/// 3. bare non-object body: one sample, the body itself, no quality.
fn extract_signal_samples(body: &Value) -> SignalExtraction {
    let Some(obj) = body.as_object() else {
        return SignalExtraction {
            samples: vec![ExtractedSample {
                value: body.clone(),
                quality: None,
                source_ts: None,
                server_ts: None,
                quality_raw: None,
            }],
            meta: SignalMeta::default(),
        };
    };
    let Some(samples_value) = obj.get("samples") else {
        // Legacy object shape — exactly the pre-canonical behavior.
        return SignalExtraction {
            samples: vec![ExtractedSample {
                value: obj.get("value").cloned().unwrap_or_else(|| body.clone()),
                quality: obj
                    .get("quality")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                source_ts: None,
                server_ts: None,
                quality_raw: None,
            }],
            meta: SignalMeta::default(),
        };
    };
    // Canonical southbound: the `samples` key selects this branch; a non-array value yields
    // zero valid samples (no-op) rather than falling back to storing the body as "the value".
    let samples = samples_value
        .as_array()
        .map(|elements| {
            elements
                .iter()
                .filter_map(|element| {
                    let sample = element.as_object()?;
                    // The `value` KEY must exist; its value is taken verbatim (even null).
                    let value = sample.get("value")?.clone();
                    Some(ExtractedSample {
                        value,
                        quality: non_empty_string(sample.get("quality")),
                        source_ts: non_empty_string(sample.get("sourceTs")),
                        server_ts: non_empty_string(sample.get("serverTs")),
                        quality_raw: non_empty_string(sample.get("qualityRaw")),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let signal = obj.get("signal").and_then(Value::as_object);
    let device = obj.get("device").and_then(Value::as_object);
    let meta = SignalMeta {
        name: non_empty_string(signal.and_then(|s| s.get("name"))),
        signal_id: non_empty_string(signal.and_then(|s| s.get("id"))),
        address: signal
            .and_then(|s| s.get("address"))
            .filter(|v| !v.is_null())
            .cloned(),
        adapter: non_empty_string(device.and_then(|d| d.get("adapter"))),
        endpoint: non_empty_string(device.and_then(|d| d.get("endpoint"))),
    };
    SignalExtraction { samples, meta }
}

fn non_empty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn split_event_channel(channel: Option<&str>) -> (Option<String>, String) {
    let Some(channel) = channel.filter(|c| !c.is_empty()) else {
        return (None, "(unnamed)".to_string());
    };
    let tokens: Vec<&str> = channel.split('/').collect();
    if tokens.len() == 1 {
        let token = tokens[0];
        if classify_severity(token).is_some() {
            (Some(token.to_string()), "(unnamed)".to_string())
        } else {
            (None, token.to_string())
        }
    } else {
        (
            Some(tokens[0].to_string()),
            tokens[1..].join("/").to_string(),
        )
    }
}

fn classify_severity(value: &str) -> Option<&'static str> {
    match value.to_ascii_lowercase().as_str() {
        "critical" | "crit" | "fatal" | "emergency" | "alert" => Some("critical"),
        "error" | "err" => Some("error"),
        "warning" | "warn" => Some("warning"),
        "info" | "notice" => Some("info"),
        "debug" | "trace" => Some("debug"),
        _ => None,
    }
}

fn active_flag(body: &Value) -> Option<bool> {
    body.as_object()
        .and_then(|obj| obj.get("active"))
        .and_then(Value::as_bool)
}

#[cfg(test)]
mod tests {
    use super::*;
    use edgecommons::messaging::message::{HierEntry, MessageBuilder};

    fn identity() -> MessageIdentity {
        MessageIdentity::new(
            vec![HierEntry {
                level: "device".to_string(),
                value: "gw-1".to_string(),
            }],
            "component-a",
            None,
        )
        .unwrap()
    }

    fn identity_for(component: &str) -> MessageIdentity {
        MessageIdentity::new(
            vec![HierEntry {
                level: "device".to_string(),
                value: "gw-1".to_string(),
            }],
            component,
            None,
        )
        .unwrap()
    }

    fn parse(frame: &Utf8Bytes) -> Value {
        serde_json::from_str(frame.as_str()).unwrap()
    }

    fn deltas_of(outcome: &IngestOutcome) -> Value {
        let frame = outcome
            .events
            .iter()
            .find_map(|e| match e {
                GatewayEvent::Deltas(frame) => Some(frame),
                _ => None,
            })
            .expect("expected a fleet delta frame");
        parse(frame)
    }

    fn key_a() -> ComponentKey {
        ComponentKey {
            device: "gw-1".to_string(),
            component: "component-a".to_string(),
        }
    }

    #[test]
    fn metric_body_flattens_numeric_fields() {
        let mut model = Model::new(ConsoleConfig::default());
        let msg = MessageBuilder::new("Metric", "1.0")
            .identity(identity())
            .metric_update(json!({"read": 1, "_aws": {}, "label": "x"}))
            .build();
        let ev =
            normalize_message("metric", "ecv1/gw-1/component-a/main/metric/opcua", msg).unwrap();
        let out = model.ingest(ev);
        assert!(
            out.events
                .iter()
                .any(|e| matches!(e, GatewayEvent::Metrics(_)))
        );
        let series = parse(&model.metrics_frame());
        assert_eq!(series["series"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn logs_are_newest_first() {
        let mut model = Model::new(ConsoleConfig::default());
        for i in 0..2 {
            let msg = MessageBuilder::new("Log", "1.0")
                .identity(identity())
                .payload(json!({"logger": "t", "message": format!("m{i}")}))
                .build();
            let ev = normalize_message("log", "ecv1/gw-1/component-a/main/log/info", msg).unwrap();
            model.ingest(ev);
        }
        let frame = parse(&model.logs_frame(
            &key_a(),
            &LogQuery {
                limit: None,
                levels: None,
                since_id: None,
            },
        ));
        assert_eq!(frame["records"][0]["message"], "m1");
    }

    #[test]
    fn cfg_cadence_change_emits_delta() {
        let mut model = Model::new(ConsoleConfig::default());
        let state = IngressEvent {
            cls: "state".to_string(),
            channel: None,
            identity: identity(),
            body: json!({"status": "RUNNING", "uptimeSecs": 1}),
            tags: None,
            received_at: 1_000,
            source_timestamp: None,
        };
        model.ingest(state);

        let cfg = IngressEvent {
            cls: "cfg".to_string(),
            channel: None,
            identity: identity(),
            body: json!({"config": {"heartbeat": {"intervalSecs": 15}}}),
            tags: None,
            received_at: 2_000,
            source_timestamp: None,
        };
        let out = model.ingest(cfg);
        let deltas = deltas_of(&out);
        assert!(deltas["deltas"].as_array().unwrap().iter().any(|delta| {
            delta["type"] == "cadence-changed"
                && delta["expectedIntervalSecs"] == 15
                && delta["cadenceSource"] == "cfg"
        }));
        let snap = parse(&model.snapshot_frame());
        let component = &snap["snapshot"]["devices"][0]["components"][0];
        assert_eq!(component["expectedIntervalSecs"], 15);
        assert_eq!(component["cadenceSource"], "cfg");
    }

    /// B1: the bridge LWT contains the device, overlays UNREACHABLE, is idempotent, creates no
    /// `uns-bridge` component record, and is cleared by a real `state` from any component.
    #[test]
    fn bridge_lwt_contains_device_and_clears_on_state() {
        let mut model = Model::new(ConsoleConfig::default());
        // Discover a real component first so the overlay has something to cover.
        model.ingest(IngressEvent {
            cls: "state".to_string(),
            channel: None,
            identity: identity_for("component-a"),
            body: json!({"status": "RUNNING"}),
            tags: None,
            received_at: 1_000,
            source_timestamp: None,
        });

        // Bridge LWT → device unreachable.
        let lwt = model.ingest(IngressEvent {
            cls: "state".to_string(),
            channel: None,
            identity: identity_for("uns-bridge"),
            body: json!({"status": "UNREACHABLE"}),
            tags: None,
            received_at: 2_000,
            source_timestamp: None,
        });
        let deltas = deltas_of(&lwt);
        let types: Vec<&str> = deltas["deltas"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["type"].as_str().unwrap())
            .collect();
        assert_eq!(types, vec!["device-reachability-changed"]);

        let snap = parse(&model.snapshot_frame());
        let device = &snap["snapshot"]["devices"][0];
        assert_eq!(device["unreachable"], true);
        let components = device["components"].as_array().unwrap();
        // No uns-bridge component record was created by the LWT.
        assert_eq!(components.len(), 1);
        assert_eq!(components[0]["key"]["component"], "component-a");
        assert_eq!(components[0]["liveness"], "UNREACHABLE");

        // Second identical LWT is idempotent — no deltas at all.
        let second = model.ingest(IngressEvent {
            cls: "state".to_string(),
            channel: None,
            identity: identity_for("uns-bridge"),
            body: json!({"status": "UNREACHABLE"}),
            tags: None,
            received_at: 3_000,
            source_timestamp: None,
        });
        assert!(
            !second
                .events
                .iter()
                .any(|e| matches!(e, GatewayEvent::Deltas(_)))
        );

        // A real state from a component clears it.
        let recover = model.ingest(IngressEvent {
            cls: "state".to_string(),
            channel: None,
            identity: identity_for("component-a"),
            body: json!({"status": "RUNNING"}),
            tags: None,
            received_at: 4_000,
            source_timestamp: None,
        });
        let deltas = deltas_of(&recover);
        assert!(
            deltas["deltas"].as_array().unwrap().iter().any(|d| {
                d["type"] == "device-reachability-changed" && d["unreachable"] == false
            })
        );
        let snap = parse(&model.snapshot_frame());
        assert_eq!(snap["snapshot"]["devices"][0]["unreachable"], false);
    }

    /// B2: a raised alarm is contained when its device goes unreachable (an Alarms frame is
    /// emitted, the count moves to `contained`) and released back to active on recovery.
    #[test]
    fn alarm_containment_follows_reachability() {
        let mut model = Model::new(ConsoleConfig::default());
        // Raise a critical alarm on component-a.
        model.ingest(IngressEvent {
            cls: "evt".to_string(),
            channel: Some("critical/connection-lost".to_string()),
            identity: identity_for("component-a"),
            body: json!({"message": "down"}),
            tags: None,
            received_at: 1_000,
            source_timestamp: None,
        });
        let alarms = parse(&model.alarms_frame());
        assert_eq!(alarms["snapshot"]["counts"]["critical"], 1);
        assert_eq!(alarms["snapshot"]["counts"]["contained"], 0);

        // Device goes unreachable via the bridge LWT → alarm contained.
        let lwt = model.ingest(IngressEvent {
            cls: "state".to_string(),
            channel: None,
            identity: identity_for("uns-bridge"),
            body: json!({"status": "UNREACHABLE"}),
            tags: None,
            received_at: 2_000,
            source_timestamp: None,
        });
        let alarms_frame = lwt
            .events
            .iter()
            .find_map(|e| match e {
                GatewayEvent::Alarms(frame) => Some(frame),
                _ => None,
            })
            .expect("reachability change should emit an Alarms frame");
        let alarms = parse(alarms_frame);
        assert_eq!(alarms["snapshot"]["counts"]["critical"], 0);
        assert_eq!(alarms["snapshot"]["counts"]["contained"], 1);

        // Recovery releases the alarm back to active.
        let recover = model.ingest(IngressEvent {
            cls: "state".to_string(),
            channel: None,
            identity: identity_for("component-a"),
            body: json!({"status": "RUNNING"}),
            tags: None,
            received_at: 3_000,
            source_timestamp: None,
        });
        assert!(
            recover
                .events
                .iter()
                .any(|e| matches!(e, GatewayEvent::Alarms(_)))
        );
        let alarms = parse(&model.alarms_frame());
        assert_eq!(alarms["snapshot"]["counts"]["critical"], 1);
        assert_eq!(alarms["snapshot"]["counts"]["contained"], 0);
    }

    /// B3: a component discovered via a metric-only event (never sends a `state`) still
    /// degrades FRESH → WARN → STALE → OFFLINE as the sweep clock advances from its
    /// discovery time (default cadence 5 s).
    #[test]
    fn metric_only_component_degrades_from_first_seen() {
        let mut model = Model::new(ConsoleConfig::default());
        model.ingest(IngressEvent {
            cls: "metric".to_string(),
            channel: Some("opcua".to_string()),
            identity: identity_for("component-a"),
            body: json!({"read": 1}),
            tags: None,
            received_at: 0,
            source_timestamp: None,
        });

        // The component snapshots FRESH before any staleness elapses.
        let snap = parse(&model.snapshot_frame());
        assert_eq!(
            snap["snapshot"]["devices"][0]["components"][0]["liveness"],
            "FRESH"
        );

        // Advance the wall clock and sweep; default interval 5 s, warn>2x, stale>2.5x, offline>5x.
        // first_seen_at is 0, so after ~30 s (> 5 * 5 s) it must be OFFLINE.
        let mut last = "FRESH".to_string();
        for _ in 0..40 {
            let out = model.sweep();
            if let Some(GatewayEvent::Deltas(frame)) = out.events.first() {
                let deltas = parse(frame);
                if let Some(delta) = deltas["deltas"].as_array().unwrap().last() {
                    last = delta["to"].as_str().unwrap().to_string();
                }
            }
            if last == "OFFLINE" {
                break;
            }
        }
        // Because now_ms() is real wall-clock and first_seen_at is 0 (epoch), the very first
        // sweep already sees an enormous age and jumps straight to OFFLINE — proving the
        // first_seen_at baseline drives degradation without a state ever arriving.
        assert_eq!(last, "OFFLINE");
    }

    /// B4: log-class ingests never enter the LKV cache — no `value-updated` delta, empty
    /// snapshot `values` — while other classes (metric) still cache and emit one.
    #[test]
    fn log_class_values_stay_out_of_lkv_cache() {
        let mut model = Model::new(ConsoleConfig::default());
        let log = model.ingest(IngressEvent {
            cls: "log".to_string(),
            channel: Some("info".to_string()),
            identity: identity(),
            body: json!({"logger": "t", "message": "m"}),
            tags: None,
            received_at: 1_000,
            source_timestamp: None,
        });
        // The log still reaches the LogStore path.
        assert!(
            log.events
                .iter()
                .any(|e| matches!(e, GatewayEvent::Logs { .. }))
        );
        // But no value-updated delta was emitted for it (only discovery deltas).
        let deltas = deltas_of(&log);
        assert!(
            !deltas["deltas"]
                .as_array()
                .unwrap()
                .iter()
                .any(|d| d["type"] == "value-updated")
        );
        // And the component snapshot's values cache stays empty.
        let snap = parse(&model.snapshot_frame());
        let values = &snap["snapshot"]["devices"][0]["components"][0]["values"];
        assert_eq!(values.as_array().unwrap().len(), 0);

        // A metric-class ingest on the same component still caches and emits value-updated.
        let metric = model.ingest(IngressEvent {
            cls: "metric".to_string(),
            channel: Some("opcua".to_string()),
            identity: identity(),
            body: json!({"read": 1}),
            tags: None,
            received_at: 2_000,
            source_timestamp: None,
        });
        let deltas = deltas_of(&metric);
        assert!(
            deltas["deltas"]
                .as_array()
                .unwrap()
                .iter()
                .any(|d| d["type"] == "value-updated" && d["cls"] == "metric")
        );
        let snap = parse(&model.snapshot_frame());
        let values = &snap["snapshot"]["devices"][0]["components"][0]["values"];
        assert_eq!(values.as_array().unwrap().len(), 1);
        assert_eq!(values[0]["cls"], "metric");
    }

    fn data_event(body: Value) -> IngressEvent {
        IngressEvent {
            cls: "data".to_string(),
            channel: Some("temp".to_string()),
            identity: identity(),
            body,
            tags: None,
            received_at: 5_000,
            source_timestamp: Some("2026-07-10T00:00:00Z".to_string()),
        }
    }

    fn canonical_body() -> Value {
        json!({
            "device": {"adapter": "opcua", "instance": "kep1", "endpoint": "opc.tcp://host:4840"},
            "signal": {"id": "ns=3;i=1001", "name": "Boiler temp", "address": {"ns": 3, "nodeId": "i=1001"}},
            "samples": [
                {"value": 21.5, "quality": "GOOD", "qualityRaw": "0x0", "sourceTs": "2026-07-10T00:00:01Z"},
                {"value": 22.0, "quality": "UNCERTAIN", "qualityRaw": "0x40", "serverTs": "2026-07-10T00:00:02Z"}
            ]
        })
    }

    fn signals_push(outcome: &IngestOutcome) -> Option<Value> {
        outcome.events.iter().find_map(|e| match e {
            GatewayEvent::Signals(frame) => Some(parse(frame)),
            _ => None,
        })
    }

    /// §3.2/§3.3 canonical extraction: a 2-sample SouthboundSignalUpdate yields 2 points in
    /// array order (timestamps verbatim per sample), latest = the 2nd sample's value+quality,
    /// and the snapshot carries the series metadata fields.
    #[test]
    fn canonical_southbound_samples_ingest_as_points() {
        let mut model = Model::new(ConsoleConfig::default());
        model.ingest(data_event(canonical_body()));

        let snap = parse(&model.signals_frame(SignalsMode::Full));
        let series = &snap["series"][0];
        let points = series["points"].as_array().unwrap();
        assert_eq!(points.len(), 2);
        assert_eq!(points[0]["value"], 21.5);
        assert_eq!(points[0]["quality"], "GOOD");
        assert_eq!(points[0]["sourceTs"], "2026-07-10T00:00:01Z");
        assert_eq!(points[0]["at"], 5_000); // console receipt time, one time base
        assert_eq!(points[1]["value"], 22.0);
        assert_eq!(points[1]["quality"], "UNCERTAIN");
        assert_eq!(points[1]["serverTs"], "2026-07-10T00:00:02Z"); // verbatim, not folded
        assert!(points[1].get("sourceTs").is_none());
        // Latest = last sample; the folded display timestamp keeps its fallback chain.
        assert_eq!(series["latest"], 22.0);
        assert_eq!(series["quality"], "UNCERTAIN");
        assert_eq!(series["sourceTimestamp"], "2026-07-10T00:00:02Z");
        // Metadata (latest-wins, all optional) landed via the derive.
        assert_eq!(series["name"], "Boiler temp");
        assert_eq!(series["signalId"], "ns=3;i=1001");
        assert_eq!(series["address"], json!({"ns": 3, "nodeId": "i=1001"}));
        assert_eq!(series["adapter"], "opcua");
        assert_eq!(series["endpoint"], "opc.tcp://host:4840");
        assert_eq!(series["qualityRaw"], "0x40");
    }

    /// §3.3 push shape: one pre-encoded frame per ingest with one update entry per sample;
    /// `name`/`signalId` ride the batch that changed the label (first arrival) and are omitted
    /// on the next unchanged batch.
    #[test]
    fn canonical_batch_emits_one_update_per_sample() {
        let mut model = Model::new(ConsoleConfig::default());
        let first = model.ingest(data_event(canonical_body()));
        let frame = signals_push(&first).expect("signal push frame");
        assert_eq!(frame["type"], "signal");
        let updates = frame["updates"].as_array().unwrap();
        assert_eq!(updates.len(), 2);
        for update in updates {
            assert_eq!(update["name"], "Boiler temp");
            assert_eq!(update["signalId"], "ns=3;i=1001");
            assert_eq!(update["signal"], "temp");
        }
        // Per-sample sourceTimestamp fallback on each entry.
        assert_eq!(updates[0]["sourceTimestamp"], "2026-07-10T00:00:01Z");
        assert_eq!(updates[1]["sourceTimestamp"], "2026-07-10T00:00:02Z");

        // Same body again: label unchanged, so name/signalId are omitted.
        let second = model.ingest(data_event(canonical_body()));
        let frame = signals_push(&second).expect("signal push frame");
        for update in frame["updates"].as_array().unwrap() {
            assert!(update.get("name").is_none());
            assert!(update.get("signalId").is_none());
        }
    }

    /// §3.2 leniency: invalid elements (non-objects, objects without a `value` key) are
    /// skipped; an empty, all-invalid, or non-array `samples` is a whole-ingest no-op — no
    /// series is created and no frame is emitted.
    #[test]
    fn malformed_and_empty_samples_are_lenient() {
        let mut model = Model::new(ConsoleConfig::default());
        // Mixed batch: only the one element with a `value` key survives (even a null value).
        let out = model.ingest(data_event(json!({
            "samples": [42, "nope", {"quality": "GOOD"}, {"value": null, "quality": "BAD"}]
        })));
        let frame = signals_push(&out).expect("one valid sample still pushes");
        let updates = frame["updates"].as_array().unwrap();
        assert_eq!(updates.len(), 1);
        assert_eq!(updates[0]["point"]["value"], Value::Null);
        assert_eq!(updates[0]["point"]["quality"], "BAD");

        // Empty / all-invalid / non-array samples: complete no-op.
        for body in [
            json!({"samples": []}),
            json!({"samples": [1, {"quality": "GOOD"}]}),
            json!({"samples": {"value": 3}}),
        ] {
            let mut fresh = Model::new(ConsoleConfig::default());
            let out = fresh.ingest(data_event(body));
            assert!(signals_push(&out).is_none());
            let snap = parse(&fresh.signals_frame(SignalsMode::Full));
            assert_eq!(snap["series"].as_array().unwrap().len(), 0);
        }
    }

    /// §3.2 shapes 2+3 regression: the legacy `{value, quality}` object (and value-less
    /// object) and the bare scalar keep exactly their pre-canonical behavior.
    #[test]
    fn legacy_and_bare_signal_bodies_still_ingest() {
        // Legacy {value, quality}.
        let mut model = Model::new(ConsoleConfig::default());
        let out = model.ingest(data_event(json!({"value": 7, "quality": "GOOD"})));
        let frame = signals_push(&out).expect("legacy push");
        assert_eq!(frame["updates"][0]["point"]["value"], 7);
        assert_eq!(frame["updates"][0]["point"]["quality"], "GOOD");
        // Envelope-timestamp fallback (no per-sample timestamps in the legacy shape).
        assert_eq!(
            frame["updates"][0]["sourceTimestamp"],
            "2026-07-10T00:00:00Z"
        );
        let snap = parse(&model.signals_frame(SignalsMode::Full));
        assert_eq!(snap["series"][0]["latest"], 7);
        assert!(snap["series"][0].get("name").is_none());

        // Object without `value`: the whole body is the value.
        let mut model = Model::new(ConsoleConfig::default());
        let out = model.ingest(data_event(json!({"reading": 3})));
        let frame = signals_push(&out).expect("object-body push");
        assert_eq!(frame["updates"][0]["point"]["value"], json!({"reading": 3}));

        // Bare scalar.
        let mut model = Model::new(ConsoleConfig::default());
        let out = model.ingest(data_event(json!(42)));
        let frame = signals_push(&out).expect("bare push");
        assert_eq!(frame["updates"][0]["point"]["value"], 42);
        assert!(frame["updates"][0]["point"].get("quality").is_none());
    }

    /// §4.1b: summary mode serves the same series objects with the `points` key omitted
    /// entirely (not `points: []`); full mode still carries the ring.
    #[test]
    fn summary_snapshot_omits_points() {
        let mut model = Model::new(ConsoleConfig::default());
        model.ingest(data_event(canonical_body()));

        let full = parse(&model.signals_frame(SignalsMode::Full));
        assert_eq!(full["series"][0]["points"].as_array().unwrap().len(), 2);

        let summary = parse(&model.signals_frame(SignalsMode::Summary));
        let series = &summary["series"][0];
        assert!(series.get("points").is_none());
        // Everything else survives: latest + quality + metadata + publishedTs.
        assert_eq!(series["latest"], 22.0);
        assert_eq!(series["quality"], "UNCERTAIN");
        assert_eq!(series["name"], "Boiler temp");
        assert_eq!(series["signalId"], "ns=3;i=1001");
        assert_eq!(series["adapter"], "opcua");
        assert_eq!(series["publishedTs"], "2026-07-10T00:00:00Z");
    }

    /// §4.1c: the reply carries only the series that exist, in request order; the points
    /// payload matches the ring.
    #[test]
    fn signal_points_fetch_returns_found_series_in_request_order() {
        let mut model = Model::new(ConsoleConfig::default());
        // Two series on the same component: channels "temp" and "flow".
        model.ingest(data_event(canonical_body()));
        let mut flow = data_event(json!({"value": 3.2, "quality": "GOOD"}));
        flow.channel = Some("flow".to_string());
        model.ingest(flow);

        let selector = |signal: &str| SignalSelector {
            key: key_a(),
            instance: "main".to_string(),
            signal: signal.to_string(),
        };
        // Request order flow-then-temp with a miss in the middle.
        let frame = parse(&model.signal_points_frame(&[
            selector("flow"),
            selector("nope"),
            selector("temp"),
        ]));
        assert_eq!(frame["type"], "signal-points");
        let series = frame["series"].as_array().unwrap();
        assert_eq!(series.len(), 2); // the miss is omitted, not errored
        assert_eq!(series[0]["signal"], "flow");
        assert_eq!(series[0]["points"].as_array().unwrap().len(), 1);
        assert_eq!(series[1]["signal"], "temp");
        assert_eq!(series[1]["points"].as_array().unwrap().len(), 2);
        assert_eq!(series[1]["points"][0]["value"], 21.5);
        // Identity triple rides each entry.
        assert_eq!(series[0]["key"]["device"], "gw-1");
        assert_eq!(series[0]["instance"], "main");
    }

    /// §4.1a: the envelope header timestamp is emitted verbatim as `publishedTs` on every
    /// update entry and (latest-wins) on the series object; points never carry it, and the
    /// WP-D `sourceTimestamp` fallback semantics are untouched.
    #[test]
    fn published_ts_rides_updates_and_series() {
        let mut model = Model::new(ConsoleConfig::default());
        let out = model.ingest(data_event(canonical_body()));
        let frame = signals_push(&out).expect("signal push");
        for update in frame["updates"].as_array().unwrap() {
            assert_eq!(update["publishedTs"], "2026-07-10T00:00:00Z");
            assert!(update["point"].get("publishedTs").is_none());
        }
        // sourceTimestamp keeps its per-sample fallback, distinct from publishedTs.
        assert_eq!(
            frame["updates"][0]["sourceTimestamp"],
            "2026-07-10T00:00:01Z"
        );
        let snap = parse(&model.signals_frame(SignalsMode::Full));
        assert_eq!(snap["series"][0]["publishedTs"], "2026-07-10T00:00:00Z");

        // An envelope without a header timestamp omits publishedTs on updates and leaves the
        // series' latest-wins value in place.
        let mut bare = data_event(json!({"value": 1}));
        bare.source_timestamp = None;
        let out = model.ingest(bare);
        let frame = signals_push(&out).expect("push");
        assert!(frame["updates"][0].get("publishedTs").is_none());
        let snap = parse(&model.signals_frame(SignalsMode::Full));
        assert_eq!(snap["series"][0]["publishedTs"], "2026-07-10T00:00:00Z");
    }

    /// §5.1a/b/c: a sample carrying BOTH timestamps rides them verbatim on its point and, as
    /// the latest sample, on the series (full and summary alike) — no fold, no priority drop.
    #[test]
    fn verbatim_timestamp_pair_rides_points_and_series() {
        let mut model = Model::new(ConsoleConfig::default());
        model.ingest(data_event(json!({
            "samples": [{"value": 5, "quality": "GOOD",
                         "sourceTs": "2026-07-10T00:00:01Z", "serverTs": "2026-07-10T00:00:02Z"}]
        })));
        let snap = parse(&model.signals_frame(SignalsMode::Full));
        let series = &snap["series"][0];
        assert_eq!(series["points"][0]["sourceTs"], "2026-07-10T00:00:01Z");
        assert_eq!(series["points"][0]["serverTs"], "2026-07-10T00:00:02Z");
        assert_eq!(series["sourceTs"], "2026-07-10T00:00:01Z");
        assert_eq!(series["serverTs"], "2026-07-10T00:00:02Z");
        // Summary rows carry the pair too (lag without points).
        let summary = parse(&model.signals_frame(SignalsMode::Summary));
        assert_eq!(summary["series"][0]["sourceTs"], "2026-07-10T00:00:01Z");
        assert_eq!(summary["series"][0]["serverTs"], "2026-07-10T00:00:02Z");
    }

    /// §5.1c: the series pair describes the LATEST sample only — a newer sample without
    /// timestamps CLEARS it (per-sample facts, not latest-wins-retained metadata).
    #[test]
    fn series_timestamp_pair_cleared_when_latest_sample_lacks_them() {
        let mut model = Model::new(ConsoleConfig::default());
        model.ingest(data_event(json!({
            "samples": [{"value": 1, "sourceTs": "2026-07-10T00:00:01Z", "serverTs": "2026-07-10T00:00:02Z"}]
        })));
        model.ingest(data_event(json!({ "samples": [{"value": 2}] })));
        let snap = parse(&model.signals_frame(SignalsMode::Full));
        let series = &snap["series"][0];
        assert!(series.get("sourceTs").is_none());
        assert!(series.get("serverTs").is_none());
        // ...while the latest-wins publishedTs is retained by design.
        assert_eq!(series["publishedTs"], "2026-07-10T00:00:00Z");
    }

    /// §5.1d: the folded `sourceTimestamp` keeps its exact WP-D fallback semantics
    /// (sourceTs -> serverTs -> envelope timestamp) on the series and on every update entry.
    #[test]
    fn folded_source_timestamp_semantics_unchanged() {
        let mut model = Model::new(ConsoleConfig::default());
        let out = model.ingest(data_event(canonical_body()));
        let frame = signals_push(&out).expect("push");
        // Entry 1: sourceTs wins; entry 2 (serverTs-only): folds to serverTs.
        assert_eq!(
            frame["updates"][0]["sourceTimestamp"],
            "2026-07-10T00:00:01Z"
        );
        assert_eq!(
            frame["updates"][1]["sourceTimestamp"],
            "2026-07-10T00:00:02Z"
        );
        let snap = parse(&model.signals_frame(SignalsMode::Full));
        assert_eq!(snap["series"][0]["sourceTimestamp"], "2026-07-10T00:00:02Z");

        // Neither timestamp on the sample: falls to the envelope header timestamp.
        let out = model.ingest(data_event(json!({ "samples": [{"value": 9}] })));
        let frame = signals_push(&out).expect("push");
        assert_eq!(
            frame["updates"][0]["sourceTimestamp"],
            "2026-07-10T00:00:00Z"
        );
        let snap = parse(&model.signals_frame(SignalsMode::Full));
        assert_eq!(snap["series"][0]["sourceTimestamp"], "2026-07-10T00:00:00Z");
    }

    /// §5.1b/e: a serverTs-only (Modbus-like) sample yields a point and series with absent
    /// `sourceTs` and present `serverTs` — the client sees the honest pair, not a fold.
    #[test]
    fn server_ts_only_sample_has_absent_source_ts() {
        let mut model = Model::new(ConsoleConfig::default());
        model.ingest(data_event(json!({
            "samples": [{"value": 3, "quality": "GOOD", "serverTs": "2026-07-10T00:00:02Z"}]
        })));
        let snap = parse(&model.signals_frame(SignalsMode::Full));
        let series = &snap["series"][0];
        assert!(series["points"][0].get("sourceTs").is_none());
        assert_eq!(series["points"][0]["serverTs"], "2026-07-10T00:00:02Z");
        assert!(series.get("sourceTs").is_none());
        assert_eq!(series["serverTs"], "2026-07-10T00:00:02Z");
    }

    /// §6.1a/b: receipt stamps ride the model's own monotonic timeline. A regressing wall
    /// reading clamps flat (shared stamp) instead of storing a backward point/delta stamp,
    /// and stamps resume tracking the wall once it passes the clamp.
    #[test]
    fn receipt_stamps_never_regress() {
        let mut model = Model::new(ConsoleConfig::default());
        // Far-future base so the ambient wall clock (read by delta stamping) can never
        // overtake the clamp mid-test.
        let base = now_ms() + 1_000_000;
        let mut delta_ats = Vec::new();
        let mut ingest_at = |model: &mut Model, at: u64, value: i64| {
            let mut event = data_event(json!({ "value": value }));
            event.received_at = at;
            let outcome = model.ingest(event);
            let frame = outcome
                .events
                .iter()
                .find_map(|e| match e {
                    GatewayEvent::Deltas(frame) => Some(frame),
                    _ => None,
                })
                .expect("every data ingest emits a value-updated delta");
            for delta in parse(frame)["deltas"].as_array().unwrap() {
                delta_ats.push(delta["at"].as_u64().unwrap());
            }
        };
        ingest_at(&mut model, base, 1);
        ingest_at(&mut model, base - 50_000, 2); // the wall steps BACK 50 s
        ingest_at(&mut model, base + 10_000, 3); // the wall catches up past the clamp

        // Stored point stamps: flat through the backward window, then real time resumes.
        let snap = parse(&model.signals_frame(SignalsMode::Full));
        let ats: Vec<u64> = snap["series"][0]["points"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["at"].as_u64().unwrap())
            .collect();
        assert_eq!(ats, vec![base, base, base + 10_000]);
        // Delta-ring stamps never decrease; seq stays strictly increasing.
        assert!(delta_ats.windows(2).all(|w| w[0] <= w[1]));
        let seqs: Vec<u64> = model.deltas.iter().map(|(seq, _)| *seq).collect();
        assert!(seqs.windows(2).all(|w| w[0] < w[1]));
    }

    /// §6.1c: staleness ages on the same monotonic timeline. With the wall clock behind the
    /// model timeline (a backward step after events were stamped), sweep still ages components
    /// on the timeline — a degradation is not un-aged back to FRESH, and a fresh component is
    /// not double-aged.
    #[test]
    fn sweep_with_backward_stepped_clock_does_not_flip_liveness() {
        let mut model = Model::new(ConsoleConfig::default());
        // The model timeline runs ~1000 s ahead of the real wall — the backward-step window.
        let base = now_ms() + 1_000_000;
        let state_at = |component: &str, at: u64| IngressEvent {
            cls: "state".to_string(),
            channel: None,
            identity: identity_for(component),
            body: json!({"status": "RUNNING"}),
            tags: None,
            received_at: at,
            source_timestamp: None,
        };
        model.ingest(state_at("component-a", base));
        // The timeline advances 100 s (>> the 5 s x5 OFFLINE window) via another component.
        model.ingest(state_at("component-b", base + 100_000));

        // Raw-wall aging would saturate to age 0 and hold component-a FRESH (un-aged);
        // the clamped sweep ages it on the timeline instead.
        model.sweep();
        let snap = parse(&model.snapshot_frame());
        let components = snap["snapshot"]["devices"][0]["components"]
            .as_array()
            .unwrap();
        assert_eq!(components[0]["key"]["component"], "component-a");
        assert_eq!(components[0]["liveness"], "OFFLINE");
        assert_eq!(components[1]["key"]["component"], "component-b");
        assert_eq!(components[1]["liveness"], "FRESH");
    }

    /// §7.1b: a backward window yields exactly ONE observation — surfaced when the episode
    /// opens, carrying that window's deepest (first) step; deeper-tracking never re-observes,
    /// sub-threshold drift keeps the window open silently, and the next over-threshold step
    /// after the wall catches up is a NEW episode with its own observation.
    #[test]
    fn backward_step_raises_one_observation_per_episode() {
        let mut model = Model::new(ConsoleConfig::default());
        // Past base: every stamp in this test comes from the events themselves.
        let base = now_ms() - 1_000_000;
        let ingest_at = |model: &mut Model, at: u64| {
            let mut event = data_event(json!({ "value": 1 }));
            event.received_at = at;
            model.ingest(event).clock_step
        };
        assert!(ingest_at(&mut model, base).is_none()); // normal forward stamp
        // The sawtooth's back-step (2.3 s) opens the episode: one observation, max step.
        let obs = ingest_at(&mut model, base - 2_300).expect("episode open observes once");
        assert_eq!(obs.step_ms, 2_300);
        assert_eq!(obs.at, base);
        // Still behind (smaller regression): tracked, not re-observed.
        assert!(ingest_at(&mut model, base - 2_000).is_none());
        // Behind but under the 250 ms threshold: window stays open, still silent.
        assert!(ingest_at(&mut model, base - 100).is_none());
        // The wall catches up: the episode closes silently.
        assert!(ingest_at(&mut model, base + 100).is_none());
        // A second over-threshold step is a NEW episode: a second observation.
        let obs = ingest_at(&mut model, base - 1_000).expect("new episode observes again");
        assert_eq!(obs.step_ms, 1_100); // against the advanced timeline (base + 100)
    }

    /// §7.1d: after `clearAfterQuietSecs` without an episode, sweep surfaces the recovery
    /// exactly once.
    #[test]
    fn quiet_period_surfaces_recovery_once() {
        let mut model = Model::new(ConsoleConfig::default()); // clearAfterQuietSecs = 600
        // Fault long ago (past base, > 600 s before the real wall), then the wall recovered.
        let base = now_ms() - 2_000_000;
        let ingest_at = |model: &mut Model, at: u64| {
            let mut event = data_event(json!({ "value": 1 }));
            event.received_at = at;
            model.ingest(event).clock_step
        };
        assert!(ingest_at(&mut model, base).is_none());
        assert!(ingest_at(&mut model, base - 5_000).is_some()); // the fault
        assert!(ingest_at(&mut model, base + 1_000).is_none()); // wall caught up
        // The sweep's real-wall read is ~2000 s past the fault — quiet window satisfied.
        let out = model.sweep();
        assert!(out.clock_step.is_none());
        assert!(out.clock_recovered);
        // One-shot: the next sweep stays silent.
        assert!(!model.sweep().clock_recovered);
    }

    /// §8.1: `memory_series` rings with the exact `cpu_series` discipline — lockstep growth
    /// on sys ingests, snapshot + update frames carry `memorySeries`, a sys body without
    /// `memory_usage` leaves the ring untouched, and the 30-point cap holds.
    #[test]
    fn memory_series_rings_like_cpu() {
        let mut model = Model::new(ConsoleConfig::default());
        let sys_event = |body: Value, at: u64| IngressEvent {
            cls: "metric".to_string(),
            channel: Some("sys".to_string()),
            identity: identity(),
            body,
            tags: None,
            received_at: at,
            source_timestamp: None,
        };
        let attributes_push = |outcome: &IngestOutcome| -> Option<Value> {
            outcome.events.iter().find_map(|e| match e {
                GatewayEvent::Attributes(frame) => Some(parse(frame)),
                _ => None,
            })
        };

        // Two sys ingests grow both rings in lockstep; the update frame carries both series.
        model.ingest(sys_event(
            json!({"cpu_usage": 10.0, "memory_usage": 64.0}),
            1_000,
        ));
        let out = model.ingest(sys_event(
            json!({"cpu_usage": 20.0, "memory_usage": 66.0}),
            2_000,
        ));
        let update = &attributes_push(&out).expect("attribute update frame")["updates"][0];
        assert_eq!(update["cpuSeries"], json!([10.0, 20.0]));
        assert_eq!(update["memorySeries"], json!([64.0, 66.0]));

        // A sys body without memory_usage grows the CPU ring but leaves memory untouched.
        let out = model.ingest(sys_event(json!({"cpu_usage": 30.0}), 3_000));
        let update = &attributes_push(&out).expect("attribute update frame")["updates"][0];
        assert_eq!(update["cpuSeries"], json!([10.0, 20.0, 30.0]));
        assert_eq!(update["memorySeries"], json!([64.0, 66.0]));

        // The 30-point cap holds (drop-oldest), and the snapshot carries the ring too.
        for i in 0..35u64 {
            model.ingest(sys_event(
                json!({"cpu_usage": 1.0, "memory_usage": i as f64}),
                4_000 + i,
            ));
        }
        let snap = parse(&model.attributes_frame());
        let memory = snap["components"][0]["memorySeries"].as_array().unwrap();
        assert_eq!(memory.len(), 30);
        assert_eq!(memory[29], 34.0); // newest kept
        assert_eq!(memory[0], 5.0); // oldest evicted (64.0, 66.0 and 0..=4 gone)
        assert_eq!(
            snap["components"][0]["cpuSeries"].as_array().unwrap().len(),
            30
        );
    }

    #[test]
    fn log_matches_honors_level_and_since_id() {
        let record = |id: u64, level: &str| LogRecord {
            id,
            key: key_a(),
            instance: "main".to_string(),
            level: level.to_string(),
            logger: "l".to_string(),
            message: "m".to_string(),
            received_at: 0,
            source_timestamp: None,
            sequence: None,
            thread: None,
            fields: None,
            error: None,
            truncated: None,
            channel: None,
            tags: None,
        };
        let query = LogQuery {
            limit: None,
            levels: Some(vec!["error".to_string()]),
            since_id: Some(1),
        };
        assert!(!log_matches(&record(1, "error"), &query)); // id not > since_id
        assert!(!log_matches(&record(2, "info"), &query)); // level filtered
        assert!(log_matches(&record(2, "error"), &query));
    }

    #[test]
    fn resync_up_to_date_sends_nothing_but_gap_snapshots() {
        let mut model = Model::new(ConsoleConfig::default());
        model.ingest(IngressEvent {
            cls: "state".to_string(),
            channel: None,
            identity: identity(),
            body: json!({"status": "RUNNING"}),
            tags: None,
            received_at: 1_000,
            source_timestamp: None,
        });
        let seq = model.seq;
        // Up-to-date resume → nothing.
        assert!(model.resync_frame(Some(seq)).is_none());
        // Provable resume with pending deltas → a delta frame.
        let frame = model.resync_frame(Some(seq - 1)).expect("delta frame");
        let value = parse(&frame);
        assert_eq!(value["type"], "delta");
        assert!(!value["deltas"].as_array().unwrap().is_empty());
        // No resume seq → a snapshot frame.
        let frame = model.resync_frame(None).expect("snapshot frame");
        assert_eq!(parse(&frame)["type"], "snapshot");
        // Resume ahead of us → a snapshot frame (uncertain client).
        let frame = model.resync_frame(Some(seq + 5)).expect("snapshot frame");
        assert_eq!(parse(&frame)["type"], "snapshot");
    }
}

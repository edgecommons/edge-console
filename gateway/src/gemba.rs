//! Experimental multi-application browser protocol and 30 Hz egress coalescer.
//!
//! This module intentionally does not alter the existing Console v7 protocol. It is a feasibility
//! seam for independently hosted Gemba/Andon applications and is not a compatibility commitment.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::config::{AppCapability, AppConfig};

pub const APP_PROTOCOL_VERSION: i64 = 1;
pub const MAX_UI_UPDATE_HZ: u32 = 30;
/// Ceiling division keeps the actual cadence at or just below 30 Hz.
pub const UI_UPDATE_INTERVAL: Duration = Duration::from_nanos(33_333_334);
const MAX_ORDERED_FRAMES: usize = 256;
const MAX_PENDING_STATE_FRAMES: usize = 512;
const MAX_PENDING_BYTES: usize = 1024 * 1024;

/// Read-only frame families understood by the experimental app API.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum FrameFamily {
    Fleet,
    Events,
    Metrics,
    Logs,
    Signals,
    Attributes,
    Alarms,
}

impl FrameFamily {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Fleet => "fleet",
            Self::Events => "events",
            Self::Metrics => "metrics",
            Self::Logs => "logs",
            Self::Signals => "signals",
            Self::Attributes => "attributes",
            Self::Alarms => "alarms",
        }
    }

    fn is_ordered(self) -> bool {
        matches!(self, Self::Events | Self::Logs)
    }
}

impl From<AppCapability> for FrameFamily {
    fn from(value: AppCapability) -> Self {
        match value {
            AppCapability::Fleet => Self::Fleet,
            AppCapability::Events => Self::Events,
            AppCapability::Metrics => Self::Metrics,
            AppCapability::Logs => Self::Logs,
            AppCapability::Signals => Self::Signals,
            AppCapability::Attributes => Self::Attributes,
            AppCapability::Alarms => Self::Alarms,
        }
    }
}

impl TryFrom<&str> for FrameFamily {
    type Error = ();

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "fleet" => Ok(Self::Fleet),
            "events" => Ok(Self::Events),
            "metrics" => Ok(Self::Metrics),
            "logs" => Ok(Self::Logs),
            "signals" => Ok(Self::Signals),
            "attributes" => Ok(Self::Attributes),
            "alarms" => Ok(Self::Alarms),
            _ => Err(()),
        }
    }
}

/// Route-derived application policy. Browser input never chooses this identity or capability set.
#[derive(Debug, Clone)]
pub struct AppPolicy {
    pub id: String,
    pub allowed_origins: Vec<String>,
    allowed_roles: BTreeSet<String>,
    capabilities: BTreeSet<FrameFamily>,
}

impl AppPolicy {
    pub fn from_config(config: &AppConfig) -> Self {
        Self {
            id: config.id.clone(),
            allowed_origins: config.allowed_origins.clone(),
            allowed_roles: config.allowed_roles.iter().cloned().collect(),
            capabilities: config
                .capabilities
                .iter()
                .copied()
                .map(Into::into)
                .collect(),
        }
    }

    pub fn allows(&self, family: FrameFamily) -> bool {
        self.capabilities.contains(&family)
    }

    pub fn allows_role(&self, role: &str) -> bool {
        self.allowed_roles.contains(role)
    }

    fn capability_names(&self) -> Vec<&'static str> {
        self.capabilities
            .iter()
            .map(|family| family.as_str())
            .collect()
    }
}

struct PendingFrame {
    family: FrameFamily,
    value: Value,
    bytes: usize,
}

/// Per-connection protocol state and bounded pending egress.
pub struct GembaSession {
    policy: AppPolicy,
    role: String,
    ready: bool,
    subscriptions: BTreeSet<FrameFamily>,
    /// State frames are coalesced by family + projected item identity.
    pending_state: BTreeMap<(FrameFamily, String), PendingFrame>,
    /// Events and logs are ordered, bounded, and never silently converted to latest-value state.
    pending_ordered: VecDeque<PendingFrame>,
    pending_bytes: usize,
    fleet_seq_floor: u64,
    event_id_floor: u64,
    dropped_state: u64,
    dropped_ordered: u64,
    dropped_upstream: u64,
}

impl GembaSession {
    pub fn new(policy: AppPolicy, role: String) -> Self {
        Self {
            policy,
            role,
            ready: false,
            subscriptions: BTreeSet::new(),
            pending_state: BTreeMap::new(),
            pending_ordered: VecDeque::with_capacity(MAX_ORDERED_FRAMES),
            pending_bytes: 0,
            fleet_seq_floor: 0,
            event_id_floor: 0,
            dropped_state: 0,
            dropped_ordered: 0,
            dropped_upstream: 0,
        }
    }

    pub fn is_ready(&self) -> bool {
        self.ready
    }

    pub fn is_subscribed(&self, family: FrameFamily) -> bool {
        self.subscriptions.contains(&family)
    }

    pub fn subscriptions(&self) -> impl Iterator<Item = FrameFamily> + '_ {
        self.subscriptions.iter().copied()
    }

    /// Handle one client text frame. Protocol errors are explicit response frames and do not
    /// widen policy or touch the EdgeCommons message bus.
    pub fn handle_text(&mut self, text: &str) -> Vec<Value> {
        let value: Value = match serde_json::from_str(text) {
            Ok(value) => value,
            Err(_) => return vec![error("malformed", "invalid JSON")],
        };
        let Some(frame) = value.as_object() else {
            return vec![error("malformed", "frame must be a JSON object")];
        };
        if frame.get("protocolVersion").and_then(Value::as_i64) != Some(APP_PROTOCOL_VERSION) {
            return vec![error(
                "unsupported-protocol-version",
                "application protocol version must be 1",
            )];
        }
        let Some(ty) = frame.get("type").and_then(Value::as_str) else {
            return vec![error("malformed", "type must be a string")];
        };
        if !self.ready && ty != "hello" {
            return vec![error("hello-required", "hello must be the first frame")];
        }

        match ty {
            "hello" => {
                self.ready = true;
                vec![json!({
                    "type": "welcome",
                    "protocolVersion": APP_PROTOCOL_VERSION,
                    "appId": self.policy.id,
                    "role": self.role,
                    "capabilities": self.policy.capability_names(),
                    "maxUpdateHz": MAX_UI_UPDATE_HZ,
                })]
            }
            "subscribe" => self.subscribe(frame),
            // Commands are intentionally not part of AppCapability. This proves that the
            // route-derived application boundary denies them before the existing bus gateway.
            "command" | "invoke-command" => vec![error(
                "command-denied",
                "commands are not enabled for this application",
            )],
            _ => vec![error("malformed", "unknown frame type")],
        }
    }

    fn subscribe(&mut self, frame: &Map<String, Value>) -> Vec<Value> {
        let Some(requested) = frame.get("capabilities").and_then(Value::as_array) else {
            return vec![error(
                "malformed",
                "subscribe capabilities must be an array",
            )];
        };
        let mut parsed = BTreeSet::new();
        for value in requested {
            let Some(name) = value.as_str() else {
                return vec![error("malformed", "capability names must be strings")];
            };
            let Ok(family) = FrameFamily::try_from(name) else {
                return vec![error("capability-denied", "unknown capability")];
            };
            if !self.policy.allows(family) {
                return vec![error(
                    "capability-denied",
                    "application manifest does not allow the requested capability",
                )];
            }
            parsed.insert(family);
        }
        self.subscriptions = parsed;
        self.purge_unsubscribed();
        vec![json!({
            "type": "subscribed",
            "protocolVersion": APP_PROTOCOL_VERSION,
            "capabilities": self.subscriptions.iter().map(|family| family.as_str()).collect::<Vec<_>>(),
        })]
    }

    /// Add a current Console projection to the pending application update. State families are
    /// split into independently keyed entries when they carry `updates`/`deltas` arrays, then
    /// latest-wins by that key. Ordered families stay intact and ordered.
    pub fn push_frame(&mut self, family: FrameFamily, frame: Value) {
        if !self.ready || !self.is_subscribed(family) {
            return;
        }
        let Some(frame) = self.normalize_sequence(family, frame) else {
            return;
        };
        if family.is_ordered() {
            self.push_ordered(family, frame);
            return;
        }

        if let Some((array_name, items)) = state_items(&frame) {
            if items.is_empty() {
                self.push_state(family, "0:snapshot".to_string(), frame);
            } else {
                let mut template = frame.clone();
                template[array_name] = Value::Array(Vec::new());
                for item in items {
                    let mut single = template.clone();
                    single[array_name] = Value::Array(vec![item.clone()]);
                    self.push_state(
                        family,
                        format!("1:{}", projected_item_key(family, item)),
                        single,
                    );
                }
            }
        } else {
            self.push_state(family, "0:snapshot".to_string(), frame);
        }
    }

    fn normalize_sequence(&mut self, family: FrameFamily, mut frame: Value) -> Option<Value> {
        if family == FrameFamily::Fleet {
            if frame.get("type").and_then(Value::as_str) == Some("snapshot") {
                if let Some(seq) = frame.pointer("/snapshot/seq").and_then(Value::as_u64) {
                    self.fleet_seq_floor = self.fleet_seq_floor.max(seq);
                    self.remove_pending_state_family(FrameFamily::Fleet);
                }
            } else if let Some(deltas) = frame.get_mut("deltas").and_then(Value::as_array_mut) {
                deltas.retain(|delta| {
                    delta
                        .get("seq")
                        .and_then(Value::as_u64)
                        .is_none_or(|seq| seq > self.fleet_seq_floor)
                });
                let newest = deltas
                    .iter()
                    .filter_map(|delta| delta.get("seq").and_then(Value::as_u64))
                    .max();
                if let Some(newest) = newest {
                    self.fleet_seq_floor = self.fleet_seq_floor.max(newest);
                }
                if deltas.is_empty() {
                    return None;
                }
            }
        } else if family == FrameFamily::Events {
            match frame.get("type").and_then(Value::as_str) {
                Some("events") => {
                    if let Some(newest) = frame
                        .get("events")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(|event| event.get("id").and_then(Value::as_u64))
                        .max()
                    {
                        self.event_id_floor = self.event_id_floor.max(newest);
                    }
                }
                Some("event") => {
                    if let Some(id) = frame.pointer("/event/id").and_then(Value::as_u64) {
                        if id <= self.event_id_floor {
                            return None;
                        }
                        self.event_id_floor = id;
                    }
                }
                _ => {}
            }
        }
        Some(frame)
    }

    fn remove_pending_state_family(&mut self, family: FrameFamily) {
        let mut removed_bytes = 0usize;
        self.pending_state.retain(|(pending_family, _), frame| {
            let keep = *pending_family != family;
            if !keep {
                removed_bytes = removed_bytes.saturating_add(frame.bytes);
            }
            keep
        });
        self.pending_bytes = self.pending_bytes.saturating_sub(removed_bytes);
    }

    fn push_state(&mut self, family: FrameFamily, key: String, value: Value) {
        let bytes = serialized_size(&value);
        if bytes > MAX_PENDING_BYTES {
            self.dropped_state = self.dropped_state.saturating_add(1);
            return;
        }
        if let Some(replaced) = self.pending_state.remove(&(family, key.clone())) {
            self.pending_bytes = self.pending_bytes.saturating_sub(replaced.bytes);
        }
        while self.pending_state.len() >= MAX_PENDING_STATE_FRAMES
            || self.pending_bytes.saturating_add(bytes) > MAX_PENDING_BYTES
        {
            if let Some((_, evicted)) = self.pending_state.pop_first() {
                self.pending_bytes = self.pending_bytes.saturating_sub(evicted.bytes);
                self.dropped_state = self.dropped_state.saturating_add(1);
            } else if let Some(evicted) = self.pending_ordered.pop_front() {
                self.pending_bytes = self.pending_bytes.saturating_sub(evicted.bytes);
                self.dropped_ordered = self.dropped_ordered.saturating_add(1);
            } else {
                break;
            }
        }
        self.pending_bytes = self.pending_bytes.saturating_add(bytes);
        self.pending_state.insert(
            (family, key),
            PendingFrame {
                family,
                value,
                bytes,
            },
        );
    }

    fn push_ordered(&mut self, family: FrameFamily, value: Value) {
        let bytes = serialized_size(&value);
        if bytes > MAX_PENDING_BYTES {
            self.dropped_ordered = self.dropped_ordered.saturating_add(1);
            return;
        }
        while self.pending_ordered.len() >= MAX_ORDERED_FRAMES
            || self.pending_bytes.saturating_add(bytes) > MAX_PENDING_BYTES
        {
            if let Some(evicted) = self.pending_ordered.pop_front() {
                self.pending_bytes = self.pending_bytes.saturating_sub(evicted.bytes);
                self.dropped_ordered = self.dropped_ordered.saturating_add(1);
            } else if let Some((_, evicted)) = self.pending_state.pop_first() {
                self.pending_bytes = self.pending_bytes.saturating_sub(evicted.bytes);
                self.dropped_state = self.dropped_state.saturating_add(1);
            } else {
                break;
            }
        }
        self.pending_bytes = self.pending_bytes.saturating_add(bytes);
        self.pending_ordered.push_back(PendingFrame {
            family,
            value,
            bytes,
        });
    }

    fn purge_unsubscribed(&mut self) {
        let subscriptions = self.subscriptions.clone();
        self.pending_state
            .retain(|(family, _), _| subscriptions.contains(family));
        self.pending_ordered
            .retain(|frame| subscriptions.contains(&frame.family));
        self.pending_bytes = self
            .pending_state
            .values()
            .chain(self.pending_ordered.iter())
            .map(|frame| frame.bytes)
            .sum();
    }

    /// Drop pending pre-resync work after the shared broadcast reports lag. Retained snapshots
    /// then repopulate current state; the next update explicitly tells the app it crossed a gap.
    pub fn mark_resync_required(&mut self, skipped: u64) {
        self.pending_state.clear();
        self.pending_ordered.clear();
        self.pending_bytes = 0;
        self.dropped_upstream = self.dropped_upstream.saturating_add(skipped.max(1));
    }

    /// Drain at most one WebSocket message for the integration's 30 Hz interval tick.
    pub fn drain_updates(&mut self) -> Option<Value> {
        if self.pending_state.is_empty()
            && self.pending_ordered.is_empty()
            && self.dropped_state == 0
            && self.dropped_ordered == 0
            && self.dropped_upstream == 0
        {
            return None;
        }
        let mut frames = Vec::with_capacity(self.pending_state.len() + self.pending_ordered.len());
        frames.extend(
            std::mem::take(&mut self.pending_state)
                .into_values()
                .map(|frame| frame.value),
        );
        frames.extend(self.pending_ordered.drain(..).map(|frame| frame.value));
        self.pending_bytes = 0;
        let dropped_state = std::mem::take(&mut self.dropped_state);
        let dropped_ordered = std::mem::take(&mut self.dropped_ordered);
        let dropped_upstream = std::mem::take(&mut self.dropped_upstream);
        Some(json!({
            "type": "updates",
            "protocolVersion": APP_PROTOCOL_VERSION,
            "frames": frames,
            "overflow": {
                "droppedState": dropped_state,
                "droppedOrdered": dropped_ordered,
                "droppedUpstream": dropped_upstream,
                "resyncRequired": dropped_state > 0 || dropped_ordered > 0 || dropped_upstream > 0,
            },
        }))
    }
}

fn serialized_size(value: &Value) -> usize {
    serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len())
}

fn state_items(frame: &Value) -> Option<(&'static str, &[Value])> {
    for name in ["updates", "deltas", "series"] {
        if let Some(items) = frame.get(name).and_then(Value::as_array) {
            return Some((name, items));
        }
    }
    None
}

/// A stable-enough experiment key that excludes changing values while retaining the common
/// identity fields used by delta, metric, signal, and attribute projections.
fn projected_item_key(family: FrameFamily, item: &Value) -> String {
    let obj = item.as_object();
    let stable_name = (!matches!(family, FrameFamily::Signals | FrameFamily::Metrics))
        .then(|| obj.and_then(|value| value.get("name")))
        .flatten();
    json!([
        obj.and_then(|value| value.get("key")),
        obj.and_then(|value| value.get("device")),
        obj.and_then(|value| value.get("component")),
        obj.and_then(|value| value.get("instance")),
        obj.and_then(|value| value.get("signal")),
        obj.and_then(|value| value.get("metric")),
        obj.and_then(|value| value.get("measure")),
        stable_name,
        obj.and_then(|value| value.get("id")),
        obj.and_then(|value| value.get("channel")),
        obj.and_then(|value| value.get("type")),
    ])
    .to_string()
}

fn error(code: &'static str, message: &'static str) -> Value {
    json!({
        "type": "error",
        "protocolVersion": APP_PROTOCOL_VERSION,
        "code": code,
        "message": message,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(capabilities: &[FrameFamily]) -> AppPolicy {
        AppPolicy {
            id: "andon".to_string(),
            allowed_origins: Vec::new(),
            allowed_roles: BTreeSet::from(["viewer".to_string()]),
            capabilities: capabilities.iter().copied().collect(),
        }
    }

    fn ready_session(capabilities: &[FrameFamily]) -> GembaSession {
        let mut session = GembaSession::new(policy(capabilities), "viewer".to_string());
        let response = session.handle_text(r#"{"type":"hello","protocolVersion":1}"#);
        assert_eq!(response[0]["type"], "welcome");
        session
    }

    #[test]
    fn policy_denies_unknown_reads_and_all_commands_without_closing_session() {
        let mut session = ready_session(&[FrameFamily::Signals]);
        let denied = session
            .handle_text(r#"{"type":"subscribe","protocolVersion":1,"capabilities":["events"]}"#);
        assert_eq!(denied[0]["code"], "capability-denied");
        assert!(session.is_ready());
        assert!(!session.is_subscribed(FrameFamily::Events));

        let denied = session.handle_text(r#"{"type":"command","protocolVersion":1,"verb":"ping"}"#);
        assert_eq!(denied[0]["code"], "command-denied");
    }

    #[test]
    fn policy_requires_an_explicit_allowed_role() {
        let policy = policy(&[FrameFamily::Signals]);
        assert!(policy.allows_role("viewer"));
        assert!(!policy.allows_role("operator"));
        assert!(!policy.allows_role(""));
    }

    #[test]
    fn state_updates_coalesce_by_projected_identity() {
        let mut session = ready_session(&[FrameFamily::Signals]);
        session
            .handle_text(r#"{"type":"subscribe","protocolVersion":1,"capabilities":["signals"]}"#);
        for latest in 0..1_000 {
            session.push_frame(
                FrameFamily::Signals,
                json!({
                    "type": "signal",
                    "updates": [{
                        "key": {"device": "gw-1", "component": "modbus"},
                        "instance": "main",
                        "signal": "speed",
                        "latest": latest,
                    }]
                }),
            );
        }
        session.push_frame(
            FrameFamily::Signals,
            json!({
                "type": "signal",
                "updates": [{
                    "key": {"device": "gw-1", "component": "modbus"},
                    "instance": "main",
                    "signal": "temperature",
                    "latest": 42,
                }]
            }),
        );

        let batch = session
            .drain_updates()
            .expect("one bounded application update");
        let frames = batch["frames"].as_array().expect("frames array");
        assert_eq!(frames.len(), 2);
        assert!(
            frames
                .iter()
                .any(|frame| frame["updates"][0]["latest"] == 999)
        );
        assert!(
            frames
                .iter()
                .any(|frame| frame["updates"][0]["latest"] == 42)
        );
        assert!(session.drain_updates().is_none());
    }

    #[test]
    fn optional_signal_label_is_not_part_of_series_identity() {
        let mut session = ready_session(&[FrameFamily::Signals]);
        session
            .handle_text(r#"{"type":"subscribe","protocolVersion":1,"capabilities":["signals"]}"#);
        session.push_frame(
            FrameFamily::Signals,
            json!({
                "type": "signal",
                "updates": [{
                    "key": {"device": "gw-1", "component": "modbus"},
                    "instance": "main",
                    "signal": "speed",
                    "name": "Line speed",
                    "point": {"value": 1}
                }]
            }),
        );
        session.push_frame(
            FrameFamily::Signals,
            json!({
                "type": "signal",
                "updates": [{
                    "key": {"device": "gw-1", "component": "modbus"},
                    "instance": "main",
                    "signal": "speed",
                    "point": {"value": 2}
                }]
            }),
        );
        let batch = session.drain_updates().expect("coalesced signal");
        assert_eq!(batch["frames"].as_array().expect("frames").len(), 1);
        assert_eq!(batch["frames"][0]["updates"][0]["point"]["value"], 2);
    }

    #[test]
    fn empty_state_snapshot_is_delivered() {
        let mut session = ready_session(&[FrameFamily::Signals]);
        session
            .handle_text(r#"{"type":"subscribe","protocolVersion":1,"capabilities":["signals"]}"#);
        session.push_frame(
            FrameFamily::Signals,
            json!({ "type": "signals", "series": [] }),
        );
        let batch = session.drain_updates().expect("empty retained snapshot");
        assert_eq!(batch["frames"][0]["type"], "signals");
        assert_eq!(batch["frames"][0]["series"], json!([]));
    }

    #[test]
    fn metric_measures_have_distinct_coalescing_keys() {
        let mut session = ready_session(&[FrameFamily::Metrics]);
        session
            .handle_text(r#"{"type":"subscribe","protocolVersion":1,"capabilities":["metrics"]}"#);
        session.push_frame(
            FrameFamily::Metrics,
            json!({
                "type": "metrics",
                "series": [
                    { "key": "pump", "metric": "latency", "measure": "average", "latest": 10 },
                    { "key": "pump", "metric": "latency", "measure": "p95", "latest": 25 }
                ]
            }),
        );
        let batch = session.drain_updates().expect("metrics update");
        assert_eq!(batch["frames"].as_array().expect("frames").len(), 2);
    }

    #[test]
    fn ordered_frames_are_bounded_and_overflow_is_explicit() {
        let mut session = ready_session(&[FrameFamily::Events]);
        session
            .handle_text(r#"{"type":"subscribe","protocolVersion":1,"capabilities":["events"]}"#);
        for id in 0..300 {
            session.push_frame(FrameFamily::Events, json!({ "type": "event", "id": id }));
        }
        let batch = session.drain_updates().expect("bounded ordered update");
        let frames = batch["frames"].as_array().expect("frames array");
        assert_eq!(frames.len(), MAX_ORDERED_FRAMES);
        assert_eq!(frames.first().expect("first")["id"], 44);
        assert_eq!(frames.last().expect("last")["id"], 299);
        assert_eq!(batch["overflow"]["droppedOrdered"], 44);
        assert_eq!(batch["overflow"]["resyncRequired"], true);
    }

    #[test]
    fn unique_state_and_single_large_frames_are_memory_bounded() {
        let mut session = ready_session(&[FrameFamily::Signals]);
        session
            .handle_text(r#"{"type":"subscribe","protocolVersion":1,"capabilities":["signals"]}"#);
        for id in 0..1_000 {
            session.push_frame(
                FrameFamily::Signals,
                json!({ "type": "signal", "updates": [{ "key": id, "latest": id }] }),
            );
        }
        let batch = session.drain_updates().expect("bounded state update");
        assert!(batch["frames"].as_array().expect("frames").len() <= MAX_PENDING_STATE_FRAMES);
        assert!(batch["overflow"]["droppedState"].as_u64().unwrap_or(0) > 0);
        assert_eq!(session.pending_bytes, 0);

        session.push_frame(
            FrameFamily::Signals,
            json!({ "type": "signal", "blob": "x".repeat(MAX_PENDING_BYTES + 1) }),
        );
        let batch = session
            .drain_updates()
            .expect("oversized drop notification");
        assert!(batch["frames"].as_array().expect("frames").is_empty());
        assert_eq!(batch["overflow"]["droppedState"], 1);
        assert_eq!(batch["overflow"]["resyncRequired"], true);
    }

    #[test]
    fn narrowing_a_subscription_purges_removed_family_work() {
        let mut session = ready_session(&[FrameFamily::Signals, FrameFamily::Fleet]);
        session
            .handle_text(r#"{"type":"subscribe","protocolVersion":1,"capabilities":["signals"]}"#);
        session.push_frame(
            FrameFamily::Signals,
            json!({ "type": "signal", "updates": [{ "key": "speed", "latest": 12 }] }),
        );
        session.handle_text(r#"{"type":"subscribe","protocolVersion":1,"capabilities":["fleet"]}"#);
        assert!(session.drain_updates().is_none());
    }

    #[test]
    fn retained_snapshot_precedes_same_tick_live_state() {
        let mut session = ready_session(&[FrameFamily::Fleet]);
        session.handle_text(r#"{"type":"subscribe","protocolVersion":1,"capabilities":["fleet"]}"#);
        session.push_frame(
            FrameFamily::Fleet,
            json!({ "type": "snapshot", "seq": 10, "fleet": [] }),
        );
        session.push_frame(
            FrameFamily::Fleet,
            json!({ "type": "delta", "deltas": [{ "device": "gw-1", "seq": 11 }] }),
        );

        let batch = session.drain_updates().expect("snapshot and delta update");
        assert_eq!(batch["frames"][0]["type"], "snapshot");
        assert_eq!(batch["frames"][1]["type"], "delta");
    }

    #[test]
    fn retained_fleet_snapshot_rejects_stale_deltas() {
        let mut session = ready_session(&[FrameFamily::Fleet]);
        session.handle_text(r#"{"type":"subscribe","protocolVersion":1,"capabilities":["fleet"]}"#);
        session.push_frame(
            FrameFamily::Fleet,
            json!({ "type": "snapshot", "snapshot": { "seq": 10, "devices": [] } }),
        );
        session.push_frame(
            FrameFamily::Fleet,
            json!({ "type": "delta", "deltas": [{ "seq": 9 }, { "seq": 11 }] }),
        );
        let batch = session.drain_updates().expect("snapshot and fresh delta");
        assert_eq!(batch["frames"][0]["type"], "snapshot");
        assert_eq!(
            batch["frames"][1]["deltas"]
                .as_array()
                .expect("deltas")
                .len(),
            1
        );
        assert_eq!(batch["frames"][1]["deltas"][0]["seq"], 11);
    }

    #[test]
    fn retained_events_snapshot_rejects_duplicate_live_event() {
        let mut session = ready_session(&[FrameFamily::Events]);
        session
            .handle_text(r#"{"type":"subscribe","protocolVersion":1,"capabilities":["events"]}"#);
        session.push_frame(
            FrameFamily::Events,
            json!({ "type": "events", "events": [{ "id": 8 }, { "id": 7 }] }),
        );
        session.push_frame(
            FrameFamily::Events,
            json!({ "type": "event", "event": { "id": 8 } }),
        );
        session.push_frame(
            FrameFamily::Events,
            json!({ "type": "event", "event": { "id": 9 } }),
        );
        let batch = session.drain_updates().expect("deduplicated events");
        assert_eq!(batch["frames"].as_array().expect("frames").len(), 2);
        assert_eq!(batch["frames"][1]["event"]["id"], 9);
    }

    #[test]
    fn upstream_lag_discards_stale_pending_work_and_requires_resync() {
        let mut session = ready_session(&[FrameFamily::Events]);
        session
            .handle_text(r#"{"type":"subscribe","protocolVersion":1,"capabilities":["events"]}"#);
        session.push_frame(FrameFamily::Events, json!({ "type": "event", "id": 1 }));
        session.mark_resync_required(17);
        session.push_frame(
            FrameFamily::Events,
            json!({ "type": "events", "records": [{ "id": 20 }] }),
        );

        let batch = session.drain_updates().expect("resync update");
        assert_eq!(batch["frames"].as_array().expect("frames").len(), 1);
        assert_eq!(batch["frames"][0]["type"], "events");
        assert_eq!(batch["overflow"]["droppedOrdered"], 0);
        assert_eq!(batch["overflow"]["droppedUpstream"], 17);
        assert_eq!(batch["overflow"]["resyncRequired"], true);
    }

    #[test]
    fn cadence_constant_cannot_exceed_thirty_updates_per_second() {
        assert!(UI_UPDATE_INTERVAL * MAX_UI_UPDATE_HZ >= Duration::from_secs(1));
        assert!(UI_UPDATE_INTERVAL * (MAX_UI_UPDATE_HZ - 1) < Duration::from_secs(1));
    }
}

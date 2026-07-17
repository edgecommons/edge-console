use std::sync::Arc;

use edgecommons::config::model::Config;
use edgecommons::messaging::message::{HierEntry, Message, MessageBuilder, MessageIdentity};
use edgecommons::messaging::{MessagingService, message_handler};
use edgecommons::uns::{Uns, UnsClass, UnsScope};
use serde_json::{Value, json};
use tokio::sync::{RwLock, broadcast};

use crate::model::{GatewayEvent, Model, normalize_message};

const MAX_QUEUED_MESSAGES: usize = 256;
const BCAST_COMPONENT: &str = "_bcast";
const REPUBLISH_STATE: &str = "republish-state";
const REPUBLISH_CFG: &str = "republish-cfg";

pub const REPUBLISH_ALL_VERBS: &[&str] = &[REPUBLISH_STATE, REPUBLISH_CFG];
pub const REPUBLISH_CFG_VERBS: &[&str] = &[REPUBLISH_CFG];

/// The console's self-reported clock-fault channel: `evt/warning/clock-step`.
pub const CLOCK_STEP_CHANNEL: &str = "warning/clock-step";

pub async fn start_ingress(
    messaging: Arc<dyn MessagingService>,
    uns: Uns,
    core_config: Arc<Config>,
    model: Arc<RwLock<Model>>,
    events: broadcast::Sender<GatewayEvent>,
) -> edgecommons::Result<Vec<String>> {
    let classes = [
        ("state", UnsClass::State),
        ("cfg", UnsClass::Cfg),
        ("evt", UnsClass::Evt),
        ("metric", UnsClass::Metric),
        ("data", UnsClass::Data),
        ("log", UnsClass::Log),
    ];
    let mut filters = Vec::new();
    for (token, cls) in classes {
        // D-U28: the instance token is optional, so a fleet consumer must subscribe BOTH the
        // component-scope (`ecv1/+/+/{class}`) and instance-scope (`ecv1/+/+/+/{class}`) filters.
        // The two are disjoint (an instance id may not be a reserved class token) and neither
        // alone sees the whole fleet.
        for include_instance in [false, true] {
            let filter = uns.filter_scoped(cls, &UnsScope::all(), include_instance)?;
            let model_for_handler = model.clone();
            let events_for_handler = events.clone();
            let token_for_handler = token.to_string();
            let messaging_for_handler = messaging.clone();
            let uns_for_handler = uns.clone();
            let core_config_for_handler = core_config.clone();
            messaging
                .subscribe(
                    &filter,
                    message_handler(move |topic, msg| {
                        let model = model_for_handler.clone();
                        let events = events_for_handler.clone();
                        let token = token_for_handler.clone();
                        let messaging = messaging_for_handler.clone();
                        let uns = uns_for_handler.clone();
                        let core_config = core_config_for_handler.clone();
                        async move {
                            let Some(event) = normalize_message(&token, &topic, msg) else {
                                return;
                            };
                            let outcome = {
                                let mut guard = model.write().await;
                                guard.ingest(event)
                            };
                            for device in outcome.discovered_devices {
                                spawn_republish_verbs(
                                    messaging.clone(),
                                    uns.clone(),
                                    core_config.clone(),
                                    device,
                                    REPUBLISH_ALL_VERBS,
                                );
                            }
                            if let Some(step) = outcome.clock_step {
                                spawn_clock_event(
                                    messaging.clone(),
                                    uns.clone(),
                                    core_config.clone(),
                                    clock_step_body(step.step_ms),
                                );
                            }
                            for effect in outcome.events {
                                let _ = events.send(effect);
                            }
                        }
                    }),
                    MAX_QUEUED_MESSAGES,
                    1,
                )
                .await?;
            filters.push(filter);
        }
    }
    Ok(filters)
}

pub fn spawn_republish_verbs(
    messaging: Arc<dyn MessagingService>,
    uns: Uns,
    core_config: Arc<Config>,
    device: String,
    verbs: &'static [&'static str],
) {
    tokio::spawn(async move {
        broadcast_republish_verbs(messaging, uns, core_config, device, verbs).await;
    });
}

async fn broadcast_republish_verbs(
    messaging: Arc<dyn MessagingService>,
    uns: Uns,
    core_config: Arc<Config>,
    device: String,
    verbs: &'static [&'static str],
) {
    let target = match MessageIdentity::new(
        vec![HierEntry {
            level: "device".to_string(),
            value: device.clone(),
        }],
        BCAST_COMPONENT,
        // D-U28: component-scoped broadcast — `ecv1/{device}/_bcast/cmd/{verb}` (no `main`).
        None,
    ) {
        Ok(target) => target,
        Err(e) => {
            tracing::warn!(error = %e, device, "could not build republish target");
            return;
        }
    };
    for &verb in verbs {
        let topic = match uns.topic_for(&target, UnsClass::Cmd, Some(verb)) {
            Ok(topic) => topic,
            Err(e) => {
                tracing::warn!(error = %e, device, verb, "could not build republish topic");
                continue;
            }
        };
        let msg = MessageBuilder::new(verb, "1.0")
            .from_config(&core_config)
            .command(json!({}))
            .build();
        if let Err(e) = messaging.publish(&topic, &msg).await {
            tracing::warn!(error = %e, topic, device, verb, "republish publish failed");
        }
    }
}

/// The `evt/warning/clock-step` RAISE body (§7.2e): `active:true` raises/re-raises the
/// `clock-step` alarm through the console's own alarm ingestion.
pub fn clock_step_body(step_ms: u64) -> Value {
    json!({
        "message": format!(
            "gateway wall clock stepped backward {step_ms} ms; receipt timeline clamped (see console.clock)"
        ),
        "stepMs": step_ms,
        "active": true,
    })
}

/// The clearing body (§7.2e): `active:false` clears the alarm into history via the existing
/// convention.
pub fn clock_recovered_body(quiet_secs: u64) -> Value {
    json!({
        "message": format!("gateway wall clock stable for {quiet_secs} s"),
        "active": false,
    })
}

/// The canonical clock event envelope on the console's OWN identity — the same construction
/// the library's events facade uses (`"evt"/"1.0"` header, identity + tags from config,
/// `payload` body case), so the round-tripped envelope is indistinguishable from a
/// facade-published event.
pub fn clock_event_message(core_config: &Config, body: Value) -> Message {
    MessageBuilder::new("evt", "1.0")
        .from_config(core_config)
        .payload(body)
        .build()
}

/// Fire-and-forget front-door publish of a clock event: it round-trips through the gateway's
/// own `evt` subscription and raises/clears the `(own-device/edge-console)::clock-step` alarm
/// via the normal pipeline. Failures warn-log only — never block or fail ingest.
pub fn spawn_clock_event(
    messaging: Arc<dyn MessagingService>,
    uns: Uns,
    core_config: Arc<Config>,
    body: Value,
) {
    tokio::spawn(async move {
        let topic = match uns.topic_with_channel(UnsClass::Evt, CLOCK_STEP_CHANNEL) {
            Ok(topic) => topic,
            Err(e) => {
                tracing::warn!(error = %e, "could not build clock event topic");
                return;
            }
        };
        let msg = clock_event_message(&core_config, body);
        if let Err(e) = messaging.publish(&topic, &msg).await {
            tracing::warn!(error = %e, topic, "clock event publish failed");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{clock_event_message, clock_recovered_body, clock_step_body};
    use crate::config::ConsoleConfig;
    use crate::model::{GatewayEvent, IngressEvent, Model, normalize_message};
    use edgecommons::config::model::Config;
    use edgecommons::messaging::message::{HierEntry, MessageIdentity};
    use serde_json::{Value, json};

    fn state_event(component: &str, received_at: u64) -> IngressEvent {
        let identity = MessageIdentity::new(
            vec![HierEntry {
                level: "device".to_string(),
                value: "gw-1".to_string(),
            }],
            component,
            None,
        )
        .unwrap();
        IngressEvent {
            cls: "state".to_string(),
            channel: None,
            identity,
            body: json!({"status": "RUNNING"}),
            tags: None,
            received_at,
            source_timestamp: None,
        }
    }

    #[test]
    fn ingest_reports_first_seen_devices() {
        let mut model = Model::new(ConsoleConfig::default());
        // First event for the device reports it as discovered.
        let outcome = model.ingest(state_event("component-a", 1_000));
        assert_eq!(outcome.discovered_devices, vec!["gw-1".to_string()]);
        // A second event on the same (already-known) device reports no new discovery.
        let outcome = model.ingest(state_event("component-b", 1_001));
        assert!(outcome.discovered_devices.is_empty());
    }

    /// §7.4 emission shape, the round trip in miniature: the exact envelope the gateway
    /// publishes parses back through `normalize_message` + `ingest` like any component's
    /// event and raises exactly the expected alarm; the `active:false` clearing body
    /// resolves it through the same convention.
    #[test]
    fn clock_step_event_round_trips_to_alarm() {
        let core = Config::from_value("edge-console", "gw-1", json!({})).unwrap();
        // D-U28: the console is component-scoped, so its own evt is `.../edge-console/evt/...`.
        let topic = "ecv1/gw-1/edge-console/evt/warning/clock-step";
        let alarms_of = |outcome: &crate::model::IngestOutcome| -> Option<Value> {
            outcome.events.iter().find_map(|e| match e {
                GatewayEvent::Alarms(frame) => Some(serde_json::from_str(frame.as_str()).unwrap()),
                _ => None,
            })
        };

        // The raise: severity from the channel token, type from the channel tail.
        let msg = clock_event_message(&core, clock_step_body(2_300));
        let event = normalize_message("evt", topic, msg).expect("normalizes like any evt");
        assert_eq!(event.cls, "evt");
        assert_eq!(event.channel.as_deref(), Some("warning/clock-step"));
        assert_eq!(event.identity.device(), "gw-1");
        assert_eq!(event.identity.component(), "edge-console");

        let mut model = Model::new(ConsoleConfig::default());
        let outcome = model.ingest(event);
        assert!(
            outcome
                .events
                .iter()
                .any(|e| matches!(e, GatewayEvent::Event(_)))
        );
        let alarms = alarms_of(&outcome).expect("the raise emits an alarms frame");
        let active = alarms["snapshot"]["active"].as_array().unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0]["id"], "gw-1/edge-console::clock-step");
        assert_eq!(active[0]["severity"], "warning");
        assert!(
            active[0]["message"]
                .as_str()
                .unwrap()
                .contains("stepped backward 2300 ms")
        );
        assert_eq!(alarms["snapshot"]["counts"]["warning"], 1);

        // The clear: active:false resolves the same alarm into history.
        let msg = clock_event_message(&core, clock_recovered_body(600));
        let event = normalize_message("evt", topic, msg).unwrap();
        let outcome = model.ingest(event);
        let alarms = alarms_of(&outcome).expect("the clear emits an alarms frame");
        assert!(alarms["snapshot"]["active"].as_array().unwrap().is_empty());
        assert_eq!(alarms["snapshot"]["counts"]["active"], 0);
    }
}

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

pub const PROTOCOL_VERSION: i64 = 7;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ComponentKey {
    pub device: String,
    pub component: String,
}

impl ComponentKey {
    pub fn id(&self) -> String {
        format!("{}/{}", self.device, self.component)
    }
}

#[derive(Debug, Clone)]
pub struct LogQuery {
    pub limit: Option<usize>,
    pub levels: Option<Vec<String>>,
    pub since_id: Option<u64>,
}

/// `subscribe-signals` snapshot mode: `Full` carries every series' points ring; `Summary`
/// omits the `points` key entirely (the client backfills via `get-signal-points`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignalsMode {
    Full,
    Summary,
}

/// One `get-signal-points` selector — a series identity triple.
#[derive(Debug, Clone)]
pub struct SignalSelector {
    pub key: ComponentKey,
    pub instance: String,
    pub signal: String,
}

pub const MAX_SIGNAL_POINT_SELECTORS: usize = 200;

#[derive(Debug, Clone)]
pub enum ClientFrame {
    Hello {
        protocol_version: i64,
        resume_seq: Option<u64>,
    },
    GetConfig {
        protocol_version: i64,
        key: ComponentKey,
    },
    RefreshConfig {
        protocol_version: i64,
        device: String,
    },
    GetDescriptor {
        protocol_version: i64,
        key: ComponentKey,
    },
    RefreshDescriptor {
        protocol_version: i64,
        key: ComponentKey,
    },
    SubscribeEvents {
        protocol_version: i64,
        limit: Option<usize>,
    },
    UnsubscribeEvents {
        protocol_version: i64,
    },
    SubscribeMetrics {
        protocol_version: i64,
    },
    UnsubscribeMetrics {
        protocol_version: i64,
    },
    SubscribeLogs {
        protocol_version: i64,
        key: ComponentKey,
        query: LogQuery,
    },
    UnsubscribeLogs {
        protocol_version: i64,
        key: ComponentKey,
    },
    InvokeCommand {
        protocol_version: i64,
        request_id: String,
        key: ComponentKey,
        verb: String,
        args: Option<Map<String, Value>>,
    },
    SubscribeSignals {
        protocol_version: i64,
        mode: SignalsMode,
    },
    UnsubscribeSignals {
        protocol_version: i64,
    },
    GetSignalPoints {
        protocol_version: i64,
        series: Vec<SignalSelector>,
    },
    SubscribeAttributes {
        protocol_version: i64,
    },
    UnsubscribeAttributes {
        protocol_version: i64,
    },
    SubscribeAlarms {
        protocol_version: i64,
    },
    UnsubscribeAlarms {
        protocol_version: i64,
    },
    AckAlarm {
        protocol_version: i64,
        alarm_id: String,
    },
}

impl ClientFrame {
    pub fn protocol_version(&self) -> i64 {
        match self {
            ClientFrame::Hello {
                protocol_version, ..
            }
            | ClientFrame::GetConfig {
                protocol_version, ..
            }
            | ClientFrame::RefreshConfig {
                protocol_version, ..
            }
            | ClientFrame::GetDescriptor {
                protocol_version, ..
            }
            | ClientFrame::RefreshDescriptor {
                protocol_version, ..
            }
            | ClientFrame::SubscribeEvents {
                protocol_version, ..
            }
            | ClientFrame::UnsubscribeEvents { protocol_version }
            | ClientFrame::SubscribeMetrics { protocol_version }
            | ClientFrame::UnsubscribeMetrics { protocol_version }
            | ClientFrame::SubscribeLogs {
                protocol_version, ..
            }
            | ClientFrame::UnsubscribeLogs {
                protocol_version, ..
            }
            | ClientFrame::InvokeCommand {
                protocol_version, ..
            }
            | ClientFrame::SubscribeSignals {
                protocol_version, ..
            }
            | ClientFrame::UnsubscribeSignals { protocol_version }
            | ClientFrame::GetSignalPoints {
                protocol_version, ..
            }
            | ClientFrame::SubscribeAttributes { protocol_version }
            | ClientFrame::UnsubscribeAttributes { protocol_version }
            | ClientFrame::SubscribeAlarms { protocol_version }
            | ClientFrame::UnsubscribeAlarms { protocol_version }
            | ClientFrame::AckAlarm {
                protocol_version, ..
            } => *protocol_version,
        }
    }

    pub fn is_hello(&self) -> bool {
        matches!(self, ClientFrame::Hello { .. })
    }
}

pub fn parse_client_frame(raw: &str) -> Result<ClientFrame, String> {
    let value: Value = serde_json::from_str(raw).map_err(|_| "invalid JSON".to_string())?;
    let obj = value
        .as_object()
        .ok_or_else(|| "frame must be a JSON object".to_string())?;
    let protocol_version = obj
        .get("protocolVersion")
        .and_then(Value::as_i64)
        .ok_or_else(|| "protocolVersion must be an integer".to_string())?;
    let ty = obj
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "type must be a string".to_string())?;

    match ty {
        "hello" => {
            let resume_seq = match obj.get("resumeSeq") {
                Some(v) => Some(non_negative_u64(v, "resumeSeq")?),
                None => None,
            };
            Ok(ClientFrame::Hello {
                protocol_version,
                resume_seq,
            })
        }
        "get-config" => Ok(ClientFrame::GetConfig {
            protocol_version,
            key: parse_key(obj.get("key"), "get-config key")?,
        }),
        "refresh-config" => Ok(ClientFrame::RefreshConfig {
            protocol_version,
            device: non_empty_string(obj.get("device"), "refresh-config device")?,
        }),
        "get-descriptor" => Ok(ClientFrame::GetDescriptor {
            protocol_version,
            key: parse_key(obj.get("key"), "get-descriptor key")?,
        }),
        "refresh-descriptor" => Ok(ClientFrame::RefreshDescriptor {
            protocol_version,
            key: parse_key(obj.get("key"), "refresh-descriptor key")?,
        }),
        "subscribe-events" => Ok(ClientFrame::SubscribeEvents {
            protocol_version,
            limit: optional_positive_usize(obj.get("limit"), "subscribe-events limit")?,
        }),
        "unsubscribe-events" => Ok(ClientFrame::UnsubscribeEvents { protocol_version }),
        "subscribe-metrics" => Ok(ClientFrame::SubscribeMetrics { protocol_version }),
        "unsubscribe-metrics" => Ok(ClientFrame::UnsubscribeMetrics { protocol_version }),
        "subscribe-logs" => {
            let levels = match obj.get("levels") {
                Some(Value::Array(values)) => {
                    let mut parsed = Vec::new();
                    for value in values {
                        let level = value.as_str().ok_or_else(|| {
                            "subscribe-logs levels must be an array of known log levels".to_string()
                        })?;
                        if !is_log_level(level) {
                            return Err(
                                "subscribe-logs levels must be an array of known log levels"
                                    .to_string(),
                            );
                        }
                        if !parsed.iter().any(|p| p == level) {
                            parsed.push(level.to_string());
                        }
                    }
                    if parsed.is_empty() {
                        return Err("subscribe-logs levels must be an array of known log levels"
                            .to_string());
                    }
                    Some(parsed)
                }
                Some(_) => {
                    return Err(
                        "subscribe-logs levels must be an array of known log levels".to_string()
                    );
                }
                None => None,
            };
            Ok(ClientFrame::SubscribeLogs {
                protocol_version,
                key: parse_key(obj.get("key"), "subscribe-logs key")?,
                query: LogQuery {
                    limit: optional_positive_usize(obj.get("limit"), "subscribe-logs limit")?,
                    levels,
                    since_id: match obj.get("sinceId") {
                        Some(v) => Some(non_negative_u64(v, "subscribe-logs sinceId")?),
                        None => None,
                    },
                },
            })
        }
        "unsubscribe-logs" => Ok(ClientFrame::UnsubscribeLogs {
            protocol_version,
            key: parse_key(obj.get("key"), "unsubscribe-logs key")?,
        }),
        "invoke-command" => {
            let args = match obj.get("args") {
                Some(Value::Object(map)) => Some(map.clone()),
                Some(_) => {
                    return Err(
                        "invoke-command args, when present, must be a JSON object".to_string()
                    );
                }
                None => None,
            };
            Ok(ClientFrame::InvokeCommand {
                protocol_version,
                request_id: non_empty_string(obj.get("requestId"), "invoke-command requestId")?,
                key: parse_key(obj.get("key"), "invoke-command key")?,
                verb: non_empty_string(obj.get("verb"), "invoke-command verb")?,
                args,
            })
        }
        "subscribe-signals" => {
            let mode = match obj.get("mode").map(Value::as_str) {
                None => SignalsMode::Full,
                Some(Some("full")) => SignalsMode::Full,
                Some(Some("summary")) => SignalsMode::Summary,
                Some(_) => {
                    return Err(
                        "subscribe-signals mode must be \"full\" or \"summary\"".to_string()
                    );
                }
            };
            Ok(ClientFrame::SubscribeSignals {
                protocol_version,
                mode,
            })
        }
        "unsubscribe-signals" => Ok(ClientFrame::UnsubscribeSignals { protocol_version }),
        "get-signal-points" => {
            let entries = obj
                .get("series")
                .and_then(Value::as_array)
                .ok_or_else(|| "get-signal-points series must be an array".to_string())?;
            if entries.is_empty() || entries.len() > MAX_SIGNAL_POINT_SELECTORS {
                return Err(format!(
                    "get-signal-points series must carry 1 to {MAX_SIGNAL_POINT_SELECTORS} selectors"
                ));
            }
            let mut series = Vec::with_capacity(entries.len());
            for entry in entries {
                let selector = entry.as_object().ok_or_else(|| {
                    "get-signal-points selectors must be {key, instance, signal} objects"
                        .to_string()
                })?;
                series.push(SignalSelector {
                    key: parse_key(selector.get("key"), "get-signal-points key")?,
                    instance: non_empty_string(
                        selector.get("instance"),
                        "get-signal-points instance",
                    )?,
                    signal: non_empty_string(selector.get("signal"), "get-signal-points signal")?,
                });
            }
            Ok(ClientFrame::GetSignalPoints {
                protocol_version,
                series,
            })
        }
        "subscribe-attributes" => Ok(ClientFrame::SubscribeAttributes { protocol_version }),
        "unsubscribe-attributes" => Ok(ClientFrame::UnsubscribeAttributes { protocol_version }),
        "subscribe-alarms" => Ok(ClientFrame::SubscribeAlarms { protocol_version }),
        "unsubscribe-alarms" => Ok(ClientFrame::UnsubscribeAlarms { protocol_version }),
        "ack-alarm" => Ok(ClientFrame::AckAlarm {
            protocol_version,
            alarm_id: non_empty_string(obj.get("alarmId"), "ack-alarm alarmId")?,
        }),
        other => Err(format!("unknown message type '{other}'")),
    }
}

fn parse_key(value: Option<&Value>, field: &str) -> Result<ComponentKey, String> {
    let obj = value
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{field} must be {{device, component}} non-empty strings"))?;
    Ok(ComponentKey {
        device: non_empty_string(obj.get("device"), field)?,
        component: non_empty_string(obj.get("component"), field)?,
    })
}

fn non_empty_string(value: Option<&Value>, field: &str) -> Result<String, String> {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{field} must be a non-empty string"))
}

fn non_negative_u64(value: &Value, field: &str) -> Result<u64, String> {
    value
        .as_u64()
        .ok_or_else(|| format!("{field} must be a non-negative integer"))
}

fn optional_positive_usize(value: Option<&Value>, field: &str) -> Result<Option<usize>, String> {
    match value {
        None => Ok(None),
        Some(v) => {
            let n = v
                .as_u64()
                .filter(|n| *n >= 1)
                .ok_or_else(|| format!("{field} must be a positive integer"))?;
            usize::try_from(n)
                .map(Some)
                .map_err(|_| format!("{field} is too large"))
        }
    }
}

pub fn is_log_level(level: &str) -> bool {
    matches!(
        level,
        "trace" | "debug" | "info" | "warn" | "error" | "fatal"
    )
}

pub fn key_json(key: &ComponentKey) -> Value {
    json!({ "device": key.device, "component": key.component })
}

pub fn error_frame(code: &str, message: impl Into<String>) -> Value {
    json!({
        "type": "error",
        "protocolVersion": PROTOCOL_VERSION,
        "code": code,
        "message": message.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hello_resume() {
        let frame =
            parse_client_frame(r#"{"type":"hello","protocolVersion":7,"resumeSeq":42}"#).unwrap();
        assert!(matches!(
            frame,
            ClientFrame::Hello {
                protocol_version: 7,
                resume_seq: Some(42)
            }
        ));
    }

    #[test]
    fn rejects_unknown_frame() {
        let err = parse_client_frame(r#"{"type":"nope","protocolVersion":7}"#).unwrap_err();
        assert!(err.contains("unknown message type"));
    }

    /// §4.1b: absent/"full" ⇒ full snapshot, "summary" ⇒ summary, anything else ⇒ malformed.
    #[test]
    fn subscribe_signals_mode_is_strict() {
        let parse = |raw: &str| parse_client_frame(raw);
        assert!(matches!(
            parse(r#"{"type":"subscribe-signals","protocolVersion":7}"#).unwrap(),
            ClientFrame::SubscribeSignals {
                mode: SignalsMode::Full,
                ..
            }
        ));
        assert!(matches!(
            parse(r#"{"type":"subscribe-signals","protocolVersion":7,"mode":"full"}"#).unwrap(),
            ClientFrame::SubscribeSignals {
                mode: SignalsMode::Full,
                ..
            }
        ));
        assert!(matches!(
            parse(r#"{"type":"subscribe-signals","protocolVersion":7,"mode":"summary"}"#).unwrap(),
            ClientFrame::SubscribeSignals {
                mode: SignalsMode::Summary,
                ..
            }
        ));
        for raw in [
            r#"{"type":"subscribe-signals","protocolVersion":7,"mode":"points"}"#,
            r#"{"type":"subscribe-signals","protocolVersion":7,"mode":1}"#,
        ] {
            assert!(parse(raw).unwrap_err().contains("mode"));
        }
    }

    /// §4.1c: 1..=200 selectors, each a valid key + non-empty instance + non-empty signal.
    #[test]
    fn get_signal_points_validation_limits() {
        let selector =
            r#"{"key":{"device":"gw-1","component":"comp"},"instance":"main","signal":"temp"}"#;
        let frame_with = |series: &str| {
            parse_client_frame(&format!(
                r#"{{"type":"get-signal-points","protocolVersion":7,"series":{series}}}"#
            ))
        };
        // A single valid selector parses.
        let frame = frame_with(&format!("[{selector}]")).unwrap();
        let ClientFrame::GetSignalPoints { series, .. } = frame else {
            panic!("expected GetSignalPoints");
        };
        assert_eq!(series.len(), 1);
        assert_eq!(series[0].signal, "temp");
        // Exactly 200 selectors parse; 201 and 0 are rejected.
        let many = |n: usize| format!("[{}]", vec![selector; n].join(","));
        assert!(frame_with(&many(200)).is_ok());
        assert!(frame_with(&many(201)).unwrap_err().contains("1 to 200"));
        assert!(frame_with("[]").unwrap_err().contains("1 to 200"));
        // Missing series / non-array / invalid selectors are rejected.
        assert!(parse_client_frame(r#"{"type":"get-signal-points","protocolVersion":7}"#).is_err());
        assert!(frame_with(r#""nope""#).is_err());
        assert!(frame_with(r#"[42]"#).is_err());
        assert!(
            frame_with(
                r#"[{"key":{"device":"gw-1","component":"comp"},"instance":"","signal":"t"}]"#
            )
            .is_err()
        );
        assert!(
            frame_with(r#"[{"key":{"device":"gw-1","component":"comp"},"instance":"main"}]"#)
                .is_err()
        );
        assert!(frame_with(r#"[{"instance":"main","signal":"t"}]"#).is_err());
    }
}

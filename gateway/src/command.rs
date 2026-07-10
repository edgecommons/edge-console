use std::sync::Arc;
use std::time::{Duration, Instant};

use edgecommons::config::model::Config;
use edgecommons::messaging::MessagingService;
use edgecommons::messaging::message::{HierEntry, Message, MessageBuilder, MessageIdentity};
use edgecommons::uns::{Uns, UnsClass};
use serde_json::{Map, Value, json};

use crate::config::{ConsoleConfig, rbac_can};
use crate::protocol::{ComponentKey, PROTOCOL_VERSION, key_json};

#[derive(Clone)]
pub struct CommandGateway {
    messaging: Arc<dyn MessagingService>,
    uns: Uns,
    config: Arc<Config>,
    console: ConsoleConfig,
}

#[derive(Debug, Clone)]
pub struct CommandRequest {
    pub request_id: String,
    pub key: ComponentKey,
    pub verb: String,
    pub args: Option<Map<String, Value>>,
}

impl CommandGateway {
    pub fn new(
        messaging: Arc<dyn MessagingService>,
        uns: Uns,
        config: Arc<Config>,
        console: ConsoleConfig,
    ) -> Self {
        Self {
            messaging,
            uns,
            config,
            console,
        }
    }

    pub async fn invoke(&self, req: CommandRequest, role: &str) -> Value {
        let start = Instant::now();
        if !rbac_can(&self.console.rbac, role, &req.verb) {
            return self.result_frame(
                &req,
                false,
                None,
                Some(json!({
                    "code": "FORBIDDEN",
                    "message": format!("role '{role}' is not permitted to invoke '{}'", req.verb),
                })),
                0,
            );
        }

        let topic = match self.target_topic(&req.key, &req.verb) {
            Ok(topic) => topic,
            Err(e) => {
                return self.result_frame(
                    &req,
                    false,
                    None,
                    Some(json!({ "code": "INVALID_TARGET", "message": e.to_string() })),
                    elapsed_ms(start),
                );
            }
        };
        let body = req
            .args
            .clone()
            .map(Value::Object)
            .unwrap_or_else(|| json!({}));
        let message = MessageBuilder::new(req.verb.clone(), "1.0")
            .from_config(&self.config)
            .command(body)
            .build();
        let timeout_ms = self.timeout_for(&req.verb);
        let outcome = self
            .request(&topic, message, timeout_ms)
            .await
            .map(map_reply_body)
            .unwrap_or_else(|e| map_request_error(&e.to_string(), timeout_ms));

        match outcome {
            CommandOutcome::Ok(result) => {
                self.result_frame(&req, true, Some(result), None, elapsed_ms(start))
            }
            CommandOutcome::Err(error) => {
                self.result_frame(&req, false, None, Some(error), elapsed_ms(start))
            }
        }
    }

    pub async fn descriptor(&self, key: ComponentKey, role: &str) -> Value {
        let request_id = format!("descriptor-{}-{}", key.id(), crate::model::now_ms());
        let req = CommandRequest {
            request_id,
            key: key.clone(),
            verb: "describe".to_string(),
            args: None,
        };
        let result = self.invoke_raw(req, role).await;
        match result {
            CommandOutcome::Ok(value) => match normalize_describe_manifest(&value) {
                Some(manifest) => json!({
                    "type": "descriptor",
                    "protocolVersion": PROTOCOL_VERSION,
                    "key": key_json(&key),
                    "manifest": manifest,
                    "receivedAt": crate::model::now_ms(),
                }),
                None => json!({
                    "type": "descriptor-unavailable",
                    "protocolVersion": PROTOCOL_VERSION,
                    "key": key_json(&key),
                    "code": "MALFORMED_DESCRIBE",
                    "reason": "describe did not return a component manifest object",
                }),
            },
            CommandOutcome::Err(error) => json!({
                "type": "descriptor-unavailable",
                "protocolVersion": PROTOCOL_VERSION,
                "key": key_json(&key),
                "code": error.get("code").and_then(Value::as_str).unwrap_or("ERROR"),
                "reason": error.get("message").and_then(Value::as_str).unwrap_or("describe failed"),
            }),
        }
    }

    async fn invoke_raw(&self, req: CommandRequest, role: &str) -> CommandOutcome {
        if !rbac_can(&self.console.rbac, role, &req.verb) {
            return CommandOutcome::Err(json!({
                "code": "FORBIDDEN",
                "message": format!("role '{role}' is not permitted to invoke '{}'", req.verb),
            }));
        }
        let topic = match self.target_topic(&req.key, &req.verb) {
            Ok(topic) => topic,
            Err(e) => {
                return CommandOutcome::Err(json!({
                    "code": "INVALID_TARGET",
                    "message": e.to_string()
                }));
            }
        };
        let body = req.args.map(Value::Object).unwrap_or_else(|| json!({}));
        let message = MessageBuilder::new(req.verb.clone(), "1.0")
            .from_config(&self.config)
            .command(body)
            .build();
        let timeout_ms = self.timeout_for(&req.verb);
        self.request(&topic, message, timeout_ms)
            .await
            .map(map_reply_body)
            .unwrap_or_else(|e| map_request_error(&e.to_string(), timeout_ms))
    }

    async fn request(
        &self,
        topic: &str,
        message: Message,
        timeout_ms: u64,
    ) -> edgecommons::Result<Message> {
        let reply_future = self
            .messaging
            .request_with_timeout(topic, message, Some(Duration::from_millis(timeout_ms)))
            .await?;
        reply_future.await
    }

    fn target_topic(&self, key: &ComponentKey, verb: &str) -> edgecommons::Result<String> {
        let target = MessageIdentity::new(
            vec![HierEntry {
                level: "device".to_string(),
                value: key.device.clone(),
            }],
            key.component.clone(),
            Some(MessageIdentity::DEFAULT_INSTANCE.to_string()),
        )?;
        self.uns.topic_for(&target, UnsClass::Cmd, Some(verb))
    }

    fn timeout_for(&self, verb: &str) -> u64 {
        let chosen = self
            .console
            .commands
            .verb_timeouts
            .get(verb)
            .and_then(Value::as_u64)
            .unwrap_or(self.console.commands.default_timeout_ms);
        chosen.clamp(1, self.console.commands.max_timeout_ms)
    }

    fn result_frame(
        &self,
        req: &CommandRequest,
        ok: bool,
        result: Option<Value>,
        error: Option<Value>,
        elapsed_ms: u64,
    ) -> Value {
        let mut frame = json!({
            "type": "command-result",
            "protocolVersion": PROTOCOL_VERSION,
            "requestId": req.request_id,
            "key": key_json(&req.key),
            "verb": req.verb,
            "ok": ok,
            "elapsedMs": elapsed_ms,
        });
        if let Some(result) = result {
            frame["result"] = result;
        }
        if let Some(error) = error {
            frame["error"] = error;
        }
        frame
    }
}

enum CommandOutcome {
    Ok(Value),
    Err(Value),
}

fn map_reply_body(reply: Message) -> CommandOutcome {
    let Some(obj) = reply.body.as_object() else {
        return CommandOutcome::Err(json!({
            "code": "MALFORMED_REPLY",
            "message": "the command reply body was not the {ok, result|error} shape",
        }));
    };
    match obj.get("ok").and_then(Value::as_bool) {
        Some(true) => CommandOutcome::Ok(obj.get("result").cloned().unwrap_or_else(|| json!({}))),
        Some(false) => {
            let err = obj.get("error").and_then(Value::as_object);
            let code = err
                .and_then(|e| e.get("code"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or("ERROR");
            let message = err
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("");
            CommandOutcome::Err(json!({ "code": code, "message": message }))
        }
        _ => CommandOutcome::Err(json!({
            "code": "MALFORMED_REPLY",
            "message": "the command reply body was not the {ok, result|error} shape",
        })),
    }
}

fn map_request_error(message: &str, timeout_ms: u64) -> CommandOutcome {
    if message.contains("RequestTimeout")
        || message.contains("timed out")
        || message.contains("timeout")
    {
        CommandOutcome::Err(json!({
            "code": "TIMEOUT",
            "message": format!("no reply within {timeout_ms} ms"),
        }))
    } else {
        CommandOutcome::Err(json!({ "code": "REQUEST_FAILED", "message": message }))
    }
}

fn normalize_describe_manifest(result: &Value) -> Option<Value> {
    let obj = result.as_object()?;
    let mut manifest = Map::new();
    manifest.insert(
        "schema".to_string(),
        obj.get("schema")
            .or_else(|| obj.get("schemaVersion"))
            .and_then(Value::as_str)
            .map(|s| Value::String(s.to_string()))
            .unwrap_or_else(|| Value::String("edgecommons.component.describe.v1".to_string())),
    );
    if let Some(component) = obj.get("component").filter(|v| v.is_object()) {
        manifest.insert("component".to_string(), component.clone());
    }
    if let Some(digest) = obj.get("digest").and_then(Value::as_str) {
        manifest.insert("digest".to_string(), Value::String(digest.to_string()));
    }
    if let Some(commands) = normalize_commands(obj.get("commands")) {
        manifest.insert("commands".to_string(), commands);
    }
    if let Some(panels) = normalize_panels(obj.get("panels")) {
        manifest.insert("panels".to_string(), panels);
    }
    Some(Value::Object(manifest))
}

fn normalize_commands(value: Option<&Value>) -> Option<Value> {
    let values = match value {
        Some(Value::Array(values)) => values,
        Some(Value::Object(obj)) => obj.get("verbs")?.as_array()?,
        _ => return None,
    };
    let commands: Vec<Value> = values
        .iter()
        .filter(|v| {
            v.as_object()
                .and_then(|o| o.get("verb"))
                .and_then(Value::as_str)
                .is_some_and(|verb| !verb.is_empty())
        })
        .cloned()
        .collect();
    Some(Value::Array(commands))
}

fn normalize_panels(value: Option<&Value>) -> Option<Value> {
    let obj = value?.as_object()?;
    let views: Vec<Value> = obj
        .get("views")
        .and_then(Value::as_array)
        .map(|views| {
            views
                .iter()
                .filter(|view| {
                    view.as_object().is_some_and(|obj| {
                        obj.get("id")
                            .and_then(Value::as_str)
                            .is_some_and(|id| !id.is_empty())
                            && obj
                                .get("title")
                                .or_else(|| obj.get("label"))
                                .and_then(Value::as_str)
                                .is_some_and(|title| !title.is_empty())
                    })
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let mut panels = Map::new();
    panels.insert(
        "schema".to_string(),
        obj.get("schema")
            .or_else(|| obj.get("schemaVersion"))
            .and_then(Value::as_str)
            .map(|s| Value::String(s.to_string()))
            .unwrap_or_else(|| Value::String("edgecommons.panels.v2".to_string())),
    );
    if let Some(provider) = obj.get("provider").and_then(Value::as_str) {
        panels.insert("provider".to_string(), Value::String(provider.to_string()));
    }
    panels.insert(
        "renderer".to_string(),
        obj.get("renderer")
            .and_then(Value::as_str)
            .map(|s| Value::String(s.to_string()))
            .unwrap_or_else(|| Value::String("descriptor".to_string())),
    );
    if let Some(default_view) = obj.get("defaultView").and_then(Value::as_str) {
        panels.insert(
            "defaultView".to_string(),
            Value::String(default_view.to_string()),
        );
    }
    panels.insert("views".to_string(), Value::Array(views));
    Some(Value::Object(panels))
}

fn elapsed_ms(start: Instant) -> u64 {
    start.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_descriptor_panels() {
        let manifest = normalize_describe_manifest(&json!({
            "commands": { "verbs": [{ "verb": "sb/browse" }] },
            "panels": { "views": [{ "id": "overview", "title": "Overview" }] }
        }))
        .unwrap();
        assert_eq!(manifest["schema"], "edgecommons.component.describe.v1");
        assert_eq!(manifest["panels"]["renderer"], "descriptor");
        assert_eq!(manifest["commands"][0]["verb"], "sb/browse");
    }
}

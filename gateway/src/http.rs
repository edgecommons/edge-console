use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::net::SocketAddr;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::extract::ws::{Message as WsMessage, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use futures_util::{SinkExt, StreamExt};
use percent_encoding::percent_decode_str;
use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::{broadcast, mpsc};
use tokio::time::{Duration, interval};

use crate::ingress::{REPUBLISH_CFG_VERBS, spawn_republish_verbs};
use crate::model::{GatewayEvent, log_matches, log_push_frame};
use crate::protocol::{
    ClientFrame, ComponentKey, LogQuery, PROTOCOL_VERSION, error_frame, key_json,
    parse_client_frame,
};
use crate::{GatewayApp, SelfFrame};

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

/// A client with no `hello` inside this window is closed as malformed.
const HELLO_TIMEOUT: Duration = Duration::from_secs(20);

/// After forcing a fresh snapshot on a `Lagged` broadcast, further `Lagged` events inside this
/// window are ignored — the client is already getting a fresh snapshot, so re-snapshotting again
/// only piles on more work. Damps the Lagged→full-snapshot path.
const LAGGED_RESYNC_MIN_INTERVAL: Duration = Duration::from_secs(2);

pub async fn serve(
    app: Arc<GatewayApp>,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> anyhow::Result<()> {
    let addr: SocketAddr = format!("{}:{}", app.console.ws.bind_address, app.console.ws.port)
        .parse()
        .map_err(|e| anyhow::anyhow!("invalid console.ws bind address: {e}"))?;
    let router = Router::new()
        .route("/healthz", get(healthz))
        .route("/ws", get(ws_handler))
        .fallback(static_handler)
        .with_state(app);
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "edge-console Rust gateway listening");
    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown)
        .await?;
    Ok(())
}

async fn healthz() -> &'static str {
    "ok"
}

async fn ws_handler(State(app): State<Arc<GatewayApp>>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| handle_socket(app, socket))
}

async fn handle_socket(app: Arc<GatewayApp>, socket: WebSocket) {
    let id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
    let (mut sender, mut receiver) = socket.split();
    let mut bus_rx = app.events.subscribe();
    let (out_tx, mut out_rx) = mpsc::channel::<Utf8Bytes>(64);
    let mut heartbeat = interval(Duration::from_millis(app.console.ws.heartbeat_interval_ms));
    let mut session = SessionState::new(app.console.rbac.default_role.clone());
    tracing::debug!(session = id, "websocket connected");

    loop {
        tokio::select! {
            Some(msg) = receiver.next() => {
                match msg {
                    Ok(WsMessage::Text(text)) => {
                        if !handle_client_text(&app, &mut session, &out_tx, text.as_str(), &mut sender).await {
                            break;
                        }
                    }
                    Ok(WsMessage::Close(_)) => break,
                    Ok(WsMessage::Ping(bytes)) => {
                        if sender.send(WsMessage::Pong(bytes)).await.is_err() {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(e) => {
                        tracing::debug!(session = id, error = %e, "websocket receive failed");
                        break;
                    }
                }
            }
            Some(frame) = out_rx.recv() => {
                if send_text(&mut sender, frame).await.is_err() {
                    break;
                }
            }
            event = bus_rx.recv() => {
                match event {
                    Ok(event) => {
                        for frame in frames_for_event(&mut session, event) {
                            if send_text(&mut sender, frame).await.is_err() {
                                return;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if session.ready {
                            let now = std::time::Instant::now();
                            if should_force_resync(session.last_forced_resync, now) {
                                let frame = { app.model.read().await.snapshot_frame() };
                                session.last_forced_resync = Some(now);
                                if send_text(&mut sender, frame).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = heartbeat.tick() => {
                if session.ready {
                    let (rate, recent) = {
                        let guard = app.model.read().await;
                        (guard.bus_msgs_per_sec(), guard.bus_recent_rates())
                    };
                    let vitals = {
                        let mut guard = app.self_vitals.lock().expect("self-vitals mutex poisoned");
                        guard.sample_at(std::time::Instant::now())
                    };
                    let frame = heartbeat_frame(&app, rate, recent, vitals);
                    if send_text(&mut sender, frame).await.is_err() {
                        break;
                    }
                } else if session.hello_deadline_elapsed() {
                    let _ = send_text(&mut sender, json_text(error_frame("malformed", "no hello received within timeout"))).await;
                    let _ = sender.send(WsMessage::Close(None)).await;
                    break;
                }
            }
        }
    }
    tracing::debug!(session = id, "websocket disconnected");
}

async fn handle_client_text(
    app: &Arc<GatewayApp>,
    session: &mut SessionState,
    out_tx: &mpsc::Sender<Utf8Bytes>,
    text: &str,
    sender: &mut futures_util::stream::SplitSink<WebSocket, WsMessage>,
) -> bool {
    let frame = match parse_client_frame(text) {
        Ok(frame) => frame,
        Err(reason) => {
            let _ = send_text(sender, json_text(error_frame("malformed", reason))).await;
            let _ = sender.send(WsMessage::Close(None)).await;
            return false;
        }
    };
    if frame.protocol_version() != PROTOCOL_VERSION {
        let _ = send_text(
            sender,
            json_text(error_frame(
                "unsupported-protocol-version",
                format!(
                    "gateway is protocol v{}, client sent v{}",
                    PROTOCOL_VERSION,
                    frame.protocol_version()
                ),
            )),
        )
        .await;
        let _ = sender.send(WsMessage::Close(None)).await;
        return false;
    }
    // `hello` is the only frame allowed before the session is ready; everything else must wait.
    if !session.ready && !matches!(frame, ClientFrame::Hello { .. }) {
        let _ = send_text(
            sender,
            json_text(error_frame("malformed", "hello must be the first frame")),
        )
        .await;
        let _ = sender.send(WsMessage::Close(None)).await;
        return false;
    }

    match frame {
        ClientFrame::Hello { resume_seq, .. } => {
            session.ready = true;
            if send_text(
                sender,
                json_text(
                    json!({ "type": "welcome", "protocolVersion": PROTOCOL_VERSION, "role": session.role }),
                ),
            )
            .await
            .is_err()
            {
                return false;
            }
            // The settings frame was encoded once at startup; clone (refcount) it here.
            if send_text(sender, app.settings_frame.clone()).await.is_err() {
                return false;
            }
            let resync = { app.model.read().await.resync_frame(resume_seq) };
            match resync {
                // resume up-to-date: send nothing (matches TS)
                Some(frame) => send_text(sender, frame).await.is_ok(),
                None => true,
            }
        }
        ClientFrame::GetConfig { key, .. } => {
            session.config_keys.insert(key.id());
            let frame = { app.model.read().await.config_frame_for(&key) };
            match frame {
                Some(frame) => send_text(sender, frame).await.is_ok(),
                None => send_text(
                    sender,
                    json_text(json!({
                        "type": "config-unavailable",
                        "protocolVersion": PROTOCOL_VERSION,
                        "key": key_json(&key),
                    })),
                )
                .await
                .is_ok(),
            }
        }
        ClientFrame::RefreshConfig { device, .. } => {
            spawn_republish_verbs(
                app.messaging.clone(),
                app.uns.clone(),
                app.core_config.clone(),
                device,
                REPUBLISH_CFG_VERBS,
            );
            true
        }
        ClientFrame::GetDescriptor { key, .. } | ClientFrame::RefreshDescriptor { key, .. } => {
            let app = app.clone();
            let out_tx = out_tx.clone();
            let role = session.role.clone();
            tokio::spawn(async move {
                let frame = app.command.descriptor(key, &role).await;
                let _ = out_tx.send(json_text(frame)).await;
            });
            true
        }
        ClientFrame::SubscribeEvents { limit, .. } => {
            session.events_subscribed = true;
            let frame = { app.model.read().await.events_frame(limit) };
            send_text(sender, frame).await.is_ok()
        }
        ClientFrame::UnsubscribeEvents { .. } => {
            session.events_subscribed = false;
            true
        }
        ClientFrame::SubscribeMetrics { .. } => {
            session.metrics_subscribed = true;
            let frame = { app.model.read().await.metrics_frame() };
            send_text(sender, frame).await.is_ok()
        }
        ClientFrame::UnsubscribeMetrics { .. } => {
            session.metrics_subscribed = false;
            true
        }
        ClientFrame::SubscribeLogs { key, query, .. } => {
            session
                .log_subscriptions
                .insert(key.id(), (key.clone(), query.clone()));
            let frame = { app.model.read().await.logs_frame(&key, &query) };
            send_text(sender, frame).await.is_ok()
        }
        ClientFrame::UnsubscribeLogs { key, .. } => {
            session.log_subscriptions.remove(&key.id());
            true
        }
        ClientFrame::SubscribeSignals { mode, .. } => {
            session.signals_subscribed = true;
            let frame = { app.model.read().await.signals_frame(mode) };
            send_text(sender, frame).await.is_ok()
        }
        ClientFrame::UnsubscribeSignals { .. } => {
            session.signals_subscribed = false;
            true
        }
        ClientFrame::GetSignalPoints { series, .. } => {
            let frame = { app.model.read().await.signal_points_frame(&series) };
            send_text(sender, frame).await.is_ok()
        }
        ClientFrame::SubscribeAttributes { .. } => {
            session.attributes_subscribed = true;
            let frame = { app.model.read().await.attributes_frame() };
            send_text(sender, frame).await.is_ok()
        }
        ClientFrame::UnsubscribeAttributes { .. } => {
            session.attributes_subscribed = false;
            true
        }
        ClientFrame::SubscribeAlarms { .. } => {
            session.alarms_subscribed = true;
            let frame = { app.model.read().await.alarms_frame() };
            send_text(sender, frame).await.is_ok()
        }
        ClientFrame::UnsubscribeAlarms { .. } => {
            session.alarms_subscribed = false;
            true
        }
        ClientFrame::AckAlarm { alarm_id, .. } => {
            let event = { app.model.write().await.ack_alarm(&alarm_id) };
            if let Some(event) = event {
                let _ = app.events.send(event);
            }
            true
        }
        ClientFrame::InvokeCommand {
            request_id,
            key,
            verb,
            args,
            ..
        } => {
            let app = app.clone();
            let out_tx = out_tx.clone();
            let role = session.role.clone();
            tokio::spawn(async move {
                let frame = app
                    .command
                    .invoke(
                        crate::command::CommandRequest {
                            request_id,
                            key,
                            verb,
                            args,
                        },
                        &role,
                    )
                    .await;
                let _ = out_tx.send(json_text(frame)).await;
            });
            true
        }
    }
}

fn frames_for_event(session: &mut SessionState, event: GatewayEvent) -> Vec<Utf8Bytes> {
    if !session.ready {
        return Vec::new();
    }
    match event {
        GatewayEvent::Deltas(frame) => vec![frame],
        GatewayEvent::Config { key_id, frame } => {
            if session.config_keys.contains(&*key_id) {
                vec![frame]
            } else {
                Vec::new()
            }
        }
        GatewayEvent::Event(frame) => {
            if session.events_subscribed {
                vec![frame]
            } else {
                Vec::new()
            }
        }
        GatewayEvent::Metrics(frame) => {
            if session.metrics_subscribed {
                vec![frame]
            } else {
                Vec::new()
            }
        }
        GatewayEvent::Logs {
            key_id,
            record,
            dropped,
        } => {
            // Live pushes filter on sinceId + levels only (NOT limit) — matches TS
            // `filterLogRecords`.
            let Some((_, query)) = session.log_subscriptions.get(&*key_id) else {
                return Vec::new();
            };
            if log_matches(&record, query) {
                vec![log_push_frame(&record, dropped)]
            } else {
                Vec::new()
            }
        }
        GatewayEvent::Signals(frame) => {
            if session.signals_subscribed {
                vec![frame]
            } else {
                Vec::new()
            }
        }
        GatewayEvent::Attributes(frame) => {
            if session.attributes_subscribed {
                vec![frame]
            } else {
                Vec::new()
            }
        }
        GatewayEvent::Alarms(frame) => {
            if session.alarms_subscribed {
                vec![frame]
            } else {
                Vec::new()
            }
        }
    }
}

/// The single send path: hand it a `Utf8Bytes`. Shared fanout/backlog frames arrive pre-encoded
/// from the model and are cloned (a refcount bump, never a re-encode); small per-session frames are
/// encoded at the call site via [`json_text`] or [`heartbeat_frame`].
async fn send_text(
    sender: &mut futures_util::stream::SplitSink<WebSocket, WsMessage>,
    frame: Utf8Bytes,
) -> Result<(), axum::Error> {
    sender.send(WsMessage::Text(frame)).await
}

/// Encode a small per-session `Value` frame (welcome / error / config-unavailable / command
/// results) to bytes. These are tiny and built per session, so per-session encoding is fine.
fn json_text(frame: Value) -> Utf8Bytes {
    Utf8Bytes::from(frame.to_string())
}

/// The periodic `heartbeat` frame: keep-alive plus the console's own bus rate/sparkline and live
/// process vitals. Serialized per session per tick (small). All floats are finite by construction
/// (bus rates are integer counts; vitals drop any non-finite reading), so encoding is infallible.
fn heartbeat_frame(
    app: &Arc<GatewayApp>,
    bus_msgs_per_sec: f64,
    bus_recent_rates: Vec<f64>,
    vitals: crate::self_vitals::VitalsSample,
) -> Utf8Bytes {
    let frame = HeartbeatFrame {
        ty: "heartbeat",
        protocol_version: PROTOCOL_VERSION,
        at: crate::model::now_ms(),
        bus_msgs_per_sec,
        bus_recent_rates,
        self_: app.runtime.self_frame(vitals.cpu_percent, vitals.memory_mb),
    };
    Utf8Bytes::from(
        serde_json::to_string(&frame)
            .expect("heartbeat serialization is infallible: all floats are finite"),
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatFrame<'a> {
    #[serde(rename = "type")]
    ty: &'static str,
    protocol_version: i64,
    at: u64,
    bus_msgs_per_sec: f64,
    bus_recent_rates: Vec<f64>,
    #[serde(rename = "self")]
    self_: SelfFrame<'a>,
}

/// Whether a `Lagged` broadcast should force a fresh snapshot, given when the last forced resync
/// was sent. Within [`LAGGED_RESYNC_MIN_INTERVAL`] of the previous one, skip — the client is
/// already receiving a fresh snapshot.
fn should_force_resync(
    last_forced_resync: Option<std::time::Instant>,
    now: std::time::Instant,
) -> bool {
    match last_forced_resync {
        Some(prev) => now.duration_since(prev) >= LAGGED_RESYNC_MIN_INTERVAL,
        None => true,
    }
}

struct SessionState {
    connected_at: std::time::Instant,
    role: String,
    ready: bool,
    config_keys: HashSet<String>,
    events_subscribed: bool,
    metrics_subscribed: bool,
    log_subscriptions: HashMap<String, (ComponentKey, LogQuery)>,
    signals_subscribed: bool,
    attributes_subscribed: bool,
    alarms_subscribed: bool,
    /// When this session was last force-resnapshotted on a `Lagged` broadcast (damping).
    last_forced_resync: Option<std::time::Instant>,
}

impl SessionState {
    fn new(role: String) -> Self {
        Self {
            connected_at: std::time::Instant::now(),
            role,
            ready: false,
            config_keys: HashSet::new(),
            events_subscribed: false,
            metrics_subscribed: false,
            log_subscriptions: HashMap::new(),
            signals_subscribed: false,
            attributes_subscribed: false,
            alarms_subscribed: false,
            last_forced_resync: None,
        }
    }

    fn hello_deadline_elapsed(&self) -> bool {
        !self.ready && self.connected_at.elapsed() > HELLO_TIMEOUT
    }
}

async fn static_handler(State(app): State<Arc<GatewayApp>>, uri: Uri) -> Response {
    let Some(root) = &app.console.ws.web_root else {
        return StatusCode::NOT_FOUND.into_response();
    };
    match static_response(Path::new(root), uri.path()).await {
        Ok(response) => response,
        Err(status) => status.into_response(),
    }
}

async fn static_response(root: &Path, uri_path: &str) -> Result<Response, StatusCode> {
    let decoded = percent_decode_str(uri_path)
        .decode_utf8()
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let requested = safe_path(root, &decoded)?;
    let path = if decoded == "/" || decoded.is_empty() {
        root.join("index.html")
    } else if tokio::fs::metadata(&requested).await.is_ok() {
        requested
    } else if Path::new(decoded.as_ref()).extension().is_none() {
        root.join("index.html")
    } else {
        return Err(StatusCode::NOT_FOUND);
    };

    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    let mut response = Response::new(Body::from(bytes));
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_str(mime.as_ref())
            .unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    let cache = if path.file_name().and_then(|n| n.to_str()) == Some("index.html") {
        "no-cache"
    } else {
        "public, max-age=31536000, immutable"
    };
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static(cache));
    Ok(response)
}

fn safe_path(root: &Path, decoded: &str) -> Result<PathBuf, StatusCode> {
    let mut path = PathBuf::from(root);
    for component in Path::new(decoded.trim_start_matches('/')).components() {
        match component {
            Component::Normal(segment) => path.push(segment),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(StatusCode::BAD_REQUEST);
            }
        }
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::RuntimeInfo;

    #[test]
    fn safe_path_rejects_traversal() {
        assert!(safe_path(Path::new("/tmp/root"), "/../secret").is_err());
    }

    // Live-push log filtering (sinceId + levels, no limit) is proven by
    // `model::tests::log_matches_honors_level_and_since_id`.

    fn sample_runtime() -> RuntimeInfo {
        RuntimeInfo {
            device: "gw-01".to_string(),
            component: "com.mbreissi.edgecommons.EdgeConsole".to_string(),
            platform: Some("HOST".to_string()),
            transport: Some("MQTT".to_string()),
            broker: None,
            started_at: std::time::Instant::now(),
            worker_threads: 4,
            malloc_arena_max: Some(2),
        }
    }

    #[test]
    fn lagged_damping_forces_then_skips_within_interval() {
        let t0 = std::time::Instant::now();
        // No prior forced resync -> force a fresh snapshot.
        assert!(should_force_resync(None, t0));
        // Inside the 2 s window -> skip (client is already getting a fresh snapshot).
        assert!(!should_force_resync(
            Some(t0),
            t0 + Duration::from_millis(500)
        ));
        assert!(!should_force_resync(
            Some(t0),
            t0 + Duration::from_millis(1_999)
        ));
        // At/after the window -> force again.
        assert!(should_force_resync(Some(t0), t0 + Duration::from_secs(2)));
        assert!(should_force_resync(Some(t0), t0 + Duration::from_secs(5)));
    }

    #[test]
    fn heartbeat_frame_carries_rates_and_primed_vitals() {
        let runtime = sample_runtime();
        let frame = HeartbeatFrame {
            ty: "heartbeat",
            protocol_version: PROTOCOL_VERSION,
            at: 1234,
            bus_msgs_per_sec: 3.0,
            bus_recent_rates: vec![1.0, 2.0, 3.0],
            self_: runtime.self_frame(Some(4.5), Some(180.0)),
        };
        let v: Value = serde_json::from_str(&serde_json::to_string(&frame).unwrap()).unwrap();
        assert_eq!(v["type"], "heartbeat");
        assert_eq!(v["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(v["at"], 1234);
        assert_eq!(v["busMsgsPerSec"], 3.0);
        assert_eq!(v["busRecentRates"], json!([1.0, 2.0, 3.0]));
        assert_eq!(v["self"]["device"], "gw-01");
        assert_eq!(v["self"]["platform"], "HOST");
        // An absent identity field stays as `null` (unchanged wire shape).
        assert_eq!(v["self"]["broker"], Value::Null);
        assert!(v["self"]["uptimeSecs"].is_number());
        assert_eq!(v["self"]["runtime"]["workerThreads"], 4);
        assert_eq!(v["self"]["runtime"]["mallocArenaMax"], 2);
        // Vitals present when primed.
        assert_eq!(v["self"]["cpuPercent"], 4.5);
        assert_eq!(v["self"]["memoryMb"], 180.0);
    }

    #[test]
    fn heartbeat_self_omits_cpu_when_unprimed() {
        let runtime = sample_runtime();
        let self_frame = runtime.self_frame(None, Some(180.0));
        let v: Value = serde_json::from_str(&serde_json::to_string(&self_frame).unwrap()).unwrap();
        // cpu% is omitted (not a fabricated 0/null) until the sampler is primed.
        assert!(v.get("cpuPercent").is_none());
        assert_eq!(v["memoryMb"], 180.0);
    }
}

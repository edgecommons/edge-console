pub mod command;
pub mod config;
pub mod http;
pub mod ingress;
pub mod model;
pub mod protocol;
pub mod self_vitals;

use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::extract::ws::Utf8Bytes;
use edgecommons::config::model::Config;
use edgecommons::messaging::MessagingService;
use edgecommons::uns::Uns;
use serde::Serialize;
use tokio::sync::{RwLock, broadcast};

use crate::command::CommandGateway;
use crate::config::ConsoleConfig;
use crate::model::{GatewayEvent, Model};
use crate::self_vitals::SelfVitals;

#[derive(Clone)]
pub struct RuntimeInfo {
    pub device: String,
    pub component: String,
    pub platform: Option<String>,
    pub transport: Option<String>,
    pub broker: Option<String>,
    pub started_at: Instant,
    pub worker_threads: usize,
    pub malloc_arena_max: Option<usize>,
}

impl RuntimeInfo {
    /// The heartbeat `self` frame body: static identity + live process vitals. `cpu_percent` and
    /// `memory_mb` are folded in from [`SelfVitals`] and omitted (never fabricated) when absent.
    pub fn self_frame(&self, cpu_percent: Option<f64>, memory_mb: Option<f64>) -> SelfFrame<'_> {
        SelfFrame {
            device: &self.device,
            component: &self.component,
            platform: self.platform.as_deref(),
            transport: self.transport.as_deref(),
            broker: self.broker.as_deref(),
            uptime_secs: self.started_at.elapsed().as_secs(),
            runtime: SelfRuntime {
                worker_threads: self.worker_threads,
                malloc_arena_max: self.malloc_arena_max,
            },
            cpu_percent,
            memory_mb,
        }
    }
}

/// The `self` object on the heartbeat frame (`ConsoleSelf`). `platform`/`transport`/`broker`
/// serialize as `null` when absent (unchanged wire shape); the process vitals are dropped entirely
/// when unavailable so the UI shows "—" rather than a fabricated 0.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfFrame<'a> {
    pub device: &'a str,
    pub component: &'a str,
    pub platform: Option<&'a str>,
    pub transport: Option<&'a str>,
    pub broker: Option<&'a str>,
    pub uptime_secs: u64,
    pub runtime: SelfRuntime,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_mb: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfRuntime {
    pub worker_threads: usize,
    pub malloc_arena_max: Option<usize>,
}

#[derive(Clone)]
pub struct GatewayApp {
    pub model: Arc<RwLock<Model>>,
    pub events: broadcast::Sender<GatewayEvent>,
    pub command: Arc<CommandGateway>,
    pub console: ConsoleConfig,
    /// The `{"type":"settings",...}` frame, encoded once at startup (see `main.rs`); the hello
    /// path clones it (a refcount bump), never re-encodes.
    pub settings_frame: Utf8Bytes,
    pub runtime: RuntimeInfo,
    /// The console's own process-vitals sampler, shared across sessions (one refresh per cadence).
    pub self_vitals: Arc<Mutex<SelfVitals>>,
    pub messaging: Arc<dyn MessagingService>,
    pub uns: Uns,
    pub core_config: Arc<Config>,
}

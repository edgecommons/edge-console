use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::extract::ws::Utf8Bytes;
use edge_console_gateway::command::CommandGateway;
use edge_console_gateway::config::ConsoleConfig;
use edge_console_gateway::ingress::{
    clock_recovered_body, clock_step_body, spawn_clock_event, start_ingress,
};
use edge_console_gateway::model::Model;
use edge_console_gateway::protocol::PROTOCOL_VERSION;
use edge_console_gateway::self_vitals::SelfVitals;
use edge_console_gateway::{GatewayApp, RuntimeInfo};
use edgecommons::prelude::*;
use serde_json::{Value, json};
use tokio::sync::{RwLock, broadcast};
use tokio::time::{Duration, interval};

// glibc-malloc parks freed small allocations on per-arena free lists rather than returning them to
// the OS, so the snapshot-burst allocations ratchet RSS upward across refreshes; mimalloc returns
// memory to the OS and holds RSS flat. (MALLOC_ARENA_MAX below still governs any non-Rust / glibc
// allocation.)
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

const COMPONENT_NAME: &str = "com.mbreissi.edgecommons.EdgeConsole";
const DEFAULT_WORKER_THREADS: usize = 4;
const MAX_WORKER_THREADS: usize = 128;
const WORKER_THREADS_ENV: &str = "EDGECONSOLE_WORKER_THREADS";
const MALLOC_ARENA_MAX_ENV: &str = "MALLOC_ARENA_MAX";

#[derive(Debug, Clone)]
struct LaunchRuntimeConfig {
    worker_threads: usize,
    malloc_arena_max: Option<usize>,
}

fn main() -> anyhow::Result<()> {
    let launch = LaunchRuntimeConfig::from_env();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(launch.worker_threads)
        .thread_name("edge-console-gateway")
        .enable_all()
        .build()?;
    runtime.block_on(run(launch))
}

async fn run(launch: LaunchRuntimeConfig) -> anyhow::Result<()> {
    let gg = Arc::new(
        EdgeCommonsBuilder::new(COMPONENT_NAME)
            .args(std::env::args_os())
            .build()
            .await?,
    );
    let core_config = gg.config();
    let console = ConsoleConfig::from_global(core_config.global());
    report_launch_runtime(&console, &launch);
    let messaging = gg.messaging()?;
    let uns = gg.uns();
    let model = Arc::new(RwLock::new(Model::new(console.clone())));
    let (events, _) = broadcast::channel(console.runtime.event_buffer_capacity);

    let runtime = RuntimeInfo {
        device: core_config.identity().device().to_string(),
        component: core_config.identity().component().to_string(),
        platform: Some(format!("{:?}", gg.args().platform).to_ascii_uppercase()),
        transport: Some(format!("{:?}", gg.args().transport).to_ascii_uppercase()),
        broker: broker_host(&core_config.raw),
        started_at: Instant::now(),
        worker_threads: launch.worker_threads,
        malloc_arena_max: launch.malloc_arena_max,
    };
    // Encode the settings frame exactly once at startup; every hello clones the bytes.
    let settings_frame = Utf8Bytes::from(
        json!({
            "type": "settings",
            "protocolVersion": PROTOCOL_VERSION,
            "settings": console.settings(&runtime),
        })
        .to_string(),
    );

    let command = Arc::new(CommandGateway::new(
        messaging.clone(),
        uns.clone(),
        core_config.clone(),
        console.clone(),
    ));
    let app = Arc::new(GatewayApp {
        model: model.clone(),
        events: events.clone(),
        command,
        console: console.clone(),
        settings_frame,
        runtime,
        self_vitals: Arc::new(Mutex::new(SelfVitals::new())),
        messaging: messaging.clone(),
        uns: uns.clone(),
        core_config: core_config.clone(),
    });

    let filters = start_ingress(
        messaging.clone(),
        uns.clone(),
        core_config.clone(),
        model.clone(),
        events.clone(),
    )
    .await?;
    tracing::info!(filters = ?filters, "edge-console bus ingress subscribed");
    spawn_sweeper(model, events, &console, messaging, uns, core_config.clone());
    gg.set_ready(true);

    let gg_for_shutdown = gg.clone();
    edge_console_gateway::http::serve(app, async move {
        gg_for_shutdown.shutdown_signal().await;
    })
    .await?;
    Ok(())
}

impl LaunchRuntimeConfig {
    fn from_env() -> Self {
        let worker_threads = env_positive_usize(WORKER_THREADS_ENV)
            .unwrap_or(DEFAULT_WORKER_THREADS)
            .clamp(1, MAX_WORKER_THREADS);
        let malloc_arena_max = env_positive_usize(MALLOC_ARENA_MAX_ENV);
        Self {
            worker_threads,
            malloc_arena_max,
        }
    }
}

fn report_launch_runtime(console: &ConsoleConfig, launch: &LaunchRuntimeConfig) {
    if console.runtime.worker_threads != launch.worker_threads {
        tracing::warn!(
            configured_worker_threads = console.runtime.worker_threads,
            effective_worker_threads = launch.worker_threads,
            env = WORKER_THREADS_ENV,
            "console.runtime.workerThreads is launch-latched; restart with matching startup environment to apply it"
        );
    } else {
        tracing::info!(
            worker_threads = launch.worker_threads,
            "edge-console tokio runtime configured"
        );
    }

    if console.runtime.malloc_arena_max != launch.malloc_arena_max {
        tracing::warn!(
            configured_malloc_arena_max = console.runtime.malloc_arena_max,
            effective_malloc_arena_max = launch.malloc_arena_max,
            env = MALLOC_ARENA_MAX_ENV,
            "console.runtime.mallocArenaMax must be exported before process start to affect glibc"
        );
    } else if let Some(value) = launch.malloc_arena_max {
        tracing::info!(
            malloc_arena_max = value,
            "glibc malloc arena cap configured"
        );
    }
}

fn env_positive_usize(name: &str) -> Option<usize> {
    let raw = match std::env::var(name) {
        Ok(raw) => raw,
        Err(std::env::VarError::NotPresent) => return None,
        Err(err) => {
            eprintln!("ignoring {name}: {err}");
            return None;
        }
    };
    match raw.parse::<usize>() {
        Ok(value) if value > 0 => Some(value),
        _ => {
            eprintln!("ignoring {name}: expected a positive integer, got {raw:?}");
            None
        }
    }
}

fn spawn_sweeper(
    model: Arc<RwLock<Model>>,
    events: broadcast::Sender<edge_console_gateway::model::GatewayEvent>,
    console: &ConsoleConfig,
    messaging: Arc<dyn edgecommons::messaging::MessagingService>,
    uns: edgecommons::uns::Uns,
    core_config: Arc<edgecommons::config::model::Config>,
) {
    let sweep_interval_ms = console.staleness.sweep_interval_ms;
    let quiet_secs = console.clock.clear_after_quiet_secs;
    tokio::spawn(async move {
        let mut tick = interval(Duration::from_millis(sweep_interval_ms.max(100)));
        loop {
            tick.tick().await;
            let outcome = {
                let mut guard = model.write().await;
                guard.sweep()
            };
            // Clock-fault reporting goes through the front door: a canonical evt on the
            // console's own identity, round-tripped through its own subscription (§7.2).
            if let Some(step) = outcome.clock_step {
                spawn_clock_event(
                    messaging.clone(),
                    uns.clone(),
                    core_config.clone(),
                    clock_step_body(step.step_ms),
                );
            }
            if outcome.clock_recovered {
                spawn_clock_event(
                    messaging.clone(),
                    uns.clone(),
                    core_config.clone(),
                    clock_recovered_body(quiet_secs),
                );
            }
            for effect in outcome.events {
                let _ = events.send(effect);
            }
        }
    });
}

fn broker_host(raw: &Value) -> Option<String> {
    raw.pointer("/messaging/local/host")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

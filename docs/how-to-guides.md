# How-to Guides

Recipes for specific tasks. Each assumes the console builds and runs (see the [tutorial](tutorial.md)).
For concepts see [explanation.md](explanation.md); for exhaustive options see [reference/](reference/).

---

## Build the workspace

The repo contains the shared TypeScript protocol, the Carbon/React UI, and the Rust gateway:

```bash
npm run link:rust    # dev only: satisfy the Rust gateway from sibling ../core/libs/rust
npm install
npm run build        # protocol -> ui -> Rust edge-console-gateway
cargo test -p edge-console-gateway  # gateway unit suite (injected clock, fake bus — no live IO)
npm test             # protocol + ui unit suites (fake socket, injected clock — no live IO)
npm run coverage     # vitest v8 coverage over protocol + ui (the ecosystem gate)
npm run lint         # eslint (flat config) over the whole workspace
```

`npm run link:rust` generates the **gitignored** Rust crate/proto links the gateway builds against.
CI points the script at the checked-out core repo.

---

## Point the console at your site broker

The console has **one** connection — the *site broker*, the aggregation point every device's `uns-bridge`
relays into. It is an ordinary edgecommons `messaging.local` block:

```jsonc
"messaging": {
  "local": { "host": "site-broker.internal", "port": 1883, "clientId": "edge-console" },
  "requestTimeoutSeconds": 30
}
```

- On a **single-device** deployment, `messaging.local` is that device's local bus.
- On **Kubernetes**, it is the in-cluster broker Service.
- Give the console its **own thing name** (`-t site-console`) so it doesn't self-appear as a device under
  the fleet it watches.

See [reference — configuration](reference/configuration.md#config-source) for the `--transport MQTT
<file>` alternative.

---

## Deploy on HOST (a plain process)

```bash
target/release/edge-console-gateway \
  --platform HOST --transport MQTT ./messaging.json \
  -c FILE ./config.json \
  -t site-console
```

- `--transport MQTT <file>` supplies the broker connection; the same file can carry the whole config
  (its `messaging.local` is the site broker), which is why the tutorial passes `config.json` twice.
- The WebSocket gateway binds `console.ws.bindAddress:console.ws.port` (default `127.0.0.1:8443`
  (loopback); set `bindAddress` to `0.0.0.0` to accept remote connections). Reach the UI over that port
  (behind a TLS terminator — see below).

---

## Deploy self-contained (serve the built UI from the server — no Vite, no nginx)

Set `component.global.console.ws.webRoot` to the built `ui/dist` and the gateway serves its own UI as
static files on the **same** origin as the WebSocket — one process, no sidecar:

```jsonc
"component": { "global": { "console": {
  "ws": { "port": 8443, "bindAddress": "0.0.0.0", "webRoot": "../ui/dist" }
} } }
```

```bash
npm run build                         # produces ui/dist
target/release/edge-console-gateway --platform HOST --transport MQTT ./config.json -c FILE ./config.json -t site-console
# Browse straight to http://<host>:8443/ — index.html + hashed assets served by the console itself.
```

- **Opt-in**: with `webRoot` unset (the default) the gateway handles only `/healthz` and the `/ws`
  upgrade; every other GET returns 404.
- Relative paths resolve against the **server process cwd**; an absolute path is used as-is.
- Deep links work (SPA fallback serves `index.html` for extension-less routes); `..`, embedded NULs and
  decode failures are rejected with `403` before touching the filesystem; `index.html` is `no-cache`,
  every hashed asset is `immutable`.

---

## Deploy on a single device over Greengrass IPC

For a **single edge device with no site broker and no `uns-bridge`**, deploy the console as a Greengrass
component that connects to the **device-local IPC bus** and serves its UI on a device port. The repo root
carries the Greengrass artifacts: `recipe.yaml`, `gdk-config.json`, and `build.sh`.

The gateway is built with the `greengrass` Cargo feature (Greengrass IPC instead of MQTT). That provider
is a **Linux-only** C-FFI build, so build it on the device or in WSL/Linux:

```bash
# Linux / WSL — build the IPC gateway binary (proves the IPC provider links).
# CFLAGS raises the SDK's concurrent-stream ceiling (see below); build.sh sets this automatically.
CFLAGS="-DGG_IPC_MAX_STREAMS=64" \
  cargo build -p edge-console-gateway --release --no-default-features --features greengrass
```

The console opens more concurrent IPC subscription streams than the `aws-greengrass-component-sdk`
default `GG_IPC_MAX_STREAMS` (16) allows, so the greengrass build raises the ceiling to **64** with
`CFLAGS=-DGG_IPC_MAX_STREAMS=64`. `build.sh` sets this for you; only a manual `cargo build` needs it
exported by hand.

Package and deploy with the Greengrass Development Kit (GDK), which runs `build.sh` to build the UI and
the IPC binary and stage a zip artifact (binary + `ui/` at the archive root):

```bash
gdk component build      # runs build.sh -> greengrass-build/ (Linux/WSL)
gdk component publish     # upload artifact + recipe (set the bucket in gdk-config.json)
# then create a deployment targeting the device, or deploy the local recipe with greengrass-cli
```

- The recipe runs the console with `--platform GREENGRASS -c GG_CONFIG`; there is **no `messaging`
  block** — the runtime connects to the local IPC bus, so no broker is configured or required.
- It serves the bundled UI (`webRoot: "ui"`) on `0.0.0.0:8443` by default. Reach it at
  `http://<device>:8443/` (put TLS in front for browsers — see below).
- The recipe's IPC pubsub `accessControl` grants the console **SubscribeToTopic** on the six UNS classes
  it ingests (`state`/`cfg`/`evt`/`metric`/`data`/`log`, both component- and instance-scope) plus
  request/reply inbox topics, and **PublishToTopic** on every component `cmd` inbox and the console's own
  reserved-class topics. Keep the `component.token` (`edge-console`) in sync with those policy topics.

---

## Deploy on Kubernetes

The console is a standard edgecommons component, so it runs under the library's `KUBERNETES` platform —
config from a mounted **ConfigMap**, identity from the **Downward API**, stdout JSON logging, an HTTP
health probe, `SIGTERM` graceful shutdown, and a pull `/metrics`:

```bash
# build + push the gateway image, then apply your manifests
edge-console-gateway --platform KUBERNETES        # -c defaults to CONFIGMAP on this platform
```

Two console-specific rules:

1. **Reaching the browser is your concern, not the bus's.** Expose the WebSocket port
   (`console.ws.port`) with a **Service + Ingress**. No packaged Helm chart is included — you provide the
   Service/Ingress.
2. **Single replica.** The console holds long-lived WebSocket connections and an in-memory fleet model;
   run **one** replica per site broker (do not horizontally scale it).

Terminate TLS at the Ingress (see the next recipe).

---

## Put HTTPS in front of it

The server speaks **plain HTTP + WebSocket** — there is no built-in TLS listener. To serve browsers over
HTTPS/WSS, terminate TLS in front:

- **HOST / Greengrass** — a reverse proxy (nginx, Caddy) or load balancer terminating TLS and proxying
  `/` and the `/ws` upgrade to the console port.
- **Kubernetes** — an Ingress with a TLS secret, routing to the console Service.

The UI derives its WebSocket URL from the page origin (`wss://…/ws` when the page is `https://`), so once
TLS terminates in front, no UI config change is needed. Override with `VITE_CONSOLE_WS_URL` only for
unusual split-origin setups.

---

## Lock down the command (write) surface with RBAC

Command invocation is gated by a config-driven RBAC policy under `component.global.console.rbac`. Roles
carry `allow`/`deny` verb lists (`"*"` = every verb; `deny` wins over `allow`); an unknown role can do
nothing (fail-closed):

```jsonc
"console": {
  "rbac": {
    "defaultRole": "viewer",
    "roles": {
      "operator": { "allow": ["*"], "deny": ["reboot"] },     // everything except reboot
      "viewer":   { "allow": ["ping", "get-configuration"] }  // read-only verbs
    }
  }
}
```

A denied verb returns a console-synthesized `FORBIDDEN` and **never reaches the bus**.

> **Important — connections are not authenticated.** RBAC *enforcement* is real, but the console does not
> verify who is connecting: every connection is assigned `defaultRole`. So `defaultRole` is the posture
> for **everyone**. The *read* surface (snapshot + live streams) is unauthenticated too. Keep the console
> on a trusted network. See [explanation → security](explanation.md#a-note-on-security).

---

## Tune miss-detection (the staleness ladder)

The console — not the components — decides when a component is late. Tune the ladder under
`component.global.console.staleness`:

| You want… | Set |
|-----------|-----|
| More/less tolerant "warn" shading | `warnMultiplier` (default 2 × the expected interval) |
| When a value is considered STALE | `staleMultiplier` (default 2.5×) |
| When a component is considered OFFLINE | `offlineMultiplier` (default 5×) |
| The cadence assumed before a component's `cfg` arrives | `defaultIntervalSecs` (default 5) |
| How often the ladder is recomputed | `sweepIntervalMs` (default 1000) |

The multipliers must be **strictly increasing** (`warn < stale < offline`) or the whole trio falls back
to defaults with a warning. The expected interval itself is taken from each component's advertised
`cfg.config.heartbeat.intervalSecs` once its `cfg` arrives; until then `defaultIntervalSecs` applies.

---

## Bound the caches (memory guards)

Every store is bounded and drop-oldest, so a noisy fleet can't grow the console without limit:

```jsonc
"console": {
  "cache":   { "maxChannelsPerComponent": 1024 },   // distinct (class, channel) values per component
  "events":  { "maxEvents": 1000, "maxPerComponent": 100 },  // fleet-wide ring + per-component ring
  "metrics": { "maxSeriesPoints": 60, "maxSeries": 2000 },   // points per series; distinct series
  "logs":    { "maxRecords": 5000, "maxPerComponent": 1000,
               "defaultTail": 500, "maxTail": 2000 }         // fleet/per-component log tails
}
```

Overflow is dropped and counted (the Overview surfaces `droppedChannels`), never allowed to evict another
component's history. See [reference — configuration](reference/configuration.md).

---

## Tune gateway process memory/runtime

Declare the desired Rust gateway runtime under `component.global.console.runtime`:

```jsonc
"console": {
  "runtime": { "workerThreads": 4, "mallocArenaMax": 2, "eventBufferCapacity": 512 }
}
```

These knobs are launch-latched. Start the process with matching environment values:

```bash
EDGECONSOLE_WORKER_THREADS=4 MALLOC_ARENA_MAX=2 edge-console-gateway --platform HOST --transport MQTT ./config.json -c FILE ./config.json -t site-console
```

The Settings screen reports configured and effective values so a mismatch is visible after restart.
`eventBufferCapacity` controls the internal live-event broadcast ring retained for WebSocket sessions;
lagged clients resynchronize when they fall behind it.

---

## Use each screen

| To… | Go to |
|-----|-------|
| See fleet health at a glance (liveness, alarms, the console's own bus rate) | **Overview** |
| Browse the site as a tree and drill into one component | **Components** → a leaf |
| See a component's Health / Metrics / Instances / effective Config / Events / Logs | **Components** detail tabs |
| See the connectivity graph (who talks to what) | **Site Topology** |
| Read a component's effective, redacted running config | **Configuration** (pick + Structured/Raw JSON + Refresh) |
| Triage alarms with a real Ack lifecycle | **Events & Alarms** (Ack an active alarm) |
| Browse schema-free component metrics | **Metrics** |
| Browse live telemetry values + trends | **Signals** (grouped by signal path; filter by quality / device / component) |
| See the console's own policy | **Settings** (read-only) |

The **app-bar search** filters the fleet across the Overview, Components tree, and Signals; the **theme
toggle** flips g10 ↔ g100; the **bell badge** tracks the live active-alarm count; the **account
indicator** shows the connection's resolved RBAC role.

---

## Command a component from the UI

Open **Overview** (or **Component Detail**) and expand a component's controls. The three universal
built-in verbs — **ping**, **get-configuration**, **reload-config** — are offered on every component; a
generic *verb + args* form covers anything else the component answers (the console does not discover a
component's custom verbs). The result (or a coded error / timeout / `FORBIDDEN`) surfaces in a
toast. Under the hood the gateway issues one `messaging.request()` to the component's `cmd` inbox and the
`uns-bridge` rewrites `reply_to` so the site→device round-trip is transparent — see
[reference — messaging interface](reference/messaging-interface.md#the-command-write-path).

---

## Trigger a config re-announce (late join)

A component that started **before** the console cannot be asked for its current `cfg`/`state` through
retain (the platform uses no broker retain). On **Configuration**, **Refresh** fires a per-device
`republish-cfg` broadcast on the bus asking every component on that device to re-push. It is
fire-and-forget: a component re-pushes only if its device-side edgecommons runtime handles the `_bcast`
broadcast. The periodic `state` keepalive reconverges liveness within one interval regardless; the `cfg`
of an already-running component may not refresh until that component re-announces.

---

## Observe the console itself

- **Health probe**: `GET /healthz` returns `200 ok` — wire it to your liveness/readiness check.
- **Its own metrics/logs/state**: the console is a edgecommons component, so it emits the standard `state`
  keepalive, `metric` health, and logging like any other — visible in *another* console, or on the bus.
- **In-product**: the Overview "Edge bus msgs/s" tile is the console's own ingest throughput; the "Edge
  node — console self" tile is its own CPU/memory/uptime; **Settings** shows its resolved policy.

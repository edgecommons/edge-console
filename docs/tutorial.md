# Tutorial — From zero to a live console

By the end you will have built the Edge Console, run it against a fleet, opened it in a browser, and
watched components go **FRESH → WARN → STALE → OFFLINE**, reviewed a component's redacted config, and
sent a `ping` command through the bus.

The console is one Rust binary — `edge-console-gateway` — that connects to a **site broker**, subscribes
the six UNS wildcards, and serves the browser UI over HTTP + WebSocket. To follow along you need a broker
with at least one component publishing into it.

---

## What you need

- **Rust + cargo** — builds the gateway binary.
- **Node + npm** — builds the browser UI. Node is a *build* tool here; the running console is the
  compiled binary plus a broker, not a Node process.
- A **site broker** — an MQTT broker that a `uns-bridge` relays each device's traffic into — with at
  least one component publishing. The simplest live rig is an EMQX broker on `:1884` with a `uns-bridge`
  in front of a device bus and one or two scaffolded edgecommons skeletons publishing. Any broker the
  bridge feeds will do.

---

## 1. Build the workspace

The console repo holds the shared TypeScript protocol package, the Carbon/React UI, and the Rust gateway.
From the repo root:

```bash
npm run link:lib     # dev only: satisfy @edgecommons/edgecommons from the sibling ../core/libs/ts
npm run link:rust    # dev only: satisfy the Rust gateway from the sibling ../core/libs/rust
npm install
npm run build        # builds protocol -> ui -> the Rust edge-console-gateway binary
```

`npm run link:lib` generates the gitignored `local/edgecommons` workspace stub; `npm run link:rust`
generates the gitignored Rust crate/proto links. `npm run build` compiles the protocol package, bundles
the UI into `ui/dist`, and cargo-builds the gateway to `target/release/edge-console-gateway`.

---

## 2. Point the console at your broker

`test-configs/config.json` is a complete, runnable console config. Its `messaging.local` block is the
**site broker** — edit `host`/`port` to match yours:

```jsonc
"messaging": { "local": { "host": "localhost", "port": 1884, "clientId": "edge-console" } }
```

---

## 3. Run the gateway

The console is a standard edgecommons component — the same CLI shape as any adapter. Give it a **thing name
of its own** so it does not appear as a device under the fleet it is watching:

```bash
target/release/edge-console-gateway \
  --platform HOST --transport MQTT ./test-configs/config.json \
  -c FILE ./test-configs/config.json \
  -t site-console
```

It logs the six subscribed UNS wildcards, then reports the gateway listening on `0.0.0.0:8443`. (That
config sets `console.ws.bindAddress` to `0.0.0.0`; the default is loopback `127.0.0.1`.)

---

## 4. Open the UI

```bash
npm run dev -w ui                    # http://localhost:5173 (Vite proxies /ws -> the gateway on 8443)
```

Open **`http://localhost:5173`**. The **Overview** screen populates immediately: a fleet-health rollup,
summary tiles, and a table of devices/components. Because the console keeps a timestamped last-known-value
cache, the browser gets every current value the instant it connects — no waiting for the next publish.

Every publishing component appears within one keepalive interval (~5 s). The Overview table groups them by
their identity hierarchy; the keepalive cadence column reads `5s · cfg` once each component's `cfg`
announcement arrives.

> For a single-process deployment with no Vite, set `console.ws.webRoot` to the built `ui/dist` and
> browse straight to the gateway port — see the [how-to guides](how-to-guides.md).

---

## 5. Watch the liveness ladder move

The console — not the components — decides when a component is late:

- **Kill a component** → it climbs **FRESH → WARN → STALE → OFFLINE** within ~25 s (at a 5 s cadence),
  then recovers when it publishes again.
- A component that reports a graceful `{"status":"STOPPED"}` is held **STOPPED** with no staleness decay
  until it reports RUNNING again.
- A component that **restarts** resets its uptime — the restart counter ticks.
- **Kill the `uns-bridge`** → the whole device flips **UNREACHABLE** (the broker publishes the bridge's
  Last Will) and its components are *contained* ("the road is down, not the houses").
- **Restart the bridge** → recovery reconverges within one keepalive interval.

---

## 6. Review a config

Go to **Configuration**, pick a component. You see its effective running config with secrets rendered
**as redaction** (`"***"` masks, `$secret` refs labelled as vault pointers — never real values) and a
live "received *N*s ago" stamp. Click **Refresh** to fire a per-device `republish-cfg` broadcast; a
component whose device-side edgecommons runtime handles the broadcast re-pushes its config and the stamp
resets.

---

## 7. Send a command

Back on **Overview**, expand a component row and use its controls: **Ping**, **Get configuration**,
**Reload config**. Each issues one `messaging.request()` on the bus and surfaces the reply in a toast. A
verb the RBAC policy denies returns **FORBIDDEN** without ever touching the bus; a component that does not
answer in time returns **TIMEOUT**.

---

## 8. Explore the rest

- **Events & Alarms** — the live, newest-first feed; alarms carry an Active/Ack lifecycle (try **Ack**).
- **Metrics** — schema-free component metrics with latest values and trends.
- **Signals** — the data-plane browser, grouped by signal path. Each row is name-led (the canonical
  signal name, with the channel as a mono fallback) and carries the latest value, its data quality (the
  native status code on hover), a trend sparkline, and its receipt freshness over a publish-lag line
  (`publishedTs − sourceTs`, warning-toned above 5 s). Collapsed group headers still surface bad/uncertain
  pills, the group's msg/s, and its freshest update. Filter by quality, device, and component, or search;
  a row expands to its identity, address, timestamps, larger trend, and a link to Component Detail.
- **Components** — select a component and use the embedded Health / Metrics / Configuration / Events /
  Logs tabs. Logs appear when the component publishes `edgecommons.log.v1` records on the UNS `log` class.
- **Site Topology** — a derived connectivity graph.
- **Settings** — the console's own policy (RBAC, staleness ladder, command deadlines), read-only.
- The **app bar**: global search filters the fleet, the theme toggle flips **g10 ↔ g100**, and the bell
  badge tracks the live active-alarm count.

---

## Where next

- The [how-to guides](how-to-guides.md) — deploy self-contained (no Vite/nginx), lock down RBAC, use each
  screen, command a component.
- The [sample configurations](sample-configurations.md) — copy-paste configs for each deployment shape.
- The [reference](reference/) — every config option, every WebSocket frame, every UNS topic.
- The [explanation](explanation.md) — why the console is the sole browser↔bus bridge and how miss-detection
  works.

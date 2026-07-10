# Tutorial — From zero to a live console

By the end you will have the Edge Console running against a fleet, open in a browser, showing components
go **FRESH → WARN → STALE → OFFLINE**, reviewing a component's redacted config, and sending a `ping`
command through the bus. You do **not** need a real factory — a built-in demo gateway stands in for the
whole site so you can see every screen with no broker and no components.

There are two paths. Start with **Path A** (the demo) to learn the UI in two minutes; move to **Path B**
(a real site broker) once you want live data.

---

## Path A — See every screen with the demo gateway (no broker, no components)

The demo gateway runs the legacy TypeScript parity-oracle server classes (fleet model, config/event/metric/signal/attribute
stores, the WebSocket gateway) over a synthetic fleet that exercises the whole liveness ladder, redacted
`cfg` announcements, a live event stream, moving metric series, and a fake command responder. Only the
MQTT edge is bypassed.

### 1. Prerequisites

- Node 20+ (Node 22+ for the WebSocket round-trip tests), npm, and Rust.
- The sibling `edgecommons` TypeScript library built at `../core/libs/ts` (the console depends on
  `@edgecommons/edgecommons`). From the console repo root:

```bash
npm run link:lib     # generates the gitignored local/edgecommons workspace stub -> ../core/libs/ts
npm run link:rust    # generates the gitignored Rust crate/proto links -> ../core/libs/rust
npm install
npm run build        # builds protocol -> ui -> Rust edge-console-gateway
```

### 2. Start the demo gateway

```bash
node scripts/demo-gateway.mjs        # ws://127.0.0.1:8443/ws  (set DEMO_PORT to change)
```

### 3. Start the UI

```bash
npm run dev -w ui                    # http://localhost:5173  (Vite proxies /ws -> 8443)
```

Open **`http://localhost:5173`**. You should see the **Overview** screen populate immediately: a
fleet-health rollup, summary tiles, and a table of devices/components. Because the fleet model is a
timestamped last-known-value cache, the browser gets every current value the instant it connects — no
waiting for the next publish.

### 4. Watch the liveness ladder move

Leave the tab open for ~30 seconds. The synthetic fleet includes:

- a **flapping** component that goes silent periodically — watch it climb **FRESH → WARN → STALE →
  OFFLINE** and then recover;
- a **gracefully STOPPED** component (held STOPPED, no staleness decay);
- a component that **restarts** (its uptime resets — the restart counter ticks);
- a device whose **bridge "dies"** — the whole device flips to **UNREACHABLE** and its components are
  *contained* ("the road is down, not the houses"), then recovers.

### 5. Review a config (priority #2)

Go to **Configuration**, pick a component. You see its effective running config with secrets rendered
**as redaction** (`"***"` masks, `$secret` refs labelled as vault pointers — never real values) and a
live "received *N*s ago" stamp. Click **Refresh** — the demo's simulated device-side listener re-pushes
the config and the stamp resets.

### 6. Send a command (priority: the write path)

Back on **Overview**, expand a component row and use its controls: **Ping**, **Get configuration**,
**Reload config**. Each replies in ~50 ms. Try the deny path too — the demo's RBAC policy blocks the
verb `reboot`, so invoking it returns **FORBIDDEN** without ever touching the bus; one deliberately-slow
component returns **TIMEOUT**.

### 7. Explore the rest

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

That is the whole console. Everything you just saw runs the real code path from the fleet model through
the WebSocket wire to the browser — only the broker was simulated.

---

## Path B — Run against a real site broker

Now point the real gateway at a live UNS. You need a **site broker** (an MQTT broker that a `uns-bridge`
relays each device's traffic into) with at least one component publishing.

### 1. A broker + a component

The simplest live rig is an EMQX broker on `:1884` with a `uns-bridge` in front of a device bus, and one
or two scaffolded edgecommons skeletons publishing. Any broker the bridge feeds will do.

### 2. Point the console at it

`test-configs/config.json` is a complete, runnable console config. Its `messaging.local` block is the
**site broker** — edit `host`/`port` to match yours:

```jsonc
"messaging": { "local": { "host": "localhost", "port": 1884, "clientId": "edge-console" } }
```

### 3. Run the gateway

The console is a standard edgecommons component — the same CLI shape as any adapter. Give it a **thing name
of its own** so it does not appear as a device under the fleet it is watching:

```bash
target/release/edge-console-gateway \
  --platform HOST --transport MQTT ./test-configs/config.json \
  -c FILE ./test-configs/config.json \
  -t site-console
```

You should see it log the six subscribed wildcards, then the Rust gateway listening on `0.0.0.0:8443`.

### 4. Open the UI

```bash
npm run dev -w ui                    # http://localhost:5173 (proxies /ws -> the gateway on 8443)
```

Every publishing component appears within one keepalive interval (~5 s). The Overview table groups them
by their identity hierarchy; the keepalive cadence column reads `5s · cfg` once each component's `cfg`
announcement arrives.

### 5. Prove the failure modes end-to-end

- **Kill a component** → it climbs WARN → STALE → OFFLINE within ~25 s (at a 5 s cadence).
- **Kill the `uns-bridge`** → the whole device flips **UNREACHABLE** (the broker publishes the bridge's
  Last Will); its components are contained.
- **Restart the bridge** → recovery reconverges within one keepalive interval.

---

## Where next

- The [how-to guides](how-to-guides.md) — deploy self-contained (no Vite/nginx), lock down RBAC, use each
  screen, command a component.
- The [sample configurations](sample-configurations.md) — copy-paste configs for each deployment shape.
- The [reference](reference/) — every config option, every WebSocket frame, every UNS topic.
- The [explanation](explanation.md) — why the console is the sole browser↔bus bridge and how miss-detection
  works.

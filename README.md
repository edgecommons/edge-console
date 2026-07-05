# edge-console

The **EdgeCommons Edge Console**: an edge-deployed, real-time web UI to **monitor and
command** every [ggcommons](https://github.com/edgecommons/ggcommons) component on a site —
and the site's **sole browser↔bus bridge** (browsers speak HTTPS+WS to the console; only the
console speaks MQTT/UNS). It attaches to the **site broker** (the aggregation point every
device's [`uns-bridge`](https://github.com/edgecommons/uns-bridge) relays into), consumes the
Unified Namespace (`ecv1/{device}/{component}/{instance}/{class}[/channel]`), and needs **zero
per-component knowledge**: six class wildcards cover the whole fleet.

Priority #1 is **edge health** (fleet liveness, per-value freshness, whole-device
reachability); priority #2 is **config review** (every component's effective, redacted config
from its `cfg` announcements). Design source of truth: `docs/DESIGN.md` (v0.3) reconciled
against the shipped UNS core in `docs/UNS-RECONCILIATION-AND-PHASE1-PLAN.md`.

**Status: slices C0 (scaffold) + C1 (BusIngress + FleetModel) + C2 (WS gateway) + C3
(the edge-health UI — priority #1 closed, zero new ggcommons code) + C4 (CommandGateway —
RBAC-gated `invoke-command` → request/reply) + C5 (config-review — priority #2 closed) +
C6 (events & metrics screens) + C7 (the full-system UNS e2e — run and passed, HOST → kind).**
The RBAC command core is built and enforced; the remaining Phase-1 auth work — the
identity-provider wiring at the WS connect edge, plus the C4 append-before-dispatch audit
log — is deferred by decision (see "The WS gateway").

## Workspace layout

| Package | What it is |
|---|---|
| `server/` | The Node backend — a standard **ggcommons TypeScript component** (`com.edgecommons.edge-console`): the library owns config/messaging/logging/metrics/heartbeat/shutdown; the console adds BusIngress + FleetModel (this slice), then the WS gateway + CommandGateway. |
| `ui/` | The IBM **Carbon/React** front end (Vite, `g100` dark per the signed-off hi-fi). Ships the **edge-health view** (C3): a WS client + client-side fleet store mirroring the FleetModel, and the Overview screen (health tiles → issue notes → fleet table grouped by device). |
| `protocol/` | Shared TypeScript types: the WS API contract (snapshots, deltas, liveness) + UNS envelope shapes. A hard contract between `server/` and `ui/`. |
| `test-configs/` | A runnable sample config (the console's own knobs live under `component.global.console`). |
| `docs/` | DESIGN.md v0.3, the UNS reconciliation + Phase-1 plan, and the lo-fi/hi-fi mockups. |

## How the console consumes the UNS (slice C1)

**One connection** — the site broker (`messaging.local` in the config; on a single-device
deployment, the device's local bus; on Kubernetes, the in-cluster broker). Through it,
**BusIngress** subscribes the six consumer-class wildcards, built via the library
(`gg.uns().filter(cls, UnsScope.all())`, never by hand):

```text
ecv1/+/+/+/state    ecv1/+/+/+/cfg      ecv1/+/+/+/evt/#
ecv1/+/+/+/metric/# ecv1/+/+/+/data/#   ecv1/+/+/+/log/#
```

Identity always comes from the envelope's top-level `identity` element — with **one
documented exception**: the bridge's Last Will is a bare raw JSON `{"status":"UNREACHABLE"}`
on `ecv1/{device}/uns-bridge/{instance}/state` (broker-published, no envelope). For exactly
that shape the topic is parsed for `{device}` and the whole device is marked UNREACHABLE,
event-time = delivery time. Everything else raw is dropped; `tags._relay` (the bridge hop
tag) is cached but never used for business logic.

The **FleetModel** (pure, injected clock) is the platform's **retain substitute**: a
timestamped last-known-value cache keyed by `(device, component, instance, class[, channel])`
— a late-joining browser gets every current value immediately *and* its age. On top of it,
**console-side miss-detection** (the platform's first — no component reports "I am late"):

- **Cadence** is derived from each component's `cfg` announcement
  (`config.heartbeat.intervalSecs`), defaulting to 5 s until it arrives.
- The ladder: **FRESH → WARN (>2×) → STALE (>2.5×) → OFFLINE (>5×)**, tunable, driven by a
  1 s sweeper over the last `state` keepalive receipt.
- **Restart vs gap**: an `uptimeSecs` decrease means restart.
- Graceful `{"status":"STOPPED"}` holds **STOPPED** (no staleness decay) until the next
  RUNNING state.
- **Whole-device UNREACHABLE** (bridge LWT): the device subtree freezes, components report
  UNREACHABLE by containment, terminal until the next `state` envelope from that device.

The model exposes a **snapshot API** (`FleetSnapshot`, deterministic order) plus a **delta
event stream** (`FleetDelta`, monotonic `seq`) — the exact snapshot-then-deltas seam the C2
WS gateway fans out.

**Late-join rehydration**: on first sight of a device the console publishes the per-device
broadcast pair `ecv1/{device}/_bcast/main/cmd/republish-state` + `…/republish-cfg`
(fire-and-forget `cmd` notifications). Components answer once the ggcommons `_bcast` listener
slice (G-S1) lands; until then the periodic `state` keepalive converges liveness within one
interval, and `cfg` of long-running components is the known gap.

## The WS gateway (slice C2)

An HTTP + WebSocket server (`ws` + `node:http`/`node:fs` — no framework: this slice serves
`/ws`, a trivial `/healthz` probe, and — opt-in — the console's own built UI as static files
on that SAME origin) fans the FleetModel's snapshot + delta stream out to browsers,
**snapshot-then-deltas**:

- On connect, a client's first frame must be `{"type":"hello","protocolVersion":1}`
  (optionally `resumeSeq`). The gateway replies with one `snapshot` (the current
  `FleetSnapshot`, carrying its last-folded `seq`), then streams every subsequent `delta`
  batch (`FleetDelta[]`, strictly increasing `seq`).
- **Resume**: a reconnecting client sends `resumeSeq` = the last `seq` it applied. If a
  bounded recent-delta ring (default 1000) can prove contiguous coverage from there, the
  gateway sends only the missed `delta` batch — no snapshot. On any gap (evicted range, or
  `resumeSeq` ahead of the server) it falls back to a fresh `snapshot` — correctness over
  cleverness.
- **Fanout + backpressure**: every connected client is served independently; a client whose
  transport stays backpressured (`bufferedAmount` over a threshold) across several
  consecutive delta pushes is dropped-and-resnapshotted rather than queued — it never stalls
  delivery to any other client.
- A periodic `heartbeat` frame doubles as the tick that evicts a connected socket that never
  sends `hello`.
- The fanout/resume/backpressure core (`server/src/ws/gateway.ts`) is pure and injects the
  client transport — the real `ws` sockets are a thin IO edge (`server/src/ws/ws-server.ts`),
  mirroring the BusIngress/FleetModel split.
- **RBAC integrated; IdP/auth-seam wiring deferred.** The C4 command write path is
  RBAC-gated: a config-driven `console.rbac` policy (allow/deny per verb, per role) is
  **enforced** in the CommandGateway (`server/src/command/`), and `resolveRole` at the WS
  upgrade edge assigns each connection a role. What remains — **deferred by decision** — is
  real identity: wiring an identity provider (bearer/mTLS/OIDC) into that seam so `resolveRole`
  maps a *verified* principal instead of the configured permissive default. Until then every
  connection is the default role, and the read path (fleet snapshot + live stream) is
  unauthenticated — so keep the bound port on a trusted network / terminate auth in front.

### Serving the console's own UI (`console.ws.webRoot`)

Set `component.global.console.ws.webRoot` to a filesystem path (the built `ui/dist`,
relative paths resolve against the process cwd) and the console becomes a genuinely
**self-contained** deployment: it serves its own UI as static files on the SAME
port/origin as the WS gateway — no separate nginx front or Vite process needed for a
built deployment.

- **Opt-in, backward-compatible**: `webRoot` unset (the default) is byte-for-byte the
  pre-existing behavior — only `/healthz` + the `/ws` upgrade are handled; every other
  GET (including `/`) 404s.
- **Routing precedence**: `/healthz` first, then (only when `webRoot` is set) static
  file serving for every other `GET`; the `/ws` upgrade never competes with either —
  Node's `http` module hands an `Upgrade: websocket` request straight to the `upgrade`
  event (owned by `ws`), never to the plain `request` handler these routes live in.
- **SPA fallback**: a request whose path has no file extension (an app route, not an
  asset like `/assets/app-<hash>.js`) and doesn't resolve to a real file serves the root
  `index.html` instead, so deep-linking into the UI's client-side router works. A
  missing path that DOES look like an asset (has an extension) still 404s for real.
- **Traversal guard**: the request path is decoded into a whitelist of plain path
  segments — any `..` (or a decode failure / embedded NUL) is rejected with `403`
  before touching the filesystem; nothing outside `webRoot` can ever be served.
- **Caching**: `index.html` is `no-cache` (a redeploy must be picked up immediately);
  every other file gets a long `immutable` lifetime (Vite content-hashes every
  non-`index.html` asset, so a changed file is always a new URL).
- The read-only Settings screen (R6) reflects it — a "Serves UI: yes/no" row under
  **Connection**, sourced from the same `console.ws.webRoot` knob.
- **Dev-mode Vite is unaffected**: `npm run dev -w ui` still proxies `/ws` to the
  server for hot-reload; `webRoot` only matters for a *built* deployment
  (`npm run build` then point `webRoot` at `ui/dist`).
- **TLS/HTTPS is a separate, still-open concern** — the server is plain `http` today
  regardless of `webRoot`; terminate TLS in front of it (reverse proxy/load balancer)
  until the gateway grows its own HTTPS listener.

## The edge-health UI (slice C3)

The browser side of priority #1 — a Carbon (`g100`) React view fed 100 % live from the
C2 gateway (no mock data outside tests), faithful to `docs/mockups-hifi.html`:

- **WS client** (`ui/src/fleet/client.ts`): dials the gateway, sends the
  version-stamped `hello`, and dispatches `snapshot`/`delta`/`heartbeat`/`error`
  frames. Reconnects with exponential backoff (1 s → 30 s), always offering
  `resumeSeq` so the gateway resumes with only the missed deltas or re-snapshots. A
  detected seq **gap** forces an immediate resync (redial); a silent connection
  (no frame for 45 s = 3× the gateway heartbeat) is treated as dead; an
  `unsupported-protocol-version` error is **fatal** (stale tab — reload), never a
  retry loop. The socket is injected, so all of this is unit-tested with fakes.
- **Client fleet store** (`ui/src/fleet/store.ts`): the pure browser mirror of the
  server FleetModel — applies the snapshot, folds deltas strictly in `seq` order,
  computes the device-UNREACHABLE overlay exactly like the server, and heals the
  snapshot-under-outage corner (ladders hidden by the overlay) with the server's own
  recompute rule. Liveness itself is **server-computed**; the browser only applies
  transitions. Clock skew is handled with a per-frame `clientReceipt − serverAt`
  offset so ages stay honest. (Note: `value-updated` deltas carry no body — cached
  value *bodies* refresh via snapshots only; edge-health needs none of them live.)
- **The view** (`ui/src/health/`): summary-before-detail — fleet-health donut +
  counts-by-status, needs-attention/devices/live-stream tiles, inline issue notes
  (OFFLINE = error, STALE = warning, one containment note per UNREACHABLE device),
  then the fleet table grouped by device (collapsible group rows with worst-of
  rollups; per-component status tag, live last-state age, uptime — extrapolated only
  while provably alive — keepalive cadence + source, restarts). Liveness → Carbon:
  FRESH/OFFLINE/STOPPED use stock green/red/gray `Tag`s; WARN/STALE are built from
  the `$support-warning` token (Carbon ships no yellow tag); UNREACHABLE is the
  mockup's dashed-outline gray. Empty-fleet, connecting, reconnecting
  (last-known data stays visible under a banner) and fatal states are all explicit.

**WS URL resolution** (`ui/src/config.ts`): `VITE_CONSOLE_WS_URL` env override, else
derived from the page origin — `ws(s)://{host}/ws`. In dev, `vite.config.ts` proxies
`/ws` to `127.0.0.1:8443` (the server's `console.ws.port` default), so the
origin-derived URL works in both dev and production shapes.

## Config review, events & metrics (slices C5 + C6)

The liveness stream deliberately carries **no message bodies** (a `value-updated`
delta is a change notification). Bodies travel over dedicated, versioned message
families on the **same single WS connection**, each backed by a pure side store fed
by the one BusIngress tee (`console-app.ts`: FleetModel + ConfigStore + EventStore +
MetricStore):

- **Config review (C5, protocol v2)** — request/response + interest: `get-config{key}`
  is answered from the retained-`cfg` cache (`server/src/fleet/config-store.ts`,
  latest-wins, body VERBATIM — redaction already ran at the publisher: `"***"` masks,
  `$secret` refs are vault pointers) and registers per-connection interest, so every
  later `cfg` arrival for that key is pushed unprompted. `refresh-config{device}`
  fires the per-device `_bcast` `republish-cfg` broadcast (fire-and-forget; absence
  is silent until the device-side ggcommons S1 listener lands). The view
  (`ui/src/configreview/`) is the hi-fi's 340 px picker + Structured/Raw-JSON detail,
  with redaction rendered *as* redaction — closes priority #2.
- **Events (C6, protocol v3)** — subscribe/stream (events are notifications, not
  state): `subscribe-events[{limit}]` answers ONE newest-first `events` backlog from
  the rolling history (`server/src/fleet/event-store.ts`: bounded fleet-wide ring,
  default 1000, plus independent per-component rings, default 100 — drop-oldest, so
  a noisy component can't evict the others' history), then streams every arrival as
  an `event` frame until `unsubscribe-events`/disconnect. The `evt/{severity}/{type}`
  channel convention is split leniently (`splitEventChannel` — the class is open;
  unknown severities render neutrally). The **Events view** (`ui/src/events/`)
  follows the mockup's "Events & alerts" screen scoped to what exists: three header
  tiles (recent count + severity legend, events/min sparkline, noisiest source),
  component + severity filters, and the live-appending newest-first log with
  per-row expandable detail (channel, publisher timestamp, tags, pretty body).
  Alarm ack/state columns wait for the deferred `events()` facade — no dead UI.
- **Metrics (C6, protocol v3)** — snapshot + live samples: `subscribe-metrics`
  answers ONE `metrics` snapshot (every known series: latest value + a bounded
  recent series per `(component, metric, measure)` — `server/src/fleet/
  metric-store.ts`, default 60 points/series, 2000 series, drop-oldest/counted),
  then pushes `metric` update batches. Bodies fold leniently: the library's EMF
  shape (top-level numeric measures; `_aws` skipped) and bare numbers (`"value"`)
  alike. The **Metrics view** (`ui/src/metrics/`) is a scannable table — one row
  per measure with the formatted latest value and a hand-rolled inline-SVG
  **sparkline** (time-scaled, subtle area fill, emphasized endpoint dot, native
  hover summary; single hue = the g100 `support-info` blue, validated against the
  dark surface — no chart dependency).

Interest of all three families is **per-connection**: the owning view re-requests /
re-subscribes when the connection comes (back) up (the effect keys on the status),
and the fresh backlog/snapshot self-heals the client store — no client-side
resubscribe machinery. Client folds mirror the server bounds
(`ui/src/fleet/event-log-store.ts`, `ui/src/fleet/metric-series-store.ts`), and the
version handshake turns any protocol skew into a clean "reload the page".

## Configuration

The console is configured like any ggcommons component; its own knobs live in the permissive
`component.global.console` subtree (no canonical-schema change — the bridge precedent):

```jsonc
"component": {
  "global": {
    "console": {
      "ws":        { "port": 8443, "bindAddress": "0.0.0.0",
                     "heartbeatIntervalMs": 15000 },                  // C2 gateway endpoint
      "staleness": { "warnMultiplier": 2, "staleMultiplier": 2.5,
                     "offlineMultiplier": 5, "defaultIntervalSecs": 5,
                     "sweepIntervalMs": 1000 },
      "cache":     { "maxChannelsPerComponent": 1024 },
      "events":    { "maxEvents": 1000, "maxPerComponent": 100 },   // C6 rolling evt history
      "metrics":   { "maxSeriesPoints": 60, "maxSeries": 2000 }     // C6 metric series bounds
    }
  }
}
```

All fields are optional (lenient parsing with the defaults shown). See
`test-configs/config.json` for a complete runnable document — its `messaging.local` points at
the **site broker**, and the same file doubles as the `--transport MQTT` payload.

## Build, test, run

```bash
# Local dev: satisfy @edgecommons/ggcommons from the sibling checkout (../ggcommons/libs/ts).
# This generates the GITIGNORED local/ggcommons workspace stub - the npm analog of the
# bridge's .cargo/config.toml paths override. CI skips this and resolves the published
# package from GitHub Packages instead. (Requires the sibling lib to be built.)
npm run link:lib

npm install
npm run build        # protocol -> server -> ui
npm test             # server + ui unit suites (fake bus/socket + injected clock - no live IO)
npm run coverage     # vitest v8 coverage for both, thresholds 90/90/85/80 (ecosystem gate)
npm run lint         # eslint (flat config) over the whole workspace

# Run the server against the dev rig's site broker (uns-bridge dual-EMQX compose, port 1884):
node server/dist/main.js \
  --platform HOST --transport MQTT ./test-configs/config.json \
  -c FILE ./test-configs/config.json \
  -t gw-01

# SEE every view without a broker or components: a demo gateway that runs the REAL
# server classes (FleetModel + ConfigStore + EventStore + MetricStore + FleetWsGateway
# + WsServer) over a synthetic fleet exercising the whole liveness ladder (flapping ->
# WARN/STALE/OFFLINE, a graceful STOPPED, restarts, a device whose bridge dies ->
# UNREACHABLE), redacted cfg announcements + a working Refresh, a varied evt stream
# (components x severities) and moving metric series (sys cpu/memory + a bridge
# drop counter) so the sparklines visibly move:
node scripts/demo-gateway.mjs      # ws://127.0.0.1:8443/ws (DEMO_PORT to change)
npm run dev -w ui                  # http://localhost:5173 (vite proxies /ws to 8443)
                                   # NOTE: after a protocol/ change, restart vite with
                                   # --force (its dep-cache prebundles the old package)
```

Note: `package-lock.json` is deliberately untracked while the sibling link is the dev path
(it would record the local stub, which does not exist in CI); it becomes tracked when the
console pins a published `@edgecommons/ggcommons` release.

## Roadmap (Phase 1, per the reconciliation plan §4)

| Slice | Contents |
|---|---|
| ~~C0~~ | ~~repo scaffold~~ |
| ~~C1~~ | ~~BusIngress + FleetModel core~~ |
| ~~C2~~ | ~~HTTP+WS gateway: snapshot-then-deltas, resume-from-seq, per-client backpressure isolation~~ |
| ~~C3~~ | ~~Edge-health UI (Carbon): the Overview screen — fleet health rollups, liveness/reachability live from the gateway (this slice; **closes priority #1**). Components tree + Component detail ride the C5/C6 screens.~~ |
| ~~C4~~ | ~~CommandGateway: RBAC (config-driven allow/deny per verb) → `uns().topicFor()` + `request()` (timeouts ≤ 30 s), RBAC-gated at the WS gateway~~ — **built**; the append-before-dispatch **audit log** and real IdP auth-seam wiring are still to come (deferred) |
| ~~C5~~ | ~~Config-review UI (needs ggcommons G-S1 for already-running components — now shipped) — **closes priority #2**~~ |
| ~~C6~~ | ~~Events & metrics screens: the `evt` rolling log (subscribe/stream) + generic metric latest-value/sparkline table~~ |
| ~~C7~~ | ~~Full-system test~~ — **run and passed (HOST → kind)**; the GREENGRASS leg of the deployment-validation gate rides the uns-bridge's IPC-primary variant |

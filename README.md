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
(the edge-health UI — priority #1 closed, zero new ggcommons code).** CommandGateway
(C4), config-review (C5) and events/metrics screens (C6) follow per the Phase-1 plan.

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

An HTTP + WebSocket server (`ws` + `node:http` — no framework: this slice serves exactly
`/ws` plus a trivial `/healthz` probe) fans the FleetModel's snapshot + delta stream out to
browsers, **snapshot-then-deltas**:

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
- **No auth in this slice** (the seam is marked with a `TODO` in `main.ts`/`ws-server.ts`):
  the WS gateway is the sole browser↔bus bridge and today serves the full fleet snapshot +
  live stream to anyone who can reach the bound port. Add a credential check at the WS
  upgrade before exposing this beyond a trusted network.

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
      "cache":     { "maxChannelsPerComponent": 1024 }
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

# SEE the edge-health view without a broker or components: a demo gateway that runs
# the REAL server classes (FleetModel + FleetWsGateway + WsServer) over a synthetic
# fleet exercising the whole liveness ladder (flapping -> WARN/STALE/OFFLINE, a
# graceful STOPPED, restarts, and a device whose bridge dies -> UNREACHABLE):
node scripts/demo-gateway.mjs      # ws://127.0.0.1:8443/ws (DEMO_PORT to change)
npm run dev -w ui                  # http://localhost:5173 (vite proxies /ws to 8443)
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
| C4 | CommandGateway: RBAC → audit → `uns().topicFor()` + `request()` (timeouts ≤ 30 s) |
| C5 | Config-review UI (needs ggcommons G-S1 for already-running components) — **closes priority #2** |
| C6 | Events & metrics screens |
| C7 | Full-system test + deployment-validation gate (HOST → kind; GG when the bridge's IPC variant lands) |

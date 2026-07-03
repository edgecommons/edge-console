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

**Status: slices C0 (scaffold) + C1 (BusIngress + FleetModel) + C2 (WS gateway) — the
backend core, ready for a UI to attach.** Carbon UI views (C3), CommandGateway (C4),
config-review (C5) and events/metrics screens (C6) follow per the Phase-1 plan.

## Workspace layout

| Package | What it is |
|---|---|
| `server/` | The Node backend — a standard **ggcommons TypeScript component** (`com.edgecommons.edge-console`): the library owns config/messaging/logging/metrics/heartbeat/shutdown; the console adds BusIngress + FleetModel (this slice), then the WS gateway + CommandGateway. |
| `ui/` | The IBM **Carbon/React** front end (Vite). Scaffold only in this slice — no views yet. |
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
npm test             # server unit suite (fake bus + injected clock - no live broker)
npm run coverage     # vitest v8 coverage, thresholds 90/90/85/80 (ecosystem gate)
npm run lint         # eslint (flat config) over the whole workspace

# Run the server against the dev rig's site broker (uns-bridge dual-EMQX compose, port 1884):
node server/dist/main.js \
  --platform HOST --transport MQTT ./test-configs/config.json \
  -c FILE ./test-configs/config.json \
  -t gw-01
```

Note: `package-lock.json` is deliberately untracked while the sibling link is the dev path
(it would record the local stub, which does not exist in CI); it becomes tracked when the
console pins a published `@edgecommons/ggcommons` release.

## Roadmap (Phase 1, per the reconciliation plan §4)

| Slice | Contents |
|---|---|
| ~~C0~~ | ~~repo scaffold~~ |
| ~~C1~~ | ~~BusIngress + FleetModel core~~ |
| ~~C2~~ | ~~HTTP+WS gateway: snapshot-then-deltas, resume-from-seq, per-client backpressure isolation (this slice)~~ |
| C3 | Edge-health UI (Carbon): Overview rollups, Components tree, Component detail — **closes priority #1** |
| C4 | CommandGateway: RBAC → audit → `uns().topicFor()` + `request()` (timeouts ≤ 30 s) |
| C5 | Config-review UI (needs ggcommons G-S1 for already-running components) — **closes priority #2** |
| C6 | Events & metrics screens |
| C7 | Full-system test + deployment-validation gate (HOST → kind; GG when the bridge's IPC variant lands) |

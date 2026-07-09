# Reference — WebSocket protocol & data types

A console has no southbound register map, so this page is the **browser↔console WebSocket protocol** — the
hard contract between the server and the UI. Every type here is defined in the shared package
**`@edgecommons/edge-console-protocol`** and used verbatim on both sides (no re-mapping layer). For the
console↔bus UNS side, see [messaging-interface.md](messaging-interface.md).

## Endpoint & framing

- One WebSocket per browser app, at **`/ws`** on the gateway origin (`ws://` or, behind a TLS terminator,
  `wss://`). The UI derives the URL from the page origin, overridable with `VITE_CONSOLE_WS_URL`.
- Every frame in **both** directions is a JSON object carrying a `protocolVersion` integer.
- **`PROTOCOL_VERSION = 7`**. The gateway validates every inbound frame through one pure
  `parseClientMessage()` — nothing lenient is accepted (unlike the config parsers). A version skew is a
  clean rejection, not a misparse.

## The handshake

1. Client's **first frame must be `hello`** (`{ type, protocolVersion, resumeSeq? }`).
2. Server replies `welcome` (the connection's resolved RBAC role), then — if available — `settings` (the
   console's own policy), then a `snapshot` (or, on a valid resume, only the missed `delta` batch).
3. Server then streams `delta` batches and, for any families the client subscribed, their frames, plus a
   periodic `heartbeat`.

An **unsupported `protocolVersion`** yields an `error` with code `unsupported-protocol-version` (the tab
should reload — never a retry loop); a malformed frame yields `error` code `malformed`; either closes the
connection.

## Client → server frames

| `type` | Fields | Purpose |
|--------|--------|---------|
| `hello` | `protocolVersion`, `resumeSeq?` | Mandatory first frame. `resumeSeq` = last applied delta `seq` (resume attempt). |
| `get-config` | `key` | Request a component's latest retained `cfg`; also registers interest (later `cfg` pushed). |
| `refresh-config` | `device` | Fire the per-device `republish-cfg` broadcast. Fire-and-forget. |
| `subscribe-events` | `limit?` | Ask for the rolling `evt` backlog (newest-first, optionally capped) then live `event` pushes. |
| `unsubscribe-events` | — | Stop `event` pushes. Idempotent. |
| `subscribe-metrics` / `unsubscribe-metrics` | — | Metric snapshot then `metric` pushes / stop. |
| `subscribe-logs` | `key`, `limit?`, `levels?`, `sinceId?` | Ask for one component's retained log tail (newest-first), optionally capped/filtered, then live `log` pushes. |
| `unsubscribe-logs` | `key` | Stop log pushes for that component. Idempotent. |
| `subscribe-signals` / `unsubscribe-signals` | — | Data-plane signal snapshot then `signal` pushes / stop. |
| `subscribe-attributes` / `unsubscribe-attributes` | — | Runtime-attribute snapshot then `attribute` pushes / stop. |
| `subscribe-alarms` / `unsubscribe-alarms` | — | Alarm snapshot then live `alarms` replace-frames / stop. |
| `ack-alarm` | `alarmId` | Toggle console-side acknowledgement of an alarm. |
| `invoke-command` | `requestId`, `key`, `verb`, `args?` | Invoke a UNS command verb on a component (the write path). |

Interest for every family is **per-connection** — a view re-subscribes after a reconnect; the fresh
snapshot/backlog self-heals the client store (no client-side resubscribe bookkeeping).

## Server → client frames

| `type` | Payload | When |
|--------|---------|------|
| `welcome` | `role` | Right after a valid `hello`. |
| `settings` | `settings: ConsoleSettings` | After `welcome` (server-initiated). |
| `snapshot` | `snapshot: FleetSnapshot` | On connect without a resumable `resumeSeq`, or as the resume fallback. |
| `delta` | `deltas: FleetDelta[]` | Change batches, strictly increasing `seq`. |
| `heartbeat` | `at`, `busMsgsPerSec?`, `busRecentRates?`, `self?` | Periodic keep-alive + the console's own bus rate/sparkline/self vitals. |
| `config` / `config-unavailable` | `key`, `cfg`, `receivedAt`, `sourceTimestamp?` | Reply to `get-config` + later pushes / no cfg held. |
| `events` / `event` | `events: ConsoleEvent[]` / `event: ConsoleEvent` | Backlog (newest-first) / one live arrival. |
| `metrics` / `metric` | `series: MetricSeriesSnapshot[]` / `updates: MetricSeriesUpdate[]` | Snapshot / live sample batches. |
| `logs` / `log` / `logs-unavailable` | `key`, `records`, `dropped?` / `key`, `records`, `dropped?` / `key`, `code`, `reason` | Component log tail snapshot / live record batch / unavailable notice. |
| `signals` / `signal` | `series: SignalSeriesSnapshot[]` / `updates: SignalSeriesUpdate[]` | Data-plane snapshot / live samples. |
| `attributes` / `attribute` | `components: RuntimeAttributes[]` / `updates: RuntimeAttributes[]` | Runtime-attribute snapshot / live updates. |
| `alarms` | `snapshot: AlarmSnapshot` | The reply to `subscribe-alarms` **and** every later change (one replace-frame). |
| `command-result` | `requestId`, `key`, `verb`, `ok`, `result?`, `error?`, `elapsedMs` | The single answer to an `invoke-command`. Never closes the connection. |
| `error` | `code: WsErrorCode`, `message` | A rejected frame; the connection closes after. |

## Resume, backpressure, versioning

- **Resume**: offer `resumeSeq`. If a bounded recent-delta ring (default 1000) proves contiguous coverage,
  you get only the missed `delta` batch; otherwise a fresh `snapshot`. A `resumeSeq` ahead of the server,
  or an evicted range, always re-snapshots.
- **Backpressure**: a client whose transport stays backpressured across several delta pushes is
  dropped-and-resnapshotted, never queued — it cannot stall other clients.
- **Value bodies do not ride deltas.** A `value-updated` delta is a change *notification*; cached value
bodies refresh via snapshots and the dedicated body families (`config`/`events`/`metrics`/`signals`).

## Core identity & liveness types

### `ComponentKey`

```ts
interface ComponentKey { device: string; component: string; }
```

A component is one entity per `(device, component)` — the UNS instance token is **not** part of its
identity. Its canonical string form is `componentKeyId(key)` = `"${device}/${component}"`.

### `Liveness` (the console-computed state)

`"FRESH" | "WARN" | "STALE" | "OFFLINE" | "STOPPED" | "UNREACHABLE"` — see
[explanation → miss-detection](../explanation.md#console-side-miss-detection) for the
transition rules. `CadenceSource` = `"default" | "cfg"` records where the expected interval came from.

### `CachedValue` (one last-known value)

| Field | Type | Notes |
|-------|------|-------|
| `instance` | string | Source instance (`main` for `state`/`cfg`; a connection id for per-instance `data`/`evt`). |
| `cls` | `ConsumerClass` | `state`\|`cfg`\|`evt`\|`metric`\|`data`\|`log`. |
| `channel` | string? | `/`-joined channel tokens; absent for the leaf classes (`state`, `cfg`). |
| `body` | unknown | The envelope body (already lib-redacted for `cfg`). |
| `tags` | object? | Envelope tags, verbatim. `_`-prefixed keys are system-reserved (never business context). |
| `receivedAt` | number | Console receipt time (ms epoch) — the authoritative LKV timestamp. |
| `sourceTimestamp` | string? | The publisher's `header.timestamp` claim (display only — never drives staleness). |

### `InstanceStatus` (per-connection reachability)

```ts
interface InstanceStatus { instance: string; connected: boolean; detail?: string; }
```

A multi-connection component (OPC UA servers, Modbus slaves, file-replicator source dirs) reports each
configured instance's reachability in its `state.instances[]`, rather than minting a UNS instance per
connection.

## Snapshot shapes

```ts
interface FleetSnapshot { seq: number; takenAt: number; devices: DeviceSnapshot[]; }
interface DeviceSnapshot { device: string; unreachable: boolean; unreachableSince?: number; components: ComponentSnapshot[]; }
```

`ComponentSnapshot` fields:

| Field | Type | Notes |
|-------|------|-------|
| `key` | `ComponentKey` | |
| `path` | string | `identity.path` (full hierarchy join) — the tree/grouping key. |
| `hier` | `{level,value}[]` | The full hierarchy, for N-level rollups. |
| `liveness` | `Liveness` | Effective (device UNREACHABLE overlays the ladder). |
| `status` | string? | Last reported `state.status` (`RUNNING`/`STOPPED`). |
| `uptimeSecs` | number? | Last reported uptime (restart = a decrease). |
| `instances` | `InstanceStatus[]`? | Per-instance connectivity, when the state carried it. |
| `lastStateAt` | number? | Receipt time of the last `state` keepalive. |
| `expectedIntervalSecs` | number | The interval driving miss-detection. |
| `cadenceSource` | `CadenceSource` | `default` or `cfg`. |
| `restarts` | number | Observed uptime resets. |
| `values` | `CachedValue[]` | Every cached last-known value. |
| `droppedChannels` | number | Distinct channels dropped by the per-component cap. |

## Delta stream (`FleetDelta`)

Every delta carries a monotonic `seq` and a model-clock `at`. The variants:

| `type` | Extra fields | Meaning |
|--------|-------------|---------|
| `device-discovered` | `device` | First sight of a device. |
| `component-discovered` | `key`, `path`, `hier` | First sight of a component (carries `hier` for dynamic grouping without a snapshot). |
| `instances-changed` | `key`, `instances` | The full new per-instance connectivity set (replace wholesale). |
| `value-updated` | `key`, `instance`, `cls`, `channel?` | A cached value changed (notification only — no body). |
| `liveness-changed` | `key`, `from`, `to` | A ladder transition. |
| `component-restarted` | `key`, `previousUptimeSecs`, `uptimeSecs` | An uptime reset. |
| `device-reachability-changed` | `device`, `unreachable`, `componentCount` | Whole-device UNREACHABLE contain/release (`componentCount` = the "+N suppressed" rollup). |

## Body families (the values the liveness stream deliberately omits)

### Events — `ConsoleEvent`

The `evt` envelope body plus the console's attribution. Key fields: `id` (monotonic, arrival order),
`key`, `instance`, `severity?` (verbatim token), `type`, `channel?`, `body`, `tags?`, `receivedAt`,
`sourceTimestamp?`. The `evt/{severity}/{type}` channel is split leniently by `splitEventChannel()`, and
raw severity tokens are classified into `critical | error | warning | info | debug` by
`classifyEventSeverity()` (unknown ⇒ rendered neutrally — the class is open, never rejected).

### Metrics — `MetricSeriesSnapshot` / `MetricSeriesUpdate`

One series per `(component, instance, metric, measure)`: `latest`, `receivedAt`, and a bounded ascending
`points: {at, value}[]` (default `DEFAULT_METRIC_SERIES_POINTS = 60`). Bodies fold leniently — the
library's EMF shape (top-level numeric measures; `_aws` skipped) and bare numbers (measure `"value"`)
alike.

### Logs — `ConsoleLogRecord` / `ConsoleLogSnapshot`

One retained record per structured UNS `log/{level}` envelope. The console only accepts attributable
EdgeCommons envelopes with `body.schema === "edgecommons.log.v1"`; malformed or over-retained records are
dropped and counted.

```ts
type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

interface ConsoleLogRecord {
  id: number;
  key: ComponentKey;
  instance: string;
  level: LogLevel;
  logger: string;
  message: string;
  receivedAt: number;
  sourceTimestamp?: string;
  sequence?: number;
  thread?: string;
  fields?: Record<string, unknown>;
  error?: { type?: string; message?: string; stack?: string };
  truncated?: boolean;
  channel?: string;
  tags?: Record<string, unknown>;
}
```

`subscribe-logs` scopes to one component key. A `logs` frame returns the retained component tail
newest-first; later `log` frames carry one or more fresh records. `logs-unavailable` is returned when the
gateway has no log source wired or policy forbids the subscription.

### Signals (data plane) — `SignalSeriesSnapshot` / `SignalSeriesUpdate`

One series per `(component, instance, signal)`: `latest` (verbatim value), `quality?`, `receivedAt`, and a
bounded `points: {at, value, quality?}[]` (default `DEFAULT_SIGNAL_SERIES_POINTS = 60`).
`extractSignalSample(body)` splits a `data` body leniently: an object with a `value` field yields that
value (+ its `quality`); any other object yields the whole body as the value; a scalar body is the value
with no quality.

### Runtime attributes — `RuntimeAttributes`

A latest-wins projection over the `metric` class the Overview columns and Component-Detail Health tab
render: `cpuPercent?`, `memoryMb?`, `threads?`, `fds?` (the `sys.*` measures), `connectionState?`,
`readErrors?`, `writeErrors?` (adapter `southbound_health`), `platform?` (from `tags.platform` when a
component advertises it), and `cpuSeries?` (the Overview CPU sparkline). All optional — a component that
never emitted a measure omits it (the UI shows "—").

### Alarms — `ConsoleAlarm` / `AlarmCounts` / `AlarmSnapshot`

Console-derived from the `evt` severity stream: a `critical`/`error`/`warning` event **raises** an alarm
keyed by `(component, type)`; a normal-severity follow-up on the same key **clears** it (into history).
`acked` is console-side. A device going UNREACHABLE **contains** (suppresses from active counts, does not
clear) its components' alarms. `AlarmCounts` = `{ critical, warning, active, contained, acked }`.

## The console's own self-surfaces

- **`ConsoleSelf`** (on the `heartbeat`): the console's own `device`/`component`, resolved
  `platform?`/`transport?`/`broker?`, and process `cpuPercent?`/`memoryMb?`/`uptimeSecs` — the Overview
  "Edge node" and "Edge bus" tiles.
- **`ConsoleSettings`** (the `settings` frame): the console's own effective policy, read-only — `rbac`
  (roles + allow/deny + default), `connection` (identity + WS listener + `servesUi`), `staleness`,
  `commands` (incl. the bridge TTL ceiling), and `retention` (all the cache caps). This is a curated
  projection of the parsed config, never the raw document.

## Commands

`invoke-command` → exactly one `command-result`, correlated by the client-chosen `requestId`. On success
`ok: true` + `result` (the verb's result object, e.g. ping's `{status, uptimeSecs}`); on failure
`ok: false` + `error: CommandError`. `CommandError.code` is an **opaque string** — either the component's
own code passed through verbatim (`UNKNOWN_VERB`/`HANDLER_ERROR`/`RELOAD_FAILED`/`NO_CONFIG`) or a
console-synthesized `ConsoleCommandErrorCode`:

| Code | Meaning |
|------|---------|
| `FORBIDDEN` | RBAC denied the verb — never hit the bus (only this code drives a distinct UI affordance). |
| `TIMEOUT` | No reply within the per-verb deadline (≤ the bridge reply-map TTL). |
| `REQUEST_FAILED` | The request could not be issued/awaited (transport/publish error). |
| `INVALID_TARGET` | `(key, verb)` did not form a valid UNS topic. |
| `MALFORMED_REPLY` | A reply arrived whose body was not the `{ok, result\|error}` shape. |
| `UNAVAILABLE` | The gateway has no command seam wired. |

The three universal built-in verbs every component answers: **`BUILTIN_COMMAND_VERBS`** =
`["ping", "reload-config", "get-configuration"]`. The console does not discover a component's custom
verbs.

## Wire error codes

`WsErrorCode` = `"malformed" | "unsupported-protocol-version"` — both close the connection after the
`error` frame.

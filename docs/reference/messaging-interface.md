# Reference — Messaging Interface (console ↔ bus)

Everything the console **subscribes**, **publishes**, and **requests** on the site UNS bus. Addressing
follows the **Unified Namespace (UNS)**: `ecv1/{device}/{component}/{instance}/{class}[/channel]`, built
and validated by the library (`@edgecommons/edgecommons`) — never a hand-assembled string. For the
browser↔console WebSocket side, see [data-types.md](data-types.md); for the model, see
[explanation.md](../explanation.md).

- `{device}` — the resolved Thing name (the last `hierarchy` level of the *publishing* component).
- `{component}` — the publisher's component short name.
- `{instance}` — a per-connection instance for `data`/`evt`; `main` for `state`/`cfg`/`metric` and the
  `cmd` inbox.

## What the console consumes: six class wildcards

The console has **one** connection — the site broker — and subscribes the **six consumer-class
wildcards**, built via `uns().filter(cls, UnsScope.all())`. This is its entire read surface; it needs no
per-component topic templates.

| Class | Wildcard | What the console does with it |
|-------|----------|-------------------------------|
| `state` | `ecv1/+/+/+/state` | Liveness backbone (miss-detection); `status`/`uptimeSecs`/`instances[]`; the **only** signal that clears a device's UNREACHABLE. Also delivers the bridge protobuf LWT (below). |
| `cfg` | `ecv1/+/+/+/cfg` | Effective, source-redacted config → the Configuration screen; the cadence source (`config.heartbeat.intervalSecs`). |
| `evt` | `ecv1/+/+/+/evt/#` | Rolling event history + the console-side alarm tracker (raise/clear). |
| `metric` | `ecv1/+/+/+/metric/#` | Metric latest/series + the runtime-attributes projection (`sys.*`, `southbound_health`). |
| `data` | `ecv1/+/+/+/data/#` | The data plane → the Signals screen (latest value + quality + trend). |
| `log` | `ecv1/+/+/+/log/#` | Subscribed (part of the six); the console has no Logs UI. |

`cmd` is **published, never subscribed**, and `app` is not consumed.

## Envelope & identity

Normal messages use the EdgeCommons protobuf envelope whose diagnostic JSON shape is
`{header, identity, tags, body}`. The console attributes **every** message by its top-level
**`identity`** element — never the topic:

```jsonc
"identity": {
  "hier": [ { "level": "site", "value": "dallas" }, { "level": "device", "value": "gw-01" } ],
  "path": "dallas/gw-01", "component": "ModbusAdapter", "instance": "plc1"
}
```

- The **device** is the last `hier` value (computed, not a wire field).
- The **class** and **channel** are structural topic positions (the class token's index is known from the
  subscribed filter; the channel is every token after it) — position, not identity.
- `tags` is verbatim business metadata; `_`-prefixed keys (e.g. the bridge hop tag `_relay`) are
  system-reserved and ignored for grouping/business logic.
- `header.timestamp`, when present, is kept as `sourceTimestamp` (display only — it **never** drives
  staleness; the console's own receipt time does).

An envelope the console cannot attribute (no parseable `identity`) is counted (`missing-identity`) and
dropped — never fatal.

## Bridge Last Will

The `uns-bridge` Last Will is published by the **broker** when the bridge connection dies, but the payload
is still a normal EdgeCommons protobuf `state` envelope from the bridge identity:

```text
topic:   ecv1/{device}/uns-bridge/{instance}/state
body:    {"status":"UNREACHABLE"}
```

For this bridge `state` envelope, `status === "UNREACHABLE"` marks the **whole device** UNREACHABLE with
event time equal to console receipt time. Every raw/non-protobuf message is dropped before normal
FleetModel processing.

## What the console publishes

### As a component (library-owned)

The console is itself `com.mbreissi.edgecommons.EdgeConsole`, so the library publishes its **own** `state`
keepalive, `metric` health, and `cfg` on `main` — visible to *another* console. These are the standard
reserved classes; the console never hand-addresses them.

### The per-device republish broadcast (late-join rehydration)

On first sight of a device (and for already-known devices at startup, and on a Configuration **Refresh**),
the console publishes a fire-and-forget `cmd` pair to the reserved `_bcast` pseudo-component:

```text
ecv1/{device}/_bcast/main/cmd/republish-state
ecv1/{device}/_bcast/main/cmd/republish-cfg
```

These ask already-running components on the device to re-announce `state`+`cfg` (the platform uses no
broker retain). They are answered only if the device-side edgecommons runtime handles the `_bcast`
broadcast; the periodic `state` keepalive reconverges liveness within one interval regardless, while the
`cfg` of a long-running component may not refresh until it re-announces. No `reply_to`, no direct reply; a
hostile/invalid device token or a publish failure is logged and skipped.

## The command write path

Commanding is the console's only write surface onto components. The browser's `invoke-command`
([data-types.md](data-types.md#commands)) becomes a request/reply on the site bus:

```mermaid
sequenceDiagram
  participant UI as Browser
  participant GW as CommandGateway
  participant Bus as Site broker (uns-bridge)
  participant C as Component cmd inbox
  UI->>GW: invoke-command { key, verb, args }
  Note over GW: RBAC check<br/>(denied -> FORBIDDEN, never hits the bus)
  GW->>Bus: request ecv1/{device}/{component}/main/cmd/{verb}<br/>header.name=verb, body=args
  Bus->>C: (bridge rewrites reply_to)
  C-->>Bus: { ok, result | error }
  Bus-->>GW: reply
  GW-->>UI: command-result { ok, result|error, elapsedMs }
```

- **Topic**: `ecv1/{device}/{component}/main/cmd/{verb}`, built with `uns().topicFor(target, Cmd, verb)`.
  The inbox is the component's `main` instance (verbs register there; per-instance dispatch is by a body
  selector, not the topic).
- **Request**: `header.name` **must equal** the verb; the body is the `args` object (`{}` when omitted).
- **`reply_to`** is rewritten transparently by the `uns-bridge`, so a site→device request/reply just
  works on the console's single connection.
- **Deadline**: the per-verb timeout (`console.commands`), clamped to `[1, maxTimeoutMs]` where
  `maxTimeoutMs` (60 s) is the bridge reply-map TTL.

### Reply contract

A component answers `{"ok": true, "result": <object>}` or
`{"ok": false, "error": {"code", "message"}}`. The component's own error codes pass through verbatim; the
gateway adds console-side codes (`FORBIDDEN`/`TIMEOUT`/`REQUEST_FAILED`/`INVALID_TARGET`/`MALFORMED_REPLY`,
plus `UNAVAILABLE` when no command seam is wired). See
[data-types.md → Commands](data-types.md#commands).

### Built-in verbs

Every edgecommons component answers three universal built-ins, which the console offers on all components:

| Verb | Result (typical) |
|------|------------------|
| `ping` | `{ status, uptimeSecs }` |
| `get-configuration` | the component's effective configuration |
| `reload-config` | `{ reloaded: true }` (or a `RELOAD_FAILED`/`NO_CONFIG` error) |

A component's **custom** verbs cannot be enumerated (the console does not consume a `describe` manifest),
so the UI offers the built-ins plus a generic *verb + args* form.

## Reserved classes

`state`/`cfg`/`metric`/`log` are library-owned **reserved** classes — a normal component publish to them
is rejected. The console only ever *reads* them, and only ever *mints* the `_bcast … /cmd/republish-*`
broadcasts and the per-component `…/cmd/{verb}` command requests, always through the library's
`uns()`/`messaging()` facades — never a hand-assembled topic string.

## Subscription mechanics

| Property | Value |
|----------|-------|
| Filters | the six `uns().filter(cls, UnsScope.all())` wildcards |
| Dispatch | serial per class (`concurrency = 1`) — ordered folds into the FleetModel |
| Per-subscription queue bound | 256 messages |
| Shutdown | every filter is unsubscribed (idempotent) — the bus is always left clean |

`subscribedFilters()` exposes the active filters for diagnostics; the startup log prints them
(`edge-console ingress subscribed: …`).

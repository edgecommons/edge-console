# Application WebSocket protocol (v1) — internal reference

**Status: internal, evolving. Not a compatibility commitment.** This documents the *current* wire
contract of the hosted-application WebSocket (`/apps/{id}/ws`) implemented in `gateway/src/gemba.rs` and
`gateway/src/http.rs`. It is deliberately **not** part of the published, synced `docs/` set (see the
public, operator-facing surface in [`../reference/configuration.md#componentglobalconsoleapps`](../reference/configuration.md)
and [`../explanation.md#hosting-additional-applications`](../explanation.md)). The `frames[]` payloads are
raw pass-through of the existing Console v7 projections and are explicitly *not* the future stable Gemba
data contract; treat everything here as versioned-and-changeable. Source of truth is the code — update
this doc in the same change as `gemba.rs`.

Constants (`gemba.rs`): `APP_PROTOCOL_VERSION = 1`, `MAX_UI_UPDATE_HZ = 30`
(`UI_UPDATE_INTERVAL ≈ 33.33 ms`), `MAX_ORDERED_FRAMES = 256`, `MAX_PENDING_STATE_FRAMES = 512`,
`MAX_PENDING_BYTES = 1 MiB` per connection. Server-side `HELLO_TIMEOUT = 20 s`.

## Routes and admission (`http.rs`)

- WebSocket route `/apps/{app_id}/ws` is registered **only when `console.apps` is non-empty**. Static
  assets are served by the fallback handler at `/apps/{id}/…` (SPA fallback to the app's `index.html`;
  `403` on traversal; `404` for unknown id).
- Upgrade sequence for `/apps/{id}/ws`: (1) look up `AppConfig` by `id`, else `404`; (2) check the
  **exact-origin allowlist** (`listed_origin_allowed`) — a missing/empty `Origin` is **rejected**, and the
  `Origin` must equal one `allowedOrigins` entry verbatim (after trim), else `403`; (3) resolve the role
  via the same resolver as `/ws` and check membership in `allowedRoles`, else `403`; (4) upgrade. This is
  stricter than legacy `/ws` (which permits same-origin and header-less clients) — a path under a shared
  origin is a packaging namespace, not a security principal.

## Handshake and client→server frames (`gemba.rs`)

Every frame (both directions) carries `"protocolVersion": 1`. Non-object JSON, a bad/absent `type`, or a
wrong `protocolVersion` is answered with an `error` frame **without** closing the socket. The **first**
client frame must be `hello`, else `error{code:"hello-required"}` (and the server closes the socket if no
`hello` arrives within `HELLO_TIMEOUT`).

| Client frame | Shape | Notes |
|--------------|-------|-------|
| `hello` | `{"type":"hello","protocolVersion":1}` | Required first. Server replies `welcome`. |
| `subscribe` | `{"type":"subscribe","protocolVersion":1,"capabilities":["signals","alarms"]}` | `capabilities` = frame families. Each must be a known family **and** be in the app's manifest capabilities, else `error{code:"capability-denied"}`. **Replaces** the whole subscription set (not additive); pending frames for dropped families are purged immediately. Server replies `subscribed`. |
| `command` / `invoke-command` | — | Always `error{code:"command-denied"}`; socket stays open. Hosted apps have no write path. |
| any other `type` | — | `error{code:"malformed","message":"unknown frame type"}`. |

Frame families: `fleet`, `events`, `metrics`, `logs`, `signals`, `attributes`, `alarms`. **No** device or
signal filter exists in `subscribe` — clients subscribe to a whole family and filter client-side by the
`key.device` on each item.

## Server→client frames

| Server frame | Shape |
|--------------|-------|
| `welcome` | `{"type":"welcome","protocolVersion":1,"appId":"<id>","role":"<resolved>","capabilities":[<app's full manifest list>],"maxUpdateHz":30}` |
| `subscribed` | `{"type":"subscribed","protocolVersion":1,"capabilities":[<accepted set>]}` |
| `error` | `{"type":"error","protocolVersion":1,"code":"<code>","message":"<text>"}` — codes: `malformed`, `unsupported-protocol-version`, `hello-required`, `capability-denied`, `command-denied`. |
| `updates` | `{"type":"updates","protocolVersion":1,"frames":[<raw Console projections>],"overflow":{"droppedState":n,"droppedOrdered":n,"droppedUpstream":n,"resyncRequired":bool}}` |

`welcome.capabilities` is the app's **full manifest** list (not the client's subscription).
`welcome.maxUpdateHz` is always the constant `30` (informational; not per-app). `resyncRequired` is true
when any `dropped*` counter is non-zero.

### `updates` cadence and coalescing

Incoming bus events for subscribed families are queued, not sent immediately; a fixed `UI_UPDATE_INTERVAL`
timer drains at most one `updates` frame per tick ⇒ **≤ 30/s**, never a burst. An empty tick sends
nothing (`drain_updates()` returns `None`).

- **State families** (`fleet`, `metrics`, `signals`, `attributes`, `alarms`): items carrying an
  `updates`/`deltas`/`series` array are split per item, keyed by a projected identity
  (`key`,`device`,`component`,`instance`,`signal`,`metric`,`measure`,`id`,`channel`,`type`; the optional
  `name`/signal label is excluded from `Signals`/`Metrics` identity). Only the **latest** value per key
  survives between ticks. `fleet` also enforces a seq floor, `events` an event-id floor
  (`normalize_sequence`) to suppress stale/duplicate deltas after a retained snapshot.
- **Ordered families** (`events`, `logs`): bounded FIFO (`MAX_ORDERED_FRAMES = 256`, drop-oldest),
  order preserved.
- Combined budget `MAX_PENDING_BYTES = 1 MiB`/connection; an oversize single frame is dropped and counted.
  Overflow is always surfaced in `overflow{}`, never silent.

### Retained snapshot on (re)subscribe

On subscribing to a family the server immediately enqueues a retained snapshot: `fleet` → fleet snapshot,
`events` → latest ≤100 events, `metrics`/`signals`(summary)/`attributes`/`alarms` → their current
projections. `logs` has no retained-snapshot query yet (returns nothing until live records arrive).

## Known rough edges (why this is not frozen)

- **Value location differs by frame type.** A snapshot item (`type:"signals"`) carries the value at
  `series[].latest`; a live delta (`type:"signal"`) carries it at `updates[].point.value`. Clients must
  handle both.
- **`signal` is not normalized on the wire.** Depending on the upstream southbound adapter it may be a
  bare name (Modbus), an OPC UA nodeId (`Foo.Bar.Baz`), or an OEE topic (`gemba/oee/overall`). Both
  reference clients carry their own `normSignal()` tables. This is a leak from the raw-Console-projection
  pass-through, not a protocol guarantee.

## Client-side reconnect (reference clients, not a server contract)

There is no server-side reconnect logic beyond the drain timer and hello timeout. The two reference
clients choose **different** strategies (document both as examples, not a canonical policy):

- **Android TV (`google-tv-gemba`)**: exponential backoff `2s→4s→8s→…` capped at `15s`, reset on
  `welcome`; generation-guarded so a stale socket callback is ignored; a 12 s no-data watchdog force-closes
  a silently-stalled socket; OkHttp WS `pingInterval = 15 s`.
- **Tizen (`tizen-gemba`)**: flat `3s` retry; same 12 s stall watchdog (checked every 5 s).

## Origin header, per client

- Android TV (OkHttp, not a browser) forges `Origin: https://google-tv.edgecommons.local` on the request;
  it must match the app's `allowedOrigins` verbatim.
- A packaged Tizen/browser app cannot set `Origin` — the runtime supplies it (empirically `file://` for
  the packaged Samsung app), which must be registered verbatim.

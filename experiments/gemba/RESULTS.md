# Gemba feasibility experiment results

Date: 2026-07-13  
Branch: `feat/gemba`  
Verdict: feasible for separately originated web apps, with protocol, identity, and packaging work
still required before productization.

## What was proven

### Bridge and Console deployment separation

A gateway built from this branch ran as a separate local HOST process on
`127.0.0.1:18443`. It connected to the Dallas site broker exported at
`127.0.0.1:18830` with MQTT client ID `edge-console-gemba-local` and thing identity
`dallas-gemba-local`.

The existing Dallas edge-console remained in its original `dallas-site` container on port 8080.
No Dallas container was rebuilt, restarted, or replaced. After the experiment, `dallas-site`
remained healthy and all three Dallas containers retained their original 42-hour uptimes.

The normal Edge Console was also hosted by a separate Vite process on `127.0.0.1:15173` with
`VITE_CONSOLE_WS_URL=ws://127.0.0.1:18443/ws`. A live WebSocket handshake carrying browser Origin
`http://127.0.0.1:15173` succeeded and returned a Console protocol v7 welcome frame. This proves
the existing Console can be served separately from the bridge without changing its current
protocol.

### Multiple applications

One local gateway simultaneously served:

- `/apps/andon/` with `signals` and `alarms` capabilities; and
- `/apps/gemba-board/` with `fleet`, `events`, and `attributes` capabilities.

The legacy root returned 404 because `console.ws.webRoot` was unset, and an unknown app ID also
returned 404. Each app had its own static root and SPA fallback. The experiment also established an
important boundary: two path prefixes on one browser origin cannot securely identify two apps.
Scoped WebSockets therefore require distinct, explicitly registered app origins.

### Scope, principal, and command denial

Both applications completed experimental protocol v1 hello and allowed subscriptions from their
registered origins. The Andon app was denied an `events` subscription; the Gemba board was denied a
`signals` subscription. Both were denied commands before the existing command gateway or message
bus was reached, and the connections remained usable.

An Andon-origin connection to the Gemba-board socket was rejected during upgrade. A third policy
probe allowed only the `operator` role and was rejected because the running gateway resolved the
principal as `viewer`. This demonstrates enforcement of app origin plus resolved principal role;
it is not production authentication. The principal still comes from the current role-resolver seam
and defaults to the configured role.

### 30 Hz delivery, memory bounds, and failure isolation

Application data is emitted only by a fixed interval whose ceiling is 30 update envelopes per
second. High-rate state is coalesced by projected identity; event/log frames use a bounded 256-entry
ordered queue. State is capped at 512 pending entries, and combined pending serialized data is
capped at 1 MiB per connection. Overflow reports `droppedState`, `droppedOrdered`,
`droppedUpstream`, and `resyncRequired`; broadcast receiver gaps are not mislabeled as ordered
queue loss.

Unit tests folded 1,000 updates for one signal down to its latest value while preserving a second
signal. A 300-event burst retained the newest 256 in order and reported 44 dropped entries. Tests
also cover unique-state and oversized-frame bounds, metric measure identity, empty snapshots,
subscription narrowing, snapshot/delta sequence floors, and retained/live event de-duplication.

The end-to-end load test published 1,500 signal and 1,200 4 KiB event EdgeCommons protobuf
envelopes through the generic local broker on port 1883. While the Gemba board's TCP receive path
was deliberately paused, the independent Andon connection continued receiving live signal data.
It emitted 10 update envelopes during the measured window, with no rolling one-second window above
30, and converged to the final published signal value `1499`. After the stalled socket resumed, it
reported an explicit upstream gap and required resynchronization. It then reconnected to exactly the
latest 100 retained events, covering source sequence `1199` through `1100` in newest-first order.

### Physical TV follow-on

The same application WebSocket was deployed to a Sony BRAVIA 4K VH2 running Android 12/API 31.
The native OkHttp client installed over Wi-Fi ADB, reached **Live**, and consumed real Dallas updates
through the isolated local gateway. Background/foreground and a forced local-gateway outage both
recovered without relaunching the application or leaving multiple established sockets.

For the physical rate-limit check, only the isolated gateway was switched to the generic broker on
port 1883. A 333 Hz paced signal source produced 29.0 update envelopes per second on the Sony while
latest-state coalescing remained current, providing device-level confirmation of the 30 Hz egress
ceiling without publishing synthetic traffic into Dallas. The gateway was then restored to Dallas;
all Dallas containers retained their existing uptimes.

The Google TV diagnostic client also exposed an application concern: rendering a large raw-JSON `TextView`
for every envelope produced high Android `gfxinfo` jank even near 10 Hz. This does not challenge the
WebSocket result, but it confirms that production boards need typed view models and bounded widget
updates rather than whole-payload repainting.

The same route was then deployed as a signed Samsung Tizen Web application on a
`UN55RU8000FXZA`. Its packaged runtime sent Origin `file://`; after that exact Origin was registered
for only `tv-board`, the installed app reached **Live** and consumed Dallas updates. The 2019 TV also
exposed a packaging compatibility constraint: its installer accepts the signed WGT only with a
space-free filename, now normalized by the build script. Samsung deployment and RFC 6455 transport
are therefore feasible. The Samsung and Sony clients were also held concurrently on the same
gateway while the Sony showed **Live**, 504 update envelopes, 3,475 frames, 10.1 Hz, and zero
reconnects. A Samsung power cycle disconnected only that client; power-on returned to the TV's
default stream, and manually relaunching the app created a fresh session that returned to **Live**
with messages flowing. That consumer-TV launch behavior is not a target-deployment blocker because
business-oriented Samsung/Tizen displays provide kiosk mode. Rendering-cost validation and WSS
remain open. See `tv/RESULTS.md` for the device-level evidence.

## Validation evidence

- Rust gateway: 68 tests passed.
- Console browser protocol: 83 tests passed.
- Edge Console UI: 449 tests passed.
- `cargo build -p edge-console-gateway`: passed.
- `cargo clippy -p edge-console-gateway --all-targets -- -D warnings`: passed.
- Dallas verifier: passed against the separate local gateway on port 18443.
- Synthetic burst/isolation verifier: passed against the separate gateway on port 18444 and generic
  local broker on port 1883.
- External Console check: passed with the separately hosted Vite UI and an explicit browser Origin.
- Physical TV clients: Sony Google TV and Samsung Tizen both reached **Live** and consumed Dallas
  updates through the isolated local gateway, including a sustained two-physical-client interval.
- Cleanup: local gateway ports 18443, 18444, and 18445 were released; Dallas containers retained their
  original uptimes and `dallas-site` remained healthy.

## What remains unresolved

- The experimental app API wraps current Console projections. A stable, application-oriented data
  contract and schema ownership/versioning model remain design work.
- State coalescing keys are derived from current projection identity fields. Product code should
  use typed keys per data family rather than this generic experiment heuristic.
- `logs` is recognized by policy and live fan-out, but the experiment has no component/query shape
  for its retained snapshot.
- Commands intentionally fail closed. A production design needs authenticated principals,
  per-command audit, and a deliberately exposed command model. The experiment authorizes the role
  returned by the existing resolver but does not establish user identity.
- Path-based co-hosting is packaging, not app isolation. Production must choose distinct
  origins/virtual hosts or an authenticated app-session mechanism if app identity carries privilege.
- App bundle signing, upgrade/rollback, CSP, TLS termination, and HOST/Greengrass/Kubernetes package
  lifecycle were not part of this HOST feasibility proof.
- The Console v7 endpoint itself is not rate-limited. The experiment preserves it unchanged and
  proves the cap on the separate application API; migrating Edge Console to that API is a later
  compatibility decision.

## Recommendation

Proceed to a formal Gemba bridge API design. Keep the legacy Console v7 adapter while defining typed
application projections and production authentication/authorization. Prefer separate app origins
or virtual hosts, and choose the app package mount/update model for HOST first.

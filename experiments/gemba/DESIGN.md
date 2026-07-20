# Gemba feasibility experiment specification

Status: experimental; branch `feat/gemba` only. None of the APIs or configuration in this
directory are a compatibility commitment.

## Goal

Prove that one site-local edge-console gateway process can remain the sole EdgeCommons bus
participant while it serves multiple independently packaged browser applications. Preserve the
existing Console v7 `/ws` contract unchanged and exercise the new behavior through a separate,
minimal application API.

## Constraints

- Change only the `edge-console` repository on `feat/gemba`.
- Do not change the EdgeCommons core library or another component repository.
- The Dallas site broker at `127.0.0.1:18830` may supply real site messages.
- Run a separate local gateway on a non-Dallas port and with a unique MQTT client ID. Do not
  rebuild, restart, replace, or enter the existing `dallas-site` edge-console process.

## Experiment boundary

The existing `/ws` endpoint and Console v7 protocol stay untouched. Experimental applications use:

- static content at `/apps/{appId}/...`;
- a WebSocket at `/apps/{appId}/ws`;
- application identity derived from the server-selected route, not trusted browser input; and
- an experimental protocol version independent of Console v7.

`component.global.console.apps` is an experimental registry. Each entry declares an `id`,
`webRoot`, explicit browser `allowedOrigins`, non-empty `allowedRoles`, and a closed set of readable
`capabilities`. Unknown or missing policy fields fail closed. Initial capabilities are `fleet`,
`events`, `metrics`, `logs`, `signals`, `attributes`, and `alarms`; `commands` remains denied in the
experiment.

An app WebSocket requires both an exact manifest origin and an allowed resolved role. Unlike the
legacy Console endpoint, absent and merely same-origin browser origins are not accepted. This is a
deliberate feasibility result: path prefixes below one shared browser origin are packaging
namespaces, not security principals. Independently trusted apps need distinct origins (for example,
virtual hosts or separately hosted bundles) or a future authenticated app-session mechanism.

## Application protocol

The browser sends `hello` first, then `subscribe` with a list of requested capabilities. A request
outside the app manifest is rejected while the connection remains usable. Accepted data is
delivered in `updates` envelopes whose `frames` array carries the current Console projections.
This reuse is intentional for feasibility only; it does not declare those projections to be the
future stable Gemba data contract.

The application-plus-principal authorization seam combines route-selected policy, exact browser
origin, and the existing header-derived role. The experiment proves cross-origin app denial,
principal-role denial, capability denial, and fail-closed commands. Production principal
authentication remains future work; `allowedRoles` authorizes the result of the current resolver
and does not make that resolver an identity provider.

## Delivery and backpressure

Application WebSockets emit at most 30 `updates` messages per second. The bridge continues to
ingest the bus and update its retained model at full speed.

- State-like families (`fleet`, `metrics`, `signals`, `attributes`, `alarms`) retain the latest
  pending frame per typed projection identity between ticks. Metric `measure` is part of that
  identity.
- Ordered families (`events`, `logs`) use a bounded per-session queue and are emitted in order in
  the next update envelope.
- Pending state is capped at 512 entries, ordered data at 256 entries, and their combined serialized
  payload at 1 MiB per connection. Overflow is explicit through `droppedState`, `droppedOrdered`,
  `droppedUpstream`, and `resyncRequired`; broadcast receiver lag is reported as an upstream gap,
  not misclassified as ordered-data loss.
- Fleet sequence floors and event ID high-water marks prevent retained snapshots from being followed
  by stale deltas or duplicate live events. A reconnect receives at most the latest 100 retained
  events so its initial ordered snapshot fits the byte budget.
- A successful narrower subscription purges queued frames from removed families.
- Console v7 remains unchanged during the experiment; migration to the bounded app API is a later
  compatibility decision.

## Work split

1. Parse and validate the experimental app registry.
2. Add isolated app static routes with per-app SPA fallback and origin checks.
3. Add the scoped application WebSocket, 30 Hz batcher, and denial behavior.
4. Add two small apps with different manifests and an automated live verifier.
5. Run unit/build tests and a local HOST gateway against Dallas on a distinct port.

## Acceptance criteria

- Existing Rust, Console protocol, and Console UI tests remain green.
- With no legacy `webRoot`, `/` is 404 while two apps are served concurrently below their own
  route prefixes.
- The existing Console UI can run externally against the unchanged `/ws` endpoint.
- Each sample app can subscribe only to its declared capability set; denied reads and commands are
  observable and do not touch the bus.
- An end-to-end protobuf MQTT burst proves no more than 30 application update messages per second,
  bounded ordered queues, and latest-state coalescing.
- Pausing one application's TCP receive path does not stop a second application from receiving live
  updates; terminating and reconnecting the stalled client produces a bounded retained snapshot.
- A separate local gateway consumes live Dallas broker messages without changing the Dallas
  containers or their resident edge-console process.

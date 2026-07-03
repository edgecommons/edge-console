# Edge Console — UNS reconciliation & Phase-1 build plan

**Status: RECONCILIATION (design-to-shipped-reality pass) · 2026-07-03**

> Reconciles `DESIGN.md` v0.3 (2026-07-02) against what has **actually shipped** since:
> the UNS core in all four ggcommons libraries (branch `feat/unified-namespace` — grammar,
> top-level `identity`, `gg.uns()`, reserved-class guard, `request()` deadline, MQTT LWT,
> the library-owned `state`/`metric`/`cfg` publishers, `uns-test-vectors/`), the finalized
> decision registers (D‑U1…D‑U27 in `UNS-CANONICAL-DESIGN.md`, D‑B1…D‑B15 in
> `DESIGN-uns-bridge.md`), and the **completed `uns-bridge`** (sibling repo, slices
> P3‑2…P3‑6 done, dual-EMQX e2e 9/9 green). Everything below was verified against the
> shipped source (`ggcommons/libs/ts/`, the bridge repo README + code layout), not against
> other design docs.
>
> Bottom line up front: **the console's design survives almost intact — and most of its
> "mandates" are now free.** Priority #1 (edge-health) needs **zero** new ggcommons work.
> Priority #2 (config-review) needs exactly **one small 4-language ggcommons slice** — the
> device-side `republish-state`/`republish-cfg` `_bcast` listener (the same deferred item
> the bridge already broadcasts into, today "answered by nobody"). Everything else the
> console still wants from the library (describe/panels/southbound family) gates only
> Tier-2 screens and stays parked at Phase 5.

---

## 1. Grammar / envelope reconciliation — every concrete drift

DESIGN.md v0.3 was written *with* DESIGN-uns, so the big shapes match (device-only topic,
top-level `identity`, six wildcards, `/`-delimited verbs). The drifts are where the
**canonical/implementation pass and the bridge build refined the design after v0.3 was
frozen**. Each row: what the console doc says → what shipped → what the console adopts.

| # | Console design says | What actually shipped | Console must adopt |
|---|---|---|---|
| G1 | **Broadcast re-announce** at `ecv1/bcast/cmd/republish-state` (§6.4 diagram, §4) | D‑U19: broadcast is the reserved pseudo-component **`_bcast`**, **per device**: `ecv1/{device}/_bcast/main/cmd/republish-state` (+ `…/republish-cfg`). Site-wide (`+`-device) broadcast is explicitly deferred. `_`-prefix = reserved system pseudo-components. | On console start, publish the republish broadcast **once per known/discovered device** (iterate the FleetModel's device list; bootstrap: fire after the first `state` from a new device). Also: the **bridge already fires this on every site-reconnect rising edge**, so the console gets rehydration for free whenever a device's uplink flaps. |
| G2 | Commands issued via **`gg.commands().invoke(...)`** (§6.5) | The `commands()` facade (and `telemetry()/status()/events()/discovery()`) is **deferred to the components phase**. What shipped: `gg.uns().topicFor(targetIdentity, Cmd, verb)` + `messaging().request(topic, msg, timeout)` with the framework-owned deadline (default `messaging.requestTimeoutSeconds` = 30 s, per-call override). | CommandGateway = `uns().topicFor()` + `messaging().request()`. Keep per-call timeouts (10 s default / 30 s config ops) **≤ 60 s**, the bridge's reply-map TTL (paired knob, D‑B9). |
| G3 | `get-configuration` verb reaches the component (§7 table) | Only **Flow A** shipped: `ecv1/{device}/config/main/cmd/get-configuration` is the CONFIG_COMPONENT **source fetch** (component pulls *its own* config from a config server — the console is neither party). **Flow B** (console→component `get-configuration` at the component's own inbox `ecv1/{device}/{comp}/{inst}/cmd/get-configuration`) is deferred with the verbs. What DID ship for config-review is the **`cfg` push publisher**: every component announces its effective (redacted) config on `ecv1/{device}/{comp}/main/cfg` at startup + on every change, body `{"config": {…}}`. | Config-review v1 = consume the **`cfg` class** (already in the six wildcards) + the timestamped cache. Pull-on-demand for *already-running* components needs the `republish-cfg` listener (§3, item S1) — `cfg` is publish-on-startup/on-change only, so a console started later sees nothing until a change without it. |
| G4 | Miss-detection: "each `state` carries its own **`keepalive_secs` in-band**… `boot_id`/`seq` pair distinguishes restart from gap" (§6.2); mockups show "keepalive 5s" chips | Shipped `state` body is **`{"status":"RUNNING","uptimeSecs":n}`** (STOPPED on graceful stop) — **no** `keepalive_secs`, **no** `boot_id`/`seq`. Cadence lives in the component's **`cfg`** announcement (`heartbeat.intervalSecs`, schema default 5, min 1). | Derive cadence console-side: per-component expected interval = `cfg.body.config.heartbeat.intervalSecs`, defaulting to **5 s** until the cfg arrives. Restart-vs-gap discrimination = **`uptimeSecs` reset** (a decrease ⇒ restart). Zero library work. *(Option: a tiny 4-language add putting `keepaliveSecs` in the state body — see Open Question Q3; not required.)* |
| G5 | Device UNREACHABLE from "bridge Last-Wills" (§6.2), identity always read "from the top-level `identity` block, never the topic" (§6.1) | The bridge's LWT is a **bare raw JSON payload `{"status":"UNREACHABLE"}`** on `ecv1/{device}/uns-bridge/main/state` — **no envelope, no `identity`, no header** (broker-published; can't carry an honest timestamp). It **also fires on graceful bridge stop** (intended: a stopped bridge = an unreachable device); terminal sequence is relayed component `STOPPED`s → bridge `STOPPED` → raw `UNREACHABLE`. | BusIngress needs a **raw-message path on the `state` wildcard**: a `{raw}` message whose topic parses as `ecv1/{device}/uns-bridge/{inst}/state` with `status: "UNREACHABLE"` ⇒ whole-device UNREACHABLE, **event-time = delivery time** (stamp on receipt). This is the *one documented exception* to "never parse the topic". UNREACHABLE must be terminal-until-next-state even after a graceful stop. |
| G6 | `tags` = pure business context (§ identity discussion) | Every bridge-relayed envelope carries the reserved hop tag **`tags._relay`** (JSON array of `{device}/uns-bridge` hop ids). `_`-prefixed tag keys are library/system-reserved. | Ignore `_relay` for grouping/business logic; optionally surface it as the "which path did this take" breadcrumb in the detail view. Never render `_`-keys as user tags. |
| G7 | Discovery: "`state` seen with `describe_digest`, then `cmd/describe`" (§8.2) | No `describe_digest` in the state body; `describe`/`get-panel-asset` verbs and the `discovery()` facade are deferred (Phase 5 with M9/M10). | Phase-1 console builds inventory from `state`+`cfg`+`metric` alone (Tier-1 view). The describe/panel pipeline stays the Phase-2+ design as written — no rework, just later. |
| G8 | Hi-fi mockup topic `ecv1/dallas/packaging/pack-gw-01/modbus-adapter/cfg` (mockups-hifi.html line ~579) | Grammar is **device-only, constant depth, with `{instance}`**: `ecv1/pack-gw-01/modbus-adapter/main/cfg`. Hierarchy (dallas/packaging) is in `identity.hier`/`identity.path`, never the topic. | Fix the mockup string when the screen is built (`identity.path` belongs in the breadcrumb, not the topic). DESIGN.md prose is already correct (v0.3 D10); only the mockup carries the stale form. |
| G9 | Tier 0: legacy-heartbeat components get a "limited visibility" card (§11); BusIngress keeps a "legacy topic-scheme parser… fallback" (§6.1) | The bridge uplinks **only** `ecv1/…` class topics (six filters). Legacy topics (`ggcommons/{Thing}/{Comp}/heartbeat` etc.) **never reach the site broker**. And a component's library rev-bump flips it to the new state keepalive **automatically** (library-owned, on-by-default 5 s) — i.e. rev-bump ⇒ Tier 1, no component code. | **Drop the legacy-topic parser and the Tier-0 tier.** Pre-UNS components are simply invisible at the site broker; post-rev-bump they are Tier 1 for free. (Tier 0 survives only in the degenerate single-device deployment where the console sits on the device bus itself — not worth code.) |
| G10 | Six-wildcard subscription set (§4) | Shipped **verbatim**: `ecv1/+/+/+/state`, `…/cfg`, `…/evt/#`, `…/metric/#`, `…/data/#`, `…/log/#` — buildable through the library: `gg.uns().filter(cls, UnsScope.all())`. | Adopt as-is; build the filters through `uns().filter()`, never by hand (bridge precedent). |
| G11 | Envelope `{header, identity, tags, body}`; `identity.device` field (early prose) | Shipped exactly as v0.3 already said: `identity = {hier[], path, component, instance}`, **no wire `device` field** — device = last `hier` entry (computed accessor on `MessageIdentity`); `identity` is **optional** (raw messages, pre-config bootstrap). `tags.thing` is gone. | FleetModel key = `identity.path` + `component` + `instance` (as designed). Handle `identity == undefined` (raw + bootstrap messages) without crashing the normalizer. |
| G12 | M12: "a new `console` config section… modeled on the `health` section" | The canonical schema's top level is **strict** (`additionalProperties:false`) — a new top-level `console` key would be a canonical-schema change. The bridge set the precedent for component-specific knobs instead: **put them in the component's own `component.global`/`component.instances[]`** (permissive body, zero schema change — exactly how the bridge configures its site broker, uplink policy, reply map). | Console config (port/bindAddress/tls/auth, staleness multipliers, redaction deny-list) lives under **`component.global.console`**. **M12 collapses to console-side — no ggcommons change.** |
| G13 | Request/reply: console owns timeouts because the lib has none (§1 "grounded facts") | **Fixed in the library** as designed: framework-owned deadline (default 30 s, `messaging.requestTimeoutSeconds`), reply-topic cleanup guaranteed even if the caller never awaits, `RequestTimeoutError`. | The "grounded fact" is obsolete — the CommandGateway keeps its *own* per-command timeout only as UX policy (per-verb values), relying on the lib for cleanup. |
| G14 | — (not in the console doc) | The bridge **rate-caps the data plane** (default `data` 200 msg/s token bucket, `metric` 50/s in the sample; drops counted) and drops `log` off / `app` off by default; live-path loss during WAN outages is by design; **`evt` gets a bounded ordered replay buffer (1000)**. | The Signals browser must present bridge-side sampling as normal (the design already says ingest-sampled); the Events feed can trust `evt` ordering across WAN blips; per-device drop counters (`relay_dropped_*` metrics from each `uns-bridge`) are **first-class edge-health signals** — chart them on the device card. |

**Non-drifts (assumed by the console, shipped verbatim):** device-only topic grammar +
constant depth + `includeRoot` opt-in; the 8-class set with reserved `state/metric/cfg/log`
+ the guard; heartbeat→`state` keepalive on/5 s/local + `sys` metric (M11/D‑U14/D‑U20);
`cfg` effective-config publisher with redaction v1 (`$secret` untouched, `password`/`pin`/
messaging-credentials → `"***"`); MQTT LWT with retain hard-omitted (D4→M7 as revised);
`gg.uns()` builder/validator + `UnsScope`; `gg.instance()`; per-message instance stamping;
`/`-delimited lowercase-hyphenated verbs; `uns-test-vectors` conformance; the bridge's
`reply_to` rewrite making site→device request/reply transparent to the console.

---

## 2. A1–A7 / M1–M15 status against shipped reality

Two housekeeping notes first:

- The **A1–A7 labels** (the v0.1/v0.2 "proposed ggcommons adds": announce, Describe,
  GetEffectiveConfiguration, status/health checks, events, commands, panels) were
  **superseded in v0.3** by the M-mandate set — DESIGN.md v0.3 no longer carries A-numbers.
  They are reconciled below as the cross-cutting capability catalog (§7 of DESIGN.md),
  each mapped to its M-item.
- The **M1–M15 mandate walk was approved 2026-07-02** and then *largely built*. This table
  is the "how much is now free" verdict.

### 2.1 The platform mandates (M1–M9, M11, M14, M15)

| Item | What it was | Verdict | By what / what remains |
|---|---|---|---|
| **M1** `uns-bridge` | envelope-aware per-device relay | **✅ ALREADY SATISFIED (built)** | Sibling repo, P3‑2…P3‑6 done: relay matrix, hop tag, reply rewrite, per-class policy + rate caps + `evt` replay buffer, LWT UNREACHABLE, own observability (counters as `metric`s), dual-EMQX e2e 9/9. *(Held for release: GitHub remote + rev-pin bump; GREENGRASS/IPC-primary variant; standard CLI contract — none block the console's HOST-first Phase 1.)* |
| **M2** site-broker recipes | EMQX deploy + ACL | **✅ ALREADY SATISFIED (built)** | `uns-bridge/deploy/site-broker/`: HOST compose (+ dual-EMQX dev rig), GG DockerApplicationManager recipe, k8s manifests, per-device **ACL** file. One console-driven delta remains — see §4 (ACL principal for the console). |
| **M3** UNS grammar | topic grammar + classes | **✅ ALREADY SATISFIED** | All four libs; vectors; interop suite. |
| **M4** messaging model | `messaging()` + `uns()` + guard + facades | **✅ SATISFIED for what the console needs in Phase 1** — `messaging()` (hardened), `uns()` builder/validator, reserved guard + privileged seams, library publishers. **Deferred sub-part:** the opt-in facades (`telemetry/status/events/commands/discovery`) — see S2/S3 below. |
| **M5** identity + hierarchy | top-level `identity`, configurable `hierarchy` | **✅ ALREADY SATISFIED** | Per-component `hierarchy`+`identity` config, fail-fast resolution, `MessageIdentity` in all four langs, `tags.thing` removed. (SHARED_CONFIG distribution deferred — irrelevant to the console, which only *reads* identity.) |
| **M6** request hardening | internal deadline + cleanup | **✅ ALREADY SATISFIED** | Default 30 s, per-call override, `RequestTimeoutError`, idempotent settle. |
| **M7** MQTT LWT (retain deferred) | provider hook | **✅ ALREADY SATISFIED** | `messaging.lwt`, local connection, retain hard-wired false, IPC no-op; bridge uses it on its site connection (D‑B11). |
| **M8** named/second connection | "the bridge needs it" | **✅ RESOLVED AS NO-OP** (D‑U17 final / D‑B1..B5) | No core change in any language — the site broker is the *bridge's* external system. The console needs exactly **one** connection; unaffected. |
| **M9** southbound command family (`sb/*`, confirmed writes, `writes.allow[]`) | adapter-contract v2 | **⏳ STILL NEEDED — Phase 5, as planned** | Not started (D‑U15/16 provisional). Gates only the rich-control screens (Address Space, signalGrid, confirmed writes) — **not** edge-health or config-review. 4 languages + both adapters. |
| **M11** heartbeat parity | on/5 s/state | **✅ ALREADY SATISFIED** | Pulled into Phase 1 and shipped (D‑U14/D‑U20); `heartbeat.targets[]` removed. |
| **M14** uns-test-vectors | conformance | **✅ ALREADY SATISFIED** | `uns-test-vectors/` + interop UNS suite. |
| **M15** streaming enrichment | identity columns/partitioning | **⏳ STILL NEEDED — Phase 4, as planned** | Console only observes stream *health* via `metric` (already available); M15 is invisible to the console UI. No console dependency. |

### 2.2 The cross-cutting capability catalog (the old A1–A7) + console mandates

| Capability (old A-item) | Verdict | Detail |
|---|---|---|
| **Announce / liveness** | **✅ SATISFIED** | = the `state` keepalive (on by default, 5 s, `RUNNING`/`STOPPED`) + bridge LWT `UNREACHABLE`. Announce *is* the first state (D11 → shipped D6). Nothing to build in ggcommons. |
| **GetEffectiveConfiguration** | **◐ MOSTLY SATISFIED / one small slice remains (S1)** | The **`cfg` push publisher** (startup + on-change, redacted) is the config-review backbone and is shipped. Remaining: the **device-side `republish-state`/`republish-cfg` `_bcast` listener** so a late-joining console (or a reconnecting bridge — it already broadcasts this) can pull current state+cfg from already-running components. All 4 languages; small (a topic-selective subscription + re-invoking two existing publishers). The Flow-B `get-configuration` *request* verb is a nice-to-have on top (per-component pull with a reply), not required once `republish-cfg` exists. |
| **Describe / capability manifest** | **⏳ STILL NEEDED — deferred (Phase 3/5 "components phase")** | `describe` verb + manifest + `describe_digest`. Gates capability-driven UI + panels (Tier 2). 4 languages. Not needed for priorities #1/#2. |
| **status() / health checks** | **⏳ STILL NEEDED — deferred** | `state.checks[]` / DEGRADED nuance = the `status()` facade. Until it lands the console's state machine simply has no DEGRADED inputs (renders from keepalive freshness alone). 4 languages, Tier-2 opt-in. |
| **events()** | **⏳ STILL NEEDED (facade) / class usable NOW** | The `evt` **class** is open (any component may publish `evt/{sev}/{type}` via `messaging()`+`uns()` today, and the bridge buffers it across WAN blips). The convenience facade + raise/clear alarm semantics are deferred. Console consumes whatever appears — the Events screen works day one, populated as components adopt. |
| **commands() + built-in verbs** (`ping`, `reload-config`, `set-log-level`, Flow-B `get-configuration`) | **⏳ STILL NEEDED — the "Phase-3 leftovers" slice (S2)** | Deferred with the facades. The console can *issue* requests today (G2) but no component *answers* any verb yet. Minimal useful subset for the console: the `_bcast` listener (S1) ⊂ this slice; then `ping` + `reload-config` + Flow-B `get-configuration`. 4 languages. |
| **Panels (get-panel-asset, descriptor)** | **🖥 CONSOLE-SIDE + deferred lib part** | Descriptor renderer, `treeBrowser`/`signalGrid`, fallback ladder, content-addressed cache = console code (M10, parked). The lib part (`get-panel-asset` verb, manifest in `describe`) rides the Phase-5 describe slice. |
| **FleetModel + miss-detection** | **🖥 CONSOLE-SIDE (by design — the platform's first)** | Timestamped LKV cache = the retain substitute (confirmed: retain stayed out, D9/M7). Cadence from `cfg` (G4), restart from `uptimeSecs` reset, UNREACHABLE from the bridge LWT (G5). |
| **WsFanout / snapshot-then-deltas / CommandGateway / RBAC / audit / redaction-at-ingest** | **🖥 CONSOLE-SIDE** | As designed (§6). Lib-side redaction v1 already applied before the console ever sees `cfg` — console redaction is the second, console-owned layer. |
| **M10** panel schema v2 | **🖥 CONSOLE-SIDE, Phase 2+** | Depends on describe + M9; parked exactly as the mandate walk left it. |
| **M12** `console` config section | **🖥 CONSOLE-SIDE — mandate dissolved (G12)** | Lives under the console's own `component.global.console`; zero ggcommons change (bridge precedent). |
| **M13** k8s Service/Ingress + single-replica | **🖥 CONSOLE-SIDE** | Ship manifests in the console repo's `deploy/` (bridge's `deploy/site-broker/` precedent); `replicas: 1` + `Recreate` documented. No generic ggcommons chart work needed. |

### 2.3 Headline: how much ggcommons work remains for the console

**Required for console Phase 1 (priorities #1+#2): ONE small 4-language slice —**

- **S1 — the `_bcast` `republish-state`/`republish-cfg` listener** (device side). Already
  specified (UNS-CANONICAL §4.3, deferred list; bridge P3‑4 explicitly calls it the missing
  half — "published but answered by nobody"). Each library subscribes
  `ecv1/{device}/_bcast/main/cmd/#` and, on `republish-state`/`republish-cfg` (with 0–2 s
  jitter), re-fires the existing state keepalive / cfg publisher. Small, pure-logic,
  gate-friendly. **This one slice simultaneously un-inerts the bridge's reconnect
  rehydration** — one stone, two birds.

**Wanted soon after (Phase-1.5/2, still small): S2 — minimal Flow-B verb scaffolding**
(`ping`, `reload-config`, Flow-B `get-configuration`) — the first `commands()` slice.
**Later, as already phased:** S3 describe/discovery + panels (Phase 5, with M10), M9
southbound family (Phase 5), M15 streaming (Phase 4). **Everything else the console
consumes is already shipped.**

*(One non-console item noticed in passing: the bridge README's Rust-only follow-up —
exposing the runtime's raw provider to drop one device-bus client — is unrelated to the
console and stays with the bridge.)*

---

## 3. Connection & topology decision

**The console attaches to the site broker — the aggregation point the bridges relay into.**
Confirmed by the shipped topology (bridge relays uplink topic-verbatim; site consumers are
first-class in the shipped ACL model). Per deployment shape:

| Deployment | Console connects to | Notes |
|---|---|---|
| Multi-device site (HOST or GG devices) | **site EMQX** on the gateway box | The primary case. One `MessagingClient` (TS lib), `messaging.local` = the site broker. |
| Single device | the device's local bus directly | No bridge, no site broker (DESIGN-uns §9.2). Same console code — it just sees one device. |
| Kubernetes | the **in-cluster broker** (it *is* the aggregation point) | No bridge inside the cluster; console is a single-replica Deployment (`Recreate`) + Service/Ingress (M13). |

**Subscriptions:** the six class wildcards, built via `gg.uns().filter(cls, UnsScope.all())`.
`cmd` never subscribed (the console publishes it); `app` not subscribed. The `state`
wildcard **also delivers the bridges' raw LWT payloads** — the BusIngress raw-path (G5).
Optionally narrow `data` per device/scope in production (the design's note stands; the
bridge's rate caps make the default safe anyway).

**Commands:** `uns().topicFor(targetIdentity, Cmd, verb)` → the target's own inbox
`ecv1/{device}/{comp}/{inst}/cmd/{verb}` → `messaging().request(topic, msg, timeoutMs)`.
The **bridge transparently proxies the reply path** (mints a device-side `ggcommons/reply-…`,
maps it back, TTL 60 s / maxPending 1024) — the console does nothing special; its
`reply_to`/`correlation_id` survive verbatim. Constraint adopted: per-command timeouts stay
≤ 30 s (< the 60 s bridge TTL, paired-knob rule). Broadcast = per-device
`ecv1/{device}/_bcast/main/cmd/{verb}` publishes iterated over the FleetModel's device list
(site-wide `+` broadcast deferred, per D‑U19).

**FleetModel + miss-detection without retain** (the timestamped app-layer cache, confirmed
as the retain substitute — retain stayed deferred):

1. **Backbone** — the periodic `state` keepalive (on by default, 5 s) relayed by each
   bridge. Every FleetModel entry carries the receipt timestamp; per-value age badges as
   designed.
2. **Cadence** — from the component's `cfg` (`heartbeat.intervalSecs`), default 5 s until
   known (G4). Thresholds stay D5: warn 2×, STALE 2.5×, OFFLINE 5×, tunable. Restart vs
   gap: `uptimeSecs` decrease ⇒ restart.
3. **Late-join snapshot** — on console start (and per new device), publish
   `republish-state` + `republish-cfg` per device; components answer with jitter **once S1
   lands**. Until S1: convergence still happens via layer 1 within ~1 keepalive interval
   for `state`; `cfg` of long-running components is the visible gap (G3).
4. **Whole-device UNREACHABLE** — the bridge's LWT raw `{"status":"UNREACHABLE"}` on
   `ecv1/{device}/uns-bridge/main/state` (fires on ungraceful *and* graceful bridge stop —
   render as truth). Freeze the device subtree, alarm containment (+N suppressed), as
   designed. Additional cheap signal: each bridge's `site_connected` gauge + `relay_dropped_*`
   counters arrive as ordinary `metric`s — chart them on the device card.
5. **Events** — `evt` survives WAN blips in-order (bridge replay buffer); the event ring +
   reconnect replay design stands.

**ACL note (console-driven delta to the shipped `acl.conf`):** the shipped site-broker ACL
knows two principals (device bridges; `consumer-*` = subscribe `ecv1/#` + publish `cmd`/
`_bcast`/replies). The console is a consumer **but is also itself a ggcommons component**
whose own runtime publishes its `state`/`cfg`/`metric` under `ecv1/{console-device}/…` on
its one connection. The consumer principal as shipped would **deny** those publishes. Fix:
a hybrid principal for gateway-local components (consumer grants + publish under **its own**
`ecv1/{device}/#` subtree) — a one-stanza `acl.conf` addition in `deploy/site-broker/`.
Flagged as Q4.

---

## 4. Phase-1 build plan (console slices)

Discipline mirrors the bridge: **every slice builds green + is tested before the next**
(pure-logic cores split from IO for the 90 % gate; e2e outside the gate). TS/Node backend on
the ggcommons TS lib (D6), Carbon/React frontend, shared `protocol` package as a hard
contract. Local dev builds against the **sibling** `../ggcommons/libs/ts` (`file:` dep /
workspace link — the `.cargo`-override precedent); switch to the pinned published package
when `feat/unified-namespace` lands on `main` (same release-train posture as the bridge's
held rev-pin bump).

| Slice | Contents | Depends on | Test proof |
|---|---|---|---|
| **C0 — repo scaffold** | `edge-console` repo (currently a plain folder): npm workspace `server/` + `ui/` + `protocol/`; server scaffolded as a ggcommons TS component (config under `component.global.console`, G12); CI per `component-ci.yml`; gitignored sibling-lib link | org action: repo + registry entry (Q1) | builds green; lib link resolves; `GGCommons` boots against local EMQX |
| **C1 — BusIngress + FleetModel core** ⟵ **THE FIRST BUILDABLE SLICE** | One `MessagingClient`; six `uns().filter()` subscriptions; normalizer (envelope + **raw/LWT path**, `identity`-keyed, `_relay`-aware); the hierarchical FleetModel (generic N-level tree from `identity.hier`, timestamped LKV per node); the staleness engine (injected clock: cfg-derived cadence, 2×/2.5×/5×, `uptimeSecs`-reset, UNREACHABLE from bridge state, 1 s sweeper); per-device `republish-*` broadcast on start | **sibling TS lib only — zero ggcommons changes** | unit: pure FleetModel/staleness over a fake messaging service (the lib's fake pattern), no sleeps; integration: against the bridge's **dual-EMQX rig** (`uns-bridge/tests/e2e` compose) + a scaffolded TS skeleton publishing real keepalives; kill the bridge → assert UNREACHABLE via LWT |
| **C2 — WS gateway + protocol** | HTTP+WS server (`component.global.console`: port/bind/tls); scope subscribe → **snapshot-then-deltas** with sequence numbers; coalescing ≤ 4 Hz; per-socket backpressure; reconnect resync | C1 | protocol-level tests (mock socket): snapshot/delta ordering, coalesce, forced resync |
| **C3 — Edge-health UI (priority #1)** | Carbon/React shell + Overview grouped by hierarchy level (rollups, containment), Components tree, Component detail (state, freshness, `metric/sys` charts, bridge drop-counter charts); UNS-shaped routes | C2 | vitest component tests + a live demo against the C1 rig; **this closes priority #1 with zero new ggcommons code** |
| **G-S1 (ggcommons, parallel from C1 onward) — the `_bcast` republish listener** | 4-language: subscribe own `_bcast` inbox, jittered re-fire of state keepalive + cfg publisher; vectors/interop touch-up | ggcommons `feat/unified-namespace` | per-lang units under the 90 % gate; bridge e2e "disconnect/rehydrate" assertion flips from inert to green |
| **C4 — CommandGateway** | WS command frames → RBAC (3 roles) → append-audit-before-dispatch → `uns().topicFor` + `request()` (per-verb timeouts ≤ 30 s) → Events mirror; per-device broadcast button ("refresh fleet") | C1; useful against real verbs once S2 lands (`ping` first) | unit: gateway state machine vs fake bus; e2e: round-trip through the real bridge reply-rewrite (the P3‑6 D-assertion pattern) |
| **C5 — Config-review UI (priority #2)** | `cfg` cache + console-side redaction-at-ingest (second layer) + hash-based drift compare + schema-annotated view; "Refetch" = `republish-cfg` (per-device broadcast) | C2 + **G-S1** (for already-running components); Flow-B `get-configuration` (S2) upgrades per-component refetch later | e2e: change a skeleton's config → cfg re-announce → UI diff |
| **C6 — Events & metrics screens** | `evt` feed (containment, ack), generic metrics tables/charts | C2 | rig e2e incl. bridge `evt` replay after `docker pause` (bridge D-B10 pattern) |
| **C7 — FULL-SYSTEM TEST + deployment-validation gate** | The ecosystem proof the bridge README names as its own held item: CLI-scaffolded skeletons (all 4 languages, UNS rev) on a device broker + `uns-bridge` + site broker (ACL on, incl. the Q4 console stanza) + console; assert: fleet appears, staleness/UNREACHABLE transitions, config-review, command round-trip. Then the deployment matrix: HOST (dev box) → KUBERNETES (kind, single-replica + Ingress, M13) → GREENGRASS (lab-5950x; blocked on the bridge's IPC-primary follow-up — HOST-mode console against the lab's site broker in the interim) | C1–C6, G-S1 | scripted rig (bridge `run.sh` precedent), one command, printed per-assertion PASS/FAIL |
| *(Phase 2)* | Descriptor-panel renderer + PanelRegistry (needs S3 describe/get-panel-asset), sb/* screens (needs M9), Site Topology view, OIDC, config push (D7 flag) | S2/S3/M9 | — |

**First buildable slice: C1.** Its only dependency is the sibling TS lib as already shipped
on `feat/unified-namespace` — **nothing must land in ggcommons first.** G-S1 is the single
ggcommons work item to schedule in parallel (needed by C5 for full config-review value and
by the bridge to make its rehydration real; C1–C4 don't wait on it).

---

## 5. Open questions / decisions needing the user

| # | Question | Why it can't be resolved from docs+code |
|---|---|---|
| **Q1** | **Create `edgecommons/edge-console`** (git init the plain folder, GitHub repo, registry entry — `category: "console"`? platforms?) — the same org-action set as bridge D‑B6. Also: single repo with `server/`+`ui/`+`protocol/` workspaces (recommended, matches D6's shared-protocol note), or split repos? | Org/repo creation is a user action; the registry category is a naming call. |
| **Q2** | **Schedule G-S1** (the 4-language `_bcast` republish listener) now, as the console's one library prerequisite — and decide whether **S2** (minimal Flow-B verbs: `ping`, `reload-config`, Flow-B `get-configuration`) rides the same train or waits. The canonical plan defers both to "Phase 3 leftovers / components phase"; the console (and the bridge's inert rehydration) make S1 concretely urgent. | Sequencing/priority call across two workstreams (library vs console), and it re-opens a deliberately-deferred item. |
| **Q3** | **In-band cadence:** accept the console-side derivation (cadence from `cfg.heartbeat.intervalSecs`, restart from `uptimeSecs` reset — zero library change, recommended) or add `keepaliveSecs` (± `bootId`/`seq`) to the shipped `state` body (small 4-language change + golden-envelope vector regen)? | Changes a shipped, vector-pinned wire body; explicitly a user call per the no-divergence rule. |
| **Q4** | **Site-broker ACL principal for the console** (§3): add the hybrid stanza (consumer grants + publish under its own `ecv1/{device}/#`) to `deploy/site-broker/acl.conf`? Alternative (suppress the console's own observability) contradicts "the console is a standard component". | Security-posture change to a shipped deploy artifact. |
| **Q5** | **Tier 0 removal** (G9): confirm dropping the legacy-topic parser + the Tier-0 compliance tier from the console scope (pre-UNS components are invisible at the site broker anyway; rev-bump ⇒ Tier 1 free). | Removes a designed-in feature; cheap to keep only in the single-device edge case, but recommend deletion. |
| **Q6** | **Release-train sequencing:** console Phase 1 builds against the sibling `feat/unified-namespace` lib. When does the UNS core merge to `main` (unblocking the bridge's rev-pin + the console's pinned dep + component adoption/rev-bumps that make a real fleet visible)? C7's full-system test can run entirely on sibling/local pins before that, but the *deployment-validation gate* (GG lab, k8s with published images) wants published artifacts. | Merge timing is the user's call (Actions budget, review). |
| **Q7** | **GREENGRASS reach for Phase 1:** the bridge's IPC-primary variant is a held follow-up, so a GG device's traffic can't reach the site broker yet. Accept HOST+K8s as the Phase-1 console validation matrix (GG when the bridge variant lands), or pull the bridge's GG variant into scope alongside the console? | Scope/priority trade across repos. |

---

## Appendix — source-of-truth citations

- Shipped UNS core surface: `ggcommons/libs/ts/src/uns.ts` (Uns/UnsClass/UnsScope/guard
  predicate), `message.ts` (MessageIdentity), `heartbeat.ts` (state body
  `{status, uptimeSecs}`; `sys` metric), `config/effective_config.ts` (cfg publisher +
  redaction v1), `config/source/config_component.ts` (Flow A + `set-config` inbox),
  `messaging/service.ts` (request deadline, reserved guard, `publishReserved`),
  `messaging/standalone-provider.ts` + `messaging/config.ts` (LWT, retain-false).
- Decision registers: `ggcommons/docs/platform/UNS-CANONICAL-DESIGN.md` (D‑U1…D‑U27; §4.3
  Flow A/B + `_bcast`; §7 deferred-facade list), `DESIGN-uns.md` (§4 classes/wildcards, §9
  bridge + late-join, §11 mandates), `DESIGN-uns-bridge.md` (D‑B1…D‑B15; §2.2 relay matrix;
  §4.4 ACL).
- Bridge as-built: `uns-bridge/README.md` (three connections; relay/policy/reply/LWT
  behavior; P3-status table; "Remaining release-time items" incl. the inert
  `republish-*` broadcast and "edge-console as the first site-side client").
- Console design under reconciliation: `edge-console/docs/DESIGN.md` v0.3 (+
  `mockups-hifi.html` for G8).

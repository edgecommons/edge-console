# Edge Console — UI Gap / Delta Analysis

**Contract:** `docs/mockups-hifi.html` (the signed-off High-Fidelity Carbon prototype).
**Current build:** `ui/src/**`, `protocol/src/index.ts`, `server/src/**`.
**Purpose:** an honest, exhaustive map of where the implementation drifted from the approved
mockup, so we can realign deliberately. **Analysis only — no app code changed.**

> **Framing (corrected).** "Data plane" = the telemetry/business **signals** only — the UNS
> `data` class (the future **Signals** screen). **Everything else** a component publishes
> (`state`, `cfg`, `evt`, `metric`, `log`, and the `cmd` write path) is the
> **management/control plane**. The two are surfaced by different screens and must not be
> conflated; earlier drafts of this doc used "data plane" loosely for a component's whole
> substance — that misuse is corrected throughout below.

The single root cause running through almost every gap below: **the management/control plane
was under-built, and the (real) data plane was ingested then discarded**. The wire contract
(`ComponentSnapshot`) carries liveness + cadence + a raw last-known-value cache, and little
else about a component's *substance* (no CPU/mem/conn runtime attributes, no alarm state, no
capabilities) — that missing substance is management/control-plane. Meanwhile the actual data
plane (the `data`-class signals) flowed into the LKV cache and was thrown away by the UI (no
protocol surface exposed it). Every screen the mockup fills with that substance therefore had
to be dropped, reduced, or replaced with the one management-plane class that *was* rich and
already-flowing (`metric` telemetry) — hence the invented Metrics page.

> **R0 update.** The R0 foundation slice has since landed the missing plumbing: a server-side
> **SignalStore** (the data plane — `subscribe-signals`), an **AttributeStore** (runtime
> attributes projected off the `metric` class — `subscribe-attributes`), an **AlarmTracker**
> (console-side alarms with device-UNREACHABLE containment + ack — `subscribe-alarms`), the full
> identity `hier` now on the `component-discovered` delta (dynamic grouping without a snapshot),
> and the connection's RBAC role on a `welcome` handshake. The screens (R1-R6) consume these; the
> off-contract Metrics page was removed (its Sparkline mark kept as a shared `common/` component).

Legend for the **classification** column:

- **UI-only** — pure front-end; the data is already on the wire / in the stores.
- **needs-data-plumbing** — the server stores / protocol / FleetModel must carry more
  (data the bus *already delivers* but the console discards or never surfaces).
- **needs-component-emission** — components must publish something they don't today
  (CPU/mem, connection state, dependency endpoints, signal quality, capability manifests).
- **genuinely-later-phase** — depends on the deferred describe / panels / Signals-data
  workstreams that were explicitly staged out of Phase 1.

---

## 0. Screen inventory delta (approved vs built)

| # | Hi-Fi screen (side nav) | Current build | Status |
|---|---|---|---|
| 1 | **Overview** ("Edge health") — line-grouped, 9-col fleet, 4 specific tiles | `health/EdgeHealthView` — device-grouped, 8-col fleet, 4 different tiles | **PRESENT but materially reduced** |
| 2 | **Components** — Site→Line→Device→Component tree + detail summary | — | **ABSENT** |
| 3 | **Component Detail** (drill-in) — Health/Panel/Instances/Config/Events/Logs tabs | inline `CommandControls` in a fleet row only | **ABSENT** (only a command button strip survives) |
| 4 | **Site Topology** — layered SVG connectivity graph | — | **ABSENT** |
| 5 | **Configuration** — hierarchical structured view | `configreview/ConfigReviewView` — flat rows | **PRESENT but mislabeled "structured" (flat)** |
| 6 | **Events & Alerts** — severity/time/source/event/**state**/ack | `events/EventsView` — no state/ack, evt-only | **PRESENT but reduced** |
| 7 | **Signals** — data-plane browser (`data` class) | — | **ABSENT** |
| 8 | **Settings** — console policy + site-map editor | — | **ABSENT** |
| — | *(not in Hi-Fi)* | **`metrics/MetricsView`** — invented Metrics page | **EXTRA — unplanned** |

Nav shipped (`ui/src/App.tsx` line 36): `overview | config | events | metrics`.
Nav specified: `Overview · Components · Site Topology · Configuration · Events & Alerts ·
Signals · Settings`. **4 built (one of them extra) vs 7 approved → 4 approved screens
entirely absent, 1 extra shipped.**

---

## 1. Cross-cutting: the application bar (app shell chrome)

The mockup's header (`mockups-hifi.html` lines 251-259) is a full Carbon UI-shell bar. The
build ships only `<Header><HeaderName>` (App.tsx lines 51-56).

| Hi-Fi element | Current | Delta | Data the plane must carry | Classification |
|---|---|---|---|---|
| Burger / nav toggle | absent | no collapse affordance | none | **UI-only** |
| `EdgeCommons / Edge Console` name | present (`HeaderName`) | — parity | none | — |
| **Global search box** ("Search components, things, signals…") | **absent** | no cross-entity find; mockup lists this as one of the *four* paths to a component | client-side index over fleet (present) + signals (absent) | **UI-only** for components/things; signals part is **needs-data-plumbing** |
| **Theme (light/dark) toggle** (`◐`) | **absent** — theme hard-pinned `g100` (App.tsx line 50) | no light (g10) mode at all, though the mockup ships both palettes | none | **UI-only** |
| **Notifications indicator** (`🔔` + badge "2") | **absent** | no global alert count / dropdown | derivable from `fleetIssues` + events (present) | **UI-only** (data already computed in `fleet/selectors`) |
| **Account / user indicator** (`◍`) | **absent** | no identity/role surface, though RBAC roles exist server-side (`command/rbac.ts`) | connection's RBAC role (server-side, not yet sent to UI) | **needs-data-plumbing** (send the role on `hello`/snapshot) |

**Side-rail context** the mockup adds and the build omits:
- **Site context block** ("Site: dallas · Degraded") — **needs-data-plumbing**: the console
  has no explicit "site" identity (it infers devices from `hier`); a site-level rollup tag is
  UI-derivable once a site name is known.
- **"Lines" sub-nav group** (stamping / packaging / assembly) — **UI-only + identity
  convention**: `hier[]` is already on the wire (`WireIdentity.hier`), so line names are
  derivable *iff* components publish a line/area hier level (see §3).

---

## 2. Overview ("Edge health") — tiles + columns + grouping

### 2a. Summary tiles (the 4-up header)

Mockup tiles (lines 285-320): **Site health donut** · **Active alerts** · **Edge bus msgs/s** ·
**Edge node (console self)**.
Build tiles (`health/SummaryTiles.tsx`): **Fleet health donut** · **Needs attention** ·
**Devices** · **Live stream**.

| Hi-Fi tile | Current | Delta | Data the plane must carry | Classification |
|---|---|---|---|---|
| Site health donut (5/8 healthy, 4-way legend) | Fleet health donut (same idea) | near-parity; "site" vs whole-fleet framing only | counts (present) | **UI-only** |
| **Active alerts** — "1 critical · 1 warning · **+11 contained**" | "Needs attention" counts liveness buckets | build counts *staleness states*, not *alarms*; no crit/warn alarm severity, no "+N contained" | an **alarm state machine** (raise/clear + severity) — the deferred `events()` facade; containment count partially exists (`device-reachability-changed.componentCount`) | **needs-data-plumbing** (alarm state); containment rollup partly present |
| **Edge bus msgs/s** (throughput + sparkline, "MQTT · EMQX @ gateway") | **absent** | no bus-throughput tile at all | a message-rate metric — derivable from `value-updated` delta rate (UI-side) OR a real broker stat | **needs-data-plumbing** (server can count deltas/sec; a true broker metric is component/broker emission) |
| **Edge node** (console self: host, cpu 4%, mem 180 MB, up 6d) | "Live stream" (WS status + last-update age) | build shows the *socket*, not the *console process health* | the console's own process metrics (cpu/mem/uptime) + platform | **needs-data-plumbing** (server emits its own self-health; trivially available in-process) |

Also absent: the two **inline notes** are present in spirit (`IssueNotifications`) but the
mockup's second note demonstrates **containment framing** ("the road is down, not the houses …
11 would-be OFFLINE alarms suppressed under this one") — the build's issue list renders
UNREACHABLE devices but does not compute/show the *suppressed-alarm count*. **needs-data-plumbing**
(the `componentCount` on the reachability delta is the raw material; the "+11 contained" copy is not assembled).

### 2b. Fleet table — 9 Hi-Fi columns vs 8 built

Mockup columns (line 332): **Health · Component · Device · Heartbeat · CPU · Memory · Conn ·
Capabilities · ⋯(overflow)**.
Build columns (`health/FleetTable.tsx` line 43): **Health · Component · Device · Last state ·
Uptime · Keepalive · Restarts · Controls**.

| Hi-Fi column | Current | Delta | Data the plane must carry | Classification |
|---|---|---|---|---|
| Health (status tag) | Health | parity | `liveness` (present) | **UI-only** |
| Component (+ lang tag `java`/`python`/`rust`) | Component (+ non-`main` instance tag) | **language/type tag missing** | component `type`/`lang` (not on wire; part of a capability/identity descriptor) | **needs-component-emission** (or config-map) |
| Device | Device | parity | `key.device` (present) | **UI-only** |
| **Heartbeat** (age, e.g. "2s", red when overdue) | **Last state** (same value, different header) | cosmetic header rename; value is equivalent | `lastStateAt` (present) | **UI-only** |
| **CPU** (sparkline + %) | **absent** (build shows Uptime instead) | no per-component CPU | CPU% in the `state` body (components don't emit it; FleetModel only reads `status`+`uptimeSecs`) | **needs-component-emission** |
| **Memory** (MB) | **absent** (build shows Keepalive) | no per-component memory | mem in the `state` body | **needs-component-emission** |
| **Conn** (connection-state chip) | **absent** (build shows Restarts) | no southbound connection indicator | `connectionState` / `readErrors` in the `state` body | **needs-component-emission** |
| **Capabilities** (glyphs ♥ ▤ ⌘ ▦) | **absent** | no capability summary | a **capability manifest** (`describe`) | **genuinely-later-phase** |
| ⋯ overflow menu | **Controls** expander (Ping/Reload/etc.) | build's is a command strip, not a row menu; broadly serves the same slot | commands (present) | **UI-only** |

**Net:** of the 4 substance columns the mockup adds (CPU, Memory, Conn, Capabilities), the
build carries **none** — it substituted operational-liveness columns (Uptime, Keepalive,
Restarts) that the plane *does* have. Three of the four are **needs-component-emission**
(CPU/Mem/Conn ride the `state` body); Capabilities is **genuinely-later-phase**.

### 2c. Grouping — line vs device

| Hi-Fi | Current | Delta | Data | Classification |
|---|---|---|---|---|
| Fleet **grouped by line** (group rows "LINE · stamping", rollup tag, "3 components · press-gw-01 (Greengrass)") | **grouped by device** (`FleetTable` `DeviceGroup`; header literally says "grouped by device", EdgeHealthView line 131) | one grouping level too shallow — no line tier | `hier[]` is on the wire; a line is the hier level above device. Grouping is UI logic **iff** components publish a line/area hier level (today most set only `{device}`) | **UI-only + identity convention** (needs-component-emission only to *guarantee* the line level exists) |
| Table toolbar: search · **Line ▾** · **Status ▾** · **⊞ Tiles** | none | no fleet search/filter/tiles-toggle | fleet (present) | **UI-only** |

---

## 3. Components screen (tree browser + component summary)

Mockup (lines 348-387): a 320px **Site → Line → Device → Component tree** (filterable by
status/type/platform) beside a component-summary panel (CPU/Memory/Heartbeat/Open-alerts
tiles, Ping / Query status / Open detail). **Entirely absent** in the build.

| Hi-Fi element | Current | Delta | Data the plane must carry | Classification |
|---|---|---|---|---|
| Hierarchical tree (Site/Line/Device/Component) with health dots | absent | no inventory finder; only the flat device-grouped Overview table | `hier[]` + `liveness` (present) — tree is derivable | **UI-only** (assuming line hier level; else identity convention) |
| Tree filters: status / type / platform | absent | — | status (present); type/platform (**not on wire**) | **needs-component-emission** (type/platform) |
| Component summary tiles: CPU / Memory / Heartbeat / Open alerts | absent | — | CPU/Mem (state body — absent); alerts (alarm state — deferred) | **needs-component-emission** + **needs-data-plumbing** |
| "Pick a line/device → roster beneath it" | absent | no rollup roster view | hier rollups (present) | **UI-only** |

---

## 4. Component Detail (drill-in) — the richest missing surface

Mockup (lines 390-469): a full detail screen with tabs **Health · Panel (4 views) ·
Instances · Configuration · Events · Logs**, a write modal, and the OPC-UA panel's
**Address Space / Signals / Diagnostics** subtabs bound to `cmd/sb.browse` / `cmd/sb.read` /
`cmd/sb.write`. The build has **no detail screen** — only the inline `CommandControls` strip
(Ping / Get configuration / Reload config / Send command…) that appears when a fleet row is
expanded.

| Hi-Fi tab / element | Current | Delta | Data the plane must carry | Classification |
|---|---|---|---|---|
| **Health** tab: CPU & Memory live charts, Threads/FDs, Uptime, **Liveness timeline** (heartbeat arrivals, gap shading), health-checks list (connectionState, readErrors, ready) | inline strip only; no detail | uptime (present); everything else (cpu/mem/threads/fds/connState/readErrors) not surfaced | those fields in the `state` body + a retained heartbeat-arrival history | **needs-component-emission** (cpu/mem/threads/conn) + **needs-data-plumbing** (arrival-history series; FleetModel keeps only `lastStateAt`) |
| **Panel · 4 views** (descriptor-driven; Overview/Address Space/Signals/Diagnostics) | absent | no dynamic panel slot | the **HYBRID descriptor-first panel** system: `describe` manifest, `GetPanelAsset`, signed WebComponents | **genuinely-later-phase** |
| Panel treeBrowser bound to `cmd/sb.browse`; Selection read via `cmd/sb.read`; **Write modal** via `cmd/sb.write` (verify + read-back + typed confirm) | absent (generic `invoke-command` exists, but no `sb.*` verbs, no browse tree, no write-verify modal) | no southbound browse/read/write UX | `sb.browse` / `sb.read` / `sb.write` command verbs on the adapters | **genuinely-later-phase** (adapters must expose the `sb.*` verb family) |
| **Instances** tab (per-instance status) | absent | `instance` is on the key, but no per-instance roster | `component.instances[]` (config carries it; not modeled as state) | **needs-data-plumbing** |
| **Configuration** tab (embedded read-only cfg) | the separate Config screen exists | reachable as its own screen, not embedded in a detail | cfg (present) | **UI-only** |
| **Events** tab (filtered to this component) | Events screen filters by component | exists globally, not as a detail tab | evt (present) | **UI-only** |
| **Logs** tab (`cmd/get-log-tail`, live-follow, level dropdown w/ TTL) | absent | no log surface at all | a `get-log-tail` command verb + log streaming | **needs-component-emission** (+ later-phase for live-follow/TTL) |

---

## 5. Site Topology — absent

Mockup (lines 472-560): a deterministic layered **SVG connectivity graph** — cloud
(northbound targets: AWS IoT Core, Kinesis) at top, site bus (EMQX) below, processors, then
adapters, then field (southbound targets: KEPServerEX, Press PLC, Packager OPC UA, Conveyor
drive) at the bottom; edges colored by dependency state (green/warn/red-dashed-✕) with
throughput labels ("OPC UA · 41 sig/s"), the fault pinned to the exact edge. **Entirely absent.**

| Hi-Fi element | Current | Delta | Data the plane must carry | Classification |
|---|---|---|---|---|
| Component nodes + health | absent | — | liveness (present) — nodes are drawable | **UI-only** for the component tier |
| **Southbound edges to field devices** (from `state.dependencies[]`) with connection state | absent | no dependency data exists | `state.dependencies[]` — each southbound endpoint + its connection state + throughput. **Components do not publish this today** (mockup callout explicitly cites `state.dependencies[]`, line 559) | **needs-component-emission** |
| **Northbound edges to cloud** (IoT Core / Kinesis) | absent | — | streaming/northbound targets (in cfg's `streaming`, not surfaced as topology data) | **needs-data-plumbing** (derive from cfg) |
| Per-edge throughput ("N sig/s") | absent | — | signal-rate per dependency | **needs-component-emission** |
| Field/cloud external nodes | absent | — | dependency + streaming config | **needs-component-emission** + **needs-data-plumbing** |

**Correction (R0 framing).** Site Topology is **identity + cfg-driven, NOT `dependencies[]`-blocked**,
and it is a **management/control-plane** screen (not data-plane). The node tier and its layered
grouping come from the identity `hier` — computed **dynamically** from `hierarchy.levels` (site /
area / line / device, never a hardcoded "line") — and the southbound/northbound endpoints are
already present in each component's **`cfg`** (the adapter `endpoint`/`slave` blocks, the processor
`streams` targets — the same live cfg the Configuration screen shows). A first Topology can
therefore be drawn from identity + cfg **today**; `state.dependencies[]` — or the
`southbound_health` connection state that R0 now surfaces as a runtime **attribute** — only
enriches the EDGES with live connection state + per-edge throughput. So this screen is *deferred by
richness*, not *blocked by data*: the node/edge skeleton is buildable now.

---

## 6. Configuration — the mislabeled "structured" view

Mockup (lines 562-601): a component picker with **LIVE / SOURCE / UNAVAIL** provenance, a
**source badge** ("source: CONFIGMAP"), a **hot-reload mode** badge, a "newer config pushed"
note, a redaction note, **Structured / Raw** tabs, and **Refetch / Reload config / Compare⇄**
actions. Critically the **Structured tab is genuinely hierarchical** — grouped nested rows
with `schema ⓘ` annotations, a nested `component.instances[ ]` "2 instances ▸" expander, a
`streaming` static section, and a `configHash … drift ✓` row.

The build (`configreview/ConfigReviewView.tsx`) renders a picker (LIVE / UNAVAIL only) and a
**flat** structured tab: `flattenConfig()` dotted-path rows (e.g. `messaging.local.host`).

| Hi-Fi element | Current | Delta | Data the plane must carry | Classification |
|---|---|---|---|---|
| "Structured" = **hierarchical/grouped** rows, nested `instances[] ▸`, sections | **flat** dotted-path key/value rows | the headline mislabel — it says structured but is a flattened map | cfg body (present, nested already) | **UI-only** (render the tree instead of flattening) |
| `schema ⓘ` per-key annotations, "(default)" markers | absent | no schema provenance | the config **schema** + which values are defaults | **needs-data-plumbing** (schema not on the wire) |
| Source badge **CONFIGMAP / SHADOW / FILE** + **hot-reload mode** | absent | no source provenance | cfg **source/provider + reload strategy** (not in the cfg envelope) | **needs-data-plumbing** (component must stamp provenance, or gateway infers) |
| Picker **SOURCE** state (config known from source but component not live) | only LIVE / UNAVAIL | no third "source" state | a source-of-truth cfg fetch path distinct from the live push | **needs-data-plumbing** |
| **configHash + drift ✓** row | absent | no drift detection | a config hash on the cfg envelope | **needs-data-plumbing** |
| "Newer configuration pushed 12s ago" note | absent | build replaces silently on new push | already have push timing | **UI-only** |
| **Compare ⇄** (diff two configs) | absent | no diff | two cfg bodies (present once fetched) | **UI-only** |
| Refetch / Reload config | Refresh (republish-cfg) present | partial — Refresh exists; explicit Reload-config is the `reload-config` verb (available in CommandControls) | present | **UI-only** (wire the button to the existing verb) |
| Raw JSON tab, redaction honesty | present + faithful | parity (this part is well done) | cfg (present) | **UI-only** |

---

## 7. Events & Alerts — reduced to an evt feed

Mockup (lines 603-621): title **"Events & alerts"**, three tiles (Active alarms / Events per
min / Noisiest), and a table **Severity · Time · Source · Event · State · (action)** that
mixes **alarms** (Critical, with Ack), **containment** ("+11 contained"), **operator audit**
rows ("operator: marc · Wrote 42.5 to … Setpoint", State=Audit), and **auto-resolved** rows.

The build (`events/EventsView.tsx`) titles it **"Events"**, has the three tiles, and a table
**Severity · Time · Source · Event · (expand)** — the live `evt` class only.

| Hi-Fi element | Current | Delta | Data the plane must carry | Classification |
|---|---|---|---|---|
| Title "Events & **alerts**" | "Events" | scope narrowed to component events | — | **UI-only** (rename once alarms land) |
| Three summary tiles | present (Recent / per-min / Noisiest) | parity | evt (present) | **UI-only** |
| **State** column (Active / Audit / Auto / Resolved) + **Ack** action | absent | no alarm lifecycle | an **alarm state machine** (raise/clear/ack) — the deferred `events()` facade | **needs-data-plumbing** (alarm state) |
| **Active alarms** tile ("1 crit · 1 warn · +11 contained") | shows recent-event counts, not alarms | same alarm-vs-event conflation as Overview | alarm state + containment | **needs-data-plumbing** |
| **Operator audit** rows ("Wrote 42.5 to Setpoint") | absent | writes are audited server-side (`command/*`, DESIGN §"append audit … before dispatch") but not surfaced as events | the CommandGateway must **publish its audit trail** to an evt-like console surface | **needs-data-plumbing** |
| evt feed, severity classify, expand-for-detail | present + faithful | parity (well done) | evt (present) | **UI-only** |

---

## 8. Signals — absent (and the data is already arriving, unused)

Mockup (lines 623-631): a **data-plane browser** over the UNS `data` class on southbound —
table **Signal · Latest · Quality (GOOD/UNCERTAIN/BAD) · Age · Read**. **Absent** in the build.

Notably: `BusIngress` **already subscribes the `data` class** (it subscribes all six consumer
classes) and the FleetModel **already caches** every `data` value in `ComponentSnapshot.values[]`
(keyed `data/{channel}`, with `receivedAt` age). So the raw material is flowing into the LKV
cache and being **thrown away by the UI** — no protocol surface exposes it and no view reads it.

| Hi-Fi element | Current | Delta | Data the plane must carry | Classification |
|---|---|---|---|---|
| Signal rows (device/signal, latest value) | absent | `data` values cached but never surfaced | a **data-plane snapshot/subscribe** protocol surface (the `values[]` `data` entries are already there — needs a typed projection + WS frames, like C6 did for metrics) | **needs-data-plumbing** (server-side plumbing exists in the cache; expose it) |
| **Quality** (GOOD / UNCERTAIN / BAD) | absent | `data` body may not carry quality | quality in the `data` body per the `SouthboundSignalUpdate` contract | **needs-component-emission** (adapters must stamp quality) |
| Age | absent | `receivedAt` present in cache | present | **UI-only** once surfaced |
| **Read** (on-demand `sb.read`) | absent | no southbound read verb | `sb.read` command verb | **genuinely-later-phase** |

This is the screen the **Metrics page effectively displaced** — see §10.

---

## 9. Settings — absent

Mockup (lines 632-642): console-policy list — **Site-map (thing → line) editor**, staleness
thresholds, **Panel trust policy** (signedOnly), redaction rules, global read-only mode.
**Absent.**

| Hi-Fi element | Current | Delta | Data the plane must carry | Classification |
|---|---|---|---|---|
| Staleness thresholds display | absent | values exist (`FleetModelOptions`, `console-config.ts`) but no UI | present (console config) | **UI-only** (read-only display) |
| Redaction rules, panel trust, read-only mode | absent | policies exist server-side | present (console config) | **UI-only** (read-only display) |
| **Site-map editor** (thing → line) | absent | the mechanism that would let the console *assign* a line to a device when identity lacks a line level | server-persisted site-map | **needs-data-plumbing** (persist + apply an override map) — this is the pragmatic alternative to §2c's identity convention |
| Editing / hot-apply of any policy | absent | display is read-only at best | write path to console config | **needs-data-plumbing** |

---

## 10. The extra Metrics page (not in the Hi-Fi)

`ui/src/metrics/MetricsView.tsx` + the whole `metric` C6 slice ship a **Metrics** nav item and
screen that **the Hi-Fi does not contain**. Its own header comment concedes this: *"The
signed-off hi-fi has no dedicated metrics screen (its 'Signals' screen is the `data`-plane
browser, Phase 2)."*

- **What it is:** one row per `(component, metric, measure)` — Latest value + a trend
  sparkline, filterable by component. Genuinely useful, genuinely live.
- **Why it exists:** metrics were the one *rich, structured, already-flowing* **management-plane**
  class (EMF
  bodies on the `metric` class), so it was the path of least resistance — build a page for the
  data you have, rather than plumb the data the mockup needs. It is the mirror image of the
  Signals gap in §8.
- **Its dependency problem:** it only shows anything if components run with
  `metricEmission.target: "messaging"`. The **template default is `"log"`**
  (`docs/FULL-SYSTEM-TEST.md` line 47: *"template default is 'log' → no [metrics on the bus]"*),
  so out of the box this page is **empty** — you must reconfigure every component to publish
  metrics onto the bus, which is not a realistic standing posture for an edge fleet (it puts
  full-rate telemetry on the control bus).

Classification: **EXTRA / unplanned.** Decision required (see D1).

---

## 11. Consolidated plane gaps (the crux)

Everything above collapses to this list — **what the wire/stores must carry** for a faithful
Hi-Fi. Ordered by how many screens each unblocks. **Only item 4 is the true data plane** (the
`data` class / Signals); items 1, 3, 6, 8, 10 are **management/control-plane** plumbing and items
2, 7, 9 are component-emission — none of those are "the data plane" despite earlier loose wording.

1. **Component runtime attributes on `state`** — CPU%, memory, threads/FDs, `connectionState`,
   `readErrors`. **`needs-component-emission`** (the four libraries must add these to the
   `state` body) **+ `needs-data-plumbing`** (FleetModel.applyState reads only `status` +
   `uptimeSecs` today — it must project the richer body into typed `ComponentSnapshot` fields).
   *Unblocks:* Overview CPU/Mem/Conn columns, Components summary tiles, Detail Health tab.
2. **`state.dependencies[]`** — each southbound endpoint + connection state + throughput, and
   the northbound targets. **`needs-component-emission`.** *Unblocks:* the entire Site Topology
   screen, the Conn column, per-edge sig/s.
3. **Alarm state machine** (raise / clear / severity / ack / containment count) — the deferred
   `events()` facade. **`needs-data-plumbing`.** *Unblocks:* Overview "Active alerts" tile,
   Events **State/Ack** columns, the honest crit/warn/contained counts.
4. **Data-plane (`data` class) projection + WS surface** — the values are *already cached* in
   `ComponentSnapshot.values[]`; they need a typed snapshot/subscribe protocol family (mirror
   the C6 metric slice). **`needs-data-plumbing`** for the plumbing; **`needs-component-emission`**
   for signal **quality**. *Unblocks:* the Signals screen (and retires the Metrics displacement).
5. **Line/area identity level** — either components publish a line hier level (identity
   convention) **or** the console keeps a site-map override (`needs-data-plumbing`, per §9).
   *Unblocks:* line grouping (Overview, Components tree, Topology), the "Lines" sub-nav.
6. **Cfg provenance + schema + hash** — source (CONFIGMAP/SHADOW/FILE), hot-reload mode,
   `configHash`, and schema annotations on the cfg envelope. **`needs-data-plumbing`.**
   *Unblocks:* the Configuration screen's provenance badges, drift, schema ⓘ.
7. **Component type/language/platform descriptor** — for the lang tag + tree filters.
   **`needs-component-emission`** (small; or a static registry map).
8. **Console self-health + bus throughput** — the console's own cpu/mem/uptime and a msgs/s
   rate. **`needs-data-plumbing`** (in-process on the server; the bus rate is derivable from the
   delta stream). *Unblocks:* the two missing Overview tiles.
9. **Capability manifest / `describe` + panels + `sb.*`/`get-log-tail` verbs** —
   **`genuinely-later-phase`.** *Unblocks:* Capabilities column, the Panel tab (Address Space /
   Signals / Diagnostics), Logs tab, southbound browse/read/write.
10. **RBAC role to the UI** — send the connection's role on connect. **`needs-data-plumbing`.**
    *Unblocks:* the app-bar account indicator + read-only affordances.

---

## 12. Prioritized decision list (for the interactive walkthrough)

Each is a concrete choice, framed with a recommendation + its cost/dependency, but left open.

**D1. The Metrics page — remove / fold into Signals / keep?**
*Recommendation:* **fold** — re-cast it as (or retire it in favor of) the approved **Signals**
screen, since both browse a live per-key value stream and Signals is the one the contract
names. Keep the metric *slice* server-side (it's real, tested C6 code) but stop shipping a
nav item the mockup doesn't have. *Cost:* low (UI rename + point it at `data`); *dependency:*
needs the `data`-plane WS surface (item 11.4) to be a true Signals page. Keeping Metrics as-is
means shipping an off-contract screen that is empty by default (11.10 default = `log`).

**D2. Overview columns — which of the Hi-Fi 9 do we source now vs defer?**
*Recommendation:* ship **Health/Component/Device/Heartbeat** now (all UI-only), show
**CPU/Memory/Conn** as "—/n-a" placeholders until 11.1 emission lands, and defer
**Capabilities** to the panel/describe phase. *Cost:* the placeholders are honest but visibly
empty; *dependency:* CPU/Mem/Conn = component emission (11.1), the biggest single unblock.
Alternative: keep the current Uptime/Keepalive/Restarts columns as *interim substance* and add
the Hi-Fi four incrementally.

**D3. Grouping — add the line tier now (identity convention) or via a Settings site-map?**
*Recommendation:* do **both, staged** — derive lines from `hier[]` now (UI-only) and add the
Settings site-map override (11.5) as the fallback for devices whose identity carries no line
level. *Cost:* UI grouping is cheap; the site-map editor is a small server-persistence feature.
*Dependency:* none blocking for the derive-from-hier path.

**D4. Site Topology — build now (component tier only) or wait for `state.dependencies[]`?**
*Recommendation:* **wait** — the screen's whole point is the dependency/throughput edges, and a
topology with no southbound edges is a worse device list. Sequence it right after 11.2.
*Cost:* deferring a marquee screen; *dependency:* `state.dependencies[]` emission (11.2) is a
four-language library change.

**D5. Structured config — fix the flat→hierarchical render now, provenance later?**
*Recommendation:* **yes, now** — the hierarchical render is UI-only over data we already have,
and it fixes the most visible mislabel (a "Structured" tab that isn't). Defer source badges,
schema ⓘ, and configHash/drift to 11.6. *Cost:* low for the tree; the provenance items each
need a cfg-envelope addition.

**D6. Events — add alarm State/Ack now or keep it an evt feed?**
*Recommendation:* **keep evt-only until the alarm state machine (11.3) exists** — Ack/State
columns with no lifecycle behind them would be dead UI (the build's own stated principle: "no
dead navigation / no dead UI"). Rename the screen to "Events & alerts" only when alarms land.
Meanwhile, **do** surface operator-audit rows once the CommandGateway publishes its audit trail
(a smaller slice of 11.3). *Cost:* the Overview/Events "alerts" story stays liveness-only for now.

**D7. Component Detail — build the shell now (Health/Config/Events/Instances) or wait for panels?**
*Recommendation:* **build the non-panel shell now** — a real detail route with the Health tab
(uptime/liveness timeline from data we have), embedded Config, filtered Events, and an
Instances list gives the four "reach a component" paths their destination. Gate the **Panel**
and **Logs** tabs behind the describe/`sb.*` phase (11.9). *Cost:* medium; *dependency:* none
blocking for the shell; cpu/mem charts show placeholders until 11.1.

**D8. Components tree screen — ship now?**
*Recommendation:* **yes** — it's UI-only over `hier[]`+liveness and it's one of the four
canonical paths to a component. Type/platform filters degrade to status-only until 11.7.
*Cost:* low.

**D9. App-bar chrome — theme toggle, search, notifications, account: which now?**
*Recommendation:* ship **theme toggle** and **notifications** now (both UI-only over existing
data), ship **search** scoped to components/things now (add signals when 11.4 lands), and gate
the **account indicator** on the RBAC-role plumbing (11.10). *Cost:* low; high polish-per-effort.

**D10. Settings screen — read-only policy view now, editors later?**
*Recommendation:* ship a **read-only** Settings view now (all the policy values already exist
server-side, UI-only) and stage the site-map + policy editors (11.5) behind server write paths.
*Cost:* low for read-only.

**D11. Console self-health + bus-throughput tiles — add now?**
*Recommendation:* **yes** — both are cheap server-side (in-process metrics; delta-rate counter)
and they restore two of the four Overview tiles the mockup specifies. *Cost:* low
(`needs-data-plumbing` but all in the console's own process).

**D12. Sequencing — what's the critical path?**
*Recommendation:* the single highest-leverage investment is **11.1 (state runtime attributes)**
and **11.2 (state.dependencies[])** — the two component-emission items that between them unblock
CPU/Mem/Conn columns, the Detail Health tab, the Components summary, *and* enrich the Topology
screen's edges. Everything else is UI-only or console-local plumbing that can proceed in parallel.
The under-built **management/control plane** (plus the discarded data plane) is the root cause;
R0 landed the console-local plumbing, and these two emissions are the remaining component-side fix.

---

*End of analysis. No application code was modified in producing this document.*

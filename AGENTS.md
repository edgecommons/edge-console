# edge-console — component notes

EdgeCommons **console** component — category `console`, not a southbound adapter. If this repo
lives inside the EdgeCommons org umbrella workspace, read its root `AGENTS.md` first (org repo
map, design-fidelity contract, validation matrix, platform/transport model); everything below is
this component's own detail.

## What it is

The site's **sole browser↔bus bridge**: browsers speak HTTP + WebSocket to the console; only the
console speaks MQTT/the Unified Namespace (UNS). It attaches to **one** connection — the site
broker — subscribes the six consumer-class wildcards
(`ecv1/+/+/+/{state,cfg,evt,metric,data,log}[/...]`), and needs zero per-component knowledge to
render the whole fleet: edge health, config review, events/alarms, metrics, per-component logs,
signals, and an RBAC-gated command write path.

## Workspace layout

| Package | Language | What it is |
|---|---|---|
| `gateway/` | Rust (Cargo workspace member) | The runtime — a standard edgecommons component (`com.mbreissi.edgecommons.EdgeConsole`, binary `edge-console-gateway`) owning the bus ingress, the in-memory fleet model, the command/descriptor gateway, `/ws`, `/healthz`, and static `ui/dist` serving. |
| `ui/` | TypeScript (npm workspace, `@edgecommons/edge-console-ui`) | The IBM Carbon/React front end (Vite). |
| `protocol/` | TypeScript (npm workspace, `@edgecommons/edge-console-protocol`) | Shared types for the browser↔gateway WebSocket contract — the hard boundary between `gateway/` and `ui/`. |
| `test-configs/` | — | Runnable sample configs (`component.global.console.*`). |
| `docs/` | — | Diátaxis docs synced to the docs site, plus `docs/design/DESIGN.md` and the mockups. |

## Design authority

`docs/design/DESIGN.md` is the authoritative design specification (site model, architecture,
screens, security, compliance tiers, the core-lib mandates, open decisions) — read it before
changing console behavior. This file only orients an agent to the repo's shape and conventions; it
does not restate the design.

## Config location

The console's own knobs live under `component.global.console` (a permissive subtree) in the
EdgeCommons config document; the sibling sections (`messaging`, `hierarchy`, `identity`,
`logging`, `heartbeat`, `metricEmission`, `tags`, `topic`) are the standard `edgecommons` envelope,
owned by the canonical schema and not redeclared here. See
`docs/reference/configuration.md` for every option and `test-configs/` for a runnable example.

## Validation expectations

- `cargo test` (gateway) and `npm test` (protocol + ui) must stay green; `.github/workflows/ci.yml`
  builds protocol → ui → gateway.
- `ui/vitest.config.ts` already configures 90% statement/line coverage thresholds; enforcing that
  gate in CI, and adding the matching Rust/`protocol` gates, is tracked as deferred code work below.
- Docs are Diátaxis `.md`, no frontmatter, synced to the docs site by
  `core/website/scripts/sync-component-docs.mjs`; keep them present-tense, current-state only.

## Baseline-adoption status (issue #4)

This repo tracks the org-wide "Adopt the CLI-scaffold-parity component baseline" as
`edgecommons/edge-console#4`. The console is category `console`, so only the cross-cutting baseline
items apply — no `sb/*` command surface, `southbound_health` metric, panel *registration*, or
device seam (the console is the *consumer* of the adapter panel trio, not a producer of one; that
compatibility is already met per the issue).

**Landed now** (docs/governance only, `feat/baseline-adoption`): this file, `CLAUDE.md`,
`.github/workflows/deploy-docs.yml`, and `docs/reference/metrics.md`.

**Deliberately deferred**, pending the user's active `feat/gemba` branch landing on `main` (its
single commit mixes a breaking UNS topic adoption with unfinished work that cannot be cherry-picked
apart; touching `gateway/Cargo.toml`, CI, or `.gitignore` now would collide with it at rebase
time) — to be run as this repo's own baseline leg on a clean `main` once gemba merges:

- Gateway core dependency: git `rev=` pin + gitignored `.cargo/config.toml` `[patch]` sibling
  override, replacing the floating path dependency (issue P0-1).
- Commit `package-lock.json` and switch CI to `npm ci` (P0-2).
- ~~`config.schema.json` modelling `component.global.console.*` (P0-3).~~ **Done** — the schema
  ships at the repo root (`config.schema.json`), grounded in `ConsoleConfig::from_global` and
  validated against both `test-configs/`. It declares no `#/$defs/instance`: the console runs one
  per node and reads no `component.instances[]`.
- Enforce the 90% coverage gate in CI for all three packages — `npm run coverage` (ui), a new
  vitest coverage config (`protocol`), and `cargo llvm-cov --fail-under-lines 90` (gateway) (P1-4).
- Adopt the org reusable CI shape (`component-ci.yml`) alongside the bespoke dual-toolchain job, or
  record the divergence if the reusable workflow can't express it (P1-5).
- Panel-trio fixture test pinning the adapter templates' `overview`/`signals`/`diagnostics`
  describe-manifest rendering (P2-9).
- License metadata reconciliation to BUSL-1.1 across every manifest (tracked separately as issue
  #3; `Cargo.toml`/`package.json` are left untouched by the docs-only slice).
- `ui/package.json`'s stale slice-history `description` → present-tense rewrite (P2-11) — left
  alone now because `package.json` is a likely `feat/gemba` collision point, not because it's out
  of scope.

## Org conventions this repo follows

- Kebab naming already met: repo `edge-console`, crate/bin `edge-console-gateway`, npm packages
  `@edgecommons/edge-console-ui` / `@edgecommons/edge-console-protocol`. The Greengrass component
  name (`com.mbreissi.edgecommons.EdgeConsole`) stays PascalCase reverse-DNS, per convention.
- Builders/facades are the construction path (`uns()`, `messaging()`, `commands()`) — never a
  hand-assembled topic string, on either the consume or the publish side.
- The console never publishes to the reserved `state`/`cfg`/`metric`/`log` classes itself except
  through the library's own heartbeat/config machinery (it is a component too); its own writes are
  the `_bcast` republish broadcasts and per-component `cmd` requests.
- Runtime artifacts (vaults, parameter caches, generated streams, TLS certs, logs, build output,
  local broker state) stay out of Git.

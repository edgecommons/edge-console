# Phase 3 Descriptor-Driven Component Panels

Status: implementation design
Date: 2026-07-08

## Goal

Components must be able to advertise their own component-detail panel views over the EdgeCommons
command bus. The console discovers those views dynamically through `cmd/describe` and renders them
inside the existing component detail Panel area. The console must not fabricate component-specific
tabs. Unsupported verbs stay visibly unavailable.

This design implements the descriptor path from the signed-off console design:

- Component Detail has a single top-level **Panel** tab.
- The Panel tab contains component-provided sub-tabs such as **Overview**, **Address Space**,
  **Signals**, and **Diagnostics**.
- Descriptor panels use console-owned widgets such as `summary`, `commandSummary`, `treeBrowser`,
  `keyValueList`, and `signalGrid`.
- Rich southbound control binds to advertised `cmd/sb/*` verbs, especially `sb/browse`, `sb/read`,
  and `sb/write`.

## Core Library Contract

The core library owns the discovery plumbing because every component should expose the same
describe surface in Java, Python, Rust, and TypeScript.

### Built-in Verb

Add a built-in `describe` command to every `CommandInbox`.

`describe` replies with the normal command body. The result shape is:

```json
{
  "ok": true,
  "result": {
    "schemaVersion": "edgecommons.component.describe.v1",
    "component": {
      "hier": [{ "level": "device", "value": "gw-01" }],
      "path": "gw-01",
      "component": "opcua-adapter",
      "instance": "main"
    },
    "digest": "sha256:...",
    "commands": [
      { "verb": "ping", "builtIn": true },
      { "verb": "describe", "builtIn": true },
      { "verb": "get-configuration", "builtIn": true },
      { "verb": "reload-config", "builtIn": true },
      { "verb": "sb/browse", "builtIn": false }
    ],
    "panels": {
      "schemaVersion": "edgecommons.panels.v2",
      "provider": "opcua-adapter",
      "renderer": "descriptor",
      "defaultView": "overview",
      "views": []
    }
  }
}
```

The `commands` list is computed at request time from the registered command handlers and sorted
lexicographically for deterministic discovery. The verb list is the source of capability truth for
the console. If a verb is absent, UI bound to that verb must render unavailable and must not invoke
it.

The `digest` is computed over the command capability list and panel descriptor payload. It is not
security-critical in this slice; it exists so the console can cache and refresh manifests without
confusing stale views for current component truth. The digest is computed over deterministic JSON
for `{commands, panels}`. `defaultView` is omitted when no panel views exist.

### Panel Registration API

Add a parity API to `CommandInbox`:

- Java: `registerPanel(JsonObject panel)` / `panels()`
- Python: `register_panel(panel: Mapping[str, Any])` / `panels()`
- Rust: `register_panel(panel: serde_json::Value) -> Result<()>` / `panels()`
- TypeScript: `registerPanel(panel: Record<string, unknown>): void` / `panels(): Record<string, unknown>[]`

Validation is intentionally small and identical:

- Panel must be a JSON object.
- `id` must be a non-empty string.
- `title` must be a non-empty string.
- Duplicate `id` is rejected.

Everything else in the descriptor is additive and console-interpreted. The core library is a
carrier and discovery registrar, not a UI renderer.

## Panel Descriptor Shape

Each registered panel is a view descriptor. Core stores these view descriptors under
`panels.views[]`:

```json
{
  "id": "address-space",
  "title": "Address Space",
  "order": 20,
  "scope": "instance",
  "requiresRole": "viewer",
  "widgets": [
    {
      "kind": "treeBrowser",
      "id": "address-space-tree",
      "title": "Address space",
      "browseVerb": "sb/browse",
      "readVerb": "sb/read",
      "writeVerb": "sb/write",
      "root": { "ref": "root" },
      "selection": "address-space-selection"
    }
  ]
}
```

Required fields: `id`, `title`.

Optional fields:

- `order`: numeric sort order, default 1000.
- `scope`: `component` or `instance`, default `component`.
- `requiresRole`: display hint only; server RBAC remains authoritative.
- `widgets`: descriptor widgets for the console-owned renderer.

## Console Discovery

The browser client does not invoke `describe` through the visible command surface. Descriptor
discovery is gateway-owned so operator command history and toasts remain clean.

Add protocol frames:

- client: `get-descriptor { key }`
- client: `refresh-descriptor { key }`
- server: `descriptor { key, manifest, receivedAt }`
- server: `descriptor-unavailable { key, reason, code? }`

The gateway implements those frames by invoking the target component's `describe` command through
the same command gateway/RBAC path. Failures are normalized into descriptor-unavailable states:
`UNKNOWN_VERB`, timeout, forbidden, malformed reply, and transport failures are all visible and
specific.

The client keeps a `DescriptionStore` keyed by `ComponentKey`. States:

- `loading`: a describe request is in flight.
- `ready`: a valid manifest was received.
- `unavailable`: not connected, the component/gateway returned an error, or no describe result
  could be fetched. If a previous manifest exists, the client keeps it visible while surfacing the
  failed refresh state.

The server may cache by `ComponentKey + digest`, but the UI must be able to force a refresh with
`refresh-descriptor`.

RBAC defaults must allow read-only discovery:

- `viewer`: `ping`, `describe`, `get-configuration`, `sb/status`, `sb/browse`, `sb/read`
- `operator`: unchanged `*`

## Console Rendering

The existing top-level Component Detail tabs remain:

- Health
- Instances
- Panel
- Configuration
- Events

Panel tab behavior:

- If `describe` is loading, show a compact loading state.
- If `describe` failed or has no panel views, show an honest unavailable state that names `cmd/describe`.
- If panel views exist, show a provider strip and Carbon sub-tabs sorted by `order`.
- Render only console-owned descriptor widgets in this phase.
- Unknown widget kinds render as unsupported, not blank.
- A widget bound to a missing verb renders unavailable and disables its controls.

### Initial Widget Set

`summary`: compact key/value text from static descriptor rows.

`commandSummary`: list of required verbs with available/unavailable status.

`treeBrowser`: browser bound to `browseVerb`. In this implementation it renders the honest
capability advertised by the descriptor: OPC UA currently uses `mode: "paged"` and the console
invokes the first page with `{offset: 0, limit: 100}`. Future hierarchical descriptors may use
`mode: "hierarchical"` with `{ref, depth}`. If `readVerb` is present it is shown as available; if
`writeVerb` is present, Write remains guarded until the safety path lands.

`signalGrid`: table-oriented view bound to `sb/subscriptions` and optional `sb/read`. It is useful
for currently configured/subscribed OPC UA signals before the broader global Signals screen is
scoped deeply enough.

In this phase, writes are visible but guarded. The full host-owned type-to-confirm modal and audit
mirror remain part of the write safety design and must not be weakened. If the console does not yet
have the modal/audit path, the descriptor renderer disables Write with clear copy instead of issuing
direct writes.

## OPC UA Reference Panels

`opcua-adapter` registers four descriptor views on startup:

1. **Overview** (`component` scope): endpoint/instance summary and command availability.
2. **Address Space** (`instance` widget scope): paged `treeBrowser` bound to `sb/browse`,
   `sb/read`, and `sb/write`.
3. **Signals** (`instance` scope): `signalGrid` bound to `sb/subscriptions` and `sb/read`.
4. **Diagnostics** (`instance` scope): `commandSummary` and status/metrics bindings for `sb/status`.

The adapter registers the descriptors after its `sb/*` verbs are registered, so `describe` lists the
same verbs that the panels bind to.

Important fidelity notes:

- The current implementation uses slash-form verbs (`sb/browse`, `sb/read`, `sb/write`). The UI must
  display and invoke those exact verbs. Dot-form strings such as `cmd/sb.browse` are design prose
  aliases only unless an explicit alias is added.
- The accepted design calls for lazy hierarchical browsing with refs. If the adapter only supports a
  flat paged browse at implementation time, the console must show a flat/paged browser honestly or
  mark lazy expansion unavailable. It must not pretend that a fabricated hierarchy came from the
  adapter.
- Physical writes stay disabled until the console has the server-side read-only kill switch,
  host-owned confirmation modal, pre-dispatch audit event, and adapter allow-list reply wired.

## Validation

Core:

- Every language rejects duplicate panel ids and invalid `id` / `title`.
- `describe` includes built-ins, custom verbs, and registered panel views.
- Existing command dispatch semantics stay unchanged.

Console:

- Selecting a component sends `get-descriptor`.
- A successful result renders Panel sub-tabs.
- Missing verbs disable bound widgets.
- Descriptor discovery does not appear in command toasts.

OPC UA:

- `describe` returns Overview / Address Space / Signals / Diagnostics panel descriptors.
- The descriptor references only verbs registered by `CommandRegistry`.

Non-completion caveat:

- Because this changes Greengrass-reachable core command behavior, full completion requires the
  four-language local MQTT command interop and deployed Greengrass IPC regression. Unit tests and
  builds prove the implementation slice, but not final platform completion.

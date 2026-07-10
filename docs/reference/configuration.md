# Reference — Configuration

Every configuration option. For *why* these exist, see [explanation.md](../explanation.md); for tasks,
see the [how-to guides](../how-to-guides.md); for the wire protocols, see
[data-types.md](data-types.md) (browser↔console) and
[messaging-interface.md](messaging-interface.md) (console↔bus).

## Config source

The console is a standard edgecommons Rust component (`com.mbreissi.edgecommons.EdgeConsole`; UNS component
token `edge-console`). It reads one JSON document from `-c/--config`, defaulting by platform:
`HOST` → `FILE`, `GREENGRASS` → `GG_CONFIG`, `KUBERNETES` → `CONFIGMAP`. The console's own knobs live
under **`component.global.console`** (a permissive subtree); the sibling sections (`messaging`,
`hierarchy`, `identity`, `logging`, `heartbeat`,
`metricEmission`, `tags`, `topic`) are standard edgecommons sections the library parses.

**Every `console` field is optional** — parsing is deliberately lenient: a missing or malformed
section/field falls back to its default rather than failing the component.

## Top-level sections

| Section | Required | Purpose |
|---------|----------|---------|
| `messaging` | HOST/KUBERNETES | The **site broker** connection (`messaging.local`), or supplied via `--transport MQTT <file>`. The console's one connection. |
| `component.global.console` | optional | All console-specific knobs (this document). Absent ⇒ all defaults. |
| `hierarchy` | optional | UNS enterprise-hierarchy level names; last level is the device. Drives the console's dynamic grouping/tree. Absent ⇒ `["device"]`. |
| `identity` | optional | Values for every hierarchy level except the last (the resolved thing). Sets the *console's own* identity — give it a distinct thing so it doesn't self-appear. |
| `heartbeat` | optional | The console's own keepalive (it is a component too). |
| `logging`, `metricEmission`, `tags`, `topic` | optional | Standard edgecommons sections. |

## `component.global.console.ws` — the gateway endpoint

| Key | Type | Default | Definition |
|-----|------|---------|-----------|
| `port` | number (1–65535) | `8443` | TCP port the HTTP + WebSocket gateway binds. |
| `bindAddress` | string | `"127.0.0.1"` | Bind address. Loopback by default; set `"0.0.0.0"` to accept connections from other hosts. Container/k8s deployments set `"0.0.0.0"` explicitly (loopback is unreachable through Docker port-mapping). |
| `allowedOrigins` | string[] | `[]` | Browser `Origin`s permitted on the `/ws` upgrade in addition to same-origin. The `/ws` handshake is Origin-gated (CSWSH defense): same-origin browsers and non-browser clients (no `Origin` header) are always allowed; a cross-origin browser must be listed here. A separately-hosted dev UI (e.g. Vite on `http://localhost:5173`) needs its origin listed; the self-served UI (`webRoot`) is same-origin and needs nothing. |
| `heartbeatIntervalMs` | number | `15000` | Server→client heartbeat cadence (ms); also the tick that evicts a client that never sends `hello`. |
| `webRoot` | string | *(unset)* | Filesystem path to the built UI (`ui/dist`) to serve on this same origin. **Opt-in**: unset ⇒ only `/healthz` + `/ws` are served. Relative paths resolve against the process cwd; absolute paths are used as-is. See [how-to → self-contained](../how-to-guides.md#deploy-self-contained-serve-the-built-ui-from-the-server--no-vite-no-nginx). |

> **TLS is not here.** The gateway is plain HTTP regardless of `webRoot`. Terminate TLS in front (reverse
> proxy / Ingress).

## `component.global.console.staleness` — the miss-detection ladder

| Key | Type | Default | Definition |
|-----|------|---------|-----------|
| `warnMultiplier` | number | `2` | Age > this × expected interval ⇒ **WARN**. |
| `staleMultiplier` | number | `2.5` | Age > this × expected interval ⇒ **STALE**. |
| `offlineMultiplier` | number | `5` | Age > this × expected interval ⇒ **OFFLINE**. |
| `defaultIntervalSecs` | number | `5` | Expected keepalive interval (seconds) until a component's `cfg` announces one. |
| `sweepIntervalMs` | number | `1000` | The liveness sweeper period (ms). |

The three multipliers must be **strictly increasing** (`warn < stale < offline`); a misordered trio is
rejected wholesale back to the defaults with a logged warning. The expected interval per component is
`cfg.config.heartbeat.intervalSecs` once its `cfg` arrives (min 1 s, floats truncated — mirroring the
library's own `HeartbeatConfig` parsing), else `defaultIntervalSecs`.

## `component.global.console.cache` — the LKV cache bound

| Key | Type | Default | Definition |
|-----|------|---------|-----------|
| `maxChannelsPerComponent` | number | `1024` | Max distinct `(instance, class, channel)` last-known-values kept per component. Overflow is dropped and counted (`droppedChannels`), never allowed to evict existing entries. |

## `component.global.console.events` — the rolling event history

| Key | Type | Default | Definition |
|-----|------|---------|-----------|
| `maxEvents` | number | `1000` | Fleet-wide recent-`evt` ring capacity (drop-oldest). |
| `maxPerComponent` | number | `100` | Independent per-component ring capacity, so a noisy component can't evict the others' history. |

## `component.global.console.metrics` — the metric surface bounds

| Key | Type | Default | Definition |
|-----|------|---------|-----------|
| `maxSeriesPoints` | number | `60` | Recent points kept per `(component, metric, measure)` series (drop-oldest). |
| `maxSeries` | number | `2000` | Max distinct series overall; overflow dropped and counted. |

## `component.global.console.logs` — the log tail bounds

| Key | Type | Default | Definition |
|-----|------|---------|-----------|
| `maxRecords` | number | `5000` | Fleet-wide recent `log/{level}` record capacity (drop-oldest). |
| `maxPerComponent` | number | `1000` | Independent per-component log tail capacity, so a noisy component cannot evict every other component's logs. |
| `defaultTail` | number | `500` | Default `subscribe-logs` response size when the client does not ask for a limit. |
| `maxTail` | number | `2000` | Hard cap on a single `subscribe-logs` response. |

## `component.global.console.clock` — clock-fault detection

| Key | Type | Default | Definition |
|-----|------|---------|-----------|
| `stepAlarmThresholdMs` | number | `250` | A wall-clock reading at least this far behind the gateway's receipt timeline is a backward clock step. One backward window raises one `clock-step` observation; the console publishes it as `evt/warning/clock-step` on its own identity, which raises the `clock-step` alarm through the normal event pipeline. |
| `clearAfterQuietSecs` | number | `600` | After this many seconds without a backward step, the console publishes the clearing event (`active: false`), resolving the alarm into history. |

Receipt timestamps are always clamped onto the gateway's own monotonic timeline regardless of
these settings; the settings govern only when a step is *reported*. NTP slews stay under 128 ms,
so the default threshold only fires on unambiguous clock trouble (VM/hypervisor time steps).

## `component.global.console.runtime` — process runtime tuning

| Key | Type | Default | Definition |
|-----|------|---------|-----------|
| `workerThreads` | number | `4` | Tokio worker thread count for the Rust gateway process. This is launch-latched: changing it requires restarting the process with `EDGECONSOLE_WORKER_THREADS` set to the same value before launch. |
| `mallocArenaMax` | number | `2` | Caps the glibc allocator's per-thread arenas. The gateway's Rust heap uses the mimalloc allocator (which returns freed memory to the OS), so this bounds only any non-Rust / C-library allocations on Linux/glibc deployments, and only when exported as `MALLOC_ARENA_MAX` before the process starts (launch-latched). |
| `eventBufferCapacity` | number | `512` | Capacity of the gateway's internal broadcast ring for recent live events. This ring contains full JSON event payloads for connected WebSocket sessions; lower values reduce retained heap. If a client falls behind this buffer, the gateway sends a fresh fleet snapshot and live traffic continues. Values are clamped to `16..4096`. |

The Settings screen reports both configured and effective runtime values. If they differ, the
gateway is running with the process-start environment, not the newly loaded component config.

## `component.global.console.rbac` — command authorization

| Key | Type | Default | Definition |
|-----|------|---------|-----------|
| `defaultRole` | string | `"operator"` | Role assigned to a connection with no resolved principal (the console resolves none, so this applies to **every** connection). Must name a declared role, else the whole policy falls back to the default. |
| `roles` | object | *(below)* | `roleName → { allow: string[], deny: string[] }`. `"*"` = every verb; `deny` wins over `allow`; an unknown role can do nothing (fail-closed). |

Default policy:

```jsonc
"rbac": {
  "defaultRole": "operator",
  "roles": {
    "operator": { "allow": ["*"], "deny": [] },  // full control
    "viewer":   { "allow": ["ping", "describe", "get-configuration", "sb/status", "sb/browse", "sb/read"], "deny": [] }  // read-only verbs
  }
}
```

> RBAC **enforcement** is real; the console resolves no connecting principal, so `defaultRole` applies to
> every connection. See [explanation → security](../explanation.md#a-note-on-security).

## `component.global.console.commands` — command deadlines

| Key | Type | Default | Definition |
|-----|------|---------|-----------|
| `defaultTimeoutMs` | number | `30000` | Per-command deadline when a verb has no specific override. |
| `maxTimeoutMs` | number | `60000` | The hard ceiling — the `uns-bridge` reply-map TTL (paired-knob rule). Every deadline is clamped to `[1, maxTimeoutMs]`. |
| `verbTimeouts` | object | `{ "ping": 10000 }` | Per-verb deadline overrides (ms). |

## Precedence & leniency summary

- Missing/malformed `console` section or field ⇒ its default (never a hard failure).
- Numbers must be finite and positive; ports must be 1–65535; timeouts are truncated to integers and
  clamped to the bridge TTL; the staleness trio must be strictly increasing (else all-defaults).
- Runtime knobs are launch-latched: the config declares desired values, while the process applies
  `EDGECONSOLE_WORKER_THREADS` and `MALLOC_ARENA_MAX` from its startup environment.
- The expected keepalive interval per component: **its `cfg` value ▸ `defaultIntervalSecs`**.

## Identity & the UNS device tree (for the console itself)

`hierarchy.levels` names the enterprise tree, deepest (the device) last; `identity` supplies every level's
value except the last (the resolved thing name). This is the *console's own* identity — it publishes its
own `state`/`metric`/`cfg` like any component, so give it a distinct thing name (`-t site-console`) to
keep it out of the fleet it watches. The console's dynamic grouping renders **whatever hierarchy each
*observed* component declares** in its own envelope `identity`, independent of the console's own.

## CLI

| Flag | Values | Notes |
|------|--------|-------|
| `--platform` | `HOST` \| `GREENGRASS` \| `KUBERNETES` \| `auto` | Default `auto`. |
| `--transport` | `MQTT [path]` \| `IPC` | HOST/K8s use MQTT; the path is the messaging config (its `messaging.local` is the site broker). |
| `-c/--config` | `FILE <path>` \| `ENV` \| `GG_CONFIG` \| `CONFIGMAP` \| … | Default from the platform. |
| `-t/--thing` | `<name>` | The console's own IoT Thing name; the `{device}` token of *its own* UNS topics. |

## HTTP surface (non-WebSocket)

| Method + path | Response |
|---------------|----------|
| `GET /healthz` | `200 ok` (liveness/readiness probe). |
| `GET /ws` (Upgrade) | The WebSocket gateway (see [data-types.md](data-types.md)). |
| `GET <anything>` | With `webRoot` set: the static UI (SPA fallback for extension-less routes; `403` on traversal; `404` otherwise). Without `webRoot`: `404`. |

## Complete example

```jsonc
{
  "logging": { "level": "INFO" },
  "heartbeat": { "enabled": true, "intervalSecs": 5 },
  "metricEmission": { "target": "messaging" },

  "messaging": {
    "local": { "host": "site-broker.internal", "port": 1883, "clientId": "edge-console" },
    "requestTimeoutSeconds": 30
  },

  "hierarchy": { "levels": ["site", "device"] },
  "identity": { "site": "dallas" },

  "component": {
    "global": {
      "console": {
        "ws":        { "port": 8443, "bindAddress": "0.0.0.0", "allowedOrigins": [],
                       "heartbeatIntervalMs": 15000, "webRoot": "../ui/dist" },
        "staleness": { "warnMultiplier": 2, "staleMultiplier": 2.5, "offlineMultiplier": 5,
                       "defaultIntervalSecs": 5, "sweepIntervalMs": 1000 },
        "cache":     { "maxChannelsPerComponent": 1024 },
        "events":    { "maxEvents": 1000, "maxPerComponent": 100 },
        "metrics":   { "maxSeriesPoints": 60, "maxSeries": 2000 },
        "logs":      { "maxRecords": 5000, "maxPerComponent": 1000,
                       "defaultTail": 500, "maxTail": 2000 },
        "clock":     { "stepAlarmThresholdMs": 250, "clearAfterQuietSecs": 600 },
        "runtime":   { "workerThreads": 4, "mallocArenaMax": 2,
                       "eventBufferCapacity": 512 },
        "rbac":      { "defaultRole": "viewer",
                       "roles": { "operator": { "allow": ["*"], "deny": ["reboot"] },
                                  "viewer":   { "allow": ["ping", "get-configuration"] } } },
        "commands":  { "defaultTimeoutMs": 30000, "maxTimeoutMs": 60000,
                       "verbTimeouts": { "ping": 10000 } }
      }
    },
    "instances": [{ "id": "main" }]
  }
}
```

See [sample-configurations.md](../sample-configurations.md) for more complete, deployment-specific
documents.

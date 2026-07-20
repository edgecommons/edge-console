# Reference — Metrics

The console has **two** distinct metric surfaces: what it emits about itself onto the bus (it is a
standard edgecommons component too), and what it consumes and re-serves to the browser (the fleet's
`metric` class, its main reason for existing). This page covers both, plus the console's own
process vitals, which are a third, browser-only surface that never touches the bus. For the
browser-facing wire shapes (`MetricSeriesSnapshot`, the `heartbeat` frame's `self` object) see
[data-types.md](data-types.md); for the bus-facing subscription rules see
[messaging-interface.md](messaging-interface.md).

## What the console emits

The console is `com.mbreissi.edgecommons.EdgeConsole` — a standard edgecommons component with
`metricEmission.target: messaging` (`test-configs/config.json`) and `heartbeat.enabled: true`. Like
every edgecommons component, its library-owned heartbeat publishes the system-measures metric
(`sys`) on the reserved `metric` class each `heartbeat.intervalSecs` tick:

```text
ecv1/{own-device}/edge-console/main/metric/sys
```

| Measure | Unit | Purpose |
|---|---:|---|
| `cpu_usage` | Percent | The console process's own CPU share. |
| `memory_usage` | Megabytes | The console process's own resident memory. |
| `disk_total` | Gigabytes | Total disk capacity on the console's host/volume. |
| `disk_used` | Gigabytes | Used disk capacity. |
| `disk_free` | Gigabytes | Free disk capacity. |
| `threads` | Count | OS thread count of the console process. |
| `files` | Count | Open file descriptors (Linux) / open handles. |
| `fds` | Count | File descriptors (platform-dependent availability). |

This is the same `sys` metric every edgecommons component emits (library-defined, not
console-authored) — it is what makes the console visible in *another* console's fleet view, the
same way every other component is. The console does not define any metric of its own beyond this
standard one; see "The console's own self-vitals" below for the console's *own-process* CPU/memory
view, which is a separate, browser-only path.

## What the console consumes

Per [messaging-interface.md](messaging-interface.md#what-the-console-consumes-six-class-wildcards),
the console subscribes the fleet-wide `metric` wildcard (`ecv1/+/+/+/metric/#`) and keeps a bounded
series per `(component, instance, metric, measure)`, capped by
[`component.global.console.metrics`](configuration.md#componentglobalconsolemetrics--the-metric-surface-bounds)
(`maxSeriesPoints` per series, `maxSeries` overall; overflow is dropped and counted, never evicts
existing series). This is the raw feed behind the **Metrics** screen and the WebSocket
`metrics`/`metric` frames ([data-types.md](data-types.md#metrics--metricseriessnapshot--metricseriesupdate)) —
any component's any named metric, not just `sys`.

### The runtime-attributes projection

Two specific channels are additionally special-cased into a latest-wins `RuntimeAttributes`
projection that feeds the Overview columns and the Component-Detail Health tab
([data-types.md](data-types.md#runtime-attributes--runtimeattributes)):

| Channel | Fields folded in |
|---|---|
| `metric/sys` | `cpuPercent`, `memoryMb`, `diskTotalGb`, `diskUsedGb`, `diskFreeGb`, `threads`, `openFiles`, `fds` — plus a 30-point drop-oldest sparkline ring for `cpuPercent`/`memoryMb` |
| `metric/southbound_health` | `connectionState`, `readErrors`, `writeErrors` — the southbound adapters' canonical health metric |

Every field is optional: a component that never emitted a measure simply omits it, and the UI shows
"—" rather than a fabricated value.

## The console's own self-vitals

Separate from both surfaces above, the console samples **its own** process CPU% and memory
(`gateway/src/self_vitals.rs`) purely for display in its own browser-facing `heartbeat` WebSocket
frame's `self` object (`ConsoleSelf`) — this is **never published to the bus**; it powers the
Overview "Edge node" tile for the console's own row, the same way `sys` powers every other
component's row.

| Field | Unit | Purpose |
|---|---:|---|
| `cpuPercent` | Percent (one core) | Omitted on the first sample (no baseline yet — never fabricated as `0`); present from the second sample onward. |
| `memoryMb` | Megabytes | Resident memory of the console process, divided by 1,000,000 bytes. |

The same `heartbeat` frame also carries the console's own ingress throughput —
`busMsgsPerSec`/`busRecentRates`, the "Edge bus" tile — sourced from the gateway's own message
counters, not from any UNS metric.

## Dimensions

The console's own emitted metric (`sys`) carries no dimensions beyond the standard identity
(device/component/instance) — it is the library's system-measures metric, unmodified. The console
does not define any dimensioned metric family of its own (it has no southbound signals, polling
groups, or command verbs to dimension against); its `MetricSeriesSnapshot`/`MetricSeriesUpdate`
storage is keyed by `(component, instance, metric, measure)` for whatever the *fleet* emits, per
[data-types.md](data-types.md#metrics--metricseriessnapshot--metricseriesupdate).

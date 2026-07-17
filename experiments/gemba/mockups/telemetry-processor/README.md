# OEE derivation with telemetry-processor Lua

These scripts turn one raw `OeeShiftSnapshot` signal into four ordinary numeric
`SouthboundSignalUpdate` series:

| Script | Output signal | Formula |
|---|---|---|
| `scripts/availability.lua` | `AvailabilityPct` | `runTimeMs / plannedProductionMs` |
| `scripts/performance.lua` | `PerformancePct` | `(idealCycleMs × totalCount) / runTimeMs` |
| `scripts/quality.lua` | `QualityPct` | `goodCount / totalCount` |
| `scripts/oee.lua` | `OeePct` | `Availability × Performance × Quality` |

Each ratio is clamped to 0–100% and rounded to one decimal place. Invalid, incomplete, or non-GOOD
input is dropped. A zero denominator produces 0% rather than an error.

## Why the input is one snapshot signal

The telemetry-processor contract intentionally makes each Lua evaluation stateless. Its built-in
`sample` and `aggregate` stages own cross-message state, but the processor does not currently expose
a cross-signal join stage. Depending on Lua globals to remember the latest value of independent
`GoodCount`, `RejectCount`, and runtime tags would violate the supported scripting contract and
would lose the calculation state on restart.

The simulator therefore publishes the five raw OEE basis values atomically as a numeric array:

```text
OeeShiftSnapshot = [
  plannedProductionMs,
  runTimeMs,
  totalCount,
  goodCount,
  idealCycleMs
]
```

This is raw source data, not a precomputed OEE value. The telemetry-processor remains responsible
for all four ratios. Because the simulator owns cumulative shift counters, a processor restart
recovers on the next snapshot without reconstructing the shift from message history.

Counter semantics:

- `plannedProductionMs` advances only while the line is scheduled to produce; planned breaks and
  planned changeovers do not advance it.
- `runTimeMs` advances while the line is actually producing. Starved, blocked, faulted, and
  unplanned-stop time does not advance it.
- `totalCount` is good plus rejected units since the shift boundary.
- `goodCount` is accepted units since the same boundary and must not exceed `totalCount`.
- `idealCycleMs` is `60000 / ideal units per minute`: `454.545...` for Line 1 at 132 BPM and
  `2142.857...` for Line 2 at 28 CPM.
- All five values reset atomically at the shift boundary. During reset the snapshot may briefly
  report zeros; the scripts emit 0% until denominators become non-zero.

The first sample's `sourceTs` and `serverTs` are copied to every derived signal. The output envelope
is preserved by the script stage and the local target restamps the publisher identity to the
telemetry-processor.

## Example matching the Line 1 mock-up

This snapshot:

```json
[30000000, 29130000, 61394, 60964, 454.54545454545456]
```

produces, after one-decimal rounding:

```text
AvailabilityPct = 97.1
PerformancePct  = 95.8
QualityPct      = 99.3
OeePct          = 92.4
```

The factor scripts and the OEE script use the same clamping rules, so the displayed OEE remains
consistent with the three displayed factors.

## Route configuration

- `line-1-routes.json` subscribes only to the filling line's `filler1` OPC UA adapter.
- `line-2-routes.json` subscribes only to the packaging line's external-Kepware-backed
  `palletizer1` OPC UA adapter.

Each fragment defines four independent routes because one telemetry-processor script stage emits at
most one transformed message. The routes filter on the canonical signal name
`OeeShiftSnapshot`, downsample it to 1 Hz, and publish four distinct channels under
`data/gemba/oee/`. The derived body remains a valid `SouthboundSignalUpdate`, with a numeric first
sample suitable for the gateway signal store and TV applications.

For Line 1, merge these routes into the existing `TelemetryProcessor` component configuration and
ship the four files under `/scripts/oee/`. Preserve the existing archive and downsample routes.

Line 2 does not currently run telemetry-processor. Add it as another consumer inside the packaging
line deployment and mount the same `/scripts/oee/` files. This does not change the source topology:
OPC UA still comes from external Kepware and Modbus still comes from the external host simulator.

The deployed telemetry-processor must be a release build containing the `scripting-lua` feature;
selecting `scriptEngine: "lua"` fails startup when that feature is absent.

## Validation expectations

Before deployment, validate the merged catalogs and start each telemetry-processor against a local
test broker. For each line, publish at least these snapshots and assert all four derived values:

1. Empty shift: `[0, 0, 0, 0, idealCycleMs]` → four `0.0` values.
2. Normal production: the example above → `97.1`, `95.8`, `99.3`, `92.4`.
3. Performance above ideal: clamp `PerformancePct` at `100.0` and keep OEE at or below `100.0`.
4. Invalid input, non-array input, or BAD quality: no derived update.
5. Processor restart mid-shift: the next snapshot reproduces the pre-restart values.

The route fragments are design artifacts in `edge-console`; no Dallas catalog or simulator has been
changed.

# Dallas simulator changes for the TV mock-ups

Status: design proposal only. No simulator, adapter, Dallas container, or non-`edge-console`
repository was changed for these mock-ups.

## Current topology verified

The checked-in configuration and the running Dallas containers agree on the source topology:

- **Line 1 / `gw-fill-01`:** the container runs local `opcua-sim` and `modbus-sim` processes. The
  OPC UA adapter reads `opc.tcp://localhost:4840/`; the Modbus adapter reads
  `localhost:5020`, unit 1.
- **Line 2 / `gw-pack-01`:** the container runs the OPC UA and Modbus adapters, not the source
  simulators. OPC UA comes from external Kepware through `KEPWARE_ENDPOINT`; Modbus comes from the
  external host simulator through `HOST_MODBUS`. This topology must remain unchanged.

The current Line 1 signals are `BottleCount`, `ProductTemp`, and `FillLevel` over Modbus, plus
`Sine1` and `Counter` over OPC UA. The current Line 2 Modbus set is `CaseCount`, `JamStatus`, and
`RunCommand`; the OPC UA subscription includes Kepware nodes matching
`^GGCommonsTest\.Device1\.Live.*`.

The proposed additions below make the data tell a coherent production story. Existing smoke-test
nodes should remain available so component validation is not weakened.

## Line 1 — filling dashboard

### Screen binding

| Board field | Source | Proposed signal | UI treatment |
|---|---|---|---|
| Actual speed | OPC UA | `LineSpeedBpm` | Hero rate and plan variance |
| Shift good count | Modbus | `GoodBottleCount` | Monotonic shift total |
| Shift rejects | Modbus | `RejectCount` | Total plus reject rate |
| Fill pressure | OPC UA | `FillPressureKpa` | Current value, trend, 140 kPa alarm |
| Average fill | OPC UA | `FillVolumeMl` | Bottle gauge and tolerance state |
| Product temperature | Modbus | `ProductTempC` | Process-window value |
| Filler bowl level | Modbus | `BowlLevelPct` | Process-window value |
| Valve tracking | OPC UA | `ValveTrackingCount` | “40 / 40 valves tracking” |
| CO₂ volumes | OPC UA | `CO2Volumes` | Product-condition supporting value |
| Line state | OPC UA | `FillerState` | Running, starved, blocked, fault |
| OEE basis | OPC UA | `OeeShiftSnapshot` | Raw atomic basis for telemetry-processor Lua |

Availability, performance, quality, and OEE are derived by telemetry-processor from the raw
`OeeShiftSnapshot`; they do not need to be separate PLC tags. Plan variance remains an application
projection from the production counters and shift plan.

### Modbus register additions

Keep the current values for compatibility and add a scenario range that does not overlap the
validation scratch registers:

| Table / address | Type | Name | Pattern |
|---|---|---|---|
| holding 50–51 | `uint32` | `GoodBottleCount` | Increment from `LineSpeedBpm`; reset at shift boundary |
| holding 52–53 | `uint32` | `RejectCount` | Increment from the three reject categories |
| holding 54–55 | `uint32` | `UnderfillRejectCount` | Rare baseline; burst during low-pressure episode |
| holding 56–57 | `uint32` | `OverfillRejectCount` | Rare baseline; rise during pressure drift |
| holding 58–59 | `uint32` | `CapRejectCount` | 0.3–0.5% baseline with short capper-vibration burst |
| holding 60 | `uint16`, scale 0.1 | `ConveyorSpeedPct` | 95–97% while running; ramp during start/stop |
| holding 61 | `uint16`, scale 0.1 | `BowlLevelPct` | 78% ±1.2%; slow control-loop oscillation |
| holding 62 | `int16`, scale 0.1 | `ProductTempC` | 4.3 °C with slow thermal drift, not a repeating sawtooth |
| discrete 0 | `bool` | `ConveyorRunning` | True except during changeover/fault scenario |
| discrete 1 | `bool` | `InfeedStarved` | Short 10–25 s episodes every 12–18 min |
| discrete 2 | `bool` | `EStopHealthy` | Normally true; never pulse during an ordinary demo |

The existing `BottleCount`, `ProductTemp`, and `FillLevel` may remain until consumers migrate, but
the mock-up binds to the explicit engineering names above.

### OPC UA node additions

Add a `Simulation/Line1` folder in the existing `urn:edgecommons:sim` namespace:

| Node | Type | Normal pattern | Scenario behavior |
|---|---|---|---|
| `LineSpeedBpm` | Double | 126 ±1.8 BPM around a 132 target | Reduce toward 114 during pressure intervention |
| `FillPressureKpa` | Double | 112.4 kPa with layered slow/fast variation | Drift to 138–144 kPa for 45–90 s |
| `FillVolumeMl` | Double | 500.2 ±0.6 mL, weakly correlated with pressure | Bias high during overpressure; low on recovery |
| `ValveTrackingCount` | UInt16 | 40 | Drop to 39 when a valve fault scenario is active |
| `CO2Volumes` | Double | 2.62 ±0.03 | Slow temperature-correlated drift |
| `FillerState` | String | `RUNNING` | `STARVED`, `PRESSURE_HOLD`, or `FAULTED` |
| `ActiveRecipe` | String | `LS-355-07` | Change only during a scripted changeover |
| `OeeShiftSnapshot` | Double[5] | `[plannedMs, runMs, total, good, 454.545...]` | Atomic cumulative shift basis; publish at 1 Hz |

Use deterministic seeded noise plus bounded control-loop oscillation. The current bare `Sine1`
pressure mapping is useful for a transport smoke test, but an explicit `FillPressureKpa` node makes
the demo self-describing and avoids putting simulator implementation names on the wire.

The Line 1 snapshot must read the same scenario state as the scalar Modbus counters:
`good = GoodBottleCount` and `total = GoodBottleCount + RejectCount`. It must not maintain an
independent production count.

### Line 1 configuration files to change later

1. Add the scenario registers/nodes to the simulator code copied by
   `bottling-company-test/dockerfiles/edge-node.Dockerfile`. Prefer Dallas-specific simulator
   modules owned by the bottling harness rather than expanding the adapters' generic validation
   fixtures indefinitely.
2. Add the Modbus signals to
   `sites/dallas-site/configs/filling-line/config-catalog.json` under
   `ModbusAdapter.instances[conveyor1].pollGroups[main].signals`.
3. Expand the OPC UA include expression in the same catalog to include `Simulation/Line1/*` while
   retaining `Sine1|Counter` for existing validation.
4. Merge `telemetry-processor/line-1-routes.json` into the existing telemetry-processor routes and
   ship `telemetry-processor/scripts/*.lua` under `/scripts/oee/` without removing the current
   downsample and archive routes.
5. Keep polling/sampling at 500 ms / 250 ms. The gateway's per-client 30 Hz ceiling remains the UI
   protection; these sources are far below it.

## Line 2 — packaging dashboard

Line 2 keeps its external-source architecture. Changes belong in the external host Modbus
simulator and the external Kepware simulation project, plus the packaging adapter catalog that
subscribes to them.

### Screen binding

| Board field | Source | Proposed signal | UI treatment |
|---|---|---|---|
| Actual case rate | Host Modbus | `CaseRateCpm` | Hero rate and plan variance |
| Shift good cases | Host Modbus | `GoodCaseCount` | Monotonic shift total |
| Reject cases | Host Modbus | `CaseRejectCount` | Shift quality count |
| Jam state | Host Modbus | `JamStatus` | Machine state and action banner |
| Packer motor load | Host Modbus | `PackerMotorCurrentA` | Early-warning trend |
| Carton magazine | Host Modbus | `CartonMagazinePct` | Refill forecast |
| Pallet progress | Kepware OPC UA | `Live.PalletCaseCount` | Live pallet diagram |
| Pallet/layer | Kepware OPC UA | `Live.PalletNumber`, `Live.PalletLayer` | Load identity and progress |
| Vision pass | Kepware OPC UA | `Live.VisionPassPct` | Quality tile |
| Glue temperature | Kepware OPC UA | `Live.GlueTempC` | Sealer condition tile |
| Case weight | Kepware OPC UA | `Live.CaseWeightKg` | Quality tile |
| Order/label | Kepware OPC UA | `Live.ActiveOrder`, `Live.LabelCode` | Work-order context and verification |
| OEE basis | Kepware OPC UA | `Live.OeeShiftSnapshot` | Raw atomic basis for telemetry-processor Lua |

### External host Modbus additions

| Table / address | Type | Name | Pattern |
|---|---|---|---|
| input 0–1 | `uint32` | `GoodCaseCount` | Increment at 27.6 CPM when run and clear |
| input 2–3 | `uint32` | `CaseRejectCount` | 0.4–0.8% baseline; short burst after jam recovery |
| input 4 | `uint16`, scale 0.01 | `PackerMotorCurrentA` | 6.2 A normal; ramps above 9 A before jam |
| input 5 | `uint16`, scale 0.01 | `CaseWeightKg` | 12.18 kg ±0.03 with occasional reject outlier |
| input 6 | `uint16`, scale 0.1 | `CaseRateCpm` | 27.6 ±0.6; zero while jammed |
| input 7 | `uint16`, scale 0.1 | `CartonMagazinePct` | Sawtooth depletion; jump to 100% on refill event |
| discrete 0 | `bool` | `JamStatus` | Keep current address; scripted 10–20 s jam |
| discrete 1 | `bool` | `MagazineLow` | True below 15% |
| discrete 2 | `bool` | `CaseAtDischarge` | Pulse at case cadence while running |
| discrete 3 | `bool` | `EStopHealthy` | Normally true |
| coil 0 | `bool` | `RunCommand` | Keep current address and semantics |

The realistic jam pattern is causal: motor current rises over 20–40 seconds, `JamStatus` becomes
true, case rate falls to zero, and after clearance there is a brief reject/recovery period. Avoid a
boolean that toggles with no preceding or downstream effect.

### External Kepware additions

Add tags below the already subscribed `GGCommonsTest.Device1.Live` branch so the current adapter
regex continues to work:

| Kepware item | Type | Pattern |
|---|---|---|
| `Live.PalletCaseCount` | UInt16 | 1–120, increment once per good case, reset on pallet complete |
| `Live.PalletNumber` | UInt32 | Increment after each 120-case pallet |
| `Live.PalletLayer` | UInt16 | 1–5; advance every 24 cases |
| `Live.VisionPassPct` | Float | 99.4% baseline with small bounded variation and rare failure burst |
| `Live.GlueTempC` | Float | 176 °C slow control-loop variation; alarm outside 172–180 |
| `Live.CaseWeightKg` | Float | Mirror/derive from the checkweigher simulation |
| `Live.ActiveOrder` | String | `SPRK-LIME-355-24` during the primary scenario |
| `Live.LabelCode` | String | Lot/time-derived printable code, updated at lot or minute boundary |
| `Live.PalletizerState` | String | `BUILDING`, `WRAPPING`, `DISCHARGING`, `BLOCKED` |
| `Live.OeeShiftSnapshot` | Double[5] | `[plannedMs, runMs, total, good, 2142.857...]`, publish at 1 Hz |

Kepware's simulator should coordinate with the host Modbus scenario clock so a jam pauses pallet
progress and changes `PalletizerState` to `BLOCKED`. A small shared scenario seed/start timestamp is
enough; the two sources do not need a new production integration dependency.

The Line 2 OEE snapshot must reproduce the host simulator's authoritative counts from that shared
scenario state: `good = GoodCaseCount` and `total = GoodCaseCount + CaseRejectCount`. The acceptance
test should require the Kepware snapshot and the host Modbus counters to agree within one source
update, including across jam recovery and shift reset.

### Line 2 configuration files to change later

1. Update the external host Modbus simulator register map and scenario loop. Keep its configured
   endpoint in `HOST_MODBUS`; do not move it into `dallas-packaging-line`.
2. Add the `Live.*` items to the external Kepware simulation project. Keep its configured endpoint
   in `KEPWARE_ENDPOINT`; do not replace Kepware with the Line 1 asyncua simulator.
3. Update `sites/dallas-site/configs/packaging-line/config-catalog.tmpl.json` with the expanded
   Modbus signal list. The existing OPC UA regex already includes the proposed `Live.*` items.
4. Add telemetry-processor to the packaging deployment, merge
   `telemetry-processor/line-2-routes.json`, and mount the same scripts under `/scripts/oee/`.
   This is an additional consumer; it does not move or replace either external source.
5. Preserve the existing EMQX, config-component, adapter, and bridge processes when adding the
   telemetry-processor process.

## OEE computation

The four Lua transforms, formulas, input semantics, route fragments, and validation cases are in
`telemetry-processor/README.md`. Both lines publish the same raw five-element basis so the scripts
stay identical; only the source adapter subscription differs. The processor publishes numeric
`AvailabilityPct`, `PerformancePct`, `QualityPct`, and `OeePct` signals at no more than 1 Hz.

An atomic basis signal is necessary with the current telemetry-processor contract. Lua transforms
are stateless and the built-in aggregates are per key; neither is a supported cross-signal latest
value join. The array contains raw timers and counters rather than precomputed ratios, leaving the
actual OEE calculation in telemetry-processor and making restart recovery deterministic.

## Gateway/application binding

Both applications can use the same gateway and experimental `signals` capability. Each app should
have a separate manifest/route and Origin policy:

- `dallas-line-1` — Sony/Android TV Origin; display only identity line `filling-line`.
- `dallas-line-2` — Samsung packaged Origin `file://`; display only identity line
  `packaging-line`.

The mock-ups bind visual elements through `data-signal` attributes. A production client should fold
Gemba `signals` snapshots and `signal` updates by stable signal identity, then project the listed
fields. Line scoping should ultimately be enforced by the gateway policy, not solely by client-side
filtering.

## Acceptance scenario

Once implemented, a 15-minute deterministic run should demonstrate:

1. Both boards remain live concurrently through the same gateway.
2. Line 1 shows steady production, one pressure-drift episode, correlated fill movement, and
   recovery without implausible counter resets.
3. Line 2 shows normal pallet progression, a motor-current precursor, one jam, paused pallet
   progress, clearance, and a short quality-recovery period.
4. Source updates may arrive faster, but each UI receives no more than 30 update envelopes per
   second and repaints only the widgets whose projected values changed.

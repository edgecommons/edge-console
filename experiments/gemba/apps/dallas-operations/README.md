# Dallas operations web applications

This directory is one self-contained static bundle registered as three independently governed
edge-console applications:

| Application ID | Supervisor view | Requested capabilities |
|---|---|---|
| `dallas-overview` | Plant overview and line selector | `signals`, `alarms`, `fleet` |
| `dallas-line-1` | Mirror of the Sony/Android TV filling board | `signals`, `alarms` |
| `dallas-line-2` | Mirror of the Samsung/Tizen packaging board | `signals`, `alarms` |

All three registrations point to this directory as their `webRoot`. The route-derived application
ID selects a view at startup, while the common shell supplies the Dallas navigation, bridge status,
clock, and the `0`/`1`/`2` keyboard shortcuts. The line views deliberately preserve the distinct
shop-floor visual languages: continuous-flow instrumentation for Filling and a paper/manifest
production board for Packaging.

The large-format layout uses a distance-readable type scale rather than desktop-dashboard density.
At 1920×1080, supporting operational text is approximately 14–20 CSS pixels, line states and panel
headings are approximately 34–69 pixels, and primary production values reach approximately 98
pixels. At compact control-room heights, low-value annotations are removed before critical text is
reduced; visible large-format text has a 12-pixel floor.

## Run from the experimental gateway

Start the local gateway with `experiments/gemba/dallas-local.json`, then open:

- `http://127.0.0.1:18443/apps/dallas-overview/`
- `http://127.0.0.1:18443/apps/dallas-line-1/`
- `http://127.0.0.1:18443/apps/dallas-line-2/`

The bundle has no build step or remote assets. Each route loads `index.html`, `styles.css`, and
`app.js` directly from the gateway. The browser connects to `/apps/{application-id}/ws`, negotiates
application protocol v1, and subscribes only to the capabilities granted to that registration.
The UI counts received `updates` envelopes over a rolling second; the gateway remains responsible
for the 30-envelope-per-second client ceiling and latest-value coalescing.

An optional `?bridge=http://host:port` query parameter points the bundle at a separately hosted
gateway. The supplied application registration must explicitly allow the page's origin before that
WebSocket will be accepted.

## Live signal bindings

The browser matches canonical `SouthboundSignalUpdate` identity using `signal`, `name`, and
`signalId`. It prefers the `key.device` and component/instance identity to assign data to Filling or
Packaging, and falls back to the unique signal name when the device identity is not present.

Filling binds `LineSpeedBpm`, `OeePct`, `AvailabilityPct`, `PerformancePct`, `QualityPct`,
`FillPressureKpa`, `FillVolumeMl`, `GoodBottleCount`, `RejectCount`, `ProductTempC`, and
`BowlLevelPct`. `FillerState` drives the status label.

Packaging binds `CaseRateCpm`, `GoodCaseCount`, `CaseRejectCount`, `PackerMotorCurrentA`,
`GlueTempC`, `VisionPassPct`, `CaseWeightKg`, `LabelCode`, `PalletCaseCount`, and
`CartonMagazinePct`. `JamStatus` and `PackerState` drive the exception state. Line 2 continues to
use the external Kepware OPC UA source and the host Modbus simulator; the web application only
consumes their normalized UNS output and does not change that source topology.

Until a proposed simulator signal appears, its widget keeps the approved demo-baseline value and
the source badge says `DEMO BASELINE`. The badge changes to `LIVE SIMULATOR DATA` only after at
least one mapped signal arrives. This makes partially configured demonstrations obvious rather than
presenting static values as live telemetry.

The richer simulator patterns and the telemetry-processor Lua OEE routes that can supply these
bindings are documented in `../../mockups/SIMULATOR_CONFIGURATION.md` and
`../../mockups/telemetry-processor/README.md`.

## Feasibility boundary

The separate application registrations enforce origin, role, and capability policy, but this demo's
Filling-versus-Packaging selection happens in the browser. Client-side filtering is not an
authorization boundary: a production gateway should add an application projection policy that
limits device/component/signal identity before frames enter a session. The line applications should
then receive only their configured projection, while the overview receives both line projections.

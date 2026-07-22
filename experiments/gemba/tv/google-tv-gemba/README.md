# google-tv-gemba — native Android TV filling-line board (Line 01)

A native Android TV application that renders a live **OEE board for the Dallas filling line** (`gw-fill-01`)
on a Sony/Google-TV panel. It connects to the edge-console **hosted-application WebSocket** and draws a
flat, high-density HMI entirely in code (no XML layouts): an OEE band, a filling-status band, an
instrumented INFEED ▸ FILLER ▸ CAPPER flow strip, a fill-quality panel (tank gauge + pressure / volume /
temperature / CO₂ bullet bars), a rate-vs-target gauge, a reject breakdown, and a line-health footer.
Colour is used only where it carries meaning (amber = caution, red = fault, green = ok).

It is the native counterpart to the packaged Tizen board (`../tizen-gemba/`, Line 02). Both are clients
of the same console app WebSocket; see [`../README.md`](../README.md) for the shared feasibility notes and
the public operator-facing docs.

## What it connects to

- **URL:** `ws://<gateway-host>:<port>/apps/tv-board/ws` (compiled default targets the isolated
  `tv-local.json` gateway; override at launch — see below).
- **Origin:** the app is not a browser, so it sends its own `Origin: https://google-tv.edgecommons.local`
  header. That value must appear verbatim in the `tv-board` app's `allowedOrigins`
  (see [`../../tv-local.json`](../../tv-local.json)).
- **Handshake:** protocol-v1 `hello` → `welcome`, then `subscribe` to its granted families, then it
  filters client-side to `device == gw-fill-01`. (The console has no server-side device filter.)
- **Resilience:** exponential reconnect backoff (2 s → 15 s cap), a 12 s no-data stall watchdog that
  force-reconnects a silently-stalled socket, and an OkHttp WS ping every 15 s.

## Build

Requires the Android SDK (API/build-tools 36) and JDK 17. From the edge-console repo root you can use the
helper scripts (they accept the SDK license and stage the debug APK):

```powershell
experiments/gemba/tv/build-google-tv.ps1
experiments/gemba/tv/deploy-google-tv.ps1 -DeviceAddress <tv-ip>
```

Or build directly with Gradle:

```bash
# from experiments/gemba/tv/google-tv-gemba
gradle assembleDebug        # -> app/build/outputs/apk/debug/app-debug.apk
```

`local.properties` (the machine-specific `sdk.dir`) is gitignored; create it or let the Android tooling
generate it.

## Install and launch

```bash
ADB=<android-sdk>/platform-tools/adb
$ADB -s <tv-ip>:5555 install -r app/build/outputs/apk/debug/app-debug.apk
# Launch, passing the gateway URL as an Intent extra so it need not be typed with the remote:
$ADB -s <tv-ip>:5555 shell am start -n dev.edgecommons.gembatv/.MainActivity \
  --es bridgeUrl "ws://<gateway-host>:<port>/apps/tv-board/ws"
```

- The URL passed via `--es bridgeUrl` is persisted in `SharedPreferences`; later launches reuse it. Run
  `adb shell pm clear dev.edgecommons.gembatv` to reset a stale stored URL.
- Capture a screenshot with `adb -s <tv-ip>:5555 exec-out screencap -p > board.png`.

## Panel / rendering notes

- The board is built from `LinearLayout` weight rows plus a few custom `Canvas` views:
  `TankGaugeView` (bowl level), `BulletBarView` (spec measures + the rate-vs-target gauge, with a target
  tick and configurable below-band colour), and `BarMeterView` (reject split).
- **Sony BRAVIA panels render their Android UI surface at 1920×1080** (density 2.0 ≈ 960×540 dp) and
  hardware-upscale to 4K; `wm size` does not change this. Design to ~960×540 dp minus overscan.
- One signal can drive several displays (e.g. fill pressure feeds both the FILLER flow tile and the
  fill-quality bullet), so the signal→view binding is a multimap.

## Signals rendered (device `gw-fill-01`)

`OEE` / `Availability` / `Performance` / `Quality`, `FillerState`, `LineSpeedBpm`, `GoodBottleCount`,
`BowlLevelPct`, `FillPressureKpa`, `FillVolumeMl`, `ProductTempC`, `CO2Volumes`, `ConveyorSpeedPct` /
`ConveyorRunning` / `InfeedStarved` / `EStopHealthy`, `CapRejectCount`, and the reject breakdown
(`OverfillRejectCount` / `UnderfillRejectCount` / `CapRejectCount`). Signal names arrive un-normalized on
the wire (Modbus name / OPC UA nodeId / OEE topic) and are reduced to short names client-side.

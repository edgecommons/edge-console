# Gemba feasibility experiments

These files exercise the design in `DESIGN.md` without changing or replacing the running Dallas
edge-console deployment.

`dallas-local.json` starts a separate HOST gateway on `127.0.0.1:18443` and connects it to the
Dallas site broker exposed on `127.0.0.1:18830`. Its MQTT client ID and EdgeCommons component
identity are unique to this experiment. The existing Dallas UI remains on `127.0.0.1:8080`.

From the edge-console repository root:

```powershell
cargo run -p edge-console-gateway -- `
  --platform HOST `
  --transport MQTT experiments/gemba/dallas-local.json `
  -c FILE experiments/gemba/dallas-local.json `
  -t dallas-gemba-local
```

The original feasibility bundles are available from the gateway's namespaced static routes at:

- `http://127.0.0.1:18443/apps/andon/`
- `http://127.0.0.1:18443/apps/gemba-board/`

The supervisor/control-room application is one deployable static bundle with three independently
registered views:

- `http://127.0.0.1:18443/apps/dallas-overview/`
- `http://127.0.0.1:18443/apps/dallas-line-1/`
- `http://127.0.0.1:18443/apps/dallas-line-2/`

The overview provides the overarching line navigation. The two detail routes mirror the operating
pictures used by the Sony Filling display and Samsung Packaging display, so a supervisor sees the
same status and exceptions as the shop floor. See `apps/dallas-operations/README.md` for deployment,
signal binding, and the remaining server-side projection requirement.

The static paths prove multi-bundle packaging, but a path below one shared origin is not an app
security boundary. The WebSocket experiment therefore requires a distinct explicit origin for each
app. Start the sample bundles independently and point them at the bridge:

```powershell
py -3.14 -m http.server 15174 -d experiments/gemba/apps/andon
py -3.14 -m http.server 15175 -d experiments/gemba/apps/gemba-board
```

Open `http://127.0.0.1:15174/?bridge=http://127.0.0.1:18443` and
`http://127.0.0.1:15175/?bridge=http://127.0.0.1:18443`. The legacy root remains unserved (`GET /`
returns 404) because `console.ws.webRoot` is deliberately unset. The original Console can also run
separately through Vite with `VITE_CONSOLE_WS_URL=ws://127.0.0.1:18443/ws`.

Run `node experiments/gemba/verify.mjs` while the local gateway is active to check route isolation,
origin and role denial, app-scoped subscription denial, and Console v7 compatibility. To also
check a separately hosted Console, start the UI with
`VITE_CONSOLE_WS_URL=ws://127.0.0.1:18443/ws`, then run:

```powershell
$env:GEMBA_EXTERNAL_UI_URL = "http://127.0.0.1:15173/"
node experiments/gemba/verify.mjs
```

For the high-rate and stalled-consumer experiment, run the gateway with `burst-local.json` on port
18444 against the existing generic test broker on port 1883, then run:

```powershell
$env:GEMBA_BASE_URL = "http://127.0.0.1:18444"
$env:GEMBA_BURST_BROKER_PORT = "1883"
node experiments/gemba/verify.mjs
```

The verifier publishes EdgeCommons protobuf envelopes; it does not use or modify the Dallas broker
for the synthetic load.

See `RESULTS.md` for the completed feasibility run and the remaining productization gaps.

The follow-on Samsung Tizen and Google TV client experiment is under `tv/`. It uses
`tv-local.json` and the same experimental application WebSocket protocol; see `tv/README.md` for
build/deployment instructions and `tv/RESULTS.md` for the successful physical-device transport
evidence and remaining lifecycle checks.

High-fidelity 1920x1080 manufacturing-board concepts for Dallas Line 1 (Android TV) and Line 2
(Tizen) are under `mockups/`. These are standalone design prototypes; `mockups/README.md` explains
how to view them, and `mockups/SIMULATOR_CONFIGURATION.md` proposes the richer simulated signals
needed to drive them while preserving Line 2's external Kepware and host-Modbus topology.

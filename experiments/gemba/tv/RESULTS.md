# TV client feasibility results

Date: 2026-07-13

Status: local protocol preflight, physical Sony Google TV and Samsung Tizen deployment,
two-physical-TV concurrency, and post-power-cycle recovery passed. Samsung requires manual app
relaunch after power-on on this consumer model; business-oriented Samsung/Tizen displays provide
kiosk mode for unattended launch. Rendering cost and WSS remain open.

## Devices in scope

- Samsung TV in developer mode, reported software version `T-MSMAKUC-142.0, BT-S`.
  Samsung's security-update catalog maps the `T-MSMAKUC` firmware family to 2019 models. The
  corresponding Samsung web-engine matrix identifies 2019 TVs as Tizen 5.0 with Chromium M63.
  The connected device model confirms the 2019-family identification.
- Samsung `UN55RU8000FXZA` at `192.168.1.196`, exposed through SDB as the same model after
  developer mode was configured for the development PC at `192.168.1.224`.
- Sony BRAVIA 4K VH2 (`BRAVIA_VH2_M_UC`) on Android 12/API 31 at `192.168.1.223`.
  The retail firmware exposes a generic **ADB debugging** option and legacy network ADB on TCP 5555.

## Completed local evidence

- Confirmed the repository is on `feat/gemba` and kept every experiment change inside
  `edge-console`.
- Added a LAN-only gateway configuration on port 18445 with a unique MQTT client and component
  identity. The existing Dallas edge-console container was not rebuilt, restarted, or replaced.
- Started the experimental gateway against the Dallas site broker and received HTTP 200 from
  `/healthz` and `/apps/tv-board/`.
- Connected two simultaneous RFC 6455 clients to `/apps/tv-board/ws`, using the Google native-client
  Origin and the hosted Tizen-equivalent Origin.
- Both clients received `welcome`, `subscribed`, and `updates` frames. Both welcome frames advertised
  protocol version 1 and `maxUpdateHz: 30`.
- The physical Samsung package subsequently established the same route with its actual runtime
  Origin, `file://`; `file://` is allowlisted only for the `tv-board` experiment.
- `cargo test -p edge-console-gateway` passed all 68 tests.
- Tizen JavaScript passed syntax and repository ESLint checks. Tizen and Android XML files are
  well-formed; all PowerShell build/deployment scripts pass PowerShell AST parsing.
- Downloaded the official Android command-line tools, Android API/build tools 36, Gradle 9.4.1, and
  Samsung-signed Tizen Web CLI installer into the gitignored `.codex-tmp/tv-tools` directory. The
  Samsung installer signature is valid and chains to Samsung Electronics Co., Ltd.

Automated concurrent preflight result:

```json
{
  "gateway": "http://127.0.0.1:18445",
  "concurrentClients": 2,
  "application": "tv-board",
  "protocolVersion": 1,
  "maxUpdateHz": 30,
  "result": "passed"
}
```

## Sony physical-device evidence

### Build, install, and live transport

- Built `dev.edgecommons.gembatv` version `0.1.0` with min SDK 26 and target SDK 36. Android's
  `apksigner` verified the debug APK's v2 signature before installation.
- Installed and launched the APK over authorized Wi-Fi ADB at `192.168.1.223:5555`; Android reported
  the Gemba `MainActivity` as the focused foreground activity.
- Connected from the physical TV to
  `ws://192.168.1.224:18445/apps/tv-board/ws` with the registered native-client Origin.
- The TV reached **Live**, consumed real Dallas broker data, and rendered protocol-v1 `updates`
  envelopes carrying the current projected frames. A representative steady Dallas sample showed
  601 update envelopes, 5,441 frames, 9.8 Hz, and zero reconnects.
- The gateway logged the physical `tv-board` WebSocket session. Host socket inspection confirmed
  exactly one established Sony-to-gateway connection after the lifecycle test.

### Rate ceiling and coalescing

- Switched only the isolated local gateway to the generic broker on port 1883; Dallas received no
  synthetic stress traffic and its containers were not restarted or changed.
- Published one `gemba-load/burst-source` signal every 3 ms (approximately 333 Hz) for 18 seconds.
  The physical Sony client reported 29.0 update envelopes per second while the stream was active,
  immediately below the gateway's 30 Hz ceiling.
- The payload converged on the most recent source value rather than replaying every 333 Hz ingress
  sample, demonstrating state coalescing through the physical client path.
- Restored the isolated gateway to the Dallas broker after the sample. The app reconnected and
  resumed Dallas `modbus-adapter`, `opcua-adapter`, and telemetry data. All three Dallas containers
  retained their two-day uptimes and `dallas-site` remained healthy.

### Lifecycle and recovery

- Sending the app to the Google TV launcher closed its socket. Bringing the existing task back to
  the foreground created a new session, returned to **Live**, and resumed updates without creating
  multiple surviving sockets.
- Stopping only the isolated gateway moved the TV to explicit retry state. Restarting the gateway
  returned the existing app process to **Live** after its exponential-backoff window, with no app
  relaunch and no operator action.
- A screenshot taken during one redraw contained only the dynamically changing layers; a second
  capture ten seconds later contained the complete UI. This did not prevent message processing,
  but sleep/wake testing is still required before treating TV lifecycle rendering as closed.

### Device resource and rendering observation

- Under representative Dallas traffic near 10 Hz, the diagnostic app used approximately 64 MB PSS
  and 168 MB RSS in one sample, with no swap. A later sample was approximately 51 MB PSS and 155 MB
  RSS.
- Android `gfxinfo` reported 84.61% janky frames in the initial sample (46 ms median, 117 ms 90th
  percentile). The cumulative post-stress sample remained high at 69.53% janky frames.
- This is an application-rendering finding, not a WebSocket compatibility failure: the diagnostic
  client replaces a large, monospace raw-JSON `TextView` for every update. A production Andon/Gemba
  board must project typed state, update only changed widgets, and avoid rendering raw envelopes at
  the transport cadence. The 30 Hz bridge ceiling is a maximum delivery rate, not a requirement to
  repaint an entire screen 30 times per second.

## Samsung physical-device evidence

### Tooling, signing, and installation

- Installed Tizen Studio 6.1 with the TV Extension and Samsung Certificate Extension, then created
  the `edgecommons-gemba-tv` Samsung certificate profile. The distributor certificate includes the
  connected TV's DUID (`MTCKEBBVYJYJM`).
- Connected SDB to `192.168.1.196:26101`; the device identified itself as
  `UN55RU8000FXZA`. The TV accepted application installation after the development PC address and
  install permission were configured.
- Built and signed application ID `ECGEMBATV1.GembaBoard`. This 2019 TV rejected an otherwise
  valid signed WGT when its filename contained a space. Renaming `EdgeCommons Gemba.wgt` to
  `EdgeCommonsGemba.wgt` made the identical signed package install successfully. The build script
  now performs that compatibility normalization automatically.
- Replaced the SVG package icon reference with a raster PNG for compatibility with Samsung TV
  templates and older TV web runtimes.
- Rebuilt and redeployed through the repository scripts. The first scripted redeploy exposed that
  `install-permit` must be granted before each install session; `deploy-tizen.ps1` now performs that
  step, installs by the SDB serial address, and launches the app. The corrected end-to-end script
  completed successfully.

### Live transport

- Launched the installed WGT and observed a WebSocket upgrade from the TV with runtime Origin
  `file://`. Before it was allowlisted, the gateway rejected the upgrade as designed.
- Added only `file://` to the isolated `tv-board` application's allowed Origins and restarted only
  the local gateway process. The existing application reconnect loop then established physical
  session 1 at `/apps/tv-board/ws`.
- The app reached **Live** and its update-envelope/frame counters advanced while Dallas messages
  flowed. This validates the packaged Tizen web runtime, JSON protocol-v1 hello/subscription flow,
  application policy, and Dallas-to-TV data path through the same gateway used by Google TV.
- Host socket inspection showed the Samsung connection established from `192.168.1.196` to the
  local gateway at `192.168.1.224:18445`. No Dallas container was rebuilt, restarted, or replaced.
- After the evidence was captured, the verified local gateway process was stopped and port 18445
  was released. The Dallas containers remained running with their existing two-day uptimes.

### Two-TV concurrency

- Reauthorized the existing Sony ADB host key after powering on the Google TV, then launched the
  already-installed Android client without reinstalling it.
- Host socket inspection showed two simultaneous physical connections to the same local gateway:
  Samsung `192.168.1.196` and Sony `192.168.1.223`. The gateway recorded the Sony as a new
  `tv-board` session while the original Samsung session remained established.
- A Sony capture during the concurrent interval showed **Live**, 504 update envelopes, 3,475
  projected frames, a current Dallas rate of 10.1 Hz, and zero reconnects. The Samsung app remained
  **Live** with messages flowing during the same interval.
- Reinstalling and launching the Samsung WGT closed only its original session and established a new
  Samsung session while the Sony socket remained connected, returning to the same two-physical-TV
  state without restarting the gateway.

### Samsung power-cycle lifecycle

- Powering the Samsung off cleanly disconnected only its `tv-board` session; the Sony session
  remained established throughout the transition.
- Powering the Samsung back on returned to a default Samsung stream rather than resuming the
  sideloaded Gemba application. The app therefore does not provide unattended board recovery on
  this TV by itself.
- Manually launching **EdgeCommons Gemba TV** created a fresh gateway session and returned the app
  to **Live** with messages flowing. Both physical sockets were again established, demonstrating
  fresh hello/subscription, current-state redraw, and data recovery without reinstalling the app or
  restarting the gateway.
- This consumer-model observation is not a feasibility blocker for the target deployment: Samsung
  and Tizen business-oriented displays provide kiosk mode for unattended app launch. It is not a
  WebSocket recovery failure.

## Pending physical-device evidence

1. Measure Samsung CPU/memory and visible rendering behavior with representative production widget
   complexity rather than the diagnostic raw-JSON view.
2. Repeat over WSS with the intended plant certificate chain.

## Interim assessment

The shared gateway and JSON/WebSocket protocol are physically feasible on both the Sony Google TV
and Samsung Tizen TV. Both packaged clients reached **Live** and consumed Dallas updates through the
same application route without platform-specific data translation. The Sony client additionally
validated the physical 30 Hz ceiling, latest-state coalescing, foreground transitions, and gateway
loss/recovery. That run also showed that transport-rate limiting does not replace efficient
application rendering.

The unresolved cross-platform risks are production certificate trust and production dashboard
rendering cost—not RFC 6455 transport compatibility, Samsung package deployment, lifecycle
resubscription, unattended launch on kiosk-capable business displays, or two-TV concurrency.

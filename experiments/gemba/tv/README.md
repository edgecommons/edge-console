# TV client feasibility experiment

Status: Sony Google TV and Samsung Tizen physical deployment, live transport, concurrent delivery,
and post-power-cycle data recovery validation passed. The Samsung returns to its default stream
after power-on and requires explicit app relaunch on this consumer model; business-oriented
Samsung/Tizen displays provide kiosk mode for unattended launch. All source and runtime
configuration is isolated to `edge-console` on `feat/gemba`. The Dallas containers are message
sources only and are not rebuilt, restarted, or modified.

See `RESULTS.md` for the evidence captured so far and the remaining physical-device checks.

## What this tests

Both applications connect to the same gateway route and protocol:

```text
ws://192.168.1.224:18445/apps/tv-board/ws
```

They send protocol-v1 `hello` and `subscribe` frames and consume the same `updates` envelopes. The
gateway continues to enforce its 30-update-messages-per-second ceiling independently for each
connection.

- `tizen-gemba/` is a packaged Samsung TV Web application written in conservative ES5 JavaScript.
- `google-tv-gemba/` is a native Android TV application using OkHttp RFC 6455 WebSockets. OkHttp
  sends a native Ping every 15 seconds.
- `../tv-local.json` binds a separate local gateway to all LAN interfaces on port 18445 and uses a
  unique Dallas MQTT client/component identity.

The `ws://` transport, broad Tizen network access policy, Android cleartext opt-in, and synthetic
Google TV `Origin` header are feasibility mechanisms only. Production requires WSS and authenticated
device/app sessions.

## Start and verify the isolated gateway

From the edge-console repository root:

```powershell
cargo run -p edge-console-gateway -- `
  --platform HOST `
  --transport MQTT experiments/gemba/tv-local.json `
  -c FILE experiments/gemba/tv-local.json `
  -t dallas-gemba-tv-local
```

The gateway serves a hosted copy of the Tizen shell at
`http://192.168.1.224:18445/apps/tv-board/`. Before device installation, exercise two concurrent
connections with the native and hosted-client Origin values:

```powershell
node experiments/gemba/verify-tv.mjs
```

The Windows firewall must allow inbound TCP 18445 on the private LAN profile. Do not expose this
cleartext experiment on an untrusted network.

## Samsung Tizen deployment

Prerequisites:

1. Install Tizen Studio Web CLI, the matching TV Extension, and Samsung Certificate Extension.
2. Connect the TV with SDB, create a Samsung TV certificate profile, and include the connected TV's
   DUID in its distributor certificate.
3. Keep the TV in developer mode with `192.168.1.224` configured as the development PC.
4. Connect to the TV on SDB port 26101 and use **Permit to install applications**.

Build and deploy:

```powershell
experiments/gemba/tv/build-tizen.ps1 -CertificateProfile <profile-name>
experiments/gemba/tv/deploy-tizen.ps1 -TvAddress <tv-ip>
```

The tested `UN55RU8000FXZA` reports the packaged application's WebSocket Origin as `file://`. That
exact value is registered only for the isolated `tv-board` app. Do not treat `Origin` as
native-client authentication; production still requires an authenticated application/device
session.

The 2019 TV installer also rejects the signed package when the WGT filename contains a space. The
build script normalizes the generated package to `EdgeCommonsGemba.wgt` before deployment.
The deployment script grants `install-permit` on the connected SDB serial before each install; this
is required even when the same certificate profile and package were previously accepted.

The app stores an edited gateway URL in Tizen Web Storage. Focus the URL field with the remote if the
development PC address changes.

## Sony Google TV deployment

Local sideloading requires Android developer options and ADB authorization, not root access:

1. On the Sony TV, open **Settings > System > About** and press **Android TV OS build** seven times.
2. Open **Settings > System > Developer options** and enable USB debugging or Wireless debugging,
   depending on what the installed Android TV release exposes.
3. If Wireless debugging presents a pairing address and code, run `adb pair <ip>:<pair-port>` once.
4. Authorize the development PC when the TV displays its RSA confirmation prompt.

After accepting the Android SDK license and installing API/build tools 36:

```powershell
experiments/gemba/tv/build-google-tv.ps1
experiments/gemba/tv/deploy-google-tv.ps1 -DeviceAddress <tv-ip>
```

The deploy script replaces the debug APK and launches it with the LAN gateway URL through an Intent
extra, so the URL does not need to be typed with the TV remote.

The physical Sony run used a BRAVIA 4K VH2 on Android 12/API 31. Its firmware exposes one generic
**ADB debugging** switch and advertises legacy network ADB on TCP 5555; it does not present separate
USB and Wireless debugging switches. See `RESULTS.md` for the successful install, live Dallas data,
background/foreground, forced gateway reconnect, resource, and 333 Hz ingress/29 Hz egress evidence.

The physical Samsung run used a `UN55RU8000FXZA`. See `RESULTS.md` for its SDB/certificate setup,
space-free WGT filename requirement, actual `file://` Origin, live Dallas data, two-TV concurrency,
and power-cycle recovery evidence.

## Remaining physical-device evidence

- Samsung CPU/memory and visible frame drops at representative dashboard complexity.
- WSS behavior with the intended plant certificate chain.

# C7 — Full-system UNS e2e (HOST) runbook

Reusable command sequence for the whole-stack UNS test: device bus + site broker + uns-bridge
+ 2 scaffolded skeletons (TS + Python) + edge-console, verified in a headed browser.

Paths:
- LIB/monorepo:  C:\Users\breis\source\edgecommons\edgecommons
- BRIDGE:        C:\Users\breis\source\edgecommons\uns-bridge
- CONSOLE:       C:\Users\breis\source\edgecommons\edge-console
- SCRATCH (this):  ...\scratchpad\c7   (components/, run-configs/, screenshots/, logs/)

## 0. Brokers (device :1883 already running as `edgecommons-emqx`; add a clean site broker :1884)
```bash
# Device bus = the standing edgecommons-emqx on :1883 (anon, no ACL). Leave as-is.
# Site broker = a fresh anon EMQX on :1884 WITHOUT the P3-5 ACL (plaintext/anon functional test):
docker run -d --name uns-c7-site -p 1884:1883 -e EMQX_ALLOW_ANONYMOUS=true emqx/emqx:5.8.2
#   NB: deploy/site-broker/docker-compose.yml's `site` service mounts acl.conf whose trailing
#   {deny,all} blocks anonymous PLAINTEXT — so it is NOT usable for an anon functional test.
#   Use the plain container above (ACL boundary already proven in P3-5).
```

## 1. Scaffold 2 skeletons from the LATEST templates (CLI is a fixed pip install → point at live repo)
```bash
cd <SCRATCH>/c7/components
edgecommons create-component -n com.example.TsSensor -l TYPESCRIPT -p . \
  -u <LIB>/templates/typescript -g <LIB>/libs/ts --dep-source local --platforms HOST
edgecommons create-component -n com.example.PyMeter  -l PYTHON     -p . \
  -u <LIB>/templates/python                        --dep-source local --platforms HOST
```

## 2. Build the skeletons against the sibling lib
```bash
# TS: sibling libs/ts must be built (dist/) first; file: dep resolves it
cd <SCRATCH>/c7/components/TsSensor && npm install && npm run build
# Python: edgecommons is already editable-installed from libs/python (import works globally).
#   Otherwise: pip install -e <LIB>/libs/python
```

## 3. Build the bridge + console (once)
```bash
cd <BRIDGE> && cargo build --features standalone         # or run the prebuilt target/debug/uns-bridge.exe
cd <CONSOLE> && npm run link:lib && npm run link:rust && npm install && npm run build
# protocol -> ui -> Rust edge-console-gateway
```

## 4. Run configs (in <SCRATCH>/c7/run-configs) — messaging → DEVICE :1883, metricEmission=messaging
`tssensor-config.json` / `pymeter-config.json`: hierarchy [site,device], identity.site=dallas,
heartbeat.intervalSecs=5, **metricEmission.target=messaging** (template default is "log" → no
metric reaches the bus; MUST override for the console Metrics tab). `*-messaging.json`: distinct
clientId (c7-tssensor-local / c7-pymeter-local), port 1883.

## 5. Launch the stack (each in its own shell / background)
```bash
# BRIDGE (device :1883 <-> site :1884), device identity gw-01:
cd <BRIDGE> && ./target/debug/uns-bridge.exe --config ./test-configs/config.json --thing gw-01

# SKELETONS — both on device gw-01 (the bridge PINS downlink to its own device, so commands only
# reach gw-01; distinct COMPONENT names, same device = the real single-gateway topology):
cd <SCRATCH>/c7/components/TsSensor && node dist/main.js \
  --platform HOST --transport MQTT <SCRATCH>/c7/run-configs/tssensor-messaging.json \
  -c FILE <SCRATCH>/c7/run-configs/tssensor-config.json -t gw-01
cd <SCRATCH>/c7/components/PyMeter && python main.py \
  --platform HOST --transport MQTT <SCRATCH>/c7/run-configs/pymeter-messaging.json \
  -c FILE <SCRATCH>/c7/run-configs/pymeter-config.json -t gw-01

# CONSOLE gateway (site :1884), distinct thing so it doesn't self-appear under gw-01:
cd <CONSOLE> && target/release/edge-console-gateway \
  --platform HOST --transport MQTT ./test-configs/config.json \
  -c FILE ./test-configs/config.json -t site-console        # WS gateway on 0.0.0.0:8443/ws

# UI (Vite dev server, for hot-reload). IMPORTANT: after any protocol/ version bump, start
# with --force or the stale dep-prebundle sends an old protocolVersion and the gateway
# rejects the hello (v-mismatch):
cd <CONSOLE> && npm run dev -w ui -- --force                # http://localhost:5173 (proxies /ws->8443)
```

### 5b. Alternative: a BUILT, self-contained deployment (no Vite, no nginx)

Since the static-UI-serving slice, the console gateway can serve its own built UI on the
SAME port as the WS gateway — set `component.global.console.ws.webRoot` to the built
`ui/dist` (relative paths resolve against the gateway's cwd) and skip step 5's Vite
process entirely:

```bash
# test-configs/config.json: add `"webRoot": "ui/dist"` under component.global.console.ws
# (relative to <CONSOLE>, the gateway's cwd when launched with `cd <CONSOLE>`) - or
# point it at an absolute path to a built ui/dist.
cd <CONSOLE> && target/release/edge-console-gateway \
  --platform HOST --transport MQTT ./test-configs/config.json \
  -c FILE ./test-configs/config.json -t site-console
# Browse straight to http://localhost:8443/ — the console serves index.html + the
# hashed assets itself; no :5173, no separate front. (TLS/HTTPS termination is still a
# separate, not-yet-built concern — the server is plain http either way.)
```

## 6. Verify (headed browser at http://localhost:5173, or http://localhost:8443 for 5b)
1. Overview: gw-01 shows TsSensor/PyMeter/uns-bridge FRESH; keepalive "5s · cfg".
2. Configuration → pick TsSensor → Refresh: "received … ago" resets (real republish-cfg round-trip).
3. Events: alternating TsSensor/PyMeter sample-events, live tail.
4. Metrics: loopTicks tickCount/uptimeSecs per skeleton, moving sparklines; bridge relay_* counters.
5. Overview → expand a row → Ping / Get configuration / Reload config; Send command… set-greeting
   {"greeting":"..."}  → all reply ~50ms (through the bridge reply_to rewrite).
6. Failure modes: kill a skeleton → WARN→STALE→OFFLINE (~25s at 5s cadence); kill bridge →
   whole gw-01 UNREACHABLE (site-broker LWT); restart bridge → recovery (periodic state keepalive
   reconverges within one interval; the bridge does NOT fire a reconnect rehydration _bcast).

## 7. Teardown
```bash
# kill node (skeleton+console+vite), python (skeleton), uns-bridge.exe; close browser
docker stop uns-c7-site && docker rm uns-c7-site        # leave edgecommons-emqx running
rm -rf <CONSOLE>/.playwright-mcp                          # or wherever the MCP wrote artifacts
netstat -ano | grep -E ":1884|:5173|:8443"               # confirm free
```

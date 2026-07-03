#!/usr/bin/env node
/**
 * Demo gateway — the REAL C2+C5 stack (server/dist FleetModel + ConfigStore +
 * FleetWsGateway + WsServer) fed a synthetic fleet, so the edge-health AND
 * config-review UIs (slices C3/C5) can be driven in a browser without a site broker
 * or real components:
 *
 *   npm run build                       # server/dist must exist
 *   node scripts/demo-gateway.mjs       # gateway on ws://127.0.0.1:8443/ws
 *   npm run dev -w ui                   # http://localhost:5173 (vite proxies /ws)
 *
 * NOTE: this bypasses ONLY the BusIngress/MQTT edge (the C1 slice already proven
 * against the dual-EMQX rig); everything from the FleetModel/ConfigStore through the
 * WS wire to the browser is the shipped code path. The synthetic fleet exercises the
 * whole liveness ladder: healthy keepalives, one flapping component (periodic silence
 * ⇒ WARN → STALE → OFFLINE → recovery), one graceful STOPPED, one restart (uptime
 * reset), one device whose bridge "dies" (raw-LWT UNREACHABLE) and recovers — plus,
 * for config-review: `cfg` announcements with source-redacted secrets (`"***"`) and
 * `$secret` refs, one component that never pushes cfg (the UNAVAIL path), and a
 * simulated device-side republish listener so the UI's Refresh visibly re-pushes.
 */
import { FleetModel } from "../server/dist/fleet/fleet-model.js";
import { ConfigStore } from "../server/dist/fleet/config-store.js";
import { FleetWsGateway } from "../server/dist/ws/gateway.js";
import { WsServer } from "../server/dist/ws/ws-server.js";

const PORT = Number(process.env.DEMO_PORT ?? 8443);
const clock = () => Date.now();

const model = new FleetModel(clock);
const configs = new ConfigStore(clock);

/** The composition root's ingress tee: FleetModel + ConfigStore (console-app.ts shape). */
function ingest(event) {
  model.ingest(event);
  configs.ingest(event);
}

/** Build the IngressEvent for one component's state keepalive. */
function stateEvent(site, device, component, body, instance = "main") {
  return {
    kind: "envelope",
    cls: "state",
    identity: {
      hier: [
        { level: "site", value: site },
        { level: "device", value: device },
      ],
      path: `${site}/${device}`,
      component,
      instance,
    },
    body,
    sourceTimestamp: new Date().toISOString(),
    topic: `ecv1/${device}/${component}/${instance}/state`,
  };
}

/** A `cfg` announcement (body {"config": {...}} — the shipped publisher's shape). */
function cfgEvent(site, device, component, config) {
  return {
    ...stateEvent(site, device, component, { config }),
    cls: "cfg",
    topic: `ecv1/${device}/${component}/main/cfg`,
  };
}

const started = Date.now();
const uptime = (offsetSecs = 0) => Math.floor((Date.now() - started) / 1000) + offsetSecs;

// ---- the synthetic site ----------------------------------------------------
const SITE = "dallas";
let tick = 0;
let modbusRestartBase = 3600; // pretends it was up an hour before a later restart

// ---- effective configs (redaction as the library publisher would emit it) ---
/** A realistic redacted effective config for one component. */
function demoConfig(component, extra = {}) {
  return {
    heartbeat: { intervalSecs: 5 },
    hierarchy: ["site", "device"],
    logging: { level: "INFO", destination: "FILE" },
    messaging: {
      requestTimeoutSeconds: 30,
      local: {
        host: "emqx.local",
        port: 1883,
        credentials: { username: `${component}-svc`, password: "***" }, // lib-redacted
      },
    },
    ...extra,
  };
}

/**
 * Per-device cfg announcements — the demo's "device-side republish-cfg listener".
 * NOTE: asm-gw-01/file-replicator deliberately has NO cfg (the UNAVAIL path).
 */
const cfgAnnouncements = {
  "press-gw-01": [
    () =>
      cfgEvent(SITE, "press-gw-01", "opcua-adapter", demoConfig("opcua-adapter", {
        endpoint: { url: "opc.tcp://192.168.1.180:49320", securityPolicy: "Basic256Sha256" },
        signals: ["Channel1.Device1.Temp_01", "Channel1.Device1.Pressure"],
        auth: { apiKey: "$secret:opcua-server-key" }, // vault ref — travels untouched
      })),
    () =>
      cfgEvent(SITE, "press-gw-01", "modbus-adapter", demoConfig("modbus-adapter", {
        slave: { host: "192.168.1.224", port: 5020, unitId: 1, pollMs: 250 },
      })),
    () =>
      cfgEvent(SITE, "press-gw-01", "telemetry-processor", demoConfig("telemetry-processor", {
        pipeline: [{ filter: "quality == 'GOOD'" }, { sample: { everyN: 10 } }],
        streams: { northbound: { kind: "kinesis", credentials: { pin: "***" } } },
      })),
    () => cfgEvent(SITE, "press-gw-01", "batch-runner", demoConfig("batch-runner")),
  ],
  "pack-gw-01": [
    () =>
      cfgEvent(SITE, "pack-gw-01", "opcua-adapter", demoConfig("opcua-adapter", {
        endpoint: { url: "opc.tcp://192.168.1.181:49320" },
      })),
    () => cfgEvent(SITE, "pack-gw-01", "modbus-adapter", demoConfig("modbus-adapter")),
  ],
  "asm-gw-01": [
    () => cfgEvent(SITE, "asm-gw-01", "telemetry-processor", demoConfig("telemetry-processor")),
    // file-replicator: never announces cfg — config-review shows UNAVAIL for it.
  ],
};

const gateway = new FleetWsGateway(
  model,
  { clock },
  {
    configs,
    // The demo's stand-in for BusIngress.broadcastRepublish + the device-side S1
    // listener: ~800 ms after a refresh-config, the device's components re-push cfg.
    refreshDevice: (device) => {
      console.log(`[demo] refresh-config -> republish-cfg broadcast to ${device}`);
      const announcements = cfgAnnouncements[device] ?? [];
      setTimeout(() => {
        for (const announce of announcements) ingest(announce());
        console.log(`[demo] ${device}: ${announcements.length} cfg re-announced`);
      }, 800);
    },
  },
);
const server = new WsServer(gateway, { port: PORT, bindAddress: "127.0.0.1" });

function feed() {
  tick++;

  // press-gw-01: three healthy components (5 s cadence).
  for (const comp of ["opcua-adapter", "modbus-adapter", "telemetry-processor"]) {
    ingest(stateEvent(SITE, "press-gw-01", comp, { status: "RUNNING", uptimeSecs: uptime() }));
  }

  // pack-gw-01/opcua-adapter FLAPS: silent for 40 s of every 70 s window
  // (watch it walk FRESH -> WARN -> STALE -> OFFLINE and recover).
  if (tick % 14 < 6) {
    ingest(stateEvent(SITE, "pack-gw-01", "opcua-adapter", { status: "RUNNING", uptimeSecs: uptime() }));
  }

  // pack-gw-01/modbus-adapter: restarts every 60 s (uptimeSecs reset).
  if (tick % 12 === 0) modbusRestartBase = -uptime();
  ingest(
    stateEvent(SITE, "pack-gw-01", "modbus-adapter", {
      status: "RUNNING",
      uptimeSecs: uptime(modbusRestartBase < 0 ? modbusRestartBase : 3600),
    }),
  );

  // asm-gw-01: healthy pair, but the whole device goes UNREACHABLE (bridge LWT)
  // for 30 s of every 90 s window.
  const asmDown = tick % 18 >= 12;
  if (asmDown) {
    if (tick % 18 === 12) {
      ingest({
        kind: "device-unreachable",
        device: "asm-gw-01",
        topic: "ecv1/asm-gw-01/uns-bridge/main/state",
      });
      console.log("[demo] asm-gw-01 bridge DOWN (raw LWT)");
    }
  } else {
    for (const comp of ["telemetry-processor", "file-replicator"]) {
      ingest(stateEvent(SITE, "asm-gw-01", comp, { status: "RUNNING", uptimeSecs: uptime() }));
    }
  }

  // press-gw-01/batch-runner: runs 40 s, then STOPS gracefully for 35 s.
  if (tick % 15 === 8) {
    ingest(stateEvent(SITE, "press-gw-01", "batch-runner", { status: "STOPPED" }));
  } else if (tick % 15 < 8) {
    ingest(stateEvent(SITE, "press-gw-01", "batch-runner", { status: "RUNNING", uptimeSecs: uptime() }));
  }
}

await server.start();
console.log(`[demo] C2+C5 gateway (real FleetModel/ConfigStore/FleetWsGateway/WsServer) on ws://127.0.0.1:${PORT}/ws`);

// cfg announcements on "startup" (the publish-on-startup half of the cfg contract);
// cadence sources become "cfg" wherever heartbeat.intervalSecs is announced.
for (const announcements of Object.values(cfgAnnouncements)) {
  for (const announce of announcements) ingest(announce());
}
feed();

const feeder = setInterval(feed, 5000); // the 5 s keepalive cadence
const sweeper = setInterval(() => model.sweep(), 1000); // the C1 staleness sweeper
const ticker = setInterval(() => gateway.tick(), 15000); // WS heartbeats

process.on("SIGINT", async () => {
  clearInterval(feeder);
  clearInterval(sweeper);
  clearInterval(ticker);
  await server.stop();
  process.exit(0);
});

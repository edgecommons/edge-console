#!/usr/bin/env node
/**
 * Demo gateway — the REAL C2 stack (server/dist FleetModel + FleetWsGateway +
 * WsServer) fed a synthetic fleet, so the edge-health UI (slice C3) can be driven
 * in a browser without a site broker or real components:
 *
 *   npm run build                       # server/dist must exist
 *   node scripts/demo-gateway.mjs       # gateway on ws://127.0.0.1:8443/ws
 *   npm run dev -w ui                   # http://localhost:5173 (vite proxies /ws)
 *
 * NOTE: this bypasses ONLY the BusIngress/MQTT edge (the C1 slice already proven
 * against the dual-EMQX rig); everything from the FleetModel through the WS wire to
 * the browser is the shipped code path. The synthetic fleet exercises the whole
 * liveness ladder: healthy keepalives, one flapping component (periodic silence ⇒
 * WARN → STALE → OFFLINE → recovery), one graceful STOPPED, one restart (uptime
 * reset), and one device whose bridge "dies" (raw-LWT UNREACHABLE) and recovers.
 */
import { FleetModel } from "../server/dist/fleet/fleet-model.js";
import { FleetWsGateway } from "../server/dist/ws/gateway.js";
import { WsServer } from "../server/dist/ws/ws-server.js";

const PORT = Number(process.env.DEMO_PORT ?? 8443);
const clock = () => Date.now();

const model = new FleetModel(clock);
const gateway = new FleetWsGateway(model, { clock });
const server = new WsServer(gateway, { port: PORT, bindAddress: "127.0.0.1" });

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

function cfgEvent(site, device, component, intervalSecs) {
  return {
    ...stateEvent(site, device, component, { config: { heartbeat: { intervalSecs } } }),
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

function feed() {
  tick++;

  // press-gw-01: three healthy components (5 s cadence).
  for (const comp of ["opcua-adapter", "modbus-adapter", "telemetry-processor"]) {
    model.ingest(stateEvent(SITE, "press-gw-01", comp, { status: "RUNNING", uptimeSecs: uptime() }));
  }

  // pack-gw-01/opcua-adapter FLAPS: silent for 40 s of every 70 s window
  // (watch it walk FRESH -> WARN -> STALE -> OFFLINE and recover).
  if (tick % 14 < 6) {
    model.ingest(stateEvent(SITE, "pack-gw-01", "opcua-adapter", { status: "RUNNING", uptimeSecs: uptime() }));
  }

  // pack-gw-01/modbus-adapter: restarts every 60 s (uptimeSecs reset).
  if (tick % 12 === 0) modbusRestartBase = -uptime();
  model.ingest(
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
      model.ingest({
        kind: "device-unreachable",
        device: "asm-gw-01",
        topic: "ecv1/asm-gw-01/uns-bridge/main/state",
      });
      console.log("[demo] asm-gw-01 bridge DOWN (raw LWT)");
    }
  } else {
    for (const comp of ["telemetry-processor", "file-replicator"]) {
      model.ingest(stateEvent(SITE, "asm-gw-01", comp, { status: "RUNNING", uptimeSecs: uptime() }));
    }
  }

  // press-gw-01/batch-runner: runs 40 s, then STOPS gracefully for 35 s.
  if (tick % 15 === 8) {
    model.ingest(stateEvent(SITE, "press-gw-01", "batch-runner", { status: "STOPPED" }));
  } else if (tick % 15 < 8) {
    model.ingest(stateEvent(SITE, "press-gw-01", "batch-runner", { status: "RUNNING", uptimeSecs: uptime() }));
  }
}

await server.start();
console.log(`[demo] C2 gateway (real FleetModel/FleetWsGateway/WsServer) on ws://127.0.0.1:${PORT}/ws`);

// cfg announcements: cadence sources become "cfg" for these two.
model.ingest(cfgEvent(SITE, "press-gw-01", "opcua-adapter", 5));
model.ingest(cfgEvent(SITE, "pack-gw-01", "opcua-adapter", 5));
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

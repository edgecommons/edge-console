#!/usr/bin/env node
/**
 * Demo gateway — the REAL C2+C5+C6 stack (server/dist FleetModel + ConfigStore +
 * EventStore + MetricStore + FleetWsGateway + WsServer) fed a synthetic fleet, so
 * the edge-health, config-review, events AND metrics UIs (slices C3/C5/C6) can be
 * driven in a browser without a site broker or real components:
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
 * For C6: a varied `evt` stream (components x severities, live-appending) and
 * moving `metric` series (EMF-shaped `sys` cpu/memory per component + a bridge
 * `relay_dropped_data` counter) so the sparklines visibly move.
 *
 * For C4: a fake CommandInbox-like responder stands in for the site-bus request/reply
 * (the injected CommandGateway `request` fn): ping → {status, uptimeSecs}, describe → the
 * descriptor-driven component panel manifest, get-configuration → the component's demo
 * config, reload-config → {reloaded:true}, an unknown verb → UNKNOWN_VERB, and one
 * deliberately-SLOW component (telemetry-processor) → TIMEOUT. The demo RBAC policy denies
 * the verb `reboot`, so invoking it shows FORBIDDEN.
 */
import { FleetModel } from "../server/dist/fleet/fleet-model.js";
import { ConfigStore } from "../server/dist/fleet/config-store.js";
import { EventStore } from "../server/dist/fleet/event-store.js";
import { MetricStore } from "../server/dist/fleet/metric-store.js";
import { SignalStore } from "../server/dist/fleet/signal-store.js";
import { AttributeStore } from "../server/dist/fleet/attribute-store.js";
import { AlarmTracker } from "../server/dist/fleet/alarm-tracker.js";
import { ThroughputMeter } from "../server/dist/fleet/throughput-meter.js";
import { ConsoleSelfMonitor } from "../server/dist/fleet/console-self.js";
import { CommandGateway } from "../server/dist/command/command-gateway.js";
import { ConfigRbacPolicy } from "../server/dist/command/rbac.js";
import { consoleConfigFromGlobal } from "../server/dist/console-config.js";
import { consoleSettings } from "../server/dist/fleet/console-settings.js";
import { FleetWsGateway } from "../server/dist/ws/gateway.js";
import { WsServer } from "../server/dist/ws/ws-server.js";
import { MessageBuilder, MessageIdentity, RequestTimeoutError, Uns } from "@edgecommons/edgecommons";

const PORT = Number(process.env.DEMO_PORT ?? 8443);
const clock = () => Date.now();

const model = new FleetModel(clock);
const configs = new ConfigStore(clock);
const events = new EventStore(clock);
const metrics = new MetricStore(clock);
// R0 foundation stores: the data plane (signals), runtime attributes, console alarms.
const signals = new SignalStore(clock);
const attributes = new AttributeStore(clock);
const alarms = new AlarmTracker(clock);
// R1: the console's own bus-ingest throughput (the Overview "Edge bus msgs/s" tile + sparkline).
const throughput = new ThroughputMeter(clock);
// R1: the console's own self-identity + process vitals (the "Edge node console self" tile). The
// identity/platform/transport/broker are the demo's synthetic console self (matching the mockup's
// gw-dallas-01 / HOST / MQTT / EMQX @ gateway); the cpu/mem/uptime are this REAL node process
// (the honest half — the same nodeSelfSampler the live console uses).
const consoleSelfInfo = {
  device: "gw-dallas-01",
  component: "edge-console",
  platform: "HOST",
  transport: "MQTT",
  broker: "EMQX @ gateway",
};
const selfMonitor = new ConsoleSelfMonitor(consoleSelfInfo);
// Per-device platform advertised via the state-envelope `tags.platform` (config-driven metadata),
// so the Overview group rows show the mockup's `press-gw-01 (Greengrass)` / `pack-gw-01 (HOST)`.
const PLATFORM_OF = {
  "press-gw-01": "GREENGRASS",
  "pack-gw-01": "HOST",
  "asm-gw-01": "HOST",
};

// R0: device-reachability transitions drive alarm CONTAINMENT (a device going
// UNREACHABLE suppresses its components' alarms; recovery releases them).
model.onDelta((deltas) => {
  for (const d of deltas) {
    if (d.type === "device-reachability-changed") alarms.setDeviceContainment(d.device, d.unreachable);
  }
});

/** The composition root's ingress tee: FleetModel + side stores (console-app.ts shape). */
function ingest(event) {
  throughput.mark();
  model.ingest(event);
  configs.ingest(event);
  events.ingest(event);
  metrics.ingest(event);
  signals.ingest(event);
  attributes.ingest(event);
  alarms.ingest(event);
}

/**
 * The synthetic site is 3 lines (the mockup groups the fleet BY LINE); each device
 * belongs to one. The identity hierarchy is therefore site → line → device (3 levels),
 * so the console can group + build topology DYNAMICALLY from `hierarchy.levels` (never a
 * hardcoded "line" tier).
 */
const LINE_OF = {
  "press-gw-01": "stamping",
  "pack-gw-01": "packaging",
  "asm-gw-01": "assembly",
};

/** Build the IngressEvent for one component's state keepalive. */
function stateEvent(site, device, component, body, instance = "main") {
  const line = LINE_OF[device] ?? "unassigned";
  return {
    kind: "envelope",
    cls: "state",
    identity: {
      hier: [
        { level: "site", value: site },
        { level: "line", value: line },
        { level: "device", value: device },
      ],
      path: `${site}/${line}/${device}`,
      component,
      instance,
    },
    // The device's deployment platform, advertised as config-driven envelope metadata (R1).
    ...(PLATFORM_OF[device] !== undefined ? { tags: { platform: PLATFORM_OF[device] } } : {}),
    body,
    sourceTimestamp: new Date().toISOString(),
    topic: `ecv1/${device}/${component}/${instance}/state`,
  };
}

/** A `data/{signal}` telemetry sample — the DATA plane ({value, quality}). */
function dataEvent(site, device, component, signal, value, quality = "GOOD") {
  return {
    ...stateEvent(site, device, component, { value, quality }),
    cls: "data",
    channel: signal,
    topic: `ecv1/${device}/${component}/main/data/${signal}`,
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

/** An `evt` on the `evt/{severity}/{type}` convention. */
function evtEvent(site, device, component, severity, type, body) {
  return {
    ...stateEvent(site, device, component, body),
    cls: "evt",
    channel: `${severity}/${type}`,
    topic: `ecv1/${device}/${component}/main/evt/${severity}/${type}`,
  };
}

/** A `metric/{name}` sample (EMF-shaped for `sys`, like the library publisher). */
function metricEvent(site, device, component, name, measures) {
  return {
    ...stateEvent(site, device, component, {
      coreName: device,
      category: name,
      component,
      ...measures,
      _aws: { Timestamp: Date.now(), CloudWatchMetrics: [] },
    }),
    cls: "metric",
    channel: name,
    topic: `ecv1/${device}/${component}/main/metric/${name}`,
  };
}

const started = Date.now();
const uptime = (offsetSecs = 0) => Math.floor((Date.now() - started) / 1000) + offsetSecs;

// ---- the synthetic site ----------------------------------------------------
const SITE = "dallas";
let tick = 0;
let modbusRestartBase = 3600; // pretends it was up an hour before a later restart
let relayDropped = 0; // the bridge's monotonic drop counter (bursts during asm outages)

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

function row(label, value) {
  return { label, value };
}

function summaryWidget(id, title, rows) {
  return { kind: "summary", id, title, rows };
}

function commandSummaryWidget(id, title, verbs) {
  return { kind: "commandSummary", id, title, verbs };
}

function opcuaPanelDescriptor() {
  return {
    schemaVersion: "edgecommons.component.describe.v1",
    component: {
      hier: { site: SITE, line: "packaging", device: "pack-gw-01" },
      path: `${SITE}/packaging/pack-gw-01`,
      component: "opcua-adapter",
      instance: "main",
    },
    commands: [
      { verb: "describe", builtIn: true },
      { verb: "get-configuration", builtIn: true },
      { verb: "ping", builtIn: true },
      { verb: "reload-config", builtIn: true },
      { verb: "sb/browse", builtIn: false },
      { verb: "sb/read", builtIn: false },
      { verb: "sb/rescan", builtIn: false },
      { verb: "sb/status", builtIn: false },
      { verb: "sb/subscriptions", builtIn: false },
      { verb: "sb/write", builtIn: false },
    ],
    panels: {
      schemaVersion: "edgecommons.panels.v2",
      provider: "opcua-adapter",
      renderer: "descriptor",
      defaultView: "overview",
      views: [
        {
          id: "overview",
          title: "Overview",
          order: 10,
          widgets: [
            summaryWidget("opcua-summary", "OPC UA adapter", [
              row("Address space", "Paged browse via cmd/sb/browse"),
              row("Reads", "Explicit node reads and configured-signal matching"),
              row("Diagnostics", "Status, subscriptions, and rescan commands"),
            ]),
            commandSummaryWidget("opcua-command-bindings", "Command bindings", [
              "sb/status",
              "sb/browse",
              "sb/read",
              "sb/write",
              "sb/subscriptions",
              "sb/rescan",
            ]),
          ],
        },
        {
          id: "address-space",
          title: "Address Space",
          order: 20,
          widgets: [
            {
              kind: "treeBrowser",
              id: "address-space-tree",
              title: "Address space",
              scope: "instance",
              mode: "paged",
              browseVerb: "sb/browse",
              readVerb: "sb/read",
              writeVerb: "sb/write",
            },
          ],
        },
        {
          id: "signals",
          title: "Signals",
          order: 30,
          widgets: [
            {
              kind: "signalGrid",
              id: "configured-signals",
              title: "Configured signals",
              scope: "instance",
              subscriptionsVerb: "sb/subscriptions",
              readVerb: "sb/read",
            },
          ],
        },
        {
          id: "diagnostics",
          title: "Diagnostics",
          order: 40,
          widgets: [
            commandSummaryWidget("diagnostic-commands", "Diagnostic commands", [
              "sb/status",
              "sb/subscriptions",
              "sb/rescan",
            ]),
            summaryWidget("diagnostic-notes", "Diagnostics", [
              row("Status", "Live southbound session and address-space counters"),
              row("Subscriptions", "Configured signal bindings by instance"),
              row("Rescan", "Rebuild the discovered address-space cache"),
            ]),
          ],
        },
      ],
    },
    digest: "sha256:demo-opcua-panels",
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
    () =>
      cfgEvent(SITE, "pack-gw-01", "modbus-adapter", demoConfig("modbus-adapter", {
        // Topology (R3): a real slave the adapter connects to — but its southbound_health
        // reports DISCONNECTED below, so the topology draws the "adapter UP, device link DOWN"
        // red-dashed-✕ edge (the fault pinned to the exact edge, not the whole device).
        slave: { host: "192.168.1.50", port: 502, unitId: 3, pollMs: 500 },
      })),
  ],
  "asm-gw-01": [
    () =>
      cfgEvent(SITE, "asm-gw-01", "telemetry-processor", demoConfig("telemetry-processor", {
        // A northbound cloud target → a second cloud node (AWS IoT Core); when asm-gw-01 goes
        // UNREACHABLE the containment shows on the whole subtree, this edge included.
        streams: { northbound: { kind: "iot-core", credentials: { pin: "***" } } },
      })),
    // file-replicator: never announces cfg — config-review shows UNAVAIL for it.
  ],
};

// ---- C4: the command seam (a fake CommandInbox responder for the request edge) ------
const consoleIdentity = new MessageIdentity([{ level: "device", value: "gw-console" }], "edge-console");
const uns = new Uns(consoleIdentity, false);
// The demo RBAC policy: operator (full control EXCEPT reboot — so a Send-command "reboot" shows
// FORBIDDEN) + a read-only viewer, so the Settings screen (R6) shows a realistic two-role policy.
const demoRbacConfig = {
  defaultRole: "operator",
  roles: {
    operator: { allow: ["*"], deny: ["reboot"] },
    viewer: {
      allow: ["ping", "describe", "get-configuration", "sb/status", "sb/browse", "sb/read", "sb/subscriptions"],
      deny: [],
    },
  },
};
const rbac = new ConfigRbacPolicy(demoRbacConfig);
// The console's own effective policy + configuration behind the read-only Settings screen (R6):
// the demo RBAC over the parsed defaults, plus the demo's synthetic console self-identity.
const demoConsoleConfig = consoleConfigFromGlobal({ console: { rbac: demoRbacConfig } });

/** The fake site-bus request edge: reply as a real edgecommons CommandInbox would. */
function fakeComponentRequest(topic) {
  const parts = topic.split("/"); // ecv1/{device}/{component}/{instance}/cmd/{verb...}
  const component = parts[2];
  const verb = parts.slice(5).join("/");
  const reply = (body) => MessageBuilder.create(verb, "1.0").withPayload(body).build();

  // One component is deliberately slow → the console maps the rejection to TIMEOUT.
  if (component === "telemetry-processor") {
    return new Promise((_resolve, reject) =>
      setTimeout(() => reject(new RequestTimeoutError(`request on '${topic}' timed out`)), 1500),
    );
  }
  // Realistic per-verb replies (uns-test-vectors/commands.json shapes).
  return new Promise((resolve) => {
    setTimeout(() => {
      if (verb === "ping") {
        resolve(reply({ ok: true, result: { status: "RUNNING", uptimeSecs: uptime() } }));
      } else if (verb === "describe") {
        resolve(reply({ ok: true, result: component === "opcua-adapter" ? opcuaPanelDescriptor() : { commands: [] } }));
      } else if (verb === "get-configuration") {
        resolve(reply({ ok: true, result: { config: demoConfig(component) } }));
      } else if (verb === "reload-config") {
        resolve(reply({ ok: true, result: { reloaded: true } }));
      } else if (verb === "sb/status") {
        resolve(reply({ ok: true, result: { id: "main", connected: true, metrics: { nodes: 128, subscriptions: 2 } } }));
      } else if (verb === "sb/browse") {
        resolve(
          reply({
            ok: true,
            result: {
              id: "main",
              offset: 0,
              limit: 100,
              total: 4,
              nodes: [
                { signalId: "Channel1.Device1.Temp_01", namespace: 2, idType: "String", browseName: "Temp_01" },
                { signalId: "Channel1.Device1.Pressure", namespace: 2, idType: "String", browseName: "Pressure" },
                { signalId: "Channel1.Device1.Flow_A", namespace: 2, idType: "String", browseName: "Flow_A" },
                { signalId: "Channel1.Device1.MotorState", namespace: 2, idType: "String", browseName: "MotorState" },
              ],
            },
          }),
        );
      } else if (verb === "sb/subscriptions") {
        resolve(
          reply({
            ok: true,
            result: {
              id: "main",
              signals: [
                { signalId: "Channel1.Device1.Temp_01", namespace: 2, idType: "String", match: "Temp_.*" },
                { signalId: "Channel1.Device1.Pressure", namespace: 2, idType: "String", match: "Pressure" },
              ],
            },
          }),
        );
      } else if (verb === "sb/read") {
        // The Signals-screen "Read": an on-demand southbound re-read of one signal. The demo
        // synthesizes a fresh reading (a real component would return its live value + quality).
        resolve(
          reply({
            ok: true,
            result: { value: Math.round(Math.random() * 1000) / 10, quality: "GOOD", at: new Date().toISOString() },
          }),
        );
      } else {
        resolve(
          reply({
            ok: false,
            error: { code: "UNKNOWN_VERB", message: `verb '${verb}' is not registered on this component` },
          }),
        );
      }
    }, 250); // a visible round-trip
  });
}

const commandGateway = new CommandGateway({
  uns,
  newMessage: (name) => MessageBuilder.create(name, "1.0"),
  request: fakeComponentRequest,
  rbac,
  clock,
});

const gateway = new FleetWsGateway(
  model,
  {
    clock,
    busThroughput: () => throughput.ratePerSec(),
    busRecentRates: () => throughput.recentRates(),
    consoleSelf: () => selfMonitor.sample(),
    // R6: the console's own effective policy + configuration behind the read-only Settings screen.
    consoleSettings: () => consoleSettings(demoConsoleConfig, consoleSelfInfo),
  },
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
  // The activity seam: C6 events/metrics + the R0 signals/attributes/alarms surfaces.
  { events, metrics, signals, attributes, alarms },
  // The C4 command seam: invoke-command → the fake CommandInbox responder, RBAC-gated.
  { gateway: commandGateway, rbac },
);
const server = new WsServer(gateway, { port: PORT, bindAddress: "127.0.0.1" });

function feed() {
  tick++;

  // press-gw-01: three healthy components + its bridge (5 s cadence).
  for (const comp of ["opcua-adapter", "modbus-adapter", "telemetry-processor", "uns-bridge"]) {
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

  // ---- C6: moving metric series (EMF-shaped sys per component + a bridge counter).
  // Sinusoids + jitter so every sparkline visibly moves tick to tick.
  const wave = (base, amp, phase) =>
    Math.round((base + amp * Math.sin(tick / 3 + phase) + Math.random() * amp * 0.3) * 10) / 10;
  ingest(metricEvent(SITE, "press-gw-01", "opcua-adapter", "sys", {
    cpu: wave(22, 9, 0),
    memory: wave(38, 3, 1),
  }));
  ingest(metricEvent(SITE, "press-gw-01", "modbus-adapter", "sys", {
    cpu: wave(11, 5, 2),
    memory: wave(24, 2, 3),
  }));
  ingest(metricEvent(SITE, "press-gw-01", "telemetry-processor", "sys", {
    cpu: wave(41, 14, 4),
    memory: wave(55, 6, 5),
  }));
  relayDropped += asmDown ? Math.floor(Math.random() * 40) + 10 : 0; // bursts while the WAN path is down
  ingest(metricEvent(SITE, "press-gw-01", "uns-bridge", "relay_dropped_data", {
    dropped: relayDropped,
  }));

  // ---- R0: southbound_health metrics -> the per-component runtime ATTRIBUTES (conn state).
  ingest(metricEvent(SITE, "press-gw-01", "opcua-adapter", "southbound_health", {
    connectionState: "CONNECTED",
    readErrors: 0,
    writeErrors: 0,
  }));
  ingest(metricEvent(SITE, "press-gw-01", "modbus-adapter", "southbound_health", {
    connectionState: tick % 5 === 2 ? "RECONNECTING" : "CONNECTED",
    readErrors: Math.floor(tick / 5),
    writeErrors: 0,
  }));
  // pack-gw-01/modbus-adapter: the adapter itself is alive (it restarts, keepalives flow) but
  // its Modbus link to the conveyor slave is DOWN — the Topology "adapter up, device link down"
  // case (a red, dashed, ✕'d southbound edge with a red field node).
  ingest(metricEvent(SITE, "pack-gw-01", "modbus-adapter", "southbound_health", {
    connectionState: "DISCONNECTED",
    readErrors: 40 + tick,
    writeErrors: 3,
  }));
  // pack-gw-01/opcua-adapter: a healthy southbound link to its OPC UA server.
  ingest(metricEvent(SITE, "pack-gw-01", "opcua-adapter", "southbound_health", {
    connectionState: "CONNECTED",
    readErrors: 0,
    writeErrors: 0,
  }));

  // ---- R0: DATA-plane signals (data/{signal}, {value, quality}) — the Signals screen (R5).
  // Several components across TWO devices publish moving series with real quality, so the
  // browser groups by component and the trend sparklines visibly move tick to tick.
  ingest(dataEvent(SITE, "press-gw-01", "opcua-adapter", "Temp_01", wave(72, 6, 0), "GOOD"));
  // Pressure carries an honest UNCERTAIN (a wobbly transducer) — its value still moves, so the
  // sparkline moves under a non-GOOD quality (matches the mockup's UNCERTAIN row).
  ingest(dataEvent(SITE, "press-gw-01", "opcua-adapter", "Pressure", wave(4.1, 0.4, 2), "UNCERTAIN"));
  ingest(dataEvent(SITE, "press-gw-01", "modbus-adapter", "flow_rate", wave(310, 25, 1), "GOOD"));
  // A second device with a live GOOD signal (proves grouping/scoping by component).
  ingest(dataEvent(SITE, "pack-gw-01", "modbus-adapter", "conveyor_speed", wave(1.5, 0.3, 4), "GOOD"));
  // A BAD signal whose sensor died: a value-less {value:null, quality:"BAD"} sample published
  // ONCE, so it ages (the mockup's stale, dashed-out BAD Flow_A). Never re-published — the row
  // shows "—" / BAD with a growing Age, honest about the last-known state.
  if (tick === 1) ingest(dataEvent(SITE, "pack-gw-01", "opcua-adapter", "Flow_A", null, "BAD"));

  // ---- R0: a persistent CRITICAL alarm from the first tick (so the notifications badge
  //          is populated immediately), plus a visible raise→clear lifecycle below.
  if (tick === 1) {
    ingest(evtEvent(SITE, "press-gw-01", "modbus-adapter", "critical", "sensor-fault", {
      message: "flow sensor reading out of range — check wiring",
      register: 40001,
    }));
  }

  // ---- C6: a varied evt stream (components x severities, live-appending).
  if (tick % 3 === 1) {
    ingest(evtEvent(SITE, "press-gw-01", "opcua-adapter", "info", "scan-cycle-complete", {
      message: "browse + subscribe cycle finished",
      signals: 48,
      elapsedMs: 180 + Math.floor(Math.random() * 90),
    }));
  }
  if (tick % 5 === 2) {
    ingest(evtEvent(SITE, "pack-gw-01", "modbus-adapter", "warning", "slave-retry", {
      message: "slave 192.168.1.224:5020 did not answer, retrying",
      attempt: (tick % 15) + 1,
      unitId: 1,
    }));
  }
  if (tick % 7 === 3) {
    ingest(evtEvent(SITE, "press-gw-01", "telemetry-processor", "error", "pipeline-lag", {
      message: "aggregate window closed late",
      lagMs: 900 + Math.floor(Math.random() * 600),
      stage: "aggregate",
    }));
  }
  if (tick % 14 === 6) {
    ingest(evtEvent(SITE, "pack-gw-01", "opcua-adapter", "critical", "connection-lost", {
      message: "OPC UA session dropped by server",
      endpoint: "opc.tcp://192.168.1.181:49320",
    }));
  }
  if (tick % 14 === 10) {
    // The matching resolve (normal severity, SAME type) clears the alarm into history —
    // the console-side raise→clear lifecycle made visible.
    ingest(evtEvent(SITE, "pack-gw-01", "opcua-adapter", "info", "connection-lost", {
      message: "OPC UA session re-established",
    }));
  }
  if (tick % 15 === 8) {
    ingest(evtEvent(SITE, "press-gw-01", "batch-runner", "info", "batch-completed", {
      message: "batch finished cleanly, stopping until the next window",
      recordsProcessed: 1200 + tick,
    }));
  }
  if (tick % 18 === 0 && tick > 0) {
    ingest(evtEvent(SITE, "asm-gw-01", "uns-bridge", "warning", "site-reconnect", {
      message: "site link restored, replaying buffered evt in order",
      bufferedReplayed: 37,
    }));
  }
}

await server.start();
console.log(`[demo] C2+C5+C6 gateway (real FleetModel/ConfigStore/EventStore/MetricStore/FleetWsGateway/WsServer) on ws://127.0.0.1:${PORT}/ws`);

// cfg announcements on "startup" (the publish-on-startup half of the cfg contract);
// cadence sources become "cfg" wherever heartbeat.intervalSecs is announced.
for (const announcements of Object.values(cfgAnnouncements)) {
  for (const announce of announcements) ingest(announce());
}
feed();

const feeder = setInterval(feed, 5000); // the 5 s keepalive cadence
const sweeper = setInterval(() => model.sweep(), 1000); // the C1 staleness sweeper
// WS heartbeats: the live gateway ticks at 15 s, but the demo ticks faster so the Overview's
// Edge-bus sparkline + console-self cpu/mem/uptime visibly move (heartbeat carries them, R1).
const ticker = setInterval(() => gateway.tick(), 3000);

process.on("SIGINT", async () => {
  clearInterval(feeder);
  clearInterval(sweeper);
  clearInterval(ticker);
  await server.stop();
  process.exit(0);
});

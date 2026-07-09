/**
 * The console composition root (testable): wires config -> FleetModel -> BusIngress
 * -> the liveness sweeper -> the C2 WS gateway, over injected collaborators only —
 * `main.ts` adapts the live `EdgeCommons` runtime onto these five dependencies, tests
 * inject fakes.
 *
 * Wiring rules (reconciliation §3):
 *  - the FleetModel's `device-discovered` delta triggers the per-device
 *    `republish-state`/`republish-cfg` broadcast (the G1 bootstrap: fire after the
 *    first message from a new device; the bridge additionally fires the same
 *    broadcast on every site-reconnect rising edge, so rehydration is shared work);
 *  - the sweeper drives miss-detection every `console.staleness.sweepIntervalMs`
 *    (default 1 s), per DESIGN §6.2;
 *  - the C2 WS gateway fans the FleetModel's snapshot + delta stream out to browsers
 *    (`component.global.console.ws`); its own tick (heartbeats + hello-timeout
 *    eviction) runs every `console.ws.heartbeatIntervalMs` (default 15 s);
 *  - the C5 config-review path: the ingress sink tees every event into the
 *    {@link ConfigStore} (retained `cfg` bodies), the gateway answers `get-config`
 *    from it and pushes fresh arrivals, and `refresh-config` triggers the same
 *    per-device `republish-*` broadcast the discovery bootstrap uses;
 *  - the C6 activity path: the same tee feeds the {@link EventStore} (rolling
 *    recent `evt` history) and the {@link MetricStore} (latest + bounded series per
 *    metric measure); the gateway serves `subscribe-events`/`subscribe-metrics`
 *    from them and streams arrivals to subscribed clients;
 *  - the C4 command path: the {@link CommandGateway} turns an `invoke-command` into a
 *    `messaging().request()` on the site bus (the bridge rewrites `reply_to`), gated by
 *    the config-driven {@link ConfigRbacPolicy}; the WS auth seam (`resolveRole`) maps
 *    each connection to a role (today the RBAC `defaultRole` — no real auth yet).
 */
import type { IMessagingService, MessageBuilder, Uns } from "@edgecommons/edgecommons";
import { consoleConfigFromGlobal } from "./console-config";
import type { ConsoleConfig } from "./console-config";
import { BusIngress } from "./ingress/bus-ingress";
import { FleetModel } from "./fleet/fleet-model";
import type { Clock } from "./fleet/fleet-model";
import { ConfigStore } from "./fleet/config-store";
import { EventStore } from "./fleet/event-store";
import { MetricStore } from "./fleet/metric-store";
import { LogStore } from "./fleet/log-store";
import { SignalStore } from "./fleet/signal-store";
import { AttributeStore } from "./fleet/attribute-store";
import { AlarmTracker } from "./fleet/alarm-tracker";
import { ThroughputMeter } from "./fleet/throughput-meter";
import { ConsoleSelfMonitor } from "./fleet/console-self";
import type { ConsoleSelfInfo } from "./fleet/console-self";
import { consoleSettings } from "./fleet/console-settings";
import { CommandGateway } from "./command/command-gateway";
import { ConfigRbacPolicy } from "./command/rbac";
import { FleetWsGateway } from "./ws/gateway";
import { WsServer } from "./ws/ws-server";

/** What `startConsole` needs from the runtime (all injectable). */
export interface ConsoleAppDeps {
  /** The console's one connection — the site broker (`gg.messaging()`). */
  messaging: IMessagingService;
  /** The console's identity-bound topic builder (`gg.uns()`). */
  uns: Uns;
  /** Envelope factory stamping the console's identity (`MessageBuilder.create(...).withConfig(gg.config())`). */
  newMessage: (name: string) => MessageBuilder;
  /** The `component.global` config subtree (`gg.config().global()`); the console section lives at `.console`. */
  globalConfig: unknown;
  /**
   * The console's OWN static self-identity + messaging transport (R1) — its resolved device/
   * component name, platform, transport and site-broker host, read off `gg` by `main.ts`. Drives
   * the Overview "Edge node console self" tile + the "Edge bus" tile's transport foot. Optional:
   * without it the heartbeat omits `self` (honest — no self-identity wired).
   */
  self?: ConsoleSelfInfo;
  /** Injected clock (tests); defaults to `Date.now`. */
  clock?: Clock;
}

/** The running console core (slices C1 + C2 + C5 + C6: ingress + fleet model + side stores + sweeper + WS gateway). */
export interface ConsoleApp {
  readonly config: ConsoleConfig;
  readonly model: FleetModel;
  /** The retained-cfg cache behind the C5 `get-config`/`config` frames. */
  readonly configs: ConfigStore;
  /** The rolling recent-`evt` history behind the C6 `subscribe-events` stream. */
  readonly events: EventStore;
  /** The metric surface (latest + bounded series) behind the C6 `subscribe-metrics` stream. */
  readonly metrics: MetricStore;
  /** The per-component log tails behind the C6 `subscribe-logs` stream. */
  readonly logs: LogStore;
  /** The DATA-plane signal surface (latest + quality + series) behind R0 `subscribe-signals`. */
  readonly signals: SignalStore;
  /** The runtime-attribute projection behind R0 `subscribe-attributes`. */
  readonly attributes: AttributeStore;
  /** The console-side alarm tracker behind R0 `subscribe-alarms`/`ack-alarm`. */
  readonly alarms: AlarmTracker;
  readonly ingress: BusIngress;
  /** The C4 pure command core behind the `invoke-command`/`command-result` frames. */
  readonly commandGateway: CommandGateway;
  /** The C2 pure fanout core (mostly for diagnostics/tests — `wsServer` owns the real socket). */
  readonly gateway: FleetWsGateway;
  /** The C2 IO edge (HTTP + WS listener); `.address()` is only meaningful after `startConsole` resolves. */
  readonly wsServer: WsServer;
  /** Stop the WS gateway, the sweeper, detach wiring, and unsubscribe the bus (idempotent). */
  stop(): Promise<void>;
}

/** Build and start the C1+C2 console core. */
export async function startConsole(deps: ConsoleAppDeps): Promise<ConsoleApp> {
  const config = consoleConfigFromGlobal(deps.globalConfig);
  const clock = deps.clock ?? (() => Date.now());
  const model = new FleetModel(clock, {
    warnMultiplier: config.staleness.warnMultiplier,
    staleMultiplier: config.staleness.staleMultiplier,
    offlineMultiplier: config.staleness.offlineMultiplier,
    defaultIntervalSecs: config.staleness.defaultIntervalSecs,
    maxChannelsPerComponent: config.cache.maxChannelsPerComponent,
  });
  // The retained-cfg cache (C5): fed by the same ingress tee as the FleetModel, read
  // on demand by the WS gateway (the liveness stream carries no bodies by design).
  const configs = new ConfigStore(clock);
  // The C6 activity stores: rolling `evt` history + metric latest/series, fed by the
  // same tee, served over the gateway's subscribe/stream frames.
  const events = new EventStore(clock, {
    maxEvents: config.events.maxEvents,
    maxPerComponent: config.events.maxPerComponent,
  });
  const metrics = new MetricStore(clock, {
    maxSeriesPoints: config.metrics.maxSeriesPoints,
    maxSeries: config.metrics.maxSeries,
  });
  const logs = new LogStore(clock, {
    maxRecords: config.logs.maxRecords,
    maxPerComponent: config.logs.maxPerComponent,
  });
  // The R0 foundation stores (server-defaults; the screens R1-R6 consume them):
  //  - signals: the DATA plane (`data` class) — latest value + quality + bounded series;
  //  - attributes: the runtime-attribute projection off the `metric` class (sys.* + conn);
  //  - alarms: the console-side alarm tracker over the `evt` severity stream (+ containment).
  const signals = new SignalStore(clock);
  const attributes = new AttributeStore(clock);
  const alarms = new AlarmTracker(clock);
  // The console's OWN bus-ingest throughput (R1): marked once per normalized envelope,
  // read by the WS gateway on each heartbeat (the Overview "Edge bus msgs/s" tile + sparkline).
  const throughput = new ThroughputMeter(clock);
  // The console's OWN self-identity + process vitals (R1): sampled on each heartbeat (the
  // "Edge node console self" tile). Only wired when `main.ts` supplied the static self-identity.
  const selfMonitor = deps.self !== undefined ? new ConsoleSelfMonitor(deps.self) : undefined;
  const ingress = new BusIngress({
    messaging: deps.messaging,
    uns: deps.uns,
    newMessage: deps.newMessage,
    sink: (event) => {
      throughput.mark();
      model.ingest(event);
      configs.ingest(event);
      events.ingest(event);
      metrics.ingest(event);
      logs.ingest(event);
      signals.ingest(event);
      attributes.ingest(event);
      alarms.ingest(event);
    },
  });

  // Discovery -> late-join rehydration: broadcast the republish pair once per newly
  // discovered device; device-reachability transitions drive alarm CONTAINMENT (a device
  // going UNREACHABLE suppresses its components' alarms; recovery releases them).
  const detach = model.onDelta((deltas) => {
    for (const delta of deltas) {
      if (delta.type === "device-discovered") {
        void ingress.broadcastRepublish(delta.device);
      } else if (delta.type === "device-reachability-changed") {
        alarms.setDeviceContainment(delta.device, delta.unreachable);
      }
    }
  });

  await ingress.start();

  // On start, rehydrate every already-known device (empty on a cold start — the
  // discovery wiring above covers the rest as the fleet appears).
  for (const device of model.devices()) {
    await ingress.broadcastRepublish(device);
  }

  const sweeper = setInterval(() => model.sweep(), config.staleness.sweepIntervalMs);

  // The C4 command core: RBAC-gated `invoke-command` → `uns().topicFor` + the site-bus
  // `request()` (the ONLY IO edge — the bridge rewrites reply_to transparently), per-verb
  // timeouts clamped to the bridge reply-map TTL.
  const rbac = new ConfigRbacPolicy(config.rbac);
  const commandGateway = new CommandGateway({
    uns: deps.uns,
    newMessage: deps.newMessage,
    request: (topic, msg, timeoutMs) => deps.messaging.request(topic, msg, timeoutMs),
    rbac,
    clock,
    defaultTimeoutMs: config.commands.defaultTimeoutMs,
    maxTimeoutMs: config.commands.maxTimeoutMs,
    timeoutForVerb: (verb) => config.commands.verbTimeouts[verb],
  });

  // The C2 WS gateway: snapshot-then-deltas fanout over the same FleetModel (it
  // satisfies FleetSource structurally — snapshot() + onDelta()), plus the C5 config
  // seam: get-config answered from the retained-cfg cache, refresh-config wired to
  // the per-device republish broadcast (the on-demand re-pull; components answer once
  // the device-side edgecommons S1 listener lands).
  const gateway = new FleetWsGateway(
    model,
    {
      clock,
      busThroughput: () => throughput.ratePerSec(),
      busRecentRates: () => throughput.recentRates(),
      ...(selfMonitor !== undefined ? { consoleSelf: () => selfMonitor.sample() } : {}),
      // The console's OWN effective policy + configuration (R6) — the read-only Settings
      // screen's data. Always available (it is the parsed config + the static self-identity);
      // pushed once per hello, right after welcome.
      consoleSettings: () => consoleSettings(config, deps.self),
    },
    {
      configs,
      refreshDevice: (device) => void ingress.broadcastRepublish(device),
    },
    // The activity seam: C6 events/metrics + the R0 signals/attributes/alarms surfaces.
    { events, metrics, logs, signals, attributes, alarms },
    // The C4 command seam: invoke-command → request/reply, RBAC-gated.
    { gateway: commandGateway, rbac },
  );
  const wsServer = new WsServer(gateway, {
    port: config.ws.port,
    bindAddress: config.ws.bindAddress,
    // The auth seam (stubbed): every connection gets the configured RBAC default role.
    resolveRole: () => config.rbac.defaultRole,
    // Opt-in static UI serving (console.ws.webRoot) - absent means WsServer behaves
    // exactly as before (only /healthz + /ws).
    ...(config.ws.webRoot !== undefined ? { webRoot: config.ws.webRoot } : {}),
  });
  await wsServer.start();
  const wsTicker = setInterval(() => gateway.tick(), config.ws.heartbeatIntervalMs);

  let stopped = false;
  return {
    config,
    model,
    configs,
    events,
    metrics,
    logs,
    signals,
    attributes,
    alarms,
    ingress,
    commandGateway,
    gateway,
    wsServer,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(sweeper);
      clearInterval(wsTicker);
      detach();
      await wsServer.stop();
      await ingress.stop();
    },
  };
}

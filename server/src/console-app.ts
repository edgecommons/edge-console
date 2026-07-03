/**
 * The console composition root (testable): wires config -> FleetModel -> BusIngress
 * -> the liveness sweeper -> the C2 WS gateway, over injected collaborators only —
 * `main.ts` adapts the live `GGCommons` runtime onto these five dependencies, tests
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
 *    eviction) runs every `console.ws.heartbeatIntervalMs` (default 15 s).
 */
import type { IMessagingService, MessageBuilder, Uns } from "@edgecommons/ggcommons";
import { consoleConfigFromGlobal } from "./console-config";
import type { ConsoleConfig } from "./console-config";
import { BusIngress } from "./ingress/bus-ingress";
import { FleetModel } from "./fleet/fleet-model";
import type { Clock } from "./fleet/fleet-model";
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
  /** Injected clock (tests); defaults to `Date.now`. */
  clock?: Clock;
}

/** The running console core (slices C1 + C2: ingress + fleet model + sweeper + WS gateway). */
export interface ConsoleApp {
  readonly config: ConsoleConfig;
  readonly model: FleetModel;
  readonly ingress: BusIngress;
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
  const ingress = new BusIngress({
    messaging: deps.messaging,
    uns: deps.uns,
    newMessage: deps.newMessage,
    sink: (event) => model.ingest(event),
  });

  // Discovery -> late-join rehydration: broadcast the republish pair once per newly
  // discovered device (broadcastRepublish never throws).
  const detach = model.onDelta((deltas) => {
    for (const delta of deltas) {
      if (delta.type === "device-discovered") {
        void ingress.broadcastRepublish(delta.device);
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

  // The C2 WS gateway: snapshot-then-deltas fanout over the same FleetModel (it
  // satisfies FleetSource structurally — snapshot() + onDelta()).
  const gateway = new FleetWsGateway(model, { clock });
  const wsServer = new WsServer(gateway, {
    port: config.ws.port,
    bindAddress: config.ws.bindAddress,
  });
  await wsServer.start();
  const wsTicker = setInterval(() => gateway.tick(), config.ws.heartbeatIntervalMs);

  let stopped = false;
  return {
    config,
    model,
    ingress,
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

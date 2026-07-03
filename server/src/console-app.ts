/**
 * The console composition root (testable): wires config -> FleetModel -> BusIngress
 * -> the liveness sweeper, over injected collaborators only — `main.ts` adapts the
 * live `GGCommons` runtime onto these five dependencies, tests inject fakes.
 *
 * Wiring rules (reconciliation §3):
 *  - the FleetModel's `device-discovered` delta triggers the per-device
 *    `republish-state`/`republish-cfg` broadcast (the G1 bootstrap: fire after the
 *    first message from a new device; the bridge additionally fires the same
 *    broadcast on every site-reconnect rising edge, so rehydration is shared work);
 *  - the sweeper drives miss-detection every `console.staleness.sweepIntervalMs`
 *    (default 1 s), per DESIGN §6.2.
 */
import type { IMessagingService, MessageBuilder, Uns } from "@edgecommons/ggcommons";
import { consoleConfigFromGlobal } from "./console-config";
import type { ConsoleConfig } from "./console-config";
import { BusIngress } from "./ingress/bus-ingress";
import { FleetModel } from "./fleet/fleet-model";
import type { Clock } from "./fleet/fleet-model";

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

/** The running console core (slice C1: ingress + fleet model + sweeper). */
export interface ConsoleApp {
  readonly config: ConsoleConfig;
  readonly model: FleetModel;
  readonly ingress: BusIngress;
  /** Stop the sweeper, detach wiring, and unsubscribe the bus (idempotent). */
  stop(): Promise<void>;
}

/** Build and start the C1 console core. */
export async function startConsole(deps: ConsoleAppDeps): Promise<ConsoleApp> {
  const config = consoleConfigFromGlobal(deps.globalConfig);
  const model = new FleetModel(deps.clock ?? (() => Date.now()), {
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

  let stopped = false;
  return {
    config,
    model,
    ingress,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(sweeper);
      detach();
      await ingress.stop();
    },
  };
}

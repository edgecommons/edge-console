/**
 * BusIngress — the console's single IO seam onto the site UNS bus.
 *
 * Holds the injected {@link IMessagingService} (the console's ONE connection: the
 * site broker — reconciliation §3), subscribes the **six consumer-class wildcards**
 * built through the library's `uns().filter()` (never by hand — G10/bridge
 * precedent), and normalizes every delivery into an {@link IngressEvent} for the
 * sink (the FleetModel). The `state` wildcard also delivers the bridges' raw LWT
 * payloads — the normalizer's one topic-parse exception (G5).
 *
 * It also owns the **per-device `republish-*` broadcast** (G1/D-U19): on discovery
 * of a device (and on console start for already-known devices) it publishes
 * `ecv1/{device}/_bcast/main/cmd/republish-state` + `.../republish-cfg` so
 * already-running components re-announce state+cfg (answered once ggcommons S1
 * lands; the bridge already fires the same broadcast on site-reconnect).
 *
 * Everything here is injectable (messaging service, Uns builder, message factory,
 * sink), so tests run over a fake bus with zero live infrastructure — the same
 * pure-core/IO split the uns-bridge used.
 */
import {
  MessageIdentity,
  UnsClass,
  UnsScope,
  logger,
} from "@edgecommons/ggcommons";
import type { IMessagingService, MessageBuilder, Uns } from "@edgecommons/ggcommons";
import { CONSUMER_CLASSES } from "@edgecommons/edge-console-protocol";
import type { ConsumerClass } from "@edgecommons/edge-console-protocol";
import { normalize } from "./normalizer";
import type { IngressEvent } from "./normalizer";

/** Consumer-class token -> the lib's UnsClass enum member. */
const UNS_CLASS: Record<ConsumerClass, UnsClass> = {
  state: UnsClass.State,
  cfg: UnsClass.Cfg,
  evt: UnsClass.Evt,
  metric: UnsClass.Metric,
  data: UnsClass.Data,
  log: UnsClass.Log,
};

/** The reserved broadcast pseudo-component (D-U19; `_`-prefix = system-reserved). */
const BCAST_COMPONENT = "_bcast";

/** The two republish verbs the broadcast fires (UNS-CANONICAL §4.3). */
const REPUBLISH_VERBS = ["republish-state", "republish-cfg"] as const;

/** Injected collaborators — all substitutable in tests. */
export interface BusIngressDeps {
  /** The console's one connection (the site broker / local bus). */
  messaging: IMessagingService;
  /** The console's identity-bound topic builder (`gg.uns()`). */
  uns: Uns;
  /** Receives every normalized event (the FleetModel's `ingest`). */
  sink: (event: IngressEvent) => void;
  /**
   * Message factory stamping the console's own identity/tags
   * (`(name) => MessageBuilder.create(name, "1.0").withConfig(gg.config())`).
   */
  newMessage: (name: string) => MessageBuilder;
}

/** Per-subscription queue bound (the lib dispatcher's client-side buffer). */
const MAX_QUEUED_MESSAGES = 256;

/** The console's site-bus ingress: six wildcard subscriptions + the republish broadcast. */
export class BusIngress {
  private readonly filters: string[] = [];

  constructor(private readonly deps: BusIngressDeps) {}

  /**
   * Subscribe the six consumer-class wildcards. Handlers never throw into the
   * transport: a sink/normalizer failure is logged and the message dropped.
   */
  async start(): Promise<void> {
    for (const cls of CONSUMER_CLASSES) {
      const filter = this.deps.uns.filter(UNS_CLASS[cls], UnsScope.all());
      // The class token's topic-level index, derived from the filter we just built
      // (4 in the rootless grammar, 5 rooted) — the normalizer's structural anchor.
      const classIndex = filter.split("/").indexOf(cls);
      await this.deps.messaging.subscribe(
        filter,
        (topic, message) => {
          try {
            this.deps.sink(normalize(cls, classIndex, topic, message));
          } catch (e) {
            logger.warn(`edge-console ingress: sink failed for ${topic}: ${String(e)}`);
          }
        },
        MAX_QUEUED_MESSAGES,
        1, // serial dispatch per class — ordered folds into the FleetModel
      );
      this.filters.push(filter);
    }
    logger.info(`edge-console ingress subscribed: ${this.filters.join(" ")}`);
  }

  /** The active subscription filters (diagnostics/tests). */
  subscribedFilters(): readonly string[] {
    return [...this.filters];
  }

  /** Unsubscribe everything (idempotent). Always leave the bus clean on shutdown. */
  async stop(): Promise<void> {
    const filters = this.filters.splice(0, this.filters.length);
    for (const filter of filters) {
      await this.deps.messaging.unsubscribe(filter).catch((e) => {
        logger.warn(`edge-console ingress: unsubscribe ${filter} failed: ${String(e)}`);
      });
    }
  }

  /**
   * Publish the per-device republish broadcast (fire-and-forget `cmd`
   * notifications — no `reply_to`): `ecv1/{device}/_bcast/main/cmd/republish-state`
   * then `.../republish-cfg`. Site-wide (`+`-device) broadcast is deliberately not
   * built (deferred per D-U19). Never throws: a bad device token (hostile identity)
   * or publish failure is logged and skipped.
   */
  async broadcastRepublish(device: string): Promise<void> {
    let target: MessageIdentity;
    try {
      target = new MessageIdentity([{ level: "device", value: device }], BCAST_COMPONENT);
    } catch (e) {
      logger.warn(`edge-console: cannot broadcast republish to device '${device}': ${String(e)}`);
      return;
    }
    for (const verb of REPUBLISH_VERBS) {
      try {
        const topic = this.deps.uns.topicFor(target, UnsClass.Cmd, verb);
        const message = this.deps.newMessage(verb).withPayload({}).build();
        await this.deps.messaging.publish(topic, message);
      } catch (e) {
        logger.warn(
          `edge-console: republish broadcast '${verb}' to device '${device}' failed: ${String(e)}`,
        );
      }
    }
  }
}

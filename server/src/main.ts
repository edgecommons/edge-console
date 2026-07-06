/**
 * Edge Console server — process entry point.
 *
 * A standard edgecommons TypeScript component: the library owns CLI parsing, config
 * (with the console's own knobs under `component.global.console`), messaging (the
 * ONE connection — pointed at the **site broker**), logging, metrics, the state
 * keepalive, the effective-config publisher, and SIGTERM/SIGINT graceful shutdown.
 * This entry point only adapts the runtime onto `startConsole` (the testable
 * composition root).
 *
 * ## Running locally (HOST, against the dev rig's site broker)
 * ```bash
 * node dist/main.js \
 *   --platform HOST --transport MQTT ./test-configs/config.json \
 *   -c FILE ./test-configs/config.json \
 *   -t gw-01
 * ```
 * (The config file doubles as the `--transport MQTT` payload — its `messaging.local`
 * is the site broker — the same pattern the uns-bridge uses.)
 */
import { EdgeCommonsBuilder, MessageBuilder, logger } from "@edgecommons/edgecommons";

import { startConsole } from "./console-app";

/** The component's full name (short name/UNS component token: `edge-console`). */
const COMPONENT_NAME = "com.mbreissi.edgecommons.EdgeConsole";

async function main(): Promise<void> {
  const gg = await new EdgeCommonsBuilder(COMPONENT_NAME).args(process.argv.slice(2)).build();
  logger.info(
    `edge-console starting: component=${gg.componentName()} device=${gg.config().componentIdentity.device} path=${gg.config().componentIdentity.path}`,
  );

  const app = await startConsole({
    messaging: gg.messaging(),
    uns: gg.uns(),
    newMessage: (name) => MessageBuilder.create(name, "1.0").withConfig(gg.config()),
    globalConfig: gg.config().global(),
    // The console's OWN self-identity + messaging transport (R1) — all honestly sourced from the
    // console's own resolved runtime: identity (device/component) from its config-derived UNS
    // identity, platform/transport from the resolved CLI axes, and the site-broker host from its
    // `messaging.local` config. Drives the Overview "Edge node console self" tile + "Edge bus" foot.
    self: {
      device: gg.config().componentIdentity.device,
      component: gg.config().componentIdentity.component,
      platform: gg.args().platform,
      transport: gg.args().transport,
      ...(brokerHost(gg.config().raw) !== undefined ? { broker: brokerHost(gg.config().raw)! } : {}),
    },
  });

  logger.info(`edge-console ingress up (${app.ingress.subscribedFilters().length} filters)`);
  // (WsServer.start() already logged the ws gateway's bound address.)

  // The process stays up on the messaging sockets, the WS gateway, and the sweeper.
  // Graceful shutdown is library-owned (FR-HB-2): SIGTERM/SIGINT flips readiness,
  // closes the runtime (unsubscribes, best-effort STOPPED state) and exits 0.
  //
  // AUTH (C4 status): the command WRITE surface is now RBAC-GATED — a `console.rbac`
  // policy (config-driven allow/deny per verb) is ENFORCED in the CommandGateway, and
  // the role-resolution AUTH SEAM is wired at `WsServer.onConnection` (`resolveRole`).
  // What is still STUBBED is the identity source: `resolveRole` maps every connection to
  // the configured `defaultRole` (permissive by default) — there is no bearer/mTLS/OIDC
  // VERIFICATION yet, and the read surface (snapshot + delta/activity streams) is
  // unauthenticated. TODO(prod auth): before exposing beyond a trusted dev network,
  // implement `resolveRole` to verify the upgrade request's principal (headers/mTLS cert)
  // and reject unauthenticated upgrades. Track under the console's RBAC design (DESIGN §6.5).
}

/** The site-bus broker host from the console's own `messaging.local.host` config, when present. */
function brokerHost(raw: unknown): string | undefined {
  const asObj = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const host = asObj(asObj(asObj(raw).messaging).local).host;
  return typeof host === "string" && host !== "" ? host : undefined;
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});

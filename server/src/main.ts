/**
 * Edge Console server — process entry point.
 *
 * A standard ggcommons TypeScript component: the library owns CLI parsing, config
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
import { GGCommonsBuilder, MessageBuilder, logger } from "@edgecommons/ggcommons";

import { startConsole } from "./console-app";

/** The component's full name (short name/UNS component token: `edge-console`). */
const COMPONENT_NAME = "com.edgecommons.edge-console";

async function main(): Promise<void> {
  const gg = await new GGCommonsBuilder(COMPONENT_NAME).args(process.argv.slice(2)).build();
  logger.info(
    `edge-console starting: component=${gg.componentName()} device=${gg.config().componentIdentity.device} path=${gg.config().componentIdentity.path}`,
  );

  const app = await startConsole({
    messaging: gg.messaging(),
    uns: gg.uns(),
    newMessage: (name) => MessageBuilder.create(name, "1.0").withConfig(gg.config()),
    globalConfig: gg.config().global(),
  });

  logger.info(`edge-console ingress up (${app.ingress.subscribedFilters().length} filters)`);
  // (WsServer.start() already logged the ws gateway's bound address.)

  // The process stays up on the messaging sockets, the WS gateway, and the sweeper.
  // Graceful shutdown is library-owned (FR-HB-2): SIGTERM/SIGINT flips readiness,
  // closes the runtime (unsubscribes, best-effort STOPPED state) and exits 0.
  //
  // TODO(prod auth): this WS gateway is the sole browser<->bus bridge and currently
  // has NO authentication/authorization - anyone who can reach the bound port gets the
  // full fleet snapshot + live delta stream (read-only in this slice; C4's
  // CommandGateway adds a write surface). Before this is exposed beyond a trusted dev
  // network, add a seam here: e.g. reject the WS upgrade unless a bearer
  // token/mTLS/OIDC session is presented (the `req` passed to WsServer's `connection`
  // handler already carries the upgrade request's headers for this). Track under the
  // console's RBAC design (DESIGN §6.5 / C4).
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});

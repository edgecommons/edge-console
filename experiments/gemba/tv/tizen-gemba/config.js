/* global window */
/* Packaged Tizen build: explicit LAN gateway URL for the dallas-site console. The packaged app's
 * Origin is file://, which the console's tv-board app registry must allow. Update the host/port if
 * the harness console is exposed elsewhere. */
(function () {
  "use strict";
  window.GEMBA_TV_CONFIG = {
    gatewayUrl: "ws://192.168.1.224:8080/apps/tv-board/ws",
    protocolVersion: 1,
    capabilities: ["signals", "alarms"]
  };
}());

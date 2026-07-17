/* global window */

(function () {
  "use strict";

  window.GEMBA_TV_CONFIG = {
    gatewayUrl: "ws://192.168.1.224:18445/apps/tv-board/ws",
    protocolVersion: 1,
    capabilities: ["fleet", "events", "signals", "attributes", "alarms"]
  };
}());

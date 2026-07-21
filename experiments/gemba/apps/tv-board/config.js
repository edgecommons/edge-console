/* global window */
/* Browser-served config: leave gatewayUrl unset so app.js derives ws://<host>/apps/{id}/ws from the
 * page location (works when the console serves this at /apps/tv-board/). The packaged Tizen build
 * ships its own config.js with an explicit LAN gatewayUrl (see experiments/gemba/tv/tizen-gemba). */
(function () {
  "use strict";
  window.GEMBA_TV_CONFIG = {
    protocolVersion: 1,
    capabilities: ["signals", "alarms"]
  };
}());

/* Dallas Line 2 packaging OEE board — LIVE.
 *
 * Conservative ES5 for the 2019 Tizen web runtime AND ordinary browsers. Replaces the mockup's
 * synthetic scenario with the real gateway app-WebSocket: protocol-v1 hello/subscribe, then it
 * binds incoming `signals` frames to the dashboard's [data-signal] tiles and drives the pallet
 * grid, jam state, motor-current trend, and OEE strip from live values.
 *
 * Gateway URL: window.GEMBA_TV_CONFIG.gatewayUrl (config.js, used by the packaged TV app) or,
 * when served in a browser at /apps/{id}/, derived from location.
 */
(function () {
  "use strict";

  var config = window.GEMBA_TV_CONFIG || {};
  var capabilities = config.capabilities || ["signals", "alarms"];
  var socket = null;
  var reconnectTimer = null;
  var history = [];
  var latest = {};

  function appIdFromPath() {
    var m = (location.pathname || "").match(/\/apps\/([^\/]+)\//);
    return m ? m[1] : "tv-board";
  }

  function gatewayUrl() {
    if (config.gatewayUrl) return config.gatewayUrl;
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    return proto + "//" + location.host + "/apps/" + appIdFromPath() + "/ws";
  }

  function byId(id) { return document.getElementById(id); }
  function text(id, value) { var el = byId(id); if (el) el.textContent = value; }
  function pad(v) { return v < 10 ? "0" + v : String(v); }
  function commas(v) { return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function num(v) { return typeof v === "number" ? v : parseFloat(v); }

  function setConnState(state, detail) {
    var el = byId("source-state");
    if (el) el.setAttribute("data-state", state);
    if (detail) text("source-detail", detail);
  }

  // --- pallet grid (24-cell layer view driven by PalletCaseCount) ---
  function buildPallet() {
    var grid = byId("pallet-grid");
    if (!grid || grid.childNodes.length) return;
    for (var i = 0; i < 24; i += 1) {
      var cell = document.createElement("span");
      cell.textContent = pad(i + 1);
      grid.appendChild(cell);
    }
  }
  function renderPallet(palletCases) {
    var loaded = palletCases <= 0 ? 0 : (((palletCases - 1) % 24) + 1);
    var grid = byId("pallet-grid");
    if (grid) {
      var cells = grid.getElementsByTagName("span");
      for (var i = 0; i < cells.length; i += 1) {
        cells[i].className = i < loaded ? "is-loaded" : (i === loaded ? "is-next" : "");
      }
    }
    var pct = Math.min(100, Math.round((palletCases / 120) * 100));
    text("pallet-cases", palletCases + " / 120");
    text("pallet-percent", pct + "%");
    var bar = byId("pallet-progress-bar");
    if (bar) bar.style.width = pct + "%";
    var layer = Math.min(5, Math.floor((loaded - 1) / (24 / 5)) + 1);
    if (layer > 0) { text("pallet-layer", layer + " / 5"); text("pallet-layer2", layer + " / 5"); }
  }

  // --- motor-current trend ---
  function drawCurrent() {
    var width = 600, height = 128, low = 3.5, high = 10.5, path = "", i;
    for (i = 0; i < history.length; i += 1) {
      var x = history.length === 1 ? 0 : (i / (history.length - 1)) * width;
      var y = height - ((history[i] - low) / (high - low)) * height;
      path += (i === 0 ? "M" : " L") + x.toFixed(1) + " " + y.toFixed(1);
    }
    var line = byId("current-line"), area = byId("current-area");
    if (line) line.setAttribute("d", path);
    if (area) area.setAttribute("d", path + " L" + width + " " + height + " L0 " + height + " Z");
  }

  // --- jam / running board state ---
  function renderState(jammed, state) {
    var board = byId("board");
    if (board) board.className = jammed ? "board is-jammed" : "board";
    var pm = byId("packer-machine");
    if (pm) pm.className = jammed ? "machine machine--alert" : "machine machine--good";
    text("status-text", jammed ? "BLOCKED · PACKER JAM" : "RUNNING CLEAN");
    text("status-detail", jammed ? "Robot cell discharge photoeye held" : "Case packer synchronized with palletizer");
    text("packer-state", state || (jammed ? "Jammed" : "Running"));
    text("risk-chip", jammed ? "ACTION NOW" : "LOW RISK");
    text("jam-status", jammed ? "BLOCKED" : "CLEAR");
    text("attention-text", jammed
      ? "Clear case at packer discharge and inspect guide rail"
      : "Carton magazine refill scheduled");
  }

  // signal -> how to render its [data-signal] tile text
  var FORMAT = {
    CaseRateCpm: function (v) { return num(v).toFixed(1); },
    GoodCaseCount: function (v) { return commas(Math.floor(num(v))); },
    CaseRejectCount: function (v) { return commas(Math.floor(num(v))); },
    PackerMotorCurrentA: function (v) { return num(v).toFixed(1); },
    VisionPassPct: function (v) { return num(v).toFixed(1) + "%"; },
    GlueTempC: function (v) { return String(Math.round(num(v))); },
    CaseWeightKg: function (v) { return num(v).toFixed(2); },
    CartonMagazinePct: function (v) { return Math.round(num(v)) + "% remaining"; },
    JamStatus: function (v) { return (v === true || v === "true") ? "BLOCKED" : "CLEAR"; },
    LabelCode: function (v) { return String(v); },
    PalletizerState: function (v) { return String(v); },
    OEE: function (v) { return num(v).toFixed(1); },
    Availability: function (v) { return num(v).toFixed(1); },
    Performance: function (v) { return num(v).toFixed(1); },
    Quality: function (v) { return num(v).toFixed(1); }
  };

  function applyTile(name, value) {
    var fmt = FORMAT[name];
    var out = fmt ? fmt(value) : String(value);
    var els = document.querySelectorAll('[data-signal="' + name + '"]');
    for (var i = 0; i < els.length; i += 1) {
      els[i].textContent = out;
      els[i].className = (els[i].className.replace(/\bvalue-updated\b/, "") + " value-updated").replace(/^\s+/, "");
    }
  }

  function ingest(name, value) {
    if (value === null || typeof value === "undefined") return;
    latest[name] = value;
    applyTile(name, value);

    if (name === "PackerMotorCurrentA") {
      history.push(num(value));
      if (history.length > 54) history.shift();
      drawCurrent();
    } else if (name === "PalletCaseCount") {
      renderPallet(Math.floor(num(value)));
    } else if (name === "JamStatus" || name === "PalletizerState") {
      var jammed = latest.JamStatus === true || latest.JamStatus === "true"
        || latest.PalletizerState === "BLOCKED";
      renderState(jammed, latest.PalletizerState);
    } else if (name === "CaseRateCpm") {
      var d = num(value) - 28;
      text("rate-delta", (d >= 0 ? "+" : "") + d.toFixed(1));
    }
  }

  function handleFrame(frame) {
    if (!frame) return;
    if (frame.type === "signals") {
      var series = frame.series || [];
      for (var i = 0; i < series.length; i += 1) {
        ingest(series[i].id || series[i].name, series[i].latest);
      }
    } else if (frame.type === "signal") {
      var ups = frame.updates || [];
      for (var j = 0; j < ups.length; j += 1) {
        ingest(ups[j].id || ups[j].name, ups[j].point ? ups[j].point.value : ups[j].value);
      }
    }
  }

  // --- transport ---
  function send(obj) { if (socket && socket.readyState === 1) socket.send(JSON.stringify(obj)); }

  function handleMessage(event) {
    var msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    if (msg.type === "welcome") {
      setConnState("healthy", "Bridge live · " + (msg.appId || appIdFromPath()));
      send({ type: "subscribe", protocolVersion: 1, capabilities: capabilities });
    } else if (msg.type === "subscribed") {
      setConnState("healthy", "Live · max " + (msg.maxUpdateHz || 30) + "/s");
    } else if (msg.type === "updates") {
      var frames = msg.frames || [];
      for (var i = 0; i < frames.length; i += 1) handleFrame(frames[i]);
    } else if (msg.type === "error") {
      setConnState("warn", msg.code || "error");
    }
  }

  function connect() {
    setConnState("warn", "Connecting…");
    try { socket = new WebSocket(gatewayUrl()); }
    catch (e) { scheduleReconnect(); return; }
    socket.onopen = function () { send({ type: "hello", protocolVersion: 1 }); };
    socket.onmessage = handleMessage;
    socket.onclose = function () { socket = null; setConnState("warn", "Reconnecting…"); scheduleReconnect(); };
    socket.onerror = function () { setConnState("warn", "Socket error"); };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = window.setTimeout(function () { reconnectTimer = null; connect(); }, 3000);
  }

  function tickClock() {
    var d = new Date();
    text("clock", pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()));
  }

  buildPallet();
  tickClock();
  window.setInterval(tickClock, 1000);
  connect();
}());

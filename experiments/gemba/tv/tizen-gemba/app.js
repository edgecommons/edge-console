/* global WebSocket, document, window */

(function () {
  "use strict";

  var config = window.GEMBA_TV_CONFIG || {};
  var protocolVersion = config.protocolVersion || 1;
  var capabilities = config.capabilities || ["fleet", "events", "signals", "attributes", "alarms"];
  var storageKey = "edgecommons.gemba.gatewayUrl";
  var socket = null;
  var reconnectTimer = null;
  var manualDisconnect = false;
  var reconnectAttempt = 0;
  var reconnects = 0;
  var envelopes = 0;
  var frames = 0;
  var rateWindowStartedAt = Date.now();
  var rateWindowEnvelopes = 0;

  var status = document.getElementById("status");
  var gatewayInput = document.getElementById("gateway-url");
  var envelopeCount = document.getElementById("envelope-count");
  var frameCount = document.getElementById("frame-count");
  var messageRate = document.getElementById("message-rate");
  var reconnectCount = document.getElementById("reconnect-count");
  var lastMessage = document.getElementById("last-message");
  var lastError = document.getElementById("last-error");
  var latestUpdate = document.getElementById("latest-update");

  function setStatus(text, state) {
    status.textContent = text;
    status.className = "status " + state;
  }

  function storedGatewayUrl() {
    try {
      return window.localStorage.getItem(storageKey) || config.gatewayUrl || "";
    } catch (error) {
      lastError.textContent = "Could not read saved gateway URL: " + error.message;
      return config.gatewayUrl || "";
    }
  }

  function saveGatewayUrl(value) {
    try {
      window.localStorage.setItem(storageKey, value);
    } catch (error) {
      lastError.textContent = "Could not persist gateway URL: " + error.message;
    }
  }

  function validGatewayUrl(value) {
    return /^wss?:\/\/[^\s]+$/i.test(value);
  }

  function scheduleReconnect() {
    var delay;
    if (manualDisconnect || reconnectTimer !== null) {
      return;
    }
    delay = Math.min(30000, 1000 * Math.pow(2, Math.min(reconnectAttempt, 5)));
    delay += Math.floor(Math.random() * 500);
    reconnectAttempt += 1;
    reconnects += 1;
    reconnectCount.textContent = String(reconnects);
    setStatus("Retry in " + Math.ceil(delay / 1000) + "s", "connecting");
    reconnectTimer = window.setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function disconnect(manual) {
    manualDisconnect = manual;
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (socket !== null) {
      try {
        socket.close(1000, manual ? "user disconnect" : "reconnect");
      } catch (error) {
        lastError.textContent = error.message;
      }
      socket = null;
    }
    if (manual) {
      setStatus("Disconnected", "disconnected");
    }
  }

  function send(message) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function updateRate() {
    var now = Date.now();
    var elapsed = (now - rateWindowStartedAt) / 1000;
    if (elapsed >= 1) {
      messageRate.textContent = (rateWindowEnvelopes / elapsed).toFixed(1) + " Hz";
      rateWindowStartedAt = now;
      rateWindowEnvelopes = 0;
    }
  }

  function handleMessage(event) {
    var message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      lastError.textContent = "Invalid JSON: " + error.message;
      return;
    }

    lastMessage.textContent = new Date().toLocaleTimeString() + " - " + message.type;
    if (message.type === "welcome") {
      reconnectAttempt = 0;
      setStatus("Live", "connected");
      send({
        type: "subscribe",
        protocolVersion: protocolVersion,
        capabilities: capabilities
      });
      return;
    }

    if (message.type === "updates") {
      envelopes += 1;
      rateWindowEnvelopes += 1;
      frames += message.frames && message.frames.length ? message.frames.length : 0;
      envelopeCount.textContent = String(envelopes);
      frameCount.textContent = String(frames);
      latestUpdate.textContent = JSON.stringify(message, null, 2);
      updateRate();
      return;
    }

    if (message.type === "error") {
      lastError.textContent = (message.code || "gateway-error") + ": " + (message.message || event.data);
    }
  }

  function connect() {
    var gatewayUrl = gatewayInput.value.replace(/^\s+|\s+$/g, "");
    if (!validGatewayUrl(gatewayUrl)) {
      lastError.textContent = "Enter a ws:// or wss:// gateway URL.";
      gatewayInput.focus();
      return;
    }

    disconnect(false);
    manualDisconnect = false;
    saveGatewayUrl(gatewayUrl);
    setStatus("Connecting", "connecting");
    lastError.textContent = "None";

    try {
      socket = new WebSocket(gatewayUrl);
    } catch (error) {
      lastError.textContent = error.message;
      scheduleReconnect();
      return;
    }

    socket.onopen = function () {
      setStatus("Handshaking", "connecting");
      send({ type: "hello", protocolVersion: protocolVersion });
    };
    socket.onmessage = handleMessage;
    socket.onerror = function () {
      lastError.textContent = "WebSocket error. Check the gateway log for the Origin value and rejection reason.";
    };
    socket.onclose = function (event) {
      socket = null;
      if (!manualDisconnect) {
        lastError.textContent = "Closed: " + event.code + (event.reason ? " - " + event.reason : "");
        scheduleReconnect();
      }
    };
  }

  document.getElementById("app-origin").textContent = window.location.origin || "(not exposed)";
  gatewayInput.value = storedGatewayUrl();
  document.getElementById("connect-button").addEventListener("click", connect);
  document.getElementById("disconnect-button").addEventListener("click", function () { disconnect(true); });
  window.addEventListener("online", function () { if (!manualDisconnect) { connect(); } });
  window.addEventListener("offline", function () { setStatus("Network offline", "disconnected"); });
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && (!socket || socket.readyState > WebSocket.OPEN) && !manualDisconnect) {
      connect();
    }
  });
  window.setInterval(updateRate, 1000);

  connect();
}());

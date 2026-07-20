/* global WebSocket, document, location, requestAnimationFrame, setInterval, setTimeout, window */

(() => {
  "use strict";

  const APPLICATIONS = {
    "dallas-overview": {
      template: "view-overview",
      crumb: "PLANT",
      purpose: "Supervisor overview · both production lines",
      capabilities: ["signals", "alarms", "fleet"],
    },
    "dallas-line-1": {
      template: "view-line-1",
      crumb: "LINE 01 / FILLING",
      purpose: "Sony shop-floor mirror · gw-fill-01",
      capabilities: ["signals", "alarms"],
    },
    "dallas-line-2": {
      template: "view-line-2",
      crumb: "LINE 02 / PACKAGING",
      purpose: "Samsung shop-floor mirror · gw-pack-01",
      capabilities: ["signals", "alarms"],
    },
  };

  const DEVICE_HINTS = {
    fill: ["fill", "line1", "line-1", "line_1"],
    pack: ["pack", "line2", "line-2", "line_2", "kepware", "case"],
  };

  const params = new URLSearchParams(location.search);
  const pathMatch = location.pathname.match(/\/apps\/([^/]+)/);
  const appId = APPLICATIONS[pathMatch?.[1]] ? pathMatch[1] : "dallas-overview";
  const app = APPLICATIONS[appId];
  const bridgeOrigin = resolveBridgeOrigin(params.get("bridge"));
  const wsUrl = new URL(`/apps/${appId}/ws`, bridgeOrigin);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";

  const state = {
    socket: null,
    reconnectAttempt: 0,
    reconnectTimer: null,
    intentionallyClosed: false,
    envelopeTimes: [],
    mapped: { fill: new Set(), pack: new Set() },
    signalValues: new Map(),
    pressureTrend: [108, 111, 110, 113, 111, 109, 110, 112, 112.4],
    currentTrend: [5.7, 6.0, 5.9, 6.2, 5.6, 6.0, 5.5, 5.8, 6.2],
    jammed: false,
  };

  mountView();
  initializePallet();
  initializeNavigation();
  initializeClock();
  initializeEnvelopeMeter();
  connect();

  function resolveBridgeOrigin(raw) {
    if (!raw) return location.origin;
    try {
      const candidate = new URL(raw, location.href);
      if (candidate.protocol === "http:" || candidate.protocol === "https:") return candidate.origin;
    } catch {
      // The status panel reports the fallback; an invalid query value never reaches WebSocket.
    }
    return location.origin;
  }

  function mountView() {
    const template = document.getElementById(app.template);
    const view = document.getElementById("view");
    view.replaceChildren(template.content.cloneNode(true));
    document.getElementById("view-crumb").textContent = app.crumb;
    document.getElementById("view-purpose").textContent = app.purpose;
    document.title = `${app.crumb.replace(" / ", " · ")} — Dallas operations`;

    for (const link of document.querySelectorAll("[data-app-link]")) {
      const destination = link.dataset.appLink;
      const url = new URL(`/apps/${destination}/`, bridgeOrigin);
      link.href = url.href;
      if (destination === appId && link.closest(".line-nav")) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }

    requestAnimationFrame(() => view.focus({ preventScroll: true }));
  }

  function initializeNavigation() {
    const shortcuts = { "0": "dallas-overview", "1": "dallas-line-1", "2": "dallas-line-2" };
    window.addEventListener("keydown", (event) => {
      const tag = event.target?.tagName?.toLowerCase();
      if (event.ctrlKey || event.metaKey || event.altKey || tag === "input" || tag === "textarea" || tag === "select") return;
      const destination = shortcuts[event.key];
      if (!destination) return;
      event.preventDefault();
      location.assign(new URL(`/apps/${destination}/`, bridgeOrigin));
    });
  }

  function initializeClock() {
    const clock = document.getElementById("clock");
    const render = () => {
      clock.dateTime = new Date().toISOString();
      clock.textContent = new Intl.DateTimeFormat("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).format(new Date());
    };
    render();
    setInterval(render, 1000);
  }

  function initializeEnvelopeMeter() {
    setInterval(() => {
      const cutoff = performance.now() - 1000;
      state.envelopeTimes = state.envelopeTimes.filter((time) => time >= cutoff);
      const output = document.getElementById("envelope-rate");
      if (output) output.textContent = state.envelopeTimes.length.toFixed(1);
    }, 250);
  }

  function initializePallet() {
    renderPallet(valueFor("PalletCaseCount") ?? 91);
  }

  function connect() {
    clearTimeout(state.reconnectTimer);
    setConnection("connecting", "Connecting to bridge", `${wsUrl.host} · ${appId}`);
    const socket = new WebSocket(wsUrl);
    state.socket = socket;

    socket.addEventListener("open", () => {
      state.reconnectAttempt = 0;
      setConnection("connecting", "Bridge connected", "Negotiating application protocol v1");
      socket.send(JSON.stringify({ type: "hello", protocolVersion: 1 }));
    });

    socket.addEventListener("message", (event) => {
      try {
        handleMessage(JSON.parse(event.data));
      } catch (error) {
        setConnection("warning", "Data warning", error instanceof Error ? error.message : "Unreadable bridge message");
      }
    });

    socket.addEventListener("close", () => {
      if (state.intentionallyClosed) return;
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      setConnection("warning", "Bridge unavailable", `${wsUrl.host} · retrying`);
    });
  }

  function scheduleReconnect() {
    state.reconnectAttempt += 1;
    const delay = Math.min(10000, 750 * (2 ** Math.min(4, state.reconnectAttempt - 1)));
    setConnection("warning", "Bridge disconnected", `Retrying in ${(delay / 1000).toFixed(1)}s`);
    state.reconnectTimer = setTimeout(connect, delay);
  }

  function handleMessage(message) {
    if (message.type === "welcome") {
      if (message.protocolVersion !== 1 || message.appId !== appId) {
        throw new Error("Bridge returned an unexpected application session");
      }
      state.socket.send(JSON.stringify({
        type: "subscribe",
        protocolVersion: 1,
        capabilities: app.capabilities,
      }));
      return;
    }

    if (message.type === "subscribed") {
      setConnection("connected", "Bridge live", `${appId} · max ${message.maxUpdateHz ?? 30} envelopes/s`);
      return;
    }

    if (message.type === "error") {
      setConnection("warning", `Bridge error · ${message.code ?? "unknown"}`, message.message ?? "Application request rejected");
      return;
    }

    if (message.type !== "updates") return;
    state.envelopeTimes.push(performance.now());
    for (const frame of message.frames ?? []) handleFrame(frame);
    handleOverflow(message.overflow);
  }

  function handleFrame(frame) {
    if (frame.type === "signals") {
      for (const series of frame.series ?? []) applySignal(series, series.latest);
      return;
    }
    if (frame.type === "signal") {
      for (const update of frame.updates ?? []) applySignal(update, update.point?.value);
      return;
    }
    if (frame.type === "alarms") updateAlarmSummary(frame.alarms ?? []);
  }

  function handleOverflow(overflow) {
    if (!overflow) return;
    const dropped = Number(overflow.droppedOrdered ?? 0)
      + Number(overflow.droppedState ?? 0)
      + Number(overflow.droppedUpstream ?? 0);
    if (dropped > 0) setConnection("warning", "Bridge live · updates coalesced", `${dropped.toLocaleString()} superseded updates`);
  }

  function applySignal(item, value) {
    if (value === undefined || value === null) return;
    const candidates = signalCandidates(item);
    const canonical = candidates[0];
    const line = lineFor(item, candidates);
    let matched = false;

    for (const element of document.querySelectorAll("[data-signal]")) {
      if (!candidates.some((candidate) => signalMatches(candidate, element.dataset.signal))) continue;
      const expectedLine = element.dataset.device;
      if (line && expectedLine && line !== expectedLine) continue;
      element.textContent = formatValue(value, element.dataset.format);
      element.classList.remove("value-updated");
      requestAnimationFrame(() => element.classList.add("value-updated"));
      matched = true;
    }

    const knownLine = lineForKnownSignal(canonical);
    const resolvedLine = line ?? knownLine;
    if (matched || knownLine) {
      if (resolvedLine) markSignalLive(resolvedLine, canonical);
      state.signalValues.set(normalizeSignal(canonical), value);
    }
    updateDerivedValues(canonical, value, resolvedLine);
  }

  function signalCandidates(item) {
    const candidates = [item.signal, item.name, item.signalId]
      .filter((candidate) => typeof candidate === "string" && candidate.trim() !== "")
      .map(normalizeSignal);
    return [...new Set(candidates)];
  }

  function normalizeSignal(value) {
    return String(value ?? "")
      .trim()
      .split(/[\/.|:]/)
      .at(-1)
      .replace(/[^a-zA-Z0-9]/g, "")
      .toLowerCase();
  }

  function signalMatches(candidate, expected) {
    const normalizedExpected = normalizeSignal(expected);
    return candidate === normalizedExpected || candidate.endsWith(normalizedExpected);
  }

  function lineFor(item, signalNames) {
    const identity = [
      item.key?.device,
      item.key?.component,
      item.instance,
      item.adapter,
      item.endpoint,
      ...signalNames,
    ].filter(Boolean).join(" ").toLowerCase();
    if (DEVICE_HINTS.fill.some((hint) => identity.includes(hint))) return "fill";
    if (DEVICE_HINTS.pack.some((hint) => identity.includes(hint))) return "pack";
    return signalNames.map(lineForKnownSignal).find(Boolean);
  }

  function lineForKnownSignal(signal) {
    const fillSignals = [
      "linespeedbpm", "oeepct", "availabilitypct", "performancepct", "qualitypct",
      "fillpressurekpa", "fillvolumeml", "goodbottlecount", "rejectcount",
      "producttempc", "bowllevelpct", "fillerstate",
    ];
    const packSignals = [
      "caseratecpm", "goodcasecount", "caserejectcount", "packermotorcurrenta",
      "gluetempc", "visionpasspct", "caseweightkg", "labelcode", "palletcasecount",
      "cartonmagazinepct", "jamstatus", "packerstate",
    ];
    const normalized = normalizeSignal(signal);
    if (fillSignals.some((known) => normalized.endsWith(known))) return "fill";
    if (packSignals.some((known) => normalized.endsWith(known))) return "pack";
    return null;
  }

  function formatValue(value, format) {
    if (format === undefined) return String(value);
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) return String(value);
    if (format === "integer") return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(numeric);
    if (format === "one") return numeric.toFixed(1);
    if (format === "two") return numeric.toFixed(2);
    return String(value);
  }

  function markSignalLive(line, signal) {
    state.mapped[line].add(normalizeSignal(signal));
    for (const output of document.querySelectorAll(`[data-live-signals="${line}"]`)) {
      output.textContent = state.mapped[line].size.toString();
    }
    for (const health of document.querySelectorAll(".source-health")) {
      if (health.closest(`[data-line="${line}"]`)) health.classList.add("is-live");
    }
    for (const output of document.querySelectorAll("[data-source-status]")) {
      if (output.closest(`[data-line="${line}"]`)) output.textContent = "LIVE SIMULATOR DATA";
    }
    document.querySelector(`[data-nav-state="${line}"]`)?.classList.add("is-live");
  }

  function updateDerivedValues(signal, value, line) {
    const normalized = normalizeSignal(signal);
    if (normalized.endsWith("fillpressurekpa")) updateTrend("FillPressureKpa", value, 95, 140, state.pressureTrend);
    if (normalized.endsWith("packermotorcurrenta")) updateTrend("PackerMotorCurrentA", value, 4, 9, state.currentTrend);
    if (normalized.endsWith("palletcasecount")) renderPallet(value);
    if (normalized.endsWith("oeepct")) updateOeeRing(value);
    if (normalized.endsWith("jamstatus")) setJamState(value);
    if (normalized.endsWith("fillerstate") || normalized.endsWith("packerstate")) setLineState(line, value);
    if (normalized.endsWith("goodbottlecount") || normalized.endsWith("goodcasecount")) updateAggregateCount();
    if (normalized.endsWith("cartonmagazinepct")) updateCartonAttention(value);
  }

  function updateTrend(name, rawValue, min, max, history) {
    const value = Number(rawValue);
    if (!Number.isFinite(value)) return;
    history.push(value);
    if (history.length > 18) history.shift();
    const points = history.map((point, index) => {
      const x = history.length === 1 ? 0 : (index / (history.length - 1)) * 600;
      const y = 112 - ((Math.max(min, Math.min(max, point)) - min) / (max - min)) * 96;
      return [x, y];
    });
    const linePath = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
    const areaPath = `${linePath} L600 120 L0 120Z`;
    document.querySelector(`[data-trend-line="${name}"]`)?.setAttribute("d", linePath);
    document.querySelector(`[data-trend-area="${name}"]`)?.setAttribute("d", areaPath);
  }

  function updateOeeRing(rawValue) {
    const value = Math.max(0, Math.min(100, Number(rawValue)));
    if (!Number.isFinite(value)) return;
    const ring = document.querySelector("[data-oee-ring]");
    if (ring) ring.style.background = `radial-gradient(circle, #13162a 57%, transparent 59%), conic-gradient(#60cc8a ${value}%, #343b56 0)`;
  }

  function renderPallet(rawCount) {
    const count = Math.max(0, Math.min(120, Math.round(Number(rawCount) || 0)));
    const percent = Math.round((count / 120) * 100);
    const layer = count === 0 ? 1 : Math.min(5, Math.ceil(count / 24));
    const loadedOnLayer = count === 0 ? 0 : ((count - 1) % 24) + 1;
    for (const output of document.querySelectorAll("[data-pallet-percent]")) output.textContent = percent.toString();
    for (const output of document.querySelectorAll("[data-pallet-layer]")) output.textContent = `${layer} / 5`;
    for (const bar of document.querySelectorAll("[data-pallet-progress], .mini-pallet > i > b")) bar.style.width = `${percent}%`;
    const grid = document.querySelector("[data-pallet-grid]");
    if (!grid) return;
    grid.replaceChildren();
    for (let position = 1; position <= 24; position += 1) {
      const cell = document.createElement("i");
      cell.textContent = position.toString().padStart(2, "0");
      if (position <= loadedOnLayer) cell.className = "is-loaded";
      else if (position === loadedOnLayer + 1) cell.className = "is-next";
      grid.append(cell);
    }
    grid.setAttribute("aria-label", `Pallet layer ${layer}: ${loadedOnLayer} of 24 case positions loaded`);
  }

  function setJamState(rawValue) {
    const value = String(rawValue).trim().toLowerCase();
    const jammed = rawValue === true || rawValue === 1 || ["1", "true", "jam", "jammed", "blocked", "tripped", "fault"].includes(value);
    state.jammed = jammed;
    document.querySelector(".floor-view--pack")?.classList.toggle("is-jammed", jammed);
    document.querySelector(".jam-panel")?.classList.toggle("is-alert", jammed);
    setText("[data-jam-risk]", jammed ? "JAM ACTIVE" : "LOW RISK");
    setText("[data-jam-state]", jammed ? "TRIPPED" : "CLEAR");
    setText("[data-packer-state]", jammed ? "Blocked" : "Running");
    setText("[data-pack-attention]", jammed ? "Packer jam detected · operator response required" : "Carton magazine refill in approximately 11 minutes");
    document.querySelector('[data-nav-state="pack"]')?.classList.toggle("is-alert", jammed);
    if (jammed) setLineState("pack", "STOPPED · JAM");
  }

  function setLineState(line, rawValue) {
    if (!line) return;
    const label = String(rawValue).replace(/[_-]+/g, " ").trim().toUpperCase();
    if (!label) return;
    for (const output of document.querySelectorAll(`[data-line-state="${line}"]`)) output.textContent = label;
  }

  function updateAggregateCount() {
    const bottles = Number(valueFor("GoodBottleCount")) || 0;
    const cases = Number(valueFor("GoodCaseCount")) || 0;
    for (const output of document.querySelectorAll("[data-aggregate-count]")) {
      output.textContent = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(bottles + cases);
    }
  }

  function updateCartonAttention(rawValue) {
    const value = Number(rawValue);
    if (!Number.isFinite(value) || state.jammed) return;
    const minutes = Math.max(1, Math.round(value / 5.5));
    setText("[data-pack-attention]", `NEXT · Carton magazine refill in approximately ${minutes} minutes`);
  }

  function updateAlarmSummary(alarms) {
    if (!Array.isArray(alarms)) return;
    const active = alarms.filter((alarm) => alarm.active !== false && alarm.state !== "cleared").length;
    for (const output of document.querySelectorAll("[data-attention-count]")) output.textContent = active.toString();
    const detail = active === 0 ? "No active broker alarms" : `${active} active broker alarm${active === 1 ? "" : "s"}`;
    setText("[data-attention-detail]", detail);
  }

  function valueFor(signal) {
    const key = normalizeSignal(signal);
    if (state.signalValues.has(key)) return state.signalValues.get(key);
    const element = document.querySelector(`[data-signal="${signal}"]`);
    return element ? Number(element.textContent.replace(/,/g, "")) : undefined;
  }

  function setText(selector, value) {
    for (const output of document.querySelectorAll(selector)) output.textContent = value;
  }

  function setConnection(mode, label, detail) {
    const dot = document.getElementById("bridge-dot");
    dot.classList.toggle("is-live", mode === "connected");
    dot.classList.toggle("is-warn", mode === "warning" || mode === "connecting");
    document.getElementById("bridge-status").textContent = label;
    document.getElementById("bridge-detail").textContent = detail;
  }

  window.addEventListener("beforeunload", () => {
    state.intentionallyClosed = true;
    clearTimeout(state.reconnectTimer);
    state.socket?.close();
  });
})();

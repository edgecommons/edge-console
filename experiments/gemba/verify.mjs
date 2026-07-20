/* global URL, clearTimeout, console, fetch, performance, process, setTimeout */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";

const execFileAsync = promisify(execFile);
const base = process.env.GEMBA_BASE_URL ?? "http://127.0.0.1:18443";
const wsBase = base.replace(/^http/, "ws");
const externalUi = process.env.GEMBA_EXTERNAL_UI_URL;
const burstPort = process.env.GEMBA_BURST_BROKER_PORT;
const origins = {
  andon: "http://127.0.0.1:15174",
  "gemba-board": "http://127.0.0.1:15175",
  "dallas-overview": "http://127.0.0.1:18443",
  "dallas-line-1": "http://127.0.0.1:18443",
  "dallas-line-2": "http://127.0.0.1:18443",
  restricted: "http://127.0.0.1:15176",
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectHttp(path, status, marker) {
  const response = await fetch(`${base}${path}`);
  assert(response.status === status, `${path}: expected HTTP ${status}, got ${response.status}`);
  if (marker !== undefined) {
    const body = await response.text();
    assert(body.includes(marker), `${path}: response did not contain ${marker}`);
  }
}

class WsClient {
  constructor(path, origin) {
    this.messages = [];
    this.waiters = [];
    this.socket = new WebSocket(`${wsBase}${path}`, origin === undefined ? {} : { origin });
    this.socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      this.messages.push({ message, at: performance.now() });
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  async open(timeoutMs = 5000) {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("WebSocket open timed out")), timeoutMs);
      this.socket.once("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      this.socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  async waitFor(predicate, timeoutMs = 5000, after = 0) {
    const existing = this.messages.slice(after).find(({ message }) => predicate(message));
    if (existing !== undefined) return existing;
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      await new Promise((resolve, reject) => {
        const remaining = Math.max(1, deadline - performance.now());
        const timeout = setTimeout(() => {
          this.waiters = this.waiters.filter((waiter) => waiter !== wake);
          reject(new Error("WebSocket message timed out"));
        }, remaining);
        const wake = () => {
          clearTimeout(timeout);
          resolve();
        };
        this.waiters.push(wake);
      });
      const found = this.messages.slice(after).find(({ message }) => predicate(message));
      if (found !== undefined) return found;
    }
    throw new Error("WebSocket message timed out");
  }

  close() {
    this.socket.close();
  }
}

async function expectWsRejected(path, origin, status) {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsBase}${path}`, { origin });
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error(`${path}: rejection timed out`));
    }, 5000);
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timeout);
      assert(response.statusCode === status, `${path}: expected ${status}, got ${response.statusCode}`);
      socket.terminate();
      resolve();
    });
    socket.once("open", () => {
      clearTimeout(timeout);
      socket.terminate();
      reject(new Error(`${path}: unexpectedly accepted WebSocket`));
    });
    socket.once("error", () => {});
  });
}

async function consoleCompatibility() {
  const client = new WsClient("/ws");
  await client.open();
  client.send({ type: "hello", protocolVersion: 7 });
  const { message } = await client.waitFor((candidate) => candidate.type === "welcome");
  assert(message.protocolVersion === 7, "legacy Console endpoint did not remain protocol v7");
  client.close();
}

async function externalConsoleCompatibility() {
  if (externalUi === undefined) return false;
  const response = await fetch(externalUi);
  assert(response.status === 200, `external Console UI returned HTTP ${response.status}`);
  const html = await response.text();
  assert(html.includes("id=\"root\""), "external Console UI did not serve its application shell");

  const client = new WsClient("/ws", new URL(externalUi).origin);
  await client.open();
  client.send({ type: "hello", protocolVersion: 7 });
  await client.waitFor((message) => message.type === "welcome" && message.protocolVersion === 7);
  client.close();
  return true;
}

async function openApp(appId, capabilities) {
  const client = new WsClient(`/apps/${appId}/ws`, origins[appId]);
  await client.open();
  client.send({ type: "hello", protocolVersion: 1 });
  const { message: welcome } = await client.waitFor((candidate) => candidate.type === "welcome");
  assert(welcome.appId === appId, `${appId}: route-derived app identity mismatch`);
  assert(welcome.maxUpdateHz === 30, `${appId}: maxUpdateHz is not 30`);
  client.send({ type: "subscribe", protocolVersion: 1, capabilities });
  await client.waitFor((candidate) => candidate.type === "subscribed");
  return client;
}

async function appScope(appId, allowed, denied) {
  console.error(`checking ${appId} scope`);
  const client = await openApp(appId, allowed);
  client.send({ type: "subscribe", protocolVersion: 1, capabilities: [denied] });
  await client.waitFor((candidate) => candidate.type === "error" && candidate.code === "capability-denied");
  client.send({ type: "command", protocolVersion: 1, verb: "ping" });
  await client.waitFor((candidate) => candidate.type === "error" && candidate.code === "command-denied");

  await client.waitFor((candidate) => candidate.type === "updates");
  client.close();
}

function assertThirtyHz(messages, start) {
  const updateTimes = messages
    .filter(({ message, at }) => message.type === "updates" && at >= start)
    .map(({ at }) => at);
  assert(updateTimes.length > 0, "burst produced no application update envelopes");
  for (let index = 0; index < updateTimes.length; index += 1) {
    const windowEnd = updateTimes[index] + 1000;
    const inWindow = updateTimes.filter((at) => at >= updateTimes[index] && at < windowEnd).length;
    assert(inWindow <= 30, `observed ${inWindow} update messages inside one second`);
  }
  return updateTimes.length;
}

async function burstAndIsolation() {
  if (burstPort === undefined) return null;
  console.error("checking burst and stalled-consumer isolation");
  const healthy = await openApp("andon", ["signals"]);
  const stalled = await openApp("gemba-board", ["events"]);
  await new Promise((resolve) => setTimeout(resolve, 500));
  console.error(`initial message types: andon=${healthy.messages.map(({ message }) => message.type).join(",")} gemba=${stalled.messages.map(({ message }) => message.type).join(",")}`);
  await healthy.waitFor((candidate) => candidate.type === "updates");
  console.error("Andon initial snapshot received");
  await stalled.waitFor((candidate) => candidate.type === "updates");
  console.error("initial snapshots received; stalling Gemba board");
  const stalledMarker = stalled.messages.length;

  // Stop consuming bytes from one application while keeping its connection open. The gateway's
  // per-session task may block on that socket, but the Andon session must continue independently.
  stalled.socket._socket.pause();
  const start = performance.now();
  await execFileAsync("py", [
    "-3.14",
    "-B",
    "experiments/gemba/publish_burst.py",
    "--port",
    burstPort,
  ]);
  console.error("broker burst published");
  await healthy.waitFor(
    (candidate) => candidate.type === "updates" && candidate.frames.some(
      (frame) => frame.type === "signal" && frame.updates.some(
        (update) => update.point?.value === 1499,
      ),
    ),
    10000,
  );
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const observed = assertThirtyHz(healthy.messages, start);
  const liveSignalValues = healthy.messages
    .filter(({ message, at }) => at >= start && message.type === "updates")
    .flatMap(({ message }) => message.frames)
    .filter((frame) => frame.type === "signal")
    .flatMap((frame) => frame.updates)
    .map((update) => update.point?.value);
  assert(liveSignalValues.at(-1) === 1499, "healthy Andon application did not converge to signal value 1499");

  stalled.socket._socket.resume();
  const { message: overflowMessage } = await stalled.waitFor(
    (candidate) => candidate.type === "updates" && (
      candidate.overflow.droppedOrdered > 0
      || candidate.overflow.droppedState > 0
      || candidate.overflow.droppedUpstream > 0
    ),
    10000,
    stalledMarker,
  );
  stalled.socket.terminate();
  console.error("healthy peer remained live; reconnecting stalled Gemba board");
  const reconnected = await openApp("gemba-board", ["events"]);
  const { message: snapshot } = await reconnected.waitFor(
    (candidate) => candidate.type === "updates" && candidate.frames.some((frame) => frame.type === "events"),
  );
  const retainedEvents = snapshot.frames.find((frame) => frame.type === "events").events;
  assert(retainedEvents.length === 100, `expected 100 retained events, got ${retainedEvents.length}`);
  const retainedSequences = retainedEvents.map((event) => event.body.sequence);
  assert(retainedSequences[0] === 1199, `newest retained event was ${retainedSequences[0]}, not 1199`);
  assert(retainedSequences.at(-1) === 1100, `oldest retained event was ${retainedSequences.at(-1)}, not 1100`);
  console.error("reconnected Gemba board received retained snapshot");
  reconnected.close();
  healthy.close();
  return {
    healthyUpdateMessages: observed,
    finalSignalValue: liveSignalValues.at(-1),
    stalledOverflow: overflowMessage.overflow,
    retainedEventCount: retainedEvents.length,
    retainedSequenceRange: [retainedSequences[0], retainedSequences.at(-1)],
    stalledPeerReconnected: true,
  };
}

console.error("checking HTTP and Console compatibility");
await expectHttp("/healthz", 200, "ok");
await expectHttp("/", 404);
await expectHttp("/apps/andon/", 200, "Dallas Andon");
await expectHttp("/apps/gemba-board/", 200, "Dallas floor board");
await expectHttp("/apps/dallas-overview/", 200, "Dallas operations");
await expectHttp("/apps/dallas-line-1/", 200, "Dallas operations");
await expectHttp("/apps/dallas-line-2/", 200, "Dallas operations");
await expectHttp("/apps/missing/", 404);
await consoleCompatibility();
const externalConsole = await externalConsoleCompatibility();
console.error("checking origin and role denials");
await expectWsRejected("/apps/gemba-board/ws", origins.andon, 403);
await expectWsRejected("/apps/restricted/ws", origins.restricted, 403);
await appScope("andon", ["signals", "alarms"], "events");
await appScope("gemba-board", ["fleet", "events", "attributes"], "signals");
await appScope("dallas-overview", ["signals", "alarms", "fleet"], "events");
await appScope("dallas-line-1", ["signals", "alarms"], "events");
await appScope("dallas-line-2", ["signals", "alarms"], "events");
const burst = await burstAndIsolation();

console.log(JSON.stringify({
  ok: true,
  gateway: base,
  legacyConsoleProtocol: 7,
  externalConsole,
  applications: ["andon", "gemba-board", "dallas-overview", "dallas-line-1", "dallas-line-2"],
  crossApplicationOriginDenied: true,
  disallowedPrincipalRoleDenied: true,
  burst,
  maxUpdateHz: 30,
}, null, 2));

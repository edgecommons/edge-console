/* global clearTimeout, console, fetch, performance, process, setTimeout */

import WebSocket from "ws";

const base = process.env.GEMBA_TV_BASE_URL ?? "http://127.0.0.1:18445";
const wsBase = base.replace(/^http/, "ws");
const path = "/apps/tv-board/ws";
const capabilities = ["fleet", "events", "signals", "attributes", "alarms"];
const clients = [
  { name: "google-tv-native", origin: "https://google-tv.edgecommons.local" },
  { name: "tizen-hosted-equivalent", origin: "http://192.168.1.224:18445" },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

class TvClient {
  constructor(name, origin) {
    this.name = name;
    this.messages = [];
    this.waiters = [];
    this.socket = new WebSocket(`${wsBase}${path}`, { origin });
    this.socket.on("message", (data) => {
      const message = JSON.parse(data.toString());
      this.messages.push({ message, at: performance.now() });
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  async open(timeoutMs = 5000) {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${this.name}: open timed out`)), timeoutMs);
      this.socket.once("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      this.socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    this.socket.send(JSON.stringify({ type: "hello", protocolVersion: 1 }));
    const welcome = await this.waitFor((message) => message.type === "welcome");
    assert(welcome.appId === "tv-board", `${this.name}: route-derived app identity mismatch`);
    assert(welcome.maxUpdateHz === 30, `${this.name}: gateway did not advertise a 30 Hz ceiling`);
    this.socket.send(JSON.stringify({ type: "subscribe", protocolVersion: 1, capabilities }));
    await this.waitFor((message) => message.type === "subscribed");
  }

  async waitFor(predicate, timeoutMs = 8000) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const found = this.messages.find(({ message }) => predicate(message));
      if (found !== undefined) return found.message;
      await new Promise((resolve, reject) => {
        const remaining = Math.max(1, deadline - performance.now());
        const timeout = setTimeout(() => {
          this.waiters = this.waiters.filter((waiter) => waiter !== wake);
          reject(new Error(`${this.name}: message timed out`));
        }, remaining);
        const wake = () => {
          clearTimeout(timeout);
          resolve();
        };
        this.waiters.push(wake);
      });
    }
    throw new Error(`${this.name}: message timed out`);
  }

  close() {
    this.socket.close();
  }
}

const health = await fetch(`${base}/healthz`);
assert(health.status === 200, `gateway health returned ${health.status}`);
const appShell = await fetch(`${base}/apps/tv-board/`);
assert(appShell.status === 200, `Tizen app shell returned ${appShell.status}`);
assert((await appShell.text()).includes("Dallas Gemba Board"), "Tizen app shell marker missing");

const connected = clients.map(({ name, origin }) => new TvClient(name, origin));
try {
  await Promise.all(connected.map((client) => client.open()));
  await Promise.all(connected.map((client) => client.waitFor((message) => message.type === "updates")));
  for (const client of connected) {
    console.error(`${client.name}: ${client.messages.map(({ message }) => message.type).join(", ")}`);
  }
} finally {
  for (const client of connected) client.close();
}

console.log(JSON.stringify({
  gateway: base,
  concurrentClients: connected.length,
  application: "tv-board",
  protocolVersion: 1,
  maxUpdateHz: 30,
  result: "passed",
}, null, 2));

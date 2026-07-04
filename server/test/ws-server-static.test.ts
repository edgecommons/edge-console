/**
 * WsServer's opt-in static-UI serving (`console.ws.webRoot`) over a REAL localhost
 * socket - the same style as `ws-server.test.ts` (real `fetch`/`WebSocket`, loopback +
 * an OS-assigned ephemeral port). Builds a throwaway "built UI" directory per test run
 * (an `index.html` + a hashed asset under `assets/`) so nothing here depends on the
 * real `ui/dist` being built.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FleetModel } from "../src/fleet/fleet-model";
import { FleetWsGateway } from "../src/ws/gateway";
import { WsServer } from "../src/ws/ws-server";

const LOOPBACK = "127.0.0.1";
const INDEX_HTML = "<!doctype html><html><body>edge-console UI</body></html>";
const ASSET_JS = "console.log('hashed asset');";

/** A throwaway "built UI" directory: `index.html` + `assets/index-ABC123.js`. */
function makeWebRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "edge-console-ui-"));
  writeFileSync(join(root, "index.html"), INDEX_HTML, "utf8");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "index-ABC123.js"), ASSET_JS, "utf8");
  return root;
}

let activeServer: WsServer | undefined;
let activeWebRoot: string | undefined;

afterEach(async () => {
  if (activeServer !== undefined) {
    await activeServer.stop();
    activeServer = undefined;
  }
  if (activeWebRoot !== undefined) {
    rmSync(activeWebRoot, { recursive: true, force: true });
    activeWebRoot = undefined;
  }
});

async function startServer(webRoot?: string): Promise<{ server: WsServer; url: string }> {
  const model = new FleetModel(() => Date.now());
  const gateway = new FleetWsGateway(model, { clock: () => Date.now() });
  const server = new WsServer(gateway, {
    port: 0,
    bindAddress: LOOPBACK,
    ...(webRoot !== undefined ? { webRoot } : {}),
  });
  activeServer = server;
  await server.start();
  const addr = server.address();
  if (addr === null) throw new Error("server did not bind");
  return { server, url: `http://${LOOPBACK}:${addr.port}` };
}

async function startServerWithUi(): Promise<{ server: WsServer; url: string }> {
  const root = makeWebRoot();
  activeWebRoot = root;
  return startServer(root);
}

describe("WsServer - static UI serving (console.ws.webRoot)", () => {
  it("serves index.html at /", async () => {
    const { url } = await startServerWithUi();
    const res = await fetch(url + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it("serves a hashed asset with the right content-type and an immutable cache header", async () => {
    const { url } = await startServerWithUi();
    const res = await fetch(url + "/assets/index-ABC123.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(await res.text()).toBe(ASSET_JS);
  });

  it("SPA-fallback: an unknown non-asset route serves index.html (client-side router deep-link)", async () => {
    const { url } = await startServerWithUi();
    const res = await fetch(url + "/topology/gw-01/opcua-adapter");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it("404s a genuinely missing asset (no SPA fallback for asset-shaped paths)", async () => {
    const { url } = await startServerWithUi();
    const res = await fetch(url + "/assets/does-not-exist.js");
    expect(res.status).toBe(404);
  });

  it("blocks path traversal outside the web root", async () => {
    const { url } = await startServerWithUi();
    // `fetch` (undici) normalizes `..` out of a URL before ever sending the request, so
    // it can't reach the server's own guard - drive the raw wire request instead, both
    // with a literal `..` segment and its percent-encoded form.
    const literal = await rawRequest(url, "/../../../../../../etc/passwd");
    expect(literal.status).toBe(403);
    const encoded = await rawRequest(url, "/assets/%2e%2e/%2e%2e/%2e%2e/secret.txt");
    expect(encoded.status).toBe(403);
    const encodedSlashes = await rawRequest(url, "/..%2f..%2f..%2fetc%2fpasswd");
    expect(encodedSlashes.status).toBe(403);
  });

  it("rejects a malformed percent-encoding (decode failure) rather than serving anything", async () => {
    const { url } = await startServerWithUi();
    const res = await rawRequest(url, "/%");
    expect(res.status).toBe(403);
  });

  it("still serves /healthz", async () => {
    const { url } = await startServerWithUi();
    const res = await fetch(url + "/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok\n");
  });

  it("still handles the /ws upgrade", async () => {
    const { url } = await startServerWithUi();
    const ws = new WebSocket(url.replace("http://", "ws://") + "/ws");
    await new Promise<void>((resolvePromise, reject) => {
      ws.addEventListener("open", () => resolvePromise(), { once: true });
      ws.addEventListener("error", () => reject(new Error("ws open failed")), { once: true });
    });
    ws.close();
  });

  it("backward compat: with webRoot UNSET, / still 404s exactly as before this feature", async () => {
    const { url } = await startServer(); // no webRoot
    const res = await fetch(url + "/");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found\n");
  });
});

/**
 * A raw HTTP GET using Node's low-level `http` client rather than `fetch`: `fetch`
 * (undici) normalizes `..` segments out of the URL before sending the request, so it
 * can never actually exercise the server's own traversal guard. A raw socket write
 * lets an attacker-supplied literal `..`/percent-encoded path reach the server exactly
 * as sent.
 */
function rawRequest(baseUrl: string, rawPath: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    const { hostname, port } = new URL(baseUrl);
    const socket = connect(Number(port), hostname, () => {
      socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`);
    });
    let raw = "";
    socket.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    socket.on("end", () => {
      const statusLine = raw.split("\r\n")[0] ?? "";
      const match = /^HTTP\/1\.1 (\d+)/.exec(statusLine);
      const status = match?.[1] !== undefined ? Number(match[1]) : 0;
      const body = raw.split("\r\n\r\n")[1] ?? "";
      resolvePromise({ status, body });
    });
    socket.on("error", reject);
  });
}

/**
 * The C2 IO edge (`WsServer`) over a REAL localhost socket — everything else in this
 * slice is tested pure (ws-gateway.test.ts, ws-delta-buffer.test.ts, protocol-ws.test.ts).
 * This file is deliberately small: it only proves the `ws`/`http` wiring itself (health
 * route, 404, upgrade handling) plus the one required integration round-trip —
 * snapshot-then-delta over a real WebSocket, driving the FleetModel directly (no
 * broker/BusIngress needed). Uses REAL timers (no fake clock) since it exercises real
 * socket I/O; binds to loopback + an OS-assigned ephemeral port (never `0.0.0.0`) so it
 * is safe/fast to run anywhere, including under a firewall-prompting OS.
 */
import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@edgecommons/edge-console-protocol";
import type { ServerMessage } from "@edgecommons/edge-console-protocol";

import { FleetModel } from "../src/fleet/fleet-model";
import type { IngressEvent } from "../src/ingress/normalizer";
import { FleetWsGateway } from "../src/ws/gateway";
import { WsServer } from "../src/ws/ws-server";

const LOOPBACK = "127.0.0.1";

function dataEvent(channel: string, device = "gw-01"): IngressEvent {
  return {
    kind: "envelope",
    cls: "data",
    channel,
    identity: { hier: [{ level: "device", value: device }], path: device, component: "comp", instance: "main" },
    body: { v: channel },
    topic: `ecv1/${device}/comp/main/data/${channel}`,
  };
}

/** Await exactly one WS text frame, parsed as JSON. */
function nextMessage(ws: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    ws.addEventListener(
      "message",
      (ev) => {
        try {
          resolve(JSON.parse(String(ev.data)) as ServerMessage);
        } catch (e) {
          reject(e as Error);
        }
      },
      { once: true },
    );
  });
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("ws open failed")), { once: true });
  });
}

let activeServer: WsServer | undefined;

afterEach(async () => {
  if (activeServer !== undefined) {
    await activeServer.stop();
    activeServer = undefined;
  }
});

async function startServer(): Promise<{ server: WsServer; model: FleetModel; url: string }> {
  const model = new FleetModel(() => Date.now());
  const gateway = new FleetWsGateway(model, { clock: () => Date.now() });
  const server = new WsServer(gateway, { port: 0, bindAddress: LOOPBACK });
  activeServer = server;
  await server.start();
  const addr = server.address();
  if (addr === null) throw new Error("server did not bind");
  return { server, model, url: `ws://${LOOPBACK}:${addr.port}` };
}

describe("WsServer - HTTP surface", () => {
  it("serves /healthz", async () => {
    const { url } = await startServer();
    const res = await fetch(url.replace("ws://", "http://") + "/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok\n");
  });

  it("404s on an unknown path", async () => {
    const { url } = await startServer();
    const res = await fetch(url.replace("ws://", "http://") + "/nope");
    expect(res.status).toBe(404);
  });
});

describe("WsServer - real WS round-trip (the required C2 integration proof)", () => {
  it("snapshot-then-delta over a real localhost socket, driving the FleetModel directly", async () => {
    const { model, url } = await startServer();
    model.ingest(dataEvent("seed"));

    const ws = new WebSocket(`${url}/ws`);
    await waitOpen(ws);

    const snapshotPromise = nextMessage(ws);
    ws.send(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION }));
    const snapshotMsg = await snapshotPromise;
    expect(snapshotMsg.type).toBe("snapshot");
    expect(snapshotMsg.type === "snapshot" && snapshotMsg.snapshot.devices[0]?.device).toBe("gw-01");

    const deltaPromise = nextMessage(ws);
    model.ingest(dataEvent("live"));
    const deltaMsg = await deltaPromise;
    expect(deltaMsg.type).toBe("delta");
    expect(deltaMsg.type === "delta" && deltaMsg.deltas[0]?.type).toBe("value-updated");

    ws.close();
  });

  it("rejects an unauthenticated-looking malformed frame over the real socket", async () => {
    const { url } = await startServer();
    const ws = new WebSocket(`${url}/ws`);
    await waitOpen(ws);

    const errorPromise = nextMessage(ws);
    ws.send("not json");
    const errorMsg = await errorPromise;
    expect(errorMsg.type).toBe("error");

    await new Promise<void>((resolve) => ws.addEventListener("close", () => resolve(), { once: true }));
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});

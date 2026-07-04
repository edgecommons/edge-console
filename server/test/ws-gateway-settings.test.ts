/**
 * The R6 `settings` frame on the WS gateway: the console's own effective policy +
 * configuration, pushed right after `welcome` on hello (server-initiated, no client
 * request), and gracefully OMITTED when no settings source is wired.
 */
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "@edgecommons/edge-console-protocol";
import type { ConsoleSettings, ServerMessage } from "@edgecommons/edge-console-protocol";

import { FleetModel } from "../src/fleet/fleet-model";
import { consoleSettings } from "../src/fleet/console-settings";
import { DEFAULT_CONSOLE_CONFIG } from "../src/console-config";
import { FleetWsGateway } from "../src/ws/gateway";
import type { ClientTransport } from "../src/ws/gateway";

const clock = (): number => 1_000_000;

class FakeTransport implements ClientTransport {
  readonly sent: string[] = [];
  closed: { code: number; reason: string } | undefined;
  constructor(readonly id: string) {}
  send(data: string): void {
    this.sent.push(data);
  }
  bufferedAmount(): number {
    return 0;
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  messages(): ServerMessage[] {
    return this.sent.map((s) => JSON.parse(s) as ServerMessage);
  }
}

function hello(): string {
  return JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION });
}

const SETTINGS: ConsoleSettings = consoleSettings(DEFAULT_CONSOLE_CONFIG, {
  device: "gw-dallas-01",
  component: "edge-console",
  platform: "HOST",
  transport: "MQTT",
  broker: "EMQX @ gateway",
});

describe("FleetWsGateway - settings frame (R6)", () => {
  it("pushes settings right after welcome, before the snapshot, on hello", () => {
    const model = new FleetModel(clock);
    const gateway = new FleetWsGateway(model, { clock, consoleSettings: () => SETTINGS });
    const t = new FakeTransport("c1");
    gateway.connect(t).onMessage(hello());

    const msgs = t.messages();
    expect(msgs[0]!.type).toBe("welcome");
    expect(msgs[1]).toEqual({ type: "settings", protocolVersion: PROTOCOL_VERSION, settings: SETTINGS });
    expect(msgs[2]!.type).toBe("snapshot");
  });

  it("omits the settings frame when no settings source is wired (honest degrade)", () => {
    const model = new FleetModel(clock);
    const gateway = new FleetWsGateway(model, { clock });
    const t = new FakeTransport("c1");
    gateway.connect(t).onMessage(hello());

    const types = t.messages().map((m) => m.type);
    expect(types).toEqual(["welcome", "snapshot"]);
  });

  it("re-pushes settings on a fresh hello (reconnect self-heals)", () => {
    const model = new FleetModel(clock);
    const gateway = new FleetWsGateway(model, { clock, consoleSettings: () => SETTINGS });
    const t = new FakeTransport("c1");
    const session = gateway.connect(t);
    session.onMessage(hello());
    session.onMessage(hello());
    const settingsFrames = t.messages().filter((m) => m.type === "settings");
    expect(settingsFrames).toHaveLength(2);
  });
});

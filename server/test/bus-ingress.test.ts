import { describe, expect, it } from "vitest";
import { Message, MessageBuilder, MessageIdentity, Uns } from "@edgecommons/edgecommons";

import { BusIngress } from "../src/ingress/bus-ingress";
import type { IngressEvent } from "../src/ingress/normalizer";
import { FakeBus, makeIdentity, wireEnvelope } from "./_fakes";

/** The console's own identity (a component on the gateway box, rootless topics). */
const CONSOLE_IDENTITY = new MessageIdentity([{ level: "device", value: "gw-01" }], "edge-console");

function makeIngress(bus: FakeBus): { ingress: BusIngress; events: IngressEvent[] } {
  const events: IngressEvent[] = [];
  const ingress = new BusIngress({
    messaging: bus,
    uns: new Uns(CONSOLE_IDENTITY, false),
    sink: (ev) => events.push(ev),
    newMessage: (name) => MessageBuilder.create(name, "1.0"),
  });
  return { ingress, events };
}

describe("BusIngress - subscriptions", () => {
  it("subscribes exactly the six consumer-class wildcards, built via uns().filter()", async () => {
    const bus = new FakeBus();
    const { ingress } = makeIngress(bus);
    await ingress.start();
    const expected = [
      "ecv1/+/+/+/state",
      "ecv1/+/+/+/cfg",
      "ecv1/+/+/+/evt/#",
      "ecv1/+/+/+/metric/#",
      "ecv1/+/+/+/data/#",
      "ecv1/+/+/+/log/#",
    ];
    expect([...bus.subscriptions.keys()]).toEqual(expected);
    expect(ingress.subscribedFilters()).toEqual(expected);
  });

  it("unsubscribes all six on stop (leave the bus clean) and is idempotent", async () => {
    const bus = new FakeBus();
    const { ingress } = makeIngress(bus);
    await ingress.start();
    await ingress.stop();
    expect(bus.subscriptions.size).toBe(0);
    expect(bus.unsubscribed).toHaveLength(6);
    await ingress.stop(); // second stop: no double-unsubscribe
    expect(bus.unsubscribed).toHaveLength(6);
  });
});

describe("BusIngress - delivery -> normalized events", () => {
  it("routes an envelope to the sink with class + channel resolved", async () => {
    const bus = new FakeBus();
    const { ingress, events } = makeIngress(bus);
    await ingress.start();

    await bus.emitWire(
      "ecv1/gw-01/opcua-adapter/main/data/temp",
      wireEnvelope("reading", makeIdentity("gw-01", "opcua-adapter"), { v: 1 }),
    );
    expect(events).toEqual([
      expect.objectContaining({ kind: "envelope", cls: "data", channel: "temp" }),
    ]);
  });

  it("drops malformed/non-protobuf payloads before they reach the FleetModel", async () => {
    const bus = new FakeBus();
    const { ingress, events } = makeIngress(bus);
    await ingress.start();

    await bus.emitWire("ecv1/gw-07/uns-bridge/main/state", Buffer.from('{"status":"UNREACHABLE"}', "utf8"));
    expect(events).toEqual([]);
  });

  it("ignores an explicitly decoded raw payload from a custom raw seam", async () => {
    const bus = new FakeBus();
    const { ingress, events } = makeIngress(bus);
    await ingress.start();

    await bus.emitMessage("ecv1/gw-07/uns-bridge/main/state", Message.raw({ status: "UNREACHABLE" }));
    expect(events).toEqual([
      {
        kind: "ignored",
        cls: "state",
        topic: "ecv1/gw-07/uns-bridge/main/state",
        reason: "raw-non-lwt",
      },
    ]);
  });

  it("contains sink failures (a throwing sink never breaks the transport handler)", async () => {
    const bus = new FakeBus();
    const ingress = new BusIngress({
      messaging: bus,
      uns: new Uns(CONSOLE_IDENTITY, false),
      sink: () => {
        throw new Error("boom");
      },
      newMessage: (name) => MessageBuilder.create(name, "1.0"),
    });
    await ingress.start();
    await expect(
      bus.emitWire("ecv1/gw-01/x/main/state", wireEnvelope("state", makeIdentity("gw-01", "x"), {})),
    ).resolves.toBeUndefined();
  });
});

describe("BusIngress - per-device republish broadcast (G1 / D-U19)", () => {
  it("publishes republish-state then republish-cfg to the device's _bcast inbox", async () => {
    const bus = new FakeBus();
    const { ingress } = makeIngress(bus);
    await ingress.broadcastRepublish("gw-01");

    expect(bus.published.map((p) => p.topic)).toEqual([
      "ecv1/gw-01/_bcast/main/cmd/republish-state",
      "ecv1/gw-01/_bcast/main/cmd/republish-cfg",
    ]);
    // Fire-and-forget notifications: named after the verb, no reply_to.
    expect(bus.published[0]!.message.header.name).toBe("republish-state");
    expect(bus.published[0]!.message.getReplyTo()).toBeUndefined();
    expect(bus.published[1]!.message.header.name).toBe("republish-cfg");
  });

  it("never throws on a hostile/invalid device token - logs and skips", async () => {
    const bus = new FakeBus();
    const { ingress } = makeIngress(bus);
    await expect(ingress.broadcastRepublish("bad/device")).resolves.toBeUndefined();
    await expect(ingress.broadcastRepublish("")).resolves.toBeUndefined();
    expect(bus.published).toHaveLength(0);
  });
});

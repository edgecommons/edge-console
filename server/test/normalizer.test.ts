import { describe, expect, it } from "vitest";
import { Message } from "@edgecommons/edgecommons";

import { normalize } from "../src/ingress/normalizer";
import { RAW_LWT, makeIdentity, wireEnvelope } from "./_fakes";

/** Rootless grammar: the class token sits at topic level 4. */
const CLASS_INDEX = 4;

function decode(payload: string): Message {
  return Message.fromWire(payload);
}

describe("normalize - envelope path", () => {
  it("decodes a data envelope: identity from the envelope, channel from the topic", () => {
    const ev = normalize(
      "data",
      CLASS_INDEX,
      "ecv1/gw-01/opcua-adapter/main/data/temp",
      decode(wireEnvelope("reading", makeIdentity("gw-01", "opcua-adapter"), { value: 21.5 })),
    );
    expect(ev).toMatchObject({
      kind: "envelope",
      cls: "data",
      channel: "temp",
      identity: {
        hier: [{ level: "device", value: "gw-01" }],
        path: "gw-01",
        component: "opcua-adapter",
        instance: "main",
      },
      body: { value: 21.5 },
      topic: "ecv1/gw-01/opcua-adapter/main/data/temp",
    });
    expect(ev.kind === "envelope" && ev.sourceTimestamp).toBe("2026-07-03T00:00:00.000Z");
  });

  it("joins multi-token channels (evt/{sev}/{type})", () => {
    const ev = normalize(
      "evt",
      CLASS_INDEX,
      "ecv1/gw-01/press-17/main/evt/warn/overtemp",
      decode(wireEnvelope("evt", makeIdentity("gw-01", "press-17"), { msg: "hot" })),
    );
    expect(ev.kind === "envelope" && ev.channel).toBe("warn/overtemp");
  });

  it("leaves the channel absent for the leaf classes", () => {
    const ev = normalize(
      "state",
      CLASS_INDEX,
      "ecv1/gw-01/press-17/main/state",
      decode(wireEnvelope("state", makeIdentity("gw-01", "press-17"), { status: "RUNNING", uptimeSecs: 3 })),
    );
    expect(ev.kind).toBe("envelope");
    expect(ev.kind === "envelope" && ev.channel).toBeUndefined();
  });

  it("keeps a multi-level hierarchy identity intact (path != device)", () => {
    const ev = normalize(
      "state",
      CLASS_INDEX,
      "ecv1/pack-gw-01/modbus-adapter/main/state",
      decode(
        wireEnvelope("state", makeIdentity("pack-gw-01", "modbus-adapter", "main", "dallas"), {
          status: "RUNNING",
          uptimeSecs: 1,
        }),
      ),
    );
    expect(ev.kind === "envelope" && ev.identity.path).toBe("dallas/pack-gw-01");
    expect(ev.kind === "envelope" && ev.identity.hier).toHaveLength(2);
  });

  it("passes tags through verbatim, including the reserved _relay hop tag (G6)", () => {
    const ev = normalize(
      "metric",
      CLASS_INDEX,
      "ecv1/gw-01/uns-bridge/main/metric/relay_dropped_data",
      decode(
        wireEnvelope("metric", makeIdentity("gw-01", "uns-bridge"), { value: 4 }, {
          _relay: ["gw-01/uns-bridge"],
          plant: "dallas",
        }),
      ),
    );
    expect(ev.kind === "envelope" && ev.tags).toEqual({
      _relay: ["gw-01/uns-bridge"],
      plant: "dallas",
    });
  });

  it("drops an envelope without an identity element (missing-identity, G11)", () => {
    const ev = normalize(
      "state",
      CLASS_INDEX,
      "ecv1/gw-01/mystery/main/state",
      decode(wireEnvelope("state", undefined, { status: "RUNNING" })),
    );
    expect(ev).toMatchObject({ kind: "ignored", cls: "state", reason: "missing-identity" });
  });

  it("drops an envelope whose malformed identity the lib parsed away (lenient drop)", () => {
    // The lib's lenient identity parser drops a malformed identity with a WARN and
    // still delivers the envelope — the console must not crash on it.
    const wire = JSON.stringify({
      header: { name: "state", version: "1.0", timestamp: "", correlation_id: "", uuid: "" },
      identity: { bogus: 1 },
      body: { status: "RUNNING" },
    });
    const ev = normalize("state", CLASS_INDEX, "ecv1/gw-01/mystery/main/state", decode(wire));
    expect(ev).toMatchObject({ kind: "ignored", reason: "missing-identity" });
  });
});

describe("normalize - raw-LWT path (the one documented topic-parse exception, G5)", () => {
  it("marks the device UNREACHABLE for the bridge LWT on the state wildcard", () => {
    const ev = normalize("state", CLASS_INDEX, "ecv1/gw-01/uns-bridge/main/state", decode(RAW_LWT));
    expect(ev).toEqual({
      kind: "device-unreachable",
      device: "gw-01",
      topic: "ecv1/gw-01/uns-bridge/main/state",
    });
  });

  it("accepts any bridge instance token ({instance} is not pinned)", () => {
    const ev = normalize("state", CLASS_INDEX, "ecv1/gw-01/uns-bridge/relay/state", decode(RAW_LWT));
    expect(ev.kind).toBe("device-unreachable");
  });

  it("ignores raw state payloads from components other than uns-bridge", () => {
    const ev = normalize("state", CLASS_INDEX, "ecv1/gw-01/rogue/main/state", decode(RAW_LWT));
    expect(ev).toMatchObject({ kind: "ignored", reason: "raw-non-lwt" });
  });

  it("ignores a raw payload whose status is not UNREACHABLE", () => {
    const ev = normalize(
      "state",
      CLASS_INDEX,
      "ecv1/gw-01/uns-bridge/main/state",
      decode('{"status":"RUNNING"}'),
    );
    expect(ev).toMatchObject({ kind: "ignored", reason: "raw-non-lwt" });
  });

  it("ignores raw non-object payloads (unparseable bytes arrive as a raw string)", () => {
    const ev = normalize("state", CLASS_INDEX, "ecv1/gw-01/uns-bridge/main/state", decode("not json"));
    expect(ev).toMatchObject({ kind: "ignored", reason: "raw-non-lwt" });
  });

  it("ignores a topic of the wrong depth", () => {
    const ev = normalize(
      "state",
      CLASS_INDEX,
      "ecv1/gw-01/uns-bridge/main/state/extra",
      decode(RAW_LWT),
    );
    expect(ev).toMatchObject({ kind: "ignored", reason: "raw-non-lwt" });
  });

  it("ignores raw payloads on every non-state class", () => {
    const ev = normalize("data", CLASS_INDEX, "ecv1/gw-01/x/main/data/temp", decode('{"v":1}'));
    expect(ev).toMatchObject({ kind: "ignored", cls: "data", reason: "raw-non-lwt" });
  });
});

import { describe, expect, it } from "vitest";
import { Message, MessageBuilder } from "@edgecommons/edgecommons";

import { normalize } from "../src/ingress/normalizer";
import { makeIdentity, wireEnvelope } from "./_fakes";

/** Rootless grammar: the class token sits at topic level 4. */
const CLASS_INDEX = 4;

function decode(payload: Buffer): Message {
  return Message.fromBytes(payload);
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

  it("drops a decoded envelope whose identity is absent", () => {
    const msg = Message.envelope(
      {
        name: "state",
        version: "1.0",
        timestamp: "",
        timestamp_ms: 0,
        correlation_id: "",
        uuid: "",
      },
      undefined,
      { status: "RUNNING" },
    );
    const ev = normalize("state", CLASS_INDEX, "ecv1/gw-01/mystery/main/state", msg);
    expect(ev).toMatchObject({ kind: "ignored", reason: "missing-identity" });
  });

  it("projects opaque protobuf bodies as diagnostics without exposing payload bytes", () => {
    const msg = MessageBuilder.create("FramePreview", "1.0")
      .withTimestamp("2026-07-03T00:00:00.000Z")
      .withUuid("00000000-0000-0000-0000-000000000000")
      .withIdentity(makeIdentity("gw-01", "camera"))
      .withTags({ capture_mode: "preview", _relay: ["gw-01/uns-bridge"] })
      .withOpaqueBody(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg")
      .build();

    const ev = normalize("data", CLASS_INDEX, "ecv1/gw-01/camera/main/data/frame-preview", Message.fromBytes(msg.toBytes()));

    expect(ev.kind).toBe("envelope");
    if (ev.kind !== "envelope") return;
    expect(ev.tags).toEqual({ capture_mode: "preview", _relay: ["gw-01/uns-bridge"] });
    expect(ev.body).toMatchObject({ content_type: "image/jpeg", length: 4 });
    expect((ev.body as Record<string, unknown>).sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((ev.body as Record<string, unknown>).data).toBeUndefined();
  });

  it("keeps structured byte values as core diagnostic markers, not assumed JSON", () => {
    const msg = MessageBuilder.create("SouthboundSignalUpdate", "1.0")
      .withTimestamp("2026-07-03T00:00:00.000Z")
      .withUuid("00000000-0000-0000-0000-000000000000")
      .withIdentity(makeIdentity("gw-01", "camera"))
      .withSouthboundSignalUpdate({
        signal: { id: "camera-1/thumbnail", name: "thumbnail" },
        samples: [{ value: Buffer.from([0, 1, 2, 254, 255]), quality: "GOOD" }],
      })
      .build();

    const ev = normalize("data", CLASS_INDEX, "ecv1/gw-01/camera/main/data/camera-1/thumbnail", Message.fromBytes(msg.toBytes()));

    expect(ev.kind).toBe("envelope");
    if (ev.kind !== "envelope") return;
    const body = ev.body as { samples: Array<{ value: unknown; quality?: string }> };
    expect(body.samples[0]!.quality).toBe("GOOD");
    expect(body.samples[0]!.value).toEqual({
      _edgecommonsBinary: { encoding: "base64", length: 5, data: "AAEC/v8=" },
    });
  });
});

describe("normalize - raw path", () => {
  it("ignores raw state payloads, including legacy bridge LWT shapes", () => {
    const ev = normalize(
      "state",
      CLASS_INDEX,
      "ecv1/gw-01/uns-bridge/main/state",
      Message.raw({ status: "UNREACHABLE" }),
    );
    expect(ev).toMatchObject({ kind: "ignored", reason: "raw-non-lwt" });
  });

  it("ignores a raw payload whose status is not UNREACHABLE", () => {
    const ev = normalize(
      "state",
      CLASS_INDEX,
      "ecv1/gw-01/uns-bridge/main/state",
      Message.raw({ status: "RUNNING" }),
    );
    expect(ev).toMatchObject({ kind: "ignored", reason: "raw-non-lwt" });
  });

  it("ignores raw non-object payloads (unparseable bytes arrive as a raw string)", () => {
    const ev = normalize("state", CLASS_INDEX, "ecv1/gw-01/uns-bridge/main/state", Message.raw("not json"));
    expect(ev).toMatchObject({ kind: "ignored", reason: "raw-non-lwt" });
  });

  it("ignores a topic of the wrong depth", () => {
    const ev = normalize(
      "state",
      CLASS_INDEX,
      "ecv1/gw-01/uns-bridge/main/state/extra",
      Message.raw({ status: "UNREACHABLE" }),
    );
    expect(ev).toMatchObject({ kind: "ignored", reason: "raw-non-lwt" });
  });

  it("ignores raw payloads on every non-state class", () => {
    const ev = normalize("data", CLASS_INDEX, "ecv1/gw-01/x/main/data/temp", Message.raw({ v: 1 }));
    expect(ev).toMatchObject({ kind: "ignored", cls: "data", reason: "raw-non-lwt" });
  });
});

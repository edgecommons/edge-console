/**
 * Direct tests for the C2 wire contract's validator (`parseClientMessage`), which lives
 * in `@edgecommons/edge-console-protocol` since both the server gateway and the future
 * UI client share it. `ws-gateway.test.ts` covers the gateway's reaction to a rejected
 * frame (error + close); these tests pin the validator's own accept/reject boundary.
 */
import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  classifyEventSeverity,
  extractSignalSample,
  isAlarmingSeverity,
  parseClientMessage,
  parseComponentKey,
  splitEventChannel,
} from "@edgecommons/edge-console-protocol";

describe("parseClientMessage", () => {
  it("accepts a bare hello (no resumeSeq)", () => {
    const result = parseClientMessage(JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION }));
    expect(result).toEqual({ ok: true, message: { type: "hello", protocolVersion: PROTOCOL_VERSION } });
  });

  it("accepts a hello with a valid resumeSeq", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, resumeSeq: 42 }),
    );
    expect(result).toEqual({
      ok: true,
      message: { type: "hello", protocolVersion: PROTOCOL_VERSION, resumeSeq: 42 },
    });
  });

  it("accepts resumeSeq: 0", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, resumeSeq: 0 }),
    );
    expect(result.ok).toBe(true);
  });

  it("ignores unknown extra fields rather than rejecting them", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, somethingElse: "x" }),
    );
    expect(result).toEqual({ ok: true, message: { type: "hello", protocolVersion: PROTOCOL_VERSION } });
  });

  it.each([
    ["not json at all", "{{{"],
    ["a JSON array", "[1,2,3]"],
    ["a JSON primitive", "42"],
    ["null", "null"],
    ["missing type", JSON.stringify({ protocolVersion: PROTOCOL_VERSION })],
    ["wrong type value", JSON.stringify({ type: "goodbye", protocolVersion: PROTOCOL_VERSION })],
    ["missing protocolVersion", JSON.stringify({ type: "hello" })],
    ["string protocolVersion", JSON.stringify({ type: "hello", protocolVersion: "1" })],
    ["fractional protocolVersion", JSON.stringify({ type: "hello", protocolVersion: 1.2 })],
    [
      "negative resumeSeq",
      JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, resumeSeq: -1 }),
    ],
    [
      "fractional resumeSeq",
      JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, resumeSeq: 1.5 }),
    ],
    [
      "string resumeSeq",
      JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION, resumeSeq: "1" }),
    ],
  ])("rejects: %s", (_label, raw) => {
    const result = parseClientMessage(raw);
    expect(result.ok).toBe(false);
  });
});

describe("parseClientMessage - the C5 config family", () => {
  const KEY = { device: "gw-01", component: "modbus-adapter", instance: "main" };

  it("accepts get-config with a full component key (extras stripped)", () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: "get-config",
        protocolVersion: PROTOCOL_VERSION,
        key: { ...KEY, extra: "ignored" },
        somethingElse: true,
      }),
    );
    expect(result).toEqual({
      ok: true,
      message: { type: "get-config", protocolVersion: PROTOCOL_VERSION, key: KEY },
    });
  });

  it("accepts refresh-config with a non-empty device", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "refresh-config", protocolVersion: PROTOCOL_VERSION, device: "gw-01" }),
    );
    expect(result).toEqual({
      ok: true,
      message: { type: "refresh-config", protocolVersion: PROTOCOL_VERSION, device: "gw-01" },
    });
  });

  it.each([
    ["missing key", JSON.stringify({ type: "get-config", protocolVersion: PROTOCOL_VERSION })],
    ["array key", JSON.stringify({ type: "get-config", protocolVersion: PROTOCOL_VERSION, key: [1] })],
    [
      "partial key",
      JSON.stringify({ type: "get-config", protocolVersion: PROTOCOL_VERSION, key: { device: "gw-01" } }),
    ],
    [
      "empty-string key field",
      JSON.stringify({
        type: "get-config",
        protocolVersion: PROTOCOL_VERSION,
        key: { device: "gw-01", component: "", instance: "main" },
      }),
    ],
    [
      "non-string key field",
      JSON.stringify({
        type: "get-config",
        protocolVersion: PROTOCOL_VERSION,
        key: { device: "gw-01", component: 3, instance: "main" },
      }),
    ],
    ["missing device", JSON.stringify({ type: "refresh-config", protocolVersion: PROTOCOL_VERSION })],
    [
      "empty device",
      JSON.stringify({ type: "refresh-config", protocolVersion: PROTOCOL_VERSION, device: "" }),
    ],
    [
      "get-config without protocolVersion",
      JSON.stringify({ type: "get-config", key: KEY }),
    ],
  ])("rejects: %s", (_label, raw) => {
    expect(parseClientMessage(raw).ok).toBe(false);
  });
});

describe("parseClientMessage - the C6 activity family", () => {
  it("accepts subscribe-events bare and with a positive limit (extras ignored)", () => {
    expect(
      parseClientMessage(JSON.stringify({ type: "subscribe-events", protocolVersion: PROTOCOL_VERSION })),
    ).toEqual({
      ok: true,
      message: { type: "subscribe-events", protocolVersion: PROTOCOL_VERSION },
    });
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "subscribe-events",
          protocolVersion: PROTOCOL_VERSION,
          limit: 50,
          extra: true,
        }),
      ),
    ).toEqual({
      ok: true,
      message: { type: "subscribe-events", protocolVersion: PROTOCOL_VERSION, limit: 50 },
    });
  });

  it.each(["unsubscribe-events", "subscribe-metrics", "unsubscribe-metrics"] as const)(
    "accepts the bare %s frame",
    (type) => {
      expect(parseClientMessage(JSON.stringify({ type, protocolVersion: PROTOCOL_VERSION }))).toEqual({
        ok: true,
        message: { type, protocolVersion: PROTOCOL_VERSION },
      });
    },
  );

  it.each([
    ["zero limit", JSON.stringify({ type: "subscribe-events", protocolVersion: PROTOCOL_VERSION, limit: 0 })],
    [
      "negative limit",
      JSON.stringify({ type: "subscribe-events", protocolVersion: PROTOCOL_VERSION, limit: -1 }),
    ],
    [
      "fractional limit",
      JSON.stringify({ type: "subscribe-events", protocolVersion: PROTOCOL_VERSION, limit: 1.5 }),
    ],
    [
      "string limit",
      JSON.stringify({ type: "subscribe-events", protocolVersion: PROTOCOL_VERSION, limit: "10" }),
    ],
    ["subscribe-metrics without protocolVersion", JSON.stringify({ type: "subscribe-metrics" })],
  ])("rejects: %s", (_label, raw) => {
    expect(parseClientMessage(raw).ok).toBe(false);
  });
});

describe("parseClientMessage - the C4 command family", () => {
  const KEY = { device: "gw-01", component: "opcua-adapter", instance: "main" };

  it("accepts invoke-command without args (key extras stripped)", () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: "invoke-command",
        protocolVersion: PROTOCOL_VERSION,
        requestId: "r1",
        key: { ...KEY, extra: 1 },
        verb: "ping",
        junk: true,
      }),
    );
    expect(result).toEqual({
      ok: true,
      message: {
        type: "invoke-command",
        protocolVersion: PROTOCOL_VERSION,
        requestId: "r1",
        key: KEY,
        verb: "ping",
      },
    });
  });

  it("accepts invoke-command with an args object", () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: "invoke-command",
        protocolVersion: PROTOCOL_VERSION,
        requestId: "r2",
        key: KEY,
        verb: "set-log-level",
        args: { level: "DEBUG" },
      }),
    );
    expect(result).toEqual({
      ok: true,
      message: {
        type: "invoke-command",
        protocolVersion: PROTOCOL_VERSION,
        requestId: "r2",
        key: KEY,
        verb: "set-log-level",
        args: { level: "DEBUG" },
      },
    });
  });

  it.each([
    ["missing requestId", { type: "invoke-command", protocolVersion: PROTOCOL_VERSION, key: KEY, verb: "ping" }],
    ["empty requestId", { type: "invoke-command", protocolVersion: PROTOCOL_VERSION, requestId: "", key: KEY, verb: "ping" }],
    ["missing key", { type: "invoke-command", protocolVersion: PROTOCOL_VERSION, requestId: "r", verb: "ping" }],
    ["partial key", { type: "invoke-command", protocolVersion: PROTOCOL_VERSION, requestId: "r", key: { device: "gw-01" }, verb: "ping" }],
    ["missing verb", { type: "invoke-command", protocolVersion: PROTOCOL_VERSION, requestId: "r", key: KEY }],
    ["empty verb", { type: "invoke-command", protocolVersion: PROTOCOL_VERSION, requestId: "r", key: KEY, verb: "" }],
    ["array args", { type: "invoke-command", protocolVersion: PROTOCOL_VERSION, requestId: "r", key: KEY, verb: "ping", args: [1] }],
    ["primitive args", { type: "invoke-command", protocolVersion: PROTOCOL_VERSION, requestId: "r", key: KEY, verb: "ping", args: 3 }],
  ])("rejects: %s", (_label, frame) => {
    expect(parseClientMessage(JSON.stringify(frame)).ok).toBe(false);
  });
});

describe("parseClientMessage - the R0 signal/attribute/alarm families", () => {
  it.each([
    "subscribe-signals",
    "unsubscribe-signals",
    "subscribe-attributes",
    "unsubscribe-attributes",
    "subscribe-alarms",
    "unsubscribe-alarms",
  ] as const)("accepts the bare %s frame", (type) => {
    expect(parseClientMessage(JSON.stringify({ type, protocolVersion: PROTOCOL_VERSION }))).toEqual({
      ok: true,
      message: { type, protocolVersion: PROTOCOL_VERSION },
    });
  });

  it("accepts ack-alarm with a non-empty alarmId (extras stripped)", () => {
    expect(
      parseClientMessage(
        JSON.stringify({
          type: "ack-alarm",
          protocolVersion: PROTOCOL_VERSION,
          alarmId: "gw-01/opcua-adapter/main::connection-lost",
          extra: 1,
        }),
      ),
    ).toEqual({
      ok: true,
      message: {
        type: "ack-alarm",
        protocolVersion: PROTOCOL_VERSION,
        alarmId: "gw-01/opcua-adapter/main::connection-lost",
      },
    });
  });

  it.each([
    ["missing alarmId", JSON.stringify({ type: "ack-alarm", protocolVersion: PROTOCOL_VERSION })],
    ["empty alarmId", JSON.stringify({ type: "ack-alarm", protocolVersion: PROTOCOL_VERSION, alarmId: "" })],
    ["non-string alarmId", JSON.stringify({ type: "ack-alarm", protocolVersion: PROTOCOL_VERSION, alarmId: 3 })],
    ["subscribe-signals without protocolVersion", JSON.stringify({ type: "subscribe-signals" })],
  ])("rejects: %s", (_label, raw) => {
    expect(parseClientMessage(raw).ok).toBe(false);
  });
});

describe("isAlarmingSeverity", () => {
  it("critical/error/warning raise; info/debug/undefined clear", () => {
    expect(isAlarmingSeverity("critical")).toBe(true);
    expect(isAlarmingSeverity("error")).toBe(true);
    expect(isAlarmingSeverity("warning")).toBe(true);
    expect(isAlarmingSeverity("info")).toBe(false);
    expect(isAlarmingSeverity("debug")).toBe(false);
    expect(isAlarmingSeverity(undefined)).toBe(false);
  });
});

describe("extractSignalSample", () => {
  it("handles {value,quality}, value-less objects, and bare scalars", () => {
    expect(extractSignalSample({ value: 7, quality: "GOOD" })).toEqual({ value: 7, quality: "GOOD" });
    expect(extractSignalSample({ a: 1 })).toEqual({ value: { a: 1 } });
    expect(extractSignalSample(true)).toEqual({ value: true });
    expect(extractSignalSample(null)).toEqual({ value: null });
  });
});

describe("splitEventChannel / classifyEventSeverity - the evt/{severity}/{type} split", () => {
  it.each([
    ["critical/overtemp", { severity: "critical", type: "overtemp" }],
    ["warning/slave/retry", { severity: "warning", type: "slave/retry" }], // multi-token type
    ["machine1/started", { severity: "machine1", type: "started" }], // unknown severity, verbatim
    ["overtemp", { type: "overtemp" }], // bare type (not a severity token)
    ["critical", { severity: "critical", type: "(unnamed)" }], // bare KNOWN severity
    [undefined, { type: "(unnamed)" }],
    ["", { type: "(unnamed)" }],
  ])("splits %j", (channel, expected) => {
    expect(splitEventChannel(channel as string | undefined)).toEqual(expected);
  });

  it("classifies synonym tokens case-insensitively and unknowns as undefined", () => {
    expect(classifyEventSeverity("CRIT")).toBe("critical");
    expect(classifyEventSeverity("fatal")).toBe("critical");
    expect(classifyEventSeverity("err")).toBe("error");
    expect(classifyEventSeverity("Warn")).toBe("warning");
    expect(classifyEventSeverity("notice")).toBe("info");
    expect(classifyEventSeverity("trace")).toBe("debug");
    expect(classifyEventSeverity("machine1")).toBeUndefined();
    expect(classifyEventSeverity(undefined)).toBeUndefined();
  });
});

describe("parseComponentKey", () => {
  it("returns a fresh extras-stripped copy for a valid key", () => {
    const input = { device: "d", component: "c", instance: "i", extra: 1 };
    const key = parseComponentKey(input);
    expect(key).toEqual({ device: "d", component: "c", instance: "i" });
    expect(key).not.toBe(input); // never the caller's object
  });

  it.each([
    ["null", null],
    ["a string", "gw-01/comp/main"],
    ["an array", ["d", "c", "i"]],
    ["empty instance", { device: "d", component: "c", instance: "" }],
    ["missing component", { device: "d", instance: "i" }],
  ])("returns undefined for %s", (_label, value) => {
    expect(parseComponentKey(value)).toBeUndefined();
  });
});

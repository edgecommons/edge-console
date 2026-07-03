/**
 * Direct tests for the C2 wire contract's validator (`parseClientMessage`), which lives
 * in `@edgecommons/edge-console-protocol` since both the server gateway and the future
 * UI client share it. `ws-gateway.test.ts` covers the gateway's reaction to a rejected
 * frame (error + close); these tests pin the validator's own accept/reject boundary.
 */
import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  parseClientMessage,
  parseComponentKey,
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

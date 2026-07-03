/**
 * Direct tests for the C2 wire contract's validator (`parseClientMessage`), which lives
 * in `@edgecommons/edge-console-protocol` since both the server gateway and the future
 * UI client share it. `ws-gateway.test.ts` covers the gateway's reaction to a rejected
 * frame (error + close); these tests pin the validator's own accept/reject boundary.
 */
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, parseClientMessage } from "@edgecommons/edge-console-protocol";

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

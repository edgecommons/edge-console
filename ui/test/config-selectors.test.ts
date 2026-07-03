import { describe, expect, it } from "vitest";
import {
  classifyValue,
  effectiveConfig,
  flattenConfig,
  jsonTokens,
  redactionCounts,
} from "../src/configreview/selectors";

describe("effectiveConfig", () => {
  it("unwraps the shipped publisher shape {config: {...}}", () => {
    expect(effectiveConfig({ config: { a: 1 } })).toEqual({ a: 1 });
  });
  it("shows anything else as-is rather than hiding it (defensive)", () => {
    expect(effectiveConfig({ notConfig: 1 })).toEqual({ notConfig: 1 });
    expect(effectiveConfig("bare")).toBe("bare");
    expect(effectiveConfig(null)).toBeNull();
    expect(effectiveConfig([1, 2])).toEqual([1, 2]);
  });
});

describe("classifyValue - the redaction contract", () => {
  it("the library sentinel '***' is redacted", () => {
    expect(classifyValue("***")).toBe("redacted");
  });
  it("$secret references are vault pointers, not values", () => {
    expect(classifyValue("$secret:api-key")).toBe("secret-ref");
  });
  it("everything else is an ordinary value (even asterisk-ish strings)", () => {
    expect(classifyValue("**")).toBe("value");
    expect(classifyValue("****")).toBe("value");
    expect(classifyValue(42)).toBe("value");
    expect(classifyValue(null)).toBe("value");
  });
});

describe("flattenConfig", () => {
  it("emits dotted-path rows depth-first in document order", () => {
    const rows = flattenConfig({
      heartbeat: { intervalSecs: 5 },
      logging: { level: "INFO" },
      enabled: true,
      threshold: null,
    });
    expect(rows).toEqual([
      { path: "heartbeat.intervalSecs", display: "5", kind: "value" },
      { path: "logging.level", display: "INFO", kind: "value" },
      { path: "enabled", display: "true", kind: "value" },
      { path: "threshold", display: "null", kind: "value" },
    ]);
  });

  it("indexes arrays and renders empty containers as single rows", () => {
    const rows = flattenConfig({
      signals: ["Temp_01", { id: "Pressure", deadband: 0.5 }],
      tags: [],
      extra: {},
    });
    expect(rows).toEqual([
      { path: "signals[0]", display: "Temp_01", kind: "value" },
      { path: "signals[1].id", display: "Pressure", kind: "value" },
      { path: "signals[1].deadband", display: "0.5", kind: "value" },
      { path: "tags", display: "[]", kind: "value" },
      { path: "extra", display: "{}", kind: "value" },
    ]);
  });

  it("classifies redacted and secret-ref leaves", () => {
    const rows = flattenConfig({
      credentials: { username: "svc", password: "***" },
      apiKey: "$secret:northbound",
    });
    expect(rows).toEqual([
      { path: "credentials.username", display: "svc", kind: "value" },
      { path: "credentials.password", display: "***", kind: "redacted" },
      { path: "apiKey", display: "$secret:northbound", kind: "secret-ref" },
    ]);
    expect(redactionCounts(rows)).toEqual({ redacted: 1, secretRefs: 1 });
  });

  it("a bare scalar config gets the '(value)' row; an empty root none", () => {
    expect(flattenConfig("just-a-string")).toEqual([
      { path: "(value)", display: "just-a-string", kind: "value" },
    ]);
    expect(flattenConfig({})).toEqual([]);
    expect(flattenConfig([])).toEqual([]);
  });
});

describe("jsonTokens", () => {
  const sample = {
    heartbeat: { intervalSecs: 5 },
    credentials: { password: "***" },
    apiKey: "$secret:x",
    targets: ["a", 2, true, null],
    empty: {},
    none: [],
  };

  it("joining the tokens yields the exact pretty-printed JSON", () => {
    const joined = jsonTokens(sample)
      .map((t) => t.text)
      .join("");
    expect(joined).toBe(JSON.stringify(sample, null, 2));
    expect(JSON.parse(joined)).toEqual(sample); // valid JSON, verbatim values
  });

  it("classifies keys/strings/numbers/literals and flags redaction sentinels", () => {
    const tokens = jsonTokens(sample);
    const kindOf = (text: string) => tokens.find((t) => t.text === text)?.kind;
    expect(kindOf('"heartbeat"')).toBe("key");
    expect(kindOf("5")).toBe("number");
    expect(kindOf('"a"')).toBe("string");
    expect(kindOf("true")).toBe("literal");
    expect(kindOf("null")).toBe("literal");
    expect(kindOf('"***"')).toBe("redacted"); // styled as redacted, shown verbatim
    expect(kindOf('"$secret:x"')).toBe("secret-ref");
    expect(kindOf("{}")).toBe("punct");
    expect(kindOf("[]")).toBe("punct");
  });

  it("handles scalar roots", () => {
    expect(jsonTokens(7)).toEqual([{ text: "7", kind: "number" }]);
    expect(jsonTokens("***")).toEqual([{ text: '"***"', kind: "redacted" }]);
  });
});

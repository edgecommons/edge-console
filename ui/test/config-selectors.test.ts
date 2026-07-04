import { describe, expect, it } from "vitest";
import {
  buildConfigTree,
  classifyValue,
  configHash,
  defaultExpandedPaths,
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

describe("buildConfigTree - the genuinely hierarchical tree", () => {
  it("builds NESTED container nodes down to classified leaves (not a flat dotted list)", () => {
    const tree = buildConfigTree({
      heartbeat: { intervalSecs: 5 },
      messaging: { local: { host: "emqx.local", credentials: { password: "***" } } },
      apiKey: "$secret:x",
    });
    // Top level: a heartbeat OBJECT node, a messaging OBJECT node, an apiKey LEAF.
    expect(tree.map((n) => ({ label: n.label, path: n.path, kind: n.kind }))).toEqual([
      { label: "heartbeat", path: "heartbeat", kind: "object" },
      { label: "messaging", path: "messaging", kind: "object" },
      { label: "apiKey", path: "apiKey", kind: "leaf" },
    ]);
    // The heartbeat container nests its own leaf, keyed by the child key alone.
    const heartbeat = tree[0]!;
    expect(heartbeat.summary).toBe("1 key");
    expect(heartbeat.children).toEqual([
      { label: "intervalSecs", path: "heartbeat.intervalSecs", kind: "leaf", display: "5", valueKind: "value" },
    ]);
    // The redaction reaches the DEEP leaf, path-addressed, classified redacted.
    // messaging → local → credentials → password (four nested levels).
    const password = tree[1]!.children![0]!.children![1]!.children![0]!;
    expect(password).toEqual({
      label: "password",
      path: "messaging.local.credentials.password",
      kind: "leaf",
      display: "***",
      valueKind: "redacted",
    });
    // The secret-ref leaf is a labeled pointer.
    expect(tree[2]).toEqual({
      label: "apiKey",
      path: "apiKey",
      kind: "leaf",
      display: "$secret:x",
      valueKind: "secret-ref",
    });
  });

  it("models arrays as indexed container nodes (component.instances[] as structured entries)", () => {
    const tree = buildConfigTree({
      instances: [{ id: "main" }, { id: "backup" }],
      tags: [],
      note: {},
    });
    const instances = tree[0]!;
    expect(instances.kind).toBe("array");
    expect(instances.summary).toBe("2 items");
    expect(instances.children!.map((c) => c.label)).toEqual(["[0]", "[1]"]);
    expect(instances.children![0]!.path).toBe("instances[0]");
    expect(instances.children![0]!.children![0]).toEqual({
      label: "id",
      path: "instances[0].id",
      kind: "leaf",
      display: "main",
      valueKind: "value",
    });
    // Empty containers are single leaf rows ([] / {}).
    expect(tree[1]).toMatchObject({ label: "tags", kind: "leaf", display: "[]" });
    expect(tree[2]).toMatchObject({ label: "note", kind: "leaf", display: "{}" });
  });

  it("a scalar root is a single (value) leaf; an empty root has no nodes", () => {
    expect(buildConfigTree("bare")).toEqual([
      { label: "(value)", path: "(value)", kind: "leaf", display: "bare", valueKind: "value" },
    ]);
    expect(buildConfigTree({})).toEqual([]);
    expect(buildConfigTree([])).toEqual([]);
  });
});

describe("defaultExpandedPaths", () => {
  it("expands nested OBJECTS to the depth cap but leaves ARRAYS folded", () => {
    const tree = buildConfigTree({
      messaging: { local: { host: "h", credentials: { password: "***" } } },
      instances: [{ id: "main" }],
    });
    const expanded = defaultExpandedPaths(tree, 2);
    // Depth 0 + 1 objects open; the depth-2 `credentials` object stays folded.
    expect(expanded.has("messaging")).toBe(true);
    expect(expanded.has("messaging.local")).toBe(true);
    expect(expanded.has("messaging.local.credentials")).toBe(false);
    // Arrays are never auto-expanded (the mockup's collapsed instances[]).
    expect(expanded.has("instances")).toBe(false);
  });
});

describe("configHash - console-computed content fingerprint", () => {
  it("is stable per content and independent of key order", () => {
    const a = configHash({ x: 1, y: { z: 2 } });
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(configHash({ y: { z: 2 }, x: 1 })).toBe(a); // key order doesn't change it
  });
  it("changes when any value changes", () => {
    expect(configHash({ x: 1 })).not.toBe(configHash({ x: 2 }));
    expect(configHash({ x: "***" })).not.toBe(configHash({ x: "value" }));
  });
});

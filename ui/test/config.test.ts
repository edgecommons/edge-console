import { describe, expect, it } from "vitest";
import { defaultWsUrl, resolveWsUrl } from "../src/config";

describe("resolveWsUrl", () => {
  it("derives ws:// from an http page origin", () => {
    expect(resolveWsUrl({ protocol: "http:", host: "gw-01:8443" })).toBe("ws://gw-01:8443/ws");
  });

  it("derives wss:// from an https page origin", () => {
    expect(resolveWsUrl({ protocol: "https:", host: "console.site.example" })).toBe(
      "wss://console.site.example/ws",
    );
  });

  it("honors the env override verbatim (trimmed)", () => {
    expect(resolveWsUrl({ protocol: "https:", host: "x" }, " ws://lab:9000/ws ")).toBe(
      "ws://lab:9000/ws",
    );
  });

  it("ignores an empty override", () => {
    expect(resolveWsUrl({ protocol: "http:", host: "localhost:5173" }, "")).toBe(
      "ws://localhost:5173/ws",
    );
  });

  it("defaultWsUrl derives from the real page location (jsdom origin)", () => {
    expect(defaultWsUrl()).toBe(`ws://${window.location.host}/ws`);
  });
});

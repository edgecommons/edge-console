import { describe, expect, it } from "vitest";
import { formatMs, siteMap, stalenessSummary } from "../src/settings/selectors";
import { compView, deviceView, fleetView, hier, key } from "./_fixtures";

describe("formatMs", () => {
  it("renders whole and fractional seconds at >= 1 s, bare ms below", () => {
    expect(formatMs(30000)).toBe("30 s");
    expect(formatMs(60000)).toBe("60 s");
    expect(formatMs(10000)).toBe("10 s");
    expect(formatMs(1000)).toBe("1 s");
    expect(formatMs(2500)).toBe("2.5 s");
    expect(formatMs(500)).toBe("500 ms");
    expect(formatMs(0)).toBe("0 ms");
  });
});

describe("stalenessSummary", () => {
  it("renders the mockup's ladder string", () => {
    expect(
      stalenessSummary({
        warnMultiplier: 2,
        staleMultiplier: 2.5,
        offlineMultiplier: 5,
        defaultIntervalSecs: 5,
        sweepIntervalMs: 1000,
      }),
    ).toBe("2× warn / 2.5× stale / 5× offline");
  });
});

describe("siteMap", () => {
  it("derives device → line from a [site, line, device] identity hierarchy", () => {
    const fleet = fleetView([
      deviceView("press-gw-01", [
        compView({
          key: key("press-gw-01", "opcua-adapter"),
          hier: hier(["site", "dallas"], ["line", "stamping"], ["device", "press-gw-01"]),
        }),
        compView({
          key: key("press-gw-01", "modbus-adapter"),
          hier: hier(["site", "dallas"], ["line", "stamping"], ["device", "press-gw-01"]),
        }),
      ]),
      deviceView("asm-gw-01", [
        compView({
          key: key("asm-gw-01", "telemetry-processor"),
          hier: hier(["site", "dallas"], ["line", "assembly"], ["device", "asm-gw-01"]),
        }),
      ]),
    ]);

    const map = siteMap(fleet);
    expect(map.levelNames).toEqual(["site", "line", "device"]);
    expect(map.groupingLevel).toBe("line");
    expect(map.site).toBe("dallas");
    // Sorted by device.
    expect(map.entries.map((e) => e.device)).toEqual(["asm-gw-01", "press-gw-01"]);
    expect(map.entries[0]).toEqual({
      device: "asm-gw-01",
      path: [{ level: "line", value: "assembly" }],
      componentCount: 1,
    });
    expect(map.entries[1]!.path).toEqual([{ level: "line", value: "stamping" }]);
    expect(map.entries[1]!.componentCount).toBe(2);
  });

  it("flags a flat [site, device] hierarchy (no intermediate tier ⇒ empty paths)", () => {
    const fleet = fleetView([
      deviceView("gw-01", [
        compView({ key: key("gw-01", "opcua-adapter"), hier: hier(["site", "dallas"], ["device", "gw-01"]) }),
      ]),
    ]);
    const map = siteMap(fleet);
    expect(map.levelNames).toEqual(["site", "device"]);
    expect(map.groupingLevel).toBeUndefined();
    expect(map.entries[0]!.path).toEqual([]);
  });

  it("handles an empty fleet honestly (no entries, no levels)", () => {
    const map = siteMap(fleetView([]));
    expect(map.entries).toEqual([]);
    expect(map.levelNames).toEqual([]);
    expect(map.site).toBeUndefined();
  });
});

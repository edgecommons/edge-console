import { describe, expect, it } from "vitest";
import {
  deviceRollup,
  displayUptimeSecs,
  fleetIssues,
  formatDurationMs,
  formatDurationSecs,
  hierPrefix,
  summarize,
} from "../src/fleet/selectors";
import { donutShares } from "../src/health/SummaryTiles";
import { T0, compView, deviceView, fleetView, key } from "./_fixtures";

describe("summarize", () => {
  it("counts components by liveness and devices by reachability", () => {
    const view = fleetView([
      deviceView("gw-01", [
        compView(),
        compView({ key: key("gw-01", "b"), liveness: "WARN" }),
        compView({ key: key("gw-01", "c"), liveness: "STALE" }),
        compView({ key: key("gw-01", "d"), liveness: "OFFLINE" }),
        compView({ key: key("gw-01", "e"), liveness: "STOPPED" }),
      ]),
      deviceView("gw-02", [compView({ key: key("gw-02"), liveness: "UNREACHABLE" })], {
        unreachable: true,
      }),
    ]);
    const counts = summarize(view);
    expect(counts.total).toBe(6);
    expect(counts.healthy).toBe(1);
    expect(counts.attention).toBe(4); // WARN + STALE + OFFLINE + UNREACHABLE
    expect(counts.byLiveness.STOPPED).toBe(1);
    expect(counts.devices).toBe(2);
    expect(counts.unreachableDevices).toBe(1);
  });

  it("handles the empty fleet", () => {
    const counts = summarize(fleetView([]));
    expect(counts.total).toBe(0);
    expect(counts.devices).toBe(0);
    expect(counts.attention).toBe(0);
  });
});

describe("deviceRollup", () => {
  it("rolls worst-of: unreachable > offline > warn/stale > stopped > healthy", () => {
    expect(deviceRollup(deviceView("d", [compView()], { unreachable: true }))).toBe("unreachable");
    expect(
      deviceRollup(deviceView("d", [compView(), compView({ liveness: "OFFLINE" })])),
    ).toBe("critical");
    expect(deviceRollup(deviceView("d", [compView(), compView({ liveness: "WARN" })]))).toBe(
      "degraded",
    );
    expect(deviceRollup(deviceView("d", [compView(), compView({ liveness: "STALE" })]))).toBe(
      "degraded",
    );
    expect(
      deviceRollup(deviceView("d", [compView({ liveness: "STOPPED" })])),
    ).toBe("stopped");
    expect(
      deviceRollup(deviceView("d", [compView(), compView({ liveness: "STOPPED" })])),
    ).toBe("healthy");
    expect(deviceRollup(deviceView("d", []))).toBe("empty");
  });
});

describe("fleetIssues", () => {
  it("emits one containment note per unreachable device, suppressing its component issues", () => {
    const view = fleetView([
      deviceView(
        "gw-02",
        [
          compView({ key: key("gw-02", "a"), liveness: "UNREACHABLE" }),
          compView({ key: key("gw-02", "b"), liveness: "UNREACHABLE" }),
        ],
        { unreachable: true, unreachableSince: T0 - 120_000 },
      ),
    ]);
    const issues = fleetIssues(view, T0);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.severity).toBe("warning");
    expect(issues[0]!.title).toContain("gw-02 — device unreachable for 2m 00s");
    expect(issues[0]!.subtitle).toContain("2 components frozen");
  });

  it("reports OFFLINE as critical (first) and STALE as warning, with age + cadence", () => {
    const view = fleetView([
      deviceView("gw-01", [
        compView({ key: key("gw-01", "stale-c"), liveness: "STALE", lastStateAt: T0 - 43_000 }),
        compView({ key: key("gw-01", "dead-c"), liveness: "OFFLINE", lastStateAt: T0 - 300_000 }),
        compView({ key: key("gw-01", "quiet"), liveness: "OFFLINE", lastStateAt: undefined }),
        compView({ key: key("gw-01", "ok") }),
        compView({ key: key("gw-01", "warned"), liveness: "WARN" }), // shading, not an alarm
      ]),
    ]);
    const issues = fleetIssues(view, T0);
    expect(issues.map((i) => i.severity)).toEqual(["critical", "critical", "warning"]);
    expect(issues[0]!.title).toBe("dead-c — offline");
    expect(issues[0]!.subtitle).toBe("gw-01 · last seen 5m 00s ago, expected ~5s");
    expect(issues[1]!.subtitle).toContain("no state received yet");
    expect(issues[2]!.title).toBe("stale-c — state keepalive stale");
    expect(issues[2]!.subtitle).toContain("last seen 43s ago");
  });
});

describe("displayUptimeSecs", () => {
  it("extrapolates while provably alive (RUNNING + FRESH/WARN)", () => {
    const comp = compView({ uptimeSecs: 100, uptimeAnchorAt: T0 });
    expect(displayUptimeSecs(comp, T0 + 30_000)).toBe(130);
    expect(displayUptimeSecs(compView({ liveness: "WARN" }), T0 + 30_000)).toBe(130);
  });

  it("freezes at the last report for STALE/OFFLINE/STOPPED/UNREACHABLE", () => {
    for (const liveness of ["STALE", "OFFLINE", "UNREACHABLE"] as const) {
      expect(displayUptimeSecs(compView({ liveness }), T0 + 30_000)).toBe(100);
    }
    expect(
      displayUptimeSecs(compView({ liveness: "STOPPED", status: "STOPPED" }), T0 + 30_000),
    ).toBe(100);
  });

  it("returns undefined when no uptime was ever reported", () => {
    expect(displayUptimeSecs(compView({ uptimeSecs: undefined }), T0)).toBeUndefined();
  });

  it("never extrapolates backwards on clock jitter", () => {
    expect(displayUptimeSecs(compView(), T0 - 5000)).toBe(100);
  });
});

describe("hierPrefix", () => {
  it("joins the hierarchy levels above the device", () => {
    expect(hierPrefix(deviceView("gw-01", [compView()]))).toBe("dallas");
  });

  it("falls back to the path when a delta-discovered component has no hier", () => {
    const comp = compView({ hier: [], path: "dallas/packaging/gw-01" });
    expect(hierPrefix(deviceView("gw-01", [comp]))).toBe("dallas / packaging");
  });

  it("returns empty for single-level paths or empty devices", () => {
    expect(hierPrefix(deviceView("gw-01", [compView({ hier: [], path: "gw-01" })]))).toBe("");
    expect(hierPrefix(deviceView("gw-01", []))).toBe("");
  });
});

describe("duration formatting", () => {
  it("renders the mockup-style compact durations", () => {
    expect(formatDurationMs(0)).toBe("0s");
    expect(formatDurationMs(43_000)).toBe("43s");
    expect(formatDurationMs(72_000)).toBe("1m 12s");
    expect(formatDurationMs(3 * 3_600_000 + 4 * 60_000)).toBe("3h 04m");
    expect(formatDurationMs((6 * 24 + 4) * 3_600_000)).toBe("6d 04h");
    expect(formatDurationMs(-500)).toBe("0s"); // clamped
  });

  it("formats uptime from seconds", () => {
    expect(formatDurationSecs(100)).toBe("1m 40s");
  });
});

describe("donutShares", () => {
  it("splits the donut into ok / warn+stale / offline / idle shares", () => {
    const view = fleetView([
      deviceView("gw-01", [
        compView(),
        compView({ liveness: "FRESH" }),
        compView({ liveness: "WARN" }),
        compView({ liveness: "STALE" }),
        compView({ liveness: "OFFLINE" }),
        compView({ liveness: "STOPPED" }),
        compView({ liveness: "UNREACHABLE" }),
        compView({ liveness: "UNREACHABLE" }),
      ]),
    ]);
    expect(donutShares(summarize(view))).toEqual([25, 25, 12.5, 37.5]);
  });

  it("is all-zero for an empty fleet (no division by zero)", () => {
    expect(donutShares(summarize(fleetView([])))).toEqual([0, 0, 0, 0]);
  });
});

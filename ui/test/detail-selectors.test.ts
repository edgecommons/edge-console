import { describe, expect, it } from "vitest";
import {
  alarmsForComponent,
  componentDetailPath,
  componentFullPath,
  detailSubtitleParts,
  detailUptimeSecs,
  healthChecks,
} from "../src/components/detail-selectors";
import { compView, consoleAlarm, deviceView, fleetView, hier, key, runtimeAttrs, T0 } from "./_fixtures";

describe("breadcrumb paths", () => {
  const comp = compView({
    key: key("pack-gw-01", "opcua-adapter"),
    hier: hier(["site", "dallas"], ["line", "packaging"], ["device", "pack-gw-01"]),
  });

  it("componentFullPath = every hier value (the Components-screen crumb)", () => {
    expect(componentFullPath(comp)).toEqual(["dallas", "packaging", "pack-gw-01"]);
  });

  it("componentDetailPath = everything below the site (the Detail crumb middle)", () => {
    expect(componentDetailPath(comp)).toEqual(["packaging", "pack-gw-01"]);
  });

  it("falls back to the bare device with no hierarchy", () => {
    const bare = compView({ key: key("gw-x", "orphan"), hier: [] });
    expect(componentFullPath(bare)).toEqual(["gw-x"]);
    expect(componentDetailPath(bare)).toEqual(["gw-x"]);
  });
});

describe("alarmsForComponent", () => {
  it("keeps only alarms attributed to the component id", () => {
    const mine = consoleAlarm({ key: key("gw-01", "opcua-adapter"), type: "connection-lost" });
    const other = consoleAlarm({ key: key("gw-01", "modbus-adapter"), type: "sensor-fault" });
    const out = alarmsForComponent([mine, other], key("gw-01", "opcua-adapter"));
    expect(out).toEqual([mine]);
  });
});

describe("detailSubtitleParts", () => {
  it("builds the subtitle facts from real data (intermediate levels, device, platform, keepalive, age)", () => {
    const comp = compView({
      key: key("pack-gw-01", "opcua-adapter"),
      hier: hier(["site", "dallas"], ["line", "packaging"], ["device", "pack-gw-01"]),
      expectedIntervalSecs: 5,
      lastStateAt: T0 - 43_000,
    });
    const attrs = runtimeAttrs(key("pack-gw-01", "opcua-adapter"), { platform: "HOST" });
    const parts = detailSubtitleParts(comp, attrs, 1, T0);
    expect(parts).toEqual([
      "line packaging",
      "pack-gw-01",
      "HOST",
      "1 instance",
      "keepalive 5s",
      "last state 43s ago",
    ]);
  });

  it("omits platform when unknown and says 'no state received yet' with no keepalive", () => {
    const comp = compView({
      key: key("gw-01", "a"),
      hier: hier(["site", "s"], ["device", "gw-01"]),
      expectedIntervalSecs: 10,
    });
    delete (comp as { lastStateAt?: number }).lastStateAt;
    const parts = detailSubtitleParts(comp, undefined, 2, T0);
    expect(parts).toEqual(["gw-01", "2 instances", "keepalive 10s", "no state received yet"]);
  });
});

describe("healthChecks", () => {
  it("derives freshness / messaging(?) / connectionState / readErrors / open alerts from real data", () => {
    const comp = compView({ key: key("gw-01", "opcua-adapter"), liveness: "STALE" });
    const attrs = runtimeAttrs(key("gw-01", "opcua-adapter"), {
      connectionState: "RECONNECTING",
      readErrors: 3,
    });
    const checks = healthChecks(comp, attrs, 1);
    expect(checks.map((c) => c.label)).toEqual([
      "heartbeat freshness",
      "messaging / ready",
      "connectionState",
      "readErrors",
      "open alerts",
    ]);
    expect(checks[0]).toMatchObject({ value: "stale", tone: "warn" });
    expect(checks[1]).toMatchObject({ value: "?", tone: "unknown", pending: true }); // honest pending
    expect(checks[2]).toMatchObject({ value: "RECONNECTING", tone: "warn" });
    expect(checks[3]).toMatchObject({ value: "3", tone: "warn" });
    expect(checks[4]).toMatchObject({ value: "1", tone: "err" });
  });

  it("marks connectionState / readErrors pending ('—') for a non-adapter with no attributes", () => {
    const comp = compView({ key: key("gw-01", "batch-runner"), liveness: "FRESH" });
    const checks = healthChecks(comp, undefined, 0);
    expect(checks[2]).toMatchObject({ label: "connectionState", value: "—", pending: true });
    expect(checks[3]).toMatchObject({ label: "readErrors", value: "—", pending: true });
    expect(checks[4]).toMatchObject({ label: "open alerts", value: "0", tone: "plain" });
  });
});

describe("detailUptimeSecs", () => {
  it("extrapolates uptime while provably alive", () => {
    const comp = compView({
      key: key("gw-01", "a"),
      status: "RUNNING",
      liveness: "FRESH",
      uptimeSecs: 100,
      uptimeAnchorAt: T0 - 10_000,
    });
    expect(detailUptimeSecs(comp, T0)).toBe(110);
  });

  it("freezes uptime when stale", () => {
    const comp = compView({
      key: key("gw-01", "a"),
      status: "RUNNING",
      liveness: "STALE",
      uptimeSecs: 100,
      uptimeAnchorAt: T0 - 10_000,
    });
    expect(detailUptimeSecs(comp, T0)).toBe(100);
  });
});

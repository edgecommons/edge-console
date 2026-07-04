/**
 * ConsoleSelfMonitor (R1): the console's OWN self-identity + process vitals — the honest source
 * behind the Overview "Edge node console self" tile. The cpu%-delta math is exercised with an
 * injected sampler (no sleeps): cpu% is the CPU-time share over the wall interval between calls.
 */
import { describe, expect, it } from "vitest";
import { ConsoleSelfMonitor, nodeSelfSampler } from "../src/fleet/console-self";
import type { SelfSysSampler } from "../src/fleet/console-self";

const MB = 1024 * 1024;

/** A sampler over a mutable ref the test advances between `sample()` calls. */
function fakeSampler(ref: { user: number; system: number; wall: number; rss: number; up: number }): SelfSysSampler {
  return {
    cpuUsageMicros: () => ({ user: ref.user, system: ref.system }),
    wallMicros: () => ref.wall,
    rssBytes: () => ref.rss,
    uptimeSecs: () => ref.up,
  };
}

describe("ConsoleSelfMonitor", () => {
  it("omits cpu% on the first sample (no interval yet) but reports mem/uptime + static identity", () => {
    const ref = { user: 0, system: 0, wall: 0, rss: 180 * MB, up: 6 * 86400 };
    const monitor = new ConsoleSelfMonitor(
      { device: "gw-dallas-01", component: "edge-console", platform: "HOST", transport: "MQTT", broker: "EMQX @ gateway" },
      fakeSampler(ref),
    );
    const self = monitor.sample();
    expect(self).toMatchObject({
      device: "gw-dallas-01",
      component: "edge-console",
      platform: "HOST",
      transport: "MQTT",
      broker: "EMQX @ gateway",
      memoryMb: 180,
      uptimeSecs: 6 * 86400,
    });
    expect(self.cpuPercent).toBeUndefined();
  });

  it("computes cpu% as the CPU-time share of one core over the wall interval", () => {
    const ref = { user: 0, system: 0, wall: 0, rss: 100 * MB, up: 10 };
    const monitor = new ConsoleSelfMonitor({ device: "gw", component: "edge-console" }, fakeSampler(ref));
    monitor.sample(); // prime
    // 1.0s of CPU (0.5 user + 0.5 system) over 2.0s wall → 50%.
    ref.user = 500_000;
    ref.system = 500_000;
    ref.wall = 2_000_000;
    ref.rss = 200 * MB;
    ref.up = 12;
    const self = monitor.sample();
    expect(self.cpuPercent).toBeCloseTo(50, 6);
    expect(self.memoryMb).toBe(200);
    expect(self.uptimeSecs).toBe(12);
  });

  it("omits the optional static fields when not supplied", () => {
    const ref = { user: 0, system: 0, wall: 0, rss: 0, up: 0 };
    const self = new ConsoleSelfMonitor({ device: "gw", component: "edge-console" }, fakeSampler(ref)).sample();
    expect(self.platform).toBeUndefined();
    expect(self.transport).toBeUndefined();
    expect(self.broker).toBeUndefined();
  });

  it("guards a zero/negative wall interval (no divide-by-zero cpu%)", () => {
    const ref = { user: 0, system: 0, wall: 1_000_000, rss: 0, up: 0 };
    const monitor = new ConsoleSelfMonitor({ device: "gw", component: "edge-console" }, fakeSampler(ref));
    monitor.sample();
    ref.user = 100_000; // CPU advanced but wall did NOT
    expect(monitor.sample().cpuPercent).toBeUndefined();
  });

  it("reads real process vitals through the default nodeSelfSampler", () => {
    expect(nodeSelfSampler.cpuUsageMicros().user).toBeGreaterThanOrEqual(0);
    expect(nodeSelfSampler.wallMicros()).toBeGreaterThan(0);
    expect(nodeSelfSampler.rssBytes()).toBeGreaterThan(0);
    expect(nodeSelfSampler.uptimeSecs()).toBeGreaterThanOrEqual(0);
    // A monitor with no injected sampler uses nodeSelfSampler and still produces a snapshot.
    const self = new ConsoleSelfMonitor({ device: "gw", component: "edge-console" }).sample();
    expect(self.memoryMb).toBeGreaterThan(0);
    expect(self.uptimeSecs).toBeGreaterThanOrEqual(0);
  });
});

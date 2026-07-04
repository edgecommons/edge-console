import { describe, expect, it } from "vitest";
import { ThroughputMeter } from "../src/fleet/throughput-meter";

/** A manual clock in ms. */
function clockAt(ref: { now: number }): () => number {
  return () => ref.now;
}

describe("ThroughputMeter", () => {
  it("is zero when idle", () => {
    const ref = { now: 1_000_000 };
    const meter = new ThroughputMeter(clockAt(ref), 10);
    expect(meter.ratePerSec()).toBe(0);
  });

  it("averages marks over the trailing window", () => {
    const ref = { now: 0 };
    const meter = new ThroughputMeter(clockAt(ref), 10);
    // 20 messages spread across the first two seconds → 20 / 10s = 2 msgs/s.
    for (let i = 0; i < 10; i++) meter.mark();
    ref.now = 1000;
    for (let i = 0; i < 10; i++) meter.mark();
    expect(meter.ratePerSec()).toBe(2);
  });

  it("drops buckets older than the window (rate decays as time passes)", () => {
    const ref = { now: 0 };
    const meter = new ThroughputMeter(clockAt(ref), 10);
    for (let i = 0; i < 30; i++) meter.mark(); // 30 in second 0
    expect(meter.ratePerSec()).toBe(3); // 30 / 10s

    // 10 s later the second-0 bucket has aged out of the window entirely.
    ref.now = 10_000;
    expect(meter.ratePerSec()).toBe(0);
  });

  it("supports a batch count and ignores non-positive marks", () => {
    const ref = { now: 5000 };
    const meter = new ThroughputMeter(clockAt(ref), 5);
    meter.mark(15);
    meter.mark(0);
    meter.mark(-3);
    expect(meter.ratePerSec()).toBe(3); // 15 / 5s
  });
});

describe("ThroughputMeter — recentRates (the tile sparkline ring, R1)", () => {
  it("returns a zero-filled ring of the history length when idle", () => {
    const ref = { now: 100_000 };
    const meter = new ThroughputMeter(clockAt(ref), 2, 6);
    expect(meter.recentRates()).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("reports per-second counts oldest→newest with zero-filled idle-second gaps", () => {
    const ref = { now: 0 };
    const meter = new ThroughputMeter(clockAt(ref), 2, 5);
    meter.mark(3); // second 0
    ref.now = 2000;
    meter.mark(7); // second 2 (second 1 idle) — the still-accumulating current second
    // ring covers seconds [-2..2] relative to nowSec=2: only seconds 0 and 2 have marks.
    expect(meter.recentRates()).toEqual([0, 0, 3, 0, 7]);
  });

  it("is bounded to the history length regardless of the requested count", () => {
    const ref = { now: 10_000 };
    const meter = new ThroughputMeter(clockAt(ref), 2, 3);
    expect(meter.recentRates(100)).toHaveLength(3);
    expect(meter.recentRates()).toHaveLength(3);
  });

  it("drops buckets that scrolled out of the history window", () => {
    const ref = { now: 0 };
    const meter = new ThroughputMeter(clockAt(ref), 2, 5);
    meter.mark(9); // second 0
    ref.now = 10_000; // 10 s later — second 0 is off the 5-bucket ring
    expect(meter.recentRates()).toEqual([0, 0, 0, 0, 0]);
  });
});

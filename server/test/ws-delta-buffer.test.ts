import { describe, expect, it } from "vitest";
import type { FleetDelta } from "@edgecommons/edge-console-protocol";

import { DeltaBuffer } from "../src/ws/delta-buffer";

function delta(seq: number): FleetDelta {
  return { type: "device-discovered", seq, at: 0, device: `d${seq}` };
}

describe("DeltaBuffer", () => {
  it("returns deltas strictly after resumeSeq while everything is still buffered", () => {
    const buf = new DeltaBuffer(10, 0);
    buf.push(delta(1));
    buf.push(delta(2));
    buf.push(delta(3));

    expect(buf.since(0)?.map((d) => d.seq)).toEqual([1, 2, 3]);
    expect(buf.since(1)?.map((d) => d.seq)).toEqual([2, 3]);
    expect(buf.since(3)?.map((d) => d.seq)).toEqual([]);
  });

  it("resuming exactly at the initial floor (startSeq) is valid, not a gap", () => {
    const buf = new DeltaBuffer(10, 5);
    buf.push(delta(6));
    expect(buf.since(5)?.map((d) => d.seq)).toEqual([6]);
  });

  it("resuming before the initial floor is a gap (undefined)", () => {
    const buf = new DeltaBuffer(10, 5);
    buf.push(delta(6));
    expect(buf.since(4)).toBeUndefined();
  });

  it("evicts the oldest entry past capacity and raises the floor accordingly", () => {
    const buf = new DeltaBuffer(2, 0);
    buf.push(delta(1));
    buf.push(delta(2));
    buf.push(delta(3)); // evicts seq 1; floor becomes 1

    expect(buf.since(1)?.map((d) => d.seq)).toEqual([2, 3]); // still exactly covered
    expect(buf.since(0)).toBeUndefined(); // seq 1 (evicted) would be needed — gap
  });

  it("a resume request for a seq beyond capacity keeps evicting the floor forward", () => {
    const buf = new DeltaBuffer(1, 0);
    for (let seq = 1; seq <= 5; seq++) buf.push(delta(seq));
    // Only seq 5 remains; floor is 4.
    expect(buf.since(4)?.map((d) => d.seq)).toEqual([5]);
    expect(buf.since(3)).toBeUndefined();
  });
});

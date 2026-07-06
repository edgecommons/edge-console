/**
 * ConsoleSelfMonitor — the console's OWN self-identity + process vitals (slice R1).
 *
 * The Overview "Edge node — console self" tile shows the console's own node/device name, its
 * deployment platform, and its live process cpu% / memory / uptime; the "Edge bus" tile's foot
 * shows the console's messaging transport + site-broker host. The console IS a edgecommons
 * component, so all of this is honestly sourced:
 *  - the STATIC identity (device/component/platform/transport/broker) comes from the console's
 *    own resolved runtime config (`main.ts` reads it off `gg` and passes it in);
 *  - the DYNAMIC vitals (cpu% / memory / uptime) are measured off the running process via an
 *    injected {@link SelfSysSampler} — `process.cpuUsage()`/`process.memoryUsage()`/
 *    `process.uptime()` in production, a fake in tests (the same inject-the-clock discipline the
 *    rest of the server uses, so the cpu%-delta math is unit-testable without sleeps).
 *
 * cpu% is the share of ONE core over the interval between two `sample()` calls (the heartbeat
 * cadence): `(Δcpu_micros / Δwall_micros) * 100`. The FIRST sample has no interval, so cpu% is
 * omitted (honest — not a fabricated 0) until the second heartbeat.
 */
import type { ConsoleSelf } from "@edgecommons/edge-console-protocol";

/** The console's static self-identity + messaging transport (from its own runtime config). */
export interface ConsoleSelfInfo {
  device: string;
  component: string;
  platform?: string;
  transport?: string;
  broker?: string;
}

/** The process-vitals sampler — injected so the cpu%-delta math is testable without sleeps. */
export interface SelfSysSampler {
  /** Cumulative process CPU time (microseconds), user + system (`process.cpuUsage()`). */
  cpuUsageMicros(): { user: number; system: number };
  /** A monotonic wall-clock read in microseconds (from `process.hrtime.bigint()` in prod). */
  wallMicros(): number;
  /** Resident set size in bytes (`process.memoryUsage().rss`). */
  rssBytes(): number;
  /** Process uptime in seconds (`process.uptime()`). */
  uptimeSecs(): number;
}

/** The production sampler over Node's `process` APIs. */
export const nodeSelfSampler: SelfSysSampler = {
  cpuUsageMicros: () => {
    const u = process.cpuUsage();
    return { user: u.user, system: u.system };
  },
  wallMicros: () => Number(process.hrtime.bigint() / 1000n),
  rssBytes: () => process.memoryUsage().rss,
  uptimeSecs: () => process.uptime(),
};

const BYTES_PER_MB = 1024 * 1024;

/** Samples the console's own process vitals and folds them into the static self-identity. */
export class ConsoleSelfMonitor {
  private lastCpuMicros: number | undefined;
  private lastWallMicros: number | undefined;

  constructor(
    private readonly info: ConsoleSelfInfo,
    private readonly sampler: SelfSysSampler = nodeSelfSampler,
  ) {}

  /**
   * Take one vitals sample and return the current {@link ConsoleSelf}. cpu% is the process CPU
   * share of one core since the previous call (omitted on the very first call — no interval yet);
   * memory is RSS in MB; uptime is `process.uptime()` seconds. Never throws.
   */
  sample(): ConsoleSelf {
    const cpu = this.sampler.cpuUsageMicros();
    const cpuMicros = cpu.user + cpu.system;
    const wallMicros = this.sampler.wallMicros();

    let cpuPercent: number | undefined;
    if (this.lastCpuMicros !== undefined && this.lastWallMicros !== undefined) {
      const deltaCpu = cpuMicros - this.lastCpuMicros;
      const deltaWall = wallMicros - this.lastWallMicros;
      if (deltaWall > 0 && deltaCpu >= 0) {
        cpuPercent = (deltaCpu / deltaWall) * 100;
      }
    }
    this.lastCpuMicros = cpuMicros;
    this.lastWallMicros = wallMicros;

    const memoryMb = this.sampler.rssBytes() / BYTES_PER_MB;
    const uptimeSecs = Math.max(0, this.sampler.uptimeSecs());

    return {
      device: this.info.device,
      component: this.info.component,
      ...(this.info.platform !== undefined ? { platform: this.info.platform } : {}),
      ...(this.info.transport !== undefined ? { transport: this.info.transport } : {}),
      ...(this.info.broker !== undefined ? { broker: this.info.broker } : {}),
      ...(cpuPercent !== undefined ? { cpuPercent } : {}),
      memoryMb,
      uptimeSecs,
    };
  }
}

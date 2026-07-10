//! The console's own live process vitals (cpu% / memory) for the heartbeat `self` frame.
//!
//! The console IS an EdgeCommons component, so these are honestly sourced from the running
//! process. The sampler is injected behind [`VitalsSampler`] so the primed/unprimed cpu% logic
//! is unit-testable without real sleeps or a live process — the same inject-the-clock discipline
//! the TS reference uses in `server/src/fleet/console-self.ts`. It mirrors the library's
//! `HeartbeatMonitor` primed handling (`local/edgecommons-rust/src/heartbeat.rs`): CPU is measured
//! as a delta between consecutive refreshes, so the first sample has no baseline and cpu% is
//! **omitted** (never a fabricated 0) until the second sample.

use std::time::{Duration, Instant};

/// The minimum spacing between real sampler refreshes. With N sessions sharing one heartbeat
/// cadence, near-simultaneous ticks reuse the cached sample instead of re-refreshing sysinfo.
const MIN_REFRESH_INTERVAL: Duration = Duration::from_secs(1);

/// One raw reading of the current process, straight from the sampler.
#[derive(Debug, Clone, Copy)]
pub struct RawSample {
    /// sysinfo cpu-usage convention: `0.0` on the first refresh (no baseline), then the share of
    /// one core over the interval between refreshes (can exceed 100% for a multi-threaded process).
    pub cpu_usage: f64,
    /// Resident memory in bytes (`process.memory()`).
    pub memory_bytes: u64,
}

/// The process-vitals seam — injected so the primed/unprimed cpu% math is testable without sleeps.
pub trait VitalsSampler: Send {
    /// Refresh and read the current process.
    fn sample(&mut self) -> RawSample;
}

/// A folded vitals sample as it appears on the heartbeat `self` frame: both fields optional and
/// omitted (never fabricated) when unavailable.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct VitalsSample {
    /// Process CPU share of one core over the last interval; `None` until the sampler is primed.
    pub cpu_percent: Option<f64>,
    /// Resident memory in MB (`process.memory()` bytes / 1_000_000 — same divisor as the library).
    pub memory_mb: Option<f64>,
}

/// Samples the console's own process vitals, holding the sysinfo state, the CPU baseline (`primed`),
/// and a short-lived cache so many sessions on one cadence share a single refresh.
pub struct SelfVitals {
    sampler: Box<dyn VitalsSampler>,
    /// False until the first refresh establishes a CPU baseline.
    primed: bool,
    last_refresh: Option<Instant>,
    cache: VitalsSample,
    min_interval: Duration,
}

impl SelfVitals {
    /// A vitals monitor over the real current process (production).
    pub fn new() -> Self {
        Self::with_sampler(Box::new(SysinfoSampler::new()))
    }

    /// A vitals monitor over an injected sampler (tests).
    pub fn with_sampler(sampler: Box<dyn VitalsSampler>) -> Self {
        Self {
            sampler,
            primed: false,
            last_refresh: None,
            cache: VitalsSample::default(),
            min_interval: MIN_REFRESH_INTERVAL,
        }
    }

    /// Take (or reuse) a vitals sample. `now` is injected so the `< 1 s` cache guard is testable
    /// without sleeps. Within [`MIN_REFRESH_INTERVAL`] of the last refresh, the cached sample is
    /// returned unchanged; otherwise the sampler is refreshed. cpu% is omitted on the first real
    /// refresh (no baseline), never fabricated.
    pub fn sample_at(&mut self, now: Instant) -> VitalsSample {
        if let Some(last) = self.last_refresh
            && now.duration_since(last) < self.min_interval
        {
            return self.cache;
        }

        let raw = self.sampler.sample();
        let was_primed = self.primed;
        self.primed = true;
        self.last_refresh = Some(now);

        let memory_mb = raw.memory_bytes as f64 / 1_000_000.0;
        self.cache = VitalsSample {
            cpu_percent: if was_primed {
                Some(raw.cpu_usage).filter(|v| v.is_finite())
            } else {
                None
            },
            memory_mb: Some(memory_mb).filter(|v| v.is_finite()),
        };
        self.cache
    }
}

impl Default for SelfVitals {
    fn default() -> Self {
        Self::new()
    }
}

/// The production sampler over `sysinfo`, scoped to the current process. Mirrors the library's
/// `HeartbeatMonitor` (`local/edgecommons-rust/src/heartbeat.rs`).
struct SysinfoSampler {
    system: sysinfo::System,
    pid: Option<sysinfo::Pid>,
}

impl SysinfoSampler {
    fn new() -> Self {
        Self {
            system: sysinfo::System::new(),
            pid: sysinfo::get_current_pid().ok(),
        }
    }
}

impl VitalsSampler for SysinfoSampler {
    fn sample(&mut self) -> RawSample {
        if let Some(pid) = self.pid {
            self.system
                .refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
        }
        match self.pid.and_then(|pid| self.system.process(pid)) {
            Some(process) => RawSample {
                cpu_usage: process.cpu_usage() as f64,
                memory_bytes: process.memory(),
            },
            None => RawSample {
                cpu_usage: 0.0,
                memory_bytes: 0,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scripted sampler: hands back each queued reading in turn (repeating the last), and counts
    /// how many times it was actually refreshed — so the cache guard is observable.
    struct FakeSampler {
        readings: Vec<RawSample>,
        calls: usize,
    }

    impl FakeSampler {
        fn new(readings: Vec<RawSample>) -> Self {
            Self { readings, calls: 0 }
        }
    }

    impl VitalsSampler for FakeSampler {
        fn sample(&mut self) -> RawSample {
            let idx = self.calls.min(self.readings.len() - 1);
            self.calls += 1;
            self.readings[idx]
        }
    }

    fn reading(cpu: f64, mem_bytes: u64) -> RawSample {
        RawSample {
            cpu_usage: cpu,
            memory_bytes: mem_bytes,
        }
    }

    #[test]
    fn first_sample_omits_cpu_but_reports_memory() {
        let mut vitals =
            SelfVitals::with_sampler(Box::new(FakeSampler::new(vec![reading(42.0, 200_000_000)])));
        let t0 = Instant::now();
        let s = vitals.sample_at(t0);
        // No baseline yet: cpu omitted (not fabricated 0), memory present.
        assert_eq!(s.cpu_percent, None);
        assert_eq!(s.memory_mb, Some(200.0));
    }

    #[test]
    fn second_sample_reports_cpu_once_primed() {
        let mut vitals = SelfVitals::with_sampler(Box::new(FakeSampler::new(vec![
            reading(0.0, 200_000_000),
            reading(55.0, 210_000_000),
        ])));
        let t0 = Instant::now();
        assert_eq!(vitals.sample_at(t0).cpu_percent, None);
        // A full interval later the baseline exists -> cpu reported.
        let s = vitals.sample_at(t0 + Duration::from_secs(2));
        assert_eq!(s.cpu_percent, Some(55.0));
        assert_eq!(s.memory_mb, Some(210.0));
    }

    #[test]
    fn cache_guard_reuses_within_one_second() {
        let sampler = FakeSampler::new(vec![reading(0.0, 100_000_000), reading(80.0, 120_000_000)]);
        let mut vitals = SelfVitals::with_sampler(Box::new(sampler));
        let t0 = Instant::now();
        let first = vitals.sample_at(t0);
        // 500 ms later: inside the guard -> returns the cached (still-unprimed) sample verbatim,
        // and the sampler is NOT refreshed again.
        let cached = vitals.sample_at(t0 + Duration::from_millis(500));
        assert_eq!(cached, first);
        assert_eq!(cached.cpu_percent, None);
        // Past the guard: a real second refresh, now primed -> cpu appears.
        let refreshed = vitals.sample_at(t0 + Duration::from_millis(1_500));
        assert_eq!(refreshed.cpu_percent, Some(80.0));
        assert_eq!(refreshed.memory_mb, Some(120.0));
    }

    #[test]
    fn non_finite_cpu_is_dropped() {
        let mut vitals = SelfVitals::with_sampler(Box::new(FakeSampler::new(vec![
            reading(0.0, 10_000_000),
            reading(f64::NAN, 10_000_000),
        ])));
        let t0 = Instant::now();
        vitals.sample_at(t0);
        let s = vitals.sample_at(t0 + Duration::from_secs(2));
        // Primed, but a non-finite reading is never emitted (keeps encode_frame infallible).
        assert_eq!(s.cpu_percent, None);
        assert_eq!(s.memory_mb, Some(10.0));
    }
}

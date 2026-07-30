use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct V3RuntimeTimingSummary {
    pub runtime_total: Duration,
    pub external: Duration,
    pub internal: Duration,
}

#[derive(Debug, Clone)]
pub(crate) struct V3RuntimeTimingState {
    inner: Arc<Mutex<V3RuntimeTimingStateInner>>,
}

#[derive(Debug)]
struct V3RuntimeTimingStateInner {
    runtime_started: Instant,
    external_started: Option<Instant>,
    external_total: Duration,
    finished: bool,
}

impl V3RuntimeTimingState {
    pub(crate) fn start() -> Self {
        Self {
            inner: Arc::new(Mutex::new(V3RuntimeTimingStateInner {
                runtime_started: Instant::now(),
                external_started: None,
                external_total: Duration::ZERO,
                finished: false,
            })),
        }
    }

    pub(crate) fn start_external(&self) -> Result<(), String> {
        let mut state = self.lock()?;
        if state.finished {
            return Err("V3 Runtime timing is already terminal".to_string());
        }
        if state.external_started.is_some() {
            return Err("V3 Runtime external timing attempt is already active".to_string());
        }
        state.external_started = Some(Instant::now());
        Ok(())
    }

    pub(crate) fn finish_external(&self) -> Result<(), String> {
        let mut state = self.lock()?;
        if state.finished {
            return Err("V3 Runtime timing is already terminal".to_string());
        }
        let started = state
            .external_started
            .take()
            .ok_or_else(|| "V3 Runtime external timing attempt is not active".to_string())?;
        state.external_total = state
            .external_total
            .checked_add(started.elapsed())
            .ok_or_else(|| "V3 Runtime external timing overflowed".to_string())?;
        Ok(())
    }

    pub(crate) fn finish_runtime(&self) -> Result<V3RuntimeTimingSummary, String> {
        let mut state = self.lock()?;
        if state.finished {
            return Err("V3 Runtime timing is already terminal".to_string());
        }
        if state.external_started.is_some() {
            return Err(
                "V3 Runtime timing cannot finish while an external attempt is active".to_string(),
            );
        }
        let runtime_total = state.runtime_started.elapsed();
        let internal = runtime_total
            .checked_sub(state.external_total)
            .ok_or_else(|| {
                "V3 Runtime external timing exceeds the Runtime total interval".to_string()
            })?;
        state.finished = true;
        Ok(V3RuntimeTimingSummary {
            runtime_total,
            external: state.external_total,
            internal,
        })
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, V3RuntimeTimingStateInner>, String> {
        self.inner
            .lock()
            .map_err(|_| "V3 Runtime timing state lock is poisoned".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_timing_accumulates_external_attempts_and_preserves_identity() {
        let timing = V3RuntimeTimingState::start();
        timing.start_external().unwrap();
        std::thread::sleep(Duration::from_millis(2));
        timing.finish_external().unwrap();
        timing.start_external().unwrap();
        std::thread::sleep(Duration::from_millis(2));
        timing.finish_external().unwrap();

        let summary = timing.finish_runtime().unwrap();

        assert!(summary.external >= Duration::from_millis(4), "{summary:?}");
        assert_eq!(
            summary.internal.checked_add(summary.external),
            Some(summary.runtime_total)
        );
    }

    #[test]
    fn runtime_timing_rejects_premature_or_duplicate_closeout() {
        let timing = V3RuntimeTimingState::start();
        assert!(timing.finish_external().is_err());
        timing.start_external().unwrap();
        assert!(timing.start_external().is_err());
        assert!(timing.finish_runtime().is_err());
        timing.finish_external().unwrap();
        timing.finish_runtime().unwrap();
        assert!(timing.finish_runtime().is_err());
        assert!(timing.start_external().is_err());
    }
}

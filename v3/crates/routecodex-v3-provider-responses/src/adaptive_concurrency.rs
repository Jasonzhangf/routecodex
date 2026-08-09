use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

pub const V3_PROVIDER_CONCURRENCY_PROBE_INTERVAL_MS: u64 = 10 * 60_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3AdaptiveConcurrencySnapshot {
    pub provider_key: String,
    pub budget: u32,
    pub in_flight: u32,
    pub saturated: bool,
    pub probe_in_flight: bool,
    pub next_probe_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3AdaptiveConcurrencyAdmission {
    Lease,
    Probe,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3AdaptiveConcurrencyLease {
    pub admission: V3AdaptiveConcurrencyAdmission,
    permit: V3AdaptiveConcurrencyPermit,
}

impl V3AdaptiveConcurrencyLease {
    pub fn is_probe(&self) -> bool {
        matches!(self.admission, V3AdaptiveConcurrencyAdmission::Probe)
    }

    pub fn provider_key(&self) -> &str {
        self.permit.provider_key()
    }

    pub fn into_permit(self) -> V3AdaptiveConcurrencyPermit {
        self.permit
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3AdaptiveConcurrencyProbeResult {
    Accepted,
    RateLimited,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3AdaptiveConcurrencyPermit {
    provider_key: String,
    probe: bool,
}

pub struct V3AdaptiveConcurrencyPermitGuard {
    controller: V3AdaptiveConcurrencyController,
    permit: Option<V3AdaptiveConcurrencyPermit>,
}

impl V3AdaptiveConcurrencyPermitGuard {
    pub fn new(
        controller: V3AdaptiveConcurrencyController,
        permit: V3AdaptiveConcurrencyPermit,
    ) -> Self {
        Self {
            controller,
            permit: Some(permit),
        }
    }
}

impl Drop for V3AdaptiveConcurrencyPermitGuard {
    fn drop(&mut self) {
        if let Some(permit) = self.permit.take() {
            let _ = self.controller.release(permit);
        }
    }
}

impl V3AdaptiveConcurrencyPermit {
    pub fn provider_key(&self) -> &str {
        &self.provider_key
    }

    pub fn is_probe(&self) -> bool {
        self.probe
    }
}

#[derive(Debug, Default)]
struct V3AdaptiveConcurrencyState {
    budget: u32,
    in_flight: u32,
    saturated: bool,
    probe_in_flight: bool,
    next_probe_at_ms: Option<u64>,
}

#[derive(Debug, Default)]
struct V3AdaptiveConcurrencyInner {
    states: Mutex<BTreeMap<String, V3AdaptiveConcurrencyState>>,
    changed: Notify,
    initial_budget: u32,
}

#[derive(Debug, Clone)]
pub struct V3AdaptiveConcurrencyController {
    inner: Arc<V3AdaptiveConcurrencyInner>,
}

impl V3AdaptiveConcurrencyController {
    pub fn process_shared() -> Self {
        static SHARED: OnceLock<V3AdaptiveConcurrencyController> = OnceLock::new();
        SHARED
            .get_or_init(|| Self::new(8).expect("adaptive concurrency default budget is valid"))
            .clone()
    }

    pub fn new(initial_budget: u32) -> Result<Self, String> {
        if initial_budget == 0 {
            return Err("adaptive concurrency initial budget must be positive".to_string());
        }
        Ok(Self {
            inner: Arc::new(V3AdaptiveConcurrencyInner {
                states: Mutex::new(BTreeMap::new()),
                changed: Notify::new(),
                initial_budget,
            }),
        })
    }

    pub fn ensure_initial_budget(
        &self,
        provider_key: &str,
        initial_budget: u32,
    ) -> Result<(), String> {
        if initial_budget == 0 {
            return Err("adaptive concurrency initial budget must be positive".to_string());
        }
        let mut states = self
            .inner
            .states
            .lock()
            .expect("adaptive concurrency state lock should not be poisoned");
        states
            .entry(provider_key.to_string())
            .or_insert_with(|| V3AdaptiveConcurrencyState {
                budget: initial_budget,
                ..V3AdaptiveConcurrencyState::default()
            });
        Ok(())
    }

    pub async fn acquire(
        &self,
        provider_key: impl Into<String>,
        now_ms: u64,
    ) -> V3AdaptiveConcurrencyLease {
        self.acquire_with_clock(provider_key, || now_ms).await
    }

    pub async fn acquire_with_clock<F>(
        &self,
        provider_key: impl Into<String>,
        now_ms: F,
    ) -> V3AdaptiveConcurrencyLease
    where
        F: Fn() -> u64 + Copy,
    {
        let provider_key = provider_key.into();
        loop {
            let notified = self.inner.changed.notified();
            if let Some(lease) = self.try_acquire(&provider_key, now_ms()) {
                return lease;
            }
            notified.await;
        }
    }

    pub fn try_acquire(
        &self,
        provider_key: &str,
        now_ms: u64,
    ) -> Option<V3AdaptiveConcurrencyLease> {
        let mut states = self
            .inner
            .states
            .lock()
            .expect("adaptive concurrency state lock should not be poisoned");
        let state =
            states
                .entry(provider_key.to_string())
                .or_insert_with(|| V3AdaptiveConcurrencyState {
                    budget: self.inner.initial_budget,
                    ..V3AdaptiveConcurrencyState::default()
                });
        if state.in_flight < state.budget {
            state.in_flight = state.in_flight.saturating_add(1);
            return Some(V3AdaptiveConcurrencyLease {
                admission: V3AdaptiveConcurrencyAdmission::Lease,
                permit: V3AdaptiveConcurrencyPermit {
                    provider_key: provider_key.to_string(),
                    probe: false,
                },
            });
        }
        if !state.saturated && !state.probe_in_flight {
            state.probe_in_flight = true;
            state.in_flight = state.in_flight.saturating_add(1);
            return Some(V3AdaptiveConcurrencyLease {
                admission: V3AdaptiveConcurrencyAdmission::Probe,
                permit: V3AdaptiveConcurrencyPermit {
                    provider_key: provider_key.to_string(),
                    probe: true,
                },
            });
        }
        if state.saturated
            && !state.probe_in_flight
            && state.next_probe_at_ms.is_some_and(|next| now_ms >= next)
        {
            state.probe_in_flight = true;
            state.in_flight = state.in_flight.saturating_add(1);
            return Some(V3AdaptiveConcurrencyLease {
                admission: V3AdaptiveConcurrencyAdmission::Probe,
                permit: V3AdaptiveConcurrencyPermit {
                    provider_key: provider_key.to_string(),
                    probe: true,
                },
            });
        }
        None
    }

    pub fn complete_probe(
        &self,
        permit: V3AdaptiveConcurrencyPermit,
        result: V3AdaptiveConcurrencyProbeResult,
        now_ms: u64,
    ) -> Result<(), String> {
        if !permit.probe {
            return Err("non-probe permit cannot complete a probe".to_string());
        }
        let mut states = self
            .inner
            .states
            .lock()
            .expect("adaptive concurrency state lock should not be poisoned");
        let state = states
            .get_mut(&permit.provider_key)
            .ok_or_else(|| "adaptive concurrency provider key is missing".to_string())?;
        if !state.probe_in_flight || state.in_flight == 0 {
            return Err("adaptive concurrency probe is not in flight".to_string());
        }
        state.probe_in_flight = false;
        state.in_flight -= 1;
        match result {
            V3AdaptiveConcurrencyProbeResult::Accepted => {
                state.budget = state.budget.saturating_add(1);
                state.saturated = false;
                state.next_probe_at_ms = None;
            }
            V3AdaptiveConcurrencyProbeResult::RateLimited => {
                state.budget = state.budget.saturating_sub(1).max(1);
                state.saturated = true;
                state.next_probe_at_ms =
                    Some(now_ms.saturating_add(V3_PROVIDER_CONCURRENCY_PROBE_INTERVAL_MS));
            }
        }
        drop(states);
        self.inner.changed.notify_waiters();
        Ok(())
    }

    pub fn observe_rate_limit(&self, provider_key: &str, now_ms: u64) -> Result<(), String> {
        let mut states = self
            .inner
            .states
            .lock()
            .expect("adaptive concurrency state lock should not be poisoned");
        let state = states
            .get_mut(provider_key)
            .ok_or_else(|| "adaptive concurrency provider key is missing".to_string())?;
        state.budget = state.budget.saturating_sub(1).max(1);
        state.saturated = true;
        state.next_probe_at_ms =
            Some(now_ms.saturating_add(V3_PROVIDER_CONCURRENCY_PROBE_INTERVAL_MS));
        drop(states);
        self.inner.changed.notify_waiters();
        Ok(())
    }

    pub fn release(&self, permit: V3AdaptiveConcurrencyPermit) -> Result<(), String> {
        let mut states = self
            .inner
            .states
            .lock()
            .expect("adaptive concurrency state lock should not be poisoned");
        let state = states
            .get_mut(&permit.provider_key)
            .ok_or_else(|| "adaptive concurrency provider key is missing".to_string())?;
        if state.in_flight == 0 {
            return Err("adaptive concurrency lease underflow".to_string());
        }
        state.in_flight -= 1;
        drop(states);
        self.inner.changed.notify_one();
        Ok(())
    }

    pub fn snapshot(&self, provider_key: &str) -> Option<V3AdaptiveConcurrencySnapshot> {
        let states = self
            .inner
            .states
            .lock()
            .expect("adaptive concurrency state lock should not be poisoned");
        states
            .get(provider_key)
            .map(|state| V3AdaptiveConcurrencySnapshot {
                provider_key: provider_key.to_string(),
                budget: state.budget,
                in_flight: state.in_flight,
                saturated: state.saturated,
                probe_in_flight: state.probe_in_flight,
                next_probe_at_ms: state.next_probe_at_ms,
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_zero_initial_budget() {
        assert!(V3AdaptiveConcurrencyController::new(0).is_err());
    }

    #[test]
    fn first_over_budget_request_is_a_probe_not_a_local_rejection() {
        let controller = V3AdaptiveConcurrencyController::new(2).unwrap();
        let first = controller.try_acquire("opencode-go:key1", 0).unwrap();
        let second = controller.try_acquire("opencode-go:key1", 0).unwrap();
        let probe = controller.try_acquire("opencode-go:key1", 0).unwrap();
        assert!(!first.is_probe());
        assert!(!second.is_probe());
        assert!(probe.is_probe());
        assert!(controller.try_acquire("opencode-go:key1", 0).is_none());
        controller.release(first.into_permit()).unwrap();
        controller.release(second.into_permit()).unwrap();
        controller
            .complete_probe(
                probe.into_permit(),
                V3AdaptiveConcurrencyProbeResult::Accepted,
                0,
            )
            .unwrap();
        assert_eq!(controller.snapshot("opencode-go:key1").unwrap().budget, 3);
    }

    #[test]
    fn upstream_429_confirms_saturation_and_reduces_budget() {
        let controller = V3AdaptiveConcurrencyController::new(2).unwrap();
        let first = controller.try_acquire("opencode-go:key1", 0).unwrap();
        let second = controller.try_acquire("opencode-go:key1", 0).unwrap();
        let probe = controller.try_acquire("opencode-go:key1", 0).unwrap();
        controller.release(first.into_permit()).unwrap();
        controller.release(second.into_permit()).unwrap();
        controller
            .complete_probe(
                probe.into_permit(),
                V3AdaptiveConcurrencyProbeResult::RateLimited,
                100,
            )
            .unwrap();
        let snapshot = controller.snapshot("opencode-go:key1").unwrap();
        assert_eq!(snapshot.budget, 1);
        assert!(snapshot.saturated);
        assert_eq!(snapshot.next_probe_at_ms, Some(600_100));
        let held = controller.try_acquire("opencode-go:key1", 100).unwrap();
        assert!(controller.try_acquire("opencode-go:key1", 100).is_none());
        controller.release(held.into_permit()).unwrap();
    }

    #[test]
    fn ten_minute_probe_reopens_budget_only_after_success() {
        let controller = V3AdaptiveConcurrencyController::new(1).unwrap();
        let lease = controller.try_acquire("opencode-go:key1", 0).unwrap();
        let probe = controller.try_acquire("opencode-go:key1", 0);
        assert!(probe.as_ref().is_some_and(|lease| lease.is_probe()));
        let probe = probe.unwrap();
        controller.release(lease.into_permit()).unwrap();
        controller
            .complete_probe(
                probe.into_permit(),
                V3AdaptiveConcurrencyProbeResult::RateLimited,
                0,
            )
            .unwrap();
        let held = controller.try_acquire("opencode-go:key1", 0).unwrap();
        assert!(controller
            .try_acquire("opencode-go:key1", 599_999)
            .is_none());
        let probe = controller.try_acquire("opencode-go:key1", 600_000).unwrap();
        assert!(probe.is_probe());
        controller
            .complete_probe(
                probe.into_permit(),
                V3AdaptiveConcurrencyProbeResult::Accepted,
                600_000,
            )
            .unwrap();
        let snapshot = controller.snapshot("opencode-go:key1").unwrap();
        assert_eq!(snapshot.budget, 2);
        assert!(!snapshot.saturated);
        controller.release(held.into_permit()).unwrap();
    }

    #[test]
    fn provider_keys_are_isolated() {
        let controller = V3AdaptiveConcurrencyController::new(1).unwrap();
        let key1 = controller.try_acquire("opencode-go:key1", 0).unwrap();
        let key2 = controller.try_acquire("opencode-go:key2", 0).unwrap();
        assert!(!key1.is_probe());
        assert!(!key2.is_probe());
        controller.release(key1.into_permit()).unwrap();
        controller.release(key2.into_permit()).unwrap();
        assert_eq!(
            controller.snapshot("opencode-go:key1").unwrap().in_flight,
            0
        );
        assert_eq!(
            controller.snapshot("opencode-go:key2").unwrap().in_flight,
            0
        );
    }

    #[tokio::test]
    async fn waiter_is_released_without_acquire_timeout() {
        let controller = V3AdaptiveConcurrencyController::new(1).unwrap();
        let held = controller.acquire("opencode-go:key1", 0).await;
        let probe = controller.acquire("opencode-go:key1", 0).await;
        assert!(probe.is_probe());
        controller.release(held.into_permit()).unwrap();
        controller
            .complete_probe(
                probe.into_permit(),
                V3AdaptiveConcurrencyProbeResult::RateLimited,
                0,
            )
            .unwrap();
        let held = controller.try_acquire("opencode-go:key1", 0).unwrap();
        let waiter_controller = controller.clone();
        let waiter =
            tokio::spawn(async move { waiter_controller.acquire("opencode-go:key1", 0).await });
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());
        let recovery_probe = controller
            .acquire(
                "opencode-go:key1",
                V3_PROVIDER_CONCURRENCY_PROBE_INTERVAL_MS,
            )
            .await;
        controller
            .complete_probe(
                recovery_probe.into_permit(),
                V3AdaptiveConcurrencyProbeResult::Accepted,
                V3_PROVIDER_CONCURRENCY_PROBE_INTERVAL_MS,
            )
            .unwrap();
        let acquired = waiter.await.unwrap();
        assert!(!acquired.is_probe());
        controller.release(acquired.into_permit()).unwrap();
        controller.release(held.into_permit()).unwrap();
    }

    #[test]
    fn rejects_invalid_probe_completion_and_lease_underflow() {
        let controller = V3AdaptiveConcurrencyController::new(1).unwrap();
        let lease = controller.try_acquire("opencode-go:key1", 0).unwrap();
        assert!(controller
            .complete_probe(
                lease.clone().into_permit(),
                V3AdaptiveConcurrencyProbeResult::Accepted,
                0,
            )
            .is_err());
        controller.release(lease.into_permit()).unwrap();
        assert!(controller
            .release(V3AdaptiveConcurrencyPermit {
                provider_key: "opencode-go:key1".to_string(),
                probe: false,
            })
            .is_err());
    }
}

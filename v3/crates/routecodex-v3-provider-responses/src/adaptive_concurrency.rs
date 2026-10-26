use std::collections::{BTreeMap, VecDeque};
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::Notify;

pub const V3_PROVIDER_CONCURRENCY_PROBE_INTERVAL_MS: u64 = 10 * 60_000;

/// The adaptive budget is derived from HTTP 429 observations in this trailing
/// window. A sample records the in-flight count at the moment the provider
/// rate-limited, which is the concurrency level the provider refused.
pub const V3_ADAPTIVE_CONCURRENCY_SAMPLE_WINDOW_MS: u64 = 60 * 60_000;

/// Default provider concurrency hard maximum when the declaration omits
/// `provider.concurrency.maxInFlight`.
pub const V3_DEFAULT_PROVIDER_MAX_IN_FLIGHT: u32 = 40;

/// Dynamic capacity belongs to a declared interface/model, never a wire body.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct V3ConcurrencyIdentityScope {
    pub interface_id: String,
    pub model_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct V3ConcurrencyBucketKey {
    provider_key: String,
    scope: Option<V3ConcurrencyIdentityScope>,
}

impl V3ConcurrencyBucketKey {
    fn new(provider_key: &str, scope: Option<&V3ConcurrencyIdentityScope>) -> Self {
        Self {
            provider_key: provider_key.to_owned(),
            scope: scope.cloned(),
        }
    }
}

type V3ConcurrencyStates = BTreeMap<V3ConcurrencyBucketKey, V3AdaptiveConcurrencyState>;

fn current_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3AdaptiveConcurrencySnapshot {
    pub provider_key: String,
    pub identity_scope: Option<V3ConcurrencyIdentityScope>,
    pub total_provider_in_flight: u32,
    pub budget: u32,
    pub in_flight: u32,
    pub saturated: bool,
    pub probe_in_flight: bool,
    pub next_probe_at_ms: Option<u64>,
    /// Configured static ceiling, taken from `provider.concurrency.maxInFlight`.
    pub hard_max_in_flight: u32,
    /// Number of HTTP 429 samples retained in the trailing one-hour window.
    pub rate_limit_samples: usize,
    /// Budget ceiling implied by the retained 429 samples.
    pub smoothed_budget: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3AdaptiveConcurrencyAdmission {
    Lease,
    Probe,
}

#[derive(Debug, PartialEq, Eq)]
pub struct V3AdaptiveConcurrencyLease {
    admission: V3AdaptiveConcurrencyAdmission,
    permit: V3AdaptiveConcurrencyPermit,
    controller: V3AdaptiveConcurrencyController,
}

impl V3AdaptiveConcurrencyLease {
    pub fn is_probe(&self) -> bool {
        matches!(self.admission, V3AdaptiveConcurrencyAdmission::Probe)
    }

    pub fn provider_key(&self) -> &str {
        self.permit.provider_key()
    }

    pub fn identity_scope(&self) -> Option<&V3ConcurrencyIdentityScope> {
        self.permit.identity_scope.as_ref()
    }

    pub(crate) fn belongs_to(&self, controller: &V3AdaptiveConcurrencyController) -> bool {
        Arc::ptr_eq(&self.controller.inner, &controller.inner)
    }

    pub(crate) fn release(self) -> Result<(), String> {
        self.controller.release(self.permit)
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

#[derive(Debug, PartialEq, Eq)]
pub struct V3AdaptiveConcurrencyPermit {
    provider_key: String,
    identity_scope: Option<V3ConcurrencyIdentityScope>,
    probe: bool,
}

pub(crate) struct V3AdaptiveConcurrencyPermitGuard {
    controller: V3AdaptiveConcurrencyController,
    permit: Option<V3AdaptiveConcurrencyPermit>,
    probe_result: Option<V3AdaptiveConcurrencyProbeResult>,
}

impl V3AdaptiveConcurrencyPermitGuard {
    pub(crate) fn new(
        controller: V3AdaptiveConcurrencyController,
        permit: V3AdaptiveConcurrencyPermit,
    ) -> Self {
        Self {
            controller,
            permit: Some(permit),
            probe_result: None,
        }
    }

    pub(crate) fn with_probe_result(mut self, result: V3AdaptiveConcurrencyProbeResult) -> Self {
        self.probe_result = Some(result);
        self
    }

    pub(crate) fn observe_rate_limit(&self, now_ms: u64) -> Result<(), String> {
        let permit = self.permit.as_ref().expect("live guard owns its permit");
        self.controller.observe_rate_limit_scoped(
            &permit.provider_key,
            permit.identity_scope.as_ref(),
            now_ms,
        )
    }
}

impl Drop for V3AdaptiveConcurrencyPermitGuard {
    fn drop(&mut self) {
        if let Some(permit) = self.permit.take() {
            if let Some(result) = self.probe_result.take() {
                self.controller
                    .complete_probe(permit, result, current_epoch_ms())
                    .expect("adaptive concurrency probe completion must never fail: lease underflow or missing provider key indicates invariant corruption and must fail fast instead of silently hanging the provider");
            } else {
                self.controller
                    .release(permit)
                    .expect("adaptive concurrency permit release must never fail: lease underflow or missing provider key indicates invariant corruption and must fail fast instead of silently hanging the provider");
            }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct V3AdaptiveConcurrencyRateLimitSample {
    epoch_ms: u64,
    in_flight_at_429: u32,
}

#[derive(Debug)]
struct V3AdaptiveConcurrencyState {
    budget: u32,
    hard_max_in_flight: u32,
    in_flight: u32,
    saturated: bool,
    probe_in_flight: bool,
    next_probe_at_ms: Option<u64>,
    notify: Arc<Notify>,
    /// Trailing-window HTTP 429 samples. The sample's in_flight value is the
    /// concurrency level the provider rate-limited at, captured before the
    /// rate-limited request's own lease is released.
    rate_limit_samples: VecDeque<V3AdaptiveConcurrencyRateLimitSample>,
}

impl Default for V3AdaptiveConcurrencyState {
    fn default() -> Self {
        Self {
            budget: 0,
            hard_max_in_flight: 0,
            in_flight: 0,
            saturated: false,
            probe_in_flight: false,
            next_probe_at_ms: None,
            notify: Arc::new(Notify::new()),
            rate_limit_samples: VecDeque::new(),
        }
    }
}

#[derive(Debug, Default)]
struct V3AdaptiveConcurrencyInner {
    states: Mutex<V3ConcurrencyStates>,
    initial_budget: u32,
    hard_max_in_flight: u32,
}

#[derive(Debug, Clone)]
pub struct V3AdaptiveConcurrencyController {
    inner: Arc<V3AdaptiveConcurrencyInner>,
}

impl PartialEq for V3AdaptiveConcurrencyController {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }
}

impl Eq for V3AdaptiveConcurrencyController {}

impl V3AdaptiveConcurrencyController {
    fn total_in_flight(states: &V3ConcurrencyStates, provider_key: &str) -> u32 {
        states
            .iter()
            .filter(|(key, _)| key.provider_key == provider_key)
            .fold(0u32, |total, (_, state)| {
                total.saturating_add(state.in_flight)
            })
    }

    fn state_mut<'a>(
        &self,
        states: &'a mut V3ConcurrencyStates,
        provider_key: &str,
        scope: Option<&V3ConcurrencyIdentityScope>,
    ) -> &'a mut V3AdaptiveConcurrencyState {
        let shared = states
            .entry(V3ConcurrencyBucketKey::new(provider_key, None))
            .or_insert_with(|| V3AdaptiveConcurrencyState {
                budget: self.inner.initial_budget,
                hard_max_in_flight: self.inner.hard_max_in_flight,
                ..V3AdaptiveConcurrencyState::default()
            });
        let hard_max = shared.hard_max_in_flight;
        let notify = shared.notify.clone();
        states
            .entry(V3ConcurrencyBucketKey::new(provider_key, scope))
            .or_insert_with(|| V3AdaptiveConcurrencyState {
                budget: hard_max,
                hard_max_in_flight: hard_max,
                notify,
                ..V3AdaptiveConcurrencyState::default()
            })
    }

    pub fn process_shared() -> Self {
        static SHARED: OnceLock<V3AdaptiveConcurrencyController> = OnceLock::new();
        SHARED
            .get_or_init(|| {
                Self::new(V3_DEFAULT_PROVIDER_MAX_IN_FLIGHT)
                    .expect("adaptive concurrency default budget is valid")
            })
            .clone()
    }

    pub fn new(initial_budget: u32) -> Result<Self, String> {
        Self::new_with_limits(initial_budget, initial_budget)
    }

    fn new_with_limits(initial_budget: u32, hard_max_in_flight: u32) -> Result<Self, String> {
        if initial_budget == 0 || hard_max_in_flight < initial_budget {
            return Err(
                "adaptive concurrency budget must be positive and not exceed its hard maximum"
                    .to_string(),
            );
        }
        Ok(Self {
            inner: Arc::new(V3AdaptiveConcurrencyInner {
                states: Mutex::new(BTreeMap::new()),
                initial_budget,
                hard_max_in_flight,
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
        let shared_key = V3ConcurrencyBucketKey::new(provider_key, None);
        states
            .entry(shared_key)
            .or_insert_with(|| V3AdaptiveConcurrencyState {
                budget: initial_budget,
                hard_max_in_flight: initial_budget,
                ..V3AdaptiveConcurrencyState::default()
            });
        for (_, state) in states
            .iter_mut()
            .filter(|(key, _)| key.provider_key == provider_key)
        {
            state.hard_max_in_flight = initial_budget;
            state.budget = state.budget.min(initial_budget);
        }
        Ok(())
    }

    pub async fn acquire(
        &self,
        provider_key: impl Into<String>,
        now_ms: u64,
    ) -> V3AdaptiveConcurrencyLease {
        self.acquire_with_clock(provider_key, || now_ms).await
    }

    pub async fn acquire_with_timeout(
        &self,
        provider_key: impl Into<String>,
        now_ms: u64,
        timeout: Duration,
    ) -> Result<V3AdaptiveConcurrencyLease, ()> {
        tokio::time::timeout(timeout, self.acquire(provider_key, now_ms))
            .await
            .map_err(|_| ())
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
            let notify = {
                let mut states = self
                    .inner
                    .states
                    .lock()
                    .expect("adaptive concurrency state lock should not be poisoned");
                let state = self.state_mut(&mut states, &provider_key, None);
                state.notify.clone()
            };
            let notified = notify.notified();
            if let Some(lease) = self.try_acquire(&provider_key, now_ms()) {
                return lease;
            }
            notified.await;
        }
    }

    /// Observe only the named capacity owners; never acquire a business lease.
    pub async fn wait_for_capacity_change(&self, provider_keys: &[String]) {
        let keys: Vec<_> = provider_keys
            .iter()
            .map(|key| (key.clone(), None))
            .collect();
        self.wait_for_scoped_capacity_change(&keys).await;
    }

    pub async fn wait_for_scoped_capacity_change(
        &self,
        keys: &[(String, Option<V3ConcurrencyIdentityScope>)],
    ) {
        let notifications = {
            let states = self
                .inner
                .states
                .lock()
                .expect("adaptive concurrency state lock should not be poisoned");
            let mut notifications = Vec::new();
            for (provider_key, scope) in keys {
                let Some(state) =
                    states.get(&V3ConcurrencyBucketKey::new(provider_key, scope.as_ref()))
                else {
                    return;
                };
                notifications.push(Box::pin(state.notify.clone().notified_owned()));
            }
            notifications
        };
        if notifications.is_empty() {
            return futures_util::future::pending().await;
        }
        let mut notifications = notifications;
        for notification in &mut notifications {
            notification.as_mut().enable();
        }
        // Registration precedes this check so a release between either step
        // cannot be lost. The following selection still owns actual admission.
        let available = {
            let states = self
                .inner
                .states
                .lock()
                .expect("adaptive concurrency state lock should not be poisoned");
            keys.iter().any(|(provider_key, scope)| {
                states
                    .get(&V3ConcurrencyBucketKey::new(provider_key, scope.as_ref()))
                    .is_none_or(|state| {
                        Self::total_in_flight(&states, provider_key) < state.hard_max_in_flight
                            && state.in_flight < state.budget
                    })
            })
        };
        if available {
            return;
        }
        futures_util::future::select_all(notifications).await;
    }

    pub fn try_acquire(
        &self,
        provider_key: &str,
        now_ms: u64,
    ) -> Option<V3AdaptiveConcurrencyLease> {
        self.try_acquire_scoped(provider_key, None, now_ms)
    }

    pub fn try_acquire_scoped(
        &self,
        provider_key: &str,
        scope: Option<&V3ConcurrencyIdentityScope>,
        now_ms: u64,
    ) -> Option<V3AdaptiveConcurrencyLease> {
        self.try_acquire_business_scoped(provider_key, scope)
            .or_else(|| self.try_acquire_probe_for_scope(provider_key, scope, now_ms, false))
    }

    pub fn try_acquire_scheduled_probe(
        &self,
        provider_key: &str,
        now_ms: u64,
    ) -> Option<V3AdaptiveConcurrencyLease> {
        self.try_acquire_probe_for_scope(provider_key, None, now_ms, true)
    }

    pub fn try_acquire_business(&self, provider_key: &str) -> Option<V3AdaptiveConcurrencyLease> {
        self.try_acquire_business_scoped(provider_key, None)
    }

    pub fn try_acquire_business_scoped(
        &self,
        provider_key: &str,
        scope: Option<&V3ConcurrencyIdentityScope>,
    ) -> Option<V3AdaptiveConcurrencyLease> {
        let mut states = self
            .inner
            .states
            .lock()
            .expect("adaptive concurrency state lock should not be poisoned");
        let total_in_flight = Self::total_in_flight(&states, provider_key);
        let state = self.state_mut(&mut states, provider_key, scope);
        if state.in_flight < state.budget && total_in_flight < state.hard_max_in_flight {
            state.in_flight = state.in_flight.saturating_add(1);
            return Some(V3AdaptiveConcurrencyLease {
                admission: V3AdaptiveConcurrencyAdmission::Lease,
                permit: V3AdaptiveConcurrencyPermit {
                    provider_key: provider_key.to_string(),
                    identity_scope: scope.cloned(),
                    probe: false,
                },
                controller: self.clone(),
            });
        }
        None
    }

    pub fn try_acquire_probe(
        &self,
        provider_key: &str,
        now_ms: u64,
    ) -> Option<V3AdaptiveConcurrencyLease> {
        self.try_acquire_probe_for_scope(provider_key, None, now_ms, false)
    }

    fn try_acquire_probe_for_scope(
        &self,
        provider_key: &str,
        scope: Option<&V3ConcurrencyIdentityScope>,
        now_ms: u64,
        scheduled_only: bool,
    ) -> Option<V3AdaptiveConcurrencyLease> {
        let mut states = self
            .inner
            .states
            .lock()
            .expect("adaptive concurrency state lock should not be poisoned");
        let total_in_flight = Self::total_in_flight(&states, provider_key);
        let state = self.state_mut(&mut states, provider_key, scope);
        if !scheduled_only
            && !state.saturated
            && !state.probe_in_flight
            && state.in_flight >= state.budget
            && total_in_flight < state.hard_max_in_flight
        {
            state.probe_in_flight = true;
            state.in_flight = state.in_flight.saturating_add(1);
            return Some(V3AdaptiveConcurrencyLease {
                admission: V3AdaptiveConcurrencyAdmission::Probe,
                permit: V3AdaptiveConcurrencyPermit {
                    provider_key: provider_key.to_string(),
                    identity_scope: scope.cloned(),
                    probe: true,
                },
                controller: self.clone(),
            });
        }
        if state.saturated
            && !state.probe_in_flight
            && state.in_flight >= state.budget
            && total_in_flight < state.hard_max_in_flight
            && state.next_probe_at_ms.is_some_and(|next| now_ms >= next)
        {
            state.probe_in_flight = true;
            state.in_flight = state.in_flight.saturating_add(1);
            return Some(V3AdaptiveConcurrencyLease {
                admission: V3AdaptiveConcurrencyAdmission::Probe,
                permit: V3AdaptiveConcurrencyPermit {
                    provider_key: provider_key.to_string(),
                    identity_scope: scope.cloned(),
                    probe: true,
                },
                controller: self.clone(),
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
            .get_mut(&V3ConcurrencyBucketKey::new(
                &permit.provider_key,
                permit.identity_scope.as_ref(),
            ))
            .ok_or_else(|| "adaptive concurrency provider key is missing".to_string())?;
        if !state.probe_in_flight || state.in_flight == 0 {
            return Err("adaptive concurrency probe is not in flight".to_string());
        }
        // Capture the concurrency the probe was admitted at before releasing its
        // own lease: a rate-limited probe refused exactly that in-flight count.
        let probe_level = state.in_flight;
        state.probe_in_flight = false;
        state.in_flight -= 1;
        match result {
            V3AdaptiveConcurrencyProbeResult::Accepted => {
                Self::prune_rate_limit_samples(state, now_ms);
                state.budget = state
                    .budget
                    .saturating_add(1)
                    .min(state.hard_max_in_flight)
                    .max(1);
                state.saturated = false;
                state.next_probe_at_ms = None;
            }
            V3AdaptiveConcurrencyProbeResult::RateLimited => {
                Self::record_rate_limit_sample(state, now_ms, probe_level);
                let smoothed = Self::smoothed_budget(state);
                state.budget = state.budget.min(smoothed).max(1);
                state.saturated = true;
                state.next_probe_at_ms =
                    Some(now_ms.saturating_add(V3_PROVIDER_CONCURRENCY_PROBE_INTERVAL_MS));
            }
        }
        let notify = state.notify.clone();
        drop(states);
        notify.notify_waiters();
        Ok(())
    }

    pub fn observe_rate_limit(&self, provider_key: &str, now_ms: u64) -> Result<(), String> {
        self.observe_rate_limit_scoped(provider_key, None, now_ms)
    }

    pub fn observe_rate_limit_scoped(
        &self,
        provider_key: &str,
        scope: Option<&V3ConcurrencyIdentityScope>,
        now_ms: u64,
    ) -> Result<(), String> {
        let mut states = self
            .inner
            .states
            .lock()
            .expect("adaptive concurrency state lock should not be poisoned");
        let state = states
            .get_mut(&V3ConcurrencyBucketKey::new(provider_key, scope))
            .ok_or_else(|| "adaptive concurrency provider key is missing".to_string())?;
        Self::record_rate_limit_sample(state, now_ms, state.in_flight);
        let smoothed = Self::smoothed_budget(state);
        state.budget = state.budget.min(smoothed).max(1);
        state.saturated = true;
        state.next_probe_at_ms =
            Some(now_ms.saturating_add(V3_PROVIDER_CONCURRENCY_PROBE_INTERVAL_MS));
        let notify = state.notify.clone();
        drop(states);
        notify.notify_waiters();
        Ok(())
    }

    /// Record the concurrency level the provider refused, then drop samples that
    /// fell out of the trailing one-hour window. The in-flight count includes the
    /// request that received the 429, so it is the true refused watermark.
    fn record_rate_limit_sample(
        state: &mut V3AdaptiveConcurrencyState,
        now_ms: u64,
        refused_in_flight: u32,
    ) {
        state
            .rate_limit_samples
            .push_back(V3AdaptiveConcurrencyRateLimitSample {
                epoch_ms: now_ms,
                in_flight_at_429: refused_in_flight.max(1),
            });
        Self::prune_rate_limit_samples(state, now_ms);
    }

    fn prune_rate_limit_samples(state: &mut V3AdaptiveConcurrencyState, now_ms: u64) {
        let window_start = now_ms.saturating_sub(V3_ADAPTIVE_CONCURRENCY_SAMPLE_WINDOW_MS);
        while state
            .rate_limit_samples
            .front()
            .is_some_and(|sample| sample.epoch_ms < window_start)
        {
            state.rate_limit_samples.pop_front();
        }
    }

    /// Adaptive budget ceiling implied by the trailing one-hour 429 samples.
    ///
    /// No sample means the provider accepted this concurrency for the whole
    /// window, so the configured hard maximum is allowed again. A sample means
    /// the provider refused that in-flight count, so the ceiling stays one slot
    /// below it. Multiple samples use the median so one outlier (for example a
    /// single-request key-level limit) cannot collapse the budget.
    fn smoothed_budget(state: &V3AdaptiveConcurrencyState) -> u32 {
        let hard_max = state.hard_max_in_flight.max(1);
        if state.rate_limit_samples.is_empty() {
            return hard_max;
        }
        let mut levels = state
            .rate_limit_samples
            .iter()
            .map(|sample| sample.in_flight_at_429)
            .collect::<Vec<_>>();
        levels.sort_unstable();
        let refused_level = if levels.len() % 2 == 1 {
            u64::from(levels[levels.len() / 2])
        } else {
            let upper = u64::from(levels[levels.len() / 2]);
            let lower = u64::from(levels[levels.len() / 2 - 1]);
            (lower + upper) / 2
        };
        let refused_level = u32::try_from(refused_level).unwrap_or(u32::MAX);
        refused_level.saturating_sub(1).clamp(1, hard_max)
    }

    /// A completed business 2xx is the recovery counterpart of an observed 429.
    /// It restores one unit of adaptive budget and clears the saturation window.
    /// Keys without tracked state have nothing to restore.
    pub fn observe_business_success(&self, provider_key: &str, now_ms: u64) -> Result<(), String> {
        self.observe_business_success_scoped(provider_key, None, now_ms)
    }

    pub fn observe_business_success_scoped(
        &self,
        provider_key: &str,
        scope: Option<&V3ConcurrencyIdentityScope>,
        now_ms: u64,
    ) -> Result<(), String> {
        let mut states = self
            .inner
            .states
            .lock()
            .expect("adaptive concurrency state lock should not be poisoned");
        let Some(state) = states.get_mut(&V3ConcurrencyBucketKey::new(provider_key, scope)) else {
            return Ok(());
        };
        Self::prune_rate_limit_samples(state, now_ms);
        state.budget = state
            .budget
            .saturating_add(1)
            .min(state.hard_max_in_flight)
            .max(1);
        state.saturated = false;
        state.next_probe_at_ms = None;
        let notify = state.notify.clone();
        drop(states);
        notify.notify_waiters();
        Ok(())
    }

    pub fn release(&self, permit: V3AdaptiveConcurrencyPermit) -> Result<(), String> {
        let mut states = self
            .inner
            .states
            .lock()
            .expect("adaptive concurrency state lock should not be poisoned");
        let state = states
            .get_mut(&V3ConcurrencyBucketKey::new(
                &permit.provider_key,
                permit.identity_scope.as_ref(),
            ))
            .ok_or_else(|| "adaptive concurrency provider key is missing".to_string())?;
        if state.in_flight == 0 {
            return Err("adaptive concurrency lease underflow".to_string());
        }
        state.in_flight -= 1;
        if permit.probe {
            state.probe_in_flight = false;
        }
        let notify = state.notify.clone();
        drop(states);
        notify.notify_waiters();
        Ok(())
    }

    pub fn snapshot(&self, provider_key: &str) -> Option<V3AdaptiveConcurrencySnapshot> {
        self.snapshot_for_scope(provider_key, None)
    }

    pub fn snapshot_for_scope(
        &self,
        provider_key: &str,
        scope: Option<&V3ConcurrencyIdentityScope>,
    ) -> Option<V3AdaptiveConcurrencySnapshot> {
        let states = self
            .inner
            .states
            .lock()
            .expect("adaptive concurrency state lock should not be poisoned");
        states
            .get(&V3ConcurrencyBucketKey::new(provider_key, scope))
            .map(|state| V3AdaptiveConcurrencySnapshot {
                provider_key: provider_key.to_string(),
                identity_scope: scope.cloned(),
                total_provider_in_flight: Self::total_in_flight(&states, provider_key),
                budget: state.budget,
                in_flight: if scope.is_some() {
                    state.in_flight
                } else {
                    Self::total_in_flight(&states, provider_key)
                },
                saturated: state.saturated,
                probe_in_flight: state.probe_in_flight,
                next_probe_at_ms: state.next_probe_at_ms,
                hard_max_in_flight: state.hard_max_in_flight,
                rate_limit_samples: state.rate_limit_samples.len(),
                smoothed_budget: Self::smoothed_budget(state),
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn identity(interface_id: &str, model_id: &str) -> V3ConcurrencyIdentityScope {
        V3ConcurrencyIdentityScope {
            interface_id: interface_id.into(),
            model_id: model_id.into(),
        }
    }

    #[test]
    fn identity_watermarks_preserve_siblings_and_one_shared_hard_ceiling() {
        let controller = V3AdaptiveConcurrencyController::new(8).unwrap();
        let key = "provider:key";
        let a = identity("responses", "a");
        let b = identity("responses", "b");
        let other_interface = identity("chat", "a");
        let a_leases: Vec<_> = (0..2)
            .map(|_| {
                controller
                    .try_acquire_business_scoped(key, Some(&a))
                    .unwrap()
            })
            .collect();
        let mut b_leases: Vec<_> = (0..4)
            .map(|_| {
                controller
                    .try_acquire_business_scoped(key, Some(&b))
                    .unwrap()
            })
            .collect();
        controller
            .observe_rate_limit_scoped(key, Some(&a), 1000)
            .unwrap();
        let refused = controller.snapshot_for_scope(key, Some(&a)).unwrap();
        assert_eq!(refused.rate_limit_samples, 1);
        assert_eq!(
            refused.smoothed_budget, 1,
            "sample is A's two leases, not all six provider leases"
        );
        assert_eq!(refused.budget, 1);
        for lease in a_leases {
            controller.release(lease.into_permit()).unwrap();
        }
        for _ in 0..4 {
            b_leases.push(
                controller
                    .try_acquire_business_scoped(key, Some(&b))
                    .unwrap(),
            );
        }
        assert_eq!(
            controller
                .snapshot_for_scope(key, Some(&b))
                .unwrap()
                .in_flight,
            8
        );
        assert!(
            controller
                .try_acquire_business_scoped(key, Some(&a))
                .is_none(),
            "models cannot multiply the shared ceiling"
        );
        assert!(controller
            .try_acquire_business_scoped(key, Some(&other_interface))
            .is_none());
        for lease in b_leases {
            controller.release(lease.into_permit()).unwrap();
        }
        let leases: Vec<_> = (0..8)
            .map(|_| {
                controller
                    .try_acquire_business_scoped(key, Some(&other_interface))
                    .unwrap()
            })
            .collect();
        assert_eq!(
            controller
                .snapshot_for_scope(key, Some(&other_interface))
                .unwrap()
                .budget,
            8
        );
        assert_eq!(
            controller.snapshot(key).unwrap().total_provider_in_flight,
            8
        );
        for lease in leases {
            controller.release(lease.into_permit()).unwrap();
        }
        controller
            .observe_business_success_scoped(key, Some(&b), 1001)
            .unwrap();
        assert_eq!(
            controller.snapshot_for_scope(key, Some(&a)).unwrap().budget,
            1
        );
        controller
            .observe_business_success_scoped(key, Some(&a), 1002)
            .unwrap();
        assert_eq!(
            controller.snapshot_for_scope(key, Some(&a)).unwrap().budget,
            2
        );
        assert!(
            !controller
                .snapshot_for_scope(key, Some(&a))
                .unwrap()
                .saturated
        );
    }

    #[test]
    fn unscoped_legacy_429_cannot_contract_declared_identity_capacity() {
        let controller = V3AdaptiveConcurrencyController::new(4).unwrap();
        let key = "provider:key";
        let legacy = controller.try_acquire_business(key).unwrap();
        controller.observe_rate_limit(key, 1000).unwrap();
        controller.release(legacy.into_permit()).unwrap();
        assert_eq!(controller.snapshot(key).unwrap().budget, 1);
        let scope = identity("responses", "a");
        let leases: Vec<_> = (0..4)
            .map(|_| {
                controller
                    .try_acquire_business_scoped(key, Some(&scope))
                    .unwrap()
            })
            .collect();
        assert!(
            controller.try_acquire_business(key).is_none(),
            "legacy calls also obey the shared hard ceiling"
        );
        for lease in leases {
            controller.release(lease.into_permit()).unwrap();
        }
        assert_eq!(
            controller.snapshot(key).unwrap().total_provider_in_flight,
            0
        );
    }

    #[tokio::test]
    async fn cancelled_scoped_guard_releases_once_and_wakes_another_identity() {
        let controller = V3AdaptiveConcurrencyController::new(1).unwrap();
        let key = "provider:key";
        let a = identity("responses", "a");
        let b = identity("responses", "b");
        let lease = controller
            .try_acquire_business_scoped(key, Some(&a))
            .unwrap();
        assert!(controller
            .try_acquire_business_scoped(key, Some(&b))
            .is_none());
        let owner = controller.clone();
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _guard = V3AdaptiveConcurrencyPermitGuard::new(owner, lease.into_permit());
            started_tx.send(()).unwrap();
            futures_util::future::pending::<()>().await;
        });
        started_rx.await.unwrap();
        let observer = controller.clone();
        let watched_b = b.clone();
        let waiter = tokio::spawn(async move {
            observer
                .wait_for_scoped_capacity_change(&[(key.into(), Some(watched_b))])
                .await;
        });
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            controller
                .snapshot_for_scope(key, Some(&a))
                .unwrap()
                .in_flight,
            0
        );
        let next = controller
            .try_acquire_business_scoped(key, Some(&b))
            .unwrap();
        drop(V3AdaptiveConcurrencyPermitGuard::new(
            controller.clone(),
            next.into_permit(),
        ));
        assert_eq!(
            controller.snapshot(key).unwrap().total_provider_in_flight,
            0
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn capacity_change_wait_is_scoped_and_never_acquires_a_lease() {
        let controller = V3AdaptiveConcurrencyController::new(1).unwrap();
        let held_a = controller.try_acquire_business("pool-a:key1").unwrap();
        let held_b = controller.try_acquire_business("pool-b:key1").unwrap();
        let watcher = controller.clone();
        let waiter = tokio::spawn(async move {
            watcher
                .wait_for_capacity_change(&["pool-a:key1".to_owned()])
                .await;
        });
        tokio::task::yield_now().await;
        controller.release(held_b.into_permit()).unwrap();
        tokio::task::yield_now().await;
        assert!(
            !waiter.is_finished(),
            "an unrelated key release must not wake this waiter"
        );
        assert_eq!(controller.snapshot("pool-a:key1").unwrap().in_flight, 1);
        controller.release(held_a.into_permit()).unwrap();
        tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            controller.snapshot("pool-a:key1").unwrap().in_flight,
            0,
            "waking for reselection must not reserve business capacity"
        );
    }

    #[tokio::test]
    async fn capacity_change_wait_observes_release_before_registration() {
        let controller = V3AdaptiveConcurrencyController::new(1).unwrap();
        let held = controller.try_acquire_business("released:key1").unwrap();
        controller.release(held.into_permit()).unwrap();
        tokio::time::timeout(
            Duration::from_secs(1),
            controller.wait_for_capacity_change(&["released:key1".to_owned()]),
        )
        .await
        .unwrap();
        assert_eq!(controller.snapshot("released:key1").unwrap().in_flight, 0);
    }

    #[test]
    fn rejects_zero_initial_budget() {
        assert!(V3AdaptiveConcurrencyController::new(0).is_err());
    }

    #[test]
    fn explicit_business_path_reports_busy_instead_of_spending_probe() {
        let controller = V3AdaptiveConcurrencyController::new_with_limits(2, 3).unwrap();
        let first = controller.try_acquire_business("opencode-go:key1").unwrap();
        let second = controller.try_acquire_business("opencode-go:key1").unwrap();
        assert!(!first.is_probe());
        assert!(!second.is_probe());
        assert!(controller
            .try_acquire_business("opencode-go:key1")
            .is_none());
        let probe = controller.try_acquire_probe("opencode-go:key1", 0).unwrap();
        assert!(probe.is_probe());
        assert!(controller
            .try_acquire_business("opencode-go:key1")
            .is_none());
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
    fn first_over_budget_request_is_a_probe_until_probe_completes() {
        let controller = V3AdaptiveConcurrencyController::new_with_limits(2, 3).unwrap();
        let first = controller.try_acquire("opencode-go:key1", 0).unwrap();
        let second = controller.try_acquire("opencode-go:key1", 0).unwrap();
        assert!(!first.is_probe());
        assert!(!second.is_probe());

        let probe = controller.try_acquire("opencode-go:key1", 0).unwrap();
        assert!(probe.is_probe());
        assert!(
            controller.try_acquire("opencode-go:key1", 0).is_none(),
            "additional requests must remain bounded while the expansion probe is in flight"
        );

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
    fn production_admission_can_consume_due_saturation_probe() {
        let controller = V3AdaptiveConcurrencyController::new_with_limits(1, 2).unwrap();
        let held = controller.try_acquire("opencode-go:key1", 0).unwrap();
        controller
            .observe_rate_limit("opencode-go:key1", 100)
            .unwrap();
        assert!(controller
            .try_acquire("opencode-go:key1", 600_099)
            .is_none());
        let probe = controller.try_acquire("opencode-go:key1", 600_100).unwrap();
        assert!(probe.is_probe());
        controller
            .complete_probe(
                probe.into_permit(),
                V3AdaptiveConcurrencyProbeResult::Accepted,
                600_100,
            )
            .unwrap();
        let snapshot = controller.snapshot("opencode-go:key1").unwrap();
        assert!(!snapshot.saturated);
        assert_eq!(snapshot.budget, 2);
        assert_eq!(snapshot.in_flight, 1);
        let expanded = controller
            .try_acquire_business("opencode-go:key1")
            .expect("successful probe budget expansion must admit business traffic");
        assert!(!expanded.is_probe());
        controller.release(expanded.into_permit()).unwrap();
        controller.release(held.into_permit()).unwrap();
    }

    #[test]
    fn upstream_429_confirms_saturation_and_reduces_budget() {
        let controller = V3AdaptiveConcurrencyController::new_with_limits(2, 3).unwrap();
        let first = controller.try_acquire("opencode-go:key1", 0).unwrap();
        let second = controller.try_acquire("opencode-go:key1", 0).unwrap();
        let probe = controller.try_acquire_probe("opencode-go:key1", 0).unwrap();
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
    fn business_success_restores_budget_drained_by_rate_limits() {
        let controller = V3AdaptiveConcurrencyController::new(8).unwrap();
        let key = "provider:key";
        controller.ensure_initial_budget(key, 8).unwrap();
        for _ in 0..7 {
            controller.observe_rate_limit(key, 0).unwrap();
        }
        let drained = controller.snapshot(key).unwrap();
        assert_eq!(drained.budget, 1);
        assert!(drained.saturated);
        // The drained budget plus one in-flight lease must report busy; a
        // completed business success must restore the next admission.
        let held = controller.try_acquire_business(key).unwrap();
        assert!(
            controller.try_acquire_business(key).is_none(),
            "drained budget with an in-flight lease must report busy"
        );
        controller.observe_business_success(key, 0).unwrap();
        let recovered = controller.snapshot(key).unwrap();
        assert_eq!(recovered.budget, 2);
        assert!(!recovered.saturated);
        assert_eq!(recovered.next_probe_at_ms, None);
        let admitted = controller
            .try_acquire_business(key)
            .expect("business success must admit the next request");
        controller.release(admitted.into_permit()).unwrap();
        controller.release(held.into_permit()).unwrap();
    }

    #[test]
    fn ten_minute_probe_reopens_budget_only_after_success() {
        let controller = V3AdaptiveConcurrencyController::new_with_limits(1, 2).unwrap();
        let lease = controller.try_acquire("opencode-go:key1", 0).unwrap();
        let probe = controller.try_acquire_probe("opencode-go:key1", 0);
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
            .try_acquire_probe("opencode-go:key1", 599_999)
            .is_none());
        let probe = controller
            .try_acquire_probe("opencode-go:key1", 600_000)
            .unwrap();
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
    fn scheduled_probe_never_exceeds_configured_provider_hard_maximum() {
        let controller = V3AdaptiveConcurrencyController::new(8).unwrap();
        let provider_key = "kdns:key1";
        controller.ensure_initial_budget(provider_key, 5).unwrap();
        let mut leases = (0..5)
            .map(|_| controller.try_acquire_business(provider_key).unwrap())
            .collect::<Vec<_>>();

        controller.observe_rate_limit(provider_key, 100).unwrap();
        assert!(
            controller
                .try_acquire_scheduled_probe(provider_key, 600_100)
                .is_none(),
            "a due probe must not send a sixth request while the provider hard limit is full"
        );

        controller.release(leases.remove(0).into_permit()).unwrap();
        let probe = controller
            .try_acquire_scheduled_probe(provider_key, 600_100)
            .expect("a due probe may use the released slot below the provider hard limit");
        assert!(probe.is_probe());
        assert_eq!(controller.snapshot(provider_key).unwrap().in_flight, 5);
        assert!(controller.try_acquire_business(provider_key).is_none());

        controller
            .complete_probe(
                probe.into_permit(),
                V3AdaptiveConcurrencyProbeResult::Accepted,
                600_100,
            )
            .unwrap();
        assert_eq!(controller.snapshot(provider_key).unwrap().budget, 5);
        assert_eq!(controller.snapshot(provider_key).unwrap().in_flight, 4);
        for lease in leases {
            controller.release(lease.into_permit()).unwrap();
        }
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

    #[tokio::test(flavor = "current_thread")]
    async fn saturated_admission_expires_without_leaking_a_lease() {
        let controller = V3AdaptiveConcurrencyController::new_with_limits(1, 2).unwrap();
        let held = controller.acquire("opencode-go:key1", 0).await;
        let probe = controller.try_acquire_probe("opencode-go:key1", 0).unwrap();
        assert!(probe.is_probe());

        let result = controller
            .acquire_with_timeout("opencode-go:key1", 0, Duration::from_millis(20))
            .await;
        assert!(result.is_err());
        assert_eq!(
            controller.snapshot("opencode-go:key1").unwrap().in_flight,
            2
        );

        controller.release(held.into_permit()).unwrap();
        controller.release(probe.into_permit()).unwrap();
        assert_eq!(
            controller.snapshot("opencode-go:key1").unwrap().in_flight,
            0
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn provider_scoped_notify_wakes_only_target_provider() {
        let controller = V3AdaptiveConcurrencyController::new_with_limits(1, 2).unwrap();
        let held_a = controller.acquire("opencode-go:key-a", 0).await;
        let probe_a = controller
            .try_acquire_probe("opencode-go:key-a", 0)
            .unwrap();
        assert!(probe_a.is_probe());
        let held_b = controller.acquire("opencode-go:key-b", 0).await;
        let probe_b = controller
            .try_acquire_probe("opencode-go:key-b", 0)
            .unwrap();
        assert!(probe_b.is_probe());

        let controller_a = controller.clone();
        let waiter_a =
            tokio::spawn(async move { controller_a.acquire("opencode-go:key-a", 0).await });
        let controller_b = controller.clone();
        let waiter_b =
            tokio::spawn(async move { controller_b.acquire("opencode-go:key-b", 0).await });
        tokio::task::yield_now().await;
        assert!(!waiter_a.is_finished());
        assert!(!waiter_b.is_finished());

        controller
            .complete_probe(
                probe_a.into_permit(),
                V3AdaptiveConcurrencyProbeResult::Accepted,
                0,
            )
            .unwrap();
        let lease_a = tokio::time::timeout(Duration::from_millis(100), waiter_a)
            .await
            .expect("provider A probe success must wake provider A waiter")
            .unwrap();
        assert_eq!(lease_a.provider_key(), "opencode-go:key-a");
        assert!(
            !waiter_b.is_finished(),
            "provider A probe success must not wake provider B waiter"
        );

        controller
            .complete_probe(
                probe_b.into_permit(),
                V3AdaptiveConcurrencyProbeResult::Accepted,
                0,
            )
            .unwrap();
        let lease_b = tokio::time::timeout(Duration::from_millis(100), waiter_b)
            .await
            .expect("provider B probe success must wake provider B waiter")
            .unwrap();
        assert_eq!(lease_b.provider_key(), "opencode-go:key-b");
        controller.release(held_a.into_permit()).unwrap();
        controller.release(held_b.into_permit()).unwrap();
        controller.release(lease_a.into_permit()).unwrap();
        controller.release(lease_b.into_permit()).unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn same_provider_releases_wake_registered_waiters_after_probe_completion() {
        let controller = V3AdaptiveConcurrencyController::new_with_limits(2, 3).unwrap();
        let held_first = controller.acquire("opencode-go:key1", 0).await;
        let held_second = controller.acquire("opencode-go:key1", 0).await;
        let probe = controller.try_acquire_probe("opencode-go:key1", 0).unwrap();
        assert!(probe.is_probe());

        let controller_first = controller.clone();
        let mut waiter_first =
            tokio::spawn(async move { controller_first.acquire("opencode-go:key1", 0).await });
        let controller_second = controller.clone();
        let mut waiter_second =
            tokio::spawn(async move { controller_second.acquire("opencode-go:key1", 0).await });
        tokio::task::yield_now().await;
        assert!(!waiter_first.is_finished());
        assert!(!waiter_second.is_finished());

        controller
            .complete_probe(
                probe.into_permit(),
                V3AdaptiveConcurrencyProbeResult::Accepted,
                0,
            )
            .unwrap();
        let (first_was_first_waiter, first) =
            tokio::time::timeout(Duration::from_millis(100), async {
                tokio::select! {
                    biased;
                    lease = &mut waiter_first => (true, lease.unwrap()),
                    lease = &mut waiter_second => (false, lease.unwrap()),
                }
            })
            .await
            .expect("successful probe must satisfy one registered waiter");

        controller.release(held_second.into_permit()).unwrap();
        controller.release(held_first.into_permit()).unwrap();
        let second = if first_was_first_waiter {
            tokio::time::timeout(Duration::from_millis(100), waiter_second)
                .await
                .expect("second release must satisfy the remaining registered waiter")
                .unwrap()
        } else {
            tokio::time::timeout(Duration::from_millis(100), waiter_first)
                .await
                .expect("second release must satisfy the remaining registered waiter")
                .unwrap()
        };
        controller.release(first.into_permit()).unwrap();
        controller.release(second.into_permit()).unwrap();
    }

    #[test]
    fn non_rate_limited_probe_release_resets_probe_state() {
        let controller = V3AdaptiveConcurrencyController::new_with_limits(2, 3).unwrap();
        let first = controller.try_acquire("opencode-go:key1", 0).unwrap();
        let second = controller.try_acquire("opencode-go:key1", 0).unwrap();
        let probe = controller.try_acquire_probe("opencode-go:key1", 0).unwrap();
        controller.release(first.into_permit()).unwrap();
        controller.release(second.into_permit()).unwrap();
        controller.release(probe.into_permit()).unwrap();
        let snapshot = controller.snapshot("opencode-go:key1").unwrap();
        assert_eq!(snapshot.in_flight, 0);
        assert!(
            !snapshot.probe_in_flight,
            "non-rate-limited probe failure must clear probe_in_flight"
        );
        let next = controller
            .try_acquire("opencode-go:key1", 0)
            .expect("probe release must reopen capacity");
        assert!(!next.is_probe());
        controller.release(next.into_permit()).unwrap();
    }

    #[test]
    fn probe_result_guard_finalizes_when_dropped_not_from_raw_ok() {
        let controller = V3AdaptiveConcurrencyController::new_with_limits(2, 3).unwrap();
        let first = controller.try_acquire("opencode-go:key1", 0).unwrap();
        let second = controller.try_acquire("opencode-go:key1", 0).unwrap();
        let probe = controller.try_acquire_probe("opencode-go:key1", 0).unwrap();
        controller.release(first.into_permit()).unwrap();
        controller.release(second.into_permit()).unwrap();

        let guard = V3AdaptiveConcurrencyPermitGuard::new(controller.clone(), probe.into_permit())
            .with_probe_result(V3AdaptiveConcurrencyProbeResult::Accepted);
        let active = controller.snapshot("opencode-go:key1").unwrap();
        assert_eq!(active.in_flight, 1);
        assert!(
            active.probe_in_flight,
            "probe must remain in flight while active stream owns the guard"
        );

        drop(guard);
        let after = controller.snapshot("opencode-go:key1").unwrap();
        assert_eq!(after.budget, 3);
        assert_eq!(after.in_flight, 0);
        assert!(!after.probe_in_flight);
    }

    #[tokio::test]
    async fn waiter_is_released_without_acquire_timeout() {
        let controller = V3AdaptiveConcurrencyController::new_with_limits(1, 2).unwrap();
        let held = controller.acquire("opencode-go:key1", 0).await;
        let probe = controller.try_acquire_probe("opencode-go:key1", 0).unwrap();
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
            .try_acquire_probe(
                "opencode-go:key1",
                V3_PROVIDER_CONCURRENCY_PROBE_INTERVAL_MS,
            )
            .unwrap();
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
                V3AdaptiveConcurrencyPermit {
                    provider_key: "opencode-go:key1".to_string(),
                    identity_scope: None,
                    probe: false,
                },
                V3AdaptiveConcurrencyProbeResult::Accepted,
                0,
            )
            .is_err());
        controller.release(lease.into_permit()).unwrap();
        assert!(controller
            .release(V3AdaptiveConcurrencyPermit {
                provider_key: "opencode-go:key1".to_string(),
                identity_scope: None,
                probe: false,
            })
            .is_err());
    }

    #[test]
    fn rate_limit_samples_the_in_flight_watermark_and_lowers_budget_below_it() {
        let controller = V3AdaptiveConcurrencyController::new_with_limits(20, 40).unwrap();
        let mut leases = Vec::new();
        for _ in 0..12 {
            leases.push(controller.try_acquire_business("opencode-go:key1").unwrap());
        }
        controller
            .observe_rate_limit("opencode-go:key1", 1_000)
            .unwrap();
        let snapshot = controller.snapshot("opencode-go:key1").unwrap();
        assert_eq!(snapshot.in_flight, 12);
        assert_eq!(snapshot.hard_max_in_flight, 40);
        assert_eq!(snapshot.rate_limit_samples, 1);
        assert_eq!(snapshot.smoothed_budget, 11);
        assert_eq!(
            snapshot.budget, 11,
            "a 429 at 12 concurrent must set budget to the refused watermark minus one"
        );
        for lease in leases {
            controller.release(lease.into_permit()).unwrap();
        }
    }

    #[test]
    fn rate_limit_window_drops_samples_older_than_one_hour() {
        let controller = V3AdaptiveConcurrencyController::new_with_limits(40, 40).unwrap();
        let first = (0..5)
            .map(|_| controller.try_acquire_business("opencode-go:key1").unwrap())
            .collect::<Vec<_>>();
        controller
            .observe_rate_limit("opencode-go:key1", 1_000)
            .unwrap();
        assert_eq!(controller.snapshot("opencode-go:key1").unwrap().budget, 4);
        for lease in first {
            controller.release(lease.into_permit()).unwrap();
        }

        let second = (0..3)
            .map(|_| controller.try_acquire_business("opencode-go:key1").unwrap())
            .collect::<Vec<_>>();
        controller
            .observe_rate_limit(
                "opencode-go:key1",
                1_000 + V3_ADAPTIVE_CONCURRENCY_SAMPLE_WINDOW_MS + 1,
            )
            .unwrap();
        let snapshot = controller.snapshot("opencode-go:key1").unwrap();
        assert_eq!(
            snapshot.rate_limit_samples, 1,
            "a sample older than one hour must be pruned from the window"
        );
        assert_eq!(snapshot.smoothed_budget, 2);
        assert_eq!(snapshot.budget, 2);
        for lease in second {
            controller.release(lease.into_permit()).unwrap();
        }
    }

    #[test]
    fn smoothed_budget_uses_the_median_of_the_hour_window() {
        let controller = V3AdaptiveConcurrencyController::new_with_limits(40, 40).unwrap();

        let first = (0..30)
            .map(|_| controller.try_acquire_business("opencode-go:key1").unwrap())
            .collect::<Vec<_>>();
        controller
            .observe_rate_limit("opencode-go:key1", 1_000)
            .unwrap();
        assert_eq!(controller.snapshot("opencode-go:key1").unwrap().budget, 29);
        for lease in first {
            controller.release(lease.into_permit()).unwrap();
        }

        let second = (0..6)
            .map(|_| controller.try_acquire_business("opencode-go:key1").unwrap())
            .collect::<Vec<_>>();
        controller
            .observe_rate_limit("opencode-go:key1", 2_000)
            .unwrap();
        for lease in second {
            controller.release(lease.into_permit()).unwrap();
        }

        let third = (0..8)
            .map(|_| controller.try_acquire_business("opencode-go:key1").unwrap())
            .collect::<Vec<_>>();
        controller
            .observe_rate_limit("opencode-go:key1", 3_000)
            .unwrap();
        let snapshot = controller.snapshot("opencode-go:key1").unwrap();
        assert_eq!(snapshot.rate_limit_samples, 3);
        assert_eq!(
            snapshot.smoothed_budget, 7,
            "median of [30, 6, 8] is 8, minus one slot; the 30 outlier must not collapse the budget"
        );
        assert_eq!(snapshot.budget, 7);
        for lease in third {
            controller.release(lease.into_permit()).unwrap();
        }
    }

    #[test]
    fn empty_window_restores_the_hard_max_as_smoothed_ceiling() {
        let controller = V3AdaptiveConcurrencyController::new_with_limits(40, 40).unwrap();
        let leases = (0..5)
            .map(|_| controller.try_acquire_business("opencode-go:key1").unwrap())
            .collect::<Vec<_>>();
        controller
            .observe_rate_limit("opencode-go:key1", 1_000)
            .unwrap();
        assert_eq!(controller.snapshot("opencode-go:key1").unwrap().budget, 4);
        for lease in leases {
            controller.release(lease.into_permit()).unwrap();
        }

        controller
            .observe_business_success(
                "opencode-go:key1",
                1_000 + V3_ADAPTIVE_CONCURRENCY_SAMPLE_WINDOW_MS + 1,
            )
            .unwrap();
        let snapshot = controller.snapshot("opencode-go:key1").unwrap();
        assert_eq!(snapshot.rate_limit_samples, 0);
        assert_eq!(
            snapshot.smoothed_budget, 40,
            "an empty one-hour window must allow the configured hard maximum again"
        );
        assert_eq!(snapshot.budget, 5);
    }

    #[test]
    fn budget_never_exceeds_hard_max_and_never_falls_below_one() {
        let controller = V3AdaptiveConcurrencyController::new_with_limits(1, 2).unwrap();
        let held = controller.try_acquire_business("opencode-go:key1").unwrap();
        controller
            .observe_rate_limit("opencode-go:key1", 1_000)
            .unwrap();
        assert_eq!(controller.snapshot("opencode-go:key1").unwrap().budget, 1);
        controller.release(held.into_permit()).unwrap();

        controller
            .observe_business_success("opencode-go:key1", 2_000)
            .unwrap();
        controller
            .observe_business_success("opencode-go:key1", 2_000)
            .unwrap();
        assert_eq!(
            controller.snapshot("opencode-go:key1").unwrap().budget,
            2,
            "repeated success must stop at the hard maximum"
        );

        let held = controller.try_acquire_business("opencode-go:key1").unwrap();
        controller
            .observe_rate_limit("opencode-go:key1", 3_000)
            .unwrap();
        assert_eq!(
            controller.snapshot("opencode-go:key1").unwrap().budget,
            1,
            "budget must never fall below one"
        );
        controller.release(held.into_permit()).unwrap();
    }

    #[test]
    fn rate_limit_samples_are_isolated_per_provider_key() {
        let controller = V3AdaptiveConcurrencyController::new_with_limits(40, 40).unwrap();

        let first = (0..20)
            .map(|_| {
                controller
                    .try_acquire_business("opencode-go:key-a")
                    .unwrap()
            })
            .collect::<Vec<_>>();
        controller
            .observe_rate_limit("opencode-go:key-a", 1_000)
            .unwrap();
        for lease in first {
            controller.release(lease.into_permit()).unwrap();
        }

        let second = (0..3)
            .map(|_| {
                controller
                    .try_acquire_business("opencode-go:key-b")
                    .unwrap()
            })
            .collect::<Vec<_>>();
        controller
            .observe_rate_limit("opencode-go:key-b", 1_000)
            .unwrap();
        for lease in second {
            controller.release(lease.into_permit()).unwrap();
        }

        let a = controller.snapshot("opencode-go:key-a").unwrap();
        let b = controller.snapshot("opencode-go:key-b").unwrap();
        assert_eq!(a.rate_limit_samples, 1);
        assert_eq!(a.smoothed_budget, 19);
        assert_eq!(a.budget, 19);
        assert_eq!(b.rate_limit_samples, 1);
        assert_eq!(b.smoothed_budget, 2);
        assert_eq!(b.budget, 2);
    }
}

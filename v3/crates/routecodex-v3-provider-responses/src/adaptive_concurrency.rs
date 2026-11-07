use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3AdaptiveConcurrencySnapshot {
    pub provider_key: String,
    pub identity_scope: Option<V3ConcurrencyIdentityScope>,
    pub total_provider_in_flight: u32,
    pub budget: u32,
    pub in_flight: u32,
    pub probe_in_flight: bool,
    /// Configured static ceiling, taken from `provider.concurrency.maxInFlight`.
    pub hard_max_in_flight: u32,
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
}

impl Drop for V3AdaptiveConcurrencyPermitGuard {
    fn drop(&mut self) {
        if let Some(permit) = self.permit.take() {
            if let Some(result) = self.probe_result.take() {
                self.controller
                    .complete_probe(permit, result)
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

#[derive(Debug)]
struct V3AdaptiveConcurrencyState {
    budget: u32,
    hard_max_in_flight: u32,
    in_flight: u32,
    probe_in_flight: bool,
    notify: Arc<Notify>,
}

impl Default for V3AdaptiveConcurrencyState {
    fn default() -> Self {
        Self {
            budget: 0,
            hard_max_in_flight: 0,
            in_flight: 0,
            probe_in_flight: false,
            notify: Arc::new(Notify::new()),
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

    pub(crate) fn new_with_limits(
        initial_budget: u32,
        hard_max_in_flight: u32,
    ) -> Result<Self, String> {
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

    pub async fn acquire(&self, provider_key: impl Into<String>) -> V3AdaptiveConcurrencyLease {
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
            if let Some(lease) = self.try_acquire(&provider_key) {
                return lease;
            }
            notified.await;
        }
    }

    pub async fn acquire_with_timeout(
        &self,
        provider_key: impl Into<String>,
        timeout: Duration,
    ) -> Result<V3AdaptiveConcurrencyLease, ()> {
        tokio::time::timeout(timeout, self.acquire(provider_key))
            .await
            .map_err(|_| ())
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

    pub fn try_acquire(&self, provider_key: &str) -> Option<V3AdaptiveConcurrencyLease> {
        self.try_acquire_scoped(provider_key, None)
    }

    pub fn try_acquire_scoped(
        &self,
        provider_key: &str,
        scope: Option<&V3ConcurrencyIdentityScope>,
    ) -> Option<V3AdaptiveConcurrencyLease> {
        self.try_acquire_business_scoped(provider_key, scope)
            .or_else(|| self.try_acquire_probe_for_scope(provider_key, scope))
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

    pub fn try_acquire_probe(&self, provider_key: &str) -> Option<V3AdaptiveConcurrencyLease> {
        self.try_acquire_probe_for_scope(provider_key, None)
    }

    fn try_acquire_probe_for_scope(
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
        if !state.probe_in_flight
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
        None
    }

    pub fn complete_probe(
        &self,
        permit: V3AdaptiveConcurrencyPermit,
        result: V3AdaptiveConcurrencyProbeResult,
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
        state.probe_in_flight = false;
        state.in_flight -= 1;
        match result {
            V3AdaptiveConcurrencyProbeResult::Accepted => {
                state.budget = state
                    .budget
                    .saturating_add(1)
                    .min(state.hard_max_in_flight)
                    .max(1);
            }
        }
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
                probe_in_flight: state.probe_in_flight,
                hard_max_in_flight: state.hard_max_in_flight,
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
    fn identity_scopes_share_the_configured_hard_ceiling_without_429_contraction() {
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
        let b_leases: Vec<_> = (0..4)
            .map(|_| {
                controller
                    .try_acquire_business_scoped(key, Some(&b))
                    .unwrap()
            })
            .collect();
        let other_leases: Vec<_> = (0..2)
            .map(|_| {
                controller
                    .try_acquire_business_scoped(key, Some(&other_interface))
                    .unwrap()
            })
            .collect();
        assert_eq!(
            controller
                .snapshot_for_scope(key, Some(&a))
                .unwrap()
                .budget,
            8,
            "a 429 observation never contracts the configured hard ceiling"
        );
        assert_eq!(
            controller.snapshot(key).unwrap().total_provider_in_flight,
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
        for lease in a_leases
            .into_iter()
            .chain(b_leases)
            .chain(other_leases)
        {
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
        let probe = controller.try_acquire_probe("opencode-go:key1").unwrap();
        assert!(probe.is_probe());
        assert!(controller
            .try_acquire_business("opencode-go:key1")
            .is_none());
        controller.release(first.into_permit()).unwrap();
        controller.release(second.into_permit()).unwrap();
        controller
            .complete_probe(probe.into_permit(), V3AdaptiveConcurrencyProbeResult::Accepted)
            .unwrap();
        assert_eq!(controller.snapshot("opencode-go:key1").unwrap().budget, 3);
    }

    #[test]
    fn first_over_budget_request_is_a_probe_until_probe_completes() {
        let controller = V3AdaptiveConcurrencyController::new_with_limits(2, 3).unwrap();
        let first = controller.try_acquire("opencode-go:key1").unwrap();
        let second = controller.try_acquire("opencode-go:key1").unwrap();
        assert!(!first.is_probe());
        assert!(!second.is_probe());

        let probe = controller.try_acquire("opencode-go:key1").unwrap();
        assert!(probe.is_probe());
        assert!(
            controller.try_acquire("opencode-go:key1").is_none(),
            "additional requests must remain bounded while the expansion probe is in flight"
        );

        controller.release(first.into_permit()).unwrap();
        controller.release(second.into_permit()).unwrap();
        controller
            .complete_probe(probe.into_permit(), V3AdaptiveConcurrencyProbeResult::Accepted)
            .unwrap();
        assert_eq!(controller.snapshot("opencode-go:key1").unwrap().budget, 3);
    }

    #[test]
    fn provider_keys_are_isolated() {
        let controller = V3AdaptiveConcurrencyController::new(1).unwrap();
        let key1 = controller.try_acquire("opencode-go:key1").unwrap();
        let key2 = controller.try_acquire("opencode-go:key2").unwrap();
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
    async fn exhausted_admission_expires_without_leaking_a_lease() {
        let controller = V3AdaptiveConcurrencyController::new_with_limits(1, 2).unwrap();
        let held = controller.acquire("opencode-go:key1").await;
        let probe = controller.try_acquire_probe("opencode-go:key1").unwrap();
        assert!(probe.is_probe());

        let result = controller
            .acquire_with_timeout("opencode-go:key1", Duration::from_millis(20))
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
        let held_a = controller.acquire("opencode-go:key-a").await;
        let probe_a = controller
            .try_acquire_probe("opencode-go:key-a")
            .unwrap();
        assert!(probe_a.is_probe());
        let held_b = controller.acquire("opencode-go:key-b").await;
        let probe_b = controller
            .try_acquire_probe("opencode-go:key-b")
            .unwrap();
        assert!(probe_b.is_probe());

        let controller_a = controller.clone();
        let waiter_a =
            tokio::spawn(async move { controller_a.acquire("opencode-go:key-a").await });
        let controller_b = controller.clone();
        let waiter_b =
            tokio::spawn(async move { controller_b.acquire("opencode-go:key-b").await });
        tokio::task::yield_now().await;
        assert!(!waiter_a.is_finished());
        assert!(!waiter_b.is_finished());

        controller
            .complete_probe(probe_a.into_permit(), V3AdaptiveConcurrencyProbeResult::Accepted)
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
            .complete_probe(probe_b.into_permit(), V3AdaptiveConcurrencyProbeResult::Accepted)
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
        let held_first = controller.acquire("opencode-go:key1").await;
        let held_second = controller.acquire("opencode-go:key1").await;
        let probe = controller.try_acquire_probe("opencode-go:key1").unwrap();
        assert!(probe.is_probe());

        let controller_first = controller.clone();
        let mut waiter_first =
            tokio::spawn(async move { controller_first.acquire("opencode-go:key1").await });
        let controller_second = controller.clone();
        let mut waiter_second =
            tokio::spawn(async move { controller_second.acquire("opencode-go:key1").await });
        tokio::task::yield_now().await;
        assert!(!waiter_first.is_finished());
        assert!(!waiter_second.is_finished());

        controller
            .complete_probe(probe.into_permit(), V3AdaptiveConcurrencyProbeResult::Accepted)
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
    fn probe_release_resets_probe_state() {
        let controller = V3AdaptiveConcurrencyController::new_with_limits(2, 3).unwrap();
        let first = controller.try_acquire("opencode-go:key1").unwrap();
        let second = controller.try_acquire("opencode-go:key1").unwrap();
        let probe = controller.try_acquire_probe("opencode-go:key1").unwrap();
        controller.release(first.into_permit()).unwrap();
        controller.release(second.into_permit()).unwrap();
        controller.release(probe.into_permit()).unwrap();
        let snapshot = controller.snapshot("opencode-go:key1").unwrap();
        assert_eq!(snapshot.in_flight, 0);
        assert!(
            !snapshot.probe_in_flight,
            "a probe that is dropped without a result must clear probe_in_flight"
        );
        let next = controller
            .try_acquire("opencode-go:key1")
            .expect("probe release must reopen capacity");
        assert!(!next.is_probe());
        controller.release(next.into_permit()).unwrap();
    }

    #[test]
    fn probe_result_guard_finalizes_when_dropped_not_from_raw_ok() {
        let controller = V3AdaptiveConcurrencyController::new_with_limits(2, 3).unwrap();
        let first = controller.try_acquire("opencode-go:key1").unwrap();
        let second = controller.try_acquire("opencode-go:key1").unwrap();
        let probe = controller.try_acquire_probe("opencode-go:key1").unwrap();
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

    #[test]
    fn rejects_invalid_probe_completion_and_lease_underflow() {
        let controller = V3AdaptiveConcurrencyController::new(1).unwrap();
        let lease = controller.try_acquire("opencode-go:key1").unwrap();
        assert!(controller
            .complete_probe(
                V3AdaptiveConcurrencyPermit {
                    provider_key: "opencode-go:key1".to_string(),
                    identity_scope: None,
                    probe: false,
                },
                V3AdaptiveConcurrencyProbeResult::Accepted,
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

}

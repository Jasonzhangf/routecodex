//! Traffic Governor Core — 跨进程流量治理器
//!
//! 独立于 Hub Pipeline 的基础设施组件。提供跨进程的 provider 流量控制：
//! - Concurrency 控制（maxInFlight）
//! - RPM 速率控制（requestsPerMinute）
//! - 自适应并发（基于 429/saturation 动态调整）
//!
//! MetadataCenter 作为唯一控制接口，不内建状态变量。

pub mod adaptive;
pub mod concurrency;
pub mod metadata;
pub mod rpm;
pub mod store;
pub mod types;

use adaptive::AdaptiveController;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use store::{now_ms, AdmissionAttempt, FileStateStore};
use types::*;

pub struct TrafficGovernor {
    adaptive: AdaptiveController,
    store: FileStateStore,
}

static PROCESS_SHARED_GOVERNORS: OnceLock<Mutex<HashMap<String, Arc<TrafficGovernor>>>> =
    OnceLock::new();

impl TrafficGovernor {
    pub fn new(store_root: &str) -> Self {
        Self {
            adaptive: AdaptiveController::new(),
            store: FileStateStore::new(store_root),
        }
    }

    pub fn process_shared(store_root: &str) -> Arc<Self> {
        let registry = PROCESS_SHARED_GOVERNORS.get_or_init(|| Mutex::new(HashMap::new()));
        let mut governors = registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Arc::clone(
            governors
                .entry(store_root.to_string())
                .or_insert_with(|| Arc::new(Self::new(store_root))),
        )
    }

    pub fn acquire(&self, ctx: &AcquireContext) -> Result<AcquireResult, GovernorError> {
        let config = self.read_traffic_config(ctx);
        validate_policy(&config)?;
        let started = Instant::now();

        loop {
            let now = now_ms();
            match self.store.try_acquire(ctx, &config, now)? {
                AdmissionAttempt::Admitted {
                    permit,
                    active_in_flight,
                    rpm_in_window,
                } => {
                    return Ok(AcquireResult {
                        permit,
                        policy: config,
                        waited_ms: elapsed_ms(started),
                        active_in_flight,
                        rpm_in_window,
                    });
                }
                AdmissionAttempt::Blocked(block) => {
                    let timeout_ms = match block.lane {
                        TrafficAdmissionLane::Concurrency => config.acquire_timeout_ms,
                        TrafficAdmissionLane::Rpm => config.rpm_timeout_ms,
                    };
                    let waited_ms = elapsed_ms(started);
                    if waited_ms >= timeout_ms {
                        return Err(GovernorError::AdmissionTimedOut(
                            TrafficAdmissionBackpressure {
                                code: "TRAFFIC_ADMISSION_BACKPRESSURE".to_string(),
                                lane: block.lane,
                                runtime_key: ctx.runtime_key.clone(),
                                state_key: block.state_key,
                                timeout_ms,
                                waited_ms,
                                current: block.current,
                                limit: block.limit,
                            },
                        ));
                    }
                    let timeout_remaining = timeout_ms.saturating_sub(waited_ms);
                    let state_change_remaining = block
                        .next_change_at_ms
                        .map(|change_at| change_at.saturating_sub(now))
                        .unwrap_or(timeout_remaining);
                    let wait_ms = timeout_remaining.min(state_change_remaining).max(1);
                    self.store
                        .wait_for_change(block.revision, Duration::from_millis(wait_ms));
                }
            }
        }
    }

    pub fn release(&self, permit: &Permit) -> Result<ReleaseResult, GovernorError> {
        let released = self.store.release_lease(permit)?;
        Ok(ReleaseResult {
            released,
            active_in_flight: self.store.active_count_for_state_key(&permit.state_key),
        })
    }

    pub fn observe_outcome(&self, event: &OutcomeEvent) {
        self.adaptive.observe(event);
    }

    pub fn is_at_capacity(&self, runtime_key: &str) -> bool {
        self.store.is_at_capacity(runtime_key, None, None)
    }

    pub fn is_at_capacity_in_scope(
        &self,
        runtime_key: &str,
        scope_key: Option<&str>,
        max_in_flight: Option<usize>,
    ) -> bool {
        self.store
            .is_at_capacity(runtime_key, scope_key, max_in_flight)
    }

    fn read_traffic_config(&self, ctx: &AcquireContext) -> TrafficPolicy {
        TrafficPolicy {
            max_in_flight: ctx.max_in_flight.unwrap_or(2),
            acquire_timeout_ms: ctx.acquire_timeout_ms.unwrap_or(60_000),
            stale_lease_ms: ctx.stale_lease_ms.unwrap_or(300_000),
            requests_per_minute: ctx.requests_per_minute.unwrap_or(120),
            rpm_timeout_ms: ctx.rpm_timeout_ms.unwrap_or(60_000),
            rpm_window_ms: ctx.rpm_window_ms.unwrap_or(60_000),
        }
    }
}

fn validate_policy(policy: &TrafficPolicy) -> Result<(), GovernorError> {
    if policy.max_in_flight == 0 {
        return Err(GovernorError::InvalidConfig(
            "max_in_flight must be greater than zero".to_string(),
        ));
    }
    if policy.requests_per_minute == 0 {
        return Err(GovernorError::InvalidConfig(
            "requests_per_minute must be greater than zero".to_string(),
        ));
    }
    for (field, value) in [
        ("acquire_timeout_ms", policy.acquire_timeout_ms),
        ("stale_lease_ms", policy.stale_lease_ms),
        ("rpm_timeout_ms", policy.rpm_timeout_ms),
        ("rpm_window_ms", policy.rpm_window_ms),
    ] {
        if value == 0 {
            return Err(GovernorError::InvalidConfig(format!(
                "{field} must be greater than zero"
            )));
        }
    }
    Ok(())
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod admission_lane_tests {
    use super::*;
    use std::thread;
    use std::time::{Duration, Instant};

    fn bounded_context(runtime_key: &str, request_id: &str) -> AcquireContext {
        let mut context = AcquireContext::new(runtime_key, request_id);
        context.max_in_flight = Some(1);
        context.acquire_timeout_ms = Some(250);
        context.stale_lease_ms = Some(500);
        context.requests_per_minute = Some(100);
        context.rpm_timeout_ms = Some(250);
        context.rpm_window_ms = Some(1_000);
        context
    }

    #[test]
    fn process_shared_handles_acquire_and_release_the_same_lease_truth() {
        let store_root = format!("/tmp/routecodex-traffic-shared-{}", uuid::Uuid::new_v4());
        let first = TrafficGovernor::process_shared(&store_root);
        let second = TrafficGovernor::process_shared(&store_root);
        let context = bounded_context("runtime:shared", "request:first");

        let acquired = first.acquire(&context).expect("first admission");
        assert!(second.is_at_capacity("runtime:shared"));

        let released = second.release(&acquired.permit).expect("shared release");
        assert!(released.released);
        assert_eq!(released.active_in_flight, 0);
        assert!(!first.is_at_capacity("runtime:shared"));
    }

    #[test]
    fn concurrency_saturation_waits_for_release_instead_of_failing_immediately() {
        let governor = TrafficGovernor::new("/tmp/routecodex-traffic-release-wait");
        let first_context = bounded_context("runtime:wait", "request:first");
        let first = governor.acquire(&first_context).expect("first admission");
        let governor = std::sync::Arc::new(governor);
        let waiter_governor = std::sync::Arc::clone(&governor);
        let waiter_context = bounded_context("runtime:wait", "request:waiter");
        let started = Instant::now();
        let waiter = thread::spawn(move || waiter_governor.acquire(&waiter_context));

        thread::sleep(Duration::from_millis(40));
        governor
            .release(&first.permit)
            .expect("release first lease");
        let admitted = waiter
            .join()
            .expect("waiter thread")
            .expect("waiter admission");

        assert!(started.elapsed() >= Duration::from_millis(35));
        assert!(admitted.waited_ms >= 35);
        assert_eq!(admitted.active_in_flight, 1);
    }

    #[test]
    fn concurrency_timeout_is_typed_backpressure_and_never_provider_429() {
        let governor = TrafficGovernor::new("/tmp/routecodex-traffic-timeout");
        let mut first_context = bounded_context("runtime:timeout", "request:first");
        first_context.stale_lease_ms = Some(1_000);
        governor.acquire(&first_context).expect("first admission");

        let mut waiter_context = bounded_context("runtime:timeout", "request:waiter");
        waiter_context.acquire_timeout_ms = Some(45);
        waiter_context.stale_lease_ms = Some(1_000);
        let started = Instant::now();
        let error = governor
            .acquire(&waiter_context)
            .expect_err("capacity must time out");

        assert!(started.elapsed() >= Duration::from_millis(40));
        match error {
            GovernorError::AdmissionTimedOut(ref backpressure) => {
                assert_eq!(backpressure.code, "TRAFFIC_ADMISSION_BACKPRESSURE");
                assert_eq!(backpressure.lane, TrafficAdmissionLane::Concurrency);
                assert_eq!(backpressure.timeout_ms, 45);
                assert!(backpressure.waited_ms >= 40);
            }
            other => panic!("expected typed admission backpressure, got {other}"),
        }
        assert!(!error.to_string().contains("429"));
    }

    #[test]
    fn stale_lease_expiry_admits_a_waiter_without_release() {
        let governor = TrafficGovernor::new("/tmp/routecodex-traffic-stale");
        let mut first_context = bounded_context("runtime:stale", "request:first");
        first_context.stale_lease_ms = Some(45);
        governor.acquire(&first_context).expect("first admission");

        let mut waiter_context = bounded_context("runtime:stale", "request:waiter");
        waiter_context.stale_lease_ms = Some(45);
        let started = Instant::now();
        let admitted = governor
            .acquire(&waiter_context)
            .expect("stale lease admission");

        assert!(started.elapsed() >= Duration::from_millis(40));
        assert!(admitted.waited_ms >= 40);
        assert_eq!(admitted.active_in_flight, 1);
    }

    #[test]
    fn rpm_window_blocks_then_admits_after_the_recorded_event_expires() {
        let governor = TrafficGovernor::new("/tmp/routecodex-traffic-rpm");
        let mut first_context = bounded_context("runtime:rpm", "request:first");
        first_context.requests_per_minute = Some(1);
        first_context.rpm_window_ms = Some(45);
        let first = governor.acquire(&first_context).expect("first admission");
        governor
            .release(&first.permit)
            .expect("release concurrency lease");

        let mut waiter_context = bounded_context("runtime:rpm", "request:waiter");
        waiter_context.requests_per_minute = Some(1);
        waiter_context.rpm_window_ms = Some(45);
        let started = Instant::now();
        let admitted = governor
            .acquire(&waiter_context)
            .expect("rpm-window admission");

        assert!(started.elapsed() >= Duration::from_millis(40));
        assert!(admitted.waited_ms >= 40);
        assert_eq!(admitted.rpm_in_window, 1);
    }
}

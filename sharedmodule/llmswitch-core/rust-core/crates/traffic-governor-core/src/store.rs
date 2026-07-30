//! Process-shared traffic admission state.
//!
//! Concurrency leases and RPM events live under one lock so capacity checks and
//! lease creation are one atomic state transition. A revisioned condition
//! variable lets blocked admissions wait without missing a concurrent release.

use crate::types::*;
use std::collections::HashMap;
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Debug)]
pub(crate) struct AdmissionBlock {
    pub lane: TrafficAdmissionLane,
    pub state_key: String,
    pub current: u64,
    pub limit: u64,
    pub next_change_at_ms: Option<u64>,
    pub revision: u64,
}

#[derive(Debug)]
pub(crate) enum AdmissionAttempt {
    Admitted {
        permit: Permit,
        active_in_flight: u32,
        rpm_in_window: u32,
    },
    Blocked(AdmissionBlock),
}

#[derive(Default)]
struct StoreState {
    lanes: HashMap<String, TrafficState>,
    policies: HashMap<String, TrafficPolicy>,
    revision: u64,
}

pub struct FileStateStore {
    state: Mutex<StoreState>,
    changed: Condvar,
}

impl FileStateStore {
    pub fn new(_root: &str) -> Self {
        Self {
            state: Mutex::new(StoreState::default()),
            changed: Condvar::new(),
        }
    }

    pub(crate) fn try_acquire(
        &self,
        ctx: &AcquireContext,
        policy: &TrafficPolicy,
        now: u64,
    ) -> Result<AdmissionAttempt, GovernorError> {
        let state_key = compose_key(&ctx.runtime_key, ctx.scope_key.as_deref());
        let mut store = self.lock_state();
        let revision = store.revision;
        let lane = store
            .lanes
            .entry(state_key.clone())
            .or_insert_with(TrafficState::empty);
        prune_lane(lane, policy, now);

        let active = lane.leases.len();
        if active >= policy.max_in_flight {
            return Ok(AdmissionAttempt::Blocked(AdmissionBlock {
                lane: TrafficAdmissionLane::Concurrency,
                state_key,
                current: active as u64,
                limit: policy.max_in_flight as u64,
                next_change_at_ms: lane.leases.iter().map(|lease| lease.expires_at).min(),
                revision,
            }));
        }

        let rpm_count = lane.rpm_events.len() as u32;
        if rpm_count >= policy.requests_per_minute {
            return Ok(AdmissionAttempt::Blocked(AdmissionBlock {
                lane: TrafficAdmissionLane::Rpm,
                state_key,
                current: rpm_count as u64,
                limit: policy.requests_per_minute as u64,
                next_change_at_ms: lane
                    .rpm_events
                    .iter()
                    .map(|event| event.started_at.saturating_add(policy.rpm_window_ms))
                    .min(),
                revision,
            }));
        }

        let lease_id = format!("lease-{}", uuid::Uuid::new_v4());
        let pid = std::process::id();
        let server_id = format!("pid-{pid}");
        let expires_at = now.saturating_add(policy.stale_lease_ms);
        lane.leases.push(TrafficLease {
            lease_id: lease_id.clone(),
            request_id: ctx.request_id.clone(),
            pid,
            server_id: server_id.clone(),
            started_at: now,
            expires_at,
        });
        lane.rpm_events.push(RpmEvent {
            request_id: ctx.request_id.clone(),
            started_at: now,
        });
        lane.updated_at = now;
        let active_in_flight = lane.leases.len().min(u32::MAX as usize) as u32;
        let rpm_in_window = lane.rpm_events.len().min(u32::MAX as usize) as u32;
        store.policies.insert(state_key.clone(), policy.clone());
        store.revision = store.revision.wrapping_add(1);

        Ok(AdmissionAttempt::Admitted {
            permit: Permit {
                runtime_key: ctx.runtime_key.clone(),
                provider_key: ctx.provider_key.clone(),
                request_id: ctx.request_id.clone(),
                lease_id,
                state_key,
                scope_key: ctx.scope_key.clone(),
                max_in_flight: policy.max_in_flight,
                pid,
                server_id,
                started_at: now,
                expires_at,
            },
            active_in_flight,
            rpm_in_window,
        })
    }

    pub(crate) fn wait_for_change(&self, revision: u64, wait: Duration) {
        if wait.is_zero() {
            return;
        }
        let guard = self.lock_state();
        if guard.revision != revision {
            return;
        }
        match self.changed.wait_timeout(guard, wait) {
            Ok(_) => {}
            Err(poisoned) => {
                drop(poisoned.into_inner());
            }
        }
    }

    pub fn active_lease_count(&self, key: &str) -> usize {
        let now = now_ms();
        let mut store = self.lock_state();
        let policy = store.policies.get(key).cloned();
        let Some(lane) = store.lanes.get_mut(key) else {
            return 0;
        };
        if let Some(policy) = policy.as_ref() {
            prune_lane(lane, policy, now);
        }
        lane.leases.len()
    }

    pub fn rpm_event_count(&self, key: &str, window_start: u64) -> u32 {
        let store = self.lock_state();
        store
            .lanes
            .get(key)
            .map(|lane| {
                lane.rpm_events
                    .iter()
                    .filter(|event| event.started_at >= window_start)
                    .count()
                    .min(u32::MAX as usize) as u32
            })
            .unwrap_or(0)
    }

    pub fn release_lease(&self, permit: &Permit) -> Result<bool, GovernorError> {
        let mut store = self.lock_state();
        let released = if let Some(lane) = store.lanes.get_mut(&permit.state_key) {
            let before = lane.leases.len();
            lane.leases.retain(|lease| {
                lease.lease_id != permit.lease_id || lease.request_id != permit.request_id
            });
            lane.updated_at = now_ms();
            lane.leases.len() < before
        } else {
            false
        };
        if released {
            store.revision = store.revision.wrapping_add(1);
            self.changed.notify_all();
        }
        Ok(released)
    }

    pub fn active_count_for_state_key(&self, state_key: &str) -> u32 {
        self.active_lease_count(state_key).min(u32::MAX as usize) as u32
    }

    pub fn is_at_capacity(
        &self,
        runtime_key: &str,
        scope_key: Option<&str>,
        max_in_flight: Option<usize>,
    ) -> bool {
        let state_key = compose_key(runtime_key, scope_key);
        let store = self.lock_state();
        let configured_limit = store
            .policies
            .get(&state_key)
            .map(|policy| policy.max_in_flight);
        drop(store);
        let limit = max_in_flight.or(configured_limit).unwrap_or(2);
        self.active_lease_count(&state_key) >= limit
    }

    fn lock_state(&self) -> MutexGuard<'_, StoreState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub(crate) fn compose_key(runtime_key: &str, scope_key: Option<&str>) -> String {
    match scope_key {
        Some(scope) if !scope.is_empty() => format!("{scope}::{runtime_key}"),
        _ => runtime_key.to_string(),
    }
}

fn prune_lane(lane: &mut TrafficState, policy: &TrafficPolicy, now: u64) {
    lane.leases.retain(|lease| lease.expires_at > now);
    lane.rpm_events
        .retain(|event| event.started_at.saturating_add(policy.rpm_window_ms) > now);
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_ctx(runtime: &str, request: &str) -> AcquireContext {
        AcquireContext::new(runtime, request)
    }

    fn acquire_once(
        store: &FileStateStore,
        context: &AcquireContext,
        policy: &TrafficPolicy,
    ) -> Permit {
        match store
            .try_acquire(context, policy, now_ms())
            .expect("admission attempt")
        {
            AdmissionAttempt::Admitted { permit, .. } => permit,
            AdmissionAttempt::Blocked(block) => {
                panic!("unexpected blocked admission in {} lane", block.lane)
            }
        }
    }

    #[test]
    fn create_release_and_count_share_one_state_key() {
        let store = FileStateStore::new("/tmp/traffic-test");
        let context = make_ctx("openai", "request:one");
        let policy = TrafficPolicy::default_multi();
        let permit = acquire_once(&store, &context, &policy);

        assert_eq!(store.active_lease_count("openai"), 1);
        assert!(store.release_lease(&permit).expect("release lease"));
        assert_eq!(store.active_lease_count("openai"), 0);
    }

    #[test]
    fn release_requires_the_matching_request_and_lease_identity() {
        let store = FileStateStore::new("/tmp/traffic-test");
        let context = make_ctx("openai", "request:one");
        let policy = TrafficPolicy::default_multi();
        let permit = acquire_once(&store, &context, &policy);
        let mut wrong_request = permit.clone();
        wrong_request.request_id = "request:other".to_string();

        assert!(!store
            .release_lease(&wrong_request)
            .expect("mismatched release"));
        assert_eq!(store.active_lease_count("openai"), 1);
        assert!(store.release_lease(&permit).expect("matching release"));
    }

    #[test]
    fn scope_keys_are_isolated() {
        let store = FileStateStore::new("/tmp/traffic-test");
        let mut context = make_ctx("openai", "request:one");
        context.scope_key = Some("port:5555".to_string());
        let permit = acquire_once(&store, &context, &TrafficPolicy::default_multi());

        assert_eq!(store.active_lease_count("openai"), 0);
        assert_eq!(store.active_lease_count("port:5555::openai"), 1);
        assert!(store.release_lease(&permit).expect("release scoped lease"));
    }
}

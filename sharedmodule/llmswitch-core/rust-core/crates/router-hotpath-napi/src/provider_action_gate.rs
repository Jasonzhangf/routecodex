//! Cross-request provider action admission owned next to ErrorErr05.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

pub const PROVIDER_ACTION_ISOLATED_DELAY_MS: u64 = 1_000;
pub const PROVIDER_ACTION_SUSTAINED_DELAY_MS: u64 = 5_000;
const PROVIDER_ACTION_IDLE_TTL_MS: u64 = 10 * 60_000;
const PROVIDER_ACTION_ACTIVE_POLL_MS: u64 = 50;

#[derive(Debug)]
struct ProviderActionGateState {
    lane_group_key: String,
    generation: u64,
    mode: ProviderActionGateMode,
    consecutive_failures: u64,
    waiters: VecDeque<ProviderActionWaitTicket>,
    next_admission_at: Instant,
    admitted_generation: Option<u64>,
    admitted_action_scope: Option<String>,
    updated_at: Instant,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProviderActionWaitTicket {
    waiter_id: String,
    action_scope_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ProviderActionGateMode {
    Isolated,
    Sustained,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderActionGateKeyInput {
    pub lane_key: String,
    #[serde(default)]
    pub lane_group_key: Option<String>,
    #[serde(default)]
    pub action_scope_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderActionWaitInput {
    pub lane_key: String,
    pub waiter_id: String,
    pub action_scope_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderActionTerminalCommitInput {
    pub lane_key: String,
    pub generation: u64,
    pub action_scope_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderActionAbandonInput {
    pub lane_key: String,
    pub generation: u64,
    pub action_scope_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderActionSuccessInput {
    pub lane_group_key: String,
    pub action_scope_key: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderActionResetInput {
    #[serde(default)]
    pub lane_key: Option<String>,
    #[serde(default)]
    pub lane_prefix: Option<String>,
    #[serde(default)]
    pub lane_group_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderActionFailureRecorded {
    pub generation: u64,
    pub mode: &'static str,
    pub minimum_delay_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderActionAdmissionPoll {
    pub state: &'static str,
    pub generation: u64,
    pub mode: &'static str,
    pub wait_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderActionTerminalCommit {
    pub committed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderActionSuccessRecorded {
    pub accepted: bool,
    pub removed_lanes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderActionGateContract {
    pub isolated_delay_ms: u64,
    pub sustained_delay_ms: u64,
    pub single_admission_per_generation: bool,
    pub explicit_admission_ownership: bool,
    pub wall_clock_expiry_forbidden: bool,
    pub waiter_order: &'static str,
    pub abandon_is_health_neutral: bool,
}

pub fn contract() -> ProviderActionGateContract {
    ProviderActionGateContract {
        isolated_delay_ms: PROVIDER_ACTION_ISOLATED_DELAY_MS,
        sustained_delay_ms: PROVIDER_ACTION_SUSTAINED_DELAY_MS,
        single_admission_per_generation: true,
        explicit_admission_ownership: true,
        wall_clock_expiry_forbidden: true,
        waiter_order: "fifo_ticket",
        abandon_is_health_neutral: true,
    }
}

fn states() -> &'static Mutex<HashMap<String, ProviderActionGateState>> {
    static STATES: OnceLock<Mutex<HashMap<String, ProviderActionGateState>>> = OnceLock::new();
    STATES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_states() -> Result<MutexGuard<'static, HashMap<String, ProviderActionGateState>>, String> {
    states()
        .lock()
        .map_err(|_| "provider action gate state lock is poisoned".to_string())
}

fn normalize_required(value: String, field: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("{field} must be non-empty"));
    }
    Ok(value.to_string())
}

fn mode_label(mode: ProviderActionGateMode) -> &'static str {
    match mode {
        ProviderActionGateMode::Isolated => "isolated",
        ProviderActionGateMode::Sustained => "sustained",
    }
}

fn mode_delay_ms(mode: ProviderActionGateMode) -> u64 {
    match mode {
        ProviderActionGateMode::Isolated => PROVIDER_ACTION_ISOLATED_DELAY_MS,
        ProviderActionGateMode::Sustained => PROVIDER_ACTION_SUSTAINED_DELAY_MS,
    }
}

fn remaining_ms(deadline: Instant, now: Instant) -> u64 {
    deadline
        .checked_duration_since(now)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn prune_idle(states: &mut HashMap<String, ProviderActionGateState>, now: Instant) {
    let ttl = Duration::from_millis(PROVIDER_ACTION_IDLE_TTL_MS);
    states.retain(|_, state| {
        !state.waiters.is_empty()
            || state.admitted_generation.is_some()
            || now.duration_since(state.updated_at) < ttl
    });
}

pub fn record_failure(
    input: ProviderActionGateKeyInput,
) -> Result<ProviderActionFailureRecorded, String> {
    let lane_key = normalize_required(input.lane_key, "laneKey")?;
    let lane_group_key = input
        .lane_group_key
        .map(|value| normalize_required(value, "laneGroupKey"))
        .transpose()?
        .unwrap_or_else(|| lane_key.clone());
    let action_scope_key = input
        .action_scope_key
        .map(|value| normalize_required(value, "actionScopeKey"))
        .transpose()?;
    let now = Instant::now();
    let mut states = lock_states()?;
    prune_idle(&mut states, now);
    let active_lane_generation = states
        .values()
        .filter(|state| state.lane_group_key == lane_group_key)
        .map(|state| state.generation)
        .max();
    let active_admission = states
        .values()
        .find(|state| {
            state.lane_group_key == lane_group_key
                && state.admitted_generation == Some(state.generation)
        })
        .map(|state| {
            (
                state.generation,
                state.admitted_action_scope.as_deref().map(str::to_string),
            )
        });
    let active_admission_owned = active_admission.is_some();
    let records_admitted_action_outcome =
        active_admission
            .as_ref()
            .is_some_and(|(_, admitted_scope)| {
                action_scope_key.as_ref().is_some()
                    && admitted_scope.as_ref() == action_scope_key.as_ref()
            });
    let active_group_failure = states
        .values()
        .any(|state| state.lane_group_key == lane_group_key && state.consecutive_failures > 0);
    if records_admitted_action_outcome {
        for state in states
            .values_mut()
            .filter(|state| state.lane_group_key == lane_group_key)
        {
            state.generation = state.generation.saturating_add(1);
            state.mode = ProviderActionGateMode::Sustained;
            state.next_admission_at =
                now + Duration::from_millis(PROVIDER_ACTION_SUSTAINED_DELAY_MS);
            state.admitted_generation = None;
            state.admitted_action_scope = None;
            state.updated_at = now;
        }
    } else if active_group_failure {
        for state in states
            .values_mut()
            .filter(|state| state.lane_group_key == lane_group_key)
        {
            state.mode = ProviderActionGateMode::Sustained;
            state.next_admission_at =
                now + Duration::from_millis(PROVIDER_ACTION_SUSTAINED_DELAY_MS);
            state.updated_at = now;
        }
    }
    let state = match states.get_mut(&lane_key) {
        Some(state) => {
            if !records_admitted_action_outcome && !active_admission_owned {
                state.generation = state.generation.saturating_add(1);
                state.admitted_generation = None;
                state.admitted_action_scope = None;
            }
            state
        }
        None => {
            let generation = match (
                active_lane_generation,
                active_admission_owned,
                records_admitted_action_outcome,
            ) {
                (Some(generation), true, false) => generation,
                (Some(generation), _, true) => generation.saturating_add(1),
                (Some(generation), false, false) => generation.saturating_add(1),
                (None, _, _) => 1,
            };
            states.insert(
                lane_key.clone(),
                ProviderActionGateState {
                    lane_group_key: lane_group_key.clone(),
                    generation,
                    mode: if active_group_failure {
                        ProviderActionGateMode::Sustained
                    } else {
                        ProviderActionGateMode::Isolated
                    },
                    consecutive_failures: 0,
                    waiters: VecDeque::new(),
                    next_admission_at: now,
                    admitted_generation: None,
                    admitted_action_scope: None,
                    updated_at: now,
                },
            );
            states
                .get_mut(&lane_key)
                .expect("provider action gate state was just inserted")
        }
    };
    state.consecutive_failures = state.consecutive_failures.saturating_add(1);
    state.mode =
        if state.consecutive_failures == 1 && !active_group_failure && !active_admission_owned {
            ProviderActionGateMode::Isolated
        } else {
            ProviderActionGateMode::Sustained
        };
    state.next_admission_at = now + Duration::from_millis(mode_delay_ms(state.mode));
    if !active_admission_owned || records_admitted_action_outcome {
        state.admitted_generation = None;
        state.admitted_action_scope = None;
    }
    state.updated_at = now;
    Ok(ProviderActionFailureRecorded {
        generation: state.generation,
        mode: mode_label(state.mode),
        minimum_delay_ms: mode_delay_ms(state.mode),
    })
}

pub fn begin_wait(input: ProviderActionWaitInput) -> Result<ProviderActionAdmissionPoll, String> {
    let lane_key = normalize_required(input.lane_key, "laneKey")?;
    let waiter_id = normalize_required(input.waiter_id, "waiterId")?;
    let action_scope_key = normalize_required(input.action_scope_key, "actionScopeKey")?;
    let now = Instant::now();
    let mut states = lock_states()?;
    let Some(state) = states.get_mut(&lane_key) else {
        return Ok(released_poll());
    };
    if let Some(ticket) = state
        .waiters
        .iter()
        .find(|ticket| ticket.waiter_id == waiter_id)
    {
        if ticket.action_scope_key != action_scope_key {
            return Err("provider action waiter action scope changed".to_string());
        }
    } else {
        state.waiters.push_back(ProviderActionWaitTicket {
            waiter_id,
            action_scope_key,
        });
    }
    if state.waiters.len() > 1 && state.mode == ProviderActionGateMode::Isolated {
        state.mode = ProviderActionGateMode::Sustained;
        state.next_admission_at = now + Duration::from_millis(PROVIDER_ACTION_SUSTAINED_DELAY_MS);
    }
    state.updated_at = now;
    Ok(wait_poll(state, now))
}

pub fn poll_admission(
    input: ProviderActionWaitInput,
) -> Result<ProviderActionAdmissionPoll, String> {
    let lane_key = normalize_required(input.lane_key, "laneKey")?;
    let waiter_id = normalize_required(input.waiter_id, "waiterId")?;
    let action_scope_key = normalize_required(input.action_scope_key, "actionScopeKey")?;
    let now = Instant::now();
    let mut states = lock_states()?;
    let lane_group_key = match states.get(&lane_key) {
        Some(state) => state.lane_group_key.clone(),
        None => return Ok(released_poll()),
    };
    let group_has_active_admission = states.values().any(|state| {
        state.lane_group_key == lane_group_key
            && state.admitted_generation == Some(state.generation)
    });
    let (lane_group_key, admission) = {
        let Some(state) = states.get_mut(&lane_key) else {
            return Ok(released_poll());
        };
        let Some(ticket) = state
            .waiters
            .iter()
            .find(|ticket| ticket.waiter_id == waiter_id)
        else {
            return Err("provider action waiter is not registered".to_string());
        };
        if ticket.action_scope_key != action_scope_key {
            return Err("provider action waiter action scope changed".to_string());
        }
        if group_has_active_admission
            || state
                .waiters
                .front()
                .is_none_or(|ticket| ticket.waiter_id != waiter_id)
        {
            state.updated_at = now;
            return Ok(ProviderActionAdmissionPoll {
                state: "wait",
                generation: state.generation,
                mode: mode_label(state.mode),
                wait_ms: remaining_ms(state.next_admission_at, now)
                    .max(PROVIDER_ACTION_ACTIVE_POLL_MS),
            });
        }
        let wait_ms = remaining_ms(state.next_admission_at, now);
        if wait_ms > 0 {
            state.updated_at = now;
            return Ok(wait_poll(state, now));
        }
        state.admitted_generation = Some(state.generation);
        state.admitted_action_scope = Some(action_scope_key.clone());
        state.next_admission_at = now + Duration::from_millis(PROVIDER_ACTION_SUSTAINED_DELAY_MS);
        remove_waiter(state, &waiter_id, &action_scope_key);
        state.updated_at = now;
        (
            state.lane_group_key.clone(),
            ProviderActionAdmissionPoll {
                state: "admitted",
                generation: state.generation,
                mode: mode_label(state.mode),
                wait_ms: 0,
            },
        )
    };
    for (key, sibling) in states.iter_mut().filter(|(key, sibling)| {
        *key != &lane_key
            && sibling.lane_group_key == lane_group_key
            && sibling.consecutive_failures > 0
    }) {
        let _ = key;
        sibling.mode = ProviderActionGateMode::Sustained;
        sibling.next_admission_at = now + Duration::from_millis(PROVIDER_ACTION_SUSTAINED_DELAY_MS);
        sibling.updated_at = now;
    }
    Ok(admission)
}

pub fn cancel_wait(input: ProviderActionWaitInput) -> Result<(), String> {
    let lane_key = normalize_required(input.lane_key, "laneKey")?;
    let waiter_id = normalize_required(input.waiter_id, "waiterId")?;
    let action_scope_key = normalize_required(input.action_scope_key, "actionScopeKey")?;
    if let Some(state) = lock_states()?.get_mut(&lane_key) {
        remove_waiter(state, &waiter_id, &action_scope_key);
        state.updated_at = Instant::now();
    }
    Ok(())
}

pub fn commit_terminal(
    input: ProviderActionTerminalCommitInput,
) -> Result<ProviderActionTerminalCommit, String> {
    let lane_key = normalize_required(input.lane_key, "laneKey")?;
    let action_scope_key = normalize_required(input.action_scope_key, "actionScopeKey")?;
    let now = Instant::now();
    let mut states = lock_states()?;
    let Some(state) = states.get(&lane_key) else {
        return Ok(ProviderActionTerminalCommit { committed: false });
    };
    if state.generation != input.generation
        || state.admitted_generation != Some(input.generation)
        || state.admitted_action_scope.as_deref() != Some(action_scope_key.as_str())
    {
        return Ok(ProviderActionTerminalCommit { committed: false });
    }
    let lane_group_key = state.lane_group_key.clone();
    for state in states
        .values_mut()
        .filter(|state| state.lane_group_key == lane_group_key)
    {
        state.generation = state.generation.saturating_add(1);
        state.mode = ProviderActionGateMode::Sustained;
        state.next_admission_at = now + Duration::from_millis(PROVIDER_ACTION_SUSTAINED_DELAY_MS);
        state.admitted_generation = None;
        state.admitted_action_scope = None;
        state.updated_at = now;
    }
    Ok(ProviderActionTerminalCommit { committed: true })
}

pub fn abandon_admission(input: ProviderActionAbandonInput) -> Result<bool, String> {
    let lane_key = normalize_required(input.lane_key, "laneKey")?;
    let action_scope_key = normalize_required(input.action_scope_key, "actionScopeKey")?;
    let now = Instant::now();
    let mut states = lock_states()?;
    let Some(state) = states.get(&lane_key) else {
        return Ok(false);
    };
    if state.generation != input.generation
        || state.admitted_generation != Some(input.generation)
        || state.admitted_action_scope.as_deref() != Some(action_scope_key.as_str())
    {
        return Ok(false);
    }
    let lane_group_key = state.lane_group_key.clone();
    for state in states
        .values_mut()
        .filter(|state| state.lane_group_key == lane_group_key)
    {
        state.generation = state.generation.saturating_add(1);
        state.mode = ProviderActionGateMode::Sustained;
        state.next_admission_at = now + Duration::from_millis(PROVIDER_ACTION_SUSTAINED_DELAY_MS);
        state.admitted_generation = None;
        state.admitted_action_scope = None;
        state.updated_at = now;
    }
    Ok(true)
}

pub fn record_success(
    input: ProviderActionSuccessInput,
) -> Result<ProviderActionSuccessRecorded, String> {
    let lane_group_key = normalize_required(input.lane_group_key, "laneGroupKey")?;
    let action_scope_key = normalize_required(input.action_scope_key, "actionScopeKey")?;
    let mut states = lock_states()?;
    let active_admission_scope = states.values().find_map(|state| {
        (state.lane_group_key == lane_group_key
            && state.admitted_generation == Some(state.generation))
        .then(|| state.admitted_action_scope.clone())
        .flatten()
    });
    if active_admission_scope
        .as_deref()
        .is_some_and(|scope| scope != action_scope_key)
    {
        return Ok(ProviderActionSuccessRecorded {
            accepted: false,
            removed_lanes: 0,
        });
    }
    let before = states.len();
    states.retain(|_, state| state.lane_group_key != lane_group_key);
    Ok(ProviderActionSuccessRecorded {
        accepted: true,
        removed_lanes: before.saturating_sub(states.len()),
    })
}

pub fn peek_wait(input: ProviderActionGateKeyInput) -> Result<u64, String> {
    let lane_key = normalize_required(input.lane_key, "laneKey")?;
    let now = Instant::now();
    let mut states = lock_states()?;
    prune_idle(&mut states, now);
    let Some(state) = states.get(&lane_key) else {
        return Ok(0);
    };
    let group_has_active_admission = states.values().any(|candidate| {
        candidate.lane_group_key == state.lane_group_key
            && candidate.admitted_generation == Some(candidate.generation)
    });
    Ok(if group_has_active_admission {
        PROVIDER_ACTION_ACTIVE_POLL_MS
    } else {
        remaining_ms(state.next_admission_at, now)
    })
}

pub fn reset(input: ProviderActionResetInput) -> Result<usize, String> {
    let lane_key = input
        .lane_key
        .map(|value| normalize_required(value, "laneKey"))
        .transpose()?;
    let lane_prefix = input
        .lane_prefix
        .map(|value| normalize_required(value, "lanePrefix"))
        .transpose()?;
    let lane_group_key = input
        .lane_group_key
        .map(|value| normalize_required(value, "laneGroupKey"))
        .transpose()?;
    let mut states = lock_states()?;
    let before = states.len();
    states.retain(|key, state| {
        if lane_key.as_ref().is_some_and(|lane| key == lane) {
            return false;
        }
        if lane_prefix
            .as_ref()
            .is_some_and(|prefix| key.starts_with(prefix))
        {
            return false;
        }
        if lane_group_key
            .as_ref()
            .is_some_and(|group| &state.lane_group_key == group)
        {
            return false;
        }
        lane_key.is_some() || lane_prefix.is_some() || lane_group_key.is_some()
    });
    Ok(before.saturating_sub(states.len()))
}

fn wait_poll(state: &ProviderActionGateState, now: Instant) -> ProviderActionAdmissionPoll {
    ProviderActionAdmissionPoll {
        state: "wait",
        generation: state.generation,
        mode: mode_label(state.mode),
        wait_ms: remaining_ms(state.next_admission_at, now).max(1),
    }
}

fn released_poll() -> ProviderActionAdmissionPoll {
    ProviderActionAdmissionPoll {
        state: "released_by_success",
        generation: 0,
        mode: "idle",
        wait_ms: 0,
    }
}

fn remove_waiter(state: &mut ProviderActionGateState, waiter_id: &str, action_scope_key: &str) {
    if let Some(index) = state.waiters.iter().position(|ticket| {
        ticket.waiter_id == waiter_id && ticket.action_scope_key == action_scope_key
    }) {
        state.waiters.remove(index);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard, OnceLock};
    use std::thread;

    fn test_guard() -> MutexGuard<'static, ()> {
        static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        TEST_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .expect("provider action gate test lock must not be poisoned")
    }

    fn key(value: &str) -> ProviderActionGateKeyInput {
        ProviderActionGateKeyInput {
            lane_key: value.to_string(),
            lane_group_key: None,
            action_scope_key: None,
        }
    }

    fn grouped_key(value: &str, group: &str) -> ProviderActionGateKeyInput {
        ProviderActionGateKeyInput {
            lane_key: value.to_string(),
            lane_group_key: Some(group.to_string()),
            action_scope_key: None,
        }
    }

    fn waiter(key: &str, id: &str) -> ProviderActionWaitInput {
        ProviderActionWaitInput {
            lane_key: key.to_string(),
            waiter_id: id.to_string(),
            action_scope_key: id.to_string(),
        }
    }

    fn terminal_commit(
        key: &str,
        generation: u64,
        action_scope: &str,
    ) -> ProviderActionTerminalCommitInput {
        ProviderActionTerminalCommitInput {
            lane_key: key.to_string(),
            generation,
            action_scope_key: action_scope.to_string(),
        }
    }

    fn scoped_grouped_key(
        value: &str,
        group: &str,
        action_scope: &str,
    ) -> ProviderActionGateKeyInput {
        ProviderActionGateKeyInput {
            lane_key: value.to_string(),
            lane_group_key: Some(group.to_string()),
            action_scope_key: Some(action_scope.to_string()),
        }
    }

    fn abandon(key: &str, generation: u64, action_scope: &str) -> ProviderActionAbandonInput {
        ProviderActionAbandonInput {
            lane_key: key.to_string(),
            generation,
            action_scope_key: action_scope.to_string(),
        }
    }

    #[test]
    fn isolated_and_sustained_delays_are_rust_owned() {
        let _guard = test_guard();
        reset(ProviderActionResetInput::default()).unwrap();
        let first = record_failure(key("scope-a")).unwrap();
        assert_eq!(first.minimum_delay_ms, PROVIDER_ACTION_ISOLATED_DELAY_MS);
        assert_eq!(first.mode, "isolated");
        begin_wait(waiter("scope-a", "isolated")).unwrap();
        let early = poll_admission(waiter("scope-a", "isolated")).unwrap();
        assert_eq!(early.state, "wait");
        assert!(early.wait_ms > 0);
        let second = record_failure(key("scope-a")).unwrap();
        assert_eq!(second.minimum_delay_ms, PROVIDER_ACTION_SUSTAINED_DELAY_MS);
        assert_eq!(second.mode, "sustained");
    }

    #[test]
    fn success_after_terminal_admission_invalidates_atomic_commit() {
        let _guard = test_guard();
        reset(ProviderActionResetInput::default()).unwrap();
        let scope = "terminal-success-race";
        record_failure(key(scope)).unwrap();
        {
            let mut states = lock_states().unwrap();
            states.get_mut(scope).unwrap().next_admission_at = Instant::now();
        }
        begin_wait(waiter(scope, "terminal")).unwrap();
        let admission = poll_admission(waiter(scope, "terminal")).unwrap();
        assert_eq!(admission.state, "admitted");

        reset(ProviderActionResetInput {
            lane_key: Some(scope.to_string()),
            ..ProviderActionResetInput::default()
        })
        .unwrap();

        assert!(
            !commit_terminal(terminal_commit(scope, admission.generation, "terminal"))
                .unwrap()
                .committed,
            "success reset must invalidate a stale terminal admission"
        );
    }

    #[test]
    fn overlapping_waiter_promotes_and_one_generation_admits_once() {
        let _guard = test_guard();
        reset(ProviderActionResetInput::default()).unwrap();
        record_failure(key("scope-b")).unwrap();
        begin_wait(waiter("scope-b", "first")).unwrap();
        let promoted = begin_wait(waiter("scope-b", "second")).unwrap();
        assert_eq!(promoted.mode, "sustained");
        assert!(promoted.wait_ms >= PROVIDER_ACTION_SUSTAINED_DELAY_MS - 1);
        thread::sleep(Duration::from_millis(
            PROVIDER_ACTION_SUSTAINED_DELAY_MS + 5,
        ));
        assert_eq!(
            poll_admission(waiter("scope-b", "first")).unwrap().state,
            "admitted"
        );
        assert_eq!(
            poll_admission(waiter("scope-b", "second")).unwrap().state,
            "wait"
        );
    }

    #[test]
    fn reset_releases_waiters_without_provider_failure_projection() {
        let _guard = test_guard();
        reset(ProviderActionResetInput::default()).unwrap();
        record_failure(key("scope-c")).unwrap();
        begin_wait(waiter("scope-c", "waiter")).unwrap();
        reset(ProviderActionResetInput {
            lane_key: Some("scope-c".to_string()),
            lane_prefix: None,
            lane_group_key: None,
        })
        .unwrap();
        assert_eq!(
            poll_admission(waiter("scope-c", "waiter")).unwrap().state,
            "released_by_success"
        );
    }

    #[test]
    fn cancel_is_health_neutral_and_does_not_release_the_generation() {
        let _guard = test_guard();
        reset(ProviderActionResetInput::default()).unwrap();
        record_failure(key("scope-cancel")).unwrap();
        begin_wait(waiter("scope-cancel", "cancelled")).unwrap();
        cancel_wait(waiter("scope-cancel", "cancelled")).unwrap();

        let replacement = begin_wait(waiter("scope-cancel", "replacement")).unwrap();
        assert_eq!(replacement.state, "wait");
        assert_eq!(replacement.generation, 1);
        assert!(replacement.wait_ms > 0);
    }

    #[test]
    fn admitted_action_failure_advances_every_lane_in_the_group() {
        let _guard = test_guard();
        reset(ProviderActionResetInput::default()).unwrap();
        let group = "global_error|port:5555|gateway-priority";
        let first_key = "global_error|port:5555|provider-a|HTTP_429";
        let second_key = "global_error|port:5555|provider-a|HTTP_500";
        record_failure(scoped_grouped_key(first_key, group, "request-a")).unwrap();
        {
            let mut states = lock_states().unwrap();
            states.get_mut(first_key).unwrap().next_admission_at = Instant::now();
        }
        begin_wait(waiter(first_key, "request-a")).unwrap();
        assert_eq!(
            poll_admission(waiter(first_key, "request-a"))
                .unwrap()
                .state,
            "admitted"
        );

        record_failure(scoped_grouped_key(second_key, group, "request-a")).unwrap();
        {
            let mut states = lock_states().unwrap();
            states.get_mut(first_key).unwrap().next_admission_at = Instant::now();
        }
        begin_wait(waiter(first_key, "reselected-action")).unwrap();
        assert_eq!(
            poll_admission(waiter(first_key, "reselected-action"))
                .unwrap()
                .state,
            "admitted",
            "the outcome failure left the previous group admission permanently occupied"
        );
    }

    #[test]
    fn admitted_action_requires_explicit_abandon_before_replacement_generation() {
        let _guard = test_guard();
        reset(ProviderActionResetInput::default()).unwrap();
        let scope = "global_error|port:5555|provider-a|HTTP_429";
        record_failure(scoped_grouped_key(scope, scope, "request-a")).unwrap();
        {
            let mut states = lock_states().unwrap();
            states.get_mut(scope).unwrap().next_admission_at = Instant::now();
        }
        begin_wait(waiter(scope, "request-a")).unwrap();
        let admitted = poll_admission(waiter(scope, "request-a")).unwrap();
        assert_eq!(admitted.state, "admitted");

        begin_wait(waiter(scope, "request-b")).unwrap();
        {
            let mut states = lock_states().unwrap();
            let state = states.get_mut(scope).unwrap();
            state.next_admission_at = Instant::now();
            assert_eq!(state.consecutive_failures, 1);
        }
        let blocked = poll_admission(waiter(scope, "request-b")).unwrap();
        assert_eq!(
            blocked.state, "wait",
            "wall-clock expiry must not infer that an admitted action was cancelled"
        );
        assert!(
            abandon_admission(abandon(scope, admitted.generation, "request-a")).unwrap(),
            "the exact admitted generation must be explicitly abandonable"
        );
        assert_eq!(
            lock_states()
                .unwrap()
                .get(scope)
                .unwrap()
                .consecutive_failures,
            1,
            "abandoned admission must not count as another provider failure"
        );
        let sustained = poll_admission(waiter(scope, "request-b")).unwrap();
        assert_eq!(sustained.state, "wait");
        assert!(
            sustained.wait_ms >= PROVIDER_ACTION_SUSTAINED_DELAY_MS - 5,
            "explicit abandon must start a complete sustained spacing floor"
        );
        {
            let mut states = lock_states().unwrap();
            states.get_mut(scope).unwrap().next_admission_at = Instant::now();
        }
        let replacement = poll_admission(waiter(scope, "request-b")).unwrap();
        assert_eq!(replacement.state, "admitted");
        assert_eq!(replacement.generation, admitted.generation + 1);
    }

    #[test]
    fn stale_action_scope_cannot_abandon_or_commit_a_reused_generation() {
        let _guard = test_guard();
        reset(ProviderActionResetInput::default()).unwrap();
        let scope = "global_error|port:5555|provider-a|HTTP_429";
        record_failure(scoped_grouped_key(scope, scope, "request-new")).unwrap();
        {
            let mut states = lock_states().unwrap();
            states.get_mut(scope).unwrap().next_admission_at = Instant::now();
        }
        begin_wait(waiter(scope, "request-new")).unwrap();
        let admitted = poll_admission(waiter(scope, "request-new")).unwrap();
        assert_eq!(admitted.state, "admitted");

        assert!(
            !abandon_admission(abandon(scope, admitted.generation, "request-old")).unwrap(),
            "a stale abort listener must not abandon a new owner with the same generation number"
        );
        assert!(
            !commit_terminal(terminal_commit(scope, admitted.generation, "request-old"))
                .unwrap()
                .committed,
            "a stale terminal caller must not commit another action scope"
        );
        let states = lock_states().unwrap();
        assert_eq!(
            states.get(scope).unwrap().admitted_action_scope.as_deref(),
            Some("request-new")
        );
    }

    #[test]
    fn unrelated_success_cannot_release_an_active_action_scope() {
        let _guard = test_guard();
        reset(ProviderActionResetInput::default()).unwrap();
        let group = "global_error|port:5555|gateway-priority";
        let scope = "global_error|port:5555|provider-a|HTTP_503";
        record_failure(scoped_grouped_key(scope, group, "request-a")).unwrap();
        {
            let mut states = lock_states().unwrap();
            states.get_mut(scope).unwrap().next_admission_at = Instant::now();
        }
        begin_wait(waiter(scope, "request-a")).unwrap();
        assert_eq!(
            poll_admission(waiter(scope, "request-a")).unwrap().state,
            "admitted"
        );

        let unrelated = record_success(ProviderActionSuccessInput {
            lane_group_key: group.to_string(),
            action_scope_key: "request-b".to_string(),
        })
        .unwrap();
        assert!(!unrelated.accepted);
        assert_eq!(unrelated.removed_lanes, 0);
        assert!(lock_states().unwrap().contains_key(scope));

        let owner = record_success(ProviderActionSuccessInput {
            lane_group_key: group.to_string(),
            action_scope_key: "request-a".to_string(),
        })
        .unwrap();
        assert!(owner.accepted);
        assert_eq!(owner.removed_lanes, 1);
        assert!(!lock_states().unwrap().contains_key(scope));
    }

    #[test]
    fn waiter_ticket_rejects_action_scope_rebinding() {
        let _guard = test_guard();
        reset(ProviderActionResetInput::default()).unwrap();
        let scope = "global_error|port:5555|provider-a|HTTP_503";
        record_failure(key(scope)).unwrap();
        begin_wait(waiter(scope, "request-a")).unwrap();
        let rebound = ProviderActionWaitInput {
            lane_key: scope.to_string(),
            waiter_id: "request-a".to_string(),
            action_scope_key: "request-b".to_string(),
        };
        assert_eq!(
            poll_admission(rebound).unwrap_err(),
            "provider action waiter action scope changed"
        );
    }

    #[test]
    fn fifo_waiters_preserve_order_when_middle_ticket_is_cancelled() {
        let _guard = test_guard();
        reset(ProviderActionResetInput::default()).unwrap();
        let scope = "global_error|port:5555|provider-a|HTTP_503";
        record_failure(key(scope)).unwrap();
        begin_wait(waiter(scope, "first")).unwrap();
        begin_wait(waiter(scope, "middle")).unwrap();
        begin_wait(waiter(scope, "last")).unwrap();
        cancel_wait(waiter(scope, "middle")).unwrap();
        {
            let mut states = lock_states().unwrap();
            states.get_mut(scope).unwrap().next_admission_at = Instant::now();
        }
        assert_eq!(
            poll_admission(waiter(scope, "last")).unwrap().state,
            "wait",
            "a later waiter must not overtake the first FIFO ticket"
        );
        assert_eq!(
            poll_admission(waiter(scope, "first")).unwrap().state,
            "admitted"
        );
    }

    #[test]
    fn active_group_admission_blocks_other_provider_lane_beyond_deadline() {
        let _guard = test_guard();
        reset(ProviderActionResetInput::default()).unwrap();
        let group = "global_error|port:5555|gateway-priority";
        let first_key = "global_error|port:5555|provider-a|HTTP_503";
        let second_key = "global_error|port:5555|provider-b|HTTP_429";
        record_failure(scoped_grouped_key(first_key, group, "request-a")).unwrap();
        record_failure(scoped_grouped_key(second_key, group, "request-b")).unwrap();
        begin_wait(waiter(first_key, "request-a")).unwrap();
        begin_wait(waiter(second_key, "request-b")).unwrap();
        {
            let mut states = lock_states().unwrap();
            states.get_mut(first_key).unwrap().next_admission_at = Instant::now();
            states.get_mut(second_key).unwrap().next_admission_at = Instant::now();
        }
        let first = poll_admission(waiter(first_key, "request-a")).unwrap();
        assert_eq!(first.state, "admitted");
        {
            let mut states = lock_states().unwrap();
            states.get_mut(second_key).unwrap().next_admission_at = Instant::now();
        }
        assert_eq!(
            poll_admission(waiter(second_key, "request-b"))
                .unwrap()
                .state,
            "wait",
            "a different provider/error-family lane must not bypass the group-active permit"
        );
    }

    #[test]
    fn concurrent_failure_does_not_clear_another_action_scope_admission() {
        let _guard = test_guard();
        reset(ProviderActionResetInput::default()).unwrap();
        let group = "global_error|port:5555|gateway-priority";
        let first_key = "global_error|port:5555|provider-a|HTTP_503";
        let second_key = "global_error|port:5555|provider-b|HTTP_429";
        record_failure(scoped_grouped_key(first_key, group, "request-a")).unwrap();
        {
            let mut states = lock_states().unwrap();
            states.get_mut(first_key).unwrap().next_admission_at = Instant::now();
        }
        begin_wait(waiter(first_key, "request-a")).unwrap();
        let admitted = poll_admission(waiter(first_key, "request-a")).unwrap();
        assert_eq!(admitted.state, "admitted");

        record_failure(scoped_grouped_key(second_key, group, "request-b")).unwrap();
        let states = lock_states().unwrap();
        let active = states.get(first_key).unwrap();
        assert_eq!(active.generation, admitted.generation);
        assert_eq!(active.admitted_generation, Some(admitted.generation));
        assert_eq!(active.admitted_action_scope.as_deref(), Some("request-a"));
    }

    #[test]
    fn failure_from_admitted_action_scope_ends_prior_permit() {
        let _guard = test_guard();
        reset(ProviderActionResetInput::default()).unwrap();
        let group = "global_error|port:5555|gateway-priority";
        let first_key = "global_error|port:5555|provider-a|HTTP_503";
        let next_key = "global_error|port:5555|provider-b|HTTP_429";
        record_failure(scoped_grouped_key(first_key, group, "request-a")).unwrap();
        {
            let mut states = lock_states().unwrap();
            states.get_mut(first_key).unwrap().next_admission_at = Instant::now();
        }
        begin_wait(waiter(first_key, "request-a")).unwrap();
        let admitted = poll_admission(waiter(first_key, "request-a")).unwrap();
        assert_eq!(admitted.state, "admitted");

        record_failure(scoped_grouped_key(next_key, group, "request-a")).unwrap();
        let states = lock_states().unwrap();
        assert_eq!(states.get(first_key).unwrap().admitted_generation, None);
        assert_eq!(
            states.get(next_key).unwrap().mode,
            ProviderActionGateMode::Sustained
        );
    }

    #[test]
    fn exact_and_prefix_resets_are_scope_isolated() {
        let _guard = test_guard();
        reset(ProviderActionResetInput::default()).unwrap();
        record_failure(key("global|5520|provider-a|timeout")).unwrap();
        record_failure(key("global|5520|provider-a|status-429")).unwrap();
        record_failure(key("global|5555|provider-a|timeout")).unwrap();

        let removed = reset(ProviderActionResetInput {
            lane_key: None,
            lane_prefix: Some("global|5520|provider-a|".to_string()),
            lane_group_key: None,
        })
        .unwrap();
        assert_eq!(removed, 2);
        assert_eq!(
            begin_wait(waiter("global|5520|provider-a|timeout", "released"))
                .unwrap()
                .state,
            "released_by_success"
        );
        assert_eq!(
            begin_wait(waiter("global|5555|provider-a|timeout", "still-active"))
                .unwrap()
                .state,
            "wait"
        );
    }

    #[test]
    fn provider_or_error_family_change_inside_active_group_stays_sustained() {
        let _guard = test_guard();
        reset(ProviderActionResetInput::default()).unwrap();
        let first = record_failure(grouped_key(
            "global_error|port:5555|provider-a|tools|HTTP_503",
            "global_error|port:5555|tools",
        ))
        .unwrap();
        assert_eq!(first.mode, "isolated");
        let switched = record_failure(grouped_key(
            "global_error|port:5555|provider-b|tools|HTTP_429",
            "global_error|port:5555|tools",
        ))
        .unwrap();
        assert_eq!(switched.mode, "sustained");
        assert_eq!(
            switched.minimum_delay_ms,
            PROVIDER_ACTION_SUSTAINED_DELAY_MS
        );
        reset(ProviderActionResetInput {
            lane_group_key: Some("global_error|port:5555|tools".to_string()),
            ..Default::default()
        })
        .unwrap();
        let after_success = record_failure(grouped_key(
            "global_error|port:5555|provider-c|tools|HTTP_502",
            "global_error|port:5555|tools",
        ))
        .unwrap();
        assert_eq!(after_success.mode, "isolated");
    }

    #[test]
    fn changed_provider_lanes_admit_one_action_per_group_interval() {
        let _guard = test_guard();
        reset(ProviderActionResetInput::default()).unwrap();
        let group = "global_error|port:5555|gateway-priority";
        let first_key = "global_error|port:5555|provider-a|tools|HTTP_503";
        let second_key = "global_error|port:5555|provider-b|tools|HTTP_429";
        record_failure(grouped_key(first_key, group)).unwrap();
        record_failure(grouped_key(second_key, group)).unwrap();
        begin_wait(waiter(first_key, "first-provider")).unwrap();
        begin_wait(waiter(second_key, "second-provider")).unwrap();

        thread::sleep(Duration::from_millis(
            PROVIDER_ACTION_SUSTAINED_DELAY_MS + 5,
        ));
        assert_eq!(
            poll_admission(waiter(first_key, "first-provider"))
                .unwrap()
                .state,
            "admitted"
        );
        let second = poll_admission(waiter(second_key, "second-provider")).unwrap();
        assert_eq!(second.state, "wait");
        assert!(
            second.wait_ms >= PROVIDER_ACTION_SUSTAINED_DELAY_MS - 5,
            "a provider/error-family change admitted a second group action without the sustained interval"
        );
    }
}

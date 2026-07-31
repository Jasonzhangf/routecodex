// feature_id: v3.provider_action_gate

use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use routecodex_v3_error::{V3Error05RecoveryAdmissionWitness, V3ProviderFailureSessionScope};
use tokio::sync::watch;
use tokio::time::Instant;

pub const V3_PROVIDER_ACTION_ISOLATED_DELAY_MS: u64 = 1_000;
pub const V3_PROVIDER_ACTION_MEDIUM_DELAY_MS: u64 = 3_000;
pub const V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS: u64 = 5_000;
const V3_PROVIDER_ACTION_IDLE_TTL_MS: u64 = 10 * 60_000;

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct V3ProviderActionProviderScope {
    pub server_id: String,
    pub routing_group: String,
    pub session_id: String,
    pub provider_runtime_identity: String,
}

impl V3ProviderActionProviderScope {
    pub fn new(
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_runtime_identity: impl Into<String>,
    ) -> Result<Self, String> {
        Self::from_failure_session_scope(failure_session_scope, provider_runtime_identity)
    }

    fn from_failure_session_scope(
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_runtime_identity: impl Into<String>,
    ) -> Result<Self, String> {
        Ok(Self {
            server_id: failure_session_scope.server_id().to_string(),
            routing_group: failure_session_scope.routing_group().to_string(),
            session_id: failure_session_scope.session_id().to_string(),
            provider_runtime_identity: required_scope_part(
                provider_runtime_identity.into(),
                "provider_runtime_identity",
            )?,
        })
    }
}

#[derive(Debug, Clone, Eq)]
pub struct V3ProviderActionGateKey {
    pub provider_scope: V3ProviderActionProviderScope,
    pub session_id: String,
    pub normalized_error_family: String,
}

impl V3ProviderActionGateKey {
    pub fn new(
        failure_session_scope: &V3ProviderFailureSessionScope,
        provider_runtime_identity: impl Into<String>,
        normalized_error_family: impl Into<String>,
    ) -> Result<Self, String> {
        let provider_scope =
            V3ProviderActionProviderScope::new(failure_session_scope, provider_runtime_identity)?;
        Ok(Self {
            session_id: provider_scope.session_id.clone(),
            provider_scope,
            normalized_error_family: required_scope_part(
                normalized_error_family.into(),
                "normalized_error_family",
            )?,
        })
    }

    fn from_recovery_witness(witness: &V3Error05RecoveryAdmissionWitness) -> Result<Self, String> {
        Ok(Self {
            provider_scope: V3ProviderActionProviderScope::from_failure_session_scope(
                witness.failure_session_scope(),
                witness.provider_runtime_identity(),
            )?,
            session_id: witness.failure_session_scope().session_id().to_string(),
            normalized_error_family: required_scope_part(
                witness.normalized_error_family().to_string(),
                "normalized_error_family",
            )?,
        })
    }

    fn recovery_witness(
        &self,
        generation: u64,
    ) -> Result<V3Error05RecoveryAdmissionWitness, String> {
        V3Error05RecoveryAdmissionWitness::new(
            V3ProviderFailureSessionScope::new(
                &self.provider_scope.server_id,
                &self.provider_scope.routing_group,
                &self.provider_scope.session_id,
            )?,
            &self.provider_scope.provider_runtime_identity,
            &self.normalized_error_family,
            generation,
        )
    }
}

impl PartialEq for V3ProviderActionGateKey {
    fn eq(&self, other: &Self) -> bool {
        self.provider_scope == other.provider_scope
            && self.normalized_error_family == other.normalized_error_family
    }
}

impl Hash for V3ProviderActionGateKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.provider_scope.hash(state);
        self.normalized_error_family.hash(state);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3ProviderActionGateMode {
    Isolated,
    Medium,
    Sustained,
}

#[derive(Debug)]
pub struct V3ProviderActionAdmission {
    pub generation: u64,
    pub mode: V3ProviderActionGateMode,
    pub minimum_delay_ms: u64,
    pub released_by_success: bool,
    pub reevaluate_after_terminal: bool,
    pub refreshed_recovery_witness: Option<V3Error05RecoveryAdmissionWitness>,
    permit: Option<V3ProviderActionPermit>,
}

impl V3ProviderActionAdmission {
    pub(crate) fn take_permit(&mut self) -> Option<V3ProviderActionPermit> {
        self.permit.take()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderActionFailureRecorded {
    pub generation: u64,
    pub mode: V3ProviderActionGateMode,
    pub minimum_delay_ms: u64,
    recovery_ticket: V3ProviderActionRecoveryTicket,
}

impl V3ProviderActionFailureRecorded {
    pub fn recovery_ticket(&self) -> &V3ProviderActionRecoveryTicket {
        &self.recovery_ticket
    }

    pub fn recovery_witness(&self) -> Result<V3Error05RecoveryAdmissionWitness, String> {
        self.recovery_ticket.recovery_witness()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderActionRecoveryTicket {
    key: V3ProviderActionGateKey,
    generation: u64,
}

impl V3ProviderActionRecoveryTicket {
    fn new(key: V3ProviderActionGateKey, generation: u64) -> Result<Self, String> {
        if generation == 0 {
            return Err("provider action recovery ticket generation must be positive".to_string());
        }
        Ok(Self { key, generation })
    }

    fn from_recovery_witness(witness: &V3Error05RecoveryAdmissionWitness) -> Result<Self, String> {
        Self::new(
            V3ProviderActionGateKey::from_recovery_witness(witness)?,
            witness.generation(),
        )
    }

    pub fn key(&self) -> &V3ProviderActionGateKey {
        &self.key
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn recovery_witness(&self) -> Result<V3Error05RecoveryAdmissionWitness, String> {
        self.key.recovery_witness(self.generation)
    }
}

#[derive(Debug)]
pub enum V3ProviderActionRecoveryTransition {
    Admitted(V3ProviderActionAdmission),
    Superseded(V3ProviderActionRecoveryTicket),
    ReleasedBySuccess(V3ProviderActionRecoveryTicket),
}

#[derive(Debug)]
struct V3ProviderActionGateState {
    generation: u64,
    mode: V3ProviderActionGateMode,
    consecutive_failures: u64,
    waiter_queue: VecDeque<u64>,
    next_waiter_ticket: u64,
    next_admission_at: Instant,
    admitted_generation: Option<u64>,
    admitted_action_scope: Option<V3ProviderActionProviderScope>,
    success_transition_generation: Option<u64>,
    terminal_transition_generation: Option<u64>,
    updated_at: Instant,
    change_tx: watch::Sender<u64>,
}

#[derive(Debug, Default)]
struct V3ProviderActionGateInner {
    states: Mutex<HashMap<V3ProviderActionGateKey, V3ProviderActionGateState>>,
}

#[derive(Debug, Clone, Default)]
pub struct V3ProviderActionGate {
    inner: Arc<V3ProviderActionGateInner>,
}

#[derive(Debug)]
pub(crate) struct V3ProviderActionPermit {
    gate: V3ProviderActionGate,
    key: V3ProviderActionGateKey,
    generation: u64,
    armed: bool,
}

impl Drop for V3ProviderActionPermit {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let _ = self.gate.abandon_admission(&self.key, self.generation);
        self.armed = false;
    }
}

impl V3ProviderActionGate {
    pub fn process_shared() -> Self {
        static SHARED: OnceLock<V3ProviderActionGate> = OnceLock::new();
        SHARED.get_or_init(Self::default).clone()
    }

    pub async fn record_failure_and_wait(
        &self,
        key: V3ProviderActionGateKey,
    ) -> Result<V3ProviderActionAdmission, String> {
        self.record_failure(&key)?;
        self.wait_for_active_failure(key).await
    }

    pub async fn record_failure_and_wait_for_terminal_projection(
        &self,
        key: V3ProviderActionGateKey,
    ) -> Result<V3ProviderActionAdmission, String> {
        self.record_failure(&key)?;
        loop {
            let admission = self.wait_for_active_failure(key.clone()).await?;
            if admission.released_by_success {
                self.record_failure(&key)?;
                continue;
            }
            if admission.reevaluate_after_terminal {
                continue;
            }
            if self.commit_terminal_admission(&key, &admission)? {
                return Ok(admission);
            }
            self.record_failure(&key)?;
        }
    }

    pub async fn wait_for_active_failure(
        &self,
        key: V3ProviderActionGateKey,
    ) -> Result<V3ProviderActionAdmission, String> {
        let action_scope = key.provider_scope.clone();
        let mut waiter = self.register_waiter(key, action_scope, true, None)?;
        waiter.wait().await
    }

    pub async fn wait_for_recovery_witness(
        &self,
        witness: &V3Error05RecoveryAdmissionWitness,
        action_scope: V3ProviderActionProviderScope,
    ) -> Result<V3ProviderActionRecoveryTransition, String> {
        let ticket = V3ProviderActionRecoveryTicket::from_recovery_witness(witness)?;
        self.wait_for_recovery_ticket(&ticket, action_scope).await
    }

    pub async fn wait_for_recovery_ticket(
        &self,
        ticket: &V3ProviderActionRecoveryTicket,
        action_scope: V3ProviderActionProviderScope,
    ) -> Result<V3ProviderActionRecoveryTransition, String> {
        {
            let states = self.lock_states()?;
            let current_generation = states
                .get(ticket.key())
                .map(|state| state.generation)
                .ok_or_else(|| {
                    "provider action recovery ticket references a lane that is absent".to_string()
                })?;
            if current_generation < ticket.generation() {
                return Err(format!(
                    "provider action recovery ticket generation {} is ahead of lane generation {}",
                    ticket.generation(),
                    current_generation
                ));
            }
        }
        self.register_waiter(
            ticket.key().clone(),
            action_scope,
            true,
            Some(ticket.generation()),
        )?
        .wait_recovery()
        .await
    }

    pub async fn wait_for_provider_action(
        &self,
        provider_scope: &V3ProviderActionProviderScope,
    ) -> Result<Option<V3ProviderActionAdmission>, String> {
        self.wait_for_matching_provider_action(provider_scope, false)
            .await
    }

    pub async fn wait_for_exact_provider_action(
        &self,
        provider_scope: &V3ProviderActionProviderScope,
    ) -> Result<Option<V3ProviderActionAdmission>, String> {
        self.wait_for_matching_provider_action(provider_scope, true)
            .await
    }

    async fn wait_for_matching_provider_action(
        &self,
        provider_scope: &V3ProviderActionProviderScope,
        exact_provider: bool,
    ) -> Result<Option<V3ProviderActionAdmission>, String> {
        let key = {
            let mut states = self.lock_states()?;
            prune_idle_states(&mut states);
            states
                .iter()
                .filter(|(key, _)| {
                    key.provider_scope.server_id == provider_scope.server_id
                        && key.provider_scope.routing_group == provider_scope.routing_group
                        && key.provider_scope.session_id == provider_scope.session_id
                        && (!exact_provider
                            || key.provider_scope.provider_runtime_identity
                                == provider_scope.provider_runtime_identity)
                })
                .max_by_key(|(_, state)| state.next_admission_at)
                .map(|(key, _)| key.clone())
        };
        match key {
            Some(key) => self
                .register_waiter(key, provider_scope.clone(), true, None)?
                .wait()
                .await
                .map(Some),
            None => Ok(None),
        }
    }

    pub fn record_success(&self, key: &V3ProviderActionGateKey) -> Result<(), String> {
        let now = Instant::now();
        let removed = {
            let mut states = self.lock_states()?;
            let retain_for_waiters = states
                .get(key)
                .is_some_and(|state| !state.waiter_queue.is_empty());
            if retain_for_waiters {
                let state = states
                    .get_mut(key)
                    .expect("provider action gate key was just observed");
                state.generation = state.generation.saturating_add(1);
                state.mode = V3ProviderActionGateMode::Sustained;
                state.consecutive_failures = 0;
                state.next_admission_at =
                    now + Duration::from_millis(V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS);
                state.admitted_generation = None;
                state.admitted_action_scope = None;
                state.success_transition_generation = Some(state.generation);
                state.terminal_transition_generation = None;
                state.updated_at = now;
                let _ = state.change_tx.send(state.generation);
                None
            } else {
                states.remove(key)
            }
        };
        if let Some(state) = removed {
            let _ = state.change_tx.send(state.generation.saturating_add(1));
        }
        Ok(())
    }

    pub fn record_provider_success(
        &self,
        provider_scope: &V3ProviderActionProviderScope,
    ) -> Result<(), String> {
        let now = Instant::now();
        let removed = {
            let mut states = self.lock_states()?;
            let keys = states
                .iter()
                .filter_map(|(key, state)| {
                    (key.provider_scope == *provider_scope
                        || state.admitted_action_scope.as_ref() == Some(provider_scope))
                    .then_some(key.clone())
                })
                .collect::<Vec<_>>();
            let mut removed = Vec::new();
            for key in keys {
                let retain_for_waiters = states
                    .get(&key)
                    .is_some_and(|state| !state.waiter_queue.is_empty());
                if retain_for_waiters {
                    let state = states
                        .get_mut(&key)
                        .expect("provider action gate key was just observed");
                    state.generation = state.generation.saturating_add(1);
                    state.mode = V3ProviderActionGateMode::Sustained;
                    state.consecutive_failures = 0;
                    state.next_admission_at =
                        now + Duration::from_millis(V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS);
                    state.admitted_generation = None;
                    state.admitted_action_scope = None;
                    state.success_transition_generation = Some(state.generation);
                    state.terminal_transition_generation = None;
                    state.updated_at = now;
                    let _ = state.change_tx.send(state.generation);
                } else if let Some(state) = states.remove(&key) {
                    removed.push(state);
                }
            }
            removed
        };
        for state in removed {
            let _ = state.change_tx.send(state.generation.saturating_add(1));
        }
        Ok(())
    }

    pub fn active_waiters(&self, key: &V3ProviderActionGateKey) -> Result<usize, String> {
        Ok(self
            .lock_states()?
            .get(key)
            .map_or(0, |state| state.waiter_queue.len()))
    }

    pub fn abandon_admission(
        &self,
        key: &V3ProviderActionGateKey,
        generation: u64,
    ) -> Result<bool, String> {
        let now = Instant::now();
        let mut states = self.lock_states()?;
        let Some(state) = states.get(key) else {
            return Ok(false);
        };
        if state.generation != generation || state.admitted_generation != Some(generation) {
            return Ok(false);
        }
        let server_id = key.provider_scope.server_id.clone();
        let routing_group = key.provider_scope.routing_group.clone();
        for (_active_key, state) in states.iter_mut().filter(|(active_key, _)| {
            active_key.provider_scope.server_id == server_id
                && active_key.provider_scope.routing_group == routing_group
                && active_key.provider_scope.session_id == key.provider_scope.session_id
        }) {
            state.generation = state.generation.saturating_add(1);
            state.mode = V3ProviderActionGateMode::Sustained;
            state.next_admission_at =
                now + Duration::from_millis(V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS);
            state.admitted_generation = None;
            state.admitted_action_scope = None;
            state.success_transition_generation = None;
            state.terminal_transition_generation = None;
            state.updated_at = now;
            let _ = state.change_tx.send(state.generation);
        }
        Ok(true)
    }

    pub fn commit_terminal_admission(
        &self,
        key: &V3ProviderActionGateKey,
        admission: &V3ProviderActionAdmission,
    ) -> Result<bool, String> {
        let now = Instant::now();
        let mut states = self.lock_states()?;
        let Some(state) = states.get(key) else {
            return Ok(false);
        };
        if state.generation != admission.generation
            || state.admitted_generation != Some(admission.generation)
        {
            return Ok(false);
        }
        let server_id = key.provider_scope.server_id.clone();
        let routing_group = key.provider_scope.routing_group.clone();
        let session_id = key.provider_scope.session_id.clone();
        for (_key, state) in states.iter_mut().filter(|(key, _)| {
            key.provider_scope.server_id == server_id
                && key.provider_scope.routing_group == routing_group
                && key.provider_scope.session_id == session_id
        }) {
            state.generation = state.generation.saturating_add(1);
            state.mode = V3ProviderActionGateMode::Sustained;
            state.next_admission_at =
                now + Duration::from_millis(V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS);
            state.admitted_generation = None;
            state.admitted_action_scope = None;
            state.success_transition_generation = None;
            state.terminal_transition_generation = Some(state.generation);
            state.updated_at = now;
            let _ = state.change_tx.send(state.generation);
        }
        Ok(true)
    }

    pub fn record_failure(
        &self,
        key: &V3ProviderActionGateKey,
    ) -> Result<V3ProviderActionFailureRecorded, String> {
        let now = Instant::now();
        let mut states = self.lock_states()?;
        prune_idle_states(&mut states);
        let consumed_success_transition = states.get(key).is_some_and(|state| {
            state.success_transition_generation == Some(state.generation)
                && state.waiter_queue.is_empty()
                && state.admitted_generation.is_none()
        });
        if consumed_success_transition {
            states.remove(key);
        }
        let active_lane_generation = states
            .iter()
            .filter(|(active_key, _)| {
                active_key.provider_scope.server_id == key.provider_scope.server_id
                    && active_key.provider_scope.routing_group == key.provider_scope.routing_group
                    && active_key.provider_scope.session_id == key.provider_scope.session_id
            })
            .map(|(_, state)| state.generation)
            .max();
        let active_admission_owned = states.iter().any(|(active_key, state)| {
            active_key.provider_scope.server_id == key.provider_scope.server_id
                && active_key.provider_scope.routing_group == key.provider_scope.routing_group
                && active_key.provider_scope.session_id == key.provider_scope.session_id
                && state.admitted_generation == Some(state.generation)
        });
        if active_lane_generation.is_some() {
            for (_active_key, state) in states.iter_mut().filter(|(active_key, _)| {
                active_key.provider_scope.server_id == key.provider_scope.server_id
                    && active_key.provider_scope.routing_group == key.provider_scope.routing_group
                    && active_key.provider_scope.session_id == key.provider_scope.session_id
            }) {
                state.mode = V3ProviderActionGateMode::Sustained;
                state.next_admission_at =
                    now + Duration::from_millis(V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS);
                state.success_transition_generation = None;
                state.terminal_transition_generation = None;
                state.updated_at = now;
                let _ = state.change_tx.send(state.generation);
            }
        }
        let state = match states.get_mut(key) {
            Some(state) => {
                if !active_admission_owned {
                    state.generation = state.generation.saturating_add(1);
                    state.admitted_generation = None;
                    state.admitted_action_scope = None;
                }
                state.mode = V3ProviderActionGateMode::Sustained;
                state.consecutive_failures = state.consecutive_failures.saturating_add(1);
                state.next_admission_at =
                    now + Duration::from_millis(V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS);
                state.success_transition_generation = None;
                state.terminal_transition_generation = None;
                state.updated_at = now;
                let _ = state.change_tx.send(state.generation);
                state
            }
            None => {
                let (change_tx, _change_rx) = watch::channel(1);
                let generation = match (active_lane_generation, active_admission_owned) {
                    (Some(generation), true) => generation,
                    (Some(generation), false) => generation.saturating_add(1),
                    (None, _) => 1,
                };
                let mode = if active_lane_generation.is_some() {
                    V3ProviderActionGateMode::Sustained
                } else {
                    V3ProviderActionGateMode::Isolated
                };
                states.insert(
                    key.clone(),
                    V3ProviderActionGateState {
                        generation,
                        mode,
                        consecutive_failures: 1,
                        waiter_queue: VecDeque::new(),
                        next_waiter_ticket: 1,
                        next_admission_at: now + Duration::from_millis(mode_delay_ms(mode)),
                        admitted_generation: None,
                        admitted_action_scope: None,
                        success_transition_generation: None,
                        terminal_transition_generation: None,
                        updated_at: now,
                        change_tx,
                    },
                );
                states
                    .get_mut(key)
                    .expect("provider action gate state was just inserted")
            }
        };
        Ok(V3ProviderActionFailureRecorded {
            generation: state.generation,
            mode: state.mode,
            minimum_delay_ms: mode_delay_ms(state.mode),
            recovery_ticket: V3ProviderActionRecoveryTicket::new(key.clone(), state.generation)?,
        })
    }

    fn register_waiter(
        &self,
        key: V3ProviderActionGateKey,
        action_scope: V3ProviderActionProviderScope,
        admit_action: bool,
        expected_generation: Option<u64>,
    ) -> Result<V3ProviderActionWaiter, String> {
        let now = Instant::now();
        let (change_rx, registered_generation, ticket) = {
            let mut states = self.lock_states()?;
            let state = states
                .get_mut(&key)
                .ok_or_else(|| "provider action gate has no active failure".to_string())?;
            let ticket = state.next_waiter_ticket;
            state.next_waiter_ticket = state.next_waiter_ticket.saturating_add(1);
            state.waiter_queue.push_back(ticket);
            if state.waiter_queue.len() > 1 && state.mode == V3ProviderActionGateMode::Isolated {
                state.mode = V3ProviderActionGateMode::Sustained;
                state.next_admission_at =
                    now + Duration::from_millis(V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS);
                state.updated_at = now;
                let _ = state.change_tx.send(state.generation);
            }
            (state.change_tx.subscribe(), state.generation, ticket)
        };
        Ok(V3ProviderActionWaiter {
            gate: self.clone(),
            key,
            action_scope,
            change_rx,
            registered_generation,
            ticket,
            admit_action,
            expected_generation,
            registered: true,
        })
    }

    fn lock_states(
        &self,
    ) -> Result<MutexGuard<'_, HashMap<V3ProviderActionGateKey, V3ProviderActionGateState>>, String>
    {
        self.inner
            .states
            .lock()
            .map_err(|_| "provider action gate state lock is poisoned".to_string())
    }
}

struct V3ProviderActionWaiter {
    gate: V3ProviderActionGate,
    key: V3ProviderActionGateKey,
    action_scope: V3ProviderActionProviderScope,
    change_rx: watch::Receiver<u64>,
    registered_generation: u64,
    ticket: u64,
    admit_action: bool,
    expected_generation: Option<u64>,
    registered: bool,
}

impl V3ProviderActionWaiter {
    async fn wait(&mut self) -> Result<V3ProviderActionAdmission, String> {
        match self.wait_transition().await? {
            V3ProviderActionRecoveryTransition::Admitted(admission) => Ok(admission),
            V3ProviderActionRecoveryTransition::Superseded(ticket) => Err(format!(
                "provider action waiter generation was superseded by generation {}",
                ticket.generation()
            )),
            V3ProviderActionRecoveryTransition::ReleasedBySuccess(_) => Err(
                "provider action waiter was released by provider success without admission"
                    .to_string(),
            ),
        }
    }

    async fn wait_recovery(&mut self) -> Result<V3ProviderActionRecoveryTransition, String> {
        self.wait_transition().await
    }

    async fn wait_transition(&mut self) -> Result<V3ProviderActionRecoveryTransition, String> {
        loop {
            let wait = {
                let mut states = self.gate.lock_states()?;
                let group_has_active_admission = states.iter().any(|(key, state)| {
                    key.provider_scope.server_id == self.key.provider_scope.server_id
                        && key.provider_scope.routing_group == self.key.provider_scope.routing_group
                        && key.provider_scope.session_id == self.key.provider_scope.session_id
                        && state.admitted_generation == Some(state.generation)
                });
                let Some(state) = states.get_mut(&self.key) else {
                    self.registered = false;
                    return Err(
                        "provider action gate state disappeared without an explicit transition"
                            .to_string(),
                    );
                };
                if self
                    .expected_generation
                    .is_some_and(|generation| state.generation > generation)
                {
                    let transition =
                        if state.success_transition_generation == Some(state.generation) {
                            V3ProviderActionRecoveryTransition::ReleasedBySuccess(
                                V3ProviderActionRecoveryTicket::new(
                                    self.key.clone(),
                                    state.generation,
                                )?,
                            )
                        } else {
                            V3ProviderActionRecoveryTransition::Superseded(
                                V3ProviderActionRecoveryTicket::new(
                                    self.key.clone(),
                                    state.generation,
                                )?,
                            )
                        };
                    unregister_waiter(state, self.ticket);
                    self.registered = false;
                    return Ok(transition);
                }
                if state.success_transition_generation == Some(state.generation)
                    && self.registered_generation < state.generation
                {
                    let admission = V3ProviderActionAdmission {
                        generation: state.generation,
                        mode: state.mode,
                        minimum_delay_ms: mode_delay_ms(state.mode),
                        released_by_success: true,
                        reevaluate_after_terminal: false,
                        refreshed_recovery_witness: None,
                        permit: None,
                    };
                    unregister_waiter(state, self.ticket);
                    self.registered = false;
                    return Ok(V3ProviderActionRecoveryTransition::Admitted(admission));
                }
                if state.terminal_transition_generation == Some(state.generation)
                    && self.registered_generation < state.generation
                {
                    let admission = V3ProviderActionAdmission {
                        generation: state.generation,
                        mode: state.mode,
                        minimum_delay_ms: mode_delay_ms(state.mode),
                        released_by_success: false,
                        reevaluate_after_terminal: true,
                        refreshed_recovery_witness: Some(
                            self.key.recovery_witness(state.generation)?,
                        ),
                        permit: None,
                    };
                    unregister_waiter(state, self.ticket);
                    self.registered = false;
                    return Ok(V3ProviderActionRecoveryTransition::Admitted(admission));
                }
                let now = Instant::now();
                let admission = if now >= state.next_admission_at
                    && (!self.admit_action || !group_has_active_admission)
                    && state.waiter_queue.front() == Some(&self.ticket)
                {
                    let admission_mode = state.mode;
                    let admission_generation = state.generation;
                    if self.admit_action {
                        state.admitted_generation = Some(admission_generation);
                        state.admitted_action_scope = Some(self.action_scope.clone());
                        state.mode = V3ProviderActionGateMode::Sustained;
                        state.next_admission_at =
                            now + Duration::from_millis(V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS);
                    }
                    state.updated_at = now;
                    let admission = V3ProviderActionAdmission {
                        generation: admission_generation,
                        mode: admission_mode,
                        minimum_delay_ms: mode_delay_ms(admission_mode),
                        released_by_success: false,
                        reevaluate_after_terminal: false,
                        refreshed_recovery_witness: None,
                        permit: self.admit_action.then(|| V3ProviderActionPermit {
                            gate: self.gate.clone(),
                            key: self.key.clone(),
                            generation: admission_generation,
                            armed: true,
                        }),
                    };
                    unregister_waiter(state, self.ticket);
                    let _ = state.change_tx.send(state.generation);
                    self.registered = false;
                    Some((
                        admission,
                        self.key.provider_scope.server_id.clone(),
                        self.key.provider_scope.routing_group.clone(),
                    ))
                } else {
                    None
                };
                if let Some((admission, server_id, routing_group)) = admission {
                    for (sibling_key, sibling) in states.iter_mut().filter(|(sibling_key, _)| {
                        **sibling_key != self.key
                            && sibling_key.provider_scope.server_id == server_id
                            && sibling_key.provider_scope.routing_group == routing_group
                            && sibling_key.provider_scope.session_id
                                == self.key.provider_scope.session_id
                    }) {
                        let _ = sibling_key;
                        sibling.mode = V3ProviderActionGateMode::Sustained;
                        sibling.next_admission_at =
                            now + Duration::from_millis(V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS);
                        sibling.updated_at = now;
                        let _ = sibling.change_tx.send(sibling.generation);
                    }
                    return Ok(V3ProviderActionRecoveryTransition::Admitted(admission));
                }
                states.get(&self.key).and_then(|state| {
                    if state.waiter_queue.front() != Some(&self.ticket) {
                        None
                    } else if group_has_active_admission {
                        None
                    } else {
                        Some(state.next_admission_at.saturating_duration_since(now))
                    }
                })
            };

            if let Some(wait) = wait {
                tokio::select! {
                    _ = tokio::time::sleep(wait) => {}
                    changed = self.change_rx.changed() => {
                        if changed.is_err() {
                            self.registered = false;
                            return Err(
                                "provider action gate notification channel closed without an explicit transition"
                                    .to_string(),
                            );
                        }
                    }
                }
            } else if self.change_rx.changed().await.is_err() {
                self.registered = false;
                return Err(
                    "provider action gate notification channel closed without an explicit transition"
                        .to_string(),
                );
            }
        }
    }
}

impl Drop for V3ProviderActionWaiter {
    fn drop(&mut self) {
        if !self.registered {
            return;
        }
        if let Ok(mut states) = self.gate.inner.states.lock() {
            if let Some(state) = states.get_mut(&self.key) {
                unregister_waiter(state, self.ticket);
            }
        }
    }
}

fn unregister_waiter(state: &mut V3ProviderActionGateState, ticket: u64) {
    if let Some(index) = state
        .waiter_queue
        .iter()
        .position(|queued| *queued == ticket)
    {
        state.waiter_queue.remove(index);
    }
    state.updated_at = Instant::now();
    let _ = state.change_tx.send(state.generation);
}

fn mode_delay_ms(mode: V3ProviderActionGateMode) -> u64 {
    match mode {
        V3ProviderActionGateMode::Isolated => V3_PROVIDER_ACTION_ISOLATED_DELAY_MS,
        V3ProviderActionGateMode::Medium => V3_PROVIDER_ACTION_MEDIUM_DELAY_MS,
        V3ProviderActionGateMode::Sustained => V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS,
    }
}

fn prune_idle_states(states: &mut HashMap<V3ProviderActionGateKey, V3ProviderActionGateState>) {
    let now = Instant::now();
    states.retain(|_, state| {
        !state.waiter_queue.is_empty()
            || state.admitted_generation.is_some()
            || now.saturating_duration_since(state.updated_at)
                < Duration::from_millis(V3_PROVIDER_ACTION_IDLE_TTL_MS)
    });
}

fn required_scope_part(value: String, field: &str) -> Result<String, String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(format!("provider action gate {field} cannot be empty"));
    }
    Ok(normalized.to_string())
}

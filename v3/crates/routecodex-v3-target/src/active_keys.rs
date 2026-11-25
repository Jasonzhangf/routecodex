//! Active key selection control. Provider health and business payloads have no
//! ownership here. Callers supply already eligible identities from one bucket.
use routecodex_v3_config::{V3ActiveKeyFailureAction, V3ActiveKeyPolicy, V3SelectionStrategy};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct V3ActiveKeyIdentity {
    pub provider_id: String,
    pub interface_id: String,
    pub model_id: String,
    pub auth_alias: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct V3ActiveKeyScope {
    pub listener_id: String,
    pub routing_group_id: String,
    pub pool_id: String,
}

pub struct V3ActiveKeySelectionContext<'a> {
    pub listener_id: &'a str,
    pub session_id: Option<&'a str>,
    pub state: &'a V3ActiveKeySelectionState,
    pub excluded: &'a BTreeSet<V3ActiveKeyIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ActiveKeySelection {
    pub scope: V3ActiveKeyScope,
    pub identity: V3ActiveKeyIdentity,
    transition: u64,
    session_id: Option<String>,
    session_revision: u64,
    retries: u32,
    on_failure: V3ActiveKeyFailureAction,
}

/// Request-local state. Reuse this object for same-key retries; do not choose
/// again or advance assignment cursors when sending another attempt.
#[derive(Debug)]
pub struct V3ActiveKeyEpisode {
    pub selection: V3ActiveKeySelection,
    sends: u64,
    completed_send: u64,
    closed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ActiveKeyFailureFeedback {
    pub applied: bool,
    pub stale: bool,
    pub consecutive_failures: u32,
    pub transitioned: bool,
    pub durability_error: Option<String>,
}

impl V3ActiveKeyEpisode {
    pub fn new(selection: V3ActiveKeySelection) -> Self {
        Self {
            selection,
            sends: 0,
            completed_send: 0,
            closed: false,
        }
    }

    /// Call at the actual send boundary, after checking current health and
    /// cancellation. Selection/planning never consumes retry budget.
    pub fn begin_attempt(&mut self) -> Option<()> {
        if self.closed || self.sends > u64::from(self.selection.retries) {
            return None;
        }
        self.sends += 1;
        Some(())
    }

    pub fn can_retry(&self, still_eligible: bool) -> bool {
        !self.closed
            && self.sends > 0
            && self.sends <= u64::from(self.selection.retries)
            && still_eligible
    }

    /// Cancellation or request-local incompatibility closes only the episode.
    /// It must never hold an otherwise usable account.
    pub fn cancel(&mut self) {
        self.closed = true;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ActiveKeySnapshot {
    pub scope: V3ActiveKeyScope,
    pub policy: V3ActiveKeyPolicy,
    pub strategy: V3SelectionStrategy,
    pub order: Vec<V3ActiveKeyIdentity>,
    pub held: BTreeSet<V3ActiveKeyIdentity>,
    pub persistence_error: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum V3ActiveKeyStateError {
    #[error("active key scope is not configured")]
    UnknownScope,
    #[error("active key member is not configured in this scope")]
    UnknownMember,
    #[error("active key policy supports active_queue, round_robin, or sticky only")]
    InvalidStrategy,
    #[error("active key state persistence failed: {0}")]
    Persistence(String),
}

#[derive(Debug)]
pub struct V3ActiveKeySelectionState {
    store: Mutex<Store>,
    persistence: Mutex<()>,
    path: Option<PathBuf>,
}

#[derive(Debug, Default)]
struct Store {
    pools: BTreeMap<V3ActiveKeyScope, Pool>,
    retained: BTreeMap<V3ActiveKeyScope, BTreeSet<V3ActiveKeyIdentity>>,
    tick: u64,
    persistence_error: Option<String>,
}

#[derive(Debug)]
struct Pool {
    policy: V3ActiveKeyPolicy,
    strategy: V3SelectionStrategy,
    order: Vec<V3ActiveKeyIdentity>,
    held: BTreeSet<V3ActiveKeyIdentity>,
    transitions: BTreeMap<V3ActiveKeyIdentity, u64>,
    failures: BTreeMap<V3ActiveKeyIdentity, u32>,
    next: Option<V3ActiveKeyIdentity>,
    sessions: BTreeMap<String, SessionAffinity>,
}

#[derive(Debug)]
struct SessionAffinity {
    binding: Option<V3ActiveKeyIdentity>,
    // A provisional choice must not supersede accepted business success.
    revision: u64,
    used: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Persisted {
    holds: Vec<PersistedPool>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PersistedPool {
    scope: V3ActiveKeyScope,
    held: BTreeSet<V3ActiveKeyIdentity>,
}

impl Default for V3ActiveKeySelectionState {
    fn default() -> Self {
        Self {
            store: Mutex::new(Store::default()),
            persistence: Mutex::new(()),
            path: None,
        }
    }
}

impl V3ActiveKeySelectionState {
    /// Explicit state path supplied by listener construction. Never derive a
    /// production path or silently release holds after malformed state.
    pub fn from_file(path: impl Into<PathBuf>) -> Result<Self, V3ActiveKeyStateError> {
        let path = path.into();
        let retained = match std::fs::read(&path) {
            Ok(bytes) => {
                let state: Persisted = serde_json::from_slice(&bytes)
                    .map_err(|error| V3ActiveKeyStateError::Persistence(error.to_string()))?;
                state
                    .holds
                    .into_iter()
                    .map(|entry| (entry.scope, entry.held))
                    .collect()
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
            Err(error) => return Err(V3ActiveKeyStateError::Persistence(error.to_string())),
        };
        Ok(Self {
            store: Mutex::new(Store {
                retained,
                ..Store::default()
            }),
            persistence: Mutex::new(()),
            path: Some(path),
        })
    }

    /// Universe must be expanded from declared pool targets without request
    /// filters. Membership is intersected here again, never unioned into routes.
    pub fn configure(
        &self,
        scope: V3ActiveKeyScope,
        policy: V3ActiveKeyPolicy,
        strategy: V3SelectionStrategy,
        universe: &[V3ActiveKeyIdentity],
    ) -> Result<(), V3ActiveKeyStateError> {
        if !matches!(
            strategy,
            V3SelectionStrategy::ActiveQueue
                | V3SelectionStrategy::RoundRobin
                | V3SelectionStrategy::Sticky
        ) {
            return Err(V3ActiveKeyStateError::InvalidStrategy);
        }
        let mut order = Vec::new();
        for member in &policy.members {
            for identity in universe {
                if identity.provider_id == member.provider
                    && identity.auth_alias == member.alias
                    && !order.contains(identity)
                {
                    order.push(identity.clone());
                }
            }
        }
        let mut store = self.store.lock().expect("active key state lock");
        let retained = store.retained.get(&scope).cloned().unwrap_or_default();
        let previous = store.pools.remove(&scope);
        let mut pool = previous.unwrap_or_else(|| Pool {
            policy: policy.clone(),
            strategy: strategy.clone(),
            order: order.clone(),
            held: retained,
            transitions: BTreeMap::new(),
            failures: BTreeMap::new(),
            next: None,
            sessions: BTreeMap::new(),
        });
        pool.order.retain(|identity| order.contains(identity));
        for identity in &order {
            if !pool.order.contains(identity) {
                pool.order.push(identity.clone());
            }
            pool.transitions.entry(identity.clone()).or_insert(0);
            pool.failures.entry(identity.clone()).or_insert(0);
        }
        pool.held.retain(|identity| order.contains(identity));
        pool.transitions
            .retain(|identity, _| order.contains(identity));
        pool.failures.retain(|identity, _| order.contains(identity));
        for session in pool.sessions.values_mut() {
            if session
                .binding
                .as_ref()
                .is_some_and(|identity| !order.contains(identity) || pool.held.contains(identity))
            {
                session.binding = None;
            }
        }
        pool.policy = policy;
        pool.strategy = strategy;
        store.pools.insert(scope, pool);
        Ok(())
    }

    /// `eligible` is one final existing tier/effective-priority bucket. Queue
    /// order and sticky preferences cannot promote a lower-priority candidate.
    pub fn choose(
        &self,
        scope: &V3ActiveKeyScope,
        eligible: &BTreeSet<V3ActiveKeyIdentity>,
        excluded: &BTreeSet<V3ActiveKeyIdentity>,
        session_id: Option<&str>,
    ) -> Result<Option<V3ActiveKeySelection>, V3ActiveKeyStateError> {
        let mut store = self.store.lock().expect("active key state lock");
        store.tick = store.tick.wrapping_add(1);
        let tick = store.tick;
        let pool = store
            .pools
            .get_mut(scope)
            .ok_or(V3ActiveKeyStateError::UnknownScope)?;
        let allowed = |identity: &&V3ActiveKeyIdentity| {
            eligible.contains(*identity)
                && !excluded.contains(*identity)
                && !pool.held.contains(*identity)
        };
        let available = pool
            .order
            .iter()
            .filter(allowed)
            .cloned()
            .collect::<Vec<_>>();
        if available.is_empty() {
            return Ok(None);
        }
        let session_id = session_id.filter(|session| !session.is_empty());
        let preferred = if pool.strategy == V3SelectionStrategy::Sticky {
            session_id
                .and_then(|session| pool.sessions.get(session))
                .and_then(|session| session.binding.as_ref())
                .filter(|identity| available.contains(identity))
                .cloned()
        } else {
            None
        };
        let chosen = preferred.unwrap_or_else(|| {
            if pool.strategy == V3SelectionStrategy::ActiveQueue {
                return available[0].clone();
            }
            let start = pool
                .next
                .as_ref()
                .and_then(|next| pool.order.iter().position(|identity| identity == next))
                .unwrap_or(0);
            let index = (0..pool.order.len())
                .map(|offset| (start + offset) % pool.order.len())
                .find(|index| available.contains(&pool.order[*index]))
                .expect("nonempty eligible active members");
            pool.next = Some(pool.order[(index + 1) % pool.order.len()].clone());
            pool.order[index].clone()
        });
        if pool.strategy == V3SelectionStrategy::Sticky {
            if let Some(session_id) = session_id {
                let session =
                    pool.sessions
                        .entry(session_id.to_owned())
                        .or_insert(SessionAffinity {
                            binding: None,
                            revision: 0,
                            used: tick,
                        });
                session.used = tick;
                if pool.sessions.len() > 4096 {
                    let oldest = pool
                        .sessions
                        .iter()
                        .min_by_key(|(_, session)| session.used)
                        .map(|(id, _)| id.clone())
                        .expect("nonempty sessions");
                    pool.sessions.remove(&oldest);
                }
            }
        }
        Ok(Some(V3ActiveKeySelection {
            scope: scope.clone(),
            transition: pool.transitions[&chosen],
            identity: chosen,
            session_id: session_id.map(str::to_string),
            session_revision: tick,
            retries: pool.policy.retries,
            on_failure: pool.policy.on_failure,
        }))
    }

    /// Call only after full attempt governance accepted a business result.
    /// A stale success never clears a hold or overwrites a post-release choice.
    pub fn accepted_success(
        &self,
        episode: &mut V3ActiveKeyEpisode,
    ) -> Result<bool, V3ActiveKeyStateError> {
        if episode.closed || episode.sends == 0 || episode.completed_send == episode.sends {
            return Ok(false);
        }
        episode.closed = true;
        episode.completed_send = episode.sends;
        let mut store = self.store.lock().expect("active key state lock");
        store.tick = store.tick.wrapping_add(1);
        let tick = store.tick;
        let pool = store
            .pools
            .get_mut(&episode.selection.scope)
            .ok_or(V3ActiveKeyStateError::UnknownScope)?;
        let selection = &episode.selection;
        if pool.held.contains(&selection.identity)
            || pool.transitions.get(&selection.identity) != Some(&selection.transition)
        {
            return Ok(false);
        }
        pool.failures.insert(selection.identity.clone(), 0);
        if pool.strategy == V3SelectionStrategy::Sticky {
            if let Some(session) = &selection.session_id {
                if let Some(binding) = pool
                    .sessions
                    .get_mut(session)
                    .filter(|binding| binding.revision <= selection.session_revision)
                {
                    binding.binding = Some(selection.identity.clone());
                    binding.revision = selection.session_revision;
                    binding.used = tick;
                }
            }
        }
        Ok(true)
    }

    /// Consume one failed actual dispatch. The shared streak is independent of
    /// request retry budgets. A generation change makes late outcomes stale.
    pub fn record_delivery_failure(
        &self,
        episode: &mut V3ActiveKeyEpisode,
    ) -> Result<V3ActiveKeyFailureFeedback, V3ActiveKeyStateError> {
        let mut store = self.store.lock().expect("active key state lock");
        let selection = &episode.selection;
        let pool = store
            .pools
            .get_mut(&selection.scope)
            .ok_or(V3ActiveKeyStateError::UnknownScope)?;
        let stale = pool.transitions.get(&selection.identity) != Some(&selection.transition);
        let mut feedback = V3ActiveKeyFailureFeedback {
            applied: false,
            stale,
            consecutive_failures: pool.failures.get(&selection.identity).copied().unwrap_or(0),
            transitioned: false,
            durability_error: None,
        };
        if stale {
            episode.closed = true;
        }
        if episode.closed || episode.sends == 0 || episode.completed_send == episode.sends {
            return Ok(feedback);
        }
        episode.completed_send = episode.sends;
        let count = pool.failures.entry(selection.identity.clone()).or_default();
        *count += 1;
        feedback.applied = true;
        feedback.consecutive_failures = *count;
        if *count < 4 {
            return Ok(feedback);
        }
        *count = 0;
        feedback.transitioned = true;
        episode.closed = true;
        *pool
            .transitions
            .get_mut(&selection.identity)
            .expect("known transition") += 1;
        let held_changed = match selection.on_failure {
            V3ActiveKeyFailureAction::Hold => pool.held.insert(selection.identity.clone()),
            V3ActiveKeyFailureAction::Tail => {
                move_to_tail(pool, &selection.identity);
                false
            }
        };
        for session in pool.sessions.values_mut() {
            if session.binding.as_ref() == Some(&selection.identity) {
                session.binding = None;
            }
        }
        drop(store);
        if held_changed {
            if let Err(error) = self.persist() {
                feedback.durability_error = Some(error.to_string());
            }
        }
        Ok(feedback)
    }

    /// Close only this request's episode. Earlier failures stay counted until
    /// an accepted business success or the fourth-failure transition.
    pub fn close_failure(
        &self,
        episode: &mut V3ActiveKeyEpisode,
    ) -> Result<bool, V3ActiveKeyStateError> {
        let changed = !episode.closed && episode.sends > 0;
        episode.closed = true;
        Ok(changed)
    }

    pub fn release(
        &self,
        scope: &V3ActiveKeyScope,
        identity: &V3ActiveKeyIdentity,
    ) -> Result<bool, V3ActiveKeyStateError> {
        let mut store = self.store.lock().expect("active key state lock");
        let pool = store
            .pools
            .get_mut(scope)
            .ok_or(V3ActiveKeyStateError::UnknownScope)?;
        let transition = pool
            .transitions
            .get_mut(identity)
            .ok_or(V3ActiveKeyStateError::UnknownMember)?;
        let changed = pool.held.remove(identity);
        if changed {
            *transition += 1;
            pool.failures.insert(identity.clone(), 0);
            move_to_tail(pool, identity);
        }
        drop(store);
        // Retry persistence even for an idempotent release after a prior I/O error.
        self.persist()?;
        Ok(changed)
    }

    pub fn snapshot(
        &self,
        scope: &V3ActiveKeyScope,
    ) -> Result<V3ActiveKeySnapshot, V3ActiveKeyStateError> {
        let store = self.store.lock().expect("active key state lock");
        let pool = store
            .pools
            .get(scope)
            .ok_or(V3ActiveKeyStateError::UnknownScope)?;
        Ok(V3ActiveKeySnapshot {
            scope: scope.clone(),
            policy: pool.policy.clone(),
            strategy: pool.strategy.clone(),
            order: pool.order.clone(),
            held: pool.held.clone(),
            persistence_error: store.persistence_error.clone(),
        })
    }

    pub fn selectable(&self, scope: &V3ActiveKeyScope, identity: &V3ActiveKeyIdentity) -> bool {
        let store = self.store.lock().expect("active key state lock");
        store.pools.get(scope).is_some_and(|pool| {
            pool.transitions.contains_key(identity) && !pool.held.contains(identity)
        })
    }

    /// A tail member is eligible for a new request, but an old episode must not
    /// send another retry after a concurrent threshold or manual release.
    pub fn selection_current(&self, selection: &V3ActiveKeySelection) -> bool {
        let store = self.store.lock().expect("active key state lock");
        store.pools.get(&selection.scope).is_some_and(|pool| {
            pool.transitions.get(&selection.identity) == Some(&selection.transition)
                && !pool.held.contains(&selection.identity)
        })
    }

    fn persist(&self) -> Result<(), V3ActiveKeyStateError> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        // Serialize disk writers, but never hold the selection lock over I/O.
        // Snapshot after acquiring this lock so older writes cannot undo release.
        let _writer = self
            .persistence
            .lock()
            .expect("active key persistence lock");
        let mut store = self.store.lock().expect("active key state lock");
        let holds = store
            .pools
            .iter()
            .map(|(scope, pool)| (scope.clone(), pool.held.clone()))
            .collect::<Vec<_>>();
        for (scope, held) in holds {
            store.retained.insert(scope, held);
        }
        let state = Persisted {
            holds: store
                .retained
                .iter()
                .map(|(scope, held)| PersistedPool {
                    scope: scope.clone(),
                    held: held.clone(),
                })
                .collect(),
        };
        drop(store);
        let result = write_state(path, &state);
        let mut store = self.store.lock().expect("active key state lock");
        store.persistence_error = result.as_ref().err().map(ToString::to_string);
        result.map_err(|error| V3ActiveKeyStateError::Persistence(error.to_string()))
    }
}

fn move_to_tail(pool: &mut Pool, identity: &V3ActiveKeyIdentity) {
    let rotating = matches!(
        pool.strategy,
        V3SelectionStrategy::RoundRobin | V3SelectionStrategy::Sticky
    );
    if rotating {
        if let Some(start) = pool
            .next
            .as_ref()
            .and_then(|next| pool.order.iter().position(|member| member == next))
        {
            pool.order.rotate_left(start);
        }
    }
    pool.order.retain(|member| member != identity);
    pool.order.push(identity.clone());
    if rotating {
        pool.next = pool.order.first().cloned();
    }
}

fn write_state(path: &Path, state: &Persisted) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("active-keys.tmp");
    let result = (|| {
        std::fs::write(&temporary, serde_json::to_vec(state)?)?;
        std::fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

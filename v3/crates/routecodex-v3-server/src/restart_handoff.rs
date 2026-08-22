use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum V3FrontExecutionMode {
    Direct,
    Relay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum V3FrontContinuationOwner {
    Direct,
    Relay,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct V3FrontRequestLeaseKey {
    pub request_id: String,
    pub pipeline_id: String,
    pub server_id: String,
    pub port: u16,
    pub session_scope: String,
}

#[derive(Debug, Clone)]
pub struct V3FrontDeadlineBudget {
    absolute_deadline: Instant,
    idle_deadline: Instant,
}

impl V3FrontDeadlineBudget {
    pub fn new(now: Instant, absolute: Duration, idle: Duration) -> Self {
        Self {
            absolute_deadline: now + absolute,
            idle_deadline: now + idle,
        }
    }

    pub fn remaining(&self, now: Instant) -> (Duration, Duration) {
        (
            self.absolute_deadline.saturating_duration_since(now),
            self.idle_deadline.saturating_duration_since(now),
        )
    }

    pub fn is_expired(&self, now: Instant) -> bool {
        self.absolute_deadline <= now || self.idle_deadline <= now
    }

    pub fn observe_activity(&mut self, now: Instant, idle: Duration) {
        self.idle_deadline = (now + idle).min(self.absolute_deadline);
    }

    pub fn restore_remaining(
        now: Instant,
        absolute_remaining: Duration,
        idle_remaining: Duration,
    ) -> Self {
        Self {
            absolute_deadline: now + absolute_remaining,
            idle_deadline: now + idle_remaining.min(absolute_remaining),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3FrontFrameDecision {
    New,
    Duplicate,
    OutOfOrder,
}

#[derive(Debug, Clone, Default)]
pub struct V3FrontFrameSequence {
    next_client_sequence: u64,
    next_provider_sequence: u64,
}

impl V3FrontFrameSequence {
    pub fn observe_client(&mut self, sequence: u64) -> V3FrontFrameDecision {
        observe_next(&mut self.next_client_sequence, sequence)
    }

    pub fn observe_provider(&mut self, sequence: u64) -> V3FrontFrameDecision {
        observe_next(&mut self.next_provider_sequence, sequence)
    }

    pub fn client_next(&self) -> u64 {
        self.next_client_sequence
    }

    pub fn provider_next(&self) -> u64 {
        self.next_provider_sequence
    }
}

fn observe_next(next: &mut u64, sequence: u64) -> V3FrontFrameDecision {
    match sequence.cmp(next) {
        std::cmp::Ordering::Equal => {
            *next = next.saturating_add(1);
            V3FrontFrameDecision::New
        }
        std::cmp::Ordering::Less => V3FrontFrameDecision::Duplicate,
        std::cmp::Ordering::Greater => V3FrontFrameDecision::OutOfOrder,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3FrontLeaseState {
    Running,
    Frozen,
    Attached,
    Completed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct V3RuntimeHandoffCheckpoint {
    pub key: V3FrontRequestLeaseKey,
    pub runtime_generation: u64,
    pub execution_mode: V3FrontExecutionMode,
    pub continuation_owner: V3FrontContinuationOwner,
    pub last_client_sequence: u64,
    pub last_provider_sequence: u64,
    pub semantic_commit: bool,
    pub absolute_remaining_ms: u64,
    pub idle_remaining_ms: u64,
}

#[derive(Debug)]
pub struct V3FrontRequestLease {
    pub key: V3FrontRequestLeaseKey,
    pub execution_mode: V3FrontExecutionMode,
    pub continuation_owner: V3FrontContinuationOwner,
    pub runtime_generation: u64,
    pub state: V3FrontLeaseState,
    pub semantic_commit: bool,
    pub frame_sequence: V3FrontFrameSequence,
    pub deadline: V3FrontDeadlineBudget,
}

impl V3FrontRequestLease {
    pub fn checkpoint(&self, now: Instant) -> V3RuntimeHandoffCheckpoint {
        let (absolute, idle) = self.deadline.remaining(now);
        V3RuntimeHandoffCheckpoint {
            key: self.key.clone(),
            runtime_generation: self.runtime_generation,
            execution_mode: self.execution_mode,
            continuation_owner: self.continuation_owner,
            last_client_sequence: self.frame_sequence.client_next().saturating_sub(1),
            last_provider_sequence: self.frame_sequence.provider_next().saturating_sub(1),
            semantic_commit: self.semantic_commit,
            absolute_remaining_ms: absolute.as_millis().min(u64::MAX as u128) as u64,
            idle_remaining_ms: idle.as_millis().min(u64::MAX as u128) as u64,
        }
    }

    pub fn reattach(
        checkpoint: &V3RuntimeHandoffCheckpoint,
        now: Instant,
        new_generation: u64,
    ) -> Self {
        let mut frame_sequence = V3FrontFrameSequence::default();
        frame_sequence.next_client_sequence = checkpoint.last_client_sequence.saturating_add(1);
        frame_sequence.next_provider_sequence = checkpoint.last_provider_sequence.saturating_add(1);
        Self {
            key: checkpoint.key.clone(),
            execution_mode: checkpoint.execution_mode,
            continuation_owner: checkpoint.continuation_owner,
            runtime_generation: new_generation,
            state: V3FrontLeaseState::Attached,
            semantic_commit: checkpoint.semantic_commit,
            frame_sequence,
            deadline: V3FrontDeadlineBudget::restore_remaining(
                now,
                Duration::from_millis(checkpoint.absolute_remaining_ms),
                Duration::from_millis(checkpoint.idle_remaining_ms),
            ),
        }
    }
}

#[derive(Debug, Default)]
pub struct V3FrontRequestLeaseRegistry {
    leases: BTreeMap<V3FrontRequestLeaseKey, V3FrontLeaseState>,
}

impl V3FrontRequestLeaseRegistry {
    pub fn insert(&mut self, lease: &V3FrontRequestLease) -> Option<V3FrontLeaseState> {
        self.leases.insert(lease.key.clone(), lease.state)
    }

    pub fn state(&self, key: &V3FrontRequestLeaseKey) -> Option<V3FrontLeaseState> {
        self.leases.get(key).copied()
    }

    pub fn remove(&mut self, key: &V3FrontRequestLeaseKey) -> Option<V3FrontLeaseState> {
        self.leases.remove(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> V3FrontRequestLeaseKey {
        V3FrontRequestLeaseKey {
            request_id: "req-1".into(),
            pipeline_id: "pipe-1".into(),
            server_id: "server-1".into(),
            port: 7777,
            session_scope: "session-1".into(),
        }
    }

    fn lease(now: Instant) -> V3FrontRequestLease {
        V3FrontRequestLease {
            key: key(),
            execution_mode: V3FrontExecutionMode::Relay,
            continuation_owner: V3FrontContinuationOwner::Relay,
            runtime_generation: 4,
            state: V3FrontLeaseState::Running,
            semantic_commit: false,
            frame_sequence: V3FrontFrameSequence::default(),
            deadline: V3FrontDeadlineBudget::new(
                now,
                Duration::from_secs(120),
                Duration::from_secs(15),
            ),
        }
    }

    #[test]
    fn frame_sequence_rejects_duplicate_and_out_of_order_frames() {
        let mut sequence = V3FrontFrameSequence::default();
        assert_eq!(sequence.observe_client(0), V3FrontFrameDecision::New);
        assert_eq!(sequence.observe_client(0), V3FrontFrameDecision::Duplicate);
        assert_eq!(sequence.observe_client(2), V3FrontFrameDecision::OutOfOrder);
        assert_eq!(sequence.observe_client(1), V3FrontFrameDecision::New);
    }

    #[test]
    fn reattach_preserves_mode_owner_commit_and_sequence() {
        let now = Instant::now();
        let mut lease = lease(now);
        assert_eq!(
            lease.frame_sequence.observe_client(0),
            V3FrontFrameDecision::New
        );
        assert_eq!(
            lease.frame_sequence.observe_provider(0),
            V3FrontFrameDecision::New
        );
        lease.semantic_commit = true;
        let checkpoint = lease.checkpoint(now + Duration::from_secs(1));
        let restored = V3FrontRequestLease::reattach(&checkpoint, now + Duration::from_secs(2), 5);
        assert_eq!(restored.execution_mode, V3FrontExecutionMode::Relay);
        assert_eq!(restored.continuation_owner, V3FrontContinuationOwner::Relay);
        assert!(restored.semantic_commit);
        assert_eq!(restored.runtime_generation, 5);
        assert_eq!(restored.frame_sequence.client_next(), 1);
        assert_eq!(restored.frame_sequence.provider_next(), 1);
    }

    #[test]
    fn reattach_never_extends_the_absolute_deadline() {
        let now = Instant::now();
        let lease = lease(now);
        let checkpoint = lease.checkpoint(now + Duration::from_secs(119));
        let restored =
            V3FrontRequestLease::reattach(&checkpoint, now + Duration::from_secs(119), 5);
        let (absolute, _) = restored.deadline.remaining(now + Duration::from_secs(120));
        assert!(absolute.is_zero());
    }

    #[test]
    fn registry_is_keyed_by_full_request_scope() {
        let now = Instant::now();
        let lease = lease(now);
        let mut registry = V3FrontRequestLeaseRegistry::default();
        assert_eq!(registry.insert(&lease), None);
        assert_eq!(registry.state(&lease.key), Some(V3FrontLeaseState::Running));
        assert_eq!(
            registry.remove(&lease.key),
            Some(V3FrontLeaseState::Running)
        );
        assert_eq!(registry.state(&lease.key), None);
    }
}

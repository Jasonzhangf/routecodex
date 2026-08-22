use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum V3ProviderTransportKind {
    Http,
    WebSocketV2,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum V3ProviderTransportAttemptState {
    Connecting,
    Streaming,
    Detached,
    Terminal,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct V3ProviderTransportAttemptKey {
    pub request_id: String,
    pub provider_id: String,
    pub attempt_id: u64,
}

/// Request-scoped control identity for provider transport handoff. This is
/// never serialized into a provider request or client response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct V3ProviderTransportHandoffScope {
    pub pipeline_id: String,
    pub server_id: String,
    pub port: u16,
    pub session_scope: String,
    pub runtime_generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct V3ProviderTransportCheckpoint {
    pub key: V3ProviderTransportAttemptKey,
    pub scope: V3ProviderTransportHandoffScope,
    pub kind: V3ProviderTransportKind,
    pub state: V3ProviderTransportAttemptState,
    pub next_provider_sequence: u64,
    pub runtime_generation: u64,
}

#[derive(Debug, Clone)]
struct V3ProviderTransportAttempt {
    checkpoint: V3ProviderTransportCheckpoint,
}

#[derive(Debug, Clone, Default)]
pub struct V3ProviderTransportAttemptBroker {
    attempts: Arc<Mutex<BTreeMap<V3ProviderTransportAttemptKey, V3ProviderTransportAttempt>>>,
    next_attempt_ids: Arc<Mutex<BTreeMap<(String, String), u64>>>,
}

impl V3ProviderTransportAttemptBroker {
    pub fn begin_next(
        &self,
        request_id: impl Into<String>,
        provider_id: impl Into<String>,
        kind: V3ProviderTransportKind,
        scope: V3ProviderTransportHandoffScope,
    ) -> Result<V3ProviderTransportAttemptKey, String> {
        let request_id = request_id.into();
        let provider_id = provider_id.into();
        let attempt_id = {
            let mut next_ids = self
                .next_attempt_ids
                .lock()
                .expect("provider transport attempt id lock");
            let key = (request_id.clone(), provider_id.clone());
            let attempt_id = next_ids.get(&key).copied().unwrap_or(0);
            next_ids.insert(key, attempt_id.saturating_add(1));
            attempt_id
        };
        let key = V3ProviderTransportAttemptKey {
            request_id,
            provider_id,
            attempt_id,
        };
        self.begin(key.clone(), kind, scope)?;
        Ok(key)
    }

    pub fn begin(
        &self,
        key: V3ProviderTransportAttemptKey,
        kind: V3ProviderTransportKind,
        scope: V3ProviderTransportHandoffScope,
    ) -> Result<(), String> {
        let mut attempts = self
            .attempts
            .lock()
            .expect("provider transport attempt lock");
        if attempts.contains_key(&key) {
            return Err("provider transport attempt key is already active".to_string());
        }
        let runtime_generation = scope.runtime_generation;
        attempts.insert(
            key.clone(),
            V3ProviderTransportAttempt {
                checkpoint: V3ProviderTransportCheckpoint {
                    key,
                    scope,
                    kind,
                    state: V3ProviderTransportAttemptState::Connecting,
                    next_provider_sequence: 0,
                    runtime_generation,
                },
            },
        );
        Ok(())
    }

    pub fn state(
        &self,
        key: &V3ProviderTransportAttemptKey,
    ) -> Option<V3ProviderTransportAttemptState> {
        self.attempts
            .lock()
            .expect("provider transport attempt lock")
            .get(key)
            .map(|attempt| attempt.checkpoint.state)
    }

    pub fn transition(
        &self,
        key: &V3ProviderTransportAttemptKey,
        state: V3ProviderTransportAttemptState,
    ) -> Result<(), String> {
        let mut attempts = self
            .attempts
            .lock()
            .expect("provider transport attempt lock");
        let attempt = attempts
            .get_mut(key)
            .ok_or_else(|| "provider transport attempt key is not registered".to_string())?;
        let current = attempt.checkpoint.state;
        let allowed = matches!(
            (current, state),
            (V3ProviderTransportAttemptState::Connecting, V3ProviderTransportAttemptState::Streaming)
                | (V3ProviderTransportAttemptState::Connecting, V3ProviderTransportAttemptState::Detached)
                | (V3ProviderTransportAttemptState::Connecting, V3ProviderTransportAttemptState::Terminal)
                | (V3ProviderTransportAttemptState::Connecting, V3ProviderTransportAttemptState::Failed)
                | (V3ProviderTransportAttemptState::Streaming, V3ProviderTransportAttemptState::Detached)
                | (V3ProviderTransportAttemptState::Streaming, V3ProviderTransportAttemptState::Terminal)
                | (V3ProviderTransportAttemptState::Streaming, V3ProviderTransportAttemptState::Failed)
                | (V3ProviderTransportAttemptState::Detached, V3ProviderTransportAttemptState::Streaming)
                | (V3ProviderTransportAttemptState::Detached, V3ProviderTransportAttemptState::Terminal)
                | (V3ProviderTransportAttemptState::Detached, V3ProviderTransportAttemptState::Failed)
        );
        if !allowed {
            return Err(format!(
                "provider transport attempt cannot transition from {current:?} to {state:?}"
            ));
        }
        attempt.checkpoint.state = state;
        Ok(())
    }

    pub fn observe_provider_frame(
        &self,
        key: &V3ProviderTransportAttemptKey,
        sequence: u64,
    ) -> Result<bool, String> {
        let mut attempts = self
            .attempts
            .lock()
            .expect("provider transport attempt lock");
        let attempt = attempts
            .get_mut(key)
            .ok_or_else(|| "provider transport attempt key is not registered".to_string())?;
        if sequence != attempt.checkpoint.next_provider_sequence {
            return Ok(false);
        }
        attempt.checkpoint.next_provider_sequence =
            attempt.checkpoint.next_provider_sequence.saturating_add(1);
        Ok(true)
    }

    pub fn checkpoint(
        &self,
        key: &V3ProviderTransportAttemptKey,
    ) -> Option<V3ProviderTransportCheckpoint> {
        self.attempts
            .lock()
            .expect("provider transport attempt lock")
            .get(key)
            .map(|attempt| attempt.checkpoint.clone())
    }

    pub fn checkpoints(&self) -> Vec<V3ProviderTransportCheckpoint> {
        self.attempts
            .lock()
            .expect("provider transport attempt lock")
            .values()
            .map(|attempt| attempt.checkpoint.clone())
            .collect()
    }

    pub fn restore_detached(
        &self,
        checkpoints: &[V3ProviderTransportCheckpoint],
    ) -> Result<usize, String> {
        let mut attempts = self
            .attempts
            .lock()
            .expect("provider transport attempt lock");
        let mut restored_next_ids = BTreeMap::<(String, String), u64>::new();
        for checkpoint in checkpoints {
            if checkpoint.key.request_id.trim().is_empty()
                || checkpoint.key.provider_id.trim().is_empty()
                || checkpoint.scope.pipeline_id.trim().is_empty()
                || checkpoint.scope.server_id.trim().is_empty()
                || checkpoint.scope.session_scope.trim().is_empty()
                || checkpoint.scope.port == 0
                || checkpoint.scope.runtime_generation == 0
            {
                return Err("provider transport checkpoint has incomplete scope".to_string());
            }
            if attempts.contains_key(&checkpoint.key) {
                return Err("provider transport checkpoint key is already active".to_string());
            }
            let mut restored = checkpoint.clone();
            if matches!(
                restored.state,
                V3ProviderTransportAttemptState::Connecting
                    | V3ProviderTransportAttemptState::Streaming
            ) {
                restored.state = V3ProviderTransportAttemptState::Detached;
            }
            let next_id = restored_next_ids
                .entry((
                    restored.key.request_id.clone(),
                    restored.key.provider_id.clone(),
                ))
                .or_insert(0);
            *next_id = (*next_id).max(restored.key.attempt_id.saturating_add(1));
            attempts.insert(
                restored.key.clone(),
                V3ProviderTransportAttempt { checkpoint: restored },
            );
        }
        drop(attempts);
        let mut next_ids = self
            .next_attempt_ids
            .lock()
            .expect("provider transport attempt id lock");
        for (key, next_id) in restored_next_ids {
            let current = next_ids.entry(key).or_insert(0);
            *current = (*current).max(next_id);
        }
        Ok(checkpoints.len())
    }

    pub fn remove(
        &self,
        key: &V3ProviderTransportAttemptKey,
    ) -> Option<V3ProviderTransportCheckpoint> {
        self.attempts
            .lock()
            .expect("provider transport attempt lock")
            .remove(key)
            .map(|attempt| attempt.checkpoint)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> V3ProviderTransportAttemptKey {
        V3ProviderTransportAttemptKey {
            request_id: "req-1".into(),
            provider_id: "provider-1".into(),
            attempt_id: 1,
        }
    }

    fn scope(generation: u64) -> V3ProviderTransportHandoffScope {
        V3ProviderTransportHandoffScope {
            pipeline_id: "pipeline-1".into(),
            server_id: "server-1".into(),
            port: 7777,
            session_scope: "session-1".into(),
            runtime_generation: generation,
        }
    }

    #[test]
    fn provider_transport_attempt_tracks_state_and_sequence() {
        let broker = V3ProviderTransportAttemptBroker::default();
        let key = key();
        broker
            .begin(key.clone(), V3ProviderTransportKind::Http, scope(7))
            .unwrap();
        assert_eq!(
            broker.state(&key),
            Some(V3ProviderTransportAttemptState::Connecting)
        );
        broker
            .transition(&key, V3ProviderTransportAttemptState::Streaming)
            .unwrap();
        assert!(broker.observe_provider_frame(&key, 0).unwrap());
        assert!(!broker.observe_provider_frame(&key, 0).unwrap());
        assert_eq!(broker.checkpoint(&key).unwrap().next_provider_sequence, 1);
    }

    #[test]
    fn provider_transport_attempt_rejects_duplicate_key() {
        let broker = V3ProviderTransportAttemptBroker::default();
        let key = key();
        broker
            .begin(key.clone(), V3ProviderTransportKind::WebSocketV2, scope(3))
            .unwrap();
        assert!(broker
            .begin(key, V3ProviderTransportKind::WebSocketV2, scope(4))
            .is_err());
    }

    #[test]
    fn provider_transport_attempt_terminal_is_exactly_once() {
        let broker = V3ProviderTransportAttemptBroker::default();
        let key = key();
        broker
            .begin(key.clone(), V3ProviderTransportKind::Http, scope(3))
            .unwrap();
        broker
            .transition(&key, V3ProviderTransportAttemptState::Terminal)
            .unwrap();
        assert!(broker
            .transition(&key, V3ProviderTransportAttemptState::Failed)
            .is_err());
        assert!(broker
            .transition(&key, V3ProviderTransportAttemptState::Terminal)
            .is_err());
        assert_eq!(
            broker.state(&key),
            Some(V3ProviderTransportAttemptState::Terminal)
        );
    }

    #[test]
    fn provider_transport_checkpoint_restores_active_attempt_as_detached() {
        let source = V3ProviderTransportAttemptBroker::default();
        let key = key();
        source
            .begin(key.clone(), V3ProviderTransportKind::Http, scope(7))
            .unwrap();
        source
            .transition(&key, V3ProviderTransportAttemptState::Streaming)
            .unwrap();
        source.observe_provider_frame(&key, 0).unwrap();
        let checkpoint = source.checkpoint(&key).unwrap();

        let restored = V3ProviderTransportAttemptBroker::default();
        assert_eq!(restored.restore_detached(&[checkpoint]), Ok(1));
        let restored_checkpoint = restored.checkpoint(&key).unwrap();
        assert_eq!(
            restored_checkpoint.state,
            V3ProviderTransportAttemptState::Detached
        );
        assert_eq!(restored_checkpoint.next_provider_sequence, 1);
        assert_eq!(restored_checkpoint.scope.runtime_generation, 7);
    }
}

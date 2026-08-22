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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct V3ProviderTransportCheckpoint {
    pub key: V3ProviderTransportAttemptKey,
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
        runtime_generation: u64,
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
        self.begin(key.clone(), kind, runtime_generation)?;
        Ok(key)
    }

    pub fn begin(
        &self,
        key: V3ProviderTransportAttemptKey,
        kind: V3ProviderTransportKind,
        runtime_generation: u64,
    ) -> Result<(), String> {
        let mut attempts = self
            .attempts
            .lock()
            .expect("provider transport attempt lock");
        if attempts.contains_key(&key) {
            return Err("provider transport attempt key is already active".to_string());
        }
        attempts.insert(
            key.clone(),
            V3ProviderTransportAttempt {
                checkpoint: V3ProviderTransportCheckpoint {
                    key,
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

    #[test]
    fn provider_transport_attempt_tracks_state_and_sequence() {
        let broker = V3ProviderTransportAttemptBroker::default();
        let key = key();
        broker
            .begin(key.clone(), V3ProviderTransportKind::Http, 7)
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
            .begin(key.clone(), V3ProviderTransportKind::WebSocketV2, 3)
            .unwrap();
        assert!(broker
            .begin(key, V3ProviderTransportKind::WebSocketV2, 4)
            .is_err());
    }
}

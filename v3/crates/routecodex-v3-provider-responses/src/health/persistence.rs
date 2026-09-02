use super::{V3ProviderHealthState, V3ProviderHealthStore};
use crate::global_cooldown::{
    V3ProviderCooldownCoordinator, V3ProviderCooldownFailureClass, V3ProviderCooldownKey,
};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, RwLock, RwLockWriteGuard};

const V3_PROVIDER_HEALTH_PERSISTENCE_QUEUE_CAPACITY: usize = 32;

type V3ProviderCooldownPersistenceEntries = Vec<(V3ProviderCooldownKey, u64, u64)>;

#[derive(Debug)]
enum V3ProviderHealthPersistenceCommand {
    Replace(V3ProviderCooldownPersistenceEntries),
    Flush(mpsc::Sender<Result<(), String>>),
}

#[derive(Debug, Clone)]
pub(super) struct V3ProviderHealthPersistenceWriter {
    sender: mpsc::SyncSender<V3ProviderHealthPersistenceCommand>,
    alarm: Arc<RwLock<Option<String>>>,
}

#[derive(Debug)]
struct V3ProviderHealthPersistenceTicket {
    writer: V3ProviderHealthPersistenceWriter,
    entries: V3ProviderCooldownPersistenceEntries,
}

impl V3ProviderHealthPersistenceTicket {
    fn from_state(state: &V3ProviderHealthState) -> Option<Self> {
        Some(Self {
            writer: state.persistence.clone()?,
            entries: provider_cooldown_persistence_entries(state),
        })
    }

    fn enqueue(self) {
        self.writer.enqueue(self.entries);
    }
}

impl V3ProviderHealthPersistenceWriter {
    fn start(mut coordinator: V3ProviderCooldownCoordinator) -> Self {
        let (sender, receiver) = mpsc::sync_channel(V3_PROVIDER_HEALTH_PERSISTENCE_QUEUE_CAPACITY);
        let alarm = Arc::new(RwLock::new(None));
        let writer_alarm = Arc::clone(&alarm);
        std::thread::Builder::new()
            .name("v3-provider-health-persistence".to_string())
            .spawn(move || {
                let mut persisted_entries = Vec::new();
                while let Ok(command) = receiver.recv() {
                    match command {
                        V3ProviderHealthPersistenceCommand::Replace(entries) => {
                            if entries == persisted_entries {
                                continue;
                            }
                            match coordinator.replace_entries(entries.clone()) {
                                Ok(()) => {
                                    persisted_entries = entries;
                                    if let Ok(mut alarm) = writer_alarm.write() {
                                        *alarm = None;
                                    }
                                }
                                Err(error) => set_persistence_alarm(
                                    &writer_alarm,
                                    format!("provider health persistence write failed: {error}"),
                                ),
                            }
                        }
                        V3ProviderHealthPersistenceCommand::Flush(receipt) => {
                            let result = writer_alarm
                                .read()
                                .map_err(|error| {
                                    format!(
                                        "provider health persistence alarm lock poisoned: {error}"
                                    )
                                })
                                .and_then(|alarm| match alarm.as_ref() {
                                    Some(error) => Err(error.clone()),
                                    None => Ok(()),
                                });
                            let _ = receipt.send(result);
                        }
                    }
                }
            })
            .unwrap_or_else(|error| {
                panic!("provider health persistence writer start failed: {error}")
            });
        Self { sender, alarm }
    }

    fn enqueue(&self, entries: V3ProviderCooldownPersistenceEntries) {
        if let Err(error) = self
            .sender
            .try_send(V3ProviderHealthPersistenceCommand::Replace(entries))
        {
            set_persistence_alarm(
                &self.alarm,
                format!("provider health persistence queue rejected update: {error}"),
            );
        }
    }

    fn flush_snapshot(&self, entries: V3ProviderCooldownPersistenceEntries) -> Result<(), String> {
        self.sender
            .send(V3ProviderHealthPersistenceCommand::Replace(entries))
            .map_err(|error| format!("provider health persistence writer unavailable: {error}"))?;
        let (receipt_sender, receipt_receiver) = mpsc::channel();
        self.sender
            .send(V3ProviderHealthPersistenceCommand::Flush(receipt_sender))
            .map_err(|error| format!("provider health persistence writer unavailable: {error}"))?;
        receipt_receiver.recv().map_err(|error| {
            format!("provider health persistence flush receipt missing: {error}")
        })?
    }

    fn alarm(&self) -> Option<String> {
        self.alarm
            .read()
            .map(|alarm| alarm.clone())
            .unwrap_or_else(|error| {
                Some(format!(
                    "provider health persistence alarm lock poisoned: {error}"
                ))
            })
    }
}

pub(super) fn start_provider_health_persistence(
    persistence_path: Option<PathBuf>,
) -> Option<V3ProviderHealthPersistenceWriter> {
    let mut coordinator = persistence_path.map(|path| {
        V3ProviderCooldownCoordinator::load(path, 5 * 60 * 60_000)
            .unwrap_or_else(|error| panic!("provider cooldown persistence load failed: {error}"))
    });
    if let Some(coordinator) = coordinator.as_mut() {
        // Durable cooldowns are diagnostic history only. Restart admission
        // starts with a clean provider health state; in-process failures
        // repopulate this coordinator through the normal health owner.
        coordinator
            .replace_entries(Vec::new())
            .unwrap_or_else(|error| panic!("provider cooldown startup clear failed: {error}"));
    }
    coordinator.map(V3ProviderHealthPersistenceWriter::start)
}

pub(super) fn provider_cooldown_state_path() -> PathBuf {
    if let Ok(path) = std::env::var("ROUTECODEX_V3_PROVIDER_COOLDOWN_STATE") {
        return PathBuf::from(path);
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".rcc")
        .join("state")
        .join("provider-cooldowns.json")
}

fn provider_cooldown_persistence_entries(
    state: &V3ProviderHealthState,
) -> V3ProviderCooldownPersistenceEntries {
    state
        .provider_cooldown_probes
        .iter()
        .filter_map(|(key, probe)| {
            Some((
                V3ProviderCooldownKey {
                    provider_id: key.provider_id.clone(),
                    auth_alias: key.auth_alias.clone(),
                    model_id: probe.probe_model_id.clone(),
                    failure_class: V3ProviderCooldownFailureClass::Semantic,
                },
                probe.blocked_until_ms?,
                probe.next_probe_at_ms?,
            ))
        })
        .collect()
}

pub(super) fn persist_cooldown_state(state: RwLockWriteGuard<'_, V3ProviderHealthState>) {
    let ticket = V3ProviderHealthPersistenceTicket::from_state(&state);
    drop(state);
    if let Some(ticket) = ticket {
        ticket.enqueue();
    }
}

impl V3ProviderHealthStore {
    pub fn persistence_alarm(&self) -> Option<String> {
        self.state
            .read()
            .map_err(|error| format!("provider health state poisoned: {error}"))
            .ok()
            .and_then(|state| state.persistence.as_ref().and_then(|writer| writer.alarm()))
    }

    pub fn flush_persistence(&self) -> Result<(), String> {
        let (writer, entries) = {
            let state = self
                .state
                .read()
                .map_err(|error| format!("provider health state poisoned: {error}"))?;
            (
                state.persistence.clone(),
                provider_cooldown_persistence_entries(&state),
            )
        };
        match writer {
            Some(writer) => writer.flush_snapshot(entries),
            None => Ok(()),
        }
    }
}

fn set_persistence_alarm(alarm: &RwLock<Option<String>>, message: String) {
    if let Ok(mut alarm) = alarm.write() {
        *alarm = Some(message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::V3ProviderAvailabilityReader;
    use std::sync::{Arc, RwLock};

    #[test]
    fn health_persistence_isolation_flushes_latest_snapshot_in_order() {
        let root = tempfile::tempdir().expect("create isolated persistence directory");
        let path = root.path().join("provider-cooldowns.json");
        let writer = V3ProviderHealthPersistenceWriter::start(V3ProviderCooldownCoordinator::new(
            path.clone(),
            60_000,
        ));
        let store = V3ProviderHealthStore {
            state: Arc::new(RwLock::new(V3ProviderHealthState {
                persistence: Some(writer),
                ..V3ProviderHealthState::default()
            })),
        };

        store
            .record_provider_cooldown_failure(
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                "first failure",
                100,
                60_000,
            )
            .expect("first health mutation");
        store
            .record_provider_cooldown_failure(
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                "newer failure",
                200,
                120_000,
            )
            .expect("newer health mutation");
        store
            .flush_persistence()
            .expect("flush receipt must follow the latest snapshot");

        let restored = V3ProviderCooldownCoordinator::load(path, 60_000)
            .expect("load flushed provider cooldown state");
        let entries = restored.persisted_entries();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].0.provider_id, "provider-a");
        assert_eq!(entries[0].0.auth_alias.as_deref(), Some("key-a"));
        assert_eq!(entries[0].0.model_id.as_deref(), Some("model-a"));
        assert_eq!(entries[0].1, 120_200);
        assert_eq!(entries[0].2, 30_200);
        assert_eq!(store.persistence_alarm(), None);
    }

    #[test]
    fn health_persistence_isolation_write_failure_does_not_change_provider_health_truth() {
        let root = std::env::temp_dir().join(format!(
            "routecodex-v3-health-persistence-failure-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).expect("create isolated persistence target");
        let writer = V3ProviderHealthPersistenceWriter::start(V3ProviderCooldownCoordinator::new(
            root.clone(),
            60_000,
        ));
        let store = V3ProviderHealthStore {
            state: Arc::new(RwLock::new(V3ProviderHealthState {
                persistence: Some(writer),
                ..V3ProviderHealthState::default()
            })),
        };

        store
            .record_provider_cooldown_failure(
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                "provider failure",
                100,
                60_000,
            )
            .expect("health truth must commit independently of persistence");
        assert!(
            !store
                .availability("provider-a", Some("key-a"), Some("model-a"), 101)
                .available,
            "persistence failure must not roll back in-memory health truth"
        );
        assert!(store.flush_persistence().is_err());
        assert!(store
            .persistence_alarm()
            .expect("persistence failure alarm")
            .contains("persistence write failed"));

        std::fs::remove_dir_all(&root).expect("remove isolated persistence target");
    }
}

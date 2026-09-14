use super::{V3ProviderHealthState, V3ProviderHealthStore};
use crate::global_cooldown::{
    V3ProviderCooldownCoordinator, V3ProviderCooldownFailureClass, V3ProviderCooldownKey,
};
use routecodex_v3_config::V3Config05ManifestPublished;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, RwLock, RwLockWriteGuard};

const V3_PROVIDER_HEALTH_PERSISTENCE_QUEUE_CAPACITY: usize = 32;

type V3ProviderCooldownPersistenceEntries = Vec<(V3ProviderCooldownKey, u64, u64)>;

#[derive(Debug)]
enum V3ProviderHealthPersistenceCommand {
    Replace {
        failure_class: V3ProviderCooldownFailureClass,
        entries: V3ProviderCooldownPersistenceEntries,
    },
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
                let mut persisted_entries = coordinator.persisted_entries();
                while let Ok(command) = receiver.recv() {
                    match command {
                        V3ProviderHealthPersistenceCommand::Replace {
                            failure_class,
                            entries,
                        } => {
                            let replaced_classes = BTreeSet::from([failure_class]);
                            let mut merged_entries = persisted_entries
                                .iter()
                                .filter(|(key, _, _)| {
                                    !replaced_classes.contains(&key.failure_class)
                                })
                                .cloned()
                                .collect::<Vec<_>>();
                            merged_entries.extend(entries);
                            if merged_entries == persisted_entries {
                                continue;
                            }
                            match coordinator.replace_entries(merged_entries.clone()) {
                                Ok(()) => {
                                    persisted_entries = merged_entries;
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
            .try_send(V3ProviderHealthPersistenceCommand::Replace {
                failure_class: V3ProviderCooldownFailureClass::Semantic,
                entries,
            })
        {
            set_persistence_alarm(
                &self.alarm,
                format!("provider health persistence queue rejected update: {error}"),
            );
        }
    }

    fn flush_snapshot(&self, entries: V3ProviderCooldownPersistenceEntries) -> Result<(), String> {
        self.sender
            .send(V3ProviderHealthPersistenceCommand::Replace {
                failure_class: V3ProviderCooldownFailureClass::Semantic,
                entries,
            })
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
) -> Option<(
    V3ProviderHealthPersistenceWriter,
    V3ProviderCooldownPersistenceEntries,
)> {
    let mut coordinator = persistence_path.map(|path| {
        V3ProviderCooldownCoordinator::load(path, 5 * 60 * 60_000)
            .unwrap_or_else(|error| panic!("provider cooldown persistence load failed: {error}"))
    });
    coordinator.as_mut().map(|coordinator| {
        coordinator
            .reset_probe_schedule_for_startup()
            .unwrap_or_else(|error| {
                panic!("provider cooldown startup probe reset failed: {error}")
            });
        let entries = coordinator.persisted_entries();
        (
            V3ProviderHealthPersistenceWriter::start(coordinator.clone()),
            entries,
        )
    })
}

pub(super) fn provider_cooldown_state_path_for_manifest(
    manifest: &V3Config05ManifestPublished,
) -> PathBuf {
    if let Ok(path) = std::env::var("ROUTECODEX_V3_PROVIDER_COOLDOWN_STATE") {
        return PathBuf::from(path);
    }
    let scope = enabled_listener_scope_digest(manifest);
    default_provider_cooldown_state_path()
        .with_file_name(format!("provider-cooldowns-{scope}.json"))
}

fn enabled_listener_scope_digest(manifest: &V3Config05ManifestPublished) -> String {
    let mut hasher = Sha256::new();
    for (server_id, server) in manifest.servers.iter().filter(|(_, server)| server.enabled) {
        hasher.update((server_id.len() as u64).to_le_bytes());
        hasher.update(server_id.as_bytes());
        hasher.update((server.bind.len() as u64).to_le_bytes());
        hasher.update(server.bind.as_bytes());
        hasher.update(server.port.to_le_bytes());
    }
    let digest = hasher.finalize();
    digest
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn default_provider_cooldown_state_path() -> PathBuf {
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
    use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
    use std::sync::{Arc, RwLock};

    #[test]
    fn provider_cooldown_state_path_is_scoped_to_enabled_listener_scope() {
        let primary = manifest("primary", "127.0.0.1", 1);
        let secondary = manifest("secondary", "127.0.0.1", 1);
        let primary_other_bind = manifest("primary", "127.0.0.2", 1);
        let primary_other_port = manifest("primary", "127.0.0.1", 2);
        let underscore_id = manifest("a_b", "127.0.0.1", 1);
        let two_ids = manifest_with_servers(&[("a", "127.0.0.1", 1), ("b", "127.0.0.2", 2)]);

        let primary_path = provider_cooldown_state_path_for_manifest(&primary);
        let secondary_path = provider_cooldown_state_path_for_manifest(&secondary);
        let primary_other_bind_path =
            provider_cooldown_state_path_for_manifest(&primary_other_bind);
        let primary_other_port_path =
            provider_cooldown_state_path_for_manifest(&primary_other_port);
        let underscore_id_path = provider_cooldown_state_path_for_manifest(&underscore_id);
        let two_ids_path = provider_cooldown_state_path_for_manifest(&two_ids);

        assert_ne!(
            primary_path, secondary_path,
            "different listener scopes must not share one cooldown persistence file"
        );
        assert_ne!(
            primary_path, primary_other_bind_path,
            "same server id on a different bind must not share one cooldown persistence file"
        );
        assert_ne!(
            primary_path, primary_other_port_path,
            "same server id on a different port must not share one cooldown persistence file"
        );
        assert_ne!(
            underscore_id_path, two_ids_path,
            "a_b and two ids a+b must not share one cooldown persistence file"
        );
        assert!(primary_path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                name.starts_with("provider-cooldowns-")
                    && name.ends_with(".json")
                    && name.len() > "provider-cooldowns-.json".len()
            }));
    }

    fn manifest(server_id: &str, bind: &str, port: u16) -> V3Config05ManifestPublished {
        manifest_with_servers(&[(server_id, bind, port)])
    }

    fn manifest_with_servers(servers: &[(&str, &str, u16)]) -> V3Config05ManifestPublished {
        let server_blocks = servers
            .iter()
            .map(|(server_id, bind, port)| {
                format!(
                    "[servers.{server_id}]\nbind = \"{bind}\"\nport = {port}\nrouting_group = \"g\""
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        compile_v3_config_05_manifest(
            parse_v3_config_02_authoring(&format!(
                r#"
version = 3
{server_blocks}
[providers.p]
type = "responses"
base_url = "http://provider.invalid/v1"
default_model = "m"
auth = {{ type = "api_key", entries = [{{ alias = "k", env = "KEY" }}] }}
[providers.p.models.m]
[route_groups.g.pools.default]
targets = [{{ kind = "provider_model", provider = "p", model = "m", key = "k", priority = 1 }}]
"#
            ))
            .expect("test authoring must parse"),
        )
        .expect("test manifest must compile")
    }

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
            ..V3ProviderHealthStore::default()
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
        assert_eq!(
            entries[0].0.failure_class,
            V3ProviderCooldownFailureClass::Semantic
        );
        assert_eq!(entries[0].1, 120_200);
        assert_eq!(entries[0].2, 5_200);
        assert_eq!(store.persistence_alarm(), None);
    }

    #[test]
    fn health_persistence_preserves_other_failure_classes() {
        let root = tempfile::tempdir().expect("create isolated persistence directory");
        let path = root.path().join("provider-cooldowns.json");
        let mut coordinator = V3ProviderCooldownCoordinator::new(path.clone(), 60_000);
        coordinator
            .record_failure(
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                V3ProviderCooldownFailureClass::Auth,
                100,
                crate::global_cooldown::V3ProviderCooldownObservation::default(),
            )
            .expect("seed auth cooldown");
        let writer = V3ProviderHealthPersistenceWriter::start(coordinator);
        let store = V3ProviderHealthStore {
            state: Arc::new(RwLock::new(V3ProviderHealthState {
                persistence: Some(writer),
                ..V3ProviderHealthState::default()
            })),
            ..V3ProviderHealthStore::default()
        };

        store
            .record_provider_cooldown_failure(
                "provider-a",
                Some("key-a"),
                Some("model-a"),
                "semantic provider failure",
                200,
                120_000,
            )
            .expect("record semantic cooldown");
        store
            .flush_persistence()
            .expect("flush mixed failure classes");

        let restored = V3ProviderCooldownCoordinator::load(path, 60_000)
            .expect("load mixed provider cooldown state");
        let entries = restored.persisted_entries();
        assert_eq!(entries.len(), 2);
        assert!(entries
            .iter()
            .any(|(key, _, _)| { key.failure_class == V3ProviderCooldownFailureClass::Auth }));
        assert!(entries
            .iter()
            .any(|(key, _, _)| { key.failure_class == V3ProviderCooldownFailureClass::Semantic }));
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
            ..V3ProviderHealthStore::default()
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

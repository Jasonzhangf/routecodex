use super::{V3ProviderHealthListenerScope, V3ProviderHealthState, V3ProviderHealthStore};
use crate::global_cooldown::{
    acquire_state_writer_lock, V3ProviderCooldownCoordinator, V3ProviderCooldownFailureClass,
    V3ProviderCooldownKey, V3ProviderRateLimitEpisode,
};
use routecodex_v3_config::V3Config05ManifestPublished;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    mpsc, Arc, RwLock, RwLockWriteGuard,
};

#[cfg(test)]
thread_local! {
    static TEST_SPAWN_FAILURE: std::cell::Cell<Option<String>> = const { std::cell::Cell::new(None) };
}

const V3_PROVIDER_HEALTH_PERSISTENCE_QUEUE_CAPACITY: usize = 32;

type V3ProviderCooldownPersistenceEntries = Vec<(V3ProviderCooldownKey, u64, u64)>;
type V3ProviderRateLimitPersistenceEntries =
    Vec<(V3ProviderCooldownKey, V3ProviderRateLimitEpisode)>;

enum V3ProviderHealthPersistenceCommand {
    Replace(
        u64,
        V3ProviderCooldownPersistenceEntries,
        V3ProviderRateLimitPersistenceEntries,
    ),
    Flush(mpsc::Sender<Result<(), String>>),
}

#[derive(Debug, Default)]
struct V3PersistenceAlarms {
    startup: Option<String>,
    health: Option<String>,
}

impl V3PersistenceAlarms {
    fn first(&self) -> Option<String> {
        self.startup.clone().or_else(|| self.health.clone())
    }
}

#[derive(Debug, Clone)]
pub(super) struct V3ProviderHealthPersistenceWriter {
    sender: mpsc::SyncSender<V3ProviderHealthPersistenceCommand>,
    alarm: Arc<RwLock<V3PersistenceAlarms>>,
    revision: Arc<AtomicU64>,
}

#[derive(Debug)]
struct V3ProviderHealthPersistenceTicket {
    writer: V3ProviderHealthPersistenceWriter,
    entries: V3ProviderCooldownPersistenceEntries,
    episodes: V3ProviderRateLimitPersistenceEntries,
    revision: u64,
}

impl V3ProviderHealthPersistenceTicket {
    fn from_state(state: &V3ProviderHealthState) -> Option<Self> {
        let writer = state.persistence.clone()?;
        Some(Self {
            revision: writer.next_revision(),
            writer,
            entries: provider_cooldown_persistence_entries(state),
            episodes: provider_rate_limit_persistence_entries(state),
        })
    }

    fn enqueue(self) {
        self.writer
            .enqueue_at(self.revision, self.entries, self.episodes);
    }
}

impl V3ProviderHealthPersistenceWriter {
    fn start(coordinator: V3ProviderCooldownCoordinator) -> Result<Self, String> {
        Self::start_with_spawn(coordinator, spawn_health_persistence_thread)
    }

    fn start_with_spawn(
        coordinator: V3ProviderCooldownCoordinator,
        spawn: impl FnOnce(
            String,
            Box<dyn FnOnce() + Send + 'static>,
        ) -> std::io::Result<std::thread::JoinHandle<()>>,
    ) -> Result<Self, String> {
        let ownership = Arc::new(acquire_state_writer_lock(coordinator.state_path())?);
        Self::start_with_ownership(coordinator, ownership, spawn)
    }

    fn start_with_ownership(
        mut coordinator: V3ProviderCooldownCoordinator,
        ownership: Arc<fs::File>,
        spawn: impl FnOnce(
            String,
            Box<dyn FnOnce() + Send + 'static>,
        ) -> std::io::Result<std::thread::JoinHandle<()>>,
    ) -> Result<Self, String> {
        coordinator.attach_ownership(ownership);
        let (sender, receiver) = mpsc::sync_channel(V3_PROVIDER_HEALTH_PERSISTENCE_QUEUE_CAPACITY);
        let alarm = Arc::new(RwLock::new(V3PersistenceAlarms::default()));
        let writer_alarm = Arc::clone(&alarm);
        let work: Box<dyn FnOnce() + Send + 'static> = Box::new(move || {
            let mut persisted_entries = coordinator.persisted_entries();
            let mut persisted_episodes = coordinator.persisted_rate_limit_episodes();
            let mut latest_revision = 0;
            while let Ok(command) = receiver.recv() {
                match command {
                    V3ProviderHealthPersistenceCommand::Replace(revision, entries, episodes) => {
                        if revision < latest_revision {
                            continue;
                        }
                        latest_revision = revision;
                        if coordinator.has_indeterminate_commit() {
                            match coordinator.reconcile_indeterminate() {
                                Ok(Some(_)) => {
                                    persisted_entries = coordinator.persisted_entries();
                                    persisted_episodes =
                                        coordinator.persisted_rate_limit_episodes();
                                    if let Ok(mut alarm) = writer_alarm.write() {
                                        alarm.health = None;
                                    }
                                }
                                Ok(None) => {}
                                Err(_) => continue,
                            }
                        }
                        let mut merged_entries = persisted_entries
                            .iter()
                            .filter(|(key, _, _)| {
                                !matches!(
                                    key.failure_class,
                                    V3ProviderCooldownFailureClass::Semantic
                                        | V3ProviderCooldownFailureClass::RateLimit
                                        | V3ProviderCooldownFailureClass::ProbeLong
                                        | V3ProviderCooldownFailureClass::ManualAuth
                                )
                            })
                            .cloned()
                            .collect::<Vec<_>>();
                        merged_entries.extend(entries);
                        if merged_entries == persisted_entries && episodes == persisted_episodes {
                            continue;
                        }
                        match coordinator.replace_entries_and_rate_limit_episodes(
                            merged_entries.clone(),
                            episodes.clone(),
                        ) {
                            Ok(()) => {
                                persisted_entries = merged_entries;
                                persisted_episodes = episodes;
                                if let Ok(mut alarm) = writer_alarm.write() {
                                    alarm.health = None;
                                }
                            }
                            Err(error) => {
                                set_health_persistence_alarm(
                                    &writer_alarm,
                                    format!("provider health persistence write failed: {error}"),
                                );
                            }
                        }
                    }
                    V3ProviderHealthPersistenceCommand::Flush(receipt) => {
                        let result = writer_alarm
                            .read()
                            .map_err(|error| {
                                format!("provider health persistence alarm lock poisoned: {error}")
                            })
                            .and_then(|alarm| match alarm.first() {
                                Some(error) => Err(error),
                                None => Ok(()),
                            });
                        let _ = receipt.send(result);
                    }
                }
            }
        });
        let spawned = spawn("v3-provider-health-persistence".to_string(), work);
        Self::after_spawn(sender, alarm, spawned)
    }

    fn after_spawn(
        sender: mpsc::SyncSender<V3ProviderHealthPersistenceCommand>,
        alarm: Arc<RwLock<V3PersistenceAlarms>>,
        spawned: std::io::Result<std::thread::JoinHandle<()>>,
    ) -> Result<Self, String> {
        spawned
            .map_err(|error| format!("provider health persistence writer start failed: {error}"))?;
        Ok(Self {
            sender,
            alarm,
            revision: Arc::new(AtomicU64::new(0)),
        })
    }

    fn next_revision(&self) -> u64 {
        self.revision
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1)
    }

    #[cfg(test)]
    fn enqueue(
        &self,
        entries: V3ProviderCooldownPersistenceEntries,
        episodes: V3ProviderRateLimitPersistenceEntries,
    ) {
        self.enqueue_at(self.next_revision(), entries, episodes);
    }

    fn enqueue_at(
        &self,
        revision: u64,
        entries: V3ProviderCooldownPersistenceEntries,
        episodes: V3ProviderRateLimitPersistenceEntries,
    ) {
        if let Err(error) = self
            .sender
            .try_send(V3ProviderHealthPersistenceCommand::Replace(
                revision, entries, episodes,
            ))
        {
            set_health_persistence_alarm(
                &self.alarm,
                format!("provider health persistence queue rejected update: {error}"),
            );
        }
    }

    #[cfg(test)]
    fn flush_snapshot(
        &self,
        entries: V3ProviderCooldownPersistenceEntries,
        episodes: V3ProviderRateLimitPersistenceEntries,
    ) -> Result<(), String> {
        self.flush_snapshot_at(self.next_revision(), entries, episodes)
    }

    fn flush_snapshot_at(
        &self,
        revision: u64,
        entries: V3ProviderCooldownPersistenceEntries,
        episodes: V3ProviderRateLimitPersistenceEntries,
    ) -> Result<(), String> {
        self.sender
            .send(V3ProviderHealthPersistenceCommand::Replace(
                revision, entries, episodes,
            ))
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
            .map(|alarm| alarm.first())
            .unwrap_or_else(|error| {
                Some(format!(
                    "provider health persistence alarm lock poisoned: {error}"
                ))
            })
    }
}

fn spawn_health_persistence_thread(
    name: String,
    work: Box<dyn FnOnce() + Send + 'static>,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    #[cfg(test)]
    if let Some(message) = TEST_SPAWN_FAILURE.with(std::cell::Cell::take) {
        return Err(std::io::Error::other(message));
    }
    std::thread::Builder::new().name(name).spawn(work)
}

impl V3ProviderHealthPersistenceWriter {
    fn disabled(message: String) -> Self {
        let (sender, _receiver) = mpsc::sync_channel(V3_PROVIDER_HEALTH_PERSISTENCE_QUEUE_CAPACITY);
        Self {
            sender,
            alarm: Arc::new(RwLock::new(V3PersistenceAlarms {
                startup: Some(message),
                ..Default::default()
            })),
            revision: Arc::new(AtomicU64::new(0)),
        }
    }
}

pub(super) fn start_provider_health_persistence(
    manifest: &V3Config05ManifestPublished,
    persistence_path: Option<PathBuf>,
    legacy_persistence_path: Option<PathBuf>,
    prune_scope_suffix: Option<String>,
) -> Option<(
    V3ProviderHealthPersistenceWriter,
    V3ProviderCooldownPersistenceEntries,
    V3ProviderRateLimitPersistenceEntries,
)> {
    let path = persistence_path?;
    let ownership = match acquire_state_writer_lock(&path) {
        Ok(ownership) => Arc::new(ownership),
        Err(error) => return Some((disabled_persistence_writer(error), Vec::new(), Vec::new())),
    };
    let aggregate_legacy = legacy_provider_cooldown_state_path_for_manifest(manifest);
    let mut preserved = vec![aggregate_legacy];
    if let Some(legacy) = legacy_persistence_path.as_ref() {
        preserved.push(legacy.clone());
    }
    prune_stale_provider_cooldown_scope_files(
        &path,
        legacy_persistence_path.as_deref(),
        &preserved,
        prune_scope_suffix.as_deref(),
    );
    let mut coordinator = match load_provider_cooldown_coordinator(
        manifest,
        path,
        legacy_persistence_path,
        Some(ownership.clone()),
    ) {
        Ok(coordinator) => coordinator,
        Err(error) => {
            return Some((
                disabled_persistence_writer(format!(
                    "provider cooldown persistence load failed: {error}"
                )),
                Vec::new(),
                Vec::new(),
            ))
        }
    };
    if let Err(error) = coordinator.sync_loaded_state() {
        let entries = coordinator
            .persisted_entries()
            .into_iter()
            .filter(|(key, _, _)| manifest_contains_cooldown_key(manifest, key))
            .collect();
        let episodes = coordinator
            .persisted_rate_limit_episodes()
            .into_iter()
            .filter(|(key, _)| manifest_contains_cooldown_key(manifest, key))
            .collect();
        return Some((
            disabled_persistence_writer(format!(
                "provider cooldown startup reconciliation failed: {error}"
            )),
            entries,
            episodes,
        ));
    }
    if let Err(error) = coordinator.reset_probe_schedule_for_startup() {
        let entries = coordinator
            .persisted_entries()
            .into_iter()
            .filter(|(key, _, _)| manifest_contains_cooldown_key(manifest, key))
            .collect();
        let episodes = coordinator
            .persisted_rate_limit_episodes()
            .into_iter()
            .filter(|(key, _)| manifest_contains_cooldown_key(manifest, key))
            .collect();
        return Some((
            disabled_persistence_writer(format!(
                "provider cooldown startup probe reset failed: {error}"
            )),
            entries,
            episodes,
        ));
    }
    let entries = coordinator
        .persisted_entries()
        .into_iter()
        .filter(|(key, _, _)| manifest_contains_cooldown_key(manifest, key))
        .collect();
    let episodes = coordinator
        .persisted_rate_limit_episodes()
        .into_iter()
        .filter(|(key, _)| manifest_contains_cooldown_key(manifest, key))
        .collect();
    match V3ProviderHealthPersistenceWriter::start_with_ownership(
        coordinator,
        ownership,
        spawn_health_persistence_thread,
    ) {
        Ok(writer) => Some((writer, entries, episodes)),
        Err(error) => Some((disabled_persistence_writer(error), entries, episodes)),
    }
}

fn disabled_persistence_writer(error: String) -> V3ProviderHealthPersistenceWriter {
    eprintln!("[RouteCodexV3] provider cooldown persistence disabled: {error}");
    V3ProviderHealthPersistenceWriter::disabled(error)
}

/// Retains a bounded number of superseded per-scope cooldown state files.
///
/// The state path is keyed by a manifest scope digest, so every config revision
/// that changes provider, auth or model identity writes a new
/// `provider-cooldowns-<scope>.json` and the superseded ones are never read
/// again. Recent generations are kept so a rollback still finds its state;
/// older ones are removed so the state directory cannot grow per revision.
fn prune_stale_provider_cooldown_scope_files(
    current: &Path,
    legacy: Option<&Path>,
    preserved: &[PathBuf],
    scope_suffix: Option<&str>,
) {
    const RETAINED_SCOPE_GENERATIONS: usize = 4;
    /// The state directory is shared by every instance, so age gates deletion:
    /// on the generation count alone the newest-four rule would remove the
    /// current scope file of a concurrently running process that has simply not
    /// written a cooldown recently.
    const PRUNABLE_GENERATION_AGE: std::time::Duration =
        std::time::Duration::from_secs(24 * 60 * 60);
    if std::env::var_os("ROUTECODEX_V3_PROVIDER_COOLDOWN_STATE").is_some() {
        // An explicit state path is caller-owned; never prune around it.
        return;
    }
    let Some(directory) = current.parent() else {
        return;
    };
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let now = std::time::SystemTime::now();
    let mut superseded = Vec::new();
    for entry in entries.flatten() {
        let candidate = entry.path();
        if candidate == current
            || legacy == Some(candidate.as_path())
            || preserved.iter().any(|path| path == &candidate)
        {
            continue;
        }
        let Some(name) = candidate.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.starts_with("provider-cooldowns-") || !name.ends_with(".json") {
            continue;
        }
        // A listener-scoped manifest owns only the files for this listener.
        // Never prune another port's live state while cleaning superseded
        // provider revisions.
        if scope_suffix.is_some_and(|suffix| !name.ends_with(suffix)) {
            continue;
        }
        // Legacy aggregate callers have no ownership of listener-scoped files.
        if scope_suffix.is_none()
            && name
                .strip_prefix("provider-cooldowns-")
                .and_then(|name| name.strip_suffix(".json"))
                .is_some_and(|scope| scope.contains('-'))
        {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let modified = metadata.modified().unwrap_or(std::time::UNIX_EPOCH);
        // A future or unreadable timestamp is never treated as prunable.
        if now
            .duration_since(modified)
            .map(|age| age < PRUNABLE_GENERATION_AGE)
            .unwrap_or(true)
        {
            continue;
        }
        superseded.push((modified, candidate));
    }
    if superseded.len() <= RETAINED_SCOPE_GENERATIONS {
        return;
    }
    // Newest first, and the file name breaks ties so equal timestamps cannot
    // make the retained set depend on directory order.
    superseded.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
    for (_, candidate) in superseded.into_iter().skip(RETAINED_SCOPE_GENERATIONS) {
        if let Err(error) = fs::remove_file(&candidate) {
            eprintln!(
                "[RouteCodexV3] superseded provider cooldown state not removed {}: {error}",
                candidate.display()
            );
        }
    }
}

fn load_provider_cooldown_coordinator(
    manifest: &V3Config05ManifestPublished,
    path: PathBuf,
    legacy_path: Option<PathBuf>,
    ownership: Option<Arc<fs::File>>,
) -> Result<V3ProviderCooldownCoordinator, String> {
    let explicit_path =
        std::env::var_os("ROUTECODEX_V3_PROVIDER_COOLDOWN_STATE").map(PathBuf::from);
    if !path.exists()
        && explicit_path
            .as_ref()
            .is_none_or(|override_path| override_path != &path)
    {
        if let Some(legacy_path) = legacy_path.filter(|legacy| legacy != &path && legacy.exists()) {
            let legacy = V3ProviderCooldownCoordinator::load(legacy_path)?;
            let entries = legacy
                .persisted_entries()
                .into_iter()
                .filter(|(key, _, _)| manifest_contains_cooldown_key(manifest, key))
                .collect();
            let mut migrated = V3ProviderCooldownCoordinator::new(path);
            if let Some(ownership) = ownership.as_ref() {
                migrated.attach_ownership(ownership.clone());
            }
            let episodes = legacy
                .persisted_rate_limit_episodes()
                .into_iter()
                .filter(|(key, _)| manifest_contains_cooldown_key(manifest, key))
                .collect();
            migrated.replace_entries_and_rate_limit_episodes(entries, episodes)?;
            return Ok(migrated);
        }
    }
    let mut coordinator = V3ProviderCooldownCoordinator::load(path)?;
    if let Some(ownership) = ownership {
        coordinator.attach_ownership(ownership);
    }
    Ok(coordinator)
}

pub(super) fn manifest_contains_cooldown_key(
    manifest: &V3Config05ManifestPublished,
    key: &V3ProviderCooldownKey,
) -> bool {
    let Some(provider) = manifest.providers.get(&key.provider_id) else {
        return false;
    };
    if !provider.enabled {
        return false;
    }
    let Some(interface) = provider.interfaces.get(&key.interface_id) else {
        return false;
    };
    if !interface.enabled {
        return false;
    }
    if let Some(auth_alias) = key.auth_alias.as_deref() {
        if !provider
            .auth
            .entries
            .iter()
            .any(|entry| entry.alias == auth_alias)
        {
            return false;
        }
    }
    key.model_id
        .as_deref()
        .is_none_or(|model_id| provider.models.contains_key(model_id))
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

/// Persistence path for one listener scope.
///
/// The explicit single-listener override remains the exact declared path.
/// Otherwise the listener identity alone owns a stable file across provider
/// configuration changes. Each listener still has exactly one writer.
pub(super) fn provider_cooldown_state_path_for_listener(
    manifest: &V3Config05ManifestPublished,
    listener: &V3ProviderHealthListenerScope,
) -> PathBuf {
    if enabled_business_listener_count(manifest) <= 1 {
        if let Ok(path) = std::env::var("ROUTECODEX_V3_PROVIDER_COOLDOWN_STATE") {
            return PathBuf::from(path);
        }
    }
    let file_name = format!(
        "provider-cooldowns-listener-{}.json",
        listener_identity_digest(listener)
    );
    if let Ok(path) = std::env::var("ROUTECODEX_V3_PROVIDER_COOLDOWN_STATE") {
        let base = PathBuf::from(path);
        let directory = base
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        return directory.join(file_name);
    }
    default_provider_cooldown_state_path().with_file_name(file_name)
}

pub(super) fn legacy_provider_cooldown_state_path_for_manifest(
    manifest: &V3Config05ManifestPublished,
) -> PathBuf {
    let scope = legacy_listener_scope_digest(manifest);
    default_provider_cooldown_state_path()
        .with_file_name(format!("provider-cooldowns-{scope}.json"))
}

/// Legacy migration source for one listener.
///
/// The historical file is keyed by the whole listener set, so it carries no
/// port provenance once the manifest has more than one listener. Preserve the
/// file, but never copy an unowned aggregate record into every port.
pub(super) fn legacy_provider_cooldown_state_path_for_listener(
    manifest: &V3Config05ManifestPublished,
    listener: &V3ProviderHealthListenerScope,
) -> Option<PathBuf> {
    if enabled_business_listener_count(manifest) <= 1 {
        if std::env::var_os("ROUTECODEX_V3_PROVIDER_COOLDOWN_STATE").is_some() {
            return None;
        }
        let previous = provider_cooldown_state_path_for_manifest(manifest);
        return Some(if previous.exists() {
            previous
        } else {
            legacy_provider_cooldown_state_path_for_manifest(manifest)
        });
    }
    let file_name = listener_scoped_state_file_name(manifest, listener);
    if let Ok(path) = std::env::var("ROUTECODEX_V3_PROVIDER_COOLDOWN_STATE") {
        let base = PathBuf::from(path);
        return Some(
            base.parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new("."))
                .join(file_name),
        );
    }
    Some(default_provider_cooldown_state_path().with_file_name(file_name))
}

pub(super) fn listener_scoped_state_suffix(listener: &V3ProviderHealthListenerScope) -> String {
    format!("-{}.json", listener_identity_digest(listener))
}

fn enabled_business_listener_count(manifest: &V3Config05ManifestPublished) -> usize {
    manifest
        .servers
        .values()
        .filter(|server| server.enabled)
        .count()
}

fn listener_scoped_state_file_name(
    manifest: &V3Config05ManifestPublished,
    listener: &V3ProviderHealthListenerScope,
) -> String {
    format!(
        "provider-cooldowns-{}-{}.json",
        provider_scope_digest(manifest),
        listener_identity_digest(listener)
    )
}

fn enabled_listener_scope_digest(manifest: &V3Config05ManifestPublished) -> String {
    let mut hasher = Sha256::new();
    for (server_id, server) in manifest.servers.iter().filter(|(_, server)| server.enabled) {
        update_listener_identity_digest(&mut hasher, server_id, &server.bind, server.port);
    }
    update_provider_scope_digest(&mut hasher, manifest);
    digest_hex(hasher.finalize())
}

fn provider_scope_digest(manifest: &V3Config05ManifestPublished) -> String {
    let mut hasher = Sha256::new();
    update_provider_scope_digest(&mut hasher, manifest);
    digest_hex(hasher.finalize())
}

fn listener_identity_digest(listener: &V3ProviderHealthListenerScope) -> String {
    let mut hasher = Sha256::new();
    update_listener_identity_digest(
        &mut hasher,
        &listener.server_id,
        &listener.bind,
        listener.port,
    );
    digest_hex(hasher.finalize())
}

fn update_listener_identity_digest(hasher: &mut Sha256, server_id: &str, bind: &str, port: u16) {
    hasher.update((server_id.len() as u64).to_le_bytes());
    hasher.update(server_id.as_bytes());
    hasher.update((bind.len() as u64).to_le_bytes());
    hasher.update(bind.as_bytes());
    hasher.update(port.to_le_bytes());
}

fn update_provider_scope_digest(hasher: &mut Sha256, manifest: &V3Config05ManifestPublished) {
    // Provider/model/auth identity is part of the persistence scope. A config
    // revision must not inherit cooldown entries for removed or renamed
    // targets and then probe them on startup.
    hasher.update(b"providers");
    hasher.update((manifest.providers.len() as u64).to_le_bytes());
    for (provider_id, provider) in &manifest.providers {
        hasher.update(b"provider_id");
        hasher.update((provider_id.len() as u64).to_le_bytes());
        hasher.update(provider_id.as_bytes());
        hasher.update(b"provider_enabled");
        hasher.update([u8::from(provider.enabled)]);
        hasher.update(b"auth_aliases");
        hasher.update((provider.auth.entries.len() as u64).to_le_bytes());
        for entry in &provider.auth.entries {
            hasher.update((entry.alias.len() as u64).to_le_bytes());
            hasher.update(entry.alias.as_bytes());
        }
        hasher.update(b"model_ids");
        hasher.update((provider.models.len() as u64).to_le_bytes());
        for model_id in provider.models.keys() {
            hasher.update((model_id.len() as u64).to_le_bytes());
            hasher.update(model_id.as_bytes());
        }
    }
}

fn digest_hex(digest: impl AsRef<[u8]>) -> String {
    digest
        .as_ref()
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn legacy_listener_scope_digest(manifest: &V3Config05ManifestPublished) -> String {
    let mut hasher = Sha256::new();
    for (server_id, server) in manifest.servers.iter().filter(|(_, server)| server.enabled) {
        update_listener_identity_digest(&mut hasher, server_id, &server.bind, server.port);
    }
    digest_hex(hasher.finalize())
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
            if !matches!(
                &key.scope,
                crate::provider_cooldown_probe::V3ProviderCooldownHealthScope::Identity
            ) {
                return None;
            }
            Some((
                V3ProviderCooldownKey {
                    provider_id: key.provider_id.clone(),
                    interface_id: key.interface_id.clone(),
                    auth_alias: key.auth_alias.clone(),
                    model_id: probe.probe_model_id.clone(),
                    failure_class: if state.auth_key_cooldowns.contains_key(key) {
                        V3ProviderCooldownFailureClass::ManualAuth
                    } else if probe.cooldown_cause
                        == Some(V3ProviderCooldownFailureClass::ManualAuth)
                    {
                        V3ProviderCooldownFailureClass::ManualAuth
                    } else if probe.cooldown_cause
                        == Some(V3ProviderCooldownFailureClass::RateLimit)
                    {
                        V3ProviderCooldownFailureClass::RateLimit
                    } else if probe.long_probe_backoff {
                        V3ProviderCooldownFailureClass::ProbeLong
                    } else {
                        V3ProviderCooldownFailureClass::Semantic
                    },
                },
                probe.blocked_until_ms?,
                probe.next_probe_at_ms?,
            ))
        })
        .collect()
}

fn provider_rate_limit_persistence_entries(
    state: &V3ProviderHealthState,
) -> V3ProviderRateLimitPersistenceEntries {
    state
        .adaptive_history
        .iter()
        .filter_map(|(key, history)| {
            if !matches!(
                &key.scope,
                crate::provider_cooldown_probe::V3ProviderCooldownHealthScope::Identity
            ) {
                return None;
            }
            Some((
                V3ProviderCooldownKey {
                    provider_id: key.provider_id.clone(),
                    interface_id: key.interface_id.clone(),
                    auth_alias: key.auth_alias.clone(),
                    model_id: key.model_id.clone(),
                    failure_class: V3ProviderCooldownFailureClass::RateLimit,
                },
                history.rate_limit_episode.clone()?,
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
        let (writer, revision, entries, episodes) = {
            let state = self
                .state
                .read()
                .map_err(|error| format!("provider health state poisoned: {error}"))?;
            let writer = state.persistence.clone();
            (
                writer.clone(),
                writer
                    .as_ref()
                    .map(V3ProviderHealthPersistenceWriter::next_revision),
                provider_cooldown_persistence_entries(&state),
                provider_rate_limit_persistence_entries(&state),
            )
        };
        match writer {
            Some(writer) => {
                writer.flush_snapshot_at(revision.expect("writer has revision"), entries, episodes)
            }
            None => Ok(()),
        }
    }
}

fn set_health_persistence_alarm(alarm: &RwLock<V3PersistenceAlarms>, message: String) {
    if let Ok(mut alarm) = alarm.write() {
        alarm.health.get_or_insert(message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::V3ProviderAvailabilityReader;
    use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
    use std::sync::{Arc, RwLock};

    #[test]
    fn health_state_owner_rejects_second_writer() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let _first = V3ProviderHealthPersistenceWriter::start(V3ProviderCooldownCoordinator::new(
            path.clone(),
        ))
        .unwrap();
        let second =
            V3ProviderHealthPersistenceWriter::start(V3ProviderCooldownCoordinator::new(path));
        assert!(
            second.is_err(),
            "a second owner must not write the same health state"
        );
    }

    #[test]
    fn health_state_owner_rejects_unowned_coordinator_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let _owner = V3ProviderHealthPersistenceWriter::start(V3ProviderCooldownCoordinator::new(
            path.clone(),
        ))
        .unwrap();
        let mut unowned = V3ProviderCooldownCoordinator::new(path);
        let key = V3ProviderCooldownKey {
            provider_id: "p".into(),
            interface_id: "responses".into(),
            auth_alias: Some("k".into()),
            model_id: Some("m".into()),
            failure_class: V3ProviderCooldownFailureClass::Semantic,
        };
        assert!(
            unowned.replace_entries(vec![(key, 1_000, 1_000)]).is_err(),
            "a public coordinator cannot bypass the active state owner"
        );
    }

    #[test]
    fn health_state_owner_child() {
        let Some(path) = std::env::var_os("RCC_HEALTH_OWNER_TEST_PATH") else {
            return;
        };
        let ready = std::env::var_os("RCC_HEALTH_OWNER_TEST_READY").unwrap();
        let _owner = V3ProviderHealthPersistenceWriter::start(V3ProviderCooldownCoordinator::new(
            PathBuf::from(path),
        ))
        .unwrap();
        std::fs::write(ready, b"ready").unwrap();
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).unwrap();
    }

    #[test]
    fn health_state_owner_rejects_other_process() {
        use std::process::{Command, Stdio};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let ready = dir.path().join("ready");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "health::persistence::tests::health_state_owner_child",
                "--nocapture",
            ])
            .env("RCC_HEALTH_OWNER_TEST_PATH", &path)
            .env("RCC_HEALTH_OWNER_TEST_READY", &ready)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !ready.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let ready_seen = ready.exists();
        let second = if ready_seen {
            Some(V3ProviderHealthPersistenceWriter::start(
                V3ProviderCooldownCoordinator::new(path.clone()),
            ))
        } else {
            None
        };
        drop(child.stdin.take());
        let child_status = child.wait().unwrap();
        assert!(
            ready_seen && child_status.success(),
            "owned child must acquire the state lock"
        );
        assert!(
            second.unwrap().is_err(),
            "another process must not acquire the same state lock"
        );
        assert!(
            V3ProviderHealthPersistenceWriter::start(V3ProviderCooldownCoordinator::new(path))
                .is_ok(),
            "state ownership must be available after the first process exits"
        );
    }

    #[test]
    fn indeterminate_health_snapshot_reconciles_without_losing_cooldown() {
        use crate::global_cooldown::{
            clear_test_sync_failure, set_test_sync_failure, V3TestSyncFailure,
        };
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let writer = V3ProviderHealthPersistenceWriter::start(V3ProviderCooldownCoordinator::new(
            path.clone(),
        ))
        .unwrap();
        let key = V3ProviderCooldownKey {
            provider_id: "p".into(),
            interface_id: "responses".into(),
            auth_alias: Some("k".into()),
            model_id: Some("m".into()),
            failure_class: V3ProviderCooldownFailureClass::RateLimit,
        };
        set_test_sync_failure(path.clone(), V3TestSyncFailure::Directory);
        assert!(writer
            .flush_snapshot(vec![(key.clone(), 1_000, 1_000)], vec![])
            .is_err());
        clear_test_sync_failure(&path);
        writer
            .flush_snapshot(vec![(key.clone(), 1_000, 1_000)], vec![])
            .unwrap();
        assert_eq!(
            V3ProviderCooldownCoordinator::load(path)
                .unwrap()
                .persisted_entries(),
            vec![(key, 1_000, 1_000)]
        );
        assert!(writer.alarm().is_none());
    }

    #[test]
    fn restarted_health_restores_persisted_active_cooldown() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cooldowns.json");
        let key = V3ProviderCooldownKey {
            provider_id: "p".into(),
            interface_id: "default".into(),
            auth_alias: Some("k".into()),
            model_id: Some("m".into()),
            failure_class: V3ProviderCooldownFailureClass::Semantic,
        };
        let mut previous = V3ProviderCooldownCoordinator::new(path.clone());
        previous
            .replace_entries(vec![(key, 60_100, 60_100)])
            .unwrap();
        drop(previous);
        let restarted = V3ProviderHealthStore::from_manifest_with_persistence_path(
            &manifest("s", "127.0.0.1", 1),
            path,
        );
        assert!(
            !restarted
                .availability("p", Some("k"), Some("m"), 100)
                .unwrap()
                .available,
            "restart must restore an active cooldown until its deadline"
        );
    }

    #[test]
    fn health_restart_requires_durable_loaded_state() {
        use crate::global_cooldown::{
            clear_test_sync_failure, set_test_sync_failure, V3TestSyncFailure,
        };
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let key = V3ProviderCooldownKey {
            provider_id: "p".into(),
            interface_id: "default".into(),
            auth_alias: Some("k".into()),
            model_id: Some("m".into()),
            failure_class: V3ProviderCooldownFailureClass::Semantic,
        };
        let mut initial = V3ProviderCooldownCoordinator::new(path.clone());
        initial
            .replace_entries(vec![(key, 60_100, 60_100)])
            .unwrap();
        drop(initial);
        set_test_sync_failure(path.clone(), V3TestSyncFailure::Directory);
        let (writer, entries, _) = start_provider_health_persistence(
            &manifest("s", "127.0.0.1", 1),
            Some(path.clone()),
            None,
            None,
        )
        .unwrap();
        clear_test_sync_failure(&path);
        assert_eq!(
            entries.len(),
            1,
            "restart must preserve persisted cooldowns"
        );
        assert!(
            writer.alarm().is_some(),
            "startup must not enable learning while loaded state durability is unconfirmed"
        );
    }

    #[test]
    fn issue44cc3af_newer_429_snapshot_cannot_be_overwritten_by_late_old_ticket() {
        use crate::global_cooldown::V3ProviderRateLimitEpisode;
        use crate::provider_cooldown_probe::provider_cooldown_probe_key_for_interface;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cooldowns.json");
        let manifest = manifest("s", "127.0.0.1", 1);
        let store =
            V3ProviderHealthStore::from_manifest_with_persistence_path(&manifest, path.clone());
        let key = provider_cooldown_probe_key_for_interface("p", "default", Some("k"), Some("m"));
        let (old, new) = {
            let mut state = store.state.write().unwrap();
            state
                .adaptive_history
                .entry(key.clone())
                .or_default()
                .rate_limit_episode = Some(V3ProviderRateLimitEpisode {
                policy_version: 1,
                consecutive_429: 1,
                total_429: 1,
                ..Default::default()
            });
            let old = V3ProviderHealthPersistenceTicket::from_state(&state).unwrap();
            state
                .adaptive_history
                .get_mut(&key)
                .unwrap()
                .rate_limit_episode
                .as_mut()
                .unwrap()
                .total_429 = 2;
            let new = V3ProviderHealthPersistenceTicket::from_state(&state).unwrap();
            (old, new)
        };
        let writer = new.writer.clone();
        new.enqueue();
        old.enqueue();
        let (sender, receiver) = mpsc::channel();
        writer
            .sender
            .send(V3ProviderHealthPersistenceCommand::Flush(sender))
            .unwrap();
        receiver.recv().unwrap().unwrap();
        let episodes = V3ProviderCooldownCoordinator::load(path)
            .unwrap()
            .persisted_rate_limit_episodes();
        assert_eq!(
            episodes[0].1.total_429, 2,
            "late old snapshot must not roll state backward"
        );
    }

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

    #[test]
    fn provider_cooldown_state_path_changes_when_provider_identity_changes() {
        let primary = manifest("primary", "127.0.0.1", 1);
        let mut changed = primary.clone();
        changed
            .providers
            .values_mut()
            .next()
            .expect("fixture provider")
            .enabled = false;
        assert_ne!(
            provider_cooldown_state_path_for_manifest(&primary),
            provider_cooldown_state_path_for_manifest(&changed),
            "provider config revisions must not reuse stale cooldown persistence"
        );
    }

    #[test]
    fn listener_cooldown_state_path_survives_provider_configuration_change() {
        let original = manifest_with_servers(&[("a", "127.0.0.1", 1), ("b", "127.0.0.1", 2)]);
        let mut changed = original.clone();
        changed.providers.values_mut().next().unwrap().enabled = false;
        let listener = V3ProviderHealthListenerScope {
            server_id: "a".into(),
            bind: "127.0.0.1".into(),
            port: 1,
        };
        assert_eq!(
            provider_cooldown_state_path_for_listener(&original, &listener),
            provider_cooldown_state_path_for_listener(&changed, &listener),
            "unchanged listener must retain its cooldown state across provider changes"
        );
    }

    #[test]
    fn listener_migration_preserves_only_configured_cooldown_identities() {
        let root = tempfile::tempdir().unwrap();
        let previous = root.path().join("previous.json");
        let stable = root.path().join("stable.json");
        let manifest = manifest("s", "127.0.0.1", 1);
        let valid = V3ProviderCooldownKey {
            provider_id: "p".into(),
            interface_id: "default".into(),
            auth_alias: Some("k".into()),
            model_id: Some("m".into()),
            failure_class: V3ProviderCooldownFailureClass::Semantic,
        };
        let removed = V3ProviderCooldownKey {
            model_id: Some("removed".into()),
            ..valid.clone()
        };
        let mut old = V3ProviderCooldownCoordinator::new(previous.clone());
        old.replace_entries(vec![(valid.clone(), 1_000, 1_000), (removed, 2_000, 2_000)])
            .unwrap();
        let migrated =
            load_provider_cooldown_coordinator(&manifest, stable.clone(), Some(previous), None)
                .unwrap();
        assert_eq!(
            migrated.persisted_entries(),
            vec![(valid.clone(), 1_000, 1_000)]
        );
        assert_eq!(
            V3ProviderCooldownCoordinator::load(stable)
                .unwrap()
                .persisted_entries(),
            vec![(valid, 1_000, 1_000)]
        );
    }

    #[test]
    fn legacy_migration_accepts_only_current_provider_keys() {
        let manifest = manifest("primary", "127.0.0.1", 1);
        let valid = V3ProviderCooldownKey {
            provider_id: "p".into(),
            interface_id: "default".into(),
            auth_alias: Some("k".into()),
            model_id: Some("m".into()),
            failure_class: V3ProviderCooldownFailureClass::Semantic,
        };
        let stale_provider = V3ProviderCooldownKey {
            provider_id: "removed".into(),
            ..valid.clone()
        };
        let stale_auth = V3ProviderCooldownKey {
            auth_alias: Some("removed-key".into()),
            ..valid.clone()
        };
        let stale_model = V3ProviderCooldownKey {
            model_id: Some("removed-model".into()),
            ..valid.clone()
        };
        let stale_interface = V3ProviderCooldownKey {
            interface_id: "removed-interface".into(),
            ..valid.clone()
        };
        assert!(manifest_contains_cooldown_key(&manifest, &valid));
        assert!(!manifest_contains_cooldown_key(&manifest, &stale_provider));
        assert!(!manifest_contains_cooldown_key(&manifest, &stale_auth));
        assert!(!manifest_contains_cooldown_key(&manifest, &stale_model));
        assert!(!manifest_contains_cooldown_key(&manifest, &stale_interface));

        let mut named_manifest = manifest.clone();
        let provider = named_manifest
            .providers
            .get_mut("p")
            .expect("fixture provider");
        let mut chat = provider
            .interfaces
            .get("default")
            .expect("default interface")
            .clone();
        chat.id = "chat".to_string();
        provider.interfaces.insert("chat".to_string(), chat);
        let named_interface = V3ProviderCooldownKey {
            interface_id: "chat".into(),
            ..valid.clone()
        };
        assert!(manifest_contains_cooldown_key(
            &named_manifest,
            &named_interface
        ));
        named_manifest
            .providers
            .get_mut("p")
            .expect("fixture provider")
            .interfaces
            .get_mut("chat")
            .expect("named interface")
            .enabled = false;
        assert!(!manifest_contains_cooldown_key(
            &named_manifest,
            &named_interface
        ));
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
        ))
        .expect("start persistence writer");
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

        let restored = V3ProviderCooldownCoordinator::load(path)
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
        let mut coordinator = V3ProviderCooldownCoordinator::new(path.clone());
        coordinator
            .replace_entries(vec![(
                V3ProviderCooldownKey {
                    provider_id: "provider-a".into(),
                    interface_id: "default".into(),
                    auth_alias: Some("key-a".into()),
                    model_id: Some("model-a".into()),
                    failure_class: V3ProviderCooldownFailureClass::Auth,
                },
                60_100,
                60_100,
            )])
            .expect("seed auth cooldown");
        let writer = V3ProviderHealthPersistenceWriter::start(coordinator)
            .expect("start persistence writer");
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

        let restored =
            V3ProviderCooldownCoordinator::load(path).expect("load mixed provider cooldown state");
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
        ))
        .expect("start persistence writer");
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
                .unwrap()
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

    #[test]
    fn unsupported_provider_cooldown_schema_disables_persistence_without_overwriting() {
        let root = tempfile::tempdir().expect("create isolated persistence directory");
        let path = root.path().join("provider-cooldowns.json");
        let contents = br#"{"schema_version": 999, "entries": []}"#;
        std::fs::write(&path, contents).expect("write unsupported cooldown state");
        let manifest = manifest("s", "127.0.0.1", 1);

        let (writer, entries, _) =
            start_provider_health_persistence(&manifest, Some(path.clone()), None, None)
                .expect("an unreadable cooldown state must not stop provider health persistence");

        assert!(
            entries.is_empty(),
            "an unreadable cooldown state must start from no persisted cooldown"
        );
        let alarm = writer
            .alarm()
            .expect("an unreadable cooldown state must raise the persistence alarm");
        assert!(
            alarm.contains("provider cooldown persistence load failed"),
            "{alarm}"
        );
        assert!(
            alarm.contains("unsupported provider cooldown state schema 999"),
            "{alarm}"
        );
        assert_eq!(std::fs::read(&path).expect("read original state"), contents);

        writer.enqueue(Vec::new(), Vec::new());
        assert!(writer.flush_snapshot(Vec::new(), Vec::new()).is_err());
        assert_eq!(std::fs::read(path).expect("read original state"), contents);
        assert!(writer
            .alarm()
            .expect("disabled persistence must retain its first failure")
            .contains("unsupported provider cooldown state schema 999"));
    }

    #[test]
    fn corrupt_provider_cooldown_state_disables_persistence_without_overwriting() {
        let root = tempfile::tempdir().expect("create isolated persistence directory");
        let path = root.path().join("provider-cooldowns.json");
        let contents = b"{not json";
        std::fs::write(&path, contents).expect("write corrupt cooldown state");
        let manifest = manifest("s", "127.0.0.1", 1);

        let (writer, entries, _) =
            start_provider_health_persistence(&manifest, Some(path.clone()), None, None)
                .expect("a corrupt cooldown state must not stop provider health persistence");

        assert!(entries.is_empty());
        let alarm = writer.alarm().expect("persistence alarm");
        assert!(alarm.contains("decode provider cooldown state"), "{alarm}");
        assert_eq!(std::fs::read(path).expect("read original state"), contents);
    }

    #[test]
    fn persistence_writer_spawn_failure_disables_startup_without_panicking() {
        let root = tempfile::tempdir().expect("create isolated persistence directory");
        let path = root.path().join("provider-cooldowns.json");
        let mut coordinator = V3ProviderCooldownCoordinator::new(path.clone());
        coordinator
            .replace_entries(vec![(
                V3ProviderCooldownKey {
                    provider_id: "p".into(),
                    interface_id: "default".into(),
                    auth_alias: Some("k".into()),
                    model_id: Some("m".into()),
                    failure_class: V3ProviderCooldownFailureClass::Semantic,
                },
                60_100,
                60_100,
            )])
            .expect("seed persisted cooldown");
        let manifest = manifest("s", "127.0.0.1", 1);
        TEST_SPAWN_FAILURE
            .with(|failure| failure.set(Some("injected writer start failure".to_string())));

        let (writer, entries, _) =
            start_provider_health_persistence(&manifest, Some(path), None, None)
                .expect("spawn failure must keep provider health persistence available");

        assert_eq!(
            entries.len(),
            1,
            "startup failure must preserve cooldown entries"
        );
        assert!(writer
            .alarm()
            .expect("disabled writer must retain the startup failure")
            .contains("provider health persistence writer start failed"));
        writer.enqueue(Vec::new(), Vec::new());
        assert!(writer.flush_snapshot(Vec::new(), Vec::new()).is_err());
        assert!(TEST_SPAWN_FAILURE.with(std::cell::Cell::take).is_none());
    }

    #[test]
    fn superseded_cooldown_scope_files_are_pruned_while_recent_generations_survive() {
        // Backdates a generation far enough that the shared-directory age gate
        // treats it as prunable.
        fn backdate(path: &std::path::Path) {
            let modified =
                std::time::SystemTime::now() - std::time::Duration::from_secs(48 * 60 * 60);
            let handle = fs::OpenOptions::new()
                .write(true)
                .open(path)
                .expect("open superseded generation for backdating");
            handle
                .set_times(std::fs::FileTimes::new().set_modified(modified))
                .expect("backdate superseded generation");
        }

        let root = tempfile::tempdir().expect("create isolated persistence directory");
        let current = root.path().join("provider-cooldowns-current.json");
        fs::write(&current, b"{}").expect("write current scope state");
        let legacy = root.path().join("provider-cooldowns-legacy.json");
        fs::write(&legacy, b"{}").expect("write legacy scope state");
        let unrelated = root.path().join("provider-cooldowns.json");
        fs::write(&unrelated, b"{}").expect("write undigested legacy state");
        let other_listener = root
            .path()
            .join("provider-cooldowns-revision-listener.json");
        fs::write(&other_listener, b"{}").expect("write another listener state");
        backdate(&other_listener);
        let mut generations = Vec::new();
        for index in 0..6 {
            let path = root
                .path()
                .join(format!("provider-cooldowns-rev{index}.json"));
            fs::write(&path, b"{}").expect("write superseded scope state");
            // Distinct modification times make the retained-generation rule
            // deterministic instead of depending on filesystem timestamp
            // granularity.
            std::thread::sleep(std::time::Duration::from_millis(20));
            backdate(&path);
            generations.push(path);
        }
        // A concurrently running instance's current scope file: superseded by
        // name for this manifest, but freshly written by its owner.
        let concurrent = root.path().join("provider-cooldowns-concurrent.json");
        fs::write(&concurrent, b"{}").expect("write concurrent scope state");

        prune_stale_provider_cooldown_scope_files(&current, Some(&legacy), &[], None);

        assert!(
            other_listener.exists(),
            "an unscoped owner must not prune listener state"
        );

        assert!(
            current.exists(),
            "the live scope state must never be pruned"
        );
        assert!(
            legacy.exists(),
            "the legacy scope state must never be pruned"
        );
        assert!(
            unrelated.exists(),
            "an undigested provider-cooldowns.json is not a scope generation"
        );
        assert!(
            concurrent.exists(),
            "a recently written scope file is never pruned, even when superseded by name"
        );
        for (index, path) in generations.iter().enumerate() {
            assert_eq!(
                path.exists(),
                index >= 2,
                "only the newest four prunable generations are retained: {}",
                path.display()
            );
        }
    }
}

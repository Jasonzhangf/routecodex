use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

static PERSIST_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum V3TestSyncFailure {
    File,
    Directory,
}

#[cfg(test)]
fn sync_failures() -> &'static std::sync::Mutex<BTreeMap<PathBuf, V3TestSyncFailure>> {
    static FAILURES: std::sync::OnceLock<std::sync::Mutex<BTreeMap<PathBuf, V3TestSyncFailure>>> = std::sync::OnceLock::new();
    FAILURES.get_or_init(|| std::sync::Mutex::new(BTreeMap::new()))
}

#[cfg(test)]
pub(crate) fn set_test_sync_failure(path: PathBuf, failure: V3TestSyncFailure) {
    sync_failures().lock().unwrap().insert(path, failure);
}

#[cfg(test)]
pub(crate) fn clear_test_sync_failure(path: &Path) {
    sync_failures().lock().unwrap().remove(path);
}

#[cfg(test)]
fn check_test_sync_failure(path: &Path, phase: V3TestSyncFailure) -> std::io::Result<()> {
    if sync_failures().lock().unwrap().get(path) == Some(&phase) {
        Err(std::io::Error::other("injected provider state sync failure"))
    } else {
        Ok(())
    }
}

const SCHEMA_VERSION: u32 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Ord, PartialOrd, Serialize, Deserialize)]
pub enum V3ProviderCooldownFailureClass {
    Auth,
    Quota,
    RateLimit,
    Transport,
    Semantic,
    ProbeLong,
    /// Existing on-disk manual-control class. A model-less key is an auth
    /// hold; a model-scoped key is a manual probe hold.
    ManualAuth,
}

#[derive(Debug, Clone, PartialEq, Eq, Ord, PartialOrd, Serialize, Deserialize)]
pub struct V3ProviderCooldownKey {
    pub provider_id: String,
    #[serde(default = "default_interface_id")]
    pub interface_id: String,
    pub auth_alias: Option<String>,
    pub model_id: Option<String>,
    pub failure_class: V3ProviderCooldownFailureClass,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct V3ProviderRateLimitEpisode {
    #[serde(default)]
    pub policy_version: u8,
    #[serde(default)]
    pub consecutive_429: u32,
    #[serde(default)]
    pub total_429: u32,
    #[serde(default)]
    pub cooldown_duration_ms: u64,
    pub first_429_at_ms: Option<u64>,
    pub last_429_at_ms: Option<u64>,
    pub not_before_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct V3ProviderCooldownEntry {
    blocked_until_ms: u64,
    next_probe_at_ms: u64,
    probe_in_flight: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct V3ProviderCooldownFile {
    schema_version: u32,
    #[serde(default)]
    state_revision: u64,
    entries: Vec<(V3ProviderCooldownKey, V3ProviderCooldownEntry)>,
    #[serde(default)]
    rate_limit_episodes: Vec<(V3ProviderCooldownKey, V3ProviderRateLimitEpisode)>,
}

enum V3PersistenceCommitError {
    NotCommitted(String),
    Indeterminate(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum V3ReconciledCommit {
    Committed,
    NotCommitted,
}

#[derive(Debug, Clone)]
pub struct V3ProviderCooldownCoordinator {
    path: PathBuf,
    ownership: Option<Arc<fs::File>>,
    state_revision: u64,
    indeterminate: Option<Box<V3ProviderCooldownCoordinator>>,
    entries: BTreeMap<V3ProviderCooldownKey, V3ProviderCooldownEntry>,
    rate_limit_episodes: BTreeMap<V3ProviderCooldownKey, V3ProviderRateLimitEpisode>,
}

impl V3ProviderCooldownCoordinator {
    pub(crate) fn state_path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn attach_ownership(&mut self, ownership: Arc<fs::File>) {
        self.ownership = Some(ownership);
    }

    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            ownership: None,
            state_revision: 0,
            indeterminate: None,
            entries: BTreeMap::new(),
            rate_limit_episodes: BTreeMap::new(),
        }
    }

    pub fn load(path: PathBuf) -> Result<Self, String> {
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::new(path))
            }
            Err(error) => return Err(format!("read provider cooldown state: {error}")),
        };
        let file: V3ProviderCooldownFile = serde_json::from_slice(&bytes)
            .map_err(|error| format!("decode provider cooldown state: {error}"))?;
        if !matches!(file.schema_version, 1 | 2 | 3 | 4 | SCHEMA_VERSION) {
            return Err(format!(
                "unsupported provider cooldown state schema {}",
                file.schema_version
            ));
        }
        Ok(Self {
            path,
            ownership: None,
            state_revision: file.state_revision,
            indeterminate: None,
            entries: file.entries.into_iter().collect(),
            rate_limit_episodes: file.rate_limit_episodes.into_iter().collect(),
        })
    }

    fn persist(&mut self) -> Result<(), V3PersistenceCommitError> {
        let _temporary_ownership = if self.ownership.is_none() {
            Some(acquire_state_writer_lock(&self.path).map_err(V3PersistenceCommitError::NotCommitted)?)
        } else {
            None
        };
        if let Some(parent) = self.path.parent().filter(|p| !p.as_os_str().is_empty()) {
            fs::create_dir_all(parent)
                .map_err(|error| V3PersistenceCommitError::NotCommitted(format!("create provider cooldown state directory: {error}")))?;
        }
        let next_revision = self.state_revision.checked_add(1)
            .ok_or_else(|| V3PersistenceCommitError::NotCommitted("provider state revision exhausted".to_owned()))?;
        let bytes = serde_json::to_vec_pretty(&V3ProviderCooldownFile {
            schema_version: SCHEMA_VERSION,
            state_revision: next_revision,
            entries: self
                .entries
                .iter()
                .map(|(key, entry)| (key.clone(), entry.clone()))
                .collect(),
            rate_limit_episodes: self
                .rate_limit_episodes
                .iter()
                .map(|(key, episode)| (key.clone(), episode.clone()))
                .collect(),
        })
        .map_err(|error| V3PersistenceCommitError::NotCommitted(format!("encode provider cooldown state: {error}")))?;
        let temp = self.path.with_extension(format!(
            "json.tmp.{}.{}",
            std::process::id(),
            PERSIST_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temp)
            .map_err(|error| V3PersistenceCommitError::NotCommitted(format!("create provider cooldown state temp file: {error}")))?;
        let before_rename = (|| -> std::io::Result<()> {
            file.write_all(&bytes)?;
            #[cfg(test)]
            check_test_sync_failure(&self.path, V3TestSyncFailure::File)?;
            file.sync_all()
        })();
        if let Err(error) = before_rename {
            let _ = fs::remove_file(&temp);
            return Err(V3PersistenceCommitError::NotCommitted(format!("write or sync provider cooldown state: {error}")));
        }
        fs::rename(&temp, &self.path).map_err(|error|
            V3PersistenceCommitError::Indeterminate(format!("rename provider cooldown state: {error}")))?;
        let parent = self.path.parent().filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        #[cfg(test)]
        check_test_sync_failure(&self.path, V3TestSyncFailure::Directory)
            .map_err(|error| V3PersistenceCommitError::Indeterminate(format!("sync provider state directory: {error}")))?;
        fs::File::open(parent).and_then(|directory| directory.sync_all())
            .map_err(|error| V3PersistenceCommitError::Indeterminate(format!("sync provider state directory: {error}")))?;
        self.state_revision = next_revision;
        Ok(())
    }

    pub fn persisted_entries(&self) -> Vec<(V3ProviderCooldownKey, u64, u64)> {
        self.entries
            .iter()
            .map(|(key, entry)| (key.clone(), entry.blocked_until_ms, entry.next_probe_at_ms))
            .collect()
    }

    pub fn persisted_rate_limit_episodes(
        &self,
    ) -> Vec<(V3ProviderCooldownKey, V3ProviderRateLimitEpisode)> {
        self.rate_limit_episodes
            .iter()
            .map(|(key, episode)| (key.clone(), episode.clone()))
            .collect()
    }

    /// Confirm a surviving record before admitting a new writer after a prior
    /// process may have failed between rename and directory synchronization.
    pub(crate) fn sync_loaded_state(&self) -> Result<(), String> {
        let file = match fs::File::open(&self.path) {
            Ok(file) => Some(file),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("open provider state for reconciliation: {error}")),
        };
        if let Some(file) = file {
            #[cfg(test)]
            check_test_sync_failure(&self.path, V3TestSyncFailure::File)
                .map_err(|error| format!("sync loaded provider state: {error}"))?;
            file.sync_all().map_err(|error| format!("sync loaded provider state: {error}"))?;
        }
        let parent = self.path.parent().filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        #[cfg(test)]
        check_test_sync_failure(&self.path, V3TestSyncFailure::Directory)
            .map_err(|error| format!("sync loaded provider state directory: {error}"))?;
        fs::File::open(parent).and_then(|directory| directory.sync_all())
            .map_err(|error| format!("sync loaded provider state directory: {error}"))
    }

    fn prepare_update(&self) -> Result<Self, String> {
        if self.indeterminate.is_some() {
            return Err("provider state commit is indeterminate; reconciliation required".to_owned());
        }
        if self.ownership.is_some() {
            return Ok(self.clone());
        }
        let ownership = Arc::new(acquire_state_writer_lock(&self.path)?);
        let mut current = Self::load(self.path.clone())?;
        current.attach_ownership(ownership);
        current.sync_loaded_state()?;
        Ok(current)
    }

    fn accept_update(&mut self, candidate: Self) {
        self.state_revision = candidate.state_revision;
        self.entries = candidate.entries;
        self.rate_limit_episodes = candidate.rate_limit_episodes;
    }

    fn commit_candidate(&mut self, mut candidate: Self) -> Result<(), String> {
        match candidate.persist() {
            Ok(()) => { self.accept_update(candidate); Ok(()) }
            Err(V3PersistenceCommitError::NotCommitted(error)) => Err(error),
            Err(V3PersistenceCommitError::Indeterminate(error)) => {
                self.indeterminate = Some(Box::new(candidate));
                Err(format!("provider state commit indeterminate: {error}"))
            }
        }
    }

    pub(crate) fn has_indeterminate_commit(&self) -> bool {
        self.indeterminate.is_some()
    }

    pub(crate) fn reconcile_indeterminate(&mut self) -> Result<Option<V3ReconciledCommit>, String> {
        let Some(pending) = self.indeterminate.as_ref() else { return Ok(None); };
        if self.ownership.is_none() {
            return Err("provider state reconciliation requires writer ownership".to_owned());
        }
        let current = Self::load(self.path.clone())?;
        let expected_revision = pending.state_revision.checked_add(1)
            .ok_or_else(|| "provider state revision exhausted".to_owned())?;
        let same_values = |left: &Self, right: &Self| {
            left.entries == right.entries
                && left.rate_limit_episodes == right.rate_limit_episodes
        };
        let result = if current.state_revision == expected_revision && same_values(&current, pending) {
            V3ReconciledCommit::Committed
        } else if current.state_revision == self.state_revision && same_values(&current, self) {
            V3ReconciledCommit::NotCommitted
        } else {
            return Err("provider state reconciliation found an unexpected record".to_owned());
        };
        current.sync_loaded_state()?;
        self.accept_update(current);
        self.indeterminate = None;
        Ok(Some(result))
    }

    /// Preserve cooldown deadlines across restart, but always begin a fresh
    /// startup probe cycle for every persisted entry.
    pub fn reset_probe_schedule_for_startup(&mut self) -> Result<(), String> {
        let mut candidate = self.prepare_update()?;
        if candidate.entries.is_empty() {
            return Ok(());
        }
        for (key, entry) in &mut candidate.entries {
            if key.failure_class != V3ProviderCooldownFailureClass::RateLimit {
                entry.next_probe_at_ms = 0;
            }
            entry.probe_in_flight = false;
        }
        self.commit_candidate(candidate)
    }

    pub fn replace_entries(
        &mut self,
        entries: Vec<(V3ProviderCooldownKey, u64, u64)>,
    ) -> Result<(), String> {
        let mut candidate = self.prepare_update()?;
        if candidate.state_revision != self.state_revision {
            return Err("provider state snapshot is stale".to_owned());
        }
        candidate.replace_entries_in_memory(entries);
        self.commit_candidate(candidate)
    }

    pub fn replace_entries_and_rate_limit_episodes(
        &mut self,
        entries: Vec<(V3ProviderCooldownKey, u64, u64)>,
        episodes: Vec<(V3ProviderCooldownKey, V3ProviderRateLimitEpisode)>,
    ) -> Result<(), String> {
        let mut candidate = self.prepare_update()?;
        if candidate.state_revision != self.state_revision {
            return Err("provider state snapshot is stale".to_owned());
        }
        candidate.replace_entries_in_memory(entries);
        candidate.rate_limit_episodes = episodes.into_iter().collect();
        self.commit_candidate(candidate)
    }

    fn replace_entries_in_memory(&mut self, entries: Vec<(V3ProviderCooldownKey, u64, u64)>) {
        self.entries = entries
            .into_iter()
            .map(|(key, blocked_until_ms, next_probe_at_ms)| {
                (
                    key,
                    V3ProviderCooldownEntry {
                        blocked_until_ms,
                        next_probe_at_ms,
                        probe_in_flight: false,
                    },
                )
            })
            .collect();
    }
}

pub(crate) fn acquire_state_writer_lock(path: &Path) -> Result<fs::File, String> {
    let parent = path.parent().filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|error| format!("create provider state directory: {error}"))?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|error| format!("resolve provider state directory: {error}"))?;
    let name = path.file_name().ok_or_else(|| "provider state path has no filename".to_string())?;
    let mut lock_name = name.to_os_string();
    lock_name.push(".lock");
    let lock = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false)
        .open(canonical_parent.join(lock_name))
        .map_err(|error| format!("open provider state ownership lock: {error}"))?;
    lock.try_lock().map_err(|error| format!("provider state already owned or unavailable: {error}"))?;
    Ok(lock)
}

fn default_interface_id() -> String {
    "default".to_string()
}

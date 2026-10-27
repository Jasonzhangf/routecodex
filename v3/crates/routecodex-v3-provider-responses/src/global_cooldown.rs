use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

static PERSIST_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

const SCHEMA_VERSION: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Ord, PartialOrd, Serialize, Deserialize)]
pub enum V3ProviderCooldownFailureClass {
    Auth,
    Quota,
    RateLimit,
    Transport,
    Semantic,
    ProbeLong,
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
    pub first_429_at_ms: Option<u64>,
    pub last_429_at_ms: Option<u64>,
    pub not_before_ms: Option<u64>,
    pub probe_required: bool,
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
    entries: Vec<(V3ProviderCooldownKey, V3ProviderCooldownEntry)>,
    #[serde(default)]
    rate_limit_episodes: Vec<(V3ProviderCooldownKey, V3ProviderRateLimitEpisode)>,
}

#[derive(Debug, Clone)]
pub struct V3ProviderCooldownCoordinator {
    path: PathBuf,
    entries: BTreeMap<V3ProviderCooldownKey, V3ProviderCooldownEntry>,
    rate_limit_episodes: BTreeMap<V3ProviderCooldownKey, V3ProviderRateLimitEpisode>,
}

impl V3ProviderCooldownCoordinator {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
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
        if !matches!(file.schema_version, 1 | 2 | SCHEMA_VERSION) {
            return Err(format!(
                "unsupported provider cooldown state schema {}",
                file.schema_version
            ));
        }
        Ok(Self {
            path,
            entries: file.entries.into_iter().collect(),
            rate_limit_episodes: file.rate_limit_episodes.into_iter().collect(),
        })
    }

    fn persist(&self) -> Result<(), String> {
        if let Some(parent) = self.path.parent().filter(|p| !p.as_os_str().is_empty()) {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create provider cooldown state directory: {error}"))?;
        }
        let bytes = serde_json::to_vec_pretty(&V3ProviderCooldownFile {
            schema_version: SCHEMA_VERSION,
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
        .map_err(|error| format!("encode provider cooldown state: {error}"))?;
        let temp = self.path.with_extension(format!(
            "json.tmp.{}.{}",
            std::process::id(),
            PERSIST_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::write(&temp, bytes)
            .map_err(|error| format!("write provider cooldown state: {error}"))?;
        fs::rename(&temp, &self.path)
            .map_err(|error| format!("commit provider cooldown state: {error}"))
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

    /// Preserve cooldown deadlines across restart, but always begin a fresh
    /// startup probe cycle for every persisted entry.
    pub fn reset_probe_schedule_for_startup(&mut self) -> Result<(), String> {
        if self.entries.is_empty() {
            return Ok(());
        }
        for entry in self.entries.values_mut() {
            entry.next_probe_at_ms = 0;
            entry.probe_in_flight = false;
        }
        self.persist()
    }

    pub fn replace_entries(
        &mut self,
        entries: Vec<(V3ProviderCooldownKey, u64, u64)>,
    ) -> Result<(), String> {
        self.replace_entries_and_rate_limit_episodes(entries, self.persisted_rate_limit_episodes())
    }

    pub fn replace_entries_and_rate_limit_episodes(
        &mut self,
        entries: Vec<(V3ProviderCooldownKey, u64, u64)>,
        episodes: Vec<(V3ProviderCooldownKey, V3ProviderRateLimitEpisode)>,
    ) -> Result<(), String> {
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
        self.rate_limit_episodes = episodes.into_iter().collect();
        self.persist()
    }
}

fn default_interface_id() -> String {
    "default".to_string()
}

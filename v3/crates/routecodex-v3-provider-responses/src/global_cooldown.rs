use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

const PROBE_RETRY_INTERVAL_MS: u64 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Ord, PartialOrd, Serialize, Deserialize)]
pub enum V3ProviderCooldownFailureClass {
    Auth,
    Quota,
    RateLimit,
    Transport,
    Semantic,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct V3ProviderCooldownObservation {
    pub reset_at_ms: Option<u64>,
    pub retry_after_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Ord, PartialOrd, Serialize, Deserialize)]
struct V3ProviderCooldownKey {
    provider_id: String,
    auth_alias: Option<String>,
    model_id: Option<String>,
    failure_class: V3ProviderCooldownFailureClass,
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
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderCooldownProbePermit {
    key: V3ProviderCooldownKey,
}

impl V3ProviderCooldownProbePermit {
    pub fn provider_id(&self) -> &str {
        &self.key.provider_id
    }
    pub fn auth_alias(&self) -> Option<&str> {
        self.key.auth_alias.as_deref()
    }
    pub fn model_id(&self) -> Option<&str> {
        self.key.model_id.as_deref()
    }
}

#[derive(Debug, Clone)]
pub struct V3ProviderCooldownCoordinator {
    path: PathBuf,
    max_cooldown_ms: u64,
    entries: BTreeMap<V3ProviderCooldownKey, V3ProviderCooldownEntry>,
}

impl V3ProviderCooldownCoordinator {
    pub fn new(path: PathBuf, max_cooldown_ms: u64) -> Self {
        Self {
            path,
            max_cooldown_ms: max_cooldown_ms.max(1),
            entries: BTreeMap::new(),
        }
    }

    pub fn load(path: PathBuf, max_cooldown_ms: u64) -> Result<Self, String> {
        let bytes =
            fs::read(&path).map_err(|error| format!("read provider cooldown state: {error}"))?;
        let file: V3ProviderCooldownFile = serde_json::from_slice(&bytes)
            .map_err(|error| format!("decode provider cooldown state: {error}"))?;
        if file.schema_version != 1 {
            return Err(format!(
                "unsupported provider cooldown state schema {}",
                file.schema_version
            ));
        }
        Ok(Self {
            path,
            max_cooldown_ms: max_cooldown_ms.max(1),
            entries: file.entries.into_iter().collect(),
        })
    }

    pub fn record_failure(
        &mut self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        failure_class: V3ProviderCooldownFailureClass,
        now_ms: u64,
        observation: V3ProviderCooldownObservation,
    ) -> Result<(), String> {
        let max_deadline = now_ms.saturating_add(self.max_cooldown_ms);
        let observed_deadline = observation
            .reset_at_ms
            .or_else(|| {
                observation
                    .retry_after_ms
                    .map(|delta| now_ms.saturating_add(delta))
            })
            .unwrap_or(max_deadline);
        let key = self.key(provider_id, auth_alias, model_id, failure_class);
        self.entries.insert(
            key,
            V3ProviderCooldownEntry {
                blocked_until_ms: observed_deadline.min(max_deadline),
                next_probe_at_ms: observed_deadline.min(max_deadline),
                probe_in_flight: false,
            },
        );
        self.persist()
    }

    pub fn persist(&self) -> Result<(), String> {
        if let Some(parent) = self
            .path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent)
                .map_err(|error| format!("create provider cooldown state directory: {error}"))?;
        }
        let bytes = serde_json::to_vec_pretty(&V3ProviderCooldownFile {
            schema_version: 1,
            entries: self
                .entries
                .iter()
                .map(|(key, entry)| (key.clone(), entry.clone()))
                .collect(),
        })
        .map_err(|error| format!("encode provider cooldown state: {error}"))?;
        let temp = self.path.with_extension("json.tmp");
        fs::write(&temp, bytes)
            .map_err(|error| format!("write provider cooldown state: {error}"))?;
        fs::rename(&temp, &self.path)
            .map_err(|error| format!("commit provider cooldown state: {error}"))
    }

    pub fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> bool {
        !self.entries.iter().any(|(key, entry)| {
            key.provider_id == provider_id
                && key.auth_alias.as_deref() == auth_alias
                && (key.model_id.is_none() || key.model_id.as_deref() == model_id)
                && (entry.probe_in_flight
                    || entry.next_probe_at_ms > now_ms
                    || entry.blocked_until_ms > now_ms)
        })
    }

    pub fn acquire_startup_probe(
        &mut self,
        _now_ms: u64,
    ) -> Result<Option<V3ProviderCooldownProbePermit>, String> {
        let Some((key, entry)) = self
            .entries
            .iter_mut()
            .find(|(_, entry)| !entry.probe_in_flight)
        else {
            return Ok(None);
        };
        entry.probe_in_flight = true;
        Ok(Some(V3ProviderCooldownProbePermit { key: key.clone() }))
    }

    pub fn acquire_due_probe(
        &mut self,
        now_ms: u64,
    ) -> Result<Option<V3ProviderCooldownProbePermit>, String> {
        let Some((key, entry)) = self
            .entries
            .iter_mut()
            .find(|(_, entry)| !entry.probe_in_flight && entry.next_probe_at_ms <= now_ms)
        else {
            return Ok(None);
        };
        entry.probe_in_flight = true;
        Ok(Some(V3ProviderCooldownProbePermit { key: key.clone() }))
    }

    pub fn apply_probe_success(
        &mut self,
        permit: V3ProviderCooldownProbePermit,
        _now_ms: u64,
    ) -> Result<(), String> {
        self.entries.remove(&permit.key);
        self.persist()
    }

    pub fn apply_probe_failure(
        &mut self,
        permit: V3ProviderCooldownProbePermit,
        now_ms: u64,
    ) -> Result<(), String> {
        let entry = self
            .entries
            .get_mut(&permit.key)
            .ok_or_else(|| "provider cooldown probe state missing".to_string())?;
        entry.probe_in_flight = false;
        entry.next_probe_at_ms = now_ms.saturating_add(PROBE_RETRY_INTERVAL_MS);
        self.persist()
    }

    pub fn max_deadline_ms(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
    ) -> Option<u64> {
        self.entries.iter().find_map(|(key, entry)| {
            (key.provider_id == provider_id
                && key.auth_alias.as_deref() == auth_alias
                && key.model_id.as_deref() == model_id)
                .then_some(entry.blocked_until_ms)
        })
    }

    fn key(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        failure_class: V3ProviderCooldownFailureClass,
    ) -> V3ProviderCooldownKey {
        V3ProviderCooldownKey {
            provider_id: provider_id.to_string(),
            auth_alias: auth_alias.map(str::to_string),
            model_id: model_id.map(str::to_string),
            failure_class,
        }
    }
}

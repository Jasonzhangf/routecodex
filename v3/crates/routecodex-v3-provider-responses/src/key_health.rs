use routecodex_v3_error::{V3ProviderFailureAction, V3ProviderHealthScope, V3ProviderRecoveryKind};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

const DEFAULT_SCORE_MILLI: u32 = 1_000;
const SUCCESS_SCORE_STEP_MILLI: u32 = 20;
static PERSIST_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
struct V3ProviderKeyHealthIdentity {
    provider_id: String,
    auth_alias: String,
    model_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
struct V3LegacyProviderKeyHealthIdentity {
    provider_id: String,
    auth_alias: String,
    model_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
struct V3ProviderKeyHealthIdentityV3 {
    provider_id: String,
    auth_alias: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct V3ProviderKeyHealthState {
    score_milli: u32,
    failure_streak: u32,
    #[serde(default)]
    scope: V3ProviderHealthScope,
    #[serde(default)]
    failure_class: Option<String>,
    #[serde(default)]
    success_streak: u32,
    #[serde(default)]
    last_failure_at_ms: Option<u64>,
    #[serde(default)]
    last_success_at_ms: Option<u64>,
    cooldown_until_ms: Option<u64>,
    probe_required: bool,
    #[serde(default)]
    global_probe_owned: bool,
    #[serde(default)]
    probe_model_id: Option<String>,
    score_generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct V3ProviderKeyHealthFile {
    schema_version: u32,
    entries: Vec<(V3ProviderKeyHealthIdentity, V3ProviderKeyHealthState)>,
}

#[derive(Debug, Clone, Deserialize)]
struct V3LegacyProviderKeyHealthFile {
    entries: Vec<(V3LegacyProviderKeyHealthIdentity, V3ProviderKeyHealthState)>,
}

#[derive(Debug, Clone, Deserialize)]
struct V3ProviderKeyHealthFileV4 {
    entries: Vec<(V3LegacyProviderKeyHealthIdentity, V3ProviderKeyHealthState)>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3ProviderKeyHealthProjection {
    pub provider_id: String,
    pub auth_alias: String,
    pub model_id: String,
    pub score_milli: u32,
    pub failure_streak: u32,
    pub success_streak: u32,
    pub cooldown: bool,
    pub cooldown_until_ms: Option<u64>,
    pub available: bool,
    pub score_generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3ProviderSchedulingProjection {
    pub provider_id: String,
    pub auth_alias: String,
    pub model_id: String,
    pub priority: i32,
    pub score_milli: u32,
    pub base_weight: u32,
    pub effective_weight_milli: u64,
    pub available: bool,
    pub blocked_scopes: Vec<String>,
    pub score_generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderKeyHealthProbePermit {
    provider_id: String,
    auth_alias: String,
    model_id: String,
    expected_generation: u64,
}

impl V3ProviderKeyHealthProbePermit {
    pub fn provider_id(&self) -> &str {
        &self.provider_id
    }

    pub fn auth_alias(&self) -> &str {
        &self.auth_alias
    }

    pub fn model_id(&self) -> &str {
        &self.model_id
    }

    pub fn expected_generation(&self) -> u64 {
        self.expected_generation
    }
}

pub trait V3ProviderSchedulingReader {
    fn scheduling_projection(
        &self,
        provider_id: &str,
        auth_alias: &str,
        model_id: &str,
        priority: i32,
        base_weight: u32,
        now_ms: u64,
    ) -> V3ProviderSchedulingProjection;
}

impl V3ProviderSchedulingProjection {
    pub fn new(
        provider_id: &str,
        auth_alias: &str,
        model_id: &str,
        priority: i32,
        score_milli: u32,
        base_weight: u32,
    ) -> Self {
        let score_multiplier = 500_u64.saturating_add(u64::from(score_milli));
        Self {
            provider_id: provider_id.to_string(),
            auth_alias: auth_alias.to_string(),
            model_id: model_id.to_string(),
            priority,
            score_milli,
            base_weight,
            effective_weight_milli: u64::from(base_weight.max(1)) * score_multiplier,
            available: true,
            blocked_scopes: Vec::new(),
            score_generation: 0,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct V3ProviderKeyHealthStore {
    state: Arc<RwLock<BTreeMap<V3ProviderKeyHealthIdentity, V3ProviderKeyHealthState>>>,
    probe_in_flight: Arc<RwLock<BTreeMap<V3ProviderKeyHealthIdentity, u64>>>,
    path: Option<PathBuf>,
}

impl V3ProviderKeyHealthStore {
    pub fn new_persistent(path: PathBuf) -> Self {
        Self {
            state: Arc::new(RwLock::new(BTreeMap::new())),
            probe_in_flight: Arc::new(RwLock::new(BTreeMap::new())),
            path: Some(path),
        }
    }

    pub fn load_persistent(path: PathBuf) -> Result<Self, String> {
        let bytes =
            fs::read(&path).map_err(|error| format!("read provider key health state: {error}"))?;
        let value: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|error| format!("decode provider key health state: {error}"))?;
        let schema_version = value
            .get("schema_version")
            .and_then(serde_json::Value::as_u64)
            .ok_or_else(|| "provider key health state schema_version is missing".to_string())?
            as u32;
        let state = match schema_version {
            1 | 2 => {
                let legacy: V3LegacyProviderKeyHealthFile = serde_json::from_value(value)
                    .map_err(|error| format!("decode legacy provider key health state: {error}"))?;
                merge_legacy_entries(legacy.entries)
            }
            3 => {
                let file: V3ProviderKeyHealthFileV3 = serde_json::from_value(value)
                    .map_err(|error| format!("decode provider key health state v3: {error}"))?;
                migrate_v3_entries(file.entries)?
            }
            4 => {
                let file: V3ProviderKeyHealthFile = serde_json::from_value(value)
                    .map_err(|error| format!("decode provider key health state: {error}"))?;
                load_v4_entries(file.entries)?
            }
            4 => {
                let file: V3ProviderKeyHealthFileV4 = serde_json::from_value(value)
                    .map_err(|error| format!("decode provider key health state v4: {error}"))?;
                merge_legacy_entries(file.entries)
            }
            other => {
                return Err(format!(
                    "unsupported provider key health state schema {other}"
                ));
            }
        };
        Ok(Self {
            state: Arc::new(RwLock::new(state)),
            probe_in_flight: Arc::new(RwLock::new(BTreeMap::new())),
            path: Some(path),
        })
    }

    pub fn persist(&self) -> Result<(), String> {
        let Some(path) = self.path.as_ref() else {
            return Ok(());
        };
        let state = self
            .state
            .read()
            .map_err(|_| "provider key health state poisoned".to_string())?;
        persist_state(path, &state)
    }

    pub fn record_provider_failure_action(
        &self,
        provider_id: &str,
        auth_alias: &str,
        model_id: &str,
        action: &V3ProviderFailureAction,
        now_ms: u64,
    ) -> Result<V3ProviderKeyHealthProjection, String> {
        let identity = identity(provider_id, auth_alias, model_id);
        let (result, snapshot) = {
            let mut state = self
                .state
                .write()
                .map_err(|_| "provider key health state poisoned".to_string())?;
            let entry = state.entry(identity.clone()).or_insert_with(default_state);
            entry.probe_model_id = Some(model_id.to_string());

            let mut mutated = true;
            match action.recovery {
                V3ProviderRecoveryKind::IrrecoverableGlobalCooldown => {
                    entry.scope = action.scope;
                    entry.failure_class = Some(action.class_code.clone());
                    entry.failure_streak = action.failure_threshold.max(1);
                    entry.success_streak = 0;
                    entry.last_failure_at_ms = Some(now_ms);
                    entry.score_milli = apply_delta(entry.score_milli, action.score_delta_milli);
                    entry.cooldown_until_ms = Some(now_ms.saturating_add(action.cooldown_ms));
                    entry.probe_required = true;
                    entry.global_probe_owned = true;
                }
                V3ProviderRecoveryKind::RecoverableCounted => {
                    entry.scope = action.scope;
                    entry.failure_class = Some(action.class_code.clone());
                    entry.failure_streak = entry.failure_streak.saturating_add(1);
                    entry.success_streak = 0;
                    entry.last_failure_at_ms = Some(now_ms);
                    entry.score_milli = apply_delta(entry.score_milli, action.score_delta_milli);
                    if action.scope == V3ProviderHealthScope::GlobalProviderKey
                        && entry.failure_streak >= action.failure_threshold.max(1)
                    {
                        entry.cooldown_until_ms = Some(now_ms.saturating_add(action.cooldown_ms));
                        entry.probe_required = true;
                    }
                }
                V3ProviderRecoveryKind::HealthNeutralTransient
                | V3ProviderRecoveryKind::NotProviderHealth => mutated = false,
            }
            if mutated {
                entry.score_generation = entry.score_generation.saturating_add(1);
            }
            (projection(&identity, entry, now_ms), state.clone())
        };
        persist_if_configured(self.path.as_ref(), &snapshot)?;
        Ok(result)
    }

    pub fn record_provider_success(
        &self,
        provider_id: &str,
        auth_alias: &str,
        model_id: &str,
        now_ms: u64,
    ) -> Result<V3ProviderKeyHealthProjection, String> {
        let identity = identity(provider_id, auth_alias, model_id);
        let (result, snapshot) = {
            let mut state = self
                .state
                .write()
                .map_err(|_| "provider key health state poisoned".to_string())?;
            let entry = state.entry(identity.clone()).or_insert_with(default_state);
            entry.probe_model_id = Some(model_id.to_string());
            entry.score_milli = entry
                .score_milli
                .saturating_add(SUCCESS_SCORE_STEP_MILLI)
                .min(DEFAULT_SCORE_MILLI);
            entry.failure_streak = 0;
            entry.success_streak = entry.success_streak.saturating_add(1);
            entry.last_success_at_ms = Some(now_ms);
            entry.score_generation = entry.score_generation.saturating_add(1);
            (projection(&identity, entry, now_ms), state.clone())
        };
        persist_if_configured(self.path.as_ref(), &snapshot)?;
        Ok(result)
    }

    pub fn complete_probe_success(
        &self,
        provider_id: &str,
        auth_alias: &str,
        model_id: &str,
        now_ms: u64,
    ) -> Result<V3ProviderKeyHealthProjection, String> {
        self.complete_probe_success_at_generation(provider_id, auth_alias, model_id, now_ms, None)
    }

    pub fn complete_probe_success_at_generation(
        &self,
        provider_id: &str,
        auth_alias: &str,
        model_id: &str,
        now_ms: u64,
        expected_generation: Option<u64>,
    ) -> Result<V3ProviderKeyHealthProjection, String> {
        let identity = identity(provider_id, auth_alias, model_id);
        self.remove_probe_in_flight(&identity)?;
        let (result, snapshot) = {
            let mut state = self
                .state
                .write()
                .map_err(|_| "provider key health state poisoned".to_string())?;
            let entry = state.entry(identity.clone()).or_insert_with(default_state);
            entry.probe_model_id = Some(model_id.to_string());
            if let Some(expected_generation) = expected_generation {
                if entry.score_generation != expected_generation {
                    return Err(format!(
                        "stale provider key health probe generation: expected {expected_generation}, current {}",
                        entry.score_generation
                    ));
                }
            }
            entry.cooldown_until_ms = None;
            entry.probe_required = false;
            entry.global_probe_owned = false;
            entry.failure_streak = 0;
            entry.success_streak = entry.success_streak.saturating_add(1);
            entry.last_success_at_ms = Some(now_ms);
            entry.score_milli = entry.score_milli.max(600);
            entry.score_generation = entry.score_generation.saturating_add(1);
            (projection(&identity, entry, now_ms), state.clone())
        };
        persist_if_configured(self.path.as_ref(), &snapshot)?;
        Ok(result)
    }

    pub fn complete_probe_failure(
        &self,
        provider_id: &str,
        auth_alias: &str,
        model_id: &str,
        now_ms: u64,
        cooldown_ms: u64,
    ) -> Result<V3ProviderKeyHealthProjection, String> {
        let identity = identity(provider_id, auth_alias, model_id);
        self.remove_probe_in_flight(&identity)?;
        let (result, snapshot) = {
            let mut state = self
                .state
                .write()
                .map_err(|_| "provider key health state poisoned".to_string())?;
            let entry = state.entry(identity.clone()).or_insert_with(default_state);
            entry.probe_model_id = Some(model_id.to_string());
            entry.cooldown_until_ms = Some(now_ms.saturating_add(cooldown_ms));
            entry.probe_required = true;
            entry.score_milli = apply_delta(entry.score_milli, -50);
            entry.score_generation = entry.score_generation.saturating_add(1);
            (projection(&identity, entry, now_ms), state.clone())
        };
        persist_if_configured(self.path.as_ref(), &snapshot)?;
        Ok(result)
    }

    pub fn provider_key_health_probe_keys(
        &self,
        now_ms: u64,
        startup: bool,
    ) -> Result<Vec<(String, String, String)>, String> {
        let state = self
            .state
            .read()
            .map_err(|_| "provider key health state poisoned".to_string())?;
        let in_flight = self
            .probe_in_flight
            .read()
            .map_err(|_| "provider key health probe lock poisoned".to_string())?;
        Ok(state
            .iter()
            .filter(|(identity, health)| {
                health.probe_required
                    && !health.global_probe_owned
                    && !in_flight.contains_key(identity)
                    && (startup
                        || health
                            .cooldown_until_ms
                            .is_some_and(|deadline| deadline <= now_ms))
            })
            .map(|(identity, _health)| {
                (
                    identity.provider_id.clone(),
                    identity.auth_alias.clone(),
                    identity.model_id.clone(),
                )
            })
            .collect())
    }

    pub fn acquire_provider_key_health_probe(
        &self,
        provider_id: &str,
        auth_alias: &str,
        model_id: &str,
    ) -> Result<Option<V3ProviderKeyHealthProbePermit>, String> {
        let identity = identity(provider_id, auth_alias, model_id);
        let state = self
            .state
            .read()
            .map_err(|_| "provider key health state poisoned".to_string())?
            .get(&identity)
            .filter(|health| health.probe_required && !health.global_probe_owned)
            .map(|health| (health.score_generation, health.probe_model_id.clone()));
        let Some((expected_generation, _probe_model_id)) = state else {
            return Ok(None);
        };
        let mut in_flight = self
            .probe_in_flight
            .write()
            .map_err(|_| "provider key health probe lock poisoned".to_string())?;
        if in_flight
            .insert(identity.clone(), expected_generation)
            .is_some()
        {
            return Ok(None);
        }
        Ok(Some(V3ProviderKeyHealthProbePermit {
            provider_id: identity.provider_id,
            auth_alias: identity.auth_alias,
            model_id: identity.model_id,
            expected_generation,
        }))
    }

    pub fn scheduling_projection(
        &self,
        provider_id: &str,
        auth_alias: &str,
        model_id: &str,
        priority: i32,
        base_weight: u32,
        now_ms: u64,
    ) -> Result<V3ProviderSchedulingProjection, String> {
        let identity = identity(provider_id, auth_alias, model_id);
        let state = self
            .state
            .read()
            .map_err(|_| "provider key health state poisoned".to_string())?;
        let health = state.get(&identity).cloned().unwrap_or_else(default_state);
        let available = health
            .cooldown_until_ms
            .map(|until| now_ms >= until && !health.probe_required)
            .unwrap_or(!health.probe_required);
        let score_multiplier = 500_u64.saturating_add(u64::from(health.score_milli));
        let blocked_scopes = if available {
            Vec::new()
        } else {
            vec!["provider_key_health_cooldown".to_string()]
        };
        Ok(V3ProviderSchedulingProjection {
            provider_id: provider_id.to_string(),
            auth_alias: auth_alias.to_string(),
            model_id: model_id.to_string(),
            priority,
            score_milli: health.score_milli,
            base_weight,
            effective_weight_milli: u64::from(base_weight.max(1)) * score_multiplier,
            available,
            blocked_scopes,
            score_generation: health.score_generation,
        })
    }
}

impl V3ProviderSchedulingReader for V3ProviderKeyHealthStore {
    fn scheduling_projection(
        &self,
        provider_id: &str,
        auth_alias: &str,
        model_id: &str,
        priority: i32,
        base_weight: u32,
        now_ms: u64,
    ) -> V3ProviderSchedulingProjection {
        self.scheduling_projection(
            provider_id,
            auth_alias,
            model_id,
            priority,
            base_weight,
            now_ms,
        )
        .unwrap_or_else(|_| V3ProviderSchedulingProjection {
            provider_id: provider_id.to_string(),
            auth_alias: auth_alias.to_string(),
            model_id: model_id.to_string(),
            priority,
            score_milli: 0,
            base_weight,
            effective_weight_milli: 0,
            available: false,
            blocked_scopes: vec!["provider_key_health_projection_failed".to_string()],
            score_generation: 0,
        })
    }
}

fn load_v4_entries(
    entries: Vec<(V3ProviderKeyHealthIdentity, V3ProviderKeyHealthState)>,
) -> Result<BTreeMap<V3ProviderKeyHealthIdentity, V3ProviderKeyHealthState>, String> {
    let mut state = BTreeMap::new();
    for (identity, health) in entries {
        let inserted = state.insert(identity.clone(), health);
        if inserted.is_some() {
            return Err(format!(
                "duplicate provider key health identity: {}/{}",
                identity.provider_id, identity.auth_alias
            ));
        }
    }
    Ok(state)
}

fn identity(provider_id: &str, auth_alias: &str, model_id: &str) -> V3ProviderKeyHealthIdentity {
    V3ProviderKeyHealthIdentity {
        provider_id: provider_id.to_string(),
        auth_alias: auth_alias.to_string(),
        model_id: model_id.to_string(),
    }
}

fn default_state() -> V3ProviderKeyHealthState {
    V3ProviderKeyHealthState {
        score_milli: DEFAULT_SCORE_MILLI,
        failure_streak: 0,
        scope: V3ProviderHealthScope::None,
        failure_class: None,
        success_streak: 0,
        last_failure_at_ms: None,
        last_success_at_ms: None,
        cooldown_until_ms: None,
        probe_required: false,
        global_probe_owned: false,
        probe_model_id: None,
        score_generation: 0,
    }
}

impl V3ProviderKeyHealthStore {
    fn remove_probe_in_flight(&self, identity: &V3ProviderKeyHealthIdentity) -> Result<(), String> {
        self.probe_in_flight
            .write()
            .map_err(|_| "provider key health probe lock poisoned".to_string())?
            .remove(identity);
        Ok(())
    }
}

fn apply_delta(value: u32, delta: i32) -> u32 {
    if delta.is_negative() {
        value.saturating_sub(delta.unsigned_abs())
    } else {
        value.saturating_add(delta as u32).min(DEFAULT_SCORE_MILLI)
    }
}

fn projection(
    identity: &V3ProviderKeyHealthIdentity,
    state: &V3ProviderKeyHealthState,
    now_ms: u64,
) -> V3ProviderKeyHealthProjection {
    let cooldown = state.probe_required
        || state
            .cooldown_until_ms
            .map(|until| now_ms < until)
            .unwrap_or(false);
    V3ProviderKeyHealthProjection {
        provider_id: identity.provider_id.clone(),
        auth_alias: identity.auth_alias.clone(),
        model_id: identity.model_id.clone(),
        score_milli: state.score_milli,
        failure_streak: state.failure_streak,
        success_streak: state.success_streak,
        cooldown,
        cooldown_until_ms: state.cooldown_until_ms,
        available: !cooldown,
        score_generation: state.score_generation,
    }
}

fn persist_if_configured(
    path: Option<&PathBuf>,
    state: &BTreeMap<V3ProviderKeyHealthIdentity, V3ProviderKeyHealthState>,
) -> Result<(), String> {
    if let Some(path) = path {
        persist_state(path, state)?;
    }
    Ok(())
}

fn persist_state(
    path: &PathBuf,
    state: &BTreeMap<V3ProviderKeyHealthIdentity, V3ProviderKeyHealthState>,
) -> Result<(), String> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create provider key health state directory: {error}"))?;
    }
    let bytes = serde_json::to_vec_pretty(&V3ProviderKeyHealthFile {
        schema_version: 4,
        entries: state
            .iter()
            .map(|(identity, health)| (identity.clone(), health.clone()))
            .collect(),
    })
    .map_err(|error| format!("encode provider key health state: {error}"))?;
    let sequence = PERSIST_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp = path.with_extension(format!("json.tmp.{}.{}", std::process::id(), sequence));
    fs::write(&temp, bytes).map_err(|error| format!("write provider key health state: {error}"))?;
    match fs::rename(&temp, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&temp);
            Err(format!("commit provider key health state: {error}"))
        }
    }
}

fn merge_legacy_entries(
    entries: Vec<(V3LegacyProviderKeyHealthIdentity, V3ProviderKeyHealthState)>,
) -> BTreeMap<V3ProviderKeyHealthIdentity, V3ProviderKeyHealthState> {
    let mut merged = BTreeMap::new();
    for (legacy_identity, mut health) in entries {
        let identity = V3ProviderKeyHealthIdentity {
            provider_id: legacy_identity.provider_id,
            auth_alias: legacy_identity.auth_alias,
            model_id: legacy_identity.model_id.clone(),
        };
        health.probe_model_id = Some(legacy_identity.model_id);
        merged.entry(identity).or_insert(health);
    }
    merged
}

fn migrate_v3_entries(
    entries: Vec<(V3ProviderKeyHealthIdentityV3, V3ProviderKeyHealthState)>,
) -> Result<BTreeMap<V3ProviderKeyHealthIdentity, V3ProviderKeyHealthState>, String> {
    let mut migrated = BTreeMap::new();
    for (legacy_identity, health) in entries {
        let model_id = health.probe_model_id.clone().ok_or_else(|| {
            format!(
                "provider key health state v3 entry is missing probe_model_id for provider {} auth {}",
                legacy_identity.provider_id, legacy_identity.auth_alias
            )
        })?;
        let identity = V3ProviderKeyHealthIdentity {
            provider_id: legacy_identity.provider_id,
            auth_alias: legacy_identity.auth_alias,
            model_id,
        };
        if migrated.insert(identity.clone(), health).is_some() {
            return Err(format!(
                "provider key health state v3 contains duplicate model identity for provider {} auth {} model {}",
                identity.provider_id, identity.auth_alias, identity.model_id
            ));
        }
    }
    Ok(migrated)
}

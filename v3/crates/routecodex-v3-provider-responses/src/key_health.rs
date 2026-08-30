use crate::health::V3ProviderHealthStore;
use serde::Serialize;

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
    pub effective_priority: i32,
    pub score_milli: u32,
    pub base_weight: u32,
    pub effective_weight_milli: u64,
    pub available: bool,
    pub blocked_scopes: Vec<String>,
    pub score_generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderHealthProbePermit {
    provider_id: String,
    auth_alias: Option<String>,
    model_id: Option<String>,
    expected_generation: u64,
}

impl V3ProviderHealthProbePermit {
    pub(crate) fn new(
        provider_id: String,
        auth_alias: Option<String>,
        model_id: Option<String>,
        expected_generation: u64,
    ) -> Self {
        Self {
            provider_id,
            auth_alias,
            model_id,
            expected_generation,
        }
    }

    pub fn provider_id(&self) -> &str {
        &self.provider_id
    }

    pub fn auth_alias(&self) -> Option<&str> {
        self.auth_alias.as_deref()
    }

    pub fn model_id(&self) -> Option<&str> {
        self.model_id.as_deref()
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
        Self {
            provider_id: provider_id.to_string(),
            auth_alias: auth_alias.to_string(),
            model_id: model_id.to_string(),
            priority,
            effective_priority: priority,
            score_milli,
            base_weight,
            effective_weight_milli: u64::from(base_weight.max(1)),
            available: true,
            blocked_scopes: Vec::new(),
            score_generation: 0,
        }
    }
}

// Compatibility name only. State and transitions live in V3ProviderHealthStore.
pub type V3ProviderKeyHealthStore = V3ProviderHealthStore;

use crate::health::V3ProviderHealthStore;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct V3ProviderKeyHealthProjection {
    pub provider_id: String,
    pub interface_id: String,
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
    pub interface_id: String,
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
    interface_id: String,
    auth_alias: Option<String>,
    model_id: Option<String>,
    expected_generation: u64,
    purpose: V3ProviderProbePurpose,
    pub(crate) acquisition_id: V3ProbeAcquisitionId,
}

/// Physical probe purpose for one owned acquisition.
///
/// The purpose qualifies only which control-plane owner may hold the single
/// physical probe slot. It never classifies business health and never by
/// itself authorizes a cooldown or score change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3ProviderProbePurpose {
    /// Recovery probe for an identity already visible in the cooldown pool.
    CooldownRecovery,
    /// Observation probe for a healthy/held identity before any cooling
    /// decision. It shares the same physical slot but holds no cooldown entry.
    PrecoolObservation,
}

/// Typed result of closing one owned pre-cool observation probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3ProviderPrecoolObservationOutcome {
    /// The permit was still the authoritative owner for its health
    /// generation. The observation is closed without fabricating a business
    /// receipt, score change or cooldown.
    Completed,
    /// The permit no longer owned the slot or its health generation had moved.
    /// Nothing was recorded.
    Superseded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3ProviderRateLimitProbeDisposition {
    NotApplicable,
    Superseded,
    Retained,
    Reclassified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct V3ProbeAcquisitionId(pub(crate) u64);

impl V3ProviderHealthProbePermit {
    pub(crate) fn new(
        provider_id: String,
        interface_id: String,
        auth_alias: Option<String>,
        model_id: Option<String>,
        expected_generation: u64,
        acquisition_id: V3ProbeAcquisitionId,
    ) -> Self {
        Self::new_with_purpose(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            expected_generation,
            acquisition_id,
            V3ProviderProbePurpose::CooldownRecovery,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new_with_purpose(
        provider_id: String,
        interface_id: String,
        auth_alias: Option<String>,
        model_id: Option<String>,
        expected_generation: u64,
        acquisition_id: V3ProbeAcquisitionId,
        purpose: V3ProviderProbePurpose,
    ) -> Self {
        Self {
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            expected_generation,
            purpose,
            acquisition_id,
        }
    }

    pub fn provider_id(&self) -> &str {
        &self.provider_id
    }

    pub fn auth_alias(&self) -> Option<&str> {
        self.auth_alias.as_deref()
    }

    pub fn interface_id(&self) -> &str {
        &self.interface_id
    }

    pub fn model_id(&self) -> Option<&str> {
        self.model_id.as_deref()
    }

    pub fn expected_generation(&self) -> u64 {
        self.expected_generation
    }

    pub fn purpose(&self) -> V3ProviderProbePurpose {
        self.purpose
    }
}

pub trait V3ProviderSchedulingReader {
    fn scheduling_projection_for_interface(
        &self,
        provider_id: &str,
        interface_id: &str,
        auth_alias: &str,
        model_id: &str,
        priority: i32,
        base_weight: u32,
        now_ms: u64,
    ) -> V3ProviderSchedulingProjection {
        let _ = interface_id;
        self.scheduling_projection(
            provider_id,
            auth_alias,
            model_id,
            priority,
            base_weight,
            now_ms,
        )
    }

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
        interface_id: &str,
        auth_alias: &str,
        model_id: &str,
        priority: i32,
        score_milli: u32,
        base_weight: u32,
    ) -> Self {
        Self {
            provider_id: provider_id.to_string(),
            interface_id: interface_id.to_string(),
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

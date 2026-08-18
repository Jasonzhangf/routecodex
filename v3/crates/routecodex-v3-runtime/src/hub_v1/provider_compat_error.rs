use super::common::V3ProviderCompatProfileId;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3ProviderCompatErrorClassification {
    PayloadBoundaryViolation,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("provider compat profile {profile} failed at {stage}: {reason}")]
pub struct V3ProviderCompatError {
    pub(crate) stage: &'static str,
    pub(crate) profile: String,
    pub(crate) reason: String,
    pub(crate) classification: V3ProviderCompatErrorClassification,
}

impl V3ProviderCompatError {
    pub(crate) fn new_payload_boundary(
        stage: &'static str,
        profile: String,
        reason: String,
    ) -> Self {
        Self {
            stage,
            profile,
            reason,
            classification: V3ProviderCompatErrorClassification::PayloadBoundaryViolation,
        }
    }

    pub(crate) fn other(stage: &'static str, profile: String, reason: String) -> Self {
        Self {
            stage,
            profile,
            reason,
            classification: V3ProviderCompatErrorClassification::Other,
        }
    }

    pub(crate) fn classification(&self) -> V3ProviderCompatErrorClassification {
        self.classification
    }
}

pub(crate) fn classify_v3_provider_compat_error(
    stage: &'static str,
    profile: &V3ProviderCompatProfileId,
    reason: String,
) -> V3ProviderCompatError {
    if reason.starts_with("ProviderCompatPayloadBoundaryViolation") {
        V3ProviderCompatError::new_payload_boundary(stage, profile.as_str().to_string(), reason)
    } else {
        V3ProviderCompatError::other(stage, profile.as_str().to_string(), reason)
    }
}

pub fn provider_compat_boundary_source(
    source_stage: &'static str,
    error: &V3ProviderCompatError,
) -> routecodex_v3_error::V3Error01SourceRaised {
    let field = extract_v3_provider_compat_boundary_field(&error.reason)
        .unwrap_or_else(|| "control_like_top_level_field".to_string());
    routecodex_v3_error::raise_v3_provider_compat_payload_boundary_violation(
        source_stage,
        field,
        error.reason.as_str(),
    )
}

pub fn extract_v3_provider_compat_boundary_field(reason: &str) -> Option<String> {
    let marker = "ProviderCompatPayloadBoundaryViolation field=";
    let start = reason.find(marker)? + marker.len();
    let rest = &reason[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '\0')
        .unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

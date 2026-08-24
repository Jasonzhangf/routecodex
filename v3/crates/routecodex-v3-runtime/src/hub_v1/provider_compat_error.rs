use super::common::V3ProviderCompatProfileId;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3ProviderCompatErrorClassification {
    PayloadBoundaryViolation,
    RequestPayloadInvalid,
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
    } else if matches!(stage, "request" | "request_protocol")
        && (reason.contains("MalformedOutboundField")
            || reason.contains("UnmappedOutboundFields")
            || reason.contains("codec malformed"))
    {
        V3ProviderCompatError {
            stage,
            profile: profile.as_str().to_string(),
            reason,
            classification: V3ProviderCompatErrorClassification::RequestPayloadInvalid,
        }
    } else {
        V3ProviderCompatError::other(stage, profile.as_str().to_string(), reason)
    }
}

pub(crate) fn provider_request_payload_source(
    source_stage: &'static str,
    error: &V3ProviderCompatError,
) -> routecodex_v3_error::V3Error01SourceRaised {
    routecodex_v3_error::build_v3_error_01_source_raised(
        routecodex_v3_error::V3ErrorSourceKind::InvalidRequest,
        source_stage,
        "provider_request_payload_invalid",
        error.to_string(),
    )
}

pub fn provider_compat_boundary_source(
    source_stage: &'static str,
    error: &V3ProviderCompatError,
) -> routecodex_v3_error::V3Error01SourceRaised {
    let field = extract_v3_provider_compat_boundary_field(&error.reason)
        .unwrap_or("control_like_top_level_field");
    routecodex_v3_error::raise_v3_provider_compat_payload_boundary_violation(
        source_stage,
        field,
        error.reason.as_str(),
    )
}

pub fn extract_v3_provider_compat_boundary_field(reason: &str) -> Option<&'static str> {
    let marker = "ProviderCompatPayloadBoundaryViolation field=";
    let start = reason.find(marker)? + marker.len();
    let rest = &reason[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '\0')
        .unwrap_or(rest.len());
    Some(match &rest[..end] {
        "metadata" => "metadata",
        "client_metadata" => "client_metadata",
        "context" => "context",
        "routing" => "routing",
        "continuation" => "continuation",
        "provider" => "provider",
        _ => "control_like_top_level_field",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_shape_compat_failures_are_client_invalid_request() {
        let profile = V3ProviderCompatProfileId::Passthrough;
        let error = classify_v3_provider_compat_error(
            "request",
            &profile,
            "Anthropic codec malformed tools[].format".to_string(),
        );
        assert_eq!(
            error.classification(),
            V3ProviderCompatErrorClassification::RequestPayloadInvalid
        );
    }

    #[test]
    fn response_compat_failures_remain_non_request_errors() {
        let profile = V3ProviderCompatProfileId::Passthrough;
        let error = classify_v3_provider_compat_error(
            "response",
            &profile,
            "Anthropic codec malformed tools[].format".to_string(),
        );
        assert_eq!(
            error.classification(),
            V3ProviderCompatErrorClassification::Other
        );
    }
}

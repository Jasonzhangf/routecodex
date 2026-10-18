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
) -> crate::shared::V3DirectSourceError {
    crate::shared::direct_internal_error(
        routecodex_v3_error::V3ErrorSourceKind::RuntimeFailure,
        source_stage,
        "provider_request_payload_invalid",
        error.to_string(),
        routecodex_v3_error::V3InternalErrorCode::V3Provider12ResponsesWirePayload,
    )
}

pub fn provider_compat_boundary_source(
    source_stage: &'static str,
    error: &V3ProviderCompatError,
) -> crate::shared::V3DirectSourceError {
    let field = extract_v3_provider_compat_boundary_field(&error.reason)
        .unwrap_or("control_like_top_level_field");
    let raw = routecodex_v3_error::raise_v3_provider_compat_payload_boundary_violation(
        source_stage,
        field,
        error.reason.as_str(),
    );
    crate::shared::direct_internal_error(
        raw.source_kind,
        source_stage,
        raw.code,
        raw.message,
        routecodex_v3_error::V3InternalErrorCode::V3Provider12ResponsesWirePayload,
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

    #[test]
    fn request_payload_source_preserves_wire_payload_identity() {
        let profile = V3ProviderCompatProfileId::Passthrough;
        let error = classify_v3_provider_compat_error(
            "request",
            &profile,
            "Anthropic codec malformed tools[].format".to_string(),
        );
        let source = provider_request_payload_source("ProviderReqCompat06ProviderCompat", &error)
            .expect("compat source must execute Error01 successfully");

        assert_eq!(
            source.source_kind,
            routecodex_v3_error::V3ErrorSourceKind::RuntimeFailure
        );
        assert_eq!(source.source_stage, "ProviderReqCompat06ProviderCompat");
        assert_eq!(source.code, "provider_request_payload_invalid");
        let internal = source
            .internal_error
            .expect("wire payload internal identity");
        assert_eq!(internal.internal_code, "500-150");
        assert_eq!(internal.node_id, "V3Provider12ResponsesWirePayload");
        assert!(source.external_error.is_none());
    }

    #[test]
    fn boundary_source_preserves_boundary_identity_and_sdk_input() {
        let error = V3ProviderCompatError::new_payload_boundary(
            "response",
            "passthrough".to_string(),
            "ProviderCompatPayloadBoundaryViolation field=metadata value=control".to_string(),
        );
        let source = provider_compat_boundary_source("ProviderRespCompat02ProviderCompat", &error)
            .expect("compat boundary source must execute Error01 successfully");

        assert_eq!(
            source.source_kind,
            routecodex_v3_error::V3ErrorSourceKind::RuntimeFailure
        );
        assert_eq!(source.source_stage, "ProviderRespCompat02ProviderCompat");
        assert_eq!(
            source.code,
            routecodex_v3_error::V3_PROVIDER_COMPAT_PAYLOAD_BOUNDARY_VIOLATION_CODE
        );
        let internal = source
            .internal_error
            .expect("wire payload internal identity");
        assert_eq!(internal.internal_code, "500-150");
        assert_eq!(internal.node_id, "V3Provider12ResponsesWirePayload");
        assert!(source.external_error.is_none());
    }
}

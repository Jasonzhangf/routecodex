use serde::{Deserialize, Serialize};

use crate::{is_v3_retryable_transient_source, V3Error02Classified, V3ErrorSourceKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum V3ProviderRecoveryKind {
    IrrecoverableGlobalCooldown,
    RecoverableCounted,
    HealthNeutralTransient,
    NotProviderHealth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum V3ProviderHealthScope {
    None,
    SessionProviderKey,
    GlobalProviderKey,
}

impl Default for V3ProviderHealthScope {
    fn default() -> Self {
        Self::None
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct V3ProviderFailureAction {
    pub class_code: String,
    pub recovery: V3ProviderRecoveryKind,
    pub scope: V3ProviderHealthScope,
    pub score_delta_milli: i32,
    pub failure_threshold: u32,
    pub cooldown_ms: u64,
}

impl V3ProviderFailureAction {
    pub fn recoverable(class_code: &str) -> Self {
        Self {
            class_code: class_code.to_string(),
            recovery: V3ProviderRecoveryKind::RecoverableCounted,
            scope: V3ProviderHealthScope::GlobalProviderKey,
            score_delta_milli: -50,
            failure_threshold: 3,
            cooldown_ms: 15 * 60_000,
        }
    }

    pub fn recoverable_session(class_code: &str) -> Self {
        let mut action = Self::recoverable(class_code);
        action.scope = V3ProviderHealthScope::SessionProviderKey;
        action
    }
}

pub fn build_v3_provider_failure_action_from_v3_error_02(
    classified: &V3Error02Classified,
) -> V3ProviderFailureAction {
    if classified.source.source_kind != V3ErrorSourceKind::ProviderFailure {
        return V3ProviderFailureAction {
            class_code: classified.class.to_string(),
            recovery: V3ProviderRecoveryKind::NotProviderHealth,
            scope: V3ProviderHealthScope::None,
            score_delta_milli: 0,
            failure_threshold: 0,
            cooldown_ms: 0,
        };
    }
    let status = classified
        .source
        .external_error
        .as_ref()
        .and_then(|error| error.status);
    let response_stream_failure = classified.source.code == "provider_response_sse_stream";
    let http_status_is_health_counted = matches!(status, Some(429 | 500 | 502));
    if !response_stream_failure
        && !http_status_is_health_counted
        && is_v3_retryable_transient_source(&classified.source)
    {
        return V3ProviderFailureAction {
            class_code: classified.source.code.clone(),
            recovery: V3ProviderRecoveryKind::HealthNeutralTransient,
            scope: V3ProviderHealthScope::None,
            score_delta_milli: 0,
            failure_threshold: 0,
            cooldown_ms: 0,
        };
    }
    if matches!(status, Some(401 | 402 | 403 | 503))
        || is_irrecoverable_provider_failure_code(&classified.source.code)
    {
        return V3ProviderFailureAction {
            class_code: classified.source.code.clone(),
            recovery: V3ProviderRecoveryKind::IrrecoverableGlobalCooldown,
            scope: V3ProviderHealthScope::GlobalProviderKey,
            score_delta_milli: -200,
            failure_threshold: 1,
            cooldown_ms: classified
                .provider_global_cooldown_ms
                .unwrap_or(60 * 60_000),
        };
    }
    if response_stream_failure || http_status_is_health_counted {
        V3ProviderFailureAction::recoverable(&classified.source.code)
    } else {
        V3ProviderFailureAction::recoverable_session(&classified.source.code)
    }
}

fn is_irrecoverable_provider_failure_code(code: &str) -> bool {
    let normalized = code.trim().to_ascii_lowercase();
    [
        "account_disabled",
        "account_suspended",
        "billing_disabled",
        "insufficient_quota",
        "invalid_api_key",
        "quota_exceeded",
        "unauthorized",
    ]
    .iter()
    .any(|marker| normalized == *marker || normalized.contains(marker))
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct V3ProviderErrorFingerprint {
    pub reason_code: String,
    pub provider_code: String,
    pub http_status: u16,
    pub semantic_signature: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct V3ProviderGlobalFailurePolicy {
    pub failure_threshold: u32,
    pub cooldown_ms: u64,
    pub probe_interval_ms: u64,
}

impl V3ProviderErrorFingerprint {
    pub fn new(
        reason_code: impl Into<String>,
        provider_code: impl Into<String>,
        http_status: u16,
        semantic_signature: impl Into<String>,
    ) -> Result<Self, String> {
        let fingerprint = Self {
            reason_code: reason_code.into(),
            provider_code: provider_code.into(),
            http_status,
            semantic_signature: semantic_signature.into(),
        };
        if fingerprint.reason_code.trim().is_empty()
            || fingerprint.provider_code.trim().is_empty()
            || fingerprint.semantic_signature.trim().is_empty()
        {
            return Err("provider error fingerprint fields must be non-empty".to_string());
        }
        Ok(fingerprint)
    }
}

pub fn build_v3_provider_global_error_fingerprint(
    status: u16,
) -> Result<Option<V3ProviderErrorFingerprint>, String> {
    let (class, normalized_status) = match status {
        401 | 403 => ("account_auth", 401),
        429 => ("recoverable_upstream", 429),
        500..=599 => ("recoverable_upstream", 500),
        _ => return Ok(None),
    };
    V3ProviderErrorFingerprint::new(class, class, normalized_status, class).map(Some)
}

pub fn build_v3_provider_global_failure_policy(
    status: u16,
) -> Option<V3ProviderGlobalFailurePolicy> {
    match status {
        401 | 403 => Some(V3ProviderGlobalFailurePolicy {
            failure_threshold: 2,
            cooldown_ms: 60 * 60_000,
            probe_interval_ms: 60 * 60_000,
        }),
        429 | 500..=599 => Some(V3ProviderGlobalFailurePolicy {
            failure_threshold: 3,
            cooldown_ms: 15 * 60_000,
            probe_interval_ms: 15 * 60_000,
        }),
        _ => None,
    }
}

pub fn build_v3_provider_global_error_fingerprint_from_classified(
    classified: &V3Error02Classified,
) -> Result<Option<V3ProviderErrorFingerprint>, String> {
    let Some(status) = classified
        .source
        .external_error
        .as_ref()
        .and_then(|error| error.status)
    else {
        return Ok(None);
    };
    if let Some(signature) = classified.provider_global_semantic_signature.as_deref() {
        return V3ProviderErrorFingerprint::new(
            "provider_semantic",
            classified.source.code.clone(),
            status,
            signature,
        )
        .map(Some);
    }
    build_v3_provider_global_error_fingerprint(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        build_v3_error_01_source_raised_external, V3ErrorSourceKind, V3ExternalErrorKind,
        V3ExternalErrorLink,
    };

    fn classified(stage: &'static str, code: &str, status: u16) -> V3Error02Classified {
        crate::build_v3_error_02_classified_from_v3_error_01(
            build_v3_error_01_source_raised_external(
                V3ErrorSourceKind::ProviderFailure,
                stage,
                code,
                "provider failure",
                V3ExternalErrorLink {
                    kind: V3ExternalErrorKind::Provider,
                    status: Some(status),
                    code: Some(code.to_string()),
                    provider_id: Some("provider-a".to_string()),
                    upstream_request_id: None,
                    message: Some("provider failure".to_string()),
                },
            ),
        )
    }

    #[test]
    fn classified_provider_error_has_one_typed_health_action() {
        let action = build_v3_provider_failure_action_from_v3_error_02(&classified(
            "V3ProviderReqOutbound09TransportRequest",
            "provider_connect_failed",
            503,
        ));
        assert_eq!(
            action.recovery,
            V3ProviderRecoveryKind::IrrecoverableGlobalCooldown
        );
        assert_eq!(action.scope, V3ProviderHealthScope::GlobalProviderKey);
        assert_eq!(action.failure_threshold, 1);

        let action = build_v3_provider_failure_action_from_v3_error_02(&classified(
            "V3ProviderReqOutbound09TransportRequest",
            "invalid_api_key",
            401,
        ));
        assert_eq!(
            action.recovery,
            V3ProviderRecoveryKind::IrrecoverableGlobalCooldown
        );
        assert_eq!(action.scope, V3ProviderHealthScope::GlobalProviderKey);
        assert_eq!(action.failure_threshold, 1);

        for (code, status) in [("insufficient_quota", 429), ("account_disabled", 403)] {
            let action = build_v3_provider_failure_action_from_v3_error_02(&classified(
                "V3ProviderReqOutbound09TransportRequest",
                code,
                status,
            ));
            assert_eq!(
                action.recovery,
                V3ProviderRecoveryKind::IrrecoverableGlobalCooldown
            );
            assert_eq!(action.failure_threshold, 1);
        }

        let action = build_v3_provider_failure_action_from_v3_error_02(&classified(
            "V3ProviderRespInbound01Raw",
            "provider_response_sse_stream",
            200,
        ));
        assert_eq!(action.recovery, V3ProviderRecoveryKind::RecoverableCounted);
        assert_eq!(action.scope, V3ProviderHealthScope::GlobalProviderKey);
        assert_eq!(action.failure_threshold, 3);
        assert_eq!(action.score_delta_milli, -50);

        let action = build_v3_provider_failure_action_from_v3_error_02(&classified(
            "V3ProviderRespInbound01Raw",
            "provider_response_sse_stream",
            502,
        ));
        assert_eq!(action.recovery, V3ProviderRecoveryKind::RecoverableCounted);
        assert_eq!(action.scope, V3ProviderHealthScope::GlobalProviderKey);
        assert_eq!(action.failure_threshold, 3);
        assert_eq!(action.score_delta_milli, -50);

        let action = build_v3_provider_failure_action_from_v3_error_02(&classified(
            "V3ProviderReqOutbound09TransportRequest",
            "rate_limit_error",
            429,
        ));
        assert_eq!(action.recovery, V3ProviderRecoveryKind::RecoverableCounted);
        assert_eq!(action.scope, V3ProviderHealthScope::GlobalProviderKey);
        assert_eq!(action.failure_threshold, 3);
        assert_eq!(action.score_delta_milli, -50);
    }
}

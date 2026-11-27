use crate::{
    build_v3_error_02_classified_from_v3_error_01,
    build_v3_provider_failure_action_from_v3_error_02, V3Error01SourceRaised, V3ErrorSourceKind,
    V3ExternalErrorKind, V3InternalErrorLane, V3ProviderRecoveryKind,
};
use serde::Serialize;

/// In an opt-in active episode, a dispatched response codec failure is a local
/// processing cause. The actual HTTP response stays in Runtime's separate
/// attempt witness; an internal Error source cannot carry an external link.
pub fn normalize_v3_active_key_failure_source(
    source: V3Error01SourceRaised,
    dispatched: bool,
) -> V3Error01SourceRaised {
    if dispatched
        && source.source_kind == V3ErrorSourceKind::ProviderFailure
        && matches!(
            source.code.as_str(),
            "provider_response_json_invalid"
                | "provider_response_body_error"
                | "provider_response_event_codec_failure"
                | "provider_malformed_sse"
                | "provider_response_sse_event_invalid"
                | "provider_response_empty"
        )
        && source.external_error.as_ref().is_none_or(|external| {
            external.kind != V3ExternalErrorKind::Transport
                && external
                    .provider_http_status()
                    .is_none_or(|status| status < 400)
        })
    {
        crate::build_v3_error_01_source_raised_internal(
            V3ErrorSourceKind::RuntimeFailure,
            source.source_stage,
            &source.code,
            &source.message,
            crate::V3InternalErrorCode::V3ProviderResp14Raw,
        )
    } else {
        source
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3ActiveKeyFailureClass {
    Neutral,
    RetryableDelivery,
    NonretryableDelivery,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum V3ActiveKeyRecoveryAction {
    Neutral,
    RetrySelectedActiveKey,
    Reselect,
}

/// Selection reliability is separate from Provider health. The caller supplies
/// actual dispatch evidence and invokes this only before business commit.
pub fn classify_v3_active_key_failure(
    source: &V3Error01SourceRaised,
    dispatched: bool,
) -> V3ActiveKeyFailureClass {
    use V3ActiveKeyFailureClass::*;
    if !dispatched
        || !matches!(
            source.source_kind,
            V3ErrorSourceKind::ProviderFailure
                | V3ErrorSourceKind::RuntimeFailure
                | V3ErrorSourceKind::ProviderCompatPayloadBoundaryViolation
        )
    {
        return Neutral;
    }
    if source
        .external_error
        .as_ref()
        .is_some_and(|link| link.kind == V3ExternalErrorKind::Transport)
    {
        return RetryableDelivery;
    }
    if source.source_kind != V3ErrorSourceKind::ProviderFailure
        || source
            .internal_error
            .as_ref()
            .is_some_and(|error| error.lane == V3InternalErrorLane::Response)
    {
        return NonretryableDelivery;
    }
    let classified = build_v3_error_02_classified_from_v3_error_01(source.clone());
    let action = build_v3_provider_failure_action_from_v3_error_02(&classified);
    let status = source
        .external_error
        .as_ref()
        .and_then(|link| link.provider_http_status());
    if action.recovery == V3ProviderRecoveryKind::IrrecoverableGlobalCooldown
        || status.is_some_and(|status| (400..500).contains(&status) && status != 429)
    {
        NonretryableDelivery
    } else {
        RetryableDelivery
    }
}

/// The eligibility input combines request budget, current selection generation,
/// health, cancellation and route restrictions. This creates no recovery wait.
pub fn plan_v3_active_key_recovery(
    class: V3ActiveKeyFailureClass,
    retry_allowed: bool,
) -> V3ActiveKeyRecoveryAction {
    match class {
        V3ActiveKeyFailureClass::Neutral => V3ActiveKeyRecoveryAction::Neutral,
        V3ActiveKeyFailureClass::RetryableDelivery if retry_allowed => {
            V3ActiveKeyRecoveryAction::RetrySelectedActiveKey
        }
        _ => V3ActiveKeyRecoveryAction::Reselect,
    }
}

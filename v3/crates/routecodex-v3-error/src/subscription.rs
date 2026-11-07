use serde::{Deserialize, Serialize};

use crate::{V3Error02Classified, V3ErrorSourceKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum V3ProviderRecoveryKind {
    IrrecoverableGlobalCooldown,
    RecoverableCounted,
    NotProviderHealth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum V3ProviderHealthScope {
    #[default]
    None,
    SessionProviderKey,
    GlobalProviderKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct V3ProviderFailureAction {
    pub class_code: String,
    /// Typed identity of this failure. Provider health counts a consecutive
    /// failure streak only for repeated failures of the same fingerprint, so
    /// three *different* recoverable errors never add up to a cooldown.
    /// A typed fingerprint carries the upstream status/semantics; failures
    /// without an upstream status fall back to their failure class code, so a
    /// missing identity never merges two different classes into one streak.
    pub failure_fingerprint: Option<V3ProviderErrorFingerprint>,
    pub recovery: V3ProviderRecoveryKind,
    pub scope: V3ProviderHealthScope,
    pub score_delta_milli: i32,
    pub failure_threshold: u32,
    pub cooldown_ms: u64,
    /// Retained as a typed compatibility field; all provider classes now use
    /// the shared aggressive cooldown/probe ladder.
    pub long_probe_backoff: bool,
    /// Advisory recovery probe. A scheduled or in-flight probe is not an
    /// availability decision and a probe failure never advances the ladder.
    pub advisory_probe: bool,
}

impl V3ProviderFailureAction {
    pub fn recoverable(class_code: &str) -> Self {
        Self {
            class_code: class_code.to_string(),
            failure_fingerprint: class_code_fingerprint(class_code),
            recovery: V3ProviderRecoveryKind::RecoverableCounted,
            scope: V3ProviderHealthScope::GlobalProviderKey,
            score_delta_milli: -5,
            failure_threshold: crate::V3_PROVIDER_RECOVERABLE_FAILURE_THRESHOLD,
            cooldown_ms: 5_000,
            long_probe_backoff: false,
            advisory_probe: false,
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
            failure_fingerprint: None,
            recovery: V3ProviderRecoveryKind::NotProviderHealth,
            scope: V3ProviderHealthScope::None,
            score_delta_milli: 0,
            failure_threshold: 0,
            cooldown_ms: 0,
            long_probe_backoff: false,
            advisory_probe: false,
        };
    }
    let status = classified
        .source
        .external_error
        .as_ref()
        .and_then(|error| error.status);
    let failure_fingerprint = build_v3_provider_failure_identity_from_classified(classified);
    // Real recoverable failures count toward the shared repeat threshold.
    // Authentication/account failures retain their immediate typed boundary.
    if matches!(status, Some(401..=403))
        || is_irrecoverable_provider_failure_code(&classified.source.code)
    {
        let cooldown_ms = 5_000;
        return V3ProviderFailureAction {
            class_code: classified.source.code.clone(),
            failure_fingerprint,
            recovery: V3ProviderRecoveryKind::IrrecoverableGlobalCooldown,
            scope: V3ProviderHealthScope::GlobalProviderKey,
            score_delta_milli: -20,
            failure_threshold: 0,
            cooldown_ms,
            long_probe_backoff: matches!(status, Some(401..=403)),
            advisory_probe: false,
        };
    }
    let mut action = V3ProviderFailureAction::recoverable(&classified.source.code);
    action.failure_fingerprint = failure_fingerprint;
    if let Some(status) = status {
        if let Some(policy) = build_v3_provider_global_failure_policy(status) {
            action.failure_threshold = policy.failure_threshold;
            action.cooldown_ms = policy.cooldown_ms;
            action.long_probe_backoff = matches!(status, 503);
        }
    }
    action
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

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
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
        402 => ("account_billing", 402),
        // 保留真实上游状态作为身份的一部分：500 与 502 是两种可恢复错误，
        // 交替出现不会累计成同一条连续失败序列而误冷却 provider。
        429 | 500..=599 => ("recoverable_upstream", status),
        _ => return Ok(None),
    };
    V3ProviderErrorFingerprint::new(class, class, normalized_status, class).map(Some)
}

/// Provider health policy per upstream status.
///
/// Account/billing classes (`401..=403`) are the typed irrecoverable group and
/// still cool on their first occurrence. Every other recoverable status,
/// including HTTP 429, uses the same shared threshold for the exact identity;
/// only the raw upstream evidence differs.
pub fn build_v3_provider_global_failure_policy(
    status: u16,
) -> Option<V3ProviderGlobalFailurePolicy> {
    match status {
        401..=403 => Some(V3ProviderGlobalFailurePolicy {
            failure_threshold: 1,
            cooldown_ms: 5_000,
            probe_interval_ms: 5_000,
        }),
        429 | 500..=599 => Some(V3ProviderGlobalFailurePolicy {
            failure_threshold: crate::V3_PROVIDER_RECOVERABLE_FAILURE_THRESHOLD,
            cooldown_ms: 5_000,
            probe_interval_ms: 5_000,
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

/// A provider failure without an upstream status (a local decode failure, a
/// mid-stream break, a request-local compatibility error) carries no typed
/// fingerprint. Its failure class code is still a stable identity, so it is
/// promoted into the fingerprint instead of degrading to `None`: an empty
/// identity would make two unrelated classes count as one streak.
fn class_code_fingerprint(class_code: &str) -> Option<V3ProviderErrorFingerprint> {
    let class = class_code.trim();
    if class.is_empty() {
        return None;
    }
    V3ProviderErrorFingerprint::new("provider_class", class.to_string(), 0, class.to_string()).ok()
}

/// Typed identity of a provider failure for the health streak. The upstream
/// status/semantics win when present; otherwise the failure class code
/// identifies it.
fn build_v3_provider_failure_identity_from_classified(
    classified: &V3Error02Classified,
) -> Option<V3ProviderErrorFingerprint> {
    build_v3_provider_global_error_fingerprint_from_classified(classified)
        .ok()
        .flatten()
        .or_else(|| class_code_fingerprint(&classified.source.code))
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
        assert_eq!(action.recovery, V3ProviderRecoveryKind::RecoverableCounted);
        assert_eq!(action.scope, V3ProviderHealthScope::GlobalProviderKey);
        // 503 is a recoverable class: the shared consecutive-failure threshold
        // decides when the exact identity enters the cooldown pool, while the
        // probe ladder still backs off.
        assert_eq!(
            action.failure_threshold,
            crate::V3_PROVIDER_RECOVERABLE_FAILURE_THRESHOLD
        );
        assert_eq!(action.cooldown_ms, 5_000);
        assert!(action.long_probe_backoff);

        let ordinary = build_v3_provider_failure_action_from_v3_error_02(&classified(
            "V3ProviderReqOutbound09TransportRequest",
            "provider_connect_failed",
            500,
        ));
        assert_eq!(
            ordinary.failure_threshold,
            crate::V3_PROVIDER_RECOVERABLE_FAILURE_THRESHOLD
        );
        assert_eq!(ordinary.cooldown_ms, 5_000);
        assert!(!ordinary.long_probe_backoff);

        let payment_required = build_v3_provider_failure_action_from_v3_error_02(&classified(
            "V3ProviderReqOutbound09TransportRequest",
            "payment_required",
            402,
        ));
        assert_eq!(
            payment_required.recovery,
            V3ProviderRecoveryKind::IrrecoverableGlobalCooldown
        );
        assert_eq!(payment_required.failure_threshold, 0);
        assert_eq!(payment_required.cooldown_ms, 5_000);
        assert!(payment_required.long_probe_backoff);
        let fingerprint = build_v3_provider_global_error_fingerprint(402)
            .expect("402 fingerprint classification must not fail")
            .expect("402 must reach global health");
        assert_eq!(fingerprint.http_status, 402);

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
        assert_eq!(action.failure_threshold, 0);

        // A 429 whose body carries an account/quota code stays irrecoverable:
        // status 429 no longer exempts it from the ordinary typed boundary.
        let quota_429 = build_v3_provider_failure_action_from_v3_error_02(&classified(
            "V3ProviderReqOutbound09TransportRequest",
            "insufficient_quota",
            429,
        ));
        assert_eq!(
            quota_429.recovery,
            V3ProviderRecoveryKind::IrrecoverableGlobalCooldown
        );
        let rate_limited = build_v3_provider_failure_action_from_v3_error_02(&classified(
            "V3ProviderReqOutbound09TransportRequest",
            "rate_limit_error",
            429,
        ));
        assert_eq!(
            rate_limited.recovery,
            V3ProviderRecoveryKind::RecoverableCounted,
            "HTTP 429 takes the ordinary recoverable control path"
        );
        assert_eq!(rate_limited.scope, V3ProviderHealthScope::GlobalProviderKey);
        assert_eq!(
            rate_limited.failure_threshold,
            crate::V3_PROVIDER_RECOVERABLE_FAILURE_THRESHOLD
        );
        assert_eq!(rate_limited.cooldown_ms, 5_000);
        assert_eq!(rate_limited.score_delta_milli, -5);
        assert!(build_v3_provider_global_failure_policy(429).is_some());

        for (code, status) in [("account_disabled", 403)] {
            let action = build_v3_provider_failure_action_from_v3_error_02(&classified(
                "V3ProviderReqOutbound09TransportRequest",
                code,
                status,
            ));
            assert_eq!(
                action.recovery,
                V3ProviderRecoveryKind::IrrecoverableGlobalCooldown
            );
            assert_eq!(action.failure_threshold, 0);
        }

        let action = build_v3_provider_failure_action_from_v3_error_02(&classified(
            "V3ProviderRespInbound01Raw",
            "provider_response_sse_stream",
            200,
        ));
        assert_eq!(action.recovery, V3ProviderRecoveryKind::RecoverableCounted);
        assert_eq!(action.scope, V3ProviderHealthScope::GlobalProviderKey);
        assert_eq!(
            action.failure_threshold,
            crate::V3_PROVIDER_RECOVERABLE_FAILURE_THRESHOLD
        );
        assert_eq!(action.score_delta_milli, -5);

        let action = build_v3_provider_failure_action_from_v3_error_02(&classified(
            "V3ProviderRespInbound01Raw",
            "provider_response_sse_stream",
            502,
        ));
        assert_eq!(action.recovery, V3ProviderRecoveryKind::RecoverableCounted);
        assert_eq!(action.scope, V3ProviderHealthScope::GlobalProviderKey);
        assert_eq!(
            action.failure_threshold,
            crate::V3_PROVIDER_RECOVERABLE_FAILURE_THRESHOLD
        );
        assert_eq!(action.score_delta_milli, -5);

        let action = build_v3_provider_failure_action_from_v3_error_02(&classified(
            "V3ProviderReqOutbound09TransportRequest",
            "rate_limit_error",
            429,
        ));
        assert_eq!(action.recovery, V3ProviderRecoveryKind::RecoverableCounted);
        assert_eq!(action.scope, V3ProviderHealthScope::GlobalProviderKey);
        assert_eq!(
            action.failure_threshold,
            crate::V3_PROVIDER_RECOVERABLE_FAILURE_THRESHOLD
        );
        assert_eq!(action.score_delta_milli, -5);

        let action = build_v3_provider_failure_action_from_v3_error_02(&classified(
            "V3ProviderReqOutbound09TransportRequest",
            "provider_connect_failed",
            502,
        ));
        assert_eq!(action.recovery, V3ProviderRecoveryKind::RecoverableCounted);
        assert_eq!(
            action.failure_threshold,
            crate::V3_PROVIDER_RECOVERABLE_FAILURE_THRESHOLD
        );
    }

    #[test]
    fn every_provider_failure_class_counts_global_health() {
        // 400（客户端请求错误）也计入全局健康：同一 key 连续失败必须冷却，
        // 由后台探活恢复，而不是永远保持可选（P0 风暴根因之一）。
        let action = build_v3_provider_failure_action_from_v3_error_02(&classified(
            "V3ProviderReqOutbound09TransportRequest",
            "provider_http_400",
            400,
        ));
        assert_eq!(action.recovery, V3ProviderRecoveryKind::RecoverableCounted);
        assert_eq!(action.scope, V3ProviderHealthScope::GlobalProviderKey);

        // 瞬态重试来源不再豁免健康计数：连续瞬态失败同样进入冷却+探活。
        let action = build_v3_provider_failure_action_from_v3_error_02(&classified(
            "V3ProviderResp14Raw",
            "provider.sse_decode",
            200,
        ));
        assert_eq!(action.recovery, V3ProviderRecoveryKind::RecoverableCounted);
        assert_eq!(action.scope, V3ProviderHealthScope::GlobalProviderKey);
    }

    /// Latest decision: HTTP 429 is an ordinary recoverable upstream failure.
    /// Only the raw status/body evidence differs from another recoverable
    /// class; no health-neutral or rate-limit-specific recovery policy exists.
    #[test]
    fn http_429_shares_the_ordinary_recoverable_policy_unlike_special_rate_limit() {
        let rate_limited = build_v3_provider_failure_action_from_v3_error_02(&classified(
            "V3ProviderReqOutbound09TransportRequest",
            "rate_limit_error",
            429,
        ));
        let ordinary = build_v3_provider_failure_action_from_v3_error_02(&classified(
            "V3ProviderReqOutbound09TransportRequest",
            "provider_connect_failed",
            500,
        ));
        assert_eq!(
            rate_limited.recovery, ordinary.recovery,
            "429 must use the ordinary recoverable control path"
        );
        assert_eq!(rate_limited.scope, ordinary.scope);
        assert_eq!(rate_limited.failure_threshold, ordinary.failure_threshold);
        assert_eq!(rate_limited.cooldown_ms, ordinary.cooldown_ms);
        assert_eq!(
            rate_limited.long_probe_backoff,
            ordinary.long_probe_backoff
        );
        assert_eq!(
            rate_limited.failure_fingerprint.as_ref().map(|fp| fp.http_status),
            Some(429),
            "the raw upstream 429 stays in the typed failure identity"
        );
    }

    /// v29 arbitration: the shared recoverable threshold is three consecutive
    /// failures for the exact complete identity; every recoverable status
    /// (429 | 500..=599) enters the cooldown pool through the same count.
    /// Cooldown ladder durations are owned by the provider health store.
    #[test]
    fn v29_recoverable_threshold_is_three_consecutive_failures() {
        assert_eq!(crate::V3_PROVIDER_RECOVERABLE_FAILURE_THRESHOLD, 3);
        for status in [429u16, 500, 502, 503, 599] {
            let policy = build_v3_provider_global_failure_policy(status)
                .unwrap_or_else(|| panic!("status {status} must have a recoverable policy"));
            assert_eq!(
                policy.failure_threshold,
                crate::V3_PROVIDER_RECOVERABLE_FAILURE_THRESHOLD,
                "status {status} uses the shared recoverable threshold"
            );
        }
    }

    #[test]
    fn recoverable_failure_identity_keeps_distinct_status_and_class() {
        // 5xx 保留真实上游状态：500 与 502 是两种可恢复错误，不能共用一条
        // 连续失败序列。
        let server_error = build_v3_provider_global_error_fingerprint(500)
            .expect("500 fingerprint classification must not fail")
            .expect("500 must reach global health");
        let gateway_error = build_v3_provider_global_error_fingerprint(502)
            .expect("502 fingerprint classification must not fail")
            .expect("502 must reach global health");
        assert_ne!(server_error, gateway_error);
        assert_eq!(server_error.http_status, 500);
        assert_eq!(gateway_error.http_status, 502);

        // 没有上游状态的 provider 失败落到失败类别：不同类别仍是不同身份，
        // 空身份不能把两类失败合并成一条 streak。
        let action_a = build_v3_provider_failure_action_from_v3_error_02(
            &crate::build_v3_error_02_classified_from_v3_error_01(
                crate::build_v3_error_01_source_raised(
                    V3ErrorSourceKind::ProviderFailure,
                    "V3ProviderResp14Raw",
                    "provider.sse_decode",
                    "provider local decode failure",
                ),
            ),
        );
        let action_b = build_v3_provider_failure_action_from_v3_error_02(
            &crate::build_v3_error_02_classified_from_v3_error_01(
                crate::build_v3_error_01_source_raised(
                    V3ErrorSourceKind::ProviderFailure,
                    "ProviderReqCompat06ProviderCompat",
                    "provider_request_compat_error",
                    "provider request compat failure",
                ),
            ),
        );
        let (fingerprint_a, fingerprint_b) = (
            action_a
                .failure_fingerprint
                .expect("no-status class identity"),
            action_b
                .failure_fingerprint
                .expect("no-status class identity"),
        );
        assert_eq!(fingerprint_a.http_status, 0);
        assert_ne!(fingerprint_a, fingerprint_b);
    }

    #[test]
    fn registered_irrecoverable_code_keeps_first_failure_threshold_over_http_status() {
        // 分类优先于状态码：已注册的不可恢复账户/计费类即使上游返回 503
        // 也必须首次即冷却，不能被可恢复阈值覆盖成三次。
        for (code, status) in [
            ("insufficient_quota", 503),
            ("invalid_api_key", 503),
            ("quota_exceeded", 503),
            ("account_disabled", 503),
        ] {
            let action = build_v3_provider_failure_action_from_v3_error_02(&classified(
                "V3ProviderReqOutbound09TransportRequest",
                code,
                status,
            ));
            assert_eq!(
                action.recovery,
                V3ProviderRecoveryKind::IrrecoverableGlobalCooldown,
                "code={code} status={status}"
            );
            assert_eq!(action.failure_threshold, 0, "code={code} status={status}");
        }
    }
}

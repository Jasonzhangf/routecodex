use serde::{Deserialize, Serialize};

use crate::{V3Error02Classified, V3ErrorSourceKind};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum V3ProviderRecoveryKind {
    IrrecoverableGlobalCooldown,
    RecoverableCounted,
    HealthNeutralTransient,
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
}

impl V3ProviderFailureAction {
    pub fn recoverable(class_code: &str) -> Self {
        Self {
            class_code: class_code.to_string(),
            failure_fingerprint: class_code_fingerprint(class_code),
            recovery: V3ProviderRecoveryKind::RecoverableCounted,
            scope: V3ProviderHealthScope::GlobalProviderKey,
            score_delta_milli: -5,
            failure_threshold: 3,
            cooldown_ms: 5_000,
            long_probe_backoff: false,
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
        };
    }
    let status = classified
        .source
        .external_error
        .as_ref()
        .and_then(|error| error.status);
    let failure_fingerprint = build_v3_provider_failure_identity_from_classified(classified);
    // 统一错误模型：不再按状态码豁免——瞬态重试来源与 400/4xx 同样计入
    // 全局健康。可恢复类必须连续三次同类失败才进入共享冷却，避免单个 provider
    // 因一次可恢复错误被排除而耗尽路由池；账户/计费类仍按 typed irrecoverable
    // 立即冷却，由后台探活或真实成功恢复。
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
        429 => ("recoverable_upstream", 429),
        // 保留真实上游状态作为身份的一部分：500 与 502 是两种可恢复错误，
        // 交替出现不会累计成同一条连续失败序列而误冷却 provider。
        500..=599 => ("recoverable_upstream", status),
        _ => return Ok(None),
    };
    V3ProviderErrorFingerprint::new(class, class, normalized_status, class).map(Some)
}

/// Provider health policy per upstream status.
///
/// Account/billing classes (`401..=403`) are the typed irrecoverable group and
/// still cool on their first occurrence. Every recoverable class requires three
/// consecutive same-fingerprint failures before cooldown: one recoverable error
/// must not exclude a provider, and with a single provider that exclusion is
/// what exhausts the route pool.
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
            failure_threshold: 3,
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
        // 503 is a recoverable class: three consecutive same-fingerprint failures
        // are required before cooldown, while the probe ladder still backs off.
        assert_eq!(action.failure_threshold, 3);
        assert_eq!(action.cooldown_ms, 5_000);
        assert!(action.long_probe_backoff);

        let ordinary = build_v3_provider_failure_action_from_v3_error_02(&classified(
            "V3ProviderReqOutbound09TransportRequest",
            "provider_connect_failed",
            500,
        ));
        assert_eq!(ordinary.failure_threshold, 3);
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
            assert_eq!(action.failure_threshold, 0);
        }

        let action = build_v3_provider_failure_action_from_v3_error_02(&classified(
            "V3ProviderRespInbound01Raw",
            "provider_response_sse_stream",
            200,
        ));
        assert_eq!(action.recovery, V3ProviderRecoveryKind::RecoverableCounted);
        assert_eq!(action.scope, V3ProviderHealthScope::GlobalProviderKey);
        assert_eq!(action.failure_threshold, 3);
        assert_eq!(action.score_delta_milli, -5);

        let action = build_v3_provider_failure_action_from_v3_error_02(&classified(
            "V3ProviderRespInbound01Raw",
            "provider_response_sse_stream",
            502,
        ));
        assert_eq!(action.recovery, V3ProviderRecoveryKind::RecoverableCounted);
        assert_eq!(action.scope, V3ProviderHealthScope::GlobalProviderKey);
        assert_eq!(action.failure_threshold, 3);
        assert_eq!(action.score_delta_milli, -5);

        let action = build_v3_provider_failure_action_from_v3_error_02(&classified(
            "V3ProviderReqOutbound09TransportRequest",
            "rate_limit_error",
            429,
        ));
        assert_eq!(action.recovery, V3ProviderRecoveryKind::RecoverableCounted);
        assert_eq!(action.scope, V3ProviderHealthScope::GlobalProviderKey);
        assert_eq!(action.failure_threshold, 3);
        assert_eq!(action.score_delta_milli, -5);

        let action = build_v3_provider_failure_action_from_v3_error_02(&classified(
            "V3ProviderReqOutbound09TransportRequest",
            "provider_connect_failed",
            502,
        ));
        assert_eq!(action.recovery, V3ProviderRecoveryKind::RecoverableCounted);
        assert_eq!(action.failure_threshold, 3);
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
                .expect("class fallback identity"),
            action_b
                .failure_fingerprint
                .expect("class fallback identity"),
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

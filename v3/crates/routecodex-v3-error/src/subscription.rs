use serde::Serialize;

use crate::V3Error02Classified;

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

/// Classifies provider HTTP failures that may affect provider-global health.
/// The runtime consumes this typed fingerprint; it must not reconstruct the
/// health class from a raw status at the health-store boundary.
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

use routecodex_v3_error::{V3Error05RecoveryAdmissionWitness, V3ProviderFailureSessionScope};
use routecodex_v3_provider_responses::V3ProviderFailureRecord;

pub(crate) const V3_TRANSIENT_RETRY_BUDGET: usize = 2;

pub(crate) fn build_v3_transient_failure_record(
    provider_key: &str,
    failure_count: u32,
    reason: Option<&str>,
) -> V3ProviderFailureRecord {
    V3ProviderFailureRecord {
        scope_label: provider_key.to_string(),
        provider_key: provider_key.to_string(),
        state: "transient_exhausted".to_string(),
        failure_count,
        cooldown_until_ms: None,
        reason: reason.map(str::to_string),
    }
}

pub(crate) fn build_v3_transient_recovery_witness(
    failure_session_scope: &V3ProviderFailureSessionScope,
    provider_key: &str,
    normalized_error_family: &str,
) -> Result<V3Error05RecoveryAdmissionWitness, String> {
    V3Error05RecoveryAdmissionWitness::new(
        failure_session_scope.clone(),
        provider_key.to_string(),
        normalized_error_family.to_string(),
        1,
    )
}

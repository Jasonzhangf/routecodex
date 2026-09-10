// feature_id: v3.provider_response_error_policy_closeout

fn configured_retry_budget_for_failure(
    matched_policy: Option<&V3ProviderErrorActionPolicyManifest>,
    default_budget: usize,
) -> usize {
    // A provider failure must always advance to another candidate.  Retry
    // budgets remain in the manifest for observability/backoff metadata, but
    // are never used to send the same request to the same provider again.
    let _ = (matched_policy, default_budget);
    0
}

fn configured_retry_backoff_ms(
    matched_policy: Option<&V3ProviderErrorActionPolicyManifest>,
    retries_done: usize,
) -> u64 {
    let Some((backoff_ms, multiplier)) = matched_policy.and_then(|policy| {
        policy.path.iter().find_map(|step| match step {
            V3ProviderDispositionStepManifest::WaitRetry {
                backoff_ms,
                backoff_multiplier,
                ..
            } => Some((*backoff_ms, backoff_multiplier.unwrap_or(1))),
            _ => None,
        })
    }) else {
        return 0;
    };
    let exponent = u32::try_from(retries_done).unwrap_or(u32::MAX);
    backoff_ms
        .saturating_mul(multiplier.saturating_pow(exponent))
        .min(60_000)
}

fn configured_retry_mode(
    matched_policy: Option<&V3ProviderErrorActionPolicyManifest>,
    default_same_candidate_retries: usize,
) -> Option<V3ProviderErrorRetryMode> {
    matched_policy
        .and_then(|policy| {
            policy.path.iter().find_map(|step| match step {
                V3ProviderDispositionStepManifest::WaitRetry { retry_mode, .. } => Some(*retry_mode),
                _ => None,
            })
        })
        .or_else(|| {
            (default_same_candidate_retries > 0)
                .then_some(V3ProviderErrorRetryMode::RetrySame)
        })
}

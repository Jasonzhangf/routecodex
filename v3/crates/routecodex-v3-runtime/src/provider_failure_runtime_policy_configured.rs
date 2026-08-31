// feature_id: v3.provider_response_error_policy_closeout

fn configured_retry_budget_for_failure(
    matched_policy: Option<&V3ProviderErrorActionPolicyManifest>,
    default_budget: usize,
) -> usize {
    let Some(policy) = matched_policy else {
        return default_budget;
    };
    policy
        .path
        .iter()
        .find_map(|step| match step {
            V3ProviderDispositionStepManifest::WaitRetry {
                retry_mode:
                    V3ProviderErrorRetryMode::RetrySame
                    | V3ProviderErrorRetryMode::ReselectBeforeClientProjection,
                max_attempts,
                ..
            } => Some(max_attempts.saturating_sub(1) as usize),
            V3ProviderDispositionStepManifest::WaitRetry { .. } => Some(0),
            _ => None,
        })
        .unwrap_or(default_budget)
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

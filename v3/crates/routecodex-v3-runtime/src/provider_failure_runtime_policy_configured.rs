// feature_id: v3.provider_response_error_policy_closeout

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

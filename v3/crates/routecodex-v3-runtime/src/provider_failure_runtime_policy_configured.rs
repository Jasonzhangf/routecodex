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
) -> Option<V3ProviderErrorRetryMode> {
    matched_policy.and_then(|policy| {
        policy.path.iter().find_map(|step| match step {
            V3ProviderDispositionStepManifest::WaitRetry { retry_mode, .. } => Some(*retry_mode),
            _ => None,
        })
    })
}

fn configured_health_policy_for_failure(
    matched_policy_directive: Option<&V3ProviderErrorActionPolicyManifest>,
    manifest: &V3Config05ManifestPublished,
    provider_id: &str,
    provider_type: Option<&str>,
    model_id: Option<&str>,
    status: u16,
    error_type: Option<&str>,
    message: &str,
) -> Option<V3ProviderFailurePolicy> {
    let policy = match matched_policy_directive {
        Some(policy) => policy,
        None => manifest
            .error
            .provider_error_action_policy
            .iter()
            .find(|policy| {
                provider_error_policy_matches_source_failure(
                    policy,
                    provider_id,
                    provider_type,
                    model_id,
                    status,
                    error_type,
                ) && (policy.matcher.content_contains_any.is_empty()
                    || policy
                        .matcher
                        .content_contains_any
                        .iter()
                        .any(|value| message.contains(value)))
            })?,
    };
    let threshold = policy
        .path
        .iter()
        .find_map(|step| match step {
            V3ProviderDispositionStepManifest::WaitRetry { max_attempts, .. } => {
                Some((*max_attempts).max(1))
            }
            _ => None,
        })
        .unwrap_or(1);
    let cooldown_ms = policy.path.iter().find_map(|step| match step {
        V3ProviderDispositionStepManifest::Cooldown {
            duration_ms: Some(duration_ms),
            ..
        } => Some((*duration_ms).max(1)),
        _ => None,
    });
    let until_restart = policy.path.iter().any(|step| {
        matches!(
            step,
            V3ProviderDispositionStepManifest::Cooldown {
                until_restart: Some(true),
                ..
            }
        )
    });
    let cooldown_scope = policy.path.iter().find_map(|step| match step {
        V3ProviderDispositionStepManifest::Cooldown {
            scope: V3ProviderErrorActionScope::AuthKey,
            ..
        } => Some(V3ProviderFailureCooldownScope::AuthKey),
        V3ProviderDispositionStepManifest::Cooldown { .. } => {
            Some(V3ProviderFailureCooldownScope::Session)
        }
        _ => None,
    }).unwrap_or(V3ProviderFailureCooldownScope::Session);
    if cooldown_ms.is_none() && !until_restart {
        return None;
    }
    Some(V3ProviderFailurePolicy {
        failure_threshold: threshold,
        cooldown_ms: cooldown_ms.unwrap_or(1),
        probe_interval_ms: routecodex_v3_config::internal::v3_provider_probe_interval_ms(
            match cooldown_scope {
                V3ProviderFailureCooldownScope::AuthKey => {
                    routecodex_v3_config::internal::V3ProviderProbeIntervalScope::AuthKey
                }
                V3ProviderFailureCooldownScope::Session => {
                    routecodex_v3_config::internal::V3ProviderProbeIntervalScope::Recoverable
                }
            },
        ),
        until_restart,
        cooldown_scope,
    })
}

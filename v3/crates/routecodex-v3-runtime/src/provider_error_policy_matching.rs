use routecodex_v3_config::V3ProviderErrorActionPolicyManifest;

/// Shared scalar matcher for provider-error action policies.
///
/// Payload-specific predicates remain at their owning response-diagnostics
/// boundary; runtime failure policy uses the same matcher for source errors.
pub(crate) fn provider_error_policy_matches_failure(
    policy: &V3ProviderErrorActionPolicyManifest,
    provider_id: &str,
    provider_type: Option<&str>,
    model: Option<&str>,
    status: u16,
    provider_code: Option<&str>,
) -> bool {
    policy
        .scope
        .provider_id
        .as_deref()
        .is_none_or(|expected| expected == provider_id)
        && policy
            .scope
            .provider_type
            .as_deref()
            .is_none_or(|expected| Some(expected) == provider_type)
        && policy
            .scope
            .model_id
            .as_deref()
            .is_none_or(|expected| Some(expected) == model)
        && policy
            .matcher
            .http_status
            .is_none_or(|expected| expected == status)
        && policy
            .matcher
            .provider_code
            .as_deref()
            .is_none_or(|expected| Some(expected) == provider_code)
}

pub(crate) fn provider_error_policy_matches_source_failure(
    policy: &V3ProviderErrorActionPolicyManifest,
    provider_id: &str,
    provider_type: Option<&str>,
    model: Option<&str>,
    status: u16,
    provider_code: Option<&str>,
) -> bool {
    policy.matcher.provider_type_code.is_none()
        && policy.matcher.terminal_status.is_none()
        && policy.matcher.finish_reason.is_none()
        && policy.matcher.usage_total_tokens.is_none()
        && policy.matcher.input_tokens.is_none()
        && policy.matcher.output_tokens.is_none()
        && policy.matcher.choices_count.is_none()
        && policy.matcher.has_valid_model_output.is_none()
        && provider_error_policy_matches_failure(
            policy,
            provider_id,
            provider_type,
            model,
            status,
            provider_code,
        )
}

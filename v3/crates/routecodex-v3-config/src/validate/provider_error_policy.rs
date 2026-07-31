fn compile_error(
    mut authoring: V3ErrorAuthoringConfig,
    provider_scoped_policies: Vec<V3ProviderErrorActionPolicyAuthoringConfig>,
) -> Result<V3ErrorManifest, V3ConfigError> {
    let policies = authoring
        .policies
        .into_iter()
        .map(|(id, policy)| {
            require_id("error policy", &id)?;
            if policy.action.trim().is_empty() {
                return Err(validation(format!("error policy {id} action is empty")));
            }
            Ok((
                id,
                V3ErrorPolicyManifest {
                    action: policy.action,
                    cooldown_ms: policy.cooldown_ms,
                    max_attempts: policy.max_attempts,
                },
            ))
        })
        .collect::<Result<_, V3ConfigError>>()?;
    authoring
        .provider_error_action_policy
        .extend(provider_scoped_policies);
    let provider_error_action_policy =
        compile_provider_error_action_policies(authoring.provider_error_action_policy)?;
    let client_error_projection_policy =
        compile_client_error_projection_policies(authoring.client_error_projection_policy)?;
    Ok(V3ErrorManifest {
        policies,
        provider_error_action_policy,
        client_error_projection_policy,
    })
}

fn compile_provider_error_action_policies(
    policies: Vec<V3ProviderErrorActionPolicyAuthoringConfig>,
) -> Result<Vec<V3ProviderErrorActionPolicyManifest>, V3ConfigError> {
    let mut seen = BTreeSet::new();
    let mut compiled = Vec::with_capacity(policies.len());
    for policy in policies {
        require_id("provider error action policy", &policy.policy_id)?;
        if !seen.insert(policy.policy_id.clone()) {
            return Err(validation(format!(
                "duplicate provider error action policy {}",
                policy.policy_id
            )));
        }
        let scope = compile_provider_error_policy_scope(&policy.policy_id, policy.scope)?;
        let matcher = compile_provider_error_matcher(&policy.policy_id, policy.matcher, &scope)?;
        let action = compile_provider_error_action(&policy.policy_id, policy.action)?;
        compiled.push(V3ProviderErrorActionPolicyManifest {
            policy_id: policy.policy_id,
            scope,
            matcher,
            action,
        });
    }
    Ok(compiled)
}

fn compile_provider_error_policy_scope(
    policy_id: &str,
    scope: V3ProviderErrorPolicyScopeAuthoringConfig,
) -> Result<V3ProviderErrorPolicyScopeManifest, V3ConfigError> {
    validate_optional_policy_id("provider_id", policy_id, scope.provider_id.as_deref())?;
    validate_optional_policy_id("provider_type", policy_id, scope.provider_type.as_deref())?;
    validate_optional_policy_id("model_id", policy_id, scope.model_id.as_deref())?;
    validate_optional_policy_id("routing_group", policy_id, scope.routing_group.as_deref())?;
    Ok(V3ProviderErrorPolicyScopeManifest {
        provider_id: scope.provider_id,
        provider_type: scope.provider_type,
        model_id: scope.model_id,
        routing_group: scope.routing_group,
    })
}

fn compile_provider_error_matcher(
    policy_id: &str,
    mut matcher: V3ProviderErrorMatcherAuthoringConfig,
    scope: &V3ProviderErrorPolicyScopeManifest,
) -> Result<V3ProviderErrorMatcherManifest, V3ConfigError> {
    if let Some(sse) = matcher.sse.take() {
        if matcher.finish_reason.is_none() {
            matcher.finish_reason = sse.finish_reason;
        }
        if matcher.usage_total_tokens.is_none() {
            matcher.usage_total_tokens = sse.usage_total_tokens;
        }
        if matcher.content_contains_any.is_empty() {
            matcher.content_contains_any = sse.content_contains_any;
        } else if !sse.content_contains_any.is_empty() {
            return Err(validation(format!(
                "provider error action policy {policy_id} duplicates content_contains_any in match and match.sse"
            )));
        }
    }
    if matcher.content_contains_any.iter().any(|value| {
        let trimmed = value.trim();
        trimmed.is_empty() || trimmed.len() > 512 || looks_like_secret_literal(trimmed)
    }) {
        return Err(validation(format!(
            "provider error action policy {policy_id} content matcher must be non-empty, bounded, and secret-free"
        )));
    }
    let uses_provider_specific_text = !matcher.content_contains_any.is_empty();
    if uses_provider_specific_text
        && scope.provider_id.is_none()
        && scope.provider_type.is_none()
        && scope.model_id.is_none()
    {
        return Err(validation(format!(
            "provider error action policy {policy_id} text matcher requires provider-specific scope"
        )));
    }
    if matcher.http_status.is_none()
        && matcher.provider_code.is_none()
        && matcher.provider_type_code.is_none()
        && matcher.terminal_status.is_none()
        && matcher.finish_reason.is_none()
        && matcher.usage_total_tokens.is_none()
        && matcher.input_tokens.is_none()
        && matcher.output_tokens.is_none()
        && matcher.choices_count.is_none()
        && matcher.has_valid_model_output.is_none()
        && matcher.content_contains_any.is_empty()
    {
        return Err(validation(format!(
            "provider error action policy {policy_id} matcher is empty"
        )));
    }
    validate_optional_matcher_value("provider_code", policy_id, matcher.provider_code.as_deref())?;
    validate_optional_matcher_value(
        "provider_type_code",
        policy_id,
        matcher.provider_type_code.as_deref(),
    )?;
    validate_optional_matcher_value(
        "terminal_status",
        policy_id,
        matcher.terminal_status.as_deref(),
    )?;
    validate_optional_matcher_value("finish_reason", policy_id, matcher.finish_reason.as_deref())?;
    Ok(V3ProviderErrorMatcherManifest {
        http_status: matcher.http_status,
        provider_code: matcher.provider_code,
        provider_type_code: matcher.provider_type_code,
        terminal_status: matcher.terminal_status,
        finish_reason: matcher.finish_reason,
        usage_total_tokens: matcher.usage_total_tokens,
        input_tokens: matcher.input_tokens,
        output_tokens: matcher.output_tokens,
        choices_count: matcher.choices_count,
        has_valid_model_output: matcher.has_valid_model_output,
        content_contains_any: matcher.content_contains_any,
    })
}

fn compile_provider_error_action(
    policy_id: &str,
    action: V3ProviderErrorActionAuthoringConfig,
) -> Result<V3ProviderErrorActionManifest, V3ConfigError> {
    require_id("provider error reason_code", &action.reason_code)?;
    if looks_like_secret_literal(&action.reason_code) {
        return Err(validation(format!(
            "provider error action policy {policy_id} reason_code must be secret-free"
        )));
    }
    if matches!(action.kind, V3ProviderErrorActionClass::PeriodicRecovery)
        && action.cooldown_ms.unwrap_or(0) == 0
    {
        return Err(validation(format!(
            "provider error action policy {policy_id} periodic_recovery requires cooldown_ms"
        )));
    }
    if action
        .cooldown_ms
        .is_some_and(|cooldown| cooldown > 24 * 60 * 60 * 1000)
    {
        return Err(validation(format!(
            "provider error action policy {policy_id} cooldown_ms exceeds one day"
        )));
    }
    Ok(V3ProviderErrorActionManifest {
        kind: action.kind,
        reason_code: action.reason_code,
        retry_mode: action.retry_mode,
        cooldown_ms: action.cooldown_ms,
        disable_scope: action.disable_scope,
    })
}

fn compile_client_error_projection_policies(
    policies: Vec<V3ClientErrorProjectionPolicyAuthoringConfig>,
) -> Result<Vec<V3ClientErrorProjectionPolicyManifest>, V3ConfigError> {
    let mut seen = BTreeSet::new();
    let mut compiled = Vec::with_capacity(policies.len());
    for policy in policies {
        require_id("client error projection policy", &policy.policy_id)?;
        if !seen.insert(policy.policy_id.clone()) {
            return Err(validation(format!(
                "duplicate client error projection policy {}",
                policy.policy_id
            )));
        }
        if policy.matcher.reason_code.is_none() && policy.matcher.action_class.is_none() {
            return Err(validation(format!(
                "client error projection policy {} matcher is empty",
                policy.policy_id
            )));
        }
        if let Some(reason_code) = policy.matcher.reason_code.as_deref() {
            require_id("client error projection reason_code", reason_code)?;
            if looks_like_secret_literal(reason_code) {
                return Err(validation(format!(
                    "client error projection policy {} reason_code must be secret-free",
                    policy.policy_id
                )));
            }
        }
        require_id(
            "client error projection public_code",
            &policy.projection.public_code,
        )?;
        if looks_like_secret_literal(&policy.projection.public_code) {
            return Err(validation(format!(
                "client error projection policy {} public_code must be secret-free",
                policy.policy_id
            )));
        }
        compiled.push(V3ClientErrorProjectionPolicyManifest {
            policy_id: policy.policy_id,
            matcher: V3ClientErrorProjectionMatcherManifest {
                reason_code: policy.matcher.reason_code,
                action_class: policy.matcher.action_class,
            },
            projection: V3ClientErrorProjectionManifest {
                public_code: policy.projection.public_code,
                message_mode: policy.projection.message_mode,
            },
        });
    }
    Ok(compiled)
}

fn validate_optional_policy_id(
    field: &str,
    policy_id: &str,
    value: Option<&str>,
) -> Result<(), V3ConfigError> {
    if let Some(value) = value {
        require_id(field, value)?;
        if looks_like_secret_literal(value) {
            return Err(validation(format!(
                "provider error action policy {policy_id} {field} must be secret-free"
            )));
        }
    }
    Ok(())
}

fn validate_optional_matcher_value(
    field: &str,
    policy_id: &str,
    value: Option<&str>,
) -> Result<(), V3ConfigError> {
    if let Some(value) = value {
        require_id(field, value)?;
        if looks_like_secret_literal(value) {
            return Err(validation(format!(
                "provider error action policy {policy_id} {field} must be secret-free"
            )));
        }
    }
    Ok(())
}

fn validate_selection_weight(
    owner: &str,
    policy: &V3SelectionPolicy,
    priority: Option<i32>,
    weight: Option<u32>,
) -> Result<(), V3ConfigError> {
    match policy.strategy {
        V3SelectionStrategy::Priority if priority.is_none() => Err(validation(format!(
            "{owner} priority selection target missing priority"
        ))),
        V3SelectionStrategy::Weighted if weight.unwrap_or(0) == 0 => Err(validation(format!(
            "{owner} weighted selection target needs positive weight"
        ))),
        V3SelectionStrategy::RoundRobin => Ok(()),
        _ => Ok(()),
    }
}

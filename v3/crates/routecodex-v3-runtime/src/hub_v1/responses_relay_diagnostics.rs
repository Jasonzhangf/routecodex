// Provider diagnostic projections, split from responses_relay_runtime.rs to
// satisfy verify:v3-file-size. Semantics unchanged; the caller site in
// responses_relay_runtime was prefixed with `responses_relay_diagnostics::`.

use super::*;

pub(super) fn openai_chat_provider_diagnostic_message(payload: &Value) -> Option<String> {
    let usage = extract_v3_runtime_usage_summary(payload);
    let usage_zero = usage.as_ref().is_some_and(|usage| {
        usage.input_tokens == Some(0)
            && usage.output_tokens == Some(0)
            && usage.total_tokens == Some(0)
    });
    payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| {
            choices.iter().find_map(|choice| {
                if choice.get("finish_reason").and_then(Value::as_str) != Some("stop") {
                    return None;
                }
                let message = choice.get("message").and_then(Value::as_object)?;
                if !message
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .is_none_or(Vec::is_empty)
                {
                    return None;
                }
                let content = message.get("content").and_then(Value::as_str)?.trim();
                if usage_zero && content.starts_with("upstream returned zero output tokens") {
                    return Some(
                        "OpenAI Chat provider returned zero-output upstream diagnostic instead of model output"
                            .to_string(),
                    );
                }
                None
            })
        })
}

// ---- provider 语义错误投影（从 responses_relay_runtime.rs 移入，语义不变）----

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct V3ProviderSemanticErrorProjection {
    pub(super) code: String,
    pub(super) message: String,
    pub(super) provider_global_failure: bool,
    pub(super) cooldown_ms: Option<u64>,
}

pub(super) fn anthropic_cyber_refusal_error_from_payload(
    payload: &Value,
) -> Option<V3ProviderSemanticErrorProjection> {
    let direct = payload.as_object();
    let delta = payload.get("delta").and_then(Value::as_object);
    let candidate = [direct, delta]
        .into_iter()
        .flatten()
        .find(|object| anthropic_cyber_refusal_object_matches(object))?;
    let explanation = candidate
        .get("stop_details")
        .and_then(Value::as_object)
        .and_then(|details| details.get("explanation"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Anthropic returned a cyber-category refusal.");
    Some(V3ProviderSemanticErrorProjection {
        code: V3_ANTHROPIC_CYBER_REFUSAL_CODE.to_string(),
        message: format!(
            "Anthropic cyber refusal is treated as retryable provider saturation: {explanation}"
        ),
        provider_global_failure: false,
        cooldown_ms: None,
    })
}

fn anthropic_cyber_refusal_object_matches(object: &Map<String, Value>) -> bool {
    let stop_reason = object
        .get("stop_reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .map(str::to_ascii_lowercase);
    if stop_reason.as_deref() != Some("refusal") {
        return false;
    }
    object
        .get("stop_details")
        .and_then(Value::as_object)
        .and_then(|details| details.get("category"))
        .and_then(Value::as_str)
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
        == Some("cyber")
}

pub(super) fn provider_response_semantic_error_message_from_manifest(
    manifest: Option<&V3Config05ManifestPublished>,
    provider_id: Option<&str>,
    payload: &Value,
) -> Option<String> {
    provider_response_semantic_error_from_manifest(manifest, provider_id, payload)
        .map(|error| error.message)
}

pub(super) fn provider_response_semantic_error_from_manifest(
    manifest: Option<&V3Config05ManifestPublished>,
    provider_id: Option<&str>,
    payload: &Value,
) -> Option<V3ProviderSemanticErrorProjection> {
    let manifest = manifest?;
    let provider_id = provider_id?;
    let provider = manifest.providers.get(provider_id);
    let provider_type = provider.map(|provider| provider.provider_type.as_str());
    let model = payload.get("model").and_then(Value::as_str);
    manifest
        .error
        .provider_error_action_policy
        .iter()
        .find(|policy| {
            provider_error_action_policy_matches(policy, provider_id, provider_type, model, payload)
        })
        .map(|policy| {
            let public_message = manifest
                .error
                .client_error_projection_policy
                .iter()
                .find(|projection| {
                    projection
                        .matcher
                        .reason_code
                        .as_deref()
                        .is_none_or(|reason| reason == policy.action.reason_code)
                        && projection
                            .matcher
                            .action_class
                            .is_none_or(|action| action == policy.action.kind)
                })
                .map(|projection| projection.projection.public_code.clone())
                .unwrap_or_else(|| policy.action.reason_code.clone());
            V3ProviderSemanticErrorProjection {
                code: policy.action.reason_code.clone(),
                message: format!(
                    "Provider response semantic error matched policy {} reason {} action {} display {}",
                    policy.policy_id,
                    policy.action.reason_code,
                    policy.action.kind.as_str(),
                    public_message
                ),
                provider_global_failure: policy.action.provider_global_failure
                    || policy.path.iter().any(|step| {
                        matches!(
                            step,
                            routecodex_v3_config::V3ProviderDispositionStepManifest::Cooldown {
                                provider_global_failure: true,
                                ..
                            }
                        )
                    }),
                cooldown_ms: policy
                    .path
                    .iter()
                    .find_map(|step| match step {
                        routecodex_v3_config::V3ProviderDispositionStepManifest::Cooldown {
                            duration_ms,
                            ..
                        } => *duration_ms,
                        _ => None,
                    })
                    .or(policy.action.cooldown_ms),
            }
        })
}

fn provider_error_action_policy_matches(
    policy: &V3ProviderErrorActionPolicyManifest,
    provider_id: &str,
    provider_type: Option<&str>,
    model: Option<&str>,
    payload: &Value,
) -> bool {
    let provider_code = provider_payload_provider_code(payload);
    crate::provider_error_policy_matching::provider_error_policy_matches_failure(
        policy,
        provider_id,
        provider_type,
        model,
        200,
        provider_code,
    ) && provider_error_matcher_matches(&policy.matcher, payload)
}

fn provider_payload_provider_code(payload: &Value) -> Option<&str> {
    [
        payload.pointer("/error/code"),
        payload.pointer("/response/error/code"),
    ]
    .into_iter()
    .flatten()
    .find_map(Value::as_str)
    .map(str::trim)
    .filter(|code| !code.is_empty())
}

fn provider_error_matcher_matches(
    matcher: &V3ProviderErrorMatcherManifest,
    payload: &Value,
) -> bool {
    if matcher.http_status.is_some_and(|status| status != 200) {
        return false;
    }
    let usage = extract_v3_runtime_usage_summary(payload);
    if matcher.usage_total_tokens.is_some_and(|expected| {
        usage.as_ref().and_then(|usage| usage.total_tokens) != Some(expected)
    }) {
        return false;
    }
    if matcher.input_tokens.is_some_and(|expected| {
        usage.as_ref().and_then(|usage| usage.input_tokens) != Some(expected)
    }) {
        return false;
    }
    if matcher.output_tokens.is_some_and(|expected| {
        usage.as_ref().and_then(|usage| usage.output_tokens) != Some(expected)
    }) {
        return false;
    }
    let choices = payload.get("choices").and_then(Value::as_array);
    if matcher
        .choices_count
        .is_some_and(|expected| choices.map_or(0, Vec::len) != expected)
    {
        return false;
    }
    if matcher
        .finish_reason
        .as_deref()
        .is_some_and(|expected| !payload_choices_have_finish_reason(payload, expected))
    {
        return false;
    }
    if matcher
        .has_valid_model_output
        .is_some_and(|expected| provider_payload_has_valid_model_output(payload) != expected)
    {
        return false;
    }
    if !matcher.content_contains_any.is_empty()
        && !provider_payload_content_contains_any(payload, &matcher.content_contains_any)
    {
        return false;
    }
    true
}

fn payload_choices_have_finish_reason(payload: &Value, expected: &str) -> bool {
    payload
        .get("choices")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|choice| choice.get("finish_reason").and_then(Value::as_str) == Some(expected))
}

fn provider_payload_has_valid_model_output(payload: &Value) -> bool {
    payload
        .get("choices")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|choice| {
            let Some(message) = choice.get("message").and_then(Value::as_object) else {
                return false;
            };
            message
                .get("tool_calls")
                .and_then(Value::as_array)
                .is_some_and(|calls| !calls.is_empty())
                || message
                    .get("content")
                    .and_then(Value::as_str)
                    .is_some_and(|content| !content.trim().is_empty())
        })
}

fn provider_payload_content_contains_any(payload: &Value, phrases: &[String]) -> bool {
    payload
        .get("choices")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|choice| choice.get("message").and_then(Value::as_object))
        .filter_map(|message| message.get("content").and_then(Value::as_str))
        .any(|content| phrases.iter().any(|phrase| content.contains(phrase)))
}

#[cfg(test)]
mod tests {
    use super::provider_payload_provider_code;
    use serde_json::json;

    #[test]
    fn provider_code_is_read_from_provider_error_semantics() {
        assert_eq!(
            provider_payload_provider_code(&json!({"error":{"code":"quota_exhausted"}})),
            Some("quota_exhausted")
        );
        assert_eq!(
            provider_payload_provider_code(
                &json!({"type":"response.failed","response":{"error":{"code":"upstream_failed"}}})
            ),
            Some("upstream_failed")
        );
        assert_eq!(
            provider_payload_provider_code(&json!({"error":{"code":"  "}})),
            None
        );
    }
}

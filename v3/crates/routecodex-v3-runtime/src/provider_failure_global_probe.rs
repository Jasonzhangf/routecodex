use crate::provider_failure_runtime_policy::V3ProviderFailureRuntimeHealth;
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::{
    build_v3_provider_failure_action_from_v3_error_02,
    build_v3_provider_global_error_fingerprint_from_classified, V3Error02Classified,
    V3ProviderFailureSessionScope,
};
use routecodex_v3_provider_responses::{
    build_v3_provider_global_probe_request, ReqwestResponsesTransport, ResponsesTransport,
    V3ProviderAuthHandle, V3ProviderAuthSecretHandle, V3ResponsesProviderTarget,
};

pub fn build_v3_provider_global_probe_target(
    manifest: &V3Config05ManifestPublished,
    provider_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> Result<V3ResponsesProviderTarget, String> {
    let provider = manifest
        .providers
        .get(provider_id)
        .ok_or_else(|| format!("probe provider {provider_id} missing"))?;
    let auth = provider
        .auth
        .entries
        .iter()
        .find(|entry| auth_alias.is_none_or(|alias| entry.alias == alias))
        .ok_or_else(|| format!("probe provider {provider_id} has no auth entry"))?;
    let secret = match (
        &auth.env,
        &auth.token_file,
        &auth.secret_file,
        &auth.secret_key,
        &auth.api_key,
    ) {
        (Some(env), None, None, None, None) => V3ProviderAuthSecretHandle::Environment(env.clone()),
        (None, Some(path), None, None, None) => V3ProviderAuthSecretHandle::TokenFile(path.clone()),
        (None, None, Some(path), Some(key), None) => V3ProviderAuthSecretHandle::SecretFile {
            path: path.clone(),
            key: key.clone(),
        },
        (None, None, None, None, Some(value)) => V3ProviderAuthSecretHandle::ApiKey(value.clone()),
        _ => {
            return Err(format!(
                "probe provider {provider_id} auth entry is invalid"
            ))
        }
    };
    let model = provider
        .models
        .get(model_id.unwrap_or(&provider.default_model))
        .ok_or_else(|| format!("probe provider {provider_id} default model missing"))?;
    let responses = provider.responses.as_ref();
    Ok(V3ResponsesProviderTarget {
        provider_id: provider.id.clone(),
        provider_type: provider.provider_type.clone(),
        base_url: provider.base_url.clone(),
        canonical_model_id: model.id.clone(),
        wire_model: model.wire_name.clone(),
        compatibility_profile: provider.compatibility_profile.clone(),
        auth: V3ProviderAuthHandle {
            alias: auth.alias.clone(),
            secret,
        },
        responses_transport: responses.map(|value| value.transport).unwrap_or_default(),
        websocket_v2_url: responses.and_then(|value| value.websocket_v2_url.clone()),
        provider_request_cleanup: provider.provider_request_cleanup.clone(),
        request_timeout_ms: provider.request_timeout_ms,
        sse_first_frame_timeout_ms: provider.sse_first_frame_timeout_ms,
        initial_concurrency_budget: provider
            .concurrency
            .as_ref()
            .map(|value| value.max_in_flight)
            .unwrap_or(8),
    })
}

impl V3ProviderFailureRuntimeHealth {
    pub(crate) fn record_provider_global_health_for_classified_error(
        &self,
        scope: &V3ProviderFailureSessionScope,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        classified: &V3Error02Classified,
        now_ms: u64,
    ) -> Result<(), String> {
        let Some(fingerprint) =
            build_v3_provider_global_error_fingerprint_from_classified(classified)?
        else {
            return Ok(());
        };
        let action = build_v3_provider_failure_action_from_v3_error_02(classified);
        self.record_provider_key_failure_action(
            provider_id,
            auth_alias,
            model_id,
            &action,
            now_ms,
        )?;
        let _ = self.record_provider_failure_in_session_without_health_cooldown(
            scope,
            provider_id,
            auth_alias,
            model_id,
            Some(fingerprint.reason_code.as_str()),
            now_ms,
        )?;
        Ok(())
    }
}

pub(crate) async fn probe_v3_provider_global_target_impl(
    target: V3ResponsesProviderTarget,
) -> Result<(), String> {
    let provider_id = target.provider_id.clone();
    let provider_type = target.provider_type.clone();
    let request = build_v3_provider_global_probe_request(
        target,
        format!("provider-global-probe-{provider_id}"),
    )?;
    let response = ReqwestResponsesTransport::default()
        .send(request)
        .await
        .map_err(|error| error.to_string())?;
    if !(200..=299).contains(&response.status()) {
        return Err(format!(
            "provider global probe returned {}",
            response.status()
        ));
    }
    let json = response
        .json_body()
        .ok_or_else(|| format!("provider global probe returned non-JSON body for {provider_id}"))?;
    validate_v3_provider_probe_json(&provider_id, &provider_type, json)?;
    Ok(())
}

fn validate_v3_provider_probe_json(
    provider_id: &str,
    provider_type: &str,
    json: &[u8],
) -> Result<(), String> {
    let value = serde_json::from_slice::<serde_json::Value>(json).map_err(|error| {
        format!("provider global probe returned invalid JSON for {provider_id}: {error}")
    })?;
    let object = value.as_object().ok_or_else(|| {
        format!("provider global probe returned non-object JSON for {provider_id}")
    })?;
    if object.contains_key("error") {
        return Err(format!(
            "provider global probe returned 2xx with embedded error payload for {provider_id}"
        ));
    }
    let completed = match provider_type {
        "responses" => {
            object.get("status").and_then(serde_json::Value::as_str) == Some("completed")
        }
        "openai_chat" => object
            .get("choices")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|choices| {
                choices.first().is_some_and(|choice| {
                    choice
                        .get("finish_reason")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|reason| !reason.is_empty())
                })
            }),
        "anthropic" => {
            object.get("type").and_then(serde_json::Value::as_str) == Some("message")
                && object
                    .get("stop_reason")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|reason| !reason.is_empty())
        }
        "gemini" => object
            .get("candidates")
            .and_then(serde_json::Value::as_array)
            .is_some_and(|candidates| {
                candidates.first().is_some_and(|candidate| {
                    candidate
                        .get("finishReason")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|reason| !reason.is_empty())
                })
            }),
        other => return Err(format!("unsupported provider probe protocol {other}")),
    };
    completed.then_some(()).ok_or_else(|| {
        format!(
            "provider global probe returned no successful terminal payload for {provider_id} ({provider_type})"
        )
    })
}

#[cfg(test)]
mod tests {
    use super::validate_v3_provider_probe_json;

    #[test]
    fn http_200_error_payload_is_probe_failure() {
        let error = validate_v3_provider_probe_json(
            "provider-a",
            "responses",
            br#"{"error":{"code":"invalid_api_key"}}"#,
        )
        .expect_err("embedded provider error must fail the probe");
        assert!(error.contains("embedded error payload"));
    }

    #[test]
    fn malformed_or_failed_json_is_probe_failure() {
        assert!(validate_v3_provider_probe_json("provider-a", "responses", b"not-json").is_err());
        assert!(validate_v3_provider_probe_json(
            "provider-a",
            "responses",
            br#"{"status":"failed"}"#,
        )
        .is_err());
        assert!(validate_v3_provider_probe_json(
            "provider-a",
            "responses",
            br#"{"status":"completed"}"#,
        )
        .is_ok());
    }

    #[test]
    fn each_provider_protocol_requires_its_terminal_success_shape() {
        assert!(validate_v3_provider_probe_json(
            "provider-a",
            "openai_chat",
            br#"{"choices":[{"finish_reason":"stop"}]}"#,
        )
        .is_ok());
        assert!(validate_v3_provider_probe_json(
            "provider-a",
            "openai_chat",
            br#"{"choices":[{}]}"#,
        )
        .is_err());
        assert!(validate_v3_provider_probe_json(
            "provider-a",
            "openai_chat",
            br#"{"choices":[{"finish_reason":""}]}"#,
        )
        .is_err());
        assert!(validate_v3_provider_probe_json(
            "provider-a",
            "anthropic",
            br#"{"type":"message","stop_reason":"max_tokens"}"#,
        )
        .is_ok());
        assert!(validate_v3_provider_probe_json(
            "provider-a",
            "gemini",
            br#"{"candidates":[{"finishReason":"MAX_TOKENS"}]}"#,
        )
        .is_ok());
        assert!(validate_v3_provider_probe_json(
            "provider-a",
            "anthropic",
            br#"{"type":"message","stop_reason":""}"#,
        )
        .is_err());
        assert!(validate_v3_provider_probe_json(
            "provider-a",
            "gemini",
            br#"{"candidates":[{"finishReason":""}]}"#,
        )
        .is_err());
        assert!(validate_v3_provider_probe_json("provider-a", "openai_chat", br#"{}"#).is_err());
        assert!(validate_v3_provider_probe_json("provider-a", "anthropic", br#"{}"#).is_err());
        assert!(validate_v3_provider_probe_json("provider-a", "gemini", br#"{}"#).is_err());
    }
}

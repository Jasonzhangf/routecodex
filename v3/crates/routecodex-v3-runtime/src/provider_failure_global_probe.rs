use crate::provider_failure_runtime_policy::{
    apply_v3_internal_provider_failure_policy, V3ProviderFailureRuntimeHealth,
};
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::{
    build_v3_provider_failure_action_from_v3_error_02,
    build_v3_provider_global_error_fingerprint_from_classified, V3Error02Classified,
    V3ProviderFailureSessionScope,
};
use routecodex_v3_provider_responses::{
    adaptive_concurrency::V3AdaptiveConcurrencyController, build_v3_provider_global_probe_request,
    ReqwestResponsesTransport, ResponsesTransport, V3ProviderAuthHandle,
    V3ProviderAuthSecretHandle, V3ProviderError, V3ResponsesProviderTarget,
};

use crate::provider_failure_runtime_policy::{
    v3_relay_provider_policy_now_epoch_ms, V3ProviderHealthProbeFailure,
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
    let model = match model_id {
        Some(id) => provider
            .models
            .get(id)
            .ok_or_else(|| format!("probe provider {provider_id} model {id} is not routed"))?,
        None => provider
            .models
            .values()
            .next()
            .ok_or_else(|| format!("probe provider {provider_id} has no routed model"))?,
    };
    let responses = provider.responses.as_ref();
    Ok(V3ResponsesProviderTarget {
        provider_id: provider.id.clone(),
        provider_type: provider.provider_type.clone(),
        base_url: provider.base_url.clone(),
        canonical_model_id: model.id.clone(),
        wire_model: model.wire_name.clone(),
        compatibility_profile: provider.compatibility_profile.clone(),
        headers: provider.headers.clone(),
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
        concurrency_acquire_timeout_ms: provider
            .concurrency
            .as_ref()
            .map(|value| value.acquire_timeout_ms)
            .unwrap_or(60_000),
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
        let status = classified
            .source
            .external_error
            .as_ref()
            .and_then(|error| error.status)
            .unwrap_or(0);
        let action = apply_v3_internal_provider_failure_policy(
            build_v3_provider_failure_action_from_v3_error_02(classified),
            classified.source.source_stage,
            status,
            &classified.source.code,
        );
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
) -> Result<(), V3ProviderHealthProbeFailure> {
    let provider_id = target.provider_id.clone();
    let provider_key = format!("{}:{}", target.provider_id, target.auth.alias);
    let initial_concurrency_budget = target.initial_concurrency_budget;
    let request = build_v3_provider_global_probe_request(
        target,
        format!("provider-global-probe-{provider_id}"),
    )
    .map_err(V3ProviderHealthProbeFailure::Internal)?;
    let concurrency = V3AdaptiveConcurrencyController::process_shared();
    concurrency
        .ensure_initial_budget(&provider_key, initial_concurrency_budget)
        .map_err(V3ProviderHealthProbeFailure::Internal)?;
    let now_ms =
        v3_relay_provider_policy_now_epoch_ms().map_err(V3ProviderHealthProbeFailure::Internal)?;
    let admission = concurrency
        .try_acquire(&provider_key, now_ms)
        .ok_or(V3ProviderHealthProbeFailure::ConcurrencyBusy)?;
    let response = ReqwestResponsesTransport::default()
        .send(request.with_pre_acquired_admission(admission))
        .await
        .map_err(provider_probe_error)?;
    if !provider_probe_status_is_success(response.status()) {
        return Err(V3ProviderHealthProbeFailure::Provider(format!(
            "provider global probe returned {}",
            response.status()
        )));
    }
    Ok(())
}

fn provider_probe_status_is_success(status: u16) -> bool {
    (200..=299).contains(&status)
}

fn provider_probe_error(error: V3ProviderError) -> V3ProviderHealthProbeFailure {
    match error {
        V3ProviderError::HttpStatus { .. }
        | V3ProviderError::Transport { .. }
        | V3ProviderError::WebSocketTransport { .. }
        | V3ProviderError::WebSocketProtocol { .. }
        | V3ProviderError::WebSocketProviderEvent { .. }
        | V3ProviderError::UnexpectedContentType { .. }
        | V3ProviderError::ResponseBody { .. }
        | V3ProviderError::MalformedSse { .. } => {
            V3ProviderHealthProbeFailure::Provider(error.to_string())
        }
        _ => V3ProviderHealthProbeFailure::Internal(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{provider_probe_error, provider_probe_status_is_success};
    use crate::provider_failure_runtime_policy::V3ProviderHealthProbeFailure;
    use routecodex_v3_provider_responses::V3ProviderError;

    #[test]
    fn internal_transport_errors_remain_internal_probe_failures() {
        let error = provider_probe_error(V3ProviderError::InternalTransport {
            request_id: "probe-request".to_string(),
            provider_id: "provider-a".to_string(),
            lane: routecodex_v3_provider_responses::V3ProviderInternalTransportLane::Request,
            reason: "invalid concurrency budget".to_string(),
        });
        assert!(matches!(
            error,
            V3ProviderHealthProbeFailure::Internal(message)
                if message.contains("invalid concurrency budget")
        ));
    }

    #[test]
    fn websocket_provider_errors_are_provider_probe_failures() {
        let protocol = provider_probe_error(V3ProviderError::WebSocketProtocol {
            request_id: "probe-request".to_string(),
            provider_id: "provider-a".to_string(),
            reason: "provider protocol error".to_string(),
        });
        assert!(matches!(
            protocol,
            V3ProviderHealthProbeFailure::Provider(message)
                if message.contains("provider protocol error")
        ));

        let event = provider_probe_error(V3ProviderError::WebSocketProviderEvent {
            request_id: "probe-request".to_string(),
            provider_id: "provider-a".to_string(),
            status: Some(503),
            code: Some("server_error".to_string()),
            message: "provider unavailable".to_string(),
        });
        assert!(matches!(
            event,
            V3ProviderHealthProbeFailure::Provider(message)
                if message.contains("provider unavailable")
        ));
    }

    #[test]
    fn provider_global_probe_uses_http_status_only() {
        assert!(provider_probe_status_is_success(200));
        assert!(provider_probe_status_is_success(299));
        assert!(!provider_probe_status_is_success(199));
        assert!(!provider_probe_status_is_success(300));
    }
}

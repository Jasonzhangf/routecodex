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
    v3_provider_auth_handle_from_manifest_entry, ReqwestResponsesTransport, V3ProviderAuthHandle,
    V3ProviderError, V3ResponsesProviderTarget,
};

use crate::provider_failure_runtime_policy::{
    v3_relay_provider_policy_now_epoch_ms, V3ProviderHealthProbeFailure,
};

pub fn build_v3_provider_global_probe_target(
    manifest: &V3Config05ManifestPublished,
    provider_id: &str,
    interface_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> Result<V3ResponsesProviderTarget, String> {
    build_v3_provider_global_probe_target_at(
        manifest,
        provider_id,
        interface_id,
        auth_alias,
        model_id,
        v3_relay_provider_policy_now_epoch_ms()?,
    )
}

fn build_v3_provider_global_probe_target_at(
    manifest: &V3Config05ManifestPublished,
    provider_id: &str,
    interface_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
    now_ms: u64,
) -> Result<V3ResponsesProviderTarget, String> {
    let provider = manifest
        .providers
        .get(provider_id)
        .ok_or_else(|| format!("probe provider {provider_id} missing"))?;
    let interface = provider
        .interfaces
        .get(interface_id)
        .filter(|interface| interface.enabled)
        .ok_or_else(|| {
            format!("probe provider {provider_id} interface {interface_id} is absent or disabled")
        })?;
    let auth = provider
        .auth
        .entries
        .iter()
        .find(|entry| auth_alias.is_none_or(|alias| entry.alias == alias))
        .ok_or_else(|| format!("probe provider {provider_id} has no auth entry"))?;
    let secret = v3_provider_auth_handle_from_manifest_entry(auth.alias.clone(), auth)?.secret;
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
    // Global recovery probes and the periodic sweep are real provider requests.
    // Outside a model's declared availability window they must never be sent,
    // or a billable minute would be touched by a probe.
    if model
        .availability
        .as_ref()
        .is_some_and(|availability| !availability.is_available_at(now_ms))
    {
        return Err(format!(
            "probe provider {provider_id} model {} is outside its availability window",
            model.id
        ));
    }
    let responses = interface.responses.as_ref();
    Ok(V3ResponsesProviderTarget {
        provider_id: provider.id.clone(),
        interface_id: interface.id.clone(),
        provider_type: interface.provider_type.clone(),
        base_url: interface.base_url.clone(),
        canonical_model_id: model.id.clone(),
        wire_model: model.wire_name.clone(),
        compatibility_profile: interface
            .compatibility_profile
            .clone()
            .or_else(|| provider.compatibility_profile.clone()),
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
            .unwrap_or(40),
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
        interface_id: &str,
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
        self.record_provider_key_failure_action_for_interface(
            provider_id,
            interface_id,
            auth_alias,
            model_id,
            &action,
            now_ms,
        )?;
        let _ = self.record_provider_failure_in_session_without_health_cooldown_for_interface(
            scope,
            provider_id,
            interface_id,
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
    let identity_scope =
        routecodex_v3_provider_responses::adaptive_concurrency::V3ConcurrencyIdentityScope {
            interface_id: target.interface_id.clone(),
            model_id: target.canonical_model_id.clone(),
        };
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
        .try_acquire_scoped(&provider_key, Some(&identity_scope), now_ms)
        .ok_or(V3ProviderHealthProbeFailure::ConcurrencyBusy)?;
    ReqwestResponsesTransport::default()
        .send_probe(request.with_pre_acquired_admission(admission))
        .await
        .map_err(provider_probe_error)
}

fn provider_probe_error(error: V3ProviderError) -> V3ProviderHealthProbeFailure {
    match error {
        V3ProviderError::HttpStatus { .. }
        | V3ProviderError::Transport { .. }
        | V3ProviderError::ResponseBodyUnreadable { .. }
        | V3ProviderError::WebSocketTransport { .. }
        | V3ProviderError::WebSocketProtocol { .. }
        | V3ProviderError::WebSocketProviderEvent { .. }
        | V3ProviderError::UnexpectedContentType { .. }
        | V3ProviderError::ResponseBody { .. }
        | V3ProviderError::MalformedSse { .. } => V3ProviderHealthProbeFailure::Provider(error),
        _ => V3ProviderHealthProbeFailure::Internal(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{build_v3_provider_global_probe_target_at, provider_probe_error};
    use crate::provider_failure_runtime_policy::V3ProviderHealthProbeFailure;
    use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
    use routecodex_v3_provider_responses::{V3ProviderError, V3ProviderInternalTransportLane};

    fn probe_manifest(
        availability: Option<&str>,
    ) -> routecodex_v3_config::V3Config05ManifestPublished {
        let availability_line = availability
            .map(|value| format!("availability = {value}\n"))
            .unwrap_or_default();
        let source = format!(
            r#"
version = 3
[servers.s]
bind = "127.0.0.1"
port = 1
routing_group = "g"
[providers.p]
type = "responses"
base_url = "http://p.invalid/v1"
default_model = "m"
auth = {{ type = "api_key", entries = [{{ alias = "kp", env = "PROBE_KEY" }}] }}
[providers.p.models.m]
capabilities = ["text"]
{availability_line}
[route_groups.g.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "p", model = "m", key = "kp", priority = 1 }}]
"#
        );
        std::env::set_var("PROBE_KEY", "test-secret");
        compile_v3_config_05_manifest(
            parse_v3_config_02_authoring(&source).expect("probe authoring"),
        )
        .expect("probe manifest")
    }

    #[test]
    fn probe_target_is_refused_outside_the_declared_availability_window() {
        let manifest = probe_manifest(Some(
            r#"{ timezone = "Asia/Shanghai", guard_minutes = 0, periods = [{ start = "22:00", end = "08:00" }] }"#,
        ));
        // 10:00 Asia/Shanghai is outside the free window: no probe may be sent.
        let error = build_v3_provider_global_probe_target_at(
            &manifest,
            "p",
            "default",
            Some("kp"),
            Some("m"),
            1_767_232_800_000,
        )
        .expect_err("a probe must not be built outside the availability window");
        assert!(
            error.contains("outside its availability window"),
            "unexpected probe rejection reason: {error}"
        );
    }

    #[test]
    fn probe_target_is_built_inside_the_declared_availability_window() {
        let manifest = probe_manifest(Some(
            r#"{ timezone = "Asia/Shanghai", guard_minutes = 0, periods = [{ start = "22:00", end = "08:00" }] }"#,
        ));
        // 23:00 Asia/Shanghai is inside the free window.
        let target = build_v3_provider_global_probe_target_at(
            &manifest,
            "p",
            "default",
            Some("kp"),
            Some("m"),
            1_767_279_600_000,
        )
        .expect("a probe is allowed inside the availability window");
        assert_eq!(target.canonical_model_id, "m");
    }

    #[test]
    fn probe_target_without_availability_is_always_buildable() {
        let manifest = probe_manifest(None);
        build_v3_provider_global_probe_target_at(
            &manifest,
            "p",
            "default",
            Some("kp"),
            Some("m"),
            1_767_232_800_000,
        )
        .expect("an undeclared window keeps the probe buildable at any time");
    }

    #[test]
    fn internal_transport_errors_remain_internal_probe_failures() {
        assert!(matches!(
            provider_probe_error(V3ProviderError::InternalTransport {
                request_id: "probe".into(),
                provider_id: "p".into(),
                lane: V3ProviderInternalTransportLane::Request,
                reason: "invalid budget".into(),
            }),
            V3ProviderHealthProbeFailure::Internal(_)
        ));
    }
}

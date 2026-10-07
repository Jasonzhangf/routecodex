//! Direct original-source availability handoff regression.
//!
//! The frozen provider mapper raises `V3ErrorSourceKind::ProviderLocalFailure`
//! for provider-local construction failures (invalid base URL, missing or
//! unreadable auth secret). These tests lock the Direct kernel consumer: the
//! local source must reach the availability-aware provider failure policy with
//! real candidate facts, recover to a healthy candidate, and keep its original
//! internal 598 disposition without a client error response on exhaustion.

use super::*;
use async_trait::async_trait;
use routecodex_v3_config::{
    compile_v3_config_05_manifest, parse_v3_config_02_authoring, V3Config05ManifestPublished,
};
use std::sync::atomic::{AtomicUsize, Ordering};

#[path = "tests/fixtures.rs"]
mod fixtures;
use fixtures::*;

fn local_handoff_scope(routing_group: &str) -> V3ProviderFailureSessionScope {
    let session_id = format!("local-source-handoff:{routing_group}");
    V3ProviderFailureSessionScope::new("test", routing_group, &session_id)
        .expect("local handoff failure session scope")
        .with_transport_handoff_scope(format!("test-pipeline:{session_id}"), 7777, 1)
        .expect("local handoff transport handoff scope")
}

fn local_handoff_manifest(
    mut manifest: V3Config05ManifestPublished,
    routing_group: &str,
) -> V3Config05ManifestPublished {
    let source_group_id = manifest
        .servers
        .get("test")
        .expect("test server")
        .routing_group
        .clone();
    let mut group = manifest
        .route_groups
        .get(&source_group_id)
        .expect("test route group")
        .clone();
    group.id = routing_group.to_string();
    manifest
        .route_groups
        .insert(routing_group.to_string(), group);
    manifest
        .servers
        .get_mut("test")
        .expect("test server")
        .routing_group = routing_group.to_string();
    manifest
}

fn local_handoff_raw(
    routing_group: &str,
    request_id: &str,
    execution_id: &str,
) -> V3Server03HttpRequestRaw {
    V3Server03HttpRequestRaw {
        request_purpose: V3RequestPurpose::Conversation,
        port: Some(7777),
        pipeline_id: Some(format!("test-pipeline:{request_id}")),
        server_id: "test".to_string(),
        failure_session_scope: local_handoff_scope(routing_group),
        request_id: request_id.to_string(),
        execution_id: execution_id.to_string(),
        method: "POST".to_string(),
        path: "/v1/responses".to_string(),
        body: json!({"model":"client-model","input":"hello"}),
    }
}

/// Two providers with an unambiguous selection order: `alpha` is listed first
/// and carries the higher priority value, so it is the initial selection under
/// either array-order or priority-descending tie-breaking. `beta` is the only
/// healthy candidate the recovery owner may hand off to.
fn local_handoff_two_provider_manifest() -> V3Config05ManifestPublished {
    let authoring = parse_v3_config_02_authoring(
        r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"
[servers.test.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]

[providers.alpha]
type = "responses"
base_url = "http://alpha.invalid/v1"
default_model = "alpha-model"
auth = { type = "api_key", entries = [{ alias = "key", env = "ALPHA_KEY" }] }
[providers.alpha.models.alpha-model]
wire_name = "wire-alpha"
[providers.alpha.health]
enabled = true
failure_threshold = 3
cooldown_ms = 900000

[providers.beta]
type = "responses"
base_url = "http://beta.invalid/v1"
default_model = "beta-model"
auth = { type = "api_key", entries = [{ alias = "key", env = "BETA_KEY" }] }
[providers.beta.models.beta-model]
wire_name = "wire-beta"
[providers.beta.health]
enabled = true
failure_threshold = 3
cooldown_ms = 900000

[forwarders.responses]
model = "client-model"
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "alpha", model = "alpha-model", key = "key", priority = 2 },
  { kind = "provider_model", provider = "beta", model = "beta-model", key = "key", priority = 1 }
]

[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "responses", priority = 1 }]
"#,
    )
    .unwrap();
    compile_v3_config_05_manifest(authoring).unwrap()
}

#[test]
fn direct_local_construction_sources_map_to_provider_local_failure() {
    let cases = [
        V3ProviderError::InvalidBaseUrl {
            request_id: "req-local".to_string(),
            provider_id: "openai".to_string(),
            reason: "invalid base url".to_string(),
        },
        V3ProviderError::MissingAuthSecret {
            request_id: "req-local".to_string(),
            provider_id: "openai".to_string(),
            auth_alias: "key1".to_string(),
        },
        V3ProviderError::AuthSecretRead {
            request_id: "req-local".to_string(),
            provider_id: "openai".to_string(),
            auth_alias: "key1".to_string(),
            reason: "secret read failed".to_string(),
        },
    ];
    for error in cases {
        let source = crate::hooks::build_v3_provider_error_source(
            "V3Transport13ResponsesHttpRequest",
            error,
        );
        assert_eq!(source.source_kind, V3ErrorSourceKind::ProviderLocalFailure);
        assert_eq!(source.code, "provider_local_runtime_error");
        assert!(
            source.internal_error.is_some(),
            "provider-local failure keeps an internal diagnostic code"
        );
        assert!(
            source.external_error.is_none(),
            "provider-local failure never carries an external error link"
        );
        assert!(
            is_direct_recoverable_provider_failure_source(&source),
            "Direct must treat provider-local failures as recoverable provider sources"
        );
    }
}

struct LocalConstructionFailsFirstThenSucceeds {
    sends: AtomicUsize,
    sent_providers: std::sync::Mutex<Vec<String>>,
}

#[async_trait]
impl ResponsesTransport for LocalConstructionFailsFirstThenSucceeds {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.sent_providers
            .lock()
            .unwrap()
            .push(request.provider_id().to_string());
        if self.sends.fetch_add(1, Ordering::SeqCst) == 0 {
            return Err(V3ProviderError::InvalidBaseUrl {
                request_id: request.request_id().to_string(),
                provider_id: request.provider_id().to_string(),
                reason: "frozen local base-url construction failure".to_string(),
            });
        }
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            br#"{"id":"resp_local_handoff","output_text":"ok"}"#.to_vec(),
        ))
    }
}

#[tokio::test]
async fn direct_local_construction_failure_reselects_healthy_candidate() {
    let routing_group = "direct_local_handoff_reselect";
    let manifest = local_handoff_manifest(local_handoff_two_provider_manifest(), routing_group);
    let provider_health =
        V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let raw = local_handoff_raw(routing_group, "req-local-reselect", "exec-local-reselect");
    let plan = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        raw.clone(),
        provider_health.clone(),
        0,
    )
    .expect("local handoff reselect plan");
    let transport = LocalConstructionFailsFirstThenSucceeds {
        sends: AtomicUsize::new(0),
        sent_providers: std::sync::Mutex::new(Vec::new()),
    };
    let output = execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::new()
            .with_provider_health(provider_health)
            .with_initial_plan(&plan),
        &manifest,
        raw,
        crate::register_responses_direct_hooks(),
        &transport,
    )
    .await;

    assert_eq!(output.client_payload.status, 200, "{output:?}");
    assert_eq!(
        transport.sends.load(Ordering::SeqCst),
        2,
        "local construction failure must reselect exactly one healthy candidate"
    );
    assert_eq!(
        transport.sent_providers.lock().unwrap().as_slice(),
        &["alpha".to_string(), "beta".to_string()],
        "the failed initial provider must be excluded and the healthy candidate reselected"
    );
    assert!(output.node_trace.contains(&"V3TargetLocalReselected"));
    let observability = output
        .observability
        .as_ref()
        .expect("Direct must expose provider failure observability");
    assert_eq!(observability.provider_failure_events.len(), 1);
    let event = &observability.provider_failure_events[0];
    assert_eq!(
        event.error_type.as_deref(),
        Some("provider_local_runtime_error")
    );
    assert!(
        event.internal_code.is_some(),
        "recovery observation keeps the provider-local internal diagnostic"
    );
    assert_eq!(
        event.external_error_status, None,
        "provider-local failure has no external HTTP witness"
    );
    assert_eq!(
        event.next_provider_key.as_deref(),
        Some("beta:key:beta-model"),
        "recovery must hand off to the healthy candidate"
    );
}

struct AlwaysLocalConstructionFailure {
    sends: AtomicUsize,
}

#[async_trait]
impl ResponsesTransport for AlwaysLocalConstructionFailure {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.sends.fetch_add(1, Ordering::SeqCst);
        Err(V3ProviderError::MissingAuthSecret {
            request_id: request.request_id().to_string(),
            provider_id: request.provider_id().to_string(),
            auth_alias: "key1".to_string(),
        })
    }
}

#[tokio::test]
async fn direct_local_construction_exhaustion_keeps_internal_598_without_client_error() {
    let routing_group = "direct_local_handoff_exhausted";
    let manifest = local_handoff_manifest(test_manifest(), routing_group);
    let provider_health =
        V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest);
    let raw = local_handoff_raw(routing_group, "req-local-exhausted", "exec-local-exhausted");
    let plan = plan_v3_responses_protocol_execution_with_provider_health(
        &manifest,
        raw.clone(),
        provider_health.clone(),
        0,
    )
    .expect("local handoff exhaustion plan");
    let transport = AlwaysLocalConstructionFailure {
        sends: AtomicUsize::new(0),
    };
    let output = execute_v3_responses_direct_runtime_kernel_core(
        V3ResponsesDirectRuntimeCoreState::new()
            .with_provider_health(provider_health)
            .with_initial_plan(&plan),
        &manifest,
        raw,
        crate::register_responses_direct_hooks(),
        &transport,
    )
    .await;

    assert_eq!(output.client_payload.status, 598, "{output:?}");
    assert_eq!(
        output.terminal_disposition,
        Some(V3ProviderTerminalDisposition::NoResponse),
        "provider-local exhaustion must terminate the transport without an error response"
    );
    assert_eq!(transport.sends.load(Ordering::SeqCst), 1);
    assert!(!output.node_trace.contains(&"V3TargetLocalReselected"));
    let body = match &output.client_payload.body {
        V3ClientBody::Json(value) => value.clone(),
        other => panic!("expected json client body, got {other:?}"),
    };
    assert_eq!(body["error"]["code"], "provider_local_runtime_error");
    assert_ne!(
        body["error"]["code"], "network_error",
        "provider-local exhaustion must not become a provider pool-exhausted projection"
    );
}

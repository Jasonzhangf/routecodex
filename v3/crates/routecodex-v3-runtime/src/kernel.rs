use crate::hooks::V3HookRegistry;
use crate::nodes::*;
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_debug::{V3DebugError, V3DebugRuntime};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3Error01SourceRaised, V3ErrorActionScope, V3ErrorSourceKind,
    V3_ERROR_CHAIN_NODE_IDS,
};
use routecodex_v3_provider_responses::{
    ReqwestResponsesTransport, ResponsesTransport, V3ProviderAvailabilityProjection,
    V3ProviderAvailabilityReader, V3ProviderAvailabilityRegistry,
};
use routecodex_v3_target::{V3TargetCandidate, V3TargetInterpreter};
use routecodex_v3_virtual_router::V3VirtualRouter;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone)]
pub struct V3ResponsesDirectRuntimeOutput {
    pub client_payload: V3Resp15ClientPayload,
    pub node_trace: Vec<&'static str>,
    pub error_chain: Option<Vec<&'static str>>,
}

pub async fn execute_v3_responses_direct_runtime_kernel_with_default_transport(
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    hook_registry: V3HookRegistry,
) -> V3ResponsesDirectRuntimeOutput {
    execute_v3_responses_direct_runtime_kernel(
        manifest,
        raw,
        hook_registry,
        &ReqwestResponsesTransport::default(),
    )
    .await
}

pub async fn execute_v3_responses_direct_runtime_kernel_with_default_transport_and_debug(
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    hook_registry: V3HookRegistry,
    debug: &V3DebugRuntime,
) -> V3ResponsesDirectRuntimeOutput {
    let scope = match debug.start_trace(&raw.server_id, &raw.request_id, &raw.execution_id) {
        Ok(scope) => scope,
        Err(error) => {
            return debug_error_output("V3Debug01TraceContextStarted", error, &hook_registry)
        }
    };
    if let Err(error) = debug.capture_raw_request(&scope, raw.body.clone()) {
        return debug_error_output("V3Debug02RawRequestCaptured", error, &hook_registry);
    }

    let output = execute_v3_responses_direct_runtime_kernel_with_default_transport(
        manifest,
        raw,
        hook_registry,
    )
    .await;

    for node_id in &output.node_trace {
        if let Err(error) = debug.record_node_event(
            &scope,
            *node_id,
            "executed",
            output
                .error_chain
                .as_ref()
                .map(|chain| json!({"error_chain": chain})),
        ) {
            return debug_error_output("V3Debug01NodeEventRegistered", error, &hook_registry);
        }
    }
    if let Err(error) =
        debug.capture_raw_response(&scope, client_payload_debug_value(&output.client_payload))
    {
        return debug_error_output("V3Debug03RawResponseCaptured", error, &hook_registry);
    }
    output
}

pub async fn execute_v3_responses_direct_runtime_kernel<T: ResponsesTransport>(
    manifest: &V3Config05ManifestPublished,
    raw: V3Server03HttpRequestRaw,
    hook_registry: V3HookRegistry,
    transport: &T,
) -> V3ResponsesDirectRuntimeOutput {
    let mut trace = vec!["V3Config05ManifestPublished", "V3Server03HttpRequestRaw"];
    require_static_hooks(&hook_registry);

    let standardized = build_v3_req_04_standardized_responses_from_v3_server_03(raw);
    trace.push("V3Req04StandardizedResponses");

    let router = V3VirtualRouter::default();
    let classified = match router.classify_request(
        manifest,
        &standardized.protocol_context.server_id,
        &standardized.protocol_context.endpoint,
    ) {
        Ok(value) => value,
        Err(error) => {
            return error_output(
                runtime_source("V3Router05RequestClassified", error),
                trace,
                &hook_registry,
            )
        }
    };
    trace.push("V3Router05RequestClassified");
    let pool = match router.resolve_default_pool(manifest, classified) {
        Ok(value) => value,
        Err(error) => {
            return error_output(
                runtime_source("V3Router06RoutePoolResolved", error),
                trace,
                &hook_registry,
            )
        }
    };
    trace.push("V3Router06RoutePoolResolved");
    let hit = match router.hit_opaque_target_once(pool, 0) {
        Ok(value) => value,
        Err(error) => {
            return error_output(
                runtime_source("V3Router07OpaqueTargetHitOnce", error),
                trace,
                &hook_registry,
            )
        }
    };
    trace.push("V3Router07OpaqueTargetHitOnce");
    let target = V3TargetInterpreter::default();
    let kind = target.classify_kind(hit);
    trace.push("V3Target08KindClassified");
    let expanded = match target.expand_candidates(manifest, kind, 0) {
        Ok(value) => value,
        Err(error) => {
            return error_output(
                runtime_source("V3Target09CandidateSetExpanded", error),
                trace,
                &hook_registry,
            )
        }
    };
    trace.push("V3Target09CandidateSetExpanded");
    let availability = V3ProviderAvailabilityRegistry::from_manifest(manifest);
    let mut failed_candidates = BTreeSet::new();
    loop {
        let attempt_availability = V3RuntimeAttemptAvailability {
            base: &availability,
            failed_candidates: &failed_candidates,
        };
        let selected = match target.select_available(expanded.clone(), &attempt_availability, 0) {
            Ok(value) => value,
            Err(error) => {
                return error_output(
                    build_v3_error_01_source_raised(
                        V3ErrorSourceKind::TargetPoolExhausted,
                        "V3Target10ConcreteProviderSelected",
                        "selected_target_exhausted",
                        format!(
                            "{} candidates unavailable",
                            error.attempted_candidates.len()
                        ),
                    ),
                    trace,
                    &hook_registry,
                )
            }
        };
        trace.push("V3Target10ConcreteProviderSelected");

        let provider_scope = V3ErrorActionScope::ProviderInstance {
            provider_id: selected.candidate.provider_id.clone(),
        };
        let failed_key = candidate_key(&selected.candidate);
        let policy = hook_registry.run_route(selected, &standardized);
        trace.push("V3ResponsesDirect11Policy");

        let wire = match hook_registry.run_request_projection(&policy) {
            Ok(value) => value,
            Err(source) => return error_output(source, trace, &hook_registry),
        };
        trace.push("V3Provider12ResponsesWirePayload");

        let transport_request = match hook_registry.run_provider_transport(wire) {
            Ok(value) => value,
            Err(source) => return error_output(source, trace, &hook_registry),
        };
        trace.push("V3Transport13ResponsesHttpRequest");

        let provider_raw = match transport.send(transport_request).await {
            Ok(raw) => raw,
            Err(error) => {
                failed_candidates.insert(failed_key);
                let remaining = remaining_available_candidates(
                    &expanded.candidates,
                    &availability,
                    &failed_candidates,
                );
                let projected = hook_registry.run_error(
                    build_v3_error_01_source_raised(
                        V3ErrorSourceKind::ProviderFailure,
                        "V3Transport13ResponsesHttpRequest",
                        "provider_transport_error",
                        error.to_string(),
                    ),
                    provider_scope,
                    remaining,
                );
                trace.extend(V3_ERROR_CHAIN_NODE_IDS);
                if projected
                    .body
                    .pointer("/error/decision")
                    .and_then(Value::as_str)
                    == Some("target_local_reselect")
                {
                    trace.push("V3TargetLocalReselected");
                    continue;
                }
                return projected_error_output(projected, trace);
            }
        };
        trace.push("V3ProviderResp14Raw");

        let payload = match hook_registry.run_response_projection(provider_raw).await {
            Ok(payload) => payload,
            Err(source) => return error_output(source, trace, &hook_registry),
        };
        trace.push("V3Resp15ClientPayload");

        return V3ResponsesDirectRuntimeOutput {
            client_payload: payload,
            node_trace: trace,
            error_chain: None,
        };
    }
}

fn runtime_source(stage: &'static str, error: impl std::fmt::Display) -> V3Error01SourceRaised {
    build_v3_error_01_source_raised(
        V3ErrorSourceKind::RuntimeFailure,
        stage,
        "v3_route_target_runtime_failure",
        error.to_string(),
    )
}

fn error_output(
    source: V3Error01SourceRaised,
    node_trace: Vec<&'static str>,
    hook_registry: &V3HookRegistry,
) -> V3ResponsesDirectRuntimeOutput {
    let projected = hook_registry.run_error(source, V3ErrorActionScope::None, 0);
    projected_error_output(projected, node_trace)
}

fn projected_error_output(
    projected: routecodex_v3_error::V3Error06ClientProjected,
    node_trace: Vec<&'static str>,
) -> V3ResponsesDirectRuntimeOutput {
    V3ResponsesDirectRuntimeOutput {
        client_payload: V3Resp15ClientPayload {
            status: projected.status,
            headers: BTreeMap::from([("content-type".to_string(), "application/json".to_string())]),
            body: V3ClientBody::Json(projected.body),
        },
        node_trace,
        error_chain: Some(projected.chain.to_vec()),
    }
}

fn debug_error_output(
    stage: &'static str,
    error: V3DebugError,
    hook_registry: &V3HookRegistry,
) -> V3ResponsesDirectRuntimeOutput {
    error_output(
        build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            stage,
            "v3_debug_failure",
            error.to_string(),
        ),
        vec![stage],
        hook_registry,
    )
}

fn client_payload_debug_value(payload: &V3Resp15ClientPayload) -> Value {
    match &payload.body {
        V3ClientBody::Json(value) => value.clone(),
        V3ClientBody::Bytes(bytes) => json!({
            "body_kind": "bytes",
            "byte_len": bytes.len()
        }),
    }
}

struct V3RuntimeAttemptAvailability<'a, R> {
    base: &'a R,
    failed_candidates: &'a BTreeSet<String>,
}

impl<R: V3ProviderAvailabilityReader> V3ProviderAvailabilityReader
    for V3RuntimeAttemptAvailability<'_, R>
{
    fn availability(
        &self,
        provider_id: &str,
        auth_alias: Option<&str>,
        model_id: Option<&str>,
        now_ms: u64,
    ) -> V3ProviderAvailabilityProjection {
        let mut projection = self
            .base
            .availability(provider_id, auth_alias, model_id, now_ms);
        let key = availability_key(provider_id, auth_alias, model_id);
        if self.failed_candidates.contains(&key) {
            projection.available = false;
            projection
                .blocked_scopes
                .push(format!("request_failed:{key}"));
        }
        projection
    }
}

fn candidate_key(candidate: &V3TargetCandidate) -> String {
    availability_key(
        &candidate.provider_id,
        Some(&candidate.auth_alias),
        Some(&candidate.model_id),
    )
}

fn availability_key(provider_id: &str, auth_alias: Option<&str>, model_id: Option<&str>) -> String {
    format!(
        "{}:{}:{}",
        provider_id,
        auth_alias.unwrap_or(""),
        model_id.unwrap_or("")
    )
}

fn remaining_available_candidates<R: V3ProviderAvailabilityReader>(
    candidates: &[V3TargetCandidate],
    availability: &R,
    failed_candidates: &BTreeSet<String>,
) -> usize {
    let attempt_availability = V3RuntimeAttemptAvailability {
        base: availability,
        failed_candidates,
    };
    candidates
        .iter()
        .filter(|candidate| {
            attempt_availability
                .availability(
                    &candidate.provider_id,
                    Some(&candidate.auth_alias),
                    Some(&candidate.model_id),
                    0,
                )
                .available
        })
        .count()
}

fn require_static_hooks(hook_registry: &V3HookRegistry) {
    for hook in [
        "ResponsesDirectRouteHook",
        "ResponsesDirectRequestProjectionHook",
        "ResponsesDirectProviderTransportHook",
        "ResponsesDirectResponseProjectionHook",
        "ResponsesDirectErrorHook",
    ] {
        assert!(
            hook_registry.require_hook(hook),
            "missing static hook {hook}"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use routecodex_v3_config::*;
    use routecodex_v3_provider_responses::{
        V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
        V3Transport13ResponsesHttpRequest,
    };
    use serde_json::json;

    struct CaptureTransport;

    #[async_trait]
    impl ResponsesTransport for CaptureTransport {
        async fn send(
            &self,
            request: V3Transport13ResponsesHttpRequest,
        ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
            assert_eq!(request.body(), &json!({"model":"gpt-test","input":"hello"}));
            Ok(V3ProviderResp14Raw::from_json(
                request.request_id(),
                request.provider_id(),
                200,
                vec![V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"application/json".to_vec(),
                }],
                br#"{"id":"resp_test","output_text":"ok"}"#.to_vec(),
            ))
        }
    }

    #[tokio::test]
    async fn runtime_executes_adjacent_responses_direct_chain() {
        let output = execute_v3_responses_direct_runtime_kernel(
            &test_manifest(),
            V3Server03HttpRequestRaw {
                server_id: "test".to_string(),
                request_id: "req".to_string(),
                execution_id: "exec".to_string(),
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                body: json!({"model":"client-model","input":"hello"}),
            },
            crate::register_responses_direct_hooks(),
            &CaptureTransport,
        )
        .await;
        assert_eq!(output.client_payload.status, 200);
        assert_eq!(
            output.client_payload.body,
            V3ClientBody::Json(json!({"id":"resp_test","output_text":"ok"}))
        );
        assert_eq!(
            output.node_trace,
            vec![
                "V3Config05ManifestPublished",
                "V3Server03HttpRequestRaw",
                "V3Req04StandardizedResponses",
                "V3Router05RequestClassified",
                "V3Router06RoutePoolResolved",
                "V3Router07OpaqueTargetHitOnce",
                "V3Target08KindClassified",
                "V3Target09CandidateSetExpanded",
                "V3Target10ConcreteProviderSelected",
                "V3ResponsesDirect11Policy",
                "V3Provider12ResponsesWirePayload",
                "V3Transport13ResponsesHttpRequest",
                "V3ProviderResp14Raw",
                "V3Resp15ClientPayload",
            ]
        );
    }

    #[tokio::test]
    async fn provider_error_enters_error_chain_not_success() {
        struct ErrorTransport;
        #[async_trait]
        impl ResponsesTransport for ErrorTransport {
            async fn send(
                &self,
                request: V3Transport13ResponsesHttpRequest,
            ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
                Err(V3ProviderError::Transport {
                    request_id: request.request_id().to_string(),
                    provider_id: request.provider_id().to_string(),
                    reason: "boom".to_string(),
                })
            }
        }
        let output = execute_v3_responses_direct_runtime_kernel(
            &test_manifest(),
            V3Server03HttpRequestRaw {
                server_id: "test".to_string(),
                request_id: "req".to_string(),
                execution_id: "exec".to_string(),
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                body: json!({"model":"client-model","input":"hello"}),
            },
            crate::register_responses_direct_hooks(),
            &ErrorTransport,
        )
        .await;
        assert_eq!(output.client_payload.status, 502);
        assert_eq!(output.error_chain.unwrap()[0], "V3Error01SourceRaised");
        match output.client_payload.body {
            V3ClientBody::Json(body) => {
                assert!(body["error"]["message"].as_str().unwrap().contains("boom"))
            }
            V3ClientBody::Bytes(_) => panic!("error response must be JSON"),
        }
    }

    #[tokio::test]
    async fn provider_failure_reselects_without_router_reentry() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        struct FirstFailsSecondSucceeds {
            sends: AtomicUsize,
        }

        #[async_trait]
        impl ResponsesTransport for FirstFailsSecondSucceeds {
            async fn send(
                &self,
                request: V3Transport13ResponsesHttpRequest,
            ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
                if self.sends.fetch_add(1, Ordering::SeqCst) == 0 {
                    return Err(V3ProviderError::Transport {
                        request_id: request.request_id().to_string(),
                        provider_id: request.provider_id().to_string(),
                        reason: "first failed".to_string(),
                    });
                }
                assert_eq!(request.provider_id(), "second");
                assert_eq!(request.body()["model"], "wire-second");
                Ok(V3ProviderResp14Raw::from_json(
                    request.request_id(),
                    request.provider_id(),
                    200,
                    vec![V3ProviderResponseHeader {
                        name: "content-type".to_string(),
                        value: b"application/json".to_vec(),
                    }],
                    br#"{"id":"resp_second","output_text":"ok"}"#.to_vec(),
                ))
            }
        }

        let transport = FirstFailsSecondSucceeds {
            sends: AtomicUsize::new(0),
        };
        let output = execute_v3_responses_direct_runtime_kernel(
            &reselection_manifest(),
            V3Server03HttpRequestRaw {
                server_id: "test".to_string(),
                request_id: "req".to_string(),
                execution_id: "exec".to_string(),
                method: "POST".to_string(),
                path: "/v1/responses".to_string(),
                body: json!({"model":"client-model","input":"hello"}),
            },
            crate::register_responses_direct_hooks(),
            &transport,
        )
        .await;

        assert_eq!(output.client_payload.status, 200, "{output:?}");
        assert_eq!(transport.sends.load(Ordering::SeqCst), 2);
        assert_eq!(
            output
                .node_trace
                .iter()
                .filter(|node| **node == "V3Router07OpaqueTargetHitOnce")
                .count(),
            1
        );
        assert!(output.node_trace.contains(&"V3TargetLocalReselected"));
    }

    fn test_manifest() -> V3Config05ManifestPublished {
        let authoring = parse_v3_config_02_authoring(
            r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"

[providers.openai]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "ROUTECODEX_V3_TEST_KEY" }] }

[providers.openai.models.gpt-test]
supports_streaming = true

[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "openai", model = "gpt-test", priority = 1 }]
"#,
        )
        .unwrap();
        compile_v3_config_05_manifest(authoring).unwrap()
    }

    fn reselection_manifest() -> V3Config05ManifestPublished {
        let authoring = parse_v3_config_02_authoring(
            r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"

[providers.first]
type = "responses"
base_url = "http://first.invalid/v1"
default_model = "test"
auth = { type = "api_key", entries = [{ alias = "key", env = "FIRST_KEY" }] }
[providers.first.models.test]
wire_name = "wire-first"

[providers.second]
type = "responses"
base_url = "http://second.invalid/v1"
default_model = "test"
auth = { type = "api_key", entries = [{ alias = "key", env = "SECOND_KEY" }] }
[providers.second.models.test]
wire_name = "wire-second"

[forwarders.responses]
model = "test"
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "first", model = "test", key = "key", priority = 1 },
  { kind = "provider_model", provider = "second", model = "test", key = "key", priority = 2 }
]

[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "responses", priority = 1 }]
"#,
        )
        .unwrap();
        compile_v3_config_05_manifest(authoring).unwrap()
    }
}

use crate::hooks::V3HookRegistry;
use crate::nodes::*;
use routecodex_v3_config::V3Config05ManifestPublished;
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3Error01SourceRaised, V3ErrorSourceKind,
};
use routecodex_v3_provider_responses::{ReqwestResponsesTransport, ResponsesTransport};
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub struct V3ResponsesDirectRuntimeOutput {
    pub client_payload: V3Resp10ClientPayload,
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

    let selected = match hook_registry.run_route(manifest, &standardized) {
        Ok(selected) => selected,
        Err(source) => return error_output(source, trace, &hook_registry),
    };
    trace.push("V3Route05SelectedTarget");

    let policy = build_v3_responses_direct_06_policy_from_v3_route_05(selected, &standardized);
    trace.push("V3ResponsesDirect06Policy");

    let wire = hook_registry.run_request_projection(&policy);
    trace.push("V3Provider07ResponsesWirePayload");

    let transport_request = hook_registry.run_provider_transport(wire);
    trace.push("V3Transport08ResponsesHttpRequest");

    let provider_raw = match transport.send(transport_request).await {
        Ok(raw) => raw,
        Err(error) => {
            return error_output(
                build_v3_error_01_source_raised(
                    V3ErrorSourceKind::ProviderFailure,
                    "V3Transport08ResponsesHttpRequest",
                    "provider_transport_error",
                    error.to_string(),
                ),
                trace,
                &hook_registry,
            )
        }
    };
    trace.push("V3ProviderResp09Raw");

    let payload = match hook_registry.run_response_projection(provider_raw) {
        Ok(payload) => payload,
        Err(source) => return error_output(source, trace, &hook_registry),
    };
    trace.push("V3Resp10ClientPayload");

    V3ResponsesDirectRuntimeOutput {
        client_payload: payload,
        node_trace: trace,
        error_chain: None,
    }
}

fn error_output(
    source: V3Error01SourceRaised,
    node_trace: Vec<&'static str>,
    hook_registry: &V3HookRegistry,
) -> V3ResponsesDirectRuntimeOutput {
    let projected = hook_registry.run_error(source);
    V3ResponsesDirectRuntimeOutput {
        client_payload: V3Resp10ClientPayload {
            status: projected.status,
            headers: BTreeMap::from([("content-type".to_string(), "application/json".to_string())]),
            body: V3ClientBody::Json(projected.body),
        },
        node_trace,
        error_chain: Some(projected.chain.to_vec()),
    }
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
        V3ProviderError, V3ProviderResp09Raw, V3Transport08ResponsesHttpRequest,
    };
    use serde_json::json;

    struct CaptureTransport;

    #[async_trait]
    impl ResponsesTransport for CaptureTransport {
        async fn send(
            &self,
            request: V3Transport08ResponsesHttpRequest,
        ) -> Result<V3ProviderResp09Raw, V3ProviderError> {
            assert_eq!(
                request.body,
                json!({"model":"client-model","input":"hello"})
            );
            Ok(V3ProviderResp09Raw {
                provider_id: request.provider_id,
                status: 200,
                headers: BTreeMap::from([(
                    "content-type".to_string(),
                    "application/json".to_string(),
                )]),
                body: br#"{"id":"resp_test","output_text":"ok"}"#.to_vec(),
            })
        }
    }

    #[tokio::test]
    async fn runtime_executes_adjacent_responses_direct_chain() {
        let output = execute_v3_responses_direct_runtime_kernel(
            &test_manifest(),
            V3Server03HttpRequestRaw {
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
                "V3Route05SelectedTarget",
                "V3ResponsesDirect06Policy",
                "V3Provider07ResponsesWirePayload",
                "V3Transport08ResponsesHttpRequest",
                "V3ProviderResp09Raw",
                "V3Resp10ClientPayload",
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
                _request: V3Transport08ResponsesHttpRequest,
            ) -> Result<V3ProviderResp09Raw, V3ProviderError> {
                Err(V3ProviderError::Transport("boom".to_string()))
            }
        }
        let output = execute_v3_responses_direct_runtime_kernel(
            &test_manifest(),
            V3Server03HttpRequestRaw {
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
}

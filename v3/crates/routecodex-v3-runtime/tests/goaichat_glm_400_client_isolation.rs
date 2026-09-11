//! White-box contract for sample RID
//! `openai-responses-router-gpt-5.5-20260906T075643453-51980-3718`.
//!
//! Authoritative goal (m1788710112409-56): after goaichat glm HTTP 400
//! `invalid_request` / content-required, keep that error on the internal
//! observability/error path, switch immediately to the next available sibling
//! model, and continue the original request. The client must never receive
//! HTTP 400 or a wrapped 502. Cooldown/ProbeSuccess is not a pass criterion.
//! Do not rewrite payload to guess a missing content field.

use async_trait::async_trait;
use futures_util::StreamExt;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderHttpFailure, V3ProviderResp14Raw,
    V3ProviderResponseHeader, V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    execute_v3_responses_relay_runtime, V3ResponsesRelayClientBody, V3ResponsesRelayRuntimeInput,
    V3ResponsesRelayRuntimeOutput,
};
use serde_json::{json, Value};
use std::sync::Mutex;

const SAMPLE_RID: &str = "openai-responses-router-gpt-5.5-20260906T075643453-51980-3718";
const SAMPLE_INPUT: &str = "original-request-must-continue-unchanged";
const GLM_400_BODY: &str =
    include_str!("../../../fixtures/goaichat-glm-400-client-isolation/provider-400.json");

fn glm_400_wire_body() -> Vec<u8> {
    let fixture: Value = serde_json::from_str(GLM_400_BODY).expect("fixture json");
    serde_json::to_vec(&fixture["exact_provider_400_body"]).expect("400 body")
}

fn goaichat_sibling_manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.g400iso]
bind = "127.0.0.1"
port = 5555
routing_group = "g400iso"
endpoints = ["responses"]
[servers.g400iso.execution]
allowed_modes = ["relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }
attempt_store = {}
[providers.goaichat]
type = "responses"
base_url = "http://goaichat.invalid/v1"
default_model = "glm-5.3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "LIMITED_KEY" }] }
[providers.goaichat.models."glm-5.3"]
wire_name = "glm-5.3"
supports_streaming = true
supports_thinking = true
max_context_tokens = 200000
capabilities = ["text", "tools", "reasoning"]
[providers.goaichat.models."qwen3.8-max"]
wire_name = "qwen3.8-max"
supports_streaming = true
supports_thinking = true
max_context_tokens = 200000
capabilities = ["text", "tools", "reasoning"]
[route_groups.g400iso.pools.client_responses]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "responses", models = ["client-responses"] }
targets = [
  { kind = "provider_model", provider = "goaichat", model = "glm-5.3", key = "key1", priority = 2 },
  { kind = "provider_model", provider = "goaichat", model = "qwen3.8-max", key = "key1", priority = 1 }
]
[route_groups.g400iso.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "goaichat", model = "glm-5.3", key = "key1", priority = 2 },
  { kind = "provider_model", provider = "goaichat", model = "qwen3.8-max", key = "key1", priority = 1 }
]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}

struct Glm400ThenQwen200Transport {
    captures: Mutex<Vec<(String, Value)>>,
}

impl Glm400ThenQwen200Transport {
    fn new() -> Self {
        Self {
            captures: Mutex::new(Vec::new()),
        }
    }
}

#[async_trait]
impl ResponsesTransport for Glm400ThenQwen200Transport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.captures
            .lock()
            .unwrap()
            .push((request.provider_id().to_string(), request.body().clone()));
        let model = request
            .body()
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("");
        if model == "glm-5.3" {
            return Err(V3ProviderError::HttpStatus {
                response: Box::new(V3ProviderHttpFailure {
                    request_id: request.request_id().to_string(),
                    provider_id: request.provider_id().to_string(),
                    status: 400,
                    headers: vec![],
                    body: glm_400_wire_body(),
                    body_read_failure: None,
                }),
            });
        }
        assert_eq!(model, "qwen3.8-max", "next available sibling must be qwen");
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&json!({
                "id":"resp_g400_iso_qwen",
                "status":"completed",
                "output":[{"type":"output_text","text":"continued-original-request"}]
            }))
            .unwrap(),
        ))
    }
}

fn assert_client_never_400_or_502(status: u16) {
    assert_ne!(status, 400, "client must never receive provider HTTP 400");
    assert_ne!(
        status, 502,
        "client must never receive a 502 wrapper of provider HTTP 400"
    );
    assert_eq!(
        status, 200,
        "available next provider must continue the request"
    );
}

fn assert_glm_400_stayed_internal(
    output: &V3ResponsesRelayRuntimeOutput,
    transport: &Glm400ThenQwen200Transport,
) {
    assert!(
        output.error_chain.is_none(),
        "successful client closeout must not project an error_chain; 400 stays internal"
    );
    assert!(
        output.node_trace.contains(&"V3TargetLocalReselected"),
        "glm 400 must reselect immediately: {trace:?}",
        trace = output.node_trace
    );
    let observability = output
        .observability
        .as_ref()
        .expect("switch-and-continue must keep observability");
    assert_eq!(observability.provider_id.as_deref(), Some("goaichat"));
    assert_eq!(
        observability.provider_key.as_deref(),
        Some("goaichat:key1:qwen3.8-max")
    );
    assert_eq!(observability.provider_status, Some(200));
    let glm_event = observability
        .provider_failure_events
        .iter()
        .find(|event| event.provider_key == "goaichat:key1:glm-5.3")
        .expect("glm HTTP 400 must remain on internal observability");
    assert_eq!(glm_event.status, 400);
    assert_eq!(glm_event.action, "switch_provider");
    assert_eq!(
        glm_event.next_provider_key.as_deref(),
        Some("goaichat:key1:qwen3.8-max")
    );
    assert!(
        glm_event
            .error_type
            .as_deref()
            .is_some_and(|error_type| error_type.contains("invalid_request")
                || error_type.contains("invalid_parameter")),
        "sample error_type must stay on the internal event, got {:?}",
        glm_event.error_type
    );
    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 2);
    assert_eq!(captures[0].0, "goaichat");
    assert_eq!(captures[0].1["model"], "glm-5.3");
    assert_eq!(captures[1].0, "goaichat");
    assert_eq!(captures[1].1["model"], "qwen3.8-max");
    assert_eq!(
        captures[0].1.get("input"),
        captures[1].1.get("input"),
        "original request must continue without payload rewrite"
    );
    let input_text = captures[0].1["input"].to_string();
    assert!(
        input_text.contains(SAMPLE_INPUT),
        "normalized provider input must keep the original request text: {input_text}"
    );
}

async fn run_isolation(stream: bool) -> V3ResponsesRelayRuntimeOutput {
    let transport = Glm400ThenQwen200Transport::new();
    let output = execute_v3_responses_relay_runtime(
        &goaichat_sibling_manifest(),
        V3ResponsesRelayRuntimeInput {
            server_id: "g400iso".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: format!("{SAMPLE_RID}:stream={stream}"),
            payload: json!({
                "model":"client-responses",
                "input": SAMPLE_INPUT,
                "stream": stream
            }),
        },
        &transport,
    )
    .await
    .unwrap();
    assert_client_never_400_or_502(output.status);
    assert_glm_400_stayed_internal(&output, &transport);
    output
}

#[tokio::test]
async fn goaichat_glm_http400_switches_sibling_model_client_never_400_or_502_json() {
    let output = run_isolation(false).await;
    match output.client_body {
        V3ResponsesRelayClientBody::Json(body) => {
            assert!(
                body.get("error").is_none(),
                "client JSON must not wrap the glm 400: {body}"
            );
            assert_eq!(body["status"], "completed");
        }
        V3ResponsesRelayClientBody::Sse(_) => panic!("JSON request must project JSON body"),
    }
}

#[tokio::test]
async fn goaichat_glm_http400_switches_sibling_model_client_never_400_or_502_sse() {
    let output = run_isolation(true).await;
    match output.client_body {
        V3ResponsesRelayClientBody::Sse(mut stream) => {
            let mut forwarded = Vec::new();
            while let Some(chunk) = stream.next().await {
                forwarded.extend(chunk);
            }
            let text = String::from_utf8(forwarded).unwrap();
            assert!(
                !text.contains("\"status\":400") && !text.contains("HTTP 400"),
                "client SSE must not surface glm 400: {text}"
            );
            assert!(
                !text.contains("network_error") && !text.contains("\"status\":502"),
                "client SSE must not wrap glm 400 as 502: {text}"
            );
            assert!(text.contains("continued-original-request"));
        }
        V3ResponsesRelayClientBody::Json(_) => panic!("SSE request must project SSE stream"),
    }
}

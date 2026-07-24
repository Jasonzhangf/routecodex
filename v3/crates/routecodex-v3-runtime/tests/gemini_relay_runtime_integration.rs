use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderHttpFailure, V3ProviderResp14Raw,
    V3ProviderResponseHeader, V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    execute_v3_gemini_relay_runtime, V3GeminiRelayClientBody, V3GeminiRelayRuntimeInput,
};
use serde_json::{json, Value};
use std::sync::Mutex;

#[path = "../../../tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
use hub_v1_fixture::{hub_v1_server_execution, hub_v1_test_declaration};

struct JsonTransport {
    captured_url: Mutex<Option<String>>,
    captured_body: Mutex<Option<Value>>,
}

struct StaticJsonTransport {
    provider_body: Value,
}

#[async_trait]
impl ResponsesTransport for JsonTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        *self.captured_url.lock().unwrap() = Some(request.url().to_string());
        *self.captured_body.lock().unwrap() = Some(request.body().clone());
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&json!({
                "candidates":[{
                    "index":0,
                    "finishReason":"STOP",
                    "content":{"role":"model","parts":[{"text":"controlled json"}]}
                }],
                "usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}
            }))
            .unwrap(),
        ))
    }
}

#[async_trait]
impl ResponsesTransport for StaticJsonTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&self.provider_body).unwrap(),
        ))
    }
}

#[tokio::test]
async fn json_runtime_executes_one_hub_lifecycle_and_preserves_gemini_semantics() {
    let transport = JsonTransport {
        captured_url: Mutex::new(None),
        captured_body: Mutex::new(None),
    };
    let payload = json!({
        "contents":[{"role":"user","parts":[{"text":"hello"}]}],
        "tools":[{"functionDeclarations":[{"name":"lookup","parameters":{"type":"object"}}]}],
        "generationConfig":{"temperature":0.2},
        "stream":false
    });
    let output = execute_v3_gemini_relay_runtime(
        &manifest(),
        V3GeminiRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-json".into(),
            endpoint_path: "/v1beta/models/gemini-client/generateContent".into(),
            payload: payload.clone(),
        },
        &transport,
    )
    .await
    .unwrap();

    assert_eq!(
        transport.captured_url.lock().unwrap().as_deref(),
        Some("http://controlled.invalid/v1beta/models/gemini-wire/generateContent")
    );
    let captured = transport.captured_body.lock().unwrap().clone().unwrap();
    assert_eq!(captured, payload);
    assert!(captured.get("metadata_center").is_none());
    assert_eq!(output.status, 200);
    assert_eq!(output.node_trace.len(), 17);
    assert_eq!(output.node_trace[0], "V3HubReqInbound01ClientRaw");
    assert!(output
        .node_trace
        .contains(&"ProviderReqCompat06ProviderCompat"));
    assert!(output
        .node_trace
        .contains(&"ProviderRespCompat02ProviderCompat"));
    assert_eq!(output.node_trace[16], "V3ServerRespOutbound06ClientFrame");
    let client_response = match output.client_body {
        V3GeminiRelayClientBody::Json(value) => value,
        V3GeminiRelayClientBody::Sse(_) => panic!("expected JSON client body"),
    };
    assert_eq!(
        client_response["candidates"][0]["content"]["parts"][0]["text"],
        "controlled json"
    );
    assert_eq!(client_response["usageMetadata"]["totalTokenCount"], 5);
}

#[tokio::test]
async fn json_function_call_governance_preserves_gemini_name_mapping() {
    let transport = StaticJsonTransport {
        provider_body: json!({
            "candidates":[{
                "index":0,
                "finishReason":"STOP",
                "content":{"role":"model","parts":[{
                    "functionCall":{"name":"lookup_weather","args":{"city":"Paris"}}
                }]}
            }]
        }),
    };
    let output = execute_v3_gemini_relay_runtime(
        &manifest(),
        V3GeminiRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-function-call".into(),
            endpoint_path: "/v1beta/models/gemini-client/generateContent".into(),
            payload: json!({
                "contents":[{"role":"user","parts":[{"text":"weather"}]}],
                "stream":false
            }),
        },
        &transport,
    )
    .await
    .unwrap();
    let client_response = match output.client_body {
        V3GeminiRelayClientBody::Json(value) => value,
        V3GeminiRelayClientBody::Sse(_) => panic!("expected JSON client body"),
    };
    assert_eq!(
        client_response["candidates"][0]["content"]["parts"][0]["functionCall"]["name"],
        "lookup_weather"
    );
}

struct ErrorTransport;

#[async_trait]
impl ResponsesTransport for ErrorTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        Err(V3ProviderError::HttpStatus {
            response: Box::new(V3ProviderHttpFailure {
                request_id: request.request_id().to_string(),
                provider_id: request.provider_id().to_string(),
                status: 429,
                headers: vec![],
                body: br#"{"error":{"code":429,"message":"controlled rate limit","status":"RESOURCE_EXHAUSTED"}}"#
                    .to_vec(),
            }),
        })
    }
}

struct ReselectTransport {
    provider_ids: Mutex<Vec<String>>,
}

#[async_trait]
impl ResponsesTransport for ReselectTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let provider_id = request.provider_id().to_string();
        self.provider_ids.lock().unwrap().push(provider_id.clone());
        if provider_id == "primary" {
            return Err(V3ProviderError::HttpStatus {
                response: Box::new(V3ProviderHttpFailure {
                    request_id: request.request_id().to_string(),
                    provider_id,
                    status: 500,
                    headers: vec![],
                    body:
                        br#"{"error":{"code":500,"message":"primary failed","status":"INTERNAL"}}"#
                            .to_vec(),
                }),
            });
        }
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id().to_string(),
            provider_id,
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&json!({
                "candidates":[{
                    "index":0,
                    "finishReason":"STOP",
                    "content":{"role":"model","parts":[{"text":"secondary success"}]}
                }]
            }))
            .unwrap(),
        ))
    }
}

#[tokio::test]
async fn provider_http_failure_reselects_next_candidate_before_client_projection() {
    let transport = ReselectTransport {
        provider_ids: Mutex::new(Vec::new()),
    };
    let output = execute_v3_gemini_relay_runtime(
        &manifest_with_two_providers(),
        V3GeminiRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-provider-reselect".into(),
            endpoint_path: "/v1beta/models/gemini-client/generateContent".into(),
            payload: json!({
                "contents":[{"role":"user","parts":[{"text":"use the available provider"}]}],
                "stream":false
            }),
        },
        &transport,
    )
    .await
    .unwrap();

    assert_eq!(
        transport.provider_ids.lock().unwrap().as_slice(),
        ["primary", "secondary"]
    );
    assert_eq!(output.status, 200);
    assert!(output.node_trace.contains(&"V3TargetLocalReselected"));
    assert!(output.error_chain.is_none());
    let client_response = match output.client_body {
        V3GeminiRelayClientBody::Json(value) => value,
        V3GeminiRelayClientBody::Sse(_) => panic!("expected JSON client body"),
    };
    assert_eq!(
        client_response["candidates"][0]["content"]["parts"][0]["text"],
        "secondary success"
    );
    assert!(
        !client_response.to_string().contains("primary failed"),
        "failed candidate error must not be projected while another candidate succeeds"
    );
}

struct MalformedErrorTransport;

#[async_trait]
impl ResponsesTransport for MalformedErrorTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        Err(V3ProviderError::HttpStatus {
            response: Box::new(V3ProviderHttpFailure {
                request_id: request.request_id().to_string(),
                provider_id: request.provider_id().to_string(),
                status: 502,
                headers: vec![],
                body: b"not-json".to_vec(),
            }),
        })
    }
}

#[tokio::test]
async fn provider_error_enters_error01_06_without_success_projection() {
    let output = execute_v3_gemini_relay_runtime(
        &manifest(),
        V3GeminiRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-error".into(),
            endpoint_path: "/v1beta/models/gemini-client/generateContent".into(),
            payload: json!({
                "contents":[{"role":"user","parts":[{"text":"fail"}]}],
                "stream":false
            }),
        },
        &ErrorTransport,
    )
    .await
    .unwrap();
    assert_eq!(output.status, 429);
    let client_response = match output.client_body {
        V3GeminiRelayClientBody::Json(value) => value,
        V3GeminiRelayClientBody::Sse(_) => panic!("expected JSON error body"),
    };
    assert_eq!(client_response["error"]["message"], "controlled rate limit");
    assert_eq!(client_response["error"]["code"], "RESOURCE_EXHAUSTED");
    assert_eq!(
        client_response["error"]["stage"],
        "V3ProviderReqOutbound09TransportRequest"
    );
    assert_eq!(client_response["error"]["class"], "provider_failure");
    assert_eq!(
        client_response["error"]["error_node"],
        "V3Error06ClientProjected"
    );
    assert!(
        client_response["error"].get("status").is_none(),
        "provider raw Gemini status must not bypass ErrorErr06 projection: {client_response}"
    );
    assert_eq!(output.error_chain.as_ref().unwrap().len(), 6);
    assert!(!output.node_trace.contains(&"V3ProviderRespInbound01Raw"));
    assert_eq!(output.node_trace.last(), Some(&"V3Error06ClientProjected"));
}

#[tokio::test]
async fn malformed_provider_error_body_projects_explicit_error_not_fallback() {
    let output = execute_v3_gemini_relay_runtime(
        &manifest(),
        V3GeminiRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-malformed-error".into(),
            endpoint_path: "/v1beta/models/gemini-client/generateContent".into(),
            payload: json!({
                "contents":[{"role":"user","parts":[{"text":"malformed error"}]}],
                "stream":false
            }),
        },
        &MalformedErrorTransport,
    )
    .await
    .unwrap();
    assert_eq!(output.status, 502);
    let client_response = match output.client_body {
        V3GeminiRelayClientBody::Json(value) => value,
        V3GeminiRelayClientBody::Sse(_) => panic!("expected JSON error body"),
    };
    assert_eq!(
        client_response["error"]["code"],
        "provider_error_body_malformed"
    );
    assert_eq!(output.error_chain.as_ref().unwrap().len(), 6);
}

type ControlledSseReceiver = tokio::sync::mpsc::Receiver<Result<Vec<u8>, V3ProviderError>>;

struct ControlledSseTransport {
    receiver: Mutex<Option<ControlledSseReceiver>>,
}

struct StaticSseTransport {
    chunks: Mutex<Option<Vec<Vec<u8>>>>,
}

#[async_trait]
impl ResponsesTransport for ControlledSseTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let receiver = self.receiver.lock().unwrap().take().unwrap();
        let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
            receiver.recv().await.map(|item| (item, receiver))
        });
        Ok(V3ProviderResp14Raw::from_sse(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(stream),
        ))
    }
}

#[async_trait]
impl ResponsesTransport for StaticSseTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let chunks = self.chunks.lock().unwrap().take().unwrap();
        Ok(V3ProviderResp14Raw::from_sse(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"text/event-stream".to_vec(),
            }],
            Box::pin(futures_util::stream::iter(chunks.into_iter().map(Ok))),
        ))
    }
}

#[tokio::test]
async fn sse_runtime_enters_response_chat_process_and_preserves_thought_signature() {
    use futures_util::StreamExt;
    let transport = StaticSseTransport {
        chunks: Mutex::new(Some(vec![br#"data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"thought":true,"text":"hidden plan","thoughtSignature":"sig-1"},{"text":"visible"}]},"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":11}}

"#
        .to_vec()])),
    };
    let output = execute_v3_gemini_relay_runtime(
        &manifest(),
        V3GeminiRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-sse-thought-chain".into(),
            endpoint_path: "/v1beta/models/gemini-client/generateContent".into(),
            payload: json!({
                "contents":[{"role":"user","parts":[{"text":"stream thought"}]}],
                "stream":true
            }),
        },
        &transport,
    )
    .await
    .unwrap();
    assert_eq!(output.status, 200);
    assert_eq!(
        &output.node_trace[10..],
        &[
            "V3ProviderRespInbound01Raw",
            "ProviderRespCompat02ProviderCompat",
            "V3HubRespInbound02Normalized",
            "V3HubRespChatProcess03Governed",
            "V3HubRespContinuation04Committed",
            "V3HubRespOutbound05ClientSemantic",
            "V3ServerRespOutbound06ClientFrame"
        ],
        "native Gemini SSE must enter the same response chain as JSON before client projection"
    );
    let stream = match output.client_body {
        V3GeminiRelayClientBody::Sse(stream) => stream,
        V3GeminiRelayClientBody::Json(_) => panic!("expected SSE client body"),
    };
    let events = stream.collect::<Vec<_>>().await;
    assert_eq!(events.len(), 1);
    let event = String::from_utf8(events.into_iter().next().unwrap().unwrap()).unwrap();
    let payload: Value = serde_json::from_str(event.trim_start_matches("data: ").trim()).unwrap();
    let part = &payload["candidates"][0]["content"]["parts"][0];
    assert_eq!(part["thought"], true);
    assert_eq!(part["text"], "hidden plan");
    assert_eq!(part["thoughtSignature"], "sig-1");
    assert_eq!(
        payload["candidates"][0]["content"]["parts"][1]["text"],
        "visible"
    );
}

#[tokio::test]
async fn sse_runtime_emits_first_gemini_event_before_provider_terminal_without_materializing() {
    use futures_util::StreamExt;
    let (sender, receiver) = tokio::sync::mpsc::channel(2);
    sender
        .send(Ok(br#"data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"first"}]},"finishReason":null}]}

"#
        .to_vec()))
        .await
        .unwrap();
    let transport = ControlledSseTransport {
        receiver: Mutex::new(Some(receiver)),
    };
    let output = execute_v3_gemini_relay_runtime(
        &manifest(),
        V3GeminiRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-sse".into(),
            endpoint_path: "/v1beta/models/gemini-client/generateContent".into(),
            payload: json!({
                "contents":[{"role":"user","parts":[{"text":"stream"}]}],
                "stream":true
            }),
        },
        &transport,
    )
    .await
    .unwrap();
    assert_eq!(output.status, 200);
    let mut stream = match output.client_body {
        V3GeminiRelayClientBody::Sse(stream) => stream,
        V3GeminiRelayClientBody::Json(_) => panic!("expected SSE client body"),
    };
    let first = tokio::time::timeout(std::time::Duration::from_millis(100), stream.next())
        .await
        .expect("first Gemini SSE frame must not wait for terminal")
        .unwrap()
        .unwrap();
    assert!(String::from_utf8(first).unwrap().contains("first"));
    sender
        .send(Ok(br#"data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"done"}]},"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":9}}

"#
        .to_vec()))
        .await
        .unwrap();
    drop(sender);
    let remaining = stream.collect::<Vec<_>>().await;
    assert_eq!(remaining.len(), 1);
    let terminal = String::from_utf8(remaining.into_iter().next().unwrap().unwrap()).unwrap();
    assert!(terminal.contains("\"finishReason\":\"STOP\""));
    assert!(!terminal.contains("[DONE]"));
}

#[tokio::test]
async fn malformed_non_terminal_and_post_terminal_sse_fail_explicitly() {
    let cases = [
        (
            vec![b"data: not-json\n\n".to_vec()],
            "expected",
            "malformed SSE JSON must fail before client success",
        ),
        (
            vec![br#"data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"still running"}]},"finishReason":null}]}

"#
            .to_vec()],
            "ended without terminal finishReason",
            "SSE stream end without terminal finishReason must fail",
        ),
        (
            vec![br#"data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"done"}]},"finishReason":"STOP"}]}

data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"late"}]},"finishReason":null}]}

"#
            .to_vec()],
            "after terminal finishReason",
            "SSE frame after terminal finishReason must fail",
        ),
    ];
    for (chunks, expected, label) in cases {
        let items = collect_sse_items(chunks).await;
        assert!(
            items
                .iter()
                .any(|item| item.as_ref().is_err_and(|error| error.contains(expected))),
            "{label}: expected error containing {expected}, got {items:?}"
        );
    }
}

#[tokio::test]
async fn response_side_channel_is_rejected_for_json_and_sse_before_client_success() {
    let json_output = execute_v3_gemini_relay_runtime(
        &manifest(),
        V3GeminiRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-json-response-isolation".into(),
            endpoint_path: "/v1beta/models/gemini-client/generateContent".into(),
            payload: json!({
                "contents":[{"role":"user","parts":[{"text":"json leak"}]}],
                "stream":false
            }),
        },
        &StaticJsonTransport {
            provider_body: json!({
                "metadata_center":{"route":"must-not-leak"},
                "candidates":[{
                    "index":0,
                    "finishReason":"STOP",
                    "content":{"role":"model","parts":[{"text":"hidden"}]}
                }]
            }),
        },
    )
    .await
    .unwrap();
    assert_eq!(json_output.status, 502);
    assert_eq!(json_output.error_chain.as_ref().unwrap().len(), 6);
    let json_client_response = match json_output.client_body {
        V3GeminiRelayClientBody::Json(value) => value,
        V3GeminiRelayClientBody::Sse(_) => panic!("expected JSON error body"),
    };
    assert!(
        json_client_response.to_string().contains("metadata_center"),
        "provider response side-channel rejection must be visible in terminal error body: {json_client_response}"
    );
    assert!(
        !json_client_response.to_string().contains("hidden"),
        "side-channel-contaminated provider response must not be projected as client success"
    );

    let items = collect_sse_items(vec![br#"data: {"metadata_center":{"route":"must-not-leak"},"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"hidden"}]},"finishReason":"STOP"}]}

"#
    .to_vec()])
    .await;
    assert!(
        items.iter().any(|item| item
            .as_ref()
            .is_err_and(|error| error.contains("metadata_center"))),
        "SSE side-channel leak must be rejected before client success, got {items:?}"
    );
    assert!(
        items
            .iter()
            .all(|item| item.as_ref().is_err() || !item.as_ref().unwrap().contains("hidden")),
        "SSE side-channel payload must not be projected as a client success"
    );
}

#[tokio::test]
async fn side_channel_request_fails_before_provider_send() {
    let transport = JsonTransport {
        captured_url: Mutex::new(None),
        captured_body: Mutex::new(None),
    };
    let error = execute_v3_gemini_relay_runtime(
        &manifest(),
        V3GeminiRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-isolation".into(),
            endpoint_path: "/v1beta/models/gemini-client/generateContent".into(),
            payload: json!({
                "contents":[{"role":"user","parts":[{"text":"leak"}]}],
                "metadata_center":{"route":"must-not-leak"}
            }),
        },
        &transport,
    )
    .await
    .unwrap_err();
    assert!(error.to_string().contains("metadata_center"));
    assert!(transport.captured_body.lock().unwrap().is_none());
}

#[tokio::test]
async fn non_gemini_route_target_fails_before_provider_send() {
    let transport = JsonTransport {
        captured_url: Mutex::new(None),
        captured_body: Mutex::new(None),
    };
    let error = execute_v3_gemini_relay_runtime(
        &manifest_with_provider_type("openai_chat"),
        V3GeminiRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-non-gemini-target".into(),
            endpoint_path: "/v1beta/models/gemini-client/generateContent".into(),
            payload: json!({
                "contents":[{"role":"user","parts":[{"text":"must not hit OpenAI target"}]}],
                "stream":false
            }),
        },
        &transport,
    )
    .await
    .expect_err("non-Gemini provider target must fail before transport");

    assert!(
        error
            .to_string()
            .contains("no compatible Gemini provider target"),
        "{error:?}"
    );
    assert!(transport.captured_url.lock().unwrap().is_none());
    assert!(transport.captured_body.lock().unwrap().is_none());
}

async fn collect_sse_items(chunks: Vec<Vec<u8>>) -> Vec<Result<String, String>> {
    use futures_util::StreamExt;
    let transport = StaticSseTransport {
        chunks: Mutex::new(Some(chunks)),
    };
    let output = execute_v3_gemini_relay_runtime(
        &manifest(),
        V3GeminiRelayRuntimeInput {
            server_id: "controlled".into(),
            request_id: "req-sse-negative".into(),
            endpoint_path: "/v1beta/models/gemini-client/generateContent".into(),
            payload: json!({
                "contents":[{"role":"user","parts":[{"text":"invalid stream"}]}],
                "stream":true
            }),
        },
        &transport,
    )
    .await
    .unwrap();
    let stream = match output.client_body {
        V3GeminiRelayClientBody::Sse(stream) => stream,
        V3GeminiRelayClientBody::Json(_) => panic!("expected SSE client body"),
    };
    stream
        .map(|item| item.map(|bytes| String::from_utf8(bytes).unwrap()))
        .collect::<Vec<_>>()
        .await
}

fn manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
    manifest_with_provider_type("gemini")
}

fn manifest_with_two_providers() -> routecodex_v3_config::V3Config05ManifestPublished {
    let source = format!(
        r#"
version = 3

{hub_v1_declaration}

[servers.controlled]
bind = "127.0.0.1"
port = 1
routing_group = "controlled"
endpoints = ["gemini"]

{server_execution}

[providers.primary]
type = "gemini"
base_url = "http://primary.invalid/v1beta"
default_model = "gemini-wire"
auth = {{ type = "api_key", entries = [{{ alias = "primary", env = "V3_GEMINI_PRIMARY_KEY" }}] }}
[providers.primary.models.gemini-wire]
wire_name = "gemini-wire"
aliases = ["gemini-client"]
supports_streaming = true
capabilities = ["text", "tools"]

[providers.secondary]
type = "gemini"
base_url = "http://secondary.invalid/v1beta"
default_model = "gemini-wire"
auth = {{ type = "api_key", entries = [{{ alias = "secondary", env = "V3_GEMINI_SECONDARY_KEY" }}] }}
[providers.secondary.models.gemini-wire]
wire_name = "gemini-wire"
aliases = ["gemini-client"]
supports_streaming = true
capabilities = ["text", "tools"]

[route_groups.controlled.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "primary", model = "gemini-wire", key = "primary", priority = 1 }},
  {{ kind = "provider_model", provider = "secondary", model = "gemini-wire", key = "secondary", priority = 2 }}
]
"#,
        hub_v1_declaration = hub_v1_test_declaration(),
        server_execution = hub_v1_server_execution("controlled"),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn manifest_with_provider_type(
    provider_type: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let source = format!(
        r#"
version = 3

{hub_v1_declaration}

[servers.controlled]
bind = "127.0.0.1"
port = 1
routing_group = "controlled"
endpoints = ["gemini"]

{server_execution}

[providers.controlled]
type = "{provider_type}"
base_url = "http://controlled.invalid/v1beta"
default_model = "gemini-wire"
auth = {{ type = "api_key", entries = [{{ alias = "controlled", env = "V3_GEMINI_CONTROLLED_KEY" }}] }}
[providers.controlled.models.gemini-wire]
wire_name = "gemini-wire"
aliases = ["gemini-client"]
supports_streaming = true
capabilities = ["text", "tools"]
[route_groups.controlled.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "controlled", model = "gemini-wire", key = "controlled", priority = 1 }}]
"#,
        hub_v1_declaration = hub_v1_test_declaration(),
        server_execution = hub_v1_server_execution("controlled"),
        provider_type = provider_type,
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

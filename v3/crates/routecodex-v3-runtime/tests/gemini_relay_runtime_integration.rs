use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderAvailabilityReader, V3ProviderError, V3ProviderHttpFailure,
    V3ProviderResp14Raw, V3ProviderResponseHeader, V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    execute_v3_gemini_relay_runtime, execute_v3_gemini_relay_runtime_with_provider_health,
    V3GeminiRelayClientBody, V3GeminiRelayRuntimeInput, V3ResponsesRelayProviderHealthHandle,
};
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};

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
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
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
    let mut expected_provider_payload = payload;
    expected_provider_payload["model"] = json!("gemini-wire");
    expected_provider_payload
        .as_object_mut()
        .expect("Gemini provider payload must be object")
        .remove("stream");
    assert_eq!(captured, expected_provider_payload);
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
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
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
    let server_id = "gemini_provider_http_reselect";
    let transport = ReselectTransport {
        provider_ids: Mutex::new(Vec::new()),
    };
    let output = execute_v3_gemini_relay_runtime(
        &manifest_with_two_providers_for_scope(server_id),
        V3GeminiRelayRuntimeInput {
            server_id: server_id.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
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
    let server_id = "gemini_provider_error_projection";
    let output = execute_v3_gemini_relay_runtime(
        &manifest_for_action_gate_scope(server_id),
        V3GeminiRelayRuntimeInput {
            server_id: server_id.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
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
    let server_id = "gemini_malformed_provider_error";
    let output = execute_v3_gemini_relay_runtime(
        &manifest_for_action_gate_scope(server_id),
        V3GeminiRelayRuntimeInput {
            server_id: server_id.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
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

struct RecoverySseTransport {
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
impl ResponsesTransport for RecoverySseTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        if request.provider_id() == "primary" {
            return Err(V3ProviderError::HttpStatus {
                response: Box::new(V3ProviderHttpFailure {
                    request_id: request.request_id().to_string(),
                    provider_id: request.provider_id().to_string(),
                    status: 500,
                    headers: vec![],
                    body:
                        br#"{"error":{"code":500,"message":"primary failed","status":"INTERNAL"}}"#
                            .to_vec(),
                }),
            });
        }
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
        assert!(
            request.url().ends_with("/streamGenerateContent?alt=sse"),
            "Gemini SSE transport must use the streaming endpoint: {}",
            request.url()
        );
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
    let output = tokio::time::timeout(
        Duration::from_secs(5),
        execute_v3_gemini_relay_runtime(
            &manifest(),
            V3GeminiRelayRuntimeInput {
                server_id: "controlled".into(),
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "test-server",
                    "test-group",
                    concat!(module_path!(), ":", line!()),
                )
                .expect("test provider failure session scope"),
                request_id: "req-sse-thought-chain".into(),
                endpoint_path: "/v1beta/models/gemini-client/generateContent".into(),
                payload: json!({
                    "contents":[{"role":"user","parts":[{"text":"stream thought"}]}],
                    "stream":true
                }),
            },
            &transport,
        ),
    )
    .await
    .expect("endpoint-only Gemini SSE request must reach transport within five seconds")
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
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
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
            "gemini_sse_malformed",
            vec![b"data: not-json\n\n".to_vec()],
            "expected",
            "malformed SSE JSON must fail before client success",
        ),
        (
            "gemini_sse_eof",
            vec![br#"data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"still running"}]},"finishReason":null}]}

"#
            .to_vec()],
            "ended without terminal finishReason",
            "SSE stream end without terminal finishReason must fail",
        ),
        (
            "gemini_sse_post_terminal",
            vec![br#"data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"done"}]},"finishReason":"STOP"}]}

data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"late"}]},"finishReason":null}]}

"#
            .to_vec()],
            "after terminal finishReason",
            "SSE frame after terminal finishReason must fail",
        ),
        (
            "gemini_sse_invalid_finish_reason",
            vec![br#"data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"invalid"}]},"finishReason":7}]}

"#
            .to_vec()],
            "finishReason must be null or a non-empty string",
            "non-string Gemini finishReason must fail",
        ),
    ];
    for (scope, chunks, expected, label) in cases {
        let items = collect_sse_items(chunks, scope).await;
        assert!(
            items
                .iter()
                .any(|item| item.as_ref().is_err_and(|error| error.contains(expected))),
            "{label}: expected error containing {expected}, got {items:?}"
        );
    }
}

#[tokio::test]
async fn post_commit_sse_failure_records_failure_but_does_not_block_a_fresh_request() {
    use futures_util::StreamExt;
    let server_id = "gemini_gate_failure";
    let manifest = manifest_for_action_gate_scope(server_id);
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest);
    let cases = [
        (
            "malformed",
            vec![
                br#"data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"partial"}]},"finishReason":null}]}

"#
                .to_vec(),
                b"data: {malformed-json}\n\n".to_vec(),
            ],
        ),
        (
            "eof",
            vec![
                br#"data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"partial"}]},"finishReason":null}]}

"#
                .to_vec(),
            ],
        ),
        (
            "post-terminal",
            vec![
                br#"data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"done"}]},"finishReason":"STOP"}]}

data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"late"}]},"finishReason":null}]}

"#
                .to_vec(),
            ],
        ),
    ];
    for (case, chunks) in cases {
        let failing = StaticSseTransport {
            chunks: Mutex::new(Some(chunks)),
        };
        let first = execute_v3_gemini_relay_runtime_with_provider_health(
            &manifest,
            V3GeminiRelayRuntimeInput {
                server_id: server_id.into(),
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "test-server",
                    "test-group",
                    concat!(module_path!(), ":", line!()),
                )
                .expect("test provider failure session scope"),
                request_id: format!("req-gemini-post-commit-{case}"),
                endpoint_path: "/v1beta/models/gemini-client/generateContent".into(),
                payload: json!({
                    "contents":[{"role":"user","parts":[{"text":"stream"}]}],
                    "stream":true
                }),
            },
            &failing,
            provider_health.runtime_health(),
        )
        .await
        .expect("first provider action returns a lazy stream");
        let stream = match first.client_body {
            V3GeminiRelayClientBody::Sse(stream) => stream,
            V3GeminiRelayClientBody::Json(_) => panic!("expected SSE"),
        };
        let items = stream.collect::<Vec<_>>().await;
        assert!(
            items.iter().any(Result::is_err),
            "{case} must fail explicitly"
        );

        let succeeding = JsonTransport {
            captured_url: Mutex::new(None),
            captured_body: Mutex::new(None),
        };
        let second = execute_v3_gemini_relay_runtime_with_provider_health(
            &manifest,
            V3GeminiRelayRuntimeInput {
                server_id: server_id.into(),
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "test-server",
                    "test-group",
                    concat!(module_path!(), ":", line!()),
                )
                .expect("test provider failure session scope"),
                request_id: format!("req-gemini-after-post-commit-{case}"),
                endpoint_path: "/v1beta/models/gemini-client/generateContent".into(),
                payload: json!({
                    "contents":[{"role":"user","parts":[{"text":"next"}]}],
                    "stream":false
                }),
            },
            &succeeding,
            provider_health.runtime_health(),
        )
        .await
        .expect("second provider action");
        assert_eq!(second.status, 200);
    }
}

#[tokio::test]
async fn terminal_sse_recovery_does_not_block_a_fresh_request() {
    use futures_util::StreamExt;
    let server_id = "gemini_gate_success";
    let manifest = manifest_for_action_gate_scope(server_id);
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest);
    let failing = StaticSseTransport {
        chunks: Mutex::new(Some(vec![b"data: {malformed-json}\n\n".to_vec()])),
    };
    let failed = execute_v3_gemini_relay_runtime_with_provider_health(
        &manifest,
        V3GeminiRelayRuntimeInput {
            server_id: server_id.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-gemini-seed-active-gate".into(),
            endpoint_path: "/v1beta/models/gemini-client/generateContent".into(),
            payload: json!({
                "contents":[{"role":"user","parts":[{"text":"seed"}]}],
                "stream":true
            }),
        },
        &failing,
        provider_health.runtime_health(),
    )
    .await
    .expect("failing provider action returns a lazy stream");
    let failed_stream = match failed.client_body {
        V3GeminiRelayClientBody::Sse(stream) => stream,
        V3GeminiRelayClientBody::Json(_) => panic!("expected SSE"),
    };
    assert!(failed_stream
        .collect::<Vec<_>>()
        .await
        .iter()
        .any(Result::is_err));

    let terminal = StaticSseTransport {
        chunks: Mutex::new(Some(vec![
            br#"data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"done"}]},"finishReason":"STOP"}]}

"#
            .to_vec(),
        ])),
    };
    let successful = execute_v3_gemini_relay_runtime_with_provider_health(
        &manifest,
        V3GeminiRelayRuntimeInput {
            server_id: server_id.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-gemini-terminal-reset".into(),
            endpoint_path: "/v1beta/models/gemini-client/generateContent".into(),
            payload: json!({
                "contents":[{"role":"user","parts":[{"text":"reset"}]}],
                "stream":true
            }),
        },
        &terminal,
        provider_health.runtime_health(),
    )
    .await
    .expect("terminal provider action");
    let successful_stream = match successful.client_body {
        V3GeminiRelayClientBody::Sse(stream) => stream,
        V3GeminiRelayClientBody::Json(_) => panic!("expected SSE"),
    };

    let waiting_manifest = manifest.clone();
    let waiting_health = provider_health.runtime_health();
    let waiting_server_id = server_id.to_string();
    let waiter = tokio::spawn(async move {
        let succeeding = JsonTransport {
            captured_url: Mutex::new(None),
            captured_body: Mutex::new(None),
        };
        execute_v3_gemini_relay_runtime_with_provider_health(
            &waiting_manifest,
            V3GeminiRelayRuntimeInput {
                server_id: waiting_server_id,
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "test-server",
                    "test-group",
                    concat!(module_path!(), ":", line!()),
                )
                .expect("test provider failure session scope"),
                request_id: "req-gemini-released-by-terminal-success".into(),
                endpoint_path: "/v1beta/models/gemini-client/generateContent".into(),
                payload: json!({
                    "contents":[{"role":"user","parts":[{"text":"released"}]}],
                    "stream":false
                }),
            },
            &succeeding,
            waiting_health,
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        waiter.is_finished(),
        "fresh Gemini request consumed an unrelated Error05 recovery lane"
    );
    let fresh = waiter
        .await
        .expect("fresh Gemini request task panicked")
        .expect("fresh Gemini request failed");
    assert_eq!(fresh.status, 200);

    let items = successful_stream.collect::<Vec<_>>().await;
    assert!(items.iter().all(Result::is_ok), "{items:?}");
}

#[tokio::test]
async fn active_recovery_sse_blocks_a_second_recovery_beyond_five_seconds() {
    use futures_util::StreamExt;
    let server_id = "gemini_active_recovery";
    const FAILURE_SESSION_ID: &str = "gemini-active-recovery-session";
    let manifest = manifest_with_two_providers_for_scope(server_id);
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest);
    let (terminal_sender, terminal_receiver) = tokio::sync::mpsc::channel(2);
    terminal_sender
        .send(Ok(
            br#"data: {"candidates":[{"index":0,"content":{"role":"model","parts":[{"text":"done"}]},"finishReason":"STOP"}]}

"#
            .to_vec(),
        ))
        .await
        .unwrap();
    let first = execute_v3_gemini_relay_runtime_with_provider_health(
        &manifest,
        V3GeminiRelayRuntimeInput {
            server_id: server_id.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                FAILURE_SESSION_ID,
            )
            .expect("test provider failure session scope"),
            request_id: "req-gemini-active-recovery-stream".into(),
            endpoint_path: "/v1beta/models/gemini-client/generateContent".into(),
            payload: json!({
                "contents":[{"role":"user","parts":[{"text":"recover as a lazy stream"}]}],
                "stream":true
            }),
        },
        &RecoverySseTransport {
            receiver: Mutex::new(Some(terminal_receiver)),
        },
        provider_health.runtime_health(),
    )
    .await
    .expect("first request must reach a lazy recovery stream");
    assert!(
        first.node_trace.contains(&"V3ProviderActionGateAdmission"),
        "the controlled lazy SSE must be a recovery action"
    );
    let mut first_stream = match first.client_body {
        V3GeminiRelayClientBody::Sse(stream) => stream,
        V3GeminiRelayClientBody::Json(_) => panic!("expected SSE"),
    };
    assert!(first_stream.next().await.unwrap().is_ok());

    let waiting_manifest = manifest.clone();
    let waiting_health = provider_health.runtime_health();
    let waiter = tokio::spawn(async move {
        execute_v3_gemini_relay_runtime_with_provider_health(
            &waiting_manifest,
            V3GeminiRelayRuntimeInput {
                server_id: server_id.into(),
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "test-server",
                    "test-group",
                    FAILURE_SESSION_ID,
                )
                .expect("test provider failure session scope"),
                request_id: "req-gemini-second-recovery-action".into(),
                endpoint_path: "/v1beta/models/gemini-client/generateContent".into(),
                payload: json!({
                    "contents":[{"role":"user","parts":[{"text":"also fail then recover"}]}],
                    "stream":false
                }),
            },
            &ReselectTransport {
                provider_ids: Mutex::new(Vec::new()),
            },
            waiting_health,
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(5_200)).await;
    assert!(
        !waiter.is_finished(),
        "active recovery permit expired by wall clock before terminal success"
    );

    let success_completed_at = Instant::now();
    drop(terminal_sender);
    assert!(
        first_stream.next().await.is_none(),
        "clean EOF must finish the first Gemini recovery stream"
    );
    let released = tokio::time::timeout(Duration::from_secs(6), waiter)
        .await
        .expect("clean EOF did not release the queued Gemini recovery action")
        .expect("queued Gemini recovery task panicked")
        .expect("queued Gemini recovery action failed");
    assert_eq!(released.status, 200);
    assert!(
        released
            .node_trace
            .contains(&"V3ProviderActionGateAdmission"),
        "the competing Gemini request must also enter Error05 recovery"
    );
    assert!(
        success_completed_at.elapsed() >= Duration::from_millis(4_800),
        "terminal success must preserve the sustained five-second recovery spacing"
    );
}

#[tokio::test]
async fn lazy_sse_client_disconnect_is_health_neutral_and_never_enters_action_wait() {
    use futures_util::StreamExt;
    let server_id = "gemini_client_disconnect";
    let manifest = manifest_for_action_gate_scope(server_id);
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest);
    let (sender, receiver) = tokio::sync::mpsc::channel(1);
    sender
        .send(Err(V3ProviderError::ClientDisconnect {
            request_id: "req-gemini-client-disconnect".into(),
            provider_id: server_id.into(),
        }))
        .await
        .unwrap();
    drop(sender);
    let transport = ControlledSseTransport {
        receiver: Mutex::new(Some(receiver)),
    };
    let output = execute_v3_gemini_relay_runtime_with_provider_health(
        &manifest,
        V3GeminiRelayRuntimeInput {
            server_id: server_id.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-gemini-client-disconnect".into(),
            endpoint_path: "/v1beta/models/gemini-client/generateContent".into(),
            payload: json!({
                "contents":[{"role":"user","parts":[{"text":"disconnect"}]}],
                "stream":true
            }),
        },
        &transport,
        provider_health.runtime_health(),
    )
    .await
    .expect("client disconnect remains a lazy stream error");
    let stream = match output.client_body {
        V3GeminiRelayClientBody::Sse(stream) => stream,
        V3GeminiRelayClientBody::Json(_) => panic!("expected SSE"),
    };
    let items = stream.collect::<Vec<_>>().await;
    assert_eq!(items.len(), 1);
    assert!(items[0]
        .as_ref()
        .is_err_and(|error| error.contains("client disconnected")));

    let availability = provider_health.store().availability(
        server_id,
        Some(server_id),
        Some("gemini-wire"),
        u64::MAX,
    );
    assert!(availability.available);
    assert!(availability.blocked_scopes.is_empty());

    let succeeding = JsonTransport {
        captured_url: Mutex::new(None),
        captured_body: Mutex::new(None),
    };
    let second = tokio::time::timeout(
        Duration::from_millis(500),
        execute_v3_gemini_relay_runtime_with_provider_health(
            &manifest,
            V3GeminiRelayRuntimeInput {
                server_id: server_id.into(),
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "test-server",
                    "test-group",
                    concat!(module_path!(), ":", line!()),
                )
                .expect("test provider failure session scope"),
                request_id: "req-gemini-after-client-disconnect".into(),
                endpoint_path: "/v1beta/models/gemini-client/generateContent".into(),
                payload: json!({
                    "contents":[{"role":"user","parts":[{"text":"next"}]}],
                    "stream":false
                }),
            },
            &succeeding,
            provider_health.runtime_health(),
        ),
    )
    .await
    .expect("client disconnect entered the provider action wait gate")
    .expect("next provider action failed");
    assert_eq!(second.status, 200);
}

#[tokio::test]
async fn response_side_channel_is_rejected_for_json_and_sse_before_client_success() {
    let server_id = "gemini_json_response_side_channel";
    let json_output = execute_v3_gemini_relay_runtime(
        &manifest_for_action_gate_scope(server_id),
        V3GeminiRelayRuntimeInput {
            server_id: server_id.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
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
    .to_vec()], "gemini_sse_response_isolation")
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
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
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
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
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

async fn collect_sse_items(chunks: Vec<Vec<u8>>, server_id: &str) -> Vec<Result<String, String>> {
    use futures_util::StreamExt;
    let transport = StaticSseTransport {
        chunks: Mutex::new(Some(chunks)),
    };
    let manifest = manifest_for_action_gate_scope(server_id);
    let output = execute_v3_gemini_relay_runtime(
        &manifest,
        V3GeminiRelayRuntimeInput {
            server_id: server_id.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
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

fn manifest_for_action_gate_scope(
    scope: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let source = format!(
        r#"
version = 3

{hub_v1_declaration}

[servers.{scope}]
bind = "127.0.0.1"
port = 1
routing_group = "{scope}"
endpoints = ["gemini"]

{server_execution}

[providers.{scope}]
type = "gemini"
base_url = "http://{scope}.invalid/v1beta"
default_model = "gemini-wire"
auth = {{ type = "api_key", entries = [{{ alias = "{scope}", env = "V3_GEMINI_SCOPED_KEY" }}] }}
[providers.{scope}.models.gemini-wire]
wire_name = "gemini-wire"
aliases = ["gemini-client"]
supports_streaming = true
capabilities = ["text", "tools"]

[route_groups.{scope}.pools.gemini_client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "gemini", models = ["gemini-client"] }}
targets = [{{ kind = "provider_model", provider = "{scope}", model = "gemini-wire", key = "{scope}", priority = 1 }}]

[route_groups.{scope}.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "{scope}", model = "gemini-wire", key = "{scope}", priority = 1 }}]
"#,
        hub_v1_declaration = hub_v1_test_declaration(),
        server_execution = hub_v1_server_execution(scope),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn manifest_with_two_providers_for_scope(
    scope: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let source = format!(
        r#"
version = 3

{hub_v1_declaration}

[servers.{scope}]
bind = "127.0.0.1"
port = 1
routing_group = "{scope}"
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

[route_groups.{scope}.pools.gemini_client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "gemini", models = ["gemini-client"] }}
targets = [
  {{ kind = "provider_model", provider = "primary", model = "gemini-wire", key = "primary", priority = 1 }},
  {{ kind = "provider_model", provider = "secondary", model = "gemini-wire", key = "secondary", priority = 2 }}
]

[route_groups.{scope}.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "primary", model = "gemini-wire", key = "primary", priority = 1 }},
  {{ kind = "provider_model", provider = "secondary", model = "gemini-wire", key = "secondary", priority = 2 }}
]
"#,
        hub_v1_declaration = hub_v1_test_declaration(),
        server_execution = hub_v1_server_execution(scope),
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
[route_groups.controlled.pools.gemini_client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "gemini", models = ["gemini-client"] }}
targets = [{{ kind = "provider_model", provider = "controlled", model = "gemini-wire", key = "controlled", priority = 1 }}]
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

// E3: Gemini thinkingLevel -> reasoning.effort runtime integration (red tests).
// The Gemini relay runtime preserves thinkingConfig.thinkingLevel natively in the
// provider wire. The codec layer extracts ChatReasoningLevel semantics from the
// thinkingLevel field. These tests verify the runtime integration path.

#[tokio::test]
async fn gemini_thinking_level_high_reaches_provider_wire() {
    let transport = JsonTransport {
        captured_url: Mutex::new(None),
        captured_body: Mutex::new(None),
    };
    execute_v3_gemini_relay_runtime(
        &manifest(),
        V3GeminiRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-thinking-high".into(),
            endpoint_path: "/v1beta/models/gemini-client/generateContent".into(),
            payload: json!({
                "contents": [{"role": "user", "parts": [{"text": "think carefully"}]}],
                "generationConfig": {
                    "thinkingConfig": {
                        "thinkingLevel": "HIGH"
                    }
                },
                "stream": false
            }),
        },
        &transport,
    )
    .await
    .unwrap();

    let captured = transport.captured_body.lock().unwrap().clone().unwrap();
    let level = captured
        .pointer("/generationConfig/thinkingConfig/thinkingLevel")
        .and_then(Value::as_str);
    assert_eq!(
        level,
        Some("HIGH"),
        "provider wire must preserve thinkingLevel=HIGH"
    );
}

#[tokio::test]
async fn gemini_thinking_level_medium_reaches_provider_wire() {
    let transport = JsonTransport {
        captured_url: Mutex::new(None),
        captured_body: Mutex::new(None),
    };
    execute_v3_gemini_relay_runtime(
        &manifest(),
        V3GeminiRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-thinking-medium".into(),
            endpoint_path: "/v1beta/models/gemini-client/generateContent".into(),
            payload: json!({
                "contents": [{"role": "user", "parts": [{"text": "think"}]}],
                "generationConfig": {
                    "thinkingConfig": {
                        "thinkingLevel": "MEDIUM"
                    }
                },
                "stream": false
            }),
        },
        &transport,
    )
    .await
    .unwrap();

    let captured = transport.captured_body.lock().unwrap().clone().unwrap();
    let level = captured
        .pointer("/generationConfig/thinkingConfig/thinkingLevel")
        .and_then(Value::as_str);
    assert_eq!(
        level,
        Some("MEDIUM"),
        "provider wire must preserve thinkingLevel=MEDIUM"
    );
}

#[tokio::test]
async fn gemini_thinking_level_low_reaches_provider_wire() {
    let transport = JsonTransport {
        captured_url: Mutex::new(None),
        captured_body: Mutex::new(None),
    };
    execute_v3_gemini_relay_runtime(
        &manifest(),
        V3GeminiRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-thinking-low".into(),
            endpoint_path: "/v1beta/models/gemini-client/generateContent".into(),
            payload: json!({
                "contents": [{"role": "user", "parts": [{"text": "quick answer"}]}],
                "generationConfig": {
                    "thinkingConfig": {
                        "thinkingLevel": "LOW"
                    }
                },
                "stream": false
            }),
        },
        &transport,
    )
    .await
    .unwrap();

    let captured = transport.captured_body.lock().unwrap().clone().unwrap();
    let level = captured
        .pointer("/generationConfig/thinkingConfig/thinkingLevel")
        .and_then(Value::as_str);
    assert_eq!(
        level,
        Some("LOW"),
        "provider wire must preserve thinkingLevel=LOW"
    );
}

#[tokio::test]
async fn gemini_thinking_budget_and_include_thoughts_produce_no_reasoning_effort() {
    // includeThoughts and thinkingBudget are separate from thinkingLevel.
    // They must NOT produce a reasoning.effort field in the provider wire.
    let transport = JsonTransport {
        captured_url: Mutex::new(None),
        captured_body: Mutex::new(None),
    };
    execute_v3_gemini_relay_runtime(
        &manifest(),
        V3GeminiRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-thinking-budget".into(),
            endpoint_path: "/v1beta/models/gemini-client/generateContent".into(),
            payload: json!({
                "contents": [{"role": "user", "parts": [{"text": "think"}]}],
                "generationConfig": {
                    "thinkingConfig": {
                        "includeThoughts": true,
                        "thinkingBudget": 4096
                    }
                },
                "stream": false
            }),
        },
        &transport,
    )
    .await
    .unwrap();

    let captured = transport.captured_body.lock().unwrap().clone().unwrap();
    // The provider wire must NOT contain reasoning.effort when only includeThoughts/thinkingBudget are set
    let reasoning = captured.get("reasoning");
    assert!(reasoning.is_none() || reasoning.and_then(|r| r.get("effort")).is_none(),
        "provider wire must not contain reasoning.effort when only includeThoughts/thinkingBudget are set");
    // But thinkingConfig must be preserved in the provider wire
    let budget = captured
        .pointer("/generationConfig/thinkingConfig/thinkingBudget")
        .and_then(Value::as_u64);
    assert_eq!(
        budget,
        Some(4096),
        "thinkingBudget must be preserved in provider wire"
    );
    let include = captured
        .pointer("/generationConfig/thinkingConfig/includeThoughts")
        .and_then(Value::as_bool);
    assert_eq!(
        include,
        Some(true),
        "includeThoughts must be preserved in provider wire"
    );
}

// E3: Gemini thinkingLevel -> reasoning.effort runtime integration.

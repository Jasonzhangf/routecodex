use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderHttpFailure, V3ProviderResp14Raw,
    V3ProviderResponseHeader, V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    execute_v3_anthropic_relay_runtime,
    materialize_v3_responses_provider_sse_as_canonical_response,
    project_v3_anthropic_events_after_resp04, project_v3_responses_json_as_anthropic_events,
    project_v3_responses_json_as_anthropic_message, V3AnthropicRelayRuntimeInput,
};
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;

struct JsonTransport {
    captured: Mutex<Option<serde_json::Value>>,
}

#[async_trait]
impl ResponsesTransport for JsonTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        *self.captured.lock().unwrap() = Some(request.body().clone());
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&json!({
                "id":"resp_json_1",
                "status":"completed",
                "output":[
                    {"type":"reasoning","summary":[{"type":"summary_text","text":"Need lookup"}]},
                    {"type":"function_call","call_id":"call_json_1","name":"lookup","arguments":"{\"q\":\"alpha\"}"}
                ]
            }))
            .unwrap(),
        ))
    }
}

struct MatrixJsonTransport {
    captured: Mutex<Option<Value>>,
    response: Value,
}

#[async_trait]
impl ResponsesTransport for MatrixJsonTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        *self.captured.lock().unwrap() = Some(request.body().clone());
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&self.response).unwrap(),
        ))
    }
}

#[tokio::test]
async fn json_runtime_uses_one_fixed_hub_lifecycle_and_exact_provider_wire() {
    let scope = "anthropic_json_lifecycle";
    let transport = JsonTransport {
        captured: Mutex::new(None),
    };
    let output = execute_v3_anthropic_relay_runtime(
        &manifest(scope),
        V3AnthropicRelayRuntimeInput {
            server_id: scope.into(),
            request_id: "req-json".into(),
            payload: json!({
                "model":"claude-client-alias",
                "messages":[{"role":"user","content":"Lookup alpha"}],
                "tools":[{"name":"lookup","input_schema":{"type":"object"}}],
                "thinking":{"type":"enabled","budget_tokens":512},
                "stream":false
            }),
        },
        &transport,
    )
    .await
    .unwrap();
    assert_eq!(
        transport.captured.lock().unwrap().as_ref().unwrap(),
        &json!({
            "model":"responses-wire-model",
            "input":[{"role":"user","content":[{"type":"input_text","text":"Lookup alpha"}]}],
            "tools":[{"type":"function","name":"lookup","parameters":{"type":"object"}}],
            "reasoning":{"thinking":{"type":"enabled","budget_tokens":512}},
            "stream":false
        })
    );
    assert_eq!(output.status, 200);
    assert_eq!(output.node_trace.len(), 17, "trace={:?}", output.node_trace);
    assert_eq!(output.node_trace[0], "V3HubReqInbound01ClientRaw");
    assert!(output
        .node_trace
        .contains(&"ProviderReqCompat06ProviderCompat"));
    assert!(output
        .node_trace
        .contains(&"ProviderRespCompat02ProviderCompat"));
    assert_eq!(output.node_trace[16], "V3ServerRespOutbound06ClientFrame");
    assert_eq!(output.client_response["stop_reason"], "tool_use");
}

#[tokio::test]
async fn anthropic_responses_field_parity_request_matrix() {
    let scope = "anthropic_request_matrix";
    let transport = MatrixJsonTransport {
        captured: Mutex::new(None),
        response: json!({
            "id":"resp_request_matrix",
            "status":"completed",
            "output":[{"type":"output_text","text":"matrix ok"}],
            "usage":{"input_tokens":11,"output_tokens":7,"total_tokens":18}
        }),
    };
    let output = execute_v3_anthropic_relay_runtime(
        &manifest(scope),
        V3AnthropicRelayRuntimeInput {
            server_id: scope.into(),
            request_id: "req-anthropic-field-matrix".into(),
            payload: json!({
                "model":"claude-client-alias",
                "system":"system alpha\n\nsystem beta",
                "messages":[
                    {
                        "role":"user",
                        "content":[
                            {"type":"text","text":"Describe image"},
                            {"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="}}
                        ]
                    },
                    {
                        "role":"assistant",
                        "content":[
                            {"type":"tool_use","id":"call_lookup","name":"lookup","input":{"q":"alpha"}}
                        ]
                    },
                    {
                        "role":"user",
                        "content":[
                            {"type":"tool_result","tool_use_id":"call_lookup","content":[{"type":"text","text":"lookup result"}]}
                        ]
                    }
                ],
                "tools":[{
                    "name":"lookup",
                    "description":"Lookup docs",
                    "input_schema":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]}
                }],
                "tool_choice":{"type":"tool","name":"lookup"},
                "thinking":{"type":"enabled","budget_tokens":1024},
                "metadata":{"client":"kept"},
                "temperature":0.2,
                "top_p":0.9,
                "top_k":5,
                "max_tokens":123,
                "stop_sequences":["</stop>"],
                "stream":false
            }),
        },
        &transport,
    )
    .await
    .unwrap();
    let body = transport.captured.lock().unwrap().clone().unwrap();
    assert_eq!(body["model"], "responses-wire-model");
    assert!(body.get("instructions").is_none());
    assert_eq!(body["input"][0]["type"], "message");
    assert_eq!(body["input"][0]["role"], "system");
    assert_eq!(
        body["input"][0]["content"][0],
        json!({"type":"input_text","text":"system alpha\n\nsystem beta"})
    );
    assert_eq!(body["input"][1]["role"], "user");
    assert_eq!(
        body["input"][1]["content"][0],
        json!({"type":"input_text","text":"Describe image"})
    );
    assert_eq!(
        body["input"][1]["content"][1],
        json!({"type":"input_image","image_url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="})
    );
    assert_eq!(body["input"][2]["type"], "function_call");
    assert_eq!(body["input"][2]["call_id"], "call_lookup");
    assert_eq!(body["input"][2]["name"], "lookup");
    assert_eq!(body["input"][2]["arguments"], r#"{"q":"alpha"}"#);
    assert_eq!(body["input"][3]["type"], "function_call_output");
    assert_eq!(body["input"][3]["call_id"], "call_lookup");
    assert_eq!(body["input"][3]["output"], "lookup result");
    assert_eq!(body["tools"][0]["type"], "function");
    assert_eq!(body["tools"][0]["name"], "lookup");
    assert_eq!(body["tools"][0]["description"], "Lookup docs");
    assert_eq!(
        body["tools"][0]["parameters"],
        json!({"type":"object","properties":{"q":{"type":"string"}},"required":["q"]})
    );
    assert_eq!(
        body["tool_choice"],
        json!({"type":"function","name":"lookup"})
    );
    assert!(
        body["reasoning"].get("effort").is_none(),
        "Anthropic inbound thinking must not invent reasoning.effort: {body}"
    );
    assert_eq!(
        body["reasoning"]["thinking"],
        json!({"type":"enabled","budget_tokens":1024})
    );
    assert_eq!(body["metadata"], json!({"client":"kept"}));
    assert_eq!(body["temperature"], 0.2);
    assert_eq!(body["top_p"], 0.9);
    assert_eq!(body["top_k"], 5);
    assert_eq!(body["max_output_tokens"], 123);
    assert_eq!(body["stop"], json!(["</stop>"]));
    assert_eq!(body["stream"], false);
    assert_eq!(output.status, 200);
}

#[test]
fn anthropic_responses_field_parity_response_matrix() {
    let projected = project_v3_responses_json_as_anthropic_message(&json!({
        "id":"resp_response_matrix",
        "model":"responses-wire-model",
        "status":"completed",
        "output":[
            {"type":"reasoning","summary":[
                {"type":"summary_text","text":"first thought"},
                {"type":"summary_text","text":"second thought"}
            ]},
            {"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]},
            {"type":"output_text","text":" world"},
            {"type":"function_call","call_id":"call_lookup","name":"lookup","arguments":"{\"q\":\"beta\"}"},
            {"type":"custom_tool_call","call_id":"call_raw","name":"exec","input":"raw script"}
        ],
        "usage":{"input_tokens":13,"output_tokens":8,"total_tokens":21}
    }))
    .unwrap();
    assert_eq!(projected["id"], "msg_response_matrix");
    assert_eq!(projected["model"], "responses-wire-model");
    assert_eq!(projected["role"], "assistant");
    assert_eq!(projected["stop_reason"], "tool_use");
    assert_eq!(projected["usage"]["input_tokens"], 13);
    assert_eq!(projected["usage"]["output_tokens"], 8);
    assert_eq!(projected["usage"]["total_tokens"], 21);
    assert_eq!(
        projected["content"],
        json!([
            {"type":"thinking","thinking":"first thought\n\nsecond thought"},
            {"type":"text","text":"hello"},
            {"type":"text","text":" world"},
            {"type":"tool_use","id":"call_lookup","name":"lookup","input":{"q":"beta"}},
            {"type":"tool_use","id":"call_raw","name":"exec","input":{"input":"raw script"}}
        ])
    );
}

#[test]
fn anthropic_responses_field_parity_rejects_malformed_function_arguments() {
    let error = project_v3_responses_json_as_anthropic_message(&json!({
        "id":"resp_bad_args",
        "status":"completed",
        "output":[
            {"type":"function_call","call_id":"call_bad","name":"lookup","arguments":"{\"q\":"}
        ]
    }))
    .unwrap_err();
    assert!(
        error.to_string().contains("function_call arguments"),
        "unexpected error: {error}"
    );
}

#[test]
fn json_projection_accepts_live_responses_message_output_text_shape() {
    let projected = project_v3_responses_json_as_anthropic_message(&json!({
        "id":"resp_live_text",
        "status":"completed",
        "output":[{
            "type":"message",
            "role":"assistant",
            "content":[{
                "type":"output_text",
                "text":"V3_COMPAT_ANTHROPIC_JSON_OK"
            }]
        }]
    }))
    .unwrap();
    assert_eq!(projected["content"][0]["type"], "text");
    assert_eq!(
        projected["content"][0]["text"],
        "V3_COMPAT_ANTHROPIC_JSON_OK"
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
                body: br#"{"error":{"type":"rate_limit_error","message":"controlled rate limit"}}"#
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
                    body: br#"{"error":{"type":"server_error","message":"primary failed"}}"#
                        .to_vec(),
                }),
            });
        }
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            provider_id,
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&json!({
                "id":"resp_reselect",
                "status":"completed",
                "output":[{"type":"output_text","text":"secondary success"}]
            }))
            .unwrap(),
        ))
    }
}

#[tokio::test]
async fn provider_http_failure_reselects_next_candidate_before_client_projection() {
    let scope = "anthropic_provider_reselect";
    let transport = ReselectTransport {
        provider_ids: Mutex::new(Vec::new()),
    };
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        execute_v3_anthropic_relay_runtime(
            &manifest_with_two_providers(scope),
            V3AnthropicRelayRuntimeInput {
                server_id: scope.into(),
                request_id: "req-provider-reselect".into(),
                payload: json!({
                    "model":"claude-client-alias",
                    "messages":[{"role":"user","content":"use the available provider"}],
                    "stream":false
                }),
            },
            &transport,
        ),
    )
    .await
    .unwrap_or_else(|_| {
        panic!(
            "provider reselect remained blocked after 30s; sends={:?}",
            transport.provider_ids.lock().unwrap().as_slice()
        )
    })
    .unwrap();

    assert_eq!(
        transport.provider_ids.lock().unwrap().as_slice(),
        ["primary", "secondary"]
    );
    assert_eq!(output.status, 200);
    assert!(output.node_trace.contains(&"V3TargetLocalReselected"));
    assert!(output.error_chain.is_none());
    assert_eq!(
        output.client_response["content"][0]["text"],
        "secondary success"
    );
    assert!(
        !output
            .client_response
            .to_string()
            .contains("primary failed"),
        "failed candidate error must not be projected while another candidate succeeds"
    );
}

#[tokio::test]
async fn provider_error_enters_error01_06_without_success_projection() {
    let scope = "anthropic_provider_terminal";
    let output = execute_v3_anthropic_relay_runtime(
        &manifest(scope),
        V3AnthropicRelayRuntimeInput {
            server_id: scope.into(),
            request_id: "req-error".into(),
            payload: json!({"model":"claude-client-alias","messages":[{"role":"user","content":"fail"}],"stream":false}),
        },
        &ErrorTransport,
    )
    .await
    .unwrap();
    assert_eq!(output.status, 429);
    assert_eq!(
        output.client_response["error"]["message"],
        "controlled rate limit"
    );
    assert_eq!(output.client_response["error"]["code"], "rate_limit_error");
    assert_eq!(
        output.client_response["error"]["stage"],
        "V3ProviderReqOutbound09TransportRequest"
    );
    assert_eq!(output.client_response["error"]["class"], "provider_failure");
    assert_eq!(
        output.client_response["error"]["error_node"],
        "V3Error06ClientProjected"
    );
    assert!(
        output.client_response["error"].get("type").is_none(),
        "provider raw Anthropic error body must not bypass ErrorErr06 projection: {}",
        output.client_response
    );
    assert_eq!(output.error_chain.as_ref().unwrap().len(), 6);
    assert!(!output.node_trace.contains(&"V3ProviderRespInbound01Raw"));
    assert_eq!(output.node_trace.last(), Some(&"V3Error06ClientProjected"));
}

#[tokio::test]
async fn sse_projection_accepts_live_data_only_text_delta_frames() {
    let stream = futures_util::stream::iter([
        Ok(br#"data: {"type":"response.created","response":{"id":"resp_live_sse","status":"in_progress"}}

"#
        .to_vec()),
        Ok(br#"data: {"type":"response.output_item.added","item":{"type":"message","id":"msg_live","role":"assistant","content":[]}}

"#
        .to_vec()),
        Ok(br#"data: {"type":"response.content_part.added","part":{"type":"output_text","text":""}}

"#
        .to_vec()),
        Ok(br#"data: {"type":"response.output_text.delta","delta":"V3_COMPAT_"}

"#
        .to_vec()),
        Ok(br#"data: {"type":"response.output_text.delta","delta":"ANTHROPIC_SSE_OK"}

"#
        .to_vec()),
        Ok(br#"data: {"type":"response.output_text.done","text":"V3_COMPAT_ANTHROPIC_SSE_OK"}

"#
        .to_vec()),
        Ok(br#"data: {"type":"response.completed","response":{"id":"resp_live_sse","status":"completed"}}

"#
        .to_vec()),
        Ok(b"data: [DONE]\n\n".to_vec()),
    ]);
    let canonical_response =
        materialize_v3_responses_provider_sse_as_canonical_response(Box::pin(stream))
            .await
            .unwrap();
    assert_eq!(canonical_response["output"][0]["type"], "message");
    assert_eq!(canonical_response["output"][1]["type"], "output_text");
    assert_eq!(
        canonical_response["output"][1]["text"],
        "V3_COMPAT_ANTHROPIC_SSE_OK"
    );
    let client_events = project_v3_responses_json_as_anthropic_events(&canonical_response).unwrap();
    assert!(client_events.iter().any(|event| {
        event
            .pointer("/data/delta/text")
            .and_then(|value| value.as_str())
            == Some("V3_COMPAT_ANTHROPIC_SSE_OK")
    }));
    assert_eq!(client_events.last().unwrap()["event"], "message_stop");
}

#[tokio::test]
async fn structured_sse_contract_preserves_reasoning_tool_and_terminal_order() {
    let stream = futures_util::stream::iter([
        Ok(b"event: response.reasoning_summary_text.delta\ndata: {\"output_index\":0,\"item_id\":\"rs_1\",\"summary_index\":0,\"delta\":\"Need\"}\n\n".to_vec()),
        Ok(b"event: response.reasoning_summary_text.delta\ndata: {\"output_index\":0,\"item_id\":\"rs_1\",\"summary_index\":0,\"delta\":\" beta\"}\n\n".to_vec()),
        Ok(b"event: response.output_item.added\ndata: {\"item\":{\"type\":\"function_call\",\"call_id\":\"call_sse_1\",\"name\":\"lookup\",\"arguments\":\"\"}}\n\n".to_vec()),
        Ok(b"event: response.function_call_arguments.delta\ndata: {\"delta\":\"{\\\"q\\\":\\\"beta\\\"}\"}\n\n".to_vec()),
        Ok(b"event: response.completed\ndata: {\"response\":{\"id\":\"resp_sse_1\",\"status\":\"completed\"}}\n\n".to_vec()),
    ]);
    let canonical_response =
        materialize_v3_responses_provider_sse_as_canonical_response(Box::pin(stream))
            .await
            .unwrap();
    assert_eq!(canonical_response["output"].as_array().unwrap().len(), 2);
    let client_events = project_v3_responses_json_as_anthropic_events(&canonical_response).unwrap();
    let client = project_v3_anthropic_events_after_resp04(client_events);
    let events = client["events"].as_array().unwrap();
    let reasoning_starts = events
        .iter()
        .filter(|event| {
            event["event"] == "content_block_start"
                && event["data"]["content_block"]["type"] == "thinking"
        })
        .collect::<Vec<_>>();
    let reasoning_deltas = events
        .iter()
        .filter(|event| event["data"]["delta"]["type"] == "thinking_delta")
        .collect::<Vec<_>>();
    let reasoning_stops = events
        .iter()
        .filter(|event| {
            event["event"] == "content_block_stop" && event["data"]["index"] == json!(0)
        })
        .collect::<Vec<_>>();
    assert_eq!(reasoning_starts.len(), 1);
    assert_eq!(reasoning_deltas.len(), 1);
    assert!(reasoning_deltas
        .iter()
        .all(|event| event["data"]["index"] == json!(0)));
    assert_eq!(
        reasoning_deltas[0]["data"]["delta"]["thinking"],
        "Need beta"
    );
    assert_eq!(reasoning_stops.len(), 1);
    assert_eq!(events.last().unwrap()["event"], "message_stop");
}

struct ResponsesThinkingSseTransport;

#[async_trait]
impl ResponsesTransport for ResponsesThinkingSseTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let stream = futures_util::stream::iter([
            Ok(br#"event: response.created
data: {"type":"response.created","response":{"id":"resp_thinking_sse","status":"in_progress","output":[]}}

"#
            .to_vec()),
            Ok(br#"event: response.reasoning_summary_text.delta
data: {"type":"response.reasoning_summary_text.delta","output_index":0,"item_id":"rs_thinking","summary_index":0,"delta":"signed thought"}

"#
            .to_vec()),
            Ok(br#"event: response.completed
data: {"type":"response.completed","response":{"id":"resp_thinking_sse","status":"completed","output":[{"type":"reasoning","id":"rs_thinking","summary":[{"type":"summary_text","text":"signed thought"}],"encrypted_content":"resp04-signature"}]}}

"#
            .to_vec()),
            Ok(b"data: [DONE]\n\n".to_vec()),
        ]);
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

struct ResponsesThinkingSseWithoutTerminalTransport;

#[async_trait]
impl ResponsesTransport for ResponsesThinkingSseWithoutTerminalTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let stream = futures_util::stream::iter([
            Ok(br#"event: response.created
data: {"type":"response.created","response":{"id":"resp_thinking_no_terminal","status":"in_progress","output":[]}}

"#
            .to_vec()),
            Ok(br#"event: response.reasoning_summary_text.delta
data: {"type":"response.reasoning_summary_text.delta","output_index":0,"item_id":"rs_thinking","summary_index":0,"delta":"must not become success"}

"#
            .to_vec()),
            Ok(b"data: [DONE]\n\n".to_vec()),
        ]);
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

#[tokio::test]
async fn responses_sse_projects_anthropic_thinking_from_resp04_finalized_truth() {
    let scope = "anthropic_thinking_sse";
    let output = execute_v3_anthropic_relay_runtime(
        &manifest(scope),
        V3AnthropicRelayRuntimeInput {
            server_id: scope.into(),
            request_id: "req-thinking-sse".into(),
            payload: json!({
                "model":"claude-client-alias",
                "messages":[{"role":"user","content":"think"}],
                "stream":true
            }),
        },
        &ResponsesThinkingSseTransport,
    )
    .await
    .expect("Responses SSE thinking must close through Resp04");

    let events = output.client_response["events"]
        .as_array()
        .expect("Anthropic SSE events");
    assert!(events.iter().any(|event| {
        event["event"] == "content_block_delta"
            && event["data"]["delta"]
                == json!({
                    "type":"signature_delta",
                    "signature":"resp04-signature"
                })
    }));
    assert_eq!(
        output.node_trace.last(),
        Some(&"V3ServerRespOutbound06ClientFrame")
    );
}

#[tokio::test]
async fn responses_sse_without_terminal_fails_before_anthropic_success_projection() {
    let scope = "anthropic_terminal_missing";
    let output = execute_v3_anthropic_relay_runtime(
        &manifest(scope),
        V3AnthropicRelayRuntimeInput {
            server_id: scope.into(),
            request_id: "req-thinking-no-terminal".into(),
            payload: json!({
                "model":"claude-client-alias",
                "messages":[{"role":"user","content":"think"}],
                "stream":true
            }),
        },
        &ResponsesThinkingSseWithoutTerminalTransport,
    )
    .await
    .expect("provider codec failure must project through the standard error chain");

    assert_eq!(output.status, 502);
    assert!(
        output
            .client_response
            .to_string()
            .contains("before response.completed"),
        "incomplete provider stream must not be wrapped as Anthropic success: {}",
        output.client_response
    );
    assert_eq!(
        output.error_chain.as_deref(),
        Some(
            &[
                "V3Error01SourceRaised",
                "V3Error02Classified",
                "V3Error03TargetLocalAction",
                "V3Error04TargetExhaustionDecision",
                "V3Error05ExecutionDecision",
                "V3Error06ClientProjected",
            ][..]
        )
    );
}

fn manifest(scope: &str) -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            &r#"
version = 3
[servers.__SCOPE__]
bind = "127.0.0.1"
port = 1
routing_group = "__SCOPE__"
endpoints = ["anthropic"]
[providers.controlled]
type = "responses"
base_url = "http://controlled.invalid/v1"
default_model = "responses-wire-model"
auth = { type = "api_key", entries = [{ alias = "controlled", env = "CONTROLLED_KEY" }] }
[providers.controlled.models.responses-wire-model]
wire_name = "responses-wire-model"
supports_streaming = true
supports_thinking = true
capabilities = ["text", "tools", "tool_outputs", "local_materialization", "reasoning", "vision", "web_search"]
[route_groups.__SCOPE__.pools.claude_client]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "anthropic", models = ["claude-client-alias"] }
targets = [{ kind = "provider_model", provider = "controlled", model = "responses-wire-model", key = "controlled", priority = 1 }]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "controlled", model = "responses-wire-model", key = "controlled", priority = 1 }]
"#
            .replace("__SCOPE__", scope),
        )
        .unwrap(),
    )
    .unwrap()
}

fn manifest_with_two_providers(scope: &str) -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            &r#"
version = 3
[servers.__SCOPE__]
bind = "127.0.0.1"
port = 1
routing_group = "__SCOPE__"
endpoints = ["anthropic"]
[providers.primary]
type = "responses"
base_url = "http://primary.invalid/v1"
default_model = "responses-wire-model"
auth = { type = "api_key", entries = [{ alias = "primary", env = "V3_ANTHROPIC_PRIMARY_KEY" }] }
[providers.primary.models.responses-wire-model]
wire_name = "responses-wire-model"
aliases = ["claude-client-alias"]
supports_streaming = true
supports_thinking = true
capabilities = ["text", "tools", "tool_outputs", "local_materialization", "reasoning", "vision"]
[providers.secondary]
type = "responses"
base_url = "http://secondary.invalid/v1"
default_model = "responses-wire-model"
auth = { type = "api_key", entries = [{ alias = "secondary", env = "V3_ANTHROPIC_SECONDARY_KEY" }] }
[providers.secondary.models.responses-wire-model]
wire_name = "responses-wire-model"
aliases = ["claude-client-alias"]
supports_streaming = true
supports_thinking = true
capabilities = ["text", "tools", "tool_outputs", "local_materialization", "reasoning", "vision"]
[route_groups.__SCOPE__.pools.claude_client]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "anthropic", models = ["claude-client-alias"] }
targets = [
  { kind = "provider_model", provider = "primary", model = "responses-wire-model", key = "primary", priority = 1 },
  { kind = "provider_model", provider = "secondary", model = "responses-wire-model", key = "secondary", priority = 2 }
]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "primary", model = "responses-wire-model", key = "primary", priority = 1 },
  { kind = "provider_model", provider = "secondary", model = "responses-wire-model", key = "secondary", priority = 2 }
]
"#
            .replace("__SCOPE__", scope),
        )
        .unwrap(),
    )
    .unwrap()
}

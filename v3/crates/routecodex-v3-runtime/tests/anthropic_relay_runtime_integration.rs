use async_trait::async_trait;
use futures_util::StreamExt;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderHttpFailure, V3ProviderResp14Raw,
    V3ProviderResponseHeader, V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    execute_v3_anthropic_relay_runtime_with_client_headers_provider_health,
    materialize_v3_provider_sse_as_canonical_response,
    materialize_v3_responses_provider_sse_as_canonical_response,
    project_v3_anthropic_client_events, project_v3_anthropic_message_as_responses_response,
    project_v3_responses_json_as_anthropic_events, project_v3_responses_json_as_anthropic_message,
    V3AnthropicRelayRuntimeInput, V3HubProviderWireProtocol, V3ProviderFailureRuntimeHealth,
};
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;

async fn execute_v3_anthropic_relay_runtime<T: ResponsesTransport>(
    manifest: &routecodex_v3_config::V3Config05ManifestPublished,
    input: V3AnthropicRelayRuntimeInput,
    transport: &T,
) -> Result<
    routecodex_v3_runtime::V3AnthropicRelayRuntimeOutput,
    routecodex_v3_runtime::V3AnthropicRelayRuntimeError,
> {
    execute_v3_anthropic_relay_runtime_with_client_headers_provider_health(
        manifest,
        input,
        transport,
        Vec::new(),
        V3ProviderFailureRuntimeHealth::from_manifest_for_tests(manifest),
    )
    .await
}

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
                    {"type":"function_call","call_id":"call_json_1","name":"lookup","arguments":"{\"q\":\"alpha\",\"reason\":\"查找 alpha\",\"goal_alignment_confidence\":100,\"model_id\":\"responses-wire-model\"}"}
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

#[tokio::test]
async fn anthropic_json_codec_represents_max_tokens_but_provider_materialization_rejects_it() {
    let json_response = project_v3_anthropic_message_as_responses_response(&json!({
        "id":"msg_terminal_parity",
        "type":"message",
        "role":"assistant",
        "model":"MiniMax-M3",
        "content":[{"type":"text","text":"partial"}],
        "usage":{"input_tokens":3,"output_tokens":2},
        "stop_reason":"max_tokens",
        "stop_sequence":null
    }))
    .expect("Anthropic JSON max_tokens must use the registered terminal projection");

    let stream = futures_util::stream::iter([
        Ok(br#"event: message_start
data: {"type":"message_start","message":{"id":"msg_terminal_parity","type":"message","role":"assistant","model":"MiniMax-M3","content":[],"stop_reason":null,"usage":{"input_tokens":3}}}

"#.to_vec()),
        Ok(br#"event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

"#.to_vec()),
        Ok(br#"event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}

"#.to_vec()),
        Ok(br#"event: content_block_stop
data: {"type":"content_block_stop","index":0}

"#.to_vec()),
        Ok(br#"event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"output_tokens":2}}

"#.to_vec()),
        Ok(br#"event: message_stop
data: {"type":"message_stop"}

"#.to_vec()),
    ]);
    let sse_error = materialize_v3_provider_sse_as_canonical_response(
        V3HubProviderWireProtocol::Anthropic,
        Box::pin(stream),
    )
    .await
    .expect_err("provider max_tokens must not be admitted as a successful attempt");

    assert_eq!(json_response["status"], "incomplete");
    assert_eq!(
        json_response["incomplete_details"]["reason"],
        "max_output_tokens"
    );
    assert_eq!(json_response["finish_reason"], "max_tokens");
    assert!(
        sse_error
            .to_string()
            .contains("provider response ended before completion: max_tokens"),
        "unexpected provider materialization error: {sse_error}"
    );
}

#[tokio::test]
async fn anthropic_refusal_provider_terminal_is_rejected_before_success_projection() {
    let json_response = project_v3_anthropic_message_as_responses_response(&json!({
        "id":"msg_refusal_terminal_parity",
        "type":"message",
        "role":"assistant",
        "model":"MiniMax-M3",
        "content":[{"type":"text","text":"partial"}],
        "usage":{"input_tokens":3,"output_tokens":2},
        "stop_reason":"refusal",
        "stop_details":{"type":"refusal","category":"policy","explanation":"refused"}
    }))
    .expect("Anthropic JSON refusal must use the registered terminal projection");

    let stream = futures_util::stream::iter([
        Ok(br#"event: message_start
data: {"type":"message_start","message":{"id":"msg_refusal_terminal_parity","type":"message","role":"assistant","model":"MiniMax-M3","content":[],"stop_reason":null,"usage":{"input_tokens":3}}}

"#.to_vec()),
        Ok(br#"event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

"#.to_vec()),
        Ok(br#"event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}

"#.to_vec()),
        Ok(br#"event: content_block_stop
data: {"type":"content_block_stop","index":0}

"#.to_vec()),
        Ok(br#"event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"type":"refusal","category":"policy","explanation":"refused"}},"usage":{"output_tokens":2}}

"#.to_vec()),
        Ok(br#"event: message_stop
data: {"type":"message_stop"}

"#.to_vec()),
    ]);
    let sse_error = materialize_v3_provider_sse_as_canonical_response(
        V3HubProviderWireProtocol::Anthropic,
        Box::pin(stream),
    )
    .await
    .expect_err("provider refusal must not be admitted as a successful attempt");

    assert_eq!(json_response["status"], "incomplete");
    assert_eq!(
        json_response["incomplete_details"]["reason"],
        "content_filter"
    );
    assert!(
        sse_error
            .to_string()
            .contains("provider response ended before completion: content_filter"),
        "unexpected provider materialization error: {sse_error}"
    );
}

#[tokio::test]
async fn anthropic_json_and_sse_reject_unknown_terminal_without_success_projection() {
    let json_error = project_v3_anthropic_message_as_responses_response(&json!({
        "id":"msg_unknown_terminal",
        "type":"message",
        "role":"assistant",
        "model":"MiniMax-M3",
        "content":[{"type":"text","text":"must fail"}],
        "stop_reason":"future_terminal"
    }))
    .expect_err("unknown Anthropic JSON stop_reason must fail at the terminal owner");
    assert!(json_error.to_string().contains("future_terminal"));

    let stream = futures_util::stream::iter([
        Ok(br#"event: message_start
data: {"type":"message_start","message":{"id":"msg_unknown_terminal","type":"message","role":"assistant","model":"MiniMax-M3","content":[],"stop_reason":null}}

"#.to_vec()),
        Ok(br#"event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

"#.to_vec()),
        Ok(br#"event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"must fail"}}

"#.to_vec()),
        Ok(br#"event: content_block_stop
data: {"type":"content_block_stop","index":0}

"#.to_vec()),
        Ok(br#"event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"future_terminal","stop_sequence":null}}

"#.to_vec()),
        Ok(br#"event: message_stop
data: {"type":"message_stop"}

"#.to_vec()),
    ]);
    let sse_error = materialize_v3_provider_sse_as_canonical_response(
        V3HubProviderWireProtocol::Anthropic,
        Box::pin(stream),
    )
    .await
    .expect_err("unknown Anthropic SSE stop_reason must fail at the same terminal owner");
    assert!(sse_error.to_string().contains("future_terminal"));
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
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-json".into(),
            toolreason_observation_session_id: Some("rcc-session:request:req-json".into()),
            payload: json!({
                "model":"claude-client-alias",
                "messages":[{"role":"user","content":"Lookup alpha"}],
                "tools":[{"name":"lookup","input_schema":{"type":"object"}}],
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
            "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"Lookup alpha"}]}],
            "tools":[{"type":"function","name":"lookup","parameters":{"type":"object"}}],
            "stream":false
        })
    );
    assert_eq!(output.status, 200);
    assert_eq!(output.node_trace.len(), 15, "trace={:?}", output.node_trace);
    assert_eq!(output.node_trace[0], "V3HubReqInbound01ClientRaw");
    assert!(output
        .node_trace
        .contains(&"ProviderReqCompat06ProviderCompat"));
    assert!(output
        .node_trace
        .contains(&"ProviderRespCompat02ProviderCompat"));
    assert_eq!(output.node_trace[14], "V3ServerRespOutbound06ClientFrame");
    assert_eq!(output.client_response["stop_reason"], "tool_use");
    let toolreason = output
        .stream_observation
        .as_ref()
        .unwrap()
        .snapshot()
        .unwrap()
        .toolreason
        .unwrap();
    assert_eq!(toolreason.status, "OK");
    assert_eq!(toolreason.reason.as_deref(), Some("查找 alpha"));
    assert_eq!(
        toolreason.session_id.as_deref(),
        Some("rcc-session:request:req-json")
    );
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
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-anthropic-field-matrix".into(),
            toolreason_observation_session_id: None,
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
                "output_config":{"effort":"medium"},
                "metadata":{"user_id":"opaque-user"},
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
    assert_eq!(output.status, 200, "runtime output: {output:?}");
    let observability = output
        .observability
        .as_ref()
        .expect("anthropic relay JSON success must carry typed observability");
    assert_eq!(observability.entry_protocol, "anthropic");
    assert_eq!(observability.transport, "json");
    assert_eq!(observability.response_status.as_deref(), Some("completed"));
    let usage = observability
        .usage
        .as_ref()
        .expect("anthropic JSON usage must normalize into observability");
    assert_eq!(usage.input_tokens, Some(11));
    assert_eq!(usage.output_tokens, Some(7));
    assert_eq!(usage.total_tokens, Some(18));
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
    assert_eq!(body["reasoning"]["effort"], "medium");
    assert_eq!(body["metadata"], json!({"user_id":"opaque-user"}));
    assert!(body.get("client_metadata").is_none(), "{body}");
    assert_eq!(body["temperature"], 0.2);
    assert_eq!(body["top_p"], 0.9);
    assert_eq!(body["top_k"], 5);
    assert_eq!(body["max_output_tokens"], 123);
    assert_eq!(body["stop"], json!(["</stop>"]));
    assert_eq!(body["stream"], false);
}

#[tokio::test]
async fn anthropic_structured_system_extension_is_not_silently_flattened_for_responses() {
    let scope = "anthropic_structured_system_unmapped";
    let transport = MatrixJsonTransport {
        captured: Mutex::new(None),
        response: json!({"id":"unused","status":"completed","output":[]}),
    };
    let output = execute_v3_anthropic_relay_runtime(
        &manifest(scope),
        V3AnthropicRelayRuntimeInput {
            server_id: scope.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-anthropic-structured-system-unmapped".into(),
            toolreason_observation_session_id: None,
            payload: json!({
                "model":"claude-client-alias",
                "system":[{
                    "type":"text",
                    "text":"cache this system block",
                    "cache_control":{"type":"ephemeral"}
                }],
                "messages":[{"role":"user","content":"hello"}],
                "max_tokens":128,
                "stream":false
            }),
        },
        &transport,
    )
    .await
    .unwrap();

    assert_eq!(output.status, 598, "runtime output: {output:?}");
    assert!(transport.captured.lock().unwrap().is_none());
    assert_eq!(
        output.client_response["error"]["code"],
        "provider_request_payload_invalid"
    );
    assert!(
        output.client_response["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("UnmappedOutboundFields")),
        "structured Anthropic system semantics must fail explicitly when Responses has no exact field: {output:?}"
    );
    assert!(output
        .node_trace
        .contains(&"ProviderReqCompat06ProviderCompat"));
    assert!(!output.node_trace.contains(&"V3TargetPolicyRetriedSame"));
    assert!(!output
        .node_trace
        .contains(&"V3ProviderReqOutbound09TransportRequest"));
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
                body_read_failure: None,
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
                    body_read_failure: None,
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
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "test-server",
                    "test-group",
                    concat!(module_path!(), ":", line!()),
                )
                .expect("test provider failure session scope"),
                request_id: "req-provider-reselect".into(),
                toolreason_observation_session_id: None,
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
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-error".into(),
            toolreason_observation_session_id: None,
            payload: json!({"model":"claude-client-alias","messages":[{"role":"user","content":"fail"}],"stream":false}),
        },
        &ErrorTransport,
    )
    .await
    .unwrap();
    assert_eq!(output.status, 502);
    assert_eq!(output.client_response["error"]["message"], "network error");
    assert_eq!(output.client_response["error"]["code"], "network_error");
    assert!(
        output.client_response["error"].get("stage").is_none()
            && output.client_response["error"].get("class").is_none()
            && output.client_response["error"].get("error_node").is_none()
            && output.client_response["error"].get("decision").is_none()
            && output.client_response["error"]
                .get("target_exhausted")
                .is_none()
            && output.client_response["error"]
                .get("external_error")
                .is_none(),
        "Error06 body must not carry control-plane fields: {}",
        output.client_response["error"]
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
        Ok(br#"data: {"type":"response.content_part.done","item_id":"msg_live","output_index":0,"content_index":0,"part":{"type":"output_text","text":"V3_COMPAT_ANTHROPIC_SSE_OK"}}

"#
        .to_vec()),
        Ok(br#"data: {"type":"response.output_item.done","output_index":0,"item":{"type":"message","id":"msg_live","role":"assistant","content":[{"type":"output_text","text":"V3_COMPAT_ANTHROPIC_SSE_OK"}]}}

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
    assert_eq!(
        canonical_response["output"][0]["content"][0]["type"],
        "output_text"
    );
    assert_eq!(
        canonical_response["output"][0]["content"][0]["text"],
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
        Ok(b"event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"rs_1\",\"type\":\"reasoning\",\"summary\":[]}}\n\n".to_vec()),
        Ok(b"event: response.reasoning_summary_text.delta\ndata: {\"type\":\"response.reasoning_summary_text.delta\",\"output_index\":0,\"item_id\":\"rs_1\",\"summary_index\":0,\"delta\":\"Need\"}\n\n".to_vec()),
        Ok(b"event: response.reasoning_summary_text.delta\ndata: {\"type\":\"response.reasoning_summary_text.delta\",\"output_index\":0,\"item_id\":\"rs_1\",\"summary_index\":0,\"delta\":\" beta\"}\n\n".to_vec()),
        Ok(b"event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"output_index\":1,\"item\":{\"id\":\"fc_1\",\"type\":\"function_call\",\"call_id\":\"call_sse_1\",\"name\":\"lookup\",\"arguments\":\"\"}}\n\n".to_vec()),
        Ok(b"event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":1,\"item_id\":\"fc_1\",\"delta\":\"{\\\"q\\\":\\\"beta\\\"}\"}\n\n".to_vec()),
        Ok(b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_sse_1\",\"status\":\"completed\"}}\n\n".to_vec()),
    ]);
    let canonical_response =
        materialize_v3_responses_provider_sse_as_canonical_response(Box::pin(stream))
            .await
            .unwrap();
    assert_eq!(canonical_response["output"].as_array().unwrap().len(), 2);
    let client_events = project_v3_responses_json_as_anthropic_events(&canonical_response).unwrap();
    let client = project_v3_anthropic_client_events(client_events);
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
data: {"type":"response.completed","response":{"id":"resp_thinking_sse","status":"completed","output":[{"type":"reasoning","id":"rs_thinking","summary":[{"type":"summary_text","text":"signed thought"}],"encrypted_content":"resp04-signature"}],"usage":{"input_tokens":13,"output_tokens":8,"total_tokens":21}}}

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

struct ContinuousNonTerminalAnthropicSseTransport;

#[async_trait]
impl ResponsesTransport for ContinuousNonTerminalAnthropicSseTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let stream = futures_util::stream::iter([Ok(
            br#"event: response.created
data: {"type":"response.created","response":{"id":"resp_anthropic_hang","status":"in_progress","output":[]}}

"#
            .to_vec(),
        )])
        .chain(futures_util::stream::unfold((), |_| async {
            Some((
                Ok::<Vec<u8>, V3ProviderError>(
                    br#"event: response.output_text.delta
data: {"type":"response.output_text.delta","delta":"progress"}

"#
                    .to_vec(),
                ),
                (),
            ))
        }));
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
async fn responses_sse_projects_anthropic_thinking_from_response_governance() {
    let scope = "anthropic_thinking_sse";
    let output = execute_v3_anthropic_relay_runtime(
        &manifest(scope),
        V3AnthropicRelayRuntimeInput {
            server_id: scope.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-thinking-sse".into(),
            toolreason_observation_session_id: None,
            payload: json!({
                "model":"claude-client-alias",
                "messages":[{"role":"user","content":"think"}],
                "stream":true
            }),
        },
        &ResponsesThinkingSseTransport,
    )
    .await
    .expect("Responses SSE thinking must close through response governance");

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
    let observability = output
        .observability
        .as_ref()
        .expect("anthropic relay SSE success must carry typed observability");
    let usage = observability
        .usage
        .as_ref()
        .expect("anthropic SSE usage must normalize into observability");
    assert_eq!(usage.input_tokens, Some(13));
    assert_eq!(usage.output_tokens, Some(8));
    assert_eq!(usage.total_tokens, Some(21));
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
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-thinking-no-terminal".into(),
            toolreason_observation_session_id: None,
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
    assert_eq!(output.client_response["error"]["code"], "network_error");
    assert_eq!(output.client_response["error"]["message"], "network error");
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

#[tokio::test]
async fn anthropic_relay_continuous_non_terminal_sse_returns_typed_failure() {
    let scope = "anthropic_continuous_non_terminal";
    let mut manifest = manifest(scope);
    manifest
        .servers
        .get_mut(scope)
        .expect("anthropic relay test server")
        .execution
        .as_mut()
        .expect("execution policy")
        .attempt_store
        .residence_timeout_ms = 250;

    let outcome = tokio::time::timeout(
        Duration::from_secs(2),
        execute_v3_anthropic_relay_runtime(
            &manifest,
            V3AnthropicRelayRuntimeInput {
                server_id: scope.into(),
                failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                    "test-server",
                    scope,
                    concat!(module_path!(), ":", line!()),
                )
                .expect("test provider failure session scope"),
                request_id: "req-anthropic-continuous-non-terminal".into(),
                toolreason_observation_session_id: None,
                payload: json!({
                    "model":"claude-client-alias",
                    "messages":[{"role":"user","content":"continuous non-terminal"}],
                    "stream":true
                }),
            },
            &ContinuousNonTerminalAnthropicSseTransport,
        ),
    )
    .await
    .expect("continuous non-terminal Anthropic stream must not hang the runtime");

    match outcome {
        Ok(output) => {
            assert_eq!(output.status, 502);
            assert_eq!(output.client_response["error"]["code"], "network_error");
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
        Err(routecodex_v3_runtime::V3AnthropicRelayRuntimeError::ExecutionControlRequest(
            message,
        )) => {
            assert!(
                message.contains("request residence deadline"),
                "unexpected request-stage failure: {message}"
            );
            let projected = routecodex_v3_runtime::project_v3_anthropic_relay_runtime_failure(
                routecodex_v3_runtime::V3AnthropicRelayRuntimeError::ExecutionControlRequest(
                    message,
                ),
            );
            assert_eq!(projected.status, 598);
            assert_eq!(projected.error_chain.as_ref().map(Vec::len), Some(6));
            assert!(projected.client_response.get("error").is_some());
        }
        Err(error) => panic!("unexpected Anthropic relay failure: {error}"),
    }
}

fn manifest(scope: &str) -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            &r#"
version = 3
[pipelines.hub_v1]
skeleton = "hub_v1"
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
capabilities = ["text", "tools", "tool_outputs", "reasoning", "vision", "web_search"]
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
[pipelines.hub_v1]
skeleton = "hub_v1"
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
capabilities = ["text", "tools", "tool_outputs", "reasoning", "vision"]
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
capabilities = ["text", "tools", "tool_outputs", "reasoning", "vision"]
[route_groups.__SCOPE__.pools.claude_client]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "anthropic", models = ["claude-client-alias"] }
targets = [
  { kind = "provider_model", provider = "primary", model = "responses-wire-model", key = "primary", priority = 2 },
  { kind = "provider_model", provider = "secondary", model = "responses-wire-model", key = "secondary", priority = 1 }
]
[route_groups.__SCOPE__.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "primary", model = "responses-wire-model", key = "primary", priority = 2 },
  { kind = "provider_model", provider = "secondary", model = "responses-wire-model", key = "secondary", priority = 1 }
]
"#
            .replace("__SCOPE__", scope),
        )
        .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn anthropic_unknown_direct_provider_model_returns_model_not_found() {
    let scope = "anthropic_404";
    let transport = JsonTransport {
        captured: Mutex::new(None),
    };
    let error = execute_v3_anthropic_relay_runtime(
        &manifest(scope),
        V3AnthropicRelayRuntimeInput {
            server_id: scope.into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                "session-anthropic-404",
            )
            .expect("test provider failure session scope"),
            request_id: "req-anthropic-404".into(),
            toolreason_observation_session_id: None,
            payload: json!({
                "model":"controlled.unknown-model",
                "messages":[{"role":"user","content":"ping"}],
                "stream":false
            }),
        },
        &transport,
    )
    .await
    .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("direct provider model controlled.unknown-model is not configured"),
        "anthropic provider.model absence must surface ModelNotFound: {error}"
    );
}

#[tokio::test]
async fn anthropic_entry_mode_b_web_search_intercepted_must_fail_fast_not_silently_strip() {
    // 红测：anthropic 入口 + Mode B web_search 拦截后无结果投影路径，
    // 必须显式 WebSearchInterceptedUnprojected，禁止静默剥离成普通文本。
    let manifest = compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[pipelines.hub_v1]
skeleton = "hub_v1"
[servers.ws]
bind = "127.0.0.1"
port = 1
routing_group = "ws"
endpoints = ["anthropic"]
[providers.mm]
type = "anthropic"
base_url = "https://api.minimaxi.com/anthropic"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MM_KEY" }] }
[providers.mm.models."MiniMax-M3"]
wire_name = "MiniMax-M3"
supports_streaming = true
capabilities = ["text", "tools", "web_search"]
web_search_execution_mode = "metadata_center_local_search"
web_search_backend = "MiniMax-M3"
[route_groups.ws.pools.web_search]
selection = { strategy = "priority" }
match = { precedence = 20, required_capabilities = ["web_search"] }
targets = [{ kind = "provider_model", provider = "mm", model = "MiniMax-M3", key = "key1", priority = 1 }]
[route_groups.ws.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "mm", model = "MiniMax-M3", key = "key1", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap();

    struct WebSearchTransport;
    #[async_trait]
    impl ResponsesTransport for WebSearchTransport {
        async fn send(
            &self,
            request: V3Transport13ResponsesHttpRequest,
        ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
            Ok(V3ProviderResp14Raw::from_json(
                request.request_id(),
                request.provider_id(),
                200,
                vec![V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"application/json".to_vec(),
                }],
                serde_json::to_vec(&json!({
                    "id": "msg_ws_1",
                    "type": "message",
                    "role": "assistant",
                    "model": "MiniMax-M3",
                    "content": [
                        {"type": "tool_use", "id": "call_ws_1", "name": "websearch",
                         "input": {"query": "routecodex"}}
                    ],
                    "stop_reason": "tool_use",
                    "usage": {"input_tokens": 11, "output_tokens": 5}
                }))
                .unwrap(),
            ))
        }
    }

    let payload = json!({
        "model": "MiniMax-M3",
        "max_tokens": 128,
        "messages": [{"role": "user", "content": "search routecodex"}],
        "tools": [{"name": "web_search", "description": "Search the web"}],
        "stream": false
    });
    let error = execute_v3_anthropic_relay_runtime(
        &manifest,
        V3AnthropicRelayRuntimeInput {
            server_id: "ws".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                "anthropic-mode-b-ws",
            )
            .expect("scope"),
            request_id: "anthropic-mode-b-ws-1".into(),
            toolreason_observation_session_id: None,
            payload,
        },
        &WebSearchTransport,
    )
    .await
    .expect_err("Mode B web_search interception must fail fast, not silently strip");
    match error {
        routecodex_v3_runtime::V3AnthropicRelayRuntimeError::WebSearchInterceptedUnprojected => {}
        other => panic!("expected WebSearchInterceptedUnprojected, got: {other:?}"),
    }
}

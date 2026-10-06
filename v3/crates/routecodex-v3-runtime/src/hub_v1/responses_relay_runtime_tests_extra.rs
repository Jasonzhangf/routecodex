use super::*;
use futures_util::{stream, StreamExt};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::build_v3_transport_13_responses_http_request_from_parts;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

struct AnthropicToolSearchJsonTransport;

#[async_trait::async_trait]
impl ResponsesTransport for AnthropicToolSearchJsonTransport {
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
            br#"{"id":"f433f0f7029b4727a2538edc7c6a7df0","type":"message","role":"assistant","model":"glm-5.3","content":[{"type":"tool_use","id":"call_3dqpgqh0jjwwie2wrul1zjb0","name":"mcp__rcc_probe__echo","input":{"text":"RCC_MCP_IDENTITY_BASELINE"}}],"stop_reason":"tool_use","usage":{"input_tokens":549,"output_tokens":60}}"#.to_vec(),
        ))
    }
}

#[test]
fn responses_tool_search_output_provider_call_restores_identity_for_tool_followup() {
    let request = json!({
        "model":"gpt-5.5",
        "tools":[{"type":"tool_search"}],
        "input":[
            {"type":"tool_search_call","call_id":"call_search","execution":"client","arguments":{"query":"codex review"}},
            {"type":"tool_search_output","call_id":"call_search","execution":"client","tools":[{
                "type":"namespace","name":"mcp__codex_review","tools":[{
                    "type":"function","name":"review_start","parameters":{"type":"object","properties":{"repo":{"type":"string"}}}
                }]
            }]}
        ]
    });
    let provider_response = json!({"id":"chatcmpl_dynamic_mcp","choices":[{
        "message":{"role":"assistant","tool_calls":[{
            "id":"call_review_start","type":"function",
            "function":{"name":"mcp__codex_review__review_start","arguments":"{\"repo\":\"/tmp/project\"}"}
        }]},
        "finish_reason":"tool_calls"
    }]});
    let semantic_request =
        super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
            &request,
        )
        .expect("Responses request must normalize to the runtime Chat canonical body");

    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &provider_response,
        &semantic_request,
    )
    .expect("provider tool call must project through the Responses response owner");
    assert_eq!(response["status"], "completed");
    assert_eq!(response["output"][0]["type"], "function_call");
    assert_eq!(response["output"][0]["namespace"], "mcp__codex_review");
    assert_eq!(response["output"][0]["name"], "review_start");
    assert_eq!(response["output"][0]["call_id"], "call_review_start");
    assert_eq!(
        response["output"][0]["arguments"],
        "{\"repo\":\"/tmp/project\"}"
    );

    let followup = json!({
        "tools": request["tools"],
        "input": [
            request["input"][0].clone(),
            request["input"][1].clone(),
            response["output"][0].clone(),
            {"type":"function_call_output","call_id":"call_review_start","output":"review started"},
            {"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]}
        ]
    });
    let canonical =
        super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
            &followup,
        )
        .expect("client followup must canonicalize the discovered MCP tool result");
    let chat = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("client followup must project back to the provider MCP identity");

    let messages = chat["messages"]
        .as_array()
        .expect("provider followup messages");
    let provider_call = messages
        .iter()
        .flat_map(|message| message["tool_calls"].as_array().into_iter().flatten())
        .find(|call| call["id"] == "call_review_start")
        .expect("provider history must retain the discovered MCP call id");
    assert_eq!(
        provider_call["function"]["name"],
        "mcp__codex_review__review_start"
    );
    assert_eq!(
        provider_call["function"]["arguments"],
        "{\"repo\":\"/tmp/project\"}"
    );
    let provider_result = messages
        .iter()
        .find(|message| message["tool_call_id"] == "call_review_start" && message["role"] == "tool")
        .expect("provider history must retain the discovered MCP result");
    assert_eq!(provider_result["content"], "review started");
}

#[tokio::test]
async fn responses_tool_search_output_anthropic_json_relay_preserves_tool_roundtrip() {
    std::env::set_var("ANTHROPIC_FIRST_KEY", "anthropic-secret");
    std::env::set_var("OPENAI_SECOND_KEY", "openai-secret");
    let manifest = super::responses_relay_runtime_tests::anthropic_then_openai_chat_manifest();
    let output = execute_v3_responses_relay_runtime_inner(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: "test".to_string(),
            failure_session_scope: V3ProviderFailureSessionScope::new(
                "test",
                "default",
                "mcp-tool-search-json-relay-session",
            )
            .expect("session scope"),
            request_id: "req-mcp-tool-search-json-relay".to_string(),
            payload: json!({
                "model":"client-model",
                "stream":false,
                "tools":[{"type":"tool_search"}],
                "input":[
                    {"type":"tool_search_call","call_id":"call_search_rcc_baseline","execution":"client","arguments":{"query":"rcc probe echo"}},
                    {"type":"tool_search_output","call_id":"call_search_rcc_baseline","execution":"client","tools":[{"type":"namespace","name":"mcp__rcc_probe","tools":[{"type":"function","name":"echo","description":"Echo the supplied text exactly","parameters":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}]}]}
                ]
            }),
        },
        &AnthropicToolSearchJsonTransport,
        None,
        V3ProviderFailureRuntimeHealth::from_manifest(&manifest),
        V3ResponsesRelayRetryPolicy::default(),
        false,
        None,
        None,
        None,
        None,
        BTreeSet::new(),
        None,
        None,
        V3ResponsesRelayRuntimeSeeds::default(),
        V3RelayEntryOrigin::ClientEntry,
    )
    .await
    .expect("Anthropic JSON response must traverse the full Relay runtime");

    assert_eq!(
        output.status, 200,
        "{}",
        match &output.client_body {
            V3ResponsesRelayClientBody::Json(value) => value.to_string(),
            V3ResponsesRelayClientBody::Sse(_) => "unexpected SSE".to_string(),
        }
    );
    let V3ResponsesRelayClientBody::Json(response) = output.client_body else {
        panic!("non-streaming request must return a JSON response");
    };
    assert_eq!(response["status"], "completed");
    assert_eq!(response["output"][0]["namespace"], "mcp__rcc_probe");
    assert_eq!(response["output"][0]["name"], "echo");
    assert_eq!(
        response["output"][0]["call_id"],
        "call_3dqpgqh0jjwwie2wrul1zjb0"
    );
    assert_eq!(
        response["output"][0]["arguments"],
        "{\"text\":\"RCC_MCP_IDENTITY_BASELINE\"}"
    );

    let followup = json!({
        "tools": [{"type":"tool_search"}],
        "input": [
            {"type":"tool_search_call","call_id":"call_search_rcc_baseline","execution":"client","arguments":{"query":"rcc probe echo"}},
            {"type":"tool_search_output","call_id":"call_search_rcc_baseline","execution":"client","tools":[{"type":"namespace","name":"mcp__rcc_probe","tools":[{"type":"function","name":"echo","description":"Echo the supplied text exactly","parameters":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}]}]},
            response["output"][0].clone(),
            {"type":"function_call_output","call_id":"call_3dqpgqh0jjwwie2wrul1zjb0","output":"RCC_MCP_FOLLOWUP_OK"},
            {"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]}
        ]
    });
    let canonical = super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(&followup)
        .expect("the restored function call and result must normalize for the follow-up turn");
    let anthropic_request =
        super::super::anthropic_codec::encode_v3_responses_semantic_as_anthropic_request(canonical)
            .expect("the follow-up must preserve the MCP dispatch identity to Anthropic");
    let tool_use = anthropic_request["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|message| message["content"].as_array().into_iter().flatten())
        .find(|part| part["type"] == "tool_use" && part["id"] == "call_3dqpgqh0jjwwie2wrul1zjb0")
        .expect("provider history must preserve the matching MCP tool call");
    assert_eq!(tool_use["name"], "mcp__rcc_probe__echo");
    assert_eq!(tool_use["input"]["text"], "RCC_MCP_IDENTITY_BASELINE");
    let tool_result = anthropic_request["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|message| message["content"].as_array().into_iter().flatten())
        .find(|part| {
            part["type"] == "tool_result" && part["tool_use_id"] == "call_3dqpgqh0jjwwie2wrul1zjb0"
        })
        .expect("provider history must preserve the matching MCP result");
    assert_eq!(tool_result["content"], "RCC_MCP_FOLLOWUP_OK");
}

#[tokio::test]
async fn responses_tool_search_output_anthropic_sse_restores_identity_for_tool_followup() {
    let inbound = json!({
        "model":"glm-5.3",
        "tools":[{"type":"tool_search"}],
        "input":[
            {"type":"tool_search_call","call_id":"call_search","execution":"client","arguments":{"query":"codex review"}},
            {"type":"tool_search_output","call_id":"call_search","execution":"client","tools":[{
                "type":"namespace","name":"mcp__codex_review","tools":[{
                    "type":"function","name":"review_start","parameters":{"type":"object","properties":{"repo":{"type":"string"}}}
                }]
            }]}
        ]
    });
    let canonical =
        super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
            &inbound,
        )
        .expect("Responses discovery history must normalize for the Relay runtime");
    let context = V3AnthropicResponsesProjectionContext::from_chat_canonical_request(&canonical)
        .expect("projection context must read dynamic MCP identity from canonical history");
    let event = |kind: &str, body: serde_json::Value| {
        Ok(format!("event: {kind}\ndata: {body}\n\n").into_bytes())
    };
    let provider = Box::pin(stream::iter(vec![
        event(
            "message_start",
            json!({"type":"message_start","message":{"id":"msg_dynamic_mcp","type":"message","role":"assistant","model":"glm-5.3","content":[],"usage":{"input_tokens":10}}}),
        ),
        event(
            "content_block_start",
            json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_review_start","name":"mcp__codex_review__review_start","input":{}}}),
        ),
        event(
            "content_block_delta",
            json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"repo\":\"/tmp/project\"}"}}),
        ),
        event(
            "content_block_stop",
            json!({"type":"content_block_stop","index":0}),
        ),
        event(
            "message_delta",
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":2}}),
        ),
        event("message_stop", json!({"type":"message_stop"})),
    ]));
    let response =
        build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol_with_context(
            V3HubProviderWireProtocol::Anthropic,
            provider,
            &V3RuntimeStreamObservation::default(),
            &context,
        )
        .await
        .expect("Anthropic provider SSE tool_use must project through Responses response owner");
    let call = &response["output"][0];
    assert_eq!(call["type"], "function_call");
    assert_eq!(call["namespace"], "mcp__codex_review");
    assert_eq!(call["name"], "review_start");
    assert_eq!(call["call_id"], "call_review_start");
    assert_eq!(call["arguments"], "{\"repo\":\"/tmp/project\"}");

    let followup = json!({
        "model": inbound["model"],
        "tools": inbound["tools"],
        "input": [
            inbound["input"][0].clone(),
            inbound["input"][1].clone(),
            call.clone(),
            {"type":"function_call_output","call_id":"call_review_start","output":"review started"},
            {"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]}
        ]
    });
    let canonical =
        super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
            &followup,
        )
        .expect("client must be able to return the restored call and tool result");
    let anthropic_request =
        super::super::anthropic_codec::encode_v3_responses_semantic_as_anthropic_request(canonical)
            .expect("the followup must project to the same Anthropic provider protocol");
    let tool_use = anthropic_request["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|message| message["content"].as_array().into_iter().flatten())
        .find(|part| part["type"] == "tool_use" && part["id"] == "call_review_start")
        .expect("provider request must preserve the tool call identity");
    assert_eq!(tool_use["name"], "mcp__codex_review__review_start");
    assert_eq!(tool_use["input"]["repo"], "/tmp/project");
    let tool_result = anthropic_request["messages"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|message| message["content"].as_array().into_iter().flatten())
        .find(|part| part["type"] == "tool_result" && part["tool_use_id"] == "call_review_start")
        .expect("provider request must preserve the tool result pairing");
    assert_eq!(tool_result["content"], "review started");
}

#[test]
fn responses_provider_json_restores_declared_mcp_identity_for_tool_followup() {
    let request = json!({
        "tools": [{"type":"namespace","name":"mcp__mcpx","tools":[
            {"type":"namespace","name":"workspace","tools":[
                {"type":"function","name":"read","parameters":{"type":"object"}}
            ]}
        ]}]
    });
    let projection_context =
        V3AnthropicResponsesProjectionContext::from_chat_canonical_request(&request)
            .expect("request tool declaration must establish response identity context");
    let provider_response = json!({
        "id":"resp_mcpx_json_read",
        "status":"requires_action",
        "output":[{
            "type":"function_call",
            "id":"fc_mcpx_json_read",
            "call_id":"call_mcpx_json_read",
            "name":"mcp__mcpx__workspace__read",
            "arguments":"{\"path\":\"README.md\"}"
        }]
    });
    let successful_attempt_view =
        super::responses_relay_runtime_tests::responses_relay_hook_successful_attempt_view(
            "mcp-json-roundtrip",
            request.clone(),
            V3HubProviderWireProtocol::Responses,
        );
    let manifest = super::responses_relay_runtime_tests::anthropic_then_openai_chat_manifest();
    let mut trace = Vec::new();
    let (response, _) = run_json_response_hooks(
        V3ResponsesRelayJsonResponseHookInput {
            session_id: "mcp-json-roundtrip",
            request_id: "mcp-json-roundtrip",
            provider_value: &provider_response,
            provider_semantic_body: &request,
            manifest: &manifest,
            server_id: "test",
            provider_id: Some("openai_second"),
            expected_model_id: "chat-test",
            provider_protocol: V3HubProviderWireProtocol::Responses,
            source_provider_protocol: V3HubProviderWireProtocol::Responses,
            projection_context: &projection_context,
            successful_attempt_view: &successful_attempt_view,
            provider_response_transport_intent: V3HubTransportIntent::Json,
            compatibility_profile: None,
            web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode::None,
            web_search_center_state: None,
            retain_response_cipher: false,
            tool_thinking_enabled: false,
            tool_thinking_turn_context: &V3ToolThinkingTurnContext::disabled(),
        },
        &mut trace,
    )
    .expect("Responses provider JSON must restore identity from the request declaration");

    assert_eq!(response["output"][0]["call_id"], "call_mcpx_json_read");
    assert_eq!(response["output"][0]["namespace"], "mcp__mcpx.workspace");
    assert_eq!(response["output"][0]["name"], "read");
    assert_eq!(
        response["output"][0]["arguments"],
        "{\"path\":\"README.md\"}"
    );

    let followup = json!({
        "tools": request["tools"],
        "input": [
            response["output"][0].clone(),
            {"type":"function_call_output","call_id":"call_mcpx_json_read","output":"README contents"},
            {"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]}
        ]
    });
    let canonical =
        super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
            &followup,
        )
        .expect("client followup must canonicalize with the restored tool identity");
    let chat = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("client followup must project back to the declared provider tool identity");

    assert_eq!(
        chat["messages"][0]["tool_calls"][0]["id"],
        "call_mcpx_json_read"
    );
    assert_eq!(
        chat["messages"][0]["tool_calls"][0]["function"]["name"],
        "mcp__mcpx__workspace__read"
    );
    assert_eq!(chat["messages"][1]["tool_call_id"], "call_mcpx_json_read");
    assert_eq!(chat["messages"][1]["content"], "README contents");
}

#[tokio::test]
async fn responses_provider_sse_restores_declared_mcp_identity_for_tool_followup() {
    let observation = V3RuntimeStreamObservation::default();
    let request = json!({
        "tools": [{"type":"namespace","name":"mcp__mcpx","tools":[
            {"type":"namespace","name":"workspace","tools":[
                {"type":"function","name":"read","parameters":{"type":"object"}}
            ]}
        ]}]
    });
    let context = V3AnthropicResponsesProjectionContext::from_chat_canonical_request(&request)
        .expect("request tool declaration must establish response identity context");
    let provider = Box::pin(stream::iter(vec![
        Ok(b"event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call_mcpx_read\",\"name\":\"mcp__mcpx__workspace__read\",\"arguments\":\"{\\\"path\\\":\\\"README.md\\\"}\"}}\n\n".to_vec()),
        Ok(b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_mcpx_read\",\"status\":\"requires_action\",\"usage\":{\"input_tokens\":2,\"output_tokens\":3,\"total_tokens\":5}}}\n\n".to_vec()),
    ]));

    let response =
        build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol_with_context(
            V3HubProviderWireProtocol::Responses,
            provider,
            &observation,
            &context,
        )
        .await
        .expect("Responses provider SSE must restore identity from the request declaration");

    assert_eq!(response["output"][0]["call_id"], "call_mcpx_read");
    assert_eq!(response["output"][0]["namespace"], "mcp__mcpx.workspace");
    assert_eq!(response["output"][0]["name"], "read");
    assert_eq!(
        response["output"][0]["arguments"],
        "{\"path\":\"README.md\"}"
    );

    let followup = json!({
        "tools": request["tools"],
        "input": [
            response["output"][0].clone(),
            {"type":"function_call_output","call_id":"call_mcpx_read","output":"README contents"},
            {"type":"message","role":"user","content":[{"type":"input_text","text":"continue"}]}
        ]
    });
    let canonical =
        super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
            &followup,
        )
        .expect("client followup must canonicalize with the restored tool identity");
    let chat = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("client followup must project back to the declared provider tool identity");

    assert_eq!(chat["messages"][0]["tool_calls"][0]["id"], "call_mcpx_read");
    assert_eq!(
        chat["messages"][0]["tool_calls"][0]["function"]["name"],
        "mcp__mcpx__workspace__read"
    );
    assert_eq!(chat["messages"][1]["tool_call_id"], "call_mcpx_read");
    assert_eq!(chat["messages"][1]["content"], "README contents");
}

#[test]
fn unsupported_provider_tool_call_keeps_identity_through_client_error_and_next_turn() {
    let request = json!({"tools":[{"type":"function","name":"exec_command",
        "parameters":{"type":"object","properties":{"cmd":{"type":"string"}}}}]});
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({"id":"chatcmpl_unknown_call","choices":[{
            "message":{"role":"assistant","content":"","tool_calls":[{
                "id":"call_read1","type":"function",
                "function":{"name":"read 1","arguments":"{}"}
            }]},"finish_reason":"tool_calls"
        }]}),
        &request,
    )
    .expect("provider call must reach the client with its original identity");
    assert_eq!(response["output"][0]["name"], "read 1");
    assert_eq!(response["output"][0]["call_id"], "call_read1");

    let followup = json!({
        "tools": request["tools"],
        "input": [
            response["output"][0].clone(),
            {"type":"function_call_output","call_id":"call_read1",
                "output":"unsupported call: read 1"}
        ]
    });
    let canonical =
        super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
            &followup,
        )
        .expect("client error must canonicalize with the failed call");
    let chat = build_v3_openai_chat_standard_request_from_chat_canonical(&canonical)
        .expect("failed call and result must project into the next provider request");
    assert_eq!(chat["messages"][0]["tool_calls"][0]["id"], "call_read1");
    assert_eq!(
        chat["messages"][0]["tool_calls"][0]["function"]["name"],
        "read 1"
    );
    assert_eq!(chat["messages"][1]["tool_call_id"], "call_read1");
    assert_eq!(chat["messages"][1]["content"], "unsupported call: read 1");
}

#[test]
fn openai_chat_functions_exec_call_restores_shell_namespace_for_responses_client() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({"id":"chatcmpl_functions_exec","choices":[{
            "message":{"role":"assistant","content":"","tool_calls":[{
                "id":"call_functions_exec","type":"function",
                "function":{"name":"functions__exec","arguments":"{\"input\":\"pwd\"}"}
            }]},"finish_reason":"tool_calls"
        }]}),
        &json!({"tools":[
            {"type":"namespace","name":"functions","tools":[
                {"type":"custom","name":"exec","description":"deferred shell tool","format":{"type":"text"}}
            ]},
            {"type":"namespace","name":"functions","tools":[
                {"type":"custom","name":"exec","description":"current shell tool","format":{"type":"text"}}
            ]}
        ]}),
    )
    .expect("flattened shell call must restore its client namespace");

    assert_eq!(response["status"], "completed");
    assert_eq!(response["output"][0]["type"], "custom_tool_call");
    assert_eq!(response["output"][0]["namespace"], "functions");
    assert_eq!(response["output"][0]["name"], "exec");
    assert_eq!(response["output"][0]["call_id"], "call_functions_exec");
}

#[test]
fn openai_chat_namespace_custom_tool_response_restores_client_name() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "id":"chatcmpl_namespace_exec",
            "choices":[{"message":{"role":"assistant","content":"","tool_calls":[{
                "id":"call_namespace_exec",
                "type":"function",
                "function":{"name":"functions__exec","arguments":"{\"input\":\"pwd\"}"}
            }]},"finish_reason":"tool_calls"}]
        }),
        &json!({"tools":[{"type":"namespace","name":"functions","tools":[
            {"type":"custom","name":"exec","format":{"type":"text"}}
        ]}]}),
    )
    .expect("namespace custom declaration must reverse the provider function call");
    assert_eq!(response["output"][0]["type"], "custom_tool_call");
    assert_eq!(response["output"][0]["namespace"], "functions");
    assert_eq!(response["output"][0]["name"], "exec");
    assert_eq!(response["output"][0]["input"], "pwd");
    assert_eq!(response["output"][0]["call_id"], "call_namespace_exec");
}

#[test]
fn openai_chat_nested_namespace_custom_tool_restores_client_identity() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "id":"chatcmpl_nested_exec",
            "choices":[{"message":{"role":"assistant","content":"","tool_calls":[{
                "id":"call_nested_exec",
                "type":"function",
                "function":{"name":"functions__inner__exec","arguments":"{\"input\":\"pwd\"}"}
            }]},"finish_reason":"tool_calls"}]
        }),
        &json!({"tools":[{"type":"namespace","name":"functions","tools":[
            {"type":"namespace","name":"inner","tools":[
                {"type":"custom","name":"exec","format":{"type":"text"}}
            ]}
        ]}]}),
    )
    .expect("nested custom declaration must reverse the provider function call");
    assert_eq!(response["output"][0]["type"], "custom_tool_call");
    assert_eq!(response["output"][0]["namespace"], "functions.inner");
    assert_eq!(response["output"][0]["name"], "exec");
    assert_eq!(response["output"][0]["input"], "pwd");
    assert_eq!(response["output"][0]["call_id"], "call_nested_exec");
}

#[test]
fn openai_chat_nested_mcpx_function_call_restores_dotted_client_namespace() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "id":"chatcmpl_nested_mcpx_read",
            "choices":[{"message":{"role":"assistant","content":"","tool_calls":[{
                "id":"call_nested_mcpx_read",
                "type":"function",
                "function":{"name":"mcp__mcpx__workspace__read","arguments":"{\"path\":\"README.md\"}"}
            }]},"finish_reason":"tool_calls"}]
        }),
        &json!({"tools":[{"type":"namespace","name":"mcp__mcpx","tools":[
            {"type":"namespace","name":"workspace","tools":[
                {"type":"function","name":"read","parameters":{"type":"object"}}
            ]}
        ]}]}),
    )
    .expect("nested provider tool name must restore the client namespace path");

    assert_eq!(response["output"][0]["type"], "function_call");
    assert_eq!(response["output"][0]["namespace"], "mcp__mcpx.workspace");
    assert_eq!(response["output"][0]["name"], "read");
    assert_eq!(
        response["output"][0]["arguments"],
        "{\"path\":\"README.md\"}"
    );
    assert_eq!(response["output"][0]["call_id"], "call_nested_mcpx_read");
}

#[test]
fn openai_chat_namespace_with_provider_delimiter_restores_declared_identity() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "id":"chatcmpl_underscored_namespace",
            "choices":[{"message":{"role":"assistant","content":"","tool_calls":[{
                "id":"call_underscored_namespace",
                "type":"function",
                "function":{"name":"mcp__mcpx__workspace__read","arguments":"{}"}
            }]},"finish_reason":"tool_calls"}]
        }),
        &json!({"tools":[{"type":"namespace","name":"mcp__mcpx__workspace","tools":[
            {"type":"function","name":"read","parameters":{"type":"object"}}
        ]}]}),
    )
    .expect("provider dispatch name must reverse through its request declaration");

    assert_eq!(response["output"][0]["namespace"], "mcp__mcpx__workspace");
    assert_eq!(response["output"][0]["name"], "read");
    assert_eq!(
        response["output"][0]["call_id"],
        "call_underscored_namespace"
    );
}

#[test]
fn openai_chat_namespace_custom_tool_accepts_raw_freeform_arguments() {
    // Live error sample: kdns-freesail returned apply_patch as a raw free-form
    // string instead of the {"input":"..."} Chat function schema. The client
    // contract is a raw custom input, so this must project instead of 502.
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "id":"chatcmpl_raw_apply_patch",
            "choices":[{"message":{"role":"assistant","content":"","tool_calls":[{
                "id":"call_raw_apply_patch",
                "type":"function",
                "function":{"name":"functions__apply_patch","arguments":"*** Begin Patch\n*** Update File: /tmp/x\n+ hi\n*** End Patch"}
            }]},"finish_reason":"tool_calls"}]
        }),
        &json!({"tools":[{"type":"namespace","name":"functions","tools":[
            {"type":"custom","name":"apply_patch","format":{"type":"text"}}
        ]}]}),
    )
    .expect("raw free-form custom arguments must project to custom_tool_call");
    assert_eq!(response["output"][0]["type"], "custom_tool_call");
    assert_eq!(response["output"][0]["namespace"], "functions");
    assert_eq!(response["output"][0]["name"], "apply_patch");
    assert_eq!(
        response["output"][0]["input"],
        "*** Begin Patch\n*** Update File: /tmp/x\n+ hi\n*** End Patch"
    );
    assert_eq!(response["output"][0]["call_id"], "call_raw_apply_patch");
}

#[test]
fn zero_input_usage_uses_request_tiktoken_estimate() {
    let request = json!({
        "model": "gpt-5.5",
        "input": [{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}]
    });
    let mut response = json!({
        "status": "requires_action",
        "usage": {"input_tokens": 0, "output_tokens": 3, "total_tokens": 3}
    });
    materialize_v3_runtime_input_usage_estimate_from_request(&mut response, &request);
    assert_eq!(response["usage"]["input_tokens"], 2);
    assert_eq!(response["usage"]["total_tokens"], 5);
}

#[test]
fn nonzero_provider_input_usage_is_preserved() {
    let request = json!({
        "model": "gpt-5.5",
        "input": [{"type":"message","role":"user","content":"hello"}]
    });
    let mut response = json!({
        "status": "completed",
        "usage": {"input_tokens": 345678, "output_tokens": 3, "total_tokens": 345681}
    });
    materialize_v3_runtime_input_usage_estimate_from_request(&mut response, &request);
    assert_eq!(response["usage"]["input_tokens"], 345678);
    assert_eq!(response["usage"]["total_tokens"], 345681);
}

#[test]
fn missing_usage_gets_request_tiktoken_input_estimate() {
    let request = json!({
        "model": "gpt-5.5",
        "input": [{"type":"message","role":"user","content":"hello"}]
    });
    let mut response = json!({"status": "completed"});
    materialize_v3_runtime_input_usage_estimate_from_request(&mut response, &request);
    assert_eq!(response["usage"]["input_tokens"], 2);
    assert!(response["usage"].get("total_tokens").is_none());
}

#[tokio::test]
async fn provider_sse_done_without_completed_is_terminal_missing() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![
        Ok(b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n".to_vec()),
        Ok(b"event: response.done\ndata: {\"type\":\"response.done\",\"response\":{\"id\":\"resp_done\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":2,\"total_tokens\":3}}}\n\n".to_vec()),
        Ok(b"data: [DONE]\n\n".to_vec()),
    ]));
    let error =
        build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(provider, &observation)
            .await
            .unwrap_err();

    assert!(error
        .to_string()
        .contains("provider response event stream ended before response.completed"));
}

#[tokio::test]
async fn provider_sse_requires_action_without_completed_is_terminal_missing() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![Ok(
        b"event: response.requires_action\ndata: {\"type\":\"response.requires_action\",\"response\":{\"id\":\"resp_required\",\"status\":\"requires_action\"},\"required_action\":{\"type\":\"submit_tool_outputs\"}}\n\n".to_vec(),
    )]));
    let error =
        build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(provider, &observation)
            .await
            .unwrap_err();

    assert!(error
        .to_string()
        .contains("provider response event stream ended before response.completed"));
}

#[tokio::test]
async fn openai_chat_stream_usage_preserves_cached_input_tokens() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![
        Ok(concat!(
            "data: {\"id\":\"chatcmpl_cache\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"deepseek-v4.1-flash\",\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"ok\"},\"finish_reason\":null,\"index\":0}]}\n\n",
            "data: {\"id\":\"chatcmpl_cache\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"deepseek-v4.1-flash\",\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\",\"index\":0}]}\n\n",
        )
        .as_bytes()
        .to_vec()),
        Ok(concat!(
            "data: {\"id\":\"chatcmpl_cache\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"deepseek-v4.1-flash\",\"choices\":[],\"usage\":{\"prompt_tokens\":2712,\"completion_tokens\":3,\"total_tokens\":2715,\"prompt_tokens_details\":{\"cached_tokens\":2560},\"cache_read_input_tokens\":2560,\"prompt_cache_hit_tokens\":2560,\"prompt_cache_miss_tokens\":152}}\n\n",
            "data: [DONE]\n\n",
        )
        .as_bytes()
        .to_vec()),
    ]));
    let provider_payload = build_v3_hub_resp_inbound_02_from_openai_chat_provider_stream_events(
        provider,
        &observation,
    )
    .await
    .expect("Chat SSE usage must materialize before Responses projection");

    assert_eq!(provider_payload["usage"]["prompt_tokens"], 2712);
    assert_eq!(
        provider_payload["usage"]["prompt_tokens_details"]["cached_tokens"],
        2560
    );

    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &provider_payload,
        &json!({"tools": []}),
    )
    .expect("Chat completion usage must project to Responses");

    assert_eq!(response["usage"]["input_tokens"], 2712);
    assert_eq!(
        response["usage"]["input_tokens_details"]["cached_tokens"],
        2560
    );
}

/// A Chat provider that answers with a tool call must project to a Responses
/// response whose terminal status is `completed`, which is the same semantic a
/// Responses-native provider reports for a function_call output item.
/// `requires_action` is not a Responses status and must not be fabricated, and
/// the Chat-only `finish_reason` field must not enter the Responses object.
#[test]
fn openai_chat_tool_call_projects_completed_status_without_finish_reason() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "id": "chatcmpl_tool_terminal",
            "model": "wb-deepseek-v4.1-flash",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "id": "call_weather_1",
                        "type": "function",
                        "function": {
                            "name": "get_weather",
                            "arguments": "{\"city\":\"Paris\"}"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": {"prompt_tokens": 11, "completion_tokens": 3, "total_tokens": 14}
        }),
        &json!({
            "tools": [{
                "type": "function",
                "function": {"name": "get_weather", "parameters": {"type": "object"}}
            }]
        }),
    )
    .expect("an OpenAI Chat tool call must project to a Responses function_call");

    assert_eq!(
        response["status"], "completed",
        "a tool call is a normal Responses output item; the terminal status must stay completed: {response}"
    );
    assert!(
        response.get("finish_reason").is_none(),
        "finish_reason is a Chat Completions field and must not enter a Responses object: {response}"
    );
    assert_eq!(
        response["id"], "chatcmpl_tool_terminal",
        "the provider response id must be preserved: {response}"
    );
    assert_eq!(response["output"][0]["type"], "function_call");
    assert_eq!(response["output"][0]["call_id"], "call_weather_1");
    assert_eq!(response["output"][0]["name"], "get_weather");
}

#[path = "responses_relay_runtime_extra_tests.rs"]
mod extracted_tests_tail;
#[path = "responses_relay_runtime_extra_tail_tests.rs"]
mod extracted_tests_tail_2;

#[test]
fn anthropic_sse_minimax_profile_still_harvests_text_tool_calls() {
    // The Responses Relay SSE path materializes Anthropic text into a canonical
    // Responses payload while retaining a separate Anthropic source witness.
    // ProviderRespCompat02 must still see the canonical protocol so a declared
    // chat:minimax profile harvests a text tool envelope instead of leaking it
    // as visible text or rejecting it as malformed.
    let provider_response = json!({
        "id":"resp_minimax_sse_tool",
        "status":"completed",
        "output":[{
            "type":"message",
            "role":"assistant",
            "content":[{
                "type":"output_text",
                "text":"<function_calls>{\"tool_calls\":[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"pwd\"}}]}</function_calls>"
            }]
        }]
    });
    let successful_attempt_view =
        super::responses_relay_runtime_tests::responses_relay_hook_successful_attempt_view(
            "anthropic-sse-minimax",
            json!({"model":"client-model"}),
            V3HubProviderWireProtocol::Responses,
        );
    let manifest = super::responses_relay_runtime_tests::anthropic_then_openai_chat_manifest();
    let mut trace = Vec::new();
    let (response, _) = run_json_response_hooks(
        V3ResponsesRelayJsonResponseHookInput {
            session_id: "anthropic-sse-minimax",
            request_id: "anthropic-sse-minimax",
            provider_value: &provider_response,
            provider_semantic_body: &json!({"model":"client-model"}),
            manifest: &manifest,
            server_id: "test",
            provider_id: Some("anthropic_first"),
            expected_model_id: "claude-test",
            provider_protocol: V3HubProviderWireProtocol::Responses,
            source_provider_protocol: V3HubProviderWireProtocol::Anthropic,
            projection_context: &V3AnthropicResponsesProjectionContext::default(),
            successful_attempt_view: &successful_attempt_view,
            provider_response_transport_intent: V3HubTransportIntent::Sse,
            compatibility_profile: Some("chat:minimax"),
            web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode::None,
            web_search_center_state: None,
            retain_response_cipher: false,
            tool_thinking_enabled: false,
            tool_thinking_turn_context: &V3ToolThinkingTurnContext::disabled(),
        },
        &mut trace,
    )
    .expect("chat:minimax must harvest the text tool envelope through the canonical protocol");
    assert_eq!(response["output"][0]["type"], "function_call");
    assert_eq!(response["output"][0]["name"], "exec_command");
    assert_eq!(response["output"][0]["arguments"], "{\"cmd\":\"pwd\"}");
    let serialized = serde_json::to_string(&response).unwrap();
    assert!(!serialized.contains("<function_calls>"));
}

#[test]
fn anthropic_json_relay_keeps_literal_control_text_unchanged() {
    // Scope guard: the Resp03 control-text rule is bound to the Responses Relay
    // SSE materialization path, where provider_protocol stays canonical Responses
    // and the Anthropic wire protocol is carried by the typed source witness.
    // The Anthropic JSON projection keeps its existing path, so a literal text
    // block must reach the client unchanged instead of being rewritten or
    // rejected as a malformed control frame.
    let provider_response = json!({
        "id":"msg_anthropic_json_literal",
        "type":"message",
        "role":"assistant",
        "model":"claude-test",
        "content":[{
            "type":"text",
            "text":"<thinking>private plan\n<\u{2f}｜DSML｜parameter>\n<\u{2f}｜DSML｜invoke>\n<\u{2f}｜DSML｜tool_calls>"
        }],
        "stop_reason":"end_turn",
        "usage":{"input_tokens":1,"output_tokens":8}
    });
    let successful_attempt_view =
        super::responses_relay_runtime_tests::responses_relay_hook_successful_attempt_view(
            "anthropic-json-literal",
            json!({"model":"client-model"}),
            V3HubProviderWireProtocol::Anthropic,
        );
    let manifest = super::responses_relay_runtime_tests::anthropic_then_openai_chat_manifest();
    let mut trace = Vec::new();
    let (response, _) = run_json_response_hooks(
        V3ResponsesRelayJsonResponseHookInput {
            session_id: "anthropic-json-literal",
            request_id: "anthropic-json-literal",
            provider_value: &provider_response,
            provider_semantic_body: &json!({"model":"client-model"}),
            manifest: &manifest,
            server_id: "test",
            provider_id: Some("anthropic_first"),
            expected_model_id: "claude-test",
            provider_protocol: V3HubProviderWireProtocol::Anthropic,
            source_provider_protocol: V3HubProviderWireProtocol::Anthropic,
            projection_context: &V3AnthropicResponsesProjectionContext::default(),
            successful_attempt_view: &successful_attempt_view,
            provider_response_transport_intent: V3HubTransportIntent::Json,
            compatibility_profile: None,
            web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode::None,
            web_search_center_state: None,
            retain_response_cipher: false,
            tool_thinking_enabled: false,
            tool_thinking_turn_context: &V3ToolThinkingTurnContext::disabled(),
        },
        &mut trace,
    )
    .expect("Anthropic JSON relay must not reject literal provider text");
    let serialized = serde_json::to_string(&response).unwrap();
    assert!(
        serialized.contains("private plan"),
        "literal Anthropic JSON text must survive Resp03: {serialized}"
    );
    assert!(
        serialized.contains("｜DSML｜tool_calls>"),
        "literal Anthropic JSON text must not be rewritten at Resp03: {serialized}"
    );
}

#[test]
fn anthropic_sse_whole_item_thinking_literal_stays_visible() {
    // Scope guard: Resp03 governs only the proven complete DSML control frame.
    // A whole-item `<thinking>...</thinking>` literal that does not carry the
    // exact DSML closing block is representable provider text and must be
    // forwarded unchanged instead of being dropped as internal-only.
    let provider_response = json!({
        "id":"resp_thinking_literal",
        "status":"completed",
        "output":[{
            "type":"message",
            "role":"assistant",
            "content":[{"type":"output_text","text":"<thinking>private</thinking>"}]
        }]
    });
    let successful_attempt_view =
        super::responses_relay_runtime_tests::responses_relay_hook_successful_attempt_view(
            "anthropic-sse-thinking-literal",
            json!({"model":"client-model"}),
            V3HubProviderWireProtocol::Responses,
        );
    let manifest = super::responses_relay_runtime_tests::anthropic_then_openai_chat_manifest();
    let mut trace = Vec::new();
    let (response, _) = run_json_response_hooks(
        V3ResponsesRelayJsonResponseHookInput {
            session_id: "anthropic-sse-thinking-literal",
            request_id: "anthropic-sse-thinking-literal",
            provider_value: &provider_response,
            provider_semantic_body: &json!({"model":"client-model"}),
            manifest: &manifest,
            server_id: "test",
            provider_id: Some("anthropic_first"),
            expected_model_id: "claude-test",
            provider_protocol: V3HubProviderWireProtocol::Responses,
            source_provider_protocol: V3HubProviderWireProtocol::Anthropic,
            projection_context: &V3AnthropicResponsesProjectionContext::default(),
            successful_attempt_view: &successful_attempt_view,
            provider_response_transport_intent: V3HubTransportIntent::Sse,
            compatibility_profile: None,
            web_search_execution_mode: routecodex_v3_config::V3WebSearchExecutionMode::None,
            web_search_center_state: None,
            retain_response_cipher: false,
            tool_thinking_enabled: false,
            tool_thinking_turn_context: &V3ToolThinkingTurnContext::disabled(),
        },
        &mut trace,
    )
    .expect("Anthropic SSE whole-item literal must pass through Resp03");
    let serialized = serde_json::to_string(&response).unwrap();
    assert!(
        serialized.contains("<thinking>private</thinking>"),
        "whole-item `<thinking>` literal must stay visible: {serialized}"
    );
}

#[test]
fn openai_chat_provider_usage_normalizes_to_hub_canonical_token_names() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "id": "chatcmpl_usage_shape",
            "choices": [{
                "message": {"role": "assistant", "content": "ok"},
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": 11,
                "prompt_tokens_details": {"cached_tokens": 5},
                "completion_tokens": 7,
                "completion_tokens_details": {"reasoning_tokens": 2},
                "total_tokens": 18
            }
        }),
        &json!({"tools":[]}),
    )
    .expect("OpenAI Chat response must project to Responses");

    assert_eq!(response["usage"]["input_tokens"], 11);
    assert_eq!(
        response["usage"]["input_tokens_details"]["cached_tokens"],
        5
    );
    assert_eq!(response["usage"]["output_tokens"], 7);
    assert_eq!(
        response["usage"]["output_tokens_details"]["reasoning_tokens"],
        2
    );
    assert_eq!(response["usage"]["total_tokens"], 18);
    assert!(
        response["usage"].get("prompt_tokens").is_none(),
        "Hub canonical response usage must not expose OpenAI Chat provider-wire prompt_tokens: {response}"
    );
    assert!(
        response["usage"].get("completion_tokens").is_none(),
        "Hub canonical response usage must not expose OpenAI Chat provider-wire completion_tokens: {response}"
    );
}

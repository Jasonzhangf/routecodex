//! Responses -> OpenAI Chat provider-wire field parity.
//!
//! Continuation was removed from V3: these cases only pin request/response field
//! projection and malformed-argument preservation on the current Relay runtime.

use routecodex_v3_runtime::{
    characterize_v3_openai_chat_client_input_to_hub_semantic,
    characterize_v3_openai_chat_hub_response_semantic_to_client_projection,
    characterize_v3_openai_chat_hub_semantic_to_provider_wire,
    characterize_v3_openai_chat_provider_raw_to_hub_response_semantic,
    execute_v3_responses_relay_runtime, V3HubEntryProtocol, V3HubProviderWireProtocol,
    V3HubTransportIntent,
};
use std::sync::Mutex;

struct ProviderProjectionJsonTransport {
    captures: Mutex<Vec<(String, serde_json::Value)>>,
    response: serde_json::Value,
}

#[async_trait::async_trait]
impl routecodex_v3_provider_responses::ResponsesTransport for ProviderProjectionJsonTransport {
    async fn send(
        &self,
        request: routecodex_v3_provider_responses::V3Transport13ResponsesHttpRequest,
    ) -> Result<
        routecodex_v3_provider_responses::V3ProviderResp14Raw,
        routecodex_v3_provider_responses::V3ProviderError,
    > {
        self.captures
            .lock()
            .unwrap()
            .push((request.url().to_string(), request.body().clone()));
        Ok(
            routecodex_v3_provider_responses::V3ProviderResp14Raw::from_json(
                request.request_id(),
                request.provider_id(),
                200,
                vec![routecodex_v3_provider_responses::V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"application/json".to_vec(),
                }],
                serde_json::to_vec(&self.response).unwrap(),
            ),
        )
    }
}

fn manifest_openai_chat_wire() -> routecodex_v3_config::V3Config05ManifestPublished {
    manifest_provider_wire("openai_chat")
}

fn manifest_provider_wire(protocol: &str) -> routecodex_v3_config::V3Config05ManifestPublished {
    let mut authoring = routecodex_v3_config::parse_v3_config_02_authoring(
            r#"
version = 3
[servers.chatwire]
bind = "127.0.0.1"
port = 5555
routing_group = "chatwire"
endpoints = ["responses"]
[servers.chatwire.execution]
allowed_modes = ["relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = {}
[providers.chatwire]
type = "openai_chat"
base_url = "http://chatwire.invalid/v1"
default_model = "chat-wire-model"
auth = { type = "api_key", entries = [{ alias = "controlled", env = "CONTROLLED_KEY" }] }
[providers.chatwire.models.chat-wire-model]
wire_name = "chat-wire-model"
supports_streaming = true
supports_thinking = true
capabilities = ["text", "tools", "reasoning", "web_search"]
[route_groups.chatwire.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "chatwire", model = "chat-wire-model", key = "controlled", priority = 1 }]
"#,
    )
    .unwrap();
    authoring
        .providers
        .get_mut("chatwire")
        .unwrap()
        .provider_type = protocol.to_owned();
    routecodex_v3_config::compile_v3_config_05_manifest(authoring).unwrap()
}

fn responses_relay_input(
    request_id: &str,
    payload: serde_json::Value,
) -> routecodex_v3_runtime::V3ResponsesRelayRuntimeInput {
    routecodex_v3_runtime::V3ResponsesRelayRuntimeInput {
        server_id: "chatwire".into(),
        failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
            "test-server",
            "test-group",
            concat!(module_path!(), ":", line!()),
        )
        .unwrap(),
        request_id: request_id.into(),
        payload,
    }
}

fn provider_projection_body(capture: &(String, serde_json::Value)) -> &serde_json::Value {
    &capture.1
}

fn normalization_transport() -> ProviderProjectionJsonTransport {
    ProviderProjectionJsonTransport {
        captures: Mutex::new(Vec::new()),
        response: serde_json::json!({
            "id":"chatcmpl-normalization",
            "object":"chat.completion",
            "model":"chat-wire-model",
            "choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]
        }),
    }
}

#[tokio::test]
async fn responses_openai_chat_field_parity_dual_text_history_reaches_wire_once() {
    for messages in [
        serde_json::json!([{"role":"user","content":"hi"}]),
        serde_json::Value::Null,
    ] {
        let transport = normalization_transport();
        let result = execute_v3_responses_relay_runtime(
            &manifest_openai_chat_wire(),
            responses_relay_input(
                "req-dual-text-normalization",
                serde_json::json!({"input":"hi","messages":messages,"tools":[],"stream":false}),
            ),
            &transport,
        )
        .await
        .expect("equivalent optional history must reach provider wire once");
        assert!(result.error_chain.is_none());
        let captures = transport.captures.lock().unwrap();
        assert_eq!(captures.len(), 1);
        let body = provider_projection_body(&captures[0]);
        assert!(
            body.get("input").is_none(),
            "raw input cannot reach Chat wire"
        );
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"][0]["content"], "hi");
    }
}

#[tokio::test]
async fn responses_openai_chat_field_parity_legacy_tool_output_normalizes_before_wire() {
    for (name, output_type, repeated_result) in [
        ("lookup", "function_call_output", false),
        ("apply_patch", "custom_tool_call_output", false),
        ("apply_patch", "custom_tool_call_output", true),
    ] {
        let transport = normalization_transport();
        let arguments = "{\"q\":\"preserve exact arguments\"}";
        let output = "tool failure remains data\r\nexpected line";
        let mut messages = vec![serde_json::json!({"role":"assistant","tool_calls":[{
            "id":"call_legacy","type":"function",
            "function":{"name":name,"arguments":arguments}
        }]})];
        if repeated_result {
            messages.push(
                serde_json::json!({"role":"tool","tool_call_id":"call_legacy","content":output}),
            );
        }
        let result = execute_v3_responses_relay_runtime(
            &manifest_openai_chat_wire(),
            responses_relay_input(
                "req-legacy-tool-normalization",
                serde_json::json!({
                    "messages":messages,
                    "input":[{"type":output_type,"call_id":"call_legacy","output":output}],
                    "stream":false
                }),
            ),
            &transport,
        )
        .await
        .expect("legacy paired tool result must normalize into Chat before projection");
        assert!(result.error_chain.is_none());
        let captures = transport.captures.lock().unwrap();
        assert_eq!(captures.len(), 1);
        let body = provider_projection_body(&captures[0]);
        assert!(body.get("input").is_none());
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["tool_calls"][0]["id"], "call_legacy");
        assert_eq!(messages[0]["tool_calls"][0]["function"]["name"], name);
        assert_eq!(
            messages[0]["tool_calls"][0]["function"]["arguments"],
            arguments
        );
        assert_eq!(messages[1]["role"], "tool");
        assert_eq!(messages[1]["tool_call_id"], "call_legacy");
        assert_eq!(messages[1]["content"], output);
    }
}

#[tokio::test]
async fn responses_openai_chat_field_parity_normalization_preserves_failure_boundaries() {
    for (payload, expected) in [
        (
            serde_json::json!({"input":"hi","messages":[{"role":"user","content":"hi"}],"tools":"not-an-array"}),
            "$.tools",
        ),
        (
            serde_json::json!({"input":"hi","messages":[{"role":"user","content":"different"}]}),
            "conflicting input and messages",
        ),
        (
            serde_json::json!({"messages":[{"role":"assistant","tool_calls":[{"id":"call_known","type":"function","function":{"name":"lookup","arguments":"{}"}}]}],"input":[{"type":"function_call_output","call_id":"call_orphan","output":"unpaired"}]}),
            "orphan tool output",
        ),
        (
            serde_json::json!({"messages":[{"role":"assistant","tool_calls":[{"id":"call_known","type":"function","function":{"name":"lookup","arguments":"{}"}}]}],"input":[{"type":"custom_tool_call_output","call_id":"call_known","output":"wrong kind"}]}),
            "tool output kind mismatch",
        ),
        (
            serde_json::json!({"messages":[{"role":"assistant","tool_calls":[{"id":"call_known","type":"function","function":{"name":"lookup","arguments":"{}"}}]},{"role":"tool","tool_call_id":"call_known","content":"old"}],"input":[{"type":"function_call_output","call_id":"call_known","output":"different"}]}),
            "conflicting tool output",
        ),
    ] {
        let transport = normalization_transport();
        let result = execute_v3_responses_relay_runtime(
            &manifest_openai_chat_wire(),
            responses_relay_input("req-normalization-negative", payload),
            &transport,
        )
        .await;
        let message = match result {
            Err(error) => error.to_string(),
            Ok(output) => {
                assert_eq!(output.status, 598);
                assert!(output.error_chain.is_some());
                let routecodex_v3_runtime::V3ResponsesRelayClientBody::Json(body) =
                    output.client_body
                else {
                    panic!("JSON negative request must project a JSON error");
                };
                body["error"]["message"]
                    .as_str()
                    .expect("explicit client error")
                    .to_owned()
            }
        };
        assert!(message.contains(expected), "{message}");
        assert!(
            !message.contains("UnmappedOutboundFields target_protocol=openai_chat paths=$.input"),
            "{message}"
        );
        assert!(transport.captures.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn responses_openai_chat_field_parity_equivalent_tool_histories_merge_annotations() {
    let transport = normalization_transport();
    let result = execute_v3_responses_relay_runtime(
        &manifest_openai_chat_wire(),
        responses_relay_input("req-dual-tool-history", serde_json::json!({
            "messages":[
                {"role":"assistant","tool_calls":[{"id":"call_full","type":"function","function":{"name":"lookup","arguments":"{}"}}]},
                {"role":"tool","tool_call_id":"call_full","content":"done"}
            ],
            "input":[
                {"type":"function_call","id":"fc_source","call_id":"call_full","name":"lookup","arguments":"{}"},
                {"type":"function_call_output","id":"fco_source","call_id":"call_full","output":"done"}
            ],
            "stream":false
        })),
        &transport,
    ).await.expect("equivalent complete tool history must merge codec annotations");
    assert_eq!(result.status, 200);
    assert!(result.error_chain.is_none());
    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1);
    let body = provider_projection_body(&captures[0]);
    assert!(body.get("input").is_none());
    assert_eq!(body["messages"].as_array().unwrap().len(), 2);
    assert_eq!(body["messages"][0]["tool_calls"][0]["id"], "call_full");
    assert_eq!(body["messages"][1]["content"], "done");
}

#[tokio::test]
async fn responses_openai_chat_field_parity_tool_output_extra_fields_roundtrip_or_fail_explicitly()
{
    let payload = serde_json::json!({
        "messages":[{"role":"assistant","tool_calls":[{"id":"call_extra","type":"function","function":{"name":"lookup","arguments":"{}"}}]}],
        "input":[{"type":"function_call_output","id":"fco_extra","status":"completed","call_id":"call_extra","output":"done","opaque_business":{"ticket":42}}],
        "stream":false
    });
    let transport = ProviderProjectionJsonTransport {
        captures: Mutex::new(Vec::new()),
        response: serde_json::json!({"id":"resp-extra","object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}]}),
    };
    let result = execute_v3_responses_relay_runtime(
        &manifest_provider_wire("responses"),
        responses_relay_input("req-extra-roundtrip", payload.clone()),
        &transport,
    )
    .await
    .expect("opaque Responses fields must roundtrip to a Responses target");
    assert_eq!(result.status, 200);
    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1);
    let items = provider_projection_body(&captures[0])["input"]
        .as_array()
        .unwrap();
    let output = items
        .iter()
        .find(|item| item["type"] == "function_call_output")
        .unwrap();
    assert_eq!(output["call_id"], "call_extra");
    assert_eq!(output["output"], "done");
    assert_eq!(output["id"], "fc_fco_extra");
    assert_eq!(output["status"], "completed");
    assert_eq!(output["opaque_business"], serde_json::json!({"ticket":42}));
    drop(captures);

    let transport = normalization_transport();
    let result = execute_v3_responses_relay_runtime(
        &manifest_openai_chat_wire(),
        responses_relay_input("req-extra-unmapped", payload),
        &transport,
    )
    .await
    .expect("unmapped target field must enter the typed error projection");
    assert_eq!(result.status, 598);
    let routecodex_v3_runtime::V3ResponsesRelayClientBody::Json(body) = result.client_body else {
        panic!("JSON request requires JSON error");
    };
    let message = body["error"]["message"].as_str().unwrap();
    assert!(message.contains("UnmappedOutboundFields"), "{message}");
    assert!(
        message.contains("responses_tool_output_extra_fields"),
        "{message}"
    );
    assert!(transport.captures.lock().unwrap().is_empty());
}

#[tokio::test]
async fn responses_openai_chat_field_parity_named_tool_output_extra_fields_roundtrip() {
    let transport = ProviderProjectionJsonTransport {
        captures: Mutex::new(Vec::new()),
        response: serde_json::json!({"id":"resp-named-extra","object":"response","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}]}),
    };
    let result = execute_v3_responses_relay_runtime(
        &manifest_provider_wire("responses"),
        responses_relay_input("req-named-extra-roundtrip", serde_json::json!({
            "input":[{"type":"function_call_output","name":"lookup","namespace":"client","output":"done","opaque_business":{"ticket":42}}],
            "stream":false
        })),
        &transport,
    ).await.expect("named result fields must survive Responses projection");
    assert_eq!(result.status, 200);
    let captures = transport.captures.lock().unwrap();
    let items = provider_projection_body(&captures[0])["input"]
        .as_array()
        .unwrap();
    let output = items
        .iter()
        .find(|item| item["type"] == "function_call_output")
        .expect("named result must retain its registered dispatch identity");
    assert_eq!(output["name"], "lookup");
    assert_eq!(output["namespace"], "client");
    assert_eq!(output["output"], "done");
    assert_eq!(output["opaque_business"], serde_json::json!({"ticket":42}));
    assert!(output.get("call_id").is_none());
}

#[test]
fn responses_openai_chat_field_parity_request_matrix() {
    let request = serde_json::json!({
        "model": "gpt-chat",
        "messages": [{"role": "user", "content": "preserve request fields"}],
        "temperature": 0.2,
        "stream": false,
        "metadata": {"trace": "request-matrix"}
    });
    let hub = characterize_v3_openai_chat_client_input_to_hub_semantic(
        request.clone(),
        V3HubEntryProtocol::OpenAiChat,
        V3HubTransportIntent::Json,
    )
    .expect("request must normalize into the Hub semantic");
    assert_eq!(hub.payload(), &request);
    let provider = characterize_v3_openai_chat_hub_semantic_to_provider_wire(hub)
        .expect("request must project to the OpenAI Chat provider wire");
    assert_eq!(provider.payload(), &request);
}

#[test]
fn responses_openai_chat_field_parity_response_matrix() {
    let response = serde_json::json!({
        "id": "chatcmpl-response-matrix",
        "object": "chat.completion",
        "model": "gpt-chat",
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": "preserve response fields"},
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 3, "completion_tokens": 4, "total_tokens": 7}
    });
    let hub = characterize_v3_openai_chat_provider_raw_to_hub_response_semantic(
        response.clone(),
        V3HubProviderWireProtocol::OpenAiChat,
        V3HubTransportIntent::Json,
    )
    .expect("response must normalize from the OpenAI Chat provider wire");
    assert_eq!(hub.payload(), &response);
    let client = characterize_v3_openai_chat_hub_response_semantic_to_client_projection(hub)
        .expect("response must project to the client semantic");
    assert_eq!(client.payload(), &response);
}

#[tokio::test]
async fn responses_openai_chat_field_parity_request_matrix_runtime() {
    let transport = ProviderProjectionJsonTransport {
        captures: Mutex::new(Vec::new()),
        response: serde_json::json!({
            "id":"chatcmpl-field-parity-request",
            "object":"chat.completion",
            "model":"chat-wire-model",
            "choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]
        }),
    };
    let result = execute_v3_responses_relay_runtime(
        &manifest_openai_chat_wire(),
        responses_relay_input(
            "req-responses-openai-chat-field-request",
            serde_json::json!({
                "model":"gpt-5.5",
                "stream":false,
                "instructions":"field parity system",
                "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"run request matrix"}]}],
                "tools":[{"type":"function","name":"lookup","description":"Lookup docs","parameters":{"type":"object","properties":{"q":{"type":"string"}},"required":["q"]},"strict":true}],
                "tool_choice":{"type":"function","name":"lookup"},
                "parallel_tool_calls":false,
                "user":"user-field-matrix",
                "temperature":0.3,
                "top_p":0.8,
                "logit_bias":{"42":1},
                "seed":123,
                "response_format":{"type":"json_object"},
                "reasoning":{"effort":"medium"},
                "max_output_tokens":321,
                "metadata":{"client":"metadata-kept"},
                "stop":["<END>"]
            }),
        ),
        &transport,
    )
    .await
    .expect("Responses -> OpenAI Chat request field parity must execute");

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1);
    let body = provider_projection_body(&captures[0]);
    assert_eq!(captures[0].0, "http://chatwire.invalid/v1/chat/completions");
    assert_eq!(body["reasoning_effort"], "medium");
    assert_eq!(body["max_completion_tokens"], 321);
    assert_eq!(
        body["metadata"],
        serde_json::json!({"client":"metadata-kept"})
    );
    assert!(
        body.get("reasoning").is_none(),
        "OpenAI Chat provider wire must map only Responses reasoning.effort to reasoning_effort"
    );
    assert!(result.error_chain.is_none());
}

#[tokio::test]
async fn responses_openai_chat_field_parity_rejects_malformed_client_metadata_before_provider_capture(
) {
    let transport = ProviderProjectionJsonTransport {
        captures: Mutex::new(Vec::new()),
        response: serde_json::json!({}),
    };
    let error = execute_v3_responses_relay_runtime(
        &manifest_openai_chat_wire(),
        responses_relay_input(
            "req-responses-openai-chat-client-metadata-reject",
            serde_json::json!({
                "model":"gpt-5.5",
                "stream":false,
                "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"reject client metadata"}]}],
                "client_metadata":"client-metadata-must-be-an-object"
            }),
        ),
        &transport,
    )
    .await
    .expect_err("malformed client_metadata must fail before provider send");
    assert!(error
        .to_string()
        .contains("metadata/client_metadata must be an object"));
    assert_eq!(
        transport.captures.lock().unwrap().len(),
        0,
        "OpenAI Chat provider wire must reject unsupported client_metadata before provider capture"
    );
}

#[tokio::test]
async fn responses_openai_chat_field_parity_paired_malformed_arguments_preserve_exact_string_without_reselect(
) {
    let call_id = "call_e7896581c85649b58531dfc2";
    let malformed_arguments = "{\"cmd\":\"find v2\"}{\"cmd\":\"cat bootstrap.mjs\"}";
    let parse_failure_output =
        "failed to parse function arguments: trailing characters at line 1 column 18";
    let transport = ProviderProjectionJsonTransport {
        captures: Mutex::new(Vec::new()),
        response: serde_json::json!({
            "id":"chatcmpl-malformed-projected-paired",
            "object":"chat.completion",
            "model":"chat-wire-model",
            "choices":[{"index":0,"message":{"role":"assistant","content":"projected paired malformed arguments"},"finish_reason":"stop"}]
        }),
    };
    let result = execute_v3_responses_relay_runtime(
        &manifest_openai_chat_wire(),
        responses_relay_input(
            "req-malformed-feedback",
            serde_json::json!({
                "model":"gpt-5.5",
                "stream":false,
                "input":[
                    {"type":"function_call","call_id":call_id,"name":"exec_command","arguments":malformed_arguments},
                    {"type":"function_call_output","call_id":call_id,"output":parse_failure_output}
                ]
            }),
        ),
        &transport,
    )
    .await
    .expect("paired malformed OpenAI Chat arguments must preserve their exact string without provider reselect");

    assert!(result.error_chain.is_none());
    assert!(
        !result.node_trace.contains(&"V3TargetLocalReselected"),
        "paired malformed OpenAI Chat arguments must not trigger Error05 reselect: {:?}",
        result.node_trace
    );
    let observability = result.observability.as_ref().expect("observability");
    assert!(
        observability.provider_failure_events.is_empty(),
        "projectable malformed arguments must not be wrapped as provider failure: {observability:?}"
    );
    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1);
    assert_eq!(
        captures[0].0, "http://chatwire.invalid/v1/chat/completions",
        "the selected OpenAI Chat target must receive the provider request without reselect"
    );
    let provider_body = provider_projection_body(&captures[0]);
    let tool_call_message = provider_body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message.get("tool_calls").is_some())
        .expect("assistant tool_call message");
    let wire_arguments = tool_call_message["tool_calls"][0]["function"]["arguments"]
        .as_str()
        .expect("wire arguments string");
    assert_eq!(
        wire_arguments, malformed_arguments,
        "OpenAI Chat function.arguments must preserve the exact original string bytes"
    );
    let tool_result_message = provider_body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message["role"] == "tool")
        .expect("paired tool result message");
    assert_eq!(
        tool_result_message["tool_call_id"], call_id,
        "parse-failure tool result must remain paired"
    );
}

#[tokio::test]
async fn responses_openai_chat_field_parity_unpaired_malformed_arguments_preserve_exact_string_without_reselect(
) {
    let call_id = "call_unpaired_malformed";
    let malformed_arguments = "{\"cmd\":\"one\"}{\"cmd\":\"two\"}";
    let transport = ProviderProjectionJsonTransport {
        captures: Mutex::new(Vec::new()),
        response: serde_json::json!({
            "id":"chatcmml-malformed-projected-unpaired",
            "object":"chat.completion",
            "model":"chat-wire-model",
            "choices":[{"index":0,"message":{"role":"assistant","content":"projected unpaired malformed arguments"},"finish_reason":"stop"}]
        }),
    };
    let result = execute_v3_responses_relay_runtime(
        &manifest_openai_chat_wire(),
        responses_relay_input(
            "req-malformed-unpaired",
            serde_json::json!({
                "model":"gpt-5.5",
                "stream":false,
                "input":[{"type":"function_call","call_id":call_id,"name":"exec_command","arguments":malformed_arguments}]
            }),
        ),
        &transport,
    )
    .await
    .expect("unpaired malformed OpenAI Chat arguments must preserve their exact string without provider reselect");
    assert!(result.error_chain.is_none());
    assert!(
        !result.node_trace.contains(&"V3TargetLocalReselected"),
        "unpaired malformed OpenAI Chat arguments must not trigger Error05 reselect: {:?}",
        result.node_trace
    );
    let observability = result.observability.as_ref().expect("observability");
    assert!(
        observability.provider_failure_events.is_empty(),
        "projectable malformed arguments must not be wrapped as provider failure: {observability:?}"
    );
    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1);
    let provider_body = provider_projection_body(&captures[0]);
    let tool_call_message = provider_body["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message.get("tool_calls").is_some())
        .expect("assistant tool_call message");
    let wire_arguments = tool_call_message["tool_calls"][0]["function"]["arguments"]
        .as_str()
        .expect("wire arguments string");
    assert_eq!(
        wire_arguments, malformed_arguments,
        "OpenAI Chat function.arguments must preserve the exact original string bytes"
    );
}

#[tokio::test]
async fn responses_openai_chat_field_parity_web_search_call_history_projects_tool_pair() {
    let transport = ProviderProjectionJsonTransport {
        captures: Mutex::new(Vec::new()),
        response: serde_json::json!({
            "id":"chatcmpl-web-search-history",
            "object":"chat.completion",
            "model":"chat-wire-model",
            "choices":[{"index":0,"message":{"role":"assistant","content":"continued"},"finish_reason":"stop"}]
        }),
    };
    let result = execute_v3_responses_relay_runtime(
        &manifest_openai_chat_wire(),
        responses_relay_input(
            "req-responses-openai-chat-web-search-history",
            serde_json::json!({
                "model":"gpt-5.5",
                "stream":false,
                "input":[
                    {"type":"web_search_call","status":"failed","action":{"type":"search","query":"微信小程序 发布流程","queries":["微信小程序 发布流程"]}},
                    {"type":"message","role":"user","content":[{"type":"input_text","text":"继续"}]}
                ]
            }),
        ),
        &transport,
    )
    .await
    .expect("Responses web_search_call history must reach OpenAI Chat provider wire");
    let captures = transport.captures.lock().unwrap();
    let body = provider_projection_body(&captures[0]);
    let messages = body["messages"]
        .as_array()
        .expect("OpenAI Chat provider messages");
    let pair_start = messages
        .iter()
        .position(|message| message.get("tool_calls").is_some())
        .expect("provider messages must include assistant web_search tool_call");
    assert_eq!(
        messages[pair_start]["tool_calls"][0]["function"]["name"],
        "web_search"
    );
    assert_eq!(messages[pair_start + 1]["role"], "tool");
    assert_eq!(
        messages[pair_start + 1]["tool_call_id"],
        messages[pair_start]["tool_calls"][0]["id"]
    );
    assert_eq!(
        messages.last().unwrap(),
        &serde_json::json!({"role":"user","content":"继续"})
    );
    assert!(result.error_chain.is_none());
}

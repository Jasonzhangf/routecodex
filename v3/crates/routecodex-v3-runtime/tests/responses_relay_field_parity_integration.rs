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
    V3HubTransportIntent, V3ResponsesRelayClientBody,
};
use std::sync::Mutex;

struct ProviderProjectionJsonTransport {
    captures: Mutex<Vec<(String, serde_json::Value)>>,
    response: serde_json::Value,
}

struct ProviderProjectionSseTransport {
    captures: Mutex<Vec<(String, serde_json::Value)>>,
}

#[async_trait::async_trait]
impl routecodex_v3_provider_responses::ResponsesTransport for ProviderProjectionSseTransport {
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
        let frames = [
            r#"data: {"id":"chatcmpl-codex-exec-sse","object":"chat.completion.chunk","model":"chat-wire-model","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_exec_sse","type":"function","function":{"name":"exec","arguments":""}}]},"finish_reason":null}]}"#,
            r#"data: {"id":"chatcmpl-codex-exec-sse","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"input\":\"text(1 + 1)\\n\"}"}}]},"finish_reason":null}]}"#,
            r#"data: {"id":"chatcmpl-codex-exec-sse","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#,
            "data: [DONE]",
        ];
        let chunks = frames
            .into_iter()
            .map(|frame| Ok(format!("{frame}\n\n").into_bytes()));
        Ok(
            routecodex_v3_provider_responses::V3ProviderResp14Raw::from_sse(
                request.request_id().to_string(),
                request.provider_id().to_string(),
                200,
                vec![routecodex_v3_provider_responses::V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"text/event-stream".to_vec(),
                }],
                Box::pin(futures_util::stream::iter(chunks)),
            ),
        )
    }
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
    routecodex_v3_config::compile_v3_config_05_manifest(
        routecodex_v3_config::parse_v3_config_02_authoring(
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
        .unwrap(),
    )
    .unwrap()
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
async fn responses_openai_chat_namespace_exec_function_call_restored_runtime() {
    let transport = ProviderProjectionJsonTransport {
        captures: Mutex::new(Vec::new()),
        response: serde_json::json!({
            "id":"chatcmpl-codex-exec",
            "object":"chat.completion",
            "model":"chat-wire-model",
            "choices":[{"index":0,"message":{"role":"assistant","tool_calls":[{
                "id":"call_exec_1",
                "type":"function",
                "function":{"name":"exec","arguments":"{\"input\":\"text(1 + 1)\\n\"}"}
            }]},"finish_reason":"tool_calls"}]
        }),
    };
    let result = execute_v3_responses_relay_runtime(
        &manifest_openai_chat_wire(),
        responses_relay_input(
            "req-responses-openai-chat-codex-exec-namespace",
            serde_json::json!({
                "model":"gpt-5.5",
                "stream":false,
                "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"2 + 2"}]}],
                "tools":[{"type":"namespace","name":"functions","tools":[{"type":"function","name":"exec","parameters":{"type":"object","properties":{"input":{"type":"string"}},"required":["input"]}}]}]
            }),
        ),
        &transport,
    )
    .await
    .expect("Codex function tool call must complete the Responses Relay path");

    let response = match &result.client_body {
        V3ResponsesRelayClientBody::Json(body) => body,
        V3ResponsesRelayClientBody::Sse(_) => panic!("request selected JSON response transport"),
    };
    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1, "provider must receive the request");
    assert!(
        captures[0].1["tools"].as_array().is_some_and(|tools| {
            tools
                .iter()
                .any(|tool| tool["function"]["name"] == "functions__exec")
        }),
        "provider wire must advertise the namespaced Codex tool"
    );
    assert_eq!(result.status, 200, "client response: {response}");
    assert_eq!(response["status"], "requires_action");
    assert_eq!(response["output"][0]["type"], "function_call");
    assert_eq!(response["output"][0]["namespace"], "functions");
    assert_eq!(response["output"][0]["name"], "exec");
    assert_eq!(response["output"][0]["call_id"], "call_exec_1");
    assert_eq!(
        response["output"][0]["arguments"],
        "{\"input\":\"text(1 + 1)\\n\"}"
    );
    assert!(result.error_chain.is_none());
}

#[tokio::test]
async fn responses_openai_chat_namespace_custom_leaf_exec_restores_dispatch_json() {
    let raw_input = "const r = await tools.clock__curr_time({}); text(JSON.stringify(r));\n";
    let transport = ProviderProjectionJsonTransport {
        captures: Mutex::new(Vec::new()),
        response: serde_json::json!({
            "id":"chatcmpl-codex-custom-exec",
            "object":"chat.completion",
            "model":"chat-wire-model",
            "choices":[{"index":0,"message":{"role":"assistant","tool_calls":[{
                "id":"call_custom_exec",
                "type":"function",
                "function":{"name":"exec","arguments":serde_json::json!({"input":raw_input}).to_string()}
            }]},"finish_reason":"tool_calls"}]
        }),
    };
    let result = execute_v3_responses_relay_runtime(
        &manifest_openai_chat_wire(),
        responses_relay_input(
            "req-responses-openai-chat-codex-custom-leaf-exec",
            serde_json::json!({
                "model":"gpt-6-luna",
                "stream":false,
                "input":[
                    {"type":"message","role":"user","content":[{"type":"input_text","text":"read the clock"}]},
                    {"type":"additional_tools","tools":[{"type":"namespace","name":"functions","tools":[{
                        "type":"custom","name":"exec","description":"Run tools",
                        "format":{"type":"grammar","syntax":"lark","definition":"start: /.+/"}
                    }]}]}
                ]
            }),
        ),
        &transport,
    )
    .await
    .expect("declared Codex custom tool must project through Responses Relay");

    let response = match &result.client_body {
        V3ResponsesRelayClientBody::Json(body) => body,
        V3ResponsesRelayClientBody::Sse(_) => panic!("request selected JSON response transport"),
    };
    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1);
    assert!(captures[0].1["tools"].as_array().is_some_and(|tools| {
        tools
            .iter()
            .any(|tool| tool["function"]["name"] == "functions__exec")
    }));
    assert_eq!(result.status, 200);
    assert_eq!(response["status"], "requires_action");
    assert_eq!(response["output"][0]["type"], "custom_tool_call");
    assert_eq!(response["output"][0]["name"], "exec");
    assert_eq!(response["output"][0]["call_id"], "call_custom_exec");
    assert_eq!(response["output"][0]["input"], raw_input);
    assert!(response["output"][0].get("arguments").is_none());

    let tool_call = response["output"][0].clone();
    drop(captures);
    let followup = ProviderProjectionJsonTransport {
        captures: Mutex::new(Vec::new()),
        response: serde_json::json!({
            "id":"chatcmpl-codex-custom-exec-followup",
            "object":"chat.completion",
            "model":"chat-wire-model",
            "choices":[{"index":0,"message":{"role":"assistant","content":"The clock tool returned 12:34."},"finish_reason":"stop"}]
        }),
    };
    let followup_result = execute_v3_responses_relay_runtime(
        &manifest_openai_chat_wire(),
        responses_relay_input(
            "req-responses-openai-chat-codex-custom-leaf-exec-followup",
            serde_json::json!({
                "model":"gpt-6-luna",
                "stream":false,
                "input":[
                    {"type":"message","role":"user","content":[{"type":"input_text","text":"read the clock"}]},
                    tool_call,
                    {"type":"custom_tool_call_output","call_id":"call_custom_exec","output":"12:34"},
                    {"type":"additional_tools","tools":[{"type":"namespace","name":"functions","tools":[{
                        "type":"custom","name":"exec","description":"Run tools",
                        "format":{"type":"grammar","syntax":"lark","definition":"start: /.+/"}
                    }]}]}
                ]
            }),
        ),
        &followup,
    )
    .await
    .expect("client custom tool output must reach the same provider call_id");
    assert_eq!(followup_result.status, 200);
    let followup_captures = followup.captures.lock().unwrap();
    assert_eq!(followup_captures.len(), 1);
    let messages = followup_captures[0].1["messages"].as_array().unwrap();
    assert!(messages.iter().any(|message| message["role"] == "assistant"
        && message["tool_calls"][0]["id"] == "call_custom_exec"));
    assert!(messages.iter().any(|message| message["role"] == "tool"
        && message["tool_call_id"] == "call_custom_exec"
        && message["content"] == "12:34"));
}

#[tokio::test]
async fn responses_openai_chat_namespace_custom_leaf_exec_restores_dispatch_sse() {
    use futures_util::StreamExt;

    let transport = ProviderProjectionSseTransport {
        captures: Mutex::new(Vec::new()),
    };
    let result = execute_v3_responses_relay_runtime(
        &manifest_openai_chat_wire(),
        responses_relay_input(
            "req-responses-openai-chat-codex-custom-leaf-exec-sse",
            serde_json::json!({
                "model":"gpt-6-luna",
                "stream":true,
                "input":[
                    {"type":"message","role":"user","content":[{"type":"input_text","text":"read the clock"}]},
                    {"type":"additional_tools","tools":[{"type":"namespace","name":"functions","tools":[{
                        "type":"custom","name":"exec","description":"Run tools",
                        "format":{"type":"grammar","syntax":"lark","definition":"start: /.+/"}
                    }]}]}
                ]
            }),
        ),
        &transport,
    )
    .await
    .expect("Codex custom tool call must project through Responses SSE");
    assert_eq!(result.status, 200);
    assert!(transport.captures.lock().unwrap()[0].1["tools"]
        .as_array()
        .is_some_and(|tools| tools
            .iter()
            .any(|tool| tool["function"]["name"] == "functions__exec")));

    let mut stream = match result.client_body {
        V3ResponsesRelayClientBody::Sse(stream) => stream,
        V3ResponsesRelayClientBody::Json(_) => panic!("stream request must project SSE"),
    };
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        bytes.extend(chunk);
    }
    let client_sse = String::from_utf8(bytes).expect("client SSE must be valid UTF-8");
    assert!(
        client_sse.contains("event: response.output_item.done"),
        "{client_sse}"
    );
    assert!(
        client_sse.contains("\"type\":\"custom_tool_call\""),
        "{client_sse}"
    );
    assert!(client_sse.contains("\"name\":\"exec\""), "{client_sse}");
    assert!(
        client_sse.contains("\"call_id\":\"call_exec_sse\""),
        "{client_sse}"
    );
    assert!(
        client_sse.contains("\"input\":\"text(1 + 1)\\n\""),
        "{client_sse}"
    );
    assert!(
        client_sse.contains("event: response.completed"),
        "{client_sse}"
    );
}

#[tokio::test]
async fn responses_openai_chat_namespace_exec_function_call_restored_sse_runtime() {
    use futures_util::StreamExt;

    let transport = ProviderProjectionSseTransport {
        captures: Mutex::new(Vec::new()),
    };
    let result = execute_v3_responses_relay_runtime(
        &manifest_openai_chat_wire(),
        responses_relay_input(
            "req-responses-openai-chat-codex-exec-namespace-sse",
            serde_json::json!({
                "model":"gpt-5.5",
                "stream":true,
                "input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"2 + 2"}]}],
                "tools":[{"type":"namespace","name":"functions","tools":[{"type":"function","name":"exec","parameters":{"type":"object","properties":{"input":{"type":"string"}},"required":["input"]}}]}]
            }),
        ),
        &transport,
    )
    .await
    .expect("Codex function tool SSE must complete the Responses Relay path");

    assert_eq!(result.status, 200);
    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1, "provider must receive the request");
    assert_eq!(captures[0].1["stream"], true);
    assert!(
        captures[0].1["tools"].as_array().is_some_and(|tools| {
            tools
                .iter()
                .any(|tool| tool["function"]["name"] == "functions__exec")
        }),
        "provider wire must advertise the namespaced Codex tool"
    );
    drop(captures);

    let mut stream = match result.client_body {
        V3ResponsesRelayClientBody::Sse(stream) => stream,
        V3ResponsesRelayClientBody::Json(_) => panic!("stream request must project SSE"),
    };
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        bytes.extend(chunk);
    }
    let client_sse = String::from_utf8(bytes).expect("client SSE must be valid UTF-8");
    assert!(client_sse.contains("event: response.function_call_arguments.done"));
    assert!(
        client_sse.contains("\"namespace\":\"functions\""),
        "{client_sse}"
    );
    assert!(client_sse.contains("\"name\":\"exec\""), "{client_sse}");
    assert!(
        client_sse.contains("\"call_id\":\"call_exec_sse\""),
        "{client_sse}"
    );
    let arguments_event = client_sse
        .split("event: response.function_call_arguments.done\n")
        .nth(1)
        .and_then(|event| event.strip_prefix("data: "))
        .and_then(|data| data.lines().next())
        .expect("SSE must include a complete function_call_arguments.done event");
    let arguments_event: serde_json::Value =
        serde_json::from_str(arguments_event).expect("arguments event data must be JSON");
    assert_eq!(arguments_event["arguments"], r#"{"input":"text(1 + 1)\n"}"#);
    assert!(client_sse.contains("event: response.completed"));
    assert!(client_sse.contains("event: response.done"));
    assert!(client_sse.contains("data: [DONE]"));
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

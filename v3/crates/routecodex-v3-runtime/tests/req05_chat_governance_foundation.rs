use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    build_v3_server_03_http_request_raw, execute_v3_responses_direct_runtime_kernel,
    execute_v3_responses_relay_runtime, register_responses_direct_hooks,
    V3ResponsesRelayRuntimeInput,
};
use serde_json::{json, Value};
use std::sync::Mutex;

const HISTORY_IMAGE_PLACEHOLDER: &str = "[Image]";

struct CapturingJsonTransport {
    captures: Mutex<Vec<(String, Value)>>,
    response: Value,
}

#[async_trait]
impl ResponsesTransport for CapturingJsonTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.captures
            .lock()
            .unwrap()
            .push((request.url().to_string(), request.body().clone()));
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

fn relay_manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
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
capabilities = ["text", "tools", "reasoning"]
[route_groups.chatwire.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "chatwire", model = "chat-wire-model", key = "controlled", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}

fn direct_manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[features]
[servers.direct]
bind = "127.0.0.1"
port = 5555
routing_group = "direct"
endpoints = ["responses"]
[servers.direct.execution]
allowed_modes = ["direct"]
allowed_invocation_sources = ["client", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = {}
[providers.responses]
type = "responses"
base_url = "http://direct.invalid/v1"
default_model = "direct-model"
auth = { type = "api_key", entries = [{ alias = "direct-key", env = "DIRECT_KEY" }] }
responses = { process = "direct", streaming = "always", transport = "http" }
[providers.responses.models.direct-model]
wire_name = "wire-m"
capabilities = ["text", "tools", "multimodal", "vision"]
supports_streaming = true
[route_groups.direct.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "responses", model = "direct-model", key = "direct-key", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}

fn responses_relay_input(request_id: &str, payload: Value) -> V3ResponsesRelayRuntimeInput {
    V3ResponsesRelayRuntimeInput {
        server_id: "chatwire".to_string(),
        failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
            "test-server",
            "test-group",
            format!("{}:{request_id}", module_path!()),
        )
        .expect("test failure scope"),
        request_id: request_id.to_string(),
        payload,
    }
}

fn direct_request(body: Value) -> routecodex_v3_runtime::V3Server03HttpRequestRaw {
    let scope = routecodex_v3_error::V3ProviderFailureSessionScope::new(
        "direct",
        "direct-group",
        "req-direct-governance",
    )
    .expect("direct failure scope")
    .with_transport_handoff_scope("direct-pipeline", 5555, 1)
    .expect("direct transport handoff scope");
    let mut raw = build_v3_server_03_http_request_raw(
        "direct".to_string(),
        scope,
        "req-direct-governance".to_string(),
        "exec-direct-governance".to_string(),
        "POST".to_string(),
        "/v1/responses".to_string(),
        body,
    );
    raw.port = Some(5555);
    raw.pipeline_id = Some("direct-pipeline".to_string());
    raw
}

fn provider_tool_call<'a>(messages: &'a [Value], call_id: &str) -> &'a Value {
    messages
        .iter()
        .find_map(|message| {
            message
                .get("tool_calls")
                .and_then(Value::as_array)
                .and_then(|calls| {
                    calls
                        .iter()
                        .find(|call| call.get("id").and_then(Value::as_str) == Some(call_id))
                })
        })
        .unwrap_or_else(|| panic!("tool call {call_id} missing from provider wire: {messages:?}"))
}

fn provider_tool_output<'a>(messages: &'a [Value], call_id: &str) -> &'a str {
    messages
        .iter()
        .find(|message| {
            message.get("role").and_then(Value::as_str) == Some("tool")
                && message.get("tool_call_id").and_then(Value::as_str) == Some(call_id)
        })
        .and_then(|message| message.get("content").and_then(Value::as_str))
        .unwrap_or_else(|| panic!("tool output {call_id} missing from provider wire: {messages:?}"))
}

#[tokio::test]
async fn relay_preserves_complete_tool_arguments_and_history_pairing() {
    let transport = CapturingJsonTransport {
        captures: Mutex::new(Vec::new()),
        response: json!({
            "id": "chatcmpl-req05-governance",
            "object": "chat.completion",
            "model": "chat-wire-model",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "ok"},
                "finish_reason": "stop"
            }]
        }),
    };
    let exec_arguments = "{ \"cmd\" : \"printf 'exec-ok'\" , \"yield_time_ms\" : 250 }";
    let patch = "*** Begin Patch\n*** Update File: src/lib.rs\n@@\n-old\n+new\n*** End Patch";
    let mcp_arguments = "{ \"action\" : \"list\" , \"workspace\" : \"routecodex\" }";

    let result = execute_v3_responses_relay_runtime(
        &relay_manifest(),
        responses_relay_input(
            "req-relay-governance",
            json!({
                "model": "gpt-5.5",
                "stream": false,
                "tools": [
                    {
                        "type": "function",
                        "name": "exec_command",
                        "parameters": {
                            "type": "object",
                            "properties": {"cmd": {"type": "string"}}
                        }
                    },
                    {
                        "type": "custom",
                        "name": "apply_patch",
                        "format": {"type": "text"}
                    },
                    {
                        "type": "namespace",
                        "name": "mcp__mcpx",
                        "tools": [{
                            "type": "function",
                            "name": "session",
                            "parameters": {"type": "object"}
                        }]
                    }
                ],
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "start"}]
                    },
                    {
                        "type": "function_call",
                        "id": "fc_exec",
                        "call_id": "call_exec",
                        "name": "exec_command",
                        "arguments": exec_arguments
                    },
                    {
                        "type": "function_call_output",
                        "call_id": "call_exec",
                        "output": "exec-ok"
                    },
                    {
                        "type": "custom_tool_call",
                        "id": "ctc_patch",
                        "call_id": "call_patch",
                        "name": "apply_patch",
                        "input": patch
                    },
                    {
                        "type": "custom_tool_call_output",
                        "call_id": "call_patch",
                        "output": "patch-ok"
                    },
                    {
                        "type": "function_call",
                        "id": "fc_mcp",
                        "call_id": "call_mcp",
                        "name": "session",
                        "namespace": "mcp__mcpx",
                        "arguments": mcp_arguments
                    },
                    {
                        "type": "function_call_output",
                        "call_id": "call_mcp",
                        "output": "{\"ok\":true}"
                    },
                    {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": "continue"}]
                    }
                ]
            }),
        ),
        &transport,
    )
    .await
    .expect("Relay runtime must accept complete tool history");

    assert_eq!(result.status, 200, "{result:?}");
    assert!(result.error_chain.is_none(), "{result:?}");

    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1);
    assert_eq!(
        captures[0].0, "http://chatwire.invalid/v1/chat/completions",
        "Relay request must reach the selected OpenAI Chat provider"
    );
    let provider_body = &captures[0].1;
    assert!(provider_body.get("input").is_none());
    assert!(
        !provider_body
            .to_string()
            .contains(HISTORY_IMAGE_PLACEHOLDER),
        "an image-free request must not gain history image placeholders: {provider_body}"
    );
    let messages = provider_body["messages"]
        .as_array()
        .expect("OpenAI Chat provider messages");

    let exec_call = provider_tool_call(messages, "call_exec");
    assert_eq!(exec_call["function"]["name"], "exec_command");
    assert_eq!(
        exec_call["function"]["arguments"], exec_arguments,
        "exec_command arguments must be forwarded byte-for-byte"
    );
    assert_eq!(provider_tool_output(messages, "call_exec"), "exec-ok");

    let patch_call = provider_tool_call(messages, "call_patch");
    assert_eq!(patch_call["function"]["name"], "apply_patch");
    assert_eq!(
        patch_call["function"]["arguments"],
        serde_json::to_string(&json!({"input": patch})).unwrap(),
        "free-text apply_patch input must be preserved without parsing it as JSON"
    );
    assert_eq!(provider_tool_output(messages, "call_patch"), "patch-ok");

    let mcp_call = provider_tool_call(messages, "call_mcp");
    assert_eq!(mcp_call["function"]["name"], "mcp__mcpx__session");
    assert_eq!(
        mcp_call["function"]["arguments"], mcp_arguments,
        "MCP arguments must be forwarded byte-for-byte"
    );
    assert_eq!(provider_tool_output(messages, "call_mcp"), "{\"ok\":true}");
    assert_eq!(
        messages.last(),
        Some(&json!({"role": "user", "content": "continue"}))
    );
}

#[tokio::test]
async fn direct_same_protocol_preserves_payload_and_image_history_rules() {
    let transport = CapturingJsonTransport {
        captures: Mutex::new(Vec::new()),
        response: json!({
            "id": "resp-direct-governance",
            "object": "response",
            "status": "completed",
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "ok"}]
            }]
        }),
    };
    let history_image_url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nKsAAAAASUVORK5CYII=";
    let current_image_url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lK3Q6wAAAABJRU5ErkJggg==";
    let tool_image_url = history_image_url;
    let exec_arguments = "{ \"cmd\" : \"pwd\" }";
    let tools = json!([{
        "type": "function",
        "name": "exec_command",
        "parameters": {"type": "object", "properties": {"cmd": {"type": "string"}}}
    }]);

    let output = execute_v3_responses_direct_runtime_kernel(
        &direct_manifest(),
        direct_request(json!({
            "model": "gpt-5.5",
            "instructions": "preserve direct payload",
            "stream": false,
            "metadata": {"client": "direct"},
            "tools": tools.clone(),
            "tool_choice": "auto",
            "parallel_tool_calls": true,
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "old question"},
                        {"type": "input_image", "image_url": {"url": history_image_url}}
                    ]
                },
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "old answer"}]
                },
                {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": "current question"},
                        {"type": "input_image", "image_url": {"url": current_image_url}}
                    ]
                },
                {
                    "type": "function_call",
                    "id": "fc_direct_exec",
                    "call_id": "call_direct_exec",
                    "name": "exec_command",
                    "arguments": exec_arguments
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_direct_exec",
                    "output": [
                        {"type": "input_image", "image_url": {"url": tool_image_url}}
                    ]
                }
            ]
        })),
        register_responses_direct_hooks(),
        &transport,
    )
    .await;

    assert_eq!(output.client_payload.status, 200, "{output:#?}");
    let captures = transport.captures.lock().unwrap();
    assert_eq!(captures.len(), 1);
    let wire = &captures[0].1;

    assert_eq!(wire["model"], "wire-m");
    assert_eq!(wire["instructions"], "preserve direct payload");
    assert_eq!(wire["metadata"], json!({"client": "direct"}));
    assert_eq!(wire["tools"], tools);
    assert_eq!(wire["tool_choice"], "auto");
    assert_eq!(wire["parallel_tool_calls"], true);
    assert!(
        wire.get("messages").is_none(),
        "Direct same-protocol payload must not synthesize Relay Chat messages: {wire}"
    );

    let input = wire["input"].as_array().expect("Responses provider input");
    assert_eq!(input.len(), 5);
    assert_eq!(
        input[0]["content"][1],
        json!({"type": "input_text", "text": HISTORY_IMAGE_PLACEHOLDER}),
        "older history image must become the existing placeholder"
    );
    assert_eq!(input[1]["content"][0]["text"], "old answer");
    assert_eq!(
        input[2]["content"][1],
        json!({"type": "input_image", "image_url": current_image_url}),
        "the current user image must be retained"
    );
    assert_eq!(input[3]["call_id"], "call_direct_exec");
    assert_eq!(input[3]["arguments"], exec_arguments);
    assert_eq!(
        input[4]["output"][0],
        json!({"type": "input_text", "text": HISTORY_IMAGE_PLACEHOLDER}),
        "tool-result image history must be cleaned to the existing placeholder"
    );
}

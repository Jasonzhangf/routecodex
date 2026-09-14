//! Mixed-provider-type pool coverage on the Anthropic entry (`POST /v1/messages`).
//!
//! Bug A regression coverage: the Anthropic entry previously aborted the whole
//! request when the selected candidate's provider wire protocol had no
//! Anthropic-entry transport arm (kdns-style `openai_chat` providers killed
//! every `/v1/messages` request with 598 `anthropic_relay_runtime_error` even
//! though the pool also contained supported candidates). The runtime now
//! services `openai_chat` candidates through the shared `/chat/completions`
//! transport builder and projects their `chat.completion` responses into
//! Anthropic client messages (JSON and SSE), so a mixed openai_chat + anthropic
//! pool is fully usable at the Anthropic entry.

use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{execute_v3_anthropic_relay_runtime, V3AnthropicRelayRuntimeInput};
use serde_json::{json, Value};
use std::sync::Mutex;

fn ensure_isolated_provider_state_dir() {
    static INITIALIZE: std::sync::Once = std::sync::Once::new();
    INITIALIZE.call_once(|| {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock must follow the Unix epoch")
            .as_nanos();
        let state_dir = std::env::temp_dir().join(format!(
            "routecodex-v3-mixed-pool-failover-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&state_dir)
            .expect("mixed-pool tests must own an isolated provider cooldown state directory");
        std::env::set_var(
            "ROUTECODEX_V3_PROVIDER_COOLDOWN_STATE",
            state_dir.join("provider-cooldowns.json"),
        );
    });
}

struct JsonChatCompletionTransport {
    captured_provider_ids: Mutex<Vec<String>>,
    captured_url: Mutex<Option<String>>,
}

impl JsonChatCompletionTransport {
    fn new() -> Self {
        Self {
            captured_provider_ids: Mutex::new(Vec::new()),
            captured_url: Mutex::new(None),
        }
    }

    fn provider_ids(&self) -> Vec<String> {
        self.captured_provider_ids.lock().unwrap().clone()
    }

    fn url(&self) -> Option<String> {
        self.captured_url.lock().unwrap().clone()
    }
}

#[async_trait]
impl ResponsesTransport for JsonChatCompletionTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.captured_provider_ids
            .lock()
            .unwrap()
            .push(request.provider_id().to_string());
        *self.captured_url.lock().unwrap() = Some(request.url().to_string());
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&json!({
                "id":"chatcmpl-mixed-pool-ok",
                "object":"chat.completion",
                "created":1757767058,
                "model":"gpt-5.5",
                "choices":[{
                    "index":0,
                    "message":{"role":"assistant","content":"RCC_V3_MIXED_POOL_OK"},
                    "finish_reason":"stop"
                }],
                "usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}
            }))
            .unwrap(),
        ))
    }
}

struct JsonChatCompletionToolCallTransport;

#[async_trait]
impl ResponsesTransport for JsonChatCompletionToolCallTransport {
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
                "id":"chatcmpl-tool-ok",
                "object":"chat.completion",
                "created":1757767058,
                "model":"gpt-5.5",
                "choices":[{
                    "index":0,
                    "message":{
                        "role":"assistant",
                        "content":null,
                        "tool_calls":[{
                            "id":"call-abc",
                            "type":"function",
                            "function":{"name":"weather_check","arguments":"{\"city\":\"beijing\"}"}
                        }]
                    },
                    "finish_reason":"tool_calls"
                }],
                "usage":{"prompt_tokens":9,"completion_tokens":11,"total_tokens":20}
            }))
            .unwrap(),
        ))
    }
}

struct JsonChatCompletionSseStreamTransport;

#[async_trait]
impl ResponsesTransport for JsonChatCompletionSseStreamTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let stream = futures_util::stream::iter([
            Ok(br#"data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1757767058,"model":"gpt-5.5","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

"#.to_vec()),
            Ok(br#"data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1757767058,"model":"gpt-5.5","choices":[{"index":0,"delta":{"content":"RCC_V3_"},"finish_reason":null}]}

"#.to_vec()),
            Ok(br#"data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1757767058,"model":"gpt-5.5","choices":[{"index":0,"delta":{"content":"SSE_OK"},"finish_reason":null}]}

"#.to_vec()),
            Ok(br#"data: {"id":"chatcmpl-stream","object":"chat.completion.chunk","created":1757767058,"model":"gpt-5.5","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

"#.to_vec()),
            Ok(br#"data: [DONE]

"#.to_vec()),
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

fn manifest(server_id: &str, targets: &str) -> routecodex_v3_config::V3Config05ManifestPublished {
    ensure_isolated_provider_state_dir();
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            &format!(
                r#"
version = 3

[servers.{server_id}]
bind = "127.0.0.1"
port = 5555
routing_group = "{server_id}"
endpoints = ["anthropic"]

[servers.{server_id}.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = {{ allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }}

[providers.kdns]
type = "openai_chat"
base_url = "http://controlled.invalid/kdns"
default_model = "gpt-5.5"
auth = {{ type = "api_key", entries = [{{ alias = "kdns", env = "KDNS_TEST_KEY" }}] }}

[providers.kdns.models."gpt-5.5"]
wire_name = "gpt-5.5"
supports_streaming = true
capabilities = ["text", "tools"]

[providers.corealgos]
type = "anthropic"
base_url = "http://controlled.invalid/corealgos"
default_model = "claude-fable-5"
auth = {{ type = "api_key", entries = [{{ alias = "corealgos", env = "COREALGOS_TEST_KEY" }}] }}

[providers.corealgos.models.claude-fable-5]
wire_name = "claude-fable-5"
supports_streaming = true
capabilities = ["text", "tools"]

[route_groups.{server_id}.pools.default]
selection = {{ strategy = "priority" }}
targets = [
{targets}
]
"#
            ),
        )
        .unwrap(),
    )
    .unwrap()
}

fn mixed_pool_input(
    server_id: &str,
    request_id: &str,
    stream: bool,
) -> V3AnthropicRelayRuntimeInput {
    V3AnthropicRelayRuntimeInput {
        server_id: server_id.into(),
        failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
            "test-mixed-pool",
            server_id,
            concat!(module_path!(), ":", line!()),
        )
        .expect("test provider failure session scope"),
        toolreason_observation_session_id: None,
        request_id: request_id.into(),
        payload: json!({
            "model":"gpt-5.5",
            "max_tokens":64,
            "messages":[{"role":"user","content":"Return exactly: RCC_V3_MIXED_POOL_OK"}],
            "stream":stream
        }),
    }
}

#[tokio::test]
async fn anthropic_relay_mixed_openai_chat_pool_is_served_without_abort() {
    // A kdns-style openai_chat candidate at the pool's top priority previously
    // aborted every /v1/messages request (598 anthropic_relay_runtime_error)
    // even with a supported anthropic candidate in the pool. The top-priority
    // openai_chat candidate must now service the request through
    // /chat/completions.
    let server_id = "mixed_pool_failover";
    let manifest = manifest(
        server_id,
        r#"  { kind = "provider_model", provider = "kdns", model = "gpt-5.5", key = "kdns", priority = 20 },
  { kind = "provider_model", provider = "corealgos", model = "claude-fable-5", key = "corealgos", priority = 10 },"#,
    );
    let transport = JsonChatCompletionTransport::new();
    let output = execute_v3_anthropic_relay_runtime(
        &manifest,
        mixed_pool_input(server_id, "req-anthropic-mixed-pool", false),
        &transport,
    )
    .await
    .expect("mixed openai_chat + anthropic pool must not abort the request");

    assert_eq!(output.status, 200);
    assert_eq!(
        transport.provider_ids(),
        vec!["kdns".to_string()],
        "the top-priority openai_chat candidate must service the request"
    );
    assert_eq!(
        transport.url().as_deref(),
        Some("http://controlled.invalid/kdns/chat/completions")
    );
    assert_eq!(
        output.client_response["content"][0]["text"],
        json!("RCC_V3_MIXED_POOL_OK")
    );
    assert_eq!(output.client_response["stop_reason"], json!("end_turn"));
    assert_eq!(
        output.client_response["usage"],
        json!({"input_tokens":7,"output_tokens":3})
    );
    assert_eq!(output.client_response["model"], json!("gpt-5.5"));
}

#[tokio::test]
async fn anthropic_relay_openai_chat_tool_calls_project_to_tool_use_blocks() {
    let server_id = "mixed_pool_openai_chat_tool";
    let manifest = manifest(
        server_id,
        r#"  { kind = "provider_model", provider = "kdns", model = "gpt-5.5", key = "kdns", priority = 1 },"#,
    );
    let output = execute_v3_anthropic_relay_runtime(
        &manifest,
        mixed_pool_input(server_id, "req-anthropic-mixed-pool-tool", false),
        &JsonChatCompletionToolCallTransport,
    )
    .await
    .expect("openai_chat tool_calls must project to Anthropic tool_use blocks");

    assert_eq!(output.status, 200);
    assert_eq!(output.client_response["stop_reason"], json!("tool_use"));
    assert_eq!(
        output.client_response["content"],
        json!([{
            "type":"tool_use",
            "id":"call-abc",
            "name":"weather_check",
            "input":{"city":"beijing"}
        }])
    );
}

#[tokio::test]
async fn anthropic_relay_openai_chat_sse_stream_reaches_client_sse_events() {
    // The production failure sample used stream=true; an openai_chat provider's
    // chat.completion.chunk stream must materialize and project to Anthropic
    // client SSE events.
    let server_id = "mixed_pool_openai_chat_sse";
    let manifest = manifest(
        server_id,
        r#"  { kind = "provider_model", provider = "kdns", model = "gpt-5.5", key = "kdns", priority = 1 },"#,
    );
    let output = execute_v3_anthropic_relay_runtime(
        &manifest,
        mixed_pool_input(server_id, "req-anthropic-mixed-pool-sse", true),
        &JsonChatCompletionSseStreamTransport,
    )
    .await
    .expect("openai_chat SSE stream must service the Anthropic entry");

    assert_eq!(output.status, 200);
    let events = output.client_response["events"]
        .as_array()
        .expect("stream=true Anthropic client projection must contain SSE events");
    assert_eq!(events.first().unwrap()["event"], "message_start");
    assert!(events.iter().any(|event| {
        event.pointer("/data/delta/text").and_then(Value::as_str) == Some("RCC_V3_SSE_OK")
    }));
    assert_eq!(events.last().unwrap()["event"], "message_stop");
}

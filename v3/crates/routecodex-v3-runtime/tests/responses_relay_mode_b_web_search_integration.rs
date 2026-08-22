//! responses 入口 Mode B web_search 同轮拦截红测。
//!
//! 背景（20260808）：用户真实请求（4444 `/v1/responses` + input web_search part）
//! 返回裸 `requires_action`（websearch function_call 直接给客户端）——Mode B
//! 的 Resp03 同轮本地搜索拦截未触发。web_search 与 stopless 解耦后，当前轮
//! 拦截必须直接使用 Req04 激活的 LocalToolSurfaceActive state，不依赖
//! stopless feature / client session scope。
//!
//! 红测契约：responses 入口 + web_search item + Mode B 模型（metadata_center_local_search）
//! → provider 返回 websearch tool call → 响应**不得**以裸 function_call(websearch)
//! 返回客户端（必须被 Resp03 同轮拦截，进入本地搜索 hop 或显式 fail-fast）。

use std::collections::VecDeque;
use std::sync::Mutex;

use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    execute_v3_responses_relay_runtime_with_transport_health_and_stopless_control,
    V3ResponsesRelayClientBody, V3ResponsesRelayProviderHealthHandle, V3ResponsesRelayRuntimeInput,
    V3ResponsesRelayStoplessControlScope, V3ResponsesRelayStoplessControlState,
};
use serde_json::{json, Value};

fn manifest_mode_b_websearch() -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[servers.controlled]
bind = "127.0.0.1"
port = 5555
routing_group = "controlled"
endpoints = ["responses"]
[providers.mm]
type = "anthropic"
base_url = "https://api.minimaxi.com/anthropic"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "MM_KEY" }] }
[providers.mm.models.MiniMax-M3]
wire_name = "MiniMax-M3"
capabilities = ["text", "tools", "multimodal", "vision", "web_search"]
web_search_execution_mode = "metadata_center_local_search"
web_search_backend = "MiniMax-M3"
[route_groups.controlled.pools.web_search]
selection = { strategy = "priority" }
match = { precedence = 20, required_capabilities = ["web_search"] }
targets = [{ kind = "provider_model", provider = "mm", model = "MiniMax-M3", key = "key1", priority = 1 }]
[route_groups.controlled.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "mm", model = "MiniMax-M3", key = "key1", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}

struct WebSearchToolCallTransport {
    responses: Mutex<VecDeque<Value>>,
}

#[async_trait]
impl ResponsesTransport for WebSearchToolCallTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let next = self
            .responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("mode B web_search transport response queue must be non-empty");
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            serde_json::to_vec(&next).unwrap(),
        ))
    }
}

#[tokio::test]
async fn responses_entry_mode_b_web_search_call_must_not_return_bare_function_call() {
    // 红测：provider 返回 websearch tool call 时，响应不得以裸
    // function_call(websearch) 返回客户端（Mode B 同轮拦截必须生效）。
    let manifest = manifest_mode_b_websearch();
    let transport = WebSearchToolCallTransport {
        responses: Mutex::new(VecDeque::from([
            // 主请求：provider 返回 websearch tool call
            json!({
                "id": "msg_mm_ws_1",
                "type": "message",
                "role": "assistant",
                "model": "MiniMax-M3",
                "content": [
                    {"type": "tool_use", "id": "call_ws_1", "name": "web_search",
                     "input": {"query": "routecodex"}}
                ],
                "stop_reason": "tool_use",
                "usage": {"input_tokens": 11, "output_tokens": 5}
            }),
            // 本地搜索 hop 响应（web_search_backend=MiniMax-M3 的搜索结果）
            json!({
                "id": "msg_mm_hop_1",
                "type": "message",
                "role": "assistant",
                "model": "MiniMax-M3",
                "content": [
                    {"type": "text", "text": "RouteCodex 是协议路由代理。"}
                ],
                "stop_reason": "end_turn",
                "usage": {"input_tokens": 8, "output_tokens": 12}
            }),
        ])),
    };
    let stopless_control = V3ResponsesRelayStoplessControlState::default();
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest);
    let scope = V3ResponsesRelayStoplessControlScope::new(
        "/v1/responses",
        "session-mode-b-web-search",
        "conversation-mode-b-web-search",
        5555,
        "controlled",
    );

    let result = execute_v3_responses_relay_runtime_with_transport_health_and_stopless_control(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-mode-b-web-search".into(),
            payload: json!({
                "model": "MiniMax-M3",
                "input": [
                    {"type": "web_search", "query": "routecodex"},
                    {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "search routecodex"}]}
                ],
                "stream": false
            }),
        },
        &transport,
        &provider_health,
        &stopless_control,
        scope.clone(),
    )
    .await;

    let output = result.expect("responses relay runtime must not fail");
    let body = match output.client_body {
        V3ResponsesRelayClientBody::Json(value) => value,
        _ => panic!("expected JSON relay output"),
    };
    let items = body
        .get("output")
        .and_then(Value::as_array)
        .expect("output array");
    for item in items {
        let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
        assert_ne!(
            (kind, item.get("name").and_then(Value::as_str).unwrap_or("")),
            ("function_call", "websearch"),
            "Mode B web_search tool call must be intercepted, not returned as bare requires_action: {item}"
        );
    }
}

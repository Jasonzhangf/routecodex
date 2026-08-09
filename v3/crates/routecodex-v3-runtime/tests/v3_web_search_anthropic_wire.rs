//! 5520 场景红测：responses 入口 + anthropic target + Mode B（MiniMax hosted
//! web search）。捕获 anthropic wire 工具声明（确认 web_search 保留 hosted
//! 工具、无 exec_command 注入），并验证 hosted 结果投影。

use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::hub_v1::{
    execute_v3_responses_relay_runtime_with_local_continuation, V3ResponsesRelayClientBody,
    V3ResponsesRelayLocalContinuationScope, V3ResponsesRelayLocalContinuationState,
    V3ResponsesRelayRuntimeInput,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

struct WireCaptureTransport(Arc<Mutex<Vec<Value>>>);
#[async_trait]
impl ResponsesTransport for WireCaptureTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        self.0.lock().unwrap().push(request.body().clone());
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            br#"{"id":"resp_hosted","type":"message","role":"assistant","model":"MiniMax-M3","content":[{"type":"text","text":"I searched."},{"type":"server_tool_use","id":"call_h1","name":"web_search","input":{"query":"routecodex"}},{"type":"web_search_tool_result","tool_use_id":"call_h1","content":[{"type":"web_search_result","title":"RouteCodex","url":"https://github.com/example/routecodex","page_age":"2026-07-07","content":"a routing gateway"}]}],"stop_reason":"tool_use"}"#
                .to_vec(),
        ))
    }
}

fn anthropic_mode_a_manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
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
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }
[providers.minimax]
type = "anthropic"
base_url = "https://api.minimaxi.com/anthropic"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "ROUTECODEX_V3_TEST_KEY" }] }
[providers.minimax.models."MiniMax-M3"]
wire_name = "MiniMax-M3"
supports_streaming = true
web_search_execution_mode = "native_remote_search_tool_mix"
capabilities = ["text", "tools", "web_search"]
[forwarders.responses]
model = "MiniMax-M3"
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "minimax", model = "MiniMax-M3", priority = 1 }]
[route_groups.chatwire.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "responses", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}

fn anthropic_mode_b_manifest() -> routecodex_v3_config::V3Config05ManifestPublished {
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
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }
[providers.minimax]
type = "anthropic"
base_url = "https://api.minimaxi.com/anthropic"
default_model = "MiniMax-M3"
auth = { type = "api_key", entries = [{ alias = "key1", env = "ROUTECODEX_V3_TEST_KEY" }] }
[providers.minimax.models."MiniMax-M3"]
wire_name = "MiniMax-M3"
supports_streaming = true
web_search_execution_mode = "metadata_center_local_search"
web_search_backend = "MiniMax-M3"
capabilities = ["text", "tools", "web_search"]
[forwarders.responses]
model = "MiniMax-M3"
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "minimax", model = "MiniMax-M3", priority = 1 }]
[route_groups.chatwire.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "responses", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn anthropic_wire_keeps_hosted_web_search_without_exec_command_and_projects_result() {
    let manifest = anthropic_mode_a_manifest();
    let captures = Arc::new(Mutex::new(Vec::new()));
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-ws-anthropic-relay",
        "conversation-ws-anthropic-relay",
        5555,
        "chatwire",
    );
    let output = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: "chatwire".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-ws-anthropic-relay".into(),
            payload: json!({
                "model": "MiniMax-M3",
                "input": "search routecodex",
                "tools": [{"type": "web_search"}]
            }),
        },
        &WireCaptureTransport(captures.clone()),
        &state,
        scope,
        12_000,
    )
    .await
    .expect("relay runtime must execute");

    assert_eq!(output.status, 200, "{output:?}");
    let wires = captures.lock().unwrap();
    assert!(!wires.is_empty(), "provider wire must be captured");
    let wire = &wires[0];
    // anthropic wire 工具：web_search 保留 hosted 工具，绝不注入 exec_command。
    let tools = wire
        .get("tools")
        .and_then(Value::as_array)
        .expect("anthropic tools");
    let names: Vec<&str> = tools
        .iter()
        .filter_map(|t| t.get("name").and_then(Value::as_str))
        .collect();
    assert!(
        names.iter().any(|name| *name == "web_search"),
        "anthropic wire must keep hosted web_search tool, got: {names:?}"
    );
    assert!(
        !names.iter().any(|name| *name == "exec_command"),
        "Mode B anthropic wire must not inject exec_command, got: {names:?}"
    );
    // 客户端响应：hosted web_search_call + 原 call_id 配对（web_search 调用
    // 与 web_search_tool_result 均剥离）。
    match output.client_body {
        V3ResponsesRelayClientBody::Json(value) => {
            let out = value["output"].as_array().expect("client output array");
            let call = out
                .iter()
                .find(|item| item.get("type").and_then(Value::as_str) == Some("web_search_call"))
                .expect("hosted web_search_call projected");
            assert_eq!(call["status"], "completed");
            assert_eq!(call["action"]["query"], "routecodex");
            let paired = out
                .iter()
                .find(|item| {
                    item.get("type").and_then(Value::as_str) == Some("function_call_output")
                })
                .expect("paired function_call_output");
            assert_eq!(paired["call_id"], "call_h1");
            assert!(
                out.iter()
                    .all(|item| item.get("type").and_then(Value::as_str)
                        != Some("web_search_tool_result")),
                "hosted web_search_tool_result must be stripped from client"
            );
        }
        other => panic!("JSON client body expected"),
    }
}

/// 搜索 hop 干净上下文红测：主模型返回 web_search call（无 hosted tool_result）
/// → 触发本地搜索 hop；断言搜索请求 wire 的工具列表仅 hosted web_search、
/// 上下文干净（无历史/无其他工具）、引导提示简单（"search the web: <query>"）。
struct SearchHopWireCaptureTransport {
    captures: Arc<Mutex<Vec<Value>>>,
    sends: Arc<Mutex<usize>>,
}
#[async_trait]
impl ResponsesTransport for SearchHopWireCaptureTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let mut sends = self.sends.lock().unwrap();
        let is_search_hop = *sends > 0;
        *sends += 1;
        if is_search_hop {
            self.captures.lock().unwrap().push(request.body().clone());
        }
        let body = if is_search_hop {
            // 搜索 hop 响应：anthropic 文本结果。
            br#"{"id":"resp_search","type":"message","role":"assistant","model":"MiniMax-M3","content":[{"type":"text","text":"search result text"}],"stop_reason":"end_turn"}"#
                .to_vec()
        } else {
            // 主模型响应：web_search call，无 hosted tool_result（走本地搜索 hop）。
            br#"{"id":"resp_main","type":"message","role":"assistant","model":"MiniMax-M3","content":[{"type":"tool_use","id":"call_s1","name":"web_search","input":{"query":"rust latest version"}}],"stop_reason":"tool_use"}"#
                .to_vec()
        };
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id().to_string(),
            request.provider_id().to_string(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            body,
        ))
    }
}

#[tokio::test]
async fn search_hop_wire_is_clean_hosted_web_search_only() {
    let manifest = anthropic_mode_b_manifest();
    let captures = Arc::new(Mutex::new(Vec::new()));
    let state = V3ResponsesRelayLocalContinuationState::default();
    let scope = V3ResponsesRelayLocalContinuationScope::responses(
        "/v1/responses",
        "session-ws-search-hop",
        "conversation-ws-search-hop",
        5555,
        "chatwire",
    );
    let output = execute_v3_responses_relay_runtime_with_local_continuation(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: "chatwire".into(),
            failure_session_scope: routecodex_v3_error::V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-ws-search-hop".into(),
            payload: json!({
                "model": "MiniMax-M3",
                "input": "use web search for rust latest version",
                "tools": [{"type": "web_search"}]
            }),
        },
        &SearchHopWireCaptureTransport {
            captures: captures.clone(),
            sends: std::sync::Arc::new(std::sync::Mutex::new(0)),
        },
        &state,
        scope,
        12_000,
    )
    .await
    .expect("relay runtime must execute");
    assert_eq!(output.status, 200, "{output:?}");
    // 客户端响应：hosted web_search_call 投影 + 原 call_id 配对。
    match output.client_body {
        V3ResponsesRelayClientBody::Json(value) => {
            eprintln!(
                "SEARCH_HOP_CLIENT={}",
                serde_json::to_string(&value).unwrap()
            );
            let out = value["output"].as_array().expect("client output array");
            let call = out
                .iter()
                .find(|item| item.get("type").and_then(Value::as_str) == Some("web_search_call"))
                .expect("hosted web_search_call projected after local search hop");
            assert_eq!(call["action"]["query"], "rust latest version");
            assert!(out.iter().any(
                |item| item.get("type").and_then(Value::as_str) == Some("function_call_output")
            ));
        }
        _ => panic!("JSON client body expected"),
    }
    // 搜索 hop wire：工具列表仅 hosted web_search、上下文干净、引导简单。
    let wires = captures.lock().unwrap();
    assert_eq!(wires.len(), 1, "exactly one search hop wire expected");
    let wire = &wires[0];
    let tools = wire.get("tools").and_then(Value::as_array).expect("tools");
    assert_eq!(
        tools.len(),
        1,
        "search hop must expose only web_search tool"
    );
    assert_eq!(tools[0]["type"], "web_search_20250305");
    assert_eq!(tools[0]["name"], "web_search");
    let input = wire["messages"].as_array().expect("anthropic messages");
    assert_eq!(
        input.len(),
        1,
        "search hop context must be clean (single message)"
    );
    let text = input[0]["content"]
        .as_str()
        .or_else(|| input[0]["content"][0]["text"].as_str())
        .expect("guided text");
    assert!(
        text.starts_with("search the web:"),
        "search hop guidance must be simple, got: {text}"
    );
    assert!(
        wire.get("web_search_options").is_none(),
        "search hop must not carry residual web_search_options"
    );
}

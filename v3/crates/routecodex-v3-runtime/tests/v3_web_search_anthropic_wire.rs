//! 5520 场景红测：responses 入口 + anthropic target + Mode B（MiniMax hosted
//! web search）。捕获 anthropic wire 工具声明（确认 web_search 保留 hosted
//! 工具、无 exec_command 注入），并验证 hosted 结果投影。

#![allow(unused_variables, clippy::manual_contains)]

use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_hooks::{ControlRequest, ControlResponse};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::hub_v1::{
    execute_v3_responses_relay_runtime,
    execute_v3_responses_relay_runtime_with_transport_health_and_server_tool_state,
    V3ResponsesRelayClientBody, V3ResponsesRelayProviderHealthHandle, V3ResponsesRelayRuntimeInput,
    V3ResponsesRelayServerToolScope, V3ResponsesRelayServerToolState,
};
use serde_json::{json, Value};
use servertool_core::web_search_contract::{
    WebSearchHookOutcome, WebSearchResult, WebSearchResultStatus,
};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

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
            br#"{"id":"resp_hosted","type":"message","role":"assistant","model":"MiniMax-M3","content":[{"type":"text","text":"I searched."},{"type":"server_tool_use","id":"call_h1","name":"web_search","input":{"query":"routecodex"}},{"type":"web_search_tool_result","tool_use_id":"call_h1","content":[{"type":"web_search_result","title":"RouteCodex","url":"https://github.com/example/routecodex","page_age":"2026-07-07","content":"a routing gateway"}]}],"stop_reason":"end_turn"}"#
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
    let output = execute_v3_responses_relay_runtime(
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

/// Mode B 本地搜索执行：主模型返回 web_search call（无 hosted tool_result）
/// → runtime 通过 typed hooks sidecar 执行一次搜索；断言没有第二 provider
/// attempt，且 sidecar 收到 call_id/query 配对的 typed request。
struct SearchHopWireCaptureTransport {
    sends: Arc<Mutex<usize>>,
}
#[async_trait]
impl ResponsesTransport for SearchHopWireCaptureTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        let mut sends = self.sends.lock().unwrap();
        *sends += 1;
        // 主模型响应：web_search call，无 hosted tool_result（走 typed sidecar）。
        let body =
            br#"{"id":"resp_main","type":"message","role":"assistant","model":"MiniMax-M3","content":[{"type":"tool_use","id":"call_s1","name":"web_search","input":{"query":"rust latest version"}}],"stop_reason":"tool_use"}"#
                .to_vec();
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

fn test_socket_path(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("rcc-{label}-{nonce}.sock"))
}

fn serve_completed_search(
    socket_path: PathBuf,
) -> thread::JoinHandle<servertool_core::web_search_contract::WebSearchHookRequest> {
    let listener = UnixListener::bind(&socket_path).expect("bind typed sidecar test socket");
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept typed sidecar request");
        let mut line = String::new();
        BufReader::new(stream.try_clone().expect("clone typed sidecar stream"))
            .read_line(&mut line)
            .expect("read typed sidecar request");
        let request: ControlRequest =
            serde_json::from_str(line.trim()).expect("decode typed sidecar request");
        let ControlRequest::ExecuteWebSearch { request } = request else {
            panic!("expected ExecuteWebSearch");
        };
        let response = ControlResponse::ok(json!({
            "outcome": WebSearchHookOutcome::Completed(WebSearchResult {
                call_id: request.call_id.clone(),
                status: WebSearchResultStatus::Completed,
                content: Some("search result text".to_string()),
                sources: Vec::new(),
                metadata: None,
                error: None,
            })
        }));
        writeln!(
            stream,
            "{}",
            serde_json::to_string(&response).expect("encode typed sidecar response")
        )
        .expect("write typed sidecar response");
        *request
    })
}

#[tokio::test]
async fn search_hop_uses_typed_sidecar_without_provider_reentry() {
    let manifest = anthropic_mode_b_manifest();
    let sends = Arc::new(Mutex::new(0));
    let socket_path = test_socket_path("anthropic-sidecar");
    let sidecar = serve_completed_search(socket_path.clone());
    let server_tool_state = V3ResponsesRelayServerToolState::default()
        .with_hooks_sidecar_socket(Some(socket_path.clone()));
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest);
    let scope = V3ResponsesRelayServerToolScope::new(
        "/v1/responses",
        "session-ws-anthropic",
        "conversation-ws-anthropic",
        5555,
        "chatwire",
    );
    let output = execute_v3_responses_relay_runtime_with_transport_health_and_server_tool_state(
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
            sends: sends.clone(),
        },
        &provider_health,
        &server_tool_state,
        scope,
    )
    .await
    .expect("relay runtime must execute");
    let request = sidecar.join().expect("join typed sidecar worker");
    let _ = std::fs::remove_file(&socket_path);
    assert_eq!(output.status, 200, "{output:?}");
    assert_eq!(
        *sends.lock().unwrap(),
        1,
        "typed sidecar execution must not issue a second provider attempt"
    );
    assert_eq!(request.call_id, "call_s1");
    assert_eq!(request.query, "rust latest version");
    // 客户端响应：hosted web_search_call 投影 + 原 call_id 配对。
    match output.client_body {
        V3ResponsesRelayClientBody::Json(value) => {
            let out = value["output"].as_array().expect("client output array");
            let call = out
                .iter()
                .find(|item| item.get("type").and_then(Value::as_str) == Some("web_search_call"))
                .expect("hosted web_search_call projected after typed sidecar result");
            assert_eq!(call["action"]["query"], "rust latest version");
            assert_eq!(call["results"][0]["text"], "search result text");
            let paired = out
                .iter()
                .find(|item| {
                    item.get("type").and_then(Value::as_str) == Some("function_call_output")
                })
                .expect("paired function_call_output");
            assert_eq!(paired["call_id"], "call_s1");
            assert_eq!(paired["output"], "search result text");
            assert!(call.get("phase").is_none());
            assert!(paired.get("scope_key").is_none());
        }
        _ => panic!("JSON client body expected"),
    }
}

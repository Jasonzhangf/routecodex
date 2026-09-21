//! responses 入口 Mode B web_search 同轮拦截红测。
//!
//! 背景（20260808）：用户真实请求（4444 `/v1/responses` + input web_search part）
//! 返回裸 `requires_action`（websearch function_call 直接给客户端）——Mode B
//! 的 Resp03 同轮本地搜索拦截未触发。web_search 与其他 tool state 解耦后，当前轮
//! 拦截必须直接使用 Req04 激活的 LocalToolSurfaceActive state，不依赖
//! 其他 client session control scope。
//!
//! 红测契约：responses 入口 + web_search item + Mode B 模型（metadata_center_local_search）
//! → provider 返回 websearch tool call → 响应**不得**以裸 function_call(websearch)
//! 返回客户端（必须被 Resp03 同轮拦截，进入本地搜索 hop 或显式 fail-fast）。

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_hooks::{ControlRequest, ControlResponse};
use routecodex_v3_provider_responses::{
    ResponsesTransport, V3ProviderError, V3ProviderResp14Raw, V3ProviderResponseHeader,
    V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::{
    execute_v3_responses_relay_runtime_with_transport_health_and_server_tool_state,
    V3ResponsesRelayClientBody, V3ResponsesRelayProviderHealthHandle, V3ResponsesRelayRuntimeInput,
    V3ResponsesRelayServerToolScope, V3ResponsesRelayServerToolState,
};
use serde_json::{json, Value};
use servertool_core::web_search_contract::{
    WebSearchHookOutcome, WebSearchResult, WebSearchResultStatus, WebSearchSource,
};

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
[servers.controlled.execution]
allowed_modes = ["relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = {}
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

fn web_search_tool_call_response() -> Value {
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
    })
}

fn test_socket_path(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    PathBuf::from("/tmp").join(format!("rcc-{label}-{nonce}.sock"))
}

fn serve_sources_only_result(
    socket_path: PathBuf,
) -> thread::JoinHandle<servertool_core::web_search_contract::WebSearchHookRequest> {
    serve_web_search_result(
        socket_path,
        None,
        vec![WebSearchSource {
            ref_id: "source-1".to_string(),
            url: Some("https://example.com".to_string()),
            title: Some("Example".to_string()),
        }],
    )
}

fn serve_web_search_result(
    socket_path: PathBuf,
    content: Option<String>,
    sources: Vec<WebSearchSource>,
) -> thread::JoinHandle<servertool_core::web_search_contract::WebSearchHookRequest> {
    let listener = UnixListener::bind(&socket_path).expect("bind hooks sidecar test socket");
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept hooks sidecar request");
        let mut line = String::new();
        BufReader::new(stream.try_clone().expect("clone hooks sidecar stream"))
            .read_line(&mut line)
            .expect("read hooks sidecar request");
        let request: ControlRequest =
            serde_json::from_str(line.trim()).expect("decode hooks sidecar request");
        let ControlRequest::ExecuteWebSearch { request } = request else {
            panic!("expected ExecuteWebSearch");
        };
        let response = ControlResponse::ok(json!({
            "outcome": WebSearchHookOutcome::Completed(WebSearchResult {
                call_id: request.call_id.clone(),
                status: WebSearchResultStatus::Completed,
                content,
                sources,
                metadata: None,
                error: None,
            })
        }));
        writeln!(
            stream,
            "{}",
            serde_json::to_string(&response).expect("encode hooks sidecar response")
        )
        .expect("write hooks sidecar response");
        *request
    })
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
async fn responses_entry_mode_b_web_search_no_state_fails_without_provider_send() {
    let manifest = manifest_mode_b_websearch();
    let transport = WebSearchToolCallTransport {
        responses: Mutex::new(VecDeque::from([web_search_tool_call_response()])),
    };
    let result =
        routecodex_v3_runtime::execute_v3_responses_relay_runtime(&manifest, V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-mode-b-web-search-no-state".into(),
            payload: json!({
                "model": "MiniMax-M3",
                "input": [
                    {"type": "web_search", "query": "routecodex"},
                    {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "search routecodex"}]}
                ],
                "stream": false
            }),
        }, &transport)
        .await;

    let error = result.expect_err("web-search-capable call without typed state must fail");
    assert!(
        error
            .to_string()
            .contains("web_search execution state is unavailable"),
        "unexpected error: {error}"
    );
    assert_eq!(
        transport.responses.lock().unwrap().len(),
        1,
        "typed state validation must run before provider send"
    );
}

#[tokio::test]
async fn responses_entry_mode_b_web_search_missing_sidecar_fails_without_provider_reentry() {
    // Provider只允许一次主请求响应。未配置 hooks sidecar socket 必须显式
    // 失败；若旧 provider re-entry仍活跃，第二次 send会因队列为空直接失败。
    let manifest = manifest_mode_b_websearch();
    let transport = WebSearchToolCallTransport {
        responses: Mutex::new(VecDeque::from([web_search_tool_call_response()])),
    };
    let server_tool_state = V3ResponsesRelayServerToolState::default();
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest);
    let scope = V3ResponsesRelayServerToolScope::new(
        "/v1/responses",
        "session-mode-b-web-search",
        "conversation-mode-b-web-search",
        5555,
        "controlled",
    );

    let result = execute_v3_responses_relay_runtime_with_transport_health_and_server_tool_state(
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
        &server_tool_state,
        scope.clone(),
    )
    .await;

    let error = result.expect_err("missing hooks sidecar socket must fail explicitly");
    assert!(
        error
            .to_string()
            .contains("web_search hooks sidecar socket is not configured"),
        "unexpected error: {error}"
    );
    assert!(
        transport.responses.lock().unwrap().is_empty(),
        "the single main provider response must be consumed exactly once"
    );
}

#[tokio::test]
async fn responses_entry_mode_b_web_search_projects_sources_only_sidecar_result() {
    let manifest = manifest_mode_b_websearch();
    let transport = WebSearchToolCallTransport {
        responses: Mutex::new(VecDeque::from([web_search_tool_call_response()])),
    };
    let socket_path = test_socket_path("sources-only");
    let sidecar = serve_sources_only_result(socket_path.clone());
    let server_tool_state = V3ResponsesRelayServerToolState::default()
        .with_hooks_sidecar_socket(Some(socket_path.clone()));
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest);
    let scope = V3ResponsesRelayServerToolScope::new(
        "/v1/responses",
        "session-mode-b-web-search",
        "conversation-mode-b-web-search",
        5555,
        "controlled",
    );

    let output = execute_v3_responses_relay_runtime_with_transport_health_and_server_tool_state(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-mode-b-web-search-sources-only".into(),
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
        &server_tool_state,
        scope,
    )
    .await
    .expect("sources-only sidecar result must project");

    let request = sidecar.join().expect("join hooks sidecar");
    let _ = std::fs::remove_file(&socket_path);
    assert_eq!(request.call_id, "call_ws_1");
    assert_eq!(request.query, "routecodex");
    assert!(
        transport.responses.lock().unwrap().is_empty(),
        "the single main provider response must be consumed exactly once"
    );
    let V3ResponsesRelayClientBody::Json(body) = output.client_body else {
        panic!("expected JSON relay output");
    };
    let items = body["output"].as_array().expect("output array");
    let call = items
        .iter()
        .find(|item| item["type"] == "web_search_call")
        .expect("projected web_search_call");
    let pair = items
        .iter()
        .find(|item| item["type"] == "function_call_output")
        .expect("paired function_call_output");
    assert_eq!(call["id"], "web_search_call_ws_1");
    assert_eq!(call["results"][0]["ref_id"], "source-1");
    assert_eq!(call["results"][0]["title"], "Example");
    assert_eq!(call["results"][0]["url"], "https://example.com");
    assert_eq!(pair["call_id"], "call_ws_1");
    assert_eq!(pair["output"]["type"], "web_search_tool_result");
    assert_eq!(pair["output"]["results"], call["results"]);
    assert!(call.get("phase").is_none());
    assert!(pair.get("scope_key").is_none());
}

#[tokio::test]
async fn responses_entry_mode_b_web_search_projects_text_and_sources_sidecar_result() {
    let manifest = manifest_mode_b_websearch();
    let transport = WebSearchToolCallTransport {
        responses: Mutex::new(VecDeque::from([web_search_tool_call_response()])),
    };
    let socket_path = test_socket_path("text-and-sources");
    let sidecar = serve_web_search_result(
        socket_path.clone(),
        Some("RouteCodex summary".to_string()),
        vec![WebSearchSource {
            ref_id: "source-1".to_string(),
            url: Some("https://example.com".to_string()),
            title: Some("Example".to_string()),
        }],
    );
    let server_tool_state = V3ResponsesRelayServerToolState::default()
        .with_hooks_sidecar_socket(Some(socket_path.clone()));
    let provider_health = V3ResponsesRelayProviderHealthHandle::from_manifest(&manifest);
    let scope = V3ResponsesRelayServerToolScope::new(
        "/v1/responses",
        "session-mode-b-web-search-mixed",
        "conversation-mode-b-web-search-mixed",
        5555,
        "controlled",
    );

    let output = execute_v3_responses_relay_runtime_with_transport_health_and_server_tool_state(
        &manifest,
        V3ResponsesRelayRuntimeInput {
            server_id: "controlled".into(),
            failure_session_scope: V3ProviderFailureSessionScope::new(
                "test-server",
                "test-group",
                concat!(module_path!(), ":", line!()),
            )
            .expect("test provider failure session scope"),
            request_id: "req-mode-b-web-search-text-and-sources".into(),
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
        &server_tool_state,
        scope,
    )
    .await
    .expect("text and sources sidecar result must project");

    let request = sidecar.join().expect("join hooks sidecar");
    let _ = std::fs::remove_file(&socket_path);
    assert_eq!(request.call_id, "call_ws_1");
    assert_eq!(request.query, "routecodex");
    assert!(
        transport.responses.lock().unwrap().is_empty(),
        "the single main provider response must be consumed exactly once"
    );
    let V3ResponsesRelayClientBody::Json(body) = output.client_body else {
        panic!("expected JSON relay output");
    };
    let items = body["output"].as_array().expect("output array");
    let call = items
        .iter()
        .find(|item| item["type"] == "web_search_call")
        .expect("projected web_search_call");
    let pair = items
        .iter()
        .find(|item| item["type"] == "function_call_output")
        .expect("paired function_call_output");
    assert_eq!(call["id"], "web_search_call_ws_1");
    assert_eq!(call["results"].as_array().expect("results").len(), 2);
    assert_eq!(call["results"][0]["ref_id"], "call_ws_1");
    assert_eq!(call["results"][0]["text"], "RouteCodex summary");
    assert_eq!(call["results"][1]["ref_id"], "source-1");
    assert_eq!(pair["call_id"], "call_ws_1");
    assert_eq!(pair["output"]["type"], "web_search_tool_result");
    assert_eq!(pair["output"]["results"], call["results"]);
    assert!(call.get("phase").is_none());
    assert!(pair.get("scope_key").is_none());
}

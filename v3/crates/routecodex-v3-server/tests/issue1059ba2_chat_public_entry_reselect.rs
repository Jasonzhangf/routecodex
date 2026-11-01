//! 1059ba2 real public-entry regression.
//!
//! The primary pool candidate is a Responses-protocol provider that terminates
//! with `response.incomplete` carrying usage but no deliverable business
//! output. The real `/v1/chat/completions` HTTP/SSE entry must reselect to the
//! healthy OpenAI-Chat secondary and project only that attempt to the client.
//!
//! Trace evidence note: the live snapshot session is only opened for the
//! `responses` entry protocol. A Chat entry therefore leaves
//! `/_routecodex/debug/snapshots` empty; the server still persists the exact
//! client-response sample for the real Chat request, and that artifact carries
//! the ordered `node_trace` produced by the same request path. This test reads
//! the debug route first and falls back to the existing sample artifact, so no
//! product-source seam is added.

use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::post,
    Json, Router,
};
use futures_util::StreamExt;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, oneshot, Mutex};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
use hub_v1_fixture::{hub_v1_server_execution, hub_v1_test_declaration};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;
use test_ports::free_port;

static TEST_LOCK: Mutex<()> = Mutex::const_new(());

struct StateRootGuard(PathBuf);

impl Drop for StateRootGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Debug)]
struct ProviderCapture {
    provider: &'static str,
    path: &'static str,
    body: Value,
}

#[derive(Clone)]
struct UpstreamState {
    captures: mpsc::UnboundedSender<ProviderCapture>,
}

async fn responses_incomplete_upstream(
    State(state): State<Arc<UpstreamState>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    state
        .captures
        .send(ProviderCapture {
            provider: "primary_responses",
            path: "/v1/responses",
            body: body.clone(),
        })
        .unwrap();
    let frames = vec![
        Ok::<Vec<u8>, std::convert::Infallible>(
            b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_primary_incomplete\",\"status\":\"in_progress\"}}\n\n".to_vec(),
        ),
        Ok(
            b"event: response.incomplete\ndata: {\"type\":\"response.incomplete\",\"response\":{\"id\":\"resp_primary_incomplete\",\"status\":\"incomplete\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"},\"usage\":{\"input_tokens\":10,\"output_tokens\":2,\"total_tokens\":12}}}\n\n".to_vec(),
        ),
    ];
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from_stream(futures_util::stream::iter(frames)))
        .unwrap()
}

#[tokio::test]
async fn chat_public_entry_reselects_empty_incomplete_primary_and_delivers_secondary_only() {
    let _guard = TEST_LOCK.lock().await;
    let original_home = std::env::var_os("HOME");
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must follow the Unix epoch")
        .as_nanos();
    let state_root = std::env::temp_dir().join(format!(
        "routecodex-1059ba2-public-entry-{}-{nonce}",
        std::process::id()
    ));
    let _state_root_guard = StateRootGuard(state_root.clone());
    let home = state_root.join("home");
    std::fs::create_dir_all(&home).unwrap();
    std::env::set_var("HOME", &home);
    std::env::set_var(
        "ROUTECODEX_V3_PROVIDER_COOLDOWN_STATE",
        state_root.join("provider-cooldowns.json"),
    );
    std::env::set_var("V3_RESPONSES_PRIMARY_KEY", "primary-secret");
    std::env::set_var("V3_OPENAI_CHAT_SECONDARY_KEY", "secondary-secret");

    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_addr = upstream.local_addr().unwrap();
    let (captures_tx, mut captures_rx) = mpsc::unbounded_channel();
    let (upstream_shutdown_tx, upstream_shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/responses", post(responses_incomplete_upstream))
        .route("/v1/chat/completions", post(healthy_chat_upstream))
        .with_state(Arc::new(UpstreamState {
            captures: captures_tx,
        }));
    tokio::spawn(async move {
        axum::serve(upstream, app)
            .with_graceful_shutdown(async move {
                let _ = upstream_shutdown_rx.await;
            })
            .await
            .unwrap();
    });

    let server_port = free_port();
    let handle = spawn_v3_server_aggregate(manifest(server_port, upstream_addr.port()))
        .await
        .unwrap();
    let endpoint = format!("http://{}/v1/chat/completions", handle.listeners[0].addr);
    let client = reqwest::Client::new();

    let response = client
        .post(&endpoint)
        .json(&json!({
            "model": "chat-client-alias",
            "messages": [{ "role": "user", "content": "empty incomplete" }],
            "stream": true,
            "stream_options": { "include_usage": true }
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get("content-type").unwrap(),
        "text/event-stream"
    );
    let collected = tokio::time::timeout(
        Duration::from_secs(20),
        response.bytes_stream().collect::<Vec<_>>(),
    )
    .await
    .expect("real Chat SSE response must complete");
    let body = collected
        .into_iter()
        .map(|chunk| chunk.expect("client SSE chunk must be readable"))
        .flat_map(|bytes| bytes.to_vec())
        .collect::<Vec<_>>();
    let text = String::from_utf8(body).unwrap();

    // Only the healthy secondary attempt may reach the client wire. The primary
    // usage/terminal payload must never be projected.
    assert!(
        !text.contains("primary"),
        "primary attempt content leaked into the client stream: {text}"
    );
    assert!(
        !text.contains("resp_primary_incomplete") && !text.contains("response.incomplete"),
        "primary terminal payload leaked into the client stream: {text}"
    );
    assert!(
        !text.contains("prompt_tokens") && !text.contains("\"usage\""),
        "primary usage frame leaked into the client stream: {text}"
    );
    assert!(
        !text.contains("max_output_tokens"),
        "primary incomplete reason leaked into the client stream: {text}"
    );
    assert_eq!(
        text.matches("data: [DONE]").count(),
        1,
        "the client stream must carry exactly one [DONE]: {text}"
    );
    let client_frames: Vec<Value> = text
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .filter(|data| *data != "[DONE]")
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()
        .expect("every client data frame must be valid JSON");
    assert!(!client_frames.is_empty(), "client must receive SSE frames");
    let content: String = client_frames
        .iter()
        .filter_map(|frame| frame["choices"][0]["delta"]["content"].as_str())
        .collect();
    assert_eq!(content, "secondary-after-incomplete", "{text}");
    assert!(
        client_frames
            .iter()
            .any(|frame| frame["choices"][0]["finish_reason"] == "stop"),
        "secondary terminal frame is missing: {text}"
    );

    // The controlled upstream proves the real provider call order.
    let mut attempts = Vec::new();
    for _ in 0..2 {
        let capture = tokio::time::timeout(Duration::from_secs(5), captures_rx.recv())
            .await
            .expect("both provider attempts must reach the controlled upstream")
            .expect("capture channel must stay open");
        attempts.push(capture);
    }
    let order: Vec<&str> = attempts.iter().map(|capture| capture.provider).collect();
    assert_eq!(
        order,
        ["primary_responses", "secondary_openai_chat"],
        "empty primary attempt must be tried first and reselected to the secondary"
    );
    let paths: Vec<&str> = attempts.iter().map(|capture| capture.path).collect();
    assert_eq!(paths, ["/v1/responses", "/v1/chat/completions"]);
    for capture in &attempts {
        assert_eq!(
            capture.body.get("stream").and_then(Value::as_bool),
            Some(true),
            "both provider attempts must carry the client stream request: {:?}",
            capture.body
        );
    }

    // Prefer the live debug snapshot route. The Chat entry currently does not
    // open a live snapshot session, so when the route is empty the existing
    // real-request sample artifact supplies the same ordered node trace.
    let snapshots_response = client
        .get(format!(
            "http://{}/_routecodex/debug/snapshots",
            handle.listeners[0].addr
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(snapshots_response.status(), StatusCode::OK);
    let snapshots: Value = snapshots_response.json().await.unwrap();
    eprintln!(
        "debug snapshots payload: {}",
        serde_json::to_string(&snapshots).unwrap()
    );
    let snapshot_nodes = snapshots["snapshots"]
        .as_array()
        .map(|snapshots| {
            snapshots
                .iter()
                .filter_map(|snapshot| snapshot["node_id"].as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let trace_nodes = if snapshot_nodes
        .iter()
        .any(|node| node == "V3TargetLocalReselected")
        && snapshot_nodes
            .iter()
            .any(|node| node == "V3ServerRespOutbound06ClientFrame")
    {
        snapshot_nodes.clone()
    } else {
        eprintln!(
            "debug snapshots route carried no Chat live node trace ({snapshot_nodes:?}); \
             reading the existing client-response sample artifact"
        );
        let sample = wait_for_response_sample(&home, server_port).await;
        sample["node_trace"]
            .as_array()
            .unwrap_or_else(|| panic!("client-response sample must carry node_trace: {sample}"))
            .iter()
            .filter_map(|node| node.as_str().map(str::to_string))
            .collect::<Vec<_>>()
    };
    let reselected_position = trace_nodes
        .iter()
        .position(|node| node == "V3TargetLocalReselected")
        .unwrap_or_else(|| {
            panic!("missing V3TargetLocalReselected in real trace: {trace_nodes:?}")
        });
    let first_client_frame_position = trace_nodes
        .iter()
        .position(|node| node == "V3ServerRespOutbound06ClientFrame")
        .unwrap_or_else(|| {
            panic!("missing V3ServerRespOutbound06ClientFrame in real trace: {trace_nodes:?}")
        });
    assert!(
        reselected_position < first_client_frame_position,
        "V3TargetLocalReselected must be recorded before the first client frame: {trace_nodes:?}"
    );

    handle.wait_for_codex_sample_persistence().await.unwrap();
    let shutdown_failures = handle.shutdown().await;
    assert!(
        shutdown_failures.is_empty(),
        "codex sample persistence failed: {shutdown_failures:?}"
    );
    upstream_shutdown_tx.send(()).unwrap();
    std::env::remove_var("V3_RESPONSES_PRIMARY_KEY");
    std::env::remove_var("V3_OPENAI_CHAT_SECONDARY_KEY");
    std::env::remove_var("ROUTECODEX_V3_PROVIDER_COOLDOWN_STATE");
    match original_home {
        Some(home) => std::env::set_var("HOME", home),
        None => std::env::remove_var("HOME"),
    }
}

fn codex_response_sample(home: &Path, server_port: u16) -> Option<PathBuf> {
    let port_dir = home
        .join(".rcc")
        .join("codex-samples")
        .join("openai-chat-completions")
        .join("ports")
        .join(server_port.to_string());
    let entries = std::fs::read_dir(port_dir).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path().join("response.json");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

async fn wait_for_response_sample(home: &Path, server_port: u16) -> Value {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(path) = codex_response_sample(home, server_port) {
            match std::fs::read(&path) {
                Ok(bytes) if !bytes.is_empty() => match serde_json::from_slice::<Value>(&bytes) {
                    Ok(sample) => return sample,
                    Err(err) => eprintln!(
                        "response sample exists but is not yet valid JSON ({}): {}",
                        path.display(),
                        err
                    ),
                },
                Ok(_) => eprintln!(
                    "response sample exists but is still empty: {}",
                    path.display()
                ),
                Err(err) => eprintln!(
                    "response sample is unreadable ({}): {}",
                    path.display(),
                    err
                ),
            }
        }
        assert!(
            Instant::now() < deadline,
            "the real Chat request did not persist a complete client-response sample under {}",
            home.join(".rcc/codex-samples/openai-chat-completions")
                .display()
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn manifest(
    server_port: u16,
    upstream_port: u16,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    // The shared hub_v1 fixture defaults openai_chat to Direct; this test pins
    // its own explicit Relay binding, matching the controlled Chat harness.
    let direct_binding = r#"{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_direct_server_outcome", runtime_owner_path = "v3/crates/routecodex-v3-server/src/executors.rs" }"#;
    let relay_binding = r#"{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "relay", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs" }"#;
    let hub_v1_declaration = hub_v1_test_declaration().replace(direct_binding, relay_binding);
    let source = format!(
        r#"
version = 3

{hub_v1_declaration}

[servers.public_entry]
bind = "127.0.0.1"
port = {server_port}
routing_group = "public_entry"
endpoints = ["openai_chat"]

{server_execution}

[debug]
log_console = false
snapshots = true
codex_samples = true
snapshot_stages = "client-response,provider-response"
retention = {{ raw_requests = 8, raw_responses = 8, events = 128 }}

[providers.primary]
type = "responses"
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "chat-wire-model"
auth = {{ type = "api_key", entries = [{{ alias = "primary", env = "V3_RESPONSES_PRIMARY_KEY" }}] }}
[providers.primary.models.chat-wire-model]
wire_name = "chat-wire-model"
aliases = ["chat-client-alias"]
supports_streaming = true
capabilities = ["text", "tools"]

[providers.secondary]
type = "openai_chat"
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "chat-wire-model"
auth = {{ type = "api_key", entries = [{{ alias = "secondary", env = "V3_OPENAI_CHAT_SECONDARY_KEY" }}] }}
[providers.secondary.models.chat-wire-model]
wire_name = "chat-wire-model"
aliases = ["chat-client-alias"]
supports_streaming = true
capabilities = ["text", "tools"]

[route_groups.public_entry.pools.chat_client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "openai_chat", models = ["chat-client-alias"] }}
targets = [
  {{ kind = "provider_model", provider = "primary", model = "chat-wire-model", key = "primary", priority = 2 }},
  {{ kind = "provider_model", provider = "secondary", model = "chat-wire-model", key = "secondary", priority = 1 }}
]
[route_groups.public_entry.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "primary", model = "chat-wire-model", key = "primary", priority = 2 }},
  {{ kind = "provider_model", provider = "secondary", model = "chat-wire-model", key = "secondary", priority = 1 }}
]
"#,
        hub_v1_declaration = hub_v1_declaration,
        server_execution = hub_v1_server_execution("public_entry"),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

async fn healthy_chat_upstream(
    State(state): State<Arc<UpstreamState>>,
    _headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    state
        .captures
        .send(ProviderCapture {
            provider: "secondary_openai_chat",
            path: "/v1/chat/completions",
            body: body.clone(),
        })
        .unwrap();
    let frames = vec![
        Ok::<Vec<u8>, std::convert::Infallible>(
            b"data: {\"id\":\"chatcmpl-secondary\",\"object\":\"chat.completion.chunk\",\"model\":\"chat-wire-model\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"secondary-after-incomplete\"},\"finish_reason\":null}]}\n\n".to_vec(),
        ),
        Ok(
            b"data: {\"id\":\"chatcmpl-secondary\",\"object\":\"chat.completion.chunk\",\"model\":\"chat-wire-model\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n".to_vec(),
        ),
        Ok(b"data: [DONE]\n\n".to_vec()),
    ];
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from_stream(futures_util::stream::iter(frames)))
        .unwrap()
}

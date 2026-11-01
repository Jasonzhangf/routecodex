//! Public Direct-to-Relay handoff controls.
//!
//! The fixture keeps the standard Chat Direct registry from the shared hub
//! fixture. Alpha is a same-protocol Chat provider. Beta is a Responses
//! provider, so the selected Beta continuation must enter the Chat Relay.

use crate::{hub_v1_fixture, test_home, test_ports};
use routecodex_v3_config::{
    compile_v3_config_05_manifest, parse_v3_config_02_authoring, V3Config05ManifestPublished,
};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex};

static LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();

const KEY_ENV: &str = "FA22072_DIRECT_RELAY_HANDOFF_KEY";
const KEY: &str = "owned-direct-relay-handoff-key";
const ALPHA_WIRE: &str = "alpha-wire";
const BETA_WIRE: &str = "beta-wire";
const ALPHA_TEXT: &str = "A_HANDOFF_HEALTHY";
const BETA_TEXT: &str = "B_HANDOFF_DONE";
const TOOL_CALL_ID: &str = "call_owned_handoff";
const TOOL_RESULT: &str = "OWNED_HANDOFF_HISTORY_RESULT";

#[derive(Debug, Clone)]
struct Capture {
    path: String,
    body: Value,
    authorization: String,
}

fn chat_request(marker: &str, stream: bool, model: &str) -> Value {
    json!({
        "model": model,
        "messages": [
            {"role": "user", "content": marker},
            {"role": "assistant", "tool_calls": [{
                "id": TOOL_CALL_ID,
                "type": "function",
                "function": {"name": "lookup", "arguments": "{\"q\":\"owned\"}"}
            }]},
            {"role": "tool", "tool_call_id": TOOL_CALL_ID, "content": TOOL_RESULT}
        ],
        "tools": [{"type": "function", "function": {
            "name": "lookup",
            "parameters": {"type": "object", "properties": {"q": {"type": "string"}}}
        }}],
        "stream": stream,
        "stream_options": {"include_usage": true}
    })
}

async fn read_request(socket: &mut TcpStream) -> Option<Capture> {
    let mut wire = Vec::new();
    let mut chunk = [0u8; 4096];
    let (head, offset, length) = loop {
        let n = socket.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        wire.extend_from_slice(&chunk[..n]);
        if let Some(at) = wire.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&wire[..at]).into_owned();
            let length = head
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    (key.eq_ignore_ascii_case("content-length"))
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            break (head, at + 4, length);
        }
    };
    while wire.len() < offset + length {
        let n = socket.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        wire.extend_from_slice(&chunk[..n]);
    }
    let path = head.lines().next()?.split_whitespace().nth(1)?.to_owned();
    let authorization = head
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case("authorization")
                .then(|| value.trim().to_owned())
        })
        .unwrap_or_default();
    Some(Capture {
        path,
        body: serde_json::from_slice(&wire[offset..offset + length]).ok()?,
        authorization,
    })
}

fn handoff_manifest(
    port: u16,
    alpha: u16,
    beta: u16,
    beta_only: bool,
) -> V3Config05ManifestPublished {
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let execution = hub_v1_fixture::hub_v1_server_execution("direct_relay_handoff");
    let targets = if beta_only {
        r#"[{ kind = "provider_model", provider = "beta", model = "beta-wire", key = "key1", priority = 1 }]"#
    } else {
        r#"[
  { kind = "provider_model", provider = "alpha", model = "alpha-wire", key = "key1", priority = 2 },
  { kind = "provider_model", provider = "beta", model = "beta-wire", key = "key1", priority = 1 }
]"#
    };
    let source = format!(
        r#"
version = 3
{declaration}
[servers.direct_relay_handoff]
bind = "127.0.0.1"
port = {port}
routing_group = "direct_relay_handoff"
endpoints = ["openai_chat"]
{execution}
[providers.alpha]
type = "openai_chat"
base_url = "http://127.0.0.1:{alpha}/v1"
default_model = "alpha-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key1", env = "{KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.alpha.models.alpha-wire]
wire_name = "alpha-wire"
capabilities = ["text", "tools"]
supports_streaming = true
[providers.beta]
type = "responses"
base_url = "http://127.0.0.1:{beta}/v1"
default_model = "beta-wire"
auth = {{ type = "api_key", entries = [{{ alias = "key1", env = "{KEY_ENV}" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.beta.models.beta-wire]
wire_name = "beta-wire"
capabilities = ["text", "tools"]
supports_streaming = true
[route_groups.direct_relay_handoff.pools.default]
selection = {{ strategy = "priority" }}
targets = {targets}
[debug]
log_console = false
snapshots = true
codex_samples = true
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

async fn write_chat_response(socket: &mut TcpStream, stream: bool) {
    let chat = json!({
        "id": "chatcmpl-owned-alpha",
        "object": "chat.completion",
        "model": ALPHA_WIRE,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": ALPHA_TEXT},
            "finish_reason": "stop"
        }],
        "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}
    });
    let (content_type, body) = if stream {
        (
            "text/event-stream",
            format!(
                "data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
                json!({
                    "id": "chatcmpl-owned-alpha",
                    "object": "chat.completion.chunk",
                    "model": ALPHA_WIRE,
                    "choices": [{
                        "index": 0,
                        "delta": {"role": "assistant", "content": ALPHA_TEXT},
                        "finish_reason": null
                    }]
                }),
                json!({
                    "id": "chatcmpl-owned-alpha",
                    "object": "chat.completion.chunk",
                    "model": ALPHA_WIRE,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}
                })
            ),
        )
    } else {
        ("application/json", chat.to_string())
    };
    let head = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    let _ = socket.write_all(head.as_bytes()).await;
    let _ = socket.write_all(body.as_bytes()).await;
    let _ = socket.flush().await;
}

async fn serve_alpha(
    listener: TcpListener,
    drop_head: Arc<AtomicBool>,
    captures: Arc<Mutex<Vec<Capture>>>,
    order: Arc<Mutex<Vec<&'static str>>>,
) {
    loop {
        let (mut socket, _) = match listener.accept().await {
            Ok(value) => value,
            Err(_) => return,
        };
        let Some(capture) = read_request(&mut socket).await else {
            continue;
        };
        let stream = capture.body["stream"] == true;
        captures.lock().await.push(capture);
        order.lock().await.push("alpha");
        if drop_head.load(Ordering::SeqCst) {
            continue;
        }
        write_chat_response(&mut socket, stream).await;
    }
}

async fn write_beta_response(socket: &mut TcpStream, stream: bool) {
    let response = json!({
        "id": "resp-owned-beta",
        "object": "response",
        "status": "completed",
        "model": BETA_WIRE,
        "output": [{
            "id": "msg-owned-beta",
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "content": [{"type": "output_text", "text": BETA_TEXT, "annotations": []}]
        }],
        "usage": {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5}
    });
    let (content_type, body) = if stream {
        (
            "text/event-stream",
            format!(
                "data: {}\n\ndata: {}\n\ndata: {}\n\n",
                json!({
                    "type": "response.created",
                    "response": {
                        "id": "resp-owned-beta",
                        "status": "in_progress",
                        "model": BETA_WIRE,
                        "output": []
                    }
                }),
                json!({
                    "type": "response.output_text.delta",
                    "response_id": "resp-owned-beta",
                    "output_index": 0,
                    "content_index": 0,
                    "item_id": "msg-owned-beta",
                    "delta": BETA_TEXT
                }),
                json!({"type": "response.completed", "response": response})
            ),
        )
    } else {
        ("application/json", response.to_string())
    };
    let head = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    let _ = socket.write_all(head.as_bytes()).await;
    let _ = socket.write_all(body.as_bytes()).await;
    let _ = socket.flush().await;
}

async fn serve_beta_held(
    listener: TcpListener,
    arrived: oneshot::Sender<Capture>,
    release: oneshot::Receiver<()>,
    captures: Arc<Mutex<Vec<Capture>>>,
    order: Arc<Mutex<Vec<&'static str>>>,
) {
    let (mut socket, _) = listener.accept().await.unwrap();
    let capture = read_request(&mut socket).await.unwrap();
    let stream = capture.body["stream"] == true;
    captures.lock().await.push(capture.clone());
    order.lock().await.push("beta");
    let _ = arrived.send(capture);
    let _ = release.await;
    write_beta_response(&mut socket, stream).await;
}

async fn serve_beta_drop(
    listener: TcpListener,
    captures: Arc<Mutex<Vec<Capture>>>,
    order: Arc<Mutex<Vec<&'static str>>>,
) {
    loop {
        let (mut socket, _) = match listener.accept().await {
            Ok(value) => value,
            Err(_) => return,
        };
        let Some(capture) = read_request(&mut socket).await else {
            continue;
        };
        captures.lock().await.push(capture);
        order.lock().await.push("beta");
        // Close before any HTTP response head.
    }
}

async fn serve_captured_peer(
    listener: TcpListener,
    label: &'static str,
    text: &'static str,
    captures: Arc<Mutex<Vec<Capture>>>,
    order: Arc<Mutex<Vec<&'static str>>>,
) {
    loop {
        let Ok((mut socket, _)) = listener.accept().await else {
            return;
        };
        let Some(capture) = read_request(&mut socket).await else {
            continue;
        };
        captures.lock().await.push(capture);
        order.lock().await.push(label);
        let body = json!({
            "id": format!("resp-owned-{label}"), "object": "response",
            "status": "completed", "model": BETA_WIRE,
            "output": [{"id": format!("msg-owned-{label}"), "type": "message",
                "role": "assistant", "status": "completed",
                "content": [{"type": "output_text", "text": text, "annotations": []}]}],
            "usage": {"input_tokens": 3, "output_tokens": 2, "total_tokens": 5}
        })
        .to_string();
        let wire = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = socket.write_all(wire.as_bytes()).await;
        let _ = socket.flush().await;
    }
}

#[tokio::test]
async fn fa22072_direct_relay_captured_plan_and_exclusions_public_consumer() {
    let (home, _lock) = LOCK.lock().await;
    std::env::set_var(KEY_ENV, KEY);
    let alpha = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let beta = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let gamma = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let delta = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = test_ports::free_port();
    let mut manifest = handoff_manifest(
        port,
        alpha.local_addr().unwrap().port(),
        beta.local_addr().unwrap().port(),
        false,
    );
    for (id, address) in [
        ("gamma", gamma.local_addr().unwrap()),
        ("delta", delta.local_addr().unwrap()),
    ] {
        let mut provider = manifest.providers["beta"].clone();
        provider.id = id.into();
        provider.base_url = format!("http://{address}/v1");
        for interface in provider.interfaces.values_mut() {
            interface.base_url = provider.base_url.clone();
        }
        manifest.providers.insert(id.into(), provider);
    }
    let pool = manifest
        .route_groups
        .get_mut("direct_relay_handoff")
        .unwrap()
        .pools
        .get_mut("default")
        .unwrap();
    pool.targets[0].priority = Some(3);
    pool.targets[1].priority = Some(2);
    let mut gamma_target = pool.targets[1].clone();
    gamma_target.provider = Some("gamma".into());
    gamma_target.priority = Some(1);
    pool.targets.push(gamma_target.clone());
    let mut receiving_manifest = manifest.clone();
    let mut delta_target = gamma_target;
    delta_target.provider = Some("delta".into());
    receiving_manifest
        .route_groups
        .get_mut("direct_relay_handoff")
        .unwrap()
        .pools
        .get_mut("default")
        .unwrap()
        .targets = vec![delta_target];
    let order = Arc::new(Mutex::new(Vec::new()));
    let a = Arc::new(Mutex::new(Vec::new()));
    let b = Arc::new(Mutex::new(Vec::new()));
    let c = Arc::new(Mutex::new(Vec::new()));
    let d = Arc::new(Mutex::new(Vec::new()));
    let peers = [
        tokio::spawn(serve_alpha(
            alpha,
            Arc::new(AtomicBool::new(true)),
            a.clone(),
            order.clone(),
        )),
        tokio::spawn(serve_beta_drop(beta, b.clone(), order.clone())),
        tokio::spawn(serve_captured_peer(
            gamma,
            "gamma",
            "C_CAPTURED_DONE",
            c.clone(),
            order.clone(),
        )),
        tokio::spawn(serve_captured_peer(
            delta,
            "delta",
            "D_ROUTER_REENTRY",
            d.clone(),
            order.clone(),
        )),
    ];
    let scope = routecodex_v3_error::V3ProviderFailureSessionScope::new(
        "direct_relay_handoff",
        "direct_relay_handoff",
        "owned-captured-plan-session",
    )
    .unwrap()
    .with_transport_handoff_scope("owned-captured-plan-pipeline", port, 1)
    .unwrap();
    let payload = chat_request("OWNED_CAPTURED_PLAN", false, "auto");
    let mut raw = routecodex_v3_runtime::build_v3_server_03_http_request_raw(
        "direct_relay_handoff".into(),
        scope.clone(),
        "owned-captured-plan-request".into(),
        "owned-captured-plan-execution".into(),
        "POST".into(),
        "/v1/chat/completions".into(),
        payload.clone(),
    );
    raw.port = Some(port);
    raw.pipeline_id = Some("owned-captured-plan-pipeline".into());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let producer = routecodex_v3_runtime::execute_v3_direct_runtime_kernel_core::<
        routecodex_v3_runtime::V3ChatDirectCodec,
        _,
    >(
        (),
        &manifest,
        raw,
        routecodex_v3_runtime::default_responses_transport(),
        routecodex_v3_runtime::V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(
            &manifest,
        ),
        now,
        true,
        None,
        None,
    )
    .await;
    let mut controls = Vec::new();
    if let Some(handoff) = producer.protocol_relay_handoff {
        if handoff.target.candidate.provider_id != "beta"
            || handoff.expanded.candidates.len() != 3
            || !handoff
                .request_local_excluded_candidates
                .contains("alpha:default:key1:alpha-wire")
        {
            controls
                .push("producer did not preserve selected B, captured A/B/C and excluded A".into());
        }
        let original_source = handoff
            .provider_failure_events
            .first()
            .and_then(|event| event.diagnostic_source.clone());
        let result = tokio::time::timeout(Duration::from_secs(8),
            routecodex_v3_runtime::execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health_and_handoff(
                &receiving_manifest,
                routecodex_v3_runtime::V3OpenAiChatRelayRuntimeInput {
                    server_id: "direct_relay_handoff".into(), failure_session_scope: scope,
                    request_id: "owned-captured-plan-request".into(), payload,
                },
                routecodex_v3_runtime::V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&receiving_manifest),
                handoff,
            )).await;
        match result {
            Ok(Ok(output)) => {
                let alpha_sources: Vec<_> = output
                    .observability
                    .iter()
                    .flat_map(|observability| &observability.provider_failure_events)
                    .filter(|event| event.provider_id == "alpha")
                    .collect();
                if original_source.is_none()
                    || alpha_sources.len() != 1
                    || serde_json::to_value(
                        &alpha_sources
                            .first()
                            .and_then(|event| event.diagnostic_source.as_ref()),
                    )
                    .unwrap()
                        != serde_json::to_value(&original_source).unwrap()
                {
                    controls.push("original A source must be retained exactly once".into());
                }
                if output.status != 200 || output.error_chain.is_some() {
                    controls.push(format!(
                        "receiving outcome is not genuine success: {output:?}"
                    ));
                }
                let payload = output.into_v3_resp_15_client_payload();
                match payload.body {
                    routecodex_v3_runtime::V3ClientBody::Json(body) => {
                        if body["choices"][0]["message"]["content"] != "C_CAPTURED_DONE"
                            || body["choices"][0]["finish_reason"] != "stop"
                            || body["model"] != BETA_WIRE
                            || body["usage"]["total_tokens"] != 5
                            || body.to_string().contains("D_ROUTER_REENTRY")
                        {
                            controls.push(format!("captured C semantics were lost: {body}"));
                        }
                    }
                    _ => controls.push("JSON consumer returned non-JSON body".into()),
                }
            }
            other => controls.push(format!(
                "captured-plan consumer did not complete: {other:?}"
            )),
        }
    } else {
        controls.push("Direct did not return a typed Relay handoff".into());
    }
    let counts = [
        a.lock().await.len(),
        b.lock().await.len(),
        c.lock().await.len(),
        d.lock().await.len(),
    ];
    let actual_order = order.lock().await.clone();
    if counts != [1, 1, 1, 0] || actual_order != ["alpha", "beta", "gamma"] {
        controls.push(format!(
            "expected A1/B1/C1/D0 in order, counts={counts:?} order={actual_order:?}"
        ));
    }
    for task in peers {
        task.abort();
        let _ = task.await;
    }
    std::env::remove_var(KEY_ENV);
    drop(home);
    eprintln!(
        "captured-plan counts={counts:?} order={actual_order:?} cleanup=true controls={controls:?}"
    );
    assert!(
        controls.is_empty(),
        "captured-plan/exclusion controls failed: {controls:?}"
    );
}

async fn raw_post_chat(port: u16, body: &Value) -> Vec<u8> {
    let body = body.to_string();
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    socket
        .write_all(
            format!(
                "POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    socket.flush().await.unwrap();
    let mut bytes = Vec::new();
    let result = tokio::time::timeout(Duration::from_secs(3), socket.read_to_end(&mut bytes))
        .await
        .expect("failed request transport must close without waiting for future recovery");
    if let Err(error) = result {
        assert!(
            matches!(
                error.kind(),
                std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::UnexpectedEof
            ),
            "unexpected read error: {error}"
        );
    }
    bytes
}

async fn wait_for_capture_count(
    captures: &Arc<Mutex<Vec<Capture>>>,
    expected: usize,
    limit: Duration,
) -> bool {
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        if captures.lock().await.len() >= expected {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn run_business_case(beta_only: bool) -> Vec<String> {
    let mut controls = Vec::new();
    for stream in [false, true] {
        let alpha_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let alpha_port = alpha_listener.local_addr().unwrap().port();
        let alpha_captures = Arc::new(Mutex::new(Vec::new()));
        let order = Arc::new(Mutex::new(Vec::new()));
        let alpha_task = tokio::spawn(serve_alpha(
            alpha_listener,
            Arc::new(AtomicBool::new(true)),
            alpha_captures.clone(),
            order.clone(),
        ));
        let beta_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let beta_port = beta_listener.local_addr().unwrap().port();
        let beta_captures = Arc::new(Mutex::new(Vec::new()));
        let (arrived_tx, arrived_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let beta_task = tokio::spawn(serve_beta_held(
            beta_listener,
            arrived_tx,
            release_rx,
            beta_captures.clone(),
            order.clone(),
        ));
        let handle = spawn_v3_server_aggregate(handoff_manifest(
            test_ports::free_port(),
            alpha_port,
            beta_port,
            beta_only,
        ))
        .await
        .unwrap();
        let port = handle.listeners[0].addr.port();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(12))
            .build()
            .unwrap();
        let marker = format!("OWNED_DIRECT_RELAY_BETA_ONLY_{beta_only}_STREAM_{stream}");
        let request = client
            .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
            .json(&chat_request(&marker, stream, "auto"));
        let client_task = tokio::spawn(async move {
            let response = request.send().await?;
            let status = response.status().as_u16();
            let bytes = response.bytes().await?;
            Ok::<_, reqwest::Error>((status, bytes))
        });
        let arrival = tokio::time::timeout(Duration::from_secs(8), arrived_rx).await;
        let prior_attempt_count = alpha_captures.lock().await.len();
        match arrival {
            Ok(Ok(capture)) => {
                let expected_prior = if beta_only { 0 } else { 1 };
                if prior_attempt_count != expected_prior
                    || client_task.is_finished()
                    || capture.path != "/v1/responses"
                    || capture.authorization != format!("Bearer {KEY}")
                    || capture.body["model"] != BETA_WIRE
                    || !capture.body["input"].is_array()
                    || !capture.body.to_string().contains(&marker)
                    || !capture.body.to_string().contains(TOOL_CALL_ID)
                    || !capture.body.to_string().contains(TOOL_RESULT)
                {
                    controls.push(format!(
                        "stream={stream}: handoff/held-client control failed: A={prior_attempt_count}, B={capture:?}"
                    ));
                }
            }
            other => controls.push(format!(
                "stream={stream}: cross-protocol successor never arrived: {other:?}"
            )),
        }
        let _ = release_tx.send(());
        let result = client_task.await.unwrap();
        match result {
            Ok((status, bytes)) => {
                let text = String::from_utf8_lossy(&bytes);
                if status != 200
                    || !text.contains(BETA_TEXT)
                    || !text.contains(BETA_WIRE)
                    || !text.contains("stop")
                    || !text.contains("usage")
                    || !text.contains("\"total_tokens\":5")
                    || text.contains("\"error\"")
                    || text.contains(KEY)
                    || text.contains("diagnostic_source")
                    || (stream && !text.contains("[DONE]"))
                {
                    controls.push(format!(
                        "stream={stream}: genuine B result/privacy failed: {status} {text}"
                    ));
                }
            }
            Err(error) => {
                controls.push(format!("stream={stream}: client did not recover: {error}"))
            }
        }
        let final_alpha = alpha_captures.lock().await;
        if final_alpha.len() != prior_attempt_count
            || final_alpha.iter().any(|capture| {
                capture.path != "/v1/chat/completions"
                    || capture.body["model"] != ALPHA_WIRE
                    || capture.authorization != format!("Bearer {KEY}")
                    || !capture.body.to_string().contains(&marker)
            })
        {
            controls.push(format!(
                "stream={stream}: prior Direct calls changed after B: {final_alpha:?}"
            ));
        }
        drop(final_alpha);
        let observed_order = order.lock().await.clone();
        let expected_order: Vec<&str> = if beta_only {
            vec!["beta"]
        } else {
            vec!["alpha", "beta"]
        };
        if observed_order.as_slice() != expected_order.as_slice() {
            controls.push(format!(
                "stream={stream}: provider order must be {expected_order:?}, got {observed_order:?}"
            ));
        }
        let logs: Value = client
            .get(format!("http://127.0.0.1:{port}/_routecodex/debug/logs"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        if !logs["logs"].as_array().unwrap().iter().any(|event| {
            event["node_id"] == "V3Server03HttpRequestRaw"
                && event["details"]["execution_mode"] == "direct"
        }) {
            controls.push(format!(
                "stream={stream}: request did not enter the standard Direct registry"
            ));
        }
        if beta_task.is_finished() {
            beta_task.await.unwrap();
        } else {
            beta_task.abort();
            let _ = beta_task.await;
        }
        alpha_task.abort();
        let _ = alpha_task.await;
        let failures = handle.shutdown().await;
        eprintln!(
            "direct-relay-handoff beta_only={beta_only} stream={stream} prior_A={prior_attempt_count} held_B_released=true diagnostic_persistence_failures={failures:?} controls={controls:?}"
        );
    }
    controls
}

#[tokio::test]
async fn fa22072_direct_to_relay_business_continuation_public_entry() {
    let (home, _lock) = LOCK.lock().await;
    std::env::set_var(KEY_ENV, KEY);
    let controls = run_business_case(false).await;
    std::env::remove_var(KEY_ENV);
    drop(home);
    assert!(
        controls.is_empty(),
        "Direct-to-Relay business controls failed: {controls:?}"
    );
}

#[tokio::test]
async fn fa22072_direct_to_relay_beta_positive_public_entry() {
    let (home, _lock) = LOCK.lock().await;
    std::env::set_var(KEY_ENV, KEY);
    let controls = run_business_case(true).await;
    std::env::remove_var(KEY_ENV);
    drop(home);
    assert!(
        controls.is_empty(),
        "B-only public controls failed: {controls:?}"
    );
}

#[tokio::test]
async fn fa22072_direct_kernel_returns_selected_relay_handoff_public_consumer() {
    let (home, _lock) = LOCK.lock().await;
    std::env::set_var(KEY_ENV, KEY);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let alpha_port = listener.local_addr().unwrap().port();
    let captures = Arc::new(Mutex::new(Vec::new()));
    let order = Arc::new(Mutex::new(Vec::new()));
    let alpha_task = tokio::spawn(serve_alpha(
        listener,
        Arc::new(AtomicBool::new(true)),
        captures.clone(),
        order.clone(),
    ));
    let beta_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let beta_port = beta_listener.local_addr().unwrap().port();
    let (beta_accept_tx, mut beta_accept_rx) = oneshot::channel();
    let beta_accept_task = tokio::spawn(async move {
        if beta_listener.accept().await.is_ok() {
            let _ = beta_accept_tx.send(());
        }
    });
    let port = test_ports::free_port();
    let manifest = handoff_manifest(port, alpha_port, beta_port, false);
    let scope = routecodex_v3_error::V3ProviderFailureSessionScope::new(
        "direct_relay_handoff",
        "direct_relay_handoff",
        "owned-kernel-handoff-session",
    )
    .unwrap()
    .with_transport_handoff_scope("owned-kernel-handoff-pipeline", port, 1)
    .unwrap();
    let mut raw = routecodex_v3_runtime::build_v3_server_03_http_request_raw(
        "direct_relay_handoff".into(),
        scope,
        "owned-kernel-handoff-request".into(),
        "owned-kernel-handoff-execution".into(),
        "POST".into(),
        "/v1/chat/completions".into(),
        chat_request("OWNED_KERNEL_HANDOFF", false, "auto"),
    );
    raw.port = Some(port);
    raw.pipeline_id = Some("owned-kernel-handoff-pipeline".into());
    let observed_failures = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink_failures = observed_failures.clone();
    let failure_sink: routecodex_v3_runtime::V3RuntimeProviderFailureEventSink =
        Arc::new(move |_, event| {
            sink_failures.lock().unwrap().push(event.clone());
        });
    let selected = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink_selected = selected.clone();
    let route_sink: routecodex_v3_runtime::V3RuntimeRouteSelectionEventSink =
        Arc::new(move |event| {
            sink_selected.lock().unwrap().push(format!("{event:?}"));
        });
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    let output = routecodex_v3_runtime::execute_v3_direct_runtime_kernel_core::<
        routecodex_v3_runtime::V3ChatDirectCodec,
        _,
    >(
        (),
        &manifest,
        raw,
        routecodex_v3_runtime::default_responses_transport(),
        routecodex_v3_runtime::V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(
            &manifest,
        ),
        now,
        true,
        Some(&failure_sink),
        Some(&route_sink),
    )
    .await;
    let alpha_captures = captures.lock().await.clone();
    let beta_received = matches!(
        tokio::time::timeout(Duration::from_millis(100), &mut beta_accept_rx).await,
        Ok(Ok(()))
    );
    alpha_task.abort();
    let _ = alpha_task.await;
    beta_accept_task.abort();
    let _ = beta_accept_task.await;
    std::env::remove_var(KEY_ENV);
    drop(home);
    eprintln!(
        "kernel-handoff A={} B_received={beta_received} selected={:?} output={output:?} cleanup=true",
        alpha_captures.len(),
        selected.lock().unwrap()
    );
    assert_eq!(
        alpha_captures.len(),
        1,
        "Direct producer must not resend failed A before B handoff"
    );
    assert!(
        !beta_received,
        "producer must return handoff before Relay's real send"
    );
    assert_eq!(alpha_captures[0].path, "/v1/chat/completions");
    assert_eq!(alpha_captures[0].body["model"], ALPHA_WIRE);
    assert_eq!(alpha_captures[0].authorization, format!("Bearer {KEY}"));
    assert!(alpha_captures[0]
        .body
        .to_string()
        .contains("OWNED_KERNEL_HANDOFF"));
    let handoff = output
        .protocol_relay_handoff
        .expect("Direct producer selected B Relay handoff");
    assert_eq!(handoff.target.candidate.provider_id, "beta");
    assert_eq!(handoff.target.candidate.model_id, BETA_WIRE);
    assert_eq!(handoff.target.candidate.auth_alias, "key1");
    assert!(handoff
        .expanded
        .candidates
        .iter()
        .any(|candidate| candidate.provider_id == "alpha"));
    assert!(handoff
        .expanded
        .candidates
        .iter()
        .any(|candidate| candidate.provider_id == "beta"));
    assert!(handoff
        .request_local_excluded_candidates
        .contains("alpha:default:key1:alpha-wire"));
    assert!(!handoff
        .request_local_excluded_candidates
        .contains("beta:default:key1:beta-wire"));
    assert_eq!(handoff.provider_failure_events.len(), 1);
    assert_eq!(observed_failures.lock().unwrap().len(), 1);
    assert!(handoff.node_trace.contains(&"V3TargetLocalReselected"));
    assert!(handoff
        .node_trace
        .contains(&"V3Execution11ProtocolDecision"));
    let source =
        serde_json::to_value(&handoff.provider_failure_events[0].diagnostic_source).unwrap();
    assert_eq!(source["source_kind"], "provider_failure");
    assert!(source["message"]
        .as_str()
        .unwrap()
        .contains("provider alpha"));
}

#[tokio::test]
async fn fa22072_direct_relay_provider_model_pin_failure_does_not_admit_default_pool() {
    let (home, _lock) = LOCK.lock().await;
    std::env::set_var(KEY_ENV, KEY);
    let alpha_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let alpha_port = alpha_listener.local_addr().unwrap().port();
    let alpha_captures = Arc::new(Mutex::new(Vec::new()));
    let order = Arc::new(Mutex::new(Vec::new()));
    let drop_alpha = Arc::new(AtomicBool::new(false));
    let alpha_task = tokio::spawn(serve_alpha(
        alpha_listener,
        drop_alpha.clone(),
        alpha_captures.clone(),
        order.clone(),
    ));
    let beta_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let beta_port = beta_listener.local_addr().unwrap().port();
    let beta_captures = Arc::new(Mutex::new(Vec::new()));
    let beta_task = tokio::spawn(serve_beta_drop(
        beta_listener,
        beta_captures.clone(),
        order.clone(),
    ));
    let handle = spawn_v3_server_aggregate(handoff_manifest(
        test_ports::free_port(),
        alpha_port,
        beta_port,
        false,
    ))
    .await
    .unwrap();
    let port = handle.listeners[0].addr.port();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();

    let before = client
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .json(&chat_request(
            "OWNED_PIN_HEALTHY_BEFORE",
            false,
            "alpha.alpha-wire",
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(before.status(), 200);
    let before_body: Value = before.json().await.unwrap();
    assert_eq!(before_body["choices"][0]["message"]["content"], ALPHA_TEXT);

    drop_alpha.store(true, Ordering::SeqCst);
    let before_alpha = alpha_captures.lock().await.len();
    let before_beta = beta_captures.lock().await.len();
    let raw = raw_post_chat(
        port,
        &chat_request("OWNED_PIN_EXHAUSTION", false, "alpha.alpha-wire"),
    )
    .await;
    let alpha_after = alpha_captures.lock().await.len();
    let beta_after = beta_captures.lock().await.len();
    let text = String::from_utf8_lossy(&raw);
    assert_eq!(
        alpha_after - before_alpha,
        1,
        "the exact pin must be attempted once"
    );
    assert_eq!(
        beta_after - before_beta,
        0,
        "a failed exact pin must not admit the default pool"
    );
    assert!(
        raw.is_empty(),
        "pinned exhaustion must close the transport without client bytes: {text}"
    );
    assert!(
        !text.contains("\"error\"") && !text.contains("[DONE]") && !text.contains(KEY),
        "pinned exhaustion leaked error, fake completion, or credential: {text}"
    );

    drop_alpha.store(false, Ordering::SeqCst);
    let after = client
        .post(format!("http://127.0.0.1:{port}/v1/chat/completions"))
        .json(&chat_request(
            "OWNED_PIN_HEALTHY_AFTER",
            false,
            "alpha.alpha-wire",
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(after.status(), 200);
    let after_body: Value = after.json().await.unwrap();
    assert_eq!(after_body["choices"][0]["message"]["content"], ALPHA_TEXT);

    beta_task.abort();
    let _ = beta_task.await;
    alpha_task.abort();
    let _ = alpha_task.await;
    let failures = handle.shutdown().await;
    std::env::remove_var(KEY_ENV);
    drop(home);
    eprintln!("direct-relay-pin diagnostic_persistence_failures={failures:?}");
}

#[tokio::test]
async fn fa22072_direct_relay_default_pool_exhaustion_public_entry() {
    let (home, _lock) = LOCK.lock().await;
    std::env::set_var(KEY_ENV, KEY);
    let mut controls = Vec::new();
    for stream in [false, true] {
        let alpha_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let alpha_port = alpha_listener.local_addr().unwrap().port();
        let alpha_captures = Arc::new(Mutex::new(Vec::new()));
        let order = Arc::new(Mutex::new(Vec::new()));
        let alpha_task = tokio::spawn(serve_alpha(
            alpha_listener,
            Arc::new(AtomicBool::new(true)),
            alpha_captures.clone(),
            order.clone(),
        ));
        let beta_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let beta_port = beta_listener.local_addr().unwrap().port();
        let beta_captures = Arc::new(Mutex::new(Vec::new()));
        let beta_task = tokio::spawn(serve_beta_drop(
            beta_listener,
            beta_captures.clone(),
            order.clone(),
        ));
        let handle = spawn_v3_server_aggregate(handoff_manifest(
            test_ports::free_port(),
            alpha_port,
            beta_port,
            false,
        ))
        .await
        .unwrap();
        let port = handle.listeners[0].addr.port();
        let marker = format!("OWNED_DIRECT_RELAY_EXHAUSTION_STREAM_{stream}");
        let raw = raw_post_chat(port, &chat_request(&marker, stream, "auto")).await;
        let alpha_ready = wait_for_capture_count(&alpha_captures, 1, Duration::from_secs(2)).await;
        let beta_ready = wait_for_capture_count(&beta_captures, 1, Duration::from_secs(2)).await;
        if !alpha_ready || !beta_ready {
            controls.push(format!(
                "stream={stream}: expected A1/B1 exhaustion attempts, got A={} B={}",
                alpha_captures.lock().await.len(),
                beta_captures.lock().await.len()
            ));
        }
        let observed_order = order.lock().await.clone();
        if observed_order.as_slice() != ["alpha", "beta"].as_slice() {
            controls.push(format!(
                "stream={stream}: exhaustion provider order must be [alpha, beta], got {observed_order:?}"
            ));
        }
        let text = String::from_utf8_lossy(&raw);
        if !stream && !raw.is_empty() {
            controls.push(format!(
                "stream={stream}: exhausted transport delivered bytes: {text}"
            ));
        }
        if stream
            && (text.contains("data:")
                || text.contains("[DONE]")
                || text.contains("event: error")
                || text.contains("\"error\"")
                || text.contains(KEY)
                || text.contains("503"))
        {
            controls.push(format!(
                "stream={stream}: exhausted SSE delivered a business/error terminal: {text}"
            ));
        }
        beta_task.abort();
        let _ = beta_task.await;
        alpha_task.abort();
        let _ = alpha_task.await;
        let failures = handle.shutdown().await;
        eprintln!(
            "direct-relay-exhaustion stream={stream} A={} B={} bytes={} diagnostic_persistence_failures={failures:?} controls={controls:?}",
            alpha_captures.lock().await.len(),
            beta_captures.lock().await.len(),
            raw.len()
        );
    }
    std::env::remove_var(KEY_ENV);
    drop(home);
    assert!(
        controls.is_empty(),
        "Direct-to-Relay exhaustion controls failed: {controls:?}"
    );
}

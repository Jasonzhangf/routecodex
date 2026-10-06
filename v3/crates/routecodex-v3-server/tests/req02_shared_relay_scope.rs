use axum::{
    body::Body,
    extract::State,
    http::{header, StatusCode},
    response::Response,
    routing::post,
    Router,
};
use futures_util::StreamExt;
use routecodex_v3_config::{
    compile_v3_config_05_manifest, parse_v3_config_02_authoring, V3Config05ManifestPublished,
};
use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_runtime::kernel::{
    execute_v3_direct_runtime_kernel_core_with_request_control, ResponsesTransport,
    V3ProviderError, V3ProviderResp14Raw, V3Transport13ResponsesHttpRequest,
};
use routecodex_v3_runtime::operation_runner::execute_v3_operation_runner_request_capture_client_json;
use routecodex_v3_runtime::{
    build_v3_server_03_http_request_raw_with_purpose_and_scope,
    execute_v3_openai_chat_relay_handoff_runtime_with_default_transport_provider_health_and_request_control,
    execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health_execution_mode_and_request_control,
    V3ChatDirectCodec, V3HubExecutionMode, V3OpenAiChatRelayClientBody,
    V3OpenAiChatRelayRuntimeInput, V3ProviderFailureRuntimeHealth, V3RelayRuntimeEntry,
    V3RequestExecutionControl, V3RequestPurpose,
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::{
    net::TcpListener,
    sync::{oneshot, Notify},
    time::{timeout, Duration},
};

const AUTH_ENV: &str = "REQ02_SHARED_RELAY_SCOPE_KEY";

#[tokio::test]
async fn req02_chat_canonical_handoff_reaches_provider_without_republishing_original_pair() {
    let (base_url, upstream, shutdown) = start_upstream(UpstreamReply::JsonOk).await;
    let server_id = "req02_chat_canonical_handoff";
    let request_id = "req02-chat-canonical-handoff";
    let manifest = manifest(server_id, &base_url);
    let control = request_control(&manifest, server_id, request_id);
    let handle = control.request_context().clone();
    let captured = execute_v3_operation_runner_request_capture_client_json(json!({
        "model": "client-test",
        "messages": [{"role": "user", "content": "req02 shared relay scope"}],
        "stream": false
    }))
    .unwrap();
    let raw = build_v3_server_03_http_request_raw_with_purpose_and_scope(
        server_id.to_string(),
        failure_scope(server_id, request_id),
        request_id.to_string(),
        format!("{request_id}-exec"),
        "POST".to_string(),
        "/v1/chat/completions".to_string(),
        V3RequestPurpose::Conversation,
        Some(45444),
        Some(format!("{request_id}-pipeline")),
        captured,
    );
    // The real Direct phase runs REQ02 once and publishes the request pair, then
    // selects a Relay target. The typed handoff moves the canonical Value plus
    // the captured target/control; the Relay entry must consume that handoff
    // instead of republishing the original raw entry.
    let direct =
        execute_v3_direct_runtime_kernel_core_with_request_control::<V3ChatDirectCodec, _>(
            (),
            &manifest,
            raw,
            &PanicTransport,
            V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest),
            0,
            true,
            None,
            None,
            control,
        )
        .await;
    let handoff = direct
        .protocol_relay_handoff
        .expect("relay-only chat entry must produce a typed Direct-to-Relay handoff");
    assert!(
        handle.original_pair().is_ok(),
        "the Direct phase must have published the request pair exactly once"
    );
    let relay_entry = V3RelayRuntimeEntry::direct_relay_handoff(
        handoff.target,
        handoff.expanded,
        handoff.request_local_excluded_candidates,
        handoff.observability_accumulator,
    );
    upstream.release.notify_one();
    let result = timeout(Duration::from_secs(5),
        execute_v3_openai_chat_relay_handoff_runtime_with_default_transport_provider_health_and_request_control(
            &manifest,
            V3OpenAiChatRelayRuntimeInput {
                server_id: server_id.to_string(),
                failure_session_scope: failure_scope(server_id, request_id),
                request_id: request_id.to_string(),
                payload: handoff.canonical_request,
            },
            V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(&manifest),
            V3HubExecutionMode::Relay,
            relay_entry,
            handoff.request_execution_control,
            handoff.route_policy_pending,
        ),
    ).await;
    let calls = upstream.calls.load(Ordering::SeqCst);
    let _ = shutdown.send(());
    let output = result
        .expect("canonical handoff must finish within timeout")
        .expect("canonical handoff must reuse the pair instead of republishing raw entry");
    assert_eq!(calls, 1, "the first provider attempt must be reached");
    match output.client_body {
        V3OpenAiChatRelayClientBody::Json(body) => assert_eq!(
            body["choices"][0]["message"]["content"],
            "shared relay json ok"
        ),
        V3OpenAiChatRelayClientBody::Sse(_) => panic!("JSON handoff must return JSON"),
    }
}

struct PanicTransport;

#[async_trait::async_trait]
impl ResponsesTransport for PanicTransport {
    async fn send(
        &self,
        _request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        panic!("a Relay-only Direct phase must not send a provider attempt");
    }
}

#[derive(Clone, Copy)]
enum UpstreamReply {
    JsonOk,
    SseOk,
}

struct UpstreamControl {
    reply: UpstreamReply,
    arrived: Arc<Notify>,
    release: Arc<Notify>,
    calls: Arc<AtomicUsize>,
}

async fn controlled_upstream(State(control): State<Arc<UpstreamControl>>) -> Response<Body> {
    control.calls.fetch_add(1, Ordering::SeqCst);
    control.arrived.notify_one();
    control.release.notified().await;

    match control.reply {
        UpstreamReply::JsonOk => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(&json!({
                    "id": "resp_req02_shared_relay_json",
                    "status": "completed",
                    "output": [{"type": "output_text", "text": "shared relay json ok"}],
                    "usage": {
                        "input_tokens": 3,
                        "output_tokens": 2,
                        "total_tokens": 5
                    }
                }))
                .unwrap(),
            ))
            .unwrap(),
        UpstreamReply::SseOk => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/event-stream")
            .body(Body::from(
                concat!(
                    "event: response.output_text.delta\n",
                    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"shared relay sse ok\"}\n\n",
                    "event: response.completed\n",
                    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_req02_shared_relay_sse\",\"status\":\"completed\",\"output\":[{\"type\":\"output_text\",\"text\":\"shared relay sse ok\"}],\"usage\":{\"input_tokens\":3,\"output_tokens\":3,\"total_tokens\":6}}}\n\n"
                ),
            ))
            .unwrap(),
    }
}

async fn start_upstream(
    reply: UpstreamReply,
) -> (String, Arc<UpstreamControl>, oneshot::Sender<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let control = Arc::new(UpstreamControl {
        reply,
        arrived: Arc::new(Notify::new()),
        release: Arc::new(Notify::new()),
        calls: Arc::new(AtomicUsize::new(0)),
    });
    let app = Router::new()
        .route("/v1/responses", post(controlled_upstream))
        .with_state(Arc::clone(&control));
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (format!("http://{address}/v1"), control, shutdown_tx)
}

fn manifest(server_id: &str, provider_base_url: &str) -> V3Config05ManifestPublished {
    std::env::set_var(AUTH_ENV, "req02-test-key");
    let source = format!(
        r#"
version = 3
[servers.{server_id}]
bind = "127.0.0.1"
port = 45444
routing_group = "{server_id}"
endpoints = ["openai_chat"]
[servers.{server_id}.execution]
allowed_modes = ["relay"]
allowed_invocation_sources = ["client", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = {{}}
[providers.test]
type = "responses"
base_url = "{provider_base_url}"
default_model = "wire-test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{AUTH_ENV}" }}] }}
[providers.test.models.wire-test]
wire_name = "wire-test"
aliases = ["client-test"]
capabilities = ["text"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
[route_groups.{server_id}.pools.chat_client]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, entry_protocol = "openai_chat", models = ["client-test"] }}
targets = [{{ kind = "provider_model", provider = "test", model = "wire-test", key = "key", priority = 1 }}]
[route_groups.{server_id}.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "test", model = "wire-test", key = "key", priority = 1 }}]
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn failure_scope(server_id: &str, request_id: &str) -> V3ProviderFailureSessionScope {
    V3ProviderFailureSessionScope::new(server_id, server_id, format!("{request_id}-session"))
        .unwrap()
        .with_transport_handoff_scope(format!("{request_id}-pipeline"), 45444, 1)
        .unwrap()
}

fn request_control(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    request_id: &str,
) -> V3RequestExecutionControl {
    V3RequestExecutionControl::new(manifest, server_id, request_id, "openai_chat").unwrap()
}

fn relay_input(server_id: &str, request_id: &str, stream: bool) -> V3OpenAiChatRelayRuntimeInput {
    V3OpenAiChatRelayRuntimeInput {
        server_id: server_id.to_string(),
        failure_session_scope: failure_scope(server_id, request_id),
        request_id: request_id.to_string(),
        payload: json!({
            "model": "client-test",
            "messages": [{"role": "user", "content": "req02 shared relay scope"}],
            "stream": stream
        }),
    }
}

async fn call_relay_runtime(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    request_id: &str,
    stream: bool,
    control: V3RequestExecutionControl,
) -> Result<
    routecodex_v3_runtime::V3OpenAiChatRelayRuntimeOutput,
    routecodex_v3_runtime::V3OpenAiChatRelayRuntimeError,
> {
    let provider_health =
        V3ProviderFailureRuntimeHealth::from_manifest_for_isolated_tests(manifest);
    execute_v3_openai_chat_relay_runtime_with_default_transport_provider_health_execution_mode_and_request_control(
        manifest,
        relay_input(server_id, request_id, stream),
        provider_health,
        V3HubExecutionMode::Relay,
        control,
        None,
    )
    .await
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ScopeState {
    Active,
    Released,
}

fn scope_state(control: &V3RequestExecutionControl) -> ScopeState {
    match control.request_context().original_pair() {
        Ok(_) => ScopeState::Active,
        Err(error) if error.contains("scope already released") => ScopeState::Released,
        Err(error) if error.contains("original pair not initialized") => ScopeState::Active,
        Err(error) => panic!("unexpected public request-scope state: {error}"),
    }
}

fn sse_json_frames(body: &str) -> Vec<Value> {
    body.lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .map(str::trim)
        .filter(|data| *data != "[DONE]")
        .map(|data| serde_json::from_str(data).unwrap())
        .collect()
}

#[tokio::test]
async fn req02_shared_relay_openai_chat_sse_scope_active_until_eof_then_released() {
    let (base_url, upstream, shutdown) = start_upstream(UpstreamReply::SseOk).await;
    upstream.release.notify_one();
    let server_id = "req02_shared_relay_openai_chat_sse";
    let request_id = "req02-shared-relay-openai-chat-sse";
    let manifest = manifest(server_id, &base_url);
    let control = request_control(&manifest, server_id, request_id);
    let observer = control.clone();
    let initial_state = scope_state(&observer);

    let output = match call_relay_runtime(&manifest, server_id, request_id, true, control).await {
        Ok(output) => output,
        Err(error) => {
            let _ = shutdown.send(());
            panic!("real OpenAI Chat Relay SSE failed before client projection: {error}");
        }
    };
    let status = output.status;
    let after_return = scope_state(&observer);
    let V3OpenAiChatRelayClientBody::Sse(mut stream) = output.client_body else {
        let _ = shutdown.send(());
        panic!("real OpenAI Chat Relay SSE must return an SSE client body");
    };

    let mut forwarded = Vec::new();
    while let Some(chunk) = stream.next().await {
        forwarded.extend(chunk);
    }
    let after_eof = scope_state(&observer);
    let forwarded = String::from_utf8(forwarded).unwrap();
    let _ = shutdown.send(());

    assert_eq!(initial_state, ScopeState::Active);
    assert_eq!(status, 200, "{forwarded}");
    assert_eq!(upstream.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        after_return,
        ScopeState::Active,
        "scope must remain active after the public SSE output returns and before EOF"
    );
    assert!(
        forwarded.contains("\"object\":\"chat.completion.chunk\""),
        "client SSE must project valid Chat chunks: {forwarded}"
    );
    assert!(
        forwarded.contains("\"content\":\"shared relay sse ok\""),
        "client SSE must preserve the provider text: {forwarded}"
    );
    assert!(
        forwarded.contains("\"finish_reason\":\"stop\""),
        "client SSE must carry the Chat terminal finish reason: {forwarded}"
    );
    assert_eq!(
        forwarded.matches("data: [DONE]").count(),
        1,
        "client SSE must carry exactly one Chat [DONE] terminal: {forwarded}"
    );
    let frames = sse_json_frames(&forwarded);
    assert!(
        frames.iter().any(|frame| {
            frame["choices"][0]["delta"]["content"] == json!("shared relay sse ok")
        }),
        "client SSE JSON frames must preserve the provider text: {frames:?}"
    );
    assert_eq!(
        after_eof,
        ScopeState::Released,
        "draining the real SSE stream to EOF must release the scope while the stream and observer clone remain alive"
    );
}

#[tokio::test]
async fn req02_shared_relay_openai_chat_cancel_releases_with_observer_control_alive() {
    let (base_url, upstream, shutdown) = start_upstream(UpstreamReply::SseOk).await;
    let server_id = "req02_shared_relay_openai_chat_cancel";
    let request_id = "req02-shared-relay-openai-chat-cancel";
    let manifest = manifest(server_id, &base_url);
    let control = request_control(&manifest, server_id, request_id);
    let observer = control.clone();
    let manifest_for_task = manifest.clone();
    let handle = tokio::spawn(async move {
        call_relay_runtime(&manifest_for_task, server_id, request_id, true, control).await
    });

    if timeout(Duration::from_secs(5), upstream.arrived.notified())
        .await
        .is_err()
    {
        upstream.release.notify_one();
        let _ = shutdown.send(());
        panic!("runtime must reach the real upstream before cancellation");
    }

    handle.abort();
    let join_error = match handle.await {
        Ok(_) => {
            upstream.release.notify_one();
            let _ = shutdown.send(());
            panic!("runtime task must be cancelled while the upstream request is pending");
        }
        Err(error) => error,
    };
    if !join_error.is_cancelled() {
        upstream.release.notify_one();
        let _ = shutdown.send(());
        panic!("runtime task join error was not cancellation: {join_error}");
    }
    tokio::task::yield_now().await;
    let after_cancel = scope_state(&observer);
    upstream.release.notify_one();
    let _ = shutdown.send(());

    assert_eq!(
        after_cancel,
        ScopeState::Released,
        "cancelling the real Runtime future must release its request scope while an observer control clone remains"
    );
}

#[tokio::test]
async fn req02_shared_relay_openai_chat_json_scope_active_until_output_drop_then_released() {
    let (base_url, upstream, shutdown) = start_upstream(UpstreamReply::JsonOk).await;
    upstream.release.notify_one();
    let server_id = "req02_shared_relay_openai_chat_json";
    let request_id = "req02-shared-relay-openai-chat-json";
    let manifest = manifest(server_id, &base_url);
    let control = request_control(&manifest, server_id, request_id);
    let observer = control.clone();
    let initial_state = scope_state(&observer);

    let output = match call_relay_runtime(&manifest, server_id, request_id, false, control).await {
        Ok(output) => output,
        Err(error) => {
            let _ = shutdown.send(());
            panic!("real OpenAI Chat Relay JSON failed before client projection: {error}");
        }
    };
    let status = output.status;
    let after_return = scope_state(&observer);
    let client_body = match &output.client_body {
        V3OpenAiChatRelayClientBody::Json(value) => value.clone(),
        V3OpenAiChatRelayClientBody::Sse(_) => {
            let _ = shutdown.send(());
            panic!("real OpenAI Chat Relay JSON request must return a JSON client body");
        }
    };
    drop(output);
    let after_drop = scope_state(&observer);
    let _ = shutdown.send(());

    assert_eq!(initial_state, ScopeState::Active);
    assert_eq!(status, 200, "{client_body}");
    assert_eq!(upstream.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        client_body.pointer("/choices/0/message/content"),
        Some(&json!("shared relay json ok")),
        "client JSON must preserve the provider text: {client_body}"
    );
    assert_eq!(
        client_body.pointer("/usage/total_tokens"),
        Some(&json!(5)),
        "client JSON must preserve provider usage: {client_body}"
    );
    assert_eq!(
        after_return,
        ScopeState::Active,
        "scope must remain active after the public JSON output returns"
    );
    assert_eq!(
        after_drop,
        ScopeState::Released,
        "dropping the consumed public JSON output must release the scope while an observer control clone remains"
    );
}

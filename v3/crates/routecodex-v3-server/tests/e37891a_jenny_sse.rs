//! e37891a public-entry control for Jenny's held SSE requests.
//!
//! The fixture uses a real aggregate server and controlled loopback upstreams.
//! It records provider sends and keeps request/probe barriers explicit so a
//! successful HTTP status is not enough to satisfy the causal assertions.

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
use routecodex_v3_server::{spawn_v3_server_aggregate, V3ServerAggregateHandle};
use serde_json::{json, Value};
use std::{ffi::OsString, sync::Arc, time::Duration};
use tokio::{
    net::TcpListener,
    sync::{mpsc, Mutex, Semaphore},
    task::JoinHandle,
    time::timeout,
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "support/fa22072_test_home.rs"]
mod test_home;

static TEST_LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();

const AUTH_ENV: &str = "E37891A_JENNY_SSE_KEY";
const AUTH_SECRET: &str = "e37891a-jenny-sse-key";
const KEEPALIVE_ENV: &str = "ROUTECODEX_HTTP_SSE_KEEPALIVE_MS";
const PROBE_MARKER: &str = "ping; reply pong";
const JENNY_SESSION: &str = "jenny-hang-causal";
const BUSINESS_TIMEOUT: Duration = Duration::from_secs(10);

struct TestEnvironment {
    previous_auth: Option<OsString>,
    previous_keepalive: Option<OsString>,
}

impl TestEnvironment {
    fn install() -> Self {
        let previous_auth = std::env::var_os(AUTH_ENV);
        let previous_keepalive = std::env::var_os(KEEPALIVE_ENV);
        std::env::set_var(AUTH_ENV, AUTH_SECRET);
        std::env::set_var(KEEPALIVE_ENV, "50");
        Self {
            previous_auth,
            previous_keepalive,
        }
    }
}

impl Drop for TestEnvironment {
    fn drop(&mut self) {
        restore_env(AUTH_ENV, self.previous_auth.take());
        restore_env(KEEPALIVE_ENV, self.previous_keepalive.take());
    }
}

fn restore_env(name: &str, value: Option<OsString>) {
    match value {
        Some(value) => std::env::set_var(name, value),
        None => std::env::remove_var(name),
    }
}

#[derive(Clone, Debug)]
struct Capture {
    authorization: String,
    model: String,
    input: String,
    stream: bool,
    probe: bool,
    input_value: Value,
}

struct Peer {
    label: &'static str,
    captures: Mutex<Vec<Capture>>,
    probe_entered: Semaphore,
    probe_release: Semaphore,
    r1_entered: Semaphore,
    r1_release: Semaphore,
    r2_entered: Semaphore,
    r2_release: Semaphore,
    target_entered: Semaphore,
}

struct PeerHandle {
    peer: Arc<Peer>,
    base: String,
    task: JoinHandle<()>,
}

impl std::ops::Deref for PeerHandle {
    type Target = Peer;

    fn deref(&self) -> &Self::Target {
        &self.peer
    }
}

#[derive(Clone, Debug)]
enum StreamEvent {
    Headers {
        status: u16,
        content_type: Option<String>,
    },
    Chunk(String),
}

#[derive(Debug)]
struct ClientOutcome {
    status: Option<u16>,
    content_type: Option<String>,
    body: String,
    transport_error: Option<String>,
}

impl ClientOutcome {
    fn text(&self) -> String {
        format!(
            "status={:?} content_type={:?} transport_error={:?} body={}",
            self.status, self.content_type, self.transport_error, self.body
        )
    }
}

fn input_text(body: &Value) -> String {
    body.get("input")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            body.get("input")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|item| item.get("content"))
                .and_then(Value::as_array)
                .and_then(|content| content.first())
                .and_then(|part| part.get("text"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_default()
}

fn sse_frame(kind: &str, data: Value) -> String {
    format!("event: {kind}\ndata: {data}\n\n")
}

fn business_sse(label: &str, model: &str) -> String {
    let text = format!("{label}-business-ok");
    let response_id = format!("resp_{label}");
    let message_id = format!("msg_{label}");
    let message = json!({
        "id": message_id,
        "type": "message",
        "role": "assistant",
        "status": "completed",
        "content": [{
            "type": "output_text",
            "text": text,
            "annotations": []
        }]
    });
    let completed = json!({
        "type": "response.completed",
        "response": {
            "id": response_id,
            "object": "response",
            "status": "completed",
            "model": model,
            "output": [message],
            "output_text": text
        }
    });
    format!(
        "{}{}{}{}",
        sse_frame(
            "response.created",
            json!({
                "type": "response.created",
                "response": {"id": format!("resp_{label}"), "status": "in_progress"}
            })
        ),
        sse_frame(
            "response.metadata",
            json!({
                "type": "response.metadata",
                "response_id": format!("resp_{label}"),
                "metadata": {"fixture": label}
            })
        ),
        sse_frame(
            "response.output_text.delta",
            json!({
                "type": "response.output_text.delta",
                "item_id": format!("msg_{label}"),
                "output_index": 0,
                "content_index": 0,
                "delta": text
            })
        ),
        sse_frame("response.completed", completed)
    )
}

fn provider_sse(label: &str, model: &str) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/event-stream")
        .body(Body::from(business_sse(label, model)))
        .unwrap()
}

fn probe_json(label: &str) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "id": format!("probe_{label}"),
                "object": "response",
                "status": "completed",
                "output_text": "pong"
            })
            .to_string(),
        ))
        .unwrap()
}

async fn peer_handler(
    State(peer): State<Arc<Peer>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    let authorization = headers["authorization"]
        .to_str()
        .expect("fixture authorization header")
        .to_string();
    assert_eq!(authorization, format!("Bearer {AUTH_SECRET}"));
    let model = body["model"]
        .as_str()
        .expect("fixture request model")
        .to_string();
    let input = input_text(&body);
    let stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let probe = input.contains(PROBE_MARKER);
    peer.captures.lock().await.push(Capture {
        authorization,
        model: model.clone(),
        input: input.clone(),
        stream,
        probe,
        input_value: body.get("input").cloned().unwrap_or(Value::Null),
    });

    if probe {
        peer.probe_entered.add_permits(1);
        peer.probe_release.acquire().await.unwrap().forget();
        return probe_json(peer.label);
    }

    if input.contains("r1-holder") {
        peer.r1_entered.add_permits(1);
        peer.r1_release.acquire().await.unwrap().forget();
    } else if input.contains("r2-target") {
        peer.r2_entered.add_permits(1);
        peer.r2_release.acquire().await.unwrap().forget();
    } else if input.contains("target") || input == "healthy-successor" {
        peer.target_entered.add_permits(1);
    }
    provider_sse(peer.label, &model)
}

async fn spawn_peer(label: &'static str) -> PeerHandle {
    let peer = Arc::new(Peer {
        label,
        captures: Mutex::new(Vec::new()),
        probe_entered: Semaphore::new(0),
        probe_release: Semaphore::new(0),
        r1_entered: Semaphore::new(0),
        r1_release: Semaphore::new(0),
        r2_entered: Semaphore::new(0),
        r2_release: Semaphore::new(0),
        target_entered: Semaphore::new(0),
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/v1/responses", post(peer_handler))
        .with_state(peer.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    PeerHandle {
        peer,
        base: format!("http://127.0.0.1:{}/v1", address.port()),
        task,
    }
}

async fn stop_peer(peer: PeerHandle) {
    peer.task.abort();
    let _ = peer.task.await;
}

async fn stop_all(handle: V3ServerAggregateHandle, peers: Vec<PeerHandle>) {
    let _ = handle.shutdown().await;
    for peer in peers {
        stop_peer(peer).await;
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .unwrap()
}

fn direct_provider_block(
    provider_id: &str,
    base: &str,
    wire_model: &str,
    max_in_flight: u32,
) -> String {
    format!(
        r#"
[providers.{provider_id}]
type = "responses"
base_url = "{base}"
default_model = "model"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{AUTH_ENV}" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 60000 }}
concurrency = {{ max_in_flight = {max_in_flight}, acquire_timeout_ms = 6000, stale_lease_ms = 120000 }}
responses = {{ process = "direct", streaming = "always" }}
[providers.{provider_id}.models.model]
wire_name = "{wire_model}"
capabilities = ["text"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
"#
    )
}

fn manifest(
    port: u16,
    providers: &[(&str, &str, &str, u32)],
    route_pools: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let provider_blocks = providers
        .iter()
        .map(|(provider_id, base, wire_model, max_in_flight)| {
            direct_provider_block(provider_id, base, wire_model, *max_in_flight)
        })
        .collect::<String>();
    let source = format!(
        r#"
version = 3
{declaration}
[servers.owned]
bind = "127.0.0.1"
port = {port}
routing_group = "owned"
endpoints = ["responses"]
{execution}
{provider_blocks}
{route_pools}
"#,
        declaration = hub_v1_fixture::hub_v1_test_declaration(),
        execution = hub_v1_fixture::hub_v1_server_execution("owned"),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

async fn send_stream(
    client: &reqwest::Client,
    endpoint: &str,
    session_id: &str,
    input: &str,
    progress: Option<mpsc::UnboundedSender<StreamEvent>>,
) -> ClientOutcome {
    send_stream_body(
        client,
        endpoint,
        session_id,
        json!({
            "model": "client-auto", "input": input, "stream": true
        }),
        progress,
    )
    .await
}

async fn send_stream_body(
    client: &reqwest::Client,
    endpoint: &str,
    session_id: &str,
    body: Value,
    progress: Option<mpsc::UnboundedSender<StreamEvent>>,
) -> ClientOutcome {
    let response = match client
        .post(endpoint)
        .header("accept", "text/event-stream")
        .header("x-session-id", session_id)
        .json(&body)
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return ClientOutcome {
                status: None,
                content_type: None,
                body: String::new(),
                transport_error: Some(error.to_string()),
            };
        }
    };

    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    if let Some(progress) = progress.as_ref() {
        let _ = progress.send(StreamEvent::Headers {
            status,
            content_type: content_type.clone(),
        });
    }

    let mut stream = response.bytes_stream();
    let mut body = String::new();
    let mut transport_error = None;
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes).into_owned();
                body.push_str(&text);
                if let Some(progress) = progress.as_ref() {
                    let _ = progress.send(StreamEvent::Chunk(text));
                }
            }
            Err(error) => {
                transport_error = Some(error.to_string());
                break;
            }
        }
    }

    ClientOutcome {
        status: Some(status),
        content_type,
        body,
        transport_error,
    }
}

async fn wait_for_semaphore(semaphore: &Semaphore, wait: Duration) -> bool {
    if let Ok(Ok(permit)) = timeout(wait, semaphore.acquire()).await {
        permit.forget();
        true
    } else {
        false
    }
}

async fn seed_exact_probe(client: &reqwest::Client, base: &str, provider_id: &str) {
    let added = client
        .post(format!("{base}/_routecodex/health/cooldown-pool/add"))
        .json(&json!({
            "provider_id": provider_id,
            "interface_id": "default",
            "auth_alias": "key",
            "model_id": "model",
            "kind": "probe",
            "duration_ms": 60000
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(added.status(), StatusCode::OK);
    let scheduled = client
        .post(format!("{base}/_routecodex/health/cooldown-pool/probe"))
        .json(&json!({
            "provider_id": provider_id,
            "interface_id": "default",
            "auth_alias": "key",
            "model_id": "model"
        }))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    assert_eq!(
        scheduled["scheduled"], true,
        "fixture identity must have a due exact probe: {scheduled}"
    );
}

fn sse_payloads(body: &str) -> Vec<Value> {
    body.lines()
        .filter_map(|line| line.strip_prefix("data:").map(str::trim))
        .filter(|line| !line.is_empty() && *line != "[DONE]")
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

fn assert_business_sse(outcome: &ClientOutcome, expected_text: &str) {
    assert!(outcome.transport_error.is_none(), "{}", outcome.text());
    assert_eq!(outcome.status, Some(200), "{}", outcome.text());
    assert!(
        outcome
            .content_type
            .as_deref()
            .is_some_and(|value| value.starts_with("text/event-stream")),
        "{}",
        outcome.text()
    );
    assert!(!outcome.body.contains("event: error"), "{}", outcome.text());
    let payloads = sse_payloads(&outcome.body);
    assert!(
        payloads
            .iter()
            .any(|payload| payload["type"] == "response.metadata"),
        "client SSE must preserve response.metadata: {}",
        outcome.text()
    );
    assert!(
        payloads
            .iter()
            .any(|payload| payload["type"] == "response.output_text.delta"),
        "client SSE must carry a visible business delta: {}",
        outcome.text()
    );
    assert!(
        outcome.body.contains(expected_text),
        "client SSE must carry the expected business text: {}",
        outcome.text()
    );
    let completed = payloads
        .iter()
        .filter(|payload| payload["type"] == "response.completed")
        .count();
    assert_eq!(
        completed,
        1,
        "client SSE must close with one completion: {}",
        outcome.text()
    );
}

fn assert_no_client_error_or_empty_success(outcome: &ClientOutcome) {
    assert!(
        outcome.transport_error.is_some(),
        "exhaustion must end transport detectably: {}",
        outcome.text()
    );
    let body = &outcome.body;
    assert!(
        !body.contains("event: error"),
        "client SSE must not carry an error event: {}",
        outcome.text()
    );
    assert!(
        !body.contains("\"error\"")
            && !body.contains("\"message\"")
            && !body.contains("503")
            && !body.contains("418"),
        "provider failure text must stay internal: {}",
        outcome.text()
    );
    assert!(
        !body.contains("response.completed"),
        "exhaustion must not fabricate empty success: {}",
        outcome.text()
    );
    assert!(
        outcome.status.map(|status| status < 400).unwrap_or(true),
        "client must not receive a provider HTTP error status: {}",
        outcome.text()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn healthy_stream_returns_metadata_and_completion() {
    let (_home, _lock) = TEST_LOCK.lock().await;
    let _environment = TestEnvironment::install();
    let peer = spawn_peer("healthy").await;
    let handle = spawn_v3_server_aggregate(manifest(
        free_port(),
        &[("healthy", peer.base.as_str(), "wire-healthy", 1)],
        r#"
[route_groups.owned.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "healthy", model = "model", key = "key", priority = 1 }]
"#,
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let outcome = send_stream(
        &client(),
        &endpoint,
        JENNY_SESSION,
        "healthy-baseline",
        None,
    )
    .await;
    let captures = peer.captures.lock().await.clone();
    stop_all(handle, vec![peer]).await;

    assert_business_sse(&outcome, "healthy-business-ok");
    assert_eq!(captures.len(), 1, "{captures:?}");
    assert!(captures[0].stream, "{captures:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn same_session_stream_progresses_while_r1_is_held() {
    let (_home, _lock) = TEST_LOCK.lock().await;
    let _environment = TestEnvironment::install();
    let peer = spawn_peer("session").await;
    let handle = spawn_v3_server_aggregate(manifest(
        free_port(),
        &[("session", peer.base.as_str(), "wire-session", 1)],
        r#"
[route_groups.owned.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "session", model = "model", key = "key", priority = 1 }]
"#,
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = client();
    let (progress_tx, mut progress_rx) = mpsc::unbounded_channel();

    let mut r1_task = tokio::spawn({
        let client = client.clone();
        let endpoint = endpoint.clone();
        async move {
            send_stream(
                &client,
                &endpoint,
                JENNY_SESSION,
                "r1-holder",
                Some(progress_tx),
            )
            .await
        }
    });
    let headers = timeout(Duration::from_secs(3), progress_rx.recv())
        .await
        .expect("R1 SSE headers must arrive while upstream is held")
        .expect("R1 progress channel must stay open");
    let first_chunk = timeout(Duration::from_secs(3), progress_rx.recv())
        .await
        .expect("R1 must emit keepalive before upstream business")
        .expect("R1 progress channel must stay open");
    let r1_probe_sent = wait_for_semaphore(&peer.r1_entered, Duration::from_secs(3)).await;

    let mut r2_task = tokio::spawn({
        let client = client.clone();
        let endpoint = endpoint.clone();
        async move { send_stream(&client, &endpoint, JENNY_SESSION, "r2-target", None).await }
    });
    let r2_reached_before_r1_release =
        wait_for_semaphore(&peer.r2_entered, Duration::from_secs(2)).await;
    if r2_reached_before_r1_release {
        peer.r2_release.add_permits(1);
    }
    let r2_outcome = if r2_reached_before_r1_release {
        timeout(BUSINESS_TIMEOUT, &mut r2_task)
            .await
            .ok()
            .and_then(Result::ok)
    } else {
        None
    };

    r1_task.abort();
    let _ = r1_task.await;
    peer.r1_release.add_permits(1);
    peer.r2_release.add_permits(1);
    let r3_outcome = timeout(
        BUSINESS_TIMEOUT,
        send_stream(&client, &endpoint, JENNY_SESSION, "r3-after-cancel", None),
    )
    .await
    .ok();
    let captures = peer.captures.lock().await.clone();
    stop_all(handle, vec![peer]).await;

    match headers {
        StreamEvent::Headers {
            status: 200,
            content_type: Some(content_type),
        } if content_type.starts_with("text/event-stream") => {}
        other => panic!("R1 must establish a 200 SSE transport: {other:?}"),
    }
    match first_chunk {
        StreamEvent::Chunk(body) => assert!(
            body.contains(": keepalive"),
            "R1 must expose keepalive while the provider is held: {body:?}"
        ),
        other => panic!("R1 must emit an SSE keepalive chunk: {other:?}"),
    }
    assert!(
        r1_probe_sent,
        "the first request must actually reach the controlled provider: {captures:?}"
    );
    assert!(
        r2_reached_before_r1_release,
        "same-session R2 must reach the provider before R1 releases: {captures:?}"
    );
    let r2_outcome = r2_outcome.expect("R2 must complete before R1 releases");
    assert_business_sse(&r2_outcome, "session-business-ok");
    let r3_outcome = r3_outcome.expect("R3 must complete after R1 cancellation");
    assert_business_sse(&r3_outcome, "session-business-ok");
    let r1_count = captures
        .iter()
        .filter(|capture| capture.input.contains("r1-holder"))
        .count();
    let r2_count = captures
        .iter()
        .filter(|capture| capture.input.contains("r2-target"))
        .count();
    let r3_count = captures
        .iter()
        .filter(|capture| capture.input.contains("r3-after-cancel"))
        .count();
    assert_eq!(r1_count, 1, "{captures:?}");
    assert_eq!(r2_count, 1, "{captures:?}");
    assert_eq!(r3_count, 1, "{captures:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn held_probe_stream_reaches_healthy_declared_successor() {
    let (_home, _lock) = TEST_LOCK.lock().await;
    let _environment = TestEnvironment::install();
    let leading = spawn_peer("leading").await;
    let healthy = spawn_peer("healthy").await;
    let handle = spawn_v3_server_aggregate(manifest(
        free_port(),
        &[
            ("leading", leading.base.as_str(), "wire-leading", 1),
            ("healthy", healthy.base.as_str(), "wire-healthy", 1),
        ],
        r#"
[route_groups.owned.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "leading", model = "model", key = "key", priority = 2 },
  { kind = "provider_model", provider = "healthy", model = "model", key = "key", priority = 1 }
]
"#,
    ))
    .await
    .unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let endpoint = format!("{base}/v1/responses");
    let client = client();

    seed_exact_probe(&client, &base, "leading").await;
    let probe_held = wait_for_semaphore(&leading.probe_entered, Duration::from_secs(5)).await;
    let mut target = tokio::spawn({
        let client = client.clone();
        let endpoint = endpoint.clone();
        async move { send_stream(&client, &endpoint, JENNY_SESSION, "healthy-successor", None).await }
    });
    let healthy_reached_before_release =
        wait_for_semaphore(&healthy.target_entered, Duration::from_secs(3)).await;
    let target_outcome = if healthy_reached_before_release {
        timeout(BUSINESS_TIMEOUT, &mut target)
            .await
            .ok()
            .and_then(Result::ok)
    } else {
        None
    };
    leading.probe_release.add_permits(1);
    if !healthy_reached_before_release {
        target.abort();
        let _ = target.await;
    }
    let leading_captures = leading.captures.lock().await.clone();
    let healthy_captures = healthy.captures.lock().await.clone();
    stop_all(handle, vec![leading, healthy]).await;

    assert!(
        probe_held,
        "the leading exact identity probe must be held: {leading_captures:?}"
    );
    assert!(
        healthy_reached_before_release,
        "the declared healthy successor must receive the request while the leading probe is held: {leading_captures:?} {healthy_captures:?}"
    );
    assert!(
        leading_captures
            .iter()
            .any(|capture| capture.probe && capture.input.contains(PROBE_MARKER)),
        "the leading identity must receive its exact probe: {leading_captures:?}"
    );
    assert!(
        !leading_captures
            .iter()
            .any(|capture| capture.input.contains("healthy-successor")),
        "the held leading identity must not receive the business request: {leading_captures:?}"
    );
    assert!(
        healthy_captures
            .iter()
            .any(|capture| { capture.input.contains("healthy-successor") && capture.stream }),
        "the healthy successor must receive the explicit stream request: {healthy_captures:?}"
    );
    let target_outcome =
        target_outcome.expect("the healthy successor must complete before probe release");
    assert_business_sse(&target_outcome, "healthy-business-ok");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn all_unavailable_held_probe_release_characterization() {
    let (_home, _lock) = TEST_LOCK.lock().await;
    let _environment = TestEnvironment::install();
    let alpha = spawn_peer("alpha").await;
    let beta = spawn_peer("beta").await;
    let handle = spawn_v3_server_aggregate(manifest(
        free_port(),
        &[
            ("alpha", alpha.base.as_str(), "wire-alpha", 1),
            ("beta", beta.base.as_str(), "wire-beta", 1),
        ],
        r#"
[route_groups.owned.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "alpha", model = "model", key = "key", priority = 2 },
  { kind = "provider_model", provider = "beta", model = "model", key = "key", priority = 1 }
]
"#,
    ))
    .await
    .unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let endpoint = format!("{base}/v1/responses");
    let client = client();

    seed_exact_probe(&client, &base, "alpha").await;
    seed_exact_probe(&client, &base, "beta").await;
    let alpha_probe_held = wait_for_semaphore(&alpha.probe_entered, Duration::from_secs(5)).await;
    let beta_probe_held = wait_for_semaphore(&beta.probe_entered, Duration::from_secs(5)).await;

    let mut request = tokio::spawn({
        let client = client.clone();
        let endpoint = endpoint.clone();
        async move { send_stream(&client, &endpoint, JENNY_SESSION, "all-unavailable", None).await }
    });
    let before_release = timeout(Duration::from_millis(700), &mut request).await;
    let pending_before_release = before_release.is_err();
    let mut outcome_before_release = match before_release {
        Ok(Ok(outcome)) => Some(outcome),
        Ok(Err(error)) => panic!("request task failed before probe release: {error}"),
        Err(_) => None,
    };

    alpha.probe_release.add_permits(1);
    beta.probe_release.add_permits(1);
    if pending_before_release {
        outcome_before_release = Some(
            timeout(BUSINESS_TIMEOUT, &mut request)
                .await
                .expect("releasing the held exact probes must unblock the main recovery wait")
                .expect("request task must join after probe release"),
        );
    }

    let followup = timeout(
        BUSINESS_TIMEOUT,
        send_stream(
            &client,
            &endpoint,
            JENNY_SESSION,
            "all-unavailable-after-release",
            None,
        ),
    )
    .await
    .expect("a new request after probe release must complete");
    let alpha_captures = alpha.captures.lock().await.clone();
    let beta_captures = beta.captures.lock().await.clone();
    stop_all(handle, vec![alpha, beta]).await;

    assert!(alpha_probe_held, "{alpha_captures:?}");
    assert!(beta_probe_held, "{beta_captures:?}");
    assert!(
        alpha_captures
            .iter()
            .any(|capture| capture.probe && capture.input.contains(PROBE_MARKER)),
        "{alpha_captures:?}"
    );
    assert!(
        beta_captures
            .iter()
            .any(|capture| capture.probe && capture.input.contains(PROBE_MARKER)),
        "{beta_captures:?}"
    );
    eprintln!(
        "e37891a characterization pending_before_release={pending_before_release} \
         alpha_captures={alpha_captures:?} beta_captures={beta_captures:?}"
    );
    if pending_before_release {
        assert_business_sse(
            outcome_before_release
                .as_ref()
                .expect("pending request outcome after release"),
            "alpha-business-ok",
        );
    } else if let Some(outcome) = outcome_before_release.as_ref() {
        assert_no_client_error_or_empty_success(outcome);
    }
    assert_business_sse(&followup, "alpha-business-ok");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn all_unavailable_held_probe_ends_without_waiting() {
    let (_home, _lock) = TEST_LOCK.lock().await;
    let _environment = TestEnvironment::install();
    let alpha = spawn_peer("alpha").await;
    let beta = spawn_peer("beta").await;
    let handle = spawn_v3_server_aggregate(manifest(
        free_port(),
        &[
            ("alpha", alpha.base.as_str(), "wire-alpha", 1),
            ("beta", beta.base.as_str(), "wire-beta", 1),
        ],
        r#"
[route_groups.owned.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "alpha", model = "model", key = "key", priority = 2 },
  { kind = "provider_model", provider = "beta", model = "model", key = "key", priority = 1 }
]
"#,
    ))
    .await
    .unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let endpoint = format!("{base}/v1/responses");
    let client = client();

    seed_exact_probe(&client, &base, "alpha").await;
    seed_exact_probe(&client, &base, "beta").await;
    let alpha_probe_held = wait_for_semaphore(&alpha.probe_entered, Duration::from_secs(5)).await;
    let beta_probe_held = wait_for_semaphore(&beta.probe_entered, Duration::from_secs(5)).await;

    let mut request = tokio::spawn({
        let client = client.clone();
        let endpoint = endpoint.clone();
        async move {
            send_stream(
                &client,
                &endpoint,
                JENNY_SESSION,
                "all-unavailable-contract",
                None,
            )
            .await
        }
    });
    let outcome = timeout(Duration::from_secs(2), &mut request).await;
    if outcome.is_err() {
        request.abort();
        let _ = request.await;
    }
    alpha.probe_release.add_permits(1);
    beta.probe_release.add_permits(1);
    let captures = (
        alpha.captures.lock().await.clone(),
        beta.captures.lock().await.clone(),
    );
    stop_all(handle, vec![alpha, beta]).await;

    assert!(alpha_probe_held, "{:?}", captures.0);
    assert!(beta_probe_held, "{:?}", captures.1);
    assert!(
        captures.0.iter().any(|capture| capture.probe),
        "{:?}",
        captures.0
    );
    assert!(
        captures.1.iter().any(|capture| capture.probe),
        "{:?}",
        captures.1
    );
    let outcome = outcome.unwrap_or_else(|_| {
        panic!(
            "desired contract failed: all-unavailable request stayed open while held exact probes remained unreleased"
        )
    });
    let outcome = outcome.expect("request task must join after the contract result");
    assert_no_client_error_or_empty_success(&outcome);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn capability_labels_choose_pool_without_filtering_provider() {
    let (_home, _lock) = TEST_LOCK.lock().await;
    let _environment = TestEnvironment::install();
    let search = spawn_peer("search").await;
    let fallback = spawn_peer("fallback").await;
    let mut compiled = manifest(
        free_port(),
        &[
            ("search", search.base.as_str(), "wire-search", 1),
            ("fallback", fallback.base.as_str(), "wire-fallback", 1),
        ],
        r#"
[route_groups.owned.pools.multimodal]
match = { precedence = 1, required_capabilities = ["multimodal"] }
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "search", model = "model", key = "key", priority = 2 },
  { kind = "provider_model", provider = "fallback", model = "model", key = "key", priority = 1 }
]
[route_groups.owned.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "fallback", model = "model", key = "key", priority = 1 }]
"#,
    );
    compiled
        .providers
        .get_mut("fallback")
        .unwrap()
        .models
        .get_mut("model")
        .unwrap()
        .capabilities
        .push("vision".into());
    let handle = spawn_v3_server_aggregate(compiled).await.unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let input = json!([{"role":"user", "content":[
        {"type":"input_text", "text":"capability-target"},
        {"type":"input_image", "image_url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="}
    ]}]);
    let outcome = timeout(
        Duration::from_secs(3),
        send_stream_body(
            &client(),
            &endpoint,
            JENNY_SESSION,
            json!({"model":"client-auto", "input":input, "stream":true}),
            None,
        ),
    )
    .await;
    let captures = search.captures.lock().await.clone();
    let fallback_captures = fallback.captures.lock().await.clone();
    stop_all(handle, vec![search, fallback]).await;
    assert_eq!(captures.len(), 1, "selected multimodal pool must send to its declared text provider; fallback={fallback_captures:?}");
    assert!(
        fallback_captures.is_empty(),
        "capability must select multimodal pool: {fallback_captures:?}"
    );
    assert_eq!(
        captures[0].input_value, input,
        "image request must reach provider unchanged"
    );
    assert_business_sse(
        &outcome.expect("capability labels must not create exhaustion waiting"),
        "search-business-ok",
    );
}

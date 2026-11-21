//! e37891a public-entry red regressions for request admission.
//!
//! These cases use a real aggregate server and real HTTP upstream fixtures.
//! Controlled upstreams inspect the actual request identity and hold probes or
//! business requests with semaphores, so final client status alone cannot
//! satisfy the assertions.

use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::post,
    Json, Router,
};
use futures_util::{stream, StreamExt};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::{spawn_v3_server_aggregate, V3ServerAggregateHandle};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    convert::Infallible,
    ffi::OsString,
    ops::Deref,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Mutex, Semaphore},
    task::JoinHandle,
    time::{sleep, timeout, Duration},
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
#[path = "support/fa22072_test_home.rs"]
mod test_home;

static TEST_LOCK: test_home::ServerTestLock = test_home::ServerTestLock::new();

const AUTH_ENV: &str = "E37891A_ADMISSION_KEY";
const AUTH_SECRET: &str = "e37891a-owned-key";
const SECOND_AUTH_ENV: &str = "E37891A_SECOND_KEY";
const SECOND_AUTH_SECRET: &str = "e37891a-second-key";
const PROBE_MARKER: &str = "ping; reply pong";
const CLIENT_TIMEOUT: Duration = Duration::from_secs(15);
const DECLARED_RETRY_BACKOFF_MS: u64 = 2_000;
const IMMEDIATE_SWITCH_BOUND: Duration = Duration::from_secs(1);
const RECOVERY_HOLD_RESIDENCE_MS: u64 = 5_000;
const RECOVERY_DEADLINE_RESIDENCE_MS: u64 = 1_000;
const RECOVERY_DEADLINE_FIRST_FAILURE_DELAY_MS: u64 = 600;
const RECOVERY_SUCCESSOR_IDLE_TIMEOUT_MS: u64 = 850;
const SSE_KEEPALIVE_ENV: &str = "ROUTECODEX_HTTP_SSE_KEEPALIVE_MS";

struct EnvironmentValueGuard {
    key: &'static str,
    previous: Option<OsString>,
}

impl EnvironmentValueGuard {
    fn set(key: &'static str, value: &str) -> Self {
        let previous = std::env::var_os(key);
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvironmentValueGuard {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(value) => std::env::set_var(self.key, value),
            None => std::env::remove_var(self.key),
        }
    }
}

#[derive(Clone, Debug)]
struct Capture {
    authorization: String,
    model: String,
    input: String,
    probe: bool,
}

struct Peer {
    label: &'static str,
    captures: Mutex<Vec<Capture>>,
    business_attempt_order: Arc<Mutex<Vec<String>>>,
    rejected_keys: Mutex<BTreeMap<String, u16>>,
    rejected_inputs: Mutex<BTreeMap<String, u16>>,
    blocked_inputs: Mutex<BTreeSet<String>>,
    reject_blocked: AtomicBool,
    reject_entered: Semaphore,
    reject_release: Semaphore,
    probe_entered: Semaphore,
    probe_release: Semaphore,
    holder_entered: Semaphore,
    holder_release: Semaphore,
    target_entered: Semaphore,
}

struct PeerHandle {
    peer: Arc<Peer>,
    base: String,
    task: JoinHandle<()>,
}

impl Deref for PeerHandle {
    type Target = Peer;

    fn deref(&self) -> &Self::Target {
        &self.peer
    }
}

#[derive(Debug)]
enum ClientOutcome {
    Completed(Value),
    Http { status: u16, body: String },
    TransportError(String),
}

impl ClientOutcome {
    fn text(&self) -> String {
        match self {
            Self::Completed(value) => value.to_string(),
            Self::Http { status, body } => format!("status={status} body={body}"),
            Self::TransportError(error) => format!("transport_error={error}"),
        }
    }

    fn contains(&self, needle: &str) -> bool {
        self.text().contains(needle)
    }
}

fn evidence_body_text(evidence: &Value) -> String {
    evidence["body"]
        .as_array()
        .map(|bytes| {
            bytes
                .iter()
                .filter_map(|byte| byte.as_u64().and_then(|byte| u8::try_from(byte).ok()))
                .collect::<Vec<u8>>()
        })
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default()
}

fn assert_final_http_error(outcome: &ClientOutcome, evidence: &Value, expected_status: u16) {
    let ClientOutcome::Http { status, body } = outcome else {
        panic!("the final provider HTTP error must reach the client: {outcome:?}");
    };
    assert_eq!(*status, expected_status);
    assert_eq!(evidence["kind"], "external_http");
    assert_eq!(evidence["status"], expected_status);
    assert_eq!(*body, evidence_body_text(evidence));
    assert_eq!(
        serde_json::from_str::<Value>(body).unwrap(),
        json!({"error":{"message":"owned-real-key-failure","http_status":expected_status}})
    );
}

fn completed_response(label: &str, model: &str) -> Response<Body> {
    let text = format!("{label}-business-ok");
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "id": format!("resp_e37891a_{label}"),
                "object": "response",
                "status": "completed",
                "model": model,
                "output": [{
                    "id": format!("msg_e37891a_{label}"),
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                    "content": [{
                        "type": "output_text",
                        "text": text,
                        "annotations": []
                    }]
                }],
                "output_text": text
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
    assert!(
        authorization == format!("Bearer {AUTH_SECRET}")
            || authorization == format!("Bearer {SECOND_AUTH_SECRET}")
    );
    let model = body["model"]
        .as_str()
        .expect("fixture request model")
        .to_string();
    let input = body["input"]
        .as_str()
        .or_else(|| body["input"][0]["content"][0]["text"].as_str())
        .unwrap_or_default()
        .to_string();
    let probe = input.contains(PROBE_MARKER);
    peer.captures.lock().await.push(Capture {
        authorization: authorization.clone(),
        model: model.clone(),
        input: input.clone(),
        probe,
    });

    let rejected_by_input = peer.rejected_inputs.lock().await.get(&input).copied();
    let rejected_by_key = if rejected_by_input.is_some() {
        None
    } else {
        peer.rejected_keys.lock().await.get(&authorization).copied()
    };
    let rejected_status = rejected_by_input.or(rejected_by_key);
    if let Some(status) = rejected_status {
        peer.business_attempt_order
            .lock()
            .await
            .push(format!("{}:entered", peer.label));
        let blocked_inputs = peer.blocked_inputs.lock().await;
        if peer.reject_blocked.load(Ordering::SeqCst)
            && (blocked_inputs.is_empty() || blocked_inputs.contains(&input))
        {
            peer.reject_entered.add_permits(1);
            peer.reject_release.acquire().await.unwrap().forget();
        }
        drop(blocked_inputs);
        peer.business_attempt_order
            .lock()
            .await
            .push(format!("{}:{status}", peer.label));
        return Response::builder()
            .status(status)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"error":{"message":"owned-real-key-failure","http_status":status}})
                    .to_string(),
            ))
            .unwrap();
    }

    if probe {
        peer.probe_entered.add_permits(1);
        peer.probe_release.acquire().await.unwrap().forget();
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({
                    "id": format!("probe_e37891a_{}", peer.label),
                    "object": "response",
                    "status": "completed",
                    "output_text": "pong"
                })
                .to_string(),
            ))
            .unwrap();
    }

    if input == "holder" {
        peer.holder_entered.add_permits(1);
        peer.holder_release.acquire().await.unwrap().forget();
    } else if input == "stream-holder" {
        peer.holder_entered.add_permits(1);
        peer.business_attempt_order.lock().await.push(format!(
            "{}:{}",
            peer.label,
            StatusCode::OK.as_u16()
        ));
        let reasoning = json!({
            "type": "response.reasoning_summary_text.delta",
            "delta": "recovered-deadline-reasoning",
            "item_id": "rs_e37891a_recovered_deadline",
            "output_index": 0,
            "summary_index": 0,
            "sequence_number": 1
        });
        let frame = format!("event: response.reasoning_summary_text.delta\ndata: {reasoning}\n\n");
        let stream =
            stream::once(async move { Ok::<_, Infallible>(frame) }).chain(stream::pending());
        return Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "text/event-stream")
            .body(Body::from_stream(stream))
            .unwrap();
    } else if input == "target" {
        peer.target_entered.add_permits(1);
    }
    if input == "target" {
        peer.business_attempt_order.lock().await.push(format!(
            "{}:{}",
            peer.label,
            StatusCode::OK.as_u16()
        ));
    }
    completed_response(peer.label, &model)
}

async fn spawn_peer(label: &'static str) -> PeerHandle {
    spawn_peer_with_order(label, Arc::new(Mutex::new(Vec::new()))).await
}

async fn spawn_peer_with_order(
    label: &'static str,
    business_attempt_order: Arc<Mutex<Vec<String>>>,
) -> PeerHandle {
    let peer = Arc::new(Peer {
        label,
        captures: Mutex::new(Vec::new()),
        business_attempt_order,
        rejected_keys: Mutex::new(BTreeMap::new()),
        rejected_inputs: Mutex::new(BTreeMap::new()),
        blocked_inputs: Mutex::new(BTreeSet::new()),
        reject_blocked: AtomicBool::new(false),
        reject_entered: Semaphore::new(0),
        reject_release: Semaphore::new(0),
        probe_entered: Semaphore::new(0),
        probe_release: Semaphore::new(0),
        holder_entered: Semaphore::new(0),
        holder_release: Semaphore::new(0),
        target_entered: Semaphore::new(0),
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/v1/responses", post(peer_handler))
        .with_state(peer.clone());
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    PeerHandle {
        peer,
        base: format!("http://{address}/v1"),
        task,
    }
}

async fn stop_peer(peer: PeerHandle) {
    peer.task.abort();
    let _ = peer.task.await;
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
        .timeout(CLIENT_TIMEOUT)
        .build()
        .unwrap()
}

fn provider_block(provider_id: &str, base: &str, wire_model: &str) -> String {
    format!(
        r#"
[providers.{provider_id}]
type = "responses"
base_url = "{base}"
default_model = "model"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{AUTH_ENV}" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 60000 }}
concurrency = {{ max_in_flight = 1, acquire_timeout_ms = 6000, stale_lease_ms = 120000 }}
responses = {{ process = "chat", streaming = "always" }}
[providers.{provider_id}.models.model]
wire_name = "{wire_model}"
capabilities = ["text"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
"#
    )
}

fn provider_block_with_two_keys(provider_id: &str, base: &str, wire_model: &str) -> String {
    format!(
        r#"
[providers.{provider_id}]
type = "responses"
base_url = "{base}"
default_model = "model"
auth = {{ type = "api_key", entries = [
  {{ alias = "key1", env = "{AUTH_ENV}" }},
  {{ alias = "key2", env = "{SECOND_AUTH_ENV}" }}
] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 60000 }}
concurrency = {{ max_in_flight = 1, acquire_timeout_ms = 6000, stale_lease_ms = 120000 }}
responses = {{ process = "chat", streaming = "always" }}
[providers.{provider_id}.models.model]
wire_name = "{wire_model}"
capabilities = ["text"]
supports_streaming = true
max_tokens = 4096
max_context_tokens = 128000
"#
    )
}

fn direct_provider_block(provider_id: &str, base: &str, wire_model: &str) -> String {
    format!(
        r#"
[providers.{provider_id}]
type = "responses"
base_url = "{base}"
default_model = "model"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{AUTH_ENV}" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 60000 }}
concurrency = {{ max_in_flight = 1, acquire_timeout_ms = 6000, stale_lease_ms = 120000 }}
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
    providers: &[(&str, &str, &str)],
    route_pools: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let provider_blocks = providers
        .iter()
        .map(|(provider_id, base, wire_model)| provider_block(provider_id, base, wire_model))
        .collect::<String>();
    manifest_with_provider_blocks(port, &provider_blocks, route_pools)
}

fn manifest_with_provider_blocks(
    port: u16,
    provider_blocks: &str,
    route_pools: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    manifest_with_declaration(
        port,
        &hub_v1_fixture::hub_v1_test_declaration(),
        provider_blocks,
        route_pools,
    )
}

fn test_declaration(relay: bool) -> String {
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    if relay {
        let direct_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
        let relay_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;
        declaration.replace(direct_binding, relay_binding)
    } else {
        declaration
    }
}

fn manifest_with_declaration(
    port: u16,
    declaration: &str,
    provider_blocks: &str,
    route_pools: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    manifest_with_execution(port, declaration, provider_blocks, route_pools, "")
}

fn manifest_with_execution(
    port: u16,
    declaration: &str,
    provider_blocks: &str,
    route_pools: &str,
    execution_settings: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
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
{execution_settings}
{provider_blocks}
{route_pools}
"#,
        execution = hub_v1_fixture::hub_v1_server_execution("owned"),
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

async fn send_request(client: &reqwest::Client, endpoint: &str, input: &str) -> ClientOutcome {
    match client
        .post(endpoint)
        .json(&json!({
            "model": "client-auto",
            "input": input,
            "stream": false
        }))
        .send()
        .await
    {
        Ok(response) => {
            let status = response.status().as_u16();
            if !response.status().is_success() {
                return ClientOutcome::Http {
                    status,
                    body: response.text().await.unwrap_or_default(),
                };
            }
            match response.json::<Value>().await {
                Ok(value) => ClientOutcome::Completed(value),
                Err(error) => ClientOutcome::Http {
                    status,
                    body: format!("non-json response: {error}"),
                },
            }
        }
        Err(error) => ClientOutcome::TransportError(error.to_string()),
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

async fn run_issue0afb440_immediate_switch(relay: bool) {
    let (_home, _guard) = TEST_LOCK.lock().await;
    std::env::set_var(AUTH_ENV, AUTH_SECRET);
    let attempt_order = Arc::new(Mutex::new(Vec::new()));
    let failing = spawn_peer_with_order("immediate-fail", attempt_order.clone()).await;
    let healthy = spawn_peer_with_order("immediate-healthy", attempt_order.clone()).await;
    failing
        .rejected_inputs
        .lock()
        .await
        .insert("target".to_string(), 503);
    let providers = [
        ("immediatefail", failing.base.as_str(), "wire-immediatefail"),
        (
            "immediatehealthy",
            healthy.base.as_str(),
            "wire-immediatehealthy",
        ),
    ];
    let provider_blocks = providers
        .iter()
        .map(|(provider_id, base, wire_model)| {
            if relay {
                provider_block(provider_id, base, wire_model)
            } else {
                direct_provider_block(provider_id, base, wire_model)
            }
        })
        .collect::<String>();
    let route_pools = r#"
[route_groups.owned.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "immediatefail", model = "model", key = "key", priority = 2 },
  { kind = "provider_model", provider = "immediatehealthy", model = "model", key = "key", priority = 1 }
]

[[error.provider_error_action_policy]]
policy_id = "issue0afb440_immediate_switch"
scope = { provider_id = "immediatefail" }
match = { http_status = 503 }
path = [
  { step = "wait_retry", retry_mode = "reselect_before_client_projection", max_attempts = 1, backoff_ms = 2000 },
  { step = "project", reason_code = "provider_failure" }
]
"#;
    let handle = spawn_v3_server_aggregate(manifest_with_declaration(
        free_port(),
        &test_declaration(relay),
        &provider_blocks,
        route_pools,
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let started = std::time::Instant::now();
    let outcome = timeout(
        IMMEDIATE_SWITCH_BOUND,
        send_request(&client(), &endpoint, "target"),
    )
    .await;
    let elapsed = started.elapsed();
    let failing_captures = failing.captures.lock().await.clone();
    let healthy_captures = healthy.captures.lock().await.clone();
    let order = attempt_order.lock().await.clone();
    handle.shutdown().await;
    stop_peer(failing).await;
    stop_peer(healthy).await;
    std::env::remove_var(AUTH_ENV);

    let outcome = outcome.unwrap_or_else(|_| {
        panic!(
            "{} must switch after the real 503 without waiting for the declared {DECLARED_RETRY_BACKOFF_MS}ms retry; elapsed={elapsed:?}",
            if relay { "Relay" } else { "Direct" }
        )
    });
    assert_eq!(
        failing_captures
            .iter()
            .filter(|capture| capture.input == "target" && !capture.probe)
            .count(),
        1,
        "the failed identity must receive exactly one business attempt: {failing_captures:?}"
    );
    assert_eq!(
        healthy_captures
            .iter()
            .filter(|capture| {
                capture.input == "target"
                    && capture.model == "wire-immediatehealthy"
                    && capture.authorization == format!("Bearer {AUTH_SECRET}")
            })
            .count(),
        1,
        "the declared successor must receive the request: {healthy_captures:?}"
    );
    assert_eq!(
        order,
        [
            "immediate-fail:entered",
            "immediate-fail:503",
            "immediate-healthy:200",
        ],
        "the failed provider response must be observed before the successor attempt"
    );
    let ClientOutcome::Completed(value) = outcome else {
        panic!("the successor business response must reach the client: {outcome:?}");
    };
    assert!(
        value.to_string().contains("immediate-healthy-business-ok"),
        "the successor business response must reach the client: {value}"
    );
    assert!(
        !value.to_string().contains("owned-real-key-failure"),
        "provider error content must stay internal: {value}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue0afb440_non_last_failure_switches_immediately_direct() {
    run_issue0afb440_immediate_switch(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue0afb440_non_last_failure_switches_immediately_relay() {
    run_issue0afb440_immediate_switch(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue0afb440_healthy_sibling_completes_while_first_request_recovers() {
    let (_home, _guard) = TEST_LOCK.lock().await;
    std::env::set_var(AUTH_ENV, AUTH_SECRET);
    let attempt_order = Arc::new(Mutex::new(Vec::new()));
    let failing = spawn_peer_with_order("sibling-recovery-fail", attempt_order.clone()).await;
    let healthy = spawn_peer_with_order("sibling-recovery-healthy", attempt_order.clone()).await;
    failing
        .rejected_inputs
        .lock()
        .await
        .insert("target".to_string(), 503);
    failing
        .blocked_inputs
        .lock()
        .await
        .insert("target".to_string());
    let providers = [
        (
            "siblingrecoveryfail",
            failing.base.as_str(),
            "wire-siblingrecoveryfail",
        ),
        (
            "siblingrecoveryhealthy",
            healthy.base.as_str(),
            "wire-siblingrecoveryhealthy",
        ),
    ];
    let provider_blocks = providers
        .iter()
        .map(|(provider_id, base, wire_model)| provider_block(provider_id, base, wire_model))
        .collect::<String>();
    let route_pools = r#"
[route_groups.owned.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "siblingrecoveryfail", model = "model", key = "key", priority = 2 },
  { kind = "provider_model", provider = "siblingrecoveryhealthy", model = "model", key = "key", priority = 1 }
]
"#;
    let handle = spawn_v3_server_aggregate(manifest_with_provider_blocks(
        free_port(),
        &provider_blocks,
        route_pools,
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    failing.reject_blocked.store(true, Ordering::SeqCst);
    let mut recovering = tokio::spawn({
        let client = client();
        let endpoint = endpoint.clone();
        async move { send_request(&client, &endpoint, "target").await }
    });
    assert!(
        wait_for_semaphore(&failing.reject_entered, Duration::from_secs(5)).await,
        "the first request must reach its held provider failure"
    );
    let sibling = timeout(
        Duration::from_secs(2),
        send_request(&client(), &endpoint, "sibling"),
    )
    .await
    .expect("a healthy sibling request must not wait for the held first request");
    assert!(
        !recovering.is_finished(),
        "the first request must still be held at its own provider response"
    );
    failing.reject_release.add_permits(1);
    let recovered = timeout(Duration::from_secs(5), &mut recovering)
        .await
        .expect("the first request must reselect its declared healthy successor")
        .expect("the recovery task must not panic");
    let failing_captures = failing.captures.lock().await.clone();
    let healthy_captures = healthy.captures.lock().await.clone();
    let order = attempt_order.lock().await.clone();
    handle.shutdown().await;
    stop_peer(failing).await;
    stop_peer(healthy).await;
    std::env::remove_var(AUTH_ENV);

    assert!(
        sibling.contains("sibling-recovery-fail-business-ok"),
        "the sibling must finish on its independent fast path: {sibling:?}"
    );
    assert!(
        recovered.contains("sibling-recovery-healthy-business-ok"),
        "the held request must recover after its 503 returns: {recovered:?}"
    );
    assert_eq!(
        failing_captures
            .iter()
            .filter(|capture| capture.input == "target" && !capture.probe)
            .count(),
        1,
        "the held request must attempt the preferred candidate exactly once: {failing_captures:?}"
    );
    assert_eq!(
        healthy_captures
            .iter()
            .filter(|capture| capture.input == "target" && !capture.probe)
            .count(),
        1,
        "the recovered request must attempt the declared successor exactly once: {healthy_captures:?}"
    );
    assert_eq!(
        order,
        [
            "sibling-recovery-fail:entered",
            "sibling-recovery-fail:503",
            "sibling-recovery-healthy:200",
        ],
        "the held upstream 503 must be observed before the successor succeeds"
    );
    assert!(
        !sibling.contains("owned-real-key-failure")
            && !recovered.contains("owned-real-key-failure"),
        "provider error payloads must remain internal"
    );
}

async fn start_recovery_hold(
    relay: bool,
    residence_ms: u64,
    successor_idle_timeout_ms: Option<u64>,
) -> (
    V3ServerAggregateHandle,
    PeerHandle,
    PeerHandle,
    std::net::SocketAddr,
    Arc<Mutex<Vec<String>>>,
) {
    let attempt_order = Arc::new(Mutex::new(Vec::new()));
    let failing = spawn_peer_with_order("recovery-hold-fail", attempt_order.clone()).await;
    let successor = spawn_peer_with_order("recovery-hold-successor", attempt_order.clone()).await;
    failing
        .rejected_inputs
        .lock()
        .await
        .insert("stream-holder".to_string(), 503);
    let providers = [
        (
            "recoveryholdfail",
            failing.base.as_str(),
            "wire-recoveryholdfail",
        ),
        (
            "recoveryholdsuccessor",
            successor.base.as_str(),
            "wire-recoveryholdsuccessor",
        ),
    ];
    let provider_blocks = providers
        .iter()
        .map(|(provider_id, base, wire_model)| {
            if relay {
                provider_block(provider_id, base, wire_model)
            } else {
                direct_provider_block(provider_id, base, wire_model)
            }
        })
        .collect::<String>();
    let route_pools = format!(
        r#"
[error]
provider_error_default_path = [
  {{ step = "wait_retry", retry_mode = "reselect_before_client_projection", max_attempts = 1, backoff_ms = {DECLARED_RETRY_BACKOFF_MS} }},
  {{ step = "project", reason_code = "provider_failure" }}
]

[route_groups.owned.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "recoveryholdfail", model = "model", key = "key", priority = 2 }},
  {{ kind = "provider_model", provider = "recoveryholdsuccessor", model = "model", key = "key", priority = 1 }}
]
"#
    );
    let mut manifest = manifest_with_execution(
        free_port(),
        &test_declaration(relay),
        &provider_blocks,
        &route_pools,
        &format!("attempt_store = {{ residence_timeout_ms = {residence_ms} }}"),
    );
    if let Some(idle_timeout_ms) = successor_idle_timeout_ms {
        manifest
            .providers
            .get_mut("recoveryholdsuccessor")
            .expect("successor provider")
            .sse_first_frame_timeout_ms = Some(idle_timeout_ms);
    }
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let server_addr = handle.listeners[0].addr;
    (handle, failing, successor, server_addr, attempt_order)
}

async fn open_streaming_responses_request(
    server_addr: std::net::SocketAddr,
    session_id: &str,
) -> TcpStream {
    let body = json!({
        "model": "client-auto",
        "input": "stream-holder",
        "stream": true
    })
    .to_string();
    let mut socket = TcpStream::connect(server_addr).await.unwrap();
    socket
        .write_all(
            format!(
                "POST /v1/responses HTTP/1.1\r\nHost: localhost\r\nX-Session-Id: {session_id}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    socket
}

fn request_records_path(home: &Path, port: u16) -> PathBuf {
    home.join(".rcc")
        .join("logs")
        .join(format!("server-v3-{port}.request-records.jsonl"))
}

fn read_request_rows(path: &Path) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|line| line.get("row").cloned())
        .collect()
}

async fn wait_for_request_terminal(
    path: &Path,
    event_type: &str,
    budget: Duration,
) -> Option<Vec<Value>> {
    let deadline = std::time::Instant::now() + budget;
    loop {
        let rows = read_request_rows(path);
        if rows
            .iter()
            .any(|row| row["event_type"] == json!(event_type))
        {
            return Some(rows);
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn read_until_bytes(socket: &mut TcpStream, needle: &[u8], budget: Duration) -> Vec<u8> {
    let mut wire = Vec::new();
    timeout(budget, async {
        while !wire.windows(needle.len()).any(|window| window == needle) {
            let mut chunk = [0; 1024];
            let count = socket.read(&mut chunk).await.unwrap();
            assert_ne!(count, 0, "client transport closed before {needle:?}");
            wire.extend_from_slice(&chunk[..count]);
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "timed out waiting for {:?}: {}",
            String::from_utf8_lossy(needle),
            String::from_utf8_lossy(&wire)
        )
    });
    wire
}

async fn stop_recovery_hold(
    handle: V3ServerAggregateHandle,
    failing: PeerHandle,
    successor: PeerHandle,
) {
    handle.shutdown().await;
    stop_peer(failing).await;
    stop_peer(successor).await;
    std::env::remove_var(AUTH_ENV);
}

async fn run_issue0afb440_cancel_after_recovery(relay: bool) {
    let (_home_guard, _guard) = TEST_LOCK.lock().await;
    let _keepalive = EnvironmentValueGuard::set(SSE_KEEPALIVE_ENV, "50");
    let home = PathBuf::from(std::env::var("HOME").unwrap());
    std::env::set_var(AUTH_ENV, AUTH_SECRET);
    let (handle, failing, successor, server_addr, attempt_order) =
        start_recovery_hold(relay, RECOVERY_HOLD_RESIDENCE_MS, None).await;
    let session_id = if relay {
        "issue0afb440-cancel-relay"
    } else {
        "issue0afb440-cancel-direct"
    };
    let mut socket = open_streaming_responses_request(server_addr, session_id).await;
    let wire = read_until_bytes(&mut socket, b"\r\n\r\n", Duration::from_secs(3)).await;
    assert!(
        String::from_utf8_lossy(&wire).starts_with("HTTP/1.1 200")
            && !String::from_utf8_lossy(&wire).contains("owned-real-key-failure"),
        "the request must have committed only its SSE transport before recovery: {}",
        String::from_utf8_lossy(&wire)
    );
    assert!(
        wait_for_semaphore(&successor.holder_entered, Duration::from_secs(5)).await,
        "{} recovery must dispatch the successor before the client cancels",
        if relay { "Relay" } else { "Direct" }
    );
    let request_counts = (
        failing
            .captures
            .lock()
            .await
            .iter()
            .filter(|capture| capture.input == "stream-holder" && !capture.probe)
            .count(),
        successor
            .captures
            .lock()
            .await
            .iter()
            .filter(|capture| capture.input == "stream-holder" && !capture.probe)
            .count(),
    );
    assert_eq!(
        request_counts.0, 1,
        "the failed identity must receive exactly one business attempt"
    );
    let order = attempt_order.lock().await.clone();
    drop(socket);

    let path = request_records_path(&home, server_addr.port());
    let rows = wait_for_request_terminal(&path, "request.cancelled", Duration::from_secs(2)).await;
    let cancelled = rows.as_ref().and_then(|rows| {
        rows.iter()
            .find(|row| row["event_type"] == json!("request.cancelled"))
    });
    let cancellation_recorded = cancelled.is_some();
    if let Some(cancelled) = cancelled {
        assert_eq!(
            cancelled["meta"]["provider_id"],
            json!("recoveryholdsuccessor"),
            "the cancellation must belong to the held successor attempt: {cancelled}"
        );
        assert_eq!(
            cancelled["meta"]["error_category"],
            json!("client_disconnect"),
            "client cancellation must retain its typed source: {cancelled}"
        );
        assert!(
            cancelled["meta"]["provider_status"].is_null(),
            "client cancellation must not carry a provider status: {cancelled}"
        );
    }
    let preparation = timeout(Duration::from_secs(2), handle.prepare_exec_attempt())
        .await
        .expect("client cancellation must release request activity");
    drop(preparation);

    stop_recovery_hold(handle, failing, successor).await;
    assert_eq!(
        request_counts,
        (1, 1),
        "cancellation must not retry the failed identity or duplicate the successor: {request_counts:?}"
    );
    assert_eq!(
        order,
        [
            "recovery-hold-fail:entered",
            "recovery-hold-fail:503",
            "recovery-hold-successor:200",
        ],
        "the real upstream 503 must be observed before the successor is cancelled"
    );
    assert!(
        rows.as_ref().map_or(true, |rows| rows.iter().all(|row| {
            row["event_type"] != json!("request.failed")
                && row["event_type"] != json!("request.completed")
        })),
        "client cancellation must not also record a failed or completed terminal; rows={rows:#?}"
    );
    assert!(
        cancellation_recorded,
        "disconnect after successor recovery dispatch must produce request.cancelled; rows={rows:#?}"
    );
}

async fn run_issue0afb440_idle_timeout_after_recovery(relay: bool) {
    let (_home_guard, _guard) = TEST_LOCK.lock().await;
    let _keepalive = EnvironmentValueGuard::set(SSE_KEEPALIVE_ENV, "50");
    let home = PathBuf::from(std::env::var("HOME").unwrap());
    std::env::set_var(AUTH_ENV, AUTH_SECRET);
    let (handle, failing, successor, server_addr, attempt_order) = start_recovery_hold(
        relay,
        RECOVERY_DEADLINE_RESIDENCE_MS,
        Some(RECOVERY_SUCCESSOR_IDLE_TIMEOUT_MS),
    )
    .await;
    failing
        .blocked_inputs
        .lock()
        .await
        .insert("stream-holder".to_string());
    failing.reject_blocked.store(true, Ordering::SeqCst);
    let session_id = if relay {
        "issue0afb440-deadline-relay"
    } else {
        "issue0afb440-deadline-direct"
    };
    let started = std::time::Instant::now();
    let mut socket = open_streaming_responses_request(server_addr, session_id).await;
    let initial_wire = read_until_bytes(&mut socket, b"\r\n\r\n", Duration::from_secs(3)).await;
    assert!(
        wait_for_semaphore(&failing.reject_entered, Duration::from_secs(5)).await,
        "the initial candidate must reach its delayed upstream failure"
    );
    sleep(Duration::from_millis(
        RECOVERY_DEADLINE_FIRST_FAILURE_DELAY_MS,
    ))
    .await;
    failing.reject_release.add_permits(1);
    assert!(
        wait_for_semaphore(&successor.holder_entered, Duration::from_secs(5)).await,
        "{} recovery must dispatch the successor before the original deadline",
        if relay { "Relay" } else { "Direct" }
    );
    let successor_started = std::time::Instant::now();
    let mut wire = Vec::new();
    let ended = timeout(Duration::from_secs(3), socket.read_to_end(&mut wire)).await;
    let elapsed = started.elapsed();
    let successor_elapsed = successor_started.elapsed();
    let wire_text = format!(
        "{}{}",
        String::from_utf8_lossy(&initial_wire),
        String::from_utf8_lossy(&wire)
    );
    let path = request_records_path(&home, server_addr.port());
    let rows = wait_for_request_terminal(&path, "request.failed", Duration::from_secs(2)).await;
    let failed = rows.as_ref().and_then(|rows| {
        rows.iter()
            .find(|row| row["event_type"] == json!("request.failed"))
    });
    let failed_terminal_recorded = failed.is_some();
    let failed_identity = failed
        .map(|failed| failed["meta"]["provider_id"] == json!("recoveryholdsuccessor"))
        .unwrap_or(false);
    let request_counts = (
        failing
            .captures
            .lock()
            .await
            .iter()
            .filter(|capture| capture.input == "stream-holder" && !capture.probe)
            .count(),
        successor
            .captures
            .lock()
            .await
            .iter()
            .filter(|capture| capture.input == "stream-holder" && !capture.probe)
            .count(),
    );
    let order = attempt_order.lock().await.clone();
    drop(socket);
    stop_recovery_hold(handle, failing, successor).await;

    let transport_ended = match ended.as_ref() {
        Ok(Ok(_)) => true,
        Ok(Err(error)) => error.kind() == std::io::ErrorKind::ConnectionReset,
        Err(_) => false,
    };
    assert!(
        transport_ended,
        "idle transport did not end within 3s of successor dispatch: {ended:?}; elapsed={elapsed:?}; {wire_text}"
    );
    assert!(
        elapsed > Duration::from_millis(RECOVERY_DEADLINE_RESIDENCE_MS)
            && successor_elapsed >= Duration::from_millis(RECOVERY_SUCCESSOR_IDLE_TIMEOUT_MS - 100),
        "the successor sent a frame and must use its own idle window: total={elapsed:?}; successor={successor_elapsed:?}"
    );
    assert!(
        failed_terminal_recorded && failed_identity,
        "idle timeout must record request.failed for the held successor; rows={rows:#?}"
    );
    assert!(
        !wire_text.contains("response.completed")
            && !wire_text.contains("\"status\":\"completed\"")
            && !wire_text.contains("owned-real-key-failure")
            && !wire_text.contains("\"error\"")
            && !wire_text.contains("network_error")
            && !wire_text.contains("502")
            && !wire_text.contains("598")
            && !wire_text.contains("599"),
        "the client must not receive fabricated success or provider/proxy error semantics: {wire_text}"
    );
    assert!(
        !wire.ends_with(b"0\r\n\r\n"),
        "the expired transport must break instead of faking a normal completion: {wire_text}"
    );
    assert_eq!(
        request_counts,
        (1, 1),
        "recovery must issue one attempt to each identity; failing/successor counts={request_counts:?}"
    );
    assert_eq!(
        order,
        [
            "recovery-hold-fail:entered",
            "recovery-hold-fail:503",
            "recovery-hold-successor:200",
        ],
        "the delayed upstream 503 must be observed before the successor stream is held"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue0afb440_client_cancel_after_recovery_direct() {
    run_issue0afb440_cancel_after_recovery(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue0afb440_client_cancel_after_recovery_relay() {
    run_issue0afb440_cancel_after_recovery(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue0afb440_idle_timeout_after_recovery_direct() {
    run_issue0afb440_idle_timeout_after_recovery(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue0afb440_idle_timeout_after_recovery_relay() {
    run_issue0afb440_idle_timeout_after_recovery(true).await;
}

async fn wait_for_terminal_evidence(samples_root: &std::path::Path) -> Value {
    for _ in 0..200 {
        if let Ok(entries) = std::fs::read_dir(samples_root) {
            for entry in entries.flatten() {
                let path = entry.path().join("provider-terminal.json");
                if let Ok(raw) = std::fs::read_to_string(path) {
                    if let Ok(evidence) = serde_json::from_str::<Value>(&raw) {
                        return evidence;
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("provider terminal evidence must appear under {samples_root:?}");
}

async fn wait_for_failed_attempt_evidence(samples_root: &std::path::Path) -> Value {
    for _ in 0..200 {
        if let Ok(entries) = std::fs::read_dir(samples_root) {
            for entry in entries.flatten() {
                let path = entry.path().join("provider-failed-attempts.json");
                if let Ok(raw) = std::fs::read_to_string(path) {
                    if let Ok(evidence) = serde_json::from_str::<Value>(&raw) {
                        return evidence;
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("provider failed-attempt evidence must appear under {samples_root:?}");
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
    let probed = client
        .post(format!("{base}/_routecodex/health/cooldown-pool/probe"))
        .json(&json!({
            "provider_id": provider_id,
            "interface_id": "default",
            "auth_alias": "key",
            "model_id": "model"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(probed.status(), StatusCode::OK);
    let probed = probed.json::<Value>().await.unwrap();
    assert_eq!(
        probed["scheduled"], true,
        "fixture identity must have a due exact probe: {probed}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn held_probe_does_not_block_healthy_sibling_admission() {
    let (_home, _guard) = TEST_LOCK.lock().await;
    std::env::set_var(AUTH_ENV, AUTH_SECRET);
    let leading = spawn_peer("leading").await;
    let healthy = spawn_peer("healthy").await;
    let route_pools = format!(
        r#"
[route_groups.owned.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "leading", model = "model", key = "key", priority = 2 }},
  {{ kind = "provider_model", provider = "healthy", model = "model", key = "key", priority = 1 }}
]
"#
    );
    let handle = spawn_v3_server_aggregate(manifest(
        free_port(),
        &[
            ("leading", leading.base.as_str(), "wire-leading"),
            ("healthy", healthy.base.as_str(), "wire-healthy"),
        ],
        &route_pools,
    ))
    .await
    .unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let endpoint = format!("{base}/v1/responses");
    let client = client();

    seed_exact_probe(&client, &base, "leading").await;
    let seeded = client
        .get(format!("{base}/_routecodex/health/cooldown-pool"))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    eprintln!("e37891a held-probe seeded pool={seeded}");
    let mut target = tokio::spawn({
        let client = client.clone();
        let endpoint = endpoint.clone();
        async move { send_request(&client, &endpoint, "target").await }
    });
    let probe_entered = wait_for_semaphore(&leading.probe_entered, Duration::from_secs(10)).await;
    let healthy_dispatched =
        wait_for_semaphore(&healthy.target_entered, Duration::from_secs(10)).await;
    let target_outcome = if healthy_dispatched {
        timeout(Duration::from_secs(10), &mut target)
            .await
            .ok()
            .and_then(Result::ok)
    } else {
        None
    };
    let target_sent_before_probe_release = healthy_dispatched;
    leading.probe_release.add_permits(1);

    let during = client
        .get(format!("{base}/_routecodex/health/cooldown-pool"))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    eprintln!(
        "e37891a held-probe fixture pool={during} healthy_target_entered={healthy_dispatched} target_outcome={target_outcome:?}"
    );
    if !healthy_dispatched {
        target.abort();
        let _ = target.await;
    }
    let leading_captures = leading.captures.lock().await.clone();
    let healthy_captures = healthy.captures.lock().await.clone();
    handle.shutdown().await;
    stop_peer(leading).await;
    stop_peer(healthy).await;
    std::env::remove_var(AUTH_ENV);

    assert!(
        probe_entered,
        "the public cooldown probe must reach the leading exact identity"
    );
    assert!(
        target_sent_before_probe_release,
        "healthy business dispatch must occur before the held probe is released"
    );
    assert!(
        leading_captures.iter().any(|capture| {
            capture.probe
                && capture.model == "wire-leading"
                && capture.authorization == format!("Bearer {AUTH_SECRET}")
        }),
        "leading probe must preserve exact provider/model/key identity: {leading_captures:?}"
    );
    assert!(
        !leading_captures
            .iter()
            .any(|capture| capture.input == "target" && !capture.probe),
        "the held leading identity must not receive the business target: {leading_captures:?}"
    );
    assert!(
        healthy_captures.iter().any(|capture| {
            capture.input == "target"
                && capture.model == "wire-healthy"
                && capture.authorization == format!("Bearer {AUTH_SECRET}")
        }),
        "the healthy sibling must receive the exact business request: {healthy_captures:?}"
    );
    let target_outcome = target_outcome.expect("healthy target must complete after dispatch");
    assert!(
        target_outcome.contains("healthy-business-ok"),
        "the client must receive the real healthy business response: {target_outcome:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn empty_leading_tier_reaches_healthy_lower_tier() {
    let (_home, _guard) = TEST_LOCK.lock().await;
    std::env::set_var(AUTH_ENV, AUTH_SECRET);
    let leading = spawn_peer("leading").await;
    let healthy = spawn_peer("healthy").await;
    let route_pools = r#"
[route_groups.owned.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "leading", model = "model", key = "key", priority = 2 },
  { kind = "provider_model", provider = "healthy", model = "model", key = "key", priority = 1 }
]
"#;
    let handle = spawn_v3_server_aggregate(manifest(
        free_port(),
        &[
            ("leading", leading.base.as_str(), "wire-leading"),
            ("healthy", healthy.base.as_str(), "wire-healthy"),
        ],
        route_pools,
    ))
    .await
    .unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let endpoint = format!("{base}/v1/responses");
    let client = client();

    let holder = tokio::spawn({
        let client = client.clone();
        let endpoint = endpoint.clone();
        async move { send_request(&client, &endpoint, "holder").await }
    });
    let holder_entered = wait_for_semaphore(&leading.holder_entered, Duration::from_secs(2)).await;
    seed_exact_probe(&client, &base, "leading").await;
    let mut target = tokio::spawn({
        let client = client.clone();
        let endpoint = endpoint.clone();
        async move { send_request(&client, &endpoint, "target").await }
    });
    let healthy_dispatched =
        wait_for_semaphore(&healthy.target_entered, Duration::from_secs(2)).await;
    let target_sent_before_holder_release = healthy_dispatched;
    let target_outcome = if healthy_dispatched {
        timeout(Duration::from_secs(2), &mut target)
            .await
            .ok()
            .and_then(Result::ok)
    } else {
        None
    };
    leading.holder_release.add_permits(1);
    leading.probe_release.add_permits(1);
    let holder_outcome = timeout(Duration::from_secs(2), holder)
        .await
        .ok()
        .and_then(Result::ok);
    if !healthy_dispatched {
        target.abort();
        let _ = target.await;
    }
    let leading_captures = leading.captures.lock().await.clone();
    let healthy_captures = healthy.captures.lock().await.clone();
    handle.shutdown().await;
    stop_peer(leading).await;
    stop_peer(healthy).await;
    std::env::remove_var(AUTH_ENV);

    assert!(
        holder_entered,
        "the leading tier must receive its capacity holder"
    );
    assert!(
        target_sent_before_holder_release,
        "the healthy lower tier must receive the target before the leading holder is released"
    );
    assert_eq!(
        leading_captures
            .iter()
            .filter(|capture| capture.input == "holder")
            .count(),
        1,
        "the original request must send once: {leading_captures:?}"
    );
    assert!(
        !leading_captures
            .iter()
            .any(|capture| capture.input == "target"),
        "the full leading tier must not receive the target: {leading_captures:?}"
    );
    assert!(
        healthy_captures.iter().any(|capture| {
            capture.input == "target"
                && capture.model == "wire-healthy"
                && capture.authorization == format!("Bearer {AUTH_SECRET}")
        }),
        "the healthy lower tier must receive the exact target: {healthy_captures:?}"
    );
    let holder_outcome = holder_outcome.expect("released holder must complete");
    assert!(
        holder_outcome.contains("leading-business-ok"),
        "the original holder must complete after release: {holder_outcome:?}"
    );
    let target_outcome = target_outcome.expect("healthy lower-tier target must complete");
    assert!(
        target_outcome.contains("healthy-business-ok"),
        "the target must complete with healthy business content: {target_outcome:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn matched_pool_unavailable_reaches_declared_default() {
    let (_home, _guard) = TEST_LOCK.lock().await;
    std::env::set_var(AUTH_ENV, AUTH_SECRET);
    let matched = spawn_peer("matched").await;
    let default = spawn_peer("default").await;
    let route_pools = r#"
[route_groups.owned.pools.thinking]
selection = { strategy = "priority" }
match = { precedence = 10, required_capabilities = ["thinking"] }
targets = [
  { kind = "provider_model", provider = "matched", model = "model", key = "key", priority = 1 }
]
[route_groups.owned.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "default", model = "model", key = "key", priority = 1 }
]
"#;
    let handle = spawn_v3_server_aggregate(manifest(
        free_port(),
        &[
            ("matched", matched.base.as_str(), "wire-matched"),
            ("default", default.base.as_str(), "wire-default"),
        ],
        route_pools,
    ))
    .await
    .unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let endpoint = format!("{base}/v1/responses");
    let client = client();

    let holder = tokio::spawn({
        let client = client.clone();
        let endpoint = endpoint.clone();
        async move { send_request(&client, &endpoint, "holder").await }
    });
    let holder_entered = wait_for_semaphore(&matched.holder_entered, Duration::from_secs(2)).await;
    seed_exact_probe(&client, &base, "matched").await;
    let mut target = tokio::spawn({
        let client = client.clone();
        let endpoint = endpoint.clone();
        async move { send_request(&client, &endpoint, "target").await }
    });
    let default_dispatched =
        wait_for_semaphore(&default.target_entered, Duration::from_secs(2)).await;
    let target_sent_before_holder_release = default_dispatched;
    let target_outcome = if default_dispatched {
        timeout(Duration::from_secs(2), &mut target)
            .await
            .ok()
            .and_then(Result::ok)
    } else {
        None
    };
    matched.holder_release.add_permits(1);
    matched.probe_release.add_permits(1);
    let holder_outcome = timeout(Duration::from_secs(2), holder)
        .await
        .ok()
        .and_then(Result::ok);
    if !default_dispatched {
        target.abort();
        let _ = target.await;
    }
    let matched_captures = matched.captures.lock().await.clone();
    let default_captures = default.captures.lock().await.clone();
    handle.shutdown().await;
    stop_peer(matched).await;
    stop_peer(default).await;
    std::env::remove_var(AUTH_ENV);

    assert!(
        holder_entered,
        "the matched pool must be selected while it has executable capacity"
    );
    assert!(
        target_sent_before_holder_release,
        "the declared default pool must receive the target before the matched-pool holder is released"
    );
    assert_eq!(
        matched_captures
            .iter()
            .filter(|capture| capture.input == "holder")
            .count(),
        1,
        "the original matched-pool request must send once: {matched_captures:?}"
    );
    assert!(
        !matched_captures
            .iter()
            .any(|capture| capture.input == "target"),
        "the unavailable matched pool must not receive the target while full: {matched_captures:?}"
    );
    assert!(
        default_captures.iter().any(|capture| {
            capture.input == "target"
                && capture.model == "wire-default"
                && capture.authorization == format!("Bearer {AUTH_SECRET}")
        }),
        "the declared default pool must receive the exact target: {default_captures:?}"
    );
    let holder_outcome = holder_outcome.expect("released matched holder must complete");
    assert!(
        holder_outcome.contains("matched-business-ok"),
        "the original matched-pool holder must complete after release: {holder_outcome:?}"
    );
    let target_outcome = target_outcome.expect("default-pool target must complete");
    assert!(
        target_outcome.contains("default-business-ok"),
        "the target must complete with default business content: {target_outcome:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_business_requests_have_no_admission_limit() {
    let (_home, _guard) = TEST_LOCK.lock().await;
    std::env::set_var(AUTH_ENV, AUTH_SECRET);
    let peer = spawn_peer("only").await;
    let handle = spawn_v3_server_aggregate(manifest(
        free_port(),
        &[("only", peer.base.as_str(), "wire-only")],
        r#"
[route_groups.owned.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "only", model = "model", key = "key", priority = 1 }]
"#,
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let client = client();
    let holder = tokio::spawn({
        let client = client.clone();
        let endpoint = endpoint.clone();
        async move { send_request(&client, &endpoint, "holder").await }
    });
    assert!(wait_for_semaphore(&peer.holder_entered, Duration::from_secs(2)).await);
    let mut target = tokio::spawn({
        let client = client.clone();
        let endpoint = endpoint.clone();
        async move { send_request(&client, &endpoint, "target").await }
    });
    let overlapping = wait_for_semaphore(&peer.target_entered, Duration::from_millis(500)).await;
    peer.holder_release.add_permits(1);
    let holder_outcome = timeout(Duration::from_secs(2), holder)
        .await
        .unwrap()
        .unwrap();
    let target_outcome = timeout(Duration::from_secs(2), &mut target).await;
    if target_outcome.is_err() {
        target.abort();
        let _ = target.await;
    }
    handle.shutdown().await;
    stop_peer(peer).await;
    std::env::remove_var(AUTH_ENV);
    assert!(
        overlapping,
        "the second business request must reach the same provider before the first is released"
    );
    assert!(holder_outcome.contains("only-business-ok"));
    let outcome = target_outcome
        .expect("released capacity must resume the accepted request")
        .unwrap();
    assert!(outcome.contains("only-business-ok"), "{outcome:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn final_provider_final_key_projects_real_http_error() {
    let (home, _guard) = TEST_LOCK.lock().await;
    std::env::set_var(AUTH_ENV, AUTH_SECRET);
    let peer = spawn_peer("final").await;
    peer.rejected_keys
        .lock()
        .await
        .insert(format!("Bearer {AUTH_SECRET}"), 418);
    let handle = spawn_v3_server_aggregate(manifest(
        free_port(),
        &[("final", peer.base.as_str(), "wire-final")],
        r#"
[route_groups.owned.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "final", model = "model", key = "key", priority = 1 }]
"#,
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let port = handle.listeners[0].addr.port();

    let outcome = send_request(&client(), &endpoint, "target").await;
    let captures = peer.captures.lock().await.clone();
    let evidence = wait_for_terminal_evidence(&home.codex_samples_root(port)).await;
    handle.shutdown().await;
    stop_peer(peer).await;
    std::env::remove_var(AUTH_ENV);

    assert_eq!(
        captures
            .iter()
            .filter(|capture| capture.input == "target")
            .count(),
        1,
        "the only declared key must be attempted exactly once: {captures:?}"
    );
    assert_final_http_error(&outcome, &evidence, 418);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn final_provider_final_key_projects_429_and_stays_health_neutral() {
    assert_final_429_is_health_neutral(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn relay_final_provider_final_key_projects_429_and_stays_health_neutral() {
    assert_final_429_is_health_neutral(true).await;
}

async fn assert_final_429_is_health_neutral(relay: bool) {
    let (home, _guard) = TEST_LOCK.lock().await;
    std::env::set_var(AUTH_ENV, AUTH_SECRET);
    let peer = spawn_peer("final429").await;
    peer.rejected_keys
        .lock()
        .await
        .insert(format!("Bearer {AUTH_SECRET}"), 429);
    let provider_blocks = if relay {
        provider_block("final429", peer.base.as_str(), "wire-final429")
    } else {
        direct_provider_block("final429", peer.base.as_str(), "wire-final429")
    };
    let handle = spawn_v3_server_aggregate(manifest_with_declaration(
        free_port(),
        &test_declaration(relay),
        &provider_blocks,
        r#"
[route_groups.owned.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "final429", model = "model", key = "key", priority = 1 }]
"#,
    ))
    .await
    .unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let endpoint = format!("{base}/v1/responses");
    let port = handle.listeners[0].addr.port();

    let client = client();
    let mut outcomes = Vec::new();
    for index in 0..11 {
        let input = format!("final-429-{index}");
        outcomes.push(send_request(&client, &endpoint, &input).await);
    }
    let captures = peer.captures.lock().await.clone();
    let terminal = wait_for_terminal_evidence(&home.codex_samples_root(port)).await;
    let failed_attempts = wait_for_failed_attempt_evidence(&home.codex_samples_root(port)).await;
    let pool = client
        .get(format!("{base}/_routecodex/health/cooldown-pool"))
        .send()
        .await
        .unwrap()
        .json::<Value>()
        .await
        .unwrap();
    handle.shutdown().await;
    stop_peer(peer).await;
    std::env::remove_var(AUTH_ENV);

    for (index, outcome) in outcomes.iter().enumerate() {
        let input = format!("final-429-{index}");
        assert_eq!(
            captures
                .iter()
                .filter(|capture| capture.input == input)
                .count(),
            1,
            "the final key must receive one attempt for each new request: {input}"
        );
        assert_final_http_error(outcome, &terminal, 429);
    }
    let attempts = failed_attempts["attempts"]
        .as_array()
        .expect("failed attempts must be an array");
    assert_eq!(attempts.len(), 1, "{failed_attempts}");
    assert_eq!(
        attempts[0]["health_state"], "last_candidate_terminal",
        "the final 429 identity must stay health-neutral: {failed_attempts}"
    );
    let entries = pool["entries"].as_array().expect("cooldown entries");
    assert!(
        entries.iter().all(|entry| {
            !(entry["provider_id"] == "final429"
                && entry["interface_id"] == "default"
                && entry["auth_alias"].as_str() == Some("key")
                && entry["model_id"].as_str() == Some("model"))
        }),
        "the final 429 exact identity must not acquire a cooldown/probe/recovery entry: {entries:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn remaining_same_provider_key_is_attempted_after_first_key_failure() {
    let (_home, _guard) = TEST_LOCK.lock().await;
    std::env::set_var(AUTH_ENV, AUTH_SECRET);
    std::env::set_var(SECOND_AUTH_ENV, SECOND_AUTH_SECRET);
    let peer = spawn_peer("siblings").await;
    peer.rejected_keys
        .lock()
        .await
        .insert(format!("Bearer {AUTH_SECRET}"), 503);
    let provider_blocks =
        provider_block_with_two_keys("siblings", peer.base.as_str(), "wire-siblings");
    let handle = spawn_v3_server_aggregate(manifest_with_provider_blocks(
        free_port(),
        &provider_blocks,
        r#"
[route_groups.owned.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "siblings", model = "model", key = "key1", priority = 2 },
  { kind = "provider_model", provider = "siblings", model = "model", key = "key2", priority = 1 }
]
"#,
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);

    let outcome = send_request(&client(), &endpoint, "target").await;
    let captures = peer.captures.lock().await.clone();
    handle.shutdown().await;
    stop_peer(peer).await;
    std::env::remove_var(AUTH_ENV);
    std::env::remove_var(SECOND_AUTH_ENV);

    assert!(
        captures.iter().any(|capture| {
            capture.input == "target" && capture.authorization == format!("Bearer {AUTH_SECRET}")
        }),
        "the failed first key must be attempted: {captures:?}"
    );
    assert!(
        captures.iter().any(|capture| {
            capture.input == "target"
                && capture.authorization == format!("Bearer {SECOND_AUTH_SECRET}")
        }),
        "the untried sibling key must receive the request: {captures:?}"
    );
    assert!(
        outcome.contains("siblings-business-ok"),
        "the sibling key success must reach the client: {outcome:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn last_of_two_failing_keys_projects_only_its_own_error() {
    let (home, _guard) = TEST_LOCK.lock().await;
    std::env::set_var(AUTH_ENV, AUTH_SECRET);
    std::env::set_var(SECOND_AUTH_ENV, SECOND_AUTH_SECRET);
    let peer = spawn_peer("finalkeys").await;
    peer.rejected_keys
        .lock()
        .await
        .insert(format!("Bearer {AUTH_SECRET}"), 503);
    peer.rejected_keys
        .lock()
        .await
        .insert(format!("Bearer {SECOND_AUTH_SECRET}"), 418);
    let provider_blocks =
        provider_block_with_two_keys("finalkeys", peer.base.as_str(), "wire-finalkeys");
    let route_pools = "\
[route_groups.owned.pools.default]
selection = { strategy = \"priority\" }
targets = [
  { kind = \"provider_model\", provider = \"finalkeys\", model = \"model\", key = \"key1\", priority = 2 },
  { kind = \"provider_model\", provider = \"finalkeys\", model = \"model\", key = \"key2\", priority = 1 }
]
";
    let handle = spawn_v3_server_aggregate(manifest_with_provider_blocks(
        free_port(),
        &provider_blocks,
        route_pools,
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);
    let port = handle.listeners[0].addr.port();

    let outcome = send_request(&client(), &endpoint, "target").await;
    let captures = peer.captures.lock().await.clone();
    let evidence = wait_for_terminal_evidence(&home.codex_samples_root(port)).await;
    handle.shutdown().await;
    stop_peer(peer).await;
    std::env::remove_var(AUTH_ENV);
    std::env::remove_var(SECOND_AUTH_ENV);

    let keys = captures
        .iter()
        .filter(|capture| capture.input == "target")
        .map(|capture| &capture.authorization)
        .collect::<Vec<_>>();
    assert_eq!(
        keys,
        [
            &format!("Bearer {AUTH_SECRET}"),
            &format!("Bearer {SECOND_AUTH_SECRET}")
        ],
        "the first failed key and final key must each be attempted once in order"
    );
    assert_final_http_error(&outcome, &evidence, 418);
}

async fn run_issue0afb440_ninth_visible_candidate(relay: bool) {
    let (_home, _guard) = TEST_LOCK.lock().await;
    std::env::set_var(AUTH_ENV, AUTH_SECRET);
    let business_attempt_order = Arc::new(Mutex::new(Vec::new()));
    let peers = [
        spawn_peer_with_order("capacity-00", business_attempt_order.clone()).await,
        spawn_peer_with_order("capacity-01", business_attempt_order.clone()).await,
        spawn_peer_with_order("capacity-02", business_attempt_order.clone()).await,
        spawn_peer_with_order("capacity-03", business_attempt_order.clone()).await,
        spawn_peer_with_order("capacity-04", business_attempt_order.clone()).await,
        spawn_peer_with_order("capacity-05", business_attempt_order.clone()).await,
        spawn_peer_with_order("capacity-06", business_attempt_order.clone()).await,
        spawn_peer_with_order("capacity-07", business_attempt_order.clone()).await,
        spawn_peer_with_order("capacity-08", business_attempt_order.clone()).await,
    ];
    for peer in peers.iter().take(8) {
        peer.rejected_keys
            .lock()
            .await
            .insert(format!("Bearer {AUTH_SECRET}"), 503);
    }

    let provider_ids = [
        "capacity00",
        "capacity01",
        "capacity02",
        "capacity03",
        "capacity04",
        "capacity05",
        "capacity06",
        "capacity07",
        "capacity08",
    ];
    let providers = provider_ids
        .iter()
        .zip(peers.iter())
        .map(|(provider_id, peer)| (*provider_id, peer.base.as_str(), "wire-capacity"))
        .collect::<Vec<_>>();
    let route_pools = r#"
[route_groups.owned.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "capacity00", model = "model", key = "key", priority = 9 },
  { kind = "provider_model", provider = "capacity01", model = "model", key = "key", priority = 8 },
  { kind = "provider_model", provider = "capacity02", model = "model", key = "key", priority = 7 },
  { kind = "provider_model", provider = "capacity03", model = "model", key = "key", priority = 6 },
  { kind = "provider_model", provider = "capacity04", model = "model", key = "key", priority = 5 },
  { kind = "provider_model", provider = "capacity05", model = "model", key = "key", priority = 4 },
  { kind = "provider_model", provider = "capacity06", model = "model", key = "key", priority = 3 },
  { kind = "provider_model", provider = "capacity07", model = "model", key = "key", priority = 2 },
  { kind = "provider_model", provider = "capacity08", model = "model", key = "key", priority = 1 }
]
"#;
    let provider_blocks = if relay {
        providers
            .iter()
            .map(|(provider_id, base, wire_model)| provider_block(provider_id, base, wire_model))
            .collect::<String>()
    } else {
        providers
            .iter()
            .map(|(provider_id, base, wire_model)| {
                direct_provider_block(provider_id, base, wire_model)
            })
            .collect::<String>()
    };
    let declaration = if relay {
        let direct_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }"#;
        let relay_binding = r#"{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "relay", protocol_profile_owner = "v3.hub_relay_runtime_closeout", implemented = true, forbidden_reentry_behavior = "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime.", runtime_owner_symbol = "execute_v3_responses_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs" }"#;
        hub_v1_fixture::hub_v1_test_declaration().replace(direct_binding, relay_binding)
    } else {
        hub_v1_fixture::hub_v1_test_declaration()
    };
    let handle = spawn_v3_server_aggregate(manifest_with_declaration(
        free_port(),
        &declaration,
        &provider_blocks,
        route_pools,
    ))
    .await
    .unwrap();
    let endpoint = format!("http://{}/v1/responses", handle.listeners[0].addr);

    for peer in peers.iter().take(8) {
        peer.reject_blocked.store(true, Ordering::SeqCst);
    }
    let client_task =
        tokio::spawn(async move { send_request(&client(), &endpoint, "target").await });
    for (index, peer) in peers.iter().take(8).enumerate() {
        timeout(Duration::from_secs(5), peer.reject_entered.acquire())
            .await
            .unwrap_or_else(|_| panic!("candidate {index} must enter before timeout"))
            .expect("candidate rejection gate must remain open")
            .forget();
        for (later_index, later_peer) in peers.iter().enumerate().skip(index + 1) {
            let later_captures = later_peer.captures.lock().await;
            assert!(
                !later_captures
                    .iter()
                    .any(|capture| capture.input == "target" && !capture.probe),
                "candidate {later_index} must not start before candidate {index} returns its 503: {later_captures:?}"
            );
        }
        peer.reject_release.add_permits(1);
    }
    let outcome = timeout(CLIENT_TIMEOUT, client_task)
        .await
        .expect("client must complete after the rejection gates release")
        .expect("client task must not panic");
    let mut captures = Vec::new();
    for peer in &peers {
        captures.push(peer.captures.lock().await.clone());
    }
    let observed_order = business_attempt_order.lock().await.clone();
    handle.shutdown().await;
    for peer in peers {
        stop_peer(peer).await;
    }
    std::env::remove_var(AUTH_ENV);

    let ClientOutcome::Completed(value) = outcome else {
        panic!("the ninth visible candidate must complete the client response: {outcome:?}");
    };
    assert!(
        value["status"] == "completed" && value.to_string().contains("capacity-08-business-ok"),
        "the ninth visible candidate success must reach the client: {value}"
    );
    for (index, peer_captures) in captures.iter().enumerate() {
        assert_eq!(
            peer_captures
                .iter()
                .filter(|capture| capture.input == "target" && !capture.probe)
                .count(),
            1,
            "visible candidate {index} in {mode} must receive exactly one business attempt: {peer_captures:?}",
            mode = if relay { "Relay" } else { "Direct" }
        );
    }
    assert_eq!(
        observed_order,
        [
            "capacity-00:entered",
            "capacity-00:503",
            "capacity-01:entered",
            "capacity-01:503",
            "capacity-02:entered",
            "capacity-02:503",
            "capacity-03:entered",
            "capacity-03:503",
            "capacity-04:entered",
            "capacity-04:503",
            "capacity-05:entered",
            "capacity-05:503",
            "capacity-06:entered",
            "capacity-06:503",
            "capacity-07:entered",
            "capacity-07:503",
            "capacity-08:200",
        ],
        "each candidate must enter only after the preceding 503 has returned"
    );
    assert!(
        !value.to_string().contains("owned-real-key-failure"),
        "the eight provider failures must stay out of the client response: {value}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue0afb440_ninth_visible_candidate_completes_after_eight_provider_failures_direct() {
    run_issue0afb440_ninth_visible_candidate(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn issue0afb440_ninth_visible_candidate_completes_after_eight_provider_failures_relay() {
    run_issue0afb440_ninth_visible_candidate(true).await;
}

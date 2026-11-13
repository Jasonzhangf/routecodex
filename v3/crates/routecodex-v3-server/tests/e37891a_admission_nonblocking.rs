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
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{collections::BTreeMap, ops::Deref, sync::Arc};
use tokio::{
    net::TcpListener,
    sync::{Mutex, Semaphore},
    task::JoinHandle,
    time::{timeout, Duration},
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
    rejected_keys: Mutex<BTreeMap<String, u16>>,
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

    if let Some(status) = peer.rejected_keys.lock().await.get(&authorization).copied() {
        return Response::builder()
            .status(status)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"error":{"message":"owned-real-key-failure"}}).to_string(),
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
    } else if input == "target" {
        peer.target_entered.add_permits(1);
    }
    completed_response(peer.label, &model)
}

async fn spawn_peer(label: &'static str) -> PeerHandle {
    let peer = Arc::new(Peer {
        label,
        captures: Mutex::new(Vec::new()),
        rejected_keys: Mutex::new(BTreeMap::new()),
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
async fn final_provider_final_key_error_stays_internal_and_ends_transport() {
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
    let ClientOutcome::TransportError(error) = &outcome else {
        panic!("the final provider failure must end only this client transport: {outcome:?}");
    };
    assert!(
        !error.contains("owned-real-key-failure"),
        "provider error body must not reach the client: {error}"
    );
    assert_eq!(evidence["kind"], "external_http", "{evidence}");
    assert_eq!(evidence["status"], 418, "{evidence}");
    assert!(
        evidence_body_text(&evidence).contains("owned-real-key-failure"),
        "the real provider error must remain available internally: {evidence}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn final_provider_final_key_429_stays_health_neutral_and_ends_transport() {
    let (home, _guard) = TEST_LOCK.lock().await;
    std::env::set_var(AUTH_ENV, AUTH_SECRET);
    let peer = spawn_peer("final429").await;
    peer.rejected_keys
        .lock()
        .await
        .insert(format!("Bearer {AUTH_SECRET}"), 429);
    let provider_blocks = direct_provider_block("final429", peer.base.as_str(), "wire-final429");
    let handle = spawn_v3_server_aggregate(manifest_with_provider_blocks(
        free_port(),
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
    let outcome = send_request(&client, &endpoint, "target").await;
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

    assert_eq!(
        captures
            .iter()
            .filter(|capture| capture.input == "target")
            .count(),
        1,
        "the only declared key must be attempted exactly once: {captures:?}"
    );
    let ClientOutcome::TransportError(error) = &outcome else {
        panic!("the final provider failure must end only this client transport: {outcome:?}");
    };
    assert!(
        !error.contains("owned-real-key-failure"),
        "provider error body must not reach the client: {error}"
    );
    assert_eq!(terminal["kind"], "external_http", "{terminal}");
    assert_eq!(terminal["status"], 429, "{terminal}");
    assert!(
        evidence_body_text(&terminal).contains("owned-real-key-failure"),
        "the real provider error must remain available internally: {terminal}"
    );
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
async fn last_of_two_failing_keys_keep_errors_internal_and_end_transport() {
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

    assert!(
        captures.iter().any(|capture| {
            capture.input == "target" && capture.authorization == format!("Bearer {AUTH_SECRET}")
        }),
        "the first failing key must be attempted: {captures:?}"
    );
    assert!(
        captures.iter().any(|capture| {
            capture.input == "target"
                && capture.authorization == format!("Bearer {SECOND_AUTH_SECRET}")
        }),
        "the final untried key must be attempted after the first failure: {captures:?}"
    );
    let ClientOutcome::TransportError(error) = &outcome else {
        panic!("the exhausted provider target must end only this client transport: {outcome:?}");
    };
    assert!(
        !error.contains("owned-real-key-failure"),
        "provider error body must not reach the client: {error}"
    );
    assert_eq!(evidence["kind"], "external_http", "{evidence}");
    assert_eq!(evidence["status"], 418, "{evidence}");
    assert!(
        evidence_body_text(&evidence).contains("owned-real-key-failure"),
        "the final provider error must remain available internally: {evidence}"
    );
}

//! fa22072 Runtime rescue causal witness through the real Chat HTTP listener.
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    routing::post,
    Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::spawn_v3_server_aggregate;
use serde_json::{json, Value};
use std::{ffi::OsString, path::PathBuf, sync::Arc};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{Mutex, Semaphore},
    time::{timeout, Duration},
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;

struct TestHomeGuard {
    previous: Option<OsString>,
    path: PathBuf,
}
impl TestHomeGuard {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("fa22072-probe-lifecycle-r6-{}", std::process::id()));
        std::fs::create_dir(&path).unwrap();
        let previous = std::env::var_os("HOME");
        std::env::set_var("HOME", &path);
        Self { previous, path }
    }
}
impl Drop for TestHomeGuard {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        std::fs::remove_dir_all(&self.path).unwrap();
    }
}

struct Peer {
    captures: Mutex<Vec<Value>>,
    probe_entered: Semaphore,
    probe_release: Semaphore,
    business_entered: Semaphore,
    business_release: Semaphore,
}
async fn healthy(
    State(peer): State<Arc<Peer>>,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    peer.captures.lock().await.push(body.clone());
    if body["messages"][0]["content"] == "upstream failure marker" {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":{"message":"owned upstream forbidden"}})),
        );
    }
    (
        StatusCode::OK,
        Json(
            json!({"id":"chat_step5", "object":"chat.completion", "model":"step-5-preview",
        "choices":[{"index":0,"message":{"role":"assistant","content":"step5 complete"},"finish_reason":"stop"}]}),
        ),
    )
}
async fn cooled(
    State(peer): State<Arc<Peer>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> (StatusCode, Json<Value>) {
    assert_eq!(headers["authorization"], "Bearer owned-test-key");
    assert_eq!(body["model"], "step-5-preview");
    peer.captures.lock().await.push(body.clone());
    if body["messages"][0]["content"] == "earlier business generation marker" {
        peer.business_entered.add_permits(1);
        peer.business_release.acquire().await.unwrap().forget();
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":{"message":"owned earlier business forbidden"}})),
        );
    }
    peer.probe_entered.add_permits(1);
    peer.probe_release.acquire().await.unwrap().forget();
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(json!({"error":{"message":"owned failed probe"}})),
    )
}

fn manifest(
    base: &str,
    port: u16,
    preceding_tier: bool,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let execution = hub_v1_fixture::hub_v1_server_execution("chat");
    let source = format!(
        r#"
version = 3
{declaration}
[servers.chat]
bind = "127.0.0.1"
port = {port}
routing_group = "recovery"
endpoints = ["openai_chat"]
{execution}
[providers.healthy]
type = "openai_chat"
base_url = "{base}/healthy/v1"
default_model = "step-5-preview"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "FA22072_RECOVERY_TEST_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.healthy.models.step-5-preview]
wire_name = "step-5-preview"
capabilities = ["text"]
max_context_tokens = 1000000
[providers.cooled]
type = "openai_chat"
base_url = "{base}/cooled/v1"
default_model = "step-5-preview"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "FA22072_RECOVERY_TEST_KEY" }}] }}
health = {{ enabled = false, failure_threshold = 1, cooldown_ms = 5000 }}
[providers.cooled.models.step-5-preview]
wire_name = "step-5-preview"
capabilities = ["text"]
max_context_tokens = 1000000
[debug]
log_console = false
snapshots = false
codex_samples = false
[route_groups.recovery.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "cooled", model = "step-5-preview", key = "key", priority = 100 }}, {{ kind = "provider_model", provider = "healthy", model = "step-5-preview", key = "key", priority = 1 }}]
"#
    );
    let mut authoring = parse_v3_config_02_authoring(&source).unwrap();
    if preceding_tier {
        let group = authoring.route_groups.get_mut("recovery").unwrap();
        let mut preceding = group.pools["default"].clone();
        preceding
            .targets
            .retain(|target| target.provider.as_deref() == Some("cooled"));
        preceding.match_rule = Some(routecodex_v3_config::V3RoutePoolMatchAuthoringConfig {
            precedence: Some(10),
            entry_protocol: Some("openai_chat".into()),
            models: vec!["step-5-preview".into()],
            required_capabilities: Vec::new(),
            min_input_tokens: None,
            max_input_tokens: None,
        });
        group
            .pools
            .get_mut("default")
            .unwrap()
            .targets
            .retain(|target| target.provider.as_deref() == Some("healthy"));
        group.pools.insert("preceding".into(), preceding);
    }
    compile_v3_config_05_manifest(authoring).unwrap()
}

async fn raw_chat(port: u16, model: &str, marker: &str, stream: bool) -> Vec<u8> {
    let body = json!({"model":model,"messages":[{"role":"user","content":marker}],"stream":stream})
        .to_string();
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    socket.write_all(format!("POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    let mut bytes = Vec::new();
    let result = timeout(Duration::from_secs(2), socket.read_to_end(&mut bytes))
        .await
        .expect("failed request transport must close without waiting for future provider recovery");
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

static TEST_LOCK: Mutex<()> = Mutex::const_new(());

#[tokio::test]
async fn healthy_chat_selection_does_not_wait_for_owned_pending_probe() {
    public_recovery_witness(true, false, ProbeEnd::Release).await;
}

#[tokio::test]
async fn all_cooled_failed_probe_closes_chat_and_preserves_healthy_sibling() {
    public_recovery_witness(false, false, ProbeEnd::Release).await;
}

#[tokio::test]
async fn preceding_tier_probe_is_single_flight_while_healthy_chat_completes() {
    public_recovery_witness(true, true, ProbeEnd::Release).await;
}

#[tokio::test]
async fn aggregate_shutdown_cancels_held_probe_without_remote_release() {
    public_recovery_witness(true, false, ProbeEnd::Shutdown).await;
}

#[tokio::test]
async fn aggregate_exec_preparation_cancels_held_probe_without_remote_release() {
    public_recovery_witness(true, false, ProbeEnd::Exec).await;
}

#[tokio::test]
async fn aggregate_drop_cancels_held_probe_without_remote_release() {
    public_recovery_witness(true, false, ProbeEnd::Drop).await;
}

#[tokio::test]
async fn newer_business_generation_shutdown_releases_held_probe_owner() {
    public_recovery_witness_with_generation(true, false, ProbeEnd::Shutdown, true).await;
}

#[tokio::test]
async fn newer_business_generation_exec_releases_held_probe_owner() {
    public_recovery_witness_with_generation(true, false, ProbeEnd::Exec, true).await;
}

#[tokio::test]
async fn newer_business_generation_drop_releases_held_probe_owner() {
    public_recovery_witness_with_generation(true, false, ProbeEnd::Drop, true).await;
}

// Keep one already accepted public control connection. Listener shutdown stops
// accepts; this connection retains the existing read-only service and its store.
// This observes actual in-memory ownership after exit, without reloading state.
async fn retained_cooldown_pool(socket: &mut TcpStream) -> Value {
    socket.write_all(b"GET /_routecodex/health/cooldown-pool HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n").await.unwrap();
    let mut headers = Vec::new();
    while !headers.ends_with(b"\r\n\r\n") {
        headers.push(socket.read_u8().await.unwrap());
    }
    let headers = String::from_utf8(headers).unwrap();
    assert!(headers.starts_with("HTTP/1.1 200"), "{headers}");
    let length: usize = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse().unwrap())
        })
        .expect("JSON control response has a bounded content length");
    let mut body = vec![0; length];
    socket.read_exact(&mut body).await.unwrap();
    serde_json::from_slice(&body).unwrap()
}

async fn assert_released_on_retained_connection(socket: &mut TcpStream, before: &Value) {
    timeout(Duration::from_secs(2), async {
        loop {
            let pool = retained_cooldown_pool(socket).await;
            let entry = exact_probe(&pool);
            if entry["state"] != "probing" {
                assert_eq!(entry["failure_count"], before["failure_count"]);
                assert_eq!(entry["until_ms"], before["until_ms"]);
                return;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("exited probe owner must release its marker despite newer business generation");
}

#[derive(Clone, Copy)]
enum ProbeEnd {
    Release,
    Shutdown,
    Exec,
    Drop,
}

async fn cooldown_pool(client: &reqwest::Client, base: &str) -> Value {
    client
        .get(format!("{base}/_routecodex/health/cooldown-pool"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

fn exact_probe(pool: &Value) -> &Value {
    pool["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| {
            entry["provider_id"] == "cooled"
                && entry["interface_id"] == "default"
                && entry["auth_alias"] == "key"
                && entry["model_id"] == "step-5-preview"
                && entry["kind"] == "probe"
        })
        .expect("exact cooled identity must remain visible")
}

async fn public_recovery_witness(
    require_pending_healthy_progress: bool,
    preceding_tier: bool,
    probe_end: ProbeEnd,
) {
    public_recovery_witness_with_generation(
        require_pending_healthy_progress,
        preceding_tier,
        probe_end,
        false,
    )
    .await;
}

async fn public_recovery_witness_with_generation(
    require_pending_healthy_progress: bool,
    preceding_tier: bool,
    probe_end: ProbeEnd,
    advance_generation: bool,
) {
    let _lock = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new();
    eprintln!(
        "owned public fixture pid={} home={}",
        std::process::id(),
        _home.path.display()
    );
    std::env::set_var("FA22072_RECOVERY_TEST_KEY", "owned-test-key");
    let peer = Arc::new(Peer {
        captures: Mutex::new(Vec::new()),
        probe_entered: Semaphore::new(0),
        probe_release: Semaphore::new(0),
        business_entered: Semaphore::new(0),
        business_release: Semaphore::new(0),
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = Router::new()
        .route("/healthy/v1/chat/completions", post(healthy))
        .route("/cooled/v1/chat/completions", post(cooled))
        .with_state(peer.clone());
    let upstream = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let reserved = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = reserved.local_addr().unwrap().port();
    drop(reserved);
    let mut manifest = manifest(&format!("http://{addr}"), port, preceding_tier);
    if advance_generation {
        manifest
            .providers
            .get_mut("cooled")
            .unwrap()
            .health
            .as_mut()
            .unwrap()
            .enabled = true;
    }
    let handle = spawn_v3_server_aggregate(manifest).await.unwrap();
    let base = format!("http://{}", handle.listeners[0].addr);
    let client = reqwest::Client::new();
    let earlier_business = if advance_generation {
        let request = tokio::spawn(raw_chat(
            port,
            "cooled.step-5-preview",
            "earlier business generation marker",
            false,
        ));
        timeout(Duration::from_secs(2), peer.business_entered.acquire())
            .await
            .unwrap()
            .unwrap()
            .forget();
        Some(request)
    } else {
        None
    };
    let add = client.post(format!("{base}/_routecodex/health/cooldown-pool/add"))
        .json(&json!({"provider_id":"cooled", "interface_id":"default", "auth_alias":"key", "model_id":"step-5-preview", "kind":"probe", "duration_ms":60000}))
        .send().await.unwrap();
    assert_eq!(add.status(), 200);
    let request_client = client.clone();
    let request_base = base.clone();
    let mut request = tokio::spawn(async move {
        request_client.post(format!("{request_base}/v1/chat/completions"))
            .json(&json!({"model":"step-5-preview","messages":[{"role":"user","content":"step5 marker"}],"stream":false}))
            .send().await
    });
    timeout(Duration::from_secs(2), peer.probe_entered.acquire())
        .await
        .expect("real probe must enter upstream")
        .unwrap()
        .forget();
    let before_release = timeout(Duration::from_millis(500), &mut request).await;
    let attempted_before_release = peer
        .captures
        .lock()
        .await
        .iter()
        .any(|v| v["messages"][0]["content"] == "step5 marker");
    eprintln!("public causal witness: probe pending, healthy business attempted={attempted_before_release}, request_finished={}", before_release.is_ok());
    let completed_before_release = before_release.is_ok();
    if require_pending_healthy_progress {
        assert!(
            completed_before_release && attempted_before_release,
            "healthy business must complete while actual cooled probe is held"
        );
    }
    let pending_pool = cooldown_pool(&client, &base).await;
    assert_eq!(exact_probe(&pending_pool)["state"], "probing");
    if preceding_tier {
        let concurrent = client.post(format!("{base}/v1/chat/completions"))
            .json(&json!({"model":"step-5-preview","messages":[{"role":"user","content":"concurrent marker"}],"stream":false}))
            .send().await.unwrap();
        assert_eq!(
            concurrent.json::<Value>().await.unwrap()["choices"][0]["message"]["content"],
            "step5 complete"
        );
        assert_eq!(
            peer.probe_entered.available_permits(),
            0,
            "concurrent request must not duplicate the held probe"
        );
    }
    // Release the same external probe: forward intervention, without any product timeout.
    let response = match before_release {
        Ok(value) => value.unwrap().unwrap(),
        Err(_) => timeout(Duration::from_secs(2), &mut request)
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
    };
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.unwrap();
    assert_eq!(body["choices"][0]["message"]["content"], "step5 complete");
    if let Some(earlier_business) = earlier_business {
        // Actual pinned business 403 passes through typed Error/Provider health
        // before this request-local close. Probe A remains authenticated and held.
        peer.business_release.add_permits(1);
        let bytes = timeout(Duration::from_secs(2), earlier_business)
            .await
            .unwrap()
            .unwrap();
        assert!(
            bytes.is_empty(),
            "provider 403 must not become client error data"
        );
        assert_eq!(peer.probe_release.available_permits(), 0);
        eprintln!("same-identity earlier business403 processed after held probe capture; healthy content already complete");
    }
    let mut retained = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let before_exit = timeout(
        Duration::from_secs(2),
        retained_cooldown_pool(&mut retained),
    )
    .await
    .unwrap();
    let before_exit = exact_probe(&before_exit).clone();
    assert_eq!(before_exit["state"], "probing");
    match probe_end {
        ProbeEnd::Release => peer.probe_release.add_permits(64),
        ProbeEnd::Shutdown => {
            timeout(Duration::from_secs(2), handle.shutdown())
                .await
                .expect("held probe must not block shutdown");
            assert_released_on_retained_connection(&mut retained, &before_exit).await;
            assert_eq!(peer.probe_release.available_permits(), 0);
            upstream.abort();
            let _ = upstream.await;
            return;
        }
        ProbeEnd::Exec => {
            let preparation = timeout(Duration::from_secs(2), handle.prepare_exec_attempt())
                .await
                .expect("held probe must not block exec preparation")
                .unwrap();
            drop(preparation);
            assert_released_on_retained_connection(&mut retained, &before_exit).await;
            assert_eq!(peer.probe_release.available_permits(), 0);
            let pool = cooldown_pool(&client, &base).await;
            assert_ne!(exact_probe(&pool)["state"], "probing");
            assert_eq!(
                exact_probe(&pool)["failure_count"],
                0,
                "cancellation is not a provider failure"
            );
            handle.shutdown().await;
            upstream.abort();
            let _ = upstream.await;
            return;
        }
        ProbeEnd::Drop => {
            drop(handle);
            assert_released_on_retained_connection(&mut retained, &before_exit).await;
            assert_eq!(peer.probe_release.available_permits(), 0);
            upstream.abort();
            let _ = upstream.await;
            return;
        }
    }
    timeout(Duration::from_secs(2), async {
        loop {
            let pool = cooldown_pool(&client, &base).await;
            if exact_probe(&pool)["state"] != "probing" {
                assert_eq!(exact_probe(&pool)["failure_count"], 1);
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("released 503 probe must complete and retain exact cooldown");
    // A pinned all-cooled target has no business response to deliver. Its failed
    // probe must leave health cooled while closing this request, not await a
    // future scheduled recovery. The watchdog is only a test cleanup boundary.
    let failure_client = client.clone();
    let failure_base = base.clone();
    let mut exhausted = tokio::spawn(async move {
        failure_client.post(format!("{failure_base}/v1/chat/completions"))
            .json(&json!({"model":"cooled.step-5-preview","messages":[{"role":"user","content":"all cooled marker"}],"stream":false}))
            .send().await
    });
    let exhausted_result = timeout(Duration::from_millis(500), &mut exhausted).await;
    let closed = matches!(&exhausted_result, Ok(Ok(Err(_))));
    eprintln!("public all-cooled witness: failed probe already captured, promptly closed={closed}");
    if exhausted_result.is_err() {
        exhausted.abort();
        let _ = exhausted.await;
    }
    let sibling = client.post(format!("{base}/v1/chat/completions"))
        .json(&json!({"model":"healthy.step-5-preview","messages":[{"role":"user","content":"sibling marker"}],"stream":false}))
        .send().await.unwrap();
    assert_eq!(sibling.status(), 200);
    let sibling_body: Value = sibling.json().await.unwrap();
    assert_eq!(
        sibling_body["choices"][0]["message"]["content"],
        "step5 complete"
    );
    if closed {
        let all_cooled_raw = raw_chat(port, "cooled.step-5-preview", "all cooled raw", false).await;
        eprintln!("all-cooled nonstream client bytes={}", all_cooled_raw.len());
        assert!(
            all_cooled_raw.is_empty(),
            "nonstream failure must close without HTTP status/body: {:?}",
            String::from_utf8_lossy(&all_cooled_raw)
        );
        let stream_raw = raw_chat(port, "cooled.step-5-preview", "all cooled stream", true).await;
        let stream_text = String::from_utf8_lossy(&stream_raw);
        eprintln!("all-cooled stream wire={stream_text:?}");
        assert!(
            !stream_text.contains("data:")
                && !stream_text.contains("[DONE]")
                && !stream_text.contains("event: error")
                && !stream_text.contains("503"),
            "failure SSE must carry no business/error terminal: {stream_text}"
        );
        let forbidden_raw = raw_chat(
            port,
            "healthy.step-5-preview",
            "upstream failure marker",
            false,
        )
        .await;
        eprintln!("actual upstream403 client bytes={}", forbidden_raw.len());
        assert!(
            forbidden_raw.is_empty(),
            "real provider403 must remain internal, with no client wrapper: {:?}",
            String::from_utf8_lossy(&forbidden_raw)
        );
        assert!(
            peer.captures
                .lock()
                .await
                .iter()
                .any(|v| v["messages"][0]["content"] == "upstream failure marker"),
            "real403 must be triggered through actual provider transport"
        );
        let recovered_sibling = client.post(format!("{base}/v1/chat/completions"))
            .json(&json!({"model":"healthy.step-5-preview","messages":[{"role":"user","content":"after failure sibling"}],"stream":false}))
            .send().await.unwrap();
        assert_eq!(recovered_sibling.status(), 200);
        assert_eq!(
            recovered_sibling.json::<Value>().await.unwrap()["choices"][0]["message"]["content"],
            "step5 complete"
        );
    }
    let pool: Value = client
        .get(format!("{base}/_routecodex/health/cooldown-pool"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(pool["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["provider_id"] == "cooled" && v["model_id"] == "step-5-preview"));
    assert!(!pool["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v["provider_id"] == "healthy"));
    handle.shutdown().await;
    upstream.abort();
    let _ = upstream.await;
    assert!(closed, "all-cooled failed probe waited for future recovery instead of closing the exhausted request");
    if require_pending_healthy_progress {
        assert!(attempted_before_release, "healthy Step5 was blocked by the owned pending rescue probe; releasing that probe restored the same request");
    }
}

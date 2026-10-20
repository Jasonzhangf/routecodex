//! Public port-local provider health acceptance for issue d9fd985.
//!
//! command:
//!   node v3/scripts/run-v3-cargo-test.mjs -p routecodex-v3-server \
//!     --test issued9fd985_port_local_health -- --nocapture
//!
//! The tests use two real HTTP listeners in one aggregate and a controlled
//! upstream. Every mutating business request has a spare eligible candidate so
//! the failure is allowed to update provider health and switch candidates.

use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::Response,
    routing::post,
    Json, Router,
};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_server::{spawn_v3_server_aggregate, V3ServerAggregateHandle};
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
};
use tokio::{
    sync::{oneshot, Mutex, Semaphore},
    time::{sleep, timeout, Duration},
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;

#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;

use test_ports::free_port;

static TEST_LOCK: Mutex<()> = Mutex::const_new(());

const KEY_ENV: &str = "V3_D9FD985_KEY";
const SIBLING_ENV: &str = "V3_D9FD985_SIBLING";
const KEY_SECRET: &str = "d9fd985-key-secret";
const SIBLING_SECRET: &str = "d9fd985-sibling-secret";

struct TestHomeGuard {
    previous: Option<OsString>,
    path: PathBuf,
}

impl TestHomeGuard {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "rcc-d9fd985-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("create test home");
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
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

struct EnvGuard {
    name: &'static str,
    previous: Option<OsString>,
}

impl EnvGuard {
    fn unset(name: &'static str) -> Self {
        let previous = std::env::var_os(name);
        std::env::remove_var(name);
        Self { name, previous }
    }
    fn set(name: &'static str, value: &str) -> Self {
        let previous = std::env::var_os(name);
        std::env::set_var(name, value);
        Self { name, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        match &self.previous {
            Some(value) => std::env::set_var(self.name, value),
            None => std::env::remove_var(self.name),
        }
    }
}

struct UpstreamState {
    business: AtomicUsize,
    probes: AtomicUsize,
    probe_success: AtomicBool,
    hold_probe: AtomicBool,
    probe_entered: Semaphore,
    probe_release: Semaphore,
    fail_main: bool,
}

impl UpstreamState {
    fn new(fail_main: bool, probe_success: bool) -> Self {
        Self {
            business: AtomicUsize::new(0),
            probes: AtomicUsize::new(0),
            probe_success: AtomicBool::new(probe_success),
            hold_probe: AtomicBool::new(false),
            probe_entered: Semaphore::new(0),
            probe_release: Semaphore::new(0),
            fail_main,
        }
    }

    fn business_count(&self) -> usize {
        self.business.load(Ordering::SeqCst)
    }

    fn probe_count(&self) -> usize {
        self.probes.load(Ordering::SeqCst)
    }
}

fn success_body() -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "id": "resp_d9fd985",
                "object": "response",
                "status": "completed",
                "output": [{
                    "type": "message",
                    "id": "msg_d9fd985",
                    "role": "assistant",
                    "status": "completed",
                    "content": [{
                        "type": "output_text",
                        "text": "upstream-ok",
                        "annotations": []
                    }]
                }]
            })
            .to_string(),
        ))
        .expect("build success response")
}

fn failure_body() -> Response<Body> {
    Response::builder()
        .status(StatusCode::INTERNAL_SERVER_ERROR)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({
                "error": {
                    "type": "server_error",
                    "code": "server_error",
                    "message": "controlled real upstream failure"
                }
            })
            .to_string(),
        ))
        .expect("build failure response")
}

fn is_probe(body: &Value) -> bool {
    body["input"]
        .as_array()
        .and_then(|items| items.first())
        .and_then(|item| item["content"].as_array())
        .and_then(|content| content.first())
        .and_then(|part| part["text"].as_str())
        == Some("ping; reply pong")
}

async fn upstream(
    State(state): State<Arc<UpstreamState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response<Body> {
    if is_probe(&body) {
        state.probes.fetch_add(1, Ordering::SeqCst);
        if state.hold_probe.load(Ordering::SeqCst) {
            state.probe_entered.add_permits(1);
            let _release = state
                .probe_release
                .acquire()
                .await
                .expect("probe release semaphore");
        }
        return if state.probe_success.load(Ordering::SeqCst) {
            success_body()
        } else {
            failure_body()
        };
    }

    state.business.fetch_add(1, Ordering::SeqCst);
    let model = body["model"].as_str().unwrap_or_default();
    let authorization = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let is_cross_port_isolation_request = body["input"].as_str() == Some("other-port-same-key");
    if model == "main"
        && state.fail_main
        && authorization.contains(KEY_SECRET)
        && !is_cross_port_isolation_request
    {
        failure_body()
    } else {
        success_body()
    }
}

async fn start_upstream(
    fail_main: bool,
    probe_success: bool,
) -> (String, Arc<UpstreamState>, oneshot::Sender<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind controlled upstream");
    let address = listener.local_addr().expect("upstream address");
    let state = Arc::new(UpstreamState::new(fail_main, probe_success));
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/responses", post(upstream))
        .with_state(Arc::clone(&state));
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .expect("serve controlled upstream");
    });
    (format!("http://{address}/v1"), state, shutdown_tx)
}

fn port_manifest(
    port_a: u16,
    port_b: u16,
    primary_base_url: &str,
    spare_base_url: &str,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let execution_a = hub_v1_fixture::hub_v1_server_execution("a");
    let execution_b = hub_v1_fixture::hub_v1_server_execution("b");
    let source = format!(
        r#"
version = 3
{declaration}
[servers.a]
bind = "127.0.0.1"
port = {port_a}
routing_group = "port"
endpoints = ["responses"]
{execution_a}
[servers.b]
bind = "127.0.0.1"
port = {port_b}
routing_group = "port"
endpoints = ["responses"]
{execution_b}
[providers.primary]
default_model = "main"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{KEY_ENV}" }}, {{ alias = "sibling", env = "{SIBLING_ENV}" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 60000, probe_interval_ms = 60000 }}
[providers.primary.models.main]
wire_name = "main"
[providers.primary.models.other]
wire_name = "other"
[providers.primary.interfaces.responses]
type = "responses"
base_url = "{primary_base_url}"
[providers.spare]
type = "responses"
base_url = "{spare_base_url}"
default_model = "main"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "{KEY_ENV}" }}] }}
[providers.spare.models.main]
wire_name = "main"
[forwarders.responses]
model = "main"
aliases = ["client-test"]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "primary", model = "main", key = "key", interface = "responses", priority = 100 }},
  {{ kind = "provider_model", provider = "spare", model = "main", key = "key", priority = 1 }}
]
[forwarders.other]
model = "other"
aliases = ["other-test"]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "primary", model = "other", key = "key", interface = "responses", priority = 100 }}]
[forwarders.sibling]
model = "main"
aliases = ["sibling-test"]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "primary", model = "main", key = "sibling", interface = "responses", priority = 100 }}]
[route_groups.port.pools.client_test]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, models = ["client-test"] }}
targets = [{{ kind = "forwarder", id = "responses", priority = 1 }}]
[route_groups.port.pools.other]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, models = ["other-test"] }}
targets = [{{ kind = "forwarder", id = "other", priority = 1 }}]
[route_groups.port.pools.sibling]
selection = {{ strategy = "priority" }}
match = {{ precedence = 10, models = ["sibling-test"] }}
targets = [{{ kind = "forwarder", id = "sibling", priority = 1 }}]
[route_groups.port.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "forwarder", id = "responses", priority = 1 }}]
[debug]
log_console = true
snapshots = false
codex_samples = false
"#
    );
    compile_v3_config_05_manifest(parse_v3_config_02_authoring(&source).unwrap()).unwrap()
}

fn listener_base(handle: &V3ServerAggregateHandle, server_id: &str) -> String {
    format!(
        "http://{}",
        handle
            .listeners
            .iter()
            .find(|listener| listener.server_id == server_id)
            .expect("configured listener")
            .addr
    )
}

async fn business_request(
    client: &reqwest::Client,
    base: &str,
    model: &str,
    input: &str,
) -> (u16, String) {
    let response = match timeout(
        Duration::from_secs(5),
        client
            .post(format!("{base}/v1/responses"))
            .json(&json!({"model": model, "input": input, "stream": false}))
            .send(),
    )
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => panic!("business request {model} {input:?} transport: {error}"),
        Err(error) => panic!("business request {model} {input:?} did not finish: {error}"),
    };
    let status = response.status().as_u16();
    let body = response.text().await.expect("business body");
    (status, body)
}

async fn cooldown_entries(client: &reqwest::Client, base: &str) -> Vec<Value> {
    let response = client
        .get(format!("{base}/_routecodex/health/cooldown-pool"))
        .send()
        .await
        .expect("cooldown pool request");
    assert_eq!(response.status(), 200);
    response.json::<Value>().await.expect("cooldown pool JSON")["entries"]
        .as_array()
        .expect("cooldown entries")
        .clone()
}

fn exact_primary_entry(entries: &[Value]) -> Option<&Value> {
    entries.iter().find(|entry| {
        entry["provider_id"] == "primary"
            && entry["interface_id"] == "responses"
            && entry["auth_alias"] == "key"
            && entry["model_id"] == "main"
            && entry["kind"] == "probe"
    })
}

async fn add_probe_cooldown(client: &reqwest::Client, base: &str, duration_ms: u64) {
    let response = client
        .post(format!("{base}/_routecodex/health/cooldown-pool/add"))
        .json(&json!({
            "provider_id": "primary",
            "interface_id": "responses",
            "auth_alias": "key",
            "model_id": "main",
            "kind": "probe",
            "duration_ms": duration_ms
        }))
        .send()
        .await
        .expect("add cooldown");
    assert_eq!(response.status(), 200);
}

async fn trigger_probe(client: &reqwest::Client, base: &str) {
    let response = client
        .post(format!("{base}/_routecodex/health/cooldown-pool/probe"))
        .json(&json!({
            "provider_id": "primary",
            "interface_id": "responses",
            "auth_alias": "key",
            "model_id": "main"
        }))
        .send()
        .await
        .expect("trigger probe");
    assert_eq!(response.status(), 200);
    let body: Value = response.json().await.expect("probe response JSON");
    assert_eq!(body["scheduled"], true);
}

async fn wait_until<F, Fut>(label: &str, mut predicate: F)
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    timeout(Duration::from_secs(8), async {
        loop {
            if predicate().await {
                return;
            }
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for {label}"));
}

async fn wait_for_port_release(port: u16) {
    timeout(Duration::from_secs(4), async {
        loop {
            match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
                Ok(listener) => {
                    drop(listener);
                    return;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
                    sleep(Duration::from_millis(20)).await;
                }
                Err(error) => panic!("check listener release on {port}: {error}"),
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("timed out waiting for listener port {port} release"));
}

#[tokio::test]
async fn id9_failure_cooldown_is_port_local() {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("failure");
    let _key = EnvGuard::set(KEY_ENV, KEY_SECRET);
    let _sibling = EnvGuard::set(SIBLING_ENV, SIBLING_SECRET);
    let (primary_base, primary, primary_shutdown) = start_upstream(true, false).await;
    let (spare_base, spare, spare_shutdown) = start_upstream(false, true).await;
    let handle = spawn_v3_server_aggregate(port_manifest(
        free_port(),
        free_port(),
        &primary_base,
        &spare_base,
    ))
    .await
    .expect("spawn two-listener aggregate");
    let base_a = listener_base(&handle, "a");
    let base_b = listener_base(&handle, "b");
    // Rebuilds reuse the same listen address. Never let reqwest keep an idle
    // connection to the previous aggregate, or the next assertion would read
    // the old in-memory store instead of the newly spawned listener.
    let client = reqwest::Client::builder()
        .pool_max_idle_per_host(0)
        .build()
        .expect("build isolation client");

    for index in 0..3 {
        let (status, body) =
            business_request(&client, &base_a, "client-test", &format!("port-a-{index}")).await;
        assert_eq!(status, 200, "spare candidate must answer: {body}");
        assert!(body.contains("upstream-ok"), "{body}");
    }
    assert!(
        primary.business_count() > 0,
        "the primary candidate must receive the failed attempts"
    );
    assert!(
        spare.business_count() > 0,
        "the spare candidate must answer the switched attempts"
    );

    let entries_a = cooldown_entries(&client, &base_a).await;
    let exact = exact_primary_entry(&entries_a).expect("port A exact cooldown must exist");
    assert!(
        matches!(
            exact["state"].as_str(),
            Some("blocked" | "waiting" | "probing")
        ),
        "{entries_a:?}"
    );
    assert_eq!(
        entries_a.len(),
        1,
        "port A must cool only the failed complete identity: {entries_a:?}"
    );
    let entries_b = cooldown_entries(&client, &base_b).await;
    assert!(
        entries_b.is_empty(),
        "port B must not inherit port A health: {entries_b:?}"
    );

    let primary_before_other = primary.business_count();
    let (status, body) =
        business_request(&client, &base_a, "other-test", "other model isolation").await;
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("upstream-ok"), "{body}");
    assert_eq!(
        primary.business_count(),
        primary_before_other + 1,
        "the other model must still reach the primary provider"
    );

    let primary_before_sibling = primary.business_count();
    let (status, body) =
        business_request(&client, &base_a, "sibling-test", "sibling key isolation").await;
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("upstream-ok"), "{body}");
    assert_eq!(
        primary.business_count(),
        primary_before_sibling + 1,
        "the sibling auth key must still reach the primary provider"
    );

    let primary_before_b = primary.business_count();
    let (status, body) =
        business_request(&client, &base_b, "client-test", "port-b-reaches-primary").await;
    assert_eq!(status, 200, "{body}");
    assert!(
        primary.business_count() > primary_before_b,
        "port B must still dispatch the same identity to the primary provider"
    );

    handle.shutdown().await;
    let _ = primary_shutdown.send(());
    let _ = spare_shutdown.send(());
}

#[tokio::test]
async fn id9_probe_outcomes_are_port_local() {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("probe");
    let _key = EnvGuard::set(KEY_ENV, KEY_SECRET);
    let _sibling = EnvGuard::set(SIBLING_ENV, SIBLING_SECRET);
    let (primary_base, primary, primary_shutdown) = start_upstream(true, false).await;
    let (spare_base, _spare, spare_shutdown) = start_upstream(false, true).await;
    let handle = spawn_v3_server_aggregate(port_manifest(
        free_port(),
        free_port(),
        &primary_base,
        &spare_base,
    ))
    .await
    .expect("spawn two-listener aggregate");
    let base_a = listener_base(&handle, "a");
    let base_b = listener_base(&handle, "b");
    let client = reqwest::Client::new();

    // Drive one real primary failure on port A. The spare candidate answers,
    // so this failure is allowed to cool the exact primary identity on port A.
    let (status, body) = business_request(&client, &base_a, "client-test", "probe-a-failure").await;
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("upstream-ok"), "{body}");
    wait_until("port A exact cooldown", || async {
        exact_primary_entry(&cooldown_entries(&client, &base_a).await).is_some()
    })
    .await;
    assert!(
        exact_primary_entry(&cooldown_entries(&client, &base_b).await).is_none(),
        "port B must not inherit port A failure state: {:?}",
        cooldown_entries(&client, &base_b).await
    );

    trigger_probe(&client, &base_a).await;
    wait_until("port A failed probe", || async {
        primary.probe_count() >= 1
    })
    .await;
    wait_until("port A failed probe health", || async {
        exact_primary_entry(&cooldown_entries(&client, &base_a).await)
            .is_some_and(|entry| entry["failure_count"].as_u64() == Some(1))
    })
    .await;
    assert!(
        exact_primary_entry(&cooldown_entries(&client, &base_b).await).is_none(),
        "port A failed probe must not mutate port B: {:?}",
        cooldown_entries(&client, &base_b).await
    );

    primary.probe_success.store(true, Ordering::SeqCst);
    trigger_probe(&client, &base_a).await;
    wait_until("port A recovery probe", || async {
        primary.probe_count() >= 2
    })
    .await;
    wait_until("port A recovery", || async {
        exact_primary_entry(&cooldown_entries(&client, &base_a).await).is_none()
    })
    .await;
    assert!(
        exact_primary_entry(&cooldown_entries(&client, &base_b).await).is_none(),
        "port B must stay untouched by port A recovery: {:?}",
        cooldown_entries(&client, &base_b).await
    );
    assert_eq!(
        primary.probe_count(),
        2,
        "each manual trigger must create exactly one probe on its own port"
    );

    handle.shutdown().await;
    let _ = primary_shutdown.send(());
    let _ = spare_shutdown.send(());
}

#[tokio::test]
async fn id9_exact_identity_isolation() {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("exact-identity");
    let _key = EnvGuard::set(KEY_ENV, KEY_SECRET);
    let _sibling = EnvGuard::set(SIBLING_ENV, SIBLING_SECRET);
    let (primary_base, primary, primary_shutdown) = start_upstream(true, false).await;
    let (spare_base, _spare, spare_shutdown) = start_upstream(false, true).await;
    let handle = spawn_v3_server_aggregate(port_manifest(
        free_port(),
        free_port(),
        &primary_base,
        &spare_base,
    ))
    .await
    .expect("spawn two-listener aggregate");
    let base_a = listener_base(&handle, "a");
    let base_b = listener_base(&handle, "b");
    let client = reqwest::Client::new();

    let (status, body) =
        business_request(&client, &base_a, "client-test", "exact-primary-failure").await;
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("upstream-ok"), "{body}");
    wait_until("exact primary cooldown", || async {
        exact_primary_entry(&cooldown_entries(&client, &base_a).await).is_some()
    })
    .await;
    let entries_a = cooldown_entries(&client, &base_a).await;
    assert_eq!(entries_a.len(), 1, "{entries_a:?}");
    assert!(
        matches!(
            entries_a[0]["state"].as_str(),
            Some("blocked" | "waiting" | "probing")
        ),
        "{entries_a:?}"
    );

    let primary_before_other = primary.business_count();
    let (status, body) =
        business_request(&client, &base_a, "other-test", "same-port-other-model").await;
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("upstream-ok"), "{body}");
    assert_eq!(
        primary.business_count(),
        primary_before_other + 1,
        "the other model on the failing port must remain dispatchable"
    );

    let primary_before_sibling = primary.business_count();
    let (status, body) =
        business_request(&client, &base_a, "sibling-test", "same-port-other-key").await;
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("upstream-ok"), "{body}");
    assert_eq!(
        primary.business_count(),
        primary_before_sibling + 1,
        "the sibling auth key on the failing port must remain dispatchable"
    );

    let primary_before_port_b = primary.business_count();
    let (status, body) =
        business_request(&client, &base_b, "client-test", "other-port-same-key").await;
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("upstream-ok"), "{body}");
    assert_eq!(
        primary.business_count(),
        primary_before_port_b + 1,
        "the same complete identity on port B must remain dispatchable"
    );

    let entries_a_after = cooldown_entries(&client, &base_a).await;
    assert_eq!(entries_a_after.len(), 1, "{entries_a_after:?}");
    let exact_after = exact_primary_entry(&entries_a_after).expect("exact cooldown remains");
    assert!(
        matches!(
            exact_after["state"].as_str(),
            Some("blocked" | "waiting" | "probing")
        ),
        "{entries_a_after:?}"
    );
    assert!(
        cooldown_entries(&client, &base_b).await.is_empty(),
        "port B must not inherit the exact identity failure"
    );

    handle.shutdown().await;
    let _ = primary_shutdown.send(());
    let _ = spare_shutdown.send(());
}

fn seed_legacy_shared_file(path: &Path) -> Vec<u8> {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system time")
        .as_millis() as u64;
    let bytes = serde_json::to_vec_pretty(&json!({
        "schema_version": 3,
        "entries": [[
            {
                "provider_id": "primary",
                "interface_id": "responses",
                "auth_alias": "key",
                "model_id": "main",
                "failure_class": "Semantic"
            },
            {
                "blocked_until_ms": now_ms + 600_000,
                "next_probe_at_ms": now_ms + 600_000,
                "probe_in_flight": false
            }
        ]]
    }))
    .expect("legacy file JSON");
    std::fs::write(path, &bytes).expect("write legacy shared file");
    bytes
}

fn scoped_files_in(directory: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(directory)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
        .collect()
}

#[tokio::test]
async fn id9_persistence_rebuild_is_port_local_with_explicit_override() {
    persistence_rebuild(true).await;
}

#[tokio::test]
async fn id9_persistence_rebuild_is_port_local_with_default_path() {
    persistence_rebuild(false).await;
}

async fn persistence_rebuild(explicit_override: bool) {
    let _guard = TEST_LOCK.lock().await;
    let home = TestHomeGuard::new("persistence");
    let _key = EnvGuard::set(KEY_ENV, KEY_SECRET);
    let _sibling = EnvGuard::set(SIBLING_ENV, SIBLING_SECRET);
    let override_path = if explicit_override {
        home.path.join("legacy-shared.json")
    } else {
        home.path.join(".rcc/state/provider-cooldowns.json")
    };
    std::fs::create_dir_all(override_path.parent().unwrap()).unwrap();
    let seeded_bytes = seed_legacy_shared_file(&override_path);
    let _override = if explicit_override {
        EnvGuard::set(
            "ROUTECODEX_V3_PROVIDER_COOLDOWN_STATE",
            override_path.to_str().unwrap(),
        )
    } else {
        EnvGuard::unset("ROUTECODEX_V3_PROVIDER_COOLDOWN_STATE")
    };
    let (primary_base, primary, primary_shutdown) = start_upstream(true, false).await;
    let (spare_base, _spare, spare_shutdown) = start_upstream(false, true).await;
    let port_a = free_port();
    let port_b = free_port();
    let manifest = port_manifest(port_a, port_b, &primary_base, &spare_base);

    let first = spawn_v3_server_aggregate(manifest.clone())
        .await
        .expect("spawn first two-listener aggregate");
    let base_a = listener_base(&first, "a");
    let base_b = listener_base(&first, "b");
    let client = reqwest::Client::builder()
        .pool_max_idle_per_host(0)
        .build()
        .expect("build rebuild client");

    assert!(
        cooldown_entries(&client, &base_a).await.is_empty(),
        "a shared legacy file has no port provenance and must not seed port A"
    );
    assert!(
        cooldown_entries(&client, &base_b).await.is_empty(),
        "a shared legacy file has no port provenance and must not seed port B"
    );
    assert_eq!(
        std::fs::read(&override_path).expect("read preserved override"),
        seeded_bytes,
        "the unowned legacy file must be preserved unchanged"
    );

    add_probe_cooldown(&client, &base_a, 600_000).await;
    assert!(
        cooldown_entries(&client, &base_b).await.is_empty(),
        "port A operator cooldown must not appear in port B"
    );
    first.shutdown().await;
    wait_for_port_release(port_a).await;
    wait_for_port_release(port_b).await;

    let scoped_files = scoped_files_in(override_path.parent().unwrap());
    assert!(
        scoped_files.len() >= 2,
        "multi-listener persistence must create per-port state files: {scoped_files:?}"
    );

    let second = spawn_v3_server_aggregate(manifest.clone())
        .await
        .expect("rebuild two-listener aggregate");
    let base_a = listener_base(&second, "a");
    let base_b = listener_base(&second, "b");
    let entries_a = cooldown_entries(&client, &base_a).await;
    assert!(
        exact_primary_entry(&entries_a).is_some(),
        "port A must restore its own persisted cooldown: {entries_a:?}"
    );
    assert!(
        cooldown_entries(&client, &base_b).await.is_empty(),
        "port B must not inherit port A persisted cooldown"
    );
    wait_until("restart startup probe settles", || async {
        primary.probe_count() >= 1
            && exact_primary_entry(&cooldown_entries(&client, &base_a).await)
                .is_some_and(|entry| entry["state"] != "probing")
    })
    .await;
    assert_eq!(
        std::fs::read(&override_path).expect("read preserved override after rebuild"),
        seeded_bytes
    );

    second.shutdown().await;
    wait_for_port_release(port_a).await;
    wait_for_port_release(port_b).await;

    // The next rebuild lets port A run its own recovery probe. Only port A
    // owns the restored record, so only port A may clear it.
    primary.probe_success.store(true, Ordering::SeqCst);
    let third = spawn_v3_server_aggregate(manifest)
        .await
        .expect("rebuild two-listener aggregate for recovery");
    let base_a = listener_base(&third, "a");
    let base_b = listener_base(&third, "b");
    let probes_before_recovery = primary.probe_count();
    if timeout(Duration::from_secs(8), async {
        loop {
            if exact_primary_entry(&cooldown_entries(&client, &base_a).await).is_none() {
                return;
            }
            sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .is_err()
    {
        let entries = cooldown_entries(&client, &base_a).await;
        panic!(
            "port A restored cooldown recovery timed out; probes_before={probes_before_recovery} probes_after={} entries={:?}",
            primary.probe_count(),
            entries
        );
    }
    assert!(
        cooldown_entries(&client, &base_b).await.is_empty(),
        "port A recovery must leave port B untouched"
    );

    third.shutdown().await;
    let _ = primary_shutdown.send(());
    let _ = spare_shutdown.send(());
}

#[tokio::test]
async fn id9_lifecycle_releases_all_port_owners() {
    let _guard = TEST_LOCK.lock().await;
    let _home = TestHomeGuard::new("lifecycle");
    let _key = EnvGuard::set(KEY_ENV, KEY_SECRET);
    let _sibling = EnvGuard::set(SIBLING_ENV, SIBLING_SECRET);
    let (primary_base, primary, primary_shutdown) = start_upstream(false, true).await;
    let (spare_base, _spare, spare_shutdown) = start_upstream(false, true).await;
    primary.hold_probe.store(true, Ordering::SeqCst);
    let handle = spawn_v3_server_aggregate(port_manifest(
        free_port(),
        free_port(),
        &primary_base,
        &spare_base,
    ))
    .await
    .expect("spawn two-listener aggregate");
    let base_a = listener_base(&handle, "a");
    let base_b = listener_base(&handle, "b");
    let client = reqwest::Client::new();

    add_probe_cooldown(&client, &base_a, 600_000).await;
    add_probe_cooldown(&client, &base_b, 600_000).await;
    let original_a = exact_primary_entry(&cooldown_entries(&client, &base_a).await)
        .expect("port A original cooldown")
        .clone();
    let original_b = exact_primary_entry(&cooldown_entries(&client, &base_b).await)
        .expect("port B original cooldown")
        .clone();

    trigger_probe(&client, &base_a).await;
    trigger_probe(&client, &base_b).await;
    timeout(
        Duration::from_secs(4),
        primary.probe_entered.acquire_many(2),
    )
    .await
    .expect("both port-owned probes must enter the controlled upstream")
    .expect("probe entry semaphore")
    .forget();
    assert_eq!(primary.probe_count(), 2, "each port owns exactly one probe");
    assert_eq!(
        exact_primary_entry(&cooldown_entries(&client, &base_a).await).expect("port A held probe")
            ["state"],
        "probing"
    );
    assert_eq!(
        exact_primary_entry(&cooldown_entries(&client, &base_b).await).expect("port B held probe")
            ["state"],
        "probing"
    );

    let preparation = timeout(Duration::from_secs(3), handle.prepare_exec_attempt())
        .await
        .expect("held probes must not block aggregate preparation")
        .expect("aggregate preparation");
    wait_until("both port probe owners quiesce", || async {
        let entry_a = exact_primary_entry(&cooldown_entries(&client, &base_a).await).cloned();
        let entry_b = exact_primary_entry(&cooldown_entries(&client, &base_b).await).cloned();
        entry_a.is_some_and(|entry| entry["state"] != "probing")
            && entry_b.is_some_and(|entry| entry["state"] != "probing")
    })
    .await;
    drop(preparation);
    let rolled_back_a = exact_primary_entry(&cooldown_entries(&client, &base_a).await)
        .expect("port A cooldown retained after rollback")
        .clone();
    let rolled_back_b = exact_primary_entry(&cooldown_entries(&client, &base_b).await)
        .expect("port B cooldown retained after rollback")
        .clone();
    assert_eq!(rolled_back_a["provider_id"], original_a["provider_id"]);
    assert_eq!(rolled_back_b["provider_id"], original_b["provider_id"]);
    assert_eq!(
        primary.probe_release.available_permits(),
        0,
        "aborted probes must not release the controlled upstream"
    );

    wait_until("both port probe owners resume", || async {
        exact_primary_entry(&cooldown_entries(&client, &base_a).await)
            .is_some_and(|entry| entry["state"] == "probing")
            && exact_primary_entry(&cooldown_entries(&client, &base_b).await)
                .is_some_and(|entry| entry["state"] == "probing")
    })
    .await;
    assert_eq!(
        primary.probe_count(),
        4,
        "rollback must resume exactly one probe per port, not duplicate owners"
    );

    for base in [&base_a, &base_b] {
        let (status, body) =
            business_request(&client, base, "client-test", "business-after-rollback").await;
        assert_eq!(status, 200, "{body}");
        assert!(body.contains("upstream-ok"), "{body}");
    }

    primary.probe_release.add_permits(64);
    wait_until("both restored probes recover", || async {
        exact_primary_entry(&cooldown_entries(&client, &base_a).await).is_none()
            && exact_primary_entry(&cooldown_entries(&client, &base_b).await).is_none()
    })
    .await;

    handle.shutdown().await;
    let _ = primary_shutdown.send(());
    let _ = spare_shutdown.send(());
}

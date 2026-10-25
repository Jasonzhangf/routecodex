//! Manual cooldown actions on a real managed listener.
//!
//! These exercise the loopback-only `/_routecodex/health/cooldown-pool/add` and
//! `/probe` endpoints through a genuinely spawned aggregate listener rather than
//! a hand-built router, so the route table, the loopback guard and the store
//! wiring are all the production ones. Harness shape follows
//! `admin_webui_managed.rs`: temp `HOME`, compiled authoring config, real
//! listener on a free port, assertions read back over HTTP.
//!
//! Probe state is seeded through the public `/add` endpoint instead of poking
//! the store, because the aggregate handle deliberately keeps its
//! `provider_health` handle private. That is also the honest path: the operator
//! creates a manual cooldown, then asks for a probe on it.

use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Json, Router,
};
use routecodex_v3_config::V3ConfigStore;
use routecodex_v3_server::spawn_v3_server_aggregate_with_admin;
use serde_json::{json, Value};
use std::{collections::BTreeMap, env, fs, path::PathBuf, sync::Arc};
use tokio::{
    sync::{oneshot, Mutex},
    time::{sleep, timeout, Duration},
};

static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn temp_home(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "rcc-cooldown-manual-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;
use test_ports::free_port;

#[path = "support/cooldown_probe_binary_state.rs"]
mod cooldown_probe_binary_state;

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;

fn config_source(server_port: u16) -> String {
    format!(
        r#"
version = 3

[servers.main]
bind = "127.0.0.1"
port = {server_port}
routing_group = "default"
endpoints = ["responses"]

[providers.test]
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_COOLDOWN_MANUAL_TEST_KEY" }}] }}

[providers.test.interfaces.default]
type = "responses"
base_url = "http://127.0.0.1:9/v1"

[providers.test.interfaces.chat]
type = "openai_chat"
base_url = "http://127.0.0.1:9/v1"

[providers.test.models.test]

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "test", model = "test", key = "key", priority = 1 }}]
"#
    )
}

/// A spawned aggregate listener plus the temp `HOME` it was built under.
struct Managed {
    handle: Option<routecodex_v3_server::V3ServerAggregateHandle>,
    base: String,
    listener_port: u16,
    admin_base: Option<String>,
    home: PathBuf,
    previous_home: Option<std::ffi::OsString>,
}

impl Managed {
    async fn start(label: &str) -> Self {
        Self::start_inner(label, false).await
    }

    /// Same aggregate, but with the admin WebUI listener enabled so the admin
    /// proxy can be exercised against the real listener inside one process.
    async fn start_admin(label: &str) -> Self {
        Self::start_inner(label, true).await
    }

    async fn start_inner(label: &str, with_admin: bool) -> Self {
        Self::start_source(label, with_admin, config_source).await
    }

    async fn start_source(
        label: &str,
        with_admin: bool,
        source: impl FnOnce(u16) -> String,
    ) -> Self {
        std::env::set_var("V3_COOLDOWN_MANUAL_TEST_KEY", "controlled-secret");
        std::env::remove_var("ROUTECODEX_V3_ADMIN_BIND");
        // These cases count upstream attempts and health probes, so the Chat
        // Process continuation must not add an extra execution.
        routecodex_v3_config::internal::v3_test_only_set_chat_process_refill_max_override(Some(0));
        let home = temp_home(label);
        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home);
        let config_path = home.join("config.v3.toml");
        let server_port = free_port();
        let source = if with_admin {
            format!(
                "{}\n[admin_webui]\nenabled = true\nbind = \"127.0.0.1\"\nport = {}\n",
                source(server_port),
                free_port()
            )
        } else {
            source(server_port)
        };
        fs::write(&config_path, source).unwrap();

        let snapshot = V3ConfigStore::new(&config_path)
            .load_snapshot_with_source_identity()
            .unwrap();
        let handle = spawn_v3_server_aggregate_with_admin(
            snapshot.manifest,
            snapshot.admin_webui,
            Some(config_path),
        )
        .await
        .unwrap();
        let listener = handle
            .listeners
            .iter()
            .find(|listener| listener.server_id == "main")
            .expect("aggregate handle exposes the configured server listener");
        let base = format!("http://{}", listener.addr);
        let listener_port = listener.addr.port();
        let admin_base = handle
            .listeners
            .iter()
            .find(|listener| listener.server_id == "admin_webui")
            .map(|listener| format!("http://{}", listener.addr));
        // Let the listeners accept before the first request.
        sleep(Duration::from_millis(50)).await;
        Self {
            handle: Some(handle),
            base,
            listener_port,
            admin_base,
            home,
            previous_home,
        }
    }

    async fn finish(mut self) {
        if let Some(handle) = self.handle.take() {
            handle.shutdown().await;
        }
    }

    fn pool_url(&self) -> String {
        format!("{}/_routecodex/health/cooldown-pool", self.base)
    }

    fn add_url(&self) -> String {
        format!("{}/_routecodex/health/cooldown-pool/add", self.base)
    }

    fn probe_url(&self) -> String {
        format!("{}/_routecodex/health/cooldown-pool/probe", self.base)
    }
}

impl Drop for Managed {
    fn drop(&mut self) {
        if let Some(previous) = self.previous_home.take() {
            env::set_var("HOME", previous);
        } else {
            env::remove_var("HOME");
        }
        let _ = fs::remove_dir_all(&self.home);
    }
}

async fn post_json(client: &reqwest::Client, url: String, body: Value) -> (u16, Value) {
    let response = client.post(url).json(&body).send().await.unwrap();
    let status = response.status().as_u16();
    let value = response.json::<Value>().await.unwrap_or(Value::Null);
    (status, value)
}

/// Admin mutating endpoints require the provisioned admin token.
async fn post_json_admin(
    client: &reqwest::Client,
    url: String,
    token: &str,
    body: Value,
) -> (u16, Value) {
    let response = client
        .post(url)
        .header("x-routecodex-admin-token", token)
        .json(&body)
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    let value = response.json::<Value>().await.unwrap_or(Value::Null);
    (status, value)
}

async fn pool_entries(client: &reqwest::Client, url: String) -> Vec<Value> {
    let response = client.get(url).send().await.unwrap();
    assert_eq!(response.status(), 200);
    let body = response.json::<Value>().await.unwrap();
    body["entries"].as_array().cloned().unwrap_or_default()
}

#[tokio::test]
async fn manual_add_is_visible_in_the_listener_cooldown_pool() {
    let _guard = TEST_LOCK.lock().await;
    let managed = Managed::start("add-visible").await;
    let client = reqwest::Client::new();

    let (status, body) = post_json(
        &client,
        managed.add_url(),
        json!({
            "provider_id": "test",
            "auth_alias": "key",
            "model_id": "test",
            "kind": "probe",
            "duration_ms": 60_000,
        }),
    )
    .await;
    assert_eq!(status, 200, "valid manual add must succeed: {body}");
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["applied"], json!("probe"));
    assert!(
        body["until_ms"].as_u64().is_some(),
        "until_ms must be reported"
    );

    let entries = pool_entries(&client, managed.pool_url()).await;
    let entry = entries
        .iter()
        .find(|entry| entry["provider_id"] == json!("test"))
        .expect("manual add must be projected by the listener pool");
    assert_eq!(entry["kind"], json!("probe"));
    assert_eq!(entry["interface_id"], json!("default"));
    assert_eq!(entry["model_id"], json!("test"));

    managed.finish().await;
}

/// HS05: bounded score 0 is an additional cooldown trigger on the real public
/// listener. A controlled loopback upstream lets the test drain the exact
/// provider/key/model identity to score 0 with real 429s, prove the exact-key
/// exclusion and sibling availability, then recover the identity through a valid
/// 2xx probe. Startup/probe receipts are counted apart from business attempts.
///
/// The failure pattern is `F F S` (two 429s, then one business success). The
/// success resets the failure streak, so the ordinary three-consecutive-429
/// threshold never fires; the only trigger that can cool here is the score
/// reaching 0 after `-5 -5 +1` per cycle.
#[tokio::test]
async fn zero_score_cooldown_excludes_exact_key_and_valid_probe_restores_it() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var("V3_COOLDOWN_MANUAL_TEST_KEY", "controlled-secret");

    // Controlled loopback upstream first so the config can point at it.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_port = listener.local_addr().unwrap().port();
    let upstream = Arc::new(ZeroUpstream::default());
    let (shutdown, stopped) = oneshot::channel::<()>();
    let app = Router::new()
        .route("/v1/responses", post(zero_provider))
        .route(
            "/fallback/v1/responses",
            post(|| async { zero_rejection() }),
        )
        .with_state(upstream.clone());
    let upstream_task = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
            .unwrap();
    });

    let managed =
        Managed::start_source("zero-score", false, |port| zero_config(port, upstream_port)).await;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .no_proxy()
        .build()
        .unwrap();
    let base = managed.base.clone();

    // Drain the exact identity to score 0. The `requests >= 20` guard fails loudly
    // if a cooldown appears from the three-consecutive-429 threshold instead.
    let mut requests = 0_u32;
    let mut cooled = false;
    'drive: for cycle in 0..16_u32 {
        for attempt in 0..2_u32 {
            let marker = format!("zero:fail-{cycle}-{attempt}");
            zero_fail(&client, &base, "test", &marker).await;
            zero_receipt(&upstream, &marker).await;
            requests += 1;
            if zero_is_cooled(&client, &base).await {
                assert!(
                    requests >= 20,
                    "cooldown after only {requests} requests must be the 3-429 threshold, not score 0"
                );
                cooled = true;
                break 'drive;
            }
        }
        let marker = format!("zero:ok-{cycle}");
        zero_success(&client, &base, "test", &marker).await;
        zero_receipt(&upstream, &marker).await;
        requests += 1;
    }
    assert!(
        cooled,
        "driving the exact identity to score 0 must admit its exact-key cooldown"
    );

    // The cooldown is bound to the exact identity; siblings stay out of the pool.
    let entries = pool_entries(&client, format!("{base}/_routecodex/health/cooldown-pool")).await;
    let exact = entries
        .iter()
        .find(|entry| {
            entry["provider_id"] == json!("test")
                && entry["auth_alias"] == json!("key")
                && entry["model_id"] == json!("test")
        })
        .unwrap_or_else(|| {
            panic!("the exact provider/key/model identity must be cooled: {entries:?}")
        });
    let interface_id = exact["interface_id"]
        .as_str()
        .unwrap_or("default")
        .to_string();
    assert!(
        !entries
            .iter()
            .any(|entry| entry["model_id"] == json!("sibling")),
        "the sibling model must not be cooled: {entries:?}"
    );
    assert!(
        !entries
            .iter()
            .any(|entry| entry["provider_id"] == json!("independent")),
        "the sibling provider must not be cooled: {entries:?}"
    );

    // The cooled identity receives no further business attempt.
    let blocked = "zero:blocked";
    zero_fail(&client, &base, "test", blocked).await;
    assert!(
        !upstream.business.lock().await.contains_key(blocked),
        "the cooled identity must not receive another business attempt"
    );

    // Siblings still answer while the exact identity is cooled.
    zero_success(&client, &base, "sibling", "zero:sibling-model").await;
    zero_receipt(&upstream, "zero:sibling-model").await;
    zero_success(&client, &base, "independent", "zero:sibling-provider").await;
    zero_receipt(&upstream, "zero:sibling-provider").await;

    // A matching valid 2xx probe restores the exact identity. The operator probe
    // only makes it due now; the runtime still runs it over the same provider wire.
    let probes_before = *upstream.probes.lock().await;
    let (status, body) = post_json(
        &client,
        managed.probe_url(),
        json!({
            "provider_id": "test",
            "interface_id": interface_id,
            "auth_alias": "key",
            "model_id": "test",
        }),
    )
    .await;
    assert_eq!(status, 200, "operator probe must be accepted: {body}");
    assert_eq!(
        body["scheduled"],
        json!(true),
        "the score-0 cooldown must carry probe state: {body}"
    );

    timeout(Duration::from_secs(15), async {
        loop {
            if *upstream.probes.lock().await > probes_before
                && !zero_is_cooled(&client, &base).await
            {
                break;
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("a valid 2xx probe must recover the exact identity");

    // The recovered identity routes again, and the server plus siblings stay alive.
    zero_success(&client, &base, "test", "zero:recovered").await;
    zero_receipt(&upstream, "zero:recovered").await;
    zero_success(&client, &base, "sibling", "zero:alive-after-recovery").await;
    zero_receipt(&upstream, "zero:alive-after-recovery").await;

    managed.finish().await;
    shutdown.send(()).unwrap();
    upstream_task.await.unwrap();
    std::env::remove_var("V3_COOLDOWN_MANUAL_TEST_KEY");
}

/// Controlled loopback upstream: probe traffic and business traffic are recorded
/// separately, and only business markers that ask for it return 429. The
/// separate fallback remains eligible so failed primary attempts may change
/// health under the last-candidate policy.
#[derive(Default)]
struct ZeroUpstream {
    business: Mutex<BTreeMap<String, usize>>,
    probes: Mutex<usize>,
}

async fn zero_provider(
    State(state): State<Arc<ZeroUpstream>>,
    Json(body): Json<Value>,
) -> Response<Body> {
    // A recovery probe carries an array input and the fixed probe text; a business
    // request carries its string marker. Keeping them apart is the whole point.
    let probe = body.get("input").map_or(false, serde_json::Value::is_array)
        || body.to_string().contains("ping; reply pong");
    if probe {
        *state.probes.lock().await += 1;
        return zero_ok("pong");
    }
    let marker = body["input"].as_str().unwrap_or("").to_string();
    *state
        .business
        .lock()
        .await
        .entry(marker.clone())
        .or_default() += 1;
    if marker.starts_with("zero:fail-") {
        return zero_rejection();
    }
    zero_ok(&marker)
}

fn zero_rejection() -> Response<Body> {
    Response::builder()
            .status(StatusCode::TOO_MANY_REQUESTS)
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"error":{"type":"rate_limit_error","code":"rate_limit_error","message":"controlled 429"}})
                    .to_string(),
            ))
            .unwrap()
}

fn zero_ok(text: &str) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"id":"resp-zero","object":"response","status":"completed",
            "output":[{"type":"message","id":"msg-zero","role":"assistant","status":"completed",
            "content":[{"type":"output_text","text":text,"annotations":[]}]}]})
            .to_string(),
        ))
        .unwrap()
}

async fn zero_fail(client: &reqwest::Client, base: &str, model: &str, marker: &str) {
    let result = timeout(
        Duration::from_secs(5),
        client
            .post(format!("{base}/v1/responses"))
            .json(&json!({"model":model,"input":marker,"stream":false}))
            .send(),
    )
    .await
    .expect("a provider 429 must terminate promptly");
    assert!(
        result.is_err(),
        "a provider 429 must terminate the transport without a client error response"
    );
}

async fn zero_success(client: &reqwest::Client, base: &str, model: &str, marker: &str) {
    let response = timeout(
        Duration::from_secs(5),
        client
            .post(format!("{base}/v1/responses"))
            .json(&json!({"model":model,"input":marker,"stream":false}))
            .send(),
    )
    .await
    .expect("a healthy provider must answer promptly")
    .expect("a healthy provider must actually answer the next request");
    assert_eq!(response.status(), 200);
    let body = response.text().await.unwrap();
    assert!(
        body.contains(marker),
        "must return the real successful provider payload: {body}"
    );
    assert!(
        !body.contains("\"error\""),
        "the client must not receive an error envelope: {body}"
    );
}

async fn zero_receipt(upstream: &Arc<ZeroUpstream>, marker: &str) {
    assert_eq!(
        upstream.business.lock().await.get(marker),
        Some(&1),
        "{marker}: must reach the controlled upstream exactly once"
    );
}

async fn zero_is_cooled(client: &reqwest::Client, base: &str) -> bool {
    pool_entries(client, format!("{base}/_routecodex/health/cooldown-pool"))
        .await
        .iter()
        .any(|entry| {
            entry["provider_id"] == json!("test")
                && entry["auth_alias"] == json!("key")
                && entry["model_id"] == json!("test")
        })
}

fn zero_config(server_port: u16, upstream_port: u16) -> String {
    let declaration = hub_v1_fixture::hub_v1_test_declaration();
    let execution = hub_v1_fixture::hub_v1_server_execution("main");
    format!(
        r#"
version = 3

[error]
provider_error_default_path = [
  {{ step = "wait_retry", retry_mode = "reselect_before_client_projection", max_attempts = 1, backoff_ms = 0 }},
  {{ step = "cooldown", scope = "provider_model", duration_ms = 5000, provider_global_failure = false }},
  {{ step = "project", reason_code = "provider_failure" }},
]

[servers.main]
bind = "127.0.0.1"
port = {server_port}
routing_group = "default"
endpoints = ["responses"]

[providers.test]
type = "responses"
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_COOLDOWN_MANUAL_TEST_KEY" }}] }}
[providers.test.models.test]
[providers.test.models.sibling]

[providers.independent]
type = "responses"
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_COOLDOWN_MANUAL_TEST_KEY" }}] }}
[providers.independent.models.test]

[providers.fallback]
type = "responses"
base_url = "http://127.0.0.1:{upstream_port}/fallback/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_COOLDOWN_MANUAL_TEST_KEY" }}] }}
[providers.fallback.models.test]

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [
  {{ kind = "provider_model", provider = "test", model = "test", key = "key", priority = 100 }},
  {{ kind = "provider_model", provider = "fallback", model = "test", key = "key", priority = 99 }}
]
[route_groups.default.pools.sibling]
match = {{ models = ["sibling"], precedence = 10 }}
targets = [{{ kind = "provider_model", provider = "test", model = "sibling", key = "key", priority = 100 }}]
[route_groups.default.pools.independent]
match = {{ models = ["independent"], precedence = 10 }}
targets = [{{ kind = "provider_model", provider = "independent", model = "test", key = "key", priority = 100 }}]

{declaration}
{execution}
"#
    )
}

#[tokio::test]
async fn manual_actions_keep_named_interface_identity_isolated() {
    let _guard = TEST_LOCK.lock().await;
    let managed = Managed::start("interface-isolation").await;
    let client = reqwest::Client::new();

    for interface_id in ["chat", "default"] {
        let (status, body) = post_json(
            &client,
            managed.add_url(),
            json!({
                "provider_id": "test",
                "interface_id": interface_id,
                "auth_alias": "key",
                "model_id": "test",
                "kind": "probe",
                "duration_ms": 60_000,
            }),
        )
        .await;
        assert_eq!(status, 200, "manual add must succeed: {body}");
    }

    let entries = pool_entries(&client, managed.pool_url()).await;
    for interface_id in ["chat", "default"] {
        assert!(
            entries.iter().any(|entry| {
                entry["provider_id"] == json!("test")
                    && entry["interface_id"] == json!(interface_id)
                    && entry["kind"] == json!("probe")
            }),
            "the pool must preserve the {interface_id} interface identity: {entries:?}"
        );
    }

    let (status, body) = post_json(
        &client,
        managed.probe_url(),
        json!({
            "provider_id": "test",
            "interface_id": "chat",
            "auth_alias": "key",
            "model_id": "test",
        }),
    )
    .await;
    assert_eq!(status, 200, "named-interface probe must succeed: {body}");
    assert_eq!(body["scheduled"], json!(true));

    let (status, body) = post_json(
        &client,
        managed.pool_url(),
        json!({
            "provider_id": "test",
            "interface_id": "chat",
            "auth_alias": "key",
            "model_id": "test",
            "kind": "probe",
        }),
    )
    .await;
    assert_eq!(status, 200, "named-interface removal must succeed: {body}");
    assert_eq!(body["removed"], json!(true));

    let entries = pool_entries(&client, managed.pool_url()).await;
    assert!(
        entries
            .iter()
            .all(|entry| entry["interface_id"] != json!("chat")),
        "removing chat must not leave a chat entry: {entries:?}"
    );
    assert!(
        entries
            .iter()
            .any(|entry| entry["interface_id"] == json!("default")),
        "removing chat must not affect the default sibling: {entries:?}"
    );

    managed.finish().await;
}

#[tokio::test]
async fn manual_add_rejects_session_kind_and_out_of_range_duration() {
    let _guard = TEST_LOCK.lock().await;
    let managed = Managed::start("add-rejects").await;
    let client = reqwest::Client::new();

    let (status, body) = post_json(
        &client,
        managed.add_url(),
        json!({
            "provider_id": "test",
            "auth_alias": "key",
            "kind": "session",
            "duration_ms": 60_000,
        }),
    )
    .await;
    assert_eq!(status, 400, "session is not a manual kind: {body}");

    for duration_ms in [0_u64, 24 * 60 * 60 * 1000 + 1] {
        let (status, body) = post_json(
            &client,
            managed.add_url(),
            json!({
                "provider_id": "test",
                "auth_alias": "key",
                "model_id": "test",
                "kind": "probe",
                "duration_ms": duration_ms,
            }),
        )
        .await;
        assert_eq!(
            status, 400,
            "duration {duration_ms} must be rejected: {body}"
        );
    }

    // A rejected add must not have written anything.
    let entries = pool_entries(&client, managed.pool_url()).await;
    assert!(
        entries
            .iter()
            .all(|entry| entry["provider_id"] != json!("test")),
        "rejected manual adds must not create entries: {entries:?}"
    );

    managed.finish().await;
}

#[tokio::test]
async fn manual_probe_reports_scheduled_false_without_probe_state() {
    let _guard = TEST_LOCK.lock().await;
    let managed = Managed::start("probe-noop").await;
    let client = reqwest::Client::new();

    let (status, body) = post_json(
        &client,
        managed.probe_url(),
        json!({ "provider_id": "test", "auth_alias": "key", "model_id": "test" }),
    )
    .await;
    assert_eq!(
        status, 200,
        "an identity without probe state is a no-op: {body}"
    );
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["scheduled"], json!(false));

    managed.finish().await;
}

#[tokio::test]
async fn manual_probe_schedules_an_existing_probe() {
    let _guard = TEST_LOCK.lock().await;
    let managed = Managed::start("probe-scheduled").await;
    let client = reqwest::Client::new();

    // Seed real probe state through the public add endpoint.
    let (status, body) = post_json(
        &client,
        managed.add_url(),
        json!({
            "provider_id": "test",
            "auth_alias": "key",
            "model_id": "test",
            "kind": "probe",
            "duration_ms": 600_000,
        }),
    )
    .await;
    assert_eq!(
        status, 200,
        "seeding manual probe state must succeed: {body}"
    );

    let (status, body) = post_json(
        &client,
        managed.probe_url(),
        json!({ "provider_id": "test", "auth_alias": "key", "model_id": "test" }),
    )
    .await;
    assert_eq!(
        status, 200,
        "probing an existing entry must succeed: {body}"
    );
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["scheduled"], json!(true));

    managed.finish().await;
}

#[tokio::test]
async fn manual_probe_rejects_blank_provider() {
    let _guard = TEST_LOCK.lock().await;
    let managed = Managed::start("probe-blank").await;
    let client = reqwest::Client::new();

    let (status, body) = post_json(
        &client,
        managed.probe_url(),
        json!({ "provider_id": "   " }),
    )
    .await;
    assert_eq!(status, 400, "blank provider_id is a bad request: {body}");

    managed.finish().await;
}

/// Real cross-crate forward: admin proxy -> loopback listener -> store.
///
/// This is the only test that proves the browser-facing admin routes actually
/// reach a listener. It asserts the listener body comes back through the proxy
/// and that the listener's own pool reflects the admin-injected state, then
/// proves the pre-existing release route end-to-end on the same entry.
#[tokio::test]
async fn admin_proxy_forwards_manual_cooldown_actions_to_the_listener() {
    let _guard = TEST_LOCK.lock().await;
    let managed = Managed::start_admin("admin-forward").await;
    let client = reqwest::Client::new();
    let admin_base = managed
        .admin_base
        .clone()
        .expect("admin listener must be enabled for this test");
    let port = managed.listener_port;
    let token = fs::read_to_string(managed.home.join("state").join("admin-token"))
        .expect("admin token is provisioned under <config_dir>/state/admin-token")
        .trim()
        .to_string();

    // 1. Manual add through the admin proxy.
    let (status, body) = post_json_admin(
        &client,
        format!("{admin_base}/api/observability/cooldown-pool/add"),
        &token,
        json!({
            "port": port,
            "provider_id": "test",
            "interface_id": "chat",
            "auth_alias": "key",
            "model_id": "test",
            "kind": "probe",
            "duration_ms": 600_000,
        }),
    )
    .await;
    assert_eq!(
        status, 200,
        "admin add must forward to the listener: {body}"
    );
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["applied"], json!("probe"));
    assert!(
        body["until_ms"].as_u64().is_some(),
        "the listener's until_ms must survive the proxy: {body}"
    );

    // The listener really holds it.
    let entries = pool_entries(&client, managed.pool_url()).await;
    assert!(
        entries.iter().any(|entry| {
            entry["provider_id"] == json!("test")
                && entry["interface_id"] == json!("chat")
                && entry["kind"] == json!("probe")
        }),
        "listener must hold the admin-injected cooldown: {entries:?}"
    );

    // 2. Manual probe through the admin proxy.
    let (status, body) = post_json_admin(
        &client,
        format!("{admin_base}/api/observability/cooldown-pool/probe"),
        &token,
        json!({
            "port": port,
            "provider_id": "test",
            "interface_id": "chat",
            "auth_alias": "key",
            "model_id": "test",
        }),
    )
    .await;
    assert_eq!(
        status, 200,
        "admin probe must forward to the listener: {body}"
    );
    assert_eq!(body["scheduled"], json!(true));

    // 3. Manual release through the admin proxy (pre-existing route, now proven end-to-end).
    let (status, body) = post_json_admin(
        &client,
        format!("{admin_base}/api/observability/cooldown-pool"),
        &token,
        json!({
            "port": port,
            "provider_id": "test",
            "interface_id": "chat",
            "auth_alias": "key",
            "model_id": "test",
            "kind": "probe",
        }),
    )
    .await;
    assert_eq!(
        status, 200,
        "admin release must forward to the listener: {body}"
    );
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["removed"], json!(true));

    let entries = pool_entries(&client, managed.pool_url()).await;
    assert!(
        entries
            .iter()
            .all(|entry| entry["provider_id"] != json!("test")),
        "released entry must disappear from the listener: {entries:?}"
    );

    // 4. Admin still refuses an invalid request before any forward.
    let (status, _) = post_json_admin(
        &client,
        format!("{admin_base}/api/observability/cooldown-pool/add"),
        &token,
        json!({
            "port": port,
            "provider_id": "test",
            "kind": "session",
            "duration_ms": 1_000,
        }),
    )
    .await;
    assert_eq!(
        status, 400,
        "session kind must be refused by the admin proxy"
    );

    // 5. The 24 h bound is owned by the listener, so the admin does not restate
    // it. The listener's 400 must therefore survive the proxy as a 400: if the
    // proxy relabelled it BAD_GATEWAY it would report the operator's own input
    // mistake as a listener fault.
    let (status, body) = post_json_admin(
        &client,
        format!("{admin_base}/api/observability/cooldown-pool/add"),
        &token,
        json!({
            "port": port,
            "provider_id": "test",
            "auth_alias": "key",
            "model_id": "test",
            "kind": "probe",
            "duration_ms": 24 * 60 * 60 * 1000 + 1,
        }),
    )
    .await;
    assert_eq!(
        status, 400,
        "the listener's out-of-range 400 must pass through the proxy, not become 502: {body}"
    );

    managed.finish().await;
}

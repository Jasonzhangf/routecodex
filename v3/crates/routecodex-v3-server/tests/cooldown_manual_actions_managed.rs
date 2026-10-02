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

use routecodex_v3_config::V3ConfigStore;
use routecodex_v3_server::spawn_v3_server_aggregate_with_admin;
use serde_json::{json, Value};
use std::{env, fs, net::TcpListener, path::PathBuf};
use tokio::time::{sleep, Duration};

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

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

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
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_COOLDOWN_MANUAL_TEST_KEY" }}] }}

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
        std::env::set_var("V3_COOLDOWN_MANUAL_TEST_KEY", "controlled-secret");
        std::env::remove_var("ROUTECODEX_V3_ADMIN_BIND");
        let home = temp_home(label);
        let previous_home = env::var_os("HOME");
        env::set_var("HOME", &home);
        let config_path = home.join("config.v3.toml");
        let server_port = free_port();
        let source = if with_admin {
            format!(
                "{}\n[admin_webui]\nenabled = true\nbind = \"127.0.0.1\"\nport = {}\n",
                config_source(server_port),
                free_port()
            )
        } else {
            config_source(server_port)
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
    assert_eq!(entry["model_id"], json!("test"));

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
        entries
            .iter()
            .any(|entry| entry["provider_id"] == json!("test") && entry["kind"] == json!("probe")),
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

use axum::{
    body::Body, extract::State, http::StatusCode, response::Response, routing::post, Router,
};
use routecodex_v3_config::V3ConfigStore;
use routecodex_v3_server::spawn_v3_server_aggregate_with_admin;
use serde_json::{json, Value};
use std::{
    env, fs,
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use tokio::{
    sync::oneshot,
    time::{sleep, Duration},
};

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
use hub_v1_fixture::{hub_v1_server_execution, hub_v1_test_declaration};

static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn temp_home(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "rcc-admin-managed-{label}-{}-{}",
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
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_ADMIN_MANAGED_TEST_KEY" }}] }}

[providers.test.models.test]

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "test", model = "test", key = "key", priority = 1 }}]
"#
    )
}

fn config_source_with_upstream(server_port: u16, upstream_port: u16) -> String {
    format!(
        r#"
version = 3

{hub_v1_declaration}

[servers.main]
bind = "127.0.0.1"
port = {server_port}
routing_group = "default"
endpoints = ["responses"]

{server_execution}
[providers.test]
type = "responses"
base_url = "http://127.0.0.1:{upstream_port}/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_ADMIN_MANAGED_TEST_KEY" }}] }}
responses = {{ process = "direct", streaming = "never" }}

[providers.test.models.test]
wire_name = "test"
capabilities = ["text"]

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "test", model = "test", key = "key", priority = 1 }}]
"#,
        hub_v1_declaration = hub_v1_test_declaration(),
        server_execution = hub_v1_server_execution("main"),
    )
}

async fn controlled_responses_upstream(State(calls): State<Arc<AtomicUsize>>) -> Response<Body> {
    calls.fetch_add(1, Ordering::SeqCst);
    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(
            r#"{"id":"resp_850e916","object":"response","status":"completed","model":"test","output_text":"admin-conflict-routed","output":[{"id":"msg_850e916","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"admin-conflict-routed","annotations":[]}]}]}"#,
        ))
        .unwrap()
}

async fn start_controlled_responses_upstream() -> (u16, Arc<AtomicUsize>, oneshot::Sender<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app = Router::new()
        .route("/v1/responses", post(controlled_responses_upstream))
        .with_state(Arc::clone(&calls));
    tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await
            .unwrap();
    });
    (address.port(), calls, shutdown_tx)
}

fn assert_original_listener_still_accepts(listener: &TcpListener) {
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let _client = TcpStream::connect(address).expect("connect to the original admin placeholder");
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    loop {
        match listener.accept() {
            Ok((_stream, _peer)) => return,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(
                    std::time::Instant::now() < deadline,
                    "the original admin placeholder listener must still accept connections"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => panic!("admin placeholder listener accept failed: {error}"),
        }
    }
}

#[tokio::test]
async fn admin_webui_serves_in_aggregate_process_and_shutdown_releases_both_ports() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var("V3_ADMIN_MANAGED_TEST_KEY", "controlled-secret");
    std::env::remove_var("ROUTECODEX_V3_ADMIN_BIND");
    let home = temp_home("server-admin");
    let previous_home = env::var_os("HOME");
    env::set_var("HOME", &home);
    let config_path = home.join("config.v3.toml");
    let server_port = free_port();
    let admin_port = free_port();
    let source = format!(
        r#"
{}
[admin_webui]
enabled = true
bind = "127.0.0.1"
port = {admin_port}
"#,
        config_source(server_port)
    );
    fs::write(&config_path, source).unwrap();

    let snapshot = V3ConfigStore::new(&config_path)
        .load_snapshot_with_source_identity()
        .unwrap();
    let manifest = snapshot.manifest;
    let admin_webui = snapshot.admin_webui;
    assert!(admin_webui.is_some());

    let handle = spawn_v3_server_aggregate_with_admin(manifest, admin_webui, Some(config_path))
        .await
        .unwrap();
    let admin_listener = handle
        .listeners
        .iter()
        .find(|listener| listener.server_id == "admin_webui")
        .expect("aggregate handle exposes admin listener");
    let server_listener = handle
        .listeners
        .iter()
        .find(|listener| listener.server_id == "main")
        .expect("aggregate handle exposes configured server listener");

    let client = reqwest::Client::new();
    let admin_response = client
        .get(format!("http://{}/requests.html", admin_listener.addr))
        .send()
        .await
        .unwrap();
    assert_eq!(admin_response.status(), 200);
    let body = admin_response.text().await.unwrap();
    assert!(body.contains("<html"), "admin page should render HTML");

    let health = client
        .get(format!("http://{}/health", server_listener.addr))
        .send()
        .await
        .unwrap();
    assert_eq!(health.status(), 200);

    handle.shutdown().await;
    sleep(Duration::from_millis(100)).await;
    assert!(
        TcpListener::bind(("127.0.0.1", admin_port)).is_ok(),
        "shutdown must release admin port"
    );
    assert!(
        TcpListener::bind(("127.0.0.1", server_port)).is_ok(),
        "shutdown must release server port"
    );
    if let Some(previous_home) = previous_home {
        env::set_var("HOME", previous_home);
    } else {
        env::remove_var("HOME");
    }
    let _ = fs::remove_dir_all(&home);
}

#[tokio::test]
async fn issue850e916_admin_port_conflict_keeps_business_listeners_serving() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var("V3_ADMIN_MANAGED_TEST_KEY", "controlled-secret");
    std::env::remove_var("ROUTECODEX_V3_ADMIN_BIND");
    let home = temp_home("server-admin-conflict");
    let previous_home = env::var_os("HOME");
    env::set_var("HOME", &home);
    let config_path = home.join("config.v3.toml");
    let server_port = free_port();
    let (upstream_port, upstream_calls, upstream_shutdown) =
        start_controlled_responses_upstream().await;
    let admin_placeholder = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let admin_port = admin_placeholder.local_addr().unwrap().port();
    let source = format!(
        r#"
{}
[admin_webui]
enabled = true
bind = "127.0.0.1"
port = {admin_port}
"#,
        config_source_with_upstream(server_port, upstream_port)
    );
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
    .expect("an occupied admin port must not abort business listener startup");

    assert!(
        handle
            .listeners
            .iter()
            .all(|listener| listener.server_id != "admin_webui"),
        "the aggregate handle must not expose an admin listener when its port was unavailable"
    );
    let server_listener = handle
        .listeners
        .iter()
        .find(|listener| listener.server_id == "main")
        .expect("aggregate handle exposes the configured business listener");

    let client = reqwest::Client::new();
    let health = client
        .get(format!("http://{}/health", server_listener.addr))
        .send()
        .await
        .unwrap();
    assert_eq!(health.status(), 200);

    let routed = client
        .post(format!("http://{}/v1/responses", server_listener.addr))
        .json(&json!({"model": "test", "input": "admin conflict business route"}))
        .send()
        .await
        .unwrap();
    assert_eq!(routed.status(), 200);
    let routed_body: Value = routed.json().await.unwrap();
    assert_eq!(routed_body["output_text"], "admin-conflict-routed");
    assert_eq!(
        upstream_calls.load(Ordering::SeqCst),
        1,
        "the business request must actually reach the controlled provider"
    );

    assert!(
        TcpListener::bind(("127.0.0.1", admin_port)).is_err(),
        "the original admin placeholder must keep its port while the aggregate runs"
    );
    assert_original_listener_still_accepts(&admin_placeholder);

    handle.shutdown().await;
    sleep(Duration::from_millis(100)).await;
    assert!(
        TcpListener::bind(("127.0.0.1", admin_port)).is_err(),
        "aggregate shutdown must not release a port owned by the original placeholder listener"
    );

    let _ = upstream_shutdown.send(());
    if let Some(previous_home) = previous_home {
        env::set_var("HOME", previous_home);
    } else {
        env::remove_var("HOME");
    }
    let _ = fs::remove_dir_all(&home);
}

#[tokio::test]
async fn issue850e916_business_listener_conflict_fails_explicitly() {
    let _guard = TEST_LOCK.lock().await;
    std::env::remove_var("ROUTECODEX_V3_ADMIN_BIND");
    let home = temp_home("server-business-conflict");
    let previous_home = env::var_os("HOME");
    env::set_var("HOME", &home);
    let config_path = home.join("config.v3.toml");
    let business_placeholder = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let business_port = business_placeholder.local_addr().unwrap().port();
    fs::write(&config_path, config_source_with_upstream(business_port, 9)).unwrap();

    let snapshot = V3ConfigStore::new(&config_path)
        .load_snapshot_with_source_identity()
        .unwrap();
    let error = match spawn_v3_server_aggregate_with_admin(
        snapshot.manifest,
        None,
        Some(config_path),
    )
    .await
    {
        Ok(_handle) => {
            panic!("an occupied business listener port must fail startup explicitly")
        }
        Err(error) => error,
    };
    assert_eq!(
        error.kind(),
        std::io::ErrorKind::AddrInUse,
        "business listener conflicts must stay AddrInUse, got {error}"
    );
    assert!(
        TcpListener::bind(("127.0.0.1", business_port)).is_err(),
        "the pre-occupied business port must remain owned by the original listener"
    );

    if let Some(previous_home) = previous_home {
        env::set_var("HOME", previous_home);
    } else {
        env::remove_var("HOME");
    }
    let _ = fs::remove_dir_all(&home);
}

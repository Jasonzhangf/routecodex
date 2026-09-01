use routecodex_v3_config::V3ConfigStore;
use routecodex_v3_server::spawn_v3_server_aggregate_with_admin;
use std::{env, fs, net::TcpListener, path::PathBuf};
use tokio::time::{sleep, Duration};

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
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_ADMIN_MANAGED_TEST_KEY" }}] }}

[providers.test.models.test]

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "test", model = "test", key = "key", priority = 1 }}]
"#
    )
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

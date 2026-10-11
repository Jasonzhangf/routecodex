use routecodex_v3_config::{
    compile_v3_config_05_manifest, parse_v3_config_02_authoring, V3AdminWebuiManifest,
};
use routecodex_v3_server::spawn_v3_server_aggregate_with_admin;
use serde_json::{json, Value};
use std::net::TcpListener;

#[path = "../../../crates/routecodex-v3-runtime/tests/support/hub_v1_fixture.rs"]
mod hub_v1_fixture;
use hub_v1_fixture::{hub_v1_server_execution, hub_v1_test_declaration};

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn config_source(server_port: u16, admin_port: u16) -> String {
    format!(
        r#"
version = 3

{hub_v1_declaration}

[servers.runtime]
bind = "127.0.0.1"
port = {server_port}
routing_group = "controlled"
endpoints = ["responses"]

{server_execution}

[admin_webui]
enabled = true
bind = "127.0.0.1"
port = {admin_port}

[providers.multi]
default_model = "wire-model"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_ADMIN_COOLDOWN_INTERFACE_KEY" }}] }}
health = {{ enabled = true, failure_threshold = 1, cooldown_ms = 60000 }}

[providers.multi.models.wire-model]
wire_name = "wire-model"
aliases = ["client-model"]
capabilities = ["text"]
supports_streaming = true

[providers.multi.interfaces.default]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
responses = {{ process = "chat", streaming = "never" }}

[providers.multi.interfaces.chat]
type = "openai_chat"
base_url = "http://127.0.0.1:9/v1"

[route_groups.controlled.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "multi", model = "wire-model", key = "key", interface = "default", priority = 1 }}]
"#,
        hub_v1_declaration = hub_v1_test_declaration(),
        server_execution = hub_v1_server_execution("runtime"),
    )
}

fn manifest(
    server_port: u16,
    admin_port: u16,
) -> routecodex_v3_config::V3Config05ManifestPublished {
    compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(&config_source(server_port, admin_port)).unwrap(),
    )
    .unwrap()
}

async fn post_admin(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    path: &str,
    body: Value,
) -> (reqwest::StatusCode, Value) {
    let response = client
        .post(format!("{base}{path}"))
        .header("x-routecodex-admin-token", token)
        .json(&body)
        .send()
        .await
        .expect("admin response");
    let status = response.status();
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    (status, body)
}

async fn runtime_pool(client: &reqwest::Client, runtime_port: u16) -> Value {
    client
        .get(format!(
            "http://127.0.0.1:{runtime_port}/_routecodex/health/cooldown-pool"
        ))
        .send()
        .await
        .expect("runtime pool response")
        .json()
        .await
        .expect("runtime pool json")
}

fn entry_for_interface<'a>(pool: &'a Value, interface_id: &str) -> Option<&'a Value> {
    pool["entries"]
        .as_array()?
        .iter()
        .find(|entry| entry["provider_id"] == "multi" && entry["interface_id"] == interface_id)
}

#[tokio::test]
async fn admin_cooldown_actions_preserve_interface_identity() {
    std::env::set_var(
        "V3_ADMIN_COOLDOWN_INTERFACE_KEY",
        "controlled-admin-cooldown-secret",
    );
    let server_port = free_port();
    let admin_port = free_port();
    let manifest = manifest(server_port, admin_port);
    let config_dir = std::env::temp_dir().join(format!(
        "rcc-admin-cooldown-interface-{}-{}",
        std::process::id(),
        admin_port
    ));
    let _ = std::fs::remove_dir_all(&config_dir);
    std::fs::create_dir_all(&config_dir).expect("create config dir");
    let config_path = config_dir.join("config.v3.toml");
    std::fs::write(&config_path, config_source(server_port, admin_port)).expect("write config");
    let admin = V3AdminWebuiManifest {
        enabled: true,
        bind: "127.0.0.1".into(),
        port: admin_port,
    };

    let handle =
        spawn_v3_server_aggregate_with_admin(manifest, Some(admin), Some(config_path.clone()))
            .await
            .unwrap();
    let runtime = handle
        .listeners
        .iter()
        .find(|listener| listener.server_id == "runtime")
        .expect("runtime listener");
    let admin = handle
        .listeners
        .iter()
        .find(|listener| listener.server_id == "admin_webui")
        .expect("admin listener");
    let token = std::fs::read_to_string(config_dir.join("state").join("admin-token"))
        .expect("admin token")
        .trim()
        .to_string();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap();
    let admin_base = format!("http://{}", admin.addr);

    let add = |interface_id: &str| {
        json!({
            "port": runtime.addr.port(),
            "provider_id": "multi",
            "interface_id": interface_id,
            "auth_alias": "key",
            "kind": "auth_key",
            "duration_ms": 60000,
        })
    };

    let (status, body) = post_admin(
        &client,
        &admin_base,
        &token,
        "/api/observability/cooldown-pool/add",
        add("default"),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_eq!(body["interface_id"], "default");

    let (status, body) = post_admin(
        &client,
        &admin_base,
        &token,
        "/api/observability/cooldown-pool/add",
        add("chat"),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_eq!(body["interface_id"], "chat");

    let pool = runtime_pool(&client, runtime.addr.port()).await;
    assert!(
        entry_for_interface(&pool, "default").is_some(),
        "default cooldown missing: {pool}"
    );
    assert!(
        entry_for_interface(&pool, "chat").is_some(),
        "chat cooldown missing: {pool}"
    );

    let (status, body) = post_admin(
        &client,
        &admin_base,
        &token,
        "/api/observability/cooldown-pool",
        json!({
            "port": runtime.addr.port(),
            "provider_id": "multi",
            "interface_id": "chat",
            "auth_alias": "key",
            "kind": "auth_key",
        }),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_eq!(body["interface_id"], "chat");
    assert_eq!(body["removed"], true);

    let pool = runtime_pool(&client, runtime.addr.port()).await;
    assert!(
        entry_for_interface(&pool, "default").is_some(),
        "releasing chat must leave default unchanged: {pool}"
    );
    assert!(
        entry_for_interface(&pool, "chat").is_none(),
        "releasing chat must remove only chat: {pool}"
    );

    let (status, body) = post_admin(
        &client,
        &admin_base,
        &token,
        "/api/observability/cooldown-pool/add",
        add("chat"),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");

    let (status, body) = post_admin(
        &client,
        &admin_base,
        &token,
        "/api/observability/cooldown-pool/probe",
        json!({
            "port": runtime.addr.port(),
            "provider_id": "multi",
            "interface_id": "chat",
            "auth_alias": "key",
        }),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_eq!(body["interface_id"], "chat");
    assert_eq!(body["scheduled"], true);

    let pool = runtime_pool(&client, runtime.addr.port()).await;
    assert!(
        entry_for_interface(&pool, "default").is_some(),
        "probing chat must leave default unchanged: {pool}"
    );

    handle.shutdown().await;
    let _ = std::fs::remove_dir_all(config_dir);
    std::env::remove_var("V3_ADMIN_COOLDOWN_INTERFACE_KEY");
}

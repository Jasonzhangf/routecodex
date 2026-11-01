//! Public `/_routecodex/diagnostics/virtual-router/status` acceptance for a
//! multi-interface provider whose route target pins an auth key but omits the
//! interface.
//!
//! Real Target selection expands every enabled interface for such a target, so
//! the status projection must do the same. Collapsing onto a phantom `default`
//! identity would report a provider as available while every real interface is
//! cooled. Cooldowns are seeded through the public loopback `/add` endpoint so
//! the store wiring is the production one.

use routecodex_v3_config::V3ConfigStore;
use routecodex_v3_server::spawn_v3_server_aggregate_with_admin;
use serde_json::{json, Value};
use std::{env, fs, path::PathBuf};
use tokio::time::{sleep, Duration};

static TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[path = "../../../crates/routecodex-v3-runtime/tests/support/test_ports.rs"]
mod test_ports;
use test_ports::free_port;

fn temp_home(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "rcc-diag-multi-{label}-{}-{}",
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

fn config_source(server_port: u16) -> String {
    format!(
        r#"
version = 3

[servers.main]
bind = "127.0.0.1"
port = {server_port}
routing_group = "default"
endpoints = ["responses"]

[providers.multi]
default_model = "m"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_DIAG_MULTI_KEY" }}] }}

[providers.multi.models.m]
wire_name = "wire-m"
capabilities = ["text"]

[providers.multi.interfaces.chat]
type = "openai_chat"
base_url = "http://127.0.0.1:9/v1"

[providers.multi.interfaces.responses]
type = "responses"
base_url = "http://127.0.0.1:9/v1"

[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "multi", model = "m", key = "key", priority = 1 }}]
"#
    )
}

fn sorted_provider_keys(entries: &Value) -> Vec<String> {
    let mut keys = entries
        .as_array()
        .expect("entries array")
        .iter()
        .map(|entry| {
            entry["providerKey"]
                .as_str()
                .unwrap_or_default()
                .to_string()
        })
        .collect::<Vec<_>>();
    keys.sort();
    keys
}

#[tokio::test]
async fn virtual_router_status_expands_named_interfaces_for_an_auth_pinned_target() {
    let _guard = TEST_LOCK.lock().await;
    std::env::set_var("V3_DIAG_MULTI_KEY", "controlled-secret");
    let home = temp_home("status");
    let previous_home = env::var_os("HOME");
    env::set_var("HOME", &home);

    let config_path = home.join("config.v3.toml");
    let server_port = free_port();
    fs::write(&config_path, config_source(server_port)).unwrap();
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
        .expect("configured listener");
    let base = format!("http://{}", listener.addr);
    sleep(Duration::from_millis(50)).await;

    let client = reqwest::Client::new();
    let status_url = format!("{base}/_routecodex/diagnostics/virtual-router/status");
    let add_url = format!("{base}/_routecodex/health/cooldown-pool/add");
    let remove_url = format!("{base}/_routecodex/health/cooldown-pool");

    // Seed a cooldown for each real interface through the public endpoint.
    for interface_id in ["chat", "responses"] {
        let response = client
            .post(&add_url)
            .json(&json!({
                "port": server_port,
                "provider_id": "multi",
                "interface_id": interface_id,
                "auth_alias": "key",
                "model_id": "m",
                "kind": "auth_key",
                "duration_ms": 60_000,
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            200,
            "cooldown add for {interface_id} must succeed"
        );
    }

    let status: Value = client
        .get(&status_url)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pool = &status["virtualRouter"]["routes"]["default"]["pools"][0];
    assert_eq!(
        pool["availableTargets"],
        json!([]),
        "every real interface is cooled, so no target is available: {pool}"
    );
    assert_eq!(
        sorted_provider_keys(&pool["unavailableProviders"]),
        vec!["multi.chat.key.m", "multi.responses.key.m"],
        "the projection must name the real interfaces, never a phantom default"
    );
    assert!(
        !sorted_provider_keys(&pool["unavailableProviders"])
            .iter()
            .any(|key| key == "multi.key.m"),
        "the interface-omitted label must not survive interface expansion"
    );

    // Releasing one interface changes only that sibling.
    let response = client
        .post(&remove_url)
        .json(&json!({
            "port": server_port,
            "provider_id": "multi",
            "interface_id": "chat",
            "auth_alias": "key",
            "kind": "auth_key",
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200, "release of chat must succeed");

    let status: Value = client
        .get(&status_url)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let pool = &status["virtualRouter"]["routes"]["default"]["pools"][0];
    assert_eq!(pool["availableTargets"], json!(["multi.chat.key.m"]));
    assert_eq!(
        sorted_provider_keys(&pool["unavailableProviders"]),
        vec!["multi.responses.key.m"]
    );

    handle.shutdown().await;
    if let Some(previous) = previous_home {
        env::set_var("HOME", previous);
    } else {
        env::remove_var("HOME");
    }
    let _ = fs::remove_dir_all(&home);
}

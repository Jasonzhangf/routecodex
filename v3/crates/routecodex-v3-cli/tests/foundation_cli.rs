use std::fs;
use std::process::Command;

fn write_config() -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("routecodex-v3-cli-{}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let path = root.join("config.v3.toml");
    fs::write(&path, r#"
version = 3
[servers.a]
bind = "127.0.0.1"
port = 4444
routing_group = "default"
[servers.b]
bind = "127.0.0.1"
port = 4445
routing_group = "default"
[providers.test]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "test"
auth = { type = "api_key", entries = [{ alias = "key", env = "V3_TEST_KEY" }] }
[providers.test.models.test]
[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "test", model = "test", key = "key", priority = 1 }]
"#).unwrap();
    path
}

#[test]
fn config_check_and_server_status_use_config_store_manifest() {
    let config = write_config();
    let binary = env!("CARGO_BIN_EXE_routecodex-v3");
    let check = Command::new(binary)
        .args(["config", "check", "--config", config.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(check.status.success());
    assert!(String::from_utf8(check.stdout)
        .unwrap()
        .contains("servers=2"));

    let status = Command::new(binary)
        .args(["server", "status", "--config", config.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(status.status.success());
    let stdout = String::from_utf8(status.stdout).unwrap();
    assert!(stdout.contains("a enabled=true address=127.0.0.1:4444"));
    assert!(stdout.contains("b enabled=true address=127.0.0.1:4445"));
    fs::remove_dir_all(config.parent().unwrap()).unwrap();
}

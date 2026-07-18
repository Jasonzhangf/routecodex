use std::fs;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn write_config() -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!(
        "routecodex-v3-cli-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
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
    let binary = env!("CARGO_BIN_EXE_rccv3");
    let check = Command::new(binary)
        .args(["config", "check", "-c", config.to_str().unwrap()])
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

    let top_level_status = Command::new(binary)
        .args(["status", "-c", config.to_str().unwrap()])
        .output()
        .unwrap();
    assert!(top_level_status.status.success());
    let stdout = String::from_utf8(top_level_status.stdout).unwrap();
    assert!(stdout.contains("a enabled=true address=127.0.0.1:4444"));
    assert!(stdout.contains("b enabled=true address=127.0.0.1:4445"));
    fs::remove_dir_all(config.parent().unwrap()).unwrap();
}

#[test]
fn help_exposes_old_style_top_level_lifecycle_commands() {
    let help = Command::new(env!("CARGO_BIN_EXE_rccv3"))
        .arg("--help")
        .output()
        .unwrap();
    assert!(help.status.success());
    let stdout = String::from_utf8(help.stdout).unwrap();
    for command in ["start", "status", "restart", "stop"] {
        assert!(stdout.contains(command), "{stdout}");
    }
    assert!(
        !stdout.contains("server"),
        "server namespace must stay compatible but not be the user-facing lifecycle shape:\n{stdout}"
    );
}

#[test]
fn version_flag_reports_package_and_crate_version() {
    let output = Command::new(env!("CARGO_BIN_EXE_rccv3"))
        .arg("--version")
        .output()
        .unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert!(stdout.starts_with("rccv3 "), "{stdout}");
    assert!(stdout.contains("(crate "), "{stdout}");
}

#[test]
fn top_level_start_help_exposes_snap_and_optional_config() {
    let help = Command::new(env!("CARGO_BIN_EXE_rccv3"))
        .args(["start", "--help"])
        .output()
        .unwrap();
    assert!(help.status.success());
    let stdout = String::from_utf8(help.stdout).unwrap();
    assert!(stdout.contains("--snap"), "{stdout}");
    assert!(stdout.contains("--config"), "{stdout}");
    assert!(stdout.contains("-c"), "{stdout}");
}

#[test]
fn cli_defaults_to_home_rcc_config_v3_toml() {
    let source = write_config();
    let home = source.parent().unwrap().join("home");
    let default_config = home.join(".rcc").join("config.v3.toml");
    fs::create_dir_all(default_config.parent().unwrap()).unwrap();
    fs::copy(&source, &default_config).unwrap();

    let check = Command::new(env!("CARGO_BIN_EXE_rccv3"))
        .env("HOME", &home)
        .args(["config", "check"])
        .output()
        .unwrap();

    assert!(
        check.status.success(),
        "{}",
        String::from_utf8_lossy(&check.stderr)
    );
    assert!(String::from_utf8(check.stdout)
        .unwrap()
        .contains("servers=2"));
    fs::remove_dir_all(source.parent().unwrap()).unwrap();
}

#[test]
fn cli_without_explicit_config_or_home_fails_fast() {
    let check = Command::new(env!("CARGO_BIN_EXE_rccv3"))
        .env_remove("HOME")
        .args(["config", "check"])
        .output()
        .unwrap();

    assert!(!check.status.success());
    assert!(String::from_utf8(check.stderr)
        .unwrap()
        .contains("HOME is required to resolve config.v3.toml"));
}

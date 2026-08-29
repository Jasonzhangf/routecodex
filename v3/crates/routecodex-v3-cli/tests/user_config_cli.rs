use routecodex_v3_config::V3UserConfigStore;
use std::io::Write;
use std::process::{Command, Stdio};

fn write_provider(home: &std::path::Path) {
    let provider_dir = home.join("provider").join("p1");
    std::fs::create_dir_all(&provider_dir).expect("provider dir");
    std::fs::write(
        provider_dir.join("config.v2.toml"),
        r#"version = "2.0.0"
providerId = "p1"
[provider]
id = "p1"
enabled = true
type = "openai_chat"
baseURL = "http://127.0.0.1:9999/v1"
defaultModel = "m1"
[provider.auth]
type = "apikey"
apiKey = "test"
[provider.models."m1"]
supportsStreaming = true
"#,
    )
    .expect("provider file");
}

fn write_legacy_config(path: &std::path::Path) {
    std::fs::write(
        path,
        r#"version = 3
[servers.a]
bind = "127.0.0.1"
port = 4444
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
"#,
    )
    .expect("legacy config");
}

#[test]
fn init_interactive_and_noninteractive_write_the_same_minimal_user_config() {
    let noninteractive = tempfile::tempdir().expect("noninteractive home");
    let interactive = tempfile::tempdir().expect("interactive home");
    write_provider(noninteractive.path());
    write_provider(interactive.path());
    let noninteractive_config = noninteractive.path().join("config.toml");
    let interactive_config = interactive.path().join("config.toml");

    let output = Command::new(env!("CARGO_BIN_EXE_rccv3"))
        .args([
            "init",
            "--config",
            noninteractive_config.to_str().unwrap(),
            "--provider",
            "p1",
        ])
        .output()
        .expect("noninteractive init");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let mut child = Command::new(env!("CARGO_BIN_EXE_rccv3"))
        .args(["init", "--config", interactive_config.to_str().unwrap()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("interactive init");
    child.stdin.as_mut().unwrap().write_all(b"\n").unwrap();
    let output = child.wait_with_output().expect("interactive output");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let explicit = V3UserConfigStore::new(&noninteractive_config)
        .read_routing_selection()
        .expect("explicit selection");
    let prompted = V3UserConfigStore::new(&interactive_config)
        .read_routing_selection()
        .expect("prompted selection");
    assert_eq!(explicit, prompted);
    let raw = std::fs::read_to_string(&noninteractive_config).unwrap();
    assert!(!raw.contains("providers"));
    assert!(!raw.contains("servers"));
    assert!(!raw.contains("priority"));
    assert!(noninteractive
        .path()
        .join("provider/p1/config.v2.toml")
        .exists());

    let check = Command::new(env!("CARGO_BIN_EXE_rccv3"))
        .args([
            "config",
            "check",
            "--config",
            noninteractive_config.to_str().unwrap(),
        ])
        .output()
        .expect("config check");
    assert!(
        check.status.success(),
        "{}",
        String::from_utf8_lossy(&check.stderr)
    );
}

#[test]
fn server_status_loads_exact_config_toml_through_the_user_config_owner() {
    let home = tempfile::tempdir().expect("home");
    write_provider(home.path());
    let config = home.path().join("config.toml");
    let created = Command::new(env!("CARGO_BIN_EXE_rccv3"))
        .args([
            "init",
            "--config",
            config.to_str().unwrap(),
            "--provider",
            "p1",
        ])
        .output()
        .expect("create config");
    assert!(
        created.status.success(),
        "{}",
        String::from_utf8_lossy(&created.stderr)
    );

    let status = Command::new(env!("CARGO_BIN_EXE_rccv3"))
        .env("ROUTECODEX_V3_STATE_DIR", home.path().join("state"))
        .args(["server", "status", "--config", config.to_str().unwrap()])
        .output()
        .expect("server status");

    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    assert!(String::from_utf8_lossy(&status.stdout).contains("enabled=true"));
}

#[test]
fn exact_filename_selection_never_retries_the_other_config_owner() {
    let root = tempfile::tempdir().expect("root");
    let user_filename = root.path().join("config.toml");
    write_legacy_config(&user_filename);
    let rejected = Command::new(env!("CARGO_BIN_EXE_rccv3"))
        .args([
            "config",
            "check",
            "--config",
            user_filename.to_str().unwrap(),
        ])
        .output()
        .expect("reject legacy shape under user filename");
    assert!(!rejected.status.success());
    let stderr = String::from_utf8_lossy(&rejected.stderr);
    assert!(stderr.contains("unknown field `servers`"), "{stderr}");

    let legacy_filename = root.path().join("config.v3.toml");
    write_legacy_config(&legacy_filename);
    let accepted = Command::new(env!("CARGO_BIN_EXE_rccv3"))
        .env("ROUTECODEX_V3_STATE_DIR", root.path().join("state"))
        .args([
            "server",
            "status",
            "--config",
            legacy_filename.to_str().unwrap(),
        ])
        .output()
        .expect("accept explicit legacy config");
    assert!(
        accepted.status.success(),
        "{}",
        String::from_utf8_lossy(&accepted.stderr)
    );
    assert!(
        String::from_utf8_lossy(&accepted.stdout).contains("a enabled=true address=127.0.0.1:4444")
    );
}

#[test]
fn config_check_without_explicit_path_uses_home_config_toml() {
    let home = tempfile::tempdir().expect("home");
    let config_root = home.path().join(".rcc");
    std::fs::create_dir_all(&config_root).expect("config root");
    write_provider(&config_root);
    std::fs::write(
        config_root.join("config.toml"),
        r#"version = 3

[route_groups.responses_v3_7777.default]
tiers = [[{ use = "p1/m1" }]]

[route_groups.routecodex_v3_4444.default]
tiers = [[{ use = "p1/m1" }]]
"#,
    )
    .expect("default user config");

    let checked = Command::new(env!("CARGO_BIN_EXE_rccv3"))
        .env("HOME", home.path())
        .args(["config", "check"])
        .output()
        .expect("default config check");

    assert!(
        checked.status.success(),
        "{}",
        String::from_utf8_lossy(&checked.stderr)
    );
    assert!(String::from_utf8_lossy(&checked.stdout).contains("config ok: version=3 servers=2"));
}

#[test]
fn init_rejects_unknown_model_and_preserves_existing_config_without_force() {
    let home = tempfile::tempdir().expect("home");
    write_provider(home.path());
    let config = home.path().join("config.toml");
    let invalid = Command::new(env!("CARGO_BIN_EXE_rccv3"))
        .args([
            "init",
            "--config",
            config.to_str().unwrap(),
            "--provider",
            "p1",
            "--model",
            "missing",
        ])
        .output()
        .expect("invalid init");
    assert!(!invalid.status.success());
    assert!(!config.exists());

    let created = Command::new(env!("CARGO_BIN_EXE_rccv3"))
        .args([
            "init",
            "--config",
            config.to_str().unwrap(),
            "--provider",
            "p1",
        ])
        .output()
        .expect("create config");
    assert!(created.status.success());
    let before = std::fs::read(&config).unwrap();
    let repeated = Command::new(env!("CARGO_BIN_EXE_rccv3"))
        .args([
            "init",
            "--config",
            config.to_str().unwrap(),
            "--provider",
            "p1",
        ])
        .output()
        .expect("repeat init");
    assert!(!repeated.status.success());
    assert_eq!(std::fs::read(&config).unwrap(), before);
}

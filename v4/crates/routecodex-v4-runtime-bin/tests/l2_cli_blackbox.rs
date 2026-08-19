use std::fs;
use std::net::{TcpListener, TcpStream};
use std::process::Command;
use std::time::{Duration, Instant};

fn root(name: &str) -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "rccv4-{name}-{}-{}",
        std::process::id(),
        std::thread::current().name().unwrap_or("test")
    ));
    fs::create_dir_all(&path).expect("temp root");
    path
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("ephemeral bind")
        .local_addr()
        .expect("address")
        .port()
}

fn initialize(test_root: &std::path::Path, port: u16) -> std::path::PathBuf {
    let config = test_root.join("config.v4.toml");
    let output = Command::new(env!("CARGO_BIN_EXE_rccv4"))
        .args([
            "init",
            "-c",
            config.to_str().expect("config path"),
            "--provider",
            "test-provider",
            "--base-url",
            "https://example.invalid/v1",
            "--model",
            "test-model",
            "--api-key",
            "test-only-key",
            "--port",
            &port.to_string(),
        ])
        .output()
        .expect("init command");
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    config
}

#[test]
fn help_version_config_and_servertool_are_cwd_independent() {
    let test_root = root("surface");
    let config = initialize(&test_root, free_port());
    for args in [vec!["--version"], vec!["--help"]] {
        let output = Command::new(env!("CARGO_BIN_EXE_rccv4"))
            .current_dir("/tmp")
            .args(args)
            .output()
            .expect("surface command");
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    }
    let check = Command::new(env!("CARGO_BIN_EXE_rccv4"))
        .current_dir("/tmp")
        .args(["config", "check", "-c", config.to_str().expect("config")])
        .output()
        .expect("config check");
    assert!(check.status.success(), "{}", String::from_utf8_lossy(&check.stderr));
    let tool = Command::new(env!("CARGO_BIN_EXE_rccv4"))
        .current_dir("/tmp")
        .args([
            "servertool",
            "run",
            "web_search",
            "--input-json",
            "{\"query\":\"RouteCodex\"}",
        ])
        .output()
        .expect("servertool");
    assert!(tool.status.success(), "{}", String::from_utf8_lossy(&tool.stderr));
    let value: serde_json::Value = serde_json::from_slice(&tool.stdout).expect("tool JSON");
    assert_eq!(value["routeHint"], "web_search");
}

#[test]
fn managed_start_status_restart_stop_uses_v4_state_root() {
    let test_root = root("lifecycle");
    let state_root = std::path::PathBuf::from("/tmp").join(format!(
        "rccv4-state-{}",
        std::process::id()
    ));
    let port = free_port();
    let config = initialize(&test_root, port);
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_rccv4"))
            .current_dir("/tmp")
            .env("RCCV4_STATE_ROOT", &state_root)
            .args(args)
            .output()
            .expect("lifecycle command")
    };
    let start = run(&["start", "-c", config.to_str().expect("config"), "--snap"]);
    assert!(start.status.success(), "{}", String::from_utf8_lossy(&start.stderr));
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline && TcpStream::connect(("127.0.0.1", port)).is_err() {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(TcpStream::connect(("127.0.0.1", port)).is_ok(), "listener not ready");
    let status = run(&["status", "-c", config.to_str().expect("config")]);
    assert!(status.status.success());
    assert!(String::from_utf8_lossy(&status.stdout).contains("state=running"));
    let restart = run(&["restart", "-c", config.to_str().expect("config")]);
    assert!(restart.status.success(), "{}", String::from_utf8_lossy(&restart.stderr));
    let stop = run(&["stop", "-c", config.to_str().expect("config")]);
    assert!(stop.status.success(), "{}", String::from_utf8_lossy(&stop.stderr));
    assert!(!state_root.join("instance.json").exists());
}

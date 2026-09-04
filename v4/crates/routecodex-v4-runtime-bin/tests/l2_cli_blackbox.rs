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
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    config
}

fn status_pid(output: &[u8]) -> u32 {
    let text = String::from_utf8_lossy(output);
    text.split_whitespace()
        .find_map(|part| {
            part.strip_prefix("pid=")
                .and_then(|value| value.parse().ok())
        })
        .expect("managed status must include pid")
}

fn start_cordis_fixture(
    state_root: &std::path::Path,
) -> (std::process::Child, std::path::PathBuf, std::path::PathBuf) {
    fs::create_dir_all(state_root).expect("Cordis state root");
    let socket = state_root.join("cordis.sock");
    let manifest = state_root.join("manifest.compiled.json");
    let stderr_path = state_root.join("cordis.stderr");
    let stderr = fs::File::create(&stderr_path).expect("Cordis stderr");
    let child = Command::new("node")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../cordis/routecodex-v4-cordis-host/tests/resources/daemon-child.mjs"
        ))
        .args([
            state_root.to_str().expect("state root"),
            socket.to_str().expect("socket"),
            "manifest",
            manifest.to_str().expect("manifest"),
        ])
        .stderr(stderr)
        .spawn()
        .expect("Cordis daemon fixture");
    (child, socket, stderr_path)
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
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let check = Command::new(env!("CARGO_BIN_EXE_rccv4"))
        .current_dir("/tmp")
        .args(["config", "check", "-c", config.to_str().expect("config")])
        .output()
        .expect("config check");
    assert!(
        check.status.success(),
        "{}",
        String::from_utf8_lossy(&check.stderr)
    );
    let tool = Command::new(env!("CARGO_BIN_EXE_rccv4"))
        .current_dir("/tmp")
        .args([
            "servertool",
            "run",
            "web_search",
            "--input-json",
            "{\"query\":\"RouteCodex\"}",
            "--flow",
            "flow-1",
            "--session-id",
            "session-1",
            "--request-id",
            "request-1",
        ])
        .output()
        .expect("servertool");
    assert!(
        tool.status.success(),
        "{}",
        String::from_utf8_lossy(&tool.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&tool.stdout).expect("tool JSON");
    assert_eq!(value["toolName"], "web_search");
    assert!(value.get("routeHint").is_none());
    assert!(value.get("flowId").is_none());
    assert!(value.get("sessionId").is_none());
    assert!(value.get("requestId").is_none());
}

#[test]
fn managed_start_status_restart_stop_uses_v4_state_root() {
    let test_root = root("lifecycle");
    let state_root = std::path::PathBuf::from("/tmp").join(format!(
        "rccv4-state-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    let port = free_port();
    let config = initialize(&test_root, port);
    let preflight = Command::new(env!("CARGO_BIN_EXE_rccv4"))
        .current_dir("/tmp")
        .env("RCCV4_STATE_ROOT", &state_root)
        .env("HOME", &test_root)
        .args(["start", "-c", config.to_str().expect("config")])
        .output()
        .expect("manifest preflight");
    assert!(!preflight.status.success(), "preflight must fail without Cordis admission");
    assert!(
        !String::from_utf8_lossy(&preflight.stdout).contains("Server started"),
        "failed admission must not print a started banner"
    );
    assert!(state_root.join("manifest.compiled.json").exists(), "preflight must publish the compiled manifest");
    let (mut cordis, socket, cordis_stderr) = start_cordis_fixture(&state_root);
    let cordis_deadline = Instant::now() + Duration::from_secs(3);
    while !socket.exists() && Instant::now() < cordis_deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(socket.exists(), "Cordis daemon fixture socket not ready");
    let run = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_rccv4"))
            .current_dir("/tmp")
            .env("RCCV4_STATE_ROOT", &state_root)
            .env("HOME", &test_root)
            .env("RCCV4_CORDIS_HOST_SOCKET", &socket)
            .args(args)
            .output()
            .expect("lifecycle command")
    };
    let start = run(&["start", "-c", config.to_str().expect("config"), "--snap"]);
    assert!(
        start.status.success(),
        "{}\ncordis={}\nruntime={}",
        String::from_utf8_lossy(&start.stderr),
        fs::read_to_string(cordis_stderr).unwrap_or_default(),
        fs::read_to_string(state_root.join("logs/rccv4.log")).unwrap_or_default()
    );
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline && TcpStream::connect(("127.0.0.1", port)).is_err() {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        TcpStream::connect(("127.0.0.1", port)).is_ok(),
        "listener not ready"
    );
    let first_pid = status_pid(&run(&["status", "-c", config.to_str().expect("config")]).stdout);
    let takeover = run(&["start", "-c", config.to_str().expect("config"), "--snap"]);
    assert!(
        takeover.status.success(),
        "{}",
        String::from_utf8_lossy(&takeover.stderr)
    );
    assert!(String::from_utf8_lossy(&takeover.stdout).contains("state=running"));
    let second_pid = status_pid(&run(&["status", "-c", config.to_str().expect("config")]).stdout);
    assert_ne!(
        first_pid, second_pid,
        "start must cold-start a fresh managed child"
    );
    let status = run(&["status", "-c", config.to_str().expect("config")]);
    assert!(status.status.success());
    assert!(String::from_utf8_lossy(&status.stdout).contains("state=running"));
    let restart = run(&["restart", "-c", config.to_str().expect("config")]);
    assert!(
        restart.status.success(),
        "{}",
        String::from_utf8_lossy(&restart.stderr)
    );
    let stop = run(&["stop", "-c", config.to_str().expect("config")]);
    assert!(
        stop.status.success(),
        "{}",
        String::from_utf8_lossy(&stop.stderr)
    );
    assert!(!state_root.join("instance.json").exists());
    let _ = cordis.kill();
    let _ = cordis.wait();
}

#[test]
fn restart_cold_starts_when_no_managed_instance_exists() {
    let test_root = root("cold-restart");
    let state_root = std::path::PathBuf::from("/tmp").join(format!(
        "rccv4-cold-restart-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
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
    let restart = run(&["restart", "-c", config.to_str().expect("config")]);
    assert!(
        restart.status.success(),
        "restart must bootstrap the project Cordis host: {}",
        String::from_utf8_lossy(&restart.stderr)
    );
    let stop = run(&["stop", "-c", config.to_str().expect("config")]);
    assert!(stop.status.success(), "{}", String::from_utf8_lossy(&stop.stderr));
}

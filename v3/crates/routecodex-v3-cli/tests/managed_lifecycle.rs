use serde_json::Value;
use std::fs;
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};
use tempfile::TempDir;

const SECRET: &str = "managed-lifecycle-controlled-secret";

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn write_config(root: &TempDir, ports: [u16; 2]) -> PathBuf {
    let path = root.path().join("config.v3.toml");
    fs::write(
        &path,
        format!(
            r#"version = 3
[features]
responses_direct = true
[servers.a]
bind = "127.0.0.1"
port = {}
routing_group = "default"
endpoints = ["responses"]
[servers.b]
bind = "127.0.0.1"
port = {}
routing_group = "default"
endpoints = ["responses"]
[providers.test]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_MANAGED_TEST_KEY" }}] }}
[providers.test.models.test]
wire_name = "wire-test"
capabilities = ["text", "streaming"]
supports_streaming = true
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "test", model = "test", key = "key", priority = 1 }}]
"#,
            ports[0], ports[1]
        ),
    )
    .unwrap();
    path
}

fn run(binary: &str, state_root: &Path, config: &Path, command: &str) -> Output {
    run_with_pid(binary, state_root, config, command).1
}

fn run_with_pid(binary: &str, state_root: &Path, config: &Path, command: &str) -> (u32, Output) {
    let child = Command::new(binary)
        .args(["server", command, "--config"])
        .arg(config)
        .env("ROUTECODEX_V3_STATE_DIR", state_root)
        .env("V3_MANAGED_TEST_KEY", SECRET)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let pid = child.id();
    let output = child.wait_with_output().unwrap();
    (pid, output)
}

fn run_with_timeout(
    binary: &str,
    state_root: &Path,
    config: &Path,
    command: &str,
    timeout_ms: u64,
) -> Output {
    Command::new(binary)
        .args(["server", command, "--config"])
        .arg(config)
        .arg("--timeout-ms")
        .arg(timeout_ms.to_string())
        .env("ROUTECODEX_V3_STATE_DIR", state_root)
        .env("V3_MANAGED_TEST_KEY", SECRET)
        .output()
        .unwrap()
}

fn last_json(output: &Output) -> Value {
    let stdout = String::from_utf8(output.stdout.clone()).unwrap();
    serde_json::from_str(stdout.lines().last().unwrap()).unwrap()
}

fn wait_port(port: u16, open: bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let is_open = TcpStream::connect(("127.0.0.1", port)).is_ok();
        if is_open == open {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "port {port} open={is_open}, wanted {open}"
        );
        sleep(Duration::from_millis(50));
    }
}

fn single_instance_dir(state_root: &Path) -> PathBuf {
    let entries = fs::read_dir(state_root.join("instances"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(entries.len(), 1);
    entries[0].clone()
}

fn scan_instance_files_for_secret(instance_dir: &Path) {
    let mut projected = String::new();
    for entry in fs::read_dir(instance_dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_file() {
            projected.push_str(&String::from_utf8_lossy(&fs::read(path).unwrap()));
        }
    }
    assert!(!projected.contains(SECRET));
}

fn copy_release_binary(source: &str, release_root: &Path) -> PathBuf {
    let binary = release_root.join("bin").join("rccv3");
    fs::create_dir_all(binary.parent().unwrap()).unwrap();
    fs::copy(source, &binary).unwrap();
    fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
    binary
}

#[test]
fn managed_cli_start_status_restart_stop_is_one_aggregate_identity() {
    let root = TempDir::new().unwrap();
    let state_root = root.path().join("state");
    let ports = [free_port(), free_port()];
    let config = write_config(&root, ports);
    let binary = env!("CARGO_BIN_EXE_rccv3");

    let start = run(binary, &state_root, &config, "start");
    assert!(
        start.status.success(),
        "{}",
        String::from_utf8_lossy(&start.stderr)
    );
    let started = last_json(&start);
    assert_eq!(started["state"], "running");
    for port in ports {
        wait_port(port, true);
    }

    let instance_dir = single_instance_dir(&state_root);
    let first_pid: Value =
        serde_json::from_slice(&fs::read(instance_dir.join("pid.cache")).unwrap()).unwrap();
    let first_nonce = first_pid["start_nonce"].as_str().unwrap().to_string();

    let status = run(binary, &state_root, &config, "status");
    assert!(status.status.success());
    assert_eq!(last_json(&status)["state"], "running");

    let control_path = instance_dir.join("control.json");
    let original_control = fs::read(&control_path).unwrap();
    let mut wrong_control: Value = serde_json::from_slice(&original_control).unwrap();
    wrong_control["start_nonce"] = Value::String("wrong-nonce".to_string());
    fs::write(&control_path, serde_json::to_vec(&wrong_control).unwrap()).unwrap();
    let wrong_identity = run(binary, &state_root, &config, "status");
    assert!(!wrong_identity.status.success());
    assert!(String::from_utf8_lossy(&wrong_identity.stderr).contains("IdentityMismatch"));
    fs::write(&control_path, original_control).unwrap();

    let duplicate = run(binary, &state_root, &config, "start");
    assert!(!duplicate.status.success());
    let duplicate_stderr = String::from_utf8_lossy(&duplicate.stderr);
    assert!(
        duplicate_stderr.contains("AlreadyRunning") || duplicate_stderr.contains("already running"),
        "{duplicate_stderr}"
    );

    let restart = run(binary, &state_root, &config, "restart");
    assert!(
        restart.status.success(),
        "{}",
        String::from_utf8_lossy(&restart.stderr)
    );
    assert_eq!(last_json(&restart)["instance_id"], started["instance_id"]);
    let second_pid: Value =
        serde_json::from_slice(&fs::read(instance_dir.join("pid.cache")).unwrap()).unwrap();
    assert_ne!(second_pid["start_nonce"].as_str().unwrap(), first_nonce);
    for port in ports {
        wait_port(port, true);
    }

    let stop = run(binary, &state_root, &config, "stop");
    assert!(
        stop.status.success(),
        "{}",
        String::from_utf8_lossy(&stop.stderr)
    );
    assert_eq!(last_json(&stop)["state"], "stopped");
    for port in ports {
        wait_port(port, false);
    }
    let stopped = run(binary, &state_root, &config, "status");
    assert!(stopped.status.success());
    assert_eq!(last_json(&stopped)["state"], "stopped");
    let already_stopped = run(binary, &state_root, &config, "stop");
    assert!(!already_stopped.status.success());
    assert!(String::from_utf8_lossy(&already_stopped.stderr).contains("NotRunning"));

    scan_instance_files_for_secret(&instance_dir);
}

#[test]
fn managed_child_survives_start_cli_exit_and_is_controlled_by_new_cli_processes() {
    let root = TempDir::new().unwrap();
    let state_root = root.path().join("state");
    let ports = [free_port(), free_port()];
    let config = write_config(&root, ports);
    let binary = env!("CARGO_BIN_EXE_rccv3");

    let (start_cli_pid, start) = run_with_pid(binary, &state_root, &config, "start");
    assert!(
        start.status.success(),
        "{}",
        String::from_utf8_lossy(&start.stderr)
    );
    let started = last_json(&start);
    assert_eq!(started["state"], "running");
    for port in ports {
        wait_port(port, true);
    }

    let instance_dir = single_instance_dir(&state_root);
    let first_pid: Value =
        serde_json::from_slice(&fs::read(instance_dir.join("pid.cache")).unwrap()).unwrap();
    let managed_child_pid = first_pid["pid"].as_u64().unwrap();
    assert_ne!(managed_child_pid, u64::from(start_cli_pid));

    let status_from_new_cli = run(binary, &state_root, &config, "status");
    assert!(
        status_from_new_cli.status.success(),
        "{}",
        String::from_utf8_lossy(&status_from_new_cli.stderr)
    );
    assert_eq!(last_json(&status_from_new_cli)["state"], "running");

    let restart_from_new_cli = run_with_timeout(binary, &state_root, &config, "restart", 15_000);
    assert!(
        restart_from_new_cli.status.success(),
        "{}",
        String::from_utf8_lossy(&restart_from_new_cli.stderr)
    );
    assert_eq!(
        last_json(&restart_from_new_cli)["instance_id"],
        started["instance_id"]
    );
    let second_pid: Value =
        serde_json::from_slice(&fs::read(instance_dir.join("pid.cache")).unwrap()).unwrap();
    assert_ne!(second_pid["pid"].as_u64().unwrap(), managed_child_pid);
    for port in ports {
        wait_port(port, true);
    }

    let stop_from_new_cli = run_with_timeout(binary, &state_root, &config, "stop", 15_000);
    assert!(
        stop_from_new_cli.status.success(),
        "{}",
        String::from_utf8_lossy(&stop_from_new_cli.stderr)
    );
    for port in ports {
        wait_port(port, false);
    }
    scan_instance_files_for_secret(&instance_dir);
}

#[test]
fn stopped_instance_restarts_from_next_release_snapshot_executable() {
    let root = TempDir::new().unwrap();
    let state_root = root.path().join("state");
    let ports = [free_port(), free_port()];
    let config = write_config(&root, ports);
    let source_binary = env!("CARGO_BIN_EXE_rccv3");
    let first_release = copy_release_binary(source_binary, &root.path().join("release-a"));
    let second_release = copy_release_binary(source_binary, &root.path().join("release-b"));

    let first_start = run(
        first_release.to_str().unwrap(),
        &state_root,
        &config,
        "start",
    );
    assert!(
        first_start.status.success(),
        "{}",
        String::from_utf8_lossy(&first_start.stderr)
    );
    let first_instance_id = last_json(&first_start)["instance_id"].clone();
    let first_stop = run(
        first_release.to_str().unwrap(),
        &state_root,
        &config,
        "stop",
    );
    assert!(
        first_stop.status.success(),
        "{}",
        String::from_utf8_lossy(&first_stop.stderr)
    );
    for port in ports {
        wait_port(port, false);
    }

    let second_start = run(
        second_release.to_str().unwrap(),
        &state_root,
        &config,
        "start",
    );
    assert!(
        second_start.status.success(),
        "{}",
        String::from_utf8_lossy(&second_start.stderr)
    );
    assert_eq!(last_json(&second_start)["instance_id"], first_instance_id);
    for port in ports {
        wait_port(port, true);
    }

    let instance_dir = single_instance_dir(&state_root);
    let declaration: Value =
        serde_json::from_slice(&fs::read(instance_dir.join("instance.json")).unwrap()).unwrap();
    assert_eq!(
        declaration["executable_path"],
        fs::canonicalize(&second_release)
            .unwrap()
            .display()
            .to_string()
    );

    let second_stop = run(
        second_release.to_str().unwrap(),
        &state_root,
        &config,
        "stop",
    );
    assert!(
        second_stop.status.success(),
        "{}",
        String::from_utf8_lossy(&second_stop.stderr)
    );
    for port in ports {
        wait_port(port, false);
    }
    scan_instance_files_for_secret(&instance_dir);
}

#[test]
fn unknown_port_owner_is_not_stopped_or_taken_over() {
    let root = TempDir::new().unwrap();
    let state_root = root.path().join("state");
    let occupied = TcpListener::bind("127.0.0.1:0").unwrap();
    let occupied_port = occupied.local_addr().unwrap().port();
    let config = write_config(&root, [occupied_port, free_port()]);
    let binary = env!("CARGO_BIN_EXE_rccv3");
    let start = run(binary, &state_root, &config, "start");
    assert!(!start.status.success());
    assert!(
        String::from_utf8_lossy(&start.stderr).contains("Address already in use"),
        "{}",
        String::from_utf8_lossy(&start.stderr)
    );
    assert_eq!(occupied.local_addr().unwrap().port(), occupied_port);
    assert!(TcpStream::connect(("127.0.0.1", occupied_port)).is_ok());
    let instance_dir = single_instance_dir(&state_root);
    let status: Value =
        serde_json::from_slice(&fs::read(instance_dir.join("status.json")).unwrap()).unwrap();
    assert_eq!(status["state"], "failed");
}

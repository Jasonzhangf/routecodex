use serde_json::Value;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};
use tempfile::TempDir;

const SECRET: &str = "managed-lifecycle-controlled-secret";

const HUB_V1_TEST_DECLARATION: &str = r#"
[pipelines.hub_v1]
skeleton = "hub_v1"
entry_protocols = ["responses", "anthropic", "gemini", "openai_chat"]
hook_set_id = "hub_v1.default"
entry_protocol_bindings = [
  { entry_protocol = "responses", endpoint_patterns = ["/v1/responses"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_default_transport_debug_and_continuation", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" },
  { entry_protocol = "anthropic", endpoint_patterns = ["/v1/messages"], execution_mode = "relay", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Anthropic Messages endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_anthropic_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs" },
  { entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "relay", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs" },
  { entry_protocol = "gemini", endpoint_patterns = ["/v1beta/models/:model/generateContent"], execution_mode = "relay", protocol_profile_owner = "v3.gemini_relay_runtime_integration", implemented = true, forbidden_reentry_behavior = "Gemini endpoint must not fall through to pending or direct runtime.", runtime_owner_symbol = "execute_v3_gemini_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs" },
]
resources = { metadata_center = { kind = "control", scope = "request" }, continuation_store = { kind = "continuation", scope = "server" }, error_chain = { kind = "error", scope = "request" }, debug_artifact = { kind = "debug", scope = "debug" }, snapshot_buffer = { kind = "snapshot", scope = "debug" }, provider_health = { kind = "provider_health", scope = "provider" } }
hooks = [
  { hook_id = "hub_v1.V3HubReqInbound01ClientRaw.entry.not_implemented", node = "V3HubReqInbound01ClientRaw", phase = "entry", requirement = "required", priority = 0, order = 0, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqInbound01ClientRaw.exit.not_implemented", node = "V3HubReqInbound01ClientRaw", phase = "exit", requirement = "required", priority = 0, order = 1, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqInbound02Normalized.entry.not_implemented", node = "V3HubReqInbound02Normalized", phase = "entry", requirement = "required", priority = 0, order = 2, allowed_resources = ["metadata_center"], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqInbound02Normalized.exit.not_implemented", node = "V3HubReqInbound02Normalized", phase = "exit", requirement = "optional", enabled = false, priority = 0, order = 3, allowed_resources = [], forbidden_resources = ["continuation_store"] },
  { hook_id = "hub_v1.V3HubReqContinuation03Classified.entry.not_implemented", node = "V3HubReqContinuation03Classified", phase = "entry", requirement = "required", priority = 0, order = 4, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqContinuation03Classified.exit.not_implemented", node = "V3HubReqContinuation03Classified", phase = "exit", requirement = "required", priority = 0, order = 5, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqChatProcess04Governed.entry.not_implemented", node = "V3HubReqChatProcess04Governed", phase = "entry", requirement = "required", priority = 0, order = 6, allowed_resources = ["continuation_store"], forbidden_resources = [], profile = "servertool" },
  { hook_id = "hub_v1.V3HubReqChatProcess04Governed.exit.not_implemented", node = "V3HubReqChatProcess04Governed", phase = "exit", requirement = "required", priority = 0, order = 7, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqExecution05Planned.entry.not_implemented", node = "V3HubReqExecution05Planned", phase = "entry", requirement = "required", priority = 0, order = 8, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqExecution05Planned.exit.not_implemented", node = "V3HubReqExecution05Planned", phase = "exit", requirement = "required", priority = 0, order = 9, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqTarget06Resolved.entry.not_implemented", node = "V3HubReqTarget06Resolved", phase = "entry", requirement = "required", priority = 0, order = 10, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqTarget06Resolved.exit.not_implemented", node = "V3HubReqTarget06Resolved", phase = "exit", requirement = "required", priority = 0, order = 11, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqOutbound07ProviderSemantic.entry.not_implemented", node = "V3HubReqOutbound07ProviderSemantic", phase = "entry", requirement = "required", priority = 0, order = 12, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubReqOutbound07ProviderSemantic.exit.not_implemented", node = "V3HubReqOutbound07ProviderSemantic", phase = "exit", requirement = "required", priority = 0, order = 13, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderReqOutbound08WirePayload.entry.not_implemented", node = "V3ProviderReqOutbound08WirePayload", phase = "entry", requirement = "required", priority = 0, order = 14, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderReqOutbound08WirePayload.exit.not_implemented", node = "V3ProviderReqOutbound08WirePayload", phase = "exit", requirement = "required", priority = 0, order = 15, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderReqOutbound09TransportRequest.entry.not_implemented", node = "V3ProviderReqOutbound09TransportRequest", phase = "entry", requirement = "required", priority = 0, order = 16, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderReqOutbound09TransportRequest.exit.not_implemented", node = "V3ProviderReqOutbound09TransportRequest", phase = "exit", requirement = "required", priority = 0, order = 17, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderRespInbound01Raw.entry.not_implemented", node = "V3ProviderRespInbound01Raw", phase = "entry", requirement = "required", priority = 0, order = 18, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderRespInbound01Raw.exit.not_implemented", node = "V3ProviderRespInbound01Raw", phase = "exit", requirement = "required", priority = 0, order = 19, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespInbound02Normalized.entry.not_implemented", node = "V3HubRespInbound02Normalized", phase = "entry", requirement = "required", priority = 0, order = 20, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespInbound02Normalized.exit.not_implemented", node = "V3HubRespInbound02Normalized", phase = "exit", requirement = "required", priority = 0, order = 21, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespChatProcess03Governed.entry.not_implemented", node = "V3HubRespChatProcess03Governed", phase = "entry", requirement = "required", priority = 0, order = 22, allowed_resources = ["continuation_store"], forbidden_resources = [], profile = "servertool" },
  { hook_id = "hub_v1.V3HubRespChatProcess03Governed.exit.not_implemented", node = "V3HubRespChatProcess03Governed", phase = "exit", requirement = "required", priority = 0, order = 23, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespContinuation04Committed.entry.not_implemented", node = "V3HubRespContinuation04Committed", phase = "entry", requirement = "required", priority = 0, order = 24, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespContinuation04Committed.exit.not_implemented", node = "V3HubRespContinuation04Committed", phase = "exit", requirement = "required", priority = 0, order = 25, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespOutbound05ClientSemantic.entry.not_implemented", node = "V3HubRespOutbound05ClientSemantic", phase = "entry", requirement = "required", priority = 0, order = 26, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespOutbound05ClientSemantic.exit.not_implemented", node = "V3HubRespOutbound05ClientSemantic", phase = "exit", requirement = "required", priority = 0, order = 27, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ServerRespOutbound06ClientFrame.entry.not_implemented", node = "V3ServerRespOutbound06ClientFrame", phase = "entry", requirement = "required", priority = 0, order = 28, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ServerRespOutbound06ClientFrame.exit.not_implemented", node = "V3ServerRespOutbound06ClientFrame", phase = "exit", requirement = "required", priority = 0, order = 29, allowed_resources = [], forbidden_resources = [] },
]
"#;

const HUB_V1_TEST_SERVER_EXECUTION: &str = r#"
[servers.a.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }

[servers.b.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }
"#;

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn write_config(root: &TempDir, ports: [u16; 2]) -> PathBuf {
    write_config_with_snapshots(root, ports, true)
}

fn write_config_with_snapshots(root: &TempDir, ports: [u16; 2], snapshots: bool) -> PathBuf {
    write_config_with_debug(root, ports, snapshots, true)
}

fn write_config_with_debug(
    root: &TempDir,
    ports: [u16; 2],
    snapshots: bool,
    log_console: bool,
) -> PathBuf {
    let path = root.path().join("config.v3.toml");
    let hub_v1_declaration = HUB_V1_TEST_DECLARATION;
    let hub_v1_server_execution = HUB_V1_TEST_SERVER_EXECUTION;
    let port_a = ports[0];
    let port_b = ports[1];
    let snapshots = if snapshots { "true" } else { "false" };
    let log_console = if log_console { "true" } else { "false" };
    fs::write(
        &path,
        format!(
            r#"version = 3
{hub_v1_declaration}
[features]
responses_direct = true
[debug]
log_console = {log_console}
snapshots = {snapshots}
dry_run = true
retention = {{ raw_requests = 4, raw_responses = 4, events = 32 }}
[servers.a]
bind = "127.0.0.1"
port = {port_a}
routing_group = "default"
endpoints = ["responses", "anthropic", "gemini", "openai_chat"]
[servers.b]
bind = "127.0.0.1"
port = {port_b}
routing_group = "default"
endpoints = ["responses", "anthropic", "gemini", "openai_chat"]
{hub_v1_server_execution}
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
"#
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

fn run_top_level(binary: &str, state_root: &Path, config: &Path, command: &str) -> Output {
    Command::new(binary)
        .args([command, "--config"])
        .arg(config)
        .env("ROUTECODEX_V3_STATE_DIR", state_root)
        .env("V3_MANAGED_TEST_KEY", SECRET)
        .output()
        .unwrap()
}

fn assert_empty_stdout(output: &Output, label: &str) {
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.trim().is_empty(),
        "{label} must stay background-compatible and not print success JSON/stdout, got:\n{stdout}"
    );
}

fn last_json(output: &Output) -> Value {
    let stdout = String::from_utf8(output.stdout.clone()).unwrap();
    serde_json::from_str(stdout.lines().last().unwrap()).unwrap()
}

fn status_json(binary: &str, state_root: &Path, config: &Path) -> Value {
    let status = run(binary, state_root, config, "status");
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    last_json(&status)
}

fn top_level_status_json(binary: &str, state_root: &Path, config: &Path) -> Value {
    let status = run_top_level(binary, state_root, config, "status");
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    last_json(&status)
}

fn spawn_top_level_start(binary: &str, state_root: &Path, config: &Path) -> Child {
    Command::new(binary)
        .args(["start", "--config"])
        .arg(config)
        .env("ROUTECODEX_V3_STATE_DIR", state_root)
        .env("V3_MANAGED_TEST_KEY", SECRET)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

fn spawn_top_level_start_with_args(
    binary: &str,
    state_root: &Path,
    config: &Path,
    extra_args: &[&str],
) -> Child {
    let mut command = Command::new(binary);
    command.args(["start", "--config"]).arg(config);
    command.args(extra_args);
    command
        .env("ROUTECODEX_V3_STATE_DIR", state_root)
        .env("V3_MANAGED_TEST_KEY", SECRET)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

fn spawn_top_level_start_without_config(binary: &str, state_root: &Path, home: &Path) -> Child {
    Command::new(binary)
        .arg("start")
        .env("HOME", home)
        .env("ROUTECODEX_V3_STATE_DIR", state_root)
        .env("V3_MANAGED_TEST_KEY", SECRET)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

fn run_top_level_without_config(
    binary: &str,
    state_root: &Path,
    home: &Path,
    command: &str,
) -> Output {
    Command::new(binary)
        .arg(command)
        .env("HOME", home)
        .env("ROUTECODEX_V3_STATE_DIR", state_root)
        .env("V3_MANAGED_TEST_KEY", SECRET)
        .output()
        .unwrap()
}

fn send_responses_dry_run_request(port: u16) {
    let body = r#"{"model":"test","input":"console probe","stream":false}"#;
    let request = format!(
        "POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nx-routecodex-dry-run: provider-request\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.write_all(request.as_bytes()).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    assert!(
        response.starts_with("HTTP/1.1 200"),
        "dry-run response must succeed, got:\n{response}"
    );
}

fn http_get_json(port: u16, path: &str) -> Value {
    let request =
        format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.write_all(request.as_bytes()).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(
        response.starts_with("HTTP/1.1 200"),
        "GET {path} must succeed, got:\n{response}"
    );
    let (_, body) = response
        .split_once("\r\n\r\n")
        .expect("HTTP response must contain a body separator");
    serde_json::from_str(body).unwrap()
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

fn spawn_sigterm_resistant_listener(port: u16) -> Child {
    let script = format!(
        r#"
const net = require('net');
process.on('SIGTERM', () => {{}});
const server = net.createServer((socket) => socket.end());
server.listen({{ host: '127.0.0.1', port: {} }});
setInterval(() => {{}}, 1000);
"#,
        port
    );
    let child = Command::new("node")
        .args(["-e", &script])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    wait_port(port, true);
    child
}

fn single_instance_dir(state_root: &Path) -> PathBuf {
    let entries = fs::read_dir(state_root.join("instances"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(entries.len(), 1);
    entries[0].clone()
}

fn wait_status_file_state(instance_dir: &Path, expected: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(bytes) = fs::read(instance_dir.join("status.json")) {
            let status: Value = serde_json::from_slice(&bytes).unwrap();
            if status["state"] == expected {
                return status;
            }
        }
        assert!(
            Instant::now() < deadline,
            "managed status did not reach {expected}"
        );
        sleep(Duration::from_millis(50));
    }
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
    assert_empty_stdout(&start, "server start");
    let started = status_json(binary, &state_root, &config);
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
    if !duplicate.status.success() {
        let _ = run(binary, &state_root, &config, "stop");
        panic!(
            "duplicate start must take over like old rcc start: {}",
            String::from_utf8_lossy(&duplicate.stderr)
        );
    }
    assert_empty_stdout(&duplicate, "duplicate server start");
    assert_eq!(
        status_json(binary, &state_root, &config)["instance_id"],
        started["instance_id"]
    );
    let takeover_pid: Value =
        serde_json::from_slice(&fs::read(instance_dir.join("pid.cache")).unwrap()).unwrap();
    assert!(
        takeover_pid["start_nonce"].as_str().unwrap() != first_nonce,
        "duplicate start must stop and restart the managed child"
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
    assert_ne!(
        second_pid["start_nonce"].as_str().unwrap(),
        takeover_pid["start_nonce"].as_str().unwrap()
    );
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
fn top_level_start_status_restart_stop_match_legacy_cli_shape() {
    let root = TempDir::new().unwrap();
    let state_root = root.path().join("state");
    let ports = [free_port(), free_port()];
    let config = write_config_with_debug(&root, ports, true, false);
    let binary = env!("CARGO_BIN_EXE_rccv3");

    let start = spawn_top_level_start(binary, &state_root, &config);
    for port in ports {
        wait_port(port, true);
    }
    let started = top_level_status_json(binary, &state_root, &config);
    assert_eq!(started["state"], "running");
    send_responses_dry_run_request(ports[0]);

    let status = run_top_level(binary, &state_root, &config, "status");
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    assert_eq!(last_json(&status)["state"], "running");

    let restart = run_top_level(binary, &state_root, &config, "restart");
    assert!(
        restart.status.success(),
        "{}",
        String::from_utf8_lossy(&restart.stderr)
    );
    assert_eq!(last_json(&restart)["instance_id"], started["instance_id"]);
    for port in ports {
        wait_port(port, true);
    }

    let stop = run_top_level(binary, &state_root, &config, "stop");
    assert!(
        stop.status.success(),
        "{}",
        String::from_utf8_lossy(&stop.stderr)
    );
    assert_eq!(last_json(&stop)["state"], "stopped");
    for port in ports {
        wait_port(port, false);
    }
    let start_output = start.wait_with_output().unwrap();
    assert!(
        start_output.status.success(),
        "{}",
        String::from_utf8_lossy(&start_output.stderr)
    );
    let start_stdout = String::from_utf8_lossy(&start_output.stdout);
    assert!(
        start_stdout.contains("V3ServerStartup01ListenerSetPreflight"),
        "top-level start must stream server startup console even when config log_console=false, got:\n{start_stdout}"
    );
    assert!(
        start_stdout.contains("V3Server03HttpRequestRaw"),
        "top-level start must stream server request console/debug output even when config log_console=false, got:\n{start_stdout}"
    );
    assert!(
        !start_stdout.contains("\"schema_version\":1,\"instance_id\"")
            && !start_stdout.contains("starting a on"),
        "top-level start must not print CLI status JSON or invented starting lines, got:\n{start_stdout}"
    );
}

#[test]
fn top_level_lifecycle_without_config_uses_home_config_v3_toml() {
    let root = TempDir::new().unwrap();
    let state_root = root.path().join("state");
    let home = root.path().join("home");
    let default_config = home.join(".rcc").join("config.v3.toml");
    fs::create_dir_all(default_config.parent().unwrap()).unwrap();
    let ports = [free_port(), free_port()];
    let source_config = write_config(&root, ports);
    fs::copy(&source_config, &default_config).unwrap();
    let binary = env!("CARGO_BIN_EXE_rccv3");

    let start = spawn_top_level_start_without_config(binary, &state_root, &home);
    for port in ports {
        wait_port(port, true);
    }
    let status = run_top_level_without_config(binary, &state_root, &home, "status");
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    assert_eq!(last_json(&status)["state"], "running");

    let stop = run_top_level_without_config(binary, &state_root, &home, "stop");
    assert!(
        stop.status.success(),
        "{}",
        String::from_utf8_lossy(&stop.stderr)
    );
    for port in ports {
        wait_port(port, false);
    }
    let start_output = start.wait_with_output().unwrap();
    assert!(
        start_output.status.success(),
        "{}",
        String::from_utf8_lossy(&start_output.stderr)
    );
}

#[test]
fn top_level_start_snap_forces_debug_snapshots() {
    let root = TempDir::new().unwrap();
    let state_root = root.path().join("state");
    let ports = [free_port(), free_port()];
    let config = write_config_with_snapshots(&root, ports, false);
    let binary = env!("CARGO_BIN_EXE_rccv3");

    let start = spawn_top_level_start_with_args(binary, &state_root, &config, &["--snap"]);
    for port in ports {
        wait_port(port, true);
    }
    let debug = http_get_json(ports[0], "/_routecodex/debug/status");
    assert_eq!(debug["debug"]["snapshots_enabled"], true);

    let stop = run_top_level(binary, &state_root, &config, "stop");
    assert!(
        stop.status.success(),
        "{}",
        String::from_utf8_lossy(&stop.stderr)
    );
    for port in ports {
        wait_port(port, false);
    }
    let start_output = start.wait_with_output().unwrap();
    assert!(
        start_output.status.success(),
        "{}",
        String::from_utf8_lossy(&start_output.stderr)
    );
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
    assert_empty_stdout(&start, "server start");
    let started = status_json(binary, &state_root, &config);
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
    assert_empty_stdout(&first_start, "first release start");
    let first_instance_id =
        status_json(first_release.to_str().unwrap(), &state_root, &config)["instance_id"].clone();
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
    assert_empty_stdout(&second_start, "second release start");
    assert_eq!(
        status_json(second_release.to_str().unwrap(), &state_root, &config)["instance_id"],
        first_instance_id
    );
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
fn start_force_kills_explicit_listener_pid_after_graceful_timeout() {
    let root = TempDir::new().unwrap();
    let state_root = root.path().join("state");
    let occupied_port = free_port();
    let mut occupied = spawn_sigterm_resistant_listener(occupied_port);
    let config = write_config(&root, [occupied_port, free_port()]);
    let binary = env!("CARGO_BIN_EXE_rccv3");
    let mut start = Command::new(binary)
        .args(["start", "--config"])
        .arg(&config)
        .env("ROUTECODEX_V3_STATE_DIR", &state_root)
        .env("V3_MANAGED_TEST_KEY", SECRET)
        .env("ROUTECODEX_V3_STOP_TIMEOUT_MS", "200")
        .env("ROUTECODEX_V3_KILL_TIMEOUT_MS", "800")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline && occupied.try_wait().unwrap().is_none() {
        sleep(Duration::from_millis(50));
    }
    if occupied.try_wait().unwrap().is_none() {
        let _ = occupied.kill();
        let _ = occupied.wait();
        let _ = start.kill();
        let output = start.wait_with_output().unwrap();
        panic!(
            "start must free explicit listener PID before binding: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let killed = occupied.wait().unwrap();
    assert!(
        !killed.success(),
        "SIGTERM-resistant listener must be force-killed"
    );
    wait_port(occupied_port, true);
    let instance_dir = single_instance_dir(&state_root);
    assert_eq!(
        wait_status_file_state(&instance_dir, "running")["state"],
        "running"
    );
    let stop = run(binary, &state_root, &config, "stop");
    assert!(
        stop.status.success(),
        "{}",
        String::from_utf8_lossy(&stop.stderr)
    );
    wait_port(occupied_port, false);
    let start_output = start.wait_with_output().unwrap();
    assert!(
        start_output.status.success(),
        "{}",
        String::from_utf8_lossy(&start_output.stderr)
    );
}

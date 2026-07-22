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
  { hook_id = "hub_v1.ProviderReqCompat06ProviderCompat.entry.not_implemented", node = "ProviderReqCompat06ProviderCompat", phase = "entry", requirement = "required", priority = 0, order = 14, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.ProviderReqCompat06ProviderCompat.exit.not_implemented", node = "ProviderReqCompat06ProviderCompat", phase = "exit", requirement = "required", priority = 0, order = 15, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderReqOutbound08WirePayload.entry.not_implemented", node = "V3ProviderReqOutbound08WirePayload", phase = "entry", requirement = "required", priority = 0, order = 16, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderReqOutbound08WirePayload.exit.not_implemented", node = "V3ProviderReqOutbound08WirePayload", phase = "exit", requirement = "required", priority = 0, order = 17, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderReqOutbound09TransportRequest.entry.not_implemented", node = "V3ProviderReqOutbound09TransportRequest", phase = "entry", requirement = "required", priority = 0, order = 18, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderReqOutbound09TransportRequest.exit.not_implemented", node = "V3ProviderReqOutbound09TransportRequest", phase = "exit", requirement = "required", priority = 0, order = 19, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderRespInbound01Raw.entry.not_implemented", node = "V3ProviderRespInbound01Raw", phase = "entry", requirement = "required", priority = 0, order = 20, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ProviderRespInbound01Raw.exit.not_implemented", node = "V3ProviderRespInbound01Raw", phase = "exit", requirement = "required", priority = 0, order = 21, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.ProviderRespCompat02ProviderCompat.entry.not_implemented", node = "ProviderRespCompat02ProviderCompat", phase = "entry", requirement = "required", priority = 0, order = 22, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.ProviderRespCompat02ProviderCompat.exit.not_implemented", node = "ProviderRespCompat02ProviderCompat", phase = "exit", requirement = "required", priority = 0, order = 23, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespInbound02Normalized.entry.not_implemented", node = "V3HubRespInbound02Normalized", phase = "entry", requirement = "required", priority = 0, order = 24, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespInbound02Normalized.exit.not_implemented", node = "V3HubRespInbound02Normalized", phase = "exit", requirement = "required", priority = 0, order = 25, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespChatProcess03Governed.entry.not_implemented", node = "V3HubRespChatProcess03Governed", phase = "entry", requirement = "required", priority = 0, order = 26, allowed_resources = ["continuation_store"], forbidden_resources = [], profile = "servertool" },
  { hook_id = "hub_v1.V3HubRespChatProcess03Governed.exit.not_implemented", node = "V3HubRespChatProcess03Governed", phase = "exit", requirement = "required", priority = 0, order = 27, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespContinuation04Committed.entry.not_implemented", node = "V3HubRespContinuation04Committed", phase = "entry", requirement = "required", priority = 0, order = 28, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespContinuation04Committed.exit.not_implemented", node = "V3HubRespContinuation04Committed", phase = "exit", requirement = "required", priority = 0, order = 29, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespOutbound05ClientSemantic.entry.not_implemented", node = "V3HubRespOutbound05ClientSemantic", phase = "entry", requirement = "required", priority = 0, order = 30, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3HubRespOutbound05ClientSemantic.exit.not_implemented", node = "V3HubRespOutbound05ClientSemantic", phase = "exit", requirement = "required", priority = 0, order = 31, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ServerRespOutbound06ClientFrame.entry.not_implemented", node = "V3ServerRespOutbound06ClientFrame", phase = "entry", requirement = "required", priority = 0, order = 32, allowed_resources = [], forbidden_resources = [] },
  { hook_id = "hub_v1.V3ServerRespOutbound06ClientFrame.exit.not_implemented", node = "V3ServerRespOutbound06ClientFrame", phase = "exit", requirement = "required", priority = 0, order = 33, allowed_resources = [], forbidden_resources = [] },
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
capabilities = ["text"]
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

fn write_config_with_server_b_enabled(
    root: &TempDir,
    filename: &str,
    ports: [u16; 2],
    server_b_enabled: bool,
) -> PathBuf {
    let path = root.path().join(filename);
    let hub_v1_declaration = HUB_V1_TEST_DECLARATION;
    let hub_v1_server_execution = HUB_V1_TEST_SERVER_EXECUTION;
    let port_a = ports[0];
    let port_b = ports[1];
    let server_b_enabled = if server_b_enabled { "true" } else { "false" };
    fs::write(
        &path,
        format!(
            r#"version = 3
{hub_v1_declaration}
[features]
responses_direct = true
[debug]
log_console = true
snapshots = true
dry_run = true
retention = {{ raw_requests = 4, raw_responses = 4, events = 32 }}
[servers.a]
bind = "127.0.0.1"
port = {port_a}
routing_group = "default"
endpoints = ["responses", "anthropic", "gemini", "openai_chat"]
[servers.b]
enabled = {server_b_enabled}
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
capabilities = ["text"]
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
        .env(
            "ROUTECODEX_REQUEST_ID_COUNTER_FILE",
            request_counter_file(state_root),
        )
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
        .env(
            "ROUTECODEX_REQUEST_ID_COUNTER_FILE",
            request_counter_file(state_root),
        )
        .env("V3_MANAGED_TEST_KEY", SECRET)
        .output()
        .unwrap()
}

fn run_top_level(binary: &str, state_root: &Path, config: &Path, command: &str) -> Output {
    Command::new(binary)
        .args([command, "--config"])
        .arg(config)
        .env("ROUTECODEX_V3_STATE_DIR", state_root)
        .env(
            "ROUTECODEX_REQUEST_ID_COUNTER_FILE",
            request_counter_file(state_root),
        )
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
        .env(
            "ROUTECODEX_REQUEST_ID_COUNTER_FILE",
            request_counter_file(state_root),
        )
        .env("ROUTECODEX_FORCE_LOG_COLOR", "1")
        .env("V3_MANAGED_TEST_KEY", SECRET)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

fn spawn_top_level_start_with_args_and_home(
    binary: &str,
    state_root: &Path,
    config: &Path,
    extra_args: &[&str],
    home: &Path,
) -> Child {
    let mut command = Command::new(binary);
    command.args(["start", "--config"]).arg(config);
    command.args(extra_args);
    command
        .env("HOME", home)
        .env("ROUTECODEX_V3_STATE_DIR", state_root)
        .env(
            "ROUTECODEX_REQUEST_ID_COUNTER_FILE",
            request_counter_file(state_root),
        )
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
        .env(
            "ROUTECODEX_REQUEST_ID_COUNTER_FILE",
            request_counter_file(state_root),
        )
        .env("V3_MANAGED_TEST_KEY", SECRET)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

fn request_counter_file(state_root: &Path) -> PathBuf {
    state_root.join("request-id-counter.json")
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

fn send_responses_dry_run_request(port: u16, session_id: &str, workdir: &Path) {
    let body = format!(
        r#"{{"model":"test","input":"console probe","stream":false,"client_metadata":{{"session_id":"{session_id}","thread_id":"thread-{session_id}"}}}}"#
    );
    let request = format!(
        "POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nx-routecodex-dry-run: provider-request\r\nx-routecodex-workdir: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        workdir.display(),
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

fn send_invalid_json_request(port: u16) {
    let body = r#"{"model":"test","input":"broken""#;
    let request = format!(
        "POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
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
        response.starts_with("HTTP/1.1 400"),
        "invalid JSON response must fail visibly, got:\n{response}"
    );
}

fn send_path_not_found_request(port: u16) {
    let request = format!(
        "GET /not-registered HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.write_all(request.as_bytes()).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    assert!(
        response.starts_with("HTTP/1.1 404"),
        "unknown path response must fail visibly, got:\n{response}"
    );
}

fn leading_ansi_color(line: &str) -> Option<String> {
    if !line.starts_with("\u{1b}[") {
        return None;
    }
    let end = line.find('m')?;
    Some(line[..=end].to_string())
}

fn request_id_from_line(line: &str) -> Option<&str> {
    let marker = " request ";
    let start = line.find(marker)? + marker.len();
    let rest = &line[start..];
    let end = rest.find(' ')?;
    Some(&rest[..end])
}

fn request_counter_suffix_from_line(line: &str) -> Option<(u64, u64)> {
    let request_id = request_id_from_line(line)?;
    let mut parts = request_id.rsplit('-');
    let daily = parts.next()?.parse::<u64>().ok()?;
    let total = parts.next()?.parse::<u64>().ok()?;
    Some((total, daily))
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

fn spawn_sigterm_resistant_multi_listener(ports: [u16; 2]) -> Child {
    let script = format!(
        r#"
const net = require('net');
process.on('SIGTERM', () => {{}});
for (const port of [{}, {}]) {{
  net.createServer((socket) => socket.end()).listen({{ host: '127.0.0.1', port }});
}}
setInterval(() => {{}}, 1000);
"#,
        ports[0], ports[1]
    );
    let child = Command::new("node")
        .args(["-e", &script])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    wait_port(ports[0], true);
    wait_port(ports[1], true);
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
    assert_eq!(
        second_pid["pid"].as_u64().unwrap(),
        takeover_pid["pid"].as_u64().unwrap(),
        "managed restart must exec in place and preserve the server PID"
    );
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
    let vr_status = http_get_json(ports[0], "/_routecodex/diagnostics/virtual-router/status");
    assert_eq!(vr_status["ok"], true);
    assert_eq!(vr_status["serverId"], "a");
    assert_eq!(vr_status["localPort"], ports[0]);
    assert_eq!(vr_status["routingPolicyGroup"], "default");
    assert_eq!(
        vr_status["virtualRouter"]["routes"]["default"]["pools"][0]["poolId"],
        "default"
    );
    send_responses_dry_run_request(ports[0], "console-alpha", root.path());
    send_responses_dry_run_request(ports[0], "console-beta", root.path());
    send_invalid_json_request(ports[0]);
    send_path_not_found_request(ports[0]);

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
    send_responses_dry_run_request(ports[0], "console-after-restart", root.path());

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
    let start_stderr = String::from_utf8_lossy(&start_output.stderr);
    assert!(
        start_stdout.contains("[RouteCodexV3] rccv3 start version=")
            && start_stdout.contains(" crate=")
            && start_stdout.contains(" binary=")
            && start_stdout.contains(" config=")
            && start_stdout.contains(" snap="),
        "top-level start must print the exact rccv3 binary/config/snap version line before streaming server logs, got:\n{start_stdout}"
    );
    assert!(
        start_stdout.contains("[RouteCodexV3] Server started version=")
            && start_stdout.contains(" crate=")
            && start_stdout.contains(" binary=")
            && start_stdout.contains(" on "),
        "top-level start must stream standard human startup status with version/binary evidence even when config log_console=false, got:\n{start_stdout}"
    );
    assert!(
        start_stdout
            .matches("[RouteCodexV3] Server started version=")
            .count()
            >= 2,
        "top-level restart must exec in place and keep streaming startup console output to the original foreground session, got:\n{start_stdout}"
    );
    assert!(
        start_stdout.contains("▶ [/v1/responses]")
            && start_stdout.contains("request ")
            && start_stdout.contains(" started")
            && start_stdout.contains("rawInputItems=1")
            && start_stdout.contains("preparedInputItems=1")
            && start_stdout.contains("\u{1b}["),
        "top-level start must stream colorized old production request monitor output even when config log_console=false, got:\n{start_stdout}"
    );
    let started_lines = start_stdout
        .lines()
        .filter(|line| line.contains("▶ [/v1/responses]"))
        .collect::<Vec<_>>();
    assert!(
        started_lines.len() >= 3,
        "top-level start must show every request start, got:\n{start_stdout}"
    );
    let request_counters = started_lines
        .iter()
        .take(2)
        .filter_map(|line| request_counter_suffix_from_line(line))
        .collect::<Vec<_>>();
    assert_eq!(
        request_counters,
        vec![(1, 1), (2, 2)],
        "visible request ids must use production total/daily suffix counters, got:\n{start_stdout}"
    );
    for line in started_lines.iter().take(2) {
        let request_id = request_id_from_line(line).unwrap();
        assert!(
            request_id.starts_with("openai-responses-router-test-")
                && !request_id.contains("-req-"),
            "request id must use production entry-provider-model timestamp shape, got {request_id}"
        );
        assert!(
            request_id.contains('T'),
            "request id must include production timestamp, got {request_id}"
        );
    }
    let invalid_error_id = start_stderr
        .lines()
        .find(|line| line.contains("❌ [/v1/responses]"))
        .and_then(request_id_from_line)
        .expect("invalid JSON error line must include a request id");
    assert!(
        invalid_error_id.starts_with("openai-responses-router-unknown-")
            && invalid_error_id.ends_with("-3-3"),
        "pre-body errors must still allocate production-shaped total/daily request id, got stderr:\n{start_stderr}"
    );
    let unknown_path_error_id = start_stderr
        .lines()
        .find(|line| line.contains("❌ [/not-registered]"))
        .and_then(request_id_from_line)
        .expect("unknown path error line must include a request id");
    assert!(
        unknown_path_error_id.starts_with("openai-chat-router-unknown-")
            && unknown_path_error_id.ends_with("-4-4")
            && !start_stderr.contains("❌ [unknown]")
            && !start_stderr.contains("request pre-request failed"),
        "404 errors must use endpoint path and continuous production-shaped request id, got stderr:\n{start_stderr}"
    );
    let first_color = leading_ansi_color(started_lines[0]).expect("first session must be colored");
    let second_color =
        leading_ansi_color(started_lines[1]).expect("second session must be colored");
    assert_ne!(
        first_color, second_color,
        "different client sessions must resolve to different foreground colors, got:\n{start_stdout}"
    );
    assert!(
        start_stdout.contains("[virtual-router-hit]")
            && start_stdout.contains("req=openai-responses-router-test-")
            && start_stdout.contains("sid=console-alpha")
            && start_stdout.contains(" -> test[key].wire-test")
            && start_stdout.contains("reason=provider-request-dry-run")
            && !start_stdout.contains("🎯 [/v1/responses]"),
        "foreground monitor must use the V2 virtual-router-hit route/provider shape, got:\n{start_stdout}"
    );
    assert!(
        start_stdout.contains("✅ [/v1/responses]")
            && start_stdout.contains("status=200")
            && !start_stdout.contains("providerStatus=200")
            && start_stdout.contains("nodes=")
            && start_stdout.contains("elapsedMs=")
            && start_stdout.contains("finish_reason=")
            && !start_stdout.contains("finishReason="),
        "foreground monitor must show V2 snake-case finish_reason without repeating providerStatus=200, got:\n{start_stdout}"
    );
    assert!(
        start_stdout.contains("[usage]")
            && start_stdout.contains("usage=")
            && start_stdout.contains("project=")
            && start_stdout.contains(&format!(":{}", ports[0]))
            && start_stdout.contains("route=router-direct:provider-request-dry-run")
            && start_stdout.contains("model=test->wire-test")
            && start_stdout.contains("finish_reason=")
            && start_stdout.contains("time=i:")
            && start_stdout.contains(" e:")
            && start_stdout.contains(" t:")
            && !start_stdout.contains("finishReason="),
        "foreground monitor must show the V2 usage summary shape, got:\n{start_stdout}"
    );
    assert!(
        start_stderr.contains("\u{1b}[31m")
            && start_stderr.contains("❌ [/v1/responses]")
            && start_stderr.contains("error=V3E")
            && start_stderr.contains("subcode=")
            && !start_stderr.contains("request pre-request failed")
            && !start_stderr.contains("errorChain="),
        "foreground errors must be red, compact, and use the continuous request id instead of pre-request, got stderr:\n{start_stderr}"
    );
    assert!(
        !start_stdout.contains("\"schema_version\":1,\"instance_id\"")
            && !start_stdout.contains("starting a on")
            && !start_stdout.contains("\"node_id\":\"V3ServerStartup01ListenerSetPreflight\""),
        "top-level start must not print CLI status JSON, raw debug JSON, or invented starting lines, got:\n{start_stdout}"
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
    let home = root.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let ports = [free_port(), free_port()];
    let config = write_config_with_snapshots(&root, ports, false);
    let binary = env!("CARGO_BIN_EXE_rccv3");

    let start =
        spawn_top_level_start_with_args_and_home(binary, &state_root, &config, &["--snap"], &home);
    for port in ports {
        wait_port(port, true);
    }
    let debug = http_get_json(ports[0], "/_routecodex/debug/status");
    assert_eq!(debug["debug"]["snapshots_enabled"], true);
    let expected_log_file = home
        .join(".rcc")
        .join("logs")
        .join(format!("server-{}.log", ports[0]));
    assert_eq!(
        debug["debug"]["log_file"],
        expected_log_file.display().to_string(),
        "foreground start must project the production-style server log file path"
    );
    send_responses_dry_run_request(ports[0], "snap-log-file", root.path());
    let log_text = fs::read_to_string(&expected_log_file).unwrap();
    assert!(
        log_text.contains("▶ [/v1/responses]")
            && log_text.contains("\u{1b}[")
            && log_text.contains("[virtual-router-hit]")
            && log_text.contains("✅ [/v1/responses]")
            && log_text.contains("[usage]"),
        "foreground dry-run must persist the same colorized V2-shaped human monitor lines into server log, got:\n{log_text}"
    );

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
fn top_level_restart_snap_forces_debug_snapshots() {
    let root = TempDir::new().unwrap();
    let state_root = root.path().join("state");
    let ports = [free_port(), free_port()];
    let config = write_config_with_snapshots(&root, ports, false);
    let binary = env!("CARGO_BIN_EXE_rccv3");

    let start = run(binary, &state_root, &config, "start");
    assert!(
        start.status.success(),
        "{}",
        String::from_utf8_lossy(&start.stderr)
    );
    for port in ports {
        wait_port(port, true);
    }
    let before = http_get_json(ports[0], "/_routecodex/debug/status");
    assert_eq!(before["debug"]["snapshots_enabled"], false);

    let restart = Command::new(binary)
        .args(["restart", "--config"])
        .arg(&config)
        .arg("--snap")
        .env("ROUTECODEX_V3_STATE_DIR", &state_root)
        .env(
            "ROUTECODEX_REQUEST_ID_COUNTER_FILE",
            request_counter_file(&state_root),
        )
        .env("V3_MANAGED_TEST_KEY", SECRET)
        .output()
        .unwrap();
    assert!(
        restart.status.success(),
        "{}",
        String::from_utf8_lossy(&restart.stderr)
    );
    for port in ports {
        wait_port(port, true);
    }
    let after = http_get_json(ports[0], "/_routecodex/debug/status");
    assert_eq!(after["debug"]["snapshots_enabled"], true);

    let stop = run_top_level(binary, &state_root, &config, "stop");
    assert!(
        stop.status.success(),
        "{}",
        String::from_utf8_lossy(&stop.stderr)
    );
    for port in ports {
        wait_port(port, false);
    }
}

#[test]
fn top_level_start_snap_stages_enable_local_stage_selector() {
    let root = TempDir::new().unwrap();
    let state_root = root.path().join("state");
    let home = root.path().join("home");
    fs::create_dir_all(&home).unwrap();
    let ports = [free_port(), free_port()];
    let config = write_config_with_snapshots(&root, ports, false);
    let binary = env!("CARGO_BIN_EXE_rccv3");

    let start = spawn_top_level_start_with_args_and_home(
        binary,
        &state_root,
        &config,
        &["--snap-stages", "client-request,provider-request"],
        &home,
    );
    for port in ports {
        wait_port(port, true);
    }
    let debug = http_get_json(ports[0], "/_routecodex/debug/status");
    assert_eq!(debug["debug"]["snapshots_enabled"], true);
    assert_eq!(
        debug["debug"]["snapshot_stages"],
        "client-request,provider-request"
    );

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
    let managed_child_nonce = first_pid["start_nonce"].as_str().unwrap().to_string();
    let managed_executable_path =
        serde_json::from_slice::<Value>(&fs::read(instance_dir.join("instance.json")).unwrap())
            .unwrap()["executable_path"]
            .as_str()
            .unwrap()
            .to_string();
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
    let second_declaration: Value =
        serde_json::from_slice(&fs::read(instance_dir.join("instance.json")).unwrap()).unwrap();
    assert_eq!(
        second_declaration["executable_path"].as_str().unwrap(),
        managed_executable_path,
        "same-binary restart must preserve the originally published executable path"
    );
    assert_eq!(
        second_pid["pid"].as_u64().unwrap(),
        managed_child_pid,
        "restart must exec the running managed child in place instead of spawning a replacement PID"
    );
    assert_ne!(
        second_pid["start_nonce"].as_str().unwrap(),
        managed_child_nonce,
        "restart must republish a fresh control nonce after exec"
    );
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
fn running_instance_restart_execs_next_release_snapshot_in_place() {
    let root = TempDir::new().unwrap();
    let state_root = root.path().join("state");
    let ports = [free_port(), free_port()];
    let config = write_config(&root, ports);
    let source_binary = env!("CARGO_BIN_EXE_rccv3");
    let first_release = copy_release_binary(source_binary, &root.path().join("active-release-a"));
    let second_release = copy_release_binary(source_binary, &root.path().join("active-release-b"));

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
    for port in ports {
        wait_port(port, true);
    }

    let instance_dir = single_instance_dir(&state_root);
    let first_pid: Value =
        serde_json::from_slice(&fs::read(instance_dir.join("pid.cache")).unwrap()).unwrap();
    let pid_before = first_pid["pid"].as_u64().unwrap();
    let nonce_before = first_pid["start_nonce"].as_str().unwrap().to_string();
    let first_instance_id =
        status_json(first_release.to_str().unwrap(), &state_root, &config)["instance_id"].clone();

    let restart_from_next_release = run_with_timeout(
        second_release.to_str().unwrap(),
        &state_root,
        &config,
        "restart",
        15_000,
    );
    assert!(
        restart_from_next_release.status.success(),
        "{}",
        String::from_utf8_lossy(&restart_from_next_release.stderr)
    );
    assert_eq!(
        last_json(&restart_from_next_release)["instance_id"],
        first_instance_id
    );
    for port in ports {
        wait_port(port, true);
    }

    let second_pid: Value =
        serde_json::from_slice(&fs::read(instance_dir.join("pid.cache")).unwrap()).unwrap();
    assert_eq!(
        second_pid["pid"].as_u64().unwrap(),
        pid_before,
        "restart from the next release must exec in place and preserve the managed PID"
    );
    assert_ne!(
        second_pid["start_nonce"].as_str().unwrap(),
        nonce_before,
        "restart from the next release must republish a fresh control nonce"
    );
    let declaration: Value =
        serde_json::from_slice(&fs::read(instance_dir.join("instance.json")).unwrap()).unwrap();
    assert_eq!(
        declaration["executable_path"],
        fs::canonicalize(&second_release)
            .unwrap()
            .display()
            .to_string(),
        "restart must re-enter the executable path supplied by the current restart command"
    );
    assert!(
        !instance_dir.join("restart.plan.json").exists(),
        "the restarted managed child must consume and remove the nonce-bound restart plan"
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

#[test]
fn start_releases_only_overlapping_port_from_foreign_managed_instance() {
    let root = TempDir::new().unwrap();
    let state_root = root.path().join("state");
    let shared_port = free_port();
    let sibling_port = free_port();
    let inactive_single_config_port = free_port();
    let aggregate_config = write_config_with_server_b_enabled(
        &root,
        "aggregate.v3.toml",
        [shared_port, sibling_port],
        true,
    );
    let single_port_config = write_config_with_server_b_enabled(
        &root,
        "single.v3.toml",
        [shared_port, inactive_single_config_port],
        false,
    );
    let binary = env!("CARGO_BIN_EXE_rccv3");

    let aggregate_start = run(binary, &state_root, &aggregate_config, "start");
    assert!(
        aggregate_start.status.success(),
        "{}",
        String::from_utf8_lossy(&aggregate_start.stderr)
    );
    wait_port(shared_port, true);
    wait_port(sibling_port, true);
    let aggregate_status = status_json(binary, &state_root, &aggregate_config);
    assert_eq!(aggregate_status["state"], "running");

    let single_start = run(binary, &state_root, &single_port_config, "start");
    let single_start_success = single_start.status.success();
    let shared_port_open = TcpStream::connect(("127.0.0.1", shared_port)).is_ok();
    let sibling_still_open = TcpStream::connect(("127.0.0.1", sibling_port)).is_ok();
    let aggregate_status_after_release = run(binary, &state_root, &aggregate_config, "status");
    let aggregate_still_running = aggregate_status_after_release.status.success()
        && last_json(&aggregate_status_after_release)["state"] == "running";

    let _ = run(binary, &state_root, &single_port_config, "stop");
    let _ = run(binary, &state_root, &aggregate_config, "stop");
    wait_port(shared_port, false);
    wait_port(sibling_port, false);

    assert!(
        single_start_success,
        "{}",
        String::from_utf8_lossy(&single_start.stderr)
    );
    assert!(
        shared_port_open,
        "single-port V3 start must own the overlapping configured port"
    );
    assert!(
        sibling_still_open,
        "single-port V3 start must not stop a sibling listener from a foreign multi-port managed instance"
    );
    assert!(
        aggregate_still_running,
        "foreign managed instance control plane must remain live after port-scoped release"
    );
}

#[test]
fn foreign_background_start_releasing_all_ports_disconnects_foreground_owner() {
    let root = TempDir::new().unwrap();
    let state_root = root.path().join("state");
    let shared_port = free_port();
    let inactive_port_a = free_port();
    let inactive_port_b = free_port();
    let foreground_config = write_config_with_server_b_enabled(
        &root,
        "foreground-single.v3.toml",
        [shared_port, inactive_port_a],
        false,
    );
    let background_config = write_config_with_server_b_enabled(
        &root,
        "background-single.v3.toml",
        [shared_port, inactive_port_b],
        false,
    );
    let binary = env!("CARGO_BIN_EXE_rccv3");

    let mut foreground = spawn_top_level_start(binary, &state_root, &foreground_config);
    wait_port(shared_port, true);
    assert_eq!(
        top_level_status_json(binary, &state_root, &foreground_config)["state"],
        "running"
    );

    let background_start = run(binary, &state_root, &background_config, "start");
    assert!(
        background_start.status.success(),
        "{}",
        String::from_utf8_lossy(&background_start.stderr)
    );
    wait_port(shared_port, true);

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if foreground.try_wait().unwrap().is_some() {
            break;
        }
        if Instant::now() >= deadline {
            let _ = run(binary, &state_root, &background_config, "stop");
            let _ = run(binary, &state_root, &foreground_config, "stop");
            panic!(
                "foreground owner must exit when a foreign background start releases its final listener port"
            );
        }
        sleep(Duration::from_millis(50));
    }

    let foreground_output = foreground.wait_with_output().unwrap();
    assert!(
        foreground_output.status.success(),
        "{}",
        String::from_utf8_lossy(&foreground_output.stderr)
    );
    let foreground_status = run_top_level(binary, &state_root, &foreground_config, "status");
    assert!(foreground_status.status.success());
    assert_eq!(last_json(&foreground_status)["state"], "stopped");

    let background_status = status_json(binary, &state_root, &background_config);
    assert_eq!(background_status["state"], "running");
    let stop = run(binary, &state_root, &background_config, "stop");
    assert!(
        stop.status.success(),
        "{}",
        String::from_utf8_lossy(&stop.stderr)
    );
    wait_port(shared_port, false);
}

#[test]
fn start_refuses_to_signal_unmanaged_listener_pid_that_owns_sibling_ports() {
    let root = TempDir::new().unwrap();
    let state_root = root.path().join("state");
    let target_port = free_port();
    let sibling_port = free_port();
    let inactive_single_config_port = free_port();
    let mut unmanaged = spawn_sigterm_resistant_multi_listener([target_port, sibling_port]);
    let single_port_config = write_config_with_server_b_enabled(
        &root,
        "single.v3.toml",
        [target_port, inactive_single_config_port],
        false,
    );
    let binary = env!("CARGO_BIN_EXE_rccv3");

    let start = Command::new(binary)
        .args(["server", "start", "--config"])
        .arg(&single_port_config)
        .env("ROUTECODEX_V3_STATE_DIR", &state_root)
        .env("V3_MANAGED_TEST_KEY", SECRET)
        .env("ROUTECODEX_V3_STOP_TIMEOUT_MS", "200")
        .env("ROUTECODEX_V3_KILL_TIMEOUT_MS", "200")
        .output()
        .unwrap();
    let target_still_open = TcpStream::connect(("127.0.0.1", target_port)).is_ok();
    let sibling_still_open = TcpStream::connect(("127.0.0.1", sibling_port)).is_ok();
    let stderr = String::from_utf8_lossy(&start.stderr).to_string();

    let _ = unmanaged.kill();
    let _ = unmanaged.wait();
    wait_port(target_port, false);
    wait_port(sibling_port, false);

    assert!(
        !start.status.success(),
        "start must fail explicitly instead of killing an unmanaged multi-port PID"
    );
    assert!(
        stderr.contains("refusing to signal listener PID")
            && stderr.contains("non-target listener ports"),
        "start must expose the scoped PID refusal, got:\n{stderr}"
    );
    assert!(
        target_still_open,
        "target port must remain owned by the unmanaged process after scoped refusal"
    );
    assert!(
        sibling_still_open,
        "sibling port must not be stopped when only one target port is configured"
    );
}

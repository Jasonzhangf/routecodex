use super::*;

const FAILED_EXEC_RESTART_CHILD_ENV: &str = "ROUTECODEX_TEST_FAILED_EXEC_RESTART_CHILD";
const FAILED_EXEC_RESTART_TEST_FILTER: &str = "tests::codex_sample_persistence::failed_exec_restart_keeps_sample_persistence_failure_and_handoff_files";

struct SamplePersistenceTestEnvironment {
    previous_home: Option<std::ffi::OsString>,
    previous_key: Option<std::ffi::OsString>,
}

impl SamplePersistenceTestEnvironment {
    fn new(home: &std::path::Path) -> Self {
        fs::create_dir_all(home).unwrap();
        let previous_home = std::env::var_os("HOME");
        let previous_key = std::env::var_os("V3_LIFECYCLE_TEST_KEY");
        std::env::set_var("HOME", home);
        std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
        Self {
            previous_home,
            previous_key,
        }
    }
}

impl Drop for SamplePersistenceTestEnvironment {
    fn drop(&mut self) {
        if let Some(home) = &self.previous_home {
            std::env::set_var("HOME", home);
        } else {
            std::env::remove_var("HOME");
        }
        if let Some(key) = &self.previous_key {
            std::env::set_var("V3_LIFECYCLE_TEST_KEY", key);
        } else {
            std::env::remove_var("V3_LIFECYCLE_TEST_KEY");
        }
    }
}

async fn spawn_sample_persistence_failure_server(
    root: &std::path::Path,
    home: &std::path::Path,
    port: u16,
) -> (
    V3ManagedInstanceDeclaration,
    PathBuf,
    routecodex_v3_server::V3ServerAggregateHandle,
) {
    let (config, executable, state) = managed_fixture_with_port(root, port);
    let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state)
        .with_snapshots_enabled(true)
        .with_direct_snapshots_enabled(true);
    let (declaration, manifest) = lifecycle.declaration(&executable).unwrap();
    let handle = routecodex_v3_server::spawn_v3_server_aggregate(manifest)
        .await
        .unwrap();

    let samples_root = home
        .join(".rcc")
        .join("codex-samples")
        .join("openai-responses")
        .join("ports")
        .join(port.to_string());
    fs::create_dir_all(samples_root.parent().unwrap()).unwrap();
    fs::write(&samples_root, b"block sample directory creation").unwrap();

    let instance_dir = state.join("instances").join(&declaration.instance_id);
    (declaration, instance_dir, handle)
}

async fn sample_persistence_failure_http_roundtrip(listener_addr: std::net::SocketAddr) -> String {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

    let body = serde_json::json!({
        "model": "test",
        "input": "managed sample persistence failure",
    })
    .to_string();
    let header = format!(
        "POST /v1/responses HTTP/1.1\r\nHost: {listener_addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let mut stream = tokio::net::TcpStream::connect(listener_addr).await.unwrap();
    stream.write_all(header.as_bytes()).await.unwrap();
    stream.write_all(body.as_bytes()).await.unwrap();
    let mut response = tokio::io::BufReader::new(stream);
    let mut status_line = String::new();
    tokio::time::timeout(Duration::from_secs(5), response.read_line(&mut status_line))
        .await
        .unwrap()
        .unwrap();
    let mut response_headers = String::new();
    let mut content_length = None;
    let mut chunked = false;
    loop {
        let mut header = String::new();
        tokio::time::timeout(Duration::from_secs(5), response.read_line(&mut header))
            .await
            .unwrap()
            .unwrap();
        if header == "\r\n" {
            break;
        }
        if header.is_empty() {
            panic!("response closed before the header terminator: {status_line}{response_headers}");
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = Some(value.trim().parse::<usize>().unwrap());
            }
            if name.eq_ignore_ascii_case("transfer-encoding") {
                chunked = value
                    .split(',')
                    .any(|encoding| encoding.trim().eq_ignore_ascii_case("chunked"));
            }
        }
        response_headers.push_str(&header);
    }
    let mut response_body = Vec::new();
    if let Some(content_length) = content_length {
        response_body.resize(content_length, 0);
        tokio::time::timeout(Duration::from_secs(5), response.read_exact(&mut response_body))
            .await
            .unwrap()
            .unwrap();
    } else if chunked {
        loop {
            let mut size_line = String::new();
            tokio::time::timeout(Duration::from_secs(5), response.read_line(&mut size_line))
                .await
                .unwrap()
                .unwrap();
            let size = usize::from_str_radix(
                size_line
                    .trim_end_matches(['\r', '\n'])
                    .split(';')
                    .next()
                    .unwrap(),
                16,
            )
            .unwrap();
            if size == 0 {
                loop {
                    let mut trailer = String::new();
                    tokio::time::timeout(Duration::from_secs(5), response.read_line(&mut trailer))
                        .await
                        .unwrap()
                        .unwrap();
                    if trailer == "\r\n" || trailer.is_empty() {
                        break;
                    }
                }
                break;
            }
            let body_start = response_body.len();
            response_body.resize(body_start + size, 0);
            tokio::time::timeout(
                Duration::from_secs(5),
                response.read_exact(&mut response_body[body_start..]),
            )
            .await
            .unwrap()
            .unwrap();
            let mut chunk_end = [0; 2];
            tokio::time::timeout(Duration::from_secs(5), response.read_exact(&mut chunk_end))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(&chunk_end, b"\r\n");
        }
    } else {
        panic!("unsupported response framing: {status_line}{response_headers}");
    }
    format!(
        "{status_line}{response_headers}\r\n{}",
        String::from_utf8(response_body).unwrap()
    )
}

#[tokio::test]
async fn managed_shutdown_records_sample_persistence_failure_with_hooks_cleanup_detail() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    let home = root.path().join("home");
    let _environment = SamplePersistenceTestEnvironment::new(&home);
    let port = std::net::TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let (declaration, instance_dir, handle) =
        spawn_sample_persistence_failure_server(root.path(), &home, port).await;
    let response = sample_persistence_failure_http_roundtrip(handle.listeners[0].addr).await;
    assert!(response.starts_with("HTTP/1.1 502 "), "{response}");
    assert!(response.contains("\r\n\r\n"), "incomplete HTTP response: {response}");
    assert!(
        !response.contains("codex sample persistence shutdown failed"),
        "persistence diagnostics must not replace the client error response: {response}"
    );

    ensure_private_dir(&instance_dir).unwrap();
    let socket_path = instance_dir.join("managed-control.sock");
    let process_record_path = instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE);
    fs::write(&process_record_path, "sidecar-process").unwrap();
    let sidecar_child = tokio::process::Command::new("true").spawn().unwrap();
    let sidecar = V3HooksSidecarProcess::for_test(sidecar_child, 0, process_record_path.clone());

    shutdown_managed_runtime(
        &instance_dir,
        &declaration.instance_id,
        &socket_path,
        handle,
        V3HooksSidecarSupervisor::from_startup(
            instance_dir.clone(),
            tokio::spawn(async move { Ok(Some(sidecar)) }),
        ),
    )
    .await
    .unwrap();

    let status: V3ManagedStatusRecord = read_json(&instance_dir.join("status.json")).unwrap();
    assert_eq!(status.state, V3ManagedRunState::Stopped);
    let detail = status.detail.unwrap_or_default();
    assert!(
        detail.contains("codex sample persistence shutdown failed"),
        "{detail}"
    );
    assert!(detail.contains("request.json"), "{detail}");
    assert!(detail.contains("hooks sidecar shutdown failed"), "{detail}");
    assert!(process_record_path.exists());
}

#[tokio::test]
async fn failed_exec_restart_keeps_sample_persistence_failure_and_handoff_files() {
    let child_root = std::env::var_os(FAILED_EXEC_RESTART_CHILD_ENV);
    if child_root.is_none() {
        let root = TempDir::new().unwrap();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                FAILED_EXEC_RESTART_TEST_FILTER,
                "--nocapture",
            ])
            .env(FAILED_EXEC_RESTART_CHILD_ENV, root.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "isolated failed exec-restart process failed: status={} stdout={} stderr={}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let child_stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            child_stdout.contains(FAILED_EXEC_RESTART_TEST_FILTER),
            "isolated failed exec-restart process exited without running its target test: status={} stdout={} stderr={}",
            output.status,
            child_stdout,
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let root = PathBuf::from(child_root.unwrap());
    let home = root.join("home");
    let _environment = SamplePersistenceTestEnvironment::new(&home);
    let port = std::net::TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let (declaration, instance_dir, handle) =
        spawn_sample_persistence_failure_server(&root, &home, port).await;
    let response = sample_persistence_failure_http_roundtrip(handle.listeners[0].addr).await;
    assert!(response.starts_with("HTTP/1.1 502 "), "{response}");
    assert!(response.contains("\r\n\r\n"), "incomplete HTTP response: {response}");
    assert!(
        !response.contains("codex sample persistence shutdown failed"),
        "persistence diagnostics must not replace the client error response: {response}"
    );

    ensure_private_dir(&instance_dir).unwrap();
    let socket_path = instance_dir.join("managed-control.sock");
    fs::write(instance_dir.join("pid.cache"), "managed-pid").unwrap();
    fs::write(instance_dir.join("control.json"), "managed-control").unwrap();
    fs::write(&socket_path, "managed-socket").unwrap();
    let process_record_path = instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE);
    fs::write(&process_record_path, "sidecar-process").unwrap();
    let restart_plan_path = instance_dir.join(RESTART_PLAN_FILE);
    fs::write(&restart_plan_path, "restart-plan").unwrap();
    let sidecar_child = tokio::process::Command::new("true").spawn().unwrap();
    let sidecar = V3HooksSidecarProcess::for_test(sidecar_child, 0, process_record_path.clone());
    let expected_provider_handoff = serde_json::to_value(
        routecodex_v3_runtime::default_provider_transport_handoff_checkpoints(),
    )
    .unwrap();
    let restart_plan = ControlRestartPlan {
        control_instance_id: declaration.instance_id.clone(),
        declaration: declaration.clone(),
        executable_path: root.join("missing-replacement"),
        snapshots: true,
        snapshot_direct: true,
        snapshot_stages: None,
        sse_dump: false,
    };

    let error = restart_managed_runtime_in_place(
        &instance_dir,
        &socket_path,
        handle,
        V3HooksSidecarSupervisor::from_startup(
            instance_dir.clone(),
            tokio::spawn(async move { Ok(Some(sidecar)) }),
        ),
        restart_plan,
        false,
    )
    .await
    .unwrap_err();
    assert!(
        wait_for_listener_set_available(&declaration.listeners, Duration::from_secs(3)).await,
        "failed exec restart must release listener ports before the test runtime exits"
    );
    assert!(
        matches!(error, V3LifecycleError::Io(ref io) if io.kind() == std::io::ErrorKind::NotFound),
        "restart should report the missing replacement executable: {error}"
    );

    let status: V3ManagedStatusRecord = read_json(&instance_dir.join("status.json")).unwrap();
    assert_eq!(status.state, V3ManagedRunState::Failed);
    let detail = status.detail.unwrap_or_default();
    assert!(
        detail.contains("codex sample persistence shutdown failed during exec restart"),
        "{detail}"
    );
    assert!(detail.contains("request.json"), "{detail}");
    assert!(detail.contains("hooks sidecar shutdown failed"), "{detail}");
    assert!(detail.contains("exec restart failed"), "{detail}");

    let front_handoff: serde_json::Value =
        read_json(&instance_dir.join(FRONT_HANDOFF_FILE)).unwrap();
    assert!(front_handoff.is_array(), "{front_handoff}");
    let provider_handoff: serde_json::Value =
        read_json(&instance_dir.join(PROVIDER_HANDOFF_FILE)).unwrap();
    assert_eq!(provider_handoff, expected_provider_handoff);
    assert!(process_record_path.exists());
    assert!(!restart_plan_path.exists());
}

fn managed_fixture_with_port(root: &std::path::Path, port: u16) -> (PathBuf, PathBuf, PathBuf) {
    let config = root.join("managed-config.v3.toml");
    let executable = std::env::current_exe().unwrap();
    let state = root.join("managed-state");
    let hub_v1_declaration = super::hub_v1_fixture::hub_v1_test_declaration();
    let server_execution = super::hub_v1_fixture::hub_v1_server_execution("test");
    fs::write(
        &config,
        format!(
            r#"version = 3
{hub_v1_declaration}
[servers.test]
bind = "127.0.0.1"
port = {port}
routing_group = "default"
endpoints = ["responses"]
{server_execution}
[providers.test]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_LIFECYCLE_TEST_KEY" }}] }}
responses = {{ process = "chat", streaming = "always" }}
[providers.test.models.test]
wire_name = "wire-test"
aliases = ["client-test"]
capabilities = ["text", "tools"]
supports_streaming = true
supports_thinking = true
thinking = "optional"
max_tokens = 4096
max_context_tokens = 128000
[debug]
log_console = false
snapshots = true
dry_run = true
retention = {{ raw_requests = 8, raw_responses = 8, events = 64 }}
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "test", model = "test", key = "key", priority = 1 }}]
"#
        ),
    )
    .unwrap();
    (config, executable, state)
}

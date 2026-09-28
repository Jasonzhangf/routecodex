use super::*;

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
    root: &TempDir,
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
    tokio::task::spawn_blocking(move || {
        use std::io::{BufRead, BufReader, Write};

        let body = serde_json::json!({
            "model": "test",
            "input": "managed sample persistence failure",
        })
        .to_string();
        let header = format!(
            "POST /v1/responses HTTP/1.1\r\nHost: {listener_addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let mut stream = std::net::TcpStream::connect(listener_addr).unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        stream.write_all(header.as_bytes()).unwrap();
        stream.write_all(body.as_bytes()).unwrap();
        let mut response = BufReader::new(stream);
        let mut status_line = String::new();
        response.read_line(&mut status_line).unwrap();
        status_line
    })
    .await
    .unwrap()
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
        spawn_sample_persistence_failure_server(&root, &home, port).await;
    let response = sample_persistence_failure_http_roundtrip(handle.listeners[0].addr).await;
    assert!(response.starts_with("HTTP/1.1 502 "), "{response}");

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
        spawn_sample_persistence_failure_server(&root, &home, port).await;
    let response = sample_persistence_failure_http_roundtrip(handle.listeners[0].addr).await;
    assert!(response.starts_with("HTTP/1.1 502 "), "{response}");

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
        executable_path: root.path().join("missing-replacement"),
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

fn managed_fixture_with_port(root: &TempDir, port: u16) -> (PathBuf, PathBuf, PathBuf) {
    let config = root.path().join("managed-config.v3.toml");
    let executable = std::env::current_exe().unwrap();
    let state = root.path().join("managed-state");
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

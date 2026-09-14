use super::*;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::sync::Mutex;
use std::time::Instant;
use tempfile::TempDir;

static TEST_ENV_LOCK: Mutex<()> = Mutex::new(());
const TEST_HOOKS_INSTALL_RECORD_ENV: &str = "ROUTECODEX_HOOKS_INSTALL_RECORD";

#[test]
fn control_client_disconnect_is_not_a_managed_runtime_failure() {
    assert!(is_control_client_disconnect(&std::io::Error::new(
        std::io::ErrorKind::BrokenPipe,
        "control client closed",
    )));
    assert!(is_control_client_disconnect(&std::io::Error::new(
        std::io::ErrorKind::UnexpectedEof,
        "control client closed",
    )));
    assert!(is_control_client_disconnect(&std::io::Error::new(
        std::io::ErrorKind::ConnectionReset,
        "control client closed",
    )));
    assert!(!is_control_client_disconnect(&std::io::Error::new(
        std::io::ErrorKind::PermissionDenied,
        "control socket denied",
    )));
}

#[tokio::test]
async fn control_response_broken_pipe_is_nonfatal() {
    let (mut server, client) = UnixStream::pair().unwrap();
    drop(client);
    let response = ControlResponse {
        schema_version: SCHEMA_VERSION,
        instance_id: "v3-test".to_string(),
        accepted: true,
        state: V3ManagedRunState::Running,
        message: "identity verified".to_string(),
    };
    assert!(!write_control_response(&mut server, &response)
        .await
        .unwrap());
}

#[tokio::test]
#[cfg(unix)]
async fn configured_hooks_sidecar_requires_ready_protocol_and_stops_by_explicit_pid() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    let record_path = root.path().join("install.json");
    let daemon_config = root.path().join("hooksd.json");
    let supervisor_wrapper = root.path().join("supervisor-wrapper");
    let bin_directory = root.path().join("bin");
    fs::create_dir(&instance_dir).unwrap();
    fs::create_dir(&bin_directory).unwrap();
    fs::write(bin_directory.join("rccv3-codexapp"), "").unwrap();
    fs::write(&daemon_config, "{}").unwrap();
    fs::write(
        &supervisor_wrapper,
        "#!/bin/sh\nprintf '%s\\n' '{\"protocol\":\"routecodex-hooks-supervisor/v1\",\"ready\":true}'\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n",
    )
    .unwrap();
    let mut permissions = fs::metadata(&supervisor_wrapper).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&supervisor_wrapper, permissions).unwrap();
    fs::write(
        &record_path,
        serde_json::json!({
            "supervisor_enabled": true,
            "supervisor_wrapper": supervisor_wrapper,
            "daemon_config": daemon_config,
            "bin_directory": bin_directory,
            "install_root": root.path(),
        })
        .to_string(),
    )
    .unwrap();
    std::env::set_var(TEST_HOOKS_INSTALL_RECORD_ENV, &record_path);
    let sidecar = start_configured_hooks_sidecar(&instance_dir)
        .await
        .unwrap()
        .expect("enabled test sidecar must start");
    sidecar.stop().await.unwrap();
    std::env::remove_var(TEST_HOOKS_INSTALL_RECORD_ENV);
}

#[tokio::test]
#[cfg(unix)]
async fn delayed_hooks_stop_retries_owned_codexapp_socket_cleanup() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let root = TempDir::new_in("/tmp").unwrap();
    let instance_dir = root.path().join("instance");
    let socket_path = root.path().join("codexapp.sock");
    let process_record_path = instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE);
    fs::create_dir(&instance_dir).unwrap();
    let _socket = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();
    let install_root = root.path().to_path_buf();
    let child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg("trap 'exit 0' TERM INT; while :; do sleep 1; done")
        .process_group(0)
        .spawn()
        .unwrap();
    let process_group_id = child.id().unwrap() as libc::pid_t;
    fs::write(&process_record_path, "delayed cleanup record").unwrap();
    let sidecar = V3HooksSidecarProcess::for_test_with_owned_socket_cleanup(
        child,
        process_group_id,
        process_record_path.clone(),
        socket_path.clone(),
        install_root,
    );

    sidecar.stop().await.unwrap();

    assert!(!socket_path.exists());
    assert!(!process_record_path.exists());
}

#[tokio::test]
#[cfg(unix)]
async fn failed_hooks_sidecar_is_degraded_without_removing_runtime_control() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    let record_path = root.path().join("install.json");
    let daemon_config = root.path().join("hooksd.json");
    let supervisor_wrapper = root.path().join("supervisor-wrapper");
    let supervisor_started = root.path().join("supervisor-started");
    let bin_directory = root.path().join("bin");
    let socket_path = root.path().join("routecodex-control.sock");
    fs::create_dir(&instance_dir).unwrap();
    fs::create_dir(&bin_directory).unwrap();
    let codexapp_binary = bin_directory.join("rccv3-codexapp");
    fs::write(&codexapp_binary, "#!/bin/sh\nexit 0\n").unwrap();
    let mut codexapp_permissions = fs::metadata(&codexapp_binary).unwrap().permissions();
    codexapp_permissions.set_mode(0o755);
    fs::set_permissions(&codexapp_binary, codexapp_permissions).unwrap();
    fs::write(&daemon_config, "{}").unwrap();
    fs::write(
        &supervisor_wrapper,
        format!(
            "#!/bin/sh\nprintf 'started\\n' > '{}'\nexit 17\n",
            supervisor_started.display()
        ),
    )
    .unwrap();
    let mut permissions = fs::metadata(&supervisor_wrapper).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&supervisor_wrapper, permissions).unwrap();
    fs::write(
        &record_path,
        serde_json::json!({
            "supervisor_enabled": true,
            "supervisor_wrapper": supervisor_wrapper,
            "daemon_config": daemon_config,
            "bin_directory": bin_directory,
            "install_root": root.path(),
        })
        .to_string(),
    )
    .unwrap();
    fs::write(instance_dir.join("pid.cache"), "runtime-pid").unwrap();
    fs::write(instance_dir.join("control.json"), "runtime-control").unwrap();
    fs::write(&socket_path, "runtime-socket-marker").unwrap();
    std::env::set_var(TEST_HOOKS_INSTALL_RECORD_ENV, &record_path);

    let started_at = Instant::now();
    let (sidecar, detail) = start_managed_hooks_sidecar(&instance_dir).await.unwrap();
    assert!(started_at.elapsed() < Duration::from_secs(2));

    assert!(sidecar.is_none());
    assert!(detail.unwrap().contains("hooks sidecar unavailable"));
    assert!(supervisor_started.exists());
    assert!(instance_dir.join("pid.cache").exists());
    assert!(instance_dir.join("control.json").exists());
    assert!(socket_path.exists());
    write_status(
        &instance_dir,
        "degraded-instance",
        V3ManagedRunState::Running,
        Some("hooks sidecar unavailable: hooks sidecar exited before readiness".to_string()),
    )
    .unwrap();
    assert_eq!(
        read_live_status_detail(&instance_dir, "degraded-instance").unwrap(),
        Some("hooks sidecar unavailable: hooks sidecar exited before readiness".to_string())
    );
    std::env::remove_var(TEST_HOOKS_INSTALL_RECORD_ENV);
}

#[tokio::test]
#[cfg(unix)]
async fn failed_hooks_sidecar_forced_group_cleanup_removes_codexapp_socket() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    let record_path = root.path().join("install.json");
    let daemon_config = root.path().join("hooksd.json");
    let supervisor_wrapper = root.path().join("supervisor-wrapper");
    let bin_directory = root.path().join("bin");
    let codexapp_socket = root.path().join("codexapp.sock");
    let pid_path = root.path().join("supervisor-wrapper.pid");
    fs::create_dir(&instance_dir).unwrap();
    fs::create_dir(&bin_directory).unwrap();
    fs::write(bin_directory.join("rccv3-codexapp"), "").unwrap();
    fs::write(
        &daemon_config,
        serde_json::json!({"codexapp": {"socket": codexapp_socket}}).to_string(),
    )
    .unwrap();
    fs::write(
        &supervisor_wrapper,
        format!(
            "#!/bin/sh\necho $$ > '{}'\nnode -e 'const net=require(\"net\"); const server=net.createServer(); server.listen(process.argv[1]); setInterval(() => {{}}, 1000);' '{}' &\nsleep 1\nprintf '%s\\n' '{{\"protocol\":\"wrong\",\"ready\":false}}'\ntrap '' TERM INT\nwhile :; do sleep 1; done\n",
            pid_path.display(),
            codexapp_socket.display(),
        ),
    )
    .unwrap();
    let mut permissions = fs::metadata(&supervisor_wrapper).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&supervisor_wrapper, permissions).unwrap();
    fs::write(
        &record_path,
        serde_json::json!({
            "supervisor_enabled": true,
            "supervisor_wrapper": supervisor_wrapper,
            "daemon_config": daemon_config,
            "bin_directory": bin_directory,
            "install_root": root.path(),
        })
        .to_string(),
    )
    .unwrap();
    std::env::set_var(TEST_HOOKS_INSTALL_RECORD_ENV, &record_path);

    let (sidecar, detail) = start_managed_hooks_sidecar(&instance_dir).await.unwrap();

    assert!(sidecar.is_none());
    assert!(detail.unwrap().contains("invalid readiness record"));
    assert!(!codexapp_socket.exists());
    let pid: libc::pid_t = fs::read_to_string(&pid_path)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert_eq!(unsafe { libc::kill(-pid, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
    std::env::remove_var(TEST_HOOKS_INSTALL_RECORD_ENV);
}

#[tokio::test]
#[cfg(unix)]
async fn failed_hooks_sidecar_cleans_descendant_after_wrapper_exits_before_readiness() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    let record_path = root.path().join("install.json");
    let daemon_config = root.path().join("hooksd.json");
    let supervisor_wrapper = root.path().join("supervisor-wrapper");
    let bin_directory = root.path().join("bin");
    let codexapp_socket = root.path().join("codexapp.sock");
    let pid_path = root.path().join("supervisor-wrapper.pid");
    let descendant_pid_path = root.path().join("descendant.pid");
    fs::create_dir(&instance_dir).unwrap();
    fs::create_dir(&bin_directory).unwrap();
    fs::write(bin_directory.join("rccv3-codexapp"), "").unwrap();
    fs::write(
        &daemon_config,
        serde_json::json!({"codexapp": {"socket": codexapp_socket}}).to_string(),
    )
    .unwrap();
    fs::write(&codexapp_socket, "owned by the failed hooks startup").unwrap();
    fs::write(
        &supervisor_wrapper,
        format!(
            "#!/bin/sh\necho $$ > '{}'\n(trap '' TERM INT; while :; do sleep 1; done) &\necho $! > '{}'\nprintf '%s\\n' '{{\"protocol\":\"wrong\",\"ready\":false}}'\nexit 17\n",
            pid_path.display(),
            descendant_pid_path.display()
        ),
    )
    .unwrap();
    let mut permissions = fs::metadata(&supervisor_wrapper).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&supervisor_wrapper, permissions).unwrap();
    fs::write(
        &record_path,
        serde_json::json!({
            "supervisor_enabled": true,
            "supervisor_wrapper": supervisor_wrapper,
            "daemon_config": daemon_config,
            "bin_directory": bin_directory,
            "install_root": root.path(),
        })
        .to_string(),
    )
    .unwrap();
    std::env::set_var(TEST_HOOKS_INSTALL_RECORD_ENV, &record_path);

    let (sidecar, detail) = start_managed_hooks_sidecar(&instance_dir).await.unwrap();

    assert!(sidecar.is_none());
    assert!(detail.unwrap().contains("invalid readiness record"));
    assert!(codexapp_socket.exists());
    let pid: libc::pid_t = fs::read_to_string(&pid_path)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let descendant_pid: libc::pid_t = fs::read_to_string(&descendant_pid_path)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert_eq!(unsafe { libc::kill(-pid, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
    assert_eq!(unsafe { libc::kill(descendant_pid, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
    std::env::remove_var(TEST_HOOKS_INSTALL_RECORD_ENV);
}

#[tokio::test]
#[cfg(unix)]
async fn failed_hooks_stop_preserves_control_resources_and_reports_failure() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
    let root = TempDir::new().unwrap();
    let port = std::net::TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let (config, executable, state) = fixture_with_port(&root, port);
    let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
    let (declaration, manifest) = lifecycle.declaration(&executable).unwrap();
    let instance_dir = state.join("instances").join(&declaration.instance_id);
    ensure_private_dir(&instance_dir).unwrap();
    let socket_path = instance_dir.join("managed-control.sock");
    fs::write(instance_dir.join("pid.cache"), "managed-pid").unwrap();
    fs::write(instance_dir.join("control.json"), "managed-control").unwrap();
    fs::write(&socket_path, "managed-socket").unwrap();
    let process_record_path = instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE);
    fs::write(&process_record_path, "sidecar-process").unwrap();
    let sidecar_child = tokio::process::Command::new("true").spawn().unwrap();
    let sidecar = V3HooksSidecarProcess::for_test(sidecar_child, 0, process_record_path.clone());
    let handle = routecodex_v3_server::spawn_v3_server_aggregate(manifest)
        .await
        .unwrap();

    let error = shutdown_managed_runtime(
        &instance_dir,
        &declaration.instance_id,
        &socket_path,
        handle,
        Some(sidecar),
    )
    .await
    .unwrap_err();

    assert!(error.to_string().contains("process group id is invalid"));
    let status: V3ManagedStatusRecord = read_json(&instance_dir.join("status.json")).unwrap();
    assert_eq!(status.state, V3ManagedRunState::Failed);
    assert!(status
        .detail
        .as_deref()
        .is_some_and(|detail| detail.contains("process group id is invalid")));
    assert!(instance_dir.join("pid.cache").exists());
    assert!(instance_dir.join("control.json").exists());
    assert!(socket_path.exists());
    assert!(process_record_path.exists());
}

#[tokio::test]
#[cfg(unix)]
async fn failed_hooks_restart_preserves_old_control_and_does_not_exec_replacement() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
    let root = TempDir::new().unwrap();
    let port = std::net::TcpListener::bind(("127.0.0.1", 0))
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let (config, executable, state) = fixture_with_port(&root, port);
    let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
    let (declaration, manifest) = lifecycle.declaration(&executable).unwrap();
    let instance_dir = state.join("instances").join(&declaration.instance_id);
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
    let handle = routecodex_v3_server::spawn_v3_server_aggregate(manifest)
        .await
        .unwrap();
    let restart_plan = ControlRestartPlan {
        control_instance_id: declaration.instance_id.clone(),
        declaration: declaration.clone(),
        executable_path: executable.clone(),
        snapshots: false,
        snapshot_direct: false,
        snapshot_stages: None,
        sse_dump: false,
    };

    let error = restart_managed_runtime_in_place(
        &instance_dir,
        &socket_path,
        handle,
        Some(sidecar),
        restart_plan,
        false,
    )
    .await
    .unwrap_err();

    assert!(error.to_string().contains("process group id is invalid"));
    let status: V3ManagedStatusRecord = read_json(&instance_dir.join("status.json")).unwrap();
    assert_eq!(status.state, V3ManagedRunState::Failed);
    assert!(status
        .detail
        .as_deref()
        .is_some_and(|detail| detail.contains("process group id is invalid")));
    assert!(instance_dir.join("pid.cache").exists());
    assert!(instance_dir.join("control.json").exists());
    assert!(socket_path.exists());
    assert!(process_record_path.exists());
    assert!(restart_plan_path.exists());
}

#[tokio::test]
#[cfg(unix)]
async fn live_persisted_hooks_group_blocks_reaping_runtime_control() {
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    ensure_private_dir(&instance_dir).unwrap();
    fs::write(
        instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE),
        r#"{"schema_version":1,"process_group_id":0}"#,
    )
    .unwrap();
    let mut child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg("while :; do sleep 1; done")
        .process_group(0)
        .spawn()
        .unwrap();
    let process_group_id = child.id().unwrap() as libc::pid_t;
    fs::write(
        instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE),
        format!(
            r#"{{"schema_version":1,"process_group_id":{process_group_id},"leader_pid":{process_group_id},"leader_start_token":"{}"}}"#,
            process_start_token(process_group_id as u32).unwrap().unwrap()
        ),
    )
    .unwrap();
    let expected = managed_test_declaration(
        "live-hooks-group",
        &root.path().join("config.v3.toml"),
        "digest",
        "/tmp/rccv3",
        45_499,
    );
    write_json_atomic(&instance_dir.join("instance.json"), &expected).unwrap();
    write_status(
        &instance_dir,
        &expected.instance_id,
        V3ManagedRunState::Failed,
        Some("hooks cleanup failed".to_string()),
    )
    .unwrap();
    fs::write(instance_dir.join("pid.cache"), "managed-pid").unwrap();
    fs::write(instance_dir.join("control.json"), "managed-control").unwrap();

    let error = reap_inactive_runtime_files(&instance_dir, &expected)
        .unwrap_err()
        .to_string();

    assert!(error.contains("hooks sidecar process group is alive"));
    assert!(instance_dir.join("pid.cache").exists());
    assert!(instance_dir.join("control.json").exists());
    assert!(instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE).exists());
    assert_eq!(unsafe { libc::kill(-process_group_id, libc::SIGKILL) }, 0);
    let _ = child.wait().await;
}

#[tokio::test]
#[cfg(unix)]
async fn live_persisted_hooks_group_blocks_managed_child_start() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
    let root = TempDir::new().unwrap();
    let (config, executable, state) = fixture_with_port(&root, 45_497);
    let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
    let (declaration, _) = lifecycle.declaration(&executable).unwrap();
    let instance_dir = state.join("instances").join(&declaration.instance_id);
    ensure_private_dir(&instance_dir).unwrap();
    write_json_atomic(&instance_dir.join("instance.json"), &declaration).unwrap();
    write_status(
        &instance_dir,
        &declaration.instance_id,
        V3ManagedRunState::Starting,
        None,
    )
    .unwrap();
    let mut child = tokio::process::Command::new("sh")
        .arg("-c")
        .arg("while :; do sleep 1; done")
        .process_group(0)
        .spawn()
        .unwrap();
    let process_group_id = child.id().unwrap() as libc::pid_t;
    fs::write(
        instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE),
        format!(
            r#"{{"schema_version":1,"process_group_id":{process_group_id},"leader_pid":{process_group_id},"leader_start_token":"{}"}}"#,
            process_start_token(process_group_id as u32).unwrap().unwrap()
        ),
    )
    .unwrap();

    let error = lifecycle.run_managed_child(&executable).await.unwrap_err();

    assert!(matches!(error, V3LifecycleError::HooksControlValidation(_)));
    assert!(error
        .to_string()
        .contains("hooks sidecar process group from a previous run is still alive"));
    let status: V3ManagedStatusRecord = read_json(&instance_dir.join("status.json")).unwrap();
    assert_eq!(status.state, V3ManagedRunState::Failed);
    assert!(status
        .detail
        .as_deref()
        .is_some_and(|detail| detail.contains("hooks sidecar startup blocked")));
    assert!(!instance_dir.join("pid.cache").exists());
    assert!(!instance_dir.join("control.json").exists());
    assert!(!instance_dir.join("managed-control.sock").exists());
    assert!(instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE).exists());
    assert_eq!(unsafe { libc::kill(-process_group_id, libc::SIGKILL) }, 0);
    let _ = child.wait().await;
}

#[test]
fn degraded_hook_detail_survives_a_running_status_update() {
    assert_eq!(
        append_status_detail(
            Some("hooks sidecar unavailable: hooks sidecar exited before readiness"),
            "released listener ports 45499".to_string(),
        ),
        "hooks sidecar unavailable: hooks sidecar exited before readiness; released listener ports 45499"
    );
    assert_eq!(
        append_status_detail(None, "released listener ports 45499".to_string()),
        "released listener ports 45499"
    );
}

fn fixture(root: &TempDir) -> (PathBuf, PathBuf, PathBuf) {
    fixture_with_port(root, 45499)
}

fn fixture_with_port(root: &TempDir, port: u16) -> (PathBuf, PathBuf, PathBuf) {
    let config = root.path().join("config.v3.toml");
    let executable = std::env::current_exe().unwrap();
    let state = root.path().join("state");
    fs::write(
        &config,
        format!(
            r#"version = 3
[servers.test]
bind = "127.0.0.1"
port = {}
routing_group = "default"
endpoints = ["responses"]
[providers.test]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "test"
auth = {{ type = "api_key", entries = [{{ alias = "key", env = "V3_LIFECYCLE_TEST_KEY" }}] }}
[providers.test.models.test]
wire_name = "test"
capabilities = ["text"]
[route_groups.default.pools.default]
selection = {{ strategy = "priority" }}
targets = [{{ kind = "provider_model", provider = "test", model = "test", key = "key", priority = 1 }}]
"#,
            port
        ),
    )
    .unwrap();
    (config, executable, state)
}

#[test]
fn declaration_includes_enabled_admin_webui_listener() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
    std::env::remove_var("ROUTECODEX_V3_ADMIN_BIND");
    let root = TempDir::new().unwrap();
    let (config, executable, state) = fixture_with_port(&root, 45499);
    let mut raw = fs::read_to_string(&config).unwrap();
    raw.push_str(
        r#"
[admin_webui]
enabled = true
bind = "127.0.0.1"
port = 45498
"#,
    );
    fs::write(&config, raw).unwrap();
    let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
    let (declaration, _) = lifecycle.declaration(&executable).unwrap();
    assert!(
        declaration.listeners.iter().any(|listener| {
            listener.server_id == "admin_webui"
                && listener.bind == "127.0.0.1"
                && listener.port == 45498
        }),
        "declaration must include enabled admin_webui listener: {:?}",
        declaration.listeners
    );
}

fn managed_test_declaration(
    instance_id: &str,
    config_path: &Path,
    config_digest: &str,
    executable_path: &str,
    port: u16,
) -> V3ManagedInstanceDeclaration {
    V3ManagedInstanceDeclaration {
        schema_version: SCHEMA_VERSION,
        instance_id: instance_id.to_string(),
        config_path: config_path.display().to_string(),
        config_digest: config_digest.to_string(),
        executable_path: executable_path.to_string(),
        listeners: vec![V3ManagedListenerDeclaration {
            server_id: "responses_v3_5555".to_string(),
            bind: "0.0.0.0".to_string(),
            port,
        }],
    }
}

#[test]
fn deterministic_identity_and_unknown_state_fields_fail() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
    let root = TempDir::new().unwrap();
    let (config, executable, state) = fixture(&root);
    let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
    let (first, _) = lifecycle.declaration(&executable).unwrap();
    let (second, _) = lifecycle.declaration(&executable).unwrap();
    assert_eq!(first, second);
    let instance_dir = state.join("instances").join(&first.instance_id);
    ensure_private_dir(&instance_dir).unwrap();
    fs::write(
        instance_dir.join("status.json"),
        format!(
            r#"{{"schema_version":1,"instance_id":"{}","state":"running","updated_at_epoch_ms":1,"detail":null,"secret":"forbidden"}}"#,
            first.instance_id
        ),
    )
    .unwrap();
    let error = read_json::<V3ManagedStatusRecord>(&instance_dir.join("status.json"))
        .unwrap_err()
        .to_string();
    assert!(error.contains("unknown field"));
}

#[test]
fn operation_lock_is_exclusive_and_auth_handle_is_required() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    let (config, executable, state) = fixture(&root);
    std::env::remove_var("V3_LIFECYCLE_TEST_KEY");
    let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
    let (_, manifest) = lifecycle.declaration(&executable).unwrap();
    assert!(validate_auth_handles(&manifest).is_err());
    std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
    let (declaration, _) = lifecycle.declaration(&executable).unwrap();
    let instance_dir = state.join("instances").join(declaration.instance_id);
    let first = acquire_operation_lock(&instance_dir, "first").unwrap();
    assert!(matches!(
        acquire_operation_lock(&instance_dir, "second"),
        Err(V3LifecycleError::OperationLocked(_))
    ));
    drop(first);
    acquire_operation_lock(&instance_dir, "third").unwrap();
}

#[test]
fn lifecycle_accepts_api_key_only_and_rejects_mixed_auth_handles() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    let (config, executable, state) = fixture(&root);
    let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
    let (_, mut manifest) = lifecycle.declaration(&executable).unwrap();
    let entry = &mut manifest.providers.get_mut("test").unwrap().auth.entries[0];
    entry.env = None;
    entry.token_file = None;
    entry.api_key = Some("inline-secret".to_string());
    validate_auth_handles(&manifest).unwrap();

    let entry = &mut manifest.providers.get_mut("test").unwrap().auth.entries[0];
    entry.env = Some("V3_LIFECYCLE_TEST_KEY".to_string());
    assert!(matches!(
        validate_auth_handles(&manifest),
        Err(V3LifecycleError::Validation(message))
            if message.contains("invalid handle shape")
    ));
}

#[test]
fn state_projection_never_contains_resolved_secret() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret-value");
    let root = TempDir::new().unwrap();
    let (config, executable, state) = fixture(&root);
    let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
    let (declaration, _) = lifecycle.declaration(&executable).unwrap();
    let rendered = serde_json::to_string(&declaration).unwrap();
    assert!(!rendered.contains("controlled-secret-value"));
    assert!(!rendered.contains("V3_LIFECYCLE_TEST_KEY"));
}

#[test]
fn restart_control_operation_is_explicit_protocol() {
    let request = ControlRequest {
        schema_version: SCHEMA_VERSION,
        instance_id: "v3-test".to_string(),
        start_nonce: "nonce".to_string(),
        operation: ControlOperation::Restart,
        ports: None,
    };
    let plan = V3ManagedRestartPlanRecord {
        schema_version: SCHEMA_VERSION,
        instance_id: "v3-test".to_string(),
        start_nonce: "nonce".to_string(),
        executable_path: "/tmp/rccv3-next".to_string(),
        target_declaration: None,
        snapshots: true,
        snapshot_direct: false,
        snapshot_stages: Some("provider-request".to_string()),
        sse_dump: false,
    };

    let rendered = serde_json::to_string(&request).unwrap();
    let rendered_plan = serde_json::to_string(&plan).unwrap();

    assert!(rendered.contains("\"operation\":\"restart\""));
    assert!(!rendered.contains("/tmp/rccv3-next"));
    assert!(rendered_plan.contains("\"executable_path\":\"/tmp/rccv3-next\""));
    assert!(rendered_plan.contains("\"snapshots\":true"));
    assert!(!rendered_plan.contains("\"snapshot_direct\""));
    assert!(rendered_plan.contains("\"snapshot_stages\":\"provider-request\""));
}

#[test]
fn managed_child_reentry_removes_restart_plan_from_previous_control_identity() {
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    ensure_private_dir(&instance_dir).unwrap();
    write_json_atomic(
        &instance_dir.join(RESTART_PLAN_FILE),
        &V3ManagedRestartPlanRecord {
            schema_version: SCHEMA_VERSION,
            instance_id: "v3-test".to_string(),
            start_nonce: "previous-nonce".to_string(),
            executable_path: "/tmp/rccv3-next".to_string(),
            target_declaration: None,
            snapshots: true,
            snapshot_direct: false,
            snapshot_stages: None,
            sse_dump: false,
        },
    )
    .unwrap();

    remove_restart_plan_for_previous_control_identity(&instance_dir, "fresh-nonce").unwrap();

    assert!(
        !instance_dir.join(RESTART_PLAN_FILE).exists(),
        "a successfully re-entered managed child must not retain the consumed restart plan"
    );
}

#[test]
fn restart_without_current_instance_state_fails_without_bootstrap() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
    let root = TempDir::new().unwrap();
    let port_listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = port_listener.local_addr().unwrap().port();
    drop(port_listener);
    let (config, executable, state) = fixture_with_port(&root, port);
    let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
    let (declaration, _) = lifecycle.declaration(&executable).unwrap();
    let instance_dir = state.join("instances").join(&declaration.instance_id);

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    let error = runtime
        .block_on(lifecycle.restart(&executable, Duration::from_millis(1)))
        .unwrap_err();

    assert!(
        matches!(&error, V3LifecycleError::NotRunning(instance_id) if instance_id == &declaration.instance_id),
        "restart without live managed truth must fail explicitly instead of bootstrapping a detached runtime, got {error}"
    );
    assert!(
        !instance_dir.join("instance.json").exists(),
        "restart without live managed truth must not publish instance state"
    );
    assert!(
        !instance_dir.join("status.json").exists(),
        "restart without live managed truth must not publish startup status"
    );
}

#[test]
fn restart_discovers_live_previous_owner_when_config_digest_changed() {
    let root = TempDir::new().unwrap();
    let state = root.path().join("state");
    let config_path = root.path().join("config.v3.toml");
    let old = managed_test_declaration(
        "v3-previous-digest-owner",
        &config_path,
        "old-digest",
        "/tmp/old-rccv3",
        45551,
    );
    let expected = managed_test_declaration(
        "v3-current-digest-owner",
        &config_path,
        "new-digest",
        "/tmp/new-rccv3",
        45551,
    );
    let old_dir = state.join("instances").join(&old.instance_id);
    ensure_private_dir(&old_dir).unwrap();
    write_json_atomic(&old_dir.join("instance.json"), &old).unwrap();
    write_status(&old_dir, &old.instance_id, V3ManagedRunState::Running, None).unwrap();
    let socket_path = managed_control_socket_path(&old.instance_id);
    fs::write(&socket_path, b"live previous owner socket marker").unwrap();
    write_json_atomic(
        &old_dir.join("pid.cache"),
        &V3ManagedPidCache {
            schema_version: SCHEMA_VERSION,
            instance_id: old.instance_id.clone(),
            pid: std::process::id(),
            start_nonce: "previous-owner".to_string(),
            started_at_epoch_ms: 1,
            process_start_token: None,
        },
    )
    .unwrap();
    write_json_atomic(
        &old_dir.join("control.json"),
        &V3ManagedControlRecord {
            schema_version: SCHEMA_VERSION,
            instance_id: old.instance_id.clone(),
            socket_path: socket_path.display().to_string(),
            start_nonce: "previous-owner".to_string(),
        },
    )
    .unwrap();

    let owner = find_live_previous_owner_for_restart(&state, &expected)
        .unwrap()
        .expect("changed-digest restart must find the previous live owner");

    assert_eq!(owner.1.instance_id, old.instance_id);
    let _ = fs::remove_file(socket_path);
}

#[test]
fn restart_matches_live_previous_owner_when_config_path_changes_for_the_same_listener_set() {
    let root = TempDir::new().unwrap();
    let old = managed_test_declaration(
        "v3-legacy-config-owner",
        &root.path().join("config.v3.toml"),
        "legacy-digest",
        "/tmp/old-rccv3",
        45553,
    );
    let expected = managed_test_declaration(
        "v3-user-config-owner",
        &root.path().join("config.toml"),
        "user-digest",
        "/tmp/new-rccv3",
        45553,
    );

    assert!(previous_owner_matches_restart_declaration(&old, &expected));

    let mut different_listener_set = expected.clone();
    different_listener_set
        .listeners
        .push(V3ManagedListenerDeclaration {
            server_id: "additional".to_string(),
            bind: "127.0.0.1".to_string(),
            port: 45554,
        });
    assert!(!previous_owner_matches_restart_declaration(
        &old,
        &different_listener_set
    ));
}

#[test]
fn restart_plan_projects_a_validated_config_path_change_and_rejects_listener_drift() {
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    ensure_private_dir(&instance_dir).unwrap();
    let executable_path = std::env::current_exe().unwrap();
    let current = managed_test_declaration(
        "v3-legacy-config-owner",
        &root.path().join("config.v3.toml"),
        "legacy-digest",
        executable_path.to_str().unwrap(),
        45555,
    );
    let target = managed_test_declaration(
        "v3-user-config-owner",
        &root.path().join("config.toml"),
        "user-digest",
        executable_path.to_str().unwrap(),
        45555,
    );
    let request = ControlRequest {
        schema_version: SCHEMA_VERSION,
        instance_id: current.instance_id.clone(),
        start_nonce: "nonce".to_string(),
        operation: ControlOperation::Restart,
        ports: None,
    };
    let write_plan = |target_declaration: V3ManagedInstanceDeclaration| {
        write_json_atomic(
            &instance_dir.join(RESTART_PLAN_FILE),
            &V3ManagedRestartPlanRecord {
                schema_version: SCHEMA_VERSION,
                instance_id: current.instance_id.clone(),
                start_nonce: "nonce".to_string(),
                executable_path: executable_path.display().to_string(),
                target_declaration: Some(target_declaration),
                snapshots: false,
                snapshot_direct: false,
                snapshot_stages: None,
                sse_dump: false,
            },
        )
        .unwrap();
    };

    write_plan(target.clone());
    let projected = control_restart_plan(&instance_dir, &request, &current)
        .unwrap()
        .unwrap();
    assert_eq!(projected.declaration, target);

    let mut listener_drift = target;
    listener_drift.listeners.push(V3ManagedListenerDeclaration {
        server_id: "additional".to_string(),
        bind: "127.0.0.1".to_string(),
        port: 45556,
    });
    write_plan(listener_drift);
    assert!(control_restart_plan(&instance_dir, &request, &current).is_err());
}

#[test]
fn exec_restart_reentry_adopts_changed_declaration_from_previous_owner() {
    let root = TempDir::new().unwrap();
    let state = root.path().join("state");
    let config_path = root.path().join("config.v3.toml");
    let old = managed_test_declaration(
        "v3-previous-exec-owner",
        &config_path,
        "old-digest",
        "/tmp/old-rccv3",
        45552,
    );
    let expected = managed_test_declaration(
        "v3-current-exec-owner",
        &config_path,
        "new-digest",
        "/tmp/new-rccv3",
        45552,
    );
    let old_dir = state.join("instances").join(&old.instance_id);
    let expected_dir = state.join("instances").join(&expected.instance_id);
    ensure_private_dir(&old_dir).unwrap();
    write_json_atomic(&old_dir.join("instance.json"), &old).unwrap();
    write_status(
        &old_dir,
        &old.instance_id,
        V3ManagedRunState::Starting,
        Some("exec restart accepted".to_string()),
    )
    .unwrap();
    write_json_atomic(
        &old_dir.join("pid.cache"),
        &V3ManagedPidCache {
            schema_version: SCHEMA_VERSION,
            instance_id: old.instance_id.clone(),
            pid: std::process::id(),
            start_nonce: "previous-exec-owner".to_string(),
            started_at_epoch_ms: 1,
            process_start_token: None,
        },
    )
    .unwrap();

    assert!(
        adopt_exec_restart_declaration_change(&state, &expected_dir, &expected).unwrap(),
        "exec-reentered child must adopt the current declaration"
    );

    let adopted: V3ManagedInstanceDeclaration =
        read_json(&expected_dir.join("instance.json")).unwrap();
    let adopted_status: V3ManagedStatusRecord =
        read_json(&expected_dir.join("status.json")).unwrap();
    let old_status: V3ManagedStatusRecord = read_json(&old_dir.join("status.json")).unwrap();
    assert_eq!(adopted, expected);
    assert_eq!(adopted_status.state, V3ManagedRunState::Starting);
    assert_eq!(old_status.state, V3ManagedRunState::Stopped);
    assert!(!old_dir.join("pid.cache").exists());
}

#[test]
fn published_declaration_mismatch_is_rejected_without_reaping() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
    let root = TempDir::new().unwrap();
    let (config, executable, state) = fixture(&root);
    let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
    let (declaration, _) = lifecycle.declaration(&executable).unwrap();
    let instance_dir = state.join("instances").join(&declaration.instance_id);
    ensure_private_dir(&instance_dir).unwrap();
    let mut wrong = declaration.clone();
    wrong.config_digest = "wrong-digest".to_string();
    write_json_atomic(&instance_dir.join("instance.json"), &wrong).unwrap();
    assert!(matches!(
        verify_published_declaration(&instance_dir, &declaration),
        Err(V3LifecycleError::IdentityMismatch(_))
    ));
    assert!(matches!(
        reap_inactive_runtime_files(&instance_dir, &declaration),
        Err(V3LifecycleError::IdentityMismatch(_))
    ));
    assert!(instance_dir.join("instance.json").exists());
}

#[test]
fn terminal_state_allows_reaping_stale_release_executable_path_for_same_config_identity() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
    let root = TempDir::new().unwrap();
    let (config, executable, state) = fixture(&root);
    let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
    let (declaration, _) = lifecycle.declaration(&executable).unwrap();
    let instance_dir = state.join("instances").join(&declaration.instance_id);
    ensure_private_dir(&instance_dir).unwrap();
    let mut old_release = declaration.clone();
    old_release.executable_path = root
        .path()
        .join("old-release")
        .join("routecodex-v3")
        .display()
        .to_string();
    write_json_atomic(&instance_dir.join("instance.json"), &old_release).unwrap();
    write_status(
        &instance_dir,
        &declaration.instance_id,
        V3ManagedRunState::Stopped,
        Some("old release path removed after install".to_string()),
    )
    .unwrap();

    reap_inactive_runtime_files(&instance_dir, &declaration).unwrap();
    assert!(instance_dir.join("instance.json").exists());
    assert!(instance_dir.join("status.json").exists());
}

#[test]
fn non_terminal_runtime_state_is_never_reaped_after_control_probe_failure() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
    let root = TempDir::new().unwrap();
    let (config, executable, state) = fixture(&root);
    let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
    let (declaration, _) = lifecycle.declaration(&executable).unwrap();
    let instance_dir = state.join("instances").join(&declaration.instance_id);
    ensure_private_dir(&instance_dir).unwrap();
    write_json_atomic(&instance_dir.join("instance.json"), &declaration).unwrap();
    write_status(
        &instance_dir,
        &declaration.instance_id,
        V3ManagedRunState::Running,
        Some("control probe temporarily unavailable".to_string()),
    )
    .unwrap();
    let occupied = std::net::TcpListener::bind(("127.0.0.1", 45499)).unwrap();
    write_json_atomic(
        &instance_dir.join("pid.cache"),
        &V3ManagedPidCache {
            schema_version: SCHEMA_VERSION,
            instance_id: declaration.instance_id.clone(),
            pid: 42,
            start_nonce: "active-release".to_string(),
            started_at_epoch_ms: 1,
            process_start_token: None,
        },
    )
    .unwrap();

    assert!(matches!(
        reap_inactive_runtime_files(&instance_dir, &declaration),
        Err(V3LifecycleError::IdentityMismatch(_))
    ));
    assert!(instance_dir.join("pid.cache").exists());
    assert!(instance_dir.join("status.json").exists());
    drop(occupied);
}

#[test]
fn stale_running_state_allows_release_snapshot_executable_rollover_when_control_is_gone() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
    let root = TempDir::new().unwrap();
    let (config, executable, state) = fixture(&root);
    let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
    let (published, _) = lifecycle.declaration(&executable).unwrap();
    let instance_dir = state.join("instances").join(&published.instance_id);
    ensure_private_dir(&instance_dir).unwrap();

    let next_release = root.path().join("next-release-rccv3");
    fs::write(&next_release, b"next release executable identity").unwrap();
    let mut expected = published.clone();
    expected.executable_path = fs::canonicalize(&next_release)
        .unwrap()
        .display()
        .to_string();

    write_json_atomic(&instance_dir.join("instance.json"), &published).unwrap();
    write_status(
        &instance_dir,
        &published.instance_id,
        V3ManagedRunState::Running,
        Some("previous release lost pid and control socket after install rollover".to_string()),
    )
    .unwrap();
    write_json_atomic(
        &instance_dir.join("pid.cache"),
        &V3ManagedPidCache {
            schema_version: SCHEMA_VERSION,
            instance_id: published.instance_id.clone(),
            pid: 42,
            start_nonce: "previous-release".to_string(),
            started_at_epoch_ms: 1,
            process_start_token: None,
        },
    )
    .unwrap();
    let socket_path = managed_control_socket_path(&published.instance_id);
    assert!(!socket_path.exists());
    write_json_atomic(
        &instance_dir.join("control.json"),
        &V3ManagedControlRecord {
            schema_version: SCHEMA_VERSION,
            instance_id: published.instance_id.clone(),
            socket_path: socket_path.display().to_string(),
            start_nonce: "previous-release".to_string(),
        },
    )
    .unwrap();

    reap_inactive_runtime_files(&instance_dir, &expected).unwrap();

    assert!(!instance_dir.join("pid.cache").exists());
    assert!(!instance_dir.join("control.json").exists());
    assert!(!socket_path.exists());
}

#[test]
fn foreign_control_record_is_never_reaped_from_terminal_state() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
    let root = TempDir::new().unwrap();
    let (config, executable, state) = fixture(&root);
    let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
    let (declaration, _) = lifecycle.declaration(&executable).unwrap();
    let instance_dir = state.join("instances").join(&declaration.instance_id);
    ensure_private_dir(&instance_dir).unwrap();
    write_json_atomic(&instance_dir.join("instance.json"), &declaration).unwrap();
    write_status(
        &instance_dir,
        &declaration.instance_id,
        V3ManagedRunState::Stopped,
        Some("terminal cleanup permitted only for owned control truth".to_string()),
    )
    .unwrap();
    let foreign_instance_id = format!("{}-foreign", declaration.instance_id);
    let foreign_socket = managed_control_socket_path(&foreign_instance_id);
    fs::write(&foreign_socket, b"foreign-control-socket-marker").unwrap();
    write_json_atomic(
        &instance_dir.join("control.json"),
        &V3ManagedControlRecord {
            schema_version: SCHEMA_VERSION,
            instance_id: foreign_instance_id,
            socket_path: foreign_socket.display().to_string(),
            start_nonce: "foreign".to_string(),
        },
    )
    .unwrap();

    assert!(matches!(
        reap_inactive_runtime_files(&instance_dir, &declaration),
        Err(V3LifecycleError::IdentityMismatch(_))
    ));
    assert!(foreign_socket.exists());
    let _ = fs::remove_file(foreign_socket);
}

#[test]
fn stopped_instance_state_allows_release_snapshot_executable_rollover() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
    let root = TempDir::new().unwrap();
    let (config, executable, state) = fixture(&root);
    let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
    let (published, _) = lifecycle.declaration(&executable).unwrap();
    let instance_dir = state.join("instances").join(&published.instance_id);
    ensure_private_dir(&instance_dir).unwrap();

    let next_release = root.path().join("next-release-routecodex-v3");
    fs::write(&next_release, b"next release executable identity").unwrap();
    let mut expected = published.clone();
    expected.executable_path = fs::canonicalize(&next_release)
        .unwrap()
        .display()
        .to_string();

    write_json_atomic(&instance_dir.join("instance.json"), &published).unwrap();
    write_status(
        &instance_dir,
        &published.instance_id,
        V3ManagedRunState::Stopped,
        Some("previous release stopped cleanly".to_string()),
    )
    .unwrap();
    write_json_atomic(
        &instance_dir.join("pid.cache"),
        &V3ManagedPidCache {
            schema_version: SCHEMA_VERSION,
            instance_id: published.instance_id.clone(),
            pid: 42,
            start_nonce: "previous-release".to_string(),
            started_at_epoch_ms: 1,
            process_start_token: None,
        },
    )
    .unwrap();
    let socket_path = managed_control_socket_path(&published.instance_id);
    fs::write(&socket_path, b"stale owned control socket").unwrap();
    write_json_atomic(
        &instance_dir.join("control.json"),
        &V3ManagedControlRecord {
            schema_version: SCHEMA_VERSION,
            instance_id: published.instance_id.clone(),
            socket_path: socket_path.display().to_string(),
            start_nonce: "previous-release".to_string(),
        },
    )
    .unwrap();

    reap_inactive_runtime_files(&instance_dir, &expected).unwrap();

    assert!(!instance_dir.join("pid.cache").exists());
    assert!(!instance_dir.join("control.json").exists());
    assert!(!socket_path.exists());
}

#[test]
fn running_instance_state_rejects_release_snapshot_executable_rollover() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
    let root = TempDir::new().unwrap();
    let (config, executable, state) = fixture(&root);
    let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
    let (published, _) = lifecycle.declaration(&executable).unwrap();
    let instance_dir = state.join("instances").join(&published.instance_id);
    ensure_private_dir(&instance_dir).unwrap();

    let mut expected = published.clone();
    expected.executable_path = root
        .path()
        .join("active-release-must-not-be-taken-over")
        .display()
        .to_string();
    write_json_atomic(&instance_dir.join("instance.json"), &published).unwrap();
    write_status(
        &instance_dir,
        &published.instance_id,
        V3ManagedRunState::Running,
        Some("active previous release".to_string()),
    )
    .unwrap();
    let occupied = std::net::TcpListener::bind(("127.0.0.1", published.listeners[0].port)).unwrap();
    write_json_atomic(
        &instance_dir.join("pid.cache"),
        &V3ManagedPidCache {
            schema_version: SCHEMA_VERSION,
            instance_id: published.instance_id.clone(),
            pid: 42,
            start_nonce: "active-release".to_string(),
            started_at_epoch_ms: 1,
            process_start_token: None,
        },
    )
    .unwrap();

    assert!(matches!(
        reap_inactive_runtime_files(&instance_dir, &expected),
        Err(V3LifecycleError::IdentityMismatch(_))
    ));
    assert!(instance_dir.join("pid.cache").exists());
    assert!(instance_dir.join("instance.json").exists());
    drop(occupied);
}

#[test]
fn restart_plan_omits_false_snapshot_direct_for_previous_release_child_compat() {
    let plan = V3ManagedRestartPlanRecord {
        schema_version: SCHEMA_VERSION,
        instance_id: "instance".to_string(),
        start_nonce: "nonce".to_string(),
        executable_path: "/tmp/rccv3".to_string(),
        target_declaration: None,
        snapshots: false,
        snapshot_direct: false,
        snapshot_stages: None,
        sse_dump: false,
    };

    let encoded = serde_json::to_value(&plan).unwrap();
    assert!(
        encoded.get("snapshot_direct").is_none(),
        "false snapshot_direct must not be written to restart.plan.json because previous-release managed children with deny_unknown_fields reject the newly-added field"
    );
    assert!(encoded.get("console").is_none());
    assert!(
        encoded.get("target_declaration").is_none(),
        "same-identity release upgrade must remain readable by the previous managed child"
    );

    let decoded: V3ManagedRestartPlanRecord = serde_json::from_value(encoded).unwrap();
    assert!(!decoded.snapshot_direct);
}

#[test]
fn restart_plan_keeps_true_snapshot_direct_for_snapall_restart() {
    let plan = V3ManagedRestartPlanRecord {
        schema_version: SCHEMA_VERSION,
        instance_id: "instance".to_string(),
        start_nonce: "nonce".to_string(),
        executable_path: "/tmp/rccv3".to_string(),
        target_declaration: None,
        snapshots: true,
        snapshot_direct: true,
        snapshot_stages: None,
        sse_dump: false,
    };

    let encoded = serde_json::to_value(&plan).unwrap();
    assert_eq!(
        encoded.get("snapshot_direct"),
        Some(&serde_json::json!(true))
    );
}

#[test]
fn default_snapshot_authorization_does_not_enable_sample_persistence() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
    let root = TempDir::new().unwrap();
    let (config, executable, state) = fixture(&root);
    let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
    let (_, manifest) = lifecycle.declaration(&executable).unwrap();
    assert!(!manifest.debug.codex_samples);
    assert!(
        manifest.debug.snapshot_direct,
        "config default snapshot_direct must survive lifecycle without explicit flags"
    );

    let forced = V3ManagedLifecycle::with_state_root(&config, &state)
        .with_snapshots_enabled(true)
        .with_direct_snapshots_enabled(true);
    let (_, forced_manifest) = forced.declaration(&executable).unwrap();
    assert!(forced_manifest.debug.codex_samples);
    assert!(forced_manifest.debug.snapshot_direct);
}

#[test]
fn configured_codex_samples_authorization_survives_managed_declaration() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
    let root = TempDir::new().unwrap();
    let (config, executable, state) = fixture(&root);
    let mut raw = fs::read_to_string(&config).unwrap();
    raw.push_str("\n[debug]\ncodex_samples = true\n");
    fs::write(&config, raw).unwrap();

    let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
    let (_, manifest) = lifecycle.declaration(&executable).unwrap();
    assert!(manifest.debug.codex_samples);
}

#[test]
fn instance_residual_pids_are_discovered_even_when_ports_are_no_longer_listened() {
    // 复现用户场景：`routecodex start` 抢占后，旧 run-managed-child 已释放端口
    // 但进程残留并保持 tty 前台进程组，导致 Ctrl+C 信号发到错误进程。
    // 当前实现只按 lsof 占用端口找 PID，找不到已释放端口的残留进程（红）。
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
    let root = TempDir::new().unwrap();
    let (config, executable, state) = fixture(&root);
    let lifecycle = V3ManagedLifecycle::with_state_root(&config, &state);
    let (declaration, _) = lifecycle.declaration(&executable).unwrap();

    let target_port = declaration.listeners[0].port;
    let instance_dir = state.join("instances").join(&declaration.instance_id);
    ensure_private_dir(&instance_dir).unwrap();
    write_json_atomic(&instance_dir.join("instance.json"), &declaration).unwrap();

    // 残留进程：存活、声明端口与目标重叠、但不监听任何端口（模拟 start 接管后的旧 child）。
    let residual = Command::new("sleep")
        .arg("300")
        .spawn()
        .expect("spawn residual process");
    let residual_pid = residual.id();
    write_json_atomic(
        &instance_dir.join("pid.cache"),
        &V3ManagedPidCache {
            schema_version: SCHEMA_VERSION,
            instance_id: declaration.instance_id.clone(),
            pid: residual_pid,
            start_nonce: "residual".to_string(),
            started_at_epoch_ms: epoch_ms(),
            process_start_token: Some(process_start_token(residual_pid).unwrap().unwrap()),
        },
    )
    .unwrap();

    let discovered = instance_residual_pids_for_listener_set(&state, &declaration.listeners)
        .expect("residual discovery must succeed");
    assert!(
        discovered.contains(&residual_pid),
        "residual managed child PID {residual_pid} must be discovered even without listening ports, got {discovered:?}"
    );

    let _ = unsafe { libc::kill(residual_pid as libc::pid_t, libc::SIGKILL) };
}

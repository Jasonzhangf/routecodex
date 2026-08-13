use super::*;
use std::sync::Mutex;
use tempfile::TempDir;

static TEST_ENV_LOCK: Mutex<()> = Mutex::new(());

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
        snapshots: true,
        snapshot_direct: false,
        snapshot_stages: Some("provider-request".to_string()),
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
            snapshots: true,
            snapshot_direct: false,
            snapshot_stages: None,
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
        snapshots: false,
        snapshot_direct: false,
        snapshot_stages: None,
    };

    let encoded = serde_json::to_value(&plan).unwrap();
    assert!(
        encoded.get("snapshot_direct").is_none(),
        "false snapshot_direct must not be written to restart.plan.json because previous-release managed children with deny_unknown_fields reject the newly-added field"
    );
    assert!(encoded.get("console").is_none());

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
        snapshots: true,
        snapshot_direct: true,
        snapshot_stages: None,
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

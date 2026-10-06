use super::*;

#[test]
fn restart_plan_projects_a_validated_config_path_change_and_rejects_listener_drift() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    std::env::set_var("V3_LIFECYCLE_TEST_KEY", "controlled-secret");
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    ensure_private_dir(&instance_dir).unwrap();
    let (config, executable_path, state) =
        codex_sample_persistence::managed_fixture_with_port(root.path(), 45555);
    let (current, _) = V3ManagedLifecycle::with_state_root(&config, &state)
        .declaration(&executable_path)
        .unwrap();
    let target_directory = root.path().join("next");
    fs::create_dir(&target_directory).unwrap();
    let target_config = target_directory.join("config.v3.toml");
    fs::copy(&config, &target_config).unwrap();
    let (target, _) = V3ManagedLifecycle::with_state_root(&target_config, &state)
        .declaration(&executable_path)
        .unwrap();
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

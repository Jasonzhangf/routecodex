use super::*;

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

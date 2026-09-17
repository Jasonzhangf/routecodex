use super::*;

#[tokio::test]
#[cfg(unix)]
async fn fatal_runtime_failure_stops_supervisor_and_preserves_primary_error() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    ensure_private_dir(&instance_dir).unwrap();
    let process_record_path = instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE);
    fs::write(&process_record_path, "sidecar-process").unwrap();
    let sidecar_child = tokio::process::Command::new("true").spawn().unwrap();
    let sidecar = V3HooksSidecarProcess::for_test(sidecar_child, 0, process_record_path.clone());

    let error = fail_managed_runtime_with_hooks_cleanup(
        &instance_dir,
        "fatal-instance",
        None,
        V3HooksSidecarSupervisor::from_startup(
            instance_dir.clone(),
            tokio::spawn(async move { Ok(Some(sidecar)) }),
        ),
        V3LifecycleError::Validation("managed runtime fatal control-plane failure".to_string()),
    )
    .await
    .unwrap_err();

    assert!(
        matches!(error, V3LifecycleError::Validation(ref message) if message.contains("managed runtime fatal control-plane failure")),
        "primary runtime error must not be replaced by cleanup failure, got {error}"
    );
    let status: V3ManagedStatusRecord = read_json(&instance_dir.join("status.json")).unwrap();
    assert_eq!(status.state, V3ManagedRunState::Failed);
    let detail = status.detail.unwrap();
    assert!(detail.contains("managed runtime fatal control-plane failure"));
    assert!(detail.contains("hooks sidecar cleanup failed"));
    assert!(process_record_path.exists());
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
            "hooks_runtime": "legacy_supervisor",
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
async fn failed_hooks_sidecar_is_unavailable_without_removing_runtime_control() {
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
    fs::write(bin_directory.join("rccv3-codexapp"), "").unwrap();
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
            "hooks_runtime": "legacy_supervisor",
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

    let (sidecar, detail) = start_managed_hooks_sidecar(&instance_dir).await.unwrap();

    assert!(sidecar.is_none());
    assert!(detail.unwrap().contains("hooks_unavailable:"));
    assert!(supervisor_started.exists());
    assert!(instance_dir.join("pid.cache").exists());
    assert!(instance_dir.join("control.json").exists());
    assert!(socket_path.exists());
    write_status(
        &instance_dir,
        "unavailable-instance",
        V3ManagedRunState::Running,
        Some("hooks_unavailable:crashed: hooks sidecar exited before readiness".to_string()),
    )
    .unwrap();
    assert_eq!(
        read_live_status_detail(&instance_dir, "unavailable-instance").unwrap(),
        Some("hooks_unavailable:crashed: hooks sidecar exited before readiness".to_string())
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
            "hooks_runtime": "legacy_supervisor",
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
            "hooks_runtime": "legacy_supervisor",
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

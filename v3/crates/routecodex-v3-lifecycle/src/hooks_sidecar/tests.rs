use super::*;
use crate::tests::TEST_ENV_LOCK;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
#[cfg(unix)]
use std::os::unix::io::AsRawFd;
use tempfile::TempDir;

#[tokio::test]
#[cfg(unix)]
async fn ready_hooks_sidecar_stop_removes_only_startup_owned_codexapp_socket() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let root = TempDir::new_in("/tmp").unwrap();
    let instance_dir = root.path().join("instance");
    let record_path = root.path().join("install.json");
    let daemon_config = root.path().join("hooksd.json");
    let supervisor_wrapper = root.path().join("supervisor-wrapper");
    let bin_directory = root.path().join("bin");
    let socket_path = root.path().join("codexapp.sock");
    fs::create_dir(&instance_dir).unwrap();
    fs::create_dir(&bin_directory).unwrap();
    fs::write(bin_directory.join("rccv3-codexapp"), "").unwrap();
    fs::write(
        &daemon_config,
        serde_json::json!({"codexapp": {"socket": socket_path}}).to_string(),
    )
    .unwrap();
    fs::write(
        &supervisor_wrapper,
        format!(
            "#!/bin/sh\nexec node -e 'const net=require(\"net\"); const server=net.createServer(); server.listen(process.argv[1], () => {{ process.stdout.write(JSON.stringify({{protocol: \"routecodex-hooks-supervisor/v1\", ready: true}})+\"\\n\"); }}); setInterval(() => {{}}, 1000);' '{}'\n",
            socket_path.display()
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
    std::env::set_var(HOOKS_INSTALL_RECORD_ENV, &record_path);

    let sidecar = start_configured_hooks_sidecar(&instance_dir)
        .await
        .unwrap()
        .expect("enabled test sidecar must start");
    assert!(socket_path.exists());

    sidecar.stop().await.unwrap();

    assert!(!socket_path.exists());
    std::env::remove_var(HOOKS_INSTALL_RECORD_ENV);
}

#[tokio::test]
#[cfg(unix)]
async fn missing_install_record_is_a_true_noop() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    let record_path = root.path().join("missing-install.json");
    fs::create_dir(&instance_dir).unwrap();
    write_status(
        &instance_dir,
        "hooks-noop-instance",
        V3ManagedRunState::Running,
        Some("runtime detail".to_string()),
    )
    .unwrap();
    std::env::set_var(HOOKS_INSTALL_RECORD_ENV, &record_path);

    let (sidecar, detail) = start_managed_hooks_sidecar(&instance_dir).await.unwrap();

    assert!(sidecar.is_none());
    assert!(detail.is_none());
    assert!(!instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE).exists());
    assert!(!instance_dir.join("hooks-sidecar.sock").exists());
    assert_eq!(
        read_live_status_detail(&instance_dir, "hooks-noop-instance").unwrap(),
        Some("runtime detail".to_string())
    );
    std::env::remove_var(HOOKS_INSTALL_RECORD_ENV);
}

#[tokio::test]
#[cfg(unix)]
async fn disabled_supervisor_is_a_true_noop() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    let record_path = root.path().join("install.json");
    fs::create_dir(&instance_dir).unwrap();
    fs::write(
        &record_path,
        serde_json::json!({
            "supervisor_enabled": false,
            "bin_directory": root.path().join("bin"),
            "install_root": root.path(),
        })
        .to_string(),
    )
    .unwrap();
    write_status(
        &instance_dir,
        "hooks-disabled-instance",
        V3ManagedRunState::Running,
        Some("runtime detail".to_string()),
    )
    .unwrap();
    std::env::set_var(HOOKS_INSTALL_RECORD_ENV, &record_path);

    let (sidecar, detail) = start_managed_hooks_sidecar(&instance_dir).await.unwrap();

    assert!(sidecar.is_none());
    assert!(detail.is_none());
    assert!(!instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE).exists());
    assert!(!instance_dir.join("hooks-sidecar.sock").exists());
    assert_eq!(
        read_live_status_detail(&instance_dir, "hooks-disabled-instance").unwrap(),
        Some("runtime detail".to_string())
    );
    std::env::remove_var(HOOKS_INSTALL_RECORD_ENV);
}

#[test]
#[cfg(unix)]
fn hooks_running_status_never_overwrites_stopping_or_stopped_state() {
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    ensure_private_dir(&instance_dir).unwrap();

    write_status(
        &instance_dir,
        "hooks-status-instance",
        V3ManagedRunState::Stopping,
        Some("main stop in progress".to_string()),
    )
    .unwrap();
    write_running_status_if_current(
        &instance_dir,
        "hooks-status-instance",
        Some("hooks status pending".to_string()),
    )
    .unwrap();
    let status: V3ManagedStatusRecord = read_json(&instance_dir.join("status.json")).unwrap();
    assert_eq!(status.state, V3ManagedRunState::Stopping);
    assert_eq!(status.detail.as_deref(), Some("main stop in progress"));

    write_status(
        &instance_dir,
        "hooks-status-instance",
        V3ManagedRunState::Stopped,
        Some("main stop complete".to_string()),
    )
    .unwrap();
    write_running_status_if_current(
        &instance_dir,
        "hooks-status-instance",
        Some("late hooks status".to_string()),
    )
    .unwrap();
    let status: V3ManagedStatusRecord = read_json(&instance_dir.join("status.json")).unwrap();
    assert_eq!(status.state, V3ManagedRunState::Stopped);
    assert_eq!(status.detail.as_deref(), Some("main stop complete"));
}

#[test]
#[cfg(unix)]
fn hooks_running_status_rejects_instance_identity_mismatch() {
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    ensure_private_dir(&instance_dir).unwrap();
    write_status(
        &instance_dir,
        "main-instance",
        V3ManagedRunState::Running,
        Some("main detail".to_string()),
    )
    .unwrap();

    let error = write_running_status_if_current(
        &instance_dir,
        "foreign-hooks-instance",
        Some("foreign hooks detail".to_string()),
    )
    .unwrap_err();

    assert!(matches!(error, V3LifecycleError::IdentityMismatch(_)));
    let status: V3ManagedStatusRecord = read_json(&instance_dir.join("status.json")).unwrap();
    assert_eq!(status.instance_id, "main-instance");
    assert_eq!(status.state, V3ManagedRunState::Running);
    assert_eq!(status.detail.as_deref(), Some("main detail"));
}

#[test]
#[cfg(unix)]
fn status_lock_contention_is_bounded() {
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    ensure_private_dir(&instance_dir).unwrap();
    let lock_path = instance_dir.join("status.lock");
    let lock_file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .open(lock_path)
        .unwrap();
    assert_eq!(
        unsafe { libc::flock(lock_file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );

    let started = std::time::Instant::now();
    let error = write_status(
        &instance_dir,
        "status-lock-instance",
        V3ManagedRunState::Running,
        None,
    )
    .unwrap_err();

    assert!(matches!(error, V3LifecycleError::Timeout(_)));
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "status lock wait must stay bounded: {:?}",
        started.elapsed()
    );
}

#[tokio::test]
#[cfg(unix)]
async fn stopping_supervisor_during_slow_startup_is_bounded_and_cleans_owned_state() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    let record_path = root.path().join("install.json");
    let bin_directory = root.path().join("bin");
    let hooksd_started = root.path().join("hooksd-started");
    fs::create_dir(&instance_dir).unwrap();
    fs::create_dir(&bin_directory).unwrap();
    fs::write(
        bin_directory.join("rccv3-hooksd"),
        format!(
            "#!/bin/sh\nprintf 'started\\n' > '{}'\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n",
            hooksd_started.display()
        ),
    )
    .unwrap();
    let mut permissions = fs::metadata(bin_directory.join("rccv3-hooksd"))
        .unwrap()
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(bin_directory.join("rccv3-hooksd"), permissions).unwrap();
    fs::write(
        &record_path,
        serde_json::json!({
            "supervisor_enabled": true,
            "bin_directory": bin_directory,
            "install_root": root.path(),
        })
        .to_string(),
    )
    .unwrap();
    std::env::set_var(HOOKS_INSTALL_RECORD_ENV, &record_path);

    let supervisor = V3HooksSidecarSupervisor::spawn(
        instance_dir.clone(),
        "hooks-slow-start-instance".to_string(),
    );
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    while !hooksd_started.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "slow hooksd did not start"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let stop = tokio::time::timeout(Duration::from_secs(2), supervisor.stop())
        .await
        .expect("supervisor stop must not wait for readiness timeout");
    stop.unwrap();

    assert!(!instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE).exists());
    assert!(!instance_dir.join("hooks-sidecar.sock").exists());
    std::env::remove_var(HOOKS_INSTALL_RECORD_ENV);
}

#[tokio::test]
#[cfg(unix)]
async fn readiness_admission_is_bounded_and_deferred_detail_is_published() {
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    ensure_private_dir(&instance_dir).unwrap();
    let instance_id = "hooks-deferred-readiness-instance";
    write_status(
        &instance_dir,
        instance_id,
        V3ManagedRunState::Running,
        Some("hooks sidecar readiness pending".to_string()),
    )
    .unwrap();

    let (readiness_tx, readiness_rx) = tokio::sync::oneshot::channel();
    let mut supervisor =
        V3HooksSidecarSupervisor::from_readiness_for_test(instance_dir.clone(), readiness_rx);
    let admission_started = tokio::time::Instant::now();
    let admission = supervisor
        .wait_for_readiness_or_timeout(Duration::from_millis(100))
        .await
        .unwrap();
    assert!(admission.is_none());
    assert!(
        admission_started.elapsed() < Duration::from_secs(1),
        "readiness admission must stay bounded: {:?}",
        admission_started.elapsed()
    );
    assert_eq!(
        read_live_status_detail(&instance_dir, instance_id).unwrap(),
        Some("hooks sidecar readiness pending".to_string())
    );

    supervisor.spawn_readiness_detail_publisher(instance_dir.clone(), instance_id.to_string());
    readiness_tx
        .send(Some(
            "hooks sidecar unavailable: hooks_unavailable:crashed: readiness task failed"
                .to_string(),
        ))
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    loop {
        let detail = read_live_status_detail(&instance_dir, instance_id).unwrap();
        if detail.as_deref().is_some_and(|detail| {
            detail.contains("hooks sidecar unavailable:")
                && detail.contains("hooks_unavailable:crashed")
        }) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "deferred readiness detail was not published: {detail:?}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    write_status(
        &instance_dir,
        instance_id,
        V3ManagedRunState::Stopped,
        Some("main stop complete".to_string()),
    )
    .unwrap();
    let status: V3ManagedStatusRecord = read_json(&instance_dir.join("status.json")).unwrap();
    assert_eq!(status.state, V3ManagedRunState::Stopped);
    assert_eq!(status.detail.as_deref(), Some("main stop complete"));
}

#[tokio::test]
#[cfg(unix)]
async fn deferred_readiness_does_not_overwrite_an_earlier_crash_detail() {
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    ensure_private_dir(&instance_dir).unwrap();
    let instance_id = "hooks-readiness-race-instance";
    let crash_detail =
        "hooks sidecar unavailable: hooks_unavailable:crashed: hooks sidecar exited after readiness";
    write_status(
        &instance_dir,
        instance_id,
        V3ManagedRunState::Running,
        Some(crash_detail.to_string()),
    )
    .unwrap();

    let (readiness_tx, readiness_rx) = tokio::sync::oneshot::channel();
    let mut supervisor =
        V3HooksSidecarSupervisor::from_readiness_for_test(instance_dir.clone(), readiness_rx);
    supervisor.spawn_readiness_detail_publisher(instance_dir.clone(), instance_id.to_string());
    readiness_tx
        .send(Some(
            "hooks sidecar unavailable: hooks_unavailable:crashed: readiness task failed"
                .to_string(),
        ))
        .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;

    let status: V3ManagedStatusRecord = read_json(&instance_dir.join("status.json")).unwrap();
    assert_eq!(status.state, V3ManagedRunState::Running);
    assert_eq!(status.detail.as_deref(), Some(crash_detail));
}

#[tokio::test]
#[cfg(unix)]
async fn supervisor_readiness_is_a_pending_barrier_until_protocol_ready() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    let record_path = root.path().join("install.json");
    let bin_directory = root.path().join("bin");
    fs::create_dir(&instance_dir).unwrap();
    fs::create_dir(&bin_directory).unwrap();
    fs::write(
        bin_directory.join("rccv3-hooksd"),
        format!(
            "#!/bin/sh\nsleep 1\nprintf '%s\\n' '{{\"protocol\":\"rcc-hooks-sidecar/v1\",\"ready\":true}}'\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n"
        ),
    )
    .unwrap();
    let mut permissions = fs::metadata(bin_directory.join("rccv3-hooksd"))
        .unwrap()
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(bin_directory.join("rccv3-hooksd"), permissions).unwrap();
    fs::write(
        &record_path,
        serde_json::json!({
            "supervisor_enabled": true,
            "bin_directory": bin_directory,
            "install_root": root.path(),
        })
        .to_string(),
    )
    .unwrap();
    std::env::set_var(HOOKS_INSTALL_RECORD_ENV, &record_path);

    let mut supervisor = V3HooksSidecarSupervisor::spawn(
        instance_dir.clone(),
        "hooks-readiness-barrier-instance".to_string(),
    );
    {
        let readiness_future = supervisor.wait_for_readiness();
        tokio::pin!(readiness_future);
        let pending = tokio::time::timeout(Duration::from_millis(250), &mut readiness_future).await;
        assert!(
            pending.is_err(),
            "readiness must remain pending until the sidecar protocol reports ready"
        );
        let readiness = tokio::time::timeout(Duration::from_secs(3), &mut readiness_future)
            .await
            .expect("supervisor readiness must complete")
            .unwrap();
        assert!(readiness.is_none());
    }
    supervisor.stop().await.unwrap();
    std::env::remove_var(HOOKS_INSTALL_RECORD_ENV);
}

#[tokio::test]
#[cfg(unix)]
async fn supervisor_timeout_force_reaps_owned_group_and_record() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    let record_path = root.path().join("install.json");
    let bin_directory = root.path().join("bin");
    fs::create_dir(&instance_dir).unwrap();
    fs::create_dir(&bin_directory).unwrap();
    // The sidecar reports readiness but ignores TERM, so the bounded
    // supervisor stop must fall back to the persisted-record force cleanup.
    let control_socket = instance_dir.join("hooks-sidecar.sock");
    fs::write(
        bin_directory.join("rccv3-hooksd"),
        format!(
            "#!/bin/sh\nexec node -e 'process.on(\"SIGTERM\", () => {{}}); process.on(\"SIGINT\", () => {{}}); const net=require(\"net\"); const server=net.createServer(); server.listen(process.argv[1], () => {{ process.stdout.write(JSON.stringify({{protocol: \"rcc-hooks-sidecar/v1\", ready: true}})+\"\\n\"); }}); setInterval(() => {{}}, 1000);' '{}'\n",
            control_socket.display()
        ),
    )
    .unwrap();
    let mut permissions = fs::metadata(bin_directory.join("rccv3-hooksd"))
        .unwrap()
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(bin_directory.join("rccv3-hooksd"), permissions).unwrap();
    fs::write(
        &record_path,
        serde_json::json!({
            "supervisor_enabled": true,
            "bin_directory": bin_directory,
            "install_root": root.path(),
        })
        .to_string(),
    )
    .unwrap();
    std::env::set_var(HOOKS_INSTALL_RECORD_ENV, &record_path);

    let supervisor = V3HooksSidecarSupervisor::spawn(
        instance_dir.clone(),
        "hooks-force-stop-instance".to_string(),
    );
    let process_record_path = instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE);
    // Wait until the supervisor has consumed readiness and rewritten the
    // record with the control-socket identity; only then is the sidecar
    // adopted and the bounded-stop path reachable.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let adopted = read_json::<V3HooksSidecarProcessRecord>(&process_record_path)
            .map(|record| record.control_socket_identity.is_some())
            .unwrap_or(false);
        if adopted {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "hooks sidecar was not adopted after readiness"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let record: V3HooksSidecarProcessRecord = read_json(&process_record_path).unwrap();
    let process_group_id = record.process_group_id;

    // The bounded stop returns a typed timeout to the main lifecycle; the
    // detached supervisor task stays the cleanup owner and completes the
    // identity-validated SIGTERM/SIGKILL termination afterwards.
    let stop_error = supervisor.stop().await.unwrap_err();
    assert!(
        matches!(stop_error, V3LifecycleError::Timeout(_)),
        "bounded supervisor stop must report a typed timeout, got {stop_error}"
    );

    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        let group_dead = unsafe { libc::kill(-process_group_id, 0) } == -1
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH);
        if group_dead && !process_record_path.exists() {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "detached supervisor cleanup did not reap the owned group and record"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    std::env::remove_var(HOOKS_INSTALL_RECORD_ENV);
}

#[test]
#[cfg(unix)]
fn replaced_codexapp_socket_is_removed_but_original_identity_is_preserved() {
    let root = TempDir::new_in("/tmp").unwrap();
    let socket_path = root.path().join("codexapp.sock");
    let replacement_path = root.path().join("codexapp.replacement.sock");
    let original = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();
    let pre_start_identity = codexapp_socket_identity(&fs::symlink_metadata(&socket_path).unwrap());
    // Keep both socket entries alive while they are allocated. Rebinding the
    // same path after unlink can reuse the original inode on CI filesystems.
    let replacement = std::os::unix::net::UnixListener::bind(&replacement_path).unwrap();
    let startup_identity =
        codexapp_socket_identity(&fs::symlink_metadata(&replacement_path).unwrap());
    assert_ne!(pre_start_identity, startup_identity);
    drop(original);
    fs::remove_file(&socket_path).unwrap();
    fs::rename(&replacement_path, &socket_path).unwrap();

    cleanup_codexapp_socket(&CodexAppSocketCleanup {
        path: socket_path.clone(),
        install_root: root.path().to_path_buf(),
        pre_start_identity: Some(pre_start_identity),
        startup_identity: Some(startup_identity),
    })
    .unwrap();

    drop(replacement);
    assert!(!socket_path.exists());
}

#[test]
#[cfg(unix)]
fn persisted_non_socket_identity_never_authorizes_file_removal() {
    let root = TempDir::new_in("/tmp").unwrap();
    let path = root.path().join("hooks-sidecar.sock");
    fs::write(&path, "not a socket").unwrap();
    let metadata = fs::symlink_metadata(&path).unwrap();
    let identity = CodexAppSocketIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
        is_socket: false,
    };

    remove_file_if_identity_matches(&path, identity).unwrap();

    assert!(path.exists(), "non-socket identity must not delete a file");
}

#[test]
#[cfg(unix)]
fn control_socket_cleanup_without_identity_never_deletes_regular_file() {
    let root = TempDir::new_in("/tmp").unwrap();
    let path = root.path().join("hooks-sidecar.sock");
    fs::write(&path, "replacement regular file").unwrap();

    remove_control_socket_if_present(&path).unwrap();

    assert!(
        path.exists(),
        "socket-only cleanup must preserve a regular file"
    );
}

#[test]
#[cfg(unix)]
fn codexapp_binary_from_record_accepts_installer_bin_directory_and_rejects_escape() {
    let root = TempDir::new_in("/tmp").unwrap();
    let install_root = root.path().join("install");
    let inside_bin = install_root.join("bin");
    let outside_bin = root.path().join("outside-bin");
    fs::create_dir_all(&inside_bin).unwrap();
    fs::create_dir_all(&outside_bin).unwrap();
    fs::write(inside_bin.join("rccv3-codexapp"), "").unwrap();
    fs::write(outside_bin.join("rccv3-codexapp"), "").unwrap();
    let record_path = root.path().join("install.json");
    let install_root_value = serde_json::json!(install_root);

    let relative = serde_json::json!({
        "install_root": install_root_value,
        "bin_directory": "install/bin"
    });
    let relative_error = codexapp_binary_from_record(&relative, &record_path)
        .expect_err("relative bin directory must be rejected");
    assert!(relative_error
        .to_string()
        .contains("bin_directory must be absolute"));

    let installer_layout = serde_json::json!({
        "install_root": install_root,
        "bin_directory": outside_bin
    });
    let resolved = codexapp_binary_from_record(&installer_layout, &record_path).unwrap();
    assert_eq!(
        resolved,
        fs::canonicalize(outside_bin.join("rccv3-codexapp")).unwrap()
    );

    let symlink_bin = root.path().join("symlink-bin");
    let escaped_binary = root.path().join("escaped-rccv3-codexapp");
    fs::create_dir_all(&symlink_bin).unwrap();
    fs::write(&escaped_binary, "").unwrap();
    std::os::unix::fs::symlink(&escaped_binary, symlink_bin.join("rccv3-codexapp")).unwrap();
    let escaped = serde_json::json!({
        "install_root": root.path(),
        "bin_directory": symlink_bin
    });
    let escaped_error = codexapp_binary_from_record(&escaped, &record_path)
        .expect_err("codexapp symlink must not escape the declared bin directory");
    assert!(escaped_error.to_string().contains("inside bin_directory"));
}

#[test]
#[cfg(unix)]
fn dead_persisted_hooks_group_is_reapable_after_leader_exit() {
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    fs::create_dir(&instance_dir).unwrap();
    let mut child = Command::new("sleep")
        .arg("30")
        .process_group(0)
        .spawn()
        .unwrap();
    let process_group_id = child.id() as libc::pid_t;
    let leader_start_token = process_start_token(process_group_id as u32)
        .unwrap()
        .unwrap();
    assert_eq!(unsafe { libc::kill(-process_group_id, libc::SIGKILL) }, 0);
    child.wait().unwrap();
    fs::write(
        instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE),
        serde_json::json!({
            "schema_version": SCHEMA_VERSION,
            "process_group_id": process_group_id,
            "leader_pid": process_group_id,
            "leader_start_token": leader_start_token,
        })
        .to_string(),
    )
    .unwrap();

    assert!(!hooks_sidecar_process_group_is_alive(&instance_dir).unwrap());
}

#[tokio::test]
#[cfg(unix)]
async fn active_cleanup_uses_child_handle_when_start_token_is_missing() {
    let mut group_leader = TokioCommand::new("/bin/sh")
        .arg("-c")
        .arg("trap '' TERM INT; trap 'exit 0' USR1; read -r line")
        .stdin(Stdio::piped())
        .process_group(0)
        .spawn()
        .unwrap();
    let process_group_id = group_leader.id().unwrap() as libc::pid_t;
    let mut child = TokioCommand::new("/bin/sh")
        .arg("-c")
        .arg("while :; do /bin/sleep 60; done")
        .process_group(process_group_id)
        .spawn()
        .unwrap();

    terminate_sidecar(
        Some(&mut child),
        &mut group_leader,
        process_group_id,
        process_group_id as u32,
        "",
    )
    .await
    .unwrap();

    assert_eq!(unsafe { libc::kill(-process_group_id, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
}

#[tokio::test]
#[cfg(unix)]
async fn anchor_identity_mismatch_never_signals_live_process_group() {
    let mut group_leader = TokioCommand::new("/bin/sh")
        .arg("-c")
        .arg("trap '' TERM INT; trap 'exit 0' USR1; read -r line")
        .stdin(Stdio::piped())
        .process_group(0)
        .spawn()
        .unwrap();
    let process_group_id = group_leader.id().unwrap() as libc::pid_t;
    let leader_start_token = process_start_token(process_group_id as u32)
        .unwrap()
        .unwrap();
    let mut child = TokioCommand::new("/bin/sh")
        .arg("-c")
        .arg("while :; do /bin/sleep 60; done")
        .process_group(process_group_id)
        .spawn()
        .unwrap();

    let error = terminate_sidecar(
        Some(&mut child),
        &mut group_leader,
        process_group_id,
        process_group_id as u32,
        "not-the-anchor-token",
    )
    .await
    .unwrap_err();
    assert!(matches!(error, V3LifecycleError::HooksControlValidation(_)));
    assert_eq!(unsafe { libc::kill(-process_group_id, 0) }, 0);

    terminate_sidecar(
        Some(&mut child),
        &mut group_leader,
        process_group_id,
        process_group_id as u32,
        &leader_start_token,
    )
    .await
    .unwrap();
}

#[tokio::test]
#[cfg(unix)]
async fn forced_cleanup_removes_dead_group_control_socket_and_record() {
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    fs::create_dir(&instance_dir).unwrap();
    let mut child = Command::new("sleep")
        .arg("30")
        .process_group(0)
        .spawn()
        .unwrap();
    let process_group_id = child.id() as libc::pid_t;
    let leader_start_token = process_start_token(process_group_id as u32)
        .unwrap()
        .unwrap();
    assert_eq!(unsafe { libc::kill(-process_group_id, libc::SIGKILL) }, 0);
    child.wait().unwrap();

    let control_socket = instance_dir.join("hooks-sidecar.sock");
    let _socket = std::os::unix::net::UnixListener::bind(&control_socket).unwrap();
    let identity = codexapp_socket_identity(&fs::symlink_metadata(&control_socket).unwrap());
    fs::write(
        instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE),
        serde_json::json!({
            "schema_version": SCHEMA_VERSION,
            "process_group_id": process_group_id,
            "leader_pid": process_group_id,
            "leader_start_token": leader_start_token,
            "control_socket_identity": identity,
        })
        .to_string(),
    )
    .unwrap();

    assert_eq!(
        force_terminate_sidecar_by_record(&instance_dir)
            .await
            .unwrap(),
        ForcedSidecarCleanup::RecordRemoved
    );

    assert!(!control_socket.exists());
    assert!(!instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE).exists());
}

#[tokio::test]
#[cfg(unix)]
async fn forced_cleanup_uses_persisted_legacy_codexapp_socket_cleanup() {
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    let socket_path = root.path().join("codexapp.sock");
    fs::create_dir(&instance_dir).unwrap();
    let _socket = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();
    let startup_identity = codexapp_socket_identity(&fs::symlink_metadata(&socket_path).unwrap());
    let mut child = Command::new("sleep")
        .arg("30")
        .process_group(0)
        .spawn()
        .unwrap();
    let process_group_id = child.id() as libc::pid_t;
    let leader_start_token = process_start_token(process_group_id as u32)
        .unwrap()
        .unwrap();
    assert_eq!(unsafe { libc::kill(-process_group_id, libc::SIGKILL) }, 0);
    child.wait().unwrap();

    fs::write(
        instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE),
        serde_json::json!({
            "schema_version": SCHEMA_VERSION,
            "process_group_id": process_group_id,
            "leader_pid": process_group_id,
            "leader_start_token": leader_start_token,
            "codexapp_socket_cleanup": {
                "path": socket_path,
                "install_root": root.path(),
                "pre_start_identity": null,
                "startup_identity": startup_identity,
            },
        })
        .to_string(),
    )
    .unwrap();

    assert_eq!(
        force_terminate_sidecar_by_record(&instance_dir)
            .await
            .unwrap(),
        ForcedSidecarCleanup::RecordRemoved
    );

    assert!(!socket_path.exists());
    assert!(!instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE).exists());
}

#[tokio::test]
#[cfg(unix)]
async fn forced_cleanup_retains_record_until_control_socket_identity_is_persisted() {
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    fs::create_dir(&instance_dir).unwrap();
    let mut child = Command::new("sleep")
        .arg("30")
        .process_group(0)
        .spawn()
        .unwrap();
    let process_group_id = child.id() as libc::pid_t;
    let leader_start_token = process_start_token(process_group_id as u32)
        .unwrap()
        .unwrap();
    assert_eq!(unsafe { libc::kill(-process_group_id, libc::SIGKILL) }, 0);
    child.wait().unwrap();

    // Model the readiness-to-record-update window: the sidecar already owns
    // its control socket, but the process record still lacks the identity.
    let control_socket = instance_dir.join("hooks-sidecar.sock");
    let _socket = std::os::unix::net::UnixListener::bind(&control_socket).unwrap();
    let identity = codexapp_socket_identity(&fs::symlink_metadata(&control_socket).unwrap());
    let record_path = instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE);
    fs::write(
        &record_path,
        serde_json::json!({
            "schema_version": SCHEMA_VERSION,
            "process_group_id": process_group_id,
            "leader_pid": process_group_id,
            "leader_start_token": leader_start_token,
        })
        .to_string(),
    )
    .unwrap();

    assert_eq!(
        force_terminate_sidecar_by_record(&instance_dir)
            .await
            .unwrap(),
        ForcedSidecarCleanup::RecordPreserved
    );

    // Never unlink an unverified socket, and keep the record so the identity
    // can be persisted by the startup owner or a later lifecycle start.
    assert!(control_socket.exists());
    assert!(record_path.exists());

    let mut record: V3HooksSidecarProcessRecord = read_json(&record_path).unwrap();
    record.control_socket_identity = Some(identity);
    write_json_atomic(&record_path, &record).unwrap();

    assert_eq!(
        force_terminate_sidecar_by_record(&instance_dir)
            .await
            .unwrap(),
        ForcedSidecarCleanup::RecordRemoved
    );

    assert!(!control_socket.exists());
    assert!(!record_path.exists());
}

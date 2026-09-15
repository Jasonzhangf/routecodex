use super::*;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::sync::Mutex;
use tempfile::TempDir;

#[cfg(unix)]
static TEST_ENV_LOCK: Mutex<()> = Mutex::new(());

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

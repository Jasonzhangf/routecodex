use super::*;
use crate::tests::{TEST_ENV_LOCK, TEST_HOOKS_INSTALL_RECORD_ENV};
use std::os::unix::fs::PermissionsExt;
use tempfile::TempDir;

fn write_executable(path: &Path, body: &str) {
    fs::write(path, body).unwrap();
    let mut permissions = fs::metadata(path).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).unwrap();
}

fn write_record(root: &Path, bin_directory: &Path, record_path: &Path) {
    fs::write(
        record_path,
        serde_json::json!({
            "supervisor_enabled": true,
            "bin_directory": bin_directory,
            "install_root": root,
        })
        .to_string(),
    )
    .unwrap();
}

#[tokio::test]
#[cfg(unix)]
async fn internal_hooksd_anchor_leader_stays_alive_through_readiness_and_stop() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    let record_path = root.path().join("install.json");
    let bin_directory = root.path().join("bin");
    fs::create_dir(&instance_dir).unwrap();
    fs::create_dir(&bin_directory).unwrap();
    // A ready internal hooksd that stays alive like the real daemon.
    write_executable(
        &bin_directory.join("rccv3-hooksd"),
        "#!/bin/sh\nprintf '%s\\n' '{\"protocol\":\"rcc-hooks-sidecar/v1\",\"ready\":true}'\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n",
    );
    write_record(root.path(), &bin_directory, &record_path);
    std::env::set_var(TEST_HOOKS_INSTALL_RECORD_ENV, &record_path);

    let sidecar = start_configured_hooks_sidecar(&instance_dir)
        .await
        .unwrap()
        .expect("internal hooksd test sidecar must start");

    // Give the anchor a moment; if its piped stdin were dropped it would see
    // EOF and exit immediately, so this window is enough to catch that bug.
    tokio::time::sleep(Duration::from_millis(500)).await;

    // The lifecycle-owned anchor leader must still be alive after readiness.
    // The production start path keeps the piped `ChildStdin` owned by the
    // retained `Child`, so the `read -r line` anchor does not see EOF.
    let record: serde_json::Value =
        serde_json::from_slice(&fs::read(instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE)).unwrap())
            .unwrap();
    let process_group_id = record["process_group_id"].as_i64().unwrap() as libc::pid_t;
    let leader_pid = record["leader_pid"].as_u64().unwrap() as libc::pid_t;
    assert_eq!(
        unsafe { libc::kill(leader_pid, 0) },
        0,
        "anchor leader {leader_pid} must not have exited after readiness"
    );
    assert!(
        hooks_sidecar_process_group_is_alive(&instance_dir).unwrap(),
        "owned process group must be alive after readiness"
    );

    sidecar.stop().await.unwrap();
    assert_eq!(
        unsafe { libc::kill(-process_group_id, 0) },
        -1,
        "stop must remove the complete owned process group"
    );
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
    std::env::remove_var(TEST_HOOKS_INSTALL_RECORD_ENV);
}

#[tokio::test]
#[cfg(unix)]
async fn internal_hooksd_binary_starts_when_present_in_install_bin_directory() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    let record_path = root.path().join("install.json");
    let bin_directory = root.path().join("bin");
    fs::create_dir(&instance_dir).unwrap();
    fs::create_dir(&bin_directory).unwrap();
    let hooksd_binary = bin_directory.join("rccv3-hooksd");
    fs::write(
        &hooksd_binary,
        "#!/bin/sh\nprintf '%s\\n' '{\"protocol\":\"rcc-hooks-sidecar/v1\",\"ready\":true}'\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n",
    )
    .unwrap();
    let mut permissions = fs::metadata(&hooksd_binary).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&hooksd_binary, permissions).unwrap();
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
    std::env::set_var(TEST_HOOKS_INSTALL_RECORD_ENV, &record_path);
    let sidecar = start_configured_hooks_sidecar(&instance_dir)
        .await
        .unwrap()
        .expect("internal hooksd test sidecar must start");
    sidecar.stop().await.unwrap();
    std::env::remove_var(TEST_HOOKS_INSTALL_RECORD_ENV);
}

#[tokio::test]
#[cfg(unix)]
async fn internal_hooksd_receives_namespace_sockets_and_handlers_config() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    let record_path = root.path().join("install.json");
    let bin_directory = root.path().join("bin");
    let args_path = root.path().join("args.txt");
    let tui_socket = root.path().join("tui.sock");
    let desktop_socket = root.path().join("desktop.sock");
    let handlers_config = root.path().join("handlers.json");
    fs::create_dir(&instance_dir).unwrap();
    fs::create_dir(&bin_directory).unwrap();
    fs::write(&tui_socket, "").unwrap();
    fs::write(&desktop_socket, "").unwrap();
    fs::write(&handlers_config, r#"{"schema_version":1,"handlers":[]}"#).unwrap();
    write_executable(
        &bin_directory.join("rccv3-hooksd"),
        &format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nprintf '%s\\n' '{{\"protocol\":\"rcc-hooks-sidecar/v1\",\"ready\":true}}'\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n",
            args_path.display()
        ),
    );
    fs::write(
        &record_path,
        serde_json::json!({
            "supervisor_enabled": true,
            "bin_directory": bin_directory,
            "install_root": root.path(),
            "tui_appserver_socket": tui_socket,
            "desktop_appserver_socket": desktop_socket,
            "hooks_handlers_config": handlers_config,
        })
        .to_string(),
    )
    .unwrap();
    std::env::set_var(TEST_HOOKS_INSTALL_RECORD_ENV, &record_path);

    let sidecar = start_configured_hooks_sidecar(&instance_dir)
        .await
        .unwrap()
        .expect("internal hooksd test sidecar must start");
    let args = fs::read_to_string(&args_path).unwrap();
    assert!(args.contains("--tui-appserver-socket"));
    assert!(args.contains("--desktop-appserver-socket"));
    assert!(args.contains("--handlers-config"));
    assert!(args.contains("--state-file"));
    assert!(args.contains("hooks-sidecar-state.json"));
    sidecar.stop().await.unwrap();
    std::env::remove_var(TEST_HOOKS_INSTALL_RECORD_ENV);
}

#[tokio::test]
#[cfg(unix)]
async fn internal_hooksd_missing_binary_reports_hooks_unavailable_missing() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    let record_path = root.path().join("install.json");
    let bin_directory = root.path().join("bin");
    fs::create_dir(&instance_dir).unwrap();
    fs::create_dir(&bin_directory).unwrap();
    write_record(root.path(), &bin_directory, &record_path);
    fs::write(instance_dir.join("pid.cache"), "runtime-pid").unwrap();
    fs::write(instance_dir.join("control.json"), "runtime-control").unwrap();
    std::env::set_var(TEST_HOOKS_INSTALL_RECORD_ENV, &record_path);

    let (sidecar, detail) = start_managed_hooks_sidecar(&instance_dir).await.unwrap();

    assert!(sidecar.is_none());
    assert!(
        detail.unwrap().contains("hooks_unavailable:missing"),
        "missing internal hooksd must report hooks_unavailable:missing"
    );
    assert!(instance_dir.join("pid.cache").exists());
    assert!(instance_dir.join("control.json").exists());
    std::env::remove_var(TEST_HOOKS_INSTALL_RECORD_ENV);
}

#[tokio::test]
#[cfg(unix)]
async fn missing_internal_hooksd_does_not_fall_back_to_legacy_supervisor() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    let record_path = root.path().join("install.json");
    let bin_directory = root.path().join("bin");
    let legacy_started = root.path().join("legacy-started");
    let supervisor_wrapper = root.path().join("supervisor-wrapper");
    fs::create_dir(&instance_dir).unwrap();
    fs::create_dir(&bin_directory).unwrap();
    write_executable(
        &supervisor_wrapper,
        &format!(
            "#!/bin/sh\nprintf 'started\\n' > '{}'\nprintf '%s\\n' '{{\"protocol\":\"routecodex-hooks-supervisor/v1\",\"ready\":true}}'\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n",
            legacy_started.display()
        ),
    );
    fs::write(
        &record_path,
        serde_json::json!({
            "supervisor_enabled": true,
            "bin_directory": bin_directory,
            "install_root": root.path(),
            "supervisor_wrapper": supervisor_wrapper,
        })
        .to_string(),
    )
    .unwrap();
    std::env::set_var(TEST_HOOKS_INSTALL_RECORD_ENV, &record_path);

    let (sidecar, detail) = start_managed_hooks_sidecar(&instance_dir).await.unwrap();

    assert!(sidecar.is_none());
    assert!(
        detail.unwrap().contains("hooks_unavailable:missing"),
        "missing internal hooksd must fail closed, not select legacy supervisor"
    );
    assert!(!legacy_started.exists());
    std::env::remove_var(TEST_HOOKS_INSTALL_RECORD_ENV);
}

#[tokio::test]
#[cfg(unix)]
async fn internal_hooksd_crash_before_readiness_reports_hooks_unavailable_crashed() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    let record_path = root.path().join("install.json");
    let bin_directory = root.path().join("bin");
    fs::create_dir(&instance_dir).unwrap();
    fs::create_dir(&bin_directory).unwrap();
    write_executable(&bin_directory.join("rccv3-hooksd"), "#!/bin/sh\nexit 17\n");
    write_record(root.path(), &bin_directory, &record_path);
    fs::write(instance_dir.join("pid.cache"), "runtime-pid").unwrap();
    fs::write(instance_dir.join("control.json"), "runtime-control").unwrap();
    std::env::set_var(TEST_HOOKS_INSTALL_RECORD_ENV, &record_path);

    let (sidecar, detail) = start_managed_hooks_sidecar(&instance_dir).await.unwrap();

    assert!(sidecar.is_none());
    assert!(
        detail.unwrap().contains("hooks_unavailable:crashed"),
        "internal hooksd crash must report hooks_unavailable:crashed"
    );
    assert!(instance_dir.join("pid.cache").exists());
    assert!(instance_dir.join("control.json").exists());
    assert!(!instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE).exists());
    std::env::remove_var(TEST_HOOKS_INSTALL_RECORD_ENV);
}

#[tokio::test]
#[cfg(unix)]
async fn internal_hooksd_start_failure_removes_control_socket_after_owned_group_stops() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    let record_path = root.path().join("install.json");
    let bin_directory = root.path().join("bin");
    let hooksd_binary = bin_directory.join("rccv3-hooksd");
    fs::create_dir(&instance_dir).unwrap();
    fs::create_dir(&bin_directory).unwrap();
    write_executable(
        &hooksd_binary,
        "#!/bin/sh\n/usr/bin/ruby -rsocket -e 'UNIXServer.new(ARGV[0])' \"$2\"\nexit 17\n",
    );
    write_record(root.path(), &bin_directory, &record_path);
    std::env::set_var(TEST_HOOKS_INSTALL_RECORD_ENV, &record_path);

    let error = match start_configured_hooks_sidecar(&instance_dir).await {
        Ok(_) => panic!("the first start must fail after binding and crashing"),
        Err(error) => error,
    };
    assert!(
        error.to_string().contains("hooks_unavailable:crashed"),
        "the startup failure must preserve the crashed reason: {error}"
    );
    let control_socket = instance_dir.join("hooks-sidecar.sock");
    assert!(
        !control_socket.exists(),
        "a failed startup must remove the control socket it owned"
    );
    assert!(!instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE).exists());

    write_executable(
        &hooksd_binary,
        "#!/bin/sh\nprintf '%s\\n' '{\"protocol\":\"rcc-hooks-sidecar/v1\",\"ready\":true}'\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n",
    );
    let sidecar = start_configured_hooks_sidecar(&instance_dir)
        .await
        .expect("the second start must not fail with AddrInUse")
        .expect("the ready sidecar must start");
    sidecar.stop().await.unwrap();
    std::env::remove_var(TEST_HOOKS_INSTALL_RECORD_ENV);
}

#[tokio::test]
#[cfg(unix)]
async fn stale_record_without_control_socket_identity_is_reaped_before_internal_start() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    let record_path = root.path().join("install.json");
    let bin_directory = root.path().join("bin");
    fs::create_dir(&instance_dir).unwrap();
    fs::create_dir(&bin_directory).unwrap();
    write_executable(
        &bin_directory.join("rccv3-hooksd"),
        "#!/bin/sh\nprintf '%s\\n' '{\"protocol\":\"rcc-hooks-sidecar/v1\",\"ready\":true}'\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n",
    );
    write_record(root.path(), &bin_directory, &record_path);

    // A previous run was killed before it could persist the control-socket
    // identity and left its bound socket behind.
    let control_socket = instance_dir.join("hooks-sidecar.sock");
    let stale_socket = std::os::unix::net::UnixListener::bind(&control_socket).unwrap();
    drop(stale_socket);
    let mut dead_child = Command::new("sleep")
        .arg("30")
        .process_group(0)
        .spawn()
        .unwrap();
    let process_group_id = dead_child.id() as libc::pid_t;
    let leader_start_token = process_start_token(process_group_id as u32)
        .unwrap()
        .unwrap();
    assert_eq!(unsafe { libc::kill(-process_group_id, libc::SIGKILL) }, 0);
    dead_child.wait().unwrap();
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
    std::env::set_var(TEST_HOOKS_INSTALL_RECORD_ENV, &record_path);

    let sidecar = start_configured_hooks_sidecar(&instance_dir)
        .await
        .expect("stale control-socket cleanup must not fail startup")
        .expect("the ready sidecar must start");
    sidecar.stop().await.unwrap();

    assert!(!control_socket.exists());
    assert!(!instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE).exists());
    std::env::remove_var(TEST_HOOKS_INSTALL_RECORD_ENV);
}

#[tokio::test]
#[cfg(unix)]
async fn stale_live_hooks_group_is_unavailable_instead_of_aborting_start() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    let record_path = root.path().join("install.json");
    let bin_directory = root.path().join("bin");
    fs::create_dir(&instance_dir).unwrap();
    fs::create_dir(&bin_directory).unwrap();
    write_record(root.path(), &bin_directory, &record_path);
    // A foreign process group is alive and a matching process record is
    // persisted from a previous run. Startup must not adopt or signal it, and
    // must not abort the main service.
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
    fs::write(instance_dir.join("pid.cache"), "runtime-pid").unwrap();
    fs::write(instance_dir.join("control.json"), "runtime-control").unwrap();
    std::env::set_var(TEST_HOOKS_INSTALL_RECORD_ENV, &record_path);

    let (sidecar, detail) = start_managed_hooks_sidecar(&instance_dir).await.unwrap();

    assert!(sidecar.is_none(), "stale foreign group must not be adopted");
    let detail = detail.expect("unavailable startup must carry a detail");
    assert!(
        detail.contains("hooks_unavailable:"),
        "stale live group must report hooks_unavailable: {detail}"
    );
    assert!(
        detail.contains("still alive"),
        "unavailable detail must keep the exact reason: {detail}"
    );
    // The foreign group must be untouched and the main-service caches intact.
    assert!(instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE).exists());
    assert!(instance_dir.join("pid.cache").exists());
    assert!(instance_dir.join("control.json").exists());
    assert_eq!(unsafe { libc::kill(-process_group_id, libc::SIGKILL) }, 0);
    let _ = child.wait().await;
    std::env::remove_var(TEST_HOOKS_INSTALL_RECORD_ENV);
}

#[tokio::test]
#[cfg(unix)]
async fn internal_hooksd_readiness_timeout_reports_hooks_unavailable_timeout() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    let record_path = root.path().join("install.json");
    let bin_directory = root.path().join("bin");
    fs::create_dir(&instance_dir).unwrap();
    fs::create_dir(&bin_directory).unwrap();
    write_executable(
        &bin_directory.join("rccv3-hooksd"),
        "#!/bin/sh\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n",
    );
    write_record(root.path(), &bin_directory, &record_path);
    fs::write(instance_dir.join("pid.cache"), "runtime-pid").unwrap();
    fs::write(instance_dir.join("control.json"), "runtime-control").unwrap();
    std::env::set_var(TEST_HOOKS_INSTALL_RECORD_ENV, &record_path);

    let error = match start_configured_hooks_sidecar_with_timeout(
        &instance_dir,
        Duration::from_millis(250),
    )
    .await
    {
        Ok(_) => panic!("readiness timeout must fail closed"),
        Err(error) => error,
    };

    assert!(
        error.to_string().contains("hooks_unavailable:timeout"),
        "internal hooksd readiness timeout must report hooks_unavailable:timeout"
    );
    assert!(instance_dir.join("pid.cache").exists());
    assert!(instance_dir.join("control.json").exists());
    assert!(!instance_dir.join(HOOKS_SIDECAR_PROCESS_FILE).exists());
    std::env::remove_var(TEST_HOOKS_INSTALL_RECORD_ENV);
}

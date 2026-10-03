use super::*;
use crate::tests::{TEST_ENV_LOCK, TEST_HOOKS_INSTALL_RECORD_ENV};
use serde_json::Value;
use std::ffi::OsString;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

// Real workspace binary + typed project lease; finite artifact failure fixtures
// never impersonate a successful daemon. HOME changes share TEST_ENV_LOCK.
struct Fixture {
    root: TempDir,
    record: PathBuf,
    bin: PathBuf,
    old_home: Option<OsString>,
    old_record: Option<OsString>,
    daemon: Option<std::process::Child>,
}

impl Fixture {
    fn new(start_daemon: bool) -> Self {
        let root = tempfile::Builder::new()
            .prefix("rhl-")
            .tempdir_in("/tmp")
            .unwrap();
        let bin = root.path().join("bin");
        fs::create_dir(&bin).unwrap();
        let binary = std::env::current_exe()
            .unwrap()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join("rccv3-hooksd");
        assert!(
            binary.is_file(),
            "first cargo build -p routecodex-v3-hooks --bin rccv3-hooksd"
        );
        fs::copy(&binary, bin.join("rccv3-hooksd")).unwrap();
        let record = root.path().join("install.json");
        fs::write(
            &record,
            serde_json::json!({
                "supervisor_enabled":true, "bin_directory":bin, "install_root":root.path()
            })
            .to_string(),
        )
        .unwrap();
        let old_home = std::env::var_os("HOME");
        let old_record = std::env::var_os(TEST_HOOKS_INSTALL_RECORD_ENV);
        std::env::set_var("HOME", root.path());
        std::env::set_var(TEST_HOOKS_INSTALL_RECORD_ENV, &record);
        let daemon = start_daemon.then(|| {
            std::process::Command::new(binary)
                .arg("--shared-daemon")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap()
        });
        let mut fixture = Self {
            root,
            record,
            bin,
            old_home,
            old_record,
            daemon,
        };
        if start_daemon {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while !fixture.global_socket().exists() {
                assert!(fixture
                    .daemon
                    .as_mut()
                    .unwrap()
                    .try_wait()
                    .unwrap()
                    .is_none());
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        fixture
    }
    fn global_socket(&self) -> PathBuf {
        self.root.path().join(".rcc/hooks/daemon.sock")
    }
    fn project(&self, name: &str) -> PathBuf {
        let project = self.root.path().join(name);
        fs::create_dir(&project).unwrap();
        fs::canonicalize(project).unwrap()
    }
    fn replace_binary(&self, source: &str) {
        let binary = self.bin.join("rccv3-hooksd");
        fs::remove_file(&binary).unwrap();
        fs::write(&binary, source).unwrap();
        fs::set_permissions(binary, fs::Permissions::from_mode(0o755)).unwrap();
    }
    async fn idle_exit(&mut self) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(child) = self.daemon.as_mut() {
                if let Some(status) = child.try_wait().unwrap() {
                    assert!(status.success());
                    break;
                }
            } else if !self.global_socket().exists() {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "shared daemon must exit after its last lease"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(!self.global_socket().exists());
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Some(child) = self.daemon.as_mut() {
            if child.try_wait().unwrap().is_none() {
                child.kill().expect("test daemon cleanup");
            }
            child.wait().expect("test daemon reap");
        }
        for (name, value) in [
            ("HOME", &self.old_home),
            (TEST_HOOKS_INSTALL_RECORD_ENV, &self.old_record),
        ] {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }
}

async fn health(project: &Path) -> bool {
    let mut stream = tokio::net::UnixStream::connect(project.join("hooks-sidecar.sock"))
        .await
        .unwrap();
    stream
        .write_all(b"{\"method\":\"health\"}\n")
        .await
        .unwrap();
    let mut line = String::new();
    tokio::time::timeout(
        Duration::from_secs(2),
        tokio::io::BufReader::new(stream).read_line(&mut line),
    )
    .await
    .unwrap()
    .unwrap();
    let response: routecodex_v3_hooks::ControlResponse = serde_json::from_str(&line).unwrap();
    response.ok && response.protocol == routecodex_v3_hooks::PROTOCOL
}

fn running(project: &Path, instance: &str) {
    fs::write(project.join("pid.cache"), "runtime-pid").unwrap();
    fs::write(project.join("control.json"), "runtime-control").unwrap();
    write_status(project, instance, V3ManagedRunState::Running, None).unwrap();
}

async fn wait_degraded(project: &Path, instance: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let detail = read_live_status_detail(project, instance)
            .unwrap()
            .unwrap_or_default();
        if detail.contains("hooks_unavailable:crashed") {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
        "expected explicit hooks-unavailable status: {detail}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let status: V3ManagedStatusRecord = read_json(&project.join("status.json")).unwrap();
    assert_eq!(status.state, V3ManagedRunState::Running);
    assert!(project.join("pid.cache").exists());
    assert!(project.join("control.json").exists());
}

#[tokio::test]
async fn internal_hooksd_projects_share_a_daemon_and_stop_only_their_registration() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let mut fixture = Fixture::new(true);
    let a = fixture.project("a");
    let b = fixture.project("b");
    let a_sidecar = start_configured_hooks_sidecar(&a).await.unwrap().unwrap();
    let b_sidecar = start_configured_hooks_sidecar(&b).await.unwrap().unwrap();
    match (&a_sidecar, &b_sidecar) {
        (V3HooksSidecarProcess::Shared(a), V3HooksSidecarProcess::Shared(b)) => {
            assert_eq!(a.daemon_pid, b.daemon_pid);
            assert_eq!(a.daemon_pid, fixture.daemon.as_ref().unwrap().id());
        }
        _ => panic!("internal mode must use project leases"),
    }
    assert!(
        !a.join(HOOKS_SIDECAR_PROCESS_FILE).exists(),
        "no per-project PID/group owner"
    );
    assert!(health(&a).await && health(&b).await);
    a_sidecar.stop().await.unwrap();
    assert!(!a.join("hooks-sidecar.sock").exists());
    assert!(health(&b).await);
    b_sidecar.stop().await.unwrap();
    fixture.idle_exit().await;
}

#[tokio::test]
async fn internal_hooksd_launches_real_shared_binary_and_drop_lease_cleans_project() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let mut fixture = Fixture::new(false);
    let project = fixture.project("launch");
    let sidecar = start_configured_hooks_sidecar(&project)
        .await
        .unwrap()
        .unwrap();
    assert!(health(&project).await);
    drop(sidecar);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while project.join("hooks-sidecar.sock").exists() {
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    fixture.idle_exit().await;
}

#[tokio::test]
async fn internal_hooksd_daemon_crash_preserves_running_runtime() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let mut fixture = Fixture::new(true);
    let project = fixture.project("crash");
    running(&project, "crash");
    let mut supervisor = V3HooksSidecarSupervisor::spawn(project.clone(), "crash".into());
    let readiness = supervisor.wait_for_readiness().await.unwrap();
    assert!(readiness.is_none(), "{readiness:?}");
    assert!(health(&project).await);
    fixture.daemon.as_mut().unwrap().kill().unwrap();
    fixture.daemon.as_mut().unwrap().wait().unwrap();
    wait_degraded(&project, "crash").await;
    // A simultaneous control/lease loss can expose the failed cleanup ACK.
    // Preserve that error; the process has been reaped and RCC stays Running.
    if let Err(error) = supervisor.stop().await {
        assert!(
            matches!(
                error,
                V3LifecycleError::Io(_) | V3LifecycleError::HooksOptionalUnavailable(_)
            ),
            "{error}"
        );
    }
    assert!(!project.join("hooks-sidecar.sock").exists());
}

#[tokio::test]
async fn internal_hooksd_project_socket_loss_releases_only_affected_registration() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let mut fixture = Fixture::new(true);
    let a = fixture.project("lost");
    let b = fixture.project("healthy");
    running(&a, "lost");
    let mut supervisor = V3HooksSidecarSupervisor::spawn(a.clone(), "lost".into());
    let readiness = supervisor.wait_for_readiness().await.unwrap();
    assert!(readiness.is_none(), "{readiness:?}");
    let b_sidecar = start_configured_hooks_sidecar(&b).await.unwrap().unwrap();
    fs::remove_file(a.join("hooks-sidecar.sock")).unwrap();
    wait_degraded(&a, "lost").await;
    supervisor.stop().await.unwrap();
    assert!(health(&b).await);
    b_sidecar.stop().await.unwrap();
    fixture.idle_exit().await;
}

#[tokio::test]
async fn internal_hooksd_replacement_socket_is_preserved_and_instance_degrades() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let mut fixture = Fixture::new(true);
    let project = fixture.project("replace");
    running(&project, "replace");
    let mut supervisor = V3HooksSidecarSupervisor::spawn(project.clone(), "replace".into());
    let readiness = supervisor.wait_for_readiness().await.unwrap();
    assert!(readiness.is_none(), "{readiness:?}");
    let socket = project.join("hooks-sidecar.sock");
    fs::remove_file(&socket).unwrap();
    let replacement = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    let expected = fs::symlink_metadata(&socket).unwrap().ino();
    wait_degraded(&project, "replace").await;
    supervisor.stop().await.unwrap();
    assert_eq!(fs::symlink_metadata(&socket).unwrap().ino(), expected);
    drop(replacement);
    fs::remove_file(socket).unwrap();
    fixture.idle_exit().await;
}

#[tokio::test]
async fn internal_hooksd_invalid_handlers_fail_without_runtime_damage() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let mut fixture = Fixture::new(true);
    let project = fixture.project("invalid");
    running(&project, "invalid");
    let config = fixture.root.path().join("handlers.json");
    fs::write(&config, r#"{"schema_version":9,"handlers":[]}"#).unwrap();
    let mut record: Value = serde_json::from_slice(&fs::read(&fixture.record).unwrap()).unwrap();
    record["hooks_handlers_config"] = serde_json::json!(config);
    fs::write(&fixture.record, record.to_string()).unwrap();
    let (sidecar, detail) = start_managed_hooks_sidecar(&project).await.unwrap();
    assert!(sidecar.is_none());
    assert!(detail
        .unwrap()
        .contains("unsupported hooks handlers config schema"));
    assert!(!project.join("hooks-sidecar.sock").exists());
    assert!(project.join("pid.cache").exists());
    fixture.idle_exit().await;
}

#[tokio::test]
async fn internal_hooksd_missing_binary_does_not_select_legacy_supervisor() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let fixture = Fixture::new(false);
    let project = fixture.project("missing");
    running(&project, "missing");
    fs::remove_file(fixture.bin.join("rccv3-hooksd")).unwrap();
    let marker = fixture.root.path().join("legacy-started");
    let wrapper = fixture.root.path().join("supervisor-wrapper");
    fs::write(
        &wrapper,
        format!("#!/bin/sh\nprintf started > '{}'\n", marker.display()),
    )
    .unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
    let mut record: Value = serde_json::from_slice(&fs::read(&fixture.record).unwrap()).unwrap();
    record["supervisor_wrapper"] = serde_json::json!(wrapper);
    fs::write(&fixture.record, record.to_string()).unwrap();
    let (sidecar, detail) = start_managed_hooks_sidecar(&project).await.unwrap();
    assert!(sidecar.is_none());
    assert!(detail.unwrap().contains("hooks_unavailable:missing"));
    assert!(!marker.exists());
    assert!(project.join("pid.cache").exists());
}

#[tokio::test]
async fn internal_hooksd_old_binary_is_rejected_before_resident_launch() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let fixture = Fixture::new(false);
    let project = fixture.project("old");
    fixture.replace_binary(
        "#!/bin/sh\nprintf '%s\\n' '{\"protocol\":\"rcc-hooks-sidecar/v1\",\"ready\":true}'\n",
    );
    let (sidecar, detail) = start_managed_hooks_sidecar(&project).await.unwrap();
    assert!(sidecar.is_none());
    assert!(detail
        .unwrap()
        .contains("hooks_unavailable:invalid_readiness"));
    assert!(!fixture.global_socket().exists());
}

#[tokio::test]
async fn internal_hooksd_capability_probe_crash_is_optional() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let fixture = Fixture::new(false);
    let project = fixture.project("bad-artifact");
    running(&project, "bad-artifact");
    fixture.replace_binary("#!/bin/sh\nexit 17\n");
    let (sidecar, detail) = start_managed_hooks_sidecar(&project).await.unwrap();
    assert!(sidecar.is_none());
    let detail = detail.unwrap();
    assert!(detail.contains("hooks_unavailable:crashed"), "{detail}");
    assert!(project.join("pid.cache").exists());
    assert!(!project.join(HOOKS_SIDECAR_PROCESS_FILE).exists());
}

#[tokio::test]
async fn internal_hooksd_probe_timeout_and_startup_cancellation_are_bounded() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let fixture = Fixture::new(false);
    let project = fixture.project("timeout");
    let marker = fixture.root.path().join("probe-pid");
    fixture.replace_binary(&format!(
        "#!/bin/sh\nprintf '%s' $$ > '{}'\nsleep 60\n",
        marker.display()
    ));
    let start = std::time::Instant::now();
    let result =
        start_configured_hooks_sidecar_with_timeout(&project, Duration::from_millis(250)).await;
    assert!(result
        .err()
        .unwrap()
        .to_string()
        .contains("hooks_unavailable:timeout"));
    assert!(start.elapsed() < Duration::from_secs(2));
    if marker.exists() {
        let pid: i32 = fs::read_to_string(&marker).unwrap().parse().unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        fs::remove_file(&marker).unwrap();
    }
    running(&project, "cancel");
    let supervisor = V3HooksSidecarSupervisor::spawn(project.clone(), "cancel".into());
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !marker.exists() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "probe must reach its marker before cancellation"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let start = std::time::Instant::now();
    supervisor.stop().await.unwrap();
    assert!(start.elapsed() < Duration::from_secs(2));
    let pid: i32 = fs::read_to_string(marker).unwrap().parse().unwrap();
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    assert!(!project.join(HOOKS_SIDECAR_PROCESS_FILE).exists());
}

#[tokio::test]
async fn internal_hooksd_stale_dead_record_and_socket_are_reaped_before_registration() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let mut fixture = Fixture::new(true);
    let project = fixture.project("stale");
    let socket = project.join("hooks-sidecar.sock");
    drop(std::os::unix::net::UnixListener::bind(&socket).unwrap());
    fs::write(
        project.join(HOOKS_SIDECAR_PROCESS_FILE),
        serde_json::json!({
            "schema_version":SCHEMA_VERSION, "process_group_id":2147483647,
            "leader_pid":2147483647, "leader_start_token":"dead"
        })
        .to_string(),
    )
    .unwrap();
    let sidecar = start_configured_hooks_sidecar(&project)
        .await
        .unwrap()
        .unwrap();
    assert!(health(&project).await);
    assert!(!project.join(HOOKS_SIDECAR_PROCESS_FILE).exists());
    sidecar.stop().await.unwrap();
    assert!(!socket.exists());
    fixture.idle_exit().await;
}

#[tokio::test]
async fn internal_hooksd_stale_live_group_is_not_adopted_or_signalled() {
    let _guard = TEST_ENV_LOCK.lock().unwrap();
    let fixture = Fixture::new(false);
    let project = fixture.project("foreign");
    let mut child = Command::new("sleep")
        .arg("30")
        .process_group(0)
        .spawn()
        .unwrap();
    let pid = child.id();
    fs::write(
        project.join(HOOKS_SIDECAR_PROCESS_FILE),
        serde_json::json!({
            "schema_version":SCHEMA_VERSION, "process_group_id":pid,
            "leader_pid":pid, "leader_start_token":process_start_token(pid).unwrap().unwrap()
        })
        .to_string(),
    )
    .unwrap();
    let (sidecar, detail) = start_managed_hooks_sidecar(&project).await.unwrap();
    assert!(sidecar.is_none());
    assert!(detail.unwrap().contains("still alive"));
    assert!(child.try_wait().unwrap().is_none());
    child.kill().unwrap();
    child.wait().unwrap();
}

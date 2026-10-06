use super::*;
use std::io;

const TRANSIENT_ACCEPT_CHILD_ENV: &str = "RCC_LIFECYCLE_TRANSIENT_ACCEPT_CHILD";

#[test]
fn transient_control_accept_errors_end_only_the_affected_accept() {
    for kind in [io::ErrorKind::Interrupted, io::ErrorKind::ConnectionAborted] {
        assert!(
            control_accept_error_is_transient(&V3LifecycleError::Io(io::Error::from(kind))),
            "transient accept kind {kind:?} must be retried"
        );
    }
    for errno in [libc::EMFILE, libc::ENFILE, libc::EPROTO, libc::ENETDOWN] {
        assert!(
            control_accept_error_is_transient(&V3LifecycleError::Io(
                io::Error::from_raw_os_error(errno)
            )),
            "transient accept errno {errno} must be retried"
        );
    }
    for errno in [libc::EBADF, libc::EINVAL, libc::ENOTSOCK, libc::ENOENT] {
        assert!(
            !control_accept_error_is_transient(&V3LifecycleError::Io(
                io::Error::from_raw_os_error(errno)
            )),
            "fatal accept errno {errno} must keep escalating"
        );
    }
    assert!(!control_accept_error_is_transient(
        &V3LifecycleError::Validation("not an io failure".to_string())
    ));
}

#[cfg(unix)]
fn current_nofile_limit() -> (libc::rlim_t, libc::rlim_t) {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    assert_eq!(
        unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) },
        0
    );
    (limit.rlim_cur, limit.rlim_max)
}

#[cfg(unix)]
fn set_nofile_limit(soft: libc::rlim_t) {
    let (_, hard) = current_nofile_limit();
    let limit = libc::rlimit {
        rlim_cur: soft,
        rlim_max: hard,
    };
    assert_eq!(
        unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) },
        0
    );
}

#[cfg(unix)]
#[test]
fn transient_control_accept_error_keeps_managed_runtime_serving() {
    // RLIMIT_NOFILE is process-wide, so the real control-plane case runs in a
    // dedicated child process that runs only the `..._child` case below. The
    // parent asserts on the child's result.
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("--exact")
        .arg(
            "tests::control_plane_accept::transient_control_accept_error_keeps_managed_runtime_serving_child",
        )
        .arg("--nocapture")
        .arg("--test-threads=1")
        .env(TRANSIENT_ACCEPT_CHILD_ENV, "1")
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success() && stdout.contains("1 passed"),
        "child control-plane accept case did not pass:\nstatus={:?}\n--- stdout ---\n{stdout}\n--- stderr ---\n{stderr}",
        output.status
    );
}

#[cfg(unix)]
#[tokio::test]
async fn transient_control_accept_error_keeps_managed_runtime_serving_child() {
    if std::env::var(TRANSIENT_ACCEPT_CHILD_ENV).is_err() {
        // The fd limit change below is process-wide, so this case only runs
        // inside the dedicated child process spawned by the parent case.
        return;
    }
    let root = TempDir::new().unwrap();
    let instance_dir = root.path().join("instance");
    ensure_private_dir(&instance_dir).unwrap();
    let instance_id = "control-accept-transient-instance";
    let start_nonce = "generation-1".to_string();
    let socket_path = root.path().join("managed-control.sock");
    let config_path = root.path().join("config.toml");
    // The config path must exist so the ephemeral-config orphan watchdog stays
    // armed instead of ending the control loop.
    fs::write(&config_path, "config").unwrap();
    let declaration = V3ManagedInstanceDeclaration {
        schema_version: SCHEMA_VERSION,
        instance_id: instance_id.to_string(),
        config_path: config_path.display().to_string(),
        config_digest: "digest".to_string(),
        executable_path: root.path().join("rccv3").display().to_string(),
        listeners: Vec::new(),
    };
    write_json_atomic(
        &instance_dir.join("pid.cache"),
        &V3ManagedPidCache {
            schema_version: SCHEMA_VERSION,
            instance_id: instance_id.to_string(),
            pid: std::process::id(),
            start_nonce: start_nonce.to_string(),
            started_at_epoch_ms: 0,
            process_start_token: None,
        },
    )
    .unwrap();
    write_json_atomic(
        &instance_dir.join("control.json"),
        &V3ManagedControlRecord {
            schema_version: SCHEMA_VERSION,
            instance_id: instance_id.to_string(),
            socket_path: socket_path.display().to_string(),
            start_nonce: start_nonce.to_string(),
        },
    )
    .unwrap();
    write_status(&instance_dir, instance_id, V3ManagedRunState::Running, None).unwrap();
    let listener = tokio::net::UnixListener::bind(&socket_path).unwrap();
    let control_loop = tokio::spawn({
        let instance_dir = instance_dir.clone();
        let declaration = declaration.clone();
        let socket_path = socket_path.clone();
        let supervisor = V3HooksSidecarSupervisor::from_startup(
            instance_dir.clone(),
            tokio::spawn(async { Ok(None) }),
        );
        async move {
            run_managed_control_loop(
                &instance_dir,
                &declaration,
                &socket_path,
                start_nonce,
                listener,
                None,
                supervisor,
                false,
            )
            .await
        }
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        !control_loop.is_finished(),
        "the control loop must be waiting in accept before the transient failure"
    );

    // Induce a real transient accept failure: with no free file descriptor the
    // listener accept fails with EMFILE while the managed runtime keeps running.
    let (saved_soft, _) = current_nofile_limit();
    set_nofile_limit(0);
    tokio::time::sleep(Duration::from_millis(300)).await;
    set_nofile_limit(saved_soft);

    assert!(
        !control_loop.is_finished(),
        "a transient control accept failure must not tear down the managed runtime"
    );
    let response = send_control(&instance_dir, &declaration, ControlOperation::Status)
        .await
        .expect("the managed runtime must still serve control requests");
    assert!(response.accepted);
    assert_eq!(response.state, V3ManagedRunState::Running);
    let status: V3ManagedStatusRecord = read_json(&instance_dir.join("status.json")).unwrap();
    assert_eq!(status.state, V3ManagedRunState::Running);

    control_loop.abort();
}

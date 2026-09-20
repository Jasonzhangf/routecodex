use routecodex_v4_lifecycle::{
    release_unmanaged_listener, repair_stale, status_managed, CordisSocketIdentity, LifecycleError,
    ManagedAction, ManagedControlPlane, ManagedInstanceRecord, V4LifecyclePaths,
};
use std::fs;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

fn test_root(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("rccv4-lifecycle-{name}-{}", std::process::id()))
}

fn record() -> ManagedInstanceRecord {
    ManagedInstanceRecord {
        runtime_identity: "rccv4".to_string(),
        pid: std::process::id(),
        generation_nonce: 1,
        cordis_socket_identity: None,
        config_path: "/tmp/config.v4.toml".to_string(),
        manifest_path: "/tmp/manifest.json".to_string(),
        manifest_digest: "sha256:test".to_string(),
        listeners: vec!["127.0.0.1:61234".to_string()],
    }
}

#[test]
fn paths_are_v4_scoped_and_never_name_v3() {
    let paths = V4LifecyclePaths::for_state_root(test_root("paths"));
    for path in [
        &paths.state_root,
        &paths.record_path,
        &paths.control_socket,
        &paths.manifest_path,
        &paths.log_path,
    ] {
        assert!(!path.to_string_lossy().contains("v3"));
    }
}

#[test]
fn control_socket_reports_status_and_stop_for_exact_instance() {
    let paths = V4LifecyclePaths::for_state_root(test_root("control"));
    let control = ManagedControlPlane::bind(paths.clone(), record()).expect("bind");
    let status_paths = paths.clone();
    let status = thread::spawn(move || status_managed(&status_paths).expect("status"));
    for _ in 0..100 {
        if control.poll().expect("poll") == ManagedAction::Continue && status.is_finished() {
            break;
        }
        thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(status.join().expect("join").state, "running");
    let running_state: serde_json::Value =
        serde_json::from_slice(&fs::read(&paths.status_path).expect("running status file"))
            .expect("running status JSON");
    assert_eq!(running_state["state"], "running");
    control.clear_record().expect("clear");
    assert!(!paths.control_socket.exists());
    let stopped_state: serde_json::Value =
        serde_json::from_slice(&fs::read(&paths.status_path).expect("stopped status file"))
            .expect("stopped status JSON");
    assert_eq!(stopped_state["state"], "stopped");
    drop(control);
    fs::remove_dir_all(&paths.state_root).expect("cleanup exact test root");
}

#[test]
fn existing_record_or_socket_fails_fast_without_silent_cleanup() {
    let paths = V4LifecyclePaths::for_state_root(test_root("stale"));
    let control = ManagedControlPlane::bind(paths.clone(), record()).expect("bind");
    assert!(ManagedControlPlane::bind(paths.clone(), record()).is_err());
    control.clear_record().expect("clear");
    drop(control);
    fs::remove_dir_all(&paths.state_root).expect("cleanup exact test root");
}

#[test]
fn cordis_socket_witness_round_trips_and_rejects_zero_identity() {
    let paths = V4LifecyclePaths::for_state_root(test_root("cordis-witness"));
    let mut record = record();
    record.cordis_socket_identity = Some(CordisSocketIdentity {
        pid: 12345,
        start_time: 99,
        device: 7,
        inode: 11,
    });
    let control = ManagedControlPlane::bind(paths.clone(), record.clone()).expect("bind");
    let loaded = routecodex_v4_lifecycle::read_record(&paths)
        .expect("read record")
        .expect("record");
    assert_eq!(loaded.cordis_socket_identity, record.cordis_socket_identity);
    control.clear_record().expect("clear");
    drop(control);

    record.cordis_socket_identity = Some(CordisSocketIdentity {
        pid: 1,
        start_time: 0,
        device: 0,
        inode: 1,
    });
    assert!(ManagedControlPlane::bind(paths.clone(), record).is_err());
    fs::remove_dir_all(&paths.state_root).expect("cleanup exact test root");
}

#[test]
fn repair_stale_removes_dead_instance_record_and_socket() {
    let paths = V4LifecyclePaths::for_state_root(test_root("repair"));
    paths.prepare().expect("prepare");
    fs::write(
        &paths.record_path,
        serde_json::to_vec(&ManagedInstanceRecord {
            pid: 999_999_999,
            ..record()
        })
        .expect("record"),
    )
    .expect("write record");
    std::os::unix::net::UnixListener::bind(&paths.control_socket).expect("socket");
    repair_stale(&paths).expect("repair");
    assert!(!paths.record_path.exists());
    assert!(!paths.control_socket.exists());
    fs::remove_dir_all(&paths.state_root).expect("cleanup exact test root");
}

#[test]
fn repair_stale_refuses_unwitnessed_control_socket() {
    let paths = V4LifecyclePaths::for_state_root(test_root("socket-only"));
    paths.prepare().expect("prepare");
    std::os::unix::net::UnixListener::bind(&paths.control_socket).expect("socket");
    assert!(matches!(
        repair_stale(&paths),
        Err(LifecycleError::StaleState)
    ));
    assert!(
        paths.control_socket.exists(),
        "unwitnessed control socket must not be removed"
    );
    fs::remove_dir_all(&paths.state_root).expect("cleanup exact test root");
}

#[test]
fn unmanaged_takeover_never_signals_foreign_listener() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("listener");
    let address = listener.local_addr().expect("address").to_string();
    let result = release_unmanaged_listener(&address, Duration::from_millis(100));
    assert!(
        matches!(result, Ok(()) | Err(LifecycleError::CommandTimeout(100))),
        "foreign listener must remain untouched; bounded probe result: {result:?}"
    );
    assert!(std::net::TcpStream::connect(&address).is_ok());
}

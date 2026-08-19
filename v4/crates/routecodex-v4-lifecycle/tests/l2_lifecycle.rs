use routecodex_v4_lifecycle::{
    status_managed, ManagedAction, ManagedControlPlane, ManagedInstanceRecord,
    V4LifecyclePaths,
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
    control.clear_record().expect("clear");
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

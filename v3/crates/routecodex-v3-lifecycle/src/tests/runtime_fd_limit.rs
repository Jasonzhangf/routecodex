use super::*;

#[test]
fn managed_declaration_serialization_remains_previous_release_compatible() {
    let current: V3ManagedInstanceDeclaration = serde_json::from_value(serde_json::json!({
        "schema_version": SCHEMA_VERSION,
        "instance_id": "instance",
        "config_path": "/tmp/config.toml",
        "config_digest": "digest",
        "executable_path": "/tmp/rccv3",
        "listeners": []
    }))
    .unwrap();
    let encoded = serde_json::to_value(&current).unwrap();
    assert_eq!(encoded.get("fd_limit"), None);
}

#[test]
fn runtime_fd_limit_is_loaded_from_config_snapshot() {
    let root = TempDir::new().unwrap();
    let (config, _, _) = fixture(&root);
    let mut raw = fs::read_to_string(&config).unwrap();
    raw.push_str("\n[runtime]\nfd_limit = 4096\n");
    fs::write(&config, raw).unwrap();

    let snapshot = load_v3_config_snapshot_from_path(&config).unwrap();
    assert_eq!(snapshot.runtime.fd_limit, Some(4096));
}

#[test]
fn zero_fd_limit_is_rejected() {
    assert!(matches!(
        apply_v3_runtime_fd_limit(Some(0)),
        Err(V3LifecycleError::Validation(_))
    ));
}

#[test]
fn absent_fd_limit_is_a_noop() {
    apply_v3_runtime_fd_limit(None).unwrap();
}

#[test]
fn fd_limit_is_applied_to_the_current_process() {
    let mut before = std::mem::MaybeUninit::<libc::rlimit>::uninit();
    assert_eq!(
        unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, before.as_mut_ptr()) },
        0
    );
    let before = unsafe { before.assume_init() };
    let target = if before.rlim_max == libc::RLIM_INFINITY {
        1024
    } else {
        1024.min(before.rlim_max as u64)
    };
    apply_v3_runtime_fd_limit(Some(1024)).unwrap();
    let mut after = std::mem::MaybeUninit::<libc::rlimit>::uninit();
    assert_eq!(
        unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, after.as_mut_ptr()) },
        0
    );
    let after = unsafe { after.assume_init() };
    assert_eq!(
        unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &before) },
        0,
        "restore the process fd limit after the test"
    );
    assert_eq!(after.rlim_cur, target as libc::rlim_t);
    assert_eq!(after.rlim_max, before.rlim_max);
}

use super::TEST_HOME_LOCK;
use crate as routecodex_v3_server;
include!("../../tests/support/active_key_control_fixture.rs");
use std::{sync::mpsc, thread};

#[test]
fn prepared_publication_survives_another_owners_prefix_prune() {
    const CHILD_LOCK: &str = "RCC_ACTIVE_CONTROL_STORAGE_LOCK_CHILD";
    if let Some(path) = std::env::var_os(CHILD_LOCK) {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .unwrap();
        assert!(
            matches!(file.try_lock(), Err(std::fs::TryLockError::WouldBlock)),
            "another process must observe the actual publisher's namespace lock"
        );
        eprintln!("actual-publisher-lock cross-process=blocked");
        return;
    }
    let _home_lock = TEST_HOME_LOCK.blocking_lock();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let _home = runtime.block_on(LOCK.lock());
    let bind = assigned_ipv4().expect("assigned non-loopback address");
    let longer = runtime.block_on(Fixture::start_named_with_peer(
        bind,
        &bind.to_string(),
        false,
        "storage-race.toml",
        &"x".repeat(61),
        None,
        None,
    ));
    let config_path = longer.config_path.clone();
    let closing_record = longer.record_path.clone();
    let longer_port = longer.business.port();
    let (prepared_tx, prepared_rx) = mpsc::channel();
    let (resume_tx, resume_rx) = mpsc::channel();
    let publisher = thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        crate::active_key_control::set_storage_boundary_observer(Some(Box::new(move |stage| {
            if stage == crate::active_key_control::StorageBoundaryStage::DirectoriesPrepared {
                prepared_tx.send(()).unwrap();
                resume_rx.recv().unwrap();
            }
        })));
        let shorter_id = "x".repeat(60);
        let shorter = runtime.block_on(Fixture::start_named_with_peer(
            bind,
            &bind.to_string(),
            false,
            "storage-race.toml",
            &shorter_id,
            None,
            Some((&"x".repeat(61), longer_port)),
        ));
        crate::active_key_control::set_storage_boundary_observer(None);
        let companion = shorter.control;
        let business = runtime.block_on(shorter.business());
        let status = runtime.block_on(shorter.status());
        let release = runtime.block_on(shorter.release("default"));
        let after = runtime.block_on(shorter.status());
        let cleanup = runtime.block_on(shorter.finish(Close::Shutdown));
        (companion, business, status, release, after, cleanup)
    });
    let prepared = prepared_rx.recv_timeout(Duration::from_secs(30)).is_ok();
    let lock_path = config_path
        .canonicalize()
        .unwrap()
        .parent()
        .unwrap()
        .join(".active-key-control.lock");
    let transaction_locked = match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&lock_path)
    {
        Ok(file) => matches!(file.try_lock(), Err(std::fs::TryLockError::WouldBlock)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => panic!("open transaction lock: {error}"),
    };
    let child_lock = transaction_locked.then(|| {
        std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "tests::active_key_control_storage_race::prepared_publication_survives_another_owners_prefix_prune", "--nocapture"])
            .env(CHILD_LOCK, &lock_path).output().unwrap()
    });
    let (contended_tx, contended_rx) = mpsc::channel();
    let contended_tx = Mutex::new(Some(contended_tx));
    routecodex_v3_config::v3_test_only_set_active_key_control_lock_observer(Some(Arc::new(
        move |path, stage| {
            if path == closing_record
                && stage == routecodex_v3_config::V3ActiveKeyControlLockStage::WriteContended
            {
                if let Some(tx) = contended_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
            }
        },
    )));
    let (close_tx, close_rx) = mpsc::channel();
    let (verify_tx, verify_rx) = mpsc::channel();
    let closer = thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let mut longer = longer;
        let report = runtime.block_on(longer.handle.take().unwrap().shutdown());
        close_tx.send(report.is_empty()).unwrap();
        // The real closer has completed. Defer shared-lock absence verification
        // until the publisher is resumed, so a closer-only bypass can finish prune.
        verify_rx.recv().unwrap();
        runtime.block_on(longer.finish_resources())
    });
    let real_closer_contended = contended_rx.recv_timeout(Duration::from_secs(10)).is_ok();
    // Only the real closer's failed try-lock permits publication to resume.
    // A closer-only lock bypass must finish its actual pruning first.
    let closed_before_resume = if real_closer_contended {
        None
    } else {
        close_rx.recv_timeout(Duration::from_secs(30)).ok()
    };
    let resumed = resume_tx.send(()).is_ok();
    let result = publisher.join().unwrap();
    verify_tx.send(()).unwrap();
    let closed =
        closed_before_resume.or_else(|| close_rx.recv_timeout(Duration::from_secs(30)).ok());
    let close_cleanup = closer.join().unwrap();
    routecodex_v3_config::v3_test_only_set_active_key_control_lock_observer(None);
    assert!(
        prepared && resumed,
        "publication pause/resume must complete"
    );
    assert_eq!(closed, Some(true), "long owner resources must close");
    assert_eq!(close_cleanup, (true, true));
    assert_eq!(result.5, (true, true), "publisher resources must close");
    assert_eq!(
        result.1.as_ref().unwrap().0,
        200,
        "business request remains usable"
    );
    assert!(
        result.0.is_some(),
        "prepared publication lost its companion after real prefix pruning"
    );
    assert_eq!(
        result.2.as_ref().unwrap().0,
        200,
        "Admin discovers published companion"
    );
    assert_eq!(
        result.2.as_ref().unwrap().1["pools"][0]["held"][0]["auth_alias"],
        "A"
    );
    assert_eq!(result.3.as_ref().unwrap().0, 200, "Admin releases held A");
    assert_eq!(result.3.as_ref().unwrap().1["released"], true);
    assert_eq!(result.4.as_ref().unwrap().0, 200);
    assert_eq!(result.4.as_ref().unwrap().1["pools"][0]["held"], json!([]));
    assert!(
        transaction_locked,
        "publisher must hold a namespace OS lock"
    );
    assert!(
        real_closer_contended,
        "actual closer must encounter the held lock before publisher resumes"
    );
    let child = child_lock.unwrap();
    assert!(
        child.status.success(),
        "{}{}",
        String::from_utf8_lossy(&child.stdout),
        String::from_utf8_lossy(&child.stderr)
    );
    assert!(String::from_utf8_lossy(&child.stderr)
        .contains("actual-publisher-lock cross-process=blocked"));
    eprintln!("actual-publisher-lock independent-handle=blocked cross-process=blocked; real Admin status/release and owner cleanup passed");
}

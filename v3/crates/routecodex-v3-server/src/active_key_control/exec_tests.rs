use super::*;
use std::path::PathBuf;
use std::time::Duration;

struct Scope(PathBuf);

impl Scope {
    fn new(case: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "rcc-active-control-exec-{case}-{}",
            std::process::id()
        ));
        std::fs::create_dir(&dir).unwrap();
        Self(dir)
    }

    fn config(&self, name: &str) -> PathBuf {
        let config = self.0.join(name);
        std::fs::write(&config, "").unwrap();
        config
    }
}

impl Drop for Scope {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(1)
}

#[cfg(unix)]
#[tokio::test]
async fn active_key_custody_retains_fully_written_leaf_after_failed_rollback() {
    use std::os::unix::fs::PermissionsExt;
    for replace in [false, true] {
        let scope = Scope::new("sync-rollback");
        let paths = record_path(&scope.config("config.toml"), "edge").unwrap();
        let leaf_dir = paths.record.parent().unwrap().to_owned();
        let locked_dir = leaf_dir.clone();
        let intended = record("edge", 3211);
        let startup = V3ActiveKeyControlStartup::new(Default::default(), |_| Ok(()));
        let result = publish_startup_record(
            paths.clone(),
            intended.clone(),
            deadline(),
            None,
            Some(&startup),
            Some(Box::new(move |_| {
                let directory = locked_dir.clone();
                V3ActiveKeyControlWrite::test_fail_next_record_sync(move || {
                    std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o500))
                        .unwrap();
                });
            })),
        )
        .await;
        std::fs::set_permissions(leaf_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let bytes = paths.read();
        let mut retained = startup.snapshot();
        let pending = retained.records.iter().any(|item| item.record == intended);
        let foreign_bytes = serde_json::to_vec(&record("edge", 3212)).unwrap();
        if replace {
            paths
                .with_write(|tx| {
                    tx.remove()?;
                    tx.publish(&foreign_bytes, || {})
                })
                .unwrap();
        }
        let recovered = retained.retire_failed_startup().await;
        let absent = !paths.record.exists();
        let final_bytes = paths.read().ok();
        drop(scope);
        let error = result.unwrap_err().to_string();
        assert!(
            error.contains("injected record sync failure")
                && error.contains("remove incomplete owned control record"),
            "{error}"
        );
        assert_eq!(bytes.unwrap(), serde_json::to_vec(&intended).unwrap());
        assert!(
            pending,
            "fully written endpoint lost its exact cleanup owner"
        );
        let diagnostics = recovered.unwrap();
        assert!(retained.is_empty());
        if replace {
            assert_eq!(final_bytes, Some(foreign_bytes));
            assert_eq!(diagnostics.len(), 1);
            assert_eq!(diagnostics[0].error.kind(), io::ErrorKind::AlreadyExists);
        } else {
            assert!(diagnostics.is_empty() && absent);
        }
    }
}

fn record(server_id: &str, control_port: u16) -> ActiveKeyControlEndpointRecord {
    make_record(
        server_id,
        SocketAddr::from(([127, 0, 0, 1], 3210)),
        SocketAddr::from(([127, 0, 0, 1], control_port)),
    )
}

fn inherited(
    paths: &V3ActiveKeyControlPaths,
    record: &ActiveKeyControlEndpointRecord,
) -> ActiveKeyControlOwner {
    let handoff = V3ActiveKeyControlExecHandoff {
        records: vec![InheritedRecord {
            canonical_config: paths.canonical_config_path().into_os_string(),
            record: record.clone(),
        }],
    };
    let bytes = serde_json::to_vec(&handoff).unwrap();
    serde_json::from_slice::<V3ActiveKeyControlExecHandoff>(&bytes)
        .unwrap()
        .into_pending_owners()
        .unwrap()
        .pop()
        .unwrap()
}

#[tokio::test]
async fn active_key_exec_replaces_exact_or_missing_and_keeps_equal_record_owned() {
    let scope = Scope::new("match");
    let config = scope.config("config.toml");
    let paths = record_path(&config, "edge").unwrap();
    let old = record("edge", 3211);
    let fresh = record("edge", 3212);
    let record_only = record("edge", 3210);
    for (preexisting, replacement) in [
        (Some(&old), &fresh),
        (None, &fresh),
        (Some(&record_only), &record_only),
    ] {
        if let Some(preexisting) = preexisting {
            publish_record(&paths, preexisting).unwrap();
        }
        let expected = preexisting.unwrap_or(&old);
        let mut inherited = inherited(&paths, expected);
        let mut owner = publish_record_until(
            paths.clone(),
            replacement.clone(),
            deadline(),
            Some(&mut inherited),
            None,
        )
        .await
        .unwrap();
        assert!(!inherited.record_pending);
        let captured =
            V3ActiveKeyControlExecHandoff::capture(std::slice::from_ref(&owner)).unwrap();
        assert_eq!(captured.records[0].record, *replacement);
        drop(inherited);
        let actual =
            serde_json::from_slice::<ActiveKeyControlEndpointRecord>(&paths.read().unwrap())
                .unwrap();
        assert_eq!(actual, *replacement);
        owner.close_until(deadline()).await.unwrap();
        assert_eq!(paths.read().unwrap_err().kind(), io::ErrorKind::NotFound);
    }
}

#[tokio::test]
async fn active_key_exec_preserves_foreign_and_malformed_record() {
    let scope = Scope::new("conflict");
    let paths = record_path(&scope.config("config.toml"), "edge").unwrap();
    let expected = record("edge", 3211);
    let foreign = record("edge", 3212);
    let replacement = record("edge", 3213);
    assert_eq!(foreign.owner_pid, expected.owner_pid);
    for (bytes, kind, pending) in [
        (
            serde_json::to_vec(&foreign).unwrap(),
            io::ErrorKind::AlreadyExists,
            false,
        ),
        (b"{malformed".to_vec(), io::ErrorKind::InvalidData, true),
    ] {
        paths.with_write(|tx| tx.publish(&bytes, || {})).unwrap();
        assert_eq!(
            publish_record_until(paths.clone(), replacement.clone(), deadline(), None, None)
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::AlreadyExists
        );
        let mut inherited = inherited(&paths, &expected);
        let error = publish_record_until(
            paths.clone(),
            replacement.clone(),
            deadline(),
            Some(&mut inherited),
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind(), kind);
        assert!(error.to_string().contains("control conflict"));
        assert_eq!(inherited.record_pending, pending);
        assert_eq!(paths.read().unwrap(), bytes);
        paths.with_write(|tx| tx.remove()).unwrap();
        inherited.close_until(deadline()).await.unwrap();
    }
}

#[tokio::test]
async fn active_key_exec_retires_removed_config_and_policy_without_touching_siblings() {
    let scope = Scope::new("retirement");
    let old_config = scope.config("old.toml");
    let new_config = scope.config("new.toml");
    let old_paths = record_path(&old_config, "edge").unwrap();
    let retired_paths = record_path(&new_config, "retired").unwrap();
    let new_paths = record_path(&new_config, "edge").unwrap();
    let old = record("edge", 3211);
    let retired = record("retired", 3212);
    let new = record("edge", 3213);
    for (paths, record) in [
        (&old_paths, &old),
        (&retired_paths, &retired),
        (&new_paths, &new),
    ] {
        publish_record(paths, record).unwrap();
    }
    let survivor = new_paths.read().unwrap();
    std::fs::remove_file(old_config).unwrap();
    let mut old = inherited(&old_paths, &old);
    let mut retired = inherited(&retired_paths, &retired);
    let deadline = deadline();
    retire_inherited_record_until(&mut old, deadline, None)
        .await
        .unwrap();
    retire_inherited_record_until(&mut retired, deadline, None)
        .await
        .unwrap();
    assert!(!old.record_pending && !retired.record_pending);
    assert_eq!(
        old_paths.read().unwrap_err().kind(),
        io::ErrorKind::NotFound
    );
    assert_eq!(
        retired_paths.read().unwrap_err().kind(),
        io::ErrorKind::NotFound
    );
    assert_eq!(new_paths.read().unwrap(), survivor);
    assert!(try_remove_owned_record(&new_paths, &new).unwrap());
}

#[tokio::test]
async fn active_key_exec_expiry_and_cancellation_retain_exact_cleanup_for_later_close() {
    let scope = Scope::new("expiry");
    let config = scope.config("config.toml");
    let old_paths = record_path(&config, "old").unwrap();
    let paths = record_path(&config, "edge").unwrap();
    let old = record("old", 3211);
    let expected = record("edge", 3212);
    let replacement = record("edge", 3213);
    publish_record(&old_paths, &old).unwrap();
    publish_record(&paths, &expected).unwrap();
    let before = paths.read().unwrap();
    let old_before = old_paths.read().unwrap();
    let mut inherited = inherited(&paths, &expected);
    let mut retired = self::inherited(&old_paths, &old);
    let holder = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(scope.0.join(".active-key-control.lock"))
        .unwrap();
    holder.try_lock().unwrap();
    let expired = Instant::now() + Duration::from_millis(100);
    assert_eq!(
        publish_record_until(
            paths.clone(),
            replacement.clone(),
            expired,
            Some(&mut inherited),
            None,
        )
        .await
        .unwrap_err()
        .kind(),
        io::ErrorKind::TimedOut
    );
    assert_eq!(
        retire_inherited_record_until(&mut retired, expired, None)
            .await
            .unwrap_err()
            .kind(),
        io::ErrorKind::TimedOut
    );
    tokio::select! {
        result = publish_record_until(paths.clone(), replacement, deadline(), Some(&mut inherited), None) => {
            panic!("cancelled acquisition completed while locked: {result:?}");
        }
        () = tokio::time::sleep(Duration::from_millis(40)) => {}
    }
    let owners = [inherited, retired];
    let carried = V3ActiveKeyControlExecHandoff::capture(&owners).unwrap();
    assert_eq!(carried.records.len(), 2);
    drop(holder);
    assert_eq!(paths.read().unwrap(), before);
    assert_eq!(old_paths.read().unwrap(), old_before);
    for mut owner in owners {
        owner.close_until(deadline()).await.unwrap();
    }
    assert_eq!(paths.read().unwrap_err().kind(), io::ErrorKind::NotFound);
    assert_eq!(
        old_paths.read().unwrap_err().kind(),
        io::ErrorKind::NotFound
    );
}

#[test]
fn active_key_exec_duplicate_scope_cannot_construct_a_cleanup_owner() {
    let scope = Scope::new("duplicate");
    let paths = record_path(&scope.config("config.toml"), "edge").unwrap();
    let expected = record("edge", 3211);
    publish_record(&paths, &expected).unwrap();
    let bytes = paths.read().unwrap();
    let handoff = V3ActiveKeyControlExecHandoff {
        records: [expected.clone(), record("edge", 3212)]
            .into_iter()
            .map(|record| InheritedRecord {
                canonical_config: paths.canonical_config_path().into_os_string(),
                record,
            })
            .collect(),
    };
    assert_eq!(
        handoff.into_pending_owners().unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );
    assert_eq!(paths.read().unwrap(), bytes);
    assert!(try_remove_owned_record(&paths, &expected).unwrap());
}

#[tokio::test]
async fn active_key_startup_cancellation_keeps_exact_publication_alternatives() {
    let scope = Scope::new("startup-cancel");
    let config = scope.config("config.toml");
    let paths = record_path(&config, "edge").unwrap();
    let old = record("edge", 3211);
    let new = record("edge", 3212);
    publish_record(&paths, &old).unwrap();
    let mut owner = inherited(&paths, &old);
    let handoff = V3ActiveKeyControlExecHandoff::capture(std::slice::from_ref(&owner)).unwrap();
    owner.record_pending = false;
    let journal = scope.0.join("front-handoff.json");
    std::fs::write(&journal, serde_json::to_vec(&handoff).unwrap()).unwrap();
    let path = journal.clone();
    let startup = V3ActiveKeyControlStartup::new(handoff, move |controls| {
        std::fs::write(
            &path,
            serde_json::to_vec(controls).map_err(io::Error::other)?,
        )
    });
    let lock_path = scope.0.join(".active-key-control.lock");
    let holder = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(lock_path)
        .unwrap();
    holder.try_lock().unwrap();
    let waiting_paths = paths.clone();
    let waiting_new = new.clone();
    let waiting_startup = startup.clone();
    let waiter = tokio::spawn(async move {
        publish_startup_record(
            waiting_paths,
            waiting_new,
            deadline(),
            None,
            Some(&waiting_startup),
            None,
        )
        .await
    });
    tokio::time::sleep(Duration::from_millis(60)).await;
    waiter.abort();
    let wait_cancelled = waiter.await.is_err_and(|error| error.is_cancelled());
    drop(holder);
    let unchanged = paths.read_until(deadline()).await;
    let prior: V3ActiveKeyControlExecHandoff =
        serde_json::from_slice(&std::fs::read(&journal).unwrap()).unwrap();

    let (entered, acquired) = tokio::sync::oneshot::channel();
    let entered = Mutex::new(Some(entered));
    let (resume, resume_rx) = std::sync::mpsc::channel::<()>();
    let publishing_paths = paths.clone();
    let publishing_old = old.clone();
    let publishing_new = new.clone();
    let task = tokio::spawn(async move {
        let mut owner = inherited(&publishing_paths, &publishing_old);
        publish_startup_record(
            publishing_paths,
            publishing_new,
            deadline(),
            Some(&mut owner),
            Some(&startup),
            Some(Box::new(move |_| {
                if let Some(entered) = entered.lock().unwrap().take() {
                    let _ = entered.send(());
                }
                let _ = resume_rx.recv_timeout(Duration::from_secs(4));
            })),
        )
        .await
    });
    let reached = matches!(
        tokio::time::timeout(Duration::from_secs(3), acquired).await,
        Ok(Ok(()))
    );
    let mut retained: V3ActiveKeyControlExecHandoff =
        serde_json::from_slice(&std::fs::read(&journal).unwrap()).unwrap();
    let candidates = retained
        .records
        .iter()
        .map(|record| record.record.clone())
        .collect::<Vec<_>>();
    task.abort();
    let publication_cancelled = task.await.is_err_and(|error| error.is_cancelled());
    drop(resume);
    let cleanup = retained.retire_failed_startup().await;
    let absent = paths
        .read_until(deadline())
        .await
        .is_err_and(|error| error.kind() == io::ErrorKind::NotFound);
    drop(scope);
    assert!(wait_cancelled && reached && publication_cancelled);
    assert_eq!(unchanged.unwrap(), serde_json::to_vec(&old).unwrap());
    assert_eq!(prior.records.len(), 1);
    assert_eq!(candidates, [old, new]);
    assert!(cleanup.unwrap().is_empty() && retained.is_empty() && absent);
}

#[tokio::test]
async fn active_key_startup_needs_authority_and_durable_write_before_mutation() {
    let scope = Scope::new("startup-write-ahead");
    let paths = record_path(&scope.config("config.toml"), "edge").unwrap();
    let old = record("edge", 3211);
    publish_record(&paths, &old).unwrap();
    let bytes = paths.read().unwrap();
    let unowned = V3ActiveKeyControlStartup::new(V3ActiveKeyControlExecHandoff::default(), |_| {
        panic!("a foreign record must never reach write-ahead custody")
    });
    let conflict = publish_startup_record(
        paths.clone(),
        old.clone(),
        deadline(),
        None,
        Some(&unowned),
        None,
    )
    .await;
    let mut owner = inherited(&paths, &old);
    let handoff = V3ActiveKeyControlExecHandoff::capture(std::slice::from_ref(&owner)).unwrap();
    let failing = V3ActiveKeyControlStartup::new(handoff, |_| {
        Err(io::Error::from(io::ErrorKind::PermissionDenied))
    });
    let failed = publish_startup_record(
        paths.clone(),
        record("edge", 3212),
        deadline(),
        Some(&mut owner),
        Some(&failing),
        None,
    )
    .await;
    let preserved = paths.read();
    let pending = owner.record_pending;
    owner.close_until(deadline()).await.unwrap();
    drop(owner);
    drop(scope);
    assert_eq!(conflict.unwrap_err().kind(), io::ErrorKind::AlreadyExists);
    assert!(unowned.snapshot().is_empty());
    assert_eq!(failed.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
    assert_eq!(preserved.unwrap(), bytes);
    assert!(pending);
}

#[cfg(unix)]
pub(super) fn prepare_failed_replacement(
    config: &Path,
) -> (V3ActiveKeyControlPaths, ActiveKeyControlOwner) {
    let paths = record_path(config, "exec-failed").unwrap();
    let expected = record("exec-failed", 3211);
    publish_record(&paths, &expected).unwrap();
    let inherited = inherited(&paths, &expected);
    (paths, inherited)
}

#[cfg(unix)]
pub(super) fn check_failed_replacement(
    paths: V3ActiveKeyControlPaths,
    mut inherited: ActiveKeyControlOwner,
) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let error = runtime
        .block_on(publish_record_until(
            paths.clone(),
            record("exec-failed", 3212),
            deadline(),
            Some(&mut inherited),
            None,
        ))
        .unwrap_err();
    assert_eq!(error.raw_os_error(), Some(libc::EFBIG));
    assert!(
        !inherited.record_pending,
        "removed predecessor cannot be restored"
    );
    assert_eq!(paths.read().unwrap_err().kind(), io::ErrorKind::NotFound);
    assert_eq!(
        std::fs::metadata(paths.record.parent().unwrap())
            .unwrap_err()
            .kind(),
        io::ErrorKind::NotFound
    );
}

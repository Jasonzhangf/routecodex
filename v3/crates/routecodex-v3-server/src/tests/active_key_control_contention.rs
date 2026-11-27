use super::TEST_HOME_LOCK;
use crate as routecodex_v3_server;
include!("../../tests/support/active_key_control_fixture.rs");
use std::{sync::mpsc, thread};

#[test]
fn contended_admin_discovery_does_not_block_same_runtime_business() {
    use routecodex_v3_config::{
        v3_test_only_set_active_key_control_lock_observer as observe,
        V3ActiveKeyControlLockStage as Stage,
    };
    let _home_lock = TEST_HOME_LOCK.lock().unwrap();
    let clients = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let _home = clients.block_on(LOCK.lock());
    let bind = assigned_ipv4().unwrap();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    let consumer = thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async move {
            let fixture = Fixture::start(bind, false).await;
            ready_tx
                .send((
                    fixture.admin,
                    fixture.business,
                    fixture.config_path.clone(),
                    fixture.token.clone(),
                    fixture.group.clone(),
                ))
                .unwrap();
            let _ = stop_rx.await;
            fixture.finish(Close::Shutdown).await
        })
    });
    let (admin, business, config, token, group) =
        ready_rx.recv_timeout(Duration::from_secs(20)).unwrap();
    let lock_path = config
        .canonicalize()
        .unwrap()
        .parent()
        .unwrap()
        .join(".active-key-control.lock");
    let holder = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(lock_path)
        .unwrap();
    holder.lock().unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let entered_tx = Mutex::new(Some(entered_tx));
    observe(Some(Arc::new(move |_, stage| {
        if stage == Stage::ReadAcquire {
            if let Some(tx) = entered_tx.lock().unwrap().take() {
                let _ = tx.send(());
            }
        }
    })));
    let admin_request = clients.spawn(async move {
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        response(client.get(format!(
            "http://{admin}/api/routes/active-keys?server_id=selected"
        )))
        .await
    });
    let entered = entered_rx.recv_timeout(Duration::from_secs(10)).is_ok();
    let business_result = clients.block_on(async {
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(1500))
            .build()
            .unwrap();
        response(
            client
                .post(format!("http://{business}/v1/responses"))
                .header("x-session-id", "contended-admin-independent-business")
                .json(&json!({"model":"client","input":"ordinary text"})),
        )
        .await
    });
    let admin_result = clients.block_on(admin_request).unwrap();
    let release_body = json!({"server_id":"selected","routing_group_id":group,"pool_id":"default",
        "provider_id":"controlled","interface_id":"default","model_id":"wire","auth_alias":"A"});
    let blocked_release = clients.block_on(async {
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap();
        response(
            client
                .post(format!("http://{admin}/api/routes/active-keys/release"))
                .header("x-routecodex-admin-token", &token)
                .json(&release_body),
        )
        .await
    });
    observe(None);
    drop(holder);
    let recovered_status = clients.block_on(response(client().get(format!(
        "http://{admin}/api/routes/active-keys?server_id=selected"
    ))));
    let recovered_release = clients.block_on(response(
        client()
            .post(format!("http://{admin}/api/routes/active-keys/release"))
            .header("x-routecodex-admin-token", &token)
            .json(&release_body),
    ));
    let _ = stop_tx.send(());
    let cleanup = consumer.join().unwrap();
    assert!(entered, "actual Admin must reach record-lock acquisition");
    assert_eq!(cleanup, (true, true), "all fixture resources must close");
    assert_eq!(
        business_result.as_ref().map(|r| r.0),
        Ok(200),
        "control lock contention blocked unrelated business: {business_result:?}"
    );
    assert!(matches!(admin_result, Ok((503, _))),
        "contended control must fail explicitly within its own bounded acquisition: {admin_result:?}");
    assert!(
        matches!(blocked_release, Ok((503, _))),
        "contended release must fail explicitly: {blocked_release:?}"
    );
    assert_eq!(
        recovered_status.unwrap().1["pools"][0]["held"][0]["auth_alias"],
        "A",
        "expired release must not execute later after the lock is released"
    );
    assert_eq!(recovered_release.unwrap().1["released"], true);
}

#[test]
fn startup_contention_serves_business_before_bounded_control_publication() {
    use routecodex_v3_config::{
        v3_test_only_set_active_key_control_lock_observer as observe,
        V3ActiveKeyControlLockStage as Stage,
    };
    let _home_lock = TEST_HOME_LOCK.lock().unwrap();
    let clients = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let _home = clients.block_on(LOCK.lock());
    let bind = assigned_ipv4().unwrap();
    let mut fixture = clients.block_on(Fixture::start(bind, false));
    assert!(clients
        .block_on(fixture.handle.take().unwrap().shutdown())
        .is_empty());
    assert!(clients.block_on(closed(fixture.business)));
    let paths = fixture.record_paths();
    let lock_path = fixture
        .config_path
        .canonicalize()
        .unwrap()
        .parent()
        .unwrap()
        .join(".active-key-control.lock");
    let holder = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(lock_path)
        .unwrap();
    holder.lock().unwrap();
    let (contended_tx, contended_rx) = mpsc::channel();
    let contended_tx = Mutex::new(Some(contended_tx));
    observe(Some(Arc::new(move |_, stage| {
        if stage == Stage::WriteContended {
            if let Some(tx) = contended_tx.lock().unwrap().take() {
                let _ = tx.send(());
            }
        }
    })));
    let config = fixture.config_path.clone();
    let manifest = fixture.manifest.clone();
    let (started_tx, started_rx) = mpsc::channel();
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    let consumer = thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let aggregate = spawn_v3_server_aggregate_with_admin(manifest, None, Some(config))
                .await
                .unwrap();
            started_tx
                .send(aggregate.active_key_controls.len())
                .unwrap();
            let _ = stop_rx.await;
            aggregate.shutdown().await
        })
    });
    let contended = contended_rx.recv_timeout(Duration::from_secs(10)).is_ok();
    let business = clients.block_on(async {
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(1500))
            .build()
            .unwrap();
        response(
            client
                .post(format!("http://{}/v1/responses", fixture.business))
                .json(&json!({"model":"client","input":"ordinary text"})),
        )
        .await
    });
    let started_while_held = started_rx.recv_timeout(Duration::from_secs(3)).ok();
    observe(None);
    drop(holder);
    let _ = stop_tx.send(());
    let close = consumer.join().unwrap();
    let late_record = read_control_bytes(&paths);
    fixture.admin_task.abort();
    fixture.upstream_task.abort();
    clients.block_on(async {
        let _ = fixture.admin_task.await;
        let _ = fixture.upstream_task.await;
    });
    let released = clients.block_on(async {
        closed(fixture.business).await
            && closed(fixture.admin).await
            && closed(fixture.upstream_addr).await
    });
    assert!(
        close.is_empty() && released,
        "startup failure must close all owned resources"
    );
    assert!(
        contended,
        "real startup must observe actual exclusive contention"
    );
    assert_eq!(
        business.unwrap().0,
        200,
        "business accept must run during control publication contention"
    );
    assert_eq!(
        started_while_held,
        Some(0),
        "startup must return bounded control unavailability while lock remains held"
    );
    assert!(
        late_record.is_none(),
        "expired startup must not publish later"
    );
}

#[test]
fn contended_drop_has_no_waiter_and_retains_exact_manual_cleanup() {
    let _home_lock = TEST_HOME_LOCK.lock().unwrap();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let _home = runtime.block_on(LOCK.lock());
    let mut fixture = runtime.block_on(Fixture::start(assigned_ipv4().unwrap(), false));
    let paths = fixture.record_paths();
    let original = paths.read().unwrap();
    let lock_path = fixture
        .config_path
        .canonicalize()
        .unwrap()
        .parent()
        .unwrap()
        .join(".active-key-control.lock");
    let holder = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(lock_path)
        .unwrap();
    holder.lock().unwrap();
    let owner = fixture
        .handle
        .as_mut()
        .unwrap()
        .active_key_controls
        .pop()
        .unwrap();
    let control = owner.record.control_addr;
    let (done_tx, done_rx) = mpsc::channel();
    let dropping = thread::spawn(move || {
        drop(owner);
        let _ = done_tx.send(());
    });
    let ended_while_held = done_rx.recv_timeout(Duration::from_secs(1)).is_ok();
    let business = runtime.block_on(fixture.business());
    drop(holder);
    dropping.join().unwrap();
    let retained = paths.read();
    paths
        .with_write(|tx| {
            if let Ok(bytes) = tx.read() {
                assert_eq!(
                    bytes, original,
                    "manual recovery must compare the complete owned bytes"
                );
                tx.remove()?;
                tx.prune_empty()?;
            }
            Ok(())
        })
        .unwrap();
    let closed_control = runtime.block_on(closed(control));
    let cleanup = runtime.block_on(fixture.finish(Close::Shutdown));
    assert_eq!(cleanup, (true, true));
    assert!(closed_control);
    assert!(
        ended_while_held,
        "Drop must not wait for a held namespace lock"
    );
    assert_eq!(business.unwrap().0, 200);
    assert_eq!(
        retained.unwrap(),
        original,
        "Drop must leave an explicit record for owner recovery, not a latent remover"
    );
}

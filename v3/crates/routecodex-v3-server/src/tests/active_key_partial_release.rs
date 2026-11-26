use super::TEST_HOME_LOCK;
use crate as routecodex_v3_server;
include!("../../tests/support/active_key_control_fixture.rs");

#[test]
fn releasing_one_listener_closes_its_control_and_preserves_its_peer() {
    let _home_lock = TEST_HOME_LOCK.lock().unwrap();
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let _home = runtime.block_on(LOCK.lock());
    let result = runtime.block_on(async {
        let bind = assigned_ipv4().unwrap();
        let reserve = std::net::TcpListener::bind((bind, 0)).unwrap();
        let peer_port = reserve.local_addr().unwrap().port();
        drop(reserve);
        let mut fixture = Fixture::start_named_with_peer(bind, &bind.to_string(), false,
            "partial-release.toml", "selected", None, Some(("peer", peer_port))).await;
        let first_control = fixture.control.unwrap();
        assert!(fixture.handle.take().unwrap().shutdown().await.is_empty());
        assert!(closed(fixture.business).await && closed(first_control).await);
        let state = routecodex_v3_admin::AppState::new(fixture.config_path.clone());
        let manifest = state.store.validate(&state.store.read_authoring().unwrap()).unwrap();
        let mut aggregate = spawn_v3_server_aggregate_with_admin(manifest.clone(), None,
            Some(fixture.config_path.clone())).await.unwrap();
        let selected_paths = fixture.record_paths();
        let peer_paths = routecodex_v3_config::v3_active_key_control_paths(&fixture.config_path, "peer").unwrap();
        let selected_record: Value = serde_json::from_slice(&selected_paths.read().unwrap()).unwrap();
        let peer_record: Value = serde_json::from_slice(&peer_paths.read().unwrap()).unwrap();
        let selected_control: SocketAddr = selected_record["control_addr"].as_str().unwrap().parse().unwrap();
        let peer_control: SocketAddr = peer_record["control_addr"].as_str().unwrap().parse().unwrap();
        let released = aggregate.shutdown_listener_ports(&[fixture.business.port()].into_iter().collect()).await;
        let business_closed = closed(fixture.business).await;
        let selected_control_closed = closed(selected_control).await;
        let selected_record_removed = read_control_bytes(&selected_paths).is_none();
        let peer_business = response(client().post(format!("http://{bind}:{peer_port}/v1/responses"))
            .json(&json!({"model":"client","input":"ordinary text"}))).await;
        let peer_status = response(client().get(format!("http://{}/api/routes/active-keys?server_id=peer",fixture.admin))).await;
        let peer_group = peer_status.as_ref().ok().map(|v|v.1["pools"][0]["routing_group_id"].clone()).unwrap_or(Value::Null);
        let peer_release = response(client().post(format!("http://{}/api/routes/active-keys/release",fixture.admin))
            .header("x-routecodex-admin-token", &fixture.token)
            .json(&json!({"server_id":"peer","routing_group_id":peer_group,"pool_id":"default",
                "provider_id":"controlled","interface_id":"default","model_id":"wire","auth_alias":"A"}))).await;
        let mut replacement_manifest = manifest;
        replacement_manifest.servers.retain(|id,_| id=="selected");
        let replacement = spawn_v3_server_aggregate_with_admin(replacement_manifest,None,
            Some(fixture.config_path.clone())).await.unwrap();
        let replacement_control = replacement.active_key_controls.iter()
            .find(|owner|owner.record.server_id=="selected").map(|owner|owner.record.control_addr);
        let replacement_status = fixture.status().await;
        let replacement_cleanup = replacement.shutdown().await.is_empty();
        let aggregate_cleanup = aggregate.shutdown().await.is_empty();
        fixture.admin_task.abort(); fixture.upstream_task.abort();
        let _ = fixture.admin_task.await; let _ = fixture.upstream_task.await;
        let cleanup = replacement_cleanup && aggregate_cleanup && closed(fixture.business).await
            && closed(SocketAddr::new(bind,peer_port)).await && closed(fixture.admin).await
            && closed(fixture.upstream_addr).await && closed(selected_control).await && closed(peer_control).await
            && read_control_bytes(&selected_paths).is_none() && read_control_bytes(&peer_paths).is_none();
        (released,business_closed,selected_control_closed,selected_record_removed,peer_business,
            peer_status,peer_release,replacement_control,replacement_status,cleanup)
    });
    assert!(
        result.9,
        "all owned listeners, companions, records, Admin and upstream must close"
    );
    assert!(
        result.1,
        "released business listener must close: {:?}",
        result.0
    );
    assert!(
        result.2,
        "released listener's companion remains live after port-scoped release"
    );
    assert!(
        result.3,
        "released listener's record remains after port-scoped release"
    );
    assert_eq!(result.4.unwrap().0, 200, "peer business remains usable");
    assert_eq!(result.5.unwrap().0, 200, "peer control remains usable");
    assert_eq!(
        result.6.unwrap().1["released"],
        true,
        "peer release remains usable"
    );
    assert!(
        result.7.is_some(),
        "released listener must be able to publish a replacement companion"
    );
    assert_eq!(result.8.unwrap().0, 200);
}

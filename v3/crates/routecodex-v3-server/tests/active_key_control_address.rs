include!("support/active_key_control_fixture.rs");

#[tokio::test]
async fn real_admin_status_and_exact_release_follow_the_selected_listener_control() {
    let _home = LOCK.lock().await;
    let mut binds = vec![
        "0.0.0.0".parse::<IpAddr>().unwrap(),
        "::1".parse().unwrap(),
        "::".parse().unwrap(),
    ];
    if let Some(ip) = assigned_ipv4() {
        binds.push(ip);
    } else {
        panic!("assigned non-loopback address is required for companion acceptance");
    }
    for bind in binds {
        let fixture = Fixture::start(bind, false).await;
        let business = fixture.business().await;
        let status = fixture.status().await;
        let rejected = fixture.release("wrong-pool").await;
        let still_held = fixture.status().await;
        let released = fixture.release("default").await;
        let after = fixture.status().await;
        let next = fixture.business().await;
        let companion = fixture.control.unwrap();
        let companion_only = if !bind.is_loopback() && !bind.is_unspecified() {
            Some((
                response(client().get(format!("http://{companion}/v1/models"))).await,
                response(client().get(format!(
                    "http://{}/_routecodex/selection/active-keys",
                    fixture.business
                )))
                .await,
            ))
        } else {
            None
        };
        let all_calls = fixture.calls.calls.lock().unwrap().clone();
        let calls = all_calls
            .iter()
            .map(|(alias, _)| alias.clone())
            .collect::<Vec<_>>();
        let cleanup = fixture.finish(Close::Shutdown).await;
        assert_eq!(
            cleanup,
            (true, true),
            "owned sockets and endpoint record must close for {bind}"
        );
        let business = business.unwrap();
        assert_eq!(business.0, 200);
        assert_eq!(business.1["output"][0]["content"][0]["text"], "B");
        assert_eq!(status.unwrap().1["pools"][0]["held"][0]["auth_alias"], "A");
        assert_eq!(rejected.unwrap().0, 404);
        assert_eq!(
            still_held.unwrap().1["pools"][0]["held"][0]["auth_alias"],
            "A"
        );
        assert_eq!(released.unwrap().1["released"], true);
        assert_eq!(after.unwrap().1["pools"][0]["held"], json!([]));
        let next = next.unwrap();
        assert_eq!(next.0, 200);
        assert_eq!(next.1["output"][0]["content"][0]["text"], "B");
        assert_eq!(
            calls,
            ["A", "A", "A", "A", "B", "B"],
            "actual controlled wire bodies: {all_calls:?}"
        );
        if let Some((models, remote)) = companion_only {
            assert_eq!(
                models.unwrap().0,
                404,
                "companion exposes no business endpoint"
            );
            assert_eq!(
                remote.unwrap().0,
                403,
                "business LAN peer cannot invoke loopback controls"
            );
            assert!(companion.ip().is_loopback());
            eprintln!("VERIFIED assigned LAN bind={bind} companion={companion}; actual Admin release and cleanup");
        } else {
            eprintln!("VERIFIED exact/wildcard bind={bind} control={companion}; actual Admin release and cleanup");
        }
    }
}

#[tokio::test]
async fn bracketed_ipv6_bind_keeps_legacy_business_and_real_admin_controls() {
    let _home = LOCK.lock().await;
    let fixture = Fixture::start_with_bind_text("::1".parse().unwrap(), "[::1]", false).await;
    let business = fixture.business().await;
    let status = fixture.status().await;
    let released = fixture.release("default").await;
    let after = fixture.status().await;
    let calls = fixture.calls.calls.lock().unwrap().len();
    let cleanup = fixture.finish(Close::Shutdown).await;
    assert_eq!(cleanup, (true, true));
    assert_eq!(business.unwrap().0, 200);
    assert_eq!(status.unwrap().1["pools"][0]["held"][0]["auth_alias"], "A");
    assert_eq!(released.unwrap().1["released"], true);
    assert_eq!(after.unwrap().1["pools"][0]["held"], json!([]));
    assert_eq!(calls, 5);
}

#[tokio::test]
async fn colliding_config_listener_components_keep_independent_real_admin_controls() {
    let _home = LOCK.lock().await;
    let bind = assigned_ipv4().expect("real non-loopback address for companion acceptance");
    for reverse in [false, true] {
        let a = Fixture::start_named(bind, &bind.to_string(), false, "a-b.toml", "c").await;
        let b = Fixture::start_named(bind, &bind.to_string(), false, "a", "b.toml-c").await;
        let business_a = a.business().await;
        let business_b = b.business().await;
        let status_a = a.status().await;
        let status_b = b.status().await;
        let have_both = a.control.is_some() && b.control.is_some();
        let names = (a.record_path.clone(), b.record_path.clone());
        let (closing, survivor) = if reverse { (b, a) } else { (a, b) };
        let first_release = closing.release("default").await;
        let first_after = closing.status().await;
        let survivor_before = survivor.status().await;
        let survivor_path = survivor.record_path.clone();
        let survivor_addr = survivor.control;
        let first_cleanup = closing.finish(Close::Shutdown).await;
        let retained = survivor_path.exists();
        let survivor_status = survivor.status().await;
        let second_release = survivor.release("default").await;
        let second_after = survivor.status().await;
        let survivor_socket_live = match survivor_addr {
            Some(addr) => tokio::net::TcpStream::connect(addr).await.is_ok(),
            None => false,
        };
        let second_cleanup = survivor.finish(Close::Shutdown).await;
        assert_eq!(first_cleanup, (true, true));
        assert_eq!(second_cleanup, (true, true));
        assert!(
            have_both,
            "both distinct canonical config/listener owners require independent companions"
        );
        assert!(names
            .0
            .ends_with(".active-key-control/a-b.toml/listener/s-63/endpoint.json"));
        assert!(names
            .1
            .ends_with(".active-key-control/a/listener/s-622e746f6d6c2d63/endpoint.json"));
        assert_eq!(
            business_a.unwrap().1["output"][0]["content"][0]["text"],
            "B"
        );
        assert_eq!(
            business_b.unwrap().1["output"][0]["content"][0]["text"],
            "B"
        );
        assert_eq!(
            status_a.unwrap().1["pools"][0]["held"][0]["auth_alias"],
            "A"
        );
        assert_eq!(
            status_b.unwrap().1["pools"][0]["held"][0]["auth_alias"],
            "A"
        );
        assert_eq!(first_release.unwrap().1["released"], true);
        assert_eq!(first_after.unwrap().1["pools"][0]["held"], json!([]));
        assert_eq!(
            survivor_before.unwrap().1["pools"][0]["held"][0]["auth_alias"],
            "A"
        );
        assert!(
            retained && survivor_socket_live,
            "closing one owner must preserve the other's endpoint and socket"
        );
        assert_eq!(survivor_status.unwrap().0, 200);
        assert_eq!(second_release.unwrap().1["released"], true);
        assert_eq!(second_after.unwrap().1["pools"][0]["held"], json!([]));
    }
}

#[tokio::test]
async fn long_canonical_config_name_keeps_real_admin_status_release_and_cleanup() {
    let _home = LOCK.lock().await;
    let bind = assigned_ipv4().expect("real non-loopback address for companion acceptance");
    let name = format!("a{}.toml", "-".repeat(80));
    for close in [Close::Shutdown, Close::Drop, Close::Exec] {
        let mut fixture = Fixture::start_named(bind, &bind.to_string(), false, &name, "c").await;
        let root = fixture.record_root.clone();
        let relative = fixture.record_path.strip_prefix(&root).unwrap();
        assert_eq!(
            relative.components().next().unwrap().as_os_str(),
            std::ffi::OsStr::new(&name)
        );
        assert!(relative.components().all(|component| component
            .as_os_str()
            .as_encoded_bytes()
            .len()
            <= 255));
        let business = fixture.business().await;
        let status = fixture.status().await;
        let control = fixture.control;
        fixture.reload().await;
        let retained = fixture.status().await;
        let release = fixture.release("default").await;
        let after = fixture.status().await;
        let cleanup = fixture.finish(close).await;
        assert_eq!(cleanup, (true, true));
        assert!(
            control.is_some(),
            "a legal canonical filename requires a discoverable companion"
        );
        assert_eq!(business.unwrap().1["output"][0]["content"][0]["text"], "B");
        let (status_code, status) = status.unwrap();
        assert_eq!(status_code, 200);
        assert_eq!(status["pools"][0]["held"][0]["auth_alias"], "A");
        assert_eq!(
            retained.unwrap().1["pools"][0]["held"][0]["auth_alias"],
            "A"
        );
        assert_eq!(release.unwrap().1["released"], true);
        assert_eq!(after.unwrap().1["pools"][0]["held"], json!([]));
        assert!(
            !root.exists(),
            "the final owner must prune its empty control directory chain"
        );
    }
}

#[tokio::test]
async fn shared_canonical_config_keeps_chunked_listener_owners_independent() {
    let _home = LOCK.lock().await;
    let bind = assigned_ipv4().expect("real non-loopback address for companion acceptance");
    let first_id = "x".repeat(60);
    let second_id = format!("{first_id}x");
    for reverse in [false, true] {
        let reservation = tokio::net::TcpListener::bind(SocketAddr::new(bind, 0))
            .await
            .unwrap();
        let second_port = reservation.local_addr().unwrap().port();
        drop(reservation);
        let first = Fixture::start_named_with_peer(
            bind,
            &bind.to_string(),
            false,
            "shared.toml",
            &first_id,
            None,
            Some((&second_id, second_port)),
        )
        .await;
        let second = Fixture::start_named_with_peer(
            bind,
            &bind.to_string(),
            false,
            "shared.toml",
            &second_id,
            Some(second_port),
            Some((&first_id, first.business.port())),
        )
        .await;
        assert_eq!(first.record_root, second.record_root);
        assert_ne!(first.record_path, second.record_path);
        assert!(second
            .record_path
            .starts_with(first.record_path.parent().unwrap()));
        let root = first.record_root.clone();
        let first_business = first.business().await;
        let second_business = second.business().await;
        let (closing, survivor) = if reverse {
            (second, first)
        } else {
            (first, second)
        };
        let closing_record = closing.record_path.clone();
        let first_cleanup = closing.finish(Close::Shutdown).await;
        let survivor_record = survivor.record_path.exists();
        let survivor_status = survivor.status().await;
        let survivor_release = survivor.release("default").await;
        let survivor_after = survivor.status().await;
        let survivor_control_live = match survivor.control {
            Some(addr) => tokio::net::TcpStream::connect(addr).await.is_ok(),
            None => false,
        };
        let final_cleanup = survivor.finish(Close::Shutdown).await;
        assert_eq!(first_cleanup, (true, true));
        assert_eq!(final_cleanup, (true, true));
        assert!(!closing_record.exists());
        assert!(
            !root.exists(),
            "last owner must prune the complete empty scoped chain"
        );
        assert!(survivor_record && survivor_control_live);
        assert_eq!(
            first_business.unwrap().1["output"][0]["content"][0]["text"],
            "B"
        );
        assert_eq!(
            second_business.unwrap().1["output"][0]["content"][0]["text"],
            "B"
        );
        assert_eq!(
            survivor_status.unwrap().1["pools"][0]["held"][0]["auth_alias"],
            "A"
        );
        assert_eq!(survivor_release.unwrap().1["released"], true);
        assert_eq!(survivor_after.unwrap().1["pools"][0]["held"], json!([]));
    }
}

#[tokio::test]
async fn failed_chunked_publication_preserves_live_sibling_and_foreign_leaf() {
    let _home = LOCK.lock().await;
    let bind = assigned_ipv4().expect("real non-loopback address for companion acceptance");
    let first_id = "q".repeat(60);
    let failed_id = format!("{first_id}q");
    let reservation = tokio::net::TcpListener::bind(SocketAddr::new(bind, 0))
        .await
        .unwrap();
    let failed_port = reservation.local_addr().unwrap().port();
    drop(reservation);
    let first = Fixture::start_named_with_peer(
        bind,
        &bind.to_string(),
        false,
        "shared-failure.toml",
        &first_id,
        None,
        Some((&failed_id, failed_port)),
    )
    .await;
    let failed = Fixture::start_named_with_peer(
        bind,
        &bind.to_string(),
        true,
        "shared-failure.toml",
        &failed_id,
        Some(failed_port),
        Some((&first_id, first.business.port())),
    )
    .await;
    let first_business = first.business().await;
    let failed_business = failed.business().await;
    let foreign = failed.record_path.clone();
    let root = failed.record_root.clone();
    let failed_control = failed.control;
    let failed_cleanup = failed.finish(Close::Shutdown).await;
    let retained = first.status().await;
    let release = first.release("default").await;
    let first_cleanup = first.finish(Close::Shutdown).await;
    let foreign_bytes = std::fs::read(&foreign).unwrap();
    assert_eq!(failed_cleanup, (true, false));
    assert_eq!(first_cleanup, (true, true));
    assert!(failed_control.is_none());
    assert_eq!(
        first_business.unwrap().1["output"][0]["content"][0]["text"],
        "B"
    );
    assert_eq!(
        failed_business.unwrap().1["output"][0]["content"][0]["text"],
        "A"
    );
    assert_eq!(
        retained.unwrap().1["pools"][0]["held"][0]["auth_alias"],
        "A"
    );
    assert_eq!(release.unwrap().1["released"], true);
    assert_eq!(foreign_bytes, b"foreign endpoint record");
    // This foreign leaf was explicitly created by this fixture. Both actual
    // owners are now closed; only the fixture may remove its retained input.
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn case_distinct_listener_ids_keep_independent_real_admin_controls() {
    let _home = LOCK.lock().await;
    let bind = assigned_ipv4().expect("real non-loopback address for companion acceptance");
    for reverse in [false, true] {
        let reservation = tokio::net::TcpListener::bind(SocketAddr::new(bind, 0))
            .await
            .unwrap();
        let second_port = reservation.local_addr().unwrap().port();
        drop(reservation);
        let first = Fixture::start_named_with_peer(
            bind,
            &bind.to_string(),
            false,
            "case-scope.toml",
            "edge",
            None,
            Some(("Edge", second_port)),
        )
        .await;
        let second = Fixture::start_named_with_peer(
            bind,
            &bind.to_string(),
            false,
            "case-scope.toml",
            "Edge",
            Some(second_port),
            Some(("edge", first.business.port())),
        )
        .await;
        let first_business = first.business().await;
        let second_business = second.business().await;
        let first_status = first.status().await;
        let second_status = second.status().await;
        let both = first.control.is_some() && second.control.is_some();
        let (closing, survivor) = if reverse {
            (second, first)
        } else {
            (first, second)
        };
        let first_release = closing.release("default").await;
        let first_cleanup = closing.finish(Close::Shutdown).await;
        let survivor_status = survivor.status().await;
        let survivor_release = survivor.release("default").await;
        let survivor_after = survivor.status().await;
        let second_cleanup = survivor.finish(Close::Shutdown).await;
        assert!(first_cleanup.0 && second_cleanup.0);
        assert!(
            both,
            "case-distinct IDs must publish independent companions"
        );
        assert_eq!(
            first_business.unwrap().1["output"][0]["content"][0]["text"],
            "B"
        );
        assert_eq!(
            second_business.unwrap().1["output"][0]["content"][0]["text"],
            "B"
        );
        assert_eq!(first_status.unwrap().0, 200);
        assert_eq!(second_status.unwrap().0, 200);
        assert_eq!(first_release.unwrap().1["released"], true);
        assert_eq!(
            survivor_status.unwrap().1["pools"][0]["held"][0]["auth_alias"],
            "A"
        );
        assert_eq!(survivor_release.unwrap().1["released"], true);
        assert_eq!(survivor_after.unwrap().1["pools"][0]["held"], json!([]));
        assert!(first_cleanup.1 && second_cleanup.1);
    }
}

#[tokio::test]
#[cfg(unix)]
async fn record_path_above_syscall_limit_keeps_real_admin_controls() {
    let _home = LOCK.lock().await;
    let bind = assigned_ipv4().expect("real non-loopback address for companion acceptance");
    let limit_output = std::process::Command::new("getconf")
        .arg("PATH_MAX")
        .arg(std::env::var_os("HOME").unwrap())
        .output()
        .unwrap();
    assert!(limit_output.status.success());
    let limit = String::from_utf8(limit_output.stdout)
        .unwrap()
        .trim()
        .parse::<usize>()
        .unwrap();
    let config_name = format!("{}.toml", "c".repeat(240));
    let server_id = "-".repeat(limit / 2 + 100);
    let mut fixture =
        Fixture::start_named(bind, &bind.to_string(), false, &config_name, &server_id).await;
    assert!(fixture.record_path.as_os_str().as_encoded_bytes().len() > limit);
    let business = fixture.business().await;
    let status = fixture.status().await;
    let control = fixture.control;
    fixture.reload().await;
    let reconstructed = fixture.status().await;
    let release = fixture.release("default").await;
    let after = fixture.status().await;
    let cleanup = fixture.finish(Close::Shutdown).await;
    assert!(cleanup.0);
    assert!(
        control.is_some(),
        "legal components require directory-relative publication beyond PATH_MAX"
    );
    assert_eq!(business.unwrap().1["output"][0]["content"][0]["text"], "B");
    assert_eq!(status.unwrap().1["pools"][0]["held"][0]["auth_alias"], "A");
    assert_eq!(
        reconstructed.unwrap().1["pools"][0]["held"][0]["auth_alias"],
        "A"
    );
    assert_eq!(release.unwrap().1["released"], true);
    assert_eq!(after.unwrap().1["pools"][0]["held"], json!([]));
    assert!(cleanup.1);
}

#[tokio::test]
async fn control_publication_failure_keeps_business_and_preserves_the_foreign_record() {
    let _home = LOCK.lock().await;
    let bind = assigned_ipv4().expect("assigned non-loopback address");
    let fixture = Fixture::start(bind, true).await;
    let path = fixture.record_path.clone();
    let business = fixture.business().await;
    let unavailable = fixture.status().await;
    let cleanup = fixture.finish(Close::Shutdown).await;
    let preserved = std::fs::read(&path).unwrap();
    std::fs::remove_file(path).unwrap();
    assert_eq!(cleanup, (true, false));
    let business = business.unwrap();
    assert_eq!(
        business.0, 200,
        "control I/O failure must not stop business forwarding"
    );
    assert_eq!(business.1["output"][0]["content"][0]["text"], "A");
    assert_ne!(
        unavailable.unwrap().0,
        200,
        "invalid/foreign record must remain an explicit control error"
    );
    assert_eq!(preserved, b"foreign endpoint record");
}

#[tokio::test]
async fn drop_and_exec_close_the_owned_companion_and_record() {
    let _home = LOCK.lock().await;
    let bind = assigned_ipv4().expect("assigned non-loopback address");
    for how in [Close::Drop, Close::Exec] {
        let fixture = Fixture::start(bind, false).await;
        let status = fixture.status().await;
        let cleanup = fixture.finish(how).await;
        assert_eq!(status.unwrap().0, 200);
        assert_eq!(cleanup, (true, true));
    }
}

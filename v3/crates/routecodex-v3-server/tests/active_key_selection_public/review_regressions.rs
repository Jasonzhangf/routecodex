use super::*;

async fn request_model(
    entry: &Entry,
    session: &str,
    model: &str,
) -> Result<(StatusCode, String), reqwest::Error> {
    entry
        .send_model(
            session,
            model,
            json!(if model == "default-only" {
                "ordinary paragraph".to_string()
            } else {
                "ordinary paragraph ".repeat(2000)
            }),
        )
        .await
}

fn pool<'a>(status: &'a Value, id: &str) -> &'a Value {
    status["pools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|pool| pool["pool_id"] == id)
        .expect("declared active pool")
}

#[tokio::test]
async fn legacy_failure_enters_active_default_with_target_witness() {
    let _home = LOCK.lock().await;
    let pools = r#"
[route_groups.active_public.pools.primary]
selection = {strategy="priority"}
match = {precedence=10,required_capabilities=["thinking"],min_input_tokens=1000}
targets = [{kind="provider_model",provider="controlled",model="wire",key="A",priority=1}]
[route_groups.active_public.pools.default]
selection = {strategy="round_robin"}
active_keys = {members=[{provider="controlled",alias="B"},{provider="controlled",alias="C"}],retries=3,on_failure="hold"}
targets = [{kind="provider_model",provider="controlled",model="wire",priority=1}]
"#;
    for chat in paths() {
        let entry = Entry::start_with_protocol_and_pools(
            "round_robin",
            3,
            "hold",
            if chat { "openai_chat" } else { "responses" },
            &["B", "C"],
            Some(pools),
        )
        .await;
        let before = request_model(&entry, "default-before", "default-only").await;
        entry.script("A", &[Outcome::Http(429)]);
        let recovered = request_model(&entry, "legacy-recovery", "client").await;
        let after = request_model(&entry, "default-after", "default-only").await;
        let calls = entry.calls();
        entry.stop().await;
        let before = before.expect("initial default response");
        let recovered = recovered.expect("recovered active response");
        let after = after.expect("next default response");
        assert_eq!(before.0, StatusCode::OK, "{}", before.1);
        assert_eq!(text(&before.1), "B");
        assert_eq!(recovered.0, StatusCode::OK, "{}", recovered.1);
        assert_eq!(
            text(&recovered.1),
            "C",
            "recovery must consume the actual next active turn"
        );
        assert_eq!(after.0, StatusCode::OK, "{}", after.1);
        assert_eq!(text(&after.1), "B");
        assert_eq!(calls, ["B", "A", "C", "B"]);
    }
}

#[tokio::test]
async fn held_active_default_is_not_a_health_successor() {
    let _home = LOCK.lock().await;
    let pools = r#"
[route_groups.active_public.pools.primary]
selection = {strategy="priority"}
match = {precedence=10,required_capabilities=["thinking"],min_input_tokens=1000}
targets = [{kind="provider_model",provider="controlled",model="wire",key="A",priority=1}]
[route_groups.active_public.pools.default]
selection = {strategy="active_queue"}
active_keys = {members=[{provider="controlled",alias="B"}],retries=3,on_failure="hold"}
targets = [{kind="provider_model",provider="controlled",model="wire",key="B",priority=1}]
"#;
    for chat in paths() {
        let entry = Entry::start_with_protocol_and_pools(
            "active_queue",
            3,
            "hold",
            if chat { "openai_chat" } else { "responses" },
            &["B"],
            Some(pools),
        )
        .await;
        entry.script("B", &[Outcome::Account(400, "invalid_request_error"); 4]);
        let mut setup = Vec::new();
        for index in 0..4 {
            let response =
                request_model(&entry, &format!("hold-default-{index}"), "default-only").await;
            setup.push(response);
        }
        let held = entry.queue().await;
        entry.script("A", &[Outcome::Account(401, "authentication_error")]);
        let final_error = request_model(&entry, "legacy-final", "client").await;
        let healthy_again = request_model(&entry, "legacy-health-neutral", "client").await;
        let calls = entry.calls();
        entry.stop().await;
        for response in setup {
            let response = response.expect("actual complete setup rejection");
            assert_eq!(response.0, StatusCode::BAD_REQUEST, "{}", response.1);
        }
        assert_eq!(pool(&held, "default")["held"][0]["auth_alias"], "B");
        let final_error = final_error.expect("actual final HTTP rejection");
        let healthy_again = healthy_again.expect("health-neutral next request");
        assert_eq!(final_error.0, StatusCode::UNAUTHORIZED, "{}", final_error.1);
        assert_eq!(healthy_again.0, StatusCode::OK, "{}", healthy_again.1);
        assert_eq!(text(&healthy_again.1), "A");
        assert_eq!(
            calls,
            ["B", "B", "B", "B", "A", "A"],
            "a held default must neither receive a send nor remove final health neutrality"
        );
    }
}

#[tokio::test]
async fn overlapping_legacy_and_active_occurrences_keep_their_own_policy() {
    let _home = LOCK.lock().await;
    for active_primary in [false, true] {
        let active = "selection={strategy=\"active_queue\"}\nactive_keys={members=[{provider=\"controlled\",alias=\"A\"}],retries=3,on_failure=\"hold\"}";
        let legacy = "selection={strategy=\"priority\"}";
        let pools = format!(
            r#"
[route_groups.active_public.pools.primary]
{primary}
match={{precedence=10,required_capabilities=["thinking"],min_input_tokens=1000}}
targets=[{{kind="provider_model",provider="controlled",model="wire",key="A",priority=1}}]
[route_groups.active_public.pools.default]
{default}
targets=[{{kind="provider_model",provider="controlled",model="wire",key="A",priority=1}}]
"#,
            primary = if active_primary { active } else { legacy },
            default = if active_primary { legacy } else { active }
        );
        for chat in paths() {
            let entry = Entry::start_with_protocol_and_pools(
                "active_queue",
                3,
                "hold",
                if chat { "openai_chat" } else { "responses" },
                &["A"],
                Some(&pools),
            )
            .await;
            entry.script("A", &[Outcome::Account(400, "invalid_request_error"); 4]);
            let hold_model = if active_primary {
                "client"
            } else {
                "default-only"
            };
            let mut setup = Vec::new();
            for index in 0..4 {
                let response =
                    request_model(&entry, &format!("overlap-hold-{index}"), hold_model).await;
                setup.push((response, entry.calls().len()));
            }
            let active_pool = if active_primary { "primary" } else { "default" };
            let held = entry.queue().await;
            let legacy_model = if active_primary {
                "default-only"
            } else {
                "client"
            };
            let legacy_success = request_model(&entry, "overlap-legacy", legacy_model).await;
            let state_after = entry.queue().await;
            let calls = entry.calls();
            entry.stop().await;
            for (index, (response, sends)) in setup.into_iter().enumerate() {
                let response = response.expect("actual overlap rejection");
                assert_eq!(response.0, StatusCode::BAD_REQUEST, "{}", response.1);
                assert_eq!(
                    sends,
                    index + 1,
                    "closed failure excludes the identity across declarations within this request"
                );
            }
            assert_eq!(pool(&held, active_pool)["held"][0]["auth_alias"], "A");
            let legacy_success =
                legacy_success.expect("independent legacy occurrence remains eligible");
            assert_eq!(legacy_success.0, StatusCode::OK, "{}", legacy_success.1);
            assert_eq!(text(&legacy_success.1), "A");
            assert_eq!(calls, ["A", "A", "A", "A", "A"]);
            assert_eq!(
                pool(&state_after, active_pool)["held"][0]["auth_alias"],
                "A",
                "legacy success must not clear another pool's hold"
            );
        }
    }
}

#[tokio::test]
async fn hold_store_failure_still_recovers_to_healthy_successor() {
    let _home = LOCK.lock().await;
    for disposition in ["hold", "tail"] {
        for chat in paths() {
            let entry = Entry::start("active_queue", 3, disposition, chat).await;
            let config = routecodex_v3_config::default_v3_config_path(std::path::PathBuf::from(
                std::env::var_os("HOME").unwrap(),
            ));
            let file =
                config.with_file_name(format!("active-keys-127.0.0.1_{}.json", entry.ports[0]));
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::create_dir(&file)
                .expect("directory deterministically rejects atomic hold-file replacement");
            entry.script("A", &[Outcome::Http(500); 4]);
            let recovered = entry
                .send(
                    "hold-disk-failure",
                    json!("recover despite local durability failure"),
                )
                .await;
            let status = entry.queue().await;
            let calls = entry.calls();
            entry.stop().await;
            std::fs::remove_dir(&file).unwrap();
            let (http, body) = recovered.expect("healthy B must complete the same request");
            assert_eq!(http, StatusCode::OK, "{body}");
            assert_eq!(text(&body), "B");
            assert_eq!(calls, ["A", "A", "A", "A", "B"]);
            let state = pool(&status, "default");
            if disposition == "hold" {
                assert_eq!(state["held"][0]["auth_alias"], "A");
                assert!(
                    state["persistence_error"]
                        .as_str()
                        .is_some_and(|error| !error.is_empty()),
                    "durability error must remain explicit in control status: {state}"
                );
            } else {
                assert_eq!(state["held"], json!([]));
                assert!(
                    state["persistence_error"].is_null(),
                    "tail does not write the unchanged held set: {state}"
                );
            }
        }
    }
}

#[tokio::test]
async fn shared_identity_uses_the_supplying_active_pools_state() {
    let _home = LOCK.lock().await;
    let pools = r#"
[route_groups.active_public.pools.primary]
selection = {strategy="active_queue"}
active_keys = {members=[{provider="controlled",alias="A"}],retries=3,on_failure="hold"}
match = {precedence=10,required_capabilities=["thinking"],min_input_tokens=1000}
targets = [{kind="provider_model",provider="controlled",model="wire",key="A",priority=1}]
[route_groups.active_public.pools.default]
selection = {strategy="active_queue"}
active_keys = {members=[{provider="controlled",alias="A"},{provider="controlled",alias="B"}],retries=3,on_failure="hold"}
targets = [{kind="provider_model",provider="controlled",model="wire",priority=1}]
"#;
    for chat in paths() {
        let entry = Entry::start_with_protocol_and_pools(
            "active_queue",
            3,
            "hold",
            if chat { "openai_chat" } else { "responses" },
            &["A", "B"],
            Some(pools),
        )
        .await;
        entry.script("A", &[Outcome::Account(400, "invalid_request_error"); 4]);
        let mut setup = Vec::new();
        for index in 0..4 {
            let response =
                request_model(&entry, &format!("shared-primary-{index}"), "client").await;
            setup.push((
                response,
                entry.calls().iter().filter(|alias| *alias == "A").count(),
            ));
        }
        let recovered = request_model(&entry, "shared-default-after-hold", "client").await;
        let queue = entry.queue().await;
        entry.stop().await;
        for (index, (response, sends)) in setup.into_iter().enumerate() {
            let response = response.expect("shared-identity successor response");
            assert_eq!(response.0, StatusCode::OK, "{}", response.1);
            assert_eq!(text(&response.1), "B");
            assert_eq!(
                sends,
                index + 1,
                "a failed identity cannot cycle through its other declaration in the same request"
            );
        }
        let recovered = recovered.expect("independent active occurrence response");
        assert_eq!(recovered.0, StatusCode::OK, "{}", recovered.1);
        assert_eq!(
            text(&recovered.1),
            "A",
            "primary hold does not hold the default's occurrence"
        );
        assert_eq!(pool(&queue, "primary")["held"][0]["auth_alias"], "A");
        assert_eq!(pool(&queue, "default")["held"], json!([]));
    }
}

#[tokio::test]
async fn concurrent_fourth_failure_holds_once_and_independent_requests_keep_b() {
    let _home = LOCK.lock().await;
    for chat in paths() {
        let entry = Entry::start("active_queue", 3, "hold", chat).await;
        entry.script("A", &[Outcome::SlowHttp(400); 4]);
        let responses = futures_util::future::join_all((0..4).map(|index| {
            let entry = &entry;
            async move { entry.request(&format!("concurrent-failure-{index}")).await }
        }))
        .await;
        let after = entry.request("after-concurrent-hold").await;
        let queue = entry.queue().await;
        let calls = entry.calls();
        entry.stop().await;
        assert!(responses.iter().all(|body| text(body) == "B"));
        assert_eq!(text(&after), "B");
        assert_eq!(calls.iter().filter(|alias| *alias == "A").count(), 4);
        assert_eq!(calls.iter().filter(|alias| *alias == "B").count(), 5);
        assert_eq!(pool(&queue, "default")["held"].as_array().unwrap().len(), 1);
        assert_eq!(pool(&queue, "default")["held"][0]["auth_alias"], "A");
    }
}

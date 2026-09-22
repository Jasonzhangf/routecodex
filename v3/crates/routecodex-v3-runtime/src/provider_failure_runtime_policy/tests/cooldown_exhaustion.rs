use super::*;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Notify;

fn all_candidate_keys(expanded: &V3Target09CandidateSetExpanded) -> BTreeSet<String> {
    expanded
        .candidates
        .iter()
        .map(v3_relay_provider_candidate_key)
        .collect()
}

fn put_all_candidates_in_provider_cooldown(
    health: &V3ProviderFailureRuntimeHealth,
    expanded: &V3Target09CandidateSetExpanded,
) {
    for candidate in &expanded.candidates {
        health
            .store
            .record_provider_cooldown_failure(
                &candidate.provider_id,
                Some(&candidate.auth_alias),
                Some(&candidate.model_id),
                "controlled cooldown-only exhaustion",
                10_000,
                10_000,
            )
            .expect("provider cooldown setup");
    }
}

fn put_auth_key_in_cooldown(
    health: &V3ProviderFailureRuntimeHealth,
    failure_session_scope: &V3ProviderFailureSessionScope,
    provider_id: &str,
    auth_alias: &str,
    now_ms: u64,
) {
    health
        .store
        .record_provider_failure_in_session_with_policy(
            failure_session_scope,
            provider_id,
            Some(auth_alias),
            None,
            Some("controlled auth-key cooldown"),
            now_ms,
            Some(routecodex_v3_provider_responses::V3ProviderFailurePolicy {
                failure_threshold: 1,
                cooldown_ms: 900_000,
                until_restart: false,
                ..Default::default()
            }),
        )
        .expect("auth-key cooldown setup");
}

fn acquire_rescue_probe(
    health: &V3ProviderFailureRuntimeHealth,
    provider_id: &str,
    auth_alias: &str,
    model_id: &str,
) -> routecodex_v3_provider_responses::V3ProviderHealthProbePermit {
    health
        .store
        .acquire_provider_cooldown_rescue_probe(provider_id, Some(auth_alias), Some(model_id))
        .expect("rescue probe acquisition")
        .expect("rescue probe must be acquired")
}

async fn serve_one_responses_probe(listener: TcpListener) {
    let (mut socket, _) = listener
        .accept()
        .await
        .expect("provider probe listener must accept one request");
    let mut request = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        let read = tokio::time::timeout(Duration::from_secs(1), socket.read(&mut chunk))
            .await
            .expect("provider probe request headers must arrive")
            .expect("provider probe request must be readable");
        if read == 0 {
            break;
        }
        request.extend_from_slice(&chunk[..read]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let body = r#"{"status":"completed"}"#;
    let response = format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    );
    socket
        .write_all(response.as_bytes())
        .await
        .expect("provider probe response must be writable");
}

#[test]
fn request_local_provider_failure_excludes_all_auth_keys_for_provider() {
    let scope = "request_local_provider_exclusion";
    let mut manifest = global_pool_alive_manifest(scope);
    let primary = manifest.providers.get_mut("first").expect("first provider");
    let mut key2 = primary.auth.entries[0].clone();
    key2.alias = "key2".to_string();
    primary.auth.entries.push(key2);

    let group = manifest
        .route_groups
        .get_mut(scope)
        .expect("request-local provider exclusion group");
    for pool in group.pools.values_mut() {
        for target in &mut pool.targets {
            if target.provider.as_deref() == Some("first") {
                target.key = None;
                target.priority = Some(2);
            } else {
                target.priority = Some(1);
            }
        }
    }

    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let selected = match resolve_target(&manifest, scope, &BTreeSet::new(), &health) {
        V3RelayProviderTargetResolution::Selected(selected) => selected,
        _ => panic!("first provider must be selectable before failure"),
    };
    let expanded = expand_v3_relay_target_plan_for_selected(&manifest, &selected, 0)
        .expect("provider family expansion");
    let excluded = expand_request_local_provider_failure_scope(
        V3RequestLocalProviderFailureScope::Provider,
        &selected,
        &expanded,
    );

    let V3RelayProviderTargetResolution::Selected(selected) =
        resolve_target(&manifest, scope, &excluded, &health)
    else {
        panic!("the second provider must remain selectable");
    };
    assert_eq!(selected.candidate.provider_id, "second");
}

#[tokio::test]
async fn fresh_cooldown_only_exhaustion_runs_one_rescue_probe_and_resumes_same_request() {
    let server_id = "fresh_cooldown_only_exhaustion";
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("provider probe listener must bind");
    let base_url = format!(
        "http://{}/v1",
        listener
            .local_addr()
            .expect("provider probe listener address")
    );
    let mut manifest = global_pool_alive_manifest(server_id);
    let provider = manifest.providers.get_mut("first").expect("first provider");
    provider.base_url = base_url;
    provider.auth.entries[0].env = Some("ROUTECODEX_V3_FRESH_COOLDOWN_PROBE_KEY".into());
    std::env::set_var(
        "ROUTECODEX_V3_FRESH_COOLDOWN_PROBE_KEY",
        "routecodex-test-key",
    );
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, "fresh-cooldown-session")
            .expect("failure session scope");
    let expanded = match build_v3_relay_target_candidates(&V3RelayProviderTargetResolutionInput {
        manifest: &manifest,
        server_id,
        failure_session_scope: &failure_session_scope,
        entry_kind: "responses",
        endpoint_path: "/v1/responses",
        body: &json!({"model":"client-responses","input":"hello"}),
        request_local_excluded_candidates: &BTreeSet::new(),
        provider_health: &health,
        now_ms: 20_001,
        deterministic_sample: 0,
    }) {
        Ok(expanded) => expanded,
        Err(_) => panic!("expanded candidates failed"),
    };
    put_all_candidates_in_provider_cooldown(&health, &expanded);
    let probe_server = tokio::spawn(serve_one_responses_probe(listener));

    let selection = tokio::time::timeout(
        Duration::from_secs(2),
        select_v3_expanded_target_with_exhaustion_rescue(
            &manifest,
            expanded,
            &failure_session_scope,
            &health,
            &BTreeSet::new(),
            20_001,
            0,
            true,
        ),
    )
    .await
    .expect("fresh cooldown exhaustion must not wait forever");
    match selection {
        V3TargetSelectionAfterRescue::Selected(_) => {}
        _ => panic!("successful fresh rescue probe must resume the same request"),
    }
    tokio::time::timeout(Duration::from_secs(1), probe_server)
        .await
        .expect("fresh cooldown exhaustion must run a rescue probe")
        .expect("provider probe task must not panic");
}

#[tokio::test]
async fn cooldown_only_exhaustion_waits_for_successful_rescue_probe() {
    let server_id = "cooldown_only_exhaustion";
    let manifest = global_pool_alive_manifest(server_id);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, "cooldown-only-session")
            .expect("failure session scope");
    let expanded = match build_v3_relay_target_candidates(&V3RelayProviderTargetResolutionInput {
        manifest: &manifest,
        server_id,
        failure_session_scope: &failure_session_scope,
        entry_kind: "responses",
        endpoint_path: "/v1/responses",
        body: &json!({"model":"client-responses","input":"hello"}),
        request_local_excluded_candidates: &BTreeSet::new(),
        provider_health: &health,
        now_ms: 20_001,
        deterministic_sample: 0,
    }) {
        Ok(expanded) => expanded,
        Err(_) => panic!("expanded candidates failed"),
    };
    put_all_candidates_in_provider_cooldown(&health, &expanded);
    let first = expanded.candidates[0].clone();
    let second = expanded.candidates[1].clone();
    let excluded_key = v3_relay_provider_candidate_key(&first);
    let first_permit = acquire_rescue_probe(
        &health,
        &first.provider_id,
        &first.auth_alias,
        &first.model_id,
    );
    let second_permit = acquire_rescue_probe(
        &health,
        &second.provider_id,
        &second.auth_alias,
        &second.model_id,
    );

    let selection_started = Arc::new(Notify::new());
    let selection = {
        let health = health.clone();
        let failure_session_scope = failure_session_scope.clone();
        let selection_started = selection_started.clone();
        let request_local_excluded_candidates = BTreeSet::from([excluded_key.clone()]);
        tokio::spawn(async move {
            let task = select_v3_expanded_target_with_exhaustion_rescue(
                &manifest,
                expanded,
                &failure_session_scope,
                &health,
                &request_local_excluded_candidates,
                20_001,
                0,
                true,
            );
            selection_started.notify_one();
            task.await
        })
    };
    selection_started.notified().await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !selection.is_finished(),
        "cooldown-only exhaustion must hold the request until a rescue probe succeeds"
    );

    health
        .store
        .complete_provider_cooldown_probe_success_at_generation(
            &first.provider_id,
            Some(&first.auth_alias),
            Some(&first.model_id),
            20_001,
            Some(first_permit.expected_generation()),
        )
        .expect("first rescue probe success");

    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !selection.is_finished(),
        "a successful probe must not revive a candidate excluded by an earlier request-local failure"
    );

    health
        .store
        .complete_provider_cooldown_probe_success_at_generation(
            &second.provider_id,
            Some(&second.auth_alias),
            Some(&second.model_id),
            20_001,
            Some(second_permit.expected_generation()),
        )
        .expect("second rescue probe success");

    let selection = tokio::time::timeout(Duration::from_millis(500), selection)
        .await
        .expect("selection must wake after rescue probe success")
        .expect("selection task must not panic");
    match selection {
        V3TargetSelectionAfterRescue::Selected(selected) => assert_ne!(
            v3_relay_provider_candidate_key(&selected.candidate),
            excluded_key,
            "successful rescue probe must recover a different candidate without reviving a request-local failure"
        ),
        _ => panic!("successful rescue probe must make a candidate selectable"),
    }
}

#[tokio::test]
async fn cooldown_only_exhaustion_probe_failure_keeps_waiting_for_later_recovery() {
    let server_id = "cooldown_only_exhaustion_failure";
    let manifest = global_pool_alive_manifest(server_id);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, "cooldown-only-failure-session")
            .expect("failure session scope");
    let expanded = match build_v3_relay_target_candidates(&V3RelayProviderTargetResolutionInput {
        manifest: &manifest,
        server_id,
        failure_session_scope: &failure_session_scope,
        entry_kind: "responses",
        endpoint_path: "/v1/responses",
        body: &json!({"model":"client-responses","input":"hello"}),
        request_local_excluded_candidates: &BTreeSet::new(),
        provider_health: &health,
        now_ms: 20_001,
        deterministic_sample: 0,
    }) {
        Ok(expanded) => expanded,
        Err(_) => panic!("expanded candidates failed"),
    };
    put_all_candidates_in_provider_cooldown(&health, &expanded);
    let first = expanded.candidates[0].clone();
    let second = expanded.candidates[1].clone();
    let excluded_key = v3_relay_provider_candidate_key(&first);
    let first_permit = acquire_rescue_probe(
        &health,
        &first.provider_id,
        &first.auth_alias,
        &first.model_id,
    );
    let second_permit = acquire_rescue_probe(
        &health,
        &second.provider_id,
        &second.auth_alias,
        &second.model_id,
    );

    let selection_started = Arc::new(Notify::new());
    let selection = {
        let health = health.clone();
        let failure_session_scope = failure_session_scope.clone();
        let selection_started = selection_started.clone();
        let request_local_excluded_candidates = BTreeSet::from([excluded_key.clone()]);
        tokio::spawn(async move {
            let task = select_v3_expanded_target_with_exhaustion_rescue(
                &manifest,
                expanded,
                &failure_session_scope,
                &health,
                &request_local_excluded_candidates,
                20_001,
                0,
                true,
            );
            selection_started.notify_one();
            task.await
        })
    };
    selection_started.notified().await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !selection.is_finished(),
        "failed rescue probes must keep the request held"
    );

    health
        .store
        .complete_provider_cooldown_probe_failure_at_generation(
            &first.provider_id,
            Some(&first.auth_alias),
            Some(&first.model_id),
            20_001,
            Some(first_permit.expected_generation()),
        )
        .expect("first rescue probe failure");

    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !selection.is_finished(),
        "one failed probe must not terminate while another probe is in flight"
    );

    health
        .store
        .complete_provider_cooldown_probe_success_at_generation(
            &second.provider_id,
            Some(&second.auth_alias),
            Some(&second.model_id),
            20_001,
            Some(second_permit.expected_generation()),
        )
        .expect("second rescue probe success");

    let selection = tokio::time::timeout(Duration::from_millis(500), selection)
        .await
        .expect("selection must wake after a later rescue probe succeeds")
        .expect("selection task must not panic");
    match selection {
        V3TargetSelectionAfterRescue::Selected(selected) => assert_ne!(
            v3_relay_provider_candidate_key(&selected.candidate),
            excluded_key,
            "recovery must not revive a candidate excluded by an earlier request-local failure"
        ),
        _ => panic!("a later successful rescue probe must resume the held request"),
    }
}

#[tokio::test]
async fn cooldown_only_exhaustion_retries_when_next_probe_is_due() {
    let server_id = "cooldown_only_exhaustion_due_retry";
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("provider probe listener must bind");
    let base_url = format!(
        "http://{}/v1",
        listener
            .local_addr()
            .expect("provider probe listener address")
    );
    let mut manifest = global_pool_alive_manifest(server_id);
    let provider = manifest.providers.get_mut("first").expect("first provider");
    provider.base_url = base_url;
    provider.auth.entries[0].env = Some("ROUTECODEX_V3_DUE_RETRY_PROBE_KEY".into());
    std::env::set_var("ROUTECODEX_V3_DUE_RETRY_PROBE_KEY", "routecodex-test-key");
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, "cooldown-due-retry-session")
            .expect("failure session scope");
    let expanded = match build_v3_relay_target_candidates(&V3RelayProviderTargetResolutionInput {
        manifest: &manifest,
        server_id,
        failure_session_scope: &failure_session_scope,
        entry_kind: "responses",
        endpoint_path: "/v1/responses",
        body: &json!({"model":"client-responses","input":"hello"}),
        request_local_excluded_candidates: &BTreeSet::new(),
        provider_health: &health,
        now_ms: 20_001,
        deterministic_sample: 0,
    }) {
        Ok(expanded) => expanded,
        Err(_) => panic!("expanded candidates failed"),
    };
    put_all_candidates_in_provider_cooldown(&health, &expanded);
    let second = expanded.candidates[1].clone();
    let second_permit = acquire_rescue_probe(
        &health,
        &second.provider_id,
        &second.auth_alias,
        &second.model_id,
    );
    let probe_server = tokio::spawn(serve_one_responses_probe(listener));

    let selection = tokio::spawn({
        let health = health.clone();
        let failure_session_scope = failure_session_scope.clone();
        async move {
            select_v3_expanded_target_with_exhaustion_rescue(
                &manifest,
                expanded,
                &failure_session_scope,
                &health,
                &BTreeSet::new(),
                20_001,
                0,
                true,
            )
            .await
        }
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !selection.is_finished(),
        "the first rescue probe must complete before the due retry"
    );
    health
        .store
        .complete_provider_cooldown_probe_failure_at_generation(
            &second.provider_id,
            Some(&second.auth_alias),
            Some(&second.model_id),
            20_001,
            Some(second_permit.expected_generation()),
        )
        .expect("first rescue probe failure");

    let selection = tokio::time::timeout(Duration::from_secs(7), selection)
        .await
        .expect("the held request must retry when the provider-owned next probe becomes due")
        .expect("selection task must not panic");
    assert!(
        matches!(selection, V3TargetSelectionAfterRescue::Selected(_)),
        "the due retry probe must resume the held request"
    );
    tokio::time::timeout(Duration::from_secs(1), probe_server)
        .await
        .expect("the due retry must reach the provider listener")
        .expect("provider probe task must not panic");
}

#[tokio::test]
async fn request_local_exclusion_without_cooldown_probe_success_stays_terminal() {
    let server_id = "request_local_exclusion_without_probe";
    let manifest = global_pool_alive_manifest(server_id);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, "request-local-exclusion-session")
            .expect("failure session scope");
    let expanded = match build_v3_relay_target_candidates(&V3RelayProviderTargetResolutionInput {
        manifest: &manifest,
        server_id,
        failure_session_scope: &failure_session_scope,
        entry_kind: "responses",
        endpoint_path: "/v1/responses",
        body: &json!({"model":"client-responses","input":"hello"}),
        request_local_excluded_candidates: &BTreeSet::new(),
        provider_health: &health,
        now_ms: 20_001,
        deterministic_sample: 0,
    }) {
        Ok(expanded) => expanded,
        Err(_) => panic!("expanded candidates failed"),
    };
    let request_local_excluded_candidates = all_candidate_keys(&expanded);

    let selection = tokio::time::timeout(
        Duration::from_millis(500),
        select_v3_expanded_target_with_exhaustion_rescue(
            &manifest,
            expanded,
            &failure_session_scope,
            &health,
            &request_local_excluded_candidates,
            20_001,
            0,
            true,
        ),
    )
    .await
    .expect("non-cooldown request-local exclusion must not hang");
    assert!(
        matches!(selection, V3TargetSelectionAfterRescue::Exhausted(_)),
        "ordinary request-local provider failures must remain terminal"
    );
}

#[tokio::test]
async fn auth_key_cooldown_holds_selection_until_probe_recovery() {
    let server_id = "auth_key_cooldown_with_provider_probe";
    let manifest = global_pool_alive_manifest(server_id);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, "auth-key-with-provider-probe")
            .expect("failure session scope");
    let expanded = match build_v3_relay_target_candidates(&V3RelayProviderTargetResolutionInput {
        manifest: &manifest,
        server_id,
        failure_session_scope: &failure_session_scope,
        entry_kind: "responses",
        endpoint_path: "/v1/responses",
        body: &json!({"model":"client-responses","input":"hello"}),
        request_local_excluded_candidates: &BTreeSet::new(),
        provider_health: &health,
        now_ms: 20_001,
        deterministic_sample: 0,
    }) {
        Ok(expanded) => expanded,
        Err(_) => panic!("expanded candidates failed"),
    };
    for provider_id in ["first", "second"] {
        put_auth_key_in_cooldown(&health, &failure_session_scope, provider_id, "key1", 20_001);
    }
    let first_permit = health
        .store
        .acquire_provider_cooldown_probe_if_due("first", Some("key1"), Some("gpt-test"), 25_001)
        .expect("auth-key due probe acquisition")
        .expect("the model candidate must acquire the model-less auth-key probe");
    assert_eq!(first_permit.auth_alias(), Some("key1"));
    assert_eq!(
        first_permit.model_id(),
        None,
        "the auth-key probe must retain its model-less identity"
    );

    let selection = tokio::spawn({
        let health = health.clone();
        let failure_session_scope = failure_session_scope.clone();
        async move {
            select_v3_expanded_target_with_exhaustion_rescue(
                &manifest,
                expanded,
                &failure_session_scope,
                &health,
                &BTreeSet::new(),
                25_001,
                0,
                true,
            )
            .await
        }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !selection.is_finished(),
        "auth-key cooldown-only exhaustion must hold for probe recovery"
    );

    health
        .store
        .complete_provider_cooldown_probe_failure_at_generation(
            first_permit.provider_id(),
            first_permit.auth_alias(),
            first_permit.model_id(),
            25_001,
            Some(first_permit.expected_generation()),
        )
        .expect("failed auth-key probe");
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !selection.is_finished(),
        "a failed auth-key probe must keep the request held for the next probe"
    );
    let retry_deadline_ms = health
        .store
        .provider_cooldown_probe_next_deadline_ms("first", Some("key1"), Some("gpt-test"))
        .expect("auth-key retry deadline")
        .expect("failed auth-key probe must schedule a retry");
    let retry = health
        .store
        .acquire_provider_cooldown_probe_if_due(
            "first",
            Some("key1"),
            Some("gpt-test"),
            retry_deadline_ms,
        )
        .expect("auth-key retry probe acquisition")
        .expect("the model candidate must resolve the next auth-key probe deadline");
    health
        .store
        .complete_provider_cooldown_probe_success_at_generation(
            retry.provider_id(),
            retry.auth_alias(),
            retry.model_id(),
            retry_deadline_ms,
            Some(retry.expected_generation()),
        )
        .expect("successful auth-key retry probe");
    let selection = tokio::time::timeout(Duration::from_millis(500), selection)
        .await
        .expect("selection must wake after auth-key probe success")
        .expect("selection task must not panic");
    assert!(
        matches!(selection, V3TargetSelectionAfterRescue::Selected(_)),
        "successful auth-key retry probe must resume the held request"
    );
}

#[tokio::test]
async fn auth_key_cooldown_holds_selection_until_successful_probe_recovery() {
    let server_id = "auth_key_cooldown_with_successful_provider_probe";
    let manifest = global_pool_alive_manifest(server_id);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope = test_provider_failure_scope(
        server_id,
        server_id,
        "auth-key-with-successful-provider-probe",
    )
    .expect("failure session scope");
    let expanded = match build_v3_relay_target_candidates(&V3RelayProviderTargetResolutionInput {
        manifest: &manifest,
        server_id,
        failure_session_scope: &failure_session_scope,
        entry_kind: "responses",
        endpoint_path: "/v1/responses",
        body: &json!({"model":"client-responses","input":"hello"}),
        request_local_excluded_candidates: &BTreeSet::new(),
        provider_health: &health,
        now_ms: 20_001,
        deterministic_sample: 0,
    }) {
        Ok(expanded) => expanded,
        Err(_) => panic!("expanded candidates failed"),
    };
    for provider_id in ["first", "second"] {
        put_auth_key_in_cooldown(&health, &failure_session_scope, provider_id, "key1", 20_001);
    }
    let first_permit = health
        .store
        .acquire_provider_cooldown_probe_if_due("first", Some("key1"), Some("gpt-test"), 25_001)
        .expect("auth-key due probe acquisition")
        .expect("the model candidate must acquire the model-less auth-key probe");
    assert_eq!(first_permit.auth_alias(), Some("key1"));
    assert_eq!(
        first_permit.model_id(),
        None,
        "the auth-key probe must retain its model-less identity"
    );

    let selection = tokio::spawn({
        let health = health.clone();
        let failure_session_scope = failure_session_scope.clone();
        async move {
            select_v3_expanded_target_with_exhaustion_rescue(
                &manifest,
                expanded,
                &failure_session_scope,
                &health,
                &BTreeSet::new(),
                25_001,
                0,
                true,
            )
            .await
        }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        !selection.is_finished(),
        "auth-key cooldown-only exhaustion must hold for successful probe recovery"
    );
    health
        .store
        .complete_provider_cooldown_probe_success_at_generation(
            first_permit.provider_id(),
            first_permit.auth_alias(),
            first_permit.model_id(),
            25_001,
            Some(first_permit.expected_generation()),
        )
        .expect("successful auth-key probe");
    let selection = tokio::time::timeout(Duration::from_millis(500), selection)
        .await
        .expect("a successful auth-key probe must resume the held request")
        .expect("selection task must not panic");
    assert!(
        matches!(selection, V3TargetSelectionAfterRescue::Selected(_)),
        "successful auth-key probe recovery must make the candidate selectable"
    );
}

#[tokio::test]
async fn later_tier_selection_probes_preceding_cooled_candidate_before_fallback() {
    let server_id = "later_tier_probe";
    let mut manifest = global_pool_alive_manifest(server_id);
    manifest
        .providers
        .get_mut("first")
        .expect("first provider")
        .base_url = "http://127.0.0.1:1/v1".to_string();
    let mut third_provider = manifest
        .providers
        .get("second")
        .expect("second provider")
        .clone();
    third_provider.base_url = "http://third.invalid/v1".to_string();
    manifest
        .providers
        .insert("third".to_string(), third_provider);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, "later-tier-session")
            .expect("failure session scope");
    let body = json!({"model":"client-responses","input":"hello"});
    let mut expanded =
        match build_v3_relay_target_candidates(&V3RelayProviderTargetResolutionInput {
            manifest: &manifest,
            server_id,
            failure_session_scope: &failure_session_scope,
            entry_kind: "responses",
            endpoint_path: "/v1/responses",
            body: &body,
            request_local_excluded_candidates: &BTreeSet::new(),
            provider_health: &health,
            now_ms: 20_001,
            deterministic_sample: 0,
        }) {
            Ok(expanded) => expanded,
            Err(_) => panic!("expanded candidates"),
        };

    let first = expanded
        .candidates
        .iter_mut()
        .find(|candidate| candidate.provider_id == "first")
        .expect("first candidate");
    first.pool_ids = vec!["client_responses".to_string()];
    let second = expanded
        .candidates
        .iter_mut()
        .find(|candidate| candidate.provider_id == "second")
        .expect("second candidate");
    second.pool_ids = vec!["default".to_string()];
    let mut third = second.clone();
    third.provider_id = "third".to_string();
    third.base_url = "http://third.invalid/v1".to_string();
    third.pool_ids = vec!["emergency".to_string()];
    expanded.candidates.push(third);
    let target_kind = expanded
        .route
        .target_plan
        .first()
        .expect("initial target plan")
        .target_kind
        .clone();
    expanded.route.target_plan.push(
        routecodex_v3_virtual_router::V3Router07OpaqueTargetPlanEntry {
            tier_index: 1,
            pool_id: "default".to_string(),
            target_index: 0,
            target_kind: target_kind.clone(),
            target_id: None,
            priority: 1,
            weight: 1,
            direct_provider_model: Some(("second".to_string(), "gpt-test".to_string())),
        },
    );
    expanded.route.target_plan.push(
        routecodex_v3_virtual_router::V3Router07OpaqueTargetPlanEntry {
            tier_index: 2,
            pool_id: "emergency".to_string(),
            target_index: 0,
            target_kind: target_kind.clone(),
            target_id: None,
            priority: 1,
            weight: 1,
            direct_provider_model: Some(("third".to_string(), "gpt-test".to_string())),
        },
    );
    assert_eq!(
        V3TargetInterpreter::route_tier_index_for_candidate(
            &expanded.route,
            expanded
                .candidates
                .iter()
                .find(|candidate| candidate.provider_id == "first")
                .expect("first candidate"),
        ),
        0
    );
    assert_eq!(
        V3TargetInterpreter::route_tier_index_for_candidate(
            &expanded.route,
            expanded
                .candidates
                .iter()
                .find(|candidate| candidate.provider_id == "second")
                .expect("second candidate"),
        ),
        1
    );
    assert_eq!(
        V3TargetInterpreter::route_tier_index_for_candidate(
            &expanded.route,
            expanded
                .candidates
                .iter()
                .find(|candidate| candidate.provider_id == "third")
                .expect("third candidate"),
        ),
        2
    );

    for provider_id in ["first", "second"] {
        for _ in 0..3 {
            health
                .store
                .record_provider_cooldown_failure(
                    provider_id,
                    Some("key1"),
                    Some("gpt-test"),
                    "preceding tier is cooled",
                    20_000,
                    100_000,
                )
                .expect("preceding candidate cooldown");
        }
    }

    let selection = tokio::time::timeout(
        Duration::from_secs(2),
        select_v3_expanded_target_with_exhaustion_rescue(
            &manifest,
            expanded,
            &failure_session_scope,
            &health,
            &BTreeSet::new(),
            20_001,
            0,
            true,
        ),
    )
    .await
    .expect("preceding-tier probe must not hang");
    let V3TargetSelectionAfterRescue::Selected(selected) = selection else {
        panic!("a later tier must remain selectable after probe failure");
    };
    assert_eq!(selected.candidate.provider_id, "third");
    for provider_id in ["first", "second"] {
        assert!(
            health
                .store
                .acquire_provider_cooldown_rescue_probe(
                    provider_id,
                    Some("key1"),
                    Some("gpt-test"),
                )
                .expect("rescue probe state")
                .is_none(),
            "every preceding tier must be probed before a later-tier selection"
        );
        assert!(
            !health
                .store
                .availability(provider_id, Some("key1"), Some("gpt-test"), 20_001)
                .available,
            "a failed probe must preserve the preceding candidate cooldown"
        );
    }
}

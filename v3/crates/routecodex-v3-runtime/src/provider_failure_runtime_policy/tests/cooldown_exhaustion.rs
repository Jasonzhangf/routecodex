use super::*;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
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
            excluded_key.clone(),
            "successful rescue probe must recover a different candidate without reviving a request-local failure"
        ),
        _ => panic!("successful rescue probe must make a candidate selectable"),
    }
}

#[tokio::test]
async fn cooldown_only_exhaustion_probe_failure_continues_the_ladder() {
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

    health
        .store
        .complete_provider_cooldown_probe_success_at_generation(
            &second.provider_id,
            Some(&second.auth_alias),
            Some(&second.model_id),
            20_001,
            Some(second_permit.expected_generation()),
        )
        .expect("scheduled rescue probe success");

    let selection = tokio::time::timeout(Duration::from_millis(500), selection)
        .await
        .expect("selection must wake after a later rescue probe succeeds")
        .expect("selection task must not panic");
    match selection {
        V3TargetSelectionAfterRescue::Selected(selected) => assert_ne!(
            v3_relay_provider_candidate_key(&selected.candidate),
            excluded_key,
            "the request must resume with a nonfailed candidate after the ladder succeeds"
        ),
        _ => panic!("the request must resume after the recovery ladder succeeds"),
    }
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
async fn request_local_failure_is_not_revived_by_cooldown_probe_success() {
    let server_id = "request_local_failure_not_revived";
    let manifest = global_pool_alive_manifest(server_id);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, "request-local-revival-session")
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
    let request_local_excluded_candidates = BTreeSet::from([excluded_key.clone()]);

    let selection_started = Arc::new(Notify::new());
    let selection = {
        let health = health.clone();
        let failure_session_scope = failure_session_scope.clone();
        let selection_started = selection_started.clone();
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
        "the nonfailed candidate must keep the request held while recovery probes continue"
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
        "a request-local failed candidate must not be revived by its own cooldown probe success"
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
            "a request-local failed candidate must remain excluded even after its probe succeeds"
        ),
        _ => panic!("the nonfailed candidate must be selected"),
    }
}

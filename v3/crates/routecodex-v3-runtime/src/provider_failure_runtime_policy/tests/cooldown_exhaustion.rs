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

#[tokio::test]
async fn cooldown_only_exhaustion_waits_for_successful_rescue_probe() {
    let server_id = "cooldown_only_exhaustion";
    let manifest = global_pool_alive_manifest(server_id);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    for provider_id in ["first", "second"] {
        for _ in 0..3 {
            health
                .store
                .record_provider_cooldown_failure(
                    provider_id,
                    Some("key1"),
                    Some("gpt-test"),
                    "controlled cooldown-only exhaustion",
                    10_000,
                    1,
                )
                .expect("provider cooldown setup");
        }
        let permit = health
            .store
            .acquire_provider_cooldown_rescue_probe(provider_id, Some("key1"), Some("gpt-test"))
            .expect("rescue probe acquisition")
            .expect("rescue probe must be acquired");
        health
            .store
            .complete_provider_cooldown_probe_failure_at_generation(
                provider_id,
                Some("key1"),
                Some("gpt-test"),
                20_000,
                Some(permit.expected_generation()),
            )
            .expect("rescue probe completion");
    }

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

    let selection_started = Arc::new(Notify::new());
    let selection = {
        let health = health.clone();
        let failure_session_scope = failure_session_scope.clone();
        let selection_started = selection_started.clone();
        let request_local_excluded_candidates = all_candidate_keys(&expanded);
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
        .complete_provider_cooldown_probe_success("first", Some("key1"), Some("gpt-test"))
        .expect("rescue probe success");

    let selection = tokio::time::timeout(Duration::from_millis(500), selection)
        .await
        .expect("selection must wake after rescue probe success")
        .expect("selection task must not panic");
    match selection {
        V3TargetSelectionAfterRescue::Selected(selected) => assert_eq!(
            selected.candidate.provider_id, "first",
            "successful rescue probe must recover the request-local excluded candidate"
        ),
        _ => panic!("successful rescue probe must make a candidate selectable"),
    }
}

#[tokio::test]
async fn cooldown_only_exhaustion_probe_failure_continues_the_ladder() {
    let server_id = "cooldown_only_exhaustion_failure";
    let manifest = global_pool_alive_manifest(server_id);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    for provider_id in ["first", "second"] {
        for _ in 0..3 {
            health
                .store
                .record_provider_cooldown_failure(
                    provider_id,
                    Some("key1"),
                    Some("gpt-test"),
                    "controlled cooldown-only exhaustion",
                    10_000,
                    1,
                )
                .expect("provider cooldown setup");
        }
        let permit = health
            .store
            .acquire_provider_cooldown_rescue_probe(provider_id, Some("key1"), Some("gpt-test"))
            .expect("rescue probe acquisition")
            .expect("rescue probe must be acquired");
        health
            .store
            .complete_provider_cooldown_probe_failure_at_generation(
                provider_id,
                Some("key1"),
                Some("gpt-test"),
                20_000,
                Some(permit.expected_generation()),
            )
            .expect("rescue probe completion");
    }

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

    let selection_started = Arc::new(Notify::new());
    let selection = {
        let health = health.clone();
        let failure_session_scope = failure_session_scope.clone();
        let selection_started = selection_started.clone();
        let request_local_excluded_candidates = all_candidate_keys(&expanded);
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
        .complete_provider_cooldown_probe_success("first", Some("key1"), Some("gpt-test"))
        .expect("scheduled rescue probe success");

    let selection = tokio::time::timeout(Duration::from_millis(500), selection)
        .await
        .expect("selection must wake after a later rescue probe succeeds")
        .expect("selection task must not panic");
    match selection {
        V3TargetSelectionAfterRescue::Selected(selected) => assert_eq!(
            selected.candidate.provider_id, "first",
            "the request must resume with the recovered candidate after the ladder succeeds"
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

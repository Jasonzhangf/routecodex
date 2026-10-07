use super::*;
use serde_json::json;
use std::time::Duration;

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
async fn fresh_cooldown_only_exhaustion_is_terminal_without_waiting() {
    let server_id = "fresh_cooldown_only_exhaustion_terminal";
    let manifest = global_pool_alive_manifest(server_id);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, "fresh-cooldown-terminal-session")
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
    let generation_before = health.store.availability_generation();

    let selection = tokio::time::timeout(
        Duration::from_millis(250),
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
    .expect("a fully cooled eligible pool must terminate without waiting");

    assert!(
        matches!(selection, V3TargetSelectionAfterRescue::Exhausted(_)),
        "complete cooldown-only exhaustion must return terminal exhaustion, not resume"
    );
    assert_eq!(
        health.store.availability_generation(),
        generation_before,
        "the exhausted request must not run a request-owned rescue probe"
    );
}

#[tokio::test]
async fn probe_recovery_after_terminal_exhaustion_does_not_resume_the_exhausted_request() {
    let server_id = "terminal_exhaustion_no_resume";
    let manifest = global_pool_alive_manifest(server_id);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, "terminal-no-resume-session")
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
    let stale_candidate = expanded.candidates[0].clone();
    let next_candidate = expanded.candidates[1].clone();

    let exhausted = tokio::time::timeout(
        Duration::from_millis(250),
        select_v3_expanded_target_with_exhaustion_rescue(
            &manifest,
            expanded.clone(),
            &failure_session_scope,
            &health,
            &BTreeSet::new(),
            20_001,
            0,
            true,
        ),
    )
    .await
    .expect("complete exhaustion must terminate without waiting");
    match exhausted {
        V3TargetSelectionAfterRescue::Exhausted(exhausted) => assert!(
            !exhausted.attempted_candidates.is_empty(),
            "terminal exhaustion must record the attempted candidates"
        ),
        V3TargetSelectionAfterRescue::Selected(_) => {
            panic!("a fully cooled eligible pool must not select a candidate")
        }
        V3TargetSelectionAfterRescue::Failed(source) => {
            panic!("complete exhaustion must not raise a source failure: {source:?}")
        }
    }

    // A newer failure for the stale candidate plus an external successful probe
    // for the next candidate must not resume the request that already terminated.
    health
        .store
        .record_provider_failure_action(
            &stale_candidate.provider_id,
            &stale_candidate.auth_alias,
            &stale_candidate.model_id,
            &V3ProviderFailureAction::recoverable("transport"),
            20_002,
        )
        .expect("newer provider failure must advance health generation");
    let next_permit = acquire_rescue_probe(
        &health,
        &next_candidate.provider_id,
        &next_candidate.auth_alias,
        &next_candidate.model_id,
    );
    health
        .store
        .complete_provider_cooldown_probe_success_at_generation(
            next_permit.provider_id(),
            next_permit.auth_alias(),
            next_permit.model_id(),
            20_002,
            Some(next_permit.expected_generation()),
        )
        .expect("external rescue probe success");

    let selection = tokio::time::timeout(
        Duration::from_millis(250),
        select_v3_expanded_target_with_exhaustion_rescue(
            &manifest,
            expanded,
            &failure_session_scope,
            &health,
            &BTreeSet::new(),
            20_002,
            0,
            true,
        ),
    )
    .await
    .expect("a new selection must not wait after external recovery");
    match selection {
        V3TargetSelectionAfterRescue::Selected(selected) => assert_eq!(
            selected.candidate.provider_id, next_candidate.provider_id,
            "the recovered next provider must serve the new selection only"
        ),
        _ => panic!("external recovery must restore admission for a new request"),
    }
}

#[tokio::test]
async fn request_local_exclusion_is_preserved_across_terminal_exhaustion() {
    let server_id = "terminal_exhaustion_request_local_exclusion";
    let manifest = global_pool_alive_manifest(server_id);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, "terminal-exclusion-session")
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
    let excluded_candidate = expanded.candidates[0].clone();
    let excluded_key = v3_relay_provider_candidate_key(&excluded_candidate);
    let request_local_excluded_candidates = BTreeSet::from([excluded_key.clone()]);

    let selection = tokio::time::timeout(
        Duration::from_millis(250),
        select_v3_expanded_target_with_exhaustion_rescue(
            &manifest,
            expanded.clone(),
            &failure_session_scope,
            &health,
            &request_local_excluded_candidates,
            20_001,
            0,
            true,
        ),
    )
    .await
    .expect("cooldown-only exhaustion with a request-local exclusion must not wait");
    assert!(
        matches!(selection, V3TargetSelectionAfterRescue::Exhausted(_)),
        "a request-local excluded candidate must not be revived by waiting"
    );

    for candidate in &expanded.candidates {
        let permit = acquire_rescue_probe(
            &health,
            &candidate.provider_id,
            &candidate.auth_alias,
            &candidate.model_id,
        );
        health
            .store
            .complete_provider_cooldown_probe_success_at_generation(
                permit.provider_id(),
                permit.auth_alias(),
                permit.model_id(),
                20_001,
                Some(permit.expected_generation()),
            )
            .expect("external rescue probe success");
    }

    let selection = tokio::time::timeout(
        Duration::from_millis(250),
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
    .expect("a new selection must not wait after external recovery");
    match selection {
        V3TargetSelectionAfterRescue::Selected(selected) => assert_ne!(
            v3_relay_provider_candidate_key(&selected.candidate),
            excluded_key,
            "external recovery must not revive a request-local excluded candidate"
        ),
        _ => panic!("the non-excluded candidate must be selectable after recovery"),
    }
}

#[tokio::test]
async fn cooldown_only_exhaustion_probe_failure_keeps_a_new_request_terminal() {
    let server_id = "cooldown_only_exhaustion_failure_terminal";
    let manifest = global_pool_alive_manifest(server_id);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, "cooldown-failure-terminal-session")
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

    let first_selection = tokio::time::timeout(
        Duration::from_millis(250),
        select_v3_expanded_target_with_exhaustion_rescue(
            &manifest,
            expanded.clone(),
            &failure_session_scope,
            &health,
            &BTreeSet::new(),
            20_001,
            0,
            true,
        ),
    )
    .await
    .expect("a fully cooled eligible pool must terminate without waiting");
    assert!(matches!(
        first_selection,
        V3TargetSelectionAfterRescue::Exhausted(_)
    ));

    // An external management probe failure must preserve the cooldown and must
    // not turn a later request into a held wait.
    let second_permit = acquire_rescue_probe(
        &health,
        &second.provider_id,
        &second.auth_alias,
        &second.model_id,
    );
    health
        .store
        .complete_provider_cooldown_probe_failure_at_generation(
            second_permit.provider_id(),
            second_permit.auth_alias(),
            second_permit.model_id(),
            20_001,
            Some(second_permit.expected_generation()),
        )
        .expect("external rescue probe failure");
    assert!(
        !health
            .availability(
                &second.provider_id,
                Some(&second.auth_alias),
                Some(&second.model_id),
                20_001,
            )
            .available,
        "a failed management probe must preserve the provider cooldown"
    );

    let next_selection = tokio::time::timeout(
        Duration::from_millis(250),
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
    .expect("a still-cooled pool must terminate without waiting");
    assert!(
        matches!(next_selection, V3TargetSelectionAfterRescue::Exhausted(_)),
        "a failed management probe must not hold a later request"
    );
}

#[tokio::test]
async fn cooldown_only_exhaustion_never_retries_on_due_probe() {
    let server_id = "cooldown_only_exhaustion_no_due_retry";
    let manifest = global_pool_alive_manifest(server_id);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, "cooldown-no-due-retry-session")
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

    // A due probe is owned by the health store, never by the request.
    let due_deadline_ms = health
        .store
        .provider_cooldown_probe_next_deadline_ms(
            &first.provider_id,
            Some(&first.auth_alias),
            Some(&first.model_id),
        )
        .expect("background probe deadline")
        .expect("a cooled provider must schedule a background probe");
    let due_permit = health
        .store
        .acquire_provider_cooldown_probe_if_due(
            &first.provider_id,
            Some(&first.auth_alias),
            Some(&first.model_id),
            due_deadline_ms,
        )
        .expect("background due probe acquisition")
        .expect("the scheduled background probe must become due");
    let generation_before = health.store.availability_generation();

    let selection = tokio::time::timeout(
        Duration::from_millis(250),
        select_v3_expanded_target_with_exhaustion_rescue(
            &manifest,
            expanded,
            &failure_session_scope,
            &health,
            &BTreeSet::new(),
            due_deadline_ms,
            0,
            true,
        ),
    )
    .await
    .expect("a due background probe must not hold the request");
    assert!(
        matches!(selection, V3TargetSelectionAfterRescue::Exhausted(_)),
        "the request must terminate instead of retrying the due background probe"
    );
    assert_eq!(
        health.store.availability_generation(),
        generation_before,
        "the request must not run the due background probe itself"
    );

    health
        .store
        .complete_provider_cooldown_probe_failure_at_generation(
            due_permit.provider_id(),
            due_permit.auth_alias(),
            due_permit.model_id(),
            due_deadline_ms,
            Some(due_permit.expected_generation()),
        )
        .expect("background probe failure");
    assert!(
        !health
            .availability(
                &first.provider_id,
                Some(&first.auth_alias),
                Some(&first.model_id),
                due_deadline_ms,
            )
            .available,
        "a failed background probe must preserve the cooldown"
    );
}

#[tokio::test]
async fn residence_timeout_config_does_not_hold_selection() {
    let server_id = "cooldown_exhaustion_residence_timeout_ignored";
    let manifest = global_pool_alive_manifest_with_rescue_timeout(server_id, Some(5_000));
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, "residence-timeout-ignored-session")
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
    let generation_before = health.store.availability_generation();

    let started = std::time::Instant::now();
    let selection = tokio::time::timeout(
        Duration::from_secs(1),
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
    .expect("a configured residence timeout must not hold the exhausted request");
    assert!(
        matches!(selection, V3TargetSelectionAfterRescue::Exhausted(_)),
        "complete exhaustion must be terminal even with a residence timeout configured"
    );
    assert!(
        started.elapsed() < Duration::from_millis(1_000),
        "the request must not wait for the residence timeout"
    );
    assert_eq!(
        health.store.availability_generation(),
        generation_before,
        "the request must not run a rescue probe while terminating"
    );
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
async fn auth_key_cooldown_exhaustion_is_terminal() {
    let server_id = "auth_key_cooldown_terminal";
    let manifest = global_pool_alive_manifest(server_id);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, "auth-key-terminal-session")
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
    let generation_before = health.store.availability_generation();

    let selection = tokio::time::timeout(
        Duration::from_millis(250),
        select_v3_expanded_target_with_exhaustion_rescue(
            &manifest,
            expanded,
            &failure_session_scope,
            &health,
            &BTreeSet::new(),
            25_001,
            0,
            true,
        ),
    )
    .await
    .expect("auth-key cooldown-only exhaustion must not wait");
    assert!(
        matches!(selection, V3TargetSelectionAfterRescue::Exhausted(_)),
        "auth-key cooldown-only exhaustion must be terminal"
    );
    assert_eq!(
        health.store.availability_generation(),
        generation_before,
        "the exhausted request must not run a request-owned auth-key probe"
    );
}

#[tokio::test]
async fn auth_key_cooldown_probe_recovery_restores_only_a_new_selection() {
    let server_id = "auth_key_cooldown_new_selection";
    let manifest = global_pool_alive_manifest(server_id);
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope =
        test_provider_failure_scope(server_id, server_id, "auth-key-new-selection-session")
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
    assert_eq!(
        first_permit.model_id(),
        None,
        "the auth-key probe must retain its model-less identity"
    );

    let exhausted = tokio::time::timeout(
        Duration::from_millis(250),
        select_v3_expanded_target_with_exhaustion_rescue(
            &manifest,
            expanded.clone(),
            &failure_session_scope,
            &health,
            &BTreeSet::new(),
            25_001,
            0,
            true,
        ),
    )
    .await
    .expect("auth-key cooldown-only exhaustion must not wait");
    assert!(
        matches!(exhausted, V3TargetSelectionAfterRescue::Exhausted(_)),
        "auth-key cooldown-only exhaustion must be terminal"
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

    let selection = tokio::time::timeout(
        Duration::from_millis(250),
        select_v3_expanded_target_with_exhaustion_rescue(
            &manifest,
            expanded,
            &failure_session_scope,
            &health,
            &BTreeSet::new(),
            25_001,
            0,
            true,
        ),
    )
    .await
    .expect("a new selection must not wait after auth-key probe recovery");
    match selection {
        V3TargetSelectionAfterRescue::Selected(selected) => {
            assert_eq!(selected.candidate.provider_id, "first");
            assert_eq!(
                selected.candidate.auth_alias, "key1",
                "auth-key probe recovery must restore the exact auth-key identity"
            );
        }
        _ => panic!("a successful auth-key probe must restore admission for a new request"),
    }
}

#[tokio::test]
async fn later_tier_selection_skips_in_flight_rescue_probes_without_waiting() {
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

    let first_probe = acquire_rescue_probe(&health, "first", "key1", "gpt-test");
    let second_probe = acquire_rescue_probe(&health, "second", "key1", "gpt-test");

    let selection = tokio::time::timeout(
        Duration::from_millis(500),
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
        panic!("a later tier must remain selectable while prior probes are in flight");
    };
    assert_eq!(selected.candidate.provider_id, "third");
    for (provider_id, permit) in [("first", first_probe), ("second", second_probe)] {
        health
            .store
            .complete_provider_cooldown_probe_failure_at_generation(
                provider_id,
                Some("key1"),
                Some("gpt-test"),
                20_001,
                Some(permit.expected_generation()),
            )
            .expect("finish the pre-existing rescue probe");
        assert!(
            !health
                .store
                .availability(provider_id, Some("key1"), Some("gpt-test"), 20_001)
                .available,
            "skipping a probe in flight must preserve the preceding candidate cooldown"
        );
    }
}

#[tokio::test]
async fn later_tier_selection_does_not_wait_for_probe_transport_admission() {
    let server_id = "later_tier_probe_transport_busy";
    let first_provider = "later_tier_busy_first";
    let mut manifest =
        global_pool_alive_manifest_with_provider_names(server_id, None, first_provider, "second");
    manifest
        .providers
        .get_mut(first_provider)
        .expect("first provider")
        .base_url = "http://127.0.0.1:1/v1".to_string();
    manifest
        .providers
        .get_mut(first_provider)
        .expect("first provider")
        .concurrency = Some(routecodex_v3_config::V3ProviderConcurrencyAuthoringConfig {
        max_in_flight: 1,
        acquire_timeout_ms: 60_000,
        stale_lease_ms: 300_000,
    });
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let failure_session_scope = test_provider_failure_scope(
        server_id,
        server_id,
        "later-tier-probe-transport-busy-session",
    )
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
        .find(|candidate| candidate.provider_id == first_provider)
        .expect("first candidate");
    first.pool_ids = vec!["client_responses".to_string()];
    let second = expanded
        .candidates
        .iter_mut()
        .find(|candidate| candidate.provider_id == "second")
        .expect("second candidate");
    second.pool_ids = vec!["default".to_string()];
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
            target_kind,
            target_id: None,
            priority: 1,
            weight: 1,
            direct_provider_model: Some(("second".to_string(), "gpt-test".to_string())),
        },
    );
    health
        .store
        .record_provider_cooldown_failure(
            first_provider,
            Some("key1"),
            Some("gpt-test"),
            "preceding tier is cooled",
            20_000,
            100_000,
        )
        .expect("first provider cooldown");

    let controller = V3AdaptiveConcurrencyController::process_shared();
    let first_key = format!("{first_provider}:key1");
    controller
        .ensure_initial_budget(&first_key, 1)
        .expect("first provider concurrency budget");
    let active_business_lease = controller
        .try_acquire_business(&first_key)
        .expect("first provider busy lease");

    let selection = tokio::time::timeout(
        Duration::from_millis(500),
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
    .expect("a busy probe transport must not block later-tier selection");
    let V3TargetSelectionAfterRescue::Selected(selected) = selection else {
        panic!("the available later tier must remain selectable");
    };
    assert_eq!(selected.candidate.provider_id, "second");
    assert!(
        !health
            .store
            .availability(first_provider, Some("key1"), Some("gpt-test"), 20_001)
            .available,
        "skipping a capacity-blocked probe must preserve provider cooldown"
    );
    controller
        .release(active_business_lease.into_permit())
        .expect("release first provider busy lease");
}

#[tokio::test]
async fn busy_preferred_candidate_reselects_later_tier_without_capacity_wait() {
    let server_id = "pinned_busy_candidate_reselect";
    let first_provider = "pinned_busy_first";
    let mut manifest =
        global_pool_alive_manifest_with_provider_names(server_id, None, first_provider, "second");
    manifest
        .providers
        .get_mut(first_provider)
        .expect("first provider")
        .concurrency = Some(routecodex_v3_config::V3ProviderConcurrencyAuthoringConfig {
        max_in_flight: 1,
        acquire_timeout_ms: 60_000,
        stale_lease_ms: 300_000,
    });
    let health = V3ProviderFailureRuntimeHealth::from_manifest(&manifest);
    let scope = test_provider_failure_scope(server_id, server_id, "pinned-busy-session")
        .expect("failure session scope");
    let body = json!({"model":"client-responses","input":"hello"});
    let mut expanded =
        match build_v3_relay_target_candidates(&V3RelayProviderTargetResolutionInput {
            manifest: &manifest,
            server_id,
            failure_session_scope: &scope,
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
        .find(|candidate| candidate.provider_id == first_provider)
        .expect("first candidate");
    first.pool_ids = vec!["client_responses".to_string()];
    let second = expanded
        .candidates
        .iter_mut()
        .find(|candidate| candidate.provider_id == "second")
        .expect("second candidate");
    second.pool_ids = vec!["default".to_string()];
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
            target_kind,
            target_id: None,
            priority: 1,
            weight: 1,
            direct_provider_model: Some(("second".to_string(), "gpt-test".to_string())),
        },
    );
    let preferred = V3TargetInterpreter::default()
        .select_available(expanded.clone(), &health.store, 20_001)
        .expect("first tier selected");
    assert_eq!(preferred.candidate.provider_id, first_provider);

    let controller = V3AdaptiveConcurrencyController::process_shared();
    let first_key = format!("{first_provider}:key1");
    controller
        .ensure_initial_budget(&first_key, 1)
        .expect("first provider concurrency budget");
    let active_business_lease = controller
        .try_acquire_business(&first_key)
        .expect("first provider busy lease");

    let selected = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        select_v3_expanded_target_with_admission_rescue(
            &manifest,
            expanded,
            &scope,
            &health,
            &BTreeSet::new(),
            20_001,
            0,
            false,
            Some(preferred),
        ),
    )
    .await
    .expect("busy preferred admission must not wait for capacity");
    let V3AdmittedTargetSelectionAfterRescue::Selected(selected) = selected else {
        panic!("a full preferred provider must select the available later tier");
    };
    assert_eq!(selected.selected.candidate.provider_id, "second");
    assert_eq!(controller.snapshot(&first_key).unwrap().in_flight, 1);
    assert!(
        health
            .availability(first_provider, Some("key1"), Some("gpt-test"), 20_001)
            .available
    );
    drop(selected);
    controller
        .release(active_business_lease.into_permit())
        .expect("release first provider busy lease");
}

use super::*;
use serde_json::json;
use std::time::Duration;

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
async fn cooldown_only_exhaustion_returns_without_waiting_for_availability_change() {
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
    .expect("cooldown-only exhaustion must return a terminal resolution, not wait");

    assert!(
        matches!(selection, V3TargetSelectionAfterRescue::Exhausted(_)),
        "cooldown-only exhaustion must project explicit exhaustion"
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

use super::*;
use serde_json::json;
use std::time::Duration;

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

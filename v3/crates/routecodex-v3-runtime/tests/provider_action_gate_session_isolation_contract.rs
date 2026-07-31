use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_runtime::{
    V3ProviderActionGate, V3ProviderActionGateKey, V3ProviderActionProviderScope,
};
use std::time::Duration;

fn session(session_id: &str) -> V3ProviderFailureSessionScope {
    V3ProviderFailureSessionScope::new("server-a", "group-a", session_id)
        .expect("valid request data-plane session scope")
}

fn provider_scope(session_id: &str) -> V3ProviderActionProviderScope {
    V3ProviderActionProviderScope::new(&session(session_id), "provider-a:key-a:model-a")
        .expect("session-bound provider action scope")
}

fn key(session_id: &str) -> V3ProviderActionGateKey {
    V3ProviderActionGateKey::new(
        &session(session_id),
        "provider-a:key-a:model-a",
        "provider_http_429",
    )
    .expect("session-bound provider action key")
}

#[test]
fn otherwise_identical_action_lanes_are_distinct_by_real_session() {
    let a = key("session-a");
    let b = key("session-b");
    assert_ne!(a, b);
    assert_eq!(a.provider_scope.session_id, "session-a");
    assert_eq!(b.provider_scope.session_id, "session-b");
    assert_ne!(a.provider_scope.session_id, a.provider_scope.routing_group);
}

#[tokio::test]
async fn session_b_success_does_not_clear_or_release_session_a_lane() {
    let gate = V3ProviderActionGate::default();
    let a_key = key("session-a");
    gate.record_failure(&a_key).expect("record A failure");

    gate.record_provider_success(&provider_scope("session-b"))
        .expect("record B success");

    let b = tokio::time::timeout(
        Duration::from_millis(100),
        gate.wait_for_exact_provider_action(&provider_scope("session-b")),
    )
    .await
    .expect("B lookup must not wait")
    .expect("B lookup")
    .is_none();
    assert!(b, "B must have no active A-owned lane");

    assert!(
        tokio::time::timeout(
            Duration::from_millis(100),
            gate.wait_for_exact_provider_action(&provider_scope("session-a")),
        )
        .await
        .is_err(),
        "A lane must remain active after B success"
    );
}

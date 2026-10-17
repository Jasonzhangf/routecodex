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
fn identical_provider_identity_shares_lane_across_real_sessions() {
    let a = key("session-a");
    let b = key("session-b");
    assert_eq!(a, b);
    assert_eq!(a.provider_scope.session_id, "session-a");
    assert_eq!(b.provider_scope.session_id, "session-b");
    assert_ne!(a.provider_scope.session_id, a.provider_scope.routing_group);
}

#[tokio::test]
async fn different_listener_ports_do_not_share_failure_or_success() {
    let gate = V3ProviderActionGate::default();
    let server_a = V3ProviderFailureSessionScope::new("listener-4444", "default", "a").unwrap();
    let server_b = V3ProviderFailureSessionScope::new("listener-7777", "default", "b").unwrap();
    let key_a = V3ProviderActionGateKey::new(&server_a, "provider:key:model", "http429").unwrap();
    let key_b = V3ProviderActionGateKey::new(&server_b, "provider:key:model", "http429").unwrap();
    assert_ne!(
        key_a, key_b,
        "each listener must own its provider failure lane"
    );
    let scope_a = V3ProviderActionProviderScope::new(&server_a, "provider:key:model").unwrap();
    let scope_b = V3ProviderActionProviderScope::new(&server_b, "provider:key:model").unwrap();
    gate.record_failure(&key_a).unwrap();
    assert!(tokio::time::timeout(
        Duration::from_millis(100),
        gate.wait_for_exact_provider_action(&scope_b)
    )
    .await
    .expect("4444 failure cannot delay7777")
    .unwrap()
    .is_none());
    gate.record_provider_success(&scope_b).unwrap();
    assert!(
        tokio::time::timeout(
            Duration::from_millis(100),
            gate.wait_for_exact_provider_action(&scope_a)
        )
        .await
        .is_err(),
        "7777 success cannot release4444 backoff"
    );
}

#[tokio::test]
async fn real_success_from_another_session_clears_same_identity() {
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
    assert!(b, "real success must clear shared identity delay");

    assert!(
        tokio::time::timeout(
            Duration::from_millis(100),
            gate.wait_for_exact_provider_action(&provider_scope("session-a")),
        )
        .await
        .unwrap()
        .unwrap()
        .is_none(),
        "success must reset the identity in every session"
    );
}

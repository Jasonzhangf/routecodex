use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_runtime::{
    V3ProviderActionGate, V3ProviderActionGateKey, V3ProviderActionProviderScope,
    V3ProviderActionRecoveryTransition,
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
        "provider_transport_error",
    )
    .expect("session-bound provider action key")
}

#[test]
fn non429_failure_does_not_escalate_another_identity_in_the_same_session() {
    for other in [
        "provider-a:default:key-b:model-a",
        "provider-a:default:key-a:model-b",
        "provider-a:alternate:key-a:model-a",
        "provider-b:default:key-a:model-a",
    ] {
        let gate = V3ProviderActionGate::default();
        let original = V3ProviderActionGateKey::new(
            &session("same-live-session"), "provider-a:default:key-a:model-a", "provider_transport_error",
        ).unwrap();
        let independent = V3ProviderActionGateKey::new(
            &session("same-live-session"), other, "provider_transport_error",
        ).unwrap();
        assert_eq!(gate.record_failure(&original).unwrap().minimum_delay_ms, 1000);
        assert_eq!(gate.record_failure(&independent).unwrap().minimum_delay_ms, 1000,
            "another complete identity must keep its independent first-failure delay: {other}");
    }
}

#[test]
fn rate_limit_backoff_is_independent_for_other_auth_keys() {
    let gate = V3ProviderActionGate::default();
    let first = V3ProviderActionGateKey::new(
        &session("session-a"),
        "provider-a:key-a:model-a",
        "provider_http_429",
    )
    .unwrap();
    let second = V3ProviderActionGateKey::new(
        &session("session-b"),
        "provider-a:key-b:model-a",
        "provider_http_429",
    )
    .unwrap();
    assert_eq!(gate.record_failure(&first).unwrap().minimum_delay_ms, 1000);
    assert_eq!(
        gate.record_failure(&second).unwrap().minimum_delay_ms,
        1000,
        "another auth key must retain its independent first-failure backoff"
    );
}

#[tokio::test]
async fn admitted_identity_cannot_occupy_another_identity_in_the_same_session() {
    let gate = V3ProviderActionGate::default();
    let a = V3ProviderActionGateKey::new(&session("shared-session"), "a:default:k:m", "provider_transport_error").unwrap();
    let b = V3ProviderActionGateKey::new(&session("shared-session"), "b:default:k:m", "provider_transport_error").unwrap();
    let first = gate.record_failure(&a).unwrap();
    let second = gate.record_failure(&b).unwrap();
    let held = gate.wait_for_recovery_ticket(first.recovery_ticket(), a.provider_scope.clone()).await.unwrap();
    assert!(matches!(held, V3ProviderActionRecoveryTransition::Admitted(_)));
    let independent = tokio::time::timeout(Duration::from_millis(500),
        gate.wait_for_recovery_ticket(second.recovery_ticket(), b.provider_scope.clone()),
    ).await.expect("B's due action cannot wait for A's active permit").unwrap();
    assert!(matches!(independent, V3ProviderActionRecoveryTransition::Admitted(_)), "B remains current: {independent:?}");
    drop(held);
}

#[tokio::test]
async fn terminal_identity_cannot_supersede_another_identity_in_the_same_session() {
    let gate = V3ProviderActionGate::default();
    let a = V3ProviderActionGateKey::new(&session("shared-session"), "a:default:k:m", "provider_transport_error").unwrap();
    let b = V3ProviderActionGateKey::new(&session("shared-session"), "b:default:k:m", "provider_transport_error").unwrap();
    let first = gate.record_failure(&a).unwrap();
    let second = gate.record_failure(&b).unwrap();
    let held = gate.wait_for_recovery_ticket(first.recovery_ticket(), a.provider_scope.clone()).await.unwrap();
    let V3ProviderActionRecoveryTransition::Admitted(admission) = &held else { panic!("A admitted"); };
    assert!(gate.commit_terminal_admission(&a, admission).unwrap());
    let independent = tokio::time::timeout(Duration::from_millis(500),
        gate.wait_for_recovery_ticket(second.recovery_ticket(), b.provider_scope.clone()),
    ).await.expect("A's terminal cannot re-time B").unwrap();
    assert!(matches!(independent, V3ProviderActionRecoveryTransition::Admitted(_)),
        "A's terminal cannot supersede B's current generation: {independent:?}");
}

#[tokio::test]
async fn rate_limit_lane_and_success_release_are_shared_across_sessions() {
    let gate = V3ProviderActionGate::default();
    let a = V3ProviderActionGateKey::new(
        &session("session-a"),
        "provider-a:key-a:model-a",
        "provider_http_429",
    )
    .unwrap();
    let b = V3ProviderActionGateKey::new(
        &session("session-b"),
        "provider-a:key-a:model-a",
        "provider_http_429",
    )
    .unwrap();
    assert_eq!(a, b);
    let failure = gate.record_failure(&a).unwrap();
    assert_eq!(failure.minimum_delay_ms, 1_000);
    let ticket = failure.recovery_ticket().clone();
    let pending = {
        let gate = gate.clone();
        let ticket = ticket.clone();
        let action_scope = b.provider_scope.clone();
        tokio::spawn(async move { gate.wait_for_recovery_ticket(&ticket, action_scope).await })
    };
    tokio::time::sleep(Duration::from_millis(25)).await;
    assert!(
        !pending.is_finished(),
        "another session did not share the exact rate-limit lane"
    );
    gate.record_provider_success(&b.provider_scope).unwrap();
    let transition = tokio::time::timeout(Duration::from_millis(100), pending)
        .await
        .expect("shared rate-limit success release")
        .expect("rate-limit waiter task")
        .expect("rate-limit transition");
    assert!(matches!(
        transition,
        V3ProviderActionRecoveryTransition::Consumed(released) if released == ticket
    ));
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
    let b_key = key("session-b");
    let a_failure = gate.record_failure(&a_key).expect("record A failure");
    let a_ticket = a_failure.recovery_ticket().clone();

    gate.record_provider_success(&provider_scope("session-b"))
        .expect("record B success");

    assert_eq!(
        gate.active_waiters(&b_key)
            .expect("read B exact-lane waiter count"),
        0,
        "B must not be registered in A's active lane"
    );

    let transition = tokio::time::timeout(
        Duration::from_millis(1_500),
        gate.wait_for_recovery_ticket(&a_ticket, a_key.provider_scope.clone()),
    )
    .await
    .expect("A lane must remain active after B success")
    .expect("A recovery transition");
    let V3ProviderActionRecoveryTransition::Admitted(admission) = transition else {
        panic!("B success changed A's recovery transition: {transition:?}");
    };
    assert_eq!(admission.generation, a_ticket.generation());
    drop(admission);
}

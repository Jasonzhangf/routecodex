use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_runtime::{
    V3ProviderActionGate, V3ProviderActionGateKey, V3ProviderActionGateMode,
    V3ProviderActionProviderScope, V3ProviderActionRecoveryTransition,
    V3_PROVIDER_ACTION_ISOLATED_DELAY_MS, V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS,
};
use std::time::{Duration, Instant};

fn key(error_family: &str) -> V3ProviderActionGateKey {
    scoped_key(
        "server-a",
        "group-a",
        "provider-a:key-a:model-a",
        error_family,
    )
}

fn session_scope(server_id: &str, routing_group: &str) -> V3ProviderFailureSessionScope {
    V3ProviderFailureSessionScope::new(
        server_id,
        routing_group,
        format!("{server_id}:{routing_group}:session"),
    )
    .expect("valid provider failure session scope")
}

fn scoped_key(
    server_id: &str,
    routing_group: &str,
    provider: &str,
    error_family: &str,
) -> V3ProviderActionGateKey {
    V3ProviderActionGateKey::new(
        &session_scope(server_id, routing_group),
        provider,
        error_family,
    )
    .expect("valid action gate key")
}

fn scoped_provider_scope(
    server_id: &str,
    routing_group: &str,
    provider: &str,
) -> V3ProviderActionProviderScope {
    V3ProviderActionProviderScope::new(&session_scope(server_id, routing_group), provider)
        .expect("valid provider action scope")
}

fn provider_scope(provider: &str) -> V3ProviderActionProviderScope {
    scoped_provider_scope("server-a", "group-a", provider)
}

#[tokio::test]
async fn isolated_failure_blocks_one_action_for_at_least_one_second() {
    assert_eq!(V3_PROVIDER_ACTION_ISOLATED_DELAY_MS, 1_000);
    assert_eq!(V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS, 5_000);

    let gate = V3ProviderActionGate::default();
    let started = Instant::now();
    let admission = gate
        .record_failure_and_wait(key("provider_transport"))
        .await
        .expect("isolated failure admission");

    assert_eq!(admission.mode, V3ProviderActionGateMode::Isolated);
    assert!(admission.generation >= 1);
    assert!(
        started.elapsed() >= Duration::from_millis(V3_PROVIDER_ACTION_ISOLATED_DELAY_MS),
        "isolated provider action was admitted before the one-second floor"
    );
}

#[tokio::test]
async fn isolated_terminal_projection_waits_for_the_same_one_second_gate() {
    let gate = V3ProviderActionGate::default();
    let started = Instant::now();
    let admission = gate
        .record_failure_and_wait_for_terminal_projection(key("provider_http_401"))
        .await
        .expect("isolated terminal projection admission");

    assert_eq!(admission.mode, V3ProviderActionGateMode::Isolated);
    assert!(
        started.elapsed() >= Duration::from_millis(V3_PROVIDER_ACTION_ISOLATED_DELAY_MS),
        "terminal Error06 projection bypassed the one-second provider failure floor"
    );
}

#[tokio::test]
async fn unrelated_success_cannot_release_a_stale_terminal_projection() {
    let gate = V3ProviderActionGate::default();
    let scope = key("provider_http_401");
    let pending = {
        let gate = gate.clone();
        let scope = scope.clone();
        tokio::spawn(async move {
            gate.record_failure_and_wait_for_terminal_projection(scope)
                .await
        })
    };

    tokio::time::sleep(Duration::from_millis(25)).await;
    gate.record_success(&scope)
        .expect("unrelated success resets active lane");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        !pending.is_finished(),
        "routing-group success released a stale provider error directly to Error06"
    );

    let admission = pending
        .await
        .expect("terminal projection waiter task")
        .expect("terminal projection admission");
    assert!(!admission.released_by_success);
    assert_eq!(admission.mode, V3ProviderActionGateMode::Isolated);
}

#[tokio::test]
async fn success_after_terminal_admission_invalidates_atomic_commit() {
    let gate = V3ProviderActionGate::default();
    let scope = key("provider_http_401");
    gate.record_failure(&scope)
        .expect("record terminal failure");
    let admission = gate
        .wait_for_active_failure(scope.clone())
        .await
        .expect("terminal admission");

    gate.record_success(&scope)
        .expect("success races after terminal admission");

    assert!(
        !gate
            .commit_terminal_admission(&scope, &admission)
            .expect("atomic terminal commit"),
        "a success that won after admission must invalidate stale Error06 projection"
    );
}

#[tokio::test]
async fn overlapping_waiter_promotes_scope_to_five_seconds_and_one_admission() {
    let gate = V3ProviderActionGate::default();
    let scope = key("provider_transport");
    let started = Instant::now();

    let mut first = {
        let gate = gate.clone();
        let scope = scope.clone();
        tokio::spawn(async move { gate.record_failure_and_wait(scope).await })
    };
    tokio::time::sleep(Duration::from_millis(25)).await;
    let mut second = {
        let gate = gate.clone();
        let scope = scope.clone();
        tokio::spawn(async move { gate.wait_for_active_failure(scope).await })
    };

    let (admission, first_won) = tokio::select! {
        result = &mut first => (result.expect("first waiter task").expect("first sustained admission"), true),
        result = &mut second => (result.expect("second waiter task").expect("second sustained admission"), false),
    };
    assert_eq!(admission.mode, V3ProviderActionGateMode::Sustained);
    assert!(
        started.elapsed() >= Duration::from_millis(V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS),
        "overlapping provider actions were admitted before the five-second floor"
    );
    assert!(
        if first_won {
            !second.is_finished()
        } else {
            !first.is_finished()
        },
        "one gate generation admitted more than one provider action"
    );

    gate.record_success(&scope).expect("success reset");
    let released = if first_won {
        second
            .await
            .expect("second waiter task")
            .expect("second waiter release")
    } else {
        first
            .await
            .expect("first waiter task")
            .expect("first waiter release")
    };
    assert!(released.released_by_success);
    assert_eq!(gate.active_waiters(&scope).expect("waiter count"), 0);
}

#[tokio::test]
async fn scopes_are_isolated_and_success_does_not_reset_other_error_family() {
    let gate = V3ProviderActionGate::default();
    let transport = key("provider_transport");
    let malformed = key("provider_malformed_sse");

    let transport_waiter = {
        let gate = gate.clone();
        let scope = transport.clone();
        tokio::spawn(async move { gate.record_failure_and_wait(scope).await })
    };
    let malformed_waiter = {
        let gate = gate.clone();
        let scope = malformed.clone();
        tokio::spawn(async move { gate.record_failure_and_wait(scope).await })
    };

    tokio::time::sleep(Duration::from_millis(25)).await;
    gate.record_success(&transport)
        .expect("transport success reset");
    let released = transport_waiter
        .await
        .expect("transport waiter task")
        .expect("transport waiter release");
    assert!(released.released_by_success);
    assert!(
        !malformed_waiter.is_finished(),
        "success for one error family reset a distinct scoped gate"
    );

    malformed_waiter.abort();
    let _ = malformed_waiter.await;
    tokio::time::sleep(Duration::from_millis(10)).await;
    assert_eq!(gate.active_waiters(&malformed).expect("waiter count"), 0);
}

#[tokio::test]
async fn reselected_provider_action_consumes_failed_scope_gate_and_success_releases_waiters() {
    let gate = V3ProviderActionGate::default();
    let failed = key("provider_http_500");
    gate.record_failure(&failed).expect("record failure");

    let started = Instant::now();
    let admission = gate
        .wait_for_provider_action(&provider_scope("provider-b:key-b:model-b"))
        .await
        .expect("wait for reselected action")
        .expect("active routing-group gate");
    assert_eq!(admission.mode, V3ProviderActionGateMode::Isolated);
    assert!(
        started.elapsed() >= Duration::from_millis(V3_PROVIDER_ACTION_ISOLATED_DELAY_MS),
        "reselected provider action bypassed the failed provider gate"
    );

    let blocked = {
        let gate = gate.clone();
        tokio::spawn(async move {
            gate.wait_for_provider_action(&provider_scope("provider-a:key-a:model-a"))
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(25)).await;
    assert!(
        !blocked.is_finished(),
        "one admission released another provider action in the same generation"
    );

    gate.record_provider_success(&provider_scope("provider-b:key-b:model-b"))
        .expect("reselected provider success reset");
    let released = blocked
        .await
        .expect("blocked waiter task")
        .expect("blocked waiter result")
        .expect("released admission");
    assert!(released.released_by_success);

    let next_started = Instant::now();
    let next = gate
        .wait_for_provider_action(&provider_scope("provider-a:key-a:model-a"))
        .await
        .expect("next action wait")
        .expect("retained sustained lane");
    assert_eq!(next.mode, V3ProviderActionGateMode::Sustained);
    assert!(
        next_started.elapsed() >= Duration::from_millis(V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS),
        "provider success with queued requests must not broadcast stale actions"
    );
    gate.record_provider_success(&provider_scope("provider-a:key-a:model-a"))
        .expect("retained lane cleanup");
}

#[tokio::test]
async fn unrelated_same_group_provider_success_cannot_release_an_owned_action_permit() {
    let gate = V3ProviderActionGate::default();
    let failed = key("provider_http_500");
    gate.record_failure(&failed)
        .expect("record provider A failure");
    let admission = gate
        .wait_for_active_failure(failed)
        .await
        .expect("provider A recovery admission");

    gate.record_provider_success(&provider_scope("provider-c:key-c:model-c"))
        .expect("unrelated provider C success");

    let provider_a = provider_scope("provider-a:key-a:model-a");
    let still_owned = tokio::time::timeout(
        Duration::from_millis(100),
        gate.wait_for_exact_provider_action(&provider_a),
    )
    .await;
    assert!(
        still_owned.is_err(),
        "unrelated same-group provider success released provider A's owned recovery permit"
    );

    drop(admission);
}

#[tokio::test]
async fn exact_provider_lookup_ignores_another_provider_recovery_lane() {
    let gate = V3ProviderActionGate::default();
    let provider_b_failure = scoped_key(
        "server-exact",
        "group-exact",
        "provider-b:key-b:model-b",
        "provider_http_503",
    );
    gate.record_failure(&provider_b_failure)
        .expect("record provider B failure");

    let provider_a =
        scoped_provider_scope("server-exact", "group-exact", "provider-a:key-a:model-a");
    let exact = tokio::time::timeout(
        Duration::from_millis(100),
        gate.wait_for_exact_provider_action(&provider_a),
    )
    .await
    .expect("exact provider lookup must not wait on another provider")
    .expect("exact provider lookup");
    assert!(
        exact.is_none(),
        "pinned provider A consumed provider B's recovery lane"
    );

    gate.record_success(&provider_b_failure)
        .expect("cleanup provider B failure");
}

#[tokio::test]
async fn second_failure_before_success_promotes_and_extends_the_sustained_deadline() {
    let gate = V3ProviderActionGate::default();
    let scope = key("provider_http_500");
    gate.record_failure(&scope).expect("first failure");

    tokio::time::sleep(Duration::from_millis(100)).await;
    let second_failure_at = Instant::now();
    let recorded = gate.record_failure(&scope).expect("second failure");
    assert_eq!(recorded.generation, 2);
    assert_eq!(recorded.mode, V3ProviderActionGateMode::Sustained);

    tokio::time::sleep(Duration::from_millis(100)).await;
    let final_failure_at = Instant::now();
    let extended = gate.record_failure(&scope).expect("sustained failure");
    assert_eq!(extended.generation, 3);
    assert_eq!(extended.mode, V3ProviderActionGateMode::Sustained);

    let admission = gate
        .wait_for_active_failure(scope)
        .await
        .expect("sustained admission");
    assert_eq!(admission.generation, 3);
    assert_eq!(admission.mode, V3ProviderActionGateMode::Sustained);
    assert!(
        second_failure_at.elapsed()
            >= Duration::from_millis(V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS + 100),
        "additional sustained failure did not advance the original five-second deadline"
    );
    assert!(
        final_failure_at.elapsed() >= Duration::from_millis(V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS),
        "provider action was admitted before five seconds from the latest failure"
    );
}

#[tokio::test]
async fn exact_gate_keys_isolate_server_group_provider_and_error_family_state() {
    let gate = V3ProviderActionGate::default();
    let base = key("provider_transport");
    let other_server = scoped_key(
        "server-b",
        "group-a",
        "provider-a:key-a:model-a",
        "provider_transport",
    );
    let other_group = scoped_key(
        "server-a",
        "group-b",
        "provider-a:key-a:model-a",
        "provider_transport",
    );
    let other_provider = scoped_key(
        "server-a",
        "group-a",
        "provider-b:key-b:model-b",
        "provider_transport",
    );
    let other_family = key("provider_malformed_sse");

    for scope in [
        base.clone(),
        other_server.clone(),
        other_group.clone(),
        other_provider.clone(),
        other_family.clone(),
    ] {
        gate.record_failure(&scope).expect("record scoped failure");
    }

    let waiters = [
        other_server.clone(),
        other_group.clone(),
        other_provider.clone(),
        other_family.clone(),
    ]
    .into_iter()
    .map(|scope| {
        let gate = gate.clone();
        tokio::spawn(async move { gate.wait_for_active_failure(scope).await })
    })
    .collect::<Vec<_>>();

    tokio::time::sleep(Duration::from_millis(25)).await;
    gate.record_success(&base).expect("reset base key");
    assert_eq!(gate.active_waiters(&base).expect("base waiter count"), 0);
    for waiter in &waiters {
        assert!(
            !waiter.is_finished(),
            "resetting one exact gate key released a distinct scope"
        );
    }

    for scope in [other_server, other_group, other_provider, other_family] {
        gate.record_success(&scope).expect("reset distinct key");
    }
    for waiter in waiters {
        assert!(
            waiter
                .await
                .expect("waiter task")
                .expect("waiter release")
                .released_by_success
        );
    }
}

#[tokio::test]
async fn process_shared_handles_observe_the_same_cross_request_generation() {
    let first_request_gate = V3ProviderActionGate::process_shared();
    let second_request_gate = V3ProviderActionGate::process_shared();
    let scope = scoped_key(
        "shared-server",
        "shared-group",
        "shared-provider:key:model",
        "provider_http_503",
    );

    first_request_gate
        .record_failure(&scope)
        .expect("first request records provider failure");
    assert_eq!(
        second_request_gate
            .active_waiters(&scope)
            .expect("second request reads shared gate"),
        0
    );

    let started = Instant::now();
    let admission = second_request_gate
        .wait_for_active_failure(scope.clone())
        .await
        .expect("second request waits on shared failure");
    assert_eq!(admission.generation, 1);
    assert!(
        started.elapsed() >= Duration::from_millis(V3_PROVIDER_ACTION_ISOLATED_DELAY_MS),
        "a new runtime request bypassed the process-shared provider action gate"
    );

    first_request_gate
        .record_success(&scope)
        .expect("shared test cleanup");
}

#[tokio::test]
async fn terminal_transition_wakes_old_waiter_for_reselection_then_serializes_next_generation() {
    let gate = V3ProviderActionGate::default();
    let scope = key("provider_http_503");
    gate.record_failure(&scope).expect("record first failure");

    let mut first = {
        let gate = gate.clone();
        let scope = scope.clone();
        tokio::spawn(async move { gate.wait_for_active_failure(scope).await })
    };
    tokio::time::sleep(Duration::from_millis(25)).await;
    let mut second = {
        let gate = gate.clone();
        let scope = scope.clone();
        tokio::spawn(async move { gate.wait_for_active_failure(scope).await })
    };

    let (admitted, first_won) = tokio::select! {
        result = &mut first => (result.expect("first action task").expect("first action admission"), true),
        result = &mut second => (result.expect("second action task").expect("second action admission"), false),
    };
    assert_eq!(admitted.mode, V3ProviderActionGateMode::Sustained);
    assert!(if first_won {
        !second.is_finished()
    } else {
        !first.is_finished()
    });

    assert!(
        gate.commit_terminal_admission(&scope, &admitted)
            .expect("terminal transition"),
        "admitted generation must commit atomically"
    );
    let reevaluate = if first_won {
        second
            .await
            .expect("second action task")
            .expect("terminal reevaluation")
    } else {
        first
            .await
            .expect("first action task")
            .expect("terminal reevaluation")
    };
    assert!(reevaluate.reevaluate_after_terminal);
    assert!(!reevaluate.released_by_success);

    let next_generation_started = Instant::now();
    let next = gate
        .wait_for_active_failure(scope.clone())
        .await
        .expect("next generation admission");
    assert_eq!(next.generation, admitted.generation + 1);
    assert_eq!(next.mode, V3ProviderActionGateMode::Sustained);
    assert!(!next.reevaluate_after_terminal);
    assert!(
        next_generation_started.elapsed()
            >= Duration::from_millis(V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS),
        "terminal transition admitted the next provider action before five seconds"
    );

    gate.record_success(&scope).expect("terminal test cleanup");
}

#[tokio::test]
async fn changing_provider_and_error_family_cannot_restart_an_active_lane_at_one_second() {
    let gate = V3ProviderActionGate::default();
    let first = scoped_key(
        "storm-server",
        "storm-group",
        "provider-a:key:model-a",
        "provider_http_500",
    );
    let changed = scoped_key(
        "storm-server",
        "storm-group",
        "provider-b:key:model-b",
        "provider_malformed_sse",
    );
    gate.record_failure(&first).expect("first lane failure");

    let changed_at = Instant::now();
    let recorded = gate
        .record_failure(&changed)
        .expect("changed provider/family failure");
    assert_eq!(recorded.mode, V3ProviderActionGateMode::Sustained);
    let admission = gate
        .wait_for_active_failure(changed.clone())
        .await
        .expect("changed failure admission");
    assert_eq!(admission.mode, V3ProviderActionGateMode::Sustained);
    assert!(
        changed_at.elapsed() >= Duration::from_millis(V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS),
        "changing provider or error family restarted an active storm lane at one second"
    );

    gate.record_provider_success(&scoped_provider_scope(
        "storm-server",
        "storm-group",
        "provider-b:key:model-b",
    ))
    .expect("storm lane cleanup");
}

#[tokio::test]
async fn changed_provider_lanes_admit_one_action_per_routing_group_interval() {
    let gate = V3ProviderActionGate::default();
    let first = scoped_key(
        "server-serial",
        "group-serial",
        "provider-a:key:model",
        "provider_http_503",
    );
    let second = scoped_key(
        "server-serial",
        "group-serial",
        "provider-b:key:model",
        "provider_http_429",
    );
    gate.record_failure(&first).expect("first provider failure");
    gate.record_failure(&second)
        .expect("second provider failure");

    let first_admission = gate
        .wait_for_active_failure(first)
        .await
        .expect("first group admission");
    assert_eq!(first_admission.mode, V3ProviderActionGateMode::Sustained);

    let second_started = Instant::now();
    drop(first_admission);
    let second_admission = gate
        .wait_for_active_failure(second)
        .await
        .expect("second group admission");
    assert_eq!(second_admission.mode, V3ProviderActionGateMode::Sustained);
    assert!(
        second_started.elapsed() >= Duration::from_millis(V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS),
        "provider/error-family change admitted a second routing-group action without five seconds"
    );
}

#[tokio::test]
async fn admitted_action_failure_advances_the_group_before_reselecting() {
    let gate = V3ProviderActionGate::default();
    let terminal = scoped_key(
        "server-outcome",
        "group-outcome",
        "provider-a:key:model",
        "provider_http_429",
    );
    gate.record_failure_and_wait_for_terminal_projection(terminal.clone())
        .await
        .expect("terminal projection admission");

    let primary = scoped_provider_scope("server-outcome", "group-outcome", "provider-a:key:model");
    gate.wait_for_provider_action(&primary)
        .await
        .expect("next request admission")
        .expect("retained terminal lane");

    let next_failure = scoped_key(
        "server-outcome",
        "group-outcome",
        "provider-a:key:model",
        "provider_http_500",
    );
    gate.record_failure(&next_failure)
        .expect("admitted provider action failure");

    let reselected = tokio::time::timeout(
        Duration::from_millis(V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS + 500),
        gate.wait_for_active_failure(terminal),
    )
    .await
    .expect("stale admitted generation blocked the reselected provider")
    .expect("reselected provider admission");
    assert_eq!(reselected.mode, V3ProviderActionGateMode::Sustained);
}

#[tokio::test]
async fn admitted_action_requires_explicit_drop_before_replacement_generation() {
    let gate = V3ProviderActionGate::default();
    let scope = key("provider_http_429");
    gate.record_failure(&scope)
        .expect("record provider failure");
    let admitted = gate
        .wait_for_active_failure(scope.clone())
        .await
        .expect("first provider action admission");

    let competing_scope = scoped_key(
        "server-a",
        "group-a",
        "provider-b:key-b:model-b",
        "provider_http_503",
    );
    let competing_failure = gate
        .record_failure(&competing_scope)
        .expect("record concurrent provider failure");
    assert_eq!(competing_failure.mode, V3ProviderActionGateMode::Sustained);

    let mut next = {
        let gate = gate.clone();
        let scope = competing_scope.clone();
        tokio::spawn(async move { gate.wait_for_active_failure(scope).await })
    };
    tokio::time::sleep(Duration::from_millis(
        V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS + 100,
    ))
    .await;
    assert!(
        !next.is_finished(),
        "elapsed time alone released a provider action whose permit is still owned"
    );

    let next_started = Instant::now();
    drop(admitted);
    let next = tokio::time::timeout(
        Duration::from_millis(V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS + 500),
        &mut next,
    )
    .await
    .expect("explicit permit drop did not start a replacement generation")
    .expect("replacement provider action task")
    .expect("replacement provider action admission");

    assert_eq!(next.mode, V3ProviderActionGateMode::Sustained);
    assert!(
        next_started.elapsed() >= Duration::from_millis(V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS),
        "explicit abandon did not enforce a full five-second sustained floor"
    );
}

#[tokio::test]
async fn fifo_waiter_cancellation_removes_only_its_ticket() {
    let gate = V3ProviderActionGate::default();
    let scope = key("provider_http_503");
    gate.record_failure(&scope)
        .expect("record provider failure");

    let first = {
        let gate = gate.clone();
        let scope = scope.clone();
        tokio::spawn(async move { gate.wait_for_active_failure(scope).await })
    };
    tokio::time::sleep(Duration::from_millis(25)).await;
    let cancelled = {
        let gate = gate.clone();
        let scope = scope.clone();
        tokio::spawn(async move { gate.wait_for_active_failure(scope).await })
    };
    tokio::time::sleep(Duration::from_millis(25)).await;
    let third = {
        let gate = gate.clone();
        let scope = scope.clone();
        tokio::spawn(async move { gate.wait_for_active_failure(scope).await })
    };
    cancelled.abort();
    let _ = cancelled.await;

    let first_admission = first
        .await
        .expect("first waiter task")
        .expect("first waiter admission");
    assert!(
        !third.is_finished(),
        "a later FIFO waiter bypassed the first ticket"
    );
    drop(first_admission);

    let third_admission = tokio::time::timeout(
        Duration::from_millis(V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS + 500),
        third,
    )
    .await
    .expect("third waiter remained blocked after the first permit was dropped")
    .expect("third waiter task")
    .expect("third waiter admission");
    assert_eq!(third_admission.mode, V3ProviderActionGateMode::Sustained);
    assert_eq!(gate.active_waiters(&scope).expect("waiter count"), 0);
}

#[tokio::test]
async fn recovery_ticket_consumes_its_exact_failure_key_not_the_latest_group_lane() {
    let gate = V3ProviderActionGate::default();
    let failed_a = scoped_key(
        "ticket-server",
        "ticket-group",
        "provider-a:key:model",
        "provider_http_500",
    );
    let failed_b = scoped_key(
        "ticket-server",
        "ticket-group",
        "provider-b:key:model",
        "provider_malformed_sse",
    );
    let recorded_a = gate.record_failure(&failed_a).expect("provider A failure");
    let ticket_a = recorded_a.recovery_ticket().clone();
    gate.record_failure(&failed_b).expect("provider B failure");

    let action_scope =
        scoped_provider_scope("ticket-server", "ticket-group", "provider-c:key:model");
    let transition = gate
        .wait_for_recovery_ticket(&ticket_a, action_scope)
        .await
        .expect("exact recovery ticket transition");
    let V3ProviderActionRecoveryTransition::Admitted(admission) = transition else {
        panic!("unrelated provider/error-family lane replaced the exact recovery ticket");
    };
    assert_eq!(admission.generation, ticket_a.generation());

    drop(admission);
    gate.record_success(&failed_b)
        .expect("cleanup unrelated provider B lane");
}

#[tokio::test]
async fn superseded_same_key_generation_returns_typed_transition() {
    let gate = V3ProviderActionGate::default();
    let failed = scoped_key(
        "superseded-server",
        "superseded-group",
        "provider-a:key:model",
        "provider_http_503",
    );
    let first = gate.record_failure(&failed).expect("first failure");
    let first_ticket = first.recovery_ticket().clone();
    let second = gate
        .record_failure(&failed)
        .expect("newer same-key failure");

    let action_scope = scoped_provider_scope(
        "superseded-server",
        "superseded-group",
        "provider-b:key:model",
    );
    let transition = gate
        .wait_for_recovery_ticket(&first_ticket, action_scope)
        .await
        .expect("typed superseded transition");
    let V3ProviderActionRecoveryTransition::Superseded(current) = transition else {
        panic!("superseded recovery generation was silently admitted or redirected");
    };
    assert_eq!(current.generation(), second.generation);
    assert_eq!(current.key(), &failed);

    gate.record_success(&failed)
        .expect("cleanup superseded failure lane");
}

#[tokio::test]
async fn success_released_recovery_reenters_the_retained_five_second_generation() {
    let gate = V3ProviderActionGate::default();
    let failed = scoped_key(
        "success-release-server",
        "success-release-group",
        "provider-a:key:model",
        "provider_http_429",
    );
    let first = gate.record_failure(&failed).expect("first failure");
    let first_ticket = first.recovery_ticket().clone();
    let action_scope = scoped_provider_scope(
        "success-release-server",
        "success-release-group",
        "provider-b:key:model",
    );

    let pending = {
        let gate = gate.clone();
        let ticket = first_ticket.clone();
        let action_scope = action_scope.clone();
        tokio::spawn(async move { gate.wait_for_recovery_ticket(&ticket, action_scope).await })
    };
    tokio::time::sleep(Duration::from_millis(25)).await;
    gate.record_success(&failed)
        .expect("provider success retains queued recovery lane");

    let transition = pending
        .await
        .expect("released recovery task")
        .expect("released recovery transition");
    let V3ProviderActionRecoveryTransition::ReleasedBySuccess(refreshed) = transition else {
        panic!("provider success must return the retained recovery generation");
    };
    assert_eq!(refreshed.key(), &failed);
    assert_eq!(refreshed.generation(), first_ticket.generation() + 1);

    let sustained_started = Instant::now();
    let transition = gate
        .wait_for_recovery_ticket(&refreshed, action_scope)
        .await
        .expect("retained recovery wait");
    let V3ProviderActionRecoveryTransition::Admitted(admission) = transition else {
        panic!("retained recovery generation must admit exactly one provider action");
    };
    assert_eq!(admission.mode, V3ProviderActionGateMode::Sustained);
    assert!(
        sustained_started.elapsed() >= Duration::from_millis(V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS),
        "provider success released a queued recovery directly into transport"
    );
}

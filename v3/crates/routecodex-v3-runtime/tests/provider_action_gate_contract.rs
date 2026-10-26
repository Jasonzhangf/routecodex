use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_runtime::{
    V3ProviderActionGate, V3ProviderActionGateKey, V3ProviderActionGateMode,
    V3ProviderActionProviderScope, V3ProviderActionRecoveryTransition,
    V3_PROVIDER_ACTION_ISOLATED_DELAY_MS, V3_PROVIDER_ACTION_MEDIUM_DELAY_MS,
    V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS,
};
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};

fn key(error_family: &str) -> V3ProviderActionGateKey {
    scoped_key(
        "server-a",
        "group-a",
        "provider-a:key-a:model-a",
        error_family,
    )
}

#[test]
fn configured_backoff_is_a_minimum_for_provider_action_admission() {
    let gate = V3ProviderActionGate::default();
    let recorded = gate
        .record_failure_with_minimum_delay(&key("configured_backoff"), 7_000)
        .expect("record configured backoff");
    assert_eq!(recorded.minimum_delay_ms, 7_000);
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
async fn isolated_terminal_projection_commits_without_waiting_for_provider_action_admission() {
    let gate = V3ProviderActionGate::default();
    let started = Instant::now();
    let admission = gate
        .record_failure_and_commit_terminal_projection(key("provider_http_401"))
        .expect("isolated terminal projection admission");

    assert_eq!(admission.mode, V3ProviderActionGateMode::Isolated);
    assert!(
        started.elapsed() < Duration::from_millis(100),
        "terminal Error06 projection must not wait for a provider action that will not run"
    );
}

#[tokio::test]
async fn terminal_projection_does_not_revoke_an_active_sibling_action_permit() {
    let gate = V3ProviderActionGate::default();
    let active_key = scoped_key(
        "server-a",
        "group-a",
        "provider-a:key-a:model-a",
        "provider_transport",
    );
    let active_failure = gate
        .record_failure(&active_key)
        .expect("record active action failure");
    let active = match gate
        .wait_for_recovery_ticket(
            active_failure.recovery_ticket(),
            active_key.provider_scope.clone(),
        )
        .await
        .expect("active provider action transition")
    {
        V3ProviderActionRecoveryTransition::Admitted(admission) => admission,
        transition => panic!("active provider ticket must be admitted: {transition:?}"),
    };

    let started = Instant::now();
    gate.record_failure_and_commit_terminal_projection(scoped_key(
        "server-a",
        "group-a",
        "provider-b:key-b:model-b",
        "provider_http_401",
    ))
    .expect("terminal projection commits without waiting");

    assert!(
        started.elapsed() < Duration::from_millis(100),
        "terminal projection must not wait for the active sibling action"
    );
    assert!(
        gate.abandon_admission(&active_key, active.generation)
            .expect("active permit release"),
        "terminal projection must leave the active sibling permit owned until release"
    );
}

#[tokio::test]
async fn terminal_projection_advances_an_active_exact_key_and_preserves_its_permit() {
    let gate = V3ProviderActionGate::default();
    let active_key = key("provider_http_401");
    let active_failure = gate
        .record_failure(&active_key)
        .expect("record active exact-key failure");
    let active = match gate
        .wait_for_recovery_ticket(
            active_failure.recovery_ticket(),
            active_key.provider_scope.clone(),
        )
        .await
        .expect("active exact-key action transition")
    {
        V3ProviderActionRecoveryTransition::Admitted(admission) => admission,
        transition => panic!("active exact-key ticket must be admitted: {transition:?}"),
    };

    let waiter = {
        let gate = gate.clone();
        let key = active_key.clone();
        tokio::spawn(async move { gate.wait_for_active_failure(key).await })
    };
    tokio::time::sleep(Duration::from_millis(25)).await;

    let terminal = gate
        .record_failure_and_commit_terminal_projection(active_key.clone())
        .expect("terminal projection advances the active exact-key lane");
    let wake = waiter
        .await
        .expect("terminal waiter task")
        .expect("terminal waiter transition");
    assert!(wake.reevaluate_after_terminal);
    assert_eq!(wake.generation, terminal.generation + 1);
    assert!(
        gate.abandon_admission(&active_key, active.generation)
            .expect("active exact-key permit release"),
        "terminal generation advancement must retain the prior permit until release"
    );
}

#[test]
fn terminal_projection_commits_atomically_with_concurrent_provider_success() {
    let gate = V3ProviderActionGate::default();
    let scope = key("provider_http_401");
    let barrier = Arc::new(Barrier::new(5));

    std::thread::scope(|threads| {
        for _ in 0..4 {
            let gate = gate.clone();
            let scope = scope.clone();
            let barrier = Arc::clone(&barrier);
            threads.spawn(move || {
                barrier.wait();
                for _ in 0..1_000 {
                    gate.record_failure_and_commit_terminal_projection(scope.clone())
                        .expect("terminal record and commit share one generation");
                }
            });
        }

        let success_gate = gate.clone();
        threads.spawn(move || {
            barrier.wait();
            for _ in 0..4_000 {
                success_gate
                    .record_success(&scope)
                    .expect("concurrent provider success updates its gate state");
            }
        });
    });
}

#[tokio::test]
async fn unrelated_success_cannot_delay_a_terminal_projection() {
    let gate = V3ProviderActionGate::default();
    let scope = key("provider_http_401");
    let admission = gate
        .record_failure_and_commit_terminal_projection(scope.clone())
        .expect("terminal projection must commit immediately");
    gate.record_success(&scope)
        .expect("unrelated success resets active lane");
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
async fn overlapping_waiters_do_not_promote_the_declared_isolated_delay() {
    let gate = V3ProviderActionGate::default();
    let scope = key("provider_transport");
    let started = Instant::now();

    gate.record_failure(&scope)
        .expect("record overlapping waiter failure");
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

    let (admission, first_won) = tokio::time::timeout(Duration::from_millis(2_000), async {
        tokio::select! {
            result = &mut first => (result.expect("first waiter task").expect("first admission"), true),
            result = &mut second => (result.expect("second waiter task").expect("second admission"), false),
        }
    })
    .await
    .expect("adding a waiter promoted the isolated delay beyond two seconds");
    assert_eq!(admission.mode, V3ProviderActionGateMode::Isolated);
    assert!(
        started.elapsed() >= Duration::from_millis(V3_PROVIDER_ACTION_ISOLATED_DELAY_MS),
        "overlapping provider actions bypassed the isolated one-second floor"
    );
    assert!(
        if first_won {
            !second.is_finished()
        } else {
            !first.is_finished()
        },
        "one exact provider generation admitted more than one physical action"
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
async fn independent_provider_action_tickets_admit_without_consuming_another_lane() {
    let gate = V3ProviderActionGate::default();
    let first_key = key("provider_http_500");
    let second_key = scoped_key(
        "server-a",
        "group-a",
        "provider-b:key-b:model-b",
        "provider_http_500",
    );
    let first_failure = gate
        .record_failure(&first_key)
        .expect("record first provider failure");
    let second_failure = gate
        .record_failure(&second_key)
        .expect("record second provider failure");
    assert_eq!(first_failure.mode, V3ProviderActionGateMode::Isolated);
    assert_eq!(
        second_failure.mode,
        V3ProviderActionGateMode::Isolated,
        "a second identity inherited the first identity's failure sequence"
    );

    let first_admission = match gate
        .wait_for_recovery_ticket(
            first_failure.recovery_ticket(),
            first_key.provider_scope.clone(),
        )
        .await
        .expect("first provider ticket transition")
    {
        V3ProviderActionRecoveryTransition::Admitted(admission) => admission,
        transition => panic!("first provider ticket must be admitted: {transition:?}"),
    };
    assert_eq!(first_admission.mode, V3ProviderActionGateMode::Isolated);

    let second_started = Instant::now();
    let second_admission = match tokio::time::timeout(
        Duration::from_millis(500),
        gate.wait_for_recovery_ticket(
            second_failure.recovery_ticket(),
            second_key.provider_scope.clone(),
        ),
    )
    .await
    .expect("the first identity's physical permit blocked the second identity")
    .expect("second provider ticket transition")
    {
        V3ProviderActionRecoveryTransition::Admitted(admission) => admission,
        transition => panic!("second provider ticket must be admitted: {transition:?}"),
    };
    assert_eq!(second_admission.mode, V3ProviderActionGateMode::Isolated);
    assert!(
        second_started.elapsed() < Duration::from_millis(500),
        "the second identity waited for the first identity's admitted action"
    );

    drop(first_admission);
    drop(second_admission);
}

#[tokio::test]
async fn unrelated_same_group_provider_success_cannot_release_an_owned_action_permit() {
    let gate = V3ProviderActionGate::default();
    let failed = key("provider_http_500");
    let failure = gate
        .record_failure(&failed)
        .expect("record provider A failure");
    let admission = match gate
        .wait_for_recovery_ticket(failure.recovery_ticket(), failed.provider_scope.clone())
        .await
        .expect("provider A recovery transition")
    {
        V3ProviderActionRecoveryTransition::Admitted(admission) => admission,
        transition => panic!("provider A recovery ticket must be admitted: {transition:?}"),
    };

    gate.record_provider_success(&provider_scope("provider-c:key-c:model-c"))
        .expect("unrelated provider C success");

    assert!(
        gate.abandon_admission(&failed, admission.generation)
            .expect("provider A permit release"),
        "unrelated same-group provider success released provider A's owned recovery permit"
    );

    drop(admission);
}

#[tokio::test]
async fn exact_provider_recovery_tickets_remain_independent_of_another_lane() {
    let gate = V3ProviderActionGate::default();
    let provider_b_failure = scoped_key(
        "server-exact",
        "group-exact",
        "provider-b:key-b:model-b",
        "provider_http_503",
    );
    let provider_a_failure = scoped_key(
        "server-exact",
        "group-exact",
        "provider-a:key-a:model-a",
        "provider_http_503",
    );
    let provider_b_recorded = gate
        .record_failure(&provider_b_failure)
        .expect("record provider B failure");
    let provider_a_recorded = gate
        .record_failure(&provider_a_failure)
        .expect("record provider A failure");

    let provider_a = match gate
        .wait_for_recovery_ticket(
            provider_a_recorded.recovery_ticket(),
            provider_a_failure.provider_scope.clone(),
        )
        .await
        .expect("provider A recovery transition")
    {
        V3ProviderActionRecoveryTransition::Admitted(admission) => admission,
        transition => panic!("provider A recovery ticket must be admitted: {transition:?}"),
    };
    assert_eq!(provider_a.mode, V3ProviderActionGateMode::Isolated);

    let provider_b = match tokio::time::timeout(
        Duration::from_millis(500),
        gate.wait_for_recovery_ticket(
            provider_b_recorded.recovery_ticket(),
            provider_b_failure.provider_scope.clone(),
        ),
    )
    .await
    .expect("provider A's active lane blocked provider B's own recovery")
    .expect("provider B recovery transition")
    {
        V3ProviderActionRecoveryTransition::Admitted(admission) => admission,
        transition => panic!("provider B recovery ticket must be admitted: {transition:?}"),
    };
    assert_eq!(provider_b.mode, V3ProviderActionGateMode::Isolated);

    drop(provider_a);
    drop(provider_b);
}

#[tokio::test]
async fn consecutive_failures_extend_the_active_deadline() {
    let gate = V3ProviderActionGate::default();
    let scope = key("provider_http_500");
    gate.record_failure(&scope).expect("first failure");

    tokio::time::sleep(Duration::from_millis(100)).await;
    let second_failure_at = Instant::now();
    let recorded = gate.record_failure(&scope).expect("second failure");
    assert_eq!(recorded.generation, 2);
    assert_eq!(recorded.mode, V3ProviderActionGateMode::Medium);

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

#[test]
fn consecutive_failures_follow_one_three_five_and_success_resets() {
    let gate = V3ProviderActionGate::default();
    let scope = key("provider_http_500");

    let first = gate.record_failure(&scope).expect("first failure");
    assert_eq!(first.mode, V3ProviderActionGateMode::Isolated);
    assert_eq!(first.minimum_delay_ms, V3_PROVIDER_ACTION_ISOLATED_DELAY_MS);

    let second = gate.record_failure(&scope).expect("second failure");
    assert_eq!(second.mode, V3ProviderActionGateMode::Medium);
    assert_eq!(second.minimum_delay_ms, V3_PROVIDER_ACTION_MEDIUM_DELAY_MS);

    let third = gate.record_failure(&scope).expect("third failure");
    assert_eq!(third.mode, V3ProviderActionGateMode::Sustained);
    assert_eq!(
        third.minimum_delay_ms,
        V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS
    );

    let fourth = gate.record_failure(&scope).expect("fourth failure");
    assert_eq!(fourth.mode, V3ProviderActionGateMode::Sustained);
    assert_eq!(
        fourth.minimum_delay_ms,
        V3_PROVIDER_ACTION_SUSTAINED_DELAY_MS
    );

    gate.record_success(&scope)
        .expect("success resets failure sequence");
    let after_success = gate.record_failure(&scope).expect("failure after success");
    assert_eq!(after_success.mode, V3ProviderActionGateMode::Isolated);
    assert_eq!(
        after_success.minimum_delay_ms,
        V3_PROVIDER_ACTION_ISOLATED_DELAY_MS
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

    let started = Instant::now();
    first_request_gate
        .record_failure(&scope)
        .expect("first request records provider failure");
    assert_eq!(
        second_request_gate
            .active_waiters(&scope)
            .expect("second request reads shared gate"),
        0
    );

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
    assert_eq!(admitted.mode, V3ProviderActionGateMode::Isolated);
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
async fn changing_provider_and_error_family_keep_independent_isolated_delays() {
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
    let first_recorded = gate.record_failure(&first).expect("first lane failure");
    let changed_recorded = gate
        .record_failure(&changed)
        .expect("changed provider/family failure");
    assert_eq!(first_recorded.mode, V3ProviderActionGateMode::Isolated);
    assert_eq!(
        changed_recorded.mode,
        V3ProviderActionGateMode::Isolated,
        "changing provider or error family inherited another identity's failure count"
    );
    assert_eq!(
        changed_recorded.minimum_delay_ms,
        V3_PROVIDER_ACTION_ISOLATED_DELAY_MS
    );

    let first_admission = match gate
        .wait_for_recovery_ticket(first_recorded.recovery_ticket(), first.provider_scope.clone())
        .await
        .expect("first lane recovery transition")
    {
        V3ProviderActionRecoveryTransition::Admitted(admission) => admission,
        transition => panic!("first lane recovery ticket must be admitted: {transition:?}"),
    };
    assert_eq!(first_admission.mode, V3ProviderActionGateMode::Isolated);

    let changed_started = Instant::now();
    let changed_admission = match tokio::time::timeout(
        Duration::from_millis(500),
        gate.wait_for_recovery_ticket(
            changed_recorded.recovery_ticket(),
            changed.provider_scope.clone(),
        ),
    )
    .await
    .expect("the first provider's active permit blocked the changed provider")
    .expect("changed provider recovery transition")
    {
        V3ProviderActionRecoveryTransition::Admitted(admission) => admission,
        transition => panic!("changed provider recovery ticket must be admitted: {transition:?}"),
    };
    assert_eq!(changed_admission.mode, V3ProviderActionGateMode::Isolated);
    assert!(
        changed_started.elapsed() < Duration::from_millis(500),
        "changing provider or error family waited for another identity's permit"
    );

    drop(first_admission);
    drop(changed_admission);
}

#[tokio::test]
async fn changed_provider_lanes_admit_independently_by_exact_generation() {
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
        "provider_http_500",
    );
    let first_recorded = gate.record_failure(&first).expect("first provider failure");
    let second_recorded = gate
        .record_failure(&second)
        .expect("second provider failure");
    assert_eq!(first_recorded.mode, V3ProviderActionGateMode::Isolated);
    assert_eq!(
        second_recorded.mode,
        V3ProviderActionGateMode::Isolated,
        "a changed provider inherited the routing group's failure interval"
    );

    let first_admission = match gate
        .wait_for_recovery_ticket(first_recorded.recovery_ticket(), first.provider_scope.clone())
        .await
        .expect("first provider transition")
    {
        V3ProviderActionRecoveryTransition::Admitted(admission) => admission,
        transition => panic!("first provider ticket must be admitted: {transition:?}"),
    };
    assert_eq!(first_admission.mode, V3ProviderActionGateMode::Isolated);

    let second_started = Instant::now();
    let second_admission = match tokio::time::timeout(
        Duration::from_millis(500),
        gate.wait_for_recovery_ticket(
            second_recorded.recovery_ticket(),
            second.provider_scope.clone(),
        ),
    )
    .await
    .expect("the first provider's permit serialized a changed provider lane")
    .expect("second provider transition")
    {
        V3ProviderActionRecoveryTransition::Admitted(admission) => admission,
        transition => panic!("second provider ticket must be admitted: {transition:?}"),
    };
    assert_eq!(second_admission.mode, V3ProviderActionGateMode::Isolated);
    assert!(
        second_started.elapsed() < Duration::from_millis(500),
        "provider/error-family change waited for the routing group's first action"
    );

    drop(first_admission);
    drop(second_admission);
}

#[tokio::test]
async fn admitted_action_failure_does_not_advance_another_provider_lane() {
    let gate = V3ProviderActionGate::default();
    let admitted_key = scoped_key(
        "server-outcome",
        "group-outcome",
        "provider-a:key:model",
        "provider_http_503",
    );
    let admitted_recorded = gate
        .record_failure(&admitted_key)
        .expect("record admitted provider failure");
    let admitted = match gate
        .wait_for_recovery_ticket(
            admitted_recorded.recovery_ticket(),
            admitted_key.provider_scope.clone(),
        )
        .await
        .expect("admitted provider transition")
    {
        V3ProviderActionRecoveryTransition::Admitted(admission) => admission,
        transition => panic!("admitted provider ticket must be admitted: {transition:?}"),
    };

    let independent_key = scoped_key(
        "server-outcome",
        "group-outcome",
        "provider-b:key:model",
        "provider_http_500",
    );
    let independent_recorded = gate
        .record_failure(&independent_key)
        .expect("record independent provider failure");
    let independent_ticket = independent_recorded.recovery_ticket().clone();

    gate.record_failure(&admitted_key)
        .expect("record the admitted provider action failure");
    assert_eq!(
        independent_ticket.generation(),
        1,
        "the admitted provider action advanced another identity's generation"
    );

    let independent_started = Instant::now();
    let independent = match tokio::time::timeout(
        Duration::from_millis(V3_PROVIDER_ACTION_ISOLATED_DELAY_MS + 500),
        gate.wait_for_recovery_ticket(
            &independent_ticket,
            independent_key.provider_scope.clone(),
        ),
    )
    .await
    .expect("the admitted provider action blocked its independent lane")
    .expect("independent provider transition")
    {
        V3ProviderActionRecoveryTransition::Admitted(admission) => admission,
        transition => panic!("independent provider ticket must be admitted: {transition:?}"),
    };
    assert_eq!(independent.mode, V3ProviderActionGateMode::Isolated);
    assert_eq!(independent.generation, 1);
    assert!(
        independent_started.elapsed() >= Duration::from_millis(V3_PROVIDER_ACTION_ISOLATED_DELAY_MS),
        "the independent lane bypassed its own declared isolated delay"
    );

    drop(admitted);
    drop(independent);
}

#[tokio::test]
async fn admitted_action_requires_explicit_drop_before_replacement_generation() {
    let gate = V3ProviderActionGate::default();
    let scope = key("provider_http_503");
    let failure = gate
        .record_failure(&scope)
        .expect("record provider failure");
    let admitted = match gate
        .wait_for_recovery_ticket(failure.recovery_ticket(), scope.provider_scope.clone())
        .await
        .expect("first provider action transition")
    {
        V3ProviderActionRecoveryTransition::Admitted(admission) => admission,
        transition => panic!("first provider ticket must be admitted: {transition:?}"),
    };
    let competing_failure = gate
        .record_failure(&scope)
        .expect("record concurrent provider failure");
    assert_eq!(competing_failure.mode, V3ProviderActionGateMode::Medium);
    assert_eq!(
        competing_failure.generation, admitted.generation,
        "a new failure replaced the generation whose permit is still owned"
    );

    let mut next = {
        let gate = gate.clone();
        let scope = scope.clone();
        tokio::spawn(async move { gate.wait_for_active_failure(scope).await })
    };
    tokio::time::sleep(Duration::from_millis(
        V3_PROVIDER_ACTION_MEDIUM_DELAY_MS + 100,
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
async fn consumed_recovery_lane_releases_ticket_for_reevaluation() {
    let gate = V3ProviderActionGate::default();
    let failed = scoped_key(
        "released-server",
        "released-group",
        "provider-a:key:model",
        "provider_http_500",
    );
    let ticket = gate
        .record_failure(&failed)
        .expect("provider failure")
        .recovery_ticket()
        .clone();
    gate.record_success(&failed).expect("provider success");

    let transition = gate
        .wait_for_recovery_ticket(&ticket, provider_scope("provider-b:key:model"))
        .await
        .expect("consumed lane is a re-evaluation");
    assert!(matches!(
        transition,
        V3ProviderActionRecoveryTransition::Consumed(released)
            if released == ticket
    ));
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
        "provider_http_500",
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
    let sustained_started = Instant::now();
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

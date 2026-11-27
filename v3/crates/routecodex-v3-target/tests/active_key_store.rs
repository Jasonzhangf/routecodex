use routecodex_v3_config::{
    V3ActiveKeyFailureAction, V3ActiveKeyMember, V3ActiveKeyPolicy, V3SelectionStrategy,
};
use routecodex_v3_target::*;
use std::collections::BTreeSet;
use std::sync::Arc;

fn identity(alias: &str) -> V3ActiveKeyIdentity {
    V3ActiveKeyIdentity {
        provider_id: "provider".into(),
        interface_id: "responses".into(),
        model_id: "model".into(),
        auth_alias: alias.into(),
    }
}
fn scope() -> V3ActiveKeyScope {
    V3ActiveKeyScope {
        listener_id: "listener".into(),
        routing_group_id: "group".into(),
        pool_id: "default".into(),
    }
}
fn configure(
    state: &V3ActiveKeySelectionState,
    strategy: V3SelectionStrategy,
    action: V3ActiveKeyFailureAction,
) {
    state
        .configure(
            scope(),
            V3ActiveKeyPolicy {
                members: ["a", "b", "c"]
                    .map(|alias| V3ActiveKeyMember {
                        provider: "provider".into(),
                        alias: alias.into(),
                    })
                    .to_vec(),
                retries: 3,
                on_failure: action,
            },
            strategy,
            &[
                identity("c"),
                identity("a"),
                identity("inactive"),
                identity("b"),
            ],
        )
        .unwrap();
}
fn choose(
    state: &V3ActiveKeySelectionState,
    excluded: &BTreeSet<V3ActiveKeyIdentity>,
    session: Option<&str>,
) -> V3ActiveKeySelection {
    state
        .choose(
            &scope(),
            &[
                identity("a"),
                identity("b"),
                identity("c"),
                identity("inactive"),
            ]
            .into(),
            excluded,
            session,
        )
        .unwrap()
        .unwrap()
}

fn fail_four(state: &V3ActiveKeySelectionState, episode: &mut V3ActiveKeyEpisode) {
    for count in 1..=4 {
        episode.begin_attempt().unwrap();
        let feedback = state.record_delivery_failure(episode).unwrap();
        assert!(feedback.applied);
        assert_eq!(feedback.consecutive_failures, count);
        assert_eq!(feedback.transitioned, count == 4);
    }
}

#[test]
fn early_episode_closure_does_not_requeue_or_hold_the_key() {
    let state = V3ActiveKeySelectionState::default();
    configure(
        &state,
        V3SelectionStrategy::ActiveQueue,
        V3ActiveKeyFailureAction::Hold,
    );
    let mut episode = V3ActiveKeyEpisode::new(choose(&state, &BTreeSet::new(), None));
    episode.begin_attempt().unwrap();
    assert!(state.close_failure(&mut episode).unwrap());
    assert!(
        state.snapshot(&scope()).unwrap().held.is_empty(),
        "closing a single nonretryable failure is not the fourth-failure transition"
    );
    assert_eq!(
        choose(&state, &BTreeSet::new(), None).identity,
        identity("a")
    );
}

#[test]
fn manual_release_joins_the_tail_behind_remaining_fresh_assignments() {
    let state = V3ActiveKeySelectionState::default();
    configure(
        &state,
        V3SelectionStrategy::RoundRobin,
        V3ActiveKeyFailureAction::Hold,
    );
    let mut episode = V3ActiveKeyEpisode::new(choose(&state, &BTreeSet::new(), None));
    fail_four(&state, &mut episode);
    assert_eq!(
        choose(&state, &BTreeSet::new(), None).identity,
        identity("b")
    );
    state.release(&scope(), &identity("a")).unwrap();
    for alias in ["c", "b", "a"] {
        assert_eq!(
            choose(&state, &BTreeSet::new(), None).identity,
            identity(alias)
        );
    }
}

#[test]
fn tail_transition_respects_the_current_round_robin_queue_position() {
    for advance in 1..=2 {
        let state = V3ActiveKeySelectionState::default();
        configure(
            &state,
            V3SelectionStrategy::RoundRobin,
            V3ActiveKeyFailureAction::Tail,
        );
        let mut failed = V3ActiveKeyEpisode::new(choose(&state, &BTreeSet::new(), None));
        for _ in 0..advance {
            choose(&state, &BTreeSet::new(), None);
        }
        fail_four(&state, &mut failed);
        let expected = if advance == 1 {
            ["c", "b", "a"]
        } else {
            ["b", "c", "a"]
        };
        for alias in expected {
            assert_eq!(
                choose(&state, &BTreeSet::new(), None).identity,
                identity(alias),
                "failed A must rejoin behind the remaining logical queue"
            );
        }
    }
}

#[test]
fn concurrent_fourth_failure_requeues_once_and_invalidates_unsent_old_retries() {
    let state = Arc::new(V3ActiveKeySelectionState::default());
    configure(
        &state,
        V3SelectionStrategy::ActiveQueue,
        V3ActiveKeyFailureAction::Tail,
    );
    let old = choose(&state, &BTreeSet::new(), None);
    let episodes = (0..4)
        .map(|_| {
            let mut episode = V3ActiveKeyEpisode::new(choose(&state, &BTreeSet::new(), None));
            episode.begin_attempt().unwrap();
            episode
        })
        .collect::<Vec<_>>();
    let threads = episodes
        .into_iter()
        .map(|mut episode| {
            let state = state.clone();
            std::thread::spawn(move || state.record_delivery_failure(&mut episode).unwrap())
        })
        .collect::<Vec<_>>();
    let feedback = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        feedback
            .iter()
            .filter(|outcome| outcome.transitioned)
            .count(),
        1
    );
    assert_eq!(
        state.snapshot(&scope()).unwrap().order,
        [identity("b"), identity("c"), identity("a")]
    );
    assert!(
        state.selectable(&scope(), &identity("a")),
        "new requests may eventually reach the tail"
    );
    assert!(
        !state.selection_current(&old),
        "old retry episodes lost their generation"
    );
}

#[test]
fn fourth_failure_accumulates_across_requests_without_duplicate_outcomes() {
    let state = V3ActiveKeySelectionState::default();
    configure(
        &state,
        V3SelectionStrategy::ActiveQueue,
        V3ActiveKeyFailureAction::Tail,
    );
    let mut policy = state.snapshot(&scope()).unwrap().policy;
    policy.retries = 0;
    state
        .configure(
            scope(),
            policy,
            V3SelectionStrategy::ActiveQueue,
            &[identity("a"), identity("b"), identity("c")],
        )
        .unwrap();
    for count in 1..=4 {
        let mut episode = V3ActiveKeyEpisode::new(choose(&state, &BTreeSet::new(), None));
        episode.begin_attempt().unwrap();
        assert!(!episode.can_retry(true));
        let feedback = state.record_delivery_failure(&mut episode).unwrap();
        assert_eq!(feedback.consecutive_failures, count);
        assert_eq!(feedback.transitioned, count == 4);
        assert!(!state.record_delivery_failure(&mut episode).unwrap().applied);
        state.close_failure(&mut episode).unwrap();
        assert_eq!(
            state.snapshot(&scope()).unwrap().order[0],
            identity(if count == 4 { "b" } else { "a" })
        );
    }
}

#[test]
fn third_failure_preserves_affinity_and_fourth_tail_invalidates_all_sessions() {
    let state = V3ActiveKeySelectionState::default();
    configure(
        &state,
        V3SelectionStrategy::Sticky,
        V3ActiveKeyFailureAction::Tail,
    );
    let only_a = [identity("b"), identity("c")].into();
    for session in ["s1", "s2"] {
        let mut success = V3ActiveKeyEpisode::new(choose(&state, &only_a, Some(session)));
        success.begin_attempt().unwrap();
        state.accepted_success(&mut success).unwrap();
    }
    for count in 1..=4 {
        let mut episode = V3ActiveKeyEpisode::new(choose(&state, &only_a, None));
        episode.begin_attempt().unwrap();
        let feedback = state.record_delivery_failure(&mut episode).unwrap();
        assert_eq!(feedback.consecutive_failures, count);
        state.close_failure(&mut episode).unwrap();
        if count == 3 {
            assert_eq!(
                choose(&state, &BTreeSet::new(), Some("s1")).identity,
                identity("a")
            );
            assert_eq!(
                choose(&state, &BTreeSet::new(), Some("s2")).identity,
                identity("a")
            );
        }
    }
    assert_eq!(
        choose(&state, &BTreeSet::new(), Some("s1")).identity,
        identity("b")
    );
    assert_eq!(
        choose(&state, &BTreeSet::new(), Some("s2")).identity,
        identity("c")
    );
    assert_eq!(
        choose(&state, &BTreeSet::new(), Some("new")).identity,
        identity("a")
    );
}

#[test]
fn accepted_success_resets_streak_but_neutral_cancellation_does_not() {
    let state = V3ActiveKeySelectionState::default();
    configure(
        &state,
        V3SelectionStrategy::ActiveQueue,
        V3ActiveKeyFailureAction::Hold,
    );
    let mut episode = V3ActiveKeyEpisode::new(choose(&state, &BTreeSet::new(), None));
    for count in 1..=3 {
        episode.begin_attempt().unwrap();
        assert_eq!(
            state
                .record_delivery_failure(&mut episode)
                .unwrap()
                .consecutive_failures,
            count
        );
    }
    episode.begin_attempt().unwrap();
    assert!(state.accepted_success(&mut episode).unwrap());
    assert!(state.snapshot(&scope()).unwrap().held.is_empty());
    for count in 1..=3 {
        let mut episode = V3ActiveKeyEpisode::new(choose(&state, &BTreeSet::new(), None));
        episode.begin_attempt().unwrap();
        assert_eq!(
            state
                .record_delivery_failure(&mut episode)
                .unwrap()
                .consecutive_failures,
            count
        );
        state.close_failure(&mut episode).unwrap();
    }
    let mut cancelled = V3ActiveKeyEpisode::new(choose(&state, &BTreeSet::new(), None));
    cancelled.begin_attempt().unwrap();
    cancelled.cancel();
    assert!(
        !state
            .record_delivery_failure(&mut cancelled)
            .unwrap()
            .applied
    );
    let mut fourth = V3ActiveKeyEpisode::new(choose(&state, &BTreeSet::new(), None));
    fourth.begin_attempt().unwrap();
    assert!(
        state
            .record_delivery_failure(&mut fourth)
            .unwrap()
            .transitioned
    );
}

#[test]
fn a_newer_failed_selection_cannot_suppress_an_accepted_old_success() {
    let state = V3ActiveKeySelectionState::default();
    configure(
        &state,
        V3SelectionStrategy::Sticky,
        V3ActiveKeyFailureAction::Tail,
    );
    let mut old = V3ActiveKeyEpisode::new(choose(&state, &BTreeSet::new(), Some("session")));
    old.begin_attempt().unwrap();
    let mut newer_failed =
        V3ActiveKeyEpisode::new(choose(&state, &BTreeSet::new(), Some("session")));
    newer_failed.begin_attempt().unwrap();
    state.record_delivery_failure(&mut newer_failed).unwrap();
    state.close_failure(&mut newer_failed).unwrap();
    assert!(state.accepted_success(&mut old).unwrap());
    assert_eq!(
        choose(&state, &BTreeSet::new(), Some("session")).identity,
        identity("a"),
        "only a newer successful replacement can supersede an accepted result"
    );
}

#[test]
fn late_old_session_success_cannot_replace_a_newer_successful_binding() {
    let state = V3ActiveKeySelectionState::default();
    configure(
        &state,
        V3SelectionStrategy::Sticky,
        V3ActiveKeyFailureAction::Tail,
    );
    let mut old = V3ActiveKeyEpisode::new(choose(&state, &BTreeSet::new(), Some("session")));
    old.begin_attempt().unwrap();
    let mut new = V3ActiveKeyEpisode::new(choose(&state, &BTreeSet::new(), Some("session")));
    assert_eq!(new.selection.identity, identity("b"));
    new.begin_attempt().unwrap();
    assert!(state.accepted_success(&mut new).unwrap());
    assert!(state.accepted_success(&mut old).unwrap());
    assert_eq!(
        choose(&state, &BTreeSet::new(), Some("session")).identity,
        identity("b")
    );
}

#[test]
fn queue_success_retains_head_and_retries_count_only_sends() {
    let state = V3ActiveKeySelectionState::default();
    configure(
        &state,
        V3SelectionStrategy::ActiveQueue,
        V3ActiveKeyFailureAction::Hold,
    );
    for _ in 0..3 {
        let selected = choose(&state, &BTreeSet::new(), None);
        assert_eq!(selected.identity, identity("a"));
        let mut episode = V3ActiveKeyEpisode::new(selected);
        assert!(!episode.can_retry(true));
        for send in 1..=4 {
            episode.begin_attempt().unwrap();
            assert_eq!(episode.can_retry(true), send < 4);
            assert!(!episode.can_retry(false));
        }
        assert!(episode.begin_attempt().is_none());
        assert!(state.accepted_success(&mut episode).unwrap());
        assert!(!state.close_failure(&mut episode).unwrap());
    }
}

#[test]
fn hold_release_and_stale_concurrent_outcomes_are_once_only() {
    let state = V3ActiveKeySelectionState::default();
    configure(
        &state,
        V3SelectionStrategy::ActiveQueue,
        V3ActiveKeyFailureAction::Hold,
    );
    let selected = choose(&state, &BTreeSet::new(), Some("session"));
    let mut first = V3ActiveKeyEpisode::new(selected.clone());
    let mut concurrent = V3ActiveKeyEpisode::new(selected.clone());
    let mut late_success = V3ActiveKeyEpisode::new(selected);
    concurrent.begin_attempt();
    late_success.begin_attempt();
    fail_four(&state, &mut first);
    assert!(!state.accepted_success(&mut late_success).unwrap());
    assert_eq!(
        choose(&state, &BTreeSet::new(), None).identity,
        identity("b")
    );
    assert!(state.release(&scope(), &identity("a")).unwrap());
    assert!(
        state
            .record_delivery_failure(&mut concurrent)
            .unwrap()
            .stale
    );
    let snapshot = state.snapshot(&scope()).unwrap();
    assert!(snapshot.held.is_empty());
    assert_eq!(
        snapshot.order,
        vec![identity("b"), identity("c"), identity("a")]
    );
    assert!(!state.release(&scope(), &identity("a")).unwrap());
    assert_eq!(snapshot.order, state.snapshot(&scope()).unwrap().order);
    assert!(state.release(&scope(), &identity("inactive")).is_err());
}

#[test]
fn tail_cannot_cycle_in_same_request_and_cancel_has_no_disposition() {
    let state = V3ActiveKeySelectionState::default();
    configure(
        &state,
        V3SelectionStrategy::ActiveQueue,
        V3ActiveKeyFailureAction::Tail,
    );
    let mut excluded = BTreeSet::new();
    for alias in ["a", "b", "c"] {
        let selection = choose(&state, &excluded, None);
        assert_eq!(selection.identity, identity(alias));
        excluded.insert(selection.identity.clone());
        let mut episode = V3ActiveKeyEpisode::new(selection);
        fail_four(&state, &mut episode);
        assert!(!state.close_failure(&mut episode).unwrap());
    }
    assert!(state
        .choose(&scope(), &excluded, &excluded, None)
        .unwrap()
        .is_none());
    assert_eq!(
        choose(&state, &BTreeSet::new(), None).identity,
        identity("a")
    );
    let mut cancelled = V3ActiveKeyEpisode::new(choose(&state, &BTreeSet::new(), None));
    cancelled.begin_attempt();
    cancelled.cancel();
    assert!(!state.close_failure(&mut cancelled).unwrap());
    assert_eq!(
        choose(&state, &BTreeSet::new(), None).identity,
        identity("a")
    );
}

#[test]
fn sticky_records_only_success_and_no_session_does_not_bind() {
    let state = V3ActiveKeySelectionState::default();
    configure(
        &state,
        V3SelectionStrategy::Sticky,
        V3ActiveKeyFailureAction::Hold,
    );
    assert_eq!(
        choose(&state, &BTreeSet::new(), Some("s")).identity,
        identity("a")
    );
    let b = choose(&state, &BTreeSet::new(), Some("s"));
    assert_eq!(
        b.identity,
        identity("b"),
        "provisional selection is not a binding"
    );
    let mut episode = V3ActiveKeyEpisode::new(b);
    episode.begin_attempt();
    assert!(state.accepted_success(&mut episode).unwrap());
    assert_eq!(
        choose(&state, &BTreeSet::new(), Some("s")).identity,
        identity("b")
    );
    let excluded = [identity("b")].into();
    assert_eq!(choose(&state, &excluded, Some("s")).identity, identity("c"));
    assert_eq!(
        choose(&state, &BTreeSet::new(), Some("s")).identity,
        identity("b")
    );
    assert_eq!(
        choose(&state, &BTreeSet::new(), None).identity,
        identity("a")
    );
    assert_eq!(
        choose(&state, &BTreeSet::new(), None).identity,
        identity("b")
    );
}

#[test]
fn concurrent_fresh_sessions_rotate_atomically() {
    let state = Arc::new(V3ActiveKeySelectionState::default());
    configure(
        &state,
        V3SelectionStrategy::RoundRobin,
        V3ActiveKeyFailureAction::Hold,
    );
    let threads = (0..30)
        .map(|index| {
            let state = state.clone();
            std::thread::spawn(move || {
                choose(&state, &BTreeSet::new(), Some(&index.to_string())).identity
            })
        })
        .collect::<Vec<_>>();
    let choices = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect::<Vec<_>>();
    for alias in ["a", "b", "c"] {
        assert_eq!(
            choices
                .iter()
                .filter(|chosen| **chosen == identity(alias))
                .count(),
            10
        );
    }
}

#[test]
fn persistent_holds_survive_reconstruction_release_and_scope_isolation() {
    let root = std::env::temp_dir().join(format!("routecodex-active-store-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("state.json");
    let state = V3ActiveKeySelectionState::from_file(&path).unwrap();
    configure(
        &state,
        V3SelectionStrategy::ActiveQueue,
        V3ActiveKeyFailureAction::Hold,
    );
    let mut episode = V3ActiveKeyEpisode::new(choose(&state, &BTreeSet::new(), None));
    fail_four(&state, &mut episode);
    drop(state);
    let state = V3ActiveKeySelectionState::from_file(&path).unwrap();
    configure(
        &state,
        V3SelectionStrategy::ActiveQueue,
        V3ActiveKeyFailureAction::Hold,
    );
    assert_eq!(
        choose(&state, &BTreeSet::new(), None).identity,
        identity("b")
    );
    let mut other = scope();
    other.listener_id = "other".into();
    let snapshot = state.snapshot(&scope()).unwrap();
    state
        .configure(
            other.clone(),
            snapshot.policy,
            snapshot.strategy,
            &snapshot.order,
        )
        .unwrap();
    assert!(state.selectable(&other, &identity("a")));
    state.release(&scope(), &identity("a")).unwrap();
    drop(state);
    let state = V3ActiveKeySelectionState::from_file(&path).unwrap();
    configure(
        &state,
        V3SelectionStrategy::ActiveQueue,
        V3ActiveKeyFailureAction::Hold,
    );
    assert!(state.snapshot(&scope()).unwrap().held.is_empty());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn persistence_error_is_explicit_and_keeps_safe_hold() {
    let root = std::env::temp_dir().join(format!(
        "routecodex-active-store-error-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let state_dir = root.join("state");
    let state_path = state_dir.join("state.json");
    let state = V3ActiveKeySelectionState::from_file(&state_path).unwrap();
    configure(
        &state,
        V3SelectionStrategy::ActiveQueue,
        V3ActiveKeyFailureAction::Hold,
    );
    std::fs::create_dir_all(&state_path).unwrap();
    let mut episode = V3ActiveKeyEpisode::new(choose(&state, &BTreeSet::new(), None));
    for _ in 0..3 {
        episode.begin_attempt().unwrap();
        state.record_delivery_failure(&mut episode).unwrap();
    }
    episode.begin_attempt().unwrap();
    let feedback = state.record_delivery_failure(&mut episode).unwrap();
    assert!(feedback.applied);
    assert!(feedback.transitioned);
    assert!(feedback.durability_error.is_some());
    let snapshot = state.snapshot(&scope()).unwrap();
    assert!(snapshot.held.contains(&identity("a")));
    assert!(snapshot.persistence_error.is_some());
    assert_eq!(
        choose(&state, &BTreeSet::new(), None).identity,
        identity("b")
    );
    std::fs::remove_dir_all(&state_path).unwrap();
    state.release(&scope(), &identity("a")).unwrap();
    assert!(state
        .snapshot(&scope())
        .unwrap()
        .persistence_error
        .is_none());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn tail_transition_does_not_persist_an_unchanged_held_set() {
    let root = std::env::temp_dir().join(format!(
        "routecodex-active-store-tail-error-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let state_dir = root.join("state");
    let state_path = state_dir.join("state.json");
    let state = V3ActiveKeySelectionState::from_file(&state_path).unwrap();
    configure(
        &state,
        V3SelectionStrategy::ActiveQueue,
        V3ActiveKeyFailureAction::Tail,
    );
    std::fs::create_dir_all(&state_path).unwrap();
    let mut episode = V3ActiveKeyEpisode::new(choose(&state, &BTreeSet::new(), None));
    for _ in 0..3 {
        episode.begin_attempt().unwrap();
        state.record_delivery_failure(&mut episode).unwrap();
    }
    episode.begin_attempt().unwrap();
    let feedback = state.record_delivery_failure(&mut episode).unwrap();
    assert!(feedback.applied);
    assert!(feedback.transitioned);
    assert!(feedback.durability_error.is_none());
    assert!(state
        .snapshot(&scope())
        .unwrap()
        .persistence_error
        .is_none());
    std::fs::remove_dir_all(state_path).unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn full_identity_and_each_scope_component_is_independent() {
    let state = V3ActiveKeySelectionState::default();
    configure(
        &state,
        V3SelectionStrategy::ActiveQueue,
        V3ActiveKeyFailureAction::Hold,
    );
    let selected = choose(&state, &BTreeSet::new(), None);
    let mut episode = V3ActiveKeyEpisode::new(selected);
    fail_four(&state, &mut episode);
    for component in 0..3 {
        let mut other = scope();
        match component {
            0 => other.listener_id.push('2'),
            1 => other.routing_group_id.push('2'),
            _ => other.pool_id.push('2'),
        }
        let snapshot = state.snapshot(&scope()).unwrap();
        state
            .configure(
                other.clone(),
                snapshot.policy,
                snapshot.strategy,
                &snapshot.order,
            )
            .unwrap();
        assert!(state.selectable(&other, &identity("a")));
    }
    let snapshot = state.snapshot(&scope()).unwrap();
    let mut interface = identity("a");
    interface.interface_id = "chat".into();
    let mut model = identity("a");
    model.model_id = "other-model".into();
    let mut universe = snapshot.order;
    universe.extend([interface.clone(), model.clone()]);
    state
        .configure(scope(), snapshot.policy, snapshot.strategy, &universe)
        .unwrap();
    assert!(!state.selectable(&scope(), &identity("a")));
    assert!(state.selectable(&scope(), &interface));
    assert!(state.selectable(&scope(), &model));
}

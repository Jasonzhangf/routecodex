use super::*;
use futures_util::StreamExt;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use std::sync::{Arc, Mutex};

#[test]
fn request_candidate_scan_tracks_complete_identities_and_clears() {
    let budget =
        V3AttemptBudget::new_isolated(test_limits(8, 32, 64), Arc::new(AtomicUsize::new(0)));
    budget
        .record_request_candidate_attempt("provider/interface/key/model".into(), 0)
        .unwrap();
    budget
        .record_request_candidate_attempt("provider/interface/key/model".into(), 0)
        .unwrap();
    budget
        .record_request_candidate_attempt("provider/interface/other/model".into(), 0)
        .unwrap();
    assert_eq!(budget.request_candidate_attempts().unwrap().len(), 2);
    budget.clear_request_candidate_scan();
    assert!(budget.request_candidate_attempts().unwrap().is_empty());
}

#[test]
fn recovery_clears_only_the_matched_failed_identity() {
    let budget =
        V3AttemptBudget::new_isolated(test_limits(8, 32, 64), Arc::new(AtomicUsize::new(0)));
    budget.record_request_candidate_attempt("p/default/k1/m".into(), 3).unwrap();
    budget.record_request_candidate_attempt("p/default/k2/m".into(), 7).unwrap();
    budget.clear_recovered_request_candidates(&BTreeSet::from(["p/default/k1/m".into()])).unwrap();
    assert_eq!(budget.request_candidate_recovery_revisions().unwrap(), BTreeMap::from([("p/default/k2/m".into(), 7)]));
}

#[test]
fn unsent_transport_release_does_not_mark_a_candidate_attempted() {
    let budget =
        V3AttemptBudget::new_isolated(test_limits(8, 32, 64), Arc::new(AtomicUsize::new(0)));
    assert_eq!(budget.admit_transport_attempt().unwrap(), 1);
    budget.release_unsent_transport_attempt();
    assert_eq!(budget.transport_attempts(), 0);
    assert!(budget.request_candidate_attempts().unwrap().is_empty());
}

#[test]
fn target_recovery_backoff_starts_at_declared_one_second() {
    let budget =
        V3AttemptBudget::new_isolated(test_limits(8, 16, 32), Arc::new(AtomicUsize::new(0)));
    let now = Instant::now();
    assert_eq!(
        budget.current_target_recovery_deadline(now),
        Some(now + Duration::from_secs(1))
    );
}

#[test]
fn target_recovery_ladder_and_notification_wakes_keep_original_due_time() {
    let mut limits = test_limits(8, 16, 32);
    limits.residence_timeout = Duration::from_secs(600);
    let budget = V3AttemptBudget::new_isolated(limits, Arc::new(AtomicUsize::new(0)));
    let mut now = Instant::now();
    let sibling = V3AttemptBudget::new_isolated(limits, Arc::new(AtomicUsize::new(0)));
    let sibling_started = now;
    let sibling_due = sibling.current_target_recovery_deadline(sibling_started);
    for seconds in [1, 3, 15, 35, 90, 1, 1] {
        let due_at = now + Duration::from_secs(seconds);
        assert_eq!(budget.current_target_recovery_deadline(now), Some(due_at));
        let notified_at = now + Duration::from_millis(200);
        let reselected = budget.clone();
        reselected.advance_target_recovery_step_if_due(notified_at);
        assert_eq!(
            reselected.current_target_recovery_deadline(notified_at),
            Some(due_at)
        );
        budget.advance_target_recovery_step_if_due(due_at);
        budget.advance_target_recovery_step_if_due(due_at);
        assert_eq!(
            sibling.current_target_recovery_deadline(sibling_started),
            sibling_due,
            "advancing one request must not advance another request's recovery cursor"
        );
        now = due_at;
    }
    let fresh = V3AttemptBudget::new_isolated(limits, Arc::new(AtomicUsize::new(0)));
    let fresh_now = Instant::now();
    assert_eq!(
        fresh.current_target_recovery_deadline(fresh_now),
        Some(fresh_now + Duration::from_secs(1))
    );
    assert_eq!(
        budget.current_target_recovery_deadline(budget.residence_deadline()),
        Some(budget.residence_deadline() + Duration::from_secs(1))
    );
}

#[test]
fn materialization_slots_replace_and_release_only_after_old_value_drops() {
    let process = Arc::new(AtomicUsize::new(0));
    let budget = V3AttemptBudget::new_isolated(test_limits(8, 16, 32), process.clone());
    let context = V3AttemptMaterializationContext::new(budget.clone());
    let mut slots = V3MaterializationSlots::new(context);
    let initial = slots.prepare_replace(0usize, 5).unwrap();
    slots.finish_replace(initial).unwrap();
    assert!(
        slots.prepare_replace(0, 4).is_err(),
        "old and newly copied replacement coexist before mutation"
    );
    assert_eq!(process.load(Ordering::Acquire), 5);
    let smaller = slots.prepare_replace(0, 2).unwrap();
    assert_eq!(
        process.load(Ordering::Acquire),
        7,
        "old and new retained subtrees are both charged before replacement"
    );
    slots.finish_replace(smaller).unwrap();
    assert_eq!(process.load(Ordering::Acquire), 2);
    slots.grow(0, 4).unwrap();
    assert!(slots.prepare_replace(1, 3).is_err());
    assert_eq!(process.load(Ordering::Acquire), 6);
    for _ in 0..100 {
        let replacement = slots.prepare_replace(0, 1).unwrap();
        slots.finish_replace(replacement).unwrap();
        slots.grow(0, 1).unwrap();
    }
    assert_eq!(
        process.load(Ordering::Acquire),
        2,
        "replaced values do not accumulate wire-traffic charges"
    );
    let pending = slots.prepare_field_replace(0, 1, 3).unwrap();
    assert_eq!(process.load(Ordering::Acquire), 5);
    slots.finish_replace(pending).unwrap();
    assert_eq!(
        process.load(Ordering::Acquire),
        4,
        "unchanged fields are neither copied nor charged twice"
    );
    let abandoned = slots.prepare_replace(0, 1).unwrap();
    drop(abandoned);
    assert_eq!(
        process.load(Ordering::Acquire),
        5,
        "failed mutation keeps its pending copy reserved until reducer destruction"
    );
    drop(slots);
    assert_eq!(budget.request_resident_bytes(), 0);
    assert_eq!(process.load(Ordering::Acquire), 0);
}

#[test]
fn materialization_leases_share_attempt_limit_and_transfer_without_readmission() {
    let process = Arc::new(AtomicUsize::new(0));
    let budget = V3AttemptBudget::new_isolated(test_limits(8, 16, 32), process.clone());
    let context = V3AttemptMaterializationContext::new(budget.clone());
    let mut raw = context.reserve(5).unwrap();
    let reducer = context.reserve(3).unwrap();
    assert!(context.reserve(1).is_err());
    let transferred = raw.split_off(2).unwrap();
    assert_eq!(process.load(Ordering::Acquire), 8);
    assert!(raw.split_off(4).is_err());
    drop(raw);
    assert_eq!(process.load(Ordering::Acquire), 5);
    drop(transferred);
    drop(reducer);
    assert_eq!(budget.request_resident_bytes(), 0);
    assert_eq!(process.load(Ordering::Acquire), 0);
}

#[test]
fn materialization_failed_request_or_process_reservation_rolls_back_attempt() {
    for (request_limit, process_limit) in [(5, 32), (32, 5)] {
        let process = Arc::new(AtomicUsize::new(0));
        let budget = V3AttemptBudget::new_isolated(
            test_limits(8, request_limit, process_limit),
            process.clone(),
        );
        let context = V3AttemptMaterializationContext::new(budget.clone());
        let first = context.reserve(4).unwrap();
        assert!(context.reserve(2).is_err());
        assert_eq!(context.inner.resident_bytes.load(Ordering::Acquire), 4);
        assert_eq!(process.load(Ordering::Acquire), 4);
        drop(first);
        let recovered = context.reserve(5).unwrap();
        drop(recovered);
        assert_eq!(budget.request_resident_bytes(), 0);
        assert_eq!(process.load(Ordering::Acquire), 0);
    }
}

#[test]
fn materialization_releases_discarded_input_and_replaced_state() {
    let process = Arc::new(AtomicUsize::new(0));
    let budget = V3AttemptBudget::new_isolated(test_limits(8, 16, 32), process.clone());
    let context = V3AttemptMaterializationContext::new(budget.clone());
    let mut state = context.reserve(3).unwrap();
    for _ in 0..100 {
        let comment = context.reserve(5).unwrap();
        drop(comment);
    }
    state.grow(4).unwrap();
    assert!(state.grow(2).is_err());
    assert!(state.shrink_to(8).is_err());
    state.shrink_to(2).unwrap();
    assert_eq!(process.load(Ordering::Acquire), 2);
    drop(state);
    assert_eq!(budget.request_resident_bytes(), 0);
    assert_eq!(process.load(Ordering::Acquire), 0);
}

#[tokio::test]
async fn materialization_projection_shares_attempt_capacity_and_keeps_sealed_lease() {
    let process = Arc::new(AtomicUsize::new(0));
    let budget = V3AttemptBudget::new_isolated(test_limits(8, 32, 64), process.clone());
    let context = V3AttemptMaterializationContext::new(budget.clone());
    let canonical = context.reserve(5).unwrap();
    let mut projected = V3CommittedClientSseBuilder::with_materialization_context(context).unwrap();
    assert!(
        projected.push(vec![1; 4]).is_err(),
        "canonical and encoded frames share one attempt ceiling"
    );
    projected.push(vec![1; 3]).unwrap();
    assert_eq!(process.load(Ordering::Acquire), 8);
    projected.mark_last_frame_as_terminal().unwrap();
    let mut sealed = projected.seal_after_validated_terminal().unwrap();
    drop(canonical);
    assert_eq!(process.load(Ordering::Acquire), 3);
    assert_eq!(sealed.next().await.unwrap(), vec![1; 3]);
    assert_eq!(
        process.load(Ordering::Acquire),
        3,
        "the sealed replay still owns retained frames"
    );
    drop(sealed);
    assert_eq!(process.load(Ordering::Acquire), 0);
    assert_eq!(budget.request_resident_bytes(), 0);
}

#[test]
fn materialization_shared_sealed_frames_keep_reservation_after_stream_drop() {
    let process = Arc::new(AtomicUsize::new(0));
    let budget = V3AttemptBudget::new_isolated(test_limits(8, 16, 32), process.clone());
    let mut builder = V3CommittedClientSseBuilder::with_budget(budget.clone()).unwrap();
    builder.push(vec![1; 5]).unwrap();
    builder.mark_last_frame_as_terminal().unwrap();
    let stream = builder.seal_after_validated_terminal().unwrap();
    let retained = stream.sealed_frames();
    drop(stream);
    assert_eq!(retained.as_slice(), &[vec![1; 5]]);
    assert_eq!(
        process.load(Ordering::Acquire),
        5,
        "retained frame allocation outlives its replay stream"
    );
    drop(retained);
    assert_eq!(process.load(Ordering::Acquire), 0);
    assert_eq!(budget.request_resident_bytes(), 0);
}

#[tokio::test]
async fn materialization_adopts_prefix_without_double_charge_or_accounting_gap() {
    let process = Arc::new(AtomicUsize::new(0));
    let budget = V3AttemptBudget::new_isolated(test_limits(8, 8, 8), process.clone());
    let mut prefix = V3AttemptPrefixBuffer::new(budget.clone()).unwrap();
    prefix.push(vec![1; 5]).unwrap();
    let mut holder = V3RetainedPrefixReservation::default();
    let mut replay = prefix
        .replay_retained(Box::pin(futures_util::stream::empty()), &mut holder)
        .unwrap();
    let context = V3AttemptMaterializationContext::new(budget.clone());
    let lease = context.adopt_prefix(&mut holder).unwrap();
    assert_eq!(
        process.load(Ordering::Acquire),
        5,
        "adoption never reserves the same raw allocation twice"
    );
    assert!(holder.reservation.is_none());
    let raw = replay.next().await.unwrap().unwrap();
    assert!(replay.next().await.is_none());
    drop(replay);
    drop(holder);
    assert_eq!(context.inner.resident_bytes.load(Ordering::Acquire), 5);
    assert_eq!(
        process.load(Ordering::Acquire),
        5,
        "EOF does not release raw chunks retained by the consumer"
    );
    drop(raw);
    drop(lease);
    assert_eq!(process.load(Ordering::Acquire), 0);
}

#[test]
fn materialization_prefix_admission_failure_preserves_original_owner() {
    let process = Arc::new(AtomicUsize::new(0));
    let budget = V3AttemptBudget::new_isolated(test_limits(8, 32, 64), process.clone());
    let mut prefix = V3AttemptPrefixBuffer::new(budget.clone()).unwrap();
    prefix.push(vec![1; 5]).unwrap();
    let mut holder = V3RetainedPrefixReservation::default();
    let replay = prefix
        .replay_retained(Box::pin(futures_util::stream::empty()), &mut holder)
        .unwrap();
    let context = V3AttemptMaterializationContext::new(budget);
    let reducer = context.reserve(4).unwrap();
    assert!(context.adopt_prefix(&mut holder).is_err());
    assert_eq!(holder.reservation.as_ref().unwrap().bytes, 5);
    assert_eq!(context.inner.resident_bytes.load(Ordering::Acquire), 4);
    assert_eq!(process.load(Ordering::Acquire), 9);
    drop(replay);
    drop(holder);
    drop(reducer);
    assert_eq!(process.load(Ordering::Acquire), 0);
}

#[tokio::test]
async fn materialization_json_projection_admits_encoded_bytes_before_retention() {
    let process = Arc::new(AtomicUsize::new(0));
    let budget = V3AttemptBudget::new_isolated(test_limits(96, 128, 256), process.clone());
    let context = V3AttemptMaterializationContext::new(budget.clone());
    let canonical = context.reserve(70).unwrap();
    let mut builder = V3CommittedClientSseBuilder::with_materialization_context(context).unwrap();
    assert!(builder
        .push_json_event(
            Some("response.delta"),
            &serde_json::json!({"text":"too large"})
        )
        .is_err());
    assert_eq!(process.load(Ordering::Acquire), 70);
    assert!(builder.frames.is_empty());
    drop(canonical);
    let payload = serde_json::json!({"text":"a\n\"雪"});
    let expected = format!("event: response.delta\ndata: {payload}\n\n").into_bytes();
    builder
        .push_json_event(Some("response.delta"), &payload)
        .unwrap();
    assert_eq!(process.load(Ordering::Acquire), expected.len());
    builder.mark_last_frame_as_terminal().unwrap();
    let mut stream = builder.seal_after_validated_terminal().unwrap();
    assert_eq!(stream.next().await.unwrap(), expected);
    drop(stream);
    assert_eq!(budget.request_resident_bytes(), 0);
    assert_eq!(process.load(Ordering::Acquire), 0);
}

#[tokio::test]
async fn materialization_raw_chunks_keep_independent_leases_across_polls() {
    let process = Arc::new(AtomicUsize::new(0));
    let budget = V3AttemptBudget::new_isolated(test_limits(8, 16, 32), process.clone());
    let mut prefix = V3AttemptPrefixBuffer::new(budget.clone()).unwrap();
    prefix.push(vec![1; 5]).unwrap();
    let tail = Box::pin(futures_util::stream::iter(vec![
        Ok(vec![2; 3]),
        Ok(vec![3; 1]),
    ]));
    let mut holder = V3RetainedPrefixReservation::default();
    let source = prefix.replay_retained(tail, &mut holder).unwrap();
    let context = V3AttemptMaterializationContext::new(budget.clone());
    let mut stream = V3MaterializationInputStream::new(source, context, &mut holder).unwrap();
    let first = stream.next().await.unwrap().ok().unwrap();
    let second = stream.next().await.unwrap().ok().unwrap();
    assert_eq!(first.bytes, vec![1; 5]);
    assert_eq!(second.bytes, vec![2; 3]);
    assert_eq!(
        process.load(Ordering::Acquire),
        8,
        "polling next does not release a retained previous chunk"
    );
    assert!(matches!(
        stream.next().await.unwrap(),
        Err(V3MaterializationInputError::LocalStore(_))
    ));
    drop(stream);
    assert_eq!(
        process.load(Ordering::Acquire),
        8,
        "cancelling input does not release chunks still held by its consumer"
    );
    drop(first);
    drop(second);
    assert_eq!(budget.request_resident_bytes(), 0);
    assert_eq!(process.load(Ordering::Acquire), 0);
}

#[tokio::test]
async fn raw_prefix_reservation_survives_yield_and_releases_on_cancel() {
    let process = Arc::new(AtomicUsize::new(0));
    let budget = V3AttemptBudget::new_isolated(test_limits(8, 8, 8), process.clone());
    let mut prefix = V3AttemptPrefixBuffer::new(budget.clone()).unwrap();
    prefix.push(vec![1; 3]).unwrap();
    prefix.push(vec![2; 4]).unwrap();
    assert_eq!(process.load(Ordering::Acquire), 7);
    let mut replay = prefix.replay(Box::pin(futures_util::stream::empty()));
    let first = replay.next().await.unwrap().unwrap();
    assert_eq!(
        process.load(Ordering::Acquire),
        7,
        "yielded raw bytes remain owned by the consumer"
    );
    drop(first);
    let second = replay.next().await.unwrap().unwrap();
    assert_eq!(
        process.load(Ordering::Acquire),
        4,
        "completed preceding chunk releases exactly once"
    );
    drop(second);
    drop(replay);
    assert_eq!(process.load(Ordering::Acquire), 0);
    assert_eq!(budget.request_resident_bytes(), 0);
}

#[test]
fn raw_prefix_failed_capacity_reservation_does_not_leak() {
    let process = Arc::new(AtomicUsize::new(0));
    let budget = V3AttemptBudget::new_isolated(test_limits(8, 8, 8), process.clone());
    let mut prefix = V3AttemptPrefixBuffer::new(budget.clone()).unwrap();
    prefix.push(vec![1; 5]).unwrap();
    assert!(matches!(
        prefix.push(vec![2; 4]),
        Err(V3AttemptStoreError::LocalResourceExhausted(_))
    ));
    assert_eq!(process.load(Ordering::Acquire), 5);
    drop(prefix);
    assert_eq!(process.load(Ordering::Acquire), 0);
    assert_eq!(budget.request_resident_bytes(), 0);
}

#[tokio::test]
async fn raw_prefix_retained_collector_keeps_reservation_after_replay_eof() {
    let process = Arc::new(AtomicUsize::new(0));
    let budget = V3AttemptBudget::new_isolated(test_limits(8, 8, 8), process.clone());
    let mut prefix = V3AttemptPrefixBuffer::new(budget.clone()).unwrap();
    prefix.push(vec![1; 5]).unwrap();
    let mut retained = V3RetainedPrefixReservation::default();
    let mut replay = prefix
        .replay_retained(Box::pin(futures_util::stream::empty()), &mut retained)
        .unwrap();
    let chunk = replay.next().await.unwrap().unwrap();
    assert!(replay.next().await.is_none());
    drop(replay);
    assert_eq!(
        process.load(Ordering::Acquire),
        5,
        "the raw collector still retains the chunk after stream EOF"
    );
    drop(chunk);
    drop(retained);
    assert_eq!(process.load(Ordering::Acquire), 0);
    assert_eq!(budget.request_resident_bytes(), 0);
}

fn test_limits(
    attempt_max_bytes: usize,
    request_max_bytes: usize,
    process_max_bytes: usize,
) -> V3AttemptStoreLimits {
    V3AttemptStoreLimits {
        attempt_max_bytes,
        attempt_max_frames: 3,
        request_max_bytes,
        process_max_bytes,
        residence_timeout: Duration::from_secs(60),
    }
}

#[tokio::test]
async fn transport_attempt_admission_continues_without_legacy_ceiling() {
    let mut limits = test_limits(8, 16, 32);
    limits.residence_timeout = Duration::from_millis(30);
    let budget = V3AttemptBudget::new_isolated(limits, Arc::new(AtomicUsize::new(0)));
    assert_eq!(budget.admit_transport_attempt().unwrap(), 1);
    assert_eq!(budget.admit_transport_attempt().unwrap(), 2);
    assert_eq!(budget.transport_attempts(), 2);
}

#[tokio::test]
async fn issue9bb26d4_semantic_storage_preserves_capacity_and_original_admission_deadline() {
    let mut limits = test_limits(4, 4, 4);
    limits.residence_timeout = Duration::from_millis(30);
    let process = Arc::new(AtomicUsize::new(0));
    let budget = V3AttemptBudget::new_isolated(limits, process.clone());
    let original_deadline = budget.residence_deadline();
    let mut attempt = V3CommittedClientSseBuilder::with_budget(budget.clone()).unwrap();
    attempt.push(vec![1, 2]).unwrap();
    attempt.observe_semantic_output();
    tokio::time::sleep(Duration::from_millis(60)).await;
    assert_eq!(budget.residence_deadline(), original_deadline);
    attempt.push(vec![3, 4]).unwrap();
    assert!(
        matches!(
            attempt.push(vec![5]),
            Err(V3AttemptStoreError::LocalResourceExhausted(_))
        ),
        "semantic output must not relax the byte limit"
    );
    assert_eq!(process.load(Ordering::Acquire), 4);
    attempt.mark_last_frame_as_terminal().unwrap();
    let replay = attempt.seal_after_validated_terminal().unwrap();
    assert_eq!(
        process.load(Ordering::Acquire),
        4,
        "replay owns the retained bytes"
    );
    drop(replay);
    assert_eq!(process.load(Ordering::Acquire), 0);
    assert_eq!(budget.admit_transport_attempt().unwrap(), 1);
    assert_eq!(budget.residence_deadline(), original_deadline);
    assert_eq!(budget.attempt_deadline(), None);
    assert!(!budget.active_stream_has_semantic_progress());
}

#[test]
fn direct_dsml_complete_rewrite_keeps_budget_and_terminal_reservation() {
    let process = Arc::new(AtomicUsize::new(0));
    let budget = V3AttemptBudget::new_isolated(test_limits(8, 8, 8), process.clone());
    let mut builder = V3CommittedClientSseBuilder::with_budget(budget.clone()).unwrap();
    builder.push(vec![1, 2]).unwrap();
    builder.mark_last_frame_as_terminal().unwrap();
    builder
        .rewrite_complete_attempt::<V3AttemptStoreError>(|_| {
            Ok(Some((vec![vec![3, 4], vec![5, 6]], 1)))
        })
        .unwrap();
    assert_eq!(process.load(Ordering::Acquire), 4);
    assert_eq!(builder.terminal_frame_index, Some(1));
    assert!(matches!(
        builder.rewrite_complete_attempt(|_| Ok::<_, V3AttemptStoreError>(Some((
            vec![vec![0; 9]],
            0
        )))),
        Err(V3AttemptStoreError::LocalResourceExhausted(_))
    ));
    assert_eq!(process.load(Ordering::Acquire), 4);
    builder
        .rewrite_complete_attempt::<V3AttemptStoreError>(|_| Ok(Some((vec![vec![7]], 0))))
        .unwrap();
    assert_eq!(process.load(Ordering::Acquire), 1);
    drop(builder);
    assert_eq!(process.load(Ordering::Acquire), 0);
}

#[test]
fn unsent_capacity_rejection_releases_only_pending_attempt() {
    let budget = V3AttemptBudget::new_isolated(test_limits(8, 8, 8), Arc::new(AtomicUsize::new(0)));
    assert_eq!(budget.admit_transport_attempt().unwrap(), 1);
    for _ in 0..10 {
        assert_eq!(budget.admit_transport_attempt().unwrap(), 2);
        budget.release_unsent_transport_attempt();
        assert_eq!(budget.transport_attempts(), 1);
    }
    assert_eq!(budget.admit_transport_attempt().unwrap(), 2);
    assert_eq!(budget.admit_transport_attempt().unwrap(), 3);
    assert_eq!(budget.admit_transport_attempt().unwrap(), 4);
    assert_eq!(budget.transport_attempts(), 4);
}

#[test]
fn attempt_budget_counts_all_transport_attempts_past_legacy_ceiling() {
    let process_bytes = Arc::new(AtomicUsize::new(0));
    let budget = V3AttemptBudget::new_isolated(test_limits(8, 8, 8), Arc::clone(&process_bytes));

    for expected in 1..=12 {
        assert_eq!(budget.admit_transport_attempt().unwrap(), expected);
    }
    assert_eq!(budget.transport_attempts(), 12);
    assert_eq!(process_bytes.load(Ordering::Acquire), 0);
}

#[test]
fn begin_refill_opens_a_new_scan_without_reusing_prior_attempt_count() {
    let budget = V3AttemptBudget::new_isolated(test_limits(8, 8, 8), Arc::new(AtomicUsize::new(0)));
    assert_eq!(budget.admit_transport_attempt().unwrap(), 1);
    assert_eq!(budget.admit_transport_attempt().unwrap(), 2);
    budget
        .record_request_candidate_attempt("provider/interface/key/model".into(), 0)
        .unwrap();
    let control = V3RequestExecutionControl {
        attempt_budget: budget.clone(),
    };
    control.begin_refill_execution();
    assert_eq!(budget.transport_attempts(), 0);
    assert!(budget.request_candidate_attempts().unwrap().is_empty());
}

#[test]
fn attempt_budget_consumes_compiled_server_policy() {
    let manifest = compile_v3_config_05_manifest(
        parse_v3_config_02_authoring(
            r#"
version = 3
[pipelines.hub_v1]
skeleton = "hub_v1"
[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"
[servers.test.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "refill", "dry_run"]
allowed_transports = ["json", "sse"]
attempt_store = { attempt_max_bytes = 11, attempt_max_frames = 12, request_max_bytes = 13, process_max_bytes = 14, residence_timeout_ms = 15 }
[providers.test]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "test-model"
auth = { type = "api_key", entries = [{ alias = "key", env = "TEST_KEY" }] }
[providers.test.models.test-model]
capabilities = ["text"]
[route_groups.default.pools.default]
targets = [{ kind = "provider_model", provider = "test", model = "test-model", priority = 1 }]
"#,
        )
        .unwrap(),
    )
    .unwrap();

    let budget = V3AttemptBudget::from_manifest(&manifest, "test").unwrap();
    assert_eq!(budget.inner.limits.attempt_max_bytes, 11);
    assert_eq!(budget.inner.limits.attempt_max_frames, 12);
    assert_eq!(budget.inner.limits.request_max_bytes, 13);
    assert_eq!(budget.inner.limits.process_max_bytes, 14);
    assert_eq!(
        budget.inner.limits.residence_timeout,
        Duration::from_millis(15)
    );
    assert!(matches!(
        V3AttemptBudget::from_manifest(&manifest, "missing"),
        Err(V3AttemptStoreError::InvalidAttemptState(_))
    ));
}

#[test]
fn attempt_store_reserves_before_append_and_releases_on_drop() {
    let process_bytes = Arc::new(AtomicUsize::new(0));
    let budget = V3AttemptBudget::new_isolated(test_limits(4, 4, 4), Arc::clone(&process_bytes));
    let mut builder = V3CommittedClientSseBuilder::with_budget(budget.clone()).unwrap();
    builder.push(vec![1, 2, 3, 4]).unwrap();
    assert_eq!(budget.request_resident_bytes(), 4);
    assert_eq!(process_bytes.load(Ordering::Acquire), 4);
    let error = builder.push(vec![5]).unwrap_err();
    assert!(matches!(
        error,
        V3AttemptStoreError::LocalResourceExhausted(_)
    ));
    assert_eq!(budget.request_resident_bytes(), 4);
    assert_eq!(process_bytes.load(Ordering::Acquire), 4);
    drop(builder);
    assert_eq!(budget.request_resident_bytes(), 0);
    assert_eq!(process_bytes.load(Ordering::Acquire), 0);
}

#[test]
fn attempt_store_process_budget_is_shared_across_requests() {
    let process_bytes = Arc::new(AtomicUsize::new(0));
    let first_budget =
        V3AttemptBudget::new_isolated(test_limits(8, 8, 6), Arc::clone(&process_bytes));
    let second_budget =
        V3AttemptBudget::new_isolated(test_limits(8, 8, 6), Arc::clone(&process_bytes));
    let mut first = V3CommittedClientSseBuilder::with_budget(first_budget).unwrap();
    first.push(vec![1, 2, 3, 4]).unwrap();
    let mut second = V3CommittedClientSseBuilder::with_budget(second_budget).unwrap();
    let error = second.push(vec![5, 6, 7]).unwrap_err();
    assert!(matches!(
        error,
        V3AttemptStoreError::LocalResourceExhausted(_)
    ));
    assert_eq!(process_bytes.load(Ordering::Acquire), 4);
}

#[test]
fn attempt_store_request_budget_is_shared_across_attempts() {
    let process_bytes = Arc::new(AtomicUsize::new(0));
    let budget = V3AttemptBudget::new_isolated(test_limits(8, 6, 16), Arc::clone(&process_bytes));
    let mut first = V3CommittedClientSseBuilder::with_budget(budget.clone()).unwrap();
    first.push(vec![1, 2, 3, 4]).unwrap();
    let mut second = V3CommittedClientSseBuilder::with_budget(budget.clone()).unwrap();
    let error = second.push(vec![5, 6, 7]).unwrap_err();
    assert!(matches!(
        error,
        V3AttemptStoreError::LocalResourceExhausted(_)
    ));
    drop(first);
    second.push(vec![5, 6, 7]).unwrap();
    assert_eq!(budget.request_resident_bytes(), 3);
}

#[test]
fn execution_control_payload_architecture_responses_replay_reuses_request_reservation() {
    let process_bytes = Arc::new(AtomicUsize::new(0));
    let mut limits = test_limits(8_192, 4_096, 16_384);
    limits.attempt_max_frames = 16;
    let budget = V3AttemptBudget::new_isolated(limits, Arc::clone(&process_bytes));
    let mut provider_attempt = V3CommittedClientSseBuilder::with_budget(budget.clone()).unwrap();
    provider_attempt.push(vec![0; 4_095]).unwrap();

    let error = match crate::hub_v1::build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05_with_budget(
        serde_json::json!({"id": "resp-shared-budget", "status": "completed", "output": []}),
        budget.clone(),
    ) {
        Ok(_) => panic!("client replay must not escape the active request reservation"),
        Err(error) => error,
    };
    assert!(error.contains("request provider SSE resident byte limit"));
    assert_eq!(budget.request_resident_bytes(), 4_095);

    drop(provider_attempt);
    let replay = crate::hub_v1::build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05_with_budget(
        serde_json::json!({"id": "resp-shared-budget", "status": "completed", "output": []}),
        budget.clone(),
    )
    .expect("released provider reservation must admit the same request replay");
    drop(replay);
    assert_eq!(budget.request_resident_bytes(), 0);
    assert_eq!(process_bytes.load(Ordering::Acquire), 0);
}

#[test]
fn execution_control_payload_architecture_anthropic_replay_reuses_request_reservation() {
    let process_bytes = Arc::new(AtomicUsize::new(0));
    let budget = V3AttemptBudget::new_isolated(
        test_limits(8_192, 4_096, 16_384),
        Arc::clone(&process_bytes),
    );
    let mut provider_attempt = V3CommittedClientSseBuilder::with_budget(budget.clone()).unwrap();
    provider_attempt.push(vec![0; 4_095]).unwrap();
    let response = serde_json::json!({
        "events": [{
            "event": "message_stop",
            "data": {"type": "message_stop"}
        }]
    });

    let error = match crate::hub_v1::project_v3_anthropic_client_sse_stream_with_budget(
        response.clone(),
        budget.clone(),
    ) {
        Ok(_) => panic!("client replay must not escape the active request reservation"),
        Err(error) => error,
    };
    assert!(error.contains("request provider SSE resident byte limit"));
    assert_eq!(budget.request_resident_bytes(), 4_095);

    drop(provider_attempt);
    let replay =
        crate::hub_v1::project_v3_anthropic_client_sse_stream_with_budget(response, budget.clone())
            .expect("released provider reservation must admit the same request replay");
    drop(replay);
    assert_eq!(budget.request_resident_bytes(), 0);
    assert_eq!(process_bytes.load(Ordering::Acquire), 0);
}

#[test]
fn attempt_store_rejects_expired_request_before_reservation() {
    let process_bytes = Arc::new(AtomicUsize::new(0));
    let mut limits = test_limits(8, 8, 8);
    limits.residence_timeout = Duration::ZERO;
    let budget = V3AttemptBudget::new_isolated(limits, Arc::clone(&process_bytes));
    let error = match V3CommittedClientSseBuilder::with_budget(budget) {
        Ok(_) => panic!("expired request budget must reject a new attempt store"),
        Err(error) => error,
    };
    assert!(matches!(
        error,
        V3AttemptStoreError::ResidenceDeadlineExceeded(_)
    ));
    assert_eq!(process_bytes.load(Ordering::Acquire), 0);
}

#[test]
fn sealed_replay_holds_reservation_until_stream_drop() {
    let process_bytes = Arc::new(AtomicUsize::new(0));
    let budget = V3AttemptBudget::new_isolated(test_limits(8, 8, 8), Arc::clone(&process_bytes));
    let mut builder = V3CommittedClientSseBuilder::with_budget(budget.clone()).unwrap();
    builder.push(vec![1, 2, 3]).unwrap();
    builder.mark_last_frame_as_terminal().unwrap();
    let stream = builder.seal_after_validated_terminal().unwrap();
    assert_eq!(budget.request_resident_bytes(), 3);
    drop(stream);
    assert_eq!(budget.request_resident_bytes(), 0);
    assert_eq!(process_bytes.load(Ordering::Acquire), 0);
}

async fn observed_terminal_after_drop(frames_to_consume: usize) -> V3CommittedSseTerminal {
    let mut builder = V3CommittedClientSseBuilder::new();
    builder
        .push(b"event: response.created\n\n".to_vec())
        .unwrap();
    builder
        .push(b"event: response.completed\n\n".to_vec())
        .unwrap();
    builder.mark_last_frame_as_terminal().unwrap();
    builder.push(b"event: ping\n\n".to_vec()).unwrap();
    let terminal = Arc::new(Mutex::new(None));
    let observed_terminal = Arc::clone(&terminal);
    let mut stream = builder.seal_after_validated_terminal().unwrap().observe(
        |_| {},
        move |value| {
            *observed_terminal.lock().unwrap() = Some(value);
        },
    );
    for _ in 0..frames_to_consume {
        stream.next().await.expect("sealed replay frame");
    }
    drop(stream);
    let terminal = terminal
        .lock()
        .unwrap()
        .expect("drop must finalize the committed handoff");
    terminal
}

#[tokio::test]
async fn committed_sse_terminal_callback_waits_until_terminal_frame_is_returned() {
    let mut builder = V3CommittedClientSseBuilder::new();
    builder
        .push(b"event: response.completed\n\n".to_vec())
        .unwrap();
    builder.mark_last_frame_as_terminal().unwrap();
    let terminal = Arc::new(Mutex::new(None));
    let observed_terminal = Arc::clone(&terminal);
    let terminal_writer = Arc::clone(&terminal);
    let mut stream = builder.seal_after_validated_terminal().unwrap().observe(
        move |_| {
            assert!(
                observed_terminal.lock().unwrap().is_none(),
                "terminal callback must not run during frame callback"
            );
        },
        move |value| {
            *terminal_writer.lock().unwrap() = Some(value);
        },
    );

    assert!(stream.next().await.is_some());
    assert!(terminal.lock().unwrap().is_none());
    assert!(stream.next().await.is_none());
    assert_eq!(
        terminal.lock().unwrap().as_ref(),
        Some(&V3CommittedSseTerminal::Completed)
    );
}

#[tokio::test]
async fn committed_sse_drop_before_last_handoff_frame_remains_dropped() {
    assert_eq!(
        observed_terminal_after_drop(1).await,
        V3CommittedSseTerminal::Dropped
    );
}

#[tokio::test]
async fn committed_sse_drop_after_last_handoff_frame_is_completed() {
    assert_eq!(
        observed_terminal_after_drop(2).await,
        V3CommittedSseTerminal::Completed
    );
}

#[tokio::test]
async fn committed_sse_drop_before_held_terminal_after_flushed_prefix_is_dropped() {
    let mut builder = V3CommittedClientSseBuilder::new();
    let (sink, _rx) = V3CommittedClientFrameSink::channel();
    builder
        .push(b"event: response.created\n\n".to_vec())
        .unwrap();
    builder
        .push(b"event: response.output_text.delta\n\n".to_vec())
        .unwrap();
    builder.commit_client_stream(sink);
    builder.hold_client_flush();
    builder
        .push(b"event: response.output_text.delta\n\n".to_vec())
        .unwrap();
    builder
        .push(b"event: response.output_text.delta\n\n".to_vec())
        .unwrap();
    builder
        .push(b"event: response.completed\n\n".to_vec())
        .unwrap();
    builder.mark_last_frame_as_terminal().unwrap();

    let terminal = Arc::new(Mutex::new(None));
    let observed_terminal = Arc::clone(&terminal);
    let mut stream = builder.seal_after_validated_terminal().unwrap().observe(
        |_| {},
        move |value| {
            *observed_terminal.lock().unwrap() = Some(value);
        },
    );
    stream.next().await.expect("one held nonterminal frame");
    drop(stream);

    assert_eq!(
        terminal.lock().unwrap().as_ref(),
        Some(&V3CommittedSseTerminal::Dropped),
        "the held terminal must remain unconsumed"
    );
}

#[tokio::test]
async fn first_frame_commit_flushes_delivered_frames_before_terminal() {
    let mut builder = V3CommittedClientSseBuilder::new();
    let (sink, mut rx) = V3CommittedClientFrameSink::channel();
    builder.push(b"frame-a".to_vec()).unwrap();
    assert!(rx.try_recv().is_err(), "no delivery before commit");
    builder.commit_client_stream(sink);
    assert_eq!(rx.try_recv().unwrap(), b"frame-a".to_vec());
    assert_eq!(builder.client_frames_flushed(), 1);
    builder.push(b"frame-b".to_vec()).unwrap();
    assert_eq!(rx.try_recv().unwrap(), b"frame-b".to_vec());
    builder.push(b"frame-c".to_vec()).unwrap();
    builder.mark_last_frame_as_terminal().unwrap();
    assert_eq!(rx.try_recv().unwrap(), b"frame-c".to_vec());
    assert_eq!(builder.client_frames_flushed(), 3);
    let sealed = builder.seal_after_validated_terminal().unwrap();
    let remainder: Vec<Vec<u8>> = sealed.collect().await;
    assert!(remainder.is_empty(), "every frame already delivered");
    assert!(rx.try_recv().is_err(), "no duplicate delivery");
}

#[tokio::test]
async fn first_frame_commit_seal_remainder_preserves_byte_identity() {
    let frames = [
        b"created".to_vec(),
        b"delta1".to_vec(),
        b"delta2".to_vec(),
        b"terminal".to_vec(),
    ];
    let mut delivered = Vec::new();
    {
        let mut builder = V3CommittedClientSseBuilder::new();
        let (sink, mut rx) = V3CommittedClientFrameSink::channel();
        builder.push(frames[0].clone()).unwrap();
        builder.push(frames[1].clone()).unwrap();
        builder.commit_client_stream(sink);
        builder.push(frames[2].clone()).unwrap();
        builder.push(frames[3].clone()).unwrap();
        builder.mark_last_frame_as_terminal().unwrap();
        let sealed = builder.seal_after_validated_terminal().unwrap();
        while let Ok(frame) = rx.try_recv() {
            delivered.push(frame);
        }
        delivered.extend(sealed.collect::<Vec<_>>().await);
    }
    let mut buffered = Vec::new();
    {
        let mut builder = V3CommittedClientSseBuilder::new();
        for frame in &frames {
            builder.push(frame.clone()).unwrap();
        }
        builder.mark_last_frame_as_terminal().unwrap();
        buffered.extend(
            builder
                .seal_after_validated_terminal()
                .unwrap()
                .collect::<Vec<_>>()
                .await,
        );
    }
    assert_eq!(
        delivered, buffered,
        "streamed path must equal buffered path byte for byte"
    );
    assert_eq!(delivered, frames.to_vec());
}

#[test]
fn first_frame_commit_rejects_whole_attempt_rewrite_after_delivery() {
    let mut builder = V3CommittedClientSseBuilder::new();
    let (sink, _rx) = V3CommittedClientFrameSink::channel();
    builder.push(vec![1]).unwrap();
    builder.commit_client_stream(sink);
    builder.push(vec![2]).unwrap();
    assert!(matches!(
        builder.rewrite_frames_non_increasing(|frame| frame),
        Err(V3AttemptStoreError::InvalidAttemptState(_))
    ));
    assert!(matches!(
        builder.rewrite_complete_attempt::<V3AttemptStoreError>(|_| Ok(Some((vec![vec![9]], 0)))),
        Err(V3AttemptStoreError::InvalidAttemptState(_))
    ));
}

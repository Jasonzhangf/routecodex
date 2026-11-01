use super::*;
use futures_util::StreamExt;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use std::sync::{Arc, Mutex};

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
        None
    );
}

fn test_limits(
    attempt_max_bytes: usize,
    request_max_bytes: usize,
    process_max_bytes: usize,
) -> V3AttemptStoreLimits {
    V3AttemptStoreLimits {
        request_max_attempts: 3,
        attempt_max_bytes,
        attempt_max_frames: 3,
        request_max_bytes,
        process_max_bytes,
        residence_timeout: Duration::from_secs(60),
    }
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
    // One actual HTTP429 keeps its wire sequence, but not a failure allowance.
    assert_eq!(budget.admit_transport_attempt().unwrap(), 1);
    budget.record_rate_limited_attempt();
    for _ in 0..10 {
        assert_eq!(budget.admit_transport_attempt().unwrap(), 2);
        budget.release_unsent_transport_attempt();
        assert_eq!(budget.transport_attempts(), 1);
    }
    assert_eq!(budget.admit_transport_attempt().unwrap(), 2);
    assert_eq!(budget.admit_transport_attempt().unwrap(), 3);
    assert_eq!(budget.admit_transport_attempt().unwrap(), 4);
    assert!(budget.admit_transport_attempt().is_err());
    assert_eq!(budget.transport_attempts(), 4);
}

#[test]
fn attempt_budget_counts_all_transport_attempts_without_reset() {
    let process_bytes = Arc::new(AtomicUsize::new(0));
    let budget = V3AttemptBudget::new_isolated(test_limits(8, 8, 8), Arc::clone(&process_bytes));

    assert_eq!(budget.admit_transport_attempt().unwrap(), 1);
    assert_eq!(budget.admit_transport_attempt().unwrap(), 2);
    assert_eq!(budget.admit_transport_attempt().unwrap(), 3);
    assert!(matches!(
        budget.admit_transport_attempt(),
        Err(V3AttemptStoreError::TransportAttemptsExhausted(_))
    ));
    assert_eq!(budget.transport_attempts(), 3);
    assert_eq!(process_bytes.load(Ordering::Acquire), 0);
}

#[test]
fn issue44cc3af_429_wait_does_not_consume_failure_slots_or_reset_attempt_sequence() {
    let budget = V3AttemptBudget::new_isolated(test_limits(8, 8, 8), Arc::new(AtomicUsize::new(0)));
    assert_eq!(budget.admit_transport_attempt().unwrap(), 1);
    budget.record_rate_limited_attempt();
    assert_eq!(budget.admit_transport_attempt().unwrap(), 2);
    budget.record_rate_limited_attempt();
    assert_eq!(budget.admit_transport_attempt().unwrap(), 3);
    assert_eq!(budget.admit_transport_attempt().unwrap(), 4);
    assert_eq!(budget.admit_transport_attempt().unwrap(), 5);
    assert!(
        budget.admit_transport_attempt().is_err(),
        "non-429 failures remain bounded"
    );
    assert_eq!(budget.transport_attempts(), 5);
}

#[test]
fn attempt_budget_preserves_configured_hard_limit() {
    let process_bytes = Arc::new(AtomicUsize::new(0));
    let mut limits = test_limits(8, 8, 8);
    limits.request_max_attempts = 5;
    let budget = V3AttemptBudget::new_isolated(limits, process_bytes);
    for expected in 1..=5 {
        assert_eq!(budget.admit_transport_attempt().unwrap(), expected);
    }
    assert!(matches!(
        budget.admit_transport_attempt(),
        Err(V3AttemptStoreError::TransportAttemptsExhausted(message))
            if message.contains("limit 5")
    ));
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

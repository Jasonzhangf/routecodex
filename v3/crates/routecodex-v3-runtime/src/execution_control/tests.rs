use super::*;
use futures_util::StreamExt;
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use std::sync::{Arc, Mutex};

fn test_limits() -> V3AttemptStoreLimits {
    V3AttemptStoreLimits {
        residence_timeout: Duration::from_secs(60),
    }
}

#[test]
fn direct_dsml_complete_rewrite_preserves_frames_and_terminal() {
    let budget = V3AttemptBudget::new(test_limits());
    let mut builder = V3CommittedClientSseBuilder::with_budget(budget.clone()).unwrap();
    builder.push(vec![1, 2]).unwrap();
    builder.mark_last_frame_as_terminal().unwrap();
    builder
        .rewrite_complete_attempt::<V3AttemptStoreError>(|_| {
            Ok(Some((vec![vec![3, 4], vec![5, 6]], 1)))
        })
        .unwrap();
    assert_eq!(builder.frames(), &[vec![3, 4], vec![5, 6]]);
    assert_eq!(builder.byte_len, 4);
    assert_eq!(builder.terminal_frame_index, Some(1));
    builder
        .rewrite_complete_attempt(|_| Ok::<_, V3AttemptStoreError>(Some((vec![vec![0; 9]], 0))))
        .unwrap();
    assert_eq!(builder.frames(), &[vec![0; 9]]);
    assert_eq!(builder.byte_len, 9);
    builder
        .rewrite_complete_attempt::<V3AttemptStoreError>(|_| Ok(Some((vec![vec![7]], 0))))
        .unwrap();
    assert_eq!(builder.frames(), &[vec![7]]);
    assert_eq!(builder.byte_len, 1);
    assert_eq!(builder.terminal_frame_index, Some(0));
}

#[test]
fn unsent_capacity_rejection_releases_only_pending_attempt() {
    let budget = V3AttemptBudget::new(test_limits());
    // One real send keeps its wire sequence while unsent reservations roll back.
    assert_eq!(budget.admit_transport_attempt().unwrap(), 1);
    for _ in 0..10 {
        assert_eq!(budget.admit_transport_attempt().unwrap(), 2);
        budget.release_unsent_transport_attempt();
        assert_eq!(budget.transport_attempts(), 1);
    }
    assert_eq!(budget.admit_transport_attempt().unwrap(), 2);
    assert_eq!(budget.admit_transport_attempt().unwrap(), 3);
    assert_eq!(budget.admit_transport_attempt().unwrap(), 4);
    assert_eq!(budget.admit_transport_attempt().unwrap(), 5);
    assert_eq!(budget.transport_attempts(), 5);
}

#[test]
fn attempt_budget_counts_all_transport_attempts_without_reset() {
    let budget = V3AttemptBudget::new(test_limits());

    assert_eq!(budget.admit_transport_attempt().unwrap(), 1);
    assert_eq!(budget.admit_transport_attempt().unwrap(), 2);
    assert_eq!(budget.admit_transport_attempt().unwrap(), 3);
    assert_eq!(budget.admit_transport_attempt().unwrap(), 4);
    assert_eq!(budget.transport_attempts(), 4);
}

#[test]
fn attempt_sequence_has_no_local_hard_limit() {
    let budget = V3AttemptBudget::new(test_limits());
    for expected in 1..=5 {
        assert_eq!(budget.admit_transport_attempt().unwrap(), expected);
    }
    assert_eq!(budget.admit_transport_attempt().unwrap(), 6);
}

#[test]
fn attempt_budget_named_identity_bypasses_hard_limit_without_resetting_sequence() {
    let budget = V3AttemptBudget::new(test_limits());

    // A captured identity is admitted on every typed-authorized send. The
    // captured target and typed eligibility owners, not this count, decide
    // whether an untried tier/default or a recovered identity may send.
    assert_eq!(
        budget
            .admit_transport_attempt_for_identity(Some("A"))
            .unwrap(),
        1
    );
    assert_eq!(
        budget
            .admit_transport_attempt_for_identity(Some("A"))
            .unwrap(),
        2
    );
    assert_eq!(
        budget
            .admit_transport_attempt_for_identity(Some("B"))
            .unwrap(),
        3,
        "the configured ceiling must not block the first real send of B"
    );
    // The real wire sequence is cumulative. Releasing a reservation that never
    // reached the wire rolls back only that pending send.
    budget.release_unsent_transport_attempt();
    assert_eq!(budget.transport_attempts(), 2);
    assert_eq!(
        budget
            .admit_transport_attempt_for_identity(Some("B"))
            .unwrap(),
        3
    );
    assert_eq!(budget.admit_transport_attempt().unwrap(), 4);
    assert_eq!(budget.transport_attempts(), 4);
}

#[test]
fn attempt_budget_named_send_keeps_sequence_and_unsent_rollback() {
    let budget = V3AttemptBudget::new(test_limits());
    // A real send on a named identity keeps its wire sequence.
    assert_eq!(
        budget
            .admit_transport_attempt_for_identity(Some("A"))
            .unwrap(),
        1
    );
    // An unsent named reservation rolls the count back without rewinding the
    // earlier real send.
    assert_eq!(
        budget
            .admit_transport_attempt_for_identity(Some("A"))
            .unwrap(),
        2
    );
    budget.release_unsent_transport_attempt();
    assert_eq!(budget.transport_attempts(), 1);
    assert_eq!(
        budget
            .admit_transport_attempt_for_identity(Some("B"))
            .unwrap(),
        2
    );
    assert_eq!(budget.transport_attempts(), 2);
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
attempt_store = { residence_timeout_ms = 15 }
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
fn attempt_store_preserves_complete_frames() {
    let budget = V3AttemptBudget::new(test_limits());
    let mut builder = V3CommittedClientSseBuilder::with_budget(budget).unwrap();
    builder.push(vec![1, 2, 3, 4]).unwrap();
    builder
        .push(vec![5])
        .expect("the former byte limit must not reject a frame");
    assert_eq!(builder.frames, vec![vec![1, 2, 3, 4], vec![5]]);
    assert_eq!(builder.byte_len, 5);
}

#[test]
fn attempt_store_does_not_block_other_requests() {
    let first_budget = V3AttemptBudget::new(test_limits());
    let second_budget = V3AttemptBudget::new(test_limits());
    let mut first = V3CommittedClientSseBuilder::with_budget(first_budget).unwrap();
    first.push(vec![1, 2, 3, 4]).unwrap();
    let mut second = V3CommittedClientSseBuilder::with_budget(second_budget).unwrap();
    second
        .push(vec![5, 6, 7])
        .expect("another request must not hold business capacity");
    assert_eq!(second.frames, vec![vec![5, 6, 7]]);
    assert_eq!(first.frames, vec![vec![1, 2, 3, 4]]);
    drop(first);
    assert_eq!(second.frames, vec![vec![5, 6, 7]]);
}

#[test]
fn retained_attempt_does_not_gate_another_attempt() {
    let budget = V3AttemptBudget::new(test_limits());
    let mut first = V3CommittedClientSseBuilder::with_budget(budget.clone()).unwrap();
    first.push(vec![1, 2, 3, 4]).unwrap();
    let mut second = V3CommittedClientSseBuilder::with_budget(budget.clone()).unwrap();
    second
        .push(vec![5, 6, 7])
        .expect("a retained attempt must not block another attempt");
    assert_eq!(second.frames, vec![vec![5, 6, 7]]);
    assert_eq!(first.frames, vec![vec![1, 2, 3, 4]]);
    drop(first);
    assert_eq!(second.frames, vec![vec![5, 6, 7]]);
}

#[tokio::test]
async fn execution_control_payload_architecture_responses_replay_with_retained_attempt() {
    let budget = V3AttemptBudget::new(test_limits());
    let mut provider_attempt = V3CommittedClientSseBuilder::with_budget(budget.clone()).unwrap();
    provider_attempt.push(vec![0; 4_095]).unwrap();

    let replay = crate::hub_v1::build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05_with_budget(
        serde_json::json!({"id": "resp-shared-budget", "status": "completed", "output": []}),
        budget.clone(),
    ).expect("a retained provider attempt must not block client replay");
    let frames = replay.collect::<Vec<_>>().await;
    let wire = String::from_utf8(frames.concat()).unwrap();
    assert!(wire.contains("response.completed"), "{wire}");
    assert_eq!(provider_attempt.frames(), &[vec![0; 4_095]]);
}

#[tokio::test]
async fn execution_control_payload_architecture_anthropic_replay_with_retained_attempt() {
    let budget = V3AttemptBudget::new(test_limits());
    let mut provider_attempt = V3CommittedClientSseBuilder::with_budget(budget.clone()).unwrap();
    provider_attempt.push(vec![0; 4_095]).unwrap();
    let response = serde_json::json!({
        "events": [{
            "event": "message_stop",
            "data": {"type": "message_stop"}
        }]
    });

    let replay = crate::hub_v1::project_v3_anthropic_client_sse_stream_with_budget(
        response.clone(),
        budget.clone(),
    )
    .expect("a retained provider attempt must not block client replay");
    let frames = replay.collect::<Vec<_>>().await;
    let wire = String::from_utf8(frames.concat()).unwrap();
    assert!(wire.contains("message_stop"), "{wire}");
    assert_eq!(provider_attempt.frames(), &[vec![0; 4_095]]);
}

#[test]
fn attempt_store_rejects_expired_request() {
    let mut limits = test_limits();
    limits.residence_timeout = Duration::ZERO;
    let budget = V3AttemptBudget::new(limits);
    let error = match V3CommittedClientSseBuilder::with_budget(budget) {
        Ok(_) => panic!("expired request budget must reject a new attempt store"),
        Err(error) => error,
    };
    assert!(matches!(
        error,
        V3AttemptStoreError::ResidenceDeadlineExceeded(_)
    ));
}

#[tokio::test]
async fn sealed_replay_preserves_owned_frames() {
    let budget = V3AttemptBudget::new(test_limits());
    let mut builder = V3CommittedClientSseBuilder::with_budget(budget).unwrap();
    builder.push(vec![1, 2, 3]).unwrap();
    builder.mark_last_frame_as_terminal().unwrap();
    let stream = builder.seal_after_validated_terminal().unwrap();
    assert_eq!(stream.collect::<Vec<_>>().await, vec![vec![1, 2, 3]]);
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

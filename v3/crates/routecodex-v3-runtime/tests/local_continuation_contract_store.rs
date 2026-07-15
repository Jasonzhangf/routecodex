use routecodex_v3_runtime::{
    decode_v3_local_continuation_immutable_record, encode_v3_local_continuation_immutable_record,
    V3LocalContinuationError, V3LocalContinuationReq04RestoreRequest,
    V3LocalContinuationResp04CommitResult, V3LocalContinuationResp04SaveInput,
    V3LocalContinuationRestoreOwner, V3LocalContinuationScopeKey, V3LocalContinuationStore,
    V3LocalContinuationTerminalOutcome,
};
use serde_json::{json, Value};

fn scope() -> V3LocalContinuationScopeKey {
    V3LocalContinuationScopeKey::responses(
        "/v1/responses",
        "session-local",
        "conversation-local",
        5555,
        "relay-priority",
    )
}

fn context() -> Value {
    json!({
        "response": {
            "id": "rcc_local_1",
            "status": "requires_action",
            "output": [{
                "type": "function_call",
                "call_id": "call_local_1",
                "name": "local.tool",
                "arguments": "{\"value\":1}"
            }]
        },
        "chat_process": {
            "messages": [{"role":"assistant","content":"canonical"}],
            "tool_state": {"call_local_1":"pending"}
        }
    })
}

fn save_input(outcome: V3LocalContinuationTerminalOutcome) -> V3LocalContinuationResp04SaveInput {
    V3LocalContinuationResp04SaveInput::new(
        "rcc_local_1",
        scope(),
        context(),
        outcome,
        1_000,
        9_000,
    )
}

fn restore_request() -> V3LocalContinuationReq04RestoreRequest {
    V3LocalContinuationReq04RestoreRequest::local("rcc_local_1", scope(), 2_000)
}

#[test]
fn non_terminal_resp04_save_and_req04_restore_are_round_trip_equivalent() {
    let mut store = V3LocalContinuationStore::default();
    assert_eq!(
        store.commit_at_resp04(save_input(V3LocalContinuationTerminalOutcome::NonTerminal)),
        Ok(V3LocalContinuationResp04CommitResult::Stored)
    );

    let restored = store.restore_at_req04(&restore_request()).unwrap();
    assert_eq!(restored.canonical_context(), &context());
    assert_eq!(restored.record().context_id(), "rcc_local_1");
    assert_eq!(restored.record().scope(), &scope());
    assert_eq!(restored.record().committed_at_epoch_ms(), 1_000);
    assert_eq!(restored.record().expires_at_epoch_ms(), 9_000);

    let encoded = encode_v3_local_continuation_immutable_record(restored.record()).unwrap();
    let decoded = decode_v3_local_continuation_immutable_record(&encoded).unwrap();
    assert_eq!(&decoded, restored.record());
    assert_eq!(decoded.canonical_context(), &context());
}

#[test]
fn terminal_success_failure_and_already_terminal_are_explicit_non_save_results() {
    let mut store = V3LocalContinuationStore::default();
    for outcome in [
        V3LocalContinuationTerminalOutcome::Success,
        V3LocalContinuationTerminalOutcome::Failure,
        V3LocalContinuationTerminalOutcome::AlreadyTerminal,
    ] {
        assert_eq!(
            store.commit_at_resp04(save_input(outcome)),
            Ok(V3LocalContinuationResp04CommitResult::NotStored(outcome))
        );
        assert!(store.is_empty());
    }
    assert!(matches!(
        store.restore_at_req04(&restore_request()),
        Err(V3LocalContinuationError::NotFound { .. })
    ));
}

#[test]
fn already_terminal_input_cannot_revive_or_overwrite_existing_truth() {
    let mut store = V3LocalContinuationStore::default();
    store
        .commit_at_resp04(save_input(V3LocalContinuationTerminalOutcome::NonTerminal))
        .unwrap();
    let replacement = V3LocalContinuationResp04SaveInput::new(
        "rcc_local_1",
        scope(),
        json!({"replacement":"must_not_win"}),
        V3LocalContinuationTerminalOutcome::AlreadyTerminal,
        2_000,
        10_000,
    );
    assert_eq!(
        store.commit_at_resp04(replacement),
        Ok(V3LocalContinuationResp04CommitResult::NotStored(
            V3LocalContinuationTerminalOutcome::AlreadyTerminal
        ))
    );
    assert_eq!(
        store
            .restore_at_req04(&restore_request())
            .unwrap()
            .canonical_context(),
        &context()
    );
}

#[test]
fn every_entry_session_conversation_port_and_group_scope_mismatch_is_rejected() {
    let mut store = V3LocalContinuationStore::default();
    store
        .commit_at_resp04(save_input(V3LocalContinuationTerminalOutcome::NonTerminal))
        .unwrap();
    let mismatches = [
        V3LocalContinuationScopeKey::responses(
            "/v1/chat/completions",
            "session-local",
            "conversation-local",
            5555,
            "relay-priority",
        ),
        V3LocalContinuationScopeKey::responses(
            "/v1/responses",
            "session-other",
            "conversation-local",
            5555,
            "relay-priority",
        ),
        V3LocalContinuationScopeKey::responses(
            "/v1/responses",
            "session-local",
            "conversation-other",
            5555,
            "relay-priority",
        ),
        V3LocalContinuationScopeKey::responses(
            "/v1/responses",
            "session-local",
            "conversation-local",
            5520,
            "relay-priority",
        ),
        V3LocalContinuationScopeKey::responses(
            "/v1/responses",
            "session-local",
            "conversation-local",
            5555,
            "other-group",
        ),
    ];
    for mismatched_scope in mismatches {
        let request =
            V3LocalContinuationReq04RestoreRequest::local("rcc_local_1", mismatched_scope, 2_000);
        assert!(matches!(
            store.restore_at_req04(&request),
            Err(V3LocalContinuationError::ScopeMismatch { .. })
        ));
    }
}

#[test]
fn expired_context_fails_without_repair_or_fallback() {
    let mut store = V3LocalContinuationStore::default();
    store
        .commit_at_resp04(save_input(V3LocalContinuationTerminalOutcome::NonTerminal))
        .unwrap();
    let expired = V3LocalContinuationReq04RestoreRequest::local("rcc_local_1", scope(), 9_000);
    assert!(matches!(
        store.restore_at_req04(&expired),
        Err(V3LocalContinuationError::Expired { .. })
    ));
}

#[test]
fn duplicate_resp04_commit_cannot_overwrite_immutable_context() {
    let mut store = V3LocalContinuationStore::default();
    store
        .commit_at_resp04(save_input(V3LocalContinuationTerminalOutcome::NonTerminal))
        .unwrap();
    assert!(matches!(
        store.commit_at_resp04(save_input(V3LocalContinuationTerminalOutcome::NonTerminal)),
        Err(V3LocalContinuationError::AlreadyCommitted { .. })
    ));
    assert_eq!(store.len(), 1);
    assert_eq!(
        store
            .restore_at_req04(&restore_request())
            .unwrap()
            .canonical_context(),
        &context()
    );
}

#[test]
fn remote_owner_cannot_restore_local_context() {
    let mut store = V3LocalContinuationStore::default();
    store
        .commit_at_resp04(save_input(V3LocalContinuationTerminalOutcome::NonTerminal))
        .unwrap();
    let request =
        restore_request().with_owner(V3LocalContinuationRestoreOwner::RemoteProviderDirect);
    assert_eq!(
        store.restore_at_req04(&request),
        Err(V3LocalContinuationError::CrossOwner)
    );
}

#[test]
fn invalid_expiry_is_rejected_before_context_enters_store() {
    let mut store = V3LocalContinuationStore::default();
    let invalid = V3LocalContinuationResp04SaveInput::new(
        "rcc_invalid_expiry",
        scope(),
        context(),
        V3LocalContinuationTerminalOutcome::NonTerminal,
        9_000,
        9_000,
    );
    assert!(matches!(
        store.commit_at_resp04(invalid),
        Err(V3LocalContinuationError::InvalidExpiry { .. })
    ));
    assert!(store.is_empty());
}

#[test]
fn corrupt_or_forbidden_codec_fields_fail_closed() {
    let mut store = V3LocalContinuationStore::default();
    store
        .commit_at_resp04(save_input(V3LocalContinuationTerminalOutcome::NonTerminal))
        .unwrap();
    let restored = store.restore_at_req04(&restore_request()).unwrap();
    let encoded = encode_v3_local_continuation_immutable_record(restored.record()).unwrap();
    let baseline: Value = serde_json::from_slice(&encoded).unwrap();

    for forbidden in [
        "debug_snapshot",
        "snapshot_payload",
        "provider_id",
        "model_id",
        "auth_handle_id",
        "remote_owner",
    ] {
        let mut mutated = baseline.clone();
        mutated
            .as_object_mut()
            .unwrap()
            .insert(forbidden.into(), json!({"must_not":"enter truth"}));
        assert!(matches!(
            decode_v3_local_continuation_immutable_record(&serde_json::to_vec(&mutated).unwrap()),
            Err(V3LocalContinuationError::Codec { .. })
        ));
    }

    let mut wrong_boundary = baseline.clone();
    wrong_boundary["saved_at_boundary"] = json!("req04");
    assert!(matches!(
        decode_v3_local_continuation_immutable_record(
            &serde_json::to_vec(&wrong_boundary).unwrap()
        ),
        Err(V3LocalContinuationError::Codec { .. })
    ));

    assert!(matches!(
        decode_v3_local_continuation_immutable_record(b"{not-json"),
        Err(V3LocalContinuationError::Codec { .. })
    ));
}

#[test]
fn release_removes_only_the_named_local_context() {
    let mut store = V3LocalContinuationStore::default();
    store
        .commit_at_resp04(save_input(V3LocalContinuationTerminalOutcome::NonTerminal))
        .unwrap();
    assert!(!store.release("other"));
    assert_eq!(store.len(), 1);
    assert!(store.release("rcc_local_1"));
    assert!(store.is_empty());
    assert!(matches!(
        store.restore_at_req04(&restore_request()),
        Err(V3LocalContinuationError::NotFound { .. })
    ));
}

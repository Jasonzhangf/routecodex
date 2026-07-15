use routecodex_v3_runtime::{
    decode_v3_remote_continuation_locator, encode_v3_remote_continuation_locator,
    V3RemoteContinuationCommitInput, V3RemoteContinuationEntryProtocol, V3RemoteContinuationError,
    V3RemoteContinuationLoadRequest, V3RemoteContinuationLocator, V3RemoteContinuationOwner,
    V3RemoteContinuationPin, V3RemoteContinuationScopeKey, V3RemoteContinuationStore,
    V3RemoteProviderAvailability,
};

fn scope() -> V3RemoteContinuationScopeKey {
    V3RemoteContinuationScopeKey::responses(
        "/v1/responses",
        "session-a",
        "conversation-a",
        5555,
        "gateway-priority",
    )
}

fn pin() -> V3RemoteContinuationPin {
    V3RemoteContinuationPin::new("provider-a", "model-a", "auth-a")
}

fn locator() -> V3RemoteContinuationLocator {
    V3RemoteContinuationLocator::new_direct(
        "resp_remote",
        scope(),
        pin(),
        "cap-rev-1",
        1_000,
        9_000,
    )
}

fn load_request() -> V3RemoteContinuationLoadRequest {
    V3RemoteContinuationLoadRequest::direct(
        "resp_remote",
        scope(),
        pin(),
        V3RemoteProviderAvailability::Available,
        2_000,
    )
}

#[test]
fn direct_remote_locator_round_trips_for_same_entry_scope_and_pin() {
    let mut store = V3RemoteContinuationStore::default();
    store
        .commit(V3RemoteContinuationCommitInput::locator_only(locator()))
        .unwrap();

    let loaded = store.load(&load_request()).unwrap();
    assert_eq!(loaded.remote_response_id, "resp_remote");
    assert_eq!(loaded.owner, V3RemoteContinuationOwner::Direct);
    assert_eq!(loaded.scope_key, scope());
    assert_eq!(loaded.pin, pin());

    let encoded = encode_v3_remote_continuation_locator(loaded).unwrap();
    let decoded = decode_v3_remote_continuation_locator(&encoded).unwrap();
    assert_eq!(decoded, *loaded);
    assert!(!encoded.contains("history"));
    assert!(!encoded.contains("tool_state"));
    assert!(!encoded.contains("chat_process_context"));
}

#[test]
fn chat_or_messages_entry_cannot_hit_responses_remote_locator() {
    let mut store = V3RemoteContinuationStore::default();
    store
        .commit(V3RemoteContinuationCommitInput::locator_only(locator()))
        .unwrap();

    for protocol in [
        V3RemoteContinuationEntryProtocol::ChatCompletions,
        V3RemoteContinuationEntryProtocol::Messages,
    ] {
        let request = V3RemoteContinuationLoadRequest::direct(
            "resp_remote",
            scope().with_entry_protocol(protocol),
            pin(),
            V3RemoteProviderAvailability::Available,
            2_000,
        );
        assert!(matches!(
            store.load(&request),
            Err(V3RemoteContinuationError::EntryProtocolMismatch)
        ));
    }
}

#[test]
fn relay_owner_cannot_load_direct_remote_locator() {
    let mut store = V3RemoteContinuationStore::default();
    store
        .commit(V3RemoteContinuationCommitInput::locator_only(locator()))
        .unwrap();

    let mut request = load_request();
    request.owner = V3RemoteContinuationOwner::Relay;
    assert!(matches!(
        store.load(&request),
        Err(V3RemoteContinuationError::OwnerMismatch)
    ));
}

#[test]
fn same_session_with_different_port_or_group_is_rejected() {
    let mut store = V3RemoteContinuationStore::default();
    store
        .commit(V3RemoteContinuationCommitInput::locator_only(locator()))
        .unwrap();

    let request = V3RemoteContinuationLoadRequest::direct(
        "resp_remote",
        scope().with_port_group(5520, "gateway-priority"),
        pin(),
        V3RemoteProviderAvailability::Available,
        2_000,
    );
    assert!(matches!(
        store.load(&request),
        Err(V3RemoteContinuationError::ScopeMismatch { .. })
    ));

    let request = V3RemoteContinuationLoadRequest::direct(
        "resp_remote",
        scope().with_port_group(5555, "other-group"),
        pin(),
        V3RemoteProviderAvailability::Available,
        2_000,
    );
    assert!(matches!(
        store.load(&request),
        Err(V3RemoteContinuationError::ScopeMismatch { .. })
    ));
}

#[test]
fn provider_model_or_auth_pin_mismatch_is_rejected() {
    let mut store = V3RemoteContinuationStore::default();
    store
        .commit(V3RemoteContinuationCommitInput::locator_only(locator()))
        .unwrap();

    for bad_pin in [
        V3RemoteContinuationPin::new("provider-b", "model-a", "auth-a"),
        V3RemoteContinuationPin::new("provider-a", "model-b", "auth-a"),
        V3RemoteContinuationPin::new("provider-a", "model-a", "auth-b"),
    ] {
        let request = V3RemoteContinuationLoadRequest::direct(
            "resp_remote",
            scope(),
            bad_pin,
            V3RemoteProviderAvailability::Available,
            2_000,
        );
        assert!(matches!(
            store.load(&request),
            Err(V3RemoteContinuationError::PinMismatch { .. })
        ));
    }
}

#[test]
fn expired_locator_is_rejected_and_not_repaired() {
    let mut store = V3RemoteContinuationStore::default();
    store
        .commit(V3RemoteContinuationCommitInput::locator_only(locator()))
        .unwrap();

    let request = V3RemoteContinuationLoadRequest::direct(
        "resp_remote",
        scope(),
        pin(),
        V3RemoteProviderAvailability::Available,
        9_000,
    );
    assert!(matches!(
        store.load(&request),
        Err(V3RemoteContinuationError::Expired { .. })
    ));
}

#[test]
fn provider_unavailable_fails_without_cross_provider_reselection() {
    let mut store = V3RemoteContinuationStore::default();
    store
        .commit(V3RemoteContinuationCommitInput::locator_only(locator()))
        .unwrap();

    let request = V3RemoteContinuationLoadRequest::direct(
        "resp_remote",
        scope(),
        pin(),
        V3RemoteProviderAvailability::Unavailable,
        2_000,
    );
    assert!(matches!(
        store.load(&request),
        Err(V3RemoteContinuationError::ProviderUnavailable {
            provider_id,
            model_id
        }) if provider_id == "provider-a" && model_id == "model-a"
    ));
}

#[test]
fn remote_store_refuses_local_context_history_or_tool_state() {
    let mut store = V3RemoteContinuationStore::default();
    let input = V3RemoteContinuationCommitInput {
        locator: locator(),
        local_context_attempted: true,
    };
    assert!(matches!(
        store.commit(input),
        Err(V3RemoteContinuationError::LocalContextForbidden)
    ));
    assert!(store.is_empty());
}

#[test]
fn release_removes_only_the_remote_locator() {
    let mut store = V3RemoteContinuationStore::default();
    store
        .commit(V3RemoteContinuationCommitInput::locator_only(locator()))
        .unwrap();
    assert_eq!(store.len(), 1);
    assert!(store.release("resp_remote"));
    assert!(store.is_empty());
    assert!(matches!(
        store.load(&load_request()),
        Err(V3RemoteContinuationError::NotFound { .. })
    ));
}

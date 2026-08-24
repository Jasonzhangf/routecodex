fn commit_or_release_v3_direct_continuation(
    continuation_state: Option<&V3ResponsesDirectContinuationState>,
    scope: &V3ResponsesDirectContinuationScope,
    remote_continuation: &V3RemoteContinuationObservation,
    previous_response_id: Option<&str>,
    selected_pin: &V3RemoteContinuationPin,
    selected_capability_revision: &str,
    now_epoch_ms: u64,
    trace: &mut Vec<&'static str>,
    hook_registry: &V3HookRegistry,
) -> Result<(), V3ResponsesDirectRuntimeOutput> {
    let pending_response_id = match remote_continuation {
        V3RemoteContinuationObservation::Pending { response_id } => Some(response_id.clone()),
        V3RemoteContinuationObservation::Terminal => None,
        V3RemoteContinuationObservation::Streaming { .. } => unreachable!(
            "streaming Responses continuation is handled before material lifecycle"
        ),
    };
    let lifecycle_changed = previous_response_id.is_some() || pending_response_id.is_some();
    if !lifecycle_changed {
        return Ok(());
    }
    if let Some(response_id) = pending_response_id {
        let locator = V3RemoteContinuationLocator::new_direct(
            response_id,
            scope.key.clone(),
            selected_pin.clone(),
            selected_capability_revision.to_string(),
            now_epoch_ms,
            now_epoch_ms + REMOTE_CONTINUATION_TTL_MS,
        );
        let input = V3RemoteContinuationCommitInput::locator_only(locator);
        let mut store = match continuation_state
            .expect("continuation state is required to commit a locator")
            .store
            .lock()
        {
            Ok(store) => store,
            Err(error) => {
                return Err(error_output(
                    runtime_source("V3HubRespContinuation04Committed", error),
                    std::mem::take(trace),
                    hook_registry,
                ))
            }
        };
        let commit = match previous_response_id {
            Some(previous_response_id) => store.rebind_for_resp04(previous_response_id, input),
            None => store.commit(input),
        };
        if let Err(error) = commit {
            return Err(error_output(
                runtime_source("V3HubRespContinuation04Committed", error),
                std::mem::take(trace),
                hook_registry,
            ));
        }
    } else if let Some(previous_response_id) = previous_response_id {
        let mut store = match continuation_state
            .expect("continuation state is required to release a locator")
            .store
            .lock()
        {
            Ok(store) => store,
            Err(error) => {
                return Err(error_output(
                    runtime_source("V3HubRespContinuation04Committed", error),
                    std::mem::take(trace),
                    hook_registry,
                ))
            }
        };
        if !store.release_bound(previous_response_id, &scope.key, selected_pin) {
            return Err(error_output(
                runtime_source(
                    "V3HubRespContinuation04Committed",
                    format!(
                        "terminal locator {previous_response_id} was not present at Resp04 release"
                    ),
                ),
                std::mem::take(trace),
                hook_registry,
            ));
        }
    }
    trace.push("V3HubRespContinuation04Committed");
    Ok(())
}

fn persist_v3_direct_continuation_lifecycle(
    continuation_state: Option<&V3ResponsesDirectContinuationState>,
    scope: &V3ResponsesDirectContinuationScope,
    remote_continuation: &V3RemoteContinuationObservation,
    previous_response_id: Option<&str>,
    selected_pin: &V3RemoteContinuationPin,
    selected_capability_revision: &str,
    now_epoch_ms: u64,
) -> Result<(), V3Error01SourceRaised> {
    let pending_response_id = match remote_continuation {
        V3RemoteContinuationObservation::Pending { response_id } => Some(response_id.clone()),
        V3RemoteContinuationObservation::Terminal => None,
        V3RemoteContinuationObservation::Streaming { state } => state
            .pending_response_id()
            .map_err(|error| build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3HubRespContinuation04Committed",
                "direct_continuation_stream_observation_failed",
                error,
            ))?,
    };
    let lifecycle_changed = previous_response_id.is_some() || pending_response_id.is_some();
    if !lifecycle_changed {
        return Ok(());
    }
    let continuation_state = continuation_state.ok_or_else(|| {
        build_v3_error_01_source_raised(
            V3ErrorSourceKind::RuntimeFailure,
            "V3HubRespContinuation04Committed",
            "direct_continuation_state_missing",
            "continuation lifecycle changed without a continuation state",
        )
    })?;
    if let Some(response_id) = pending_response_id {
        let locator = V3RemoteContinuationLocator::new_direct(
            response_id,
            scope.key.clone(),
            selected_pin.clone(),
            selected_capability_revision.to_string(),
            now_epoch_ms,
            now_epoch_ms + REMOTE_CONTINUATION_TTL_MS,
        );
        let input = V3RemoteContinuationCommitInput::locator_only(locator);
        let mut store = continuation_state.store.lock().map_err(|error| {
            build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3HubRespContinuation04Committed",
                "direct_continuation_store_poisoned",
                error.to_string(),
            )
        })?;
        let commit = match previous_response_id {
            Some(previous_response_id) => store.rebind_for_resp04(previous_response_id, input),
            None => store.commit(input),
        };
        commit.map_err(|error| {
            build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3HubRespContinuation04Committed",
                "direct_continuation_commit_failed",
                error.to_string(),
            )
        })?;
    } else if let Some(previous_response_id) = previous_response_id {
        let mut store = continuation_state.store.lock().map_err(|error| {
            build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3HubRespContinuation04Committed",
                "direct_continuation_store_poisoned",
                error.to_string(),
            )
        })?;
        if !store.release_bound(previous_response_id, &scope.key, selected_pin) {
            return Err(build_v3_error_01_source_raised(
                V3ErrorSourceKind::RuntimeFailure,
                "V3HubRespContinuation04Committed",
                "direct_continuation_release_missing",
                format!(
                    "terminal locator {previous_response_id} was not present at Resp04 release"
                ),
            ));
        }
    }
    Ok(())
}

fn wrap_v3_direct_sse_continuation_lifecycle(
    stream: V3ClientSseStream,
    observation_state: V3SseRemoteContinuationObservationState,
    continuation_state: Option<Arc<V3ResponsesDirectContinuationState>>,
    continuation_scope: Option<V3ResponsesDirectContinuationScope>,
    previous_response_id: Option<String>,
    selected_pin: V3RemoteContinuationPin,
    selected_capability_revision: String,
    now_epoch_ms: u64,
) -> V3ClientSseStream {
    struct State {
        stream: V3ClientSseStream,
        observation_state: V3SseRemoteContinuationObservationState,
        continuation_state: Option<Arc<V3ResponsesDirectContinuationState>>,
        continuation_scope: Option<V3ResponsesDirectContinuationScope>,
        previous_response_id: Option<String>,
        selected_pin: V3RemoteContinuationPin,
        selected_capability_revision: String,
        now_epoch_ms: u64,
        finalized: bool,
    }

    Box::pin(stream::unfold(
        State {
            stream,
            observation_state,
            continuation_state,
            continuation_scope,
            previous_response_id,
            selected_pin,
            selected_capability_revision,
            now_epoch_ms,
            finalized: false,
        },
        |mut state| async move {
            if state.finalized {
                return None;
            }
            match state.stream.next().await {
                Some(item @ Ok(_)) => Some((item, state)),
                Some(Err(error)) => {
                    state.finalized = true;
                    Some((Err(error), state))
                }
                None => {
                    state.finalized = true;
                    let Some(scope) = state.continuation_scope.as_ref() else {
                        return None;
                    };
                    let observation = V3RemoteContinuationObservation::Streaming {
                        state: state.observation_state.clone(),
                    };
                    match persist_v3_direct_continuation_lifecycle(
                        state.continuation_state.as_deref(),
                        scope,
                        &observation,
                        state.previous_response_id.as_deref(),
                        &state.selected_pin,
                        &state.selected_capability_revision,
                        state.now_epoch_ms,
                    ) {
                        Ok(()) => None,
                        Err(error) => Some((Err(error), state)),
                    }
                }
            }
        },
    ))
}

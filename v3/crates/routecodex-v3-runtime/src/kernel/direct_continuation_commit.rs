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

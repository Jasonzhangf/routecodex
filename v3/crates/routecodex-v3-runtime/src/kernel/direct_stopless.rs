struct V3ResponsesDirectStoplessJsonResponseControlInput<'a> {
    manifest: &'a V3Config05ManifestPublished,
    server_id: &'a str,
    stopless_control: Option<&'a V3ResponsesDirectStoplessControlState>,
    stopless_scope: Option<&'a V3ResponsesDirectStoplessControlScope>,
    request_stopless_state: Option<&'a V3StoplessCenterState>,
    transition_request_id: &'a str,
    transition_updated_at: u64,
    payload: &'a mut Value,
}

#[derive(Debug, Clone, Default)]
struct V3ResponsesDirectStoplessJsonResponseControlOutcome {
    intercepted: bool,
    continuation_transition: V3DirectStoplessContinuationTransition,
}

#[derive(Debug, Clone, Default)]
enum V3DirectStoplessContinuationTransition {
    #[default]
    PassThrough,
    Continue {
        response_id: String,
    },
    Terminal,
}

fn prepare_v3_responses_direct_stopless_control_request(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_control: Option<&V3ResponsesDirectStoplessControlState>,
    stopless_scope: Option<&V3ResponsesDirectStoplessControlScope>,
    payload: &mut Value,
    transition_request_id: &str,
    transition_updated_at: u64,
    trace: &mut Vec<&'static str>,
) -> Result<Option<V3StoplessCenterState>, V3Error01SourceRaised> {
    if !v3_responses_direct_stopless_center_enabled_for_server(manifest, server_id) {
        return Ok(None);
    }
    let (Some(stopless_control), Some(stopless_scope)) = (stopless_control, stopless_scope) else {
        return Ok(None);
    };
    if !stopless_scope.has_client_session_scope() {
        return Ok(None);
    }
    trace.push("V3DirectStoplessReq01RuntimeControlLoaded");
    let restored_state = stopless_control
        .load_for_scope(stopless_scope)
        .map_err(|error| runtime_source("V3DirectStoplessReq01RuntimeControlLoaded", error))?;
    let restored_state_loaded = restored_state.is_some();
    let mut events = Vec::<V3HubRelayRequestHookEvent>::new();
    let request_state = apply_v3_stopless_request_hook_at_req04(
        payload,
        &mut events,
        restored_state.as_ref(),
        Some(transition_request_id),
        Some(transition_updated_at),
    )
    .map(|state| state.map(|state| state.with_max_stop_budget_floor(4)))
    .map_err(|error| runtime_source("V3DirectStoplessReq03GuidanceToolInjected", error))?;
    if events.iter().any(|event| {
        matches!(
            event,
            V3HubRelayRequestHookEvent::Req04StoplessCliNoopObserved
        )
    }) {
        trace.push("V3DirectStoplessReq02NoopCliConsumed");
        project_v3_direct_stopless_native_reasoning_stop_output(payload, restored_state.as_ref())?;
    }
    if request_state.is_some() {
        trace.push("V3DirectStoplessReq03GuidanceToolInjected");
    }
    apply_v3_responses_direct_stopless_control_request_transition(
        manifest,
        server_id,
        Some(stopless_control),
        Some(stopless_scope),
        restored_state_loaded,
        request_state.as_ref(),
    )?;
    Ok(request_state)
}

fn project_v3_direct_stopless_native_reasoning_stop_output(
    payload: &mut Value,
    restored_state: Option<&V3StoplessCenterState>,
) -> Result<(), V3Error01SourceRaised> {
    let Some(call_id) = restored_state
        .and_then(V3StoplessCenterState::last_provider_stopless_call_id)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };
    let input = payload
        .get_mut("input")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            runtime_source(
                "V3DirectStoplessReq02NoopCliConsumed",
                "Direct stopless native reasoningStop continuation requires Responses input array",
            )
        })?;
    let already_projected = input.iter().any(|item| {
        matches!(
            item.get("type").and_then(Value::as_str),
            Some("function_call_output" | "tool_call_output")
        ) && item
            .get("call_id")
            .or_else(|| item.get("tool_call_id"))
            .and_then(Value::as_str)
            .is_some_and(|existing| existing == call_id)
    });
    if already_projected {
        return Ok(());
    }
    input.insert(
        0,
        json!({
            "type": "function_call_output",
            "call_id": call_id,
            "output": ""
        }),
    );
    Ok(())
}

fn apply_v3_responses_direct_stopless_json_response_control(
    input: V3ResponsesDirectStoplessJsonResponseControlInput<'_>,
    trace: &mut Vec<&'static str>,
) -> Result<V3ResponsesDirectStoplessJsonResponseControlOutcome, V3Error01SourceRaised> {
    let Some(request_stopless_state) = input.request_stopless_state else {
        return Ok(V3ResponsesDirectStoplessJsonResponseControlOutcome::default());
    };
    if !v3_responses_direct_stopless_center_enabled_for_server(input.manifest, input.server_id) {
        return Ok(V3ResponsesDirectStoplessJsonResponseControlOutcome::default());
    }
    let (Some(stopless_control), Some(stopless_scope)) =
        (input.stopless_control, input.stopless_scope)
    else {
        return Ok(V3ResponsesDirectStoplessJsonResponseControlOutcome::default());
    };
    if !stopless_scope.has_client_session_scope() {
        return Ok(V3ResponsesDirectStoplessJsonResponseControlOutcome::default());
    }
    trace.push("V3DirectStoplessResp01EvidenceObserved");
    let outcome = run_v3_responses_direct_stopless_response_hooks(
        input.payload.clone(),
        request_stopless_state,
        input.transition_request_id,
        input.transition_updated_at,
        V3HubTransportIntent::Json,
    )?;
    *input.payload = outcome.payload;
    let continuation_transition = if !outcome.intercepted {
        V3DirectStoplessContinuationTransition::PassThrough
    } else if outcome
        .center_state
        .as_ref()
        .is_some_and(V3StoplessCenterState::need_continue)
    {
        let response_id = direct_response_id(input.payload).ok_or_else(|| {
            runtime_source(
                "V3HubRespContinuation04Committed",
                "Direct stopless continue transition requires provider-native response id",
            )
        })?;
        V3DirectStoplessContinuationTransition::Continue { response_id }
    } else {
        V3DirectStoplessContinuationTransition::Terminal
    };
    apply_v3_responses_direct_stopless_control_response_transition(
        input.manifest,
        input.server_id,
        Some(stopless_control),
        Some(stopless_scope),
        outcome.center_state,
    )?;
    trace.push("V3DirectStoplessResp02RuntimeControlUpdated");
    if outcome.intercepted {
        trace.push("V3DirectStoplessResp03NoopCliOrTerminalProjected");
    }
    Ok(V3ResponsesDirectStoplessJsonResponseControlOutcome {
        intercepted: outcome.intercepted,
        continuation_transition,
    })
}

struct V3DirectStoplessResponseHookOutcome {
    payload: Value,
    center_state: Option<V3StoplessCenterState>,
    intercepted: bool,
}

fn run_v3_responses_direct_stopless_response_hooks(
    payload: Value,
    request_stopless_state: &V3StoplessCenterState,
    transition_request_id: &str,
    transition_updated_at: u64,
    transport_intent: V3HubTransportIntent,
) -> Result<V3DirectStoplessResponseHookOutcome, V3Error01SourceRaised> {
    if let Some(key) = crate::hub_v1::find_v3_hub_side_channel_key(&payload) {
        return Err(runtime_source(
            "V3DirectStoplessResp01EvidenceObserved",
            format!("provider response leaked RouteCodex side-channel field: {key}"),
        ));
    }
    let resp01 = build_v3_provider_resp_inbound_01_raw_with_compat_profile(
        payload,
        V3ProviderRespInbound01RawContext::new(
            V3HubEntryProtocol::Responses,
            V3HubProviderWireProtocol::Responses,
            V3HubContinuationOwnership::RemoteProviderOwned,
            V3HubExecutionMode::Direct,
            V3HubInvocationSource::Client,
            transport_intent,
        ),
    );
    let resp02 = build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(resp01)
        .map_err(|error| runtime_source("V3DirectStoplessResp01EvidenceObserved", error))?;
    let resp02 = build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(resp02);
    let profile = V3HubRelayResponseHookProfile::empty()
        .with_stopless_reasoning_stop()
        .with_stopless_center_state(request_stopless_state.clone())
        .with_stopless_transition_context(transition_request_id, transition_updated_at);
    let tool_outcome = apply_v3_tool_call_servertool_hook_at_resp03(resp02, &profile)
        .map_err(|error| runtime_source("V3DirectStoplessResp01EvidenceObserved", error))?;
    if tool_outcome.intercepted {
        return Ok(V3DirectStoplessResponseHookOutcome {
            payload: tool_outcome.input.provider_payload().as_ref().clone(),
            center_state: tool_outcome.center_state,
            intercepted: true,
        });
    }
    if direct_response_has_provider_tool_call(tool_outcome.input.provider_payload().as_ref()) {
        return Ok(V3DirectStoplessResponseHookOutcome {
            payload: tool_outcome.input.provider_payload().as_ref().clone(),
            center_state: None,
            intercepted: false,
        });
    }
    let stop_outcome = apply_v3_stop_servertool_hook_at_resp03(tool_outcome.input, &profile)
        .map_err(|error| runtime_source("V3DirectStoplessResp01EvidenceObserved", error))?;
    Ok(V3DirectStoplessResponseHookOutcome {
        payload: stop_outcome.input.provider_payload().as_ref().clone(),
        center_state: stop_outcome.center_state,
        intercepted: stop_outcome.intercepted,
    })
}

fn apply_v3_responses_direct_stopless_control_request_transition(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_control: Option<&V3ResponsesDirectStoplessControlState>,
    stopless_scope: Option<&V3ResponsesDirectStoplessControlScope>,
    restored_state_loaded: bool,
    request_stopless_state: Option<&V3StoplessCenterState>,
) -> Result<(), V3Error01SourceRaised> {
    match request_stopless_state {
        Some(state) => store_v3_responses_direct_stopless_control_state(
            manifest,
            server_id,
            stopless_control,
            stopless_scope,
            state.clone(),
        ),
        None if restored_state_loaded => clear_v3_responses_direct_stopless_control_state(
            manifest,
            server_id,
            stopless_control,
            stopless_scope,
        ),
        None => Ok(()),
    }
}

fn apply_v3_responses_direct_stopless_control_response_transition(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_control: Option<&V3ResponsesDirectStoplessControlState>,
    stopless_scope: Option<&V3ResponsesDirectStoplessControlScope>,
    response_stopless_state: Option<V3StoplessCenterState>,
) -> Result<(), V3Error01SourceRaised> {
    match response_stopless_state {
        Some(state) => store_v3_responses_direct_stopless_control_state(
            manifest,
            server_id,
            stopless_control,
            stopless_scope,
            state,
        ),
        None => clear_v3_responses_direct_stopless_control_state(
            manifest,
            server_id,
            stopless_control,
            stopless_scope,
        ),
    }
}

fn store_v3_responses_direct_stopless_control_state(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_control: Option<&V3ResponsesDirectStoplessControlState>,
    stopless_scope: Option<&V3ResponsesDirectStoplessControlScope>,
    state: V3StoplessCenterState,
) -> Result<(), V3Error01SourceRaised> {
    if !v3_responses_direct_stopless_center_enabled_for_server(manifest, server_id) {
        return Ok(());
    }
    let (Some(stopless_control), Some(stopless_scope)) = (stopless_control, stopless_scope) else {
        return Ok(());
    };
    if !stopless_scope.has_client_session_scope() {
        return Ok(());
    }
    stopless_control
        .store_for_scope(stopless_scope, state)
        .map_err(|error| runtime_source("V3DirectStoplessResp02RuntimeControlUpdated", error))
}

fn clear_v3_responses_direct_stopless_control_state(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_control: Option<&V3ResponsesDirectStoplessControlState>,
    stopless_scope: Option<&V3ResponsesDirectStoplessControlScope>,
) -> Result<(), V3Error01SourceRaised> {
    if !v3_responses_direct_stopless_center_enabled_for_server(manifest, server_id) {
        return Ok(());
    }
    let (Some(stopless_control), Some(stopless_scope)) = (stopless_control, stopless_scope) else {
        return Ok(());
    };
    if !stopless_scope.has_client_session_scope() {
        return Ok(());
    }
    stopless_control
        .clear_for_scope(stopless_scope)
        .map_err(|error| runtime_source("V3DirectStoplessResp02RuntimeControlUpdated", error))
}

fn clear_v3_responses_direct_stopless_control_on_pre_resp03_terminal(
    manifest: &V3Config05ManifestPublished,
    server_id: &str,
    stopless_control: Option<&V3ResponsesDirectStoplessControlState>,
    stopless_scope: Option<&V3ResponsesDirectStoplessControlScope>,
    request_stopless_state: Option<&V3StoplessCenterState>,
) -> Result<(), V3Error01SourceRaised> {
    if request_stopless_state.is_none() {
        return Ok(());
    }
    clear_v3_responses_direct_stopless_control_state(
        manifest,
        server_id,
        stopless_control,
        stopless_scope,
    )
}

fn commit_v3_direct_stopless_remote_locator_for_payload(
    payload: &Value,
    previous_response_id: Option<&str>,
    continuation_state: Option<&V3ResponsesDirectContinuationState>,
    continuation_scope: Option<&V3ResponsesDirectContinuationScope>,
    selected_pin: &V3RemoteContinuationPin,
    selected_capability_revision: &str,
    now_epoch_ms: u64,
) -> Result<(), V3Error01SourceRaised> {
    let Some(response_id) = direct_response_id(payload) else {
        return Err(runtime_source(
            "V3HubRespContinuation04Committed",
            "Direct stopless no-op projection requires native response id for remote continuation",
        ));
    };
    let (Some(continuation_state), Some(continuation_scope)) =
        (continuation_state, continuation_scope)
    else {
        return Err(runtime_source(
            "V3HubRespContinuation04Committed",
            "Direct stopless no-op projection requires direct continuation state/scope",
        ));
    };
    let locator = V3RemoteContinuationLocator::new_direct(
        response_id,
        continuation_scope.key.clone(),
        selected_pin.clone(),
        selected_capability_revision.to_string(),
        now_epoch_ms,
        now_epoch_ms + REMOTE_CONTINUATION_TTL_MS,
    );
    let input = V3RemoteContinuationCommitInput::locator_only(locator);
    let mut store = continuation_state
        .store
        .lock()
        .map_err(|error| runtime_source("V3HubRespContinuation04Committed", error))?;
    let commit = match previous_response_id {
        Some(previous_response_id) => store.rebind_for_resp04(previous_response_id, input),
        None => store.commit(input),
    };
    commit.map_err(|error| runtime_source("V3HubRespContinuation04Committed", error))
}

fn direct_response_id(payload: &Value) -> Option<String> {
    payload
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| payload.pointer("/response/id").and_then(Value::as_str))
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(ToOwned::to_owned)
}

fn direct_response_has_provider_tool_call(payload: &Value) -> bool {
    let semantic = payload.get("response").unwrap_or(payload);
    if matches!(
        semantic.get("status").and_then(Value::as_str),
        Some("requires_action" | "in_progress")
    ) {
        return true;
    }
    semantic
        .get("output")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                matches!(
                    item.get("type").and_then(Value::as_str),
                    Some("function_call" | "custom_tool_call" | "tool_call")
                )
            })
        })
        || matches!(
            payload.pointer("/item/type").and_then(Value::as_str),
            Some("function_call" | "custom_tool_call" | "tool_call")
        )
}

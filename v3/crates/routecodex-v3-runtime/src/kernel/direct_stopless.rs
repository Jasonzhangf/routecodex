use crate::hub_v1::{V3WebSearchCenterPhase, V3WebSearchCenterState};

struct V3ResponsesDirectStoplessJsonResponseControlInput<'a> {
    manifest: &'a V3Config05ManifestPublished,
    server_id: &'a str,
    stopless_control: Option<&'a V3ResponsesDirectStoplessControlState>,
    stopless_scope: Option<&'a V3ResponsesDirectStoplessControlScope>,
    request_stopless_state: Option<&'a V3StoplessCenterState>,
    request_web_search_state: Option<&'a V3WebSearchCenterState>,
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
        0,
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
    if request_state.is_some() {
        trace.push("V3DirectStoplessReq03ControlStateUpdated");
    }
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
        Some(request_stopless_state),
        input.request_web_search_state,
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
    web_search_state: Option<V3WebSearchCenterState>,
    intercepted: bool,
}

fn run_v3_responses_direct_stopless_response_hooks(
    payload: Value,
    request_stopless_state: Option<&V3StoplessCenterState>,
    web_search_state: Option<&V3WebSearchCenterState>,
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
    let mut profile = V3HubRelayResponseHookProfile::empty()
        .with_web_search_execution_mode(
            routecodex_v3_config::V3WebSearchExecutionMode::MetadataCenterLocalSearch,
        );
    if let Some(state) = web_search_state {
        profile = profile.with_web_search_center_state(state.clone());
    }
    if let Some(stopless_state) = request_stopless_state {
        profile = profile
            .with_stopless_reasoning_stop()
            .with_stopless_center_state(stopless_state.clone())
            .with_stopless_transition_context(transition_request_id, transition_updated_at);
    }
    let tool_outcome = apply_v3_tool_call_servertool_hook_at_resp03(resp02, &profile)
        .map_err(|error| runtime_source("V3DirectStoplessResp01EvidenceObserved", error))?;
    if tool_outcome.intercepted {
        return Ok(V3DirectStoplessResponseHookOutcome {
            payload: tool_outcome.input.provider_payload().as_ref().clone(),
            center_state: tool_outcome.center_state,
            web_search_state: tool_outcome.web_search_state,
            intercepted: true,
        });
    }
    if direct_response_has_provider_tool_call(tool_outcome.input.provider_payload().as_ref()) {
        return Ok(V3DirectStoplessResponseHookOutcome {
            payload: tool_outcome.input.provider_payload().as_ref().clone(),
            center_state: None,
            web_search_state: None,
            intercepted: false,
        });
    }
    let stop_outcome = apply_v3_stop_servertool_hook_at_resp03(tool_outcome.input, &profile)
        .map_err(|error| runtime_source("V3DirectStoplessResp01EvidenceObserved", error))?;
    Ok(V3DirectStoplessResponseHookOutcome {
        payload: stop_outcome.input.provider_payload().as_ref().clone(),
        center_state: stop_outcome.center_state,
        web_search_state: None,
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

/// direct 模式的 Mode B 判定：请求声明的 model 的编译期 web_search 执行模式。
/// direct 的请求 body 是 responses JSON（`model` 字段），与 relay 同源解析。
pub(crate) fn direct_web_search_execution_mode(
    manifest: &V3Config05ManifestPublished,
    payload: &Value,
) -> routecodex_v3_config::V3WebSearchExecutionMode {
    let model = payload
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let Some(model) = model else {
        return routecodex_v3_config::V3WebSearchExecutionMode::None;
    };
    crate::hub_v1::resolve_web_search_mode_and_backend(manifest, model).0
}

/// direct Req04 侧 websearch 控制：Mode B 且请求声明 web_search 工具时，
/// 把标准 `web_search` 声明本地化为 `websearch` 普通函数（不投影 exec_command），
/// 并在 ServerToolCenter websearch 桶登记 LocalToolSurfaceActive。
/// 独立于 stopless center 开关：websearch 是独立的 server tool 实例。
pub(crate) fn prepare_v3_responses_direct_web_search_control_request(
    manifest: &V3Config05ManifestPublished,
    stopless_control: Option<&V3ResponsesDirectStoplessControlState>,
    stopless_scope: Option<&V3ResponsesDirectStoplessControlScope>,
    payload: &mut Value,
    trace: &mut Vec<&'static str>,
) -> Result<(), V3Error01SourceRaised> {
    if !direct_web_search_execution_mode(manifest, payload)
        .is_metadata_center_local_search()
    {
        return Ok(());
    }
    let (Some(stopless_control), Some(stopless_scope)) = (stopless_control, stopless_scope) else {
        return Ok(());
    };
    if !stopless_scope.has_client_session_scope() {
        return Ok(());
    }
    let state = crate::hub_v1::apply_v3_web_search_request_hook_at_req04(payload)
        .map_err(|error| {
            runtime_source("V3DirectWebSearchReq01LocalToolSurfaceActive", error.to_string())
        })?;
    if let Some(state) = state {
        stopless_control
            .web_search_store_for_scope(stopless_scope, state)
            .map_err(|error| {
                runtime_source("V3DirectWebSearchReq01LocalToolSurfaceActive", error)
            })?;
        trace.push("V3DirectWebSearchReq01LocalToolSurfaceActive");
    }
    Ok(())
}

/// direct 下一轮 Req04 配对收尾：中心存在 SearchResultCaptured 且当前请求
/// 的 tool_outputs 含匹配 original_call_id 的 function_call_output 时，
/// 状态机收尾为 Completed（跨轮调用配对语义同 relay）。
pub(crate) fn apply_v3_responses_direct_web_search_control_completion(
    stopless_control: Option<&V3ResponsesDirectStoplessControlState>,
    stopless_scope: Option<&V3ResponsesDirectStoplessControlScope>,
    payload: &Value,
    trace: &mut Vec<&'static str>,
) -> Result<(), V3Error01SourceRaised> {
    let (Some(stopless_control), Some(stopless_scope)) = (stopless_control, stopless_scope) else {
        return Ok(());
    };
    if !stopless_scope.has_client_session_scope() {
        return Ok(());
    }
    let Some(state) = stopless_control
        .web_search_load_for_scope(stopless_scope)
        .map_err(|error| runtime_source("V3DirectWebSearchReq02PairVerified", error))?
    else {
        return Ok(());
    };
    if state.phase() != V3WebSearchCenterPhase::SearchResultCaptured {
        return Ok(());
    }
    let Some(call_id) = state.original_call_id() else {
        return Ok(());
    };
    let tool_output_ids = crate::hub_v1::find_responses_tool_output_ids(payload)
        .map_err(|error| runtime_source("V3DirectWebSearchReq02PairVerified", error))?;
    if !tool_output_ids.consumed_ids.contains(&call_id.to_string()) {
        return Ok(());
    }
    // 收尾走完整合法迁移链（同 relay）：SearchResultCaptured ->
    // HostedResultProjected -> MainModelContinuationPrepared -> Completed。
    let completed = state
        .transition_to(
            V3WebSearchCenterPhase::HostedResultProjected,
            "req04_pair_verified",
        )
        .and_then(|state| {
            state.transition_to(
                V3WebSearchCenterPhase::MainModelContinuationPrepared,
                "req04_pair_verified",
            )
        })
        .and_then(|state| {
            state.transition_to(V3WebSearchCenterPhase::Completed, "req04_pair_verified")
        })
        .map_err(|reason| runtime_source("V3DirectWebSearchReq02PairVerified", reason))?;
    stopless_control
        .web_search_store_for_scope(stopless_scope, completed)
        .map_err(|error| runtime_source("V3DirectWebSearchReq02PairVerified", error))?;
    trace.push("V3DirectWebSearchReq02PairVerified");
    Ok(())
}

/// direct Resp03 侧 websearch 控制（JSON 响应）：从中心读取 Req04 登记的
/// LocalToolSurfaceActive 状态，拦截模型发出的本地 websearch tool call
/// （剥离 + 状态迁移 ToolCallObserved），把携带 call_id/query/count 的状态
/// 传出，由 kernel 执行异步搜索 hop 与 hosted 投影。
/// 独立于 stopless center 开关。
pub(crate) fn apply_v3_responses_direct_web_search_json_response_control(
    stopless_control: Option<&V3ResponsesDirectStoplessControlState>,
    stopless_scope: Option<&V3ResponsesDirectStoplessControlScope>,
    payload: &mut Value,
    trace: &mut Vec<&'static str>,
) -> Result<Option<V3WebSearchCenterState>, V3Error01SourceRaised> {
    let (Some(stopless_control), Some(stopless_scope)) = (stopless_control, stopless_scope) else {
        return Ok(None);
    };
    if !stopless_scope.has_client_session_scope() {
        return Ok(None);
    }
    let Some(request_state) = stopless_control
        .web_search_load_for_scope(stopless_scope)
        .map_err(|error| runtime_source("V3DirectWebSearchResp01Intercepted", error))?
    else {
        return Ok(None);
    };
    if request_state.phase() != V3WebSearchCenterPhase::LocalToolSurfaceActive {
        return Ok(None);
    }
    trace.push("V3DirectWebSearchResp01EvidenceObserved");
    let outcome = run_v3_responses_direct_stopless_response_hooks(
        payload.clone(),
        None,
        Some(&request_state),
        "",
        0,
        V3HubTransportIntent::Json,
    )?;
    *payload = outcome.payload;
    if !outcome.intercepted {
        return Ok(None);
    }
    trace.push("V3DirectWebSearchResp02RuntimeControlUpdated");
    Ok(outcome.web_search_state)
}

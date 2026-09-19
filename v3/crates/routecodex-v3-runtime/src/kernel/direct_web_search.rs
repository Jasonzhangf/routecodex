use crate::hub_v1::{V3WebSearchCenterPhase, V3WebSearchCenterState};

pub(crate) fn direct_web_search_execution_mode(
    manifest: &V3Config05ManifestPublished,
    payload: &Value,
) -> routecodex_v3_config::V3WebSearchExecutionMode {
    let Some(model) = payload
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return routecodex_v3_config::V3WebSearchExecutionMode::None;
    };
    crate::hub_v1::resolve_web_search_mode_and_backend(manifest, model).0
}

pub(crate) fn prepare_v3_responses_direct_web_search_control_request(
    manifest: &V3Config05ManifestPublished,
    server_tool_state: Option<&V3ResponsesDirectServerToolState>,
    server_tool_scope: Option<&V3ResponsesDirectServerToolScope>,
    payload: &mut Value,
    trace: &mut Vec<&'static str>,
) -> Result<(), V3Error01SourceRaised> {
    if !direct_web_search_execution_mode(manifest, payload).is_metadata_center_local_search() {
        return Ok(());
    }
    let (Some(server_tool_state), Some(server_tool_scope)) =
        (server_tool_state, server_tool_scope)
    else {
        return Err(runtime_source(
            "V3DirectWebSearchReq01LocalToolSurfaceActive",
            "web_search execution state is unavailable",
        ));
    };
    if !server_tool_scope.has_client_session_scope() {
        return Ok(());
    }
    let state = crate::hub_v1::apply_v3_web_search_request_hook_at_req04(payload)
        .map_err(|error| runtime_source("V3DirectWebSearchReq01LocalToolSurfaceActive", error.to_string()))?;
    if let Some(state) = state {
        server_tool_state
            .web_search_store_for_scope(
                server_tool_scope,
                state,
                V3ServerToolCenterWriteOrigin {
                    module: "direct_web_search",
                    symbol: "prepare_v3_responses_direct_web_search_control_request",
                    stage: "req04_web_search_surface_active",
                },
                Some("req04 web_search surface activated, store paired state"),
                None,
            )
            .map_err(|error| runtime_source("V3DirectWebSearchReq01LocalToolSurfaceActive", error))?;
        trace.push("V3DirectWebSearchReq01LocalToolSurfaceActive");
    }
    Ok(())
}

pub(crate) fn apply_v3_responses_direct_web_search_control_completion(
    server_tool_state: Option<&V3ResponsesDirectServerToolState>,
    server_tool_scope: Option<&V3ResponsesDirectServerToolScope>,
    payload: &Value,
    trace: &mut Vec<&'static str>,
) -> Result<(), V3Error01SourceRaised> {
    let (Some(server_tool_state), Some(server_tool_scope)) =
        (server_tool_state, server_tool_scope)
    else {
        return Ok(());
    };
    if !server_tool_scope.has_client_session_scope() {
        return Ok(());
    }
    let Some(state) = server_tool_state
        .web_search_load_for_scope(server_tool_scope)
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
    let completed = state
        .transition_to(V3WebSearchCenterPhase::HostedResultProjected, "req04_pair_verified")
        .and_then(|state| {
            state.transition_to(
                V3WebSearchCenterPhase::MainModelContinuationPrepared,
                "req04_pair_verified",
            )
        })
        .and_then(|state| state.transition_to(V3WebSearchCenterPhase::Completed, "req04_pair_verified"))
        .map_err(|reason| runtime_source("V3DirectWebSearchReq02PairVerified", reason))?;
    server_tool_state
        .web_search_store_for_scope(
            server_tool_scope,
            completed,
            V3ServerToolCenterWriteOrigin {
                module: "direct_web_search",
                symbol: "apply_v3_responses_direct_web_search_control_completion",
                stage: "req02_pair_verified",
            },
            Some("req02 pair verified, persist completed web_search state"),
            None,
        )
        .map_err(|error| runtime_source("V3DirectWebSearchReq02PairVerified", error))?;
    trace.push("V3DirectWebSearchReq02PairVerified");
    Ok(())
}

pub(crate) fn apply_v3_responses_direct_web_search_json_response_control(
    server_tool_state: Option<&V3ResponsesDirectServerToolState>,
    server_tool_scope: Option<&V3ResponsesDirectServerToolScope>,
    payload: &mut Value,
    trace: &mut Vec<&'static str>,
) -> Result<Option<V3WebSearchCenterState>, V3Error01SourceRaised> {
    let (Some(server_tool_state), Some(server_tool_scope)) =
        (server_tool_state, server_tool_scope)
    else {
        return Ok(None);
    };
    if !server_tool_scope.has_client_session_scope() {
        return Ok(None);
    }
    let Some(request_state) = server_tool_state
        .web_search_load_for_scope(server_tool_scope)
        .map_err(|error| runtime_source("V3DirectWebSearchResp01Intercepted", error))?
    else {
        return Ok(None);
    };
    if request_state.phase() != V3WebSearchCenterPhase::LocalToolSurfaceActive {
        return Ok(None);
    }
    let resp01 = build_v3_provider_resp_inbound_01_raw_with_compat_profile(
        payload.clone(),
        V3ProviderRespInbound01RawContext::new(
            V3HubEntryProtocol::Responses,
            V3HubProviderWireProtocol::Responses,
            V3HubExecutionMode::Direct,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        ),
    );
    let resp02 = build_provider_resp_compat_02_from_v3_provider_resp_inbound_01(resp01)
        .map_err(|error| runtime_source("V3DirectWebSearchResp01Intercepted", error.to_string()))?;
    let resp02 = build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(resp02)
        .map_err(|error| runtime_source("V3DirectWebSearchResp01Intercepted", error))?;
    let profile = V3HubRelayResponseHookProfile::empty()
        .with_web_search_execution_mode(
            routecodex_v3_config::V3WebSearchExecutionMode::MetadataCenterLocalSearch,
        )
        .with_web_search_center_state(request_state);
    let outcome = apply_v3_tool_call_servertool_hook_at_resp03(resp02, &profile)
        .map_err(|error| runtime_source("V3DirectWebSearchResp01Intercepted", error.to_string()))?;
    *payload = outcome.input.provider_payload().as_ref().clone();
    if !outcome.intercepted {
        return Ok(None);
    }
    trace.push("V3DirectWebSearchResp01Intercepted");
    Ok(outcome.web_search_state)
}

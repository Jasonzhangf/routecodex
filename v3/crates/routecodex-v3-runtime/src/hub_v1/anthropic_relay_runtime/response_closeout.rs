use super::*;

pub(super) async fn closeout_anthropic_relay_sse_response<F>(
    resp01: V3ProviderRespInbound01Raw,
    response_hook_profile: &V3HubRelayResponseHookProfile,
    trace: &mut Vec<&'static str>,
    local: Option<&V3AnthropicRelayLocalContinuationExecution<'_>>,
    requested_local_ids: &[String],
    project_client_response: F,
) -> Result<(Value, bool, V3RuntimeStreamObservation), V3AnthropicRelayRuntimeError>
where
    F: FnOnce(&Value) -> Result<Value, V3AnthropicRelayRuntimeError>,
{
    trace.push("V3ProviderRespInbound01Raw");
    let compat = build_provider_resp_compat_02_from_v3_provider_resp_inbound_01_sse(resp01).await?;
    trace.push("ProviderRespCompat02ProviderCompat");
    let resp02 = build_v3_hub_resp_inbound_02_from_provider_resp_compat_02(compat)
        .map_err(|error| V3AnthropicRelayRuntimeError::Target(error))?;
    trace.push("V3HubRespInbound02Normalized");
    closeout_anthropic_relay_normalized_response(
        resp02,
        response_hook_profile,
        trace,
        local,
        requested_local_ids,
        project_client_response,
    )
}

pub(super) fn closeout_anthropic_relay_response<F>(
    resp01: V3ProviderRespInbound01Raw,
    response_hook_profile: &V3HubRelayResponseHookProfile,
    trace: &mut Vec<&'static str>,
    local: Option<&V3AnthropicRelayLocalContinuationExecution<'_>>,
    requested_local_ids: &[String],
    project_client_response: F,
) -> Result<(Value, bool, V3RuntimeStreamObservation), V3AnthropicRelayRuntimeError>
where
    F: FnOnce(&Value) -> Result<Value, V3AnthropicRelayRuntimeError>,
{
    trace.push("V3ProviderRespInbound01Raw");
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks.normalize(resp01)?;
    trace.push("ProviderRespCompat02ProviderCompat");
    trace.push("V3HubRespInbound02Normalized");
    closeout_anthropic_relay_normalized_response(
        resp02,
        response_hook_profile,
        trace,
        local,
        requested_local_ids,
        project_client_response,
    )
}

fn closeout_anthropic_relay_normalized_response<F>(
    resp02: V3HubRespInbound02Normalized,
    response_hook_profile: &V3HubRelayResponseHookProfile,
    trace: &mut Vec<&'static str>,
    local: Option<&V3AnthropicRelayLocalContinuationExecution<'_>>,
    requested_local_ids: &[String],
    project_client_response: F,
) -> Result<(Value, bool, V3RuntimeStreamObservation), V3AnthropicRelayRuntimeError>
where
    F: FnOnce(&Value) -> Result<Value, V3AnthropicRelayRuntimeError>,
{
    let hooks = compile_v3_hub_relay_response_hooks();
    // 在 resp02 被 govern move 前克隆归一化 payload（含原始 tool_use——
    // Mode B hosted web_search 透传分支需要未剥离的 web_search tool_use）。
    let resp02_payload = resp02.provider_raw().payload.0.clone();
    let stream_observation = V3RuntimeStreamObservation::default();
    crate::hub_v1::record_v3_toolreason_observation_at_resp03(
        &resp02_payload,
        &stream_observation,
        response_hook_profile.toolreason_observation_session_id(),
        response_hook_profile.toolreason_observation_request_id(),
        response_hook_profile.toolreason_expected_model_id(),
    )
    .map_err(V3AnthropicRelayRuntimeError::Target)?;
    let resp03 = hooks.govern(resp02, response_hook_profile)?;
    trace.push("V3HubRespChatProcess03Governed");
    let resp04 = hooks.commit(resp03)?;
    trace.push("V3HubRespContinuation04Committed");
    let servertool_followup_required =
        resp04.previous.servertool_action() == V3HubServertoolResponseAction::FollowupRequired;
    // Mode B 拦截：websearch call 已由 Resp03 剥离（web_search_transition 存在）。
    // 区分两种形状：
    // - hosted `web_search`（anthropic wire server tool `web_search_20250305`，
    //   模型调用 name=web_search）——标准 Anthropic 工具调用协议，透传 tool_use
    //   给客户端（claude code 等）执行搜索并回传结果；
    // - 本地 `websearch`（function name=websearch，无客户端投影路径）——
    //   禁止静默剥离，fail-fast。
    if resp04.web_search_transition().is_some() {
        // 区分两种形状：
        // - hosted `web_search`（anthropic wire server tool `web_search_20250305`，
        //   模型调用 name=web_search）——标准 Anthropic 工具调用协议，透传 tool_use
        //   给客户端（claude code 等）执行搜索并回传结果；
        // - 本地 `websearch`（function name=websearch，无客户端投影路径）——
        //   禁止静默剥离，fail-fast。
        let is_hosted_web_search = first_local_websearch_tool_call(&resp02_payload)?
            .as_ref()
            .is_some_and(|call| call.name.eq_ignore_ascii_case("web_search"));
        if !is_hosted_web_search {
            return Err(V3AnthropicRelayRuntimeError::WebSearchInterceptedUnprojected);
        }
        let client_payload = project_client_response(resp02_payload.as_ref())?;
        return Ok((
            client_payload,
            servertool_followup_required,
            stream_observation,
        ));
    }
    commit_or_release_local_continuation(
        local,
        requested_local_ids,
        resp04.finalized_payload(),
        resp04.action(),
    )?;
    let client_payload = project_client_response(resp04.finalized_payload())?;
    let resp05 = build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04_with_client_payload(
        resp04.into_data(),
        client_payload,
    );
    trace.push("V3HubRespOutbound05ClientSemantic");
    let resp06 = build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05(resp05);
    trace.push("V3ServerRespOutbound06ClientFrame");
    let client_response = resp06.into_client_payload();
    Ok((
        client_response,
        servertool_followup_required,
        stream_observation,
    ))
}

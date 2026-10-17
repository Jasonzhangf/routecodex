use super::*;

pub(super) async fn closeout_anthropic_relay_sse_response<F>(
    resp01: V3ProviderRespInbound01Raw,
    request_id: &str,
    response_hook_profile: &V3HubRelayResponseHookProfile,
    trace: &mut Vec<&'static str>,
    project_client_response: F,
) -> Result<(Value, bool, V3RuntimeStreamObservation), V3AnthropicRelayRuntimeError>
where
    F: FnOnce(&Value) -> Result<Value, V3AnthropicRelayRuntimeError> + Send + 'static,
{
    trace.push("V3ProviderRespInbound01Raw");
    let compat = build_provider_resp_compat_02_from_v3_provider_resp_inbound_01_sse(resp01).await?;
    trace.push("ProviderRespCompat02ProviderCompat");
    let resp02 =
        build_v3_hub_resp_inbound_02_from_provider_resp_compat_02_with_chat_request_and_request_id(
            compat,
            None,
            Some(request_id),
        )
        .map_err(|error| V3AnthropicRelayRuntimeError::Target(error))?;
    trace.push("V3HubRespInbound02Normalized");
    closeout_anthropic_relay_normalized_response(
        resp02,
        request_id,
        response_hook_profile,
        trace,
        project_client_response,
    )
}

pub(super) fn closeout_anthropic_relay_response<F>(
    resp01: V3ProviderRespInbound01Raw,
    request_id: &str,
    response_hook_profile: &V3HubRelayResponseHookProfile,
    trace: &mut Vec<&'static str>,
    project_client_response: F,
) -> Result<(Value, bool, V3RuntimeStreamObservation), V3AnthropicRelayRuntimeError>
where
    F: FnOnce(&Value) -> Result<Value, V3AnthropicRelayRuntimeError> + Send + 'static,
{
    trace.push("V3ProviderRespInbound01Raw");
    let hooks = compile_v3_hub_relay_response_hooks();
    let resp02 = hooks.normalize_with_context(resp01, None, Some(request_id))?;
    trace.push("ProviderRespCompat02ProviderCompat");
    trace.push("V3HubRespInbound02Normalized");
    closeout_anthropic_relay_normalized_response(
        resp02,
        request_id,
        response_hook_profile,
        trace,
        project_client_response,
    )
}

fn closeout_anthropic_relay_normalized_response<F>(
    resp02: V3HubRespInbound02Normalized,
    request_id: &str,
    response_hook_profile: &V3HubRelayResponseHookProfile,
    trace: &mut Vec<&'static str>,
    project_client_response: F,
) -> Result<(Value, bool, V3RuntimeStreamObservation), V3AnthropicRelayRuntimeError>
where
    F: FnOnce(&Value) -> Result<Value, V3AnthropicRelayRuntimeError> + Send + 'static,
{
    let hooks = compile_v3_hub_relay_response_hooks();
    // 在 resp02 被 govern move 前克隆归一化 payload（含原始 tool_use——
    // Mode B hosted web_search 透传分支需要未剥离的 web_search tool_use）。
    let resp02_payload = resp02.provider_raw().payload.0.clone();
    if !crate::hub_v1::v3_provider_json_attempt_has_deliverable_business_content(
        resp02.semantic_protocol(),
        &resp02_payload,
    ) {
        return Err(V3AnthropicRelayRuntimeError::ProviderResponseEmpty);
    }
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
    let (resp03, web_search_transition, _web_search_hook_outcome) = resp03.into_parts();
    let servertool_followup_required =
        resp03.servertool_action() == V3HubServertoolResponseAction::FollowupRequired;
    // Mode B 拦截：websearch call 已由 Resp03 剥离（web_search_transition 存在）。
    // 区分两种形状：
    // - hosted `web_search`（anthropic wire server tool `web_search_20250305`，
    //   模型调用 name=web_search）——标准 Anthropic 工具调用协议，透传 tool_use
    //   给客户端（claude code 等）执行搜索并回传结果；
    // - 本地 `websearch`（function name=websearch，无客户端投影路径）——
    //   禁止静默剥离，fail-fast。
    if web_search_transition.is_some() {
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
    let projection_error = Arc::new(Mutex::new(None));
    let projection_error_for_operator = Arc::clone(&projection_error);
    let resp05 = try_build_v3_hub_resp_outbound_05_from_v3_hub_resp_chat_process_03_with_projector(
        resp03,
        move |payload| match project_client_response(&payload) {
            Ok(output) => Ok(output),
            Err(error) => {
                let message = error.to_string();
                *projection_error_for_operator.lock().map_err(|_| {
                    format!("inverse projection typed error holder is poisoned: {message}")
                })? = Some(error);
                Err(message)
            }
        },
    )
    .map_err(|runner_error| match projection_error.lock() {
        Ok(mut error) => error.take().unwrap_or_else(|| {
            V3AnthropicRelayRuntimeError::ExecutionControlResponse(format!(
                "inverse_project_client_response SDK execution failed: {runner_error}"
            ))
        }),
        Err(_) => V3AnthropicRelayRuntimeError::ExecutionControlResponse(format!(
            "inverse projection typed error holder is poisoned: {runner_error}"
        )),
    })?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closeout_projection_preserves_typed_projector_error() {
        let marker = "anthropic-closeout-typed-projector-marker";
        let response = build_v3_provider_resp_inbound_01_raw(
            serde_json::json!({
                "id": "resp_closeout_typed_error",
                "status": "completed",
                "output": [{
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "hello"}]
                }]
            }),
            V3HubEntryProtocol::Anthropic,
            V3HubProviderWireProtocol::Responses,
            V3HubExecutionMode::Relay,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        );
        let profile = V3HubRelayResponseHookProfile::empty();
        let mut trace = Vec::new();

        let error = closeout_anthropic_relay_response(
            response,
            "req-closeout-typed-error",
            &profile,
            &mut trace,
            |payload| {
                assert_eq!(payload["id"], "resp_closeout_typed_error");
                Err(V3AnthropicRelayRuntimeError::Target(marker.to_string()))
            },
        )
        .expect_err("typed projector failure must fail the closeout");

        match error {
            V3AnthropicRelayRuntimeError::Target(reason) => assert_eq!(reason, marker),
            other => panic!("typed projector error changed variant: {other:?}"),
        }
    }
}

use super::*;

pub(super) async fn closeout_anthropic_relay_sse_response<F>(
    resp01: V3ProviderRespInbound01Raw,
    request_id: &str,
    response_hook_profile: &V3HubRelayResponseHookProfile,
    trace: &mut Vec<&'static str>,
    refill: Option<&mut crate::hub_v1::relay_runtime_core::V3RelayRefillCarrier>,
    project_client_response: F,
) -> Result<(Value, V3RuntimeStreamObservation), V3AnthropicRelayRuntimeError>
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
        refill,
        project_client_response,
    )
}

pub(super) fn closeout_anthropic_relay_response<F>(
    resp01: V3ProviderRespInbound01Raw,
    request_id: &str,
    response_hook_profile: &V3HubRelayResponseHookProfile,
    trace: &mut Vec<&'static str>,
    refill: Option<&mut crate::hub_v1::relay_runtime_core::V3RelayRefillCarrier>,
    project_client_response: F,
) -> Result<(Value, V3RuntimeStreamObservation), V3AnthropicRelayRuntimeError>
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
        refill,
        project_client_response,
    )
}

fn closeout_anthropic_relay_normalized_response<F>(
    resp02: V3HubRespInbound02Normalized,
    request_id: &str,
    response_hook_profile: &V3HubRelayResponseHookProfile,
    trace: &mut Vec<&'static str>,
    refill: Option<&mut crate::hub_v1::relay_runtime_core::V3RelayRefillCarrier>,
    project_client_response: F,
) -> Result<(Value, V3RuntimeStreamObservation), V3AnthropicRelayRuntimeError>
where
    F: FnOnce(&Value) -> Result<Value, V3AnthropicRelayRuntimeError> + Send + 'static,
{
    let hooks = compile_v3_hub_relay_response_hooks();
    // 在 resp02 被 govern move 前克隆归一化 payload（含原始 tool_use）。
    let resp02_payload = resp02.provider_raw().payload.0.clone();
    if !crate::hub_v1::v3_provider_json_attempt_has_deliverable_business_content(
        resp02.semantic_protocol(),
        &resp02_payload,
    ) {
        return Err(V3AnthropicRelayRuntimeError::ProviderResponseEmpty);
    }
    let stream_observation = V3RuntimeStreamObservation::default();
    // 续杯只看源显式 summary：必须在 govern 可能合成 summary 之前取自归一化后的
    // 原生 payload，否则合成 summary 会被误判成源显式。
    let has_source_summary = refill.is_some()
        && super::resp_chat_process_03_governed::has_v3_source_explicit_nonempty_summary(
            &resp02_payload,
        );
    let complete_profile = response_hook_profile
        .clone()
        .with_complete_provider_attempt(true);
    let resp03 = hooks.govern(resp02, &complete_profile)?;
    trace.push("V3HubRespChatProcess03Governed");
    let resp03 = resp03.into_governed();
    let source_terminal_completed = resp03.previous.source_terminal_completed;
    let (accumulated_items, accumulated_usage) = match refill {
        Some(refill) => {
            super::relay_runtime_core::publish_v3_relay_chat_process_round(
                &resp03,
                has_source_summary,
                source_terminal_completed,
                refill,
            );
            (
                Some(refill.accumulated_items.clone()),
                refill.accumulated_usage.clone(),
            )
        }
        None => (None, None),
    };
    let projection_error = Arc::new(Mutex::new(None));
    let projection_error_for_operator = Arc::clone(&projection_error);
    let resp05 = try_build_v3_hub_resp_outbound_05_from_v3_hub_resp_chat_process_03_with_projector(
        resp03,
        move |mut payload| {
            if let Some(accumulated_items) = accumulated_items.as_deref() {
                super::resp_chat_process_03_governed::apply_v3_chat_process_refill_accumulation(
                    &mut payload,
                    accumulated_items,
                    accumulated_usage.as_ref(),
                );
            }
            match project_client_response(&payload) {
                Ok(output) => Ok(output),
                Err(error) => {
                    let message = error.to_string();
                    *projection_error_for_operator.lock().map_err(|_| {
                        format!("inverse projection typed error holder is poisoned: {message}")
                    })? = Some(error);
                    Err(message)
                }
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
    Ok((client_response, stream_observation))
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
            None,
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

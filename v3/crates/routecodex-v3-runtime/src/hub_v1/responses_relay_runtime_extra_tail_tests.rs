use super::*;

#[tokio::test]
async fn responses_provider_sse_codex_rate_limits_extension_does_not_abort_stream() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![
        Ok(b"event: codex.rate_limits\ndata: {\"type\":\"codex.rate_limits\",\"rate_limits\":{\"primary\":{\"used_percent\":12}}}\n\n".to_vec()),
        Ok(b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\n".to_vec()),
        Ok(b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_extension\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"ok\"}]}]}}\n\n".to_vec()),
        Ok(b"data: [DONE]\n\n".to_vec()),
    ]));
    let response =
        build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(provider, &observation)
            .await
            .expect("provider extension must not turn a valid stream into a provider failure");

    assert_eq!(response["status"], "completed");
    assert_eq!(response["output"][0]["content"][0]["text"], "ok");
}

#[tokio::test]
async fn responses_provider_sse_codex_extension_without_terminal_still_fails() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![Ok(
        b"event: codex.rate_limits\ndata: {\"type\":\"codex.rate_limits\",\"rate_limits\":{}}\n\n"
            .to_vec(),
    )]));
    let error =
        build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(provider, &observation)
            .await
            .expect_err("an extension cannot manufacture a terminal response");

    assert!(error
        .to_string()
        .contains("provider response event stream ended before response.completed"));
}

#[tokio::test]
async fn anthropic_provider_sse_malformed_tool_json_fails_without_text_downgrade() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![
            Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_sse\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"MiniMax-M3\",\"content\":[]}}\n\n".to_vec()),
            Ok(b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call_1\",\"name\":\"exec_command\",\"input\":{}}}\n\n".to_vec()),
            Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"cmd\\\":\\\"unterminated\"}}\n\n".to_vec()),
            Ok(b"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n".to_vec()),
            Ok(b"event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\",\"stop_sequence\":null}}\n\n".to_vec()),
            Ok(b"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".to_vec()),
        ]));
    let error = build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
        V3HubProviderWireProtocol::Anthropic,
        provider,
        &observation,
    )
    .await
    .unwrap_err();

    assert!(error.to_string().contains("input_json_delta is malformed"));
}

#[test]
fn web_search_state_machine_advances_to_search_result_captured_via_hop() {
    // 搜索 hop 的状态迁移契约：ToolCallObserved -> SearchResultCaptured
    // 携带归一化结果；非相邻迁移必须被拒绝。
    let observed = V3WebSearchCenterState::new()
        .transition_to(
            V3WebSearchCenterPhase::LocalToolSurfaceActive,
            "req04_web_search_surface_active",
        )
        .expect("idle -> local_tool_surface_active")
        .with_original_call_id(Some("call_ws_1"))
        .with_query(Some("routecodex v3"))
        .transition_to(
            V3WebSearchCenterPhase::ToolCallObserved,
            "resp03_websearch_call_observed",
        )
        .expect("local_tool_surface_active -> tool_call_observed");
    let prepared = observed
        .transition_to(
            V3WebSearchCenterPhase::SearchDispatchPrepared,
            "search_hop_dispatch_prepared",
        )
        .expect("tool_call_observed -> search_dispatch_prepared");
    let in_flight = prepared
        .transition_to(
            V3WebSearchCenterPhase::SearchInFlight,
            "search_hop_in_flight",
        )
        .expect("search_dispatch_prepared -> search_in_flight");
    let captured = in_flight
        .transition_to(
            V3WebSearchCenterPhase::SearchResultCaptured,
            "search_hop_result_captured",
        )
        .expect("search_in_flight -> search_result_captured");
    assert_eq!(
        captured.phase(),
        V3WebSearchCenterPhase::SearchResultCaptured
    );
    assert_eq!(captured.original_call_id(), Some("call_ws_1"));
    assert_eq!(captured.query(), Some("routecodex v3"));
    // 非法迁移：SearchResultCaptured -> SearchInFlight 必须拒绝
    let error = captured
        .transition_to(V3WebSearchCenterPhase::SearchInFlight, "backwards")
        .expect_err("terminal captured must not move backwards");
    assert!(error.contains("invalid web_search ServerTool transition"));
}

#[test]
fn relay_runtime_failure_propagates_supplied_observability() {
    // Red guard: project_v3_responses_relay_runtime_failure 之前对所有
    // source raised 路径都丢弃 observability。本次修复后调用方可显式
    // 传入 Some(observability)，要求 output.observability 字段保留同一对象。
    // 反向：传 None 必须不引入新的 payload 字段；不破坏 Error06 控制面
    // 隔离（仍输出 JSON error body，error_chain 写齐）。
    let mut observability = V3RuntimeObservability::default();
    observability.entry_protocol = "responses".to_string();
    observability.execution_mode = "relay".to_string();
    observability.transport = "json".to_string();
    observability.routing_group_id = Some("group-a".to_string());
    observability.pool_id = Some("pool-a".to_string());
    observability.provider_id = Some("provider-x".to_string());
    observability.provider_key = Some("provider-x:key1:model-y".to_string());
    observability.model_id = Some("model-y".to_string());
    observability.wire_model = Some("model-y".to_string());
    observability.provider_type = Some("openai_responses".to_string());
    observability.attempts = Some(1);
    observability.response_status = Some("error".to_string());
    observability.provider_status = Some(598);

    let output = project_v3_responses_relay_runtime_failure(
        V3ResponsesRelayRuntimeError::WebSearchDispatchFailed("red-test propagation".to_string()),
        Some(observability.clone()),
    );
    assert_eq!(output.status, 598);
    let propagated = output
        .observability
        .as_ref()
        .expect("explicit observability must be retained through relay failure projection");
    assert_eq!(propagated.entry_protocol, observability.entry_protocol);
    assert_eq!(propagated.routing_group_id, observability.routing_group_id);
    assert_eq!(propagated.provider_id, observability.provider_id);
    assert_eq!(propagated.provider_key, observability.provider_key);
    assert_eq!(propagated.model_id, observability.model_id);
    assert_eq!(propagated.wire_model, observability.wire_model);
    assert_eq!(propagated.provider_status, observability.provider_status);
    assert_eq!(
        propagated.response_status.as_deref(),
        Some("error"),
        "responses_relay_failures::error_output must overwrite response_status to 'error'"
    );
    let body = match &output.client_body {
        V3ResponsesRelayClientBody::Json(body) => body,
        V3ResponsesRelayClientBody::Sse(_) => {
            panic!("runtime failure must project as JSON")
        }
    };
    assert_eq!(body["error"]["code"], "responses_relay_runtime_error");
    assert_eq!(
        body["error"]["message"],
        "web_search local search hop failed: red-test propagation"
    );
    assert!(
        body["error"].get("stage").is_none()
            && body["error"].get("class").is_none()
            && body["error"].get("decision").is_none()
            && body["error"].get("target_exhausted").is_none()
            && body["error"].get("candidates_remaining").is_none()
            && body["error"].get("error_node").is_none(),
        "Error06 body must not carry control-plane fields even when observability is supplied: {}",
        body["error"]
    );

    let none_output = project_v3_responses_relay_runtime_failure(
        V3ResponsesRelayRuntimeError::WebSearchDispatchFailed("no-obs".to_string()),
        None,
    );
    assert!(
        none_output.observability.is_none(),
        "no observability input must keep output.observability None to preserve previous behavior"
    );
}

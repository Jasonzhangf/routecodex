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
async fn responses_provider_sse_codex_response_metadata_extension_does_not_abort_stream() {
    // `codex.response.metadata` is a typed provider extension that mirrors
    // `response.metadata` for the same provider; it must not turn a valid
    // 200/201 stream into a provider failure and must not trigger a retry on
    // the same provider.
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![
        Ok(
            b"event: codex.response.metadata\ndata: {\"type\":\"codex.response.metadata\",\"metadata\":{\"request_id\":\"req_1\"}}\n\n"
                .to_vec(),
        ),
        Ok(
            b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\n"
                .to_vec(),
        ),
        Ok(
            b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_extension\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"ok\"}]}]}}\n\n"
                .to_vec(),
        ),
        Ok(b"data: [DONE]\n\n".to_vec()),
    ]));
    let response =
        build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(provider, &observation)
            .await
            .expect("provider extension must not turn a valid stream into a provider failure");

    assert_eq!(response["status"], "completed");
    assert_eq!(response["output"][0]["content"][0]["text"], "ok");
    let snapshot = observation
        .snapshot()
        .expect("runtime stream observation snapshot must remain accessible");
    assert!(
        snapshot
            .typed_object_types
            .iter()
            .any(|event_type| event_type == "responses:codex.response.metadata"),
        "registered codex.response.metadata extension must be observed as a typed provider event: {:?}",
        snapshot.typed_object_types
    );
    assert!(
        snapshot.post_commit_error.is_none(),
        "registered provider extension must not surface a post-commit provider failure: {:?}",
        snapshot.post_commit_error
    );
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

#[tokio::test]
async fn anthropic_provider_sse_live_malformed_tool_json_unquoted_session_id_fails_without_downgrade(
) {
    // Live 2026-09-10 17:58 provider stream: goaichat glm-5.3 emitted a
    // tool-use argument fragment set that concatenates to
    // {"session_id":584d22,...}; the unquoted alphanumeric token is not valid
    // JSON. RouteCodex must classify it as a malformed provider codec stream,
    // never downgrade it to text, and let provider failure policy reselect.
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![
        Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_live\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"glm-5.3\",\"content\":[]}}\n\n".to_vec()),
        Ok(b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":10,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call_live\",\"name\":\"write_stdin\",\"input\":{}}}\n\n".to_vec()),
        Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":10,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"chars\\\": \\\"\"}}\n\n".to_vec()),
        Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":10,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"\"}}\n\n".to_vec()),
        Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":10,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\", \\\"goal_alignment_confidence\\\": \"}}\n\n".to_vec()),
        Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":10,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"0\"}}\n\n".to_vec()),
        Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":10,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\".\"}}\n\n".to_vec()),
        Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":10,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"95\"}}\n\n".to_vec()),
        Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":10,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\", \\\"max_output_tokens\\\": \"}}\n\n".to_vec()),
        Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":10,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"200\"}}\n\n".to_vec()),
        Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":10,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"0\"}}\n\n".to_vec()),
        Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":10,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\", \\\"reason\\\": \\\"\"}}\n\n".to_vec()),
        Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":10,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"Poll\"}}\n\n".to_vec()),
        Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":10,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\" status\"}}\n\n".to_vec()),
        Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":10,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"es\"}}\n\n".to_vec()),
        Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":10,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"\"}}\n\n".to_vec()),
        Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":10,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\", \\\"session_id\\\": \"}}\n\n".to_vec()),
        Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":10,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"584\"}}\n\n".to_vec()),
        Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":10,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"d\"}}\n\n".to_vec()),
        Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":10,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"22\"}}\n\n".to_vec()),
        Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":10,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\", \\\"yield_time_ms\\\": \"}}\n\n".to_vec()),
        Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":10,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"300\"}}\n\n".to_vec()),
        Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":10,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"00\"}}\n\n".to_vec()),
        Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":10,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"}\"}}\n\n".to_vec()),
        Ok(b"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":10}\n\n".to_vec()),
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

#[tokio::test]
async fn anthropic_sse_namespaced_custom_call_keeps_identity_and_result_pairing() {
    let observation = V3RuntimeStreamObservation::default();
    let tools = json!([{"type":"namespace","name":"functions","tools":[
        {"type":"custom","name":"exec","format":{"type":"text"}}
    ]}]);
    let inbound = json!({"model":"kimi-k3","input":[
        {"type":"additional_tools","role":"developer","tools":tools.clone()},
        {"type":"message","role":"user","content":[{"type":"input_text","text":"Run pwd"}]}
    ]});
    let canonical = super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(&inbound)
        .expect("additional_tools must enter the canonical request");
    let context = V3AnthropicResponsesProjectionContext::from_chat_canonical_request(&canonical)
        .expect("projection context");
    let event = |kind: &str, body: serde_json::Value| {
        Ok(format!("event: {kind}\ndata: {body}\n\n").into_bytes())
    };
    let input = "const r=await tools.exec_command({cmd:\"pwd\"}); text(r.output);";
    let provider = Box::pin(stream::iter(vec![
        event(
            "message_start",
            json!({"type":"message_start","message":{"id":"msg_exec","type":"message","role":"assistant","model":"kimi-k3","content":[],"usage":{"input_tokens":10}}}),
        ),
        event(
            "content_block_start",
            json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_a721e55043a14035a8611be4","name":"functions__exec"}}),
        ),
        event(
            "content_block_delta",
            json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":json!({"input":input}).to_string()}}),
        ),
        event(
            "content_block_stop",
            json!({"type":"content_block_stop","index":0}),
        ),
        event(
            "message_delta",
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":2}}),
        ),
        event("message_stop", json!({"type":"message_stop"})),
    ]));
    let response =
        build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol_with_context(
            V3HubProviderWireProtocol::Anthropic,
            provider,
            &observation,
            &context,
        )
        .await
        .expect("tool use must reach Responses");
    let call = &response["output"][0];
    assert_eq!(call["type"], "custom_tool_call");
    assert_eq!(call["namespace"], "functions");
    assert_eq!(call["name"], "exec");
    assert_eq!(call["call_id"], "call_a721e55043a14035a8611be4");
    assert_eq!(call["input"], input);
    let followup = json!({"model":"kimi-k3","tools":tools,"input":[
        call.clone(),
        {"type":"custom_tool_call_output","call_id":call["call_id"],"output":"/tmp"}
    ]});
    let canonical = super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(&followup)
        .expect("client tool result must enter the next turn");
    let next_request =
        super::super::anthropic_codec::encode_v3_responses_semantic_as_anthropic_request(canonical)
            .expect("call and result must project together to Anthropic");
    assert_eq!(
        next_request["messages"][0]["content"][1]["name"],
        "functions__exec"
    );
    assert_eq!(
        next_request["messages"][1]["content"][0]["tool_use_id"],
        call["call_id"]
    );
}

#[tokio::test]
async fn anthropic_sse_top_level_dotted_custom_names_roundtrip_with_results() {
    for client_name in [
        "functions.exec",
        "mcp__mcpx.exec",
        "functions.mcp__mcpx.exec",
    ] {
        let tools = json!([{"type":"custom","name":client_name,"format":{"type":"text"}}]);
        let inbound = json!({"model":"glm-5.3","tools":tools,"input":[
            {"type":"message","role":"user","content":[{"type":"input_text","text":"Run the tool"}]}
        ]});
        let canonical = super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(&inbound)
            .expect("top-level custom declaration must enter Chat Process");
        let outbound =
            super::super::anthropic_codec::encode_v3_responses_semantic_as_anthropic_request(
                canonical.clone(),
            )
            .expect("top-level custom declaration must reach Anthropic");
        let provider_name = outbound["tools"][0]["name"]
            .as_str()
            .expect("provider tool name must come from this request's outbound projection");
        let context =
            V3AnthropicResponsesProjectionContext::from_chat_canonical_request(&canonical)
                .expect("projection context");
        let event = |kind: &str, body: serde_json::Value| {
            Ok(format!("event: {kind}\ndata: {body}\n\n").into_bytes())
        };
        let provider = Box::pin(stream::iter(vec![
            event(
                "message_start",
                json!({"type":"message_start","message":{"id":"msg_dotted","type":"message","role":"assistant","model":"glm-5.3","content":[],"usage":{"input_tokens":10}}}),
            ),
            event(
                "content_block_start",
                json!({"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_dotted","name":provider_name}}),
            ),
            event(
                "content_block_delta",
                json!({"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"input\":\"pwd\"}"}}),
            ),
            event(
                "content_block_stop",
                json!({"type":"content_block_stop","index":0}),
            ),
            event(
                "message_delta",
                json!({"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":2}}),
            ),
            event("message_stop", json!({"type":"message_stop"})),
        ]));
        let response =
            build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol_with_context(
                V3HubProviderWireProtocol::Anthropic,
                provider,
                &V3RuntimeStreamObservation::default(),
                &context,
            )
            .await
            .expect("provider tool use must reach Responses");
        let call = &response["output"][0];
        assert_eq!(call["type"], "custom_tool_call", "{client_name}");
        assert_eq!(call["name"], client_name);
        assert!(call.get("namespace").is_none(), "{client_name}");
        assert_eq!(call["call_id"], "call_dotted");
        assert_eq!(call["input"], "pwd");
        let followup = json!({"model":"glm-5.3","tools":tools,"input":[
            call.clone(),
            {"type":"custom_tool_call_output","call_id":"call_dotted","output":"/tmp"}
        ]});
        let canonical = super::super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(&followup)
            .expect("tool call and result must enter next turn");
        let next_request =
            super::super::anthropic_codec::encode_v3_responses_semantic_as_anthropic_request(
                canonical,
            )
            .expect("tool call and result must return to Anthropic");
        assert_eq!(
            next_request["messages"][0]["content"][1]["name"],
            provider_name
        );
        assert_eq!(
            next_request["messages"][1]["content"][0]["tool_use_id"],
            "call_dotted"
        );
    }
}

#[test]
fn anthropic_dotted_custom_name_survives_request_entry_and_hooks() {
    let request = json!({
        "model": "glm-5.3",
        "stream": true,
        "tools": [{"type":"custom","name":"mcp__mcpx.exec","format":{"type":"text"}}],
        "input": [
            {"type":"message","role":"user","content":[{"type":"input_text","text":"Run the tool"}]},
            {"type":"custom_tool_call","id":"item_dotted","call_id":"call_dotted","name":"mcp__mcpx.exec","input":"pwd"},
            {"type":"custom_tool_call_output","call_id":"call_dotted","output":"/tmp"}
        ]
    });
    let raw = super::super::build_v3_hub_req_inbound_01_client_raw(
        request,
        V3HubEntryProtocol::Responses,
        V3HubInvocationSource::Client,
        V3HubTransportIntent::Sse,
    );
    let invocation = crate::operation_runner::RequestInvocationContext::new(
        crate::operation_runner::V3RequestContextHandle::new(
            "anthropic-dotted-custom-name".to_string(),
            "responses".to_string(),
        ),
        "anthropic-dotted-custom-name-entry".to_string(),
        "anthropic-dotted-custom-name-attempt".to_string(),
        crate::operation_runner::RequestOriginKind::ClientEntry,
    );
    let normalized =
        super::super::build_v3_hub_req_inbound_02_from_request_invocation(raw, &invocation)
            .expect("Responses entry canonicalization");
    assert_eq!(
        normalized.payload()["messages"][1]["tool_calls"][0]["type"],
        "custom"
    );
    assert_eq!(
        normalized.payload()["messages"][1]["tool_calls"][0]["custom"]["name"],
        "mcp__mcpx.exec"
    );
    assert_eq!(
        normalized.payload()["messages"][1]["tool_calls"][0]["custom"]["input"],
        "pwd"
    );
    let governed = super::super::compile_v3_hub_relay_request_hooks()
        .run_from_normalized(
            normalized,
            &super::super::V3HubServertoolRequestProfile::disabled(),
        )
        .expect("request hooks");
    let semantic = governed.payload_arc().as_ref();
    assert_eq!(semantic["messages"][1]["tool_calls"][0]["type"], "custom");
    let standard_view = crate::operation_runner::project_canonical_standard_view(semantic)
        .expect("registered Outbound working view");
    let source = super::super::request_outbound_format::build_v3_anthropic_provider_request_source_from_chat_canonical(
        &standard_view,
        V3HubEntryProtocol::Responses,
    )
    .expect("Anthropic outbound source");
    assert_eq!(source["messages"][1]["tool_calls"][0]["type"], "custom");
    let wire =
        super::super::anthropic_codec::encode_v3_responses_semantic_as_anthropic_request(source)
            .expect("Anthropic wire projection");
    assert_eq!(wire["tools"][0]["name"], "mcp__mcpx.exec");
    let content = wire["messages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|message| message["content"].as_array().into_iter().flatten())
        .collect::<Vec<_>>();
    assert!(
        content
            .iter()
            .any(|part| part["type"] == "tool_use" && part["name"] == "mcp__mcpx.exec"),
        "{wire}"
    );
    assert!(
        content
            .iter()
            .any(|part| part["type"] == "tool_result" && part["tool_use_id"] == "call_dotted"),
        "{wire}"
    );
}
#[tokio::test]
async fn responses_provider_sse_unknown_response_event_fails_instead_of_discarding() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![Ok(
            b"event: response.reasoning_summary.delta\ndata: {\"type\":\"response.reasoning_summary.delta\",\"delta\":\"lost\"}\n\n".to_vec(),
        )]));
    let error =
        build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(provider, &observation)
            .await
            .unwrap_err();

    assert!(error
        .to_string()
        .contains("response.reasoning_summary.delta is unsupported"));
}

#[test]
fn openai_chat_provider_reasoning_content_projects_replay_content_before_tool_call() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "id": "chatcmpl_reasoning_content",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "",
                    "reasoning_content": "Need inspect before running the tool.",
                    "tool_calls": [{
                        "id": "call_reasoning_exec",
                        "type": "custom",
                        "custom": {
                            "name": "exec",
                            "input": "pwd"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        }),
        &json!({
            "tools": [{"type":"custom","name":"exec"}]
        }),
    )
    .expect("OpenAI Chat response must project reasoning to Responses");

    assert_eq!(response["status"], "completed");
    assert_eq!(response["output"][0]["type"], "reasoning");
    assert_eq!(
            response["output"][0]["summary"][0]["text"], "Need inspect before running the tool.",
            "OpenAI Chat reasoning_content must become replay-safe Responses reasoning.summary before tool calls"
        );
    assert_eq!(
        response["output"][0]["content"][0]["text"], "Need inspect before running the tool.",
        "OpenAI Chat reasoning_content must also populate replay-safe Responses reasoning.content"
    );
    assert_eq!(response["output"][1]["type"], "custom_tool_call");
    assert_eq!(response["output"][1]["call_id"], "call_reasoning_exec");
}

#[test]
fn openai_chat_custom_tool_response_round_trips_to_responses_custom_call() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "id": "chatcmpl_apply_patch",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "id": "call_apply_patch",
                        "type": "custom",
                        "custom": {
                            "name": "apply_patch",
                            "input": "*** Begin Patch\n*** End Patch"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        }),
        &json!({
            "tools": [{
                "type":"custom",
                "name":"apply_patch",
                "format":{"type":"grammar","syntax":"lark","definition":"start: patch"}
            }]
        }),
    )
    .expect("Chat function projection must reverse to the declared Responses custom tool");

    assert_eq!(response["status"], "completed");
    assert_eq!(response["output"][0]["type"], "custom_tool_call");
    assert_eq!(response["output"][0]["name"], "apply_patch");
    assert_eq!(
        response["output"][0]["input"],
        "*** Begin Patch\n*** End Patch"
    );
}

#[test]
fn openai_chat_function_tool_call_with_custom_declared_name_round_trips_as_custom_call() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "id": "chatcmpl_apply_patch_flattened",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "id": "call_apply_patch_2",
                        "type": "function",
                        "function": {
                            "name": "apply_patch",
                            "arguments": "{\"input\":\"*** Begin Patch\\n*** End Patch\",\"reason\":\"修改目标文件\",\"goal_alignment_confidence\":100,\"model_id\":\"gpt-test\"}"
                        }
                    }]
                },
                "finish_reason": "tool_calls"
            }]
        }),
        &json!({
            "tools": [{"type":"custom","name":"apply_patch"}]
        }),
    )
    .expect("flattened function tool_call must reverse to the declared Responses custom tool");

    assert_eq!(response["status"], "completed");
    assert_eq!(response["output"][0]["type"], "custom_tool_call");
    assert_eq!(response["output"][0]["name"], "apply_patch");
    assert_eq!(
        response["output"][0]["input"],
        "*** Begin Patch\n*** End Patch"
    );
}

#[test]
fn openai_chat_provider_structured_reasoning_keeps_summary_encrypted_and_replay_content() {
    let response = build_v3_responses_provider_response_from_openai_chat_payload(
        &json!({
            "id": "chatcmpl_structured_reasoning",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "visible answer",
                    "reasoning": {
                        "summary": [{"type":"summary_text","text":"safe summary"}],
                        "content": [{"type":"reasoning_text","text":"private chain"}],
                        "encrypted_content": "enc-opaque"
                    }
                },
                "finish_reason": "stop"
            }]
        }),
        &json!({"tools":[]}),
    )
    .expect("OpenAI Chat structured reasoning must project to Responses");

    assert_eq!(response["status"], "completed");
    assert_eq!(response["output"][0]["type"], "reasoning");
    assert_eq!(response["output"][0]["summary"][0]["text"], "safe summary");
    assert_eq!(response["output"][0]["encrypted_content"], "enc-opaque");
    assert_eq!(
        response["output"][0]["content"][0]["text"], "safe summary",
        "Responses reasoning item must carry replay-safe plaintext content"
    );
    assert_eq!(response["output"][1]["type"], "output_text");
    assert_eq!(response["output"][1]["text"], "visible answer");
    assert!(
        !response.to_string().contains("private chain"),
        "private reasoning.content must not be serialized into the client payload: {response}"
    );
}

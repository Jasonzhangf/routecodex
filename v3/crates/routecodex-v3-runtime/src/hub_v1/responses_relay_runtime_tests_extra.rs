use super::*;
use futures_util::{stream, StreamExt};
use routecodex_v3_config::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};
use routecodex_v3_provider_responses::build_v3_transport_13_responses_http_request_from_parts;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};

#[test]
fn explicit_target_exhaustion_projection_is_compact() {
    let output =
            project_v3_responses_relay_runtime_failure(V3ResponsesRelayRuntimeError::Target(
                "selected target exhausted after [\"routecodex:key1:deepseek-v4-flash:availability(cooldown)\"]"
                    .to_string(),
            ));

    assert_eq!(output.status, 503);
    let body = match &output.client_body {
        V3ResponsesRelayClientBody::Json(body) => body,
        V3ResponsesRelayClientBody::Sse(_) => panic!("target exhaustion must project as JSON"),
    };
    assert_eq!(body["error"]["code"], "selected_target_exhausted");
    assert_eq!(
            body["error"]["message"],
            "selected target exhausted after [\"routecodex:key1:deepseek-v4-flash:availability(cooldown)\"]"
        );
    assert!(
        body["error"].get("class").is_none()
            && body["error"].get("target_exhausted").is_none()
            && body["error"].get("stage").is_none()
            && body["error"].get("decision").is_none(),
        "Error06 body must not carry control-plane fields: {}",
        body["error"]
    );
    assert!(!body.to_string().contains("V3TargetExhaustion"));
    assert_eq!(
        output.error_chain.as_deref(),
        Some(V3_ERROR_CHAIN_NODE_IDS.as_slice())
    );
}

#[test]
fn non_target_runtime_failure_remains_runtime_error() {
    let output = project_v3_responses_relay_runtime_failure(
        V3ResponsesRelayRuntimeError::StaticRegistry("registry unavailable".to_string()),
    );

    assert_eq!(output.status, 500);
    let body = match &output.client_body {
        V3ResponsesRelayClientBody::Json(body) => body,
        V3ResponsesRelayClientBody::Sse(_) => panic!("runtime failure must project as JSON"),
    };
    assert_eq!(body["error"]["code"], "responses_relay_runtime_error");
    assert_eq!(
        body["error"]["message"],
        "V3 Hub static hook registry failed: registry unavailable"
    );
    assert!(
        body["error"].get("class").is_none()
            && body["error"].get("stage").is_none()
            && body["error"].get("decision").is_none()
            && body["error"].get("target_exhausted").is_none()
            && body["error"].get("candidates_remaining").is_none()
            && body["error"].get("error_node").is_none(),
        "Error06 body must not carry control-plane fields: {}",
        body["error"]
    );
    assert_eq!(
        output.error_chain.as_deref(),
        Some(V3_ERROR_CHAIN_NODE_IDS.as_slice())
    );
}

#[test]
fn provider_failure_output_projects_error_chain_body_without_success_wrapping() {
    let terminal_projection = V3ErrorHandlingCenter::project_terminal_decision(
        V3ErrorHandlingCenter::decide_provider(
            V3ErrorHandlingCenterInput {
                source: routecodex_v3_error::build_v3_error_01_source_raised_external(
                    V3ErrorSourceKind::ProviderFailure,
                    "V3ProviderReqOutbound09TransportRequest",
                    "rate_limit_error",
                    "controlled rate limit",
                    routecodex_v3_error::V3ExternalErrorLink {
                        kind: routecodex_v3_error::V3ExternalErrorKind::Provider,
                        status: Some(429),
                        code: Some("rate_limit_error".to_string()),
                        provider_id: Some("controlled".to_string()),
                        upstream_request_id: None,
                        message: Some("controlled rate limit".to_string()),
                    },
                ),
                action_scope: V3ErrorActionScope::ProviderInstance {
                    provider_id: "controlled".to_string(),
                },
                candidates_remaining: 0,
                source_status: Some(429),
            },
            false,
            false,
            None,
        )
        .try_into_terminal()
        .expect("explicit route/default exhaustion proof must yield terminal Error05"),
    );
    let output = provider_failure_output(
        V3ResponsesRelayProviderFailure {
            status: 429,
            policy_error_type: "rate_limit_error".to_string(),
            policy_error_message: "controlled rate limit".to_string(),
            provider_id: "controlled".to_string(),
            source_stage: "V3ProviderReqOutbound09TransportRequest",
            terminal_projection: Some(terminal_projection),
            observability: None,
        },
        vec!["V3ProviderReqOutbound09TransportRequest"],
        0,
    );

    assert_eq!(output.status, 429);
    let body = match &output.client_body {
        V3ResponsesRelayClientBody::Json(body) => body,
        V3ResponsesRelayClientBody::Sse(_) => panic!("provider error must project as JSON"),
    };
    assert_eq!(body["error"]["code"], "rate_limit_error");
    assert_eq!(body["error"]["message"], "controlled rate limit");
    assert!(
        body["error"].get("stage").is_none()
            && body["error"].get("class").is_none()
            && body["error"].get("decision").is_none()
            && body["error"].get("target_exhausted").is_none()
            && body["error"].get("candidates_remaining").is_none()
            && body["error"].get("error_node").is_none()
            && body["error"].get("external_error").is_none(),
        "Error06 body must not carry control-plane fields: {}",
        body["error"]
    );
    assert!(
        body["error"].get("type").is_none(),
        "provider raw error body must not bypass ErrorErr06 projection: {body}"
    );
    assert_eq!(
        output.error_chain.as_deref(),
        Some(V3_ERROR_CHAIN_NODE_IDS.as_slice())
    );
    assert!(!output.node_trace.contains(&"V3ProviderRespInbound01Raw"));
    assert_eq!(output.node_trace.last(), Some(&"V3Error06ClientProjected"));
}

fn test_provider_request(
    stream_intent: routecodex_v3_provider_responses::V3ResponsesStreamIntent,
) -> V3Transport13ResponsesHttpRequest {
    build_v3_transport_13_responses_http_request_from_parts(
            "req_snap_1",
            "provider_snap",
            "https://provider.example/v1/responses",
            V3ProviderAuthHandle {
                alias: "provider_snap:key1:test".to_string(),
                secret: V3ProviderAuthSecretHandle::Environment(
                    "ROUTECODEX_TEST_KEY".to_string(),
                ),
            },
            stream_intent,
            json!({
                "model": "gpt-test",
                "input": [{
                    "type": "message",
                    "role": "user",
                    "content": "snap test",
                    "tools": [{
                        "type": "function",
                        "name": "exec",
                        "parameters": {"type":"object"}
                    }]
                }],
                "stream": stream_intent == routecodex_v3_provider_responses::V3ResponsesStreamIntent::Sse
            }),
        )
        .expect("test provider request")
}

#[derive(Clone)]
struct JsonSnapTransport;

#[async_trait::async_trait]
impl ResponsesTransport for JsonSnapTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        Ok(V3ProviderResp14Raw::from_json(
            request.request_id(),
            request.provider_id(),
            200,
            vec![V3ProviderResponseHeader {
                name: "content-type".to_string(),
                value: b"application/json".to_vec(),
            }],
            br#"{"id":"resp_snap_json","status":"completed","output_text":"ok"}"#.to_vec(),
        ))
    }
}

#[tokio::test]
async fn runtime_provider_snap_captures_provider_request_and_json_response() {
    let transport = V3LiveSnapResponsesTransport {
        inner: JsonSnapTransport,
        snapshots: V3LiveSnapProviderSnapshotRecorder::default(),
    };

    let raw = transport
        .send(test_provider_request(
            routecodex_v3_provider_responses::V3ResponsesStreamIntent::Json,
        ))
        .await
        .expect("provider response");
    let bytes = raw.into_body_bytes().await.expect("json body survives");
    assert_eq!(
        serde_json::from_slice::<Value>(&bytes).unwrap()["output_text"],
        "ok"
    );

    let provider_request = transport
        .snapshots()
        .provider_request_payload()
        .expect("provider request snapshot");
    assert_eq!(provider_request["attempts"][0]["attempt"], 1);
    assert_eq!(
        provider_request["attempts"][0]["request"]["body"]["input"][0]["tools"][0]["name"],
        "exec"
    );
    assert_eq!(
        provider_request["attempts"][0]["request"]["headers"].get("authorization"),
        None
    );
    assert_ne!(
        provider_request["attempts"][0]["request"].to_string(),
        "[REDACTED]"
    );
    assert!(
        provider_request["attempts"][0]["request"]["body"]
            .get("tools")
            .is_none(),
        "snap capture must not rebuild nested tool shape into top-level tools"
    );

    let provider_response = transport
        .snapshots()
        .provider_response_payload()
        .expect("provider response snapshot");
    assert_eq!(
        provider_response["attempts"][0]["response"]["body"]["output_text"],
        "ok"
    );
    assert_eq!(
        provider_response["attempts"][0]["response"]["bodyKind"],
        "json"
    );
}

#[tokio::test]
async fn runtime_provider_snap_respects_stage_selector_for_provider_request_only() {
    let transport = V3LiveSnapResponsesTransport {
        inner: JsonSnapTransport,
        snapshots: V3LiveSnapProviderSnapshotRecorder::default(),
    };

    let raw = transport
        .send(test_provider_request(
            routecodex_v3_provider_responses::V3ResponsesStreamIntent::Json,
        ))
        .await
        .expect("provider response");
    let _ = raw.into_body_bytes().await.expect("json body survives");

    assert!(
        transport.snapshots().provider_request_payload().is_some(),
        "provider-request stage must be available when selected"
    );
    assert!(
        transport
            .snapshots()
            .provider_response_payload_for_selector("client-request,provider-request")
            .is_none(),
        "provider-response stage must stay off when selector excludes it"
    );
}

#[derive(Clone)]
struct SseSnapTransport;

#[async_trait::async_trait]
impl ResponsesTransport for SseSnapTransport {
    async fn send(
        &self,
        request: V3Transport13ResponsesHttpRequest,
    ) -> Result<V3ProviderResp14Raw, V3ProviderError> {
        Ok(V3ProviderResp14Raw::from_sse(
                request.request_id().to_string(),
                request.provider_id().to_string(),
                200,
                vec![V3ProviderResponseHeader {
                    name: "content-type".to_string(),
                    value: b"text/event-stream".to_vec(),
                }],
                Box::pin(futures_util::stream::iter(vec![
                    Ok(b"event: response.output_text.delta\ndata: {\"delta\":\"he\"}\n\n"
                        .to_vec()),
                    Ok(b"event: response.completed\ndata: {\"response\":{\"status\":\"completed\"}}\n\n".to_vec()),
                ])),
            ))
    }
}

#[tokio::test]
async fn runtime_provider_snap_captures_sse_response_without_consuming_stream() {
    let transport = V3LiveSnapResponsesTransport {
        inner: SseSnapTransport,
        snapshots: V3LiveSnapProviderSnapshotRecorder::default(),
    };

    let raw = transport
        .send(test_provider_request(
            routecodex_v3_provider_responses::V3ResponsesStreamIntent::Sse,
        ))
        .await
        .expect("provider response");
    let bytes = raw.into_body_bytes().await.expect("sse body survives");
    let sse_text = String::from_utf8(bytes).unwrap();
    assert!(sse_text.contains("response.output_text.delta"));
    assert!(sse_text.contains("response.completed"));

    let provider_response = transport
        .snapshots()
        .provider_response_payload()
        .expect("provider response snapshot");
    assert_eq!(
        provider_response["attempts"][0]["response"]["bodyKind"],
        "sse"
    );
    let raw_sse = provider_response["attempts"][0]["response"]["rawSse"]
        .as_str()
        .expect("raw SSE");
    assert!(raw_sse.contains("response.output_text.delta"));
    assert!(raw_sse.contains("response.completed"));
}

async fn collect_projected_sse(
    stream: V3ResponsesRelayClientStream,
) -> Vec<Result<String, String>> {
    stream
        .map(|item| {
            item.and_then(|bytes| String::from_utf8(bytes).map_err(|error| error.to_string()))
        })
        .collect()
        .await
}

#[tokio::test]
async fn provider_sse_eof_without_terminal_fails_before_client_projection() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![Ok(
            b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n".to_vec(),
        )]));
    let error =
        build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(provider, &observation)
            .await
            .unwrap_err();

    assert!(error
        .to_string()
        .contains("provider response event stream ended before response.completed"));
}

#[tokio::test]
async fn provider_sse_failed_terminal_returns_provider_sse_error() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![Ok(
            b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"message\":\"upstream stream failed\"}}}\n\n".to_vec(),
        )]));
    let error =
        build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(provider, &observation)
            .await
            .unwrap_err();

    assert!(error.to_string().contains("upstream stream failed"));
    assert_eq!(
        observation.snapshot().unwrap().response_status.as_deref(),
        Some("failed")
    );
}

#[tokio::test]
async fn provider_sse_json_failure_wins_over_opaque_event_label() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![Ok(
            b"event: response.created\ndata: {\"type\":\"response.failed\",\"response\":{\"status\":\"failed\",\"error\":{\"message\":\"json failure\"}}}\n\n".to_vec(),
        )]));
    let error =
        build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(provider, &observation)
            .await
            .unwrap_err();

    assert!(error.to_string().contains("json failure"));
    assert!(!error.to_string().contains("event/type mismatch"));
}

#[tokio::test]
async fn provider_sse_json_completed_wins_over_opaque_event_label() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![Ok(
            b"event: provider-specific-label\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_json_authority\",\"status\":\"completed\"}}\n\n".to_vec(),
        )]));
    let response =
        build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(provider, &observation)
            .await
            .expect("JSON response.completed must remain terminal");

    assert_eq!(response["id"], "resp_json_authority");
    assert_eq!(response["status"], "completed");
}

#[tokio::test]
async fn provider_sse_incomplete_is_terminal_response_with_usage_observation() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![Ok(
            b"event: response.incomplete\ndata: {\"type\":\"response.incomplete\",\"response\":{\"id\":\"resp_incomplete\",\"status\":\"incomplete\",\"incomplete_details\":{\"reason\":\"max_output_tokens\"},\"usage\":{\"input_tokens\":10,\"output_tokens\":5,\"total_tokens\":15}}}\n\n".to_vec(),
        )]));
    let response =
        build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(provider, &observation)
            .await
            .expect("response.incomplete must materialize as a terminal response, not an error");

    assert_eq!(response["status"], "incomplete");
    assert_eq!(
        response["incomplete_details"]["reason"],
        "max_output_tokens"
    );
    let snapshot = observation.snapshot().unwrap();
    assert_eq!(snapshot.response_status.as_deref(), Some("incomplete"));
    assert_eq!(
        snapshot.finish_reason.as_deref(),
        Some("length"),
        "max_output_tokens incomplete terminal must record finish_reason=length"
    );
}

#[tokio::test]
async fn provider_sse_raw_json_error_body_exposes_upstream_error() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![Ok(
        b"data: {\"error\":{\"message\":\"Panic detected\",\"type\":\"new_api_panic\"}}\n\n"
            .to_vec(),
    )]));
    let error =
        build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(provider, &observation)
            .await
            .unwrap_err();

    assert!(error.to_string().contains("new_api_panic"));
    assert!(error.to_string().contains("Panic detected"));
}

#[tokio::test]
async fn provider_sse_done_without_completed_is_terminal_missing() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![
            Ok(b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n".to_vec()),
            Ok(b"event: response.done\ndata: {\"type\":\"response.done\",\"response\":{\"id\":\"resp_done\",\"status\":\"completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":2,\"total_tokens\":3}}}\n\n".to_vec()),
            Ok(b"data: [DONE]\n\n".to_vec()),
        ]));
    let error =
        build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(provider, &observation)
            .await
            .unwrap_err();

    assert!(error
        .to_string()
        .contains("provider response event stream ended before response.completed"));
}

#[tokio::test]
async fn provider_sse_requires_action_without_completed_is_terminal_missing() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![Ok(
            b"event: response.requires_action\ndata: {\"type\":\"response.requires_action\",\"response\":{\"id\":\"resp_required\",\"status\":\"requires_action\"},\"required_action\":{\"type\":\"submit_tool_outputs\"}}\n\n".to_vec(),
        )]));
    let error =
        build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(provider, &observation)
            .await
            .unwrap_err();

    assert!(error
        .to_string()
        .contains("provider response event stream ended before response.completed"));
}

#[tokio::test]
async fn client_sse_function_call_projection_missing_call_id_fails_explicitly() {
    let projected = collect_projected_sse(
        build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05(json!({
            "id": "resp_bad_call_id",
            "status": "requires_action",
            "output": [{
                "type": "function_call",
                "name": "exec_command",
                "arguments": "{\"cmd\":\"pwd\"}"
            }]
        })),
    )
    .await;
    let error = projected
        .into_iter()
        .find_map(Result::err)
        .expect("missing call_id must fail before terminal success");

    assert!(
        error.contains("missing call_id"),
        "missing function_call call_id must be an explicit SSE projection error: {error}"
    );
}

#[tokio::test]
async fn client_sse_function_call_projection_missing_arguments_fails_explicitly() {
    let projected = collect_projected_sse(
        build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05(json!({
            "id": "resp_bad_arguments",
            "status": "requires_action",
            "output": [{
                "type": "function_call",
                "call_id": "call_missing_args",
                "name": "exec_command"
            }]
        })),
    )
    .await;
    let error = projected
        .into_iter()
        .find_map(Result::err)
        .expect("missing arguments must fail before terminal success");

    assert!(
        error.contains("missing string arguments"),
        "missing function_call arguments must be an explicit SSE projection error: {error}"
    );
}

#[tokio::test]
async fn client_sse_completed_response_projects_output_text_items_to_message_shape() {
    // 同一 SSE 流内 completed/done 内嵌 response 的 output item 必须与
    // output_item.done 一致（output_text -> message 包裹），不允许同一
    // output 条目出现两种 client 语义。
    let projected = collect_projected_sse(
        build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05(json!({
            "id": "resp_completed_shape",
            "status": "completed",
            "output": [{"type": "output_text", "text": "done"}]
        })),
    )
    .await;
    let text: String = projected
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .expect("SSE projection must not error")
        .join("\n");
    let completed = text
        .find("event: response.completed")
        .map(|index| &text[index..])
        .expect("response.completed frame must be present");
    assert!(
            completed.contains(r#""output":[{"content":[{"text":"done","type":"output_text"}],"role":"assistant","type":"message"}]"#),
            "completed response.output must use message shape consistent with output_item.done: {completed}"
        );
    let done = text
        .find("event: response.done")
        .map(|index| &text[index..])
        .expect("response.done frame must be present");
    assert!(
            done.contains(r#""output":[{"content":[{"text":"done","type":"output_text"}],"role":"assistant","type":"message"}]"#),
            "done response.output must use message shape consistent with output_item.done: {done}"
        );
}

#[tokio::test]
async fn client_sse_incomplete_terminal_streams_partial_output_not_failed() {
    // response.incomplete 是 Responses 协议合法终态：必须保留部分输出并投影
    // response.created + output_item.done + response.incomplete + response.done
    // + [DONE]，禁止映射成 response.failed 丢弃部分输出。
    let projected = collect_projected_sse(
        build_v3_server_resp_outbound_06_sse_transport_frames_from_resp05(json!({
            "id": "resp_incomplete_shape",
            "status": "incomplete",
            "incomplete_details": {"reason": "max_output_tokens"},
            "output": [{"type": "output_text", "text": "partial"}]
        })),
    )
    .await;
    let text: String = projected
        .into_iter()
        .collect::<Result<Vec<_>, _>>()
        .expect("SSE projection must not error")
        .join("\n");
    assert!(
        !text.contains("response.failed"),
        "incomplete must not project response.failed: {text}"
    );
    assert!(
        text.contains("event: response.created"),
        "response.created frame must be present: {text}"
    );
    assert!(
        text.contains(r#""type":"response.output_item.done""#),
        "partial output_item.done frames must be streamed: {text}"
    );
    assert!(
        text.contains("event: response.incomplete"),
        "response.incomplete frame must be present: {text}"
    );
    assert!(
        text.contains(r#""status":"incomplete""#),
        "incomplete frame must preserve status=incomplete: {text}"
    );
    assert!(
        text.contains(r#""reason":"max_output_tokens""#),
        "incomplete frame must preserve incomplete_details.reason: {text}"
    );
    assert!(
        text.contains("partial"),
        "partial output must not be dropped: {text}"
    );
    assert!(
        text.contains("event: response.done") && text.contains("data: [DONE]"),
        "incomplete terminal must close with response.done + [DONE]: {text}"
    );
}

#[tokio::test]
async fn anthropic_provider_sse_canonicalizes_responses_response_before_chatprocess() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![
            Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_sse\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"MiniMax-M3\",\"content\":[],\"stop_reason\":null,\"usage\":{\"input_tokens\":10}}}\n\n".to_vec()),
            Ok(b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n".to_vec()),
            Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"V3_ANTHROPIC_\"}}\n\n".to_vec()),
            Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"SSE_OK\"}}\n\n".to_vec()),
            Ok(b"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n".to_vec()),
            Ok(b"event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":2}}\n\n".to_vec()),
            Ok(b"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".to_vec()),
        ]));
    let response = build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
        V3HubProviderWireProtocol::Anthropic,
        provider,
        &observation,
    )
    .await
    .expect("Anthropic provider event stream must canonicalize before Responses Chat Process");

    assert_eq!(response["status"], "completed");
    assert_eq!(response["output"][0]["type"], "message");
    assert_eq!(
        response["output"][0]["content"][0]["text"],
        "V3_ANTHROPIC_SSE_OK"
    );
    let snapshot = observation.snapshot().expect("stream observation");
    assert_eq!(snapshot.response_status.as_deref(), Some("completed"));
    assert_eq!(snapshot.finish_reason.as_deref(), Some("end_turn"));
}

#[tokio::test]
async fn anthropic_provider_sse_uses_responses_projection_context_for_metadata_and_custom_tools() {
    let observation = V3RuntimeStreamObservation::default();
    let context = V3AnthropicResponsesProjectionContext::from_chat_canonical_request(&json!({
        "tools":[{
            "type":"custom",
            "name":"apply_patch",
            "description":"apply a patch"
        }],
        "routecodex_chat_extension":{
            "responses_request":{
                "metadata":{"trace_id":"sse-context-kept"}
            }
        }
    }))
    .expect("projection context");
    let provider = Box::pin(stream::iter(vec![
            Ok(br#"event: message_start
data: {"type":"message_start","message":{"id":"msg_sse_custom","type":"message","role":"assistant","model":"claude-fable-5","content":[],"usage":{"input_tokens":10}}}

"#
            .to_vec()),
            Ok(br#"event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call_apply_patch","name":"apply_patch"}}

"#
            .to_vec()),
            Ok(br#"event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"input\":\"*** Begin Patch\\n*** End Patch\"}"}}

"#
            .to_vec()),
            Ok(br#"event: content_block_stop
data: {"type":"content_block_stop","index":0}

"#
            .to_vec()),
            Ok(br#"event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":2}}

"#
            .to_vec()),
            Ok(br#"event: message_stop
data: {"type":"message_stop"}

"#
            .to_vec()),
        ]));

    let response =
        build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol_with_context(
            V3HubProviderWireProtocol::Anthropic,
            provider,
            &observation,
            &context,
        )
        .await
        .expect("Anthropic SSE projection must use request context");

    assert_eq!(response["metadata"]["trace_id"], "sse-context-kept");
    assert_eq!(response["output"][0]["type"], "custom_tool_call");
    assert_eq!(response["output"][0]["call_id"], "call_apply_patch");
    assert_eq!(response["output"][0]["name"], "apply_patch");
    assert_eq!(
        response["output"][0]["input"],
        "*** Begin Patch\n*** End Patch"
    );
}

#[tokio::test]
async fn anthropic_provider_sse_duplicate_message_start_before_content_merges_metadata() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![
            Ok(br#"event: message_start
data: {"type":"message_start","message":{"id":"msg_dup","type":"message","role":"assistant","content":[],"model":"claude-fable-5","usage":{"input_tokens":7}}}

"#
            .to_vec()),
            Ok(br#"event: message_start
data: {"type":"message_start","message":{"model":"claude-fable-5","id":"msg_dup","type":"message","role":"assistant","content":[],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"cache_read_input_tokens":5,"output_tokens":0,"service_tier":"standard"}}}

"#
            .to_vec()),
            Ok(br#"event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

"#
            .to_vec()),
            Ok(br#"event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"duplicate start tolerated"}}

"#
            .to_vec()),
            Ok(br#"event: content_block_stop
data: {"type":"content_block_stop","index":0}

"#
            .to_vec()),
            Ok(br#"event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}

"#
            .to_vec()),
            Ok(br#"event: message_stop
data: {"type":"message_stop"}

"#
            .to_vec()),
        ]));
    let response = build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
        V3HubProviderWireProtocol::Anthropic,
        provider,
        &observation,
    )
    .await
    .expect("compatible duplicate message_start must be provider codec compatible");

    assert_eq!(response["id"], "msg_dup");
    assert_eq!(response["model"], "claude-fable-5");
    assert_eq!(response["status"], "completed");
    assert_eq!(response["finish_reason"], "end_turn");
    assert_eq!(
        response["output"][0]["content"][0]["text"],
        "duplicate start tolerated"
    );
    assert_eq!(response["usage"]["input_tokens"], 7);
    assert_eq!(response["usage"]["output_tokens"], 3);
    assert_eq!(response["usage"]["total_tokens"], 10);
    assert_eq!(response["usage"]["cache_read_input_tokens"], 5);
}

#[tokio::test]
async fn anthropic_provider_sse_duplicate_message_start_eof_without_stop_still_fails() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![
            Ok(br#"event: message_start
data: {"type":"message_start","message":{"id":"msg_dup_eof","type":"message","role":"assistant","model":"claude-fable-5","content":[],"usage":{"input_tokens":7}}}

"#
            .to_vec()),
            Ok(br#"event: message_start
data: {"type":"message_start","message":{"model":"claude-fable-5","id":"msg_dup_eof","type":"message","role":"assistant","content":[],"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"output_tokens":0}}}

"#
            .to_vec()),
        ]));
    let error = build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
        V3HubProviderWireProtocol::Anthropic,
        provider,
        &observation,
    )
    .await
    .unwrap_err();

    assert!(error
        .to_string()
        .contains("Anthropic provider event stream ended without message_stop"));
    assert!(!error.to_string().contains("duplicate message_start"));
}

#[tokio::test]
async fn anthropic_provider_sse_duplicate_message_start_different_id_fails() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![
            Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_one\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-fable-5\",\"content\":[]}}\n\n".to_vec()),
            Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_two\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-fable-5\",\"content\":[]}}\n\n".to_vec()),
        ]));
    let error = build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
        V3HubProviderWireProtocol::Anthropic,
        provider,
        &observation,
    )
    .await
    .unwrap_err();

    assert!(error
        .to_string()
        .contains("duplicate message_start with different id"));
}

#[tokio::test]
async fn anthropic_provider_sse_duplicate_message_start_after_content_start_fails() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![
            Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_after_content\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-fable-5\",\"content\":[]}}\n\n".to_vec()),
            Ok(b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n".to_vec()),
            Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_after_content\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-fable-5\",\"content\":[]}}\n\n".to_vec()),
        ]));
    let error = build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
        V3HubProviderWireProtocol::Anthropic,
        provider,
        &observation,
    )
    .await
    .unwrap_err();

    assert!(error
        .to_string()
        .contains("duplicate message_start after content_block_start"));
}

#[tokio::test]
async fn anthropic_provider_sse_message_stop_closes_open_thinking_block_without_502() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![
            Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_glmrelay\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"glm-5.2\",\"content\":[],\"usage\":{\"input_tokens\":210584,\"output_tokens\":0}}}\n\n".to_vec()),
            Ok(b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n".to_vec()),
            Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"Working on it\"}}\n\n".to_vec()),
            Ok(b"event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"input_tokens\":205404,\"cache_read_input_tokens\":203776,\"output_tokens\":28},\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n".to_vec()),
            Ok(b"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".to_vec()),
        ]));
    let response = build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
            V3HubProviderWireProtocol::Anthropic,
            provider,
            &observation,
        )
        .await
        .expect(
            "terminal Anthropic message_stop must preserve completed thinking instead of raising synthetic 502",
        );

    assert_eq!(response["status"], "completed");
    assert_eq!(response["output"][0]["type"], "reasoning");
    assert_eq!(response["output"][0]["summary"][0]["text"], "Working on it");
    let snapshot = observation.snapshot().expect("stream observation");
    assert_eq!(snapshot.response_status.as_deref(), Some("completed"));
    assert_eq!(snapshot.finish_reason.as_deref(), Some("end_turn"));
}

#[tokio::test]
async fn anthropic_provider_sse_rejects_thinking_text_alias() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![
            Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_alias\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-fable-5\",\"content\":[]}}\n\n".to_vec()),
            Ok(b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"text\":\"alias text\"}}\n\n".to_vec()),
            Ok(b"event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n".to_vec()),
            Ok(b"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".to_vec()),
        ]));
    let error = build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
        V3HubProviderWireProtocol::Anthropic,
        provider,
        &observation,
    )
    .await
    .unwrap_err();

    assert!(error
        .to_string()
        .contains("Anthropic codec malformed reasoning content"));
}

#[tokio::test]
async fn anthropic_provider_sse_rejects_thinking_delta_text_alias() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![
            Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_delta_alias\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-fable-5\",\"content\":[]}}\n\n".to_vec()),
            Ok(b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n".to_vec()),
            Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"text\":\"alias text\"}}\n\n".to_vec()),
        ]));
    let error = build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
        V3HubProviderWireProtocol::Anthropic,
        provider,
        &observation,
    )
    .await
    .unwrap_err();

    assert!(error
        .to_string()
        .contains("Anthropic codec malformed reasoning content"));
}

#[tokio::test]
async fn anthropic_provider_sse_rejects_redacted_signature_alias() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![
            Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_redacted_alias\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-fable-5\",\"content\":[]}}\n\n".to_vec()),
            Ok(b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"redacted_thinking\",\"signature\":\"alias data\"}}\n\n".to_vec()),
        ]));
    let error = build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
        V3HubProviderWireProtocol::Anthropic,
        provider,
        &observation,
    )
    .await
    .unwrap_err();

    assert!(error
        .to_string()
        .contains("Anthropic codec malformed reasoning content"));
}

#[tokio::test]
async fn anthropic_provider_sse_rejects_native_and_alias_dual_truth() {
    for content_block in [
        r#"{"type":"thinking","thinking":"native","text":"alias"}"#,
        r#"{"type":"redacted_thinking","data":"native","signature":"alias"}"#,
    ] {
        let observation = V3RuntimeStreamObservation::default();
        let stream = format!(
                "event: message_start\ndata: {{\"type\":\"message_start\",\"message\":{{\"id\":\"msg_dual\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-fable-5\",\"content\":[]}}}}\n\nevent: content_block_start\ndata: {{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{content_block}}}\n\n"
            );
        let provider = Box::pin(stream::iter(vec![Ok(stream.into_bytes())]));
        let error = build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
            V3HubProviderWireProtocol::Anthropic,
            provider,
            &observation,
        )
        .await
        .unwrap_err();

        assert!(error
            .to_string()
            .contains("Anthropic codec malformed reasoning content"));
    }
}

#[tokio::test]
async fn anthropic_provider_sse_message_stop_does_not_close_open_tool_block() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![
            Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_tool_missing_stop\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"glm-5.2\",\"content\":[]}}\n\n".to_vec()),
            Ok(b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"call_1\",\"name\":\"exec_command\",\"input\":{}}}\n\n".to_vec()),
            Ok(b"event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"}}\n\n".to_vec()),
            Ok(b"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n".to_vec()),
        ]));
    let error = build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
        V3HubProviderWireProtocol::Anthropic,
        provider,
        &observation,
    )
    .await
    .unwrap_err();

    assert!(error
        .to_string()
        .contains("content block 0 ended without content_block_stop"));
}

#[tokio::test]
async fn anthropic_provider_sse_eof_without_message_stop_fails_before_success() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![
            Ok(b"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_sse\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[]}}\n\n".to_vec()),
            Ok(b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n".to_vec()),
            Ok(b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"partial\"}}\n\n".to_vec()),
        ]));
    let error = build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
        V3HubProviderWireProtocol::Anthropic,
        provider,
        &observation,
    )
    .await
    .unwrap_err();

    assert!(error
        .to_string()
        .contains("Anthropic provider event stream ended without message_stop"));
}

#[tokio::test]
async fn anthropic_provider_sse_raw_json_error_body_exposes_upstream_error() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![Ok(
        b"data: {\"error\":{\"message\":\"Panic detected\",\"type\":\"new_api_panic\"}}\n\n"
            .to_vec(),
    )]));
    let error = build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
        V3HubProviderWireProtocol::Anthropic,
        provider,
        &observation,
    )
    .await
    .unwrap_err();

    assert!(error.to_string().contains("new_api_panic"));
    assert!(error.to_string().contains("Panic detected"));
}

#[tokio::test]
async fn openai_chat_provider_sse_raw_json_error_body_exposes_upstream_error() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![Ok(
        b"data: {\"error\":{\"message\":\"Panic detected\",\"type\":\"new_api_panic\"}}\n\n"
            .to_vec(),
    )]));
    let error = build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
        V3HubProviderWireProtocol::OpenAiChat,
        provider,
        &observation,
    )
    .await
    .unwrap_err();

    assert!(error.to_string().contains("new_api_panic"));
    assert!(error.to_string().contains("Panic detected"));
}

#[tokio::test]
async fn responses_provider_sse_materializes_created_tool_usage_without_silent_loss() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![
            Ok(b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_scaffold\",\"model\":\"provider-model\",\"created_at\":123}}\n\n".to_vec()),
            Ok(b"event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"exec_command\",\"arguments\":\"\"}}\n\n".to_vec()),
            Ok(b"event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"call_id\":\"call_1\",\"delta\":\"{\\\"cmd\\\":\"}\n\n".to_vec()),
            Ok(b"event: response.function_call_arguments.done\ndata: {\"type\":\"response.function_call_arguments.done\",\"call_id\":\"call_1\",\"arguments\":\"{\\\"cmd\\\":\\\"pwd\\\"}\"}\n\n".to_vec()),
            Ok(b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"requires_action\",\"usage\":{\"input_tokens\":2,\"output_tokens\":3,\"total_tokens\":5}},\"required_action\":{\"type\":\"submit_tool_outputs\"}}\n\n".to_vec()),
            Ok(b"data: [DONE]\n\n".to_vec()),
        ]));
    let response =
        build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(provider, &observation)
            .await
            .unwrap();

    assert_eq!(response["id"], "resp_scaffold");
    assert_eq!(response["model"], "provider-model");
    assert_eq!(response["created_at"], 123);
    assert_eq!(response["status"], "requires_action");
    assert_eq!(response["required_action"]["type"], "submit_tool_outputs");
    assert_eq!(response["usage"]["total_tokens"], 5);
    assert_eq!(response["output"][0]["call_id"], "call_1");
    assert_eq!(response["output"][0]["arguments"], "{\"cmd\":\"pwd\"}");
}

#[tokio::test]
async fn responses_provider_sse_reasoning_summary_events_materialize_without_provider_failure() {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![
            Ok(b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_reasoning_summary\",\"model\":\"provider-model\",\"created_at\":123}}\n\n".to_vec()),
            Ok(b"event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"item\":{\"id\":\"rs_1\",\"type\":\"reasoning\",\"summary\":[]}}\n\n".to_vec()),
            Ok(b"event: response.reasoning_summary_part.added\ndata: {\"type\":\"response.reasoning_summary_part.added\",\"output_index\":0,\"item_id\":\"rs_1\",\"summary_index\":0,\"part\":{\"type\":\"summary_text\",\"text\":\"\"}}\n\n".to_vec()),
            Ok(b"event: response.reasoning_summary_text.delta\ndata: {\"type\":\"response.reasoning_summary_text.delta\",\"output_index\":0,\"item_id\":\"rs_1\",\"summary_index\":0,\"delta\":\"Need \"}\n\n".to_vec()),
            Ok(b"event: response.reasoning_summary_text.delta\ndata: {\"type\":\"response.reasoning_summary_text.delta\",\"output_index\":0,\"item_id\":\"rs_1\",\"summary_index\":0,\"delta\":\"inspect\"}\n\n".to_vec()),
            Ok(b"event: response.reasoning_summary_text.done\ndata: {\"type\":\"response.reasoning_summary_text.done\",\"output_index\":0,\"item_id\":\"rs_1\",\"summary_index\":0,\"text\":\"Need inspect\"}\n\n".to_vec()),
            Ok(b"event: response.reasoning_summary_part.done\ndata: {\"type\":\"response.reasoning_summary_part.done\",\"output_index\":0,\"item_id\":\"rs_1\",\"summary_index\":0,\"part\":{\"type\":\"summary_text\",\"text\":\"Need inspect\"}}\n\n".to_vec()),
            Ok(b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":2,\"output_tokens\":3,\"total_tokens\":5}}}\n\n".to_vec()),
            Ok(b"data: [DONE]\n\n".to_vec()),
        ]));
    let response =
        build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(provider, &observation)
            .await
            .unwrap();

    assert_eq!(response["id"], "resp_reasoning_summary");
    assert_eq!(response["status"], "completed");
    assert_eq!(response["usage"]["total_tokens"], 5);
    assert_eq!(response["output"][0]["id"], "rs_1");
    assert_eq!(response["output"][0]["type"], "reasoning");
    assert_eq!(
        response["output"][0]["summary"][0],
        json!({"type":"summary_text","text":"Need inspect"})
    );
}

#[tokio::test]
async fn responses_provider_sse_custom_tool_call_input_events_materialize_without_provider_failure()
{
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![
            Ok(b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_custom_tool_call_input\",\"model\":\"provider-model\",\"created_at\":123}}\n\n".to_vec()),
            Ok(b"event: response.output_item.added\ndata: {\"type\":\"response.output_item.added\",\"item\":{\"type\":\"custom_tool_call\",\"call_id\":\"call_ctc\",\"name\":\"exec_command\",\"input\":\"\"}}\n\n".to_vec()),
            Ok(b"event: response.custom_tool_call_input.delta\ndata: {\"type\":\"response.custom_tool_call_input.delta\",\"output_index\":0,\"item_id\":\"ctc_1\",\"delta\":\"{\\\"cmd\\\":\\\"\"}\n\n".to_vec()),
            Ok(b"event: response.custom_tool_call_input.delta\ndata: {\"type\":\"response.custom_tool_call_input.delta\",\"output_index\":0,\"item_id\":\"ctc_1\",\"delta\":\"pwd\\\"}\"}\n\n".to_vec()),
            Ok(b"event: response.custom_tool_call_input.done\ndata: {\"type\":\"response.custom_tool_call_input.done\",\"output_index\":0,\"item_id\":\"ctc_1\",\"input\":\"{\\\"cmd\\\":\\\"pwd\\\"}\"}\n\n".to_vec()),
            Ok(b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"usage\":{\"input_tokens\":2,\"output_tokens\":3,\"total_tokens\":5}}}\n\n".to_vec()),
            Ok(b"data: [DONE]\n\n".to_vec()),
        ]));
    let response =
        build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(provider, &observation)
            .await
            .unwrap();

    assert_eq!(response["id"], "resp_custom_tool_call_input");
    assert_eq!(response["status"], "completed");
    assert_eq!(response["usage"]["total_tokens"], 5);
    assert_eq!(response["output"][0]["type"], "custom_tool_call");
    assert_eq!(response["output"][0]["call_id"], "call_ctc");
    assert_eq!(response["output"][0]["input"], "{\"cmd\":\"pwd\"}");
}

#[tokio::test]
async fn responses_provider_sse_merges_stream_output_items_into_terminal_output_without_silent_loss(
) {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![
            Ok(b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_tool_search_merge\",\"model\":\"provider-model\",\"created_at\":123}}\n\n".to_vec()),
            Ok(b"event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"id\":\"rs_1\",\"type\":\"reasoning\",\"summary\":[{\"type\":\"summary_text\",\"text\":\"Searching\"}]}}\n\n".to_vec()),
            Ok(b"event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"output_index\":1,\"item\":{\"id\":\"tsc_1\",\"type\":\"tool_search_call\",\"call_id\":\"call_search\",\"execution\":\"client\",\"status\":\"completed\",\"arguments\":{\"query\":\"computer use control local Mac apps screenshot click type\",\"limit\":5}}}\n\n".to_vec()),
            Ok(b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_tool_search_merge\",\"status\":\"completed\",\"output\":[{\"id\":\"rs_1\",\"type\":\"reasoning\",\"summary\":[{\"type\":\"summary_text\",\"text\":\"Searching\"}]}],\"usage\":{\"input_tokens\":2,\"output_tokens\":214,\"total_tokens\":216}}}\n\n".to_vec()),
            Ok(b"data: [DONE]\n\n".to_vec()),
        ]));
    let response =
        build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(provider, &observation)
            .await
            .unwrap();

    assert_eq!(response["status"], "completed");
    assert_eq!(response["usage"]["output_tokens"], 214);
    assert_eq!(response["output"].as_array().unwrap().len(), 2);
    assert_eq!(response["output"][0]["type"], "reasoning");
    assert_eq!(response["output"][1]["type"], "tool_search_call");
    assert_eq!(response["output"][1]["call_id"], "call_search");
    assert_eq!(
        response["output"][1]["arguments"]["query"],
        "computer use control local Mac apps screenshot click type"
    );
}

#[tokio::test]
async fn responses_provider_sse_stream_output_without_identity_does_not_overwrite_terminal_output()
{
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(vec![
            Ok(b"event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_no_identity_merge\",\"model\":\"provider-model\",\"created_at\":123}}\n\n".to_vec()),
            Ok(b"event: response.output_item.done\ndata: {\"type\":\"response.output_item.done\",\"output_index\":0,\"item\":{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"stream text\"}]}}\n\n".to_vec()),
            Ok(b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_no_identity_merge\",\"status\":\"completed\",\"output\":[{\"type\":\"reasoning\",\"summary\":[{\"type\":\"summary_text\",\"text\":\"terminal reasoning\"}]}],\"usage\":{\"input_tokens\":2,\"output_tokens\":4,\"total_tokens\":6}}}\n\n".to_vec()),
            Ok(b"data: [DONE]\n\n".to_vec()),
        ]));
    let response =
        build_v3_hub_resp_inbound_02_from_responses_provider_stream_events(provider, &observation)
            .await
            .unwrap();

    assert_eq!(response["status"], "completed");
    assert_eq!(response["output"].as_array().unwrap().len(), 2);
    assert_eq!(response["output"][0]["type"], "message");
    assert_eq!(response["output"][1]["type"], "reasoning");
    assert_eq!(
        response["output"][1]["summary"][0]["text"],
        "terminal reasoning"
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

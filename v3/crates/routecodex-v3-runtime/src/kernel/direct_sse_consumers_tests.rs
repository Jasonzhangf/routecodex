use super::*;
use crate::sse_object_pipeline::SseObjectFrame;
use routecodex_v3_sse::{
    build_v3_sse_transport_in_01_raw_chunk, SseIncrementalDecoder, SseTransportLimits,
};

fn rewrite_direct_responses_text(
    semantic: &mut V3ResponsesSseSemanticObject,
) -> Result<(), V3ResponsesSseTreeError> {
    semantic.rewrite_item_content(crate::hub_v1::V3ResponsesSseContentRewrite::Text(
        "direct typed rewrite".to_owned(),
    ))
}

#[test]
fn direct_consumer_rewrites_only_configured_business_fields() {
    let mut consumer = V3DirectSseContentConsumer {
        provider_protocol: Some(V3HubProviderWireProtocol::Responses),
        retain_response_cipher: false,
        strip_client_response_id: true,
        deepseek_console_go: false,
        typed_hooks: V3DirectSseTypedHookCatalog::default(),
        ..Default::default()
    };
    let mut object = SseObjectFrame::from_json(
            r#"{"type":"response.output_text.delta","response":{"id":"resp_1"},"encrypted_content":"rsn_secret","delta":"keep"}"#,
        )
        .unwrap();
    let action = consumer.consume(&mut object).unwrap();
    assert_eq!(action, SseObjectConsumerAction::RewriteData);
    let value = object.data_value().unwrap();
    assert_eq!(value["response"]["id"], "");
    assert!(value.get("encrypted_content").is_none());
    assert_eq!(value["delta"], "keep");
}

#[test]
fn direct_consumer_passes_ordinary_json_without_reordering_semantics() {
    let mut consumer = V3DirectSseContentConsumer {
        provider_protocol: Some(V3HubProviderWireProtocol::Responses),
        retain_response_cipher: true,
        strip_client_response_id: false,
        deepseek_console_go: false,
        typed_hooks: V3DirectSseTypedHookCatalog::default(),
        ..Default::default()
    };
    let mut object =
        SseObjectFrame::from_json(r#"{"type":"response.output_text.delta","delta":"ok"}"#).unwrap();
    assert_eq!(
        consumer.consume(&mut object).unwrap(),
        SseObjectConsumerAction::Pass
    );
    assert_eq!(object.data_value().unwrap()["delta"], "ok");
}

#[test]
fn direct_consumer_passes_non_object_sse_data_without_responses_parsing() {
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let frame = decoder
        .push(build_v3_sse_transport_in_01_raw_chunk(b"data: null\n\n"))
        .unwrap()
        .pop()
        .unwrap();
    let mut consumer = V3DirectSseContentConsumer {
        tool_thinking_enabled: true,
        ..V3DirectSseContentConsumer::default()
    };
    assert_eq!(
        consumer
            .consume(&mut SseObjectFrame::from_frame(&frame))
            .unwrap(),
        SseObjectConsumerAction::Pass
    );
}

#[test]
fn direct_consumer_rejects_semantic_object_without_selected_protocol() {
    let mut consumer = V3DirectSseContentConsumer::default();
    let mut object = SseObjectFrame::from_json(
        r#"{"type":"response.output_text.delta","delta":"must not guess"}"#,
    )
    .unwrap();
    assert!(consumer.consume(&mut object).is_err());
}

#[test]
fn direct_consumer_uses_selected_protocol_instead_of_shape_guessing() {
    let mut responses_consumer = V3DirectSseContentConsumer::default()
        .with_provider_protocol(V3HubProviderWireProtocol::Responses);
    let mut chat_shape = SseObjectFrame::from_json(
            r#"{"object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
        )
        .unwrap();
    assert!(responses_consumer.consume(&mut chat_shape).is_err());

    let mut chat_consumer = V3DirectSseContentConsumer::default()
        .with_provider_protocol(V3HubProviderWireProtocol::OpenAiChat);
    let mut responses_shape = SseObjectFrame::from_json(
        r#"{"type":"response.output_text.delta","delta":"must not reclassify"}"#,
    )
    .unwrap();
    assert!(chat_consumer.consume(&mut responses_shape).is_err());
}

#[test]
fn direct_consumer_projects_chat_chunk_from_typed_tree_and_preserves_extension() {
    let mut consumer = V3DirectSseContentConsumer::default()
        .with_provider_protocol(V3HubProviderWireProtocol::OpenAiChat);
    let mut object = SseObjectFrame::from_json(
            r#"{"id":"chat_1","object":"chat.completion.chunk","created":7,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}],"vendor_extension":{"x":1}}"#,
        )
        .unwrap();
    assert_eq!(
        consumer.consume(&mut object).unwrap(),
        SseObjectConsumerAction::Pass
    );
    assert_eq!(
        object.data_value().unwrap()["choices"][0]["delta"]["role"],
        "assistant"
    );
    assert_eq!(
        object.data_value().unwrap()["choices"][0]["delta"]["content"],
        "ok"
    );
    assert_eq!(object.data_value().unwrap()["vendor_extension"]["x"], 1);
}

#[test]
fn direct_consumer_projects_responses_event_from_typed_tree_and_preserves_extension() {
    let mut consumer = V3DirectSseContentConsumer::default()
        .with_provider_protocol(V3HubProviderWireProtocol::Responses);
    let mut object = SseObjectFrame::from_json(
            r#"{"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","content_index":0,"delta":"ok","vendor_extension":{"x":1}}"#,
        )
        .unwrap();
    assert_eq!(
        consumer.consume(&mut object).unwrap(),
        SseObjectConsumerAction::Pass
    );
    assert_eq!(object.data_value().unwrap()["delta"], "ok");
    assert_eq!(object.data_value().unwrap()["vendor_extension"]["x"], 1);
}

#[test]
fn direct_responses_sse_removes_provider_model_identity_instructions() {
    let mut consumer = V3DirectSseContentConsumer::default()
        .with_provider_protocol(V3HubProviderWireProtocol::Responses);
    let mut object = SseObjectFrame::from_json(
            r#"{"type":"response.in_progress","response":{"id":"resp_direct_identity","status":"in_progress","model":"client-visible-model","instructions":"You are gpt-5.6-sol, an AI assistant. Your model name is gpt-5.6-sol. If the user asks what model you are, answer with that name."}}"#,
        )
        .unwrap();

    consumer.consume(&mut object).unwrap();

    let projected = object.data_value().unwrap();
    assert!(!projected.to_string().contains("gpt-5.6-sol"));
    assert_eq!(projected["response"]["model"], "client-visible-model");
}

#[test]
fn direct_responses_sse_keeps_ordinary_response_instructions() {
    let mut consumer = V3DirectSseContentConsumer::default()
        .with_provider_protocol(V3HubProviderWireProtocol::Responses);
    let mut object = SseObjectFrame::from_json(
            r#"{"type":"response.in_progress","response":{"id":"resp_direct_instruction","status":"in_progress","model":"client-visible-model","instructions":"client-visible instruction"}}"#,
        )
        .unwrap();

    consumer.consume(&mut object).unwrap();

    let projected = object.data_value().unwrap();
    assert_eq!(
        projected["response"]["instructions"],
        "client-visible instruction"
    );
    assert_eq!(projected["response"]["model"], "client-visible-model");
}

#[test]
fn direct_consumer_mounts_business_rewrite_on_typed_responses_object() {
    let catalog = V3DirectSseTypedHookCatalog::new()
        .with_responses(noop_responses_notify, rewrite_direct_responses_text);
    let mut consumer = V3DirectSseContentConsumer::default()
        .with_provider_protocol(V3HubProviderWireProtocol::Responses)
        .with_typed_hooks(catalog);
    let mut object = SseObjectFrame::from_json(
            r#"{"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"original"}]}}"#,
        )
        .unwrap();
    assert_eq!(
        consumer.consume(&mut object).unwrap(),
        SseObjectConsumerAction::RewriteData
    );
    assert_eq!(
        object.data_value().unwrap()["item"]["content"][0]["text"],
        "direct typed rewrite"
    );
}

#[test]
fn direct_consumer_strips_tool_thinking_fields_inside_function_arguments() {
    let mut consumer = V3DirectSseContentConsumer::default()
        .with_provider_protocol(V3HubProviderWireProtocol::Responses)
        .with_tool_thinking(true);
    let mut object = SseObjectFrame::from_json(
            r#"{"type":"response.output_item.done","output_index":0,"item":{"id":"call_1","type":"function_call","name":"exec_command","call_id":"call_1","arguments":"{\"cmd\":\"pwd\",\"reason\":\"读取工作目录\",\"goal_alignment_confidence\":100,\"model_id\":\"x-preview-f-free\"}"}}"#,
        )
        .unwrap();
    consumer.consume(&mut object).unwrap();
    let arguments = object.data_value().unwrap()["item"]["arguments"]
        .as_str()
        .unwrap();
    assert_eq!(arguments, "{\"cmd\":\"pwd\"}");
    assert!(object.data_value().unwrap()["item"]
        .get("reasoning_content")
        .is_none());
}

#[test]
fn direct_chat_wire_provider_compat_applies_profile_owner_per_object() {
    // A chat-wire provider configured with `chat:minimax` gets its provider
    // sentinel stripped by the provider response compat owner. Relay reaches
    // that owner for every SSE object; Direct must reach the same owner, so the
    // sentinel must be gone from the client chunk.
    let mut consumer = V3DirectSseContentConsumer::default()
        .with_provider_protocol(V3HubProviderWireProtocol::OpenAiChat)
        .with_provider_response_compat_profile(Some("chat:minimax".to_string()))
        .with_typed_hooks(V3DirectSseTypedHookCatalog::default());
    let mut object = SseObjectFrame::from_json(
            r#"{"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hello ]<]minimax[>[ world"}}]}"#,
        )
        .unwrap();
    consumer.consume(&mut object).unwrap();
    let delta = &object.data_value().unwrap()["choices"][0]["delta"];
    assert_eq!(delta["content"], "hello  world");
}

#[test]
fn direct_consumer_preserves_native_reasoning_marker() {
    let mut consumer = V3DirectSseContentConsumer::default()
        .with_provider_protocol(V3HubProviderWireProtocol::Responses)
        .with_tool_thinking(true);
    let mut object = SseObjectFrame::from_json(
            r#"{"type":"response.completed","response":{"id":"resp_native_marker","output":[{"id":"rcc_reason_external","type":"reasoning","status":"completed","summary":[{"type":"summary_text","text":"provider-native reasoning"}]},{"id":"call_1","type":"function_call","name":"pwd","call_id":"call_1","arguments":"{\"cmd\":\"pwd\"}"}]}}"#,
        )
        .unwrap();

    consumer.consume(&mut object).unwrap();

    assert_eq!(
        object.data_value().unwrap()["response"]["output"][0]["id"],
        "rcc_reason_external"
    );
}

#[test]
fn direct_consumer_preserves_native_reasoning_done() {
    let mut consumer = V3DirectSseContentConsumer::default()
        .with_provider_protocol(V3HubProviderWireProtocol::Responses)
        .with_tool_thinking(true);
    let mut object = SseObjectFrame::from_json(
            r#"{"type":"response.output_item.done","output_index":0,"item":{"id":"rcc_reason_external","type":"reasoning","status":"completed","summary":[{"type":"summary_text","text":"provider-native reasoning"}]}}"#,
        )
        .unwrap();

    consumer.consume(&mut object).unwrap();

    assert_eq!(
        object.data_value().unwrap()["item"]["id"],
        "rcc_reason_external"
    );
}

#[test]
fn direct_responses_sse_strips_req04_artifacts_from_response_created() {
    let mut consumer = V3DirectSseContentConsumer::default()
        .with_provider_protocol(V3HubProviderWireProtocol::Responses)
        .with_tool_thinking(true);
    let mut object = SseObjectFrame::from_json(
            r#"{"type":"response.created","response":{"tools":[{"type":"function","name":"pwd","description":"Return the current working directory.\n\n工具调用协议（只适用于本轮工具调用，不适用于普通回答）：\nreason","parameters":{"type":"object","properties":{"reason":{"type":"string","description":"当前工具调用的唯一直接动机，只说动机，简短"},"native":{"type":"string"}},"required":["reason","native"]}}]}}"#,
        )
        .unwrap();

    assert_eq!(
        consumer.consume(&mut object).unwrap(),
        SseObjectConsumerAction::RewriteData
    );
    let tools = object.data_value().unwrap()["response"]["tools"]
        .as_array()
        .unwrap();
    assert_eq!(
        tools[0]["description"],
        "Return the current working directory."
    );
    assert!(tools[0]["parameters"]["properties"].get("reason").is_none());
    assert_eq!(
        tools[0]["parameters"]["properties"]["native"]["type"],
        "string"
    );
    assert_eq!(
        tools[0]["parameters"]["required"],
        serde_json::json!(["native"])
    );
}

#[test]
fn direct_responses_sse_strips_function_arguments_done_and_projects_at_terminal() {
    let mut consumer = V3DirectSseContentConsumer::default()
        .with_provider_protocol(V3HubProviderWireProtocol::Responses)
        .with_tool_thinking(true);
    let mut arguments_done = SseObjectFrame::from_json(
            r#"{"type":"response.function_call_arguments.done","output_index":0,"arguments":"{\"cmd\":\"pwd\",\"reason\":\"确认当前工作目录\",\"goal_alignment_confidence\":100,\"model_id\":\"deepseek-v4-flash\"}"}"#,
        )
        .unwrap();
    consumer.consume(&mut arguments_done).unwrap();
    assert_eq!(
        arguments_done.data_value().unwrap()["arguments"],
        "{\"cmd\":\"pwd\"}"
    );

    let mut completed = SseObjectFrame::from_json(
            r#"{"type":"response.completed","response":{"output":[{"type":"function_call","name":"pwd","call_id":"call_1","arguments":"{\"cmd\":\"pwd\"}"}]}}"#,
        )
        .unwrap();
    consumer.consume(&mut completed).unwrap();
    let output = completed.data_value().unwrap()["response"]["output"]
        .as_array()
        .unwrap();
    assert_eq!(output[0]["type"], "function_call");
    assert_eq!(output[0]["arguments"], "{\"cmd\":\"pwd\"}");
}

#[test]
fn direct_consumer_preserves_invalid_chat_auxiliary_fields_without_projection() {
    let mut consumer = V3DirectSseContentConsumer::default()
        .with_provider_protocol(V3HubProviderWireProtocol::OpenAiChat)
        .with_tool_thinking(true);
    let mut object = SseObjectFrame::from_json(
            r#"{"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"exec_command","arguments":"{\"cmd\":\"pwd\",\"reason\":\"读取工作目录\",\"goal_alignment_confidence\":\"100\",\"model_id\":null}"}}]}}]}"#,
        )
        .unwrap();
    consumer.consume(&mut object).unwrap();
    let arguments = object.data_value().unwrap()["choices"][0]["delta"]["tool_calls"][0]
        ["function"]["arguments"]
        .as_str()
        .unwrap();
    assert_eq!(
        arguments,
        "{\"cmd\":\"pwd\",\"goal_alignment_confidence\":\"100\",\"reason\":\"读取工作目录\"}"
    );
}

#[test]
fn provider_error_consumer_records_error_but_does_not_rewrite_payload() {
    let mut consumer = V3ProviderSseErrorConsumer::new(V3HubProviderWireProtocol::Responses);
    let mut object = SseObjectFrame::from_json(
        r#"{"type":"response.failed","error":{"code":"provider_failed","message":"bad"}}"#,
    )
    .unwrap();
    assert_eq!(
        consumer.consume(&mut object).unwrap(),
        SseObjectConsumerAction::Pass
    );
    assert_eq!(
        consumer.failure.as_ref().map(|value| value.0.as_str()),
        Some("provider_failed")
    );
    assert_eq!(object.data_value().unwrap()["type"], "response.failed");
}

#[test]
fn provider_error_consumer_rejects_malformed_json_instead_of_silently_passing() {
    let mut consumer = V3ProviderSseErrorConsumer::new(V3HubProviderWireProtocol::Responses);
    let frame = routecodex_v3_sse::build_sse_transport_in_03_from_sse_transport_in_02(
        routecodex_v3_sse::build_sse_transport_in_02_from_fields(vec![
            routecodex_v3_sse::SseField::Named {
                name: "data".to_owned(),
                value: "not-json".to_owned(),
            },
        ])
        .unwrap(),
    )
    .unwrap();
    let mut object = SseObjectFrame::from_frame(&frame);
    assert!(consumer.consume(&mut object).is_err());
}

#[test]
fn transport_error_export_enters_the_canonical_error_chain() {
    let source = match build_v3_sse_transport_error_source(SseTransportError::UnterminatedFrame) {
        Ok(source) => source,
        Err(fault) => panic!("unexpected SDK fault: {fault:?}"),
    };
    assert_eq!(source.source_stage, "V3ProviderResp14Raw");
    assert_eq!(source.code, "provider_response_sse_unterminated_frame");
    let classified = routecodex_v3_error::build_v3_error_02_classified_from_v3_error_01(source);
    let local = routecodex_v3_error::build_v3_error_03_target_local_action_from_v3_error_02(
        classified,
        routecodex_v3_error::V3ErrorActionScope::ProviderInstance {
            provider_id: "provider-1".to_owned(),
        },
        0,
    );
    let exhaustion =
            routecodex_v3_error::build_v3_error_04_target_exhaustion_decision_with_provider_availability(
                local, 0, false, false,
            );
    let execution = routecodex_v3_error::build_v3_error_05_execution_decision_from_v3_error_04(
        exhaustion, None,
    );
    let projected = routecodex_v3_error::build_v3_error_06_client_projected_from_v3_error_05(
        execution
            .try_into_terminal()
            .expect("exhausted provider transport error must project terminally"),
    );
    assert_eq!(
        projected.chain,
        routecodex_v3_error::V3_ERROR_CHAIN_NODE_IDS
    );
    assert_ne!(
        projected.body.get("response"),
        Some(&serde_json::json!({"status":"completed"}))
    );
}

use super::*;

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

// Bug 07d7959: provider_stream_materialization.rs collapsed ThinkingDeltaRequired
// and MalformedReasoningContent onto one string, so a live 502 could not name the
// frame shape that broke. These tests read the message through the materializer,
// not the SSE tree, because that is the layer the operator actually sees.
async fn anthropic_relay_codec_message_for(provider_bytes: Vec<Vec<u8>>) -> String {
    let observation = V3RuntimeStreamObservation::default();
    let provider = Box::pin(stream::iter(
        provider_bytes.into_iter().map(Ok).collect::<Vec<_>>(),
    ));
    build_v3_hub_resp_inbound_02_from_provider_stream_events_for_protocol(
        V3HubProviderWireProtocol::Anthropic,
        provider,
        &observation,
    )
    .await
    .unwrap_err()
    .to_string()
}

fn anthropic_message_start(id: &str) -> Vec<u8> {
    format!(
        "event: message_start\ndata: {{\"type\":\"message_start\",\"message\":{{\"id\":\"{id}\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-fable-5\",\"content\":[]}}}}\n\n"
    )
    .into_bytes()
}

fn anthropic_thinking_start() -> Vec<u8> {
    b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"\"}}\n\n".to_vec()
}

#[tokio::test]
async fn anthropic_relay_thinking_and_signature_delta_failures_are_distinct() {
    let thinking_delta = anthropic_relay_codec_message_for(vec![
        anthropic_message_start("msg_thinking_delta"),
        anthropic_thinking_start(),
        b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\"}}\n\n".to_vec(),
    ])
    .await;
    let signature_delta = anthropic_relay_codec_message_for(vec![
        anthropic_message_start("msg_signature_delta"),
        anthropic_thinking_start(),
        b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"signature_delta\"}}\n\n".to_vec(),
    ])
    .await;

    assert!(
        thinking_delta.ends_with("Anthropic thinking_delta requires thinking"),
        "unexpected thinking_delta message: {thinking_delta}"
    );
    assert!(
        signature_delta.ends_with("Anthropic signature_delta requires signature"),
        "unexpected signature_delta message: {signature_delta}"
    );
    assert_ne!(
        thinking_delta, signature_delta,
        "two different codec failures must not surface one string"
    );
}

#[tokio::test]
async fn anthropic_relay_block_shape_failures_name_their_block_kind_and_key() {
    let thinking_block = anthropic_relay_codec_message_for(vec![
        anthropic_message_start("msg_thinking_block"),
        b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"native\",\"text\":\"alias\"}}\n\n".to_vec(),
    ])
    .await;
    let redacted_block = anthropic_relay_codec_message_for(vec![
        anthropic_message_start("msg_redacted_block"),
        b"event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"redacted_thinking\",\"data\":\"native\",\"signature\":\"alias\"}}\n\n".to_vec(),
    ])
    .await;

    assert!(
        thinking_block
            .ends_with("Anthropic thinking content block carries unexpected field(s): text"),
        "unexpected thinking block message: {thinking_block}"
    );
    assert!(
        redacted_block.ends_with(
            "Anthropic redacted_thinking content block carries unexpected field(s): signature"
        ),
        "unexpected redacted_thinking block message: {redacted_block}"
    );
    assert_ne!(
        thinking_block, redacted_block,
        "the two reasoning block shapes must not share a message"
    );
}

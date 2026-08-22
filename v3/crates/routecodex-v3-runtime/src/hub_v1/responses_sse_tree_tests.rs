use super::*;
use serde_json::json;

struct RewriteResponsesHook {
    notified: bool,
}

impl V3ResponsesSseSemanticHook for RewriteResponsesHook {
    fn notify(&mut self, input: &V3ResponsesSseHookInput<'_>) {
        self.notified = input.protocol.event_type == "response.output_item.done";
    }

    fn rewrite(
        &mut self,
        semantic: &mut V3ResponsesSseSemanticObject,
    ) -> Result<(), V3ResponsesSseTreeError> {
        semantic.rewrite_item_content(V3ResponsesSseContentRewrite::Text("hooked".to_owned()))
    }
}

#[test]
fn responses_item_classifier_keeps_message_reasoning_and_function_call_distinct() {
    assert_eq!(
        classify_v3_responses_sse_output_item(&json!({"type":"message","id":"msg_1"}))
            .unwrap()
            .kind(),
        V3ResponsesSseOutputItemKind::Message
    );
    assert_eq!(
        classify_v3_responses_sse_output_item(&json!({"type":"reasoning","id":"rs_1"}))
            .unwrap()
            .kind(),
        V3ResponsesSseOutputItemKind::Reasoning
    );
    assert_eq!(
        classify_v3_responses_sse_output_item(
            &json!({"type":"function_call","id":"fc_1","call_id":"call_1"})
        )
        .unwrap()
        .kind(),
        V3ResponsesSseOutputItemKind::FunctionCall
    );
}

#[test]
fn responses_registered_item_types_each_have_typed_round_trip() {
    let cases = [
        ("message", V3ResponsesSseOutputItemKind::Message),
        ("reasoning", V3ResponsesSseOutputItemKind::Reasoning),
        ("function_call", V3ResponsesSseOutputItemKind::FunctionCall),
        (
            "custom_tool_call",
            V3ResponsesSseOutputItemKind::CustomToolCall,
        ),
        (
            "function_call_output",
            V3ResponsesSseOutputItemKind::FunctionCallOutput,
        ),
        ("web_search_call", V3ResponsesSseOutputItemKind::WebSearchCall),
        ("file_search_call", V3ResponsesSseOutputItemKind::FileSearchCall),
        (
            "code_interpreter_call",
            V3ResponsesSseOutputItemKind::CodeInterpreterCall,
        ),
        ("computer_call", V3ResponsesSseOutputItemKind::ComputerCall),
        ("mcp_call", V3ResponsesSseOutputItemKind::McpCall),
        ("mcp_list_tools", V3ResponsesSseOutputItemKind::McpListTools),
        (
            "mcp_approval_request",
            V3ResponsesSseOutputItemKind::McpApprovalRequest,
        ),
        ("tool_search_call", V3ResponsesSseOutputItemKind::ToolSearchCall),
        (
            "apply_patch_call",
            V3ResponsesSseOutputItemKind::ApplyPatchCall,
        ),
    ];
    for (item_type, expected_kind) in cases {
        let input = json!({
            "type": item_type,
            "id": format!("{item_type}_1"),
            "output_index": 2,
            "provider_extension": {"keep": true}
        });
        let item = classify_v3_responses_sse_output_item(&input).unwrap();
        assert_eq!(item.kind(), expected_kind, "item type {item_type}");
        assert_eq!(item.to_normalized_value(), input, "item type {item_type}");
    }
}

#[test]
fn responses_item_classifier_rejects_unknown_item_type() {
    let error = classify_v3_responses_sse_output_item(&json!({
        "type":"future_item",
        "id":"item_1"
    }))
    .unwrap_err();
    assert!(error
        .to_string()
        .contains("unsupported Responses output item type"));
}

#[test]
fn responses_json_document_uses_typed_items_and_round_trips_without_raw_json() {
    let input = json!({
        "object": "response",
        "id": "resp_1",
        "status": "completed",
        "model": "gpt-test",
        "output": [
            {
                "type": "message",
                "id": "msg_1",
                "content": [{"type": "output_text", "text": "hello"}]
            },
            {"type": "function_call", "id": "fc_1", "call_id": "call_1"}
        ],
        "provider_extension": {"keep": true}
    });

    let document = V3ResponsesJsonDocument::from_json(&input).unwrap();
    assert_eq!(document.items.len(), 2);
    assert_eq!(
        document.items[0].item().kind(),
        V3ResponsesSseOutputItemKind::Message
    );
    assert_eq!(
        document.items[1].item().kind(),
        V3ResponsesSseOutputItemKind::FunctionCall
    );
    assert_eq!(document.to_normalized_value(), input);
    assert_eq!(
        V3ResponsesJsonDocument::from_json(&document.to_normalized_value()).unwrap(),
        document
    );
}

#[test]
fn responses_json_document_rejects_non_array_output_and_unknown_items() {
    let output_error = V3ResponsesJsonDocument::from_json(&json!({
        "object": "response",
        "output": {}
    }))
    .unwrap_err();
    assert_eq!(output_error, V3ResponsesSseTreeError::OutputNotArray);

    let item_error = V3ResponsesJsonDocument::from_json(&json!({
        "object": "response",
        "output": [{"type": "future_item"}]
    }))
    .unwrap_err();
    assert!(item_error
        .to_string()
        .contains("unsupported Responses output item type"));
}

#[test]
fn responses_json_document_keeps_legacy_output_text_as_explicit_typed_compatibility_node() {
    let input = json!({
        "object": "response",
        "status": "completed",
        "output": [{"type": "output_text", "text": "legacy visible"}]
    });
    let document = V3ResponsesJsonDocument::from_json(&input).unwrap();
    assert_eq!(
        document.items[0].item().kind(),
        V3ResponsesSseOutputItemKind::OutputText
    );
    assert_eq!(document.to_normalized_value(), input);
}

#[test]
fn responses_content_rewrite_cannot_change_identity_or_item_type() {
    let item = classify_v3_responses_sse_output_item(&json!({
        "type":"message",
        "id":"msg_1",
        "status":"in_progress"
    }))
    .unwrap();
    let rewritten = rewrite_v3_responses_sse_content(
        item,
        V3ResponsesSseContentRewrite::Text("rewritten".to_string()),
    )
    .unwrap();
    assert_eq!(rewritten.kind(), V3ResponsesSseOutputItemKind::Message);
    assert_eq!(rewritten.identity().item_id.as_deref(), Some("msg_1"));
    assert_eq!(rewritten.rewritten_content(), Some("rewritten"));
}

#[test]
fn responses_item_round_trip_rebuilds_from_normalized_tree() {
    let input = json!({
        "type":"message",
        "id":"msg_1",
        "status":"completed",
        "provider_extension":{"keep":true},
        "content":[{"type":"output_text","text":"before"}]
    });
    let item = classify_v3_responses_sse_output_item(&input).unwrap();
    assert_eq!(item.to_normalized_value(), input);

    let rewritten = rewrite_v3_responses_sse_content(
        item,
        V3ResponsesSseContentRewrite::Text("after".to_owned()),
    )
    .unwrap();
    let output = rewritten.to_normalized_value();
    assert_eq!(output["id"], "msg_1");
    assert_eq!(output["provider_extension"]["keep"], true);
    assert_eq!(output["content"][0]["text"], "after");
}

#[test]
fn responses_protocol_metadata_stays_separate_from_business_metadata() {
    let metadata = V3ResponsesSseProtocolMetadata::from_event(&json!({
        "type":"response.output_text.delta",
        "response_id":"resp_1",
        "item_id":"msg_1",
        "output_index":0,
        "content_index":0,
        "sequence_number":4
    }))
    .unwrap();
    assert_eq!(metadata.response_id.as_deref(), Some("resp_1"));
    assert_eq!(metadata.item_id.as_deref(), Some("msg_1"));
    assert_eq!(metadata.sequence_number, Some(4));
    assert!(!metadata.contains_business_metadata_field("metadata"));
}

#[test]
fn responses_normalized_item_projects_to_json_and_sse() {
    let input = json!({
        "type":"message",
        "id":"msg_1",
        "content":[{"type":"output_text","text":"hello"}],
        "provider_extension":{"keep":true}
    });
    let item = classify_v3_responses_sse_output_item(&input).unwrap();
    assert_eq!(project_v3_responses_sse_item_json(&item), input);
    let bytes =
        project_v3_responses_sse_item_sse(Some("response.output_item.done".to_owned()), &item)
            .unwrap();
    let mut decoder = routecodex_v3_sse::SseIncrementalDecoder::new(
        routecodex_v3_sse::SseTransportLimits::default(),
    );
    let frame = decoder
        .push(routecodex_v3_sse::build_v3_sse_transport_in_01_raw_chunk(
            &bytes,
        ))
        .unwrap()
        .pop()
        .unwrap();
    let object = crate::sse_object_pipeline::SseObjectFrame::from_frame(&frame);
    assert_eq!(object.event_name(), Some("response.output_item.done"));
    assert_eq!(object.data_value(), Some(&input));
}

#[test]
fn responses_semantic_event_projection_preserves_event_envelope() {
    let input = json!({
        "type":"response.output_text.delta",
        "response_id":"resp_1",
        "item_id":"msg_1",
        "output_index":0,
        "content_index":0,
        "sequence_number":4,
        "delta":"hello",
        "provider_extension":{"keep":true}
    });
    let semantic = classify_v3_responses_sse_event(&input).unwrap();
    assert_eq!(semantic.item, None);
    assert_eq!(
        semantic.content,
        Some(V3ResponsesSseContentKind::OutputText)
    );
    assert_eq!(project_v3_responses_sse_event_json(&semantic), input);
    let bytes = project_v3_responses_sse_event_sse(
        Some("response.output_text.delta".to_owned()),
        &semantic,
    )
    .unwrap();
    let mut decoder = routecodex_v3_sse::SseIncrementalDecoder::new(
        routecodex_v3_sse::SseTransportLimits::default(),
    );
    let frame = decoder
        .push(routecodex_v3_sse::build_v3_sse_transport_in_01_raw_chunk(
            &bytes,
        ))
        .unwrap()
        .pop()
        .unwrap();
    let object = crate::sse_object_pipeline::SseObjectFrame::from_frame(&frame);
    assert_eq!(object.event_name(), Some("response.output_text.delta"));
    assert_eq!(object.data_value(), Some(&input));
}

#[test]
fn responses_created_accepts_nullable_envelope_fields() {
    let input = json!({
        "type":"response.created",
        "item":null,
        "response":{
            "id":"resp_1",
            "status":"requires_action",
            "output":null,
            "usage":null,
            "error":null
        }
    });
    let semantic = classify_v3_responses_sse_event(&input)
        .expect("nullable Responses envelope fields are valid protocol data");
    assert_eq!(semantic.protocol.event_type, "response.created");
    assert_eq!(
        semantic.response.as_ref().and_then(|value| value.id.as_deref()),
        Some("resp_1")
    );
}

#[test]
fn responses_semantic_hook_notifies_and_rewrites_typed_item() {
    let input = json!({
        "type":"response.output_item.done",
        "item":{"type":"message","id":"msg_1","content":[{"type":"output_text","text":"before"}]}
    });
    let mut semantic = classify_v3_responses_sse_event(&input).unwrap();
    let transport = V3ResponsesSseTransportObject::new(None, input.clone());
    let protocol = V3ResponsesSseProtocolMetadata::from_event(&input).unwrap();
    let mut hook = RewriteResponsesHook { notified: false };
    apply_v3_responses_sse_semantic_hook(&mut semantic, &transport, &protocol, &mut hook).unwrap();
    assert!(hook.notified);
    assert_eq!(
        semantic.to_normalized_value()["item"]["content"][0]["text"],
        "hooked"
    );
}

#[test]
fn responses_reducer_keeps_container_item_and_terminal_layers_typed() {
    let mut reducer = V3ResponsesSseReducerState::default();
    reducer
        .apply_event(&json!({
            "type":"response.created",
            "response":{
                "id":"resp_1",
                "status":"in_progress",
                "model":"model-a",
                "usage":{"input_tokens":1,"provider_extension":{"keep":true}},
                "provider_extension":{"keep":true}
            }
        }))
        .unwrap();
    reducer
        .apply_event(&json!({
            "type":"response.output_item.added",
            "item":{"type":"function_call","id":"item_1","call_id":"call_1","arguments":"{}"}
        }))
        .unwrap();
    reducer
        .apply_event(&json!({"type":"response.completed","sequence_number":9}))
        .unwrap();
    assert_eq!(
        reducer
            .response
            .as_ref()
            .and_then(|value| value.id.as_deref()),
        Some("resp_1")
    );
    assert!(matches!(
        reducer.items.first(),
        Some(V3ResponsesSseTypedOutputItem::FunctionCall(item))
            if item.kind() == V3ResponsesSseOutputItemKind::FunctionCall
    ));
    assert_eq!(
        reducer.terminal,
        Some(V3ResponsesSseTerminalState::Completed)
    );
    assert_eq!(reducer.sequence_number, Some(9));
    assert_eq!(
        reducer.response.as_ref().unwrap().extensions[0].name,
        "provider_extension"
    );
}

#[test]
fn responses_reducer_rejects_output_item_event_without_item() {
    let error = V3ResponsesSseReducerState::default()
        .apply_event(&json!({"type":"response.output_item.done"}))
        .unwrap_err();
    assert_eq!(error, V3ResponsesSseTreeError::MissingOutputItem);
}

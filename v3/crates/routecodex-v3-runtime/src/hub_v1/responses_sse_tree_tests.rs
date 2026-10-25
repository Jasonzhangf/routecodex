use super::*;
use serde_json::json;

#[test]
fn responses_tool_values_remain_lossless_in_items_and_done_events() {
    let values = [
        json!({"q":" exact \n","nested":[1,2]}),
        json!([1,{"keep":true}]),
        json!(null),
        json!(true),
        json!(7),
        json!("{\"q\":\"exact\"}"),
        json!("{\"q\":"),
        json!(""),
    ];
    for kind in ["function_call", "custom_tool_call"] {
        let field = if kind == "function_call" {
            "arguments"
        } else {
            "input"
        };
        let event_type = if kind == "function_call" {
            "response.function_call_arguments.done"
        } else {
            "response.custom_tool_call_input.done"
        };
        for value in &values {
            let mut original =
                json!({"type":kind,"id":"item_original","call_id":"call_original","name":"lookup"});
            original[field] = value.clone();
            assert_eq!(
                classify_v3_responses_sse_output_item(&original)
                    .unwrap()
                    .to_normalized_value(),
                original
            );
            original["output_index"] = json!(0);
            let mut reducer = V3ResponsesSseReducerState::default();
            reducer.apply_event(&json!({"type":"response.output_item.added","output_index":0,"item":{"type":kind,"id":"item_original","call_id":"call_original","name":"lookup"}})).unwrap();
            let mut done = json!({"type":event_type,"item_id":"item_original","output_index":0});
            done[field] = value.clone();
            reducer.apply_event(&done).unwrap();
            assert_eq!(reducer.items[0].item().to_normalized_value(), original);
            let delta_type = if kind == "function_call" {
                "response.function_call_arguments.delta"
            } else {
                "response.custom_tool_call_input.delta"
            };
            reducer.apply_event(&json!({"type":delta_type,"item_id":"item_original","output_index":0,"delta":" retained tail"})).unwrap();
            let prefix = value
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| value.to_string());
            assert_eq!(
                reducer.items[0].item().to_normalized_value()[field],
                format!("{prefix} retained tail")
            );
            reducer.apply_event(&done).unwrap();
            assert_eq!(reducer.items[0].item().to_normalized_value(), original);
        }
        let absent =
            json!({"type":kind,"id":"item_original","call_id":"call_original","name":"lookup"});
        assert_eq!(
            classify_v3_responses_sse_output_item(&absent)
                .unwrap()
                .to_normalized_value(),
            absent
        );
    }
}

struct RewriteResponsesHook {
    notified: bool,
}

impl V3ResponsesSseSemanticHook for RewriteResponsesHook {
    fn notify(&mut self, input: &V3ResponsesSseHookInput<'_>) -> Result<(), String> {
        self.notified = input.protocol.event_type == "response.output_item.done";
        Ok(())
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
        (
            "web_search_call",
            V3ResponsesSseOutputItemKind::WebSearchCall,
        ),
        (
            "file_search_call",
            V3ResponsesSseOutputItemKind::FileSearchCall,
        ),
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
        (
            "tool_search_call",
            V3ResponsesSseOutputItemKind::ToolSearchCall,
        ),
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
        semantic
            .response
            .as_ref()
            .and_then(|value| value.id.as_deref()),
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

/// Ordered fingerprint of reasoning `content` texts. Uses the std hasher so the
/// assertion needs no new dependency; exact `Value` equality is asserted too.
fn reasoning_content_fingerprint(texts: &[&str]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    texts.hash(&mut hasher);
    hasher.finish()
}

fn normalized_reasoning_output_item(reasoning: &serde_json::Value) -> serde_json::Value {
    let document = json!({
        "object": "response",
        "id": "resp_openai_chat_relay",
        "status": "completed",
        "output": [reasoning.clone()]
    });
    let normalized = V3ResponsesJsonDocument::from_json(&document)
        .expect("builder-produced Responses document must normalize")
        .to_normalized_value();
    normalized["output"][0].clone()
}

#[test]
fn responses_builder_reasoning_content_survives_typed_json_normalization() {
    // Exact item shape emitted by the Chat->Responses reasoning builder
    // (`responses_openai_chat_conversion.rs`,
    // `build_v3_responses_reasoning_item_from_openai_chat_message`) for a preserved
    // lifeai Chat response: `summary` and `content` carry the same reasoning text so
    // the client can echo `content` on the next turn. `run_json_response_hooks`
    // normalizes this document through `V3ResponsesJsonDocument`, so the typed tree
    // must keep `content`; the current tree excludes it and drops it.
    let builder_reasoning = json!({
        "type": "reasoning",
        "summary": [
            {"type": "summary_text", "text": "first reasoning part"},
            {"type": "summary_text", "text": "second reasoning part"}
        ],
        "content": [
            {"type": "reasoning_text", "text": "first reasoning part"},
            {"type": "reasoning_text", "text": "second reasoning part"}
        ]
    });

    let item = normalized_reasoning_output_item(&builder_reasoning);
    assert_eq!(item["type"], "reasoning");
    assert_eq!(item["summary"], builder_reasoning["summary"]);
    assert_eq!(
        item["content"], builder_reasoning["content"],
        "typed JSON normalization must preserve reasoning.content emitted by the Chat->Responses builder"
    );

    let normalized_texts: Vec<&str> = item["content"]
        .as_array()
        .expect("normalized reasoning item must keep its content array")
        .iter()
        .map(|entry| entry["text"].as_str().unwrap())
        .collect();
    assert_eq!(
        normalized_texts,
        vec!["first reasoning part", "second reasoning part"]
    );
    assert_eq!(
        reasoning_content_fingerprint(&normalized_texts),
        reasoning_content_fingerprint(&["first reasoning part", "second reasoning part"])
    );
    // `content` stays distinct from `summary`: no duplicate entry and no text mixing.
    assert_eq!(item["content"].as_array().unwrap().len(), 2);
    assert_eq!(item["summary"].as_array().unwrap().len(), 2);
}

#[test]
fn responses_reasoning_content_survives_when_distinct_from_summary() {
    // Constructed shape lock, not a claimed historical DSH sample: content must be
    // carried on its own and never reconstructed by mirroring summary. This blocks a
    // guess-dedup / summary-mirroring repair for the confirmed builder-content loss.
    let reasoning = json!({
        "type": "reasoning",
        "summary": [{"type": "summary_text", "text": "short summary"}],
        "content": [
            {"type": "reasoning_text", "text": "full reasoning part one"},
            {"type": "reasoning_text", "text": "full reasoning part two"}
        ]
    });

    let item = normalized_reasoning_output_item(&reasoning);
    assert_eq!(item["summary"], reasoning["summary"]);
    assert_eq!(
        item["content"], reasoning["content"],
        "distinct reasoning.content must survive typed JSON normalization without mirroring summary"
    );
}

#[test]
fn responses_reasoning_content_survives_output_item_done_sse_round_trip() {
    let reasoning = json!({
        "type": "reasoning",
        "summary": [{"type": "summary_text", "text": "reasoning for the tool call"}],
        "content": [{"type": "reasoning_text", "text": "reasoning for the tool call"}]
    });

    let item = classify_v3_responses_sse_output_item(&reasoning).unwrap();
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
    assert_eq!(
        object.data_value(),
        Some(&reasoning),
        "response.output_item.done SSE projection must preserve reasoning.content"
    );
}

#[test]
fn responses_reasoning_content_round_trips_all_json_shapes_losslessly() {
    let cases = [
        ("absent", None, false),
        ("null", Some(json!(null)), true),
        ("string", Some(json!("reasoning text")), true),
        ("number", Some(json!(17)), true),
        ("bool", Some(json!(true)), true),
        ("object", Some(json!({"nested": [1, null, "kept"]})), true),
        ("empty_array", Some(json!([])), true),
        (
            "standard_reasoning_text_array",
            Some(json!([
                {"type": "reasoning_text", "text": "first"},
                {"type": "reasoning_text", "text": "second"}
            ])),
            true,
        ),
        (
            "arbitrary_json_array",
            Some(json!([
                {"type": "reasoning_text", "text": "typed part"},
                "opaque scalar",
                3,
                null,
                {"provider_extension": {"keep": true}}
            ])),
            true,
        ),
    ];

    for (label, expected_content, content_present) in cases {
        let summary = json!([
            {"type": "summary_text", "text": format!("{label} summary")}
        ]);
        let mut reasoning = json!({
            "type": "reasoning",
            "summary": summary.clone()
        });
        if let Some(content) = expected_content.as_ref() {
            reasoning["content"] = content.clone();
        }

        let document = json!({
            "object": "response",
            "id": "resp_reasoning_shapes",
            "status": "completed",
            "output": [reasoning.clone()]
        });
        let normalized = V3ResponsesJsonDocument::from_json(&document)
            .unwrap_or_else(|error| panic!("{label}: JSON document must normalize: {error:?}"))
            .to_normalized_value();
        let normalized_item = normalized["output"]
            .as_array()
            .and_then(|output| output.first())
            .unwrap_or_else(|| panic!("{label}: normalized JSON output item missing"));
        assert_eq!(
            normalized_item.get("content"),
            expected_content.as_ref(),
            "{label}: JSON document must preserve reasoning.content presence and exact JSON value"
        );
        assert_eq!(
            normalized_item.get("summary"),
            Some(&summary),
            "{label}: JSON document must preserve summary independently"
        );

        let item = classify_v3_responses_sse_output_item(&reasoning)
            .unwrap_or_else(|error| panic!("{label}: SSE item must classify: {error:?}"));
        assert_eq!(
            item.to_normalized_value().get("content"),
            expected_content.as_ref(),
            "{label}: SSE item must preserve reasoning.content presence and exact JSON value"
        );
        let bytes =
            project_v3_responses_sse_item_sse(Some("response.output_item.done".to_owned()), &item)
                .unwrap_or_else(|error| panic!("{label}: SSE item must project: {error:?}"));
        let mut decoder = routecodex_v3_sse::SseIncrementalDecoder::new(
            routecodex_v3_sse::SseTransportLimits::default(),
        );
        let frame = decoder
            .push(routecodex_v3_sse::build_v3_sse_transport_in_01_raw_chunk(
                &bytes,
            ))
            .unwrap_or_else(|error| panic!("{label}: SSE frame must decode: {error:?}"))
            .pop()
            .unwrap_or_else(|| panic!("{label}: SSE frame must be present"));
        let object = crate::sse_object_pipeline::SseObjectFrame::from_frame(&frame);
        let projected = object
            .data_value()
            .unwrap_or_else(|| panic!("{label}: SSE data must be present"));
        assert_eq!(
            projected.get("content"),
            expected_content.as_ref(),
            "{label}: SSE projection must preserve reasoning.content presence and exact JSON value"
        );
        assert_eq!(
            projected.get("summary"),
            Some(&summary),
            "{label}: SSE projection must preserve summary independently"
        );
        if content_present {
            assert!(
                projected.get("content").is_some(),
                "{label}: present content must not disappear"
            );
        } else {
            assert!(
                projected.get("content").is_none(),
                "{label}: absent content must not be synthesized"
            );
        }
    }
}

fn apply_annotation_item_added(reducer: &mut V3ResponsesSseReducerState) {
    reducer
        .apply_event(&json!({
            "type": "response.output_item.added",
            "output_index": 0,
            "item": {
                "type": "message",
                "id": "msg_1",
                "status": "in_progress",
                "role": "assistant",
                "content": []
            }
        }))
        .unwrap();
}

fn apply_annotation_content_part_done(
    reducer: &mut V3ResponsesSseReducerState,
    annotations: &serde_json::Value,
) {
    reducer
        .apply_event(&json!({
            "type": "response.content_part.done",
            "output_index": 0,
            "item_id": "msg_1",
            "content_index": 0,
            "part": {
                "type": "output_text",
                "text": "cited text",
                "annotations": annotations
            }
        }))
        .unwrap();
}

fn apply_annotation_item_done(
    reducer: &mut V3ResponsesSseReducerState,
    content: serde_json::Value,
) {
    reducer
        .apply_event(&json!({
            "type": "response.output_item.done",
            "output_index": 0,
            "item": {
                "type": "message",
                "id": "msg_1",
                "status": "completed",
                "role": "assistant",
                "content": content
            }
        }))
        .unwrap();
}

#[test]
fn responses_item_done_merge_preserves_content_part_annotations() {
    let annotations = json!([{
        "type": "url_citation",
        "url": "https://example.com/cited",
        "title": "cited"
    }]);
    let mut reducer = V3ResponsesSseReducerState::default();
    apply_annotation_item_added(&mut reducer);
    apply_annotation_content_part_done(&mut reducer, &annotations);
    assert_eq!(
        reducer.items[0].item().to_normalized_value()["content"][0]["annotations"],
        annotations,
        "content part events must merge annotations into the reduced item"
    );

    apply_annotation_item_done(
        &mut reducer,
        json!([{"type": "output_text", "text": "cited text"}]),
    );
    let normalized = reducer.items[0].item().to_normalized_value();
    assert_eq!(normalized["content"][0]["text"], json!("cited text"));
    assert_eq!(
        normalized["content"][0]["annotations"], annotations,
        "response.output_item.done must keep annotations that only intermediate events carried"
    );
}

#[test]
fn responses_item_done_merge_keeps_explicit_and_empty_content_part_annotations() {
    let intermediate = json!([{
        "type": "url_citation",
        "url": "https://example.com/intermediate"
    }]);
    let done_owned = json!([{
        "type": "url_citation",
        "url": "https://example.com/done"
    }]);
    let cases: Vec<(Option<Value>, Value, &str)> = vec![
        (
            Some(done_owned.clone()),
            done_owned.clone(),
            "annotations declared by the closing part must win",
        ),
        (
            Some(json!([])),
            json!([]),
            "an explicitly empty annotation list must stay empty",
        ),
        (
            None,
            intermediate.clone(),
            "a closing part without annotations must be backfilled",
        ),
    ];
    for (done_annotations, expected, label) in cases {
        let mut reducer = V3ResponsesSseReducerState::default();
        apply_annotation_item_added(&mut reducer);
        apply_annotation_content_part_done(&mut reducer, &intermediate);
        let mut part = json!({"type": "output_text", "text": "cited text"});
        if let Some(done_annotations) = done_annotations {
            part["annotations"] = done_annotations;
        }
        apply_annotation_item_done(&mut reducer, json!([part]));
        assert_eq!(
            reducer.items[0].item().to_normalized_value()["content"][0]["annotations"],
            expected,
            "{label}"
        );
    }
}

#[test]
fn responses_item_done_merge_does_not_move_annotations_across_part_types() {
    let mut reducer = V3ResponsesSseReducerState::default();
    apply_annotation_item_added(&mut reducer);
    apply_annotation_content_part_done(
        &mut reducer,
        &json!([{"type": "url_citation", "url": "https://example.com/cited"}]),
    );
    apply_annotation_item_done(
        &mut reducer,
        json!([{"type": "refusal", "refusal": "not citing"}]),
    );
    let normalized = reducer.items[0].item().to_normalized_value();
    assert_eq!(normalized["content"][0]["refusal"], json!("not citing"));
    assert!(
        normalized["content"][0].get("annotations").is_none(),
        "annotations belong to the output_text part and must not attach to a refusal part"
    );
}

//! Public consumer coverage for the single current hosted-history event.
//!
//! The registered field library normalizes one configured hosted source item
//! into one assistant/null history anchor carrying the complete native event
//! as an extension. These tests drive the public SDK boundary: normalize ->
//! current canonical editor -> registered current inverse/helper. They assert
//! external value behavior only; no private slot is used as a substitute.
use routecodex_v3_runtime::operation_runner::{
    apply_canonical_field_edit, execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, project_canonical_direct_request,
    project_hosted_history_emissions, CanonicalFieldEdit, CurrentFieldAssociations,
    DirectRequestProjection, RequestInvocationContext, RequestNormalizationEntry,
    RequestOriginKind, RequestScopedContextPair, V3RequestContextHandle,
};
use serde_json::{json, Value};

const EXTENSION_KEY: &str = "responses_hosted_history_event";

fn normalize(raw: Value) -> (Value, RequestScopedContextPair, CurrentFieldAssociations) {
    let handle = V3RequestContextHandle::new("hosted-current-event".into(), "responses".into());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "hosted-invocation".into(),
        "hosted-attempt".into(),
        RequestOriginKind::ClientEntry,
    );
    let captured = execute_v3_operation_runner_request_capture_client_json(raw).unwrap();
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .unwrap();
    let pair = handle.original_pair().unwrap();
    let associations = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    (canonical, pair, associations)
}

fn project(
    canonical: &Value,
    pair: &RequestScopedContextPair,
    associations: &CurrentFieldAssociations,
) -> DirectRequestProjection {
    project_canonical_direct_request(
        canonical,
        &pair.inverse_context,
        associations,
        &pair.explicit_history_pairing,
    )
    .unwrap()
}

fn edit(
    canonical: &Value,
    associations: &CurrentFieldAssociations,
    edit: CanonicalFieldEdit,
) -> (Value, CurrentFieldAssociations) {
    apply_canonical_field_edit(canonical, associations, &edit).unwrap()
}

fn native_event(canonical: &Value, message_index: usize) -> Value {
    canonical["messages"][message_index]["routecodex_chat_extension"][EXTENSION_KEY].clone()
}

fn web_search_item() -> Value {
    json!({
        "type": "web_search_call",
        "id": "ws_1",
        "status": "completed",
        "action": {"type": "search", "query": "routecodex"},
        "result": {"title": "RouteCodex", "url": "https://example.test"},
    })
}

#[test]
fn configured_case_normalizes_to_one_native_anchor_and_roundtrips_exactly() {
    let item = web_search_item();
    let raw = json!({"model": "m", "input": [item.clone()]});
    let (canonical, pair, associations) = normalize(raw);

    let messages = canonical["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 1, "one anchor only: {canonical}");
    assert_eq!(messages[0]["role"], json!("assistant"));
    assert_eq!(messages[0]["content"], Value::Null);
    assert_eq!(native_event(&canonical, 0), item);

    let projected = project(&canonical, &pair, &associations);
    assert_eq!(
        projected.payload["input"],
        json!([item]),
        "unchanged roundtrip must reproduce the exact original native event"
    );

    let emissions = project_hosted_history_emissions(
        &canonical,
        &pair.inverse_context,
        &associations,
    )
    .unwrap();
    assert_eq!(emissions.len(), 1);
    assert_eq!(emissions[0].event, item);
    assert_eq!(emissions[0].identity, "ws_1");
    assert_eq!(emissions[0].canonical_message_index, 0);
    assert_eq!(emissions[0].source_index, 0);
}

#[test]
fn absent_empty_and_nonstring_identity_use_generated_stable_identity() {
    for item in [
        json!({"type": "web_search_call", "status": "completed",
            "action": {"type": "search", "query": "q"}}),
        json!({"type": "web_search_call", "id": "", "call_id": "", "tool_call_id": null,
            "status": "completed", "action": {"type": "search", "query": "q"}}),
        json!({"type": "web_search_call", "id": 7, "call_id": true,
            "status": "completed", "action": {"type": "search", "query": "q"}}),
    ] {
        let raw = json!({"model": "m", "input": [item.clone()]});
        let (canonical, pair, associations) = normalize(raw);
        let emissions = project_hosted_history_emissions(
            &canonical,
            &pair.inverse_context,
            &associations,
        )
        .unwrap();
        assert_eq!(
            emissions[0].identity, "call_routecodex_web_search_0",
            "absent/empty/nonstring identity must use the generated representation identity"
        );
        assert_eq!(
            project(&canonical, &pair, &associations).payload["input"],
            json!([item]),
            "identity absence/presence must be preserved on the native inverse"
        );
    }
}

#[test]
fn failed_and_unknown_status_and_values_are_preserved_without_rejection() {
    let item = json!({
        "type": "web_search_call",
        "id": "ws_failed",
        "status": "failed",
        "action": {"type": "search", "query": "q"},
        "error": {"code": "upstream_error", "message": "boom"},
        "status_detail": {"retryable": true},
        "future_member": [1, 2, {"nested": null}],
    });
    let raw = json!({"model": "m", "input": [item.clone()]});
    let (canonical, pair, associations) = normalize(raw);
    assert_eq!(native_event(&canonical, 0), item);
    assert_eq!(project(&canonical, &pair, &associations).payload["input"], json!([item]));

    let emissions = project_hosted_history_emissions(
        &canonical,
        &pair.inverse_context,
        &associations,
    )
    .unwrap();
    let result_block = &emissions[0].anthropic_blocks[1];
    assert_eq!(result_block["type"], json!("web_search_tool_result"));
    assert_eq!(result_block["content"]["status"], json!("failed"));
    assert_eq!(result_block["content"]["error"]["code"], json!("upstream_error"));
    assert_eq!(result_block["content"]["status_detail"]["retryable"], json!(true));
    assert_eq!(result_block["content"]["future_member"][2]["nested"], Value::Null);

    // An unregistered status string is business data, never a rejection.
    let unknown_status = json!({"type": "web_search_call", "id": "ws_x",
        "status": "quarantined", "action": {"type": "search", "query": "q"}});
    let raw = json!({"model": "m", "input": [unknown_status.clone()]});
    let (canonical, pair, associations) = normalize(raw);
    assert_eq!(project(&canonical, &pair, &associations).payload["input"], json!([unknown_status]));
}

#[test]
fn long_strings_crlf_and_nested_dotted_keys_roundtrip() {
    let long = format!("{}\r\nEXACT_HOSTED_TAIL", "x".repeat(70_000));
    let item = json!({
        "type": "web_search_call",
        "id": "ws_long",
        "status": "completed",
        "action": {"type": "search", "query": long, "dotted.key": {"a.b": [1, {"c.d": "e"}]}},
        "result": {"weird.key": "value", "nested": {"deep.key": {"inner.key": "leaf"}}},
    });
    let raw = json!({"model": "m", "input": [item.clone()]});
    let (canonical, pair, associations) = normalize(raw);
    assert_eq!(native_event(&canonical, 0), item);
    assert_eq!(project(&canonical, &pair, &associations).payload["input"], json!([item]));
}

#[test]
fn current_replace_remove_and_move_govern_the_single_event() {
    let item = json!({
        "type": "web_search_call",
        "id": "ws_edit",
        "status": "completed",
        "action": {"type": "search", "query": "before"},
        "result": {"title": "before", "url": "https://example.test"},
        "result_items": [{"rank": 1}, {"rank": 2}],
        "unknown_field": "keep",
    });
    let raw = json!({"model": "m", "input": [item]});
    let (canonical, pair, associations) = normalize(raw);
    let base = format!("chat.messages[0].routecodex_chat_extension.{EXTENSION_KEY}");

    let (canonical, associations) = edit(
        &canonical,
        &associations,
        CanonicalFieldEdit::Replace {
            path: format!("{base}.action"),
            value: json!({"type": "search", "query": "after"}),
        },
    );
    let (canonical, associations) = edit(
        &canonical,
        &associations,
        CanonicalFieldEdit::Replace {
            path: format!("{base}.unknown_field"),
            value: json!({"replaced": true}),
        },
    );
    let (canonical, associations) = edit(
        &canonical,
        &associations,
        CanonicalFieldEdit::MoveArray {
            array_path: format!("{base}.result_items"),
            from: 0,
            to: 1,
        },
    );
    let (canonical, associations) = edit(
        &canonical,
        &associations,
        CanonicalFieldEdit::Remove {
            path: format!("{base}.result"),
        },
    );

    let expected = json!({
        "type": "web_search_call",
        "id": "ws_edit",
        "status": "completed",
        "action": {"type": "search", "query": "after"},
        "result_items": [{"rank": 2}, {"rank": 1}],
        "unknown_field": {"replaced": true},
    });
    assert_eq!(
        project(&canonical, &pair, &associations).payload["input"],
        json!([expected.clone()]),
        "typed edits must govern the one native event; the removed source value never refills"
    );

    let emissions = project_hosted_history_emissions(
        &canonical,
        &pair.inverse_context,
        &associations,
    )
    .unwrap();
    assert_eq!(emissions.len(), 1);
    assert_eq!(emissions[0].event, expected);
    let call_arguments: Value = serde_json::from_str(
        emissions[0].chat_assistant["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        call_arguments,
        json!({"type": "search", "query": "after"}),
        "the Chat call half derives its arguments from the same current event"
    );
    let result_content: Value = serde_json::from_str(
        emissions[0].chat_tool_result["content"].as_str().unwrap(),
    )
    .unwrap();
    assert_eq!(
        result_content, expected,
        "the Chat result half is the JSON encoding of the same current event"
    );
    assert!(
        emissions[0].anthropic_blocks[1]["content"].get("result").is_none(),
        "the removed field must not reappear in the native outcome"
    );
    assert_eq!(
        emissions[0].anthropic_blocks[1]["content"]["unknown_field"],
        json!({"replaced": true})
    );
}

#[test]
fn whole_anchor_deletion_emits_no_native_event_and_no_generated_pair() {
    let item = web_search_item();
    let raw = json!({"model": "m", "input": [item]});
    let (canonical, pair, associations) = normalize(raw);
    let (canonical, associations) = edit(
        &canonical,
        &associations,
        CanonicalFieldEdit::Remove {
            path: "chat.messages[0]".to_string(),
        },
    );
    assert_eq!(
        project(&canonical, &pair, &associations).payload["input"],
        json!([]),
        "a deleted anchor must not be revived from the opaque source record"
    );
    assert!(
        project_hosted_history_emissions(&canonical, &pair.inverse_context, &associations)
            .unwrap()
            .is_empty(),
        "a deleted anchor emits no generated Chat pair"
    );
}

#[test]
fn anthropic_native_blocks_carry_current_outcome_and_exclude_only_identity() {
    let item = json!({
        "type": "web_search_call",
        "id": "ws_anthropic",
        "status": "completed",
        "action": {"type": "search", "query": "q"},
        "result": {"title": "t", "url": "https://example.test"},
        "result_items": [{"rank": 1}],
        "unknown_sibling": {"x": 1},
    });
    let raw = json!({"model": "m", "input": [item]});
    let (canonical, pair, associations) = normalize(raw);
    let emissions = project_hosted_history_emissions(
        &canonical,
        &pair.inverse_context,
        &associations,
    )
    .unwrap();
    let blocks = &emissions[0].anthropic_blocks;
    assert_eq!(blocks.len(), 2);
    assert_eq!(blocks[0]["type"], json!("server_tool_use"));
    assert_eq!(blocks[0]["id"], json!("ws_anthropic"));
    assert_eq!(blocks[0]["name"], json!("web_search"));
    assert_eq!(blocks[0]["input"], json!({"type": "search", "query": "q"}));
    assert_eq!(blocks[1]["type"], json!("web_search_tool_result"));
    assert_eq!(blocks[1]["tool_use_id"], json!("ws_anthropic"));
    let content = &blocks[1]["content"];
    assert_eq!(content["status"], json!("completed"));
    assert_eq!(content["action"], json!({"type": "search", "query": "q"}));
    assert_eq!(content["result"]["title"], json!("t"));
    assert_eq!(content["result_items"], json!([{"rank": 1}]));
    assert_eq!(content["unknown_sibling"], json!({"x": 1}));
    for excluded in ["type", "id", "call_id", "tool_call_id"] {
        assert!(
            content.get(excluded).is_none(),
            "identity/type field {excluded} is represented by the native blocks"
        );
    }
}

#[test]
fn absent_and_nonobject_arguments_follow_the_configured_encoding() {
    // Absent action -> empty object call arguments.
    let raw = json!({"model": "m", "input": [{"type": "web_search_call", "id": "ws_absent"}]});
    let (canonical, pair, associations) = normalize(raw);
    let emissions = project_hosted_history_emissions(
        &canonical,
        &pair.inverse_context,
        &associations,
    )
    .unwrap();
    assert_eq!(emissions[0].arguments, json!({}));
    assert_eq!(emissions[0].anthropic_blocks[0]["input"], json!({}));

    // Non-object action -> preserved under `value`.
    let raw = json!({"model": "m", "input": [{"type": "web_search_call", "id": "ws_scalar",
        "action": "just-a-query"}]});
    let (canonical, pair, associations) = normalize(raw);
    let emissions = project_hosted_history_emissions(
        &canonical,
        &pair.inverse_context,
        &associations,
    )
    .unwrap();
    assert_eq!(emissions[0].arguments, json!({"value": "just-a-query"}));
}

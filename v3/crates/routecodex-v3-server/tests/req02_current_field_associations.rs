use routecodex_v3_runtime::operation_runner::{
    apply_canonical_field_edit, execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, CanonicalFieldEdit,
    CurrentFieldAssociations, RequestInvocationContext, RequestNormalizationEntry,
    RequestOriginKind, RequestScopedContextPair, V3RequestContextHandle,
};
use serde_json::{json, Value};

fn normalize_responses(request_id: &str, raw: Value) -> (Value, RequestScopedContextPair) {
    let handle = V3RequestContextHandle::new(request_id.to_string(), "responses".to_string());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        format!("{request_id}-invocation"),
        format!("{request_id}-attempt"),
        RequestOriginKind::ClientEntry,
    );
    let captured = execute_v3_operation_runner_request_capture_client_json(raw)
        .expect("public capture entry accepts real client JSON");
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .expect("public normalize entry executes the real REQ02 SDK slice");
    let pair = handle
        .original_pair()
        .expect("raw client entry publishes the original inverse/history pair");
    (canonical, pair)
}

fn mapping_index(pair: &RequestScopedContextPair, source_path: &str) -> usize {
    pair.inverse_context
        .field_mappings
        .iter()
        .position(|mapping| mapping.source_path == source_path)
        .unwrap_or_else(|| panic!("missing field mapping for `{source_path}`"))
}

fn record_id_for(pair: &RequestScopedContextPair, mapping_index: usize) -> String {
    let mapping = &pair.inverse_context.field_mappings[mapping_index];
    pair.inverse_context
        .tool_declarations
        .iter()
        .find(|declaration| declaration.source_path == mapping.source_path)
        .unwrap_or_else(|| {
            panic!(
                "missing tool declaration for mapping `{}`",
                mapping.source_path
            )
        })
        .record_id
        .clone()
}

fn declaration_kind_for(pair: &RequestScopedContextPair, mapping_index: usize) -> &str {
    let mapping = &pair.inverse_context.field_mappings[mapping_index];
    &pair
        .inverse_context
        .tool_declarations
        .iter()
        .find(|declaration| declaration.source_path == mapping.source_path)
        .unwrap_or_else(|| {
            panic!(
                "missing tool declaration for mapping `{}`",
                mapping.source_path
            )
        })
        .kind
}

fn canonical_tool_call_by_id<'a>(canonical: &'a Value, call_id: &str) -> &'a Value {
    canonical["messages"]
        .as_array()
        .expect("canonical messages are an array")
        .iter()
        .find_map(|message| {
            message["tool_calls"]
                .as_array()
                .and_then(|calls| calls.iter().find(|call| call["id"] == call_id))
        })
        .unwrap_or_else(|| panic!("missing canonical tool call `{call_id}`"))
}

fn apply_patch_tool() -> Value {
    json!({
        "type": "custom",
        "name": "apply_patch",
        "input_schema": {"type": "object", "properties": {"patch": {"type": "string"}}}
    })
}

fn exec_tool() -> Value {
    json!({
        "type": "function",
        "name": "exec",
        "parameters": {"type": "object", "properties": {"cmd": {"type": "string"}}}
    })
}

fn namespace_tools(children: Vec<Value>) -> Value {
    json!({
        "model": "responses-model",
        "input": [],
        "tools": [{
            "type": "namespace",
            "name": "functions",
            "tools": children
        }]
    })
}

#[test]
fn public_sdk_remove_preceding_child_keeps_surviving_exec_mapping_and_record() {
    let custom = apply_patch_tool();
    let exec = exec_tool();
    let (canonical, pair) = normalize_responses(
        "req02-current-remove",
        namespace_tools(vec![custom.clone(), exec.clone()]),
    );
    let custom_index = mapping_index(&pair, "request.tools[0].tools[0]");
    let exec_index = mapping_index(&pair, "request.tools[0].tools[1]");
    let custom_record = record_id_for(&pair, custom_index);
    let exec_record = record_id_for(&pair, exec_index);
    assert_ne!(custom_record, exec_record);

    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    let original_pair = pair.clone();
    let (data, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::Remove {
            path: "chat.tools[0].tools[0]".to_string(),
        },
    )
    .unwrap();

    assert_eq!(data["tools"][0]["tools"].as_array().unwrap().len(), 1);
    assert_eq!(data["tools"][0]["tools"][0]["name"], "exec");
    assert_eq!(current.destination_for_original_mapping(custom_index), None);
    assert_eq!(
        current.destination_for_original_mapping(exec_index),
        Some("chat.tools[0].tools[0]")
    );
    let indices = current.original_mapping_indices_for_destination("chat.tools[0].tools[0]");
    assert!(indices.contains(&exec_index));
    assert!(!indices.contains(&custom_index));
    assert_eq!(record_id_for(&pair, exec_index), exec_record);
    assert_eq!(pair, original_pair);
}

#[test]
fn public_sdk_insert_before_shifts_existing_sources_without_fake_origin() {
    let custom = apply_patch_tool();
    let exec = exec_tool();
    let (canonical, pair) = normalize_responses(
        "req02-current-insert",
        namespace_tools(vec![custom.clone(), exec.clone()]),
    );
    let custom_index = mapping_index(&pair, "request.tools[0].tools[0]");
    let exec_index = mapping_index(&pair, "request.tools[0].tools[1]");
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);

    let (data, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::InsertArray {
            array_path: "chat.tools[0].tools".to_string(),
            index: 0,
            value: json!({"type": "function", "name": "new"}),
        },
    )
    .unwrap();

    assert_eq!(data["tools"][0]["tools"][0]["name"], "new");
    assert!(current
        .original_mapping_indices_for_destination("chat.tools[0].tools[0]")
        .is_empty());
    assert_eq!(
        current.destination_for_original_mapping(custom_index),
        Some("chat.tools[0].tools[1]")
    );
    assert_eq!(
        current.destination_for_original_mapping(exec_index),
        Some("chat.tools[0].tools[2]")
    );
}

#[test]
fn public_sdk_move_within_array_moves_both_original_ids_with_the_elements() {
    let custom = apply_patch_tool();
    let exec = exec_tool();
    let (canonical, pair) = normalize_responses(
        "req02-current-move",
        namespace_tools(vec![custom.clone(), exec.clone()]),
    );
    let custom_index = mapping_index(&pair, "request.tools[0].tools[0]");
    let exec_index = mapping_index(&pair, "request.tools[0].tools[1]");
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);

    let (data, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::MoveArray {
            array_path: "chat.tools[0].tools".to_string(),
            from: 0,
            to: 1,
        },
    )
    .unwrap();

    assert_eq!(data["tools"][0]["tools"][0]["name"], "exec");
    assert_eq!(data["tools"][0]["tools"][1]["name"], "apply_patch");
    assert_eq!(
        current.original_mapping_indices_for_destination("chat.tools[0].tools[0]"),
        vec![exec_index]
    );
    assert_eq!(
        current.original_mapping_indices_for_destination("chat.tools[0].tools[1]"),
        vec![custom_index]
    );
}

#[test]
fn public_sdk_consecutive_deletes_keep_only_the_last_original_mapping() {
    let custom = apply_patch_tool();
    let exec = exec_tool();
    let mcp = json!({
        "type": "custom",
        "name": "mcp_read",
        "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}}
    });
    let (canonical, pair) = normalize_responses(
        "req02-current-deletes",
        namespace_tools(vec![custom.clone(), exec.clone(), mcp.clone()]),
    );
    let mcp_index = mapping_index(&pair, "request.tools[0].tools[2]");
    let mcp_record = record_id_for(&pair, mcp_index);
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);

    let (data, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::Remove {
            path: "chat.tools[0].tools[0]".to_string(),
        },
    )
    .unwrap();
    let (data, current) = apply_canonical_field_edit(
        &data,
        &current,
        &CanonicalFieldEdit::Remove {
            path: "chat.tools[0].tools[0]".to_string(),
        },
    )
    .unwrap();

    assert_eq!(data["tools"][0]["tools"].as_array().unwrap().len(), 1);
    assert_eq!(data["tools"][0]["tools"][0]["name"], "mcp_read");
    assert_eq!(
        current.original_mapping_indices_for_destination("chat.tools[0].tools[0]"),
        vec![mcp_index]
    );
    assert_eq!(record_id_for(&pair, mcp_index), mcp_record);
}

#[test]
fn public_sdk_same_name_schema_with_different_original_kind_follows_the_survivor() {
    let schema = json!({"type": "object", "properties": {"value": {"type": "string"}}});
    let custom = json!({"type": "custom", "name": "lookup", "input_schema": schema.clone()});
    let function = json!({"type": "function", "name": "lookup", "parameters": schema.clone()});
    let (canonical, pair) = normalize_responses(
        "req02-current-kind",
        namespace_tools(vec![custom.clone(), function.clone()]),
    );
    let custom_index = mapping_index(&pair, "request.tools[0].tools[0]");
    let function_index = mapping_index(&pair, "request.tools[0].tools[1]");
    assert_eq!(declaration_kind_for(&pair, custom_index), "custom");
    assert_eq!(declaration_kind_for(&pair, function_index), "function");
    let function_record = record_id_for(&pair, function_index);
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);

    let (data, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::Remove {
            path: "chat.tools[0].tools[0]".to_string(),
        },
    )
    .unwrap();

    assert_eq!(data["tools"][0]["tools"][0]["name"], "lookup");
    assert_eq!(
        current.original_mapping_indices_for_destination("chat.tools[0].tools[0]"),
        vec![function_index]
    );
    assert_eq!(record_id_for(&pair, function_index), function_record);
}

#[test]
fn public_sdk_quoted_literal_key_uses_structural_parser_and_keeps_original_pair() {
    let patch = format!(
        "{}\n*** Begin Patch\n+literal\n*** End Patch\n{}",
        "a".repeat(70_000),
        "b".repeat(70_000)
    );
    let raw = json!({
        "model": "responses-model",
        "input": [],
        "vendor.name[0]": {"patch": patch.clone()}
    });
    let (canonical, pair) = normalize_responses("req02-current-literal", raw);
    assert_eq!(canonical["vendor.name[0]"]["patch"], json!(patch));
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    assert!(
        current
            .original_mapping_indices_for_destination(r#"chat["vendor.name[0]"]"#)
            .len()
            > 0
    );
    let original_pair = pair.clone();

    let (data, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::Replace {
            path: r#"chat["vendor.name[0]"].patch"#.to_string(),
            value: json!(patch.clone()),
        },
    )
    .unwrap();

    assert_eq!(data["vendor.name[0]"]["patch"], json!(patch));
    assert!(
        current
            .original_mapping_indices_for_destination(r#"chat["vendor.name[0]"]"#)
            .len()
            > 0
    );
    assert_eq!(pair, original_pair);
}

#[test]
fn public_sdk_schema_mutation_keeps_the_existing_source_association() {
    let custom = apply_patch_tool();
    let exec = exec_tool();
    let (canonical, pair) = normalize_responses(
        "req02-current-schema",
        namespace_tools(vec![custom.clone(), exec.clone()]),
    );
    let exec_index = mapping_index(&pair, "request.tools[0].tools[1]");
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);

    let (data, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::Replace {
            path: "chat.tools[0].tools[1].parameters".to_string(),
            value: json!({"type": "object", "properties": {"new_cmd": {"type": "string"}}}),
        },
    )
    .unwrap();

    assert_eq!(
        data["tools"][0]["tools"][1]["parameters"]["properties"]["new_cmd"]["type"],
        "string"
    );
    assert_eq!(
        current.destination_for_original_mapping(exec_index),
        Some("chat.tools[0].tools[1]")
    );
}

#[test]
fn public_sdk_edit_preserves_complete_exec_patch_and_mcp_strings() {
    let arguments = format!("{{}}\n{}REQ02_CURRENT_EXEC_TAIL", "x".repeat(70_000));
    let patch = format!("*** Begin Patch\n+{}\n*** End Patch\n", "y".repeat(70_000));
    let mcp_input = format!("{}{}", "mcp".repeat(40_000), "REQ02_CURRENT_MCP_TAIL");
    let raw = json!({
        "model": "responses-model",
        "tools": [{
            "type": "namespace",
            "name": "functions",
            "tools": [apply_patch_tool(), exec_tool()]
        }],
        "input": [
            {"type": "function_call", "call_id": "call_exec", "name": "exec", "arguments": arguments},
            {"type": "custom_tool_call", "call_id": "call_patch", "name": "apply_patch", "input": patch},
            {"type": "custom_tool_call", "call_id": "call_mcp", "name": "mcp_read", "input": mcp_input}
        ]
    });
    let (canonical, pair) = normalize_responses("req02-current-strings", raw);
    assert_eq!(
        canonical_tool_call_by_id(&canonical, "call_exec")["function"]["arguments"],
        json!(arguments)
    );
    assert_eq!(
        canonical_tool_call_by_id(&canonical, "call_patch")["custom"]["input"],
        json!(patch)
    );
    assert_eq!(
        canonical_tool_call_by_id(&canonical, "call_mcp")["custom"]["input"],
        json!(mcp_input)
    );
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);

    let (data, _current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::Remove {
            path: "chat.tools[0].tools[0]".to_string(),
        },
    )
    .unwrap();

    assert_eq!(
        canonical_tool_call_by_id(&data, "call_exec")["function"]["arguments"],
        json!(arguments)
    );
    assert_eq!(
        canonical_tool_call_by_id(&data, "call_patch")["custom"]["input"],
        json!(patch)
    );
    assert_eq!(
        canonical_tool_call_by_id(&data, "call_mcp")["custom"]["input"],
        json!(mcp_input)
    );
}

#[test]
fn public_sdk_failed_edit_leaves_data_and_current_associations_unchanged() {
    let custom = apply_patch_tool();
    let exec = exec_tool();
    let (canonical, pair) = normalize_responses(
        "req02-current-failure",
        namespace_tools(vec![custom.clone(), exec.clone()]),
    );
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    let before_canonical = canonical.clone();
    let before_current = current.clone();

    let error = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::Remove {
            path: "chat.tools[0].tools[9]".to_string(),
        },
    )
    .expect_err("missing array element must fail");

    assert!(error.contains("missing"));
    assert_eq!(canonical, before_canonical);
    assert_eq!(current, before_current);
}

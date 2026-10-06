use routecodex_v3_runtime::operation_runner::{
    execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, RequestInvocationContext,
    RequestNormalizationEntry, RequestOriginKind, RequestScopedContextPair, V3RequestContextHandle,
};
use serde_json::{json, Value};

fn normalize(request_id: &str, protocol: &str, raw: Value) -> (Value, RequestScopedContextPair) {
    let handle = V3RequestContextHandle::new(request_id.to_string(), protocol.to_string());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        format!("{request_id}-invocation"),
        format!("{request_id}-attempt"),
        RequestOriginKind::ClientEntry,
    );
    let captured = execute_v3_operation_runner_request_capture_client_json(raw)
        .expect("public capture entry accepts the fixture");
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .expect("public normalize entry accepts the fixture");
    let pair = handle
        .original_pair()
        .expect("public normalize entry publishes the original pair");
    (canonical, pair)
}

fn destinations(pair: &RequestScopedContextPair, source_path: &str) -> Vec<String> {
    pair.inverse_context
        .field_mappings
        .iter()
        .filter(|mapping| {
            mapping.source_path == source_path
                && mapping.semantics.as_deref() != Some("normalization_instruction_separator")
        })
        .map(|mapping| mapping.destination.clone())
        .collect()
}

fn flattened_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| {
                part.get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_else(|| panic!("text part without text: {part}"))
                    .to_string()
            })
            .collect::<Vec<_>>()
            .join(""),
        other => panic!("unsupported canonical content: {other}"),
    }
}

fn assert_no_wildcard_history_destinations(pair: &RequestScopedContextPair) {
    assert!(pair
        .inverse_context
        .field_mappings
        .iter()
        .all(|mapping| !mapping.destination.contains("[]")));
}

#[test]
fn gemini_two_text_parts_use_distinct_concrete_leaves_and_preserve_flattened_bytes() {
    let first = "alpha\r\n";
    let second = "omega\n";
    let (canonical, pair) = normalize(
        "req02-gemini-instruction-parts",
        "gemini",
        json!({
            "model": "gemini-test",
            "systemInstruction": {
                "parts": [
                    {"text": first},
                    {"text": ""},
                    {"text": second}
                ],
                "vendorRoot": {"literal.key[0]": null}
            },
            "contents": [{"role": "user", "parts": [{"text": "hello"}]}]
        }),
    );

    assert_eq!(
        canonical["messages"][0]["content"],
        json!([
            {"type": "text", "text": first},
            {"type": "text", "text": "\n"},
            {"type": "text", "text": ""},
            {"type": "text", "text": "\n"},
            {"type": "text", "text": second}
        ])
    );
    assert_eq!(
        flattened_text(&canonical["messages"][0]["content"]),
        format!("{first}\n\n{second}")
    );
    assert_eq!(
        destinations(&pair, "request.systemInstruction.parts[0].text"),
        vec!["chat.messages[0].content[0].text"]
    );
    assert_eq!(
        destinations(&pair, "request.systemInstruction.parts[1].text"),
        vec!["chat.messages[0].content[2].text"]
    );
    assert_eq!(
        destinations(&pair, "request.systemInstruction.parts[2].text"),
        vec!["chat.messages[0].content[4].text"]
    );
    assert!(pair
        .inverse_context
        .opaque_record_references
        .iter()
        .any(
            |record| record.path == r#"request.systemInstruction["vendorRoot"]"#
                || record.path == "request.systemInstruction.vendorRoot"
        ));
    assert_no_wildcard_history_destinations(&pair);
}

#[test]
fn anthropic_system_parts_keep_scalar_and_multipart_shapes() {
    let scalar = "single system";
    let (scalar_canonical, scalar_pair) = normalize(
        "req02-anthropic-scalar-system",
        "anthropic",
        json!({
            "model": "claude-test",
            "max_tokens": 64,
            "system": scalar,
            "messages": [{"role": "user", "content": "hello"}]
        }),
    );
    assert_eq!(scalar_canonical["messages"][0]["content"], scalar);
    assert_eq!(
        destinations(&scalar_pair, "request.system"),
        vec!["chat.messages[0].content"]
    );

    let first = json!({"type": "text", "text": "one\r\n", "cache_control": {"type": "ephemeral"}});
    let second = json!({"type": "text", "text": "two", r#"literal.key[0]"#: null});
    let (canonical, pair) = normalize(
        "req02-anthropic-multipart-system",
        "anthropic",
        json!({
            "model": "claude-test",
            "max_tokens": 64,
            "system": [first.clone(), second.clone()],
            "messages": [{"role": "user", "content": "hello"}]
        }),
    );
    assert_eq!(
        canonical["messages"][0]["content"],
        json!([
            {"type": "text", "text": "one\r\n"},
            {"type": "text", "text": "\n"},
            {"type": "text", "text": "two"}
        ])
    );
    assert_eq!(
        flattened_text(&canonical["messages"][0]["content"]),
        "one\r\n\ntwo"
    );
    assert_eq!(
        destinations(&pair, "request.system[0].text"),
        vec!["chat.messages[0].content[0].text"]
    );
    assert_eq!(
        destinations(&pair, "request.system[1].text"),
        vec!["chat.messages[0].content[2].text"]
    );
    assert!(pair
        .inverse_context
        .opaque_record_references
        .iter()
        .any(|record| record.path == "request.system[0].cache_control"
            || record.path == r#"request.system[0]["cache_control"]"#));
    assert!(pair
        .inverse_context
        .opaque_record_references
        .iter()
        .any(|record| record.path == r#"request.system[1]["literal.key[0]"]"#));
    assert_no_wildcard_history_destinations(&pair);
}

#[test]
fn responses_instructions_append_to_existing_system_with_distinct_leaf_paths() {
    let instruction = "instruction\nwith newline";
    let existing = "existing history";
    let (canonical, pair) = normalize(
        "req02-responses-instruction-existing-system",
        "responses",
        json!({
            "model": "responses-test",
            "instructions": instruction,
            "input": [
                {"role": "user", "content": "hello"},
                {"role": "system", "content": existing}
            ]
        }),
    );

    assert_eq!(
        canonical["messages"][1]["content"],
        json!([
            {"type": "text", "text": instruction},
            {"type": "text", "text": "\n"},
            {"type": "text", "text": existing}
        ])
    );
    assert_eq!(
        flattened_text(&canonical["messages"][1]["content"]),
        format!("{instruction}\n{existing}")
    );
    assert_eq!(
        destinations(&pair, "request.instructions"),
        vec!["chat.messages[1].content[0].text"]
    );
    assert_eq!(
        destinations(&pair, "request.input[1].content"),
        vec!["chat.messages[1].content[2].text"]
    );
    let generated = pair
        .inverse_context
        .field_mappings
        .iter()
        .filter(|mapping| {
            mapping.semantics.as_deref() == Some("normalization_instruction_separator")
        })
        .collect::<Vec<_>>();
    assert_eq!(generated.len(), 1);
    assert_eq!(generated[0].source_path, "request.instructions");
    assert_eq!(generated[0].destination, "chat.messages[1].content[1]");
    assert_eq!(
        generated[0].transform_id.as_deref(),
        Some("v3.responses.instructions_to_chat_system.v1")
    );
    assert_no_wildcard_history_destinations(&pair);
}

#[test]
fn prefix_shift_and_mixed_history_mappings_remain_exact() {
    let (canonical, pair) = normalize(
        "req02-instruction-prefix-shift",
        "responses",
        json!({
            "model": "responses-test",
            "instructions": "prefix\r\n",
            "messages": [{"role": "user", "content": "primary"}],
            "input": [
                {"role": "user", "content": "secondary"},
                {
                    "type": "function_call",
                    "call_id": "call-exec",
                    "namespace": "functions",
                    "name": "exec",
                    "arguments": "{\"cmd\":\"printf exact\"}"
                },
                {
                    "type": "custom_tool_call",
                    "call_id": "call-patch",
                    "namespace": "server",
                    "name": "apply_patch",
                    "input": "*** Begin Patch\n*** End Patch\n"
                },
                {
                    "type": "function_call_output",
                    "call_id": "call-exec",
                    "output": "exec output"
                },
                {
                    "type": "custom_tool_call_output",
                    "call_id": "call-patch",
                    "output": "patch output"
                }
            ]
        }),
    );

    assert_eq!(canonical["messages"][0]["content"], "prefix\r\n");
    assert_eq!(canonical["messages"][1]["content"], "primary");
    assert_eq!(canonical["messages"][2]["content"], "secondary");
    assert_eq!(
        canonical["messages"][3]["tool_calls"][0]["function"]["arguments"],
        "{\"cmd\":\"printf exact\"}"
    );
    assert_eq!(
        canonical["messages"][4]["tool_calls"][0]["custom"]["input"],
        "*** Begin Patch\n*** End Patch\n"
    );
    assert_eq!(canonical["messages"][5]["content"], "exec output");
    assert_eq!(canonical["messages"][6]["content"], "patch output");
    for (source, destination) in [
        ("request.instructions", "chat.messages[0].content"),
        ("request.messages[0]", "chat.messages[1]"),
        ("request.input[0]", "chat.messages[2]"),
        (
            "request.input[1].arguments",
            "chat.messages[3].tool_calls[0].function.arguments",
        ),
        (
            "request.input[2].input",
            "chat.messages[4].tool_calls[0].custom.input",
        ),
        ("request.input[3].output", "chat.messages[5].content"),
        ("request.input[4].output", "chat.messages[6].content"),
    ] {
        assert!(
            pair.inverse_context.field_mappings.iter().any(|mapping| {
                mapping.source_path == source && mapping.destination == destination
            }),
            "missing mapping {source} -> {destination}"
        );
    }
    assert_no_wildcard_history_destinations(&pair);
}

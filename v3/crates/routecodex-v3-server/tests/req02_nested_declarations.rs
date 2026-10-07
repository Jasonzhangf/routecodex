use routecodex_v3_runtime::operation_runner::{
    execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, HistoryPairingReference,
    RequestInvocationContext, RequestNormalizationEntry, RequestOriginKind,
    RequestScopedContextPair, ToolDeclarationReference, V3RequestContextHandle,
};
use serde_json::{json, Value};

const APPLY_PATCH_GRAMMAR: &str = r#"start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?

hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?

filename: /(.+)/
add_line: "+" /(.*)/ LF -> line

change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF

%import common.LF
"#;

fn normalize_raw(
    entry_protocol: &str,
    request_id: &str,
    raw: Value,
) -> (V3RequestContextHandle, Value, RequestScopedContextPair) {
    let handle = V3RequestContextHandle::new(request_id.to_string(), entry_protocol.to_string());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        format!("{request_id}-invocation"),
        format!("{request_id}-attempt"),
        RequestOriginKind::ClientEntry,
    );
    let captured = execute_v3_operation_runner_request_capture_client_json(raw.clone())
        .expect("public capture entry must accept the real client JSON value");
    assert_eq!(
        captured, raw,
        "public capture entry must preserve the exact client JSON value"
    );
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .expect("public normalize entry must execute the real REQ02 SDK slice");
    let pair = handle
        .original_pair()
        .expect("raw client entry must publish the original inverse/history pair");
    (handle, canonical, pair)
}

fn declaration_by_source<'a>(
    pair: &'a RequestScopedContextPair,
    source_path: &str,
) -> &'a ToolDeclarationReference {
    pair.inverse_context
        .tool_declarations
        .iter()
        .find(|declaration| declaration.source_path == source_path)
        .unwrap_or_else(|| panic!("missing typed declaration for `{source_path}`"))
}

fn history_by_source<'a>(
    pair: &'a RequestScopedContextPair,
    source_path: &str,
) -> &'a HistoryPairingReference {
    pair.explicit_history_pairing
        .messages
        .iter()
        .find(|message| message.source_path == source_path)
        .unwrap_or_else(|| panic!("missing typed history pairing for `{source_path}`"))
}

fn opaque_record_by_id<'a>(canonical: &'a Value, record_id: &str) -> &'a Value {
    canonical["routecodex_chat_extension"]["chat_extension_opaque_record"]
        .as_array()
        .expect("canonical root must carry the opaque record array")
        .iter()
        .find(|record| record["record_id"] == record_id)
        .unwrap_or_else(|| panic!("missing opaque record id `{record_id}`"))
}

fn assert_declaration(
    pair: &RequestScopedContextPair,
    canonical: &Value,
    source_path: &str,
    kind: &str,
    name: &str,
    namespace: Option<&Value>,
    expected_value: &Value,
) -> String {
    let declaration = declaration_by_source(pair, source_path);
    assert_eq!(declaration.kind, kind, "declaration kind at {source_path}");
    assert_eq!(
        declaration.name.as_deref(),
        Some(name),
        "declaration name at {source_path}"
    );
    assert_eq!(
        declaration.namespace.as_ref(),
        namespace,
        "declaration namespace at {source_path}"
    );
    assert_eq!(
        declaration.encoding, "json",
        "declaration encoding at {source_path}"
    );
    let record = opaque_record_by_id(canonical, &declaration.record_id);
    assert_eq!(record["path"], source_path);
    assert_eq!(record["value"], *expected_value);
    declaration.record_id.clone()
}

fn assert_history(
    pair: &RequestScopedContextPair,
    source_path: &str,
    call_id: &str,
    name: Option<&str>,
    kind: &str,
    namespace: Option<&Value>,
) {
    let history = history_by_source(pair, source_path);
    assert_eq!(history.call_id.as_deref(), Some(call_id));
    assert_eq!(history.name.as_deref(), name);
    assert_eq!(history.kind, kind);
    assert_eq!(history.namespace.as_ref(), namespace);
    assert_eq!(history.encoding, "string");
}

#[test]
fn responses_namespace_children_keep_identity_schema_values_and_pairing() {
    let functions_namespace = json!("functions");
    let demo_namespace = json!("mcp__demo__");
    let shared_arguments = json!({
        "cmd": "printf '%s\\n' 'REQ02_NESTED_IDENTITY_SENTINEL'",
        "workdir": "/workspace/routecodex",
        "yield_time_ms": 1000
    })
    .to_string();
    let shared_patch = "*** Begin Patch\n*** Update File: src/nested.rs\n@@\n-old\n+new\n+// REQ02_NESTED_PATCH_TAIL_SENTINEL\n*** End Patch\n";
    let functions_exec = json!({
        "type": "function",
        "name": "exec_command",
        "description": "Functions namespace exec command.",
        "strict": false,
        "parameters": {
            "type": "object",
            "properties": {
                "cmd": {"type": "string"},
                "workdir": {"type": "string"},
                "yield_time_ms": {"type": "number"}
            },
            "required": ["cmd"],
            "additionalProperties": false
        },
        "vendorFunctionField": {"keep": "functions-exec"}
    });
    let functions_patch = json!({
        "type": "custom",
        "name": "apply_patch",
        "description": "Functions namespace apply patch.",
        "format": {
            "type": "grammar",
            "syntax": "lark",
            "definition": APPLY_PATCH_GRAMMAR
        },
        "vendorCustomField": {"keep": "functions-patch"}
    });
    let demo_exec = json!({
        "type": "function",
        "name": "exec_command",
        "description": "Demo namespace exec command.",
        "strict": false,
        "parameters": {
            "type": "object",
            "properties": {
                "cmd": {"type": "string"},
                "workdir": {"type": "string"},
                "yield_time_ms": {"type": "number"},
                "max_output_tokens": {"type": "number"}
            },
            "required": ["cmd", "workdir"],
            "additionalProperties": true
        },
        "vendorFunctionField": {"keep": "demo-exec"}
    });
    let demo_patch = json!({
        "type": "custom",
        "name": "apply_patch",
        "description": "Demo namespace apply patch.",
        "format": {
            "type": "grammar",
            "syntax": "lark",
            "definition": APPLY_PATCH_GRAMMAR
        },
        "vendorCustomField": {"keep": "demo-patch"}
    });
    let functions_declaration = json!({
        "type": "namespace",
        "name": "functions",
        "description": "",
        "vendorContainerField": {"keep": "functions-container"},
        "tools": [functions_exec.clone(), functions_patch.clone()]
    });
    let demo_declaration = json!({
        "type": "namespace",
        "name": "mcp__demo__",
        "description": "Demo namespace tools.",
        "vendorContainerField": {"keep": "demo-container"},
        "tools": [demo_exec.clone(), demo_patch.clone()]
    });
    let functions_exec_result = "functions exec result\nREQ02_FUNCTIONS_EXEC_RESULT_TAIL";
    let functions_patch_result = "functions patch result\nREQ02_FUNCTIONS_PATCH_RESULT_TAIL";
    let demo_exec_result = "demo exec result\nREQ02_DEMO_EXEC_RESULT_TAIL";
    let demo_patch_result = "demo patch result\nREQ02_DEMO_PATCH_RESULT_TAIL";
    let raw = json!({
        "model": "gpt-5.6-sol",
        "tools": [functions_declaration.clone(), demo_declaration.clone()],
        "input": [
            {
                "type": "function_call",
                "call_id": "call_req02_nested_functions_exec",
                "namespace": functions_namespace,
                "name": "exec_command",
                "arguments": shared_arguments
            },
            {
                "type": "custom_tool_call",
                "call_id": "call_req02_nested_functions_patch",
                "namespace": functions_namespace,
                "name": "apply_patch",
                "input": shared_patch
            },
            {
                "type": "function_call",
                "call_id": "call_req02_nested_demo_exec",
                "namespace": demo_namespace,
                "name": "exec_command",
                "arguments": shared_arguments
            },
            {
                "type": "custom_tool_call",
                "call_id": "call_req02_nested_demo_patch",
                "namespace": demo_namespace,
                "name": "apply_patch",
                "input": shared_patch
            },
            {
                "type": "function_call_output",
                "call_id": "call_req02_nested_functions_exec",
                "output": functions_exec_result
            },
            {
                "type": "custom_tool_call_output",
                "call_id": "call_req02_nested_functions_patch",
                "output": functions_patch_result
            },
            {
                "type": "function_call_output",
                "call_id": "call_req02_nested_demo_exec",
                "output": demo_exec_result
            },
            {
                "type": "custom_tool_call_output",
                "call_id": "call_req02_nested_demo_patch",
                "output": demo_patch_result
            }
        ]
    });

    let (_handle, canonical, pair) =
        normalize_raw("responses", "req02-nested-declarations", raw.clone());

    assert_eq!(
        canonical["tools"], raw["tools"],
        "namespace containers and their original tools list must remain byte-equivalent"
    );
    assert_eq!(
        canonical["messages"][0]["tool_calls"][0]["function"]["arguments"],
        Value::String(shared_arguments.clone())
    );
    assert_eq!(
        canonical["messages"][1]["tool_calls"][0]["custom"]["input"],
        Value::String(shared_patch.to_string())
    );
    assert_eq!(
        canonical["messages"][2]["tool_calls"][0]["function"]["arguments"],
        Value::String(shared_arguments.clone())
    );
    assert_eq!(
        canonical["messages"][3]["tool_calls"][0]["custom"]["input"],
        Value::String(shared_patch.to_string())
    );

    let functions_record_id = assert_declaration(
        &pair,
        &canonical,
        "request.tools[0]",
        "namespace",
        "functions",
        None,
        &functions_declaration,
    );
    let demo_record_id = assert_declaration(
        &pair,
        &canonical,
        "request.tools[1]",
        "namespace",
        "mcp__demo__",
        None,
        &demo_declaration,
    );
    assert_ne!(functions_record_id, demo_record_id);

    let functions_exec_record_id = assert_declaration(
        &pair,
        &canonical,
        "request.tools[0].tools[0]",
        "function",
        "exec_command",
        Some(&functions_namespace),
        &functions_exec,
    );
    let functions_patch_record_id = assert_declaration(
        &pair,
        &canonical,
        "request.tools[0].tools[1]",
        "custom",
        "apply_patch",
        Some(&functions_namespace),
        &functions_patch,
    );
    let demo_exec_record_id = assert_declaration(
        &pair,
        &canonical,
        "request.tools[1].tools[0]",
        "function",
        "exec_command",
        Some(&demo_namespace),
        &demo_exec,
    );
    let demo_patch_record_id = assert_declaration(
        &pair,
        &canonical,
        "request.tools[1].tools[1]",
        "custom",
        "apply_patch",
        Some(&demo_namespace),
        &demo_patch,
    );
    assert_ne!(functions_exec_record_id, demo_exec_record_id);
    assert_ne!(functions_patch_record_id, demo_patch_record_id);
    assert_ne!(
        opaque_record_by_id(&canonical, &functions_exec_record_id)["value"]["parameters"],
        opaque_record_by_id(&canonical, &demo_exec_record_id)["value"]["parameters"]
    );
    assert_eq!(
        opaque_record_by_id(&canonical, &functions_exec_record_id)["value"]["vendorFunctionField"],
        json!({"keep": "functions-exec"})
    );
    assert_eq!(
        opaque_record_by_id(&canonical, &functions_patch_record_id)["value"]["vendorCustomField"],
        json!({"keep": "functions-patch"})
    );

    assert_history(
        &pair,
        "request.input[0]",
        "call_req02_nested_functions_exec",
        Some("exec_command"),
        "function",
        Some(&functions_namespace),
    );
    assert_history(
        &pair,
        "request.input[1]",
        "call_req02_nested_functions_patch",
        Some("apply_patch"),
        "custom",
        Some(&functions_namespace),
    );
    assert_history(
        &pair,
        "request.input[2]",
        "call_req02_nested_demo_exec",
        Some("exec_command"),
        "function",
        Some(&demo_namespace),
    );
    assert_history(
        &pair,
        "request.input[3]",
        "call_req02_nested_demo_patch",
        Some("apply_patch"),
        "custom",
        Some(&demo_namespace),
    );
    assert_history(
        &pair,
        "request.input[4]",
        "call_req02_nested_functions_exec",
        None,
        "function_call_output",
        None,
    );
    assert_history(
        &pair,
        "request.input[5]",
        "call_req02_nested_functions_patch",
        None,
        "custom_tool_call_output",
        None,
    );
    assert_history(
        &pair,
        "request.input[6]",
        "call_req02_nested_demo_exec",
        None,
        "function_call_output",
        None,
    );
    assert_history(
        &pair,
        "request.input[7]",
        "call_req02_nested_demo_patch",
        None,
        "custom_tool_call_output",
        None,
    );
}

#[test]
fn responses_namespace_unknown_children_and_siblings_remain_opaque() {
    let known = json!({
        "type": "function",
        "name": "known",
        "parameters": {"type": "object"},
        "unknownChildSibling": {"keep": "child"}
    });
    let unknown = json!({
        "type": "future_tool",
        "name": "future",
        "parameters": {"type": "object"},
        "unknown": {"keep": "future"}
    });
    let container = json!({
        "type": "namespace",
        "name": "mixed",
        "vendorContainerSibling": {"keep": "container"},
        "tools": [known.clone(), unknown.clone(), "free-text"]
    });
    let raw = json!({
        "model": "responses-model",
        "tools": [container.clone()],
        "input": []
    });

    let (_handle, canonical, pair) =
        normalize_raw("responses", "req02-nested-unknowns", raw.clone());

    assert_eq!(
        canonical["tools"], raw["tools"],
        "unknown children and siblings must remain in the original business list"
    );
    assert_eq!(
        pair.inverse_context.tool_declarations.len(),
        2,
        "only the namespace container and its known function child may become typed declarations"
    );
    let namespace = json!("mixed");
    let container_record_id = assert_declaration(
        &pair,
        &canonical,
        "request.tools[0]",
        "namespace",
        "mixed",
        None,
        &container,
    );
    assert_eq!(
        opaque_record_by_id(&canonical, &container_record_id)["value"]["vendorContainerSibling"],
        json!({"keep": "container"})
    );
    let known_record_id = assert_declaration(
        &pair,
        &canonical,
        "request.tools[0].tools[0]",
        "function",
        "known",
        Some(&namespace),
        &known,
    );
    assert_eq!(
        opaque_record_by_id(&canonical, &known_record_id)["value"]["unknownChildSibling"],
        json!({"keep": "child"})
    );
    assert!(pair
        .inverse_context
        .tool_declarations
        .iter()
        .all(|declaration| declaration.source_path != "request.tools[0].tools[1]"));
    assert!(pair
        .inverse_context
        .tool_declarations
        .iter()
        .all(|declaration| declaration.source_path != "request.tools[0].tools[2]"));
}

#[test]
fn responses_namespace_children_require_explicit_known_type_and_preserve_name_presence() {
    let explicit_function = json!({
        "type": "function",
        "name": "explicit_function",
        "description": "Explicit function child.",
        "parameters": {
            "type": "object",
            "properties": {
                "value": {"type": "string"}
            },
            "required": ["value"],
            "additionalProperties": false
        },
        "vendorFunctionSibling": {"keep": "explicit-function"}
    });
    let explicit_custom = json!({
        "type": "custom",
        "name": "explicit_custom",
        "description": "Explicit custom child.",
        "format": {
            "type": "grammar",
            "syntax": "lark",
            "definition": "start: /.+/"
        },
        "vendorCustomSibling": {"keep": "explicit-custom"}
    });
    let missing_type = json!({
        "name": "missing_type",
        "description": "Missing type must remain an unknown business object.",
        "parameters": {"type": "object"},
        "vendorMissingSibling": {"keep": "missing-type"}
    });
    let null_type = json!({
        "type": null,
        "name": "null_type",
        "description": "Null type must remain an unknown business object.",
        "parameters": {"type": "object"},
        "vendorNullSibling": {"keep": "null-type"}
    });
    let unknown_type = json!({
        "type": "future_tool",
        "name": "future_tool",
        "description": "Unknown type must remain an unknown business object.",
        "parameters": {"type": "object"},
        "vendorUnknownSibling": {"keep": "unknown-type"}
    });
    let children = vec![
        explicit_function.clone(),
        explicit_custom.clone(),
        missing_type.clone(),
        null_type.clone(),
        unknown_type.clone(),
    ];
    let absent_container = json!({
        "type": "namespace",
        "description": "Namespace without a name.",
        "vendorContainerSibling": {"keep": "absent"},
        "tools": children.clone()
    });
    let null_container = json!({
        "type": "namespace",
        "name": null,
        "description": "Namespace with an explicit null name.",
        "vendorContainerSibling": {"keep": "null"},
        "tools": children.clone()
    });
    let string_container = json!({
        "type": "namespace",
        "name": "mixed",
        "description": "Namespace with a string name.",
        "vendorContainerSibling": {"keep": "string"},
        "tools": children.clone()
    });
    let raw = json!({
        "model": "responses-model",
        "tools": [
            absent_container.clone(),
            null_container.clone(),
            string_container.clone()
        ],
        "input": []
    });

    let (_handle, canonical, pair) =
        normalize_raw("responses", "req02-nested-explicit-kind", raw.clone());

    assert_eq!(
        canonical["tools"], raw["tools"],
        "all namespace children, values, and siblings must remain in the original business list"
    );
    for declaration in &pair.inverse_context.tool_declarations {
        let ToolDeclarationReference {
            record_id: _,
            source_path: _,
            kind: _,
            name: _,
            namespace: _,
            encoding: _,
        } = declaration;
    }

    let absent_declaration = declaration_by_source(&pair, "request.tools[0]");
    assert_eq!(absent_declaration.kind, "namespace");
    assert_eq!(absent_declaration.name.as_deref(), None);
    assert_eq!(absent_declaration.namespace.as_ref(), None);
    assert_eq!(
        opaque_record_by_id(&canonical, &absent_declaration.record_id)["value"],
        raw["tools"][0],
        "the absent-name container opaque record must preserve the exact original object"
    );

    let null_declaration = declaration_by_source(&pair, "request.tools[1]");
    assert_eq!(null_declaration.kind, "namespace");
    assert_eq!(null_declaration.name.as_deref(), None);
    assert_eq!(null_declaration.namespace.as_ref(), None);
    assert_eq!(
        opaque_record_by_id(&canonical, &null_declaration.record_id)["value"],
        raw["tools"][1],
        "the null-name container opaque record must preserve the exact original object"
    );

    let string_declaration = declaration_by_source(&pair, "request.tools[2]");
    assert_eq!(string_declaration.kind, "namespace");
    assert_eq!(string_declaration.name.as_deref(), Some("mixed"));
    assert_eq!(string_declaration.namespace.as_ref(), None);
    assert_eq!(
        opaque_record_by_id(&canonical, &string_declaration.record_id)["value"],
        raw["tools"][2],
        "the string-name container opaque record must preserve the exact original object"
    );

    let absent_function_record_id = assert_declaration(
        &pair,
        &canonical,
        "request.tools[0].tools[0]",
        "function",
        "explicit_function",
        None,
        &explicit_function,
    );
    let absent_custom_record_id = assert_declaration(
        &pair,
        &canonical,
        "request.tools[0].tools[1]",
        "custom",
        "explicit_custom",
        None,
        &explicit_custom,
    );
    assert_ne!(absent_function_record_id, absent_custom_record_id);

    let null_namespace = Value::Null;
    assert_declaration(
        &pair,
        &canonical,
        "request.tools[1].tools[0]",
        "function",
        "explicit_function",
        Some(&null_namespace),
        &explicit_function,
    );
    assert_declaration(
        &pair,
        &canonical,
        "request.tools[1].tools[1]",
        "custom",
        "explicit_custom",
        Some(&null_namespace),
        &explicit_custom,
    );

    let mixed_namespace = json!("mixed");
    assert_declaration(
        &pair,
        &canonical,
        "request.tools[2].tools[0]",
        "function",
        "explicit_function",
        Some(&mixed_namespace),
        &explicit_function,
    );
    assert_declaration(
        &pair,
        &canonical,
        "request.tools[2].tools[1]",
        "custom",
        "explicit_custom",
        Some(&mixed_namespace),
        &explicit_custom,
    );

    for path in [
        "request.tools[0].tools[2]",
        "request.tools[0].tools[3]",
        "request.tools[0].tools[4]",
        "request.tools[1].tools[2]",
        "request.tools[1].tools[3]",
        "request.tools[1].tools[4]",
        "request.tools[2].tools[2]",
        "request.tools[2].tools[3]",
        "request.tools[2].tools[4]",
    ] {
        assert!(
            pair.inverse_context
                .tool_declarations
                .iter()
                .all(|declaration| declaration.source_path != path),
            "missing, null, or unknown child type must not create a typed declaration at {path}"
        );
    }

    assert_eq!(
        pair.inverse_context.tool_declarations.len(),
        9,
        "only namespace containers and explicitly typed function/custom children may be typed"
    );
}

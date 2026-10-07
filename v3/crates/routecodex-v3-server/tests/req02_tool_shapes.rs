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
    println!(
        "REQ02_INPUT_JSON request_id={request_id} payload={}",
        serde_json::to_string(&raw).expect("test input must serialize")
    );
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
    if let Some(namespace) = namespace {
        assert_eq!(
            declaration.namespace.as_ref(),
            Some(namespace),
            "declaration namespace at {source_path}"
        );
    }
    assert_eq!(
        declaration.encoding, "json",
        "declaration encoding at {source_path}"
    );
    let record = opaque_record_by_id(canonical, &declaration.record_id);
    assert_eq!(record["path"], source_path);
    assert_eq!(
        record["value"], *expected_value,
        "opaque declaration value at {source_path}"
    );
    declaration.record_id.clone()
}

fn assert_history(
    pair: &RequestScopedContextPair,
    source_path: &str,
    call_id: Option<&str>,
    name: Option<&str>,
    kind: &str,
    namespace: Option<&Value>,
    encoding: &str,
) {
    let history = history_by_source(pair, source_path);
    assert_eq!(
        history.call_id.as_deref(),
        call_id,
        "history call id at {source_path}"
    );
    assert_eq!(
        history.name.as_deref(),
        name,
        "history name at {source_path}"
    );
    assert_eq!(history.kind, kind, "history kind at {source_path}");
    if let Some(namespace) = namespace {
        assert_eq!(
            history.namespace.as_ref(),
            Some(namespace),
            "history namespace at {source_path}"
        );
    }
    assert_eq!(
        history.encoding, encoding,
        "history encoding at {source_path}"
    );
}

fn assert_namespace_absent(namespace: Option<&Value>, source_path: &str) {
    assert!(
        namespace.is_none(),
        "namespace at {source_path} must be absent, got {namespace:?}"
    );
}

fn assert_call_output_pair(
    pair: &RequestScopedContextPair,
    call_source_path: &str,
    output_source_path: &str,
) {
    let call = history_by_source(pair, call_source_path);
    let output = history_by_source(pair, output_source_path);
    assert!(
        call.call_id.is_some(),
        "call id must be present at {call_source_path}"
    );
    assert_eq!(
        call.call_id, output.call_id,
        "call and output must pair by call_id"
    );
}

#[test]
fn responses_gpt_5_5_flat_custom_apply_patch_preserves_raw_multiline_input_and_pairs_output() {
    let patch = "*** Begin Patch\n*** Update File: src/lib.rs\n@@\n-old_value\n+new_value\n+// REQ02_APPLY_PATCH_TAIL_SENTINEL\n*** End Patch\n";
    let apply_patch_tool = json!({
        "type": "custom",
        "name": "apply_patch",
        "description": "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
        "format": {
            "type": "grammar",
            "syntax": "lark",
            "definition": APPLY_PATCH_GRAMMAR
        }
    });
    let patch_output = "Success. Updated the following files:\nM src/lib.rs\nREQ02_APPLY_PATCH_OUTPUT_TAIL_SENTINEL";
    let raw = json!({
        "model": "gpt-5.5",
        "tools": [apply_patch_tool.clone()],
        "input": [
            {
                "type": "custom_tool_call",
                "call_id": "call_req02_apply_patch",
                "name": "apply_patch",
                "input": patch
            },
            {
                "type": "custom_tool_call_output",
                "call_id": "call_req02_apply_patch",
                "output": patch_output
            }
        ]
    });

    let (_handle, canonical, pair) = normalize_raw("responses", "req02-gpt55-apply-patch", raw);

    let custom_input = &canonical["messages"][0]["tool_calls"][0]["custom"]["input"];
    assert!(
        custom_input.is_string(),
        "custom input must remain a raw string"
    );
    assert_eq!(custom_input, &Value::String(patch.to_string()));
    assert!(
        custom_input
            .as_str()
            .unwrap()
            .contains("REQ02_APPLY_PATCH_TAIL_SENTINEL"),
        "the complete multiline patch must retain its tail sentinel"
    );
    assert_eq!(
        canonical["messages"][1]["tool_call_id"],
        "call_req02_apply_patch"
    );
    assert_eq!(
        canonical["messages"][1]["content"],
        Value::String(patch_output.to_string())
    );

    assert_declaration(
        &pair,
        &canonical,
        "request.tools[0]",
        "custom",
        "apply_patch",
        None,
        &apply_patch_tool,
    );
    assert_namespace_absent(
        declaration_by_source(&pair, "request.tools[0]")
            .namespace
            .as_ref(),
        "request.tools[0]",
    );
    assert_history(
        &pair,
        "request.input[0]",
        Some("call_req02_apply_patch"),
        Some("apply_patch"),
        "custom",
        None,
        "string",
    );
    assert_namespace_absent(
        history_by_source(&pair, "request.input[0]")
            .namespace
            .as_ref(),
        "request.input[0]",
    );
    assert_history(
        &pair,
        "request.input[1]",
        Some("call_req02_apply_patch"),
        None,
        "custom_tool_call_output",
        None,
        "string",
    );
    assert_call_output_pair(&pair, "request.input[0]", "request.input[1]");
}

#[test]
fn responses_gpt_5_5_flat_exec_command_preserves_exact_long_arguments_and_result_pairing() {
    let long_cmd = format!(
        "set -eu\nprintf '%s\\n' '{}{}'\npwd",
        "x".repeat(70_000),
        "REQ02_EXEC_COMMAND_TAIL_SENTINEL"
    );
    let long_workdir = format!("/workspace/{}/routecodex", "d".repeat(4_096));
    let arguments = json!({
        "cmd": long_cmd,
        "workdir": long_workdir,
        "yield_time_ms": 1000,
        "max_output_tokens": 4096
    })
    .to_string();
    let exec_command_tool = json!({
        "type": "function",
        "name": "exec_command",
        "description": "Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
        "strict": false,
        "parameters": {
            "type": "object",
            "properties": {
                "cmd": {"type": "string", "description": "Shell command to execute."},
                "workdir": {"type": "string", "description": "Working directory for the command. Defaults to the turn cwd."},
                "yield_time_ms": {"type": "number", "description": "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms."},
                "max_output_tokens": {"type": "number", "description": "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy."}
            },
            "required": ["cmd"],
            "additionalProperties": false
        }
    });
    let result = format!(
        "exit_code=0\n{}\nREQ02_EXEC_COMMAND_RESULT_TAIL_SENTINEL",
        "y".repeat(8_192)
    );
    let raw = json!({
        "model": "gpt-5.5",
        "tools": [exec_command_tool.clone()],
        "input": [
            {
                "type": "function_call",
                "call_id": "call_req02_exec_command",
                "name": "exec_command",
                "arguments": arguments
            },
            {
                "type": "function_call_output",
                "call_id": "call_req02_exec_command",
                "output": result
            }
        ]
    });

    let (_handle, canonical, pair) = normalize_raw("responses", "req02-gpt55-exec-command", raw);

    let canonical_arguments = &canonical["messages"][0]["tool_calls"][0]["function"]["arguments"];
    assert_eq!(canonical_arguments, &Value::String(arguments.clone()));
    assert_eq!(
        canonical_arguments.as_str().unwrap(),
        arguments,
        "function arguments must remain byte-for-byte equivalent"
    );
    assert!(canonical_arguments
        .as_str()
        .unwrap()
        .contains("REQ02_EXEC_COMMAND_TAIL_SENTINEL"));
    assert!(
        canonical_arguments.as_str().unwrap().len() > 70_000,
        "the complete long command must not be truncated"
    );
    assert_eq!(
        canonical["messages"][1]["tool_call_id"],
        "call_req02_exec_command"
    );
    assert_eq!(canonical["messages"][1]["content"], Value::String(result));

    assert_declaration(
        &pair,
        &canonical,
        "request.tools[0]",
        "function",
        "exec_command",
        None,
        &exec_command_tool,
    );
    assert_namespace_absent(
        declaration_by_source(&pair, "request.tools[0]")
            .namespace
            .as_ref(),
        "request.tools[0]",
    );
    assert_history(
        &pair,
        "request.input[0]",
        Some("call_req02_exec_command"),
        Some("exec_command"),
        "function",
        None,
        "string",
    );
    assert_namespace_absent(
        history_by_source(&pair, "request.input[0]")
            .namespace
            .as_ref(),
        "request.input[0]",
    );
    assert_history(
        &pair,
        "request.input[1]",
        Some("call_req02_exec_command"),
        None,
        "function_call_output",
        None,
        "string",
    );
    assert_call_output_pair(&pair, "request.input[0]", "request.input[1]");
}

#[test]
fn responses_gpt_5_5_flat_mcp_preserves_nested_business_values_and_history_identity() {
    let namespace = json!("mcp__mcpx.workspace");
    let mcp_arguments_value = json!({
        "path": "docs/architecture/v3-function-map.yml",
        "filters": {
            "labels": ["required", "runtime"],
            "nested": {"keep": [1, null, true, {"value": "opaque"}]}
        },
        "cursor": null
    });
    let mcp_arguments = mcp_arguments_value.to_string();
    let mcp_result = json!({
        "content": [{"type": "text", "text": "function-map contents"}],
        "structuredContent": {
            "resource": "v3-function-map",
            "values": [1, null, {"nested": ["keep", true]}]
        },
        "isError": false
    });
    let mcp_tool = json!({
        "type": "function",
        "namespace": namespace,
        "name": "workspace_read",
        "description": "Read a workspace resource.",
        "strict": false,
        "parameters": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "filters": {"type": "object"},
                "cursor": {"type": ["string", "null"]}
            },
            "required": ["path"],
            "additionalProperties": false
        }
    });
    let raw = json!({
        "model": "gpt-5.5",
        "tools": [mcp_tool.clone()],
        "input": [
            {
                "type": "function_call",
                "call_id": "call_req02_mcp_read",
                "namespace": namespace,
                "name": "workspace_read",
                "arguments": mcp_arguments
            },
            {
                "type": "function_call_output",
                "call_id": "call_req02_mcp_read",
                "output": mcp_result.clone()
            }
        ]
    });

    let (_handle, canonical, pair) = normalize_raw("responses", "req02-gpt55-mcp", raw);

    assert_eq!(
        canonical["messages"][0]["tool_calls"][0]["function"]["name"],
        "mcp__mcpx.workspace__workspace_read"
    );
    assert_eq!(
        canonical["messages"][0]["tool_calls"][0]["function"]["arguments"],
        Value::String(mcp_arguments.clone())
    );
    assert_eq!(
        canonical["messages"][1]["tool_call_id"],
        "call_req02_mcp_read"
    );
    assert_eq!(canonical["messages"][1]["content"], mcp_result);

    assert_declaration(
        &pair,
        &canonical,
        "request.tools[0]",
        "function",
        "workspace_read",
        Some(&namespace),
        &mcp_tool,
    );
    assert_history(
        &pair,
        "request.input[0]",
        Some("call_req02_mcp_read"),
        Some("workspace_read"),
        "function",
        Some(&namespace),
        "string",
    );
    assert_history(
        &pair,
        "request.input[1]",
        Some("call_req02_mcp_read"),
        None,
        "function_call_output",
        None,
        "json-object",
    );
    assert_call_output_pair(&pair, "request.input[0]", "request.input[1]");
}

#[test]
fn responses_gpt_5_6_namespace_mixed_tools_preserve_nested_identity_schema_and_history() {
    let functions_namespace = json!("functions");
    let demo_namespace = json!("mcp__demo__");
    let shared_arguments = json!({
        "cmd": "printf '%s\\n' 'REQ02_NAMESPACE_IDENTITY_SENTINEL'",
        "workdir": "/workspace/routecodex",
        "yield_time_ms": 1000
    })
    .to_string();
    let shared_patch = "*** Begin Patch\n*** Update File: src/shared.rs\n@@\n-old\n+new\n+// REQ02_NAMESPACE_PATCH_TAIL_SENTINEL\n*** End Patch\n";
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
        }
    });
    let functions_patch = json!({
        "type": "custom",
        "name": "apply_patch",
        "description": "Functions namespace apply patch.",
        "format": {
            "type": "grammar",
            "syntax": "lark",
            "definition": APPLY_PATCH_GRAMMAR
        }
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
        }
    });
    let demo_patch = json!({
        "type": "custom",
        "name": "apply_patch",
        "description": "Demo namespace apply patch.",
        "format": {
            "type": "grammar",
            "syntax": "lark",
            "definition": APPLY_PATCH_GRAMMAR
        }
    });
    let functions_declaration = json!({
        "type": "namespace",
        "name": "functions",
        "description": "",
        "tools": [functions_exec.clone(), functions_patch.clone()]
    });
    let demo_declaration = json!({
        "type": "namespace",
        "name": "mcp__demo__",
        "description": "Demo namespace tools.",
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
                "call_id": "call_req02_functions_exec",
                "namespace": functions_namespace,
                "name": "exec_command",
                "arguments": shared_arguments
            },
            {
                "type": "custom_tool_call",
                "call_id": "call_req02_functions_patch",
                "namespace": functions_namespace,
                "name": "apply_patch",
                "input": shared_patch
            },
            {
                "type": "function_call",
                "call_id": "call_req02_demo_exec",
                "namespace": demo_namespace,
                "name": "exec_command",
                "arguments": shared_arguments
            },
            {
                "type": "custom_tool_call",
                "call_id": "call_req02_demo_patch",
                "namespace": demo_namespace,
                "name": "apply_patch",
                "input": shared_patch
            },
            {
                "type": "function_call_output",
                "call_id": "call_req02_functions_exec",
                "output": functions_exec_result
            },
            {
                "type": "custom_tool_call_output",
                "call_id": "call_req02_functions_patch",
                "output": functions_patch_result
            },
            {
                "type": "function_call_output",
                "call_id": "call_req02_demo_exec",
                "output": demo_exec_result
            },
            {
                "type": "custom_tool_call_output",
                "call_id": "call_req02_demo_patch",
                "output": demo_patch_result
            }
        ]
    });

    let (_handle, canonical, pair) = normalize_raw("responses", "req02-gpt56-namespace-tools", raw);

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
        opaque_record_by_id(&canonical, &demo_exec_record_id)["value"]["parameters"],
        "same-named tools in different namespaces must retain different schemas"
    );

    assert_history(
        &pair,
        "request.input[0]",
        Some("call_req02_functions_exec"),
        Some("exec_command"),
        "function",
        Some(&functions_namespace),
        "string",
    );
    assert_history(
        &pair,
        "request.input[1]",
        Some("call_req02_functions_patch"),
        Some("apply_patch"),
        "custom",
        Some(&functions_namespace),
        "string",
    );
    assert_history(
        &pair,
        "request.input[2]",
        Some("call_req02_demo_exec"),
        Some("exec_command"),
        "function",
        Some(&demo_namespace),
        "string",
    );
    assert_history(
        &pair,
        "request.input[3]",
        Some("call_req02_demo_patch"),
        Some("apply_patch"),
        "custom",
        Some(&demo_namespace),
        "string",
    );
    assert_history(
        &pair,
        "request.input[4]",
        Some("call_req02_functions_exec"),
        None,
        "function_call_output",
        None,
        "string",
    );
    assert_history(
        &pair,
        "request.input[5]",
        Some("call_req02_functions_patch"),
        None,
        "custom_tool_call_output",
        None,
        "string",
    );
    assert_history(
        &pair,
        "request.input[6]",
        Some("call_req02_demo_exec"),
        None,
        "function_call_output",
        None,
        "string",
    );
    assert_history(
        &pair,
        "request.input[7]",
        Some("call_req02_demo_patch"),
        None,
        "custom_tool_call_output",
        None,
        "string",
    );
    assert_call_output_pair(&pair, "request.input[0]", "request.input[4]");
    assert_call_output_pair(&pair, "request.input[1]", "request.input[5]");
    assert_call_output_pair(&pair, "request.input[2]", "request.input[6]");
    assert_call_output_pair(&pair, "request.input[3]", "request.input[7]");
}

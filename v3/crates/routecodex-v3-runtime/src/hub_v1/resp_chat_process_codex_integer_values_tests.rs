use super::*;
use serde_json::{json, Value};

#[test]
fn resp03_restores_registered_codex_integer_argument_values() {
    let request = json!({"tools": [{
        "type": "function", "name": "exec_command", "strict": false,
        "description": "Runs a command in a PTY, returning output or a session ID.",
        "parameters": {"type": "object", "additionalProperties": false,
            "properties": {
                "cmd": {"type": "string"}, "justification": {"type": "string"},
                "login": {"type": "boolean"}, "max_output_tokens": {"type": "integer"},
                "prefix_rule": {"type": "array", "items": {"type": "string"}},
                "sandbox_permissions": {"type": "string", "enum": ["use_default", "require_escalated"]},
                "shell": {"type": "string"}, "tty": {"type": "boolean"},
                "workdir": {"type": "string"}, "yield_time_ms": {"type": "integer"}
            }, "required": ["cmd"]}
    }]});
    let mut response = json!({"output": [{"type": "function_call", "name": "exec_command",
        "arguments": "{\"cmd\":\"pwd\",\"max_output_tokens\":8000.0,\"yield_time_ms\":20000.0}"}]});
    normalize_v3_codex_integer_tool_values_at_resp03(&request, &mut response);
    let arguments: Value =
        serde_json::from_str(response["output"][0]["arguments"].as_str().unwrap()).unwrap();
    assert!(arguments["max_output_tokens"].as_u64().is_some());
    assert!(arguments["yield_time_ms"].as_u64().is_some());

    let mut fractional = json!({"output": [{"type": "function_call", "name": "exec_command",
        "arguments": "{\"cmd\":\"pwd\",\"max_output_tokens\":8000.5}"}]});
    normalize_v3_codex_integer_tool_values_at_resp03(&request, &mut fractional);
    assert_eq!(
        fractional["output"][0]["arguments"],
        "{\"cmd\":\"pwd\",\"max_output_tokens\":8000.5}"
    );

    let mut unrelated = json!({"output": [{"type": "function_call", "name": "other_tool",
        "arguments": "{\"max_output_tokens\":8000.0}"}]});
    normalize_v3_codex_integer_tool_values_at_resp03(&request, &mut unrelated);
    assert_eq!(
        unrelated["output"][0]["arguments"],
        "{\"max_output_tokens\":8000.0}"
    );

    let mut duplicate = json!({"output": [{"type": "function_call", "name": "exec_command",
        "arguments": "{\"max_output_tokens\":8000.0,\"max_output_tokens\":9000.0}"}]});
    normalize_v3_codex_integer_tool_values_at_resp03(&request, &mut duplicate);
    assert_eq!(
        duplicate["output"][0]["arguments"],
        "{\"max_output_tokens\":8000.0,\"max_output_tokens\":9000.0}"
    );

    for unsafe_extra in [
        "{\"cmd\":\"pwd\",\"max_output_tokens\":8000.0,\"extra\":{\"key\":1,\"key\":2}}",
        "{\"cmd\":\"pwd\",\"max_output_tokens\":8000.0,\"extra\":9007199254740993.0}",
    ] {
        let mut response = json!({"output": [{"type": "function_call", "name": "exec_command",
            "arguments": unsafe_extra}]});
        normalize_v3_codex_integer_tool_values_at_resp03(&request, &mut response);
        assert_eq!(response["output"][0]["arguments"], unsafe_extra);
    }

    let mut wrong_schema = request.clone();
    wrong_schema["tools"][0]["description"] = json!("User-defined shell tool");
    let mut user_result = response.clone();
    user_result["output"][0]["arguments"] = json!("{\"max_output_tokens\":8000.0}");
    normalize_v3_codex_integer_tool_values_at_resp03(&wrong_schema, &mut user_result);
    assert_eq!(
        user_result["output"][0]["arguments"],
        "{\"max_output_tokens\":8000.0}"
    );
}

#[test]
fn resp03_restores_registered_write_stdin_integer_values_only() {
    let request = json!({"tools": [{
        "type": "function", "name": "write_stdin", "strict": false,
        "description": "Writes characters to an existing unified exec session and returns recent output.",
        "parameters": {"type": "object", "additionalProperties": false,
            "properties": {
                "chars": {"type": "string"}, "max_output_tokens": {"type": "integer"},
                "session_id": {"type": "integer"}, "yield_time_ms": {"type": "integer"}
            }, "required": ["session_id"]}
    }]});
    let mut response = json!({"output": [{"type": "function_call", "name": "write_stdin",
        "arguments": "{\"session_id\":123.0,\"yield_time_ms\":5000.0,\"max_output_tokens\":2000.0,\"chars\":\"\"}"}]});
    normalize_v3_codex_integer_tool_values_at_resp03(&request, &mut response);
    let arguments: Value =
        serde_json::from_str(response["output"][0]["arguments"].as_str().unwrap()).unwrap();
    for field in ["session_id", "yield_time_ms", "max_output_tokens"] {
        assert!(arguments[field].as_u64().is_some(), "{field}");
    }
    assert_eq!(arguments["chars"], "");
}

use routecodex_v3_runtime::operation_runner::{
    execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, HistoryPairingReference,
    RequestInvocationContext, RequestNormalizationEntry, RequestOriginKind,
    RequestScopedContextPair, V3RequestContextHandle,
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
        .expect("public capture entry must accept the real client JSON value");
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .expect("public normalize entry must execute the real Responses history slice");
    let pair = handle
        .original_pair()
        .expect("raw client entry must publish the original typed history pair");
    (canonical, pair)
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

#[test]
fn responses_input_string_and_matching_messages_keep_one_user_history() {
    let raw = json!({
        "model": "req02-mixed-history-model",
        "input": "hi",
        "messages": [{"role": "user", "content": "hi"}]
    });

    let (canonical, pair) = normalize_responses("req02-input-string-matching-messages", raw);

    assert_eq!(pair.explicit_history_pairing.entry_protocol, "responses");
    assert!(canonical.get("input").is_none());
    assert_eq!(
        canonical["messages"],
        json!([{"role": "user", "content": "hi"}])
    );
}

#[test]
fn responses_messages_call_plus_input_output_preserve_complete_typed_history() {
    let call_id = "call_req02_exec_complete";
    let exec_arguments = format!(
        "{}{}",
        "x".repeat(70_000),
        "REQ02_EXEC_ARGUMENTS_TAIL_SENTINEL"
    );
    let exec_result = format!("first line\r\nsecond line\r\n{}", "r".repeat(4_096));
    let raw = json!({
        "model": "req02-mixed-history-model",
        "messages": [{
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "id": call_id,
                "type": "function",
                "function": {
                    "name": "exec",
                    "arguments": exec_arguments.clone()
                }
            }]
        }],
        "input": [{
            "type": "function_call_output",
            "call_id": call_id,
            "output": exec_result.clone()
        }]
    });

    let (canonical, pair) = normalize_responses("req02-messages-call-input-output", raw);

    assert_eq!(canonical["messages"].as_array().unwrap().len(), 2);
    assert_eq!(canonical["messages"][0]["role"], "assistant");
    assert_eq!(canonical["messages"][0]["tool_calls"][0]["id"], call_id);
    assert_eq!(
        canonical["messages"][0]["tool_calls"][0]["function"]["name"],
        "exec"
    );
    assert_eq!(
        canonical["messages"][0]["tool_calls"][0]["function"]["arguments"],
        Value::String(exec_arguments.clone())
    );
    assert!(
        canonical["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap()
            .ends_with("REQ02_EXEC_ARGUMENTS_TAIL_SENTINEL")
    );
    assert_eq!(canonical["messages"][1]["role"], "tool");
    assert_eq!(canonical["messages"][1]["tool_call_id"], call_id);
    assert_eq!(
        canonical["messages"][1]["content"],
        Value::String(exec_result.clone())
    );
    assert!(canonical["messages"][1]["content"]
        .as_str()
        .unwrap()
        .contains("\r\n"));

    assert_eq!(pair.explicit_history_pairing.messages.len(), 2);
    let call_history = history_by_source(&pair, "request.messages[0].tool_calls[0]");
    assert_eq!(call_history.call_id.as_deref(), Some(call_id));
    assert_eq!(call_history.name.as_deref(), Some("exec"));
    assert_eq!(call_history.kind, "function");
    assert_eq!(call_history.encoding, "string");

    let result_history = history_by_source(&pair, "request.input[0]");
    assert_eq!(result_history.call_id.as_deref(), Some(call_id));
    assert_eq!(result_history.kind, "function_call_output");
    assert_eq!(result_history.encoding, "string");
}

#[test]
fn responses_messages_result_plus_duplicate_input_output_keep_two_histories() {
    let call_id = "call_req02_duplicate_result";
    let exec_arguments = format!(
        "{}{}",
        "y".repeat(70_000),
        "REQ02_DUPLICATE_ARGUMENTS_TAIL_SENTINEL"
    );
    let exec_result = format!("cached result\r\n{}", "z".repeat(4_096));
    let raw = json!({
        "model": "req02-mixed-history-model",
        "messages": [
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": call_id,
                    "type": "function",
                    "function": {
                        "name": "exec",
                        "arguments": exec_arguments
                    }
                }]
            },
            {
                "role": "tool",
                "tool_call_id": call_id,
                "content": exec_result.clone()
            }
        ],
        "input": [{
            "type": "function_call_output",
            "call_id": call_id,
            "output": exec_result.clone()
        }]
    });

    let (canonical, pair) = normalize_responses("req02-messages-result-input-duplicate", raw);

    assert_eq!(canonical["messages"].as_array().unwrap().len(), 2);
    assert_eq!(canonical["messages"][0]["role"], "assistant");
    assert_eq!(canonical["messages"][0]["tool_calls"][0]["id"], call_id);
    assert_eq!(canonical["messages"][1]["role"], "tool");
    assert_eq!(canonical["messages"][1]["tool_call_id"], call_id);
    assert_eq!(
        canonical["messages"][1]["content"],
        Value::String(exec_result.clone())
    );
    assert_eq!(
        canonical["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| { message["role"] == "tool" && message["tool_call_id"] == call_id })
            .count(),
        1
    );

    let call_history = history_by_source(&pair, "request.messages[0].tool_calls[0]");
    assert_eq!(call_history.call_id.as_deref(), Some(call_id));
    assert_eq!(call_history.kind, "function");
    assert_eq!(call_history.encoding, "string");

    let message_result_history = history_by_source(&pair, "request.messages[1].tool_call_id");
    assert_eq!(message_result_history.call_id.as_deref(), Some(call_id));
    assert_eq!(message_result_history.kind, "tool_result");
    assert_eq!(message_result_history.encoding, "string");

    let duplicate_input_history = history_by_source(&pair, "request.input[0]");
    assert_eq!(duplicate_input_history.call_id.as_deref(), Some(call_id));
    assert_eq!(duplicate_input_history.kind, "function_call_output");
    assert_eq!(duplicate_input_history.encoding, "string");
}

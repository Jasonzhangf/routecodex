use super::harvest_tools_json;
use serde_json::{json, Value};

#[test]
fn harvest_tools_json_delta_shell() {
    let input = json!({
        "signal": {
            "type": "delta",
            "payload": {
                "choices": [
                    {
                        "delta": {
                            "content": "<function=execute><parameter=command>pwd</parameter></function=execute>"
                        }
                    }
                ]
            }
        },
        "context": {
            "requestId": "req_harvest_1",
            "idPrefix": "call"
        }
    })
    .to_string();

    let raw = harvest_tools_json(input).unwrap();
    let parsed: Value = serde_json::from_str(&raw).unwrap();
    let events = parsed.get("deltaEvents").and_then(Value::as_array).unwrap();
    assert!(!events.is_empty());
    let tool_calls = events[0]
        .get("tool_calls")
        .and_then(Value::as_array)
        .unwrap();
    let function = tool_calls[0]
        .get("function")
        .and_then(Value::as_object)
        .unwrap();
    assert_eq!(function.get("name").and_then(Value::as_str), Some("shell"));
}

#[test]
fn harvest_tools_json_normalizes_functions_prefix_tool_name() {
    let input = json!({
        "signal": {
            "type": "delta",
            "payload": {
                "choices": [
                    {
                        "delta": {
                            "content": "<function=functions.update_plan><parameter=plan>[]</parameter></function=functions.update_plan>"
                        }
                    }
                ]
            }
        },
        "context": {
            "requestId": "req_harvest_2",
            "idPrefix": "call"
        }
    })
    .to_string();

    let raw = harvest_tools_json(input).unwrap();
    let parsed: Value = serde_json::from_str(&raw).unwrap();
    let events = parsed.get("deltaEvents").and_then(Value::as_array).unwrap();
    assert!(!events.is_empty());
    let tool_calls = events[0]
        .get("tool_calls")
        .and_then(Value::as_array)
        .unwrap();
    let function = tool_calls[0]
        .get("function")
        .and_then(Value::as_object)
        .unwrap();
    assert_eq!(
        function.get("name").and_then(Value::as_str),
        Some("update_plan")
    );
}

#[test]
fn harvest_tools_json_keeps_dotted_tool_name_after_functions_prefix() {
    let input = json!({
        "signal": {
            "type": "delta",
            "payload": {
                "choices": [
                    {
                        "delta": {
                            "content": "<function=functions.mailbox.status><parameter=target>\"finger-system-agent\"</parameter></function=functions.mailbox.status>"
                        }
                    }
                ]
            }
        },
        "context": {
            "requestId": "req_harvest_3",
            "idPrefix": "call"
        }
    })
    .to_string();

    let raw = harvest_tools_json(input).unwrap();
    let parsed: Value = serde_json::from_str(&raw).unwrap();
    let events = parsed.get("deltaEvents").and_then(Value::as_array).unwrap();
    assert!(!events.is_empty());
    let tool_calls = events[0]
        .get("tool_calls")
        .and_then(Value::as_array)
        .unwrap();
    let function = tool_calls[0]
        .get("function")
        .and_then(Value::as_object)
        .unwrap();
    assert_eq!(
        function.get("name").and_then(Value::as_str),
        Some("mailbox.status")
    );
}

#[test]
fn harvest_tools_json_delta_function_call_normalizes_functions_prefix() {
    let input = json!({
        "signal": {
            "type": "delta",
            "payload": {
                "choices": [
                    {
                        "delta": {
                            "function_call": {
                                "name": "functions.update_plan",
                                "arguments": { "plan": [] }
                            }
                        }
                    }
                ]
            }
        },
        "context": {
            "requestId": "req_harvest_4",
            "idPrefix": "call"
        }
    })
    .to_string();

    let raw = harvest_tools_json(input).unwrap();
    let parsed: Value = serde_json::from_str(&raw).unwrap();
    let events = parsed.get("deltaEvents").and_then(Value::as_array).unwrap();
    assert!(!events.is_empty());
    let tool_calls = events[0]
        .get("tool_calls")
        .and_then(Value::as_array)
        .unwrap();
    let function = tool_calls[0]
        .get("function")
        .and_then(Value::as_object)
        .unwrap();
    assert_eq!(
        function.get("name").and_then(Value::as_str),
        Some("update_plan")
    );
}

#[test]
fn harvest_tools_json_final_extracts_jsonish_tool_calls_from_text() {
    let input = json!({
        "signal": {
            "type": "final",
            "payload": {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "正文：{\"tool_calls\":[{\"name\":\"mailbox.status\",\"input\":{\"target\":\"finger-system-agent\"}}]}"
                        },
                        "finish_reason": "stop"
                    }
                ]
            }
        },
        "context": {
            "requestId": "req_harvest_5",
            "idPrefix": "call"
        }
    })
    .to_string();

    let raw = harvest_tools_json(input).unwrap();
    let parsed: Value = serde_json::from_str(&raw).unwrap();
    let normalized = parsed.get("normalized").cloned().unwrap_or(Value::Null);
    let choice = normalized
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|arr| arr.get(0))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    assert_eq!(
        choice.get("finish_reason").and_then(Value::as_str),
        Some("tool_calls")
    );
    let message = choice
        .get("message")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let tool_calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    assert_eq!(tool_calls.len(), 1);
    let function = tool_calls[0]
        .get("function")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    assert_eq!(
        function.get("name").and_then(Value::as_str),
        Some("mailbox.status")
    );
    let args = function
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or("{}");
    let args_json: Value = serde_json::from_str(args).unwrap_or(Value::Null);
    assert_eq!(
        args_json.get("target").and_then(Value::as_str),
        Some("finger-system-agent")
    );
}

#[test]
fn harvest_tools_json_final_extracts_rcc_fence_tool_calls_with_nested_input_name() {
    let input = json!({
        "signal": {
            "type": "final",
            "payload": {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "前言\n• <<RCC_TOOL_CALLS_JSON\n{\"tool_calls\":[{\"input\":{\"cmd\":\"pwd\",\"name\":\"exec_command\"}}]}RCC_TOOL_CALLS_JSON\n尾言"
                        },
                        "finish_reason": "stop"
                    }
                ]
            }
        },
        "context": {
            "requestId": "req_harvest_rcc_nested_name",
            "idPrefix": "call"
        }
    })
    .to_string();

    let raw = harvest_tools_json(input).unwrap();
    let parsed: Value = serde_json::from_str(&raw).unwrap();
    let normalized = parsed.get("normalized").cloned().unwrap_or(Value::Null);
    let choice = normalized
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|arr| arr.get(0))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    assert_eq!(
        choice.get("finish_reason").and_then(Value::as_str),
        Some("tool_calls")
    );
    let message = choice
        .get("message")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let tool_calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    assert_eq!(tool_calls.len(), 1);
    let function = tool_calls[0]
        .get("function")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    assert_eq!(
        function.get("name").and_then(Value::as_str),
        Some("exec_command")
    );
    let args = function
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or("{}");
    let args_json: Value = serde_json::from_str(args).unwrap_or(Value::Null);
    assert_eq!(args_json.get("cmd").and_then(Value::as_str), Some("pwd"));
    assert_eq!(message.get("content").and_then(Value::as_str), Some(""));
}

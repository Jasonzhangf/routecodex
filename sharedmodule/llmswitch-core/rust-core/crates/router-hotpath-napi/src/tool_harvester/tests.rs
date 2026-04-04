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

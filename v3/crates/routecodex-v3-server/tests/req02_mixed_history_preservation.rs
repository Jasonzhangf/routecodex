use routecodex_v3_runtime::operation_runner::{
    execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, RequestInvocationContext,
    RequestNormalizationEntry, RequestOriginKind, RequestScopedContextPair, V3RequestContextHandle,
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

fn messages(canonical: &Value) -> &Vec<Value> {
    canonical
        .get("messages")
        .and_then(Value::as_array)
        .expect("canonical response request must contain messages")
}

fn history_sources(pair: &RequestScopedContextPair) -> Vec<&str> {
    pair.explicit_history_pairing
        .messages
        .iter()
        .map(|message| message.source_path.as_str())
        .collect()
}

fn opaque_value<'a>(canonical: &'a Value, path: &str) -> Option<&'a Value> {
    canonical
        .get("routecodex_chat_extension")?
        .get("chat_extension_opaque_record")?
        .as_array()?
        .iter()
        .find(|record| record.get("path").and_then(Value::as_str) == Some(path))?
        .get("value")
}

#[test]
fn same_call_id_with_distinct_complete_opaque_outputs_preserves_two_messages() {
    let call_id = "call_req02_distinct_complete_opaque_outputs";
    let first_output = json!({
        "kind": "complete",
        "representation": "first",
        "payload": {"text": "alpha", "bytes": [1, 2, 3]}
    });
    let second_output = json!({
        "kind": "complete",
        "representation": "second",
        "payload": {"text": "beta", "bytes": [4, 5, 6]}
    });
    let raw = json!({
        "model": "req02-mixed-history-model",
        "input": [
            {
                "type": "function_call_output",
                "call_id": call_id,
                "output": first_output.clone()
            },
            {
                "type": "function_call_output",
                "call_id": call_id,
                "output": second_output.clone()
            }
        ]
    });

    let (canonical, pair) = normalize_responses("req02-distinct-complete-opaque-outputs", raw);

    let messages = messages(&canonical);
    assert_eq!(messages.len(), 2, "{canonical}");
    assert_eq!(messages[0]["role"], "tool");
    assert_eq!(messages[0]["tool_call_id"], call_id);
    assert_eq!(messages[0]["content"], first_output);
    assert_eq!(messages[1]["role"], "tool");
    assert_eq!(messages[1]["tool_call_id"], call_id);
    assert_eq!(messages[1]["content"], second_output);
    assert_eq!(
        history_sources(&pair),
        vec!["request.input[0]", "request.input[1]"]
    );
    assert!(pair
        .explicit_history_pairing
        .messages
        .iter()
        .all(|history| history.call_id.as_deref() == Some(call_id)));
}

#[test]
fn different_unknown_values_across_sources_keep_two_messages_and_original_values() {
    let call_id = "call_req02_distinct_unknown_values";
    let messages_unknown = json!({
        "origin": "messages",
        "value": {"complete": true, "payload": ["messages", 1]}
    });
    let input_unknown = json!({
        "origin": "input",
        "value": {"complete": true, "payload": ["input", 2]}
    });
    let raw = json!({
        "model": "req02-mixed-history-model",
        "messages": [{
            "role": "tool",
            "tool_call_id": call_id,
            "content": "same-output",
            "req02_unknown": messages_unknown.clone()
        }],
        "input": [{
            "type": "function_call_output",
            "call_id": call_id,
            "output": "same-output",
            "req02_unknown": input_unknown.clone()
        }]
    });

    let (canonical, pair) = normalize_responses("req02-distinct-unknown-values", raw);

    let messages = messages(&canonical);
    assert_eq!(messages.len(), 2, "{canonical}");
    assert_eq!(messages[0]["req02_unknown"], messages_unknown);
    assert_eq!(
        opaque_value(&canonical, "request.input[0].req02_unknown"),
        Some(&input_unknown)
    );
    assert_eq!(
        history_sources(&pair),
        vec!["request.messages[0].tool_call_id", "request.input[0]"]
    );
}

#[test]
fn repeated_tool_results_within_secondary_source_preserve_occurrences() {
    let call_id = "call_req02_repeated_secondary_result";
    let repeated = json!({
        "type": "function_call_output",
        "call_id": call_id,
        "output": "same-result"
    });
    let raw = json!({
        "model": "req02-mixed-history-model",
        "input": [repeated.clone(), repeated]
    });

    let (canonical, pair) = normalize_responses("req02-repeated-secondary-result", raw);

    let messages = messages(&canonical);
    assert_eq!(messages.len(), 2, "{canonical}");
    assert_eq!(messages[0], messages[1]);
    assert_eq!(
        history_sources(&pair),
        vec!["request.input[0]", "request.input[1]"]
    );
    assert!(pair
        .explicit_history_pairing
        .messages
        .iter()
        .all(|history| history.call_id.as_deref() == Some(call_id)));
}

#[test]
fn partial_non_tool_overlap_across_sources_is_preserved_itemwise() {
    let raw = json!({
        "model": "req02-mixed-history-model",
        "messages": [
            {"role": "user", "content": "user A"},
            {"role": "user", "content": "user B"}
        ],
        "input": [
            {"role": "user", "content": "user A"},
            {"role": "user", "content": "user C"}
        ]
    });

    let (canonical, _pair) = normalize_responses("req02-partial-non-tool-overlap", raw);

    let messages = messages(&canonical);
    assert_eq!(messages.len(), 4, "{canonical}");
    assert_eq!(messages[0]["content"], "user A");
    assert_eq!(messages[1]["content"], "user B");
    assert_eq!(messages[2]["content"], "user A");
    assert_eq!(messages[3]["content"], "user C");
}

#[test]
fn primary_tool_result_and_repeated_secondary_results_keep_two_occurrences() {
    let call_id = "call_req02_primary_and_repeated_secondary";
    let raw = json!({
        "model": "req02-mixed-history-model",
        "messages": [{
            "role": "tool",
            "tool_call_id": call_id,
            "content": "same-result"
        }],
        "input": [
            {
                "type": "function_call_output",
                "call_id": call_id,
                "output": "same-result"
            },
            {
                "type": "function_call_output",
                "call_id": call_id,
                "output": "same-result"
            }
        ]
    });

    let (canonical, pair) = normalize_responses("req02-primary-and-repeated-secondary", raw);

    let messages = messages(&canonical);
    assert_eq!(messages.len(), 2, "{canonical}");
    assert_eq!(messages[0]["content"], "same-result");
    assert_eq!(messages[1]["content"], "same-result");

    let mut sources = history_sources(&pair);
    sources.sort_unstable();
    assert_eq!(
        sources,
        vec![
            "request.input[0]",
            "request.input[1]",
            "request.messages[0].tool_call_id"
        ]
    );
    assert!(pair
        .explicit_history_pairing
        .messages
        .iter()
        .all(|history| history.call_id.as_deref() == Some(call_id)));
}

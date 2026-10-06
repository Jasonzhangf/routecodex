use routecodex_v3_runtime::operation_runner::{
    execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, HistoryPairingReference,
    RequestInvocationContext, RequestNormalizationEntry, RequestOriginKind,
    RequestScopedContextPair, V3RequestContextHandle,
};
use serde_json::{json, Value};

const CUSTOM_CALL_ID: &str = "call_req02_r16_exec";
const FUNCTION_CALL_ID: &str = "call_req02_r16_patch";
const CUSTOM_NAME: &str = "exec";
const FUNCTION_NAME: &str = "apply_patch";
const CUSTOM_INPUT: &str = "printf 'namespace presence'\npatch <<'EOF'\nraw text\nEOF\n__REQ02_NAMESPACE_R16_EXEC_SENTINEL__\n";
const FUNCTION_ARGUMENTS: &str = "*** Begin Patch\n*** Update File: sample.txt\n*** End Patch\n__REQ02_NAMESPACE_R16_PATCH_SENTINEL__\n";

#[derive(Clone, Copy, Debug)]
enum NamespacePresence {
    Absent,
    ExplicitNull,
}

impl NamespacePresence {
    fn value(self) -> Option<Value> {
        match self {
            Self::Absent => None,
            Self::ExplicitNull => Some(Value::Null),
        }
    }
}

fn with_namespace(mut call: Value, namespace: NamespacePresence) -> Value {
    if let Some(namespace) = namespace.value() {
        call.as_object_mut()
            .expect("tool call must be an object")
            .insert("namespace".to_string(), namespace);
    }
    call
}

fn request(protocol: &str, namespace: NamespacePresence) -> Value {
    let custom_call = with_namespace(
        json!({
            "id": CUSTOM_CALL_ID,
            "type": "custom",
            "custom": {"name": CUSTOM_NAME, "input": CUSTOM_INPUT}
        }),
        namespace,
    );
    let function_call = with_namespace(
        json!({
            "id": FUNCTION_CALL_ID,
            "type": "function",
            "function": {"name": FUNCTION_NAME, "arguments": FUNCTION_ARGUMENTS}
        }),
        namespace,
    );
    json!({
        "model": format!("req02-r16-{protocol}-model"),
        "messages": [{
            "role": "assistant",
            "content": null,
            "tool_calls": [custom_call, function_call]
        }]
    })
}

fn normalize(protocol: &str, request_id: &str, raw: Value) -> (Value, RequestScopedContextPair) {
    let handle = V3RequestContextHandle::new(request_id.to_string(), protocol.to_string());
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
    .expect("public normalize entry must execute the real REQ02 SDK slice");
    let pair = handle
        .original_pair()
        .expect("raw client entry must publish the original inverse/history pair");
    (canonical, pair)
}

fn canonical_call_by_id<'a>(canonical: &'a Value, call_id: &str) -> &'a Value {
    canonical["messages"][0]["tool_calls"]
        .as_array()
        .expect("canonical history must carry tool calls")
        .iter()
        .find(|call| call["id"] == call_id)
        .unwrap_or_else(|| panic!("missing canonical tool call `{call_id}`"))
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

fn assert_public_namespace_case(protocol: &str, request_id: &str, namespace: NamespacePresence) {
    let raw = request(protocol, namespace);
    let (canonical, pair) = normalize(protocol, request_id, raw);
    let expected_namespace = namespace.value();

    let custom = canonical_call_by_id(&canonical, CUSTOM_CALL_ID);
    assert_eq!(custom["type"], "custom");
    assert_eq!(custom["custom"]["name"], CUSTOM_NAME);
    assert_eq!(custom["custom"]["input"], CUSTOM_INPUT);
    assert_eq!(
        custom.get("namespace"),
        expected_namespace.as_ref(),
        "canonical custom call namespace presence changed for {protocol}/{namespace:?}"
    );

    let function = canonical_call_by_id(&canonical, FUNCTION_CALL_ID);
    assert_eq!(function["type"], "function");
    assert_eq!(function["function"]["name"], FUNCTION_NAME);
    assert_eq!(function["function"]["arguments"], FUNCTION_ARGUMENTS);
    assert_eq!(
        function.get("namespace"),
        expected_namespace.as_ref(),
        "canonical function call namespace presence changed for {protocol}/{namespace:?}"
    );

    let custom_history = history_by_source(&pair, "request.messages[0].tool_calls[0]");
    assert_eq!(custom_history.call_id.as_deref(), Some(CUSTOM_CALL_ID));
    assert_eq!(custom_history.name.as_deref(), Some(CUSTOM_NAME));
    assert_eq!(custom_history.kind, "custom");
    assert_eq!(custom_history.encoding, "string");
    assert_eq!(
        custom_history.namespace.as_ref(),
        expected_namespace.as_ref(),
        "typed custom history namespace presence changed for {protocol}/{namespace:?}"
    );

    let function_history = history_by_source(&pair, "request.messages[0].tool_calls[1]");
    assert_eq!(function_history.call_id.as_deref(), Some(FUNCTION_CALL_ID));
    assert_eq!(function_history.name.as_deref(), Some(FUNCTION_NAME));
    assert_eq!(function_history.kind, "function");
    assert_eq!(function_history.encoding, "string");
    assert_eq!(
        function_history.namespace.as_ref(),
        expected_namespace.as_ref(),
        "typed function history namespace presence changed for {protocol}/{namespace:?}"
    );
}

#[test]
fn openai_chat_absent_tool_call_namespace_remains_absent() {
    assert_public_namespace_case(
        "openai-chat",
        "req02-r16-openai-chat-absent",
        NamespacePresence::Absent,
    );
}

#[test]
fn openai_chat_explicit_null_tool_call_namespace_remains_null() {
    assert_public_namespace_case(
        "openai-chat",
        "req02-r16-openai-chat-null",
        NamespacePresence::ExplicitNull,
    );
}

#[test]
fn responses_absent_tool_call_namespace_remains_absent() {
    assert_public_namespace_case(
        "responses",
        "req02-r16-responses-absent",
        NamespacePresence::Absent,
    );
}

#[test]
fn responses_explicit_null_tool_call_namespace_remains_null() {
    assert_public_namespace_case(
        "responses",
        "req02-r16-responses-null",
        NamespacePresence::ExplicitNull,
    );
}

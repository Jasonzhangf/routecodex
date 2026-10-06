use routecodex_v3_runtime::operation_runner::{
    execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, HistoryPairingReference,
    RequestInvocationContext, RequestNormalizationEntry, RequestOriginKind,
    RequestScopedContextPair, ToolDeclarationReference, V3RequestContextHandle,
};
use serde_json::{json, Value};

#[derive(Clone, Copy, Debug)]
enum NamespaceCase {
    Absent,
    Null,
    String,
}

impl NamespaceCase {
    fn value(self) -> Option<Value> {
        match self {
            Self::Absent => None,
            Self::Null => Some(Value::Null),
            Self::String => Some(json!("mcp.search")),
        }
    }
}

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
    (handle, canonical, pair)
}

fn opaque_record_by_id<'a>(canonical: &'a Value, record_id: &str) -> &'a Value {
    canonical["routecodex_chat_extension"]["chat_extension_opaque_record"]
        .as_array()
        .expect("canonical root must carry the opaque record array")
        .iter()
        .find(|record| record["record_id"] == record_id)
        .unwrap_or_else(|| panic!("missing opaque record id `{record_id}`"))
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

fn responses_request(namespace: NamespaceCase) -> Value {
    let mut tool = json!({
        "type": "function",
        "function": {
            "name": "lookup",
            "parameters": {"type": "object"}
        }
    });
    let mut call = json!({
        "type": "function_call",
        "call_id": "call-namespace",
        "name": "lookup",
        "arguments": "{\"q\":1}"
    });
    if let Some(namespace) = namespace.value() {
        tool.as_object_mut()
            .expect("tool must be an object")
            .insert("namespace".to_string(), namespace.clone());
        call.as_object_mut()
            .expect("call must be an object")
            .insert("namespace".to_string(), namespace);
    }
    json!({
        "model": "responses-model",
        "tools": [tool],
        "input": [call]
    })
}

#[test]
fn responses_public_typed_namespace_presence_distinguishes_absent_null_and_string() {
    for namespace in [
        NamespaceCase::Absent,
        NamespaceCase::Null,
        NamespaceCase::String,
    ] {
        let raw = responses_request(namespace);
        let (_handle, canonical, pair) =
            normalize_raw("responses", "req-namespace-responses", raw.clone());
        let expected = namespace.value();

        let declaration = declaration_by_source(&pair, "request.tools[0]");
        assert_eq!(
            declaration.namespace.as_ref(),
            expected.as_ref(),
            "declaration namespace presence changed for {namespace:?}"
        );
        assert_eq!(
            opaque_record_by_id(&canonical, &declaration.record_id)["value"],
            raw["tools"][0],
            "declaration opaque value changed for {namespace:?}"
        );

        let history = history_by_source(&pair, "request.input[0]");
        assert_eq!(
            history.namespace.as_ref(),
            expected.as_ref(),
            "history namespace presence changed for {namespace:?}"
        );
        assert_eq!(
            canonical["messages"][0]["tool_calls"][0]["function"]["arguments"], "{\"q\":1}",
            "history arguments changed for {namespace:?}"
        );
    }
}

#[test]
fn four_protocol_absent_tool_declarations_are_none_not_null() {
    let cases = [
        (
            "responses",
            json!({
                "model": "responses-model",
                "tools": [{
                    "type": "function",
                    "function": {"name": "lookup", "parameters": {"type": "object"}}
                }],
                "input": []
            }),
            "request.tools[0]",
        ),
        (
            "openai-chat",
            json!({
                "model": "chat-model",
                "messages": [],
                "tools": [{
                    "type": "function",
                    "function": {"name": "lookup", "parameters": {"type": "object"}}
                }]
            }),
            "request.tools[0]",
        ),
        (
            "anthropic",
            json!({
                "model": "claude",
                "max_tokens": 1,
                "messages": [],
                "tools": [{
                    "name": "lookup",
                    "input_schema": {"type": "object"}
                }]
            }),
            "request.tools[0]",
        ),
        (
            "gemini",
            json!({
                "model": "gemini",
                "contents": [],
                "tools": [{
                    "functionDeclarations": [{
                        "name": "lookup",
                        "parameters": {"type": "object"}
                    }]
                }]
            }),
            "request.tools[0].functionDeclarations[0]",
        ),
    ];

    for (protocol, raw, source_path) in cases {
        let (_handle, _canonical, pair) =
            normalize_raw(protocol, &format!("req-namespace-{protocol}"), raw);
        let declaration = declaration_by_source(&pair, source_path);
        assert!(
            declaration.namespace.is_none(),
            "{protocol} absent namespace must remain None, got {:?}",
            declaration.namespace
        );
    }
}

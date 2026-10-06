use routecodex_v3_runtime::operation_runner::{
    execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, RequestInvocationContext,
    RequestNormalizationEntry, RequestOriginKind, RequestScopedContextPair, V3RequestContextHandle,
};
use serde_json::{json, Value};

const MULTILINE_INSTRUCTIONS: &str =
    "You are the instruction source.\nKeep every line.\n\nIncluding this one.";

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

#[test]
fn req02_instruction_source_association_new_system_uses_emitted_index() {
    let (canonical, pair) = normalize(
        "req02-new-system",
        "responses",
        json!({
            "model": "client-model",
            "instructions": MULTILINE_INSTRUCTIONS,
            "input": "hello",
            "stream": false
        }),
    );

    assert_eq!(
        canonical["messages"],
        json!([
            {"role": "system", "content": MULTILINE_INSTRUCTIONS},
            {"role": "user", "content": "hello"}
        ])
    );
    assert_eq!(
        destinations(&pair, "request.instructions"),
        vec!["chat.messages[0].content"]
    );
}

#[test]
fn req02_instruction_source_association_existing_system_uses_nonzero_index() {
    let (canonical, pair) = normalize(
        "req02-existing-system",
        "responses",
        json!({
            "model": "client-model",
            "instructions": MULTILINE_INSTRUCTIONS,
            "input": [
                {"role": "user", "content": "hello"},
                {"role": "system", "content": "existing system message"}
            ],
            "stream": false
        }),
    );

    assert_eq!(
        canonical["messages"],
        json!([
            {"role": "user", "content": "hello"},
            {
                "role": "system",
                "content": [
                    {"type":"text","text":MULTILINE_INSTRUCTIONS},
                    {"type":"text","text":"\n"},
                    {"type":"text","text":"existing system message"}
                ]
            }
        ])
    );
    assert_eq!(
        destinations(&pair, "request.instructions"),
        vec!["chat.messages[1].content[0].text"]
    );
    assert_eq!(
        destinations(&pair, "request.input[1].content"),
        vec!["chat.messages[1].content[2].text"]
    );
    let text = canonical["messages"][1]["content"]
        .as_array()
        .unwrap()
        .iter()
        .map(|part| part["text"].as_str().unwrap())
        .collect::<String>();
    assert_eq!(
        text,
        format!("{MULTILINE_INSTRUCTIONS}\nexisting system message")
    );
}

#[test]
fn req02_instruction_source_association_prefixed_fold_uses_shifted_index() {
    let (canonical, pair) = normalize(
        "req02-prefixed-fold",
        "responses",
        json!({
            "model": "client-model",
            "instructions": MULTILINE_INSTRUCTIONS,
            "messages": [{"role": "user", "content": "history"}],
            "input": [{"role": "user", "content": "current"}],
            "stream": false
        }),
    );

    assert_eq!(
        canonical["messages"],
        json!([
            {"role": "system", "content": MULTILINE_INSTRUCTIONS},
            {"role": "user", "content": "history"},
            {"role": "user", "content": "current"}
        ])
    );
    assert_eq!(
        destinations(&pair, "request.instructions"),
        vec!["chat.messages[0].content"]
    );
}

#[test]
fn req02_instruction_source_association_gemini_aliases_share_emitted_index() {
    let (canonical, pair) = normalize(
        "req02-gemini-system",
        "gemini",
        json!({
            "model": "client-model",
            "systemInstruction": {"parts": [{"text": MULTILINE_INSTRUCTIONS}]},
            "contents": [{"role": "user", "parts": [{"text": "hello"}]}]
        }),
    );

    assert_eq!(
        canonical["messages"],
        json!([
            {"role": "system", "content": MULTILINE_INSTRUCTIONS},
            {
                "role": "user",
                "content": [{"type": "text", "text": "hello"}]
            }
        ])
    );
    assert_eq!(
        destinations(&pair, "request.systemInstruction"),
        vec!["chat.messages[0].content"]
    );
    assert_eq!(
        destinations(&pair, "request.systemInstruction.parts[0].text"),
        vec!["chat.messages[0].content"]
    );
    assert!(pair
        .inverse_context
        .opaque_record_references
        .iter()
        .any(|record| record.path == "request.systemInstruction"));
}

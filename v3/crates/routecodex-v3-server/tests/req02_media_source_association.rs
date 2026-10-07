use routecodex_v3_runtime::operation_runner::{
    execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, RequestInvocationContext,
    RequestNormalizationEntry, RequestOriginKind, RequestScopedContextPair, V3RequestContextHandle,
};
use serde_json::{json, Value};

fn normalize(protocol: &str, raw: Value) -> (Value, RequestScopedContextPair) {
    let handle = V3RequestContextHandle::new("media-association".into(), protocol.into());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "media-invocation".into(),
        "media-attempt".into(),
        RequestOriginKind::ClientEntry,
    );
    let captured = execute_v3_operation_runner_request_capture_client_json(raw).unwrap();
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .unwrap();
    (canonical, handle.original_pair().unwrap())
}

fn assert_mapping(pair: &RequestScopedContextPair, source: &str, destination: &str) {
    assert!(
        pair.inverse_context
            .field_mappings
            .iter()
            .any(|mapping| mapping.source_path == source && mapping.destination == destination),
        "missing media association {source} -> {destination}"
    );
}

fn assert_source(canonical: &Value, pair: &RequestScopedContextPair, path: &str, raw: &Value) {
    let reference = pair
        .inverse_context
        .opaque_record_references
        .iter()
        .find(|reference| reference.path == path)
        .unwrap_or_else(|| panic!("missing source representation reference {path}"));
    let records = canonical["routecodex_chat_extension"]["chat_extension_opaque_record"]
        .as_array()
        .unwrap();
    let record = records
        .iter()
        .find(|record| record["record_id"] == reference.record_id)
        .unwrap();
    assert_eq!(&record["value"], raw);
}

#[test]
fn responses_image_object_and_scalar_keep_distinct_actual_destinations_and_source_shape() {
    let items = json!([
        {"type":"message","role":"user","content":[
            {"type":"input_image","image_url":"https://example.invalid/one","detail":"high"},
            {"type":"image_url","image_url":{"url":"https://example.invalid/two","vendor.name[0]":true}}
        ]},
        {"type":"reasoning","content":"reasoning with absent role"}
    ]);
    let (canonical, pair) = normalize("responses", json!({"input":items.clone()}));
    assert_eq!(
        canonical["messages"][0]["content"][0]["image_url"]["url"],
        "https://example.invalid/one"
    );
    assert_eq!(
        canonical["messages"][0]["content"][1]["image_url"]["vendor.name[0]"],
        true
    );
    assert_mapping(
        &pair,
        "request.input[0].content[0].image_url",
        "chat.messages[0].content[0].image_url.url",
    );
    assert_mapping(
        &pair,
        "request.input[0].content[1].image_url",
        "chat.messages[0].content[1].image_url",
    );
    assert_source(&canonical, &pair, "request.input[0]", &items[0]);
    assert_source(&canonical, &pair, "request.input[1]", &items[1]);
}

#[test]
fn anthropic_media_records_original_presence_and_actual_emitted_media_path() {
    let message = json!({"role":"user","content":[
        {"type":"image","source":{"type":"base64","data":"YWJj","vendor.name[0]":"opaque"}},
        {"type":"document","title":"manual","source":{"type":"url","url":"https://example.invalid/manual"}}
    ]});
    let (canonical, pair) = normalize("anthropic", json!({"messages":[message.clone()]}));
    assert_eq!(
        canonical["messages"][0]["content"][0]["media"]["inline_data"],
        "YWJj"
    );
    assert!(canonical["messages"][0]["content"][0]["media"]
        .get("mime_type")
        .is_none());
    assert_mapping(
        &pair,
        "request.messages[0].content[0].source.data",
        "chat.messages[0].content[0].media.inline_data",
    );
    assert_mapping(
        &pair,
        "request.messages[0].content[1].source.url",
        "chat.messages[0].content[1].file.file_url",
    );
    assert_source(&canonical, &pair, "request.messages[0]", &message);
    assert!(pair
        .inverse_context
        .opaque_record_references
        .iter()
        .any(|reference| reference.path
            == r#"request.messages[0].content[0].source["vendor.name[0]"]"#));
}

#[test]
fn native_instruction_and_history_source_references_preserve_absence_and_literal_keys() {
    let instruction = json!({"parts":[{"text":"one"},{"text":"two"}],"vendor.name[0]":null});
    let message = json!({"parts":[{"text":"hello"}]});
    let (canonical, pair) = normalize(
        "gemini",
        json!({
            "systemInstruction":instruction.clone(), "contents":[message.clone()]
        }),
    );
    assert_source(&canonical, &pair, "request.systemInstruction", &instruction);
    assert_source(&canonical, &pair, "request.contents[0]", &message);
    assert!(pair
        .inverse_context
        .opaque_record_references
        .iter()
        .any(|reference| reference.path == r#"request.systemInstruction["vendor.name[0]"]"#));
}

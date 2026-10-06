//! Real public SDK consumer for the registered Direct view dependency.
//! Runtime HTTP/WS and actual client tool execution remain separate gates.
use routecodex_v3_runtime::operation_runner::{
    execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, project_canonical_direct_request,
    CurrentFieldAssociations, DirectRequestProjection, RequestInvocationContext,
    RequestNormalizationEntry, RequestOriginKind, RequestScopedContextPair, V3RequestContextHandle,
};
use serde_json::{json, Value};

fn normalize(protocol: &str, raw: Value) -> (Value, RequestScopedContextPair) {
    let handle = V3RequestContextHandle::new(format!("public-direct-{protocol}"), protocol.into());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "client-invocation".into(),
        "provider-attempt".into(),
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

fn project(canonical: &Value, pair: &RequestScopedContextPair) -> DirectRequestProjection {
    let associations = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    project_canonical_direct_request(
        canonical,
        &pair.inverse_context,
        &associations,
        &pair.explicit_history_pairing,
    )
    .unwrap()
}

#[test]
fn optional_null_history_keeps_original_presence_in_registered_direct_view() {
    for (protocol, raw) in [
        (
            "responses",
            json!({"model":"m","input":"hi","messages":null}),
        ),
        ("openai-chat", json!({"model":"m","messages":null})),
        ("anthropic", json!({"model":"m","messages":null})),
        ("gemini", json!({"model":"m","contents":null})),
    ] {
        let (canonical, pair) = normalize(protocol, raw.clone());
        assert_eq!(
            canonical["messages"].as_array().unwrap().len(),
            if protocol == "responses" { 1 } else { 0 }
        );
        assert_eq!(
            project(&canonical, &pair).payload,
            raw,
            "Direct inverse must restore the original null container without adding a user turn"
        );
    }
}

#[test]
fn four_protocols_normalize_then_project_through_public_owners() {
    for (protocol, raw) in [
        (
            "responses",
            json!({"input":[{"role":"user","content":"hello"}],"model":"m", "vendor.key[0]":null}),
        ),
        (
            "openai-chat",
            json!({"messages":[{"role":"user","content":"hello"}],"model":"m"}),
        ),
        (
            "anthropic",
            json!({"messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}], "model":"m","max_tokens":32}),
        ),
        (
            "gemini",
            json!({"contents":[{"role":"user","parts":[{"text":"hello"}]}],"generationConfig":{"maxOutputTokens":32}}),
        ),
    ] {
        let (canonical, pair) = normalize(protocol, raw.clone());
        let projected = project(&canonical, &pair);
        assert_eq!(projected.payload, raw, "{protocol}");
    }
}

#[test]
fn public_view_preserves_full_exec_patch_mcp_and_pairs_emitted_declarations() {
    let cmd = "printf '%s\\n' 'literal $() and `bytes`'\nprintf '%s' 'exec-tail'";
    let patch =
        "*** Begin Patch\n*** Add File: /tmp/exact-path\n+literal $() and `bytes`\n*** End Patch\n";
    let mcp = json!({"nested":[null,{"text":"complete\nMCP tail","meta":{"keep":true}}]});
    let raw = json!({"model":"m", "tools":[{"type":"namespace","name":"functions","tools":[
        {"type":"function","name":"exec","parameters":{"type":"object"}},
        {"type":"custom","name":"apply_patch","format":{"type":"text"}}
    ]}],"input":[
        {"type":"function_call","call_id":"exec-call","namespace":"functions","name":"exec","arguments":cmd},
        {"type":"custom_tool_call","call_id":"patch-call","namespace":"functions","name":"apply_patch","input":patch},
        {"type":"function_call_output","call_id":"mcp-call","output":mcp}
    ]});
    let (canonical, pair) = normalize("responses", raw.clone());
    let projected = project(&canonical, &pair);
    assert_eq!(projected.payload, raw);
    let exec = projected
        .declarations
        .iter()
        .find(|mapping| mapping.source_path == "request.tools[0].tools[0]")
        .unwrap();
    let original = pair
        .inverse_context
        .tool_declarations
        .iter()
        .find(|declaration| declaration.record_id == exec.declaration_record_id)
        .unwrap();
    assert_eq!(original.name.as_deref(), Some("exec"));
    assert_eq!(exec.emitted_kind, "function");
    assert_eq!(exec.emitted_namespace, Some(json!("functions")));
    assert_eq!(exec.destination_path, "tools[0].tools[0]");
    let custom = projected
        .declarations
        .iter()
        .find(|mapping| mapping.source_path == "request.tools[0].tools[1]")
        .unwrap();
    assert_eq!(custom.emitted_kind, "custom");
    assert_eq!(custom.emitted_name.as_deref(), Some("apply_patch"));
}

#[test]
fn public_view_keeps_deleted_mapped_fields_absent_and_null_distinct() {
    let (mut canonical, pair) = normalize(
        "responses",
        json!({
            "model":"m","input":[],"temperature":0.2,"top_p":0.8,
            "tools":[{"type":"function","name":"exec","parameters":{"type":"object"}}]
        }),
    );
    canonical.as_object_mut().unwrap().remove("temperature");
    canonical.as_object_mut().unwrap().remove("tools");
    canonical["top_p"] = Value::Null;
    let projected = project(&canonical, &pair);
    assert_eq!(
        projected.payload,
        json!({"model":"m","input":[],"top_p":null})
    );
    assert!(projected.declarations.is_empty());
}

#[test]
fn native_instruction_and_empty_history_have_independent_presence() {
    for (protocol, raw) in [
        ("anthropic", json!({"system":"instruction-only"})),
        (
            "gemini",
            json!({"systemInstruction":{"parts":[{"text":"instruction-only"}]}}),
        ),
        ("anthropic", json!({"messages":[]})),
        ("gemini", json!({"contents":[]})),
        ("anthropic", json!({"messages":null})),
        ("gemini", json!({"contents":"opaque native value"})),
    ] {
        let (canonical, pair) = normalize(protocol, raw.clone());
        let projected = project(&canonical, &pair);
        assert_eq!(projected.payload, raw, "{protocol}");
    }
}

#[test]
fn nested_namespace_leaf_has_its_own_original_and_emitted_association() {
    let raw = json!({"input":[],"tools":[{"type":"namespace","name":"outer","tools":[
        {"type":"namespace","name":"inner","tools":[
            {"type":"custom","name":"apply_patch","format":{"type":"text"}}
        ]}
    ]}]});
    let (canonical, pair) = normalize("responses", raw.clone());
    let projected = project(&canonical, &pair);
    assert_eq!(projected.payload, raw);
    let source = "request.tools[0].tools[0].tools[0]";
    let original = pair
        .inverse_context
        .tool_declarations
        .iter()
        .find(|declaration| declaration.source_path == source)
        .expect("each actual nested declaration has its own source identity");
    assert_eq!(original.kind, "custom");
    assert_eq!(original.name.as_deref(), Some("apply_patch"));
    assert_eq!(original.namespace, Some(json!("inner")));
    let emitted = projected
        .declarations
        .iter()
        .find(|mapping| mapping.declaration_record_id == original.record_id)
        .unwrap();
    assert_eq!(emitted.destination_path, "tools[0].tools[0].tools[0]");
    assert_eq!(emitted.emitted_kind, "custom");
    assert_eq!(emitted.emitted_namespace, Some(json!("inner")));
}

#[test]
fn public_native_instruction_inverse_reads_distinct_current_leaves() {
    for (protocol, raw, sources, expected) in [
        (
            "gemini",
            json!({"contents":[],"systemInstruction":{"parts":[
                {"text":"same","vendor":1}, {"text":"same","vendor":2}
            ]}}),
            [
                "request.systemInstruction.parts[0].text",
                "request.systemInstruction.parts[1].text",
            ],
            json!({"contents":[],"systemInstruction":{"parts":[
                {"text":"first-current","vendor":1}, {"text":null,"vendor":2}
            ]}}),
        ),
        (
            "anthropic",
            json!({"messages":[],"system":[
                {"type":"text","text":"same","vendor":1},
                {"type":"text","text":"same","vendor":2}
            ]}),
            ["request.system[0].text", "request.system[1].text"],
            json!({"messages":[],"system":[
                {"type":"text","text":"first-current","vendor":1},
                {"type":"text","text":null,"vendor":2}
            ]}),
        ),
    ] {
        let (mut canonical, pair) = normalize(protocol, raw);
        for (source, destination) in sources.into_iter().zip([
            "chat.messages[0].content[0].text",
            "chat.messages[0].content[2].text",
        ]) {
            let mapping = pair
                .inverse_context
                .field_mappings
                .iter()
                .find(|mapping| mapping.source_path == source)
                .unwrap();
            assert_eq!(mapping.destination, destination, "{protocol}: {source}");
        }
        canonical["messages"][0]["content"][0]["text"] = json!("first-current");
        canonical["messages"][0]["content"][2]["text"] = Value::Null;
        let projected = project(&canonical, &pair);
        assert_eq!(projected.payload, expected, "{protocol}");
    }
}

#[test]
fn public_responses_instruction_and_history_keep_independent_current_values() {
    let (mut canonical, pair) = normalize(
        "responses",
        json!({
            "instructions":"same", "input":[{"role":"system","content":"same"}]
        }),
    );
    for (source, destination) in [
        ("request.instructions", "chat.messages[0].content[0].text"),
        (
            "request.input[0].content",
            "chat.messages[0].content[2].text",
        ),
    ] {
        let mapping = pair
            .inverse_context
            .field_mappings
            .iter()
            .find(|mapping| mapping.source_path == source)
            .unwrap();
        assert_eq!(mapping.destination, destination);
    }
    canonical["messages"][0]["content"][0]
        .as_object_mut()
        .unwrap()
        .remove("text");
    canonical["messages"][0]["content"][2]["text"] = json!("history-current");
    let projected = project(&canonical, &pair);
    assert_eq!(
        projected.payload,
        json!({
            "input":[{"role":"system","content":"history-current"}]
        })
    );
}

#[test]
fn public_native_config_preserves_literal_structural_characters_in_keys() {
    let raw = json!({"contents":[], "generationConfig":{
        "temperature":0.4, "vendor.key[0]":{"nested.key":null},
        "temperature.vendor":"literal field"
    }});
    let (canonical, pair) = normalize("gemini", raw.clone());
    let projected = project(&canonical, &pair);
    assert_eq!(projected.payload, raw);
}

#[test]
fn shared_system_array_restores_only_its_own_history_parts() {
    let raw = json!({"instructions":"same", "input":[{
        "role":"system", "content":[
            {"type":"input_text","text":"same","vendor":{"keep":true}},
            {"type":"input_text","text":"tail","literal.key[0]":null}
        ]
    }]});
    let (canonical, pair) = normalize("responses", raw.clone());
    let projected = project(&canonical, &pair);
    assert_eq!(projected.payload, raw);
}

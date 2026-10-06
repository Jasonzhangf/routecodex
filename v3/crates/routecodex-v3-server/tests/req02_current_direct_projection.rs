//! Public consumer coverage for Direct projection through paired current edits.
use routecodex_v3_runtime::operation_runner::{
    apply_canonical_field_edit, execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, project_canonical_direct_request,
    CanonicalFieldEdit, CurrentFieldAssociations, DirectRequestProjection,
    RequestInvocationContext, RequestNormalizationEntry, RequestOriginKind,
    RequestScopedContextPair, V3RequestContextHandle,
};
use serde_json::{json, Value};

fn normalize(
    protocol: &str,
    raw: Value,
) -> (Value, RequestScopedContextPair, CurrentFieldAssociations) {
    let handle = V3RequestContextHandle::new(format!("current-direct-{protocol}"), protocol.into());
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
    let pair = handle.original_pair().unwrap();
    let associations = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    (canonical, pair, associations)
}

fn project(
    canonical: &Value,
    pair: &RequestScopedContextPair,
    associations: &CurrentFieldAssociations,
) -> DirectRequestProjection {
    project_canonical_direct_request(
        canonical,
        &pair.inverse_context,
        associations,
        &pair.explicit_history_pairing,
    )
    .unwrap()
}

#[test]
fn deleted_optional_null_history_is_not_revived_from_original_source() {
    for (protocol, raw, native_key) in [
        (
            "responses",
            json!({"model":"m","messages":null}),
            "messages",
        ),
        (
            "openai-chat",
            json!({"model":"m","messages":null}),
            "messages",
        ),
        (
            "anthropic",
            json!({"model":"m","messages":null}),
            "messages",
        ),
        ("gemini", json!({"model":"m","contents":null}), "contents"),
    ] {
        let (canonical, pair, associations) = normalize(protocol, raw);
        let (canonical, associations) = apply_canonical_field_edit(
            &canonical,
            &associations,
            &CanonicalFieldEdit::Remove {
                path: "chat.messages".into(),
            },
        )
        .unwrap();
        assert!(
            project(&canonical, &pair, &associations)
                .payload
                .get(native_key)
                .is_none(),
            "{protocol}: removed canonical history must not reappear from its original null record"
        );
    }
}

#[test]
fn four_protocol_public_baselines_remain_lossless() {
    for (protocol, raw) in [
        (
            "responses",
            json!({"model":"m","input":[{"role":"user","content":"hello"}],"vendor.key[0]":null}),
        ),
        (
            "openai-chat",
            json!({"model":"m","messages":[{"role":"user","content":"hello"}]}),
        ),
        (
            "anthropic",
            json!({"model":"m","messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}],"max_tokens":32}),
        ),
        (
            "gemini",
            json!({"contents":[{"role":"user","parts":[{"text":"hello"}]}],"generationConfig":{"maxOutputTokens":32}}),
        ),
    ] {
        let (canonical, pair, associations) = normalize(protocol, raw.clone());
        assert_eq!(
            project(&canonical, &pair, &associations).payload,
            raw,
            "{protocol}"
        );
    }
}

#[test]
fn identity_tool_deletion_uses_surviving_original_identity() {
    let raw = json!({"model":"m","input":[],"tools":[{"type":"namespace","name":"functions","tools":[
        {"type":"custom","name":"apply_patch","format":{"type":"text"}},
        {"type":"function","name":"exec","parameters":{"type":"object"}}
    ]}]});
    let (canonical, pair, associations) = normalize("responses", raw);
    let original_records = pair.inverse_context.tool_declarations.clone();
    let deleted_record_id = original_records
        .iter()
        .find(|declaration| declaration.source_path == "request.tools[0].tools[0]")
        .unwrap()
        .record_id
        .clone();

    let (canonical, associations) = apply_canonical_field_edit(
        &canonical,
        &associations,
        &CanonicalFieldEdit::Remove {
            path: "chat.tools[0].tools[0]".to_string(),
        },
    )
    .unwrap();
    let projected = project(&canonical, &pair, &associations);

    assert_eq!(
        projected.payload["tools"][0]["tools"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(projected.payload["tools"][0]["tools"][0]["name"], "exec");
    assert_eq!(projected.declarations.len(), 2);
    let container = projected
        .declarations
        .iter()
        .find(|declaration| declaration.source_path == "request.tools[0]")
        .unwrap();
    assert_eq!(container.destination_path, "tools[0]");
    assert_eq!(container.emitted_kind, "namespace");
    assert_eq!(container.emitted_name.as_deref(), Some("functions"));
    assert_eq!(container.emitted_namespace, None);
    let exec = projected
        .declarations
        .iter()
        .find(|declaration| declaration.source_path == "request.tools[0].tools[1]")
        .unwrap();
    assert_eq!(exec.destination_path, "tools[0].tools[0]");
    assert_eq!(exec.emitted_kind, "function");
    assert_eq!(exec.emitted_name.as_deref(), Some("exec"));
    assert_eq!(exec.emitted_namespace, Some(json!("functions")));
    assert!(projected
        .declarations
        .iter()
        .all(|declaration| declaration.declaration_record_id != deleted_record_id));
    assert_eq!(
        pair.inverse_context.tool_declarations, original_records,
        "the immutable original pair must not be rewritten"
    );
}

#[test]
fn identity_tool_move_and_insert_follow_current_wire_positions() {
    let raw = json!({"model":"m","input":[],"tools":[
        {"type":"function","name":"first","parameters":{"type":"object"}},
        {"type":"function","name":"second","parameters":{"type":"object"}}
    ]});
    let (canonical, pair, associations) = normalize("responses", raw);

    let (canonical, associations) = apply_canonical_field_edit(
        &canonical,
        &associations,
        &CanonicalFieldEdit::MoveArray {
            array_path: "chat.tools".to_string(),
            from: 0,
            to: 1,
        },
    )
    .unwrap();
    let moved = project(&canonical, &pair, &associations);
    assert_eq!(moved.payload["tools"][0]["name"], "second");
    assert_eq!(moved.payload["tools"][1]["name"], "first");
    assert_eq!(
        moved
            .declarations
            .iter()
            .find(|declaration| declaration.source_path == "request.tools[0]")
            .unwrap()
            .destination_path,
        "tools[1]"
    );

    let (canonical, associations) = apply_canonical_field_edit(
        &canonical,
        &associations,
        &CanonicalFieldEdit::InsertArray {
            array_path: "chat.tools".to_string(),
            index: 0,
            value: json!({"type":"function","name":"inserted","parameters":{"type":"object"}}),
        },
    )
    .unwrap();
    let inserted = project(&canonical, &pair, &associations);
    assert_eq!(inserted.payload["tools"][0]["name"], "inserted");
    assert_eq!(inserted.declarations.len(), 2);
    assert!(inserted
        .declarations
        .iter()
        .all(|declaration| declaration.emitted_name.as_deref() != Some("inserted")));
    assert!(inserted
        .declarations
        .iter()
        .all(|declaration| declaration.source_path.starts_with("request.tools[")));
}

#[test]
fn instruction_and_history_deletions_do_not_cross_revive() {
    let raw =
        json!({"model":"m","instructions":"same","input":[{"role":"system","content":"same"}]});
    let (canonical, pair, associations) = normalize("responses", raw);
    let instruction_source = "request.instructions";
    let history_source = "request.input[0].content";
    let instruction_index = pair
        .inverse_context
        .field_mappings
        .iter()
        .position(|mapping| mapping.source_path == instruction_source)
        .unwrap();
    let history_index = pair
        .inverse_context
        .field_mappings
        .iter()
        .position(|mapping| mapping.source_path == history_source)
        .unwrap();
    let instruction_destination = associations
        .destination_for_original_mapping(instruction_index)
        .unwrap()
        .to_string();
    let history_destination = associations
        .destination_for_original_mapping(history_index)
        .unwrap()
        .to_string();

    let (canonical, associations) = apply_canonical_field_edit(
        &canonical,
        &associations,
        &CanonicalFieldEdit::Remove {
            path: instruction_destination,
        },
    )
    .unwrap();
    let projected = project(&canonical, &pair, &associations);
    assert!(projected.payload.get("instructions").is_none());
    assert_eq!(projected.payload["input"][0]["content"], "same");

    let (canonical, associations) = apply_canonical_field_edit(
        &canonical,
        &associations,
        &CanonicalFieldEdit::Remove {
            path: history_destination,
        },
    )
    .unwrap();
    let projected = project(&canonical, &pair, &associations);
    assert_eq!(
        projected.payload,
        json!({"model":"m","input":[{"role":"system"}]})
    );
}

#[test]
fn anthropic_and_gemini_deletions_do_not_emit_placeholder_declarations() {
    let anthropic = json!({"model":"m","messages":[],"tools":[
        {"name":"first","input_schema":{"type":"object"}},
        {"name":"second","input_schema":{"type":"object"}}
    ]});
    let (canonical, pair, associations) = normalize("anthropic", anthropic);
    let (canonical, associations) = apply_canonical_field_edit(
        &canonical,
        &associations,
        &CanonicalFieldEdit::Remove {
            path: "chat.tools[0]".to_string(),
        },
    )
    .unwrap();
    let projected = project(&canonical, &pair, &associations);
    assert_eq!(projected.payload["tools"].as_array().unwrap().len(), 1);
    assert_eq!(projected.payload["tools"][0]["name"], "second");
    assert_eq!(projected.declarations.len(), 1);
    assert_eq!(projected.declarations[0].destination_path, "tools[0]");

    let gemini = json!({"contents":[],"tools":[
        {"functionDeclarations":[{"name":"first","parameters":{"type":"object"}}],"vendor":1},
        {"functionDeclarations":[{"name":"second","parameters":{"type":"object"}}]}
    ]});
    let (canonical, pair, associations) = normalize("gemini", gemini);
    let (canonical, associations) = apply_canonical_field_edit(
        &canonical,
        &associations,
        &CanonicalFieldEdit::Remove {
            path: "chat.tools[0]".to_string(),
        },
    )
    .unwrap();
    let projected = project(&canonical, &pair, &associations);
    assert_eq!(
        projected.payload["tools"][0]["functionDeclarations"],
        json!([])
    );
    assert_eq!(projected.payload["tools"][0]["vendor"], 1);
    assert_eq!(
        projected.payload["tools"][1]["functionDeclarations"][0]["name"],
        "second"
    );
    assert_eq!(projected.declarations.len(), 1);
    assert_eq!(
        projected.declarations[0].destination_path,
        "tools[1].functionDeclarations[0]"
    );
}

#[test]
fn current_unknown_sibling_and_null_schema_values_are_preserved() {
    let raw = json!({"model":"m","messages":[],"tools":[{
        "name":"lookup",
        "input_schema":{"type":"object","properties":{"q":{"type":"string"}},"vendor":null},
        "description":"old",
        "vendor":null
    }]});
    let (canonical, pair, associations) = normalize("anthropic", raw);
    let (canonical, associations) = apply_canonical_field_edit(
        &canonical,
        &associations,
        &CanonicalFieldEdit::Replace {
            path: "chat.tools[0].function.parameters".to_string(),
            value: json!({"type":"object","properties":{"q":{"type":"string"}},"vendor":null}),
        },
    )
    .unwrap();
    let (canonical, associations) = apply_canonical_field_edit(
        &canonical,
        &associations,
        &CanonicalFieldEdit::Remove {
            path: "chat.tools[0].function.description".to_string(),
        },
    )
    .unwrap();
    let projected = project(&canonical, &pair, &associations);
    assert_eq!(projected.payload["tools"][0]["vendor"], Value::Null);
    assert_eq!(
        projected.payload["tools"][0]["input_schema"]["vendor"],
        Value::Null
    );
    assert!(projected.payload["tools"][0].get("description").is_none());
}

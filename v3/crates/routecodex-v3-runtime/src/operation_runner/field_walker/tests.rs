use super::field_operator_library::FieldOperatorRegistry;
use super::profile::FieldProfile;
use super::*;
use serde_json::json;
use std::collections::BTreeSet;

fn inventory(paths: &[&str]) -> BTreeSet<String> {
    paths.iter().map(|path| (*path).to_owned()).collect()
}

fn four_direction_profile() -> &'static str {
    r#"
path_consumers:
  - protocol: responses
    path: request.model
    consumers:
      client_request_to_chat: routecodex.v3.field.lossless_preserve@1
      chat_to_provider: routecodex.v3.field.standard_projection@1
    params: {shape: leaf}
  - protocol: responses
    path: response.model
    consumers:
      provider_response_to_chat: routecodex.v3.field.provider_normalization@1
      chat_to_client_response: routecodex.v3.field.inverse_client_projection@1
    params: {shape: leaf}
field_walker:
  opaque_tool_payload_paths: []
"#
}

fn compile(source: &str, paths: &[&str], protocol: &str, direction: FieldDirection) -> FieldWalker {
    FieldWalker::compile(
        FieldProfile::from_yaml(source, inventory(paths), protocol, direction)
            .expect("profile parses"),
        FieldOperatorRegistry::default(),
    )
    .expect("profile compiles")
}

#[test]
fn four_direction_round_trip_preserves_unknown_business_fields() {
    let cases = [
        (
            FieldDirection::ClientRequestToChat,
            ReferenceOwner::RequestInverseContext,
        ),
        (
            FieldDirection::ChatToProvider,
            ReferenceOwner::RequestInverseContext,
        ),
        (
            FieldDirection::ProviderResponseToChat,
            ReferenceOwner::ResponseProvenance,
        ),
        (
            FieldDirection::ChatToClientResponse,
            ReferenceOwner::ResponseProvenance,
        ),
    ];
    for (direction, owner) in cases {
        let walker = compile(
            four_direction_profile(),
            &["request.model", "response.model"],
            "responses",
            direction,
        );
        let original = json!({
                "model": "gpt-test",
                "future_business_field": {"nested": [1, {"keep": true}]}
        });
        let mut result = walker.walk(original.clone());
        assert_eq!(
            result.value["future_business_field"],
            original["future_business_field"]
        );
        assert_eq!(result.consumed.len(), 1);
        assert_eq!(result.consumed[0].path, "/model");
        assert_eq!(result.opaque_records.len(), 1);
        assert_eq!(
            result.opaque_records[0].original_path,
            "/future_business_field"
        );
        assert_eq!(result.inverse_references[0].owner, owner);
        assert_eq!(result.inverse_references[0].protocol, "responses");

        // Prove the inverse consumes the same-turn record rather than reading a log or snapshot.
        result
            .value
            .as_object_mut()
            .expect("request object")
            .remove("future_business_field");
        assert_eq!(result.restore_inverse(), original);
    }
}

#[test]
fn known_path_with_unmatched_value_shape_is_preserved_opaque() {
    let walker = compile(
        four_direction_profile(),
        &["request.model", "response.model"],
        "responses",
        FieldDirection::ClientRequestToChat,
    );
    let payload = json!({"model": {"unexpected": "object"}});
    let result = walker.walk(payload.clone());
    assert_eq!(result.value, payload);
    assert!(result.consumed.is_empty());
    assert_eq!(result.opaque_records.len(), 1);
    assert_eq!(result.opaque_records[0].original_path, "/model");
}

#[test]
fn opaque_tool_arguments_and_input_are_single_unchanged_values() {
    let source = r#"
path_consumers:
  - protocol: responses
    path: request.input
    parent_owned: true
    structure_only: true
    params: {shape: array}
  - protocol: responses
    path: request.input[].type
    consumers:
      client_request_to_chat: routecodex.v3.field.identity_preserve@1
    params: {shape: array_item}
  - protocol: responses
    path: request.input[].arguments
    consumers:
      client_request_to_chat: routecodex.v3.field.opaque_tool_payload@1
    params: {shape: opaque_complete_value}
  - protocol: responses
    path: request.input[].input
    consumers:
      client_request_to_chat: routecodex.v3.field.opaque_tool_payload@1
    params: {shape: opaque_complete_value}
field_walker:
  opaque_tool_payload_paths:
    - protocol: responses
      path: request.input[].arguments
    - protocol: responses
      path: request.input[].input
"#;
    let walker = compile(
        source,
        &[
            "request.input",
            "request.input[].type",
            "request.input[].arguments",
            "request.input[].input",
        ],
        "responses",
        FieldDirection::ClientRequestToChat,
    );
    let argument_text = r#"{"nested":{"do_not":"parse"}}"#;
    let payload = json!({
        "input": [{
            "type": "function_call",
            "arguments": argument_text,
            "input": {"raw": [1, 2, 3]}
        }]
    });
    let result = walker.walk(payload.clone());
    assert_eq!(result.value, payload);
    assert!(result.opaque_records.is_empty());
    assert_eq!(
        result.value["input"][0]["arguments"].as_str(),
        Some(argument_text)
    );
    assert_eq!(result.value["input"][0]["input"], json!({"raw": [1, 2, 3]}));
}

#[test]
fn typed_discriminator_cases_select_by_the_responses_item_type() {
    let source = r#"
path_consumers:
  - protocol: responses
    path: request.input
    parent_owned: true
    structure_only: true
    params: {shape: array}
  - protocol: responses
    path: request.input[].type
    consumers:
      client_request_to_chat: routecodex.v3.field.identity_preserve@1
    params: {shape: array_item}
  - protocol: responses
    path: request.input[].arguments
    consumers:
      client_request_to_chat: routecodex.v3.field.opaque_tool_payload@1
    params: {shape: opaque_complete_value}
    typed_discriminator_cases:
      discriminator_path: request.input[].type
      cases:
        - type_value: function_call
          semantic_id: tool.call.arguments
          operator: routecodex.v3.field.opaque_tool_payload@1
field_walker:
  opaque_tool_payload_paths:
    - protocol: responses
      path: request.input[].arguments
"#;
    let walker = compile(
        source,
        &[
            "request.input",
            "request.input[].type",
            "request.input[].arguments",
        ],
        "responses",
        FieldDirection::ClientRequestToChat,
    );
    let payload = json!({
        "input": [
            {"type": "message", "arguments": "not a tool call"},
            {"type": "function_call", "arguments": "{\"answer\":42}"}
        ]
    });
    let result = walker.walk(payload);
    assert_eq!(result.opaque_records.len(), 1);
    assert_eq!(result.opaque_records[0].original_path, "/input/0/arguments");
    assert!(result.consumed.iter().any(|receipt| {
        receipt.path == "/input/1/arguments"
            && receipt.semantic_id.as_deref() == Some("tool.call.arguments")
    }));
}

#[test]
fn compile_rejects_missing_operator_registration() {
    let source = r#"
path_consumers:
  - protocol: responses
    path: request.model
    consumers:
      client_request_to_chat: routecodex.v3.field.not_registered@1
    params: {shape: leaf}
field_walker: {opaque_tool_payload_paths: []}
"#;
    let error = FieldWalker::compile(
        FieldProfile::from_yaml(
            source,
            inventory(&["request.model"]),
            "responses",
            FieldDirection::ClientRequestToChat,
        )
        .expect("profile parses"),
        FieldOperatorRegistry::default(),
    )
    .err()
    .expect("missing operator must fail compile");
    assert!(error.to_string().contains("missing operator registration"));
}

#[test]
fn compile_rejects_duplicate_consumer_on_same_path_and_direction() {
    let source = r#"
path_consumers:
  - protocol: responses
    path: request.model
    consumers:
      client_request_to_chat: routecodex.v3.field.lossless_preserve@1
    params: {shape: leaf}
  - protocol: responses
    path: request.model
    consumers:
      client_request_to_chat: routecodex.v3.field.identity_preserve@1
    params: {shape: leaf}
field_walker: {opaque_tool_payload_paths: []}
"#;
    let error = FieldWalker::compile(
        FieldProfile::from_yaml(
            source,
            inventory(&["request.model"]),
            "responses",
            FieldDirection::ClientRequestToChat,
        )
        .expect("profile parses"),
        FieldOperatorRegistry::default(),
    )
    .err()
    .expect("duplicate ownership must fail compile");
    assert!(error.to_string().contains("duplicate consumer ownership"));
}

#[test]
fn real_manifest_compiles_for_each_protocol_and_direction() {
    const PROFILES: &str = include_str!(
        "../../../../../../docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml"
    );
    const MATRIX: &str = include_str!(
        "../../../../../../docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml"
    );
    let matrix: serde_json::Value = serde_yaml::from_str(MATRIX).expect("matrix parses");
    let registry = FieldOperatorRegistry::default();
    for protocol in ["responses", "openai_chat", "anthropic", "gemini"] {
        let mut paths = BTreeSet::new();
        if let Some(sections) = matrix["source_inventory"][protocol].as_object() {
            for section in sections.values().filter_map(serde_json::Value::as_array) {
                paths.extend(
                    section
                        .iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(str::to_owned),
                );
            }
        }
        assert!(!paths.is_empty(), "inventory exists for {protocol}");
        for direction in [
            FieldDirection::ClientRequestToChat,
            FieldDirection::ChatToProvider,
            FieldDirection::ProviderResponseToChat,
            FieldDirection::ChatToClientResponse,
        ] {
            let profile = FieldProfile::from_yaml(PROFILES, paths.clone(), protocol, direction)
                .unwrap_or_else(|error| panic!("{protocol} {direction:?}: {error}"));
            FieldWalker::compile(profile, FieldOperatorRegistry::default())
                .unwrap_or_else(|error| panic!("{protocol} {direction:?}: {error}"));
        }
    }
    let manifest: serde_json::Value = serde_yaml::from_str(PROFILES).expect("profiles parse");
    for entry in manifest["operator_registry"]["field_operators"]
        .as_array()
        .expect("field operator registry")
    {
        let key = format!(
            "{}@{}",
            entry["operator"].as_str().expect("operator name"),
            entry["operator_version"]
                .as_str()
                .expect("operator version")
        );
        assert!(
            registry.get(&key).is_some(),
            "missing static operator {key}"
        );
    }
}

#[test]
fn compile_rejects_structural_row_shadowing_a_consumer() {
    let source = r#"
path_consumers:
  - protocol: responses
    path: request.input
    structure_only: true
    params: {shape: array}
  - protocol: responses
    path: request.input
    consumers:
      client_request_to_chat: routecodex.v3.field.lossless_preserve@1
    params: {shape: array}
field_walker: {opaque_tool_payload_paths: []}
"#;
    let profile = FieldProfile::from_yaml(
        source,
        inventory(&["request.input"]),
        "responses",
        FieldDirection::ClientRequestToChat,
    )
    .expect("profile parses");
    assert!(FieldWalker::compile(profile, FieldOperatorRegistry::default()).is_err());
}

#[test]
fn unmatched_shapes_restore_in_every_direction_with_escaped_member_names() {
    for direction in [
        FieldDirection::ClientRequestToChat,
        FieldDirection::ChatToProvider,
        FieldDirection::ProviderResponseToChat,
        FieldDirection::ChatToClientResponse,
    ] {
        let walker = compile(
            four_direction_profile(),
            &["request.model", "response.model"],
            "responses",
            direction,
        );
        let original = json!({"model": [null, {"raw": true}], "a~/b": {"keep": 42}});
        let mut result = walker.walk(original.clone());
        assert_eq!(result.opaque_records.len(), 2);
        assert!(result
            .opaque_records
            .iter()
            .any(|r| r.original_path == "/a~0~1b"));
        result.value = json!({});
        assert_eq!(result.restore_inverse(), original);
    }
}

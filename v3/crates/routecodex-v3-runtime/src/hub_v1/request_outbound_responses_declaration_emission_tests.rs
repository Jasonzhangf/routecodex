use super::*;
use crate::operation_runner::{
    apply_canonical_field_edit, CanonicalFieldEdit, CurrentFieldAssociations, FieldMapping,
    RequestInverseContext, ToolDeclarationReference,
};

fn declaration(
    record_id: &str,
    source_path: &str,
    kind: &str,
    name: &str,
    namespace: Value,
) -> ToolDeclarationReference {
    ToolDeclarationReference {
        record_id: record_id.to_string(),
        source_path: source_path.to_string(),
        kind: kind.to_string(),
        name: Some(name.to_string()),
        namespace: Some(namespace),
        encoding: "json".to_string(),
    }
}

fn mapping(source_path: &str, destination: &str) -> FieldMapping {
    FieldMapping {
        source_path: source_path.to_string(),
        destination: destination.to_string(),
        operator: "routecodex.v3.field.tool_declaration_transform@1".to_string(),
        shape: None,
        semantics: None,
        transform_id: None,
        collision_policy: None,
        encoding: "json".to_string(),
    }
}

fn inverse(
    field_mappings: Vec<FieldMapping>,
    tool_declarations: Vec<ToolDeclarationReference>,
) -> RequestInverseContext {
    RequestInverseContext {
        entry_protocol: "responses".to_string(),
        normalized_protocol: "chat".to_string(),
        field_mappings,
        opaque_record_references: Vec::new(),
        tool_declarations,
        native_container_bindings: Vec::new(),
    }
}

#[test]
fn responses_emission_uses_actual_sdk_sources_and_nested_destinations() {
    use crate::operation_runner::{
        execute_v3_operation_runner_request_capture_client_json,
        execute_v3_operation_runner_request_normalize_losslessly, RequestInvocationContext,
        RequestNormalizationEntry, RequestOriginKind, V3RequestContextHandle,
    };

    let raw = json!({
        "model": "client-model",
        "input": [{"role": "user", "content": "Use all declared tools"}],
        "tools": [{
            "type": "namespace",
            "name": "outer",
            "tools": [{
                "type": "namespace",
                "name": "inner",
                "tools": [
                    {"type": "custom", "name": "apply_patch", "format": {"type": "text"}},
                    {
                        "type": "function",
                        "name": "lookup",
                        "parameters": {
                            "type": "object",
                            "properties": {"q": {"type": "string"}}
                        }
                    }
                ]
            }]
        }]
    });
    let handle = V3RequestContextHandle::new("responses-emission".into(), "responses".into());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "responses-invocation".into(),
        "responses-attempt".into(),
        RequestOriginKind::ClientEntry,
    );
    let captured = execute_v3_operation_runner_request_capture_client_json(raw).unwrap();
    let mut canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .unwrap();
    let pair = handle.original_pair().unwrap();
    canonical["tools"][0]["tools"][0]["tools"][1]["parameters"]["properties"]["q"]["type"] =
        json!("number");
    let original_canonical = canonical.clone();
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);

    let (wire, mappings) =
        build_v3_openai_responses_standard_request_from_chat_canonical_with_declarations(
            &canonical,
            &pair.inverse_context,
            &current,
        )
        .expect("actual SDK canonical must project through the Responses standard entry");

    assert_eq!(
        canonical, original_canonical,
        "declaration emission must not modify the request canonical"
    );
    assert!(
        canonical["routecodex_chat_extension"]["chat_extension_opaque_record"].is_array(),
        "the SDK opaque carrier must remain on the original canonical"
    );
    assert_eq!(wire["tools"].as_array().unwrap().len(), 2);
    assert_eq!(wire["tools"][0]["type"], "function");
    assert_eq!(wire["tools"][0]["name"], "outer__inner__apply_patch");
    assert_eq!(wire["tools"][1]["type"], "function");
    assert_eq!(wire["tools"][1]["name"], "outer__inner__lookup");
    assert_eq!(
        wire["tools"][1]["parameters"]["properties"]["q"]["type"], "number",
        "the emitted tool must use the current canonical schema"
    );

    assert_eq!(mappings.len(), 2);
    let patch = mappings
        .iter()
        .find(|mapping| mapping.source_path == "request.tools[0].tools[0].tools[0]")
        .expect("nested custom child must be recorded");
    assert_eq!(patch.destination_path, "tools[0]");
    assert_eq!(patch.emitted_kind, "function");
    assert_eq!(
        patch.emitted_name.as_deref(),
        Some("outer__inner__apply_patch")
    );
    assert_eq!(patch.emitted_namespace, None);

    let lookup = mappings
        .iter()
        .find(|mapping| mapping.source_path == "request.tools[0].tools[0].tools[1]")
        .expect("nested function child must be recorded");
    assert_eq!(lookup.destination_path, "tools[1]");
    assert_eq!(lookup.emitted_kind, "function");
    assert_eq!(lookup.emitted_name.as_deref(), Some("outer__inner__lookup"));
    assert_eq!(lookup.emitted_namespace, None);
    let original = pair
        .inverse_context
        .tool_declarations
        .iter()
        .find(|declaration| declaration.source_path == "request.tools[0].tools[0].tools[1]")
        .unwrap();
    assert_eq!(lookup.declaration_record_id, original.record_id);
}

#[test]
fn responses_emission_records_duplicate_leaf_names_by_actual_namespace() {
    let payload = json!({
        "messages": [],
        "tools": [
            {
                "type": "namespace",
                "name": "alpha",
                "tools": [{"type": "function", "name": "leaf", "parameters": {"type": "object"}}]
            },
            {
                "type": "namespace",
                "name": "beta",
                "tools": [{"type": "custom", "name": "leaf", "format": {"type": "text"}}]
            }
        ]
    });
    let inverse = inverse(
        vec![
            mapping("request.tools[0].tools[0]", "chat.tools[0].tools[0]"),
            mapping("request.tools[1].tools[0]", "chat.tools[1].tools[0]"),
        ],
        vec![
            declaration(
                "r-alpha",
                "request.tools[0].tools[0]",
                "function",
                "leaf",
                json!("alpha"),
            ),
            declaration(
                "r-beta",
                "request.tools[1].tools[0]",
                "custom",
                "leaf",
                json!("beta"),
            ),
        ],
    );

    let current = CurrentFieldAssociations::from_normalization(&inverse);
    let (_wire, mappings) =
        build_v3_openai_responses_standard_request_from_chat_canonical_with_declarations(
            &payload, &inverse, &current,
        )
        .expect("duplicate leaf names in distinct namespaces must remain distinguishable");

    assert_eq!(mappings.len(), 2);
    let alpha = mappings
        .iter()
        .find(|mapping| mapping.destination_path == "tools[0]")
        .expect("alpha child must be recorded at its flat wire destination");
    assert_eq!(alpha.declaration_record_id, "r-alpha");
    assert_eq!(alpha.source_path, "request.tools[0].tools[0]");
    assert_eq!(alpha.emitted_kind, "function");
    assert_eq!(alpha.emitted_name.as_deref(), Some("alpha__leaf"));
    assert_eq!(alpha.emitted_namespace, None);

    let beta = mappings
        .iter()
        .find(|mapping| mapping.destination_path == "tools[1]")
        .expect("beta child must be recorded at its flat wire destination");
    assert_eq!(beta.declaration_record_id, "r-beta");
    assert_eq!(beta.source_path, "request.tools[1].tools[0]");
    assert_eq!(beta.emitted_kind, "function");
    assert_eq!(beta.emitted_name.as_deref(), Some("beta__leaf"));
    assert_eq!(beta.emitted_namespace, None);
}

#[test]
fn responses_emission_records_changed_schema_and_omits_removed_child() {
    let payload = json!({
        "messages": [],
        "tools": [{
            "type": "namespace",
            "name": "ns",
            "tools": [
                {
                    "type": "function",
                    "name": "keep",
                    "parameters": {
                        "type": "object",
                        "properties": {"value": {"type": "string"}}
                    }
                },
                {"type": "function", "name": "drop", "parameters": {"type": "object"}}
            ]
        }]
    });
    let inverse = inverse(
        vec![
            mapping("request.tools[0].tools[0]", "chat.tools[0].tools[0]"),
            mapping("request.tools[0].tools[1]", "chat.tools[0].tools[1]"),
        ],
        vec![
            declaration(
                "r-keep",
                "request.tools[0].tools[0]",
                "function",
                "keep",
                json!("ns"),
            ),
            declaration(
                "r-drop",
                "request.tools[0].tools[1]",
                "function",
                "drop",
                json!("ns"),
            ),
        ],
    );
    // Schema value edits do not move the source; the structural removal goes
    // through the registered edit consumer so data and current origins stay
    // paired in one call.
    let mut payload = payload;
    payload["tools"][0]["tools"][0]["parameters"]["properties"]["value"]["type"] = json!("number");
    let initial = CurrentFieldAssociations::from_normalization(&inverse);
    let (payload, current) = apply_canonical_field_edit(
        &payload,
        &initial,
        &CanonicalFieldEdit::Remove {
            path: "chat.tools[0].tools[1]".to_string(),
        },
    )
    .expect("registered remove edit must pair the data and current origins");

    let (wire, mappings) =
        build_v3_openai_responses_standard_request_from_chat_canonical_with_declarations(
            &payload, &inverse, &current,
        )
        .expect("removed child must not block the remaining Responses emission");

    assert_eq!(wire["tools"].as_array().unwrap().len(), 1);
    assert_eq!(wire["tools"][0]["type"], "function");
    assert_eq!(wire["tools"][0]["name"], "ns__keep");
    assert_eq!(
        wire["tools"][0]["parameters"]["properties"]["value"]["type"],
        "number"
    );
    assert_eq!(mappings.len(), 1);
    assert_eq!(mappings[0].declaration_record_id, "r-keep");
    assert_eq!(mappings[0].source_path, "request.tools[0].tools[0]");
    assert_eq!(mappings[0].destination_path, "tools[0]");
    assert!(
        mappings
            .iter()
            .all(|mapping| mapping.declaration_record_id != "r-drop"),
        "removed child must not retain a declaration association"
    );
}

#[test]
fn responses_emission_records_apply_patch_projection_from_actual_emitted_tool() {
    let payload = json!({
        "messages": [],
        "tools": [{
            "type": "custom",
            "name": "apply_patch",
            "description": "Apply a patch",
            "format": {"type": "text"}
        }]
    });
    let inverse = inverse(
        vec![mapping("request.tools[0]", "chat.tools[0]")],
        vec![declaration(
            "r-patch",
            "request.tools[0]",
            "custom",
            "apply_patch",
            json!(null),
        )],
    );

    let current = CurrentFieldAssociations::from_normalization(&inverse);
    let (wire, mappings) =
        build_v3_openai_responses_standard_request_from_chat_canonical_with_declarations(
            &payload, &inverse, &current,
        )
        .expect("apply_patch custom declaration must project through Responses");

    assert_eq!(
        wire["tools"], payload["tools"],
        "native custom declaration must be preserved completely"
    );
    assert_eq!(mappings.len(), 1);
    assert_eq!(mappings[0].declaration_record_id, "r-patch");
    assert_eq!(mappings[0].destination_path, "tools[0]");
    assert_eq!(mappings[0].emitted_kind, "custom");
    assert_eq!(mappings[0].emitted_name.as_deref(), Some("apply_patch"));
    assert_eq!(mappings[0].emitted_namespace, None);
}

#[test]
fn responses_emission_matches_observer_free_builder_without_opaque_envelope() {
    let payload = json!({
        "messages": [],
        "tools": [{
            "type": "namespace",
            "name": "ns",
            "tools": [{
                "type": "function",
                "name": "leaf",
                "parameters": {"type": "object"}
            }]
        }]
    });
    let inverse = inverse(
        vec![mapping(
            "request.tools[0].tools[0]",
            "chat.tools[0].tools[0]",
        )],
        vec![declaration(
            "r-leaf",
            "request.tools[0].tools[0]",
            "function",
            "leaf",
            json!("ns"),
        )],
    );

    let current = CurrentFieldAssociations::from_normalization(&inverse);
    let plain = build_v3_openai_responses_standard_request_from_chat_canonical(&payload)
        .expect("observer-free Responses builder succeeds");
    let (declared, mappings) =
        build_v3_openai_responses_standard_request_from_chat_canonical_with_declarations(
            &payload, &inverse, &current,
        )
        .expect("declared Responses builder succeeds");

    assert_eq!(plain, declared);
    assert_eq!(mappings.len(), 1);
}

#[test]
fn responses_emission_omits_filtered_hosted_search_association() {
    let payload = json!({
        "messages": [],
        "tools": [
            {"type": "web_search"},
            {"type": "function", "name": "keep", "parameters": {"type": "object"}}
        ]
    });
    let inverse = inverse(
        vec![
            mapping("request.tools[0]", "chat.tools[0]"),
            mapping("request.tools[1]", "chat.tools[1]"),
        ],
        vec![
            declaration(
                "r-search",
                "request.tools[0]",
                "web_search",
                "web_search",
                json!(null),
            ),
            declaration(
                "r-keep",
                "request.tools[1]",
                "function",
                "keep",
                json!(null),
            ),
        ],
    );
    let current = CurrentFieldAssociations::from_normalization(&inverse);
    let mut observer = StandardOutboundDeclarationObserver::new(&inverse, &current);

    let (wire, _) =
        build_v3_openai_responses_standard_request_for_selected_target_with_observer_and_drops(
            &payload,
            false,
            Some(&mut observer),
        )
        .expect("hosted search filtering must precede declaration recording");
    let mappings = observer.into_mappings();

    assert_eq!(wire["tools"].as_array().unwrap().len(), 1);
    assert_eq!(wire["tools"][0]["name"], "keep");
    assert_eq!(mappings.len(), 1);
    assert_eq!(mappings[0].declaration_record_id, "r-keep");
    assert_eq!(mappings[0].destination_path, "tools[0]");
}

#[test]
fn responses_emission_filters_hosted_search_once_and_preserves_controls_when_available() {
    use crate::operation_runner::{
        execute_v3_operation_runner_request_capture_client_json,
        execute_v3_operation_runner_request_normalize_losslessly, RequestInvocationContext,
        RequestNormalizationEntry, RequestOriginKind, V3RequestContextHandle,
    };

    let raw = json!({
        "model": "client-model",
        "input": [{"role": "user", "content": "Use declared tools"}],
        "tools": [
            {"type": "web_search"},
            {
                "type": "namespace",
                "name": "ns",
                "tools": [
                    {"type": "custom", "name": "apply_patch", "format": {"type": "text"}},
                    {
                        "type": "function",
                        "name": "lookup",
                        "parameters": {
                            "type": "object",
                            "properties": {"q": {"type": "string"}}
                        }
                    }
                ]
            }
        ],
        "tool_choice": {"type": "web_search"},
        "web_search_options": {"search_context_size": "low"}
    });
    let handle = V3RequestContextHandle::new("responses-controls".into(), "responses".into());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "responses-controls-invocation".into(),
        "responses-controls-attempt".into(),
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
    let original_canonical = canonical.clone();
    let working_view =
        crate::operation_runner::project_canonical_standard_view(&canonical).unwrap();
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);

    let mut unavailable_observer =
        StandardOutboundDeclarationObserver::new(&pair.inverse_context, &current);
    let (unavailable, _) =
        build_v3_openai_responses_standard_request_for_selected_target_with_observer_and_drops(
            &working_view,
            false,
            Some(&mut unavailable_observer),
        )
        .expect("hosted search filtering must remain the only tools filter");
    let unavailable_mappings = unavailable_observer.into_mappings();

    assert_eq!(
        canonical, original_canonical,
        "hosted search and control cleanup must not modify the request canonical"
    );
    assert_eq!(unavailable["tools"].as_array().unwrap().len(), 2);
    assert_eq!(unavailable["tools"][0]["type"], "function");
    assert_eq!(unavailable["tools"][0]["name"], "ns__apply_patch");
    assert_eq!(unavailable["tools"][1]["type"], "function");
    assert_eq!(unavailable["tools"][1]["name"], "ns__lookup");
    assert_eq!(
        unavailable["tools"][1]["parameters"]["properties"]["q"]["type"], "string",
        "the complete surviving schema must remain on the provider wire"
    );
    assert!(unavailable.get("tool_choice").is_none());
    assert!(unavailable.get("web_search_options").is_none());
    assert_eq!(unavailable_mappings.len(), 2);

    let patch_source = "request.tools[1].tools[0]";
    let lookup_source = "request.tools[1].tools[1]";
    let patch_original = pair
        .inverse_context
        .tool_declarations
        .iter()
        .find(|declaration| declaration.source_path == patch_source)
        .expect("SDK inverse must contain the nested custom declaration");
    let lookup_original = pair
        .inverse_context
        .tool_declarations
        .iter()
        .find(|declaration| declaration.source_path == lookup_source)
        .expect("SDK inverse must contain the nested function declaration");
    let patch = unavailable_mappings
        .iter()
        .find(|mapping| mapping.destination_path == "tools[0]")
        .expect("nested custom child must be recorded after hosted filtering");
    let lookup = unavailable_mappings
        .iter()
        .find(|mapping| mapping.destination_path == "tools[1]")
        .expect("nested function child must be recorded after hosted filtering");
    assert_eq!(patch.declaration_record_id, patch_original.record_id);
    assert_eq!(patch.source_path, patch_source);
    assert_eq!(patch.emitted_kind, "function");
    assert_eq!(patch.emitted_name.as_deref(), Some("ns__apply_patch"));
    assert_eq!(patch.emitted_namespace, None);
    assert_eq!(lookup.declaration_record_id, lookup_original.record_id);
    assert_eq!(lookup.source_path, lookup_source);
    assert_eq!(lookup.emitted_kind, "function");
    assert_eq!(lookup.emitted_name.as_deref(), Some("ns__lookup"));
    assert_eq!(lookup.emitted_namespace, None);

    let (available, available_mappings) =
        build_v3_openai_responses_standard_request_from_chat_canonical_with_declarations(
            &canonical,
            &pair.inverse_context,
            &current,
        )
        .expect("available hosted search must remain on the standard Responses wire");
    assert_eq!(available["tools"].as_array().unwrap().len(), 3);
    assert_eq!(available["tools"][0]["type"], "web_search");
    assert_eq!(available["tools"][1]["type"], "function");
    assert_eq!(available["tools"][1]["name"], "ns__apply_patch");
    assert_eq!(available["tools"][2]["type"], "function");
    assert_eq!(available["tools"][2]["name"], "ns__lookup");
    assert_eq!(available["tool_choice"], json!({"type": "web_search"}));
    assert_eq!(
        available["web_search_options"],
        json!({"search_context_size": "low"})
    );
    assert_eq!(available_mappings.len(), 2);
    assert!(
        available_mappings
            .iter()
            .all(|mapping| mapping.destination_path != "tools[0]"),
        "hosted search itself must not invent a declaration association"
    );
    assert_eq!(
        available_mappings[0].declaration_record_id,
        patch_original.record_id
    );
    assert_eq!(available_mappings[0].destination_path, "tools[1]");
    assert_eq!(
        available_mappings[1].declaration_record_id,
        lookup_original.record_id
    );
    assert_eq!(available_mappings[1].destination_path, "tools[2]");
}

#[test]
fn responses_emission_does_not_invent_record_for_new_discovered_tool() {
    let payload = json!({
        "messages": [],
        "tools": [{"type": "function", "name": "discovered", "parameters": {"type": "object"}}]
    });
    let inverse = inverse(Vec::new(), Vec::new());
    let current = CurrentFieldAssociations::from_normalization(&inverse);

    let (wire, mappings) =
        build_v3_openai_responses_standard_request_from_chat_canonical_with_declarations(
            &payload, &inverse, &current,
        )
        .expect("new discovered tool must still be emitted");

    assert_eq!(wire["tools"].as_array().unwrap().len(), 1);
    assert!(
        mappings.is_empty(),
        "a declaration without an original inverse record must not invent one"
    );
}

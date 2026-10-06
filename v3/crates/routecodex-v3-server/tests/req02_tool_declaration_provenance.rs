use routecodex_v3_runtime::operation_runner::{
    execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, RequestInvocationContext,
    RequestNormalizationEntry, RequestOriginKind, RequestScopedContextPair,
    ToolDeclarationReference, V3RequestContextHandle,
};
use serde_json::{json, Value};

#[test]
fn embedded_declarations_keep_their_history_source_and_destination() {
    let discovered = json!({"type": "namespace", "name": "functions", "tools": [
        {"type": "function", "name": "exec", "parameters": {"type": "object"}},
        {"type": "custom", "name": "apply_patch", "format": {"type": "text"}}
    ]});
    let raw = json!({"model": "client-model", "tools": [{"type": "tool_search"}],
    "input": [
        {"type": "tool_search_call", "call_id": "search", "arguments": {}},
        {"type": "tool_search_output", "call_id": "search", "tools": [discovered.clone()]}
    ]});
    let (_handle, canonical, pair) = normalize_raw("responses", "req02-embedded-source", raw);
    assert_eq!(
        canonical["tools"],
        json!([{"type": "tool_search"}]),
        "inbound must preserve the original declaration domains"
    );
    assert_eq!(canonical["messages"][1]["tools"][0], discovered);
    for (index, kind, name) in [(0, "function", "exec"), (1, "custom", "apply_patch")] {
        let source = format!("request.input[1].tools[0].tools[{index}]");
        let declaration = declaration_by_source(&pair, &source);
        assert_eq!(declaration.kind, kind);
        assert_eq!(declaration.name.as_deref(), Some(name));
        assert_eq!(declaration.namespace, Some(json!("functions")));
        let mapping = pair
            .inverse_context
            .field_mappings
            .iter()
            .find(|mapping| mapping.source_path == source)
            .expect("exact embedded mapping");
        assert_eq!(
            mapping.destination,
            format!("chat.messages[1].tools[0].tools[{index}]")
        );
        assert_eq!(
            mapping.operator,
            "routecodex.v3.field.tool_declaration_transform@1"
        );
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
    let captured = execute_v3_operation_runner_request_capture_client_json(raw.clone())
        .expect("public capture entry must accept the real client JSON value");
    assert_eq!(
        captured, raw,
        "public capture entry must preserve the exact client JSON value"
    );
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

fn opaque_record_by_id<'a>(canonical: &'a Value, record_id: &str) -> &'a Value {
    canonical["routecodex_chat_extension"]["chat_extension_opaque_record"]
        .as_array()
        .expect("canonical root must carry the opaque record array")
        .iter()
        .find(|record| record["record_id"] == record_id)
        .unwrap_or_else(|| panic!("missing opaque record id `{record_id}`"))
}

fn assert_provenance(
    pair: &RequestScopedContextPair,
    canonical: &Value,
    source_path: &str,
    destination: &str,
    kind: &str,
    name: Option<&str>,
    namespace: Option<&Value>,
    expected_value: &Value,
) {
    let declaration = declaration_by_source(pair, source_path);
    assert_eq!(declaration.kind, kind, "declaration kind at {source_path}");
    assert_eq!(
        declaration.name.as_deref(),
        name,
        "declaration name at {source_path}"
    );
    assert_eq!(
        declaration.namespace.as_ref(),
        namespace,
        "declaration namespace at {source_path}"
    );
    assert_eq!(
        declaration.encoding, "json",
        "declaration encoding at {source_path}"
    );

    let mapping = pair
        .inverse_context
        .field_mappings
        .iter()
        .find(|mapping| mapping.source_path == source_path)
        .unwrap_or_else(|| panic!("missing field mapping provenance for `{source_path}`"));
    assert_eq!(
        mapping.destination, destination,
        "canonical destination for {source_path}"
    );
    assert_eq!(
        mapping.operator, "routecodex.v3.field.tool_declaration_transform@1",
        "registered tool-declaration operator at {source_path}"
    );
    assert_eq!(
        mapping.encoding, "json",
        "mapping encoding at {source_path}"
    );
    let Some(destination) = destination.strip_prefix("chat.tools[") else {
        panic!("tool declaration provenance must target chat.tools[]: {destination}");
    };
    let (index_text, suffix) = destination.split_once(']').unwrap_or_else(|| {
        panic!("tool declaration provenance must target chat.tools[]: {destination}")
    });
    let canonical_index = index_text.parse::<usize>().unwrap_or_else(|_| {
        panic!("tool declaration provenance destination must have an array index: {destination}")
    });
    let mut canonical_declaration = canonical["tools"]
        .as_array()
        .and_then(|tools| tools.get(canonical_index))
        .unwrap_or_else(|| {
            panic!("mapping destination index must exist in emitted canonical tools")
        });
    if !suffix.is_empty() {
        let child = suffix
            .strip_prefix(".tools[")
            .and_then(|value| value.strip_suffix(']'))
            .expect("namespace child destination")
            .parse::<usize>()
            .unwrap();
        canonical_declaration = &canonical_declaration["tools"][child];
    }
    assert!(canonical_declaration.is_object());

    let record = opaque_record_by_id(canonical, &declaration.record_id);
    assert_eq!(record["path"], source_path);
    assert_eq!(
        record["value"], *expected_value,
        "opaque source declaration at {source_path}"
    );
}

#[test]
fn four_protocol_tool_declarations_emit_source_to_canonical_provenance() {
    let openai_function = json!({
        "type": "function",
        "function": {"name": "lookup", "parameters": {"type": "object"}}
    });
    let anthropic_function = json!({
        "name": "lookup",
        "description": "Claude lookup",
        "input_schema": {"type": "object"}
    });
    let responses_function = json!({
        "type": "function",
        "namespace": "server",
        "name": "lookup",
        "parameters": {"type": "object"}
    });
    let gemini_function = json!({
        "name": "lookup",
        "parameters": {"type": "object"}
    });

    let cases = [
        (
            "openai-chat",
            "req02-prov-openai",
            json!({"model": "chat-model", "messages": [], "tools": [openai_function.clone()]}),
            "request.tools[0]",
            Some("lookup"),
            None,
            &openai_function,
        ),
        (
            "anthropic",
            "req02-prov-anthropic",
            json!({"model": "claude", "max_tokens": 1, "messages": [], "tools": [anthropic_function.clone()]}),
            "request.tools[0]",
            Some("lookup"),
            None,
            &anthropic_function,
        ),
        (
            "responses",
            "req02-prov-responses",
            json!({"model": "responses-model", "input": [], "tools": [responses_function.clone()]}),
            "request.tools[0]",
            Some("lookup"),
            Some(&json!("server")),
            &responses_function,
        ),
        (
            "gemini",
            "req02-prov-gemini",
            json!({"model": "gemini", "contents": [], "tools": [{"functionDeclarations": [gemini_function.clone()]}]}),
            "request.tools[0].functionDeclarations[0]",
            Some("lookup"),
            None,
            &gemini_function,
        ),
    ];

    for (protocol, request_id, raw, source_path, name, namespace, expected) in cases {
        let (_handle, canonical, pair) = normalize_raw(protocol, request_id, raw);
        assert_provenance(
            &pair,
            &canonical,
            source_path,
            "chat.tools[0]",
            "function",
            name,
            namespace,
            expected,
        );
        assert_eq!(
            canonical["tools"][0]
                .get("function")
                .unwrap_or(&canonical["tools"][0])["name"],
            "lookup",
            "{protocol} emitted canonical declaration must match its mapping destination"
        );
    }
}

#[test]
fn responses_namespace_children_provenance_keeps_repeated_names_and_different_schemas() {
    let namespace = json!("demo");
    let lookup_a = json!({
        "type": "function",
        "name": "lookup",
        "parameters": {"type": "object", "properties": {"q": {"type": "string"}}}
    });
    let lookup_b = json!({
        "type": "custom",
        "name": "lookup",
        "input_schema": {"type": "object", "properties": {"x": {"type": "integer"}}}
    });
    let container = json!({
        "type": "namespace",
        "name": "demo",
        "tools": [lookup_a.clone(), lookup_b.clone()]
    });
    let raw = json!({"model": "responses-model", "input": [], "tools": [container.clone()]});

    let (_handle, canonical, pair) =
        normalize_raw("responses", "req02-prov-namespace-children", raw);
    assert_eq!(
        canonical["tools"],
        json!([container.clone()]),
        "provenance must not flatten namespace payload"
    );
    assert_provenance(
        &pair,
        &canonical,
        "request.tools[0]",
        "chat.tools[0]",
        "namespace",
        Some("demo"),
        None,
        &container,
    );
    assert_provenance(
        &pair,
        &canonical,
        "request.tools[0].tools[0]",
        "chat.tools[0].tools[0]",
        "function",
        Some("lookup"),
        Some(&namespace),
        &lookup_a,
    );
    assert_provenance(
        &pair,
        &canonical,
        "request.tools[0].tools[1]",
        "chat.tools[0].tools[1]",
        "custom",
        Some("lookup"),
        Some(&namespace),
        &lookup_b,
    );
    assert_eq!(
        canonical["tools"][0]["tools"][0]["parameters"]["properties"]["q"],
        json!({"type": "string"}),
        "first repeated child must retain its own schema at its provenance destination"
    );
    assert_eq!(
        canonical["tools"][0]["tools"][1]["input_schema"]["properties"]["x"],
        json!({"type": "integer"}),
        "second repeated child must retain its own schema at its provenance destination"
    );
}

#[test]
fn gemini_multiple_containers_provenance_flattens_each_emitted_declaration() {
    let alpha = json!({"name": "alpha", "parameters": {"type": "object"}});
    let beta = json!({"name": "beta", "parameters": {"type": "object"}});
    let gamma = json!({"name": "gamma", "parameters": {"type": "object"}});
    let raw = json!({
        "model": "gemini",
        "contents": [],
        "tools": [
            {"functionDeclarations": [alpha.clone(), beta.clone()]},
            {"functionDeclarations": [gamma.clone()]}
        ]
    });

    let (_handle, canonical, pair) = normalize_raw("gemini", "req02-prov-gemini-multi", raw);
    assert_provenance(
        &pair,
        &canonical,
        "request.tools[0].functionDeclarations[0]",
        "chat.tools[0]",
        "function",
        Some("alpha"),
        None,
        &alpha,
    );
    assert_provenance(
        &pair,
        &canonical,
        "request.tools[0].functionDeclarations[1]",
        "chat.tools[1]",
        "function",
        Some("beta"),
        None,
        &beta,
    );
    assert_provenance(
        &pair,
        &canonical,
        "request.tools[1].functionDeclarations[0]",
        "chat.tools[2]",
        "function",
        Some("gamma"),
        None,
        &gamma,
    );
    assert_eq!(
        canonical["tools"][3],
        Value::Null,
        "non-function Gemini containers must not append a canonical declaration"
    );
}

#[test]
fn absent_null_and_string_responses_namespaces_do_not_claim_child_provenance() {
    let absent = json!({
        "type": "namespace",
        "name": "absent",
        "tools": [{"type": "function", "name": "lookup", "parameters": {"type": "object"}}]
    });
    let null_child = json!({
        "type": "namespace",
        "name": "null_child",
        "tools": [null]
    });
    let string_child = json!({
        "type": "namespace",
        "name": "string_child",
        "tools": ["opaque"]
    });
    let raw = json!({"model": "responses-model", "input": [], "tools": [absent.clone(), null_child.clone(), string_child.clone()]});

    let (_handle, canonical, pair) = normalize_raw("responses", "req02-prov-namespace-absent", raw);
    assert_provenance(
        &pair,
        &canonical,
        "request.tools[0]",
        "chat.tools[0]",
        "namespace",
        Some("absent"),
        None,
        &absent,
    );
    assert_provenance(
        &pair,
        &canonical,
        "request.tools[0].tools[0]",
        "chat.tools[0].tools[0]",
        "function",
        Some("lookup"),
        Some(&json!("absent")),
        &json!({"type": "function", "name": "lookup", "parameters": {"type": "object"}}),
    );
    assert_provenance(
        &pair,
        &canonical,
        "request.tools[1]",
        "chat.tools[1]",
        "namespace",
        Some("null_child"),
        None,
        &null_child,
    );
    assert_provenance(
        &pair,
        &canonical,
        "request.tools[2]",
        "chat.tools[2]",
        "namespace",
        Some("string_child"),
        None,
        &string_child,
    );
    assert!(
        pair.inverse_context
            .tool_declarations
            .iter()
            .all(|declaration| declaration.source_path != "request.tools[1].tools[0]"),
        "null namespace child must not be emitted as a canonical declaration"
    );
    assert!(
        pair.inverse_context
            .tool_declarations
            .iter()
            .all(|declaration| declaration.source_path != "request.tools[2].tools[0]"),
        "string namespace child must not be emitted as a canonical declaration"
    );
    assert_eq!(
        canonical["tools"][2]["tools"][0], "opaque",
        "string namespace child remains present without declaration provenance"
    );
}

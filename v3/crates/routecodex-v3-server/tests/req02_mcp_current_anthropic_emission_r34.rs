//! R34 black-box regression for the Anthropic wire emission of a discovered
//! MCP declaration.
//!
//! The test drives the real public SDK (capture -> normalize -> typed current
//! edit) and the real standard Anthropic projection consumer, then observes
//! the final `payload.tools` and the actual attempt declaration map. It never
//! constructs a private observer or inspects internal slots.

use routecodex_v3_config::{
    V3ProviderRequestCleanupAuthoringConfig, V3ResponsesTransportKind, V3WebSearchExecutionMode,
};
use routecodex_v3_runtime::hub_v1::{V3HubExecutionMode, V3HubProviderWireProtocol};
use routecodex_v3_runtime::operation_runner::{
    apply_canonical_field_edit, execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, project_canonical_request,
    CanonicalFieldEdit, CanonicalRequestProjection, CurrentFieldAssociations,
    RequestInvocationContext, RequestNormalizationEntry, RequestOriginKind,
    RequestScopedContextPair, ToolMappingReference, V3RequestContextHandle, V3TargetCandidate,
};
use serde_json::{json, Value};

fn target() -> V3TargetCandidate {
    V3TargetCandidate {
        provider_id: "provider".to_string(),
        provider_type: "anthropic".to_string(),
        auth_alias: "primary".to_string(),
        model_id: "provider-model".to_string(),
        wire_model: "provider-wire-model".to_string(),
        visible_model_ids: vec!["client-model".to_string()],
        model_capabilities: vec!["text".to_string(), "multimodal".to_string()],
        web_search_execution_mode: V3WebSearchExecutionMode::None,
        max_context_tokens: None,
        max_tokens: None,
        context_token_estimate_scale_bps: 10_000,
        base_url: "https://provider.invalid/v1".to_string(),
        responses_process: None,
        responses_transport: V3ResponsesTransportKind::Http,
        websocket_v2_url: None,
        provider_request_cleanup: V3ProviderRequestCleanupAuthoringConfig::default(),
        request_timeout_ms: 300_000,
        sse_first_frame_timeout_ms: None,
        initial_concurrency_budget: 8,
        concurrency_acquire_timeout_ms: 60_000,
        compatibility_profile: None,
        headers: Default::default(),
        env_name: Some("TEST_KEY".to_string()),
        token_file: None,
        secret_file: None,
        secret_key: None,
        api_key: None,
        required_capabilities: Vec::new(),
        priority: 0,
        weight: 1,
        pool_ids: vec!["default".to_string()],
        default_pool_member: true,
        path: vec!["provider".to_string()],
    }
}

/// A Responses request whose only client tool is the `tool_search` builtin and
/// whose discovery result carries one MCP namespace with two functions. The
/// namespace survives normalization as a `tool_search_output` Chat message.
fn discovered_raw() -> Value {
    json!({
        "model": "client-model",
        "tools": [{"type": "tool_search"}],
        "input": [
            {"type": "tool_search_call", "call_id": "search", "execution": "client",
             "arguments": {"query": "probe"}},
            {"type": "tool_search_output", "call_id": "search", "execution": "client",
             "tools": [{"type": "namespace", "name": "mcp__probe", "tools": [
                 {"type": "function", "name": "echo", "parameters": {
                     "type": "object", "properties": {"text": {"type": "string"}},
                     "required": ["text"]
                 }},
                 {"type": "function", "name": "ping", "parameters": {
                     "type": "object", "properties": {"count": {"type": "integer"}},
                     "required": ["count"]
                 }}
             ]}]}
        ]
    })
}

fn sdk_request(raw: Value) -> (Value, RequestScopedContextPair, CurrentFieldAssociations) {
    let handle = V3RequestContextHandle::new("r34-mcp-emission".into(), "responses".into());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "r34-invocation".into(),
        "r34-attempt".into(),
        RequestOriginKind::ClientEntry,
    );
    let captured =
        execute_v3_operation_runner_request_capture_client_json(raw).expect("real SDK capture");
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .expect("real SDK normalize");
    let pair = handle.original_pair().expect("original pair");
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    (canonical, pair, current)
}

fn project(
    canonical: &Value,
    pair: &RequestScopedContextPair,
    current: &CurrentFieldAssociations,
) -> CanonicalRequestProjection {
    project_canonical_request(
        canonical,
        &pair.inverse_context,
        current,
        &pair.explicit_history_pairing,
        V3HubExecutionMode::Relay,
        V3HubProviderWireProtocol::Anthropic,
        &target(),
        "r34-anthropic",
    )
    .expect("standard Anthropic projection must consume the request")
}

fn declaration_id(pair: &RequestScopedContextPair, source_path: &str) -> String {
    pair.inverse_context
        .tool_declarations
        .iter()
        .find(|declaration| declaration.source_path == source_path)
        .unwrap_or_else(|| panic!("missing original declaration for {source_path}"))
        .record_id
        .clone()
}

fn mapping_for<'a>(
    mappings: &'a [ToolMappingReference],
    declaration_record_id: &str,
) -> Option<&'a ToolMappingReference> {
    mappings
        .iter()
        .find(|mapping| mapping.declaration_record_id == declaration_record_id)
}

fn tool_named<'a>(payload: &'a Value, name: &str) -> Option<&'a Value> {
    payload
        .get("tools")
        .and_then(Value::as_array)?
        .iter()
        .find(|tool| tool.get("name").and_then(Value::as_str) == Some(name))
}

fn emitted_names(payload: &Value) -> Vec<&str> {
    payload
        .get("tools")
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| tool.get("name").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn discovered_mcp_namespace_reaches_anthropic_wire_with_full_schema_and_original_record() {
    let (canonical, pair, current) = sdk_request(discovered_raw());
    let echo = declaration_id(&pair, "request.input[1].tools[0].tools[0]");
    let projected = project(&canonical, &pair, &current);

    let echo_tool = tool_named(&projected.payload, "mcp__probe__echo").unwrap_or_else(|| {
        panic!(
            "the discovered MCP declaration must reach the Anthropic wire: {}",
            projected.payload
        )
    });
    assert_eq!(
        echo_tool["input_schema"],
        json!({
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"]
        }),
        "the full discovered MCP schema must be emitted, not a bare object"
    );

    let mapping = mapping_for(&projected.attempt.declarations.tool_mappings, &echo)
        .expect("the actual emitted declaration must map back to the original record");
    assert_eq!(mapping.source_path, "request.input[1].tools[0].tools[0]");
    assert_eq!(mapping.emitted_name.as_deref(), Some("mcp__probe__echo"));

    // The original tools-only case must not weaken: the native `tool_search`
    // declaration stays emitted and keeps its own original record.
    let tool_search = tool_named(&projected.payload, "tool_search")
        .expect("the tools-only builtin must stay on the wire");
    assert_eq!(tool_search["input_schema"], json!({"type": "object"}));
    let search = declaration_id(&pair, "request.tools[0]");
    assert!(
        mapping_for(&projected.attempt.declarations.tool_mappings, &search).is_some(),
        "the native tools-only declaration must stay mapped"
    );
}

#[test]
fn current_schema_replacement_emits_new_schema_and_keeps_the_original_record() {
    let (canonical, pair, current) = sdk_request(discovered_raw());
    let echo = declaration_id(&pair, "request.input[1].tools[0].tools[0]");
    let (canonical, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::Replace {
            path: "chat.messages[1].tools[0].tools[0].parameters".to_string(),
            value: json!({
                "type": "object",
                "properties": {"text": {"type": "string"}, "lang": {"type": "string"}},
                "required": ["text", "lang"]
            }),
        },
    )
    .expect("typed schema replacement");

    let projected = project(&canonical, &pair, &current);
    let echo_tool = tool_named(&projected.payload, "mcp__probe__echo")
        .expect("the replaced declaration must still emit");
    assert_eq!(
        echo_tool["input_schema"]["properties"]["lang"],
        json!({"type": "string"}),
        "the actual wire schema must follow the current declaration"
    );
    let mapping = mapping_for(&projected.attempt.declarations.tool_mappings, &echo)
        .expect("replacement must keep the original record identity");
    assert_eq!(mapping.source_path, "request.input[1].tools[0].tools[0]");
    assert_eq!(mapping.emitted_name.as_deref(), Some("mcp__probe__echo"));
}

#[test]
fn current_removal_drops_the_discovered_tool_and_its_map() {
    let (canonical, pair, current) = sdk_request(discovered_raw());
    let echo = declaration_id(&pair, "request.input[1].tools[0].tools[0]");
    let ping = declaration_id(&pair, "request.input[1].tools[0].tools[1]");
    let (canonical, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::Remove {
            path: "chat.messages[1].tools[0].tools[0]".to_string(),
        },
    )
    .expect("typed removal");

    let projected = project(&canonical, &pair, &current);
    assert!(
        tool_named(&projected.payload, "mcp__probe__echo").is_none(),
        "a removed declaration must not be emitted: {}",
        projected.payload
    );
    assert!(
        tool_named(&projected.payload, "mcp__probe__ping").is_some(),
        "the surviving discovered declaration must stay emitted"
    );
    assert!(
        mapping_for(&projected.attempt.declarations.tool_mappings, &echo).is_none(),
        "a removed declaration must not keep a stale map"
    );
    let ping_mapping = mapping_for(&projected.attempt.declarations.tool_mappings, &ping)
        .expect("the survivor must map to its own original record");
    assert_eq!(
        ping_mapping.source_path,
        "request.input[1].tools[0].tools[1]"
    );
    assert_eq!(
        ping_mapping.emitted_name.as_deref(),
        Some("mcp__probe__ping")
    );
}

#[test]
fn current_move_follows_the_original_records() {
    let (canonical, pair, current) = sdk_request(discovered_raw());
    let echo = declaration_id(&pair, "request.input[1].tools[0].tools[0]");
    let ping = declaration_id(&pair, "request.input[1].tools[0].tools[1]");
    let (canonical, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::MoveArray {
            array_path: "chat.messages[1].tools[0].tools".to_string(),
            from: 0,
            to: 1,
        },
    )
    .expect("typed move");

    let projected = project(&canonical, &pair, &current);
    assert_eq!(
        emitted_names(&projected.payload),
        vec!["tool_search", "mcp__probe__ping", "mcp__probe__echo"],
        "the wire order must follow the current declaration order"
    );
    let ping_mapping = mapping_for(&projected.attempt.declarations.tool_mappings, &ping)
        .expect("the moved declaration must keep its own original record");
    let echo_mapping = mapping_for(&projected.attempt.declarations.tool_mappings, &echo)
        .expect("the shifted declaration must keep its own original record");
    assert_eq!(ping_mapping.destination_path, "tools[1]");
    assert_eq!(echo_mapping.destination_path, "tools[2]");
    assert_eq!(
        ping_mapping.source_path,
        "request.input[1].tools[0].tools[1]"
    );
    assert_eq!(
        echo_mapping.source_path,
        "request.input[1].tools[0].tools[0]"
    );
}

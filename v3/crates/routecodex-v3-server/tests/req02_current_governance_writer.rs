//! Public consumer coverage for the REQ02 current-source governance writer.
//!
//! The exercised chain is the real public SDK entry, not a private helper:
//! `execute_v3_operation_runner_request_capture_client_json`
//! -> `execute_v3_operation_runner_request_normalize_losslessly`
//! -> `govern_v3_operation_runner_current_request_fields`
//! -> `project_canonical_direct_request` with the real original pair/current
//! -> `publish_successful_attempt`
//! -> `project_v3_openai_chat_response_as_responses_with_successful_attempt`.

use routecodex_v3_runtime::operation_runner::{
    execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, project_canonical_direct_request,
    AttemptContext, AttemptDeclarationMap, AttemptProjectionContext, CanonicalFieldEdit,
    CurrentFieldAssociations, DirectRequestProjection, RequestInvocationContext,
    RequestNormalizationEntry, RequestOriginKind, RequestScopedContextPair, ResponseProjectionView,
    ToolMappingReference, V3RequestContextHandle,
};
use routecodex_v3_runtime::{
    govern_v3_operation_runner_current_request_fields,
    project_v3_openai_chat_response_as_responses_with_successful_attempt,
};
use serde_json::{json, Value};

fn normalize(request_id: &str, raw: &Value) -> (Value, V3RequestContextHandle) {
    let handle = V3RequestContextHandle::new(request_id.to_string(), "responses".to_string());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        format!("{request_id}-invocation"),
        format!("{request_id}-attempt"),
        RequestOriginKind::ClientEntry,
    );
    let captured = execute_v3_operation_runner_request_capture_client_json(raw.clone())
        .expect("public SDK capture accepts real client JSON");
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .expect("public SDK normalize executes REQ02 losslessly");
    (canonical, handle)
}

fn tool_container(children: Vec<Value>) -> Value {
    json!({
        "model": "responses-model",
        "input": [],
        "tools": [{"type": "namespace", "name": "functions", "tools": children}]
    })
}

fn apply_patch_tool() -> Value {
    json!({"type": "custom", "name": "apply_patch", "format": {"type": "text"}})
}

fn exec_tool() -> Value {
    json!({"type": "function", "name": "exec", "parameters": {"type": "object"}})
}

fn governed(
    canonical: &Value,
    handle: &V3RequestContextHandle,
    origin: RequestOriginKind,
    invocation_id: &str,
    attempt_id: &str,
    edits: Vec<CanonicalFieldEdit>,
) -> Result<Value, String> {
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        invocation_id.to_string(),
        attempt_id.to_string(),
        origin,
    );
    govern_v3_operation_runner_current_request_fields(canonical, &invocation, edits.as_slice())
}

fn project(
    canonical: &Value,
    pair: &RequestScopedContextPair,
    current: &CurrentFieldAssociations,
) -> DirectRequestProjection {
    project_canonical_direct_request(
        canonical,
        &pair.inverse_context,
        current,
        &pair.explicit_history_pairing,
    )
    .expect("public Direct inverse consumes governed data")
}

fn mapping_index(pair: &RequestScopedContextPair, source_path: &str) -> usize {
    pair.inverse_context
        .field_mappings
        .iter()
        .position(|mapping| mapping.source_path == source_path)
        .unwrap_or_else(|| panic!("missing field mapping for `{source_path}`"))
}

fn declaration_kind(pair: &RequestScopedContextPair, source_path: &str) -> String {
    pair.inverse_context
        .tool_declarations
        .iter()
        .find(|declaration| declaration.source_path == source_path)
        .unwrap_or_else(|| panic!("missing tool declaration for `{source_path}`"))
        .kind
        .clone()
}

fn canonical_tool_call_by_id<'a>(canonical: &'a Value, call_id: &str) -> &'a Value {
    canonical["messages"]
        .as_array()
        .expect("canonical messages are an array")
        .iter()
        .find_map(|message| {
            message["tool_calls"]
                .as_array()
                .and_then(|calls| calls.iter().find(|call| call["id"] == call_id))
        })
        .unwrap_or_else(|| panic!("missing canonical tool call `{call_id}`"))
}

fn publish_attempt(
    handle: &V3RequestContextHandle,
    attempt_id: &str,
    mappings: Vec<ToolMappingReference>,
) -> AttemptContext {
    let attempt = AttemptContext {
        attempt_id: attempt_id.to_string(),
        projection: AttemptProjectionContext {
            attempt_id: attempt_id.to_string(),
            provider_protocol: "chat".to_string(),
            provider_model: "model".to_string(),
            paths: Vec::new(),
        },
        declarations: AttemptDeclarationMap {
            attempt_id: attempt_id.to_string(),
            provider_protocol: "chat".to_string(),
            provider_model: "model".to_string(),
            tool_mappings: mappings,
        },
    };
    handle
        .publish_successful_attempt(attempt.clone())
        .expect("publish successful attempt");
    attempt
}

fn chat_response_inverse(
    handle: &V3RequestContextHandle,
    attempt: &AttemptContext,
    provider_response: &Value,
) -> Value {
    let view = ResponseProjectionView::from_successful_attempt(handle, attempt)
        .expect("successful attempt view");
    project_v3_openai_chat_response_as_responses_with_successful_attempt(provider_response, &view)
        .expect("public Chat response inverse")
}

fn declaration_namespace(pair: &RequestScopedContextPair, source_path: &str) -> Option<Value> {
    pair.inverse_context
        .tool_declarations
        .iter()
        .find(|declaration| declaration.source_path == source_path)
        .unwrap_or_else(|| panic!("missing tool declaration for `{source_path}`"))
        .namespace
        .clone()
}

#[test]
fn current_governance_writer_zero_edit_is_exact_transparent() {
    let raw = tool_container(vec![apply_patch_tool(), exec_tool()]);
    let (canonical, handle) = normalize("zero", &raw);

    let governed = governed(
        &canonical,
        &handle,
        RequestOriginKind::ClientEntry,
        "zero-invocation",
        "zero-attempt",
        vec![],
    )
    .expect("zero edits publish only current associations");
    assert_eq!(
        governed, canonical,
        "zero-edit governance must be exactly transparent"
    );

    let pair = handle.original_pair().expect("original pair");
    let current = handle
        .current_field_associations()
        .expect("zero-edit publishes current associations");
    let projected = project(&governed, &pair, &current);
    assert_eq!(
        projected.payload, raw,
        "the zero-edit current layout equals the raw layout"
    );

    let attempt = publish_attempt(&handle, "zero-attempt", projected.declarations);
    let inverse = chat_response_inverse(
        &handle,
        &attempt,
        &json!({
            "id": "resp",
            "object": "chat.completion",
            "created": 1,
            "model": "model",
            "choices": [{"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": "ok"}}]
        }),
    );
    assert!(inverse["output"].is_array());
}

#[test]
fn current_governance_writer_consecutive_deletes_shift_current_sources() {
    let mcp = json!({"type": "custom", "name": "mcp_read", "input_schema": {"type": "object"}});
    let raw = tool_container(vec![apply_patch_tool(), exec_tool(), mcp.clone()]);
    let (canonical, handle) = normalize("deletes", &raw);

    let governed = governed(
        &canonical,
        &handle,
        RequestOriginKind::ClientEntry,
        "deletes-invocation",
        "deletes-attempt",
        vec![
            CanonicalFieldEdit::Remove {
                path: "chat.tools[0].tools[0]".to_string(),
            },
            CanonicalFieldEdit::Remove {
                path: "chat.tools[0].tools[0]".to_string(),
            },
        ],
    )
    .expect("serial deletes keep data and source references paired");

    assert_eq!(governed["tools"][0]["tools"], json!([mcp.clone()]));
    let pair = handle.original_pair().expect("original pair");
    let current = handle
        .current_field_associations()
        .expect("deletes publish current associations");
    let projected = project(&governed, &pair, &current);
    assert_eq!(
        projected.payload,
        tool_container(vec![mcp]),
        "the current projected layout reflects the intentional removals"
    );
    assert_ne!(projected.payload, raw);
    assert_eq!(
        pair.inverse_context.tool_declarations.len(),
        4,
        "the immutable original pair keeps every declaration"
    );
    assert_eq!(
        current.destination_for_original_mapping(mapping_index(&pair, "request.tools[0].tools[2]")),
        Some("chat.tools[0].tools[0]")
    );
    assert_eq!(
        current.destination_for_original_mapping(mapping_index(&pair, "request.tools[0].tools[0]")),
        None
    );
    assert_eq!(
        current.destination_for_original_mapping(mapping_index(&pair, "request.tools[0].tools[1]")),
        None
    );
}

#[test]
fn current_governance_writer_insert_and_move_do_not_invent_sources() {
    let exec = exec_tool();
    let patch = apply_patch_tool();
    let raw = tool_container(vec![patch.clone(), exec.clone()]);
    let (canonical, handle) = normalize("move", &raw);

    let governed = governed(
        &canonical,
        &handle,
        RequestOriginKind::ClientEntry,
        "move-invocation",
        "move-attempt",
        vec![
            CanonicalFieldEdit::InsertArray {
                array_path: "chat.tools[0].tools".to_string(),
                index: 0,
                value: json!({"type": "function", "name": "new"}),
            },
            CanonicalFieldEdit::MoveArray {
                array_path: "chat.tools[0].tools".to_string(),
                from: 1,
                to: 2,
            },
        ],
    )
    .expect("insert and move execute serially");

    assert_eq!(
        governed["tools"][0]["tools"],
        json!([
            json!({"type": "function", "name": "new"}),
            exec.clone(),
            patch.clone()
        ])
    );
    let pair = handle.original_pair().expect("original pair");
    let current = handle
        .current_field_associations()
        .expect("insert and move publish current associations");
    let projected = project(&governed, &pair, &current);
    assert_eq!(
        projected.payload["tools"][0]["tools"],
        json!([json!({"type": "function", "name": "new"}), exec, patch]),
        "the inserted element keeps its own value and the moved descendants keep their bytes"
    );
    assert!(
        current
            .original_mapping_indices_for_destination("chat.tools[0].tools[0]")
            .is_empty(),
        "an inserted element must not invent an original source"
    );
    assert_eq!(
        current.destination_for_original_mapping(mapping_index(&pair, "request.tools[0].tools[1]")),
        Some("chat.tools[0].tools[1]")
    );
    assert_eq!(
        current.destination_for_original_mapping(mapping_index(&pair, "request.tools[0].tools[0]")),
        Some("chat.tools[0].tools[2]")
    );
    assert!(!projected
        .declarations
        .iter()
        .any(|mapping| mapping.source_path == "request.tools[0].tools[3]"));
}

#[test]
fn current_governance_writer_nested_same_name_kinds_keep_distinct_destinations() {
    let schema = json!({"type": "object", "properties": {"value": {"type": "string"}}});
    let custom = json!({"type": "custom", "name": "shared", "input_schema": schema.clone()});
    let function = json!({"type": "function", "name": "shared", "parameters": schema.clone()});
    let raw = json!({
        "model": "responses-model",
        "input": [],
        "tools": [{
            "type": "namespace",
            "name": "shared",
            "tools": [custom.clone(), function.clone()]
        }]
    });
    let (canonical, handle) = normalize("nested", &raw);
    let pair = handle.original_pair().expect("original pair");
    assert_eq!(declaration_kind(&pair, "request.tools[0]"), "namespace");
    assert_eq!(
        declaration_kind(&pair, "request.tools[0].tools[0]"),
        "custom"
    );
    assert_eq!(
        declaration_kind(&pair, "request.tools[0].tools[1]"),
        "function"
    );
    let custom_index = mapping_index(&pair, "request.tools[0].tools[0]");

    let governed = governed(
        &canonical,
        &handle,
        RequestOriginKind::ClientEntry,
        "nested-invocation",
        "nested-attempt",
        vec![],
    )
    .expect("zero edits publish current associations");
    let current = handle.current_field_associations().expect("current");
    let projected = project(&governed, &pair, &current);
    assert_eq!(
        projected.payload, raw,
        "same-name declarations with distinct kinds stay distinguishable"
    );

    let governed = self::governed(
        &governed,
        &handle,
        RequestOriginKind::Retry,
        "nested-retry",
        "nested-attempt-2",
        vec![CanonicalFieldEdit::Remove {
            path: "chat.tools[0].tools[0]".to_string(),
        }],
    )
    .expect("remove the custom `shared` and keep the function `shared`");
    let current = handle.current_field_associations().expect("current");
    let projected = project(&governed, &pair, &current);
    assert_eq!(projected.payload["tools"][0]["tools"][0], function);
    assert_eq!(
        projected.payload["tools"][0]["tools"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        current.destination_for_original_mapping(custom_index),
        None,
        "the removed custom declaration loses its destination"
    );
    assert_eq!(
        current.destination_for_original_mapping(mapping_index(&pair, "request.tools[0].tools[1]")),
        Some("chat.tools[0].tools[0]")
    );
}

#[test]
fn current_governance_writer_preserves_complete_exec_patch_mcp_bytes() {
    let arguments = format!(
        "{{\"cmd\":\"echo\"}}\n{}REQ02_CURRENT_EXEC_TAIL",
        "x".repeat(70_000)
    );
    let patch = format!("*** Begin Patch\n+{}\n*** End Patch\n", "y".repeat(70_000));
    let mcp_input = format!("{}{}", "mcp".repeat(40_000), "REQ02_CURRENT_MCP_TAIL");
    let raw = json!({
        "model": "responses-model",
        "tools": [{"type": "namespace", "name": "functions", "tools": [apply_patch_tool(), exec_tool()]}],
        "input": [
            {"type": "function_call", "call_id": "call_exec", "name": "exec", "arguments": arguments},
            {"type": "custom_tool_call", "call_id": "call_patch", "name": "apply_patch", "input": patch},
            {"type": "custom_tool_call", "call_id": "call_mcp", "name": "mcp_read", "input": mcp_input}
        ]
    });
    let (canonical, handle) = normalize("strings", &raw);
    assert_eq!(
        canonical_tool_call_by_id(&canonical, "call_exec")["function"]["arguments"],
        json!(arguments)
    );
    assert_eq!(
        canonical_tool_call_by_id(&canonical, "call_patch")["custom"]["input"],
        json!(patch)
    );
    assert_eq!(
        canonical_tool_call_by_id(&canonical, "call_mcp")["custom"]["input"],
        json!(mcp_input)
    );

    let governed = governed(
        &canonical,
        &handle,
        RequestOriginKind::ClientEntry,
        "strings-invocation",
        "strings-attempt",
        vec![],
    )
    .expect("zero edits publish current associations");
    let pair = handle.original_pair().expect("original pair");
    let current = handle.current_field_associations().expect("current");
    let projected = project(&governed, &pair, &current);
    assert_eq!(
        projected.payload, raw,
        "the complete exec/patch/mcp argument and output bytes survive the zero-edit round trip"
    );

    let governed = self::governed(
        &governed,
        &handle,
        RequestOriginKind::Retry,
        "strings-retry",
        "strings-attempt-2",
        vec![CanonicalFieldEdit::Remove {
            path: "chat.tools[0].tools[0]".to_string(),
        }],
    )
    .expect("an unrelated tool removal must not touch long history bytes");
    assert_eq!(
        canonical_tool_call_by_id(&governed, "call_exec")["function"]["arguments"],
        json!(arguments)
    );
    assert_eq!(
        canonical_tool_call_by_id(&governed, "call_patch")["custom"]["input"],
        json!(patch)
    );
    assert_eq!(
        canonical_tool_call_by_id(&governed, "call_mcp")["custom"]["input"],
        json!(mcp_input)
    );
}

#[test]
fn current_governance_writer_request_slots_are_isolated() {
    let raw = tool_container(vec![apply_patch_tool(), exec_tool()]);
    let (canonical_a, handle_a) = normalize("isolation-a", &raw);
    let (canonical_b, handle_b) = normalize("isolation-b", &raw);
    assert!(handle_a
        .current_field_associations_option()
        .expect("active handle a")
        .is_none());
    assert!(handle_b
        .current_field_associations_option()
        .expect("active handle b")
        .is_none());

    let governed_a = governed(
        &canonical_a,
        &handle_a,
        RequestOriginKind::ClientEntry,
        "isolation-a-invocation",
        "isolation-a-attempt",
        vec![CanonicalFieldEdit::Remove {
            path: "chat.tools[0].tools[0]".to_string(),
        }],
    )
    .expect("govern request a");
    assert!(handle_a
        .current_field_associations_option()
        .expect("active handle a")
        .is_some());
    assert!(
        handle_b
            .current_field_associations_option()
            .expect("active handle b")
            .is_none(),
        "governing one request must not seed another request's current slot"
    );

    let governed_b = governed(
        &canonical_b,
        &handle_b,
        RequestOriginKind::ClientEntry,
        "isolation-b-invocation",
        "isolation-b-attempt",
        vec![],
    )
    .expect("govern request b");
    assert_eq!(governed_b, canonical_b);
    let pair_b = handle_b.original_pair().expect("original pair b");
    let current_b = handle_b.current_field_associations().expect("current b");
    assert_eq!(project(&governed_b, &pair_b, &current_b).payload, raw);
    assert_ne!(governed_a, governed_b);
}

#[test]
fn current_governance_writer_reentry_invocations_preserve_governed_addresses() {
    let exec = exec_tool();
    let raw = tool_container(vec![apply_patch_tool(), exec.clone()]);
    let (canonical, handle) = normalize("reentry", &raw);
    let pair = handle.original_pair().expect("original pair");
    let surviving_index = mapping_index(&pair, "request.tools[0].tools[1]");
    let removed_index = mapping_index(&pair, "request.tools[0].tools[0]");

    let first = governed(
        &canonical,
        &handle,
        RequestOriginKind::ClientEntry,
        "reentry-first",
        "attempt-1",
        vec![CanonicalFieldEdit::Remove {
            path: "chat.tools[0].tools[0]".to_string(),
        }],
    )
    .expect("client entry seeds and applies once");
    assert_eq!(
        handle
            .current_field_associations()
            .expect("current after seed")
            .destination_for_original_mapping(surviving_index),
        Some("chat.tools[0].tools[0]")
    );

    let second = governed(
        &first,
        &handle,
        RequestOriginKind::Retry,
        "reentry-retry",
        "attempt-2",
        vec![],
    )
    .expect("retry must consume the published current slot");
    let third = governed(
        &second,
        &handle,
        RequestOriginKind::InternalFollowup,
        "reentry-followup",
        "attempt-3",
        vec![],
    )
    .expect("followup must not reseed from normalization destinations");
    let fourth = governed(
        &third,
        &handle,
        RequestOriginKind::ClientEntry,
        "reentry-new-entry",
        "attempt-4",
        vec![],
    )
    .expect("a later client-entry invocation must reuse the already-governed slot");

    for (label, value) in [
        ("retry", &second),
        ("internal followup", &third),
        ("later client entry", &fourth),
    ] {
        assert_eq!(
            value["tools"][0]["tools"],
            json!([exec.clone()]),
            "{label} must preserve the already-governed source addresses"
        );
    }
    let current = handle.current_field_associations().expect("current");
    assert_eq!(
        current.destination_for_original_mapping(surviving_index),
        Some("chat.tools[0].tools[0]")
    );
    assert_eq!(
        current.destination_for_original_mapping(removed_index),
        None
    );
    assert_eq!(
        project(&fourth, &pair, &current).payload,
        tool_container(vec![exec])
    );
    assert_eq!(
        pair,
        handle.original_pair().expect("original pair"),
        "the original pair stays immutable across reentry"
    );
}

#[test]
fn current_governance_writer_failed_multi_edit_publishes_nothing() {
    let raw = tool_container(vec![exec_tool()]);
    let (canonical, handle) = normalize("failure", &raw);
    let published = governed(
        &canonical,
        &handle,
        RequestOriginKind::ClientEntry,
        "failure-seed",
        "attempt-1",
        vec![],
    )
    .expect("seed the published current slot");
    let before_current = handle.current_field_associations().expect("current before");
    let before_pair = handle.original_pair().expect("pair before");
    let before_canonical = canonical.clone();

    let error = governed(
        &published,
        &handle,
        RequestOriginKind::Retry,
        "failure-retry",
        "attempt-2",
        vec![
            CanonicalFieldEdit::Remove {
                path: "chat.tools[0].tools[0]".to_string(),
            },
            CanonicalFieldEdit::Remove {
                path: "chat.tools[0].tools[0]".to_string(),
            },
        ],
    )
    .expect_err("the second removal is invalid and must keep the real internal error");
    assert!(
        error.contains("missing"),
        "real internal error retained: {error}"
    );
    assert_eq!(
        handle.current_field_associations().expect("current after"),
        before_current,
        "a failed multi-edit must not publish a partial current slot"
    );
    assert_eq!(handle.original_pair().expect("pair after"), before_pair);
    assert_eq!(
        canonical, before_canonical,
        "the input canonical value is never mutated"
    );
    assert_eq!(
        project(&published, &before_pair, &before_current).payload,
        raw
    );
}

#[test]
fn current_governance_writer_missing_reentry_and_terminated_scope_keep_real_errors() {
    let (canonical, handle) = normalize("missing", &json!({"input": []}));
    assert!(handle
        .current_field_associations_option()
        .expect("active handle")
        .is_none());

    let retry = governed(
        &canonical,
        &handle,
        RequestOriginKind::Retry,
        "missing-retry",
        "missing-attempt",
        vec![],
    )
    .expect_err("a missing reentry current slot is a real error, not an empty association");
    assert!(
        retry.contains("no published current field associations"),
        "unexpected error: {retry}"
    );
    let followup = governed(
        &canonical,
        &handle,
        RequestOriginKind::InternalFollowup,
        "missing-followup",
        "missing-attempt-2",
        vec![],
    )
    .expect_err("a missing followup current slot is a real error");
    assert!(followup.contains("no published current field associations"));

    let guard = handle.take_finalizer().expect("take finalizer");
    guard.finalize().expect("release active request");
    let terminated = governed(
        &canonical,
        &handle,
        RequestOriginKind::ClientEntry,
        "terminated",
        "terminated-attempt",
        vec![],
    )
    .expect_err("a terminated handle must not be revived into a new current slot");
    assert!(
        terminated.contains("scope already released"),
        "unexpected error: {terminated}"
    );
    assert!(handle.current_field_associations_option().is_err());
    assert!(handle.original_pair().is_err());
}

#[test]
fn current_governance_writer_chat_response_inverse_uses_declared_emitted_names() {
    let raw = tool_container(vec![apply_patch_tool(), exec_tool()]);
    let (canonical, handle) = normalize("response", &raw);
    let governed = governed(
        &canonical,
        &handle,
        RequestOriginKind::ClientEntry,
        "response-invocation",
        "response-attempt",
        vec![],
    )
    .expect("zero edits publish current associations");
    let pair = handle.original_pair().expect("original pair");
    let current = handle.current_field_associations().expect("current");
    let projected = project(&governed, &pair, &current);

    let exec_mapping = projected
        .declarations
        .iter()
        .find(|mapping| mapping.source_path == "request.tools[0].tools[1]")
        .cloned()
        .expect("emitted exec mapping");
    let patch_mapping = projected
        .declarations
        .iter()
        .find(|mapping| mapping.source_path == "request.tools[0].tools[0]")
        .cloned()
        .expect("emitted apply_patch mapping");
    assert_eq!(exec_mapping.emitted_kind, "function");
    assert_eq!(exec_mapping.emitted_name.as_deref(), Some("exec"));
    assert_eq!(patch_mapping.emitted_kind, "custom");
    assert_eq!(patch_mapping.emitted_name.as_deref(), Some("apply_patch"));

    let attempt = publish_attempt(&handle, "response-attempt", projected.declarations);
    let arguments = format!(
        "{{\"cmd\":\"echo\"}}\n{}REQ02_RESPONSE_EXEC_TAIL",
        "q".repeat(60_000)
    );
    let patch_input = format!("*** Begin Patch\n+{}\n*** End Patch\n", "r".repeat(60_000));
    let inverse = chat_response_inverse(
        &handle,
        &attempt,
        &json!({
            "id": "resp",
            "object": "chat.completion",
            "created": 1,
            "model": "model",
            "choices": [{
                "index": 0,
                "finish_reason": "tool_calls",
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [
                        {"id": "call-exec", "type": "function", "function": {"name": exec_mapping.emitted_name.clone().expect("emitted exec name"), "arguments": arguments}},
                        {"id": "call-patch", "type": "custom", "custom": {"name": patch_mapping.emitted_name.clone().expect("emitted patch name"), "input": patch_input}}
                    ]
                }
            }]
        }),
    );

    assert_eq!(inverse["output"][0]["type"], "function_call");
    assert_eq!(inverse["output"][0]["name"], "exec");
    assert_eq!(inverse["output"][0]["call_id"], "call-exec");
    assert_eq!(inverse["output"][0]["arguments"], json!(arguments));
    assert_eq!(inverse["output"][1]["type"], "custom_tool_call");
    assert_eq!(inverse["output"][1]["name"], "apply_patch");
    assert_eq!(inverse["output"][1]["call_id"], "call-patch");
    assert_eq!(inverse["output"][1]["input"], json!(patch_input));
    match declaration_namespace(&pair, "request.tools[0].tools[1]") {
        Some(namespace) => assert_eq!(inverse["output"][0]["namespace"], namespace),
        None => assert!(inverse["output"][0].get("namespace").is_none()),
    }
    match declaration_namespace(&pair, "request.tools[0].tools[0]") {
        Some(namespace) => assert_eq!(inverse["output"][1]["namespace"], namespace),
        None => assert!(inverse["output"][1].get("namespace").is_none()),
    }
}

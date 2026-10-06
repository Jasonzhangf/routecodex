use routecodex_v3_runtime::operation_runner::{
    execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, HistoryPairingReference,
    RequestInvocationContext, RequestNormalizationEntry, RequestOriginKind,
    RequestScopedContextPair, ToolDeclarationReference, V3RequestContextHandle,
};
use serde_json::{json, Value};

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

fn invocation(
    handle: &V3RequestContextHandle,
    invocation_id: &str,
    attempt_id: &str,
    origin: RequestOriginKind,
) -> RequestInvocationContext {
    RequestInvocationContext::new(
        handle.clone(),
        invocation_id.to_string(),
        attempt_id.to_string(),
        origin,
    )
}

fn opaque_records(canonical: &Value) -> &Vec<Value> {
    canonical["routecodex_chat_extension"]["chat_extension_opaque_record"]
        .as_array()
        .expect("canonical root must carry the opaque record array")
}

fn opaque_record<'a>(canonical: &'a Value, path: &str) -> &'a Value {
    opaque_records(canonical)
        .iter()
        .find(|record| record["path"] == path)
        .unwrap_or_else(|| panic!("missing opaque record for `{path}`"))
}

fn opaque_record_by_id<'a>(canonical: &'a Value, record_id: &str) -> &'a Value {
    opaque_records(canonical)
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

#[test]
fn responses_public_consumer_preserves_typed_declarations_history_and_opaque_conflicts() {
    let exec_arguments = json!({
        "cmd": format!(
            "printf '%s' '{}{}'",
            "x".repeat(70_000),
            "RESP_EXEC_FINAL_SENTINEL"
        ),
        "workdir": "/workspace/routecodex",
        "yield_time_ms": 1000
    })
    .to_string();
    let apply_patch_input = json!({
        "workdir": "/workspace/routecodex",
        "free_text": "*** Begin Patch\n*** Update File: src/lib.rs\n@@\n-old\n+new\n*** End Patch\n"
    });
    let exec_tool = json!({
        "type": "function",
        "function": {
            "name": "exec",
            "parameters": {"command": {"type": "string"}},
            "extension": {"tool_declaration_nested": {"extension": true}}
        }
    });
    let custom_tool = json!({
        "type": "custom",
        "namespace": "server",
        "name": "apply_patch",
        "input_schema": {"type": "object"}
    });
    let mcp_tool = json!({
        "type": "function",
        "namespace": "mcp.search",
        "name": "find",
        "parameters": {"query": {"type": "string"}}
    });
    let unknown_top_level = json!({"keep": "exactly", "nested": [1, null, {"x": true}]});
    let client_extension = json!({"nested": {"keep": "client business value"}});
    let client_carrier = json!({"nested": {"keep": "conflicting business value"}});
    let raw = json!({
        "model": "responses-model",
        "tools": [exec_tool.clone(), custom_tool.clone(), mcp_tool.clone()],
        "input": [
            {
                "type": "function_call",
                "call_id": "call-function",
                "namespace": "mcp.search",
                "name": "find",
                "arguments": exec_arguments.clone()
            },
            {
                "type": "custom_tool_call",
                "call_id": "call-custom",
                "namespace": "server",
                "name": "apply_patch",
                "input": apply_patch_input.clone()
            },
            {
                "type": "function_call_output",
                "call_id": "call-function",
                "output": "complete result"
            },
            {
                "type": "custom_tool_call_output",
                "call_id": "call-custom",
                "output": {"ok": true}
            }
        ],
        "unknown_top_level": unknown_top_level.clone(),
        "extension": client_extension.clone(),
        "routecodex_chat_extension": client_carrier.clone()
    });

    let (_handle, canonical, pair) = normalize_raw("responses", "req-responses", raw);

    assert_eq!(
        canonical["messages"][0]["tool_calls"][0]["function"]["name"],
        "mcp.search__find"
    );
    assert_eq!(
        canonical["messages"][0]["tool_calls"][0]["function"]["arguments"],
        Value::String(exec_arguments.clone())
    );
    assert!(
        canonical["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap()
            .contains("RESP_EXEC_FINAL_SENTINEL")
    );
    assert_eq!(
        canonical["messages"][1]["tool_calls"][0]["custom"]["name"],
        "server.apply_patch"
    );
    assert_eq!(
        canonical["messages"][1]["tool_calls"][0]["custom"]["input"],
        apply_patch_input
    );
    assert_eq!(canonical["messages"][2]["tool_call_id"], "call-function");
    assert_eq!(canonical["messages"][2]["content"], "complete result");
    assert_eq!(canonical["messages"][3]["tool_call_id"], "call-custom");
    assert_eq!(canonical["messages"][3]["content"], json!({"ok": true}));

    let exec_declaration = declaration_by_source(&pair, "request.tools[0]");
    assert_eq!(exec_declaration.kind, "function");
    assert_eq!(exec_declaration.name.as_deref(), Some("exec"));
    assert!(exec_declaration.namespace.is_none());
    assert_eq!(
        opaque_record_by_id(&canonical, &exec_declaration.record_id)["value"],
        exec_tool
    );
    let custom_declaration = declaration_by_source(&pair, "request.tools[1]");
    assert_eq!(custom_declaration.kind, "custom");
    assert_eq!(custom_declaration.name.as_deref(), Some("apply_patch"));
    assert_eq!(
        custom_declaration.namespace.as_ref(),
        Some(&json!("server"))
    );
    assert_eq!(
        opaque_record_by_id(&canonical, &custom_declaration.record_id)["value"],
        custom_tool
    );
    let mcp_declaration = declaration_by_source(&pair, "request.tools[2]");
    assert_eq!(mcp_declaration.kind, "function");
    assert_eq!(mcp_declaration.name.as_deref(), Some("find"));
    assert_eq!(
        mcp_declaration.namespace.as_ref(),
        Some(&json!("mcp.search"))
    );
    assert_eq!(
        opaque_record_by_id(&canonical, &mcp_declaration.record_id)["value"],
        mcp_tool
    );

    let function_history = history_by_source(&pair, "request.input[0]");
    assert_eq!(function_history.call_id.as_deref(), Some("call-function"));
    assert_eq!(function_history.kind, "function");
    assert_eq!(function_history.name.as_deref(), Some("find"));
    assert_eq!(
        function_history.namespace.as_ref(),
        Some(&json!("mcp.search"))
    );
    assert_eq!(function_history.encoding, "string");
    let custom_history = history_by_source(&pair, "request.input[1]");
    assert_eq!(custom_history.call_id.as_deref(), Some("call-custom"));
    assert_eq!(custom_history.kind, "custom");
    assert_eq!(custom_history.name.as_deref(), Some("apply_patch"));
    assert_eq!(custom_history.namespace.as_ref(), Some(&json!("server")));
    assert_eq!(custom_history.encoding, "json-object");
    let function_output_history = history_by_source(&pair, "request.input[2]");
    assert_eq!(
        function_output_history.call_id.as_deref(),
        Some("call-function")
    );
    assert_eq!(function_output_history.kind, "function_call_output");
    assert_eq!(function_output_history.encoding, "string");
    let custom_output_history = history_by_source(&pair, "request.input[3]");
    assert_eq!(
        custom_output_history.call_id.as_deref(),
        Some("call-custom")
    );
    assert_eq!(custom_output_history.kind, "custom_tool_call_output");
    assert_eq!(custom_output_history.encoding, "json-object");

    assert_eq!(canonical["extension"], client_extension);
    assert_eq!(
        opaque_record(&canonical, "request.extension")["value"],
        client_extension
    );
    assert_eq!(
        opaque_record(&canonical, "request.routecodex_chat_extension")["value"],
        client_carrier
    );
    assert_eq!(
        opaque_record(&canonical, "request.unknown_top_level")["value"],
        unknown_top_level
    );
}

#[test]
fn chat_public_consumer_preserves_tool_arguments_results_schema_and_unknown_fields() {
    let command_arguments = json!({
        "cmd": format!(
            "printf '%s' '{}{}'",
            "y".repeat(70_000),
            "CHAT_COMMAND_FINAL_SENTINEL"
        ),
        "nested": {"keep": true}
    })
    .to_string();
    let chat_tool = json!({
        "type": "function",
        "function": {
            "name": "lookup",
            "description": "Look up",
            "parameters": {
                "type": "object",
                "properties": {"q": {"type": "string"}},
                "required": ["q"]
            },
            "unknown_tool_field": {"keep": "schema"}
        }
    });
    let unknown_top_level = json!({"keep": "chat-top-level"});
    let message_extension = json!({"nested": [1, null, {"x": true}]});
    let raw = json!({
        "model": "chat-model",
        "messages": [
            {
                "role": "assistant",
                "content": "calling",
                "tool_calls": [{
                    "id": "call-chat-1",
                    "type": "function",
                    "function": {
                        "name": "lookup",
                        "arguments": command_arguments.clone()
                    }
                }],
                "vendor_extension": message_extension.clone()
            },
            {
                "role": "tool",
                "tool_call_id": "call-chat-1",
                "content": "chat result",
                "vendor_tool_sibling": {"keep": "result"}
            }
        ],
        "tools": [chat_tool.clone()],
        "unknown_top_level": unknown_top_level.clone()
    });

    let (_handle, canonical, pair) = normalize_raw("openai-chat", "req-chat", raw);

    assert_eq!(canonical["messages"][0]["role"], "assistant");
    assert_eq!(
        canonical["messages"][0]["tool_calls"][0]["function"]["name"],
        "lookup"
    );
    assert_eq!(
        canonical["messages"][0]["tool_calls"][0]["function"]["arguments"],
        Value::String(command_arguments.clone())
    );
    assert!(
        canonical["messages"][0]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap()
            .contains("CHAT_COMMAND_FINAL_SENTINEL")
    );
    assert_eq!(
        canonical["messages"][0]["vendor_extension"],
        message_extension
    );
    assert_eq!(canonical["messages"][1]["tool_call_id"], "call-chat-1");
    assert_eq!(canonical["messages"][1]["content"], "chat result");
    assert_eq!(
        canonical["messages"][1]["vendor_tool_sibling"],
        json!({"keep": "result"})
    );
    assert_eq!(canonical["tools"][0], chat_tool);

    let declaration = declaration_by_source(&pair, "request.tools[0]");
    assert_eq!(declaration.kind, "function");
    assert_eq!(declaration.name.as_deref(), Some("lookup"));
    assert!(declaration.namespace.is_none());
    assert_eq!(
        opaque_record_by_id(&canonical, &declaration.record_id)["value"],
        chat_tool
    );
    let call_history = history_by_source(&pair, "request.messages[0].tool_calls[0]");
    assert_eq!(call_history.call_id.as_deref(), Some("call-chat-1"));
    assert_eq!(call_history.kind, "function");
    assert_eq!(call_history.name.as_deref(), Some("lookup"));
    assert_eq!(call_history.encoding, "string");
    let result_history = history_by_source(&pair, "request.messages[1].tool_call_id");
    assert_eq!(result_history.call_id.as_deref(), Some("call-chat-1"));
    assert_eq!(result_history.kind, "tool_result");
    assert_eq!(result_history.encoding, "string");
    assert_eq!(
        opaque_record(&canonical, "request.unknown_top_level")["value"],
        unknown_top_level
    );
    assert_eq!(
        opaque_record(&canonical, "request.messages[0].vendor_extension")["value"],
        json!({"nested": [1, null, {"x": true}]})
    );
    assert_eq!(
        opaque_record(&canonical, "request.messages[1].vendor_tool_sibling")["value"],
        json!({"keep": "result"})
    );
}

#[test]
fn anthropic_public_consumer_preserves_tool_pairing_cache_control_and_unknown_siblings() {
    let cache_control = json!({"type": "ephemeral"});
    let tool_input = json!({"q": 1, "nested": {"keep": "input"}});
    let raw = json!({
        "model": "claude",
        "max_tokens": 42,
        "messages": [
            {
                "role": "assistant",
                "vendor_message": {"keep": "message"},
                "content": [
                    {
                        "type": "text",
                        "text": "calling",
                        "cache_control": cache_control.clone(),
                        "vendor_text": {"keep": "text"}
                    },
                    {
                        "type": "tool_use",
                        "id": "toolu-1",
                        "name": "lookup",
                        "input": tool_input.clone(),
                        "cache_control": cache_control.clone(),
                        "vendor_use": {"keep": "use"}
                    }
                ]
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "toolu-1",
                        "content": "ok",
                        "is_error": true,
                        "cache_control": cache_control.clone(),
                        "vendor_result": {"keep": "result"}
                    }
                ]
            }
        ],
        "tools": [{
            "name": "lookup",
            "description": "Look up",
            "input_schema": {"type": "object"},
            "cache_control": cache_control.clone(),
            "vendor_declaration": {"keep": "declaration"}
        }]
    });

    let (_handle, canonical, pair) = normalize_raw("anthropic", "req-anthropic", raw);

    assert_eq!(canonical["messages"][0]["role"], "assistant");
    assert_eq!(
        canonical["messages"][0]["content"][0],
        json!({"type": "text", "text": "calling"})
    );
    assert_eq!(
        canonical["messages"][0]["tool_calls"][0]["function"]["name"],
        "lookup"
    );
    assert_eq!(
        canonical["messages"][0]["tool_calls"][0]["function"]["arguments"],
        tool_input
    );
    assert_eq!(canonical["messages"][1]["role"], "user");
    assert_eq!(canonical["messages"][1]["content"], json!([]));
    assert_eq!(canonical["messages"][2]["role"], "tool");
    assert_eq!(canonical["messages"][2]["tool_call_id"], "toolu-1");
    assert_eq!(canonical["messages"][2]["content"], "ok");

    let declaration = declaration_by_source(&pair, "request.tools[0]");
    assert_eq!(declaration.kind, "function");
    assert_eq!(declaration.name.as_deref(), Some("lookup"));
    assert!(declaration.namespace.is_none());
    let declaration_record = opaque_record_by_id(&canonical, &declaration.record_id);
    assert_eq!(declaration_record["value"]["cache_control"], cache_control);
    assert_eq!(
        declaration_record["value"]["vendor_declaration"],
        json!({"keep": "declaration"})
    );

    let use_history = history_by_source(&pair, "request.messages[0].content[1]");
    assert_eq!(use_history.call_id.as_deref(), Some("toolu-1"));
    assert_eq!(use_history.kind, "function");
    assert_eq!(use_history.name.as_deref(), Some("lookup"));
    assert_eq!(use_history.encoding, "json-object");
    let result_history = history_by_source(&pair, "request.messages[1].content[0]");
    assert_eq!(result_history.call_id.as_deref(), Some("toolu-1"));
    assert_eq!(result_history.kind, "tool_result");
    assert_eq!(result_history.encoding, "string");

    for (path, expected) in [
        (
            "request.messages[0].content[0].cache_control",
            cache_control.clone(),
        ),
        (
            "request.messages[0].content[0].vendor_text",
            json!({"keep": "text"}),
        ),
        (
            "request.messages[0].content[1].cache_control",
            cache_control.clone(),
        ),
        (
            "request.messages[0].content[1].vendor_use",
            json!({"keep": "use"}),
        ),
        ("request.messages[1].content[0].is_error", json!(true)),
        (
            "request.messages[1].content[0].cache_control",
            cache_control,
        ),
        (
            "request.messages[1].content[0].vendor_result",
            json!({"keep": "result"}),
        ),
        (
            "request.messages[0].vendor_message",
            json!({"keep": "message"}),
        ),
    ] {
        assert_eq!(opaque_record(&canonical, path)["value"], expected);
    }
}

#[test]
fn gemini_public_consumer_preserves_media_presence_unknown_parts_and_function_history() {
    let current_image = json!({
        "mimeType": "image/webp",
        "data": "UklGRg==",
        "vendor": {"keep": "current-image"}
    });
    let image_without_mime = json!({"data": "aGVsbG8="});
    let unknown_part = json!({
        "unknownType": {"payload": [1, null, {"keep": true}]},
        "vendorSibling": {"keep": "part"}
    });
    let unrepresentable_inline = json!({
        "data": 123,
        "mimeType": {"vendor": "keep"},
        "vendor": {"k": 1}
    });
    let function_call = json!({
        "id": "gemini-call-1",
        "name": "lookup",
        "args": {"q": 1, "nested": {"keep": "args"}},
        "vendorCall": {"keep": "call"}
    });
    let function_response = json!({
        "id": "gemini-call-1",
        "response": {"ok": true, "nested": {"keep": "response"}},
        "vendorResponse": {"keep": "response"}
    });
    let declaration = json!({
        "name": "lookup",
        "description": "Look up",
        "parameters": {"type": "object"},
        "vendorDeclaration": {"keep": "declaration"}
    });
    let raw = json!({
        "model": "gemini-client-model",
        "contents": [
            {"role": "user", "parts": [{"text": "prior turn"}]},
            {"role": "model", "parts": [{"functionCall": function_call.clone()}]},
            {"role": "user", "parts": [{"functionResponse": function_response.clone()}]},
            {
                "role": "user",
                "parts": [
                    {"inlineData": current_image.clone()},
                    {"inlineData": image_without_mime.clone()},
                    unknown_part.clone(),
                    {"inlineData": unrepresentable_inline.clone()}
                ]
            }
        ],
        "tools": [{
            "functionDeclarations": [declaration.clone()],
            "vendorConfig": {"keep": "tool-container"}
        }]
    });

    let (_handle, canonical, pair) = normalize_raw("gemini", "req-gemini", raw);

    assert_eq!(canonical["messages"][1]["role"], "assistant");
    assert_eq!(
        canonical["messages"][1]["tool_calls"][0]["function"]["name"],
        "lookup"
    );
    assert_eq!(
        canonical["messages"][1]["tool_calls"][0]["function"]["arguments"],
        json!({"q": 1, "nested": {"keep": "args"}})
    );
    assert_eq!(canonical["messages"][2]["role"], "user");
    assert_eq!(canonical["messages"][2]["content"], json!([]));
    assert_eq!(canonical["messages"][3]["role"], "tool");
    assert_eq!(canonical["messages"][3]["tool_call_id"], "gemini-call-1");
    assert_eq!(
        canonical["messages"][3]["content"],
        json!({"ok": true, "nested": {"keep": "response"}})
    );
    assert_eq!(
        canonical["messages"][4]["content"][0],
        json!({
            "type": "media",
            "media": {
                "inline_data": "UklGRg==",
                "mime_type": "image/webp"
            }
        })
    );
    assert_eq!(
        canonical["messages"][4]["content"][1],
        json!({
            "type": "media",
            "media": {"inline_data": "aGVsbG8="}
        })
    );
    assert!(canonical["messages"][4]["content"][1]["media"]
        .get("mime_type")
        .is_none());
    assert_eq!(canonical["messages"][4]["content"][2], unknown_part);
    assert_eq!(
        canonical["messages"][4]["content"][3],
        json!({"inlineData": unrepresentable_inline.clone()})
    );

    let declaration_ref = declaration_by_source(&pair, "request.tools[0].functionDeclarations[0]");
    assert_eq!(declaration_ref.kind, "function");
    assert_eq!(declaration_ref.name.as_deref(), Some("lookup"));
    assert!(declaration_ref.namespace.is_none());
    assert_eq!(
        opaque_record_by_id(&canonical, &declaration_ref.record_id)["value"],
        declaration
    );
    let call_history = history_by_source(&pair, "request.contents[1].parts[0]");
    assert_eq!(call_history.call_id.as_deref(), Some("gemini-call-1"));
    assert_eq!(call_history.kind, "function");
    assert_eq!(call_history.name.as_deref(), Some("lookup"));
    assert_eq!(call_history.encoding, "json-object");
    let response_history = history_by_source(&pair, "request.contents[2].parts[0]");
    assert_eq!(response_history.call_id.as_deref(), Some("gemini-call-1"));
    assert_eq!(response_history.kind, "tool_result");
    assert_eq!(response_history.encoding, "json-object");

    assert_eq!(
        opaque_record(&canonical, "request.contents[3].parts[0].inlineData.vendor")["value"],
        json!({"keep": "current-image"})
    );
    assert_eq!(
        opaque_record(&canonical, "request.contents[3].parts[2].unknownType")["value"],
        json!({"payload": [1, null, {"keep": true}]})
    );
    assert_eq!(
        opaque_record(&canonical, "request.contents[3].parts[3].inlineData")["value"],
        unrepresentable_inline
    );
}

#[test]
fn public_handle_reentry_lifecycle_and_request_isolation_are_typed_and_lossless() {
    let raw = json!({
        "model": "responses-model",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "hello"}]
        }]
    });
    let (handle, canonical, original_pair) = normalize_raw("responses", "req-lifecycle", raw);
    let clone = handle.clone();
    drop(clone);
    assert_eq!(
        handle
            .original_pair()
            .expect("handle clone drop must not finalize"),
        original_pair
    );

    let retry = invocation(
        &handle,
        "req-lifecycle-retry-invocation",
        "req-lifecycle-retry-attempt",
        RequestOriginKind::Retry,
    );
    let retried = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &retry,
        RequestNormalizationEntry::AlreadyCanonical(canonical.clone()),
    )
    .expect("retry must consume AlreadyCanonical through the public SDK entry");
    assert_eq!(retried, canonical);
    assert_eq!(
        handle
            .original_pair()
            .expect("retry must preserve the original pair"),
        original_pair
    );

    let followup = invocation(
        &handle,
        "req-lifecycle-followup-invocation",
        "req-lifecycle-followup-attempt",
        RequestOriginKind::InternalFollowup,
    );
    let followed = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &followup,
        RequestNormalizationEntry::AlreadyCanonical(canonical.clone()),
    )
    .expect("internal followup must consume AlreadyCanonical through the public SDK entry");
    assert_eq!(followed, canonical);
    assert_eq!(
        handle
            .original_pair()
            .expect("followup must preserve the original pair"),
        original_pair
    );

    let guard = handle
        .take_finalizer()
        .expect("the request must expose exactly one finalizer guard");
    assert_eq!(
        handle.take_finalizer().unwrap_err(),
        "request req-lifecycle finalizer guard already taken"
    );
    guard
        .finalize()
        .expect("public finalizer must release the request");
    assert_eq!(
        handle.original_pair().unwrap_err(),
        "request req-lifecycle scope already released"
    );
    assert_eq!(
        handle
            .successful_attempt("req-lifecycle-attempt")
            .unwrap_err(),
        "request req-lifecycle scope already released"
    );

    let (handle_a, canonical_a, pair_a) = normalize_raw(
        "responses",
        "req-isolation-a",
        json!({
            "model": "a",
            "tools": [{
                "type": "function",
                "function": {"name": "alpha", "parameters": {"type": "object"}}
            }],
            "input": "alpha request"
        }),
    );
    let (handle_b, canonical_b, pair_b) = normalize_raw(
        "openai-chat",
        "req-isolation-b",
        json!({
            "model": "b",
            "messages": [{"role": "user", "content": "beta request"}],
            "tools": [{
                "type": "function",
                "function": {"name": "beta", "parameters": {"type": "object"}}
            }]
        }),
    );
    assert_ne!(handle_a.request_id(), handle_b.request_id());
    assert_eq!(
        pair_a
            .inverse_context
            .tool_declarations
            .iter()
            .map(|declaration| declaration.name.as_deref())
            .collect::<Vec<_>>(),
        vec![Some("alpha")]
    );
    assert_eq!(
        pair_b
            .inverse_context
            .tool_declarations
            .iter()
            .map(|declaration| declaration.name.as_deref())
            .collect::<Vec<_>>(),
        vec![Some("beta")]
    );
    assert_eq!(canonical_a["tools"][0]["function"]["name"], "alpha");
    assert_eq!(canonical_b["tools"][0]["function"]["name"], "beta");
    let retry_with_raw = invocation(
        &handle_a,
        "invalid-retry-invocation",
        "invalid-retry-attempt",
        RequestOriginKind::Retry,
    );
    let error = execute_v3_operation_runner_request_normalize_losslessly(
        &handle_a,
        &retry_with_raw,
        RequestNormalizationEntry::RawEntry(json!({"input": "not allowed"})),
    )
    .expect_err("retry with RawEntry must fail as an internal lifecycle error");
    assert_eq!(
        error.message,
        "retry and internal followup require an already-canonical entry"
    );

    let client_with_canonical = invocation(
        &handle_a,
        "invalid-client-invocation",
        "invalid-client-attempt",
        RequestOriginKind::ClientEntry,
    );
    let error = execute_v3_operation_runner_request_normalize_losslessly(
        &handle_a,
        &client_with_canonical,
        RequestNormalizationEntry::AlreadyCanonical(canonical_a),
    )
    .expect_err("client entry with AlreadyCanonical must fail as an internal lifecycle error");
    assert_eq!(
        error.message,
        "client entry cannot consume an already-canonical invocation input"
    );

    let wrong_scope = invocation(
        &handle_b,
        "wrong-scope-invocation",
        "wrong-scope-attempt",
        RequestOriginKind::ClientEntry,
    );
    let error = execute_v3_operation_runner_request_normalize_losslessly(
        &handle_a,
        &wrong_scope,
        RequestNormalizationEntry::AlreadyCanonical(json!({"messages": []})),
    )
    .expect_err("an invocation bound to another request scope must fail");
    assert_eq!(
        error.message,
        "request handle `req-isolation-a` does not belong to invocation request `req-isolation-b` scope"
    );
}

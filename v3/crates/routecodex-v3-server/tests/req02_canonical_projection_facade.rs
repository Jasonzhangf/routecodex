use routecodex_v3_config::{
    V3ProviderRequestCleanupAuthoringConfig, V3ResponsesTransportKind, V3WebSearchExecutionMode,
};
use routecodex_v3_runtime::hub_v1::{V3HubExecutionMode, V3HubProviderWireProtocol};
use routecodex_v3_runtime::operation_runner::{
    apply_canonical_field_edit, execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, project_canonical_request,
    AttemptContext, CanonicalFieldEdit, CurrentFieldAssociations, RequestInvocationContext,
    RequestNormalizationEntry, RequestOriginKind, RequestScopedContextPair, ResponseProjectionView,
    V3RequestContextHandle, V3TargetCandidate,
};
use routecodex_v3_runtime::{
    project_v3_anthropic_message_as_responses_response_with_context,
    project_v3_openai_chat_response_as_responses_with_successful_attempt,
    V3AnthropicResponsesProjectionContext,
};
use serde_json::{json, Value};

fn target(protocol: V3HubProviderWireProtocol, web_search: bool) -> V3TargetCandidate {
    let provider_type = match protocol {
        V3HubProviderWireProtocol::Responses => "responses",
        V3HubProviderWireProtocol::OpenAiChat => "openai_chat",
        V3HubProviderWireProtocol::Anthropic => "anthropic",
        V3HubProviderWireProtocol::Gemini => "gemini",
    };
    V3TargetCandidate {
        provider_id: "provider".to_string(),
        provider_type: provider_type.to_string(),
        auth_alias: "primary".to_string(),
        model_id: "provider-model".to_string(),
        wire_model: "provider-wire-model".to_string(),
        visible_model_ids: vec!["client-model".to_string()],
        model_capabilities: vec![
            "text".to_string(),
            "multimodal".to_string(),
            "web_search".to_string(),
        ]
        .into_iter()
        .filter(|_| web_search)
        .collect(),
        web_search_execution_mode: if web_search {
            V3WebSearchExecutionMode::NativeRemoteSearchSearchOnly
        } else {
            V3WebSearchExecutionMode::None
        },
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

fn sdk_request_with_handle(
    protocol: &str,
    raw: Value,
) -> (
    V3RequestContextHandle,
    Value,
    RequestScopedContextPair,
    CurrentFieldAssociations,
) {
    let handle = V3RequestContextHandle::new(format!("facade-{protocol}"), protocol.to_string());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "facade-invocation".to_string(),
        "facade-attempt".to_string(),
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
    (handle, canonical, pair, current)
}

fn sdk_request(
    protocol: &str,
    raw: Value,
) -> (Value, RequestScopedContextPair, CurrentFieldAssociations) {
    let (_, canonical, pair, current) = sdk_request_with_handle(protocol, raw);
    (canonical, pair, current)
}

#[test]
fn discovered_mcp_declaration_survives_sdk_normalization_and_actual_emit() {
    let raw = json!({
        "model": "client-model",
        "tools": [{"type": "tool_search"}],
        "input": [
            {"type": "tool_search_call", "call_id": "search", "execution": "client",
             "arguments": {"query": "echo"}},
            {"type": "tool_search_output", "call_id": "search", "execution": "client",
             "tools": [{"type": "namespace", "name": "mcp__probe", "tools": [
                 {"type": "function", "name": "echo", "parameters": {
                     "type": "object", "properties": {"text": {"type": "string"}},
                     "required": ["text"]
                 }}
             ]}]}
        ]
    });
    let (canonical, pair, current) = sdk_request("responses", raw);
    let declaration = pair
        .inverse_context
        .tool_declarations
        .iter()
        .find(|declaration| declaration.source_path == "request.input[1].tools[0].tools[0]")
        .expect("the discovered declaration must retain its original request identity");
    assert_eq!(declaration.name.as_deref(), Some("echo"));
    assert_eq!(declaration.namespace, Some(json!("mcp__probe")));
    for protocol in [
        V3HubProviderWireProtocol::OpenAiChat,
        V3HubProviderWireProtocol::Anthropic,
    ] {
        let projected = project_canonical_request(
            &canonical,
            &pair.inverse_context,
            &current,
            &pair.explicit_history_pairing,
            V3HubExecutionMode::Relay,
            protocol,
            &target(protocol, false),
            "discovered-attempt",
        )
        .expect("discovered tool must reach the standard projection");
        assert!(
            projected
                .attempt
                .declarations
                .tool_mappings
                .iter()
                .any(|mapping| { mapping.declaration_record_id == declaration.record_id }),
            "the actual emitted declaration must retain the same original record: {}",
            projected.payload
        );
    }
}

#[test]
fn unnamed_builtin_declaration_returns_its_declared_native_call_shape() {
    let raw = json!({
        "model": "client-model", "input": "discover a tool",
        "tools": [{"type": "tool_search"}]
    });
    let (handle, mut canonical, pair, current) = sdk_request_with_handle("responses", raw);
    // The request Chat Process emits the existing function representation for
    // a client-executed builtin. Its original declaration has no name field.
    canonical["tools"][0] = json!({
        "type": "function", "name": "tool_search", "parameters": {"type": "object"}
    });
    for protocol in [V3HubProviderWireProtocol::Anthropic, V3HubProviderWireProtocol::OpenAiChat] {
        let projected = project_canonical_request(
            &canonical, &pair.inverse_context, &current, &pair.explicit_history_pairing,
            V3HubExecutionMode::Relay, protocol, &target(protocol, false), "builtin-attempt",
        ).unwrap();
        handle.publish_successful_attempt(projected.attempt.clone()).unwrap();
        let view = ResponseProjectionView::from_successful_attempt(&handle, &projected.attempt).unwrap();
        let restored = match protocol {
            V3HubProviderWireProtocol::Anthropic => {
                let context = V3AnthropicResponsesProjectionContext::from_successful_attempt(&view)
                    .expect("an unnamed builtin is a valid original declaration");
                project_v3_anthropic_message_as_responses_response_with_context(&json!({
                    "id": "builtin", "type": "message", "role": "assistant", "model": "provider-wire-model",
                    "content": [{"type": "tool_use", "id": "builtin-call", "name": "tool_search", "input": {"query": "echo"}}],
                    "stop_reason": "tool_use", "usage": {"input_tokens": 1, "output_tokens": 1}
                }), &context).unwrap()
            }
            _ => project_v3_openai_chat_response_as_responses_with_successful_attempt(&json!({
                "id": "builtin", "object": "chat.completion", "model": "provider-wire-model",
                "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {
                    "role": "assistant", "content": null,
                    "tool_calls": [{"id": "builtin-call", "type": "function", "function": {
                        "name": "tool_search", "arguments": "{\"query\":\"echo\"}"
                    }}]
                }}]
            }), &view).unwrap(),
        };
        assert_eq!(restored["output"][0]["type"], "tool_search_call");
        assert_eq!(restored["output"][0]["call_id"], "builtin-call");
        assert_eq!(restored["output"][0]["arguments"], json!({"query": "echo"}));
        assert_eq!(restored["output"][0]["execution"], "client");
        assert!(restored["output"][0].get("name").is_none());
    }
    assert_eq!(handle.original_pair().unwrap(), pair);
}

fn emitted_name(
    attempt: &AttemptContext,
    pair: &RequestScopedContextPair,
    source_path: &str,
) -> String {
    let declaration = pair
        .inverse_context
        .tool_declarations
        .iter()
        .find(|declaration| declaration.source_path == source_path)
        .expect("original declaration");
    attempt
        .declarations
        .tool_mappings
        .iter()
        .find(|mapping| mapping.declaration_record_id == declaration.record_id)
        .and_then(|mapping| mapping.emitted_name.as_deref())
        .map(str::to_string)
        .expect("actual emitted declaration name")
}

#[test]
fn four_native_direct_protocols_and_model_binding_are_preserved() {
    let cases = [
        (
            "responses",
            V3HubProviderWireProtocol::Responses,
            json!({"model":"client-model","input":[{"role":"user","content":"hello"}],"vendor.key[0]":{"keep":null}}),
        ),
        (
            "openai-chat",
            V3HubProviderWireProtocol::OpenAiChat,
            json!({"model":"client-model","messages":[{"role":"user","content":"hello"}]}),
        ),
        (
            "anthropic",
            V3HubProviderWireProtocol::Anthropic,
            json!({"model":"client-model","messages":[{"role":"user","content":[{"type":"text","text":"hello"}]}],"max_tokens":32}),
        ),
        (
            "gemini",
            V3HubProviderWireProtocol::Gemini,
            json!({"contents":[{"role":"user","parts":[{"text":"hello"}]}],"generationConfig":{"maxOutputTokens":32}}),
        ),
    ];

    for (protocol, wire_protocol, raw) in cases {
        let (canonical, pair, current) = sdk_request(protocol, raw.clone());
        let projected = project_canonical_request(
            &canonical,
            &pair.inverse_context,
            &current,
            &pair.explicit_history_pairing,
            V3HubExecutionMode::Direct,
            wire_protocol,
            &target(wire_protocol, false),
            "direct-attempt",
        )
        .expect("native Direct projection");
        let mut expected = raw;
        expected["model"] = json!("provider-wire-model");
        assert_eq!(projected.payload, expected, "{protocol}");
        assert_eq!(projected.attempt.attempt_id, "direct-attempt");
        assert_eq!(
            projected.attempt.projection.provider_model,
            "provider-model"
        );
    }
}

#[test]
fn relay_selected_option_and_current_identity_are_preserved_without_mutation() {
    let command = "printf '%s\\n' 'literal $() and `bytes`'\nprintf complete-tail";
    let patch = "*** Begin Patch\n*** Add File: /tmp/complete-path\n+literal $() and `bytes`\n*** End Patch\n";
    let mcp = json!({"nested":[null,{"text":"complete\nMCP tail","meta":{"keep":true}}]});
    let raw = json!({"model":"client-model","input":[
        {"role":"user","content":"use complete tool payloads"},
        {"type":"function_call","call_id":"exec-call","namespace":"functions","name":"exec","arguments":command},
        {"type":"custom_tool_call","call_id":"patch-call","namespace":"functions","name":"apply_patch","input":patch},
        {"type":"function_call_output","call_id":"mcp-call","output":mcp}
    ],"tools":[{"type":"namespace","name":"functions","tools":[
        {"type":"function","name":"exec","parameters":{"type":"object"}},
        {"type":"custom","name":"apply_patch","format":{"type":"text"}}
    ]}]});
    let (canonical, pair, current) = sdk_request("responses", raw);
    let original_canonical = canonical.clone();
    let pair_before = pair.clone();
    let exec_source = pair
        .inverse_context
        .tool_declarations
        .iter()
        .find(|declaration| declaration.source_path == "request.tools[0].tools[0]")
        .unwrap();

    let (canonical, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::InsertArray {
            array_path: "chat.tools".to_string(),
            index: 0,
            value: json!({"type":"function","name":"inserted","parameters":{"type":"object"}}),
        },
    )
    .expect("paired insert");
    let canonical_before_projection = canonical.clone();
    let current_before_projection = current.clone();

    let projected = project_canonical_request(
        &canonical,
        &pair.inverse_context,
        &current,
        &pair.explicit_history_pairing,
        V3HubExecutionMode::Relay,
        V3HubProviderWireProtocol::Responses,
        &target(V3HubProviderWireProtocol::Responses, true),
        "relay-attempt",
    )
    .expect("Responses relay projection");
    assert_eq!(projected.attempt.declarations.tool_mappings.len(), 2);
    let exec = projected
        .attempt
        .declarations
        .tool_mappings
        .iter()
        .find(|mapping| mapping.declaration_record_id == exec_source.record_id)
        .unwrap();
    assert_eq!(exec.destination_path, "tools[1]");
    assert_eq!(exec.emitted_namespace, None);
    assert_eq!(exec.emitted_name.as_deref(), Some("functions__exec"));
    assert_eq!(projected.payload["tools"][1]["type"], "function");
    assert_eq!(projected.payload["tools"][1]["name"], "functions__exec");
    assert_eq!(
        projected.payload["tools"][1]["parameters"],
        json!({"type":"object"})
    );
    assert_eq!(projected.payload["model"], "provider-wire-model");
    assert_eq!(canonical, canonical_before_projection);
    assert_eq!(pair, pair_before);
    assert_eq!(current, current_before_projection);
    assert_eq!(original_canonical["tools"].as_array().unwrap().len(), 1);
    assert!(projected
        .attempt
        .declarations
        .tool_mappings
        .iter()
        .all(|mapping| {
            pair.inverse_context
                .tool_declarations
                .iter()
                .any(|declaration| declaration.record_id == mapping.declaration_record_id)
        }));

    let handle =
        V3RequestContextHandle::new("relay-attempt-handle".to_string(), "responses".to_string());
    handle
        .publish_original_pair(pair.clone())
        .expect("test transport publishes request pair");
    handle
        .publish_successful_attempt(projected.attempt.clone())
        .expect("test transport publishes successful attempt");
    let view = ResponseProjectionView::from_successful_attempt(&handle, &projected.attempt)
        .expect("existing response mapper consumes successful attempt");
    let restored = view
        .attempt()
        .declarations
        .tool_mappings
        .iter()
        .find(|mapping| mapping.declaration_record_id == exec_source.record_id)
        .unwrap();
    assert_eq!(restored, exec);
}

#[test]
fn selected_web_search_mode_matches_observer_free_standard_builder() {
    let raw = json!({"model":"client-model","messages":[{"role":"user","content":"search"}],"tools":[{"type":"web_search"}]});
    let (canonical, pair, current) = sdk_request("openai-chat", raw);
    let selected = target(V3HubProviderWireProtocol::OpenAiChat, true);
    let projected = project_canonical_request(
        &canonical,
        &pair.inverse_context,
        &current,
        &pair.explicit_history_pairing,
        V3HubExecutionMode::Relay,
        V3HubProviderWireProtocol::OpenAiChat,
        &selected,
        "websearch-attempt",
    )
    .expect("Chat relay projection");
    let mut baseline_input = canonical.clone();
    baseline_input
        .as_object_mut()
        .expect("Chat canonical object")
        .remove("routecodex_chat_extension");
    let baseline = routecodex_v3_runtime::hub_v1::build_v3_openai_chat_standard_request_for_selected_web_search_mode(
        &baseline_input,
        selected.web_search_execution_mode,
        true,
    )
    .expect("selected-option observer-free builder");
    assert_eq!(projected.payload["tools"], baseline["tools"]);
    assert!(projected
        .attempt
        .declarations
        .tool_mappings
        .iter()
        .all(|mapping| pair
            .inverse_context
            .tool_declarations
            .iter()
            .any(|declaration| declaration.record_id == mapping.declaration_record_id)));

    let disabled = target(V3HubProviderWireProtocol::OpenAiChat, false);
    let projected_disabled = project_canonical_request(
        &canonical,
        &pair.inverse_context,
        &current,
        &pair.explicit_history_pairing,
        V3HubExecutionMode::Relay,
        V3HubProviderWireProtocol::OpenAiChat,
        &disabled,
        "websearch-disabled-attempt",
    )
    .expect("Chat relay projection without capability");
    let baseline_disabled = routecodex_v3_runtime::hub_v1::build_v3_openai_chat_standard_request_for_selected_web_search_mode(
        &baseline_input,
        disabled.web_search_execution_mode,
        false,
    )
    .expect("selected-option observer-free builder without capability");
    assert_eq!(
        projected_disabled.payload["tools"],
        baseline_disabled["tools"]
    );
}

#[test]
fn responses_tools_round_trip_through_chat_relay_successful_attempt() {
    let exec_arguments = "{\"cmd\":\"printf '%s\\n' 'literal $() and `bytes`'\nprintf complete-tail\",\"cwd\":\"/tmp\"}";
    let custom_exec_input = "custom exec complete\nsecond line";
    let patch = "*** Begin Patch\n*** Add File: /tmp/complete-path\n+literal $() and `bytes`\n*** End Patch\n";
    let raw = json!({"model":"client-model","input":[
        {"role":"user","content":"use complete tool payloads"}
    ],"tools":[
        {"type":"namespace","name":"functions","tools":[
            {"type":"function","name":"exec","parameters":{"type":"object","properties":{"cmd":{"type":"string"}}}}
        ]},
        {"type":"namespace","name":"custom","tools":[
            {"type":"custom","name":"exec","format":{"type":"text"}},
            {"type":"custom","name":"apply_patch","format":{"type":"text"}}
        ]}
    ]});
    let (handle, canonical, pair, current) = sdk_request_with_handle("responses", raw);
    let projected = project_canonical_request(
        &canonical,
        &pair.inverse_context,
        &current,
        &pair.explicit_history_pairing,
        V3HubExecutionMode::Relay,
        V3HubProviderWireProtocol::OpenAiChat,
        &target(V3HubProviderWireProtocol::OpenAiChat, false),
        "chat-response-attempt",
    )
    .expect("Responses to Chat relay projection");

    let function_exec_name = emitted_name(&projected.attempt, &pair, "request.tools[0].tools[0]");
    let custom_exec_name = emitted_name(&projected.attempt, &pair, "request.tools[1].tools[0]");
    let patch_name = emitted_name(&projected.attempt, &pair, "request.tools[1].tools[1]");

    handle
        .publish_successful_attempt(projected.attempt.clone())
        .expect("publish facade attempt");
    let view = ResponseProjectionView::from_successful_attempt(&handle, &projected.attempt)
        .expect("existing response view");
    let provider = json!({
        "id": "chatcmpl-facade",
        "object": "chat.completion",
        "created": 1,
        "model": "provider-model",
        "choices": [{
            "index": 0,
            "finish_reason": "tool_calls",
            "message": {
                "role": "assistant",
                "content": null,
                "tool_calls": [
                    {
                        "id": "exec-call",
                        "type": "function",
                        "function": {"name": function_exec_name, "arguments": exec_arguments}
                    },
                    {
                        "id": "custom-exec-call",
                        "type": "function",
                        "function": {"name": custom_exec_name, "arguments": json!({"input": custom_exec_input}).to_string()}
                    },
                    {
                        "id": "patch-call",
                        "type": "function",
                        "function": {"name": patch_name, "arguments": json!({"input": patch}).to_string()}
                    }
                ]
            }
        }]
    });
    let restored =
        project_v3_openai_chat_response_as_responses_with_successful_attempt(&provider, &view)
            .expect("existing Chat response inverse");
    let output = restored["output"].as_array().expect("Responses output");

    let function_exec = output
        .iter()
        .find(|item| item["call_id"] == "exec-call")
        .expect("exec output");
    assert_eq!(function_exec["type"], "function_call");
    assert_eq!(function_exec["namespace"], "functions");
    assert_eq!(function_exec["name"], "exec");
    assert_eq!(function_exec["arguments"], exec_arguments);

    let custom_exec = output
        .iter()
        .find(|item| item["call_id"] == "custom-exec-call")
        .expect("custom exec output");
    assert_eq!(custom_exec["type"], "custom_tool_call");
    assert_eq!(custom_exec["namespace"], "custom");
    assert_eq!(custom_exec["name"], "exec");
    assert_eq!(custom_exec["input"], custom_exec_input);

    let patch_call = output
        .iter()
        .find(|item| item["call_id"] == "patch-call")
        .expect("patch output");
    assert_eq!(patch_call["type"], "custom_tool_call");
    assert_eq!(patch_call["namespace"], "custom");
    assert_eq!(patch_call["name"], "apply_patch");
    assert_eq!(patch_call["input"], patch);
}

#[test]
fn responses_tools_round_trip_through_anthropic_relay_successful_attempt() {
    let exec_arguments = json!({
        "cmd": "printf '%s\\n' 'literal $() and `bytes`'\nprintf complete-tail",
        "cwd": "/tmp"
    })
    .to_string();
    let exec_input: Value = serde_json::from_str(&exec_arguments).expect("exec input object");
    let custom_exec_input = "custom exec complete\nsecond line";
    let patch = "*** Begin Patch\n*** Add File: /tmp/complete-path\n+literal $() and `bytes`\n*** End Patch\n";
    let raw = json!({"model":"client-model","input":[
        {"role":"user","content":"use complete tool payloads"}
    ],"tools":[
        {"type":"namespace","name":"functions","tools":[
            {"type":"function","name":"exec","parameters":{"type":"object","properties":{"cmd":{"type":"string"}}}}
        ]},
        {"type":"namespace","name":"custom","tools":[
            {"type":"custom","name":"exec","format":{"type":"text"}},
            {"type":"custom","name":"apply_patch","format":{"type":"text"}}
        ]}
    ]});
    let (handle, canonical, pair, current) = sdk_request_with_handle("responses", raw);
    let projected = project_canonical_request(
        &canonical,
        &pair.inverse_context,
        &current,
        &pair.explicit_history_pairing,
        V3HubExecutionMode::Relay,
        V3HubProviderWireProtocol::Anthropic,
        &target(V3HubProviderWireProtocol::Anthropic, false),
        "anthropic-response-attempt",
    )
    .expect("Responses to Anthropic relay projection");

    let function_exec_name = emitted_name(&projected.attempt, &pair, "request.tools[0].tools[0]");
    let custom_exec_name = emitted_name(&projected.attempt, &pair, "request.tools[1].tools[0]");
    let patch_name = emitted_name(&projected.attempt, &pair, "request.tools[1].tools[1]");

    handle
        .publish_successful_attempt(projected.attempt.clone())
        .expect("publish facade attempt");
    let view = ResponseProjectionView::from_successful_attempt(&handle, &projected.attempt)
        .expect("existing response view");
    let context = V3AnthropicResponsesProjectionContext::from_successful_attempt(&view)
        .expect("existing Anthropic response context");
    let provider = json!({
        "id": "msg-facade",
        "type": "message",
        "role": "assistant",
        "model": "provider-model",
        "content": [
            {"type": "tool_use", "id": "exec-call", "name": function_exec_name, "input": exec_input},
            {"type": "tool_use", "id": "custom-exec-call", "name": custom_exec_name, "input": {"input": custom_exec_input}},
            {"type": "tool_use", "id": "patch-call", "name": patch_name, "input": {"input": patch}}
        ],
        "stop_reason": "tool_use",
        "usage": {"input_tokens": 1, "output_tokens": 1}
    });
    let restored =
        project_v3_anthropic_message_as_responses_response_with_context(&provider, &context)
            .expect("existing Anthropic response inverse");
    let output = restored["output"].as_array().expect("Responses output");

    let function_exec = output
        .iter()
        .find(|item| item["call_id"] == "exec-call")
        .expect("exec output");
    assert_eq!(function_exec["type"], "function_call");
    assert_eq!(function_exec["namespace"], "functions");
    assert_eq!(function_exec["name"], "exec");
    assert_eq!(function_exec["arguments"], exec_arguments);

    let custom_exec = output
        .iter()
        .find(|item| item["call_id"] == "custom-exec-call")
        .expect("custom exec output");
    assert_eq!(custom_exec["type"], "custom_tool_call");
    assert_eq!(custom_exec["namespace"], "custom");
    assert_eq!(custom_exec["name"], "exec");
    assert_eq!(custom_exec["input"], custom_exec_input);

    let patch_call = output
        .iter()
        .find(|item| item["call_id"] == "patch-call")
        .expect("patch output");
    assert_eq!(patch_call["type"], "custom_tool_call");
    assert_eq!(patch_call["namespace"], "custom");
    assert_eq!(patch_call["name"], "apply_patch");
    assert_eq!(patch_call["input"], patch);
}

#[test]
fn gemini_native_and_chat_relay_preserve_content_and_typed_model_binding() {
    let gemini = json!({"contents":[{"role":"user","parts":[{"text":"hello"}]}],"generationConfig":{"maxOutputTokens":32}});
    let (canonical, pair, current) = sdk_request("gemini", gemini.clone());
    let projected = project_canonical_request(
        &canonical,
        &pair.inverse_context,
        &current,
        &pair.explicit_history_pairing,
        V3HubExecutionMode::Relay,
        V3HubProviderWireProtocol::Gemini,
        &target(V3HubProviderWireProtocol::Gemini, false),
        "gemini-relay-attempt",
    )
    .expect("native Gemini relay projection");
    assert_eq!(projected.payload, gemini);
    assert_eq!(projected.attempt.projection.provider_model, "provider-model");

    let (canonical, pair, current) = sdk_request(
        "openai-chat",
        json!({"model":"client-model","messages":[{"role":"user","content":"hello"}]}),
    );
    let projected = project_canonical_request(
        &canonical,
        &pair.inverse_context,
        &current,
        &pair.explicit_history_pairing,
        V3HubExecutionMode::Relay,
        V3HubProviderWireProtocol::Gemini,
        &target(V3HubProviderWireProtocol::Gemini, false),
        "cross-gemini-attempt",
    )
    .expect("Chat semantics must reach the registered Gemini standard composer");
    assert_eq!(
        projected.payload["contents"],
        json!([{"role":"user","parts":[{"text":"hello"}]}])
    );
    assert!(projected.payload.get("model").is_none());
    assert!(projected.payload.get("messages").is_none());
    assert_eq!(projected.attempt.projection.provider_model, "provider-model");
}

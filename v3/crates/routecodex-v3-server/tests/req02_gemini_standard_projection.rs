use routecodex_v3_config::{
    V3ProviderRequestCleanupAuthoringConfig, V3ResponsesTransportKind, V3WebSearchExecutionMode,
};
use routecodex_v3_runtime::hub_v1::{V3HubExecutionMode, V3HubProviderWireProtocol};
use routecodex_v3_runtime::operation_runner::{
    apply_canonical_field_edit, execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, project_canonical_request,
    CanonicalFieldEdit, CurrentFieldAssociations, RequestInvocationContext,
    RequestNormalizationEntry, RequestOriginKind, V3RequestContextHandle, V3TargetCandidate,
};
use serde_json::{json, Value};

fn target(reasoning: bool) -> V3TargetCandidate {
    V3TargetCandidate {
        provider_id: "gemini-provider".to_string(),
        provider_type: "gemini".to_string(),
        auth_alias: "primary".to_string(),
        model_id: "provider-model".to_string(),
        wire_model: "provider-wire-model".to_string(),
        visible_model_ids: vec!["client-model".to_string()],
        model_capabilities: if reasoning {
            vec!["text".to_string(), "reasoning".to_string()]
        } else {
            vec!["text".to_string()]
        },
        web_search_execution_mode: V3WebSearchExecutionMode::None,
        max_context_tokens: None,
        max_tokens: None,
        context_token_estimate_scale_bps: 10_000,
        base_url: "https://generativelanguage.googleapis.com/v1beta".to_string(),
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
        path: vec!["gemini-provider".to_string()],
    }
}

fn sdk_request(
    request_id: &str,
    protocol: &str,
    raw: Value,
) -> (
    V3RequestContextHandle,
    Value,
    routecodex_v3_runtime::operation_runner::RequestScopedContextPair,
    CurrentFieldAssociations,
) {
    let handle = V3RequestContextHandle::new(request_id.to_string(), protocol.to_string());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        format!("{request_id}-invocation"),
        format!("{request_id}-attempt"),
        RequestOriginKind::ClientEntry,
    );
    let captured =
        execute_v3_operation_runner_request_capture_client_json(raw).expect("public SDK capture");
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(captured),
    )
    .expect("public SDK lossless normalize");
    let pair = handle.original_pair().expect("immutable original pair");
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    (handle, canonical, pair, current)
}

#[test]
fn chat_canonical_projects_to_actual_gemini_wire_with_complete_tool_identity() {
    let exec_arguments = json!({
        "cmd": "printf '%s\\n' 'literal $() and `bytes`'\nprintf complete-tail",
        "cwd": "/tmp"
    });
    let exec_result = json!({
        "output": "exec complete\nsecond line",
        "metadata": {"nested": [null, {"keep": true}]}
    });
    let patch = "*** Begin Patch\n*** Add File: /tmp/complete-path\n+literal $() and `bytes`\n*** End Patch\n";
    let mcp_arguments = json!({
        "query": "find",
        "payload": {"nested": [null, {"text": "MCP tail", "keep": true}]}
    });
    let mcp_result = json!({
        "items": [{"name": "complete", "metadata": {"nested": true}}],
        "tail": "MCP result complete"
    });
    let raw = json!({
        "model": "client-model",
        "input": [
            {"role": "system", "content": "Use all declared tools."},
            {"role": "user", "content": [
                {"type": "text", "text": "run the tools"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,UklGRg=="}}
            ]},
            {"type":"function_call","call_id":"exec-call","name":"exec","arguments":exec_arguments.to_string()},
            {"type":"custom_tool_call","call_id":"patch-call","namespace":"functions","name":"apply_patch","input":patch},
            {"type":"function_call_output","call_id":"exec-call","output":exec_result.clone()},
            {"type":"custom_tool_call_output","call_id":"patch-call","output":"applied"},
            {"type":"function_call","call_id":"mcp-call","namespace":"mcp__search","name":"find","arguments":mcp_arguments.to_string()},
            {"type":"function_call_output","call_id":"mcp-call","output":mcp_result.clone()}
        ],
        "tools": [
            {
                "type": "function",
                    "name": "exec",
                    "description": "execute",
                    "parameters": {"type": "object", "properties": {"cmd": {"type": "string"}}}
            },
            {
                "type":"namespace","name":"functions","tools":[
                    {"type":"custom","name":"apply_patch","description":"patch","format":{"type":"text"}}
                ]
            },
            {
                "type":"namespace","name":"mcp__search","tools":[
                    {"type":"function","name":"find","description":"mcp find","parameters":{"type":"object"}}
                ]
            }
        ],
        "reasoning_effort": "high",
        "tool_choice": {"type": "function", "function": {"name": "exec"}},
        "stream": false
    });
    let (_handle, canonical, pair, current) =
        sdk_request("gemini-standard-projection", "responses", raw);
    let canonical_before = canonical.clone();
    let pair_before = pair.clone();
    let current_before = current.clone();

    let projected = project_canonical_request(
        &canonical,
        &pair.inverse_context,
        &current,
        &pair.explicit_history_pairing,
        V3HubExecutionMode::Relay,
        V3HubProviderWireProtocol::Gemini,
        &target(true),
        "gemini-standard-attempt",
    )
    .expect("Chat canonical must project to Gemini standard wire");

    assert_eq!(
        canonical, canonical_before,
        "projection must not mutate the request canonical"
    );
    assert_eq!(
        pair, pair_before,
        "projection must not mutate original pair"
    );
    assert_eq!(
        current, current_before,
        "projection must not mutate current associations"
    );
    assert!(
        projected.payload.get("model").is_none(),
        "Gemini model belongs in the URL, not the body: {}",
        projected.payload
    );
    assert_eq!(
        projected.payload["generationConfig"]["thinkingConfig"]["thinkingLevel"],
        "HIGH"
    );
    assert_eq!(
        projected.payload["toolConfig"]["functionCallingConfig"]["mode"],
        "ANY"
    );
    assert_eq!(
        projected.payload["toolConfig"]["functionCallingConfig"]["allowedFunctionNames"],
        json!(["exec"])
    );

    let contents = projected.payload["contents"]
        .as_array()
        .expect("Gemini contents");
    assert!(contents.iter().any(|content| {
        content["parts"]
            .as_array()
            .is_some_and(|parts| parts.iter().any(|part| part["text"] == "run the tools"))
    }));
    assert!(contents.iter().any(|content| {
        content["parts"].as_array().is_some_and(|parts| {
            parts
                .iter()
                .any(|part| part["inlineData"]["data"] == "UklGRg==")
        })
    }));

    let calls = contents
        .iter()
        .flat_map(|content| content["parts"].as_array().into_iter().flatten())
        .filter_map(|part| part.get("functionCall"))
        .collect::<Vec<_>>();
    let exec_call = calls
        .iter()
        .find(|call| call["id"] == "exec-call")
        .expect("exec functionCall");
    assert_eq!(exec_call["name"], "exec");
    assert_eq!(exec_call["args"], exec_arguments);
    let patch_call = calls
        .iter()
        .find(|call| call["id"] == "patch-call")
        .expect("patch functionCall");
    assert_eq!(patch_call["name"], "functions__apply_patch");
    assert_eq!(patch_call["args"], json!({"input": patch}));
    let mcp_call = calls
        .iter()
        .find(|call| call["id"] == "mcp-call")
        .expect("mcp functionCall");
    assert_eq!(mcp_call["name"], "mcp__search__find");
    assert_eq!(mcp_call["args"], mcp_arguments);

    let responses = contents
        .iter()
        .flat_map(|content| content["parts"].as_array().into_iter().flatten())
        .filter_map(|part| part.get("functionResponse"))
        .collect::<Vec<_>>();
    let exec_response = responses
        .iter()
        .find(|response| response["id"] == "exec-call")
        .expect("exec functionResponse");
    assert_eq!(exec_response["name"], "exec");
    assert_eq!(exec_response["response"], exec_result);
    let patch_response = responses
        .iter()
        .find(|response| response["id"] == "patch-call")
        .expect("patch functionResponse");
    assert_eq!(patch_response["name"], "functions__apply_patch");
    assert_eq!(patch_response["response"], json!("applied"));
    let mcp_response = responses
        .iter()
        .find(|response| response["id"] == "mcp-call")
        .expect("mcp functionResponse");
    assert_eq!(mcp_response["name"], "mcp__search__find");
    assert_eq!(mcp_response["response"], mcp_result);

    let declarations = projected.payload["tools"]
        .as_array()
        .expect("Gemini tools")
        .iter()
        .flat_map(|tool| {
            tool["functionDeclarations"]
                .as_array()
                .into_iter()
                .flatten()
        })
        .collect::<Vec<_>>();
    assert_eq!(declarations.len(), 3);
    assert!(declarations
        .iter()
        .any(|declaration| declaration["name"] == "exec"));
    assert!(declarations
        .iter()
        .any(|declaration| declaration["name"] == "functions__apply_patch"));
    assert!(declarations
        .iter()
        .any(|declaration| declaration["name"] == "mcp__search__find"));
    assert_eq!(
        declarations
            .iter()
            .find(|declaration| declaration["name"] == "exec")
            .unwrap()["parameters"],
        json!({"type": "object", "properties": {"cmd": {"type": "string"}}})
    );

    for source_path in [
        "request.tools[0]",
        "request.tools[1].tools[0]",
        "request.tools[2].tools[0]",
    ] {
        let original = pair
            .inverse_context
            .tool_declarations
            .iter()
            .find(|declaration| declaration.source_path == source_path)
            .unwrap_or_else(|| panic!("missing original declaration {source_path}"));
        let mapping = projected
            .attempt
            .declarations
            .tool_mappings
            .iter()
            .find(|mapping| mapping.declaration_record_id == original.record_id)
            .unwrap_or_else(|| panic!("missing emitted mapping for {source_path}"));
        assert_eq!(mapping.source_path, source_path);
        assert!(mapping
            .destination_path
            .starts_with("tools[0].functionDeclarations["));
    }
}

#[test]
fn native_gemini_uses_current_canonical_values_in_the_same_standard_producer() {
    let raw = json!({
        "systemInstruction":{"parts":[{"text":"system"}]},
        "contents":[
            {"role":"user","parts":[{"text":"old"}]},
            {"role":"model","parts":[{"functionCall":{"id":"native-call","name":"exec","args":{"cmd":"old"}}}]},
            {"role":"user","parts":[{"functionResponse":{"id":"native-call","name":"exec","response":{"output":"old"}}}]}
        ],
        "tools":[{"functionDeclarations":[{"name":"exec","parameters":{"type":"object","properties":{"cmd":{"type":"string"}}}}]}],
        "generationConfig":{"maxOutputTokens":20,"topP":0.8}
    });
    let (_handle, mut canonical, pair, current) =
        sdk_request("native-gemini-standard", "gemini", raw);
    let messages = canonical["messages"].as_array_mut().unwrap();
    let user = messages
        .iter_mut()
        .find(|message| message.pointer("/content/0/text") == Some(&json!("old")))
        .unwrap();
    user["content"][0]["text"] = json!("current text");
    let call = messages
        .iter_mut()
        .find_map(|message| {
            message["tool_calls"]
                .as_array_mut()
                .and_then(|calls| calls.first_mut())
        })
        .unwrap();
    call["function"]["arguments"] = json!({"cmd":"printf 'literal $() and `bytes`'\nprintf tail"});
    canonical["max_completion_tokens"] = json!(40);
    canonical["tools"][0]["function"]["parameters"]["properties"]["cwd"] = json!({"type":"string"});
    let before = canonical.clone();
    let projected = project_canonical_request(
        &canonical,
        &pair.inverse_context,
        &current,
        &pair.explicit_history_pairing,
        V3HubExecutionMode::Relay,
        V3HubProviderWireProtocol::Gemini,
        &target(false),
        "native-gemini-attempt",
    )
    .unwrap();
    assert_eq!(canonical, before);
    assert!(projected.payload.get("model").is_none());
    assert_eq!(projected.payload["generationConfig"]["maxOutputTokens"], 40);
    assert_eq!(
        projected.payload["tools"][0]["functionDeclarations"][0]["parameters"]["properties"]["cwd"],
        json!({"type":"string"})
    );
    let parts = projected.payload["contents"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|content| content["parts"].as_array().unwrap())
        .collect::<Vec<_>>();
    assert!(parts.iter().any(|part| part["text"] == "current text"));
    assert!(parts.iter().any(|part| part["functionCall"]["args"]["cmd"]
        == "printf 'literal $() and `bytes`'\nprintf tail"));
    assert!(parts.iter().any(|part| part["functionResponse"]
        == json!({"id":"native-call","name":"exec","response":{"output":"old"}})));
    let mapping = &projected.attempt.declarations.tool_mappings[0];
    assert_eq!(
        mapping.source_path,
        "request.tools[0].functionDeclarations[0]"
    );
    assert_eq!(mapping.destination_path, "tools[0].functionDeclarations[0]");
}

#[test]
fn native_gemini_relay_preserves_representable_opaque_siblings() {
    let raw = json!({
        "systemInstruction":{"parts":[{"text":"system","vendorPartMetadata":{"keep":[null,1]}}]},
        "contents":[{"role":"user","parts":[
            {"text":"current","thoughtSignature":"signature","vendorPartMetadata":{"keep":true}},
            {"inlineData":{"mimeType":"image/png","data":"UklGRg==","vendor":{"keep":null}}}
        ]}],
        "tools":[{"functionDeclarations":[{"name":"exec","parameters":{"type":"object"},"vendor":{"keep":true}}]}],
        "generationConfig":{"maxOutputTokens":20,"vendor":{"keep":[null,2]}}
    });
    let (_handle, canonical, pair, current) =
        sdk_request("native-gemini-opaque-standard", "gemini", raw.clone());
    let projected = project_canonical_request(
        &canonical,
        &pair.inverse_context,
        &current,
        &pair.explicit_history_pairing,
        V3HubExecutionMode::Relay,
        V3HubProviderWireProtocol::Gemini,
        &target(false),
        "native-gemini-opaque-attempt",
    )
    .unwrap();
    assert_eq!(
        projected.payload, raw,
        "same-protocol Relay must preserve representable opaque business siblings"
    );
}

#[test]
fn native_gemini_opaque_siblings_follow_current_positions_and_deletions() {
    let raw = json!({"contents":[{"role":"user","parts":[
        {"text":"same","thoughtSignature":"first","vendorPartMetadata":{"index":0}},
        {"text":"same","thoughtSignature":"second","vendorPartMetadata":{"index":1}}
    ]}]});
    let (_handle, mut canonical, pair, mut current) =
        sdk_request("native-gemini-current-opaque", "gemini", raw);
    let pair_before = pair.clone();
    let records = canonical["routecodex_chat_extension"]["chat_extension_opaque_record"]
        .as_array_mut()
        .unwrap();
    let vendor = records
        .iter_mut()
        .find(|record| record["path"] == "request.contents[0].parts[1].vendorPartMetadata")
        .unwrap();
    vendor["value"]["index"] = json!(42);
    records.retain(|record| record["path"] != "request.contents[0].parts[0].thoughtSignature");
    (canonical, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::MoveArray {
            array_path: "chat.messages[0].content".into(),
            from: 1,
            to: 0,
        },
    )
    .unwrap();
    (canonical, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::InsertArray {
            array_path: "chat.messages[0].content".into(),
            index: 1,
            value: json!({"type":"text","text":"new current part"}),
        },
    )
    .unwrap();
    let before = canonical.clone();
    let projected = project_canonical_request(
        &canonical,
        &pair.inverse_context,
        &current,
        &pair.explicit_history_pairing,
        V3HubExecutionMode::Relay,
        V3HubProviderWireProtocol::Gemini,
        &target(false),
        "native-gemini-current-opaque-attempt",
    )
    .unwrap();
    assert_eq!(
        projected.payload["contents"][0]["parts"],
        json!([
            {"text":"same","thoughtSignature":"second","vendorPartMetadata":{"index":42}},
            {"text":"new current part"},
            {"text":"same","vendorPartMetadata":{"index":0}}
        ])
    );
    assert_eq!(canonical, before);
    assert_eq!(pair, pair_before);
}

#[test]
fn native_gemini_preserves_builtin_declarations_and_multiple_instruction_parts() {
    let raw = json!({
        "systemInstruction":{"parts":[
            {"text":"first instruction","vendorPartMetadata":{"index":0}},
            {"text":"second instruction","vendorPartMetadata":{"index":1}}
        ]},
        "contents":[{"role":"user","parts":[{"text":"use declared tools"}]}],
        "tools":[
            {"googleSearch":{"excludeDomains":["example.invalid"]}},
            {"functionDeclarations":[{"name":"exec","parameters":{"type":"object"}}],"vendor":{"keep":true}}
        ]
    });
    let (_handle, canonical, pair, current) =
        sdk_request("native-gemini-builtin-standard", "gemini", raw.clone());
    let projection = project_canonical_request(
        &canonical,
        &pair.inverse_context,
        &current,
        &pair.explicit_history_pairing,
        V3HubExecutionMode::Relay,
        V3HubProviderWireProtocol::Gemini,
        &target(false),
        "native-gemini-builtin-attempt",
    )
    .unwrap();
    assert_eq!(
        projection.payload, raw,
        "all native declaration and instruction domains must retain their meaning"
    );
    for original in &pair.inverse_context.tool_declarations {
        assert!(
            projection
                .attempt
                .declarations
                .tool_mappings
                .iter()
                .any(|mapping| mapping.declaration_record_id == original.record_id),
            "missing actually emitted declaration for {}",
            original.source_path
        );
    }
}

#[test]
fn native_gemini_builtin_declarations_use_current_values_and_actual_emission() {
    let raw = json!({
        "contents":[{"role":"user","parts":[{"text":"use tools"}]}],
        "tools":[
            {"googleSearch":{"excludeDomains":["old.invalid"]}},
            {"functionDeclarations":[{"name":"exec","parametersJsonSchema":{"type":"object"}}],"vendor":{"keep":true}}
        ]
    });
    let (_handle, mut canonical, pair, mut current) =
        sdk_request("native-gemini-builtin-current", "gemini", raw);
    let builtin_mapping_index = pair
        .inverse_context
        .field_mappings
        .iter()
        .position(|mapping| {
            mapping.source_path == "request.tools[0]"
                && mapping.operator == "routecodex.v3.field.tool_declaration_transform@1"
        })
        .unwrap();
    let builtin_path = current
        .destination_for_original_mapping(builtin_mapping_index)
        .unwrap()
        .to_string();
    assert!(
        builtin_path.starts_with("chat.routecodex_chat_extension.chat_extension_opaque_record[")
    );
    (canonical, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::Replace {
            path: builtin_path,
            value: json!({"googleSearch":{"excludeDomains":["current.invalid"]}}),
        },
    )
    .unwrap();
    assert_eq!(canonical["tools"].as_array().unwrap().len(), 1);
    canonical["tools"][0]["function"]["name"] = json!("current_exec");
    let record_index = canonical["routecodex_chat_extension"]["chat_extension_opaque_record"]
        .as_array()
        .unwrap()
        .iter()
        .position(|record| record["path"] == "request.tools[0]")
        .unwrap();
    (canonical, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::MoveArray {
            array_path: "chat.routecodex_chat_extension.chat_extension_opaque_record".into(),
            from: record_index,
            to: 0,
        },
    )
    .unwrap();
    let before = canonical.clone();
    let projected = project_canonical_request(
        &canonical,
        &pair.inverse_context,
        &current,
        &pair.explicit_history_pairing,
        V3HubExecutionMode::Relay,
        V3HubProviderWireProtocol::Gemini,
        &target(false),
        "native-gemini-builtin-current-attempt",
    )
    .unwrap();
    assert_eq!(
        projected.payload["tools"],
        json!([
            {"googleSearch":{"excludeDomains":["current.invalid"]}},
            {"functionDeclarations":[{"name":"current_exec","parametersJsonSchema":{"type":"object"}}],"vendor":{"keep":true}}
        ])
    );
    for original in &pair.inverse_context.tool_declarations {
        let mapping = projected
            .attempt
            .declarations
            .tool_mappings
            .iter()
            .find(|mapping| mapping.declaration_record_id == original.record_id)
            .unwrap();
        assert_eq!(mapping.source_path, original.source_path);
        if original.kind == "googleSearch" {
            assert_eq!(mapping.destination_path, "tools[0]");
            assert_eq!(mapping.emitted_kind, "googleSearch");
            assert!(mapping.emitted_name.is_none());
        } else {
            assert_eq!(mapping.destination_path, "tools[1].functionDeclarations[0]");
            assert_eq!(mapping.emitted_name.as_deref(), Some("current_exec"));
        }
    }
    assert_eq!(canonical, before);
    (canonical, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::Remove {
            path: current
                .destination_for_original_mapping(builtin_mapping_index)
                .unwrap()
                .to_string(),
        },
    )
    .unwrap();
    let projected = project_canonical_request(
        &canonical,
        &pair.inverse_context,
        &current,
        &pair.explicit_history_pairing,
        V3HubExecutionMode::Relay,
        V3HubProviderWireProtocol::Gemini,
        &target(false),
        "native-gemini-builtin-deleted-attempt",
    )
    .unwrap();
    assert_eq!(projected.payload["tools"].as_array().unwrap().len(), 1);
    assert_eq!(projected.attempt.declarations.tool_mappings.len(), 1);
    assert_eq!(
        projected.attempt.declarations.tool_mappings[0]
            .emitted_name
            .as_deref(),
        Some("current_exec")
    );
}

#[test]
fn native_instruction_inverse_distinguishes_original_and_generated_newlines() {
    let raw = json!({
        "systemInstruction":{"parts":[{"text":"same"},{"text":"\n"},{"text":"same"}]},
        "contents":[{"role":"user","parts":[{"text":"question"}]}]
    });
    let (_handle, canonical, pair, current) =
        sdk_request("native-instruction-newlines", "gemini", raw.clone());
    let projected = project_canonical_request(
        &canonical,
        &pair.inverse_context,
        &current,
        &pair.explicit_history_pairing,
        V3HubExecutionMode::Relay,
        V3HubProviderWireProtocol::Gemini,
        &target(false),
        "native-instruction-newlines-attempt",
    )
    .unwrap();
    assert_eq!(projected.payload, raw);
}

#[test]
fn native_instruction_current_edits_keep_order_insertions_and_modified_generated_parts() {
    let raw = json!({
        "systemInstruction":{"parts":[
            {"text":"same","vendorPartMetadata":{"source":0}},
            {"text":"same","vendorPartMetadata":{"source":1}}
        ]},
        "contents":[{"role":"user","parts":[{"text":"question"}]}]
    });
    let (_handle, mut canonical, pair, mut current) =
        sdk_request("native-instruction-edits", "gemini", raw);
    let pair_before = pair.clone();
    (canonical, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::Replace {
            path: "chat.messages[0].content[1]".into(),
            value: json!({"type":"text","text":"modified generated contribution"}),
        },
    )
    .unwrap();
    (canonical, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::MoveArray {
            array_path: "chat.messages[0].content".into(),
            from: 2,
            to: 0,
        },
    )
    .unwrap();
    (canonical, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::InsertArray {
            array_path: "chat.messages[0].content".into(),
            index: 1,
            value: json!({"type":"text","text":"\n"}),
        },
    )
    .unwrap();
    let projected = project_canonical_request(
        &canonical,
        &pair.inverse_context,
        &current,
        &pair.explicit_history_pairing,
        V3HubExecutionMode::Relay,
        V3HubProviderWireProtocol::Gemini,
        &target(false),
        "native-instruction-edits-attempt",
    )
    .unwrap();
    assert_eq!(
        projected.payload["systemInstruction"]["parts"],
        json!([
            {"text":"same","vendorPartMetadata":{"source":1}},
            {"text":"\n"},
            {"text":"same","vendorPartMetadata":{"source":0}},
            {"text":"modified generated contribution"}
        ])
    );
    (canonical, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::Remove {
            path: "chat.messages[0].content[2]".into(),
        },
    )
    .unwrap();
    let projected = project_canonical_request(
        &canonical,
        &pair.inverse_context,
        &current,
        &pair.explicit_history_pairing,
        V3HubExecutionMode::Relay,
        V3HubProviderWireProtocol::Gemini,
        &target(false),
        "native-instruction-edits-deleted-attempt",
    )
    .unwrap();
    assert_eq!(
        projected.payload["systemInstruction"]["parts"],
        json!([
            {"text":"same","vendorPartMetadata":{"source":1}},
            {"text":"\n"},
            {"text":"modified generated contribution"}
        ])
    );
    assert_eq!(pair, pair_before);
}

#[test]
fn native_gemini_preserves_instruction_and_content_container_siblings() {
    let raw = json!({
        "systemInstruction":{
            "role":"system","parts":[{"text":"instruction"}],
            "vendorInstruction":{"literal.key[0]":[null,"tail"]}
        },
        "contents":[{
            "role":"user","parts":[{"text":"question"}],
            "vendorContent":{"nested":[null,{"keep":true}]}
        }]
    });
    let (_handle, canonical, pair, current) =
        sdk_request("native-gemini-containers", "gemini", raw.clone());
    let projected = project_canonical_request(
        &canonical,
        &pair.inverse_context,
        &current,
        &pair.explicit_history_pairing,
        V3HubExecutionMode::Relay,
        V3HubProviderWireProtocol::Gemini,
        &target(false),
        "native-gemini-containers-attempt",
    )
    .unwrap();
    assert_eq!(projected.payload, raw);
}

#[test]
fn native_hosted_tools_never_become_invalid_cross_protocol_declarations() {
    let raw = json!({
        "contents":[{"role":"user","parts":[{"text":"use the representable tool"}]}],
        "tools":[
            {"googleSearch":{}}, {"codeExecution":{}},
            {"functionDeclarations":[{"name":"exec","parameters":{"type":"object"}}]}
        ]
    });
    let (_handle, canonical, pair, current) =
        sdk_request("native-builtin-cross-protocol", "gemini", raw);
    let before = canonical.clone();
    for (protocol, provider_type) in [
        (V3HubProviderWireProtocol::OpenAiChat, "openai_chat"),
        (V3HubProviderWireProtocol::Responses, "responses"),
        (V3HubProviderWireProtocol::Anthropic, "anthropic"),
    ] {
        let mut selected = target(false);
        selected.provider_type = provider_type.into();
        let projected = project_canonical_request(
            &canonical,
            &pair.inverse_context,
            &current,
            &pair.explicit_history_pairing,
            V3HubExecutionMode::Relay,
            protocol,
            &selected,
            "native-builtin-cross-protocol-attempt",
        )
        .unwrap();
        let declarations = projected.payload["tools"].as_array().unwrap();
        assert_eq!(
            declarations.len(),
            1,
            "native-only tools must stay outside {provider_type} standard tools"
        );
        let declaration = &declarations[0];
        assert!(declaration.get("googleSearch").is_none());
        assert!(declaration.get("codeExecution").is_none());
        assert_eq!(
            declaration.get("function").unwrap_or(declaration)["name"],
            "exec"
        );
        assert_eq!(projected.attempt.declarations.tool_mappings.len(), 1);
        assert_eq!(
            projected.attempt.declarations.tool_mappings[0]
                .emitted_name
                .as_deref(),
            Some("exec")
        );
        assert_eq!(canonical, before);
    }
}

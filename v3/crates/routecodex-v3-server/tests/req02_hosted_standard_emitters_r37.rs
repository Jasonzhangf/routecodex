//! Public consumer coverage for the single current hosted-history event on the
//! standard Chat, Anthropic and Gemini emitters.
//!
//! Every case drives the public SDK boundary (capture -> lossless normalize ->
//! typed current edit -> `project_canonical_request`) and asserts the final
//! provider payload, not a private slot or helper output.
use routecodex_v3_config::{
    V3ProviderRequestCleanupAuthoringConfig, V3ResponsesTransportKind, V3WebSearchExecutionMode,
};
use routecodex_v3_runtime::hub_v1::{V3HubExecutionMode, V3HubProviderWireProtocol};
use routecodex_v3_runtime::operation_runner::{
    apply_canonical_field_edit, execute_v3_operation_runner_request_capture_client_json,
    execute_v3_operation_runner_request_normalize_losslessly, project_canonical_request,
    CanonicalFieldEdit, CanonicalRequestProjection, CurrentFieldAssociations,
    RequestInvocationContext, RequestNormalizationEntry, RequestOriginKind, RequestScopedContextPair,
    V3RequestContextHandle, V3TargetCandidate,
};
use serde_json::{json, Value};

const EXTENSION_KEY: &str = "responses_hosted_history_event";

#[test]
fn opaque_text_part_fields_survive_chat_standard_projection() {
    let (canonical, pair, current) = normalize(json!({
        "model": "client-model",
        "input": [{"type":"message","role":"user","content":[{
            "type":"input_text","text":"opaque text",
            "vendorPartMetadata":{"dotted.key":[1,null,{"keep":true}]}
        }]}]
    }));
    let chat = project(&canonical, &pair, &current, V3HubProviderWireProtocol::OpenAiChat);
    assert_eq!(chat.payload["messages"][0]["content"], json!([{
        "type":"text","text":"opaque text",
        "vendorPartMetadata":{"dotted.key":[1,null,{"keep":true}]}
    }]), "standard message projection must preserve opaque content siblings");
}

#[test]
fn chat_source_message_type_remains_opaque_on_standard_projection() {
    let (canonical, pair, current) = normalize_entry("openai_chat", json!({
        "model":"client-model", "messages":[{
            "role":"user", "type":"message", "content":"opaque original discriminator"
        }]
    }));
    let chat = project(&canonical, &pair, &current, V3HubProviderWireProtocol::OpenAiChat);
    assert_eq!(chat.payload["messages"][0]["type"], "message",
        "Chat source extension must not be confused with a Responses discriminator");
}

fn target(protocol: V3HubProviderWireProtocol) -> V3TargetCandidate {
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
        model_capabilities: vec!["text".to_string(), "web_search".to_string()],
        web_search_execution_mode: V3WebSearchExecutionMode::NativeRemoteSearchSearchOnly,
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

fn normalize(raw: Value) -> (Value, RequestScopedContextPair, CurrentFieldAssociations) {
    normalize_entry("responses", raw)
}

fn normalize_entry(entry: &str, raw: Value) -> (Value, RequestScopedContextPair, CurrentFieldAssociations) {
    let handle = V3RequestContextHandle::new("hosted-standard".into(), entry.into());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        "hosted-standard-invocation".into(),
        "hosted-standard-attempt".into(),
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
    let current = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
    (canonical, pair, current)
}

fn project(
    canonical: &Value,
    pair: &RequestScopedContextPair,
    current: &CurrentFieldAssociations,
    protocol: V3HubProviderWireProtocol,
) -> CanonicalRequestProjection {
    project_canonical_request(
        canonical,
        &pair.inverse_context,
        current,
        &pair.explicit_history_pairing,
        V3HubExecutionMode::Relay,
        protocol,
        &target(protocol),
        "hosted-standard-attempt",
    )
    .unwrap()
}

#[test]
fn chat_anthropic_gemini_emit_the_complete_current_hosted_event() {
    let event = json!({
        "type": "web_search_call",
        "id": "ws_edit",
        "status": "failed",
        "action": {"type": "search", "query": "routecodex", "dotted.key": {"a.b": [1, {"c.d": "e"}]}},
        "result": {"weird.key": "value", "nested": {"deep.key": {"inner.key": "leaf"}}},
        "unknown_field": {"x": 1},
    });
    let raw = json!({"model": "client-model", "input": [
        event,
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "继续"}]}
    ]});
    let (canonical, pair, current) = normalize(raw);
    let base = format!("chat.messages[0].routecodex_chat_extension.{EXTENSION_KEY}");
    let (canonical, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::Replace {
            path: format!("{base}.action.query"),
            value: json!("after"),
        },
    )
    .unwrap();
    let (canonical, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::Replace {
            path: format!("{base}.unknown_field"),
            value: json!({"replaced": true}),
        },
    )
    .unwrap();
    let expected = json!({
        "type": "web_search_call",
        "id": "ws_edit",
        "status": "failed",
        "action": {"type": "search", "query": "after", "dotted.key": {"a.b": [1, {"c.d": "e"}]}},
        "result": {"weird.key": "value", "nested": {"deep.key": {"inner.key": "leaf"}}},
        "unknown_field": {"replaced": true},
    });

    let chat = project(&canonical, &pair, &current, V3HubProviderWireProtocol::OpenAiChat);
    let chat_messages = chat.payload["messages"].as_array().unwrap();
    let pair_start = chat_messages
        .iter()
        .position(|message| {
            message
                .pointer("/tool_calls/0/function/name")
                .and_then(Value::as_str)
                == Some("web_search")
        })
        .expect("Chat provider wire must include the hosted assistant call");
    assert_eq!(
        chat_messages[pair_start]["tool_calls"][0]["id"],
        json!("ws_edit")
    );
    assert_eq!(
        chat_messages[pair_start]["tool_calls"][0]["function"]["name"],
        json!("web_search")
    );
    let chat_arguments: Value = serde_json::from_str(
        chat_messages[pair_start]["tool_calls"][0]["function"]["arguments"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(chat_arguments, expected["action"]);
    assert_eq!(chat_messages[pair_start + 1]["role"], json!("tool"));
    assert_eq!(
        chat_messages[pair_start + 1]["tool_call_id"],
        json!("ws_edit")
    );
    let chat_result: Value = serde_json::from_str(
        chat_messages[pair_start + 1]["content"].as_str().unwrap(),
    )
    .unwrap();
    assert_eq!(chat_result, expected);

    let anthropic = project(&canonical, &pair, &current, V3HubProviderWireProtocol::Anthropic);
    let anthropic_messages = anthropic.payload["messages"].as_array().unwrap();
    let assistant = anthropic_messages
        .iter()
        .find(|message| message.get("role") == Some(&json!("assistant")))
        .expect("Anthropic assistant message");
    let blocks = assistant["content"].as_array().unwrap();
    assert_eq!(blocks[0]["type"], json!("server_tool_use"));
    assert_eq!(blocks[0]["id"], json!("ws_edit"));
    assert_eq!(blocks[0]["name"], json!("web_search"));
    assert_eq!(blocks[0]["input"], expected["action"]);
    assert_eq!(blocks[1]["type"], json!("web_search_tool_result"));
    assert_eq!(blocks[1]["tool_use_id"], json!("ws_edit"));
    assert_eq!(blocks[1]["content"]["status"], json!("failed"));
    assert_eq!(blocks[1]["content"]["action"], expected["action"]);
    assert_eq!(blocks[1]["content"]["result"], expected["result"]);
    assert_eq!(blocks[1]["content"]["unknown_field"], json!({"replaced": true}));
    assert!(blocks[1]["content"].get("id").is_none());
    assert!(blocks[1]["content"].get("type").is_none());

    let gemini = project(&canonical, &pair, &current, V3HubProviderWireProtocol::Gemini);
    let contents = gemini.payload["contents"].as_array().unwrap();
    let model_call = contents
        .iter()
        .find_map(|message| {
            message["parts"]
                .as_array()
                .and_then(|parts| parts.iter().find(|part| part.get("functionCall").is_some()))
        })
        .expect("Gemini model functionCall");
    assert_eq!(model_call["functionCall"]["name"], json!("web_search"));
    assert_eq!(model_call["functionCall"]["id"], json!("ws_edit"));
    assert_eq!(model_call["functionCall"]["args"], expected["action"]);
    let user_response = contents
        .iter()
        .find_map(|message| {
            message["parts"]
                .as_array()
                .and_then(|parts| parts.iter().find(|part| part.get("functionResponse").is_some()))
        })
        .expect("Gemini user functionResponse");
    assert_eq!(user_response["functionResponse"]["name"], json!("web_search"));
    assert_eq!(user_response["functionResponse"]["id"], json!("ws_edit"));
    assert_eq!(user_response["functionResponse"]["response"], expected);
}

#[test]
fn failed_and_unknown_status_are_not_rejected_and_crlf_long_bytes_are_kept() {
    let long = format!("{}\r\nEXACT_HOSTED_TAIL", "x".repeat(70_000));
    let item = json!({
        "type": "web_search_call",
        "id": "ws_long",
        "status": "quarantined",
        "action": {"type": "search", "query": long, "dotted.key": {"a.b": [1, {"c.d": "e"}]}},
        "result": {"weird.key": "value", "nested": {"deep.key": {"inner.key": "leaf"}}},
        "error": {"code": "upstream_error", "message": "boom"},
    });
    let raw = json!({"model": "client-model", "input": [item]});
    let (canonical, pair, current) = normalize(raw);
    let chat = project(&canonical, &pair, &current, V3HubProviderWireProtocol::OpenAiChat);
    let result: Value = serde_json::from_str(
        chat.payload["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|message| message.get("role") == Some(&json!("tool")))
            .unwrap()["content"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(result, item);
    let anthropic = project(&canonical, &pair, &current, V3HubProviderWireProtocol::Anthropic);
    let blocks = anthropic.payload["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|message| message.get("role") == Some(&json!("assistant")))
        .unwrap()["content"]
        .as_array()
        .unwrap();
    assert_eq!(blocks[1]["content"]["status"], json!("quarantined"));
    assert_eq!(blocks[1]["content"]["error"]["code"], json!("upstream_error"));
    assert_eq!(blocks[1]["content"]["result"]["nested"]["deep.key"]["inner.key"], json!("leaf"));
}

#[test]
fn instructions_before_hosted_anchor_keep_both_on_the_chat_wire() {
    let raw = json!({
        "model": "client-model",
        "instructions": "SYSTEM_GUARD",
        "input": [
            {"type": "web_search_call", "id": "ws_instr", "status": "completed",
             "action": {"type": "search", "query": "instructions"}},
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "继续"}]}
        ]
    });
    let (canonical, pair, current) = normalize(raw);
    let chat = project(&canonical, &pair, &current, V3HubProviderWireProtocol::OpenAiChat);
    let messages = chat.payload["messages"].as_array().unwrap();
    assert!(
        messages.iter().any(|message| message["content"]
            .as_str()
            .is_some_and(|content| content.contains("SYSTEM_GUARD"))),
        "instructions must survive hosted expansion: {messages:?}"
    );
    let pair_start = messages
        .iter()
        .position(|message| {
            message
                .pointer("/tool_calls/0/function/name")
                .and_then(Value::as_str)
                == Some("web_search")
        })
        .expect("hosted assistant call must emit after instructions");
    assert_eq!(messages[pair_start]["tool_calls"][0]["id"], json!("ws_instr"));
    assert_eq!(messages[pair_start + 1]["role"], json!("tool"));
    assert_eq!(messages[pair_start + 1]["tool_call_id"], json!("ws_instr"));
    assert_eq!(
        messages.last().unwrap(),
        &json!({"role": "user", "content": "继续"})
    );
}

#[test]
fn whole_anchor_removal_emits_no_hosted_pair() {
    let raw = json!({"model": "client-model", "input": [
        {"type": "web_search_call", "id": "ws_del", "status": "completed",
         "action": {"type": "search", "query": "gone"}},
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "hi"}]}
    ]});
    let (canonical, pair, current) = normalize(raw);
    let (canonical, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::Remove {
            path: "chat.messages[0]".to_string(),
        },
    )
    .unwrap();
    for protocol in [
        V3HubProviderWireProtocol::OpenAiChat,
        V3HubProviderWireProtocol::Anthropic,
        V3HubProviderWireProtocol::Gemini,
    ] {
        let projected = project(&canonical, &pair, &current, protocol);
        let text = serde_json::to_string(&projected.payload).unwrap();
        assert!(!text.contains("web_search"), "removed event must not emit: {projected:?}");
    }
}

#[test]
fn move_preserves_hosted_event_order() {
    let raw = json!({"model": "client-model", "input": [
        {"type": "web_search_call", "id": "ws_move", "status": "completed",
         "action": {"type": "search", "query": "order"}},
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "before"}]}
    ]});
    let (canonical, pair, current) = normalize(raw);
    let (canonical, current) = apply_canonical_field_edit(
        &canonical,
        &current,
        &CanonicalFieldEdit::MoveArray {
            array_path: "chat.messages".to_string(),
            from: 0,
            to: 1,
        },
    )
    .unwrap();
    let chat = project(&canonical, &pair, &current, V3HubProviderWireProtocol::OpenAiChat);
    let messages = chat.payload["messages"].as_array().unwrap();
    let pair_start = messages
        .iter()
        .position(|message| {
            message
                .pointer("/tool_calls/0/function/name")
                .and_then(Value::as_str)
                == Some("web_search")
        })
        .expect("moved hosted event must still emit");
    assert_eq!(messages[pair_start - 1]["role"], json!("user"));
    assert_eq!(messages[pair_start + 1]["role"], json!("tool"));
    assert_eq!(
        messages[pair_start + 1]["tool_call_id"],
        json!("ws_move")
    );
}

#[test]
fn ordinary_tool_and_hosted_interleave_in_one_anthropic_assistant() {
    let raw = json!({"model": "client-model", "input": [
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "search, then run"}]},
        {"type": "function_call", "call_id": "call_exec", "name": "exec_command", "arguments": "{\"cmd\":\"pwd\"}"},
        {"type": "web_search_call", "id": "ws_search_2", "status": "completed",
         "action": {"type": "search", "query": "Ubuntu"}, "result": {"title": "t", "url": "u"}},
        {"type": "function_call_output", "call_id": "call_exec", "output": "/tmp"}
    ]});
    let (canonical, pair, current) = normalize(raw);
    let anthropic = project(&canonical, &pair, &current, V3HubProviderWireProtocol::Anthropic);
    let messages = anthropic.payload["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 3);
    let assistant = &messages[1];
    assert_eq!(assistant["role"], json!("assistant"));
    assert_eq!(assistant["content"][0]["type"], json!("tool_use"));
    assert_eq!(assistant["content"][0]["id"], json!("call_exec"));
    assert_eq!(assistant["content"][1]["type"], json!("server_tool_use"));
    assert_eq!(assistant["content"][1]["id"], json!("ws_search_2"));
    assert_eq!(
        assistant["content"][2]["type"],
        json!("web_search_tool_result")
    );
    assert_eq!(
        assistant["content"][2]["tool_use_id"],
        json!("ws_search_2")
    );
    assert_eq!(messages[2]["content"][0]["type"], json!("tool_result"));
    assert_eq!(messages[2]["content"][0]["tool_use_id"], json!("call_exec"));

    let chat = project(&canonical, &pair, &current, V3HubProviderWireProtocol::OpenAiChat);
    let chat_messages = chat.payload["messages"].as_array().unwrap();
    let web = chat_messages
        .iter()
        .position(|message| {
            message
                .pointer("/tool_calls/0/function/name")
                .and_then(Value::as_str)
                == Some("web_search")
        })
        .unwrap();
    assert_eq!(chat_messages[web + 1]["role"], json!("tool"));
    assert_eq!(
        chat_messages[web + 1]["tool_call_id"],
        json!("ws_search_2")
    );
    let exec = chat_messages
        .iter()
        .position(|message| {
            message
                .pointer("/tool_calls/0/function/name")
                .and_then(Value::as_str)
                == Some("exec_command")
        })
        .unwrap();
    let exec_result = chat_messages
        .iter()
        .position(|message| message.get("tool_call_id") == Some(&json!("call_exec")))
        .unwrap();
    assert!(exec < web);
    assert!(exec_result > web);
    assert_eq!(chat_messages[exec_result]["content"], json!("/tmp"));
}

#[test]
fn hosted_before_discovered_declaration_keeps_original_source_identity() {
    let raw = json!({
        "model": "client-model",
        "tools": [{"type": "tool_search"}],
        "input": [
            {"type": "web_search_call", "id": "ws_shift", "status": "completed",
             "action": {"type": "search", "query": "shift"}},
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
    let (canonical, pair, current) = normalize(raw);
    let declaration = pair
        .inverse_context
        .tool_declarations
        .iter()
        .find(|declaration| declaration.source_path == "request.input[2].tools[0].tools[0]")
        .expect("discovered declaration must retain its original request identity");
    let chat = project(&canonical, &pair, &current, V3HubProviderWireProtocol::OpenAiChat);
    assert!(
        chat.attempt
            .declarations
            .tool_mappings
            .iter()
            .any(|mapping| mapping.declaration_record_id == declaration.record_id),
        "hosted message expansion must not shift the discovered declaration record: {}",
        chat.payload
    );
    let text = serde_json::to_string(&chat.payload).unwrap();
    assert!(text.contains("web_search"));
    assert!(text.contains("echo"));
}

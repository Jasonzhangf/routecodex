use super::*;

// Chat semantics reaching a Gemini target must either project into the Gemini
// wire shape or fail explicitly at the protocol boundary; they must never be
// silently stripped before the provider wire.
#[test]
fn gemini_wire_projects_reasoning_effort_and_tool_choice() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "think"}]}],
        "reasoning_effort": "high",
        "tool_choice": "required"
    });
    let request =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect("Gemini outbound must project compatible fields");
    assert_eq!(
        request.pointer("/generationConfig/thinkingConfig/thinkingLevel"),
        Some(&json!("HIGH"))
    );
    assert_eq!(
        request.pointer("/toolConfig/functionCallingConfig/mode"),
        Some(&json!("ANY"))
    );
    for consumed in ["reasoning_effort", "tool_choice"] {
        assert!(
            request.get(consumed).is_none(),
            "consumed Chat field {consumed} must not reach the Gemini wire: {request}"
        );
    }
}

#[test]
fn gemini_wire_reasoning_effort_overrides_existing_thinking_level() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "think"}]}],
        "generationConfig": {
            "thinkingConfig": {
                "thinkingLevel": "LOW"
            }
        },
        "reasoning_effort": "high"
    });
    let request =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect("canonical Chat reasoning_effort must own the outbound thinking level");
    assert_eq!(
        request.pointer("/generationConfig/thinkingConfig/thinkingLevel"),
        Some(&json!("HIGH"))
    );
    assert!(request.get("reasoning_effort").is_none(), "{request}");
}

#[test]
fn gemini_selected_target_rejects_reasoning_effort_without_reasoning_capability() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "think"}]}],
        "reasoning_effort": "high"
    });
    let error = project_outbound_payload_for_selected_target_protocol(
        &payload,
        V3OutboundTargetProtocol::Gemini,
        &["text".to_string(), "tools".to_string()],
    )
    .expect_err("Gemini thinkingLevel projection must require selected target capability");
    assert_eq!(
        error,
        "UnmappedOutboundFields target_protocol=gemini paths=$.reasoning_effort missing_capability=reasoning"
    );
}

#[test]
fn gemini_selected_target_rejects_thinking_budget_without_reasoning_capability() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "think"}]}],
        "generationConfig": {
            "thinkingConfig": {
                "thinkingBudget": 4096
            }
        }
    });
    let error = project_outbound_payload_for_selected_target_protocol(
        &payload,
        V3OutboundTargetProtocol::Gemini,
        &["text".to_string(), "tools".to_string()],
    )
    .expect_err("Gemini thinkingBudget projection must require selected target capability");
    assert_eq!(
        error,
        "UnmappedOutboundFields target_protocol=gemini paths=$.generationConfig.thinkingConfig.thinkingBudget missing_capability=reasoning"
    );
}

#[test]
fn gemini_selected_target_projects_reasoning_with_reasoning_capability() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "think"}]}],
        "reasoning_effort": "high"
    });
    let request = project_outbound_payload_for_selected_target_protocol(
        &payload,
        V3OutboundTargetProtocol::Gemini,
        &["text".to_string(), "reasoning".to_string()],
    )
    .expect("selected Gemini target with reasoning capability must accept thinkingLevel");
    assert_eq!(
        request.pointer("/generationConfig/thinkingConfig/thinkingLevel"),
        Some(&json!("HIGH"))
    );
}

#[test]
fn gemini_wire_rejects_reasoning_effort_without_a_shared_level() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "think"}]}],
        "reasoning_effort": "xhigh"
    });
    let error =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect_err("an effort without a Gemini equivalent must fail explicitly");
    assert_eq!(
        error,
        "UnmappedOutboundFields target_protocol=gemini paths=$.reasoning_effort"
    );
}

#[test]
fn gemini_wire_rejects_reasoning_summary_policy_without_a_wire_equivalent() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "think"}]}],
        "reasoning_summary_policy": "detailed"
    });
    let error =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect_err("Gemini has no exact request-side summary policy equivalent");
    assert_eq!(
        error,
        "UnmappedOutboundFields target_protocol=gemini paths=$.reasoning_summary_policy"
    );
}

#[test]
fn gemini_wire_rejects_unknown_routecodex_chat_extension() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "think"}]}],
        "routecodex_chat_extension": {"route": "search"}
    });
    let error =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect_err("unknown Chat extensions must not be stripped for Gemini");
    assert_eq!(
        error,
        "UnmappedOutboundFields target_protocol=gemini paths=$.routecodex_chat_extension.route"
    );
}

#[test]
fn gemini_wire_projects_function_tool_choice_names() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "go"}]}],
        "tool_choice": {"type": "function", "function": {"name": "lookup"}}
    });
    let request =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect("function tool_choice must project onto functionCallingConfig");
    assert_eq!(
        request.pointer("/toolConfig/functionCallingConfig/mode"),
        Some(&json!("ANY"))
    );
    assert_eq!(
        request.pointer("/toolConfig/functionCallingConfig/allowedFunctionNames"),
        Some(&json!(["lookup"]))
    );
}

#[test]
fn gemini_wire_rejects_malformed_function_tool_choice_name() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "go"}]}],
        "tool_choice": {"type": "function", "function": {"name": 123}}
    });
    let error =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect_err("malformed function names must not be dropped");
    assert_eq!(
        error,
        "MalformedOutboundField target_protocol=gemini path=$.tool_choice.function.name"
    );
}

#[test]
fn gemini_wire_rejects_function_tool_choice_missing_name() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "go"}]}],
        "tool_choice": {"type": "function", "function": {}}
    });
    let error =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect_err("function-specific tool_choice must name the function");
    assert_eq!(
        error,
        "MalformedOutboundField target_protocol=gemini path=$.tool_choice.function.name"
    );
}

#[test]
fn gemini_wire_rejects_unknown_tool_choice_member() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "go"}]}],
        "tool_choice": {"type": "function", "function": {"name": "lookup"}, "route": "shadow"}
    });
    let error =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect_err("unknown tool_choice members must not be stripped");
    assert_eq!(
        error,
        "UnmappedOutboundFields target_protocol=gemini paths=$.tool_choice.route"
    );
}

#[test]
fn gemini_wire_rejects_malformed_allowed_function_names() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "go"}]}],
        "tool_choice": {
            "type": "function",
            "allowedFunctionNames": ["lookup", 123]
        }
    });
    let error =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect_err("malformed allowed function names must not be dropped");
    assert_eq!(
        error,
        "MalformedOutboundField target_protocol=gemini path=$.tool_choice.allowedFunctionNames[1]"
    );
}

#[test]
fn gemini_wire_preserves_user_owned_routecodex_chat_extension_schema_property() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{
            "role": "user",
            "parts": [{"text": "hi"}]
        }],
        "tools": [{
            "functionDeclarations": [{
                "name": "lookup",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "routecodex_chat_extension": {"type": "string"}
                    }
                }
            }]
        }]
    });
    let request =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect("user-owned schema properties must not be treated as Chat extensions");
    assert_eq!(
        request.pointer(
            "/tools/0/functionDeclarations/0/parameters/properties/routecodex_chat_extension/type"
        ),
        Some(&json!("string"))
    );
}

// Regression for the live 4444 failure shape: a Responses-origin Chat payload
// routed to a chat:gemini provider carried target-unsupported Chat semantics.
// It must now fail explicitly in outbound projection instead of being silently
// stripped or leaking to the provider body.
#[test]
fn gemini_wire_rejects_responses_origin_unsupported_chat_fields_reported_live() {
    let payload = json!({
        "model": "gemini-3.8-flash",
        "contents": [{"role": "user", "parts": [{"text": "hi"}]}],
        "parallel_tool_calls": true,
        "reasoning_effort": "medium",
        "reasoning_summary_policy": "auto",
        "routecodex_chat_extension": {"responses_request": {"store": false}},
        "tool_choice": "auto",
        "stream": true
    });
    let error =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect_err(
                "unsupported Gemini Chat semantics must fail explicitly before provider wire",
            );
    assert!(
        error.contains("UnmappedOutboundFields target_protocol=gemini"),
        "{error}"
    );
    assert!(error.contains("$.parallel_tool_calls"), "{error}");
    assert!(error.contains("$.reasoning_summary_policy"), "{error}");
    assert!(
        error.contains("$.routecodex_chat_extension.responses_request.store"),
        "{error}"
    );
}

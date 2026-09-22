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
fn gemini_wire_consumes_default_safe_reasoning_summary_policy() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "think"}]}],
        "reasoning_summary_policy": "detailed"
    });
    let request =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect("the live Codex client's detailed summary policy is a declared no-op");
    assert!(
        request.get("reasoning_summary_policy").is_none(),
        "consumed reasoning_summary_policy must not reach Gemini wire: {request}"
    );
}

#[test]
fn gemini_wire_rejects_invalid_reasoning_summary_policy_as_unmapped() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "think"}]}],
        "reasoning_summary_policy": "verbose"
    });
    let error =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect_err("Gemini has no declared reasoning_summary_policy projection");
    assert_eq!(
        error,
        "UnmappedOutboundFields target_protocol=gemini paths=$.reasoning_summary_policy"
    );
}

#[test]
fn gemini_wire_rejects_whitespace_reasoning_summary_policy_as_unmapped() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "think"}]}],
        "reasoning_summary_policy": " auto "
    });
    let error =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect_err("Gemini must not trim canonical reasoning_summary_policy values");
    assert_eq!(
        error,
        "UnmappedOutboundFields target_protocol=gemini paths=$.reasoning_summary_policy"
    );
}

#[test]
fn gemini_wire_consumes_parallel_tool_calls_true_as_default_safe() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "think"}]}],
        "parallel_tool_calls": true
    });
    let request =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect(
            "parallel_tool_calls=true is the permissive default and should not constrain Gemini",
        );
    assert!(
        request.get("parallel_tool_calls").is_none(),
        "default-safe parallel_tool_calls must not reach Gemini wire: {request}"
    );
}

#[test]
fn gemini_wire_rejects_parallel_tool_calls_false_as_unmapped() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "think"}]}],
        "parallel_tool_calls": false
    });
    let error =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect_err("Gemini cannot enforce disabled parallel tool calls");
    assert_eq!(
        error,
        "UnmappedOutboundFields target_protocol=gemini paths=$.parallel_tool_calls"
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

// Regression for the live 4444 failure shape: default-safe Responses-origin
// fields must be consumed while non-default or constraining semantics remain
// explicit unmapped errors.
#[test]
fn gemini_wire_consumes_default_safe_responses_origin_fields_reported_live() {
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
    let request =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect("Gemini must consume default-safe Responses-origin fields");
    assert_eq!(
        request.pointer("/generationConfig/thinkingConfig/thinkingLevel"),
        Some(&json!("MEDIUM"))
    );
    assert_eq!(
        request.pointer("/toolConfig/functionCallingConfig/mode"),
        Some(&json!("AUTO"))
    );
    for consumed in [
        "parallel_tool_calls",
        "reasoning_effort",
        "reasoning_summary_policy",
        "routecodex_chat_extension",
        "tool_choice",
    ] {
        assert!(
            request.get(consumed).is_none(),
            "consumed field {consumed} must not reach Gemini wire: {request}"
        );
    }
}

#[test]
fn gemini_wire_consumes_false_responses_store_extension() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "hi"}]}],
        "routecodex_chat_extension": {"responses_request": {"store": false}},
        "stream": true
    });
    let request =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect("store=false is a no-op persistence request and must not leak to Gemini");
    assert!(
        request.get("routecodex_chat_extension").is_none(),
        "RouteCodex extension must not reach Gemini wire: {request}"
    );
}

#[test]
fn gemini_wire_rejects_responses_origin_reasoning_summary_policy_extension() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "hi"}]}],
        "routecodex_chat_extension": {
            "responses_request": {
                "reasoning_summary_policy": "auto",
                "store": false
            }
        }
    });
    let error =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect_err("Gemini has no declared Responses summary-policy projection");
    assert_eq!(
        error,
        "UnmappedOutboundFields target_protocol=gemini paths=$.routecodex_chat_extension.responses_request.reasoning_summary_policy"
    );
}

#[test]
fn gemini_wire_rejects_true_responses_store_extension() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "hi"}]}],
        "routecodex_chat_extension": {"responses_request": {"store": true}}
    });
    let error =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect_err("Gemini cannot honor a true Responses store request");
    assert_eq!(
        error,
        "UnmappedOutboundFields target_protocol=gemini paths=$.routecodex_chat_extension.responses_request.store"
    );
}

// Regression for live bug 6215563: the Codex Responses client always sends
// `client_metadata`, `prompt_cache_key` and `text.output_config` inside the
// registered `routecodex_chat_extension.responses_request` container. Those
// values are request-local Codex context, not provider semantics, so Gemini
// must consume the declared default-safe values before wire and keep failing
// closed for constraining or malformed values.
#[test]
fn gemini_wire_consumes_live_codex_responses_extension_fields() {
    let payload = json!({
        "model": "gemini-3.8-flash",
        "contents": [{"role": "user", "parts": [{"text": "hi"}]}],
        "parallel_tool_calls": true,
        "reasoning_effort": "high",
        "reasoning_summary_policy": "detailed",
        "tool_choice": "auto",
        "stream": true,
        "routecodex_chat_extension": {
            "responses_request": {
                "client_metadata": {
                    "session_id": "01a0c963-890c-7b83-ab9f-b30d03a5a7ae",
                    "thread_id": "01a0c963-890c-7b83-ab9f-b30d03a5a7ae",
                    "turn_id": "01a0c96f-a956-74f3-94ad-b208ba48953d",
                    "root_turn_id": "01a0c96f-a956-74f3-94ad-b208ba48953d",
                    "x-codex-installation-id": "15252310-9634-460d-9809-64a631ebd187",
                    "x-codex-turn-metadata": "{\"agent_name\":\"/root\"}",
                    "x-codex-window-id": "01a0c963-890c-7b83-ab9f-b30d0"
                },
                "prompt_cache_key": "01a0c963-890c-7b83-ab9f-b30d03a5a7ae",
                "store": false,
                "text": {"verbosity": "high"}
            }
        }
    });
    let request =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect("declared default-safe Codex extension fields must be consumed before Gemini wire");
    assert!(
        request.get("routecodex_chat_extension").is_none(),
        "RouteCodex extension must never reach the Gemini wire: {request}"
    );
}

#[test]
fn gemini_wire_rejects_unknown_client_metadata_key() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "hi"}]}],
        "routecodex_chat_extension": {
            "responses_request": {
                "client_metadata": {"unregistered_key": "v"}
            }
        }
    });
    let error =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect_err("unregistered client_metadata keys are not declared for Gemini");
    assert_eq!(
        error,
        "UnmappedOutboundFields target_protocol=gemini paths=$.routecodex_chat_extension.responses_request.client_metadata.unregistered_key"
    );
}

#[test]
fn gemini_wire_rejects_client_metadata_user_id_without_a_target_field() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "hi"}]}],
        "routecodex_chat_extension": {
            "responses_request": {
                "client_metadata": {"user_id": "client-user"}
            }
        }
    });
    let error =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect_err("Gemini has no client_metadata.user_id target field");
    assert_eq!(
        error,
        "UnmappedOutboundFields target_protocol=gemini paths=$.routecodex_chat_extension.responses_request.client_metadata.user_id"
    );
}

#[test]
fn gemini_wire_rejects_malformed_prompt_cache_key() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "hi"}]}],
        "routecodex_chat_extension": {
            "responses_request": {"prompt_cache_key": "   "}
        }
    });
    let error =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect_err("an empty prompt_cache_key is malformed for Gemini");
    assert_eq!(
        error,
        "MalformedOutboundField target_protocol=gemini path=$.routecodex_chat_extension.responses_request.prompt_cache_key"
    );
}

#[test]
fn gemini_wire_rejects_invalid_text_verbosity() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "hi"}]}],
        "routecodex_chat_extension": {
            "responses_request": {"text": {"verbosity": "verbose"}}
        }
    });
    let error =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect_err("verbosity outside low/medium/high is malformed for Gemini");
    assert_eq!(
        error,
        "MalformedOutboundField target_protocol=gemini path=$.routecodex_chat_extension.responses_request.text.verbosity"
    );
}

#[test]
fn gemini_wire_rejects_unmapped_text_format() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "hi"}]}],
        "routecodex_chat_extension": {
            "responses_request": {"text": {"format": {"type": "json_schema"}}}
        }
    });
    let error =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect_err("Gemini has no declared text.format projection in this owner");
    assert_eq!(
        error,
        "UnmappedOutboundFields target_protocol=gemini paths=$.routecodex_chat_extension.responses_request.text.format"
    );
}

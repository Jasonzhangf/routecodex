use super::*;

#[test]
fn gemini_table_consumer_generation_config_scalars_follow_field_map() {
    let temperature = crate::protocol_tables::map_field(
        "gemini",
        "temperature",
        crate::protocol_tables::V3TableDirection::Outbound,
    )
    .unwrap()
    .expect("Gemini temperature field must be declared");
    let max_output_tokens = crate::protocol_tables::map_field(
        "gemini",
        "max_completion_tokens",
        crate::protocol_tables::V3TableDirection::Outbound,
    )
    .unwrap()
    .expect("Gemini max-output field must be declared");

    let mut generation_config = Map::new();
    generation_config.insert(temperature.to_string(), json!(0.25));
    generation_config.insert(max_output_tokens.to_string(), json!(0));
    generation_config.insert("topK".to_string(), json!(40));
    generation_config.insert(
        "nativeResidual".to_string(),
        json!({"nested": ["preserved"]}),
    );
    let payload = json!({
        "contents": [{"role": "user", "parts": [{"text": "sample"}]}],
        "generationConfig": generation_config
    });
    let canonical = crate::hub_v1::build_v3_chat_canonical_request_from_gemini_payload(&payload)
        .expect("Gemini generationConfig must canonicalize through the production builder");
    assert_eq!(canonical["temperature"], json!(0.25));
    assert_eq!(canonical["max_completion_tokens"], json!(0));
    assert_eq!(canonical["top_k"], json!(40));

    let generation = canonical
        .pointer("/routecodex_chat_extension/gemini_native_fields/0/fields/generationConfig")
        .expect("unmapped generationConfig members must remain in the request residual");
    assert!(generation.get(temperature).is_none());
    assert!(generation.get(max_output_tokens).is_none());
    assert_eq!(
        generation["nativeResidual"],
        json!({"nested": ["preserved"]})
    );

    let projected =
        project_outbound_payload_for_target_protocol(&canonical, V3OutboundTargetProtocol::Gemini)
            .expect("Gemini native restore must consume the declared scalar fields");
    assert_eq!(projected["generationConfig"][temperature], json!(0.25));
    assert_eq!(projected["generationConfig"][max_output_tokens], json!(0));
    assert_eq!(
        projected["generationConfig"]["nativeResidual"],
        json!({"nested": ["preserved"]})
    );
}

#[test]
fn gemini_table_consumer_tool_choice_aliases_follow_tool_choice_map() {
    let expected_any = crate::protocol_tables::map_value(
        crate::protocol_tables::V3TableKind::ToolChoice,
        "gemini",
        "required",
        crate::protocol_tables::V3TableDirection::Outbound,
    )
    .unwrap()
    .expect("Gemini required tool choice must be declared");

    for value in ["required", "any", "tool", "function"] {
        let payload = json!({
            "model": "gemini-test",
            "contents": [{"role": "user", "parts": [{"text": "go"}]}],
            "tool_choice": value
        });
        let projected = project_outbound_payload_for_target_protocol(
            &payload,
            V3OutboundTargetProtocol::Gemini,
        )
        .unwrap_or_else(|error| panic!("Gemini tool_choice alias {value} must project: {error}"));
        assert_eq!(
            projected.pointer("/toolConfig/functionCallingConfig/mode"),
            Some(&json!(expected_any)),
            "Gemini tool_choice alias {value} must use the table declaration"
        );
    }

    let expected_inbound = crate::protocol_tables::map_value(
        crate::protocol_tables::V3TableKind::ToolChoice,
        "gemini",
        "ANY",
        crate::protocol_tables::V3TableDirection::Inbound,
    )
    .unwrap()
    .expect("Gemini inbound ANY must be declared");
    let canonical = crate::hub_v1::build_v3_chat_canonical_request_from_gemini_payload(&json!({
        "contents": [{"role": "user", "parts": [{"text": "go"}]}],
        "toolConfig": {"functionCallingConfig": {"mode": "ANY"}}
    }))
    .expect("Gemini inbound ANY must pass through the production builder");
    assert_eq!(canonical["tool_choice"], json!(expected_inbound));

    for value in ["any", "tool", "function"] {
        assert_eq!(
            crate::protocol_tables::map_value(
                crate::protocol_tables::V3TableKind::ToolChoice,
                "gemini",
                value,
                crate::protocol_tables::V3TableDirection::Inbound,
            )
            .unwrap(),
            None,
            "Gemini inbound aliases must not be invented: {value}"
        );
    }
}

#[test]
fn gemini_history_projects_only_each_calls_original_signature() {
    let mut request = json!({"messages":[{"role":"assistant","content":"","tool_calls":[
        {"id":"signed","type":"function","thought_signature":"opaque/function/+==","function":{"name":"function","arguments":"{\"left\":19,\"right\":23}"}},
        {"id":"unsigned","type":"function","function":{"name":"unsigned","arguments":"{malformed"}}
    ]},{"role":"tool","tool_call_id":"signed","content":"42"}]});
    project_gemini_chat_request(&mut request).unwrap();
    let parts = &request["contents"][0]["parts"];
    assert_eq!(parts[0]["thoughtSignature"], "opaque/function/+==");
    assert!(parts[1].get("thoughtSignature").is_none());
    assert_eq!(parts[1]["functionCall"]["args"], "{malformed");
    assert_eq!(
        request["contents"][1]["parts"][0]["functionResponse"]["id"],
        "signed"
    );
    assert_eq!(
        request["contents"][1]["parts"][0]["functionResponse"]["response"]["output"],
        "42"
    );
    let mut native = json!({"contents":[{"role":"model","parts":[{"functionCall":{"name":"native","args":{}},"thoughtSignature":"native/+=="}]}]});
    let original = native.clone();
    project_gemini_chat_request(&mut native).unwrap();
    assert_eq!(native, original);
}

#[test]
fn gemini_standard_projection_preserves_opaque_tools_beside_shared_declarations() {
    let opaque = json!({"googleSearch":{"excludeDomains":["example.invalid"]}});
    let source = json!({"messages":[{"role":"user","content":"plain request"}],"tools":[
        opaque,
        {"type":"namespace","name":"declared","tools":[{"type":"function","name":"leaf","parameters":{"type":"object"}}]}
    ],"tool_choice":{"type":"function","name":"declared.leaf"}});
    let projected =
        project_outbound_payload_for_target_protocol(&source, V3OutboundTargetProtocol::Gemini)
            .unwrap();
    assert_eq!(projected["tools"][0], opaque);
    let name = &projected["tools"][1]["functionDeclarations"][0]["name"];
    assert_eq!(
        &projected["toolConfig"]["functionCallingConfig"]["allowedFunctionNames"][0],
        name
    );
    assert_eq!(
        projected["contents"][0]["parts"][0]["text"],
        "plain request"
    );
    assert!(projected.get("messages").is_none());
}

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
fn gemini_wire_preserves_reasoning_summary_policy_opaquely() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "think"}]}],
        "reasoning_summary_policy": "detailed"
    });
    let projected =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect("unknown policy fields remain opaque business data");
    assert_eq!(
        projected["reasoning_summary_policy"],
        payload["reasoning_summary_policy"]
    );
}

#[test]
fn gemini_wire_preserves_unknown_reasoning_summary_policy_opaquely() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "think"}]}],
        "reasoning_summary_policy": "verbose"
    });
    let projected =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect("unknown policy values remain opaque business data");
    assert_eq!(
        projected["reasoning_summary_policy"],
        payload["reasoning_summary_policy"]
    );
}

#[test]
fn gemini_wire_preserves_parallel_tool_calls_true_opaquely() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "think"}]}],
        "parallel_tool_calls": true
    });
    let projected =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect("parallel tool intent remains opaque business data");
    assert_eq!(
        projected["parallel_tool_calls"],
        payload["parallel_tool_calls"]
    );
}

#[test]
fn gemini_wire_preserves_parallel_tool_calls_false_opaquely() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "think"}]}],
        "parallel_tool_calls": false
    });
    let projected =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect("parallel tool intent remains opaque business data");
    assert_eq!(
        projected["parallel_tool_calls"],
        payload["parallel_tool_calls"]
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

// Regression for the live 4444 failure shape: Gemini can consume/project only
// fields with a declared exact mapping. Other Responses-origin Chat semantics
// must remain explicit unmapped errors rather than being silently stripped.
#[test]
fn gemini_wire_preserves_unmapped_responses_origin_fields_opaquely() {
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
    let projected =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect("unmapped Responses-origin Chat fields retain their original values");
    assert_eq!(
        projected["parallel_tool_calls"],
        payload["parallel_tool_calls"]
    );
    assert_eq!(
        projected["reasoning_summary_policy"],
        payload["reasoning_summary_policy"]
    );
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

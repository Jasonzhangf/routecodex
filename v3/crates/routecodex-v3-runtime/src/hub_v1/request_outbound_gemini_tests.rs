use super::*;

// Chat semantics reaching a Gemini target must either project into the Gemini
// wire shape or be consumed at the protocol boundary; they must never fail the
// whole request with UnmappedOutboundFields.
#[test]
fn gemini_wire_projects_reasoning_effort_and_tool_choice_then_drops_unmapped_fields() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "think"}]}],
        "reasoning_effort": "high",
        "tool_choice": "required",
        "parallel_tool_calls": true,
        "reasoning_summary_policy": "detailed",
        "routecodex_chat_extension": {"route": "search"}
    });
    let request =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect("Gemini outbound must project compatible fields and consume the rest");
    assert_eq!(
        request.pointer("/generationConfig/thinkingConfig/thinkingLevel"),
        Some(&json!("HIGH"))
    );
    assert_eq!(
        request.pointer("/toolConfig/functionCallingConfig/mode"),
        Some(&json!("ANY"))
    );
    for consumed in [
        "parallel_tool_calls",
        "reasoning_summary_policy",
        "routecodex_chat_extension",
        "reasoning_effort",
        "tool_choice",
    ] {
        assert!(
            request.get(consumed).is_none(),
            "consumed Chat field {consumed} must not reach the Gemini wire: {request}"
        );
    }
}

#[test]
fn gemini_wire_consumes_reasoning_effort_without_a_shared_level() {
    let payload = json!({
        "model": "gemini-test",
        "contents": [{"role": "user", "parts": [{"text": "think"}]}],
        "reasoning_effort": "xhigh"
    });
    let request =
        project_outbound_payload_for_target_protocol(&payload, V3OutboundTargetProtocol::Gemini)
            .expect("an effort without a Gemini equivalent must be consumed, not rejected");
    assert!(request.get("reasoning_effort").is_none(), "{request}");
    assert!(request.get("generationConfig").is_none(), "{request}");
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

// Regression for the live 4444 failure: a Responses-origin Chat payload routed
// to a chat:gemini provider carried exactly these five top-level Chat fields and
// was rejected as provider_request_payload_invalid before reaching the wire.
#[test]
fn gemini_wire_accepts_responses_origin_chat_payload_reported_live() {
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
            .expect("the reported live payload must project instead of failing at request_protocol");
    assert_eq!(
        request.pointer("/generationConfig/thinkingConfig/thinkingLevel"),
        Some(&json!("MEDIUM"))
    );
    assert_eq!(
        request.pointer("/toolConfig/functionCallingConfig/mode"),
        Some(&json!("AUTO"))
    );
    // `stream` is consumed as transport intent by the existing contract, so the
    // projected wire must not carry it as a body field.
    assert!(request.get("stream").is_none(), "{request}");
}

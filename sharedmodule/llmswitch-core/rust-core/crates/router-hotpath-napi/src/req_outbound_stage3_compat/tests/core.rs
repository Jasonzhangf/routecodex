use super::*;

#[test]
fn test_empty_input_error() {
    let result = run_req_outbound_stage3_compat_json("".to_string());
    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("Input JSON is empty"));
}

#[test]
fn test_invalid_json_error() {
    let result = run_req_outbound_stage3_compat_json("not valid json".to_string());
    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(err.contains("Failed to parse input JSON"));
}

#[test]
fn test_no_profile_passthrough() {
    let input = ReqOutboundCompatInput {
        payload: json!({"model": "gpt-4", "messages": [{"role": "user", "content": "hi"}]}),
        adapter_context: AdapterContext {
            compatibility_profile: None,
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_123".to_string()),
            entry_endpoint: Some("/v1/chat".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            estimated_input_tokens: None,
            model_id: None,
            client_model_id: None,
            original_model_id: None,
            provider_id: None,
            provider_key: None,
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };
    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert!(result.applied_profile.is_none());
    assert!(result.native_applied);
    assert_eq!(result.payload["model"], "gpt-4");
}

#[test]
fn test_profile_selection() {
    let input = ReqOutboundCompatInput {
        payload: json!({"model": "deepseek-chat"}),
        adapter_context: AdapterContext {
            compatibility_profile: Some("deepseek-compat".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_456".to_string()),
            entry_endpoint: Some("/v1/chat".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            estimated_input_tokens: None,
            model_id: None,
            client_model_id: None,
            original_model_id: None,
            provider_id: None,
            provider_key: None,
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };
    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert!(result.applied_profile.is_none());
    assert!(result.native_applied);
}

#[test]
fn test_empty_profile_treated_as_none() {
    let input = ReqOutboundCompatInput {
        payload: json!({"model": "test"}),
        adapter_context: AdapterContext {
            compatibility_profile: Some("   ".to_string()),
            provider_protocol: None,
            request_id: None,
            entry_endpoint: None,
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            estimated_input_tokens: None,
            model_id: None,
            client_model_id: None,
            original_model_id: None,
            provider_id: None,
            provider_key: None,
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: None,
    };
    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert!(result.applied_profile.is_none());
    assert!(result.native_applied);
}

#[test]
fn test_json_roundtrip() {
    let input_json = r#"{
        "payload": {"model": "gpt-4", "messages": [{"role": "user", "content": "hello"}]},
        "adapterContext": {
            "compatibilityProfile": "test-profile",
            "providerProtocol": "openai-chat",
            "requestId": "req_789",
            "entryEndpoint": "/v1/chat"
        }
    }"#;

    let result = run_req_outbound_stage3_compat_json(input_json.to_string()).unwrap();
    let output: CompatResult = serde_json::from_str(&result).unwrap();
    assert!(output.applied_profile.is_none());
    assert!(output.native_applied);
}

#[test]
fn test_explicit_profile_takes_priority() {
    let input = ReqOutboundCompatInput {
        payload: json!({"model": "deepseek-chat"}),
        adapter_context: AdapterContext {
            compatibility_profile: Some("context-profile".to_string()),
            provider_protocol: Some("openai-chat".to_string()),
            request_id: Some("req_999".to_string()),
            entry_endpoint: Some("/v1/chat".to_string()),
            route_id: None,
            rt: None,
            captured_chat_request: None,
            deepseek: None,
            claude_code: None,
            estimated_input_tokens: None,
            model_id: None,
            client_model_id: None,
            original_model_id: None,
            provider_id: None,
            provider_key: None,
            runtime_key: None,
            client_request_id: None,
            group_request_id: None,
            session_id: None,
            conversation_id: None,
        },
        explicit_profile: Some("explicit-profile".to_string()),
    };
    let result = run_req_outbound_stage3_compat(input).unwrap();
    assert!(result.applied_profile.is_none());
    assert!(result.native_applied);
}

#[test]
fn test_pinned_alias_lookup_and_unpin_json_api() {
    let session_id = "sid-pinned-alias-test";
    let signature = "x".repeat(64);

    let adapter_context = AdapterContext {
        compatibility_profile: None,
        provider_protocol: Some("gemini-chat".to_string()),
        request_id: None,
        entry_endpoint: None,
        route_id: None,
        rt: None,
        captured_chat_request: None,
        deepseek: None,
        claude_code: None,
        estimated_input_tokens: None,
        model_id: None,
        client_model_id: None,
        original_model_id: None,
        provider_id: Some("antigravity".to_string()),
        provider_key: Some("antigravity.demo.gemini-2.5-flash".to_string()),
        runtime_key: None,
        client_request_id: None,
        group_request_id: None,
        session_id: Some(session_id.to_string()),
        conversation_id: None,
    };

    let payload = json!({
        "candidates": [
            {
                "content": {
                    "parts": [
                        { "thoughtSignature": signature }
                    ]
                }
            }
        ]
    });
    let _ = super::super::gemini_cli::cache_antigravity_thought_signature_from_gemini_response(
        payload,
        &adapter_context,
    );

    let lookup_raw = lookup_antigravity_pinned_alias_for_session_id_json(
        json!({
            "sessionId": session_id,
            "hydrate": true
        })
        .to_string(),
    )
    .unwrap();
    let lookup: AntigravityPinnedAliasLookupOutput = serde_json::from_str(&lookup_raw).unwrap();
    assert_eq!(lookup.alias.as_deref(), Some("antigravity.demo"));

    let unpin_raw = unpin_antigravity_session_alias_for_session_id_json(
        json!({
            "sessionId": session_id
        })
        .to_string(),
    )
    .unwrap();
    let unpin: AntigravityPinnedAliasUnpinOutput = serde_json::from_str(&unpin_raw).unwrap();
    assert!(unpin.changed);

    let lookup_raw_after = lookup_antigravity_pinned_alias_for_session_id_json(
        json!({
            "sessionId": session_id,
            "hydrate": true
        })
        .to_string(),
    )
    .unwrap();
    let lookup_after: AntigravityPinnedAliasLookupOutput =
        serde_json::from_str(&lookup_raw_after).unwrap();
    assert!(lookup_after.alias.is_none());
}

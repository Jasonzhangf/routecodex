//! Public consumer for the Req07 runtime projection contract.
//!
//! This test enters through the real registered REQ02 SDK graph, builds the
//! Req07 provider payload plus its typed attempt context through the single
//! facade, publishes the attempt only after a buffered success, and then reads
//! the original tool declarations back through `ResponseProjectionView`.
//! It never rebuilds control facts from the payload.

use routecodex_v3_config::{
    V3ProviderRequestCleanupAuthoringConfig, V3ResponsesTransportKind, V3WebSearchExecutionMode,
};
use routecodex_v3_runtime::hub_v1::{
    build_v3_hub_req_chat_process_04_from_v3_hub_req_inbound_02,
    build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04,
    build_v3_hub_req_inbound_01_client_raw, build_v3_hub_req_inbound_02_from_canonical,
    build_v3_hub_req_outbound_07_from_v3_hub_req_target_06,
    build_v3_hub_req_target_06_from_v3_hub_req_execution_05,
    govern_v3_operation_runner_current_request_fields, V3HubEntryProtocol, V3HubExecutionMode,
    V3HubInvocationSource, V3HubProviderWireProtocol, V3HubReqOutbound07ProviderSemantic,
    V3HubTargetResolution, V3HubTransportIntent,
};
use routecodex_v3_runtime::operation_runner::{
    execute_v3_operation_runner_request_normalize_losslessly, RequestInvocationContext,
    RequestNormalizationEntry, RequestOriginKind, ResponseProjectionView, V3RequestContextHandle,
    V3TargetCandidate,
};
use routecodex_v3_runtime::{
    materialize_v3_provider_sse_as_canonical_response_with_context,
    project_v3_anthropic_message_as_responses_response_with_context,
    project_v3_openai_chat_response_as_responses_with_successful_attempt,
    V3AnthropicResponsesProjectionContext,
};
use serde_json::{json, Value};

fn selected_candidate(provider_protocol: V3HubProviderWireProtocol) -> V3TargetCandidate {
    let provider_type = match provider_protocol {
        V3HubProviderWireProtocol::OpenAiChat => "openai_chat",
        V3HubProviderWireProtocol::Responses => "responses",
        V3HubProviderWireProtocol::Anthropic => "anthropic",
        V3HubProviderWireProtocol::Gemini => "gemini",
    };
    V3TargetCandidate {
        provider_id: format!("req07-{provider_type}"),
        provider_type: provider_type.to_string(),
        auth_alias: "primary".to_string(),
        model_id: "req07-model".to_string(),
        wire_model: "req07-wire-model".to_string(),
        visible_model_ids: vec!["client-route-alias".to_string()],
        model_capabilities: vec!["text".to_string(), "tools".to_string()],
        web_search_execution_mode: V3WebSearchExecutionMode::None,
        max_context_tokens: None,
        max_tokens: None,
        context_token_estimate_scale_bps: 10_000,
        base_url: "https://provider.invalid/v1".to_string(),
        responses_process: None,
        responses_transport: V3ResponsesTransportKind::Http,
        websocket_v2_url: None,
        provider_request_cleanup: V3ProviderRequestCleanupAuthoringConfig::default(),
        request_timeout_ms: 300_000,
        priority: 0,
        weight: 1,
        sse_first_frame_timeout_ms: None,
        initial_concurrency_budget: 8,
        concurrency_acquire_timeout_ms: 60_000,
        compatibility_profile: None,
        headers: Default::default(),
        env_name: Some("REQ07_RUNTIME_PROJECTION_KEY".to_string()),
        token_file: None,
        secret_file: None,
        secret_key: None,
        api_key: None,
        required_capabilities: Vec::new(),
        pool_ids: vec!["default".to_string()],
        default_pool_member: true,
        path: vec![provider_type.to_string()],
    }
}

fn request_handle_and_canonical(request_id: &str, raw: Value) -> (V3RequestContextHandle, Value) {
    let handle = V3RequestContextHandle::new(request_id.to_string(), "responses".to_string());
    let invocation = RequestInvocationContext::new(
        handle.clone(),
        format!("{request_id}-invocation"),
        format!("{request_id}-entry"),
        RequestOriginKind::ClientEntry,
    );
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        &handle,
        &invocation,
        RequestNormalizationEntry::RawEntry(raw),
    )
    .expect("real REQ02 SDK normalize must publish the original pair");
    let canonical = govern_v3_operation_runner_current_request_fields(&canonical, &invocation, &[])
        .expect("the registered governance entry must publish current field associations");
    (handle, canonical)
}

fn build_req07(
    request_id: &str,
    raw: Value,
    attempt_id: &str,
    provider_protocol: V3HubProviderWireProtocol,
) -> (V3RequestContextHandle, V3HubReqOutbound07ProviderSemantic) {
    let (handle, canonical) = request_handle_and_canonical(request_id, raw.clone());
    let req02 = build_v3_hub_req_inbound_02_from_canonical(
        build_v3_hub_req_inbound_01_client_raw(
            raw,
            V3HubEntryProtocol::Responses,
            V3HubInvocationSource::Client,
            V3HubTransportIntent::Json,
        ),
        canonical.clone(),
    );
    let req04 = build_v3_hub_req_chat_process_04_from_v3_hub_req_inbound_02(req02);
    let req05 = build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04(
        req04,
        V3HubExecutionMode::Relay,
    );
    let req06 = build_v3_hub_req_target_06_from_v3_hub_req_execution_05(
        req05,
        V3HubTargetResolution::Routed,
        selected_candidate(provider_protocol),
    );
    let req07 = build_v3_hub_req_outbound_07_from_v3_hub_req_target_06(
        req06,
        &canonical,
        &handle,
        V3HubExecutionMode::Relay,
        attempt_id,
        provider_protocol,
    )
    .expect("Req07 must delegate the standard projection to the verified facade");
    (handle, req07)
}

fn declared_tools() -> Value {
    json!([
        {"type": "function", "name": "exec", "parameters": {"type": "object"}},
        {"type": "custom", "name": "apply_patch", "format": {"type": "text"}},
        {
            "type": "function",
            "name": "mcp.search__find",
            "parameters": {"type": "object"}
        }
    ])
}

fn raw_request() -> Value {
    json!({
        "model": "client-route-alias",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "use the declared tools"}]
        }],
        "tools": declared_tools(),
        "stream": false
    })
}

fn namespaced_raw_request() -> Value {
    json!({
        "model": "client-route-alias",
        "input": [{
            "type": "message",
            "role": "user",
            "content": [{"type": "input_text", "text": "use the declared tools"}]
        }],
        "tools": [
            {
                "type": "namespace",
                "name": "functions",
                "tools": [{
                    "type": "function",
                    "name": "exec",
                    "parameters": {
                        "type": "object",
                        "properties": {"cmd": {"type": "string"}}
                    }
                }]
            },
            {
                "type": "namespace",
                "name": "custom",
                "tools": [{
                    "type": "custom",
                    "name": "apply_patch",
                    "format": {"type": "text"}
                }]
            }
        ],
        "stream": false
    })
}

fn emitted_name_for_original(view: &ResponseProjectionView, original_name: &str) -> String {
    let inverse = view.request_inverse_context();
    let declaration = inverse
        .tool_declarations
        .iter()
        .find(|declaration| declaration.name.as_deref() == Some(original_name))
        .unwrap_or_else(|| panic!("original declaration `{original_name}` must exist"));
    view.attempt()
        .declarations
        .tool_mappings
        .iter()
        .find(|mapping| mapping.declaration_record_id == declaration.record_id)
        .unwrap_or_else(|| panic!("declaration `{original_name}` must have an emitted mapping"))
        .emitted_name
        .clone()
        .unwrap_or_else(|| panic!("declaration `{original_name}` must carry an emitted name"))
}

fn publish_and_view(
    handle: &V3RequestContextHandle,
    req07: &V3HubReqOutbound07ProviderSemantic,
) -> ResponseProjectionView {
    let attempt_context = req07.attempt_context().clone();
    handle
        .publish_successful_attempt(attempt_context.clone())
        .expect("buffered success must publish the attempt context");
    ResponseProjectionView::from_successful_attempt(handle, &attempt_context)
        .expect("the successful attempt must open the response projection view")
}

#[test]
fn req02_req07_runtime_projection_recovers_declared_tool_identity_from_successful_attempt() {
    let (handle, req07) = build_req07(
        "req07-projection-success",
        raw_request(),
        "req07-projection-attempt",
        V3HubProviderWireProtocol::Responses,
    );
    let attempt_context = req07.attempt_context().clone();

    // The attempt is not visible until the buffered transport success publishes it.
    assert!(
        ResponseProjectionView::from_successful_attempt(&handle, &attempt_context).is_err(),
        "an unpublished attempt must not be readable as a successful response view"
    );
    handle
        .publish_successful_attempt(attempt_context.clone())
        .expect("buffered success must publish the attempt context");

    let view = ResponseProjectionView::from_successful_attempt(&handle, &attempt_context)
        .expect("the successful attempt must open the response projection view");
    let inverse = view.request_inverse_context();
    let mappings = &view.attempt().declarations.tool_mappings;
    assert!(
        !mappings.is_empty(),
        "the attempt declaration map must record the emitted provider declarations"
    );

    let mut recovered_names = Vec::new();
    for mapping in mappings {
        let declaration = inverse
            .tool_declarations
            .iter()
            .find(|declaration| declaration.record_id == mapping.declaration_record_id)
            .unwrap_or_else(|| {
                panic!(
                    "emitted declaration `{}` must resolve to the request's original declaration",
                    mapping.declaration_record_id
                )
            });
        recovered_names.push(declaration.name.clone().unwrap_or_default());
    }
    assert!(
        recovered_names.iter().any(|name| name == "exec"),
        "function exec must recover its original name: {recovered_names:?}"
    );
    assert!(
        recovered_names.iter().any(|name| name == "apply_patch"),
        "custom apply_patch must recover its original name: {recovered_names:?}"
    );
    assert!(
        recovered_names
            .iter()
            .any(|name| name == "mcp.search__find"),
        "namespaced MCP tool must recover its original name: {recovered_names:?}"
    );
}

#[test]
fn req02_req07_runtime_projection_consumes_openai_chat_provider_json_inverse() {
    let exec_arguments = "{\"cmd\":\"printf '%s\\n' 'literal $() and `bytes`'\",\"cwd\":\"/tmp\"}";
    let patch = "*** Begin Patch\n*** Add File: /tmp/complete-path\n+literal $() and `bytes`\n*** End Patch\n";
    let (handle, req07) = build_req07(
        "req07-projection-chat-json",
        namespaced_raw_request(),
        "req07-projection-chat-json-attempt",
        V3HubProviderWireProtocol::OpenAiChat,
    );
    let view = publish_and_view(&handle, &req07);
    let exec_emitted = emitted_name_for_original(&view, "exec");
    let patch_emitted = emitted_name_for_original(&view, "apply_patch");
    assert_eq!(
        view.attempt().attempt_id,
        "req07-projection-chat-json-attempt",
        "the typed view must bind the actual published attempt identity"
    );
    assert_eq!(
        view.request_inverse_context().entry_protocol,
        "responses",
        "the inverse context must come from the real Responses request SDK"
    );
    assert_ne!(
        exec_emitted, "exec",
        "the provider-emitted function name must differ from the original so the inverse mapping is load-bearing"
    );
    assert_ne!(
        patch_emitted, "apply_patch",
        "the provider-emitted custom name must differ from the original so the inverse mapping is load-bearing"
    );

    let provider = json!({
        "id": "chatcmpl-req07",
        "object": "chat.completion",
        "created": 1,
        "model": "req07-wire-model",
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
                        "function": {"name": exec_emitted, "arguments": exec_arguments}
                    },
                    {
                        "id": "patch-call",
                        "type": "function",
                        "function": {
                            "name": patch_emitted,
                            "arguments": json!({"input": patch}).to_string()
                        }
                    }
                ]
            }
        }]
    });
    let restored =
        project_v3_openai_chat_response_as_responses_with_successful_attempt(&provider, &view)
            .expect("OpenAI Chat provider JSON inverse must consume the typed view");
    let output = restored["output"].as_array().expect("Responses output");

    let function_exec = output
        .iter()
        .find(|item| item["call_id"] == "exec-call")
        .expect("exec output");
    assert_eq!(function_exec["type"], "function_call");
    assert_eq!(function_exec["namespace"], "functions");
    assert_eq!(function_exec["name"], "exec");
    assert_eq!(function_exec["arguments"], exec_arguments);

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
fn req02_req07_runtime_projection_consumes_anthropic_provider_json_inverse() {
    let exec_arguments = "{\"cmd\":\"printf '%s\\n' 'literal $() and `bytes`'\",\"cwd\":\"/tmp\"}";
    let exec_input: Value = serde_json::from_str(exec_arguments).expect("exec input object");
    let patch = "*** Begin Patch\n*** Add File: /tmp/complete-path\n+literal $() and `bytes`\n*** End Patch\n";
    let (handle, req07) = build_req07(
        "req07-projection-anthropic-json",
        namespaced_raw_request(),
        "req07-projection-anthropic-json-attempt",
        V3HubProviderWireProtocol::Anthropic,
    );
    let view = publish_and_view(&handle, &req07);
    let exec_emitted = emitted_name_for_original(&view, "exec");
    let patch_emitted = emitted_name_for_original(&view, "apply_patch");
    let context = V3AnthropicResponsesProjectionContext::from_successful_attempt(&view)
        .expect("typed Anthropic response context");

    let provider = json!({
        "id": "msg-req07",
        "type": "message",
        "role": "assistant",
        "model": "req07-wire-model",
        "content": [
            {"type": "tool_use", "id": "exec-call", "name": exec_emitted, "input": exec_input},
            {
                "type": "tool_use",
                "id": "patch-call",
                "name": patch_emitted,
                "input": {"input": patch}
            }
        ],
        "stop_reason": "tool_use",
        "usage": {"input_tokens": 1, "output_tokens": 1}
    });
    let restored =
        project_v3_anthropic_message_as_responses_response_with_context(&provider, &context)
            .expect("Anthropic provider JSON inverse must consume the typed view");
    let output = restored["output"].as_array().expect("Responses output");

    let function_exec = output
        .iter()
        .find(|item| item["call_id"] == "exec-call")
        .expect("exec output");
    assert_eq!(function_exec["type"], "function_call");
    assert_eq!(function_exec["namespace"], "functions");
    assert_eq!(function_exec["name"], "exec");
    assert_eq!(function_exec["arguments"], exec_arguments);

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
fn req02_anthropic_response_context_accepts_unnamed_native_tool_declarations() {
    let declarations = namespaced_raw_request()["tools"].clone();
    let request = json!({
        "model": "client-route-alias", "tools": [{"type": "tool_search"}], "stream": false,
        "input": [
            {"type": "tool_search_call", "call_id": "search-call", "execution": "client", "arguments": {"query": "exec and patch"}},
            {"type": "tool_search_output", "call_id": "search-call", "execution": "client", "tools": declarations}
        ]
    });
    let (handle, req07) = build_req07(
        "req07-native-tool-identity",
        request,
        "req07-native-tool-identity-attempt",
        V3HubProviderWireProtocol::Anthropic,
    );
    let view = publish_and_view(&handle, &req07);
    assert!(
        view.request_inverse_context()
            .tool_declarations
            .iter()
            .any(|declaration| { declaration.kind == "tool_search" && declaration.name.is_none() }),
        "the native tool must retain its actual unnamed declaration"
    );
    let context = V3AnthropicResponsesProjectionContext::from_successful_attempt(&view)
        .expect("native declarations must not be mistaken for named callable declarations");
    let provider = json!({
        "id": "msg-native-tool", "type": "message", "role": "assistant",
        "model": "req07-wire-model", "stop_reason": "tool_use",
        "content": [{"type": "tool_use", "id": "exec-call", "name": emitted_name_for_original(&view, "exec"), "input": {"cmd": "printf complete-tail"}}],
        "usage": {"input_tokens": 1, "output_tokens": 1}
    });
    let restored =
        project_v3_anthropic_message_as_responses_response_with_context(&provider, &context)
            .unwrap();
    assert_eq!(restored["output"][0]["type"], "function_call");
    assert_eq!(restored["output"][0]["namespace"], "functions");
    assert_eq!(restored["output"][0]["name"], "exec");
    assert_eq!(
        restored["output"][0]["arguments"],
        "{\"cmd\":\"printf complete-tail\"}"
    );
}

#[tokio::test]
async fn req02_req07_runtime_projection_consumes_real_provider_sse_inverse() {
    let patch = "*** Begin Patch\n*** Add File: /tmp/complete-path\n+literal $() and `bytes`\n*** End Patch\n";
    let (handle, req07) = build_req07(
        "req07-projection-anthropic-sse",
        namespaced_raw_request(),
        "req07-projection-anthropic-sse-attempt",
        V3HubProviderWireProtocol::Anthropic,
    );
    let view = publish_and_view(&handle, &req07);
    let patch_emitted = emitted_name_for_original(&view, "apply_patch");
    let context = V3AnthropicResponsesProjectionContext::from_successful_attempt(&view)
        .expect("typed Anthropic response context");
    let partial_json = json!({"input": patch}).to_string();
    let provider = Box::pin(futures_util::stream::iter(vec![
        Ok(br#"event: message_start
data: {"type":"message_start","message":{"id":"msg_sse","type":"message","role":"assistant","model":"req07-wire-model","content":[],"usage":{"input_tokens":1}}}

"#
        .to_vec()),
        Ok(format!(
            "event: content_block_start\ndata: {}\n\n",
            json!({
                "type": "content_block_start",
                "index": 0,
                "content_block": {"type": "tool_use", "id": "patch-call", "name": patch_emitted}
            })
        )
        .into_bytes()),
        Ok(format!(
            "event: content_block_delta\ndata: {}\n\n",
            json!({
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "input_json_delta", "partial_json": partial_json}
            })
        )
        .into_bytes()),
        Ok(br#"event: content_block_stop
data: {"type":"content_block_stop","index":0}

"#
        .to_vec()),
        Ok(br#"event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":2}}

"#
        .to_vec()),
        Ok(br#"event: message_stop
data: {"type":"message_stop"}

"#
        .to_vec()),
    ]));

    let restored = materialize_v3_provider_sse_as_canonical_response_with_context(
        V3HubProviderWireProtocol::Anthropic,
        provider,
        &context,
    )
    .await
    .expect("real Anthropic provider SSE must consume the typed view");
    let output = restored["output"].as_array().expect("Responses output");
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
fn req02_req07_runtime_projection_keeps_request_scopes_isolated() {
    let (handle_a, req07_a) = build_req07(
        "req07-projection-a",
        raw_request(),
        "req07-projection-attempt-a",
        V3HubProviderWireProtocol::Responses,
    );
    let (handle_b, _req07_b) = build_req07(
        "req07-projection-b",
        raw_request(),
        "req07-projection-attempt-b",
        V3HubProviderWireProtocol::Responses,
    );

    handle_a
        .publish_successful_attempt(req07_a.attempt_context().clone())
        .expect("request A attempt must publish in its own scope");

    assert!(
        ResponseProjectionView::from_successful_attempt(&handle_b, req07_a.attempt_context())
            .is_err(),
        "request B must not read request A's successful attempt"
    );
}

#[test]
fn req02_custom_history_reaches_anthropic_with_complete_call_and_result() {
    let patch = format!(
        "*** Begin Patch\n{}\n*** End Patch\n",
        "自由文本$()\\`".repeat(10_000)
    );
    let result = "patch result\ncomplete bytes\\$()";
    let mut raw = namespaced_raw_request();
    raw["input"] = json!([
        {"role": "user", "content": "continue the original custom tool"},
        {"type": "custom_tool_call", "call_id": "custom-history-call",
         "namespace": "custom", "name": "apply_patch", "input": patch},
        {"type": "custom_tool_call_output", "call_id": "custom-history-call", "output": result}
    ]);
    let (_handle, req07) = build_req07(
        "req07-custom-history",
        raw,
        "req07-custom-history-attempt",
        V3HubProviderWireProtocol::Anthropic,
    );
    let wire = req07.standard_payload();
    let call = &wire["messages"][1]["content"][0];
    assert_eq!(call["type"], "tool_use");
    assert_eq!(call["id"], "custom-history-call");
    assert_eq!(call["name"], wire["tools"][1]["name"]);
    assert_eq!(call["input"], json!({"input": patch}));
    let output = &wire["messages"][2]["content"][0];
    assert_eq!(output["type"], "tool_result");
    assert_eq!(output["tool_use_id"], "custom-history-call");
    let content = &output["content"];
    let text = if let Some(text) = content.as_str() {
        text.to_owned()
    } else {
        content
            .as_array()
            .expect("representable tool output")
            .iter()
            .map(|part| part["text"].as_str().expect("text output"))
            .collect::<String>()
    };
    assert_eq!(text, result);
}

#[test]
fn req02_anthropic_standard_projection_preserves_nonhistory_semantics_through_compat() {
    let mut raw = raw_request();
    raw["reasoning"] = json!({"effort": "high"});
    raw["metadata"] = json!({"user_id": "opaque-user-1"});
    raw["text"] = json!({"format": {
        "type": "json_schema",
        "name": "answer",
        "strict": true,
        "schema": {
            "type": "object",
            "properties": {"answer": {"type": "string"}},
            "required": ["answer"],
            "additionalProperties": false
        }
    }});
    raw["store"] = json!(false);
    raw["max_output_tokens"] = json!(8192);
    let (handle, req07) = build_req07(
        "req07-anthropic-standard-meaning",
        raw,
        "req07-anthropic-standard-meaning-attempt",
        V3HubProviderWireProtocol::Anthropic,
    );
    let pair = handle.original_pair().unwrap();
    let standard = req07.standard_payload().clone();
    assert_eq!(standard["model"], "req07-wire-model");
    assert_eq!(standard["metadata"]["user_id"], "opaque-user-1");
    assert_eq!(standard["output_config"]["effort"], "high");
    assert_eq!(standard["output_config"]["format"]["type"], "json_schema");
    assert_eq!(
        standard["output_config"]["format"]["schema"]["required"],
        json!(["answer"])
    );
    assert_eq!(standard["max_tokens"], 8192);
    assert!(standard.get("store").is_none());
    assert!(standard.get("routecodex_chat_extension").is_none());
    let compat =
        routecodex_v3_runtime::hub_v1::build_provider_req_compat_06_from_v3_hub_req_outbound_07(
            req07,
        )
        .expect("provider-private passthrough must consume the standard projection");
    assert!(
        compat.drops.is_empty(),
        "representable semantics must not be discarded"
    );
    assert_eq!(handle.original_pair().unwrap(), pair);
}

#[test]
fn req02_standard_projection_carries_actual_drops_to_provider_compat() {
    let mut raw = raw_request();
    raw["seed"] = json!(123);
    let (handle, req07) = build_req07(
        "req07-anthropic-drop-carrier",
        raw,
        "req07-anthropic-drop-carrier-attempt",
        V3HubProviderWireProtocol::Anthropic,
    );
    let pair = handle.original_pair().unwrap();
    assert!(req07.standard_payload().get("seed").is_none());
    let compat =
        routecodex_v3_runtime::hub_v1::build_provider_req_compat_06_from_v3_hub_req_outbound_07(
            req07,
        )
        .expect("an unrepresentable seed must use the declared DROP contract");
    let drop = compat
        .drops
        .iter()
        .find(|drop| drop.json_path == "$.seed")
        .expect("the actual standard projection drop must survive Compat");
    assert_eq!(drop.target_protocol, "anthropic");
    assert_eq!(drop.canonical_value, 123);
    assert_eq!(handle.original_pair().unwrap(), pair);
}

#[test]
fn req02_anthropic_custom_input_that_looks_like_json_stays_a_raw_string() {
    let input = "{\"cmd\":\"literal $() and `bytes`\"}\r\n";
    let mut raw = namespaced_raw_request();
    raw["input"] = json!([
        {"type":"custom_tool_call", "call_id":"raw-json-call",
         "namespace":"custom", "name":"apply_patch", "input":input},
        {"type":"custom_tool_call_output", "call_id":"raw-json-call", "output":"complete"}
    ]);
    let (_, req07) = build_req07(
        "req07-custom-json-like-input",
        raw,
        "req07-custom-json-like-input-attempt",
        V3HubProviderWireProtocol::Anthropic,
    );
    let wire = req07.standard_payload();
    assert_eq!(
        wire["messages"][0]["content"][0]["input"],
        json!({"input":input})
    );
    assert_eq!(
        wire["messages"][0]["content"][0]["name"],
        wire["tools"][1]["name"]
    );
    assert_eq!(
        wire["messages"][1]["content"][0]["tool_use_id"],
        "raw-json-call"
    );
}

#[test]
fn req02_declared_client_metadata_maps_to_extension_and_remains_reversible() {
    let mut raw = raw_request();
    raw["client_metadata"] = json!({"user_id":"opaque-client-user", "session_id":"local-session"});
    let (handle, canonical) =
        request_handle_and_canonical("req07-client-metadata-source", raw.clone());
    assert_eq!(
        canonical["routecodex_chat_extension"]["responses_request"]["client_metadata"],
        raw["client_metadata"]
    );
    assert!(canonical.get("client_metadata").is_none());
    let pair = handle.original_pair().unwrap();
    let current = handle.current_field_associations().unwrap();
    assert_eq!(
        routecodex_v3_runtime::operation_runner::project_canonical_direct_request(
            &canonical,
            &pair.inverse_context,
            &current,
            &pair.explicit_history_pairing,
        )
        .unwrap()
        .payload,
        raw
    );
    let (_, req07) = build_req07(
        "req07-client-metadata-target",
        raw,
        "req07-client-metadata-target-attempt",
        V3HubProviderWireProtocol::Anthropic,
    );
    assert_eq!(
        req07.standard_payload()["metadata"]["user_id"],
        "opaque-client-user"
    );
    assert!(req07.standard_payload().get("client_metadata").is_none());
}

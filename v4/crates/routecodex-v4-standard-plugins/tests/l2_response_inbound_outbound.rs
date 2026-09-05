//! Relay response codec and terminal frame boundary tests.
//!
//! SSE transport has separate opaque-byte tests and is intentionally absent.

use routecodex_v4_cordis_bridge::{BridgeError, NodeExecutionInput, SharedTransportCarrier};
use routecodex_v4_node_container::{NodeContainer, NodeContainerError, PlanBindings};
use routecodex_v4_plugin_plan::{compile_node_plan, PlanError};
use routecodex_v4_standard_plugins::response_inbound::{
    decode_provider_sse_frame, ProviderSseEventDisposition,
};
use routecodex_v4_standard_plugins::protocol::provider_response::{
    normalize_provider_response, normalize_provider_sse_frame,
};
use routecodex_v4_standard_plugins::response_outbound::{
    encode_client_error_sse_frame, encode_client_sse_frame,
};
use routecodex_v4_standard_plugins::{
    compile_standard_plan, standard_authoring, standard_container_services,
    standard_node_allowed_reads, standard_node_allowed_writes, standard_resource_registry,
    StandardHandleRegistry,
};
use serde_json::{json, Value};
use std::sync::Arc;

fn execute(
    node_id: &str,
    position: u32,
    plugin_id: &str,
    data: Value,
    information: Value,
) -> Result<Value, NodeContainerError> {
    let plan = compile_standard_plan(
        node_id,
        if node_id == "V4HubRespInbound03Normalized"
            || node_id == "V4ProviderRespCompat02ProviderCompat"
        {
            "response_inbound"
        } else {
            "response_outbound"
        },
        "response",
        position,
        &[plugin_id],
    )
    .expect("response plan compiles");
    let hash = plan.plan_hash();
    let bindings = PlanBindings {
        graph_hash: hash.clone(),
        manifest_hash: hash.clone(),
        loaded_plan_hash: hash,
    };
    let mut container = NodeContainer::declare(node_id, plan, bindings).expect("binding passes");
    container.context_created().unwrap();
    container.plugins_mounted().unwrap();
    container.publish().unwrap();
    let output = container.execute(
        NodeExecutionInput {
            data,
            control: json!({}),
            information,
            transport: None,
        },
        &StandardHandleRegistry::new(),
    );
    container.drain().unwrap();
    container.dispose().unwrap();
    output.map(|value| value.data)
}

#[test]
fn protocol_decode_preserves_provider_business_response() {
    let response = json!({
        "id":"resp-1",
        "output":[
            {"type":"message","content":[{"type":"output_text","text":"hello"}]},
            {"type":"function_call","call_id":"call-1","name":"lookup","arguments":"{}"}
        ],
        "usage":{"input_tokens":10,"output_tokens":2},
        "metadata":{"client_visible":true}
    });
    let decoded = execute(
        "V4HubRespInbound03Normalized",
        3,
        "v4.std.response.protocol_decode",
        response.clone(),
        json!({}),
    )
    .unwrap();
    assert_eq!(decoded, response);
}

#[test]
fn provider_compat_consumes_raw_provider_body_inside_response_plan() {
    let response = json!({
        "id": "resp-raw-1",
        "output": [{"type": "message", "content": [{"type": "output_text", "text": "hello"}]}]
    });
    let decoded = execute(
        "V4ProviderRespCompat02ProviderCompat",
        2,
        "v4.std.response.provider_compat",
        response.clone(),
        json!({"provider_protocol": "openai-responses"}),
    )
    .expect("raw provider envelope must be decoded by response plugin");
    assert_eq!(decoded, response);
}

#[test]
fn provider_response_hooks_preserve_text_tools_and_usage() {
    let openai = normalize_provider_response(
        "openai",
        &json!({
            "id":"chat-1","model":"gpt-wire",
            "choices":[{"message":{"content":"hello","tool_calls":[{"id":"call-1","function":{"name":"lookup","arguments":"{}"}}]}}],
            "usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}
        }),
    )
    .expect("openai normalized by response hook");
    assert_eq!(openai["status"], "completed");
    assert_eq!(openai["output"][0]["content"][0]["text"], "hello");
    assert_eq!(openai["output"][1]["call_id"], "call-1");
    assert_eq!(openai["usage"]["input_tokens"], 3);

    let anthropic = normalize_provider_response(
        "anthropic",
        &json!({"id":"msg-1","model":"claude-wire","content":[{"type":"text","text":"hello"}],"usage":{"input_tokens":2,"output_tokens":5}}),
    )
    .expect("anthropic normalized by response hook");
    assert_eq!(anthropic["output"][0]["content"][0]["text"], "hello");
    assert_eq!(anthropic["usage"]["total_tokens"], 7);
}

#[test]
fn provider_response_hook_consumes_gateway_diagnostics_and_rejects_unknown_control() {
    let normalized = normalize_provider_response(
        "responses",
        &json!({
            "id": "resp-1",
            "status": "completed",
            "output": [],
            "extra_fields": {
                "provider": "openai",
                "provider_response_headers": {"x-request-id": "upstream"},
                "latency": 12,
                "resolved_model_used": "gpt-wire"
            }
        }),
    )
    .expect("known diagnostics are consumed by response hook");
    assert!(normalized.get("extra_fields").is_none());
    assert_eq!(normalized["id"], "resp-1");

    let error = normalize_provider_response(
        "responses",
        &json!({"id":"resp-1","status":"completed","output":[],"extra_fields":{"unregistered_control":true}}),
    )
    .expect_err("unknown control fields fail closed at response hook");
    assert!(error.contains("provider_response_control_envelope"));
}

#[test]
fn provider_response_hooks_reject_instruction_injection() {
    let error = normalize_provider_response(
        "responses",
        &json!({"id":"resp-1","status":"completed","instructions":"internal prompt","output":[]}),
    )
    .expect_err("provider instructions must not cross response boundary");
    assert!(error.contains("provider_response_instructions_injected"));

    let error = normalize_provider_sse_frame(
        "responses",
        br#"event: response.created
data: {"type":"response.created","response":{"id":"resp-1","instructions":"internal prompt"}}

"#,
    )
    .expect_err("SSE provider instructions must not cross response boundary");
    assert!(error.contains("provider_response_instructions_injected"));
}

#[test]
fn provider_response_sse_hooks_project_text_and_terminal_events() {
    let openai = normalize_provider_sse_frame(
        "openai",
        b"data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":null}]}\n\ndata: [DONE]\n\n",
    )
    .expect("openai SSE normalized by response hook");
    let text = String::from_utf8(openai).expect("utf8");
    assert!(text.contains("response.output_text.delta"));
    assert!(text.contains("response.completed"));

    let anthropic = normalize_provider_sse_frame(
        "anthropic",
        b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"hi\"}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    )
    .expect("anthropic SSE normalized by response hook");
    assert!(String::from_utf8(anthropic)
        .expect("utf8")
        .contains("response.completed"));

    let responses = normalize_provider_sse_frame(
        "responses",
        br#"event: response.created
data: {"type":"response.created","extra_fields":{"provider":"openai","latency":4},"response":{"id":"resp-1","extra_fields":{"chunk_index":0}}}

"#,
    )
    .expect("Responses SSE diagnostics are consumed by response hook");
    let text = String::from_utf8(responses).expect("utf8");
    assert!(!text.contains("extra_fields"));
    assert!(text.contains("response.created"));
}

#[test]
fn provider_sse_uses_arc_transport_carrier_and_typed_terminal_control() {
    let bytes: Arc<[u8]> = Arc::from(
        b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"arc-1\"}}\n\n"
            .as_slice(),
    );
    let carrier = SharedTransportCarrier::from_shared_bytes(Arc::clone(&bytes));
    let plan = compile_standard_plan(
        "V4ProviderRespInbound01Raw",
        "response_inbound",
        "relay_response",
        1,
        &["v4.std.response.sse_frame_boundary"],
    )
    .expect("provider SSE boundary plan compiles");
    let hash = plan.plan_hash();
    let bindings = PlanBindings {
        graph_hash: hash.clone(),
        manifest_hash: hash.clone(),
        loaded_plan_hash: hash,
    };
    let mut container = NodeContainer::declare(
        "V4ProviderRespInbound01Raw",
        plan,
        bindings,
    )
    .expect("provider SSE container binds");
    container.context_created().unwrap();
    container.plugins_mounted().unwrap();
    container.publish().unwrap();
    let output = container
        .execute(
            NodeExecutionInput {
                data: json!({}),
                control: json!({}),
                information: json!({"provider_protocol": "openai-responses"}),
                transport: Some(carrier.clone()),
            },
            &StandardHandleRegistry::new(),
        )
        .expect("typed transport carrier reaches provider SSE plugin");
    assert_eq!(output.data["type"], "response.completed");
    assert_eq!(output.control["stream_terminal"], true);
    assert!(output.data.get("_sse_frame").is_none());
    assert!(carrier.shares_storage_with(&SharedTransportCarrier::from_shared_bytes(bytes)));
    container.drain().unwrap();
    container.dispose().unwrap();
}

#[test]
fn direct_response_hook_consumes_raw_provider_body() {
    let response = json!({
        "id": "resp-direct-1",
        "object": "response",
        "output": [{"type": "message", "content": [{"type": "output_text", "text": "ok"}]}]
    });
    let decoded = execute(
        "V4DirectResp02RelayContainer",
        2,
        "v4.hook.direct.response",
        response.clone(),
        json!({"provider_protocol": "responses", "client_protocol": "responses"}),
    )
    .expect("direct response plugin must decode transport envelope");
    assert_eq!(decoded, response);
}

#[test]
fn protocol_decode_rejects_invalid_shape_and_control_leakage() {
    for response in [
        json!([]),
        json!({"output":{}}),
        json!({"output":[{}]}),
        json!({"output":[],"error_chain":{}}),
    ] {
        let error = execute(
            "V4HubRespInbound03Normalized",
            3,
            "v4.std.response.protocol_decode",
            response,
            json!({}),
        )
        .expect_err("invalid response must fail fast");
        assert!(matches!(
            error,
            NodeContainerError::Bridge(BridgeError::HandleError { .. })
        ));
    }
}

#[test]
fn relay_response_hook_projects_only_registered_protocol_pair() {
    let projected = execute(
        "V4HubRespOutbound05ClientSemantic",
        5,
        "v4.hook.relay.response",
        json!({
            "id":"resp-1",
            "model":"m",
            "output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]}]
        }),
        json!({"provider_protocol":"openai-responses","client_protocol":"openai-chat"}),
    )
    .unwrap();
    assert_eq!(
        projected["choices"][0]["message"]["content"],
        json!("hello")
    );

    assert!(execute(
        "V4HubRespOutbound05ClientSemantic",
        5,
        "v4.hook.relay.response",
        json!({"id":"resp-2"}),
        json!({"provider_protocol":"openai-responses","client_protocol":"gemini"}),
    )
    .is_err());
}

#[test]
fn relay_response_hook_projects_responses_function_arguments_delta() {
    let projected = execute(
        "V4HubRespOutbound05ClientSemantic",
        5,
        "v4.hook.relay.response",
        json!({
            "type": "response.function_call_arguments.delta",
            "output_index": 1,
            "delta": "{\"city\":"
        }),
        json!({"provider_protocol":"openai-responses","client_protocol":"openai-chat"}),
    )
    .expect("registered Responses event projects through the Relay response hook");

    assert_eq!(
        projected["choices"][0]["delta"]["tool_calls"][0]["index"],
        1
    );
    assert_eq!(
        projected["choices"][0]["delta"]["tool_calls"][0]["function"]["arguments"],
        "{\"city\":"
    );
}

#[test]
fn frame_build_preserves_client_semantic_payload() {
    let payload = json!({"id":"resp-1","object":"chat.completion","choices":[]});
    let frame = execute(
        "V4ServerRespOutbound06ClientFrame",
        6,
        "v4.std.response.frame_build",
        payload.clone(),
        json!({}),
    )
    .unwrap();
    assert_eq!(frame, payload);
}

#[test]
fn frame_build_rejects_control_plane_fields() {
    let error = execute(
        "V4ServerRespOutbound06ClientFrame",
        6,
        "v4.std.response.frame_build",
        json!({"id":"resp-1","route_facts":{}}),
        json!({}),
    )
    .expect_err("control leakage must fail fast");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(BridgeError::HandleError { .. })
    ));
}

#[test]
fn client_sse_codec_rejects_control_plane_fields_before_projection() {
    let error = encode_client_sse_frame(
        "responses",
        &json!({"type":"response.completed","route_facts":{}}),
        true,
    )
    .expect_err("client SSE projection must reject control leakage");
    assert!(error.contains("standard boundary rejects control field route_facts"));
}

#[test]
fn frame_builder_cannot_bind_to_chat_process_node() {
    let authoring = standard_authoring(&["v4.std.response.frame_build"]).unwrap();
    let error = compile_node_plan(
        "V4HubRespChatProcess04Governed",
        "response_chat_process",
        "response",
        4,
        &authoring,
        &standard_node_allowed_reads("V4HubRespChatProcess04Governed"),
        &standard_node_allowed_writes("V4HubRespChatProcess04Governed"),
        &standard_resource_registry(),
        &standard_container_services(),
    )
    .expect_err("non-adjacent node selector must fail");
    assert!(matches!(
        error,
        PlanError::NodeSelectorMismatch { .. }
            | PlanError::NodeSelectorPositionMismatch { .. }
            | PlanError::NodeRoleMismatch { .. }
    ));
}

#[test]
fn provider_sse_codec_classifies_continue_complete_and_failure() {
    let continuing = decode_provider_sse_frame(
        b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n",
    )
    .expect("delta frame decodes");
    assert_eq!(
        continuing.disposition,
        ProviderSseEventDisposition::Continue
    );

    let completed = decode_provider_sse_frame(
        b"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp-1\"}}\n\n",
    )
    .expect("completed frame decodes");
    assert_eq!(
        completed.disposition,
        ProviderSseEventDisposition::Completed
    );

    let failed = decode_provider_sse_frame(
        b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"error\":{\"message\":\"upstream failed\"}}}\n\n",
    )
    .expect("failed frame decodes");
    assert_eq!(
        failed.disposition,
        ProviderSseEventDisposition::Failed {
            message: "upstream failed".to_string(),
        }
    );
}

#[test]
fn provider_sse_codec_rejects_failed_event_without_error_truth() {
    let error = decode_provider_sse_frame(
        b"event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{}}\n\n",
    )
    .expect_err("failed event without error truth must fail fast");
    assert!(error.contains("missing error.message"));
}

#[test]
fn provider_sse_codec_projects_control_extra_fields_out_of_client_payload() {
    let decoded = decode_provider_sse_frame(
        b"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\",\"extra_fields\":{\"provider\":\"openai\"}}\n\n",
    )
    .expect("diagnostic extra_fields are consumed by provider normalization");
    assert_eq!(decoded.semantic["delta"], "hi");
    assert!(decoded.semantic.get("extra_fields").is_none());
}

#[test]
fn provider_sse_codec_rejects_malformed_function_arguments_delta() {
    for frame in [
        b"event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"delta\":\"{}\"}\n\n".as_slice(),
        b"event: response.function_call_arguments.delta\ndata: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":1,\"delta\":{}}\n\n".as_slice(),
    ] {
        let error = decode_provider_sse_frame(frame)
            .expect_err("malformed function arguments delta must fail at provider codec");
        assert!(error.contains("response.function_call_arguments.delta"));
    }
}

#[test]
fn client_error_frame_never_fabricates_success_closeout() {
    let responses = encode_client_error_sse_frame("responses", "upstream failed")
        .expect("Responses error frame");
    let responses = String::from_utf8(responses).expect("Responses error frame is UTF-8");
    assert!(responses.starts_with("event: error\ndata: "));
    assert!(!responses.contains("response.completed"));

    let chat = encode_client_error_sse_frame("chat", "upstream failed").expect("Chat error frame");
    let chat = String::from_utf8(chat).expect("Chat error frame is UTF-8");
    assert!(chat.starts_with("data: "));
    assert!(!chat.contains("[DONE]"));
}

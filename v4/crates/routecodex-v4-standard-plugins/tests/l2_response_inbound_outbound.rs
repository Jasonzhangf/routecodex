//! L2 response inbound/outbound plugin tests.
//!
//! Positive: provider raw/semantic decodes to parsed response, governed
//! response projects to client semantic, and client semantic builds a client
//! frame. Negative: non-object/malformed payloads, control/debug fields in
//! client payload, unauthorized resource writes and non-adjacent node
//! selectors fail fast without fallback.

use routecodex_v4_cordis_bridge::{BridgeError, NodeExecutionInput};
use routecodex_v4_node_container::{NodeContainer, NodeContainerError, PlanBindings};
use routecodex_v4_plugin_plan::{compile_node_plan, PlanError};
use routecodex_v4_standard_plugins::{
    compile_standard_plan, standard_authoring, standard_container_services,
    standard_node_allowed_reads, standard_node_allowed_writes, standard_resource_registry,
    StandardHandleRegistry,
};
use serde_json::{json, Value};

fn plan_bindings(plan: &routecodex_v4_plugin_plan::NodePluginPlan) -> PlanBindings {
    let hash = plan.plan_hash();
    PlanBindings {
        graph_hash: hash.clone(),
        manifest_hash: hash.clone(),
        loaded_plan_hash: hash,
    }
}

fn publish_container(mut container: NodeContainer) -> NodeContainer {
    container.context_created().unwrap();
    container.plugins_mounted().unwrap();
    container.publish().unwrap();
    container
}

fn provider_raw() -> Value {
    json!({
        "requestId": "req-response-1",
        "providerId": "keyless-mock",
        "statusCode": 200,
        "data": {
            "id": "resp-1",
            "output": [
                {"type": "text", "text": "hello"},
                {"type": "function_call", "id": "call-1", "name": "lookup", "arguments": "{}"}
            ],
            "usage": {"input_tokens": 10, "output_tokens": 2}
        }
    })
}

fn execute(
    node_id: &str,
    role_id: &str,
    chain: &str,
    position: u32,
    plugin_id: &str,
    data: Value,
) -> Result<Value, NodeContainerError> {
    let plan = compile_standard_plan(node_id, role_id, chain, position, &[plugin_id])
        .expect("response plan compiles");
    let hash = plan.plan_hash();
    let mut container = NodeContainer::declare(node_id, plan.clone(), plan_bindings(&plan))
        .expect("binding passes");
    container = publish_container(container);
    let registry = StandardHandleRegistry::new();
    let output = container.execute_with_plan_hash(
        &hash,
        NodeExecutionInput {
            data,
            control: json!({}),
        },
        &registry,
    )?;
    container.drain().unwrap();
    container.dispose().unwrap();
    Ok(output.data)
}

fn assert_no_control_fields(value: &Value) {
    let object = value.as_object().expect("response payload is object");
    for key in [
        "control",
        "metadata",
        "error_chain",
        "route_facts",
        "target_selection",
        "payload_cycle",
        "debug",
        "diagnostics",
        "snapshot",
    ] {
        assert!(
            !object.contains_key(key),
            "{key} leaked into client payload"
        );
    }
}

#[test]
fn positive_protocol_decode_builds_parsed_response() {
    let parsed = execute(
        "V4HubRespInbound02Parsed",
        "response_inbound",
        "response",
        2,
        "v4.std.response.protocol_decode",
        provider_raw(),
    );
    let parsed = parsed.expect("parsed response is object");
    let parsed = parsed.as_object().expect("parsed response is object");
    assert_eq!(parsed["requestId"], json!("req-response-1"));
    assert_eq!(parsed["providerId"], json!("keyless-mock"));
    assert_eq!(parsed["statusCode"], json!(200));
    assert_eq!(parsed["output"][0]["type"], json!("text"));
    assert_eq!(parsed["output"][0]["text"], json!("hello"));
    assert_eq!(parsed["output"][1]["type"], json!("function_call"));
    assert_eq!(parsed["output"][1]["id"], json!("call-1"));
    assert_no_control_fields(&Value::from(parsed.clone()));
}

#[test]
fn positive_client_semantic_projection_preserves_response_semantics() {
    let semantic = execute(
        "V4HubRespOutbound04ClientSemantic",
        "response_outbound",
        "response",
        4,
        "v4.std.response.client_semantic_projection",
        json!({
            "requestId": "req-response-1",
            "id": "resp-1",
            "output": [{"type": "text", "text": "hello"}],
            "usage": {"input_tokens": 10, "output_tokens": 2}
        }),
    )
    .expect("response plugin executes");
    let semantic = semantic.as_object().expect("client semantic is object");
    assert_eq!(semantic["requestId"], json!("req-response-1"));
    assert_eq!(semantic["id"], json!("resp-1"));
    assert_eq!(semantic["output"][0]["text"], json!("hello"));
    assert_eq!(semantic["usage"]["input_tokens"], json!(10));
    assert_no_control_fields(&Value::from(semantic.clone()));
}

#[test]
fn positive_frame_build_creates_single_client_frame() {
    let frame = execute(
        "V4ServerRespOutbound06ClientFrame",
        "response_outbound",
        "response",
        6,
        "v4.std.response.frame_build",
        json!({
            "requestId": "req-response-1",
            "id": "resp-1",
            "output": [{"type": "text", "text": "hello"}],
            "usage": {"input_tokens": 10, "output_tokens": 2}
        }),
    )
    .expect("response plugin executes");
    let frame = frame.as_object().expect("client frame is object");
    assert_eq!(frame["kind"], json!("client_frame"));
    assert_eq!(frame["requestId"], json!("req-response-1"));
    assert_eq!(frame["response"]["id"], json!("resp-1"));
    assert_eq!(frame["response"]["output"][0]["text"], json!("hello"));
    assert_no_control_fields(&Value::from(frame.clone()));
}

#[test]
fn positive_protocol_metadata_and_response_fields_are_preserved() {
    let parsed = execute(
        "V4HubRespInbound02Parsed",
        "response_inbound",
        "response",
        2,
        "v4.std.response.protocol_decode",
        json!({
            "requestId": "req-response-1",
            "providerId": "keyless-mock",
            "statusCode": 200,
            "data": {
                "id": "resp-1",
                "metadata": {"trace": "client-visible"},
                "usage": {"input_tokens": 10},
                "output": [{"type": "text", "text": "hello", "annotations": []}]
            }
        }),
    )
    .expect("protocol metadata remains business payload");
    assert_eq!(parsed["metadata"]["trace"], json!("client-visible"));
    assert_eq!(parsed["output"][0]["annotations"], json!([]));

    let semantic = execute(
        "V4HubRespOutbound04ClientSemantic",
        "response_outbound",
        "response",
        4,
        "v4.std.response.client_semantic_projection",
        parsed,
    )
    .expect("client projection succeeds");
    let frame = execute(
        "V4ServerRespOutbound06ClientFrame",
        "response_outbound",
        "response",
        6,
        "v4.std.response.frame_build",
        semantic,
    )
    .expect("frame build succeeds");
    assert_eq!(
        frame["response"]["metadata"]["trace"],
        json!("client-visible")
    );
    assert_eq!(frame["response"]["usage"]["input_tokens"], json!(10));
}

#[test]
fn negative_protocol_decode_rejects_non_object() {
    let error = execute(
        "V4HubRespInbound02Parsed",
        "response_inbound",
        "response",
        2,
        "v4.std.response.protocol_decode",
        json!([1, 2, 3]),
    )
    .expect_err("protocol_decode must reject non-object");
    assert!(
        matches!(error,
            NodeContainerError::Bridge(BridgeError::HandleError { ref plugin_id, .. })
                if plugin_id == "v4.std.response.protocol_decode"
        ),
        "expect Bridge HandleError for non-array input, got: {:?}",
        error
    );
}

#[test]
fn negative_protocol_decode_rejects_malformed_provider_raw() {
    let mut raw = provider_raw();
    raw["statusCode"] = json!(503);
    let plan = compile_standard_plan(
        "V4HubRespInbound02Parsed",
        "response_inbound",
        "response",
        2,
        &["v4.std.response.protocol_decode"],
    )
    .expect("plan compiles");
    let hash = plan.plan_hash();
    let mut container = NodeContainer::declare(
        "V4HubRespInbound02Parsed",
        plan.clone(),
        plan_bindings(&plan),
    )
    .expect("binding passes");
    container = publish_container(container);
    let registry = StandardHandleRegistry::new();
    let error = container
        .execute_with_plan_hash(
            &hash,
            NodeExecutionInput {
                data: raw,
                control: json!({}),
            },
            &registry,
        )
        .expect_err("non-success provider status must fail fast");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(BridgeError::HandleError { .. })
    ));
    container.drain().unwrap();
    container.dispose().unwrap();
}

#[test]
fn negative_client_projection_requires_request_identity() {
    let plan = compile_standard_plan(
        "V4HubRespOutbound04ClientSemantic",
        "response_outbound",
        "response",
        4,
        &["v4.std.response.client_semantic_projection"],
    )
    .expect("plan compiles");
    let hash = plan.plan_hash();
    let mut container = NodeContainer::declare(
        "V4HubRespOutbound04ClientSemantic",
        plan.clone(),
        plan_bindings(&plan),
    )
    .expect("binding passes");
    container = publish_container(container);
    let registry = StandardHandleRegistry::new();
    let error = container
        .execute_with_plan_hash(
            &hash,
            NodeExecutionInput {
                data: json!({
                    "id": "resp-1",
                    "output": []
                }),
                control: json!({}),
            },
            &registry,
        )
        .expect_err("missing request identity must fail fast");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(BridgeError::HandleError { .. })
    ));
    container.drain().unwrap();
    container.dispose().unwrap();
}

#[test]
fn negative_response_client_projection_cannot_write_normal_payload() {
    let mut authoring = standard_authoring(&["v4.std.response.client_semantic_projection"])
        .expect("authoring succeeds");
    authoring[0].descriptor.writes = vec!["v4.response.normal_payload".to_string()];
    let error = compile_node_plan(
        "V4HubRespOutbound04ClientSemantic",
        "response_outbound",
        "response",
        4,
        &authoring,
        &standard_node_allowed_reads("V4HubRespOutbound04ClientSemantic"),
        &standard_node_allowed_writes("V4HubRespOutbound04ClientSemantic"),
        &standard_resource_registry(),
        &standard_container_services(),
    )
    .expect_err("client semantic must not write backward into normal payload");
    assert!(matches!(error, PlanError::UnauthorizedWrite { .. }));
}

#[test]
fn negative_protocol_decode_rejects_invalid_output_shapes() {
    for data in [
        json!({}),
        json!({"output": {}}),
        json!({"output": ["text"]}),
        json!({"output": [{}]}),
        json!({"output": [{"type": 1}]}),
    ] {
        let mut raw = provider_raw();
        raw["data"] = data;
        let error = execute(
            "V4HubRespInbound02Parsed",
            "response_inbound",
            "response",
            2,
            "v4.std.response.protocol_decode",
            raw,
        )
        .expect_err("invalid output shape must fail fast");
        assert!(matches!(
            error,
            NodeContainerError::Bridge(BridgeError::HandleError { .. })
        ));
    }
}

#[test]
fn positive_response_outbound_nodes_preserve_request_identity() {
    let semantic = execute(
        "V4HubRespOutbound04ClientSemantic",
        "response_outbound",
        "response",
        4,
        "v4.std.response.client_semantic_projection",
        json!({
            "requestId": "req-response-1",
            "id": "resp-1",
            "output": [{"type": "text", "text": "hello"}]
        }),
    )
    .expect("client semantic projection succeeds");
    let boundary = execute(
        "V4ServerSseOut05FrameBoundary",
        "response_outbound",
        "response",
        5,
        "v4.std.response.sse_frame_boundary",
        semantic,
    )
    .expect("SSE boundary validates adjacent client wire payload");
    let frame = execute(
        "V4ServerRespOutbound06ClientFrame",
        "response_outbound",
        "response",
        6,
        "v4.std.response.frame_build",
        boundary,
    )
    .expect("terminal frame build succeeds");
    assert_eq!(frame["requestId"], json!("req-response-1"));
}

#[test]
fn negative_non_adjacent_response_node_selector_rejected() {
    let mut authoring =
        standard_authoring(&["v4.std.response.frame_build"]).expect("authoring succeeds");
    authoring[0].descriptor.node_selector.node_id = "V4HubRespChatProcess03Governed".to_string();
    let error = compile_node_plan(
        "V4HubRespChatProcess03Governed",
        "response_chat_process",
        "response",
        3,
        &authoring,
        &standard_node_allowed_reads("V4HubRespChatProcess03Governed"),
        &standard_node_allowed_writes("V4HubRespChatProcess03Governed"),
        &standard_resource_registry(),
        &standard_container_services(),
    )
    .expect_err("frame_build must not bind to chat process");
    assert!(matches!(
        error,
        PlanError::NodeSelectorMismatch { .. }
            | PlanError::NodeSelectorPositionMismatch { .. }
            | PlanError::NodeRoleMismatch { .. }
    ));
}

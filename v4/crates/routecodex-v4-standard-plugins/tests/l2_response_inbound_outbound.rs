use routecodex_v4_cordis_bridge::{execute_plan, BridgeError, NodeExecutionInput};
use routecodex_v4_plugin_plan::{compile_node_plan, PlanError};
use routecodex_v4_standard_plugins::{
    compile_standard_plan, standard_authoring, standard_container_services,
    standard_node_allowed_reads, standard_node_allowed_writes, standard_resource_registry,
    StandardHandleRegistry,
};
use serde_json::{json, Value};

fn execute(
    node_id: &str,
    role_id: &str,
    position: u32,
    plugin_id: &str,
    data: Value,
) -> Result<routecodex_v4_cordis_bridge::NodeExecutionOutput, BridgeError> {
    let plan = compile_standard_plan(node_id, role_id, "response", position, &[plugin_id])
        .expect("registered response plan compiles");
    execute_plan(
        &plan,
        NodeExecutionInput {
            data,
            control: json!({}),
        },
        &StandardHandleRegistry::new(),
    )
}

#[test]
fn positive_provider_raw_decodes_to_normal_payload() {
    let output = execute(
        "V4HubRespInbound02Parsed",
        "response_inbound",
        2,
        "v4.std.protocol.response_decode",
        json!(r#"{"id":"resp-1","output":[{"type":"output_text","text":"ok"}]}"#),
    )
    .expect("provider raw decodes");
    assert_eq!(output.data["parsed_response"]["id"], "resp-1");
    assert_eq!(output.control, json!({}));
}

#[test]
fn positive_outbound_nodes_project_and_build_adjacent_frame() {
    let semantic = execute(
        "V4HubRespOutbound04ClientSemantic",
        "response_outbound",
        4,
        "v4.std.protocol.response_client_semantic",
        json!({"parsed_response":{"id":"resp-1","output_text":"ok"}}),
    )
    .expect("client semantic projection succeeds");
    assert_eq!(semantic.data["client_semantic"]["output_text"], "ok");

    let boundary = execute(
        "V4ServerSseOut05FrameBoundary",
        "response_outbound",
        5,
        "v4.std.protocol.response_sse_frame",
        semantic.data.clone(),
    )
    .expect("SSE boundary validates adjacent semantic data");
    assert_eq!(boundary.data, semantic.data);

    let frame = execute(
        "V4ServerRespOutbound06ClientFrame",
        "response_outbound",
        6,
        "v4.std.protocol.response_frame_build",
        boundary.data,
    )
    .expect("terminal frame builds");
    assert_eq!(frame.data["frame"]["id"], "resp-1");
}

#[test]
fn positive_four_descriptors_bind_exact_response_nodes() {
    let plugins = routecodex_v4_standard_plugins::standard_plugins();
    let expected = [
        (
            "v4.std.protocol.response_decode",
            "V4HubRespInbound02Parsed",
            2,
        ),
        (
            "v4.std.protocol.response_client_semantic",
            "V4HubRespOutbound04ClientSemantic",
            4,
        ),
        (
            "v4.std.protocol.response_sse_frame",
            "V4ServerSseOut05FrameBoundary",
            5,
        ),
        (
            "v4.std.protocol.response_frame_build",
            "V4ServerRespOutbound06ClientFrame",
            6,
        ),
    ];
    for (plugin_id, node_id, position) in expected {
        let descriptor = &plugins
            .iter()
            .find(|plugin| plugin.plugin_id == plugin_id)
            .expect("response plugin registered")
            .descriptor;
        assert_eq!(descriptor.node_selector.node_id, node_id);
        assert_eq!(descriptor.node_selector.position, position);
    }
}

#[test]
fn negative_malformed_provider_raw_fails_fast() {
    let error = execute(
        "V4HubRespInbound02Parsed",
        "response_inbound",
        2,
        "v4.std.protocol.response_decode",
        json!("{not-json"),
    )
    .expect_err("malformed raw cannot become a successful response");
    assert!(matches!(error, BridgeError::HandleError { .. }));
}

#[test]
fn negative_non_object_provider_raw_fails_fast() {
    let error = execute(
        "V4HubRespInbound02Parsed",
        "response_inbound",
        2,
        "v4.std.protocol.response_decode",
        json!("[1,2,3]"),
    )
    .expect_err("provider response must decode to an object");
    assert!(matches!(error, BridgeError::HandleError { .. }));
}

#[test]
fn protocol_named_metadata_in_provider_raw_stays_business_data() {
    let output = execute(
        "V4HubRespInbound02Parsed",
        "response_inbound",
        2,
        "v4.std.protocol.response_decode",
        json!(r#"{"id":"resp-1","metadata_center":{"route":"internal"}}"#),
    )
    .expect("provider protocol data remains in the data plane");
    assert_eq!(
        output.data["parsed_response"]["metadata_center"]["route"],
        "internal"
    );
    assert_eq!(output.control, json!({}));
}

#[test]
fn protocol_named_error_data_does_not_write_control() {
    let output = execute(
        "V4HubRespOutbound04ClientSemantic",
        "response_outbound",
        4,
        "v4.std.protocol.response_client_semantic",
        json!({"parsed_response":{"id":"resp-1","error_chain":{"stage":3}}}),
    )
    .expect("client semantic projection preserves business data");
    assert_eq!(output.data["client_semantic"]["id"], "resp-1");
    assert_eq!(output.data["client_semantic"]["error_chain"]["stage"], 3);
    assert_eq!(output.control, json!({}));
}

#[test]
fn negative_non_adjacent_selector_is_rejected() {
    let mut authoring = standard_authoring(&["v4.std.protocol.response_decode"])
        .expect("registered descriptor loads");
    authoring[0].descriptor.node_selector.node_id = "V4ServerRespOutbound06ClientFrame".to_string();
    let error = compile_node_plan(
        "V4ServerRespOutbound06ClientFrame",
        "response_outbound",
        "response",
        6,
        &authoring,
        &standard_node_allowed_reads("V4ServerRespOutbound06ClientFrame"),
        &standard_node_allowed_writes("V4ServerRespOutbound06ClientFrame"),
        &standard_resource_registry(),
        &standard_container_services(),
    )
    .expect_err("response decode cannot skip to terminal frame");
    assert!(
        !error.to_string().is_empty(),
        "typed plan error must be explicit"
    );
}

#[test]
fn negative_undeclared_resource_write_is_rejected() {
    let mut authoring = standard_authoring(&["v4.std.protocol.response_decode"])
        .expect("registered descriptor loads");
    authoring[0].descriptor.writes = vec!["v4.response.client_wire_payload".to_string()];
    let error = compile_node_plan(
        "V4HubRespInbound02Parsed",
        "response_inbound",
        "response",
        2,
        &authoring,
        &standard_node_allowed_reads("V4HubRespInbound02Parsed"),
        &standard_node_allowed_writes("V4HubRespInbound02Parsed"),
        &standard_resource_registry(),
        &standard_container_services(),
    )
    .expect_err("inbound cannot write client wire payload");
    assert!(matches!(error, PlanError::UnauthorizedWrite { .. }));
}

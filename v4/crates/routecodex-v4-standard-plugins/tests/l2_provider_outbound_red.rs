//! Red tests for provider outbound wire and transport validators.
//!
//! The request lane must build a wire payload through the typed wire_build
//! plugin and validate it at the transport boundary. Control side channels
//! must not be reconstructed into wire bytes.

use routecodex_v4_cordis_bridge::NodeExecutionInput;
use routecodex_v4_node_container::{NodeContainer, NodeContainerError, PlanBindings};
use routecodex_v4_standard_plugins::{compile_standard_plan, StandardHandleRegistry};
use serde_json::{json, Value};

fn execute(
    node_id: &str,
    position: u32,
    plugin_id: &str,
    data: Value,
    information: Value,
    control: Value,
) -> Result<routecodex_v4_cordis_bridge::NodeExecutionOutput, NodeContainerError> {
    let role = if node_id == "V4ProviderReqOutbound09TransportRequest" {
        "request_outbound"
    } else {
        "request_outbound"
    };
    let plan = compile_standard_plan(node_id, role, "relay_request", position, &[plugin_id])
        .expect("provider outbound plan compiles");
    let hash = plan.plan_hash();
    let bindings = PlanBindings {
        graph_hash: hash.clone(),
        manifest_hash: hash.clone(),
        loaded_plan_hash: hash.clone(),
    };
    let mut container = NodeContainer::declare(node_id, plan, bindings).expect("binding passes");
    container.context_created().unwrap();
    container.plugins_mounted().unwrap();
    container.publish().unwrap();
    let output = container.execute_with_plan_hash(
        &hash,
        NodeExecutionInput {
            data,
            control,
            information,
        },
        &StandardHandleRegistry::new(),
    );
    container.drain().unwrap();
    container.dispose().unwrap();
    output
}

#[test]
fn positive_provider_wire_build_uses_typed_protocol_pair() {
    let output = execute(
        "V4ProviderReqOutbound08WirePayload",
        8,
        "v4.std.provider.wire_build",
        json!({"model":"m","messages":[{"role":"user","content":"hi"}]}),
        json!({"client_protocol":"openai-chat","provider_protocol":"openai-responses"}),
        json!({}),
    )
    .expect("wire build executes");
    assert_eq!(output.data["protocol"], json!("responses"));
    assert_eq!(output.data["input"][0]["content"], json!("hi"));
    assert!(output.data.get("messages").is_none());
    assert!(output.data.get("route_facts").is_none());
}

#[test]
fn negative_provider_wire_build_rejects_missing_protocol() {
    let error = execute(
        "V4ProviderReqOutbound08WirePayload",
        8,
        "v4.std.provider.wire_build",
        json!({"model":"m","messages":[]}),
        json!({}),
        json!({}),
    )
    .expect_err("wire build requires typed protocol information");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(routecodex_v4_cordis_bridge::BridgeError::HandleError { .. })
    ));
}

#[test]
fn positive_provider_transport_validate_preserves_wire_and_emits_fact() {
    let payload = json!({"model":"m","input":"hello"});
    let output = execute(
        "V4ProviderReqOutbound09TransportRequest",
        9,
        "v4.std.provider.transport_validate",
        payload.clone(),
        json!({}),
        json!({}),
    )
    .expect("transport validate executes");
    assert_eq!(output.data, payload);
    let kinds: Vec<&str> = output.diagnostics.iter().map(|f| f.kind.as_str()).collect();
    assert!(
        kinds.iter().any(|k| *k == "node.provider_transport_validated"),
        "transport validate must emit diagnostic: {kinds:?}"
    );
}

#[test]
fn negative_provider_transport_validate_rejects_non_object_wire() {
    let error = execute(
        "V4ProviderReqOutbound09TransportRequest",
        9,
        "v4.std.provider.transport_validate",
        json!(["bad"]),
        json!({}),
        json!({}),
    )
    .expect_err("transport validate requires object wire");
    assert!(matches!(
        error,
        NodeContainerError::Bridge(routecodex_v4_cordis_bridge::BridgeError::HandleError { .. })
    ));
}

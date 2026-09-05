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
) -> Result<Value, NodeContainerError> {
    let plan = compile_standard_plan(
        node_id,
        "response_outbound",
        "response",
        position,
        &[plugin_id],
    )
    .expect("response hook plan compiles");
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
fn direct_response_hook_requires_same_protocol_and_preserves_payload() {
    let payload = json!({"id":"resp-1","output":[]});
    let projected = execute(
        "V4DirectResp02RelayContainer",
        2,
        "v4.hook.direct.response",
        payload.clone(),
        json!({"client_protocol":"openai-responses","provider_protocol":"openai-responses"}),
    )
    .unwrap();
    assert_eq!(projected, payload);

    let error = execute(
        "V4DirectResp02RelayContainer",
        2,
        "v4.hook.direct.response",
        payload,
        json!({"client_protocol":"openai-chat","provider_protocol":"openai-responses"}),
    );
    assert!(error.is_err());
}

#[test]
fn relay_response_hook_uses_typed_protocol_pair() {
    let projected = execute(
        "V4HubRespOutbound05ClientSemantic",
        5,
        "v4.hook.relay.response",
        json!({
            "id":"resp-1",
            "model":"gpt-5.6-sol",
            "output":[{"type":"message","content":[{"type":"output_text","text":"hello"}]}]
        }),
        json!({"client_protocol":"openai-chat","provider_protocol":"openai-responses"}),
    )
    .unwrap();
    assert_eq!(projected["object"], json!("chat.completion"));
    assert_eq!(
        projected["choices"][0]["message"]["content"],
        json!("hello")
    );

    let error = execute(
        "V4HubRespOutbound05ClientSemantic",
        5,
        "v4.hook.relay.response",
        json!({"id":"resp-2"}),
        json!({"client_protocol":"anthropic-messages","provider_protocol":"openai-responses"}),
    );
    assert!(error.is_err());
}

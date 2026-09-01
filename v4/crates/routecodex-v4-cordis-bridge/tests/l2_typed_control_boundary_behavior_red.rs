use routecodex_v4_cordis_bridge::NodeExecutionInput;
use serde_json::json;

#[test]
fn bridge_rejects_payload_reconstructed_control_state() {
    let decoded = serde_json::from_value::<NodeExecutionInput>(json!({
        "data": {"input": []},
        "control": {"continuation_owner": "direct"},
        "information": {}
    }));
    assert!(
        decoded.is_err(),
        "bridge must reject untyped control reconstructed from JSON payload"
    );
}

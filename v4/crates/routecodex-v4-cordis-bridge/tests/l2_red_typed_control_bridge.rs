use routecodex_v4_cordis_bridge::NodeExecutionInput;
use serde_json::json;

#[test]
fn bridge_rejects_untyped_control_payload() {
    let input = serde_json::from_value::<NodeExecutionInput>(json!({
        "data": {},
        "control": {"continuation_scope": "scope-a"},
        "information": {}
    }));
    assert!(input.is_err(), "bridge must require a typed control handle");
}

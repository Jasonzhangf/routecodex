use super::{normalize_v3_provider_sse_json_data_with_event_name, V3HubProviderWireProtocol};
use serde_json::Value;

#[test]
fn responses_mcp_function_call_restores_namespace_for_client_dispatch() {
    let data = normalize_v3_provider_sse_json_data_with_event_name(
        V3HubProviderWireProtocol::Responses,
        r#"{"type":"response.completed","response":{"output":[{"type":"function_call","call_id":"mcp_1","name":"mcp__mcpx__workspace","arguments":"{}"}]}}"#,
        Some("response.completed"),
    )
    .expect("flattened MCP function call must normalize");
    let value: Value = serde_json::from_str(&data).expect("normalized JSON");
    let item = &value["response"]["output"][0];
    assert_eq!(item["namespace"], "mcp__mcpx");
    assert_eq!(item["name"], "workspace");
    assert_eq!(item["arguments"], "{}");
}

#[test]
fn responses_mcp_namespace_normalization_preserves_non_matching_calls() {
    let data = normalize_v3_provider_sse_json_data_with_event_name(
        V3HubProviderWireProtocol::Responses,
        r#"{"type":"response.completed","response":{"output":[{"type":"function_call","call_id":"plain_1","name":"mcp__workspace","arguments":"{}"},{"type":"function_call","call_id":"existing_1","name":"workspace","namespace":"mcp__other","arguments":"{}"}]}}"#,
        Some("response.completed"),
    )
    .expect("non-matching function calls must remain valid");
    let value: Value = serde_json::from_str(&data).expect("normalized JSON");
    assert_eq!(value["response"]["output"][0]["name"], "mcp__workspace");
    assert!(value["response"]["output"][0].get("namespace").is_none());
    assert_eq!(value["response"]["output"][1]["name"], "workspace");
    assert_eq!(value["response"]["output"][1]["namespace"], "mcp__other");
}

#[test]
fn responses_mcp_namespace_normalization_keeps_nested_path_reversible() {
    let data = normalize_v3_provider_sse_json_data_with_event_name(
        V3HubProviderWireProtocol::Responses,
        r#"{"type":"response.completed","response":{"output":[{"type":"function_call","call_id":"nested_1","name":"mcp__mcpx__workspace__read","arguments":"{}"}]}}"#,
        Some("response.completed"),
    )
    .expect("nested flattened MCP function call must normalize");
    let value: Value = serde_json::from_str(&data).expect("normalized JSON");
    let item = &value["response"]["output"][0];
    assert_eq!(item["namespace"], "mcp__mcpx__workspace");
    assert_eq!(item["name"], "read");
}

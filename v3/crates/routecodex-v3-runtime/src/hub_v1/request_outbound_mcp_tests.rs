#[test]
fn openai_chat_provider_normalizes_dotted_mcp_history_content_names() {
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&json!({
        "model":"glm-5.3","messages":[{"role":"tool","tool_call_id":"call_search","content":[{"type":"tool_result","name":"mcp__mcpx.workspace","content":"{}"}]}]
    })).expect("dotted MCP history names must be legal on provider wire");
    assert_eq!(
        request["messages"][0]["content"][0]["name"],
        "mcp__mcpx__workspace"
    );
}

#[test]
fn openai_chat_provider_preserves_tool_search_control_history_names() {
    let request = build_v3_openai_chat_standard_request_from_chat_canonical(&json!({
        "model":"glm-5.3","messages":[{"role":"assistant","tool_calls":[{"id":"search_1","type":"function","function":{"name":"mcp__mcpx.workspace","arguments":"{}"}}],"routecodex_chat_extension":{"responses_tool_call_type":"tool_search_call"}}]
    })).expect("tool_search history must remain projectable");
    assert_eq!(
        request["messages"][0]["tool_calls"][0]["function"]["name"],
        "mcp__mcpx.workspace"
    );
}

use routecodex_v4_servertool::{build_run_projection, ServertoolRunInput};

#[test]
fn web_search_cli_projection_matches_v3_surface() {
    let projection = build_run_projection(ServertoolRunInput {
        tool_name: "web_search".to_string(),
        input: serde_json::json!({"query": "RouteCodex"}),
        flow_id: Some("flow-1".to_string()),
        session_id: Some("session-1".to_string()),
        request_id: Some("request-1".to_string()),
    })
    .expect("projection");
    assert_eq!(projection.output.tool_name, "web_search");
    assert_eq!(projection.control.route_hint, "web_search");
    assert_eq!(projection.control.flow_id.as_deref(), Some("flow-1"));
    assert_eq!(projection.control.session_id.as_deref(), Some("session-1"));
    assert_eq!(projection.control.request_id.as_deref(), Some("request-1"));
    let output = serde_json::to_value(&projection.output).expect("output JSON");
    assert!(output.get("routeHint").is_none());
    assert!(output.get("flowId").is_none());
    assert!(output.get("sessionId").is_none());
    assert!(output.get("requestId").is_none());
}

#[test]
fn non_object_input_fails_fast() {
    let error = build_run_projection(ServertoolRunInput {
        tool_name: "web_search".to_string(),
        input: serde_json::json!(["invalid"]),
        flow_id: None,
        session_id: None,
        request_id: None,
    })
    .expect_err("must fail");
    assert!(error.to_string().contains("SERVERTOOL_CLI_INVALID_FIELD"));
}

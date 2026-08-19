use routecodex_v4_servertool::{build_run_output, ServertoolRunInput};

#[test]
fn web_search_cli_projection_matches_v3_surface() {
    let output = build_run_output(ServertoolRunInput {
        tool_name: "web_search".to_string(),
        input: serde_json::json!({"query": "RouteCodex"}),
        flow_id: None,
        session_id: None,
        request_id: None,
    })
    .expect("projection");
    assert_eq!(output.tool_name, "web_search");
    assert_eq!(output.route_hint, "web_search");
}

#[test]
fn non_object_input_fails_fast() {
    let error = build_run_output(ServertoolRunInput {
        tool_name: "web_search".to_string(),
        input: serde_json::json!(["invalid"]),
        flow_id: None,
        session_id: None,
        request_id: None,
    })
    .expect_err("must fail");
    assert!(error.to_string().contains("SERVERTOOL_CLI_INVALID_FIELD"));
}

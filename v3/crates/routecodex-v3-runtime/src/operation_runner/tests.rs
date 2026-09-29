use serde_json::json;
use std::collections::HashMap;

#[test]
fn capture_client_json_entry_preserves_exact_json_value() {
    let command = format!(
        "printf '%s' '{}{}'",
        "x".repeat(65_536),
        "NODE01_EXEC_COMMAND_FINAL_SENTINEL"
    );
    let command_arguments = json!({
        "cmd": command,
        "workdir": "/workspace/routecodex",
        "yield_time_ms": 1000
    })
    .to_string();
    let payload = json!({
        "model": "client-model",
        "input": {
            "role": "user",
            "content": "hello",
            "tool_call": {
                "call_id": "call_original",
                "name": "functions.exec",
                "arguments": {"opaque": [1, null, {"keep": true}]}
            }
        },
        "tool_calls": [
            {
                "namespace": "mcp__mcpx.workspace",
                "name": "read",
                "call_id": "call_mcp_read",
                "arguments": "{\"path\":\"docs/architecture/v3-function-map.yml\"}"
            },
            {
                "name": "exec_command",
                "call_id": "call_exec_command",
                "arguments": command_arguments
            }
        ],
        "tool_results": [
            {
                "namespace": "mcp__mcpx.workspace",
                "name": "read",
                "call_id": "call_mcp_read",
                "output": "function-map contents"
            },
            {
                "name": "exec_command",
                "call_id": "call_exec_command",
                "output": "command completed"
            }
        ],
        "stream": true,
        "tools": [
            {
                "type": "namespace",
                "name": "functions",
                "tools": [{
                    "type": "function",
                    "name": "functions.exec",
                    "parameters": {
                        "type": "object",
                        "properties": {"command": {"type": "string"}}
                    }
                }]
            },
            {
                "type": "namespace",
                "name": "mcp__mcpx.workspace",
                "tools": [{
                    "type": "function",
                    "name": "read",
                    "parameters": {
                        "type": "object",
                        "properties": {"path": {"type": "string"}}
                    }
                }]
            },
            {
                "type": "function",
                "name": "exec_command",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "cmd": {"type": "string"},
                        "workdir": {"type": "string"},
                        "yield_time_ms": {"type": "integer"}
                    }
                }
            }
        ],
        "extension": {"opaque_key": "preserve exactly"}
    });

    let output = crate::operation_runner::execute_v3_operation_runner_request_capture_client_json(
        payload.clone(),
    )
    .expect("capture client json RuntimeRequestGraphEntry must succeed");

    assert_eq!(output, payload);
    let captured_arguments = output["tool_calls"][1]["arguments"]
        .as_str()
        .expect("exec_command arguments remain the original JSON string");
    assert!(captured_arguments.len() > 65_536);
    assert!(captured_arguments.contains("NODE01_EXEC_COMMAND_FINAL_SENTINEL"));
}

#[test]
fn capture_client_json_passes_all_raw_json_shapes_to_the_protocol_owner() {
    for payload in [
        json!([]),
        json!([1, {"tool": "functions.exec"}]),
        json!(null),
        json!(false),
        json!("text"),
        json!(42),
    ] {
        let captured =
            crate::operation_runner::execute_v3_operation_runner_request_capture_client_json(
                payload.clone(),
            )
            .expect("capture accepts every valid JSON value");
        assert_eq!(captured, payload);
    }
}

#[test]
fn capture_client_json_entry_compile_fails_when_operator_not_registered() {
    let error = crate::operation_runner::compile_v3_operation_runner_request_capture_client_json(
        &pipeline_runtime::Registry::default(),
    )
    .expect_err("capture client json compile must fail when operator is absent");

    assert!(
        error
            .message
            .contains("missing operator `routecodex.v3.operation.capture_client_json@1`"),
        "unexpected compile error: {}",
        error.message
    );
}

#[test]
fn request_capture_graph_slice_preserves_the_canonical_node_contract() {
    let graph = super::request_capture_graph_slice().expect("canonical capture slice");

    assert_eq!(graph.id, "v3.operation_runner.request.capture_client_json");
    assert_eq!(graph.version, "1");
    assert_eq!(
        format!("{}@{}", graph.id, graph.version),
        "v3.operation_runner.request.capture_client_json@1"
    );
    assert_eq!(graph.inputs.len(), 1);
    assert_eq!(graph.inputs[0].id, "source-request");
    assert_eq!(graph.inputs[0].schema, pipeline_runtime::ValueType::Any);
    assert_eq!(graph.outputs, ["client-json"]);
    assert_eq!(graph.nodes.len(), 1);
    let node = &graph.nodes[0];
    assert_eq!(node.id, "capture_client_json");
    assert_eq!(node.operator, "routecodex.v3.operation.capture_client_json");
    assert_eq!(node.operator_version, "1");
    assert_eq!(node.inputs, ["source-request"]);
    assert_eq!(node.output.id, "client-json");
    assert_eq!(node.output.schema, pipeline_runtime::ValueType::Any);
    assert_eq!(node.input_selector.include.len(), 0);
    assert_eq!(node.input_selector.exclude.len(), 0);
    assert!(node.input_selector.predicate.is_none());
    assert_eq!(node.output_selector.include.len(), 0);
    assert_eq!(node.output_selector.exclude.len(), 0);
    assert!(node.output_selector.predicate.is_none());
    assert_eq!(node.iterator, pipeline_runtime::IteratorKind::Whole);
}

#[test]
fn runtime_identity_matches_the_derived_compiled_capture_slice() {
    let entry = super::RuntimeRequestGraphEntry::compile().expect("capture entry compiles");
    let identity = super::request_capture_identity(&entry.graph, "identity-test".to_string());
    let mut inputs = HashMap::new();
    inputs.insert(
        super::SOURCE_REQUEST_ARC.to_string(),
        json!({"opaque": ["client", 1, null]}),
    );

    let result = pipeline_runtime::Runtime::new(std::collections::BTreeSet::new())
        .run(
            &entry.graph,
            identity,
            inputs,
            &pipeline_runtime::Cancellation::default(),
        )
        .expect("capture slice Runtime::run succeeds");

    assert_eq!(
        result.identity.graph_id,
        "v3.operation_runner.request.capture_client_json"
    );
    assert_eq!(result.identity.graph_version, "1");
    assert_eq!(
        format!(
            "{}@{}",
            result.identity.graph_id, result.identity.graph_version
        ),
        "v3.operation_runner.request.capture_client_json@1"
    );
    assert_eq!(
        result.identity.graph_id,
        entry.graph.id(),
        "runtime identity graph_id must match the compiled capture-slice graph id"
    );
    assert_eq!(
        result.identity.graph_version,
        entry.graph.version(),
        "runtime identity graph_version must match the compiled capture-slice graph version"
    );
}

#[test]
fn runtime_identity_uses_deterministic_derived_slice_identity() {
    let entry = super::RuntimeRequestGraphEntry::compile().expect("capture entry compiles");
    let identity = super::request_capture_identity(&entry.graph, "identity-test".to_string());

    assert_eq!(
        identity.graph_id,
        super::derived_capture_slice_graph_id(super::CANONICAL_REQUEST_GRAPH_ID, super::CAPTURE_NODE_ID),
        "request graph slice identity must be canonical request graph ID plus selected capture node ID"
    );
    assert_eq!(identity.graph_id, entry.graph.id());
    assert_eq!(
        identity.graph_version,
        super::CANONICAL_REQUEST_GRAPH_VERSION,
        "request graph slice identity must inherit the canonical request graph version"
    );
}

#[test]
fn capture_slice_rejects_output_schema_that_mismatches_registry() {
    let mut graph: serde_json::Value = serde_json::from_str(super::REQUEST_GRAPH_JSON).unwrap();
    graph["nodes"][0]["output"]["schema"] = json!("String");

    let error = capture_slice_from_graph(graph).expect_err("schema mismatch must fail");
    assert!(error.message.contains("does not match"), "{error}");
}

#[test]
fn capture_slice_rejects_request_origin_kind_write_authority() {
    let mut graph: serde_json::Value = serde_json::from_str(super::REQUEST_GRAPH_JSON).unwrap();
    graph["nodes"][0]["resources"]["writes"] = json!(["v3.operation_runner.request_origin_kind"]);

    let error = capture_slice_from_graph(graph).expect_err("capture effects must be empty");
    assert!(error.message.contains("no resource writes"), "{error}");
}

fn capture_slice_from_graph(
    graph: serde_json::Value,
) -> Result<pipeline_runtime::Graph, super::OperationRunnerError> {
    let source = serde_json::to_string(&graph).expect("graph JSON serializes");
    super::request_capture_graph_slice_from_sources(&source, super::FIELD_PROFILES_YAML)
}

#[test]
fn capture_slice_compiles_from_request_graph_and_field_profile_registry_only() {
    let graph = super::request_capture_graph_slice_from_sources(
        super::REQUEST_GRAPH_JSON,
        super::FIELD_PROFILES_YAML,
    )
    .expect("capture slice uses only request graph plus field-profile schema registry");

    assert_eq!(graph.id, "v3.operation_runner.request.capture_client_json");
    assert_eq!(graph.version, "1");
}

#[test]
fn capture_slice_rejects_missing_input_schema_reference() {
    let mut graph: serde_json::Value = serde_json::from_str(super::REQUEST_GRAPH_JSON).unwrap();
    graph["inputs"][0]
        .as_object_mut()
        .unwrap()
        .remove("schema_ref");

    let error = capture_slice_from_graph(graph).expect_err("missing schema reference must fail");
    assert!(error.message.contains("schema_ref"), "{error}");
}

#[test]
fn capture_slice_rejects_unknown_output_schema_reference() {
    let mut graph: serde_json::Value = serde_json::from_str(super::REQUEST_GRAPH_JSON).unwrap();
    graph["nodes"][0]["output"]["schema_ref"] = json!("v3.operation_runner.arc.unknown");

    let error = capture_slice_from_graph(graph).expect_err("unknown schema reference must fail");
    assert!(error.message.contains("unknown project schema"), "{error}");
}

#[test]
fn capture_slice_rejects_unknown_input_schema_reference() {
    let mut graph: serde_json::Value = serde_json::from_str(super::REQUEST_GRAPH_JSON).unwrap();
    graph["inputs"][0]["schema_ref"] = json!("v3.operation_runner.arc.unknown");

    let error = capture_slice_from_graph(graph).expect_err("unknown schema reference must fail");
    assert!(error.message.contains("unknown project schema"), "{error}");
}

#[test]
fn capture_slice_rejects_missing_output_schema_reference() {
    let mut graph: serde_json::Value = serde_json::from_str(super::REQUEST_GRAPH_JSON).unwrap();
    graph["nodes"][0]["output"]
        .as_object_mut()
        .unwrap()
        .remove("schema_ref");

    let error = capture_slice_from_graph(graph).expect_err("missing schema reference must fail");
    assert!(error.message.contains("schema_ref"), "{error}");
}

#[test]
fn capture_slice_rejects_inline_schema_that_disagrees_with_registry() {
    let mut graph: serde_json::Value = serde_json::from_str(super::REQUEST_GRAPH_JSON).unwrap();
    graph["inputs"][0]["schema"] = json!("String");

    let error = capture_slice_from_graph(graph).expect_err("schema mismatch must fail");
    assert!(error.message.contains("does not match"), "{error}");
}

#[test]
fn capture_slice_rejects_declared_resource_effects() {
    let mut graph: serde_json::Value = serde_json::from_str(super::REQUEST_GRAPH_JSON).unwrap();
    graph["nodes"][0]["resources"]["writes"] =
        json!(["v3.operation_runner.metadata_center_control"]);

    let error = capture_slice_from_graph(graph).expect_err("capture effects must be empty");
    assert!(error.message.contains("no resource writes"), "{error}");
}

#[test]
fn capture_slice_rejects_declared_resource_reads() {
    let mut graph: serde_json::Value = serde_json::from_str(super::REQUEST_GRAPH_JSON).unwrap();
    graph["nodes"][0]["resources"]["reads"] =
        json!(["v3.operation_runner.metadata_center_control"]);

    let error = capture_slice_from_graph(graph).expect_err("capture effects must be empty");
    assert!(error.message.contains("no resource reads"), "{error}");
}

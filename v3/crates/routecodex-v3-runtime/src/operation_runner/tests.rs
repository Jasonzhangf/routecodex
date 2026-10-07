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
    let canonical: serde_json::Value = serde_json::from_str(super::REQUEST_GRAPH_JSON).unwrap();
    let canonical_graph_id = canonical["id"].as_str().expect("config graph id");
    let canonical_graph_version = canonical["version"].as_str().expect("config graph version");

    assert_eq!(
        identity.graph_id,
        super::graph_slice::derived_slice_graph_id(canonical_graph_id, super::CAPTURE_NODE_ID),
        "request graph slice identity must be config graph ID plus selected capture node ID"
    );
    assert_eq!(identity.graph_id, entry.graph.id());
    assert_eq!(
        identity.graph_version, canonical_graph_version,
        "request graph slice identity must inherit the configured request graph version"
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

fn config_graph() -> serde_json::Value {
    serde_json::from_str(super::REQUEST_GRAPH_JSON).expect("canonical request graph JSON")
}

fn normalize_node_index(graph: &serde_json::Value) -> usize {
    graph["nodes"]
        .as_array()
        .expect("nodes array")
        .iter()
        .position(|node| node["id"] == super::NORMALIZE_NODE_ID)
        .expect("normalize node present")
}

fn derived_normalize_slice(
    graph: serde_json::Value,
) -> Result<
    (pipeline_runtime::Graph, std::collections::BTreeSet<String>),
    super::OperationRunnerError,
> {
    let source = serde_json::to_string(&graph).expect("graph JSON serializes");
    super::request_normalize_graph_slice_from_sources(&source, super::FIELD_PROFILES_YAML)
}

#[test]
fn normalize_slice_reads_the_real_capture_output_arc_declaration() {
    // The normalize input ARC is the `client-json` ARC produced by the capture
    // node; the slice must copy that real declaration instead of hand-writing an
    // input schema. Breaking the capture output schema must therefore fail the
    // normalize slice derivation.
    let mut graph = config_graph();
    graph["nodes"][0]["output"]["schema"] = json!("Object");

    let error = derived_normalize_slice(graph)
        .expect_err("normalize slice must resolve the real captured client-json ARC");
    assert!(error.message.contains("does not match"), "{error}");
}

#[test]
fn canonical_graph_fields_flow_into_the_derived_slice() {
    let mut graph = config_graph();
    let index = normalize_node_index(&graph);
    graph["version"] = json!("2");
    graph["nodes"][index]["operator_version"] = json!("2");

    let (slice, _) = derived_normalize_slice(graph).expect("derived normalize slice");

    assert_eq!(slice.version, "2");
    assert_eq!(slice.nodes[0].operator_version, "2");
    assert_eq!(
        slice.nodes[0].operator,
        "routecodex.v3.operation.normalize_request_losslessly"
    );
    assert_eq!(slice.inputs.len(), 1);
    assert_eq!(slice.inputs[0].id, super::CLIENT_JSON_ARC);
    assert_eq!(slice.inputs[0].schema, pipeline_runtime::ValueType::Any);
}

#[test]
fn unregistered_operator_version_fails_sdk_compile() {
    let mut graph = config_graph();
    let index = normalize_node_index(&graph);
    graph["nodes"][index]["operator_version"] = json!("2");
    let (slice, grant) = derived_normalize_slice(graph).expect("derived normalize slice");

    let error = pipeline_runtime::compile(slice, &pipeline_runtime::Registry::default(), &grant)
        .expect_err("unregistered operator version must fail SDK compile");

    assert!(
        error
            .message
            .contains("routecodex.v3.operation.normalize_request_losslessly@2"),
        "{error}"
    );
}

#[test]
fn canonical_graph_identity_changes_execute_the_real_normalize_operator() {
    let payload = json!({
        "model": "client-model",
        "input": "preserve the complete request",
        "tools": [{
            "type": "function",
            "name": "exec_command",
            "parameters": {"type": "object", "properties": {"cmd": {"type": "string"}}}
        }],
        "opaque_extension": {"patch": "*** Begin Patch\n*** End Patch\n", "mcp": [null, 1]}
    });
    let baseline_handle = super::V3RequestContextHandle::new(
        "baseline-config-request".to_string(),
        "responses".to_string(),
    );
    let baseline_invocation = super::RequestInvocationContext::new(
        baseline_handle.clone(),
        "baseline-invocation".to_string(),
        "baseline-attempt".to_string(),
        super::RequestOriginKind::ClientEntry,
    );
    let expected = super::execute_v3_operation_runner_request_normalize_losslessly(
        &baseline_handle,
        &baseline_invocation,
        super::RequestNormalizationEntry::RawEntry(payload.clone()),
    )
    .expect("existing public normalize entry");

    let mut config = config_graph();
    config["id"] = json!("configured-request-graph");
    config["version"] = json!("2");
    let (graph, grant) = derived_normalize_slice(config).expect("derive configured graph");
    let handle = super::V3RequestContextHandle::new(
        "configured-request".to_string(),
        "responses".to_string(),
    );
    let invocation = super::RequestInvocationContext::new(
        handle.clone(),
        "configured-invocation".to_string(),
        "configured-attempt".to_string(),
        super::RequestOriginKind::ClientEntry,
    );
    let mut registry = pipeline_runtime::Registry::default();
    registry
        .register(super::NormalizeRequestLosslesslyOperator::new(invocation))
        .expect("register the real normalize operator");
    let compiled = pipeline_runtime::compile(graph, &registry, &grant)
        .expect("compile configured graph through the real SDK");
    let identity = pipeline_runtime::Identity {
        project_id: "routecodex-v3".to_string(),
        graph_id: compiled.id().to_string(),
        graph_version: compiled.version().to_string(),
        execution_id: "configured-invocation".to_string(),
        attempt_id: "configured-attempt".to_string(),
    };
    let result = pipeline_runtime::Runtime::new(grant)
        .run(
            &compiled,
            identity,
            HashMap::from([(super::CLIENT_JSON_ARC.to_string(), payload)]),
            &pipeline_runtime::Cancellation::default(),
        )
        .expect("execute the real operator with configured graph identity");
    assert_eq!(
        result.outputs[super::CANONICAL_REQUEST_ARC].payload,
        expected
    );
    assert_eq!(
        compiled.id(),
        "configured-request-graph.normalize_request_losslessly"
    );
    assert_eq!(compiled.version(), "2");
    assert_eq!(
        handle.original_pair().unwrap(),
        baseline_handle.original_pair().unwrap()
    );
}

struct UnknownEffectOperator;

impl pipeline_runtime::Operator for UnknownEffectOperator {
    fn name(&self) -> &'static str {
        "routecodex.v3.operation.normalize_request_losslessly"
    }

    fn version(&self) -> &'static str {
        "1"
    }

    fn input_type(&self) -> pipeline_runtime::ValueType {
        pipeline_runtime::ValueType::Any
    }

    fn output_type(&self) -> pipeline_runtime::ValueType {
        pipeline_runtime::ValueType::Object
    }

    fn effects(&self) -> &'static [&'static str] {
        &["v3.operation_runner.unknown_future_effect"]
    }

    fn execute(
        &self,
        _input: serde_json::Value,
        _context: &pipeline_runtime::OperatorContext,
    ) -> Result<serde_json::Value, String> {
        Ok(serde_json::Value::Null)
    }
}

#[test]
fn graph_declared_effect_is_not_self_authorized() {
    // A graph node may declare an effect, but authorization is a separate host
    // decision: the returned grant stays fixed and a novel operator effect is
    // rejected by SDK compile rather than self-authorized by the graph.
    let mut graph = config_graph();
    let index = normalize_node_index(&graph);
    graph["nodes"][index]["resources"]["reads"]
        .as_array_mut()
        .expect("reads array")
        .push(json!("v3.operation_runner.unknown_future_effect"));
    let (slice, grant) = derived_normalize_slice(graph).expect("derived normalize slice");
    assert!(
        !grant.contains("v3.operation_runner.unknown_future_effect"),
        "graph-declared effect must not be added to the host grant: {grant:?}"
    );

    let mut registry = pipeline_runtime::Registry::default();
    registry
        .register(UnknownEffectOperator)
        .expect("register test operator");
    let error = pipeline_runtime::compile(slice, &registry, &grant)
        .expect_err("novel operator effect must not be self-authorized by the graph");

    assert!(
        error
            .message
            .contains("requires undeclared capability `v3.operation_runner.unknown_future_effect`"),
        "{error}"
    );
}

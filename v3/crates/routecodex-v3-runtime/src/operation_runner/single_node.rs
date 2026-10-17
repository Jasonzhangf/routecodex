use super::{request_graph_identity, OperationRunnerError, REQUEST_GRAPH_JSON};
use pipeline_runtime::{Cancellation, Operator, Registry, Runtime};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

const RESPONSE_GRAPH_JSON: &str = include_str!(
    "../../../../../docs/architecture/dagpipe/v3.operation_runner.response.graph.json"
);

#[derive(Clone, Copy)]
pub(crate) enum V3OperationGraph {
    Request,
    Response,
}

impl V3OperationGraph {
    fn source(self) -> Result<&'static Value, OperationRunnerError> {
        static REQUEST: OnceLock<Result<Value, OperationRunnerError>> = OnceLock::new();
        static RESPONSE: OnceLock<Result<Value, OperationRunnerError>> = OnceLock::new();
        let (slot, source) = match self {
            Self::Request => (&REQUEST, REQUEST_GRAPH_JSON),
            Self::Response => (&RESPONSE, RESPONSE_GRAPH_JSON),
        };
        slot.get_or_init(|| {
            serde_json::from_str(source)
                .map_err(|error| OperationRunnerError::new(error.to_string()))
        })
        .as_ref()
        .map_err(Clone::clone)
    }
}

/// Runs a real operator against one canonical data edge. Per-call typed control
/// belongs to the operator instance; only the business value enters the graph.
pub(crate) fn run_v3_single_node_operator(
    source: V3OperationGraph,
    node_id: &str,
    input: Value,
    operator: impl Operator + 'static,
) -> Result<Value, OperationRunnerError> {
    let source = source.source()?;
    let nodes = source["nodes"]
        .as_array()
        .ok_or_else(|| OperationRunnerError::new("canonical graph has no nodes"))?;
    let node = nodes
        .iter()
        .find(|node| node["id"].as_str() == Some(node_id))
        .ok_or_else(|| OperationRunnerError::new(format!("unknown canonical node {node_id}")))?;
    let input_id = node["inputs"]
        .as_array()
        .filter(|inputs| inputs.len() == 1)
        .and_then(|inputs| inputs[0].as_str())
        .ok_or_else(|| OperationRunnerError::new("single-node entry requires one data input"))?;
    let input_contract = source["inputs"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(nodes.iter().map(|node| &node["output"]))
        .find(|arc| arc["id"].as_str() == Some(input_id))
        .ok_or_else(|| OperationRunnerError::new("canonical input ARC has no producer"))?;
    let output_id = node["output"]["id"]
        .as_str()
        .ok_or_else(|| OperationRunnerError::new("canonical node has no output ARC"))?;
    let graph_id = source["id"]
        .as_str()
        .ok_or_else(|| OperationRunnerError::new("canonical graph has no id"))?;
    let slice = json!({
        "id": format!("{graph_id}.{node_id}"),
        "version": source["version"],
        "inputs": [input_contract],
        "nodes": [node],
        "edges": [],
        "outputs": [output_id],
    });
    let graph = pipeline_runtime::parse_graph_json(&slice.to_string())?;
    let mut registry = Registry::default();
    registry.register(operator)?;
    let graph = pipeline_runtime::compile(graph, &registry, &BTreeSet::new())?;
    static SEQUENCE: AtomicU64 = AtomicU64::new(1);
    let identity = request_graph_identity(
        &graph,
        format!("operation-{}", SEQUENCE.fetch_add(1, Ordering::Relaxed)),
    );
    let result = Runtime::new(BTreeSet::new()).run(
        &graph,
        identity,
        HashMap::from([(input_id.to_string(), input)]),
        &Cancellation::default(),
    )?;
    result
        .outputs
        .get(output_id)
        .map(|output| output.payload.clone())
        .ok_or_else(|| OperationRunnerError::new("operator did not produce its declared output"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pipeline_runtime::{OperatorContext, ValueType};

    struct ResponseTransform;

    impl Operator for ResponseTransform {
        fn name(&self) -> &'static str {
            "routecodex.v3.operation.adjust_provider_private_response"
        }
        fn version(&self) -> &'static str {
            "1"
        }
        fn input_type(&self) -> ValueType {
            ValueType::Object
        }
        fn output_type(&self) -> ValueType {
            ValueType::Object
        }
        fn execute(&self, mut input: Value, _: &OperatorContext) -> Result<Value, String> {
            input["observed"] = json!(true);
            Ok(input)
        }
    }

    #[test]
    fn response_entry_executes_the_registered_transform_on_its_canonical_edge() {
        let output = run_v3_single_node_operator(
            V3OperationGraph::Response,
            "adjust_provider_private_response",
            json!({"opaque": [null, {"keep": true}]}),
            ResponseTransform,
        )
        .unwrap();
        assert_eq!(
            output,
            json!({"opaque": [null, {"keep": true}], "observed": true})
        );
        let error = run_v3_single_node_operator(
            V3OperationGraph::Request,
            "adjust_provider_private_request",
            json!({}),
            ResponseTransform,
        )
        .unwrap_err();
        assert!(error.message.contains("missing operator"), "{error}");
    }
}

use super::{
    OperationRunnerError, CANONICAL_REQUEST_GRAPH_ID, CANONICAL_REQUEST_GRAPH_VERSION,
    CLIENT_JSON_ARC, FIELD_PROFILES_YAML, GOVERNED_REQUEST_ARC, REQUEST_GRAPH_JSON,
    SOURCE_REQUEST_ARC, STANDARD_PROVIDER_REQUEST_ARC,
};
use pipeline_runtime::{
    ArcId, Cancellation, CompiledGraph, Graph, Identity, Operator, OperatorContext, Registry,
    Runtime, ValueType,
};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::{Arc, Mutex, OnceLock};

const RESPONSE_GRAPH_JSON: &str = include_str!(
    "../../../../../docs/architecture/dagpipe/v3.operation_runner.response.graph.json"
);
const ERROR_GRAPH_JSON: &str =
    include_str!("../../../../../docs/architecture/dagpipe/v3.operation_runner.error.graph.json");

const ERR02_NODE: &str = "error_err02_classified";
const ERR05_NODE: &str = "error_err05_execution_decision";
const ERROR02_TO_05_SLICE_ID: &str = "v3.operation_runner.error.error_err02_to_error_err05";
const OPERATOR_NAMES: &[&str] = &[
    "routecodex.v3.error.err01_source_raised",
    "routecodex.v3.error.err02_classified",
    "routecodex.v3.error.err03_target_local_action",
    "routecodex.v3.error.err04_target_exhaustion",
    "routecodex.v3.error.err05_execution_decision",
    "routecodex.v3.error.err06_client_projected",
    "routecodex.v3.operation.adjust_provider_private_request",
    "routecodex.v3.operation.adjust_provider_private_response",
    "routecodex.v3.operation.capture_client_json",
    "routecodex.v3.operation.construct_transport_request",
    "routecodex.v3.operation.encode_provider_wire",
    "routecodex.v3.operation.frame_committed_client_response",
    "routecodex.v3.operation.govern_chat_request",
    "routecodex.v3.operation.govern_chat_response",
    "routecodex.v3.operation.inverse_project_client_response",
    "routecodex.v3.operation.normalize_provider_response",
    "routecodex.v3.operation.normalize_request_losslessly",
    "routecodex.v3.operation.plan_execution",
    "routecodex.v3.operation.project_standard_provider_request",
    "routecodex.v3.operation.resolve_target",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum V3OperationGraph {
    Request,
    Response,
    Error,
}

impl V3OperationGraph {
    fn label(self) -> &'static str {
        match self {
            Self::Request => "request",
            Self::Response => "response",
            Self::Error => "error",
        }
    }
}

#[derive(Clone)]
struct PreparedNode {
    graph: CompiledGraph,
    input_arc: ArcId,
    output_arc: ArcId,
    slot: Arc<ScopedOperatorSlot>,
}

struct ScopedOperatorSlot {
    name: &'static str,
    version: &'static str,
    input_type: ValueType,
    output_type: ValueType,
    operators: Mutex<HashMap<String, Box<dyn Operator>>>,
}

impl ScopedOperatorSlot {
    fn new(
        name: &'static str,
        version: &'static str,
        input_type: ValueType,
        output_type: ValueType,
    ) -> Self {
        Self {
            name,
            version,
            input_type,
            output_type,
            operators: Mutex::new(HashMap::new()),
        }
    }

    fn bind(
        &self,
        execution_id: &str,
        operator: Box<dyn Operator>,
    ) -> Result<(), OperationRunnerError> {
        if operator.name() != self.name || operator.version() != self.version {
            return Err(OperationRunnerError::new(format!(
                "prepared node expects operator `{}@{}`, got `{}@{}`",
                self.name,
                self.version,
                operator.name(),
                operator.version()
            )));
        }
        self.operators
            .lock()
            .map_err(|_| OperationRunnerError::new("prepared operator binding is poisoned"))?
            .insert(execution_id.to_string(), operator);
        Ok(())
    }

    fn clear(&self, execution_id: &str) {
        if let Ok(mut operators) = self.operators.lock() {
            operators.remove(execution_id);
        }
    }
}

impl Operator for ScopedOperatorSlot {
    fn name(&self) -> &'static str {
        self.name
    }

    fn version(&self) -> &'static str {
        self.version
    }

    fn input_type(&self) -> ValueType {
        self.input_type.clone()
    }

    fn output_type(&self) -> ValueType {
        self.output_type.clone()
    }

    fn execute(&self, input: Value, context: &OperatorContext) -> Result<Value, String> {
        let operator = self
            .operators
            .lock()
            .map_err(|_| "prepared operator binding is poisoned".to_string())?
            .remove(&context.identity.execution_id)
            .ok_or_else(|| {
                format!(
                    "prepared operator `{}@{}` has no live binding for execution `{}`",
                    self.name, self.version, context.identity.execution_id
                )
            })?;
        operator.execute(input, context)
    }
}

struct PreparedOperationRunner {
    request: CompiledGraph,
    response: CompiledGraph,
    error: CompiledGraph,
    error_02_to_05: PreparedGraph,
    nodes: HashMap<(V3OperationGraph, String), PreparedNode>,
}

struct PreparedGraph {
    graph: CompiledGraph,
    input_arc: ArcId,
    output_arc: ArcId,
}

struct BoundSlots {
    execution_id: String,
    slots: Vec<Arc<ScopedOperatorSlot>>,
}

impl Drop for BoundSlots {
    fn drop(&mut self) {
        for slot in &self.slots {
            slot.clear(&self.execution_id);
        }
    }
}

impl PreparedOperationRunner {
    fn compile() -> Result<Self, OperationRunnerError> {
        let request_graph = pipeline_runtime::parse_graph_json(REQUEST_GRAPH_JSON)?;
        let response_graph = pipeline_runtime::parse_graph_json(RESPONSE_GRAPH_JSON)?;
        let error_graph = pipeline_runtime::parse_graph_json(ERROR_GRAPH_JSON)?;

        let mut slots = BTreeMap::<(String, String), Arc<ScopedOperatorSlot>>::new();
        for graph in [&request_graph, &response_graph, &error_graph] {
            let arc_schemas = graph_arc_schemas(graph)?;
            for node in &graph.nodes {
                if node.inputs.len() != 1 {
                    return Err(OperationRunnerError::new(format!(
                        "operation node `{}` must expose one graph input",
                        node.id
                    )));
                }
                let input_type = arc_schemas
                    .get(&node.inputs[0])
                    .ok_or_else(|| {
                        OperationRunnerError::new(format!(
                            "operation node `{}` has no schema for input ARC `{}`",
                            node.id, node.inputs[0]
                        ))
                    })?
                    .clone();
                let key = (node.operator.clone(), node.operator_version.clone());
                let slot = match slots.get(&key) {
                    Some(slot) => Arc::clone(slot),
                    None => Arc::new(ScopedOperatorSlot::new(
                        operator_name(&node.operator)?,
                        operator_version(&node.operator_version)?,
                        input_type.clone(),
                        node.output.schema.clone(),
                    )),
                };
                if slot.input_type != input_type || slot.output_type != node.output.schema {
                    return Err(OperationRunnerError::new(format!(
                        "operator `{}@{}` has incompatible graph ARC schemas",
                        node.operator, node.operator_version
                    )));
                }
                slots.entry(key).or_insert(slot);
            }
        }

        let mut registry = Registry::default();
        for slot in slots.values() {
            registry.register(ArcOperator(Arc::clone(slot)))?;
        }

        let request =
            pipeline_runtime::compile(request_graph.clone(), &registry, &BTreeSet::new())?;
        let response =
            pipeline_runtime::compile(response_graph.clone(), &registry, &BTreeSet::new())?;
        let error = pipeline_runtime::compile(error_graph.clone(), &registry, &BTreeSet::new())?;

        let mut nodes = HashMap::new();
        for (kind, graph) in [
            (V3OperationGraph::Request, &request_graph),
            (V3OperationGraph::Response, &response_graph),
            (V3OperationGraph::Error, &error_graph),
        ] {
            for node in &graph.nodes {
                let prepared = prepare_node_slice(graph, node)?;
                let slot = slots
                    .get(&(node.operator.clone(), node.operator_version.clone()))
                    .cloned()
                    .ok_or_else(|| {
                        OperationRunnerError::new(format!(
                            "precompiled graph omitted operator `{}@{}`",
                            node.operator, node.operator_version
                        ))
                    })?;
                let compiled = pipeline_runtime::compile(prepared, &registry, &BTreeSet::new())?;
                let input_arc = node.inputs[0].clone();
                let output_arc = node.output.id.clone();
                nodes.insert(
                    (kind, node.id.clone()),
                    PreparedNode {
                        graph: compiled,
                        input_arc,
                        output_arc,
                        slot,
                    },
                );
            }
        }

        let error_02_to_05 = prepare_error_decision_slice(&error_graph, &registry)?;
        Ok(Self {
            request,
            response,
            error,
            error_02_to_05,
            nodes,
        })
    }

    fn run_node(
        &self,
        kind: V3OperationGraph,
        node_id: &str,
        input: Value,
        operator: Box<dyn Operator>,
    ) -> Result<Value, OperationRunnerError> {
        let node = self
            .nodes
            .get(&(kind, node_id.to_string()))
            .ok_or_else(|| {
                OperationRunnerError::new(format!("unknown canonical node {node_id}"))
            })?;
        let execution_id = next_execution_id(kind, node_id);
        node.slot.bind(&execution_id, operator)?;
        let identity = graph_identity(&node.graph, execution_id.clone());
        let result = Runtime::new(BTreeSet::new()).run(
            &node.graph,
            identity,
            HashMap::from([(node.input_arc.clone(), input)]),
            &Cancellation::default(),
        );
        node.slot.clear(&execution_id);
        result
            .map_err(OperationRunnerError::from)?
            .outputs
            .get(&node.output_arc)
            .map(|output| output.payload.clone())
            .ok_or_else(|| {
                OperationRunnerError::new("operator did not produce its declared output")
            })
    }

    fn run_error_02_to_05(
        &self,
        input: Value,
        operators: Vec<Box<dyn Operator>>,
    ) -> Result<Value, OperationRunnerError> {
        let execution_id = next_execution_id(V3OperationGraph::Error, "error02_to_05");
        let mut bound_slots = BoundSlots {
            execution_id: execution_id.clone(),
            slots: Vec::new(),
        };
        for operator in operators {
            let node_id = operator_node_id(operator.name()).ok_or_else(|| {
                OperationRunnerError::new(format!(
                    "operator `{}` is not a canonical Error02-05 node",
                    operator.name()
                ))
            })?;
            let node = self
                .nodes
                .get(&(V3OperationGraph::Error, node_id.to_string()))
                .ok_or_else(|| {
                    OperationRunnerError::new(format!("unknown canonical node {node_id}"))
                })?;
            node.slot.bind(&execution_id, operator)?;
            bound_slots.slots.push(Arc::clone(&node.slot));
        }
        let identity = graph_identity(&self.error_02_to_05.graph, execution_id.clone());
        let result = Runtime::new(BTreeSet::new()).run(
            &self.error_02_to_05.graph,
            identity,
            HashMap::from([(self.error_02_to_05.input_arc.clone(), input)]),
            &Cancellation::default(),
        );
        result
            .map_err(OperationRunnerError::from)?
            .outputs
            .get(&self.error_02_to_05.output_arc)
            .map(|output| output.payload.clone())
            .ok_or_else(|| OperationRunnerError::new("Error02-05 slice omitted its output"))
    }
}

struct ArcOperator(Arc<ScopedOperatorSlot>);

impl Operator for ArcOperator {
    fn name(&self) -> &'static str {
        self.0.name()
    }

    fn version(&self) -> &'static str {
        self.0.version()
    }

    fn input_type(&self) -> ValueType {
        self.0.input_type()
    }

    fn output_type(&self) -> ValueType {
        self.0.output_type()
    }

    fn execute(&self, input: Value, context: &OperatorContext) -> Result<Value, String> {
        self.0.execute(input, context)
    }
}

fn graph_arc_schemas(graph: &Graph) -> Result<BTreeMap<ArcId, ValueType>, OperationRunnerError> {
    let mut schemas = BTreeMap::new();
    for input in &graph.inputs {
        schemas.insert(input.id.clone(), input.schema.clone());
    }
    for node in &graph.nodes {
        schemas.insert(node.output.id.clone(), node.output.schema.clone());
    }
    Ok(schemas)
}

fn prepare_node_slice(
    graph: &Graph,
    node: &pipeline_runtime::Node,
) -> Result<Graph, OperationRunnerError> {
    if node.inputs.len() != 1 {
        return Err(OperationRunnerError::new(format!(
            "node `{}` has multiple input ARCs",
            node.id
        )));
    }
    let input_arc = &node.inputs[0];
    let input = graph
        .inputs
        .iter()
        .chain(graph.nodes.iter().map(|node| &node.output))
        .find(|arc| &arc.id == input_arc)
        .cloned()
        .ok_or_else(|| {
            OperationRunnerError::new(format!(
                "node `{}` input ARC `{input_arc}` has no producer",
                node.id
            ))
        })?;
    let graph_id = format!("{}.{}", graph.id, node.id);
    Ok(Graph {
        id: graph_id,
        version: graph.version.clone(),
        inputs: vec![input],
        nodes: vec![node.clone()],
        edges: Vec::new(),
        outputs: vec![node.output.id.clone()],
    })
}

fn prepare_error_decision_slice(
    graph: &Graph,
    registry: &Registry,
) -> Result<PreparedGraph, OperationRunnerError> {
    let start = graph
        .nodes
        .iter()
        .position(|node| node.id == ERR02_NODE)
        .ok_or_else(|| OperationRunnerError::new("error graph omitted Error02"))?;
    let end = graph
        .nodes
        .iter()
        .position(|node| node.id == ERR05_NODE)
        .ok_or_else(|| OperationRunnerError::new("error graph omitted Error05"))?;
    if start > end {
        return Err(OperationRunnerError::new(
            "error graph does not order Error02 before Error05",
        ));
    }
    let selected: BTreeSet<String> = graph.nodes[start..=end]
        .iter()
        .map(|node| node.id.clone())
        .collect();
    let first = &graph.nodes[start];
    let input = graph
        .inputs
        .iter()
        .chain(graph.nodes.iter().map(|node| &node.output))
        .find(|arc| first.inputs.iter().any(|id| id == &arc.id))
        .cloned()
        .ok_or_else(|| OperationRunnerError::new("Error02 input ARC has no producer"))?;
    let slice = Graph {
        id: ERROR02_TO_05_SLICE_ID.to_string(),
        version: graph.version.clone(),
        inputs: vec![input.clone()],
        nodes: graph.nodes[start..=end].to_vec(),
        edges: graph
            .edges
            .iter()
            .filter(|edge| selected.contains(&edge.from) && selected.contains(&edge.to))
            .cloned()
            .collect(),
        outputs: vec![graph.nodes[end].output.id.clone()],
    };
    Ok(PreparedGraph {
        graph: pipeline_runtime::compile(slice, registry, &BTreeSet::new())?,
        input_arc: input.id,
        output_arc: graph.nodes[end].output.id.clone(),
    })
}

fn operator_name(name: &str) -> Result<&'static str, OperationRunnerError> {
    OPERATOR_NAMES
        .iter()
        .copied()
        .find(|candidate| *candidate == name)
        .ok_or_else(|| {
            OperationRunnerError::new(format!("unsupported canonical operator `{name}`"))
        })
}

fn operator_version(version: &str) -> Result<&'static str, OperationRunnerError> {
    match version {
        "1" => Ok("1"),
        _ => Err(OperationRunnerError::new(format!(
            "unsupported canonical operator version `{version}`"
        ))),
    }
}

fn graph_identity(graph: &CompiledGraph, execution_id: String) -> Identity {
    Identity {
        project_id: "routecodex-v3".to_string(),
        graph_id: graph.id().to_string(),
        graph_version: graph.version().to_string(),
        execution_id,
        attempt_id: "operation-slice".to_string(),
    }
}

fn next_execution_id(kind: V3OperationGraph, node_id: &str) -> String {
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    format!(
        "{}-{node_id}-{}",
        kind.label(),
        SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )
}

fn operator_node_id(name: &str) -> Option<&'static str> {
    match name {
        "routecodex.v3.error.err02_classified" => Some(ERR02_NODE),
        "routecodex.v3.error.err03_target_local_action" => Some("error_err03_target_local_action"),
        "routecodex.v3.error.err04_target_exhaustion" => Some("error_err04_target_exhaustion"),
        "routecodex.v3.error.err05_execution_decision" => Some(ERR05_NODE),
        _ => None,
    }
}

fn precompiled_runner() -> Result<&'static PreparedOperationRunner, OperationRunnerError> {
    static RUNNER: OnceLock<Result<PreparedOperationRunner, OperationRunnerError>> =
        OnceLock::new();
    RUNNER
        .get_or_init(PreparedOperationRunner::compile)
        .as_ref()
        .map_err(Clone::clone)
}

pub(crate) fn run_precompiled_node(
    kind: V3OperationGraph,
    node_id: &str,
    input: Value,
    operator: impl Operator + 'static,
) -> Result<Value, OperationRunnerError> {
    precompiled_runner()?.run_node(kind, node_id, input, Box::new(operator))
}

pub(crate) fn run_precompiled_error_02_to_05(
    input: Value,
    operators: Vec<Box<dyn Operator>>,
) -> Result<Value, OperationRunnerError> {
    precompiled_runner()?.run_error_02_to_05(input, operators)
}

pub fn initialize() -> Result<(), OperationRunnerError> {
    precompiled_runner()?;
    Ok(())
}

pub fn precompiled_node_ids(kind: V3OperationGraph) -> Result<Vec<String>, OperationRunnerError> {
    let runner = precompiled_runner()?;
    let mut nodes = runner
        .nodes
        .keys()
        .filter(|(graph, _)| *graph == kind)
        .map(|(_, node)| node.clone())
        .collect::<Vec<_>>();
    nodes.sort();
    Ok(nodes)
}

pub fn compiled_graph_node_ids(
    kind: V3OperationGraph,
) -> Result<Vec<String>, OperationRunnerError> {
    let runner = precompiled_runner()?;
    let graph = match kind {
        V3OperationGraph::Request => &runner.request,
        V3OperationGraph::Response => &runner.response,
        V3OperationGraph::Error => &runner.error,
    };
    Ok(graph.node_ids().map(str::to_string).collect())
}

pub(crate) fn ensure_request_contract(
    slice: &Graph,
    node_id: &str,
    input_arc: &str,
    output_arc: &str,
) -> Result<(), OperationRunnerError> {
    if slice.id != format!("{CANONICAL_REQUEST_GRAPH_ID}.{node_id}")
        || slice.version != CANONICAL_REQUEST_GRAPH_VERSION
        || slice.inputs.first().map(|input| input.id.as_str()) != Some(input_arc)
        || slice.outputs.as_slice() != [output_arc]
    {
        return Err(OperationRunnerError::new(format!(
            "request node `{node_id}` does not match its canonical graph contract"
        )));
    }
    Ok(())
}

pub(crate) fn request_capture_contract() -> Result<(), OperationRunnerError> {
    precompiled_runner()?;
    Ok(())
}

pub(crate) fn request_standard_contract() -> Result<(), OperationRunnerError> {
    precompiled_runner()?;
    Ok(())
}

pub(crate) fn request_capture_input_arc() -> &'static str {
    SOURCE_REQUEST_ARC
}

pub(crate) fn request_capture_output_arc() -> &'static str {
    CLIENT_JSON_ARC
}

pub(crate) fn request_standard_input_arc() -> &'static str {
    GOVERNED_REQUEST_ARC
}

pub(crate) fn request_standard_output_arc() -> &'static str {
    STANDARD_PROVIDER_REQUEST_ARC
}

pub(crate) fn ensure_field_profile_loaded() -> Result<(), OperationRunnerError> {
    if FIELD_PROFILES_YAML.trim().is_empty() {
        return Err(OperationRunnerError::new("field profile manifest is empty"));
    }
    Ok(())
}

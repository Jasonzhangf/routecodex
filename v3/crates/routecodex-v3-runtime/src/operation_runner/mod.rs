use pipeline_runtime::{
    ArcId, Cancellation, CompiledGraph, Graph, Identity, Registry, Runtime, ValueType,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

mod operators;
use operators::CaptureClientJsonOperator;

const REQUEST_GRAPH_JSON: &str =
    include_str!("../../../../../docs/architecture/dagpipe/v3.operation_runner.request.graph.json");
const FIELD_PROFILES_YAML: &str = include_str!(
    "../../../../../docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml"
);
const CANONICAL_REQUEST_GRAPH_ID: &str = "v3.operation_runner.request";
const CANONICAL_REQUEST_GRAPH_VERSION: &str = "1";
const CAPTURE_NODE_ID: &str = "capture_client_json";
const SOURCE_REQUEST_ARC: &str = "source-request";
const CLIENT_JSON_ARC: &str = "client-json";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OperationRunnerError {
    pub message: String,
}

impl OperationRunnerError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for OperationRunnerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for OperationRunnerError {}

impl From<pipeline_runtime::CompileError> for OperationRunnerError {
    fn from(error: pipeline_runtime::CompileError) -> Self {
        Self::new(error.message)
    }
}

impl From<pipeline_runtime::ExecutionFailure> for OperationRunnerError {
    fn from(error: pipeline_runtime::ExecutionFailure) -> Self {
        Self::new(error.to_string())
    }
}

/// The only request-graph entry. It compiles the canonical capture slice and
/// executes it through the shared DAGpipe Runtime.
pub struct RuntimeRequestGraphEntry {
    graph: CompiledGraph,
}

/// Control supplied by the selected Server entry before the business JSON is read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuntimeIngressDescriptor {
    transport: RuntimeIngressTransport,
    entry_protocol: String,
    input_kind: RuntimeInputKind,
    origin: RuntimeRequestOrigin,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RuntimeIngressTransport {
    Http,
    ResponsesWebSocket,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RuntimeInputKind {
    RawEntry,
    AlreadyCanonical,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RuntimeRequestOrigin {
    ClientEntry,
    Retry,
}

impl RuntimeIngressDescriptor {
    pub fn http(entry_protocol: impl Into<String>) -> Self {
        Self {
            transport: RuntimeIngressTransport::Http,
            entry_protocol: entry_protocol.into(),
            input_kind: RuntimeInputKind::RawEntry,
            origin: RuntimeRequestOrigin::ClientEntry,
        }
    }

    pub fn responses_websocket() -> Self {
        Self {
            transport: RuntimeIngressTransport::ResponsesWebSocket,
            entry_protocol: "openai-responses".into(),
            input_kind: RuntimeInputKind::RawEntry,
            origin: RuntimeRequestOrigin::ClientEntry,
        }
    }

    fn already_canonical(&self) -> Self {
        let mut descriptor = self.clone();
        descriptor.input_kind = RuntimeInputKind::AlreadyCanonical;
        descriptor.origin = RuntimeRequestOrigin::Retry;
        descriptor
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct InverseRecord {
    entry_protocol: String,
    source_path: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PairingRecord {
    call_id: String,
    output_id: String,
}

#[derive(Default)]
struct RequestSlots {
    inverse: Option<InverseRecord>,
    pairing: Option<PairingRecord>,
}

/// The only request-scoped control store for the Node02 capability consumer.
pub struct V3NormalizedRequestLease {
    ingress: RuntimeIngressDescriptor,
    metadata_center: Arc<Mutex<RequestSlots>>,
}

impl V3NormalizedRequestLease {
    fn new(ingress: RuntimeIngressDescriptor) -> Self {
        Self {
            ingress,
            metadata_center: Arc::new(Mutex::new(RequestSlots::default())),
        }
    }
}

struct RuntimeRequestFinalizer;

impl RuntimeRequestFinalizer {
    fn release(lease: &mut V3NormalizedRequestLease) {
        let mut slots = lease
            .metadata_center
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        *slots = RequestSlots::default();
    }
}

impl Drop for V3NormalizedRequestLease {
    fn drop(&mut self) {
        RuntimeRequestFinalizer::release(self);
    }
}

pub struct RuntimeCapturedRequest {
    pub payload: Value,
    pub lease: V3NormalizedRequestLease,
}

impl RuntimeCapturedRequest {
    pub fn into_parts(self) -> (Value, V3NormalizedRequestLease) {
        (self.payload, self.lease)
    }
}

impl RuntimeRequestGraphEntry {
    pub fn compile() -> Result<Self, OperationRunnerError> {
        let mut registry = Registry::default();
        registry.register(CaptureClientJsonOperator)?;
        let graph = compile_v3_operation_runner_request_capture_client_json(&registry)?;
        Ok(Self { graph })
    }
}

fn derived_capture_slice_graph_id(canonical_graph_id: &str, selected_node_id: &str) -> String {
    format!("{canonical_graph_id}.{selected_node_id}")
}

impl RuntimeRequestGraphEntry {
    pub fn capture_client_json(&self, payload: Value) -> Result<Value, OperationRunnerError> {
        static EXECUTION_SEQUENCE: AtomicU64 = AtomicU64::new(1);
        let execution_id = EXECUTION_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let identity = request_capture_identity(&self.graph, format!("request-{execution_id}"));
        let mut inputs = HashMap::<ArcId, Value>::new();
        inputs.insert(SOURCE_REQUEST_ARC.to_string(), payload);
        let result = Runtime::new(BTreeSet::new()).run(
            &self.graph,
            identity,
            inputs,
            &Cancellation::default(),
        )?;
        result
            .outputs
            .get(CLIENT_JSON_ARC)
            .map(|output| output.payload.clone())
            .ok_or_else(|| OperationRunnerError::new("capture graph omitted `client-json` output"))
    }
}

fn request_capture_identity(graph: &CompiledGraph, execution_id: String) -> Identity {
    Identity {
        project_id: "routecodex-v3".to_string(),
        graph_id: graph.id().to_string(),
        graph_version: graph.version().to_string(),
        execution_id,
        attempt_id: "client-entry".to_string(),
    }
}

#[derive(Deserialize)]
struct FieldProfileManifest {
    arc_schema_registry: ArcSchemaRegistry,
}

#[derive(Deserialize)]
struct ArcSchemaRegistry {
    schemas: Vec<ArcSchemaEntry>,
}

#[derive(Deserialize)]
struct ArcSchemaEntry {
    id: String,
    schema: String,
}

fn project_arc_schema_registry(
    source: &str,
) -> Result<HashMap<String, String>, OperationRunnerError> {
    let manifest: FieldProfileManifest = serde_yaml::from_str(source).map_err(|error| {
        OperationRunnerError::new(format!(
            "invalid field-profile ARC schema registry: {error}"
        ))
    })?;
    if manifest.arc_schema_registry.schemas.is_empty() {
        return Err(OperationRunnerError::new(
            "field-profile ARC schema registry is empty",
        ));
    }

    let mut schemas = HashMap::new();
    for entry in manifest.arc_schema_registry.schemas {
        let id = entry.id;
        if schemas.insert(id.clone(), entry.schema).is_some() {
            return Err(OperationRunnerError::new(format!(
                "field-profile ARC schema registry contains duplicate `{id}`"
            )));
        }
    }
    Ok(schemas)
}

fn project_value_type(name: &str) -> Result<ValueType, OperationRunnerError> {
    match name {
        "Any" => Ok(ValueType::Any),
        "null" | "Null" => Ok(ValueType::Null),
        "Boolean" => Ok(ValueType::Boolean),
        "Number" => Ok(ValueType::Number),
        "String" => Ok(ValueType::String),
        "Array" => Ok(ValueType::Array),
        "Object" => Ok(ValueType::Object),
        other => Err(OperationRunnerError::new(format!(
            "unsupported DAGpipe ARC ValueType `{other}` in project schema registry"
        ))),
    }
}

fn required_string<'a>(
    value: &'a Value,
    key: &str,
    context: &str,
) -> Result<&'a str, OperationRunnerError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| OperationRunnerError::new(format!("{context} omitted string `{key}`")))
}

fn validate_arc_schema(
    arc: &Value,
    expected_arc_id: &str,
    registry: &HashMap<String, String>,
) -> Result<ValueType, OperationRunnerError> {
    let context = format!("ARC `{expected_arc_id}`");
    let arc_id = required_string(arc, "id", &context)?;
    if arc_id != expected_arc_id {
        return Err(OperationRunnerError::new(format!(
            "{context} resolved to unexpected ARC id `{arc_id}`"
        )));
    }
    let schema_ref = required_string(arc, "schema_ref", &context)?;
    let registered_schema = registry.get(schema_ref).ok_or_else(|| {
        OperationRunnerError::new(format!(
            "{context} references unknown project schema `{schema_ref}`"
        ))
    })?;
    let inline_schema = required_string(arc, "schema", &context)?;
    let registered_type = project_value_type(registered_schema)?;
    let inline_type = project_value_type(inline_schema)?;
    if inline_type != registered_type {
        return Err(OperationRunnerError::new(format!(
            "{context} inline schema `{inline_schema}` does not match `{schema_ref}` schema `{registered_schema}`"
        )));
    }
    Ok(registered_type)
}

fn request_capture_graph_slice_from_sources(
    graph_source: &str,
    field_profiles_source: &str,
) -> Result<Graph, OperationRunnerError> {
    let mut graph: Value = serde_json::from_str(graph_source).map_err(|error| {
        OperationRunnerError::new(format!("invalid request graph JSON: {error}"))
    })?;
    let registry = project_arc_schema_registry(field_profiles_source)?;
    let canonical_graph_id = required_string(&graph, "id", "request graph")?.to_string();
    if canonical_graph_id != CANONICAL_REQUEST_GRAPH_ID.to_string() {
        return Err(OperationRunnerError::new(format!(
            "request graph ID must be `{CANONICAL_REQUEST_GRAPH_ID}`, got `{canonical_graph_id}`"
        )));
    }
    let graph_version = required_string(&graph, "version", "request graph")?.to_string();
    if graph_version != CANONICAL_REQUEST_GRAPH_VERSION.to_string() {
        return Err(OperationRunnerError::new(format!(
            "request graph version must be `{CANONICAL_REQUEST_GRAPH_VERSION}`, got `{graph_version}`"
        )));
    }
    let slice_graph_id = derived_capture_slice_graph_id(&canonical_graph_id, CAPTURE_NODE_ID);

    let nodes = graph
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or_else(|| OperationRunnerError::new("request graph omitted node array"))?
        .clone();
    let capture_node = nodes
        .iter()
        .find(|node| node.get("id").and_then(Value::as_str) == Some(CAPTURE_NODE_ID))
        .cloned()
        .ok_or_else(|| OperationRunnerError::new("request graph omitted `capture_client_json`"))?;
    let target_output = required_string(
        capture_node
            .get("output")
            .ok_or_else(|| OperationRunnerError::new("capture node omitted output ARC"))?,
        "id",
        "capture output ARC",
    )?
    .to_string();
    if target_output != CLIENT_JSON_ARC {
        return Err(OperationRunnerError::new(format!(
            "capture output ARC must be `{CLIENT_JSON_ARC}`, got `{target_output}`"
        )));
    }

    let mut included_nodes = BTreeSet::from([CAPTURE_NODE_ID.to_string()]);
    let edges = graph
        .get("edges")
        .and_then(Value::as_array)
        .ok_or_else(|| OperationRunnerError::new("request graph omitted edge array"))?
        .clone();
    loop {
        let previous_count = included_nodes.len();
        for edge in &edges {
            let from = edge.get("from").and_then(Value::as_str).ok_or_else(|| {
                OperationRunnerError::new("request graph edge omitted string `from`")
            })?;
            let to = edge.get("to").and_then(Value::as_str).ok_or_else(|| {
                OperationRunnerError::new("request graph edge omitted string `to`")
            })?;
            if included_nodes.contains(to) {
                included_nodes.insert(from.to_string());
            }
        }
        if included_nodes.len() == previous_count {
            break;
        }
    }

    let selected_nodes: Vec<Value> = nodes
        .iter()
        .filter(|node| {
            node.get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| included_nodes.contains(id))
        })
        .cloned()
        .collect();
    if selected_nodes.len() != 1
        || selected_nodes[0].get("id").and_then(Value::as_str) != Some(CAPTURE_NODE_ID)
    {
        return Err(OperationRunnerError::new(
            "capture delivery slice must contain only `capture_client_json`",
        ));
    }
    let produced_arcs: BTreeSet<String> = selected_nodes
        .iter()
        .filter_map(|node| node.get("output"))
        .filter_map(|output| output.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    let required_input_arcs: BTreeSet<String> = selected_nodes
        .iter()
        .filter_map(|node| node.get("inputs").and_then(Value::as_array))
        .flatten()
        .filter_map(Value::as_str)
        .filter(|arc| !produced_arcs.contains(*arc))
        .map(str::to_string)
        .collect();
    if required_input_arcs != BTreeSet::from([SOURCE_REQUEST_ARC.to_string()]) {
        return Err(OperationRunnerError::new(format!(
            "capture slice input ARC must be `{SOURCE_REQUEST_ARC}`"
        )));
    }

    let graph_inputs = graph
        .get("inputs")
        .and_then(Value::as_array)
        .ok_or_else(|| OperationRunnerError::new("request graph omitted input ARC array"))?
        .clone();
    let selected_inputs: Vec<Value> = graph_inputs
        .iter()
        .filter(|input| {
            input
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| required_input_arcs.contains(id))
        })
        .cloned()
        .collect();
    if selected_inputs.len() != required_input_arcs.len() {
        return Err(OperationRunnerError::new(
            "capture slice input ARC is not declared by the request graph",
        ));
    }
    for input in &selected_inputs {
        let arc_id = required_string(input, "id", "capture input ARC")?;
        let schema = validate_arc_schema(input, arc_id, &registry)?;
        if schema != ValueType::Any {
            return Err(OperationRunnerError::new(format!(
                "capture input ARC `{arc_id}` must use Any schema"
            )));
        }
    }

    let capture_resources = capture_node
        .get("resources")
        .and_then(Value::as_object)
        .ok_or_else(|| OperationRunnerError::new("capture node omitted resource effects"))?;
    for effect in ["reads", "writes"] {
        let resources = capture_resources
            .get(effect)
            .and_then(Value::as_array)
            .ok_or_else(|| {
                OperationRunnerError::new(format!("capture node omitted resource `{effect}` array"))
            })?;
        if !resources.is_empty() {
            return Err(OperationRunnerError::new(format!(
                "pure capture node must declare no resource {effect}"
            )));
        }
    }

    let output = capture_node
        .get("output")
        .ok_or_else(|| OperationRunnerError::new("capture node omitted output ARC"))?;
    let output_schema = validate_arc_schema(output, &target_output, &registry)?;
    if output_schema != ValueType::Any {
        return Err(OperationRunnerError::new(format!(
            "capture output ARC `{target_output}` must use Any schema"
        )));
    }

    let root = graph
        .as_object_mut()
        .ok_or_else(|| OperationRunnerError::new("request graph must be a JSON object"))?;
    root.insert("id".to_string(), Value::String(slice_graph_id));
    root.insert("version".to_string(), Value::String(graph_version));
    root.insert("nodes".to_string(), Value::Array(selected_nodes));
    root.insert(
        "edges".to_string(),
        Value::Array(
            edges
                .iter()
                .filter(|edge| {
                    let from = edge.get("from").and_then(Value::as_str);
                    let to = edge.get("to").and_then(Value::as_str);
                    from.is_some_and(|id| included_nodes.contains(id))
                        && to.is_some_and(|id| included_nodes.contains(id))
                })
                .cloned()
                .collect(),
        ),
    );
    root.insert("inputs".to_string(), Value::Array(selected_inputs));
    root.insert("outputs".to_string(), serde_json::json!([target_output]));

    let slice_source = serde_json::to_string(&graph)
        .map_err(|error| OperationRunnerError::new(format!("invalid capture slice: {error}")))?;
    Ok(pipeline_runtime::parse_graph_json(&slice_source)?)
}

fn request_capture_graph_slice() -> Result<Graph, OperationRunnerError> {
    request_capture_graph_slice_from_sources(REQUEST_GRAPH_JSON, FIELD_PROFILES_YAML)
}

pub fn compile_v3_operation_runner_request_capture_client_json(
    registry: &Registry,
) -> Result<CompiledGraph, OperationRunnerError> {
    let graph = request_capture_graph_slice()?;
    Ok(pipeline_runtime::compile(
        graph,
        registry,
        &BTreeSet::new(),
    )?)
}

fn request_graph_entry() -> Result<&'static RuntimeRequestGraphEntry, OperationRunnerError> {
    static ENTRY: OnceLock<Result<RuntimeRequestGraphEntry, OperationRunnerError>> =
        OnceLock::new();
    match ENTRY.get_or_init(RuntimeRequestGraphEntry::compile) {
        Ok(entry) => Ok(entry),
        Err(error) => Err(error.clone()),
    }
}

pub fn execute_v3_operation_runner_request_capture_client_json(
    payload: Value,
    ingress: RuntimeIngressDescriptor,
) -> Result<RuntimeCapturedRequest, OperationRunnerError> {
    let lease = V3NormalizedRequestLease::new(ingress);
    let payload = request_graph_entry()?.capture_client_json(payload)?;
    Ok(RuntimeCapturedRequest { payload, lease })
}

#[cfg(test)]
mod capability_tests;
#[cfg(test)]
mod tests;

use pipeline_runtime::{
    ArcId, Cancellation, CompiledGraph, Graph, Identity, Registry, Runtime, ValueType,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

mod operators;
pub(crate) use operators::project_canonical_standard_view;
pub(crate) use operators::{restore_standard_projection_siblings, restore_standard_transform_siblings};
pub(crate) use operators::project_registered_native_gemini_tools;
pub(crate) use operators::is_unchanged_native_instruction_separator;
pub use operators::{
    apply_canonical_field_edit, project_canonical_direct_request, project_canonical_request,
    project_hosted_history_emissions, CanonicalFieldEdit, CanonicalRequestProjection,
    CurrentFieldAssociation, CurrentFieldAssociations, DirectRequestProjection,
    HostedHistoryEmission,
};
pub use routecodex_v3_target::V3TargetCandidate;
mod request_context_store;
use operators::{CaptureClientJsonOperator, NormalizeRequestLosslesslyOperator};
pub use request_context_store::{
    AttemptContext, AttemptDeclarationMap, AttemptProjectionContext, ExplicitHistoryPairing,
    FieldMapping, HistoryPairingReference, OpaqueRecordReference, ProjectionPath,
    RequestInverseContext, RequestInvocationContext, RequestNormalizationEntry, RequestOriginKind,
    RequestScopedContextPair, ResponseProjectionView, ToolDeclarationReference,
    ToolMappingReference, V3RequestContextHandle, V3RequestFinalizerGuard,
};

const REQUEST_GRAPH_JSON: &str =
    include_str!("../../../../../docs/architecture/dagpipe/v3.operation_runner.request.graph.json");
const FIELD_PROFILES_YAML: &str = include_str!(
    "../../../../../docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml"
);
const CANONICAL_REQUEST_GRAPH_ID: &str = "v3.operation_runner.request";
const CANONICAL_REQUEST_GRAPH_VERSION: &str = "1";
const CAPTURE_NODE_ID: &str = "capture_client_json";
const NORMALIZE_NODE_ID: &str = "normalize_request_losslessly";
const SOURCE_REQUEST_ARC: &str = "source-request";
const CLIENT_JSON_ARC: &str = "client-json";
const CANONICAL_REQUEST_ARC: &str = "canonical-request";

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
) -> Result<Value, OperationRunnerError> {
    request_graph_entry()?.capture_client_json(payload)
}

fn request_normalize_slice_graph_id(canonical_graph_id: &str, selected_node_id: &str) -> String {
    format!("{canonical_graph_id}.{selected_node_id}")
}

fn request_normalize_graph_slice_from_sources(
    graph_source: &str,
    field_profiles_source: &str,
) -> Result<(Graph, BTreeSet<String>), OperationRunnerError> {
    let mut graph: Value = serde_json::from_str(graph_source).map_err(|error| {
        OperationRunnerError::new(format!("invalid request graph JSON: {error}"))
    })?;
    let registry = project_arc_schema_registry(field_profiles_source)?;
    let canonical_graph_id = required_string(&graph, "id", "request graph")?.to_string();
    if canonical_graph_id != CANONICAL_REQUEST_GRAPH_ID {
        return Err(OperationRunnerError::new(format!(
            "request graph ID must be `{CANONICAL_REQUEST_GRAPH_ID}`, got `{canonical_graph_id}`"
        )));
    }
    let graph_version = required_string(&graph, "version", "request graph")?.to_string();
    if graph_version != CANONICAL_REQUEST_GRAPH_VERSION {
        return Err(OperationRunnerError::new(format!(
            "request graph version must be `{CANONICAL_REQUEST_GRAPH_VERSION}`, got `{graph_version}`"
        )));
    }
    let nodes = graph
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or_else(|| OperationRunnerError::new("request graph omitted node array"))?
        .clone();
    let normalize_node = nodes
        .iter()
        .find(|node| node.get("id").and_then(Value::as_str) == Some(NORMALIZE_NODE_ID))
        .cloned()
        .ok_or_else(|| {
            OperationRunnerError::new("request graph omitted `normalize_request_losslessly`")
        })?;
    let target_output = required_string(
        normalize_node
            .get("output")
            .ok_or_else(|| OperationRunnerError::new("normalize node omitted output ARC"))?,
        "id",
        "normalize output ARC",
    )?
    .to_string();
    if target_output != CANONICAL_REQUEST_ARC {
        return Err(OperationRunnerError::new(format!(
            "normalize output ARC must be `{CANONICAL_REQUEST_ARC}`, got `{target_output}`"
        )));
    }

    let selected_nodes = vec![normalize_node.clone()];

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
    if required_input_arcs != BTreeSet::from([CLIENT_JSON_ARC.to_string()]) {
        return Err(OperationRunnerError::new(format!(
            "normalize slice input ARC must be `{CLIENT_JSON_ARC}`"
        )));
    }

    let selected_input = serde_json::json!({
        "id": CLIENT_JSON_ARC,
        "schema": "Any",
        "schema_ref": "v3.operation_runner.arc.client_json",
    });
    let input_schema = validate_arc_schema(&selected_input, CLIENT_JSON_ARC, &registry)?;
    if input_schema != ValueType::Any {
        return Err(OperationRunnerError::new(format!(
            "normalize input ARC `{CLIENT_JSON_ARC}` must use Any schema"
        )));
    }

    let output = normalize_node
        .get("output")
        .ok_or_else(|| OperationRunnerError::new("normalize node omitted output ARC"))?;
    let output_schema = validate_arc_schema(output, &target_output, &registry)?;
    if output_schema != ValueType::Object {
        return Err(OperationRunnerError::new(format!(
            "normalize output ARC `{target_output}` must use Object schema"
        )));
    }

    let resources = normalize_node
        .get("resources")
        .and_then(Value::as_object)
        .ok_or_else(|| OperationRunnerError::new("normalize node omitted resource effects"))?;
    let declared_reads = resources
        .get("reads")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            OperationRunnerError::new("normalize node omitted resource `reads` array")
        })?;
    let declared_writes = resources
        .get("writes")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            OperationRunnerError::new("normalize node omitted resource `writes` array")
        })?;
    let expected_reads = BTreeSet::from([
        "v3.config.published_manifest".to_string(),
        "v3.operation_runner.request_origin_kind".to_string(),
        "v3.operation_runner.request_inverse_context".to_string(),
        "v3.operation_runner.explicit_history_pairing".to_string(),
    ]);
    let expected_writes = BTreeSet::from([
        "v3.operation_runner.request_inverse_context".to_string(),
        "v3.operation_runner.explicit_history_pairing".to_string(),
    ]);
    let actual_reads: BTreeSet<String> = declared_reads
        .iter()
        .map(|value| {
            value.as_str().map(str::to_string).ok_or_else(|| {
                OperationRunnerError::new("normalize resource read must be a string")
            })
        })
        .collect::<Result<_, _>>()?;
    let actual_writes: BTreeSet<String> = declared_writes
        .iter()
        .map(|value| {
            value.as_str().map(str::to_string).ok_or_else(|| {
                OperationRunnerError::new("normalize resource write must be a string")
            })
        })
        .collect::<Result<_, _>>()?;
    if actual_reads != expected_reads || actual_writes != expected_writes {
        return Err(OperationRunnerError::new(
            "normalize node resource effects do not match the REQ02 contract",
        ));
    }

    let root = graph
        .as_object_mut()
        .ok_or_else(|| OperationRunnerError::new("request graph must be a JSON object"))?;
    root.insert(
        "id".to_string(),
        Value::String(request_normalize_slice_graph_id(
            &canonical_graph_id,
            NORMALIZE_NODE_ID,
        )),
    );
    root.insert("version".to_string(), Value::String(graph_version));
    root.insert("nodes".to_string(), Value::Array(selected_nodes));
    root.insert("edges".to_string(), Value::Array(Vec::new()));
    root.insert("inputs".to_string(), Value::Array(vec![selected_input]));
    root.insert("outputs".to_string(), serde_json::json!([target_output]));

    let slice_source = serde_json::to_string(&graph)
        .map_err(|error| OperationRunnerError::new(format!("invalid normalize slice: {error}")))?;
    let capabilities = expected_reads.union(&expected_writes).cloned().collect();
    Ok((
        pipeline_runtime::parse_graph_json(&slice_source)?,
        capabilities,
    ))
}

pub fn request_normalize_graph_slice() -> Result<(Graph, BTreeSet<String>), OperationRunnerError> {
    request_normalize_graph_slice_from_sources(REQUEST_GRAPH_JSON, FIELD_PROFILES_YAML)
}

pub fn execute_v3_operation_runner_request_normalize_losslessly(
    handle: &V3RequestContextHandle,
    invocation: &RequestInvocationContext,
    entry: RequestNormalizationEntry,
) -> Result<Value, OperationRunnerError> {
    if !invocation.request_handle().same_scope(handle) {
        return Err(OperationRunnerError::new(format!(
            "request handle `{}` does not belong to invocation request `{}` scope",
            handle.request_id(),
            invocation.request_handle().request_id()
        )));
    }
    entry
        .validate_origin(invocation.origin_kind())
        .map_err(OperationRunnerError::new)?;
    let mut registry = Registry::default();
    registry
        .register(NormalizeRequestLosslesslyOperator::new(invocation.clone()))
        .map_err(OperationRunnerError::from)?;
    let (graph, capabilities) = request_normalize_graph_slice()?;
    let compiled = pipeline_runtime::compile(graph, &registry, &capabilities)
        .map_err(OperationRunnerError::from)?;
    let identity = Identity {
        project_id: "routecodex-v3".to_string(),
        graph_id: compiled.id().to_string(),
        graph_version: compiled.version().to_string(),
        execution_id: invocation.invocation_id().to_string(),
        attempt_id: invocation.attempt_id().to_string(),
    };
    let mut inputs = HashMap::<ArcId, Value>::new();
    inputs.insert(CLIENT_JSON_ARC.to_string(), entry.into_value());
    let result =
        Runtime::new(capabilities).run(&compiled, identity, inputs, &Cancellation::default())?;
    result
        .outputs
        .get(CANONICAL_REQUEST_ARC)
        .map(|output| output.payload.clone())
        .ok_or_else(|| {
            OperationRunnerError::new("normalize graph omitted `canonical-request` output")
        })
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod req02_resource_runner_tests {
    use super::*;
    use serde_json::json;

    fn requests_entry() -> Value {
        json!({
            "model": "client-model",
            "input": [{
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "hello"}]
            }],
            "stream": false
        })
    }

    fn handle(request_id: &str) -> V3RequestContextHandle {
        V3RequestContextHandle::new(request_id.to_string(), "responses".to_string())
    }

    fn invocation(
        handle: &V3RequestContextHandle,
        invocation_id: &str,
        attempt_id: &str,
        origin: RequestOriginKind,
    ) -> RequestInvocationContext {
        RequestInvocationContext::new(
            handle.clone(),
            invocation_id.to_string(),
            attempt_id.to_string(),
            origin,
        )
    }

    fn attempt_context(attempt_id: &str, protocol: &str, model: &str) -> AttemptContext {
        AttemptContext {
            attempt_id: attempt_id.to_string(),
            projection: AttemptProjectionContext {
                attempt_id: attempt_id.to_string(),
                provider_protocol: protocol.to_string(),
                provider_model: model.to_string(),
                paths: vec![ProjectionPath {
                    source_path: "messages".to_string(),
                    destination_path: "input".to_string(),
                    encoding: "json-array".to_string(),
                }],
            },
            declarations: AttemptDeclarationMap {
                attempt_id: attempt_id.to_string(),
                provider_protocol: protocol.to_string(),
                provider_model: model.to_string(),
                tool_mappings: vec![ToolMappingReference {
                    declaration_record_id: "tool-declaration-1".to_string(),
                    source_path: "request.tools[0]".to_string(),
                    destination_path: "tools[0]".to_string(),
                    emitted_kind: "function".to_string(),
                    emitted_name: Some("lookup".to_string()),
                    emitted_namespace: None,
                    encoding: "json-object".to_string(),
                }],
            },
        }
    }

    #[test]
    fn req02_public_sdk_raw_entry_normalizes_and_publishes_pair() {
        let request = handle("req-01");
        let invocation = invocation(
            &request,
            "invocation-1",
            "attempt-1",
            RequestOriginKind::ClientEntry,
        );
        let captured =
            execute_v3_operation_runner_request_capture_client_json(requests_entry()).unwrap();

        let canonical = execute_v3_operation_runner_request_normalize_losslessly(
            &request,
            &invocation,
            RequestNormalizationEntry::RawEntry(captured.clone()),
        )
        .expect("public REQ02 runner executes real normalize slice");

        assert_eq!(invocation.invocation_id(), "invocation-1");
        assert_eq!(invocation.attempt_id(), "attempt-1");
        assert_ne!(request.request_id(), invocation.invocation_id());
        assert_ne!(invocation.invocation_id(), invocation.attempt_id());
        assert!(canonical.get("messages").is_some());
        assert_eq!(canonical["messages"][0]["role"], "user");
        let pair = request.original_pair().expect("raw entry publishes pair");
        assert_eq!(pair.inverse_context.entry_protocol, "responses");
        assert_eq!(pair.explicit_history_pairing.entry_protocol, "responses");
    }

    #[test]
    fn req02_retry_reuses_same_sdk_without_recapture_or_pair_replacement() {
        let request = handle("req-02");
        let client = invocation(
            &request,
            "invocation-a",
            "attempt-a",
            RequestOriginKind::ClientEntry,
        );
        let captured =
            execute_v3_operation_runner_request_capture_client_json(requests_entry()).unwrap();
        let canonical = execute_v3_operation_runner_request_normalize_losslessly(
            &request,
            &client,
            RequestNormalizationEntry::RawEntry(captured),
        )
        .expect("first invocation normalizes raw entry");
        let original_pair = request.original_pair().unwrap();

        let retry = invocation(
            &request,
            "invocation-b",
            "attempt-b",
            RequestOriginKind::InternalFollowup,
        );
        let reentered = execute_v3_operation_runner_request_normalize_losslessly(
            &request,
            &retry,
            RequestNormalizationEntry::AlreadyCanonical(canonical.clone()),
        )
        .expect("reentry preserves request pair");

        assert_eq!(reentered, canonical);
        assert_eq!(request.original_pair().unwrap(), original_pair);
    }

    #[test]
    fn req02_raw_entry_cannot_republish_after_pair_exists() {
        let request = handle("req-republish");
        let client = invocation(
            &request,
            "invocation-a",
            "attempt-a",
            RequestOriginKind::ClientEntry,
        );
        let captured =
            execute_v3_operation_runner_request_capture_client_json(requests_entry()).unwrap();
        execute_v3_operation_runner_request_normalize_losslessly(
            &request,
            &client,
            RequestNormalizationEntry::RawEntry(captured.clone()),
        )
        .expect("first raw entry publishes the original pair");
        let original_pair = request.original_pair().unwrap();

        let republish = invocation(
            &request,
            "invocation-b",
            "attempt-b",
            RequestOriginKind::ClientEntry,
        );
        let error = execute_v3_operation_runner_request_normalize_losslessly(
            &request,
            &republish,
            RequestNormalizationEntry::RawEntry(captured),
        )
        .expect_err("a request scope cannot publish a second raw entry");

        assert!(error.message.contains("already has an original pair"));
        assert_eq!(request.original_pair().unwrap(), original_pair);
    }

    #[test]
    fn req02_inconsistent_entry_origin_fails_before_graph_execution() {
        let request = handle("req-03");
        let retry = invocation(&request, "inv-3", "attempt-3", RequestOriginKind::Retry);
        let error = execute_v3_operation_runner_request_normalize_losslessly(
            &request,
            &retry,
            RequestNormalizationEntry::RawEntry(requests_entry()),
        )
        .expect_err("retry cannot recapture a raw entry");

        assert!(error.message.contains("already-canonical"));
        assert!(request.original_pair().is_err());
    }

    #[test]
    fn req02_two_requests_are_isolated() {
        let request_a = handle("req-a");
        let request_b = handle("req-b");
        let inv_a = invocation(
            &request_a,
            "inv-a",
            "attempt-a",
            RequestOriginKind::ClientEntry,
        );
        let inv_b = invocation(
            &request_b,
            "inv-b",
            "attempt-b",
            RequestOriginKind::ClientEntry,
        );
        let captured_a =
            execute_v3_operation_runner_request_capture_client_json(requests_entry()).unwrap();
        let captured_b =
            execute_v3_operation_runner_request_capture_client_json(requests_entry()).unwrap();
        execute_v3_operation_runner_request_normalize_losslessly(
            &request_a,
            &inv_a,
            RequestNormalizationEntry::RawEntry(captured_a),
        )
        .expect("request a normalizes");
        execute_v3_operation_runner_request_normalize_losslessly(
            &request_b,
            &inv_b,
            RequestNormalizationEntry::RawEntry(captured_b),
        )
        .expect("request b normalizes");

        assert_eq!(request_a.request_id(), "req-a");
        assert_eq!(request_b.request_id(), "req-b");
        assert_eq!(request_a.entry_protocol(), "responses");
        assert_eq!(request_b.entry_protocol(), "responses");
        assert!(request_a.original_pair().is_ok());
        assert!(request_b.original_pair().is_ok());
        assert_ne!(request_a.request_id(), request_b.request_id());
        assert_ne!(inv_a.invocation_id(), inv_b.invocation_id());
        assert_ne!(inv_a.attempt_id(), inv_b.attempt_id());
        assert_eq!(
            request_a
                .original_pair()
                .unwrap()
                .inverse_context
                .opaque_record_references
                .len(),
            request_b
                .original_pair()
                .unwrap()
                .inverse_context
                .opaque_record_references
                .len()
        );
    }

    #[test]
    fn req02_handle_clone_does_not_release_request() {
        let request = handle("req-clone");
        let cloned = request.clone();
        let inv = invocation(
            &request,
            "inv-clone",
            "attempt-clone",
            RequestOriginKind::ClientEntry,
        );
        let captured =
            execute_v3_operation_runner_request_capture_client_json(requests_entry()).unwrap();
        execute_v3_operation_runner_request_normalize_losslessly(
            &request,
            &inv,
            RequestNormalizationEntry::RawEntry(captured),
        )
        .expect("normalizes");

        drop(cloned);
        assert!(
            request.original_pair().is_ok(),
            "dropping a clone must not finalize the request scope"
        );
    }

    #[test]
    fn req02_public_function_handle_is_same_scope_not_just_request_id() {
        let request = handle("req-same-id");
        let foreign = handle("req-same-id");
        let inv = invocation(
            &request,
            "inv-scope",
            "attempt-scope",
            RequestOriginKind::ClientEntry,
        );
        let captured =
            execute_v3_operation_runner_request_capture_client_json(requests_entry()).unwrap();
        let error = execute_v3_operation_runner_request_normalize_losslessly(
            &foreign,
            &inv,
            RequestNormalizationEntry::RawEntry(captured),
        )
        .expect_err("equal request ids must not alias different scopes");

        assert!(error.message.contains("does not belong to"));
        assert!(request.original_pair().is_err());
        assert!(foreign.original_pair().is_err());
    }

    #[test]
    fn req02_finalizer_releases_attempt_then_request() {
        let request = handle("req-finalize");
        let inv = invocation(
            &request,
            "inv-final",
            "attempt-final",
            RequestOriginKind::ClientEntry,
        );
        let captured =
            execute_v3_operation_runner_request_capture_client_json(requests_entry()).unwrap();
        execute_v3_operation_runner_request_normalize_losslessly(
            &request,
            &inv,
            RequestNormalizationEntry::RawEntry(captured),
        )
        .expect("normalizes");
        request
            .publish_successful_attempt(attempt_context(
                "attempt-final",
                "responses",
                "model-provider",
            ))
            .unwrap();

        let guard = request
            .clone()
            .take_finalizer()
            .expect("first finalizer is available");
        guard.finalize().expect("finalizer releases clean slots");
        assert_eq!(
            request.release_events_for_test(),
            vec![
                "attempts-cleared",
                "current-associations-cleared",
                "original-pair-cleared",
                "terminated"
            ]
        );
        assert!(
            request.original_pair().is_err(),
            "terminal finalizer must release request pair"
        );
        assert!(
            request.successful_attempt("attempt-final").is_err(),
            "attempt slot must be released before request pair becomes unavailable"
        );
        let second_guard = request.clone().take_finalizer();
        assert!(second_guard.is_err(), "finalizer can only be taken once");
        assert!(request.original_pair().is_err());
        assert!(request.successful_attempt("attempt-final").is_err());
    }

    #[test]
    fn req02_finalizer_releases_poisoned_scope_and_reports_error() {
        let request = handle("req-poisoned");
        let inv = invocation(
            &request,
            "inv-poisoned",
            "attempt-poisoned",
            RequestOriginKind::ClientEntry,
        );
        let captured =
            execute_v3_operation_runner_request_capture_client_json(requests_entry()).unwrap();
        execute_v3_operation_runner_request_normalize_losslessly(
            &request,
            &inv,
            RequestNormalizationEntry::RawEntry(captured),
        )
        .expect("normalizes before poison");
        request
            .publish_successful_attempt(attempt_context(
                "attempt-poisoned",
                "responses",
                "model-poisoned",
            ))
            .expect("successful attempt before poison");
        request.poison_slots_for_test();

        let guard = request
            .clone()
            .take_finalizer()
            .expect("poisoned scope still has a finalizer");
        let error = guard
            .finalize()
            .expect_err("poisoned scope reports an observable finalization error");
        assert!(error.contains("poisoned"));
        assert_eq!(
            request.release_events_for_test(),
            vec![
                "attempts-cleared",
                "current-associations-cleared",
                "original-pair-cleared",
                "terminated"
            ]
        );
        assert!(request.original_pair().is_err());
        assert!(request.successful_attempt("attempt-poisoned").is_err());
    }

    #[test]
    fn req02_poisoned_finalizer_drop_does_not_panic() {
        let request = handle("req-poisoned-drop");
        let guard = request
            .clone()
            .take_finalizer()
            .expect("finalizer is available");
        request.poison_slots_for_test();

        let drop_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            drop(guard);
        }));

        assert!(drop_result.is_ok(), "Drop must not panic on poisoned slots");
        assert_eq!(
            request.release_events_for_test(),
            vec![
                "attempts-cleared",
                "current-associations-cleared",
                "original-pair-cleared",
                "terminated"
            ]
        );
        assert!(request.original_pair().is_err());
    }

    #[test]
    fn req02_guard_release_is_idempotent_across_success_error_cancel_drop() {
        let request = handle("req-idempotent");
        let inv = invocation(
            &request,
            "inv-idem",
            "attempt-idem",
            RequestOriginKind::ClientEntry,
        );
        let captured =
            execute_v3_operation_runner_request_capture_client_json(requests_entry()).unwrap();
        execute_v3_operation_runner_request_normalize_losslessly(
            &request,
            &inv,
            RequestNormalizationEntry::RawEntry(captured),
        )
        .expect("normalizes");

        let guard = request
            .clone()
            .take_finalizer()
            .expect("first finalizer is available");
        guard.finalize().expect("finalizer releases clean slots");
        drop(guard);
        let second = request.clone().take_finalizer();
        assert!(second.is_err(), "second finalizer is rejected");
        assert!(request.original_pair().is_err());
    }

    #[test]
    fn req02_successful_attempt_does_not_read_failed_attempt() {
        let request = handle("req-attempts");
        let successful = attempt_context("attempt-ok", "responses", "model-ok");
        request
            .publish_successful_attempt(successful)
            .expect("successful attempt publishes");
        request
            .record_failed_attempt("attempt-failed", "provider 500")
            .expect("failed attempt is recorded");
        let failed = request
            .successful_attempt("attempt-failed")
            .expect_err("failed attempt is not readable as success");
        assert!(failed.contains("no successful attempt"));
        let view = request
            .successful_attempt("attempt-ok")
            .expect("successful attempt remains readable");
        assert_eq!(view.attempt_id, "attempt-ok");
    }

    #[test]
    fn req02_attempt_identity_fields_must_agree() {
        let request = handle("req-attempt-identity");
        let mut mismatched = attempt_context("attempt-ok", "responses", "model-ok");
        mismatched.declarations.provider_model = "model-other".to_string();

        let error = request
            .publish_successful_attempt(mismatched)
            .expect_err("attempt identity mismatch must fail");
        assert!(error.contains("model"));
        assert!(request.successful_attempt("attempt-ok").is_err());
    }
}

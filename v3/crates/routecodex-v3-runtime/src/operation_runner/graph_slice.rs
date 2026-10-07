//! Canonical DAGPipe graph-slice extraction.
//!
//! The canonical request graph plus the field-profile ARC schema registry are the
//! only truth for a selected node's operator/version, input/output ARC schema, and
//! declared resource effects. This module derives the single-node SESE slice for one
//! node and copies the canonical node declaration unchanged, so the SDK
//! `parse`/`compile` boundary stays the owner of the operator contract. It never
//! invents an input schema or locks operator name/version/resource sets.

use pipeline_runtime::{Graph, ValueType};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};

use super::OperationRunnerError;

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

fn resource_effect_set(
    resources: &serde_json::Map<String, Value>,
    effect: &str,
    context: &str,
) -> Result<BTreeSet<String>, OperationRunnerError> {
    resources
        .get(effect)
        .and_then(Value::as_array)
        .ok_or_else(|| {
            OperationRunnerError::new(format!("{context} omitted resource `{effect}` array"))
        })
        .map(|items| {
            items
                .iter()
                .map(|item| {
                    item.as_str().map(str::to_string).ok_or_else(|| {
                        OperationRunnerError::new(format!(
                            "{context} resource `{effect}` contains a non-string entry"
                        ))
                    })
                })
                .collect::<Result<BTreeSet<_>, _>>()
        })?
}

/// The derived slice plus the selected node's declared resource effects, which the
/// SDK `Node` does not carry. Callers apply node-specific policy (for example the
/// pure-capture rule) on top of this shared result.
pub(super) struct DerivedGraphSlice {
    pub graph: Graph,
    pub resource_reads: BTreeSet<String>,
    pub resource_writes: BTreeSet<String>,
}

/// Composite slice identity: canonical graph id plus selected node id. The version
/// is inherited from the canonical graph.
pub(super) fn derived_slice_graph_id(canonical_graph_id: &str, selected_node_id: &str) -> String {
    format!("{canonical_graph_id}.{selected_node_id}")
}

/// Resolves an ARC declaration for `arc_id`, preferring a graph input and falling
/// back to the upstream node that produces it.
fn arc_declaration<'a>(
    graph_inputs: &'a [Value],
    nodes: &'a [Value],
    arc_id: &str,
) -> Option<&'a Value> {
    if let Some(input) = graph_inputs
        .iter()
        .find(|input| input.get("id").and_then(Value::as_str) == Some(arc_id))
    {
        return Some(input);
    }
    nodes.iter().find_map(|node| {
        node.get("output")
            .filter(|output| output.get("id").and_then(Value::as_str) == Some(arc_id))
    })
}

pub(super) fn derive_graph_slice(
    graph_source: &str,
    field_profiles_source: &str,
    selected_node_id: &str,
) -> Result<DerivedGraphSlice, OperationRunnerError> {
    let graph: Value = serde_json::from_str(graph_source).map_err(|error| {
        OperationRunnerError::new(format!("invalid request graph JSON: {error}"))
    })?;
    let registry = project_arc_schema_registry(field_profiles_source)?;
    let canonical_graph_id = required_string(&graph, "id", "request graph")?.to_string();
    let graph_version = required_string(&graph, "version", "request graph")?.to_string();
    let slice_graph_id = derived_slice_graph_id(&canonical_graph_id, selected_node_id);

    let nodes = graph
        .get("nodes")
        .and_then(Value::as_array)
        .ok_or_else(|| OperationRunnerError::new("request graph omitted node array"))?;
    let selected_node = nodes
        .iter()
        .find(|node| node.get("id").and_then(Value::as_str) == Some(selected_node_id))
        .cloned()
        .ok_or_else(|| {
            OperationRunnerError::new(format!("request graph omitted `{selected_node_id}`"))
        })?;

    let graph_inputs = graph
        .get("inputs")
        .and_then(Value::as_array)
        .ok_or_else(|| OperationRunnerError::new("request graph omitted input ARC array"))?;
    let node_inputs = selected_node
        .get("inputs")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            OperationRunnerError::new(format!("node `{selected_node_id}` omitted input ARC list"))
        })?;

    let mut slice_inputs = Vec::with_capacity(node_inputs.len());
    for input_arc in node_inputs {
        let input_arc_id = input_arc.as_str().ok_or_else(|| {
            OperationRunnerError::new(format!(
                "node `{selected_node_id}` input ARC id must be a string"
            ))
        })?;
        let declaration = arc_declaration(graph_inputs, nodes, input_arc_id).ok_or_else(|| {
            OperationRunnerError::new(format!(
                "request graph does not declare input ARC `{input_arc_id}` for node `{selected_node_id}`"
            ))
        })?;
        validate_arc_schema(declaration, input_arc_id, &registry)?;
        slice_inputs.push(declaration.clone());
    }

    let output = selected_node
        .get("output")
        .ok_or_else(|| OperationRunnerError::new("selected node omitted output ARC"))?;
    let output_arc_id = required_string(output, "id", "selected node output ARC")?.to_string();
    validate_arc_schema(output, &output_arc_id, &registry)?;

    let resources = selected_node
        .get("resources")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            OperationRunnerError::new(format!(
                "node `{selected_node_id}` omitted resource effects"
            ))
        })?;
    let resource_reads = resource_effect_set(resources, "reads", selected_node_id)?;
    let resource_writes = resource_effect_set(resources, "writes", selected_node_id)?;

    let slice = serde_json::json!({
        "id": slice_graph_id,
        "version": graph_version,
        "inputs": slice_inputs,
        "nodes": [selected_node],
        "edges": [],
        "outputs": [output_arc_id],
    });
    let slice_source = serde_json::to_string(&slice).map_err(|error| {
        OperationRunnerError::new(format!("invalid derived graph slice: {error}"))
    })?;
    Ok(DerivedGraphSlice {
        graph: pipeline_runtime::parse_graph_json(&slice_source)?,
        resource_reads,
        resource_writes,
    })
}

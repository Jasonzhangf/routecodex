use std::collections::BTreeSet;

use serde_json::{json, Map, Value};

use super::current_projection_view::CurrentProjectionView;
use super::project_canonical_siblings::restore_current_source_siblings;
use crate::operation_runner::{FieldMapping, ToolDeclarationReference, ToolMappingReference};

const TOOL_DECLARATION_OPERATOR: &str = "routecodex.v3.field.tool_declaration_transform@1";
const OPENAI_CHAT_TOOLS_TRANSFORM: &str = "v3.openai_chat_tools_to_chat_tools.v1";
const ANTHROPIC_TOOLS_TRANSFORM: &str = "v3.anthropic_tools_to_chat_tools.v1";
const GEMINI_TOOLS_TRANSFORM: &str = "v3.gemini_tools_to_chat_tools.v1";

/// Consume the registered native declaration inverse at the standard emitter.
/// The same operator owns native declaration shape in Direct and Relay; this
/// does not project history, choose a mode, or reconstruct a native request.
pub(crate) fn project_registered_native_gemini_tools(
    canonical: &Value,
    inverse: &crate::operation_runner::RequestInverseContext,
    current: &crate::operation_runner::CurrentFieldAssociations,
) -> Result<Option<(Value, Vec<ToolMappingReference>)>, String> {
    if !inverse.field_mappings.iter().any(|mapping|
        mapping.transform_id.as_deref() == Some(GEMINI_TOOLS_TRANSFORM)) {
        return Ok(None);
    }
    let view = CurrentProjectionView::new(canonical, inverse, current);
    let tools = canonical.get("tools").unwrap_or(&Value::Null);
    if !tools.is_array() {
        return Ok(Some((tools.clone(), Vec::new())));
    }
    let projected = gemini_tools(&view, tools)?;
    Ok(Some((projected.tools, projected.declarations)))
}

pub(super) struct DirectToolProjection {
    pub(super) tools: Value,
    pub(super) declarations: Vec<ToolMappingReference>,
}

/// Reverse the registered declaration transform using the current data view.
/// Associations were recorded when normalization emitted each declaration.
pub(super) fn project_direct_tools(
    view: &CurrentProjectionView<'_>,
    transform_id: Option<&str>,
) -> Result<DirectToolProjection, String> {
    let Some(tools) = view.canonical().get("tools") else {
        return Ok(DirectToolProjection {
            tools: Value::Null,
            declarations: Vec::new(),
        });
    };
    if !tools.is_array() {
        return Ok(DirectToolProjection {
            tools: tools.clone(),
            declarations: Vec::new(),
        });
    }
    match transform_id {
        None | Some(OPENAI_CHAT_TOOLS_TRANSFORM) => identity_tools(view, tools),
        Some(ANTHROPIC_TOOLS_TRANSFORM) => anthropic_tools(view, tools),
        Some(GEMINI_TOOLS_TRANSFORM) => gemini_tools(view, tools),
        Some(transform) => Err(format!("unregistered tool inverse transform `{transform}`")),
    }
}

fn identity_tools(
    view: &CurrentProjectionView<'_>,
    tools: &Value,
) -> Result<DirectToolProjection, String> {
    let mut declarations = Vec::new();
    for (mapping_index, mapping) in view.inverse().field_mappings.iter().enumerate() {
        if mapping.operator != TOOL_DECLARATION_OPERATOR {
            continue;
        }
        let Some(destination) = view.current_destination(mapping_index) else {
            continue;
        };
        let Some(emitted) = view.read_mapping(mapping_index)? else {
            continue;
        };
        let Some(declaration) = declaration_for_source(view, &mapping.source_path) else {
            continue;
        };
        declarations.push(declaration_reference(
            view,
            declaration,
            mapping,
            wire_destination(destination)?,
            emitted,
        )?);
    }
    declarations.sort_by_key(|declaration| wire_order_key(&declaration.destination_path));
    Ok(DirectToolProjection {
        tools: tools.clone(),
        declarations,
    })
}

fn anthropic_tools(
    view: &CurrentProjectionView<'_>,
    tools: &Value,
) -> Result<DirectToolProjection, String> {
    let current = tools
        .as_array()
        .ok_or_else(|| "current canonical tools must be an array".to_string())?;
    let mut native = Vec::with_capacity(current.len());
    let mut declarations = Vec::new();
    for (wire_index, current_item) in current.iter().enumerate() {
        let destination = format!("chat.tools[{wire_index}]");
        let origin = mapping_for_destination(view, &destination);
        let original = match origin {
            Some(mapping) => original_value_for_source(view, &mapping.source_path)?,
            None => None,
        };
        native.push(inverse_declaration(
            current_item,
            original,
            Some(ANTHROPIC_TOOLS_TRANSFORM),
        )?);
        if let Some(mapping) = origin {
            if let Some(declaration) = declaration_for_source(view, &mapping.source_path) {
                declarations.push(declaration_reference(
                    view,
                    declaration,
                    mapping,
                    &format!("tools[{wire_index}]"),
                    &native[wire_index],
                )?);
            }
        }
    }
    Ok(DirectToolProjection {
        tools: Value::Array(native),
        declarations,
    })
}

fn gemini_tools(
    view: &CurrentProjectionView<'_>,
    tools: &Value,
) -> Result<DirectToolProjection, String> {
    let current = tools
        .as_array()
        .ok_or_else(|| "current canonical tools must be an array".to_string())?;
    let mut native = Vec::new();
    let mut declarations = Vec::new();
    let mut claimed_destinations = BTreeSet::new();

    for (_, container_path) in gemini_container_paths(view) {
        let container_index = native.len();
        if let Some(mapping_index) = view.mapping_index_for_source(&container_path) {
            let mapping = &view.inverse().field_mappings[mapping_index];
            if mapping.operator == TOOL_DECLARATION_OPERATOR {
                let Some(destination) = view.current_destination(mapping_index) else { continue; };
                let Some(current_item) = view.read_mapping(mapping_index)? else { continue; };
                claimed_destinations.insert(destination.to_string());
                native.push(current_item.clone());
                if let Some(declaration) = declaration_for_source(view, &container_path) {
                    declarations.push(declaration_reference(
                        view, declaration, mapping, &format!("tools[{container_index}]"), current_item,
                    )?);
                }
                continue;
            }
        }
        let original_container = original_value_for_source(view, &container_path)?;
        let mut container = if original_container.is_some_and(|value| !value.is_object()) {
            original_container.cloned().unwrap_or(Value::Null)
        } else { json!({}) };
        let Some(container_object) = container.as_object_mut() else {
            native.push(container);
            continue;
        };
        let mut emitted = Vec::new();
        let mut child_mappings = gemini_child_mapping_indices(view, &container_path);
        child_mappings.sort_by_key(|mapping_index| {
            view.current_destination(*mapping_index)
                .map(wire_order_key)
                .unwrap_or_default()
        });
        for mapping_index in child_mappings {
            let mapping = &view.inverse().field_mappings[mapping_index];
            let Some(destination) = view.current_destination(mapping_index) else {
                continue;
            };
            let Some(current_item) = view.read_mapping(mapping_index)? else {
                continue;
            };
            let original = original_value_for_source(view, &mapping.source_path)?;
            let wire_index = emitted.len();
            let projected =
                inverse_declaration(current_item, original, Some(GEMINI_TOOLS_TRANSFORM))?;
            emitted.push(projected);
            claimed_destinations.insert(destination.to_string());
            if let Some(declaration) = declaration_for_source(view, &mapping.source_path) {
                declarations.push(declaration_reference(
                    view,
                    declaration,
                    mapping,
                    &format!("tools[{container_index}].functionDeclarations[{wire_index}]"),
                    &emitted[wire_index],
                )?);
            }
        }
        let original_has_declarations = original_container
            .and_then(|container| container.get("functionDeclarations"))
            .is_some();
        if original_has_declarations || !emitted.is_empty() {
            container_object.insert("functionDeclarations".to_string(), Value::Array(emitted));
        }
        restore_current_source_siblings(&mut container, view, &container_path, &["functionDeclarations"])?;
        native.push(container);
    }

    for (wire_index, current_item) in current.iter().enumerate() {
        let destination = format!("chat.tools[{wire_index}]");
        if claimed_destinations.contains(&destination) {
            continue;
        }
        let projected = inverse_declaration(current_item, None, Some(GEMINI_TOOLS_TRANSFORM))?;
        if current_item.get("function").is_some() {
            native.push(json!({"functionDeclarations": [projected]}));
        } else {
            native.push(projected);
        }
    }

    Ok(DirectToolProjection {
        tools: Value::Array(native),
        declarations,
    })
}

fn declaration_for_source<'a>(
    view: &CurrentProjectionView<'a>,
    source_path: &str,
) -> Option<&'a ToolDeclarationReference> {
    view.inverse()
        .tool_declarations
        .iter()
        .find(|declaration| declaration.source_path == source_path)
}

fn declaration_reference(
    view: &CurrentProjectionView<'_>,
    declaration: &ToolDeclarationReference,
    mapping: &FieldMapping,
    destination_path: &str,
    emitted: &Value,
) -> Result<ToolMappingReference, String> {
    let identity = emitted
        .get("function")
        .or_else(|| emitted.get("custom"))
        .unwrap_or(emitted);
    let mut emitted_namespace = emitted.get("namespace").cloned();
    if emitted_namespace.is_none() {
        if let Some((parent_path, _)) = mapping.source_path.rsplit_once(".tools[") {
            if let Some(parent) = view.mapped_source_value(parent_path)? {
                if parent.get("type").and_then(Value::as_str) == Some("namespace") {
                    emitted_namespace = parent.get("name").cloned();
                }
            }
        }
    }
    Ok(ToolMappingReference {
        declaration_record_id: declaration.record_id.clone(),
        source_path: declaration.source_path.clone(),
        destination_path: destination_path.to_string(),
        emitted_kind: emitted
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or(&declaration.kind)
            .to_string(),
        emitted_name: identity
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string),
        emitted_namespace,
        encoding: declaration.encoding.clone(),
    })
}

fn mapping_for_destination<'a>(
    view: &CurrentProjectionView<'a>,
    destination: &str,
) -> Option<&'a FieldMapping> {
    view.inverse()
        .field_mappings
        .iter()
        .enumerate()
        .find(|(mapping_index, mapping)| {
            mapping.operator == TOOL_DECLARATION_OPERATOR
                && view.current_destination(*mapping_index) == Some(destination)
        })
        .map(|(_, mapping)| mapping)
}

fn original_value_for_source<'a>(
    view: &CurrentProjectionView<'a>,
    source_path: &str,
) -> Result<Option<&'a Value>, String> {
    let Some(reference) = view
        .inverse()
        .opaque_record_references
        .iter()
        .find(|reference| reference.path == source_path)
    else {
        return Ok(None);
    };
    view.opaque_value(reference)
}

fn gemini_container_paths(view: &CurrentProjectionView<'_>) -> Vec<(usize, String)> {
    let mut containers = std::collections::BTreeMap::<usize, String>::new();
    for reference in &view.inverse().opaque_record_references {
        if let Some(index) = top_level_tool_index(&reference.path) {
            containers
                .entry(index)
                .or_insert_with(|| reference.path.clone());
        }
    }
    for mapping in &view.inverse().field_mappings {
        if mapping.operator != TOOL_DECLARATION_OPERATOR {
            continue;
        }
        let Some(container) = gemini_container_path(&mapping.source_path) else {
            continue;
        };
        let Some(index) = top_level_tool_index(&container) else {
            continue;
        };
        containers
            .entry(index)
            .or_insert_with(|| container.to_string());
    }
    containers.into_iter().collect()
}

fn gemini_child_mapping_indices(
    view: &CurrentProjectionView<'_>,
    container_path: &str,
) -> Vec<usize> {
    let prefix = format!("{container_path}.functionDeclarations[");
    view.inverse()
        .field_mappings
        .iter()
        .enumerate()
        .filter_map(|(mapping_index, mapping)| {
            (mapping.operator == TOOL_DECLARATION_OPERATOR
                && mapping.source_path.starts_with(&prefix))
            .then_some(mapping_index)
        })
        .collect()
}

fn gemini_container_path(source_path: &str) -> Option<&str> {
    if top_level_tool_index(source_path).is_some() {
        return Some(source_path);
    }
    let (container, _) = source_path.split_once(".functionDeclarations[")?;
    top_level_tool_index(container)
        .is_some()
        .then_some(container)
}

fn top_level_tool_index(path: &str) -> Option<usize> {
    let rest = path.strip_prefix("request.tools[")?;
    let close = rest.find(']')?;
    if rest[close + 1..].is_empty() {
        rest[..close].parse().ok()
    } else {
        None
    }
}

fn wire_destination(destination: &str) -> Result<&str, String> {
    destination
        .strip_prefix("chat.")
        .ok_or_else(|| format!("tool destination `{destination}` is not canonical chat data"))
}

fn wire_order_key(path: &str) -> Vec<usize> {
    let mut order = Vec::new();
    let bytes = path.as_bytes();
    let mut cursor = 0;
    while cursor < bytes.len() {
        if bytes[cursor] != b'[' {
            cursor += 1;
            continue;
        }
        let start = cursor + 1;
        let mut end = start;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end > start {
            if let Ok(index) = path[start..end].parse::<usize>() {
                order.push(index);
            }
            cursor = end;
        } else {
            cursor += 1;
        }
    }
    order
}

fn inverse_declaration(
    current: &Value,
    original: Option<&Value>,
    transform_id: Option<&str>,
) -> Result<Value, String> {
    let Some(function) = current.get("function").and_then(Value::as_object) else {
        return Ok(current.clone());
    };
    let mut native = original
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let parameter_key = match transform_id {
        Some("v3.anthropic_tools_to_chat_tools.v1") => "input_schema",
        Some("v3.gemini_tools_to_chat_tools.v1") => {
            if native.contains_key("parametersJsonSchema") {
                "parametersJsonSchema"
            } else {
                "parameters"
            }
        }
        _ => return Err("inverse declaration requires a registered transform".to_string()),
    };
    replace_field(&mut native, "name", function.get("name"));
    replace_field(&mut native, "description", function.get("description"));
    replace_field(&mut native, parameter_key, function.get("parameters"));
    let copied_fields: &[&str] = match transform_id {
        Some("v3.anthropic_tools_to_chat_tools.v1") => {
            &["cache_control", "defer_loading", "strict"]
        }
        Some("v3.gemini_tools_to_chat_tools.v1") => &["response", "responseJsonSchema", "behavior"],
        _ => unreachable!("registered above"),
    };
    for key in copied_fields {
        replace_field(&mut native, key, function.get(*key));
    }
    Ok(Value::Object(native))
}

fn replace_field(target: &mut Map<String, Value>, key: &str, current: Option<&Value>) {
    match current {
        Some(value) => {
            target.insert(key.to_string(), value.clone());
        }
        None => {
            target.remove(key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::project_direct_tools;
    use crate::operation_runner::operators::current_projection_view::CurrentProjectionView;
    use crate::operation_runner::operators::field_operator_library::normalize_client_request;
    use crate::operation_runner::{CurrentFieldAssociations, RequestScopedContextPair};
    use serde_json::{json, Value};

    fn normalize(protocol: &str, raw: Value) -> (Value, RequestScopedContextPair) {
        let normalized = normalize_client_request(protocol, &raw).unwrap();
        let pair = RequestScopedContextPair::from_field_json(
            normalized.inverse_context,
            normalized.explicit_history_pairing,
        )
        .unwrap();
        (normalized.canonical_request, pair)
    }

    fn project(
        canonical: &Value,
        pair: &RequestScopedContextPair,
        transform: Option<&str>,
    ) -> super::DirectToolProjection {
        let associations = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
        project_direct_tools(
            &CurrentProjectionView::new(canonical, &pair.inverse_context, &associations),
            transform,
        )
        .unwrap()
    }

    #[test]
    fn lossless_namespace_tools_use_current_data_and_actual_emitted_identity() {
        let original = json!({"type":"namespace","name":"original","tools":[
            {"type":"function","name":"lookup","parameters":{"type":"object"}},
            {"type":"custom","name":"patch","format":{"type":"text"}}
        ]});
        let (mut canonical, pair) = normalize("responses", json!({"input":[],"tools":[original]}));
        canonical["tools"][0]["name"] = json!("changed");
        canonical["tools"][0]["tools"][1]["name"] = json!("changed_patch");
        let result = project(&canonical, &pair, None);
        assert_eq!(result.tools, canonical["tools"]);
        assert_eq!(result.declarations.len(), 3);
        let child = result
            .declarations
            .iter()
            .find(|mapping| mapping.source_path == "request.tools[0].tools[1]")
            .unwrap();
        assert_eq!(child.emitted_name.as_deref(), Some("changed_patch"));
        assert_eq!(child.emitted_kind, "custom");
        assert_eq!(child.emitted_namespace, Some(json!("changed")));
        assert_eq!(child.destination_path, "tools[0].tools[1]");
    }

    #[test]
    fn anthropic_inverse_reflects_mutations_and_preserves_unmapped_siblings() {
        let original = json!({"name":"lookup","description":"old","input_schema":{"type":"object"},"vendor":{"opaque":[null,1]},"cache_control":{"type":"ephemeral"}});
        let (mut canonical, pair) =
            normalize("anthropic", json!({"messages":[],"tools":[original]}));
        canonical["tools"][0]["function"]["name"] = json!("changed");
        canonical["tools"][0]["function"]["parameters"] =
            json!({"type":"object","properties":{"cmd":{"type":"string"}}});
        canonical["tools"][0]["function"]
            .as_object_mut()
            .unwrap()
            .remove("description");
        let result = project(
            &canonical,
            &pair,
            Some("v3.anthropic_tools_to_chat_tools.v1"),
        );
        assert_eq!(result.tools[0]["name"], "changed");
        assert_eq!(
            result.tools[0]["input_schema"],
            canonical["tools"][0]["function"]["parameters"]
        );
        assert!(result.tools[0].get("description").is_none());
        assert_eq!(result.tools[0]["vendor"], json!({"opaque":[null,1]}));
        assert_eq!(
            result.tools[0]["cache_control"],
            json!({"type":"ephemeral"})
        );
        assert_eq!(
            result.declarations[0].emitted_name.as_deref(),
            Some("changed")
        );
    }

    #[test]
    fn gemini_inverse_uses_flattening_associations_with_repeated_names() {
        let first = json!({"name":"same","parameters":{"type":"object","properties":{"q":{"type":"string"}}}});
        let second = json!({"name":"same","parametersJsonSchema":{"type":"object","properties":{"q":{"type":"integer"}}},"vendor":true});
        let raw = json!({"contents":[],"tools":[{"functionDeclarations":[first],"vendorContainer":1},{"functionDeclarations":[second]}]});
        let (mut canonical, pair) = normalize("gemini", raw);
        canonical["tools"][1]["function"]["name"] = json!("changed_second");
        canonical["tools"][1]["function"]["parameters"] =
            json!({"type":"object","properties":{"q":{"type":"boolean"}}});
        let result = project(&canonical, &pair, Some("v3.gemini_tools_to_chat_tools.v1"));
        assert_eq!(result.tools[0]["functionDeclarations"][0]["name"], "same");
        assert_eq!(
            result.tools[1]["functionDeclarations"][0]["name"],
            "changed_second"
        );
        assert_eq!(
            result.tools[1]["functionDeclarations"][0]["parametersJsonSchema"],
            canonical["tools"][1]["function"]["parameters"]
        );
        assert!(result.tools[1]["functionDeclarations"][0]
            .get("parameters")
            .is_none());
        assert_eq!(result.tools[1]["functionDeclarations"][0]["vendor"], true);
        assert_eq!(result.tools[0]["vendorContainer"], 1);
        assert_ne!(
            result.declarations[0].declaration_record_id,
            result.declarations[1].declaration_record_id
        );
        assert_eq!(
            result.declarations[1].destination_path,
            "tools[1].functionDeclarations[0]"
        );
    }

    #[test]
    fn gemini_empty_and_builtin_containers_remain_data_without_callable_aliases() {
        let tools = json!([{"functionDeclarations":[],"vendor":true},{"googleSearch":{}},{"codeExecution":{}}]);
        let (canonical, pair) = normalize("gemini", json!({"contents":[],"tools":tools.clone()}));
        let result = project(&canonical, &pair, Some("v3.gemini_tools_to_chat_tools.v1"));
        assert_eq!(result.tools, tools);
        assert_eq!(result.declarations.len(), 2);
        for (mapping, kind, destination) in [
            (&result.declarations[0], "googleSearch", "tools[1]"),
            (&result.declarations[1], "codeExecution", "tools[2]"),
        ] {
            assert_eq!(mapping.emitted_kind, kind);
            assert_eq!(mapping.destination_path, destination);
            assert!(mapping.emitted_name.is_none());
            assert!(mapping.emitted_namespace.is_none());
            assert!(pair.inverse_context.tool_declarations.iter().any(|declaration|
                declaration.record_id == mapping.declaration_record_id && declaration.kind == kind));
        }
    }

    #[test]
    fn opaque_anthropic_declaration_items_are_preserved() {
        let tools = json!([null,"opaque",{"name":"lookup","input_schema":{"type":"object"}}]);
        let (canonical, pair) =
            normalize("anthropic", json!({"messages":[],"tools":tools.clone()}));
        let result = project(
            &canonical,
            &pair,
            Some("v3.anthropic_tools_to_chat_tools.v1"),
        );
        assert_eq!(result.tools, tools);
    }
}

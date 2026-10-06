use serde_json::{Map, Value};

use super::current_projection_view::CurrentProjectionView;
use super::field_operator_helpers::map_part_type;
use super::hosted_history_projection::hosted_anchor_mapping_index;
use super::project_canonical_instructions::project_instruction_source;
use super::project_canonical_paths::{direct_child_key, field_path, read_path, write_path};
use crate::operation_runner::{
    ExplicitHistoryPairing, HistoryPairingReference, RequestInverseContext,
};

const ARRAY_CONTAINER_OPERATOR: &str = "routecodex.v3.field.array_container_shape@1";
const RESPONSES_INPUT_OPERATOR: &str = "routecodex.v3.field.request_input_shape_branch@1";
const OPENAI_CHAT_MESSAGES_TRANSFORM: &str = "v3.openai_chat_messages_to_chat_messages.v1";
const RESPONSES_INSTRUCTIONS_TRANSFORM: &str = "v3.responses.instructions_to_chat_system.v1";
const CANONICAL_MESSAGES: &str = "messages";

/// Reverse the registered history and instruction transforms that produced the
/// current canonical `chat.messages`. Only inverse history/instruction fields
/// are returned; scalar fields and tool declarations stay with their owners.
///
/// Each source item is located through the association recorded when
/// normalization emitted it, never by zipping raw arrays onto canonical arrays
/// or by searching for a role. Business values are read from the current
/// canonical data; typed references carry identity (kind, namespace presence,
/// source paths) only.
pub(super) fn project_direct_history(
    view: &CurrentProjectionView<'_>,
    history: &ExplicitHistoryPairing,
) -> Result<Value, String> {
    let mut output = Map::new();
    if view.canonical().get(CANONICAL_MESSAGES).is_none() {
        return Ok(Value::Object(output));
    }
    for root in history_roots(view.inverse()) {
        let key = request_key(&root.source_path)?;
        match &root.transform {
            HistoryTransform::OpenAiChatMessages => {
                let value = project_chat_messages(view, &root.source_path)?;
                output.insert(key, value);
            }
            HistoryTransform::ResponsesInput => {
                let value = project_responses_input(view, history, &root.source_path)?;
                output.insert(key, value);
            }
            HistoryTransform::ResponsesInstructions => {
                if let Some(value) = project_responses_instructions(view, &root.source_path)? {
                    output.insert(key, value);
                }
            }
        }
    }
    Ok(Value::Object(output))
}

enum HistoryTransform {
    OpenAiChatMessages,
    ResponsesInput,
    ResponsesInstructions,
}

struct HistoryRoot {
    source_path: String,
    transform: HistoryTransform,
}

/// Concrete source containers that own canonical `chat.messages` contributions.
/// A row is a root only when its own registered operator/transform identity
/// declares it, never because of its protocol or field spelling.
fn history_roots(inverse: &RequestInverseContext) -> Vec<HistoryRoot> {
    let mut roots: Vec<HistoryRoot> = Vec::new();
    for mapping in &inverse.field_mappings {
        if mapping.source_path.contains('[') {
            continue;
        }
        let transform = match mapping.transform_id.as_deref() {
            Some(OPENAI_CHAT_MESSAGES_TRANSFORM) => HistoryTransform::OpenAiChatMessages,
            Some(RESPONSES_INSTRUCTIONS_TRANSFORM) => HistoryTransform::ResponsesInstructions,
            None if mapping.operator == RESPONSES_INPUT_OPERATOR => {
                HistoryTransform::ResponsesInput
            }
            Some(_) | None => continue,
        };
        if !roots
            .iter()
            .any(|root| root.source_path == mapping.source_path)
        {
            roots.push(HistoryRoot {
                source_path: mapping.source_path.clone(),
                transform,
            });
        }
    }
    roots
}

struct HistoryItem {
    source_path: String,
    order: Option<usize>,
    canonical_index: usize,
}

/// Every canonical message records the source item that emitted it. An item
/// whose source path equals its container is the scalar (non-array) branch.
fn history_items(view: &CurrentProjectionView<'_>, root: &str) -> Vec<HistoryItem> {
    let mut items = Vec::new();
    for (mapping_index, mapping) in view.inverse().field_mappings.iter().enumerate() {
        if mapping.operator != ARRAY_CONTAINER_OPERATOR {
            continue;
        }
        let Some(destination) = view.current_destination(mapping_index) else {
            continue;
        };
        let Some(canonical_index) = canonical_message_index(destination) else {
            continue;
        };
        let order = if mapping.source_path == root {
            None
        } else if let Some(order) = direct_item_index(&mapping.source_path, root) {
            Some(order)
        } else {
            continue;
        };
        items.push(HistoryItem {
            source_path: mapping.source_path.clone(),
            order,
            canonical_index,
        });
    }
    items.sort_by_key(|item| (item.canonical_index, item.order));
    items
}

fn project_chat_messages(view: &CurrentProjectionView<'_>, root: &str) -> Result<Value, String> {
    let canonical = view.canonical();
    let items = history_items(view, root);
    if items.is_empty() {
        return view.empty_history_container(root);
    }
    if items.len() == 1 && items[0].order.is_none() {
        return Ok(canonical_message(canonical, items[0].canonical_index)
            .and_then(|message| message.get("content"))
            .cloned()
            .unwrap_or(Value::Null));
    }
    let mut messages = Vec::new();
    for item in &items {
        let Some(message) = canonical_message(canonical, item.canonical_index) else {
            continue;
        };
        let mut projected = message_with_source_content(message, view, &item.source_path)?;
        restore_opaque_siblings(&mut projected, view, &item.source_path)?;
        messages.push(projected);
    }
    Ok(Value::Array(messages))
}

fn project_responses_input(
    view: &CurrentProjectionView<'_>,
    history: &ExplicitHistoryPairing,
    root: &str,
) -> Result<Value, String> {
    let canonical = view.canonical();
    let items = history_items(view, root);
    // A scalar/object Responses input records its association at the container
    // path itself. That item is one source history even when a configured fold
    // aliases it with `messages`, so the original non-array shape is preserved.
    if let Some(scalar) = items.iter().find(|item| item.order.is_none()) {
        return Ok(canonical_message(canonical, scalar.canonical_index)
            .and_then(|message| message.get("content"))
            .cloned()
            .unwrap_or(Value::Null));
    }
    let mut input = Vec::new();
    for item in items.iter().filter(|item| item.order.is_some()) {
        let Some(message) = canonical_message(canonical, item.canonical_index) else {
            continue;
        };
        // A registered hosted-history anchor reads its single current native
        // event through the recorded source/current association. The original
        // opaque source value is never replayed, and a removed anchor emits no
        // event because its current mapping no longer resolves.
        if let Some(mapping_index) =
            hosted_anchor_mapping_index(view.inverse(), &item.source_path)?
        {
            if let Some(event) = view.read_mapping(mapping_index)? {
                input.push(event.clone());
            }
            continue;
        }
        input.push(project_responses_item(
            message,
            &item.source_path,
            view,
            history,
        )?);
    }
    Ok(Value::Array(input))
}

/// The Responses item type lives in the typed history pairing; the canonical
/// message alone cannot distinguish a function result from a custom result.
fn project_responses_item(
    message: &Value,
    item_path: &str,
    view: &CurrentProjectionView<'_>,
    history: &ExplicitHistoryPairing,
) -> Result<Value, String> {
    // A non-object input item is identified by its exact whole-item opaque
    // reference. The current canonical content is the business value; the
    // recorded scalar is only a source discriminator, never the replay value.
    if view
        .source_value(item_path)?
        .is_some_and(|source| !source.is_object())
    {
        return Ok(message.get("content").cloned().unwrap_or(Value::Null));
    }
    let pairing = history
        .messages
        .iter()
        .find(|pairing| pairing.source_path == item_path);
    match pairing.map(|pairing| pairing.kind.as_str()) {
        Some("function") => project_call_item(
            pairing.expect("matched history pairing"),
            "function_call",
            "function",
            "arguments",
            view,
            item_path,
        ),
        Some("custom") => project_call_item(
            pairing.expect("matched history pairing"),
            "custom_tool_call",
            "custom",
            "input",
            view,
            item_path,
        ),
        Some(kind) if kind.ends_with("_output") => {
            project_output_item(message, kind, view, item_path)
        }
        _ => project_message_item(message, view, item_path),
    }
}

fn project_call_item(
    pairing: &HistoryPairingReference,
    type_value: &str,
    kind_key: &str,
    payload_key: &str,
    view: &CurrentProjectionView<'_>,
    item_path: &str,
) -> Result<Value, String> {
    let mut item = Map::new();
    item.insert("type".to_string(), Value::String(type_value.to_string()));
    if let Some(call_id) = view.mapped_source_value(&field_path(item_path, "call_id"))? {
        item.insert("call_id".to_string(), call_id.clone());
    }
    if let Some(name) = view.mapped_source_value(&field_path(item_path, "name"))? {
        let name = match name.as_str() {
            Some(name) => Value::String(reverse_structural_name(
                kind_key,
                name,
                pairing.namespace.as_ref(),
            )),
            None => name.clone(),
        };
        item.insert("name".to_string(), name);
    }
    if let Some(value) = view.mapped_source_value(&field_path(item_path, payload_key))? {
        item.insert(payload_key.to_string(), value.clone());
    }
    // Namespace presence (missing/null/string) is typed reference identity, not
    // a canonical business value; it is replayed exactly as recorded.
    if let Some(namespace) = &pairing.namespace {
        item.insert("namespace".to_string(), namespace.clone());
    }
    let mut item = Value::Object(item);
    restore_opaque_siblings(&mut item, view, item_path)?;
    Ok(item)
}

fn project_output_item(
    message: &Value,
    type_value: &str,
    view: &CurrentProjectionView<'_>,
    item_path: &str,
) -> Result<Value, String> {
    let mut item = Map::new();
    item.insert("type".to_string(), Value::String(type_value.to_string()));
    if let Some(call_id) = message.get("tool_call_id") {
        item.insert("call_id".to_string(), call_id.clone());
    }
    if let Some(output) = message.get("content") {
        item.insert("output".to_string(), output.clone());
    }
    // Identity, status and unknown siblings are read from the mapped current
    // association only. A typed Remove drops the field, and a typed Replace
    // carries the new value; the original opaque source never refills them.
    for (source_key, item_key) in [("id", "id"), ("status", "status")] {
        if let Some(value) = view.mapped_source_value(&field_path(item_path, source_key))? {
            item.insert(item_key.to_string(), value.clone());
        }
    }
    if let Some(name) = view.mapped_source_value(&field_path(item_path, "name"))? {
        item.insert("name".to_string(), name.clone());
    }
    if let Some(namespace) = view.mapped_source_value(&field_path(item_path, "namespace"))? {
        item.insert("namespace".to_string(), namespace.clone());
    }
    for mapping_index in 0..view.inverse().field_mappings.len() {
        let Some(key) = output_extra_field_key(view, mapping_index, item_path)? else {
            continue;
        };
        if let Some(value) = view.read_mapping(mapping_index)? {
            item.insert(key, value.clone());
        }
    }
    let mut item = Value::Object(item);
    restore_opaque_siblings(&mut item, view, item_path)?;
    Ok(item)
}

/// Canonical carrier for Responses tool-result members that have no standard
/// Chat destination. Only members whose real mapping targets this carrier are
/// replayed, and only from the current association.
const OUTPUT_EXTRA_FIELDS_CARRIER: &str =
    ".routecodex_chat_extension.responses_tool_output_extra_fields";

const OUTPUT_ITEM_KNOWN_KEYS: [&str; 7] = [
    "type", "output", "call_id", "name", "namespace", "id", "status",
];

/// Resolve one unmapped output sibling's key through its registered current
/// destination. Structural parsing keeps dotted/bracketed keys exact.
fn output_extra_field_key(
    view: &CurrentProjectionView<'_>,
    mapping_index: usize,
    item_path: &str,
) -> Result<Option<String>, String> {
    let mapping = &view.inverse().field_mappings[mapping_index];
    if !mapping.destination.contains(OUTPUT_EXTRA_FIELDS_CARRIER) {
        return Ok(None);
    }
    let Some(key) = direct_child_key(&mapping.source_path, item_path)? else {
        return Ok(None);
    };
    if OUTPUT_ITEM_KNOWN_KEYS.contains(&key.as_str()) {
        return Ok(None);
    }
    Ok(Some(key))
}

fn project_message_item(
    message: &Value,
    view: &CurrentProjectionView<'_>,
    item_path: &str,
) -> Result<Value, String> {
    let mut item = message_with_source_content(message, view, item_path)?;
    if let Some(content) = item.get("content").cloned() {
        if let Some(object) = item.as_object_mut() {
            let source_path = field_path(item_path, "content");
            let projected = match source_content_parts(view, &source_path)? {
                Some(parts) => Value::Array(
                    parts
                        .into_iter()
                        .map(|(source, part)| reverse_responses_content_part(&part, view, &source))
                        .collect::<Result<Vec<_>, _>>()?,
                ),
                None => reverse_responses_content(&content, view, &source_path)?,
            };
            object.insert("content".to_string(), projected);
        }
    }
    restore_item_presence(&mut item, view.inverse(), item_path);
    restore_opaque_siblings(&mut item, view, item_path)?;
    reverse_responses_content_part(&item, view, item_path)
}

/// A shared canonical system message can contain several independent source
/// contributions. Read this history's concrete content edge before restoring
/// its native shape, so instruction prefixes never become history content.
fn message_with_source_content(
    message: &Value,
    view: &CurrentProjectionView<'_>,
    item_path: &str,
) -> Result<Value, String> {
    let mut projected = message.clone();
    let source_path = field_path(item_path, "content");
    if let Some(parts) = source_content_parts(view, &source_path)? {
        if let Some(object) = projected.as_object_mut() {
            object.insert(
                "content".into(),
                Value::Array(parts.into_iter().map(|(_, part)| part).collect()),
            );
        }
    } else if let Some(mapping_index) = view.mapping_index_for_source(&source_path) {
        if let Some(object) = projected.as_object_mut() {
            match view.read_mapping(mapping_index)? {
                Some(content) => {
                    object.insert("content".into(), content.clone());
                }
                None => {
                    object.remove("content");
                }
            }
        }
    }
    Ok(projected)
}

/// Use the whole-part edges recorded by the content emitter. A shared system
/// array contains synthetic instruction parts too; only this source's actual
/// edges belong to its history. Missing current parts stay absent.
fn source_content_parts(
    view: &CurrentProjectionView<'_>,
    source_path: &str,
) -> Result<Option<Vec<(String, Value)>>, String> {
    if !view.source_value(source_path)?.is_some_and(Value::is_array) {
        return Ok(None);
    }
    let mut mappings = view
        .inverse()
        .field_mappings
        .iter()
        .enumerate()
        .filter_map(|(mapping_index, mapping)| {
            direct_item_index(&mapping.source_path, source_path)
                .map(|index| (mapping_index, index, mapping))
        })
        .collect::<Vec<_>>();
    mappings.sort_by_key(|(mapping_index, index, _)| {
        let destination_order = view
            .current_destination(*mapping_index)
            .and_then(canonical_message_index)
            .unwrap_or(usize::MAX);
        (destination_order, *index)
    });
    let mut parts = Vec::new();
    for (mapping_index, _, mapping) in mappings {
        if let Some(current) = view.read_mapping(mapping_index)? {
            parts.push((mapping.source_path.clone(), current.clone()));
        }
    }
    Ok(Some(parts))
}

fn project_responses_instructions(
    view: &CurrentProjectionView<'_>,
    root: &str,
) -> Result<Option<Value>, String> {
    project_instruction_source(view, root)
}

/// Replay unmapped sibling values from their canonical opaque records. A value
/// the current canonical already carries is never overwritten.
fn restore_opaque_siblings(
    item: &mut Value,
    view: &CurrentProjectionView<'_>,
    item_path: &str,
) -> Result<(), String> {
    for reference in &view.inverse().opaque_record_references {
        let Some(suffix) = reference.path.strip_prefix(item_path) else {
            continue;
        };
        if suffix.is_empty()
            || (!suffix.starts_with('.') && !suffix.starts_with('['))
            || source_has_mapping(view.inverse(), &reference.path)
        {
            continue;
        }
        let Some(value) = view.opaque_value(reference)? else {
            continue;
        };
        let relative = suffix.strip_prefix('.').unwrap_or(suffix);
        if read_path(item, relative)?.is_some() {
            continue;
        }
        write_path(item, relative, value.clone())?;
    }
    Ok(())
}

fn restore_item_presence(item: &mut Value, inverse: &RequestInverseContext, item_path: &str) {
    let Some(object) = item.as_object_mut() else {
        return;
    };
    for key in ["role", "type"] {
        let source_path = field_path(item_path, key);
        if !inverse
            .field_mappings
            .iter()
            .any(|mapping| mapping.source_path == source_path)
        {
            object.remove(key);
        }
    }
}

fn source_has_mapping(inverse: &RequestInverseContext, source_path: &str) -> bool {
    inverse.field_mappings.iter().any(|mapping| {
        mapping.source_path == source_path
            || mapping
                .source_path
                .strip_prefix(source_path)
                .is_some_and(|suffix| suffix.starts_with('.') || suffix.starts_with('['))
    })
}

/// Reverse the declared structural name encoding only. Command, patch and MCP
/// payloads are never inspected.
fn reverse_structural_name(kind: &str, name: &str, namespace: Option<&Value>) -> String {
    let Some(namespace) = namespace.and_then(Value::as_str) else {
        return name.to_string();
    };
    let namespace = namespace.trim();
    if namespace.is_empty() {
        return name.to_string();
    }
    let prefix = match kind {
        "custom" => format!("{namespace}."),
        _ => format!("{namespace}__"),
    };
    name.strip_prefix(&prefix)
        .map(str::to_string)
        .unwrap_or_else(|| name.to_string())
}

fn reverse_responses_content(
    content: &Value,
    view: &CurrentProjectionView<'_>,
    source_path: &str,
) -> Result<Value, String> {
    match content {
        Value::Array(parts) => Ok(Value::Array(
            parts
                .iter()
                .enumerate()
                .map(|(index, part)| {
                    reverse_responses_content_part(part, view, &format!("{source_path}[{index}]"))
                })
                .collect::<Result<Vec<_>, _>>()?,
        )),
        other => Ok(other.clone()),
    }
}

fn reverse_responses_content_part(
    part: &Value,
    view: &CurrentProjectionView<'_>,
    source_path: &str,
) -> Result<Value, String> {
    let Some(object) = part.as_object() else {
        return Ok(part.clone());
    };
    let mut reversed = object.clone();
    let original = view.source_value(source_path)?;
    if let Some(kind) = object.get("type").and_then(Value::as_str) {
        let original_kind = original.and_then(|source| source.get("type"));
        let forward_kind = match original_kind.and_then(Value::as_str) {
            Some("input_image" | "image_url") => Value::String("image_url".into()),
            _ => original_kind.map(map_part_type).unwrap_or(Value::Null),
        };
        if forward_kind == object["type"] {
            if let Some(original_kind) = original_kind {
                reversed.insert("type".into(), original_kind.clone());
            }
        } else if let Some(raw) = responses_input_part_type(kind) {
            reversed.insert("type".to_string(), Value::String(raw.to_string()));
        }
    }
    if matches!(
        original
            .and_then(|source| source.get("type"))
            .and_then(Value::as_str),
        Some("input_image" | "image_url")
    ) && object.get("type").and_then(Value::as_str) == Some("image_url")
    {
        let original = original.expect("matched source media shape");
        reversed.remove("image_url");
        for key in ["image_url", "url", "detail"] {
            if original.get(key).is_none() {
                continue;
            }
            let path = field_path(source_path, key);
            if view.mapping_index_for_source(&path).is_some() {
                if let Some(current) = view.mapped_source_value(&path)? {
                    let mut current = current.clone();
                    if original[key].is_object()
                        && original[key].get("detail").is_none()
                        && original.get("detail").is_some()
                    {
                        if let Some(image) = current.as_object_mut() {
                            image.remove("detail");
                        }
                    }
                    reversed.insert(key.into(), current);
                }
            } else if let Some(current) = view.source_value(&path)? {
                reversed.insert(key.into(), current.clone());
            }
        }
    }
    let mut output = Value::Object(reversed);
    restore_opaque_siblings(&mut output, view, source_path)?;
    Ok(output)
}

/// The declared `part_type_value_map@1` encoding for Responses text parts.
///
/// Original text aliases are recovered from the source representation above.
/// This default applies to a current canonical text type changed by its owner.
fn responses_input_part_type(kind: &str) -> Option<&'static str> {
    match kind {
        "text" => Some("input_text"),
        _ => None,
    }
}

fn canonical_message(canonical: &Value, index: usize) -> Option<&Value> {
    canonical.get(CANONICAL_MESSAGES)?.as_array()?.get(index)
}

fn canonical_message_index(destination: &str) -> Option<usize> {
    let inner = destination
        .strip_prefix("chat.messages[")?
        .strip_suffix(']')?;
    decimal_index(inner)
}

fn direct_item_index(path: &str, root: &str) -> Option<usize> {
    let inner = path
        .strip_prefix(root)?
        .strip_prefix('[')?
        .strip_suffix(']')?;
    decimal_index(inner)
}

fn decimal_index(text: &str) -> Option<usize> {
    if text.is_empty()
        || !text.bytes().all(|byte| byte.is_ascii_digit())
        || (text.starts_with('0') && text.len() > 1)
    {
        return None;
    }
    text.parse().ok()
}

fn request_key(path: &str) -> Result<String, String> {
    path.strip_prefix("request.")
        .filter(|key| !key.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("history source `{path}` is not a concrete request field"))
}

#[cfg(test)]
mod tests {
    use super::project_direct_history;
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

    fn project(canonical: &Value, pair: &RequestScopedContextPair) -> Value {
        let associations = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
        project_direct_history(
            &CurrentProjectionView::new(canonical, &pair.inverse_context, &associations),
            &pair.explicit_history_pairing,
        )
        .unwrap()
    }

    #[test]
    fn chat_history_reads_current_canonical_content() {
        let (mut canonical, pair) = normalize(
            "openai-chat",
            json!({"messages":[
                {"role":"user","content":"old"},
                {"role":"assistant","content":"kept"}
            ]}),
        );
        canonical["messages"][0]["content"] = json!("new");

        assert_eq!(
            project(&canonical, &pair),
            json!({"messages":[
                {"role":"user","content":"new"},
                {"role":"assistant","content":"kept"}
            ]})
        );
    }

    #[test]
    fn chat_history_deleted_content_stays_deleted() {
        let (mut canonical, pair) = normalize(
            "openai-chat",
            json!({"messages":[{"role":"user","content":"old"}]}),
        );
        canonical["messages"][0]
            .as_object_mut()
            .unwrap()
            .remove("content");

        assert_eq!(
            project(&canonical, &pair),
            json!({"messages":[{"role":"user"}]})
        );
    }

    #[test]
    fn chat_history_keeps_unmapped_siblings() {
        let (canonical, pair) = normalize(
            "openai-chat",
            json!({"messages":[{"role":"user","content":"hi","vendor":{"opaque":[null,1]}}]}),
        );

        assert_eq!(
            project(&canonical, &pair),
            json!({"messages":[{"role":"user","content":"hi","vendor":{"opaque":[null,1]}}]})
        );
    }

    #[test]
    fn responses_input_string_shape_is_preserved() {
        let (mut canonical, pair) =
            normalize("responses", json!({"model":"client-model","input":"hello"}));

        assert_eq!(project(&canonical, &pair), json!({"input":"hello"}));

        canonical["messages"][0]["content"] = json!("changed");
        assert_eq!(project(&canonical, &pair), json!({"input":"changed"}));
    }

    #[test]
    fn responses_input_null_and_absence_are_preserved() {
        let (canonical, pair) = normalize("responses", json!({"model":"client-model"}));
        assert_eq!(project(&canonical, &pair), json!({}));

        let (canonical, pair) =
            normalize("responses", json!({"model":"client-model","input":null}));
        assert_eq!(project(&canonical, &pair), json!({"input":null}));
    }

    #[test]
    fn responses_scalar_input_survives_equivalence_fold_with_messages() {
        let (canonical, pair) = normalize(
            "responses",
            json!({
                "model":"client-model",
                "messages":[{"role":"user","content":"hi"}],
                "input":"hi"
            }),
        );
        assert_eq!(
            project(&canonical, &pair),
            json!({
                "messages":[{"role":"user","content":"hi"}],
                "input":"hi"
            })
        );
    }

    #[test]
    fn responses_deleted_canonical_message_drops_its_source_item() {
        let (mut canonical, pair) = normalize(
            "responses",
            json!({"model":"client-model","input":[
                {"type":"message","role":"user","content":"first"},
                {"type":"message","role":"user","content":"second"}
            ]}),
        );
        canonical["messages"].as_array_mut().unwrap().remove(0);

        assert_eq!(
            project(&canonical, &pair),
            json!({"input":[{"type":"message","role":"user","content":"second"}]})
        );
    }

    #[test]
    fn chat_history_keeps_multiple_calls_in_one_assistant_message() {
        let (canonical, pair) = normalize(
            "openai-chat",
            json!({"messages":[{
                "role":"assistant",
                "content":null,
                "tool_calls":[
                    {"id":"call_read","type":"function",
                     "function":{"name":"read","arguments":"{\"path\":\"a.rs\"}"}},
                    {"id":"call_patch","type":"custom",
                     "custom":{"name":"apply_patch","input":"*** Begin Patch\n*** End Patch"}}
                ]
            }]}),
        );

        let projected = project(&canonical, &pair);
        let calls = projected["messages"][0]["tool_calls"].as_array().unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0]["id"], "call_read");
        assert_eq!(calls[0]["function"]["arguments"], "{\"path\":\"a.rs\"}");
        assert_eq!(calls[1]["id"], "call_patch");
        assert_eq!(
            calls[1]["custom"]["input"],
            "*** Begin Patch\n*** End Patch"
        );
    }

    #[test]
    fn responses_function_call_keeps_complete_arguments_and_namespace() {
        let arguments = format!("{}{}", "x".repeat(70_000), "REQ02_EXEC_TAIL");
        let (canonical, pair) = normalize(
            "responses",
            json!({"model":"client-model","input":[{
                "type":"function_call",
                "call_id":"call_exec",
                "name":"exec",
                "namespace":"mcp",
                "arguments":arguments
            }]}),
        );

        assert_eq!(
            project(&canonical, &pair),
            json!({"input":[{
                "type":"function_call",
                "call_id":"call_exec",
                "name":"exec",
                "namespace":"mcp",
                "arguments":arguments
            }]})
        );
    }

    #[test]
    fn responses_function_call_output_keeps_complete_result_and_siblings() {
        let result = format!("first line\r\nsecond line\r\n{}", "r".repeat(4_096));
        let (canonical, pair) = normalize(
            "responses",
            json!({"model":"client-model","input":[{
                "type":"function_call_output",
                "call_id":"call_exec",
                "output":result,
                "id":"item_result",
                "status":"completed"
            }]}),
        );

        assert_eq!(
            project(&canonical, &pair),
            json!({"input":[{
                "type":"function_call_output",
                "call_id":"call_exec",
                "output":result,
                "id":"item_result",
                "status":"completed"
            }]})
        );
    }

    #[test]
    fn responses_custom_tool_call_keeps_multiline_patch_input() {
        let patch =
            "*** Begin Patch\n*** Update File: a.rs\n+literal bytes\n*** End Patch\n".repeat(1_500);
        let (canonical, pair) = normalize(
            "responses",
            json!({"model":"client-model","input":[{
                "type":"custom_tool_call",
                "call_id":"call_patch",
                "name":"apply_patch",
                "input":patch
            }]}),
        );

        assert_eq!(
            project(&canonical, &pair),
            json!({"input":[{
                "type":"custom_tool_call",
                "call_id":"call_patch",
                "name":"apply_patch",
                "input":patch
            }]})
        );
    }

    #[test]
    fn responses_custom_tool_call_output_keeps_mcp_object_result() {
        let (canonical, pair) = normalize(
            "responses",
            json!({"model":"client-model","input":[{
                "type":"custom_tool_call_output",
                "call_id":"call_mcp",
                "output":{"content":[{"type":"text","text":"ok"}],"isError":false}
            }]}),
        );

        assert_eq!(
            project(&canonical, &pair),
            json!({"input":[{
                "type":"custom_tool_call_output",
                "call_id":"call_mcp",
                "output":{"content":[{"type":"text","text":"ok"}],"isError":false}
            }]})
        );
    }

    #[test]
    fn responses_message_item_reverses_text_part_encoding() {
        let (canonical, pair) = normalize(
            "responses",
            json!({"model":"client-model","input":[{
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text":"a"},{"type":"input_text","text":"b"}]
            }]}),
        );

        assert_eq!(
            project(&canonical, &pair),
            json!({"input":[{
                "type":"message",
                "role":"user",
                "content":[{"type":"input_text","text":"a"},{"type":"input_text","text":"b"}]
            }]})
        );
    }

    #[test]
    fn responses_nonobject_items_use_current_canonical_content() {
        let (mut canonical, pair) = normalize(
            "responses",
            json!({"model":"client-model","input":[
                null,
                "scalar",
                42,
                {"role":"user","content":"object"}
            ]}),
        );
        canonical["messages"][0]["content"] = json!("changed-null");
        canonical["messages"][1]["content"] = json!("changed-scalar");
        canonical["messages"][2]["content"] = json!("changed-number");
        canonical["messages"][3]["content"] = json!("changed-object");

        assert_eq!(
            project(&canonical, &pair),
            json!({"input":[
                "changed-null",
                "changed-scalar",
                "changed-number",
                {"role":"user","content":"changed-object"}
            ]})
        );
    }

    #[test]
    fn responses_item_role_and_type_presence_follow_source_mappings() {
        let (canonical, pair) = normalize(
            "responses",
            json!({"model":"client-model","input":[
                {"type":"reasoning","content":"thought"},
                {"role":"user","content":"no type"},
                {"type":"message","content":"no role"},
                {"type":"message","role":"assistant","content":"both"}
            ]}),
        );

        let projected = project(&canonical, &pair);
        let items = projected["input"].as_array().expect("input items");
        assert_eq!(items[0]["type"], "reasoning");
        assert!(items[0].get("role").is_none());
        assert_eq!(items[1]["role"], "user");
        assert!(items[1].get("type").is_none());
        assert_eq!(items[2]["type"], "message");
        assert!(items[2].get("role").is_none());
        assert_eq!(items[3]["type"], "message");
        assert_eq!(items[3]["role"], "assistant");
    }

    #[test]
    fn responses_folded_input_calls_use_concrete_leaf_destinations() {
        let (mut canonical, pair) = normalize(
            "responses",
            json!({
                "model":"client-model",
                "messages":[
                    {
                        "role":"assistant",
                        "content":null,
                        "tool_calls":[{
                            "id":"old-call-0",
                            "type":"function",
                            "function":{"name":"old-name-0","arguments":"old-args-0"}
                        }]
                    },
                    {
                        "role":"assistant",
                        "content":null,
                        "tool_calls":[{
                            "id":"old-call-1",
                            "type":"function",
                            "function":{"name":"old-name-1","arguments":"old-args-1"}
                        }]
                    }
                ],
                "input":[
                    {
                        "type":"function_call",
                        "call_id":"old-call-0",
                        "name":"old-name-0",
                        "arguments":"old-args-0"
                    },
                    {
                        "type":"function_call",
                        "call_id":"old-call-1",
                        "name":"old-name-1",
                        "arguments":"old-args-1"
                    }
                ]
            }),
        );
        canonical["messages"][0]["tool_calls"] = json!([
            {
                "id":"new-call-0",
                "type":"function",
                "function":{"name":"new-name-0","arguments":"new-args-0"}
            },
            {
                "id":"old-call-0",
                "type":"function",
                "function":{"name":"old-name-0","arguments":"old-args-0"}
            }
        ]);
        canonical["messages"][1]["tool_calls"] = json!([
            {
                "id":"new-call-1",
                "type":"function",
                "function":{"name":"new-name-1","arguments":"new-args-1"}
            },
            {
                "id":"old-call-1",
                "type":"function",
                "function":{"name":"old-name-1","arguments":"old-args-1"}
            }
        ]);

        let projected = project(&canonical, &pair);
        assert_eq!(
            projected["input"],
            json!([
                {
                    "type":"function_call",
                    "call_id":"new-call-0",
                    "name":"new-name-0",
                    "arguments":"new-args-0"
                },
                {
                    "type":"function_call",
                    "call_id":"new-call-1",
                    "name":"new-name-1",
                    "arguments":"new-args-1"
                }
            ])
        );
    }

    #[test]
    fn copied_message_and_part_siblings_follow_current_canonical_and_deletion() {
        let (mut canonical, pair) = normalize(
            "openai-chat",
            json!({"messages":[{
                "role":"user",
                "content":[{
                    "type":"text",
                    "text":"hi",
                    "part_plain":"old-part",
                    "part.copy":"old-part-dot",
                    "part[0]":"old-part-bracket"
                }],
                "message_plain":"old-message",
                "message.copy":"old-message-dot",
                "message[0]":"old-message-bracket"
            }]}),
        );
        let message = canonical["messages"][0]
            .as_object_mut()
            .expect("canonical message");
        message.remove("message_plain");
        message.insert("message.copy".to_string(), json!("new-message-dot"));
        message.insert("message[0]".to_string(), json!("new-message-bracket"));
        let part = message["content"][0]
            .as_object_mut()
            .expect("canonical content part");
        part.remove("part_plain");
        part.insert("part.copy".to_string(), json!("new-part-dot"));
        part.insert("part[0]".to_string(), json!("new-part-bracket"));

        assert_eq!(
            project(&canonical, &pair),
            json!({"messages":[{
                "role":"user",
                "content":[{
                    "type":"text",
                    "text":"hi",
                    "part.copy":"new-part-dot",
                    "part[0]":"new-part-bracket"
                }],
                "message.copy":"new-message-dot",
                "message[0]":"new-message-bracket"
            }]})
        );
    }

    #[test]
    fn responses_mixed_sources_use_their_concrete_associations() {
        let (canonical, pair) = normalize(
            "responses",
            json!({
                "model":"client-model",
                "messages":[{
                    "role":"assistant",
                    "content":"",
                    "tool_calls":[{
                        "id":"call_exec",
                        "type":"function",
                        "function":{"name":"exec","arguments":"cmd"}
                    }]
                }],
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_exec",
                    "output":"result"
                }]
            }),
        );

        assert_eq!(
            project(&canonical, &pair),
            json!({
                "messages":[{
                    "role":"assistant",
                    "content":"",
                    "tool_calls":[{
                        "id":"call_exec",
                        "type":"function",
                        "function":{"name":"exec","arguments":"cmd"}
                    }]
                }],
                "input":[{
                    "type":"function_call_output",
                    "call_id":"call_exec",
                    "output":"result"
                }]
            })
        );
    }

    #[test]
    fn responses_repeated_call_results_keep_distinct_occurrences() {
        let (canonical, pair) = normalize(
            "responses",
            json!({"model":"client-model","input":[
                {"type":"function_call_output","call_id":"call_same","output":"same"},
                {"type":"function_call_output","call_id":"call_same","output":"same"}
            ]}),
        );

        assert_eq!(
            project(&canonical, &pair),
            json!({"input":[
                {"type":"function_call_output","call_id":"call_same","output":"same"},
                {"type":"function_call_output","call_id":"call_same","output":"same"}
            ]})
        );
    }

    #[test]
    fn responses_instructions_prefix_and_mutation_use_emitted_index() {
        let (mut canonical, pair) = normalize(
            "responses",
            json!({
                "model":"client-model",
                "instructions":"system prefix",
                "input":"hello"
            }),
        );

        assert_eq!(
            project(&canonical, &pair),
            json!({"instructions":"system prefix","input":"hello"})
        );

        canonical["messages"][0]["content"] = json!("mutated prefix");
        canonical["messages"][1]["content"] = json!("mutated hello");
        assert_eq!(
            project(&canonical, &pair),
            json!({"instructions":"mutated prefix","input":"mutated hello"})
        );
    }

    #[test]
    fn unowned_native_history_transforms_are_skipped() {
        let (canonical, pair) = normalize(
            "anthropic",
            json!({"model":"client-model","messages":[{"role":"user","content":"hi"}]}),
        );
        assert_eq!(project(&canonical, &pair), json!({}));

        let (canonical, pair) = normalize(
            "gemini",
            json!({"model":"client-model","contents":[{"role":"user","parts":[{"text":"hi"}]}]}),
        );
        assert_eq!(project(&canonical, &pair), json!({}));
    }

    #[test]
    fn responses_media_part_requires_parent_discriminators() {
        let (canonical, pair) = normalize(
            "responses",
            json!({"model":"client-model","input":[{
                "type":"message",
                "role":"user",
                "content":[{
                    "type":"input_image",
                    "image_url":"https://example.test/image.png"
                }]
            }]}),
        );

        assert_eq!(
            project(&canonical, &pair),
            json!({"input":[{
                "type":"message",
                "role":"user",
                "content":[{
                    "type":"input_image",
                    "image_url":"https://example.test/image.png"
                }]
            }]})
        );
    }

    #[test]
    fn responses_media_current_values_reverse_to_each_original_scalar_or_object_shape() {
        let raw = json!({"input":[{"type":"message","role":"user","content":[
            {"type":"input_image","image_url":"one","detail":"high","vendor.name[0]":true},
            {"type":"image_url","image_url":{"url":"two","vendor.name[0]":null},"detail":"low"},
            {"type":"input_image","url":null},
            {"type":"text","text":"literal alias"}
        ]}]});
        let (mut canonical, pair) = normalize("responses", raw);
        canonical["messages"][0]["content"][0]["image_url"]["url"] = json!("one-current");
        canonical["messages"][0]["content"][0]["image_url"]["detail"] = json!("low");
        canonical["messages"][0]["content"][1]["image_url"]["url"] = json!("two-current");
        canonical["messages"][0]["content"][1]["image_url"]["vendor.name[0]"] = json!("current");
        canonical["messages"][0]["content"][2]["image_url"]["url"] = json!("three-current");
        assert_eq!(
            project(&canonical, &pair),
            json!({"input":[{
                "type":"message","role":"user","content":[
                    {"type":"input_image","image_url":"one-current","detail":"low","vendor.name[0]":true},
                    {"type":"image_url","image_url":{"url":"two-current","vendor.name[0]":"current"},"detail":"low"},
                    {"type":"input_image","url":"three-current"},
                    {"type":"text","text":"literal alias"}
                ]
            }]})
        );
    }

    #[test]
    fn responses_inner_and_outer_media_detail_do_not_alias_distinct_source_values() {
        let raw = json!({"input":[{"type":"message","role":"user","content":[{
            "type":"input_image","image_url":{"url":"one","detail":"high"},"detail":"low"
        }]}]});
        let (canonical, pair) = normalize("responses", raw.clone());
        assert_eq!(project(&canonical, &pair), json!({"input":raw["input"]}));
    }

    // Consumer fixture for the independently admitted instruction-segment
    // representation. The actual SDK producer is verified separately after
    // combination; this test exercises its precise registered leaf contract.
    fn segmented_system_fixture(protocol: &str) -> (Value, RequestScopedContextPair) {
        let history_key = if protocol == "responses" {
            "input"
        } else {
            "messages"
        };
        let raw = json!({history_key:[{"role":"system","content":"history"}]});
        let (mut canonical, mut pair) = normalize(protocol, raw);
        canonical["messages"][0]["content"] = json!([
            {"type":"text","text":"instruction-current"},
            {"type":"text","text":"\n"},
            {"type":"text","text":"history-current"}
        ]);
        let source = format!("request.{history_key}[0].content");
        let mapping = pair
            .inverse_context
            .field_mappings
            .iter_mut()
            .find(|mapping| mapping.source_path == source)
            .unwrap();
        mapping.destination = "chat.messages[0].content[2].text".into();
        (canonical, pair)
    }

    #[test]
    fn shared_system_message_reads_only_its_registered_history_contribution() {
        for protocol in ["responses", "openai-chat"] {
            let (canonical, pair) = segmented_system_fixture(protocol);
            let key = if protocol == "responses" {
                "input"
            } else {
                "messages"
            };
            let output = project(&canonical, &pair);
            assert_eq!(output[key][0]["content"], "history-current");
        }
    }

    #[test]
    fn deleted_registered_history_leaf_does_not_receive_instruction_content() {
        for protocol in ["responses", "openai-chat"] {
            let (mut canonical, pair) = segmented_system_fixture(protocol);
            canonical["messages"][0]["content"][2]
                .as_object_mut()
                .unwrap()
                .remove("text");
            let key = if protocol == "responses" {
                "input"
            } else {
                "messages"
            };
            let output = project(&canonical, &pair);
            assert!(output[key][0].get("content").is_none());
        }
    }
}

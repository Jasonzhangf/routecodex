use serde_json::{Map, Value};
use std::collections::BTreeMap;

use super::current_projection_view::CurrentProjectionView;
use super::project_canonical_instructions::project_instruction_source;
use super::project_canonical_paths::write_path;
use crate::operation_runner::{
    ExplicitHistoryPairing, HistoryPairingReference, RequestInverseContext,
};

const ANTHROPIC_HISTORY_TRANSFORM: &str = "v3.anthropic_messages_to_chat_messages.v1";
const GEMINI_HISTORY_TRANSFORM: &str = "v3.gemini_contents_to_chat_messages.v1";
const ANTHROPIC_INSTRUCTION_TRANSFORM: &str = "v3.anthropic_system_to_chat_system.v1";
const GEMINI_INSTRUCTION_TRANSFORM: &str = "v3.gemini_system_instruction_to_chat_system.v1";

/// Which registered client-history transform the request came through.
#[derive(Clone, Copy, PartialEq, Eq)]
enum NativeProtocol {
    Anthropic,
    Gemini,
}

#[derive(Clone)]
struct NativeShape {
    protocol: NativeProtocol,
    container_source: Option<String>,
    container_key: &'static str,
    item_key: &'static str,
    instruction_source: Option<String>,
    instruction_key: &'static str,
}

/// Reverse the registered Anthropic/Gemini history and instruction transforms
/// from the current canonical request plus the original typed associations.
///
/// The returned object carries only the native history/instruction fields; the
/// parent facade merges it with the remaining direct fields and declarations.
/// Behavior is selected by the registered transform identity carried on the
/// field mappings, never by the entry protocol or model name.
pub(super) fn project_direct_native_history(
    view: &CurrentProjectionView<'_>,
    history: &ExplicitHistoryPairing,
) -> Result<Value, String> {
    let Some(shape) = select_shape(view.inverse()) else {
        return Ok(Value::Object(Map::new()));
    };
    let mut output = Map::new();
    if let Some(value) = project_instruction(view, &shape)? {
        output.insert(shape.instruction_key.to_string(), value);
    }
    if let Some(value) = project_history(view, history, &shape)? {
        output.insert(shape.container_key.to_string(), value);
    }
    Ok(Value::Object(output))
}

/// Select the native history shape from the registered history transform that
/// produced the canonical `chat.messages`. No protocol-name preference.
fn select_shape(inverse: &RequestInverseContext) -> Option<NativeShape> {
    let protocol = inverse.field_mappings.iter().find_map(|mapping| {
        match mapping.transform_id.as_deref() {
            Some(ANTHROPIC_HISTORY_TRANSFORM | ANTHROPIC_INSTRUCTION_TRANSFORM) => {
                Some(NativeProtocol::Anthropic)
            }
            Some(GEMINI_HISTORY_TRANSFORM | GEMINI_INSTRUCTION_TRANSFORM) => {
                Some(NativeProtocol::Gemini)
            }
            _ => None,
        }
    })?;
    let history_transform = match protocol {
        NativeProtocol::Anthropic => ANTHROPIC_HISTORY_TRANSFORM,
        NativeProtocol::Gemini => GEMINI_HISTORY_TRANSFORM,
    };
    let container_source = inverse
        .field_mappings
        .iter()
        .find(|mapping| mapping.transform_id.as_deref() == Some(history_transform))
        .map(|mapping| mapping.source_path.clone());
    let instruction_transform = match protocol {
        NativeProtocol::Anthropic => ANTHROPIC_INSTRUCTION_TRANSFORM,
        NativeProtocol::Gemini => GEMINI_INSTRUCTION_TRANSFORM,
    };
    let instruction_source = inverse
        .field_mappings
        .iter()
        .find(|candidate| candidate.transform_id.as_deref() == Some(instruction_transform))
        .map(|candidate| candidate.source_path.clone());
    Some(match protocol {
        NativeProtocol::Anthropic => NativeShape {
            protocol,
            container_source,
            container_key: "messages",
            item_key: "content",
            instruction_source,
            instruction_key: "system",
        },
        NativeProtocol::Gemini => NativeShape {
            protocol,
            container_source,
            container_key: "contents",
            item_key: "parts",
            instruction_source,
            instruction_key: "systemInstruction",
        },
    })
}

/// Restore the native instruction field from the canonical content at the
/// concrete message index recorded by the instruction producer.
fn project_instruction(
    view: &CurrentProjectionView<'_>,
    shape: &NativeShape,
) -> Result<Option<Value>, String> {
    let Some(source) = shape.instruction_source.as_deref() else {
        return Ok(None);
    };
    project_instruction_source(view, source)
}

/// Rebuild the native history array from the concrete per-item associations the
/// producer recorded when it emitted each canonical message.
fn project_history(
    view: &CurrentProjectionView<'_>,
    history: &ExplicitHistoryPairing,
    shape: &NativeShape,
) -> Result<Option<Value>, String> {
    let Some(container_source) = shape.container_source.as_deref() else {
        return Ok(None);
    };
    let Some(messages) = view.canonical().get("messages").and_then(Value::as_array) else {
        return Ok(None);
    };
    // A non-array source was emitted as one canonical content value and
    // associated with the source container itself. Preserve its current shape.
    if let Some((mapping_index, _)) =
        view.inverse()
            .field_mappings
            .iter()
            .enumerate()
            .find(|(mapping_index, mapping)| {
                mapping.source_path == container_source
                    && mapping.operator == "routecodex.v3.field.array_container_shape@1"
                    && view
                        .current_destination(*mapping_index)
                        .and_then(exact_message_index)
                        .is_some()
            })
    {
        return Ok(view
            .read_mapping(mapping_index)?
            .and_then(|message| message.get("content"))
            .cloned());
    }
    let associations = history_item_associations(view, container_source);
    if associations.is_empty() {
        return view.empty_history_container(container_source).map(Some);
    }
    let mut projected = Vec::with_capacity(associations.len());
    for (item_index, indices) in associations {
        // The current canonical no longer holds any message this native item
        // produced, so the item itself is gone.
        if indices.iter().all(|index| *index >= messages.len()) {
            continue;
        }
        let item_path = format!("{container_source}[{item_index}]");
        projected.push(project_item(
            view, history, shape, messages, &item_path, &indices,
        )?);
    }
    Ok(Some(Value::Array(projected)))
}

/// Concrete native item path -> canonical message indices it produced. A single
/// native item may own several canonical messages (for example a tool result).
fn history_item_associations(
    view: &CurrentProjectionView<'_>,
    container: &str,
) -> BTreeMap<usize, Vec<usize>> {
    let mut associations = BTreeMap::<usize, Vec<usize>>::new();
    for (mapping_index, mapping) in view.inverse().field_mappings.iter().enumerate() {
        if mapping.transform_id.is_some() {
            continue;
        }
        let Some(item_index) = exact_container_index(&mapping.source_path, container) else {
            continue;
        };
        let Some(message_index) = view
            .current_destination(mapping_index)
            .and_then(exact_message_index)
        else {
            continue;
        };
        associations
            .entry(item_index)
            .or_default()
            .push(message_index);
    }
    for indices in associations.values_mut() {
        indices.sort_unstable();
        indices.dedup();
    }
    associations
}

fn project_item(
    view: &CurrentProjectionView<'_>,
    history: &ExplicitHistoryPairing,
    shape: &NativeShape,
    messages: &[Value],
    item_path: &str,
    indices: &[usize],
) -> Result<Value, String> {
    let mut native = scaffold(view, item_path)?;
    let Some(message_index) = indices.first().copied() else {
        return Ok(native);
    };
    let Some(message) = messages.get(message_index) else {
        return Ok(native);
    };
    if !native.is_object() {
        return Ok(native);
    }
    {
        let object = native.as_object_mut().expect("object");
        object.remove(shape.item_key);
    }
    if let Some(role) = message.get("role").and_then(Value::as_str) {
        let role = inverse_role(shape.protocol, role);
        native
            .as_object_mut()
            .expect("object")
            .insert("role".to_string(), Value::String(role));
    }
    let tool_positions = tool_positions(history, item_path, shape.item_key);
    if let Some(content) = project_item_content(
        view,
        shape,
        item_path,
        message.get("content"),
        &tool_positions,
    )? {
        native
            .as_object_mut()
            .expect("object")
            .insert(shape.item_key.to_string(), content);
    }
    Ok(native)
}

fn project_item_content(
    view: &CurrentProjectionView<'_>,
    shape: &NativeShape,
    item_path: &str,
    content: Option<&Value>,
    tool_positions: &BTreeMap<usize, &HistoryPairingReference>,
) -> Result<Option<Value>, String> {
    let parts = content.and_then(Value::as_array);
    if tool_positions.is_empty() {
        // No tool block was extracted from this item, so the native content is
        // the current canonical content projected back through its parts.
        return match content {
            Some(Value::Array(parts)) => Ok(Some(Value::Array(
                parts
                    .iter()
                    .enumerate()
                    .map(|(position, part)| project_part(view, shape, item_path, position, part))
                    .collect::<Result<Vec<_>, _>>()?,
            ))),
            Some(other) => Ok(Some(other.clone())),
            None => Ok(None),
        };
    }
    let parts = parts.map(Vec::as_slice).unwrap_or(&[]);
    let highest_tool = tool_positions.keys().max().copied().unwrap_or(0) + 1;
    let total = highest_tool.max(parts.len() + tool_positions.len());
    let mut projected = Vec::with_capacity(total);
    let mut next_part = parts.iter();
    for position in 0..total {
        if let Some(pairing) = tool_positions.get(&position) {
            projected.push(project_tool_block(view, shape, pairing)?);
        } else if let Some(part) = next_part.next() {
            projected.push(project_part(view, shape, item_path, position, part)?);
        }
    }
    Ok(Some(Value::Array(projected)))
}

fn tool_positions<'a>(
    history: &'a ExplicitHistoryPairing,
    item_path: &str,
    item_key: &str,
) -> BTreeMap<usize, &'a HistoryPairingReference> {
    let prefix = format!("{item_path}.{item_key}[");
    let mut positions = BTreeMap::new();
    for pairing in &history.messages {
        let Some(rest) = pairing.source_path.strip_prefix(&prefix) else {
            continue;
        };
        let Some(close) = rest.find(']') else {
            continue;
        };
        if close + 1 != rest.len() {
            continue;
        }
        let Ok(index) = rest[..close].parse::<usize>() else {
            continue;
        };
        positions.insert(index, pairing);
    }
    positions
}

fn project_part(
    view: &CurrentProjectionView<'_>,
    shape: &NativeShape,
    item_path: &str,
    position: usize,
    part: &Value,
) -> Result<Value, String> {
    let part_path = format!("{item_path}.{}[{position}]", shape.item_key);
    let mut native = scaffold(view, &part_path)?;
    let Some(object) = native.as_object_mut() else {
        return Ok(part.clone());
    };
    let Some(part_object) = part.as_object() else {
        return Ok(part.clone());
    };
    match shape.protocol {
        NativeProtocol::Anthropic => project_anthropic_part(view, object, part_object, &part_path)?,
        NativeProtocol::Gemini => project_gemini_part(view, object, part_object, &part_path)?,
    }
    Ok(native)
}

fn project_anthropic_part(
    view: &CurrentProjectionView<'_>,
    object: &mut Map<String, Value>,
    part: &Map<String, Value>,
    part_path: &str,
) -> Result<(), String> {
    match part.get("type").and_then(Value::as_str) {
        Some("text") => {
            object.insert("type".to_string(), Value::String("text".to_string()));
            copy_leaf(object, part, "text");
        }
        Some("image") | Some("image_url") => {
            object.insert("type".to_string(), Value::String("image".to_string()));
            object.insert(
                "source".to_string(),
                restore_anthropic_media_source(
                    view,
                    object.get("source"),
                    &format!("{part_path}.source"),
                )?,
            );
        }
        Some("file") => {
            object.insert("type".to_string(), Value::String("document".to_string()));
            object.insert(
                "source".to_string(),
                restore_anthropic_media_source(
                    view,
                    object.get("source"),
                    &format!("{part_path}.source"),
                )?,
            );
            if let Some(title) = part
                .get("file")
                .and_then(Value::as_object)
                .and_then(|file| file.get("filename"))
            {
                if !title.is_null() {
                    object.insert("title".to_string(), title.clone());
                }
            }
        }
        Some("thinking") => {
            object.insert("type".to_string(), Value::String("thinking".to_string()));
            copy_leaf(object, part, "thinking");
            copy_leaf(object, part, "signature");
        }
        _ => merge_object_map(object, part),
    }
    Ok(())
}

fn project_gemini_part(
    view: &CurrentProjectionView<'_>,
    object: &mut Map<String, Value>,
    part: &Map<String, Value>,
    part_path: &str,
) -> Result<(), String> {
    match part.get("type").and_then(Value::as_str) {
        Some("text") => copy_leaf(object, part, "text"),
        Some("media") => {
            let inline = nested_object(object, "inlineData");
            restore_leaf(
                view,
                inline,
                part,
                &["media", "inline_data"],
                "data",
                &format!("{part_path}.inlineData.data"),
            )?;
            restore_leaf(
                view,
                inline,
                part,
                &["media", "mime_type"],
                "mimeType",
                &format!("{part_path}.inlineData.mimeType"),
            )?;
        }
        Some("file") => {
            let file = nested_object(object, "fileData");
            restore_leaf(
                view,
                file,
                part,
                &["file", "file_url"],
                "fileUri",
                &format!("{part_path}.fileData.fileUri"),
            )?;
            restore_leaf(
                view,
                file,
                part,
                &["file", "mime_type"],
                "mimeType",
                &format!("{part_path}.fileData.mimeType"),
            )?;
        }
        _ => merge_object_map(object, part),
    }
    Ok(())
}

fn project_tool_block(
    view: &CurrentProjectionView<'_>,
    shape: &NativeShape,
    pairing: &HistoryPairingReference,
) -> Result<Value, String> {
    let block_path = pairing.source_path.as_str();
    let mut native = scaffold(view, &block_path)?;
    if !native.is_object() {
        native = Value::Object(Map::new());
    }
    let object = native.as_object_mut().expect("object");
    match (shape.protocol, pairing.kind.as_str()) {
        (NativeProtocol::Anthropic, "tool_result") => {
            object.insert("type".to_string(), Value::String("tool_result".to_string()));
            if let Some(call_id) = mapped_leaf(view, &format!("{block_path}.tool_use_id"))? {
                object.insert("tool_use_id".to_string(), call_id);
            }
            if let Some(content) = mapped_leaf(view, &format!("{block_path}.content"))? {
                object.insert("content".to_string(), content);
            }
        }
        (NativeProtocol::Anthropic, _) => {
            object.insert("type".to_string(), Value::String("tool_use".to_string()));
            if let Some(call_id) = mapped_leaf(view, &format!("{block_path}.id"))? {
                object.insert("id".to_string(), call_id);
            }
            if let Some(name) = mapped_leaf(view, &format!("{block_path}.name"))? {
                object.insert("name".to_string(), name);
            }
            if let Some(input) = mapped_leaf(view, &format!("{block_path}.input"))? {
                object.insert("input".to_string(), input);
            }
        }
        (NativeProtocol::Gemini, "tool_result") => {
            let response = nested_object(object, "functionResponse");
            if let Some(call_id) = mapped_leaf(view, &format!("{block_path}.functionResponse.id"))?
            {
                response.insert("id".to_string(), call_id);
            }
            if let Some(name) = mapped_leaf(view, &format!("{block_path}.functionResponse.name"))? {
                response.insert("name".to_string(), name);
            }
            if let Some(content) =
                mapped_leaf(view, &format!("{block_path}.functionResponse.response"))?
            {
                response.insert("response".to_string(), content);
            }
        }
        (NativeProtocol::Gemini, _) => {
            let call_object = nested_object(object, "functionCall");
            if let Some(call_id) = mapped_leaf(view, &format!("{block_path}.functionCall.id"))? {
                call_object.insert("id".to_string(), call_id);
            }
            if let Some(name) = mapped_leaf(view, &format!("{block_path}.functionCall.name"))? {
                call_object.insert("name".to_string(), name);
            }
            if let Some(args) = mapped_leaf(view, &format!("{block_path}.functionCall.args"))? {
                call_object.insert("args".to_string(), args);
            }
        }
    }
    Ok(native)
}

fn mapped_leaf(
    view: &CurrentProjectionView<'_>,
    source_path: &str,
) -> Result<Option<Value>, String> {
    Ok(view.mapped_source_value(source_path)?.cloned())
}

fn restore_leaf(
    view: &CurrentProjectionView<'_>,
    target: &mut Map<String, Value>,
    source: &Map<String, Value>,
    source_keys: &[&str],
    target_key: &str,
    source_path: &str,
) -> Result<(), String> {
    if let Some(value) = mapped_leaf(view, source_path)? {
        target.insert(target_key.to_string(), value);
        return Ok(());
    }
    if let Some(value) = nested_value(source, source_keys) {
        target.insert(target_key.to_string(), value.clone());
    }
    Ok(())
}

fn nested_value<'a>(source: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    let (first, rest) = keys.split_first()?;
    let mut value = source.get(*first)?;
    for key in rest {
        value = value.as_object()?.get(*key)?;
    }
    Some(value)
}

fn restore_anthropic_media_source(
    view: &CurrentProjectionView<'_>,
    existing: Option<&Value>,
    source_path: &str,
) -> Result<Value, String> {
    let mut merged = existing
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mapped_url = mapped_leaf(view, &format!("{source_path}.url"))?;
    let mapped_data = mapped_leaf(view, &format!("{source_path}.data"))?;
    let mapped_media_type = mapped_leaf(view, &format!("{source_path}.media_type"))?;
    let source_type = view
        .source_value(&format!("{source_path}.type"))?
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            mapped_url
                .as_ref()
                .map(|_| "url".to_string())
                .or_else(|| mapped_data.as_ref().map(|_| "base64".to_string()))
        });
    match source_type {
        Some(source_type) => {
            merged.insert("type".to_string(), Value::String(source_type));
        }
        None => {
            merged.remove("type");
        }
    }
    for (target_key, value) in [
        ("url", mapped_url),
        ("data", mapped_data),
        ("media_type", mapped_media_type),
    ] {
        match value {
            Some(value) => {
                merged.insert(target_key.to_string(), value);
            }
            None => {
                merged.remove(target_key);
            }
        }
    }
    Ok(Value::Object(merged))
}

/// Build the original native value for `path` from the opaque siblings the
/// producer recorded at and below it. Recognized leaves are written from the
/// current canonical data by the caller; this only restores copied data.
fn scaffold(view: &CurrentProjectionView<'_>, path: &str) -> Result<Value, String> {
    if !is_mapped_source_or_ancestor(view.inverse(), path) {
        if let Some(value) = view.source_value(path)? {
            return Ok(value.clone());
        }
    }
    let mut root = Value::Object(Map::new());
    for reference in &view.inverse().opaque_record_references {
        let Some(relative) = reference.path.strip_prefix(path).and_then(|rest| {
            rest.strip_prefix('.')
                .or_else(|| rest.starts_with('[').then_some(rest))
        }) else {
            continue;
        };
        if relative.is_empty() {
            continue;
        }
        if is_exact_mapped_source(view.inverse(), &reference.path) {
            continue;
        }
        let Some(value) = view.opaque_value(reference)? else {
            continue;
        };
        write_path(&mut root, relative, value.clone())?;
    }
    Ok(root)
}

fn is_mapped_source_or_ancestor(inverse: &RequestInverseContext, source_path: &str) -> bool {
    inverse.field_mappings.iter().any(|mapping| {
        mapping.source_path == source_path
            || mapping
                .source_path
                .strip_prefix(source_path)
                .is_some_and(|rest| rest.starts_with('.') || rest.starts_with('['))
    })
}

fn is_exact_mapped_source(inverse: &RequestInverseContext, source_path: &str) -> bool {
    inverse
        .field_mappings
        .iter()
        .any(|mapping| mapping.source_path == source_path)
}

fn inverse_role(protocol: NativeProtocol, role: &str) -> String {
    match protocol {
        NativeProtocol::Gemini if role == "assistant" => "model".to_string(),
        _ => role.to_string(),
    }
}

fn merge_object(existing: Option<&Value>, computed: Value) -> Value {
    let mut merged = existing
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Value::Object(computed) = computed {
        for (key, value) in computed {
            merged.insert(key, value);
        }
    }
    Value::Object(merged)
}

fn merge_object_map(target: &mut Map<String, Value>, source: &Map<String, Value>) {
    for (key, value) in source {
        target.insert(key.clone(), value.clone());
    }
}

fn copy_leaf(target: &mut Map<String, Value>, source: &Map<String, Value>, key: &str) {
    if let Some(value) = source.get(key) {
        target.insert(key.to_string(), value.clone());
    }
}

fn copy_value(target: &mut Map<String, Value>, source: Option<&Value>, key: &str) {
    if let Some(value) = source {
        target.insert(key.to_string(), value.clone());
    }
}

fn copy_nested(
    target: &mut Map<String, Value>,
    source: &Map<String, Value>,
    container: &str,
    inner: &str,
    key: &str,
) {
    if let Some(value) = source
        .get(container)
        .and_then(Value::as_object)
        .and_then(|object| object.get(inner))
    {
        target.insert(key.to_string(), value.clone());
    }
}

fn nested_object<'a>(object: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    if !object.get(key).is_some_and(Value::is_object) {
        object.insert(key.to_string(), Value::Object(Map::new()));
    }
    object
        .get_mut(key)
        .and_then(Value::as_object_mut)
        .expect("nested object was inserted")
}

/// Exact `{container}[N]` with no trailing segment.
fn exact_container_index(source: &str, container: &str) -> Option<usize> {
    let rest = source.strip_prefix(container)?.strip_prefix('[')?;
    let close = rest.find(']')?;
    if close + 1 != rest.len() {
        return None;
    }
    rest[..close].parse().ok()
}

/// Exact `chat.messages[N]`.
fn exact_message_index(destination: &str) -> Option<usize> {
    let rest = destination.strip_prefix("chat.messages[")?;
    let close = rest.find(']')?;
    if close + 1 != rest.len() {
        return None;
    }
    rest[..close].parse().ok()
}

#[cfg(test)]
mod tests {
    use super::project_direct_native_history;
    use crate::operation_runner::operators::current_projection_view::CurrentProjectionView;
    use crate::operation_runner::operators::field_operator_library::normalize_client_request;
    use crate::operation_runner::{CurrentFieldAssociations, RequestScopedContextPair};
    use serde_json::{json, Value};

    fn normalize(protocol: &str, raw: &Value) -> (Value, RequestScopedContextPair) {
        let normalized = normalize_client_request(protocol, raw).expect("request normalizes");
        let pair = RequestScopedContextPair::from_field_json(
            normalized.inverse_context,
            normalized.explicit_history_pairing,
        )
        .expect("inverse context parses");
        (normalized.canonical_request, pair)
    }

    fn project(canonical: &Value, pair: &RequestScopedContextPair) -> Result<Value, String> {
        let associations = CurrentFieldAssociations::from_normalization(&pair.inverse_context);
        project_direct_native_history(
            &CurrentProjectionView::new(canonical, &pair.inverse_context, &associations),
            &pair.explicit_history_pairing,
        )
    }

    fn untouched(protocol: &str, raw: &Value) -> Value {
        let (canonical, pair) = normalize(protocol, raw);
        project(&canonical, &pair).expect("native history projects")
    }

    #[test]
    fn anthropic_untouched_history_and_instructions_round_trip() {
        let raw = json!({
            "system": "be concise",
            "messages": [
                {"role": "user", "content": [{"type": "text", "text": "hello", "cache_control": {"type": "ephemeral"}}], "vendorMessage": {"keep": 1}},
                {"role": "assistant", "content": [
                    {"type": "text", "text": "calling"},
                    {"type": "tool_use", "id": "toolu-1", "name": "exec", "input": {"command": "line1\nline2"}, "vendorTool": {"keep": 2}}
                ]},
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu-1", "content": "complete\nresult", "is_error": false, "vendorResult": {"keep": 3}}]}
            ]
        });
        let output = untouched("anthropic", &raw);
        assert_eq!(output["system"], raw["system"]);
        assert_eq!(output["messages"][0], raw["messages"][0]);
        assert_eq!(
            output["messages"][1]["content"][0],
            raw["messages"][1]["content"][0]
        );
        assert_eq!(
            output["messages"][1]["content"][1],
            raw["messages"][1]["content"][1]
        );
        assert_eq!(output["messages"][2], raw["messages"][2]);
    }

    #[test]
    fn gemini_untouched_history_instruction_and_media_round_trip() {
        let raw = json!({
            "systemInstruction": {"parts": [{"text": "be concise", "vendor": {"keep": 0}}]},
            "contents": [
                {"role": "user", "parts": [{"text": "hello", "vendor": {"keep": 1}}], "vendorMessage": {"keep": 2}},
                {"role": "model", "parts": [{"functionCall": {"id": "call-1", "name": "exec", "args": {"command": "line1\nline2"}, "vendorCall": {"keep": 3}}}]},
                {"role": "user", "parts": [{"functionResponse": {"id": "call-1", "response": {"output": "complete\nresult"}, "vendorResult": {"keep": 4}}}]},
                {"role": "user", "parts": [
                    {"inlineData": {"mimeType": "image/png", "data": "aGVsbG8=", "vendor": {"keep": 5}}},
                    {"text": "after image"}
                ]}
            ]
        });
        let output = untouched("gemini", &raw);
        assert_eq!(output["systemInstruction"], raw["systemInstruction"]);
        assert_eq!(output["contents"][0], raw["contents"][0]);
        assert_eq!(output["contents"][1], raw["contents"][1]);
        assert_eq!(output["contents"][2], raw["contents"][2]);
        assert_eq!(output["contents"][3], raw["contents"][3]);
    }

    #[test]
    fn canonical_content_mutation_and_deletion_reflect_native_shape() {
        let raw = json!({
            "messages": [
                {"role": "user", "content": [{"type": "text", "text": "hello", "cache_control": {"type": "ephemeral"}}]},
                {"role": "user", "content": [{"type": "text", "text": "drop me"}]}
            ]
        });
        let (mut canonical, pair) = normalize("anthropic", &raw);
        canonical["messages"][0]["content"][0]["text"] = json!("changed");
        canonical["messages"].as_array_mut().unwrap().remove(1);
        let output = project(&canonical, &pair).expect("anthropic history projects");
        assert_eq!(output["messages"].as_array().unwrap().len(), 1);
        assert_eq!(output["messages"][0]["content"][0]["text"], "changed");
        assert_eq!(
            output["messages"][0]["content"][0]["cache_control"],
            json!({"type": "ephemeral"})
        );
    }

    #[test]
    fn multiple_parts_and_tool_blocks_keep_native_positions() {
        let raw = json!({
            "messages": [
                {"role": "user", "content": [{"type": "text", "text": "first"}, {"type": "text", "text": "second"}]},
                {"role": "assistant", "content": [
                    {"type": "text", "text": "before call"},
                    {"type": "tool_use", "id": "toolu-1", "name": "exec", "input": {"command": "cmd"}},
                    {"type": "text", "text": "after call"}
                ]}
            ]
        });
        let output = untouched("anthropic", &raw);
        assert_eq!(
            output["messages"][0]["content"].as_array().unwrap().len(),
            2
        );
        assert_eq!(output["messages"][0]["content"][0]["text"], "first");
        assert_eq!(output["messages"][0]["content"][1]["text"], "second");
        assert_eq!(output["messages"][1]["content"][0]["text"], "before call");
        assert_eq!(output["messages"][1]["content"][1]["type"], "tool_use");
        assert_eq!(output["messages"][1]["content"][1]["id"], "toolu-1");
        assert_eq!(
            output["messages"][1]["content"][1]["input"],
            json!({"command": "cmd"})
        );
        assert_eq!(output["messages"][1]["content"][2]["text"], "after call");
    }

    #[test]
    fn tool_argument_mutation_and_tool_result_identity_survive_inverse() {
        let raw = json!({
            "messages": [
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "toolu-1", "name": "exec", "input": {"command": "old"}}
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "toolu-1", "content": "old result"}
                ]}
            ]
        });
        let (mut canonical, pair) = normalize("anthropic", &raw);
        canonical["messages"][0]["tool_calls"][0]["function"]["arguments"] =
            json!({"command": "changed", "nested": [1, null, true]});
        canonical["messages"][2]["content"] = json!("changed result");
        let output = project(&canonical, &pair).expect("anthropic history projects");
        assert_eq!(
            output["messages"][0]["content"][0]["input"],
            json!({"command": "changed", "nested": [1, null, true]})
        );
        assert_eq!(output["messages"][0]["content"][0]["id"], "toolu-1");
        assert_eq!(output["messages"][0]["content"][0]["name"], "exec");
        assert_eq!(
            output["messages"][1]["content"][0]["tool_use_id"],
            "toolu-1"
        );
        assert_eq!(
            output["messages"][1]["content"][0]["content"],
            "changed result"
        );
    }

    #[test]
    fn gemini_media_missing_and_null_mime_preserves_presence() {
        let raw = json!({
            "contents": [{"role": "user", "parts": [
                {"inlineData": {"data": "aGVsbG8="}},
                {"inlineData": {"mimeType": null, "data": "d29ybGQ="}}
            ]}]
        });
        let output = untouched("gemini", &raw);
        assert_eq!(
            output["contents"][0]["parts"][0]["inlineData"]["data"],
            "aGVsbG8="
        );
        assert!(output["contents"][0]["parts"][0]["inlineData"]
            .get("mimeType")
            .is_none());
        assert_eq!(
            output["contents"][0]["parts"][1]["inlineData"]["mimeType"],
            Value::Null
        );
        assert_eq!(
            output["contents"][0]["parts"][1]["inlineData"]["data"],
            "d29ybGQ="
        );
    }

    #[test]
    fn unknown_literal_dotted_and_bracket_keys_round_trip() {
        let raw = json!({
            "contents": [{"role": "user", "parts": [{"text": "hello", "vendor.name[0]": {"keep": true}}]}]
        });
        let output = untouched("gemini", &raw);
        assert_eq!(
            output["contents"][0]["parts"][0]["vendor.name[0]"],
            json!({"keep": true})
        );
    }

    #[test]
    fn instruction_mutation_reflects_current_canonical_content() {
        let raw = json!({
            "system": "original",
            "messages": [{"role": "user", "content": "hello"}]
        });
        let (mut canonical, pair) = normalize("anthropic", &raw);
        canonical["messages"][0]["content"] = json!("changed");
        let output = project(&canonical, &pair).expect("anthropic history projects");
        assert_eq!(output["system"], "changed");

        let raw = json!({
            "systemInstruction": {"parts": [{"text": "original", "vendor": {"keep": 0}}]},
            "contents": [{"role": "user", "parts": [{"text": "hello"}]}]
        });
        let (mut canonical, pair) = normalize("gemini", &raw);
        canonical["messages"][0]["content"] = json!("changed");
        let output = project(&canonical, &pair).expect("gemini history projects");
        assert_eq!(output["systemInstruction"]["parts"][0]["text"], "changed");
        assert_eq!(
            output["systemInstruction"]["parts"][0]["vendor"],
            json!({"keep": 0})
        );
    }

    #[test]
    fn complete_command_patch_and_mcp_values_are_opaque() {
        let command = "cmd:\n  - sed -n '1,240p' a.rs\n  - cargo test\n".repeat(2_000);
        let patch = "*** Begin Patch\n*** Update File: a.rs\n+literal\n*** End Patch\n".repeat(500);
        let raw = json!({
            "messages": [
                {"role": "assistant", "content": [
                    {"type": "tool_use", "id": "toolu-1", "name": "exec", "input": {"command": command.clone()}},
                    {"type": "tool_use", "id": "toolu-2", "name": "apply_patch", "input": patch.clone()}
                ]}
            ]
        });
        let output = untouched("anthropic", &raw);
        assert_eq!(
            output["messages"][0]["content"][0]["input"]["command"],
            json!(command)
        );
        assert_eq!(output["messages"][0]["content"][1]["input"], json!(patch));
    }

    #[test]
    fn responses_history_is_not_owned_by_this_native_operator() {
        let raw = json!({"input": [{"type": "message", "role": "user", "content": "hello"}]});
        let output = untouched("responses", &raw);
        assert_eq!(output, json!({}));
    }

    #[test]
    fn gemini_multiple_tool_calls_and_object_results_stay_complete() {
        let raw = json!({
            "contents": [
                {"role": "model", "parts": [
                    {"functionCall": {"id": "call-a", "name": "exec", "args": {"command": "a\nb", "vendor": {"keep": 1}}}},
                    {"functionCall": {"id": "call-b", "name": "search", "args": {"query": "mcp", "options": {"nested": [1, null]}}}}
                ]},
                {"role": "user", "parts": [
                    {"functionResponse": {"id": "call-a", "response": {"output": "complete\nresult", "meta": {"keep": true}}}},
                    {"functionResponse": {"id": "call-b", "response": {"rows": [{"id": 1}, {"id": 2}]}}}
                ]}
            ]
        });
        let output = untouched("gemini", &raw);
        assert_eq!(
            output["contents"][0]["parts"][0]["functionCall"]["args"],
            json!({"command": "a\nb", "vendor": {"keep": 1}})
        );
        assert_eq!(
            output["contents"][0]["parts"][1]["functionCall"]["args"],
            json!({"query": "mcp", "options": {"nested": [1, null]}})
        );
        assert_eq!(
            output["contents"][1]["parts"][0]["functionResponse"]["response"],
            json!({"output": "complete\nresult", "meta": {"keep": true}})
        );
        assert_eq!(
            output["contents"][1]["parts"][1]["functionResponse"]["response"],
            json!({"rows": [{"id": 1}, {"id": 2}]})
        );
    }

    #[test]
    fn gemini_multiple_instruction_parts_consume_concrete_content_mappings() {
        let raw = json!({
            "systemInstruction": {
                "parts": [
                    {"text": "first line", "vendor": {"keep": 0}},
                    {"text": "second line", "vendor": {"keep": 1}}
                ]
            },
            "contents": [
                {"role": "user", "parts": [{"text": "hello"}]},
                {"role": "model", "parts": [{"text": "world"}]}
            ]
        });
        let (mut canonical, pair) = normalize("gemini", &raw);
        for (index, current) in [(0, "first changed"), (1, "second changed")] {
            let source = format!("request.systemInstruction.parts[{index}].text");
            let mapping = pair
                .inverse_context
                .field_mappings
                .iter()
                .find(|mapping| mapping.source_path == source)
                .unwrap();
            super::write_path(&mut canonical, &mapping.destination, json!(current)).unwrap();
        }
        let output = project(&canonical, &pair).expect("gemini history projects");
        assert_eq!(
            output["systemInstruction"],
            json!({
                "parts": [
                    {"text": "first changed", "vendor": {"keep": 0}},
                    {"text": "second changed", "vendor": {"keep": 1}}
                ]
            })
        );
    }

    #[test]
    fn empty_canonical_history_projects_to_empty_native_container() {
        let raw = json!({
            "contents": [{"role": "user", "parts": [{"text": "hello"}]}]
        });
        let (mut canonical, pair) = normalize("gemini", &raw);
        canonical["messages"] = json!([]);
        let output = project(&canonical, &pair).expect("gemini history projects");
        assert_eq!(output["contents"], json!([]));
    }

    #[test]
    fn canonical_content_array_can_be_replaced_wholesale() {
        let raw = json!({
            "messages": [{"role": "user", "content": [{"type": "text", "text": "hello"}]}]
        });
        let (mut canonical, pair) = normalize("anthropic", &raw);
        canonical["messages"][0]["content"] = json!([
            {"type": "text", "text": "first changed"},
            {"type": "text", "text": "second added"}
        ]);
        let output = project(&canonical, &pair).expect("anthropic history projects");
        assert_eq!(output["messages"][0]["content"][0]["text"], "first changed");
        assert_eq!(output["messages"][0]["content"][1]["text"], "second added");
    }

    #[test]
    fn anthropic_base64_media_round_trips_source_shape() {
        let with_mime = json!({
            "messages": [{"role": "user", "content": [{
                "type": "image",
                "source": {"type": "base64", "media_type": "image/png", "data": "aGVsbG8="},
                "cache_control": {"type": "ephemeral"}
            }]}]
        });
        assert_eq!(
            untouched("anthropic", &with_mime)["messages"][0]["content"][0],
            with_mime["messages"][0]["content"][0]
        );

        let without_mime = json!({
            "messages": [{"role": "user", "content": [{
                "type": "image",
                "source": {"type": "base64", "data": "aGVsbG8=", "vendor": {"keep": 1}}
            }]}]
        });
        assert_eq!(
            untouched("anthropic", &without_mime)["messages"][0]["content"][0],
            without_mime["messages"][0]["content"][0]
        );
    }
}

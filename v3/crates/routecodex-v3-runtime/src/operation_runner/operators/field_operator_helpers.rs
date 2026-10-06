use serde_json::{json, Map, Value};

use super::field_operator_library::RequestNormalizer;
use super::field_operator_profiles::{FieldOperatorKind, ProfileRow};

impl RequestNormalizer<'_> {
    pub(super) fn apply_leaf_operator(
        &mut self,
        row: &ProfileRow,
        value: &Value,
        raw_path: &str,
        destination: &str,
    ) -> Value {
        let operator = row
            .dispatch_operator()
            .unwrap_or("routecodex.v3.field.lossless_preserve@1");
        self.record_mapping(row, raw_path, destination, "json");
        match row
            .dispatch_kind
            .unwrap_or(FieldOperatorKind::LosslessPreserve)
        {
            FieldOperatorKind::RoleValueMap => value
                .as_str()
                .map(|role| Value::String(map_role_for_transform(row.transform_id(), role)))
                .unwrap_or_else(|| value.clone()),
            FieldOperatorKind::ParallelToolCallsValueMap => {
                if row.inverse_boolean() {
                    value
                        .as_bool()
                        .map(|value| Value::Bool(!value))
                        .unwrap_or_else(|| value.clone())
                } else {
                    value.clone()
                }
            }
            FieldOperatorKind::ToolChoiceValueMap => map_tool_choice_value(value),
            FieldOperatorKind::PartTypeValueMap => map_part_type(value),
            FieldOperatorKind::MediaShapeBranch => self.normalize_media_value(value, raw_path),
            FieldOperatorKind::ContentShapeBranch => {
                self.normalize_content_value(row, value, raw_path)
            }
            FieldOperatorKind::ToolDeclarationTransform => {
                if let Some(items) = value.as_array() {
                    for (index, item) in items.iter().enumerate() {
                        self.record_openai_like_declaration(
                            item,
                            &format!("{raw_path}[{index}]"),
                            &format!("{destination}[{index}]"),
                        );
                    }
                }
                value.clone()
            }
            FieldOperatorKind::LosslessPreserve
            | FieldOperatorKind::OpaqueToolPayload
            | FieldOperatorKind::RequestInputShapeBranch
            | FieldOperatorKind::ToolChoiceShapeBranch => value.clone(),
            // Container kinds are owned by process_top_level_field; if a leaf
            // dispatch ever reaches them, preserving the raw value is the only
            // lossless option available at this layer.
            FieldOperatorKind::InstructionsToSystemMessage
            | FieldOperatorKind::TokenLimitRename
            | FieldOperatorKind::ResponsesIncludeTransform
            | FieldOperatorKind::ArrayContainerShape => value.clone(),
        }
    }

    pub(super) fn process_openai_like_tool(
        &mut self,
        item: &Value,
        item_path: &str,
        output: &mut Vec<Value>,
    ) {
        self.record_openai_like_declaration(
            item,
            item_path,
            &format!("chat.tools[{}]", output.len()),
        );
        output.push(item.clone());
    }

    fn record_openai_like_declaration(&mut self, item: &Value, item_path: &str, destination: &str) {
        self.record_mapping_by_path(
            item_path,
            destination,
            "routecodex.v3.field.tool_declaration_transform@1",
        );
        let Some(object) = item.as_object() else {
            self.record_opaque(item_path, item);
            return;
        };
        let (kind, name) = openai_like_tool_identity(object);
        self.push_tool_declaration(item_path, kind, name, object.get("namespace"), item);
        self.record_namespace_children(object, item_path, destination);
    }

    fn record_namespace_children(
        &mut self,
        object: &Map<String, Value>,
        item_path: &str,
        destination: &str,
    ) {
        if object.get("type").and_then(Value::as_str) != Some("namespace") {
            return;
        }
        if let Some(children) = object.get("tools").and_then(Value::as_array) {
            for (index, child) in children.iter().enumerate() {
                let Some(child_object) = child.as_object() else {
                    continue;
                };
                let Some(kind) = child_object.get("type").and_then(Value::as_str) else {
                    continue;
                };
                if !matches!(kind, "namespace" | "function" | "custom") {
                    continue;
                }
                let path = format!("{item_path}.tools[{index}]");
                let child_destination = format!("{destination}.tools[{index}]");
                let (_, name) = openai_like_tool_identity(child_object);
                self.push_tool_declaration(&path, kind, name, object.get("name"), child);
                self.record_mapping_by_path(
                    &path,
                    &child_destination,
                    "routecodex.v3.field.tool_declaration_transform@1",
                );
                self.record_namespace_children(child_object, &path, &child_destination);
            }
        }
    }

    pub(super) fn push_tool_declaration(
        &mut self,
        path: &str,
        kind: &str,
        name: Option<&str>,
        namespace: Option<&Value>,
        declaration: &Value,
    ) {
        let record_id = self.record_opaque_once(path, declaration);
        let mut record = json!({
            "record_id": record_id,
            "source_path": path,
            "kind": kind,
            "name": name,
            "encoding": "json",
        });
        if let Some(namespace) = namespace {
            record
                .as_object_mut()
                .expect("tool declaration record is an object")
                .insert("namespace".to_string(), namespace.clone());
        }
        self.tool_declarations.push(record);
    }
}

pub(super) fn openai_like_tool_identity(object: &Map<String, Value>) -> (&str, Option<&str>) {
    let name = object
        .get("function")
        .and_then(Value::as_object)
        .and_then(|function| function.get("name"))
        .and_then(Value::as_str)
        .or_else(|| {
            object
                .get("custom")
                .and_then(Value::as_object)
                .and_then(|custom| custom.get("name"))
                .and_then(Value::as_str)
        })
        .or_else(|| object.get("name").and_then(Value::as_str));
    let kind = object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("function");
    (kind, name)
}

/// Role mapping is selected by the registered role_value_map transform
/// declared on the profile row, never by the entry protocol name.
pub(super) fn map_role_for_transform(transform_id: Option<&str>, role: &str) -> String {
    match transform_id {
        Some("v3.gemini_role_to_chat_role.v1") if role == "model" => "assistant".to_string(),
        _ => role.to_string(),
    }
}

pub(super) fn map_part_type(value: &Value) -> Value {
    let Some(kind) = value.as_str() else {
        return value.clone();
    };
    Value::String(
        match kind {
            "input_text" => "text",
            "input_image" => "image_url",
            "input_file" => "file",
            "image" => "image_url",
            "document" => "file",
            _ => kind,
        }
        .to_string(),
    )
}

pub(super) fn map_tool_choice_value(value: &Value) -> Value {
    if let Some(choice) = value.as_str() {
        let mapped = match choice {
            "tool" => "function",
            "any" => "required",
            "auto" => "auto",
            "none" => "none",
            _ => choice,
        };
        return Value::String(mapped.to_string());
    }
    if let Some(object) = value.as_object() {
        if object.get("type").and_then(Value::as_str) == Some("tool") {
            return json!({
                "type": "function",
                "function": {"name": object.get("name").cloned().unwrap_or(Value::Null)},
            });
        }
    }
    value.clone()
}

pub(super) fn map_tool_choice_scalar(value: &Value) -> Value {
    map_tool_choice_value(value)
}

pub(super) fn map_gemini_tool_choice(value: &Value) -> Value {
    let Some(object) = value.as_object() else {
        return map_tool_choice_value(value);
    };
    let mode = object.get("mode").and_then(Value::as_str).unwrap_or("AUTO");
    match mode {
        "NONE" => Value::String("none".to_string()),
        "ANY" => {
            let names = object
                .get("allowedFunctionNames")
                .and_then(Value::as_array)
                .filter(|names| names.len() == 1)
                .and_then(|names| names.first())
                .and_then(Value::as_str);
            match names {
                Some(name) => json!({"type": "function", "function": {"name": name}}),
                None => Value::String("required".to_string()),
            }
        }
        _ => Value::String("auto".to_string()),
    }
}

pub(super) fn history_values_equivalent(left: &Value, right: &Value) -> bool {
    if left == right {
        return true;
    }
    history_annotations_compatible(left, right)
        && normalized_history_value(left) == normalized_history_value(right)
}

const HISTORY_ANNOTATIONS: [&str; 3] = [
    "responses_item_id",
    "responses_tool_output_type",
    "responses_tool_output_status",
];

fn history_annotations_compatible(left: &Value, right: &Value) -> bool {
    let left = left
        .get("routecodex_chat_extension")
        .and_then(Value::as_object);
    let right = right
        .get("routecodex_chat_extension")
        .and_then(Value::as_object);
    HISTORY_ANNOTATIONS.iter().all(|key| {
        match (
            left.and_then(|m| m.get(*key)),
            right.and_then(|m| m.get(*key)),
        ) {
            (Some(left), Some(right)) => left == right,
            _ => true,
        }
    })
}

pub(super) fn merge_history_annotations(primary: &mut Value, secondary: &Value) {
    let Some(annotations) = secondary
        .get("routecodex_chat_extension")
        .and_then(Value::as_object)
    else {
        return;
    };
    let Some(primary) = primary.as_object_mut() else {
        return;
    };
    for key in HISTORY_ANNOTATIONS {
        let Some(value) = annotations.get(key) else {
            continue;
        };
        let extension = primary
            .entry("routecodex_chat_extension")
            .or_insert_with(|| json!({}));
        if let Some(extension) = extension.as_object_mut() {
            extension.entry(key).or_insert_with(|| value.clone());
        }
    }
}

fn normalized_history_value(value: &Value) -> Value {
    let Some(object) = value.as_object() else {
        return value.clone();
    };
    let mut normalized = object.clone();
    if let Some(extension) = normalized
        .get_mut("routecodex_chat_extension")
        .and_then(Value::as_object_mut)
    {
        for key in HISTORY_ANNOTATIONS {
            extension.remove(key);
        }
        if extension.is_empty() {
            normalized.remove("routecodex_chat_extension");
        }
    }
    let assistant_tool_turn = object.get("role").and_then(Value::as_str) == Some("assistant")
        && object
            .get("tool_calls")
            .and_then(Value::as_array)
            .is_some_and(|tool_calls| !tool_calls.is_empty());
    if assistant_tool_turn && object.get("content").map_or(true, empty_assistant_content) {
        normalized.remove("content");
        return Value::Object(normalized);
    }
    if let Some(content) = object.get("content") {
        if let Some(text) = plain_text_content(content) {
            normalized.insert("content".to_string(), Value::String(text));
        }
    }
    Value::Object(normalized)
}

fn empty_assistant_content(content: &Value) -> bool {
    match content {
        Value::Null => true,
        Value::String(text) => text.is_empty(),
        Value::Array(items) => items.is_empty(),
        _ => false,
    }
}

fn plain_text_content(content: &Value) -> Option<String> {
    match content {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) if items.len() == 1 => {
            let object = items.first()?.as_object()?;
            if object.len() != 2 || object.get("type").and_then(Value::as_str) != Some("text") {
                return None;
            }
            object
                .get("text")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        }
        _ => None,
    }
}

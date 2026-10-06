use serde_json::{json, Map, Value};

use super::field_operator_library::{RequestNormalizer, ROOT_CARRIER_KEY};
use super::field_operator_profiles::HostedHistoryCase;
use super::project_canonical_paths::field_path;

/// Responses tool results declare a closed terminal status domain. A
/// non-terminal status has no Chat canonical meaning, so it is rejected here
/// instead of being carried forward as if it were a finished result.
const RESPONSES_TOOL_RESULT_STATUS_ERROR: &str =
    "Responses function_call_output.status must be completed or incomplete before Chat canonicalization";

pub(super) fn canonical_tool_call_name(
    kind: &str,
    name: &str,
    namespace: Option<&Value>,
) -> String {
    let Some(namespace) = namespace.and_then(Value::as_str) else {
        return name.to_string();
    };
    let namespace = namespace.trim();
    if namespace.is_empty() {
        return name.to_string();
    }
    match kind {
        "custom" => format!("{namespace}.{name}"),
        _ => format!("{namespace}__{name}"),
    }
}

impl<'a> RequestNormalizer<'a> {
    /// Emit one current native hosted event and record each source member's
    /// association with that single value. No ordinary tool pair is stored.
    pub(super) fn emit_hosted_history_anchor(
        &mut self,
        object: &Map<String, Value>,
        item: &Value,
        item_path: &str,
        message_index: usize,
        case: &HostedHistoryCase,
    ) {
        let extension_base = format!(
            "chat.messages[{message_index}].{ROOT_CARRIER_KEY}.{}",
            case.canonical_extension_key()
        );
        self.record_mapping_by_path(
            item_path,
            &extension_base,
            "routecodex.v3.field.lossless_preserve@1",
        );
        for key in object.keys() {
            self.record_mapping_by_path(
                &field_path(item_path, key),
                &field_path(&extension_base, key),
                "routecodex.v3.field.lossless_preserve@1",
            );
        }
        let mut extension = Map::new();
        extension.insert(case.canonical_extension_key().to_string(), item.clone());
        let mut message = Map::new();
        message.insert("role".to_string(), Value::String("assistant".to_string()));
        message.insert("content".to_string(), Value::Null);
        message.insert(ROOT_CARRIER_KEY.to_string(), Value::Object(extension));
        self.messages.push(Value::Object(message));
    }

    /// Keep real source/current mappings for every result member so explicit
    /// edits and deletion govern inverse projection without opaque-source refill.
    pub(super) fn record_responses_output_fields(
        &mut self,
        object: &Map<String, Value>,
        item_path: &str,
        message_index: usize,
        extension: &mut Map<String, Value>,
    ) -> Result<(), String> {
        if object.contains_key("output") {
            self.record_part_mapping(
                "input[].output",
                &format!("{item_path}.output"),
                &format!("chat.messages[{message_index}].content"),
            );
        }
        if let Some(item_id) = object.get("id") {
            extension.insert("responses_item_id".to_string(), item_id.clone());
            self.record_part_mapping(
                "input[].id",
                &field_path(item_path, "id"),
                &format!(
                    "chat.messages[{message_index}].routecodex_chat_extension.responses_item_id"
                ),
            );
        }
        if let Some(status) = object.get("status") {
            if !matches!(status.as_str(), Some("completed" | "incomplete")) {
                return Err(RESPONSES_TOOL_RESULT_STATUS_ERROR.to_string());
            }
            extension.insert("responses_tool_output_status".to_string(), status.clone());
            self.record_part_mapping(
                "input[].status",
                &field_path(item_path, "status"),
                &format!(
                    "chat.messages[{message_index}].routecodex_chat_extension.responses_tool_output_status"
                ),
            );
        }
        let mut extra_fields = Map::new();
        for (key, value) in object {
            if matches!(
                key.as_str(),
                "type" | "output" | "call_id" | "name" | "namespace" | "id" | "status"
            ) {
                continue;
            }
            self.record_mapping_by_path(
                &field_path(item_path, key),
                &field_path(
                    &format!(
                        "chat.messages[{message_index}].routecodex_chat_extension.responses_tool_output_extra_fields"
                    ),
                    key,
                ),
                "routecodex.v3.field.lossless_preserve@1",
            );
            extra_fields.insert(key.clone(), value.clone());
        }
        if !extra_fields.is_empty() {
            extension.insert(
                "responses_tool_output_extra_fields".to_string(),
                Value::Object(extra_fields),
            );
        }
        Ok(())
    }

    /// Responses tool-result items project onto a Chat tool message. The
    /// terminal status domain is validated while the item is normalized, so an
    /// unregistered status fails the request instead of being carried as a
    /// finished result.
    pub(super) fn record_responses_tool_result_item(
        &mut self,
        object: &Map<String, Value>,
        item_type: &str,
        item_path: &str,
        message_index: usize,
    ) -> Result<(), String> {
        let call_id = object
            .get("call_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty());
        let name = object.get("name").and_then(Value::as_str);
        let payload = object.get("output").cloned().unwrap_or(Value::Null);
        let mut consumed = vec!["type", "output"];
        let mut extension = Map::new();
        extension.insert(
            "responses_tool_output_type".to_string(),
            Value::String(item_type.to_string()),
        );
        self.record_part_mapping(
            "input[].type",
            &format!("{item_path}.type"),
            &format!(
                "chat.messages[{message_index}].routecodex_chat_extension.responses_tool_output_type"
            ),
        );
        if let Some(call_id) = call_id {
            consumed.push("call_id");
            self.record_part_mapping(
                "input[].call_id",
                &format!("{item_path}.call_id"),
                &format!("chat.messages[{message_index}].tool_call_id"),
            );
        }
        self.record_responses_output_fields(object, item_path, message_index, &mut extension)?;
        let role = if call_id.is_some() { "tool" } else { "user" };
        if let Some(call_id) = call_id {
            self.record_part_siblings(object, item_path, &consumed);
            self.record_history_pairing_at_message(
                item_path,
                Some(call_id),
                name,
                item_type,
                None,
                Some(&payload),
                message_index,
            );
            self.messages.push(json!({
                "role": role,
                "tool_call_id": call_id,
                "content": payload,
                "routecodex_chat_extension": Value::Object(extension),
            }));
        } else {
            if let Some(name) = name {
                consumed.push("name");
                let extension_destination = format!(
                    "chat.messages[{message_index}].routecodex_chat_extension.responses_tool_output_name"
                );
                self.record_part_mapping(
                    "input[].name",
                    &format!("{item_path}.name"),
                    &extension_destination,
                );
                extension.insert(
                    "responses_tool_output_name".to_string(),
                    Value::String(name.to_string()),
                );
            }
            if object.contains_key("namespace") {
                consumed.push("namespace");
                let namespace = object.get("namespace").cloned().unwrap_or(Value::Null);
                self.record_part_mapping(
                    "input[].namespace",
                    &format!("{item_path}.namespace"),
                    &format!(
                        "chat.messages[{message_index}].routecodex_chat_extension.responses_tool_output_namespace"
                    ),
                );
                extension.insert("responses_tool_output_namespace".to_string(), namespace);
            }
            self.record_part_siblings(object, item_path, &consumed);
            self.record_history_pairing_at_message(
                item_path,
                None,
                name,
                item_type,
                object.get("namespace"),
                Some(&payload),
                message_index,
            );
            let mut message = Map::new();
            message.insert("role".to_string(), Value::String(role.to_string()));
            message.insert("content".to_string(), payload);
            message.insert(ROOT_CARRIER_KEY.to_string(), Value::Object(extension));
            self.messages.push(Value::Object(message));
        }
        Ok(())
    }

    pub(super) fn normalize_openai_tool_calls(
        &mut self,
        value: &Value,
        raw_path: &str,
        message_index: usize,
    ) -> Value {
        let Some(items) = value.as_array() else {
            self.record_opaque(raw_path, value);
            self.record_mapping_by_path(
                raw_path,
                &format!("chat.messages[{message_index}].tool_calls"),
                "routecodex.v3.field.lossless_preserve@1",
            );
            return value.clone();
        };
        Value::Array(
            items
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    let item_path = format!("{raw_path}[{index}]");
                    let Some(object) = item.as_object() else {
                        self.record_opaque(&item_path, item);
                        return item.clone();
                    };
                    let mut call = object.clone();
                    let call_id = object.get("id").and_then(Value::as_str);
                    let kind = object
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("function");
                    let name = object
                        .get(kind)
                        .and_then(Value::as_object)
                        .and_then(|payload| payload.get("name"))
                        .and_then(Value::as_str);
                    let payload_key = if kind == "custom" {
                        "input"
                    } else {
                        "arguments"
                    };
                    let payload = object
                        .get(kind)
                        .and_then(Value::as_object)
                        .and_then(|payload| payload.get(payload_key));
                    let call_base = format!("chat.messages[{message_index}].tool_calls[{index}]");
                    if object.contains_key("id") {
                        self.record_mapping_by_path(
                            &format!("{item_path}.id"),
                            &format!("{call_base}.id"),
                            "routecodex.v3.field.tool_identity_context@1",
                        );
                    }
                    if object.contains_key("type") {
                        self.record_mapping_by_path(
                            &format!("{item_path}.type"),
                            &format!("{call_base}.type"),
                            "routecodex.v3.field.part_type_value_map@1",
                        );
                    }
                    if object.contains_key("namespace") {
                        self.record_mapping_by_path(
                            &format!("{item_path}.namespace"),
                            &format!("{call_base}.namespace"),
                            "routecodex.v3.field.tool_identity_context@1",
                        );
                    }
                    self.record_history_pairing(
                        &item_path,
                        call_id,
                        name,
                        kind,
                        object.get("namespace"),
                        payload,
                    );
                    if let Some(payload) = object.get(kind).and_then(Value::as_object) {
                        if payload.contains_key("name") {
                            self.record_mapping_by_path(
                                &format!("{item_path}.{kind}.name"),
                                &format!("{call_base}.{kind}.name"),
                                "routecodex.v3.field.tool_identity_context@1",
                            );
                        }
                        if payload.contains_key(payload_key) {
                            self.record_mapping_by_path(
                                &format!("{item_path}.{kind}.{payload_key}"),
                                &format!("{call_base}.{kind}.{payload_key}"),
                                "routecodex.v3.field.opaque_tool_payload@1",
                            );
                        }
                        let mut normalized_payload = payload.clone();
                        if let Some(name) = payload.get("name").and_then(Value::as_str) {
                            normalized_payload.insert(
                                "name".to_string(),
                                Value::String(self.identity_name(kind, name)),
                            );
                        }
                        call.insert(kind.to_string(), Value::Object(normalized_payload));
                    }
                    Value::Object(call)
                })
                .collect(),
        )
    }

    pub(super) fn process_anthropic_message(&mut self, item: &Value, item_path: &str) {
        let Some(object) = item.as_object() else {
            self.record_opaque(item_path, item);
            self.messages.push(item.clone());
            return;
        };
        let message_index = self.messages.len();
        let role = object.get("role").and_then(Value::as_str).unwrap_or("user");
        let mut message = json!({
            "role": self.canonical_role(role, "messages[].role"),
            "content": Value::Null,
        });
        let mut tool_calls = Vec::new();
        let mut tool_messages = Vec::new();
        if let Some(content) = object.get("content") {
            match content {
                Value::String(text) => {
                    message["content"] = Value::String(text.clone());
                }
                Value::Array(blocks) => {
                    let mut canonical_blocks = Vec::new();
                    for (index, block) in blocks.iter().enumerate() {
                        let block_path = format!("{item_path}.content[{index}]");
                        let block_type = block
                            .get("type")
                            .and_then(Value::as_str)
                            .unwrap_or("opaque");
                        match block_type {
                            "text" | "input_text" => {
                                let content_index = canonical_blocks.len();
                                let part_base = format!(
                                    "chat.messages[{message_index}].content[{content_index}]"
                                );
                                self.with_history_context(
                                    Some(message_index),
                                    Some(content_index),
                                    None,
                                    |normalizer| {
                                        normalizer.record_part_mapping(
                                            "messages[].content[].type",
                                            &format!("{block_path}.type"),
                                            &format!("{part_base}.type"),
                                        );
                                        normalizer.record_part_mapping(
                                            "messages[].content[].text",
                                            &format!("{block_path}.text"),
                                            &format!("{part_base}.text"),
                                        );
                                    },
                                );
                                if let Some(block_object) = block.as_object() {
                                    self.record_part_siblings(
                                        block_object,
                                        &block_path,
                                        &["type", "text"],
                                    );
                                }
                                canonical_blocks.push(json!({
                                    "type": "text",
                                    "text": block.get("text").cloned().unwrap_or(Value::Null),
                                }));
                            }
                            "image" => {
                                let part = self.with_history_context(
                                    Some(message_index),
                                    Some(canonical_blocks.len()),
                                    None,
                                    |normalizer| {
                                        normalizer.anthropic_media_block(block, &block_path, false)
                                    },
                                );
                                canonical_blocks.push(part);
                            }
                            "document" => {
                                let part = self.with_history_context(
                                    Some(message_index),
                                    Some(canonical_blocks.len()),
                                    None,
                                    |normalizer| {
                                        normalizer.anthropic_media_block(block, &block_path, true)
                                    },
                                );
                                canonical_blocks.push(part);
                            }
                            "tool_use" | "server_tool_use" => {
                                let call_id = block.get("id").and_then(Value::as_str);
                                let name = block.get("name").and_then(Value::as_str);
                                let payload = block.get("input");
                                let call_index = tool_calls.len();
                                let call_base = format!(
                                    "chat.messages[{message_index}].tool_calls[{call_index}]"
                                );
                                self.with_history_context(
                                    Some(message_index),
                                    None,
                                    Some(call_index),
                                    |normalizer| {
                                        if block.get("id").is_some() {
                                            normalizer.record_part_mapping(
                                                "messages[].content[].id",
                                                &format!("{block_path}.id"),
                                                &format!("{call_base}.id"),
                                            );
                                        }
                                        if block.get("name").is_some() {
                                            normalizer.record_part_mapping(
                                                "messages[].content[].name",
                                                &format!("{block_path}.name"),
                                                &format!("{call_base}.function.name"),
                                            );
                                        }
                                        if block.get("input").is_some() {
                                            normalizer.record_part_mapping(
                                                "messages[].content[].input",
                                                &format!("{block_path}.input"),
                                                &format!("{call_base}.function.arguments"),
                                            );
                                        }
                                    },
                                );
                                if let Some(block_object) = block.as_object() {
                                    self.record_part_siblings(
                                        block_object,
                                        &block_path,
                                        &["type", "id", "name", "input"],
                                    );
                                }
                                self.record_history_pairing(
                                    &block_path,
                                    call_id,
                                    name,
                                    "function",
                                    None,
                                    payload,
                                );
                                tool_calls.push(json!({
                                    "id": call_id,
                                    "type": "function",
                                    "function": {
                                        "name": name,
                                        "arguments": payload.cloned().unwrap_or(Value::Null),
                                    },
                                }));
                            }
                            "tool_result" => {
                                let call_id = block.get("tool_use_id").and_then(Value::as_str);
                                let payload = block.get("content").cloned().unwrap_or(Value::Null);
                                let tool_message_index = message_index + 1 + tool_messages.len();
                                self.with_history_context(
                                    Some(tool_message_index),
                                    None,
                                    None,
                                    |normalizer| {
                                        if block.get("tool_use_id").is_some() {
                                            normalizer.record_part_mapping(
                                                "messages[].content[].tool_use_id",
                                                &format!("{block_path}.tool_use_id"),
                                                &format!(
                                                    "chat.messages[{tool_message_index}].tool_call_id"
                                                ),
                                            );
                                        }
                                        if block.get("content").is_some() {
                                            normalizer.record_part_mapping(
                                                "messages[].content[].content",
                                                &format!("{block_path}.content"),
                                                &format!(
                                                    "chat.messages[{tool_message_index}].content"
                                                ),
                                            );
                                        }
                                    },
                                );
                                if let Some(block_object) = block.as_object() {
                                    self.record_part_siblings(
                                        block_object,
                                        &block_path,
                                        &["type", "tool_use_id", "content"],
                                    );
                                }
                                self.record_history_pairing_at_message(
                                    &block_path,
                                    call_id,
                                    None,
                                    "tool_result",
                                    None,
                                    Some(&payload),
                                    tool_message_index,
                                );
                                tool_messages.push(json!({
                                    "role": "tool",
                                    "tool_call_id": call_id,
                                    "content": payload,
                                }));
                            }
                            "thinking" => {
                                if let Some(block_object) = block.as_object() {
                                    self.record_part_siblings(
                                        block_object,
                                        &block_path,
                                        &["type", "thinking", "signature"],
                                    );
                                }
                                canonical_blocks.push(json!({
                                    "type": "thinking",
                                    "thinking": block.get("thinking").cloned().unwrap_or(Value::Null),
                                    "signature": block.get("signature").cloned().unwrap_or(Value::Null),
                                }));
                            }
                            _ => {
                                self.record_opaque(&block_path, block);
                                canonical_blocks.push(block.clone());
                            }
                        }
                    }
                    message["content"] = Value::Array(canonical_blocks);
                }
                _ => {
                    self.record_opaque(&format!("{item_path}.content"), content);
                    message["content"] = content.clone();
                }
            }
        }
        for (key, value) in object {
            if key == "role" || key == "content" {
                continue;
            }
            self.record_opaque(&format!("{item_path}.{key}"), value);
        }
        if !tool_calls.is_empty() {
            message["tool_calls"] = Value::Array(tool_calls);
        }
        self.messages.push(message);
        self.messages.extend(tool_messages);
    }

    pub(super) fn anthropic_media_block(
        &mut self,
        block: &Value,
        block_path: &str,
        document: bool,
    ) -> Value {
        let source = block.get("source").and_then(Value::as_object);
        let source_type = source
            .and_then(|source| source.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("opaque");
        let source_key = match source_type {
            "url" => "url",
            "base64" => "data",
            _ => {
                self.record_opaque(block_path, block);
                return block.clone();
            }
        };
        let Some(data) = source.and_then(|source| source.get(source_key)) else {
            self.record_opaque(block_path, block);
            return block.clone();
        };
        if let Some(object) = block.as_object() {
            self.record_part_siblings(object, block_path, &["type", "source", "title"]);
            if let Some(source) = object.get("source").and_then(Value::as_object) {
                self.record_part_siblings(
                    source,
                    &format!("{block_path}.source"),
                    &["type", "url", "data", "media_type"],
                );
            }
        }
        let destination = match (document, source_type) {
            (true, "url") => "file.file_url",
            (true, _) => "file.file_data",
            (false, "url") => "image_url.url",
            (false, _) => "media.inline_data",
        };
        self.record_part_mapping(
            &format!("messages[].content[].source.{source_key}"),
            &format!("{block_path}.source.{source_key}"),
            destination,
        );
        let mut part = if document {
            let file_key = if source_type == "url" {
                "file_url"
            } else {
                "file_data"
            };
            let mut file = serde_json::Map::new();
            file.insert(file_key.to_string(), data.clone());
            if let Some(title) = block.get("title") {
                file.insert("filename".to_string(), title.clone());
                self.record_part_mapping(
                    "messages[].content[].title",
                    &format!("{block_path}.title"),
                    "file.filename",
                );
            }
            json!({"type": "file", "file": file})
        } else if source_type == "url" {
            json!({"type": "image_url", "image_url": {"url": data}})
        } else {
            json!({"type": "image", "media": {"inline_data": data}})
        };
        if let Some(mime) = source.and_then(|source| source.get("media_type")) {
            part["media"]["mime_type"] = mime.clone();
            self.record_part_mapping(
                "messages[].content[].source.media_type",
                &format!("{block_path}.source.media_type"),
                "media.mime_type",
            );
        }
        part
    }
}

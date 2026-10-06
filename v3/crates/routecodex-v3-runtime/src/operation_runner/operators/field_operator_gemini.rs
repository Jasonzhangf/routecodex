use serde_json::{json, Map, Value};

use super::field_operator_helpers::map_gemini_tool_choice;
use super::field_operator_library::{RequestNormalizer, ROOT_CARRIER_KEY};
use super::field_operator_profiles::{child_lookup_path, FieldOperatorKind, ProfileRow};
use super::project_canonical_paths::field_path;

/// Gemini-specific client-request field handlers. Dispatch into these methods
/// is selected by the registered `client_request_to_chat` transform_id on the
/// field-profile row, never by the entry protocol name.
impl<'a> RequestNormalizer<'a> {
    pub(super) fn process_gemini_tool(
        &mut self,
        item: &Value,
        item_path: &str,
        output: &mut Vec<Value>,
    ) {
        let Some(object) = item.as_object() else {
            self.record_opaque(item_path, item);
            self.record_mapping_by_path(
                item_path,
                &format!("chat.tools[{}]", output.len()),
                "routecodex.v3.field.tool_declaration_transform@1",
            );
            output.push(item.clone());
            return;
        };
        self.record_opaque_once(item_path, item);
        if let Some(declarations) = object.get("functionDeclarations").and_then(Value::as_array) {
            for (index, declaration) in declarations.iter().enumerate() {
                let declaration_path = format!("{item_path}.functionDeclarations[{index}]");
                let Some(declaration_object) = declaration.as_object() else {
                    self.record_opaque(&declaration_path, declaration);
                    self.record_mapping_by_path(
                        &declaration_path,
                        &format!("chat.tools[{}]", output.len()),
                        "routecodex.v3.field.tool_declaration_transform@1",
                    );
                    output.push(declaration.clone());
                    continue;
                };
                let name = declaration_object.get("name").and_then(Value::as_str);
                let mut function = Map::new();
                if let Some(name) = name {
                    function.insert("name".to_string(), Value::String(name.to_string()));
                }
                if let Some(description) = declaration_object.get("description") {
                    function.insert("description".to_string(), description.clone());
                }
                if let Some(parameters) = declaration_object.get("parameters") {
                    function.insert("parameters".to_string(), parameters.clone());
                }
                if let Some(parameters) = declaration_object.get("parametersJsonSchema") {
                    function.insert("parameters".to_string(), parameters.clone());
                }
                if let Some(response) = declaration_object.get("response") {
                    function.insert("response".to_string(), response.clone());
                }
                if let Some(response) = declaration_object.get("responseJsonSchema") {
                    function.insert("responseJsonSchema".to_string(), response.clone());
                }
                if let Some(behavior) = declaration_object.get("behavior") {
                    function.insert("behavior".to_string(), behavior.clone());
                }
                self.push_tool_declaration(&declaration_path, "function", name, None, declaration);
                self.record_mapping_by_path(
                    &declaration_path,
                    &format!("chat.tools[{}]", output.len()),
                    "routecodex.v3.field.tool_declaration_transform@1",
                );
                output.push(json!({
                    "type": "function",
                    "function": Value::Object(function),
                    "extension": {"raw_declaration": declaration.clone()},
                }));
            }
            // Fields beside `functionDeclarations` (including the empty-array
            // case) stay in the inverse context at their exact path.
            self.record_part_siblings(object, item_path, &["functionDeclarations"]);
            return;
        }

        let kind = object
            .keys()
            .find(|key| key.as_str() != "functionDeclarations")
            .map(String::as_str)
            .unwrap_or("gemini_tool");
        self.push_tool_declaration(item_path, kind, None, None, item);
        // Native hosted tools have no standard Chat declaration. Their current
        // data stays in the existing lossless extension; the typed association
        // lets the native emitter consume it without rereading a raw request.
        let record_index = self
            .opaque_records
            .iter()
            .position(|record| record.get("path").and_then(Value::as_str) == Some(item_path))
            .expect("native tool record was emitted above");
        self.record_mapping_by_path(
            item_path,
            &format!("chat.{ROOT_CARRIER_KEY}.chat_extension_opaque_record[{record_index}].value"),
            "routecodex.v3.field.tool_declaration_transform@1",
        );
    }

    pub(super) fn process_gemini_tool_config(
        &mut self,
        value: &Value,
        row: &ProfileRow,
        raw_path: &str,
    ) {
        self.record_opaque_once(raw_path, value);
        self.record_mapping(row, raw_path, "chat.tool_choice", "json");
        let function_config = value
            .get("functionCallingConfig")
            .cloned()
            .unwrap_or(Value::Null);
        let choice = map_gemini_tool_choice(&function_config);
        self.canonical.insert("tool_choice".to_string(), choice);
        self.insert_extension_value("gemini_request", "toolConfig", value.clone());
        self.record_mapping_by_path(
            &format!("{raw_path}.functionCallingConfig.allowedFunctionNames"),
            "chat.routecodex_chat_extension.gemini_request.toolConfig.functionCallingConfig.allowedFunctionNames",
            "lossless_preserve",
        );
        if let Some(function_config) = value
            .get("functionCallingConfig")
            .and_then(Value::as_object)
        {
            for (key, child) in function_config {
                if key == "mode" || key == "allowedFunctionNames" {
                    continue;
                }
                self.record_opaque_once(&format!("{raw_path}.functionCallingConfig.{key}"), child);
            }
        }
    }

    pub(super) fn process_generation_config(
        &mut self,
        value: &Value,
        row: &ProfileRow,
        raw_path: &str,
    ) {
        self.record_opaque_once(raw_path, value);
        self.record_mapping(row, raw_path, "chat.generation_config", "json");
        let Some(object) = value.as_object() else {
            self.record_opaque(raw_path, value);
            self.insert_extension_value("gemini_request", "generationConfig", value.clone());
            return;
        };
        for (key, child) in object {
            let child_lookup = child_lookup_path("generationConfig", key);
            let child_raw_path = field_path(raw_path, key);
            let Some(child_row) = self.profiles.row(&self.protocol, &child_lookup).cloned() else {
                self.record_opaque(&child_raw_path, child);
                self.record_mapping_by_path(
                    &child_raw_path,
                    &field_path(
                        "chat.routecodex_chat_extension.gemini_request",
                        &format!("generationConfig.{key}"),
                    ),
                    "routecodex.v3.field.lossless_preserve@1",
                );
                self.insert_extension_value(
                    "gemini_request",
                    &format!("generationConfig.{key}"),
                    child.clone(),
                );
                continue;
            };
            if child_row.dispatch_kind == Some(FieldOperatorKind::TokenLimitRename) {
                self.process_token_limit(child, &child_row, &child_raw_path);
                continue;
            }
            let destination = match key.as_str() {
                "candidateCount" => "n",
                "frequencyPenalty" => "frequency_penalty",
                "maxOutputTokens" => "max_completion_tokens",
                "presencePenalty" => "presence_penalty",
                "stopSequences" => "stop",
                "topP" => "top_p",
                value => value,
            };
            let transformed =
                self.apply_leaf_operator(&child_row, child, &child_raw_path, destination);
            self.canonical.insert(destination.to_string(), transformed);
        }
    }

    pub(super) fn process_gemini_message(&mut self, item: &Value, item_path: &str) {
        let Some(object) = item.as_object() else {
            self.record_opaque(item_path, item);
            self.messages.push(item.clone());
            return;
        };
        let message_index = self.messages.len();
        let role = object.get("role").and_then(Value::as_str).unwrap_or("user");
        let mut message = json!({
            "role": self.canonical_role(role, "contents[].role"),
            "content": Value::Null,
        });
        let mut tool_calls = Vec::new();
        let mut tool_messages = Vec::new();
        match object.get("parts") {
            Some(Value::Array(parts)) => {
                let mut content_parts = Vec::new();
                for (index, part) in parts.iter().enumerate() {
                    let part_path = format!("{item_path}.parts[{index}]");
                    let Some(part_object) = part.as_object() else {
                        self.record_opaque(&part_path, part);
                        content_parts.push(part.clone());
                        continue;
                    };
                    if let Some(text) = part_object.get("text") {
                        let content_index = content_parts.len();
                        self.with_history_context(
                            Some(message_index),
                            Some(content_index),
                            None,
                            |normalizer| {
                                normalizer.record_part_mapping(
                                    "contents[].parts[].text",
                                    &format!("{part_path}.text"),
                                    &format!(
                                        "chat.messages[{message_index}].content[{content_index}].text"
                                    ),
                                );
                            },
                        );
                        self.record_part_siblings(part_object, &part_path, &["text"]);
                        content_parts.push(json!({"type": "text", "text": text}));
                        continue;
                    }
                    if let Some(inline) = part_object.get("inlineData").and_then(Value::as_object) {
                        let data = inline.get("data").and_then(Value::as_str);
                        let mime_type = inline.get("mimeType");
                        if let Some(data) = data {
                            if mime_type.map_or(true, Value::is_string) {
                                let content_index = content_parts.len();
                                let part_base = format!(
                                    "chat.messages[{message_index}].content[{content_index}]"
                                );
                                self.with_history_context(
                                    Some(message_index),
                                    Some(content_index),
                                    None,
                                    |normalizer| {
                                        normalizer.record_part_mapping(
                                            "contents[].parts[].inlineData.data",
                                            &format!("{part_path}.inlineData.data"),
                                            &format!("{part_base}.media.inline_data"),
                                        );
                                    },
                                );
                                let mut media = Map::new();
                                media.insert(
                                    "inline_data".to_string(),
                                    Value::String(data.to_string()),
                                );
                                if let Some(mime_type) = mime_type.and_then(Value::as_str) {
                                    self.with_history_context(
                                        Some(message_index),
                                        Some(content_index),
                                        None,
                                        |normalizer| {
                                            normalizer.record_part_mapping(
                                                "contents[].parts[].inlineData.mimeType",
                                                &format!("{part_path}.inlineData.mimeType"),
                                                &format!("{part_base}.media.mime_type"),
                                            );
                                        },
                                    );
                                    media.insert(
                                        "mime_type".to_string(),
                                        Value::String(mime_type.to_string()),
                                    );
                                }
                                self.record_part_siblings(
                                    inline,
                                    &format!("{part_path}.inlineData"),
                                    &["data", "mimeType"],
                                );
                                self.record_part_siblings(part_object, &part_path, &["inlineData"]);
                                content_parts.push(json!({
                                    "type": "media",
                                    "media": Value::Object(media),
                                }));
                                continue;
                            }
                        }
                        // Keep non-string values and the complete inlineData
                        // container opaque instead of inventing a media type.
                        self.record_opaque(
                            &format!("{part_path}.inlineData"),
                            &Value::Object(inline.clone()),
                        );
                        self.record_part_siblings(inline, &format!("{part_path}.inlineData"), &[]);
                        self.record_part_siblings(part_object, &part_path, &["inlineData"]);
                        content_parts.push(part.clone());
                        continue;
                    }
                    if let Some(file) = part_object.get("fileData").and_then(Value::as_object) {
                        let content_index = content_parts.len();
                        let part_base =
                            format!("chat.messages[{message_index}].content[{content_index}]");
                        self.with_history_context(
                            Some(message_index),
                            Some(content_index),
                            None,
                            |normalizer| {
                                normalizer.record_part_mapping(
                                    "contents[].parts[].fileData.fileUri",
                                    &format!("{part_path}.fileData.fileUri"),
                                    &format!("{part_base}.file.file_url"),
                                );
                                normalizer.record_part_mapping(
                                    "contents[].parts[].fileData.mimeType",
                                    &format!("{part_path}.fileData.mimeType"),
                                    &format!("{part_base}.file.mime_type"),
                                );
                            },
                        );
                        self.record_part_siblings(
                            file,
                            &format!("{part_path}.fileData"),
                            &["fileUri", "mimeType"],
                        );
                        self.record_part_siblings(part_object, &part_path, &["fileData"]);
                        content_parts.push(json!({
                            "type": "file",
                            "file": {
                                "file_url": file.get("fileUri").cloned().unwrap_or(Value::Null),
                                "mime_type": file.get("mimeType").cloned().unwrap_or(Value::Null),
                            },
                        }));
                        continue;
                    }
                    if let Some(call) = part_object.get("functionCall").and_then(Value::as_object) {
                        let call_id = call.get("id").and_then(Value::as_str);
                        let name = call.get("name").and_then(Value::as_str);
                        let payload = call.get("args");
                        let call_index = tool_calls.len();
                        let call_base =
                            format!("chat.messages[{message_index}].tool_calls[{call_index}]");
                        self.with_history_context(
                            Some(message_index),
                            None,
                            Some(call_index),
                            |normalizer| {
                                if call.contains_key("id") {
                                    normalizer.record_part_mapping(
                                        "contents[].parts[].functionCall.id",
                                        &format!("{part_path}.functionCall.id"),
                                        &format!("{call_base}.id"),
                                    );
                                }
                                if call.contains_key("name") {
                                    normalizer.record_part_mapping(
                                        "contents[].parts[].functionCall.name",
                                        &format!("{part_path}.functionCall.name"),
                                        &format!("{call_base}.function.name"),
                                    );
                                }
                                if call.contains_key("args") {
                                    normalizer.record_part_mapping(
                                        "contents[].parts[].functionCall.args",
                                        &format!("{part_path}.functionCall.args"),
                                        &format!("{call_base}.function.arguments"),
                                    );
                                }
                            },
                        );
                        self.record_part_siblings(
                            call,
                            &format!("{part_path}.functionCall"),
                            &["id", "name", "args"],
                        );
                        self.record_part_siblings(part_object, &part_path, &["functionCall"]);
                        self.record_history_pairing(
                            &part_path, call_id, name, "function", None, payload,
                        );
                        tool_calls.push(json!({
                            "id": call_id,
                            "type": "function",
                            "function": {
                                "name": name,
                                "arguments": payload.cloned().unwrap_or(Value::Null),
                            },
                        }));
                        continue;
                    }
                    if let Some(response) = part_object
                        .get("functionResponse")
                        .and_then(Value::as_object)
                    {
                        let call_id = response
                            .get("id")
                            .and_then(Value::as_str)
                            .filter(|value| !value.is_empty());
                        let name = response
                            .get("name")
                            .and_then(Value::as_str)
                            .filter(|value| !value.is_empty());
                        let payload = response.get("response").cloned().unwrap_or(Value::Null);
                        let tool_message_index = message_index + 1 + tool_messages.len();
                        self.with_history_context(
                            Some(tool_message_index),
                            None,
                            None,
                            |normalizer| {
                                if call_id.is_some() {
                                    normalizer.record_part_mapping(
                                        "contents[].parts[].functionResponse.id",
                                        &format!("{part_path}.functionResponse.id"),
                                        &format!(
                                            "chat.messages[{tool_message_index}].tool_call_id"
                                        ),
                                    );
                                }
                                if call_id.is_none() && name.is_some() {
                                    normalizer.record_part_mapping(
                                        "contents[].parts[].functionResponse.name",
                                        &format!("{part_path}.functionResponse.name"),
                                        &format!(
                                            "chat.messages[{tool_message_index}].routecodex_chat_extension.responses_tool_output_name"
                                        ),
                                    );
                                }
                                if response.contains_key("response") {
                                    normalizer.record_part_mapping(
                                        "contents[].parts[].functionResponse.response",
                                        &format!("{part_path}.functionResponse.response"),
                                        &format!("chat.messages[{tool_message_index}].content"),
                                    );
                                }
                            },
                        );
                        let consumed = if call_id.is_some() {
                            vec!["id", "response"]
                        } else if name.is_some() {
                            vec!["name", "response"]
                        } else {
                            vec!["response"]
                        };
                        self.record_part_siblings(
                            response,
                            &format!("{part_path}.functionResponse"),
                            &consumed,
                        );
                        self.record_part_siblings(part_object, &part_path, &["functionResponse"]);
                        self.record_history_pairing_at_message(
                            &part_path,
                            call_id,
                            name,
                            "tool_result",
                            None,
                            Some(&payload),
                            tool_message_index,
                        );
                        let role = if call_id.is_some() { "tool" } else { "user" };
                        let mut tool_message = Map::new();
                        tool_message.insert("role".to_string(), Value::String(role.to_string()));
                        if let Some(call_id) = call_id {
                            tool_message.insert(
                                "tool_call_id".to_string(),
                                Value::String(call_id.to_string()),
                            );
                        } else {
                            let mut extension = Map::new();
                            extension.insert(
                                "responses_tool_output_type".to_string(),
                                Value::String("functionResponse".to_string()),
                            );
                            if let Some(name) = name {
                                extension.insert(
                                    "responses_tool_output_name".to_string(),
                                    Value::String(name.to_string()),
                                );
                            }
                            tool_message
                                .insert(ROOT_CARRIER_KEY.to_string(), Value::Object(extension));
                        }
                        tool_message.insert("content".to_string(), payload);
                        tool_messages.push(Value::Object(tool_message));
                        continue;
                    }
                    // Unrecognized part: preserve every business field at its exact
                    // indexed path so the inverse context can restore it verbatim.
                    let content_index = content_parts.len();
                    for (key, value) in part_object {
                        let key_path = field_path(&part_path, key);
                        self.record_opaque(&key_path, value);
                        self.with_history_context(
                            Some(message_index),
                            Some(content_index),
                            None,
                            |normalizer| {
                                normalizer.record_mapping_by_path(
                                    &key_path,
                                    &field_path(
                                        &format!(
                                            "chat.messages[{message_index}].content[{content_index}]"
                                        ),
                                        key,
                                    ),
                                    "routecodex.v3.field.lossless_preserve@1",
                                );
                            },
                        );
                    }
                    content_parts.push(part.clone());
                }
                message["content"] = Value::Array(content_parts);
            }
            Some(other) => {
                self.record_opaque(&format!("{item_path}.parts"), other);
                message["content"] = other.clone();
            }
            None => {}
        }
        for (key, value) in object {
            if key == "role" || key == "parts" {
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
}

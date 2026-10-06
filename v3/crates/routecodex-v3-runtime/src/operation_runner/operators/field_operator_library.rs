use serde_json::{json, Map, Value};
use std::sync::OnceLock;

use super::field_operator_helpers::{
    map_gemini_tool_choice, map_role_for_transform, map_tool_choice_scalar, map_tool_choice_value,
};
use super::field_operator_instructions::{InstructionSource, SystemInstructionBuilder};
use super::field_operator_history::canonical_tool_call_name;
use super::field_operator_profiles::{
    array_item_lookup_path, canonical_child_key_for_row, canonical_key_for_row, child_lookup_path,
    lookup_path, normalize_protocol, FieldOperatorKind, FoldRegistration,
    ProfileIndex, ProfileRow, CLIENT_REQUEST_DIRECTION,
};
use super::field_operator_records::{append_history_relative, MessageSourceRange};
use super::field_operator_responses_declaration::HostedToolDeclaration;
use super::project_canonical_paths::{field_path, write_path};
const FIELD_PROFILES_YAML: &str = include_str!(
    "../../../../../../docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml"
);

/// The generated Chat carrier and any raw client field with this name share one
/// root identity. A raw conflict is preserved as opaque; generated extension
/// data always owns the canonical root value.
pub(super) const ROOT_CARRIER_KEY: &str = "routecodex_chat_extension";

#[derive(Debug, PartialEq)]
pub(super) struct ClientRequestNormalization {
    pub canonical_request: Value,
    pub inverse_context: Value,
    pub explicit_history_pairing: Value,
}

pub fn normalize_client_request(
    protocol: &str,
    raw: &Value,
) -> Result<ClientRequestNormalization, String> {
    let entry_protocol = protocol.to_string();
    let protocol = normalize_protocol(protocol);
    let profiles = profile_index()?;
    if !profiles.has_protocol(&protocol) {
        return Err(format!(
            "field-profile manifest has no `{CLIENT_REQUEST_DIRECTION}` rows for protocol `{entry_protocol}`"
        ));
    }

    let mut normalizer = RequestNormalizer::new(entry_protocol, protocol, profiles);
    normalizer.normalize(raw)?;
    Ok(normalizer.finish())
}

pub(super) fn profile_index() -> Result<&'static ProfileIndex, String> {
    static PROFILE_INDEX: OnceLock<Result<ProfileIndex, String>> = OnceLock::new();
    match PROFILE_INDEX.get_or_init(|| ProfileIndex::parse(FIELD_PROFILES_YAML)) {
        Ok(index) => Ok(index),
        Err(error) => Err(error.clone()),
    }
}

pub(super) struct RequestNormalizer<'a> {
    pub(super) entry_protocol: String,
    pub(super) protocol: String,
    pub(super) profiles: &'a ProfileIndex,
    pub(super) canonical: Map<String, Value>,
    pub(super) messages: Vec<Value>,
    pub(super) message_sources: Vec<MessageSourceRange>,
    pub(super) history_fold: Option<&'a FoldRegistration>,
    pub(super) system_instructions: SystemInstructionBuilder,
    pub(super) provenance: Vec<Value>,
    pub(super) opaque_records: Vec<Value>,
    pub(super) tool_declarations: Vec<Value>,
    pub(super) hosted_tool_declarations: Vec<HostedToolDeclaration>,
    pub(super) history_pairing: Vec<Value>,
    pub(super) extension_responses_include: Option<Value>,
    pub(super) next_opaque_record: usize,
    pub(super) history_message_index: Option<usize>,
    pub(super) history_part_index: Option<usize>,
    pub(super) history_call_index: Option<usize>,
}

impl<'a> RequestNormalizer<'a> {
    fn new(entry_protocol: String, protocol: String, profiles: &'a ProfileIndex) -> Self {
        let history_fold = profiles.request_history_fold(&protocol);
        Self {
            entry_protocol,
            protocol,
            profiles,
            canonical: Map::new(),
            messages: Vec::new(),
            message_sources: Vec::new(),
            history_fold,
            system_instructions: SystemInstructionBuilder::default(),
            provenance: Vec::new(),
            opaque_records: Vec::new(),
            tool_declarations: Vec::new(),
            hosted_tool_declarations: Vec::new(),
            history_pairing: Vec::new(),
            extension_responses_include: None,
            next_opaque_record: 0,
            history_message_index: None,
            history_part_index: None,
            history_call_index: None,
        }
    }

    fn normalize(&mut self, raw: &Value) -> Result<(), String> {
        let Some(raw_object) = raw.as_object() else {
            self.record_opaque("$", raw);
            self.canonical
                .insert(ROOT_CARRIER_KEY.to_string(), self.extension_value());
            return Ok(());
        };

        for (key, value) in raw_object {
            if key == ROOT_CARRIER_KEY {
                self.record_opaque(&format!("request.{key}"), value);
                continue;
            }
            let lookup_path = lookup_path(key);
            let row = self.profiles.row(&self.protocol, &lookup_path).cloned();
            let has_descendant = self.profiles.has_descendant(&self.protocol, &lookup_path);
            match (row, has_descendant) {
                (Some(row), _) => self.process_top_level_field(key, value, &row)?,
                (None, true) => {
                    self.process_known_container(key, value);
                    if self
                        .canonical
                        .get(key)
                        .and_then(Value::as_object)
                        .is_some_and(|object| object.is_empty())
                    {
                        self.canonical.remove(key);
                    }
                }
                (None, false) => {
                    let source = field_path("request", key);
                    self.record_opaque(&source, value);
                    self.record_mapping_by_path(
                        &source,
                        &field_path("chat", key),
                        "routecodex.v3.field.lossless_preserve@1",
                    );
                    self.canonical.insert(key.to_string(), value.clone());
                }
            }
        }
        self.flush_hosted_tool_declarations();
        Ok(())
    }

    fn finish(mut self) -> ClientRequestNormalization {
        let history_indices = self.finalize_message_history().unwrap_or_else(|| {
            (0..self.messages.len())
                .map(|index| (index, index))
                .collect()
        });
        let message_count_before_system_flush = self.messages.len();
        let system_instruction_index = self.flush_system_instructions();
        let system_prefix_shift = self
            .messages
            .len()
            .saturating_sub(message_count_before_system_flush);
        self.remap_history_references(&history_indices, system_prefix_shift);
        if let Some(canonical_index) = system_instruction_index {
            self.finalize_instruction_source_mappings(canonical_index);
        }
        let messages = std::mem::take(&mut self.messages);
        self.canonical
            .insert("messages".to_string(), Value::Array(messages));
        let mut extension = self.take_extension_object();
        if let Some(include) = self.extension_responses_include.take() {
            let responses_request = extension
                .entry("responses_request".to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            match responses_request {
                Value::Object(object) => {
                    if let Some(existing) = object.insert("include".to_string(), include) {
                        self.record_opaque_once(
                            "request.routecodex_chat_extension.responses_request.include",
                            &existing,
                        );
                    }
                }
                other => {
                    let existing = std::mem::replace(other, json!({"include": include}));
                    self.record_opaque_once(
                        "request.routecodex_chat_extension.responses_request",
                        &existing,
                    );
                }
            }
        }
        if let Some(existing) = extension.remove("chat_extension_opaque_record") {
            self.record_opaque_once(
                "request.routecodex_chat_extension.chat_extension_opaque_record",
                &existing,
            );
        }
        if !self.opaque_records.is_empty() {
            extension.insert(
                "chat_extension_opaque_record".to_string(),
                Value::Array(self.opaque_records.clone()),
            );
        }
        self.canonical
            .insert(ROOT_CARRIER_KEY.to_string(), Value::Object(extension));

        let mut inverse = Map::new();
        inverse.insert(
            "entry_protocol".to_string(),
            Value::String(self.entry_protocol.clone()),
        );
        inverse.insert(
            "normalized_protocol".to_string(),
            Value::String(self.protocol),
        );
        inverse.insert("field_mappings".to_string(), Value::Array(self.provenance));
        inverse.insert(
            "opaque_record_references".to_string(),
            Value::Array(
                self.opaque_records
                    .iter()
                    .filter_map(|record| record.as_object())
                    .map(|record| {
                        let mut reference = Map::new();
                        if let Some(record_id) = record.get("record_id") {
                            reference.insert("record_id".to_string(), record_id.clone());
                        }
                        if let Some(path) = record.get("path") {
                            reference.insert("path".to_string(), path.clone());
                        }
                        if let Some(encoding) = record.get("encoding") {
                            reference.insert("encoding".to_string(), encoding.clone());
                        }
                        Value::Object(reference)
                    })
                    .collect(),
            ),
        );
        inverse.insert(
            "tool_declarations".to_string(),
            Value::Array(self.tool_declarations),
        );

        let explicit_history_pairing = json!({
            "entry_protocol": self.entry_protocol,
            "messages": self.history_pairing,
        });
        ClientRequestNormalization {
            canonical_request: Value::Object(self.canonical),
            inverse_context: Value::Object(inverse),
            explicit_history_pairing,
        }
    }

    fn process_top_level_field(
        &mut self,
        key: &str,
        value: &Value,
        row: &ProfileRow,
    ) -> Result<(), String> {
        let raw_path = format!("request.{key}");
        let kind = row.dispatch_kind.ok_or_else(|| {
            format!(
                "profile row `{}` has no dispatch operator",
                row.profile_path
            )
        })?;
        match kind {
            FieldOperatorKind::InstructionsToSystemMessage => {
                self.process_instructions(value, row, &raw_path);
            }
            FieldOperatorKind::TokenLimitRename => {
                self.process_token_limit(value, row, &raw_path);
            }
            FieldOperatorKind::ResponsesIncludeTransform => {
                self.process_include(value, row, &raw_path);
            }
            FieldOperatorKind::ToolDeclarationTransform => {
                self.process_tools(value, row, &raw_path);
            }
            FieldOperatorKind::ToolChoiceShapeBranch | FieldOperatorKind::ToolChoiceValueMap => {
                self.process_tool_choice(value, row, &raw_path);
            }
            FieldOperatorKind::RequestInputShapeBranch => {
                self.process_responses_input(value, row, &raw_path);
            }
            FieldOperatorKind::ArrayContainerShape => {
                self.process_array_container(value, row, &raw_path)?;
            }
            _ => {
                if let Some(destination) = row
                    .binding()
                    .and_then(|binding| binding.destination.as_deref())
                    .filter(|destination| destination.starts_with("chat."))
                {
                    let transformed = self.apply_leaf_operator(row, value, &raw_path, destination);
                    let mut root = Value::Object(std::mem::take(&mut self.canonical));
                    write_path(&mut root, destination, transformed)?;
                    self.canonical = root
                        .as_object()
                        .expect("registered Chat destination retains the canonical object")
                        .clone();
                } else {
                    let destination = canonical_key_for_row(row, key);
                    let transformed = self.apply_leaf_operator(row, value, &raw_path, &destination);
                    self.canonical.insert(destination, transformed);
                }
            }
        }
        Ok(())
    }

    fn process_array_container(
        &mut self,
        value: &Value,
        row: &ProfileRow,
        raw_path: &str,
    ) -> Result<(), String> {
        let transform_id = row.transform_id().ok_or_else(|| {
            format!(
                "array container `{}` has no client_request_to_chat transform_id",
                row.profile_path
            )
        })?;
        match transform_id {
            "v3.openai_chat_messages_to_chat_messages.v1"
            | "v3.anthropic_messages_to_chat_messages.v1"
            | "v3.gemini_contents_to_chat_messages.v1" => {
                self.process_messages(value, row, raw_path)?;
            }
            "v3.gemini_system_instruction_to_chat_system.v1" => {
                self.process_system_instruction(value, row, raw_path);
            }
            "v3.gemini_generation_config_to_chat_generation_config.v1" => {
                self.process_generation_config(value, row, raw_path);
            }
            "v3.gemini_tool_config_to_chat_tool_choice.v1" => {
                self.process_gemini_tool_config(value, row, raw_path);
            }
            _ => {
                return Err(format!(
                    "no handler registered for transform_id `{transform_id}` on `{}`",
                    row.profile_path
                ));
            }
        }
        Ok(())
    }

    pub(super) fn transform_known_value(
        &mut self,
        lookup_path: &str,
        value: &Value,
        raw_path: &str,
    ) -> Value {
        match value {
            Value::Object(object) => {
                let mut output = Map::new();
                for (key, child) in object {
                    let child_lookup = child_lookup_path(lookup_path, key);
                    let child_raw_path = format!("{raw_path}.{key}");
                    if let Some(row) = self.profiles.row(&self.protocol, &child_lookup).cloned() {
                        if let Some(destination) = row
                            .binding()
                            .and_then(|binding| binding.destination.as_deref())
                        {
                            let transformed =
                                self.apply_leaf_operator(&row, child, &child_raw_path, destination);
                            let mut root = Value::Object(std::mem::take(&mut self.canonical));
                            write_path(&mut root, destination, transformed).expect(
                                "registered field destination must be a valid canonical path",
                            );
                            self.canonical = match root {
                                Value::Object(object) => object,
                                _ => unreachable!("canonical root remains an object"),
                            };
                            continue;
                        }
                        let destination = canonical_key_for_row(&row, key);
                        let transformed =
                            self.apply_leaf_operator(&row, child, &child_raw_path, &destination);
                        output.insert(destination, transformed);
                    } else if self.profiles.has_descendant(&self.protocol, &child_lookup) {
                        let transformed =
                            self.transform_known_value(&child_lookup, child, &child_raw_path);
                        output.insert(key.to_string(), transformed);
                    } else {
                        self.record_opaque(&child_raw_path, child);
                        output.insert(key.to_string(), child.clone());
                    }
                }
                Value::Object(output)
            }
            Value::Array(items) => {
                let item_lookup = array_item_lookup_path(lookup_path);
                Value::Array(
                    items
                        .iter()
                        .enumerate()
                        .map(|(index, item)| {
                            let item_raw_path = format!("{raw_path}[{index}]");
                            if self.profiles.row(&self.protocol, &item_lookup).is_some()
                                || self.profiles.has_descendant(&self.protocol, &item_lookup)
                            {
                                self.transform_known_value(&item_lookup, item, &item_raw_path)
                            } else {
                                self.record_opaque(&item_raw_path, item);
                                item.clone()
                            }
                        })
                        .collect(),
                )
            }
            _ => value.clone(),
        }
    }

    fn process_instructions(&mut self, value: &Value, row: &ProfileRow, raw_path: &str) {
        self.record_opaque_once(raw_path, value);
        if !value.is_string() {
            self.record_opaque_once(raw_path, value);
        }
        let start = self.system_instructions.len();
        let mut leaf_sources: Vec<String> = Vec::new();
        if let Some(items) = value.as_array() {
            for (index, item) in items.iter().enumerate() {
                let item_path = format!("{raw_path}[{index}]");
                if let Some(object) = item.as_object() {
                    self.record_part_siblings(object, &item_path, &["text"]);
                    if let Some(text) = object.get("text").and_then(Value::as_str) {
                        let source = format!("{item_path}.text");
                        self.system_instructions
                            .push(InstructionSource::new(&source), text);
                        leaf_sources.push(source);
                    } else {
                        self.record_opaque_once(&item_path, item);
                    }
                } else {
                    self.record_opaque_once(&item_path, item);
                }
            }
        } else if let Some(object) = value.as_object() {
            self.record_part_siblings(object, raw_path, &["parts"]);
            if let Some(text) = object.get("text").and_then(Value::as_str) {
                let source = format!("{raw_path}.text");
                self.system_instructions
                    .push(InstructionSource::new(&source), text);
                leaf_sources.push(source);
            }
        } else if let Some(text) = value.as_str() {
            self.system_instructions
                .push(InstructionSource::new(raw_path), text);
            leaf_sources.push(raw_path.to_string());
        }
        if self.system_instructions.len() == start {
            self.record_opaque(raw_path, value);
            return;
        }
        self.system_instructions.register_field_source(raw_path);
        self.record_mapping(row, raw_path, "chat.messages[].role=system", "text");
        for leaf in leaf_sources {
            if leaf != raw_path {
                self.record_mapping_by_path(
                    &leaf,
                    "chat.system.instructions",
                    "instructions_to_system_message",
                );
            }
        }
    }

    fn process_system_instruction(&mut self, value: &Value, row: &ProfileRow, raw_path: &str) {
        self.record_opaque_once(raw_path, value);
        let start = self.system_instructions.len();
        let mut leaf_sources: Vec<String> = Vec::new();
        if let Some(parts) = value.get("parts").and_then(Value::as_array) {
            for (index, part) in parts.iter().enumerate() {
                let part_path = format!("{raw_path}.parts[{index}]");
                if let Some(object) = part.as_object() {
                    self.record_part_siblings(object, &part_path, &["text"]);
                    if let Some(text) = object.get("text").and_then(Value::as_str) {
                        let source = format!("{part_path}.text");
                        self.system_instructions
                            .push(InstructionSource::new(&source), text);
                        leaf_sources.push(source);
                    } else {
                        self.record_opaque_once(&part_path, part);
                    }
                } else {
                    self.record_opaque_once(&part_path, part);
                }
            }
        }
        if let Some(object) = value.as_object() {
            self.record_part_siblings(object, raw_path, &["parts"]);
        }
        if !value.is_string() {
            self.record_opaque_once(raw_path, value);
        }
        if self.system_instructions.len() == start {
            self.record_opaque(raw_path, value);
            return;
        }
        self.system_instructions.register_field_source(raw_path);
        self.record_mapping(row, raw_path, "chat.system.instructions", "text");
        for leaf in leaf_sources {
            if leaf != raw_path {
                self.record_mapping_by_path(
                    &leaf,
                    "chat.system.instructions",
                    "instructions_to_system_message",
                );
            }
        }
    }

    pub(super) fn process_token_limit(&mut self, value: &Value, row: &ProfileRow, raw_path: &str) {
        let destination = canonical_key_for_row(row, "max_completion_tokens");
        self.record_mapping(row, raw_path, &destination, "json");
        if self.canonical.contains_key(&destination) {
            self.record_opaque(raw_path, value);
            return;
        }
        self.canonical.insert(destination, value.clone());
    }

    fn process_include(&mut self, value: &Value, row: &ProfileRow, raw_path: &str) {
        self.record_mapping(
            row,
            raw_path,
            "chat.routecodex_chat_extension.responses_request.include",
            "json",
        );
        if value.is_array() {
            self.extension_responses_include = Some(value.clone());
        } else {
            self.record_opaque(raw_path, value);
            self.extension_responses_include = Some(value.clone());
        }
    }

    fn process_tools(&mut self, value: &Value, row: &ProfileRow, raw_path: &str) {
        self.record_mapping(row, raw_path, "chat.tools", "json");
        let Some(items) = value.as_array() else {
            self.record_opaque(raw_path, value);
            self.canonical.insert("tools".to_string(), value.clone());
            return;
        };
        let mut canonical_tools = Vec::new();
        let transform_id = row.transform_id();
        for (index, item) in items.iter().enumerate() {
            let item_path = format!("{raw_path}[{index}]");
            match transform_id {
                Some("v3.anthropic_tools_to_chat_tools.v1") => {
                    self.process_anthropic_tool(item, &item_path, &mut canonical_tools);
                }
                Some("v3.gemini_tools_to_chat_tools.v1") => {
                    self.process_gemini_tool(item, &item_path, &mut canonical_tools);
                }
                _ => self.process_openai_like_tool(item, &item_path, &mut canonical_tools),
            }
        }
        self.canonical
            .insert("tools".to_string(), Value::Array(canonical_tools));
    }

    fn process_anthropic_tool(&mut self, item: &Value, item_path: &str, output: &mut Vec<Value>) {
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
        let name = object.get("name").and_then(Value::as_str);
        let mut function = Map::new();
        if let Some(name) = name {
            function.insert("name".to_string(), Value::String(name.to_string()));
        }
        if let Some(description) = object.get("description") {
            function.insert("description".to_string(), description.clone());
        }
        if let Some(input_schema) = object.get("input_schema") {
            function.insert("parameters".to_string(), input_schema.clone());
        }
        for key in ["cache_control", "defer_loading", "strict"] {
            if let Some(value) = object.get(key) {
                function.insert(key.to_string(), value.clone());
            }
        }
        let canonical = json!({
            "type": "function",
            "function": Value::Object(function),
            "extension": {"raw_declaration": item.clone()},
        });
        self.push_tool_declaration(item_path, "function", name, object.get("namespace"), item);
        self.record_mapping_by_path(
            item_path,
            &format!("chat.tools[{}]", output.len()),
            "routecodex.v3.field.tool_declaration_transform@1",
        );
        output.push(canonical);
    }

    fn process_tool_choice(&mut self, value: &Value, row: &ProfileRow, raw_path: &str) {
        self.record_mapping(row, raw_path, "chat.tool_choice", "json");
        match row.transform_id() {
            Some("v3.anthropic_tool_choice_to_chat_tool_choice.v1") => {
                let Some(object) = value.as_object() else {
                    let condition = map_tool_choice_scalar(value);
                    self.canonical.insert("tool_choice".to_string(), condition);
                    return;
                };
                let choice_type = object.get("type").and_then(Value::as_str).unwrap_or("auto");
                let mut consumed = vec!["type"];
                let choice = match choice_type {
                    "auto" => Value::String("auto".to_string()),
                    "any" => Value::String("required".to_string()),
                    "none" => Value::String("none".to_string()),
                    "tool" => {
                        consumed.push("name");
                        json!({
                            "type": "function",
                            "function": {"name": object.get("name").cloned().unwrap_or(Value::Null)},
                        })
                    }
                    _ => {
                        self.record_opaque(raw_path, value);
                        value.clone()
                    }
                };
                self.canonical.insert("tool_choice".to_string(), choice);
                if let Some(disable) = object.get("disable_parallel_tool_use") {
                    if let Some(disable) = disable.as_bool() {
                        self.canonical
                            .insert("parallel_tool_calls".to_string(), Value::Bool(!disable));
                        self.record_part_mapping(
                            "tool_choice.disable_parallel_tool_use",
                            &format!("{raw_path}.disable_parallel_tool_use"),
                            "chat.parallel_tool_calls",
                        );
                        consumed.push("disable_parallel_tool_use");
                    } else {
                        self.record_opaque(
                            &format!("{raw_path}.disable_parallel_tool_use"),
                            disable,
                        );
                    }
                }
                self.record_part_siblings(object, raw_path, &consumed);
            }
            Some("v3.gemini_tool_config_to_chat_tool_choice.v1") => {
                let choice = map_gemini_tool_choice(value);
                self.canonical.insert("tool_choice".to_string(), choice);
            }
            _ => {
                let choice = map_tool_choice_value(value);
                self.canonical.insert("tool_choice".to_string(), choice);
            }
        }
    }

    fn process_responses_input(&mut self, value: &Value, row: &ProfileRow, raw_path: &str) {
        self.record_mapping(row, raw_path, "chat.messages", "json");
        match value {
            Value::String(text) => {
                let start = self.messages.len();
                let opaque_start = self.opaque_records.len();
                self.messages.push(json!({"role": "user", "content": text}));
                self.record_message_span(raw_path, raw_path, start, opaque_start);
            }
            Value::Array(items) => {
                for (index, item) in items.iter().enumerate() {
                    let item_path = format!("{raw_path}[{index}]");
                    let start = self.messages.len();
                    // The original representation is data, used by the inverse
                    // for shape/presence. It is not history-fold comparison data.
                    self.record_opaque_once(&item_path, item);
                    let opaque_start = self.opaque_records.len();
                    self.process_responses_item(item, &item_path, row);
                    self.record_message_span(raw_path, &item_path, start, opaque_start);
                }
            }
            _ => {
                let start = self.messages.len();
                let opaque_start = self.opaque_records.len();
                self.record_opaque(raw_path, value);
                self.messages
                    .push(json!({"role": "user", "content": value.clone()}));
                self.record_message_span(raw_path, raw_path, start, opaque_start);
            }
        }
    }

    fn process_responses_item(&mut self, item: &Value, item_path: &str, row: &ProfileRow) {
        let Some(object) = item.as_object() else {
            self.record_opaque(item_path, item);
            self.messages
                .push(json!({"role": "user", "content": item.clone()}));
            return;
        };
        let message_index = self.messages.len();
        let item_type = object
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("message");
        let hosted_case = row
            .params
            .hosted_history_cases
            .as_ref()
            .and_then(|cases| {
                cases
                    .iter()
                    .find(|case| case.discriminator_value() == item_type)
            })
            .cloned();
        if let Some(case) = hosted_case {
            self.emit_hosted_history_anchor(object, item, item_path, message_index, &case);
            return;
        }
        match item_type {
            // `input[]` hosted web_search declaration: a canonical `tools[]` declaration, not history.
            "web_search" => self.absorb_responses_web_search_declaration(object, item_path),
            "function_call" | "custom_tool_call" => {
                let call_id = object.get("call_id").and_then(Value::as_str);
                let name = object.get("name").and_then(Value::as_str);
                let kind = if item_type == "custom_tool_call" {
                    "custom"
                } else {
                    "function"
                };
                let payload_key = if kind == "custom" {
                    "input"
                } else {
                    "arguments"
                };
                let call_base = format!("chat.messages[{message_index}].tool_calls[0]");
                let mut call = Map::new();
                if let Some(call_id) = call_id {
                    call.insert("id".to_string(), Value::String(call_id.to_string()));
                    self.record_part_mapping(
                        "input[].call_id",
                        &format!("{item_path}.call_id"),
                        &format!("{call_base}.id"),
                    );
                }
                call.insert("type".to_string(), Value::String(kind.to_string()));
                self.record_part_mapping(
                    "input[].type",
                    &format!("{item_path}.type"),
                    &format!("{call_base}.type"),
                );
                let mut function = Map::new();
                if let Some(name) = name {
                    let name_destination = format!("{call_base}.{kind}.name");
                    function.insert(
                        "name".to_string(),
                        Value::String(canonical_tool_call_name(
                            kind,
                            name,
                            object.get("namespace"),
                        )),
                    );
                    self.record_part_mapping(
                        "input[].name",
                        &format!("{item_path}.name"),
                        &name_destination,
                    );
                }
                if object.contains_key("namespace") {
                    self.record_part_mapping(
                        "input[].namespace",
                        &format!("{item_path}.namespace"),
                        &format!("{call_base}.{kind}.name"),
                    );
                }
                if let Some(payload) = object.get(payload_key) {
                    function.insert(payload_key.to_string(), payload.clone());
                    self.record_part_mapping(
                        &format!("input[].{payload_key}"),
                        &format!("{item_path}.{payload_key}"),
                        &format!("{call_base}.{kind}.{payload_key}"),
                    );
                }
                call.insert(kind.to_string(), Value::Object(function));
                let mut consumed = vec!["type", payload_key, "namespace"];
                if call_id.is_some() {
                    consumed.push("call_id");
                }
                if name.is_some() {
                    consumed.push("name");
                }
                self.record_part_siblings(object, item_path, &consumed);
                self.record_history_pairing(
                    item_path,
                    call_id,
                    name,
                    kind,
                    object.get("namespace"),
                    object.get(payload_key),
                );
                self.messages.push(json!({
                    "role": "assistant",
                    "content": Value::Null,
                    "tool_calls": [Value::Object(call)],
                }));
            }
            "function_call_output" | "custom_tool_call_output" => {
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
                self.record_responses_output_fields(
                    object,
                    item_path,
                    message_index,
                    &mut extension,
                );
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
                    return;
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
                    return;
                }
            }
            _ => {
                let mut message = Map::new();
                let role = object.get("role").and_then(Value::as_str).unwrap_or("user");
                message.insert(
                    "role".to_string(),
                    Value::String(self.canonical_role(role, "input[].role")),
                );
                if let Some(content) = object.get("content") {
                    let content_path = format!("{item_path}.content");
                    message.insert(
                        "content".to_string(),
                        self.normalize_responses_content(content, &content_path, message_index),
                    );
                }
                if object.contains_key("role") {
                    self.record_part_mapping(
                        "input[].role",
                        &format!("{item_path}.role"),
                        &format!("chat.messages[{message_index}].role"),
                    );
                }
                for (key, value) in object {
                    if key != "role" && key != "content" {
                        let child_lookup = child_lookup_path("input[]", key);
                        if let Some(row) = self.profiles.row(&self.protocol, &child_lookup).cloned()
                        {
                            let destination =
                                canonical_child_key_for_row(&row, key, "chat.messages[]");
                            let concrete = field_path(
                                &format!("chat.messages[{message_index}]"),
                                &destination,
                            );
                            let transformed = self.with_history_context(
                                Some(message_index),
                                None,
                                None,
                                |normalizer| {
                                    normalizer.apply_leaf_operator(
                                        &row,
                                        value,
                                        &format!("{item_path}.{key}"),
                                        &concrete,
                                    )
                                },
                            );
                            message.insert(destination, transformed);
                        } else {
                            let key_path = field_path(item_path, key);
                            self.record_opaque(&key_path, value);
                            self.record_mapping_by_path(
                                &key_path,
                                &field_path(&format!("chat.messages[{message_index}]"), key),
                                "routecodex.v3.field.lossless_preserve@1",
                            );
                            message.insert(key.clone(), value.clone());
                        }
                    }
                }
                self.messages.push(Value::Object(message));
            }
        }
    }

    fn normalize_responses_content(
        &mut self,
        value: &Value,
        raw_path: &str,
        message_index: usize,
    ) -> Value {
        match value {
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .enumerate()
                    .map(|(index, item)| {
                        self.with_history_context(
                            Some(message_index),
                            Some(index),
                            None,
                            |normalizer| {
                                normalizer.record_mapping_by_path(
                                    &format!("{raw_path}[{index}]"),
                                    &format!("chat.messages[{message_index}].content[{index}]"),
                                    "routecodex.v3.field.lossless_preserve@1",
                                );
                                normalizer.normalize_responses_content_part(
                                    item,
                                    &format!("{raw_path}[{index}]"),
                                    message_index,
                                    index,
                                )
                            },
                        )
                    })
                    .collect(),
            ),
            Value::Object(object) => {
                self.record_opaque(raw_path, value);
                self.record_mapping_by_path(
                    raw_path,
                    &format!("chat.messages[{message_index}].content"),
                    "routecodex.v3.field.lossless_preserve@1",
                );
                Value::Object(object.clone())
            }
            _ => {
                self.record_mapping_by_path(
                    raw_path,
                    &format!("chat.messages[{message_index}].content"),
                    "routecodex.v3.field.lossless_preserve@1",
                );
                value.clone()
            }
        }
    }

    fn normalize_responses_content_part(
        &mut self,
        item: &Value,
        raw_path: &str,
        message_index: usize,
        content_index: usize,
    ) -> Value {
        let Some(object) = item.as_object() else {
            return item.clone();
        };
        if matches!(
            object.get("type").and_then(Value::as_str),
            Some("input_image" | "image_url")
        ) {
            return self.with_history_context(
                Some(message_index),
                Some(content_index),
                None,
                |normalizer| normalizer.normalize_responses_image_part(object, raw_path),
            );
        }
        let mut output = Map::new();
        for (key, value) in object {
            let child_lookup = child_lookup_path("input[].content[]", key);
            if let Some(row) = self.profiles.row(&self.protocol, &child_lookup).cloned() {
                let destination = canonical_key_for_row(&row, key);
                let concrete = append_history_relative(
                    &format!("chat.messages[{message_index}].content[{content_index}]"),
                    &destination,
                );
                let transformed = self.with_history_context(
                    Some(message_index),
                    Some(content_index),
                    None,
                    |normalizer| {
                        normalizer.apply_leaf_operator(
                            &row,
                            value,
                            &format!("{raw_path}.{key}"),
                            &concrete,
                        )
                    },
                );
                output.insert(destination, transformed);
            } else {
                let key_path = field_path(raw_path, key);
                self.record_opaque(&key_path, value);
                self.record_mapping_by_path(
                    &key_path,
                    &field_path(
                        &format!("chat.messages[{message_index}].content[{content_index}]"),
                        key,
                    ),
                    "routecodex.v3.field.lossless_preserve@1",
                );
                output.insert(key.clone(), value.clone());
            }
        }
        Value::Object(output)
    }

    /// Responses image parts arrive as `{type:"input_image", image_url:"...",
    /// detail:"..."}` (or with a `url` compatibility field). Canonical Chat
    /// nests the url and detail under `image_url`; unmapped siblings stay as
    /// opaque records so the inverse context can restore them verbatim.
    fn normalize_responses_image_part(
        &mut self,
        object: &Map<String, Value>,
        raw_path: &str,
    ) -> Value {
        let source = object
            .get("image_url")
            .cloned()
            .or_else(|| object.get("url").cloned())
            .unwrap_or(Value::Null);
        let mut image_url = match source {
            Value::Object(object) => object,
            Value::String(url) => Map::from_iter([("url".to_string(), Value::String(url))]),
            other => Map::from_iter([("url".to_string(), other)]),
        };
        if let Some(detail) = object.get("detail").cloned() {
            image_url.entry("detail".to_string()).or_insert(detail);
        }
        self.record_mapping_by_path(
            &format!("{raw_path}.type"),
            "chat.messages[].content[].type",
            "part_type_value_map",
        );
        if object.contains_key("image_url") {
            let destination = if object.get("image_url").is_some_and(Value::is_object) {
                "chat.messages[].content[].image_url"
            } else {
                "chat.messages[].content[].image_url.url"
            };
            self.record_mapping_by_path(
                &format!("{raw_path}.image_url"),
                destination,
                "media_shape_branch",
            );
        } else if object.contains_key("url") {
            let destination = if object.get("url").is_some_and(Value::is_object) {
                "chat.messages[].content[].image_url"
            } else {
                "chat.messages[].content[].image_url.url"
            };
            self.record_mapping_by_path(
                &format!("{raw_path}.url"),
                destination,
                "media_shape_branch",
            );
        }
        let detail_in_source_object = object
            .get("image_url")
            .or_else(|| object.get("url"))
            .and_then(Value::as_object)
            .is_some_and(|image| image.contains_key("detail"));
        if object.contains_key("detail") && !detail_in_source_object {
            self.record_mapping_by_path(
                &format!("{raw_path}.detail"),
                "chat.messages[].content[].image_url.detail",
                "media_shape_branch",
            );
        } else if let Some(detail) = object.get("detail") {
            self.record_opaque_once(&format!("{raw_path}.detail"), detail);
        }
        self.record_part_siblings(object, raw_path, &["type", "image_url", "url", "detail"]);
        json!({"type": "image_url", "image_url": Value::Object(image_url)})
    }

    fn process_messages(
        &mut self,
        value: &Value,
        row: &ProfileRow,
        raw_path: &str,
    ) -> Result<(), String> {
        self.record_mapping(row, raw_path, "chat.messages", "json");
        let Some(items) = value.as_array() else {
            if value.is_null() {
                // An absent optional history container has no message content.
                // Retain its source shape for inverse projection without
                // inventing a user turn beside another configured history.
                self.record_opaque(raw_path, value);
                return Ok(());
            }
            let start = self.messages.len();
            let opaque_start = self.opaque_records.len();
            self.record_opaque(raw_path, value);
            self.messages
                .push(json!({"role": "user", "content": value.clone()}));
            self.record_message_span(raw_path, raw_path, start, opaque_start);
            return Ok(());
        };
        let transform_id = row.transform_id().ok_or_else(|| {
            format!(
                "message container `{}` has no client_request_to_chat transform_id",
                row.profile_path
            )
        })?;
        for (index, item) in items.iter().enumerate() {
            let item_path = format!("{raw_path}[{index}]");
            let start = self.messages.len();
            self.record_opaque_once(&item_path, item);
            let opaque_start = self.opaque_records.len();
            match transform_id {
                "v3.openai_chat_messages_to_chat_messages.v1" => {
                    self.process_openai_message(item, &item_path);
                }
                "v3.anthropic_messages_to_chat_messages.v1" => {
                    self.process_anthropic_message(item, &item_path);
                }
                "v3.gemini_contents_to_chat_messages.v1" => {
                    self.process_gemini_message(item, &item_path);
                }
                _ => {
                    return Err(format!(
                        "no message handler registered for transform_id `{transform_id}`"
                    ));
                }
            }
            self.record_message_span(raw_path, &item_path, start, opaque_start);
        }
        Ok(())
    }

    fn process_openai_message(&mut self, item: &Value, item_path: &str) {
        let Some(object) = item.as_object() else {
            self.record_opaque(item_path, item);
            self.messages.push(item.clone());
            return;
        };
        let message_index = self.messages.len();
        let mut message = object.clone();
        if let Some(role) = object.get("role").and_then(Value::as_str) {
            message.insert(
                "role".to_string(),
                Value::String(self.canonical_role(role, "messages[].role")),
            );
            self.record_mapping_by_path(
                &format!("{item_path}.role"),
                &format!("chat.messages[{message_index}].role"),
                "role_value_map",
            );
        }
        if let Some(content) = object.get("content") {
            let content_path = format!("{item_path}.content");
            message.insert(
                "content".to_string(),
                self.normalize_openai_content(content, &content_path, message_index),
            );
        }
        if let Some(tool_calls) = object.get("tool_calls") {
            let calls_path = format!("{item_path}.tool_calls");
            message.insert(
                "tool_calls".to_string(),
                self.normalize_openai_tool_calls(tool_calls, &calls_path, message_index),
            );
        }
        if let Some(tool_call_id) = object.get("tool_call_id").and_then(Value::as_str) {
            self.record_mapping_by_path(
                &format!("{item_path}.tool_call_id"),
                &format!("chat.messages[{message_index}].tool_call_id"),
                "routecodex.v3.field.tool_identity_context@1",
            );
            if object.contains_key("content") {
                self.record_mapping_by_path(
                    &format!("{item_path}.content"),
                    &format!("chat.messages[{message_index}].content"),
                    "routecodex.v3.field.lossless_preserve@1",
                );
            }
            self.record_history_pairing(
                &format!("{item_path}.tool_call_id"),
                Some(tool_call_id),
                None,
                "tool_result",
                None,
                object.get("content"),
            );
        }
        for (key, value) in object {
            if key == "role" || key == "content" || key == "tool_calls" {
                continue;
            }
            let child_lookup = child_lookup_path("messages[]", key);
            if let Some(row) = self.profiles.row(&self.protocol, &child_lookup).cloned() {
                let destination = canonical_key_for_row(&row, key);
                let concrete = field_path(&format!("chat.messages[{message_index}]"), &destination);
                let transformed =
                    self.with_history_context(Some(message_index), None, None, |normalizer| {
                        normalizer.apply_leaf_operator(
                            &row,
                            value,
                            &format!("{item_path}.{key}"),
                            &concrete,
                        )
                    });
                message.insert(destination, transformed);
            } else {
                let key_path = field_path(item_path, key);
                self.record_opaque(&key_path, value);
                self.record_mapping_by_path(
                    &key_path,
                    &field_path(&format!("chat.messages[{message_index}]"), key),
                    "routecodex.v3.field.lossless_preserve@1",
                );
            }
        }
        if !message.contains_key("role") {
            let role = if message.contains_key("tool_call_id") {
                "tool"
            } else {
                "user"
            };
            message.insert("role".to_string(), Value::String(role.to_string()));
        }
        self.messages.push(Value::Object(message));
    }

    fn normalize_openai_content(
        &mut self,
        value: &Value,
        raw_path: &str,
        message_index: usize,
    ) -> Value {
        match value {
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .enumerate()
                    .map(|(index, item)| {
                        self.with_history_context(
                            Some(message_index),
                            Some(index),
                            None,
                            |normalizer| {
                                normalizer.record_mapping_by_path(
                                    &format!("{raw_path}[{index}]"),
                                    &format!("chat.messages[{message_index}].content[{index}]"),
                                    "routecodex.v3.field.lossless_preserve@1",
                                );
                                normalizer.normalize_openai_content_part(
                                    item,
                                    &format!("{raw_path}[{index}]"),
                                    message_index,
                                    index,
                                )
                            },
                        )
                    })
                    .collect(),
            ),
            Value::Object(object) => {
                self.record_opaque(raw_path, value);
                self.record_mapping_by_path(
                    raw_path,
                    &format!("chat.messages[{message_index}].content"),
                    "routecodex.v3.field.lossless_preserve@1",
                );
                Value::Object(object.clone())
            }
            _ => {
                self.record_mapping_by_path(
                    raw_path,
                    &format!("chat.messages[{message_index}].content"),
                    "routecodex.v3.field.lossless_preserve@1",
                );
                value.clone()
            }
        }
    }

    fn normalize_openai_content_part(
        &mut self,
        item: &Value,
        raw_path: &str,
        message_index: usize,
        content_index: usize,
    ) -> Value {
        let Some(object) = item.as_object() else {
            return item.clone();
        };
        let mut output = Map::new();
        for (key, value) in object {
            let child_lookup = child_lookup_path("messages[].content[]", key);
            if let Some(row) = self.profiles.row(&self.protocol, &child_lookup).cloned() {
                let destination = canonical_key_for_row(&row, key);
                let concrete = append_history_relative(
                    &format!("chat.messages[{message_index}].content[{content_index}]"),
                    &destination,
                );
                let transformed = self.with_history_context(
                    Some(message_index),
                    Some(content_index),
                    None,
                    |normalizer| {
                        normalizer.apply_leaf_operator(
                            &row,
                            value,
                            &format!("{raw_path}.{key}"),
                            &concrete,
                        )
                    },
                );
                output.insert(destination, transformed);
            } else if value.is_object() {
                let key_path = field_path(raw_path, key);
                self.record_opaque(&key_path, value);
                self.record_mapping_by_path(
                    &key_path,
                    &field_path(
                        &format!("chat.messages[{message_index}].content[{content_index}]"),
                        key,
                    ),
                    "routecodex.v3.field.lossless_preserve@1",
                );
                let nested = self.transform_known_value(&child_lookup, value, &key_path);
                output.insert(key.clone(), nested);
            } else {
                let key_path = field_path(raw_path, key);
                self.record_opaque(&key_path, value);
                self.record_mapping_by_path(
                    &key_path,
                    &field_path(
                        &format!("chat.messages[{message_index}].content[{content_index}]"),
                        key,
                    ),
                    "routecodex.v3.field.lossless_preserve@1",
                );
                output.insert(key.clone(), value.clone());
            }
        }
        Value::Object(output)
    }

    pub(super) fn identity_name(&self, kind: &str, name: &str) -> String {
        let _ = kind;
        name.to_string()
    }

    /// Canonical Chat role comes from the registered `role_value_map@1` row
    /// that owns the raw role path. The lookup path is supplied by the
    /// registered message transform, never by the entry protocol name.
    pub(super) fn canonical_role(&self, role: &str, role_lookup_path: &str) -> String {
        let transform_id = self
            .profiles
            .row(&self.protocol, role_lookup_path)
            .and_then(ProfileRow::transform_id);
        map_role_for_transform(transform_id, role)
    }

    pub(super) fn normalize_content_value(
        &mut self,
        row: &ProfileRow,
        value: &Value,
        raw_path: &str,
    ) -> Value {
        // A content-shape leaf is only reached while a history message is the
        // active producer; otherwise it is a standalone top-level content value.
        // Use the active message index so nested part records resolve to the
        // emitted canonical message instead of a wildcard.
        let message_index = self.history_message_index.unwrap_or(self.messages.len());
        match row.transform_id() {
            Some("v3.responses_content_to_chat_content.v1") => {
                return self.normalize_responses_content(value, raw_path, message_index);
            }
            Some("v3.openai_chat_content_to_chat_content.v1") => {
                return self.normalize_openai_content(value, raw_path, message_index);
            }
            _ => {}
        }
        match value {
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .enumerate()
                    .map(|(index, item)| {
                        self.normalize_media_value(item, &format!("{raw_path}[{index}]"))
                    })
                    .collect(),
            ),
            _ => value.clone(),
        }
    }

    pub(super) fn normalize_media_value(&mut self, value: &Value, raw_path: &str) -> Value {
        let Some(object) = value.as_object() else {
            return value.clone();
        };
        if object.get("type").and_then(Value::as_str).is_some()
            && (object.contains_key("url")
                || object.contains_key("data")
                || object.contains_key("media_type"))
        {
            return self.anthropic_media_block(value, raw_path, false);
        }
        if let Some(inline) = object.get("inlineData").and_then(Value::as_object) {
            let data = inline.get("data").and_then(Value::as_str).unwrap_or("");
            let mime = inline
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or("application/octet-stream");
            return json!({
                "type": "image_url",
                "image_url": {"url": format!("data:{mime};base64,{data}")},
            });
        }
        value.clone()
    }
}

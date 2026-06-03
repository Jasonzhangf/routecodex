use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Value};

use crate::shared_tooling::split_provider_tool_sentinel_text;

fn as_object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn as_object_mut(value: &mut Value) -> Option<&mut Map<String, Value>> {
    value.as_object_mut()
}

fn read_trimmed_string(record: Option<&Map<String, Value>>, keys: &[&str]) -> Option<String> {
    let record = record?;
    for key in keys {
        if let Some(value) = record.get(*key).and_then(Value::as_str) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn clone_array(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

fn extract_responses_top_level_parameters(
    record: &Map<String, Value>,
) -> Option<Map<String, Value>> {
    const ALLOWED: &[&str] = &[
        "temperature",
        "top_p",
        "max_output_tokens",
        "seed",
        "logit_bias",
        "user",
        "parallel_tool_calls",
        "tool_choice",
        "response_format",
        "stream",
    ];
    let mut out = Map::new();
    if !record.contains_key("max_output_tokens") {
        if let Some(value) = record.get("max_tokens") {
            out.insert("max_output_tokens".to_string(), value.clone());
        }
    }
    for key in ALLOWED {
        if let Some(value) = record.get(*key) {
            out.insert((*key).to_string(), value.clone());
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

pub(crate) fn normalize_followup_parameters(value: &Value) -> Option<Value> {
    let mut row = value.as_object()?.clone();
    row.remove("stream");
    if row.is_empty() {
        None
    } else {
        Some(Value::Object(row))
    }
}

fn first_normalized_parameters(candidates: Vec<Option<Value>>) -> Option<Value> {
    candidates
        .into_iter()
        .flatten()
        .find_map(|value| normalize_followup_parameters(&value))
}

pub(crate) fn resolve_followup_model(seed_model: &Value, adapter_context: &Value) -> String {
    let seed = seed_model.as_str().map(str::trim).filter(|s| !s.is_empty());
    let Some(record) = adapter_context.as_object() else {
        return seed.unwrap_or("").to_string();
    };
    for key in ["assignedModelId", "modelId"] {
        if let Some(value) = record
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return value.to_string();
        }
    }
    if let Some(value) = seed {
        return value.to_string();
    }
    for key in ["model", "originalModelId"] {
        if let Some(value) = record
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return value.to_string();
        }
    }
    String::new()
}

fn extract_responses_message_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    let Some(parts) = content.as_array() else {
        return String::new();
    };
    parts
        .iter()
        .filter_map(|part| {
            let row = part.as_object()?;
            row.get("text")
                .or_else(|| row.get("input_text"))
                .or_else(|| row.get("output_text"))
                .and_then(Value::as_str)
        })
        .collect::<Vec<_>>()
        .join("")
}

fn extract_chat_messages_from_responses_input(input: &[Value]) -> Vec<Value> {
    let mut messages = Vec::new();
    for item in input {
        let Some(row) = item.as_object() else {
            continue;
        };
        let item_type = row.get("type").and_then(Value::as_str).unwrap_or("");
        if item_type == "message" || row.contains_key("role") {
            let role = row.get("role").and_then(Value::as_str).unwrap_or("user");
            let text = row
                .get("content")
                .map(extract_responses_message_text)
                .unwrap_or_default();
            if !text.trim().is_empty() {
                if role == "assistant" {
                    if let Some(Value::Object(message)) =
                        build_assistant_message_from_text(text.as_str())
                    {
                        messages.push(Value::Object(message));
                    }
                } else {
                    messages.push(Value::Object(Map::from_iter([
                        ("role".to_string(), Value::String(role.to_string())),
                        ("content".to_string(), Value::String(text)),
                    ])));
                }
            }
        }
    }
    messages
}

pub(crate) fn extract_captured_chat_seed(captured: &Value) -> Option<Value> {
    let row = captured.as_object()?;
    let mut out = Map::new();
    if let Some(model) = row
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        out.insert("model".to_string(), Value::String(model.to_string()));
    }
    if let Some(messages) = row.get("messages").and_then(Value::as_array) {
        if messages.is_empty() {
            return None;
        }
        out.insert("messages".to_string(), Value::Array(messages.clone()));
    } else if let Some(text) = row
        .get("input")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        out.insert(
            "messages".to_string(),
            Value::Array(vec![Value::Object(Map::from_iter([
                ("role".to_string(), Value::String("user".to_string())),
                ("content".to_string(), Value::String(text.to_string())),
            ]))]),
        );
    } else if let Some(input) = row.get("input").and_then(Value::as_array) {
        let messages = extract_chat_messages_from_responses_input(input);
        if messages.is_empty() {
            return None;
        }
        out.insert("messages".to_string(), Value::Array(messages));
    } else {
        return None;
    }
    if let Some(tools) = row.get("tools").and_then(Value::as_array) {
        out.insert("tools".to_string(), Value::Array(tools.clone()));
    }
    if let Some(parameters) = first_normalized_parameters(vec![
        row.get("parameters").cloned(),
        extract_responses_top_level_parameters(row).map(Value::Object),
    ]) {
        out.insert("parameters".to_string(), parameters);
    }
    Some(Value::Object(out))
}

fn extract_captured_tool_outputs(responses_context: Option<&Map<String, Value>>) -> Vec<Value> {
    let Some(rows) = responses_context
        .and_then(|ctx| ctx.get("__captured_tool_results"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in rows {
        let Some(row) = entry.as_object() else {
            continue;
        };
        let Some(id) = read_trimmed_string(Some(row), &["tool_call_id", "call_id"]) else {
            continue;
        };
        let mut next = Map::new();
        next.insert("tool_call_id".to_string(), Value::String(id.clone()));
        next.insert("id".to_string(), Value::String(id));
        next.insert(
            "output".to_string(),
            row.get("output").cloned().unwrap_or(Value::Null),
        );
        if let Some(name) = read_trimmed_string(Some(row), &["name"]) {
            next.insert("name".to_string(), Value::String(name));
        }
        out.push(Value::Object(next));
    }
    out
}

fn read_text_part(entry: &Value) -> String {
    let Some(record) = entry.as_object() else {
        return String::new();
    };
    record
        .get("text")
        .or_else(|| record.get("output_text"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn build_assistant_message_from_text(text: &str) -> Option<Value> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let mut message = Map::new();
    message.insert("role".to_string(), Value::String("assistant".to_string()));
    if let Some((reasoning, visible)) = split_provider_tool_sentinel_text(text) {
        if !reasoning.trim().is_empty() {
            message.insert("reasoning_content".to_string(), Value::String(reasoning));
        }
        if visible.trim().is_empty() {
            message.insert("content".to_string(), Value::String(String::new()));
        } else {
            message.insert("content".to_string(), Value::String(visible));
        }
    } else {
        message.insert("content".to_string(), Value::String(text.to_string()));
    }
    Some(Value::Object(message))
}

pub(crate) fn extract_assistant_followup_message(final_chat_response: &Value) -> Option<Value> {
    let record = final_chat_response.as_object()?;
    if let Some(choice_message) = record
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(Value::as_object)
        .and_then(|choice| choice.get("message"))
        .and_then(Value::as_object)
    {
        if choice_message.get("role").and_then(Value::as_str).is_some() {
            return Some(Value::Object(choice_message.clone()));
        }
    }
    let output = record.get("output").and_then(Value::as_array)?;
    let assistant = output.iter().find(|item| {
        item.as_object()
            .and_then(|row| row.get("role"))
            .and_then(Value::as_str)
            == Some("assistant")
    })?;
    let content = assistant
        .as_object()
        .and_then(|row| row.get("content"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let text = content
        .iter()
        .map(read_text_part)
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join("");
    build_assistant_message_from_text(text.as_str())
}

fn extract_chat_tool_outputs(final_chat_response: &Value) -> Vec<Value> {
    let outputs = final_chat_response
        .as_object()
        .and_then(|row| row.get("tool_outputs"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for entry in outputs {
        let Some(record) = entry.as_object() else {
            continue;
        };
        let mut next = Map::new();
        if let Some(tool_call_id) = read_trimmed_string(Some(record), &["tool_call_id"]) {
            next.insert("tool_call_id".to_string(), Value::String(tool_call_id));
        }
        if let Some(name) = read_trimmed_string(Some(record), &["name"]) {
            next.insert("name".to_string(), Value::String(name));
        }
        if let Some(arguments) = record.get("arguments").and_then(Value::as_str) {
            next.insert(
                "arguments".to_string(),
                Value::String(arguments.to_string()),
            );
        }
        let content = record
            .get("content")
            .cloned()
            .or_else(|| record.get("output").cloned())
            .unwrap_or(Value::Null);
        next.insert("output".to_string(), content);
        out.push(Value::Object(next));
    }
    out
}

fn prune_pending_tool_calls_for_outputs(messages: &mut Vec<Value>, tool_call_ids: &[String]) {
    if tool_call_ids.is_empty() {
        return;
    }
    let mut kept = Vec::new();
    for mut message in std::mem::take(messages) {
        let role = message
            .as_object()
            .and_then(|row| row.get("role"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let calls = message
            .as_object()
            .and_then(|row| row.get("tool_calls"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if role != "assistant" || calls.is_empty() {
            kept.push(message);
            continue;
        }
        let kept_calls: Vec<Value> = calls
            .into_iter()
            .filter(|call| {
                let id =
                    read_trimmed_string(call.as_object(), &["id", "call_id"]).unwrap_or_default();
                id.is_empty() || !tool_call_ids.iter().any(|candidate| candidate == &id)
            })
            .collect();
        if !kept_calls.is_empty() {
            if let Some(row) = as_object_mut(&mut message) {
                row.insert("tool_calls".to_string(), Value::Array(kept_calls));
            }
            kept.push(message);
            continue;
        }
        let content = message
            .as_object()
            .and_then(|row| row.get("content"))
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        if !content.is_empty() {
            if let Some(row) = as_object_mut(&mut message) {
                row.remove("tool_calls");
            }
            kept.push(message);
        }
    }
    *messages = kept;
}

fn append_tool_messages_from_tool_outputs(
    messages: &mut Vec<Value>,
    adapter_context: &Value,
    final_chat_response: &Value,
    required: bool,
) -> bool {
    let responses_context = adapter_context
        .as_object()
        .and_then(|row| row.get("responsesContext"))
        .and_then(Value::as_object);
    let outputs_from_responses = extract_captured_tool_outputs(responses_context);
    let chat_outputs = if outputs_from_responses.is_empty() {
        extract_chat_tool_outputs(final_chat_response)
    } else {
        Vec::new()
    };
    let outputs = if outputs_from_responses.is_empty() {
        chat_outputs
    } else {
        outputs_from_responses
    };
    if outputs.is_empty() {
        return !required;
    }
    let tool_call_ids: Vec<String> = outputs
        .iter()
        .filter_map(|entry| read_trimmed_string(entry.as_object(), &["tool_call_id"]))
        .collect();
    prune_pending_tool_calls_for_outputs(messages, &tool_call_ids);

    let tool_calls: Vec<Value> = outputs
        .iter()
        .filter_map(|entry| {
            let row = entry.as_object()?;
            let tool_call_id = read_trimmed_string(Some(row), &["tool_call_id"])?;
            let name =
                read_trimmed_string(Some(row), &["name"]).unwrap_or_else(|| "tool".to_string());
            let arguments = row
                .get("arguments")
                .and_then(Value::as_str)
                .unwrap_or("{}")
                .to_string();
            Some(Value::Object(Map::from_iter([
                ("id".to_string(), Value::String(tool_call_id)),
                ("type".to_string(), Value::String("function".to_string())),
                (
                    "function".to_string(),
                    Value::Object(Map::from_iter([
                        ("name".to_string(), Value::String(name)),
                        ("arguments".to_string(), Value::String(arguments)),
                    ])),
                ),
            ])))
        })
        .collect();
    if !tool_calls.is_empty() {
        let append_to_last = messages
            .last_mut()
            .and_then(Value::as_object_mut)
            .map(|last| {
                let role = last
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_ascii_lowercase();
                if role == "assistant" && !last.get("tool_calls").is_some_and(Value::is_array) {
                    last.insert("tool_calls".to_string(), Value::Array(tool_calls.clone()));
                    true
                } else {
                    false
                }
            });
        if append_to_last != Some(true) {
            messages.push(Value::Object(Map::from_iter([
                ("role".to_string(), Value::String("assistant".to_string())),
                ("content".to_string(), Value::Null),
                ("tool_calls".to_string(), Value::Array(tool_calls)),
            ])));
        }
    }
    for entry in outputs {
        let mut message = Map::new();
        message.insert("role".to_string(), Value::String("tool".to_string()));
        if let Some(tool_call_id) = read_trimmed_string(entry.as_object(), &["tool_call_id"]) {
            message.insert("tool_call_id".to_string(), Value::String(tool_call_id));
        }
        let output = entry
            .as_object()
            .and_then(|row| row.get("output"))
            .cloned()
            .unwrap_or(Value::Null);
        let content = output
            .as_str()
            .map(ToString::to_string)
            .unwrap_or_else(|| serde_json::to_string(&output).unwrap_or_else(|_| "".to_string()));
        message.insert("content".to_string(), Value::String(content));
        messages.push(Value::Object(message));
    }
    true
}

fn append_text_message(messages: &mut Vec<Value>, role: &str, text: Option<&str>) {
    let trimmed = text.unwrap_or("").trim();
    if !trimmed.is_empty() {
        messages.push(Value::Object(Map::from_iter([
            ("role".to_string(), Value::String(role.to_string())),
            ("content".to_string(), Value::String(trimmed.to_string())),
        ])));
    }
}

fn compact_tool_content(messages: &mut [Value], max_chars: i64) {
    let safe_max = std::cmp::max(1, max_chars) as usize;
    for message in messages {
        let Some(row) = message.as_object_mut() else {
            continue;
        };
        let role = row
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if role != "tool" {
            continue;
        }
        let Some(content) = row.get("content").and_then(Value::as_str) else {
            continue;
        };
        if content.chars().count() > safe_max {
            let truncated = content.chars().take(safe_max).collect::<String>();
            row.insert(
                "content".to_string(),
                Value::String(format!("{}…", truncated)),
            );
        }
    }
}

fn trim_openai_messages(messages: Vec<Value>, max_non_system_messages: i64) -> Vec<Value> {
    let safe_max = std::cmp::max(1, max_non_system_messages) as usize;
    let mut system_messages = Vec::new();
    let mut non_system_messages = Vec::new();
    for message in messages {
        let role = message
            .as_object()
            .and_then(|row| row.get("role"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if role == "system" {
            system_messages.push(message);
        } else {
            non_system_messages.push(message);
        }
    }
    if non_system_messages.len() <= safe_max {
        system_messages.extend(non_system_messages);
        return system_messages;
    }
    let start = non_system_messages.len().saturating_sub(safe_max);
    system_messages.extend(non_system_messages.into_iter().skip(start));
    system_messages
}

fn tool_name(tool: &Value) -> String {
    let Some(row) = tool.as_object() else {
        return String::new();
    };
    row.get("function")
        .and_then(Value::as_object)
        .and_then(|function| function.get("name"))
        .and_then(Value::as_str)
        .or_else(|| row.get("name").and_then(Value::as_str))
        .unwrap_or("")
        .trim()
        .to_string()
}

fn drop_tool_by_function_name(tools: &[Value], name: &str) -> Vec<Value> {
    let target = name.trim();
    tools
        .iter()
        .filter(|tool| tool_name(tool) != target)
        .cloned()
        .collect()
}

fn append_tool_if_missing(
    tools: Option<&Vec<Value>>,
    tool_name_value: &str,
    tool_definition: &Value,
) -> Vec<Value> {
    let name = tool_name_value.trim();
    let mut next = tools.cloned().unwrap_or_default();
    if !next.iter().any(|tool| tool_name(tool) == name) {
        next.push(tool_definition.clone());
    }
    next
}

fn rebuild_vision_followup(
    messages: &[Value],
    summary: Option<&str>,
    original_prompt: Option<&str>,
) -> Vec<Value> {
    let mut next: Vec<Value> = messages
        .iter()
        .filter(|message| {
            message
                .as_object()
                .and_then(|row| row.get("role"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("system")
        })
        .cloned()
        .collect();
    append_text_message(&mut next, "user", original_prompt);
    append_text_message(&mut next, "user", summary);
    next
}

fn apply_single_delta_op(
    op: &Value,
    payload: &mut Map<String, Value>,
    adapter_context: &Value,
    final_chat_response: &Value,
) -> bool {
    let Some(op_row) = op.as_object() else {
        return true;
    };
    let kind = op_row.get("op").and_then(Value::as_str).unwrap_or("");
    let mut messages = payload
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    match kind {
        "append_assistant_message" => {
            if let Some(message) = extract_assistant_followup_message(final_chat_response) {
                messages.push(message);
                payload.insert("messages".to_string(), Value::Array(messages));
                true
            } else {
                op_row.get("required").and_then(Value::as_bool) != Some(true)
            }
        }
        "append_tool_messages_from_tool_outputs" => {
            let ok = append_tool_messages_from_tool_outputs(
                &mut messages,
                adapter_context,
                final_chat_response,
                op_row
                    .get("required")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            );
            payload.insert("messages".to_string(), Value::Array(messages));
            ok
        }
        "append_user_text" => {
            append_text_message(
                &mut messages,
                "user",
                op_row.get("text").and_then(Value::as_str),
            );
            payload.insert("messages".to_string(), Value::Array(messages));
            true
        }
        "inject_system_text" => {
            append_text_message(
                &mut messages,
                "system",
                op_row.get("text").and_then(Value::as_str),
            );
            payload.insert("messages".to_string(), Value::Array(messages));
            true
        }
        "preserve_tools" | "ensure_standard_tools" => true,
        "replace_tools" => {
            payload.insert(
                "tools".to_string(),
                Value::Array(clone_array(op_row.get("tools"))),
            );
            true
        }
        "force_tool_choice" => {
            if let Some(value) = op_row.get("value") {
                payload.insert("tool_choice".to_string(), value.clone());
            }
            true
        }
        "drop_tool_by_name" => {
            let tools = clone_array(payload.get("tools"));
            let name = op_row.get("name").and_then(Value::as_str).unwrap_or("");
            payload.insert(
                "tools".to_string(),
                Value::Array(drop_tool_by_function_name(&tools, name)),
            );
            true
        }
        "inject_vision_summary" => {
            append_text_message(
                &mut messages,
                "user",
                op_row.get("summary").and_then(Value::as_str),
            );
            payload.insert("messages".to_string(), Value::Array(messages));
            true
        }
        "rebuild_vision_followup" => {
            payload.insert(
                "messages".to_string(),
                Value::Array(rebuild_vision_followup(
                    &messages,
                    op_row.get("summary").and_then(Value::as_str),
                    op_row.get("originalPrompt").and_then(Value::as_str),
                )),
            );
            true
        }
        "trim_openai_messages" => {
            let max = op_row
                .get("maxNonSystemMessages")
                .and_then(Value::as_i64)
                .unwrap_or(1);
            payload.insert(
                "messages".to_string(),
                Value::Array(trim_openai_messages(messages, max)),
            );
            true
        }
        "append_tool_if_missing" => {
            let tool_name_value = op_row.get("toolName").and_then(Value::as_str).unwrap_or("");
            let tool_definition = op_row.get("toolDefinition").unwrap_or(&Value::Null);
            let tools = payload.get("tools").and_then(Value::as_array);
            payload.insert(
                "tools".to_string(),
                Value::Array(append_tool_if_missing(
                    tools,
                    tool_name_value,
                    tool_definition,
                )),
            );
            true
        }
        "compact_tool_content" => {
            let max = op_row.get("maxChars").and_then(Value::as_i64).unwrap_or(1);
            compact_tool_content(&mut messages, max);
            payload.insert("messages".to_string(), Value::Array(messages));
            true
        }
        _ => true,
    }
}

pub(crate) fn apply_followup_delta_plan(input: &Value) -> Option<Value> {
    let row = input.as_object()?;
    let seed = row.get("seed")?.as_object()?;
    let injection = row.get("injection")?.as_object()?;
    let mut payload = Map::new();
    let messages = seed.get("messages").and_then(Value::as_array)?.clone();
    payload.insert("messages".to_string(), Value::Array(messages));
    if let Some(model) = seed
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        payload.insert("model".to_string(), Value::String(model.to_string()));
    }
    if let Some(tools) = seed.get("tools").and_then(Value::as_array) {
        if !tools.is_empty() {
            payload.insert("tools".to_string(), Value::Array(tools.clone()));
        }
    }
    if let Some(parameters) = seed
        .get("parameters")
        .and_then(normalize_followup_parameters)
        .and_then(|value| value.as_object().cloned())
    {
        payload.insert("parameters".to_string(), Value::Object(parameters));
    }
    let ops = injection
        .get("ops")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let adapter_context = row.get("adapterContext").unwrap_or(&Value::Null);
    let final_chat_response = row.get("finalChatResponse").unwrap_or(&Value::Null);
    for op in &ops {
        if !apply_single_delta_op(op, &mut payload, adapter_context, final_chat_response) {
            return None;
        }
    }
    Some(Value::Object(payload))
}

#[napi]
pub fn extract_captured_chat_seed_json(captured_json: String) -> NapiResult<String> {
    let captured: Value = serde_json::from_str(&captured_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    serde_json::to_string(&extract_captured_chat_seed(&captured).unwrap_or(Value::Null))
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi]
pub fn resolve_followup_model_json(
    seed_model_json: String,
    adapter_context_json: String,
) -> NapiResult<String> {
    let seed_model: Value = serde_json::from_str(&seed_model_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let adapter_context: Value = serde_json::from_str(&adapter_context_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    serde_json::to_string(&resolve_followup_model(&seed_model, &adapter_context))
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi]
pub fn normalize_followup_parameters_json(parameters_json: String) -> NapiResult<String> {
    let parameters: Value = serde_json::from_str(&parameters_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    serde_json::to_string(&normalize_followup_parameters(&parameters).unwrap_or(Value::Null))
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi]
pub fn extract_assistant_followup_message_json(
    final_chat_response_json: String,
) -> NapiResult<String> {
    let final_chat_response: Value = serde_json::from_str(&final_chat_response_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    serde_json::to_string(
        &extract_assistant_followup_message(&final_chat_response).unwrap_or(Value::Null),
    )
    .map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[napi]
pub fn apply_followup_delta_plan_json(input_json: String) -> NapiResult<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
    serde_json::to_string(&apply_followup_delta_plan(&input).unwrap_or(Value::Null))
        .map_err(|error| napi::Error::from_reason(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn applies_tool_output_delta_and_drops_tool() {
        let input = json!({
            "adapterContext": {},
            "finalChatResponse": {
                "choices": [{"message": {"role":"assistant", "content": null}}],
                "tool_outputs": [{
                    "tool_call_id": "call_apply_patch_test",
                    "name": "apply_patch",
                    "arguments": "{\"filePath\":\"target.txt\",\"patch\":\"- old\\n+ new\"}",
                    "content": "{\"ok\":true}"
                }]
            },
            "seed": {
                "model": "gpt-test",
                "messages": [{"role":"user", "content":"edit target"}],
                "tools": [
                    {"type":"function", "function":{"name":"apply_patch", "parameters":{"type":"object"}}},
                    {"type":"function", "function":{"name":"exec_command", "parameters":{"type":"object"}}}
                ]
            },
            "injection": {
                "ops": [
                    {"op":"append_tool_messages_from_tool_outputs", "required": true},
                    {"op":"drop_tool_by_name", "name":"apply_patch"}
                ]
            }
        });
        let payload = apply_followup_delta_plan(&input).expect("payload");
        assert_eq!(
            payload["messages"][1]["tool_calls"][0]["id"],
            "call_apply_patch_test"
        );
        assert_eq!(payload["messages"][2]["role"], "tool");
        assert_eq!(payload["tools"].as_array().unwrap().len(), 1);
        assert_eq!(payload["tools"][0]["function"]["name"], "exec_command");
    }

    #[test]
    fn extracts_followup_seed_from_chat_and_responses_input() {
        let chat = json!({
            "model": " gpt-test ",
            "messages": [{"role":"user", "content":"hello"}],
            "tools": [{"type":"function", "function":{"name":"exec_command"}}],
            "parameters": {"stream": true, "tool_choice": "auto", "temperature": 0.2}
        });
        let chat_seed = extract_captured_chat_seed(&chat).expect("chat seed");
        assert_eq!(chat_seed["model"], "gpt-test");
        assert_eq!(chat_seed["messages"][0]["content"], "hello");
        assert_eq!(chat_seed["parameters"]["temperature"], 0.2);
        assert!(chat_seed["parameters"].get("stream").is_none());
        assert_eq!(chat_seed["parameters"]["tool_choice"], "auto");

        let responses = json!({
            "model": "gpt-resp",
            "input": "  explain this  ",
            "max_tokens": 42,
            "stream": true,
            "tool_choice": "auto"
        });
        let responses_seed = extract_captured_chat_seed(&responses).expect("responses seed");
        assert_eq!(responses_seed["messages"][0]["role"], "user");
        assert_eq!(responses_seed["messages"][0]["content"], "explain this");
        assert_eq!(responses_seed["parameters"]["max_output_tokens"], 42);
        assert!(responses_seed["parameters"].get("stream").is_none());
        assert_eq!(responses_seed["parameters"]["tool_choice"], "auto");
    }

    #[test]
    fn extracts_followup_seed_maps_responses_history_sentinel_prefix_to_reasoning() {
        let responses = json!({
            "model": "gpt-resp",
            "input": [{
                "type": "message",
                "role": "assistant",
                "content": [{
                    "type": "output_text",
                    "text": "DNS 已切回 coder2。]<]minimax[>[Jason，继续执行。"
                }]
            }]
        });

        let seed = extract_captured_chat_seed(&responses).expect("seed");
        assert_eq!(seed["messages"][0]["role"], "assistant");
        assert_eq!(
            seed["messages"][0]["reasoning_content"],
            "DNS 已切回 coder2。"
        );
        assert_eq!(seed["messages"][0]["content"], "Jason，继续执行。");
        let serialized = serde_json::to_string(&seed).unwrap();
        assert!(!serialized.contains("]<]minimax[>["));
    }

    #[test]
    fn apply_followup_delta_preserves_seed_tool_choice() {
        let input = json!({
            "adapterContext": {},
            "finalChatResponse": {"choices": [{"message": {"role": "assistant", "content": "continue"}}]},
            "seed": {
                "model": "gpt-test",
                "messages": [{"role": "user", "content": "continue"}],
                "tools": [{"type": "function", "function": {"name": "apply_patch", "parameters": {"type": "object"}}}],
                "parameters": {"stream": true, "tool_choice": {"type": "auto"}, "temperature": 0.2}
            },
            "injection": {"ops": [{"op": "preserve_tools"}]}
        });

        let payload = apply_followup_delta_plan(&input).expect("payload");
        assert_eq!(
            payload["parameters"]["tool_choice"],
            json!({"type": "auto"})
        );
        assert!(payload["parameters"].get("stream").is_none());
    }

    #[test]
    fn extract_assistant_followup_message_maps_provider_sentinel_prefix_to_reasoning() {
        let response = json!({
            "output": [{
                "type": "message",
                "role": "assistant",
                "content": [{
                    "type": "output_text",
                    "text": "DNS 已切回 coder2。]<]minimax[>[Jason，继续执行。"
                }]
            }]
        });

        let message = extract_assistant_followup_message(&response).expect("message");
        assert_eq!(message["role"], "assistant");
        assert_eq!(message["reasoning_content"], "DNS 已切回 coder2。");
        assert_eq!(message["content"], "Jason，继续执行。");
        let serialized = serde_json::to_string(&message).unwrap();
        assert!(!serialized.contains("]<]minimax[>["));
    }

    #[test]
    fn resolves_followup_model_precedence() {
        assert_eq!(
            resolve_followup_model(
                &Value::String("seed-model".to_string()),
                &json!({"originalModelId":"orig", "model":"ctx", "modelId":"model-id", "assignedModelId":"assigned"})
            ),
            "assigned"
        );
        assert_eq!(
            resolve_followup_model(
                &Value::String("seed-model".to_string()),
                &json!({"model":"ctx"})
            ),
            "seed-model"
        );
    }
}

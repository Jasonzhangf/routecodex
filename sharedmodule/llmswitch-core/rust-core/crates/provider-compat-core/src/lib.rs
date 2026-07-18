//! Pure Rust provider compatibility profile core.
//!
//! This crate is intentionally NAPI-free so V3 runtime/CLI can link it without
//! Node symbols. The profile ids and behavior are carried from the existing
//! `req_outbound_stage3_compat` Rust profile surface used by V2.

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

// feature_id: v3.provider_compat_profile_loading

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterContext {
    #[serde(default)]
    pub compatibility_profile: Option<String>,
    #[serde(default)]
    pub provider_protocol: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub entry_endpoint: Option<String>,
    #[serde(default)]
    pub route_id: Option<String>,
    #[serde(default, rename = "__rt")]
    pub rt: Option<Value>,
    #[serde(default)]
    pub captured_chat_request: Option<Value>,
    #[serde(default)]
    pub deepseek: Option<Value>,
    #[serde(default)]
    pub anthropic_thinking: Option<String>,
    #[serde(default)]
    pub estimated_input_tokens: Option<f64>,
    #[serde(default)]
    pub model_id: Option<String>,
    #[serde(default)]
    pub client_model_id: Option<String>,
    #[serde(default)]
    pub original_model_id: Option<String>,
    #[serde(default)]
    pub provider_id: Option<String>,
    #[serde(default)]
    pub provider_key: Option<String>,
    #[serde(default)]
    pub runtime_key: Option<String>,
    #[serde(default)]
    pub client_request_id: Option<String>,
    #[serde(default)]
    pub group_request_id: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReqOutboundCompatInput {
    pub payload: Value,
    pub adapter_context: AdapterContext,
    #[serde(default)]
    pub explicit_profile: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatResult {
    pub payload: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_profile: Option<String>,
    pub native_applied: bool,
}

pub mod req_outbound_stage3_compat {
    pub use super::{
        run_req_outbound_stage3_compat, run_resp_inbound_stage3_compat, AdapterContext,
        CompatResult, ReqOutboundCompatInput,
    };
}

pub fn run_req_outbound_stage3_compat(
    input: ReqOutboundCompatInput,
) -> Result<CompatResult, String> {
    let profile = pick_compat_profile(&input);
    // V3 relay provider semantic is already built by the provider protocol owner.
    // Until a request-side profile is explicitly proven required for V3, request
    // compat loads the profile identity but performs no payload cleanup. This
    // prevents GPT/direct-style request cleaning from leaking into V3 provider
    // compat while keeping the adjacent node and applied profile observable.
    Ok(CompatResult {
        payload: input.payload,
        applied_profile: profile,
        native_applied: true,
    })
}

pub fn run_resp_inbound_stage3_compat(
    input: ReqOutboundCompatInput,
) -> Result<CompatResult, String> {
    let profile = pick_compat_profile(&input);
    let Some(profile_id) = profile.as_deref() else {
        return Ok(build_compat_result(input.payload, None));
    };

    if is_minimax_profile(profile_id) {
        if provider_protocol_matches(
            input.adapter_context.provider_protocol.as_ref(),
            "openai-responses",
        ) || provider_protocol_matches(
            input.adapter_context.provider_protocol.as_ref(),
            "openai-chat",
        ) {
            return Ok(CompatResult {
                payload: harvest_text_tool_calls(input.payload)?,
                applied_profile: Some(profile_id.to_string()),
                native_applied: true,
            });
        }
        return Ok(build_compat_result(input.payload, None));
    }

    if is_glm_profile(profile_id) {
        if provider_protocol_matches(
            input.adapter_context.provider_protocol.as_ref(),
            "openai-chat",
        ) {
            return Ok(CompatResult {
                payload: apply_glm_response_compat(input.payload),
                applied_profile: Some(profile_id.to_string()),
                native_applied: true,
            });
        }
        return Ok(build_compat_result(input.payload, None));
    }

    Ok(build_compat_result(input.payload, None))
}

fn strip_top_level_provider_internal_fields(payload: Value) -> Value {
    let Some(mut root) = payload.as_object().cloned() else {
        return payload;
    };
    root.remove("semantics");
    root.remove("processed");
    root.remove("processingMetadata");
    Value::Object(root)
}

fn normalize_profile(profile: Option<&String>) -> Option<String> {
    profile
        .map(|profile| profile.trim())
        .filter(|profile| !profile.is_empty())
        .map(str::to_ascii_lowercase)
}

fn pick_compat_profile(input: &ReqOutboundCompatInput) -> Option<String> {
    normalize_profile(input.explicit_profile.as_ref())
        .or_else(|| normalize_profile(input.adapter_context.compatibility_profile.as_ref()))
}

fn build_compat_result(payload: Value, profile: Option<String>) -> CompatResult {
    CompatResult {
        payload: strip_top_level_provider_internal_fields(payload),
        applied_profile: profile,
        native_applied: true,
    }
}

fn profile_matches(profile: &str, expected: &str) -> bool {
    profile.trim().eq_ignore_ascii_case(expected)
}

fn is_minimax_profile(profile: &str) -> bool {
    profile_matches(profile, "chat:minimax")
}

fn is_glm_profile(profile: &str) -> bool {
    profile_matches(profile, "chat:glm")
}

fn provider_protocol_matches(protocol: Option<&String>, expected: &str) -> bool {
    match protocol {
        Some(value) => value.trim().eq_ignore_ascii_case(expected),
        None => false,
    }
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn normalize_routecodex_tool_name(raw: Option<&str>) -> Option<String> {
    let value = raw?.trim();
    if value.is_empty() {
        return None;
    }
    let lowered = value.to_ascii_lowercase();
    match lowered.as_str() {
        "exec" | "shell" | "terminal" | "bash" | "sh" => Some("exec_command".to_string()),
        "patch" | "applypatch" | "apply-patch" => Some("apply_patch".to_string()),
        "plan" => Some("update_plan".to_string()),
        "image" => Some("view_image".to_string()),
        _ => {
            let mut out = String::new();
            for ch in value.chars() {
                if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.' {
                    out.push(ch);
                } else if !ch.is_whitespace() {
                    out.push('_');
                }
            }
            let trimmed = out
                .trim_matches(|ch: char| matches!(ch, '_' | '-' | '.'))
                .to_string();
            if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("tool") {
                None
            } else {
                Some(trimmed)
            }
        }
    }
}

fn sanitize_id_token(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "id".to_string()
    } else {
        trimmed
    }
}

fn short_hash(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    digest
        .iter()
        .take(5)
        .map(|byte| format!("{:02x}", byte))
        .collect::<String>()
}

fn normalize_function_call_id(call_id: Option<&str>, fallback: &str) -> String {
    let raw = call_id.unwrap_or(fallback).trim();
    let safe = sanitize_id_token(raw);
    let normalized = if safe.to_ascii_lowercase().starts_with("fc_") {
        safe.clone()
    } else {
        format!("fc_{}", safe.trim_start_matches("call_"))
    };
    if normalized.len() <= 64 {
        return normalized;
    }
    let hash = short_hash(raw);
    let room = 64usize.saturating_sub("fc_".len() + 1 + hash.len()).max(1);
    let head = sanitize_id_token(&safe.chars().take(room).collect::<String>());
    format!("fc_{}_{}", head, hash)
}

fn stringify_arguments(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(value) => serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string()),
        None => "{}".to_string(),
    }
}

#[derive(Debug, Clone)]
struct ParsedCompatToolCall {
    call_id: Option<String>,
    name: String,
    arguments: String,
}

fn parsed_tool_call_from_value(value: &Value) -> Option<ParsedCompatToolCall> {
    let row = value.as_object()?;
    let function = row.get("function").and_then(Value::as_object);
    let name = function
        .and_then(|row| read_trimmed_string(row.get("name")))
        .or_else(|| read_trimmed_string(row.get("name")))?;
    let normalized_name = normalize_routecodex_tool_name(Some(name.as_str()))?;
    let arguments = function
        .and_then(|row| row.get("arguments"))
        .or_else(|| row.get("arguments"))
        .or_else(|| row.get("input"));
    let call_id = read_trimmed_string(row.get("call_id"))
        .or_else(|| read_trimmed_string(row.get("tool_call_id")))
        .or_else(|| read_trimmed_string(row.get("id")));
    Some(ParsedCompatToolCall {
        call_id,
        name: normalized_name,
        arguments: stringify_arguments(arguments),
    })
}

fn parsed_tool_calls_from_json_value(value: &Value) -> Vec<ParsedCompatToolCall> {
    if let Some(row) = value.as_object() {
        if let Some(calls) = row.get("tool_calls").and_then(Value::as_array) {
            return calls
                .iter()
                .filter_map(parsed_tool_call_from_value)
                .collect();
        }
        if row.get("name").is_some() || row.get("function").is_some() {
            return parsed_tool_call_from_value(value).into_iter().collect();
        }
    }
    if let Some(items) = value.as_array() {
        return items
            .iter()
            .flat_map(parsed_tool_calls_from_json_value)
            .collect();
    }
    Vec::new()
}

fn extract_balanced_json_candidate_at(text: &str, start: usize) -> Option<(usize, String)> {
    let bytes = text.as_bytes();
    let open = *bytes.get(start)?;
    let close = match open {
        b'{' => b'}',
        b'[' => b']',
        _ => return None,
    };
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escape = false;
    for (offset, ch) in text[start..].char_indices() {
        if in_string {
            if escape {
                escape = false;
            } else if ch == '\\' {
                escape = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch as u8 {
            b'"' => in_string = true,
            value if value == open => depth += 1,
            value if value == close => {
                depth -= 1;
                if depth == 0 {
                    let end = start + offset + ch.len_utf8();
                    return Some((end, text[start..end].to_string()));
                }
            }
            _ => {}
        }
    }
    None
}

fn collect_json_candidates(text: &str) -> Vec<String> {
    let mut candidates = Vec::new();
    let function_calls_re = Regex::new(r"(?is)<function_calls>([\s\S]*?)</function_calls>")
        .expect("valid function_calls regex");
    for caps in function_calls_re.captures_iter(text) {
        if let Some(body) = caps.get(1) {
            let trimmed = body.as_str().trim();
            if !trimmed.is_empty() {
                candidates.push(trimmed.to_string());
            }
        }
    }
    if candidates.is_empty() && (text.contains("tool_calls") || text.contains("\"name\"")) {
        let mut index = 0usize;
        while index < text.len() {
            let Some(ch) = text[index..].chars().next() else {
                break;
            };
            if ch == '{' || ch == '[' {
                if let Some((end, candidate)) = extract_balanced_json_candidate_at(text, index) {
                    candidates.push(candidate);
                    index = end;
                    continue;
                }
            }
            index += ch.len_utf8();
        }
    }
    candidates
}

fn parse_json_tool_calls(text: &str) -> Vec<ParsedCompatToolCall> {
    collect_json_candidates(text)
        .iter()
        .filter_map(|candidate| serde_json::from_str::<Value>(candidate).ok())
        .flat_map(|value| parsed_tool_calls_from_json_value(&value))
        .collect()
}

fn parse_xml_scalar(raw: &str) -> Value {
    serde_json::from_str::<Value>(raw).unwrap_or_else(|_| Value::String(raw.to_string()))
}

fn parse_invoke_tool_calls(text: &str) -> Vec<ParsedCompatToolCall> {
    let invoke_re =
        Regex::new(r#"(?is)<invoke\s+name=[\"']([^\"']+)[\"'][^>]*>([\s\S]*?)</invoke>"#)
            .expect("valid invoke regex");
    let param_re =
        Regex::new(r#"(?is)<parameter\s+name=[\"']([^\"']+)[\"'][^>]*>([\s\S]*?)</parameter>"#)
            .expect("valid parameter regex");
    let mut out = Vec::new();
    for caps in invoke_re.captures_iter(text) {
        let Some(name) = caps.get(1).map(|m| m.as_str().trim()) else {
            continue;
        };
        let Some(normalized_name) = normalize_routecodex_tool_name(Some(name)) else {
            continue;
        };
        let inner = caps.get(2).map(|m| m.as_str()).unwrap_or_default();
        let mut args = Map::new();
        for param_caps in param_re.captures_iter(inner) {
            let key = param_caps
                .get(1)
                .map(|m| m.as_str().trim())
                .filter(|key| !key.is_empty());
            let raw = param_caps
                .get(2)
                .map(|m| m.as_str().trim())
                .unwrap_or_default();
            if let Some(key) = key {
                args.insert(key.to_string(), parse_xml_scalar(raw));
            }
        }
        out.push(ParsedCompatToolCall {
            call_id: None,
            name: normalized_name,
            arguments: stringify_arguments(Some(&Value::Object(args))),
        });
    }
    out
}

fn parse_arg_pair_tool_calls(text: &str) -> Vec<ParsedCompatToolCall> {
    let block_re =
        Regex::new(r"(?is)<tool_call[^>]*>[\s\S]*?</tool_call>").expect("valid tool_call regex");
    let name_tag_re =
        Regex::new(r"(?is)<tool_name>([\s\S]*?)</tool_name>").expect("valid tool_name regex");
    let pair_re =
        Regex::new(r"(?is)<arg_key>([\s\S]*?)</arg_key>\s*<arg_value>([\s\S]*?)</arg_value>")
            .expect("valid arg pair regex");
    let mut out = Vec::new();
    for block in block_re.find_iter(text) {
        let block_text = block.as_str();
        let mut name = name_tag_re
            .captures(block_text)
            .and_then(|caps| caps.get(1))
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        if name.is_empty() {
            if block_text.contains("exec_command") || block_text.contains("<arg_key>cmd</arg_key>")
            {
                name = "exec_command".to_string();
            } else if block_text.contains("apply_patch") {
                name = "apply_patch".to_string();
            } else if block_text.contains("update_plan") {
                name = "update_plan".to_string();
            } else if block_text.contains("view_image") {
                name = "view_image".to_string();
            }
        }
        let Some(normalized_name) = normalize_routecodex_tool_name(Some(name.as_str())) else {
            continue;
        };
        let mut args = Map::new();
        for caps in pair_re.captures_iter(block_text) {
            let key = caps
                .get(1)
                .map(|m| m.as_str().trim())
                .filter(|key| !key.is_empty());
            let raw = caps.get(2).map(|m| m.as_str().trim()).unwrap_or_default();
            if let Some(key) = key {
                let normalized_key = if normalized_name == "exec_command" && key == "command" {
                    "cmd"
                } else {
                    key
                };
                args.insert(normalized_key.to_string(), parse_xml_scalar(raw));
            }
        }
        out.push(ParsedCompatToolCall {
            call_id: None,
            name: normalized_name,
            arguments: stringify_arguments(Some(&Value::Object(args))),
        });
    }
    out
}

fn parse_text_tool_calls(text: &str) -> Vec<ParsedCompatToolCall> {
    let json_calls = parse_json_tool_calls(text);
    if !json_calls.is_empty() {
        return json_calls;
    }
    let invoke_calls = parse_invoke_tool_calls(text);
    if !invoke_calls.is_empty() {
        return invoke_calls;
    }
    parse_arg_pair_tool_calls(text)
}

fn extract_responses_message_text(item: &Map<String, Value>) -> String {
    let mut parts = Vec::new();
    if let Some(Value::Array(content)) = item.get("content") {
        for part in content {
            let Some(part_obj) = part.as_object() else {
                continue;
            };
            if let Some(text) = read_trimmed_string(part_obj.get("text"))
                .or_else(|| read_trimmed_string(part_obj.get("content")))
                .or_else(|| read_trimmed_string(part_obj.get("value")))
            {
                if !parts.iter().any(|existing| existing == &text) {
                    parts.push(text);
                }
            }
        }
    }
    if let Some(text) = read_trimmed_string(item.get("output_text")) {
        if !parts.iter().any(|existing| existing == &text) {
            parts.push(text);
        }
    }
    parts.join("\n").trim().to_string()
}

fn responses_function_call_from_parsed(call: ParsedCompatToolCall, fallback_index: usize) -> Value {
    let call_id = call
        .call_id
        .filter(|call_id| !call_id.trim().is_empty())
        .unwrap_or_else(|| format!("call_auto_{}", fallback_index));
    let item_id = normalize_function_call_id(Some(call_id.as_str()), "fc_auto");
    json!({
        "type": "function_call",
        "id": item_id,
        "call_id": call_id,
        "name": call.name,
        "arguments": call.arguments
    })
}

fn harvest_responses_output_in_place(root: &mut Map<String, Value>) {
    let Some(Value::Array(output)) = root.get("output") else {
        return;
    };
    let mut next_output = Vec::new();
    let mut changed = false;
    let mut fallback_counter = 0usize;

    for item in output {
        let Some(item_obj) = item.as_object() else {
            next_output.push(item.clone());
            continue;
        };
        let item_type = read_trimmed_string(item_obj.get("type"))
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        let role = read_trimmed_string(item_obj.get("role"))
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        if item_type != "message" || role != "assistant" {
            next_output.push(item.clone());
            continue;
        }
        let text = extract_responses_message_text(item_obj);
        if text.is_empty() {
            next_output.push(item.clone());
            continue;
        }
        let calls = parse_text_tool_calls(text.as_str());
        if calls.is_empty() {
            next_output.push(item.clone());
            continue;
        }
        changed = true;
        for call in calls {
            fallback_counter += 1;
            next_output.push(responses_function_call_from_parsed(call, fallback_counter));
        }
    }

    if changed {
        root.insert("output".to_string(), Value::Array(next_output));
        root.remove("output_text");
    }
}

fn chat_tool_call_from_parsed(call: ParsedCompatToolCall, fallback_index: usize) -> Value {
    let call_id = call
        .call_id
        .filter(|call_id| !call_id.trim().is_empty())
        .unwrap_or_else(|| format!("call_auto_{}", fallback_index));
    json!({
        "id": call_id,
        "type": "function",
        "function": {
            "name": call.name,
            "arguments": call.arguments,
        }
    })
}

fn harvest_chat_choices_in_place(root: &mut Map<String, Value>) {
    let Some(Value::Array(choices)) = root.get_mut("choices") else {
        return;
    };
    for choice in choices.iter_mut() {
        let Some(choice_obj) = choice.as_object_mut() else {
            continue;
        };
        let text = choice_obj
            .get("message")
            .and_then(Value::as_object)
            .and_then(|message| read_trimmed_string(message.get("content")))
            .unwrap_or_default();
        if text.is_empty() {
            continue;
        }
        let calls = parse_text_tool_calls(text.as_str());
        if calls.is_empty() {
            continue;
        }
        let tool_calls: Vec<Value> = calls
            .into_iter()
            .enumerate()
            .map(|(idx, call)| chat_tool_call_from_parsed(call, idx + 1))
            .collect();
        if let Some(message) = choice_obj.get_mut("message").and_then(Value::as_object_mut) {
            message.insert("tool_calls".to_string(), Value::Array(tool_calls));
            message.insert("content".to_string(), Value::Null);
        }
        let finish = read_trimmed_string(choice_obj.get("finish_reason"))
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        if finish.is_empty() || finish == "stop" || finish == "length" {
            choice_obj.insert(
                "finish_reason".to_string(),
                Value::String("tool_calls".to_string()),
            );
        }
    }
}

fn harvest_text_tool_calls(payload: Value) -> Result<Value, String> {
    let mut payload = payload;
    let Some(root) = payload.as_object_mut() else {
        return Ok(payload);
    };
    let choices_len = root
        .get("choices")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    if choices_len > 0 {
        harvest_chat_choices_in_place(root);
    } else {
        harvest_responses_output_in_place(root);
    }
    Ok(payload)
}

fn apply_glm_response_compat(payload: Value) -> Value {
    let Some(root) = payload.as_object() else {
        return payload;
    };
    let Some(choices) = root.get("choices").and_then(Value::as_array) else {
        return payload;
    };
    let mut next_root = root.clone();
    let mut changed = false;
    let mut next_choices = Vec::new();
    for choice in choices {
        let Some(choice_obj) = choice.as_object() else {
            next_choices.push(choice.clone());
            continue;
        };
        let Some(message) = choice_obj.get("message").and_then(Value::as_object) else {
            next_choices.push(choice.clone());
            continue;
        };
        let reasoning = read_trimmed_string(message.get("reasoning_content"))
            .or_else(|| read_trimmed_string(message.get("reasoning")))
            .unwrap_or_default();
        if reasoning.is_empty() {
            next_choices.push(choice.clone());
            continue;
        }
        let calls = parse_text_tool_calls(reasoning.as_str());
        if calls.is_empty() {
            next_choices.push(choice.clone());
            continue;
        }
        let tool_calls: Vec<Value> = calls
            .into_iter()
            .enumerate()
            .map(|(idx, call)| chat_tool_call_from_parsed(call, idx + 1))
            .collect();
        let mut next_choice = choice_obj.clone();
        let mut next_message = message.clone();
        next_message.insert("tool_calls".to_string(), Value::Array(tool_calls));
        next_message.insert("content".to_string(), Value::Null);
        next_choice.insert("message".to_string(), Value::Object(next_message));
        next_choice.insert(
            "finish_reason".to_string(),
            Value::String("tool_calls".to_string()),
        );
        next_choices.push(Value::Object(next_choice));
        changed = true;
    }
    if changed {
        next_root.insert("choices".to_string(), Value::Array(next_choices));
        Value::Object(next_root)
    } else {
        payload
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimax_response_profile_harvests_responses_function_calls_xml_without_text_leak() {
        let input = ReqOutboundCompatInput {
            payload: json!({
                "object": "response",
                "id": "resp_minimax_tool_text_1",
                "output": [{
                    "type": "message",
                    "role": "assistant",
                    "content": [{
                        "type": "output_text",
                        "text": "<function_calls>{\"tool_calls\":[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"pwd\"}}]}</function_calls>"
                    }],
                    "output_text": "<function_calls>{\"tool_calls\":[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"pwd\"}}]}</function_calls>"
                }],
                "output_text": "<function_calls>{\"tool_calls\":[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"pwd\"}}]}</function_calls>"
            }),
            adapter_context: AdapterContext {
                compatibility_profile: Some("chat:minimax".to_string()),
                provider_protocol: Some("openai-responses".to_string()),
                ..Default::default()
            },
            explicit_profile: None,
        };
        let result = run_resp_inbound_stage3_compat(input).unwrap();
        assert!(result.native_applied);
        assert_eq!(result.applied_profile.as_deref(), Some("chat:minimax"));
        assert_eq!(result.payload["output"][0]["type"], "function_call");
        assert_eq!(result.payload["output"][0]["name"], "exec_command");
        assert_eq!(
            result.payload["output"][0]["arguments"]
                .as_str()
                .unwrap_or(""),
            "{\"cmd\":\"pwd\"}"
        );
        let serialized = serde_json::to_string(&result.payload).unwrap();
        assert!(!serialized.contains("<function_calls>"));
    }

    #[test]
    fn minimax_response_profile_harvests_invoke_xml_tool_call() {
        let input = ReqOutboundCompatInput {
            payload: json!({
                "object": "response",
                "id": "resp_minimax_invoke_tool_1",
                "output": [{
                    "type": "message",
                    "role": "assistant",
                    "content": [{
                        "type": "output_text",
                        "text": "<tool_call><invoke name=\"exec\"><parameter name=\"cmd\">pwd</parameter></invoke></tool_call>"
                    }]
                }]
            }),
            adapter_context: AdapterContext {
                compatibility_profile: Some("chat:minimax".to_string()),
                provider_protocol: Some("openai-responses".to_string()),
                ..Default::default()
            },
            explicit_profile: None,
        };
        let result = run_resp_inbound_stage3_compat(input).unwrap();
        assert_eq!(result.payload["output"][0]["type"], "function_call");
        assert_eq!(result.payload["output"][0]["name"], "exec_command");
        assert_eq!(
            result.payload["output"][0]["arguments"]
                .as_str()
                .unwrap_or(""),
            "{\"cmd\":\"pwd\"}"
        );
    }

    #[test]
    fn passthrough_profile_does_not_harvest_minimax_text() {
        let input = ReqOutboundCompatInput {
            payload: json!({
                "object": "response",
                "output": [{
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "<function_calls>{\"tool_calls\":[{\"name\":\"exec_command\",\"arguments\":{\"cmd\":\"pwd\"}}]}</function_calls>"}]
                }]
            }),
            adapter_context: AdapterContext {
                compatibility_profile: None,
                provider_protocol: Some("openai-responses".to_string()),
                ..Default::default()
            },
            explicit_profile: None,
        };
        let result = run_resp_inbound_stage3_compat(input).unwrap();
        assert_eq!(result.applied_profile, None);
        assert_eq!(result.payload["output"][0]["type"], "message");
    }

    #[test]
    fn request_stage_loads_profile_without_payload_cleanup() {
        let input = ReqOutboundCompatInput {
            payload: json!({
                "messages": [{"role": "user", "content": "hi"}],
                "semantics": {"internal": true},
                "processed": {"marker": "must-preserve"},
                "processingMetadata": {"marker": "must-preserve"}
            }),
            adapter_context: AdapterContext {
                compatibility_profile: Some("chat:minimax".to_string()),
                provider_protocol: Some("openai-responses".to_string()),
                ..Default::default()
            },
            explicit_profile: None,
        };
        let result = run_req_outbound_stage3_compat(input).unwrap();
        assert_eq!(result.applied_profile.as_deref(), Some("chat:minimax"));
        assert_eq!(result.payload["semantics"], json!({"internal": true}));
        assert_eq!(
            result.payload["processed"],
            json!({"marker": "must-preserve"})
        );
        assert_eq!(
            result.payload["processingMetadata"],
            json!({"marker": "must-preserve"})
        );
        assert_eq!(result.payload["messages"][0]["content"], "hi");
    }
}

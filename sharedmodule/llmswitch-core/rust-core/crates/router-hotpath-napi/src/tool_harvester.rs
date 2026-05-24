use napi::bindgen_prelude::Result as NapiResult;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use uuid::Uuid;

use crate::hub_reasoning_tool_normalizer::normalize_assistant_text_to_tool_calls_json;
use crate::shared_json_utils::{extract_balanced_json_candidate_at, split_command_string};
use crate::shared_tool_mapping::{
    normalize_routecodex_tool_name, read_routecodex_tool_name_hint_from_args,
};
use crate::shared_tooling::{
    chunk_string_by_bytes, extract_rcc_tool_call_fence_segments,
    extract_structured_apply_patch_payloads_with,
    repair_arguments_to_string,
};

#[cfg(test)]
mod tests;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarvestContext {
    pub request_id: Option<String>,
    pub id_prefix: Option<String>,
    pub chunk_size: Option<i64>,
    pub source: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HarvestSignal {
    #[serde(rename = "type")]
    pub signal_type: String,
    pub payload: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarvestInput {
    pub signal: HarvestSignal,
    pub context: Option<HarvestContext>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarvestResult {
    pub delta_events: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub normalized: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats: Option<Value>,
}

#[derive(Debug, Default, Clone)]
struct DedupeEntry {
    name: Option<String>,
    args_hash: Option<String>,
}

static DEDUPE_STATE: OnceLock<Mutex<HashMap<String, DedupeEntry>>> = OnceLock::new();

fn dedupe_state() -> &'static Mutex<HashMap<String, DedupeEntry>> {
    DEDUPE_STATE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn hash_string(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::new();
    for byte in digest.iter().take(8) {
        out.push_str(&format!("{:02x}", byte));
    }
    out
}


fn gen_id(ctx: Option<&HarvestContext>, index: usize) -> String {
    let prefix = ctx
        .and_then(|c| c.id_prefix.as_ref())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "call".to_string());
    let stamp = chrono::Utc::now().timestamp_millis();
    let suffix = Uuid::new_v4().simple().to_string();
    format!("{}_{}_{}_{}", prefix, stamp, &suffix[..6], index)
}

fn collect_json_candidates(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen = HashSet::<String>::new();
    for candidate in extract_rcc_tool_call_fence_segments(text) {
        if seen.insert(candidate.clone()) {
            out.push(candidate);
        }
    }
    let fence_re = Regex::new(r"```(?:json)?\s*([\s\S]*?)\s*```").unwrap();
    for caps in fence_re.captures_iter(text) {
        if let Some(body) = caps.get(1) {
            let candidate = body.as_str().trim();
            if !candidate.is_empty() && seen.insert(candidate.to_string()) {
                out.push(candidate.to_string());
            }
        }
    }
    if out.is_empty() && (text.contains("tool_calls") || text.contains("\"name\"")) {
        let mut index = 0usize;
        while index < text.len() {
            let Some(ch) = text[index..].chars().next() else {
                break;
            };
            if ch == '{' {
                if let Some((end, candidate)) =
                    extract_balanced_json_candidate_at(text, index, '{', '}')
                {
                    if seen.insert(candidate.clone()) {
                        out.push(candidate);
                    }
                    index = end;
                    continue;
                }
            } else if ch == '[' {
                if let Some((end, candidate)) =
                    extract_balanced_json_candidate_at(text, index, '[', ']')
                {
                    if seen.insert(candidate.clone()) {
                        out.push(candidate);
                    }
                    index = end;
                    continue;
                }
            }
            index += ch.len_utf8();
        }
    }
    out
}

fn extract_tool_call_entries_from_json_value(value: &Value) -> Vec<Value> {
    if let Some(obj) = value.as_object() {
        if let Some(calls) = obj.get("tool_calls").and_then(Value::as_array) {
            return calls.clone();
        }
        if obj.get("name").is_some() || obj.get("function").is_some() {
            return vec![value.clone()];
        }
    }
    if let Some(arr) = value.as_array() {
        let mut out: Vec<Value> = Vec::new();
        for item in arr {
            if let Some(obj) = item.as_object() {
                if obj.get("name").is_some() || obj.get("function").is_some() {
                    out.push(item.clone());
                } else if let Some(calls) = obj.get("tool_calls").and_then(Value::as_array) {
                    for call in calls {
                        out.push(call.clone());
                    }
                }
            }
        }
        return out;
    }
    Vec::new()
}

fn build_tool_events_from_entries(
    entries: Vec<Value>,
    ctx: Option<&HarvestContext>,
    chunk_size: usize,
) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut idx = 0usize;
    for call in entries {
        let Some(call_obj) = call.as_object() else {
            continue;
        };
        let fn_obj = call_obj.get("function").and_then(Value::as_object);
        let args_value = fn_obj
            .and_then(|row| row.get("arguments"))
            .cloned()
            .or_else(|| call_obj.get("arguments").cloned())
            .or_else(|| call_obj.get("input").cloned())
            .unwrap_or_else(|| Value::Object(Map::new()));
        let hinted_name = read_routecodex_tool_name_hint_from_args(Some(&args_value));
        let name_raw = fn_obj
            .and_then(|row| row.get("name"))
            .and_then(Value::as_str)
            .or_else(|| call_obj.get("name").and_then(Value::as_str))
            .or(hinted_name.as_deref())
            .unwrap_or("")
            .trim()
            .to_string();
        let normalized_name = normalize_routecodex_tool_name(Some(name_raw.as_str()))
            .unwrap_or_default();
        if normalized_name.is_empty() {
            continue;
        }
        let id = call_obj
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| call_obj.get("call_id").and_then(Value::as_str))
            .or_else(|| call_obj.get("tool_call_id").and_then(Value::as_str))
            .map(|v| v.to_string())
            .unwrap_or_else(|| gen_id(ctx, idx));
        let arg_str = repair_arguments_to_string(&args_value);
        push_tool_call_event(&mut out, idx, &id, Some(&normalized_name), None);
        for part in chunk_string_by_bytes(&arg_str, chunk_size) {
            push_tool_call_event(&mut out, idx, &id, None, Some(&part));
        }
        idx += 1;
    }
    out
}

fn extract_jsonish_tool_calls_direct(
    text: &str,
    ctx: Option<&HarvestContext>,
    chunk_size: usize,
) -> Vec<Value> {
    let candidates = collect_json_candidates(text);
    for candidate in candidates {
        let parsed = match serde_json::from_str::<Value>(candidate.as_str()) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let entries = extract_tool_call_entries_from_json_value(&parsed);
        if entries.is_empty() {
            continue;
        }
        let events = build_tool_events_from_entries(entries, ctx, chunk_size);
        if !events.is_empty() {
            return events;
        }
    }
    Vec::new()
}

fn extract_reasoning_json_tool_calls(
    text: &str,
    ctx: Option<&HarvestContext>,
    chunk_size: usize,
) -> Vec<Value> {
    let id_prefix = ctx
        .and_then(|c| c.id_prefix.as_ref())
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .unwrap_or("call");
    let options = json!({
        "idPrefix": id_prefix,
    });
    let normalized_raw = match normalize_assistant_text_to_tool_calls_json(
        text.to_string(),
        Some(options.to_string()),
    ) {
        Ok(raw) => raw,
        Err(_) => return Vec::new(),
    };
    let normalized = match serde_json::from_str::<Value>(&normalized_raw) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let tool_calls = extract_tool_call_entries_from_json_value(&normalized);
    if tool_calls.is_empty() {
        return Vec::new();
    }
    build_tool_events_from_entries(tool_calls, ctx, chunk_size)
}

fn push_tool_call_event(
    events: &mut Vec<Value>,
    index: usize,
    id: &str,
    name: Option<&str>,
    args: Option<&str>,
) {
    let mut function = Map::new();
    if let Some(name_value) = name {
        if !name_value.trim().is_empty() {
            function.insert("name".to_string(), Value::String(name_value.to_string()));
        }
    }
    if let Some(args_value) = args {
        function.insert(
            "arguments".to_string(),
            Value::String(args_value.to_string()),
        );
    }
    let entry = json!({
        "tool_calls": [
            {
                "index": index,
                "id": id,
                "type": "function",
                "function": Value::Object(function),
            }
        ]
    });
    events.push(entry);
}

fn extract_from_textual(
    content: &str,
    ctx: Option<&HarvestContext>,
    chunk_size: usize,
) -> Vec<Value> {
    let mut events: Vec<Value> = Vec::new();
    if content.trim().is_empty() {
        return events;
    }

    let structured_payloads = extract_structured_apply_patch_payloads_with(content, |raw| {
        serde_json::from_str::<Value>(raw).ok()
    });
    if !structured_payloads.is_empty() {
        let mut idx = 0usize;
        for payload in structured_payloads {
            let id = gen_id(ctx, idx);
            let arg_str = repair_arguments_to_string(&payload);
            push_tool_call_event(&mut events, idx, &id, Some("apply_patch"), None);
            for part in chunk_string_by_bytes(&arg_str, chunk_size) {
                push_tool_call_event(&mut events, idx, &id, None, Some(&part));
            }
            idx += 1;
        }
        return events;
    }

    let direct_json_events = extract_jsonish_tool_calls_direct(content, ctx, chunk_size);
    if !direct_json_events.is_empty() {
        return direct_json_events;
    }

    let reasoning_json_events = extract_reasoning_json_tool_calls(content, ctx, chunk_size);
    if !reasoning_json_events.is_empty() {
        return reasoning_json_events;
    }

    let function_re =
        Regex::new(r"<function=([A-Za-z0-9_.-]+)>([\s\S]*?)</function=([A-Za-z0-9_.-]+)>").unwrap();
    let function_param_re =
        Regex::new(r"<parameter=([A-Za-z0-9_.-]+)>([\s\S]*?)</parameter>").unwrap();
    let mut idx = 0usize;
    let mut function_events: Vec<Value> = Vec::new();
    for caps in function_re.captures_iter(content) {
        let open_name = caps
            .get(1)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        let close_name = caps
            .get(3)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        let inner = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        if open_name.is_empty()
            || close_name.is_empty()
            || !open_name.eq_ignore_ascii_case(&close_name)
        {
            continue;
        }

        let normalized_name = normalize_routecodex_tool_name(Some(&open_name)).unwrap_or_default();
        if normalized_name.is_empty() {
            continue;
        }

        let mut args_obj = Map::new();
        for param_caps in function_param_re.captures_iter(inner) {
            let key = param_caps
                .get(1)
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_default();
            if key.is_empty() {
                continue;
            }
            let raw = param_caps.get(2).map(|m| m.as_str().trim()).unwrap_or("");
            let mut value = serde_json::from_str::<Value>(raw)
                .unwrap_or_else(|_| Value::String(raw.to_string()));
            if normalized_name == "shell" && key == "command" && !value.is_array() {
                value = Value::Array(
                    split_command_string(raw)
                        .into_iter()
                        .map(Value::String)
                        .collect(),
                );
            }
            args_obj.insert(key, value);
        }

        let id = gen_id(ctx, idx);
        push_tool_call_event(&mut function_events, idx, &id, Some(&normalized_name), None);
        let arg_str = repair_arguments_to_string(&Value::Object(args_obj));
        for part in chunk_string_by_bytes(&arg_str, chunk_size) {
            push_tool_call_event(&mut function_events, idx, &id, None, Some(&part));
        }
        idx += 1;
    }
    if !function_events.is_empty() {
        return function_events;
    }

    let invoke_re = Regex::new(r#"<invoke\s+name=\"([^\">]+)\"[^>]*>([\s\S]*?)</invoke>"#).unwrap();
    let param_re =
        Regex::new(r#"<parameter\s+name=\"([^\">]+)\"[^>]*>([\s\S]*?)</parameter>"#).unwrap();
    let mut idx = 0usize;
    let mut invoke_events: Vec<Value> = Vec::new();
    for caps in invoke_re.captures_iter(content) {
        let tool_name = caps
            .get(1)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        let inner = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        if tool_name.is_empty() || inner.trim().is_empty() {
            continue;
        }
        let mut args_obj = Map::new();
        for param_caps in param_re.captures_iter(inner) {
            let key = param_caps
                .get(1)
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_default();
            if key.is_empty() {
                continue;
            }
            let raw = param_caps.get(2).map(|m| m.as_str().trim()).unwrap_or("");
            let value = serde_json::from_str::<Value>(raw)
                .unwrap_or_else(|_| Value::String(raw.to_string()));
            args_obj.insert(key, value);
        }
        let id = gen_id(ctx, idx);
        push_tool_call_event(
            &mut invoke_events,
            idx,
            &id,
            normalize_routecodex_tool_name(Some(&tool_name)).as_deref(),
            None,
        );
        let arg_str = repair_arguments_to_string(&Value::Object(args_obj));
        for part in chunk_string_by_bytes(&arg_str, chunk_size) {
            push_tool_call_event(&mut invoke_events, idx, &id, None, Some(&part));
        }
        idx += 1;
    }
    if !invoke_events.is_empty() {
        return invoke_events;
    }

    let block_re = Regex::new(r"<tool_call[^>]*>[\s\S]*?</tool_call>").unwrap();
    let name_tag_re = Regex::new(r"<tool_name>([\s\S]*?)</tool_name>").unwrap();
    let pair_re =
        Regex::new(r"<arg_key>([\s\S]*?)</arg_key>\s*<arg_value>([\s\S]*?)</arg_value>").unwrap();
    let mut matched = false;
    for block in block_re.find_iter(content) {
        let block_text = block.as_str();
        let mut name = name_tag_re
            .captures(block_text)
            .and_then(|caps| caps.get(1))
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        if name.is_empty() {
            if Regex::new(r"<arg_key>\s*command\s*</arg_key>")
                .unwrap()
                .is_match(block_text)
            {
                name = "shell".to_string();
            } else if Regex::new(r"\bapply_patch\b").unwrap().is_match(block_text) {
                name = "apply_patch".to_string();
            } else if Regex::new(r"\bupdate_plan\b").unwrap().is_match(block_text) {
                name = "update_plan".to_string();
            } else if Regex::new(r"\bview_image\b").unwrap().is_match(block_text) {
                name = "view_image".to_string();
            }
        }
        let mut args_obj = Map::new();
        for caps in pair_re.captures_iter(block_text) {
            let key = caps
                .get(1)
                .map(|m| m.as_str().trim().to_string())
                .unwrap_or_default();
            if key.is_empty() {
                continue;
            }
            let raw = caps.get(2).map(|m| m.as_str().trim()).unwrap_or("");
            let mut value = serde_json::from_str::<Value>(raw)
                .unwrap_or_else(|_| Value::String(raw.to_string()));
            if name == "shell" && key == "command" && !value.is_array() {
                value = Value::Array(
                    split_command_string(raw)
                        .into_iter()
                        .map(Value::String)
                        .collect(),
                );
            }
            args_obj.insert(key, value);
        }
        if !name.is_empty() {
            let id = gen_id(ctx, 0);
            let normalized_name = normalize_routecodex_tool_name(Some(&name)).unwrap_or_default();
            push_tool_call_event(&mut events, 0, &id, Some(&normalized_name), None);
            let arg_str = repair_arguments_to_string(&Value::Object(args_obj));
            for part in chunk_string_by_bytes(&arg_str, chunk_size) {
                push_tool_call_event(&mut events, 0, &id, None, Some(&part));
            }
            matched = true;
        }
    }
    if matched {
        return events;
    }

    let inline_re = Regex::new(r"(shell|apply_patch|update_plan|view_image)[\s\S]*?<arg_key>([\s\S]*?)</arg_key>\s*<arg_value>([\s\S]*?)</arg_value>").unwrap();
    if let Some(caps) = inline_re.captures(content) {
        let name = caps
            .get(1)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        let key = caps
            .get(2)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        let raw = caps.get(3).map(|m| m.as_str().trim()).unwrap_or("");
        let mut value =
            serde_json::from_str::<Value>(raw).unwrap_or_else(|_| Value::String(raw.to_string()));
        let mut args_obj = Map::new();
        if name == "shell" && key == "command" && !value.is_array() {
            value = Value::Array(
                split_command_string(raw)
                    .into_iter()
                    .map(Value::String)
                    .collect(),
            );
        }
        if !key.is_empty() {
            args_obj.insert(key, value);
        }
        if !name.is_empty() {
            let id = gen_id(ctx, 0);
            let normalized_name = normalize_routecodex_tool_name(Some(&name)).unwrap_or_default();
            push_tool_call_event(&mut events, 0, &id, Some(&normalized_name), None);
            let arg_str = repair_arguments_to_string(&Value::Object(args_obj));
            for part in chunk_string_by_bytes(&arg_str, chunk_size) {
                push_tool_call_event(&mut events, 0, &id, None, Some(&part));
            }
            return events;
        }
    }

    events
}

pub fn harvest_tools_json(input_json: String) -> NapiResult<String> {
    let input: HarvestInput = serde_json::from_str(&input_json).map_err(|e| {
        napi::Error::from_reason(format!("Failed to parse harvest input JSON: {}", e))
    })?;
    let ctx = input.context.as_ref();
    let chunk_size = ctx
        .and_then(|c| c.chunk_size)
        .unwrap_or(256)
        .clamp(32, 1024) as usize;

    let mut result = HarvestResult {
        delta_events: Vec::new(),
        normalized: None,
        stats: None,
    };

    let signal_type = input.signal.signal_type.as_str();
    if signal_type == "delta" {
        let mut events: Vec<Value> = Vec::new();
        let payload = input.signal.payload;

        if let Some(content) = payload
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|arr| arr.get(0))
            .and_then(|choice| choice.get("delta"))
            .and_then(|delta| delta.get("content"))
            .and_then(Value::as_str)
        {
            if !content.trim().is_empty() {
                events.extend(extract_from_textual(content, ctx, chunk_size));
            }
        }

        if let Some(fc) = payload
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|arr| arr.get(0))
            .and_then(|choice| choice.get("delta"))
            .and_then(|delta| delta.get("function_call"))
            .and_then(Value::as_object)
        {
            let name = fc
                .get("name")
                .and_then(Value::as_str)
                .map(|v| v.to_string());
            let args_val = fc.get("arguments").cloned().unwrap_or(Value::Null);
            let arg_str = repair_arguments_to_string(&args_val);
            let id = gen_id(ctx, 0);
            if let Some(name_value) = name.as_ref() {
                let normalized_name =
                    normalize_routecodex_tool_name(Some(name_value)).unwrap_or_default();
                if !normalized_name.is_empty() {
                    push_tool_call_event(&mut events, 0, &id, Some(&normalized_name), None);
                    for part in chunk_string_by_bytes(&arg_str, chunk_size) {
                        push_tool_call_event(&mut events, 0, &id, None, Some(&part));
                    }
                }
            }
        }

        if let Some(tool_calls) = payload
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|arr| arr.get(0))
            .and_then(|choice| choice.get("delta"))
            .and_then(|delta| delta.get("tool_calls"))
            .and_then(Value::as_array)
        {
            let key = ctx
                .and_then(|c| c.request_id.as_ref())
                .map(|v| v.as_str())
                .unwrap_or("default");
            let mut state_guard = dedupe_state().lock().unwrap();
            let mut idx = 0usize;
            for tc in tool_calls {
                let id = tc
                    .get("id")
                    .and_then(Value::as_str)
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| gen_id(ctx, idx));
                let name = tc
                    .get("function")
                    .and_then(Value::as_object)
                    .and_then(|row| row.get("name"))
                    .and_then(Value::as_str)
                    .map(|v| v.to_string());
                let args_val = tc
                    .get("function")
                    .and_then(Value::as_object)
                    .and_then(|row| row.get("arguments"))
                    .cloned();
                let args_str = args_val.map(|v| repair_arguments_to_string(&v));
                let args_hash = args_str.as_ref().map(|v| hash_string(v));
                let entry = state_guard.get(key).cloned().unwrap_or_default();
                let is_dup =
                    entry.name == name && entry.args_hash.is_some() && entry.args_hash == args_hash;
                if !is_dup {
                    if let Some(ref nm) = name {
                        push_tool_call_event(
                            &mut events,
                            idx,
                            &id,
                            normalize_routecodex_tool_name(Some(nm)).as_deref(),
                            None,
                        );
                    }
                    if let Some(ref args_chunk) = args_str {
                        for part in chunk_string_by_bytes(args_chunk, chunk_size) {
                            push_tool_call_event(&mut events, idx, &id, None, Some(&part));
                        }
                    }
                    state_guard.insert(key.to_string(), DedupeEntry { name, args_hash });
                }
                idx += 1;
            }
        }

        result.delta_events = events;
        return serde_json::to_string(&result).map_err(|e| {
            napi::Error::from_reason(format!("Failed to serialize harvest output: {}", e))
        });
    }

    let mut src = input.signal.payload;
    let choice_opt = src
        .get_mut("choices")
        .and_then(Value::as_array_mut)
        .and_then(|arr| arr.get_mut(0));
    if let Some(choice) = choice_opt {
        let tool_calls_len = choice
            .get("message")
            .and_then(Value::as_object)
            .and_then(|msg| msg.get("tool_calls"))
            .and_then(Value::as_array)
            .map(|arr| arr.len())
            .unwrap_or(0);
        if tool_calls_len > 0 {
            if let Some(message) = choice.get_mut("message").and_then(Value::as_object_mut) {
                if let Some(tool_calls) =
                    message.get_mut("tool_calls").and_then(Value::as_array_mut)
                {
                    for call in tool_calls.iter_mut() {
                        if let Some(function) =
                            call.get_mut("function").and_then(Value::as_object_mut)
                        {
                            if let Some(args) = function.get_mut("arguments") {
                                if !args.is_string() {
                                    let normalized = repair_arguments_to_string(args);
                                    *args = Value::String(normalized);
                                }
                            }
                        }
                    }
                }
            }
            let finish_reason = choice
                .get("finish_reason")
                .and_then(Value::as_str)
                .unwrap_or("");
            if finish_reason != "tool_calls" {
                if let Some(choice_obj) = choice.as_object_mut() {
                    choice_obj.insert(
                        "finish_reason".to_string(),
                        Value::String("tool_calls".to_string()),
                    );
                }
            }
            result.normalized = Some(src);
            return serde_json::to_string(&result).map_err(|e| {
                napi::Error::from_reason(format!("Failed to serialize harvest output: {}", e))
            });
        }

        let content = choice
            .get("message")
            .and_then(Value::as_object)
            .and_then(|msg| msg.get("content"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if !content.trim().is_empty() {
            let events = extract_from_textual(content, ctx, chunk_size);
            if !events.is_empty() {
                let mut map: HashMap<String, (Option<String>, Vec<String>)> = HashMap::new();
                for event in events.iter() {
                    let tool_calls = event
                        .get("tool_calls")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    for entry in tool_calls {
                        let id = entry
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        if id.is_empty() {
                            continue;
                        }
                        let name = entry
                            .get("function")
                            .and_then(|v| v.get("name"))
                            .and_then(Value::as_str)
                            .map(|v| v.to_string());
                        let args = entry
                            .get("function")
                            .and_then(|v| v.get("arguments"))
                            .and_then(Value::as_str)
                            .map(|v| v.to_string());
                        let entry_ref = map.entry(id).or_insert((None, Vec::new()));
                        if entry_ref.0.is_none() {
                            entry_ref.0 = name;
                        }
                        if let Some(args_value) = args {
                            entry_ref.1.push(args_value);
                        }
                    }
                }
                let mut merged: Vec<Value> = Vec::new();
                for (id, (name, args_chunks)) in map.into_iter() {
                    let arguments = args_chunks.join("");
                    merged.push(json!({
                        "id": id,
                        "type": "function",
                        "function": {
                            "name": name,
                            "arguments": arguments,
                        }
                    }));
                }
                if let Some(choice_obj) = choice.as_object_mut() {
                    if let Some(message) =
                        choice_obj.get_mut("message").and_then(Value::as_object_mut)
                    {
                        message.insert("tool_calls".to_string(), Value::Array(merged));
                        message.insert("content".to_string(), Value::String(String::new()));
                    }
                    let finish_reason = choice_obj
                        .get("finish_reason")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if finish_reason != "tool_calls" {
                        choice_obj.insert(
                            "finish_reason".to_string(),
                            Value::String("tool_calls".to_string()),
                        );
                    }
                }
                result.normalized = Some(src);
                return serde_json::to_string(&result).map_err(|e| {
                    napi::Error::from_reason(format!("Failed to serialize harvest output: {}", e))
                });
            }
        }
    }

    result.normalized = Some(src);
    serde_json::to_string(&result)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize harvest output: {}", e)))
}

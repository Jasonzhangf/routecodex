use napi::bindgen_prelude::Result as NapiResult;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::hub_reasoning_tool_normalizer::repair_arguments_to_string;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamingToolExtractInput {
    buffer: Option<String>,
    id_counter: Option<u64>,
    text: Option<String>,
    id_prefix: Option<String>,
    now_ms: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamingToolExtractOutput {
    buffer: String,
    id_counter: u64,
    tool_calls: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamingToolStateCreateInput {
    id_prefix: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamingToolExtractorState {
    buffer: String,
    id_counter: u64,
    id_prefix: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StreamingToolFeedInput {
    state: Option<StreamingToolExtractorState>,
    text: Option<String>,
    now_ms: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamingToolFeedOutput {
    state: StreamingToolExtractorState,
    tool_calls: Vec<Value>,
}

fn base36(mut value: u64) -> String {
    if value == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        let ch = if digit < 10 {
            (b'0' + digit) as char
        } else {
            (b'a' + (digit - 10)) as char
        };
        out.push(ch);
        value /= 36;
    }
    out.iter().rev().collect()
}

fn gen_id(prefix: &str, id_counter: &mut u64, now_ms: i64) -> String {
    *id_counter += 1;
    format!("{}_{}_{}", prefix, now_ms, base36(*id_counter))
}

fn is_structured_apply_patch_payload(value: &Value) -> bool {
    match value {
        Value::Object(obj) => obj.get("changes").map(|v| v.is_array()).unwrap_or(false),
        _ => false,
    }
}

fn to_tool_call(id: String, name: &str, args: &Value) -> Value {
    let args_str = repair_arguments_to_string(args);
    json!({
        "id": id,
        "type": "function",
        "function": {
            "name": name,
            "arguments": args_str
        }
    })
}

fn split_command_string(input: &str) -> Vec<String> {
    let s = input.trim();
    if s.is_empty() {
        return Vec::new();
    }
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if in_single {
            if ch == '\'' {
                in_single = false;
            } else {
                cur.push(ch);
            }
            i += 1;
            continue;
        }
        if in_double {
            if ch == '"' {
                in_double = false;
            } else if ch == '\\' && i + 1 < chars.len() {
                i += 1;
                cur.push(chars[i]);
            } else {
                cur.push(ch);
            }
            i += 1;
            continue;
        }
        if ch == '\'' {
            in_single = true;
            i += 1;
            continue;
        }
        if ch == '"' {
            in_double = true;
            i += 1;
            continue;
        }
        if ch.is_whitespace() {
            if !cur.is_empty() {
                out.push(cur.clone());
                cur.clear();
            }
            i += 1;
            continue;
        }
        cur.push(ch);
        i += 1;
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn extract_structured_blocks(
    buffer: &mut String,
    id_counter: &mut u64,
    id_prefix: &str,
    now_ms: i64,
) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut search_idx = 0;
    loop {
        if search_idx >= buffer.len() {
            break;
        }
        let start_idx = match buffer[search_idx..].find("```") {
            Some(offset) => search_idx + offset,
            None => break,
        };
        let header_end = match buffer[start_idx + 3..].find('\n') {
            Some(offset) => start_idx + 3 + offset,
            None => break,
        };
        let language = buffer[start_idx + 3..header_end]
            .trim()
            .to_ascii_lowercase();
        let end_idx = match buffer[header_end + 1..].find("```") {
            Some(offset) => header_end + 1 + offset,
            None => break,
        };
        let body = buffer[header_end + 1..end_idx].to_string();
        if language.is_empty()
            || language == "json"
            || language == "apply_patch"
            || language == "toon"
        {
            if let Ok(parsed) = serde_json::from_str::<Value>(body.as_str()) {
                if is_structured_apply_patch_payload(&parsed) {
                    let id = gen_id(id_prefix, id_counter, now_ms);
                    out.push(to_tool_call(id, "apply_patch", &parsed));
                    buffer.replace_range(start_idx..end_idx + 3, "");
                    search_idx = 0;
                    continue;
                }
            }
        }
        search_idx = end_idx + 3;
    }
    out
}

fn extract_execute_blocks(
    buffer: &mut String,
    id_counter: &mut u64,
    id_prefix: &str,
    now_ms: i64,
) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let exec_re = Regex::new(r"(?is)<function=execute>[\s\S]*?<parameter=command>([\s\S]*?)</parameter>[\s\S]*?</function=execute>")
        .expect("valid exec regex");
    for caps in exec_re.captures_iter(buffer.as_str()) {
        let cmd = caps
            .get(1)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        if cmd.is_empty() {
            continue;
        }
        let argv = split_command_string(cmd.as_str());
        let args = Value::Object(Map::from_iter([(
            "command".to_string(),
            Value::Array(argv.into_iter().map(Value::String).collect()),
        )]));
        let id = gen_id(id_prefix, id_counter, now_ms);
        out.push(to_tool_call(id, "shell", &args));
    }
    if !out.is_empty() {
        *buffer = exec_re.replace_all(buffer.as_str(), "").to_string();
    }
    out
}

#[napi_derive::napi]
pub fn extract_streaming_tool_calls_json(input_json: String) -> NapiResult<String> {
    let input: StreamingToolExtractInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let mut buffer = input.buffer.unwrap_or_default();
    let text = input.text.unwrap_or_default();
    buffer.push_str(text.as_str());

    let mut id_counter = input.id_counter.unwrap_or(0);
    let id_prefix = input.id_prefix.unwrap_or_else(|| "call".to_string());
    let now_ms = input
        .now_ms
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());

    let mut tool_calls = Vec::new();
    tool_calls.extend(extract_structured_blocks(
        &mut buffer,
        &mut id_counter,
        id_prefix.as_str(),
        now_ms,
    ));
    tool_calls.extend(extract_execute_blocks(
        &mut buffer,
        &mut id_counter,
        id_prefix.as_str(),
        now_ms,
    ));

    let output = StreamingToolExtractOutput {
        buffer,
        id_counter,
        tool_calls,
    };
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn create_streaming_tool_extractor_state_json(
    input_json: Option<String>,
) -> NapiResult<String> {
    let input = match input_json {
        Some(raw) if !raw.trim().is_empty() => {
            serde_json::from_str::<StreamingToolStateCreateInput>(&raw)
                .map_err(|e| napi::Error::from_reason(e.to_string()))?
        }
        _ => StreamingToolStateCreateInput { id_prefix: None },
    };
    let state = StreamingToolExtractorState {
        buffer: String::new(),
        id_counter: 0,
        id_prefix: input.id_prefix.unwrap_or_else(|| "call".to_string()),
    };
    serde_json::to_string(&state).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn reset_streaming_tool_extractor_state_json(state_json: String) -> NapiResult<String> {
    let state: StreamingToolExtractorState =
        serde_json::from_str(&state_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let reset = StreamingToolExtractorState {
        buffer: String::new(),
        id_counter: 0,
        id_prefix: state.id_prefix,
    };
    serde_json::to_string(&reset).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn feed_streaming_tool_extractor_json(input_json: String) -> NapiResult<String> {
    let input: StreamingToolFeedInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let mut state = input.state.unwrap_or(StreamingToolExtractorState {
        buffer: String::new(),
        id_counter: 0,
        id_prefix: "call".to_string(),
    });
    let text = input.text.unwrap_or_default();
    state.buffer.push_str(text.as_str());
    let now_ms = input
        .now_ms
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());

    let mut tool_calls = Vec::new();
    tool_calls.extend(extract_structured_blocks(
        &mut state.buffer,
        &mut state.id_counter,
        state.id_prefix.as_str(),
        now_ms,
    ));
    tool_calls.extend(extract_execute_blocks(
        &mut state.buffer,
        &mut state.id_counter,
        state.id_prefix.as_str(),
        now_ms,
    ));

    let output = StreamingToolFeedOutput { state, tool_calls };
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests;

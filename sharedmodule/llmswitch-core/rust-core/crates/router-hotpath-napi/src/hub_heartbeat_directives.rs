//! Hub heartbeat directive parsing + metadata extraction NAPI bridge.
//! Rust SSOT for heartbeat directive parsing from request messages.
//! Filesystem / runtime side-effects remain in TS.

use crate::shared_tooling::{
    collapse_extra_newlines_and_trim, find_last_user_message_index as find_last_user_index_shared,
};
use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const HB_MARKER_START: &str = "<**hb:";
const HB_MARKER_END: &str = "**>";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatDirectiveInput {
    pub messages: Value,
    pub metadata: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatDirectiveOutput {
    pub action: String, // "on" | "off" | "none"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tmux_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workdir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_changed: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatDirectiveRuntimeSummary {
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tmux_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workdir: Option<String>,
    pub content_changed: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HeartbeatDirectiveApplyOutput {
    pub messages: Value,
    pub runtime_summary: Option<HeartbeatDirectiveRuntimeSummary>,
}

fn read_string_field(obj: &serde_json::map::Map<String, Value>, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(v) = obj.get(*key) {
            if let Some(s) = v.as_str() {
                let trimmed = s.trim();
                if !trimmed.is_empty() {
                    if trimmed.starts_with("tmux:") {
                        return Some(trimmed[5..].trim().to_string());
                    }
                    return Some(trimmed.to_string());
                }
            }
        }
    }
    None
}

fn read_workdir_field(obj: &serde_json::map::Map<String, Value>) -> Option<String> {
    for key in &["workdir", "cwd", "workingDirectory", "clientWorkdir"] {
        if let Some(v) = obj.get(*key) {
            if let Some(s) = v.as_str() {
                let trimmed = s.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
    }
    None
}

fn parse_hb_directive_body(raw: &str) -> (String, Option<u64>) {
    let body = raw.trim().to_ascii_lowercase();
    if body.is_empty() {
        return ("none".to_string(), None);
    }
    if body == "on" {
        return ("on".to_string(), None);
    }
    if body == "off" {
        return ("off".to_string(), None);
    }
    // e.g. "30s", "5m", "1h", "1d"
    let re = Regex::new(r"^(\d+)\s*([smhd])$").unwrap();
    if let Some(caps) = re.captures(&body) {
        let amount: u64 = caps.get(1).unwrap().as_str().parse().unwrap_or(0);
        let unit = caps.get(2).unwrap().as_str();
        if amount == 0 {
            return ("none".to_string(), None);
        }
        let multiplier = match unit {
            "s" => 1_000u64,
            "m" => 60_000u64,
            "h" => 60 * 60_000u64,
            "d" => 24 * 60 * 60_000u64,
            _ => return ("none".to_string(), None),
        };
        return ("on".to_string(), Some(amount * multiplier));
    }
    ("none".to_string(), None)
}

fn strip_valid_hb_directives_from_text(text: &str) -> (String, Vec<(String, Option<u64>)>) {
    if !text.contains("<**") {
        return (text.to_string(), Vec::new());
    }

    let source = text.as_bytes();
    let mut output = String::with_capacity(text.len());
    let mut directives: Vec<(String, Option<u64>)> = Vec::new();
    let mut cursor = 0usize;

    while cursor < source.len() {
        let marker_start = match text[cursor..].find("<**") {
            Some(offset) => cursor + offset,
            None => {
                output.push_str(&text[cursor..]);
                break;
            }
        };

        output.push_str(&text[cursor..marker_start]);

        let search_from = marker_start + 3;
        let close_index = text[search_from..]
            .find("**>")
            .map(|offset| search_from + offset);
        let newline_index = text[search_from..]
            .find('\n')
            .map(|offset| search_from + offset);
        let has_closed_marker = match (close_index, newline_index) {
            (Some(close), Some(newline)) => close < newline,
            (Some(_), None) => true,
            _ => false,
        };
        let marker_end = if has_closed_marker {
            close_index.unwrap() + 3
        } else {
            newline_index.unwrap_or(text.len())
        };
        let raw_marker = &text[marker_start..marker_end];
        let body = if has_closed_marker {
            &text[(marker_start + 3)..close_index.unwrap()]
        } else {
            &text[(marker_start + 3)..marker_end]
        };
        let normalized = body.trim();

        let mut consumed = false;
        if normalized.len() >= 3 && normalized[..3].eq_ignore_ascii_case("hb:") {
            let (action, interval_ms) = parse_hb_directive_body(&normalized[3..]);
            if action == "on" || action == "off" {
                directives.push((action, interval_ms));
                consumed = true;
            }
        }

        if !consumed {
            output.push_str(raw_marker);
        }
        cursor = marker_end;
    }

    (
        collapse_extra_newlines_and_trim(output.as_str()),
        directives,
    )
}

fn process_content_for_valid_heartbeat_markers(
    content: &Value,
) -> (Value, Vec<(String, Option<u64>)>, bool) {
    match content {
        Value::String(text) => {
            let (next, directives) = strip_valid_hb_directives_from_text(text.as_str());
            let changed = !directives.is_empty() && next != *text;
            (Value::String(next), directives, changed)
        }
        Value::Array(parts) => {
            let mut directives: Vec<(String, Option<u64>)> = Vec::new();
            let mut changed = false;
            let mut next_parts: Vec<Value> = Vec::with_capacity(parts.len());

            for part in parts {
                match part {
                    Value::String(text) => {
                        let (next_text, mut part_directives) =
                            strip_valid_hb_directives_from_text(text.as_str());
                        if !part_directives.is_empty() && next_text != *text {
                            changed = true;
                        }
                        directives.append(&mut part_directives);
                        next_parts.push(Value::String(next_text));
                    }
                    Value::Object(obj) => {
                        let mut cloned = obj.clone();
                        let mut part_changed = false;
                        for key in ["text", "content"] {
                            let Some(Value::String(raw)) = cloned.get(key) else {
                                continue;
                            };
                            let (next_text, mut part_directives) =
                                strip_valid_hb_directives_from_text(raw.as_str());
                            if !part_directives.is_empty() && next_text != *raw {
                                part_changed = true;
                            }
                            directives.append(&mut part_directives);
                            cloned.insert(key.to_string(), Value::String(next_text));
                        }
                        if part_changed {
                            changed = true;
                        }
                        next_parts.push(Value::Object(cloned));
                    }
                    _ => next_parts.push(part.clone()),
                }
            }

            (Value::Array(next_parts), directives, changed)
        }
        _ => (content.clone(), Vec::new(), false),
    }
}

pub fn apply_heartbeat_directive_semantics(
    messages: Value,
    metadata: &Value,
) -> HeartbeatDirectiveApplyOutput {
    let rows = match messages {
        Value::Array(values) => values,
        other => {
            return HeartbeatDirectiveApplyOutput {
                messages: other,
                runtime_summary: None,
            }
        }
    };

    let Some(last_user_idx) = find_last_user_index_shared(rows.as_slice()) else {
        return HeartbeatDirectiveApplyOutput {
            messages: Value::Array(rows),
            runtime_summary: None,
        };
    };

    let Some(Value::Object(message_obj)) = rows.get(last_user_idx).cloned() else {
        return HeartbeatDirectiveApplyOutput {
            messages: Value::Array(rows),
            runtime_summary: None,
        };
    };

    let content = message_obj.get("content").cloned().unwrap_or(Value::Null);
    let (next_content, directives, changed) = process_content_for_valid_heartbeat_markers(&content);
    if directives.is_empty() || !changed {
        return HeartbeatDirectiveApplyOutput {
            messages: Value::Array(rows),
            runtime_summary: None,
        };
    }

    let mut next_rows = rows.clone();
    let mut next_message = message_obj.clone();
    next_message.insert("content".to_string(), next_content);
    next_rows[last_user_idx] = Value::Object(next_message);

    let (action, interval_ms) = directives
        .last()
        .cloned()
        .unwrap_or_else(|| ("none".to_string(), None));
    let tmux_session_id = metadata.as_object().and_then(|obj| {
        read_string_field(
            obj,
            &[
                "tmuxSessionId",
                "clientTmuxSessionId",
                "tmux_session_id",
                "client_tmux_session_id",
                "stopMessageClientInjectSessionScope",
                "stop_message_client_inject_session_scope",
            ],
        )
    });
    let workdir = metadata.as_object().and_then(read_workdir_field);

    HeartbeatDirectiveApplyOutput {
        messages: Value::Array(next_rows),
        runtime_summary: Some(HeartbeatDirectiveRuntimeSummary {
            action,
            interval_ms,
            tmux_session_id,
            workdir,
            content_changed: true,
        }),
    }
}

fn extract_hb_from_text(text: &str) -> Vec<(String, String)> {
    let mut results = Vec::new();
    let bytes = text.as_bytes();
    let marker_start = HB_MARKER_START.as_bytes();
    let marker_end = HB_MARKER_END.as_bytes();
    if bytes.len() < marker_start.len() || bytes.len() < marker_end.len() {
        return results;
    }
    let mut i = 0;
    while i + marker_start.len() <= bytes.len() {
        if &bytes[i..i + marker_start.len()] == marker_start {
            let body_start = i + marker_start.len();
            let mut j = body_start;
            while j + marker_end.len() <= bytes.len() {
                if &bytes[j..j + marker_end.len()] == marker_end {
                    let body = std::str::from_utf8(&bytes[body_start..j])
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if !body.is_empty() {
                        let raw_marker = format!("{}{}{}", HB_MARKER_START, body, HB_MARKER_END);
                        results.push((body, raw_marker));
                    }
                    i = j + marker_end.len();
                    break;
                }
                j += 1;
            }
            if j + marker_end.len() > bytes.len() {
                break;
            }
        } else {
            i += 1;
        }
    }
    results
}

// stripped text editing is currently executed in TS side (filesystem side-effects).

fn resolve_heartbeat_directive(input: HeartbeatDirectiveInput) -> HeartbeatDirectiveOutput {
    let messages = &input.messages;
    let metadata = &input.metadata;

    let messages_arr = match messages.as_array() {
        Some(a) => a,
        None => {
            return HeartbeatDirectiveOutput {
                action: "none".to_string(),
                interval_ms: None,
                tmux_session_id: None,
                workdir: None,
                content_changed: None,
            }
        }
    };

    let Some(last_user_idx) = find_last_user_index_shared(messages_arr) else {
        return HeartbeatDirectiveOutput {
            action: "none".to_string(),
            interval_ms: None,
            tmux_session_id: None,
            workdir: None,
            content_changed: None,
        };
    };

    let last_user_msg = match messages_arr.get(last_user_idx) {
        Some(v) => v,
        None => {
            return HeartbeatDirectiveOutput {
                action: "none".to_string(),
                interval_ms: None,
                tmux_session_id: None,
                workdir: None,
                content_changed: None,
            }
        }
    };

    let role = last_user_msg
        .get("role")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    if role != "user" {
        return HeartbeatDirectiveOutput {
            action: "none".to_string(),
            interval_ms: None,
            tmux_session_id: None,
            workdir: None,
            content_changed: None,
        };
    }

    // Extract text from content field
    fn extract_text(val: &Value) -> String {
        match val {
            Value::String(s) => s.clone(),
            Value::Array(arr) => arr
                .iter()
                .filter_map(|v| {
                    if let Value::Object(o) = v {
                        if let Some(Value::String(t)) = o.get("text") {
                            return Some(t.clone());
                        }
                    }
                    None
                })
                .collect::<Vec<_>>()
                .join("\n"),
            _ => String::new(),
        }
    }

    let content_val = last_user_msg.get("content");
    let text = content_val.map(extract_text).unwrap_or_default();

    let markers = extract_hb_from_text(&text);
    let last_marker_body = markers.last().map(|(body, _)| body.clone());
    let content_changed = if markers.is_empty() { None } else { Some(true) };

    let (action, interval_ms) = last_marker_body
        .as_ref()
        .map(|b| parse_hb_directive_body(b))
        .unwrap_or_else(|| ("none".to_string(), None));

    let tmux_session_id = metadata.as_object().and_then(|obj| {
        read_string_field(
            obj,
            &[
                "tmuxSessionId",
                "clientTmuxSessionId",
                "tmux_session_id",
                "client_tmux_session_id",
                "stopMessageClientInjectSessionScope",
                "stop_message_client_inject_session_scope",
            ],
        )
    });

    let workdir = metadata.as_object().and_then(|obj| read_workdir_field(obj));

    HeartbeatDirectiveOutput {
        action,
        interval_ms,
        tmux_session_id,
        workdir,
        content_changed,
    }
}

#[napi]
pub fn resolve_heartbeat_directive_json(input_json: String) -> NapiResult<String> {
    let input: HeartbeatDirectiveInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_heartbeat_directive(input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{
        apply_heartbeat_directive_semantics, resolve_heartbeat_directive, HeartbeatDirectiveInput,
    };
    use serde_json::json;

    #[test]
    fn resolves_latest_hb_directive_with_camelcase_metadata() {
        let output = resolve_heartbeat_directive(HeartbeatDirectiveInput {
            messages: json!([
                { "role": "user", "content": "<**hb:off**>" },
                { "role": "assistant", "content": "ok" },
                { "role": "user", "content": "please continue\n<**hb:15m**>" }
            ]),
            metadata: json!({
                "tmuxSessionId": "hb-native-contract",
                "cwd": "/tmp/hb-native-contract"
            }),
        });

        assert_eq!(output.action, "on");
        assert_eq!(output.interval_ms, Some(15 * 60_000));
        assert_eq!(
            output.tmux_session_id.as_deref(),
            Some("hb-native-contract")
        );
        assert_eq!(output.workdir.as_deref(), Some("/tmp/hb-native-contract"));
        assert_eq!(output.content_changed, Some(true));
    }

    #[test]
    fn applies_heartbeat_directive_semantics_to_latest_user_message_only() {
        let output = apply_heartbeat_directive_semantics(
            json!([
                { "role": "user", "content": "<**hb:off**>\nold" },
                { "role": "assistant", "content": "ok" },
                { "role": "user", "content": "please continue\n<**hb:15m**>\nthanks" }
            ]),
            &json!({
                "tmuxSessionId": "hb-native-contract",
                "cwd": "/tmp/hb-native-contract"
            }),
        );

        let messages = output.messages.as_array().unwrap();
        assert_eq!(messages[0]["content"].as_str(), Some("<**hb:off**>\nold"));
        assert_eq!(
            messages[2]["content"].as_str(),
            Some("please continue\n\nthanks")
        );
        assert_eq!(
            output.runtime_summary,
            Some(super::HeartbeatDirectiveRuntimeSummary {
                action: "on".to_string(),
                interval_ms: Some(15 * 60_000),
                tmux_session_id: Some("hb-native-contract".to_string()),
                workdir: Some("/tmp/hb-native-contract".to_string()),
                content_changed: true,
            })
        );
    }
}

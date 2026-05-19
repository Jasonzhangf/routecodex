//! Hub heartbeat directive parsing + metadata extraction NAPI bridge.
//! Rust SSOT for heartbeat directive parsing from request messages.
//! Filesystem / runtime side-effects remain in TS.

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
    pub action: String,       // "on" | "off" | "none"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tmux_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workdir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_changed: Option<bool>,
}

fn find_last_user_message_index(messages: &Value) -> Option<usize> {
    let arr = messages.as_array()?;
    for (i, msg) in arr.iter().enumerate().rev() {
        let role = msg.get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if role == "user" {
            return Some(i);
        }
    }
    None
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

fn extract_hb_from_text(text: &str) -> Vec<(String, String)> {
    let mut results = Vec::new();
    let bytes = text.as_bytes();
    let marker_start = HB_MARKER_START.as_bytes();
    let marker_end = HB_MARKER_END.as_bytes();
    let mut i = 0;
    while i <= bytes.len().saturating_sub(marker_start.len()) {
        if &bytes[i..i + marker_start.len()] == marker_start {
            let body_start = i + marker_start.len();
            let mut j = body_start;
            while j <= bytes.len().saturating_sub(marker_end.len()) {
                if &bytes[j..j + marker_end.len()] == marker_end {
                    let body = std::str::from_utf8(&bytes[body_start..j])
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if !body.is_empty() {
                        results.push((body, format!("{}[{}]", HB_MARKER_START, body)));
                    }
                    i = j + marker_end.len();
                    break;
                }
                j += 1;
            }
            if j > bytes.len().saturating_sub(marker_end.len()) {
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

    let last_user_idx = find_last_user_message_index(messages);
    let Some(last_user_idx) = last_user_idx else {
        return HeartbeatDirectiveOutput {
            action: "none".to_string(),
            interval_ms: None,
            tmux_session_id: None,
            workdir: None,
            content_changed: None,
        };
    };

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

    let role = last_user_msg.get("role")
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
            Value::Array(arr) => arr.iter()
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

    let tmux_session_id = metadata.as_object()
        .and_then(|obj| read_string_field(obj, &[
            "tmuxSessionId", "clientTmuxSessionId",
            "tmux_session_id", "client_tmux_session_id",
            "stopMessageClientInjectSessionScope", "stop_message_client_inject_session_scope",
        ]));

    let workdir = metadata.as_object()
        .and_then(|obj| read_workdir_field(obj));

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
    let input: HeartbeatDirectiveInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_heartbeat_directive(input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

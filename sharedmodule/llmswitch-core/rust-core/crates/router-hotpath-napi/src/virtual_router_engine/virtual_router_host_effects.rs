//! Virtual Router host effects — orchestration logic, console output, hit log emission.
//! Ported from `sharedmodule/llmswitch-core/src/runtime/virtual-router-host-effects.ts`
//!
//! All functions are `#[napi]` exported so TS can call via `callNativeJson`.

use napi_derive::napi;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StopMessageMarkerParseLog {
    pub request_id: String,
    pub marker_detected: bool,
    pub preview: String,
    pub stop_message_types: Vec<String>,
    pub scoped_types: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_scope: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StopMessageInstructionInput {
    pub instruction: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rcc_user_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StopMessageMarkerParseInput {
    pub request_json: String,
    pub metadata_json: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rcc_user_dir: Option<String>,
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STOP_MESSAGE_INSTRUCTION_TYPES: &[&str] =
    &["stopMessageSet", "stopMessageMode", "stopMessageClear"];
const STOP_MESSAGE_SCOPED_TYPES: &[&str] = &[
    "stopMessageSet",
    "stopMessageMode",
    "stopMessageClear",
    "preCommandSet",
    "preCommandClear",
];

// ---------------------------------------------------------------------------
// Stop message marker parse
// ---------------------------------------------------------------------------

fn has_marker_syntax(text: &str) -> bool {
    text.contains('\u{200B}') // zero-width space marker
}

fn extract_stop_message_text(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::String(s) if !s.trim().is_empty() => s.trim().to_string(),
        serde_json::Value::Array(arr) => {
            let parts: Vec<String> = arr
                .iter()
                .filter_map(|entry| match entry {
                    serde_json::Value::String(s) if !s.trim().is_empty() => {
                        Some(s.trim().to_string())
                    }
                    serde_json::Value::Object(m) => {
                        let record = m;
                        for key in &["text", "content"] {
                            if let Some(val) = record.get(*key) {
                                if let Some(s) = val.as_str() {
                                    if !s.trim().is_empty() {
                                        return Some(s.trim().to_string());
                                    }
                                }
                            }
                        }
                        None
                    }
                    _ => None,
                })
                .collect();
            parts.join("\n")
        }
        _ => String::new(),
    }
}

#[napi]
pub fn build_stop_message_marker_parse_log_json(
    request_json: String,
    metadata_json: String,
    parsed_kinds_json: String,
    stop_scope: Option<String>,
) -> napi::Result<String> {
    let request: serde_json::Value = serde_json::from_str(&request_json)
        .map_err(|e| napi::Error::from_reason(format!("invalid request: {}", e)))?;
    let metadata: serde_json::Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("invalid metadata: {}", e)))?;
    let parsed_kinds: Vec<String> = serde_json::from_str(&parsed_kinds_json)
        .map_err(|e| napi::Error::from_reason(format!("invalid parsed kinds: {}", e)))?;

    // Extract latest user message
    let messages = request
        .get("messages")
        .and_then(|v| v.as_array())
        .map(|arr| arr.as_slice())
        .unwrap_or(&[]);

    let latest = messages
        .iter()
        .rev()
        .find(|m| m.get("role").and_then(|r| r.as_str()) == Some("user"));

    let latest_text = latest
        .and_then(|m| m.get("content"))
        .map(|c| extract_stop_message_text(c))
        .unwrap_or_default();

    let latest_text_trimmed = latest_text.trim();
    let latest_has_marker = has_marker_syntax(latest_text_trimmed);
    let has_stop_keyword = latest_text_trimmed.to_lowercase().contains("stopmessage");

    if !has_stop_keyword && !latest_has_marker {
        return serde_json::to_string(&serde_json::Value::Null)
            .map_err(|e| napi::Error::from_reason(format!("serialize: {}", e)));
    }

    let stop_message_types: Vec<String> = parsed_kinds
        .iter()
        .filter(|t| STOP_MESSAGE_INSTRUCTION_TYPES.contains(&t.as_str()))
        .cloned()
        .collect();

    let scoped_types: Vec<String> = parsed_kinds
        .iter()
        .filter(|t| STOP_MESSAGE_SCOPED_TYPES.contains(&t.as_str()))
        .cloned()
        .collect();

    if !has_stop_keyword && stop_message_types.is_empty() && scoped_types.is_empty() {
        return serde_json::to_string(&serde_json::Value::Null)
            .map_err(|e| napi::Error::from_reason(format!("serialize: {}", e)));
    }

    let request_id = metadata
        .get("requestId")
        .and_then(|v| v.as_str())
        .unwrap_or("n/a")
        .to_string();

    let preview = latest_text_trimmed
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ");
    let preview = if preview.len() > 120 {
        format!("{}...", &preview[..117])
    } else {
        preview
    };

    let log = StopMessageMarkerParseLog {
        request_id,
        marker_detected: latest_has_marker,
        preview,
        stop_message_types,
        scoped_types,
        stop_scope,
    };

    serde_json::to_string(&log).map_err(|e| napi::Error::from_reason(format!("serialize: {}", e)))
}

// ---------------------------------------------------------------------------
// Stop message status label
// ---------------------------------------------------------------------------

#[napi]
pub fn format_stop_message_status_label_json(
    snapshot_json: Option<String>,
    scope: Option<String>,
    force_show: bool,
) -> napi::Result<String> {
    let scope_label = scope
        .as_deref()
        .and_then(|s| {
            let t = s.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        })
        .unwrap_or_else(|| "none".to_string());

    let snapshot = if let Some(json) = snapshot_json {
        let v: serde_json::Value = serde_json::from_str(&json)
            .map_err(|e| napi::Error::from_reason(format!("invalid snapshot: {}", e)))?;
        if v.is_null() {
            None
        } else {
            Some(v)
        }
    } else {
        None
    };

    match snapshot {
        Some(snap) => {
            let text = snap
                .get("stopMessageText")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let safe_text = if text.is_empty() {
                "(mode-only)".to_string()
            } else if text.len() <= 24 {
                text.clone()
            } else {
                format!("{}...", &text[..21])
            };
            let mode = snap
                .get("stopMessageStageMode")
                .and_then(|v| v.as_str())
                .unwrap_or("unset")
                .to_lowercase();
            let max_repeats = snap
                .get("stopMessageMaxRepeats")
                .and_then(|v| v.as_f64())
                .filter(|v| v.is_finite())
                .map(|v| (v as i64).max(0))
                .unwrap_or(0);
            let used = snap
                .get("stopMessageUsed")
                .and_then(|v| v.as_f64())
                .filter(|v| v.is_finite())
                .map(|v| (v as i64).max(0))
                .unwrap_or(0);
            let remaining = if max_repeats > 0 {
                (max_repeats - used).max(0)
            } else {
                -1
            };
            let active = mode != "off" && !text.is_empty() && max_repeats > 0;
            let rounds = if max_repeats > 0 {
                format!("{}/{}", used, max_repeats)
            } else {
                format!("{}/-", used)
            };
            let left = if remaining >= 0 {
                remaining.to_string()
            } else {
                "n/a".to_string()
            };

            let result = format!(
                "[stopMessage:scope={} text=\"{}\" mode={} round={} left={} active={}]",
                scope_label,
                safe_text,
                mode,
                rounds,
                left,
                if active { "yes" } else { "no" }
            );
            Ok(result)
        }
        None => {
            if force_show {
                Ok(format!(
                    "[stopMessage:scope={} active=no state=cleared]",
                    scope_label
                ))
            } else {
                Ok(String::new())
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Emit stop message marker parse log
// ---------------------------------------------------------------------------

#[napi]
pub fn emit_stop_message_marker_parse_log_json(log_json: Option<String>) -> napi::Result<()> {
    let log: StopMessageMarkerParseLog = match log_json {
        Some(json) => serde_json::from_str(&json)
            .map_err(|e| napi::Error::from_reason(format!("invalid log: {}", e)))?,
        None => return Ok(()),
    };

    let reset = "\x1b[0m";
    let tag_color = "\x1b[38;5;39m";
    let scope_color = "\x1b[38;5;220m";

    println!(
        "{}[virtual-router][stop_message_parse]{}\x1b[0m requestId={} marker={} parsed={} preview={}",
        tag_color, reset,
        log.request_id,
        if log.marker_detected { "detected" } else { "missing" },
        if log.stop_message_types.is_empty() { "none".to_string() } else { log.stop_message_types.join(",") },
        log.preview,
    );

    if !log.scoped_types.is_empty() {
        let msg = if let Some(ref scope) = log.stop_scope {
            format!(
                "{}[virtual-router][stop_scope]{}\x1b[0m requestId={} stage=apply scope={} instructions={}",
                scope_color, reset, log.request_id, scope, log.scoped_types.join(","),
            )
        } else {
            format!(
                "{}[virtual-router][stop_scope]{}\x1b[0m requestId={} stage=drop reason=missing_session_scope instructions={}",
                scope_color, reset, log.request_id, log.scoped_types.join(","),
            )
        };
        println!("{}", msg);
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Markers cleanup
// ---------------------------------------------------------------------------

fn clean_marker_syntax(request: &mut serde_json::Value) {
    // Remove zero-width spaces and markers from messages content
    if let Some(messages) = request.get_mut("messages").and_then(|v| v.as_array_mut()) {
        for msg in messages.iter_mut() {
            if let Some(content) = msg.get_mut("content") {
                match content {
                    serde_json::Value::String(s) => {
                        s.retain(|c| c != '\u{200B}' && c != '\u{200C}');
                    }
                    serde_json::Value::Array(arr) => {
                        for entry in arr.iter_mut() {
                            if let serde_json::Value::String(s) = entry {
                                s.retain(|c| c != '\u{200B}' && c != '\u{200C}');
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }
}

#[napi]
pub fn clean_stop_message_markers_in_place_json(request_json: String) -> napi::Result<String> {
    let mut request: serde_json::Value = serde_json::from_str(&request_json)
        .map_err(|e| napi::Error::from_reason(format!("invalid request: {}", e)))?;
    clean_marker_syntax(&mut request);
    serde_json::to_string(&request)
        .map_err(|e| napi::Error::from_reason(format!("serialize: {}", e)))
}

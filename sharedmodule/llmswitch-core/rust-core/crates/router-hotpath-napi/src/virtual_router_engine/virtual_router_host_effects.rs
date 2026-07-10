//! Virtual Router host effects — orchestration logic, console output, hit log emission.
//! Ported from `sharedmodule/llmswitch-core/src/runtime/virtual-router-host-effects.ts`
//!
//! All functions are `#[napi]` exported so TS can call via `callNativeJson`.

use napi_derive::napi;
use serde::{Deserialize, Serialize};

use crate::virtual_router_engine::instructions::{
    parse_routing_instructions_from_request, with_rcc_user_dir_override,
};

// feature_id: vr.route_host_effects

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualRouterRouteHostEffectsPlan {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parse_log: Option<StopMessageMarkerParseLog>,
    pub cleaned_request: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_scope: Option<String>,
    pub force_stop_status_label: bool,
    pub hit_log_disabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VirtualRouterRouteHostEffectsFinalizeInput {
    pub result: serde_json::Value,
    pub plan: VirtualRouterRouteHostEffectsPlan,
    #[serde(default)]
    pub hit_log: Option<serde_json::Value>,
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

fn metadata_center_snapshot_or_self(metadata: &serde_json::Value) -> &serde_json::Value {
    metadata.get("metadataCenterSnapshot").unwrap_or(metadata)
}

fn resolve_stop_message_scope_from_metadata(metadata: &serde_json::Value) -> Option<String> {
    crate::virtual_router_engine::routing::resolve_stop_message_scope(
        metadata_center_snapshot_or_self(metadata),
    )
}

fn resolve_session_log_color_key_from_metadata(metadata: &serde_json::Value) -> Option<String> {
    crate::virtual_router_hit_log::resolve_session_log_color_key_json(metadata.to_string())
        .ok()
        .and_then(|raw| serde_json::from_str::<Option<String>>(&raw).ok())
        .flatten()
        .and_then(|value| {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
}

fn resolve_virtual_router_log_request_id(metadata: &serde_json::Value) -> Option<String> {
    let record = metadata.as_object()?;
    for key in [
        "requestId",
        "clientRequestId",
        "inputRequestId",
        "groupRequestId",
    ] {
        if let Some(value) = record.get(key).and_then(|v| v.as_str()) {
            let trimmed = value.trim();
            if !trimmed.is_empty() && !trimmed.contains("unknown") {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn is_virtual_router_hit_log_disabled(metadata: &serde_json::Value) -> bool {
    metadata
        .get("__rt")
        .and_then(|v| v.as_object())
        .and_then(|rt| rt.get("disableVirtualRouterHitLog"))
        .and_then(|v| v.as_bool())
        == Some(true)
}

fn force_stop_status_label_from_log(log: Option<&StopMessageMarkerParseLog>) -> bool {
    let Some(log) = log else {
        return false;
    };
    !log.stop_message_types.is_empty()
        || log
            .scoped_types
            .iter()
            .any(|kind| STOP_MESSAGE_INSTRUCTION_TYPES.contains(&kind.as_str()))
}

// ---------------------------------------------------------------------------
// Stop message marker parse
// ---------------------------------------------------------------------------

fn has_marker_syntax(text: &str) -> bool {
    text.contains("<**") || text.contains('\u{200B}') || text.contains('\u{200C}')
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
    fn compact_marker_whitespace(input: &str) -> String {
        let without_inline_space = regex::Regex::new(r"[ \t]+\n")
            .expect("valid inline marker whitespace regex")
            .replace_all(input, "\n")
            .to_string();
        regex::Regex::new(r"\n{3,}")
            .expect("valid repeated newline regex")
            .replace_all(without_inline_space.trim(), "\n\n")
            .to_string()
    }

    fn strip_marker_syntax_from_text(raw: &str) -> String {
        let without_zero_width = raw
            .chars()
            .filter(|ch| *ch != '\u{200B}' && *ch != '\u{200C}')
            .collect::<String>();
        if !without_zero_width.contains("<**") {
            return without_zero_width;
        }

        let source = without_zero_width.as_str();
        let mut output = String::with_capacity(source.len());
        let mut cursor = 0usize;

        while cursor < source.len() {
            let marker_start = match source[cursor..].find("<**") {
                Some(offset) => cursor + offset,
                None => {
                    output.push_str(&source[cursor..]);
                    break;
                }
            };
            output.push_str(&source[cursor..marker_start]);

            let body_start = marker_start + 3;
            let close_index = source[body_start..]
                .find("**>")
                .map(|offset| body_start + offset);
            let newline_index = source[body_start..]
                .find('\n')
                .map(|offset| body_start + offset);
            let has_closed_marker = match (close_index, newline_index) {
                (Some(close), Some(newline)) => close < newline,
                (Some(_), None) => true,
                _ => false,
            };
            cursor = if has_closed_marker {
                close_index.expect("closed marker index") + 3
            } else {
                newline_index.unwrap_or(source.len())
            };
        }

        compact_marker_whitespace(output.as_str())
    }

    fn clean_content_value(content: &mut serde_json::Value) {
        match content {
            serde_json::Value::String(text) => {
                *text = strip_marker_syntax_from_text(text);
            }
            serde_json::Value::Array(parts) => {
                for entry in parts.iter_mut() {
                    match entry {
                        serde_json::Value::String(text) => {
                            *text = strip_marker_syntax_from_text(text);
                        }
                        serde_json::Value::Object(record) => {
                            for key in ["text", "content"] {
                                if let Some(serde_json::Value::String(text)) = record.get_mut(key) {
                                    *text = strip_marker_syntax_from_text(text);
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    if let Some(messages) = request.get_mut("messages").and_then(|v| v.as_array_mut()) {
        for msg in messages.iter_mut() {
            if let Some(content) = msg.get_mut("content") {
                clean_content_value(content);
            }
        }
    }

    let Some(context_input) = request
        .get_mut("semantics")
        .and_then(|v| v.as_object_mut())
        .and_then(|semantics| semantics.get_mut("responses"))
        .and_then(|v| v.as_object_mut())
        .and_then(|responses| responses.get_mut("context"))
        .and_then(|v| v.as_object_mut())
        .and_then(|context| context.get_mut("input"))
        .and_then(|v| v.as_array_mut())
    else {
        return;
    };

    for entry in context_input.iter_mut() {
        let Some(entry_obj) = entry.as_object_mut() else {
            continue;
        };
        let Some(content) = entry_obj.get_mut("content") else {
            continue;
        };
        clean_content_value(content);
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

#[napi]
pub fn plan_virtual_router_route_host_effects_json(
    request_json: String,
    metadata_json: String,
    rcc_user_dir: Option<String>,
) -> napi::Result<String> {
    let request: serde_json::Value = serde_json::from_str(&request_json)
        .map_err(|e| napi::Error::from_reason(format!("invalid request: {}", e)))?;
    let metadata: serde_json::Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(format!("invalid metadata: {}", e)))?;
    let parsed = with_rcc_user_dir_override(rcc_user_dir.as_deref(), || {
        parse_routing_instructions_from_request(&request)
    })
    .map_err(napi::Error::from_reason)?;
    let parsed_kinds: Vec<String> = parsed.into_iter().map(|entry| entry.kind).collect();
    let stop_scope = resolve_stop_message_scope_from_metadata(&metadata);
    let parse_log_raw = build_stop_message_marker_parse_log_json(
        request_json,
        metadata_json,
        serde_json::to_string(&parsed_kinds)
            .map_err(|e| napi::Error::from_reason(format!("serialize parsed kinds: {}", e)))?,
        stop_scope.clone(),
    )?;
    let parse_log = if parse_log_raw == "null" {
        None
    } else {
        Some(
            serde_json::from_str::<StopMessageMarkerParseLog>(&parse_log_raw)
                .map_err(|e| napi::Error::from_reason(format!("invalid parse log: {}", e)))?,
        )
    };
    let mut cleaned_request = request;
    clean_marker_syntax(&mut cleaned_request);
    let plan = VirtualRouterRouteHostEffectsPlan {
        stop_scope: parse_log
            .as_ref()
            .and_then(|log| log.stop_scope.clone())
            .or(stop_scope),
        force_stop_status_label: force_stop_status_label_from_log(parse_log.as_ref()),
        hit_log_disabled: is_virtual_router_hit_log_disabled(&metadata),
        request_id: resolve_virtual_router_log_request_id(&metadata),
        session_id: resolve_session_log_color_key_from_metadata(&metadata),
        parse_log,
        cleaned_request,
    };
    serde_json::to_string(&plan)
        .map_err(|e| napi::Error::from_reason(format!("serialize host effects plan: {}", e)))
}

#[napi]
pub fn finalize_virtual_router_route_host_effects_json(input_json: String) -> napi::Result<String> {
    let input: VirtualRouterRouteHostEffectsFinalizeInput = serde_json::from_str(&input_json)
        .map_err(|e| {
            napi::Error::from_reason(format!("invalid host effects finalize input: {}", e))
        })?;
    let parse_log_json = input
        .plan
        .parse_log
        .as_ref()
        .map(|log| serde_json::to_string(log))
        .transpose()
        .map_err(|e| napi::Error::from_reason(format!("serialize parse log: {}", e)))?;
    emit_stop_message_marker_parse_log_json(parse_log_json)?;
    if input.plan.hit_log_disabled {
        return Ok("null".to_string());
    }
    let target = input
        .result
        .get("target")
        .and_then(|v| v.as_object())
        .ok_or_else(|| napi::Error::from_reason("host effects result missing target"))?;
    let decision = input
        .result
        .get("decision")
        .and_then(|v| v.as_object())
        .ok_or_else(|| napi::Error::from_reason("host effects result missing decision"))?;
    let provider_key = decision
        .get("providerKey")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .or_else(|| target.get("providerKey").and_then(|v| v.as_str()));
    let hit_record_input = serde_json::json!({
        "requestId": input.plan.request_id,
        "sessionId": input.plan.session_id,
        "routeName": decision.get("routeName").cloned().unwrap_or(serde_json::Value::Null),
        "poolId": decision.get("poolId").cloned().unwrap_or(serde_json::Value::Null),
        "providerKey": provider_key,
        "modelId": target.get("modelId").cloned().unwrap_or(serde_json::Value::Null),
        "hitReason": decision.get("reasoning").cloned().unwrap_or(serde_json::Value::Null),
    });
    let record = crate::virtual_router_hit_log::create_virtual_router_hit_record_json(
        hit_record_input.to_string(),
    )?;
    let line = crate::virtual_router_hit_log::format_virtual_router_hit_json(
        record,
        input.hit_log.map(|value| value.to_string()),
    )?;
    let forced_stop_status_label = if input.plan.force_stop_status_label {
        format_stop_message_status_label_json(None, input.plan.stop_scope, true)?
    } else {
        String::new()
    };
    let output = if forced_stop_status_label.is_empty() {
        line
    } else {
        format!("{} {}", line, forced_stop_status_label)
    };
    serde_json::to_string(&Some(output))
        .map_err(|e| napi::Error::from_reason(format!("serialize host effects output: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::{
        build_stop_message_marker_parse_log_json, clean_stop_message_markers_in_place_json,
        finalize_virtual_router_route_host_effects_json,
        plan_virtual_router_route_host_effects_json,
    };
    use serde_json::{json, Value};

    #[test]
    fn marker_parse_log_detects_angle_marker_and_uses_camel_case_contract() {
        let request = json!({
            "messages": [
                { "role": "user", "content": "<**stopMessage:\"继续执行\",3**> hello" }
            ]
        });
        let metadata = json!({ "requestId": "req-stop-marker" });
        let parsed_kinds = json!(["stopMessageSet"]);

        let raw = build_stop_message_marker_parse_log_json(
            request.to_string(),
            metadata.to_string(),
            parsed_kinds.to_string(),
            Some("session:s1".to_string()),
        )
        .expect("marker parse log");
        let parsed: Value = serde_json::from_str(&raw).expect("parse log json");

        assert_eq!(parsed["requestId"], "req-stop-marker");
        assert_eq!(parsed["markerDetected"], true);
        assert_eq!(parsed["stopMessageTypes"], json!(["stopMessageSet"]));
        assert_eq!(parsed["stopScope"], "session:s1");
    }

    #[test]
    fn marker_cleanup_strips_messages_and_responses_context_input() {
        let request = json!({
            "messages": [
                { "role": "user", "content": "<**stopMessage:\"继续执行\",3**> hello" },
                { "role": "user", "content": [{ "type": "text", "text": "before <**preCommandSet:\"pwd\"**> after" }] }
            ],
            "semantics": {
                "responses": {
                    "context": {
                        "input": [
                            { "role": "user", "content": [{ "type": "input_text", "text": "<**stopMessage:on,3**> hello" }] }
                        ]
                    }
                }
            }
        });

        let raw =
            clean_stop_message_markers_in_place_json(request.to_string()).expect("clean markers");
        let cleaned: Value = serde_json::from_str(&raw).expect("parse cleaned request");

        assert_eq!(cleaned["messages"][0]["content"], "hello");
        assert_eq!(
            cleaned["messages"][1]["content"][0]["text"],
            "before  after"
        );
        assert_eq!(
            cleaned["semantics"]["responses"]["context"]["input"][0]["content"][0]["text"],
            "hello"
        );
        assert!(!raw.contains("<**"));
    }

    #[test]
    fn route_host_effects_plan_and_finalize_own_hit_log_inputs() {
        let request = json!({
            "messages": [
                { "role": "user", "content": "<**stopMessage:on,3**> hello" }
            ]
        });
        let metadata = json!({
            "requestId": "req-host-effects-rust",
            "sessionId": "session-host-effects-rust"
        });

        let plan_raw = plan_virtual_router_route_host_effects_json(
            request.to_string(),
            metadata.to_string(),
            None,
        )
        .expect("host effects plan");
        let plan: Value = serde_json::from_str(&plan_raw).expect("parse host effects plan");

        assert_eq!(plan["requestId"], "req-host-effects-rust");
        assert_eq!(plan["sessionId"], "session-host-effects-rust");
        assert_eq!(plan["forceStopStatusLabel"], true);
        assert!(!plan["cleanedRequest"].to_string().contains("<**"));

        let result = json!({
            "target": { "providerKey": "cc.key1.gpt-5.5", "modelId": "gpt-5.5" },
            "decision": {
                "providerKey": "cc.key1.gpt-5.5",
                "routeName": "thinking",
                "poolId": "gateway-priority-5520-priority-thinking",
                "reasoning": "thinking:user-input"
            }
        });
        let output_raw = finalize_virtual_router_route_host_effects_json(
            json!({ "result": result, "plan": plan }).to_string(),
        )
        .expect("finalize host effects");
        let output: Option<String> = serde_json::from_str(&output_raw).expect("parse output");
        let line = output.expect("hit log line");
        assert!(line.contains("[virtual-router-hit]"));
        assert!(line.contains("req=req-host-effects-rust"));
        assert!(line.contains("sid=session-host-effects-rust"));
        assert!(line.contains(
            "[stopMessage:scope=session:session-host-effects-rust active=no state=cleared]"
        ));
    }
}

//! Virtual Router hit log — pure formatting, zero runtime state.
//! Ported from `sharedmodule/llmswitch-core/src/runtime/virtual-router-hit-log.ts`
//!
//! All functions are `#[napi]` exported so TS can call via `callNativeJson`.
//! No mutable state, no external dependencies.
//!
//! feature_id: vr.hit_log_projection

use napi_derive::napi;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopMessageRuntimeSummary {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_any: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub safe_text: Option<String>,
    pub mode: String,
    pub max_repeats: i64,
    pub used: i64,
    pub remaining: i64,
    pub active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<i64>,
}

impl Default for StopMessageRuntimeSummary {
    fn default() -> Self {
        Self {
            has_any: None,
            safe_text: None,
            mode: "unset".to_string(),
            max_repeats: 0,
            used: 0,
            remaining: -1,
            active: false,
            updated_at: None,
            last_used_at: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualRouterHitRecord {
    pub timestamp_ms: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub route_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pool_id: Option<String>,
    pub provider_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hit_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continuation_scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_penalty: Option<i64>,
    pub stop_message: StopMessageRuntimeSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VirtualRouterHitRecordInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub route_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pool_id: Option<String>,
    pub provider_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hit_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub continuation_scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_message_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_message_max_repeats: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_message_used: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_message_updated_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_message_last_used_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_message_stage_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub routing_state: Option<StopMessageRoutingStateInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_penalty: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StopMessageRoutingStateInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_message_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_message_max_repeats: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_message_used: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_message_updated_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_message_last_used_at: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_message_stage_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VirtualRouterHitLogConfig {
    #[serde(default)]
    pub omit: Vec<String>,
}

const HIT_LOG_OMIT_FIELDS: &[&str] = &[
    "requestId",
    "sessionId",
    "model",
    "reason",
    "continuation",
    "requestTokens",
    "selectionPenalty",
    "stopMessage",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_STOP_MESSAGE_MAX_REPEATS: i64 = 10;

fn to_safe_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else if trimmed.len() <= 24 {
        Some(trimmed.to_string())
    } else {
        Some(format!("{}…", &trimmed[..21]))
    }
}

fn to_stop_mode(mode: &str) -> String {
    let m = mode.trim().to_lowercase();
    if m == "on" || m == "off" || m == "auto" {
        m
    } else {
        "unset".to_string()
    }
}

fn to_finite_i64(v: f64) -> i64 {
    if v.is_finite() {
        v as i64
    } else {
        0
    }
}

fn current_epoch_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn summarize_stop_message_runtime(
    input: &VirtualRouterHitRecordInput,
) -> StopMessageRuntimeSummary {
    let routing_state = input.routing_state.as_ref();
    let text = input
        .stop_message_text
        .as_deref()
        .or_else(|| routing_state.and_then(|state| state.stop_message_text.as_deref()))
        .unwrap_or("")
        .trim();
    let has_goal_text = !text.is_empty();
    let safe_text = to_safe_text(text);
    let mode = to_stop_mode(
        input
            .stop_message_stage_mode
            .as_deref()
            .or_else(|| routing_state.and_then(|state| state.stop_message_stage_mode.as_deref()))
            .unwrap_or(""),
    );
    let parsed_max = input
        .stop_message_max_repeats
        .or_else(|| routing_state.and_then(|state| state.stop_message_max_repeats))
        .map(|v| to_finite_i64(v))
        .filter(|&v| v > 0)
        .unwrap_or(0);
    let max_repeats = if parsed_max > 0 {
        parsed_max
    } else if has_goal_text && (mode == "on" || mode == "auto") {
        DEFAULT_STOP_MESSAGE_MAX_REPEATS
    } else {
        0
    };
    let used = input
        .stop_message_used
        .or_else(|| routing_state.and_then(|state| state.stop_message_used))
        .map(|v| to_finite_i64(v).max(0))
        .unwrap_or(0);
    let remaining = if max_repeats > 0 {
        (max_repeats - used).max(0)
    } else {
        -1
    };
    let active = mode != "off" && has_goal_text && max_repeats > 0;

    StopMessageRuntimeSummary {
        has_any: Some(has_goal_text || max_repeats > 0 || used > 0),
        safe_text,
        mode,
        max_repeats,
        used,
        remaining,
        active,
        updated_at: input
            .stop_message_updated_at
            .or_else(|| routing_state.and_then(|state| state.stop_message_updated_at))
            .map(|v| to_finite_i64(v))
            .filter(|&v| v > 0),
        last_used_at: input
            .stop_message_last_used_at
            .or_else(|| routing_state.and_then(|state| state.stop_message_last_used_at))
            .map(|v| to_finite_i64(v))
            .filter(|&v| v > 0),
    }
}

// ---------------------------------------------------------------------------
// Session log color
// ---------------------------------------------------------------------------

fn hash_session_log_color_token(value: &str) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for byte in value.bytes() {
        hash ^= byte as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    hash ^= hash >> 16;
    hash = hash.wrapping_mul(0x7feb352d);
    hash ^= hash >> 15;
    hash = hash.wrapping_mul(0x846ca68b);
    hash ^= hash >> 16;
    hash
}

fn hsl_to_rgb(hue: f64, saturation: f64, lightness: f64) -> (u8, u8, u8) {
    let chroma = (1.0 - (2.0 * lightness - 1.0).abs()) * saturation;
    let hue_prime = hue / 60.0;
    let x = chroma * (1.0 - ((hue_prime % 2.0) - 1.0).abs());
    let (r1, g1, b1) = if hue_prime < 1.0 {
        (chroma, x, 0.0)
    } else if hue_prime < 2.0 {
        (x, chroma, 0.0)
    } else if hue_prime < 3.0 {
        (0.0, chroma, x)
    } else if hue_prime < 4.0 {
        (0.0, x, chroma)
    } else if hue_prime < 5.0 {
        (x, 0.0, chroma)
    } else {
        (chroma, 0.0, x)
    };
    let m = lightness - chroma / 2.0;
    let to_channel = |v: f64| -> u8 { ((v + m).clamp(0.0, 1.0) * 255.0).round() as u8 };
    (to_channel(r1), to_channel(g1), to_channel(b1))
}

fn resolve_session_color(session_id: &str) -> Option<String> {
    if session_id.trim().is_empty() {
        return None;
    }
    let hash = hash_session_log_color_token(session_id.trim());
    let mut hue = (hash % 3600) as f64 / 10.0;
    if !(18.0..342.0).contains(&hue) {
        hue = (hue + 47.0) % 360.0;
    }
    let saturation = 0.62 + (((hash >> 12) & 0xff) as f64 / 255.0) * 0.24;
    let lightness = 0.50 + (((hash >> 20) & 0xff) as f64 / 255.0) * 0.16;
    let (r, g, b) = hsl_to_rgb(hue, saturation, lightness);
    Some(format!("\x1b[38;2;{};{};{}m", r, g, b))
}

fn resolve_route_color(route_name: &str) -> &'static str {
    match route_name {
        "multimodal" => "\x1b[38;5;45m",
        "tools" => "\x1b[38;5;214m",
        "thinking" => "\x1b[34m",
        "coding" => "\x1b[35m",
        "longcontext" => "\x1b[38;5;141m",
        "web_search" => "\x1b[32m",
        "search" => "\x1b[38;5;34m",
        "background" => "\x1b[90m",
        _ => "\x1b[36m",
    }
}

fn describe_target_provider_inner(
    provider_key: &str,
    fallback_model_id: Option<&str>,
) -> (String, Option<String>) {
    let trimmed = provider_key.trim();
    if trimmed.is_empty() {
        return (
            provider_key.to_string(),
            fallback_model_id.map(String::from),
        );
    }
    let parts: Vec<&str> = trimmed.split('.').collect();
    match parts.len() {
        0 | 1 => (
            parts.first().unwrap_or(&trimmed).to_string(),
            fallback_model_id.map(String::from),
        ),
        2 => (parts[0].to_string(), Some(parts[1].to_string())),
        _ => {
            let alias_label = format!("{}[{}]", parts[0], parts[1]);
            let resolved =
                Some(parts[2..].join(".")).or_else(|| fallback_model_id.map(String::from));
            (alias_label, resolved)
        }
    }
}

fn format_continuation_scope_inner(scope: &str) -> String {
    let normalized = scope.trim();
    if normalized.is_empty() {
        return String::new();
    }
    if normalized.len() <= 20 {
        return normalized.to_string();
    }
    if let Some(idx) = normalized.find(':') {
        let prefix = &normalized[..=idx];
        let body = &normalized[idx + 1..];
        if body.len() <= 8 {
            return format!("{}{}", prefix, body);
        }
        return format!("{}{}...{}", prefix, &body[..4], &body[body.len() - 4..]);
    }
    if normalized.len() <= 20 {
        normalized.to_string()
    } else {
        format!(
            "{}...{}",
            &normalized[..4],
            &normalized[normalized.len() - 4..]
        )
    }
}

fn parse_timestamp(ts_ms: i64) -> String {
    std::time::UNIX_EPOCH
        .checked_add(std::time::Duration::from_millis(ts_ms as u64))
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| {
            let s = d.as_secs();
            format!("{:02}:{:02}:{:02}", (s / 3600) % 24, (s / 60) % 60, s % 60)
        })
        .unwrap_or_else(|| "??:??:??".to_string())
}

// ---------------------------------------------------------------------------
// NAPI exports
// ---------------------------------------------------------------------------

#[napi]
pub fn create_virtual_router_hit_record_json(input_json: String) -> napi::Result<String> {
    let input: VirtualRouterHitRecordInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("invalid hit record input: {}", e)))?;
    let timestamp_ms = input
        .timestamp_ms
        .map(|v| if v.is_finite() { v as i64 } else { 0 })
        .unwrap_or(0);
    let timestamp_ms = if timestamp_ms > 0 {
        timestamp_ms
    } else {
        current_epoch_ms()
    };
    let stop_message = summarize_stop_message_runtime(&input);
    let record = VirtualRouterHitRecord {
        timestamp_ms,
        request_id: input.request_id,
        session_id: input.session_id,
        route_name: input.route_name,
        pool_id: input.pool_id,
        provider_key: input.provider_key,
        model_id: input.model_id,
        hit_reason: input.hit_reason,
        continuation_scope: input.continuation_scope,
        request_tokens: input.request_tokens.map(|v| (v.round() as i64).max(0)),
        selection_penalty: input.selection_penalty.map(|v| to_finite_i64(v).max(0)),
        stop_message,
    };
    serde_json::to_string(&record)
        .map_err(|e| napi::Error::from_reason(format!("serialize hit record: {}", e)))
}

#[napi]
pub fn format_virtual_router_hit_json(
    record_json: String,
    config_json: Option<String>,
) -> napi::Result<String> {
    let record: VirtualRouterHitRecord = serde_json::from_str(&record_json)
        .map_err(|e| napi::Error::from_reason(format!("invalid record: {}", e)))?;

    let omit_set: std::collections::HashSet<String> = if let Some(cfg) = config_json {
        let cfg_val: serde_json::Value = serde_json::from_str(&cfg)
            .map_err(|e| napi::Error::from_reason(format!("invalid config: {}", e)))?;
        cfg_val
            .get("omit")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str())
                    .filter(|s| HIT_LOG_OMIT_FIELDS.contains(s))
                    .map(ToString::to_string)
                    .collect()
            })
            .unwrap_or_default()
    } else {
        std::collections::HashSet::new()
    };

    let reset = "\x1b[0m";
    let time_color = "\x1b[90m";
    let time_label = format!(
        "{}{}{}",
        time_color,
        parse_timestamp(record.timestamp_ms),
        reset
    );
    let (provider_label, resolved_model) =
        describe_target_provider_inner(&record.provider_key, record.model_id.as_deref());
    let route_label = record.route_name.clone();
    let session_id = record
        .session_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| napi::Error::from_reason("virtual-router-hit sessionId is required"))?;
    let session_color = resolve_session_color(session_id)
        .ok_or_else(|| napi::Error::from_reason("virtual-router-hit sessionId is required"))?;
    let target_label = if !omit_set.contains("model") {
        match resolved_model {
            Some(m) => format!("{} -> {}.{}", route_label, provider_label, m),
            None => format!("{} -> {}", route_label, provider_label),
        }
    } else {
        format!("{} -> {}", route_label, provider_label)
    };
    let request_id_label: String = if !omit_set.contains("requestId") {
        record
            .request_id
            .as_ref()
            .filter(|s| !s.is_empty() && !s.contains("unknown"))
            .map(|s| format!(" req={}", s))
            .unwrap_or_default()
    } else {
        String::new()
    };
    let session_id_label: String = if !omit_set.contains("sessionId") {
        format!(" sid={}", session_id)
    } else {
        String::new()
    };
    let continuation_label: String = if !omit_set.contains("continuation") {
        record
            .continuation_scope
            .as_ref()
            .map(|s| {
                format!(
                    " \x1b[33m[continuation:{}]{}\x1b[0m",
                    format_continuation_scope_inner(s),
                    reset
                )
            })
            .unwrap_or_default()
    } else {
        String::new()
    };
    let reason_label: String = if !omit_set.contains("reason") {
        record
            .hit_reason
            .as_ref()
            .map(|s| format!(" reason={}", s))
            .unwrap_or_default()
    } else {
        String::new()
    };
    let request_token_label: String = if !omit_set.contains("requestTokens") {
        record
            .request_tokens
            .filter(|&v| v >= 0)
            .map(|v| format!(" reqTokens={}", v))
            .unwrap_or_default()
    } else {
        String::new()
    };
    let penalty_label: String = if !omit_set.contains("selectionPenalty") {
        record
            .selection_penalty
            .filter(|&v| v > 0)
            .map(|v| format!(" penalty={}", v))
            .unwrap_or_default()
    } else {
        String::new()
    };
    let stop_label: String =
        if !omit_set.contains("stopMessage") && record.stop_message.has_any.unwrap_or(false) {
            let sm = &record.stop_message;
            let safe_text = sm.safe_text.as_deref().unwrap_or("(mode-only)");
            let rounds = if sm.max_repeats > 0 {
                format!("{}/{}", sm.used, sm.max_repeats)
            } else {
                format!("{}/-", sm.used)
            };
            let left = if sm.remaining >= 0 {
                sm.remaining.to_string()
            } else {
                "n/a".to_string()
            };
            let mut parts = vec![
                format!("\"{}\"", safe_text),
                format!("mode={}", sm.mode),
                format!("round={}", rounds),
                format!("active={}", if sm.active { "yes" } else { "no" }),
                format!("left={}", left),
            ];
            if let Some(updated) = sm.updated_at {
                parts.push(format!("set={}", parse_timestamp(updated)));
            }
            if let Some(last) = sm.last_used_at {
                parts.push(format!("last={}", parse_timestamp(last)));
            }
            format!(
                " \x1b[38;5;214m[stopMessage:{}]{}\x1b[0m",
                parts.join(" "),
                reset
            )
        } else {
            String::new()
        };

    let prefix = format!("{}[virtual-router-hit]{}\x1b[0m", session_color, reset);
    let target_label = format!("{}{}{}", session_color, target_label, reset);
    let line = format!(
        "{} {}{}{} {}{}{}{}{}{}{}",
        prefix,
        time_label,
        request_id_label,
        session_id_label,
        target_label,
        continuation_label,
        reason_label,
        request_token_label,
        penalty_label,
        stop_label,
        reset
    );
    Ok(line)
}

#[napi]
pub fn format_continuation_scope_json(scope: Option<String>) -> napi::Result<String> {
    let result = scope
        .as_ref()
        .map(|s| format_continuation_scope_inner(s))
        .filter(|s| !s.is_empty());
    serde_json::to_string(&result)
        .map_err(|e| napi::Error::from_reason(format!("serialize: {}", e)))
}

#[napi]
pub fn parse_virtual_router_hit_provider_key_json(provider_key: String) -> napi::Result<String> {
    let trimmed = provider_key.trim();
    if trimmed.is_empty() {
        return Ok("null".to_string());
    }
    let parts: Vec<&str> = trimmed.split('.').collect();
    let result = match parts.len() {
        0 | 1 => serde_json::json!({ "providerId": trimmed }),
        2 => serde_json::json!({ "providerId": parts[0], "modelId": parts[1] }),
        _ => {
            serde_json::json!({ "providerId": parts[0], "keyAlias": parts[1], "modelId": parts[2..].join(".") })
        }
    };
    serde_json::to_string(&result)
        .map_err(|e| napi::Error::from_reason(format!("serialize: {}", e)))
}

#[napi]
pub fn resolve_session_log_color_key_json(input_json: String) -> napi::Result<String> {
    let input: serde_json::Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("invalid input: {}", e)))?;
    let result: Option<String> = if let serde_json::Value::Object(m) = &input {
        let candidates = [
            "sessionId",
            "session_id",
            "conversationId",
            "conversation_id",
            "logSessionColorKey",
            "clientTmuxSessionId",
            "client_tmux_session_id",
            "tmuxSessionId",
            "tmux_session_id",
            "rccSessionClientTmuxSessionId",
            "rcc_session_client_tmux_session_id",
        ];
        for key in &candidates {
            if let Some(val) = m.get(*key) {
                if let Some(s) = val.as_str() {
                    let t = s.trim();
                    if !t.is_empty() {
                        return Ok(serde_json::to_string(&Some(t.to_string())).unwrap());
                    }
                }
            }
        }
        None
    } else {
        None
    };
    serde_json::to_string(&result)
        .map_err(|e| napi::Error::from_reason(format!("serialize: {}", e)))
}

#[napi]
pub fn describe_target_provider_json(
    provider_key: String,
    fallback_model_id: Option<String>,
) -> napi::Result<String> {
    let (provider_label, resolved_model) =
        describe_target_provider_inner(&provider_key, fallback_model_id.as_deref());
    serde_json::to_string(&serde_json::json!({
        "providerLabel": provider_label, "resolvedModel": resolved_model
    }))
    .map_err(|e| napi::Error::from_reason(format!("serialize: {}", e)))
}

#[napi]
pub fn resolve_route_color_str(route_name: String) -> String {
    resolve_route_color(&route_name).to_string()
}

#[napi]
pub fn resolve_session_color_str(session_id: Option<String>) -> napi::Result<String> {
    let result: Option<String> = session_id.as_ref().and_then(|s| resolve_session_color(s));
    serde_json::to_string(&result)
        .map_err(|e| napi::Error::from_reason(format!("serialize: {}", e)))
}

#[napi]
pub fn build_hit_reason_json(
    route_used: String,
    provider_key: String,
    classification_reasoning: Option<String>,
    route_changed: bool,
    estimated_tokens: Option<f64>,
    last_assistant_tool_label: Option<String>,
    provider_max_context_tokens: Option<f64>,
    context_warn_ratio: Option<f64>,
) -> napi::Result<String> {
    let reason = classification_reasoning.as_deref().unwrap_or("");
    let primary = reason.split('|').next().unwrap_or("").trim();
    let command_detail = last_assistant_tool_label.as_deref();
    let base = if route_used == "tools" || route_used == "thinking" || route_used == "coding" {
        match (primary.is_empty(), command_detail) {
            (false, Some(d)) if !d.is_empty() => format!("{}({})", primary, d),
            (false, _) => primary.to_string(),
            (true, Some(d)) if !d.is_empty() => format!("{}({})", route_used, d),
            (true, _) => route_used.to_string(),
        }
    } else if route_used == "web_search" || route_used == "search" {
        match (primary.is_empty(), command_detail) {
            (false, Some(d)) if !d.is_empty() => format!("{}({})", primary, d),
            (false, _) => primary.to_string(),
            (true, Some(d)) if !d.is_empty() => format!("{}({})", route_used, d),
            (true, _) => route_used.to_string(),
        }
    } else if route_used == "default" && route_changed {
        if primary.is_empty() {
            "default:route-selected".to_string()
        } else {
            primary.to_string()
        }
    } else if !primary.is_empty() {
        primary.to_string()
    } else {
        format!("route:{}", route_used)
    };
    let context_detail: Option<String> = estimated_tokens
        .filter(|v| v.is_finite() && *v > 0.0)
        .map(|tokens| {
            let limit = provider_max_context_tokens
                .filter(|v| v.is_finite() && *v > 0.0)
                .unwrap_or(200_000.0);
            let threshold = context_warn_ratio
                .filter(|v| v.is_finite() && *v > 0.0)
                .unwrap_or(0.9);
            let ratio = tokens / limit;
            if ratio >= threshold {
                Some(format!("{:.2}/{}", ratio, limit as i64))
            } else {
                None
            }
        })
        .flatten();
    let result = if let Some(cd) = context_detail {
        format!("{}|context:{}", base, cd)
    } else {
        base
    };
    serde_json::to_string(&result)
        .map_err(|e| napi::Error::from_reason(format!("serialize: {}", e)))
}

#[napi]
pub fn to_virtual_router_hit_event_json(
    record_json: String,
    meta_json: String,
) -> napi::Result<String> {
    let record: VirtualRouterHitRecord = serde_json::from_str(&record_json)
        .map_err(|e| napi::Error::from_reason(format!("invalid record: {}", e)))?;
    let meta: serde_json::Value = serde_json::from_str(&meta_json)
        .map_err(|e| napi::Error::from_reason(format!("invalid meta: {}", e)))?;
    let request_id = meta
        .get("requestId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let entry_endpoint = meta
        .get("entryEndpoint")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .unwrap_or("/v1/chat/completions");
    let mut event = serde_json::Map::new();
    event.insert(
        "requestId".to_string(),
        serde_json::Value::String(request_id),
    );
    event.insert(
        "timestamp".to_string(),
        serde_json::Value::Number(record.timestamp_ms.into()),
    );
    event.insert(
        "entryEndpoint".to_string(),
        serde_json::Value::String(entry_endpoint.to_string()),
    );
    event.insert(
        "routeName".to_string(),
        serde_json::Value::String(record.route_name.clone()),
    );
    event.insert(
        "pool".to_string(),
        serde_json::Value::String(record.route_name.clone()),
    );
    event.insert(
        "providerKey".to_string(),
        serde_json::Value::String(record.provider_key.clone()),
    );
    if let Some(model_id) = record.model_id {
        event.insert("modelId".to_string(), serde_json::Value::String(model_id));
    }
    if let Some(reason) = record.hit_reason {
        event.insert("reason".to_string(), serde_json::Value::String(reason));
    }
    if let Some(tokens) = record.request_tokens {
        event.insert(
            "requestTokens".to_string(),
            serde_json::Value::Number(tokens.into()),
        );
    }
    if let Some(penalty) = record.selection_penalty {
        event.insert(
            "selectionPenalty".to_string(),
            serde_json::Value::Number(penalty.into()),
        );
    }
    event.insert(
        "stopMessageActive".to_string(),
        serde_json::Value::Bool(record.stop_message.active),
    );
    if record.stop_message.mode != "unset" {
        event.insert(
            "stopMessageMode".to_string(),
            serde_json::Value::String(record.stop_message.mode),
        );
    }
    if record.stop_message.remaining >= 0 {
        event.insert(
            "stopMessageRemaining".to_string(),
            serde_json::Value::Number(record.stop_message.remaining.into()),
        );
    }
    serde_json::to_string(&serde_json::Value::Object(event))
        .map_err(|e| napi::Error::from_reason(format!("serialize event: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn session_color_is_stable_and_not_palette_bucket_colliding() {
        let first = resolve_session_color("active-session-color-2").expect("first color");
        let second = resolve_session_color("active-session-color-3").expect("second color");
        let first_again = resolve_session_color("active-session-color-2").expect("stable color");

        assert!(first.starts_with("\x1b[38;2;"));
        assert_eq!(first, first_again);
        assert_ne!(first, second);
    }

    #[test]
    fn virtual_router_hit_log_contract_is_native_owned() {
        let record_json = create_virtual_router_hit_record_json(
            json!({
                "requestId": "req-1",
                "sessionId": "tmux-alpha-01",
                "routeName": "thinking",
                "poolId": "thinking-primary",
                "providerKey": "glm.key1.kimi-k2.5",
                "modelId": "kimi-k2.5",
                "hitReason": "thinking:user-input",
                "continuationScope": "responses:abcdef1234567890",
                "requestTokens": 1234.6,
                "selectionPenalty": 3,
                "timestampMs": 1_700_000_000_000_f64,
                "stopMessageText": "need more evidence before terminal",
                "stopMessageStageMode": "auto",
                "stopMessageUsed": 2,
            })
            .to_string(),
        )
        .expect("record");
        let record: serde_json::Value = serde_json::from_str(&record_json).expect("record json");
        assert_eq!(record["requestId"], "req-1");
        assert_eq!(record["requestTokens"], 1235);
        assert_eq!(record["selectionPenalty"], 3);
        assert_eq!(record["stopMessage"]["mode"], "auto");
        assert_eq!(record["stopMessage"]["maxRepeats"], 10);
        assert_eq!(record["stopMessage"]["remaining"], 8);
        assert_eq!(record["stopMessage"]["active"], true);

        let line = format_virtual_router_hit_json(
            record_json.clone(),
            Some(json!({"omit": ["requestId"]}).to_string()),
        )
        .expect("line");
        assert!(line.contains("[virtual-router-hit]"));
        assert!(line.contains("thinking -> glm[key1].kimi-k2.5"));
        assert!(!line.contains("thinking-primary"));
        assert!(!line.contains("req=req-1"));
        assert!(line.contains("sid=tmux-alpha-01"));
        assert!(line.contains("reqTokens=1235"));
        assert!(line.contains("penalty=3"));
        assert!(line.contains("[stopMessage:"));

        let event_json = to_virtual_router_hit_event_json(
            record_json,
            json!({"requestId": "req-evt", "entryEndpoint": "/v1/messages"}).to_string(),
        )
        .expect("event");
        let event: serde_json::Value = serde_json::from_str(&event_json).expect("event json");
        assert_eq!(event["requestId"], "req-evt");
        assert_eq!(event["entryEndpoint"], "/v1/messages");
        assert_eq!(event["routeName"], "thinking");
        assert_eq!(event["pool"], "thinking");
        assert_eq!(event["requestTokens"], 1235);
        assert_eq!(event["selectionPenalty"], 3);
        assert_eq!(event["stopMessageActive"], true);

        let scope = format_continuation_scope_json(Some("responses:abcdef1234567890".to_string()))
            .expect("scope");
        assert_eq!(scope, "\"responses:abcd...7890\"");

        let parsed_provider =
            parse_virtual_router_hit_provider_key_json("glm.key1.kimi-k2.5".to_string())
                .expect("provider");
        let parsed_provider: serde_json::Value =
            serde_json::from_str(&parsed_provider).expect("provider json");
        assert_eq!(parsed_provider["providerId"], "glm");
        assert_eq!(parsed_provider["keyAlias"], "key1");
        assert_eq!(parsed_provider["modelId"], "kimi-k2.5");

        let reason = build_hit_reason_json(
            "thinking".to_string(),
            "glm.key1.kimi-k2.5".to_string(),
            Some("thinking:user-input|other".to_string()),
            false,
            Some(95_000.0),
            Some("shell".to_string()),
            Some(100_000.0),
            Some(0.9),
        )
        .expect("reason");
        assert_eq!(reason, "\"thinking:user-input(shell)|context:0.95/100000\"");
    }
}

use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::Serialize;
use serde_json::{Map, Value};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClockReminderFlowPlanOutput {
    skip_for_server_tool_followup: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClockConfigOutput {
    enabled: bool,
    retention_ms: i64,
    due_window_ms: i64,
    tick_ms: i64,
    hold_non_streaming: bool,
    hold_max_ms: i64,
}

const CLOCK_RETENTION_MS_DEFAULT: i64 = 20 * 60_000;
const CLOCK_DUE_WINDOW_MS_DEFAULT: i64 = 0;
const CLOCK_TICK_MS_DEFAULT: i64 = 60_000;
const CLOCK_HOLD_NON_STREAMING_DEFAULT: bool = true;
const CLOCK_HOLD_MAX_MS_DEFAULT: i64 = 60_000;

fn resolve_bool_field(row: Option<&serde_json::Map<String, Value>>, key: &str) -> bool {
    row.and_then(|obj| obj.get(key))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn resolve_clock_reminder_flow_plan(runtime_metadata: Value) -> ClockReminderFlowPlanOutput {
    let rt_obj = runtime_metadata.as_object();
    let server_tool_followup = resolve_bool_field(rt_obj, "serverToolFollowup");
    let allow_followup = resolve_bool_field(rt_obj, "clockFollowupInjectReminders");
    ClockReminderFlowPlanOutput {
        skip_for_server_tool_followup: server_tool_followup && !allow_followup,
    }
}

fn read_token(value: Option<&Value>) -> String {
    value
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_default()
}

fn read_record_token(record: Option<&Map<String, Value>>, keys: &[&str]) -> String {
    let Some(row) = record else {
        return String::new();
    };
    for key in keys {
        let token = read_token(row.get(*key));
        if !token.is_empty() {
            return token;
        }
    }
    String::new()
}

fn resolve_clock_session_scope(primary: &Value, fallback: &Value) -> Option<String> {
    let primary_obj = primary.as_object();
    let fallback_obj = fallback.as_object();

    let tmux_session_id = {
        let from_primary = read_record_token(
            primary_obj,
            &[
                "clientTmuxSessionId",
                "client_tmux_session_id",
                "tmuxSessionId",
                "tmux_session_id",
            ],
        );
        if !from_primary.is_empty() {
            from_primary
        } else {
            read_record_token(
                fallback_obj,
                &[
                    "clientTmuxSessionId",
                    "client_tmux_session_id",
                    "tmuxSessionId",
                    "tmux_session_id",
                ],
            )
        }
    };
    if !tmux_session_id.is_empty() {
        return Some(format!("tmux:{tmux_session_id}"));
    }

    None
}

fn parse_boolean_with_default(value: Option<&Value>, fallback: bool) -> bool {
    let Some(raw) = value else {
        return fallback;
    };
    if let Some(v) = raw.as_bool() {
        return v;
    }
    if let Some(v) = raw.as_i64() {
        if v == 1 {
            return true;
        }
        if v == 0 {
            return false;
        }
        return fallback;
    }
    if let Some(v) = raw.as_str() {
        let normalized = v.trim().to_ascii_lowercase();
        if normalized == "true" || normalized == "1" || normalized == "yes" || normalized == "on" {
            return true;
        }
        if normalized == "false" || normalized == "0" || normalized == "no" || normalized == "off" {
            return false;
        }
        return fallback;
    }
    fallback
}

fn parse_non_negative_int(value: Option<&Value>, fallback: i64) -> i64 {
    let Some(raw) = value else {
        return fallback;
    };
    let Some(v) = raw.as_f64() else {
        return fallback;
    };
    if !v.is_finite() || v < 0.0 {
        return fallback;
    }
    v.floor() as i64
}

fn normalize_clock_config(raw: &Value) -> Option<ClockConfigOutput> {
    let record = raw.as_object()?;
    let enabled = record
        .get("enabled")
        .map(|value| match value {
            Value::Bool(v) => *v,
            Value::String(v) => v.trim().eq_ignore_ascii_case("true"),
            Value::Number(v) => v.as_i64().map(|n| n == 1).unwrap_or(false),
            _ => false,
        })
        .unwrap_or(false);
    if !enabled {
        return None;
    }

    Some(ClockConfigOutput {
        enabled: true,
        retention_ms: parse_non_negative_int(record.get("retentionMs"), CLOCK_RETENTION_MS_DEFAULT),
        due_window_ms: parse_non_negative_int(
            record.get("dueWindowMs"),
            CLOCK_DUE_WINDOW_MS_DEFAULT,
        ),
        tick_ms: parse_non_negative_int(record.get("tickMs"), CLOCK_TICK_MS_DEFAULT),
        hold_non_streaming: parse_boolean_with_default(
            record.get("holdNonStreaming"),
            CLOCK_HOLD_NON_STREAMING_DEFAULT,
        ),
        hold_max_ms: parse_non_negative_int(record.get("holdMaxMs"), CLOCK_HOLD_MAX_MS_DEFAULT),
    })
}

fn resolve_clock_config(raw: &Value, raw_is_undefined: bool) -> Option<ClockConfigOutput> {
    if let Some(normalized) = normalize_clock_config(raw) {
        return Some(normalized);
    }
    if raw_is_undefined {
        let default_raw = serde_json::json!({ "enabled": true });
        return normalize_clock_config(&default_raw);
    }
    None
}

#[napi]
pub fn resolve_clock_reminder_flow_plan_json(runtime_metadata_json: String) -> NapiResult<String> {
    let runtime_metadata: Value = serde_json::from_str(&runtime_metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_clock_reminder_flow_plan(runtime_metadata);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_clock_session_scope_json(
    primary_json: String,
    fallback_json: String,
) -> NapiResult<String> {
    let primary: Value =
        serde_json::from_str(&primary_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let fallback: Value = serde_json::from_str(&fallback_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_clock_session_scope(&primary, &fallback);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_clock_config_json(raw_json: String, raw_is_undefined: bool) -> NapiResult<String> {
    let raw: Value =
        serde_json::from_str(&raw_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_clock_config(&raw, raw_is_undefined);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

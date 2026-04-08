use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Number, Value};

const DEFAULT_STOP_MESSAGE_MAX_REPEATS: i64 = 10;
const STOP_MESSAGE_AI_HISTORY_MAX: usize = 8;

fn read_finite_f64(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(num)) => num.as_f64().filter(|v| v.is_finite()),
        _ => None,
    }
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value?.as_str()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.to_string())
}

fn read_bool(value: Option<&Value>) -> Option<bool> {
    match value {
        Some(Value::Bool(flag)) => Some(*flag),
        _ => None,
    }
}

fn normalize_stage_mode(value: Option<&Value>) -> Option<String> {
    let normalized = read_trimmed_string(value)?.to_ascii_lowercase();
    if normalized == "on" || normalized == "off" || normalized == "auto" {
        return Some(normalized);
    }
    None
}

fn normalize_ai_mode(value: Option<&Value>) -> Option<String> {
    let normalized = read_trimmed_string(value)?.to_ascii_lowercase();
    if normalized == "on" || normalized == "off" {
        return Some(normalized);
    }
    None
}

fn to_i64_floor(value: f64) -> i64 {
    value.floor() as i64
}

fn set_i64(target: &mut Map<String, Value>, key: &str, value: i64) {
    target.insert(key.to_string(), Value::Number(Number::from(value)));
}

fn normalize_ai_history_entries(value: Option<&Value>) -> Vec<Value> {
    let rows = match value {
        Some(Value::Array(items)) => items,
        _ => return Vec::new(),
    };
    let mut out: Vec<Value> = Vec::new();
    for item in rows {
        let row = match item {
            Value::Object(map) => map,
            _ => continue,
        };
        let mut normalized = Map::<String, Value>::new();
        if let Some(ts) = read_finite_f64(row.get("ts")) {
            set_i64(&mut normalized, "ts", to_i64_floor(ts));
        }
        if let Some(round_raw) = read_finite_f64(row.get("round")) {
            let round = to_i64_floor(round_raw).max(0);
            set_i64(&mut normalized, "round", round);
        }
        for key in [
            "assistantText",
            "reasoningText",
            "responseExcerpt",
            "followupText",
        ] {
            if let Some(value) = read_trimmed_string(row.get(key)) {
                normalized.insert(key.to_string(), Value::String(value));
            }
        }
        if !normalized.is_empty() {
            out.push(Value::Object(normalized));
        }
    }
    if out.len() > STOP_MESSAGE_AI_HISTORY_MAX {
        out = out[(out.len() - STOP_MESSAGE_AI_HISTORY_MAX)..].to_vec();
    }
    out
}

fn serialize_stop_message_state_from_map(state: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::<String, Value>::new();
    if let Some(source) = read_trimmed_string(state.get("stopMessageSource")) {
        out.insert("stopMessageSource".to_string(), Value::String(source));
    }
    if let Some(raw_text) = state.get("stopMessageText").and_then(|v| v.as_str()) {
        if !raw_text.trim().is_empty() {
            out.insert(
                "stopMessageText".to_string(),
                Value::String(raw_text.to_string()),
            );
        }
    }
    if let Some(max_repeats) = read_finite_f64(state.get("stopMessageMaxRepeats")) {
        set_i64(&mut out, "stopMessageMaxRepeats", to_i64_floor(max_repeats));
    }
    if let Some(used) = read_finite_f64(state.get("stopMessageUsed")) {
        set_i64(&mut out, "stopMessageUsed", to_i64_floor(used));
    }
    if let Some(updated_at) = read_finite_f64(state.get("stopMessageUpdatedAt")) {
        set_i64(&mut out, "stopMessageUpdatedAt", to_i64_floor(updated_at));
    }
    if let Some(last_used_at) = read_finite_f64(state.get("stopMessageLastUsedAt")) {
        set_i64(
            &mut out,
            "stopMessageLastUsedAt",
            to_i64_floor(last_used_at),
        );
    }
    if let Some(mode) = normalize_stage_mode(state.get("stopMessageStageMode")) {
        out.insert("stopMessageStageMode".to_string(), Value::String(mode));
    }
    if let Some(ai_mode) = normalize_ai_mode(state.get("stopMessageAiMode")) {
        out.insert("stopMessageAiMode".to_string(), Value::String(ai_mode));
    }
    if let Some(seed_prompt) = read_trimmed_string(state.get("stopMessageAiSeedPrompt")) {
        out.insert(
            "stopMessageAiSeedPrompt".to_string(),
            Value::String(seed_prompt),
        );
    }
    let history = normalize_ai_history_entries(state.get("stopMessageAiHistory"));
    if !history.is_empty() {
        out.insert("stopMessageAiHistory".to_string(), Value::Array(history));
    }
    if let Some(armed) = read_bool(state.get("reasoningStopArmed")) {
        out.insert("reasoningStopArmed".to_string(), Value::Bool(armed));
    }
    if let Some(summary) = read_trimmed_string(state.get("reasoningStopSummary")) {
        out.insert("reasoningStopSummary".to_string(), Value::String(summary));
    }
    if let Some(updated_at) = read_finite_f64(state.get("reasoningStopUpdatedAt")) {
        set_i64(&mut out, "reasoningStopUpdatedAt", to_i64_floor(updated_at));
    }
    out
}

fn ensure_stop_message_mode_max_repeats(state: &mut Map<String, Value>) {
    let mode = normalize_stage_mode(state.get("stopMessageStageMode"));
    if mode.as_deref() != Some("on") && mode.as_deref() != Some("auto") {
        return;
    }
    if let Some(max_repeats_raw) = read_finite_f64(state.get("stopMessageMaxRepeats")) {
        let normalized = to_i64_floor(max_repeats_raw);
        if normalized > 0 {
            set_i64(state, "stopMessageMaxRepeats", normalized);
            return;
        }
    }
    set_i64(
        state,
        "stopMessageMaxRepeats",
        DEFAULT_STOP_MESSAGE_MAX_REPEATS,
    );
}

fn deserialize_stop_message_state_maps(data: &Map<String, Value>, state: &mut Map<String, Value>) {
    if let Some(source) = read_trimmed_string(data.get("stopMessageSource")) {
        state.insert("stopMessageSource".to_string(), Value::String(source));
    }

    if let Some(raw_text) = data.get("stopMessageText").and_then(|v| v.as_str()) {
        if !raw_text.trim().is_empty() {
            state.insert(
                "stopMessageText".to_string(),
                Value::String(raw_text.to_string()),
            );
        }
    }

    let has_persisted_max_repeats = read_finite_f64(data.get("stopMessageMaxRepeats")).is_some();
    if let Some(max_repeats_raw) = read_finite_f64(data.get("stopMessageMaxRepeats")) {
        set_i64(
            state,
            "stopMessageMaxRepeats",
            to_i64_floor(max_repeats_raw),
        );
    }
    if let Some(used_raw) = read_finite_f64(data.get("stopMessageUsed")) {
        set_i64(state, "stopMessageUsed", to_i64_floor(used_raw).max(0));
    }
    if let Some(updated_at_raw) = read_finite_f64(data.get("stopMessageUpdatedAt")) {
        set_i64(state, "stopMessageUpdatedAt", to_i64_floor(updated_at_raw));
    }
    if let Some(last_used_at_raw) = read_finite_f64(data.get("stopMessageLastUsedAt")) {
        set_i64(
            state,
            "stopMessageLastUsedAt",
            to_i64_floor(last_used_at_raw),
        );
    }
    if let Some(mode) = normalize_stage_mode(data.get("stopMessageStageMode")) {
        state.insert("stopMessageStageMode".to_string(), Value::String(mode));
    }
    if let Some(ai_mode) = normalize_ai_mode(data.get("stopMessageAiMode")) {
        state.insert("stopMessageAiMode".to_string(), Value::String(ai_mode));
    }
    if let Some(seed_prompt) = read_trimmed_string(data.get("stopMessageAiSeedPrompt")) {
        state.insert(
            "stopMessageAiSeedPrompt".to_string(),
            Value::String(seed_prompt),
        );
    }
    let history = normalize_ai_history_entries(data.get("stopMessageAiHistory"));
    if !history.is_empty() {
        state.insert("stopMessageAiHistory".to_string(), Value::Array(history));
    }
    if let Some(armed) = read_bool(data.get("reasoningStopArmed")) {
        state.insert("reasoningStopArmed".to_string(), Value::Bool(armed));
    }
    if let Some(summary) = read_trimmed_string(data.get("reasoningStopSummary")) {
        state.insert("reasoningStopSummary".to_string(), Value::String(summary));
    }
    if let Some(updated_at_raw) = read_finite_f64(data.get("reasoningStopUpdatedAt")) {
        set_i64(state, "reasoningStopUpdatedAt", to_i64_floor(updated_at_raw).max(0));
    }
    if !has_persisted_max_repeats {
        ensure_stop_message_mode_max_repeats(state);
    }
}

#[napi]
pub fn serialize_stop_message_state_json(state_json: String) -> NapiResult<String> {
    let parsed = serde_json::from_str::<Value>(&state_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let state = parsed.as_object().cloned().unwrap_or_default();
    let output = serialize_stop_message_state_from_map(&state);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn deserialize_stop_message_state_json(
    data_json: String,
    state_json: String,
) -> NapiResult<String> {
    let data_parsed = serde_json::from_str::<Value>(&data_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let mut state_parsed = serde_json::from_str::<Value>(&state_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let data = data_parsed.as_object().cloned().unwrap_or_default();
    let state = state_parsed
        .as_object_mut()
        .ok_or_else(|| napi::Error::from_reason("state must be an object".to_string()))?;
    deserialize_stop_message_state_maps(&data, state);
    let output = serialize_stop_message_state_from_map(state);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

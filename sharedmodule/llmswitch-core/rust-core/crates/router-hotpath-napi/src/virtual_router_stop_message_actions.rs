use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Number, Value};

const DEFAULT_STOP_MESSAGE_MAX_REPEATS: i64 = 10;

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

fn set_string(target: &mut Map<String, Value>, key: &str, value: String) {
    target.insert(key.to_string(), Value::String(value));
}

fn push_unset(unset: &mut Vec<&'static str>, key: &'static str) {
    if !unset.contains(&key) {
        unset.push(key);
    }
}

fn parse_json_object(input: &str, name: &str) -> NapiResult<Map<String, Value>> {
    let parsed = serde_json::from_str::<Value>(input)
        .map_err(|e| napi::Error::from_reason(format!("{} parse failed: {}", name, e)))?;
    Ok(parsed.as_object().cloned().unwrap_or_default())
}

fn make_result(
    applied: bool,
    set: Map<String, Value>,
    unset: Vec<&'static str>,
) -> NapiResult<String> {
    let mut payload = Map::<String, Value>::new();
    payload.insert("applied".to_string(), Value::Bool(applied));
    payload.insert("set".to_string(), Value::Object(set));
    payload.insert(
        "unset".to_string(),
        Value::Array(
            unset
                .into_iter()
                .map(|key| Value::String(key.to_string()))
                .collect(),
        ),
    );
    serde_json::to_string(&payload).map_err(|e| napi::Error::from_reason(e.to_string()))
}

fn apply_stop_message_set(
    instruction: &Map<String, Value>,
    state: &Map<String, Value>,
    now_ms: i64,
) -> NapiResult<String> {
    let text = read_trimmed_string(instruction.get("stopMessageText"));
    let max_repeats = read_finite_f64(instruction.get("stopMessageMaxRepeats"))
        .map(to_i64_floor)
        .unwrap_or(0);

    if text.as_deref().unwrap_or("").is_empty() || max_repeats <= 0 {
        return make_result(true, Map::new(), Vec::new());
    }

    let text_value = text.unwrap_or_default();
    let incoming_mode = normalize_stage_mode(instruction.get("stopMessageStageMode"));
    let current_mode = normalize_stage_mode(state.get("stopMessageStageMode"));
    let target_mode = incoming_mode.unwrap_or_else(|| match current_mode.as_deref() {
        Some("off") | None => "on".to_string(),
        Some(mode) => mode.to_string(),
    });

    let incoming_ai_mode = normalize_ai_mode(instruction.get("stopMessageAiMode"));
    let current_ai_mode =
        normalize_ai_mode(state.get("stopMessageAiMode")).unwrap_or_else(|| "off".to_string());
    let target_ai_mode = incoming_ai_mode.unwrap_or_else(|| "off".to_string());

    let same_text = read_trimmed_string(state.get("stopMessageText"))
        .map(|v| v == text_value)
        .unwrap_or(false);
    let same_max = read_finite_f64(state.get("stopMessageMaxRepeats"))
        .map(|v| to_i64_floor(v) == max_repeats)
        .unwrap_or(false);
    let same_mode = current_mode.as_deref() == Some(target_mode.as_str());
    let same_ai_mode = current_ai_mode == target_ai_mode;
    let is_same_instruction = same_text && same_max && same_mode && same_ai_mode;

    let used = read_finite_f64(state.get("stopMessageUsed"))
        .map(|v| to_i64_floor(v).max(0))
        .unwrap_or(0);
    let has_last_used_at = read_finite_f64(state.get("stopMessageLastUsedAt")).is_some();
    let _should_rearm = !is_same_instruction || used > 0 || has_last_used_at;

    let from_historical = instruction
        .get("fromHistoricalUserMessage")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    // Historical user markers are replay context only; they must not mutate current
    // runtime state (otherwise exhausted stopMessage can be re-armed on every turn).
    if from_historical && !is_same_instruction {
        return make_result(true, Map::new(), Vec::new());
    }
    let should_rearm_for_source = !from_historical;

    let explicit_source = read_trimmed_string(instruction.get("stopMessageSource"))
        .unwrap_or_else(|| "explicit_text".to_string());

    let mut set = Map::<String, Value>::new();
    let mut unset = Vec::<&'static str>::new();

    set_string(&mut set, "stopMessageText", text_value);
    set_i64(&mut set, "stopMessageMaxRepeats", max_repeats);
    set_string(&mut set, "stopMessageSource", explicit_source);
    set_string(&mut set, "stopMessageStageMode", target_mode);
    set_string(&mut set, "stopMessageAiMode", target_ai_mode);

    if should_rearm_for_source {
        set_i64(&mut set, "stopMessageUsed", 0);
        set_i64(&mut set, "stopMessageUpdatedAt", now_ms);
        push_unset(&mut unset, "stopMessageLastUsedAt");
        push_unset(&mut unset, "stopMessageAiSeedPrompt");
        push_unset(&mut unset, "stopMessageAiHistory");
    }

    make_result(true, set, unset)
}

fn apply_stop_message_mode(
    instruction: &Map<String, Value>,
    state: &Map<String, Value>,
    now_ms: i64,
) -> NapiResult<String> {
    let mode = normalize_stage_mode(instruction.get("stopMessageStageMode"));
    if mode.is_none() {
        return make_result(true, Map::new(), Vec::new());
    }
    let mode_value = mode.unwrap_or_default();

    if mode_value == "off" {
        let mut set = Map::<String, Value>::new();
        set_string(&mut set, "stopMessageStageMode", "off".to_string());
        set_i64(&mut set, "stopMessageUpdatedAt", now_ms);
        return make_result(true, set, Vec::new());
    }

    let explicit_max = read_finite_f64(instruction.get("stopMessageMaxRepeats")).map(to_i64_floor);
    let preserved_max = read_finite_f64(state.get("stopMessageMaxRepeats")).map(to_i64_floor);

    let resolved_max = match explicit_max {
        Some(v) if v > 0 => v,
        _ => match preserved_max {
            Some(v) if v > 0 => v,
            _ => DEFAULT_STOP_MESSAGE_MAX_REPEATS,
        },
    };

    let mut set = Map::<String, Value>::new();
    set_string(&mut set, "stopMessageStageMode", mode_value);
    set_string(&mut set, "stopMessageSource", "explicit".to_string());
    set_i64(&mut set, "stopMessageMaxRepeats", resolved_max);

    make_result(true, set, Vec::new())
}

fn apply_stop_message_clear(now_ms: i64) -> NapiResult<String> {
    let mut set = Map::<String, Value>::new();
    let mut unset = Vec::<&'static str>::new();

    set_i64(&mut set, "stopMessageUpdatedAt", now_ms);

    push_unset(&mut unset, "stopMessageText");
    push_unset(&mut unset, "stopMessageMaxRepeats");
    push_unset(&mut unset, "stopMessageUsed");
    push_unset(&mut unset, "stopMessageSource");
    push_unset(&mut unset, "stopMessageLastUsedAt");
    push_unset(&mut unset, "stopMessageStageMode");
    push_unset(&mut unset, "stopMessageAiMode");
    push_unset(&mut unset, "stopMessageAiSeedPrompt");
    push_unset(&mut unset, "stopMessageAiHistory");

    make_result(true, set, unset)
}

#[napi]
pub fn apply_stop_message_instruction_json(
    instruction_json: String,
    state_json: String,
    now_ms: i64,
) -> NapiResult<String> {
    let instruction = parse_json_object(&instruction_json, "instruction")?;
    let state = parse_json_object(&state_json, "state")?;

    let instruction_type = instruction
        .get("type")
        .and_then(|v| v.as_str())
        .unwrap_or_default();

    match instruction_type {
        "stopMessageSet" => apply_stop_message_set(&instruction, &state, now_ms),
        "stopMessageMode" => apply_stop_message_mode(&instruction, &state, now_ms),
        "stopMessageClear" => apply_stop_message_clear(now_ms),
        _ => make_result(false, Map::new(), Vec::new()),
    }
}

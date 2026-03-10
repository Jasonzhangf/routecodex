use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GuardedClockScheduleItemOutput {
    due_at_ms: i64,
    set_by: String,
    task: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    recurrence: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    not_before_request_id: Option<String>,
}

fn read_i64(value: Option<&Value>) -> Option<i64> {
    if let Some(v) = value.and_then(|v| v.as_i64()) {
        return Some(v);
    }
    if let Some(v) = value.and_then(|v| v.as_u64()) {
        return i64::try_from(v).ok();
    }
    if let Some(v) = value.and_then(|v| v.as_f64()) {
        if v.is_finite() {
            return Some(v.floor() as i64);
        }
    }
    None
}

fn build_guarded_clock_schedule_item(
    marker: Value,
    request_id: String,
    due_window_ms: f64,
    now_ms: f64,
) -> Option<GuardedClockScheduleItemOutput> {
    let marker_obj = marker.as_object()?;
    let due_at_ms = read_i64(marker_obj.get("dueAtMs"))?;
    let task = marker_obj
        .get("task")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if task.is_empty() {
        return None;
    }
    let recurrence = marker_obj
        .get("recurrence")
        .cloned()
        .filter(|v| !v.is_null());
    let due_window = if due_window_ms.is_finite() {
        due_window_ms.max(0.0)
    } else {
        0.0
    };
    let now = if now_ms.is_finite() { now_ms } else { 0.0 };
    let should_guard = (due_at_ms as f64) <= now + due_window;

    Some(GuardedClockScheduleItemOutput {
        due_at_ms,
        set_by: "user".to_string(),
        task,
        recurrence,
        not_before_request_id: if should_guard { Some(request_id) } else { None },
    })
}

fn normalize_due_inject_text(value: Value) -> String {
    value.as_str().unwrap_or("").trim().to_string()
}

fn should_reserve_clock_due_reminder(had_clear: bool, session_id: String) -> bool {
    if had_clear {
        return false;
    }
    !session_id.trim().is_empty()
}

#[napi]
pub fn build_guarded_clock_schedule_item_json(
    marker_json: String,
    request_id: String,
    due_window_ms: f64,
    now_ms: f64,
) -> NapiResult<String> {
    let marker: Value =
        serde_json::from_str(&marker_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = build_guarded_clock_schedule_item(marker, request_id, due_window_ms, now_ms)
        .map(|v| serde_json::to_value(v).unwrap_or(Value::Null))
        .unwrap_or(Value::Null);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn normalize_due_inject_text_json(value_json: String) -> NapiResult<String> {
    let value: Value =
        serde_json::from_str(&value_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    serde_json::to_string(&Value::String(normalize_due_inject_text(value)))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn should_reserve_clock_due_reminder_json(
    had_clear: bool,
    session_id: String,
) -> NapiResult<bool> {
    Ok(should_reserve_clock_due_reminder(had_clear, session_id))
}

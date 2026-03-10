use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{Map, Value};
use std::sync::atomic::{AtomicU64, Ordering};

static CLOCK_MARKER_CALL_SEQ: AtomicU64 = AtomicU64::new(0);

fn sanitize_request_token(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "req".to_string()
    } else {
        trimmed
    }
}

fn build_clock_marker_call_id(request_id: String, marker_index: i64) -> String {
    let seq = CLOCK_MARKER_CALL_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let token = sanitize_request_token(request_id.trim());
    format!("call_clock_marker_{}_{}_{}", token, marker_index + 1, seq)
}

fn find_last_user_message_index(messages: &[Value]) -> i64 {
    if messages.is_empty() {
        return -1;
    }
    for idx in (0..messages.len()).rev() {
        if messages[idx]
            .as_object()
            .and_then(|obj| obj.get("role"))
            .and_then(|v| v.as_str())
            .map(|v| v == "user")
            .unwrap_or(false)
        {
            return idx as i64;
        }
    }
    -1
}

fn normalize_time_tag_line(time_tag_line: String) -> String {
    time_tag_line.trim().to_string()
}

fn inject_time_tag_into_messages(messages: Value, time_tag_line: String) -> Value {
    let mut rows = match messages {
        Value::Array(values) => values,
        _ => Vec::new(),
    };
    let line = normalize_time_tag_line(time_tag_line);
    if line.is_empty() {
        return Value::Array(rows);
    }

    let idx = find_last_user_message_index(rows.as_slice());
    if idx < 0 {
        let mut user = Map::new();
        user.insert("role".to_string(), Value::String("user".to_string()));
        user.insert("content".to_string(), Value::String(line));
        rows.push(Value::Object(user));
        return Value::Array(rows);
    }

    let row = match rows.get_mut(idx as usize).and_then(|v| v.as_object_mut()) {
        Some(v) => v,
        None => return Value::Array(rows),
    };

    match row.get("content") {
        Some(Value::String(text)) => {
            let base = text.trim_end().to_string();
            let next = if base.is_empty() {
                line
            } else {
                format!("{}\n{}", base, line)
            };
            row.insert("content".to_string(), Value::String(next));
        }
        Some(Value::Array(parts)) => {
            let mut next_parts = parts.clone();
            next_parts.push(Value::String(line));
            row.insert("content".to_string(), Value::Array(next_parts));
        }
        _ => {
            row.insert("content".to_string(), Value::String(line));
        }
    }

    Value::Array(rows)
}

fn build_clock_marker_schedule_messages(
    request_id: String,
    marker_index: i64,
    marker: Value,
    payload: Value,
) -> Value {
    let marker_obj = match marker.as_object() {
        Some(v) => v,
        None => return Value::Array(Vec::new()),
    };

    let due_at = marker_obj
        .get("dueAt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let task = marker_obj
        .get("task")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if due_at.is_empty() || task.is_empty() {
        return Value::Array(Vec::new());
    }

    let call_id = build_clock_marker_call_id(request_id, marker_index);

    let mut item = Map::new();
    item.insert("dueAt".to_string(), Value::String(due_at));
    item.insert("task".to_string(), Value::String(task));
    if let Some(recurrence) = marker_obj.get("recurrence") {
        if !recurrence.is_null() {
            item.insert("recurrence".to_string(), recurrence.clone());
        }
    }

    let mut args = Map::new();
    args.insert("action".to_string(), Value::String("schedule".to_string()));
    args.insert("items".to_string(), Value::Array(vec![Value::Object(item)]));

    let mut function_call = Map::new();
    function_call.insert("name".to_string(), Value::String("clock".to_string()));
    function_call.insert(
        "arguments".to_string(),
        Value::String(
            serde_json::to_string(&Value::Object(args)).unwrap_or_else(|_| "{}".to_string()),
        ),
    );

    let mut tool_call = Map::new();
    tool_call.insert("id".to_string(), Value::String(call_id.clone()));
    tool_call.insert("type".to_string(), Value::String("function".to_string()));
    tool_call.insert("function".to_string(), Value::Object(function_call));

    let mut assistant = Map::new();
    assistant.insert("role".to_string(), Value::String("assistant".to_string()));
    assistant.insert("content".to_string(), Value::Null);
    assistant.insert(
        "tool_calls".to_string(),
        Value::Array(vec![Value::Object(tool_call)]),
    );

    let mut tool = Map::new();
    tool.insert("role".to_string(), Value::String("tool".to_string()));
    tool.insert("tool_call_id".to_string(), Value::String(call_id));
    tool.insert("name".to_string(), Value::String("clock".to_string()));
    tool.insert(
        "content".to_string(),
        Value::String(serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string())),
    );

    Value::Array(vec![Value::Object(assistant), Value::Object(tool)])
}

fn build_due_reminder_user_message(reservation: Value, due_inject_text: String) -> Value {
    if reservation.is_null() || due_inject_text.is_empty() {
        return Value::Null;
    }
    let mut out = Map::new();
    out.insert("role".to_string(), Value::String("user".to_string()));
    out.insert(
    "content".to_string(),
    Value::String(
      [
        "[Clock Reminder]: scheduled tasks are due.",
        due_inject_text.as_str(),
        "You may call tools to complete these tasks. If the tool list is incomplete, standard tools have been injected. MANDATORY: if waiting is needed, use the clock tool to schedule wake-up (clock.schedule) now; do not only promise to wait.",
      ]
      .join("\n"),
    ),
  );
    Value::Object(out)
}

fn build_clock_reminder_metadata(
    next_request_metadata: Value,
    metadata: Value,
    has_due_user_message: bool,
    reservation: Value,
) -> Value {
    let mut base = match next_request_metadata {
        Value::Object(row) => row,
        _ => {
            let mut row = Map::new();
            let original = metadata
                .as_object()
                .and_then(|obj| obj.get("originalEndpoint"))
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .unwrap_or("/v1/chat/completions".to_string());
            row.insert("originalEndpoint".to_string(), Value::String(original));
            row
        }
    };

    if !has_due_user_message || reservation.is_null() {
        return Value::Object(base);
    }

    base.insert("__clockReservation".to_string(), reservation);
    Value::Object(base)
}

fn build_clock_reminder_messages(
    base_messages: Value,
    marker_tool_messages: Value,
    due_user_message: Value,
    time_tag_line: String,
) -> Value {
    let mut rows = match base_messages {
        Value::Array(values) => values,
        _ => Vec::new(),
    };

    if let Value::Array(markers) = marker_tool_messages {
        for row in markers {
            rows.push(row);
        }
    }

    if !due_user_message.is_null() {
        rows.push(due_user_message);
    }

    inject_time_tag_into_messages(Value::Array(rows), time_tag_line)
}

#[napi]
pub fn build_clock_marker_schedule_messages_json(
    request_id: String,
    marker_index: i64,
    marker_json: String,
    payload_json: String,
) -> NapiResult<String> {
    let marker: Value =
        serde_json::from_str(&marker_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = build_clock_marker_schedule_messages(request_id, marker_index, marker, payload);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn find_last_user_message_index_json(messages_json: String) -> NapiResult<String> {
    let messages: Value = serde_json::from_str(&messages_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let index = messages
        .as_array()
        .map(|rows| find_last_user_message_index(rows.as_slice()))
        .unwrap_or(-1);
    serde_json::to_string(&index).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn inject_time_tag_into_messages_json(
    messages_json: String,
    time_tag_line: String,
) -> NapiResult<String> {
    let messages: Value = serde_json::from_str(&messages_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = inject_time_tag_into_messages(messages, time_tag_line);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn build_due_reminder_user_message_json(
    reservation_json: String,
    due_inject_text: String,
) -> NapiResult<String> {
    let reservation: Value = serde_json::from_str(&reservation_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = build_due_reminder_user_message(reservation, due_inject_text);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn build_clock_reminder_metadata_json(
    next_request_metadata_json: String,
    metadata_json: String,
    has_due_user_message: bool,
    reservation_json: String,
) -> NapiResult<String> {
    let next_request_metadata: Value = serde_json::from_str(&next_request_metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let reservation: Value = serde_json::from_str(&reservation_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = build_clock_reminder_metadata(
        next_request_metadata,
        metadata,
        has_due_user_message,
        reservation,
    );
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn build_clock_reminder_messages_json(
    base_messages_json: String,
    marker_tool_messages_json: String,
    due_user_message_json: String,
    time_tag_line: String,
) -> NapiResult<String> {
    let base_messages: Value = serde_json::from_str(&base_messages_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let marker_tool_messages: Value = serde_json::from_str(&marker_tool_messages_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let due_user_message: Value = serde_json::from_str(&due_user_message_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = build_clock_reminder_messages(
        base_messages,
        marker_tool_messages,
        due_user_message,
        time_tag_line,
    );
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

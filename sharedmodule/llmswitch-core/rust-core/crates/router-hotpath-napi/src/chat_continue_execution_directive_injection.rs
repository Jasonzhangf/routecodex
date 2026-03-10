use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::Serialize;
use serde_json::{Map, Value};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContinueExecutionDirectiveInjectionOutput {
    changed: bool,
    messages: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GovernedMergePlanOutput {
    has_messages_override: bool,
    messages: Value,
    parameters_patch: Value,
    has_tool_choice: bool,
    tool_choice: Value,
    has_provider_stream: bool,
    provider_stream: bool,
    governed_tools: bool,
    governance_timestamp: i64,
    original_stream: bool,
    stream: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GovernedControlPlanOutput {
    apply_inbound_stream_metadata: bool,
    inbound_stream: bool,
    apply_outbound_stream_parameter: bool,
    outbound_stream: bool,
    apply_tool_choice_parameter: bool,
    tool_choice: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
}

fn message_content_contains_token(content: &Value, token: &str) -> bool {
    if token.trim().is_empty() {
        return false;
    }
    if let Some(raw) = content.as_str() {
        return raw.contains(token);
    }
    let parts = match content.as_array() {
        Some(v) => v,
        None => return false,
    };
    for part in parts {
        let obj = match part.as_object() {
            Some(v) => v,
            None => continue,
        };
        if let Some(text) = obj.get("text").and_then(|v| v.as_str()) {
            if text.contains(token) {
                return true;
            }
        }
    }
    false
}

fn has_continue_execution_directive(messages: &[Value], marker: &str, target_text: &str) -> bool {
    for message in messages {
        let obj = match message.as_object() {
            Some(v) => v,
            None => continue,
        };
        if obj
            .get("role")
            .and_then(|v| v.as_str())
            .map(|v| v == "user")
            .unwrap_or(false)
            == false
        {
            continue;
        }
        let content = match obj.get("content") {
            Some(v) => v,
            None => continue,
        };
        if message_content_contains_token(content, marker)
            || message_content_contains_token(content, target_text)
        {
            return true;
        }
    }
    false
}

fn build_continue_execution_directive(marker: &str, target_text: &str) -> String {
    let marker = marker.trim();
    let target_text = target_text.trim();
    if marker.is_empty() {
        return target_text.to_string();
    }
    if target_text.is_empty() {
        return marker.to_string();
    }
    format!("{}\n{}", marker, target_text)
}

fn inject_continue_execution_directive(
    messages: Value,
    marker: String,
    target_text: String,
) -> ContinueExecutionDirectiveInjectionOutput {
    let marker = marker.trim().to_string();
    let target_text = target_text.trim().to_string();
    let directive = build_continue_execution_directive(marker.as_str(), target_text.as_str());
    if directive.is_empty() {
        return ContinueExecutionDirectiveInjectionOutput {
            changed: false,
            messages,
        };
    }

    let mut rows = match messages {
        Value::Array(values) => values,
        other => {
            return ContinueExecutionDirectiveInjectionOutput {
                changed: false,
                messages: other,
            }
        }
    };
    if rows.is_empty()
        || has_continue_execution_directive(rows.as_slice(), marker.as_str(), target_text.as_str())
    {
        return ContinueExecutionDirectiveInjectionOutput {
            changed: false,
            messages: Value::Array(rows),
        };
    }

    let last_user_index = rows.iter().enumerate().rev().find_map(|(idx, message)| {
        message
            .as_object()
            .and_then(|obj| obj.get("role"))
            .and_then(|v| v.as_str())
            .filter(|v| *v == "user")
            .map(|_| idx)
    });
    let last_user_index = match last_user_index {
        Some(v) => v,
        None => {
            return ContinueExecutionDirectiveInjectionOutput {
                changed: false,
                messages: Value::Array(rows),
            }
        }
    };

    let message = match rows.get_mut(last_user_index) {
        Some(v) => v,
        None => {
            return ContinueExecutionDirectiveInjectionOutput {
                changed: false,
                messages: Value::Array(rows),
            }
        }
    };
    let row = match message.as_object_mut() {
        Some(v) => v,
        None => {
            return ContinueExecutionDirectiveInjectionOutput {
                changed: false,
                messages: Value::Array(rows),
            }
        }
    };

    match row.get("content") {
        Some(Value::String(text)) => {
            let base = text.trim_end().to_string();
            let next = if base.is_empty() {
                directive
            } else {
                format!("{}\n\n{}", base, directive)
            };
            row.insert("content".to_string(), Value::String(next));
        }
        Some(Value::Array(parts)) => {
            let mut next_parts = parts.clone();
            let mut updated = false;
            for idx in (0..next_parts.len()).rev() {
                let part = match next_parts.get_mut(idx) {
                    Some(v) => v,
                    None => continue,
                };
                let part_obj = match part.as_object_mut() {
                    Some(v) => v,
                    None => continue,
                };
                let text = match part_obj.get("text").and_then(|v| v.as_str()) {
                    Some(v) => v,
                    None => continue,
                };
                let base = text.trim_end().to_string();
                let next_text = if base.is_empty() {
                    directive.clone()
                } else {
                    format!("{}\n\n{}", base, directive)
                };
                part_obj.insert("text".to_string(), Value::String(next_text));
                updated = true;
                break;
            }
            if !updated {
                let mut part_obj = Map::new();
                part_obj.insert("type".to_string(), Value::String("input_text".to_string()));
                part_obj.insert("text".to_string(), Value::String(directive));
                next_parts.push(Value::Object(part_obj));
            }
            row.insert("content".to_string(), Value::Array(next_parts));
        }
        _ => {
            row.insert("content".to_string(), Value::String(directive));
        }
    }

    ContinueExecutionDirectiveInjectionOutput {
        changed: true,
        messages: Value::Array(rows),
    }
}

fn current_time_millis() -> i64 {
    let now = SystemTime::now();
    match now.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as i64,
        Err(_) => 0,
    }
}

fn normalize_governance_timestamp(raw: f64) -> i64 {
    if raw.is_finite() && raw > 0.0 {
        return raw.floor() as i64;
    }
    current_time_millis()
}

fn resolve_trimmed_model(governed_obj: &Map<String, Value>) -> Option<String> {
    let model = governed_obj
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if model.is_empty() {
        return None;
    }
    Some(model)
}

fn resolve_governed_tool_choice(governed_obj: &Map<String, Value>) -> (bool, Value) {
    let raw = match governed_obj.get("tool_choice") {
        Some(v) => v,
        None => return (false, Value::Null),
    };
    match raw {
        Value::String(_) | Value::Object(_) => (true, raw.clone()),
        _ => (false, Value::Null),
    }
}

fn resolve_governed_stream(governed_obj: &Map<String, Value>) -> (bool, bool) {
    let value = match governed_obj.get("stream") {
        Some(v) => v,
        None => return (false, false),
    };
    match value {
        Value::Bool(flag) => (true, *flag),
        _ => (false, false),
    }
}

fn resolve_governed_messages(governed_obj: &Map<String, Value>) -> (bool, Value) {
    let value = match governed_obj.get("messages") {
        Some(v) => v,
        None => return (false, Value::Null),
    };
    match value {
        Value::Array(rows) => (true, Value::Array(rows.clone())),
        _ => (false, Value::Null),
    }
}

fn resolve_governed_parameters_patch(governed_obj: &Map<String, Value>) -> Value {
    match governed_obj.get("parameters") {
        Some(Value::Object(row)) => Value::Object(row.clone()),
        _ => Value::Object(Map::new()),
    }
}

fn resolve_governed_tools_flag(governed_obj: &Map<String, Value>) -> bool {
    governed_obj.contains_key("tools")
}

fn resolve_governed_control_plan(
    governed: Value,
    inbound_stream_intent: bool,
) -> GovernedControlPlanOutput {
    let empty = Map::new();
    let governed_obj = governed.as_object().unwrap_or(&empty);
    let (apply_outbound_stream_parameter, outbound_stream) = resolve_governed_stream(governed_obj);
    let apply_tool_choice_parameter = governed_obj.contains_key("tool_choice");
    let tool_choice = governed_obj
        .get("tool_choice")
        .cloned()
        .unwrap_or(Value::Null);
    let model = resolve_trimmed_model(governed_obj);

    GovernedControlPlanOutput {
        apply_inbound_stream_metadata: true,
        inbound_stream: inbound_stream_intent,
        apply_outbound_stream_parameter,
        outbound_stream,
        apply_tool_choice_parameter,
        tool_choice,
        model,
    }
}

fn resolve_governed_merge_plan(
    governed: Value,
    inbound_stream_intent: bool,
    governance_timestamp_ms: f64,
) -> GovernedMergePlanOutput {
    let empty = Map::new();
    let governed_obj = governed.as_object().unwrap_or(&empty);
    let (has_messages_override, messages) = resolve_governed_messages(governed_obj);
    let parameters_patch = resolve_governed_parameters_patch(governed_obj);
    let (has_tool_choice, tool_choice) = resolve_governed_tool_choice(governed_obj);
    let (has_provider_stream, provider_stream) = resolve_governed_stream(governed_obj);
    let governed_tools = resolve_governed_tools_flag(governed_obj);
    let governance_timestamp = normalize_governance_timestamp(governance_timestamp_ms);

    GovernedMergePlanOutput {
        has_messages_override,
        messages,
        parameters_patch,
        has_tool_choice,
        tool_choice,
        has_provider_stream,
        provider_stream,
        governed_tools,
        governance_timestamp,
        original_stream: inbound_stream_intent,
        stream: inbound_stream_intent,
    }
}

fn apply_governed_control_operations(
    request: Value,
    governed: Value,
    inbound_stream_intent: bool,
) -> Value {
    let plan = resolve_governed_control_plan(governed, inbound_stream_intent);
    let mut request_obj = request.as_object().cloned().unwrap_or_else(Map::new);

    if plan.apply_inbound_stream_metadata {
        let mut metadata = request_obj
            .remove("metadata")
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_else(Map::new);
        metadata.insert(
            "inboundStream".to_string(),
            Value::Bool(plan.inbound_stream),
        );
        request_obj.insert("metadata".to_string(), Value::Object(metadata));
    }

    if plan.apply_outbound_stream_parameter || plan.apply_tool_choice_parameter {
        let mut parameters = request_obj
            .remove("parameters")
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_else(Map::new);
        if plan.apply_outbound_stream_parameter {
            parameters.insert("stream".to_string(), Value::Bool(plan.outbound_stream));
        }
        if plan.apply_tool_choice_parameter {
            parameters.insert("tool_choice".to_string(), plan.tool_choice);
        }
        request_obj.insert("parameters".to_string(), Value::Object(parameters));
    }

    if let Some(model) = plan.model {
        let trimmed = model.trim().to_string();
        if !trimmed.is_empty() {
            request_obj.insert("model".to_string(), Value::String(trimmed));
        }
    }

    Value::Object(request_obj)
}

fn apply_governed_merge_request(
    request: Value,
    governed: Value,
    inbound_stream_intent: bool,
    governance_timestamp_ms: f64,
) -> Value {
    let plan =
        resolve_governed_merge_plan(governed, inbound_stream_intent, governance_timestamp_ms);
    let GovernedMergePlanOutput {
        has_messages_override,
        messages,
        parameters_patch,
        has_tool_choice,
        tool_choice,
        has_provider_stream,
        provider_stream,
        governed_tools,
        governance_timestamp,
        original_stream,
        stream,
    } = plan;

    let mut request_obj = request.as_object().cloned().unwrap_or_else(Map::new);

    if has_messages_override {
        request_obj.insert("messages".to_string(), messages);
    }

    let mut parameters = request_obj
        .remove("parameters")
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_else(Map::new);
    if let Value::Object(patch) = parameters_patch {
        for (key, value) in patch {
            parameters.insert(key, value);
        }
    }
    request_obj.insert("parameters".to_string(), Value::Object(parameters));

    let mut metadata = request_obj
        .remove("metadata")
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_else(Map::new);
    if has_tool_choice {
        metadata.insert("toolChoice".to_string(), tool_choice);
    } else {
        metadata.remove("toolChoice");
    }
    metadata.insert("originalStream".to_string(), Value::Bool(original_stream));
    metadata.insert("stream".to_string(), Value::Bool(stream));
    if has_provider_stream {
        metadata.insert("providerStream".to_string(), Value::Bool(provider_stream));
    } else {
        metadata.remove("providerStream");
    }
    metadata.insert("governedTools".to_string(), Value::Bool(governed_tools));
    metadata.insert(
        "governanceTimestamp".to_string(),
        Value::from(governance_timestamp),
    );
    request_obj.insert("metadata".to_string(), Value::Object(metadata));

    Value::Object(request_obj)
}

#[napi]
pub fn inject_continue_execution_directive_json(
    messages_json: String,
    marker: String,
    target_text: String,
) -> NapiResult<String> {
    let messages: Value = serde_json::from_str(&messages_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = inject_continue_execution_directive(messages, marker, target_text);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn apply_governed_control_operations_json(
    request_json: String,
    governed_json: String,
    inbound_stream_intent: bool,
) -> NapiResult<String> {
    let request: Value =
        serde_json::from_str(&request_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let governed: Value = serde_json::from_str(&governed_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = apply_governed_control_operations(request, governed, inbound_stream_intent);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn apply_governed_merge_request_json(
    request_json: String,
    governed_json: String,
    inbound_stream_intent: bool,
    governance_timestamp_ms: f64,
) -> NapiResult<String> {
    let request: Value =
        serde_json::from_str(&request_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let governed: Value = serde_json::from_str(&governed_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = apply_governed_merge_request(
        request,
        governed,
        inbound_stream_intent,
        governance_timestamp_ms,
    );
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

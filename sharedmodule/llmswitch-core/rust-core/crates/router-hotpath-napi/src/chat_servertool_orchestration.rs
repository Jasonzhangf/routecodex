use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::chat_web_search_intent::analyze_chat_web_search_intent;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatWebSearchPlanOutput {
    should_inject: bool,
    selected_engine_indexes: Vec<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatClockPlanOutput {
    should_inject: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatContinueExecutionPlanOutput {
    should_inject: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatServerToolBundlePlanOutput {
    web_search: ChatWebSearchPlanOutput,
    clock: ChatClockPlanOutput,
    continue_execution: ChatContinueExecutionPlanOutput,
}

fn detect_provider_response_shape(payload: &Value) -> &'static str {
    let row = match payload.as_object() {
        Some(v) => v,
        None => return "unknown",
    };
    if row.get("choices").map(|v| v.is_array()).unwrap_or(false) {
        return "openai-chat";
    }
    let object_is_response = row
        .get("object")
        .and_then(|v| v.as_str())
        .map(|v| v == "response")
        .unwrap_or(false);
    if object_is_response || row.get("output").map(|v| v.is_array()).unwrap_or(false) {
        return "openai-responses";
    }
    if row.get("content").map(|v| v.is_array()).unwrap_or(false)
        || row.get("stop_reason").and_then(|v| v.as_str()).is_some()
    {
        return "anthropic-messages";
    }
    if row.get("candidates").map(|v| v.is_array()).unwrap_or(false) {
        return "gemini-chat";
    }
    "unknown"
}

fn is_canonical_chat_completion_payload(payload: &Value) -> bool {
    let row = match payload.as_object() {
        Some(v) => v,
        None => return false,
    };
    let choices = match row.get("choices").and_then(|v| v.as_array()) {
        Some(v) if !v.is_empty() => v,
        _ => return false,
    };
    let first = match choices.first().and_then(|v| v.as_object()) {
        Some(v) => v,
        None => return false,
    };
    first.get("message").and_then(|v| v.as_object()).is_some()
}

fn build_review_operations(_metadata: &Value) -> Value {
    Value::Array(Vec::new())
}

fn build_continue_execution_operations(should_inject: bool) -> Value {
    if !should_inject {
        return Value::Array(Vec::new());
    }

    let parameters = json!({
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    });
    let continue_tool = json!({
      "type": "function",
      "function": {
        "name": "continue_execution",
        "description": "No-op control tool for progress reporting without interrupting execution. Mandatory rule: if you are giving a progress-only update or are about to end_turn/stop, you MUST call continue_execution first (example arguments: {\"reason\":\"progress_update\"}). Required sequence: (1) call continue_execution, (2) provide a brief progress summary (<=5 lines), (3) immediately continue real actions. Do NOT emit finish_reason=stop/end_turn for progress-only updates. Only stop when the overall goal is actually complete. If waiting longer than 2 minutes is needed, use clock.schedule instead.",
        "parameters": parameters,
        "strict": true
      }
    });

    json!([
      {
        "op": "set_request_metadata_fields",
        "fields": { "continueExecutionEnabled": true }
      },
      {
        "op": "append_tool_if_missing",
        "toolName": "continue_execution",
        "tool": continue_tool
      }
    ])
}

fn is_stop_message_state_active(raw: &Value) -> bool {
    let record = match raw.as_object() {
        Some(v) => v,
        None => return false,
    };
    let text = record
        .get("stopMessageText")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    let max_repeats = record
        .get("stopMessageMaxRepeats")
        .and_then(|v| v.as_f64())
        .and_then(|v| {
            if v.is_finite() {
                Some(v.floor() as i64)
            } else {
                None
            }
        })
        .map(|v| if v < 1 { 1 } else { v })
        .unwrap_or(0);
    let stage_mode = record
        .get("stopMessageStageMode")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if stage_mode == "off" {
        return false;
    }
    max_repeats > 0 && (!text.is_empty() || stage_mode == "on")
}

fn resolve_has_active_stop_message_for_continue_execution(
    runtime_state: &Value,
    persisted_state: &Value,
) -> bool {
    is_stop_message_state_active(runtime_state) || is_stop_message_state_active(persisted_state)
}

fn resolve_stop_message_session_scope(metadata: &Value) -> Option<String> {
    let row = metadata.as_object()?;
    if let Some(session_id) = row.get("sessionId").and_then(|v| v.as_str()) {
        if !session_id.is_empty() {
            return Some(format!("session:{session_id}"));
        }
    }
    if let Some(conversation_id) = row.get("conversationId").and_then(|v| v.as_str()) {
        if !conversation_id.is_empty() {
            return Some(format!("conversation:{conversation_id}"));
        }
    }
    None
}

fn read_runtime_metadata_bool(runtime_metadata: &Value, key: &str) -> bool {
    runtime_metadata
        .as_object()
        .and_then(|obj| obj.get(key))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn read_runtime_metadata_object<'a>(
    runtime_metadata: &'a Value,
    key: &str,
) -> Option<&'a Map<String, Value>> {
    runtime_metadata
        .as_object()
        .and_then(|obj| obj.get(key))
        .and_then(|v| v.as_object())
}

fn read_trimmed_string(value: Option<&Value>) -> String {
    value
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .unwrap_or_default()
}

fn read_web_search_semantics(request: &Value) -> (bool, bool) {
    let hint = request
        .as_object()
        .and_then(|obj| obj.get("semantics"))
        .and_then(|semantics| semantics.as_object())
        .and_then(|semantics| semantics.get("providerExtras"))
        .and_then(|extras| extras.as_object())
        .and_then(|extras| extras.get("webSearch"));

    match hint {
        Some(Value::Bool(enabled)) => {
            if *enabled {
                (true, false)
            } else {
                (false, true)
            }
        }
        Some(Value::Object(row)) => {
            let force = row.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
            let disable = row
                .get("disable")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            (force, disable)
        }
        _ => (false, false),
    }
}

fn read_execution_mode(engine: &Map<String, Value>) -> String {
    let direct = engine
        .get("executionMode")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            engine
                .get("mode")
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_ascii_lowercase())
                .filter(|v| !v.is_empty())
        });
    match direct.as_deref() {
        Some("direct") => "direct".to_string(),
        _ => "servertool".to_string(),
    }
}

fn read_direct_activation(engine: &Map<String, Value>) -> String {
    let execution_mode = read_execution_mode(engine);
    let direct = engine
        .get("directActivation")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            engine
                .get("activation")
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_ascii_lowercase())
                .filter(|v| !v.is_empty())
        });
    match direct.as_deref() {
        Some("builtin") => "builtin".to_string(),
        Some("route") => "route".to_string(),
        _ if execution_mode == "direct" => "route".to_string(),
        _ => String::new(),
    }
}

fn is_servertool_web_search_engine(engine: &Map<String, Value>) -> bool {
    read_execution_mode(engine) == "servertool"
}

fn is_direct_route_web_search_engine(engine: &Map<String, Value>) -> bool {
    read_execution_mode(engine) == "direct" && read_direct_activation(engine) == "route"
}

fn should_bypass_servertool_web_search(
    intent_has: bool,
    intent_google_preferred: bool,
    semantics_force: bool,
    engines: &[(i64, Map<String, Value>)],
    runnable_engine_indexes: &[i64],
    direct_route_engine_indexes: &[i64],
) -> bool {
    if !intent_has || intent_google_preferred {
        return false;
    }
    if semantics_force {
        return false;
    }

    let first_direct_index = match direct_route_engine_indexes.first() {
        Some(v) => *v,
        None => return false,
    };
    let direct_engine = match engines
        .iter()
        .find(|(origin_index, _)| *origin_index == first_direct_index)
    {
        Some((_, v)) => v,
        None => return false,
    };
    let is_default = direct_engine
        .get("default")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if is_default {
        return true;
    }

    let selected_position = match runnable_engine_indexes
        .iter()
        .position(|idx| *idx == first_direct_index)
    {
        Some(v) => v,
        None => return false,
    };
    selected_position == 0
}

fn resolve_chat_web_search_plan(
    request: &Value,
    runtime_metadata: &Value,
) -> ChatWebSearchPlanOutput {
    if read_runtime_metadata_bool(runtime_metadata, "serverToolFollowup") {
        return ChatWebSearchPlanOutput {
            should_inject: false,
            selected_engine_indexes: Vec::new(),
        };
    }

    let raw_web_search = match read_runtime_metadata_object(runtime_metadata, "webSearch") {
        Some(v) => v,
        None => {
            return ChatWebSearchPlanOutput {
                should_inject: false,
                selected_engine_indexes: Vec::new(),
            }
        }
    };
    let engines = match raw_web_search.get("engines").and_then(|v| v.as_array()) {
        Some(v) if !v.is_empty() => v,
        _ => {
            return ChatWebSearchPlanOutput {
                should_inject: false,
                selected_engine_indexes: Vec::new(),
            }
        }
    };

    let (semantics_force, semantics_disable) = read_web_search_semantics(request);
    if semantics_disable {
        return ChatWebSearchPlanOutput {
            should_inject: false,
            selected_engine_indexes: Vec::new(),
        };
    }

    let inject_policy = if semantics_force {
        "always".to_string()
    } else {
        let candidate = raw_web_search
            .get("injectPolicy")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_else(|| "selective".to_string());
        if candidate == "always" || candidate == "selective" {
            candidate
        } else {
            "selective".to_string()
        }
    };

    let messages = request
        .as_object()
        .and_then(|obj| obj.get("messages"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let intent = analyze_chat_web_search_intent(messages);
    if inject_policy == "selective" && !intent.has_intent {
        return ChatWebSearchPlanOutput {
            should_inject: false,
            selected_engine_indexes: Vec::new(),
        };
    }

    let mut indexed_engines: Vec<(i64, Map<String, Value>)> = Vec::new();
    for (idx, entry) in engines.iter().enumerate() {
        let row = match entry.as_object() {
            Some(v) => v.clone(),
            None => continue,
        };
        indexed_engines.push((idx as i64, row));
    }

    let runnable_engine_indexes: Vec<i64> = indexed_engines
        .iter()
        .filter_map(|(origin_index, engine)| {
            let id = read_trimmed_string(engine.get("id"));
            if id.is_empty() {
                return None;
            }
            let server_tools_disabled = engine
                .get("serverToolsDisabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if server_tools_disabled {
                return None;
            }
            Some(*origin_index)
        })
        .collect();

    let direct_route_engine_indexes: Vec<i64> = runnable_engine_indexes
        .iter()
        .filter_map(|idx| {
            let (_, engine) = indexed_engines
                .iter()
                .find(|(origin_index, _)| *origin_index == *idx)?;
            if is_direct_route_web_search_engine(engine) {
                return Some(*idx);
            }
            None
        })
        .collect();

    let mut selected_engine_indexes: Vec<i64> = runnable_engine_indexes
        .iter()
        .filter_map(|idx| {
            let (_, engine) = indexed_engines
                .iter()
                .find(|(origin_index, _)| *origin_index == *idx)?;
            if is_servertool_web_search_engine(engine) {
                return Some(*idx);
            }
            None
        })
        .collect();

    if intent.google_preferred {
        let preferred: Vec<i64> = selected_engine_indexes
            .iter()
            .filter_map(|idx| {
                if *idx < 0 {
                    return None;
                }
                let (_, engine) = indexed_engines
                    .iter()
                    .find(|(origin_index, _)| *origin_index == *idx)?;
                let id = read_trimmed_string(engine.get("id")).to_ascii_lowercase();
                let provider_key =
                    read_trimmed_string(engine.get("providerKey")).to_ascii_lowercase();
                if provider_key.starts_with("gemini-cli.")
                    || provider_key.starts_with("antigravity.")
                    || id.contains("google")
                {
                    return Some(*idx);
                }
                None
            })
            .collect();
        if !preferred.is_empty() {
            selected_engine_indexes = preferred;
        }
    }

    if should_bypass_servertool_web_search(
        intent.has_intent,
        intent.google_preferred,
        semantics_force,
        indexed_engines.as_slice(),
        runnable_engine_indexes.as_slice(),
        direct_route_engine_indexes.as_slice(),
    ) {
        return ChatWebSearchPlanOutput {
            should_inject: false,
            selected_engine_indexes: Vec::new(),
        };
    }

    if selected_engine_indexes.is_empty() {
        return ChatWebSearchPlanOutput {
            should_inject: false,
            selected_engine_indexes: Vec::new(),
        };
    }

    ChatWebSearchPlanOutput {
        should_inject: true,
        selected_engine_indexes,
    }
}

fn read_clock_enabled(raw_clock: Option<&Value>) -> bool {
    match raw_clock {
        None => true,
        Some(Value::Object(row)) => {
            let enabled = row.get("enabled");
            if enabled == Some(&Value::Bool(true)) {
                return true;
            }
            if let Some(text) = enabled.and_then(|v| v.as_str()) {
                return text.trim().eq_ignore_ascii_case("true");
            }
            if let Some(number) = enabled.and_then(|v| v.as_i64()) {
                return number == 1;
            }
            false
        }
        _ => false,
    }
}

fn resolve_chat_clock_plan(runtime_metadata: &Value) -> ChatClockPlanOutput {
    let server_tool_followup = read_runtime_metadata_bool(runtime_metadata, "serverToolFollowup");
    let clock_followup_inject_tool =
        read_runtime_metadata_bool(runtime_metadata, "clockFollowupInjectTool");
    if server_tool_followup && !clock_followup_inject_tool {
        return ChatClockPlanOutput {
            should_inject: false,
        };
    }

    let should_inject = read_clock_enabled(
        runtime_metadata
            .as_object()
            .and_then(|obj| obj.get("clock")),
    );
    ChatClockPlanOutput { should_inject }
}

fn resolve_continue_execution_plan(
    runtime_metadata: &Value,
    has_active_stop_message: bool,
) -> ChatContinueExecutionPlanOutput {
    if read_runtime_metadata_bool(runtime_metadata, "serverToolFollowup") || has_active_stop_message
    {
        return ChatContinueExecutionPlanOutput {
            should_inject: false,
        };
    }
    ChatContinueExecutionPlanOutput {
        should_inject: true,
    }
}

#[napi]
pub fn plan_chat_web_search_operations_json(
    request_json: String,
    runtime_metadata_json: String,
) -> NapiResult<String> {
    let request: Value =
        serde_json::from_str(&request_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let runtime_metadata: Value = serde_json::from_str(&runtime_metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_chat_web_search_plan(&request, &runtime_metadata);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn plan_chat_clock_operations_json(runtime_metadata_json: String) -> NapiResult<String> {
    let runtime_metadata: Value = serde_json::from_str(&runtime_metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_chat_clock_plan(&runtime_metadata);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn plan_continue_execution_operations_json(
    runtime_metadata_json: String,
    has_active_stop_message: bool,
) -> NapiResult<String> {
    let runtime_metadata: Value = serde_json::from_str(&runtime_metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_continue_execution_plan(&runtime_metadata, has_active_stop_message);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn plan_chat_servertool_orchestration_bundle_json(
    request_json: String,
    runtime_metadata_json: String,
    has_active_stop_message: bool,
) -> NapiResult<String> {
    let request: Value =
        serde_json::from_str(&request_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let runtime_metadata: Value = serde_json::from_str(&runtime_metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;

    let output = ChatServerToolBundlePlanOutput {
        web_search: resolve_chat_web_search_plan(&request, &runtime_metadata),
        clock: resolve_chat_clock_plan(&runtime_metadata),
        continue_execution: resolve_continue_execution_plan(
            &runtime_metadata,
            has_active_stop_message,
        ),
    };

    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn detect_provider_response_shape_json(payload_json: String) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = detect_provider_response_shape(&payload);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn is_canonical_chat_completion_payload_json(payload_json: String) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = is_canonical_chat_completion_payload(&payload);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn build_review_operations_json(metadata_json: String) -> NapiResult<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = build_review_operations(&metadata);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn build_continue_execution_operations_json(should_inject: bool) -> NapiResult<String> {
    let output = build_continue_execution_operations(should_inject);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn is_stop_message_state_active_json(raw_json: String) -> NapiResult<String> {
    let raw: Value =
        serde_json::from_str(&raw_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = is_stop_message_state_active(&raw);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_has_active_stop_message_for_continue_execution_json(
    runtime_state_json: String,
    persisted_state_json: String,
) -> NapiResult<String> {
    let runtime_state: Value = serde_json::from_str(&runtime_state_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let persisted_state: Value = serde_json::from_str(&persisted_state_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output =
        resolve_has_active_stop_message_for_continue_execution(&runtime_state, &persisted_state);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_stop_message_session_scope_json(metadata_json: String) -> NapiResult<String> {
    let metadata: Value = serde_json::from_str(&metadata_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_stop_message_session_scope(&metadata);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_canonical_chat_completion_payload_true_when_first_choice_has_message_object() {
        let payload = json!({
            "id": "chatcmpl-1",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": "hello"
                    }
                }
            ]
        });
        assert!(is_canonical_chat_completion_payload(&payload));
    }

    #[test]
    fn test_is_canonical_chat_completion_payload_false_for_non_canonical_shapes() {
        let no_choices = json!({ "output": [] });
        let empty_choices = json!({ "choices": [] });
        let no_message = json!({
            "choices": [
                {
                    "index": 0
                }
            ]
        });
        assert!(!is_canonical_chat_completion_payload(&no_choices));
        assert!(!is_canonical_chat_completion_payload(&empty_choices));
        assert!(!is_canonical_chat_completion_payload(&no_message));
    }
}

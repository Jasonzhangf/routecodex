use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_json::{Map, Value};

use crate::chat_clock_tool_schema_ops::build_clock_tool_append_operations_json;
use crate::chat_process_media_semantics::{
    analyze_chat_process_media, strip_chat_process_historical_images,
    strip_responses_context_input_historical_media,
};
use crate::chat_servertool_orchestration::{
    build_continue_execution_operations_json, build_review_operations_json,
    plan_chat_servertool_orchestration_bundle_json,
};
use crate::chat_web_search_tool_schema::build_web_search_tool_append_operations_json;
use crate::hub_req_inbound_context_capture::resolve_client_inject_ready_json;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolGovernanceInput {
    pub request: Value,
    pub raw_payload: Value,
    pub metadata: Value,
    pub entry_endpoint: String,
    pub request_id: String,
    #[serde(default)]
    pub has_active_stop_message_for_continue_execution: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolGovernanceOutput {
    pub processed_request: Value,
    pub node_result: Value,
}

fn as_object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    let raw = value
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if raw.is_empty() {
        return None;
    }
    Some(raw)
}

fn normalize_record(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(row) => row,
        _ => Map::new(),
    }
}

fn normalize_record_ref(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(row) => row.clone(),
        _ => Map::new(),
    }
}

#[derive(Debug)]
struct GovernanceContext {
    entry_endpoint: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebSearchPlan {
    should_inject: bool,
    #[serde(default)]
    selected_engine_indexes: Vec<i64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SimpleInjectPlan {
    should_inject: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerToolBundlePlan {
    #[serde(default)]
    web_search: WebSearchPlan,
    #[serde(default)]
    clock: SimpleInjectPlan,
    #[serde(default)]
    continue_execution: SimpleInjectPlan,
}

fn resolve_governance_context(metadata: &Value, input_entry_endpoint: &str) -> GovernanceContext {
    let metadata_obj = as_object(metadata);

    let entry_endpoint = read_trimmed_string(metadata_obj.and_then(|obj| obj.get("entryEndpoint")))
        .or_else(|| {
            let trimmed = input_entry_endpoint.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        })
        .unwrap_or_else(|| "/v1/chat/completions".to_string());

    GovernanceContext { entry_endpoint }
}

fn apply_anthropic_tool_alias_semantics(request: &mut Map<String, Value>, entry_endpoint: &str) {
    if !entry_endpoint.contains("/v1/messages") {
        return;
    }
    if !request.contains_key("metadata") {
        request.insert("metadata".to_string(), Value::Object(Map::new()));
    }
    if let Some(metadata) = request.get_mut("metadata").and_then(|v| v.as_object_mut()) {
        metadata.insert("preserveNativeToolNames".to_string(), Value::Bool(true));
    }
}

fn apply_post_governed_media_cleanup(request: &mut Map<String, Value>) {
    const PLACEHOLDER_TEXT: &str = "[Image omitted]";

    let current_messages = request
        .get("messages")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if !current_messages.is_empty() {
        let stripped = strip_chat_process_historical_images(
            current_messages.clone(),
            PLACEHOLDER_TEXT.to_string(),
        );
        let effective_messages = if stripped.changed {
            request.insert(
                "messages".to_string(),
                Value::Array(stripped.messages.clone()),
            );
            stripped.messages
        } else {
            current_messages
        };

        let media_analysis = analyze_chat_process_media(effective_messages);
        if media_analysis.contains_current_turn_image {
            let metadata = request
                .entry("metadata".to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            if let Some(metadata_obj) = metadata.as_object_mut() {
                metadata_obj.insert("hasImageAttachment".to_string(), Value::Bool(true));
            }
        }
    }

    let maybe_context_input = request
        .get_mut("semantics")
        .and_then(|v| v.as_object_mut())
        .and_then(|semantics| semantics.get_mut("responses"))
        .and_then(|v| v.as_object_mut())
        .and_then(|responses| responses.get_mut("context"))
        .and_then(|v| v.as_object_mut())
        .and_then(|context| context.get_mut("input"));

    if let Some(input_value) = maybe_context_input {
        if let Some(input_entries) = input_value.as_array().cloned() {
            let stripped = strip_responses_context_input_historical_media(
                input_entries,
                PLACEHOLDER_TEXT.to_string(),
            );
            if stripped.changed {
                *input_value = Value::Array(stripped.messages);
            }
        }
    }
}

fn build_governed_filter_payload(request: &Value) -> Value {
    let request_obj = as_object(request);
    let model = request_obj
        .and_then(|obj| obj.get("model"))
        .cloned()
        .unwrap_or(Value::Null);
    let messages = request_obj
        .and_then(|obj| obj.get("messages"))
        .filter(|v| v.is_array())
        .cloned()
        .unwrap_or(Value::Array(Vec::new()));
    let semantics = request_obj
        .and_then(|obj| obj.get("semantics"))
        .cloned()
        .unwrap_or(Value::Null);
    let metadata = request_obj
        .and_then(|obj| obj.get("metadata"))
        .and_then(|v| v.as_object())
        .map(|row| Value::Object(row.clone()))
        .unwrap_or_else(|| Value::Object(Map::new()));
    let tools = request_obj
        .and_then(|obj| obj.get("tools"))
        .cloned()
        .unwrap_or(Value::Null);

    let parameters = request_obj
        .and_then(|obj| obj.get("parameters"))
        .and_then(|v| v.as_object())
        .map(|row| Value::Object(row.clone()))
        .unwrap_or_else(|| Value::Object(Map::new()));

    let parameter_obj = parameters.as_object();
    let tool_choice = parameter_obj
        .and_then(|obj| obj.get("tool_choice"))
        .cloned()
        .unwrap_or(Value::Null);
    let stream = parameter_obj
        .and_then(|obj| obj.get("stream"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut out = Map::new();
    out.insert("model".to_string(), model);
    out.insert("messages".to_string(), messages);
    if !semantics.is_null() {
        out.insert("semantics".to_string(), semantics);
    }
    out.insert("metadata".to_string(), metadata);
    if !tools.is_null() {
        out.insert("tools".to_string(), tools);
    }
    out.insert("tool_choice".to_string(), tool_choice);
    out.insert("stream".to_string(), Value::Bool(stream));
    out.insert("parameters".to_string(), parameters);
    Value::Object(out)
}

fn parse_json_array(raw: &str) -> Vec<Value> {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Array(rows)) => rows,
        _ => Vec::new(),
    }
}

fn parse_json_bool(raw: &str) -> Option<bool> {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Bool(v)) => Some(v),
        _ => None,
    }
}

fn parse_bundle_plan(raw: &str) -> Option<ServerToolBundlePlan> {
    serde_json::from_str::<ServerToolBundlePlan>(raw).ok()
}

fn pick_bool(value: Option<&Value>) -> Option<bool> {
    match value {
        Some(Value::Bool(v)) => Some(*v),
        Some(Value::String(raw)) => {
            let lowered = raw.trim().to_ascii_lowercase();
            if lowered == "true" {
                return Some(true);
            }
            if lowered == "false" {
                return Some(false);
            }
            None
        }
        Some(Value::Number(raw)) => {
            if raw.as_i64() == Some(1) {
                return Some(true);
            }
            if raw.as_i64() == Some(0) {
                return Some(false);
            }
            None
        }
        _ => None,
    }
}

fn read_runtime_metadata(metadata: &Map<String, Value>) -> Map<String, Value> {
    metadata
        .get("__rt")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default()
}

fn read_clock_enabled(runtime_metadata: &Map<String, Value>) -> bool {
    let raw_clock = runtime_metadata.get("clock");
    match raw_clock {
        None => true,
        Some(Value::Object(row)) => pick_bool(row.get("enabled")).unwrap_or(false),
        _ => false,
    }
}

fn read_web_search_execution_mode(engine: &Value) -> String {
    let row = match engine.as_object() {
        Some(v) => v,
        None => return "servertool".to_string(),
    };
    let direct = row
        .get("executionMode")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            row.get("mode")
                .and_then(|v| v.as_str())
                .map(|v| v.trim().to_ascii_lowercase())
                .filter(|v| !v.is_empty())
        });
    match direct.as_deref() {
        Some("direct") => "direct".to_string(),
        _ => "servertool".to_string(),
    }
}

fn resolve_default_bundle_plan(
    runtime_metadata: &Map<String, Value>,
    has_active_stop_message: bool,
) -> ServerToolBundlePlan {
    let server_tool_followup =
        pick_bool(runtime_metadata.get("serverToolFollowup")).unwrap_or(false);
    let clock_followup_inject_tool =
        pick_bool(runtime_metadata.get("clockFollowupInjectTool")).unwrap_or(false);
    let web_search_indexes = runtime_metadata
        .get("webSearch")
        .and_then(|v| v.as_object())
        .and_then(|row| row.get("engines"))
        .and_then(|v| v.as_array())
        .map(|engines| {
            engines
                .iter()
                .enumerate()
                .filter_map(|(idx, engine)| {
                    if read_web_search_execution_mode(engine) != "servertool" {
                        return None;
                    }
                    Some(idx as i64)
                })
                .collect::<Vec<i64>>()
        })
        .unwrap_or_default();

    let web_search_should = !web_search_indexes.is_empty() && !server_tool_followup;
    let clock_should = if server_tool_followup && !clock_followup_inject_tool {
        false
    } else {
        read_clock_enabled(runtime_metadata)
    };
    let continue_should = !(server_tool_followup || has_active_stop_message);

    ServerToolBundlePlan {
        web_search: WebSearchPlan {
            should_inject: web_search_should,
            selected_engine_indexes: web_search_indexes,
        },
        clock: SimpleInjectPlan {
            should_inject: clock_should,
        },
        continue_execution: SimpleInjectPlan {
            should_inject: continue_should,
        },
    }
}

fn read_selected_web_search_engines(
    runtime_metadata: &Map<String, Value>,
    indexes: &[i64],
) -> Value {
    let engines = runtime_metadata
        .get("webSearch")
        .and_then(|v| v.as_object())
        .and_then(|row| row.get("engines"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut selected: Vec<Value> = Vec::new();
    for index in indexes {
        if *index < 0 {
            continue;
        }
        let idx = *index as usize;
        if idx >= engines.len() {
            continue;
        }
        if read_web_search_execution_mode(&engines[idx]) != "servertool" {
            continue;
        }
        selected.push(engines[idx].clone());
    }
    Value::Array(selected)
}

fn build_clock_tool_definition() -> Value {
    json!({
      "type": "function",
      "function": {
        "name": "clock",
        "description": "Time + Alarm for this session. Mandatory workflow: before every new clock.schedule, call clock.list first; without a fresh list, new reminder creation is invalid. After listing, prefer clock.update over clock.schedule whenever an existing reminder can be edited. If two reminders would be within 5 minutes, merge or retime them instead of keeping near-duplicate alarms. Use clock.schedule for any blocking wait so work can continue non-blockingly and you will get an interrupt reminder later. If waiting 3 minutes or longer is required, MUST call clock.schedule now (never promise to wait without scheduling). You may set multiple reminders when they are meaningfully different. For complex reminders, write clock.md before waiting and read it first when reminded. Required clock.md template: ## 背景 / ## 当前阻塞点 / ## 下次提醒要做的第一步 / ## 不能忘的检查项. Format example: {\"action\":\"list\",\"items\":[],\"taskId\":\"\"} before {\"action\":\"schedule\",\"items\":[{\"dueAt\":\"<ISO8601>\",\"task\":\"<exact follow-up action>\",\"tool\":\"<tool-name-or-empty>\",\"arguments\":\"<json-string-or-{}>\"}],\"taskId\":\"\"}. Use get/schedule/update/list/cancel/clear. Scheduled reminders are injected into future requests.",
        "parameters": {
          "type": "object",
          "properties": {
            "action": {
              "type": "string",
              "enum": ["get", "schedule", "update", "list", "cancel", "clear"],
              "description": "Get current time, or schedule/update/list/cancel/clear session-scoped reminders. Mandatory rule: before every new clock.schedule, call clock.list first; without a fresh list, new reminder creation is invalid. After listing, prefer clock.update over clock.schedule whenever an existing reminder can be edited. If reminders end up within 5 minutes of each other, reconsider and merge or retime them. Use clock.schedule for blocking waits that should not stall execution. If waiting 3 minutes or longer is required, use action=\"schedule\" immediately."
            },
            "items": {
              "type": "array",
              "description": "For schedule/update: list of reminder payloads. update uses items[0] as patch source.",
              "items": {
                "type": "object",
                "properties": {
                  "dueAt": {
                    "type": "string",
                    "description": "ISO8601 datetime with timezone (e.g. 2026-01-21T20:30:00-08:00)."
                  },
                  "task": {
                    "type": "string",
                    "description": "Reminder text that states the exact action to execute on wake-up (no vague placeholders)."
                  },
                  "tool": {
                    "type": "string",
                    "description": "Optional suggested tool name (hint only)."
                  },
                  "arguments": {
                    "type": "string",
                    "description": "Optional suggested tool arguments as a JSON string (hint only). Use \"{}\" when unsure."
                  }
                },
                "required": ["dueAt", "task", "tool", "arguments"],
                "additionalProperties": false
              }
            },
            "taskId": {
              "type": "string",
              "description": "For cancel/update: target taskId."
            }
          },
          "required": ["action", "items", "taskId"],
          "additionalProperties": false
        },
        "strict": true
      }
    })
}

fn resolve_tool_name(tool: &Value) -> Option<String> {
    let obj = tool.as_object()?;
    let direct = obj
        .get("name")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string());
    if let Some(name) = direct {
        if !name.is_empty() {
            return Some(name);
        }
    }
    obj.get("function")
        .and_then(|v| v.as_object())
        .and_then(|row| row.get("name"))
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn request_has_tool(request: &Map<String, Value>, tool_name: &str) -> bool {
    let normalized = tool_name.trim();
    if normalized.is_empty() {
        return false;
    }
    request
        .get("tools")
        .and_then(|v| v.as_array())
        .map(|tools| {
            tools.iter().any(|tool| {
                resolve_tool_name(tool)
                    .map(|name| name == normalized)
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn apply_hub_operations(request: &mut Map<String, Value>, operations: &[Value]) {
    for op in operations {
        let row = match op.as_object() {
            Some(v) => v,
            None => continue,
        };
        let kind = row.get("op").and_then(|v| v.as_str()).unwrap_or("").trim();
        if kind == "set_request_metadata_fields" {
            let patch = match row.get("fields").and_then(|v| v.as_object()) {
                Some(v) => v,
                None => continue,
            };
            let metadata = request
                .entry("metadata".to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            if !metadata.is_object() {
                *metadata = Value::Object(Map::new());
            }
            if let Some(metadata_row) = metadata.as_object_mut() {
                for (key, value) in patch {
                    metadata_row.insert(key.clone(), value.clone());
                }
            }
            continue;
        }
        if kind == "set_request_parameter_fields" {
            let patch = match row.get("fields").and_then(|v| v.as_object()) {
                Some(v) => v,
                None => continue,
            };
            let parameters = request
                .entry("parameters".to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            if !parameters.is_object() {
                *parameters = Value::Object(Map::new());
            }
            if let Some(parameters_row) = parameters.as_object_mut() {
                for (key, value) in patch {
                    parameters_row.insert(key.clone(), value.clone());
                }
            }
            continue;
        }
        if kind == "unset_request_metadata_keys" || kind == "unset_request_parameter_keys" {
            let keys = row
                .get("keys")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|entry| entry.as_str())
                        .map(|raw| raw.trim().to_string())
                        .filter(|key| !key.is_empty())
                        .collect::<Vec<String>>()
                })
                .unwrap_or_default();
            if keys.is_empty() {
                continue;
            }
            let target_key = if kind == "unset_request_metadata_keys" {
                "metadata"
            } else {
                "parameters"
            };
            let target = request
                .entry(target_key.to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            if !target.is_object() {
                *target = Value::Object(Map::new());
            }
            if let Some(target_obj) = target.as_object_mut() {
                for key in keys {
                    target_obj.remove(&key);
                }
            }
            continue;
        }
        if kind == "append_tool_if_missing" {
            let tool_name = row
                .get("toolName")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if tool_name.is_empty() {
                continue;
            }
            if request_has_tool(request, &tool_name) {
                continue;
            }
            let tool_value = match row.get("tool") {
                Some(v) => v.clone(),
                None => continue,
            };
            let tools = request
                .entry("tools".to_string())
                .or_insert_with(|| Value::Array(Vec::new()));
            if !tools.is_array() {
                *tools = Value::Array(Vec::new());
            }
            if let Some(tool_array) = tools.as_array_mut() {
                tool_array.push(tool_value);
            }
        }
    }
}

#[napi_derive::napi]
pub fn apply_hub_operations_json(
    request_json: String,
    operations_json: String,
) -> NapiResult<String> {
    let request: Value =
        serde_json::from_str(&request_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let operations: Value = serde_json::from_str(&operations_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let mut request_obj = request.as_object().cloned().unwrap_or_else(Map::new);
    let ops = operations.as_array().cloned().unwrap_or_default();
    apply_hub_operations(&mut request_obj, &ops);
    serde_json::to_string(&Value::Object(request_obj))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

fn parse_bool_or_default(raw: NapiResult<String>, default: bool) -> bool {
    match raw {
        Ok(payload) => parse_json_bool(&payload).unwrap_or(default),
        Err(_) => default,
    }
}

fn parse_ops_or_empty(raw: NapiResult<String>) -> Vec<Value> {
    match raw {
        Ok(payload) => parse_json_array(&payload),
        Err(_) => Vec::new(),
    }
}

fn parse_bundle_or_default(
    raw: NapiResult<String>,
    runtime_metadata: &Map<String, Value>,
    has_active_stop_message: bool,
) -> ServerToolBundlePlan {
    match raw {
        Ok(payload) => parse_bundle_plan(&payload).unwrap_or_else(|| {
            resolve_default_bundle_plan(runtime_metadata, has_active_stop_message)
        }),
        Err(_) => resolve_default_bundle_plan(runtime_metadata, has_active_stop_message),
    }
}

fn maybe_apply_servertool_orchestration(
    request: &mut Map<String, Value>,
    metadata: &Map<String, Value>,
    has_active_stop_message_for_continue_execution: bool,
) {
    let metadata_json = match serde_json::to_string(&Value::Object(metadata.clone())) {
        Ok(v) => v,
        Err(_) => return,
    };
    let client_inject_ready = parse_bool_or_default(
        resolve_client_inject_ready_json(metadata_json.clone()),
        true,
    );
    if !client_inject_ready {
        return;
    }

    let runtime_metadata = read_runtime_metadata(metadata);
    let has_active_stop_message = has_active_stop_message_for_continue_execution;

    let request_value = Value::Object(request.clone());
    let request_json = match serde_json::to_string(&request_value) {
        Ok(v) => v,
        Err(_) => return,
    };
    let runtime_metadata_json =
        match serde_json::to_string(&Value::Object(runtime_metadata.clone())) {
            Ok(v) => v,
            Err(_) => "{}".to_string(),
        };
    let bundle_plan = parse_bundle_or_default(
        plan_chat_servertool_orchestration_bundle_json(
            request_json,
            runtime_metadata_json,
            has_active_stop_message,
        ),
        &runtime_metadata,
        has_active_stop_message,
    );

    let mut operations: Vec<Value> = Vec::new();

    if bundle_plan.web_search.should_inject
        && !bundle_plan.web_search.selected_engine_indexes.is_empty()
    {
        let engines = read_selected_web_search_engines(
            &runtime_metadata,
            &bundle_plan.web_search.selected_engine_indexes,
        );
        if let Ok(engines_json) = serde_json::to_string(&engines) {
            operations.extend(parse_ops_or_empty(
                build_web_search_tool_append_operations_json(engines_json),
            ));
        }
    }

    if bundle_plan.clock.should_inject {
        let has_tmux_session = [
            "clientTmuxSessionId",
            "client_tmux_session_id",
            "tmuxSessionId",
            "tmux_session_id",
        ]
        .iter()
        .any(|key| {
            metadata
                .get(*key)
                .and_then(|v| v.as_str())
                .map(|v| !v.trim().is_empty())
                .unwrap_or(false)
        });
        let clock_tool = build_clock_tool_definition();
        if let Ok(clock_tool_json) = serde_json::to_string(&clock_tool) {
            operations.extend(parse_ops_or_empty(build_clock_tool_append_operations_json(
                has_tmux_session,
                clock_tool_json,
            )));
        }
    }

    operations.extend(parse_ops_or_empty(
        build_continue_execution_operations_json(bundle_plan.continue_execution.should_inject),
    ));
    operations.extend(parse_ops_or_empty(build_review_operations_json(
        metadata_json,
    )));

    if operations.is_empty() {
        return;
    }
    apply_hub_operations(request, &operations);
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn build_node_result(
    success: bool,
    start_time_ms: u64,
    end_time_ms: u64,
    processed_request: &Map<String, Value>,
    error: Option<&str>,
) -> Value {
    let duration_ms = end_time_ms.saturating_sub(start_time_ms);
    let messages = processed_request
        .get("messages")
        .and_then(|v| v.as_array())
        .map(|v| v.len() as u64)
        .unwrap_or(0);
    let tools = processed_request
        .get("tools")
        .and_then(|v| v.as_array())
        .map(|v| v.len() as u64)
        .unwrap_or(0);

    let mut result = Map::new();
    result.insert("success".to_string(), Value::Bool(success));
    result.insert(
        "metadata".to_string(),
        json!({
          "node": "hub-chat-process",
          "executionTime": duration_ms,
          "startTime": start_time_ms,
          "endTime": end_time_ms,
          "dataProcessed": {
            "messages": messages,
            "tools": tools
          }
        }),
    );

    if let Some(err) = error {
        let mut err_map = Map::new();
        err_map.insert(
            "code".to_string(),
            Value::String("tool_governance_error".to_string()),
        );
        err_map.insert("message".to_string(), Value::String(err.to_string()));
        result.insert("error".to_string(), Value::Object(err_map));
    }

    Value::Object(result)
}

fn build_processed_request(governed: Value, metadata: &Map<String, Value>) -> Value {
    let mut processed = normalize_record(governed);
    let stream_enabled = processed
        .get("parameters")
        .and_then(|v| v.as_object())
        .and_then(|row| row.get("stream"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let mut merged_metadata = metadata.clone();
    let governed_metadata = processed
        .get("metadata")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    for (key, value) in governed_metadata {
        merged_metadata.insert(key, value);
    }
    processed.insert("metadata".to_string(), Value::Object(merged_metadata));

    let timestamp = now_millis();
    processed.insert(
        "processed".to_string(),
        json!({
          "timestamp": timestamp,
          "appliedRules": ["tool-governance"],
          "status": "success"
        }),
    );
    processed.insert(
        "processingMetadata".to_string(),
        json!({
          "streaming": {
            "enabled": stream_enabled,
            "chunkCount": 0
          }
        }),
    );
    Value::Object(processed)
}

pub fn apply_req_process_tool_governance(
    input: ToolGovernanceInput,
) -> Result<ToolGovernanceOutput, String> {
    let start_time_ms = now_millis();

    let ctx = resolve_governance_context(&input.metadata, &input.entry_endpoint);

    let mut request = normalize_record(input.request);
    let metadata = normalize_record(input.metadata);

    apply_anthropic_tool_alias_semantics(&mut request, &ctx.entry_endpoint);

    let governed = build_governed_filter_payload(&Value::Object(request));
    let mut governed_request = normalize_record(governed);
    maybe_apply_servertool_orchestration(
        &mut governed_request,
        &metadata,
        input
            .has_active_stop_message_for_continue_execution
            .unwrap_or(false),
    );
    apply_post_governed_media_cleanup(&mut governed_request);

    let processed = build_processed_request(Value::Object(governed_request), &metadata);
    let processed_request_map = normalize_record_ref(&processed);
    let end_time_ms = now_millis();

    let node_result = build_node_result(
        true,
        start_time_ms,
        end_time_ms,
        &processed_request_map,
        None,
    );

    Ok(ToolGovernanceOutput {
        processed_request: processed,
        node_result,
    })
}

#[napi]
pub fn apply_req_process_tool_governance_json(input_json: String) -> NapiResult<String> {
    if input_json.trim().is_empty() {
        return Err(napi::Error::from_reason("Input JSON is empty"));
    }
    let input: ToolGovernanceInput = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse input JSON: {}", e)))?;

    let output =
        apply_req_process_tool_governance(input).map_err(|e| napi::Error::from_reason(e))?;

    serde_json::to_string(&output)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize output: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    #[test]
    fn test_apply_tool_governance_basic() {
        let input = ToolGovernanceInput {
            request: serde_json::json!({
              "model": "gpt-4",
              "messages": [{"role": "user", "content": "hello"}]
            }),
            raw_payload: serde_json::json!({}),
            metadata: serde_json::json!({
              "entryEndpoint": "/v1/chat/completions"
            }),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_123".to_string(),
            has_active_stop_message_for_continue_execution: None,
        };
        let result = apply_req_process_tool_governance(input).unwrap();
        assert!(result.node_result["success"].as_bool().unwrap());
    }
    #[test]
    fn test_error_empty_json_input() {
        let result = apply_req_process_tool_governance_json("".to_string());
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("Input JSON is empty"));
    }

    #[test]
    fn test_anthropic_alias_semantics() {
        let input = ToolGovernanceInput {
            request: serde_json::json!({
              "model": "claude-3",
              "messages": [{"role": "user", "content": "hi"}]
            }),
            raw_payload: serde_json::json!({}),
            metadata: serde_json::json!({
              "entryEndpoint": "/v1/messages",
              "providerProtocol": "anthropic-messages"
            }),
            entry_endpoint: "/v1/messages".to_string(),
            request_id: "req_456".to_string(),
            has_active_stop_message_for_continue_execution: None,
        };
        let result = apply_req_process_tool_governance(input).unwrap();
        let processed = result.processed_request.as_object().unwrap();
        assert!(processed["metadata"]["preserveNativeToolNames"]
            .as_bool()
            .unwrap());
    }

    #[test]
    fn test_processed_request_shape_and_node_metadata() {
        let input = ToolGovernanceInput {
            request: serde_json::json!({
              "model": "gpt-4o-mini",
              "messages": [{"role": "user", "content": "hello"}],
              "parameters": {"stream": true}
            }),
            raw_payload: serde_json::json!({}),
            metadata: serde_json::json!({
              "entryEndpoint": "/v1/chat/completions",
              "capturedContext": {"k": "v"}
            }),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_789".to_string(),
            has_active_stop_message_for_continue_execution: None,
        };
        let result = apply_req_process_tool_governance(input).unwrap();
        let processed = result.processed_request.as_object().unwrap();
        assert!(processed.get("processed").is_some());
        assert!(processed.get("processingMetadata").is_some());
        assert_eq!(
            processed["processingMetadata"]["streaming"]["enabled"].as_bool(),
            Some(true)
        );
        assert_eq!(
            result.node_result["metadata"]["node"].as_str(),
            Some("hub-chat-process")
        );
    }

    #[test]
    fn test_post_governed_media_cleanup_strips_historical_media_from_followup_messages_and_context()
    {
        let input = ToolGovernanceInput {
            request: serde_json::json!({
              "model": "kimi-k2.5",
              "messages": [
                {
                  "role": "user",
                  "content": [
                    { "type": "input_text", "text": "look" },
                    { "type": "input_image", "image_url": "data:image/png;base64,AAA" }
                  ]
                },
                { "role": "assistant", "content": "ok" },
                { "role": "tool", "content": "done" }
              ],
              "semantics": {
                "responses": {
                  "context": {
                    "input": [
                      {
                        "type": "message",
                        "role": "user",
                        "content": [
                          { "type": "input_text", "text": "look" },
                          { "type": "input_image", "image_url": "data:image/png;base64,AAA" }
                        ]
                      },
                      {
                        "type": "message",
                        "role": "assistant",
                        "content": [
                          { "type": "output_text", "text": "ok" }
                        ]
                      },
                      {
                        "type": "function_call_output",
                        "call_id": "call_1",
                        "output": "done"
                      }
                    ]
                  }
                }
              }
            }),
            raw_payload: serde_json::json!({}),
            metadata: serde_json::json!({
              "entryEndpoint": "/v1/responses"
            }),
            entry_endpoint: "/v1/responses".to_string(),
            request_id: "req_media_followup".to_string(),
            has_active_stop_message_for_continue_execution: None,
        };

        let result = apply_req_process_tool_governance(input).unwrap();
        let processed = result.processed_request.as_object().unwrap();
        let messages = processed["messages"].as_array().unwrap();
        let first_content = messages[0]["content"].as_array().unwrap();
        assert_eq!(first_content[1]["type"].as_str(), Some("text"));
        assert_eq!(first_content[1]["text"].as_str(), Some("[Image omitted]"));
        assert!(processed["metadata"]
            .as_object()
            .and_then(|meta| meta.get("hasImageAttachment"))
            .is_none());

        let context_input = processed["semantics"]["responses"]["context"]["input"]
            .as_array()
            .unwrap();
        let context_first_content = context_input[0]["content"].as_array().unwrap();
        assert_eq!(
            context_first_content[1]["type"].as_str(),
            Some("input_text")
        );
        assert_eq!(
            context_first_content[1]["text"].as_str(),
            Some("[Image omitted]")
        );
    }

    #[test]
    fn test_post_governed_media_cleanup_preserves_latest_user_media_turn() {
        let input = ToolGovernanceInput {
            request: serde_json::json!({
              "model": "kimi-k2.5",
              "messages": [
                {
                  "role": "user",
                  "content": [
                    { "type": "input_text", "text": "look" },
                    { "type": "input_image", "image_url": "data:image/png;base64,BBB" }
                  ]
                }
              ]
            }),
            raw_payload: serde_json::json!({}),
            metadata: serde_json::json!({
              "entryEndpoint": "/v1/responses"
            }),
            entry_endpoint: "/v1/responses".to_string(),
            request_id: "req_media_current_turn".to_string(),
            has_active_stop_message_for_continue_execution: None,
        };

        let result = apply_req_process_tool_governance(input).unwrap();
        let processed = result.processed_request.as_object().unwrap();
        let messages = processed["messages"].as_array().unwrap();
        let first_content = messages[0]["content"].as_array().unwrap();
        assert_eq!(first_content[1]["type"].as_str(), Some("input_image"));
        assert_eq!(
            processed["metadata"]["hasImageAttachment"].as_bool(),
            Some(true)
        );
    }

    #[test]
    fn test_servertool_orchestration_appends_clock_review_continue_tools() {
        let input = ToolGovernanceInput {
            request: serde_json::json!({
              "model": "gpt-4o-mini",
              "messages": [{"role": "user", "content": "hello"}],
              "tools": [
                {
                  "type": "function",
                  "function": {
                    "name": "exec_command",
                    "parameters": { "type": "object", "properties": { "cmd": { "type": "string" } }, "required": ["cmd"] }
                  }
                }
              ],
              "parameters": {
                "stream": true
              }
            }),
            raw_payload: serde_json::json!({}),
            metadata: serde_json::json!({
              "tmuxSessionId": "s-1",
              "__rt": {
                "clock": { "enabled": true },
                "webSearch": {
                  "engines": [
                    { "id": "google" }
                  ]
                }
              }
            }),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_tools".to_string(),
            has_active_stop_message_for_continue_execution: None,
        };

        let result = apply_req_process_tool_governance(input).unwrap();
        let tools = result
            .processed_request
            .as_object()
            .and_then(|row| row.get("tools"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut names: HashSet<String> = HashSet::new();
        for tool in tools {
            let name = resolve_tool_name(&tool);
            if let Some(v) = name {
                names.insert(v);
            }
        }
        assert!(names.contains("exec_command"));
        assert!(names.contains("clock"));
        assert!(names.contains("continue_execution"));
        assert!(names.contains("review"));
    }

    #[test]
    fn test_servertool_orchestration_skips_direct_web_search_tool_injection() {
        let input = ToolGovernanceInput {
            request: serde_json::json!({
              "model": "gpt-4o-mini",
              "messages": [{"role": "user", "content": "search latest routecodex news"}],
              "parameters": {
                "stream": true
              }
            }),
            raw_payload: serde_json::json!({}),
            metadata: serde_json::json!({
              "tmuxSessionId": "s-1",
              "__rt": {
                "clock": { "enabled": true },
                "webSearch": {
                  "engines": [
                    {
                      "id": "native-search",
                      "providerKey": "demo.key1.model",
                      "executionMode": "direct",
                      "directActivation": "route"
                    }
                  ]
                }
              }
            }),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_tools_direct_search".to_string(),
            has_active_stop_message_for_continue_execution: None,
        };

        let result = apply_req_process_tool_governance(input).unwrap();
        let tools = result
            .processed_request
            .as_object()
            .and_then(|row| row.get("tools"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut names: HashSet<String> = HashSet::new();
        for tool in tools {
            if let Some(v) = resolve_tool_name(&tool) {
                names.insert(v);
            }
        }
        assert!(!names.contains("websearch"));
        assert!(names.contains("clock"));
        assert!(names.contains("continue_execution"));
    }

    #[test]
    fn test_servertool_orchestration_injects_websearch_for_servertool_engines() {
        let input = ToolGovernanceInput {
            request: serde_json::json!({
              "model": "gpt-4o-mini",
              "messages": [{"role": "user", "content": "please search the web for latest routecodex updates"}],
              "parameters": {
                "stream": true
              }
            }),
            raw_payload: serde_json::json!({}),
            metadata: serde_json::json!({
              "tmuxSessionId": "s-1",
              "__rt": {
                "webSearch": {
                  "engines": [
                    {
                      "id": "servertool-search",
                      "providerKey": "demo.key1.model",
                      "executionMode": "servertool"
                    }
                  ]
                }
              }
            }),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_tools_servertool_search".to_string(),
            has_active_stop_message_for_continue_execution: None,
        };

        let result = apply_req_process_tool_governance(input).unwrap();
        let tools = result
            .processed_request
            .as_object()
            .and_then(|row| row.get("tools"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let mut names: HashSet<String> = HashSet::new();
        for tool in tools {
            if let Some(v) = resolve_tool_name(&tool) {
                names.insert(v);
            }
        }
        assert!(names.contains("websearch"));
    }

    #[test]
    fn test_servertool_orchestration_uses_explicit_stop_message_flag_instead_of_runtime_metadata() {
        let input = ToolGovernanceInput {
            request: serde_json::json!({
              "model": "gpt-4o-mini",
              "messages": [{"role": "user", "content": "hello"}],
              "parameters": {
                "stream": true
              }
            }),
            raw_payload: serde_json::json!({}),
            metadata: serde_json::json!({
              "clientInjectReady": true,
              "__rt": {
                "stopMessageState": {
                  "stopMessageText": "halt",
                  "stopMessageMaxRepeats": 2,
                  "stopMessageStageMode": "on"
                }
              }
            }),
            entry_endpoint: "/v1/chat/completions".to_string(),
            request_id: "req_explicit_stop_flag".to_string(),
            has_active_stop_message_for_continue_execution: Some(false),
        };

        let result = apply_req_process_tool_governance(input).unwrap();
        let tools = result
            .processed_request
            .as_object()
            .and_then(|row| row.get("tools"))
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let mut names: HashSet<String> = HashSet::new();
        for tool in tools {
            if let Some(v) = resolve_tool_name(&tool) {
                names.insert(v);
            }
        }

        assert!(names.contains("continue_execution"));
    }
}

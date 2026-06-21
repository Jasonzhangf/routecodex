use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::{json, Map, Value};

// feature_id: hub.servertool_flow_presentation

fn build_default_servertool_skeleton_document_value() -> serde_json::Value {
    json!({
        "version": 1,
        "servertool": {
            "enabled": true,
            "internalTools": {

                "continue_execution": {
                    "name": "continue_execution",
                    "enabled": true,
                    "kind": "internal",
                    "trigger": { "type": "tool_call", "canonicalName": "continue_execution" },
                    "execution": { "mode": "client_inject_only", "stripAfterExecute": true }
                },
                "stop_message_auto": {
                    "name": "stop_message_auto",
                    "enabled": true,
                    "kind": "internal",
                    "trigger": { "type": "auto", "canonicalName": "stop_message_auto", "phase": "default", "priority": 40 },
                    "execution": { "mode": "auto_hook", "stripAfterExecute": true }
                },
                "web_search": {
                    "name": "web_search",
                    "enabled": true,
                    "kind": "internal",
                    "trigger": { "type": "tool_call", "canonicalName": "web_search" },
                    "execution": { "mode": "backend", "stripAfterExecute": true }
                },
                "recursive_detection_guard": {
                    "name": "recursive_detection_guard",
                    "enabled": true,
                    "kind": "internal",
                    "trigger": { "type": "auto", "canonicalName": "recursive_detection_guard", "phase": "pre", "priority": 5 },
                    "execution": { "mode": "auto_hook", "stripAfterExecute": true }
                },
                "vision_auto": {
                    "name": "vision_auto",
                    "enabled": true,
                    "kind": "internal",
                    "trigger": { "type": "auto", "canonicalName": "vision_auto", "phase": "post", "priority": 60 },
                    "execution": { "mode": "auto_hook", "stripAfterExecute": true }
                },


                "exec_command": {
                    "name": "exec_command",
                    "enabled": true,
                    "kind": "internal",
                    "trigger": { "type": "tool_call", "canonicalName": "exec_command" },
                    "execution": { "mode": "guarded", "stripAfterExecute": true }
                },
            },
            "skeleton": {
                "finalizeStrip": { "enabled": true, "requireFinalizedMarker": true },
                "autoHooks": {
                    "optionalPrimaryOrder": ["vision_auto", "stop_message_auto"],
                    "mandatoryOrder": []
                },
                "pendingInjection": {
                    "messageKinds": ["assistant_tool_calls", "tool_outputs"]
                },
                "progress": {
                    "toolNameByFlowId": {
                        "continue_execution_flow": "continue_execution",
                        "stop_message_flow": "stop_message_auto",
                        "exec_command_guard": "exec_command_guard",
                        "web_search_flow": "web_search",
                        "vision_flow": "vision_auto",
                        "recursive_detection_guard": "recursive_detection_guard"
                    },
                    "goldHighlightFlowIds": ["continue_execution_flow"]
                },
                "followup": {
                    "genericInjectionOps": [
                        "append_assistant_message",
                        "append_tool_messages_from_tool_outputs"
                    ],
                    "nativeSupportedOps": [
                        "append_assistant_message",
                        "append_tool_messages_from_tool_outputs",
                        "append_user_text",
                        "inject_system_text",
                        "inject_vision_summary",
                        "trim_openai_messages",
                        "compact_tool_content"
                    ],
                    "flowPolicy": {
                        "profilesByFlowId": {

                            "exec_command_guard": {
                                "autoLimit": true,
                                "flowOnlyLoopLimit": true
                            },
                            "stop_message_flow": {
                                "noFollowup": true,
                                "seedLoopPayload": true
                            },
                            "reasoning_stop_guard_flow": {},
                            "reasoning_stop_continue_flow": {},
                            "reasoning_stop_finalize_flow": {},
                            "continue_execution_flow": {
                                "contextDecorationMode": "continue_execution_summary"
                            },

                            "web_search_flow": {
                                "contextDecorationMode": "web_search_summary"
                            }
                        }
                    }
                }
            },
            "state": {
                "scopePriority": ["tmux", "session", "conversation"],
                "pendingInjection": {
                    "enabled": true,
                    "strictContract": true
                }
            }
        }
    })
}

fn read_document_from_input(input: &Value) -> Value {
    input
        .get("document")
        .cloned()
        .filter(|value| value.is_object())
        .unwrap_or_else(build_default_servertool_skeleton_document_value)
}

fn normalize_servertool_name(value: Option<&Value>) -> Option<String> {
    let key = value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_ascii_lowercase();
    Some(match key.as_str() {
        "websearch" | "web-search" => "web_search".to_string(),
        _ => key,
    })
}

fn normalize_auto_hook_phase(value: Option<&Value>) -> String {
    match value
        .and_then(Value::as_str)
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("pre" | "before") => "pre".to_string(),
        Some("post" | "after") => "post".to_string(),
        _ => "default".to_string(),
    }
}

fn normalize_integer(value: Option<&Value>) -> Result<i64, String> {
    let value = value.ok_or_else(|| "normalizeInteger: priority is required".to_string())?;
    if let Some(number) = value.as_i64() {
        return Ok(number);
    }
    if let Some(number) = value.as_u64() {
        return i64::try_from(number)
            .map_err(|_| "normalizeInteger: invalid integer value".to_string());
    }
    if let Some(number) = value.as_f64() {
        if number.is_finite() {
            return Ok(number.floor() as i64);
        }
    }
    if let Some(raw) = value.as_str() {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return trimmed
                .parse::<i64>()
                .map_err(|_| "normalizeInteger: invalid integer value".to_string());
        }
    }
    Err("normalizeInteger: invalid integer value".to_string())
}

fn servertool_root(document: &Value) -> Option<&Value> {
    document.get("servertool")
}

fn internal_tools(document: &Value) -> Option<&Map<String, Value>> {
    servertool_root(document)?.get("internalTools")?.as_object()
}

fn skeleton_root(document: &Value) -> Option<&Value> {
    servertool_root(document)?.get("skeleton")
}

fn state_root(document: &Value) -> Option<&Value> {
    servertool_root(document)?.get("state")
}

fn get_tool_spec<'a>(document: &'a Value, name: &str) -> Option<&'a Value> {
    let canonical = normalize_servertool_name(Some(&Value::String(name.to_string())))?;
    internal_tools(document)?.get(&canonical)
}

fn read_trimmed_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn normalize_name_array(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| normalize_servertool_name(Some(item)))
                .filter(|item| !item.is_empty())
                .map(Value::String)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn normalize_string_array(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| read_trimmed_string(Some(item)))
                .map(Value::String)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn normalize_message_kinds(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    normalize_servertool_name(Some(item))
                        .or_else(|| read_trimmed_string(Some(item)))
                })
                .filter(|item| !item.is_empty())
                .map(Value::String)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn build_progress_config(document: &Value) -> Value {
    let progress = skeleton_root(document)
        .and_then(|value| value.get("progress"))
        .unwrap_or(&Value::Null);
    let tool_name_by_flow_id = progress
        .get("toolNameByFlowId")
        .and_then(Value::as_object)
        .map(|items| {
            let mut output = Map::new();
            for (key, value) in items {
                let flow_id = key.trim();
                let Some(tool_name) = read_trimmed_string(Some(value)) else {
                    continue;
                };
                if !flow_id.is_empty() {
                    output.insert(flow_id.to_string(), Value::String(tool_name));
                }
            }
            Value::Object(output)
        })
        .unwrap_or_else(|| Value::Object(Map::new()));
    json!({
        "toolNameByFlowId": tool_name_by_flow_id,
        "goldHighlightFlowIds": normalize_string_array(progress.get("goldHighlightFlowIds"))
    })
}

fn normalize_flow_id(value: Option<&Value>) -> Option<String> {
    read_trimmed_string(value)
}

fn resolve_progress_tool_name(document: &Value, flow_id: &str) -> String {
    let Some(normalized) = normalize_flow_id(Some(&Value::String(flow_id.to_string()))) else {
        return "unknown".to_string();
    };
    let progress = build_progress_config(document);
    progress
        .get("toolNameByFlowId")
        .and_then(Value::as_object)
        .and_then(|record| record.get(&normalized))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or(normalized)
}

fn should_use_gold_progress_highlight(document: &Value, flow_id: &str) -> bool {
    let Some(normalized) = normalize_flow_id(Some(&Value::String(flow_id.to_string()))) else {
        return false;
    };
    let progress = build_progress_config(document);
    progress
        .get("goldHighlightFlowIds")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| read_trimmed_string(Some(item)))
                .any(|item| item == normalized)
        })
        .unwrap_or(false)
}

fn build_followup_config(document: &Value) -> Value {
    let followup = skeleton_root(document)
        .and_then(|value| value.get("followup"))
        .unwrap_or(&Value::Null);
    let profiles = followup
        .get("flowPolicy")
        .and_then(|value| value.get("profilesByFlowId"))
        .and_then(Value::as_object)
        .map(|items| {
            let mut output = Map::new();
            for (key, value) in items {
                let flow_id = key.trim();
                if flow_id.is_empty() {
                    continue;
                }
                let profile = value.as_object();
                let mut normalized = Map::new();
                for field in [
                    "noFollowup",
                    "autoLimit",
                    "flowOnlyLoopLimit",
                    "clientInjectOnly",
                    "clearStateOnFollowupFailure",
                    "seedLoopPayload",
                    "ignoreRequiresActionFollowup",
                ] {
                    if profile
                        .and_then(|item| item.get(field))
                        .and_then(Value::as_bool)
                        == Some(true)
                    {
                        normalized.insert(field.to_string(), Value::Bool(true));
                    }
                }
                for field in ["clientInjectSource", "transparentReplayRequestSuffix"] {
                    if let Some(text) =
                        profile.and_then(|item| read_trimmed_string(item.get(field)))
                    {
                        normalized.insert(field.to_string(), Value::String(text));
                    }
                }
                if let Some(mode) =
                    profile.and_then(|item| read_trimmed_string(item.get("contextDecorationMode")))
                {
                    if matches!(
                        mode.as_str(),
                        "continue_execution_summary" | "web_search_summary"
                    ) {
                        normalized.insert("contextDecorationMode".to_string(), Value::String(mode));
                    }
                }
                output.insert(flow_id.to_string(), Value::Object(normalized));
            }
            Value::Object(output)
        })
        .unwrap_or_else(|| Value::Object(Map::new()));
    json!({
        "genericInjectionOps": normalize_string_array(followup.get("genericInjectionOps")),
        "nativeSupportedOps": normalize_string_array(followup.get("nativeSupportedOps")),
        "flowPolicy": {
            "profilesByFlowId": profiles,
            "noFollowupFlowIds": [],
            "autoLimitFlowIds": [],
            "flowOnlyLoopLimitFlowIds": [],
            "clientInjectOnlyFlowIds": [],
            "seedLoopPayloadFlowIds": [],
            "clientInjectSourceByFlowId": {},
            "transparentReplayRequestSuffixByFlowId": {},
            "ignoreRequiresActionFollowupFlowIds": [],
            "contextDecorationModeByFlowId": {}
        }
    })
}

fn build_state_config(document: &Value) -> Value {
    let state = state_root(document).unwrap_or(&Value::Null);
    let pending = state.get("pendingInjection").unwrap_or(&Value::Null);
    json!({
        "scopePriority": normalize_name_array(state.get("scopePriority")),
        "pendingInjection": {
            "enabled": pending.get("enabled").and_then(Value::as_bool) != Some(false),
            "strictContract": pending.get("strictContract").and_then(Value::as_bool) != Some(false)
        }
    })
}

fn build_derived_config(document: Value) -> Value {
    let skeleton = skeleton_root(&document).unwrap_or(&Value::Null);
    let auto_hooks = skeleton.get("autoHooks").unwrap_or(&Value::Null);
    let pending_injection = skeleton.get("pendingInjection").unwrap_or(&Value::Null);
    let tool_specs = internal_tools(&document)
        .cloned()
        .map(Value::Object)
        .unwrap_or_else(|| Value::Object(Map::new()));
    let tool_spec_list = internal_tools(&document)
        .map(|items| items.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    json!({
        "document": document,
        "toolSpecs": tool_specs,
        "toolSpecList": tool_spec_list,
        "autoHookQueueConfig": {
            "optionalPrimaryOrder": normalize_name_array(auto_hooks.get("optionalPrimaryOrder")),
            "mandatoryOrder": normalize_name_array(auto_hooks.get("mandatoryOrder"))
        },
        "pendingInjectionConfig": {
            "messageKinds": normalize_message_kinds(pending_injection.get("messageKinds"))
        },
        "progressConfig": build_progress_config(&document),
        "followupConfig": build_followup_config(&document),
        "stateConfig": build_state_config(&document)
    })
}

#[napi]
pub fn get_default_servertool_skeleton_document_json() -> NapiResult<String> {
    let output = build_default_servertool_skeleton_document_value();
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn plan_servertool_skeleton_derived_config_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let document = read_document_from_input(&input);
    let output = build_derived_config(document);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn build_servertool_dispatch_plan_input_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let document = read_document_from_input(&input);
    let derived = build_derived_config(document);
    let tool_specs = derived
        .get("toolSpecList")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut registered = Vec::new();
    for spec in tool_specs {
        if spec.get("enabled").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        if spec
            .get("trigger")
            .and_then(|value| value.get("type"))
            .and_then(Value::as_str)
            != Some("tool_call")
        {
            continue;
        }
        let Some(name) = normalize_servertool_name(spec.get("name")) else {
            continue;
        };
        let execution = spec.get("execution").unwrap_or(&Value::Null);
        let execution_mode = read_trimmed_string(execution.get("mode"))
            .unwrap_or_else(|| "guarded".to_string());
        let strip_after_execute =
            execution.get("stripAfterExecute").and_then(Value::as_bool) != Some(false);
        registered.push(json!({
            "name": name,
            "trigger": "tool_call",
            "executionMode": execution_mode,
            "stripAfterExecute": strip_after_execute
        }));
    }
    if let Some(ad_hoc) = input
        .get("adHocRegisteredToolCallHandlers")
        .and_then(Value::as_array)
    {
        for entry in ad_hoc {
            let Some(name) = normalize_servertool_name(entry.get("name")) else {
                continue;
            };
            let execution_mode = read_trimmed_string(entry.get("executionMode"))
                .unwrap_or_else(|| "guarded".to_string());
            let strip_after_execute =
                entry.get("stripAfterExecute").and_then(Value::as_bool) != Some(false);
            registered.push(json!({
                "name": name,
                "trigger": "tool_call",
                "executionMode": execution_mode,
                "stripAfterExecute": strip_after_execute
            }));
        }
    }
    let output = json!({
        "toolCalls": input.get("toolCalls").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
        "disableToolCallHandlers": input.get("disableToolCallHandlers").and_then(Value::as_bool).unwrap_or(false),
        "includeToolCallHandlerNames": input.get("includeToolCallHandlerNames").cloned().unwrap_or(Value::Null),
        "excludeToolCallHandlerNames": input.get("excludeToolCallHandlerNames").cloned().unwrap_or(Value::Null),
        "registeredToolCallHandlers": registered,
        "runtimeMetadata": input.get("runtimeMetadata").cloned().unwrap_or(Value::Null)
    });
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn build_servertool_outcome_plan_input_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let execution_state = input.get("executionState").unwrap_or(&Value::Null);
    let adapter_context = input.get("adapterContext").unwrap_or(&Value::Null);
    let base_for_execution = input.get("baseForExecution").unwrap_or(&Value::Null);
    let executed_tool_calls = execution_state
        .get("executedToolCalls")
        .and_then(Value::as_array)
        .map(|records| {
            records
                .iter()
                .filter_map(|record| record.get("toolCall"))
                .filter_map(|tool_call| {
                    Some(json!({
                        "id": read_trimmed_string(tool_call.get("id"))?,
                        "name": read_trimmed_string(tool_call.get("name"))?,
                        "arguments": read_trimmed_string(tool_call.get("arguments")).unwrap_or_default(),
                        "executionMode": read_trimmed_string(tool_call.get("executionMode")).unwrap_or_else(|| "guarded".to_string()),
                        "stripAfterExecute": tool_call.get("stripAfterExecute").and_then(Value::as_bool) != Some(false)
                    }))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let session_id = input
        .get("sessionId")
        .cloned()
        .or_else(|| {
            adapter_context
                .as_object()
                .and_then(|row| row.get("sessionId"))
                .cloned()
        })
        .unwrap_or(Value::Null);
    let conversation_id = input
        .get("conversationId")
        .cloned()
        .or_else(|| {
            adapter_context
                .as_object()
                .and_then(|row| row.get("conversationId"))
                .cloned()
        })
        .unwrap_or(Value::Null);
    let tool_outputs = input
        .get("toolOutputs")
        .cloned()
        .or_else(|| {
            base_for_execution
                .as_object()
                .and_then(|row| row.get("tool_outputs"))
                .cloned()
        })
        .unwrap_or(Value::Null);
    let output = json!({
        "toolCalls": input.get("toolCalls").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
        "executedToolCalls": executed_tool_calls,
        "executedFlowIds": execution_state.get("executedFlowIds").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
        "lastExecutionFlowId": execution_state.get("lastExecution").and_then(|value| value.get("flowId")).cloned().unwrap_or(Value::Null),
        "hasLastExecutionFollowup": execution_state.get("lastExecution").and_then(|value| value.get("followup")).is_some(),
        "sessionId": session_id,
        "conversationId": conversation_id,
        "toolOutputs": tool_outputs,
        "pendingInjectionMessageKinds": input.get("pendingInjectionMessageKinds").cloned().unwrap_or(Value::Null)
    });
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn plan_servertool_handler_contract_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let has_finalize = input
        .get("hasFinalizeFunction")
        .and_then(Value::as_bool)
        == Some(true);
    let has_chat_response = input
        .get("hasChatResponseObject")
        .and_then(Value::as_bool)
        == Some(true);
    let has_execution = input
        .get("hasExecutionObject")
        .and_then(Value::as_bool)
        == Some(true);
    let has_execution_flow_id = input
        .get("hasExecutionFlowId")
        .and_then(Value::as_bool)
        == Some(true);
    let has_plan_markers = input
        .get("hasPlanMarkers")
        .and_then(Value::as_bool)
        == Some(true);
    let action = if has_finalize {
        "handler_plan"
    } else if has_chat_response && has_execution && has_execution_flow_id {
        "handler_result"
    } else if has_plan_markers {
        "invalid_plan_missing_finalize"
    } else {
        "invalid_contract"
    };
    serde_json::to_string(&json!({ "action": action }))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn plan_servertool_backend_execution_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let kind = read_trimmed_string(input.get("kind")).unwrap_or_else(|| "unknown".to_string());
    let action = match kind.as_str() {
        "vision_analysis" => "vision_analysis",
        "web_search" => "web_search",
        _ => "unsupported",
    };
    serde_json::to_string(&json!({ "action": action, "backendKind": kind }))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn normalize_servertool_registration_spec_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let document = read_document_from_input(&input);
    let canonical = normalize_servertool_name(input.get("name"));
    let Some(canonical) = canonical.filter(|value| !value.is_empty()) else {
        return Ok("null".to_string());
    };
    let options = input.get("options").and_then(Value::as_object);
    let tool_spec = get_tool_spec(&document, &canonical);
    let trigger = tool_spec
        .and_then(|tool| tool.get("trigger"))
        .and_then(|trigger| read_trimmed_string(trigger.get("type")))
        .or_else(|| options.and_then(|item| read_trimmed_string(item.get("trigger"))))
        .unwrap_or_else(|| "tool_call".to_string());
    let execution_mode = tool_spec
        .and_then(|tool| tool.get("execution"))
        .and_then(|execution| read_trimmed_string(execution.get("mode")))
        .or_else(|| options.and_then(|item| read_trimmed_string(item.get("executionMode"))))
        .unwrap_or_else(|| {
            if trigger == "auto" {
                "auto_hook".to_string()
            } else {
                "guarded".to_string()
            }
        });
    let enabled = tool_spec
        .and_then(|tool| tool.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let strip_after_execute = tool_spec
        .and_then(|tool| tool.get("execution"))
        .and_then(|execution| execution.get("stripAfterExecute"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let mut output = Map::new();
    output.insert("name".to_string(), Value::String(canonical.clone()));
    output.insert("enabled".to_string(), Value::Bool(enabled));
    output.insert("trigger".to_string(), Value::String(trigger.clone()));
    output.insert("executionMode".to_string(), Value::String(execution_mode));
    output.insert(
        "stripAfterExecute".to_string(),
        Value::Bool(strip_after_execute),
    );
    if trigger == "auto" {
        let hook = options
            .and_then(|item| item.get("hook"))
            .and_then(Value::as_object);
        let trigger_node = tool_spec.and_then(|tool| tool.get("trigger"));
        let phase = normalize_auto_hook_phase(
            trigger_node
                .and_then(|trigger| trigger.get("phase"))
                .or_else(|| hook.and_then(|item| item.get("phase")))
                .or_else(|| options.and_then(|item| item.get("phase"))),
        );
        let raw_priority = trigger_node
            .and_then(|trigger| trigger.get("priority"))
            .or_else(|| hook.and_then(|item| item.get("priority")))
            .or_else(|| options.and_then(|item| item.get("priority")));
        let priority = normalize_integer(raw_priority).map_err(napi::Error::from_reason)?;
        output.insert(
            "autoHook".to_string(),
            json!({
                "id": canonical,
                "phase": phase,
                "priority": priority
            }),
        );
    }
    serde_json::to_string(&Value::Object(output))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_servertool_tool_spec_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let document = read_document_from_input(&input);
    let canonical = normalize_servertool_name(input.get("name"));
    let Some(canonical) = canonical.filter(|value| !value.is_empty()) else {
        return Ok("null".to_string());
    };
    let output = get_tool_spec(&document, &canonical)
        .cloned()
        .unwrap_or(Value::Null);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn resolve_servertool_progress_tool_name_json(input_json: String) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let document = read_document_from_input(&input);
    let flow_id = read_trimmed_string(input.get("flowId")).unwrap_or_default();
    let output = resolve_progress_tool_name(&document, &flow_id);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn should_use_servertool_gold_progress_highlight_json(
    input_json: String,
) -> NapiResult<String> {
    let input: Value =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let document = read_document_from_input(&input);
    let flow_id = read_trimmed_string(input.get("flowId")).unwrap_or_default();
    let output = should_use_gold_progress_highlight(&document, &flow_id);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

fn resolve_servertool_followup_flow_profile(flow_id: &str) -> Value {
    let normalized_flow_id = flow_id.trim();
    if normalized_flow_id.is_empty() {
        return Value::Null;
    }
    let output = build_default_servertool_skeleton_document_value();
    output
        .get("servertool")
        .and_then(|v| v.get("skeleton"))
        .and_then(|v| v.get("followup"))
        .and_then(|v| v.get("flowPolicy"))
        .and_then(|v| v.get("profilesByFlowId"))
        .and_then(|v| v.get(normalized_flow_id))
        .cloned()
        .unwrap_or(Value::Null)
}

#[napi]
pub fn plan_servertool_followup_runtime_json(flow_id: String) -> NapiResult<String> {
    let normalized_flow_id = flow_id.trim().to_string();
    let profile = resolve_servertool_followup_flow_profile(&normalized_flow_id);
    let profile_obj = profile.as_object();
    let runtime_plan = json!({
        "flowId": if normalized_flow_id.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(normalized_flow_id.clone()) },
        "outcomeMode": if profile_obj.and_then(|v| v.get("noFollowup")).and_then(|v| v.as_bool()) == Some(true) {
            "skip"
        } else if profile_obj.and_then(|v| v.get("clientInjectOnly")).and_then(|v| v.as_bool()) == Some(true) {
            "client_inject_only"
        } else {
            "reenter"
        },
        "noFollowup": profile_obj.and_then(|v| v.get("noFollowup")).and_then(|v| v.as_bool()).unwrap_or(false),
        "autoLimit": profile_obj.and_then(|v| v.get("autoLimit")).and_then(|v| v.as_bool()).unwrap_or(false),
        "flowOnlyLoopLimit": profile_obj.and_then(|v| v.get("flowOnlyLoopLimit")).and_then(|v| v.as_bool()).unwrap_or(false),
        "clientInjectOnly": profile_obj.and_then(|v| v.get("clientInjectOnly")).and_then(|v| v.as_bool()).unwrap_or(false),
        "clearStateOnFollowupFailure": profile_obj.and_then(|v| v.get("clearStateOnFollowupFailure")).and_then(|v| v.as_bool()).unwrap_or(false),
        "seedLoopPayload": profile_obj.and_then(|v| v.get("seedLoopPayload")).and_then(|v| v.as_bool()).unwrap_or(false),
        "ignoreRequiresActionFollowup": profile_obj.and_then(|v| v.get("ignoreRequiresActionFollowup")).and_then(|v| v.as_bool()).unwrap_or(false),
        "clientInjectSource": profile_obj.and_then(|v| v.get("clientInjectSource")).cloned().unwrap_or(serde_json::Value::Null),
        "transparentReplayRequestSuffix": profile_obj.and_then(|v| v.get("transparentReplayRequestSuffix")).cloned().unwrap_or(serde_json::Value::Null),
        "contextDecorationMode": profile_obj.and_then(|v| v.get("contextDecorationMode")).cloned().unwrap_or(serde_json::Value::Null)
    });
    serde_json::to_string(&runtime_plan).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::{
        build_servertool_dispatch_plan_input_json,
        build_servertool_outcome_plan_input_json,
        get_default_servertool_skeleton_document_json, normalize_servertool_registration_spec_json,
        plan_servertool_backend_execution_json, plan_servertool_handler_contract_json,
        plan_servertool_followup_runtime_json, plan_servertool_skeleton_derived_config_json,
        resolve_servertool_followup_flow_profile, resolve_servertool_progress_tool_name_json,
        resolve_servertool_tool_spec_json, should_use_servertool_gold_progress_highlight_json,
    };
    use serde_json::{json, Value};

    #[test]
    fn returns_servertool_skeleton_document() {
        let raw = get_default_servertool_skeleton_document_json().expect("skeleton json");
        let parsed: Value = serde_json::from_str(&raw).expect("parse skeleton");
        assert_eq!(parsed.get("version").and_then(|v| v.as_i64()), Some(1));
        assert_eq!(
            parsed
                .get("servertool")
                .and_then(|v| v.get("enabled"))
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert!(parsed
            .get("servertool")
            .and_then(|v| v.get("internalTools"))
            .is_some());
    }

    #[test]
    fn builds_dispatch_plan_input_from_rust_skeleton_config() {
        let raw = build_servertool_dispatch_plan_input_json(json!({
            "toolCalls": [{ "id": "call_1", "name": "web_search", "arguments": "{}" }],
            "disableToolCallHandlers": false,
            "adHocRegisteredToolCallHandlers": []
        }).to_string()).expect("dispatch plan input json");
        let parsed: Value = serde_json::from_str(&raw).expect("parse dispatch plan input");
        assert_eq!(
            parsed
                .get("registeredToolCallHandlers")
                .and_then(Value::as_array)
                .unwrap()
                .iter()
                .any(|entry| entry.get("name").and_then(Value::as_str) == Some("web_search")
                    && entry.get("executionMode").and_then(Value::as_str) == Some("backend")),
            true
        );
    }

    #[test]
    fn builds_outcome_plan_input_from_execution_state() {
        let raw = build_servertool_outcome_plan_input_json(json!({
            "toolCalls": [{ "id": "call_1", "name": "web_search", "arguments": "{}" }],
            "executionState": {
                "executedToolCalls": [{
                    "toolCall": {
                        "id": "call_1",
                        "name": "web_search",
                        "arguments": "{}",
                        "executionMode": "backend",
                        "stripAfterExecute": true
                    }
                }],
                "executedFlowIds": ["web_search_ok"],
                "lastExecution": { "flowId": "web_search_ok", "followup": { "requestIdSuffix": ":x" } }
            },
            "sessionId": "sess_1"
        }).to_string()).expect("outcome input json");
        let parsed: Value = serde_json::from_str(&raw).expect("parse outcome input");
        assert_eq!(parsed["executedToolCalls"][0]["name"], json!("web_search"));
        assert_eq!(parsed["lastExecutionFlowId"], json!("web_search_ok"));
        assert_eq!(parsed["hasLastExecutionFollowup"], json!(true));
        assert_eq!(parsed["sessionId"], json!("sess_1"));
    }

    #[test]
    fn builds_outcome_plan_input_from_adapter_context_and_base_for_execution() {
        let raw = build_servertool_outcome_plan_input_json(json!({
            "toolCalls": [{ "id": "call_1", "name": "web_search", "arguments": "{}" }],
            "executionState": {
                "executedToolCalls": [],
                "executedFlowIds": []
            },
            "adapterContext": {
                "sessionId": "sess_outcome_1",
                "conversationId": "conv_outcome_1"
            },
            "baseForExecution": {
                "tool_outputs": [{
                    "tool_call_id": "call_1",
                    "name": "web_search",
                    "content": "ok"
                }]
            }
        }).to_string()).expect("outcome input json");
        let parsed: Value = serde_json::from_str(&raw).expect("parse outcome input");
        assert_eq!(parsed["sessionId"], json!("sess_outcome_1"));
        assert_eq!(parsed["conversationId"], json!("conv_outcome_1"));
        assert_eq!(parsed["toolOutputs"][0]["tool_call_id"], json!("call_1"));
    }

    #[test]
    fn plans_handler_and_backend_contracts() {
        let handler = plan_servertool_handler_contract_json(json!({
            "hasFinalizeFunction": false,
            "hasChatResponseObject": false,
            "hasExecutionObject": false,
            "hasExecutionFlowId": false,
            "hasPlanMarkers": true
        }).to_string()).expect("handler contract");
        let parsed: Value = serde_json::from_str(&handler).expect("parse handler contract");
        assert_eq!(parsed["action"], json!("invalid_plan_missing_finalize"));

        let backend = plan_servertool_backend_execution_json(json!({
            "kind": "web_search"
        }).to_string()).expect("backend execution contract");
        let parsed: Value = serde_json::from_str(&backend).expect("parse backend contract");
        assert_eq!(parsed["action"], json!("web_search"));
    }

    #[test]
    fn skeleton_does_not_register_apply_patch_servertool() {
        let raw = get_default_servertool_skeleton_document_json().expect("skeleton json");
        let parsed: Value = serde_json::from_str(&raw).expect("parse skeleton");
        let internal_tools = parsed
            .get("servertool")
            .and_then(|v| v.get("internalTools"))
            .and_then(|v| v.as_object())
            .expect("internal tools object");
        assert!(!internal_tools.contains_key("apply_patch"));

        let progress = parsed
            .get("servertool")
            .and_then(|v| v.get("skeleton"))
            .and_then(|v| v.get("progress"))
            .and_then(|v| v.get("toolNameByFlowId"))
            .and_then(|v| v.as_object())
            .expect("toolNameByFlowId object");
        assert!(!progress.contains_key("apply_patch_guard"));

        let profiles = parsed
            .get("servertool")
            .and_then(|v| v.get("skeleton"))
            .and_then(|v| v.get("followup"))
            .and_then(|v| v.get("flowPolicy"))
            .and_then(|v| v.get("profilesByFlowId"))
            .and_then(|v| v.as_object())
            .expect("profilesByFlowId object");
        assert!(!profiles.contains_key("apply_patch_guard"));
        assert!(!profiles.contains_key("apply_patch_read_before_retry_guard"));
    }

    #[test]
    fn stop_message_followup_runtime_plan_uses_skip_not_client_inject() {
        let raw = plan_servertool_followup_runtime_json("stop_message_flow".to_string())
            .expect("runtime plan json");
        let parsed: Value = serde_json::from_str(&raw).expect("parse runtime plan");
        assert_eq!(
            parsed.get("outcomeMode").and_then(|v| v.as_str()),
            Some("skip")
        );
        assert_eq!(
            parsed.get("clientInjectOnly").and_then(|v| v.as_bool()),
            Some(false)
        );
        assert_eq!(
            parsed.get("seedLoopPayload").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert!(parsed.get("stopMessageFollowupPolicy").is_none());
    }

    #[test]
    fn skeleton_owns_vision_auto_hook_order() {
        let raw = get_default_servertool_skeleton_document_json().expect("skeleton json");
        let parsed: Value = serde_json::from_str(&raw).expect("parse skeleton");
        let internal_tools = parsed
            .get("servertool")
            .and_then(|v| v.get("internalTools"))
            .and_then(|v| v.as_object())
            .expect("internal tools object");
        assert!(internal_tools.contains_key("vision_auto"));
        assert_eq!(
            internal_tools["vision_auto"]
                .get("trigger")
                .and_then(|v| v.get("type"))
                .and_then(|v| v.as_str()),
            Some("auto")
        );
        let optional = parsed
            .get("servertool")
            .and_then(|v| v.get("skeleton"))
            .and_then(|v| v.get("autoHooks"))
            .and_then(|v| v.get("optionalPrimaryOrder"))
            .and_then(|v| v.as_array())
            .expect("optional primary order");
        let ids = optional
            .iter()
            .filter_map(|item| item.as_str())
            .collect::<Vec<_>>();
        assert_eq!(ids, vec!["vision_auto", "stop_message_auto"]);
    }

    #[test]
    fn derived_config_normalizes_names_and_followup_profiles_in_rust() {
        let raw =
            plan_servertool_skeleton_derived_config_json(json!({}).to_string()).expect("derived");
        let parsed: Value = serde_json::from_str(&raw).expect("parse derived");
        assert_eq!(
            parsed["autoHookQueueConfig"]["optionalPrimaryOrder"],
            json!(["vision_auto", "stop_message_auto"])
        );
        assert_eq!(
            parsed["pendingInjectionConfig"]["messageKinds"],
            json!(["assistant_tool_calls", "tool_outputs"])
        );
        assert_eq!(
            parsed["followupConfig"]["flowPolicy"]["profilesByFlowId"]["stop_message_flow"]
                ["seedLoopPayload"],
            true
        );
        assert!(
            parsed["followupConfig"]["flowPolicy"]["profilesByFlowId"]["web_search_flow"]
                ["contextDecorationMode"]
                .as_str()
                .is_some()
        );
        assert_eq!(
            parsed["stateConfig"]["scopePriority"],
            json!(["tmux", "session", "conversation"])
        );
    }

    #[test]
    fn registration_spec_uses_rust_alias_phase_and_priority_policy() {
        let raw = normalize_servertool_registration_spec_json(
            json!({
                "name": "WEB-SEARCH",
                "options": { "trigger": "tool_call" }
            })
            .to_string(),
        )
        .expect("registration");
        let parsed: Value = serde_json::from_str(&raw).expect("parse registration");
        assert_eq!(parsed["name"], "web_search");
        assert_eq!(parsed["trigger"], "tool_call");
        assert_eq!(parsed["executionMode"], "backend");

        let auto_raw = normalize_servertool_registration_spec_json(
            json!({
                "name": " custom_auto ",
                "options": {
                    "trigger": "auto",
                    "hook": { "phase": "before", "priority": "7" }
                }
            })
            .to_string(),
        )
        .expect("auto registration");
        let auto: Value = serde_json::from_str(&auto_raw).expect("parse auto");
        assert_eq!(auto["name"], "custom_auto");
        assert_eq!(auto["autoHook"]["phase"], "pre");
        assert_eq!(auto["autoHook"]["priority"], 7);
        assert_eq!(auto["executionMode"], "auto_hook");
    }

    #[test]
    fn resolves_tool_spec_with_rust_name_alias_policy() {
        let raw = resolve_servertool_tool_spec_json(json!({ "name": "web-search" }).to_string())
            .expect("tool spec");
        let parsed: Value = serde_json::from_str(&raw).expect("parse tool spec");
        assert_eq!(parsed["name"], "web_search");
        assert_eq!(parsed["execution"]["mode"], "backend");

        let missing =
            resolve_servertool_tool_spec_json(json!({ "name": "reasoningStop" }).to_string())
                .expect("missing tool spec");
        assert_eq!(missing, "null");
    }

    #[test]
    fn resolves_progress_presentation_from_skeleton_config() {
        let known = resolve_servertool_progress_tool_name_json(
            json!({ "flowId": " web_search_flow " }).to_string(),
        )
        .expect("progress tool");
        assert_eq!(known, "\"web_search\"");

        let unknown = resolve_servertool_progress_tool_name_json(
            json!({ "flowId": " custom_flow " }).to_string(),
        )
        .expect("unknown progress tool");
        assert_eq!(unknown, "\"custom_flow\"");

        let empty =
            resolve_servertool_progress_tool_name_json(json!({ "flowId": "   " }).to_string())
                .expect("empty progress tool");
        assert_eq!(empty, "\"unknown\"");

        let gold = should_use_servertool_gold_progress_highlight_json(
            json!({ "flowId": " continue_execution_flow " }).to_string(),
        )
        .expect("gold highlight");
        assert_eq!(gold, "true");

        let regular = should_use_servertool_gold_progress_highlight_json(
            json!({ "flowId": " web_search_flow " }).to_string(),
        )
        .expect("regular highlight");
        assert_eq!(regular, "false");
    }

    #[test]
    fn apply_patch_followup_profile_is_gone() {
        let profile =
            resolve_servertool_followup_flow_profile("apply_patch_read_before_retry_guard");
        assert_eq!(profile, Value::Null);
    }

    #[test]
    fn removes_unwired_servertool_skeleton_stub_stages() {
        let raw = get_default_servertool_skeleton_document_json().expect("skeleton json");
        let parsed: Value = serde_json::from_str(&raw).expect("parse skeleton");
        let skeleton = parsed
            .get("servertool")
            .and_then(|v| v.get("skeleton"))
            .and_then(|v| v.as_object())
            .expect("skeleton object");
        assert!(!skeleton.contains_key("requestPrepare"));
        assert!(!skeleton.contains_key("internalDispatch"));
    }
}

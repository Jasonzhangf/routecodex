use super::web_search_hop::{first_local_websearch_tool_call, hosted_web_search_result_text};
use super::{
    V3HubRelayRequestError, V3HubRelayRequestHookEvent, V3HubRelayResponseError,
    V3HubRelayResponseHookProfile, V3HubRespInbound02Normalized, V3ServerToolName,
    V3WebSearchCenterPhase, V3WebSearchCenterState,
};
use serde_json::{json, Value};
use servertool_core::cli_contract::{
    build_client_exec_cli_projection_output, parse_servertool_cli_projection_tool_arguments,
    ServertoolCliProjectionToolArgumentsInput,
};
use servertool_core::outcome_contract::is_client_exec_cli_projection;
use std::collections::BTreeSet;
use std::sync::Arc;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct V3ToolThinkingTurnContext {
    enabled: bool,
    original_custom_tool_names: BTreeSet<String>,
}

impl V3ToolThinkingTurnContext {
    pub(crate) fn disabled() -> Self {
        Self::default()
    }

    pub(crate) fn enabled(original_custom_tool_names: BTreeSet<String>) -> Self {
        Self {
            enabled: true,
            original_custom_tool_names,
        }
    }

    pub(crate) fn enabled_flag(&self) -> bool {
        self.enabled
    }

    pub(crate) fn is_original_custom_tool(&self, name: &str) -> bool {
        self.original_custom_tool_names.contains(name)
    }

    pub(crate) fn original_custom_tool_names(&self) -> Option<&BTreeSet<String>> {
        self.enabled.then_some(&self.original_custom_tool_names)
    }
}

pub(crate) fn inject_v3_tool_thinking_guidance_at_req04(
    payload: &mut Value,
    current_payload_start: usize,
    enabled: bool,
) -> Result<(), V3HubRelayRequestError> {
    let _ =
        compile_v3_tool_thinking_turn_context_at_req04(payload, current_payload_start, enabled)?;
    Ok(())
}

pub(crate) fn compile_v3_tool_thinking_turn_context_at_req04(
    payload: &mut Value,
    current_payload_start: usize,
    enabled: bool,
) -> Result<V3ToolThinkingTurnContext, V3HubRelayRequestError> {
    if !enabled || payload.get("contents").is_some() || payload.get("system_instruction").is_some()
    {
        return Ok(V3ToolThinkingTurnContext::disabled());
    }
    inject_v3_tool_thinking_fields_into_tool_schemas(payload)
        .map_err(|reason| V3HubRelayRequestError::ToolThinkingSchemaInvalid { reason })?;
    let original_custom_tool_names = wrap_v3_custom_tools_at_req04(payload)?;
    if let Some(messages) = payload.get("messages").and_then(Value::as_array) {
        if current_payload_start > messages.len() {
            return Err(V3HubRelayRequestError::CurrentPayloadBoundaryInvalid {
                start: current_payload_start,
                len: messages.len(),
            });
        }
    }
    Ok(V3ToolThinkingTurnContext::enabled(
        original_custom_tool_names,
    ))
}

fn wrap_v3_custom_tools_at_req04(
    payload: &mut Value,
) -> Result<BTreeSet<String>, V3HubRelayRequestError> {
    let Some(tools) = payload.get_mut("tools").and_then(Value::as_array_mut) else {
        return Ok(BTreeSet::new());
    };
    let mut names = BTreeSet::new();
    for (index, tool) in tools.iter_mut().enumerate() {
        let Some(row) = tool.as_object() else {
            continue;
        };
        if row.get("type").and_then(Value::as_str) != Some("custom") {
            continue;
        }
        let name = row
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| V3HubRelayRequestError::ToolThinkingSchemaInvalid {
                reason: format!("custom tool at $.tools[{index}] has no non-empty name"),
            })?
            .to_string();
        if name.eq_ignore_ascii_case("apply_patch") {
            continue;
        }
        let mut function = serde_json::Map::new();
        function.insert("name".to_string(), Value::String(name.clone()));
        if let Some(description) = row.get("description") {
            function.insert("description".to_string(), description.clone());
        }
        function.insert(
            "parameters".to_string(),
            json!({
                "type":"object",
                "properties":{
                    "input":{"type":"string"},
                    "reason":{"type":"string","minLength":1,"maxLength":50},
                    "goal_alignment_confidence":{"type":"integer","minimum":0,"maximum":100}
                },
                "required":["input","reason","goal_alignment_confidence"],
                "additionalProperties":false
            }),
        );
        *tool = json!({"type":"function","function":function});
        names.insert(name);
    }
    Ok(names)
}

pub(crate) fn current_v3_tool_thinking_payload_start(payload: &Value) -> Result<usize, String> {
    for field in ["messages", "input"] {
        let Some(items) = payload.get(field).and_then(Value::as_array) else {
            continue;
        };
        return items
            .iter()
            .rposition(|item| item.get("role").and_then(Value::as_str) == Some("user"))
            .ok_or_else(|| format!("Responses {field} array has no current user message"));
    }
    Ok(0)
}

pub(crate) fn is_v3_tool_thinking_output_continuation(
    payload: &Value,
    previous_response_id: Option<&str>,
) -> bool {
    if !previous_response_id.is_some_and(|value| !value.trim().is_empty()) {
        return false;
    }
    payload
        .get("input")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            !items.is_empty()
                && items.iter().all(|item| {
                    matches!(
                        item.get("type").and_then(Value::as_str),
                        Some(
                            "function_call_output" | "custom_tool_call_output" | "tool_call_output"
                        )
                    )
                })
        })
}

fn inject_v3_tool_thinking_fields_into_tool_schemas(payload: &mut Value) -> Result<(), String> {
    let Some(tools) = payload.get_mut("tools").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    for tool in tools {
        inject_v3_tool_thinking_fields_into_tool(tool)?;
    }
    Ok(())
}

fn inject_v3_tool_thinking_fields_into_tool(tool: &mut Value) -> Result<(), String> {
    for field in ["input_schema", "parameters"] {
        if let Some(schema) = tool.get_mut(field) {
            inject_v3_tool_thinking_fields_into_schema(schema)?;
        }
    }
    if let Some(schema) = tool
        .get_mut("function")
        .and_then(Value::as_object_mut)
        .and_then(|function| function.get_mut("parameters"))
    {
        inject_v3_tool_thinking_fields_into_schema(schema)?;
    }
    Ok(())
}

pub(super) fn inject_v3_tool_thinking_fields_into_schema(schema: &mut Value) -> Result<(), String> {
    let Some(schema) = schema.as_object_mut() else {
        return Err("tool-thinking schema must be an object".to_string());
    };
    if let Some(properties) = schema.get("properties") {
        let properties = properties
            .as_object()
            .ok_or_else(|| "tool-thinking schema properties must be an object".to_string())?;
        if properties.contains_key("reason") || properties.contains_key("goal_alignment_confidence")
        {
            return Ok(());
        }
    }
    if let Some(required) = schema.get("required") {
        if !required.is_array() {
            return Err("tool-thinking schema required must be an array".to_string());
        }
    }
    if !schema.contains_key("properties") {
        schema.insert("properties".to_string(), json!({}));
    }
    if !schema.contains_key("required") {
        schema.insert("required".to_string(), json!([]));
    }
    let properties = schema
        .get_mut("properties")
        .and_then(Value::as_object_mut)
        .expect("validated properties");
    properties.insert(
        "reason".to_string(),
        json!({"type":"string","minLength":1,"maxLength":50}),
    );
    properties.insert(
        "goal_alignment_confidence".to_string(),
        json!({"type":"integer","minimum":0,"maximum":100}),
    );
    let required = schema
        .get_mut("required")
        .and_then(Value::as_array_mut)
        .expect("validated required");
    for field in ["reason", "goal_alignment_confidence"] {
        if !required.iter().any(|value| value.as_str() == Some(field)) {
            required.push(Value::String(field.to_string()));
        }
    }
    Ok(())
}

pub(crate) fn identify_v3_servertool_request_tool(
    _payload: &Value,
    web_search_mode_b: bool,
) -> Option<V3ServerToolName> {
    web_search_mode_b.then_some(V3ServerToolName::WebSearch)
}

pub(crate) fn inspect_v3_servertool_response_tool(payload: &Value) -> Option<V3ServerToolName> {
    payload
        .get("output")
        .and_then(Value::as_array)
        .and_then(|output| {
            output.iter().find_map(|item| {
                let kind = item.get("type").and_then(Value::as_str).unwrap_or_default();
                if !matches!(kind, "function_call" | "tool_call" | "custom_tool_call") {
                    return None;
                }
                let name = item
                    .get("name")
                    .and_then(Value::as_str)
                    .or_else(|| item.pointer("/function/name").and_then(Value::as_str))?;
                matches!(name.trim(), "web_search" | "web_search_preview")
                    .then_some(V3ServerToolName::WebSearch)
            })
        })
}

pub(crate) fn govern_v3_servertool_request_at_req04(
    payload: &mut Value,
    current_payload_start: usize,
    _events: &mut Vec<V3HubRelayRequestHookEvent>,
    web_search_mode_b: bool,
    tool_thinking_enabled: bool,
) -> Result<(Option<V3WebSearchCenterState>, V3ToolThinkingTurnContext), V3HubRelayRequestError> {
    let web_search_state = if web_search_mode_b && payload_declares_web_search_tool(payload) {
        apply_v3_web_search_request_hook_at_req04(payload)?
    } else {
        None
    };
    let tool_thinking_context = compile_v3_tool_thinking_turn_context_at_req04(
        payload,
        current_payload_start,
        tool_thinking_enabled,
    )?;
    Ok((web_search_state, tool_thinking_context))
}

pub fn apply_v3_web_search_request_hook_at_req04(
    payload: &mut Value,
) -> Result<Option<V3WebSearchCenterState>, V3HubRelayRequestError> {
    if !payload_declares_web_search_tool(payload) {
        return Ok(None);
    }
    V3WebSearchCenterState::new()
        .transition_to(
            V3WebSearchCenterPhase::LocalToolSurfaceActive,
            "req04_web_search_surface_active",
        )
        .map(Some)
        .map_err(|reason| V3HubRelayRequestError::WebSearchToolSurfaceActivationFailed { reason })
}

fn payload_declares_web_search_tool(payload: &Value) -> bool {
    payload
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|tools| {
            tools.iter().any(|tool| {
                if matches!(
                    tool.get("type").and_then(Value::as_str),
                    Some("web_search" | "web_search_preview")
                ) {
                    return true;
                }
                tool.get("name")
                    .and_then(Value::as_str)
                    .or_else(|| tool.pointer("/function/name").and_then(Value::as_str))
                    .is_some_and(|name| {
                        matches!(
                            name.trim().to_ascii_lowercase().as_str(),
                            "websearch" | "web_search"
                        )
                    })
            })
        })
}

pub struct V3ServerToolResponseHookOutcome {
    pub input: V3HubRespInbound02Normalized,
    pub web_search_state: Option<V3WebSearchCenterState>,
    pub intercepted: bool,
}

pub fn apply_v3_tool_call_servertool_hook_at_resp03(
    mut input: V3HubRespInbound02Normalized,
    profile: &V3HubRelayResponseHookProfile,
) -> Result<V3ServerToolResponseHookOutcome, V3HubRelayResponseError> {
    if project_registered_servertool_calls_to_client_exec(&mut input, profile)? {
        return Ok(V3ServerToolResponseHookOutcome {
            input,
            web_search_state: None,
            intercepted: false,
        });
    }
    if profile.web_search_local_surface_active()
        && first_local_websearch_tool_call(input.provider_payload().as_ref())?.is_some()
    {
        return intercept_local_web_search_call(input, profile)?
            .ok_or(V3HubRelayResponseError::MissingWebSearchActivation);
    }
    Ok(V3ServerToolResponseHookOutcome {
        input,
        web_search_state: None,
        intercepted: false,
    })
}

fn project_registered_servertool_calls_to_client_exec(
    input: &mut V3HubRespInbound02Normalized,
    profile: &V3HubRelayResponseHookProfile,
) -> Result<bool, V3HubRelayResponseError> {
    let mut payload = input.provider_payload().as_ref().clone();
    let Some(output) = payload.get_mut("output").and_then(Value::as_array_mut) else {
        return Ok(false);
    };
    let mut changed = false;
    for (index, item) in output.iter_mut().enumerate() {
        let Some(object) = item.as_object_mut() else {
            continue;
        };
        if !matches!(
            object.get("type").and_then(Value::as_str),
            Some("function_call" | "tool_call" | "custom_tool_call")
        ) {
            continue;
        }
        let Some(name) = object
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| {
                object
                    .get("function")
                    .and_then(Value::as_object)
                    .and_then(|function| function.get("name"))
                    .and_then(Value::as_str)
            })
            .map(str::to_string)
        else {
            continue;
        };
        if !profile.is_servertool_name(&name) || !is_client_exec_cli_projection(&name) {
            continue;
        }
        let arguments = object
            .get("arguments")
            .or_else(|| {
                object
                    .get("function")
                    .and_then(Value::as_object)
                    .and_then(|function| function.get("arguments"))
            })
            .and_then(Value::as_str)
            .ok_or(V3HubRelayResponseError::MalformedToolCall {
                index,
                reason: "registered servertool call missing arguments",
            })?;
        let parsed = parse_servertool_cli_projection_tool_arguments(
            ServertoolCliProjectionToolArgumentsInput {
                arguments: arguments.to_string(),
            },
        )
        .map_err(|_| V3HubRelayResponseError::MalformedToolCall {
            index,
            reason: "registered servertool call arguments must be a JSON object",
        })?;
        let projection =
            build_client_exec_cli_projection_output(&name, &format!("{name}_flow"), parsed)
                .map_err(|_| V3HubRelayResponseError::MalformedToolCall {
                    index,
                    reason: "registered servertool CLI projection failed",
                })?;
        let command = projection
            .get("execCommand")
            .and_then(Value::as_str)
            .ok_or(V3HubRelayResponseError::MalformedToolCall {
                index,
                reason: "registered servertool CLI projection missing execCommand",
            })?;
        object.insert(
            "type".to_string(),
            Value::String("function_call".to_string()),
        );
        object.insert(
            "name".to_string(),
            Value::String("exec_command".to_string()),
        );
        object.insert(
            "arguments".to_string(),
            Value::String(
                serde_json::to_string(&json!({"cmd": command})).map_err(|_| {
                    V3HubRelayResponseError::MalformedToolCall {
                        index,
                        reason: "registered servertool exec_command arguments failed",
                    }
                })?,
            ),
        );
        object.remove("function");
        changed = true;
    }
    if changed {
        *input.provider_payload_mut() = Arc::new(payload);
    }
    Ok(changed)
}

fn strip_local_websearch_tool_call(payload: &Value, call_id: &str) -> Value {
    let mut projected = payload.clone();
    if let Some(output) = projected.get_mut("output").and_then(Value::as_array_mut) {
        output.retain(|item| {
            let item_call_id = item
                .get("call_id")
                .or_else(|| item.get("id"))
                .and_then(Value::as_str);
            let is_call = item_call_id == Some(call_id)
                && matches!(
                    item.get("type").and_then(Value::as_str),
                    Some("function_call" | "tool_call" | "custom_tool_call")
                );
            let is_result = item.get("type").and_then(Value::as_str)
                == Some("web_search_tool_result")
                && item.get("tool_use_id").and_then(Value::as_str) == Some(call_id);
            !(is_call || is_result)
        });
    }
    projected
}

fn intercept_local_web_search_call(
    mut input: V3HubRespInbound02Normalized,
    profile: &V3HubRelayResponseHookProfile,
) -> Result<Option<V3ServerToolResponseHookOutcome>, V3HubRelayResponseError> {
    let Some(call) = first_local_websearch_tool_call(input.provider_payload().as_ref())? else {
        return Ok(None);
    };
    let hosted_text =
        hosted_web_search_result_text(input.provider_payload().as_ref(), &call.call_id);
    *input.provider_payload_mut() = Arc::new(strip_local_websearch_tool_call(
        input.provider_payload().as_ref(),
        &call.call_id,
    ));
    let center_state = profile
        .web_search_center_state()
        .ok_or(V3HubRelayResponseError::MissingWebSearchActivation)?
        .clone();
    let observed = center_state
        .transition_to(
            V3WebSearchCenterPhase::ToolCallObserved,
            "resp03_websearch_call_observed",
        )
        .map_err(|reason| V3HubRelayResponseError::WebSearchStateTransitionFailed { reason })?
        .with_original_call_id(Some(call.call_id.clone()))
        .with_query(Some(call.query.clone()))
        .with_count(call.count)
        .with_recency(call.recency)
        .with_content_types(call.content_types);
    let state = match hosted_text {
        Some(text_result) => observed
            .transition_to(
                V3WebSearchCenterPhase::SearchDispatchPrepared,
                "resp03_hosted_result_observed",
            )
            .and_then(|state| {
                state.transition_to(
                    V3WebSearchCenterPhase::SearchInFlight,
                    "resp03_hosted_result_observed",
                )
            })
            .and_then(|state| {
                state.transition_to(
                    V3WebSearchCenterPhase::SearchResultCaptured,
                    "resp03_hosted_result_observed",
                )
            })
            .map(|state| {
                state.with_normalized_result(Some(
                    json!({"query":call.query,"text_result":text_result}),
                ))
            })
            .map_err(|reason| V3HubRelayResponseError::WebSearchStateTransitionFailed { reason })?,
        None => observed,
    };
    Ok(Some(V3ServerToolResponseHookOutcome {
        input,
        web_search_state: Some(state),
        intercepted: true,
    }))
}

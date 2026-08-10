use super::{
    V3HubRelayRequestError, V3HubRelayRequestHookEvent, V3HubRelayResponseError,
    V3HubRelayResponseHookProfile, V3HubRespInbound02Normalized, V3ServerToolName,
    V3StoplessCenterState, V3StoplessCenterSteering, V3WebSearchCenterPhase,
    V3WebSearchCenterState,
};
use super::web_search_hop::{first_local_websearch_tool_call, hosted_web_search_result_text};
use serde_json::{json, Value};
use servertool_core::cli_contract::{
    build_client_exec_cli_projection_output, parse_servertool_cli_projection_tool_arguments,
    ServertoolCliProjectionToolArgumentsInput,
};
use servertool_core::outcome_contract::is_client_exec_cli_projection;
use std::sync::Arc;

const STOPLESS_CALL_ID: &str = "call_stopless_reasoning";
const STOPLESS_CLI_COMMAND: &str = "routecodex hook run reasoningStop";
pub(crate) fn is_v3_stopless_internal_call_id(call_id: &str) -> bool {
    call_id == STOPLESS_CALL_ID
}

pub(crate) fn identify_v3_servertool_request_tool(
    payload: &Value,
    stopless_enabled: bool,
    web_search_mode_b: bool,
) -> Option<V3ServerToolName> {
    if stopless_enabled {
        return Some(V3ServerToolName::Stopless);
    }
    if web_search_mode_b {
        return Some(V3ServerToolName::WebSearch);
    }
    let _ = payload;
    None
}

pub(crate) fn inspect_v3_servertool_response_tool(payload: &Value) -> Option<V3ServerToolName> {
    let Some(output) = payload.get("output").and_then(Value::as_array) else {
        return None;
    };
    for item in output {
        let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
        if !matches!(
            item_type,
            "function_call" | "tool_call" | "custom_tool_call"
        ) {
            continue;
        }
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| item.pointer("/function/name").and_then(Value::as_str));
        match name {
            Some(name) if name.trim().eq_ignore_ascii_case("reasoningStop") => {
                return Some(V3ServerToolName::Stopless)
            }
            Some(name)
                if matches!(name.trim(), "web_search" | "web_search_preview") =>
            {
                return Some(V3ServerToolName::WebSearch)
            }
            _ => {}
        }
    }
    None
}

pub(crate) fn govern_v3_servertool_request_at_req04(
    payload: &mut Value,
    current_payload_start: usize,
    events: &mut Vec<V3HubRelayRequestHookEvent>,
    stopless_enabled: bool,
    web_search_mode_b: bool,
    stopless_center_state: Option<&V3StoplessCenterState>,
    transition_request_id: Option<&str>,
    transition_updated_at: Option<u64>,
) -> Result<
    (Option<V3StoplessCenterState>, Option<V3WebSearchCenterState>),
    V3HubRelayRequestError,
> {
    let identified = identify_v3_servertool_request_tool(
        payload,
        stopless_enabled,
        web_search_mode_b,
    );
    let stopless_state = if identified == Some(V3ServerToolName::Stopless) {
        apply_v3_stopless_request_hook_at_req04(
            payload,
            current_payload_start,
            events,
            stopless_center_state,
            transition_request_id,
            transition_updated_at,
        )?
    } else {
        None
    };
    // web_search 与 stopless 是独立工具：stopless 激活不得吞掉 web_search
    // 激活（否则 Mode B servertool 永不激活）。web_search_mode_b 为真且
    // payload 含 web_search 声明时独立激活 LocalToolSurfaceActive。
    let web_search_state = if web_search_mode_b
        && payload_declares_web_search_tool(payload)
    {
        apply_v3_web_search_request_hook_at_req04(payload)?
    } else {
        None
    };
    Ok((stopless_state, web_search_state))
}

pub fn apply_v3_web_search_request_hook_at_req04(
    payload: &mut Value,
) -> Result<Option<V3WebSearchCenterState>, V3HubRelayRequestError> {
    let has_declaration = payload_declares_web_search_tool(payload);
    if !has_declaration {
        return Ok(None);
    }
    let state = V3WebSearchCenterState::new()
        .transition_to(
            V3WebSearchCenterPhase::LocalToolSurfaceActive,
            "req04_web_search_surface_active",
        )
        .map_err(|reason| V3HubRelayRequestError::WebSearchToolSurfaceActivationFailed { reason })?;
    Ok(Some(state))
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
                let name = tool
                    .get("name")
                    .and_then(Value::as_str)
                    .or_else(|| tool.pointer("/function/name").and_then(Value::as_str));
                name.is_some_and(|value| {
                    let value = value.trim();
                    value.eq_ignore_ascii_case("websearch")
                        || value.eq_ignore_ascii_case("web_search")
                })
            })
        })
}

pub struct V3StoplessResponseHookOutcome {
    pub input: V3HubRespInbound02Normalized,
    pub center_state: Option<V3StoplessCenterState>,
    pub web_search_state: Option<V3WebSearchCenterState>,
    pub intercepted: bool,
}

pub fn apply_v3_tool_call_servertool_hook_at_resp03(
    mut input: V3HubRespInbound02Normalized,
    profile: &V3HubRelayResponseHookProfile,
) -> Result<V3StoplessResponseHookOutcome, V3HubRelayResponseError> {
    if project_registered_servertool_calls_to_client_exec(&mut input, profile)? {
        return Ok(V3StoplessResponseHookOutcome {
            input,
            center_state: None,
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
    if !profile.stopless_reasoning_stop_enabled() || !profile.stopless_schema_guidance_active() {
        return Ok(V3StoplessResponseHookOutcome {
            input,
            center_state: None,
            web_search_state: None,
            intercepted: false,
        });
    }
    let Some(stop_call) = first_reasoning_stop_tool_call(input.provider_payload().as_ref())? else {
        return Ok(V3StoplessResponseHookOutcome {
            input,
            center_state: None,
            web_search_state: None,
            intercepted: false,
        });
    };
    let keep_noop = matches!(
        stop_call.decision,
        StoplessResponseDecision::Continue | StoplessResponseDecision::NeedsEvidence
    );
    let visible = strip_current_stopless_response_artifacts(
        input.provider_payload().as_ref(),
        &stop_call.call_id,
        stop_call.evidence.as_deref(),
        keep_noop,
    );
    *input.provider_payload_mut() = Arc::new(visible);
    let state = match stop_call.decision {
        StoplessResponseDecision::Terminal | StoplessResponseDecision::Blocked => None,
        StoplessResponseDecision::Continue | StoplessResponseDecision::NeedsEvidence => {
            let steering = if stop_call.decision == StoplessResponseDecision::NeedsEvidence {
                V3StoplessCenterSteering::ReasoningStopNeedsEvidence
            } else {
                V3StoplessCenterSteering::Continue
            };
            let transition_reason = if stop_call.decision == StoplessResponseDecision::NeedsEvidence
            {
                "reasoning_stop_needs_evidence_cli_projected"
            } else {
                "reasoning_stop_continue_projected"
            };
            let state = V3StoplessCenterState::new(
                next_stopless_consecutive_stop_count(profile),
                stopless_max_natural_stops(profile),
                steering,
            )
            .with_last_request_id(profile.stopless_transition_request_id())
            .with_last_response_id(stopless_response_id(input.provider_payload()))
            .with_last_transition_reason(transition_reason)
            .with_last_provider_stopless_call_id(Some(stop_call.call_id.clone()))
            .with_updated_at(profile.stopless_transition_updated_at().unwrap_or(0));
            (!state.guard_exhausted()).then_some(state)
        }
    };
    if state.is_none()
        && matches!(
            stop_call.decision,
            StoplessResponseDecision::Continue | StoplessResponseDecision::NeedsEvidence
        )
    {
        let visible = strip_current_stopless_response_artifacts(
            input.provider_payload().as_ref(),
            &stop_call.call_id,
            stop_call.evidence.as_deref(),
            false,
        );
        *input.provider_payload_mut() = Arc::new(visible);
    }
    Ok(V3StoplessResponseHookOutcome {
        input,
        center_state: state,
        web_search_state: None,
        intercepted: true,
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
        if !profile.is_servertool_name(&name) {
            continue;
        }
        if !is_client_exec_cli_projection(&name) {
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
            build_client_exec_cli_projection_output(&name, &format!("{name}_flow"), parsed, 0, 0)
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StoplessResponseDecision {
    Terminal,
    Blocked,
    Continue,
    NeedsEvidence,
}

struct V3ReasoningStopToolCall {
    call_id: String,
    decision: StoplessResponseDecision,
    evidence: Option<String>,
}


fn strip_local_websearch_tool_call(payload: &Value, call_id: &str) -> Value {
    let mut projected = payload.clone();
    if let Some(output) = projected.get_mut("output").and_then(Value::as_array_mut) {
        output.retain(|item| {
            let item_call_id = item
                .get("call_id")
                .or_else(|| item.get("id"))
                .and_then(Value::as_str);
            let is_web_search_call = item_call_id == Some(call_id)
                && item
                    .get("type")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| {
                        matches!(kind, "function_call" | "tool_call" | "custom_tool_call")
                    });
            let is_hosted_result = item
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|kind| kind == "web_search_tool_result")
                && item
                    .get("tool_use_id")
                    .and_then(Value::as_str)
                    == Some(call_id);
            !(is_web_search_call || is_hosted_result)
        });
    }
    // OpenAI Chat：choices[].message.tool_calls[] 剥离匹配 call_id 的 function call。
    if let Some(choices) = projected.get_mut("choices").and_then(Value::as_array_mut) {
        for choice in choices {
            let Some(message) = choice.get_mut("message") else {
                continue;
            };
            let Some(tool_calls) = message
                .get_mut("tool_calls")
                .and_then(Value::as_array_mut)
            else {
                continue;
            };
            tool_calls.retain(|item| {
                item.get("id").and_then(Value::as_str) != Some(call_id)
            });
        }
    }
    // Anthropic：content[].tool_use 剥离匹配 call_id 的工具调用。
    if let Some(content) = projected.get_mut("content").and_then(Value::as_array_mut) {
        content.retain(|item| {
            !(item.get("type").and_then(Value::as_str) == Some("tool_use")
                && item.get("id").and_then(Value::as_str) == Some(call_id))
        });
    }
    projected
}


fn intercept_local_web_search_call(
    mut input: V3HubRespInbound02Normalized,
    profile: &V3HubRelayResponseHookProfile,
) -> Result<Option<V3StoplessResponseHookOutcome>, V3HubRelayResponseError> {
    let Some(call) = first_local_websearch_tool_call(input.provider_payload().as_ref())? else {
        return Ok(None);
    };
    let hosted_text =
        hosted_web_search_result_text(input.provider_payload().as_ref(), &call.call_id);
    let visible = strip_local_websearch_tool_call(input.provider_payload().as_ref(), &call.call_id);
    *input.provider_payload_mut() = Arc::new(visible);
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
    let web_search_state = match hosted_text {
        Some(text_result) => {
            let normalized = json!({
                "query": call.query,
                "text_result": text_result
            });
            observed
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
                .map_err(|reason| {
                    V3HubRelayResponseError::WebSearchStateTransitionFailed { reason }
                })?
                .with_normalized_result(Some(normalized))
        }
        None => observed,
    };
    Ok(Some(V3StoplessResponseHookOutcome {
        input,
        center_state: None,
        web_search_state: Some(web_search_state),
        intercepted: true,
    }))
}

fn first_reasoning_stop_tool_call(
    payload: &Value,
) -> Result<Option<V3ReasoningStopToolCall>, V3HubRelayResponseError> {
    let Some(output) = payload.get("output").and_then(Value::as_array) else {
        return Ok(None);
    };
    for (index, item) in output.iter().enumerate() {
        let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
        if !matches!(
            item_type,
            "function_call" | "tool_call" | "custom_tool_call"
        ) {
            continue;
        }
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .or_else(|| item.pointer("/function/name").and_then(Value::as_str));
        if !name.is_some_and(|value| value.trim().eq_ignore_ascii_case("reasoningStop")) {
            continue;
        }
        let call_id = item
            .get("call_id")
            .or_else(|| item.get("id"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or(V3HubRelayResponseError::MalformedToolCall {
                index,
                reason: "reasoningStop tool call missing call_id",
            })?
            .to_string();
        let raw_arguments = item
            .get("arguments")
            .or_else(|| item.get("input"))
            .or_else(|| item.pointer("/function/arguments"))
            .and_then(Value::as_str)
            .ok_or(V3HubRelayResponseError::MalformedToolCall {
                index,
                reason: "reasoningStop tool call missing arguments",
            })?;
        let arguments = raw_arguments.parse::<Value>().map_err(|_| {
            V3HubRelayResponseError::MalformedToolCall {
                index,
                reason: "reasoningStop tool call arguments must be valid JSON",
            }
        })?;
        let stopreason = arguments.get("stopreason").and_then(|value| {
            value
                .as_u64()
                .and_then(|value| u8::try_from(value).ok())
                .or_else(|| value.as_str()?.trim().parse().ok())
        });
        let evidence = arguments
            .get("evidence")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let reason = arguments
            .get("reason")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let (decision, visible) = match stopreason {
            Some(0) => match evidence.as_deref() {
                Some(evidence) => (
                    StoplessResponseDecision::Terminal,
                    Some(match reason.as_deref() {
                        Some(reason) => format!("完成：{reason}\n证据：{evidence}"),
                        None => format!("完成。\n证据：{evidence}"),
                    }),
                ),
                None => (StoplessResponseDecision::NeedsEvidence, None),
            },
            Some(1) => match (reason.as_deref(), evidence.as_deref()) {
                (Some(reason), Some(evidence)) => (
                    StoplessResponseDecision::Blocked,
                    Some(format!("阻塞：{reason}\n证据：{evidence}")),
                ),
                _ => (StoplessResponseDecision::NeedsEvidence, None),
            },
            Some(2) => (StoplessResponseDecision::Continue, None),
            _ => (StoplessResponseDecision::NeedsEvidence, None),
        };
        return Ok(Some(V3ReasoningStopToolCall {
            call_id,
            decision,
            evidence: visible,
        }));
    }
    Ok(None)
}

fn strip_current_stopless_response_artifacts(
    payload: &Value,
    call_id: &str,
    evidence: Option<&str>,
    keep_noop: bool,
) -> Value {
    let mut projected = payload.clone();
    if let Some(output) = projected.get_mut("output").and_then(Value::as_array_mut) {
        let mut retained = Vec::with_capacity(output.len());
        for item in output.drain(..) {
            let item_call_id = item
                .get("call_id")
                .or_else(|| item.get("id"))
                .and_then(Value::as_str);
            let is_stopless_call = item_call_id == Some(call_id)
                && item
                    .get("type")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| {
                        matches!(kind, "function_call" | "tool_call" | "custom_tool_call")
                    });
            if !is_stopless_call {
                retained.push(item);
                continue;
            }
            if !keep_noop {
                // Terminal/Blocked：剥离工具调用，返回纯文本 stop 响应。
                continue;
            }
            // 续杯：reasoningStop 投影为 noop（无参数、无返回），文本承载在
            // 客户端可见 message 中（不丢失响应内容）。
            let mut item = item;
            if let Some(object) = item.as_object_mut() {
                object.insert("name".to_string(), Value::String("noop".to_string()));
                object.remove("arguments");
                if let Some(function) = object.get_mut("function") {
                    if let Some(function) = function.as_object_mut() {
                        function.insert("name".to_string(), Value::String("noop".to_string()));
                        function.remove("arguments");
                    }
                }
            }
            retained.push(item);
        }
        *output = retained;
        if let Some(evidence) = evidence {
            let visible = collect_stopless_visible_text(output);
            let completion = visible
                .trim()
                .is_empty()
                .then_some(evidence.to_string())
                .unwrap_or_else(|| {
                    if visible.trim().ends_with('\n') {
                        format!("{visible}{evidence}")
                    } else {
                        format!("{visible}\n\n{evidence}")
                    }
                });
            if let Some(message) = output.iter_mut().find(|item| {
                item.get("type").and_then(Value::as_str) == Some("message")
                    && item.get("content").is_some()
            }) {
                append_stopless_message_text(message, &completion);
            } else {
                output.push(json!({
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": completion}]
                }));
            }
        }
    }
    strip_current_stopless_instruction_echo(&mut projected);
    strip_current_stopless_control_text(&mut projected);
    finalize_current_stopless_response(&mut projected, keep_noop);
    projected
}

fn collect_stopless_visible_text(output: &[Value]) -> String {
    let mut visible = String::new();
    for item in output {
        if item.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        if let Some(parts) = item.get("content").and_then(Value::as_array) {
            for part in parts {
                if !matches!(
                    part.get("type").and_then(Value::as_str),
                    Some("output_text" | "text")
                ) {
                    continue;
                }
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    visible.push_str(text);
                    visible.push('\n');
                }
            }
        }
    }
    visible
}

fn append_stopless_message_text(message: &mut Value, text: &str) {
    let Some(object) = message.as_object_mut() else {
        return;
    };
    let mut parts = object
        .get("content")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    parts.push(json!({"type": "output_text", "text": text}));
    object.insert("content".to_string(), Value::Array(parts));
}

fn finalize_current_stopless_response(payload: &mut Value, keep_noop: bool) {
    let Some(object) = payload.as_object_mut() else {
        return;
    };
    if keep_noop {
        // 续杯：finish_reason 归一化为 tool_calls，客户端返回空 noop 结果后，
        // 下一轮 MetadataCenter 按 session/port 识别 noop 并续杯。
        object.insert(
            "status".to_string(),
            Value::String("requires_action".to_string()),
        );
        for key in ["finish_reason", "finishReason", "stop_reason", "stopReason"] {
            if object.contains_key(key) {
                object.insert(key.to_string(), Value::String("tool_calls".to_string()));
            }
        }
    } else {
        // Terminal/Blocked：剥离工具调用，返回纯文本 stop 响应。
        object.insert("status".to_string(), Value::String("completed".to_string()));
        for key in ["finish_reason", "finishReason", "stop_reason", "stopReason"] {
            if object.contains_key(key) {
                object.insert(key.to_string(), Value::String("stop".to_string()));
            }
        }
    }
}

fn strip_current_stopless_instruction_echo(payload: &mut Value) {
    if let Some(instructions) = payload
        .get("instructions")
        .and_then(Value::as_str)
        .map(str::to_string)
    {
        if let Some((prefix, _)) = instructions.split_once("\n\n当前轮推进准则") {
            payload["instructions"] = Value::String(prefix.to_string());
        }
    }
    if let Some(object) = payload.as_object_mut() {
        if let Some(output) = object.get_mut("output").and_then(Value::as_array_mut) {
            for item in output {
                if item.get("type").and_then(Value::as_str) != Some("reasoning") {
                    continue;
                }
                if let Some(item) = item.as_object_mut() {
                    item.remove("stop_schema");
                    item.remove("stopSchema");
                }
            }
        }
        if let Some(tools) = object.get_mut("tools").and_then(Value::as_array_mut) {
            tools.retain(|tool| {
                tool.get("name")
                    .and_then(Value::as_str)
                    .is_none_or(|name| !name.eq_ignore_ascii_case("reasoningStop"))
            });
        }
        let tools_empty = object
            .get("tools")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty);
        if tools_empty {
            object.remove("tools");
            if object.get("tool_choice").is_some_and(|choice| {
                choice.as_str() == Some("required")
                    || choice.get("type").and_then(Value::as_str) == Some("required")
            }) {
                object.remove("tool_choice");
            }
        }
    }
}

fn strip_current_stopless_control_text(payload: &mut Value) {
    if let Some(output_text) = payload.get_mut("output_text") {
        strip_current_stopless_control_string(output_text);
    }
    let Some(output) = payload.get_mut("output").and_then(Value::as_array_mut) else {
        return;
    };
    for item in output {
        if let Some(text) = item.get_mut("text") {
            strip_current_stopless_control_string(text);
        }
        let Some(content) = item.get_mut("content").and_then(Value::as_array_mut) else {
            continue;
        };
        for part in content {
            let Some(text) = part.get_mut("text") else {
                continue;
            };
            strip_current_stopless_control_string(text);
        }
    }
}

fn strip_current_stopless_control_string(value: &mut Value) {
    let Some(text) = value.as_str() else {
        return;
    };
    let cleaned = if let Some(start) = text.find("<rcc_stop_schema>") {
        let mut cleaned = text[..start].trim_end().to_string();
        if let Some(end) = text[start..].find("</rcc_stop_schema>") {
            let suffix_start = start + end + "</rcc_stop_schema>".len();
            let suffix = text[suffix_start..].trim_start();
            if !suffix.is_empty() {
                if !cleaned.is_empty() {
                    cleaned.push('\n');
                }
                cleaned.push_str(suffix);
            }
        }
        Some(cleaned)
    } else {
        serde_json::from_str::<Value>(text)
            .ok()
            .filter(is_stopless_control_object)
            .map(|_| String::new())
    };
    if let Some(cleaned) = cleaned {
        *value = Value::String(cleaned);
    }
}

fn is_stopless_control_object(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.contains_key("stopreason")
        && object.contains_key("current_goal")
        && object.contains_key("next_step")
}

pub fn apply_v3_stop_servertool_hook_at_resp03(
    input: V3HubRespInbound02Normalized,
    profile: &V3HubRelayResponseHookProfile,
) -> Result<V3StoplessResponseHookOutcome, V3HubRelayResponseError> {
    if !profile.stopless_reasoning_stop_enabled() || !profile.stopless_schema_guidance_active() {
        return Ok(V3StoplessResponseHookOutcome {
            input,
            center_state: None,
            web_search_state: None,
            intercepted: false,
        });
    }
    let object = input
        .provider_payload()
        .as_object()
        .ok_or(V3HubRelayResponseError::ProviderResponseNotObject)?;
    let status = object
        .get("status")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_default();
    if status != "completed" {
        return Ok(V3StoplessResponseHookOutcome {
            input,
            center_state: None,
            web_search_state: None,
            intercepted: false,
        });
    }
    let stop_candidate = response_has_stopless_stop_trigger(input.provider_payload().as_ref())
        || response_is_completed_responses_object_without_finish_reason(
            input.provider_payload().as_ref(),
        );
    if !stop_candidate {
        return Ok(V3StoplessResponseHookOutcome {
            input,
            center_state: None,
            web_search_state: None,
            intercepted: false,
        });
    }
    project_stopless_noop_for_stop_candidate(
        input,
        profile,
        V3StoplessCenterSteering::NaturalStopWithoutReasoningStop,
        "natural_stop_cli_projected",
        None::<String>,
    )
}

fn project_stopless_noop_for_stop_candidate(
    mut input: V3HubRespInbound02Normalized,
    profile: &V3HubRelayResponseHookProfile,
    steering: V3StoplessCenterSteering,
    transition_reason: &'static str,
    next_step: Option<String>,
) -> Result<V3StoplessResponseHookOutcome, V3HubRelayResponseError> {
    let natural_stop_count = next_stopless_consecutive_stop_count(profile);
    let max_natural_stops = stopless_max_natural_stops(profile);
    if natural_stop_count > max_natural_stops {
        let mut visible = input.provider_payload().as_ref().clone();
        strip_current_stopless_instruction_echo(&mut visible);
        strip_current_stopless_control_text(&mut visible);
        *input.provider_payload_mut() = Arc::new(visible);
        return Ok(V3StoplessResponseHookOutcome {
            input,
            center_state: None,
            web_search_state: None,
            intercepted: true,
        });
    }
    let mut visible = input.provider_payload().as_ref().clone();
    strip_current_stopless_instruction_echo(&mut visible);
    strip_current_stopless_control_text(&mut visible);
    *input.provider_payload_mut() = Arc::new(visible);
    Ok(V3StoplessResponseHookOutcome {
        center_state: Some(
            V3StoplessCenterState::new(natural_stop_count, max_natural_stops, steering)
                .with_next_step_prompt(next_step)
                .with_last_request_id(profile.stopless_transition_request_id())
                .with_last_response_id(stopless_response_id(input.provider_payload()))
                .with_last_transition_reason(transition_reason)
                .with_updated_at(profile.stopless_transition_updated_at().unwrap_or(0)),
        ),
        web_search_state: None,
        input,
        intercepted: false,
    })
}

pub fn apply_v3_stopless_request_hook_at_req04(
    payload: &mut Value,
    current_payload_start: usize,
    events: &mut Vec<V3HubRelayRequestHookEvent>,
    restored_stopless_center_state: Option<&V3StoplessCenterState>,
    transition_request_id: Option<&str>,
    transition_updated_at: Option<u64>,
) -> Result<Option<V3StoplessCenterState>, V3HubRelayRequestError> {
    if payload.get("input").and_then(Value::as_array).is_none()
        && payload.get("messages").and_then(Value::as_array).is_some()
    {
        return apply_v3_stopless_chat_request_hook_at_req04(
            payload,
            current_payload_start,
            events,
            restored_stopless_center_state,
            transition_request_id,
            transition_updated_at,
        );
    }
    let Some(input) = payload.get_mut("input").and_then(Value::as_array_mut) else {
        return Ok(initial_stopless_provider_turn_state(
            restored_stopless_center_state,
            transition_request_id,
            transition_updated_at,
        ));
    };
    let current_input = input.get(current_payload_start..).ok_or(
        V3HubRelayRequestError::CurrentPayloadBoundaryInvalid {
            start: current_payload_start,
            len: input.len(),
        },
    )?;
    if restored_stopless_center_state.is_none() {
        return Ok(initial_stopless_provider_turn_state(
            restored_stopless_center_state,
            transition_request_id,
            transition_updated_at,
        ));
    }
    let Some((index, output)) = active_stopless_cli_output(current_input) else {
        return Ok(initial_stopless_provider_turn_state(
            restored_stopless_center_state,
            transition_request_id,
            transition_updated_at,
        ));
    };
    let output = output.clone();
    let had_restored_state = restored_stopless_center_state.is_some();
    let state = restored_stopless_center_state
        .cloned()
        .or_else(|| {
            initial_stopless_provider_turn_state(
                restored_stopless_center_state,
                transition_request_id,
                transition_updated_at,
            )
        })
        .map(|state| state.cli_noop_observed(transition_request_id, transition_updated_at));
    if had_restored_state {
        events.push(V3HubRelayRequestHookEvent::Req04StoplessControlLoaded);
    }
    if state.is_some() {
        events.push(V3HubRelayRequestHookEvent::Req04StoplessCliNoopObserved);
    }
    remove_current_stopless_cli_pair(input, current_payload_start + index, &output);
    events.push(V3HubRelayRequestHookEvent::Req04StoplessResultParsed);
    Ok(state
        .map(|state| state.provider_turn_in_flight(transition_request_id, transition_updated_at)))
}

fn apply_v3_stopless_chat_request_hook_at_req04(
    payload: &mut Value,
    current_payload_start: usize,
    events: &mut Vec<V3HubRelayRequestHookEvent>,
    restored_stopless_center_state: Option<&V3StoplessCenterState>,
    transition_request_id: Option<&str>,
    transition_updated_at: Option<u64>,
) -> Result<Option<V3StoplessCenterState>, V3HubRelayRequestError> {
    let Some(messages) = payload.get_mut("messages").and_then(Value::as_array_mut) else {
        return Ok(initial_stopless_provider_turn_state(
            restored_stopless_center_state,
            transition_request_id,
            transition_updated_at,
        ));
    };
    let current_messages = messages.get(current_payload_start..).ok_or(
        V3HubRelayRequestError::CurrentPayloadBoundaryInvalid {
            start: current_payload_start,
            len: messages.len(),
        },
    )?;
    if restored_stopless_center_state.is_none() {
        return Ok(initial_stopless_provider_turn_state(
            restored_stopless_center_state,
            transition_request_id,
            transition_updated_at,
        ));
    }
    let Some(index) = active_stopless_chat_cli_output(current_messages) else {
        return Ok(initial_stopless_provider_turn_state(
            restored_stopless_center_state,
            transition_request_id,
            transition_updated_at,
        ));
    };
    let had_restored_state = restored_stopless_center_state.is_some();
    let state = restored_stopless_center_state
        .cloned()
        .or_else(|| {
            initial_stopless_provider_turn_state(
                restored_stopless_center_state,
                transition_request_id,
                transition_updated_at,
            )
        })
        .map(|state| state.cli_noop_observed(transition_request_id, transition_updated_at));
    if had_restored_state {
        events.push(V3HubRelayRequestHookEvent::Req04StoplessControlLoaded);
    }
    if state.is_some() {
        events.push(V3HubRelayRequestHookEvent::Req04StoplessCliNoopObserved);
    }
    remove_current_stopless_chat_pair(messages, current_payload_start + index);
    events.push(V3HubRelayRequestHookEvent::Req04StoplessResultParsed);
    Ok(state
        .map(|state| state.provider_turn_in_flight(transition_request_id, transition_updated_at)))
}

fn remove_current_stopless_cli_pair(input: &mut Vec<Value>, call_index: usize, output: &Value) {
    let Some(call_id) = output
        .get("call_id")
        .or_else(|| output.get("tool_call_id"))
        .and_then(Value::as_str)
    else {
        return;
    };
    if call_index == 0 {
        return;
    }
    let call_index = call_index - 1;
    if !is_stopless_cli_call(&input[call_index])
        || input[call_index]
            .get("call_id")
            .or_else(|| input[call_index].get("id"))
            .and_then(Value::as_str)
            != Some(call_id)
    {
        return;
    }
    input.remove(call_index + 1);
    input.remove(call_index);
}

fn remove_current_stopless_chat_pair(messages: &mut Vec<Value>, output_index: usize) {
    if output_index == 0 || output_index >= messages.len() {
        return;
    }
    let Some(call_id) = chat_tool_output_call_id(&messages[output_index]) else {
        return;
    };
    let call_index = output_index - 1;
    if chat_tool_call_is_stopless_cli(
        messages[call_index]
            .get("tool_calls")
            .and_then(Value::as_array)
            .and_then(|calls| {
                calls.iter().find(|call| {
                    call.get("id")
                        .or_else(|| call.get("call_id"))
                        .and_then(Value::as_str)
                        == Some(call_id)
                })
            })
            .unwrap_or(&Value::Null),
    ) {
        messages.remove(output_index);
        messages.remove(call_index);
    }
}

fn initial_stopless_provider_turn_state(
    restored_stopless_center_state: Option<&V3StoplessCenterState>,
    transition_request_id: Option<&str>,
    transition_updated_at: Option<u64>,
) -> Option<V3StoplessCenterState> {
    let request_id = transition_request_id
        .map(str::trim)
        .filter(|request_id| !request_id.is_empty())?;
    Some(
        V3StoplessCenterState::new(
            0,
            restored_stopless_center_state
                .map(V3StoplessCenterState::max_natural_stops)
                .unwrap_or(3),
            V3StoplessCenterSteering::Continue,
        )
        .provider_turn_in_flight(Some(request_id), transition_updated_at),
    )
}

fn response_has_stopless_stop_trigger(response: &Value) -> bool {
    [
        &["finish_reason"][..],
        &["finishReason"][..],
        &["stop_reason"][..],
        &["stopReason"][..],
        &["response", "finish_reason"][..],
        &["response", "finishReason"][..],
        &["response", "stop_reason"][..],
        &["response", "stopReason"][..],
        &["choices", "0", "finish_reason"][..],
        &["candidates", "0", "finishReason"][..],
    ]
    .iter()
    .any(|path| {
        response_string_path(response, path)
            .is_some_and(|value| is_stopless_natural_stop_finish_reason(&value))
    })
}

fn is_stopless_natural_stop_finish_reason(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "stop" | "end_turn"
    )
}

fn response_is_completed_responses_object_without_finish_reason(response: &Value) -> bool {
    response
        .get("object")
        .and_then(Value::as_str)
        .is_some_and(|value| value.eq_ignore_ascii_case("response"))
        && response
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|value| value.eq_ignore_ascii_case("completed"))
        && response_finish_reason(response).is_none()
}

fn response_finish_reason(response: &Value) -> Option<String> {
    [
        &["finish_reason"][..],
        &["finishReason"][..],
        &["stop_reason"][..],
        &["stopReason"][..],
        &["response", "finish_reason"][..],
        &["response", "finishReason"][..],
        &["response", "stop_reason"][..],
        &["response", "stopReason"][..],
        &["choices", "0", "finish_reason"][..],
        &["candidates", "0", "finishReason"][..],
    ]
    .iter()
    .find_map(|path| response_string_path(response, path))
}

fn response_string_path(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for segment in path {
        if let Ok(index) = segment.parse::<usize>() {
            current = current.get(index)?;
        } else {
            current = current.get(*segment)?;
        }
    }
    current
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn stopless_max_natural_stops(profile: &V3HubRelayResponseHookProfile) -> u32 {
    profile
        .stopless_center_state()
        .map(V3StoplessCenterState::max_natural_stops)
        .unwrap_or(3)
        .max(1)
}

fn next_stopless_consecutive_stop_count(profile: &V3HubRelayResponseHookProfile) -> u32 {
    profile
        .stopless_center_state()
        .map(V3StoplessCenterState::consecutive_stop_count)
        .unwrap_or(0)
        .saturating_add(1)
}

fn stopless_response_id(payload: &Value) -> Option<String> {
    payload
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
}

fn is_stopless_cli_output(item: &Value) -> bool {
    matches!(
        item.get("type").and_then(Value::as_str),
        Some("function_call_output" | "tool_call_output")
    ) && item
        .get("call_id")
        .and_then(Value::as_str)
        .is_some_and(|call_id| call_id == STOPLESS_CALL_ID)
}

fn stopless_cli_call_id(item: &Value) -> Option<&str> {
    if !is_stopless_cli_call(item) {
        return None;
    }
    item.get("call_id")
        .or_else(|| item.get("id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|call_id| !call_id.is_empty())
}

fn argument_is_exact_stopless_cli_command(arguments: &str) -> bool {
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(arguments.trim()) else {
        return false;
    };
    object.len() == 1
        && object
            .get("cmd")
            .and_then(Value::as_str)
            .is_some_and(|cmd| cmd.trim() == STOPLESS_CLI_COMMAND)
}

fn tool_name_is_exec_command(value: Option<&str>) -> bool {
    value
        .map(str::trim)
        .is_some_and(|name| name == "exec_command")
}

fn item_is_exact_stopless_cli_command_call(item: &Value) -> bool {
    tool_name_is_exec_command(item.get("name").and_then(Value::as_str))
        && item
            .get("arguments")
            .or_else(|| item.get("input"))
            .and_then(Value::as_str)
            .is_some_and(argument_is_exact_stopless_cli_command)
}

fn tool_output_call_id(item: &Value) -> Option<&str> {
    if !matches!(
        item.get("type").and_then(Value::as_str),
        Some("function_call_output" | "tool_call_output")
    ) {
        return None;
    }
    item.get("call_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|call_id| !call_id.is_empty())
}

fn output_pairs_immediately_after_stopless_cli_call(
    output: &Value,
    previous: Option<&Value>,
) -> bool {
    let Some(output_call_id) = tool_output_call_id(output) else {
        return false;
    };
    previous
        .and_then(stopless_cli_call_id)
        .is_some_and(|call_id| call_id == output_call_id)
}

fn active_stopless_cli_output(input: &[Value]) -> Option<(usize, &Value)> {
    let mut index = input.len();
    while index > 0 {
        index -= 1;
        let item = &input[index];
        if is_stopless_cli_output(item)
            || output_pairs_immediately_after_stopless_cli_call(
                item,
                index.checked_sub(1).and_then(|index| input.get(index)),
            )
        {
            return Some((index, item));
        }
        if is_stopless_cli_call(item) {
            continue;
        }
        if is_stopless_reset_boundary_item(item) {
            break;
        }
    }
    None
}

fn active_stopless_chat_cli_output(messages: &[Value]) -> Option<usize> {
    let mut index = messages.len();
    while index > 0 {
        index -= 1;
        let item = &messages[index];
        if is_stopless_chat_cli_output(item)
            || chat_output_pairs_immediately_after_stopless_cli_call(
                item,
                index.checked_sub(1).and_then(|index| messages.get(index)),
            )
        {
            return Some(index);
        }
        if is_stopless_chat_cli_call(item) {
            continue;
        }
        if chat_message_is_stopless_reset_boundary(item) {
            break;
        }
    }
    None
}

fn is_stopless_chat_cli_output(item: &Value) -> bool {
    item.get("role").and_then(Value::as_str) == Some("tool")
        && item
            .get("tool_call_id")
            .or_else(|| item.get("call_id"))
            .and_then(Value::as_str)
            .is_some_and(|call_id| call_id == STOPLESS_CALL_ID)
}

fn stopless_chat_cli_call_id(item: &Value) -> Option<&str> {
    if item.get("role").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    item.get("tool_calls")
        .and_then(Value::as_array)?
        .iter()
        .find_map(|call| {
            let call_id = call
                .get("id")
                .or_else(|| call.get("call_id"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|call_id| !call_id.is_empty())?;
            chat_tool_call_is_stopless_cli(call).then_some(call_id)
        })
}

fn chat_tool_output_call_id(item: &Value) -> Option<&str> {
    if item.get("role").and_then(Value::as_str) != Some("tool") {
        return None;
    }
    item.get("tool_call_id")
        .or_else(|| item.get("call_id"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|call_id| !call_id.is_empty())
}

fn chat_output_pairs_immediately_after_stopless_cli_call(
    output: &Value,
    previous: Option<&Value>,
) -> bool {
    let Some(output_call_id) = chat_tool_output_call_id(output) else {
        return false;
    };
    previous
        .and_then(stopless_chat_cli_call_id)
        .is_some_and(|call_id| call_id == output_call_id)
}

fn is_stopless_chat_cli_call(item: &Value) -> bool {
    item.get("role").and_then(Value::as_str) == Some("assistant")
        && item
            .get("tool_calls")
            .and_then(Value::as_array)
            .is_some_and(|calls| calls.iter().any(chat_tool_call_is_stopless_cli))
}

fn chat_tool_call_is_stopless_cli(call: &Value) -> bool {
    call.get("id")
        .or_else(|| call.get("call_id"))
        .and_then(Value::as_str)
        .is_some_and(|call_id| call_id == STOPLESS_CALL_ID)
        || (tool_name_is_exec_command(
            call.pointer("/function/name")
                .or_else(|| call.get("name"))
                .and_then(Value::as_str),
        ) && call
            .pointer("/function/arguments")
            .or_else(|| call.get("arguments"))
            .and_then(Value::as_str)
            .is_some_and(argument_is_exact_stopless_cli_command))
}

fn chat_message_is_stopless_reset_boundary(item: &Value) -> bool {
    if is_stopless_chat_cli_call(item) || is_stopless_chat_cli_output(item) {
        return false;
    }
    matches!(
        item.get("role").and_then(Value::as_str),
        Some("user" | "assistant")
    )
}

fn is_stopless_reset_boundary_item(item: &Value) -> bool {
    if is_stopless_cli_call(item) || is_stopless_cli_output(item) {
        return false;
    }
    let role = item.get("role").and_then(Value::as_str).unwrap_or_default();
    if matches!(role, "user" | "assistant") {
        return true;
    }
    match item.get("type").and_then(Value::as_str).unwrap_or_default() {
        "function_call"
        | "custom_tool_call"
        | "tool_call"
        | "function_call_output"
        | "custom_tool_call_output"
        | "tool_call_output" => true,
        "message" => !matches!(role, "developer" | "system"),
        _ => false,
    }
}

fn is_stopless_cli_call(item: &Value) -> bool {
    matches!(
        item.get("type").and_then(Value::as_str),
        Some("function_call" | "tool_call")
    ) && (item
        .get("call_id")
        .and_then(Value::as_str)
        .is_some_and(|call_id| call_id == STOPLESS_CALL_ID)
        || item_is_exact_stopless_cli_command_call(item))
}

#[cfg(test)]
#[path = "servertool_hooks_tests.rs"]
mod servertool_hooks_tests;


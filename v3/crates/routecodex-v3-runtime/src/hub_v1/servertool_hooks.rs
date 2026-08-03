use super::{
    V3HubRelayRequestError, V3HubRelayRequestHookEvent, V3HubRelayResponseError,
    V3HubRelayResponseHookProfile, V3HubRespInbound02Normalized, V3StoplessCenterState,
    V3StoplessCenterSteering,
};
use serde_json::{json, Map, Value};
use servertool_core::stop_visible_text::{
    build_stop_message_terminal_visible_payload, StopMessageTerminalVisiblePayloadInput,
};
use std::sync::Arc;

const STOPLESS_CALL_ID: &str = "call_stopless_reasoning";
pub(crate) fn is_v3_stopless_internal_call_id(call_id: &str) -> bool {
    call_id == STOPLESS_CALL_ID
}

pub struct V3StoplessResponseHookOutcome {
    pub input: V3HubRespInbound02Normalized,
    pub center_state: Option<V3StoplessCenterState>,
    pub intercepted: bool,
}

pub fn apply_v3_tool_call_servertool_hook_at_resp03(
    mut input: V3HubRespInbound02Normalized,
    profile: &V3HubRelayResponseHookProfile,
) -> Result<V3StoplessResponseHookOutcome, V3HubRelayResponseError> {
    if !profile.stopless_reasoning_stop_enabled() || !profile.stopless_schema_guidance_active() {
        return Ok(V3StoplessResponseHookOutcome {
            input,
            center_state: None,
            intercepted: false,
        });
    }
    let object = input
        .provider_payload()
        .as_object()
        .ok_or(V3HubRelayResponseError::ProviderResponseNotObject)?;
    if let Some(tool_call) = first_reasoning_stop_tool_call(object.get("output"))? {
        return match classify_reasoning_stop_arguments(tool_call.arguments) {
            V3ReasoningStopDecision::Terminal { prefix } => {
                let projected = build_stopless_terminal_visible_payload_from_reasoning_stop_prefix(
                    input.provider_payload(),
                    prefix,
                );
                *input.provider_payload_mut() = Arc::new(projected);
                Ok(V3StoplessResponseHookOutcome {
                    input,
                    center_state: None,
                    intercepted: true,
                })
            }
            V3ReasoningStopDecision::Continue => {
                let consecutive_stop_count = next_stopless_consecutive_stop_count(profile);
                let state = V3StoplessCenterState::new(
                    consecutive_stop_count,
                    stopless_max_natural_stops(profile),
                    V3StoplessCenterSteering::Continue,
                )
                .with_last_request_id(profile.stopless_transition_request_id())
                .with_last_response_id(stopless_response_id(input.provider_payload()))
                .with_last_transition_reason("reasoning_stop_continue_cli_projected")
                .with_last_provider_stopless_call_id(Some(tool_call.call_id))
                .with_updated_at(profile.stopless_transition_updated_at().unwrap_or(0));
                if state.guard_exhausted() {
                    let projected =
                        build_stopless_guard_passthrough_visible_payload(input.provider_payload());
                    *input.provider_payload_mut() = Arc::new(projected);
                    return Ok(V3StoplessResponseHookOutcome {
                        input,
                        center_state: None,
                        intercepted: true,
                    });
                }
                let projected =
                    build_stopless_guard_passthrough_visible_payload(input.provider_payload());
                *input.provider_payload_mut() = Arc::new(projected);
                Ok(V3StoplessResponseHookOutcome {
                    input,
                    center_state: Some(state),
                    intercepted: true,
                })
            }
            V3ReasoningStopDecision::NeedsEvidence => {
                let consecutive_stop_count = next_stopless_consecutive_stop_count(profile);
                let state = V3StoplessCenterState::new(
                    consecutive_stop_count,
                    stopless_max_natural_stops(profile),
                    V3StoplessCenterSteering::ReasoningStopNeedsEvidence,
                )
                .with_last_request_id(profile.stopless_transition_request_id())
                .with_last_response_id(stopless_response_id(input.provider_payload()))
                .with_last_transition_reason("reasoning_stop_needs_evidence_cli_projected")
                .with_last_provider_stopless_call_id(Some(tool_call.call_id))
                .with_updated_at(profile.stopless_transition_updated_at().unwrap_or(0));
                if state.guard_exhausted() {
                    let projected =
                        build_stopless_guard_passthrough_visible_payload(input.provider_payload());
                    *input.provider_payload_mut() = Arc::new(projected);
                    return Ok(V3StoplessResponseHookOutcome {
                        input,
                        center_state: None,
                        intercepted: true,
                    });
                }
                let projected =
                    build_stopless_guard_passthrough_visible_payload(input.provider_payload());
                *input.provider_payload_mut() = Arc::new(projected);
                Ok(V3StoplessResponseHookOutcome {
                    input,
                    center_state: Some(state),
                    intercepted: true,
                })
            }
        };
    }
    let cleaned = build_stopless_control_echo_cleaned_payload(input.provider_payload());
    *input.provider_payload_mut() = Arc::new(cleaned);
    Ok(V3StoplessResponseHookOutcome {
        input,
        center_state: None,
        intercepted: false,
    })
}

pub fn apply_v3_stop_servertool_hook_at_resp03(
    mut input: V3HubRespInbound02Normalized,
    profile: &V3HubRelayResponseHookProfile,
) -> Result<V3StoplessResponseHookOutcome, V3HubRelayResponseError> {
    if !profile.stopless_reasoning_stop_enabled() || !profile.stopless_schema_guidance_active() {
        return Ok(V3StoplessResponseHookOutcome {
            input,
            center_state: None,
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
    let cleaned = build_stopless_control_echo_cleaned_payload(input.provider_payload());
    *input.provider_payload_mut() = Arc::new(cleaned);
    if status != "completed" {
        return Ok(V3StoplessResponseHookOutcome {
            input,
            center_state: None,
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
            intercepted: false,
        });
    }
    if response_has_canonical_reasoning_summary(input.provider_payload().as_ref()) {
        if let Some(decision) = response_summary_stop_schema_decision(input.provider_payload()) {
            return match decision {
                V3SummaryStopSchemaDecision::Finished => Ok(V3StoplessResponseHookOutcome {
                    input,
                    center_state: None,
                    intercepted: false,
                }),
                V3SummaryStopSchemaDecision::Blocked { reason } => {
                    let projected = build_summary_blocked_passthrough_payload(
                        input.provider_payload(),
                        &reason,
                    );
                    *input.provider_payload_mut() = Arc::new(projected);
                    Ok(V3StoplessResponseHookOutcome {
                        input,
                        center_state: None,
                        intercepted: true,
                    })
                }
                V3SummaryStopSchemaDecision::Continue {
                    next_step,
                    transition_reason,
                    steering,
                } => project_stopless_noop_for_stop_candidate(
                    input,
                    profile,
                    steering,
                    transition_reason,
                    next_step,
                ),
            };
        }
        return Ok(V3StoplessResponseHookOutcome {
            input,
            center_state: None,
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
    let cleaned = build_stopless_passthrough_visible_payload(input.provider_payload());
    *input.provider_payload_mut() = Arc::new(cleaned);
    if natural_stop_count > max_natural_stops {
        return Ok(V3StoplessResponseHookOutcome {
            input,
            center_state: None,
            intercepted: false,
        });
    }
    Ok(V3StoplessResponseHookOutcome {
        center_state: Some(
            V3StoplessCenterState::new(natural_stop_count, max_natural_stops, steering)
                .with_next_step_prompt(next_step)
                .with_last_request_id(profile.stopless_transition_request_id())
                .with_last_response_id(stopless_response_id(input.provider_payload()))
                .with_last_transition_reason(transition_reason)
                .with_updated_at(profile.stopless_transition_updated_at().unwrap_or(0)),
        ),
        input,
        intercepted: false,
    })
}

pub fn apply_v3_stopless_request_hook_at_req04(
    payload: &mut Value,
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
    let Some((index, _output)) = active_stopless_cli_output(input) else {
        strip_stopless_cli_artifacts(input);
        strip_stopless_generated_system_guidance_items(input);
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
    strip_active_stopless_pair_and_stale(input, index);
    strip_stopless_generated_system_guidance_items(input);
    events.push(V3HubRelayRequestHookEvent::Req04StoplessResultParsed);
    Ok(state
        .map(|state| state.provider_turn_in_flight(transition_request_id, transition_updated_at)))
}

fn apply_v3_stopless_chat_request_hook_at_req04(
    payload: &mut Value,
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
    let Some(index) = active_stopless_chat_cli_output(messages) else {
        strip_stopless_chat_cli_artifacts(messages);
        strip_stopless_generated_system_guidance_items(messages);
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
    strip_active_stopless_chat_pair_and_stale(messages, index);
    strip_stopless_generated_system_guidance_items(messages);
    events.push(V3HubRelayRequestHookEvent::Req04StoplessResultParsed);
    Ok(state
        .map(|state| state.provider_turn_in_flight(transition_request_id, transition_updated_at)))
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

struct V3ReasoningStopToolCall<'a> {
    call_id: &'a str,
    arguments: &'a str,
}

fn first_reasoning_stop_tool_call(
    output: Option<&Value>,
) -> Result<Option<V3ReasoningStopToolCall<'_>>, V3HubRelayResponseError> {
    let Some(output) = output.and_then(Value::as_array) else {
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
        let Some(name) = item.get("name").and_then(Value::as_str).or_else(|| {
            item.get("function")
                .and_then(Value::as_object)
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
        }) else {
            continue;
        };
        if !name.trim().eq_ignore_ascii_case("reasoningStop") {
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
            })?;
        let arguments = item
            .get("arguments")
            .or_else(|| item.get("input"))
            .and_then(Value::as_str)
            .or_else(|| {
                item.get("function")
                    .and_then(Value::as_object)
                    .and_then(|function| function.get("arguments"))
                    .and_then(Value::as_str)
            })
            .ok_or(V3HubRelayResponseError::MalformedToolCall {
                index,
                reason: "reasoningStop tool call missing arguments",
            })?;
        return Ok(Some(V3ReasoningStopToolCall { call_id, arguments }));
    }
    Ok(None)
}

fn response_has_canonical_reasoning_summary(response: &Value) -> bool {
    let response = response.get("response").unwrap_or(response);
    response
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("reasoning"))
        .any(reasoning_item_has_non_empty_summary_text)
}

fn reasoning_item_has_non_empty_summary_text(item: &Value) -> bool {
    item.get("summary")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|entry| {
            entry
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| !text.trim().is_empty())
        })
}

enum V3SummaryStopSchemaDecision {
    Finished,
    Continue {
        next_step: Option<String>,
        transition_reason: &'static str,
        steering: V3StoplessCenterSteering,
    },
    Blocked {
        reason: String,
    },
}

fn response_summary_stop_schema_decision(response: &Value) -> Option<V3SummaryStopSchemaDecision> {
    let response = response.get("response").unwrap_or(response);
    response
        .get("output")
        .and_then(Value::as_array)?
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("reasoning"))
        .filter(|item| reasoning_item_has_non_empty_summary_text(item))
        .find_map(reasoning_item_stop_schema_decision)
}

fn reasoning_item_stop_schema_decision(item: &Value) -> Option<V3SummaryStopSchemaDecision> {
    let schema = item
        .get("stop_schema")
        .or_else(|| item.get("stopSchema"))?
        .as_object()?;
    let finished = read_stop_schema_bool(schema, "finished");
    let blocked = read_stop_schema_bool(schema, "blocked");
    let next_step = read_first_stop_schema_text(schema, &["nextStep", "next_step"]);
    let has_recognized_field = finished.is_some() || blocked.is_some() || next_step.is_some();
    if !has_recognized_field {
        return None;
    }
    if finished == Some(true) {
        return Some(V3SummaryStopSchemaDecision::Finished);
    }
    if blocked == Some(true) {
        if let Some(reason) =
            read_first_stop_schema_text(schema, &["blockedReason", "blocked_reason", "reason"])
        {
            return Some(V3SummaryStopSchemaDecision::Blocked { reason });
        }
        return Some(V3SummaryStopSchemaDecision::Continue {
            next_step,
            transition_reason: "summary_stop_schema_blocked_reason_missing_cli_projected",
            steering: V3StoplessCenterSteering::ReasoningStopNeedsEvidence,
        });
    }
    Some(V3SummaryStopSchemaDecision::Continue {
        transition_reason: if next_step.is_some() {
            "summary_stop_schema_next_step_cli_projected"
        } else {
            "summary_stop_schema_continue_cli_projected"
        },
        next_step,
        steering: V3StoplessCenterSteering::Continue,
    })
}

fn read_stop_schema_bool(object: &Map<String, Value>, key: &str) -> Option<bool> {
    object.get(key).and_then(Value::as_bool)
}

fn read_first_stop_schema_text(object: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        object
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
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

enum V3ReasoningStopDecision {
    Continue,
    NeedsEvidence,
    Terminal { prefix: String },
}

fn classify_reasoning_stop_arguments(arguments: &str) -> V3ReasoningStopDecision {
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(arguments.trim()) else {
        return V3ReasoningStopDecision::NeedsEvidence;
    };
    let Some(stopreason) = read_reasoning_stop_u8(&object, "stopreason") else {
        return V3ReasoningStopDecision::NeedsEvidence;
    };
    match stopreason {
        0 => {
            let evidence = read_reasoning_stop_text(&object, "evidence");
            if evidence.is_empty() {
                return V3ReasoningStopDecision::NeedsEvidence;
            }
            let reason = read_reasoning_stop_text(&object, "reason");
            let prefix = if reason.is_empty() {
                format!("完成。\n证据：{evidence}")
            } else {
                format!("完成：{reason}\n证据：{evidence}")
            };
            V3ReasoningStopDecision::Terminal { prefix }
        }
        1 => {
            let reason = read_reasoning_stop_text(&object, "reason");
            let evidence = read_reasoning_stop_text(&object, "evidence");
            if reason.is_empty() || evidence.is_empty() {
                return V3ReasoningStopDecision::NeedsEvidence;
            }
            V3ReasoningStopDecision::Terminal {
                prefix: format!("阻塞：{reason}\n证据：{evidence}"),
            }
        }
        2 => V3ReasoningStopDecision::Continue,
        _ => V3ReasoningStopDecision::NeedsEvidence,
    }
}

fn read_reasoning_stop_u8(object: &Map<String, Value>, key: &str) -> Option<u8> {
    object.get(key).and_then(|value| {
        value
            .as_u64()
            .and_then(|value| u8::try_from(value).ok())
            .or_else(|| value.as_str()?.trim().parse().ok())
    })
}

fn read_reasoning_stop_text(object: &Map<String, Value>, key: &str) -> String {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
        .to_string()
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

fn build_stopless_terminal_visible_payload_from_reasoning_stop_prefix(
    payload: &Value,
    prefix: String,
) -> Value {
    let mut payload =
        build_stop_message_terminal_visible_payload(StopMessageTerminalVisiblePayloadInput {
            payload: payload.clone(),
            mode: Some("replace".to_string()),
            prefix: Some(prefix),
        })
        .payload;
    finalize_stopless_terminal_responses_payload(&mut payload);
    payload
}

fn build_stopless_control_echo_cleaned_payload(payload: &Value) -> Value {
    let mut payload = payload.clone();
    strip_stopless_internal_control_echo_from_payload(&mut payload);
    payload
}

fn strip_stopless_internal_control_echo_from_payload(payload: &mut Value) {
    if let Some(response) = payload.get_mut("response") {
        strip_stopless_internal_control_echo_from_payload(response);
    }
    if let Some(object) = payload.as_object_mut() {
        strip_stopless_internal_control_echo_from_object(object);
        strip_stopless_internal_tools_from_object(object);
    }
}

fn finalize_stopless_terminal_responses_payload(payload: &mut Value) {
    let Some(object) = payload.as_object_mut() else {
        return;
    };
    if let Some("requires_action" | "in_progress" | "queued") =
        object.get("status").and_then(Value::as_str)
    {
        object.insert("status".to_string(), Value::String("completed".to_string()));
    }
    object.remove("required_action");
    object.remove("requiredAction");
    object
        .entry("finish_reason".to_string())
        .or_insert_with(|| Value::String("stop".to_string()));
    object
        .entry("finishReason".to_string())
        .or_insert_with(|| Value::String("stop".to_string()));
    strip_stopless_internal_control_echo_from_object(object);
    strip_stopless_internal_tools_from_object(object);
    if let Some(output) = object.get_mut("output").and_then(Value::as_array_mut) {
        for item in output {
            if item.get("type").and_then(Value::as_str) == Some("message") {
                if let Some(row) = item.as_object_mut() {
                    row.entry("status".to_string())
                        .or_insert_with(|| Value::String("completed".to_string()));
                    row.entry("role".to_string())
                        .or_insert_with(|| Value::String("assistant".to_string()));
                }
            }
        }
    }
}

fn strip_stopless_internal_control_echo_from_object(object: &mut Map<String, Value>) {
    if let Some(cleaned) = object
        .get("instructions")
        .and_then(Value::as_str)
        .map(strip_legacy_stopless_instruction)
    {
        if cleaned.trim().is_empty() {
            object.remove("instructions");
        } else {
            object.insert("instructions".to_string(), Value::String(cleaned));
        }
    }
    let only_stopless_tools = object
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|tools| !tools.is_empty() && tools.iter().all(tool_name_is_stopless_internal));
    let stopless_required_choice = matches!(
        object.get("tool_choice"),
        Some(Value::String(choice)) if choice.trim().eq_ignore_ascii_case("required")
    ) || matches!(
        object.get("tool_choice"),
        Some(Value::Object(choice))
            if choice
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|value| value.trim().eq_ignore_ascii_case("required"))
    );
    if only_stopless_tools && stopless_required_choice {
        object.remove("tool_choice");
    }
}

fn strip_stopless_internal_tools_from_object(object: &mut Map<String, Value>) {
    let Some(tools) = object.get_mut("tools").and_then(Value::as_array_mut) else {
        return;
    };
    tools.retain(|tool| !tool_name_is_stopless_internal(tool));
    if tools.is_empty() {
        object.remove("tools");
    }
}

fn tool_name_is_stopless_internal(tool: &Value) -> bool {
    read_tool_name(tool).is_some_and(is_stopless_internal_tool_name)
}

fn is_stopless_internal_tool_name(name: &str) -> bool {
    let normalized = name.trim().to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "reasoningstop" | "reasoning_stop" | "stop_message_auto"
    )
}

fn read_tool_name(tool: &Value) -> Option<&str> {
    tool.get("name").and_then(Value::as_str).or_else(|| {
        tool.get("function")
            .and_then(Value::as_object)
            .and_then(|function| function.get("name"))
            .and_then(Value::as_str)
    })
}

fn build_stopless_passthrough_visible_payload(payload: &Value) -> Value {
    let mut payload =
        build_stop_message_terminal_visible_payload(StopMessageTerminalVisiblePayloadInput {
            payload: payload.clone(),
            mode: Some("strip".to_string()),
            prefix: None,
        })
        .payload;
    strip_canonical_stop_schema_fields(&mut payload);
    strip_empty_responses_visible_messages(&mut payload);
    payload
}

fn build_summary_blocked_passthrough_payload(payload: &Value, reason: &str) -> Value {
    let mut payload = payload.clone();
    append_blocked_reason_to_canonical_reasoning_summary(&mut payload, reason);
    payload
}

fn append_blocked_reason_to_canonical_reasoning_summary(payload: &mut Value, reason: &str) {
    let reason = reason.trim();
    if reason.is_empty() {
        return;
    }
    if let Some(response) = payload.get_mut("response") {
        append_blocked_reason_to_canonical_reasoning_summary(response, reason);
    }
    let Some(output) = payload.get_mut("output").and_then(Value::as_array_mut) else {
        return;
    };
    for item in output {
        if item.get("type").and_then(Value::as_str) != Some("reasoning") {
            continue;
        }
        if !reasoning_item_has_non_empty_summary_text(item) {
            continue;
        }
        let Some(summary) = item.get_mut("summary").and_then(Value::as_array_mut) else {
            continue;
        };
        if summary.iter().any(|entry| {
            entry
                .get("text")
                .and_then(Value::as_str)
                .is_some_and(|text| text.contains(reason))
        }) {
            return;
        }
        summary.push(json!({
            "type": "summary_text",
            "text": format!("阻塞：{reason}")
        }));
        return;
    }
}

fn strip_canonical_stop_schema_fields(payload: &mut Value) {
    if let Some(response) = payload.get_mut("response") {
        strip_canonical_stop_schema_fields(response);
    }
    let Some(output) = payload.get_mut("output").and_then(Value::as_array_mut) else {
        return;
    };
    for item in output {
        if item.get("type").and_then(Value::as_str) != Some("reasoning") {
            continue;
        }
        let Some(object) = item.as_object_mut() else {
            continue;
        };
        object.remove("stop_schema");
        object.remove("stopSchema");
    }
}

fn build_stopless_guard_passthrough_visible_payload(payload: &Value) -> Value {
    let mut payload = build_stopless_passthrough_visible_payload(payload);
    finalize_stopless_terminal_responses_payload(&mut payload);
    payload
}

fn strip_empty_responses_visible_messages(payload: &mut Value) {
    let Some(object) = payload.as_object_mut() else {
        return;
    };
    if object
        .get("output_text")
        .and_then(Value::as_str)
        .is_some_and(|text| text.trim().is_empty())
    {
        object.remove("output_text");
    }
    let Some(output) = object.get_mut("output").and_then(Value::as_array_mut) else {
        return;
    };
    output.retain(|item| {
        item.get("type").and_then(Value::as_str) != Some("message")
            || responses_message_item_has_visible_text(item)
    });
}

fn responses_message_item_has_visible_text(item: &Value) -> bool {
    item.get("text")
        .or_else(|| item.get("output_text"))
        .is_some_and(value_has_non_empty_text)
        || item
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|part| {
                part.get("text")
                    .or_else(|| part.get("output_text"))
                    .is_some_and(value_has_non_empty_text)
            })
}

fn value_has_non_empty_text(value: &Value) -> bool {
    value
        .as_str()
        .map(str::trim)
        .is_some_and(|text| !text.is_empty())
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

fn active_stopless_cli_output(input: &[Value]) -> Option<(usize, &Value)> {
    let mut index = input.len();
    while index > 0 {
        index -= 1;
        let item = &input[index];
        if is_stopless_cli_output(item) {
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
        if is_stopless_chat_cli_output(item) {
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

fn is_stopless_chat_cli_call(item: &Value) -> bool {
    item.get("role").and_then(Value::as_str) == Some("assistant")
        && item
            .get("tool_calls")
            .and_then(Value::as_array)
            .is_some_and(|calls| {
                calls.iter().any(|call| {
                    call.get("id")
                        .or_else(|| call.get("call_id"))
                        .and_then(Value::as_str)
                        .is_some_and(|call_id| call_id == STOPLESS_CALL_ID)
                        || call
                            .pointer("/function/arguments")
                            .or_else(|| call.get("arguments"))
                            .and_then(Value::as_str)
                            .is_some_and(|value| {
                                value.contains("routecodex hook run reasoningStop")
                            })
                })
            })
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
    if is_stopless_cli_artifact(item) {
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

fn strip_active_stopless_pair_and_stale(input: &mut Vec<Value>, output_index: usize) {
    let call_index = output_index
        .checked_sub(1)
        .filter(|index| input.get(*index).is_some_and(is_stopless_cli_call));
    let mut next = Vec::with_capacity(input.len());
    let original = std::mem::take(input);
    for (index, item) in original.iter().enumerate() {
        if input_item_is_stopless_cli_projection_message_before_call(item, original.get(index + 1))
        {
            continue;
        }
        if Some(index) == call_index {
            continue;
        }
        if index == output_index {
            continue;
        }
        if is_stopless_cli_artifact(item) {
            continue;
        }
        if is_stopless_generated_continuation_item(item) {
            continue;
        }
        next.push(item.clone());
    }
    *input = next;
}

fn strip_active_stopless_chat_pair_and_stale(messages: &mut Vec<Value>, output_index: usize) {
    let call_index = output_index
        .checked_sub(1)
        .filter(|index| messages.get(*index).is_some_and(is_stopless_chat_cli_call));
    let original = std::mem::take(messages);
    for (index, item) in original.iter().enumerate() {
        if Some(index) == call_index || index == output_index {
            continue;
        }
        if is_stopless_chat_cli_call(item) || is_stopless_chat_cli_output(item) {
            continue;
        }
        if is_stopless_generated_continuation_item(item) {
            continue;
        }
        messages.push(item.clone());
    }
}

fn strip_stopless_cli_artifacts(input: &mut Vec<Value>) {
    let original = std::mem::take(input);
    for (index, item) in original.iter().enumerate() {
        if input_item_is_stopless_cli_projection_message_before_call(item, original.get(index + 1))
        {
            continue;
        }
        if is_stopless_cli_artifact(item) {
            continue;
        }
        if is_stopless_generated_continuation_item(item) {
            continue;
        }
        input.push(item.clone());
    }
}

fn strip_stopless_chat_cli_artifacts(messages: &mut Vec<Value>) {
    let original = std::mem::take(messages);
    for item in original {
        if is_stopless_chat_cli_call(&item) || is_stopless_chat_cli_output(&item) {
            continue;
        }
        if is_stopless_generated_continuation_item(&item) {
            continue;
        }
        messages.push(item);
    }
}

fn strip_stopless_generated_system_guidance_items(items: &mut Vec<Value>) {
    let original = std::mem::take(items);
    for mut item in original {
        if strip_stopless_generated_system_guidance_item(&mut item) {
            continue;
        }
        items.push(item);
    }
}

fn strip_stopless_generated_system_guidance_item(item: &mut Value) -> bool {
    let Some(object) = item.as_object_mut() else {
        return false;
    };
    let role = object
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(role, "system" | "developer") {
        return false;
    }
    let mut changed = false;
    if let Some(content) = object.get_mut("content") {
        changed = strip_stopless_generated_guidance_from_content(content);
    }
    changed && stopless_generated_guidance_item_is_empty(object)
}

fn strip_stopless_generated_guidance_from_content(content: &mut Value) -> bool {
    match content {
        Value::String(text) => {
            let cleaned = strip_legacy_stopless_instruction(text);
            if cleaned == *text {
                return false;
            }
            if cleaned.trim().is_empty() {
                *content = Value::Null;
            } else {
                *text = cleaned;
            }
            true
        }
        Value::Array(parts) => {
            let mut changed = false;
            let original = std::mem::take(parts);
            for mut part in original {
                let original_text = part.get("text").and_then(Value::as_str).map(str::to_string);
                if let Some(text) = original_text {
                    let cleaned = strip_legacy_stopless_instruction(&text);
                    if cleaned != text {
                        changed = true;
                        if cleaned.trim().is_empty() {
                            continue;
                        }
                        if let Some(object) = part.as_object_mut() {
                            object.insert("text".to_string(), Value::String(cleaned));
                        }
                    }
                }
                parts.push(part);
            }
            if parts.is_empty() {
                *content = Value::Null;
            }
            changed
        }
        _ => false,
    }
}

fn stopless_generated_guidance_item_is_empty(object: &Map<String, Value>) -> bool {
    object.iter().all(|(key, value)| match key.as_str() {
        "role" => true,
        "type" => value.as_str().is_some_and(|value| value == "message"),
        "content" => match value {
            Value::Null => true,
            Value::String(text) => text.trim().is_empty(),
            Value::Array(parts) => parts.is_empty(),
            _ => false,
        },
        _ => false,
    })
}

fn is_stopless_cli_artifact(item: &Value) -> bool {
    is_stopless_cli_call(item) || is_stopless_cli_output(item)
}

fn is_stopless_generated_continuation_item(item: &Value) -> bool {
    if item.get("role").and_then(Value::as_str) != Some("user") {
        return false;
    }
    let Some(content) = item.get("content").and_then(Value::as_str) else {
        return false;
    };
    is_stopless_generated_continuation_content(content)
}

fn is_stopless_generated_continuation_content(content: &str) -> bool {
    let content = content.trim_start();
    content.starts_with("继续当前目标。")
        && content.contains("基于已经恢复的完整上下文")
        && (content.contains("复核当前目标") || content.contains("当前目标的缺口"))
        && content.contains("reasoningStop")
        && content.contains("needs_user_input")
}

fn input_item_is_stopless_cli_projection_message_before_call(
    item: &Value,
    next_item: Option<&Value>,
) -> bool {
    next_item.is_some_and(is_stopless_cli_call) && is_stopless_cli_projection_message(item)
}

fn is_stopless_cli_projection_message(item: &Value) -> bool {
    item.get("type").and_then(Value::as_str) == Some("message")
        && item
            .get("role")
            .and_then(Value::as_str)
            .is_some_and(|role| role == "assistant")
        && responses_message_item_has_visible_text(item)
}

fn is_stopless_cli_call(item: &Value) -> bool {
    matches!(
        item.get("type").and_then(Value::as_str),
        Some("function_call" | "tool_call")
    ) && (item
        .get("call_id")
        .and_then(Value::as_str)
        .is_some_and(|call_id| call_id == STOPLESS_CALL_ID)
        || item
            .get("arguments")
            .or_else(|| item.get("input"))
            .and_then(Value::as_str)
            .is_some_and(|value| value.contains("routecodex hook run reasoningStop")))
}

fn strip_legacy_stopless_instruction(existing: &str) -> String {
    let mut cleaned = existing.to_string();
    for marker in [
        "当前轮推进准则",
        "当前轮继续推进准则",
        "请基于已经恢复的完整上下文继续推理",
        "正常执行当前任务，不要因为 stop schema 合同",
        "上一轮 stop 响应缺少 stop schema",
        "继续完成当前目标；基于现有上下文推理并按需调用工具。停止时调用 reasoningStop",
        "继续推进当前目标；不要把 no-op 工具轮当作完成。",
        "RouteCodex stopless guideline",
        "RouteCodex stopless continuation",
        "上一轮 reasoningStop CLI no-op",
        "继续完成当前目标；如果认为已完成或阻塞，必须调用 reasoningStop",
        "如果确实阻塞，调用 reasoningStop",
        "<rcc_stop_schema>",
    ] {
        if let Some(index) = cleaned.find(marker) {
            cleaned.truncate(index);
        }
    }
    cleaned.trim_end().to_string()
}

use super::{
    is_v3_client_tool_error_output_at_req04, is_v3_client_tool_error_pair_at_req04,
    V3HubRelayRequestError, V3HubRelayRequestHookEvent, V3HubRelayResponseError,
    V3HubRelayResponseHookProfile, V3HubRespInbound02Normalized, V3StoplessHookState,
};
use serde_json::{json, Map, Value};
use servertool_core::stop_visible_text::{
    build_stop_message_terminal_visible_payload, extract_current_assistant_stop_text,
    strip_stop_schema_control_text, StopMessageTerminalVisiblePayloadInput,
};
use std::sync::Arc;
use stop_message_core::{
    build_stop_schema_budget_exhausted_summary_prefix, evaluate_stop_schema_gate,
    evaluate_stop_schema_gate_with_reasoning_stop_arguments, StopSchemaGateAction,
    StopSchemaGateDecision,
};

const STOPLESS_CALL_ID: &str = "call_stopless_reasoning";
const STOPLESS_DEFAULT_VISIBLE_TEXT: &str = "继续。";
const STOPLESS_SCHEMA_INSTRUCTION: &str = concat!(
    "停止、暂停或继续当前轮时，使用唯一 stop schema 合同。\n",
    "优先调用 reasoningStop function tool，并把 JSON schema 放进 tool call arguments。\n",
    "禁止把 reasoningStop 当成 shell / CLI 命令；不要输出或执行 exec_command(cmd=\"reasoningStop\")。\n",
    "字段是条件必填：stopreason 是唯一无条件必填字段；stopreason=0 需要 has_evidence=1 且 evidence 非空；stopreason=1 需要 reason 非空、has_evidence=1 且 evidence 非空；stopreason=2 需要 current_goal 和 next_step；needs_user_input=true 时 next_step 必须直接写要问用户的问题。\n",
    "如果收到上一轮反馈，只按反馈补对应字段；没有反馈时继续当前任务。\n",
    "如果你直接 finish_reason=stop，正文末尾必须附：\n",
    "<rcc_stop_schema>\n",
    "{\"stopreason\":2,\"reason\":\"当前状态\",\"current_goal\":\"当前目标\",\"has_evidence\":0,\"evidence\":\"\",\"issue_cause\":\"\",\"excluded_factors\":\"\",\"diagnostic_order\":\"\",\"done_steps\":\"\",\"next_step\":\"下一步动作\",\"next_suggested_path\":\"\",\"needs_user_input\":false,\"learned\":\"\"}\n",
    "</rcc_stop_schema>\n",
    "标准 JSON 字段：stopreason, reason, current_goal, has_evidence, evidence, issue_cause, excluded_factors, diagnostic_order, done_steps, next_step, next_suggested_path, needs_user_input, learned。\n",
    "stopreason 取值：0=finished，1=blocked，2=continue_needed。\n",
    "needs_user_input 只能是 true/false；true 只用于真的需要向用户提一个问题。\n",
    "最小可复制样本：{\"stopreason\":2,\"reason\":\"当前状态\",\"current_goal\":\"当前目标\",\"has_evidence\":0,\"evidence\":\"\",\"next_step\":\"下一步动作\",\"needs_user_input\":false}。\n",
    "没有 reasoningStop arguments 时，使用 <rcc_stop_schema>。"
);

pub fn apply_v3_stopless_response_hook_at_resp03(
    mut input: V3HubRespInbound02Normalized,
    profile: &V3HubRelayResponseHookProfile,
) -> Result<V3HubRespInbound02Normalized, V3HubRelayResponseError> {
    if !profile.stopless_reasoning_stop_enabled() {
        return Ok(input);
    }
    let object = input
        .provider_payload()
        .as_object()
        .ok_or(V3HubRelayResponseError::ProviderResponseNotObject)?;
    let status = object
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if let Some(arguments) = first_reasoning_stop_tool_call_arguments(object.get("output")) {
        let schema_decision = classify_stopless_reasoning_stop_arguments(arguments);
        let cli_input = match schema_decision {
            V3StoplessSchemaDecision::Terminal => {
                let projected =
                    build_stopless_terminal_visible_payload_from_reasoning_stop_arguments(
                        input.provider_payload(),
                        arguments,
                    );
                *input.provider_payload_mut() = Arc::new(projected);
                return Ok(input);
            }
            V3StoplessSchemaDecision::Continue => stopless_cli_input_from_reasoning_stop_arguments(
                arguments,
                profile,
                "non_terminal_schema",
            ),
            V3StoplessSchemaDecision::Invalid => stopless_cli_input_from_reasoning_stop_arguments(
                arguments,
                profile,
                "invalid_schema",
            )
            .or_else(|| stopless_invalid_schema_cli_input_from_profile(profile)),
            V3StoplessSchemaDecision::Missing => stopless_no_schema_cli_input_from_profile(profile),
        };
        let Some(cli_input) = cli_input else {
            let projected =
                build_stopless_budget_exhausted_visible_payload_from_reasoning_stop_arguments(
                    input.provider_payload(),
                    arguments,
                );
            *input.provider_payload_mut() = Arc::new(projected);
            return Ok(input);
        };
        let projected = build_stopless_cli_projection_payload(input.provider_payload(), &cli_input);
        *input.provider_payload_mut() = Arc::new(projected);
        return Ok(input);
    }
    if status != "completed" {
        return Ok(input);
    }
    let stop_candidate = response_has_stopless_stop_trigger(input.provider_payload().as_ref())
        || response_is_completed_responses_object_without_finish_reason(
            input.provider_payload().as_ref(),
        );
    let output_text = first_output_text(object.get("output"))
        .map(str::to_string)
        .filter(|text| !text.trim().is_empty());
    let schema_decision = match output_text.as_deref() {
        Some(text) => classify_stopless_schema(text),
        None if stop_candidate => V3StoplessSchemaDecision::Missing,
        None => return Ok(input),
    };
    let cli_input = match schema_decision {
        V3StoplessSchemaDecision::Terminal => {
            let text = output_text
                .as_deref()
                .expect("terminal stopless schema requires visible text");
            let projected = build_stopless_terminal_visible_payload(input.provider_payload(), text);
            *input.provider_payload_mut() = Arc::new(projected);
            return Ok(input);
        }
        V3StoplessSchemaDecision::Continue => {
            let text = output_text
                .as_deref()
                .expect("non-terminal stopless schema requires visible text");
            stopless_cli_input_from_schema(text, profile, "non_terminal_schema")
        }
        V3StoplessSchemaDecision::Invalid => {
            let text = output_text
                .as_deref()
                .expect("invalid stopless schema requires visible text");
            stopless_cli_input_from_schema(text, profile, "invalid_schema")
        }
        V3StoplessSchemaDecision::Missing => {
            if !stop_candidate {
                return Ok(input);
            }
            stopless_no_schema_cli_input_from_profile(profile)
        }
    };
    let Some(cli_input) = cli_input else {
        if let Some(text) = output_text.as_deref() {
            if matches!(
                schema_decision,
                V3StoplessSchemaDecision::Continue | V3StoplessSchemaDecision::Invalid
            ) && read_stopless_json_object(text).is_some()
            {
                let projected =
                    build_stopless_budget_exhausted_visible_payload(input.provider_payload(), text);
                *input.provider_payload_mut() = Arc::new(projected);
            }
        }
        return Ok(input);
    };
    let projected = build_stopless_cli_projection_payload(input.provider_payload(), &cli_input);
    *input.provider_payload_mut() = Arc::new(projected);
    Ok(input)
}

pub fn apply_v3_stopless_request_hook_at_req04(
    payload: &mut Value,
    events: &mut Vec<V3HubRelayRequestHookEvent>,
) -> Result<Option<V3StoplessHookState>, V3HubRelayRequestError> {
    let Some(input) = payload.get_mut("input").and_then(Value::as_array_mut) else {
        inject_stopless_schema(payload)?;
        events.push(V3HubRelayRequestHookEvent::Req04StoplessToolInjected);
        return Ok(None);
    };
    let Some((index, output)) = active_stopless_cli_output(input) else {
        strip_stopless_cli_artifacts(input);
        inject_stopless_schema(payload)?;
        events.push(V3HubRelayRequestHookEvent::Req04StoplessToolInjected);
        return Ok(None);
    };
    let parsed = parse_stopless_cli_output(output, index)?;
    let replacement = json!({
        "role": "user",
        "content": parsed.provider_prompt
    });
    rewrite_active_stopless_pair_and_strip_stale(input, index, replacement);
    events.push(V3HubRelayRequestHookEvent::Req04StoplessResultParsed);
    events.push(V3HubRelayRequestHookEvent::Req04StoplessTextRewritten);
    inject_stopless_schema(payload)?;
    events.push(V3HubRelayRequestHookEvent::Req04StoplessToolInjected);
    Ok(Some(parsed.state))
}

fn first_output_text(output: Option<&Value>) -> Option<&str> {
    output?.as_array()?.iter().find_map(output_item_text)
}

fn output_item_text(item: &Value) -> Option<&str> {
    match item.get("type").and_then(Value::as_str) {
        Some("output_text") => item.get("text").and_then(Value::as_str),
        Some("message") => item
            .get("text")
            .and_then(Value::as_str)
            .or_else(|| first_message_content_text(item.get("content"))),
        _ => None,
    }
}

fn first_message_content_text(content: Option<&Value>) -> Option<&str> {
    content?
        .as_array()?
        .iter()
        .find_map(|part| match part.get("type").and_then(Value::as_str) {
            Some("output_text" | "text") => part.get("text").and_then(Value::as_str),
            _ => None,
        })
}

fn first_reasoning_stop_tool_call_arguments(output: Option<&Value>) -> Option<&str> {
    output?.as_array()?.iter().find_map(|item| {
        let item_type = item.get("type").and_then(Value::as_str).unwrap_or_default();
        if !matches!(
            item_type,
            "function_call" | "tool_call" | "custom_tool_call"
        ) {
            return None;
        }
        let name = item.get("name").and_then(Value::as_str).or_else(|| {
            item.get("function")
                .and_then(Value::as_object)
                .and_then(|function| function.get("name"))
                .and_then(Value::as_str)
        })?;
        if !name.trim().eq_ignore_ascii_case("reasoningStop") {
            return None;
        }
        item.get("arguments")
            .or_else(|| item.get("input"))
            .and_then(Value::as_str)
            .or_else(|| {
                item.get("function")
                    .and_then(Value::as_object)
                    .and_then(|function| function.get("arguments"))
                    .and_then(Value::as_str)
            })
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
        response_string_path(response, path).is_some_and(|value| value.eq_ignore_ascii_case("stop"))
    })
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum V3StoplessSchemaDecision {
    Missing,
    Invalid,
    Continue,
    Terminal,
}

fn classify_stopless_schema(text: &str) -> V3StoplessSchemaDecision {
    let gate = evaluate_v3_stopless_schema_gate(text);
    match gate.action {
        StopSchemaGateAction::AllowStop => V3StoplessSchemaDecision::Terminal,
        StopSchemaGateAction::FailFast => V3StoplessSchemaDecision::Invalid,
        StopSchemaGateAction::Followup => match gate.reason_code.as_str() {
            "stop_schema_missing" => V3StoplessSchemaDecision::Missing,
            "stop_schema_continue_next_step" => V3StoplessSchemaDecision::Continue,
            _ => V3StoplessSchemaDecision::Invalid,
        },
    }
}

fn classify_stopless_reasoning_stop_arguments(arguments: &str) -> V3StoplessSchemaDecision {
    let gate =
        evaluate_stop_schema_gate_with_reasoning_stop_arguments("", Some(arguments), 0, 3, "", 0);
    match gate.action {
        StopSchemaGateAction::AllowStop => V3StoplessSchemaDecision::Terminal,
        StopSchemaGateAction::FailFast => V3StoplessSchemaDecision::Invalid,
        StopSchemaGateAction::Followup => match gate.reason_code.as_str() {
            "stop_schema_missing" => V3StoplessSchemaDecision::Missing,
            "stop_schema_continue_next_step" => V3StoplessSchemaDecision::Continue,
            _ => V3StoplessSchemaDecision::Invalid,
        },
    }
}

fn stopless_cli_input_from_schema(
    text: &str,
    profile: &V3HubRelayResponseHookProfile,
    trigger_hint: &'static str,
) -> Option<Value> {
    let gate = evaluate_v3_stopless_schema_gate(text);
    let mut value =
        read_stopless_json_object(text).filter(|value| value.get("stopreason").is_some())?;
    let state = next_stopless_projection_state(profile, Some(trigger_hint));
    if state.repeat_count >= state.max_repeats {
        return None;
    }
    if let Some(object) = value.as_object_mut() {
        object
            .entry("flowId".to_string())
            .or_insert_with(|| json!("stop_message_flow"));
        object
            .entry("repeatCount".to_string())
            .or_insert_with(|| json!(state.repeat_count));
        object
            .entry("maxRepeats".to_string())
            .or_insert_with(|| json!(state.max_repeats));
        object.insert("triggerHint".to_string(), json!(trigger_hint));
        insert_stopless_schema_feedback(object, &gate);
    }
    Some(value)
}

fn stopless_cli_input_from_reasoning_stop_arguments(
    arguments: &str,
    profile: &V3HubRelayResponseHookProfile,
    trigger_hint: &'static str,
) -> Option<Value> {
    let gate =
        evaluate_stop_schema_gate_with_reasoning_stop_arguments("", Some(arguments), 0, 3, "", 0);
    let mut value =
        read_stopless_json_object(arguments).filter(|value| value.get("stopreason").is_some())?;
    let state = next_stopless_projection_state(profile, Some(trigger_hint));
    if state.repeat_count >= state.max_repeats {
        return None;
    }
    if let Some(object) = value.as_object_mut() {
        object
            .entry("flowId".to_string())
            .or_insert_with(|| json!("stop_message_flow"));
        object
            .entry("repeatCount".to_string())
            .or_insert_with(|| json!(state.repeat_count));
        object
            .entry("maxRepeats".to_string())
            .or_insert_with(|| json!(state.max_repeats));
        object.insert("triggerHint".to_string(), json!(trigger_hint));
        insert_stopless_schema_feedback(object, &gate);
    }
    Some(value)
}

fn stopless_invalid_schema_cli_input_from_profile(
    profile: &V3HubRelayResponseHookProfile,
) -> Option<Value> {
    let state = next_stopless_projection_state(profile, Some("invalid_schema"));
    if state.repeat_count >= state.max_repeats {
        return None;
    }
    Some(json!({
        "flowId": "stop_message_flow",
        "repeatCount": state.repeat_count,
        "maxRepeats": state.max_repeats,
        "triggerHint": "invalid_schema",
        "schemaFeedback": {
            "reasonCode": "invalid_schema",
            "missingFields": []
        }
    }))
}

fn stopless_no_schema_cli_input_from_profile(
    profile: &V3HubRelayResponseHookProfile,
) -> Option<Value> {
    let state = next_stopless_projection_state(profile, Some("no_schema"));
    if state.repeat_count >= state.max_repeats {
        return None;
    }
    Some(json!({
        "flowId": "stop_message_flow",
        "repeatCount": state.repeat_count,
        "maxRepeats": state.max_repeats,
        "triggerHint": state.trigger_hint.unwrap_or_else(|| "no_schema".to_string()),
        "schemaFeedback": {
            "reasonCode": "stop_schema_missing",
            "missingFields": ["stopreason"]
        }
    }))
}

fn insert_stopless_schema_feedback(object: &mut Map<String, Value>, gate: &StopSchemaGateDecision) {
    object
        .entry("schemaFeedback".to_string())
        .or_insert_with(|| {
            json!({
                "reasonCode": gate.reason_code.clone(),
                "missingFields": gate.missing_fields.clone()
            })
        });
    if let Some(followup_text) = gate
        .followup_text
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        object
            .entry("followupText".to_string())
            .or_insert_with(|| json!(followup_text));
    }
}

fn build_stopless_terminal_visible_payload(payload: &Value, text: &str) -> Value {
    let gate = evaluate_v3_stopless_schema_gate(text);
    let mut payload =
        build_stop_message_terminal_visible_payload(StopMessageTerminalVisiblePayloadInput {
            payload: payload.clone(),
            mode: Some("strip".to_string()),
            prefix: gate.summary_prefix,
        })
        .payload;
    strip_stopless_internal_tools_from_payload(&mut payload);
    payload
}

fn build_stopless_budget_exhausted_visible_payload(payload: &Value, text: &str) -> Value {
    let gate = evaluate_v3_stopless_schema_gate(text);
    let prefix = gate
        .parsed
        .as_ref()
        .and_then(build_stop_schema_budget_exhausted_summary_prefix);
    let mut payload =
        build_stop_message_terminal_visible_payload(StopMessageTerminalVisiblePayloadInput {
            payload: payload.clone(),
            mode: Some("replace".to_string()),
            prefix,
        })
        .payload;
    finalize_stopless_terminal_responses_payload(&mut payload);
    strip_empty_responses_visible_messages(&mut payload);
    payload
}

fn build_stopless_terminal_visible_payload_from_reasoning_stop_arguments(
    payload: &Value,
    arguments: &str,
) -> Value {
    let gate =
        evaluate_stop_schema_gate_with_reasoning_stop_arguments("", Some(arguments), 0, 3, "", 0);
    let mut payload =
        build_stop_message_terminal_visible_payload(StopMessageTerminalVisiblePayloadInput {
            payload: payload.clone(),
            mode: Some("replace".to_string()),
            prefix: gate.summary_prefix,
        })
        .payload;
    finalize_stopless_terminal_responses_payload(&mut payload);
    payload
}

fn build_stopless_budget_exhausted_visible_payload_from_reasoning_stop_arguments(
    payload: &Value,
    arguments: &str,
) -> Value {
    let gate =
        evaluate_stop_schema_gate_with_reasoning_stop_arguments("", Some(arguments), 0, 3, "", 0);
    let prefix = gate
        .parsed
        .as_ref()
        .and_then(build_stop_schema_budget_exhausted_summary_prefix);
    let mut payload =
        build_stop_message_terminal_visible_payload(StopMessageTerminalVisiblePayloadInput {
            payload: payload.clone(),
            mode: Some("replace".to_string()),
            prefix,
        })
        .payload;
    finalize_stopless_terminal_responses_payload(&mut payload);
    strip_empty_responses_visible_messages(&mut payload);
    payload
}

fn finalize_stopless_terminal_responses_payload(payload: &mut Value) {
    let Some(object) = payload.as_object_mut() else {
        return;
    };
    match object.get("status").and_then(Value::as_str) {
        Some("requires_action" | "in_progress" | "queued") => {
            object.insert("status".to_string(), Value::String("completed".to_string()));
        }
        _ => {}
    }
    object.remove("required_action");
    object.remove("requiredAction");
    object
        .entry("finish_reason".to_string())
        .or_insert_with(|| Value::String("stop".to_string()));
    object
        .entry("finishReason".to_string())
        .or_insert_with(|| Value::String("stop".to_string()));
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

fn strip_stopless_internal_tools_from_payload(payload: &mut Value) {
    let Some(object) = payload.as_object_mut() else {
        return;
    };
    strip_stopless_internal_tools_from_object(object);
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
    strip_empty_responses_visible_messages(&mut payload);
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

fn build_stopless_cli_projection_payload(payload: &Value, cli_input: &Value) -> Value {
    let id = payload
        .as_object()
        .and_then(|object| object.get("id"))
        .cloned()
        .unwrap_or_else(|| json!("resp_stopless_projected"));
    let output = build_stopless_passthrough_visible_payload(payload)
        .get("output")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|item| !is_provider_tool_call_item(item))
        .collect::<Vec<_>>();
    let assistant_stop_text = extract_current_assistant_stop_text(payload);
    let mut output =
        build_stopless_client_visible_projection_output(output, assistant_stop_text.as_str());
    output.push(json!({
        "type": "function_call",
        "call_id": STOPLESS_CALL_ID,
        "name": "exec_command",
        "arguments": json!({"cmd": build_stopless_cli_command(Some(cli_input))}).to_string()
    }));
    json!({
        "id": id,
        "status": "requires_action",
        "output": output
    })
}

fn build_stopless_client_visible_projection_output(
    items: Vec<Value>,
    assistant_stop_text: &str,
) -> Vec<Value> {
    let visible_text = first_non_empty_stopless_visible_text(&items)
        .or_else(|| {
            let text = strip_stop_schema_control_text(assistant_stop_text);
            let text = text.trim().to_string();
            (!text.is_empty()).then_some(text)
        })
        .unwrap_or_else(|| STOPLESS_DEFAULT_VISIBLE_TEXT.to_string());
    vec![json!({
        "type": "message",
        "role": "assistant",
        "status": "completed",
        "content": [{
            "type": "output_text",
            "text": visible_text
        }]
    })]
}

fn first_non_empty_stopless_visible_text(items: &[Value]) -> Option<String> {
    items
        .iter()
        .filter_map(output_item_text)
        .map(strip_stop_schema_control_text)
        .map(|text| text.trim().to_string())
        .find(|text| !text.is_empty())
}

fn is_provider_tool_call_item(item: &Value) -> bool {
    matches!(
        item.get("type").and_then(Value::as_str),
        Some("function_call" | "custom_tool_call" | "tool_call")
    )
}

fn evaluate_v3_stopless_schema_gate(text: &str) -> StopSchemaGateDecision {
    let gate = evaluate_stop_schema_gate(text, 0, 3, "", 0);
    if let Some(arguments) = read_stopless_json_object(text)
        .filter(|value| value.get("stopreason").is_some())
        .map(|value| value.to_string())
    {
        return evaluate_stop_schema_gate_with_reasoning_stop_arguments(
            "",
            Some(arguments.as_str()),
            0,
            3,
            "",
            0,
        );
    }
    let control_only_terminal = gate.action == StopSchemaGateAction::AllowStop
        && gate.summary_prefix.is_none()
        && strip_stop_schema_control_text(text).trim().is_empty();
    if gate.reason_code != "stop_schema_missing" && !control_only_terminal {
        return gate;
    }
    let Some(arguments) = read_stopless_json_object(text).map(|value| value.to_string()) else {
        return gate;
    };
    evaluate_stop_schema_gate_with_reasoning_stop_arguments(
        "",
        Some(arguments.as_str()),
        0,
        3,
        "",
        0,
    )
}

#[derive(Debug, Clone)]
struct V3NextStoplessProjectionState {
    repeat_count: u32,
    max_repeats: u32,
    trigger_hint: Option<String>,
}

fn next_stopless_projection_state(
    profile: &V3HubRelayResponseHookProfile,
    trigger_hint: Option<&str>,
) -> V3NextStoplessProjectionState {
    let current = profile.stopless_request_state();
    let next_is_schema_error = stopless_trigger_consumes_error_budget(trigger_hint);
    let current_is_schema_error = current
        .and_then(|state| state.trigger_hint())
        .is_some_and(|hint| stopless_trigger_consumes_error_budget(Some(hint)));
    V3NextStoplessProjectionState {
        repeat_count: if next_is_schema_error && current_is_schema_error {
            current
                .map(V3StoplessHookState::repeat_count)
                .unwrap_or(0)
                .saturating_add(1)
        } else {
            1
        },
        max_repeats: current
            .map(V3StoplessHookState::max_repeats)
            .unwrap_or(3)
            .max(1),
        trigger_hint: trigger_hint
            .map(str::to_string)
            .or_else(|| current.and_then(|state| state.trigger_hint().map(str::to_string))),
    }
}

fn stopless_trigger_consumes_error_budget(trigger_hint: Option<&str>) -> bool {
    trigger_hint.is_some_and(|hint| matches!(hint, "no_schema" | "invalid_schema"))
}

fn read_stopless_json_object(text: &str) -> Option<Value> {
    if let Some(value) = read_tagged_stopless_json_object(text) {
        return Some(value);
    }
    let trimmed = text.trim();
    if let Ok(Value::Object(object)) = serde_json::from_str::<Value>(trimmed) {
        return Some(Value::Object(object));
    }
    read_balanced_stopless_json_object(text, true)
        .or_else(|| read_balanced_stopless_json_object(text, false))
}

fn read_tagged_stopless_json_object(text: &str) -> Option<Value> {
    for (start_marker, end_marker) in [
        ("<rcc_stop_schema>", "</rcc_stop_schema>"),
        ("<stop_schema>", "</stop_schema>"),
    ] {
        let Some(start) = text.find(start_marker) else {
            continue;
        };
        let after_start = &text[start + start_marker.len()..];
        let Some(end) = after_start.find(end_marker) else {
            return None;
        };
        let candidate = after_start[..end].trim();
        return parse_stopless_object(candidate);
    }
    read_markdown_fenced_stopless_json_object(text)
}

fn read_markdown_fenced_stopless_json_object(text: &str) -> Option<Value> {
    let mut rest = text;
    while let Some(start) = rest.find("```") {
        let after_marker = &rest[start + 3..];
        let after_lang = after_marker
            .strip_prefix("json")
            .or_else(|| after_marker.strip_prefix("JSON"))
            .unwrap_or(after_marker);
        let Some(end) = after_lang.find("```") else {
            return None;
        };
        let candidate = after_lang[..end].trim();
        if let Some(value) = parse_stopless_object(candidate) {
            return Some(value);
        }
        rest = &after_lang[end + 3..];
    }
    None
}

fn read_balanced_stopless_json_object(text: &str, require_stopreason: bool) -> Option<Value> {
    let mut start: Option<usize> = None;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (index, ch) in text.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
            continue;
        }
        if ch == '{' {
            if depth == 0 {
                start = Some(index);
            }
            depth = depth.saturating_add(1);
            continue;
        }
        if ch == '}' {
            if depth == 0 {
                continue;
            }
            depth -= 1;
            if depth == 0 {
                let Some(start_index) = start.take() else {
                    continue;
                };
                let candidate = &text[start_index..index + ch.len_utf8()];
                let Some(value) = parse_stopless_object(candidate) else {
                    continue;
                };
                if !require_stopreason || value.get("stopreason").is_some() {
                    return Some(value);
                }
            }
        }
    }
    None
}

fn parse_stopless_object(candidate: &str) -> Option<Value> {
    match serde_json::from_str::<Value>(candidate).ok()? {
        Value::Object(object) => Some(Value::Object(object)),
        _ => None,
    }
}

fn build_stopless_cli_command(cli_input: Option<&Value>) -> String {
    let input_json = cli_input
        .map(Value::to_string)
        .unwrap_or_else(|| "{}".to_string());
    let mut command = format!(
        "routecodex hook run reasoningStop --input-json {}",
        shell_quote_for_stopless_cli(&input_json)
    );
    if let Some(cli_input) = cli_input {
        if let Some(repeat_count) = read_stopless_u32_field(cli_input, "repeatCount") {
            command.push_str(&format!(" --repeat-count '{}'", repeat_count));
        }
        if let Some(max_repeats) = read_stopless_u32_field(cli_input, "maxRepeats") {
            command.push_str(&format!(" --max-repeats '{}'", max_repeats));
        }
    }
    command
}

fn shell_quote_for_stopless_cli(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
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
    let mut best: Option<(usize, &Value, V3StoplessHookState)> = None;
    let mut index = input.len();
    while index > 0 {
        index -= 1;
        let item = &input[index];
        if is_stopless_cli_output(item) {
            let Some(state) = parse_stopless_cli_output(item, index)
                .ok()
                .map(|parsed| parsed.state)
            else {
                return Some((index, item));
            };
            let replace = best.as_ref().is_none_or(|(best_index, _, best_state)| {
                state.repeat_count() > best_state.repeat_count()
                    || (state.repeat_count() == best_state.repeat_count() && index > *best_index)
            });
            if replace {
                best = Some((index, item, state));
            }
            continue;
        }
        if is_stopless_cli_call(item) {
            continue;
        }
        if is_v3_client_tool_error_output_at_req04(item) {
            continue;
        }
        if index > 0 && is_v3_client_tool_error_pair_at_req04(input, index - 1) {
            index -= 1;
            continue;
        }
        if is_v3_client_tool_error_pair_at_req04(input, index) {
            continue;
        }
        if is_stopless_reset_boundary_item(item) {
            break;
        }
    }
    best.map(|(index, output, _)| (index, output))
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

fn rewrite_active_stopless_pair_and_strip_stale(
    input: &mut Vec<Value>,
    output_index: usize,
    replacement: Value,
) {
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
            next.push(replacement.clone());
            continue;
        }
        if index == output_index {
            if call_index.is_none() {
                next.push(replacement.clone());
            }
            continue;
        }
        if is_stopless_cli_artifact(item) {
            continue;
        }
        next.push(item.clone());
    }
    *input = next;
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
        input.push(item.clone());
    }
}

fn is_stopless_cli_artifact(item: &Value) -> bool {
    is_stopless_cli_call(item) || is_stopless_cli_output(item)
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct V3ParsedStoplessCliOutput {
    provider_prompt: String,
    state: V3StoplessHookState,
}

fn parse_stopless_cli_output(
    output: &Value,
    index: usize,
) -> Result<V3ParsedStoplessCliOutput, V3HubRelayRequestError> {
    let raw = output.get("output").and_then(Value::as_str).ok_or(
        V3HubRelayRequestError::MalformedStoplessCliOutput {
            index,
            reason: "output string is required",
        },
    )?;
    let parsed = parse_stopless_cli_output_json(raw, index)?;
    let provider_prompt = build_stopless_provider_prompt_from_cli_output(&parsed, index)?;
    Ok(V3ParsedStoplessCliOutput {
        provider_prompt,
        state: parse_stopless_state_from_cli_output(&parsed),
    })
}

fn build_stopless_provider_prompt_from_cli_output(
    parsed: &Value,
    index: usize,
) -> Result<String, V3HubRelayRequestError> {
    let trigger_hint = read_stopless_cli_trigger_hint(parsed);
    let schema_feedback = read_stopless_cli_schema_feedback(parsed);
    let continuation_prompt =
        read_stopless_nested_string(parsed, &["continuationPrompt", "continuation_prompt"]);

    if let Some(prompt) = build_stopless_schema_feedback_provider_prompt(
        trigger_hint.as_deref(),
        schema_feedback.as_ref(),
    ) {
        return Ok(prompt);
    }

    if let Some(next_step) = read_stopless_nested_string(parsed, &["next_step", "nextStep"]) {
        return Ok(next_step);
    }

    if schema_feedback
        .as_ref()
        .and_then(|feedback| feedback.reason_code.as_deref())
        == Some("stop_schema_continue_next_step")
    {
        return continuation_prompt.ok_or(V3HubRelayRequestError::MalformedStoplessCliOutput {
            index,
            reason: "valid continue requires next_step or continuationPrompt",
        });
    }

    if trigger_hint.as_deref() == Some("non_terminal_schema") {
        return Ok(build_stopless_continue_missing_next_step_prompt(
            schema_feedback.as_ref(),
        ));
    }

    if trigger_hint.is_none() {
        if let Some(prompt) = continuation_prompt {
            return Ok(prompt);
        }
    }

    Err(V3HubRelayRequestError::MalformedStoplessCliOutput {
        index,
        reason: "provider prompt requires next_step or schema feedback",
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct V3StoplessCliSchemaFeedback {
    reason_code: Option<String>,
    missing_fields: Vec<String>,
}

fn read_stopless_cli_trigger_hint(parsed: &Value) -> Option<String> {
    parsed
        .get("input")
        .and_then(|input| read_stopless_nested_string(input, &["triggerHint", "trigger_hint"]))
        .or_else(|| read_stopless_nested_string(parsed, &["triggerHint", "trigger_hint"]))
        .or_else(|| {
            parsed.get("schemaFeedback").and_then(|feedback| {
                read_stopless_nested_string(feedback, &["triggerHint", "trigger_hint"])
            })
        })
}

fn read_stopless_cli_schema_feedback(parsed: &Value) -> Option<V3StoplessCliSchemaFeedback> {
    let feedback = parsed
        .get("schemaFeedback")
        .or_else(|| parsed.get("schema_feedback"))
        .or_else(|| parsed.get("input")?.get("schemaFeedback"))
        .or_else(|| parsed.get("input")?.get("schema_feedback"))?;
    let reason_code =
        read_stopless_nested_string(feedback, &["reasonCode", "reason_code", "triggerHint"]);
    let missing_fields = feedback
        .get("missingFields")
        .or_else(|| feedback.get("missing_fields"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some(V3StoplessCliSchemaFeedback {
        reason_code,
        missing_fields,
    })
}

fn build_stopless_schema_feedback_provider_prompt(
    trigger_hint: Option<&str>,
    feedback: Option<&V3StoplessCliSchemaFeedback>,
) -> Option<String> {
    let reason_code = feedback
        .and_then(|feedback| feedback.reason_code.as_deref())
        .or(trigger_hint)?;
    match reason_code {
        "no_schema" | "stop_schema_missing" => {
            Some(build_stopless_no_schema_provider_prompt(feedback))
        }
        "invalid_schema"
        | "stop_schema_stopreason_missing_or_non_numeric"
        | "stop_schema_reason_missing"
        | "stop_schema_terminal_missing_fields"
        | "stop_schema_needs_user_input_missing_next_step"
        | "stop_schema_current_goal_missing"
        | "stop_schema_next_step_missing"
        | "stop_schema_forcestop_reason_missing" => Some(
            build_stopless_invalid_schema_provider_prompt(reason_code, feedback),
        ),
        _ => None,
    }
}

fn build_stopless_no_schema_provider_prompt(
    feedback: Option<&V3StoplessCliSchemaFeedback>,
) -> String {
    let missing = stopless_missing_fields_text(feedback);
    format!(
        "上一轮 stop 响应缺少 stop schema，不能空续跑，也不能只回答“继续”。请继续执行当前任务；如果准备停止，必须在正文末尾提交 <rcc_stop_schema> JSON。缺失字段：{missing}。最低要求：stopreason 必须是数字 0/1/2；finished/blocked 需要 has_evidence=1 且 evidence 非空；blocked 还需要 reason；continue 需要 current_goal 和 next_step。"
    )
}

fn build_stopless_invalid_schema_provider_prompt(
    reason_code: &str,
    feedback: Option<&V3StoplessCliSchemaFeedback>,
) -> String {
    if reason_code == "stop_schema_next_step_missing"
        || reason_code == "stop_schema_current_goal_missing"
    {
        return build_stopless_continue_missing_next_step_prompt(feedback);
    }
    let missing = stopless_missing_fields_text(feedback);
    format!(
        "上一轮 stop schema 无效，reasonCode={reason_code}，缺失/错误字段：{missing}。请只修正这些字段后继续执行或重新提交合法 stop schema：stopreason 必须是数字 0/1/2；finished/blocked 需要 has_evidence=1 且 evidence 非空；blocked 还需要 reason；continue 需要 current_goal 和 next_step。"
    )
}

fn build_stopless_continue_missing_next_step_prompt(
    feedback: Option<&V3StoplessCliSchemaFeedback>,
) -> String {
    let missing = stopless_missing_fields_text(feedback);
    format!(
        "上一轮声明任务未完成但缺少可执行续跑字段：{missing}。请继续执行当前任务；如果仍需下一轮，请补齐 current_goal 和 next_step，其中 next_step 必须是下一步 provider-facing 普通用户提示，不得为空。"
    )
}

fn stopless_missing_fields_text(feedback: Option<&V3StoplessCliSchemaFeedback>) -> String {
    let fields = feedback
        .map(|feedback| feedback.missing_fields.as_slice())
        .unwrap_or(&[]);
    if fields.is_empty() {
        "未提供字段级列表".to_string()
    } else {
        fields.join(", ")
    }
}

fn parse_stopless_state_from_cli_output(parsed: &Value) -> V3StoplessHookState {
    let repeat_count = read_stopless_nested_u32(parsed, &["repeatCount", "repeat_count"])
        .or_else(|| {
            parsed
                .get("input")
                .and_then(|input| read_stopless_nested_u32(input, &["repeatCount", "repeat_count"]))
        })
        .unwrap_or(1)
        .max(1);
    let max_repeats = read_stopless_nested_u32(parsed, &["maxRepeats", "max_repeats"])
        .or_else(|| {
            parsed
                .get("input")
                .and_then(|input| read_stopless_nested_u32(input, &["maxRepeats", "max_repeats"]))
        })
        .unwrap_or(3)
        .max(1);
    let trigger_hint = parsed
        .get("input")
        .and_then(|input| read_stopless_nested_string(input, &["triggerHint", "trigger_hint"]))
        .or_else(|| read_stopless_nested_string(parsed, &["triggerHint", "trigger_hint"]))
        .or_else(|| {
            parsed.get("schemaGuidance").and_then(|value| {
                read_stopless_nested_string(value, &["triggerHint", "trigger_hint"])
            })
        })
        .or_else(|| {
            parsed.get("schemaFeedback").and_then(|value| {
                read_stopless_nested_string(value, &["triggerHint", "trigger_hint"])
            })
        })
        .or_else(|| Some("no_schema".to_string()));
    V3StoplessHookState::new(repeat_count, max_repeats, trigger_hint)
}

fn read_stopless_nested_u32(value: &Value, keys: &[&str]) -> Option<u32> {
    keys.iter()
        .find_map(|key| read_stopless_u32_field(value, key))
}

fn read_stopless_u32_field(value: &Value, key: &str) -> Option<u32> {
    value.get(key).and_then(|field| {
        field
            .as_u64()
            .and_then(|value| u32::try_from(value).ok())
            .or_else(|| field.as_str()?.trim().parse().ok())
    })
}

fn read_stopless_nested_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|field| !field.is_empty())
            .map(str::to_string)
    })
}

fn parse_stopless_cli_output_json(
    raw: &str,
    index: usize,
) -> Result<Value, V3HubRelayRequestError> {
    serde_json::from_str(raw.trim())
        .or_else(|_| {
            let Some(stdout) = codex_exec_output_section(raw) else {
                return Err(());
            };
            serde_json::from_str(stdout.trim()).map_err(|_| ())
        })
        .map_err(|_| V3HubRelayRequestError::MalformedStoplessCliOutput {
            index,
            reason: "output must be JSON",
        })
}

fn codex_exec_output_section(raw: &str) -> Option<&str> {
    ["Output:\n", "Output:\r\n", "Output:\r"]
        .iter()
        .find_map(|marker| raw.rfind(marker).map(|index| &raw[index + marker.len()..]))
}

fn inject_stopless_schema(payload: &mut Value) -> Result<(), V3HubRelayRequestError> {
    match payload.get_mut("instructions") {
        Some(Value::String(existing)) if !has_current_stopless_instruction(existing) => {
            existing.push('\n');
            existing.push_str(STOPLESS_SCHEMA_INSTRUCTION);
        }
        Some(Value::String(_)) => {}
        _ => {
            if let Some(object) = payload.as_object_mut() {
                object.insert(
                    "instructions".to_string(),
                    Value::String(STOPLESS_SCHEMA_INSTRUCTION.to_string()),
                );
            } else {
                return Err(V3HubRelayRequestError::MalformedStoplessToolSurface {
                    field: "payload",
                    reason: "request payload must be an object before stopless injection",
                });
            }
        }
    }
    inject_reasoning_stop_tool(payload)?;
    Ok(())
}

fn has_current_stopless_instruction(existing: &str) -> bool {
    existing.contains("stopreason")
        && existing.contains("reasoningStop")
        && existing.contains("<rcc_stop_schema>")
}

fn inject_reasoning_stop_tool(payload: &mut Value) -> Result<(), V3HubRelayRequestError> {
    let Some(object) = payload.as_object_mut() else {
        return Err(V3HubRelayRequestError::MalformedStoplessToolSurface {
            field: "payload",
            reason: "request payload must be an object before stopless tool injection",
        });
    };
    if object.contains_key("tools") {
        let Some(tools) = object.get_mut("tools") else {
            unreachable!("contains_key checked")
        };
        inject_reasoning_stop_tool_into_array(tools, "tools")?;
        return Ok(());
    }
    if inject_reasoning_stop_tool_into_additional_tools(object.get_mut("input"))? {
        return Ok(());
    }
    object.insert(
        "tools".to_string(),
        Value::Array(vec![build_reasoning_stop_tool()]),
    );
    Ok(())
}

fn inject_reasoning_stop_tool_into_array(
    tools: &mut Value,
    field: &'static str,
) -> Result<(), V3HubRelayRequestError> {
    let Some(items) = tools.as_array_mut() else {
        return Err(V3HubRelayRequestError::MalformedStoplessToolSurface {
            field,
            reason: "tools must be an array; refusing to rebuild original tool JSON path",
        });
    };
    items.retain(|tool| !tool_name_is_stopless_internal(tool));
    items.push(build_reasoning_stop_tool());
    Ok(())
}

fn inject_reasoning_stop_tool_into_additional_tools(
    input: Option<&mut Value>,
) -> Result<bool, V3HubRelayRequestError> {
    let Some(items) = input.and_then(Value::as_array_mut) else {
        return Ok(false);
    };
    for item in items {
        if item.get("type").and_then(Value::as_str) != Some("additional_tools") {
            continue;
        }
        let Some(embedded_tools) = item.get_mut("tools") else {
            return Err(V3HubRelayRequestError::MalformedStoplessToolSurface {
                field: "input[].tools",
                reason: "additional_tools.tools must be an array; refusing to rebuild original tool JSON path",
            });
        };
        inject_reasoning_stop_tool_into_array(embedded_tools, "input[].tools")?;
        return Ok(true);
    }
    Ok(false)
}

fn build_reasoning_stop_tool() -> Value {
    json!({
        "type": "function",
        "name": "reasoningStop",
        "description": concat!(
            "Use this tool when you stop, pause, or need another turn. ",
            "Provide stop schema as JSON arguments. Fields are conditionally required: stopreason is the only unconditional required field; stopreason=0 requires has_evidence=1 and non-empty evidence; stopreason=1 requires non-empty reason, has_evidence=1, and non-empty evidence; stopreason=2 requires current_goal and next_step; needs_user_input=true requires next_step to be the exact user question. ",
            "If you do not call this tool, the assistant text must end with <rcc_stop_schema>...</rcc_stop_schema>. ",
            "stopreason values: 0=finished, 1=blocked, 2=continue_needed. ",
            "If work remains, use stopreason=2 and write current_goal plus next_step. ",
            "Field meanings: stopreason, reason, current_goal, has_evidence, evidence, issue_cause, excluded_factors, diagnostic_order, done_steps, next_step, next_suggested_path, needs_user_input, learned. ",
            "Minimal continue sample: ",
            "{\"stopreason\":2,\"reason\":\"当前状态\",\"current_goal\":\"当前目标\",\"has_evidence\":0,\"evidence\":\"\",\"next_step\":\"下一步动作\",\"needs_user_input\":false}. ",
            "Minimal finished sample: ",
            "{\"stopreason\":0,\"reason\":\"stopreason=0 条件成立\",\"has_evidence\":1,\"evidence\":\"列出日志/测试/文件证据\",\"needs_user_input\":false}. ",
            "Minimal blocked sample: ",
            "{\"stopreason\":1,\"reason\":\"缺少生产只读权限\",\"current_goal\":\"完成在线验证\",\"has_evidence\":1,\"evidence\":\"provider 返回 403 权限错误日志\",\"issue_cause\":\"权限不足\",\"excluded_factors\":\"本地测试已通过\",\"diagnostic_order\":\"本地 gate -> 在线请求\",\"done_steps\":\"已完成源码修复\",\"next_step\":\"请授权生产只读访问\",\"needs_user_input\":true}. ",
            "Schema correction sample: if the previous turn missed schema, call reasoningStop with {\"stopreason\":2,\"reason\":\"补齐 stop schema\",\"current_goal\":\"继续当前目标\",\"has_evidence\":0,\"evidence\":\"\",\"next_step\":\"继续执行并在下一轮提交完整 schema\",\"needs_user_input\":false}; if a field is invalid, keep the same task and correct only the invalid field."
        ),
        "parameters": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "stopreason": {
                    "type": "integer",
                    "enum": [0, 1, 2],
                    "description": "0=finished, 1=blocked, 2=continue_needed"
                },
                "reason": {
                    "type": "string",
                    "description": "Required for blocked stopreason=1; optional summary for other stopreason values."
                },
                "has_evidence": {
                    "type": "integer",
                    "enum": [0, 1],
                    "description": "Required as 1 when stopreason=0 finished or stopreason=1 blocked."
                },
                "current_goal": {
                    "type": "string",
                    "description": "Required when stopreason=2 continue_needed; write the current objective before choosing next_step."
                },
                "evidence": {
                    "type": "string",
                    "description": "Required when stopreason=0 finished, stopreason=1 blocked, or has_evidence=1."
                },
                "issue_cause": {
                    "type": "string",
                    "description": "Root cause or current blocker cause."
                },
                "excluded_factors": {
                    "type": "string",
                    "description": "Things already ruled out."
                },
                "diagnostic_order": {
                    "type": "string",
                    "description": "Investigation order already taken."
                },
                "done_steps": {
                    "type": "string",
                    "description": "Concrete steps already completed."
                },
                "next_step": {
                    "type": "string",
                    "description": "Required when stopreason=2 continue_needed, or when needs_user_input=true as the exact user question."
                },
                "next_suggested_path": {
                    "type": "string",
                    "description": "Suggested next path if another turn is needed."
                },
                "needs_user_input": {
                    "type": "boolean",
                    "description": "true only when user input is required before progress can continue."
                },
                "learned": {
                    "type": "string",
                    "description": "Key lesson or durable conclusion from this turn."
                }
            },
            "required": ["stopreason"]
        }
    })
}

#[cfg(test)]
mod tests {
    use super::parse_stopless_cli_output_json;

    #[test]
    fn parse_stopless_cli_output_json_extracts_real_5555_transcript_output() {
        let raw = r#"Chunk ID: cdb280
Wall time: 0.1387 seconds
Process exited with code 0
Original token count: 82
Output:
{"ok":true,"kind":"stop_message_auto","tool":"stop_message_auto","summary":"继续","toolName":"stop_message_auto","flowId":"stop_message_flow","routeHint":"thinking","continuationPrompt":"继续。","repeatCount":2,"maxRepeats":3,"input":{"flowId":"stop_message_flow","maxRepeats":3,"repeatCount":2,"triggerHint":"no_schema"}}
"#;
        let parsed = parse_stopless_cli_output_json(raw, 278).expect("real transcript must parse");
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["kind"], "stop_message_auto");
        assert_eq!(parsed["continuationPrompt"], "继续。");
        assert_eq!(parsed["repeatCount"], 2);
        assert_eq!(parsed["maxRepeats"], 3);
        assert_eq!(parsed["input"]["triggerHint"], "no_schema");
    }
}

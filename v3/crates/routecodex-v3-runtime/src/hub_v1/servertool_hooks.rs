use super::{
    is_v3_client_tool_error_output_at_req04, is_v3_client_tool_error_pair_at_req04,
    V3HubRelayRequestError, V3HubRelayRequestHookEvent, V3HubRelayResponseError,
    V3HubRelayResponseHookProfile, V3HubRespInbound02Normalized, V3StoplessHookState,
};
use serde_json::{json, Value};
use servertool_core::stop_visible_text::{
    build_stop_message_terminal_visible_payload, strip_stop_schema_control_text,
    StopMessageTerminalVisiblePayloadInput,
};
use std::sync::Arc;
use stop_message_core::{
    build_stop_schema_budget_exhausted_summary_prefix, evaluate_stop_schema_gate,
    evaluate_stop_schema_gate_with_reasoning_stop_arguments, StopSchemaGateAction,
    StopSchemaGateDecision,
};

const STOPLESS_CALL_ID: &str = "call_stopless_reasoning";
const STOPLESS_SCHEMA_INSTRUCTION: &str = "Stopless managed turn: final answers must include a stop schema JSON object with numeric stopreason 0, 1, or 2. Use stopreason=2 with next_step when more work is needed.";
const STOPLESS_DEFAULT_PROMPT: &str = "Continue from the previous stopless hook result.";
const STOPLESS_NO_VISIBLE_TEXT_BUDGET_EXHAUSTED: &str =
    "自动续轮已停止：模型连续返回空完成信号，没有提供可继续执行的结果。为避免循环风暴，本轮已停止。";

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
        if schema_decision == V3StoplessSchemaDecision::Missing && output_text.is_none() {
            let projected =
                build_stopless_no_visible_budget_exhausted_payload(input.provider_payload());
            *input.provider_payload_mut() = Arc::new(projected);
        } else if let Some(text) = output_text.as_deref() {
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
    let command = build_stopless_cli_command(Some(&cli_input));
    let projected = json!({
        "id": object.get("id").cloned().unwrap_or_else(|| json!("resp_stopless_projected")),
        "status": "requires_action",
        "output": [{
            "type": "function_call",
            "call_id": STOPLESS_CALL_ID,
            "name": "exec_command",
            "arguments": json!({"cmd": command}).to_string()
        }]
    });
    *input.provider_payload_mut() = Arc::new(projected);
    Ok(input)
}

pub fn apply_v3_stopless_request_hook_at_req04(
    payload: &mut Value,
    events: &mut Vec<V3HubRelayRequestHookEvent>,
) -> Result<Option<V3StoplessHookState>, V3HubRelayRequestError> {
    let Some(input) = payload.get_mut("input").and_then(Value::as_array_mut) else {
        inject_stopless_schema(payload);
        events.push(V3HubRelayRequestHookEvent::Req04StoplessToolInjected);
        return Ok(None);
    };
    let Some((index, output)) = active_stopless_cli_output(input) else {
        strip_stopless_cli_artifacts(input);
        inject_stopless_schema(payload);
        events.push(V3HubRelayRequestHookEvent::Req04StoplessToolInjected);
        return Ok(None);
    };
    let parsed = parse_stopless_cli_output(output, index)?;
    let replacement = json!({
        "role": "user",
        "content": parsed.next_step
    });
    rewrite_active_stopless_pair_and_strip_stale(input, index, replacement);
    events.push(V3HubRelayRequestHookEvent::Req04StoplessResultParsed);
    events.push(V3HubRelayRequestHookEvent::Req04StoplessTextRewritten);
    inject_stopless_schema(payload);
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

fn stopless_cli_input_from_schema(
    text: &str,
    profile: &V3HubRelayResponseHookProfile,
    trigger_hint: &'static str,
) -> Option<Value> {
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
    }
    Some(value)
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
        "triggerHint": state.trigger_hint.unwrap_or_else(|| "no_schema".to_string())
    }))
}

fn build_stopless_terminal_visible_payload(payload: &Value, text: &str) -> Value {
    let gate = evaluate_v3_stopless_schema_gate(text);
    build_stop_message_terminal_visible_payload(StopMessageTerminalVisiblePayloadInput {
        payload: payload.clone(),
        mode: Some("strip".to_string()),
        prefix: gate.summary_prefix,
    })
    .payload
}

fn build_stopless_budget_exhausted_visible_payload(payload: &Value, text: &str) -> Value {
    let gate = evaluate_v3_stopless_schema_gate(text);
    let prefix = gate
        .parsed
        .as_ref()
        .and_then(build_stop_schema_budget_exhausted_summary_prefix);
    build_stop_message_terminal_visible_payload(StopMessageTerminalVisiblePayloadInput {
        payload: payload.clone(),
        mode: Some("replace".to_string()),
        prefix,
    })
    .payload
}

fn build_stopless_no_visible_budget_exhausted_payload(payload: &Value) -> Value {
    build_stop_message_terminal_visible_payload(StopMessageTerminalVisiblePayloadInput {
        payload: payload.clone(),
        mode: Some("replace".to_string()),
        prefix: Some(STOPLESS_NO_VISIBLE_TEXT_BUDGET_EXHAUSTED.to_string()),
    })
    .payload
}

fn evaluate_v3_stopless_schema_gate(text: &str) -> StopSchemaGateDecision {
    let gate = evaluate_stop_schema_gate(text, 0, 3, "", 0);
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
    V3NextStoplessProjectionState {
        repeat_count: current
            .map(V3StoplessHookState::repeat_count)
            .unwrap_or(0)
            .saturating_add(1),
        max_repeats: current
            .map(V3StoplessHookState::max_repeats)
            .unwrap_or(3)
            .max(1),
        trigger_hint: trigger_hint
            .map(str::to_string)
            .or_else(|| current.and_then(|state| state.trigger_hint().map(str::to_string))),
    }
}

fn read_stopless_json_object(text: &str) -> Option<Value> {
    let trimmed = text.trim();
    if let Ok(Value::Object(object)) = serde_json::from_str::<Value>(trimmed) {
        return Some(Value::Object(object));
    }
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    if end <= start {
        return None;
    }
    match serde_json::from_str::<Value>(&text[start..=end]).ok()? {
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
    for (index, item) in std::mem::take(input).into_iter().enumerate() {
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
        if is_stopless_cli_artifact(&item) {
            continue;
        }
        next.push(item);
    }
    *input = next;
}

fn strip_stopless_cli_artifacts(input: &mut Vec<Value>) {
    input.retain(|item| !is_stopless_cli_artifact(item));
}

fn is_stopless_cli_artifact(item: &Value) -> bool {
    is_stopless_cli_call(item) || is_stopless_cli_output(item)
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
    next_step: String,
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
    let next_step = parsed
        .get("next_step")
        .or_else(|| parsed.get("continuationPrompt"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(STOPLESS_DEFAULT_PROMPT)
        .to_owned();
    Ok(V3ParsedStoplessCliOutput {
        next_step,
        state: parse_stopless_state_from_cli_output(&parsed),
    })
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

fn inject_stopless_schema(payload: &mut Value) {
    match payload.get_mut("instructions") {
        Some(Value::String(existing)) if !existing.contains("stopreason") => {
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
            }
        }
    }
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

use napi::bindgen_prelude::Result as NapiResult;
use serde_json::{Map, Value};

fn read_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn has_non_empty_array(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty())
}

fn read_servertool_followup_source(request_semantics: Option<&Value>) -> String {
    let Some(row) = request_semantics.and_then(Value::as_object) else {
        return String::new();
    };
    row.get("runtime_control")
        .and_then(Value::as_object)
        .and_then(|runtime| read_string(runtime.get("serverToolFollowupSource")))
        .unwrap_or_default()
}

fn is_reasoning_stop_followup_turn(request_semantics: Option<&Value>) -> bool {
    read_servertool_followup_source(request_semantics) == "servertool.reasoning_stop_continue"
}

fn read_continuation_tool_mode(request_semantics: Option<&Value>) -> String {
    request_semantics
        .and_then(Value::as_object)
        .and_then(|row| row.get("continuation"))
        .and_then(Value::as_object)
        .and_then(|row| row.get("toolContinuation"))
        .and_then(Value::as_object)
        .and_then(|row| read_string(row.get("mode")))
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default()
}

fn has_responses_resume_tool_outputs(request_semantics: Option<&Value>) -> bool {
    let resume = request_semantics
        .and_then(Value::as_object)
        .and_then(|row| row.get("responses"))
        .and_then(Value::as_object)
        .and_then(|row| row.get("resume"))
        .and_then(Value::as_object);
    has_non_empty_array(resume.and_then(|row| row.get("toolOutputsDetailed")))
        || has_non_empty_array(resume.and_then(|row| row.get("tool_outputs")))
}

fn has_requested_tools_in_semantics_value(request_semantics: Option<&Value>) -> bool {
    let Some(row) = request_semantics.and_then(Value::as_object) else {
        return false;
    };
    let tools_node = row.get("tools").and_then(Value::as_object);
    has_non_empty_array(row.get("tools"))
        || has_non_empty_array(tools_node.and_then(|tools| tools.get("clientToolsRaw")))
        || has_non_empty_array(tools_node.and_then(|tools| tools.get("baselineTools")))
}

fn read_tool_choice_candidate<'a>(row: Option<&'a Map<String, Value>>) -> Option<&'a Value> {
    let row = row?;
    row.get("tool_choice").or_else(|| row.get("toolChoice"))
}

fn is_required_tool_choice_value(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(raw)) => raw.trim().eq_ignore_ascii_case("required"),
        Some(Value::Object(row)) => {
            if read_string(row.get("type"))
                .map(|value| value.eq_ignore_ascii_case("function"))
                .unwrap_or(false)
            {
                return true;
            }
            row.get("function")
                .and_then(Value::as_object)
                .and_then(|function| read_string(function.get("name")))
                .is_some()
        }
        _ => false,
    }
}

fn is_required_tool_call_turn_value(request_semantics: Option<&Value>) -> bool {
    if !has_requested_tools_in_semantics_value(request_semantics) {
        return false;
    }
    let row = request_semantics.and_then(Value::as_object);
    if is_required_tool_choice_value(read_tool_choice_candidate(row)) {
        return true;
    }
    let responses = row
        .and_then(|row| row.get("responses"))
        .and_then(Value::as_object);
    if is_required_tool_choice_value(read_tool_choice_candidate(responses)) {
        return true;
    }
    let request_parameters = responses
        .and_then(|row| row.get("requestParameters"))
        .and_then(Value::as_object);
    if is_required_tool_choice_value(read_tool_choice_candidate(request_parameters)) {
        return true;
    }
    let metadata = row
        .and_then(|row| row.get("metadata"))
        .and_then(Value::as_object);
    if is_required_tool_choice_value(read_tool_choice_candidate(metadata)) {
        return true;
    }
    read_servertool_followup_source(request_semantics) == "servertool.reasoning_stop_continue"
}

fn is_tool_result_followup_turn_value(request_semantics: Option<&Value>) -> bool {
    if is_reasoning_stop_followup_turn(request_semantics) {
        return false;
    }
    if read_continuation_tool_mode(request_semantics) == "submit_tool_outputs" {
        return true;
    }
    let row = request_semantics.and_then(Value::as_object);
    if has_non_empty_array(row.and_then(|row| row.get("toolOutputs")))
        || has_non_empty_array(row.and_then(|row| row.get("tool_outputs")))
        || has_non_empty_array(row.and_then(|row| row.get("__captured_tool_results")))
        || has_responses_resume_tool_outputs(request_semantics)
    {
        return true;
    }
    let input = row
        .and_then(|row| row.get("input"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for item in input.iter().rev() {
        let item_type = item
            .as_object()
            .and_then(|row| read_string(row.get("type")))
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        if matches!(
            item_type.as_str(),
            "function_call_output" | "tool_result" | "tool_message"
        ) {
            return true;
        }
        if !item_type.is_empty() {
            break;
        }
    }
    let messages = row
        .and_then(|row| row.get("messages"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for message in messages.iter().rev() {
        let Some(message_row) = message.as_object() else {
            continue;
        };
        let role = read_string(message_row.get("role"))
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        if role == "tool" || role == "function" {
            return true;
        }
        if read_string(message_row.get("tool_call_id")).is_some() {
            return true;
        }
        let item_type = read_string(message_row.get("type"))
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        if matches!(
            item_type.as_str(),
            "function_call_output" | "tool_result" | "tool_message"
        ) {
            return true;
        }
        if role == "assistant" || role == "user" || !item_type.is_empty() {
            return false;
        }
    }
    false
}

fn stream_contract_probe_body(body: &Value) -> Option<&Value> {
    body.as_object()?;
    Some(body)
}

fn value_has_visible_assistant_text(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(text)) => !text.trim().is_empty(),
        Some(Value::Array(items)) => items
            .iter()
            .any(|entry| value_has_visible_assistant_text(Some(entry))),
        Some(Value::Object(row)) => {
            let item_type = read_string(row.get("type"))
                .map(|value| value.to_ascii_lowercase())
                .unwrap_or_default();
            if matches!(
                item_type.as_str(),
                "refusal" | "tool_result" | "function_call_output" | "reasoning"
            ) {
                return false;
            }
            value_has_visible_assistant_text(row.get("text"))
                || value_has_visible_assistant_text(row.get("output_text"))
                || value_has_visible_assistant_text(row.get("content"))
        }
        _ => false,
    }
}

fn value_has_non_empty_text(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(text)) => !text.trim().is_empty(),
        Some(Value::Array(items)) => items
            .iter()
            .any(|entry| value_has_non_empty_text(Some(entry))),
        Some(Value::Object(row)) => {
            value_has_non_empty_text(row.get("text"))
                || value_has_non_empty_text(row.get("output_text"))
                || value_has_non_empty_text(row.get("content"))
        }
        _ => false,
    }
}

fn is_meaningless_dot_only_text(text: &str) -> bool {
    matches!(text.trim(), "." | ".." | "...")
}

fn value_has_meaningful_visible_assistant_text(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(text)) => !text.trim().is_empty() && !is_meaningless_dot_only_text(text),
        Some(Value::Array(items)) => items
            .iter()
            .any(|entry| value_has_meaningful_visible_assistant_text(Some(entry))),
        Some(Value::Object(row)) => {
            let item_type = read_string(row.get("type"))
                .map(|value| value.to_ascii_lowercase())
                .unwrap_or_default();
            if matches!(item_type.as_str(), "reasoning" | "thinking") {
                return false;
            }
            value_has_meaningful_visible_assistant_text(row.get("text"))
                || value_has_meaningful_visible_assistant_text(row.get("output_text"))
                || value_has_meaningful_visible_assistant_text(row.get("content"))
        }
        _ => false,
    }
}

fn value_has_reasoning_only_content(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(_)) => false,
        Some(Value::Array(items)) => items
            .iter()
            .any(|entry| value_has_reasoning_only_content(Some(entry))),
        Some(Value::Object(row)) => {
            if read_string(row.get("type"))
                .map(|value| value.eq_ignore_ascii_case("reasoning"))
                .unwrap_or(false)
            {
                return true;
            }
            value_has_reasoning_only_content(row.get("reasoning"))
                || value_has_reasoning_only_content(row.get("content"))
                || value_has_reasoning_only_content(row.get("output"))
        }
        _ => false,
    }
}

fn has_non_empty_tool_calls(value: Option<&Value>) -> bool {
    has_non_empty_array(value)
}

fn has_output_function_calls(value: Option<&Value>) -> bool {
    let Some(items) = value.and_then(Value::as_array) else {
        return false;
    };
    items.iter().any(|entry| {
        let item_type = entry
            .as_object()
            .and_then(|row| read_string(row.get("type")))
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        matches!(
            item_type.as_str(),
            "function_call" | "tool_call" | "custom_tool_call"
        )
    })
}

fn contains_tool_registry_missing_text(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(text)) => {
            let normalized = text.to_ascii_lowercase();
            normalized.contains("tool not found")
                || normalized.contains("tool registry missing")
                || normalized.contains("unknown tool")
                || normalized.contains("missing tool")
        }
        Some(Value::Array(items)) => items
            .iter()
            .any(|entry| contains_tool_registry_missing_text(Some(entry))),
        Some(Value::Object(row)) => row
            .values()
            .any(|entry| contains_tool_registry_missing_text(Some(entry))),
        _ => false,
    }
}

fn contains_reasoning_stop_finalized_marker(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(text)) => text.contains("[app.finished:reasoning.stop]"),
        Some(Value::Array(items)) => items
            .iter()
            .any(|entry| contains_reasoning_stop_finalized_marker(Some(entry))),
        Some(Value::Object(row)) => row
            .values()
            .any(|entry| contains_reasoning_stop_finalized_marker(Some(entry))),
        _ => false,
    }
}

fn payload_contract_signal(reason: String, marker: &str) -> Value {
    let mut row = Map::new();
    row.insert("reason".to_string(), Value::String(reason));
    row.insert("marker".to_string(), Value::String(marker.to_string()));
    Value::Object(row)
}

fn resolve_finish_reason_record(body: &Value) -> Option<&Map<String, Value>> {
    let root = body.as_object()?;
    for key in ["data", "response", "payload"] {
        let Some(nested) = root.get(key).and_then(Value::as_object) else {
            continue;
        };
        if nested.get("choices").and_then(Value::as_array).is_some()
            || nested.get("output").and_then(Value::as_array).is_some()
            || nested.get("stop_reason").and_then(Value::as_str).is_some()
            || nested.get("status").and_then(Value::as_str).is_some()
        {
            return Some(nested);
        }
    }
    Some(root)
}

fn map_stop_reason_to_finish_reason(stop_reason: &str) -> String {
    match stop_reason.trim().to_ascii_lowercase().as_str() {
        "end_turn" => "stop".to_string(),
        "tool_use" => "tool_calls".to_string(),
        "max_tokens" => "length".to_string(),
        normalized => normalized.to_string(),
    }
}

fn map_incomplete_reason_to_finish_reason(reason: &str) -> String {
    match reason.trim().to_ascii_lowercase().as_str() {
        "max_output_tokens" | "max_tokens" => "length".to_string(),
        "content_filter" => "content_filter".to_string(),
        normalized => normalized.to_string(),
    }
}

fn first_choice_record(record: &Map<String, Value>) -> Option<&Map<String, Value>> {
    record
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(Value::as_object)
}

fn has_chat_choice_tool_calls(choice: Option<&Map<String, Value>>) -> bool {
    choice
        .and_then(|row| row.get("message"))
        .and_then(Value::as_object)
        .and_then(|message| message.get("tool_calls"))
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty())
}

fn has_chat_choice_assistant_content(choice: Option<&Map<String, Value>>) -> bool {
    let Some(message) = choice
        .and_then(|row| row.get("message"))
        .and_then(Value::as_object)
    else {
        return false;
    };
    match message.get("content") {
        Some(Value::String(text)) => !text.trim().is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        _ => false,
    }
}

fn has_responses_tool_call(record: &Map<String, Value>) -> bool {
    if record
        .get("required_action")
        .and_then(Value::as_object)
        .and_then(|row| row.get("submit_tool_outputs"))
        .and_then(Value::as_object)
        .and_then(|row| row.get("tool_calls"))
        .and_then(Value::as_array)
        .is_some_and(|items| !items.is_empty())
    {
        return true;
    }
    record
        .get("output")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                let item_type = item
                    .as_object()
                    .and_then(|row| read_string(row.get("type")))
                    .map(|value| value.to_ascii_lowercase())
                    .unwrap_or_default();
                matches!(
                    item_type.as_str(),
                    "function_call" | "tool_call" | "custom_tool_call"
                )
            })
        })
}

fn is_tool_call_continuation_response_value(body: &Value) -> bool {
    derive_finish_reason_value(body)
        .as_deref()
        .is_some_and(|reason| reason == "tool_calls")
}

fn is_provider_native_resume_continuation_value(request_semantics: &Value) -> bool {
    let Some(continuation) = request_semantics
        .as_object()
        .and_then(|row| row.get("continuation"))
        .and_then(Value::as_object)
    else {
        return false;
    };
    let continuation_owner = read_string(continuation.get("continuationOwner"))
        .or_else(|| read_string(continuation.get("continuation_owner")))
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    if continuation_owner == "relay" {
        return false;
    }
    let resume_from = continuation
        .get("resumeFrom")
        .or_else(|| continuation.get("resume_from"))
        .and_then(Value::as_object);
    if resume_from
        .and_then(|row| {
            read_string(row.get("previousResponseId"))
                .or_else(|| read_string(row.get("previous_response_id")))
        })
        .is_some()
        || read_string(continuation.get("previousResponseId")).is_some()
        || read_string(continuation.get("previous_response_id")).is_some()
    {
        return true;
    }
    let mode = read_string(continuation.get("mode"))
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    mode == "submit_tool_outputs"
        && (read_string(continuation.get("responseId")).is_some()
            || read_string(continuation.get("response_id")).is_some())
}

fn has_servertool_followup_tool_bearing_payload(record: &Map<String, Value>) -> bool {
    if record.get("required_action").is_some_and(Value::is_object) {
        return true;
    }
    if record
        .get("output")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                let item_type = item
                    .as_object()
                    .and_then(|row| read_string(row.get("type")))
                    .map(|value| value.to_ascii_lowercase())
                    .unwrap_or_default();
                matches!(
                    item_type.as_str(),
                    "function_call" | "tool_call" | "tool_use"
                ) || item_type.contains("tool")
            })
        })
    {
        return true;
    }
    record
        .get("choices")
        .and_then(Value::as_array)
        .is_some_and(|choices| {
            choices.iter().any(|choice| {
                choice
                    .as_object()
                    .and_then(|row| row.get("message"))
                    .and_then(Value::as_object)
                    .is_some_and(|message| has_non_empty_array(message.get("tool_calls")))
            })
        })
}

fn is_empty_client_response_payload_value(payload: &Value) -> bool {
    let Some(record) = payload.as_object() else {
        return true;
    };
    if record.contains_key("error") || has_servertool_followup_tool_bearing_payload(record) {
        return false;
    }

    if let Some(choices) = record.get("choices").and_then(Value::as_array) {
        if choices.is_empty() {
            return true;
        }
        let Some(message) = choices
            .first()
            .and_then(Value::as_object)
            .and_then(|choice| choice.get("message"))
            .and_then(Value::as_object)
        else {
            return true;
        };
        return !(value_has_non_empty_text(message.get("content"))
            || value_has_non_empty_text(message.get("reasoning_content"))
            || value_has_non_empty_text(message.get("reasoning")));
    }

    if let Some(output) = record.get("output").and_then(Value::as_array) {
        if output.is_empty() {
            return true;
        }
        return !output.iter().any(|item| {
            let Some(row) = item.as_object() else {
                return false;
            };
            value_has_non_empty_text(row.get("content"))
                || value_has_non_empty_text(row.get("text"))
                || value_has_non_empty_text(row.get("output_text"))
        });
    }

    true
}

fn classify_empty_response_signal_value(stage: &str, payload: &Value) -> Option<Value> {
    if !stage.starts_with("chat_process.resp.") {
        return None;
    }
    let record = payload.as_object()?;
    if record.contains_key("error") || has_servertool_followup_tool_bearing_payload(record) {
        return None;
    }

    if let Some(choices) = record.get("choices").and_then(Value::as_array) {
        if choices.is_empty() {
            return None;
        }
        let first = choices.first()?.as_object()?;
        let finish_reason = read_string(first.get("finish_reason"))
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        let has_text = first
            .get("message")
            .and_then(Value::as_object)
            .is_some_and(|message| value_has_non_empty_text(message.get("content")))
            || value_has_non_empty_text(first.get("content"));
        if finish_reason == "stop" && !has_text {
            return Some(json_object(vec![
                (
                    "errorType",
                    Value::String("empty_response_no_text_or_tool_calls".to_string()),
                ),
                (
                    "matchedText",
                    Value::String(
                        "finish_reason=stop but assistant text/tool_calls are empty".to_string(),
                    ),
                ),
                (
                    "responseSummary",
                    json_object(vec![
                        ("protocol", Value::String("chat".to_string())),
                        ("finishReason", Value::String(finish_reason)),
                        ("hasToolCalls", Value::Bool(false)),
                        ("textCount", Value::from(0)),
                    ]),
                ),
            ]));
        }
        return None;
    }

    let status = read_string(record.get("status"))
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    if status != "completed" && status != "stop" {
        return None;
    }
    let output_text = read_string(record.get("output_text")).unwrap_or_default();
    let output = record.get("output").and_then(Value::as_array);
    let output_items = output.map_or(0, Vec::len);
    let has_output_text = output.is_some_and(|items| {
        items.iter().any(|item| {
            let Some(row) = item.as_object() else {
                return false;
            };
            value_has_non_empty_text(row.get("content"))
                || value_has_non_empty_text(row.get("text"))
                || value_has_non_empty_text(row.get("output_text"))
        })
    });
    if output_text.is_empty() && !has_output_text {
        return Some(json_object(vec![
            (
                "errorType",
                Value::String("empty_response_no_text_or_tool_calls".to_string()),
            ),
            (
                "matchedText",
                Value::String(
                    "responses status completed but output_text/output content are empty"
                        .to_string(),
                ),
            ),
            (
                "responseSummary",
                json_object(vec![
                    ("protocol", Value::String("responses".to_string())),
                    ("status", Value::String(status)),
                    ("hasRequiredAction", Value::Bool(false)),
                    ("hasOutputFunctionCalls", Value::Bool(false)),
                    ("outputItems", Value::from(output_items)),
                    ("textCount", Value::from(0)),
                ]),
            ),
        ]));
    }
    None
}

fn json_object(entries: Vec<(&str, Value)>) -> Value {
    let mut row = Map::new();
    for (key, value) in entries {
        row.insert(key.to_string(), value);
    }
    Value::Object(row)
}

fn derive_finish_reason_value(body: &Value) -> Option<String> {
    let record = resolve_finish_reason_record(body)?;
    let first_choice = first_choice_record(record);
    if let Some(choice_finish_reason) =
        first_choice.and_then(|row| read_string(row.get("finish_reason")))
    {
        return Some(choice_finish_reason);
    }
    if let Some(stop_reason) = read_string(record.get("stop_reason")) {
        return Some(map_stop_reason_to_finish_reason(stop_reason.as_str()));
    }
    if has_chat_choice_tool_calls(first_choice) {
        return Some("tool_calls".to_string());
    }
    if has_responses_tool_call(record) {
        return Some("tool_calls".to_string());
    }
    if let Some(incomplete_reason) = record
        .get("incomplete_details")
        .and_then(Value::as_object)
        .and_then(|row| read_string(row.get("reason")))
    {
        return Some(map_incomplete_reason_to_finish_reason(
            incomplete_reason.as_str(),
        ));
    }
    let response_status = read_string(record.get("status"))
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    if response_status == "completed" {
        return Some("stop".to_string());
    }
    if response_status == "requires_action" {
        return Some("tool_calls".to_string());
    }
    if has_chat_choice_assistant_content(first_choice) {
        return Some("stop".to_string());
    }
    None
}

fn detect_retryable_empty_assistant_response_value(
    body: &Value,
    request_semantics: Option<&Value>,
) -> Option<Value> {
    let effective = stream_contract_probe_body(body)?;
    let effective_row = effective.as_object()?;
    let choices = effective_row
        .get("choices")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if let Some(first_choice) = choices.first().and_then(Value::as_object) {
        let finish_reason = read_string(first_choice.get("finish_reason"))
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default();
        let message = first_choice.get("message").and_then(Value::as_object);
        let has_tool_calls =
            has_non_empty_tool_calls(message.and_then(|row| row.get("tool_calls")));
        let has_text =
            value_has_meaningful_visible_assistant_text(message.and_then(|row| row.get("content")))
                || value_has_meaningful_visible_assistant_text(first_choice.get("content"));
        let combined_text_has_registry_missing =
            contains_tool_registry_missing_text(message.and_then(|row| row.get("content")))
                || contains_tool_registry_missing_text(first_choice.get("content"));
        if (finish_reason == "stop" || finish_reason.is_empty())
            && !has_tool_calls
            && is_required_tool_call_turn_value(request_semantics)
            && !is_tool_result_followup_turn_value(request_semantics)
        {
            return Some(payload_contract_signal(
                format!(
                    "finish_reason={} with declared request tools but no structured tool_calls",
                    if finish_reason.is_empty() {
                        "unknown"
                    } else {
                        finish_reason.as_str()
                    }
                ),
                "chat_missing_required_tool_call",
            ));
        }
        if matches!(finish_reason.as_str(), "stop" | "tool_calls" | "")
            && !has_tool_calls
            && !has_text
        {
            return Some(payload_contract_signal(
                format!(
                    "finish_reason={} but assistant text/tool_calls are empty",
                    if finish_reason.is_empty() {
                        "unknown"
                    } else {
                        finish_reason.as_str()
                    }
                ),
                "chat_empty_assistant",
            ));
        }
        if matches!(finish_reason.as_str(), "stop" | "tool_calls" | "")
            && !has_tool_calls
            && combined_text_has_registry_missing
        {
            return Some(payload_contract_signal(
                "assistant emitted textual tool-not-found complaint without structured tool_calls"
                    .to_string(),
                "chat_textual_tool_registry_missing",
            ));
        }
    }

    let status = read_string(effective_row.get("status"))
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    if status == "completed" || status == "stop" {
        let submit_tool_outputs = effective_row
            .get("required_action")
            .and_then(Value::as_object)
            .and_then(|row| row.get("submit_tool_outputs"))
            .and_then(Value::as_object);
        let has_required_action_tool_calls =
            has_non_empty_tool_calls(submit_tool_outputs.and_then(|row| row.get("tool_calls")));
        let has_function_calls = has_output_function_calls(effective_row.get("output"));
        let has_text =
            value_has_meaningful_visible_assistant_text(effective_row.get("output_text"))
                || value_has_meaningful_visible_assistant_text(effective_row.get("output"));
        let has_reasoning_only = value_has_reasoning_only_content(effective_row.get("output"))
            || value_has_reasoning_only_content(effective_row.get("reasoning"));
        if !has_required_action_tool_calls
            && !has_function_calls
            && is_required_tool_call_turn_value(request_semantics)
            && !is_tool_result_followup_turn_value(request_semantics)
            && !contains_reasoning_stop_finalized_marker(effective_row.get("output"))
            && !contains_reasoning_stop_finalized_marker(effective_row.get("output_text"))
        {
            return Some(payload_contract_signal(
                format!(
                    "responses status={} with declared request tools but no function_call output",
                    status
                ),
                "responses_missing_required_tool_call",
            ));
        }
        if !has_required_action_tool_calls
            && !has_function_calls
            && !has_text
            && !has_reasoning_only
            && !is_tool_result_followup_turn_value(request_semantics)
        {
            return Some(payload_contract_signal(
                format!(
                    "responses status={} but output text/tool_calls are empty{}",
                    status,
                    if has_reasoning_only {
                        " (reasoning-only payload)"
                    } else {
                        ""
                    }
                ),
                "responses_empty_output",
            ));
        }
        if !has_required_action_tool_calls
            && !has_function_calls
            && contains_tool_registry_missing_text(effective_row.get("output_text"))
        {
            return Some(payload_contract_signal(
                "responses completed with textual tool-not-found complaint but no function_call output".to_string(),
                "responses_textual_tool_registry_missing",
            ));
        }
    }
    None
}

pub fn has_requested_tools_in_semantics_json(request_semantics_json: String) -> NapiResult<bool> {
    let request_semantics: Value = serde_json::from_str(&request_semantics_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(has_requested_tools_in_semantics_value(Some(
        &request_semantics,
    )))
}

pub fn is_required_tool_call_turn_json(request_semantics_json: String) -> NapiResult<bool> {
    let request_semantics: Value = serde_json::from_str(&request_semantics_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(is_required_tool_call_turn_value(Some(&request_semantics)))
}

pub fn is_tool_result_followup_turn_json(request_semantics_json: String) -> NapiResult<bool> {
    let request_semantics: Value = serde_json::from_str(&request_semantics_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(is_tool_result_followup_turn_value(Some(&request_semantics)))
}

pub fn is_provider_native_resume_continuation_json(
    request_semantics_json: String,
) -> NapiResult<bool> {
    let request_semantics: Value = serde_json::from_str(&request_semantics_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(is_provider_native_resume_continuation_value(
        &request_semantics,
    ))
}

pub fn detect_retryable_empty_assistant_response_json(
    body_json: String,
    request_semantics_json: String,
) -> NapiResult<String> {
    let body: Value =
        serde_json::from_str(&body_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let request_semantics: Value = serde_json::from_str(&request_semantics_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = detect_retryable_empty_assistant_response_value(&body, Some(&request_semantics))
        .unwrap_or(Value::Null);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn derive_finish_reason_json(body_json: String) -> NapiResult<String> {
    let body: Value =
        serde_json::from_str(&body_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = derive_finish_reason_value(&body)
        .map(Value::String)
        .unwrap_or(Value::Null);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn is_tool_call_continuation_response_json(body_json: String) -> NapiResult<bool> {
    let body: Value =
        serde_json::from_str(&body_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(is_tool_call_continuation_response_value(&body))
}

pub fn is_empty_client_response_payload_json(body_json: String) -> NapiResult<bool> {
    let body: Value =
        serde_json::from_str(&body_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    Ok(is_empty_client_response_payload_value(&body))
}

pub fn classify_empty_response_signal_json(stage: String, body_json: String) -> NapiResult<String> {
    let body: Value =
        serde_json::from_str(&body_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = classify_empty_response_signal_value(stage.as_str(), &body).unwrap_or(Value::Null);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod request_semantics_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classifies_required_tool_call_turn_in_rust() {
        let semantics = json!({
            "tools": { "clientToolsRaw": [{ "type": "function", "function": { "name": "exec_command" } }] },
            "responses": { "requestParameters": { "tool_choice": "required" } }
        });
        assert!(has_requested_tools_in_semantics_value(Some(&semantics)));
        assert!(is_required_tool_call_turn_value(Some(&semantics)));
        assert!(!is_tool_result_followup_turn_value(Some(&semantics)));
    }

    #[test]
    fn classifies_tool_result_followup_turn_in_rust() {
        let semantics = json!({
            "messages": [
                { "role": "assistant", "content": "call tool" },
                { "role": "tool", "tool_call_id": "call_1", "content": "ok" }
            ]
        });
        assert!(is_tool_result_followup_turn_value(Some(&semantics)));
        assert!(!is_required_tool_call_turn_value(Some(&semantics)));
    }

    #[test]
    fn classifies_responses_input_function_call_output_followup_turn_in_rust() {
        let semantics = json!({
            "input": [
                { "type": "function_call", "call_id": "call_1", "name": "exec_command" },
                { "type": "function_call_output", "call_id": "call_1", "output": "ok" }
            ]
        });
        assert!(is_tool_result_followup_turn_value(Some(&semantics)));
        assert!(!is_required_tool_call_turn_value(Some(&semantics)));
    }

    #[test]
    fn classifies_provider_native_previous_response_resume_in_rust() {
        let semantics = json!({
            "continuation": {
                "continuationOwner": "direct",
                "resumeFrom": {
                    "previousResponseId": "resp_1"
                }
            }
        });
        assert!(is_provider_native_resume_continuation_value(&semantics));
    }

    #[test]
    fn classifies_provider_native_submit_tool_outputs_resume_in_rust() {
        let semantics = json!({
            "continuation": {
                "continuationOwner": "direct",
                "mode": "submit_tool_outputs",
                "responseId": "resp_1"
            }
        });
        assert!(is_provider_native_resume_continuation_value(&semantics));
    }

    #[test]
    fn does_not_classify_relay_previous_response_resume_as_provider_native() {
        let semantics = json!({
            "continuation": {
                "continuationOwner": "relay",
                "resumeFrom": {
                    "previousResponseId": "resp_relay_1"
                }
            }
        });
        assert!(!is_provider_native_resume_continuation_value(&semantics));
    }

    #[test]
    fn does_not_classify_relay_submit_tool_outputs_resume_as_provider_native() {
        let semantics = json!({
            "continuation": {
                "continuationOwner": "relay",
                "mode": "submit_tool_outputs",
                "responseId": "resp_relay_1"
            }
        });
        assert!(!is_provider_native_resume_continuation_value(&semantics));
    }

    #[test]
    fn does_not_classify_inline_tool_outputs_as_provider_native_resume() {
        let semantics = json!({
            "toolOutputs": [{ "call_id": "call_1", "output": "ok", "type": "function_call_output" }]
        });
        assert!(!is_provider_native_resume_continuation_value(&semantics));
    }

    #[test]
    fn reasoning_stop_followup_is_not_tool_result_followup() {
        let semantics = json!({
            "runtime_control": { "serverToolFollowupSource": "servertool.reasoning_stop_continue" },
            "messages": [{ "role": "tool", "tool_call_id": "call_1", "content": "ok" }]
        });
        assert!(!is_tool_result_followup_turn_value(Some(&semantics)));
    }

    #[test]
    fn legacy_rt_reasoning_stop_source_does_not_control_followup_semantics() {
        let semantics = json!({
            "__rt": { "serverToolFollowupSource": "servertool.reasoning_stop_continue" },
            "messages": [{ "role": "tool", "tool_call_id": "call_1", "content": "ok" }]
        });
        assert!(is_tool_result_followup_turn_value(Some(&semantics)));
    }

    #[test]
    fn detects_missing_required_responses_function_call_in_rust() {
        let body = json!({ "status": "completed", "output": [] });
        let semantics = json!({
            "tools": { "clientToolsRaw": [{ "type": "function", "function": { "name": "exec_command" } }] },
            "tool_choice": "required"
        });
        let signal =
            detect_retryable_empty_assistant_response_value(&body, Some(&semantics)).unwrap();
        assert_eq!(signal["marker"], "responses_missing_required_tool_call");
    }

    #[test]
    fn detects_chat_empty_assistant_in_rust() {
        let body =
            json!({ "choices": [{ "finish_reason": "tool_calls", "message": { "content": "" } }] });
        let signal =
            detect_retryable_empty_assistant_response_value(&body, Some(&Value::Null)).unwrap();
        assert_eq!(signal["marker"], "chat_empty_assistant");
    }

    #[test]
    fn derives_finish_reason_tool_calls_in_rust() {
        let chat = json!({ "choices": [{ "message": { "tool_calls": [{ "id": "call_1" }] } }] });
        assert_eq!(
            derive_finish_reason_value(&chat).as_deref(),
            Some("tool_calls")
        );

        let responses = json!({
            "status": "completed",
            "output": [{ "type": "function_call", "call_id": "call_1" }]
        });
        assert_eq!(
            derive_finish_reason_value(&responses).as_deref(),
            Some("tool_calls")
        );

        let responses_custom_tool = json!({
            "status": "completed",
            "output": [{ "type": "custom_tool_call", "call_id": "call_custom_1" }]
        });
        assert_eq!(
            derive_finish_reason_value(&responses_custom_tool).as_deref(),
            Some("tool_calls")
        );

        let anthropic = json!({ "stop_reason": "tool_use" });
        assert_eq!(
            derive_finish_reason_value(&anthropic).as_deref(),
            Some("tool_calls")
        );
    }

    #[test]
    fn detects_tool_call_continuation_response_in_rust() {
        let required_action = json!({
            "status": "requires_action",
            "required_action": {
                "submit_tool_outputs": {
                    "tool_calls": [{ "id": "call_1" }]
                }
            }
        });
        assert!(is_tool_call_continuation_response_value(&required_action));

        let empty_required_action = json!({
            "status": "completed",
            "required_action": { "submit_tool_outputs": {} },
            "output": []
        });
        assert!(!is_tool_call_continuation_response_value(
            &empty_required_action
        ));
    }

    #[test]
    fn classifies_empty_client_response_payload_in_rust() {
        assert!(is_empty_client_response_payload_value(&json!({})));
        assert!(!is_empty_client_response_payload_value(
            &json!({"error":{"message":"bad"}})
        ));
        assert!(!is_empty_client_response_payload_value(
            &json!({"choices":[{"message":{"content":"ok"}}]})
        ));
        assert!(is_empty_client_response_payload_value(
            &json!({"choices":[{"message":{"content":""}}]})
        ));
        assert!(!is_empty_client_response_payload_value(&json!({
            "choices":[{"message":{"tool_calls":[{"id":"call_1"}]}}]
        })));
        assert!(!is_empty_client_response_payload_value(&json!({
            "output":[{"type":"function_call","call_id":"call_1"}]
        })));
        assert!(!is_empty_client_response_payload_value(&json!({
            "output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]
        })));
    }

    #[test]
    fn classifies_snapshot_empty_response_signal_in_rust() {
        let chat =
            json!({ "choices": [{ "finish_reason": "stop", "message": { "content": "" } }] });
        let signal =
            classify_empty_response_signal_value("chat_process.resp.final", &chat).unwrap();
        assert_eq!(signal["responseSummary"]["protocol"], "chat");

        let tool_chat = json!({ "choices": [{ "finish_reason": "stop", "message": { "tool_calls": [{ "id": "call_1" }] } }] });
        assert!(
            classify_empty_response_signal_value("chat_process.resp.final", &tool_chat).is_none()
        );

        let responses = json!({ "status": "completed", "output": [] });
        let signal =
            classify_empty_response_signal_value("chat_process.resp.final", &responses).unwrap();
        assert_eq!(signal["responseSummary"]["protocol"], "responses");

        let text_responses = json!({ "status": "completed", "output_text": "ok" });
        assert!(
            classify_empty_response_signal_value("chat_process.resp.final", &text_responses)
                .is_none()
        );
    }
}

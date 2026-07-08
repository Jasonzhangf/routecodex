use serde_json::Value;

use crate::resp_process_stage1_tool_governance_blocks::display_sanitize::{
    contains_explicit_tool_wrapper_marker, extract_explicit_tool_wrapper_inner_payload,
    strip_orphan_tool_markup_lines, strip_tool_call_marker_payload,
    text_contains_explicit_tool_markup,
};
use crate::resp_process_stage1_tool_governance_blocks::message_content::read_message_text_candidates;
use crate::resp_process_stage1_tool_governance_blocks::text_harvest_shape::collect_stage1_harvest_input_texts;
use crate::resp_process_stage1_tool_governance_blocks::text_harvest_strict::extract_tool_calls_from_text_candidate;

pub(crate) fn resolve_text_harvest_enabled(payload: &Value) -> bool {
    let governance = payload
        .as_object()
        .and_then(|row| row.get("__rcc_tool_governance"))
        .and_then(Value::as_object);
    if governance
        .and_then(|row| row.get("skipTextHarvest"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return false;
    }
    if let Some(enabled) = governance
        .and_then(|row| row.get("enableTextHarvest"))
        .and_then(Value::as_bool)
    {
        return enabled;
    }
    payload_contains_harvestable_text_tool_payload(payload)
}

fn payload_contains_harvestable_text_tool_payload(payload: &Value) -> bool {
    let Some(choices) = payload.get("choices").and_then(Value::as_array) else {
        return false;
    };

    choices.iter().any(|choice| {
        choice
            .get("message")
            .and_then(Value::as_object)
            .map(|message| {
                read_message_text_candidates(message).iter().any(|text| {
                    collect_stage1_harvest_input_texts(text)
                        .iter()
                        .any(|candidate| {
                            text_contains_explicit_tool_markup(candidate)
                                || !extract_tool_calls_from_text_candidate(candidate, 1).is_empty()
                        })
                })
            })
            .unwrap_or(false)
    })
}

pub(crate) fn detect_unharvested_text_tool_markup(payload: &Value) -> Option<&'static str> {
    let choices = payload.get("choices").and_then(Value::as_array)?;

    for choice in choices {
        let Some(message) = choice.get("message").and_then(Value::as_object) else {
            continue;
        };
        let has_tool_calls = message
            .get("tool_calls")
            .and_then(Value::as_array)
            .map(|rows| !rows.is_empty())
            .unwrap_or(false);
        if has_tool_calls {
            continue;
        }
        for text in read_message_text_candidates(message) {
            for candidate in collect_stage1_harvest_input_texts(&text) {
                let cleaned = strip_orphan_tool_markup_lines(
                    strip_tool_call_marker_payload(candidate.as_str()).as_str(),
                );
                if contains_explicit_tool_wrapper_marker(cleaned.as_str())
                    && explicit_wrapper_inner_payload_has_tool_name_marker(cleaned.as_str())
                {
                    return Some("explicit_tool_wrapper");
                }
            }
        }
    }

    None
}

fn explicit_wrapper_inner_payload_has_tool_name_marker(raw: &str) -> bool {
    let Some(inner) = extract_explicit_tool_wrapper_inner_payload(raw) else {
        return false;
    };
    let lowered = inner.to_ascii_lowercase();
    lowered.contains("\"name\"")
        || lowered.contains("'name'")
        || lowered.contains("<name>")
        || lowered.contains("tool_name")
        || lowered.contains("\"function\"")
}

use regex::Regex;
use serde_json::Value;

use crate::resp_process_stage1_tool_governance_blocks::display_sanitize::{
    sanitize_reasoning_fields_after_tool_harvest,
    sanitize_textual_marker_field_in_message_with_policy,
};
use crate::resp_process_stage1_tool_governance_blocks::json_args::try_parse_json_value_lenient;
use crate::resp_process_stage1_tool_governance_blocks::message_content::read_message_text_candidates;
use crate::resp_process_stage1_tool_governance_blocks::requested_tools::{
    collect_requested_tool_name_keys, retain_allowed_tool_calls,
};
use crate::resp_process_stage1_tool_governance_blocks::text_harvest_extract::{
    collect_harvest_text_variants, extract_reasoning_inline_exec_command_arg_key,
    extract_rcc_tool_call_fence_segments, extract_tool_prefixed_exec_command_block,
    extract_xml_named_tool_call_blocks, extract_xml_tool_call_blocks,
};
use crate::resp_process_stage1_tool_governance_blocks::text_harvest_shape::collect_stage1_harvest_input_texts;
use crate::resp_process_stage1_tool_governance_blocks::tool_call_entry::{
    extract_json_candidates_from_text, extract_tool_call_entries_from_malformed_tool_calls_text,
    extract_tool_call_entries_from_unknown, is_obviously_truncated_tool_calls_payload,
    maybe_parse_tool_call_text_value, normalize_tool_call_entry, parse_tool_calls_shape_from_text,
};
use crate::resp_process_stage1_tool_governance_blocks::xml_text_utils::normalize_dsml_tool_markup;
use crate::shared_json_utils::read_trimmed_string;

pub(crate) fn harvest_text_tool_calls_from_payload(payload: &mut Value) -> i64 {
    harvest_explicit_wrapper_only_tool_calls_from_payload(payload)
}

pub(crate) fn extract_strict_wrapper_tool_calls_from_function_calls(
    text: &str,
    fallback_start_id: usize,
) -> Vec<Value> {
    let Ok(pattern) = Regex::new(r"(?is)<function_calls>\s*([\s\S]*?)\s*</function_calls>") else {
        return Vec::new();
    };
    let mut recovered: Vec<Value> = Vec::new();
    for caps in pattern.captures_iter(text) {
        let Some(raw) = caps.get(1).map(|m| m.as_str().trim()) else {
            continue;
        };
        if raw.is_empty() {
            continue;
        }
        let parsed = try_parse_json_value_lenient(raw);
        let Some(value) = parsed else {
            continue;
        };
        for entry in extract_tool_call_entries_from_unknown(&value) {
            if let Some(normalized) =
                normalize_tool_call_entry(&entry, fallback_start_id + recovered.len())
            {
                recovered.push(normalized);
            }
        }
    }
    recovered
}

pub(crate) fn extract_strict_wrapper_tool_calls_from_tool_calls_container(
    text: &str,
    fallback_start_id: usize,
) -> Vec<Value> {
    let normalized_text = normalize_dsml_tool_markup(text);
    let Ok(pattern) = Regex::new(r"(?is)<tool_calls>\s*([\s\S]*?)\s*</tool_calls>") else {
        return Vec::new();
    };
    let mut recovered: Vec<Value> = Vec::new();
    for caps in pattern.captures_iter(&normalized_text) {
        let Some(raw) = caps.get(1).map(|m| m.as_str().trim()) else {
            continue;
        };
        if raw.is_empty() {
            continue;
        }
        let parsed = maybe_parse_tool_call_text_value(raw);
        let Some(value) = parsed else {
            continue;
        };
        for entry in extract_tool_call_entries_from_unknown(&value) {
            if let Some(normalized) =
                normalize_tool_call_entry(&entry, fallback_start_id + recovered.len())
            {
                recovered.push(normalized);
            }
        }
    }
    recovered
}

pub(crate) fn extract_strict_wrapper_tool_calls_from_rcc(text: &str, fallback_start_id: usize) -> Vec<Value> {
    let mut recovered: Vec<Value> = Vec::new();
    for inner in extract_rcc_tool_call_fence_segments(text) {
        let parsed = try_parse_json_value_lenient(inner.as_str());
        let Some(value) = parsed else {
            continue;
        };
        for entry in extract_tool_call_entries_from_unknown(&value) {
            if let Some(normalized) =
                normalize_tool_call_entry(&entry, fallback_start_id + recovered.len())
            {
                recovered.push(normalized);
            }
        }
    }
    recovered
}

pub(crate) fn extract_tool_calls_from_text_candidate(text: &str, fallback_start_id: usize) -> Vec<Value> {
    if is_obviously_truncated_tool_calls_payload(text) {
        return Vec::new();
    }

    let mut recovered: Vec<Value> = Vec::new();

    recovered = extract_tool_call_entries_from_malformed_tool_calls_text(text, fallback_start_id);

    if recovered.is_empty() {
        if let Some(parsed) = maybe_parse_tool_call_text_value(text) {
            recovered = extract_tool_call_entries_from_unknown(&parsed);
        }
    }

    if recovered.is_empty() {
        for parsed in extract_json_candidates_from_text(text) {
            recovered = extract_tool_call_entries_from_unknown(&parsed);
            if !recovered.is_empty() {
                break;
            }
        }
    }

    if recovered.is_empty() {
        if let Some(shape) = parse_tool_calls_shape_from_text(text) {
            recovered = extract_tool_call_entries_from_unknown(&shape);
        }
    }

    if recovered.is_empty() {
        recovered = extract_xml_tool_call_blocks(text, fallback_start_id);
    }
    if recovered.is_empty() {
        if let Some(entry) = extract_tool_prefixed_exec_command_block(text, fallback_start_id) {
            recovered.push(entry);
        }
    }
    if recovered.is_empty() {
        recovered = extract_xml_named_tool_call_blocks(text, fallback_start_id);
    }
    if recovered.is_empty() {
        if let Some(entry) = extract_reasoning_inline_exec_command_arg_key(text, fallback_start_id)
        {
            recovered.push(entry);
        }
    }
    if recovered.is_empty() {
        recovered =
            extract_strict_wrapper_tool_calls_from_tool_calls_container(text, fallback_start_id);
    }
    if recovered.is_empty() {
        recovered = extract_strict_wrapper_tool_calls_from_function_calls(text, fallback_start_id);
    }
    if recovered.is_empty() {
        recovered = extract_strict_wrapper_tool_calls_from_rcc(text, fallback_start_id);
    }

    recovered
}

pub(crate) fn harvest_explicit_wrapper_only_tool_calls_from_payload(payload: &mut Value) -> i64 {
    let mut harvested = 0i64;
    let requested_tool_name_keys = collect_requested_tool_name_keys(payload);
    let Some(choices) = payload.get_mut("choices").and_then(|v| v.as_array_mut()) else {
        return harvested;
    };

    for choice in choices.iter_mut() {
        let Some(choice_row) = choice.as_object_mut() else {
            continue;
        };
        let Some(message) = choice_row
            .get_mut("message")
            .and_then(|v| v.as_object_mut())
        else {
            continue;
        };

        let existing_tool_calls = message.get("tool_calls").and_then(|v| v.as_array());
        if let Some(rows) = existing_tool_calls {
            if !rows.is_empty() {
                sanitize_reasoning_fields_after_tool_harvest(message);
                let finish_reason = read_trimmed_string(choice_row.get("finish_reason"))
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                if finish_reason.is_empty() || finish_reason == "stop" {
                    choice_row.insert(
                        "finish_reason".to_string(),
                        Value::String("tool_calls".to_string()),
                    );
                }
                continue;
            }
        }

        let mut recovered: Vec<Value> = Vec::new();
        for text in read_message_text_candidates(message) {
            for harvest_input in collect_stage1_harvest_input_texts(&text) {
                for candidate in collect_harvest_text_variants(&harvest_input) {
                    recovered = extract_tool_calls_from_text_candidate(
                        &candidate,
                        (harvested as usize) + 1,
                    );
                    if !recovered.is_empty() {
                        break;
                    }
                }
                if !recovered.is_empty() {
                    break;
                }
            }
            if !recovered.is_empty() {
                break;
            }
        }

        let _dropped = retain_allowed_tool_calls(&mut recovered, &requested_tool_name_keys);
        if recovered.is_empty() {
            // Harvest failed but markers were present: clean content to prevent leakage
            sanitize_textual_marker_field_in_message_with_policy(message, "content", true);
            continue;
        }

        harvested += recovered.len() as i64;
        message.insert("tool_calls".to_string(), Value::Array(recovered));
        sanitize_textual_marker_field_in_message_with_policy(message, "content", true);
        sanitize_reasoning_fields_after_tool_harvest(message);

        let finish_reason = read_trimmed_string(choice_row.get("finish_reason"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if finish_reason.is_empty() || finish_reason == "stop" {
            choice_row.insert(
                "finish_reason".to_string(),
                Value::String("tool_calls".to_string()),
            );
        }
    }

    harvested
}

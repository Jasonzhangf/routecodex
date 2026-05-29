use serde_json::Value;

use crate::resp_process_stage1_tool_governance_blocks::display_sanitize::{
    contains_explicit_tool_wrapper_marker, extract_explicit_tool_wrapper_inner_payload,
    strip_orphan_tool_markup_lines, strip_tool_call_marker_payload,
    text_contains_explicit_tool_markup,
};
use crate::resp_process_stage1_tool_governance_blocks::message_content::read_message_text_candidates;
use crate::resp_process_stage1_tool_governance_blocks::text_harvest_shape::collect_stage1_harvest_input_texts;
use crate::resp_process_stage1_tool_governance_blocks::text_harvest_strict::extract_tool_calls_from_text_candidate;
use crate::shared_json_utils::read_trimmed_string;

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
    detect_text_tool_provider_family(payload) != TextToolProviderFamily::Other
        || payload_contains_harvestable_text_tool_payload(payload)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TextToolProviderFamily {
    Other,
    DeepSeek,
    Qwen,
}

fn read_text_tool_provider_family_from_governance(
    payload: &Value,
) -> Option<TextToolProviderFamily> {
    let family = payload
        .as_object()
        .and_then(|row| row.get("__rcc_tool_governance"))
        .and_then(Value::as_object)
        .and_then(|row| row.get("providerFamily"))
        .and_then(Value::as_str)
        .map(|raw| raw.trim().to_ascii_lowercase())?;
    match family.as_str() {
        "deepseek" | "deepseek-web" => Some(TextToolProviderFamily::DeepSeek),
        "qwen" | "qwenchat" | "qwenchat-web" => Some(TextToolProviderFamily::Qwen),
        _ => Some(TextToolProviderFamily::Other),
    }
}

fn looks_like_text_tool_provider_token(raw: &str) -> TextToolProviderFamily {
    let normalized = raw.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return TextToolProviderFamily::Other;
    }
    if normalized.contains("deepseek") {
        return TextToolProviderFamily::DeepSeek;
    }
    if normalized.contains("qwen") {
        return TextToolProviderFamily::Qwen;
    }
    TextToolProviderFamily::Other
}

fn detect_text_tool_provider_family(payload: &Value) -> TextToolProviderFamily {
    if let Some(explicit) = read_text_tool_provider_family_from_governance(payload) {
        return explicit;
    }
    let Some(root) = payload.as_object() else {
        return TextToolProviderFamily::Other;
    };

    let mut candidates: Vec<String> = Vec::new();
    for key in ["model", "providerKey", "providerId", "runtimeKey"] {
        if let Some(raw) = read_trimmed_string(root.get(key)) {
            candidates.push(raw);
        }
    }
    if let Some(metadata) = root.get("metadata").and_then(Value::as_object) {
        for key in ["model", "providerKey", "providerId", "runtimeKey"] {
            if let Some(raw) = read_trimmed_string(metadata.get(key)) {
                candidates.push(raw);
            }
        }
        if metadata.get("deepseek").is_some() {
            candidates.push("deepseek".to_string());
        }
        if let Some(provider) = metadata.get("provider").and_then(Value::as_object) {
            for key in ["key", "id", "runtimeKey"] {
                if let Some(raw) = read_trimmed_string(provider.get(key)) {
                    candidates.push(raw);
                }
            }
        }
    }

    for candidate in candidates {
        let family = looks_like_text_tool_provider_token(candidate.as_str());
        if family != TextToolProviderFamily::Other {
            return family;
        }
    }
    TextToolProviderFamily::Other
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

use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde::Serialize;
use serde_json::Value;

use crate::chat_clock_clear_directive::strip_clock_clear_directive_text;
use crate::chat_clock_schedule_directive_candidate::ClockDirectiveCandidateOutput;
use crate::chat_clock_schedule_directive_text_parts::{
    extract_clock_schedule_directive_text_parts, ClockDirectiveTextPartOutput,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClockReminderDirectiveExtractionOutput {
    pub had_clear: bool,
    pub directive_candidates: Vec<ClockDirectiveCandidateOutput>,
    pub base_messages: Value,
}

fn collapse_extra_newlines_and_trim(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut newline_run = 0usize;
    for ch in input.chars() {
        if ch == '\n' {
            newline_run += 1;
            if newline_run <= 2 {
                out.push(ch);
            }
            continue;
        }
        newline_run = 0;
        out.push(ch);
    }
    out.trim().to_string()
}

fn parse_text_and_extract_directives(
    text: &str,
) -> (bool, Vec<ClockDirectiveCandidateOutput>, String) {
    let stripped = strip_clock_clear_directive_text(text.to_string());
    let parts = extract_clock_schedule_directive_text_parts(stripped.next);

    let mut candidates: Vec<ClockDirectiveCandidateOutput> = Vec::new();
    let mut next = String::new();

    for part in parts.parts {
        match part {
            ClockDirectiveTextPartOutput::Text { text } => {
                next.push_str(text.as_str());
            }
            ClockDirectiveTextPartOutput::Directive { full, candidate } => {
                if let Some(value) = candidate {
                    candidates.push(value);
                } else {
                    next.push_str(full.as_str());
                }
            }
        }
    }

    (
        stripped.had_clear,
        candidates,
        collapse_extra_newlines_and_trim(next.as_str()),
    )
}

fn process_content(content: &Value) -> (bool, Vec<ClockDirectiveCandidateOutput>, Value) {
    match content {
        Value::String(text) => {
            let (had_clear, candidates, next) = parse_text_and_extract_directives(text.as_str());
            (had_clear, candidates, Value::String(next))
        }
        Value::Array(parts) => {
            let mut had_clear = false;
            let mut candidates: Vec<ClockDirectiveCandidateOutput> = Vec::new();
            let mut next_parts: Vec<Value> = Vec::with_capacity(parts.len());

            for part in parts {
                match part {
                    Value::String(text) => {
                        let (part_had_clear, mut part_candidates, next_text) =
                            parse_text_and_extract_directives(text.as_str());
                        had_clear = had_clear || part_had_clear;
                        candidates.append(&mut part_candidates);
                        next_parts.push(Value::String(next_text));
                    }
                    Value::Object(obj) => {
                        let text = obj.get("text").and_then(|v| v.as_str());
                        if let Some(text_value) = text {
                            let (part_had_clear, mut part_candidates, next_text) =
                                parse_text_and_extract_directives(text_value);
                            let mut cloned = obj.clone();
                            cloned.insert("text".to_string(), Value::String(next_text));
                            had_clear = had_clear || part_had_clear;
                            candidates.append(&mut part_candidates);
                            next_parts.push(Value::Object(cloned));
                        } else {
                            next_parts.push(part.clone());
                        }
                    }
                    _ => next_parts.push(part.clone()),
                }
            }

            (had_clear, candidates, Value::Array(next_parts))
        }
        _ => (false, Vec::new(), content.clone()),
    }
}

fn find_last_user_message_index(messages: &[Value]) -> Option<usize> {
    messages
        .iter()
        .enumerate()
        .rev()
        .find_map(|(idx, message)| {
            message
                .as_object()
                .and_then(|obj| obj.get("role"))
                .and_then(|v| v.as_str())
                .filter(|v| *v == "user")
                .map(|_| idx)
        })
}

fn extract_clock_reminder_directives(messages: Value) -> ClockReminderDirectiveExtractionOutput {
    let rows = match messages {
        Value::Array(values) => values,
        other => {
            return ClockReminderDirectiveExtractionOutput {
                had_clear: false,
                directive_candidates: Vec::new(),
                base_messages: other,
            }
        }
    };

    let Some(last_user_idx) = find_last_user_message_index(rows.as_slice()) else {
        return ClockReminderDirectiveExtractionOutput {
            had_clear: false,
            directive_candidates: Vec::new(),
            base_messages: Value::Array(rows),
        };
    };

    let message = rows.get(last_user_idx).cloned();
    let Some(Value::Object(message_obj)) = message else {
        return ClockReminderDirectiveExtractionOutput {
            had_clear: false,
            directive_candidates: Vec::new(),
            base_messages: Value::Array(rows),
        };
    };

    let content = message_obj.get("content").cloned().unwrap_or(Value::Null);
    let (had_clear, directive_candidates, next_content) = process_content(&content);
    if !had_clear && directive_candidates.is_empty() {
        return ClockReminderDirectiveExtractionOutput {
            had_clear: false,
            directive_candidates: Vec::new(),
            base_messages: Value::Array(rows),
        };
    }

    let mut next_rows = rows.clone();
    if let Some(Value::Object(mut cloned)) = next_rows.get(last_user_idx).cloned() {
        cloned.insert("content".to_string(), next_content);
        next_rows[last_user_idx] = Value::Object(cloned);
    }

    ClockReminderDirectiveExtractionOutput {
        had_clear,
        directive_candidates,
        base_messages: Value::Array(next_rows),
    }
}

#[napi]
pub fn extract_clock_reminder_directives_json(messages_json: String) -> NapiResult<String> {
    let messages: Value = serde_json::from_str(&messages_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = extract_clock_reminder_directives(messages);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

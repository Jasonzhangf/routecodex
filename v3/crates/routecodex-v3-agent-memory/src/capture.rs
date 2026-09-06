use super::parse::{extract_entries, parse_terminal_memory_unit};
use super::{
    diagnostic, CapturedMemoryEntry, MemoryCaptureDiagnostic, MemoryCaptureReport,
    MemoryTerminalKind, MAX_BYTES_PER_RESPONSE, MAX_ENTRIES_PER_RESPONSE,
};
use crate::MAX_BYTES_PER_ENTRY;
use serde_json::Value;
use std::collections::BTreeMap;

pub fn capture_responses_json(
    response: &Value,
    host_id: &str,
    source_ref: &str,
) -> Result<MemoryCaptureReport, super::MemoryCaptureError> {
    if !responses_json_is_end_turn(response) {
        return Ok(MemoryCaptureReport::empty_for_bytes(0));
    }
    let mut report = MemoryCaptureReport::empty_for_bytes(0);
    let mut entry_count = 0usize;
    let mut entry_bytes = 0usize;
    for ((output_index, content_index), text) in response_output_text_parts(response) {
        report.merge(capture_text_with_budget(
            text,
            host_id,
            source_ref,
            &format!("o{output_index}-c{content_index}"),
            text.len(),
            &mut entry_count,
            &mut entry_bytes,
        ));
    }
    Ok(report)
}

pub fn capture_responses_chat(
    response: &Value,
    host_id: &str,
    source_ref: &str,
) -> Result<MemoryCaptureReport, super::MemoryCaptureError> {
    if !chat_json_is_end_turn(response) {
        return Ok(MemoryCaptureReport::empty_for_bytes(0));
    }
    let text = response
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    Ok(capture_text(text, host_id, source_ref, 0, text.len()))
}

pub(crate) fn capture_text(
    text: &str,
    host_id: &str,
    source_ref: &str,
    output_unit_index: usize,
    bytes_seen: usize,
) -> MemoryCaptureReport {
    let mut entry_count = 0usize;
    let mut entry_bytes = 0usize;
    capture_text_with_budget(
        text,
        host_id,
        source_ref,
        &format!("u{output_unit_index}"),
        bytes_seen,
        &mut entry_count,
        &mut entry_bytes,
    )
}

fn capture_text_with_budget(
    text: &str,
    host_id: &str,
    source_ref: &str,
    output_unit_identity: &str,
    bytes_seen: usize,
    entry_count: &mut usize,
    total_bytes: &mut usize,
) -> MemoryCaptureReport {
    let parsed = parse_terminal_memory_unit(text);
    let mut diagnostics = parsed.diagnostics.clone();
    let mut captured = Vec::new();

    if parsed.found {
        if let Some(object) = parsed.object.as_ref() {
            let entries = extract_entries(object, &mut diagnostics);
            for (original_index, entry) in entries {
                if *entry_count >= MAX_ENTRIES_PER_RESPONSE {
                    diagnostics.push(diagnostic(
                        "memory_entry_overflow",
                        "memory entry count exceeds MAX_ENTRIES_PER_RESPONSE",
                        Some(original_index),
                    ));
                    continue;
                }
                let entry_bytes = serde_json::to_vec(&entry).unwrap_or_default().len();
                if entry_bytes > MAX_BYTES_PER_ENTRY {
                    diagnostics.push(diagnostic(
                        "memory_entry_overflow",
                        "memory entry exceeds MAX_BYTES_PER_ENTRY",
                        Some(original_index),
                    ));
                    continue;
                }
                if total_bytes.saturating_add(entry_bytes) > MAX_BYTES_PER_RESPONSE {
                    diagnostics.push(diagnostic(
                        "memory_entry_overflow",
                        "memory capture exceeds MAX_BYTES_PER_RESPONSE",
                        Some(original_index),
                    ));
                    continue;
                }
                *entry_count = (*entry_count).saturating_add(1);
                *total_bytes = (*total_bytes).saturating_add(entry_bytes);
                captured.push(CapturedMemoryEntry {
                    host_id: crate::stable_host_id(&format!(
                        "{host_id}-{source_ref}-{output_unit_identity}-e{original_index}"
                    )),
                    entry,
                    source_ref: source_ref.to_owned(),
                });
            }
        }
    }

    let bytes_after_strip = parsed.strip_range.map_or(bytes_seen, |(start, end)| {
        text[..start]
            .trim_end()
            .len()
            .saturating_add(text[end..].trim_start().len())
    });
    MemoryCaptureReport {
        captured,
        diagnostics,
        bytes_after_strip,
        memory_unit_found: parsed.found,
    }
}

pub fn strip_memory_envelope_from_text(text: &str, report: &MemoryCaptureReport) -> String {
    if !report.memory_unit_found {
        return text.to_owned();
    }
    let parsed = parse_terminal_memory_unit(text);
    if let Some((start, end)) = parsed.strip_range {
        let mut stripped =
            String::with_capacity(text.len().saturating_sub(end.saturating_sub(start)));
        stripped.push_str(&text[..start]);
        stripped.push_str(&text[end..]);
        stripped.trim_end().to_owned()
    } else {
        text.to_owned()
    }
}

pub fn strip_memory_envelope_from_responses_payload(
    payload: &mut Value,
    report: &MemoryCaptureReport,
) {
    if !report.memory_unit_found {
        return;
    }
    if let Some(items) = payload.get_mut("output").and_then(Value::as_array_mut) {
        for item in items {
            if let Some(parts) = item.get_mut("content").and_then(Value::as_array_mut) {
                for part in parts {
                    if part.get("type").and_then(Value::as_str) == Some("output_text") {
                        if let Some(Value::String(text)) = part.get_mut("text") {
                            *text = strip_memory_envelope_from_text(text, report);
                        }
                    }
                }
            }
        }
    }
}

#[derive(Debug, Default)]
pub struct ResponsesSseAccumulator {
    delta_text: BTreeMap<(usize, usize), String>,
    done_text: BTreeMap<(usize, usize), String>,
    completed_texts: Vec<((usize, usize), String)>,
    terminal: Option<MemoryTerminalKind>,
    bytes_seen: usize,
    completed_event_seen: bool,
    diagnostics: Vec<MemoryCaptureDiagnostic>,
}

impl ResponsesSseAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn feed_event(&mut self, event: &Value) -> Result<(), super::MemoryCaptureError> {
        self.bytes_seen = self.bytes_seen.saturating_add(event.to_string().len());
        let event_type = event.get("type").and_then(Value::as_str);
        match event_type {
            Some("response.output_text.delta") => {
                if self.completed_event_seen {
                    return Ok(());
                }
                match event.get("delta").and_then(Value::as_str) {
                    Some(delta) => self
                        .delta_text
                        .entry(output_text_key(event))
                        .or_default()
                        .push_str(delta),
                    None => self.diagnostics.push(diagnostic(
                        "memory_sse_delta_invalid",
                        "response.output_text.delta must contain delta text",
                        None,
                    )),
                }
            }
            Some("response.output_text.done") => {
                if let Some(text) = event.get("text").and_then(Value::as_str) {
                    self.done_text
                        .insert(output_text_key(event), text.to_owned());
                }
            }
            Some("response.completed" | "response.done") => {
                if self.completed_event_seen {
                    return Ok(());
                }
                self.completed_event_seen = true;
                if terminal_completed_event(event) && !event_has_active_tool_output(event) {
                    self.completed_texts = completed_event_text_parts(event);
                    self.terminal = Some(MemoryTerminalKind::ResponsesCompletedEvent);
                } else {
                    self.completed_texts.clear();
                    self.terminal = None;
                }
            }
            Some(
                "response.incomplete"
                | "response.failed"
                | "response.cancelled"
                | "response.canceled",
            ) => {
                self.completed_event_seen = true;
                self.terminal = None;
            }
            _ => {}
        }
        Ok(())
    }

    pub fn canonical_output_texts(&self) -> Vec<(usize, usize, String)> {
        let texts: Vec<((usize, usize), String)> = if !self.completed_texts.is_empty() {
            self.completed_texts.clone()
        } else if !self.done_text.is_empty() {
            self.done_text
                .iter()
                .map(|(key, text)| (*key, text.clone()))
                .collect()
        } else {
            self.delta_text
                .iter()
                .map(|(key, text)| (*key, text.clone()))
                .collect()
        };
        texts
            .into_iter()
            .map(|((output_index, content_index), text)| (output_index, content_index, text))
            .collect()
    }

    pub fn terminal_kind(&self) -> Option<MemoryTerminalKind> {
        self.terminal
    }

    pub fn finalize(self, host_id: &str, source_ref: &str) -> MemoryCaptureReport {
        match self.terminal {
            Some(_) => {
                let texts = self.canonical_output_texts();
                let mut report = MemoryCaptureReport::empty_for_bytes(0);
                let mut entry_count = 0usize;
                let mut entry_bytes = 0usize;
                for (output_index, content_index, text) in texts {
                    report.merge(capture_text_with_budget(
                        &text,
                        host_id,
                        source_ref,
                        &format!("o{output_index}-c{content_index}"),
                        text.len(),
                        &mut entry_count,
                        &mut entry_bytes,
                    ));
                }
                report.diagnostics.extend(self.diagnostics);
                report
            }
            None => MemoryCaptureReport {
                captured: Vec::new(),
                diagnostics: self.diagnostics,
                bytes_after_strip: self.bytes_seen,
                memory_unit_found: false,
            },
        }
    }
}

fn responses_json_is_end_turn(response: &Value) -> bool {
    if response.get("status").and_then(Value::as_str) != Some("completed") {
        return false;
    }
    if response_output_text_parts(response).is_empty() {
        return false;
    }
    !response_has_active_tool_output(response)
}

fn chat_json_is_end_turn(response: &Value) -> bool {
    response
        .pointer("/choices/0/finish_reason")
        .and_then(Value::as_str)
        == Some("stop")
}

fn response_output_text_parts(response: &Value) -> Vec<((usize, usize), &str)> {
    let mut parts = Vec::new();
    if let Some(items) = response.get("output").and_then(Value::as_array) {
        for (output_index, item) in items.iter().enumerate() {
            if let Some(content) = item.get("content").and_then(Value::as_array) {
                for (content_index, part) in content.iter().enumerate() {
                    if part.get("type").and_then(Value::as_str) == Some("output_text") {
                        if let Some(text) = part.get("text").and_then(Value::as_str) {
                            parts.push(((output_index, content_index), text));
                        }
                    }
                }
            }
        }
    }
    parts
}

fn terminal_completed_event(event: &Value) -> bool {
    status_from_event(event) == Some("completed")
}

fn status_from_event(event: &Value) -> Option<&str> {
    event
        .get("status")
        .and_then(Value::as_str)
        .or_else(|| event.get("response").and_then(Value::as_str))
        .or_else(|| {
            event
                .get("response")
                .and_then(Value::as_object)
                .and_then(|object| object.get("status"))
                .and_then(Value::as_str)
        })
}

fn completed_event_text_parts(event: &Value) -> Vec<((usize, usize), String)> {
    let Some(response) = event.get("response") else {
        return Vec::new();
    };
    let Some(output) = response.get("output").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (output_index, item) in output.iter().enumerate() {
        let Some(content) = item.get("content").and_then(Value::as_array) else {
            continue;
        };
        for (content_index, part) in content.iter().enumerate() {
            if part.get("type").and_then(Value::as_str) == Some("output_text") {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    out.push(((output_index, content_index), text.to_owned()));
                }
            }
        }
    }
    out
}

fn output_text_key(event: &Value) -> (usize, usize) {
    (
        event
            .get("output_index")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize,
        event
            .get("content_index")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize,
    )
}

fn response_has_active_tool_output(response: &Value) -> bool {
    let Some(items) = response.get("output").and_then(Value::as_array) else {
        return false;
    };
    items.iter().any(|item| {
        matches!(
            item.get("type").and_then(Value::as_str),
            Some("function_call" | "web_search_call")
        )
    })
}

fn event_has_active_tool_output(event: &Value) -> bool {
    response_has_active_tool_output(event.get("response").unwrap_or(&Value::Null))
}

mod capture;
mod markdown;
mod parse;

pub use capture::{
    capture_responses_chat, capture_responses_json, strip_memory_envelope_from_responses_payload,
    strip_memory_envelope_from_text, ResponsesSseAccumulator,
};
pub use markdown::{publish_l3_entry, render_l3_markdown, stable_host_id};
pub use parse::MemoryUnitParse;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const ROUTE_CODEX_MEMORY_RAW_ENTRY_V1: &str = "routecodex.memory.raw-entry.v1";
pub const PROJECT_MEMORY_MARKER: &str = "project-memory:v1";
pub const PROJECT_MEMORY_END_MARKER: &str = "project-memory:end";
pub const MEMORY_RAW_CAPTURE_GUIDANCE_MARKER: &str = "routecodex.memory.raw-entry.v1";
pub const MAX_ENTRIES_PER_RESPONSE: usize = 16;
pub const MAX_BYTES_PER_ENTRY: usize = 8 * 1024;
pub const MAX_BYTES_PER_RESPONSE: usize = 64 * 1024;

pub fn memory_raw_capture_guidance_text() -> String {
    format!(
        "If this is an end_turn completion and you have durable memory candidates, append one final JSON object \
         with schema {ROUTE_CODEX_MEMORY_RAW_ENTRY_V1} to the final output_text after your normal answer: \
         {{\"memory\":{{\"entries\":[{{\"schema\":\"{ROUTE_CODEX_MEMORY_RAW_ENTRY_V1}\",\"category\":\"plan|path|knowledge|lesson\",\"title\":\"...\",\"content\":\"...\",\"tags\":[\"topic\"]}}]}}}}. \
         Never put memory in tool arguments, history, metadata, or structured-output fields. Missing memory is normal."
    )
}

pub fn inject_memory_raw_capture_guidance(body: &mut Value) -> Result<(), String> {
    let object = body
        .as_object_mut()
        .ok_or_else(|| "responses request body must be an object".to_owned())?;
    let guidance = memory_raw_capture_guidance_text();
    let messages_already_guided = object
        .get("messages")
        .is_some_and(|messages| messages_contain_guidance(messages, &guidance));
    match object.get_mut("instructions") {
        Some(Value::String(current)) => {
            if current.contains(&guidance) {
                return Ok(());
            }
            current.push('\n');
            current.push_str(&guidance);
        }
        None if messages_already_guided => {}
        None => {
            object.insert("instructions".to_owned(), Value::String(guidance));
        }
        Some(_) => {
            return Err("responses instructions must be a string for memory guidance".to_owned());
        }
    }
    Ok(())
}

fn messages_contain_guidance(messages: &Value, guidance: &str) -> bool {
    messages.as_array().is_some_and(|items| {
        items.iter().any(|item| {
            matches!(
                item.get("role").and_then(Value::as_str),
                Some("system" | "developer")
            ) && item
                .get("content")
                .and_then(Value::as_str)
                .is_some_and(|content| content.contains(guidance))
        })
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryCategory {
    Plan,
    Path,
    Knowledge,
    Lesson,
}

impl MemoryCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Path => "path",
            Self::Knowledge => "knowledge",
            Self::Lesson => "lesson",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RawMemoryEntry {
    pub schema: String,
    pub category: MemoryCategory,
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedMemoryEntry {
    pub host_id: String,
    pub entry: RawMemoryEntry,
    pub source_ref: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryCaptureReport {
    pub captured: Vec<CapturedMemoryEntry>,
    pub diagnostics: Vec<MemoryCaptureDiagnostic>,
    pub bytes_after_strip: usize,
    pub memory_unit_found: bool,
}

impl Default for MemoryCaptureReport {
    fn default() -> Self {
        Self {
            captured: Vec::new(),
            diagnostics: Vec::new(),
            bytes_after_strip: 0,
            memory_unit_found: false,
        }
    }
}

impl MemoryCaptureReport {
    pub(crate) fn empty_for_bytes(bytes_after_strip: usize) -> Self {
        Self {
            captured: Vec::new(),
            diagnostics: Vec::new(),
            bytes_after_strip,
            memory_unit_found: false,
        }
    }

    pub(crate) fn merge(&mut self, other: MemoryCaptureReport) {
        self.captured.extend(other.captured);
        self.diagnostics.extend(other.diagnostics);
        self.bytes_after_strip = self
            .bytes_after_strip
            .saturating_add(other.bytes_after_strip);
        self.memory_unit_found |= other.memory_unit_found;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryCaptureDiagnostic {
    pub code: String,
    pub message: String,
    pub entry_index: Option<usize>,
}

pub(crate) fn diagnostic(
    code: &str,
    message: &str,
    entry_index: Option<usize>,
) -> MemoryCaptureDiagnostic {
    MemoryCaptureDiagnostic {
        code: code.to_owned(),
        message: message.to_owned(),
        entry_index,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryTerminalKind {
    ResponsesCompletedEvent,
    ChatCompletedStop,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MemoryCaptureError {
    #[error("memory capture oversized: entries={entries} bytes={bytes}")]
    CaptureOversized { entries: usize, bytes: usize },
    #[error("memory entry oversized: bytes={bytes} limit={limit}")]
    EntryOversized { bytes: usize, limit: usize },
    #[error("memory publication failed: {0}")]
    PublicationFailed(String),
}

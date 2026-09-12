use super::{
    diagnostic, MemoryCaptureDiagnostic, MemoryCategory, RawMemoryEntry, MAX_BYTES_PER_ENTRY,
    ROUTE_CODEX_MEMORY_RAW_ENTRY_V1,
};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MemoryUnitParse {
    pub found: bool,
    pub strip_range: Option<(usize, usize)>,
    pub object: Option<Value>,
    pub diagnostics: Vec<MemoryCaptureDiagnostic>,
}

pub(crate) fn parse_terminal_memory_unit(text: &str) -> MemoryUnitParse {
    let trimmed_end = text.trim_end();
    if is_inside_markdown_fence(trimmed_end) {
        return MemoryUnitParse::default();
    }
    let mut start = None;
    let mut value = None;
    for candidate in terminal_memory_candidate_starts(trimmed_end).iter().rev() {
        if let Ok(parsed) = serde_json::from_str::<Value>(&trimmed_end[*candidate..]) {
            if parsed
                .as_object()
                .is_some_and(|object| object.contains_key("memory"))
            {
                start = Some(*candidate);
                value = Some(parsed);
                break;
            }
        }
    }
    let (Some(start), Some(value)) = (start, value) else {
        return MemoryUnitParse::default();
    };
    let Some(root) = value.as_object() else {
        return MemoryUnitParse::default();
    };

    let mut diagnostics = Vec::new();
    if root.keys().any(|key| key != "memory") {
        diagnostics.push(diagnostic(
            "memory_envelope_unknown_field",
            "memory envelope root contains unknown field",
            None,
        ));
    }

    let memory = root.get("memory");
    if !matches!(memory, Some(Value::Object(_))) {
        diagnostics.push(diagnostic(
            "memory_envelope_invalid",
            "memory envelope must contain a JSON object named memory",
            None,
        ));
        return MemoryUnitParse {
            found: true,
            strip_range: Some((start, trimmed_end.len())),
            object: Some(value),
            diagnostics,
        };
    }

    let memory = memory.and_then(Value::as_object).expect("checked above");
    if memory.keys().any(|key| key != "entries") {
        diagnostics.push(diagnostic(
            "memory_envelope_unknown_field",
            "memory envelope contains unknown field",
            None,
        ));
    }

    if let Some(entries) = memory.get("entries") {
        if !entries.is_array() {
            diagnostics.push(diagnostic(
                "memory_envelope_invalid",
                "memory envelope entries must be an array",
                None,
            ));
        }
    }

    MemoryUnitParse {
        found: true,
        strip_range: Some((start, trimmed_end.len())),
        object: Some(value),
        diagnostics,
    }
}

pub(crate) fn extract_entries(
    value: &Value,
    diagnostics: &mut Vec<MemoryCaptureDiagnostic>,
) -> Vec<(usize, RawMemoryEntry)> {
    let Some(root) = value.as_object() else {
        return Vec::new();
    };
    let Some(memory) = root.get("memory").and_then(Value::as_object) else {
        return Vec::new();
    };
    let Some(entries) = memory.get("entries").and_then(Value::as_array) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for (index, entry_value) in entries.iter().enumerate() {
        if let Some(entry) = parse_entry(entry_value, index, diagnostics) {
            out.push((index, entry));
        }
    }
    out
}

fn parse_entry(
    value: &Value,
    index: usize,
    diagnostics: &mut Vec<MemoryCaptureDiagnostic>,
) -> Option<RawMemoryEntry> {
    let object = match value.as_object() {
        Some(object) => object,
        None => {
            diagnostics.push(diagnostic(
                "memory_entry_invalid",
                "memory entry must be a JSON object",
                Some(index),
            ));
            return None;
        }
    };

    if object.keys().any(|key| {
        !matches!(
            key.as_str(),
            "schema" | "category" | "title" | "content" | "tags"
        )
    }) {
        diagnostics.push(diagnostic(
            "memory_entry_unknown_field",
            "memory entry contains unknown field",
            Some(index),
        ));
        return None;
    }

    let schema = match object.get("schema").and_then(Value::as_str) {
        Some(schema) if schema == ROUTE_CODEX_MEMORY_RAW_ENTRY_V1 => schema,
        _ => {
            diagnostics.push(diagnostic(
                "memory_entry_schema_invalid",
                "memory entry schema must be routecodex.memory.raw-entry.v1",
                Some(index),
            ));
            return None;
        }
    };

    let category = match object.get("category").and_then(Value::as_str) {
        Some("plan") => MemoryCategory::Plan,
        Some("path") => MemoryCategory::Path,
        Some("knowledge") => MemoryCategory::Knowledge,
        Some("lesson") => MemoryCategory::Lesson,
        _ => {
            diagnostics.push(diagnostic(
                "memory_entry_category_invalid",
                "memory entry category must be plan, path, knowledge, or lesson",
                Some(index),
            ));
            return None;
        }
    };

    let title = match object.get("title").and_then(Value::as_str) {
        Some(title) if !title.trim().is_empty() => title,
        _ => {
            diagnostics.push(diagnostic(
                "memory_entry_invalid",
                "memory entry title must be a non-empty string",
                Some(index),
            ));
            return None;
        }
    };

    let content = match object.get("content").and_then(Value::as_str) {
        Some(content) if !content.trim().is_empty() => content,
        _ => {
            diagnostics.push(diagnostic(
                "memory_entry_invalid",
                "memory entry content must be a non-empty string",
                Some(index),
            ));
            return None;
        }
    };

    let tags = match object.get("tags") {
        None => Vec::new(),
        Some(Value::Array(values)) => {
            let mut tags = Vec::new();
            for tag in values {
                match tag.as_str() {
                    Some(tag) if !tag.trim().is_empty() => tags.push(tag.trim().to_owned()),
                    _ => {
                        diagnostics.push(diagnostic(
                            "memory_entry_invalid",
                            "memory entry tags must be an array of non-empty strings",
                            Some(index),
                        ));
                        return None;
                    }
                }
            }
            tags
        }
        Some(_) => {
            diagnostics.push(diagnostic(
                "memory_entry_invalid",
                "memory entry tags must be an array of strings",
                Some(index),
            ));
            return None;
        }
    };

    let title = title.trim();
    let content = content.trim_end();
    if title.contains('\n') || title.contains('\r') || contains_markdown_comment_marker(title) {
        diagnostics.push(diagnostic(
            "memory_entry_invalid",
            "memory entry title cannot contain line breaks or markdown comment markers",
            Some(index),
        ));
        return None;
    }
    if contains_project_memory_end_marker(content) {
        diagnostics.push(diagnostic(
            "memory_entry_invalid",
            "memory entry content cannot contain the project-memory end marker",
            Some(index),
        ));
        return None;
    }

    let entry = RawMemoryEntry {
        schema: schema.to_owned(),
        category,
        title: title.to_owned(),
        content: content.to_owned(),
        tags,
    };
    let entry_bytes = serde_json::to_vec(&entry).unwrap_or_default().len();
    if entry_bytes > MAX_BYTES_PER_ENTRY {
        diagnostics.push(diagnostic(
            "memory_entry_invalid",
            "memory entry exceeds MAX_BYTES_PER_ENTRY",
            Some(index),
        ));
        return None;
    }

    Some(entry)
}

fn terminal_memory_candidate_starts(text: &str) -> Vec<usize> {
    let mut found = Vec::new();
    for (index, character) in text.char_indices() {
        if character != '{' {
            continue;
        }
        let boundary_ok = index == 0
            || text[..index]
                .chars()
                .next_back()
                .is_some_and(char::is_whitespace);
        if boundary_ok {
            found.push(index);
        }
    }
    found
}

fn contains_markdown_comment_marker(value: &str) -> bool {
    value.contains("<!--") || value.contains("-->")
}

fn contains_project_memory_end_marker(value: &str) -> bool {
    value.contains("<!-- project-memory:end -->")
}

fn is_inside_markdown_fence(text: &str) -> bool {
    text.matches("```").count() % 2 == 1
}

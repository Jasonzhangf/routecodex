use serde_json::{Map, Value};

use crate::hashline::{self, HashlineNativeEditInput};
use crate::resp_process_stage1_tool_governance_blocks::apply_patch_guard::make_apply_patch_guard_args;
use crate::resp_process_stage1_tool_governance_blocks::apply_patch_live_context::repair_line_number_update_hunks_with_live_context;
use crate::resp_process_stage1_tool_governance_blocks::apply_patch_text::{
    decode_escaped_newlines_if_needed, extract_apply_patch_text, has_unified_like_header,
    normalize_apply_patch_header_line, normalize_unified_header_path,
    strip_apply_patch_command_prefix, trim_to_patch_window,
};
use crate::resp_process_stage1_tool_governance_blocks::json_args::{
    parse_json_record, try_parse_json_value_lenient,
};
use crate::shared_json_utils::read_trimmed_string;

fn convert_servertool_line_edit_to_canonical_patch(file_path: &str, patch: &str) -> String {
    // servertool line-edit format: "- old\n+ new" → canonical apply_patch format
    let mut out = vec!["*** Begin Patch".to_string()];
    let has_removals = patch.lines().any(|l| l.starts_with('-'));
    if has_removals {
        out.push(format!("*** Update File: {}", file_path));
        out.push("@@".to_string());
    } else {
        out.push(format!("*** Add File: {}", file_path));
    }
    for line in patch.lines() {
        out.push(line.to_string());
    }
    out.push("*** End Patch".to_string());
    out.join("\n")
}

fn read_apply_patch_source_from_args(args: &Map<String, Value>) -> Option<String> {
    let direct = ["patch", "input", "text", "content", "body", "arguments"];
    for key in direct {
        if let Some(raw) = args
            .get(key)
            .and_then(|value| extract_apply_patch_text(Some(value)))
            .map(|value| value.replace("\r\n", "\n").replace('\r', "\n"))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            return Some(raw);
        }
    }
    args.get("input")
        .and_then(Value::as_object)
        .and_then(read_apply_patch_source_from_args)
}

fn build_current_apply_patch_schema_args(args: &Map<String, Value>) -> Option<(String, bool)> {
    if args.contains_key("fileContent") || args.contains_key("file_content") {
        return None;
    }
    let file_path = read_hashline_file_path_from_apply_patch_args(args)?;
    let patch_source = read_apply_patch_source_from_args(args)?;
    if patch_source.trim_start().starts_with("*** Begin Patch")
        || looks_like_native_hashline_header_patch(patch_source.as_str())
    {
        return None;
    }
    // Detect servertool line-edit format: {filePath, patch} with -/+ lines
    // Convert to canonical {patch, input} format for client compatibility
    let is_line_edit = patch_source
        .lines()
        .any(|l| l.starts_with('-') || l.starts_with('+'));
    if is_line_edit {
        let canonical_patch =
            convert_servertool_line_edit_to_canonical_patch(&file_path, &patch_source);
        let mut out = Map::new();
        out.insert("patch".to_string(), Value::String(canonical_patch));
        return Some((
            serde_json::to_string(&Value::Object(out)).unwrap_or_else(|_| "{}".to_string()),
            true,
        ));
    }
    // Fallback: preserve only canonical patch carrier for model-visible history.
    let mut out = Map::new();
    out.insert("patch".to_string(), Value::String(patch_source));
    Some((
        serde_json::to_string(&Value::Object(out)).unwrap_or_else(|_| "{}".to_string()),
        true,
    ))
}

pub(crate) fn detect_apply_patch_invalid_reason(patch: &str) -> Option<&'static str> {
    let trimmed = patch.trim();
    if trimmed.is_empty() {
        return Some("empty_patch");
    }
    if trimmed.contains("<<<<<<<") || trimmed.contains("=======") || trimmed.contains(">>>>>>>") {
        return Some("conflict_markers");
    }
    if trimmed.lines().any(|line| {
        let line = line.trim_start();
        line.starts_with("diff --git ") || line.starts_with("--- ") || line.starts_with("+++ ")
    }) {
        return Some("mixed_gnu_diff");
    }
    let is_line_edit = trimmed.lines().all(|line| {
        let current = line.trim_end();
        current.is_empty()
            || current.starts_with('+')
            || current.starts_with('-')
            || current.starts_with(' ')
            || current.starts_with("@@")
    });
    if is_line_edit
        && trimmed
            .lines()
            .any(|line| line.starts_with('+') || line.starts_with('-'))
    {
        return None;
    }
    if !(trimmed.starts_with("*** Begin Patch") && trimmed.contains("*** End Patch")) {
        return Some("unsupported_patch_format");
    }
    let has_file_marker = trimmed.contains("*** Add File:")
        || trimmed.contains("*** Update File:")
        || trimmed.contains("*** Delete File:");
    if !has_file_marker {
        return Some("unsupported_patch_format");
    }
    if trimmed.contains("*** Add File:")
        && !trimmed
            .lines()
            .any(|line| line.starts_with('+') && !line.starts_with("+++"))
    {
        return Some("empty_add_file_block");
    }
    None
}

fn looks_like_hashline_patch(raw: &str) -> bool {
    let first = raw
        .lines()
        .map(str::trim_start)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    let mut chars = first.chars();
    let Some(lead) = chars.next() else {
        return false;
    };
    matches!(lead, '<' | '+' | '-' | '=')
        && chars.next().map(|ch| ch.is_whitespace()).unwrap_or(true)
}

fn looks_like_native_hashline_header_patch(raw: &str) -> bool {
    let first = raw
        .lines()
        .map(str::trim_start)
        .find(|line| !line.is_empty())
        .unwrap_or("");
    let mut parts = first.split_whitespace();
    let Some(op) = parts.next() else {
        return false;
    };
    if !matches!(op, "<" | "+" | "-" | "=") {
        return false;
    }
    parts
        .next()
        .map(|line_num| line_num.chars().all(|ch| ch.is_ascii_digit()))
        .unwrap_or(false)
}

fn read_hashline_file_path_from_apply_patch_args(args: &Map<String, Value>) -> Option<String> {
    read_trimmed_string(args.get("filePath"))
        .or_else(|| read_trimmed_string(args.get("file_path")))
        .or_else(|| {
            args.get("input")
                .and_then(Value::as_object)
                .and_then(|row| read_trimmed_string(row.get("filePath")))
        })
        .or_else(|| {
            args.get("input")
                .and_then(Value::as_object)
                .and_then(|row| read_trimmed_string(row.get("file_path")))
        })
}

fn read_hashline_file_content_from_apply_patch_args(args: &Map<String, Value>) -> Option<String> {
    read_trimmed_string(args.get("fileContent"))
        .or_else(|| read_trimmed_string(args.get("file_content")))
        .or_else(|| {
            args.get("input")
                .and_then(Value::as_object)
                .and_then(|row| read_trimmed_string(row.get("fileContent")))
        })
        .or_else(|| {
            args.get("input")
                .and_then(Value::as_object)
                .and_then(|row| read_trimmed_string(row.get("file_content")))
        })
}

fn read_apply_patch_string_preserve_empty(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::String(raw)) => Some(raw.replace("\r\n", "\n").replace('\r', "\n")),
        _ => None,
    }
}

fn read_hashline_file_content_preserve_empty_from_apply_patch_args(
    args: &Map<String, Value>,
) -> Option<String> {
    read_apply_patch_string_preserve_empty(args.get("fileContent"))
        .or_else(|| read_apply_patch_string_preserve_empty(args.get("file_content")))
        .or_else(|| {
            args.get("input")
                .and_then(Value::as_object)
                .and_then(|row| read_apply_patch_string_preserve_empty(row.get("fileContent")))
        })
        .or_else(|| {
            args.get("input")
                .and_then(Value::as_object)
                .and_then(|row| read_apply_patch_string_preserve_empty(row.get("file_content")))
        })
}

enum HashlineApplyPatchNormalization {
    NotHashline,
    Normalized((String, bool)),
    Guarded {
        normalized: (String, bool),
        reason: &'static str,
    },
}

fn split_hashline_bridge_file_lines(file_content: &str) -> Vec<String> {
    if file_content.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<String> = file_content
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
        .map(|line| line.to_string())
        .collect();
    if lines.last().map(|line| line.is_empty()).unwrap_or(false) {
        lines.pop();
    }
    lines
}

fn find_exact_line_block_once(haystack: &[String], needle: &[String]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    let mut found: Option<usize> = None;
    for index in 0..=haystack.len().saturating_sub(needle.len()) {
        if haystack[index..index + needle.len()] == needle[..] {
            if found.is_some() {
                return None;
            }
            found = Some(index);
        }
    }
    found
}

fn normalize_simple_line_edit_apply_patch_schema_args(
    args: &Map<String, Value>,
) -> Option<HashlineApplyPatchNormalization> {
    let patch_source = read_apply_patch_source_from_args(args)?;
    if looks_like_native_hashline_header_patch(patch_source.as_str()) {
        return None;
    }
    let mut old_lines: Vec<String> = Vec::new();
    let mut new_lines: Vec<String> = Vec::new();
    let mut saw_edit_line = false;
    for raw_line in patch_source.lines() {
        if let Some(rest) = raw_line.strip_prefix('-') {
            saw_edit_line = true;
            old_lines.push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
            continue;
        }
        if let Some(rest) = raw_line.strip_prefix('+') {
            saw_edit_line = true;
            new_lines.push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
            continue;
        }
        if raw_line.trim().is_empty() {
            continue;
        }
        return None;
    }
    if !saw_edit_line || new_lines.is_empty() {
        return None;
    }
    let Some(file_path) = read_hashline_file_path_from_apply_patch_args(args) else {
        return Some(HashlineApplyPatchNormalization::Guarded {
            normalized: (make_apply_patch_guard_args("missing_patch"), true),
            reason: "hashline_missing_file_path",
        });
    };
    let Some(file_content) = read_hashline_file_content_preserve_empty_from_apply_patch_args(args)
    else {
        return Some(HashlineApplyPatchNormalization::Guarded {
            normalized: (make_apply_patch_guard_args("missing_patch"), true),
            reason: "hashline_missing_file_content",
        });
    };
    let file_lines = split_hashline_bridge_file_lines(file_content.as_str());
    let mut patch_lines: Vec<String> = vec!["*** Begin Patch".to_string()];
    if old_lines.is_empty() {
        if !file_lines.is_empty() {
            return Some(HashlineApplyPatchNormalization::Guarded {
                normalized: (
                    make_apply_patch_guard_args("unsupported_patch_format"),
                    true,
                ),
                reason: "hashline_simple_add_requires_empty_file",
            });
        }
        patch_lines.push(format!("*** Add File: {}", file_path));
    } else {
        if find_exact_line_block_once(&file_lines, &old_lines).is_none() {
            return Some(HashlineApplyPatchNormalization::Guarded {
                normalized: (
                    make_apply_patch_guard_args("unsupported_patch_format"),
                    true,
                ),
                reason: "hashline_simple_edit_not_unique",
            });
        }
        patch_lines.push(format!("*** Update File: {}", file_path));
        patch_lines.push("@@".to_string());
        for line in old_lines {
            patch_lines.push(format!("-{}", line));
        }
    }
    for line in new_lines {
        patch_lines.push(format!("+{}", line));
    }
    patch_lines.push("*** End Patch".to_string());
    let canonical_patch = patch_lines.join("\n");
    let mut out = Map::new();
    out.insert("patch".to_string(), Value::String(canonical_patch));
    Some(HashlineApplyPatchNormalization::Normalized((
        serde_json::to_string(&Value::Object(out)).unwrap_or_else(|_| "{}".to_string()),
        true,
    )))
}

fn normalize_hashline_apply_patch_schema_args(
    args: &Map<String, Value>,
) -> HashlineApplyPatchNormalization {
    let patch_source = read_apply_patch_source_from_args(args);
    let Some(patch_source) = patch_source else {
        return HashlineApplyPatchNormalization::NotHashline;
    };
    if !looks_like_hashline_patch(patch_source.as_str()) {
        return HashlineApplyPatchNormalization::NotHashline;
    }
    let Some(file_path) = read_hashline_file_path_from_apply_patch_args(args) else {
        return HashlineApplyPatchNormalization::Guarded {
            normalized: (make_apply_patch_guard_args("missing_patch"), true),
            reason: "hashline_missing_file_path",
        };
    };
    let Some(file_content) = read_hashline_file_content_from_apply_patch_args(args) else {
        return HashlineApplyPatchNormalization::Guarded {
            normalized: (make_apply_patch_guard_args("missing_patch"), true),
            reason: "hashline_missing_file_content",
        };
    };
    let result = hashline::run_hashline_native_edit(HashlineNativeEditInput {
        patch: patch_source,
        file_path,
        file_content,
    });
    if !result.ok {
        return HashlineApplyPatchNormalization::Guarded {
            normalized: (
                make_apply_patch_guard_args("unsupported_patch_format"),
                true,
            ),
            reason: "hashline_native_edit_failed",
        };
    }
    let Some(normalized_patch) = result.normalized_patch else {
        return HashlineApplyPatchNormalization::Guarded {
            normalized: (
                make_apply_patch_guard_args("unsupported_patch_format"),
                true,
            ),
            reason: "hashline_missing_normalized_patch",
        };
    };
    let mut out = Map::new();
    out.insert("patch".to_string(), Value::String(normalized_patch));
    HashlineApplyPatchNormalization::Normalized((
        serde_json::to_string(&Value::Object(out)).unwrap_or_else(|_| "{}".to_string()),
        true,
    ))
}

pub(crate) fn detect_hashline_apply_patch_guard_reason(
    raw_args: Option<&Value>,
) -> Option<&'static str> {
    let args = parse_json_record(raw_args).unwrap_or_default();
    match normalize_hashline_apply_patch_schema_args(&args) {
        HashlineApplyPatchNormalization::Guarded { reason, .. } => Some(reason),
        _ => None,
    }
}

pub(crate) fn looks_like_unparseable_apply_patch_json_args(raw_args: Option<&Value>) -> bool {
    let Some(Value::String(raw)) = raw_args else {
        return false;
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return false;
    }
    let first = trimmed.chars().next().unwrap_or_default();
    let last = trimmed.chars().last().unwrap_or_default();
    let looks_json_container = (first == '{' && last == '}') || (first == '[' && last == ']');
    looks_json_container && try_parse_json_value_lenient(trimmed).is_none()
}

fn split_apply_patch_text_lines(raw: &str) -> Vec<String> {
    let decoded = decode_escaped_newlines_if_needed(raw).replace("\r\n", "\n");
    let normalized = decoded.replace('\r', "\n");
    let mut parts: Vec<String> = normalized
        .split('\n')
        .map(|line| line.to_string())
        .collect();
    if parts.last().map(|line| line.is_empty()).unwrap_or(false) {
        parts.pop();
    }
    if parts.is_empty() {
        vec![String::new()]
    } else {
        parts
    }
}

fn normalize_apply_patch_path(raw: &str) -> Option<String> {
    let mut trimmed = raw.trim().to_string();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.contains('\n') || trimmed.contains('\r') {
        trimmed = trimmed
            .split(|ch| ch == '\n' || ch == '\r')
            .next()
            .unwrap_or("")
            .trim()
            .to_string();
    }
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.replace('\\', "/"))
}

fn read_apply_patch_stringish(value: Option<&Value>) -> Option<String> {
    let value = value?;
    match value {
        Value::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Value::Array(items) if items.len() == 1 => items
            .first()
            .and_then(|item| read_apply_patch_stringish(Some(item))),
        Value::Object(row) => {
            for key in ["path", "file", "filename", "filepath", "file_path"] {
                if let Some(found) = read_apply_patch_stringish(row.get(key)) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}

fn extract_apply_patch_change_file(
    change: &Map<String, Value>,
    top_level_file: Option<&str>,
) -> Option<String> {
    for key in ["file", "path", "filepath", "filename", "file_path"] {
        if let Some(found) = read_apply_patch_stringish(change.get(key)) {
            if let Some(normalized) = normalize_apply_patch_path(found.as_str()) {
                return Some(normalized);
            }
        }
    }
    top_level_file.and_then(normalize_apply_patch_path)
}

fn resolve_apply_patch_top_level_file(args: &Map<String, Value>) -> Option<String> {
    for key in ["file", "path", "filepath", "filename"] {
        if let Some(found) = read_apply_patch_stringish(args.get(key)) {
            if let Some(normalized) = normalize_apply_patch_path(found.as_str()) {
                return Some(normalized);
            }
        }
    }
    if let Some(target) = read_apply_patch_stringish(args.get("target")) {
        if args
            .get("changes")
            .and_then(Value::as_array)
            .map(|rows| !rows.is_empty())
            .unwrap_or(false)
        {
            if let Some(normalized) = normalize_apply_patch_path(target.as_str()) {
                if !normalized.contains('/') && !normalized.contains('.') {
                    return None;
                }
                return Some(normalized);
            }
        }
    }
    None
}

fn looks_like_patch_instructions(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .map(|raw| {
            let trimmed = raw.trim_start();
            trimmed.starts_with("*** ")
                || trimmed.starts_with("--- ")
                || trimmed.starts_with("+++ ")
        })
        .unwrap_or(false)
}

fn build_structured_apply_patch_from_record(args: &Map<String, Value>) -> Option<(String, bool)> {
    let changes = args.get("changes").and_then(Value::as_array)?;
    if changes.is_empty() {
        return None;
    }
    let top_level_file = resolve_apply_patch_top_level_file(args);
    let mut out: Vec<String> = vec!["*** Begin Patch".to_string()];
    let mut emitted = false;

    for (index, change_value) in changes.iter().enumerate() {
        let change = change_value.as_object()?;
        let kind = change
            .get("kind")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())?
            .to_ascii_lowercase();
        let file = extract_apply_patch_change_file(change, top_level_file.as_deref())?;

        match kind.as_str() {
            "create_file" => {
                let lines_source = change
                    .get("lines")
                    .or_else(|| change.get("text"))
                    .or_else(|| change.get("content"))
                    .or_else(|| change.get("body"))
                    .or_else(|| change.get("replacement"));
                let lines = match lines_source {
                    Some(Value::Array(items)) => items
                        .iter()
                        .map(|item| match item {
                            Value::String(raw) => raw.replace('\r', ""),
                            Value::Null => String::new(),
                            other => other.to_string(),
                        })
                        .collect::<Vec<String>>(),
                    Some(Value::String(raw)) => split_apply_patch_text_lines(raw),
                    Some(other) => vec![other.to_string()],
                    None => return None,
                };
                out.push(format!("*** Add File: {}", file));
                for line in lines {
                    out.push(format!("+{}", line));
                }
                emitted = true;
            }
            "delete_file" => {
                out.push(format!("*** Delete File: {}", file));
                emitted = true;
            }
            "replace" => {
                let target_source = change
                    .get("target")
                    .or_else(|| change.get("anchor"))
                    .or_else(|| change.get("context"))
                    .or_else(|| change.get("from"))
                    .or_else(|| change.get("old"))
                    .or_else(|| change.get("oldText"))
                    .or_else(|| change.get("old_text"))
                    .or_else(|| change.get("beforeText"))
                    .or_else(|| change.get("before_text"));
                let replacement_source = change
                    .get("lines")
                    .or_else(|| change.get("text"))
                    .or_else(|| change.get("content"))
                    .or_else(|| change.get("body"))
                    .or_else(|| change.get("replacement"))
                    .or_else(|| change.get("newText"))
                    .or_else(|| change.get("new_text"))
                    .or_else(|| change.get("afterText"))
                    .or_else(|| change.get("after_text"));
                let target = read_apply_patch_stringish(target_source)?;
                let replacements = match replacement_source {
                    Some(Value::Array(items)) => items
                        .iter()
                        .map(|item| match item {
                            Value::String(raw) => raw.replace('\r', ""),
                            Value::Null => String::new(),
                            other => other.to_string(),
                        })
                        .collect::<Vec<String>>(),
                    Some(Value::String(raw)) => split_apply_patch_text_lines(raw),
                    Some(other) => vec![other.to_string()],
                    None => return None,
                };
                out.push(format!("*** Update File: {}", file));
                for line in split_apply_patch_text_lines(target.as_str()) {
                    out.push(format!("-{}", line));
                }
                for line in replacements {
                    out.push(format!("+{}", line));
                }
                emitted = true;
            }
            "insert_after" | "insert_before" => {
                let anchor_source = change
                    .get("anchor")
                    .or_else(|| change.get("target"))
                    .or_else(|| change.get("context"))
                    .or_else(|| change.get("from"))
                    .or_else(|| change.get("old"))
                    .or_else(|| change.get("oldText"))
                    .or_else(|| change.get("old_text"))
                    .or_else(|| change.get("beforeText"))
                    .or_else(|| change.get("before_text"));
                let additions_source = change
                    .get("lines")
                    .or_else(|| change.get("text"))
                    .or_else(|| change.get("content"))
                    .or_else(|| change.get("body"))
                    .or_else(|| change.get("replacement"))
                    .or_else(|| change.get("newText"))
                    .or_else(|| change.get("new_text"))
                    .or_else(|| change.get("afterText"))
                    .or_else(|| change.get("after_text"));
                let anchor = read_apply_patch_stringish(anchor_source)?;
                let additions = match additions_source {
                    Some(Value::Array(items)) => items
                        .iter()
                        .map(|item| match item {
                            Value::String(raw) => raw.replace('\r', ""),
                            Value::Null => String::new(),
                            other => other.to_string(),
                        })
                        .collect::<Vec<String>>(),
                    Some(Value::String(raw)) => split_apply_patch_text_lines(raw),
                    Some(other) => vec![other.to_string()],
                    None => return None,
                };
                out.push(format!("*** Update File: {}", file));
                if kind == "insert_before" {
                    for line in additions.iter() {
                        out.push(format!("+{}", line));
                    }
                    for line in split_apply_patch_text_lines(anchor.as_str()) {
                        out.push(format!(" {}", line));
                    }
                } else {
                    for line in split_apply_patch_text_lines(anchor.as_str()) {
                        out.push(format!(" {}", line));
                    }
                    for line in additions.iter() {
                        out.push(format!("+{}", line));
                    }
                }
                emitted = true;
            }
            "delete" => {
                let target_source = change
                    .get("target")
                    .or_else(|| change.get("anchor"))
                    .or_else(|| change.get("context"))
                    .or_else(|| change.get("from"))
                    .or_else(|| change.get("old"))
                    .or_else(|| change.get("oldText"))
                    .or_else(|| change.get("old_text"))
                    .or_else(|| change.get("beforeText"))
                    .or_else(|| change.get("before_text"));
                let target = read_apply_patch_stringish(target_source)?;
                out.push(format!("*** Update File: {}", file));
                for line in split_apply_patch_text_lines(target.as_str()) {
                    out.push(format!("-{}", line));
                }
                emitted = true;
            }
            _ => {
                let _ = index;
                return None;
            }
        }
    }

    if !emitted {
        return None;
    }
    out.push("*** End Patch".to_string());
    Some((out.join("\n"), true))
}

fn read_structured_lines_source<'a>(change: &'a Map<String, Value>) -> Option<&'a Value> {
    change
        .get("lines")
        .or_else(|| change.get("text"))
        .or_else(|| change.get("content"))
        .or_else(|| change.get("body"))
        .or_else(|| change.get("replacement"))
        .or_else(|| change.get("newText"))
        .or_else(|| change.get("new_text"))
        .or_else(|| change.get("afterText"))
        .or_else(|| change.get("after_text"))
}

fn structured_lines_source_is_valid(value: Option<&Value>) -> bool {
    match value {
        Some(Value::String(raw)) => !raw.trim().is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Null) | None => false,
        Some(_) => true,
    }
}

fn structured_stringish_is_non_empty(value: Option<&Value>) -> bool {
    read_apply_patch_stringish(value)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

pub(crate) fn detect_structured_apply_patch_invalid_reason(
    args: &Map<String, Value>,
) -> Option<&'static str> {
    if args.is_empty() {
        return Some("invalid_json");
    }
    if args.contains_key("cmd") || args.contains_key("command") || args.contains_key("shell") {
        return None;
    }
    let has_structured_shape = args.contains_key("changes")
        || args.contains_key("instructions")
        || args.contains_key("file")
        || args.contains_key("path")
        || args.contains_key("filepath")
        || args.contains_key("filename")
        || args.contains_key("style")
        || args.contains_key("onClick");
    if !has_structured_shape {
        return None;
    }
    if args.contains_key("patch") || args.contains_key("input") {
        return None;
    }
    let Some(changes) = args.get("changes") else {
        if looks_like_patch_instructions(args.get("instructions")) {
            return Some("unsupported_patch_format");
        }
        return Some("missing_changes");
    };
    let Some(changes) = changes.as_array() else {
        return Some("missing_changes");
    };
    if changes.is_empty() {
        return Some("missing_changes");
    }

    let top_level_file = resolve_apply_patch_top_level_file(args);
    for change_value in changes {
        let Some(change) = change_value.as_object() else {
            return Some("invalid_change_sequence");
        };
        let Some(kind) = change
            .get("kind")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_ascii_lowercase)
        else {
            return Some("missing_field");
        };
        if args.contains_key("target") && !args.contains_key("file") {
            return Some("invalid_file");
        }
        let file = extract_apply_patch_change_file(change, top_level_file.as_deref());
        if file.is_none() {
            return Some("invalid_file");
        }
        match kind.as_str() {
            "create_file" => {
                if !structured_lines_source_is_valid(read_structured_lines_source(change)) {
                    return Some("invalid_lines");
                }
            }
            "replace" | "insert_after" | "insert_before" => {
                let has_anchor = structured_stringish_is_non_empty(
                    change
                        .get("target")
                        .or_else(|| change.get("anchor"))
                        .or_else(|| change.get("context"))
                        .or_else(|| change.get("from"))
                        .or_else(|| change.get("old"))
                        .or_else(|| change.get("oldText"))
                        .or_else(|| change.get("old_text"))
                        .or_else(|| change.get("beforeText"))
                        .or_else(|| change.get("before_text")),
                );
                if !has_anchor {
                    return Some("missing_field");
                }
                if !structured_lines_source_is_valid(read_structured_lines_source(change)) {
                    return Some("invalid_lines");
                }
            }
            "delete" => {
                let has_target = structured_stringish_is_non_empty(
                    change
                        .get("target")
                        .or_else(|| change.get("anchor"))
                        .or_else(|| change.get("context"))
                        .or_else(|| change.get("from"))
                        .or_else(|| change.get("old"))
                        .or_else(|| change.get("oldText"))
                        .or_else(|| change.get("old_text"))
                        .or_else(|| change.get("beforeText"))
                        .or_else(|| change.get("before_text")),
                );
                if !has_target {
                    return Some("missing_field");
                }
            }
            "delete_file" => {}
            _ => return Some("unsupported_patch_format"),
        }
    }
    None
}

pub(crate) fn normalize_apply_patch_text(raw: &str) -> String {
    let mut text = decode_escaped_newlines_if_needed(raw).replace("\r\n", "\n");
    text = strip_apply_patch_command_prefix(&text);
    text = trim_to_patch_window(&text);
    if text.is_empty() {
        return text;
    }
    text = text.trim().to_string();
    if text.is_empty() {
        return text;
    }

    text = text.replace("*** Create File:", "*** Add File:");

    // Some models emit single-line markers like:
    // "*** Begin Patch *** Create File: a.ts ... *** End Patch"
    text = text.replace(
        "*** Begin Patch *** Add File:",
        "*** Begin Patch\n*** Add File:",
    );
    text = text.replace(
        "*** Begin Patch *** Update File:",
        "*** Begin Patch\n*** Update File:",
    );
    text = text.replace(
        "*** Begin Patch *** Delete File:",
        "*** Begin Patch\n*** Delete File:",
    );
    text = text.replace(
        "*** Begin Patch *** Create File:",
        "*** Begin Patch\n*** Add File:",
    );
    text = text.replace("*** Add File:", "\n*** Add File:");
    text = text.replace("*** Update File:", "\n*** Update File:");
    text = text.replace("*** Delete File:", "\n*** Delete File:");
    text = text.replace("\n\n*** Add File:", "\n*** Add File:");
    text = text.replace("\n\n*** Update File:", "\n*** Update File:");
    text = text.replace("\n\n*** Delete File:", "\n*** Delete File:");

    if text.contains("*** Begin Patch") && text.contains("*** End Patch") && !text.contains('\n') {
        text = text.replace("*** Begin Patch", "*** Begin Patch\n");
        text = text.replace("*** End Patch", "\n*** End Patch");
    }

    let has_begin = text.contains("*** Begin Patch");
    let has_file_header = text.contains("*** Add File:")
        || text.contains("*** Update File:")
        || text.contains("*** Delete File:");
    let has_unified_header = has_unified_like_header(&text);
    if !has_begin && (has_file_header || has_unified_header) {
        text = format!("*** Begin Patch\n{}\n*** End Patch", text.trim());
    } else if has_begin && !text.contains("*** End Patch") {
        text = format!("{}\n*** End Patch", text.trim());
    }

    let mut out: Vec<String> = Vec::new();
    let mut in_add_section = false;
    let mut in_update_section = false;
    let mut pending_unified_from: Option<String> = None;
    for line in text.split('\n') {
        let raw_line = line.strip_suffix('\r').unwrap_or(line);
        let mut normalized = normalize_apply_patch_header_line(raw_line.trim());
        if raw_line.trim() == "***************" {
            continue;
        }
        if normalized.starts_with("*** a/") {
            normalized = format!("--- {}", normalized.trim_start_matches("*** ").trim());
        } else if normalized.starts_with("*** b/") {
            normalized = format!("+++ {}", normalized.trim_start_matches("*** ").trim());
        }

        if normalized.starts_with("--- ") {
            pending_unified_from = Some(normalized.trim_start_matches("--- ").trim().to_string());
            continue;
        }
        if normalized.starts_with("+++ ") {
            let plus_path = normalized.trim_start_matches("+++ ").trim().to_string();
            let minus_path = pending_unified_from.take();
            let plus_is_dev_null = plus_path == "/dev/null";
            let minus_is_dev_null = minus_path.as_deref() == Some("/dev/null");
            if minus_is_dev_null && !plus_is_dev_null {
                out.push(format!(
                    "*** Add File: {}",
                    normalize_unified_header_path(&plus_path)
                ));
                in_add_section = true;
                in_update_section = false;
                continue;
            }
            if plus_is_dev_null {
                if let Some(from_path) = minus_path {
                    out.push(format!(
                        "*** Delete File: {}",
                        normalize_unified_header_path(&from_path)
                    ));
                    in_add_section = false;
                    in_update_section = false;
                    continue;
                }
            }
            let update_path = if !plus_path.is_empty() {
                plus_path
            } else {
                minus_path.unwrap_or_default()
            };
            if !update_path.is_empty() {
                out.push(format!(
                    "*** Update File: {}",
                    normalize_unified_header_path(&update_path)
                ));
                in_add_section = false;
                in_update_section = true;
                continue;
            }
        }
        if normalized.starts_with("@@") {
            if let Some(from_path) = pending_unified_from.take() {
                if from_path != "/dev/null" && !from_path.is_empty() {
                    out.push(format!(
                        "*** Update File: {}",
                        normalize_unified_header_path(&from_path)
                    ));
                    in_add_section = false;
                    in_update_section = true;
                }
            }
        }

        if normalized.starts_with("*** Begin Patch") {
            out.push("*** Begin Patch".to_string());
            in_add_section = false;
            in_update_section = false;
            pending_unified_from = None;
            continue;
        }
        if normalized.starts_with("*** End Patch") {
            out.push("*** End Patch".to_string());
            in_add_section = false;
            in_update_section = false;
            pending_unified_from = None;
            continue;
        }
        if normalized.starts_with("*** Add File:") {
            out.push(normalized);
            in_add_section = true;
            in_update_section = false;
            pending_unified_from = None;
            continue;
        }
        if normalized.starts_with("*** Update File:") || normalized.starts_with("*** Delete File:")
        {
            let is_update = normalized.starts_with("*** Update File:");
            out.push(normalized);
            in_add_section = false;
            in_update_section = is_update;
            pending_unified_from = None;
            continue;
        }
        if in_add_section {
            if raw_line.trim_start().starts_with("@@") {
                continue;
            }
            if raw_line.starts_with('+') {
                out.push(raw_line.to_string());
            } else {
                out.push(format!("+{}", raw_line));
            }
            continue;
        }
        if in_update_section {
            let trimmed = raw_line.trim_start();
            if trimmed.starts_with("@@")
                || raw_line.starts_with('+')
                || raw_line.starts_with('-')
                || raw_line.starts_with(' ')
            {
                out.push(raw_line.to_string());
            }
            continue;
        }
        out.push(raw_line.to_string());
    }

    let normalized = repair_update_file_blocks_missing_hunk_header(out.join("\n").trim());
    repair_line_number_update_hunks_with_live_context(normalized.as_str())
        .trim()
        .to_string()
}

fn repair_update_file_blocks_missing_hunk_header(raw: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut in_update_block = false;
    let mut block_has_hunk = false;
    let mut inserted_hunk_for_block = false;

    for line in raw.split('\n') {
        let trimmed = line.trim();
        let is_file_header = trimmed.starts_with("*** Add File:")
            || trimmed.starts_with("*** Update File:")
            || trimmed.starts_with("*** Delete File:");
        let is_block_boundary =
            trimmed == "*** Begin Patch" || trimmed == "*** End Patch" || is_file_header;

        if is_block_boundary {
            in_update_block = trimmed.starts_with("*** Update File:");
            block_has_hunk = false;
            inserted_hunk_for_block = false;
            out.push(line.to_string());
            continue;
        }

        if in_update_block {
            if trimmed.starts_with("@@") {
                block_has_hunk = true;
                out.push(line.to_string());
                continue;
            }
            if !block_has_hunk
                && !inserted_hunk_for_block
                && (line.starts_with('+') || line.starts_with('-') || line.starts_with(' '))
            {
                out.push("@@".to_string());
                inserted_hunk_for_block = true;
            }
        }

        out.push(line.to_string());
    }

    out.join("\n")
}

pub(crate) fn normalize_apply_patch_schema_args(raw_args: Option<&Value>) -> (String, bool) {
    let Some(raw_args) = raw_args else {
        let mut out = Map::new();
        out.insert("patch".to_string(), Value::String(String::new()));
        return (
            serde_json::to_string(&Value::Object(out)).unwrap_or_else(|_| "{}".to_string()),
            true,
        );
    };
    let args = parse_json_record(Some(raw_args)).unwrap_or_default();
    if let Some(normalized) = build_current_apply_patch_schema_args(&args) {
        return normalized;
    }
    if let Some(normalized) = normalize_simple_line_edit_apply_patch_schema_args(&args) {
        match normalized {
            HashlineApplyPatchNormalization::Normalized(value) => return value,
            HashlineApplyPatchNormalization::Guarded { normalized, .. } => return normalized,
            HashlineApplyPatchNormalization::NotHashline => {}
        }
    }
    match normalize_hashline_apply_patch_schema_args(&args) {
        HashlineApplyPatchNormalization::Normalized(normalized) => return normalized,
        HashlineApplyPatchNormalization::Guarded { normalized, .. } => return normalized,
        HashlineApplyPatchNormalization::NotHashline => {}
    }
    if let Some((structured_patch, structured_repaired)) =
        build_structured_apply_patch_from_record(&args)
    {
        let patch = normalize_apply_patch_text(structured_patch.trim());
        let mut out = Map::new();
        out.insert("patch".to_string(), Value::String(patch));
        return (
            serde_json::to_string(&Value::Object(out)).unwrap_or_else(|_| "{}".to_string()),
            structured_repaired,
        );
    }
    let patch_source = read_apply_patch_source_from_args(&args).or_else(|| {
        extract_apply_patch_text(Some(raw_args))
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    });
    let Some(patch_source) = patch_source else {
        let mut out = Map::new();
        out.insert("patch".to_string(), Value::String(String::new()));
        return (
            serde_json::to_string(&Value::Object(out)).unwrap_or_else(|_| "{}".to_string()),
            true,
        );
    };
    let source_trimmed = patch_source.trim();
    let patch = normalize_apply_patch_text(source_trimmed);
    let repaired = patch.trim() != source_trimmed;
    let mut out = Map::new();
    out.insert("patch".to_string(), Value::String(patch));
    (
        serde_json::to_string(&Value::Object(out)).unwrap_or_else(|_| "{}".to_string()),
        repaired,
    )
}

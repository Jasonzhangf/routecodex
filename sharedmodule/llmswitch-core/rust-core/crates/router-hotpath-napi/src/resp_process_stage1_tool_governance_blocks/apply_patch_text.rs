use serde_json::{Map, Value};
use std::env;
use std::path::{Path, PathBuf};

use regex::Regex;

pub(crate) fn decode_escaped_newlines_if_needed(raw: &str) -> String {
    if raw.contains('\n') || !raw.contains("\\n") {
        return raw.to_string();
    }
    raw.replace("\\n", "\n")
}

fn find_first_patch_marker(raw: &str) -> Option<usize> {
    [
        "*** Begin Patch",
        "*** Add File:",
        "*** Update File:",
        "*** Delete File:",
    ]
    .iter()
    .filter_map(|marker| raw.find(marker))
    .min()
}

pub(crate) fn trim_to_patch_window(raw: &str) -> String {
    let trimmed = raw.trim();
    let Some(start) = find_first_patch_marker(trimmed) else {
        return trimmed.to_string();
    };
    let mut patch = trimmed[start..].trim().to_string();
    if let Some(end_rel) = patch.rfind("*** End Patch") {
        let end = end_rel + "*** End Patch".len();
        patch = patch[..end].trim().to_string();
    }
    patch
}

fn looks_like_patch_body_after_apply_patch_prefix(raw: &str) -> bool {
    let trimmed = raw.trim_start();
    [
        "*** Begin Patch",
        "*** Add File:",
        "*** Update File:",
        "*** Delete File:",
        "--- ",
        "+++ ",
        "*** a/",
        "*** b/",
        "diff --git ",
    ]
    .iter()
    .any(|marker| trimmed.starts_with(marker) || trimmed.contains(marker))
}

pub(crate) fn strip_apply_patch_command_prefix(raw: &str) -> String {
    let trimmed = raw.trim_start();
    let Some(rest) = trimmed.strip_prefix("apply_patch") else {
        return raw.to_string();
    };
    let stripped = rest.trim_start();
    if stripped.is_empty() || !looks_like_patch_body_after_apply_patch_prefix(stripped) {
        return raw.to_string();
    }
    stripped.to_string()
}

pub(crate) fn has_unified_like_header(text: &str) -> bool {
    text.lines().any(|line| {
        let trimmed = line.trim_start();
        trimmed.starts_with("--- ")
            || trimmed.starts_with("+++ ")
            || trimmed.starts_with("*** a/")
            || trimmed.starts_with("*** b/")
    })
}

fn looks_like_shell_wrapped_apply_patch(raw: &str) -> bool {
    let trimmed = raw.trim_start().to_ascii_lowercase();
    if trimmed.is_empty() {
        return false;
    }
    let starts_with_shell = trimmed.starts_with("bash ")
        || trimmed.starts_with("sh ")
        || trimmed.starts_with("zsh ")
        || trimmed.starts_with("env ")
        || trimmed.starts_with("command ");
    starts_with_shell && trimmed.contains("apply_patch <<")
}

fn extract_shell_wrapped_apply_patch_body(raw: &str) -> Option<String> {
    if !looks_like_shell_wrapped_apply_patch(raw) {
        return None;
    }
    let begin = raw.find("*** Begin Patch")?;
    let end_marker = "*** End Patch";
    let end = raw[begin..].find(end_marker)? + begin + end_marker.len();
    Some(raw[begin..end].to_string())
}

fn extract_apply_patch_text_from_object(row: &Map<String, Value>) -> Option<String> {
    row.get("patch")
        .and_then(|value| extract_apply_patch_text(Some(value)))
        .or_else(|| {
            row.get("input")
                .and_then(|value| extract_apply_patch_text(Some(value)))
        })
        .or_else(|| {
            row.get("instructions")
                .and_then(|value| extract_apply_patch_text(Some(value)))
        })
        .or_else(|| {
            row.get("arguments")
                .and_then(|value| extract_apply_patch_text(Some(value)))
        })
}

pub(crate) fn extract_apply_patch_text(raw_args: Option<&Value>) -> Option<String> {
    match raw_args {
        Some(Value::String(raw)) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return None;
            }
            if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
                return extract_apply_patch_text(Some(&parsed));
            }
            if let Some(patch) = extract_shell_wrapped_apply_patch_body(trimmed) {
                return Some(patch);
            }
            Some(strip_apply_patch_command_prefix(
                trim_to_patch_window(trimmed).as_str(),
            ))
        }
        Some(Value::Object(row)) => extract_apply_patch_text_from_object(row),
        Some(Value::Array(items)) => items
            .iter()
            .find_map(|value| extract_apply_patch_text(Some(value))),
        _ => None,
    }
}

pub(crate) fn normalize_apply_patch_header_path(raw: &str) -> String {
    let mut out = raw.trim().to_string();
    while out.ends_with(" ***") {
        out.truncate(out.len().saturating_sub(4));
        out = out.trim_end().to_string();
    }
    let bytes = out.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0] as char;
        let last = bytes[bytes.len() - 1] as char;
        let is_wrapped = (first == '"' && last == '"')
            || (first == '\'' && last == '\'')
            || (first == '`' && last == '`');
        if is_wrapped {
            out = out[1..out.len() - 1].trim().to_string();
        }
    }
    relativize_workspace_path(out.as_str())
}

pub(crate) fn normalize_apply_patch_header_line(line: &str) -> String {
    let add_re = Regex::new(r"^\*\*\* Add File:\s*(.+?)(?:\s+\*\*\*)?\s*$").unwrap();
    if let Some(caps) = add_re.captures(line) {
        if let Some(path) = caps.get(1) {
            return format!(
                "*** Add File: {}",
                normalize_apply_patch_header_path(path.as_str())
            );
        }
    }
    let update_re = Regex::new(r"^\*\*\* Update File:\s*(.+?)(?:\s+\*\*\*)?\s*$").unwrap();
    if let Some(caps) = update_re.captures(line) {
        if let Some(path) = caps.get(1) {
            return format!(
                "*** Update File: {}",
                normalize_apply_patch_header_path(path.as_str())
            );
        }
    }
    let delete_re = Regex::new(r"^\*\*\* Delete File:\s*(.+?)(?:\s+\*\*\*)?\s*$").unwrap();
    if let Some(caps) = delete_re.captures(line) {
        if let Some(path) = caps.get(1) {
            return format!(
                "*** Delete File: {}",
                normalize_apply_patch_header_path(path.as_str())
            );
        }
    }
    line.to_string()
}

pub(crate) fn normalize_unified_header_path(raw: &str) -> String {
    let normalized = normalize_apply_patch_header_path(raw);
    if let Some(stripped) = normalized.strip_prefix("a/") {
        return stripped.to_string();
    }
    if let Some(stripped) = normalized.strip_prefix("b/") {
        return stripped.to_string();
    }
    normalized
}

pub(crate) fn current_workspace_root() -> Option<PathBuf> {
    env::current_dir().ok()
}

pub(crate) fn relativize_workspace_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let candidate = Path::new(trimmed);
    if !candidate.is_absolute() {
        return trimmed.replace('\\', "/");
    }
    let Some(root) = current_workspace_root() else {
        return trimmed.replace('\\', "/");
    };
    let Ok(relative) = candidate.strip_prefix(root.as_path()) else {
        return trimmed.replace('\\', "/");
    };
    let text = relative.to_string_lossy().replace('\\', "/");
    if text.trim().is_empty() {
        ".".to_string()
    } else {
        text
    }
}

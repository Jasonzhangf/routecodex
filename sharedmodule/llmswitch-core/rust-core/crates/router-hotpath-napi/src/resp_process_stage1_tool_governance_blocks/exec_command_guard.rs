use crate::shared_json_utils::read_workdir_from_args;
use regex::Regex;
use serde_json::{Map, Value};

const EXEC_COMMAND_HEREDOC_BLOCK_THRESHOLD: usize = 4096;
const EXEC_COMMAND_HEREDOC_PREVIEW_CHARS: usize = 240;

pub(crate) fn truncate_preview(raw: &str, max_chars: usize) -> String {
    let mut out = String::new();
    let mut count = 0usize;
    for ch in raw.chars() {
        if count >= max_chars {
            out.push('…');
            break;
        }
        out.push(ch);
        count += 1;
    }
    out
}

fn shell_single_quote(raw: &str) -> String {
    format!("'{}'", raw.replace('\'', "'\"'\"'"))
}

fn extract_exec_command_preview_from_malformed_args(raw: &str) -> String {
    let lowered = raw.to_ascii_lowercase();
    let key = if lowered.contains("\"cmd\"") {
        "\"cmd\""
    } else if lowered.contains("\"command\"") {
        "\"command\""
    } else {
        ""
    };
    if key.is_empty() {
        return truncate_preview(raw.trim(), EXEC_COMMAND_HEREDOC_PREVIEW_CHARS);
    }
    let Some(idx) = raw.find(key) else {
        return truncate_preview(raw.trim(), EXEC_COMMAND_HEREDOC_PREVIEW_CHARS);
    };
    truncate_preview(raw[idx..].trim(), EXEC_COMMAND_HEREDOC_PREVIEW_CHARS)
}

pub(crate) fn is_large_heredoc_file_generation_command(cmd: &str) -> bool {
    if cmd.len() < EXEC_COMMAND_HEREDOC_BLOCK_THRESHOLD {
        return false;
    }
    Regex::new(r#"(?is)\bcat\s*>\s*\S+\s*<<\s*['"]?[A-Za-z0-9_:-]+['"]?"#)
        .map(|re| re.is_match(cmd))
        .unwrap_or(false)
}

pub(crate) fn build_exec_command_large_write_guard_command(preview: &str) -> String {
    let message = format!(
        "[routecodex] exec_command blocked: large heredoc file generation was truncated before execution. \
Use apply_patch for file creation or updates instead of cat <<EOF / bulk shell writes. \
Adjust and retry with apply_patch. Command preview: {}",
        preview
    );
    format!(
        "printf '%s\\n' {} >&2; exit 64",
        shell_single_quote(message.as_str())
    )
}

pub(crate) fn build_exec_command_object_with_shape(
    cmd: String,
    args: Option<&Map<String, Value>>,
    source_is_shell_alias: bool,
    force_cmd: Option<bool>,
    force_command: Option<bool>,
    args_contain_direct_or_nested_key: impl Fn(&Map<String, Value>, &str) -> bool,
) -> Option<String> {
    let empty = Map::new();
    let args = args.unwrap_or(&empty);
    let mut out = Map::new();
    let has_cmd = force_cmd.unwrap_or_else(|| args_contain_direct_or_nested_key(args, "cmd"));
    let has_command =
        force_command.unwrap_or_else(|| args_contain_direct_or_nested_key(args, "command"));
    let emit_cmd = has_cmd || (!has_command && !source_is_shell_alias);
    let emit_command = has_command || (source_is_shell_alias && !has_cmd);
    if emit_command {
        out.insert("command".to_string(), Value::String(cmd.clone()));
    }
    if emit_cmd {
        out.insert("cmd".to_string(), Value::String(cmd));
    }
    if let Some(workdir) = read_workdir_from_args(args) {
        out.insert("workdir".to_string(), Value::String(workdir));
    }
    serde_json::to_string(&Value::Object(out)).ok()
}

pub(crate) fn maybe_guard_large_exec_command_from_raw_string(
    raw_args: Option<&Value>,
    source_is_shell_alias: bool,
    build_exec_command_object: impl Fn(String, Option<bool>, Option<bool>) -> Option<String>,
) -> Option<String> {
    let raw = match raw_args {
        Some(Value::String(raw)) => raw.trim(),
        _ => return None,
    };
    if raw.is_empty() {
        return None;
    }
    let lowered = raw.to_ascii_lowercase();
    if raw.len() < EXEC_COMMAND_HEREDOC_BLOCK_THRESHOLD
        || !lowered.contains("cat >")
        || !lowered.contains("<<")
        || (!lowered.contains("\"cmd\"") && !lowered.contains("\"command\""))
    {
        return None;
    }
    let preview = extract_exec_command_preview_from_malformed_args(raw);
    let guard = build_exec_command_large_write_guard_command(preview.as_str());
    let has_cmd = lowered.contains("\"cmd\"");
    let has_command = lowered.contains("\"command\"");
    let _ = source_is_shell_alias;
    build_exec_command_object(guard, Some(has_cmd), Some(has_command))
}

pub(crate) fn exec_command_heredoc_preview_chars() -> usize {
    EXEC_COMMAND_HEREDOC_PREVIEW_CHARS
}

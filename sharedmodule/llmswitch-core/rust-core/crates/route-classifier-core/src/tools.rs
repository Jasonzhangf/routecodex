use serde_json::Value;

use crate::shell::classify_shell_command;

const THINKING_TOOL_EXACT: &[&str] = &[
    "update_plan",
    "read",
    "read_file",
    "read_text",
    "view_file",
    "view_code",
    "view_document",
    "open_file",
    "get_file",
    "download_file",
    "describe_current_request",
];
const WRITE_TOOL_EXACT: &[&str] = &[
    "edit",
    "write",
    "multiedit",
    "apply_patch",
    "write_file",
    "create_file",
    "modify_file",
    "edit_file",
    "update_file",
    "save_file",
    "append_file",
    "replace_file",
];
const SEARCH_TOOL_EXACT: &[&str] = &[
    "search_files",
    "find_files",
    "search_documents",
    "search_repo",
    "glob_search",
    "grep_files",
    "code_search",
    "lookup_symbol",
    "list_files",
    "list_directory",
    "list_dir",
];
const THINKING_TOOL_KEYWORDS: &[&str] = &[
    "read", "view", "download", "open", "show", "fetch", "inspect", "plan",
];
const SEARCH_TOOL_KEYWORDS: &[&str] = &["find", "grep", "glob", "lookup", "locate"];
const WEB_TOOL_KEYWORDS: &[&str] = &[
    "websearch",
    "web_search",
    "web-search",
    "webfetch",
    "web_fetch",
    "web_request",
    "search_web",
    "internet_search",
];
const SHELL_TOOL_NAMES: &[&str] = &["shell_command", "shell", "bash", "exec_command"];
pub(crate) const SHELL_THINKING_COMMANDS: &[&str] =
    &["cat", "head", "tail", "strings", "less", "more", "nl"];
pub(crate) const SHELL_TOOLS_COMMANDS: &[&str] = &[
    "npm", "npx", "yarn", "bun", "pnpm", "cargo", "go", "pytest", "maven", "gradle", "tsc",
    "eslint", "prettier", "make", "cmake",
];
pub(crate) const SHELL_SEARCH_COMMANDS: &[&str] = &[
    "rg",
    "ripgrep",
    "grep",
    "egrep",
    "fgrep",
    "ag",
    "ack",
    "find",
    "fd",
    "locate",
    "codesearch",
    "ls",
    "tree",
    "pwd",
];
pub(crate) const SHELL_WRITE_COMMANDS: &[&str] =
    &["apply_patch", "tee", "touch", "truncate", "patch"];
pub(crate) const SHELL_REDIRECT_WRITE_BINARIES: &[&str] = &[
    "cat", "printf", "python", "node", "perl", "ruby", "php", "bash", "sh", "zsh", "echo",
];
pub(crate) const SHELL_WRAPPER_COMMANDS: &[&str] =
    &["sudo", "env", "time", "nice", "nohup", "command", "stdbuf"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteToolCallClassification {
    pub category: String,
    pub name: String,
    pub snippet: Option<String>,
}

pub fn classify_tool_call(
    raw_name: &str,
    raw_arguments: Option<&Value>,
) -> Option<RouteToolCallClassification> {
    let raw_name = raw_name.trim();
    if raw_name.is_empty() || !looks_like_valid_tool_name_for_routing(raw_name) {
        return None;
    }
    let function_name = canonicalize_tool_name(raw_name).to_lowercase();
    if should_skip_malformed_tool_call_for_routing(function_name.as_str(), raw_arguments) {
        return None;
    }
    let args = parse_tool_arguments(raw_arguments);
    let command_text = extract_command_text(args.as_ref());
    let name_category = categorize_tool_name(&function_name);
    let shell_category = if SHELL_TOOL_NAMES.iter().any(|item| *item == function_name) {
        classify_shell_command(&command_text)
    } else {
        "other".to_string()
    };
    let category = if WEB_TOOL_KEYWORDS
        .iter()
        .any(|keyword| function_name.contains(keyword))
    {
        "websearch".to_string()
    } else if name_category == "coding" || shell_category == "coding" {
        "coding".to_string()
    } else if name_category == "thinking" || shell_category == "thinking" {
        "thinking".to_string()
    } else if name_category == "search" || shell_category == "search" {
        "search".to_string()
    } else {
        "other".to_string()
    };
    Some(RouteToolCallClassification {
        category,
        name: function_name,
        snippet: build_command_snippet(&command_text),
    })
}

pub fn has_web_search_intent(text: &str) -> bool {
    let normalized = text.to_lowercase();
    const STRICT_TERMS: &[&str] = &[
        "search the web",
        "web search",
        "browse the web",
        "search online",
        "look it up",
        "with sources",
        "联网搜索",
        "上网搜索",
        "上网搜",
        "网页搜索",
        "请搜索",
        "引用来源",
    ];
    STRICT_TERMS.iter().any(|term| normalized.contains(term))
}

fn looks_like_valid_tool_name_for_routing(raw_name: &str) -> bool {
    let trimmed = raw_name.trim();
    if trimmed.is_empty() {
        return false;
    }
    !trimmed.chars().any(|ch| {
        ch.is_whitespace()
            || matches!(
                ch,
                '"' | '\'' | '`' | '|' | '&' | ';' | '<' | '>' | '(' | ')' | '{' | '}' | '[' | ']'
            )
    })
}

fn should_skip_malformed_tool_call_for_routing(
    function_name: &str,
    raw_arguments: Option<&Value>,
) -> bool {
    let normalized = function_name.trim().to_lowercase();
    if normalized.is_empty() {
        return true;
    }
    if normalized == "apply_patch" {
        return !looks_like_valid_apply_patch_arguments_for_routing(raw_arguments);
    }
    if normalized == "write_stdin" {
        return !looks_like_valid_write_stdin_arguments_for_routing(raw_arguments);
    }
    if SHELL_TOOL_NAMES.iter().any(|item| *item == normalized) {
        return !looks_like_valid_shell_like_arguments_for_routing(raw_arguments);
    }
    false
}

fn looks_like_valid_apply_patch_arguments_for_routing(raw_arguments: Option<&Value>) -> bool {
    let Some(value) = raw_arguments else {
        return false;
    };
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return false;
            }
            if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
                return looks_like_valid_apply_patch_arguments_for_routing(Some(&parsed));
            }
            trimmed.contains("*** Begin Patch")
                || trimmed.contains("*** Update File:")
                || trimmed.contains("*** Add File:")
                || trimmed.contains("*** Delete File:")
        }
        Value::Object(map) => {
            let patch = map
                .get("patch")
                .and_then(Value::as_str)
                .or_else(|| map.get("input").and_then(Value::as_str))
                .unwrap_or("")
                .trim();
            !patch.is_empty()
                && (patch.contains("*** Begin Patch")
                    || patch.contains("*** Update File:")
                    || patch.contains("*** Add File:")
                    || patch.contains("*** Delete File:"))
        }
        _ => false,
    }
}

fn looks_like_valid_write_stdin_arguments_for_routing(raw_arguments: Option<&Value>) -> bool {
    let Some(value) = raw_arguments else {
        return false;
    };
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return false;
            }
            if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
                return looks_like_valid_write_stdin_arguments_for_routing(Some(&parsed));
            }
            false
        }
        Value::Object(map) => {
            let has_session = map.get("session_id").and_then(Value::as_i64).is_some()
                || map.get("sessionId").and_then(Value::as_i64).is_some();
            let chars = map
                .get("chars")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            has_session && !chars.is_empty()
        }
        _ => false,
    }
}

fn looks_like_valid_shell_like_arguments_for_routing(raw_arguments: Option<&Value>) -> bool {
    let Some(value) = raw_arguments else {
        return false;
    };
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return false;
            }
            if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
                return looks_like_valid_shell_like_arguments_for_routing(Some(&parsed));
            }
            !trimmed.starts_with('{')
                && !trimmed.starts_with('[')
                && trimmed.split_whitespace().next().is_some()
        }
        Value::Object(map) => {
            if let Some(cmd) = map.get("cmd").and_then(Value::as_str) {
                return !cmd.trim().is_empty();
            }
            if let Some(command) = map.get("command") {
                if let Some(text) = command.as_str() {
                    return !text.trim().is_empty();
                }
                if let Some(items) = command.as_array() {
                    return items
                        .iter()
                        .any(|item| item.as_str().is_some_and(|text| !text.trim().is_empty()));
                }
            }
            false
        }
        _ => false,
    }
}

fn canonicalize_tool_name(raw_name: &str) -> String {
    let trimmed = raw_name.trim();
    if let Some(marker_index) = trimmed.find("arg_") {
        if marker_index > 0 {
            return trimmed[..marker_index].to_string();
        }
    }
    trimmed.to_string()
}

fn parse_tool_arguments(raw_arguments: Option<&Value>) -> Option<Value> {
    let raw = raw_arguments?;
    if let Some(text) = raw.as_str() {
        if let Ok(parsed) = serde_json::from_str::<Value>(text) {
            return Some(parsed);
        }
        return Some(Value::String(text.to_string()));
    }
    Some(raw.clone())
}

fn extract_command_text(args: Option<&Value>) -> String {
    let Some(value) = args else {
        return String::new();
    };
    if let Some(text) = value.as_str() {
        return text.to_string();
    }
    if let Some(items) = value.as_array() {
        return items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect::<Vec<_>>()
            .join(" ");
    }
    let Some(record) = value.as_object() else {
        return String::new();
    };
    for key in [
        "command", "cmd", "input", "code", "script", "text", "prompt",
    ] {
        if let Some(text) = record.get(key).and_then(Value::as_str) {
            if !text.trim().is_empty() {
                return text.to_string();
            }
        }
        if let Some(items) = record.get(key).and_then(Value::as_array) {
            let joined = items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect::<Vec<_>>()
                .join(" ");
            if !joined.trim().is_empty() {
                return joined;
            }
        }
    }
    if let Some(text) = record.get("args").and_then(Value::as_str) {
        return text.to_string();
    }
    if let Some(items) = record.get("args").and_then(Value::as_array) {
        return items
            .iter()
            .filter_map(|item| item.as_str().map(str::to_string))
            .collect::<Vec<_>>()
            .join(" ");
    }
    String::new()
}

fn build_command_snippet(command_text: &str) -> Option<String> {
    let collapsed = command_text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let trimmed = collapsed.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().count() <= 80 {
        return Some(trimmed.to_string());
    }
    Some(trimmed.chars().take(80).collect::<String>() + "…")
}

fn categorize_tool_name(name: &str) -> String {
    let normalized = name.to_lowercase();
    if SEARCH_TOOL_EXACT.iter().any(|item| *item == normalized)
        || SEARCH_TOOL_KEYWORDS
            .iter()
            .any(|keyword| normalized.contains(keyword))
        || normalized == "list"
        || normalized.starts_with("list_")
        || normalized.starts_with("list-")
    {
        return "search".to_string();
    }
    if THINKING_TOOL_EXACT.iter().any(|item| *item == normalized)
        || THINKING_TOOL_KEYWORDS
            .iter()
            .any(|keyword| normalized.contains(keyword))
    {
        return "thinking".to_string();
    }
    if WRITE_TOOL_EXACT.iter().any(|item| *item == normalized) {
        return "coding".to_string();
    }
    "other".to_string()
}

use serde_json::Value;

#[derive(Debug, Clone)]
pub(super) struct ToolClassification {
    pub category: String,
    pub name: String,
    pub snippet: Option<String>,
    pub label: Option<String>,
}

fn tool_category_priority(category: &str) -> i32 {
    match category {
        "websearch" => 4,
        "coding" => 3,
        "search" => 2,
        "thinking" => 1,
        _ => 0,
    }
}

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
const WRITE_TOOL_KEYWORDS: &[&str] = &[
    "write", "patch", "modify", "edit", "create", "update", "append", "replace", "save",
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
const SHELL_THINKING_COMMANDS: &[&str] = &["cat", "head", "tail", "strings", "less", "more", "nl"];
const SHELL_SEARCH_COMMANDS: &[&str] = &[
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
];
const SHELL_WRITE_COMMANDS: &[&str] = &["apply_patch", "tee", "touch", "truncate", "patch"];
const SHELL_REDIRECT_WRITE_BINARIES: &[&str] = &[
    "cat", "printf", "python", "node", "perl", "ruby", "php", "bash", "sh", "zsh", "echo",
];
const SHELL_WRAPPER_COMMANDS: &[&str] =
    &["sudo", "env", "time", "nice", "nohup", "command", "stdbuf"];

fn extract_tool_name(tool: &Value) -> String {
    if let Some(name) = tool
        .get("function")
        .and_then(|v| v.get("name"))
        .and_then(|v| v.as_str())
    {
        return name.to_string();
    }
    if let Some(name) = tool.get("name").and_then(|v| v.as_str()) {
        return name.to_string();
    }
    "".to_string()
}

fn extract_tool_description(tool: &Value) -> String {
    if let Some(desc) = tool
        .get("function")
        .and_then(|v| v.get("description"))
        .and_then(|v| v.as_str())
    {
        return desc.to_string();
    }
    if let Some(desc) = tool.get("description").and_then(|v| v.as_str()) {
        return desc.to_string();
    }
    "".to_string()
}

pub(super) fn detect_vision_tool(tools: Option<&Value>) -> bool {
    let tools = match tools.and_then(|v| v.as_array()) {
        Some(list) => list,
        None => return false,
    };
    tools.iter().any(|tool| {
        let name = extract_tool_name(tool);
        let desc = extract_tool_description(tool);
        let name_lower = name.to_lowercase();
        let desc_lower = desc.to_lowercase();
        name_lower.contains("vision")
            || name_lower.contains("image")
            || name_lower.contains("picture")
            || name_lower.contains("photo")
            || desc_lower.contains("vision")
            || desc_lower.contains("image")
            || desc_lower.contains("picture")
            || desc_lower.contains("photo")
    })
}

pub(super) fn detect_coding_tool(tools: Option<&Value>) -> bool {
    let tools = match tools.and_then(|v| v.as_array()) {
        Some(list) => list,
        None => return false,
    };
    let write_keywords = [
        "write", "patch", "modify", "edit", "create", "update", "append", "replace", "save",
    ];
    let write_exact = [
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
    tools.iter().any(|tool| {
        let name = extract_tool_name(tool).to_lowercase();
        let desc = extract_tool_description(tool).to_lowercase();
        if name.is_empty() && desc.is_empty() {
            return false;
        }
        if write_exact.iter().any(|item| *item == name) || name == "exec_command" {
            return true;
        }
        write_keywords
            .iter()
            .any(|keyword| name.contains(keyword) || desc.contains(keyword))
    })
}

pub(super) fn detect_web_tool(tools: Option<&Value>) -> bool {
    let tools = match tools.and_then(|v| v.as_array()) {
        Some(list) => list,
        None => return false,
    };
    let web_tool_keywords = [
        "websearch",
        "web_search",
        "web-search",
        "webfetch",
        "web_fetch",
        "web_request",
        "search_web",
        "internet_search",
    ];
    tools.iter().any(|tool| {
        let name = extract_tool_name(tool).to_lowercase();
        let desc = extract_tool_description(tool).to_lowercase();
        web_tool_keywords
            .iter()
            .any(|keyword| name.contains(keyword) || desc.contains(keyword))
    })
}

pub(super) fn detect_web_search_tool_declared(tools: Option<&Value>) -> bool {
    let tools = match tools.and_then(|v| v.as_array()) {
        Some(list) => list,
        None => return false,
    };
    tools.iter().any(|tool| {
        // Match by tool type (OpenAI Responses style)
        let raw_type = tool
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_lowercase();
        if raw_type == "web_search_preview" || raw_type == "websearch_preview" {
            return true;
        }
        // Bridge injects {type: "web_search"} after stripping server-side web_search function
        if raw_type == "web_search" || raw_type == "websearch" || raw_type.starts_with("web_search")
        {
            return true;
        }
        // Match by function name (Chat Completions style)
        let name = extract_tool_name(tool);
        let normalized = name.to_lowercase().replace(['-', '_'], "");
        normalized == "websearch" || normalized == "websearchpreview"
    })
}

pub(super) fn extract_meaningful_declared_tool_names(tools: Option<&Value>) -> Vec<String> {
    let tools = match tools.and_then(|v| v.as_array()) {
        Some(list) => list,
        None => return Vec::new(),
    };
    tools
        .iter()
        .filter_map(|tool| {
            let name = extract_tool_name(tool);
            if name.is_empty() {
                return None;
            }
            Some(name)
        })
        .collect()
}

pub(super) fn detect_last_assistant_tool_category(
    messages: &[Value],
) -> Option<ToolClassification> {
    for msg in messages.iter().rev() {
        let tool_calls = match msg.get("tool_calls").and_then(|v| v.as_array()) {
            Some(list) if !list.is_empty() => list,
            _ => continue,
        };
        for call in tool_calls.iter().rev() {
            if let Some(classification) = classify_tool_call(call) {
                return Some(classification);
            }
        }
    }
    None
}

pub(super) fn classify_tool_call_for_report(call: &Value) -> Option<ToolClassification> {
    classify_tool_call(call)
}

pub(super) fn choose_higher_priority_tool_category(
    current: Option<ToolClassification>,
    candidate: Option<ToolClassification>,
) -> Option<ToolClassification> {
    match (current, candidate) {
        (None, None) => None,
        (Some(existing), None) => Some(existing),
        (None, Some(next)) => Some(next),
        (Some(existing), Some(next)) => {
            if tool_category_priority(next.category.as_str())
                > tool_category_priority(existing.category.as_str())
            {
                Some(next)
            } else {
                Some(existing)
            }
        }
    }
}

fn classify_tool_call(call: &Value) -> Option<ToolClassification> {
    let raw_name = call
        .get("function")
        .and_then(|v| v.get("name"))
        .and_then(|v| v.as_str())
        .or_else(|| call.get("name").and_then(|v| v.as_str()))?
        .trim();
    if raw_name.is_empty() {
        return None;
    }
    if !looks_like_valid_tool_name_for_routing(raw_name) {
        return None;
    }
    let function_name = canonicalize_tool_name(raw_name).to_lowercase();
    let raw_arguments = call
        .get("function")
        .and_then(|v| v.get("arguments"))
        .or_else(|| call.get("arguments"));
    if should_skip_malformed_tool_call_for_routing(function_name.as_str(), raw_arguments) {
        return None;
    }
    let args = parse_tool_arguments(raw_arguments);
    let command_text = extract_command_text(args.as_ref());
    let snippet = build_command_snippet(&command_text);
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

    Some(ToolClassification {
        category,
        name: function_name.clone(),
        snippet: snippet.clone(),
        label: snippet.or(Some(function_name)),
    })
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
                .and_then(|v| v.as_str())
                .or_else(|| map.get("input").and_then(|v| v.as_str()))
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
            let has_session = map.get("session_id").and_then(|v| v.as_i64()).is_some()
                || map.get("sessionId").and_then(|v| v.as_i64()).is_some();
            let chars = map
                .get("chars")
                .and_then(|v| v.as_str())
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
            if let Some(cmd) = map.get("cmd").and_then(|v| v.as_str()) {
                return !cmd.trim().is_empty();
            }
            if let Some(command) = map.get("command") {
                if let Some(text) = command.as_str() {
                    return !text.trim().is_empty();
                }
                if let Some(items) = command.as_array() {
                    return items.iter().any(|item| {
                        item.as_str()
                            .map(|text| !text.trim().is_empty())
                            .unwrap_or(false)
                    });
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
    if let Some(arr) = value.as_array() {
        return arr
            .iter()
            .filter_map(|item| item.as_str().map(|text| text.to_string()))
            .collect::<Vec<String>>()
            .join(" ");
    }
    let Some(record) = value.as_object() else {
        return String::new();
    };
    for key in [
        "command", "cmd", "input", "code", "script", "text", "prompt",
    ] {
        if let Some(text) = record.get(key).and_then(|v| v.as_str()) {
            if !text.trim().is_empty() {
                return text.to_string();
            }
        }
        if let Some(arr) = record.get(key).and_then(|v| v.as_array()) {
            let joined = arr
                .iter()
                .filter_map(|item| item.as_str().map(|text| text.to_string()))
                .collect::<Vec<String>>()
                .join(" ");
            if !joined.trim().is_empty() {
                return joined;
            }
        }
    }
    if let Some(text) = record.get("args").and_then(|v| v.as_str()) {
        return text.to_string();
    }
    if let Some(arr) = record.get("args").and_then(|v| v.as_array()) {
        return arr
            .iter()
            .filter_map(|item| item.as_str().map(|text| text.to_string()))
            .collect::<Vec<String>>()
            .join(" ");
    }
    String::new()
}

fn build_command_snippet(command_text: &str) -> Option<String> {
    let collapsed = command_text
        .split_whitespace()
        .collect::<Vec<&str>>()
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
    String::from("other")
}

fn classify_shell_command(command: &str) -> String {
    let normalized = strip_shell_wrapper(command).to_lowercase();
    if normalized.trim().is_empty() {
        return "other".to_string();
    }
    if normalized.contains("<<") && shell_heredoc_looks_like_write(&normalized) {
        return "coding".to_string();
    }
    if SHELL_WRITE_COMMANDS
        .iter()
        .any(|cmd| contains_command(&normalized, cmd))
    {
        return "coding".to_string();
    }
    if shell_sed_looks_like_write(&normalized) {
        return "coding".to_string();
    }
    if shell_awk_looks_like_write(&normalized) {
        return "coding".to_string();
    }
    if contains_command(&normalized, "perl") && normalized.contains("-pi") {
        return "coding".to_string();
    }
    if contains_command(&normalized, "replace") {
        return "coding".to_string();
    }
    if SHELL_REDIRECT_WRITE_BINARIES
        .iter()
        .any(|cmd| contains_command(&normalized, cmd))
        && has_output_redirect(&normalized)
    {
        return "coding".to_string();
    }
    if SHELL_SEARCH_COMMANDS
        .iter()
        .any(|cmd| contains_command(&normalized, cmd))
    {
        return "search".to_string();
    }
    if contains_command(&normalized, "git")
        && [" grep", " log", " shortlog", " reflog", " blame"]
            .iter()
            .any(|sub| normalized.contains(sub))
    {
        return "search".to_string();
    }
    if contains_command(&normalized, "bd") && normalized.contains(" search") {
        return "search".to_string();
    }
    if contains_command(&normalized, "sed") || contains_command(&normalized, "awk") {
        return "thinking".to_string();
    }
    if shell_script_looks_like_read(&normalized) {
        return "thinking".to_string();
    }
    if SHELL_THINKING_COMMANDS
        .iter()
        .any(|cmd| contains_command(&normalized, cmd))
    {
        return "thinking".to_string();
    }
    if contains_command(&normalized, "update_plan") {
        return "thinking".to_string();
    }
    "other".to_string()
}

fn strip_shell_wrapper(command: &str) -> String {
    let trimmed = command.trim();
    for wrapper in ["bash -lc", "sh -c", "zsh -c"] {
        if let Some(rest) = trimmed.strip_prefix(wrapper) {
            return rest.trim().trim_matches('\'').trim_matches('"').to_string();
        }
    }
    let mut tokens = trimmed.split_whitespace();
    let mut cleaned: Vec<String> = Vec::new();
    while let Some(token) = tokens.next() {
        if cleaned.is_empty() {
            if token.contains('=') && !token.starts_with("./") && !token.starts_with('/') {
                continue;
            }
            if SHELL_WRAPPER_COMMANDS.iter().any(|item| *item == token) {
                continue;
            }
        }
        cleaned.push(token.to_string());
    }
    cleaned.join(" ")
}

fn contains_command(command: &str, target: &str) -> bool {
    command
        .split(|ch: char| {
            ch.is_whitespace() || ch == '|' || ch == ';' || ch == '&' || ch == '\n' || ch == '\r'
        })
        .filter(|token| !token.is_empty())
        .map(normalize_binary_name)
        .any(|token| token == target)
}

fn normalize_binary_name(binary: &str) -> String {
    let lowered = binary.to_lowercase();
    let token = lowered.rsplit('/').next().unwrap_or(&lowered);
    match token {
        "python3" => "python".to_string(),
        "pip3" => "pip".to_string(),
        "ripgrep" => "rg".to_string(),
        "perl5" => "perl".to_string(),
        other => other.to_string(),
    }
}

fn has_output_redirect(command: &str) -> bool {
    let bytes = command.as_bytes();
    let mut in_single = false;
    let mut in_double = false;
    let mut escaped = false;
    for idx in 0..bytes.len() {
        let ch = bytes[idx] as char;
        if in_single {
            if ch == '\'' {
                in_single = false;
            }
            continue;
        }
        if in_double {
            if escaped {
                escaped = false;
                continue;
            }
            if ch == '\\' {
                escaped = true;
                continue;
            }
            if ch == '"' {
                in_double = false;
            }
            continue;
        }
        if ch == '\'' {
            in_single = true;
            continue;
        }
        if ch == '"' {
            in_double = true;
            continue;
        }
        if ch != '>' {
            continue;
        }
        if idx > 0 && bytes[idx - 1] == b'=' {
            continue;
        }
        if idx + 1 < bytes.len() && bytes[idx + 1] == b'=' {
            continue;
        }
        if idx > 0 && bytes[idx - 1] == b'2' {
            continue;
        }
        return true;
    }
    false
}

fn shell_heredoc_looks_like_write(command: &str) -> bool {
    if !command.contains("<<") {
        return false;
    }
    if contains_command(command, "apply_patch") {
        return true;
    }
    if SHELL_REDIRECT_WRITE_BINARIES
        .iter()
        .any(|cmd| contains_command(command, cmd))
        && has_output_redirect(command)
    {
        return true;
    }
    command.contains("write_text(")
        || command.contains(".write_text(")
        || command.contains(".write(")
        || command.contains("fs.writefile")
        || command.contains("appendfile")
        || command.contains("open(") && command.contains("'w'")
        || command.contains("open(") && command.contains("\"w\"")
}

fn shell_sed_looks_like_write(command: &str) -> bool {
    contains_command(command, "sed")
        && (command.contains(" -i")
            || command.starts_with("sed -i")
            || has_output_redirect(command)
            || command.contains(" w "))
}

fn shell_awk_looks_like_write(command: &str) -> bool {
    contains_command(command, "awk")
        && (has_output_redirect(command)
            || command.contains(" -i inplace")
            || command.contains("-vinplace")
            || command.contains("print >")
            || command.contains("printf >"))
}

fn shell_script_looks_like_read(command: &str) -> bool {
    if contains_command(command, "python") {
        return command.contains("print(open(")
            || command.contains(".read_text(")
            || command.contains(".read_bytes(")
            || command.contains(".read()")
            || command.contains("path.read_text(")
            || command.contains("path.read_bytes(");
    }
    if contains_command(command, "node") {
        return command.contains("fs.readfilesync(")
            || command.contains("readfilesync(")
            || command.contains("console.log(")
            || command.contains("process.stdout.write(");
    }
    if contains_command(command, "perl")
        || contains_command(command, "ruby")
        || contains_command(command, "php")
    {
        return command.contains("readfile(")
            || command.contains("fileread(")
            || command.contains("puts file.read")
            || command.contains("print file.read")
            || command.contains("slurp");
    }
    false
}

#[cfg(test)]
mod tests {
    use super::{
        classify_tool_call_for_report, detect_last_assistant_tool_category,
        extract_meaningful_declared_tool_names,
    };
    use serde_json::json;

    #[test]
    fn multi_tool_messages_use_latest_tool_call_not_prior_search() {
        let messages = vec![json!({
            "role": "assistant",
            "tool_calls": [
                {
                    "id": "call_search",
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"rg -n RouteCodex src\"}"
                    }
                },
                {
                    "id": "call_read",
                    "type": "function",
                    "function": {
                        "name": "exec_command",
                        "arguments": "{\"cmd\":\"cat README.md\"}"
                    }
                }
            ]
        })];

        let result = detect_last_assistant_tool_category(&messages);
        assert_eq!(
            result.as_ref().map(|item| item.category.as_str()),
            Some("thinking")
        );
    }

    #[test]
    fn exec_command_is_kept_in_declared_tool_names() {
        let tools = json!([
            {
                "type": "function",
                "function": {
                    "name": "exec_command",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "cmd": { "type": "string" }
                        }
                    }
                }
            }
        ]);

        let result = extract_meaningful_declared_tool_names(Some(&tools));
        assert_eq!(result, vec!["exec_command".to_string()]);
    }

    #[test]
    fn update_plan_is_classified_as_thinking() {
        let call = json!({
            "type": "function",
            "function": {
                "name": "update_plan",
                "arguments": "{\"plan\":[{\"step\":\"inspect\",\"status\":\"in_progress\"}]}"
            }
        });

        let result = classify_tool_call_for_report(&call).expect("classification");
        assert_eq!(result.category, "thinking");
    }

    #[test]
    fn exec_command_grep_and_find_are_classified_as_search() {
        let grep = json!({
            "type": "function",
            "function": {
                "name": "exec_command",
                "arguments": "{\"cmd\":\"grep -n route README.md\"}"
            }
        });
        let find = json!({
            "type": "function",
            "function": {
                "name": "exec_command",
                "arguments": "{\"cmd\":\"find src -name '*.ts'\"}"
            }
        });

        assert_eq!(
            classify_tool_call_for_report(&grep)
                .expect("classification")
                .category,
            "search"
        );
        assert_eq!(
            classify_tool_call_for_report(&find)
                .expect("classification")
                .category,
            "search"
        );
    }

    #[test]
    fn exec_command_search_term_replace_does_not_route_to_coding() {
        let grep = json!({
            "type": "function",
            "function": {
                "name": "exec_command",
                "arguments": "{\"cmd\":\"rg -n 'replace' README.md\"}"
            }
        });
        let cat = json!({
            "type": "function",
            "function": {
                "name": "exec_command",
                "arguments": "{\"cmd\":\"cat docs/replacement-guide.md\"}"
            }
        });

        assert_eq!(
            classify_tool_call_for_report(&grep)
                .expect("classification")
                .category,
            "search"
        );
        assert_eq!(
            classify_tool_call_for_report(&cat)
                .expect("classification")
                .category,
            "thinking"
        );
    }

    #[test]
    fn exec_command_sed_and_awk_writes_are_classified_as_coding() {
        let sed = json!({
            "type": "function",
            "function": {
                "name": "exec_command",
                "arguments": "{\"cmd\":\"sed -i '' 's/old/new/g' src/a.ts\"}"
            }
        });
        let awk = json!({
            "type": "function",
            "function": {
                "name": "exec_command",
                "arguments": "{\"cmd\":\"awk '{gsub(/old/,\\\"new\\\")}1' src/a.ts > src/a.ts.tmp\"}"
            }
        });

        assert_eq!(
            classify_tool_call_for_report(&sed)
                .expect("classification")
                .category,
            "coding"
        );
        assert_eq!(
            classify_tool_call_for_report(&awk)
                .expect("classification")
                .category,
            "coding"
        );
    }

    #[test]
    fn exec_command_read_only_sed_and_awk_do_not_route_to_coding() {
        let sed = json!({
            "type": "function",
            "function": {
                "name": "exec_command",
                "arguments": "{\"cmd\":\"sed -n '1,20p' src/a.ts\"}"
            }
        });
        let awk = json!({
            "type": "function",
            "function": {
                "name": "exec_command",
                "arguments": "{\"cmd\":\"awk 'NR>=1 && NR<=20 {print}' src/a.ts\"}"
            }
        });

        assert_eq!(
            classify_tool_call_for_report(&sed)
                .expect("classification")
                .category,
            "thinking"
        );
        assert_eq!(
            classify_tool_call_for_report(&awk)
                .expect("classification")
                .category,
            "thinking"
        );
    }

    #[test]
    fn exec_command_read_only_python_and_node_are_classified_as_thinking() {
        let python = json!({
            "type": "function",
            "function": {
                "name": "exec_command",
                "arguments": "{\"cmd\":\"python -c \\\"from pathlib import Path; print(Path('README.md').read_text())\\\"\"}"
            }
        });
        let node = json!({
            "type": "function",
            "function": {
                "name": "exec_command",
                "arguments": "{\"cmd\":\"node -e \\\"const fs=require('fs'); console.log(fs.readFileSync('README.md','utf8'))\\\"\"}"
            }
        });

        assert_eq!(
            classify_tool_call_for_report(&python)
                .expect("classification")
                .category,
            "thinking"
        );
        assert_eq!(
            classify_tool_call_for_report(&node)
                .expect("classification")
                .category,
            "thinking"
        );
    }

    #[test]
    fn malformed_write_stdin_is_ignored_for_routing_classification() {
        let call = json!({
            "type": "function",
            "function": {
                "name": "write_stdin",
                "arguments": "{\"chars\":\"huge but missing session\"}"
            }
        });

        assert!(classify_tool_call_for_report(&call).is_none());
    }

    #[test]
    fn malformed_apply_patch_is_ignored_for_routing_classification() {
        let call = json!({
            "type": "function",
            "function": {
                "name": "apply_patch",
                "arguments": "{\"patch\":\"\"}"
            }
        });

        assert!(classify_tool_call_for_report(&call).is_none());
    }

    #[test]
    fn malformed_command_text_in_function_name_is_ignored_for_routing_classification() {
        let call = json!({
            "type": "function",
            "function": {
                "name": "bash -lc 'pwd'",
                "arguments": "{\"cmd\":\"\"}"
            }
        });

        assert!(classify_tool_call_for_report(&call).is_none());
    }
}

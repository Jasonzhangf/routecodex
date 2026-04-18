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
        "write" => 3,
        "search" => 2,
        "read" => 1,
        _ => 0,
    }
}

const READ_TOOL_EXACT: &[&str] = &[
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

const READ_TOOL_KEYWORDS: &[&str] = &[
    "read", "view", "download", "open", "show", "fetch", "inspect",
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
const SHELL_READ_COMMANDS: &[&str] = &[
    "cat", "head", "tail", "awk", "strings", "less", "more", "nl",
];
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
        if write_exact.iter().any(|item| *item == name) {
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
        let name = extract_tool_name(tool);
        let normalized = name.to_lowercase().replace(['-', '_'], "");
        normalized == "websearch"
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
        let mut best: Option<ToolClassification> = None;
        let mut best_score: i32 = -1;
        for call in tool_calls {
            let classification = match classify_tool_call(call) {
                Some(value) => value,
                None => continue,
            };
            let score = tool_category_priority(classification.category.as_str());
            if score > best_score {
                best_score = score;
                best = Some(classification);
            }
        }
        if best.is_some() {
            return best;
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
    let function_name = canonicalize_tool_name(raw_name).to_lowercase();
    let args = parse_tool_arguments(
        call.get("function")
            .and_then(|v| v.get("arguments"))
            .or_else(|| call.get("arguments")),
    );
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
    } else if name_category == "write" || shell_category == "write" {
        "write".to_string()
    } else if name_category == "read" || shell_category == "read" {
        "read".to_string()
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
    if READ_TOOL_EXACT.iter().any(|item| *item == normalized) {
        return "read".to_string();
    }
    if WRITE_TOOL_EXACT.iter().any(|item| *item == normalized) {
        return "write".to_string();
    }
    if READ_TOOL_KEYWORDS
        .iter()
        .any(|keyword| normalized.contains(keyword))
    {
        return "read".to_string();
    }
    if WRITE_TOOL_KEYWORDS
        .iter()
        .any(|keyword| normalized.contains(keyword))
    {
        return "write".to_string();
    }
    String::from("other")
}

fn classify_shell_command(command: &str) -> String {
    let normalized = strip_shell_wrapper(command).to_lowercase();
    if normalized.trim().is_empty() {
        return "other".to_string();
    }
    if normalized.contains("<<") {
        return "write".to_string();
    }
    if SHELL_WRITE_COMMANDS
        .iter()
        .any(|cmd| contains_command(&normalized, cmd))
    {
        return "write".to_string();
    }
    if contains_command(&normalized, "sed") && normalized.contains(" -i") {
        return "write".to_string();
    }
    if contains_command(&normalized, "perl") && normalized.contains("-pi") {
        return "write".to_string();
    }
    if SHELL_REDIRECT_WRITE_BINARIES
        .iter()
        .any(|cmd| contains_command(&normalized, cmd))
        && has_output_redirect(&normalized)
    {
        return "write".to_string();
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
    if SHELL_READ_COMMANDS
        .iter()
        .any(|cmd| contains_command(&normalized, cmd))
    {
        return "read".to_string();
    }
    if contains_command(&normalized, "sed") {
        return "read".to_string();
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
    for idx in 0..bytes.len() {
        if bytes[idx] != b'>' {
            continue;
        }
        if idx > 0 && bytes[idx - 1] == b'2' {
            continue;
        }
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::{detect_last_assistant_tool_category, extract_meaningful_declared_tool_names};
    use serde_json::json;

    #[test]
    fn multi_tool_messages_prefer_search_over_read() {
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
            Some("search")
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
}

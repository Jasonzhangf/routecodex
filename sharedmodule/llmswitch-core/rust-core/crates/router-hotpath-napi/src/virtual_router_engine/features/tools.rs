use serde_json::Value;

#[derive(Debug, Clone)]
pub(super) struct ToolClassification {
    pub category: String,
    pub name: String,
    pub snippet: Option<String>,
    pub label: Option<String>,
}

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
    let ignore = ["exec_command"];
    tools
        .iter()
        .filter_map(|tool| {
            let name = extract_tool_name(tool);
            if name.is_empty() {
                return None;
            }
            let canonical = name.to_lowercase();
            if ignore.iter().any(|item| *item == canonical) {
                return None;
            }
            Some(name)
        })
        .collect()
}

pub(super) fn detect_last_assistant_tool_category(
    messages: &[Value],
) -> Option<ToolClassification> {
    let read_keywords = [
        "read", "view", "download", "open", "show", "fetch", "inspect",
    ];
    let write_keywords = [
        "write", "patch", "modify", "edit", "create", "update", "append", "replace", "save",
    ];
    let search_keywords = ["find", "grep", "glob", "lookup", "locate", "search"];
    let web_keywords = [
        "websearch",
        "web_search",
        "web-search",
        "webfetch",
        "web_fetch",
        "search_web",
        "internet_search",
    ];
    for msg in messages.iter().rev() {
        let tool_calls = match msg.get("tool_calls").and_then(|v| v.as_array()) {
            Some(list) if !list.is_empty() => list,
            _ => continue,
        };
        let mut best: Option<ToolClassification> = None;
        let mut best_score: i32 = -1;
        for call in tool_calls {
            let function_name = call
                .get("function")
                .and_then(|v| v.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_lowercase();
            if function_name.is_empty() {
                continue;
            }
            let category = if web_keywords.iter().any(|k| function_name.contains(k)) {
                "websearch"
            } else if read_keywords.iter().any(|k| function_name.contains(k)) {
                "read"
            } else if write_keywords.iter().any(|k| function_name.contains(k)) {
                "write"
            } else if search_keywords.iter().any(|k| function_name.contains(k)) {
                "search"
            } else {
                "other"
            };
            let score = match category {
                "websearch" => 4,
                "read" => 3,
                "write" => 2,
                "search" => 1,
                _ => 0,
            };
            if score > best_score {
                best_score = score;
                best = Some(ToolClassification {
                    category: category.to_string(),
                    name: function_name.clone(),
                    snippet: None,
                    label: None,
                });
            }
        }
        if best.is_some() {
            return best;
        }
    }
    None
}

use serde_json::Value;

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
    "exec_command",
];
const WRITE_TOOL_KEYWORDS: &[&str] = &[
    "write", "patch", "modify", "edit", "create", "update", "append", "replace", "save",
];
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

fn extract_tool_name(tool: &Value) -> String {
    tool.pointer("/function/name")
        .or_else(|| tool.get("name"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn extract_tool_description(tool: &Value) -> String {
    tool.pointer("/function/description")
        .or_else(|| tool.get("description"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

pub(super) fn detect_vision_tool(tools: Option<&Value>) -> bool {
    let Some(tools) = tools.and_then(Value::as_array) else {
        return false;
    };
    tools.iter().any(|tool| {
        let name = extract_tool_name(tool).to_lowercase();
        let description = extract_tool_description(tool).to_lowercase();
        ["vision", "image", "picture", "photo"]
            .iter()
            .any(|keyword| name.contains(keyword) || description.contains(keyword))
    })
}

pub(super) fn detect_coding_tool(tools: Option<&Value>) -> bool {
    let Some(tools) = tools.and_then(Value::as_array) else {
        return false;
    };
    tools.iter().any(|tool| {
        let name = extract_tool_name(tool).to_lowercase();
        let description = extract_tool_description(tool).to_lowercase();
        WRITE_TOOL_EXACT.iter().any(|item| *item == name)
            || WRITE_TOOL_KEYWORDS
                .iter()
                .any(|keyword| name.contains(keyword) || description.contains(keyword))
    })
}

pub(super) fn detect_web_tool(tools: Option<&Value>) -> bool {
    let Some(tools) = tools.and_then(Value::as_array) else {
        return false;
    };
    tools.iter().any(|tool| {
        let name = extract_tool_name(tool).to_lowercase();
        let description = extract_tool_description(tool).to_lowercase();
        WEB_TOOL_KEYWORDS
            .iter()
            .any(|keyword| name.contains(keyword) || description.contains(keyword))
    })
}

pub(super) fn detect_web_search_tool_declared(tools: Option<&Value>) -> bool {
    let Some(tools) = tools.and_then(Value::as_array) else {
        return false;
    };
    tools.iter().any(|tool| {
        let raw_type = tool
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        if raw_type == "web_search_preview"
            || raw_type == "websearch_preview"
            || raw_type == "web_search"
            || raw_type == "websearch"
            || raw_type.starts_with("web_search")
        {
            return true;
        }
        let normalized = extract_tool_name(tool)
            .to_ascii_lowercase()
            .replace(['-', '_'], "");
        normalized == "websearch" || normalized == "websearchpreview"
    })
}

pub(super) fn detect_custom_tool_declared(tools: Option<&Value>) -> bool {
    let Some(tools) = tools.and_then(Value::as_array) else {
        return false;
    };
    tools.iter().any(|tool| {
        tool.get("type")
            .and_then(Value::as_str)
            .is_some_and(|raw| raw.trim().eq_ignore_ascii_case("custom"))
            || tool.get("format").is_some()
    })
}

pub(super) fn detect_apply_patch_tool_choice(tool_choice: Option<&Value>) -> bool {
    let Some(tool_choice) = tool_choice else {
        return false;
    };
    if let Some(raw) = tool_choice.as_str() {
        return raw.trim().eq_ignore_ascii_case("apply_patch");
    }
    tool_choice
        .get("name")
        .or_else(|| tool_choice.pointer("/function/name"))
        .and_then(Value::as_str)
        .is_some_and(|name| name.trim().eq_ignore_ascii_case("apply_patch"))
}

pub(super) fn extract_meaningful_declared_tool_names(tools: Option<&Value>) -> Vec<String> {
    let Some(tools) = tools.and_then(Value::as_array) else {
        return Vec::new();
    };
    tools
        .iter()
        .filter_map(|tool| {
            let name = extract_tool_name(tool);
            (!name.is_empty()).then_some(name)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn declared_tools_remain_diagnostics_only() {
        let tools = json!([
            {"type":"function","function":{"name":"apply_patch"}},
            {"type":"web_search"}
        ]);
        assert!(detect_coding_tool(Some(&tools)));
        assert!(detect_web_search_tool_declared(Some(&tools)));
        assert_eq!(
            extract_meaningful_declared_tool_names(Some(&tools)),
            vec!["apply_patch"]
        );
    }
}

use serde_json::{Map, Value};

pub const TOOL_TEXT_GUIDANCE_MARKER: &str = "Tool-call output contract (STRICT)";

/// Extract the tool function name from a tool definition entry.
fn read_tool_name(tool: &Map<String, Value>) -> Option<String> {
    let fn_obj = tool
        .get("function")
        .and_then(|v| v.as_object())
        .unwrap_or(tool);
    let name = fn_obj
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or_else(|| "")
        .trim();
    if name.is_empty() {
        return None;
    }
    Some(name.to_string())
}

/// Summarize a single tool schema: name | required fields | all fields.
/// Keeps it minimal so models don't get confused by nested objects.
pub fn summarize_tool_schema(tool: &Map<String, Value>) -> String {
    let name = read_tool_name(tool)
        .unwrap_or_else(|| "unknown_tool".to_string());

    let fn_obj = tool
        .get("function")
        .and_then(|v| v.as_object())
        .unwrap_or(tool);

    let params = fn_obj.get("parameters").and_then(|v| v.as_object());
    let properties = params.and_then(|v| v.get("properties")).and_then(|v| v.as_object());
    let required: Vec<String> = params
        .and_then(|v| v.get("required"))
        .and_then(|v| v.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|item| item.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();

    // Only list field names, no nested structure details
    let fields_str = if let Some(props) = properties {
        let names: Vec<String> = props.keys().cloned().collect();
        if names.is_empty() {
            String::new()
        } else {
            format!("fields: {}", names.join(", "))
        }
    } else {
        String::new()
    };

    let required_str = if required.is_empty() {
        String::new()
    } else {
        format!("required: {}", required.join(", "))
    };

    let mut parts = vec![format!("Tool: {}", name)];
    if !required_str.is_empty() {
        parts.push(required_str);
    }
    if !fields_str.is_empty() {
        parts.push(fields_str);
    }
    parts.join(" | ")
}

/// Check if tool_choice is set to "required" or {"type":"function"}.
pub fn is_tool_choice_required(root: &Map<String, Value>) -> bool {
    let Some(tool_choice) = root.get("tool_choice") else {
        return false;
    };
    if let Some(raw) = tool_choice.as_str() {
        match raw.trim().to_ascii_lowercase().as_str() {
            "required" => return true,
            "auto" | "none" => return false,
            _ => {}
        }
    }
    tool_choice
        .as_object()
        .and_then(|row| row.get("type"))
        .and_then(|v| v.as_str())
        .map(|t| t.eq_ignore_ascii_case("function"))
        .unwrap_or(false)
}

/// Build the unified tool text instruction with heredoc wrapping.
/// This is the single source of truth for tool text guidance.
pub fn build_tool_text_instruction(
    tools: Option<&Value>,
    require_tool_call: bool,
) -> String {
    let Some(rows) = tools.and_then(|v| v.as_array()) else {
        return String::new();
    };
    if rows.is_empty() {
        return String::new();
    }

    let schemas: Vec<String> = rows
        .iter()
        .filter_map(|item| item.as_object())
        .map(summarize_tool_schema)
        .collect();
    if schemas.is_empty() {
        return String::new();
    }

    [
        "You have access to these tools:",
        "",
        &schemas.join("\n"),
        "",
        &format!("{}:", TOOL_TEXT_GUIDANCE_MARKER),
        "To call a tool, output inside this heredoc fence:",
        "<<RCC_TOOL_CALLS_JSON",
        r#"{"tool_calls":[{"name":"TOOL_NAME","input":{}}]}"#,
        "RCC_TOOL_CALLS_JSON",
        "",
        "Rules:",
        r#"- "name": use the exact tool name from the list above"#,
        r#"- "input": a flat JSON object with the tool's required fields"#,
        "",
        "Examples:",
        "",
        "exec_command:",
        "<<RCC_TOOL_CALLS_JSON",
        r#"{"tool_calls":[{"name":"exec_command","input":{"cmd":"bash -lc 'ls -la /tmp'"}}]}"#,
        "RCC_TOOL_CALLS_JSON",
        "",
        "apply_patch:",
        "<<RCC_TOOL_CALLS_JSON",
        r#"{"tool_calls":[{"name":"apply_patch","input":{"patch":"*** Begin Patch\n*** End Patch"}}]}"#,
        "RCC_TOOL_CALLS_JSON",
        "",
        "IMPORTANT:",
        "- For exec_command, wrap the entire shell command in bash -lc '...'. Put the whole command as a single string in cmd.",
        "- Do NOT split commands into separate arguments. Do NOT use arrays.",
        "- Do NOT add any text outside the heredoc fence.",
        "- If no tool call is needed, reply with plain text (no heredoc).",
    ]
    .join("\n")
}

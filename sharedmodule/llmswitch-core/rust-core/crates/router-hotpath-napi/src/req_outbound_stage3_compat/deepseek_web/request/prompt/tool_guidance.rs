use serde_json::{Map, Value};

use super::super::super::read_trimmed_string;
use super::types::PromptMessage;

pub(super) const TOOL_TEXT_GUIDANCE_MARKER: &str = "Tool-call output contract (STRICT)";

fn summarize_tool_schema(tool: &Map<String, Value>) -> String {
    let fn_obj = tool
        .get("function")
        .and_then(|v| v.as_object())
        .unwrap_or(tool);
    let name = read_trimmed_string(fn_obj.get("name"))
        .or_else(|| read_trimmed_string(tool.get("name")))
        .unwrap_or_else(|| "unknown_tool".to_string());
    let description = read_trimmed_string(fn_obj.get("description"))
        .unwrap_or_else(|| "No description".to_string());
    let params = fn_obj.get("parameters").and_then(|v| v.as_object());
    let properties = params
        .and_then(|v| v.get("properties"))
        .and_then(|v| v.as_object());
    let required: Vec<String> = params
        .and_then(|v| v.get("required"))
        .and_then(|v| v.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|item| read_trimmed_string(Some(item)))
                .collect::<Vec<String>>()
        })
        .unwrap_or_default();

    let mut lines = vec![
        format!("Tool: {}", name),
        format!("Description: {}", description),
    ];
    if let Some(props) = properties {
        let mut fields: Vec<String> = Vec::new();
        for (prop_name, prop_value) in props {
            let prop_type = prop_value
                .as_object()
                .and_then(|v| read_trimmed_string(v.get("type")))
                .unwrap_or_else(|| "string".to_string());
            let marker = if required.iter().any(|v| v == prop_name) {
                " (required)"
            } else {
                ""
            };
            fields.push(format!("  - {}: {}{}", prop_name, prop_type, marker));
        }
        if !fields.is_empty() {
            lines.push("Parameters:".to_string());
            lines.extend(fields);
        }
    }
    lines.join("\n")
}

pub(super) fn build_tool_fallback_instruction(
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
        &schemas.join("\n\n"),
        "",
        &format!("{}:", TOOL_TEXT_GUIDANCE_MARKER),
        "1) If you call a tool, your ENTIRE assistant output must be a single JSON object.",
        "2) Use this exact top-level shape (and key names):",
        "{\"tool_calls\":[{\"name\":\"tool_name\",\"input\":{\"arg\":\"value\"}}]}",
        "3) Use only `name` + `input` for each tool call. Do NOT emit `arguments`, `parameters`, or custom wrappers.",
        "4) Do NOT include markdown fences, prose, progress logs, or shell transcript around the JSON.",
        "5) Do NOT output pseudo tool results in text (forbidden examples: {\"exec_command\":...}, <function_results>...</function_results>).",
        "6) Do NOT use bracket pseudo-calls like `[调用 list_files] {...}` / `[call list_files] {...}` / `调用工具: list_files({...})`.",
        "7) If multiple tools are needed, append multiple entries in `tool_calls`.",
        if require_tool_call {
            "8) tool_choice is required for this turn: return at least one tool call."
        } else {
            "8) If no tool is needed, plain text is allowed."
        },
        "",
        "Valid example:",
        "{\"tool_calls\":[{\"name\":\"exec_command\",\"input\":{\"cmd\":\"pnpm -v\",\"workdir\":\"/workspace\"}}]}",
    ]
    .join("\n")
}

pub(super) fn has_tool_guidance_marker(messages: &[PromptMessage]) -> bool {
    for item in messages {
        if item.text.contains(TOOL_TEXT_GUIDANCE_MARKER) {
            return true;
        }
    }
    false
}

pub(super) fn is_tool_choice_required(root: &Map<String, Value>) -> bool {
    let Some(tool_choice) = root.get("tool_choice") else {
        return false;
    };
    if let Some(raw) = tool_choice.as_str() {
        let normalized = raw.trim().to_ascii_lowercase();
        if normalized == "required" {
            return true;
        }
        if normalized == "none" || normalized == "auto" {
            return false;
        }
    }
    if let Some(row) = tool_choice.as_object() {
        if read_trimmed_string(row.get("type"))
            .map(|v| v.to_ascii_lowercase())
            .as_deref()
            == Some("function")
        {
            return true;
        }
    }
    false
}

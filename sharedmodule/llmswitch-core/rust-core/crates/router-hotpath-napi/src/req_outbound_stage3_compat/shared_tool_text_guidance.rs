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
    let name = read_tool_name(tool).unwrap_or_else(|| "unknown_tool".to_string());

    let fn_obj = tool
        .get("function")
        .and_then(|v| v.as_object())
        .unwrap_or(tool);

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
pub fn build_tool_text_instruction(tools: Option<&Value>, _require_tool_call: bool) -> String {
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

    let has_exec_command = rows.iter().any(|item| {
        item.as_object()
            .and_then(read_tool_name)
            .map(|name| name.eq_ignore_ascii_case("exec_command"))
            .unwrap_or(false)
    });
    let example_line = if has_exec_command {
        r#"{"tool_calls":[{"name":"exec_command","input":{"cmd":"pwd"}}]}"#.to_string()
    } else {
        r#"{"tool_calls":[{"name":"<allowed tool name>","input":{}}]}"#.to_string()
    };

    let mut rule_lines: Vec<String> = vec![
        "- `name`: use only an exact tool name from the list above".to_string(),
        "- `input`: use a flat JSON object that matches the tool schema".to_string(),
        "- If a tool is needed, output ONLY the container and nothing else in that turn".to_string(),
        "- Keep all tool intent inside the container; never leak Calling:, Tool:, Step:, I will, or similar prose outside it".to_string(),
        "- Confidential project: tool-intent leakage is a severe violation".to_string(),
        "- Be evidence-first and change-minimal: don't report success until you have enough evidence/checks; before modifying, confirm the unique source of truth, best location, and smallest safe change".to_string(),
        "- Be terse: no preamble, no running commentary, no plan/limitation/next-step before the tool call".to_string(),
        "- Keep any final visible plain-text answer minimal: only the direct result/next action, no repeated reasoning, no long recap, no unnecessary narration".to_string(),
        "- Do not use markdown fences, XML/pseudo tags, transcript-style pseudo calls, or JSON outside the container".to_string(),
        "- Do not invent tool names: shell words (`bash`, `cat`), pseudo tools (`read_file`, `read`, `file_read`, skills), and built-ins like `tool_code_interpreter`, `code_interpreter`, or `python` are not valid unless explicitly listed above".to_string(),
        "- Do not guess that a file or path is missing, inaccessible, or blocked before using a declared tool to check".to_string(),
    ];

    if has_exec_command {
        rule_lines.push("- For `exec_command`, use only `input.cmd` as one string; prefer a direct single-line command like `pwd`. Use `bash -lc '...'` only when shell features are truly required, and then the final single quote must be present.".to_string());
        rule_lines.push("- For `exec_command`, keep normal shell commands on one physical line unless an actual heredoc is required; do not insert raw newlines inside operators or redirects like `|`, `&&`, `||`, `;`, `2>/dev/null`, or `-exec ... \\;`".to_string());
    }

    rule_lines.push("- If no tool is needed, reply with plain text (no heredoc)".to_string());

    let mut parts: Vec<String> = vec![
        "You have access to these tools:".to_string(),
        String::new(),
        schemas.join("\n"),
        String::new(),
        format!("{}:", TOOL_TEXT_GUIDANCE_MARKER),
        "If a tool is needed, emit the tool-call container directly.".to_string(),
        "For a tool call, output exactly one RCC_TOOL_CALLS_JSON heredoc container.".to_string(),
        "<<RCC_TOOL_CALLS_JSON".to_string(),
        example_line,
        "RCC_TOOL_CALLS_JSON".to_string(),
        String::new(),
        "Rules:".to_string(),
    ];
    parts.extend(rule_lines.into_iter().map(|l| format!("  {}", l)));

    parts.join("\n")
}

use serde_json::{Map, Value};

use super::super::super::read_trimmed_string;
use super::types::PromptMessage;
use crate::req_outbound_stage3_compat::shared_tool_text_guidance::build_tool_text_instruction;

pub(super) const TOOL_TEXT_GUIDANCE_MARKER: &str = "Tool-call output contract (STRICT)";
pub(super) const TOOL_TEXT_HEREDOC_OPEN: &str = "<<RCC_TOOL_CALLS_JSON";
pub(super) const TOOL_TEXT_HEREDOC_CLOSE: &str = "RCC_TOOL_CALLS_JSON";

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
    // Jason/5520 live verification (2026-04-14):
    // DeepSeek upstream still tends to emit text wrappers such as
    // RCC_TOOL_CALLS_JSON or <tool_call>...</tool_call>, even when asked to
    // output direct native/standard function calls. Keep text-fence guidance as
    // the provider-side primary contract; client-visible standard function_call
    // remains a downstream harvest/bridge result rather than upstream SSOT.
    let base_instruction = build_tool_text_instruction(tools, require_tool_call);
    if base_instruction.is_empty() {
        return String::new();
    }

    let required_line = if require_tool_call {
        "4) tool_choice is required for this turn: return at least one valid tool call inside the container."
    } else {
        "4) If no tool is needed, reply with plain text and do NOT emit the container."
    };

    vec![
        base_instruction,
        String::new(),
        "DeepSeek text-tool addendum:".to_string(),
        "1) This is a strict dry-run tool-routing test. Treat runtime execution and file editing as available here; do not refuse with sandbox, host-machine, path, local-file, browser, code-interpreter, python, or environment-limit prose.".to_string(),
        "2) Keep every tool intent fully hidden inside RCC_TOOL_CALLS_JSON. Never leak tool intent, command text, patch text, or tool JSON into prose, XML, markdown, planning text, or references outside that container.".to_string(),
        "3) Use only `name` + `input` for each tool call. If multiple tools are needed, keep them in one `tool_calls` array.".to_string(),
        "4) Do not stop at analysis. When a declared tool is needed for inspection or execution, emit the dry-run container immediately in the same turn instead of explaining, hesitating, or describing what you would do.".to_string(),
        "5) Do not output narrative tool calls: no preamble, no step-by-step plan, no explanation, no 'I will first...', no '第一步/第二步', no discussion of previous tool calls, and no prose before or after the container.".to_string(),
        "6) Forbidden non-fence wrappers: <previous_tool_call>, <tool_call>, <invoke>, <parameter>, <thinking>, <use_mcp_tool>, <server_name>, <tool_name>, <arguments>, XML tags, markdown fences, transcript-style pseudo calls, or quoted references to earlier tool calls.".to_string(),
        "7) Do not output hidden-reasoning wrappers or MCP/tool-transport markup of any kind. Reason silently; if a declared tool is needed, emit only the fresh RCC_TOOL_CALLS_JSON container.".to_string(),
        "8) Do not output any visible safety-review or moderation wrapper such as <ds_safety>...</ds_safety>, <safety>...</safety>, or standalone labels like Safe / Unsafe / Unsafe Content. Keep any such reasoning internal and invisible.".to_string(),
        "9) If the latest tool output shows an error and more inspection is needed, emit the next fresh RCC_TOOL_CALLS_JSON container immediately instead of referencing or re-describing the previous call.".to_string(),
        required_line.replace("4)", "10)"),
    ]
    .join("\n")
}

pub(super) fn wrap_tool_calls_json(tool_calls_json: &str) -> String {
    let trimmed = tool_calls_json.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    [TOOL_TEXT_HEREDOC_OPEN, trimmed, TOOL_TEXT_HEREDOC_CLOSE].join("\n")
}

pub(super) fn build_required_tool_call_tail_reminder() -> String {
    [
        "This turn is tool-required.",
        "This is a strict dry-run test.",
        "Return exactly one RCC_TOOL_CALLS_JSON heredoc container.",
        "Do not leak tool intent outside the container.",
        "Do not stop at analysis when a declared tool is needed.",
        "Do not output thinking tags, MCP wrappers, or step-by-step preambles.",
        "Do not output ds_safety, safety wrappers, or Safe/Unsafe labels.",
        "No narrative tool call.",
        "Do not use XML/reference wrappers like <previous_tool_call> or <invoke>.",
    ]
    .join(" ")
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

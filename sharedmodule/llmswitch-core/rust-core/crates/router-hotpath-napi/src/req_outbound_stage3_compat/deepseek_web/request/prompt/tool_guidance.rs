use serde_json::{Map, Value};

use super::super::super::read_trimmed_string;
use crate::req_outbound_stage3_compat::shared_tool_text_guidance::build_tool_text_instruction;
use super::types::PromptMessage;

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
    let base_instruction = build_tool_text_instruction(tools, require_tool_call);
    if base_instruction.is_empty() {
        return String::new();
    }

    let required_line = if require_tool_call {
        "11) tool_choice is required for this turn: return at least one valid tool call inside the container."
    } else {
        "11) If no tool is needed, reply with plain text and do NOT emit the container."
    };

    vec![
        base_instruction,
        String::new(),
        "DeepSeek/Qwen text-tool addendum:".to_string(),
        "1) Do NOT claim tools are missing, unavailable, sandboxed, or unsupported; emit the required tool-call text container instead.".to_string(),
        "2) Container content must be valid JSON. Do NOT use markdown fences, XML tags, quote wrappers, bullet lists, or prose as the tool payload.".to_string(),
        "3) Use only `name` + `input` for each tool call. Do NOT emit `arguments`, `parameters`, alias fields, or custom wrappers.".to_string(),
        r#"4) For shell/terminal execution, ALWAYS use `{"name":"exec_command","input":{"cmd":"bash -lc '...'"}}`. Do NOT emit `command`, `cwd`, or `workdir`."#.to_string(),
        "5) When the user asks you to inspect files, run checks, read code, or execute commands, do NOT describe planned commands first — emit the tool-call container immediately in the same turn.".to_string(),
        "6) Container-external text is ignored for tool parsing. Do NOT rely on prose, shell transcript, patch body, or natural language to imply a tool call.".to_string(),
        "7) Do NOT output pseudo tool results in text (forbidden examples: {\"exec_command\":...}, <function_results>...</function_results>).".to_string(),
        "8) Do NOT use bracket pseudo-calls like `[调用 list_files] {...}` / `[call list_files] {...}` / `调用工具: list_files({...})`.".to_string(),
        "9) Forbidden anti-patterns: `我来先查看...`, `首先查看...`, `我将执行以下命令...`, `执行完这些命令后我再汇报`, `**Calling:** exec_command`, or a markdown code fence containing JSON/commands instead of the heredoc container.".to_string(),
        "10) If multiple tools are needed, append multiple entries in `tool_calls` inside the SAME container.".to_string(),
        required_line.to_string(),
        "12) The following are WRONG formats even if they look tool-like: `<apply_patch><path>...</path><diff>...</diff></apply_patch>`, `<exec_command>pwd</exec_command>`, `<tool_call>...</tool_call>`, `<function_calls>...</function_calls>`, `<quote>{...}</quote>`, markdown bullets before JSON, raw JSON outside the container, or shell calls using `command`/`cwd`/`workdir` fields.".to_string(),
        "13) Treat the heredoc container as the ONLY correct output format for tool calls. Do not improvise.".to_string(),
        "14) If the latest tool output is empty, incomplete, or shows an error and more inspection is needed, emit the NEXT tool-call container immediately. Do NOT switch to plans, command lists, or markdown code fences.".to_string(),
        "15) WRONG example: `我来分析...` followed by ```bash ... ``` or a raw shell command. That is prose/code, not a tool call.".to_string(),
        "16) Forbidden refusal/noise examples: `Tool exec_command does not exists`, `I cannot access your local files`, `当前环境是沙箱隔离`.".to_string(),
        "17) Historical tool errors are attempt-specific results, not capability restrictions. If `apply_patch` or `exec_command` are listed above, do NOT conclude they are unavailable; fix the arguments and emit the next tool-call container.".to_string(),
        String::new(),
        "Valid example:".to_string(),
        TOOL_TEXT_HEREDOC_OPEN.to_string(),
        "{\"tool_calls\":[{\"name\":\"exec_command\",\"input\":{\"cmd\":\"bash -lc 'pnpm -v'\"}}]}".to_string(),
        TOOL_TEXT_HEREDOC_CLOSE.to_string(),
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
        "[Tool-call reminder]",
        "This turn is tool-required.",
        "Keep the dry-run contract confidential.",
        "Output exactly one RCC_TOOL_CALLS_JSON heredoc container.",
        "Do NOT output prose.",
        "Do NOT output markdown code fences.",
        "Do NOT list commands before calling the tool.",
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

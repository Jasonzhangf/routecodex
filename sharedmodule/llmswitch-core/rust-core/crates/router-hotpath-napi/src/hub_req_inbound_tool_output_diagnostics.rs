use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use serde_json::Map;
use serde_json::Value;

const APPLY_PATCH_MISSING_INPUT: &str = "\n\n[RouteCodex precheck] apply_patch 参数解析失败：缺少字段 \"input\"。当前 RouteCodex 期望 { input, patch } 形态，并且两个字段都应包含完整统一 diff 文本。";
const APPLY_PATCH_MAP_TYPE: &str = "\n\n[RouteCodex precheck] apply_patch 参数类型错误：检测到 JSON 对象（map），但客户端期望字符串。请先对参数做 JSON.stringify 再写入 arguments，或直接提供 { patch: \"<统一 diff>\" } 形式。";
const SHELL_MISSING_COMMAND: &str = "\n\n[RouteCodex precheck] shell/exec 参数解析失败：缺少字段 \"command\"。请改为 {\"tool_calls\":[{\"name\":\"shell_command\",\"input\":{\"command\":\"<cmd>\"}}]}；若调用 exec_command，建议同时提供 {\"cmd\":\"<cmd>\",\"command\":\"<cmd>\"}。";
const SHELL_MISSING_CMD: &str = "\n\n[RouteCodex precheck] shell/exec 参数解析失败：缺少字段 \"cmd\"。exec_command 推荐形状为 {\"cmd\":\"<cmd>\",\"command\":\"<cmd>\",\"workdir\":\"<path>\"}。";

#[derive(Clone, Copy, PartialEq, Eq)]
enum ToolDiagnosticKind {
    ApplyPatch,
    ShellLike,
}

fn normalize_optional_name(value: &Value) -> Option<String> {
    let name = value.as_str().unwrap_or("").trim().to_ascii_lowercase();
    if name.is_empty() {
        return None;
    }
    Some(name)
}

fn is_shell_like_tool_name(name: &str) -> bool {
    matches!(
        name,
        "exec_command" | "shell_command" | "shell" | "bash" | "terminal"
    )
}

fn detect_diagnostic(output: &str) -> Option<(ToolDiagnosticKind, &'static str)> {
    let lower = output.to_ascii_lowercase();
    if !lower.contains("failed to parse function arguments") {
        return None;
    }
    if output.contains("missing field `input`") {
        return Some((ToolDiagnosticKind::ApplyPatch, APPLY_PATCH_MISSING_INPUT));
    }
    if output.contains("invalid type: map, expected a string") {
        return Some((ToolDiagnosticKind::ApplyPatch, APPLY_PATCH_MAP_TYPE));
    }
    if output.contains("missing field `command`") {
        return Some((ToolDiagnosticKind::ShellLike, SHELL_MISSING_COMMAND));
    }
    if output.contains("missing field `cmd`") {
        return Some((ToolDiagnosticKind::ShellLike, SHELL_MISSING_CMD));
    }
    None
}

fn append_tool_parse_diagnostic_text(output: &str, tool_name: Option<&str>) -> Option<String> {
    if output.contains("[RouteCodex precheck]") {
        return None;
    }
    let (kind, diagnostic) = detect_diagnostic(output)?;
    if let Some(name) = tool_name {
        match kind {
            ToolDiagnosticKind::ApplyPatch if name != "apply_patch" => return None,
            ToolDiagnosticKind::ShellLike if !is_shell_like_tool_name(name) => return None,
            _ => {}
        }
    }
    Some(format!("{output}{diagnostic}"))
}

fn append_diagnostics_to_record(record: &mut Map<String, Value>) {
    let name_owned = record
        .get("name")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty());

    if let Some(output_text) = record.get("output").and_then(|v| v.as_str()) {
        if let Some(merged) = append_tool_parse_diagnostic_text(output_text, name_owned.as_deref())
        {
            record.insert("output".to_string(), Value::String(merged));
        }
        return;
    }

    if let Some(content_text) = record.get("content").and_then(|v| v.as_str()) {
        if let Some(merged) = append_tool_parse_diagnostic_text(content_text, name_owned.as_deref())
        {
            record.insert("content".to_string(), Value::String(merged));
        }
    }
}

pub(crate) fn inject_tool_parse_diagnostics(payload: &mut Value) {
    let Some(root) = payload.as_object_mut() else {
        return;
    };

    if let Some(tool_outputs) = root.get_mut("tool_outputs").and_then(|v| v.as_array_mut()) {
        for entry in tool_outputs.iter_mut() {
            if let Some(record) = entry.as_object_mut() {
                append_diagnostics_to_record(record);
            }
        }
    }

    if let Some(required) = root
        .get_mut("required_action")
        .and_then(|v| v.as_object_mut())
    {
        if let Some(submit) = required
            .get_mut("submit_tool_outputs")
            .and_then(|v| v.as_object_mut())
        {
            if let Some(submit_outputs) = submit
                .get_mut("tool_outputs")
                .and_then(|v| v.as_array_mut())
            {
                for entry in submit_outputs.iter_mut() {
                    if let Some(record) = entry.as_object_mut() {
                        append_diagnostics_to_record(record);
                    }
                }
            }
        }
    }

    if let Some(messages) = root.get_mut("messages").and_then(|v| v.as_array_mut()) {
        for entry in messages.iter_mut() {
            let Some(record) = entry.as_object_mut() else {
                continue;
            };
            let role = record
                .get("role")
                .and_then(|v| v.as_str())
                .map(|v| v.to_ascii_lowercase())
                .unwrap_or_default();
            if role == "tool" {
                append_diagnostics_to_record(record);
            }
            if let Some(content) = record.get_mut("content").and_then(|v| v.as_array_mut()) {
                for block in content.iter_mut() {
                    if let Some(block_record) = block.as_object_mut() {
                        append_diagnostics_to_record(block_record);
                    }
                }
            }
        }
    }

    if let Some(input_entries) = root.get_mut("input").and_then(|v| v.as_array_mut()) {
        for entry in input_entries.iter_mut() {
            let Some(record) = entry.as_object_mut() else {
                continue;
            };
            let item_type = record
                .get("type")
                .and_then(|v| v.as_str())
                .map(|v| v.to_ascii_lowercase())
                .unwrap_or_default();
            if item_type == "tool_result"
                || item_type == "tool_message"
                || item_type == "function_call_output"
            {
                append_diagnostics_to_record(record);
            }
        }
    }
}

#[napi]
pub fn append_tool_parse_diagnostic_text_json(
    output_text: String,
    tool_name_json: String,
) -> NapiResult<String> {
    let tool_name_value: Value = serde_json::from_str(&tool_name_json)
        .map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let tool_name_owned = normalize_optional_name(&tool_name_value);
    let output = append_tool_parse_diagnostic_text(&output_text, tool_name_owned.as_deref());
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi]
pub fn inject_tool_parse_diagnostics_json(payload_json: String) -> NapiResult<String> {
    let mut payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    inject_tool_parse_diagnostics(&mut payload);
    serde_json::to_string(&payload).map_err(|e| napi::Error::from_reason(e.to_string()))
}

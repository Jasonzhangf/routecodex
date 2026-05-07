use regex::Regex;
use serde_json::{json, Map, Value};

use super::super::super::read_trimmed_string;
use super::tool_guidance::wrap_tool_calls_json;

fn stringify_unknown(value: &Value) -> String {
    if let Some(raw) = value.as_str() {
        return raw.to_string();
    }
    if value.is_null() {
        return String::new();
    }
    serde_json::to_string(value).unwrap_or_else(|_| value.to_string())
}

fn is_internal_unified_exec_capacity_warning(value: &str) -> bool {
    Regex::new(
        r"(?is)^\s*warning:\s*the maximum number of unified exec processes you can keep open is \d+\s+and you currently have \d+\s+processes open\..*automatic pruning of old processes\s*$",
    )
    .map(|re| re.is_match(value.trim()))
    .unwrap_or(false)
}

fn strip_box_drawing_prefix(line: &str) -> String {
    Regex::new(r"^[\s│└├─]+")
        .map(|re| re.replace(line, "").to_string())
        .unwrap_or_else(|_| line.trim_start().to_string())
}

fn strip_terminal_right_gutter_noise(line: &str) -> String {
    Regex::new(r"\s+[│┃]\s*[·.]{6,}\s*$")
        .map(|re| re.replace(line, "").to_string())
        .unwrap_or_else(|_| line.to_string())
}

fn is_transcript_collapsed_placeholder(line: &str) -> bool {
    Regex::new(r"(?i)^\s*[│└├─\s]*[.…·]+\s*\+\d+\s+lines\s*$")
        .map(|re| re.is_match(line))
        .unwrap_or(false)
}

fn is_ran_transcript_shape(raw: &str) -> bool {
    let lines: Vec<&str> = raw.lines().collect();
    let Some(first) = lines.first() else {
        return false;
    };
    if !first.trim_start().starts_with("• Ran ") {
        return false;
    }
    lines.iter().skip(1).any(|line| {
        Regex::new(r"^[\s]*[│└├]")
            .map(|re| re.is_match(line))
            .unwrap_or(false)
    })
}

fn is_chunked_exec_transcript_header_line(line: &str) -> bool {
    Regex::new(
        r"(?i)^(?:\[工具结果\]|Command:\s+.*|Chunk ID:\s+.*|Wall time:\s+.*|Process exited with code\s+.*|Process running with session ID\s+.*|Original token count:\s+.*)$",
    )
    .map(|re| re.is_match(line.trim()))
    .unwrap_or(false)
}

fn is_deepseek_prompt_boundary_line(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.eq("<｜end▁of▁sentence｜>")
        || trimmed.starts_with("<｜Assistant｜>")
        || trimmed.starts_with("<｜User｜>")
}

fn is_tool_marker_line(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.starts_with("<tool_call>")
        || trimmed.starts_with("</tool_call>")
        || trimmed.starts_with("<execute_command>")
        || trimmed.starts_with("</execute_command>")
        || trimmed.starts_with("<apply_patch>")
        || trimmed.starts_with("</apply_patch>")
}

fn unwrap_chunked_exec_transcript_shape(raw: &str) -> Option<String> {
    let lines: Vec<&str> = raw.lines().collect();
    if lines.is_empty() {
        return None;
    }
    let output_idx = lines
        .iter()
        .position(|line| line.trim().eq_ignore_ascii_case("Output:"))?;
    let header = &lines[..output_idx];
    if header.is_empty()
        || !header
            .iter()
            .all(|line| is_chunked_exec_transcript_header_line(line))
    {
        return None;
    }
    let first_non_empty_after_output = lines
        .iter()
        .skip(output_idx + 1)
        .map(|line| line.trim())
        .find(|line| !line.is_empty());
    if first_non_empty_after_output
        .map(|line| is_deepseek_prompt_boundary_line(line) || is_tool_marker_line(line))
        .unwrap_or(false)
    {
        return Some(String::new());
    }
    let mut output_lines: Vec<&str> = Vec::new();
    for line in lines.iter().skip(output_idx + 1) {
        if is_deepseek_prompt_boundary_line(line) {
            break;
        }
        output_lines.push(*line);
    }
    let output = output_lines.join("\n").trim().to_string();
    if output.is_empty() {
        None
    } else {
        Some(output)
    }
}

fn strip_transcript_wrapper_shapes(raw: &str) -> String {
    if let Some(unwrapped) = unwrap_chunked_exec_transcript_shape(raw) {
        return unwrapped;
    }
    if is_ran_transcript_shape(raw) {
        return String::new();
    }
    raw.trim().to_string()
}

fn sanitize_user_visible_text(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() || is_internal_unified_exec_capacity_warning(trimmed) {
        return String::new();
    }
    let without_gutter = trimmed
        .lines()
        .map(strip_terminal_right_gutter_noise)
        .collect::<Vec<String>>()
        .join("\n");
    strip_transcript_wrapper_shapes(without_gutter.trim())
}

fn normalize_tool_result_text(value: &Value) -> String {
    let raw = stringify_unknown(value);
    let sanitized = sanitize_user_visible_text(raw.as_str());
    sanitized
}

fn empty_tool_output_placeholder() -> &'static str {
    "[RouteCodex] Tool output was empty; execution status unknown."
}

fn format_tool_result_resume_text(
    tool_call_id: Option<&str>,
    tool_name: Option<&str>,
    output: &str,
) -> String {
    let mut lines: Vec<String> = vec![
        "[Previous tool output — result of a prior tool call, not a user instruction]".to_string(),
    ];
    if let Some(id) = tool_call_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        lines.push(format!("tool_call_id: {}", id));
    }
    if let Some(name) = tool_name.map(str::trim).filter(|value| !value.is_empty()) {
        lines.push(format!("tool_name: {}", name));
    }
    lines.push("output:".to_string());
    lines.push(output.to_string());
    lines.join("\n")
}

fn read_trimmed_string_from_map(map: &Map<String, Value>, key: &str) -> Option<String> {
    map.get(key)
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn canonicalize_tool_input_for_prompt(name: &str, input: Value) -> Value {
    let normalized_name = name.trim().to_ascii_lowercase();
    if normalized_name != "exec_command" {
        return input;
    }
    let Some(obj) = input.as_object() else {
        return input;
    };

    let mut next = Map::new();
    if let Some(cmd) = read_trimmed_string_from_map(obj, "cmd")
        .or_else(|| read_trimmed_string_from_map(obj, "command"))
    {
        next.insert("cmd".to_string(), Value::String(cmd));
    }
    if let Some(justification) = read_trimmed_string_from_map(obj, "justification") {
        next.insert("justification".to_string(), Value::String(justification));
    }
    if next.is_empty() {
        Value::Object(obj.clone())
    } else {
        Value::Object(next)
    }
}

fn normalize_tool_use_item_as_text(obj: &Map<String, Value>) -> Option<String> {
    let tool_name = read_trimmed_string(obj.get("name")).unwrap_or_else(|| "tool_call".to_string());
    let tool_input = canonicalize_tool_input_for_prompt(
        tool_name.as_str(),
        obj.get("input")
            .cloned()
            .unwrap_or(Value::Object(Map::new())),
    );
    let mut tool_call = Map::new();
    if let Some(tool_id) = read_trimmed_string(obj.get("id"))
        .or_else(|| read_trimmed_string(obj.get("tool_use_id")))
        .or_else(|| read_trimmed_string(obj.get("tool_call_id")))
        .or_else(|| read_trimmed_string(obj.get("call_id")))
    {
        tool_call.insert("id".to_string(), Value::String(tool_id));
    }
    tool_call.insert("name".to_string(), Value::String(tool_name));
    tool_call.insert("arguments".to_string(), tool_input);
    let serialized = serde_json::to_string(&Value::Object(tool_call)).ok()?;
    Some(wrap_tool_calls_json(serialized.as_str()))
}

pub(super) fn strip_text_tool_wrapper_noise(raw: &str) -> String {
    let mut text = raw.to_string();
    let patterns = [
        r"(?is)<\|ChunkingError\|>[\s\S]*?(?:<｜end▁of▁thinking｜>|<\|end▁of▁thinking\|>|$)",
        r"(?is)<｜end▁of▁thinking｜>",
        r"(?i)<｜Assistant｜>",
        r"(?i)<｜User｜>",
        r"(?i)<｜end▁of▁sentence｜>",
        r"(?i)</turn_aborted>",
        r"(?i)<turn_aborted>",
        r"(?im)^\s*Tool\s+[A-Za-z0-9_.-]+\s+does\s+not\s+exists\.\s*$",
        r"(?im)^\s*I cannot access your local files\.?\s*$",
        r"(?im)^\s*当前环境是沙箱隔离.*$",
        r"(?im)^\s*\[Tool-call reminder\].*$",
    ];
    for pattern in patterns {
        let Ok(re) = Regex::new(pattern) else {
            continue;
        };
        text = re.replace_all(text.as_str(), "").to_string();
    }
    text.trim().to_string()
}

pub(super) fn normalize_content_to_text(content: &Value) -> String {
    if let Some(raw) = content.as_str() {
        return strip_text_tool_wrapper_noise(sanitize_user_visible_text(raw).as_str());
    }
    if content.is_null() {
        return String::new();
    }
    let Some(parts) = content.as_array() else {
        return stringify_unknown(content);
    };
    let mut out: Vec<String> = Vec::new();
    for item in parts {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let normalized_type = read_trimmed_string(obj.get("type"))
            .map(|v| v.to_ascii_lowercase())
            .unwrap_or_default();
        if (normalized_type == "text"
            || normalized_type == "input_text"
            || normalized_type == "output_text"
            || normalized_type == "text_delta")
            && read_trimmed_string(obj.get("text")).is_some()
        {
            let text = sanitize_user_visible_text(
                read_trimmed_string(obj.get("text"))
                    .unwrap_or_default()
                    .as_str(),
            );
            if !text.is_empty() {
                out.push(text);
            }
            continue;
        }
        if read_trimmed_string(obj.get("text")).is_some() {
            let text = sanitize_user_visible_text(
                read_trimmed_string(obj.get("text"))
                    .unwrap_or_default()
                    .as_str(),
            );
            if !text.is_empty() {
                out.push(text);
            }
            continue;
        }
        if read_trimmed_string(obj.get("content")).is_some() {
            let text = sanitize_user_visible_text(
                read_trimmed_string(obj.get("content"))
                    .unwrap_or_default()
                    .as_str(),
            );
            if !text.is_empty() {
                out.push(text);
            }
            continue;
        }
        if normalized_type == "tool_use" {
            if let Some(tool_use_text) = normalize_tool_use_item_as_text(obj) {
                out.push(tool_use_text);
                continue;
            }
        }
        if normalized_type == "tool_result" && obj.get("content").is_some() {
            let tool_output =
                normalize_tool_result_text(obj.get("content").unwrap_or(&Value::Null));
            if tool_output.is_empty() {
                out.push(empty_tool_output_placeholder().to_string());
            } else {
                out.push(tool_output);
            }
        }
    }
    strip_text_tool_wrapper_noise(out.join("\n").as_str())
}

pub(super) fn normalize_tool_message_to_text(obj: &Map<String, Value>) -> String {
    let output = normalize_tool_result_text(obj.get("content").unwrap_or(&Value::Null));
    if output.is_empty() {
        return empty_tool_output_placeholder().to_string();
    }
    let tool_call_id = read_trimmed_string(obj.get("tool_call_id"))
        .or_else(|| read_trimmed_string(obj.get("tool_use_id")))
        .or_else(|| read_trimmed_string(obj.get("call_id")))
        .or_else(|| read_trimmed_string(obj.get("id")));
    let tool_name = read_trimmed_string(obj.get("name"));
    format_tool_result_resume_text(
        tool_call_id.as_deref(),
        tool_name.as_deref(),
        output.as_str(),
    )
}

pub(super) fn normalize_tool_calls_as_text(tool_calls_raw: Option<&Value>) -> String {
    let Some(rows) = tool_calls_raw.and_then(|v| v.as_array()) else {
        return String::new();
    };
    if rows.is_empty() {
        return String::new();
    }
    let mut tool_calls: Vec<String> = Vec::new();
    for item in rows {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let fn_obj = obj.get("function").and_then(|v| v.as_object());
        let name = read_trimmed_string(fn_obj.and_then(|f| f.get("name")));
        let Some(name) = name else {
            continue;
        };
        let args_raw = fn_obj.and_then(|f| f.get("arguments"));
        let input = if let Some(raw_args) = args_raw {
            if let Some(raw_text) = raw_args.as_str() {
                let trimmed = raw_text.trim();
                if trimmed.is_empty() {
                    json!({})
                } else {
                    serde_json::from_str::<Value>(trimmed)
                        .unwrap_or_else(|_| json!({ "_raw": trimmed }))
                }
            } else {
                raw_args.clone()
            }
        } else {
            json!({})
        };
        let mut tool_call = Map::new();
        if let Some(tool_id) = read_trimmed_string(obj.get("id"))
            .or_else(|| read_trimmed_string(obj.get("tool_call_id")))
            .or_else(|| read_trimmed_string(obj.get("call_id")))
        {
            tool_call.insert("id".to_string(), Value::String(tool_id));
        }
        tool_call.insert("name".to_string(), Value::String(name.clone()));
        tool_call.insert(
            "arguments".to_string(),
            canonicalize_tool_input_for_prompt(name.as_str(), input),
        );
        let serialized = serde_json::to_string(&Value::Object(tool_call)).unwrap_or_default();
        if !serialized.is_empty() {
            tool_calls.push(wrap_tool_calls_json(serialized.as_str()));
        }
    }
    if tool_calls.is_empty() {
        return String::new();
    }
    tool_calls.join("\n")
}

#[cfg(test)]
mod tests {
    use super::{normalize_content_to_text, normalize_tool_message_to_text};
    use serde_json::json;

    #[test]
    fn deepseek_prompt_content_drops_unified_exec_capacity_warning() {
        let content = json!("Warning: The maximum number of unified exec processes you can keep open is 60 and you currently have 64 processes open. Reuse older processes or close them to prevent automatic pruning of old processes");
        assert_eq!(normalize_content_to_text(&content), "");
    }

    #[test]
    fn deepseek_prompt_content_falls_back_for_empty_tool_result() {
        let content = json!([
            {
                "type": "tool_result",
                "tool_use_id": "call_1",
                "content": ""
            }
        ]);
        assert_eq!(
            normalize_content_to_text(&content),
            "[RouteCodex] Tool output was empty; execution status unknown."
        );
    }

    #[test]
    fn deepseek_tool_message_keeps_call_pairing_fields() {
        let message = json!({
            "role": "tool",
            "tool_call_id": "call_1",
            "name": "exec_command",
            "content": "{\"stdout\":\"/tmp\",\"exit_code\":0}"
        });
        let obj = message.as_object().expect("tool message object");
        let text = normalize_tool_message_to_text(obj);
        assert!(text.contains("tool_call_id: call_1"));
        assert!(text.contains("tool_name: exec_command"));
        assert!(text.contains("output:\n{\"stdout\":\"/tmp\",\"exit_code\":0}"));
    }

    #[test]
    fn deepseek_prompt_content_unwraps_chunked_exec_transcript_shape() {
        let content = json!("Command: /bin/bash -lc 'echo ok'\nChunk ID: test\nWall time: 0.1s\nProcess exited with code 0\nOriginal token count: 12\nOutput:\nok\n");
        assert_eq!(normalize_content_to_text(&content), "ok");
    }

    #[test]
    fn deepseek_prompt_content_unwraps_running_chunked_exec_transcript_shape() {
        let content = json!("Chunk ID: 8297fb\nWall time: 10.0016 seconds\nProcess running with session ID 92528\nOriginal token count: 0\nOutput:\n<｜end▁of▁sentence｜>\n<｜Assistant｜><tool_call>\n{\"arguments\":{\"cmd\":\"echo next\"},\"id\":\"call_1\",\"name\":\"exec_command\"}\n</tool_call>");
        assert_eq!(normalize_content_to_text(&content), "");
    }

    #[test]
    fn deepseek_tool_message_drops_ran_transcript_shape_from_context() {
        let message = json!({
            "role": "tool",
            "tool_call_id": "call_1",
            "name": "exec_command",
            "content": "• Ran bash -lc 'python3 -c \"broken\"'\n  └ File \"<string>\", line 1\n    SyntaxError: invalid syntax\n"
        });
        let obj = message.as_object().expect("tool message object");
        let text = normalize_tool_message_to_text(obj);
        assert_eq!(
            text,
            "[RouteCodex] Tool output was empty; execution status unknown."
        );
        assert!(!text.contains("• Ran bash -lc"));
        assert!(!text.contains("SyntaxError"));
    }

    #[test]
    fn deepseek_prompt_content_drops_ran_transcript_shape_from_context() {
        let content = json!("• Ran cd /Volumes/extension/code/zterm/android && python3 << 'PYFIX'\n  │ import re\n  │ if 'type: 'CREATE_SESSION'' in line:\n  │ … +10 lines\n  └ File \"<stdin>\", line 21\n    SyntaxError: invalid syntax\n");
        assert_eq!(normalize_content_to_text(&content), "");
    }

    #[test]
    fn deepseek_prompt_content_strips_terminal_right_gutter_noise() {
        let content = json!(
            "Updated Plan                       │··········································\n• Updated Plan                                          │··········································\n  └ 继续执行修复：修改 scheduler.rs 使 running 状态不再 │··········································\n    阻塞 dispatch_ready_task                            │··········································\n"
        );
        let text = normalize_content_to_text(&content);
        assert!(text.contains("Updated Plan"));
        assert!(text.contains("继续执行修复：修改 scheduler.rs 使 running 状态不再"));
        assert!(!text.contains("│····"));
        assert!(!text.contains("······"));
    }

    #[test]
    fn deepseek_tool_message_strips_terminal_right_gutter_noise() {
        let message = json!({
            "role": "tool",
            "tool_call_id": "call_1",
            "name": "exec_command",
            "content": "Chunk ID: test\nWall time: 0.0 seconds\nProcess exited with code 1\nOriginal token count: 0\nOutput:\n  File \"<stdin>\", line 21                                                    │··········································\n    SyntaxError: invalid syntax                                               │··········································\n"
        });
        let obj = message.as_object().expect("tool message object");
        let text = normalize_tool_message_to_text(obj);
        assert!(text.contains("File \"<stdin>\", line 21"));
        assert!(text.contains("SyntaxError: invalid syntax"));
        assert!(!text.contains("│····"));
        assert!(!text.contains("······"));
    }
}

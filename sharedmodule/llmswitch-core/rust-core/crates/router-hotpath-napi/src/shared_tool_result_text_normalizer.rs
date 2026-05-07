use regex::Regex;
use serde_json::Value;

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

fn transcript_tree_marker(line: &str) -> Option<char> {
    line.trim_start().chars().next().filter(|ch| matches!(ch, '│' | '└' | '├'))
}

fn unwrap_ran_transcript_shape(raw: &str) -> Option<String> {
    let lines: Vec<&str> = raw.lines().collect();
    let first = lines.first()?.trim_start();
    if !first.starts_with("• Ran ") {
        return None;
    }
    if lines.len() < 2 {
        return None;
    }
    let has_tree_body = lines.iter().skip(1).any(|line| {
        Regex::new(r"^[\s]*[│└├]")
            .map(|re| re.is_match(line))
            .unwrap_or(false)
    });
    if !has_tree_body {
        return None;
    }

    let mut out: Vec<String> = Vec::new();
    for line in lines.iter().skip(1) {
        if is_transcript_collapsed_placeholder(line) {
            continue;
        }
        match transcript_tree_marker(line) {
            Some('└') => {}
            Some('│') | Some('├') => continue,
            _ => {}
        }
        let stripped = strip_box_drawing_prefix(line).trim().to_string();
        if stripped.is_empty() || stripped.eq_ignore_ascii_case("(ctrl + t to view transcript)") {
            continue;
        }
        out.push(stripped);
    }
    let text = out.join("\n").trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn is_chunked_exec_transcript_header_line(line: &str) -> bool {
    Regex::new(
        r"(?i)^(?:\[工具结果\]|Command:\s+.*|Chunk ID:\s+.*|Wall time:\s+.*|Process exited with code\s+.*|Process running with session ID\s+.*|Original token count:\s+.*)$",
    )
    .map(|re| re.is_match(line.trim()))
    .unwrap_or(false)
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
    Some(
        lines
            .iter()
            .skip(output_idx + 1)
            .copied()
            .collect::<Vec<&str>>()
            .join("\n")
            .trim()
            .to_string(),
    )
}

pub(crate) fn normalize_tool_result_text(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let without_gutter = trimmed
        .lines()
        .map(strip_terminal_right_gutter_noise)
        .collect::<Vec<String>>()
        .join("\n");
    if let Some(unwrapped) = unwrap_chunked_exec_transcript_shape(without_gutter.as_str()) {
        return unwrapped;
    }
    if let Some(unwrapped) = unwrap_ran_transcript_shape(without_gutter.as_str()) {
        return unwrapped;
    }
    without_gutter.trim().to_string()
}

pub(crate) fn normalize_tool_result_value(value: &Value) -> String {
    match value {
        Value::String(text) => normalize_tool_result_text(text),
        Value::Null => String::new(),
        other => serde_json::to_string(other)
            .ok()
            .map(|text| normalize_tool_result_text(text.as_str()))
            .unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::{normalize_tool_result_text, normalize_tool_result_value};
    use serde_json::json;

    #[test]
    fn strips_chunked_exec_transcript_wrapper() {
        let raw = "Chunk ID: 93f309\nWall time: 0.0000 seconds\nProcess exited with code 0\nOriginal token count: 2221\nOutput:\nalpha\nbeta\n";
        assert_eq!(normalize_tool_result_text(raw), "alpha\nbeta");
    }

    #[test]
    fn strips_ran_tree_wrapper_and_right_gutter() {
        let raw = "• Ran bash -lc 'python3 demo.py'                                  │··········\n  └ File \"<stdin>\", line 3                                        │··········\n    SyntaxError: invalid syntax                                     │··········\n";
        assert_eq!(
            normalize_tool_result_text(raw),
            "File \"<stdin>\", line 3\nSyntaxError: invalid syntax"
        );
    }

    #[test]
    fn strips_ran_command_preview_and_keeps_only_tree_output_payload() {
        let raw = r#"• Ran bash -lc 'cd /Volumes/extension/code/zterm/android && sed -i "" "/import
  │ { SessionStore } from/a                                                     
  │ import { BufferSyncEngine } from '''../lib/buffer/BufferSyncEngine''';      
  └ sed: 1: "/import { SessionStore  ...": command a expects \ followed by text
"#;
        assert_eq!(
            normalize_tool_result_text(raw),
            r#"sed: 1: "/import { SessionStore  ...": command a expects \ followed by text"#
        );
    }

    #[test]
    fn normalizes_non_string_values_without_changing_plain_json_shape() {
        let value = json!({"stdout":"ok","status":"completed"});
        let normalized = normalize_tool_result_value(&value);
        let parsed: serde_json::Value =
            serde_json::from_str(normalized.as_str()).expect("normalized json");
        assert_eq!(parsed, value);
    }
}

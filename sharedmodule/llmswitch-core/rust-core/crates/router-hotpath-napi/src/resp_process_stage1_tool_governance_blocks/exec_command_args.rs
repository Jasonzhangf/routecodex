use regex::Regex;
use serde_json::{Map, Value};

use crate::resp_process_stage1_tool_governance_blocks::json_args::read_string_array_command;
use crate::shared_json_utils::read_trimmed_string;

pub(crate) fn read_command_from_args(args: &Map<String, Value>) -> Option<String> {
    let input = args.get("input");
    let read_value = |value: Option<&Value>| -> Option<String> {
        read_trimmed_string(value).or_else(|| read_string_array_command(value))
    };
    let direct = read_value(args.get("cmd"))
        .or_else(|| read_value(args.get("command")))
        .or_else(|| read_value(args.get("script")))
        .or_else(|| read_value(args.get("toon")))
        .or_else(|| read_value(args.get("input")))
        .or_else(|| read_value(args.get("text")));
    if direct.is_some() {
        return direct;
    }
    input
        .and_then(Value::as_object)
        .and_then(|input_row| {
            read_value(input_row.get("cmd"))
                .or_else(|| read_value(input_row.get("command")))
                .or_else(|| read_value(input_row.get("script")))
                .or_else(|| read_value(input_row.get("toon")))
        })
        .or_else(|| {
            args.get("args")
                .and_then(Value::as_object)
                .and_then(|input_row| {
                    read_value(input_row.get("cmd"))
                        .or_else(|| read_value(input_row.get("command")))
                        .or_else(|| read_value(input_row.get("script")))
                        .or_else(|| read_value(input_row.get("toon")))
                })
        })
}

fn repair_shell_wrapper_shape(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let mut current = trimmed.to_string();
    if let Some(rest) = current.strip_prefix("bash-lc") {
        let next = rest.chars().next();
        if next.is_none() || next.is_some_and(|ch| ch.is_whitespace() || ch == '\'' || ch == '"') {
            current = format!("bash -lc{}", rest);
        }
    }
    if let Some(rest) = current.strip_prefix("bash -lc\"") {
        current = format!("bash -lc \"{}", rest);
    } else if let Some(rest) = current.strip_prefix("bash -lc'") {
        current = if rest.ends_with('\'') {
            format!("bash -lc '{}", rest)
        } else {
            format!("bash -lc '{}'", rest)
        };
    }

    current
}

fn find_matching_double_quote(raw: &str, start_idx: usize) -> Option<usize> {
    let bytes = raw.as_bytes();
    let mut idx = start_idx;
    let mut escaped = false;
    while idx < bytes.len() {
        let ch = bytes[idx] as char;
        if escaped {
            escaped = false;
            idx += 1;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            idx += 1;
            continue;
        }
        if ch == '"' {
            return Some(idx);
        }
        idx += 1;
    }
    None
}

fn looks_like_inline_interpreter_eval_prefix(raw: &str) -> bool {
    Regex::new(
        r#"(?is)\b(?:node|bun|deno|python|python2|python3|python\d+(?:\.\d+)?|ruby|perl)\b[\s\S]*?(?:\s-e\b|\s-c\b|\s--eval\b)\s*$"#,
    )
    .map(|re| re.is_match(raw))
    .unwrap_or(false)
}

fn repair_bash_lc_inline_eval_single_quotes(raw: &str) -> String {
    let trimmed = raw.trim();
    let Some(inner) = trimmed
        .strip_prefix("bash -lc '")
        .and_then(|value| value.strip_suffix('\''))
    else {
        return trimmed.to_string();
    };

    let bytes = inner.as_bytes();
    let mut cursor = 0usize;
    let mut repaired = inner.to_string();
    let mut changed = false;

    while cursor < bytes.len() {
        let Some(rel_quote_idx) = inner[cursor..].find('"') else {
            break;
        };
        let quote_idx = cursor + rel_quote_idx;
        let prefix = inner[..quote_idx].trim_end_matches('\\').trim_end();
        if !looks_like_inline_interpreter_eval_prefix(prefix) {
            cursor = quote_idx + 1;
            continue;
        }
        let end_quote_idx = inner
            .rfind('"')
            .filter(|idx| *idx > quote_idx)
            .or_else(|| find_matching_double_quote(inner, quote_idx + 1));
        let Some(end_quote_idx) = end_quote_idx else {
            break;
        };
        let code = &inner[quote_idx + 1..end_quote_idx];
        if code.contains('\'') {
            let escaped_code = code.replace('\'', "'\\''");
            repaired = format!(
                "{}{}{}",
                &inner[..quote_idx + 1],
                escaped_code,
                &inner[end_quote_idx..]
            );
            changed = true;
        }
        cursor = end_quote_idx + 1;
    }

    if changed {
        format!("bash -lc '{}'", repaired)
    } else {
        trimmed.to_string()
    }
}

fn looks_like_python_heredoc_command(raw: &str) -> bool {
    let lowered = raw.to_ascii_lowercase();
    if !lowered.contains("python") {
        return false;
    }
    lowered.contains("<<")
        || lowered.contains("pyeof")
        || lowered.contains("with open\\(")
        || lowered.contains("print\\(")
        || lowered.contains("read\\(")
        || lowered.contains("write\\(")
}

pub(crate) fn strip_python_heredoc_pseudo_escapes(raw: &str) -> String {
    if !looks_like_python_heredoc_command(raw) {
        return raw.to_string();
    }
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            if let Some(next) = chars.peek().copied() {
                if matches!(next, '(' | ')' | '\'' | '"') {
                    out.push(next);
                    chars.next();
                    continue;
                }
            }
        }
        out.push(ch);
    }
    out
}

pub(crate) fn normalize_exec_command_text(raw: &str) -> String {
    let repaired = repair_shell_wrapper_shape(raw);
    let repaired = repair_bash_lc_inline_eval_single_quotes(repaired.as_str());
    strip_python_heredoc_pseudo_escapes(repaired.as_str())
}

pub(crate) fn args_contain_direct_or_nested_key(args: &Map<String, Value>, key: &str) -> bool {
    if args.contains_key(key) {
        return true;
    }
    ["input", "args"].iter().any(|container_key| {
        args.get(*container_key)
            .and_then(Value::as_object)
            .map(|row| row.contains_key(key))
            .unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::read_command_from_args;
    use crate::shared_json_utils::read_workdir_from_args;
    use serde_json::json;

    #[test]
    fn shared_read_workdir_from_args_reads_nested_input_cwd() {
        let args = json!({
            "input": {
                "cwd": "/tmp/nested"
            }
        });
        let row = args.as_object().expect("args object");
        assert_eq!(read_workdir_from_args(row), Some("/tmp/nested".to_string()));
    }

    #[test]
    fn read_command_from_args_preserves_toon_alias_shape() {
        let args = json!({
            "args": {
                "toon": "pwd"
            }
        });
        let row = args.as_object().expect("args object");
        assert_eq!(read_command_from_args(row), Some("pwd".to_string()));
    }
}

use regex::Regex;
use serde_json::{Map, Value};

use crate::resp_process_stage1_tool_governance_blocks::json_args::read_string_array_command;
use crate::shared_json_utils::read_trimmed_string;
use crate::shared_tooling::repair_find_meta_impl;

fn is_object_with_command_field(value: &Value) -> bool {
    value
        .as_object()
        .map(|row| {
            ["cmd", "command", "toon", "script"]
                .iter()
                .any(|key| row.contains_key(*key))
        })
        .unwrap_or(false)
}

fn object_or_empty(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn unwrap_exec_args_shape(value: &Value) -> Map<String, Value> {
    let Some(row) = value.as_object() else {
        return Map::new();
    };
    if is_object_with_command_field(value) {
        return row.clone();
    }

    let nested = row
        .get("input")
        .filter(|nested| is_object_with_command_field(nested))
        .or_else(|| {
            row.get("arguments")
                .filter(|nested| is_object_with_command_field(nested))
        });
    let Some(nested) = nested.and_then(Value::as_object) else {
        return row.clone();
    };

    let mut out = nested.clone();
    for (key, value) in row {
        out.insert(key.clone(), value.clone());
    }
    out
}

fn as_non_empty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn as_primitive_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(raw) => {
            let trimmed = raw.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

fn as_finite_number(value: Option<&Value>) -> Option<Value> {
    match value? {
        Value::Number(number) if number.as_f64().is_some_and(f64::is_finite) => {
            Some(Value::Number(number.clone()))
        }
        _ => None,
    }
}

fn as_boolean(value: Option<&Value>) -> Option<bool> {
    value.and_then(Value::as_bool)
}

fn as_string_array_joined(value: Option<&Value>) -> Option<String> {
    let items = value?.as_array()?;
    let out: Vec<String> = items
        .iter()
        .filter_map(|entry| {
            if entry.is_null() {
                return None;
            }
            let raw = match entry {
                Value::String(value) => value.clone(),
                other => other.to_string(),
            };
            let trimmed = raw.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        })
        .collect();
    (!out.is_empty()).then(|| out.join(" "))
}

fn normalize_exec_command_args(args: &Value, schema_mode: Option<&str>) -> Value {
    let canonical_only = schema_mode == Some("canonical");
    let mut base = if canonical_only {
        object_or_empty(args)
    } else {
        unwrap_exec_args_shape(args)
    };

    let cmd_candidate = if canonical_only {
        as_non_empty_string(base.get("cmd"))
    } else {
        as_primitive_string(base.get("cmd"))
            .or_else(|| as_primitive_string(base.get("command")))
            .or_else(|| as_primitive_string(base.get("toon")))
            .or_else(|| as_primitive_string(base.get("script")))
            .or_else(|| as_string_array_joined(base.get("command")))
            .or_else(|| as_string_array_joined(base.get("cmd")))
    };

    base.remove("toon");

    let Some(cmd) = cmd_candidate else {
        return serde_json::json!({
            "ok": false,
            "reason": "missing_cmd",
            "normalized": Value::Object(base),
        });
    };

    let mut normalized = Map::new();
    normalized.insert(
        "cmd".to_string(),
        Value::String(repair_find_meta_impl(cmd.as_str())),
    );

    let workdir = if canonical_only {
        as_non_empty_string(base.get("workdir"))
    } else {
        as_non_empty_string(base.get("workdir"))
            .or_else(|| as_non_empty_string(base.get("cwd")))
            .or_else(|| as_non_empty_string(base.get("workDir")))
    };
    if let Some(value) = workdir {
        normalized.insert("workdir".to_string(), Value::String(value));
    }
    if let Some(value) = as_boolean(base.get("login")) {
        normalized.insert("login".to_string(), Value::Bool(value));
    }
    if let Some(value) = as_boolean(base.get("tty")) {
        normalized.insert("tty".to_string(), Value::Bool(value));
    }
    let timeout_ms = if canonical_only {
        as_finite_number(base.get("timeout_ms"))
    } else {
        as_finite_number(base.get("timeout_ms")).or_else(|| as_finite_number(base.get("timeoutMs")))
    };
    if let Some(value) = timeout_ms {
        normalized.insert("timeout_ms".to_string(), value);
    }
    if let Some(value) = as_non_empty_string(base.get("shell")) {
        normalized.insert("shell".to_string(), Value::String(value));
    }
    let sandbox_permissions = if canonical_only {
        as_non_empty_string(base.get("sandbox_permissions"))
    } else {
        as_non_empty_string(base.get("sandbox_permissions")).or_else(|| {
            (as_boolean(base.get("with_escalated_permissions")) == Some(true))
                .then(|| "require_escalated".to_string())
        })
    };
    if let Some(value) = sandbox_permissions {
        normalized.insert("sandbox_permissions".to_string(), Value::String(value));
    }
    if let Some(value) = as_non_empty_string(base.get("justification")) {
        normalized.insert("justification".to_string(), Value::String(value));
    }
    let max_output_tokens = if canonical_only {
        as_finite_number(base.get("max_output_tokens"))
    } else {
        as_finite_number(base.get("max_output_tokens"))
            .or_else(|| as_finite_number(base.get("max_tokens")))
    };
    if let Some(value) = max_output_tokens {
        normalized.insert("max_output_tokens".to_string(), value);
    }
    let yield_time_ms = if canonical_only {
        as_finite_number(base.get("yield_time_ms"))
    } else {
        as_finite_number(base.get("yield_time_ms"))
            .or_else(|| as_finite_number(base.get("yield_ms")))
            .or_else(|| as_finite_number(base.get("wait_ms")))
    };
    if let Some(value) = yield_time_ms {
        normalized.insert("yield_time_ms".to_string(), value);
    }

    serde_json::json!({
        "ok": true,
        "normalized": Value::Object(normalized),
    })
}

pub(crate) fn normalize_exec_command_args_json(input_json: String) -> napi::Result<String> {
    let input: Value = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::new(napi::Status::InvalidArg, e.to_string()))?;
    let schema_mode = input.get("schemaMode").and_then(Value::as_str);
    let args = input.get("args").unwrap_or(&Value::Null);
    serde_json::to_string(&normalize_exec_command_args(args, schema_mode))
        .map_err(|e| napi::Error::new(napi::Status::GenericFailure, e.to_string()))
}

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
    use super::{normalize_exec_command_args, read_command_from_args};
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

    #[test]
    fn normalize_exec_command_args_is_native_owned() {
        let result = normalize_exec_command_args(
            &json!({"input": {"cmd": "pwd", "workdir": "/workspace"}}),
            Some("compat"),
        );
        assert_eq!(result["ok"], true);
        assert_eq!(result["normalized"]["cmd"], "pwd");
        assert_eq!(result["normalized"]["workdir"], "/workspace");

        let result = normalize_exec_command_args(
            &json!({"arguments": {"command": "ls -la", "yield_time_ms": 500}}),
            Some("compat"),
        );
        assert_eq!(result["ok"], true);
        assert_eq!(result["normalized"]["cmd"], "ls -la");
        assert_eq!(result["normalized"]["yield_time_ms"], 500);

        let result = normalize_exec_command_args(
            &json!({
                "command": ["echo", "hello"],
                "cwd": "/tmp",
                "timeoutMs": 100,
                "max_tokens": 200,
                "yield_ms": 300,
                "with_escalated_permissions": true
            }),
            Some("compat"),
        );
        assert_eq!(result["ok"], true);
        assert_eq!(result["normalized"]["cmd"], "echo hello");
        assert_eq!(result["normalized"]["workdir"], "/tmp");
        assert_eq!(result["normalized"]["timeout_ms"], 100);
        assert_eq!(result["normalized"]["max_output_tokens"], 200);
        assert_eq!(result["normalized"]["yield_time_ms"], 300);
        assert_eq!(
            result["normalized"]["sandbox_permissions"],
            "require_escalated"
        );
        assert!(result["normalized"].get("toon").is_none());

        let result = normalize_exec_command_args(&json!({"toon": "pwd"}), Some("compat"));
        assert_eq!(result["ok"], true);
        assert_eq!(result["normalized"]["cmd"], "pwd");
        assert!(result["normalized"].get("toon").is_none());

        let result = normalize_exec_command_args(
            &json!({"command": "ls -la", "yield_time_ms": 500}),
            Some("canonical"),
        );
        assert_eq!(result["ok"], false);
        assert_eq!(result["reason"], "missing_cmd");
        assert!(result["normalized"].get("toon").is_none());

        let result = normalize_exec_command_args(
            &json!({"input": {"cmd": "pwd", "workdir": "/workspace"}}),
            Some("canonical"),
        );
        assert_eq!(result["ok"], false);
        assert_eq!(result["reason"], "missing_cmd");
    }
}

use serde_json::{json, Map, Value};

use crate::resp_process_stage1_tool_governance_blocks::apply_patch_schema_args::normalize_apply_patch_schema_args;
use crate::resp_process_stage1_tool_governance_blocks::exec_command_args::{
    args_contain_direct_or_nested_key, normalize_exec_command_text, read_command_from_args,
    read_workdir_from_args,
};
use crate::resp_process_stage1_tool_governance_blocks::exec_command_guard::{
    build_exec_command_large_write_guard_command, build_exec_command_object_with_shape,
    exec_command_heredoc_preview_chars, is_large_heredoc_file_generation_command,
    maybe_guard_large_exec_command_from_raw_string, truncate_preview,
};
use crate::resp_process_stage1_tool_governance_blocks::json_args::parse_json_record;
use crate::resp_process_stage1_tool_governance_blocks::tool_names::normalize_tool_name;
pub(crate) fn infer_tool_name_from_args(raw_args: Option<&Value>) -> Option<String> {
    let args = parse_json_record(raw_args).unwrap_or_default();
    if args.is_empty() {
        return None;
    }

    let has_plan = args
        .get("plan")
        .and_then(Value::as_array)
        .map(|rows| !rows.is_empty())
        .unwrap_or(false);
    let has_explanation = args
        .get("explanation")
        .and_then(Value::as_str)
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    if has_plan || has_explanation {
        return Some("update_plan".to_string());
    }

    let has_view_path = args
        .get("path")
        .and_then(Value::as_str)
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    if has_view_path {
        return Some("view_image".to_string());
    }

    let has_session_id = args.get("session_id").is_some() || args.get("sessionId").is_some();
    let has_chars = args.get("chars").is_some()
        || args.get("text").is_some()
        || args.get("data").is_some()
        || args.get("input").is_some();
    if has_session_id && has_chars {
        return Some("write_stdin".to_string());
    }

    None
}

pub(crate) fn normalize_tool_args(tool_name: &str, raw_args: Option<&Value>) -> Option<String> {
    let source_tool_name = tool_name.trim().to_ascii_lowercase();
    let source_is_shell_alias = matches!(
        source_tool_name.as_str(),
        "shell_command" | "shell" | "bash" | "terminal" | "execute_command" | "execute-command"
    );
    let name = normalize_tool_name(tool_name)?;
    let args = parse_json_record(raw_args).unwrap_or_default();
    if name == "exec_command" {
        if let Some(guarded) = maybe_guard_large_exec_command_from_raw_string(
            raw_args,
            source_is_shell_alias,
            |guard, force_cmd, force_command| {
                build_exec_command_object_with_shape(
                    guard,
                    None,
                    source_is_shell_alias,
                    force_cmd,
                    force_command,
                    args_contain_direct_or_nested_key,
                    read_workdir_from_args,
                )
            },
        ) {
            return Some(guarded);
        }
        let mut cmd = normalize_exec_command_text(read_command_from_args(&args)?.as_str());
        if is_large_heredoc_file_generation_command(cmd.as_str()) {
            let preview = truncate_preview(cmd.as_str(), exec_command_heredoc_preview_chars());
            cmd = build_exec_command_large_write_guard_command(preview.as_str());
        }
        let read_nested_value = |keys: &[&str]| -> Option<Value> {
            for key in keys {
                if let Some(value) = args.get(*key) {
                    return Some(value.clone());
                }
            }
            for container_key in ["input", "args"] {
                let Some(container) = args.get(container_key).and_then(Value::as_object) else {
                    continue;
                };
                for key in keys {
                    if let Some(value) = container.get(*key) {
                        return Some(value.clone());
                    }
                }
            }
            None
        };
        let read_i64_value = |keys: &[&str]| -> Option<Value> {
            match read_nested_value(keys)? {
                Value::Number(n) => Some(Value::Number(n)),
                Value::String(raw) => raw
                    .trim()
                    .parse::<i64>()
                    .ok()
                    .map(|v| Value::Number(v.into())),
                _ => None,
            }
        };
        let read_bool_value = |keys: &[&str]| -> Option<Value> {
            match read_nested_value(keys)? {
                Value::Bool(v) => Some(Value::Bool(v)),
                Value::String(raw) => match raw.trim().to_ascii_lowercase().as_str() {
                    "true" => Some(Value::Bool(true)),
                    "false" => Some(Value::Bool(false)),
                    _ => None,
                },
                _ => None,
            }
        };
        let read_string_value = |keys: &[&str]| -> Option<Value> {
            match read_nested_value(keys)? {
                Value::String(raw) => {
                    let trimmed = raw.trim();
                    if trimmed.is_empty() {
                        None
                    } else {
                        Some(Value::String(trimmed.to_string()))
                    }
                }
                _ => None,
            }
        };
        let read_string_array_value = |keys: &[&str]| -> Option<Value> {
            match read_nested_value(keys)? {
                Value::Array(items) => {
                    let normalized: Vec<Value> = items
                        .into_iter()
                        .filter_map(|item| match item {
                            Value::String(raw) => {
                                let trimmed = raw.trim();
                                if trimmed.is_empty() {
                                    None
                                } else {
                                    Some(Value::String(trimmed.to_string()))
                                }
                            }
                            _ => None,
                        })
                        .collect();
                    if normalized.is_empty() {
                        None
                    } else {
                        Some(Value::Array(normalized))
                    }
                }
                _ => None,
            }
        };
        let parsed = build_exec_command_object_with_shape(
            cmd,
            Some(&args),
            source_is_shell_alias,
            None,
            None,
            args_contain_direct_or_nested_key,
            read_workdir_from_args,
        )?;
        let mut out_value: Value = serde_json::from_str(parsed.as_str()).ok()?;
        let out = out_value.as_object_mut()?;

        for (key, value) in [
            ("yield_time_ms", read_i64_value(&["yield_time_ms"])),
            ("max_output_tokens", read_i64_value(&["max_output_tokens"])),
            ("tty", read_bool_value(&["tty"])),
            ("login", read_bool_value(&["login"])),
            ("justification", read_string_value(&["justification"])),
            ("shell", read_string_value(&["shell"])),
            (
                "sandbox_permissions",
                read_string_value(&["sandbox_permissions"]),
            ),
            ("prefix_rule", read_string_array_value(&["prefix_rule"])),
        ] {
            if let Some(value) = value {
                out.insert(key.to_string(), value);
            }
        }
        return serde_json::to_string(&out_value).ok();
    }

    if name == "write_stdin" {
        let mut out = Map::new();
        let session_id = args
            .get("session_id")
            .or_else(|| args.get("sessionId"))
            .and_then(|v| match v {
                Value::Number(_) => Some(v.clone()),
                Value::String(raw) => raw.parse::<i64>().ok().map(|n| Value::Number(n.into())),
                _ => None,
            })?;
        out.insert("session_id".to_string(), session_id);

        let chars = args
            .get("chars")
            .or_else(|| args.get("text"))
            .or_else(|| args.get("input"))
            .or_else(|| args.get("data"))
            .cloned()
            .unwrap_or(Value::String(String::new()));
        out.insert(
            "chars".to_string(),
            Value::String(match chars {
                Value::String(v) => v,
                other => other.to_string(),
            }),
        );

        return serde_json::to_string(&Value::Object(out)).ok();
    }

    if name == "update_plan" {
        let mut out = Map::new();
        if let Some(explanation) = args
            .get("explanation")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            out.insert(
                "explanation".to_string(),
                Value::String(explanation.to_string()),
            );
        }
        let source_plan = args
            .get("plan")
            .and_then(Value::as_array)
            .or_else(|| args.get("steps").and_then(Value::as_array));
        if let Some(rows) = source_plan {
            let normalized_rows: Vec<Value> = rows
                .iter()
                .filter_map(|row| {
                    if let Some(step_text) = row
                        .as_str()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                    {
                        return Some(json!({
                            "step": step_text,
                            "status": "pending",
                        }));
                    }
                    let obj = row.as_object()?;
                    let step = obj
                        .get("step")
                        .or_else(|| obj.get("name"))
                        .or_else(|| obj.get("title"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())?;
                    let status = obj
                        .get("status")
                        .or_else(|| obj.get("state"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())?;
                    Some(json!({
                        "step": step,
                        "status": status,
                    }))
                })
                .collect();
            if !normalized_rows.is_empty() {
                out.insert("plan".to_string(), Value::Array(normalized_rows));
            }
        }
        if out.contains_key("plan") {
            return serde_json::to_string(&Value::Object(out)).ok();
        }
    }

    if name == "apply_patch" {
        return Some(normalize_apply_patch_schema_args(raw_args).0);
    }

    serde_json::to_string(&Value::Object(args)).ok()
}

pub(crate) fn normalize_tool_args_preserving_raw_shape(
    tool_name: &str,
    raw_args: Option<&Value>,
) -> Option<String> {
    let canonical_name = normalize_tool_name(tool_name)?;
    if canonical_name != "exec_command" {
        return normalize_tool_args(tool_name, raw_args);
    }
    let source_tool_name = tool_name.trim().to_ascii_lowercase();
    let source_is_shell_alias = matches!(
        source_tool_name.as_str(),
        "shell_command" | "shell" | "bash" | "terminal" | "execute_command" | "execute-command"
    );
    if let Some(guarded) = maybe_guard_large_exec_command_from_raw_string(
        raw_args,
        source_is_shell_alias,
        |guard, force_cmd, force_command| {
            build_exec_command_object_with_shape(
                guard,
                None,
                source_is_shell_alias,
                force_cmd,
                force_command,
                args_contain_direct_or_nested_key,
                read_workdir_from_args,
            )
        },
    ) {
        return Some(guarded);
    }
    let args = parse_json_record(raw_args).unwrap_or_default();
    let cmd = read_command_from_args(&args)?;
    if is_large_heredoc_file_generation_command(cmd.as_str()) {
        let preview = truncate_preview(cmd.as_str(), exec_command_heredoc_preview_chars());
        let guard = build_exec_command_large_write_guard_command(preview.as_str());
        return build_exec_command_object_with_shape(
            guard,
            Some(&args),
            source_is_shell_alias,
            None,
            None,
            args_contain_direct_or_nested_key,
            read_workdir_from_args,
        );
    }
    serde_json::to_string(&Value::Object(args)).ok()
}

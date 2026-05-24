use serde_json::{Map, Value};

use crate::resp_process_stage1_tool_governance_blocks::apply_patch_schema_args::normalize_apply_patch_schema_args;
use crate::resp_process_stage1_tool_governance_blocks::requested_tools::{
    collect_requested_tool_name_keys, read_tool_call_name_key,
};
use crate::resp_process_stage1_tool_governance_blocks::text_harvest_strict::harvest_explicit_wrapper_only_tool_calls_from_payload;
use crate::resp_process_stage1_tool_governance_blocks::exec_command_args::{normalize_exec_command_text, read_command_from_args};
use crate::resp_process_stage1_tool_governance_blocks::json_args::parse_json_record;
use crate::resp_process_stage1_tool_governance_blocks::text_harvest_extract::looks_like_exec_command_candidate;
use crate::resp_process_stage1_tool_governance_blocks::tool_args::normalize_tool_args_preserving_raw_shape;
use crate::shared_json_utils::read_trimmed_string;

pub(crate) fn maybe_harvest_empty_tool_calls_from_json_content(payload: &mut Value) -> i64 {
    harvest_explicit_wrapper_only_tool_calls_from_payload(payload)
}

pub(crate) fn normalize_apply_patch_tool_calls(payload: &mut Value) -> i64 {
    let mut repaired = 0i64;
    let Some(choices) = payload.get_mut("choices").and_then(|v| v.as_array_mut()) else {
        return repaired;
    };

    for choice in choices {
        let Some(message) = choice.get_mut("message").and_then(|v| v.as_object_mut()) else {
            continue;
        };
        let Some(tool_calls) = message.get_mut("tool_calls").and_then(|v| v.as_array_mut()) else {
            continue;
        };

        for tool_call in tool_calls.iter_mut() {
            let Some(function) = tool_call
                .get_mut("function")
                .and_then(|v| v.as_object_mut())
            else {
                continue;
            };
            let Some(name) = read_trimmed_string(function.get("name")) else {
                continue;
            };
            if name.to_ascii_lowercase() != "apply_patch" {
                continue;
            }

            let normalized = normalize_apply_patch_schema_args(function.get("arguments"));
            let next = Value::String(normalized.0);
            let should_count = normalized.1
                || function
                    .get("arguments")
                    .map(|args| args != &next)
                    .unwrap_or(true);
            function.insert("arguments".to_string(), next);
            if should_count {
                repaired += 1;
            }
        }
    }

    repaired
}

pub(crate) fn drop_disallowed_tool_calls_from_payload(payload: &mut Value) -> i64 {
    let requested_tool_name_keys = collect_requested_tool_name_keys(payload);
    if requested_tool_name_keys.is_empty() {
        return 0;
    }

    let mut dropped = 0i64;
    let Some(choices) = payload.get_mut("choices").and_then(|v| v.as_array_mut()) else {
        return dropped;
    };

    for choice in choices {
        let Some(choice_row) = choice.as_object_mut() else {
            continue;
        };
        let Some(message) = choice_row
            .get_mut("message")
            .and_then(|v| v.as_object_mut())
        else {
            continue;
        };
        let Some(tool_calls) = message.get_mut("tool_calls").and_then(|v| v.as_array_mut()) else {
            continue;
        };

        let before = tool_calls.len();
        tool_calls.retain(|entry| {
            read_tool_call_name_key(entry)
                .map(|key| requested_tool_name_keys.contains(key.as_str()))
                .unwrap_or(false)
        });
        dropped += (before.saturating_sub(tool_calls.len())) as i64;
        if before > 0 && tool_calls.is_empty() {
            let finish_reason = read_trimmed_string(choice_row.get("finish_reason"))
                .unwrap_or_default()
                .to_ascii_lowercase();
            if finish_reason == "tool_calls" {
                choice_row.insert(
                    "finish_reason".to_string(),
                    Value::String("stop".to_string()),
                );
            }
        }
    }

    dropped
}

fn maybe_repair_malformed_exec_command_name(function: &mut Map<String, Value>) -> bool {
    let Some(raw_name) = read_trimmed_string(function.get("name")) else {
        return false;
    };
    let lowered = raw_name.to_ascii_lowercase();
    if matches!(
        lowered.as_str(),
        "exec_command" | "shell_command" | "shell" | "bash" | "terminal"
    ) {
        return false;
    }
    if !looks_like_exec_command_candidate(raw_name.as_str()) {
        return false;
    }

    let mut args = parse_json_record(function.get("arguments")).unwrap_or_default();
    if read_command_from_args(&args).is_some() {
        return false;
    }

    args.insert(
        "cmd".to_string(),
        Value::String(normalize_exec_command_text(raw_name.as_str())),
    );
    let Ok(arguments) = serde_json::to_string(&Value::Object(args)) else {
        return false;
    };

    function.insert(
        "name".to_string(),
        Value::String("exec_command".to_string()),
    );
    function.insert("arguments".to_string(), Value::String(arguments));
    true
}

pub(crate) fn remap_tool_calls_for_client_protocol(payload: &mut Value, client_protocol: &str) {
    let protocol = client_protocol.trim().to_ascii_lowercase();
    let wants_anthropic_shell = protocol == "anthropic-messages";
    let wants_exec_command_cmd = matches!(
        protocol.as_str(),
        "openai-responses" | "openai-chat" | "anthropic-messages"
    );
    let Some(choices) = payload.get_mut("choices").and_then(|v| v.as_array_mut()) else {
        return;
    };

    for choice in choices {
        let Some(tool_calls) = choice
            .get_mut("message")
            .and_then(|v| v.as_object_mut())
            .and_then(|message| message.get_mut("tool_calls"))
            .and_then(|v| v.as_array_mut())
        else {
            continue;
        };

        for tool_call in tool_calls {
            let Some(function) = tool_call
                .get_mut("function")
                .and_then(|v| v.as_object_mut())
            else {
                continue;
            };
            let _ = maybe_repair_malformed_exec_command_name(function);
            let Some(name) = read_trimmed_string(function.get("name")) else {
                continue;
            };
            let lowered = name.to_ascii_lowercase();
            let is_shell_alias = matches!(
                lowered.as_str(),
                "shell_command" | "shell" | "bash" | "terminal"
            );
            let is_exec_command = lowered == "exec_command";
            if !is_shell_alias && !is_exec_command {
                continue;
            }

            let target_name = if wants_anthropic_shell {
                if is_shell_alias {
                    "shell_command"
                } else {
                    "exec_command"
                }
            } else {
                "exec_command"
            };
            function.insert("name".to_string(), Value::String(target_name.to_string()));

            let Some(arguments) = function.get("arguments").cloned() else {
                continue;
            };
            let normalized_args = if wants_anthropic_shell && is_shell_alias {
                normalize_tool_args_preserving_raw_shape("shell_command", Some(&arguments))
            } else {
                normalize_tool_args_preserving_raw_shape(name.as_str(), Some(&arguments))
            };
            if let Some(normalized_args) = normalized_args {
                let final_args = if wants_exec_command_cmd && target_name == "exec_command" {
                    if let Ok(mut parsed) = serde_json::from_str::<Value>(normalized_args.as_str())
                    {
                        if let Some(obj) = parsed.as_object_mut() {
                            let has_cmd = obj
                                .get("cmd")
                                .and_then(Value::as_str)
                                .map(|value| !value.trim().is_empty())
                                .unwrap_or(false);
                            let has_workdir_shape =
                                obj.get("cwd").is_some() || obj.get("workdir").is_some();
                            if !has_cmd && !has_workdir_shape {
                                if let Some(command) = obj
                                    .get("command")
                                    .and_then(Value::as_str)
                                    .map(str::trim)
                                    .filter(|value| !value.is_empty())
                                {
                                    obj.insert(
                                        "cmd".to_string(),
                                        Value::String(command.to_string()),
                                    );
                                }
                            }
                        }
                        serde_json::to_string(&parsed).unwrap_or(normalized_args)
                    } else {
                        normalized_args
                    }
                } else {
                    normalized_args
                };
                function.insert("arguments".to_string(), Value::String(final_args));
            }
        }
    }
}

pub(crate) fn count_normalized_tool_calls(payload: &Value) -> i64 {
    payload
        .get("choices")
        .and_then(|v| v.as_array())
        .map(|choices| {
            choices
                .iter()
                .map(|choice| {
                    choice
                        .get("message")
                        .and_then(|v| v.as_object())
                        .and_then(|message| message.get("tool_calls"))
                        .and_then(|v| v.as_array())
                        .map(|rows| rows.len() as i64)
                        .unwrap_or(0)
                })
                .sum::<i64>()
        })
        .unwrap_or(0)
}


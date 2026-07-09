use serde_json::{Map, Value};

use crate::resp_process_stage1_tool_governance_blocks::apply_patch_schema_args::normalize_apply_patch_schema_args;
use crate::resp_process_stage1_tool_governance_blocks::exec_command_args::{
    normalize_exec_command_text, read_command_from_args,
};
use crate::resp_process_stage1_tool_governance_blocks::json_args::parse_json_record;
use crate::resp_process_stage1_tool_governance_blocks::requested_tools::collect_requested_tool_name_keys;
use crate::resp_process_stage1_tool_governance_blocks::text_harvest_extract::looks_like_exec_command_candidate;
use crate::resp_process_stage1_tool_governance_blocks::text_harvest_strict::harvest_explicit_wrapper_only_tool_calls_from_payload;
use crate::resp_process_stage1_tool_governance_blocks::tool_args::normalize_tool_args_preserving_raw_shape;
use crate::shared_json_utils::read_trimmed_string;
use crate::shared_tool_mapping::normalize_routecodex_tool_name;

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

pub(crate) fn preserve_client_tool_calls_for_feedback(payload: &mut Value) -> i64 {
    let _ = payload;
    0
}

pub(crate) fn strip_visible_content_from_tool_call_rounds(
    payload: &mut Value,
    preserve_harvested_visible_text: bool,
) -> i64 {
    let mut changed = 0i64;
    let Some(choices) = payload.get_mut("choices").and_then(|v| v.as_array_mut()) else {
        return changed;
    };

    for choice in choices {
        let Some(choice_row) = choice.as_object_mut() else {
            continue;
        };
        let finish_reason = read_trimmed_string(choice_row.get("finish_reason"))
            .unwrap_or_default()
            .to_ascii_lowercase();
        if finish_reason != "tool_calls" {
            continue;
        }
        let Some(message) = choice_row
            .get_mut("message")
            .and_then(|v| v.as_object_mut())
        else {
            continue;
        };
        let has_tool_calls = message
            .get("tool_calls")
            .and_then(Value::as_array)
            .map(|rows| !rows.is_empty())
            .unwrap_or(false);
        if !has_tool_calls {
            continue;
        }

        let should_strip = match message.get("content") {
            Some(Value::String(text)) => {
                !text.trim().is_empty()
                    && (!preserve_harvested_visible_text
                        || looks_like_harvest_transcript_residue(text.as_str()))
            }
            Some(Value::Array(items)) => !items.is_empty(),
            Some(Value::Object(_)) => true,
            Some(Value::Null) | None => false,
            Some(_) => true,
        };
        if !should_strip {
            continue;
        }

        message.insert("content".to_string(), Value::Null);
        changed += 1;
    }

    changed
}

fn looks_like_harvest_transcript_residue(text: &str) -> bool {
    let lowered = text.to_ascii_lowercase();
    if lowered.contains("tool transcript") {
        return true;
    }
    text.lines().any(|line| {
        let trimmed = line.trim();
        trimmed.starts_with('›') || trimmed.contains('│')
    })
}

fn should_preserve_structured_tool_name(
    raw_name: &str,
    requested_tool_name_keys: &std::collections::HashSet<String>,
) -> bool {
    let Some(normalized_name) = normalize_routecodex_tool_name(Some(raw_name)) else {
        return false;
    };
    let normalized_key = normalized_name.trim().to_ascii_lowercase();
    if normalized_key.is_empty()
        || matches!(
            normalized_key.as_str(),
            "exec_command" | "shell_command" | "shell" | "bash" | "terminal"
        )
    {
        return false;
    }
    if requested_tool_name_keys.contains(normalized_key.as_str()) {
        return true;
    }
    raw_name.contains('.')
        && !raw_name.contains('/')
        && !raw_name.contains(char::is_whitespace)
        && normalized_name == raw_name.trim()
}

fn maybe_repair_malformed_exec_command_name(
    function: &mut Map<String, Value>,
    requested_tool_name_keys: &std::collections::HashSet<String>,
) -> bool {
    let Some(raw_name) = read_trimmed_string(function.get("name")) else {
        return false;
    };
    let lowered = raw_name.to_ascii_lowercase();
    if should_preserve_structured_tool_name(raw_name.as_str(), requested_tool_name_keys) {
        return false;
    }
    if normalize_routecodex_tool_name(Some(raw_name.as_str()))
        .as_deref()
        .is_some_and(|normalized| normalized == raw_name.as_str())
    {
        return false;
    }
    // Guard: keep canonical snake_case tool identifiers untouched.
    if !raw_name.contains(char::is_whitespace)
        && raw_name.contains('_')
        && normalize_routecodex_tool_name(Some(raw_name.as_str())).is_some()
    {
        return false;
    }
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

fn maybe_repair_exec_command_reasoning_stop_projection(
    function: &mut Map<String, Value>,
    requested_tool_name_keys: &std::collections::HashSet<String>,
) -> bool {
    if !requested_tool_name_keys.contains("reasoningstop") {
        return false;
    }

    let Some(raw_name) = read_trimmed_string(function.get("name")) else {
        return false;
    };
    let Some(normalized_name) = normalize_routecodex_tool_name(Some(raw_name.as_str())) else {
        return false;
    };
    if normalized_name.to_ascii_lowercase() != "exec_command" {
        return false;
    }

    let mut args = parse_json_record(function.get("arguments")).unwrap_or_default();
    let Some(command) = read_command_from_args(&args) else {
        return false;
    };
    if !normalize_exec_command_text(command.as_str()).eq_ignore_ascii_case("reasoningStop") {
        return false;
    }

    for key in ["cmd", "command", "script", "toon"] {
        args.remove(key);
    }

    let Ok(arguments) = serde_json::to_string(&Value::Object(args)) else {
        return false;
    };
    function.insert(
        "name".to_string(),
        Value::String("reasoningStop".to_string()),
    );
    function.insert("arguments".to_string(), Value::String(arguments));
    true
}

fn normalize_write_stdin_args_for_client(args: &mut Map<String, Value>) {
    // Reverse of req-side normalization (hub_req_inbound_tool_call_normalization.rs):
    // server format: session_id, chars → client format: sessionId, text
    if let Some(session_id) = args.remove("session_id") {
        args.insert("sessionId".to_string(), session_id);
    }
    if let Some(chars) = args.remove("chars") {
        args.insert("text".to_string(), chars);
    }
    // Also handle the case where only one field was normalized
    if args.contains_key("session_id") && !args.contains_key("sessionId") {
        if let Some(sid) = args.remove("session_id") {
            args.insert("sessionId".to_string(), sid);
        }
    }
    if args.contains_key("chars") && !args.contains_key("text") {
        if let Some(ch) = args.remove("chars") {
            args.insert("text".to_string(), ch);
        }
    }
}

pub(crate) fn remap_tool_calls_for_client_protocol(payload: &mut Value, client_protocol: &str) {
    let protocol = client_protocol.trim().to_ascii_lowercase();
    let requested_tool_name_keys = collect_requested_tool_name_keys(payload);
    let requested_shell_command = payload
        .get("__rcc_tool_governance")
        .and_then(Value::as_object)
        .and_then(|row| row.get("requestedToolNames"))
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter().any(|row| {
                row.as_str()
                    .map(|name| name.trim().eq_ignore_ascii_case("shell_command"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);
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
            // write_stdin is a standard client tool, not a malformed shell alias
            // Req-side normalizes sessionId→session_id, text→chars; resp side reverses
            {
                let is_write_stdin = read_trimmed_string(function.get("name"))
                    .map(|n| {
                        matches!(
                            n.to_ascii_lowercase().as_str(),
                            "write_stdin" | "write.stdin"
                        )
                    })
                    .unwrap_or(false);
                if is_write_stdin {
                    if let Some(arguments) = function.get("arguments").and_then(|v| v.as_str()) {
                        if let Ok(mut parsed) = serde_json::from_str::<Value>(arguments) {
                            if let Some(obj) = parsed.as_object_mut() {
                                normalize_write_stdin_args_for_client(obj);
                            }
                            if let Ok(serialized) = serde_json::to_string(&parsed) {
                                function.insert("arguments".to_string(), Value::String(serialized));
                            }
                        }
                    }
                    continue;
                }
            }

            let _ = maybe_repair_exec_command_reasoning_stop_projection(
                function,
                &requested_tool_name_keys,
            );
            let _ = maybe_repair_malformed_exec_command_name(function, &requested_tool_name_keys);
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

            let target_name =
                if wants_anthropic_shell || (requested_shell_command && is_shell_alias) {
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

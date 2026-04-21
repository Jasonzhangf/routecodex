use regex::Regex;
use serde_json::Value;

use crate::resp_process_stage1_tool_governance::{
    govern_response, harvest_text_tool_calls_from_payload, ToolGovernanceInput,
};

use self::envelope::normalize_deepseek_business_envelope;
use self::tool_state::{
    count_tool_calls_from_choices, resolve_declared_tools_present, resolve_deepseek_options,
    resolve_tool_choice_required,
};
use super::markup::{
    ensure_finish_reason_tool_calls, harvest_function_results_markup,
    mark_function_results_harvested, write_deepseek_tool_state,
};
use super::usage::apply_usage_estimate;
use super::AdapterContext;

mod envelope;
mod tool_state;

fn set_skip_global_text_harvest(payload: &mut Value) {
    let Some(root) = payload.as_object_mut() else {
        return;
    };
    let governance = root
        .entry("__rcc_tool_governance".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if let Some(row) = governance.as_object_mut() {
        row.insert("skipTextHarvest".to_string(), Value::Bool(true));
    } else {
        *governance = serde_json::json!({
            "skipTextHarvest": true
        });
    }
}

fn strip_skip_global_text_harvest(payload: &mut Value) {
    let Some(root) = payload.as_object_mut() else {
        return;
    };
    root.remove("__rcc_tool_governance");
}

fn is_exec_command_family(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "exec_command"
            | "execute_command"
            | "execute-command"
            | "shell_command"
            | "shell"
            | "bash"
            | "terminal"
    )
}

fn resolve_requested_exec_tool_alias(adapter_context: &AdapterContext) -> Option<String> {
    let tools = adapter_context
        .captured_chat_request
        .as_ref()
        .and_then(|value| value.as_object())
        .and_then(|row| row.get("tools"))
        .and_then(Value::as_array)?;
    let mut raw_matches: Vec<String> = Vec::new();
    for tool in tools {
        let raw_name = tool
            .as_object()
            .and_then(|row| row.get("function"))
            .and_then(Value::as_object)
            .and_then(|function| function.get("name"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let Some(raw_name) = raw_name else {
            continue;
        };
        if is_exec_command_family(raw_name) {
            raw_matches.push(raw_name.to_string());
        }
    }
    raw_matches.dedup();
    if raw_matches.len() == 1 {
        return raw_matches.into_iter().next();
    }
    None
}

fn remap_exec_tool_name_to_requested_alias(payload: &mut Value, requested_alias: Option<&str>) {
    let Some(alias) = requested_alias
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return;
    };
    if alias.eq_ignore_ascii_case("exec_command") {
        return;
    }
    let Some(choices) = payload.get_mut("choices").and_then(Value::as_array_mut) else {
        return;
    };
    for choice in choices {
        let Some(tool_calls) = choice
            .as_object_mut()
            .and_then(|row| row.get_mut("message"))
            .and_then(Value::as_object_mut)
            .and_then(|message| message.get_mut("tool_calls"))
            .and_then(Value::as_array_mut)
        else {
            continue;
        };
        for tool_call in tool_calls {
            let Some(function) = tool_call
                .as_object_mut()
                .and_then(|row| row.get_mut("function"))
                .and_then(Value::as_object_mut)
            else {
                continue;
            };
            let is_exec = function
                .get("name")
                .and_then(Value::as_str)
                .map(is_exec_command_family)
                .unwrap_or(false);
            if is_exec {
                function.insert("name".to_string(), Value::String(alias.to_string()));
            }
        }
    }
}

fn normalize_tool_call_only_content_to_null(payload: &mut Value) {
    let Some(choices) = payload.get_mut("choices").and_then(Value::as_array_mut) else {
        return;
    };
    for choice in choices {
        let Some(message) = choice
            .as_object_mut()
            .and_then(|row| row.get_mut("message"))
            .and_then(Value::as_object_mut)
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
        let has_visible_content = message
            .get("content")
            .map(|value| match value {
                Value::Null => false,
                Value::String(raw) => !raw.trim().is_empty(),
                Value::Array(rows) => !rows.is_empty(),
                Value::Object(row) => !row.is_empty(),
                _ => true,
            })
            .unwrap_or(false);
        if !has_visible_content {
            message.insert("content".to_string(), Value::Null);
        }
    }
}

fn collapse_blank_lines(value: &str) -> String {
    Regex::new(r"\n{3,}")
        .ok()
        .map(|re| re.replace_all(value, "\n\n").to_string())
        .unwrap_or_else(|| value.to_string())
        .trim()
        .to_string()
}

fn sanitize_deepseek_meta_leakage_text(value: &str) -> (String, bool) {
    let mut text = value.to_string();
    let mut detected = false;
    let paired_patterns = [
        r"(?is)<\s*use_mcp_tool\s*>[\s\S]*?<\s*/\s*use_mcp_tool\s*>",
        r"(?is)<\s*previous_tool_call\s*>[\s\S]*?<\s*/\s*previous_tool_call\s*>",
        r"(?is)<\s*tool_call\s*>[\s\S]*?<\s*/\s*tool_call\s*>",
        r#"(?is)<\s*invoke(?:\s+[^>]*)?>[\s\S]*?<\s*/\s*invoke\s*>"#,
        r"(?is)<\s*ds_safety\s*>[\s\S]*?<\s*/\s*ds_safety\s*>",
        r"(?is)<\s*safety\s*>[\s\S]*?<\s*/\s*safety\s*>",
    ];
    for pattern in paired_patterns {
        let Ok(re) = Regex::new(pattern) else {
            continue;
        };
        if re.is_match(&text) {
            detected = true;
            text = re.replace_all(&text, "\n").to_string();
        }
    }

    let meta_line_patterns = [
        r"(?im)^[ \t]*<?[^>\r\n]*(?:tool-call block|RCC_TOOL_CALLS_JSON|system prompt|exact format)[^>\r\n]*>?\s*\r?\n?",
        r"(?im)^[ \t]*<\s*(?:server_name|tool_name|arguments)\s*>[\s\S]*?<\s*/\s*(?:server_name|tool_name|arguments)\s*>\s*\r?\n?",
        r"(?im)^[ \t]*<\s*/?\s*(?:server_name|tool_name|arguments)\s*>\s*\r?\n?",
    ];
    for pattern in meta_line_patterns {
        let Ok(re) = Regex::new(pattern) else {
            continue;
        };
        if re.is_match(&text) {
            detected = true;
            text = re.replace_all(&text, "").to_string();
        }
    }

    (collapse_blank_lines(&text), detected)
}

fn sanitize_deepseek_meta_leakage(payload: &mut Value) -> bool {
    let Some(choices) = payload.get_mut("choices").and_then(Value::as_array_mut) else {
        return false;
    };
    let mut detected = false;
    for choice in choices {
        let Some(message) = choice
            .as_object_mut()
            .and_then(|row| row.get_mut("message"))
            .and_then(Value::as_object_mut)
        else {
            continue;
        };
        for key in ["content", "reasoning", "reasoning_content", "thinking"] {
            let Some(value) = message.get_mut(key) else {
                continue;
            };
            match value {
                Value::String(raw) => {
                    let (next, matched) = sanitize_deepseek_meta_leakage_text(raw);
                    if matched {
                        detected = true;
                        *value = Value::String(next);
                    }
                }
                Value::Array(parts) => {
                    for part in parts {
                        let Some(part_obj) = part.as_object_mut() else {
                            continue;
                        };
                        for text_key in ["text", "content"] {
                            let Some(raw) = part_obj.get(text_key).and_then(Value::as_str) else {
                                continue;
                            };
                            let (next, matched) = sanitize_deepseek_meta_leakage_text(raw);
                            if matched {
                                detected = true;
                                part_obj.insert(text_key.to_string(), Value::String(next));
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    detected
}

fn text_contains_narrative_tool_intent(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }
    let narrative_re = match Regex::new(
        r"(?im)(?:^|\n)\s*(?:#{1,6}\s*)?(?:步骤\s*\d+|step\s*\d+|第一步|第二步|i will|let me|让我|我来|我尝试|先检查|先看|先确认)",
    ) {
        Ok(v) => v,
        Err(_) => return false,
    };
    if !narrative_re.is_match(trimmed) {
        return false;
    }
    let command_re = match Regex::new(
        r"(?im)^\s*(?:ssh|scp|find|grep|sed|cat|ls|pwd|git|cargo|pnpm|npm|bash|python|node|cp|mv|rm)\b",
    ) {
        Ok(v) => v,
        Err(_) => return false,
    };
    command_re.is_match(trimmed)
}

fn detect_narrative_tool_intent(payload: &Value) -> bool {
    let Some(choices) = payload.get("choices").and_then(Value::as_array) else {
        return false;
    };
    for choice in choices {
        let Some(message) = choice.get("message").and_then(Value::as_object) else {
            continue;
        };
        for key in ["content", "reasoning", "reasoning_content", "thinking"] {
            let Some(value) = message.get(key) else {
                continue;
            };
            match value {
                Value::String(raw) => {
                    if text_contains_narrative_tool_intent(raw) {
                        return true;
                    }
                }
                Value::Array(parts) => {
                    for part in parts {
                        let Some(part_obj) = part.as_object() else {
                            continue;
                        };
                        for text_key in ["text", "content"] {
                            let Some(raw) = part_obj.get(text_key).and_then(Value::as_str) else {
                                continue;
                            };
                            if text_contains_narrative_tool_intent(raw) {
                                return true;
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    false
}

fn attach_requested_tool_names(payload: &mut Value, adapter_context: &AdapterContext) {
    let requested: Vec<Value> = adapter_context
        .captured_chat_request
        .as_ref()
        .and_then(|value| value.as_object())
        .and_then(|row| row.get("tools"))
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| {
                    tool.as_object()
                        .and_then(|row| row.get("function"))
                        .and_then(Value::as_object)
                        .and_then(|function| function.get("name"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(|value| Value::String(value.to_string()))
                })
                .collect::<Vec<Value>>()
        })
        .unwrap_or_default();
    if requested.is_empty() {
        return;
    }
    let Some(root) = payload.as_object_mut() else {
        return;
    };
    let governance = root
        .entry("__rcc_tool_governance".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if let Some(row) = governance.as_object_mut() {
        row.insert("requestedToolNames".to_string(), Value::Array(requested));
    }
}

pub(crate) fn apply_deepseek_web_response_compat(
    payload: Value,
    adapter_context: &AdapterContext,
) -> Result<Value, String> {
    let mut normalized = normalize_deepseek_business_envelope(payload)?;
    let harvested_function_results = harvest_function_results_markup(&mut normalized);
    let before_count = count_tool_calls_from_choices(&normalized);
    attach_requested_tool_names(&mut normalized, adapter_context);
    harvest_text_tool_calls_from_payload(&mut normalized);
    set_skip_global_text_harvest(&mut normalized);

    let request_id = adapter_context
        .request_id
        .as_ref()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "req_deepseek_web_compat".to_string());

    let mut governed = match govern_response(ToolGovernanceInput {
        payload: normalized.clone(),
        client_protocol: "openai-chat".to_string(),
        entry_endpoint: "/v1/chat/completions".to_string(),
        request_id,
    }) {
        Ok(output) => output.governed_payload,
        Err(_) => {
            strip_skip_global_text_harvest(&mut normalized);
            normalized
        }
    };
    let (strict_tool_required, text_tool_fallback) = resolve_deepseek_options(adapter_context);
    let declared_tools_present = resolve_declared_tools_present(adapter_context);
    ensure_finish_reason_tool_calls(&mut governed);
    if harvested_function_results {
        mark_function_results_harvested(&mut governed);
    }
    remap_exec_tool_name_to_requested_alias(
        &mut governed,
        resolve_requested_exec_tool_alias(adapter_context).as_deref(),
    );
    let forbidden_transport_detected = sanitize_deepseek_meta_leakage(&mut governed);
    normalize_tool_call_only_content_to_null(&mut governed);

    let after_count = count_tool_calls_from_choices(&governed);
    let (state, source) = if after_count <= 0 {
        ("no_tool_calls", "none")
    } else if before_count > 0 {
        ("native_tool_calls", "native")
    } else {
        ("text_tool_calls", "fallback")
    };
    write_deepseek_tool_state(&mut governed, state, source);
    apply_usage_estimate(&mut governed, adapter_context);

    let tool_choice_required = resolve_tool_choice_required(adapter_context);
    if forbidden_transport_detected && declared_tools_present && after_count <= 0 {
        return Err(
            "DeepSeek emitted forbidden hidden tool transport markup without a valid declared tool call"
                .to_string(),
        );
    }
    if declared_tools_present && after_count <= 0 && detect_narrative_tool_intent(&governed) {
        return Err(
            "DeepSeek declared tools present but emitted narrative tool intent instead of a valid tool call"
                .to_string(),
        );
    }
    let strict_tools_missing =
        strict_tool_required && declared_tools_present && tool_choice_required && after_count <= 0;
    if strict_tools_missing {
        return Err(format!(
            "DeepSeek declared tools present but no valid tool call was produced (toolChoiceRequired={}, fallbackEnabled={}, strictToolRequired={})",
            tool_choice_required, text_tool_fallback, strict_tool_required
        ));
    }

    Ok(governed)
}

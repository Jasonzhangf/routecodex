use napi::bindgen_prelude::Result as NapiResult;
use serde_json::{Map, Value};
use uuid::Uuid;

fn is_record(value: &Value) -> bool {
    matches!(value, Value::Object(_))
}

fn read_bool(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(true)))
}

fn normalize_message_content(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if let Some(text) = item.as_str() {
                    text.to_string()
                } else {
                    serde_json::to_string(item).unwrap_or_else(|_| String::new())
                }
            })
            .collect::<Vec<String>>()
            .join(""),
        Value::Object(_) => serde_json::to_string(content).unwrap_or_else(|_| String::new()),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn normalize_tool_arguments(args: &Value) -> String {
    let raw = if let Some(text) = args.as_str() {
        text.trim().to_string()
    } else {
        serde_json::to_string(args).unwrap_or_else(|_| String::new())
    };
    if raw.trim().is_empty() {
        return String::new();
    }
    match serde_json::from_str::<Value>(&raw) {
        Ok(parsed) => serde_json::to_string(&parsed).unwrap_or(raw),
        Err(_) => raw,
    }
}

fn normalize_tool_calls(tool_calls: &mut Vec<Value>) {
    for entry in tool_calls.iter_mut() {
        let Some(row) = entry.as_object_mut() else {
            continue;
        };
        let Some(function) = row.get_mut("function").and_then(|v| v.as_object_mut()) else {
            continue;
        };
        if let Some(args) = function.get_mut("arguments") {
            *args = Value::String(normalize_tool_arguments(args));
        }
    }
}

fn normalize_choices(choices: &mut Vec<Value>, finish_reason_map: Option<&Map<String, Value>>) {
    for (index, choice) in choices.iter_mut().enumerate() {
        let Some(row) = choice.as_object_mut() else {
            continue;
        };
        if !row.contains_key("index") {
            row.insert("index".to_string(), Value::from(index as i64));
        }
        if let Some(reason) = row.get("finish_reason").and_then(|v| v.as_str()) {
            if let Some(mapped) = finish_reason_map
                .and_then(|m| m.get(reason))
                .and_then(|v| v.as_str())
            {
                row.insert(
                    "finish_reason".to_string(),
                    Value::String(mapped.to_string()),
                );
            }
        }
        if let Some(message) = row.get_mut("message").and_then(|v| v.as_object_mut()) {
            if let Some(content) = message.get("content") {
                if !content.is_string() {
                    message.insert(
                        "content".to_string(),
                        Value::String(normalize_message_content(content)),
                    );
                }
            }
            if let Some(tool_calls) = message.get_mut("tool_calls").and_then(|v| v.as_array_mut()) {
                normalize_tool_calls(tool_calls);
            }
        }
    }
}

fn normalize_usage_fields(usage: &mut Map<String, Value>) {
    let field_mappings = [
        ("input_tokens", "prompt_tokens"),
        ("output_tokens", "completion_tokens"),
        ("total_input_tokens", "prompt_tokens"),
        ("total_output_tokens", "completion_tokens"),
    ];
    for (source, target) in field_mappings {
        if let Some(value) = usage.remove(source) {
            if value.is_number() {
                usage.insert(target.to_string(), value);
            }
        }
    }

    let prompt_tokens = usage
        .get("prompt_tokens")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let completion_tokens = usage
        .get("completion_tokens")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    usage.insert("prompt_tokens".to_string(), Value::from(prompt_tokens));
    usage.insert(
        "completion_tokens".to_string(),
        Value::from(completion_tokens),
    );
    if !usage
        .get("total_tokens")
        .map(|v| v.is_number())
        .unwrap_or(false)
    {
        usage.insert(
            "total_tokens".to_string(),
            Value::from(prompt_tokens + completion_tokens),
        );
    }
}

pub fn normalize_response_payload_json(
    payload_json: String,
    config_json: Option<String>,
) -> NapiResult<String> {
    let mut payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let config: Value = match config_json {
        Some(raw) if !raw.trim().is_empty() => serde_json::from_str(&raw).unwrap_or(Value::Null),
        _ => Value::Null,
    };
    let finish_reason_map = config
        .as_object()
        .and_then(|row| row.get("finishReasonMap"))
        .and_then(|v| v.as_object());

    let Some(root) = payload.as_object_mut() else {
        return Ok(payload_json);
    };

    if let Some(usage) = root.get_mut("usage").and_then(|v| v.as_object_mut()) {
        normalize_usage_fields(usage);
    }
    if let Some(created_at) = root.remove("created_at") {
        if created_at.is_number() {
            root.insert("created".to_string(), created_at);
        } else {
            root.insert("created_at".to_string(), created_at);
        }
    }
    if let Some(choices) = root.get_mut("choices").and_then(|v| v.as_array_mut()) {
        normalize_choices(choices, finish_reason_map);
    }

    serde_json::to_string(&Value::Object(root.clone()))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

fn is_non_negative_number(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Number(num)) => num
            .as_f64()
            .map(|v| v.is_finite() && v >= 0.0)
            .unwrap_or(false),
        _ => false,
    }
}

pub fn validate_response_payload_json(payload_json: String) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let Some(root) = payload.as_object() else {
        return Err(napi::Error::from_reason("GLM响应校验失败:\n响应必须是对象"));
    };

    let mut errors: Vec<String> = Vec::new();
    if root
        .get("id")
        .and_then(|v| v.as_str())
        .map(|v| !v.is_empty())
        .unwrap_or(false)
        == false
    {
        errors.push("响应缺少有效的id字段".to_string());
    }
    if root.get("created").and_then(|v| v.as_i64()).is_none() {
        errors.push("响应缺少有效的created字段".to_string());
    }
    if root
        .get("model")
        .and_then(|v| v.as_str())
        .map(|v| !v.is_empty())
        .unwrap_or(false)
        == false
    {
        errors.push("响应缺少有效的model字段".to_string());
    }
    match root.get("choices").and_then(|v| v.as_array()) {
        Some(choices) if !choices.is_empty() => {
            for (idx, choice) in choices.iter().enumerate() {
                let Some(choice_row) = choice.as_object() else {
                    errors.push(format!("choices[{}]必须是对象", idx));
                    continue;
                };
                let Some(message) = choice_row.get("message") else {
                    errors.push(format!("choices[{}].message字段必须是对象", idx));
                    continue;
                };
                let Some(message_row) = message.as_object() else {
                    errors.push(format!("choices[{}].message字段必须是对象", idx));
                    continue;
                };
                if let Some(tool_calls) = message_row.get("tool_calls").and_then(|v| v.as_array()) {
                    for (tool_idx, tool_call) in tool_calls.iter().enumerate() {
                        let Some(tool_row) = tool_call.as_object() else {
                            errors.push(format!(
                                "choices[{}].message.tool_calls[{}]必须是对象",
                                idx, tool_idx
                            ));
                            continue;
                        };
                        let Some(function_row) =
                            tool_row.get("function").and_then(|v| v.as_object())
                        else {
                            errors.push(format!(
                                "choices[{}].message.tool_calls[{}].function字段必须是对象",
                                idx, tool_idx
                            ));
                            continue;
                        };
                        if function_row.get("name").and_then(|v| v.as_str()).is_none() {
                            errors.push(format!(
                                "choices[{}].message.tool_calls[{}].function.name字段必须是字符串",
                                idx, tool_idx
                            ));
                        }
                        match function_row.get("arguments") {
                            Some(Value::String(raw)) => {
                                if serde_json::from_str::<Value>(raw).is_err() {
                                    errors.push(format!("choices[{}].message.tool_calls[{}].function.arguments必须是有效JSON", idx, tool_idx));
                                }
                            }
                            _ => errors.push(format!("choices[{}].message.tool_calls[{}].function.arguments字段必须是字符串", idx, tool_idx)),
                        }
                    }
                }
            }
        }
        _ => errors.push("choices数组不能为空".to_string()),
    }

    if let Some(usage) = root.get("usage").and_then(|v| v.as_object()) {
        let prompt_tokens = usage.get("prompt_tokens");
        let completion_tokens = usage.get("completion_tokens");
        let total_tokens = usage.get("total_tokens");
        if !is_non_negative_number(prompt_tokens)
            || !is_non_negative_number(completion_tokens)
            || !is_non_negative_number(total_tokens)
        {
            errors.push("usage字段的token必须是非负数".to_string());
        } else if prompt_tokens.unwrap().as_i64().unwrap_or(0)
            + completion_tokens.unwrap().as_i64().unwrap_or(0)
            != total_tokens.unwrap().as_i64().unwrap_or(0)
        {
            errors.push(
                "usage.total_tokens 应等于 prompt_tokens 与 completion_tokens 之和".to_string(),
            );
        }
    }

    if !errors.is_empty() {
        return Err(napi::Error::from_reason(format!(
            "GLM响应校验失败:\n{}",
            errors.join("\n")
        )));
    }

    Ok("{}".to_string())
}

fn read_string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|entry| entry.as_str().map(|s| s.trim().to_string()))
                .filter(|s| !s.is_empty())
                .collect::<Vec<String>>()
        })
        .unwrap_or_default()
}

pub fn apply_request_rules_json(
    payload_json: String,
    config_json: Option<String>,
) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let Some(payload_row) = payload.as_object() else {
        return Ok(payload_json);
    };
    let config: Value = match config_json {
        Some(raw) if !raw.trim().is_empty() => serde_json::from_str(&raw).unwrap_or(Value::Null),
        _ => Value::Null,
    };
    let Some(config_row) = config.as_object() else {
        return Ok(payload_json);
    };

    let mut cloned = payload_row.clone();
    if let Some(remove_keys) = config_row
        .get("tools")
        .and_then(|v| v.as_object())
        .and_then(|row| row.get("function"))
        .and_then(|v| v.as_object())
        .map(|row| read_string_array(row.get("removeKeys")))
    {
        if let Some(tools) = cloned.get_mut("tools").and_then(|v| v.as_array_mut()) {
            for tool in tools.iter_mut() {
                let Some(tool_row) = tool.as_object_mut() else {
                    continue;
                };
                let Some(function_row) =
                    tool_row.get_mut("function").and_then(|v| v.as_object_mut())
                else {
                    continue;
                };
                for key in &remove_keys {
                    function_row.remove(key);
                }
            }
        }
    }

    if let Some(remove_keys) = config_row
        .get("messages")
        .and_then(|v| v.as_object())
        .and_then(|row| row.get("assistantToolCalls"))
        .and_then(|v| v.as_object())
        .and_then(|row| row.get("function"))
        .and_then(|v| v.as_object())
        .map(|row| read_string_array(row.get("removeKeys")))
    {
        if let Some(messages) = cloned.get_mut("messages").and_then(|v| v.as_array_mut()) {
            for message in messages.iter_mut() {
                let Some(message_row) = message.as_object_mut() else {
                    continue;
                };
                let Some(tool_calls) = message_row
                    .get_mut("tool_calls")
                    .and_then(|v| v.as_array_mut())
                else {
                    continue;
                };
                for tool_call in tool_calls.iter_mut() {
                    let Some(tool_row) = tool_call.as_object_mut() else {
                        continue;
                    };
                    let Some(function_row) =
                        tool_row.get_mut("function").and_then(|v| v.as_object_mut())
                    else {
                        continue;
                    };
                    for key in &remove_keys {
                        function_row.remove(key);
                    }
                }
            }
        }
    }

    if let Some(conditional) = config_row
        .get("topLevel")
        .and_then(|v| v.as_object())
        .and_then(|row| row.get("conditional"))
        .and_then(|v| v.as_array())
    {
        for rule in conditional {
            let Some(rule_row) = rule.as_object() else {
                continue;
            };
            let remove = read_string_array(rule_row.get("remove"));
            let tools_state = rule_row
                .get("when")
                .and_then(|v| v.as_object())
                .and_then(|row| row.get("tools"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let tools_len = cloned
                .get("tools")
                .and_then(|v| v.as_array())
                .map(|v| v.len())
                .unwrap_or(0);
            let matched = (tools_state == "empty" && tools_len == 0)
                || (tools_state == "present" && tools_len > 0);
            if matched {
                for field in &remove {
                    cloned.remove(field);
                }
            }
        }
    }

    serde_json::to_string(&Value::Object(cloned))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

fn delete_by_path(current: &mut Value, tokens: &[&str], idx: usize) {
    if idx >= tokens.len() {
        return;
    }
    let token = tokens[idx];
    let wildcard = token.ends_with("[]");
    let key = if wildcard {
        &token[..token.len() - 2]
    } else {
        token
    };
    if idx == tokens.len() - 1 {
        if !wildcard {
            if let Some(row) = current.as_object_mut() {
                row.remove(key);
            }
        }
        return;
    }
    if wildcard {
        if let Some(row) = current.as_object_mut() {
            if let Some(items) = row.get_mut(key).and_then(|v| v.as_array_mut()) {
                for item in items.iter_mut() {
                    delete_by_path(item, tokens, idx + 1);
                }
            }
        }
    } else if let Some(row) = current.as_object_mut() {
        if let Some(next) = row.get_mut(key) {
            delete_by_path(next, tokens, idx + 1);
        }
    }
}

pub fn apply_response_blacklist_json(
    payload_json: String,
    config_json: Option<String>,
) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let Some(root_row) = payload.as_object() else {
        return Ok(payload_json);
    };
    let config: Value = match config_json {
        Some(raw) if !raw.trim().is_empty() => serde_json::from_str(&raw).unwrap_or(Value::Null),
        _ => Value::Null,
    };
    let keep_critical = config
        .as_object()
        .and_then(|row| row.get("keepCritical"))
        .map(|v| read_bool(Some(v)))
        .unwrap_or(false);
    let paths = config
        .as_object()
        .map(|row| read_string_array(row.get("paths")))
        .unwrap_or_default();
    let critical = [
        "status",
        "output",
        "output_text",
        "required_action",
        "choices[].message.content",
        "choices[].message.tool_calls",
        "choices[].finish_reason",
    ];

    let mut out = Value::Object(root_row.clone());

    if out
        .as_object()
        .and_then(|row| row.get("data"))
        .map(|v| v.is_object())
        .unwrap_or(false)
    {
        if let Some(root) = out.as_object_mut().and_then(|row| row.get_mut("data")) {
            for path in &paths {
                if path.is_empty() {
                    continue;
                }
                if keep_critical && critical.contains(&path.as_str()) {
                    continue;
                }
                let tokens = path.split('.').collect::<Vec<&str>>();
                delete_by_path(root, &tokens, 0);
            }
        }
    } else {
        for path in &paths {
            if path.is_empty() {
                continue;
            }
            if keep_critical && critical.contains(&path.as_str()) {
                continue;
            }
            let tokens = path.split('.').collect::<Vec<&str>>();
            delete_by_path(&mut out, &tokens, 0);
        }
    }

    serde_json::to_string(&out).map_err(|e| napi::Error::from_reason(e.to_string()))
}

fn pick_string(candidates: &[Option<&Value>]) -> Option<String> {
    for candidate in candidates {
        if let Some(text) = candidate.and_then(|v| v.as_str()) {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn normalize_tool_call_ids_value(root: &mut Value) {
    let Some(root_row) = root.as_object_mut() else {
        return;
    };

    if let Some(input) = root_row.get_mut("input").and_then(|v| v.as_array_mut()) {
        for item in input.iter_mut() {
            let Some(item_row) = item.as_object_mut() else {
                continue;
            };
            let type_name = item_row.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if type_name == "function_call" {
                let id = pick_string(&[item_row.get("id")]);
                let call_id = pick_string(&[item_row.get("call_id")]);
                if call_id.is_some() && id.is_none() {
                    item_row.insert("id".to_string(), Value::String(call_id.unwrap()));
                } else if id.is_some() && call_id.is_none() {
                    item_row.insert("call_id".to_string(), Value::String(id.unwrap()));
                }
                continue;
            }
            if type_name == "function_call_output"
                || type_name == "tool_result"
                || type_name == "tool_message"
            {
                let id = pick_string(&[item_row.get("id")]);
                let call_id = pick_string(&[item_row.get("call_id")]);
                let tool_call_id = pick_string(&[item_row.get("tool_call_id")]);
                let resolved = call_id.clone().or(tool_call_id.clone());
                if let Some(call) = resolved {
                    if call_id.is_none() {
                        item_row.insert("call_id".to_string(), Value::String(call));
                    }
                }
                if id.is_some() && call_id.is_none() && tool_call_id.is_none() {
                    let val = id.unwrap();
                    item_row.insert("call_id".to_string(), Value::String(val.clone()));
                    item_row.insert("tool_call_id".to_string(), Value::String(val));
                }
            }
        }
    }

    for key in ["tool_outputs", "toolOutputs"] {
        if let Some(tool_outputs) = root_row.get_mut(key).and_then(|v| v.as_array_mut()) {
            for entry in tool_outputs.iter_mut() {
                let Some(entry_row) = entry.as_object_mut() else {
                    continue;
                };
                let resolved = pick_string(&[
                    entry_row.get("tool_call_id"),
                    entry_row.get("call_id"),
                    entry_row.get("id"),
                ]);
                if let Some(value) = resolved {
                    entry_row.insert("tool_call_id".to_string(), Value::String(value.clone()));
                    entry_row.insert("call_id".to_string(), Value::String(value));
                }
            }
        }
    }

    if let Some(output) = root_row.get_mut("output").and_then(|v| v.as_array_mut()) {
        for item in output.iter_mut() {
            let Some(item_row) = item.as_object_mut() else {
                continue;
            };
            let type_name = item_row.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if type_name == "function_call" {
                let id = pick_string(&[item_row.get("id"), item_row.get("item_id")]);
                let call_id = pick_string(&[item_row.get("call_id")]);
                if call_id.is_some() && id.is_none() {
                    item_row.insert("id".to_string(), Value::String(call_id.unwrap()));
                } else if id.is_some() && call_id.is_none() {
                    item_row.insert("call_id".to_string(), Value::String(id.unwrap()));
                }
            }
        }
    }

    if let Some(messages) = root_row.get_mut("messages").and_then(|v| v.as_array_mut()) {
        for message in messages.iter_mut() {
            let Some(message_row) = message.as_object_mut() else {
                continue;
            };
            let tool_call_id = pick_string(&[message_row.get("tool_call_id")]);
            let call_id = pick_string(&[message_row.get("call_id")]);
            let resolved = tool_call_id.clone().or(call_id.clone());
            if let Some(value) = resolved {
                message_row.insert("tool_call_id".to_string(), Value::String(value.clone()));
                message_row.insert("call_id".to_string(), Value::String(value));
            }
            if let Some(tool_calls) = message_row
                .get_mut("tool_calls")
                .and_then(|v| v.as_array_mut())
            {
                for call in tool_calls.iter_mut() {
                    let Some(call_row) = call.as_object_mut() else {
                        continue;
                    };
                    let id = pick_string(&[call_row.get("id")]);
                    let call_id2 = pick_string(&[call_row.get("call_id")]);
                    if id.is_some() && call_id2.is_none() {
                        call_row.insert("call_id".to_string(), Value::String(id.unwrap()));
                    } else if call_id2.is_some() && id.is_none() {
                        call_row.insert("id".to_string(), Value::String(call_id2.unwrap()));
                    }
                }
            }
        }
    }
}

pub fn normalize_tool_call_ids_json(payload_json: String) -> NapiResult<String> {
    let mut payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    normalize_tool_call_ids_value(&mut payload);
    serde_json::to_string(&payload).map_err(|e| napi::Error::from_reason(e.to_string()))
}

fn sanitize_id_core(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

fn collapse_underscores(value: &str) -> String {
    let mut out = String::new();
    let mut prev_underscore = false;
    for ch in value.chars() {
        if ch == '_' {
            if prev_underscore {
                continue;
            }
            prev_underscore = true;
            out.push(ch);
        } else {
            prev_underscore = false;
            out.push(ch);
        }
    }
    out
}

fn extract_id_core(value: Option<&str>) -> Option<String> {
    let raw = value?.trim();
    if raw.is_empty() {
        return None;
    }
    let mut sanitized = sanitize_id_core(raw);
    if sanitized.is_empty() {
        return None;
    }
    let lower = sanitized.to_ascii_lowercase();
    if lower.starts_with("fc_") || lower.starts_with("fc-") {
        sanitized = sanitized.chars().skip(3).collect::<String>();
    } else if lower.starts_with("call_") || lower.starts_with("call-") {
        sanitized = sanitized.chars().skip(5).collect::<String>();
    }
    let normalized = sanitize_id_core(&sanitized);
    if normalized.is_empty() {
        None
    } else {
        Some(collapse_underscores(&normalized))
    }
}

fn normalize_responses_call_id(raw_call_id: Option<&str>, fallback: &str) -> String {
    let core = extract_id_core(raw_call_id).or_else(|| extract_id_core(Some(fallback)));
    let Some(core) = core else {
        return format!("call_{}", fallback.trim_matches('_'));
    };
    format!("call_{}", core)
}

fn normalize_prefixed_id(raw_id: Option<&str>, fallback: &str, prefix: &str) -> String {
    if let Some(core) = extract_id_core(raw_id).or_else(|| extract_id_core(Some(fallback))) {
        return format!("{}{}", prefix, core);
    }
    let random_core = Uuid::new_v4()
        .to_string()
        .replace('-', "")
        .chars()
        .take(8)
        .collect::<String>();
    format!("{}{}", prefix, random_core)
}

fn normalize_function_call_id(raw_id: Option<&str>, fallback: &str) -> String {
    normalize_prefixed_id(raw_id, fallback, "fc_")
}

fn normalize_function_call_output_id(raw_id: Option<&str>, fallback: &str) -> String {
    normalize_prefixed_id(raw_id, fallback, "fc_")
}

fn enforce_lmstudio_responses_fc_tool_call_ids_value(root: &mut Value) {
    let Some(root_row) = root.as_object_mut() else {
        return;
    };
    let Some(input) = root_row.get_mut("input").and_then(|v| v.as_array_mut()) else {
        return;
    };

    let mut call_counter: usize = 0;
    for item in input.iter_mut() {
        let Some(item_row) = item.as_object_mut() else {
            continue;
        };
        let item_type = item_row
            .get("type")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if item_type != "function_call" && item_type != "function_call_output" {
            continue;
        }

        call_counter += 1;
        let raw_call_id = pick_string(&[
            item_row.get("call_id"),
            item_row.get("tool_call_id"),
            item_row.get("id"),
        ]);
        let normalized_call_id = normalize_responses_call_id(
            raw_call_id.as_deref(),
            format!("call_{}", call_counter).as_str(),
        );
        item_row.insert(
            "call_id".to_string(),
            Value::String(normalized_call_id.clone()),
        );

        if item_type == "function_call" {
            let normalized_item_id = normalize_function_call_id(
                Some(normalized_call_id.as_str()),
                format!("fc_{}", normalized_call_id).as_str(),
            );
            item_row.insert("id".to_string(), Value::String(normalized_item_id));
            continue;
        }

        let fallback_output_id = pick_string(&[item_row.get("id")])
            .unwrap_or_else(|| format!("fc_tool_{}", call_counter));
        let normalized_output_id = normalize_function_call_output_id(
            Some(normalized_call_id.as_str()),
            fallback_output_id.as_str(),
        );
        item_row.insert("id".to_string(), Value::String(normalized_output_id));
    }
}

pub fn enforce_lmstudio_responses_fc_tool_call_ids_json(
    payload_json: String,
) -> NapiResult<String> {
    let mut payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    enforce_lmstudio_responses_fc_tool_call_ids_value(&mut payload);
    serde_json::to_string(&payload).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lmstudio_responses_fc_ids_normalizes_call_and_output_ids() {
        let raw = serde_json::json!({
            "input": [
                {
                    "type": "function_call",
                    "tool_call_id": "shell#1",
                    "name": "exec_command",
                    "arguments": { "cmd": "pwd" }
                },
                {
                    "type": "function_call_output",
                    "id": "result-item-1",
                    "output": "ok"
                }
            ]
        });

        let output = enforce_lmstudio_responses_fc_tool_call_ids_json(raw.to_string()).unwrap();
        let parsed: Value = serde_json::from_str(&output).unwrap();

        assert_eq!(parsed["input"][0]["call_id"], "call_shell_1");
        assert_eq!(parsed["input"][0]["id"], "fc_shell_1");
        assert_eq!(parsed["input"][1]["call_id"], "call_result-item-1");
        assert_eq!(parsed["input"][1]["id"], "fc_result-item-1");
    }
}

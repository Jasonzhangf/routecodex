use napi::bindgen_prelude::Result as NapiResult;
use serde_json::{json, Map, Value};

fn parse_json_value(raw: &str) -> NapiResult<Value> {
    serde_json::from_str(raw).map_err(|e| napi::Error::from_reason(e.to_string()))
}

fn parse_config_value(raw: Option<String>) -> Value {
    match raw {
        Some(raw) if !raw.trim().is_empty() => serde_json::from_str(&raw).unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

fn to_object(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(|value| value.as_object())
        .cloned()
        .unwrap_or_default()
}

fn to_array(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default()
}

fn read_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(|value| value.as_str())
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn read_string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(|item| item.trim())
                .filter(|item| !item.is_empty())
                .map(|item| item.to_string())
                .collect::<Vec<String>>()
        })
        .unwrap_or_default()
}

fn has_array_items(value: Option<&Value>) -> bool {
    value
        .and_then(|value| value.as_array())
        .map(|items| !items.is_empty())
        .unwrap_or(false)
}

fn read_bool(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Bool(true)))
}

fn shallow_pick(source: &Map<String, Value>, allow: &[String]) -> Map<String, Value> {
    let mut out = Map::new();
    for key in allow {
        if let Some(value) = source.get(key) {
            out.insert(key.clone(), value.clone());
        }
    }
    out
}

fn to_object_args(value: Option<&Value>) -> Value {
    match value {
        None | Some(Value::Null) => Value::Object(Map::new()),
        Some(Value::Object(map)) => Value::Object(map.clone()),
        Some(Value::String(text)) => match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(map)) => Value::Object(map),
            Ok(other) => other,
            Err(_) => json!({ "raw": text }),
        },
        Some(other) => other.clone(),
    }
}

fn to_string_args(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(other) => serde_json::to_string(other).unwrap_or_else(|_| "{}".to_string()),
        None => "{}".to_string(),
    }
}

fn normalize_tool_content(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) if !text.trim().is_empty() => text.clone(),
        Some(Value::String(_)) | None | Some(Value::Null) => {
            "Command succeeded (no output).".to_string()
        }
        Some(other) => serde_json::to_string(other)
            .ok()
            .filter(|text| !text.is_empty())
            .unwrap_or_else(|| "Command succeeded (no output).".to_string()),
    }
}


fn contains_serialized_history_image(text: &str) -> bool {
    let normalized = text.trim();
    normalized.contains("data:image/")
        || normalized.contains("\"image_url\":\"data:image")
}

fn sanitize_historical_user_content(role: &str, content: &Value) -> Value {
    if role != "user" {
        return content.clone();
    }
    match content {
        Value::String(text) => {
            if contains_serialized_history_image(text) {
                Value::String("[historical image content omitted after prior send]".to_string())
            } else {
                Value::String(text.clone())
            }
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| {
                    let Some(obj) = item.as_object() else {
                        return item.clone();
                    };
                    let has_tool_use_id = read_string(obj.get("tool_use_id")).is_some();
                    let Some(content_text) = obj.get("content").and_then(|v| v.as_str()) else {
                        return item.clone();
                    };
                    if !has_tool_use_id || !contains_serialized_history_image(content_text) {
                        return item.clone();
                    }
                    let mut next = obj.clone();
                    next.insert(
                        "content".to_string(),
                        Value::String("[historical image content omitted after prior send]".to_string()),
                    );
                    Value::Object(next)
                })
                .collect(),
        ),
        _ => content.clone(),
    }
}

fn normalize_assistant_tool_calls(
    tool_calls: Option<&Value>,
    request_cfg: &Map<String, Value>,
) -> Vec<Value> {
    let arguments_type = request_cfg
        .get("assistantToolCalls")
        .and_then(|value| value.as_object())
        .and_then(|value| value.get("functionArgumentsType"))
        .and_then(|value| value.as_str())
        .unwrap_or("object")
        .trim()
        .to_ascii_lowercase();

    to_array(tool_calls)
        .into_iter()
        .map(|entry| {
            let row = to_object(Some(&entry));
            let function = to_object(row.get("function"));
            let mut out = Map::new();
            out.insert(
                "type".to_string(),
                Value::String(
                    read_string(row.get("type")).unwrap_or_else(|| "function".to_string()),
                ),
            );

            let mut out_function = Map::new();
            if let Some(name) = read_string(function.get("name")) {
                out_function.insert("name".to_string(), Value::String(name));
            }
            if arguments_type == "string" {
                out_function.insert(
                    "arguments".to_string(),
                    Value::String(to_string_args(function.get("arguments"))),
                );
            } else {
                out_function.insert(
                    "arguments".to_string(),
                    to_object_args(function.get("arguments")),
                );
            }
            out.insert("function".to_string(), Value::Object(out_function));

            if let Some(id) = read_string(row.get("id")) {
                out.insert("id".to_string(), Value::String(id));
            }
            Value::Object(out)
        })
        .collect()
}

fn normalize_request_message(
    message: &Value,
    request_cfg: &Map<String, Value>,
) -> Map<String, Value> {
    let row = to_object(Some(message));
    let messages_cfg = to_object(request_cfg.get("messages"));
    let allowed_roles = read_string_array(messages_cfg.get("allowedRoles"));
    let requested_role = read_string(row.get("role"));
    let role = requested_role
        .filter(|role| allowed_roles.iter().any(|allowed| allowed == role))
        .unwrap_or_else(|| "user".to_string());

    let mut out = Map::new();
    out.insert("role".to_string(), Value::String(role.clone()));

    if role == "tool" {
        out.insert(
            "content".to_string(),
            Value::String(normalize_tool_content(row.get("content"))),
        );
        if let Some(name) = read_string(row.get("name")) {
            out.insert("name".to_string(), Value::String(name));
        }
        if let Some(tool_call_id) = read_string(row.get("tool_call_id")) {
            out.insert("tool_call_id".to_string(), Value::String(tool_call_id));
        }
        return out;
    }

    match row.get("content") {
        Some(Value::Array(items)) => {
            out.insert(
                "content".to_string(),
                sanitize_historical_user_content(&role, &Value::Array(items.clone())),
            );
        }
        Some(Value::Null) | None => {
            out.insert("content".to_string(), Value::String(String::new()));
        }
        Some(Value::String(text)) => {
            out.insert(
                "content".to_string(),
                sanitize_historical_user_content(&role, &Value::String(text.clone())),
            );
        }
        Some(other) => {
            out.insert("content".to_string(), Value::String(other.to_string()));
        }
    }

    if role == "assistant" && has_array_items(row.get("tool_calls")) {
        let tool_calls = normalize_assistant_tool_calls(row.get("tool_calls"), request_cfg);
        out.insert("tool_calls".to_string(), Value::Array(tool_calls));
        if read_bool(messages_cfg.get("assistantWithToolCallsContentNull")) {
            out.insert("content".to_string(), Value::Null);
        }
    }

    out
}

fn apply_message_rules(messages: &mut Vec<Map<String, Value>>, request_cfg: &Map<String, Value>) {
    let suppress_assistant_tool_calls = request_cfg
        .get("messages")
        .and_then(|value| value.as_object())
        .map(|messages_cfg| read_bool(messages_cfg.get("suppressAssistantToolCalls")))
        .unwrap_or(false);

    let rules = request_cfg
        .get("messagesRules")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();

    if rules.is_empty() {
        if suppress_assistant_tool_calls {
            messages.retain(|message| {
                !(message
                    .get("role")
                    .and_then(|value| value.as_str())
                    .map(|role| role == "assistant")
                    .unwrap_or(false)
                    && has_array_items(message.get("tool_calls")))
            });
        }
        return;
    }

    let mut filtered: Vec<Map<String, Value>> = Vec::new();
    for mut message in messages.drain(..) {
        let mut dropped = false;
        for rule in &rules {
            let rule_row = to_object(Some(rule));
            let when = to_object(rule_row.get("when"));
            let match_role = read_string(when.get("role"))
                .map(|role| {
                    message
                        .get("role")
                        .and_then(|value| value.as_str())
                        .map(|current| current == role)
                        .unwrap_or(false)
                })
                .unwrap_or(true);
            let has_tool_calls = has_array_items(message.get("tool_calls"));
            let match_tools = when
                .get("hasToolCalls")
                .and_then(|value| value.as_bool())
                .map(|expected| expected == has_tool_calls)
                .unwrap_or(true);
            if !match_role || !match_tools {
                continue;
            }

            match read_string(rule_row.get("action")).as_deref() {
                Some("drop") => {
                    dropped = true;
                    break;
                }
                Some("set") => {
                    let set_map = to_object(rule_row.get("set"));
                    for (key, value) in set_map {
                        message.insert(key, value);
                    }
                }
                _ => {}
            }
        }
        if !dropped {
            filtered.push(message);
        }
    }

    *messages = filtered;
}

fn pair_tool_results(messages: &mut [Map<String, Value>]) {
    let mut names_by_id: Map<String, Value> = Map::new();
    for message in messages.iter() {
        if message
            .get("role")
            .and_then(|value| value.as_str())
            .map(|role| role == "assistant")
            .unwrap_or(false)
        {
            for call in to_array(message.get("tool_calls")) {
                let call_row = to_object(Some(&call));
                let function = to_object(call_row.get("function"));
                if let (Some(id), Some(name)) = (
                    read_string(call_row.get("id")),
                    read_string(function.get("name")),
                ) {
                    names_by_id.insert(id, Value::String(name));
                }
            }
        }
    }

    for message in messages.iter_mut() {
        if message
            .get("role")
            .and_then(|value| value.as_str())
            .map(|role| role == "tool")
            .unwrap_or(false)
            && read_string(message.get("name")).is_none()
        {
            if let Some(tool_call_id) = read_string(message.get("tool_call_id")) {
                if let Some(Value::String(name)) = names_by_id.get(&tool_call_id) {
                    message.insert("name".to_string(), Value::String(name.clone()));
                }
            }
        }
    }
}

fn enforce_shell_schema(schema: &Map<String, Value>) -> Map<String, Value> {
    let mut next = schema.clone();
    if !next.get("type").and_then(|value| value.as_str()).is_some() {
        next.insert("type".to_string(), Value::String("object".to_string()));
    }
    let mut properties = to_object(next.get("properties"));
    let command = to_object(properties.get("command"));
    let has_one_of = command
        .get("oneOf")
        .and_then(|value| value.as_array())
        .map(|items| !items.is_empty())
        .unwrap_or(false);
    if !has_one_of {
        let description = read_string(command.get("description")).unwrap_or_else(|| {
            "Shell command. Prefer a single string; an array of argv tokens is also accepted."
                .to_string()
        });
        properties.insert(
            "command".to_string(),
            json!({
                "description": description,
                "oneOf": [
                    { "type": "string" },
                    { "type": "array", "items": { "type": "string" } }
                ]
            }),
        );
        let mut required = read_string_array(next.get("required"));
        if !required.iter().any(|value| value == "command") {
            required.push("command".to_string());
        }
        next.insert(
            "required".to_string(),
            Value::Array(required.into_iter().map(Value::String).collect()),
        );
        if next
            .get("additionalProperties")
            .and_then(|value| value.as_bool())
            .is_none()
        {
            next.insert("additionalProperties".to_string(), Value::Bool(false));
        }
    }
    next.insert("properties".to_string(), Value::Object(properties));
    next
}

fn normalize_tool_parameters(input: Option<&Value>, name: Option<&str>) -> Option<Value> {
    let params = match input {
        None | Some(Value::Null) => return None,
        Some(Value::Object(map)) => map.clone(),
        Some(Value::String(text)) => match serde_json::from_str::<Value>(text) {
            Ok(Value::Object(map)) => map,
            _ => return None,
        },
        _ => return None,
    };

    if matches!(name, Some(value) if value.trim().eq_ignore_ascii_case("shell")) {
        return Some(Value::Object(enforce_shell_schema(&params)));
    }
    Some(Value::Object(params))
}

fn normalize_single_tool(tool_entry: &Value) -> Value {
    let tool = to_object(Some(tool_entry));
    let top_name = read_string(tool.get("name"));
    let top_description = read_string(tool.get("description"));
    let function = to_object(tool.get("function"));
    let name = read_string(function.get("name")).or(top_name);
    let description = read_string(function.get("description")).or(top_description);
    let parameters = normalize_tool_parameters(
        function.get("parameters").or(tool.get("parameters")),
        name.as_deref(),
    );

    let mut normalized_function = Map::new();
    if let Some(name) = name {
        normalized_function.insert("name".to_string(), Value::String(name));
    }
    if let Some(description) = description {
        normalized_function.insert("description".to_string(), Value::String(description));
    }
    if let Some(parameters) = parameters {
        normalized_function.insert("parameters".to_string(), parameters);
    }

    let mut out = Map::new();
    out.insert("type".to_string(), Value::String("function".to_string()));
    out.insert("function".to_string(), Value::Object(normalized_function));
    Value::Object(out)
}

fn normalize_request_tools(container: &mut Map<String, Value>, request_cfg: &Map<String, Value>) {
    let tools_cfg = to_object(request_cfg.get("tools"));
    let normalize = read_bool(tools_cfg.get("normalize"));
    let force_auto = read_bool(tools_cfg.get("forceToolChoiceAuto"));

    if let Some(tools) = container
        .get_mut("tools")
        .and_then(|value| value.as_array_mut())
    {
        if normalize {
            let normalized = tools
                .iter()
                .map(normalize_single_tool)
                .collect::<Vec<Value>>();
            *tools = normalized;
        }
    }

    if force_auto {
        container.insert("tool_choice".to_string(), Value::String("auto".to_string()));
    }

    if !container
        .get("tools")
        .and_then(|value| value.as_array())
        .map(|items| !items.is_empty())
        .unwrap_or(false)
    {
        container.remove("tool_choice");
    }
}

fn apply_request_filter(payload: Value, config: Value) -> Value {
    let src = to_object(Some(&payload));
    let request_cfg = to_object(config.get("request"));
    let allow_top_level = read_string_array(request_cfg.get("allowTopLevel"));
    let mut out = shallow_pick(&src, &allow_top_level);

    let messages = to_array(out.get("messages"));
    let mut normalized_messages = messages
        .iter()
        .map(|message| normalize_request_message(message, &request_cfg))
        .collect::<Vec<Map<String, Value>>>();
    apply_message_rules(&mut normalized_messages, &request_cfg);
    pair_tool_results(&mut normalized_messages);
    out.insert(
        "messages".to_string(),
        Value::Array(normalized_messages.into_iter().map(Value::Object).collect()),
    );

    normalize_request_tools(&mut out, &request_cfg);

    Value::Object(out)
}

fn normalize_response_tool_calls(
    tool_calls: Option<&Value>,
    response_cfg: &Map<String, Value>,
) -> Vec<Value> {
    let arguments_type = response_cfg
        .get("choices")
        .and_then(|value| value.as_object())
        .and_then(|value| value.get("message"))
        .and_then(|value| value.as_object())
        .and_then(|value| value.get("tool_calls"))
        .and_then(|value| value.as_object())
        .and_then(|value| value.get("function"))
        .and_then(|value| value.as_object())
        .and_then(|value| value.get("argumentsType"))
        .and_then(|value| value.as_str())
        .unwrap_or("object")
        .trim()
        .to_ascii_lowercase();

    to_array(tool_calls)
        .into_iter()
        .map(|entry| {
            let row = to_object(Some(&entry));
            let function = to_object(row.get("function"));
            let mut out = Map::new();
            out.insert(
                "type".to_string(),
                Value::String(
                    read_string(row.get("type")).unwrap_or_else(|| "function".to_string()),
                ),
            );

            let mut out_function = Map::new();
            if let Some(name) = read_string(function.get("name")) {
                out_function.insert("name".to_string(), Value::String(name));
            }
            if arguments_type == "string" {
                out_function.insert(
                    "arguments".to_string(),
                    Value::String(to_string_args(function.get("arguments"))),
                );
            } else {
                out_function.insert(
                    "arguments".to_string(),
                    to_object_args(function.get("arguments")),
                );
            }
            out.insert("function".to_string(), Value::Object(out_function));

            if let Some(id) = read_string(row.get("id")) {
                out.insert("id".to_string(), Value::String(id));
            }
            Value::Object(out)
        })
        .collect()
}

fn normalize_response_message(
    message: Option<&Value>,
    response_cfg: &Map<String, Value>,
) -> Map<String, Value> {
    let row = to_object(message);
    let message_cfg = response_cfg
        .get("choices")
        .and_then(|value| value.as_object())
        .and_then(|value| value.get("message"))
        .and_then(|value| value.as_object())
        .cloned()
        .unwrap_or_default();

    let mut out = Map::new();
    out.insert(
        "role".to_string(),
        Value::String(
            read_string(row.get("role"))
                .or_else(|| read_string(message_cfg.get("roleDefault")))
                .unwrap_or_else(|| "assistant".to_string()),
        ),
    );

    if has_array_items(row.get("tool_calls")) {
        let tool_calls = normalize_response_tool_calls(row.get("tool_calls"), response_cfg);
        out.insert("tool_calls".to_string(), Value::Array(tool_calls));
        if read_bool(message_cfg.get("contentNullWhenToolCalls")) {
            out.insert("content".to_string(), Value::Null);
        } else {
            out.insert(
                "content".to_string(),
                row.get("content")
                    .cloned()
                    .unwrap_or_else(|| Value::String(String::new())),
            );
        }
    } else {
        out.insert(
            "content".to_string(),
            row.get("content")
                .cloned()
                .unwrap_or_else(|| Value::String(String::new())),
        );
    }

    if let Some(reasoning_content) = read_string(row.get("reasoning_content")) {
        out.insert(
            "reasoning_content".to_string(),
            Value::String(reasoning_content),
        );
    }
    if let Some(audio) = row.get("audio") {
        out.insert("audio".to_string(), audio.clone());
    }

    out
}

fn normalize_response_choice(
    choice: &Value,
    index: usize,
    response_cfg: &Map<String, Value>,
) -> Value {
    let row = to_object(Some(choice));
    let message = normalize_response_message(row.get("message"), response_cfg);
    let has_tool_calls = has_array_items(message.get("tool_calls"));

    let mut out = Map::new();
    out.insert(
        "index".to_string(),
        row.get("index")
            .cloned()
            .unwrap_or_else(|| Value::from(index as i64)),
    );
    out.insert("message".to_string(), Value::Object(message));
    out.insert(
        "finish_reason".to_string(),
        row.get("finish_reason").cloned().unwrap_or_else(|| {
            if has_tool_calls {
                Value::String("tool_calls".to_string())
            } else {
                Value::Null
            }
        }),
    );
    Value::Object(out)
}

fn responses_filter_bypassed(adapter_context: Option<&Value>) -> bool {
    let env_flag = std::env::var("RCC_COMPAT_FILTER_OFF_RESPONSES")
        .unwrap_or_else(|_| "1".to_string())
        .trim()
        .to_ascii_lowercase();
    let env_bypass = !matches!(env_flag.as_str(), "0" | "false" | "off");

    let entry = adapter_context
        .and_then(|value| value.as_object())
        .and_then(|value| value.get("entryEndpoint").or_else(|| value.get("endpoint")))
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();

    entry == "/v1/responses" || env_bypass
}

fn apply_response_filter(payload: Value, config: Value, adapter_context: Option<Value>) -> Value {
    if responses_filter_bypassed(adapter_context.as_ref()) {
        return payload;
    }

    let src = to_object(Some(&payload));
    let response_cfg = to_object(config.get("response"));
    let allow_top_level = read_string_array(response_cfg.get("allowTopLevel"));
    let mut out = shallow_pick(&src, &allow_top_level);

    let choices = to_array(src.get("choices"));
    out.insert(
        "choices".to_string(),
        Value::Array(
            choices
                .iter()
                .enumerate()
                .map(|(index, choice)| normalize_response_choice(choice, index, &response_cfg))
                .collect(),
        ),
    );

    if let Some(usage) = src.get("usage").and_then(|value| value.as_object()) {
        let usage_allow = response_cfg
            .get("usage")
            .and_then(|value| value.as_object())
            .map(|usage_cfg| read_string_array(usage_cfg.get("allow")))
            .unwrap_or_default();
        out.insert(
            "usage".to_string(),
            Value::Object(shallow_pick(usage, &usage_allow)),
        );
    }

    Value::Object(out)
}

pub fn apply_universal_shape_request_filter_json(
    payload_json: String,
    config_json: Option<String>,
) -> NapiResult<String> {
    let payload = parse_json_value(&payload_json)?;
    let config = parse_config_value(config_json);
    serde_json::to_string(&apply_request_filter(payload, config))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

pub fn apply_universal_shape_response_filter_json(
    payload_json: String,
    config_json: Option<String>,
    adapter_context_json: Option<String>,
) -> NapiResult<String> {
    let payload = parse_json_value(&payload_json)?;
    let config = parse_config_value(config_json);
    let adapter_context = adapter_context_json
        .filter(|raw| !raw.trim().is_empty())
        .map(|raw| parse_json_value(&raw))
        .transpose()?;
    serde_json::to_string(&apply_response_filter(payload, config, adapter_context))
        .map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn universal_shape_filter_request_normalizes_messages_and_tools() {
        let payload = json!({
            "model": "glm-4.7",
            "messages": [
                {
                    "role": "assistant",
                    "content": "pending",
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "function": {
                                "name": "exec_command",
                                "arguments": { "cmd": "pwd" }
                            }
                        }
                    ]
                },
                {
                    "role": "tool",
                    "tool_call_id": "call_1",
                    "content": { "ok": true }
                }
            ],
            "tools": [
                {
                    "name": "shell",
                    "parameters": { "type": "object", "properties": {} }
                }
            ],
            "tool_choice": { "type": "function" },
            "dropMe": true
        });
        let config = json!({
            "request": {
                "allowTopLevel": ["model", "messages", "tools", "tool_choice"],
                "messages": {
                    "allowedRoles": ["system", "user", "assistant", "tool"],
                    "assistantWithToolCallsContentNull": true
                },
                "tools": {
                    "normalize": true,
                    "forceToolChoiceAuto": true
                },
                "assistantToolCalls": {
                    "functionArgumentsType": "string"
                }
            },
            "response": { "allowTopLevel": [], "choices": { "message": {} } }
        });

        let parsed = apply_request_filter(payload, config);
        assert!(parsed.get("dropMe").is_none());
        assert_eq!(parsed["messages"][0]["content"], Value::Null);
        assert_eq!(parsed["messages"][1]["name"], "exec_command");
        assert_eq!(parsed["tool_choice"], "auto");
        assert_eq!(parsed["tools"][0]["type"], "function");
    }

    #[test]
    fn universal_shape_filter_response_filters_choices_and_usage() {
        std::env::set_var("RCC_COMPAT_FILTER_OFF_RESPONSES", "0");
        let payload = json!({
            "id": "resp_1",
            "choices": [
                {
                    "message": {
                        "tool_calls": [
                            {
                                "id": "call_1",
                                "function": {
                                    "name": "exec_command",
                                    "arguments": { "cmd": "pwd" }
                                }
                            }
                        ]
                    }
                }
            ],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 6,
                "ignored": 1
            },
            "dropMe": true
        });
        let config = json!({
            "request": { "allowTopLevel": [], "messages": { "allowedRoles": [] } },
            "response": {
                "allowTopLevel": ["id", "choices", "usage"],
                "choices": {
                    "message": {
                        "roleDefault": "assistant",
                        "contentNullWhenToolCalls": true,
                        "tool_calls": { "function": { "argumentsType": "string" } }
                    }
                },
                "usage": { "allow": ["prompt_tokens", "completion_tokens"] }
            }
        });
        let adapter_context = json!({ "entryEndpoint": "/v1/chat/completions" });

        let parsed = apply_response_filter(payload, config, Some(adapter_context));
        assert!(parsed.get("dropMe").is_none());
        assert_eq!(parsed["choices"][0]["message"]["content"], Value::Null);
        assert_eq!(
            parsed["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"],
            Value::String("{\"cmd\":\"pwd\"}".to_string())
        );
        assert_eq!(parsed["usage"].get("ignored"), None);
    }
}

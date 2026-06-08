use serde_json::{json, Map, Value};

use crate::shared_json_utils::read_trimmed_string;

pub(crate) fn apply_qwen_request_compat(payload: Value, qwenchat_web: bool) -> Value {
    let mut payload = payload;
    let Some(root) = payload.as_object_mut() else {
        return payload;
    };
    root.insert(
        "model".to_string(),
        Value::String("coder-model".to_string()),
    );
    normalize_message_content_types(root);
    normalize_tool_choice(root);
    normalize_tool_definitions(root, qwenchat_web);
    payload
}

pub(crate) fn apply_qwen_response_compat(payload: Value) -> Value {
    let mut payload = unwrap_qwen_data_envelope(payload);
    let Some(root) = payload.as_object_mut() else {
        return payload;
    };
    root.entry("object".to_string())
        .or_insert_with(|| Value::String("chat.completion".to_string()));
    normalize_existing_tool_calls(root);
    harvest_qwen_marker_tool_calls(root);
    payload
}

fn unwrap_qwen_data_envelope(payload: Value) -> Value {
    let Some(root) = payload.as_object() else {
        return payload;
    };
    let Some(data) = root.get("data").and_then(Value::as_object) else {
        return payload;
    };
    if data.get("choices").is_none() {
        return payload;
    }
    Value::Object(data.clone())
}

fn normalize_message_content_types(root: &mut Map<String, Value>) {
    let Some(messages) = root.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    for message in messages {
        let Some(message_obj) = message.as_object_mut() else {
            continue;
        };
        let Some(content) = message_obj.get_mut("content").and_then(Value::as_array_mut) else {
            continue;
        };
        for part in content {
            let Some(part_obj) = part.as_object_mut() else {
                continue;
            };
            let part_type = read_trimmed_string(part_obj.get("type"))
                .map(|v| v.to_ascii_lowercase())
                .unwrap_or_default();
            match part_type.as_str() {
                "input_text" => {
                    part_obj.insert("type".to_string(), Value::String("text".to_string()));
                }
                "input_image" => {
                    part_obj.insert("type".to_string(), Value::String("image_url".to_string()));
                }
                "input_video" => {
                    part_obj.insert("type".to_string(), Value::String("video_url".to_string()));
                    if let Some(raw) = read_trimmed_string(part_obj.get("video_url")) {
                        part_obj.insert("video_url".to_string(), json!({ "url": raw }));
                    }
                }
                _ => {}
            }
        }
    }
}

fn normalize_tool_choice(root: &mut Map<String, Value>) {
    let Some(tool_choice) = root.get_mut("tool_choice") else {
        return;
    };
    let Some(choice_obj) = tool_choice.as_object_mut() else {
        return;
    };
    let choice_type = read_trimmed_string(choice_obj.get("type"))
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_default();
    if choice_type != "function" {
        return;
    }
    if choice_obj
        .get("function")
        .and_then(Value::as_object)
        .is_some()
    {
        return;
    }
    if let Some(name) = read_trimmed_string(choice_obj.get("name")) {
        choice_obj.remove("name");
        choice_obj.insert("function".to_string(), json!({ "name": name }));
    }
}

fn append_desc(target: &mut Map<String, Value>, key: &str, text: &str) {
    let existing = target
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .unwrap_or("");
    if existing.contains(text) {
        return;
    }
    let next = if existing.is_empty() {
        text.to_string()
    } else {
        format!("{} {}", existing, text)
    };
    target.insert(key.to_string(), Value::String(next));
}

fn tool_function_obj_mut(tool: &mut Value) -> Option<&mut Map<String, Value>> {
    let tool_obj = tool.as_object_mut()?;
    if tool_obj
        .get("function")
        .and_then(Value::as_object)
        .is_some()
    {
        return tool_obj.get_mut("function").and_then(Value::as_object_mut);
    }
    Some(tool_obj)
}

fn parameters_obj_mut(function_obj: &mut Map<String, Value>) -> Option<&mut Map<String, Value>> {
    function_obj
        .get_mut("parameters")
        .and_then(Value::as_object_mut)
}

fn property_obj_mut<'a>(
    params: &'a mut Map<String, Value>,
    key: &str,
) -> Option<&'a mut Map<String, Value>> {
    params
        .get_mut("properties")
        .and_then(Value::as_object_mut)
        .and_then(|props| props.get_mut(key))
        .and_then(Value::as_object_mut)
}

fn normalize_tool_definitions(root: &mut Map<String, Value>, qwenchat_web: bool) {
    let Some(tools) = root.get_mut("tools").and_then(Value::as_array_mut) else {
        return;
    };
    for tool in tools {
        let Some(function_obj) = tool_function_obj_mut(tool) else {
            continue;
        };
        let name = read_trimmed_string(function_obj.get("name"))
            .map(|v| v.to_ascii_lowercase())
            .unwrap_or_default();
        match name.as_str() {
            "exec_command" => {
                append_desc(
                    function_obj,
                    "description",
                    "Use only `cmd` as one shell-command string.",
                );
                append_desc(
                    function_obj,
                    "description",
                    "Call the tool directly instead of narrating a plan.",
                );
                if qwenchat_web {
                    append_desc(
                        function_obj,
                        "description",
                        "Treat runtime execution as available here.",
                    );
                    append_desc(
                        function_obj,
                        "description",
                        "Do not refuse with sandbox limitations.",
                    );
                    append_desc(function_obj, "description", "If native function calling is masked, output exactly one RCC_TOOL_CALLS_JSON heredoc dry-run container.");
                }
                if let Some(params) = parameters_obj_mut(function_obj) {
                    if let Some(cmd) = property_obj_mut(params, "cmd") {
                        append_desc(cmd, "description", "Single command string only.");
                    }
                    if qwenchat_web {
                        params.insert(
                            "x-routecodex-qwenchat-dryrun-hint".to_string(),
                            Value::String("If native function calling is masked, output exactly one RCC_TOOL_CALLS_JSON heredoc dry-run container; do not output sandbox/path refusal prose.".to_string()),
                        );
                    }
                }
            }
            "apply_patch" => {
                append_desc(
                    function_obj,
                    "description",
                    "Use the exact tool name `apply_patch`.",
                );
                append_desc(
                    function_obj,
                    "description",
                    "Call the tool directly when needed.",
                );
                append_desc(
                    function_obj,
                    "description",
                    "Patch paths must be workspace-relative.",
                );
                append_desc(function_obj, "description", "Do not use absolute paths.");
                if qwenchat_web {
                    append_desc(function_obj, "description", "If native function calling is masked, output exactly one RCC_TOOL_CALLS_JSON heredoc dry-run container.");
                }
            }
            "update_plan" => {
                append_desc(
                    function_obj,
                    "description",
                    "Use `plan` as the top-level field.",
                );
                append_desc(function_obj, "description", "Do not use `steps`.");
                if let Some(params) = parameters_obj_mut(function_obj) {
                    if let Some(plan) = property_obj_mut(params, "plan") {
                        append_desc(plan, "description", "Do not rename this field to `steps`.");
                    }
                }
            }
            "write_stdin" => {
                append_desc(function_obj, "description", "Use `session_id` as a number.");
                append_desc(function_obj, "description", "Keep the field names exact.");
                if let Some(params) = parameters_obj_mut(function_obj) {
                    if let Some(session_id) = property_obj_mut(params, "session_id") {
                        append_desc(session_id, "description", "Numeric exec session id only.");
                    }
                    if let Some(chars) = property_obj_mut(params, "chars") {
                        append_desc(chars, "description", "Optional stdin text string only.");
                    }
                }
            }
            _ => {}
        }
    }
}

fn normalize_existing_tool_calls(root: &mut Map<String, Value>) {
    let Some(choices) = root.get_mut("choices").and_then(Value::as_array_mut) else {
        return;
    };
    for choice in choices {
        let Some(message) = choice.get_mut("message").and_then(Value::as_object_mut) else {
            continue;
        };
        normalize_legacy_function_call(message);
        let Some(tool_calls) = message.get_mut("tool_calls").and_then(Value::as_array_mut) else {
            continue;
        };
        for (idx, call) in tool_calls.iter_mut().enumerate() {
            let Some(call_obj) = call.as_object_mut() else {
                continue;
            };
            call_obj
                .entry("id".to_string())
                .or_insert_with(|| Value::String(format!("qwen_tool_{}", idx + 1)));
            call_obj
                .entry("type".to_string())
                .or_insert_with(|| Value::String("function".to_string()));
            if let Some(function_obj) = call_obj.get_mut("function").and_then(Value::as_object_mut)
            {
                if let Some(arguments) = function_obj.get("arguments").cloned() {
                    if !arguments.is_string() {
                        function_obj.insert(
                            "arguments".to_string(),
                            Value::String(
                                serde_json::to_string(&arguments)
                                    .unwrap_or_else(|_| "{}".to_string()),
                            ),
                        );
                    }
                }
            }
        }
    }
}

fn normalize_legacy_function_call(message: &mut Map<String, Value>) {
    if message
        .get("tool_calls")
        .and_then(Value::as_array)
        .is_some()
    {
        message.remove("function_call");
        return;
    }
    let Some(function_call) = message
        .get("function_call")
        .and_then(Value::as_object)
        .cloned()
    else {
        return;
    };
    let Some(name) = read_trimmed_string(function_call.get("name")) else {
        return;
    };
    let id = read_trimmed_string(function_call.get("id"))
        .or_else(|| read_trimmed_string(function_call.get("call_id")))
        .unwrap_or_else(|| "qwen_tool_1".to_string());
    let arguments = match function_call.get("arguments") {
        Some(Value::String(text)) => text.clone(),
        Some(other) => serde_json::to_string(other).unwrap_or_else(|_| "{}".to_string()),
        None => "{}".to_string(),
    };
    message.insert(
        "tool_calls".to_string(),
        json!([{
            "id": id,
            "type": "function",
            "function": {
                "name": name,
                "arguments": arguments
            }
        }]),
    );
    message.remove("function_call");
}

fn flatten_content(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if let Some(text) = item.as_str() {
                    return text.to_string();
                }
                let Some(obj) = item.as_object() else {
                    return String::new();
                };
                read_trimmed_string(obj.get("text"))
                    .or_else(|| read_trimmed_string(obj.get("content")))
                    .or_else(|| read_trimmed_string(obj.get("thinking")))
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(obj) => read_trimmed_string(obj.get("text"))
            .or_else(|| read_trimmed_string(obj.get("content")))
            .or_else(|| read_trimmed_string(obj.get("thinking")))
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn normalize_qwen_marker_text(text: &str) -> String {
    let mut out = text.to_string();
    for token in [
        "tool_calls_section_begin",
        "tool_calls_section_end",
        "tool_call_begin",
        "tool_call_argument_begin",
        "tool_call_end",
    ] {
        let compact = format!("<|{}|>", token);
        let loose = regex::Regex::new(&format!(r"(?is)<\|\s*{}\s*\|>", token)).ok();
        if let Some(re) = loose {
            out = re.replace_all(&out, compact.as_str()).to_string();
        }
    }
    out
}

fn find_balanced_json_end(text: &str, start: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    if start >= bytes.len() || bytes[start] != b'{' {
        return None;
    }
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escape = false;
    for (offset, ch) in text[start..].char_indices() {
        if in_string {
            if escape {
                escape = false;
            } else if ch == '\\' {
                escape = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(start + offset + ch.len_utf8());
                }
            }
            _ => {}
        }
    }
    None
}

fn parse_json_with_raw_newline_repair(raw: &str) -> Value {
    if let Ok(value) = serde_json::from_str::<Value>(raw) {
        return value;
    }
    let mut repaired = String::with_capacity(raw.len());
    let mut in_string = false;
    let mut escape = false;
    for ch in raw.chars() {
        if in_string {
            if escape {
                repaired.push(ch);
                escape = false;
                continue;
            }
            match ch {
                '\\' => {
                    repaired.push(ch);
                    escape = true;
                }
                '"' => {
                    repaired.push(ch);
                    in_string = false;
                }
                '\n' => repaired.push_str("\\n"),
                '\r' => repaired.push_str("\\r"),
                '\t' => repaired.push_str("\\t"),
                _ => repaired.push(ch),
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
        }
        repaired.push(ch);
    }
    serde_json::from_str::<Value>(&repaired).unwrap_or_else(|_| json!({}))
}

fn parse_qwen_marker_calls(text: &str) -> Vec<Value> {
    let normalized = normalize_qwen_marker_text(text);
    let Some(call_re) = regex::Regex::new(
        r"(?is)<\|tool_call_begin\|>\s*(?:functions\.)?([A-Za-z_][A-Za-z0-9_.-]*)(?::\d+)?\s*<\|tool_call_argument_begin\|>",
    )
    .ok() else {
        return Vec::new();
    };
    let mut calls = Vec::new();
    for caps in call_re.captures_iter(&normalized) {
        let Some(full) = caps.get(0) else {
            continue;
        };
        let Some(name) = caps
            .get(1)
            .map(|m| m.as_str().trim())
            .filter(|v| !v.is_empty())
        else {
            continue;
        };
        let mut json_start = full.end();
        while json_start < normalized.len()
            && normalized.as_bytes()[json_start].is_ascii_whitespace()
        {
            json_start += 1;
        }
        let Some(json_end) = find_balanced_json_end(&normalized, json_start) else {
            continue;
        };
        let raw_args = &normalized[json_start..json_end];
        let args_value = parse_json_with_raw_newline_repair(raw_args);
        let args = serde_json::to_string(&args_value).unwrap_or_else(|_| "{}".to_string());
        calls.push(json!({
            "id": format!("qwen_tool_{}", calls.len() + 1),
            "type": "function",
            "function": {
                "name": name,
                "arguments": args
            }
        }));
    }
    calls
}

fn strip_qwen_marker_text(text: &str) -> String {
    let normalized = normalize_qwen_marker_text(text);
    let Some(section_re) = regex::Regex::new(
        r"(?is)<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>",
    )
    .ok() else {
        return text.trim().to_string();
    };
    section_re.replace_all(&normalized, "").trim().to_string()
}

fn strip_xml_blocks(text: &str, patterns: &[regex::Regex]) -> String {
    let mut cleaned = text.to_string();
    for pattern in patterns {
        cleaned = pattern.replace_all(&cleaned, "").to_string();
    }
    cleaned.trim().to_string()
}

fn harvest_qwenchat_xml_command_calls(text: &str) -> (Vec<Value>, String) {
    let mut calls: Vec<Value> = Vec::new();
    let mut patterns: Vec<regex::Regex> = Vec::new();
    let mut seen_commands: Vec<String> = Vec::new();
    let specs = [
        (
            r"(?is)<execute_command>\s*<command>\s*([\s\S]*?)\s*</command>\s*(?:<workdir>\s*([\s\S]*?)\s*</workdir>\s*)?</execute_command>",
            true,
        ),
        (
            r"(?is)<command>\s*<grep_command>\s*([\s\S]*?)\s*</grep_command>\s*</command>",
            false,
        ),
        (r"(?is)<command>\s*([\s\S]*?)\s*</command>", false),
    ];
    for (raw_pattern, has_workdir) in specs {
        let Some(pattern) = regex::Regex::new(raw_pattern).ok() else {
            continue;
        };
        for caps in pattern.captures_iter(text) {
            let Some(cmd) = caps
                .get(1)
                .map(|m| m.as_str().trim())
                .filter(|v| !v.is_empty())
            else {
                continue;
            };
            if !has_workdir && cmd.contains('<') {
                continue;
            }
            if seen_commands.iter().any(|seen| seen == cmd) {
                continue;
            }
            seen_commands.push(cmd.to_string());
            let mut args = Map::new();
            args.insert("cmd".to_string(), Value::String(cmd.to_string()));
            if has_workdir {
                if let Some(workdir) = caps
                    .get(2)
                    .map(|m| m.as_str().trim())
                    .filter(|v| !v.is_empty())
                {
                    args.insert("workdir".to_string(), Value::String(workdir.to_string()));
                }
            }
            calls.push(json!({
                "id": format!("qwen_tool_{}", calls.len() + 1),
                "type": "function",
                "function": {
                    "name": "exec_command",
                    "arguments": serde_json::to_string(&Value::Object(args)).unwrap_or_else(|_| "{}".to_string())
                }
            }));
        }
        patterns.push(pattern);
    }
    let cleaned = strip_xml_blocks(text, &patterns);
    (calls, cleaned)
}

fn harvest_qwen_marker_tool_calls(root: &mut Map<String, Value>) {
    let Some(choices) = root.get_mut("choices").and_then(Value::as_array_mut) else {
        return;
    };
    for choice in choices {
        let Some(choice_obj) = choice.as_object_mut() else {
            continue;
        };
        let Some(message) = choice_obj.get_mut("message").and_then(Value::as_object_mut) else {
            continue;
        };
        let content = message.get("content").cloned().unwrap_or(Value::Null);
        let text = flatten_content(&content);
        if text.contains("<command") || text.contains("<execute_command") {
            let (calls, cleaned) = harvest_qwenchat_xml_command_calls(&text);
            if !calls.is_empty() {
                message.insert("tool_calls".to_string(), Value::Array(calls));
                message.insert("content".to_string(), Value::String(cleaned));
                choice_obj.insert(
                    "finish_reason".to_string(),
                    Value::String("tool_calls".to_string()),
                );
                continue;
            }
        }
        if !text.contains("tool_call") && !text.contains("tool_calls") {
            continue;
        }
        let calls = parse_qwen_marker_calls(&text);
        if calls.is_empty() {
            continue;
        }
        let cleaned = strip_qwen_marker_text(&text);
        message.insert("tool_calls".to_string(), Value::Array(calls));
        message.insert("content".to_string(), Value::String(cleaned));
        message.remove("reasoning_content");
        choice_obj.insert(
            "finish_reason".to_string(),
            Value::String("tool_calls".to_string()),
        );
    }
}

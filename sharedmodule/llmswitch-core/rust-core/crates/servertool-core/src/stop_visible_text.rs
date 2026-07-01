use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StopMessageTerminalVisiblePayloadInput {
    pub payload: Value,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub prefix: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopMessageTerminalVisiblePayloadOutput {
    pub payload: Value,
    pub changed: bool,
}

pub fn strip_stop_schema_control_text(text: &str) -> String {
    strip_stop_schema_control_blocks(text)
}

pub fn strip_stop_schema_control_payload(payload: &mut Value) {
    if let Some(output_text) = payload.get_mut("output_text") {
        sanitize_stop_schema_visible_field(Some(output_text));
    }
    if let Some(choices) = payload.get_mut("choices").and_then(Value::as_array_mut) {
        for choice in choices {
            if let Some(message) = choice.get_mut("message") {
                sanitize_stop_schema_visible_node(message);
            }
        }
    }
    if let Some(output) = payload.get_mut("output").and_then(Value::as_array_mut) {
        for item in output {
            sanitize_stop_schema_visible_node(item);
        }
    }
}

pub fn strip_stop_schema_control_value(value: &mut Value) {
    sanitize_stop_schema_visible_value(value);
}

pub fn extract_current_assistant_stop_text(payload: &Value) -> String {
    let mut texts = Vec::<String>::new();
    if let Some(choices) = payload.get("choices").and_then(Value::as_array) {
        for choice in choices {
            let Some(message) = choice.get("message") else {
                continue;
            };
            collect_text_blocks(message.get("content"), &mut texts);
        }
    }
    if let Some(output) = payload.get("output").and_then(Value::as_array) {
        for item in output {
            collect_text_blocks(item.get("content"), &mut texts);
        }
    }
    texts.join("\n").trim().to_string()
}

pub fn extract_current_assistant_reasoning_stop_arguments(payload: &Value) -> Option<String> {
    if let Some(choices) = payload.get("choices").and_then(Value::as_array) {
        for choice in choices.iter().rev() {
            if let Some(arguments) =
                extract_reasoning_stop_arguments_from_chat_message(choice.get("message"))
            {
                return Some(arguments);
            }
        }
    }
    if let Some(output) = payload.get("output").and_then(Value::as_array) {
        for item in output.iter().rev() {
            if let Some(arguments) = extract_reasoning_stop_arguments_from_output_item(item) {
                return Some(arguments);
            }
        }
    }
    if let Some(arguments) =
        extract_reasoning_stop_arguments_from_required_action(payload.get("required_action"))
    {
        return Some(arguments);
    }
    None
}

pub fn build_stop_message_terminal_visible_payload(
    input: StopMessageTerminalVisiblePayloadInput,
) -> StopMessageTerminalVisiblePayloadOutput {
    let mut payload = input.payload;
    strip_stop_schema_control_payload(&mut payload);
    let prefix = input.prefix.unwrap_or_default().trim().to_string();
    let mode = input
        .mode
        .unwrap_or_else(|| "strip".to_string())
        .trim()
        .to_ascii_lowercase();
    let mut changed = false;
    if !prefix.is_empty() {
        changed = match mode.as_str() {
            "replace" => replace_visible_stop_content(&mut payload, &prefix),
            "prefix" => prefix_visible_stop_content(&mut payload, &prefix),
            _ => false,
        };
    }
    if !prefix.is_empty() && !payload_has_any_visible_stop_text(&payload) {
        changed = ensure_visible_stop_content(&mut payload, &prefix) || changed;
    }
    strip_terminal_visible_reasoning_fields(&mut payload);
    changed = normalize_terminal_stop_chat_payload(&mut payload) || changed;
    StopMessageTerminalVisiblePayloadOutput { payload, changed }
}

fn normalize_terminal_stop_chat_payload(payload: &mut Value) -> bool {
    let Some(row) = payload.as_object_mut() else {
        return false;
    };
    let Some(choices) = row.get_mut("choices").and_then(Value::as_array_mut) else {
        return false;
    };
    let mut changed = false;
    for choice in choices.iter_mut() {
        let Some(choice_row) = choice.as_object_mut() else {
            continue;
        };
        if choice_row.get("finish_reason").and_then(Value::as_str) == Some("tool_calls") {
            choice_row.insert(
                "finish_reason".to_string(),
                Value::String("stop".to_string()),
            );
            changed = true;
        }
        if let Some(message_row) = choice_row.get_mut("message").and_then(Value::as_object_mut) {
            if message_row.remove("tool_calls").is_some() {
                changed = true;
            }
        }
    }
    changed
}

fn strip_stop_schema_control_blocks(text: &str) -> String {
    if !has_stop_schema_control_signal(text) {
        return text.to_string();
    }
    let without_xml = remove_tagged_stop_schema_blocks(text);
    let without_fenced = remove_fenced_stop_schema_json(&without_xml);
    let without_inline = remove_inline_reasoning_stop_schema_residue(&without_fenced);
    let without_bare = remove_bare_stop_schema_json_objects(&without_inline);
    let lines: Vec<&str> = without_bare.lines().collect();
    let mut kept = Vec::new();
    for line in lines {
        let trimmed = line.trim();
        if trimmed.contains("停止原因:") || trimmed.contains("停止原因：") {
            continue;
        }
        let trimmed_end = line.trim_end();
        if !trimmed.is_empty() {
            kept.push(trimmed_end.to_string());
        }
    }
    kept.join("\n").trim().to_string()
}

fn has_stop_schema_control_signal(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("<rcc_stop_schema>")
        || lower.contains("<stop_schema>")
        || lower.contains("reasoningstop")
        || lower.contains("停止原因:")
        || lower.contains("停止原因：")
        || text.contains("\"stopreason\"")
}

fn remove_inline_reasoning_stop_schema_residue(text: &str) -> String {
    let mut output = Vec::new();
    for line in text.lines() {
        output.push(strip_inline_reasoning_stop_schema_residue_line(line));
    }
    output.join("\n")
}

fn strip_inline_reasoning_stop_schema_residue_line(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    let Some(reasoning_start) = lower.find("reasoningstop") else {
        return line.to_string();
    };
    if let Some(stripped) = strip_inline_reasoning_stop_json_call(line, reasoning_start) {
        return stripped;
    }
    let Some(next_step_relative) = lower[reasoning_start..].find("next_step") else {
        return line.to_string();
    };
    let next_step_start = reasoning_start + next_step_relative;
    let prefix = line[..reasoning_start].trim_end();
    let suffix = extract_inline_next_step_value_suffix(line, next_step_start);
    join_visible_inline_parts(prefix, suffix.as_deref())
}

fn strip_inline_reasoning_stop_json_call(line: &str, reasoning_start: usize) -> Option<String> {
    let object_start = line[reasoning_start..]
        .find('{')
        .map(|offset| reasoning_start + offset)?;
    let object_end = find_json_object_end(line, object_start)?;
    let candidate = &line[object_start..=object_end];
    if !is_stop_schema_control_json(candidate) {
        return None;
    }
    let prefix = line[..reasoning_start].trim_end();
    let suffix_start = consume_inline_reasoning_stop_trailer(line, object_end + 1);
    let suffix = line[suffix_start..]
        .trim_start_matches(|ch: char| matches!(ch, ')' | ']' | '}' | ',' | ';' | '，' | '；'))
        .trim();
    Some(join_visible_inline_parts(prefix, Some(suffix)))
}

fn consume_inline_reasoning_stop_trailer(line: &str, mut cursor: usize) -> usize {
    while cursor < line.len() {
        let ch = line[cursor..].chars().next().unwrap_or_default();
        if ch.is_whitespace() || matches!(ch, ')' | ']' | '}' | ',' | ';' | '，' | '；') {
            cursor += ch.len_utf8();
            continue;
        }
        break;
    }
    cursor
}

fn extract_inline_next_step_value_suffix(line: &str, next_step_start: usize) -> Option<String> {
    let mut cursor = next_step_start + "next_step".len();
    let bytes = line.as_bytes();
    while cursor < line.len() && bytes[cursor].is_ascii_whitespace() {
        cursor += 1;
    }
    if cursor < line.len() && (bytes[cursor] == b':' || bytes[cursor] == b'=') {
        cursor += 1;
    }
    while cursor < line.len() && bytes[cursor].is_ascii_whitespace() {
        cursor += 1;
    }
    if cursor >= line.len() {
        return None;
    }
    let first = line[cursor..].chars().next()?;
    if first == '"' || first == '\'' {
        let quote = first;
        cursor += first.len_utf8();
        let value_start = cursor;
        let mut escaped = false;
        for (offset, ch) in line[value_start..].char_indices() {
            if escaped {
                escaped = false;
                continue;
            }
            if ch == '\\' {
                escaped = true;
                continue;
            }
            if ch == quote {
                return Some(line[value_start..value_start + offset].trim().to_string());
            }
        }
        return Some(line[value_start..].trim().to_string());
    }

    let suffix = line[cursor..]
        .trim()
        .trim_matches(|ch: char| matches!(ch, ',' | ';' | '，' | '；'))
        .trim();
    if suffix.is_empty() {
        None
    } else {
        Some(suffix.to_string())
    }
}

fn join_visible_inline_parts(prefix: &str, suffix: Option<&str>) -> String {
    let prefix = prefix.trim();
    let suffix = suffix.map(str::trim).filter(|value| !value.is_empty());
    match (prefix.is_empty(), suffix) {
        (true, Some(suffix)) => suffix.to_string(),
        (false, Some(suffix)) => format!("{prefix}\n{suffix}"),
        (false, None) => prefix.to_string(),
        (true, None) => String::new(),
    }
}

fn remove_tagged_stop_schema_blocks(text: &str) -> String {
    let tags = [
        ("<rcc_stop_schema>", "</rcc_stop_schema>"),
        ("<stop_schema>", "</stop_schema>"),
    ];
    let lower = text.to_lowercase();
    let mut cursor = 0usize;
    let mut out = String::with_capacity(text.len());
    while cursor < text.len() {
        let mut matched: Option<(usize, &'static str, &'static str)> = None;
        for (start_tag, end_tag) in tags {
            if let Some(relative_start) = lower[cursor..].find(start_tag) {
                let start = cursor + relative_start;
                match matched {
                    Some((current_start, _, _)) if current_start <= start => {}
                    _ => matched = Some((start, start_tag, end_tag)),
                }
            }
        }
        let Some((start, start_tag, end_tag)) = matched else {
            out.push_str(&text[cursor..]);
            return out;
        };
        out.push_str(&text[cursor..start]);
        let content_start = start + start_tag.len();
        let Some(relative_end) = lower[content_start..].find(end_tag) else {
            if let Some(resume) = consume_unclosed_tagged_stop_schema_block(text, content_start) {
                cursor = resume;
                push_visible_separator_if_needed(&mut out, text, cursor);
                continue;
            }
            out.push_str(&text[start..]);
            return out;
        };
        cursor = content_start + relative_end + end_tag.len();
        push_visible_separator_if_needed(&mut out, text, cursor);
    }
    out
}

fn push_visible_separator_if_needed(out: &mut String, text: &str, cursor: usize) {
    if out.is_empty() || out.ends_with(char::is_whitespace) {
        return;
    }
    let Some(next) = text[cursor..].chars().next() else {
        return;
    };
    if !next.is_whitespace() {
        out.push('\n');
    }
}

fn consume_unclosed_tagged_stop_schema_block(text: &str, content_start: usize) -> Option<usize> {
    let object_start = text[content_start..]
        .find('{')
        .map(|offset| content_start + offset)?;
    let object_end = find_json_object_end(text, object_start)?;
    let candidate = &text[object_start..=object_end];
    if !is_stop_schema_control_json(candidate) {
        return None;
    }
    let mut cursor = object_end + 1;
    while cursor < text.len() {
        let ch = text[cursor..].chars().next().unwrap_or_default();
        if ch.is_whitespace() || matches!(ch, ')' | ']' | '}' | ',' | ';' | '，' | '；') {
            cursor += ch.len_utf8();
            continue;
        }
        break;
    }
    Some(cursor)
}

fn remove_fenced_stop_schema_json(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    while let Some(relative_start) = text[cursor..].find("```") {
        let start = cursor + relative_start;
        out.push_str(&text[cursor..start]);
        let header_end = match text[start + 3..].find('\n') {
            Some(offset) => start + 3 + offset + 1,
            None => {
                out.push_str(&text[start..]);
                return out;
            }
        };
        let Some(relative_end) = text[header_end..].find("```") else {
            out.push_str(&text[start..]);
            return out;
        };
        let end = header_end + relative_end;
        let raw_json = text[header_end..end].trim();
        if !is_stop_schema_control_json(raw_json) {
            out.push_str(&text[start..end + 3]);
        }
        cursor = end + 3;
    }
    out.push_str(&text[cursor..]);
    out
}

fn remove_bare_stop_schema_json_objects(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    while let Some(relative_start) = text[cursor..].find('{') {
        let start = cursor + relative_start;
        out.push_str(&text[cursor..start]);
        let Some(end) = find_json_object_end(text, start) else {
            out.push_str(&text[start..]);
            return out;
        };
        let candidate = &text[start..=end];
        if !is_stop_schema_control_json(candidate) {
            out.push_str(candidate);
        }
        cursor = end + 1;
    }
    out.push_str(&text[cursor..]);
    out
}

fn find_json_object_end(text: &str, start: usize) -> Option<usize> {
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escaped = false;
    for (offset, ch) in text[start..].char_indices() {
        let index = start + offset;
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
            continue;
        }
        if ch == '{' {
            depth += 1;
            continue;
        }
        if ch == '}' {
            depth -= 1;
            if depth == 0 {
                return Some(index);
            }
        }
    }
    None
}

fn is_stop_schema_control_json(raw_json: &str) -> bool {
    let Ok(Value::Object(record)) = serde_json::from_str::<Value>(raw_json.trim()) else {
        return false;
    };
    if !record.contains_key("stopreason") {
        return false;
    }
    [
        "stopreason",
        "reason",
        "has_evidence",
        "evidence",
        "issue_cause",
        "excluded_factors",
        "diagnostic_order",
        "next_step",
        "learned",
    ]
    .iter()
    .any(|key| record.contains_key(*key))
}

fn extract_reasoning_stop_arguments_from_chat_message(message: Option<&Value>) -> Option<String> {
    let record = message?.as_object()?;
    let tool_calls = record.get("tool_calls")?.as_array()?;
    for tool_call in tool_calls.iter().rev() {
        let tool_call_record = tool_call.as_object()?;
        let function = tool_call_record.get("function")?.as_object()?;
        let name = function.get("name").and_then(Value::as_str)?;
        if !is_reasoning_stop_tool_name(name) {
            continue;
        }
        let arguments = function
            .get("arguments")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())?;
        return Some(arguments.to_string());
    }
    None
}

fn extract_reasoning_stop_arguments_from_output_item(item: &Value) -> Option<String> {
    let record = item.as_object()?;
    let item_type = record
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if !matches!(item_type, "function_call" | "custom_tool_call") {
        return None;
    }
    let name = record
        .get("name")
        .or_else(|| record.get("toolName"))
        .and_then(Value::as_str)?;
    if !is_reasoning_stop_tool_name(name) {
        return None;
    }
    record
        .get("arguments")
        .or_else(|| record.get("input"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn extract_reasoning_stop_arguments_from_required_action(
    required_action: Option<&Value>,
) -> Option<String> {
    let tool_calls = required_action?
        .get("submit_tool_outputs")?
        .get("tool_calls")?
        .as_array()?;
    for tool_call in tool_calls.iter().rev() {
        let record = tool_call.as_object()?;
        let name = record
            .get("function")
            .and_then(|function| function.get("name"))
            .or_else(|| record.get("name"))
            .and_then(Value::as_str)?;
        if !is_reasoning_stop_tool_name(name) {
            continue;
        }
        let arguments = record
            .get("function")
            .and_then(|function| function.get("arguments"))
            .or_else(|| record.get("arguments"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())?;
        return Some(arguments.to_string());
    }
    None
}

fn is_reasoning_stop_tool_name(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "reasoningstop" | "reasoning_stop" | "stop_message_auto"
    )
}

fn sanitize_stop_schema_visible_node(node: &mut Value) {
    let Some(row) = node.as_object_mut() else {
        return;
    };
    for field in [
        "content",
        "text",
        "output_text",
        "reasoning_text",
        "reasoning_content",
    ] {
        sanitize_stop_schema_visible_field(row.get_mut(field));
    }
    sanitize_stop_schema_summary_array(row.get_mut("reasoning"));
    sanitize_stop_schema_summary_array(row.get_mut("summary"));
}

fn sanitize_stop_schema_visible_value(value: &mut Value) {
    match value {
        Value::Array(items) => {
            for item in items {
                sanitize_stop_schema_visible_value(item);
            }
        }
        Value::Object(row) => {
            for child in row.values_mut() {
                sanitize_stop_schema_visible_value(child);
            }
            for field in [
                "content",
                "text",
                "output_text",
                "reasoning_text",
                "reasoning_content",
            ] {
                sanitize_stop_schema_visible_field(row.get_mut(field));
            }
            sanitize_stop_schema_summary_array(row.get_mut("reasoning"));
            sanitize_stop_schema_summary_array(row.get_mut("summary"));
        }
        Value::String(text) => {
            *text = strip_stop_schema_control_blocks(text);
        }
        _ => {}
    }
}

fn sanitize_stop_schema_visible_field(value: Option<&mut Value>) {
    let Some(value) = value else {
        return;
    };
    match value {
        Value::String(text) => {
            *text = strip_stop_schema_control_blocks(text);
        }
        Value::Array(items) => {
            for item in items {
                sanitize_stop_schema_visible_node(item);
            }
        }
        _ => {}
    }
}

fn sanitize_stop_schema_summary_array(value: Option<&mut Value>) {
    let Some(value) = value else {
        return;
    };
    match value {
        Value::Array(summary) => {
            for item in summary {
                sanitize_stop_schema_visible_node(item);
            }
        }
        Value::Object(row) => {
            let Some(Value::Array(summary)) = row.get_mut("summary") else {
                return;
            };
            for item in summary {
                sanitize_stop_schema_visible_node(item);
            }
        }
        _ => {}
    }
}

fn collect_text_blocks(value: Option<&Value>, out: &mut Vec<String>) {
    let Some(value) = value else {
        return;
    };
    match value {
        Value::String(text) => {
            let trimmed = text.trim();
            if !trimmed.is_empty() {
                out.push(trimmed.to_string());
            }
        }
        Value::Array(items) => {
            for item in items {
                match item {
                    Value::String(text) => {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            out.push(trimmed.to_string());
                        }
                    }
                    Value::Object(row) => {
                        let text = row
                            .get("text")
                            .and_then(Value::as_str)
                            .or_else(|| row.get("output_text").and_then(Value::as_str))
                            .or_else(|| row.get("content").and_then(Value::as_str))
                            .map(str::trim)
                            .filter(|value| !value.is_empty());
                        if let Some(text) = text {
                            out.push(text.to_string());
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

fn prefix_visible_stop_content(payload: &mut Value, prefix: &str) -> bool {
    let chat_changed = prefix_chat_choice_content(payload, prefix);
    let responses_changed = prefix_responses_output_content(payload, prefix);
    chat_changed || responses_changed
}

fn replace_visible_stop_content(payload: &mut Value, prefix: &str) -> bool {
    let chat_changed = replace_chat_choice_content(payload, prefix);
    let responses_changed = replace_responses_output_content(payload, prefix);
    chat_changed || responses_changed
}

fn prefix_chat_choice_content(payload: &mut Value, prefix: &str) -> bool {
    let Some(choices) = payload.get_mut("choices").and_then(Value::as_array_mut) else {
        return false;
    };
    let mut changed = false;
    for choice in choices {
        let Some(message) = choice.get_mut("message").and_then(Value::as_object_mut) else {
            continue;
        };
        match message.get_mut("content") {
            Some(Value::String(text)) => {
                *text = format!("{prefix}\n{text}");
                changed = true;
            }
            Some(Value::Array(content)) => {
                content.insert(0, json!({ "type": "text", "text": format!("{prefix}\n") }));
                changed = true;
            }
            _ => {}
        }
    }
    changed
}

fn replace_chat_choice_content(payload: &mut Value, prefix: &str) -> bool {
    let Some(choices) = payload.get_mut("choices").and_then(Value::as_array_mut) else {
        return false;
    };
    let mut changed = false;
    for choice in choices {
        let Some(message) = choice.get_mut("message").and_then(Value::as_object_mut) else {
            continue;
        };
        message.insert("content".to_string(), Value::String(prefix.to_string()));
        changed = true;
    }
    changed
}

fn prefix_responses_output_content(payload: &mut Value, prefix: &str) -> bool {
    let Some(output) = payload.get_mut("output").and_then(Value::as_array_mut) else {
        return false;
    };
    for item in output {
        let Some(row) = item.as_object_mut() else {
            continue;
        };
        let Some(Value::Array(content)) = row.get_mut("content") else {
            continue;
        };
        content.insert(
            0,
            json!({ "type": "output_text", "text": format!("{prefix}\n") }),
        );
        if let Some(Value::String(output_text)) = payload.get_mut("output_text") {
            *output_text = format!("{prefix}\n{output_text}");
        }
        return true;
    }
    false
}

fn replace_responses_output_content(payload: &mut Value, prefix: &str) -> bool {
    let Some(output) = payload.get_mut("output").and_then(Value::as_array_mut) else {
        return false;
    };
    let mut changed = false;
    for item in output {
        let Some(row) = item.as_object_mut() else {
            continue;
        };
        if row.get("content").and_then(Value::as_array).is_some()
            || row.get("type") == Some(&Value::String("message".to_string()))
        {
            row.insert(
                "content".to_string(),
                json!([{ "type": "output_text", "text": prefix }]),
            );
            changed = true;
        }
    }
    if changed || payload.get("output_text").and_then(Value::as_str).is_some() {
        if let Some(row) = payload.as_object_mut() {
            row.insert("output_text".to_string(), Value::String(prefix.to_string()));
        }
    }
    changed
}

fn ensure_visible_stop_content(payload: &mut Value, text: &str) -> bool {
    let chat_changed = ensure_chat_visible_stop_content(payload, text);
    let responses_changed = ensure_responses_visible_stop_content(payload, text);
    chat_changed || responses_changed
}

fn ensure_chat_visible_stop_content(payload: &mut Value, text: &str) -> bool {
    let Some(choices) = payload.get_mut("choices").and_then(Value::as_array_mut) else {
        return false;
    };
    let mut changed = false;
    for choice in choices {
        let Some(message) = choice.get_mut("message").and_then(Value::as_object_mut) else {
            continue;
        };
        if message
            .get("content")
            .is_some_and(value_has_visible_stop_text)
        {
            continue;
        }
        message.insert("content".to_string(), Value::String(text.to_string()));
        changed = true;
    }
    changed
}

fn ensure_responses_visible_stop_content(payload: &mut Value, text: &str) -> bool {
    let Some(row) = payload.as_object_mut() else {
        return false;
    };
    let output = row
        .entry("output".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    let Some(items) = output.as_array_mut() else {
        return false;
    };
    for item in items.iter_mut() {
        let Some(item_row) = item.as_object_mut() else {
            continue;
        };
        let item_type = item_row
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if item_type != "message" {
            continue;
        }
        if item_row
            .get("content")
            .is_some_and(value_has_visible_stop_text)
        {
            row.insert("output_text".to_string(), Value::String(text.to_string()));
            return true;
        }
        item_row.insert(
            "content".to_string(),
            json!([{ "type": "output_text", "text": text }]),
        );
        row.insert("output_text".to_string(), Value::String(text.to_string()));
        return true;
    }
    items.push(json!({
        "type": "message",
        "role": "assistant",
        "content": [{ "type": "output_text", "text": text }]
    }));
    row.insert("output_text".to_string(), Value::String(text.to_string()));
    true
}

fn payload_has_any_visible_stop_text(payload: &Value) -> bool {
    payload
        .get("choices")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|choice| {
            choice
                .get("message")
                .and_then(|message| message.get("content"))
                .is_some_and(value_has_visible_stop_text)
        })
        || payload
            .get("output_text")
            .is_some_and(value_has_visible_stop_text)
        || payload
            .get("output")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|item| item.get("content").is_some_and(value_has_visible_stop_text))
}

fn value_has_visible_stop_text(value: &Value) -> bool {
    match value {
        Value::String(text) => !text.trim().is_empty(),
        Value::Array(items) => items.iter().any(value_has_visible_stop_text),
        Value::Object(row) => row
            .get("text")
            .or_else(|| row.get("output_text"))
            .or_else(|| row.get("content"))
            .is_some_and(value_has_visible_stop_text),
        _ => false,
    }
}

fn strip_terminal_visible_reasoning_fields(value: &mut Value) {
    match value {
        Value::Array(items) => {
            let mut index = 0usize;
            while index < items.len() {
                if is_responses_reasoning_item(&items[index]) {
                    items.remove(index);
                    continue;
                }
                strip_terminal_visible_reasoning_fields(&mut items[index]);
                index += 1;
            }
        }
        Value::Object(row) => {
            for key in [
                "reasoning_text",
                "reasoning_content",
                "reasoning",
                "reasoning_details",
            ] {
                row.remove(key);
            }
            for child in row.values_mut() {
                strip_terminal_visible_reasoning_fields(child);
            }
        }
        _ => {}
    }
}

fn is_responses_reasoning_item(value: &Value) -> bool {
    value
        .as_object()
        .and_then(|row| row.get("type"))
        .and_then(Value::as_str)
        == Some("reasoning")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strips_tagged_fenced_and_bare_stop_schema_control_text() {
        let input = r#"
visible before
<rcc_stop_schema>{"stopreason":"blocked","next_step":"repair"}</rcc_stop_schema>
<stop_schema>{"stopreason":"blocked","next_step":"inspect"}</stop_schema>
```json
{"stopreason":"blocked","evidence":["x"]}
```
{"stopreason":"blocked","learned":"x"}
停止原因：blocked
visible after
"#;
        assert_eq!(
            strip_stop_schema_control_text(input),
            "visible before\nvisible after"
        );
    }

    #[test]
    fn preserves_non_stop_schema_json_and_unclosed_json() {
        assert_eq!(
            strip_stop_schema_control_text(r#"keep {"foo":"bar"} tail {"stopreason":"x""#),
            r#"keep {"foo":"bar"} tail {"stopreason":"x""#
        );
    }

    #[test]
    fn strips_inline_reasoning_stop_schema_residue_without_truncating_next_step() {
        assert_eq!(
            strip_stop_schema_control_text(
                r#"阶段结果：计数已修复。 reasoningStop with2 -> next_step: "继续补 provider 黑盒并重放线上样本" Jason, 我继续执行。"#
            ),
            "阶段结果：计数已修复。\n继续补 provider 黑盒并重放线上样本"
        );
    }

    #[test]
    fn strips_unclosed_tagged_stop_schema_without_dropping_visible_prefix_or_suffix() {
        assert_eq!(
            strip_stop_schema_control_text(
                r#"结论：DONE<rcc_stop_schema>{"stopreason":0,"reason":"done","next_step":"无"} 尾部可见"#
            ),
            "结论：DONE\n尾部可见"
        );
    }

    #[test]
    fn strips_inline_reasoning_stop_json_call_without_truncating_visible_text() {
        assert_eq!(
            strip_stop_schema_control_text(
                r#"阶段结果：已完成 reasoningStop({"stopreason":0,"reason":"done","next_step":"无"}); Jason, 后续可继续验证。"#
            ),
            "阶段结果：已完成\nJason, 后续可继续验证。"
        );
    }

    #[test]
    fn strips_payload_visible_fields_recursively() {
        let mut payload = json!({
            "choices": [{
                "message": {
                    "content": [
                        { "type": "text", "text": "answer {\"stopreason\":\"x\",\"next_step\":\"n\"}" },
                        { "type": "reasoning_text", "reasoning_text": "<rcc_stop_schema>{\"stopreason\":\"x\"}</rcc_stop_schema>plan" }
                    ],
                    "reasoning": {
                        "summary": [{ "text": "summary ```json\n{\"stopreason\":\"x\"}\n``` ok" }]
                    }
                }
            }],
            "output": [{
                "content": [{ "output_text": "out 停止原因：x\nok" }]
            }]
        });
        strip_stop_schema_control_payload(&mut payload);
        assert_eq!(
            payload["choices"][0]["message"]["content"][0]["text"],
            "answer"
        );
        assert_eq!(
            payload["choices"][0]["message"]["content"][1]["reasoning_text"],
            "plan"
        );
        assert_eq!(
            payload["choices"][0]["message"]["reasoning"]["summary"][0]["text"],
            "summary  ok"
        );
        assert_eq!(payload["output"][0]["content"][0]["output_text"], "ok");
    }

    #[test]
    fn strips_payload_visible_summary_arrays_on_output_items() {
        let mut payload = json!({
            "output": [{
                "type": "reasoning",
                "summary": [{
                    "type": "summary_text",
                    "text": "**Thinking** done\n<rcc_stop_schema>\n{\"stopreason\":0,\"reason\":\"done\"}\n</rcc_stop_schema>"
                }]
            }]
        });

        strip_stop_schema_control_payload(&mut payload);

        assert_eq!(
            payload["output"][0]["summary"][0]["text"],
            "**Thinking** done"
        );
    }

    #[test]
    fn strips_payload_top_level_output_text() {
        let mut payload = json!({
            "output_text": "## 完成内容\n<rcc_stop_schema>\n{\"stopreason\":0,\"reason\":\"done\"}\n</rcc_stop_schema>"
        });

        strip_stop_schema_control_payload(&mut payload);

        assert_eq!(payload["output_text"], "## 完成内容");
    }

    #[test]
    fn strips_arbitrary_nested_visible_value() {
        let mut payload = json!({
            "type": "response.output_item.added",
            "item": {
                "type": "reasoning",
                "summary": [{
                    "type": "summary_text",
                    "text": "**Thinking** keep going\n<rcc_stop_schema>\n{\"stopreason\":2,\"reason\":\"continue\"}\n</rcc_stop_schema>"
                }]
            }
        });

        strip_stop_schema_control_value(&mut payload);

        assert!(!payload.to_string().contains("<rcc_stop_schema>"));
        assert_eq!(
            payload["item"]["summary"][0]["text"],
            "**Thinking** keep going"
        );
    }

    #[test]
    fn extracts_current_assistant_stop_text_from_all_chat_and_responses_items() {
        let payload = json!({
            "choices": [{
                "message": {
                    "content": [
                        { "text": "one" },
                        { "output_text": "two" },
                        "three"
                    ]
                }
            }],
            "output": [{
                "content": [
                    { "output_text": "four" },
                    { "content": "five" }
                ]
            }]
        });
        assert_eq!(
            extract_current_assistant_stop_text(&payload),
            "one\ntwo\nthree\nfour\nfive"
        );
    }

    #[test]
    fn builds_prefixed_terminal_chat_payload_without_reasoning_or_stop_schema() {
        let output =
            build_stop_message_terminal_visible_payload(StopMessageTerminalVisiblePayloadInput {
                payload: json!({
                    "choices": [{
                        "message": {
                            "content": "answer {\"stopreason\":\"0\",\"reason\":\"done\"}",
                            "reasoning": { "summary": [{ "text": "private" }] }
                        }
                    }]
                }),
                mode: Some("prefix".to_string()),
                prefix: Some("summary".to_string()),
            });
        assert!(output.changed);
        assert_eq!(
            output.payload["choices"][0]["message"]["content"],
            "summary\nanswer"
        );
        assert!(output.payload["choices"][0]["message"]
            .get("reasoning")
            .is_none());
    }

    #[test]
    fn builds_replaced_terminal_responses_payload_and_removes_reasoning_items() {
        let output =
            build_stop_message_terminal_visible_payload(StopMessageTerminalVisiblePayloadInput {
                payload: json!({
                    "output_text": "old",
                    "output": [
                        { "type": "reasoning", "summary": [{ "text": "private" }] },
                        { "type": "message", "content": [{ "type": "output_text", "text": "old" }] }
                    ]
                }),
                mode: Some("replace".to_string()),
                prefix: Some("needs user".to_string()),
            });
        assert!(output.changed);
        assert_eq!(output.payload["output_text"], "needs user");
        assert_eq!(output.payload["output"].as_array().unwrap().len(), 1);
        assert_eq!(
            output.payload["output"][0]["content"][0]["text"],
            "needs user"
        );
    }

    #[test]
    fn replace_updates_chat_and_responses_visible_surfaces_without_short_circuit() {
        let output =
            build_stop_message_terminal_visible_payload(StopMessageTerminalVisiblePayloadInput {
                payload: json!({
                    "choices": [{
                        "finish_reason": "stop",
                        "message": { "role": "assistant", "content": "继续执行中" }
                    }],
                    "output_text": "继续执行中",
                    "output": [{
                        "type": "message",
                        "role": "assistant",
                        "content": [{ "type": "output_text", "text": "继续执行中" }]
                    }]
                }),
                mode: Some("replace".to_string()),
                prefix: Some("stopless budget exhausted".to_string()),
            });
        assert!(output.changed);
        assert_eq!(
            output.payload["choices"][0]["message"]["content"],
            "stopless budget exhausted"
        );
        assert_eq!(output.payload["output_text"], "stopless budget exhausted");
        assert_eq!(
            output.payload["output"][0]["content"][0]["text"],
            "stopless budget exhausted"
        );
    }

    #[test]
    fn terminal_chat_schema_only_uses_stop_reason_as_visible_text() {
        let output = build_stop_message_terminal_visible_payload(
            StopMessageTerminalVisiblePayloadInput {
                payload: json!({
                    "choices": [{
                        "finish_reason": "tool_calls",
                        "message": {
                            "content": "<rcc_stop_schema>{\"stopreason\":0,\"reason\":\"验证已经完成\"}</rcc_stop_schema>",
                            "tool_calls": [{ "id": "call_stop", "type": "function" }]
                        }
                    }]
                }),
                mode: Some("replace".to_string()),
                prefix: Some("停止原因：验证已经完成".to_string()),
            },
        );
        assert!(output.changed);
        assert_eq!(output.payload["choices"][0]["finish_reason"], "stop");
        assert_eq!(
            output.payload["choices"][0]["message"]["content"],
            "停止原因：验证已经完成"
        );
        assert!(output.payload["choices"][0]["message"]
            .get("tool_calls")
            .is_none());
    }

    #[test]
    fn terminal_responses_schema_only_uses_stop_reason_as_visible_output_text() {
        let output = build_stop_message_terminal_visible_payload(
            StopMessageTerminalVisiblePayloadInput {
                payload: json!({
                    "status": "completed",
                    "output": [{
                        "type": "message",
                        "role": "assistant",
                        "content": [{
                            "type": "output_text",
                            "text": "<rcc_stop_schema>{\"stopreason\":0,\"reason\":\"验证已经完成\"}</rcc_stop_schema>"
                        }]
                    }]
                }),
                mode: Some("replace".to_string()),
                prefix: Some("停止原因：验证已经完成".to_string()),
            },
        );
        assert!(output.changed);
        assert_eq!(output.payload["output_text"], "停止原因：验证已经完成");
        assert_eq!(
            output.payload["output"][0]["content"][0]["text"],
            "停止原因：验证已经完成"
        );
    }

    #[test]
    fn reasoning_stop_arguments_can_come_from_responses_required_action() {
        let payload = json!({
            "id": "resp_required_action_reasoning_stop",
            "status": "requires_action",
            "required_action": {
                "type": "submit_tool_outputs",
                "submit_tool_outputs": {
                    "tool_calls": [{
                        "id": "call_required_action_reasoning_stop",
                        "type": "function",
                        "function": {
                            "name": "reasoningStop",
                            "arguments": "{\"stopreason\":2,\"reason\":\"continue\"}"
                        }
                    }]
                }
            }
        });
        let arguments = extract_current_assistant_reasoning_stop_arguments(&payload);
        assert_eq!(
            arguments.as_deref(),
            Some("{\"stopreason\":2,\"reason\":\"continue\"}")
        );
    }
}

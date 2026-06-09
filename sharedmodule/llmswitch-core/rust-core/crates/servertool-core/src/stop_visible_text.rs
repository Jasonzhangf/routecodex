use serde_json::Value;

pub fn strip_stop_schema_control_text(text: &str) -> String {
    strip_stop_schema_control_blocks(text)
}

pub fn strip_stop_schema_control_payload(payload: &mut Value) {
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

fn strip_stop_schema_control_blocks(text: &str) -> String {
    let without_xml = remove_tagged_stop_schema_blocks(text);
    let without_fenced = remove_fenced_stop_schema_json(&without_xml);
    let without_bare = remove_bare_stop_schema_json_objects(&without_fenced);
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

fn remove_tagged_stop_schema_blocks(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    let lower = text.to_lowercase();
    while let Some(relative_start) = lower[cursor..].find("<stop_schema>") {
        let start = cursor + relative_start;
        out.push_str(&text[cursor..start]);
        let content_start = start + "<stop_schema>".len();
        let Some(relative_end) = lower[content_start..].find("</stop_schema>") else {
            out.push_str(&text[start..]);
            return out;
        };
        cursor = content_start + relative_end + "</stop_schema>".len();
    }
    out.push_str(&text[cursor..]);
    out
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
    let Some(Value::Object(row)) = value else {
        return;
    };
    let Some(Value::Array(summary)) = row.get_mut("summary") else {
        return;
    };
    for item in summary {
        sanitize_stop_schema_visible_node(item);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strips_tagged_fenced_and_bare_stop_schema_control_text() {
        let input = r#"
visible before
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
    fn strips_payload_visible_fields_recursively() {
        let mut payload = json!({
            "choices": [{
                "message": {
                    "content": [
                        { "type": "text", "text": "answer {\"stopreason\":\"x\",\"next_step\":\"n\"}" },
                        { "type": "reasoning_text", "reasoning_text": "<stop_schema>{\"stopreason\":\"x\"}</stop_schema>plan" }
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
}

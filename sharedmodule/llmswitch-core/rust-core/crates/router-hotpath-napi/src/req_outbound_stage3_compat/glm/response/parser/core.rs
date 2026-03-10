#[derive(Debug, Clone)]
struct ToolCallMatch {
    start: usize,
    end: usize,
    name: String,
    args: String,
}

fn push_match(matches: &mut Vec<ToolCallMatch>, candidate: ToolCallMatch) {
    let exists = matches.iter().any(|entry| {
        entry.start == candidate.start
            && entry.end == candidate.end
            && entry.name == candidate.name
            && entry.args == candidate.args
    });
    if !exists {
        matches.push(candidate);
    }
}

fn parse_tool_call_json(body: &str, name_hint: Option<&str>) -> Option<(String, String)> {
    let parsed: Value = serde_json::from_str(body.trim()).ok()?;
    let row = parsed.as_object()?;
    let name = row
        .get("name")
        .and_then(|v| v.as_str())
        .or_else(|| row.get("tool_name").and_then(|v| v.as_str()))
        .or_else(|| row.get("tool").and_then(|v| v.as_str()))
        .or(name_hint)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())?;
    let args_source = row
        .get("arguments")
        .or_else(|| row.get("input"))
        .or_else(|| row.get("params"))
        .or_else(|| row.get("parameters"))
        .or_else(|| row.get("payload"));
    let args = match args_source {
        Some(Value::String(raw)) if !raw.trim().is_empty() => raw.trim().to_string(),
        Some(other) => serde_json::to_string(other).unwrap_or_else(|_| "{}".to_string()),
        None => "{}".to_string(),
    };
    Some((name, args))
}

fn parse_tagged_value(raw: &str) -> Value {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Value::String(String::new());
    }
    serde_json::from_str(trimmed).unwrap_or_else(|_| Value::String(trimmed.to_string()))
}

fn parse_tagged_arg_block(block: &str) -> Option<Map<String, Value>> {
    let tag_re = Regex::new(r"(?s)<arg_key>(.*?)</arg_key>\s*<arg_value>(.*?)</arg_value>").ok()?;
    let mut out = Map::<String, Value>::new();
    for captures in tag_re.captures_iter(block) {
        let key = captures
            .get(1)
            .map(|m| m.as_str().trim().to_string())
            .unwrap_or_default();
        if key.is_empty() {
            continue;
        }
        let value = captures.get(2).map(|m| m.as_str()).unwrap_or("");
        out.insert(key, parse_tagged_value(value));
    }
    if out.is_empty() {
        return None;
    }
    Some(out)
}

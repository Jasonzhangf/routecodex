fn extract_custom_tag_calls(text: &str, matches: &mut Vec<ToolCallMatch>) {
    let Some(custom_re) = Regex::new(r#"(?s)<tool_call(?:\s+name="([^"]+)")?>(.*?)</tool_call>"#).ok()
    else {
        return;
    };
    for captures in custom_re.captures_iter(text) {
        let Some(full) = captures.get(0) else {
            continue;
        };
        let name_hint = captures.get(1).map(|m| m.as_str());
        let body = captures.get(2).map(|m| m.as_str()).unwrap_or("");
        let Some((name, args)) = parse_tool_call_json(body, name_hint) else {
            continue;
        };
        push_match(
            matches,
            ToolCallMatch {
                start: full.start(),
                end: full.end(),
                name,
                args,
            },
        );
    }
}

fn extract_generic_calls(text: &str, matches: &mut Vec<ToolCallMatch>) {
    let Some(fenced_re) =
        Regex::new(r"(?is)```(?:tool|function|tool_call|function_call)?\s*(.*?)\s*```").ok()
    else {
        return;
    };
    for captures in fenced_re.captures_iter(text) {
        let Some(full) = captures.get(0) else {
            continue;
        };
        let body = captures.get(1).map(|m| m.as_str()).unwrap_or("");
        let Some((name, args)) = parse_tool_call_json(body, None) else {
            continue;
        };
        push_match(
            matches,
            ToolCallMatch {
                start: full.start(),
                end: full.end(),
                name,
                args,
            },
        );
    }

    let Some(tool_call_pattern) =
        Regex::new(r#"(?is)\[tool_call(?:\s+name="([^"]+)")?\](.*?)\[/tool_call\]"#).ok()
    else {
        return;
    };
    let Some(function_call_pattern) = Regex::new(
        r#"(?is)\[function_call(?:\s+name="([^"]+)")?\](.*?)\[/function_call\]"#,
    )
    .ok()
    else {
        return;
    };
    let bracketed_patterns = [tool_call_pattern, function_call_pattern];
    for pattern in bracketed_patterns {
        for captures in pattern.captures_iter(text) {
            let Some(full) = captures.get(0) else {
                continue;
            };
            let name_hint = captures.get(1).map(|m| m.as_str());
            let body = captures.get(2).map(|m| m.as_str()).unwrap_or("");
            let Some((name, args)) = parse_tool_call_json(body, name_hint) else {
                continue;
            };
            push_match(
                matches,
                ToolCallMatch {
                    start: full.start(),
                    end: full.end(),
                    name,
                    args,
                },
            );
        }
    }

    let Some(inline_marker_re) = Regex::new(r"(?is)(?:tool_call|function_call)\s*[:=]").ok() else {
        return;
    };
    for marker in inline_marker_re.find_iter(text) {
        let mut body_start = marker.end();
        while body_start < text.len() && text.as_bytes()[body_start].is_ascii_whitespace() {
            body_start += 1;
        }
        if body_start >= text.len() || text.as_bytes()[body_start] != b'{' {
            continue;
        }
        let Some(body_end) = find_balanced_json_end(text, body_start) else {
            continue;
        };
        let body = &text[body_start..body_end];
        let Some((name, args)) = parse_tool_call_json(body, None) else {
            continue;
        };
        push_match(
            matches,
            ToolCallMatch {
                start: marker.start(),
                end: body_end,
                name,
                args,
            },
        );
    }
}

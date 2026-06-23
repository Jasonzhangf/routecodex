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
                id: None,
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
                id: None,
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
                    id: None,
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
                id: None,
                name,
                args,
            },
        );
    }
}

fn infer_marker_tool_name(args: &str) -> Option<String> {
    let args = parse_tool_args_object(args)?;
    if read_non_empty_string_arg(&args, "cmd").is_some() {
        return Some("exec_command".to_string());
    }
    None
}

fn extract_glm_marker_calls(text: &str, matches: &mut Vec<ToolCallMatch>) {
    if !text.contains("<|tool_calls_section_begin|>")
        || !text.contains("<|tool_call_argument_begin|>")
    {
        return;
    }
    let Some(call_re) = Regex::new(
        r"(?is)<\|tool_call_begin\|>\s*([A-Za-z0-9_.:-]+)\s*<\|tool_call_argument_begin\|>\s*",
    )
    .ok()
    else {
        return;
    };
    for captures in call_re.captures_iter(text) {
        let Some(full_start) = captures.get(0) else {
            continue;
        };
        let Some(id_match) = captures.get(1) else {
            continue;
        };
        let args_start = full_start.end();
        if args_start >= text.len() || text.as_bytes()[args_start] != b'{' {
            continue;
        }
        let Some(args_end) = find_balanced_json_end(text, args_start) else {
            continue;
        };
        let args = &text[args_start..args_end];
        let Some(name) = infer_marker_tool_name(args) else {
            continue;
        };
        if !tool_call_args_are_harvestable(name.as_str(), args) {
            continue;
        }
        let tail = &text[args_end..];
        let end = tail
            .find("<|tool_call_end|>")
            .map(|offset| args_end + offset + "<|tool_call_end|>".len())
            .unwrap_or(args_end);
        push_match(
            matches,
            ToolCallMatch {
                start: full_start.start(),
                end,
                id: Some(id_match.as_str().trim().to_string()),
                name,
                args: args.to_string(),
            },
        );
    }
}

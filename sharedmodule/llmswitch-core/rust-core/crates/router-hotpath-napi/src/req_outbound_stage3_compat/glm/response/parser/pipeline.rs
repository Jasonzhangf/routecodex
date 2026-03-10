pub(super) fn extract_tool_calls_from_text(
    text: &str,
    choice_idx: usize,
) -> Option<(Vec<Value>, Option<String>)> {
    let inline_name_re = Regex::new(r"^[\s\r\n]*([A-Za-z0-9_.:-]+)").ok()?;
    let mut matches: Vec<ToolCallMatch> = Vec::new();

    extract_custom_tag_calls(text, &mut matches);
    extract_generic_calls(text, &mut matches);
    extract_tagged_sequence_calls(text, &mut matches);

    if matches.is_empty() && text.contains("<arg_key>") {
        if let Some(inline) = inline_name_re.captures(text).and_then(|c| c.get(1)) {
            let name = inline.as_str().trim().to_string();
            if !name.is_empty() {
                let block = &text[inline.end()..];
                if let Some(args_record) = parse_tagged_arg_block(block) {
                    let args = serde_json::to_string(&args_record).unwrap_or_else(|_| "{}".to_string());
                    push_match(
                        &mut matches,
                        ToolCallMatch {
                            start: 0,
                            end: text.len(),
                            name,
                            args,
                        },
                    );
                }
            }
        }
    }

    if matches.is_empty() {
        return None;
    }

    matches.sort_by_key(|entry| entry.start);
    let tool_calls = matches
        .iter()
        .enumerate()
        .map(|(idx, entry)| {
            json!({
                "id": format!("glm_tool_{}_{}", choice_idx, idx + 1),
                "type": "function",
                "function": {
                    "name": entry.name,
                    "arguments": entry.args
                }
            })
        })
        .collect::<Vec<_>>();

    matches.sort_by(|a, b| b.start.cmp(&a.start));
    let mut cleaned = text.to_string();
    for entry in matches {
        if entry.start <= entry.end && entry.end <= cleaned.len() {
            cleaned.replace_range(entry.start..entry.end, "");
        }
    }
    let reasoning = cleaned.trim().to_string();
    let reasoning = if reasoning.is_empty() {
        None
    } else {
        Some(reasoning)
    };
    Some((tool_calls, reasoning))
}

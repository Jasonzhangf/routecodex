fn extract_tagged_sequence_calls(text: &str, matches: &mut Vec<ToolCallMatch>) {
    const OPEN: &str = "<tool_call";
    const CLOSE: &str = "</tool_call>";

    let Some(attr_name_re) = Regex::new(r#"name="([^"]+)""#).ok() else {
        return;
    };
    let Some(inline_name_re) = Regex::new(r"^[\s\r\n]*([A-Za-z0-9_.:-]+)").ok() else {
        return;
    };

    let mut cursor = 0usize;
    while cursor < text.len() {
        let Some(rel_start) = text[cursor..].find(OPEN) else {
            break;
        };
        let start = cursor + rel_start;
        let Some(rel_tag_end) = text[start..].find('>') else {
            break;
        };
        let tag_end = start + rel_tag_end;
        let open_tag = &text[start..=tag_end];
        let explicit_name = attr_name_re
            .captures(open_tag)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().trim().to_string())
            .filter(|v| !v.is_empty());

        let body_start = tag_end + 1;
        let rel_close = text[body_start..].find(CLOSE);
        let rel_next_open = text[body_start..].find(OPEN);

        let (body_end, end) = match (rel_close, rel_next_open) {
            (Some(close), Some(next_open)) if close < next_open => {
                let abs_close = body_start + close;
                (abs_close, abs_close + CLOSE.len())
            }
            (Some(close), _) => {
                let abs_close = body_start + close;
                (abs_close, abs_close + CLOSE.len())
            }
            (None, Some(next_open)) => {
                let abs_next_open = body_start + next_open;
                (abs_next_open, abs_next_open)
            }
            (None, None) => (text.len(), text.len()),
        };

        let mut block = text[body_start..body_end].to_string();
        let mut name = explicit_name.unwrap_or_default();
        if name.is_empty() {
            if let Some(inline) = inline_name_re.captures(&block).and_then(|c| c.get(1)) {
                name = inline.as_str().trim().to_string();
                if !name.is_empty() {
                    block = block[inline.end()..].to_string();
                }
            }
        }

        if !name.is_empty() {
            if let Some(args_record) = parse_tagged_arg_block(&block) {
                if let Some(args) =
                    stringify_tool_args_if_harvestable(name.as_str(), &Value::Object(args_record))
                {
                    push_match(
                        matches,
                        ToolCallMatch {
                            start,
                            end,
                            name,
                            args,
                        },
                    );
                }
            }
        }

        cursor = if end > start { end } else { start + OPEN.len() };
    }
}

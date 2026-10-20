use serde_json::{Map, Value};

const THINKING_OPEN: &str = "<thinking>";
const THINKING_CLOSE: &str = "</thinking>";

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct V3ThinkingTagTextProjection {
    pub(crate) visible: String,
    pub(crate) reasoning: Vec<String>,
    pub(crate) tag_observed: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct V3DirectThinkingOutputItemPlan {
    pub(crate) item_id: Option<String>,
    pub(crate) output_index: usize,
    pub(crate) visible: String,
    pub(crate) reasoning: Vec<String>,
    pub(crate) pure_reasoning: bool,
}

#[cfg(test)]
fn project_v3_thinking_tag_text(text: &str) -> V3ThinkingTagTextProjection {
    project_v3_thinking_tag_text_with_tools(text, false)
}

pub(crate) fn project_v3_thinking_tag_text_with_tools(
    text: &str,
    has_complete_tools: bool,
) -> V3ThinkingTagTextProjection {
    // Tool harvesting has already run at its payload owner. Any serialized
    // invocation left here is opaque business text, including its arguments.
    if crate::tool_markup_parser::scan_tool_markup(
        text,
        &crate::tool_markup_parser::ToolMarkupDeclarations::default(),
    )
    .opaque_invocation
    {
        return V3ThinkingTagTextProjection {
            visible: text.to_owned(),
            ..Default::default()
        };
    }
    let protected = protected_text_ranges(text);
    let mut projection = V3ThinkingTagTextProjection::default();
    let mut cursor = 0usize;
    while cursor < text.len() {
        let open = find_unprotected(text, THINKING_OPEN, cursor, &protected);
        let close = find_unprotected(text, THINKING_CLOSE, cursor, &protected);
        match (open, close) {
            (None, None) => {
                projection.visible.push_str(&text[cursor..]);
                break;
            }
            (None, Some(close)) => {
                projection.tag_observed = true;
                projection.visible.push_str(&text[cursor..close]);
                cursor = close + THINKING_CLOSE.len();
            }
            (Some(open), Some(close)) if close < open => {
                projection.tag_observed = true;
                projection.visible.push_str(&text[cursor..close]);
                cursor = close + THINKING_CLOSE.len();
            }
            (Some(open), _) => {
                projection.tag_observed = true;
                projection.visible.push_str(&text[cursor..open]);
                let body_start = open + THINKING_OPEN.len();
                if let Some(close) = find_unprotected(text, THINKING_CLOSE, body_start, &protected)
                {
                    let body = &text[body_start..close];
                    if !body.is_empty() {
                        projection.reasoning.push(body.to_string());
                    }
                    cursor = close + THINKING_CLOSE.len();
                } else if !has_complete_tools
                    && projection.visible.is_empty()
                    && projection.reasoning.is_empty()
                {
                    let body = &text[body_start..];
                    if !body.is_empty() {
                        projection.reasoning.push(body.to_string());
                    }
                    break;
                } else {
                    projection.visible.push_str(&text[body_start..]);
                    break;
                }
            }
        }
    }
    projection
}

pub(crate) fn analyze_v3_direct_thinking_output(
    output: &[Value],
) -> Vec<V3DirectThinkingOutputItemPlan> {
    let has_tools = output.iter().any(output_item_has_complete_tool);
    output
        .iter()
        .enumerate()
        .filter_map(|(output_index, item)| {
            let (visible_parts, reasoning, tag_observed) =
                project_output_item_texts(item, has_tools)?;
            tag_observed.then(|| {
                let visible = visible_parts.concat();
                V3DirectThinkingOutputItemPlan {
                    item_id: item
                        .get("id")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    output_index,
                    pure_reasoning: !reasoning.is_empty() && visible.is_empty(),
                    visible,
                    reasoning,
                }
            })
        })
        .collect()
}

pub(crate) fn normalize_v3_direct_thinking_json(value: &mut Value) -> bool {
    normalize_thinking_json_with_tool_context(value, None)
}

pub(crate) fn normalize_thinking_json_with_tool_context(
    value: &mut Value,
    has_tools: Option<bool>,
) -> bool {
    let Some(object) = value.as_object_mut() else {
        return false;
    };
    if let Some(response) = object.get_mut("response").and_then(Value::as_object_mut) {
        if normalize_v3_direct_thinking_object(response, has_tools) {
            return true;
        }
    }
    normalize_v3_direct_thinking_object(object, has_tools)
}

fn normalize_v3_direct_thinking_object(
    object: &mut Map<String, Value>,
    has_tools: Option<bool>,
) -> bool {
    let Some(output) = object.get_mut("output").and_then(Value::as_array_mut) else {
        return false;
    };
    let original_text: String = output
        .iter()
        .filter_map(|item| item["content"].as_array())
        .flatten()
        .filter_map(|part| part["text"].as_str())
        .collect();
    let has_tools = has_tools.unwrap_or_else(|| output.iter().any(output_item_has_complete_tool));
    let mut transformed = Vec::with_capacity(output.len());
    let mut appended_reasoning = Vec::new();
    let mut changed = false;
    for (output_index, item) in output.iter().enumerate() {
        let Some((visible_parts, reasoning, tag_observed)) =
            project_output_item_texts(item, has_tools)
        else {
            transformed.push(item.clone());
            continue;
        };
        if !tag_observed {
            transformed.push(item.clone());
            continue;
        }
        changed = true;
        let visible = visible_parts.concat();
        let pure_reasoning = !reasoning.is_empty() && visible.is_empty();
        let mut transformed_item = item.clone();
        if pure_reasoning {
            transformed_item = message_into_reasoning_item(transformed_item, &reasoning);
        } else {
            replace_output_item_texts(&mut transformed_item, &visible_parts);
        }
        transformed.push(transformed_item);
        if !pure_reasoning && !reasoning.is_empty() {
            appended_reasoning.push(reasoning_item_from_message(item, output_index, &reasoning));
        }
    }
    if !changed {
        return false;
    }
    transformed.extend(appended_reasoning);
    *output = transformed;
    let visible_text: String = output
        .iter()
        .filter_map(|item| item["content"].as_array())
        .flatten()
        .filter_map(|part| part["text"].as_str())
        .collect();
    if object.get("output_text").and_then(Value::as_str) == Some(original_text.as_str()) {
        object.insert("output_text".to_owned(), Value::String(visible_text));
    }
    true
}

fn project_output_item_texts(
    item: &Value,
    has_complete_tools: bool,
) -> Option<(Vec<String>, Vec<String>, bool)> {
    let fields = item.as_object()?;
    if fields.keys().any(|key| {
        !matches!(
            key.as_str(),
            "id" | "type" | "role" | "status" | "content" | "text"
        )
    }) {
        return None;
    }
    let item_type = item.get("type").and_then(Value::as_str)?;
    match item_type {
        "message" => {
            if let Some(content) = item.get("content").and_then(Value::as_array) {
                if item.get("role").is_some_and(|role| role != "assistant")
                    || content.iter().any(|part| {
                        part["type"] != "output_text"
                            || !part["text"].is_string()
                            || part.as_object().is_none_or(|fields| {
                                fields.keys().any(|key| {
                                    !matches!(
                                        key.as_str(),
                                        "type" | "text" | "annotations" | "logprobs"
                                    )
                                })
                            })
                            || ["annotations", "logprobs"].iter().any(|key| {
                                part.get(*key).is_some_and(|value| {
                                    value.as_array().is_none_or(|a| !a.is_empty())
                                })
                            })
                    })
                {
                    return None;
                }
                let texts = content
                    .iter()
                    .filter(|part| {
                        part.get("type").and_then(Value::as_str) == Some("output_text")
                            && part.get("text").is_some_and(Value::is_string)
                    })
                    .map(|part| part["text"].as_str().unwrap_or_default().to_string())
                    .collect::<Vec<_>>();
                if texts.is_empty() {
                    return None;
                }
                return Some(project_texts(&texts, has_complete_tools));
            }
            let text = item.get("text").and_then(Value::as_str)?;
            Some(project_texts(&[text.to_string()], has_complete_tools))
        }
        "output_text" => {
            let text = item.get("text").and_then(Value::as_str)?;
            Some(project_texts(&[text.to_string()], has_complete_tools))
        }
        _ => None,
    }
}

fn project_texts(texts: &[String], has_complete_tools: bool) -> (Vec<String>, Vec<String>, bool) {
    let mut visible_parts = Vec::with_capacity(texts.len());
    let mut reasoning = Vec::new();
    let mut tag_observed = false;
    for text in texts {
        let projection = project_v3_thinking_tag_text_with_tools(text, has_complete_tools);
        visible_parts.push(projection.visible);
        reasoning.extend(projection.reasoning);
        tag_observed |= projection.tag_observed;
    }
    (visible_parts, reasoning, tag_observed)
}

fn replace_output_item_texts(item: &mut Value, visible_parts: &[String]) {
    if let Some(content) = item.get_mut("content").and_then(Value::as_array_mut) {
        let mut text_index = 0usize;
        for part in content {
            if part.get("type").and_then(Value::as_str) != Some("output_text") {
                continue;
            }
            let Some(text) = part.get_mut("text") else {
                continue;
            };
            if let Some(value) = visible_parts.get(text_index) {
                *text = Value::String(value.clone());
            }
            text_index += 1;
        }
        return;
    }
    if let Some(text) = item.get_mut("text") {
        if let Some(value) = visible_parts.first() {
            *text = Value::String(value.clone());
        }
    }
}

fn message_into_reasoning_item(mut item: Value, reasoning: &[String]) -> Value {
    let object = item
        .as_object_mut()
        .expect("message output item must be an object");
    object.insert("type".to_owned(), Value::String("reasoning".to_owned()));
    object.remove("role");
    object.remove("content");
    object.remove("text");
    object.insert("summary".to_owned(), reasoning_summary_value(reasoning));
    item
}

fn reasoning_item_from_message(item: &Value, output_index: usize, reasoning: &[String]) -> Value {
    let item_id = item
        .get("id")
        .and_then(Value::as_str)
        .map(|id| format!("rs_compat_{id}"))
        .unwrap_or_else(|| format!("rs_compat_{output_index}"));
    let mut object = Map::new();
    object.insert("id".to_owned(), Value::String(item_id));
    object.insert("type".to_owned(), Value::String("reasoning".to_owned()));
    object.insert("status".to_owned(), Value::String("completed".to_owned()));
    object.insert("summary".to_owned(), reasoning_summary_value(reasoning));
    Value::Object(object)
}

fn reasoning_summary_value(reasoning: &[String]) -> Value {
    Value::Array(
        reasoning
            .iter()
            .map(|text| {
                serde_json::json!({
                    "type": "summary_text",
                    "text": text
                })
            })
            .collect(),
    )
}

pub(crate) fn output_item_has_complete_tool(item: &Value) -> bool {
    matches!(
        item.get("type").and_then(Value::as_str),
        Some(
            "function_call"
                | "custom_tool_call"
                | "tool_call"
                | "web_search_call"
                | "file_search_call"
                | "code_interpreter_call"
                | "computer_call"
                | "mcp_call"
                | "mcp_list_tools"
                | "mcp_approval_request"
                | "tool_search_call"
                | "apply_patch_call"
        )
    )
}

fn find_unprotected(
    text: &str,
    needle: &str,
    start: usize,
    protected: &[(usize, usize)],
) -> Option<usize> {
    let mut cursor = start;
    while cursor <= text.len() {
        let found = text[cursor..].find(needle).map(|offset| cursor + offset)?;
        if protected
            .iter()
            .all(|(start, end)| found < *start || found >= *end)
        {
            return Some(found);
        }
        cursor = found + needle.len();
    }
    None
}

fn protected_text_ranges(text: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    collect_delimited_ranges(text, "```", &mut ranges);
    collect_delimited_ranges(text, "~~~", &mut ranges);
    collect_inline_code_ranges(text, &mut ranges);
    collect_double_quoted_ranges(text, &mut ranges);
    ranges.sort_unstable();
    merge_ranges(ranges)
}

fn collect_delimited_ranges(text: &str, delimiter: &str, ranges: &mut Vec<(usize, usize)>) {
    let mut cursor = 0usize;
    while let Some(start_rel) = text[cursor..].find(delimiter) {
        let start = cursor + start_rel;
        let content_start = start + delimiter.len();
        let Some(end_rel) = text[content_start..].find(delimiter) else {
            return;
        };
        let end = content_start + end_rel + delimiter.len();
        ranges.push((start, end));
        cursor = end;
    }
}

fn collect_inline_code_ranges(text: &str, ranges: &mut Vec<(usize, usize)>) {
    let bytes = text.as_bytes();
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        if bytes[cursor] != b'`' {
            cursor += 1;
            continue;
        }
        let start = cursor;
        while cursor < bytes.len() && bytes[cursor] == b'`' {
            cursor += 1;
        }
        let delimiter_len = cursor - start;
        let delimiter = &text[start..cursor];
        let mut search = cursor;
        while let Some(end_rel) = text[search..].find(delimiter) {
            let end_start = search + end_rel;
            let end = end_start + delimiter_len;
            if end <= text.len() {
                ranges.push((start, end));
                cursor = end;
                break;
            }
            search = end_start + 1;
        }
    }
}

fn collect_double_quoted_ranges(text: &str, ranges: &mut Vec<(usize, usize)>) {
    let bytes = text.as_bytes();
    let mut cursor = 0usize;
    while cursor < bytes.len() {
        if bytes[cursor] != b'"' {
            cursor += 1;
            continue;
        }
        let start = cursor;
        cursor += 1;
        let mut escaped = false;
        while cursor < bytes.len() {
            let byte = bytes[cursor];
            if byte == b'"' && !escaped {
                ranges.push((start, cursor + 1));
                cursor += 1;
                break;
            }
            escaped = byte == b'\\' && !escaped;
            if byte != b'\\' {
                escaped = false;
            }
            cursor += 1;
        }
    }
}

fn merge_ranges(ranges: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in ranges {
        match merged.last_mut() {
            Some((_, current_end)) if start <= *current_end => {
                *current_end = (*current_end).max(end);
            }
            _ => merged.push((start, end)),
        }
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn complete_pair_is_harvested_without_trimming_body() {
        let projection = project_v3_thinking_tag_text("before <thinking> body </thinking> after");
        assert_eq!(projection.visible, "before  after");
        assert_eq!(projection.reasoning, vec![" body "]);
    }

    #[test]
    fn leading_unclosed_opener_is_reasoning_without_tools() {
        let projection = project_v3_thinking_tag_text("<thinking>body");
        assert_eq!(projection.visible, "");
        assert_eq!(projection.reasoning, vec!["body"]);
    }

    #[test]
    fn leading_unclosed_opener_stays_text_with_tools() {
        let projection = project_v3_thinking_tag_text_with_tools("<thinking>body", true);
        assert_eq!(projection.visible, "body");
        assert!(projection.reasoning.is_empty());
    }

    #[test]
    fn closing_only_removes_only_the_marker() {
        let projection = project_v3_thinking_tag_text("before </thinking> after");
        assert_eq!(projection.visible, "before  after");
        assert!(projection.reasoning.is_empty());
    }

    #[test]
    fn protected_and_malformed_examples_are_unchanged() {
        let text = "<thinkingNow I see";
        let projection = project_v3_thinking_tag_text(text);
        assert_eq!(projection.visible, text);
        assert!(!projection.tag_observed);
        let quoted = project_v3_thinking_tag_text("\"<thinking>quoted</thinking>\"");
        assert_eq!(quoted.visible, "\"<thinking>quoted</thinking>\"");
        assert!(!quoted.tag_observed);
    }

    #[test]
    fn json_normalizer_preserves_unrelated_items() {
        let mut response = json!({
            "output": [
                {"type":"function_call","call_id":"c1","name":"exec_command","arguments":{"n":1}},
                {"type":"message","id":"m1","content":[{"type":"output_text","text":"<thinking>x"}]}
            ]
        });
        assert!(normalize_v3_direct_thinking_json(&mut response));
        assert_eq!(response["output"][0]["arguments"]["n"], 1);
        assert_eq!(response["output"][1]["content"][0]["text"], "x");
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct V3ThinkingTagTextProjection {
    pub(crate) visible: String,
    pub(crate) reasoning: Vec<String>,
    pub(crate) tag_observed: bool,
}

pub(crate) fn project_v3_thinking_tag_text(text: &str) -> V3ThinkingTagTextProjection {
    const OPEN: &str = "<thinking>";
    const CLOSE: &str = "</thinking>";
    let mut projection = V3ThinkingTagTextProjection::default();
    let mut remaining = text;
    while let Some(open_at) = remaining.find(OPEN) {
        projection.tag_observed = true;
        projection.visible.push_str(&remaining[..open_at]);
        let after_open = &remaining[open_at + OPEN.len()..];
        if let Some(close_at) = after_open.find(CLOSE) {
            let reasoning = &after_open[..close_at];
            if !reasoning.is_empty() {
                projection.reasoning.push(reasoning.to_string());
            }
            remaining = &after_open[close_at + CLOSE.len()..];
        } else {
            projection.visible.push_str(after_open);
            remaining = "";
            break;
        }
    }
    if !remaining.is_empty() {
        if remaining.contains(CLOSE) {
            projection.tag_observed = true;
            projection.visible.push_str(&remaining.replace(CLOSE, ""));
        } else {
            projection.visible.push_str(remaining);
        }
    }
    projection
}

pub(crate) fn apply_v3_direct_thinking_tag_json_compat(payload: &mut serde_json::Value) -> bool {
    let output = if payload.get("output").is_some() {
        payload
            .get_mut("output")
            .and_then(serde_json::Value::as_array_mut)
    } else {
        payload
            .pointer_mut("/response/output")
            .and_then(serde_json::Value::as_array_mut)
    };
    let Some(output) = output else {
        return false;
    };
    let mut appended_reasoning = Vec::new();
    let mut changed = false;
    for item in output.iter_mut() {
        if item.get("type").and_then(serde_json::Value::as_str) != Some("message") {
            continue;
        }
        let Some(content) = item
            .get_mut("content")
            .and_then(serde_json::Value::as_array_mut)
        else {
            continue;
        };
        let mut summaries = Vec::new();
        for part in content.iter_mut() {
            if part.get("type").and_then(serde_json::Value::as_str) != Some("output_text") {
                continue;
            }
            let Some(text) = part
                .get("text")
                .and_then(serde_json::Value::as_str)
                .map(ToOwned::to_owned)
            else {
                continue;
            };
            let projection = project_v3_thinking_tag_text(&text);
            if !projection.tag_observed {
                continue;
            }
            changed = true;
            part["text"] = serde_json::Value::String(projection.visible);
            summaries.extend(projection.reasoning);
        }
        if summaries.is_empty() {
            continue;
        }
        let summary = summaries
            .into_iter()
            .map(|text| serde_json::json!({"type":"summary_text","text":text}))
            .collect::<Vec<_>>();
        let visible_empty = content.iter().all(|part| {
            part.get("type").and_then(serde_json::Value::as_str) != Some("output_text")
                || part
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .is_none_or(str::is_empty)
        });
        if visible_empty {
            let id = item.get("id").cloned().unwrap_or(serde_json::Value::Null);
            let status = item
                .get("status")
                .cloned()
                .unwrap_or_else(|| serde_json::Value::String("completed".to_string()));
            *item = serde_json::json!({
                "id": id,
                "type": "reasoning",
                "status": status,
                "summary": summary
            });
        } else {
            let source_id = item
                .get("id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("message");
            appended_reasoning.push(serde_json::json!({
                "id": format!("rs_compat_{source_id}"),
                "type": "reasoning",
                "status": "completed",
                "summary": summary
            }));
        }
    }
    output.extend(appended_reasoning);
    changed
}

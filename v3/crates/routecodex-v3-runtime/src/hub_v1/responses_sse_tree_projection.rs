use super::*;

pub fn rewrite_v3_responses_sse_content(
    mut item: V3ResponsesSseOutputItem,
    rewrite: V3ResponsesSseContentRewrite,
) -> Result<V3ResponsesSseOutputItem, V3ResponsesSseTreeError> {
    let compatible = match (&rewrite, item.kind) {
        (V3ResponsesSseContentRewrite::Text(_), V3ResponsesSseOutputItemKind::OutputText)
        | (V3ResponsesSseContentRewrite::Text(_), V3ResponsesSseOutputItemKind::Message)
        | (V3ResponsesSseContentRewrite::Refusal(_), V3ResponsesSseOutputItemKind::Message)
        | (V3ResponsesSseContentRewrite::Reasoning(_), V3ResponsesSseOutputItemKind::Reasoning)
        | (
            V3ResponsesSseContentRewrite::FunctionArguments(_),
            V3ResponsesSseOutputItemKind::FunctionCall,
        )
        | (
            V3ResponsesSseContentRewrite::CustomToolInput(_),
            V3ResponsesSseOutputItemKind::CustomToolCall,
        ) => true,
        _ => false,
    };
    if !compatible {
        let content = match rewrite {
            V3ResponsesSseContentRewrite::Text(_) | V3ResponsesSseContentRewrite::Refusal(_) => {
                "message"
            }
            V3ResponsesSseContentRewrite::Reasoning(_) => "reasoning",
            V3ResponsesSseContentRewrite::FunctionArguments(_) => "function_call",
            V3ResponsesSseContentRewrite::CustomToolInput(_) => "custom_tool_call",
        };
        return Err(V3ResponsesSseTreeError::IncompatibleContentRewrite {
            content: content.to_owned(),
            item_type: item.kind.to_string(),
        });
    }
    item.rewritten_content = Some(match rewrite {
        V3ResponsesSseContentRewrite::Text(value)
        | V3ResponsesSseContentRewrite::Refusal(value)
        | V3ResponsesSseContentRewrite::Reasoning(value)
        | V3ResponsesSseContentRewrite::FunctionArguments(value)
        | V3ResponsesSseContentRewrite::CustomToolInput(value) => value,
    });
    Ok(item)
}

pub fn project_v3_responses_sse_item_json(item: &V3ResponsesSseOutputItem) -> Value {
    item.to_normalized_value()
}

pub fn project_v3_responses_sse_item_sse(
    event_name: Option<String>,
    item: &V3ResponsesSseOutputItem,
) -> Result<Vec<u8>, V3ResponsesSseTreeError> {
    let data_json = serde_json::to_string(&project_v3_responses_sse_item_json(item))
        .map_err(|error| V3ResponsesSseTreeError::Projection(error.to_string()))?;
    crate::sse_object_pipeline::SseObjectFrame::from_event_json(event_name, data_json)
        .and_then(|object| object.encode_sse())
        .map_err(|error| V3ResponsesSseTreeError::Projection(error.to_string()))
}

pub fn project_v3_responses_sse_event_json(semantic: &V3ResponsesSseSemanticObject) -> Value {
    let mut value = semantic.to_normalized_value();
    let terminal = matches!(
        value.get("type").and_then(Value::as_str),
        Some("response.completed" | "response.incomplete")
    );
    if terminal {
        if let Some(usage) = value
            .pointer_mut("/response/usage")
            .and_then(Value::as_object_mut)
        {
            // Codex's ResponsesCompleted decoder treats usage as a complete
            // record. Providers may omit total_tokens; derive only the
            // protocol-required aggregate from the values already present.
            let input = usage
                .get("input_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            let output = usage
                .get("output_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(0);
            usage.entry("input_tokens").or_insert(Value::from(input));
            usage.entry("output_tokens").or_insert(Value::from(output));
            usage
                .entry("total_tokens")
                .or_insert(Value::from(input.saturating_add(output)));
        }
    }
    value
}

pub fn project_v3_responses_sse_event_sse(
    event_name: Option<String>,
    semantic: &V3ResponsesSseSemanticObject,
) -> Result<Vec<u8>, V3ResponsesSseTreeError> {
    let data_json = serde_json::to_string(&project_v3_responses_sse_event_json(semantic))
        .map_err(|error| V3ResponsesSseTreeError::Projection(error.to_string()))?;
    crate::sse_object_pipeline::SseObjectFrame::from_event_json(event_name, data_json)
        .and_then(|object| object.encode_sse())
        .map_err(|error| V3ResponsesSseTreeError::Projection(error.to_string()))
}

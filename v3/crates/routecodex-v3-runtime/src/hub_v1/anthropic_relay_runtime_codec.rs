use super::V3AnthropicCodecError;
use futures_util::StreamExt;
use routecodex_v3_sse::{
    build_v3_sse_transport_in_01_raw_chunk, SseField, SseIncrementalDecoder, SseTransportLimits,
};
use serde_json::{json, Value};

pub fn project_v3_responses_json_as_anthropic_message(
    response: &Value,
) -> Result<Value, V3AnthropicCodecError> {
    let object = response
        .as_object()
        .ok_or(V3AnthropicCodecError::PayloadNotObject)?;
    let output = object
        .get("output")
        .and_then(Value::as_array)
        .ok_or(V3AnthropicCodecError::ContentNotArray)?;
    let mut content = Vec::new();
    let mut has_tool = false;
    for item in output {
        match item.get("type").and_then(Value::as_str) {
            Some("reasoning") => {
                if let Some(text) = item
                    .get("summary")
                    .and_then(Value::as_array)
                    .and_then(|summary| summary.first())
                    .and_then(|entry| entry.get("text"))
                    .and_then(Value::as_str)
                {
                    content.push(json!({"type":"thinking","thinking":text}));
                }
            }
            Some("function_call") => {
                has_tool = true;
                let input = item
                    .get("arguments")
                    .and_then(Value::as_str)
                    .and_then(|arguments| serde_json::from_str(arguments).ok())
                    .unwrap_or_else(|| json!({}));
                content.push(json!({
                    "type":"tool_use",
                    "id":item.get("call_id").cloned().unwrap_or(Value::Null),
                    "name":item.get("name").cloned().unwrap_or(Value::Null),
                    "input":input
                }));
            }
            Some("output_text") => {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    content.push(json!({"type":"text","text":text}));
                }
            }
            Some("message") => {
                if let Some(parts) = item.get("content").and_then(Value::as_array) {
                    for part in parts {
                        if part.get("type").and_then(Value::as_str) == Some("output_text") {
                            if let Some(text) = part.get("text").and_then(Value::as_str) {
                                content.push(json!({"type":"text","text":text}));
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    let response_id = object
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("response");
    let message_id = response_id.replacen("resp_", "msg_", 1);
    Ok(json!({
        "id":message_id,
        "type":"message",
        "role":"assistant",
        "stop_reason":if has_tool { "tool_use" } else { "end_turn" },
        "content":content
    }))
}

pub fn project_v3_responses_error_as_anthropic_error(body: &[u8]) -> Value {
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(mut object)) if object.contains_key("error") => {
            object.insert("type".to_string(), Value::String("error".to_string()));
            Value::Object(object)
        }
        _ => {
            json!({"type":"error","error":{"type":"provider_error","message":"provider returned an unreadable error body"}})
        }
    }
}

pub struct V3AnthropicRelaySseProjection {
    pub canonical_response: Value,
    pub(crate) client_events: Vec<Value>,
}

impl V3AnthropicRelaySseProjection {
    pub fn into_parts(self) -> (Value, Vec<Value>) {
        (self.canonical_response, self.client_events)
    }

    pub fn project_after_resp04(client_events: Vec<Value>) -> Value {
        json!({"events":client_events})
    }
}

pub async fn project_v3_responses_sse_as_anthropic_events(
    mut stream: routecodex_v3_provider_responses::V3ProviderSseStream,
) -> Result<V3AnthropicRelaySseProjection, String> {
    let mut events = Vec::new();
    let mut next_index = 0_u64;
    let mut active_tool_index = None;
    let mut active_text_index = None;
    let mut reasoning = String::new();
    let mut text = String::new();
    let mut tool_call: Option<(Value, Value, String)> = None;
    let mut response_id = Value::Null;
    let mut response_status = Value::String("in_progress".to_string());
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| error.to_string())?;
        let frames = decoder
            .push(build_v3_sse_transport_in_01_raw_chunk(&chunk))
            .map_err(|error| error.to_string())?;
        for frame in frames {
            let (event, data) = response_sse_fields(frame.frame().fields())?;
            match event.as_str() {
                "[DONE]" => {}
                "response.created" | "response.in_progress" => {
                    if response_id.is_null() {
                        response_id = data.pointer("/response/id").cloned().unwrap_or(Value::Null);
                    }
                    if let Some(status) = data.pointer("/response/status") {
                        response_status = status.clone();
                    }
                }
                "response.reasoning_summary_text.delta" => {
                    let index = next_index;
                    if !events.iter().any(|item: &Value| {
                        item.get("event").and_then(Value::as_str) == Some("content_block_start")
                            && item.pointer("/data/index").and_then(Value::as_u64) == Some(index)
                    }) {
                        events.push(json!({"event":"content_block_start","data":{"type":"content_block_start","index":index,"content_block":{"type":"thinking","thinking":""}}}));
                    }
                    events.push(json!({"event":"content_block_delta","data":{"type":"content_block_delta","index":index,"delta":{"type":"thinking_delta","thinking":data.get("delta").cloned().unwrap_or(Value::Null)}}}));
                    if let Some(delta) = data.get("delta").and_then(Value::as_str) {
                        reasoning.push_str(delta);
                    }
                    next_index = index + 1;
                }
                "response.output_item.added" => {
                    let item = data.get("item").cloned().unwrap_or(Value::Null);
                    if item.get("type").and_then(Value::as_str) == Some("function_call") {
                        let index = next_index;
                        active_tool_index = Some(index);
                        tool_call = Some((
                            item.get("call_id").cloned().unwrap_or(Value::Null),
                            item.get("name").cloned().unwrap_or(Value::Null),
                            String::new(),
                        ));
                        events.push(json!({"event":"content_block_start","data":{"type":"content_block_start","index":index,"content_block":{"type":"tool_use","id":item.get("call_id").cloned().unwrap_or(Value::Null),"name":item.get("name").cloned().unwrap_or(Value::Null),"input":{}}}}));
                        next_index = index + 1;
                    }
                }
                "response.content_part.added" => {
                    let part = data.get("part").cloned().unwrap_or(Value::Null);
                    if part.get("type").and_then(Value::as_str) == Some("output_text") {
                        let index = ensure_text_content_block(
                            &mut events,
                            &mut active_text_index,
                            &mut next_index,
                        );
                        if let Some(initial_text) = part.get("text").and_then(Value::as_str) {
                            if !initial_text.is_empty() {
                                text.push_str(initial_text);
                                events.push(json!({"event":"content_block_delta","data":{"type":"content_block_delta","index":index,"delta":{"type":"text_delta","text":initial_text}}}));
                            }
                        }
                    }
                }
                "response.output_text.delta" => {
                    let index = ensure_text_content_block(
                        &mut events,
                        &mut active_text_index,
                        &mut next_index,
                    );
                    if let Some(delta) = data.get("delta").and_then(Value::as_str) {
                        text.push_str(delta);
                        events.push(json!({"event":"content_block_delta","data":{"type":"content_block_delta","index":index,"delta":{"type":"text_delta","text":delta}}}));
                    }
                }
                "response.output_text.done" => {
                    if let Some(done_text) = data.get("text").and_then(Value::as_str) {
                        if text.is_empty() && !done_text.is_empty() {
                            let index = ensure_text_content_block(
                                &mut events,
                                &mut active_text_index,
                                &mut next_index,
                            );
                            text.push_str(done_text);
                            events.push(json!({"event":"content_block_delta","data":{"type":"content_block_delta","index":index,"delta":{"type":"text_delta","text":done_text}}}));
                        } else if !done_text.is_empty() && done_text != text {
                            return Err(
                                "response.output_text.done text does not match accumulated deltas"
                                    .to_string(),
                            );
                        }
                    }
                }
                "response.function_call_arguments.delta" => {
                    let index = active_tool_index
                        .ok_or("function arguments arrived before function call")?;
                    events.push(json!({"event":"content_block_delta","data":{"type":"content_block_delta","index":index,"delta":{"type":"input_json_delta","partial_json":data.get("delta").cloned().unwrap_or(Value::Null)}}}));
                    if let (Some((_, _, arguments)), Some(delta)) = (
                        tool_call.as_mut(),
                        data.get("delta").and_then(Value::as_str),
                    ) {
                        arguments.push_str(delta);
                    }
                }
                "response.output_item.done" | "response.content_part.done" => {}
                "response.completed" => {
                    response_id = data.pointer("/response/id").cloned().unwrap_or(Value::Null);
                    response_status = data
                        .pointer("/response/status")
                        .cloned()
                        .unwrap_or_else(|| Value::String("completed".to_string()));
                    events.push(json!({"event":"message_stop","data":{"type":"message_stop"}}));
                }
                _ => return Err(format!("unsupported Responses SSE event: {event}")),
            }
        }
    }
    decoder.finish().map_err(|error| error.to_string())?;
    let mut output = Vec::new();
    if !text.is_empty() {
        output.push(json!({"type":"output_text","text":text}));
    }
    if !reasoning.is_empty() {
        output
            .push(json!({"type":"reasoning","summary":[{"type":"summary_text","text":reasoning}]}));
    }
    if let Some((call_id, name, arguments)) = tool_call {
        output.push(
            json!({"type":"function_call","call_id":call_id,"name":name,"arguments":arguments}),
        );
    }
    Ok(V3AnthropicRelaySseProjection {
        canonical_response: json!({"id":response_id,"status":response_status,"output":output}),
        client_events: events,
    })
}

fn response_sse_fields(fields: &[SseField]) -> Result<(String, Value), String> {
    let mut event = None;
    let mut data_lines = Vec::new();
    for field in fields {
        if let SseField::Named { name, value } = field {
            match name.as_str() {
                "event" => event = Some(value.clone()),
                "data" => data_lines.push(value.as_str()),
                _ => {}
            }
        }
    }
    let data_text = data_lines.join("\n");
    if data_text == "[DONE]" {
        return Ok((event.unwrap_or_else(|| "[DONE]".to_string()), Value::Null));
    }
    let data: Value = serde_json::from_str(&data_text).map_err(|error| error.to_string())?;
    let event = match event {
        Some(event) => event,
        None => data
            .get("type")
            .and_then(Value::as_str)
            .ok_or("SSE frame has no event field")?
            .to_string(),
    };
    Ok((event, data))
}

fn ensure_text_content_block(
    events: &mut Vec<Value>,
    active_text_index: &mut Option<u64>,
    next_index: &mut u64,
) -> u64 {
    if let Some(index) = *active_text_index {
        return index;
    }
    let index = *next_index;
    events.push(json!({"event":"content_block_start","data":{"type":"content_block_start","index":index,"content_block":{"type":"text","text":""}}}));
    *active_text_index = Some(index);
    *next_index = index + 1;
    index
}

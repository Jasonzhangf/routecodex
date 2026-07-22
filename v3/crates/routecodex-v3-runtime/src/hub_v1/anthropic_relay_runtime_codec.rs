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
                if let Some(summary) = item.get("summary").and_then(Value::as_array) {
                    for entry in summary {
                        if let Some(text) = entry.get("text").and_then(Value::as_str) {
                            content.push(json!({"type":"thinking","thinking":text}));
                        }
                    }
                }
            }
            Some("function_call") => {
                has_tool = true;
                let input = parse_responses_function_call_arguments(item)?;
                content.push(json!({
                    "type":"tool_use",
                    "id":item.get("call_id").cloned().unwrap_or(Value::Null),
                    "name":item.get("name").cloned().unwrap_or(Value::Null),
                    "input":input
                }));
            }
            Some("custom_tool_call") => {
                has_tool = true;
                content.push(json!({
                    "type":"tool_use",
                    "id":item.get("call_id").or_else(|| item.get("id")).cloned().unwrap_or(Value::Null),
                    "name":item.get("name").cloned().unwrap_or(Value::Null),
                    "input":responses_custom_tool_call_input(item)?
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
    let mut message = json!({
        "id":message_id,
        "type":"message",
        "role":"assistant",
        "stop_reason":responses_stop_reason_as_anthropic_stop_reason(object, has_tool),
        "content":content
    });
    if let Some(model) = object.get("model") {
        message["model"] = model.clone();
    }
    if let Some(usage) = object.get("usage") {
        message["usage"] = usage.clone();
    }
    Ok(message)
}

pub fn project_v3_responses_json_as_anthropic_events(
    response: &Value,
) -> Result<Vec<Value>, V3AnthropicCodecError> {
    let message = project_v3_responses_json_as_anthropic_message(response)?;
    project_v3_anthropic_message_as_sse_events(&message)
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

fn project_v3_anthropic_message_as_sse_events(
    message: &Value,
) -> Result<Vec<Value>, V3AnthropicCodecError> {
    let object = message
        .as_object()
        .ok_or(V3AnthropicCodecError::PayloadNotObject)?;
    let content = object
        .get("content")
        .and_then(Value::as_array)
        .ok_or(V3AnthropicCodecError::ContentNotArray)?;
    let mut message_start = json!({
        "id": object.get("id").cloned().unwrap_or(Value::String("msg_anthropic_relay".to_string())),
        "type": object.get("type").cloned().unwrap_or(Value::String("message".to_string())),
        "role": object.get("role").cloned().unwrap_or(Value::String("assistant".to_string())),
        "content": []
    });
    if let Some(model) = object.get("model") {
        message_start["model"] = model.clone();
    }
    if let Some(usage) = object.get("usage") {
        message_start["usage"] = usage.clone();
    }
    let mut events = vec![json!({
        "event":"message_start",
        "data":{"type":"message_start","message":message_start}
    })];
    for (index, part) in content.iter().enumerate() {
        match part.get("type").and_then(Value::as_str) {
            Some("text") => {
                let text = part.get("text").and_then(Value::as_str).unwrap_or("");
                events.push(json!({
                    "event":"content_block_start",
                    "data":{"type":"content_block_start","index":index,"content_block":{"type":"text","text":""}}
                }));
                if !text.is_empty() {
                    events.push(json!({
                        "event":"content_block_delta",
                        "data":{"type":"content_block_delta","index":index,"delta":{"type":"text_delta","text":text}}
                    }));
                }
                events.push(json!({
                    "event":"content_block_stop",
                    "data":{"type":"content_block_stop","index":index}
                }));
            }
            Some("thinking" | "reasoning") => {
                let thinking = part
                    .get("thinking")
                    .or_else(|| part.get("text"))
                    .or_else(|| part.get("reasoning"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                events.push(json!({
                    "event":"content_block_start",
                    "data":{"type":"content_block_start","index":index,"content_block":{"type":"thinking","thinking":""}}
                }));
                if !thinking.is_empty() {
                    events.push(json!({
                        "event":"content_block_delta",
                        "data":{"type":"content_block_delta","index":index,"delta":{"type":"thinking_delta","thinking":thinking}}
                    }));
                }
                events.push(json!({
                    "event":"content_block_stop",
                    "data":{"type":"content_block_stop","index":index}
                }));
            }
            Some("redacted_thinking") => {
                let data = part
                    .get("data")
                    .or_else(|| part.get("signature"))
                    .cloned()
                    .ok_or(V3AnthropicCodecError::MalformedField {
                        field: "redacted_thinking data",
                    })?;
                events.push(json!({
                    "event":"content_block_start",
                    "data":{"type":"content_block_start","index":index,"content_block":{"type":"redacted_thinking","data":data}}
                }));
                events.push(json!({
                    "event":"content_block_stop",
                    "data":{"type":"content_block_stop","index":index}
                }));
            }
            Some("tool_use") => {
                let id = part
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or(V3AnthropicCodecError::MalformedField {
                        field: "tool_use id",
                    })?;
                let name = part
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or(V3AnthropicCodecError::MalformedField {
                        field: "tool_use name",
                    })?;
                let input = part.get("input").cloned().unwrap_or_else(|| json!({}));
                if !input.is_object() {
                    return Err(V3AnthropicCodecError::MalformedField {
                        field: "tool_use input",
                    });
                }
                events.push(json!({
                    "event":"content_block_start",
                    "data":{"type":"content_block_start","index":index,"content_block":{"type":"tool_use","id":id,"name":name,"input":input}}
                }));
                events.push(json!({
                    "event":"content_block_stop",
                    "data":{"type":"content_block_stop","index":index}
                }));
            }
            Some(_) | None => {
                return Err(V3AnthropicCodecError::MalformedField {
                    field: "content type",
                })
            }
        }
    }
    events.push(json!({
        "event":"message_delta",
        "data":{
            "type":"message_delta",
            "delta":{
                "stop_reason": object.get("stop_reason").cloned().unwrap_or(Value::String("end_turn".to_string())),
                "stop_sequence": object.get("stop_sequence").cloned().unwrap_or(Value::Null)
            },
            "usage": object.get("usage").cloned().unwrap_or(Value::Object(serde_json::Map::new()))
        }
    }));
    events.push(json!({
        "event":"message_stop",
        "data":{"type":"message_stop"}
    }));
    Ok(events)
}

fn parse_responses_function_call_arguments(item: &Value) -> Result<Value, V3AnthropicCodecError> {
    let arguments = item
        .get("arguments")
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "function_call arguments",
        })?;
    match arguments {
        Value::String(raw) => {
            serde_json::from_str(raw).map_err(|_| V3AnthropicCodecError::MalformedField {
                field: "function_call arguments",
            })
        }
        Value::Object(_) => Ok(arguments.clone()),
        _ => Err(V3AnthropicCodecError::MalformedField {
            field: "function_call arguments",
        }),
    }
}

fn responses_custom_tool_call_input(item: &Value) -> Result<Value, V3AnthropicCodecError> {
    match item.get("input") {
        Some(Value::Object(_)) => Ok(item.get("input").cloned().unwrap_or(Value::Null)),
        Some(Value::String(raw)) => Ok(json!({"input":raw})),
        Some(other) => Ok(json!({"input":other})),
        None => Err(V3AnthropicCodecError::MalformedField {
            field: "custom_tool_call input",
        }),
    }
}

fn responses_stop_reason_as_anthropic_stop_reason(
    object: &serde_json::Map<String, Value>,
    has_tool: bool,
) -> &'static str {
    if has_tool {
        return "tool_use";
    }
    match object.get("finish_reason").and_then(Value::as_str) {
        Some("max_tokens" | "length") => "max_tokens",
        Some("stop_sequence") => "stop_sequence",
        Some("tool_calls" | "requires_action") => "tool_use",
        Some("stop" | "end_turn") => "end_turn",
        _ => match object.get("status").and_then(Value::as_str) {
            Some("incomplete") => "max_tokens",
            _ => "end_turn",
        },
    }
}

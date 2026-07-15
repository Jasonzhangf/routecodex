use super::V3AnthropicCodecError;
use futures_util::StreamExt;
use serde_json::{json, Map, Value};
use sse_transport_core::{
    build_sse_transport_in_01_raw_chunk, SseField, SseIncrementalDecoder, SseTransportLimits,
};

pub fn encode_v3_anthropic_request_as_responses_semantic(
    input: Value,
) -> Result<Value, V3AnthropicCodecError> {
    let transport_intent = match input.get("stream").and_then(Value::as_bool) {
        Some(true) => super::V3HubTransportIntent::Sse,
        _ => super::V3HubTransportIntent::Json,
    };
    let input = super::characterize_v3_anthropic_client_input_to_hub_semantic(
        input,
        super::V3HubEntryProtocol::Anthropic,
        transport_intent,
    )?
    .into_payload();
    let object = input
        .as_object()
        .ok_or(V3AnthropicCodecError::PayloadNotObject)?;
    let mut output = Map::new();
    output.insert(
        "model".to_string(),
        object.get("model").cloned().unwrap_or(Value::Null),
    );
    output.insert(
        "input".to_string(),
        Value::Array(encode_messages(
            object
                .get("messages")
                .and_then(Value::as_array)
                .ok_or(V3AnthropicCodecError::MessagesNotArray)?,
        )),
    );
    if let Some(tools) = object.get("tools").and_then(Value::as_array) {
        output.insert(
            "tools".to_string(),
            Value::Array(
                tools
                    .iter()
                    .filter_map(Value::as_object)
                    .map(|tool| {
                        json!({
                            "type": "function",
                            "name": tool.get("name").cloned().unwrap_or(Value::Null),
                            "parameters": tool.get("input_schema").cloned().unwrap_or_else(|| json!({"type":"object"}))
                        })
                    })
                    .collect(),
            ),
        );
    }
    if object.get("thinking").is_some() {
        output.insert("reasoning".to_string(), json!({"effort":"medium"}));
    }
    output.insert(
        "stream".to_string(),
        Value::Bool(
            object
                .get("stream")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
    );
    Ok(Value::Object(output))
}

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
    let mut reasoning = String::new();
    let mut tool_call: Option<(Value, Value, String)> = None;
    let mut response_id = Value::Null;
    let mut response_status = Value::String("in_progress".to_string());
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| error.to_string())?;
        let frames = decoder
            .push(build_sse_transport_in_01_raw_chunk(&chunk))
            .map_err(|error| error.to_string())?;
        for frame in frames {
            let (event, data) = response_sse_fields(frame.frame().fields())?;
            match event.as_str() {
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
    let event = event.ok_or("SSE frame has no event field")?;
    let data = serde_json::from_str(&data_lines.join("\n")).map_err(|error| error.to_string())?;
    Ok((event, data))
}

fn encode_messages(messages: &[Value]) -> Vec<Value> {
    let mut encoded = Vec::new();
    for message in messages {
        let role = message.get("role").cloned().unwrap_or(Value::Null);
        let mut content = match message.get("content") {
                Some(Value::String(text)) => vec![json!({"type":"input_text","text":text})],
                Some(Value::Array(parts)) => parts
                    .iter()
                    .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                    .map(|part| {
                        json!({"type":"input_text","text":part.get("text").cloned().unwrap_or(Value::Null)})
                    })
                    .collect(),
                _ => Vec::new(),
            };
        if !content.is_empty() {
            encoded.push(json!({"role":role,"content":std::mem::take(&mut content)}));
        }
        if let Some(parts) = message.get("content").and_then(Value::as_array) {
            for part in parts {
                match part.get("type").and_then(Value::as_str) {
                        Some("tool_use") => encoded.push(json!({
                            "type":"function_call",
                            "call_id":part.get("id").cloned().unwrap_or(Value::Null),
                            "name":part.get("name").cloned().unwrap_or(Value::Null),
                            "arguments":serde_json::to_string(part.get("input").unwrap_or(&Value::Null)).unwrap_or_else(|_| "null".to_string())
                        })),
                        Some("tool_result") => encoded.push(json!({
                            "type":"function_call_output",
                            "call_id":part.get("tool_use_id").cloned().unwrap_or(Value::Null),
                            "output":anthropic_tool_result_output(part.get("content"))
                        })),
                        _ => {}
                    }
            }
        }
    }
    encoded
}

fn anthropic_tool_result_output(content: Option<&Value>) -> Value {
    match content {
        Some(Value::String(text)) => Value::String(text.clone()),
        Some(value) => {
            Value::String(serde_json::to_string(value).unwrap_or_else(|_| "null".into()))
        }
        None => Value::String(String::new()),
    }
}

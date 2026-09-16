use super::{
    project_v3_responses_reasoning_item_as_anthropic_content, V3AnthropicCodecError,
    V3HubProviderWireProtocol, V3HubTransportIntent,
};
use crate::protocol_tables::{map_value as table_map_value, V3TableDirection, V3TableKind};
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
                content.push(project_v3_responses_reasoning_item_as_anthropic_content(
                    item,
                )?);
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

/// Dispatch the client projection by the selected provider wire protocol.
///
/// The Anthropic entry serves any routed provider: `anthropic` and `responses`
/// providers carry the canonical Responses-shaped semantic payload (projected
/// via `project_v3_responses_json_as_anthropic_message`), while `openai_chat`
/// providers carry the raw `chat.completion` composite shape and need their own
/// Anthropic message projection. Non-OpenAiChat behavior is unchanged.
pub fn project_v3_anthropic_client_response_for_provider(
    semantic: &Value,
    provider_protocol: V3HubProviderWireProtocol,
    transport_intent: V3HubTransportIntent,
) -> Result<Value, V3AnthropicCodecError> {
    let message = if provider_protocol == V3HubProviderWireProtocol::OpenAiChat {
        project_v3_openai_chat_completion_as_anthropic_message(semantic)?
    } else {
        project_v3_responses_json_as_anthropic_message(semantic)?
    };
    match transport_intent {
        V3HubTransportIntent::Sse => {
            let client_events = project_v3_anthropic_message_as_sse_events(&message)?;
            Ok(project_v3_anthropic_client_events(client_events))
        }
        V3HubTransportIntent::Json => Ok(message),
    }
}

/// Project an OpenAI Chat `chat.completion` composite (JSON response or
/// materialized SSE) into an Anthropic client message.
pub fn project_v3_openai_chat_completion_as_anthropic_message(
    response: &Value,
) -> Result<Value, V3AnthropicCodecError> {
    let object = response
        .as_object()
        .ok_or(V3AnthropicCodecError::PayloadNotObject)?;
    let choices = object
        .get("choices")
        .and_then(Value::as_array)
        .ok_or(V3AnthropicCodecError::ContentNotArray)?;
    let choice = choices.first().cloned().unwrap_or_default();
    let message = choice.get("message").cloned().unwrap_or_default();
    let mut content = Vec::new();
    if let Some(thinking) = message
        .get("reasoning_content")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        content.push(json!({"type":"thinking","thinking":thinking}));
    }
    if let Some(text) = message
        .get("content")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        content.push(json!({"type":"text","text":text}));
    } else if let Some(refusal) = message
        .get("refusal")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        content.push(json!({"type":"text","text":refusal}));
    }
    let tool_calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .map(|calls| calls.to_vec())
        .unwrap_or_default();
    for tool_call in &tool_calls {
        let function = tool_call.get("function").cloned().unwrap_or_default();
        let arguments = function
            .get("arguments")
            .and_then(Value::as_str)
            .unwrap_or("{}");
        let input = serde_json::from_str::<Value>(arguments)
            .ok()
            .unwrap_or_else(|| json!({}));
        content.push(json!({
            "type":"tool_use",
            "id":tool_call.get("id").cloned().unwrap_or(Value::Null),
            "name":function.get("name").cloned().unwrap_or(Value::Null),
            "input":input
        }));
    }
    let response_id = object.get("id").and_then(Value::as_str).unwrap_or("record");
    let message_id = if let Some(id) = response_id.strip_prefix("chatcmpl-") {
        format!("msg_{id}")
    } else {
        format!("msg_{response_id}")
    };
    let mut message = json!({
        "id":message_id,
        "type":"message",
        "role":"assistant",
        "stop_reason":openai_chat_stop_reason_as_anthropic_stop_reason(&choice, &tool_calls),
        "content":content
    });
    if let Some(model) = object.get("model") {
        message["model"] = model.clone();
    }
    if let Some(usage) = object.get("usage").and_then(Value::as_object) {
        message["usage"] = json!({
            "input_tokens":usage.get("prompt_tokens").cloned().unwrap_or(Value::Null),
            "output_tokens":usage.get("completion_tokens").cloned().unwrap_or(Value::Null)
        });
    } else if let Some(usage) = object.get("usage") {
        message["usage"] = usage.clone();
    }
    Ok(message)
}

fn openai_chat_stop_reason_as_anthropic_stop_reason(choice: &Value, tool_calls: &[Value]) -> Value {
    if !tool_calls.is_empty() {
        return Value::String("tool_use".to_string());
    }
    let stop_reason = Value::String(match choice.get("finish_reason").and_then(Value::as_str) {
        Some("length" | "max_tokens") => "max_tokens".to_string(),
        _ => "end_turn".to_string(),
    });
    stop_reason
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

pub fn project_v3_anthropic_client_events(client_events: Vec<Value>) -> Value {
    json!({"events":client_events})
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
            Some("thinking") => {
                let thinking = part
                    .get("thinking")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or(V3AnthropicCodecError::MalformedField {
                        field: "reasoning content",
                    })?;
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
                if let Some(signature) = optional_anthropic_reasoning_string(part, "signature")? {
                    events.push(json!({
                        "event":"content_block_delta",
                        "data":{"type":"content_block_delta","index":index,"delta":{"type":"signature_delta","signature":signature}}
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
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or(V3AnthropicCodecError::MalformedField {
                        field: "reasoning content",
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
                let input =
                    part.get("input")
                        .cloned()
                        .ok_or(V3AnthropicCodecError::MalformedField {
                            field: "tool_use input",
                        })?;
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

fn optional_anthropic_reasoning_string<'a>(
    part: &'a Value,
    key: &str,
) -> Result<Option<&'a str>, V3AnthropicCodecError> {
    let Some(value) = part.get(key) else {
        return Ok(None);
    };
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(Some)
        .ok_or(V3AnthropicCodecError::MalformedField {
            field: "reasoning content",
        })
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
    // responses finish_reason -> hub -> anthropic（查表；未命中走 status 分支，与原 match 兜底一致）
    if let Some(value) = object.get("finish_reason").and_then(Value::as_str) {
        if let Some(hub) = table_map_value(
            V3TableKind::FinishReason,
            "responses",
            value,
            V3TableDirection::Inbound,
        )
        .ok()
        .flatten()
        {
            if let Some(anthropic_value) = table_map_value(
                V3TableKind::FinishReason,
                "anthropic",
                hub,
                V3TableDirection::Outbound,
            )
            .ok()
            .flatten()
            {
                return anthropic_value;
            }
        }
    }
    match object.get("status").and_then(Value::as_str) {
        Some("incomplete") => "max_tokens",
        _ => "end_turn",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_sse_projection_rejects_tool_use_without_input() {
        let error = project_v3_anthropic_message_as_sse_events(&json!({
            "id":"msg_missing_input",
            "type":"message",
            "role":"assistant",
            "content":[{"type":"tool_use","id":"call_missing_input","name":"lookup"}]
        }))
        .expect_err("missing tool_use input must not be synthesized as an empty object");

        assert_eq!(
            error,
            V3AnthropicCodecError::MalformedField {
                field: "tool_use input"
            }
        );
    }
}

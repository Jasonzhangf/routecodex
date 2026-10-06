use super::usage_normalization::project_v3_anthropic_usage_from_canonical;
use super::{
    project_v3_responses_reasoning_item_as_anthropic_content, V3AnthropicCodecError,
    V3AnthropicResponsesProjectionContext, V3HubProviderWireProtocol, V3HubTransportIntent,
};
use crate::operation_runner::ResponseProjectionView;
use crate::protocol_tables::{map_value as table_map_value, V3TableDirection, V3TableKind};
use serde_json::{json, Value};

pub fn project_v3_responses_json_as_anthropic_message(
    response: &Value,
) -> Result<Value, V3AnthropicCodecError> {
    project_v3_responses_json_as_anthropic_message_with_context(
        response,
        &V3AnthropicResponsesProjectionContext::default(),
    )
}

pub fn project_v3_responses_json_as_anthropic_message_with_context(
    response: &Value,
    context: &V3AnthropicResponsesProjectionContext,
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
                    "name":anthropic_client_tool_name(item, context),
                    "input":input
                }));
            }
            Some("custom_tool_call") => {
                has_tool = true;
                content.push(json!({
                    "type":"tool_use",
                    "id":item.get("call_id").or_else(|| item.get("id")).cloned().unwrap_or(Value::Null),
                    "name":anthropic_client_tool_name(item, context),
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
    if let Some(usage) = object
        .get("usage")
        .and_then(project_v3_anthropic_usage_from_canonical)
    {
        message["usage"] = usage;
    }
    Ok(message)
}

pub fn project_v3_responses_json_as_anthropic_events(
    response: &Value,
) -> Result<Vec<Value>, V3AnthropicCodecError> {
    project_v3_responses_json_as_anthropic_events_with_context(
        response,
        &V3AnthropicResponsesProjectionContext::default(),
    )
}

pub fn project_v3_responses_json_as_anthropic_events_with_context(
    response: &Value,
    context: &V3AnthropicResponsesProjectionContext,
) -> Result<Vec<Value>, V3AnthropicCodecError> {
    let message = project_v3_responses_json_as_anthropic_message_with_context(response, context)?;
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
    project_v3_anthropic_client_response_for_provider_with_context(
        semantic,
        provider_protocol,
        transport_intent,
        &V3AnthropicResponsesProjectionContext::default(),
    )
}

pub fn project_v3_anthropic_client_response_for_provider_with_view(
    semantic: &Value,
    view: &ResponseProjectionView,
    provider_protocol: V3HubProviderWireProtocol,
    transport_intent: V3HubTransportIntent,
) -> Result<Value, V3AnthropicCodecError> {
    let context = V3AnthropicResponsesProjectionContext::from_successful_attempt(view)?;
    project_v3_anthropic_client_response_for_provider_with_context(
        semantic,
        provider_protocol,
        transport_intent,
        &context,
    )
}

fn project_v3_anthropic_client_response_for_provider_with_context(
    semantic: &Value,
    provider_protocol: V3HubProviderWireProtocol,
    transport_intent: V3HubTransportIntent,
    context: &V3AnthropicResponsesProjectionContext,
) -> Result<Value, V3AnthropicCodecError> {
    let message = if provider_protocol == V3HubProviderWireProtocol::OpenAiChat {
        project_v3_openai_chat_completion_as_anthropic_message_with_context(semantic, context)?
    } else {
        project_v3_responses_json_as_anthropic_message_with_context(semantic, context)?
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
    project_v3_openai_chat_completion_as_anthropic_message_with_context(
        response,
        &V3AnthropicResponsesProjectionContext::default(),
    )
}

fn project_v3_openai_chat_completion_as_anthropic_message_with_context(
    response: &Value,
    context: &V3AnthropicResponsesProjectionContext,
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
        let name = function
            .get("name")
            .and_then(Value::as_str)
            .map(|emitted_name| anthropic_client_tool_name_from_emitted(emitted_name, context))
            .unwrap_or_else(|| function.get("name").cloned().unwrap_or(Value::Null));
        content.push(json!({
            "type":"tool_use",
            "id":tool_call.get("id").cloned().unwrap_or(Value::Null),
            "name":name,
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
    if let Some(usage) = object
        .get("usage")
        .and_then(project_v3_anthropic_usage_from_canonical)
    {
        message["usage"] = usage;
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

fn anthropic_client_tool_name(
    item: &Value,
    context: &V3AnthropicResponsesProjectionContext,
) -> Value {
    match item.get("name").and_then(Value::as_str) {
        Some(emitted_name) => anthropic_client_tool_name_from_emitted(emitted_name, context),
        None => item.get("name").cloned().unwrap_or(Value::Null),
    }
}

/// Consume the successful-attempt typed view to restore the client-facing tool
/// identity (original name plus declared namespace) from the emitted wire name.
/// Only the typed view authorizes this inverse; callers without a successful
/// attempt pass an empty context and the emitted name is preserved.
fn anthropic_client_tool_name_from_emitted(
    emitted_name: &str,
    context: &V3AnthropicResponsesProjectionContext,
) -> Value {
    let Some((_kind, Some(original_name), namespace)) =
        context.successful_attempt_tool_identity(emitted_name)
    else {
        return Value::String(emitted_name.to_string());
    };
    let name = namespace
        .and_then(Value::as_str)
        .filter(|namespace| !namespace.trim().is_empty())
        .map(|namespace| format!("{namespace}.{original_name}"))
        .unwrap_or_else(|| original_name.to_string());
    Value::String(name)
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
    use crate::operation_runner::{
        execute_v3_operation_runner_request_capture_client_json,
        execute_v3_operation_runner_request_normalize_losslessly, AttemptContext,
        AttemptDeclarationMap, AttemptProjectionContext, RequestInvocationContext,
        RequestNormalizationEntry, RequestOriginKind, ResponseProjectionView,
        ToolMappingReference, V3RequestContextHandle,
    };

    #[test]
    fn successful_attempt_view_restores_original_anthropic_mcp_name() {
        let raw = json!({
            "model": "client-model",
            "input": [{"role": "user", "content": "Use the search tool"}],
            "tools": [{
                "type": "function",
                "name": "mcp__search.find",
                "parameters": {"type": "object"}
            }]
        });
        let handle = V3RequestContextHandle::new(
            "req02-anthropic-inverse-unit".to_string(),
            "responses".to_string(),
        );
        let invocation = RequestInvocationContext::new(
            handle.clone(),
            "req02-anthropic-inverse-unit:invocation".to_string(),
            "req02-anthropic-inverse-unit:attempt".to_string(),
            RequestOriginKind::ClientEntry,
        );
        let captured = execute_v3_operation_runner_request_capture_client_json(raw)
            .expect("public capture must accept the tool declaration");
        execute_v3_operation_runner_request_normalize_losslessly(
            &handle,
            &invocation,
            RequestNormalizationEntry::RawEntry(captured),
        )
        .expect("public normalization must publish the inverse pair");
        let pair = handle.original_pair().expect("published inverse pair");
        let declaration = pair
            .inverse_context
            .tool_declarations
            .first()
            .expect("tool declaration");
        let mapping = ToolMappingReference {
            declaration_record_id: declaration.record_id.clone(),
            source_path: declaration.source_path.clone(),
            destination_path: "tools[0]".to_string(),
            emitted_kind: "function".to_string(),
            emitted_name: Some("mcp__search__find".to_string()),
            emitted_namespace: None,
            encoding: "json".to_string(),
        };
        let attempt = AttemptContext {
            attempt_id: "req02-anthropic-inverse-unit:attempt".to_string(),
            projection: AttemptProjectionContext {
                attempt_id: "req02-anthropic-inverse-unit:attempt".to_string(),
                provider_protocol: "anthropic".to_string(),
                provider_model: "anthropic-wire".to_string(),
                paths: Vec::new(),
            },
            declarations: AttemptDeclarationMap {
                attempt_id: "req02-anthropic-inverse-unit:attempt".to_string(),
                provider_protocol: "anthropic".to_string(),
                provider_model: "anthropic-wire".to_string(),
                tool_mappings: vec![mapping],
            },
        };
        handle
            .publish_successful_attempt(attempt.clone())
            .expect("publish successful attempt");
        let view = ResponseProjectionView::from_successful_attempt(&handle, &attempt)
            .expect("successful attempt view");
        let context = V3AnthropicResponsesProjectionContext::from_successful_attempt(&view)
            .expect("successful attempt projection context");

        let message = project_v3_responses_json_as_anthropic_message_with_context(
            &json!({
                "id": "resp_inverse_unit",
                "output": [{
                    "type": "function_call",
                    "call_id": "mcp-call",
                    "name": "mcp__search__find",
                    "arguments": "{\"arguments\":{\"query\":\"find nested json\"}}"
                }],
                "status": "completed"
            }),
            &context,
        )
        .expect("client Anthropic projection must restore the original identity");

        assert_eq!(message["content"][0]["type"], "tool_use");
        assert_eq!(message["content"][0]["id"], "mcp-call");
        assert_eq!(message["content"][0]["name"], "mcp__search.find");
        assert_eq!(
            message["content"][0]["input"],
            json!({"arguments": {"query": "find nested json"}})
        );
    }

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

    #[test]
    fn openai_chat_wire_client_projection_restores_original_anthropic_mcp_name() {
        // The openai_chat provider wire carries the emitted `__`-encoded name in
        // `choices[0].message.tool_calls[].function.name`. The Anthropic client
        // projection must consume the same successful-attempt typed view as the
        // Anthropic/Responses wires and restore the original dotted identity.
        let raw = json!({
            "model": "client-model",
            "input": [{"role": "user", "content": "Use the search tool"}],
            "tools": [{
                "type": "function",
                "name": "mcp__search.find",
                "parameters": {"type": "object"}
            }]
        });
        let handle = V3RequestContextHandle::new(
            "req02-anthropic-inverse-openai-chat-unit".to_string(),
            "responses".to_string(),
        );
        let invocation = RequestInvocationContext::new(
            handle.clone(),
            "req02-anthropic-inverse-openai-chat-unit:invocation".to_string(),
            "req02-anthropic-inverse-openai-chat-unit:attempt".to_string(),
            RequestOriginKind::ClientEntry,
        );
        let captured = execute_v3_operation_runner_request_capture_client_json(raw)
            .expect("public capture must accept the tool declaration");
        execute_v3_operation_runner_request_normalize_losslessly(
            &handle,
            &invocation,
            RequestNormalizationEntry::RawEntry(captured),
        )
        .expect("public normalization must publish the inverse pair");
        let pair = handle.original_pair().expect("published inverse pair");
        let declaration = pair
            .inverse_context
            .tool_declarations
            .first()
            .expect("tool declaration");
        let mapping = ToolMappingReference {
            declaration_record_id: declaration.record_id.clone(),
            source_path: declaration.source_path.clone(),
            destination_path: "tools[0]".to_string(),
            emitted_kind: "function".to_string(),
            emitted_name: Some("mcp__search__find".to_string()),
            emitted_namespace: None,
            encoding: "json".to_string(),
        };
        let attempt = AttemptContext {
            attempt_id: "req02-anthropic-inverse-openai-chat-unit:attempt".to_string(),
            projection: AttemptProjectionContext {
                attempt_id: "req02-anthropic-inverse-openai-chat-unit:attempt".to_string(),
                provider_protocol: "openai_chat".to_string(),
                provider_model: "chat-wire".to_string(),
                paths: Vec::new(),
            },
            declarations: AttemptDeclarationMap {
                attempt_id: "req02-anthropic-inverse-openai-chat-unit:attempt".to_string(),
                provider_protocol: "openai_chat".to_string(),
                provider_model: "chat-wire".to_string(),
                tool_mappings: vec![mapping],
            },
        };
        handle
            .publish_successful_attempt(attempt.clone())
            .expect("publish successful attempt");
        let view = ResponseProjectionView::from_successful_attempt(&handle, &attempt)
            .expect("successful attempt view");

        let message = project_v3_anthropic_client_response_for_provider_with_view(
            &json!({
                "id": "chatcmpl-req02-openai-chat-inverse",
                "object": "chat.completion",
                "model": "chat-wire",
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": null,
                        "tool_calls": [{
                            "id": "mcp-call",
                            "type": "function",
                            "function": {
                                "name": "mcp__search__find",
                                "arguments": "{\"arguments\":{\"query\":\"find nested json\"}}"
                            }
                        }]
                    },
                    "finish_reason": "tool_calls"
                }]
            }),
            &view,
            V3HubProviderWireProtocol::OpenAiChat,
            V3HubTransportIntent::Json,
        )
        .expect("openai_chat client projection must restore the original identity");

        assert_eq!(message["content"][0]["type"], "tool_use");
        assert_eq!(message["content"][0]["id"], "mcp-call");
        assert_eq!(message["content"][0]["name"], "mcp__search.find");
        assert_eq!(
            message["content"][0]["input"],
            json!({"arguments": {"query": "find nested json"}})
        );
    }
}

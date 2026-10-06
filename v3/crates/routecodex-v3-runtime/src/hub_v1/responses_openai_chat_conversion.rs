use super::*;
use crate::operation_runner::{ResponseProjectionView, ToolDeclarationReference};
use provider_compat_core::namespace_tools::namespace_tool_name_map;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};

#[cfg(test)]
#[path = "responses_openai_chat_conversion_tests.rs"]
mod responses_openai_chat_conversion_tests;

#[derive(Clone, Debug)]
pub(crate) struct V3ClientCustomToolName {
    name: String,
    namespace: Option<String>,
}

enum V3ResponsesToolIdentity<'a> {
    Legacy {
        custom_tool_names: &'a BTreeMap<String, V3ClientCustomToolName>,
        mcp_tool_identities: &'a HashMap<String, (String, String)>,
    },
    SuccessfulAttempt(&'a ResponseProjectionView),
}

#[derive(Clone, Copy)]
enum V3OpenAIChatToolCallRepresentation {
    Custom,
    Function,
}

struct V3OpenAIChatToolCall<'a> {
    call_id: &'a str,
    name: &'a str,
    arguments: &'a str,
    namespace: Option<&'a Value>,
    representation: V3OpenAIChatToolCallRepresentation,
}

fn client_custom_tool_call(
    call_id: &str,
    client_tool: &V3ClientCustomToolName,
    input: &str,
) -> Value {
    let mut call = json!({
        "type":"custom_tool_call",
        "call_id":call_id,
        "name":client_tool.name,
        "input":input
    });
    if let Some(namespace) = &client_tool.namespace {
        call["namespace"] = Value::String(namespace.clone());
    }
    call
}

pub(crate) fn build_v3_responses_provider_response_from_openai_chat_payload(
    payload: &Value,
    provider_semantic_body: &Value,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    build_v3_responses_provider_response_from_openai_chat_payload_with_manifest(
        payload,
        provider_semantic_body,
        None,
        None,
    )
}

pub(crate) fn build_v3_responses_provider_response_from_openai_chat_payload_with_manifest(
    payload: &Value,
    provider_semantic_body: &Value,
    manifest: Option<&V3Config05ManifestPublished>,
    provider_id: Option<&str>,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    let aliases = super::request_outbound_mcp_names::openai_chat_namespace_wire_aliases(
        provider_semantic_body,
    )
    .map_err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec)?;
    let custom_tool_names = collect_v3_responses_custom_tool_names(provider_semantic_body)
        .into_iter()
        .map(|(name, identity)| {
            let name = aliases.get(&name).cloned().unwrap_or(name);
            (name, identity)
        })
        .collect();
    let mcp_tool_identities = super::request_outbound_mcp_names::responses_mcp_dispatch_identities(
        provider_semantic_body,
    )
    .map_err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec)?
    .into_iter()
    .map(|(name, identity)| (aliases.get(&name).cloned().unwrap_or(name), identity))
    .collect();
    build_v3_responses_provider_response_from_openai_chat_payload_core(
        payload,
        manifest,
        provider_id,
        V3ResponsesToolIdentity::Legacy {
            custom_tool_names: &custom_tool_names,
            mcp_tool_identities: &mcp_tool_identities,
        },
    )
}

pub(crate) fn build_v3_responses_provider_response_from_openai_chat_payload_with_manifest_and_successful_attempt(
    payload: &Value,
    view: &ResponseProjectionView,
    manifest: &V3Config05ManifestPublished,
    provider_id: Option<&str>,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    build_v3_responses_provider_response_from_openai_chat_payload_core(
        payload,
        Some(manifest),
        provider_id,
        V3ResponsesToolIdentity::SuccessfulAttempt(view),
    )
}

pub fn project_v3_openai_chat_response_as_responses_with_successful_attempt(
    payload: &Value,
    view: &ResponseProjectionView,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    build_v3_responses_provider_response_from_openai_chat_payload_core(
        payload,
        None,
        None,
        V3ResponsesToolIdentity::SuccessfulAttempt(view),
    )
}

fn build_v3_responses_provider_response_from_openai_chat_payload_core(
    payload: &Value,
    manifest: Option<&V3Config05ManifestPublished>,
    provider_id: Option<&str>,
    tool_identity: V3ResponsesToolIdentity<'_>,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    if let Some(message) =
        responses_relay_diagnostics::openai_chat_provider_diagnostic_message(payload)
    {
        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            message,
        ));
    }
    if let Some(message) =
        responses_relay_diagnostics::provider_response_semantic_error_message_from_manifest(
            manifest,
            provider_id,
            payload,
        )
    {
        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            message,
        ));
    }

    let choices = payload
        .get("choices")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                "OpenAI Chat provider response must contain choices before Responses projection"
                    .to_string(),
            )
        })?;
    let mut output = Vec::new();
    let mut output_text_parts = Vec::new();
    let mut finish_reason = None;
    for choice in choices {
        if finish_reason.is_none() {
            finish_reason = choice
                .get("finish_reason")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        if let Some(message) = choice.get("message").and_then(Value::as_object) {
            if let Some(reasoning) =
                build_v3_responses_reasoning_item_from_openai_chat_message(message)
            {
                output.push(reasoning);
            }
            if let Some(content) = message.get("content").and_then(Value::as_str) {
                if !content.trim().is_empty() {
                    output_text_parts.push(content.to_string());
                    output.push(json!({"type":"output_text","text":content}));
                }
            }
            if let Some(tool_calls) = message.get("tool_calls").and_then(Value::as_array) {
                for call in tool_calls {
                    output.push(
                        build_v3_responses_function_call_from_openai_chat_tool_call_with_identity(
                            call,
                            &tool_identity,
                        )?,
                    );
                }
            }
        }
    }
    // A tool call is a normal Responses output item, so a completed provider turn
    // keeps the terminal status `completed`. `requires_action` is not a Responses
    // status; fabricating it here makes clients that wait for a terminal status
    // hang. The presence of tool calls is carried by `output`, not by `status`.
    // Only an explicit truncation is a non-success terminal, and it must use the
    // Responses `incomplete` shape rather than a Chat `finish_reason` field.
    // 截断词表复用唯一 owner：guard 与投影必须认同一组 reason，否则 `max_tokens`
    // 等网关别名会被 guard 豁免、却在这里落成 `completed` 的空成功响应。
    let status = match finish_reason.as_deref() {
        Some(reason) if openai_chat_finish_reason_is_output_cap(reason) => "incomplete",
        _ => "completed",
    };
    let mut response = Map::new();
    response.insert(
        "id".to_string(),
        payload
            .get("id")
            .cloned()
            .unwrap_or_else(|| Value::String("resp_openai_chat_relay".to_string())),
    );
    response.insert("object".to_string(), Value::String("response".to_string()));
    if let Some(model) = payload.get("model") {
        response.insert("model".to_string(), model.clone());
    }
    if let Some(created_at) = payload.get("created_at").or_else(|| payload.get("created")) {
        response.insert("created_at".to_string(), created_at.clone());
    }
    response.insert("status".to_string(), Value::String(status.to_string()));
    response.insert("output".to_string(), Value::Array(output));
    if !output_text_parts.is_empty() {
        response.insert(
            "output_text".to_string(),
            Value::String(output_text_parts.join("")),
        );
    }
    if status == "incomplete" {
        response.insert(
            "incomplete_details".to_string(),
            json!({"reason": "max_output_tokens"}),
        );
    }
    if let Some(usage) = payload
        .get("usage")
        .and_then(project_v3_responses_usage_from_canonical)
    {
        response.insert("usage".to_string(), usage);
    }
    Ok(Value::Object(response))
}

pub(crate) fn build_v3_responses_reasoning_item_from_openai_chat_message(
    message: &Map<String, Value>,
) -> Option<Value> {
    let mut summary = Vec::new();
    let mut encrypted_content = None;

    if let Some(reasoning) = message.get("reasoning") {
        if let Some(reasoning_row) = reasoning.as_object() {
            summary = collect_v3_reasoning_summary_entries(reasoning_row.get("summary"));
            if summary.is_empty() {
                summary = collect_v3_reasoning_content_entries(reasoning_row.get("content"))
                    .into_iter()
                    .map(v3_reasoning_summary_text_entry)
                    .collect();
            }
            encrypted_content = read_v3_trimmed_string(reasoning_row.get("encrypted_content"));
        } else if let Some(text) = flatten_v3_reasoning_text(reasoning)
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
        {
            summary.push(v3_reasoning_summary_text_entry(text));
        }
    }

    if summary.is_empty() {
        for key in ["reasoning_content", "reasoning_text"] {
            if let Some(text) = message
                .get(key)
                .and_then(flatten_v3_reasoning_text)
                .map(|text| text.trim().to_string())
                .filter(|text| !text.is_empty())
            {
                summary.push(v3_reasoning_summary_text_entry(text));
                break;
            }
        }
    }

    if summary.is_empty() && encrypted_content.is_none() {
        return None;
    }

    let mut item = Map::new();
    item.insert("type".to_string(), Value::String("reasoning".to_string()));
    if !summary.is_empty() {
        item.insert("summary".to_string(), Value::Array(summary));
        // 明文推理同时作为 content 供客户端回传：Codex 只把 content（完整推理）
        // 回传到下一轮；缺失 content 时客户端发保留标记（rsn_*），导致 wire
        // reasoning_content 字节与上一轮不匹配 -> ds4 续写缓存 miss -> provider
        // 失忆（"没有之前的上下文"）。content 与 summary 同源（当前 provider
        // 明文即完整推理，无摘要/完整之分）。
        let content: Vec<Value> = item
            .get("summary")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.get("text").cloned())
            .map(|text| json!({"type": "reasoning_text", "text": text}))
            .collect();
        if !content.is_empty() {
            item.insert("content".to_string(), Value::Array(content));
        }
    }
    if let Some(encrypted_content) = encrypted_content {
        item.insert(
            "encrypted_content".to_string(),
            Value::String(encrypted_content),
        );
    }
    Some(Value::Object(item))
}

pub(crate) fn collect_v3_reasoning_summary_entries(value: Option<&Value>) -> Vec<Value> {
    collect_v3_reasoning_text_entries(value, Some("summary_text"))
        .into_iter()
        .map(v3_reasoning_summary_text_entry)
        .collect()
}

pub(crate) fn collect_v3_reasoning_content_entries(value: Option<&Value>) -> Vec<String> {
    collect_v3_reasoning_text_entries(value, Some("reasoning_text"))
}

pub(crate) fn collect_v3_reasoning_text_entries(
    value: Option<&Value>,
    expected_type: Option<&str>,
) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    match value {
        Value::String(text) => trimmed_v3_text(text).into_iter().collect(),
        Value::Array(entries) => entries
            .iter()
            .flat_map(|entry| collect_v3_reasoning_text_entries(Some(entry), expected_type))
            .collect(),
        Value::Object(row) => {
            if let Some(expected_type) = expected_type {
                let kind = row
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or(expected_type)
                    .trim()
                    .to_ascii_lowercase();
                if kind != expected_type && kind != "text" {
                    return Vec::new();
                }
            }
            row.get("text")
                .or_else(|| row.get("content"))
                .and_then(flatten_v3_reasoning_text)
                .map(|text| text.trim().to_string())
                .filter(|text| !text.is_empty())
                .into_iter()
                .collect()
        }
        _ => Vec::new(),
    }
}

pub(crate) fn flatten_v3_reasoning_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => trimmed_v3_text(text),
        Value::Array(entries) => {
            let mut joined = String::new();
            for text in entries
                .iter()
                .filter_map(flatten_v3_reasoning_text)
                .filter(|text| !text.trim().is_empty())
            {
                if !joined.is_empty() {
                    joined.push('\n');
                }
                joined.push_str(text.trim());
            }
            trimmed_v3_text(joined.as_str())
        }
        Value::Object(row) => row
            .get("text")
            .or_else(|| row.get("content"))
            .and_then(flatten_v3_reasoning_text),
        _ => None,
    }
}

pub(crate) fn trimmed_v3_text(text: &str) -> Option<String> {
    let trimmed = text.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

pub(crate) fn v3_reasoning_summary_text_entry(text: String) -> Value {
    json!({"type":"summary_text","text":text})
}

/// Canonical usage -> Responses client wire usage 唯一归一化入口（JSON 响应与 SSE 终帧共用）。
///
/// 输入侧语义判定与 `effective_input` / `cached` 推导唯一真源是
/// `crate::hub_v1::usage_normalization::split_v3_canonical_usage_cache`；
/// Anthropic 私有字段不得出现在 Responses client payload。
pub(crate) use crate::hub_v1::usage_normalization::project_v3_responses_usage_from_canonical;

pub(crate) fn build_v3_responses_function_call_from_openai_chat_tool_call(
    call: &Value,
    custom_tool_names: &BTreeMap<String, V3ClientCustomToolName>,
    mcp_tool_identities: &HashMap<String, (String, String)>,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    build_v3_responses_function_call_from_openai_chat_tool_call_with_identity(
        call,
        &V3ResponsesToolIdentity::Legacy {
            custom_tool_names,
            mcp_tool_identities,
        },
    )
}

fn build_v3_responses_function_call_from_openai_chat_tool_call_with_identity(
    call: &Value,
    identity: &V3ResponsesToolIdentity<'_>,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    let parsed = parse_v3_openai_chat_tool_call(call)?;
    match identity {
        V3ResponsesToolIdentity::Legacy {
            custom_tool_names,
            mcp_tool_identities,
        } => project_v3_openai_chat_tool_call_with_legacy_identity(
            &parsed,
            custom_tool_names,
            mcp_tool_identities,
        ),
        V3ResponsesToolIdentity::SuccessfulAttempt(view) => {
            project_v3_openai_chat_tool_call_with_successful_attempt(&parsed, view)
        }
    }
}

fn parse_v3_openai_chat_tool_call(
    call: &Value,
) -> Result<V3OpenAIChatToolCall<'_>, V3ResponsesRelayRuntimeError> {
    let object = call.as_object().ok_or_else(|| {
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "OpenAI Chat tool_call must be an object before Responses projection".to_string(),
        )
    })?;
    let call_id = object
        .get("id")
        .or_else(|| object.get("call_id"))
        .or_else(|| object.get("tool_call_id"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                "OpenAI Chat tool_call id is required before Responses projection".to_string(),
            )
        })?;
    if object.get("type").and_then(Value::as_str) == Some("custom") {
        let custom = object
            .get("custom")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    "OpenAI Chat custom tool_call.custom must be an object before Responses projection"
                        .to_string(),
                    )
                })?;
        let name = custom
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    "OpenAI Chat custom tool name is required before Responses projection"
                        .to_string(),
                )
            })?;
        let input = custom.get("input").and_then(Value::as_str).ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                "OpenAI Chat custom tool input must be a string before Responses projection"
                    .to_string(),
            )
        })?;
        return Ok(V3OpenAIChatToolCall {
            call_id,
            name,
            arguments: input,
            namespace: custom.get("namespace"),
            representation: V3OpenAIChatToolCallRepresentation::Custom,
        });
    }
    let function = object
        .get("function")
        .and_then(Value::as_object)
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                "OpenAI Chat tool_call.function must be an object before Responses projection"
                    .to_string(),
            )
        })?;
    let name = function
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                "OpenAI Chat tool_call.function.name is required before Responses projection"
                    .to_string(),
            )
        })?;
    let arguments = function
        .get("arguments")
        .and_then(Value::as_str)
        .unwrap_or_default();
    Ok(V3OpenAIChatToolCall {
        call_id,
        name,
        arguments,
        namespace: function.get("namespace"),
        representation: V3OpenAIChatToolCallRepresentation::Function,
    })
}

fn project_v3_openai_chat_tool_call_with_legacy_identity(
    call: &V3OpenAIChatToolCall<'_>,
    custom_tool_names: &BTreeMap<String, V3ClientCustomToolName>,
    mcp_tool_identities: &HashMap<String, (String, String)>,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    if matches!(
        call.representation,
        V3OpenAIChatToolCallRepresentation::Custom
    ) {
        let Some(client_name) = custom_tool_names.get(call.name) else {
            return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                "OpenAI Chat custom tool response requires an active governed custom declaration"
                    .to_string(),
            ));
        };
        return Ok(client_custom_tool_call(
            call.call_id,
            client_name,
            call.arguments,
        ));
    }
    if call.name == "tool_search" {
        let arguments = parse_v3_openai_chat_tool_call_arguments_object(call.name, call.arguments)?;
        return Ok(project_v3_responses_tool_search_call(call.call_id, arguments));
    }
    if let Some(client_name) = custom_tool_names.get(call.name) {
        // 请求侧 custom -> function 扁平化后，provider 返回 function tool_call；
        // 按客户端声明的 custom 名归类回 custom_tool_call，保持客户端契约。
        // provider function arguments 必须是我们发出的对象 schema；只把
        // schema 的 input 字段恢复成原始 free-form 字符串，三个治理字段
        // 只在 provider wire 存在，不能泄露到客户端 custom input。
        let input = parse_v3_openai_chat_custom_tool_input(call.name, call.arguments)?;
        return Ok(client_custom_tool_call(call.call_id, client_name, &input));
    }
    let mut item = Map::from_iter([
        (
            "type".to_string(),
            Value::String("function_call".to_string()),
        ),
        (
            "call_id".to_string(),
            Value::String(call.call_id.to_string()),
        ),
        ("name".to_string(), Value::String(call.name.to_string())),
        (
            "arguments".to_string(),
            Value::String(call.arguments.to_string()),
        ),
    ]);
    super::request_outbound_mcp_names::restore_responses_mcp_namespace(
        &mut item,
        mcp_tool_identities,
    );
    Ok(Value::Object(item))
}

fn project_v3_openai_chat_tool_call_with_successful_attempt(
    call: &V3OpenAIChatToolCall<'_>,
    view: &ResponseProjectionView,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    let mapping = view
        .attempt()
        .declarations
        .tool_mappings
        .iter()
        .find(|mapping| mapping.emitted_name.as_deref() == Some(call.name));
    let Some(mapping) = mapping else {
        return Ok(current_representable_openai_chat_tool_call(
            call.call_id,
            call.name,
            call.arguments,
            call.namespace,
            matches!(
                call.representation,
                V3OpenAIChatToolCallRepresentation::Custom
            ),
        ));
    };
    let declaration = view
        .request_inverse_context()
        .tool_declarations
        .iter()
        .find(|declaration| declaration.record_id == mapping.declaration_record_id)
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                "successful attempt tool mapping references missing declaration record `{}`",
                mapping.declaration_record_id
            ))
        })?;
    if declaration.kind == "tool_search" {
        let arguments = parse_v3_openai_chat_tool_call_arguments_object(call.name, call.arguments)?;
        return Ok(project_v3_responses_tool_search_call(call.call_id, arguments));
    }
    let Some(original_name) = declaration.name.as_deref() else {
        return Ok(current_representable_openai_chat_tool_call(
            call.call_id, call.name, call.arguments, call.namespace,
            matches!(call.representation, V3OpenAIChatToolCallRepresentation::Custom),
        ));
    };

    if declaration.kind == "custom" {
        let input = match call.representation {
            V3OpenAIChatToolCallRepresentation::Custom => call.arguments.to_string(),
            V3OpenAIChatToolCallRepresentation::Function => {
                parse_v3_openai_chat_custom_tool_input(call.name, call.arguments)?
            }
        };
        let mut item = json!({
            "type":"custom_tool_call",
            "call_id":call.call_id,
            "name":original_name,
            "input":input
        });
        insert_declared_namespace(&mut item, declaration);
        return Ok(item);
    }

    let mut item = json!({
        "type":"function_call",
        "call_id":call.call_id,
        "name":original_name,
        "arguments":call.arguments
    });
    insert_declared_namespace(&mut item, declaration);
    Ok(item)
}

/// Responses' client-executed tool-search call has no function name field.
/// Both provider codecs use this standard representation; typed consumers
/// select it from the original declaration kind, not the emitted tool name.
pub(crate) fn project_v3_responses_tool_search_call(call_id: &str, arguments: Value) -> Value {
    json!({
        "type": "tool_search_call", "call_id": call_id,
        "execution": "client", "arguments": arguments
    })
}

fn parse_v3_responses_output_tool_call(
    object: &Map<String, Value>,
) -> Option<V3OpenAIChatToolCall<'_>> {
    let type_name = object.get("type").and_then(Value::as_str)?;
    let call_id = object
        .get("call_id")
        .or_else(|| object.get("id"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())?;
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())?;
    match type_name {
        "function_call" => {
            let arguments = object.get("arguments").and_then(Value::as_str)?;
            Some(V3OpenAIChatToolCall {
                call_id,
                name,
                arguments,
                namespace: None,
                representation: V3OpenAIChatToolCallRepresentation::Function,
            })
        }
        "custom_tool_call" => {
            let input = object.get("input").and_then(Value::as_str)?;
            Some(V3OpenAIChatToolCall {
                call_id,
                name,
                arguments: input,
                namespace: None,
                representation: V3OpenAIChatToolCallRepresentation::Custom,
            })
        }
        _ => None,
    }
}

/// Restore already-normalized Responses `output[]` tool identities from the
/// successful attempt view. Unknown or already-restored siblings are left
/// untouched; mapped items use the same unified call resolver as the
/// OpenAI Chat path.
pub(crate) fn restore_v3_responses_normalized_tool_identities_with_successful_attempt(
    provider_value: &mut Value,
    view: &ResponseProjectionView,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let Some(items) = provider_value
        .get_mut("output")
        .and_then(Value::as_array_mut)
    else {
        return Ok(());
    };
    for item in items {
        let Some(object) = item.as_object_mut() else {
            continue;
        };
        let Some(call) = parse_v3_responses_output_tool_call(object) else {
            continue;
        };
        let known = view
            .attempt()
            .declarations
            .tool_mappings
            .iter()
            .any(|mapping| mapping.emitted_name.as_deref() == Some(call.name));
        if !known {
            continue;
        }
        let restored = project_v3_openai_chat_tool_call_with_successful_attempt(&call, view)?;
        merge_v3_responses_tool_call_identity(object, &restored)?;
    }
    Ok(())
}

/// Original declaration kind recorded for one emitted tool name by the same
/// successful attempt traversal that produced the emission.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum V3DeclaredToolKind {
    Function,
    Custom,
}

/// Resolve the declared kind for an emitted tool name from the successful
/// attempt. The declaration record association is authoritative; the emitted
/// name, model and schema never participate in identity inference.
pub(crate) fn declared_tool_kind_for_emitted_name(
    view: &ResponseProjectionView,
    emitted_name: &str,
) -> Option<V3DeclaredToolKind> {
    let mapping = view
        .attempt()
        .declarations
        .tool_mappings
        .iter()
        .find(|mapping| mapping.emitted_name.as_deref() == Some(emitted_name))?;
    let declaration = view
        .request_inverse_context()
        .tool_declarations
        .iter()
        .find(|declaration| declaration.record_id == mapping.declaration_record_id)?;
    Some(if declaration.kind == "custom" {
        V3DeclaredToolKind::Custom
    } else {
        V3DeclaredToolKind::Function
    })
}

/// Invert one already-normalized Responses `output[]` item from the successful
/// attempt view. Only identity (`type`/`name`/`namespace`) and the declared
/// argument envelope change; `call_id`/`id` and all other siblings stay intact.
///
/// `complete` marks an item carrying the terminal `arguments`/`input`. A
/// partial streamed item restores identity only and never parses a partial
/// envelope as a complete declared input.
pub(crate) fn restore_v3_responses_output_item_identity_with_successful_attempt(
    item: &mut Value,
    view: &ResponseProjectionView,
    complete: bool,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let Some(object) = item.as_object_mut() else {
        return Ok(());
    };
    let Some(call) = parse_v3_responses_output_tool_call(object) else {
        return Ok(());
    };
    let call_id = call.call_id.to_string();
    let emitted_name = call.name.to_string();
    let arguments = call.arguments.to_string();
    let representation = call.representation;
    let known = view
        .attempt()
        .declarations
        .tool_mappings
        .iter()
        .any(|mapping| mapping.emitted_name.as_deref() == Some(emitted_name.as_str()));
    if !known {
        return Ok(());
    }
    if !complete {
        restore_v3_responses_partial_item_identity(
            object,
            view,
            &emitted_name,
            representation,
        )?;
        return Ok(());
    }
    let call = V3OpenAIChatToolCall {
        call_id: &call_id,
        name: &emitted_name,
        arguments: &arguments,
        namespace: None,
        representation,
    };
    let restored = project_v3_openai_chat_tool_call_with_successful_attempt(&call, view)?;
    merge_v3_responses_tool_call_identity(object, &restored)?;
    Ok(())
}

fn restore_v3_responses_partial_item_identity(
    object: &mut Map<String, Value>,
    view: &ResponseProjectionView,
    emitted_name: &str,
    representation: V3OpenAIChatToolCallRepresentation,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let Some(mapping) = view
        .attempt()
        .declarations
        .tool_mappings
        .iter()
        .find(|mapping| mapping.emitted_name.as_deref() == Some(emitted_name))
    else {
        return Ok(());
    };
    let declaration = view
        .request_inverse_context()
        .tool_declarations
        .iter()
        .find(|declaration| declaration.record_id == mapping.declaration_record_id)
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                "successful attempt tool mapping references missing declaration record `{}`",
                mapping.declaration_record_id
            ))
        })?;
    let original_name = declaration
        .name
        .clone()
        .unwrap_or_else(|| emitted_name.to_string());
    object.insert("name".to_string(), Value::String(original_name));
    match declaration.namespace.clone() {
        Some(namespace) => {
            object.insert("namespace".to_string(), namespace);
        }
        None => {
            object.remove("namespace");
        }
    }
    if matches!(
        representation,
        V3OpenAIChatToolCallRepresentation::Custom
    ) {
        object.insert(
            "type".to_string(),
            Value::String("custom_tool_call".to_string()),
        );
        if let Some(arguments) = object.remove("arguments") {
            object.insert("input".to_string(), arguments);
        }
    } else {
        object.insert(
            "type".to_string(),
            Value::String("function_call".to_string()),
        );
        if let Some(input) = object.remove("input") {
            object.insert("arguments".to_string(), input);
        }
    }
    Ok(())
}

/// Restore native Chat calls with the same declaration resolver used by
/// Responses. Only the identity and its declared argument envelope change.
pub(crate) fn restore_v3_chat_tool_identities_with_successful_attempt(
    provider_value: &mut Value,
    view: &ResponseProjectionView,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let Some(choices) = provider_value.get_mut("choices").and_then(Value::as_array_mut) else {
        return Ok(());
    };
    for choice in choices {
        let Some(calls) = choice.get_mut("message")
            .and_then(|message| message.get_mut("tool_calls"))
            .and_then(Value::as_array_mut) else {
            continue;
        };
        for call in calls {
            // A native partial or invalid model call still passes through.
            // Only a complete representable call enters identity inversion.
            let tool = call.get("function").or_else(|| call.get("custom"));
            let call_id = call.get("id").or_else(|| call.get("call_id"))
                .or_else(|| call.get("tool_call_id"));
            let argument_field = if call.get("type").and_then(Value::as_str) == Some("custom") {
                "input"
            } else {
                "arguments"
            };
            if !call_id.and_then(Value::as_str).is_some_and(|id| !id.trim().is_empty())
                || tool.and_then(|tool| tool.get(argument_field)).and_then(Value::as_str).is_none()
            {
                continue;
            }
            let name = call.get("function").or_else(|| call.get("custom"))
                .and_then(|tool| tool.get("name")).and_then(Value::as_str);
            if !view.attempt().declarations.tool_mappings.iter()
                .any(|mapping| mapping.emitted_name.as_deref() == name && name.is_some()) {
                continue;
            }
            let restored = project_v3_openai_chat_tool_call_with_successful_attempt(
                &parse_v3_openai_chat_tool_call(call)?, view,
            )?;
            let is_custom = restored["type"] == "custom_tool_call";
            let (kind, other, arguments) = if is_custom {
                ("custom", "function", "input")
            } else {
                ("function", "custom", "arguments")
            };
            let object = call.as_object_mut().expect("parsed Chat call is an object");
            object.insert("type".to_string(), Value::String(kind.to_string()));
            object.remove(other);
            let tool = object.entry(kind).or_insert_with(|| json!({}));
            tool["name"] = restored["name"].clone();
            tool[arguments] = restored[arguments].clone();
            if let Some(namespace) = restored.get("namespace") {
                tool["namespace"] = namespace.clone();
            } else if let Some(tool) = tool.as_object_mut() {
                tool.remove("namespace");
            }
        }
    }
    Ok(())
}

/// Invert one already-projected OpenAI Chat tool call from the successful
/// attempt view. `custom_input` is the already-decoded declared free-form input
/// for a custom call; function calls keep their exact argument bytes.
pub(crate) fn restore_v3_chat_streamed_tool_call_identity_with_successful_attempt(
    call: &mut Value,
    view: &ResponseProjectionView,
    emitted_name: &str,
    custom_input: Option<&str>,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let Some(object) = call.as_object_mut() else {
        return Ok(());
    };
    let Some(mapping) = view
        .attempt()
        .declarations
        .tool_mappings
        .iter()
        .find(|mapping| mapping.emitted_name.as_deref() == Some(emitted_name))
    else {
        return Ok(());
    };
    let declaration = view
        .request_inverse_context()
        .tool_declarations
        .iter()
        .find(|declaration| declaration.record_id == mapping.declaration_record_id)
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                "successful attempt tool mapping references missing declaration record `{}`",
                mapping.declaration_record_id
            ))
        })?;
    let original_name = declaration
        .name
        .clone()
        .unwrap_or_else(|| emitted_name.to_string());
    if declaration.kind == "custom" {
        let mut custom = Map::new();
        custom.insert("name".to_string(), Value::String(original_name));
        if let Some(namespace) = declaration.namespace.clone() {
            custom.insert("namespace".to_string(), namespace);
        }
        custom.insert(
            "input".to_string(),
            Value::String(custom_input.unwrap_or_default().to_string()),
        );
        object.insert("type".to_string(), Value::String("custom".to_string()));
        object.remove("function");
        object.insert("custom".to_string(), Value::Object(custom));
    } else {
        object.insert("type".to_string(), Value::String("function".to_string()));
        if let Some(function) = object.get_mut("function").and_then(Value::as_object_mut) {
            function.insert("name".to_string(), Value::String(original_name));
            match declaration.namespace.clone() {
                Some(namespace) => {
                    function.insert("namespace".to_string(), namespace);
                }
                None => {
                    function.remove("namespace");
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn restore_v3_responses_provider_representation_tool_identities_with_successful_attempt(
    provider_value: &mut Value,
    view: &ResponseProjectionView,
    provider_wire_protocol: V3HubProviderWireProtocol,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    if provider_wire_protocol != V3HubProviderWireProtocol::Responses {
        return Ok(());
    }
    restore_v3_responses_normalized_tool_identities_with_successful_attempt(provider_value, view)
}

fn merge_v3_responses_tool_call_identity(
    object: &mut Map<String, Value>,
    restored: &Value,
) -> Result<(), V3ResponsesRelayRuntimeError> {
    let restored = restored.as_object().ok_or_else(|| {
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "successful attempt tool projection must be an object".to_string(),
        )
    })?;
    let restored_type = restored
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                "successful attempt tool projection omitted type".to_string(),
            )
        })?;
    let restored_name = restored.get("name").cloned().ok_or_else(|| {
        V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            "successful attempt tool projection omitted name".to_string(),
        )
    })?;

    object.insert("type".to_string(), Value::String(restored_type.to_string()));
    object.insert("name".to_string(), restored_name);
    match restored.get("namespace") {
        Some(namespace) => {
            object.insert("namespace".to_string(), namespace.clone());
        }
        None => {
            object.remove("namespace");
        }
    }

    match restored_type {
        "custom_tool_call" => {
            let input = restored.get("input").cloned().ok_or_else(|| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    "successful attempt custom tool projection omitted input".to_string(),
                )
            })?;
            object.insert("input".to_string(), input);
            object.remove("arguments");
        }
        "function_call" => {
            let arguments = restored.get("arguments").cloned().ok_or_else(|| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                    "successful attempt function tool projection omitted arguments".to_string(),
                )
            })?;
            object.insert("arguments".to_string(), arguments);
            object.remove("input");
        }
        other => {
            return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
                format!("unsupported successful attempt tool projection type `{other}`"),
            ))
        }
    }

    Ok(())
}

fn insert_declared_namespace(item: &mut Value, declaration: &ToolDeclarationReference) {
    if let Some(namespace) = &declaration.namespace {
        item["namespace"] = namespace.clone();
    }
}

fn current_representable_openai_chat_tool_call(
    call_id: &str,
    provider_name: &str,
    provider_arguments: &str,
    provider_namespace: Option<&Value>,
    provider_is_custom: bool,
) -> Value {
    let mut item = if provider_is_custom {
        json!({
            "type":"custom_tool_call",
            "call_id":call_id,
            "name":provider_name,
            "input":provider_arguments
        })
    } else {
        json!({
            "type":"function_call",
            "call_id":call_id,
            "name":provider_name,
            "arguments":provider_arguments
        })
    };
    if let Some(namespace) = provider_namespace {
        item["namespace"] = namespace.clone();
    }
    item
}

pub(crate) fn parse_v3_openai_chat_custom_tool_input(
    name: &str,
    arguments: &str,
) -> Result<String, V3ResponsesRelayRuntimeError> {
    // Provider may not honor the `{"input":"..."}` Chat-freeform schema and may
    // return the raw free-form text directly. For a governed custom tool the
    // client contract is a raw string, so accept either shape explicitly.
    let trimmed = arguments.trim();
    if trimmed.is_empty() {
        return Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            format!("OpenAI Chat custom tool {name} function arguments must not be empty"),
        ));
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(Value::Object(parsed)) => parsed
            .get("input")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| {
                V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                    "OpenAI Chat custom tool {name} function arguments must contain string input"
                ))
            }),
        Ok(Value::String(value)) => Ok(value),
        Ok(_) => Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
            format!(
                "OpenAI Chat custom tool {name} function arguments must be an object or string"
            ),
        )),
        Err(_) => Ok(trimmed.to_string()),
    }
}

pub(crate) fn parse_v3_openai_chat_tool_call_arguments_object(
    name: &str,
    arguments: &str,
) -> Result<Value, V3ResponsesRelayRuntimeError> {
    let trimmed = arguments.trim();
    let parsed = if trimmed.is_empty() {
        Value::Object(Map::new())
    } else {
        serde_json::from_str::<Value>(trimmed).map_err(|error| {
            V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(format!(
                "OpenAI Chat tool_call {name} arguments must be a JSON object before Responses projection: {error}"
            ))
        })?
    };
    if parsed.is_object() {
        return Ok(parsed);
    }
    Err(V3ResponsesRelayRuntimeError::ProviderResponseEventCodec(
        format!(
            "OpenAI Chat tool_call {name} arguments must be a JSON object before Responses projection"
        ),
    ))
}

pub(crate) fn collect_v3_responses_custom_tool_names(
    payload: &Value,
) -> BTreeMap<String, V3ClientCustomToolName> {
    let mut names = BTreeMap::new();
    collect_v3_responses_custom_tool_names_from_tools(payload.get("tools"), &mut names);
    for item in payload
        .get("input")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if item.get("type").and_then(Value::as_str) == Some("additional_tools") {
            collect_v3_responses_custom_tool_names_from_tools(item.get("tools"), &mut names);
        }
    }
    names
}

pub(crate) fn collect_v3_responses_custom_tool_names_from_tools(
    tools: Option<&Value>,
    names: &mut BTreeMap<String, V3ClientCustomToolName>,
) {
    for tool in tools.and_then(Value::as_array).into_iter().flatten() {
        if tool.get("type").and_then(Value::as_str) == Some("namespace") {
            if let Ok(Some(namespace_names)) = namespace_tool_name_map(tool) {
                let namespace = tool.get("name").and_then(Value::as_str).unwrap_or_default();
                collect_namespace_custom_tool_names(tool, namespace, &namespace_names, names);
            }
            continue;
        }
        if tool.get("type").and_then(Value::as_str) != Some("custom") {
            continue;
        }
        if let Some(name) = tool
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            names.insert(
                name.to_string(),
                V3ClientCustomToolName {
                    name: name.to_string(),
                    namespace: None,
                },
            );
        }
    }
}

fn collect_namespace_custom_tool_names(
    namespace: &Value,
    client_namespace: &str,
    namespace_names: &std::collections::HashMap<String, String>,
    names: &mut BTreeMap<String, V3ClientCustomToolName>,
) {
    for child in namespace
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(name) = child.get("name").and_then(Value::as_str) else {
            continue;
        };
        let client_name = format!("{client_namespace}.{name}");
        match child.get("type").and_then(Value::as_str) {
            Some("namespace") => {
                collect_namespace_custom_tool_names(child, &client_name, namespace_names, names)
            }
            Some("custom") => {
                if let Some(provider_name) = namespace_names.get(&client_name) {
                    names.insert(
                        provider_name.clone(),
                        V3ClientCustomToolName {
                            name: name.to_string(),
                            namespace: Some(client_namespace.to_string()),
                        },
                    );
                }
            }
            _ => {}
        }
    }
}

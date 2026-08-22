use routecodex_v3_sse::SseField;
use serde_json::Value;

use super::{V3HubProviderWireProtocol, V3RuntimeStreamObservation};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum V3ProviderResponsesJsonFrameOutcome {
    ContinueBuffering,
    StartClientStream,
    Terminal,
    TerminalWithoutOutput,
    Failure { code: String, message: String },
}

pub(crate) fn parse_v3_provider_sse_json_data(data: &str) -> Result<Option<Value>, String> {
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return Ok(None);
    }
    if let Ok(value) = serde_json::from_str(data) {
        return Ok(Some(value));
    }
    // SSE data 的多行语义是一个聚合 payload，不能逐行挑出首个可解析 JSON。
    // 那会把同帧后续数据静默丢弃，错误地把不完整流当作成功。兼容只处理
    // JSON 字符串内未转义的控制字符；结构性尾随、截断和多对象帧必须保留为
    // Error01，让 Direct 在客户端提交前按既有策略重试完整尝试。
    let normalized = escape_v3_sse_raw_control_characters(data);
    match serde_json::from_str(&normalized) {
        Ok(value) => return Ok(Some(value)),
        Err(error) => Err(format!("provider SSE JSON payload is malformed: {error}")),
    }
}

/// 聚合 provider SSE data。少数 provider 会把一个 JSON 值换行，却没有给
/// 续行补 `data:` 前缀；SSE framing 层会把这种行保留为 field name。只有当
/// 当前 JSON 仍处于字符串内，或续行明显以 JSON 结构字符开头时，才把它
/// 恢复为 data；普通 `event`/扩展 field 继续保持非 payload 语义。
pub(crate) fn collect_v3_provider_sse_json_data(fields: &[SseField]) -> String {
    let mut data = String::new();
    let mut in_string = false;
    let mut escaped = false;
    for field in fields {
        let SseField::Named { name, value } = field else {
            continue;
        };
        let fragment = if name == "data" {
            Some(value.as_str())
        } else if !data.is_empty()
            && (in_string
                || name
                    .trim_start()
                    .chars()
                    .next()
                    .is_some_and(|character| matches!(character, '"' | '{' | '[' | '}' | ']')))
        {
            Some(name.as_str())
        } else {
            None
        };
        let Some(fragment) = fragment else {
            continue;
        };
        if !data.is_empty() {
            data.push('\n');
        }
        data.push_str(fragment);
        for character in fragment.chars() {
            if escaped {
                escaped = false;
            } else if character == '\\' && in_string {
                escaped = true;
            } else if character == '"' {
                in_string = !in_string;
            }
        }
    }
    data
}

pub(crate) fn normalize_v3_provider_sse_json_data_for_event_name(
    provider_protocol: V3HubProviderWireProtocol,
    fields: &[SseField],
) -> Result<String, String> {
    let data = collect_v3_provider_sse_json_data(fields);
    let event_name = fields.iter().find_map(|field| match field {
        SseField::Named { name, value } if name == "event" => Some(value.as_str()),
        _ => None,
    });
    normalize_v3_provider_sse_json_data_with_event_name(provider_protocol, &data, event_name)
}

pub(crate) fn normalize_v3_provider_sse_json_data_with_event_name(
    provider_protocol: V3HubProviderWireProtocol,
    data: &str,
    event_name: Option<&str>,
) -> Result<String, String> {
    if provider_protocol != V3HubProviderWireProtocol::Responses {
        return Ok(data.to_owned());
    }
    let Some(mut event) = parse_v3_provider_sse_json_data(data)? else {
        return Ok(data.to_owned());
    };
    let arguments_normalized = normalize_v3_responses_function_call_arguments(&mut event)?;
    let Some(object) = event.as_object_mut() else {
        return Ok(data.to_owned());
    };
    let event_name = event_name
        .or_else(|| object.get("event").and_then(Value::as_str))
        .or_else(|| object.get("event_name").and_then(Value::as_str));
    let Some(event_name) = event_name else {
        if arguments_normalized {
            return serde_json::to_string(&event).map_err(|error| error.to_string());
        }
        return Ok(data.to_owned());
    };
    if !event_name.starts_with("response.") {
        if arguments_normalized {
            return serde_json::to_string(&event).map_err(|error| error.to_string());
        }
        return Ok(data.to_owned());
    }
    if object
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty())
    {
        if arguments_normalized {
            return serde_json::to_string(&event).map_err(|error| error.to_string());
        }
        return Ok(data.to_owned());
    }
    object.insert("type".to_owned(), Value::String(event_name.to_owned()));
    serde_json::to_string(&event).map_err(|error| error.to_string())
}

pub(crate) fn normalize_v3_responses_function_call_arguments(
    event: &mut Value,
) -> Result<bool, String> {
    let mut normalized = false;
    let mut normalize_item = |item: &mut Value| -> Result<(), String> {
        let Some(object) = item.as_object_mut() else {
            return Ok(());
        };
        if object.get("type").and_then(Value::as_str) != Some("function_call") {
            return Ok(());
        }
        let Some(arguments) = object.get_mut("arguments") else {
            return Ok(());
        };
        if arguments.is_object() || arguments.is_array() {
            *arguments = Value::String(serde_json::to_string(arguments).map_err(|error| error.to_string())?);
            normalized = true;
        }
        Ok(())
    };
    if let Some(object) = event.as_object_mut() {
        if let Some(item) = object.get_mut("item") {
            normalize_item(item)?;
        }
        if let Some(output) = object
            .get_mut("response")
            .and_then(Value::as_object_mut)
            .and_then(|response| response.get_mut("output"))
            .and_then(Value::as_array_mut)
        {
            for item in output {
                normalize_item(item)?;
            }
        }
        if let Some(output) = object.get_mut("output").and_then(Value::as_array_mut) {
            for item in output {
                normalize_item(item)?;
            }
        }
    }
    Ok(normalized)
}

/// 把字符串值内未转义的 \u0000-\u001F 转义为 JSON 合法形式（\n/\r/\t 或
/// \u00XX）。只在字符串值内转义：结构外（JSON 空白）的控制字符保持原样，
/// 不改变 JSON 结构语义；已转义序列（\\n 文本）不含控制字节，天然安全。
fn escape_v3_sse_raw_control_characters(data: &str) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(data.len());
    let mut in_string = false;
    let mut escaped = false;
    for ch in data.chars() {
        if escaped {
            out.push(ch);
            escaped = false;
            continue;
        }
        match ch {
            '\\' if in_string => {
                out.push(ch);
                escaped = true;
            }
            '"' if in_string => {
                out.push(ch);
                in_string = false;
            }
            '"' => {
                out.push(ch);
                in_string = true;
            }
            ch if in_string && ch.is_control() => match ch {
                '\n' => out.push_str("\\n"),
                '\r' => out.push_str("\\r"),
                '\t' => out.push_str("\\t"),
                other => {
                    let _ = write!(out, "\\u{:04x}", other as u32);
                }
            },
            ch => out.push(ch),
        }
    }
    out
}

/// Direct precommit 的唯一 provider SSE 语义分类入口。协议必须来自已经完成的
/// Direct 协议决策，禁止根据 JSON shape 再猜协议；否则 Anthropic 的 `type`
/// 会被误送入 Responses classifier，生命周期帧会错误取得或永远无法取得
/// client commit authority。
pub(crate) fn classify_v3_provider_sse_json_data(
    provider_protocol: V3HubProviderWireProtocol,
    data: &str,
) -> Result<Option<V3ProviderResponsesJsonFrameOutcome>, String> {
    if is_v3_provider_sse_keepalive_text(data) {
        return Ok(None);
    }
    let Some(event) = parse_v3_provider_sse_json_data(data)? else {
        return Ok(None);
    };
    // A valid JSON scalar/array can be emitted by an upstream transport as a
    // control/settlement frame.  It is not a semantic event for any registered
    // provider protocol.  The shared relay codec already consumes these frames
    // before semantic classification; keep the direct precommit classifier on
    // the same boundary so it cannot manufacture a protocol failure from a
    // non-object transport frame.
    if !event.is_object() {
        return Ok(None);
    }
    if is_v3_provider_sse_protocol_neutral_keepalive_json_event(&event) {
        return Ok(None);
    }
    if matches!(
        provider_protocol,
        V3HubProviderWireProtocol::Responses | V3HubProviderWireProtocol::Anthropic
    ) && event.get("type").and_then(Value::as_str) == Some("ping")
    {
        return Ok(None);
    }
    if provider_protocol == V3HubProviderWireProtocol::OpenAiChat
        && matches!(
            event.get("choices").and_then(Value::as_array),
            Some(choices) if choices.is_empty()
        )
    {
        return Ok(None);
    }
    let outcome = match provider_protocol {
        V3HubProviderWireProtocol::Responses => classify_v3_provider_responses_json_event(&event)?,
        V3HubProviderWireProtocol::Anthropic => classify_v3_provider_anthropic_json_event(&event)?,
        V3HubProviderWireProtocol::OpenAiChat => {
            classify_v3_provider_openai_chat_json_event(&event)?
        }
        V3HubProviderWireProtocol::Gemini => {
            return Err(
                "provider Gemini SSE precommit classifier is not registered for Direct".to_string(),
            );
        }
    };
    Ok(Some(outcome))
}

/// Classify a complete JSON body received on an SSE-intent response.  The
/// normal JSON-for-SSE compatibility path remains opaque; only an explicit
/// provider error envelope is classified here so every protocol runtime shares
/// one semantic error decision.
pub(crate) fn classify_v3_provider_json_error_body(
    data: &str,
) -> Result<Option<V3ProviderResponsesJsonFrameOutcome>, String> {
    let value = serde_json::from_str::<Value>(data).map_err(|error| error.to_string())?;
    let has_error_shape = value.get("error").is_some()
        || value
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|kind| {
                matches!(
                    kind,
                    "error"
                        | "response.error"
                        | "response.failed"
                        | "response.cancelled"
                        | "response.canceled"
                )
            });
    if !has_error_shape {
        return Ok(None);
    }
    if let Some(error) = value.get("error").and_then(Value::as_object) {
        return Ok(Some(V3ProviderResponsesJsonFrameOutcome::Failure {
            code: error
                .get("code")
                .or_else(|| error.get("type"))
                .and_then(Value::as_str)
                .unwrap_or("provider_response_sse_error")
                .to_string(),
            message: error
                .get("message")
                .or_else(|| error.get("detail"))
                .and_then(Value::as_str)
                .unwrap_or("provider emitted a JSON error body")
                .to_string(),
        }));
    }
    classify_v3_provider_responses_json_event(&value).map(Some)
}

/// 所有已登记 provider 协议共享的 transport-only JSON keepalive。协议专属
/// settlement（Anthropic `type=ping`、Chat `choices=[]`）必须由对应 codec 判定，
/// 不能在这里借 shape 重分类。
fn is_v3_provider_sse_protocol_neutral_keepalive_json_event(event: &Value) -> bool {
    if event.is_null() {
        return true;
    }
    let Some(object) = event.as_object() else {
        return false;
    };
    object.get("type").and_then(Value::as_str) == Some("ping")
        || object.contains_key("ping")
        || object.is_empty()
}

/// 非 JSON keepalive data 文本（如 `data: ping` / `data: keep-alive`）：
/// 无 JSON 结构的单 token 保活帧，Direct/Relay 一致忽略；其余 malformed
/// JSON 文本保持显式 Error01（不允许静默吞并截断/控制字符污染）。
pub(crate) fn is_v3_provider_sse_keepalive_text(data: &str) -> bool {
    let token = data.trim().to_ascii_lowercase();
    token.is_empty()
        || matches!(
            token.as_str(),
            "ping" | "pong" | "keep-alive" | "keepalive" | "heartbeat" | "ok"
        )
}

pub(crate) fn classify_v3_provider_responses_json_event(
    event: &Value,
) -> Result<V3ProviderResponsesJsonFrameOutcome, String> {
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "provider Responses JSON event requires a non-empty type".to_string())?;

    if matches!(event_type, "error" | "response.error") {
        let error = event
            .get("error")
            .and_then(Value::as_object)
            .unwrap_or_else(|| event.as_object().expect("JSON event is an object"));
        let code = error
            .get("code")
            .or_else(|| error.get("type"))
            .and_then(Value::as_str)
            .unwrap_or(event_type);
        let message = error
            .get("message")
            .or_else(|| error.get("detail"))
            .and_then(Value::as_str)
            .unwrap_or("provider emitted a JSON error event");
        return Ok(V3ProviderResponsesJsonFrameOutcome::Failure {
            code: code.to_string(),
            message: message.to_string(),
        });
    }

    // response.incomplete 是 Responses 协议的合法终态（max_output_tokens 截断 /
    // content_filter 触发），不是 provider 流错误：分类为 Terminal，客户端按协议
    // 接收 status=incomplete 的完整响应，网关不得 abort 流或记录 provider 失败。
    // 缺少 incomplete_details.reason 属于畸形终帧，继续走下方失败分组显式报错。
    if event_type == "response.incomplete" {
        if event
            .pointer("/response/incomplete_details/reason")
            .or_else(|| event.pointer("/incomplete_details/reason"))
            .and_then(Value::as_str)
            .map(str::trim)
            .is_some_and(|value| !value.is_empty())
        {
            return Ok(V3ProviderResponsesJsonFrameOutcome::Terminal);
        }
    }

    if matches!(
        event_type,
        "response.failed" | "response.incomplete" | "response.cancelled" | "response.canceled"
    ) {
        let error = event
            .pointer("/response/error")
            .or_else(|| event.get("error"))
            .and_then(Value::as_object)
            .ok_or_else(|| format!("{event_type} requires a response error object"))?;
        let code = error
            .get("code")
            .or_else(|| error.get("type"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("{event_type} requires a non-empty error code"))?;
        let message = error
            .get("message")
            .or_else(|| error.get("detail"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("{event_type} requires a non-empty error message"))?;
        return Ok(V3ProviderResponsesJsonFrameOutcome::Failure {
            code: code.to_string(),
            message: message.to_string(),
        });
    }

    if event_type == "response.completed" {
        return Ok(if response_terminal_has_client_output(event)? {
            V3ProviderResponsesJsonFrameOutcome::Terminal
        } else {
            V3ProviderResponsesJsonFrameOutcome::TerminalWithoutOutput
        });
    }
    if matches!(event_type, "response.created" | "response.in_progress") {
        return Ok(V3ProviderResponsesJsonFrameOutcome::ContinueBuffering);
    }
    if matches!(
        event_type,
        "response.output_item.added" | "response.output_item.done"
    ) {
        let item = event
            .get("item")
            .ok_or_else(|| format!("{event_type} requires an item object"))?;
        return Ok(if response_output_item_has_client_output(item)? {
            V3ProviderResponsesJsonFrameOutcome::StartClientStream
        } else {
            V3ProviderResponsesJsonFrameOutcome::ContinueBuffering
        });
    }
    if matches!(
        event_type,
        "response.content_part.added" | "response.content_part.done"
    ) {
        let part = event
            .get("part")
            .ok_or_else(|| format!("{event_type} requires a part object"))?;
        return Ok(if response_message_part_has_client_output(part)? {
            V3ProviderResponsesJsonFrameOutcome::StartClientStream
        } else {
            V3ProviderResponsesJsonFrameOutcome::ContinueBuffering
        });
    }
    if matches!(
        event_type,
        "response.output_text.delta"
            | "response.output_text.done"
            | "response.refusal.delta"
            | "response.refusal.done"
            | "response.reasoning_text.delta"
            | "response.reasoning_text.done"
            | "response.reasoning_summary_text.delta"
            | "response.reasoning_summary_text.done"
            | "response.function_call_arguments.delta"
            | "response.function_call_arguments.done"
            | "response.custom_tool_call_input.delta"
            | "response.custom_tool_call_input.done"
            | "response.mcp_call.arguments.delta"
            | "response.mcp_call.arguments.done"
            | "response.code_interpreter_call_code.delta"
            | "response.code_interpreter_call_code.done"
            | "response.audio.delta"
            | "response.audio_transcript.delta"
            | "response.audio_transcript.done"
    ) {
        let has_output = [
            "delta",
            "text",
            "refusal",
            "arguments",
            "input",
            "code",
            "transcript",
        ]
        .iter()
        .any(|field| has_non_empty_string(event.get(*field)));
        return Ok(if has_output {
            V3ProviderResponsesJsonFrameOutcome::StartClientStream
        } else {
            V3ProviderResponsesJsonFrameOutcome::ContinueBuffering
        });
    }
    if event_type == "response.requires_action" {
        if event.get("required_action").is_none()
            && event.pointer("/response/required_action").is_none()
        {
            return Err("response.requires_action requires required_action".to_string());
        }
        return Ok(V3ProviderResponsesJsonFrameOutcome::StartClientStream);
    }
    if matches!(
        event_type,
        "response.reasoning_signature.delta"
            | "response.reasoning_image.delta"
            | "response.reasoning_summary_part.added"
            | "response.reasoning_summary_part.done"
            | "response.output_text.annotation.added"
            | "response.web_search_call.in_progress"
            | "response.web_search_call.searching"
            | "response.web_search_call.completed"
            | "response.file_search_call.in_progress"
            | "response.file_search_call.searching"
            | "response.file_search_call.completed"
            | "response.mcp_call.in_progress"
            | "response.mcp_call.completed"
            | "response.computer_call.in_progress"
            | "response.computer_call_output.in_progress"
            | "response.computer_call_output.completed"
            | "response.code_interpreter_call.in_progress"
            | "response.code_interpreter_call.completed"
            | "response.image_generation_call.in_progress"
            | "response.image_generation_call.partial_image"
            | "response.image_generation_call.completed"
            | "response.audio.done"
            | "response.done"
    ) {
        return Ok(V3ProviderResponsesJsonFrameOutcome::ContinueBuffering);
    }
    Err(format!(
        "provider Responses SSE event type {event_type:?} is not registered"
    ))
}

fn response_terminal_has_client_output(event: &Value) -> Result<bool, String> {
    let output = event
        .pointer("/response/output")
        .or_else(|| event.get("output"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut has_output = false;
    for item in output {
        has_output |= response_output_item_has_client_output(item)?;
    }
    Ok(has_output)
}

fn response_output_item_has_client_output(item: &Value) -> Result<bool, String> {
    let item = item
        .as_object()
        .ok_or_else(|| "provider Responses output item must be an object".to_string())?;
    match item.get("type").and_then(Value::as_str) {
        Some("message") => {
            let content = item
                .get("content")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    "provider Responses message output requires content array".to_string()
                })?;
            let mut has_output = false;
            for part in content {
                has_output |= response_message_part_has_client_output(part)?;
            }
            Ok(has_output)
        }
        Some("reasoning") => {
            let mut has_output = has_non_empty_string(item.get("encrypted_content"));
            for field in ["content", "summary"] {
                let Some(parts) = item.get(field) else {
                    continue;
                };
                let parts = parts.as_array().ok_or_else(|| {
                    format!("provider Responses reasoning output requires {field} array")
                })?;
                for part in parts {
                    has_output |= response_reasoning_part_has_client_output(part)?;
                }
            }
            Ok(has_output)
        }
        Some("output_text") => {
            let text = item.get("text").and_then(Value::as_str).ok_or_else(|| {
                "provider Responses output_text item requires string field text".to_string()
            })?;
            Ok(!text.trim().is_empty())
        }
        Some("refusal") => {
            let refusal = item.get("refusal").and_then(Value::as_str).ok_or_else(|| {
                "provider Responses refusal item requires string field refusal".to_string()
            })?;
            Ok(!refusal.trim().is_empty())
        }
        Some("function_call") => {
            require_non_empty_output_string(item, "function_call", "call_id")?;
            require_non_empty_output_string(item, "function_call", "name")?;
            require_output_string(item, "function_call", "arguments")?;
            Ok(true)
        }
        Some("custom_tool_call") => {
            require_non_empty_output_string(item, "custom_tool_call", "call_id")?;
            require_non_empty_output_string(item, "custom_tool_call", "name")?;
            require_output_string(item, "custom_tool_call", "input")?;
            Ok(true)
        }
        Some("tool_search_call") => {
            require_non_empty_output_string(item, "tool_search_call", "call_id")?;
            if !item.get("arguments").is_some_and(Value::is_object) {
                return Err(
                    "provider Responses tool_search_call output requires arguments object"
                        .to_string(),
                );
            }
            Ok(true)
        }
        Some("web_search_call" | "file_search_call" | "mcp_call" | "computer_call") => {
            Ok(["id", "call_id"]
                .iter()
                .any(|field| has_non_empty_string(item.get(*field))))
        }
        Some(output_type) => Err(format!(
            "provider Responses output item type {output_type:?} is not registered"
        )),
        None => Err("provider Responses output item requires a non-empty type".to_string()),
    }
}

pub(crate) fn is_v3_provider_sse_transport_keepalive_data(data: &str) -> bool {
    is_v3_provider_sse_keepalive_text(data)
        || serde_json::from_str::<Value>(data.trim())
            .ok()
            .is_some_and(|value| value.is_null())
}

fn response_message_part_has_client_output(part: &Value) -> Result<bool, String> {
    if let Some(text) = part.as_str() {
        return Ok(!text.trim().is_empty());
    }
    let part = part
        .as_object()
        .ok_or_else(|| "provider Responses message content part must be an object".to_string())?;
    let part_type = part
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "provider Responses message content part requires type".to_string())?;
    let field = match part_type {
        "output_text" | "reasoning_text" | "summary_text" => "text",
        "refusal" => "refusal",
        "output_audio" => "transcript",
        other => {
            return Err(format!(
                "provider Responses message content part type {other:?} is not registered"
            ));
        }
    };
    let text = part.get(field).and_then(Value::as_str).ok_or_else(|| {
        format!("provider Responses {part_type} content part requires string field {field}")
    })?;
    Ok(!text.trim().is_empty())
}

fn response_reasoning_part_has_client_output(part: &Value) -> Result<bool, String> {
    let part = part
        .as_object()
        .ok_or_else(|| "provider Responses reasoning content part must be an object".to_string())?;
    let part_type = part
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "provider Responses reasoning content part requires type".to_string())?;
    if !matches!(part_type, "reasoning_text" | "summary_text") {
        return Err(format!(
            "provider Responses reasoning content part type {part_type:?} is not registered"
        ));
    }
    let text = part.get("text").and_then(Value::as_str).ok_or_else(|| {
        format!("provider Responses {part_type} content part requires string field text")
    })?;
    Ok(!text.trim().is_empty())
}

fn require_non_empty_output_string(
    item: &serde_json::Map<String, Value>,
    output_type: &str,
    field: &str,
) -> Result<(), String> {
    if !has_non_empty_string(item.get(field)) {
        return Err(format!(
            "provider Responses {output_type} output requires non-empty {field}"
        ));
    }
    Ok(())
}

fn require_output_string(
    item: &serde_json::Map<String, Value>,
    output_type: &str,
    field: &str,
) -> Result<(), String> {
    if item.get(field).and_then(Value::as_str).is_none() {
        return Err(format!(
            "provider Responses {output_type} output requires string field {field}"
        ));
    }
    Ok(())
}

fn classify_v3_provider_anthropic_json_event(
    event: &Value,
) -> Result<V3ProviderResponsesJsonFrameOutcome, String> {
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "provider Anthropic SSE event requires a non-empty type".to_string())?;
    match event_type {
        "error" => classify_provider_error_object(event, "anthropic_provider_error"),
        "message_start" => {
            let message = event
                .get("message")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    "provider Anthropic message_start requires message object".to_string()
                })?;
            let content = message
                .get("content")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    "provider Anthropic message_start requires content array".to_string()
                })?;
            let mut has_output = false;
            for block in content {
                has_output |= anthropic_content_block_has_client_output(block)?;
            }
            Ok(if has_output {
                V3ProviderResponsesJsonFrameOutcome::StartClientStream
            } else {
                V3ProviderResponsesJsonFrameOutcome::ContinueBuffering
            })
        }
        "content_block_start" => {
            let block = event.get("content_block").ok_or_else(|| {
                "provider Anthropic content_block_start requires content_block object".to_string()
            })?;
            Ok(if anthropic_content_block_has_client_output(block)? {
                V3ProviderResponsesJsonFrameOutcome::StartClientStream
            } else {
                V3ProviderResponsesJsonFrameOutcome::ContinueBuffering
            })
        }
        "content_block_delta" => {
            let delta = event
                .get("delta")
                .and_then(Value::as_object)
                .ok_or_else(|| {
                    "provider Anthropic content_block_delta requires delta object".to_string()
                })?;
            let delta_type = delta.get("type").and_then(Value::as_str).ok_or_else(|| {
                "provider Anthropic content_block_delta requires delta.type".to_string()
            })?;
            let has_output = match delta_type {
                "text_delta" => has_string(delta.get("text"))?,
                "thinking_delta" => {
                    has_string(delta.get("thinking").or_else(|| delta.get("text")))?
                }
                "input_json_delta" => has_string(delta.get("partial_json"))?,
                "signature_delta" => has_string(delta.get("signature"))?,
                "citations_delta" => delta.get("citation").is_some(),
                other => {
                    return Err(format!(
                        "provider Anthropic content_block_delta type {other:?} is not registered"
                    ));
                }
            };
            Ok(if has_output {
                V3ProviderResponsesJsonFrameOutcome::StartClientStream
            } else {
                V3ProviderResponsesJsonFrameOutcome::ContinueBuffering
            })
        }
        "content_block_stop" | "message_delta" => {
            Ok(V3ProviderResponsesJsonFrameOutcome::ContinueBuffering)
        }
        "message_stop" => Ok(V3ProviderResponsesJsonFrameOutcome::TerminalWithoutOutput),
        "ping" => Err("provider Anthropic ping must be classified as keepalive".to_string()),
        other => Err(format!(
            "provider Anthropic SSE event type {other:?} is not registered"
        )),
    }
}

fn anthropic_content_block_has_client_output(block: &Value) -> Result<bool, String> {
    let block = block
        .as_object()
        .ok_or_else(|| "provider Anthropic content block must be an object".to_string())?;
    let block_type = block
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "provider Anthropic content block requires type".to_string())?;
    match block_type {
        "text" => has_string(block.get("text")),
        "thinking" => {
            let has_thinking = has_string(block.get("thinking"))?;
            let has_signature = match block.get("signature") {
                Some(signature) => has_string(Some(signature))?,
                None => false,
            };
            Ok(has_thinking || has_signature)
        }
        "redacted_thinking" => has_string(block.get("data")),
        "tool_use" => {
            if !has_non_empty_string(block.get("id")) || !has_non_empty_string(block.get("name")) {
                return Err(
                    "provider Anthropic tool_use block requires non-empty id and name".to_string(),
                );
            }
            Ok(true)
        }
        other => Err(format!(
            "provider Anthropic content block type {other:?} is not registered"
        )),
    }
}

fn classify_v3_provider_openai_chat_json_event(
    event: &Value,
) -> Result<V3ProviderResponsesJsonFrameOutcome, String> {
    if event.get("error").is_some() {
        return classify_provider_error_object(event, "openai_chat_provider_error");
    }
    if event.get("object").and_then(Value::as_str) != Some("chat.completion.chunk") {
        return Err(
            "provider OpenAI Chat SSE event requires object=chat.completion.chunk".to_string(),
        );
    }
    let choices = event
        .get("choices")
        .and_then(Value::as_array)
        .ok_or_else(|| "provider OpenAI Chat SSE event requires choices array".to_string())?;
    let mut has_output = false;
    let mut terminal = false;
    for choice in choices {
        let choice = choice
            .as_object()
            .ok_or_else(|| "provider OpenAI Chat choice must be an object".to_string())?;
        if let Some(finish_reason) = choice.get("finish_reason") {
            if !finish_reason.is_null() {
                if !has_non_empty_string(Some(finish_reason)) {
                    return Err(
                        "provider OpenAI Chat finish_reason must be a non-empty string".to_string(),
                    );
                }
                terminal = true;
            }
        }
        if let Some(delta) = choice.get("delta") {
            let delta = delta
                .as_object()
                .ok_or_else(|| "provider OpenAI Chat choice delta must be an object".to_string())?;
            has_output |= ["content", "reasoning_content", "reasoning"]
                .iter()
                .any(|field| has_non_empty_string(delta.get(*field)));
            if let Some(tool_calls) = delta.get("tool_calls") {
                let tool_calls = tool_calls.as_array().ok_or_else(|| {
                    "provider OpenAI Chat delta.tool_calls must be an array".to_string()
                })?;
                has_output |= !tool_calls.is_empty();
            }
            if let Some(function_call) = delta.get("function_call") {
                let function_call = function_call.as_object().ok_or_else(|| {
                    "provider OpenAI Chat delta.function_call must be an object".to_string()
                })?;
                has_output |= ["name", "arguments"]
                    .iter()
                    .any(|field| has_non_empty_string(function_call.get(*field)));
            }
        }
    }
    Ok(match (has_output, terminal) {
        (true, true) => V3ProviderResponsesJsonFrameOutcome::Terminal,
        (false, true) => V3ProviderResponsesJsonFrameOutcome::TerminalWithoutOutput,
        (true, false) => V3ProviderResponsesJsonFrameOutcome::StartClientStream,
        (false, false) => V3ProviderResponsesJsonFrameOutcome::ContinueBuffering,
    })
}

fn classify_provider_error_object(
    event: &Value,
    default_code: &str,
) -> Result<V3ProviderResponsesJsonFrameOutcome, String> {
    let error = event
        .get("error")
        .and_then(Value::as_object)
        .ok_or_else(|| "provider SSE error event requires error object".to_string())?;
    let code = error
        .get("code")
        .or_else(|| error.get("type"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default_code);
    let message = error
        .get("message")
        .or_else(|| error.get("detail"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "provider SSE error event requires a non-empty message".to_string())?;
    Ok(V3ProviderResponsesJsonFrameOutcome::Failure {
        code: code.to_string(),
        message: message.to_string(),
    })
}

fn has_string(value: Option<&Value>) -> Result<bool, String> {
    value
        .map(|value| {
            value
                .as_str()
                .map(|value| !value.is_empty())
                .ok_or_else(|| "provider SSE output field must be a string".to_string())
        })
        .unwrap_or_else(|| Err("provider SSE output field is missing".to_string()))
}

fn has_non_empty_string(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
}

pub(crate) fn record_v3_provider_sse_json_frame(
    fields: &[SseField],
    stream_observation: &V3RuntimeStreamObservation,
) -> Result<(), String> {
    let data = collect_v3_provider_sse_json_data(fields);
    // keepalive 文本（`data: ping` 等）不是 JSON 载荷：观测直接放行，
    // 否则 usage 观测会把保活帧打成 provider SSE event invalid。
    if is_v3_provider_sse_keepalive_text(&data) {
        return Ok(());
    }
    let Some(event) = parse_v3_provider_sse_json_data(&data)? else {
        return Ok(());
    };
    if let Some(field) =
        routecodex_v3_provider_responses::find_v3_routecodex_control_payload_key(&event)
    {
        return Err(format!(
            "provider SSE event carries RouteCodex control payload key {field:?}"
        ));
    }
    stream_observation.record_provider_event_json(&event)
}

#[cfg(test)]
mod provider_sse_json_codec_tests {
    use super::super::V3HubProviderWireProtocol;
    use super::*;

    #[test]
    fn responses_precommit_classification_is_protocol_owned() {
        let classify = |data| {
            classify_v3_provider_sse_json_data(V3HubProviderWireProtocol::Responses, data)
                .expect("Responses frame must classify")
        };
        assert_eq!(
            classify(r#"{"type":"response.created","response":{"id":"resp_1","output":[]}}"#),
            Some(V3ProviderResponsesJsonFrameOutcome::ContinueBuffering)
        );
        assert_eq!(
            classify(r#"{"type":"response.output_text.delta","delta":"hello"}"#),
            Some(V3ProviderResponsesJsonFrameOutcome::StartClientStream)
        );
        assert_eq!(
            classify(r#"{"type":"response.completed","response":{"id":"resp_1","output":[]}}"#),
            Some(V3ProviderResponsesJsonFrameOutcome::TerminalWithoutOutput)
        );
        assert_eq!(
            classify(r#"{"type":"response.completed","response":{"id":"resp_1"}}"#),
            Some(V3ProviderResponsesJsonFrameOutcome::TerminalWithoutOutput)
        );
        assert_eq!(
            classify(
                r#"{"type":"response.completed","response":{"id":"resp_1","output":[{"type":"output_text","text":"done"}]}}"#
            ),
            Some(V3ProviderResponsesJsonFrameOutcome::Terminal)
        );
        assert_eq!(
            classify(
                r#"{"type":"response.completed","response":{"id":"resp_1","output":[{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{}"}]}}"#
            ),
            Some(V3ProviderResponsesJsonFrameOutcome::Terminal)
        );
        assert_eq!(
            classify(
                r#"{"type":"response.error","error":{"code":"upstream_error","message":"bad upstream"}}"#
            ),
            Some(V3ProviderResponsesJsonFrameOutcome::Failure {
                code: "upstream_error".to_string(),
                message: "bad upstream".to_string(),
            })
        );
        assert_eq!(classify("ping"), None);
    }

    #[test]
    fn non_object_json_frames_are_transport_only_for_precommit() {
        for data in [r#"null"#, r#""provider-control""#, r#"["provider-control"]"#] {
            let outcome = classify_v3_provider_sse_json_data(
                V3HubProviderWireProtocol::Responses,
                data,
            )
            .expect("non-object transport frame must not be a semantic error");
            assert_eq!(outcome, None, "unexpected semantic outcome for {data}");
        }
    }

    #[test]
    fn responses_reasoning_content_part_events_are_registered() {
        let classify = |data| {
            classify_v3_provider_sse_json_data(V3HubProviderWireProtocol::Responses, data)
                .expect("Responses reasoning content part must classify")
        };
        assert_eq!(
            classify(
                r#"{"type":"response.content_part.added","part":{"type":"reasoning_text","text":"thinking"}}"#
            ),
            Some(V3ProviderResponsesJsonFrameOutcome::StartClientStream)
        );
        assert_eq!(
            classify(
                r#"{"type":"response.content_part.added","part":{"type":"summary_text","text":"summary"}}"#
            ),
            Some(V3ProviderResponsesJsonFrameOutcome::StartClientStream)
        );
        assert_eq!(
            classify(
                r#"{"type":"response.content_part.added","part":{"type":"reasoning_text","text":""}}"#
            ),
            Some(V3ProviderResponsesJsonFrameOutcome::ContinueBuffering)
        );
    }

    #[test]
    fn responses_ping_event_is_keepalive() {
        assert_eq!(
            classify_v3_provider_sse_json_data(
                V3HubProviderWireProtocol::Responses,
                r#"{"type":"ping"}"#,
            )
            .expect("Responses ping must remain a keepalive"),
            None
        );
    }

    #[test]
    fn responses_reasoning_text_terminal_regression_is_registered() {
        let reasoning_item = r#"{"type":"reasoning","id":"reasoning_1","status":"incomplete","content":[{"type":"reasoning_text","text":"We need answer exactly."}],"summary":[],"encrypted_content":"cipher-1"}"#;
        let item_done = format!(
            r#"{{"type":"response.output_item.done","output_index":0,"item":{reasoning_item}}}"#
        );
        assert_eq!(
            classify_v3_provider_sse_json_data(V3HubProviderWireProtocol::Responses, &item_done,)
                .expect("reasoning_text output item must remain a registered Responses event"),
            Some(V3ProviderResponsesJsonFrameOutcome::StartClientStream)
        );

        let completed = format!(
            r#"{{"type":"response.completed","response":{{"id":"resp_reasoning","status":"completed","output":[{reasoning_item}]}}}}"#
        );
        assert_eq!(
            classify_v3_provider_sse_json_data(V3HubProviderWireProtocol::Responses, &completed,)
                .expect(
                    "reasoning_text terminal must not become provider_response_sse_event_invalid"
                ),
            Some(V3ProviderResponsesJsonFrameOutcome::Terminal)
        );
    }

    #[test]
    fn anthropic_precommit_classification_is_protocol_owned() {
        let classify = |data| {
            classify_v3_provider_sse_json_data(V3HubProviderWireProtocol::Anthropic, data)
                .expect("Anthropic frame must classify")
        };
        assert_eq!(
            classify(
                r#"{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[]}}"#
            ),
            Some(V3ProviderResponsesJsonFrameOutcome::ContinueBuffering)
        );
        assert_eq!(
            classify(
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}"#
            ),
            Some(V3ProviderResponsesJsonFrameOutcome::StartClientStream)
        );
        assert_eq!(
            classify(r#"{"type":"message_stop"}"#),
            Some(V3ProviderResponsesJsonFrameOutcome::TerminalWithoutOutput)
        );
        assert_eq!(
            classify(
                r#"{"type":"error","error":{"type":"overloaded_error","message":"try later"}}"#
            ),
            Some(V3ProviderResponsesJsonFrameOutcome::Failure {
                code: "overloaded_error".to_string(),
                message: "try later".to_string(),
            })
        );
        assert_eq!(classify(r#"{"type":"ping"}"#), None);
    }

    #[test]
    fn openai_chat_precommit_classification_is_protocol_owned() {
        let classify = |data| {
            classify_v3_provider_sse_json_data(V3HubProviderWireProtocol::OpenAiChat, data)
                .expect("OpenAI Chat frame must classify")
        };
        assert_eq!(
            classify(
                r#"{"id":"chatcmpl_1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}"#
            ),
            Some(V3ProviderResponsesJsonFrameOutcome::ContinueBuffering)
        );
        assert_eq!(
            classify(
                r#"{"id":"chatcmpl_1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}"#
            ),
            Some(V3ProviderResponsesJsonFrameOutcome::StartClientStream)
        );
        assert_eq!(
            classify(
                r#"{"id":"chatcmpl_1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#
            ),
            Some(V3ProviderResponsesJsonFrameOutcome::TerminalWithoutOutput)
        );
        assert_eq!(
            classify(r#"{"error":{"code":"rate_limit","message":"slow down"}}"#),
            Some(V3ProviderResponsesJsonFrameOutcome::Failure {
                code: "rate_limit".to_string(),
                message: "slow down".to_string(),
            })
        );
        assert_eq!(
            classify(r#"{"id":"chatcmpl_1","object":"chat.completion.chunk","choices":[]}"#),
            None
        );
    }

    #[test]
    fn protocol_classifier_rejects_foreign_event_shapes_without_reclassification() {
        let error = classify_v3_provider_sse_json_data(
            V3HubProviderWireProtocol::Responses,
            r#"{"type":"message_start","message":{"content":[]}}"#,
        )
        .expect_err("Anthropic frame must not be reclassified on a Responses direct path");
        assert!(error.contains("Responses"), "unexpected error: {error}");

        let error = classify_v3_provider_sse_json_data(
            V3HubProviderWireProtocol::Anthropic,
            r#"{"type":"response.output_text.delta","delta":"foreign"}"#,
        )
        .expect_err("Responses frame must not be reclassified on an Anthropic direct path");
        assert!(error.contains("Anthropic"), "unexpected error: {error}");

        let error = classify_v3_provider_sse_json_data(
            V3HubProviderWireProtocol::OpenAiChat,
            r#"{"type":"response.output_text.delta","delta":"foreign"}"#,
        )
        .expect_err("Responses frame must not be reclassified on a Chat direct path");
        assert!(error.contains("OpenAI Chat"), "unexpected error: {error}");
    }

    #[test]
    fn json_type_is_the_only_semantic_source() {
        let outcome = classify_v3_provider_sse_json_data(
            V3HubProviderWireProtocol::Responses,
            r#"{"type":"response.completed","response":{"id":"resp_1","output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}]}}"#,
        )
        .expect("JSON type must classify terminal data");
        assert_eq!(outcome, Some(V3ProviderResponsesJsonFrameOutcome::Terminal));
    }

    #[test]
    fn json_error_events_are_provider_failures_before_stream_commit() {
        for event_type in ["error", "response.error"] {
            let data = format!(
                r#"{{"type":"{event_type}","error":{{"code":"upstream_error","message":"bad upstream"}}}}"#
            );
            assert_eq!(
                classify_v3_provider_sse_json_data(V3HubProviderWireProtocol::Responses, &data)
                    .expect("JSON error event must classify"),
                Some(V3ProviderResponsesJsonFrameOutcome::Failure {
                    code: "upstream_error".to_string(),
                    message: "bad upstream".to_string(),
                })
            );
        }
    }

    #[test]
    fn json_ping_event_is_transport_keepalive() {
        assert_eq!(
            classify_v3_provider_sse_json_data(
                V3HubProviderWireProtocol::Responses,
                r#"{"type":"ping"}"#,
            )
            .expect("JSON ping must remain a keepalive"),
            None,
        );
    }

    #[test]
    fn empty_output_item_lifecycle_frames_do_not_authorize_client_commit() {
        for data in [
            r#"{"type":"response.output_item.added","output_index":0,"item":{"type":"message","status":"in_progress","content":[]}}"#,
            r#"{"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","status":"in_progress","content":[],"summary":[]}}"#,
        ] {
            assert_eq!(
                classify_v3_provider_sse_json_data(V3HubProviderWireProtocol::Responses, data)
                    .expect("empty lifecycle frame must classify"),
                Some(V3ProviderResponsesJsonFrameOutcome::ContinueBuffering),
                "empty output item must remain precommit: {data}"
            );
        }
    }

    #[test]
    fn non_empty_output_items_remain_client_commit_authority() {
        for data in [
            r#"{"type":"response.output_item.added","output_index":0,"item":{"type":"message","status":"in_progress","content":[{"type":"output_text","text":"hello"}]}}"#,
            r#"{"type":"response.output_item.added","output_index":0,"item":{"type":"function_call","status":"in_progress","call_id":"call_1","name":"tool","arguments":""}}"#,
        ] {
            assert_eq!(
                classify_v3_provider_sse_json_data(V3HubProviderWireProtocol::Responses, data)
                    .expect("non-empty output item must classify"),
                Some(V3ProviderResponsesJsonFrameOutcome::StartClientStream),
                "business output must authorize streaming: {data}"
            );
        }
    }

    #[test]
    fn response_incomplete_with_reason_is_terminal_not_provider_failure() {
        for reason in ["max_output_tokens", "content_filter"] {
            let data = format!(
                r#"{{"type":"response.incomplete","response":{{"id":"resp_1","status":"incomplete","incomplete_details":{{"reason":"{reason}"}}}}}}"#
            );
            let outcome =
                classify_v3_provider_sse_json_data(V3HubProviderWireProtocol::Responses, &data)
                    .expect("response.incomplete with reason must classify");
            assert_eq!(
                outcome,
                Some(V3ProviderResponsesJsonFrameOutcome::Terminal),
                "response.incomplete is a valid terminal, not a provider failure: {data}"
            );
        }
    }

    #[test]
    fn response_incomplete_without_reason_still_fails_fast() {
        let error = classify_v3_provider_sse_json_data(
            V3HubProviderWireProtocol::Responses,
            r#"{"type":"response.incomplete","response":{"id":"resp_1","status":"incomplete"}}"#,
        )
        .expect_err("response.incomplete without incomplete_details.reason is malformed");
        assert!(
            error.contains("response.incomplete"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn missing_type_without_frame_event_still_fails_fast() {
        let error = classify_v3_provider_sse_json_data(
            V3HubProviderWireProtocol::Responses,
            r#"{"id":"resp_1"}"#,
        )
        .expect_err("data without type must fail fast");
        assert!(
            error.contains("requires a non-empty type"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn protocol_classifier_accepts_openai_chat_chunk_without_type() {
        let outcome = classify_v3_provider_sse_json_data(
            V3HubProviderWireProtocol::OpenAiChat,
            r#"{"id":"chatcmpl_1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}"#,
        )
        .expect("OpenAI Chat chunks do not require a Responses type");
        assert_eq!(
            outcome,
            Some(V3ProviderResponsesJsonFrameOutcome::StartClientStream)
        );
    }

    #[test]
    fn protocol_classifier_treats_empty_choices_chat_chunk_as_keepalive() {
        let outcome = classify_v3_provider_sse_json_data(
            V3HubProviderWireProtocol::OpenAiChat,
            r#"{"id":"chatcmpl_1","object":"chat.completion.chunk","choices":[]}"#,
        )
        .expect("empty-choices settlement chunk must classify");
        assert_eq!(
            outcome, None,
            "empty choices carries no content/usage semantics and is keepalive-only"
        );
    }

    #[test]
    fn protocol_classifier_rejects_unrecognized_json_without_type() {
        let error = classify_v3_provider_sse_json_data(
            V3HubProviderWireProtocol::Responses,
            r#"{"id":"resp_1"}"#,
        )
        .expect_err("Responses provider JSON must have a type");
        assert!(error.contains("Responses"));
    }

    #[test]
    fn protocol_classifier_rejects_malformed_chat_choices_shape() {
        for payload in [
            r#"{"object":"chat.completion.chunk","choices":null}"#,
            r#"{"object":"chat.completion.chunk","choices":{}}"#,
        ] {
            let error =
                classify_v3_provider_sse_json_data(V3HubProviderWireProtocol::OpenAiChat, payload)
                    .expect_err("malformed Chat choices must fail before stream commit");
            assert!(error.contains("choices array"));
        }
    }

    #[test]
    fn string_value_raw_control_characters_are_repaired_not_rejected() {
        // SSE 多行 data 拼接后字符串值内的原始换行/控制字符（reasoning 文本
        // 常见形态）：修复转义后必须解析成功且值语义不变。
        let data = "{\"type\":\"response.output_text.delta\",\"delta\":\"first line\nsecond\tline\u{1}tail\"}";
        let value = parse_v3_provider_sse_json_data(data)
            .expect("string-value raw control characters must be repaired");
        assert_eq!(value.unwrap()["delta"], "first line\nsecond\tline\u{1}tail");
    }

    #[test]
    fn raw_control_characters_inside_multi_line_data_frame_are_repaired() {
        // 上游把字符串内换行未转义发成多行 SSE data（join 后 line 2 开头
        // 在字符串值内）——网关必须修复而不是拒绝。
        let data = "{\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"reasoning\":\"plan\nstep two\"}}";
        let value = parse_v3_provider_sse_json_data(data)
            .expect("multi-line data frame with raw newline inside string must be repaired");
        assert_eq!(
            value.unwrap().pointer("/response/reasoning").unwrap(),
            "plan\nstep two"
        );
    }

    #[test]
    fn provider_json_continuation_without_data_prefix_is_preserved() {
        let fields = vec![
            SseField::Named {
                name: "data".to_string(),
                value: r#"{"type":"response.output_text.delta","delta":"first"#.to_string(),
            },
            SseField::Named {
                name: r#"second"}"#.to_string(),
                value: String::new(),
            },
        ];
        let data = collect_v3_provider_sse_json_data(&fields);
        let value = parse_v3_provider_sse_json_data(&data)
            .expect("JSON continuation without data prefix must be recoverable")
            .expect("continuation must contain an event");
        assert_eq!(value["delta"], "first\nsecond");
    }

    #[test]
    fn ordinary_unknown_sse_field_is_not_promoted_to_provider_json() {
        let fields = vec![
            SseField::Named {
                name: "event".to_string(),
                value: "response.output_text.delta".to_string(),
            },
            SseField::Named {
                name: "data".to_string(),
                value: r#"{"type":"response.completed"}"#.to_string(),
            },
            SseField::Named {
                name: "id".to_string(),
                value: "provider-event-1".to_string(),
            },
        ];
        assert_eq!(
            collect_v3_provider_sse_json_data(&fields),
            r#"{"type":"response.completed"}"#
        );
    }

    #[test]
    fn responses_event_name_recovers_missing_json_type_before_precommit() {
        let fields = vec![
            SseField::Named {
                name: "event".to_owned(),
                value: "response.output_text.delta".to_owned(),
            },
            SseField::Named {
                name: "data".to_owned(),
                value: r#"{"delta":"recovered"}"#.to_owned(),
            },
        ];
        let data = normalize_v3_provider_sse_json_data_for_event_name(
            V3HubProviderWireProtocol::Responses,
            &fields,
        )
        .expect("registered SSE event name must recover missing type");
        assert_eq!(
            classify_v3_provider_sse_json_data(V3HubProviderWireProtocol::Responses, &data)
                .expect("recovered Responses frame must classify"),
            Some(V3ProviderResponsesJsonFrameOutcome::StartClientStream)
        );
        assert!(data.contains(r#""type":"response.output_text.delta""#));
    }

    #[test]
    fn responses_payload_event_field_recovers_missing_json_type() {
        let data = normalize_v3_provider_sse_json_data_with_event_name(
            V3HubProviderWireProtocol::Responses,
            r#"{"event":"response.output_text.delta","delta":"recovered"}"#,
            None,
        )
        .expect("registered payload event name must recover missing type");
        assert_eq!(
            classify_v3_provider_sse_json_data(V3HubProviderWireProtocol::Responses, &data)
                .expect("recovered Responses frame must classify"),
            Some(V3ProviderResponsesJsonFrameOutcome::StartClientStream)
        );
    }

    #[test]
    fn responses_function_call_object_arguments_are_projected_as_json_string() {
        let data = normalize_v3_provider_sse_json_data_with_event_name(
            V3HubProviderWireProtocol::Responses,
            r#"{"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","name":"exec_command","arguments":{"cmd":"pwd"}}}"#,
            None,
        )
        .expect("structured function arguments must be normalized");
        let value: Value = serde_json::from_str(&data).expect("normalized JSON");
        assert_eq!(value["item"]["arguments"], r#"{"cmd":"pwd"}"#);
        assert!(classify_v3_provider_sse_json_data(V3HubProviderWireProtocol::Responses, &data)
            .expect("normalized function_call must classify")
            .is_some());
    }

    #[test]
    fn garbage_without_any_complete_json_still_fails_fast() {
        // 没有完整 JSON 的纯垃圾（含控制字符）不得被吞掉：整体兼容只容忍
        // "完整 JSON + 尾随噪声"，纯噪声仍 fail-fast。
        let error = parse_v3_provider_sse_json_data("\u{1}not json at all")
            .expect_err("garbage without any JSON must still fail");
        assert!(error.contains("malformed"));
        let error = parse_v3_provider_sse_json_data("{\"a\":1")
            .expect_err("unterminated JSON without a complete value must still fail");
        assert!(error.contains("malformed"));
    }

    #[test]
    fn escaped_sequences_are_not_double_escaped() {
        // 已转义的 \\n 文本（反斜杠+n，无控制字节）不得被再次转义。
        let data = r#"{"type":"response.output_text.delta","delta":"a\\nb"}"#;
        let value =
            parse_v3_provider_sse_json_data(data).expect("escaped sequences must parse untouched");
        assert_eq!(value.unwrap()["delta"], "a\\nb");
    }

    #[test]
    fn trailing_data_after_complete_json_is_not_silently_discarded() {
        // 一帧 data 的完整语义必须整体判定。首行完整 JSON 后的第二行不能被
        // 当作“噪声”丢掉，否则 client 看不到的事件会被错误地当成成功。
        let data = "{\"type\":\"response.completed\",\"response\":{\"status\":\"completed\"}}\n\ngarbage tail";
        let error = parse_v3_provider_sse_json_data(data)
            .expect_err("trailing data must remain a retryable malformed-frame error");
        assert!(error.contains("malformed"), "unexpected error: {error}");
    }

    #[test]
    fn multiple_json_objects_are_not_reduced_to_the_first_event() {
        // 不能选择第一个对象并忽略第二个对象；现有单值接口必须显式拒绝，
        // 由 Direct 的未提交尝试重试，而不是伪造一个不完整的成功流。
        let data = "{\"type\":\"response.completed\"}\n{\"type\":\"response.created\"}";
        let error = parse_v3_provider_sse_json_data(data)
            .expect_err("a multi-object frame cannot drop its second event");
        assert!(error.contains("malformed"), "unexpected error: {error}");
    }

    #[test]
    fn trailing_garbage_with_control_characters_remains_unrecoverable() {
        // 字符串内控制字符可规范化，但结构性尾随残片没有无损解释，不能借
        // “兼容”丢掉残片。
        let data = "{\"type\":\"response.output_text.delta\",\"delta\":\"line\u{1}two\"}\ntail";
        let error = parse_v3_provider_sse_json_data(data)
            .expect_err("tail must remain visible as a malformed frame");
        assert!(error.contains("malformed"), "unexpected error: {error}");
    }
}

use routecodex_v3_sse::SseField;
use serde_json::Value;

use super::V3RuntimeStreamObservation;

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

pub(crate) fn classify_v3_provider_responses_json_data(
    data: &str,
) -> Result<Option<V3ProviderResponsesJsonFrameOutcome>, String> {
    let Some(event) = parse_v3_provider_sse_json_data(data)? else {
        return Ok(None);
    };
    classify_v3_provider_responses_json_event(&event).map(Some)
}

pub(crate) fn classify_v3_provider_generic_sse_json_data(
    data: &str,
) -> Result<Option<V3ProviderResponsesJsonFrameOutcome>, String> {
    // 非 JSON 单 token 保活文本（`data: ping` 等）：Direct/Relay 一致忽略，
    // 必须在 JSON parse 前放行，否则 usage 观测先短路会把保活帧打成
    // provider SSE event invalid。
    if is_v3_provider_sse_keepalive_text(data) {
        return Ok(None);
    }
    let Some(event) = parse_v3_provider_sse_json_data(data)? else {
        return Ok(None);
    };
    if is_v3_provider_sse_keepalive_json_event(&event) {
        return Ok(None);
    }
    if event
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
    {
        return classify_v3_provider_responses_json_event(&event).map(Some);
    }
    let is_openai_chat_chunk = event.get("choices").and_then(Value::as_array).is_some()
        && event
            .get("object")
            .and_then(Value::as_str)
            .is_some_and(|value| value == "chat.completion.chunk");
    if !is_openai_chat_chunk {
        return Err(
            "provider generic SSE JSON event requires a recognized event shape".to_string(),
        );
    }
    Ok(Some(V3ProviderResponsesJsonFrameOutcome::StartClientStream))
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
    classify_v3_provider_generic_sse_json_data(data)
}

/// Provider SSE keepalive/settlement JSON（无内容语义，Direct/Relay 对称跳过）：
/// `{"type":"ping"}`、`{"ping":...}`、`{"choices":[],"cost":"0"}` 或空对象。
/// 这些帧只保活 transport，不产生 output/tool/usage 语义；真 malformed JSON
/// 仍由 parse 显式失败，不做静默吞并。
pub(crate) fn is_v3_provider_sse_keepalive_json_event(event: &Value) -> bool {
    let Some(object) = event.as_object() else {
        return false;
    };
    if matches!(
        object.get("choices").and_then(Value::as_array),
        Some(choices) if choices.is_empty()
    ) {
        return true;
    }
    object.contains_key("ping") || object.is_empty()
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
        return Ok(if has_output {
            V3ProviderResponsesJsonFrameOutcome::Terminal
        } else {
            V3ProviderResponsesJsonFrameOutcome::TerminalWithoutOutput
        });
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
    ) {
        let has_text = ["delta", "text", "refusal"].iter().any(|field| {
            event
                .get(*field)
                .and_then(Value::as_str)
                .is_some_and(|text| !text.trim().is_empty())
        });
        return Ok(if has_text {
            V3ProviderResponsesJsonFrameOutcome::StartClientStream
        } else {
            V3ProviderResponsesJsonFrameOutcome::ContinueBuffering
        });
    }
    Ok(V3ProviderResponsesJsonFrameOutcome::ContinueBuffering)
}

fn response_output_item_has_client_output(item: &Value) -> Result<bool, String> {
    let Some(item) = item.as_object() else {
        return Err("provider Responses output item must be an object".to_string());
    };
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
        Some("reasoning") => Ok(false),
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
        Some("web_search_call") => {
            if !["id", "call_id"].iter().any(|field| {
                item.get(*field)
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty())
            }) {
                return Err(
                    "provider Responses web_search_call output requires id or call_id".to_string(),
                );
            }
            require_non_empty_output_string(item, "web_search_call", "status")?;
            Ok(true)
        }
        Some(output_type) => Err(format!(
            "provider Responses output item type {output_type:?} is not registered"
        )),
        None => Err("provider Responses output item requires a non-empty type".to_string()),
    }
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
        "output_text" => "text",
        "refusal" => "refusal",
        "output_audio" => "transcript",
        other => {
            return Err(format!(
                "provider Responses message content part type {other:?} is not registered"
            ))
        }
    };
    let text = part.get(field).and_then(Value::as_str).ok_or_else(|| {
        format!("provider Responses {part_type} content part requires string field {field}")
    })?;
    Ok(!text.trim().is_empty())
}

fn require_non_empty_output_string(
    item: &serde_json::Map<String, Value>,
    output_type: &str,
    field: &str,
) -> Result<(), String> {
    let value = item
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            format!("provider Responses {output_type} output requires non-empty {field}")
        })?;
    let _ = value;
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
    use super::*;

    #[test]
    fn empty_completed_terminal_has_no_precommit_output_authority() {
        let outcome = classify_v3_provider_responses_json_data(
            r#"{"type":"response.completed","response":{"id":"resp_1"}}"#,
        )
        .expect("JSON type must classify terminal data");
        assert_eq!(
            outcome,
            Some(V3ProviderResponsesJsonFrameOutcome::TerminalWithoutOutput)
        );
    }

    #[test]
    fn completed_terminal_with_output_can_authorize_client_commit() {
        let outcome = classify_v3_provider_responses_json_data(
            r#"{"type":"response.completed","response":{"id":"resp_1","output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}}"#,
        )
        .expect("completed response output must classify");
        assert_eq!(outcome, Some(V3ProviderResponsesJsonFrameOutcome::Terminal));
    }

    #[test]
    fn completed_terminal_with_structurally_empty_message_has_no_output_authority() {
        let outcome = classify_v3_provider_responses_json_data(
            r#"{"type":"response.completed","response":{"id":"resp_1","output":[{"type":"message","content":[{"type":"output_text","text":""}]}]}}"#,
        )
        .expect("structurally empty completed response must classify");
        assert_eq!(
            outcome,
            Some(V3ProviderResponsesJsonFrameOutcome::TerminalWithoutOutput)
        );
    }

    #[test]
    fn completed_terminal_with_tool_call_can_authorize_client_commit() {
        let outcome = classify_v3_provider_responses_json_data(
            r#"{"type":"response.completed","response":{"id":"resp_1","output":[{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{}"}]}}"#,
        )
        .expect("completed response tool call must classify");
        assert_eq!(outcome, Some(V3ProviderResponsesJsonFrameOutcome::Terminal));
    }

    #[test]
    fn json_error_events_are_provider_failures_before_stream_commit() {
        for event_type in ["error", "response.error"] {
            let data = format!(
                r#"{{"type":"{event_type}","error":{{"code":"upstream_error","message":"bad upstream"}}}}"#
            );
            assert_eq!(
                classify_v3_provider_generic_sse_json_data(&data)
                    .expect("JSON error event must classify"),
                Some(V3ProviderResponsesJsonFrameOutcome::Failure {
                    code: "upstream_error".to_string(),
                    message: "bad upstream".to_string(),
                })
            );
        }
    }

    #[test]
    fn empty_output_item_lifecycle_frames_do_not_authorize_client_commit() {
        for data in [
            r#"{"type":"response.output_item.added","output_index":0,"item":{"type":"message","status":"in_progress","content":[]}}"#,
            r#"{"type":"response.output_item.added","output_index":0,"item":{"type":"message","status":"in_progress","content":[{"type":"output_text","text":""}]}}"#,
            r#"{"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","status":"in_progress","content":[],"summary":[]}}"#,
            r#"{"type":"response.content_part.added","output_index":0,"item_id":"msg_1","content_index":0,"part":{"type":"output_text","text":""}}"#,
        ] {
            assert_eq!(
                classify_v3_provider_generic_sse_json_data(data)
                    .expect("empty lifecycle frame must classify"),
                Some(V3ProviderResponsesJsonFrameOutcome::ContinueBuffering),
                "empty output item must remain precommit: {data}"
            );
        }
    }

    #[test]
    fn completed_terminal_rejects_unknown_or_malformed_output_items() {
        for data in [
            r#"{"type":"response.completed","response":{"output":[{"type":"unknown"}]}}"#,
            r#"{"type":"response.completed","response":{"output":[{"type":"function_call","call_id":"call_1","arguments":"{}"}]}}"#,
            r#"{"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"unknown","text":"x"}]}]}}"#,
        ] {
            assert!(
                classify_v3_provider_generic_sse_json_data(data).is_err(),
                "unknown or malformed output must fail codec classification: {data}"
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
                classify_v3_provider_generic_sse_json_data(data)
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
            let outcome = classify_v3_provider_responses_json_data(&data)
                .expect("response.incomplete with reason must classify");
            assert_eq!(
                outcome,
                Some(V3ProviderResponsesJsonFrameOutcome::Terminal),
                "response.incomplete is a valid terminal, not a provider failure: {data}"
            );
            let generic = classify_v3_provider_generic_sse_json_data(&data)
                .expect("generic classifier must accept response.incomplete");
            assert_eq!(generic, Some(V3ProviderResponsesJsonFrameOutcome::Terminal));
        }
    }

    #[test]
    fn response_incomplete_without_reason_still_fails_fast() {
        let error = classify_v3_provider_responses_json_data(
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
        let error = classify_v3_provider_responses_json_data(r#"{"id":"resp_1"}"#)
            .expect_err("data without type must fail fast");
        assert!(
            error.contains("requires a non-empty type"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn generic_classifier_accepts_openai_chat_chunk_without_type() {
        let outcome = classify_v3_provider_generic_sse_json_data(
            r#"{"id":"chatcmpl_1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}"#,
        )
        .expect("OpenAI Chat chunks do not require a Responses type");
        assert_eq!(
            outcome,
            Some(V3ProviderResponsesJsonFrameOutcome::StartClientStream)
        );
    }

    #[test]
    fn generic_classifier_treats_empty_choices_chat_chunk_as_keepalive() {
        let outcome = classify_v3_provider_generic_sse_json_data(
            r#"{"id":"chatcmpl_1","object":"chat.completion.chunk","choices":[]}"#,
        )
        .expect("empty-choices settlement chunk must classify");
        assert_eq!(
            outcome, None,
            "empty choices carries no content/usage semantics and is keepalive-only"
        );
    }

    #[test]
    fn generic_classifier_rejects_unrecognized_json_without_type() {
        let error = classify_v3_provider_generic_sse_json_data(r#"{"id":"resp_1"}"#)
            .expect_err("generic provider JSON must have a recognized shape");
        assert!(error.contains("recognized event shape"));
    }

    #[test]
    fn generic_classifier_rejects_malformed_chat_choices_shape() {
        for payload in [
            r#"{"object":"chat.completion.chunk","choices":null}"#,
            r#"{"object":"chat.completion.chunk","choices":{}}"#,
        ] {
            let error = classify_v3_provider_generic_sse_json_data(payload)
                .expect_err("malformed Chat choices must fail before stream commit");
            assert!(error.contains("recognized event shape"));
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

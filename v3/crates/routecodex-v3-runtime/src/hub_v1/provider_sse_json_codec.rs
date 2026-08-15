use routecodex_v3_sse::SseField;
use serde_json::Value;

use super::V3RuntimeStreamObservation;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum V3ProviderResponsesJsonFrameOutcome {
    ContinueBuffering,
    StartClientStream,
    Terminal,
    Failure { code: String, message: String },
}

pub(crate) fn parse_v3_provider_sse_json_data(data: &str) -> Result<Option<Value>, String> {
    let data = data.trim();
    if data.is_empty() || data == "[DONE]" {
        return Ok(None);
    }
    match serde_json::from_str(data) {
        Ok(value) => Ok(Some(value)),
        Err(error) => {
            // SSE 多行 data 拼接后，reasoning 文本等字符串值可能携带未转义的
            // 原始控制字符（\u0000-\u001F，serde 报 control character）。
            // 控制字符在 JSON 里只可能出现在字符串值内，把字符串值内的
            // 未转义控制字符转义为 \uXXXX 后重试解析；仍失败则原样报错
            // （不吞错误、不静默降级）。
            if is_v3_sse_control_character_parse_error(&error) {
                let normalized = escape_v3_sse_raw_control_characters(data);
                if let Ok(value) = serde_json::from_str(&normalized) {
                    return Ok(Some(value));
                }
            }
            Err(format!("provider SSE JSON payload is malformed: {error}"))
        }
    }
}

fn is_v3_sse_control_character_parse_error(error: &serde_json::Error) -> bool {
    error.to_string().contains("control character")
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
    let Some(event) = parse_v3_provider_sse_json_data(data)? else {
        return Ok(None);
    };
    if event
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
    {
        return classify_v3_provider_responses_json_event(&event).map(Some);
    }
    let is_openai_chat_chunk = event
        .get("choices")
        .and_then(Value::as_array)
        .is_some()
        && event
            .get("object")
            .and_then(Value::as_str)
            .is_some_and(|value| value == "chat.completion.chunk");
    if !is_openai_chat_chunk {
        return Err("provider generic SSE JSON event requires a recognized event shape".to_string());
    }
    Ok(Some(V3ProviderResponsesJsonFrameOutcome::StartClientStream))
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

    if event_type == "response.incomplete" {
        if let Some(reason) = event
            .pointer("/response/incomplete_details/reason")
            .or_else(|| event.pointer("/incomplete_details/reason"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Ok(V3ProviderResponsesJsonFrameOutcome::Failure {
                code: "response_incomplete".to_string(),
                message: reason.to_string(),
            });
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
        return Ok(V3ProviderResponsesJsonFrameOutcome::Terminal);
    }
    if matches!(event_type, "response.created" | "response.in_progress") {
        return Ok(V3ProviderResponsesJsonFrameOutcome::ContinueBuffering);
    }
    Ok(V3ProviderResponsesJsonFrameOutcome::StartClientStream)
}

pub(crate) fn record_v3_provider_sse_json_frame(
    fields: &[SseField],
    stream_observation: &V3RuntimeStreamObservation,
) -> Result<(), String> {
    let mut data = String::new();
    for field in fields {
        let SseField::Named { name, value } = field else {
            continue;
        };
        if name != "data" {
            continue;
        }
        if !data.is_empty() {
            data.push('\n');
        }
        data.push_str(value);
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
    fn json_type_is_the_only_semantic_source() {
        let outcome = classify_v3_provider_responses_json_data(
            r#"{"type":"response.completed","response":{"id":"resp_1"}}"#,
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
            r#"{"id":"chatcmpl_1","object":"chat.completion.chunk","choices":[]}"#,
        )
        .expect("OpenAI Chat chunks do not require a Responses type");
        assert_eq!(
            outcome,
            Some(V3ProviderResponsesJsonFrameOutcome::StartClientStream)
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
        assert_eq!(
            value.unwrap()["delta"],
            "first line\nsecond\tline\u{1}tail"
        );
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
    fn structural_control_characters_still_fail_fast() {
        // 结构外（非字符串）的控制字符不是合法 JSON，修复逻辑不得吞掉：
        // 转义修复后仍失败必须原样报错。
        let error = parse_v3_provider_sse_json_data("{\"a\":1}\n\u{1}tail")
            .expect_err("trailing control character outside any string must still fail");
        assert!(error.contains("malformed"));
    }

    #[test]
    fn escaped_sequences_are_not_double_escaped() {
        // 已转义的 \\n 文本（反斜杠+n，无控制字节）不得被再次转义。
        let data = r#"{"type":"response.output_text.delta","delta":"a\\nb"}"#;
        let value = parse_v3_provider_sse_json_data(data)
            .expect("escaped sequences must parse untouched");
        assert_eq!(value.unwrap()["delta"], "a\\nb");
    }
}

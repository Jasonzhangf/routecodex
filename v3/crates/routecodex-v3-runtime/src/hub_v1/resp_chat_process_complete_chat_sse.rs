//! Complete Chat text-carrier governance. Runtime owns admission and storage.
use super::{V3HubProviderWireProtocol, V3HubRelayResponseError, V3ProviderAttemptBusinessContent};
use crate::tool_markup_parser::{scan_tool_markup, ToolMarkupDeclarations, ToolMarkupSegment};
use routecodex_v3_sse::*;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, thiserror::Error)]
pub(crate) enum V3RelayCompleteResponseError {
    #[error(transparent)]
    Governance(#[from] V3HubRelayResponseError),
    #[error("complete Relay SSE processing failed: {0}")]
    Processing(String),
    #[error("complete Relay SSE store failed: {0}")]
    Store(crate::nodes::V3AttemptStoreError),
}

impl From<crate::nodes::V3AttemptStoreError> for V3RelayCompleteResponseError {
    fn from(error: crate::nodes::V3AttemptStoreError) -> Self {
        Self::Store(error)
    }
}

fn decode(
    frames: &[Vec<u8>],
) -> Result<Vec<(V3SseTransportIn03ValidatedFrameStream, Option<Value>)>, String> {
    let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
    let mut events = Vec::new();
    for bytes in frames {
        for frame in decoder
            .push(build_v3_sse_transport_in_01_raw_chunk(bytes))
            .map_err(|e| e.to_string())?
        {
            let data = frame
                .frame()
                .fields()
                .iter()
                .filter_map(|field| match field {
                    SseField::Named { name, value } if name == "data" => Some(value.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            let value = if data.trim().is_empty() || data.trim() == "[DONE]" {
                None
            } else {
                Some(serde_json::from_str(&data).map_err(|e| format!("projected SSE JSON: {e}"))?)
            };
            events.push((frame, value));
        }
    }
    decoder.finish().map_err(|e| e.to_string())?;
    Ok(events)
}

pub(crate) fn projected_sse_has_business_content(
    protocol: V3HubProviderWireProtocol,
    frames: &[Vec<u8>],
) -> Result<bool, String> {
    let mut facts = V3ProviderAttemptBusinessContent::default();
    for (_, value) in decode(frames)? {
        if let Some(value) = value {
            facts.observe_event(protocol, &value);
        }
    }
    Ok(facts.has_deliverable_business_content())
}

/// Keep exact surviving source spans, including literal/code contexts and
/// opaque invocations. Never synthesize text or touch native tool arguments.
pub(crate) fn govern_complete_chat_sse(
    frames: &[Vec<u8>],
    source_terminal: Option<usize>,
) -> Result<Option<(Vec<Vec<u8>>, usize)>, V3RelayCompleteResponseError> {
    let mut events = decode(frames).map_err(V3RelayCompleteResponseError::Processing)?;
    let mut carriers: BTreeMap<(String, String), (String, Vec<(usize, String, usize, usize)>)> =
        BTreeMap::new();
    for (event_index, (_, value)) in events.iter().enumerate() {
        let Some(choices) = value
            .as_ref()
            .and_then(|v| v.get("choices"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        for (choice_index, choice) in choices.iter().enumerate() {
            let identity = choice
                .get("index")
                .cloned()
                .unwrap_or_else(|| choice_index.into())
                .to_string();
            for field in ["message", "delta"] {
                let Some(content) = choice.get(field).and_then(|v| v.get("content")) else {
                    continue;
                };
                let texts: Vec<(String, &str)> = if let Some(text) = content.as_str() {
                    vec![(format!("/choices/{choice_index}/{field}/content"), text)]
                } else if let Some(parts) = content.as_array() {
                    parts
                        .iter()
                        .enumerate()
                        .filter_map(|(i, part)| {
                            matches!(
                                part.get("type").and_then(Value::as_str),
                                Some("text" | "output_text")
                            )
                            .then(|| {
                                part.get("text").and_then(Value::as_str).map(|text| {
                                    (
                                        format!("/choices/{choice_index}/{field}/content/{i}/text"),
                                        text,
                                    )
                                })
                            })
                            .flatten()
                        })
                        .collect()
                } else {
                    Vec::new()
                };
                for (path, text) in texts {
                    let carrier_path = path.splitn(4, '/').nth(3).unwrap_or_default().to_string();
                    let carrier = carriers
                        .entry((identity.clone(), carrier_path))
                        .or_default();
                    let start = carrier.0.len();
                    carrier.0.push_str(text);
                    carrier.1.push((event_index, path, start, carrier.0.len()));
                }
            }
        }
    }
    let mut changed = BTreeSet::new();
    for (_, (text, pieces)) in carriers {
        let scan = scan_tool_markup(&text, &ToolMarkupDeclarations::default());
        if scan.incomplete_tool_invocation {
            return Err(V3HubRelayResponseError::UnharvestableToolMarkup.into());
        }
        if !scan.removed_label {
            continue;
        }
        let base = text.as_ptr() as usize;
        let mut spans = BTreeSet::new();
        for segment in scan.segments {
            match segment {
                ToolMarkupSegment::Text(value) => {
                    spans.insert((value.as_ptr() as usize - base, value.len()));
                }
                ToolMarkupSegment::Calls(calls) => {
                    for call in calls {
                        spans.insert((call.envelope.as_ptr() as usize - base, call.envelope.len()));
                    }
                }
            }
        }
        for (event, path, start, end) in pieces {
            let mut kept = String::new();
            for (offset, length) in &spans {
                let left = start.max(*offset);
                let right = end.min(offset + length);
                if left < right {
                    kept.push_str(&text[left..right]);
                }
            }
            if kept != text[start..end] {
                let target = events[event]
                    .1
                    .as_mut()
                    .and_then(|value| value.pointer_mut(&path))
                    .ok_or_else(|| {
                        V3RelayCompleteResponseError::Processing(
                            "text carrier identity disappeared".into(),
                        )
                    })?;
                *target = kept.into();
                changed.insert(event);
            }
        }
    }
    if changed.is_empty() {
        return Ok(None);
    }
    let terminal = source_terminal.ok_or_else(|| {
        V3RelayCompleteResponseError::Processing("governed Chat SSE has no source terminal".into())
    })?;
    let mut output = Vec::with_capacity(events.len());
    for (index, (frame, value)) in events.into_iter().enumerate() {
        if !changed.contains(&index) {
            output.push(frame.frame().raw_bytes().map(Vec::from).unwrap_or_else(|| {
                build_v3_sse_transport_out_04_from_v3_sse_transport_in_03(&frame).into_bytes()
            }));
            continue;
        }
        let mut fields = Vec::new();
        let mut written = false;
        for field in frame.frame().fields() {
            if matches!(field, SseField::Named { name, .. } if name == "data") {
                if !written {
                    fields.push(SseField::Named {
                        name: "data".into(),
                        value: value.as_ref().unwrap().to_string(),
                    });
                    written = true;
                }
            } else {
                fields.push(field.clone());
            }
        }
        let decoded = build_v3_sse_transport_in_02_from_fields(fields)
            .map_err(|e| V3RelayCompleteResponseError::Processing(e.to_string()))?;
        let validated = build_v3_sse_transport_in_03_from_v3_sse_transport_in_02(decoded)
            .map_err(|e| V3RelayCompleteResponseError::Processing(e.to_string()))?;
        output.push(
            build_v3_sse_transport_out_04_from_v3_sse_transport_in_03(&validated).into_bytes(),
        );
    }
    Ok(Some((output, terminal)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(delta: Value, finish_reason: Value) -> Vec<u8> {
        format!(
            "data: {}\n\n",
            serde_json::json!({
                "id": "chatcmpl_complete_governance",
                "object": "chat.completion.chunk",
                "model": "wire-test",
                "choices": [{
                    "index": 0,
                    "delta": delta,
                    "finish_reason": finish_reason
                }]
            })
        )
        .into_bytes()
    }

    fn usage() -> Vec<u8> {
        format!(
            "data: {}\n\n",
            serde_json::json!({
                "id": "chatcmpl_complete_governance",
                "object": "chat.completion.chunk",
                "model": "wire-test",
                "choices": [],
                "usage": {"prompt_tokens": 1, "completion_tokens": 0, "total_tokens": 1}
            })
        )
        .into_bytes()
    }

    fn done() -> Vec<u8> {
        b"data: [DONE]\n\n".to_vec()
    }

    fn values(frames: &[Vec<u8>]) -> Vec<Value> {
        decode(frames)
            .expect("test Chat SSE frames must decode")
            .into_iter()
            .filter_map(|(_, value)| value)
            .collect()
    }

    fn text(frames: &[Vec<u8>]) -> String {
        values(frames)
            .iter()
            .filter_map(|value| {
                value
                    .pointer("/choices/0/delta/content")
                    .and_then(Value::as_str)
            })
            .collect()
    }

    #[test]
    fn issuee63d2f2_fragmented_control_label_is_stripped_across_delta_events() {
        let frames = vec![
            chunk(
                serde_json::json!({"content": "alpha\n<|end_of_"}),
                Value::Null,
            ),
            chunk(
                serde_json::json!({"content": "analysis|>\nomega"}),
                Value::Null,
            ),
            chunk(serde_json::json!({}), serde_json::json!("stop")),
            done(),
        ];
        let (governed, terminal) = govern_complete_chat_sse(&frames, Some(2))
            .expect("fragmented label governance must not process-fail")
            .expect("fragmented label must be rewritten");
        assert_eq!(terminal, 2);
        assert_eq!(text(&governed), "alpha\nomega");
        assert!(projected_sse_has_business_content(
            V3HubProviderWireProtocol::OpenAiChat,
            &governed
        )
        .expect("governed frames decode"));
    }

    #[test]
    fn issuee63d2f2_fragmented_orphan_close_is_unharvestable_after_aggregation() {
        let frames = vec![
            chunk(
                serde_json::json!({"content": "must-not-leak\n\n</｜DSML｜tool_"}),
                Value::Null,
            ),
            chunk(serde_json::json!({"content": "calls>"}), Value::Null),
            chunk(serde_json::json!({}), serde_json::json!("stop")),
            done(),
        ];
        let error = govern_complete_chat_sse(&frames, Some(2))
            .expect_err("a completed orphan close must discard the whole attempt");
        assert!(matches!(
            error,
            V3RelayCompleteResponseError::Governance(
                V3HubRelayResponseError::UnharvestableToolMarkup
            )
        ));
    }

    #[test]
    fn issuee63d2f2_literal_marker_contexts_stay_visible() {
        let literal = "Inline `<|end_of_analysis|>` and `<|DSML|tool_calls>` examples.\n\n```text\n</｜DSML｜tool_calls>\n```\n多语言保留: café 日本語 <|end_of_analysis|> tail";
        let frames = vec![
            chunk(serde_json::json!({"content": literal}), Value::Null),
            chunk(serde_json::json!({}), serde_json::json!("stop")),
            done(),
        ];
        assert!(
            govern_complete_chat_sse(&frames, Some(1))
                .expect("literal context governance must pass")
                .is_none(),
            "literal markers are not standalone control labels"
        );
        assert_eq!(text(&frames), literal);
        assert!(
            projected_sse_has_business_content(V3HubProviderWireProtocol::OpenAiChat, &frames)
                .expect("literal frames decode")
        );
    }

    #[test]
    fn issuee63d2f2_complete_text_invocation_envelope_survives_label_stripping() {
        let frames = vec![
            chunk(
                serde_json::json!({
                    "content": "<|DSML|tool_calls>\n<tool_call>lookup<arg_key>q</arg_key><arg_value>hello</arg_value></tool_call>\n"
                }),
                Value::Null,
            ),
            chunk(serde_json::json!({}), serde_json::json!("tool_calls")),
            done(),
        ];
        let (governed, _) = govern_complete_chat_sse(&frames, Some(1))
            .expect("complete invocation governance must pass")
            .expect("only the standalone label is stripped");
        let output = text(&governed);
        assert!(!output.contains("<|DSML|tool_calls>"));
        assert!(
            output.contains(
                "<tool_call>lookup<arg_key>q</arg_key><arg_value>hello</arg_value></tool_call>"
            ),
            "whole invocation bytes must survive: {output:?}"
        );
    }

    #[test]
    fn issuee63d2f2_native_tool_delta_and_terminal_survive_rewrite() {
        let tool_delta = serde_json::json!({
            "tool_calls": [{
                "index": 0,
                "id": "call_complete_governance",
                "type": "function",
                "function": {"name": "lookup", "arguments": "{\"q\":\"hello\"}"}
            }]
        });
        let frames = vec![
            chunk(
                serde_json::json!({"content": "<|end_of_analysis|>"}),
                Value::Null,
            ),
            chunk(tool_delta.clone(), Value::Null),
            chunk(serde_json::json!({}), serde_json::json!("tool_calls")),
            done(),
        ];
        let (governed, terminal) = govern_complete_chat_sse(&frames, Some(2))
            .expect("native tool governance must pass")
            .expect("the label carrier is rewritten");
        assert_eq!(terminal, 2);
        let governed_values = values(&governed);
        assert_eq!(
            governed_values
                .iter()
                .filter_map(|value| value.pointer("/choices/0/delta/tool_calls"))
                .next(),
            Some(&tool_delta["tool_calls"]),
            "native call bytes and association must not change"
        );
        assert_eq!(
            governed_values
                .iter()
                .filter_map(|value| value.pointer("/choices/0/finish_reason"))
                .find(|value| value.is_string()),
            Some(&serde_json::json!("tool_calls")),
            "the source terminal reason must not change"
        );
        assert!(projected_sse_has_business_content(
            V3HubProviderWireProtocol::OpenAiChat,
            &governed
        )
        .expect("native tool frames decode"));
    }

    #[test]
    fn issuee63d2f2_envelope_only_frames_are_empty_but_content_filter_is_business() {
        let envelope_only = vec![
            chunk(serde_json::json!({"role": "assistant"}), Value::Null),
            usage(),
            chunk(serde_json::json!({}), serde_json::json!("stop")),
            done(),
        ];
        assert!(!projected_sse_has_business_content(
            V3HubProviderWireProtocol::OpenAiChat,
            &envelope_only
        )
        .expect("envelope-only frames decode"));
        assert!(govern_complete_chat_sse(&envelope_only, Some(2))
            .expect("ungoverned frames pass")
            .is_none());

        let content_filter = vec![
            chunk(serde_json::json!({}), serde_json::json!("content_filter")),
            done(),
        ];
        assert!(projected_sse_has_business_content(
            V3HubProviderWireProtocol::OpenAiChat,
            &content_filter
        )
        .expect("content_filter frames decode"));
    }

    #[test]
    fn issuee63d2f2_reasoning_alone_is_not_an_empty_processing_failure() {
        let frames = vec![
            chunk(
                serde_json::json!({"reasoning_content": "private plan"}),
                Value::Null,
            ),
            chunk(serde_json::json!({}), serde_json::json!("stop")),
            done(),
        ];
        assert!(!projected_sse_has_business_content(
            V3HubProviderWireProtocol::OpenAiChat,
            &frames
        )
        .expect("reasoning frames decode"));
        assert!(govern_complete_chat_sse(&frames, Some(1))
            .expect("reasoning alone is not processing damage")
            .is_none());
    }

    #[test]
    fn issuee63d2f2_label_only_rewrite_is_empty_not_processing_damage() {
        let frames = vec![
            chunk(
                serde_json::json!({"content": "<|end_of_analysis|>"}),
                Value::Null,
            ),
            chunk(serde_json::json!({}), serde_json::json!("stop")),
            done(),
        ];
        let (governed, _) = govern_complete_chat_sse(&frames, Some(1))
            .expect("label governance itself succeeds")
            .expect("label carrier is rewritten");
        assert!(
            !projected_sse_has_business_content(V3HubProviderWireProtocol::OpenAiChat, &governed)
                .expect("rewritten frames decode"),
            "a label-only attempt is governed-empty (502), not processing damage (599)"
        );
    }

    #[test]
    fn issuee63d2f2_reasonless_terminal_with_marker_uses_typed_witness() {
        let frames = vec![
            chunk(
                serde_json::json!({"content": "<|end_of_analysis|>\nREASONLESS_OK"}),
                Value::Null,
            ),
            chunk(serde_json::json!({}), Value::Null),
            done(),
        ];
        let (governed, terminal) = govern_complete_chat_sse(&frames, Some(1))
            .expect("a reason-less protocol terminal must not become processing damage")
            .expect("the removable standalone marker is rewritten");
        assert_eq!(terminal, 1);
        assert_eq!(text(&governed), "REASONLESS_OK");
        assert!(
            projected_sse_has_business_content(V3HubProviderWireProtocol::OpenAiChat, &governed)
                .expect("governed frames decode")
        );
    }

    #[test]
    fn issuee63d2f2_malformed_projected_json_is_processing_failure() {
        let frames = vec![b"data: {not-json}\n\n".to_vec()];
        let error = govern_complete_chat_sse(&frames, Some(0))
            .expect_err("semantic damage must stay a processing failure");
        assert!(matches!(error, V3RelayCompleteResponseError::Processing(_)));
    }
}

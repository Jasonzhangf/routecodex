//! Complete Chat text-carrier governance. Runtime owns admission and storage.
use super::resp_chat_process_03_governed::{harvest_chat_text, V3HubRelaySerializedToolContext};
use super::{V3HubProviderWireProtocol, V3HubRelayResponseError, V3ProviderAttemptBusinessContent};
use routecodex_v3_sse::*;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashSet};

#[derive(Debug, thiserror::Error)]
pub(crate) enum V3RelayCompleteResponseError {
    #[error(transparent)]
    Governance(#[from] V3HubRelayResponseError),
    #[error("complete Relay SSE processing failed: {0}")]
    Processing(String),
    #[error("complete Relay SSE store failed: {0}")]
    Store(crate::nodes::V3AttemptStoreError),
}

pub(crate) type V3RelayCompleteResponseResult =
    Result<Option<(Vec<Vec<u8>>, usize)>, V3RelayCompleteResponseError>;
type V3RelayCompleteCarrierKey = (String, String);
type V3RelayCompleteCarrierSpan = (usize, String, usize, usize);
type V3RelayCompleteCarrier = (String, Vec<V3RelayCompleteCarrierSpan>);

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
#[cfg(test)]
fn govern_complete_chat_sse(
    frames: &[Vec<u8>],
    source_terminal: Option<usize>,
) -> V3RelayCompleteResponseResult {
    govern_complete_chat_sse_with_context(
        frames,
        source_terminal,
        &V3HubRelaySerializedToolContext::default(),
    )
}

pub(crate) fn govern_complete_chat_sse_with_context(
    frames: &[Vec<u8>],
    source_terminal: Option<usize>,
    context: &V3HubRelaySerializedToolContext,
) -> V3RelayCompleteResponseResult {
    let mut events = decode(frames).map_err(V3RelayCompleteResponseError::Processing)?;
    let mut carriers: BTreeMap<V3RelayCompleteCarrierKey, V3RelayCompleteCarrier> = BTreeMap::new();
    let mut used = HashSet::new();
    let mut next_indices = BTreeMap::<String, usize>::new();
    let mut opaque_choices = BTreeSet::new();
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
                if let Some(native) = choice
                    .get(field)
                    .and_then(|message| message.get("tool_calls"))
                {
                    if let Some(native) = native.as_array() {
                        for (ordinal, call) in native.iter().enumerate() {
                            if let Some(id) = call["id"].as_str() {
                                used.insert(id.to_owned());
                            }
                            let index = call["index"]
                                .as_u64()
                                .and_then(|index| usize::try_from(index).ok())
                                .unwrap_or(ordinal);
                            let next = next_indices.entry(identity.clone()).or_default();
                            *next = (*next).max(index.saturating_add(1));
                        }
                    } else {
                        opaque_choices.insert(identity.clone());
                    }
                }
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
    for ((identity, carrier), (text, pieces)) in carriers {
        let empty = V3HubRelaySerializedToolContext::default();
        // The existing Chat adapter harvests string content only. Structured
        // content and opaque native carriers retain their business shape.
        let context = if matches!(carrier.as_str(), "message/content" | "delta/content")
            && !opaque_choices.contains(&identity)
        {
            context
        } else {
            &empty
        };
        let (visible, mut calls) = harvest_chat_text(&text, context, &mut used)?;
        let base = text.as_ptr() as usize;
        let spans: BTreeSet<_> = visible
            .iter()
            .map(|value| (value.as_ptr() as usize - base, value.len()))
            .collect();
        if !calls.is_empty() {
            let (first_event, first_path, _, _) = &pieces[0];
            let message_path = first_path.split('/').take(4).collect::<Vec<_>>().join("/");
            let message = events[*first_event]
                .1
                .as_mut()
                .and_then(|event| event.pointer_mut(&message_path))
                .and_then(Value::as_object_mut)
                .ok_or_else(|| {
                    V3RelayCompleteResponseError::Processing("Chat tool carrier disappeared".into())
                })?;
            let next = next_indices.entry(identity.clone()).or_default();
            for call in &mut calls {
                call["index"] = (*next).into();
                *next += 1;
            }
            message
                .entry("tool_calls")
                .or_insert_with(|| Value::Array(Vec::new()))
                .as_array_mut()
                .expect("opaque native carriers were preserved")
                .extend(calls);
            changed.insert(*first_event);
            for (event_index, (_, event)) in events.iter_mut().enumerate() {
                let Some(choices) = event
                    .as_mut()
                    .and_then(|event| event["choices"].as_array_mut())
                else {
                    continue;
                };
                for (ordinal, choice) in choices.iter_mut().enumerate() {
                    let key = choice
                        .get("index")
                        .cloned()
                        .unwrap_or_else(|| ordinal.into())
                        .to_string();
                    if key == identity
                        && choice["finish_reason"].is_string()
                        && choice["finish_reason"] != "content_filter"
                    {
                        choice["finish_reason"] = "tool_calls".into();
                        changed.insert(event_index);
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

    fn declared_context(custom: bool) -> V3HubRelaySerializedToolContext {
        let tool = if custom {
            serde_json::json!({"type":"custom","name":"bash","format":{"type":"text"}})
        } else {
            serde_json::json!({"type":"function","name":"bash","parameters":{"type":"object","properties":{"command":{"type":"string"}}}})
        };
        let registry =
            provider_compat_core::namespace_tools::NamespaceToolIdentityRegistry::from_tools(&[
                tool,
            ])
            .unwrap();
        V3HubRelaySerializedToolContext::from_registry(&registry)
    }

    #[test]
    fn issueff1e031_complete_chat_native_extensions_and_choices() {
        let text = "Before.<tool_call>bash<arg_key>command</arg_key><arg_value>printf SAFE</arg_value></tool_call>After.";
        let native = serde_json::json!({"index":4,"id":"native_keep","type":"function","function":{"name":"other","arguments":"not-json"}});
        let first = format!("data: {}\n\n", serde_json::json!({"choices":[{"index":2,"delta":{"tool_calls":[native]},"finish_reason":null},{"index":7,"delta":{"content":"other choice"},"finish_reason":null}]})).into_bytes();
        let content = format!("id: retained\nevent: vendor.chunk\nretry: 91\ndata: {}\n\n", serde_json::json!({"choices":[{"index":2,"delta":{"content":text,"vendor_delta":{"all":[1,2]}},"finish_reason":null}],"vendor_payload":{"kept":true}})).into_bytes();
        let terminal = format!("data: {}\n\n", serde_json::json!({"choices":[{"index":2,"delta":{},"finish_reason":"stop"},{"index":7,"delta":{},"finish_reason":"stop"}]})).into_bytes();
        let frames = vec![first, content, terminal, usage(), done()];
        let (governed, terminal) =
            govern_complete_chat_sse_with_context(&frames, Some(2), &declared_context(false))
                .unwrap()
                .unwrap();
        assert_eq!(terminal, 2);
        assert_eq!(governed.len(), frames.len());
        assert_eq!(governed[0], frames[0]);
        assert_eq!(governed[3..], frames[3..]);
        let rewritten = String::from_utf8(governed[1].clone()).unwrap();
        assert!(rewritten.contains("id: retained"));
        assert!(rewritten.contains("event: vendor.chunk"));
        assert!(rewritten.contains("retry: 91"));
        let values = values(&governed);
        assert_eq!(values[0]["choices"][0]["delta"]["tool_calls"][0], native);
        assert_eq!(
            values[1]["vendor_payload"],
            serde_json::json!({"kept":true})
        );
        let delta = &values[1]["choices"][0]["delta"];
        assert_eq!(delta["content"], "Before.After.");
        assert_eq!(delta["vendor_delta"], serde_json::json!({"all":[1,2]}));
        assert_eq!(delta["tool_calls"][0]["index"], 5);
        assert_ne!(delta["tool_calls"][0]["id"], "native_keep");
        assert_eq!(delta["tool_calls"][0]["function"]["name"], "bash");
        assert_eq!(
            delta["tool_calls"][0]["function"]["arguments"],
            "{\"command\":\"printf SAFE\"}"
        );
        assert_eq!(values[2]["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(values[2]["choices"][1]["finish_reason"], "stop");
    }

    #[test]
    fn issueff1e031_complete_chat_opaque_and_custom_are_preserved() {
        let text = "<tool_call>bash<arg_key>command</arg_key><arg_value>printf SAFE</arg_value></tool_call>";
        let opaque_part = chunk(
            serde_json::json!({"content":[{"type":"text","text":text,"vendor":{"opaque":true}}]}),
            Value::Null,
        );
        let opaque_native = chunk(
            serde_json::json!({"content":text,"tool_calls":{"opaque":true}}),
            Value::Null,
        );
        for frame in [opaque_part, opaque_native] {
            let frames = vec![frame, chunk(serde_json::json!({}), "stop".into()), done()];
            assert!(govern_complete_chat_sse_with_context(
                &frames,
                Some(1),
                &declared_context(false)
            )
            .unwrap()
            .is_none());
        }
        let frames = vec![
            chunk(serde_json::json!({"content":text}), Value::Null),
            chunk(serde_json::json!({}), "stop".into()),
            done(),
        ];
        assert!(
            govern_complete_chat_sse_with_context(&frames, Some(1), &declared_context(true))
                .unwrap()
                .is_none()
        );
    }

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
        assert!(projected_sse_has_business_content(
            V3HubProviderWireProtocol::OpenAiChat,
            &governed
        )
        .expect("governed frames decode"));
    }

    #[test]
    fn issuee63d2f2_malformed_projected_json_is_processing_failure() {
        let frames = vec![b"data: {not-json}\n\n".to_vec()];
        let error = govern_complete_chat_sse(&frames, Some(0))
            .expect_err("semantic damage must stay a processing failure");
        assert!(matches!(error, V3RelayCompleteResponseError::Processing(_)));
    }
}

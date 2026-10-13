//! Gemini standard business response to the existing Responses canonical shape.
use super::gemini_terminal_semantics::interpret_gemini_terminal;
use serde_json::{json, Value};

pub(crate) fn project_gemini_response(payload: &Value, request_id: &str) -> Result<Value, String> {
    let terminal = interpret_gemini_terminal(payload)?;
    let candidates = terminal.candidates;
    let mut response = payload.clone();
    let row = response
        .as_object_mut()
        .ok_or("Gemini response requires an object")?;
    // Gemini response/call identifiers are optional. When absent, the target
    // Responses protocol gets identities scoped to this actual request.
    let response_id = match payload.get("responseId").and_then(Value::as_str) {
        Some(id) => id.to_string(),
        None => format!("resp_{request_id}"),
    };
    let mut output = Vec::new();
    let mut outcomes = Vec::new();
    for (candidate_index, candidate) in candidates.iter().enumerate() {
        let output_start = output.len();
        for (part_index, part) in candidate
            .pointer("/content/parts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            if let Some(call) = part.get("functionCall") {
                let mut item = call.clone();
                let item_row = item
                    .as_object_mut()
                    .ok_or("Gemini functionCall requires an object")?;
                let arguments = item_row.remove("args").unwrap_or_else(|| json!({}));
                item_row.insert(
                    "arguments".into(),
                    match arguments {
                        Value::String(text) => Value::String(text),
                        value => Value::String(
                            serde_json::to_string(&value).map_err(|error| error.to_string())?,
                        ),
                    },
                );
                let id = item_row.remove("id").unwrap_or_else(|| {
                    json!(format!("{response_id}_call_{candidate_index}_{part_index}"))
                });
                item_row.insert("call_id".into(), id);
                item_row.insert("type".into(), json!("function_call"));
                if let Some(signature) = part.get("thoughtSignature") {
                    item_row.insert("thought_signature".into(), signature.clone());
                }
                output.push(item);
            } else if part.get("text").is_some() {
                let mut content = part.clone();
                content["type"] = json!("output_text");
                output.push(json!({"type":"message","role":"assistant","content":[content]}));
            } else {
                // Preserve a business part with no equivalent mapping as opaque content.
                output.push(json!({"type":"message","role":"assistant","content":[part]}));
            }
        }
        // This is candidate business metadata, not transport/control state.
        // Content is projected once above. Explicit output positions preserve
        // association even for candidates with no text or function-call parts.
        let mut outcome = candidate
            .as_object()
            .cloned()
            .ok_or("Gemini candidate requires an object")?;
        if let Some(content) = outcome.get_mut("content").and_then(Value::as_object_mut) {
            content.remove("parts");
            if content.is_empty() {
                outcome.remove("content");
            }
        }
        let index = outcome
            .remove("index")
            .unwrap_or_else(|| json!(candidate_index));
        outcome.insert("candidate_index".into(), index);
        outcome.insert(
            "output_indices".into(),
            json!((output_start..output.len()).collect::<Vec<_>>()),
        );
        outcomes.push(Value::Object(outcome));
    }
    row.remove("candidates");
    row.remove("usageMetadata");
    row.insert("id".into(), json!(response_id));
    row.insert("object".into(), json!("response"));
    row.insert("output".into(), Value::Array(output));
    row.insert("gemini_candidate_outcomes".into(), Value::Array(outcomes));
    row.insert("finishReason".into(), json!(terminal.finish_reason));
    match terminal.incomplete_reason {
        Some(reason) => {
            row.insert("status".into(), json!("incomplete"));
            row.insert("incomplete_details".into(), json!({"reason":reason}));
        }
        None => {
            row.insert("status".into(), json!("completed"));
        }
    }
    if let Some(usage) = payload.get("usageMetadata") {
        let mut canonical_usage = usage.clone();
        for (source, target) in [
            ("promptTokenCount", "input_tokens"),
            ("candidatesTokenCount", "output_tokens"),
            ("totalTokenCount", "total_tokens"),
        ] {
            if let Some(value) = usage.get(source) {
                canonical_usage[target] = value.clone();
            }
        }
        row.insert("usage".into(), canonical_usage);
    }
    Ok(response)
}

/// Resp03 consumes the exact request attempt's standard binding.
pub(crate) fn restore_gemini_tool_kinds(
    response: &mut Value,
    registry: &provider_compat_core::namespace_tools::NamespaceToolIdentityRegistry,
) {
    use provider_compat_core::namespace_tools::ToolKind;
    for item in response
        .get_mut("output")
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
    {
        if item.get("type").and_then(Value::as_str) != Some("function_call") {
            continue;
        }
        let Some(name) = item.get("name").and_then(Value::as_str) else {
            continue;
        };
        let Some(identity) = registry
            .identities()
            .find(|identity| identity.actual_wire_name == name)
        else {
            continue;
        };
        if identity.kind == ToolKind::Custom {
            let arguments = item.get("arguments").cloned().unwrap_or(Value::Null);
            let parsed = arguments
                .as_str()
                .and_then(|text| serde_json::from_str::<Value>(text).ok());
            let input = parsed
                .as_ref()
                .and_then(Value::as_object)
                .filter(|object| object.len() == 1)
                .and_then(|object| object.get("input"))
                .filter(|value| value.is_string())
                .cloned()
                .unwrap_or(arguments);
            item.as_object_mut().unwrap().remove("arguments");
            item["type"] = json!("custom_tool_call");
            item["input"] = input;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gemini_terminal_mixed_outcomes_are_order_independent_and_associated() {
        for (reason, incomplete) in [
            ("SAFETY", "content_filter"),
            ("MAX_TOKENS", "max_output_tokens"),
        ] {
            for reversed in [false, true] {
                let mut candidates = vec![
                    json!({"index":7,"finishReason":reason,"finishMessage":"original","content":{"parts":[{"text":"seven"}]}}),
                    json!({"index":3,"finishReason":"STOP","content":{"parts":[{"text":"three"}]}}),
                ];
                if reversed {
                    candidates.reverse();
                }
                let response =
                    project_gemini_response(&json!({"candidates":candidates}), "mixed").unwrap();
                assert_eq!(response["status"], "incomplete");
                assert_eq!(response["incomplete_details"]["reason"], incomplete);
                let rows = response["gemini_candidate_outcomes"]
                    .as_array()
                    .expect("original candidate outcomes");
                for (index, terminal, text) in [(7, reason, "seven"), (3, "STOP", "three")] {
                    let row = rows.iter().find(|r| r["candidate_index"] == index).unwrap();
                    assert_eq!(row["finishReason"], terminal);
                    let output = row["output_indices"][0].as_u64().unwrap() as usize;
                    assert_eq!(response["output"][output]["content"][0]["text"], text);
                }
                assert_eq!(
                    rows.iter().find(|r| r["candidate_index"] == 7).unwrap()["finishMessage"],
                    "original"
                );
            }
        }
    }

    #[test]
    fn gemini_terminal_json_unfinished_is_not_default_stop_or_prompt_block() {
        for reason in [None, Some(""), Some("FINISH_REASON_UNSPECIFIED")] {
            for feedback in ["", "BLOCK_REASON_UNSPECIFIED", "SAFETY"] {
                let mut candidate = json!({"content":{"parts":[{"text":"unfinished"}]}});
                if let Some(reason) = reason {
                    candidate["finishReason"] = json!(reason);
                }
                assert!(project_gemini_response(
                    &json!({"candidates":[candidate],"promptFeedback":{"blockReason":feedback}}),
                    "unfinished"
                )
                .is_err());
            }
        }
    }
    #[test]
    fn gemini_prompt_feedback_is_the_terminal_without_candidates() {
        for reason in [
            "SAFETY",
            "OTHER",
            "BLOCKLIST",
            "PROHIBITED_CONTENT",
            "IMAGE_SAFETY",
        ] {
            for candidates in [None, Some(json!([]))] {
                let mut payload = json!({"promptFeedback":{"blockReason":reason,"safetyRatings":[{"category":"original"}]},"usageMetadata":{"promptTokenCount":7,"totalTokenCount":7}});
                if let Some(candidates) = candidates {
                    payload["candidates"] = candidates;
                }
                let response = project_gemini_response(&payload, "blocked").unwrap();
                assert_eq!(response["status"], "incomplete");
                assert_eq!(response["incomplete_details"]["reason"], "content_filter");
                assert_eq!(response["finishReason"], reason);
                assert_eq!(response["promptFeedback"], payload["promptFeedback"]);
                assert_eq!(response["usage"]["total_tokens"], 7);
                assert_eq!(response["output"], json!([]));
            }
        }
        for feedback in [
            json!({}),
            json!({"blockReason":""}),
            json!({"blockReason":"BLOCK_REASON_UNSPECIFIED"}),
        ] {
            assert!(
                project_gemini_response(&json!({"promptFeedback":feedback}), "not_blocked")
                    .is_err()
            );
        }
    }

    #[test]
    fn gemini_signatures_remain_call_local_through_canonical_history() {
        use super::super::responses_openai_codec::project_v3_responses_tool_call_to_openai_chat;
        let payload = json!({"candidates":[{"content":{"parts":[
            {"functionCall":{"id":"signed","name":"function","args":{"left":19,"right":23}},"thoughtSignature":"opaque/function/+=="},
            {"functionCall":{"id":"custom","name":"custom","args":{"input":"19 + 23"}},"thoughtSignature":"opaque/custom/+=="},
            {"functionCall":{"id":"unsigned","name":"unsigned","args":"{malformed"}}
        ]},"finishReason":"STOP"}]});
        let mut response = project_gemini_response(&payload, "signed_request").unwrap();
        let registry =
            provider_compat_core::namespace_tools::NamespaceToolIdentityRegistry::from_request(
                &json!({"tools":[{"type":"custom","name":"custom","format":{"type":"text"}}]}),
                "gemini",
            )
            .unwrap();
        restore_gemini_tool_kinds(&mut response, &registry);
        assert_eq!(response["output"][1]["type"], "custom_tool_call");
        for (index, item) in response["output"].as_array().unwrap().iter().enumerate() {
            let original = &payload["candidates"][0]["content"]["parts"][index];
            assert_eq!(
                item.get("thought_signature"),
                original.get("thoughtSignature")
            );
            let call = project_v3_responses_tool_call_to_openai_chat(
                item.as_object().unwrap(),
                item["call_id"].as_str().unwrap(),
                item["name"].as_str().unwrap(),
            );
            assert_eq!(
                call.get("thought_signature"),
                original.get("thoughtSignature")
            );
        }
        assert_eq!(response["output"][2]["arguments"], "{malformed");
    }

    #[test]
    fn gemini_normalization_preserves_malformed_arguments_and_provider_terminal() {
        let response = project_gemini_response(&json!({"responseId":"provider_id","candidates":[{
            "content":{"parts":[{"functionCall":{"id":"provider_call","name":"unregistered","args":"{malformed"}}]},
            "finishReason":"SAFETY"
        }],"usageMetadata":{"promptTokenCount":2,"candidatesTokenCount":3,"totalTokenCount":5}}), "request_identity").unwrap();
        assert_eq!(response["output"][0]["arguments"], "{malformed");
        assert_eq!(response["output"][0]["call_id"], "provider_call");
        assert_eq!(response["status"], "incomplete");
        assert_eq!(response["incomplete_details"]["reason"], "content_filter");
        assert_eq!(response["usage"]["total_tokens"], 5);
    }

    #[test]
    fn gemini_custom_wrapper_keeps_extra_business_arguments() {
        let registry = provider_compat_core::namespace_tools::NamespaceToolIdentityRegistry::from_request(
            &json!({"tools":[{"type":"custom","name":"declared_custom","format":{"type":"text"}}]}), "gemini",
        ).unwrap();
        let arguments = r#"{"input":"complete","extra":[1,2]}"#;
        let mut response = json!({"output":[{"type":"function_call","name":"declared_custom","arguments":arguments,"call_id":"provider_call"}]});
        restore_gemini_tool_kinds(&mut response, &registry);
        assert_eq!(response["output"][0]["type"], "custom_tool_call");
        assert_eq!(response["output"][0]["input"], arguments);
        assert_eq!(response["output"][0]["call_id"], "provider_call");
    }
}

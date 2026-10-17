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
                let id = item_row.get("id").cloned().unwrap_or_else(|| {
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
            .get("index").cloned()
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

/// Adjacent client projection. Input must be the final governed Responses
/// semantic payload; source protocol selects native identity/terminal rules.
pub(crate) fn project_responses_to_gemini_client(
    payload: &Value,
    source: super::V3HubProviderWireProtocol,
) -> Result<Value, String> {
    use super::V3HubProviderWireProtocol;
    let root = payload.as_object().ok_or("governed response must be an object")?;
    let output = root.get("output").and_then(Value::as_array);
    let mut response = root.clone();
    for key in ["id", "object", "output", "output_text", "status", "incomplete_details", "usage", "gemini_candidate_outcomes", "finishReason"] {
        response.remove(key);
    }
    let mut candidates = Vec::new();
    if source == V3HubProviderWireProtocol::Gemini {
        if let Some(outcomes) = root.get("gemini_candidate_outcomes").and_then(Value::as_array) {
            for outcome in outcomes {
                let mut candidate = outcome.as_object().cloned().ok_or("Gemini candidate outcome must be an object")?;
                candidate.remove("candidate_index");
                candidate.remove("output_indices");
                let mut parts = Vec::new();
                for index in outcome.get("output_indices").and_then(Value::as_array).into_iter().flatten() {
                    let item = index.as_u64().and_then(|i| output.and_then(|items| items.get(i as usize))).ok_or("Gemini output association is unavailable")?;
                    parts.extend(gemini_parts_from_governed_item(item, source)?);
                }
                if !parts.is_empty() || candidate.get("content").is_some() {
                    let content = candidate.entry("content").or_insert_with(|| json!({}));
                    let content = content.as_object_mut().ok_or("Gemini content must be an object")?;
                    content.insert("parts".into(), Value::Array(parts));
                }
                candidates.push(Value::Object(candidate));
            }
        }
    } else {
        let mut parts = Vec::new();
        for item in output.into_iter().flatten() {
            parts.extend(gemini_parts_from_governed_item(item, source)?);
        }
        let mut candidate = json!({"content":{"role":"model","parts":parts}});
        let reason = root.get("finishReason").and_then(Value::as_str)
            .or_else(|| root.get("finish_reason").and_then(Value::as_str))
            .or_else(|| payload.pointer("/incomplete_details/reason").and_then(Value::as_str));
        let hub_reason = match reason {
            Some("length" | "max_output_tokens") => Some("max_tokens"),
            Some("end_turn" | "tool_calls") => Some("stop"),
            Some(reason) => Some(reason),
            None if root.get("status").and_then(Value::as_str) == Some("completed") => Some("stop"),
            None => None,
        };
        if let Some(reason) = hub_reason {
            let mapped = crate::protocol_tables::map_value(
                crate::protocol_tables::V3TableKind::FinishReason, "gemini", reason,
                crate::protocol_tables::V3TableDirection::Outbound,
            )?;
            candidate["finishReason"] = json!(mapped.unwrap_or(reason));
        }
        candidates.push(candidate);
        if let Some(id) = root.get("id") {
            response.insert("responseId".into(), id.clone());
        }
    }
    response.insert("candidates".into(), Value::Array(candidates));
    if let Some(usage) = root.get("usage") {
        if let Some(fields) = usage.as_object() {
            let mut projected = fields.clone();
            for (canonical, native) in [
                ("input_tokens", "promptTokenCount"), ("prompt_tokens", "promptTokenCount"),
                ("output_tokens", "candidatesTokenCount"), ("completion_tokens", "candidatesTokenCount"),
                ("total_tokens", "totalTokenCount"),
            ] {
                if let Some(value) = fields.get(canonical) {
                    projected.insert(native.into(), value.clone());
                }
                projected.remove(canonical);
            }
            if let Some(value) = usage.pointer("/input_tokens_details/cached_tokens") {
                projected.insert("cachedContentTokenCount".into(), value.clone());
            }
            if let Some(value) = usage.pointer("/output_tokens_details/reasoning_tokens") {
                projected.insert("thoughtsTokenCount".into(), value.clone());
            }
            response.insert("usageMetadata".into(), Value::Object(projected));
        } else {
            response.insert("usageMetadata".into(), usage.clone());
        }
    }
    Ok(Value::Object(response))
}

fn gemini_parts_from_governed_item(item: &Value, source: super::V3HubProviderWireProtocol) -> Result<Vec<Value>, String> {
    match item.get("type").and_then(Value::as_str) {
        Some("message") => {
            let mut parts = Vec::new();
            for part in item.get("content").and_then(Value::as_array).into_iter().flatten() {
                let mut part = part.clone();
                if matches!(part.get("type").and_then(Value::as_str), Some("output_text" | "text")) {
                    part.as_object_mut().unwrap().remove("type");
                }
                parts.push(part);
            }
            Ok(parts)
        }
        Some("output_text" | "text") => {
            let mut part = item.clone();
            part.as_object_mut().unwrap().remove("type");
            Ok(vec![part])
        }
        Some("function_call" | "custom_tool_call" | "tool_call") => {
            let mut call = item.as_object().cloned().ok_or("tool item must be an object")?;
            let args = call.remove("arguments").or_else(|| call.remove("input"));
            if let Some(args) = args {
                let args = match args {
                    Value::String(text) => serde_json::from_str(&text).unwrap_or(Value::String(text)),
                    value => value,
                };
                call.insert("args".into(), args);
            }
            if source != super::V3HubProviderWireProtocol::Gemini {
                if let Some(id) = call.get("call_id").cloned() { call.insert("id".into(), id); }
            }
            for field in ["type", "call_id"] { call.remove(field); }
            let signature = call.remove("thought_signature");
            let mut part = json!({"functionCall":call});
            if let Some(signature) = signature { part["thoughtSignature"] = signature; }
            Ok(vec![part])
        }
        Some("reasoning") => {
            let mut parts = Vec::new();
            for content in item.get("summary").or_else(|| item.get("content")).and_then(Value::as_array).into_iter().flatten() {
                let mut part = content.clone();
                if let Some(part) = part.as_object_mut() { part.remove("type"); part.insert("thought".into(), json!(true)); }
                parts.push(part);
            }
            if let Some(signature) = item.get("encrypted_content").or_else(|| item.get("thought_signature")) {
                if parts.is_empty() { parts.push(json!({"thought":true})); }
                parts[0]["thoughtSignature"] = signature.clone();
            }
            Ok(parts)
        }
        _ => Ok(vec![item.clone()]),
    }
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
    #[test]
    fn gemini_client_inverse_preserves_candidate_parts_and_native_id_presence() {
        use super::*;
        let source = json!({"responseId":"native","opaque":{"keep":true},"candidates":[
            {"index":4,"content":{"role":"model","parts":[{"text":"one","opaque":1},{"inlineData":{"mimeType":"image/png","data":"AA=="}}]},"finishReason":"MAX_TOKENS"},
            {"content":{"parts":[{"functionCall":{"name":"tool","args":"invalid arguments"},"thoughtSignature":"sig"}]},"finishReason":"STOP"}
        ],"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":2,"totalTokenCount":9,"opaqueCount":11}});
        let canonical = project_gemini_response(&source, "real-request").unwrap();
        let projected = project_responses_to_gemini_client(&canonical, crate::hub_v1::V3HubProviderWireProtocol::Gemini).unwrap();
        assert_eq!(projected, source);
    }

    #[test]
    fn gemini_client_inverse_keeps_all_parts_and_raw_tool_arguments() {
        use super::*;
        let canonical = json!({"id":"upstream","status":"completed","output":[
            {"type":"message","content":[{"type":"output_text","text":"first"},{"type":"output_text","text":"second","annotation":1}]},
            {"type":"function_call","call_id":"paired","name":"tool","arguments":"broken json"}
        ],"usage":{"input_tokens":7,"output_tokens":2,"total_tokens":9}});
        let projected = project_responses_to_gemini_client(&canonical, crate::hub_v1::V3HubProviderWireProtocol::Responses).unwrap();
        assert_eq!(projected["candidates"][0]["content"]["parts"], json!([
            {"text":"first"},{"text":"second","annotation":1},{"functionCall":{"id":"paired","name":"tool","args":"broken json"}}
        ]));
        assert_eq!(projected["usageMetadata"]["totalTokenCount"], 9);
        assert_eq!(projected["candidates"][0]["finishReason"], "STOP");
    }

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

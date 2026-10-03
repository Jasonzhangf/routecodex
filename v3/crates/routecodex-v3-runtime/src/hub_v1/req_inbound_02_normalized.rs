use super::{
    encode_v3_anthropic_request_as_responses_semantic, normalize_v3_history_image_placeholders,
    V3HubEntryProtocol, V3HubReqInbound01ClientRaw, V3HubRequestSemanticProtocol,
};
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqInbound02Normalized {
    pub(crate) previous: V3HubReqInbound01ClientRaw,
    pub(crate) semantic_protocol: V3HubRequestSemanticProtocol,
    pub(crate) canonicalized_from_responses: bool,
    pub(crate) memory_raw_capture_guidance_injected: bool,
}

pub fn build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01(
    input: V3HubReqInbound01ClientRaw,
) -> V3HubReqInbound02Normalized {
    build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(input)
        .expect("V3 ReqInbound02 normalization failed")
}

pub fn build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(
    mut input: V3HubReqInbound01ClientRaw,
) -> Result<V3HubReqInbound02Normalized, String> {
    if input.entry_protocol == V3HubEntryProtocol::Responses
        && (input.payload.0.get("input").is_some()
            || input
                .payload
                .0
                .get("messages")
                .and_then(serde_json::Value::as_array)
                .is_none())
    {
        // canonical 化前先清洗原始 responses payload：此时 fco output 图片还是
        // 数组形态，normalize 能正确替换为 [Image]；canonical 转换会把数组
        // 序列化成字符串 content，若转换后再清洗会漏掉图片 base64（字符串
        // content 不被 normalize 识别，图片原样进 provider wire → context 400）。
        let raw = Arc::make_mut(&mut input.payload.0);
        normalize_v3_history_image_placeholders(raw);
        let mut canonical =
            super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload_for_req_inbound_compat(raw)
                .map_err(|error| format!("Responses inbound canonicalization failed: {error}"))?;
        if let Some(source) = raw.get("messages").filter(|value| !value.is_null()) {
            let source = source.as_array().ok_or_else(|| {
                "Responses inbound canonicalization failed: messages must be an array".to_string()
            })?;
            let decoded = canonical["messages"]
                .as_array()
                .expect("codec Chat messages");
            canonical["messages"] = Value::Array(merge_responses_chat_histories(source, decoded)?);
        }
        normalize_v3_history_image_placeholders(&mut canonical);
        input.payload.0 = Arc::new(canonical);
        return Ok(V3HubReqInbound02Normalized {
            previous: input,
            semantic_protocol: V3HubRequestSemanticProtocol::Chat,
            canonicalized_from_responses: true,
            memory_raw_capture_guidance_injected: false,
        });
    }
    if input.entry_protocol == V3HubEntryProtocol::Anthropic {
        let source_payload = std::mem::replace(&mut input.payload.0, Arc::new(Value::Null));
        let source_payload = Arc::try_unwrap(source_payload).unwrap_or_else(|arc| (*arc).clone());
        let mut responses_semantic = if source_payload
            .get("input")
            .and_then(serde_json::Value::as_array)
            .is_some()
        {
            source_payload
        } else {
            encode_v3_anthropic_request_as_responses_semantic(source_payload)
                .map_err(|error| format!("Anthropic inbound semantic projection failed: {error}"))?
        };
        let mut anthropic_preserved_fields = Vec::new();
        let mut anthropic_reasoning_effort = None;
        let mut anthropic_request_extension = None;
        if let Some(object) = responses_semantic.as_object_mut() {
            anthropic_reasoning_effort = object.remove("reasoning_effort");
            anthropic_request_extension = object.remove("routecodex_chat_extension");
            for key in [
                "context_management",
                "output_config",
                "reasoning_budget_tokens",
                "reasoning_display_policy",
                "reasoning_thinking_mode",
            ] {
                if let Some(value) = object.remove(key) {
                    anthropic_preserved_fields.push((key.to_string(), value));
                }
            }
        }
        let mut canonical =
            super::responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload(
                &responses_semantic,
            )
            .map_err(|error| format!("Anthropic inbound Chat canonicalization failed: {error}"))?;
        if let Some(canonical_object) = canonical.as_object_mut() {
            for (key, value) in anthropic_preserved_fields {
                canonical_object.insert(key, value);
            }
            if let Some(value) = anthropic_reasoning_effort {
                canonical_object.insert("reasoning_effort".to_string(), value);
            }
            if let Some(value) = anthropic_request_extension {
                if canonical_object.contains_key("routecodex_chat_extension") {
                    return Err(
                        "Anthropic inbound produced conflicting registered Chat extensions"
                            .to_string(),
                    );
                }
                canonical_object.insert("routecodex_chat_extension".to_string(), value);
            }
        }
        normalize_v3_history_image_placeholders(&mut canonical);
        input.payload.0 = Arc::new(canonical);
        return Ok(V3HubReqInbound02Normalized {
            previous: input,
            semantic_protocol: V3HubRequestSemanticProtocol::Chat,
            canonicalized_from_responses: true,
            memory_raw_capture_guidance_injected: false,
        });
    }
    if let Some(payload) = Arc::get_mut(&mut input.payload.0) {
        normalize_v3_history_image_placeholders(payload);
    } else {
        let mut payload = (*input.payload.0).clone();
        normalize_v3_history_image_placeholders(&mut payload);
        input.payload.0 = Arc::new(payload);
    }
    Ok(V3HubReqInbound02Normalized {
        previous: input,
        semantic_protocol: V3HubRequestSemanticProtocol::Chat,
        canonicalized_from_responses: false,
        memory_raw_capture_guidance_injected: false,
    })
}

fn merge_responses_chat_histories(
    source: &[Value],
    decoded: &[Value],
) -> Result<Vec<Value>, String> {
    if source.len() == decoded.len() {
        if let Some(merged) = source
            .iter()
            .zip(decoded)
            .map(|(source, decoded)| merge_equivalent_chat_value(source, decoded))
            .collect::<Option<Vec<_>>>()
        {
            return Ok(merged);
        }
    }
    // Legacy public hook callers supply preceding Chat calls and current Responses
    // results. Decode the results first; Req04 still owns id/kind pairing.
    if decoded.iter().all(|message| message["role"] == "tool") {
        let mut merged = source.to_vec();
        for result in decoded {
            if let Some(existing) = merged.iter_mut().find(|message| {
                message["role"] == "tool"
                    && message.get("tool_call_id") == result.get("tool_call_id")
            }) {
                *existing = merge_equivalent_chat_value(existing, result).ok_or_else(|| {
                    "Responses inbound canonicalization failed: conflicting tool output representations".to_string()
                })?;
            } else {
                merged.push(result.clone());
            }
        }
        return Ok(merged);
    }
    Err(
        "Responses inbound canonicalization failed: conflicting input and messages representations"
            .to_string(),
    )
}

fn merge_equivalent_chat_value(source: &Value, decoded: &Value) -> Option<Value> {
    match (source, decoded) {
        (Value::Object(source), Value::Object(decoded)) => {
            let empty_assistant_content = |object: &serde_json::Map<String, Value>| {
                object.get("role").is_some_and(|role| role == "assistant")
                    && object
                        .get("tool_calls")
                        .and_then(Value::as_array)
                        .is_some_and(|calls| !calls.is_empty())
                    && object
                        .get("content")
                        .is_none_or(|content| content.is_null() || content.as_str() == Some(""))
            };
            let semantic_keys = |object: &serde_json::Map<String, Value>| {
                object
                    .keys()
                    .filter(|key| {
                        key.as_str() != "routecodex_chat_extension"
                            && !(key.as_str() == "content" && empty_assistant_content(object))
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            };
            if semantic_keys(source) != semantic_keys(decoded) {
                return None;
            }
            let mut merged = source.clone();
            for (key, value) in decoded {
                if key == "routecodex_chat_extension" {
                    let mut fields = match source.get(key) {
                        Some(source) => source.as_object()?.clone(),
                        None => serde_json::Map::new(),
                    };
                    for (field, value) in value.as_object()? {
                        if let Some(existing) = fields.get(field) {
                            if existing != value {
                                return None;
                            }
                        } else {
                            fields.insert(field.clone(), value.clone());
                        }
                    }
                    merged.insert(key.clone(), Value::Object(fields));
                } else if key == "content"
                    && empty_assistant_content(source)
                    && empty_assistant_content(decoded)
                {
                    // Chat assistant tool calls permit absent/null content; the
                    // Responses codec spells that same empty content as "".
                } else if key == "content"
                    && comparable_chat_content(&source[key]) == comparable_chat_content(value)
                {
                    // Preserve the source representation; only singleton plain text
                    // is equivalent to its scalar Chat spelling.
                } else {
                    merged.insert(
                        key.clone(),
                        merge_equivalent_chat_value(&source[key], value)?,
                    );
                }
            }
            Some(Value::Object(merged))
        }
        (Value::Array(source), Value::Array(decoded)) if source.len() == decoded.len() => source
            .iter()
            .zip(decoded)
            .map(|(source, decoded)| merge_equivalent_chat_value(source, decoded))
            .collect::<Option<Vec<_>>>()
            .map(Value::Array),
        _ if source == decoded => Some(source.clone()),
        _ => None,
    }
}

fn comparable_chat_content(content: &Value) -> &Value {
    if let Some(parts) = content.as_array() {
        if parts.len() == 1
            && parts[0].as_object().is_some_and(|part| part.len() == 2)
            && parts[0]["type"] == "text"
            && parts[0]["text"].is_string()
        {
            return &parts[0]["text"];
        }
    }
    content
}

pub fn build_v3_hub_req_inbound_02_responses_chat_canonical_from_v3_hub_req_inbound_01(
    input: V3HubReqInbound01ClientRaw,
) -> Result<V3HubReqInbound02Normalized, String> {
    if input.entry_protocol != V3HubEntryProtocol::Responses {
        return Err(
            "Responses inbound canonicalization requires the Responses entry protocol".to_string(),
        );
    }
    build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(input)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn malformed_responses_inbound_canonicalization_failure_does_not_enter_chat_process() {
        let raw = super::super::build_v3_hub_req_inbound_01_client_raw(
            json!({
                "model": "gpt-5.5",
                "input": [{
                    "type": "unsupported_provider_private_event",
                    "payload": {"query": "RouteCodex"}
                }]
            }),
            V3HubEntryProtocol::Responses,
            super::super::V3HubInvocationSource::Client,
            super::super::V3HubTransportIntent::Json,
        );

        let result =
            build_v3_hub_req_inbound_02_responses_chat_canonical_from_v3_hub_req_inbound_01(raw);
        assert!(
            result.is_err(),
            "unsupported Responses inbound canonicalization must fail-fast before Chat Process instead of silently continuing as non-canonicalized Chat"
        );
    }

    #[test]
    fn responses_tool_history_is_normalized_to_chat_extension_without_raw_payload_carry() {
        let raw = super::super::build_v3_hub_req_inbound_01_client_raw(
            json!({
                "model": "gpt-5.5",
                "input": [{
                    "type": "web_search_call",
                    "status": "failed",
                    "action": {"type": "search", "query": "RouteCodex"}
                }]
            }),
            V3HubEntryProtocol::Responses,
            super::super::V3HubInvocationSource::Client,
            super::super::V3HubTransportIntent::Json,
        );

        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw).expect(
            "Responses inbound must normalize hosted tool history into Chat extension data",
        );
        assert!(normalized.canonicalized_from_responses);
        assert!(
            normalized.previous.payload.0.get("messages").is_some(),
            "ReqInbound must pass Chat-normalized data forward, not raw Responses payload"
        );
        assert!(
            normalized.previous.payload.0.get("input").is_none(),
            "raw Responses input must not be carried across ReqInbound after normalization"
        );
    }

    #[test]
    fn responses_request_data_fields_enter_typed_chat_extension_without_raw_field_carry() {
        let client_metadata = json!({
            "session_id": "session-1",
            "thread_id": "thread-1",
            "turn_id": "turn-1"
        });
        let raw = super::super::build_v3_hub_req_inbound_01_client_raw(
            json!({
                "model": "gpt-5.5",
                "input": "hello",
                "client_metadata": client_metadata,
                "prompt_cache_key": "session-1",
                "store": false,
                "text": {"verbosity": "high"}
            }),
            V3HubEntryProtocol::Responses,
            super::super::V3HubInvocationSource::Client,
            super::super::V3HubTransportIntent::Json,
        );

        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect("Responses request fields must normalize into Chat extension data");
        let payload = &normalized.previous.payload.0;
        let extension = &payload["routecodex_chat_extension"]["responses_request"];

        assert_eq!(extension["client_metadata"], client_metadata);
        assert_eq!(extension["prompt_cache_key"], "session-1");
        assert_eq!(extension["store"], false);
        assert_eq!(extension["text"], json!({"verbosity":"high"}));
        for raw_field in ["client_metadata", "prompt_cache_key", "store", "text"] {
            assert!(
                payload.get(raw_field).is_none(),
                "Responses field {raw_field} must not cross ReqInbound as a raw top-level payload field: {payload}"
            );
        }
    }

    #[test]
    fn responses_continuation_locator_does_not_enter_chat_canonical_payload() {
        let raw = super::super::build_v3_hub_req_inbound_01_client_raw(
            json!({
                "model": "gpt-5.5",
                "previous_response_id": "resp_local_continuation",
                "input": [{
                    "type": "function_call_output",
                    "call_id": "call_lookup",
                    "output": "done"
                }]
            }),
            V3HubEntryProtocol::Responses,
            super::super::V3HubInvocationSource::Client,
            super::super::V3HubTransportIntent::Json,
        );

        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect("Responses continuation input must normalize to Chat");

        assert!(normalized.previous.payload.0.get("messages").is_some());
        assert!(
            normalized
                .previous
                .payload
                .0
                .get("previous_response_id")
                .is_none(),
            "continuation control locator must be consumed by its owner and never cross ReqInbound02 as Chat payload"
        );
    }

    #[test]
    fn anthropic_system_extension_survives_req02_chat_canonicalization() {
        let system = json!([
            {"type":"text","text":"dynamic system"},
            {"type":"text","text":"cached system","cache_control":{"type":"ephemeral"}}
        ]);
        let raw = super::super::build_v3_hub_req_inbound_01_client_raw(
            json!({
                "model":"claude-test",
                "max_tokens":128,
                "system":system,
                "context_management":{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]},
                "output_config":{"effort":"high"},
                "thinking":{"type":"enabled","budget_tokens":1024,"display":"omitted"},
                "messages":[{"role":"user","content":"hello"}]
            }),
            super::super::V3HubEntryProtocol::Anthropic,
            super::super::V3HubInvocationSource::Client,
            super::super::V3HubTransportIntent::Json,
        );

        let normalized = build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01(raw)
            .expect("Anthropic system data must survive non-destructive Req02 normalization");

        assert_eq!(
            normalized.previous.payload.0["routecodex_chat_extension"]["anthropic_request"]
                ["system"],
            system
        );
        assert_eq!(
            normalized.previous.payload.0["context_management"],
            json!({"edits":[{"type":"clear_thinking_20251015","keep":"all"}]})
        );
        assert_eq!(normalized.previous.payload.0["reasoning_effort"], "high");
        assert_eq!(
            normalized.previous.payload.0["reasoning_thinking_mode"],
            "enabled"
        );
        assert_eq!(
            normalized.previous.payload.0["reasoning_budget_tokens"],
            1024
        );
        assert_eq!(
            normalized.previous.payload.0["reasoning_display_policy"],
            "omitted"
        );
        assert!(
            normalized.previous.payload.0.get("output_config").is_none(),
            "Anthropic effort must normalize into Chat reasoning_effort before Chat Process"
        );
    }
}

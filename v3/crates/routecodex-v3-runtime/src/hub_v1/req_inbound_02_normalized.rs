use super::{
    build_v3_chat_canonical_request_from_responses_payload_for_req_inbound,
    encode_v3_anthropic_request_as_responses_semantic, V3HubEntryProtocol,
    V3HubReqInbound01ClientRaw, V3HubRequestSemanticProtocol,
};

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqInbound02Normalized {
    pub(crate) previous: V3HubReqInbound01ClientRaw,
    pub(crate) semantic_protocol: V3HubRequestSemanticProtocol,
    pub(crate) canonicalized_from_responses: bool,
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
        && input
            .payload
            .0
            .get("messages")
            .and_then(serde_json::Value::as_array)
            .is_none()
    {
        let canonical = build_v3_chat_canonical_request_from_responses_payload_for_req_inbound(
            &input.payload.0,
        )
        .map_err(|error| format!("Responses inbound canonicalization failed: {error}"))?;
        input.payload.0 = canonical;
        return Ok(V3HubReqInbound02Normalized {
            previous: input,
            semantic_protocol: V3HubRequestSemanticProtocol::Chat,
            canonicalized_from_responses: true,
        });
    }
    if input.entry_protocol == V3HubEntryProtocol::Anthropic {
        let source_payload = std::mem::take(&mut input.payload.0);
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
        let mut canonical = build_v3_chat_canonical_request_from_responses_payload_for_req_inbound(
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
        input.payload.0 = canonical;
        return Ok(V3HubReqInbound02Normalized {
            previous: input,
            semantic_protocol: V3HubRequestSemanticProtocol::Chat,
            canonicalized_from_responses: true,
        });
    }
    Ok(V3HubReqInbound02Normalized {
        previous: input,
        semantic_protocol: V3HubRequestSemanticProtocol::Chat,
        canonicalized_from_responses: false,
    })
}

pub fn build_v3_hub_req_inbound_02_responses_chat_canonical_from_v3_hub_req_inbound_01(
    input: V3HubReqInbound01ClientRaw,
) -> Result<V3HubReqInbound02Normalized, String> {
    if input.entry_protocol != V3HubEntryProtocol::Responses {
        return Err(
            "Responses inbound canonicalization requires the Responses entry protocol".to_string(),
        );
    }
    if input
        .payload
        .0
        .get("messages")
        .and_then(serde_json::Value::as_array)
        .is_some()
    {
        return Ok(V3HubReqInbound02Normalized {
            previous: input,
            semantic_protocol: V3HubRequestSemanticProtocol::Chat,
            canonicalized_from_responses: false,
        });
    }
    let mut input = input;
    let canonical =
        build_v3_chat_canonical_request_from_responses_payload_for_req_inbound(&input.payload.0)
            .map_err(|error| format!("Responses inbound canonicalization failed: {error}"))?;
    input.payload.0 = canonical;
    Ok(V3HubReqInbound02Normalized {
        previous: input,
        semantic_protocol: V3HubRequestSemanticProtocol::Chat,
        canonicalized_from_responses: true,
    })
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

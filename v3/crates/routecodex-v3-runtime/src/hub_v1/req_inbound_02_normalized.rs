use super::{
    build_v3_chat_canonical_request_from_responses_payload_for_req_inbound,
    responses_payload_needs_req04_original_surface, V3HubEntryProtocol, V3HubReqInbound01ClientRaw,
    V3HubRequestSemanticProtocol,
};

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqInbound02Normalized {
    pub(crate) previous: V3HubReqInbound01ClientRaw,
    pub(crate) semantic_protocol: V3HubRequestSemanticProtocol,
    pub(crate) canonicalized_from_responses: bool,
    pub(crate) original_responses_payload: Option<serde_json::Value>,
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
        if responses_payload_needs_req04_original_surface(&input.payload.0) {
            let original_responses_payload = input.payload.0.clone();
            return Ok(V3HubReqInbound02Normalized {
                previous: input,
                semantic_protocol: V3HubRequestSemanticProtocol::Chat,
                canonicalized_from_responses: false,
                original_responses_payload: Some(original_responses_payload),
            });
        }
        let canonical = build_v3_chat_canonical_request_from_responses_payload_for_req_inbound(
            &input.payload.0,
        )
        .map_err(|error| format!("Responses inbound canonicalization failed: {error}"))?;
        let original_responses_payload = std::mem::replace(&mut input.payload.0, canonical);
        return Ok(V3HubReqInbound02Normalized {
            previous: input,
            semantic_protocol: V3HubRequestSemanticProtocol::Chat,
            canonicalized_from_responses: true,
            original_responses_payload: Some(original_responses_payload),
        });
    }
    Ok(V3HubReqInbound02Normalized {
        previous: input,
        semantic_protocol: V3HubRequestSemanticProtocol::Chat,
        canonicalized_from_responses: false,
        original_responses_payload: None,
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
            original_responses_payload: None,
        });
    }
    let mut input = input;
    let canonical =
        build_v3_chat_canonical_request_from_responses_payload_for_req_inbound(&input.payload.0)
            .map_err(|error| format!("Responses inbound canonicalization failed: {error}"))?;
    let original_responses_payload = std::mem::replace(&mut input.payload.0, canonical);
    Ok(V3HubReqInbound02Normalized {
        previous: input,
        semantic_protocol: V3HubRequestSemanticProtocol::Chat,
        canonicalized_from_responses: true,
        original_responses_payload: Some(original_responses_payload),
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
    fn responses_original_surface_is_preserved_without_req_inbound_synthesis() {
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
            "original Responses tool surface must remain available for Req04/ReqOutbound owners",
        );
        assert!(!normalized.canonicalized_from_responses);
        assert!(normalized.original_responses_payload.is_some());
        assert!(
            normalized.previous.payload.0.get("input").is_some(),
            "ReqInbound must preserve original Responses input instead of synthesizing Chat tool history"
        );
    }
}

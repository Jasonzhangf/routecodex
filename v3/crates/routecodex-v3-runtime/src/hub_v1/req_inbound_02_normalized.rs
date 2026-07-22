use super::{
    build_v3_chat_canonical_request_from_responses_payload_for_req_inbound, V3HubEntryProtocol,
    V3HubReqInbound01ClientRaw, V3HubRequestSemanticProtocol,
};

#[derive(Debug, Clone, PartialEq)]
pub struct V3HubReqInbound02Normalized {
    pub(crate) previous: V3HubReqInbound01ClientRaw,
    pub(crate) semantic_protocol: V3HubRequestSemanticProtocol,
    pub(crate) canonicalized_from_responses: bool,
    pub(crate) original_responses_payload: Option<serde_json::Value>,
}

pub fn build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01(
    mut input: V3HubReqInbound01ClientRaw,
) -> V3HubReqInbound02Normalized {
    if input.entry_protocol == V3HubEntryProtocol::Responses
        && input
            .payload
            .0
            .get("messages")
            .and_then(serde_json::Value::as_array)
            .is_none()
    {
        let (canonicalized_from_responses, original_responses_payload) = if let Ok(canonical) =
            build_v3_chat_canonical_request_from_responses_payload_for_req_inbound(&input.payload.0)
        {
            let original_responses_payload = std::mem::replace(&mut input.payload.0, canonical);
            (true, Some(original_responses_payload))
        } else {
            (false, None)
        };
        return V3HubReqInbound02Normalized {
            previous: input,
            semantic_protocol: V3HubRequestSemanticProtocol::Chat,
            canonicalized_from_responses,
            original_responses_payload,
        };
    }
    V3HubReqInbound02Normalized {
        previous: input,
        semantic_protocol: V3HubRequestSemanticProtocol::Chat,
        canonicalized_from_responses: false,
        original_responses_payload: None,
    }
}

pub fn build_v3_hub_req_inbound_02_responses_chat_canonical_from_v3_hub_req_inbound_01(
    mut input: V3HubReqInbound01ClientRaw,
) -> Result<V3HubReqInbound02Normalized, String> {
    if input.entry_protocol != V3HubEntryProtocol::Responses {
        return Err(
            "Responses inbound canonicalization requires the Responses entry protocol".to_string(),
        );
    }
    let mut canonicalized_from_responses = false;
    if input
        .payload
        .0
        .get("messages")
        .and_then(serde_json::Value::as_array)
        .is_none()
    {
        if let Ok(canonical) =
            build_v3_chat_canonical_request_from_responses_payload_for_req_inbound(&input.payload.0)
        {
            let original_responses_payload = std::mem::replace(&mut input.payload.0, canonical);
            canonicalized_from_responses = true;
            return Ok(V3HubReqInbound02Normalized {
                previous: input,
                semantic_protocol: V3HubRequestSemanticProtocol::Chat,
                canonicalized_from_responses,
                original_responses_payload: Some(original_responses_payload),
            });
        }
    }
    Ok(V3HubReqInbound02Normalized {
        previous: input,
        semantic_protocol: V3HubRequestSemanticProtocol::Chat,
        canonicalized_from_responses,
        original_responses_payload: None,
    })
}

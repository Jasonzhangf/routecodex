use super::{V3HubReqInbound01ClientRaw, V3HubRequestSemanticProtocol};
use crate::operation_runner::{
    execute_v3_operation_runner_request_normalize_losslessly, RequestInvocationContext,
    RequestNormalizationEntry, RequestOriginKind,
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

pub fn build_v3_hub_req_inbound_02_from_canonical(
    mut input: V3HubReqInbound01ClientRaw,
    canonical: Value,
) -> V3HubReqInbound02Normalized {
    input.payload.0 = Arc::new(canonical);
    V3HubReqInbound02Normalized {
        previous: input,
        semantic_protocol: V3HubRequestSemanticProtocol::Chat,
        canonicalized_from_responses: true,
        memory_raw_capture_guidance_injected: false,
    }
}

/// Consume the captured request through REQ02's registered SDK graph using
/// the Runtime's invocation identity and the same request-local resources.
/// Reentry carries canonical data; it does not normalize the original wire again.
pub fn build_v3_hub_req_inbound_02_from_request_invocation(
    input: V3HubReqInbound01ClientRaw,
    invocation: &RequestInvocationContext,
) -> Result<V3HubReqInbound02Normalized, String> {
    let payload = input.payload.0.as_ref().clone();
    let entry = match invocation.origin_kind() {
        RequestOriginKind::ClientEntry => RequestNormalizationEntry::RawEntry(payload),
        RequestOriginKind::Retry
        | RequestOriginKind::InternalFollowup
        | RequestOriginKind::DirectRelayHandoff => {
            RequestNormalizationEntry::AlreadyCanonical(payload)
        }
    };
    let canonical = execute_v3_operation_runner_request_normalize_losslessly(
        invocation.request_handle(),
        invocation,
        entry,
    )
    .map_err(|error| error.to_string())?;
    Ok(build_v3_hub_req_inbound_02_from_canonical(input, canonical))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn protocol_key(protocol: super::super::V3HubEntryProtocol) -> &'static str {
        match protocol {
            super::super::V3HubEntryProtocol::Responses => "responses",
            super::super::V3HubEntryProtocol::Anthropic => "anthropic",
            super::super::V3HubEntryProtocol::Gemini => "gemini",
            super::super::V3HubEntryProtocol::OpenAiChat => "openai_chat",
        }
    }

    fn inbound(
        payload: Value,
        protocol: super::super::V3HubEntryProtocol,
        request_id: &str,
    ) -> Result<V3HubReqInbound02Normalized, String> {
        // The request handle carries the declared entry protocol (not the test
        // case label) so REQ02 selects the matching field profile. The case
        // label only distinguishes request scopes.
        let invocation = crate::operation_runner::RequestInvocationContext::new(
            crate::operation_runner::V3RequestContextHandle::new(
                request_id.to_string(),
                protocol_key(protocol).to_string(),
            ),
            format!("{request_id}-entry"),
            format!("{request_id}-attempt"),
            crate::operation_runner::RequestOriginKind::ClientEntry,
        );
        build_v3_hub_req_inbound_02_from_request_invocation(
            super::super::build_v3_hub_req_inbound_01_client_raw(
                payload,
                protocol,
                super::super::V3HubInvocationSource::Client,
                super::super::V3HubTransportIntent::Json,
            ),
            &invocation,
        )
    }

    #[test]
    fn unknown_responses_native_event_is_preserved_with_inverse_association() {
        let raw = json!({
            "model": "gpt-5.5",
            "input": [{
                "type": "unsupported_provider_private_event",
                "payload": {"query": "RouteCodex"}
            }]
        });
        let normalized = inbound(
            raw,
            super::super::V3HubEntryProtocol::Responses,
            "responses-unknown",
        )
        .expect("unknown native Responses event must pass REQ02 instead of being rejected");

        assert_eq!(
            normalized.previous.payload.0["messages"][0]["type"],
            "unsupported_provider_private_event"
        );
        let opaque = &normalized.previous.payload.0["routecodex_chat_extension"]
            ["chat_extension_opaque_record"];
        assert!(
            opaque
                .as_array()
                .is_some_and(|records| records.iter().any(|record| {
                    record["path"] == "request.input[0]"
                        && record["value"]["type"] == "unsupported_provider_private_event"
                })),
            "unknown native event must keep an inverse association: {opaque}"
        );
    }

    #[test]
    fn responses_tool_history_is_normalized_to_chat_messages_without_raw_input_carry() {
        let raw = json!({
            "model": "gpt-5.5",
            "input": [{
                "type": "web_search_call",
                "status": "failed",
                "action": {"type": "search", "query": "RouteCodex"}
            }]
        });
        let normalized = inbound(
            raw.clone(),
            super::super::V3HubEntryProtocol::Responses,
            "responses-tool-history",
        )
        .expect("Responses hosted tool history must pass REQ02");
        assert!(normalized.previous.payload.0.get("messages").is_some());
        assert!(
            normalized.previous.payload.0.get("input").is_none(),
            "raw Responses input must not cross ReqInbound after normalization"
        );
        assert_eq!(normalized.previous.payload.0["messages"][0]["role"], "assistant");
        assert_eq!(
            normalized.previous.payload.0["messages"][0]["routecodex_chat_extension"]
                ["responses_hosted_history_event"],
            raw["input"][0],
            "the single current event must preserve all native fields without an inbound tool pair"
        );
    }

    #[test]
    fn responses_non_chat_fields_are_preserved_with_inverse_association() {
        let client_metadata = json!({
            "session_id": "session-1",
            "thread_id": "thread-1",
            "turn_id": "turn-1"
        });
        let raw = json!({
            "model": "gpt-5.5",
            "input": "hello",
            "client_metadata": client_metadata,
            "prompt_cache_key": "session-1",
            "store": false,
            "text": {"verbosity": "high"}
        });
        let invocation = crate::operation_runner::RequestInvocationContext::new(
            crate::operation_runner::V3RequestContextHandle::new(
                "responses-fields".to_string(),
                "responses".to_string(),
            ),
            "responses-fields-entry".to_string(),
            "responses-fields-attempt".to_string(),
            crate::operation_runner::RequestOriginKind::ClientEntry,
        );
        let normalized = build_v3_hub_req_inbound_02_from_request_invocation(
            super::super::build_v3_hub_req_inbound_01_client_raw(
                raw.clone(),
                super::super::V3HubEntryProtocol::Responses,
                super::super::V3HubInvocationSource::Client,
                super::super::V3HubTransportIntent::Json,
            ),
            &invocation,
        )
        .expect("Responses non-Chat fields must pass REQ02");
        let payload = &normalized.previous.payload.0;
        assert_eq!(
            payload["routecodex_chat_extension"]["responses_request"]["client_metadata"],
            client_metadata
        );
        assert_eq!(payload["prompt_cache_key"], "session-1");
        assert_eq!(payload["store"], false);
        assert_eq!(
            payload["routecodex_chat_extension"]["responses_request"]["text"],
            json!({"verbosity":"high"})
        );
        assert!(payload.get("input").is_none());
        assert!(payload.get("messages").is_some());
        let pair = invocation.request_handle().original_pair().unwrap();
        let current = crate::operation_runner::CurrentFieldAssociations::from_normalization(
            &pair.inverse_context,
        );
        let restored = crate::operation_runner::project_canonical_direct_request(
            payload,
            &pair.inverse_context,
            &current,
            &pair.explicit_history_pairing,
        )
        .expect("non-Chat fields must use their inverse associations");
        assert_eq!(restored.payload, raw);
        assert_eq!(invocation.request_handle().original_pair().unwrap(), pair);
    }

    #[test]
    fn responses_continuation_locator_is_preserved_until_owner_consumes() {
        let raw = json!({
            "model": "gpt-5.5",
            "previous_response_id": "resp_local_continuation",
            "input": [{
                "type": "function_call_output",
                "call_id": "call_lookup",
                "output": "done"
            }]
        });
        let normalized = inbound(
            raw,
            super::super::V3HubEntryProtocol::Responses,
            "responses-continuation",
        )
        .expect("Responses continuation input must normalize to Chat");
        assert!(normalized.previous.payload.0.get("messages").is_some());
        assert!(
            normalized
                .previous
                .payload
                .0
                .get("previous_response_id")
                .is_some(),
            "continuation locator must stay visible to its owner until consumed"
        );
        assert_eq!(
            normalized.previous.payload.0["messages"][0]["tool_call_id"],
            "call_lookup"
        );
    }

    #[test]
    fn anthropic_system_and_native_fields_survive_with_reasoning_mapping() {
        let system = json!([
            {"type":"text","text":"dynamic system"},
            {"type":"text","text":"cached system","cache_control":{"type":"ephemeral"}}
        ]);
        let raw = json!({
            "model":"claude-test",
            "max_tokens":128,
            "system":system,
            "context_management":{"edits":[{"type":"clear_thinking_20251015","keep":"all"}]},
            "output_config":{"effort":"high"},
            "thinking":{"type":"enabled","budget_tokens":1024,"display":"omitted"},
            "messages":[{"role":"user","content":"hello"}]
        });
        let normalized = inbound(
            raw,
            super::super::V3HubEntryProtocol::Anthropic,
            "anthropic-system",
        )
        .expect("Anthropic system data must survive non-destructive Req02 normalization");
        assert_eq!(
            normalized.previous.payload.0["messages"][0]["role"],
            "system"
        );
        assert_eq!(
            normalized.previous.payload.0["messages"][1]["content"],
            "hello"
        );
        // The reviewed profile must map Anthropic thinking/output_config into the
        // registered Chat reasoning_* destinations while keeping the inverse
        // association. These four assertions are the semantic contract; if they
        // are red the first divergence is the out-of-scope field owner's fix.
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
    }
}

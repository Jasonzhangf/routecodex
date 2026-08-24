use crate::hub_v1::{
    build_v3_toolreason_reasoning_done_projection_at_resp03, classify_v3_openai_chat_sse_chunk,
    classify_v3_provider_sse_json_data, classify_v3_responses_sse_event,
    normalize_v3_provider_sse_json_data_with_event_name, project_v3_openai_chat_sse_chunk_json,
    project_v3_responses_sse_event_json, V3HubProviderWireProtocol, V3OpenAiChatSseHookInput,
    V3OpenAiChatSseSemanticObject, V3OpenAiChatSseTreeError, V3ProviderResponsesJsonFrameOutcome,
    V3ResponsesSseHookInput, V3ResponsesSseSemanticObject, V3ResponsesSseTreeError,
};
use crate::sse_object_pipeline::{
    SseObjectConsumer, SseObjectConsumerAction, SseObjectError, SseObjectFrame,
};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3Error01SourceRaised, V3ErrorSourceKind,
};
use routecodex_v3_sse::{SseTransportError, SseTransportErrorExport};

/// Direct response content compatibility as an SSE object consumer.
///
/// The Direct stream invokes this consumer after transport framing and before
/// client projection, so compatibility rewrites remain object-level.
#[derive(Debug, Default)]
pub(crate) struct V3DirectSseContentConsumer {
    /// Provider protocol is fixed by the Direct execution plan before this
    /// consumer is constructed.  It must never be inferred from response JSON.
    pub(crate) provider_protocol: Option<V3HubProviderWireProtocol>,
    pub(crate) retain_response_cipher: bool,
    pub(crate) strip_client_response_id: bool,
    pub(crate) deepseek_console_go: bool,
    pub(crate) typed_hooks: V3DirectSseTypedHookCatalog,
    pub(crate) tool_thinking_enabled: bool,
    pub(crate) toolreason_client_projection: bool,
    pub(crate) tool_names: Vec<String>,
    pub(crate) pending_reasons: Vec<Option<String>>,
    pub(crate) toolreason_argument_buffers: Vec<String>,
    pub(crate) reason_emitted: bool,
    pub(crate) toolreason_reasoning_payload: Option<serde_json::Value>,
    pub(crate) toolreason_reasoning_projected: bool,
    pub(crate) session_id: Option<String>,
    pub(crate) request_id: Option<String>,
    pub(crate) client_responses_projection: bool,
}

pub(crate) type ToolreasonHook = fn(
    &mut serde_json::Value,
    &[String],
    &mut Vec<Option<String>>,
    &mut bool,
    bool,
    Option<&str>,
    Option<&str>,
    &mut Vec<String>,
);

/// Direct response business-hook catalog.
///
/// The catalog is intentionally protocol-local and contains only the two
/// allowed hook effects: semantic notification and typed business-content
/// rewrite. Provider compatibility, continuation, routing, and error policy
/// remain outside this catalog in their existing owners.
#[derive(Clone, Copy)]
pub(crate) struct V3DirectSseTypedHookCatalog {
    responses_notify: for<'a> fn(&V3ResponsesSseHookInput<'a>),
    responses_rewrite: fn(&mut V3ResponsesSseSemanticObject) -> Result<(), V3ResponsesSseTreeError>,
    chat_notify: for<'a> fn(&V3OpenAiChatSseHookInput<'a>),
    chat_rewrite: fn(&mut V3OpenAiChatSseSemanticObject) -> Result<(), V3OpenAiChatSseTreeError>,
    toolreason: ToolreasonHook,
}

impl std::fmt::Debug for V3DirectSseTypedHookCatalog {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("V3DirectSseTypedHookCatalog")
            .field("responses_notify", &"registered")
            .field("responses_rewrite", &"registered")
            .field("chat_notify", &"registered")
            .field("chat_rewrite", &"registered")
            .field("toolreason", &"registered")
            .finish()
    }
}

impl V3DirectSseTypedHookCatalog {
    pub(crate) const fn new() -> Self {
        Self {
            responses_notify: noop_responses_notify,
            responses_rewrite: noop_responses_rewrite,
            chat_notify: noop_chat_notify,
            chat_rewrite: noop_chat_rewrite,
            toolreason: noop_toolreason,
        }
    }

    pub(crate) const fn with_responses(
        mut self,
        notify: for<'a> fn(&V3ResponsesSseHookInput<'a>),
        rewrite: fn(&mut V3ResponsesSseSemanticObject) -> Result<(), V3ResponsesSseTreeError>,
    ) -> Self {
        self.responses_notify = notify;
        self.responses_rewrite = rewrite;
        self
    }

    pub(crate) const fn with_chat(
        mut self,
        notify: for<'a> fn(&V3OpenAiChatSseHookInput<'a>),
        rewrite: fn(&mut V3OpenAiChatSseSemanticObject) -> Result<(), V3OpenAiChatSseTreeError>,
    ) -> Self {
        self.chat_notify = notify;
        self.chat_rewrite = rewrite;
        self
    }

    pub(crate) const fn with_toolreason(mut self, hook: ToolreasonHook) -> Self {
        self.toolreason = hook;
        self
    }

    fn apply_toolreason(
        &self,
        value: &mut serde_json::Value,
        tool_names: &[String],
        pending_reasons: &mut Vec<Option<String>>,
        reason_emitted: &mut bool,
        project_to_client: bool,
        session_id: Option<&str>,
        request_id: Option<&str>,
        argument_buffers: &mut Vec<String>,
    ) {
        (self.toolreason)(
            value,
            tool_names,
            pending_reasons,
            reason_emitted,
            project_to_client,
            session_id,
            request_id,
            argument_buffers,
        );
    }

    fn apply_responses(
        &self,
        semantic: &mut V3ResponsesSseSemanticObject,
        transport: &crate::hub_v1::V3ResponsesSseTransportObject,
        protocol: &crate::hub_v1::V3ResponsesSseProtocolMetadata,
    ) -> Result<(), V3ResponsesSseTreeError> {
        let input = V3ResponsesSseHookInput {
            transport,
            protocol,
            semantic,
        };
        (self.responses_notify)(&input);
        (self.responses_rewrite)(semantic)
    }

    fn apply_chat(
        &self,
        semantic: &mut V3OpenAiChatSseSemanticObject,
        transport: &crate::hub_v1::V3OpenAiChatSseTransportObject,
        protocol: &crate::hub_v1::V3OpenAiChatSseProtocolMetadata,
    ) -> Result<(), V3OpenAiChatSseTreeError> {
        let input = V3OpenAiChatSseHookInput {
            transport,
            protocol,
            semantic,
        };
        (self.chat_notify)(&input);
        (self.chat_rewrite)(semantic)
    }
}

impl Default for V3DirectSseTypedHookCatalog {
    fn default() -> Self {
        Self::new()
    }
}

fn noop_responses_notify(_input: &V3ResponsesSseHookInput<'_>) {}

fn noop_responses_rewrite(
    _semantic: &mut V3ResponsesSseSemanticObject,
) -> Result<(), V3ResponsesSseTreeError> {
    Ok(())
}

fn noop_chat_notify(_input: &V3OpenAiChatSseHookInput<'_>) {}

fn noop_chat_rewrite(
    _semantic: &mut V3OpenAiChatSseSemanticObject,
) -> Result<(), V3OpenAiChatSseTreeError> {
    Ok(())
}

fn noop_toolreason(
    _value: &mut serde_json::Value,
    _tool_names: &[String],
    _pending_reasons: &mut Vec<Option<String>>,
    _reason_emitted: &mut bool,
    _project_to_client: bool,
    _session_id: Option<&str>,
    _request_id: Option<&str>,
    _argument_buffers: &mut Vec<String>,
) {
}

impl V3DirectSseContentConsumer {
    pub(crate) fn with_provider_protocol(
        mut self,
        provider_protocol: V3HubProviderWireProtocol,
    ) -> Self {
        self.provider_protocol = Some(provider_protocol);
        self
    }

    pub(crate) fn with_typed_hooks(mut self, typed_hooks: V3DirectSseTypedHookCatalog) -> Self {
        self.typed_hooks = typed_hooks;
        self
    }

    pub(crate) fn with_tool_thinking(mut self, enabled: bool, client_projection: bool) -> Self {
        self.tool_thinking_enabled = enabled;
        self.toolreason_client_projection = client_projection;
        self
    }

    pub(crate) fn with_client_responses_projection(mut self, enabled: bool) -> Self {
        self.client_responses_projection = enabled;
        self
    }

    pub(crate) fn finalize_toolreason_observation(&mut self) {
        if !self.tool_thinking_enabled {
            return;
        }
        crate::hub_v1::finalize_v3_toolreason_observation_at_resp03_with_context(
            &self.tool_names,
            &mut self.pending_reasons,
            &mut self.reason_emitted,
            crate::hub_v1::V3ToolreasonObservationContext {
                session_id: self.session_id.as_deref(),
                request_id: self.request_id.as_deref(),
            },
        );
    }

    pub(crate) fn take_toolreason_reasoning_projection(&mut self) -> Option<Vec<u8>> {
        if !self.toolreason_client_projection || self.toolreason_reasoning_projected {
            return None;
        }
        let payload = self.toolreason_reasoning_payload.take()?;
        if payload.get("object").and_then(serde_json::Value::as_str)
            == Some("chat.completion.chunk")
        {
            let reasoning = payload
                .pointer("/choices/0/delta/reasoning_content")
                .and_then(serde_json::Value::as_str)
                .filter(|text| !text.is_empty())?;
            self.toolreason_reasoning_projected = true;
            if self.client_responses_projection {
                return Some(
                    crate::hub_v1::build_v3_toolreason_visible_text_sse_events_at_resp03(
                        &serde_json::json!({"output_index": 0}),
                        reasoning,
                    )
                    .into_bytes(),
                );
            }
            return Some(
                crate::hub_v1::build_v3_openai_chat_reasoning_projection_frame_at_resp03(
                    &payload, reasoning,
                )
                .into_bytes(),
            );
        }
        let projection = build_v3_toolreason_reasoning_done_projection_at_resp03(&payload)
            .or_else(|| {
                let reasoning = payload
                    .pointer("/item/reasoning_content")
                    .and_then(serde_json::Value::as_str)?;
                let item_type = payload
                    .pointer("/item/type")
                    .and_then(serde_json::Value::as_str)?;
                matches!(
                    item_type,
                    "function" | "function_call" | "tool_call" | "custom_tool_call"
                )
                .then(|| {
                    crate::hub_v1::build_v3_toolreason_visible_text_sse_events_at_resp03(
                        &payload, reasoning,
                    )
                })
            })?;
        self.toolreason_reasoning_projected = true;
        Some(projection.into_bytes())
    }
}

pub(crate) fn build_v3_sse_transport_error_source(
    error: SseTransportError,
) -> V3Error01SourceRaised {
    let exported = SseTransportErrorExport::from(error);
    build_v3_error_01_source_raised(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderResp14Raw",
        exported.code,
        exported.message,
    )
}

impl SseObjectConsumer for V3DirectSseContentConsumer {
    fn consume(
        &mut self,
        object: &mut SseObjectFrame,
    ) -> Result<SseObjectConsumerAction, SseObjectError> {
        let Some(data_json) = object.normalized_data_json() else {
            return Ok(SseObjectConsumerAction::Pass);
        };
        let parsed: serde_json::Value =
            serde_json::from_str(&data_json).map_err(|error| SseObjectError::Consumer {
                message: error.to_string(),
            })?;
        if !parsed.is_object() {
            return Ok(SseObjectConsumerAction::Pass);
        }
        let provider_protocol = self
            .provider_protocol
            .ok_or_else(|| SseObjectError::Consumer {
                message: "Direct SSE provider protocol is missing from the execution plan"
                    .to_owned(),
            })?;
        let original: serde_json::Value = normalize_v3_provider_sse_json_data_with_event_name(
            provider_protocol,
            &data_json,
            object.event_name(),
        )
        .map_err(|message| SseObjectError::Consumer { message })
        .and_then(|normalized| {
            serde_json::from_str(&normalized).map_err(|error| SseObjectError::Consumer {
                message: error.to_string(),
            })
        })?;
        let is_anthropic_tool_event = original
            .get("type")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|event_type| {
                matches!(
                    event_type,
                    "content_block_start" | "content_block_delta" | "content_block_stop"
                )
            });
        let is_anthropic_terminal =
            original.get("type").and_then(serde_json::Value::as_str) == Some("message_stop");
        if self.tool_thinking_enabled && is_anthropic_tool_event {
            let mut anthropic = original.clone();
            crate::hub_v1::map_v3_anthropic_toolreason_stream_event_at_resp03(
                &mut anthropic,
                &mut self.tool_names,
                &mut self.pending_reasons,
                &mut self.reason_emitted,
                self.toolreason_client_projection,
            );
            if anthropic != original {
                object.replace_data_value(anthropic);
                return Ok(SseObjectConsumerAction::RewriteData);
            }
            return Ok(SseObjectConsumerAction::Pass);
        }
        if self.tool_thinking_enabled && is_anthropic_terminal {
            self.finalize_toolreason_observation();
            return Ok(SseObjectConsumerAction::Pass);
        }
        let mut rewritten =
            project_direct_typed_protocol_data(&original, provider_protocol, &self.typed_hooks)?;
        if self.tool_thinking_enabled {
            crate::hub_v1::collect_v3_responses_sse_tool_name_at_resp03(
                &rewritten,
                &mut self.tool_names,
            );
            self.typed_hooks.apply_toolreason(
                &mut rewritten,
                &self.tool_names,
                &mut self.pending_reasons,
                &mut self.reason_emitted,
                self.toolreason_client_projection,
                self.session_id.as_deref(),
                self.request_id.as_deref(),
                &mut self.toolreason_argument_buffers,
            );
            let chat_toolreason_projection = self.toolreason_client_projection
                && rewritten.get("object").and_then(serde_json::Value::as_str)
                    == Some("chat.completion.chunk")
                && rewritten
                    .pointer("/choices/0/delta/reasoning_content")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|text| !text.is_empty());
            if self.toolreason_client_projection
                && (build_v3_toolreason_reasoning_done_projection_at_resp03(&rewritten).is_some()
                    || chat_toolreason_projection)
            {
                self.toolreason_reasoning_payload = Some(rewritten.clone());
                if chat_toolreason_projection {
                    if let Some(delta) = rewritten
                        .pointer_mut("/choices/0/delta")
                        .and_then(serde_json::Value::as_object_mut)
                    {
                        delta.remove("reasoning_content");
                    }
                }
            }
            if self.toolreason_client_projection
                && rewritten.get("type").and_then(serde_json::Value::as_str)
                    == Some("response.output_item.done")
                && rewritten
                    .pointer("/item/reasoning_content")
                    .and_then(serde_json::Value::as_str)
                    .is_some()
                && rewritten
                    .pointer("/item/type")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|item_type| {
                        matches!(
                            item_type,
                            "function" | "function_call" | "tool_call" | "custom_tool_call"
                        )
                    })
            {
                self.toolreason_reasoning_payload = Some(rewritten.clone());
                if let Some(item) = rewritten
                    .get_mut("item")
                    .and_then(serde_json::Value::as_object_mut)
                {
                    item.remove("reasoning_content");
                }
            }
        }
        if self.tool_thinking_enabled && is_direct_toolreason_terminal(&rewritten) {
            self.finalize_toolreason_observation();
        }
        if !self.retain_response_cipher {
            routecodex_v3_provider_responses::apply_v3_response_cipher_policy(
                &mut rewritten,
                false,
            );
        }
        if self.strip_client_response_id {
            crate::shared::strip_v3_response_id_from_json_body(&mut rewritten);
        }
        if self.deepseek_console_go {
            rewritten = provider_compat_core::apply_deepseek_console_go_response_compat(rewritten);
        }
        if rewritten == original {
            return Ok(SseObjectConsumerAction::Pass);
        }
        object.replace_data_value(rewritten);
        Ok(SseObjectConsumerAction::RewriteData)
    }
}

fn is_direct_toolreason_terminal(value: &serde_json::Value) -> bool {
    if matches!(
        value.get("type").and_then(serde_json::Value::as_str),
        Some("response.completed" | "response.failed" | "response.incomplete")
    ) {
        return true;
    }
    value
        .get("choices")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|choices| {
            choices.iter().any(|choice| {
                choice
                    .get("finish_reason")
                    .and_then(serde_json::Value::as_str)
                    .is_some()
            })
        })
}

fn project_direct_typed_protocol_data(
    value: &serde_json::Value,
    provider_protocol: V3HubProviderWireProtocol,
    typed_hooks: &V3DirectSseTypedHookCatalog,
) -> Result<serde_json::Value, SseObjectError> {
    match provider_protocol {
        V3HubProviderWireProtocol::OpenAiChat => {
            let mut semantic = classify_v3_openai_chat_sse_chunk(value).map_err(|error| {
                SseObjectError::Consumer {
                    message: error.to_string(),
                }
            })?;
            let transport = crate::hub_v1::V3OpenAiChatSseTransportObject::new(None, value.clone());
            let protocol = semantic.protocol.clone();
            typed_hooks
                .apply_chat(&mut semantic, &transport, &protocol)
                .map_err(|error| SseObjectError::Consumer {
                    message: error.to_string(),
                })?;
            Ok(project_v3_openai_chat_sse_chunk_json(&semantic))
        }
        V3HubProviderWireProtocol::Responses => {
            let mut semantic = classify_v3_responses_sse_event(value).map_err(|error| {
                SseObjectError::Consumer {
                    message: error.to_string(),
                }
            })?;
            let transport = crate::hub_v1::V3ResponsesSseTransportObject::new(None, value.clone());
            let protocol = semantic.protocol.clone();
            typed_hooks
                .apply_responses(&mut semantic, &transport, &protocol)
                .map_err(|error| SseObjectError::Consumer {
                    message: error.to_string(),
                })?;
            Ok(project_v3_responses_sse_event_json(&semantic))
        }
        V3HubProviderWireProtocol::Anthropic | V3HubProviderWireProtocol::Gemini => {
            Ok(value.clone())
        }
    }
}

/// Provider semantic-error observation as an SSE object consumer.
///
/// The consumer records provider failure facts only. Error01-06 projection
/// remains owned by the runtime error pipeline and is not reconstructed here.
#[derive(Debug, Clone)]
pub(crate) struct V3ProviderSseErrorConsumer {
    pub(crate) provider_protocol: V3HubProviderWireProtocol,
    pub(crate) failure: Option<(String, String)>,
}

impl V3ProviderSseErrorConsumer {
    pub(crate) fn new(provider_protocol: V3HubProviderWireProtocol) -> Self {
        Self {
            provider_protocol,
            failure: None,
        }
    }
}

impl SseObjectConsumer for V3ProviderSseErrorConsumer {
    fn consume(
        &mut self,
        object: &mut SseObjectFrame,
    ) -> Result<SseObjectConsumerAction, SseObjectError> {
        if object.is_done() {
            return Ok(SseObjectConsumerAction::Pass);
        }
        if object.has_data() && !object.is_json_valid() {
            return Err(SseObjectError::InvalidJson {
                message: "provider SSE data is not valid JSON".to_owned(),
            });
        }
        let Some(data) = object.normalized_data_json() else {
            return Ok(SseObjectConsumerAction::Pass);
        };
        let data = normalize_v3_provider_sse_json_data_with_event_name(
            self.provider_protocol,
            &data,
            object.event_name(),
        )
        .map_err(|message| SseObjectError::Consumer { message })?;
        let outcome = classify_v3_provider_sse_json_data(self.provider_protocol, &data)
            .map_err(|message| SseObjectError::Consumer { message })?;
        if let Some(V3ProviderResponsesJsonFrameOutcome::Failure { code, message }) = outcome {
            self.failure = Some((code, message));
        }
        Ok(SseObjectConsumerAction::Pass)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sse_object_pipeline::SseObjectFrame;
    use routecodex_v3_sse::{
        build_v3_sse_transport_in_01_raw_chunk, SseIncrementalDecoder, SseTransportLimits,
    };

    fn test_toolreason_hook(
        value: &mut serde_json::Value,
        tool_names: &[String],
        pending_reasons: &mut Vec<Option<String>>,
        reason_emitted: &mut bool,
        project_to_client: bool,
        session_id: Option<&str>,
        request_id: Option<&str>,
        argument_buffers: &mut Vec<String>,
    ) {
        crate::hub_v1::map_v3_toolreason_stream_event_at_resp03_with_context_and_buffers(
            value,
            true,
            tool_names,
            pending_reasons,
            reason_emitted,
            project_to_client,
            session_id,
            request_id,
            Some(argument_buffers),
        );
    }

    fn rewrite_direct_responses_text(
        semantic: &mut V3ResponsesSseSemanticObject,
    ) -> Result<(), V3ResponsesSseTreeError> {
        semantic.rewrite_item_content(crate::hub_v1::V3ResponsesSseContentRewrite::Text(
            "direct typed rewrite".to_owned(),
        ))
    }

    #[test]
    fn direct_consumer_rewrites_only_configured_business_fields() {
        let mut consumer = V3DirectSseContentConsumer {
            provider_protocol: Some(V3HubProviderWireProtocol::Responses),
            retain_response_cipher: false,
            strip_client_response_id: true,
            deepseek_console_go: false,
            typed_hooks: V3DirectSseTypedHookCatalog::default(),
            ..Default::default()
        };
        let mut object = SseObjectFrame::from_json(
            r#"{"type":"response.output_text.delta","response":{"id":"resp_1"},"encrypted_content":"rsn_secret","delta":"keep"}"#,
        )
        .unwrap();
        let action = consumer.consume(&mut object).unwrap();
        assert_eq!(action, SseObjectConsumerAction::RewriteData);
        let value = object.data_value().unwrap();
        assert_eq!(value["response"]["id"], "");
        assert!(value.get("encrypted_content").is_none());
        assert_eq!(value["delta"], "keep");
    }

    #[test]
    fn direct_consumer_passes_ordinary_json_without_reordering_semantics() {
        let mut consumer = V3DirectSseContentConsumer {
            provider_protocol: Some(V3HubProviderWireProtocol::Responses),
            retain_response_cipher: true,
            strip_client_response_id: false,
            deepseek_console_go: false,
            typed_hooks: V3DirectSseTypedHookCatalog::default(),
            ..Default::default()
        };
        let mut object =
            SseObjectFrame::from_json(r#"{"type":"response.output_text.delta","delta":"ok"}"#)
                .unwrap();
        assert_eq!(
            consumer.consume(&mut object).unwrap(),
            SseObjectConsumerAction::Pass
        );
        assert_eq!(object.data_value().unwrap()["delta"], "ok");
    }

    #[test]
    fn direct_consumer_passes_non_object_sse_data_without_responses_parsing() {
        let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
        let frame = decoder
            .push(build_v3_sse_transport_in_01_raw_chunk(b"data: null\n\n"))
            .unwrap()
            .pop()
            .unwrap();
        let mut consumer = V3DirectSseContentConsumer {
            tool_thinking_enabled: true,
            toolreason_client_projection: true,
            ..V3DirectSseContentConsumer::default()
        };
        assert_eq!(
            consumer
                .consume(&mut SseObjectFrame::from_frame(&frame))
                .unwrap(),
            SseObjectConsumerAction::Pass
        );
    }

    #[test]
    fn direct_consumer_rejects_semantic_object_without_selected_protocol() {
        let mut consumer = V3DirectSseContentConsumer::default();
        let mut object = SseObjectFrame::from_json(
            r#"{"type":"response.output_text.delta","delta":"must not guess"}"#,
        )
        .unwrap();
        assert!(consumer.consume(&mut object).is_err());
    }

    #[test]
    fn direct_consumer_uses_selected_protocol_instead_of_shape_guessing() {
        let mut responses_consumer = V3DirectSseContentConsumer::default()
            .with_provider_protocol(V3HubProviderWireProtocol::Responses);
        let mut chat_shape = SseObjectFrame::from_json(
            r#"{"object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
        )
        .unwrap();
        assert!(responses_consumer.consume(&mut chat_shape).is_err());

        let mut chat_consumer = V3DirectSseContentConsumer::default()
            .with_provider_protocol(V3HubProviderWireProtocol::OpenAiChat);
        let mut responses_shape = SseObjectFrame::from_json(
            r#"{"type":"response.output_text.delta","delta":"must not reclassify"}"#,
        )
        .unwrap();
        assert!(chat_consumer.consume(&mut responses_shape).is_err());
    }

    #[test]
    fn direct_consumer_observes_and_redacts_anthropic_toolreason_fields() {
        let mut consumer = V3DirectSseContentConsumer::default()
            .with_provider_protocol(V3HubProviderWireProtocol::Anthropic)
            .with_tool_thinking(true, false);
        let mut start = SseObjectFrame::from_json(
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"exec_command","input":{}}}"#,
        )
        .unwrap();
        assert_eq!(
            consumer.consume(&mut start).unwrap(),
            SseObjectConsumerAction::Pass
        );
        let mut delta = SseObjectFrame::from_json(
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"cmd\":\"pwd\",\"reason\":\"确认目录\",\"goal_alignment_confidence\":100,\"model_id\":\"m\"}"}}"#,
        )
        .unwrap();
        assert_eq!(
            consumer.consume(&mut delta).unwrap(),
            SseObjectConsumerAction::RewriteData
        );
        assert_eq!(consumer.tool_names, vec!["exec_command"]);
        assert_eq!(consumer.pending_reasons.len(), 1);
        assert!(consumer.pending_reasons[0]
            .as_deref()
            .unwrap()
            .contains("goal_alignment_confidence"));
        assert!(!delta
            .data_value()
            .unwrap()
            .pointer("/delta/partial_json")
            .unwrap()
            .as_str()
            .unwrap()
            .contains("goal_alignment_confidence"));
    }

    #[test]
    fn direct_consumer_closes_anthropic_toolreason_at_message_stop() {
        let mut consumer = V3DirectSseContentConsumer::default()
            .with_provider_protocol(V3HubProviderWireProtocol::Anthropic)
            .with_tool_thinking(true, false);
        let mut start = SseObjectFrame::from_json(
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"exec_command","input":{}}}"#,
        )
        .unwrap();
        consumer.consume(&mut start).unwrap();
        let mut delta = SseObjectFrame::from_json(
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"cmd\":\"pwd\"}"}}"#,
        )
        .unwrap();
        consumer.consume(&mut delta).unwrap();
        assert!(!consumer.reason_emitted);
        let mut stop = SseObjectFrame::from_json(r#"{"type":"message_stop"}"#).unwrap();
        consumer.consume(&mut stop).unwrap();
        assert!(consumer.reason_emitted);
    }

    #[test]
    fn direct_consumer_redacts_anthropic_toolreason_fields_from_start_input() {
        let mut consumer = V3DirectSseContentConsumer::default()
            .with_provider_protocol(V3HubProviderWireProtocol::Anthropic)
            .with_tool_thinking(true, false);
        let mut start = SseObjectFrame::from_json(
            r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"exec_command","input":{"cmd":"pwd","reason":"确认目录","goal_alignment_confidence":100,"model_id":"m"}}}"#,
        )
        .unwrap();

        assert_eq!(
            consumer.consume(&mut start).unwrap(),
            SseObjectConsumerAction::RewriteData
        );
        let input = start
            .data_value()
            .unwrap()
            .pointer("/content_block/input")
            .unwrap();
        assert_eq!(input["cmd"], "pwd");
        assert!(input.get("reason").is_none());
        assert!(input.get("goal_alignment_confidence").is_none());
        assert!(input.get("model_id").is_none());
        assert!(consumer.pending_reasons[0]
            .as_deref()
            .unwrap()
            .contains("goal_alignment_confidence"));
    }

    #[test]
    fn direct_consumer_projects_chat_chunk_from_typed_tree_and_preserves_extension() {
        let mut consumer = V3DirectSseContentConsumer::default()
            .with_provider_protocol(V3HubProviderWireProtocol::OpenAiChat);
        let mut object = SseObjectFrame::from_json(
            r#"{"id":"chat_1","object":"chat.completion.chunk","created":7,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}],"vendor_extension":{"x":1}}"#,
        )
        .unwrap();
        assert_eq!(
            consumer.consume(&mut object).unwrap(),
            SseObjectConsumerAction::RewriteData
        );
        assert_eq!(
            object.data_value().unwrap()["choices"][0]["delta"]["content"],
            "ok"
        );
        assert_eq!(object.data_value().unwrap()["vendor_extension"]["x"], 1);
    }

    #[test]
    fn direct_consumer_projects_responses_event_from_typed_tree_and_preserves_extension() {
        let mut consumer = V3DirectSseContentConsumer::default()
            .with_provider_protocol(V3HubProviderWireProtocol::Responses);
        let mut object = SseObjectFrame::from_json(
            r#"{"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","content_index":0,"delta":"ok","vendor_extension":{"x":1}}"#,
        )
        .unwrap();
        assert_eq!(
            consumer.consume(&mut object).unwrap(),
            SseObjectConsumerAction::Pass
        );
        assert_eq!(object.data_value().unwrap()["delta"], "ok");
        assert_eq!(object.data_value().unwrap()["vendor_extension"]["x"], 1);
    }

    #[test]
    fn direct_consumer_mounts_business_rewrite_on_typed_responses_object() {
        let catalog = V3DirectSseTypedHookCatalog::new()
            .with_responses(noop_responses_notify, rewrite_direct_responses_text);
        let mut consumer = V3DirectSseContentConsumer::default()
            .with_provider_protocol(V3HubProviderWireProtocol::Responses)
            .with_typed_hooks(catalog);
        let mut object = SseObjectFrame::from_json(
            r#"{"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"original"}]}}"#,
        )
        .unwrap();
        assert_eq!(
            consumer.consume(&mut object).unwrap(),
            SseObjectConsumerAction::RewriteData
        );
        assert_eq!(
            object.data_value().unwrap()["item"]["content"][0]["text"],
            "direct typed rewrite"
        );
    }

    #[test]
    fn direct_consumer_strips_tool_thinking_fields_inside_function_arguments() {
        let mut consumer = V3DirectSseContentConsumer::default()
            .with_provider_protocol(V3HubProviderWireProtocol::Responses)
            .with_typed_hooks(
                V3DirectSseTypedHookCatalog::new().with_toolreason(test_toolreason_hook),
            )
            .with_tool_thinking(true, true);
        let mut object = SseObjectFrame::from_json(
            r#"{"type":"response.output_item.done","output_index":0,"item":{"id":"call_1","type":"function_call","name":"exec_command","call_id":"call_1","arguments":"{\"cmd\":\"pwd\",\"reason\":\"读取工作目录\",\"goal_alignment_confidence\":100,\"model_id\":\"x-preview-f-free\"}"}}"#,
        )
        .unwrap();
        consumer.consume(&mut object).unwrap();
        let arguments = object.data_value().unwrap()["item"]["arguments"]
            .as_str()
            .unwrap();
        assert_eq!(arguments, "{\"cmd\":\"pwd\"}");
        assert!(object.data_value().unwrap()["item"]
            .get("reasoning_content")
            .is_none());
        let reasoning = consumer
            .take_toolreason_reasoning_projection()
            .expect("toolreason must project as a reasoning item lifecycle");
        let reasoning = String::from_utf8(reasoning).expect("reasoning SSE must be UTF-8");
        assert!(reasoning.contains("response.output_item.added"));
        assert!(reasoning.contains("response.reasoning_summary_text.delta"));
        assert!(reasoning.contains("调用工具 pwd：读取工作目录"));
        assert!(!reasoning.contains("reasoning_content"));
    }

    #[test]
    fn direct_consumer_strips_and_projects_toolreason_from_chat_chunk_arguments() {
        let mut consumer = V3DirectSseContentConsumer::default()
            .with_provider_protocol(V3HubProviderWireProtocol::OpenAiChat)
            .with_typed_hooks(
                V3DirectSseTypedHookCatalog::new().with_toolreason(test_toolreason_hook),
            )
            .with_tool_thinking(true, true);
        let mut object = SseObjectFrame::from_json(
            r#"{"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"exec_command","arguments":"{\"cmd\":\"pwd\",\"reason\":\"读取工作目录\",\"goal_alignment_confidence\":100,\"model_id\":\"x-preview-f-free\"}"}}]}}]}"#,
        )
        .unwrap();
        consumer.consume(&mut object).unwrap();
        let delta = &object.data_value().unwrap()["choices"][0]["delta"];
        assert_eq!(
            delta["tool_calls"][0]["function"]["arguments"],
            "{\"cmd\":\"pwd\"}"
        );
        assert!(delta.get("reasoning_content").is_none());
        let reasoning = consumer
            .take_toolreason_reasoning_projection()
            .expect("chat toolreason must project as a separate reasoning item");
        let reasoning = String::from_utf8(reasoning).expect("reasoning SSE must be UTF-8");
        assert!(reasoning.contains("reasoning_content"));
        assert!(reasoning.contains("调用工具 pwd：读取工作目录"));
    }

    #[test]
    fn direct_responses_client_projects_chat_provider_toolreason_as_responses_item() {
        let mut consumer = V3DirectSseContentConsumer::default()
            .with_provider_protocol(V3HubProviderWireProtocol::OpenAiChat)
            .with_typed_hooks(
                V3DirectSseTypedHookCatalog::new().with_toolreason(test_toolreason_hook),
            )
            .with_tool_thinking(true, true)
            .with_client_responses_projection(true);
        let mut object = SseObjectFrame::from_json(
            r#"{"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"exec_command","arguments":"{\"cmd\":\"pwd\",\"reason\":\"读取工作目录\",\"goal_alignment_confidence\":100,\"model_id\":\"x-preview-f-free\"}"}}]}}]}"#,
        )
        .unwrap();
        consumer.consume(&mut object).unwrap();
        let reasoning = consumer
            .take_toolreason_reasoning_projection()
            .expect("Responses client must receive a Responses reasoning item");
        let reasoning = String::from_utf8(reasoning).expect("reasoning SSE must be UTF-8");
        assert!(reasoning.contains("response.output_item.added"));
        assert!(reasoning.contains("response.reasoning_summary_text.delta"));
        assert!(reasoning.contains("调用工具 pwd：读取工作目录"));
        assert!(!reasoning.contains("chat.completion.chunk"));
    }

    #[test]
    fn direct_consumer_strips_invalid_chat_auxiliary_fields_without_changing_command() {
        let mut consumer = V3DirectSseContentConsumer::default()
            .with_provider_protocol(V3HubProviderWireProtocol::OpenAiChat)
            .with_typed_hooks(
                V3DirectSseTypedHookCatalog::new().with_toolreason(test_toolreason_hook),
            )
            .with_tool_thinking(true, true);
        let mut object = SseObjectFrame::from_json(
            r#"{"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"exec_command","arguments":"{\"cmd\":\"pwd\",\"reason\":\"读取工作目录\",\"goal_alignment_confidence\":\"100\",\"model_id\":null}"}}]}}]}"#,
        )
        .unwrap();
        consumer.consume(&mut object).unwrap();
        let arguments = object.data_value().unwrap()["choices"][0]["delta"]["tool_calls"][0]
            ["function"]["arguments"]
            .as_str()
            .unwrap();
        assert_eq!(arguments, "{\"cmd\":\"pwd\"}");
    }

    #[test]
    fn direct_consumer_closes_missing_chat_toolreason_observation() {
        let mut consumer = V3DirectSseContentConsumer::default()
            .with_provider_protocol(V3HubProviderWireProtocol::OpenAiChat)
            .with_typed_hooks(
                V3DirectSseTypedHookCatalog::new().with_toolreason(test_toolreason_hook),
            )
            .with_tool_thinking(true, false);
        let mut object = SseObjectFrame::from_json(
            r#"{"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"exec_command","arguments":"{\"cmd\":\"pwd\"}"}}]}}]}"#,
        )
        .unwrap();
        consumer.consume(&mut object).unwrap();
        assert_eq!(consumer.tool_names, vec!["pwd"]);
        assert_eq!(
            object.data_value().unwrap()["choices"][0]["delta"]["tool_calls"][0]["function"]
                ["arguments"],
            "{\"cmd\":\"pwd\"}"
        );
        consumer.finalize_toolreason_observation();
        assert!(consumer.reason_emitted);
    }

    #[test]
    fn provider_error_consumer_records_error_but_does_not_rewrite_payload() {
        let mut consumer = V3ProviderSseErrorConsumer::new(V3HubProviderWireProtocol::Responses);
        let mut object = SseObjectFrame::from_json(
            r#"{"type":"response.failed","error":{"code":"provider_failed","message":"bad"}}"#,
        )
        .unwrap();
        assert_eq!(
            consumer.consume(&mut object).unwrap(),
            SseObjectConsumerAction::Pass
        );
        assert_eq!(
            consumer.failure.as_ref().map(|value| value.0.as_str()),
            Some("provider_failed")
        );
        assert_eq!(object.data_value().unwrap()["type"], "response.failed");
    }

    #[test]
    fn provider_error_consumer_rejects_malformed_json_instead_of_silently_passing() {
        let mut consumer = V3ProviderSseErrorConsumer::new(V3HubProviderWireProtocol::Responses);
        let frame = routecodex_v3_sse::build_sse_transport_in_03_from_sse_transport_in_02(
            routecodex_v3_sse::build_sse_transport_in_02_from_fields(vec![
                routecodex_v3_sse::SseField::Named {
                    name: "data".to_owned(),
                    value: "not-json".to_owned(),
                },
            ])
            .unwrap(),
        )
        .unwrap();
        let mut object = SseObjectFrame::from_frame(&frame);
        assert!(consumer.consume(&mut object).is_err());
    }

    #[test]
    fn transport_error_export_enters_the_canonical_error_chain() {
        let source = build_v3_sse_transport_error_source(SseTransportError::UnterminatedFrame);
        assert_eq!(source.source_stage, "V3ProviderResp14Raw");
        assert_eq!(source.code, "provider_response_sse_unterminated_frame");
        let classified = routecodex_v3_error::build_v3_error_02_classified_from_v3_error_01(source);
        let local = routecodex_v3_error::build_v3_error_03_target_local_action_from_v3_error_02(
            classified,
            routecodex_v3_error::V3ErrorActionScope::ProviderInstance {
                provider_id: "provider-1".to_owned(),
            },
            0,
        );
        let exhaustion =
            routecodex_v3_error::build_v3_error_04_target_exhaustion_decision_with_provider_availability(
                local, 0, false, false,
            );
        let execution = routecodex_v3_error::build_v3_error_05_execution_decision_from_v3_error_04(
            exhaustion, None,
        );
        let projected = routecodex_v3_error::build_v3_error_06_client_projected_from_v3_error_05(
            execution
                .try_into_terminal()
                .expect("exhausted provider transport error must project terminally"),
        );
        assert_eq!(
            projected.chain,
            routecodex_v3_error::V3_ERROR_CHAIN_NODE_IDS
        );
        assert_ne!(
            projected.body.get("response"),
            Some(&serde_json::json!({"status":"completed"}))
        );
    }
}

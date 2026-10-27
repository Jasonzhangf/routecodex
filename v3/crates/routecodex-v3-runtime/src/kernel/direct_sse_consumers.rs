use crate::hub_v1::{
    classify_v3_openai_chat_sse_chunk, classify_v3_provider_sse_json_data,
    classify_v3_responses_sse_event, normalize_v3_provider_sse_json_data_with_event_name,
    project_v3_openai_chat_sse_chunk_json, project_v3_responses_sse_event_json,
    V3HubProviderWireProtocol, V3OpenAiChatSseHookInput, V3OpenAiChatSseSemanticObject,
    V3OpenAiChatSseTreeError, V3ProviderResponsesJsonFrameOutcome, V3ResponsesSseHookInput,
    V3ResponsesSseSemanticObject, V3ResponsesSseTreeError, V3RuntimeStreamObservation,
};
use crate::sse_object_pipeline::{
    SseObjectConsumer, SseObjectConsumerAction, SseObjectError, SseObjectFrame,
};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3Error01SourceRaised, V3ErrorSourceKind,
};
use routecodex_v3_sse::{SseTransportError, SseTransportErrorExport};

/// Resp14 provider SSE semantic object.  It is the only shape accepted by
/// the client projection boundary below; raw provider wire data never crosses
/// that boundary directly.
#[derive(Debug, Clone)]
pub(crate) struct V3ProviderSseSemanticObject(serde_json::Value);

impl V3ProviderSseSemanticObject {
    fn new(value: serde_json::Value) -> Self {
        Self(value)
    }

    fn value(&self) -> &serde_json::Value {
        &self.0
    }
}

#[derive(Debug, Clone)]
pub(crate) struct V3ClientSseProjectedObject(serde_json::Value);

impl V3ClientSseProjectedObject {
    fn into_value(self) -> serde_json::Value {
        self.0
    }
}

/// Direct response content compatibility as an SSE object consumer.
///
/// The Direct stream invokes this consumer after transport framing and before
/// client projection, so compatibility rewrites remain object-level.
#[derive(Debug, Default)]
pub(crate) struct V3DirectSseContentConsumer {
    /// Provider protocol is fixed by the Direct execution plan before this
    /// consumer is constructed. It must never be inferred from response JSON.
    pub(crate) provider_protocol: Option<V3HubProviderWireProtocol>,
    pub(crate) retain_response_cipher: bool,
    pub(crate) strip_client_response_id: bool,
    pub(crate) deepseek_console_go: bool,
    pub(crate) provider_response_compat_profile: Option<String>,
    pub(crate) custom_tool_function_binding:
        Option<provider_compat_core::CustomToolFunctionBinding>,
    pub(crate) typed_hooks: V3DirectSseTypedHookCatalog,
    pub(crate) tool_thinking_enabled: bool,
    pub(crate) tool_thinking_argument_buffers: Vec<String>,
    pub(crate) request_id: Option<String>,
    pub(crate) namespace_tool_identities: std::collections::HashMap<String, (String, String)>,
    pub(crate) stream_observation: Option<V3RuntimeStreamObservation>,
}

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
}

impl std::fmt::Debug for V3DirectSseTypedHookCatalog {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("V3DirectSseTypedHookCatalog")
            .field("responses_notify", &"registered")
            .field("responses_rewrite", &"registered")
            .field("chat_notify", &"registered")
            .field("chat_rewrite", &"registered")
            .finish()
    }
}

impl V3DirectSseTypedHookCatalog {
    pub(crate) const fn new() -> Self {
        Self {
            responses_notify: noop_responses_notify,
            responses_rewrite:
                crate::hub_v1::scrub_v3_provider_model_identity_instructions_from_typed_sse,
            chat_notify: noop_chat_notify,
            chat_rewrite: noop_chat_rewrite,
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

    pub(crate) fn with_tool_thinking(mut self, enabled: bool) -> Self {
        self.tool_thinking_enabled = enabled;
        self
    }

    pub(crate) fn with_provider_response_compat_profile(mut self, profile: Option<String>) -> Self {
        self.provider_response_compat_profile = profile;
        self
    }

    pub(crate) fn with_custom_tool_function_binding(
        mut self,
        binding: Option<provider_compat_core::CustomToolFunctionBinding>,
    ) -> Self {
        self.custom_tool_function_binding = binding;
        self
    }

}

pub(crate) fn build_v3_sse_transport_error_source(
    error: SseTransportError,
) -> Result<V3Error01SourceRaised, crate::provider_failure_runtime_policy::V3RelayErrorOperatorFault>
{
    let exported = SseTransportErrorExport::from(error);
    crate::shared::direct_source_error(
        V3ErrorSourceKind::ProviderFailure,
        "V3ProviderResp14Raw",
        exported.code,
        exported.message,
        crate::operation_runner::V3Err01SourceInput::Plain,
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
        let original = V3ProviderSseSemanticObject::new(
            serde_json::from_str(
                &normalize_v3_provider_sse_json_data_with_event_name(
                    provider_protocol,
                    &data_json,
                    object.event_name(),
                )
                .map_err(|message| SseObjectError::Consumer { message })?,
            )
            .map_err(|error| SseObjectError::Consumer {
                message: error.to_string(),
            })?,
        );
        let original_value = original.value();
        let is_anthropic_tool_event = original_value
            .get("type")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|event_type| {
                matches!(
                    event_type,
                    "content_block_start" | "content_block_delta" | "content_block_stop"
                )
            });
        if self.tool_thinking_enabled && is_anthropic_tool_event {
            let mut anthropic = original_value.clone();
            crate::hub_v1::map_v3_anthropic_tool_thinking_stream_event_at_resp03(
                &mut anthropic,
                &mut self.tool_thinking_argument_buffers,
            );
            if anthropic != *original_value {
                object.replace_data_value(anthropic);
                return Ok(SseObjectConsumerAction::RewriteData);
            }
            return Ok(SseObjectConsumerAction::Pass);
        }
        let mut rewritten =
            project_direct_client_data(original.clone(), provider_protocol, &self.typed_hooks)?;
        // Provider-private response compat (chat:*) has exactly one owner: the
        // provider response compat stage. Relay applies it to the projected chat
        // chunk after the typed semantic hook and before Resp03 terminal
        // admission; Direct must reach the same owner at the same point instead
        // of reimplementing any rewrite. This is not a second implementation and
        // cannot double-apply: Direct selects it only for the
        // ProviderResponseCompat plan block, and the typed projection already
        // ran, matching Relay's ordering exactly.
        if let Some(profile) = self.provider_response_compat_profile.as_deref() {
            rewritten = crate::shared::apply_direct_provider_response_compat_value(
                rewritten,
                profile,
                provider_protocol,
                self.request_id.as_deref().unwrap_or_default(),
                self.custom_tool_function_binding.as_ref(),
            )
            .map_err(|error| SseObjectError::Consumer { message: error })?;
        }
        if self.tool_thinking_enabled {
            crate::hub_v1::map_v3_tool_thinking_stream_event_at_resp03(
                &mut rewritten,
                true,
                Some(&mut self.tool_thinking_argument_buffers),
            );
        }
        if provider_protocol == V3HubProviderWireProtocol::Responses {
            crate::direct_response_hooks::apply_v3_direct_response_projection_hooks_with_identities(
                &mut rewritten,
                self.strip_client_response_id,
                self.retain_response_cipher,
                provider_protocol,
                &self.namespace_tool_identities,
            );
        } else {
            crate::direct_response_hooks::apply_v3_direct_response_projection_hooks(
                &mut rewritten,
                self.strip_client_response_id,
                self.retain_response_cipher,
                provider_protocol,
            );
        }
        if self.deepseek_console_go {
            rewritten = provider_compat_core::apply_deepseek_console_go_response_compat(rewritten);
        }
        if rewritten == *original_value {
            return Ok(SseObjectConsumerAction::Pass);
        }
        object.replace_data_value(rewritten);
        Ok(SseObjectConsumerAction::RewriteData)
    }
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

fn project_direct_client_data(
    provider: V3ProviderSseSemanticObject,
    provider_protocol: V3HubProviderWireProtocol,
    typed_hooks: &V3DirectSseTypedHookCatalog,
) -> Result<serde_json::Value, SseObjectError> {
    let projected =
        project_direct_typed_protocol_data(provider.value(), provider_protocol, typed_hooks)?;
    Ok(V3ClientSseProjectedObject(projected).into_value())
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
#[path = "direct_sse_consumers_tests.rs"]
mod tests;

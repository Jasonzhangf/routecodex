use crate::hub_v1::{
    classify_v3_openai_chat_sse_chunk, classify_v3_provider_sse_json_data,
    classify_v3_responses_sse_event, project_v3_openai_chat_sse_chunk_json,
    project_v3_responses_sse_event_json, V3HubProviderWireProtocol,
    V3OpenAiChatSseHookInput, V3OpenAiChatSseSemanticObject,
    V3OpenAiChatSseTreeError, V3ProviderResponsesJsonFrameOutcome, V3ResponsesSseHookInput,
    V3ResponsesSseSemanticObject, V3ResponsesSseTreeError,
};
use routecodex_v3_error::{
    build_v3_error_01_source_raised, V3Error01SourceRaised, V3ErrorSourceKind,
};
use crate::sse_object_pipeline::{SseObjectConsumer, SseObjectConsumerAction, SseObjectError, SseObjectFrame};
use routecodex_v3_sse::{SseTransportError, SseTransportErrorExport};

/// Direct response content compatibility as an SSE object consumer.
///
/// The Direct stream invokes this consumer after transport framing and before
/// client projection, so compatibility rewrites remain object-level.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct V3DirectSseContentConsumer {
    pub(crate) retain_response_cipher: bool,
    pub(crate) strip_client_response_id: bool,
    pub(crate) deepseek_console_go: bool,
    pub(crate) typed_hooks: V3DirectSseTypedHookCatalog,
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
    responses_rewrite:
        fn(&mut V3ResponsesSseSemanticObject) -> Result<(), V3ResponsesSseTreeError>,
    chat_notify: for<'a> fn(&V3OpenAiChatSseHookInput<'a>),
    chat_rewrite:
        fn(&mut V3OpenAiChatSseSemanticObject) -> Result<(), V3OpenAiChatSseTreeError>,
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
            responses_rewrite: noop_responses_rewrite,
            chat_notify: noop_chat_notify,
            chat_rewrite: noop_chat_rewrite,
        }
    }

    pub(crate) const fn with_responses(
        mut self,
        notify: for<'a> fn(&V3ResponsesSseHookInput<'a>),
        rewrite: fn(
            &mut V3ResponsesSseSemanticObject,
        ) -> Result<(), V3ResponsesSseTreeError>,
    ) -> Self {
        self.responses_notify = notify;
        self.responses_rewrite = rewrite;
        self
    }

    pub(crate) const fn with_chat(
        mut self,
        notify: for<'a> fn(&V3OpenAiChatSseHookInput<'a>),
        rewrite: fn(
            &mut V3OpenAiChatSseSemanticObject,
        ) -> Result<(), V3OpenAiChatSseTreeError>,
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
    pub(crate) fn with_typed_hooks(mut self, typed_hooks: V3DirectSseTypedHookCatalog) -> Self {
        self.typed_hooks = typed_hooks;
        self
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
        let Some(original) = object.data_value().cloned() else {
            return Ok(SseObjectConsumerAction::Pass);
        };
        let mut rewritten = project_direct_typed_protocol_data(&original, &self.typed_hooks)?;
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

fn project_direct_typed_protocol_data(
    value: &serde_json::Value,
    typed_hooks: &V3DirectSseTypedHookCatalog,
) -> Result<serde_json::Value, SseObjectError> {
    let Some(object) = value.as_object() else {
        return Ok(value.clone());
    };
    if object
        .get("object")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|object_type| object_type == "chat.completion.chunk")
    {
        let mut semantic = classify_v3_openai_chat_sse_chunk(value)
            .map_err(|error| SseObjectError::Consumer { message: error.to_string() })?;
        let transport = crate::hub_v1::V3OpenAiChatSseTransportObject::new(None, value.clone());
        let protocol = semantic.protocol.clone();
        typed_hooks.apply_chat(&mut semantic, &transport, &protocol)
        .map_err(|error| SseObjectError::Consumer { message: error.to_string() })?;
        return Ok(project_v3_openai_chat_sse_chunk_json(&semantic));
    }
    if object
        .get("type")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|event_type| event_type.starts_with("response."))
    {
        let mut semantic = classify_v3_responses_sse_event(value)
            .map_err(|error| SseObjectError::Consumer { message: error.to_string() })?;
        let transport = crate::hub_v1::V3ResponsesSseTransportObject::new(None, value.clone());
        let protocol = semantic.protocol.clone();
        typed_hooks.apply_responses(&mut semantic, &transport, &protocol)
        .map_err(|error| SseObjectError::Consumer { message: error.to_string() })?;
        return Ok(project_v3_responses_sse_event_json(&semantic));
    }
    Ok(value.clone())
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
            retain_response_cipher: false,
            strip_client_response_id: true,
            deepseek_console_go: false,
            typed_hooks: V3DirectSseTypedHookCatalog::default(),
        };
        let mut object = SseObjectFrame::from_json(
            r#"{"response":{"id":"resp_1"},"encrypted_content":"rsn_secret","delta":"keep"}"#,
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
            retain_response_cipher: true,
            strip_client_response_id: false,
            deepseek_console_go: false,
            typed_hooks: V3DirectSseTypedHookCatalog::default(),
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
    fn direct_consumer_projects_chat_chunk_from_typed_tree_and_preserves_extension() {
        let mut consumer = V3DirectSseContentConsumer::default();
        let mut object = SseObjectFrame::from_json(
            r#"{"id":"chat_1","object":"chat.completion.chunk","created":7,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}],"vendor_extension":{"x":1}}"#,
        )
        .unwrap();
        assert_eq!(
            consumer.consume(&mut object).unwrap(),
            SseObjectConsumerAction::RewriteData
        );
        assert_eq!(object.data_value().unwrap()["choices"][0]["delta"]["content"], "ok");
        assert_eq!(object.data_value().unwrap()["vendor_extension"]["x"], 1);
    }

    #[test]
    fn direct_consumer_projects_responses_event_from_typed_tree_and_preserves_extension() {
        let mut consumer = V3DirectSseContentConsumer::default();
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
        let mut consumer = V3DirectSseContentConsumer::default().with_typed_hooks(catalog);
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
        let classified = routecodex_v3_error::build_v3_error_02_classified_from_v3_error_01(
            source,
        );
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
            exhaustion,
            None,
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
        assert_ne!(projected.body.get("response"), Some(&serde_json::json!({"status":"completed"})));
    }
}

use super::{
    V3OpenAiChatSseHookInput, V3OpenAiChatSseSemanticObject, V3OpenAiChatSseTreeError,
    V3ResponsesSseContentRewrite, V3ResponsesSseHookInput, V3ResponsesSseSemanticObject,
    V3ResponsesSseTreeError,
};

/// Relay response business-hook catalog.
///
/// This catalog is deliberately separate from the Direct request-key catalog.
/// It can observe protocol-owned typed objects and rewrite registered business
/// fields only. Control transitions, routing, continuation, health, and
/// MetadataCenter state remain in their existing Hub owners.
#[derive(Clone, Copy)]
pub(crate) struct V3RelaySseHookCatalog {
    responses_notify: for<'a> fn(&V3ResponsesSseHookInput<'a>),
    responses_rewrite: fn(&mut V3ResponsesSseSemanticObject) -> Result<(), V3ResponsesSseTreeError>,
    chat_notify: for<'a> fn(&V3OpenAiChatSseHookInput<'a>),
    chat_rewrite: fn(&mut V3OpenAiChatSseSemanticObject) -> Result<(), V3OpenAiChatSseTreeError>,
}

impl std::fmt::Debug for V3RelaySseHookCatalog {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("V3RelaySseHookCatalog")
            .field("responses_notify", &"registered")
            .field("responses_rewrite", &"registered")
            .field("chat_notify", &"registered")
            .field("chat_rewrite", &"registered")
            .finish()
    }
}

impl V3RelaySseHookCatalog {
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

    pub(crate) fn notify_responses(&self, input: &V3ResponsesSseHookInput<'_>) {
        (self.responses_notify)(input);
    }

    pub(crate) fn rewrite_responses(
        &self,
        semantic: &mut V3ResponsesSseSemanticObject,
    ) -> Result<(), V3ResponsesSseTreeError> {
        (self.responses_rewrite)(semantic)
    }

    pub(crate) fn notify_chat(&self, input: &V3OpenAiChatSseHookInput<'_>) {
        (self.chat_notify)(input);
    }

    pub(crate) fn rewrite_chat(
        &self,
        semantic: &mut V3OpenAiChatSseSemanticObject,
    ) -> Result<(), V3OpenAiChatSseTreeError> {
        (self.chat_rewrite)(semantic)
    }
}

impl Default for V3RelaySseHookCatalog {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn rewrite_responses(
        semantic: &mut V3ResponsesSseSemanticObject,
    ) -> Result<(), V3ResponsesSseTreeError> {
        semantic.rewrite_item_content(V3ResponsesSseContentRewrite::Text(
            "relay catalog rewrite".to_owned(),
        ))
    }

    fn rewrite_chat(
        semantic: &mut V3OpenAiChatSseSemanticObject,
    ) -> Result<(), V3OpenAiChatSseTreeError> {
        for choice in &mut semantic.choices {
            if let super::super::V3OpenAiChatSseDelta::Text(text) = &mut choice.delta {
                *text = "relay catalog rewrite".to_owned();
            }
        }
        Ok(())
    }

    #[test]
    fn catalog_keeps_responses_and_chat_mounts_independent() {
        let catalog = V3RelaySseHookCatalog::new()
            .with_responses(noop_responses_notify, rewrite_responses)
            .with_chat(noop_chat_notify, rewrite_chat);
        let mut responses = super::super::classify_v3_responses_sse_event(&serde_json::json!({
            "type":"response.output_item.done",
            "output_index":0,
            "item":{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"output_text","text":"original"}]}
        }))
        .unwrap();
        catalog.rewrite_responses(&mut responses).unwrap();
        assert_eq!(
            responses.item().and_then(|item| item.rewritten_content()),
            Some("relay catalog rewrite")
        );

        let mut chat = super::super::classify_v3_openai_chat_sse_chunk(&serde_json::json!({
            "object":"chat.completion.chunk",
            "choices":[{"index":0,"delta":{"content":"original"},"finish_reason":null}]
        }))
        .unwrap();
        catalog.rewrite_chat(&mut chat).unwrap();
        assert_eq!(
            chat.choices[0].delta,
            super::super::V3OpenAiChatSseDelta::Text("relay catalog rewrite".to_owned())
        );
    }
}

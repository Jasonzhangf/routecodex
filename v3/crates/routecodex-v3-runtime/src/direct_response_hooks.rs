//! Typed Direct response lifecycle and target-selected compatibility plan.
//!
//! This module owns hook ordering and compat selection only. It does not parse
//! SSE frames, classify provider errors, observe continuation, or mutate
//! client payloads. Those operations remain adjacent stage owners.

use crate::hub_v1::V3HubProviderWireProtocol;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3DirectResponseCompatBlock {
    Passthrough,
    ThinkingTags,
    DeepseekConsoleGoResponseShape,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3DirectResponseCompatFacts<'a> {
    pub provider_protocol: V3HubProviderWireProtocol,
    pub canonical_model_id: &'a str,
    pub model_capabilities: &'a [&'a str],
    pub compatibility_profile: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3DirectResponseCompatPlan {
    pub canonical_model_id: String,
    pub blocks: Vec<V3DirectResponseCompatBlock>,
}

impl V3DirectResponseCompatPlan {
    pub fn has_block(&self, block: V3DirectResponseCompatBlock) -> bool {
        self.blocks.contains(&block)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3DirectResponseCompatContext {
    pub provider_protocol: V3HubProviderWireProtocol,
    pub canonical_model_id: String,
    pub model_capabilities: Vec<String>,
    pub compatibility_profile: Option<String>,
    pub tool_thinking_enabled: bool,
}

impl V3DirectResponseCompatContext {
    pub fn compile_plan(&self) -> Result<V3DirectResponseCompatPlan, String> {
        let capabilities = self
            .model_capabilities
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        compile_direct_response_compat_plan(V3DirectResponseCompatFacts {
            provider_protocol: self.provider_protocol,
            canonical_model_id: &self.canonical_model_id,
            model_capabilities: &capabilities,
            compatibility_profile: self.compatibility_profile.as_deref(),
        })
    }
}

pub fn compile_direct_response_compat_plan(
    facts: V3DirectResponseCompatFacts<'_>,
) -> Result<V3DirectResponseCompatPlan, String> {
    let profile = facts
        .compatibility_profile
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let supports_reasoning = facts
        .model_capabilities
        .iter()
        .any(|capability| matches!(capability.trim(), "reasoning" | "thinking"));
    let block = match profile {
        None => V3DirectResponseCompatBlock::Passthrough,
        Some("responses:thinking-tags" | "responses:cc" | "responses:deepseek-console-go")
            if facts.provider_protocol != V3HubProviderWireProtocol::Responses =>
        {
            return Err(format!(
                "unsupported direct response compatibility profile {} for protocol {:?} model {}",
                profile.unwrap_or_default(),
                facts.provider_protocol,
                facts.canonical_model_id
            ));
        }
        Some("responses:thinking-tags" | "responses:cc")
            if facts.provider_protocol == V3HubProviderWireProtocol::Responses
                && supports_reasoning =>
        {
            V3DirectResponseCompatBlock::ThinkingTags
        }
        Some("responses:deepseek-console-go")
            if facts.provider_protocol == V3HubProviderWireProtocol::Responses
                && supports_reasoning =>
        {
            V3DirectResponseCompatBlock::DeepseekConsoleGoResponseShape
        }
        Some("responses:thinking-tags" | "responses:cc" | "responses:deepseek-console-go") => {
            return Err(format!(
                "direct response compatibility profile requires reasoning capability for model {}",
                facts.canonical_model_id
            ));
        }
        Some(unknown) => {
            return Err(format!(
                "unsupported direct response compatibility profile {unknown} for protocol {:?} model {}",
                facts.provider_protocol, facts.canonical_model_id
            ));
        }
    };
    Ok(V3DirectResponseCompatPlan {
        canonical_model_id: facts.canonical_model_id.to_string(),
        blocks: vec![block],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compat_plan_uses_configured_profile_and_canonical_model() {
        let plan = compile_direct_response_compat_plan(V3DirectResponseCompatFacts {
            provider_protocol: V3HubProviderWireProtocol::Responses,
            canonical_model_id: "gpt-5.6-sol",
            model_capabilities: &["text", "reasoning"],
            compatibility_profile: Some("responses:thinking-tags"),
        })
        .expect("configured profile must compile");
        assert_eq!(plan.canonical_model_id, "gpt-5.6-sol");
        assert_eq!(plan.blocks, vec![V3DirectResponseCompatBlock::ThinkingTags]);
    }

    #[test]
    fn compat_plan_does_not_guess_from_provider_or_model() {
        let plan = compile_direct_response_compat_plan(V3DirectResponseCompatFacts {
            provider_protocol: V3HubProviderWireProtocol::Responses,
            canonical_model_id: "cc-sol-looking-model",
            model_capabilities: &["text"],
            compatibility_profile: None,
        })
        .expect("missing profile must remain passthrough");
        assert_eq!(plan.blocks, vec![V3DirectResponseCompatBlock::Passthrough]);
    }

    #[test]
    fn compat_plan_rejects_profile_protocol_mismatch() {
        let error = compile_direct_response_compat_plan(V3DirectResponseCompatFacts {
            provider_protocol: V3HubProviderWireProtocol::OpenAiChat,
            canonical_model_id: "gpt-5.6-sol",
            model_capabilities: &["text"],
            compatibility_profile: Some("responses:thinking-tags"),
        })
        .expect_err("responses profile must not attach to Chat direct");
        assert!(error.contains("unsupported direct response compatibility profile"));
    }
}

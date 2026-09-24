//! Typed Direct response lifecycle and target-selected compatibility plan.
//!
//! This module owns hook ordering and compat selection only. It does not parse
//! SSE frames, classify provider errors, observe continuation, or mutate
//! client payloads. Those operations remain adjacent stage owners.

use crate::hub_v1::V3HubProviderWireProtocol;
use crate::hub_v1::V3ToolThinkingTurnContext;
use crate::runtime_timing::V3RuntimeTimingState;
use routecodex_v3_config::V3Config05ManifestPublished;

/// The sole Direct response payload hook for protocol-neutral response cleanup.
/// Both buffered JSON and SSE consumers call this owner; neither transport
/// layer may reimplement response-id or cipher projection.
pub(crate) fn apply_v3_direct_response_projection_hooks(
    payload: &mut serde_json::Value,
    strip_client_response_id: bool,
    retain_response_cipher: bool,
) {
    if !retain_response_cipher {
        routecodex_v3_provider_responses::apply_v3_response_cipher_policy(payload, false);
    }
    if strip_client_response_id {
        crate::shared::strip_v3_response_id_from_json_body(payload);
    }
}

pub(crate) fn apply_v3_memory_raw_capture_json_payload(
    payload: &mut serde_json::Value,
    manifest: &V3Config05ManifestPublished,
    request_id: &str,
) {
    if !manifest.memory_raw_capture.enabled {
        return;
    }
    let host_id = routecodex_v3_agent_memory::stable_host_id(&format!(
        "{}{}",
        manifest.memory_raw_capture.host_id_prefix, request_id
    ));
    let report =
        match routecodex_v3_agent_memory::capture_responses_json(payload, &host_id, request_id) {
            Ok(report) => report,
            Err(error) => {
                eprintln!("memory capture diagnostic request_id={request_id}: {error}");
                return;
            }
        };
    if report.memory_unit_found {
        routecodex_v3_agent_memory::strip_memory_envelope_from_responses_payload(payload, &report);
        for captured in &report.captured {
            if let Err(error) = routecodex_v3_agent_memory::publish_l3_entry(
                &manifest.memory_raw_capture.project_root,
                captured,
            ) {
                eprintln!("memory l3 publication diagnostic request_id={request_id}: {error}");
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V3DirectResponseCompatBlock {
    Passthrough,
    ThinkingTags,
    DeepseekConsoleGoResponseShape,
}

#[derive(Debug, Clone)]
pub struct V3DirectResponseCompatFacts<'a> {
    pub provider_protocol: V3HubProviderWireProtocol,
    pub canonical_model_id: &'a str,
    pub model_capabilities: &'a [&'a str],
    pub compatibility_profile: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3DirectResponseCompatPlan {
    pub provider_protocol: V3HubProviderWireProtocol,
    pub canonical_model_id: String,
    pub blocks: Vec<V3DirectResponseCompatBlock>,
}

impl V3DirectResponseCompatPlan {
    pub fn has_block(&self, block: V3DirectResponseCompatBlock) -> bool {
        self.blocks.contains(&block)
    }
}

#[derive(Debug, Clone)]
pub struct V3DirectResponseCompatContext {
    pub provider_protocol: V3HubProviderWireProtocol,
    pub canonical_model_id: String,
    pub model_capabilities: Vec<String>,
    pub compatibility_profile: Option<String>,
    pub tool_thinking_enabled: bool,
    pub toolreason_client_projection: bool,
    pub toolreason_observation_session_id: Option<String>,
    pub tool_thinking_turn_context: V3ToolThinkingTurnContext,
    pub(crate) runtime_timing: V3RuntimeTimingState,
}

impl V3DirectResponseCompatContext {
    pub(crate) fn with_runtime_timing(mut self, runtime_timing: V3RuntimeTimingState) -> Self {
        self.runtime_timing = runtime_timing;
        self
    }

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
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase);
    let supports_reasoning = facts
        .model_capabilities
        .iter()
        .any(|capability| matches!(capability.trim(), "reasoning" | "thinking"));
    let block = match profile.as_deref() {
        None => V3DirectResponseCompatBlock::Passthrough,
        Some("chat:openai") if facts.provider_protocol == V3HubProviderWireProtocol::OpenAiChat => {
            V3DirectResponseCompatBlock::Passthrough
        }
        Some("responses:thinking-tags" | "responses:cc" | "responses:deepseek-console-go")
            if facts.provider_protocol != V3HubProviderWireProtocol::Responses =>
        {
            return Err(format!(
                "unsupported direct response compatibility profile {} for protocol {:?} model {}",
                profile.as_deref().unwrap_or_default(),
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
        provider_protocol: facts.provider_protocol,
        canonical_model_id: facts.canonical_model_id.to_string(),
        blocks: vec![block],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    #[test]
    fn chat_direct_accepts_openai_compat_profile_without_response_rewrite() {
        let plan = compile_direct_response_compat_plan(V3DirectResponseCompatFacts {
            provider_protocol: V3HubProviderWireProtocol::OpenAiChat,
            canonical_model_id: "deepseek-v4.1-flash",
            model_capabilities: &["text", "tools"],
            compatibility_profile: Some("chat:openai"),
        })
        .expect("chat:openai is a declared Chat provider profile");
        assert_eq!(plan.blocks, vec![V3DirectResponseCompatBlock::Passthrough]);
        let mixed_case = compile_direct_response_compat_plan(V3DirectResponseCompatFacts {
            provider_protocol: V3HubProviderWireProtocol::OpenAiChat,
            canonical_model_id: "deepseek-v4.1-flash",
            model_capabilities: &["text", "tools"],
            compatibility_profile: Some("chat:OpenAI"),
        })
        .expect("profile matching follows request compat normalization");
        assert_eq!(
            mixed_case.blocks,
            vec![V3DirectResponseCompatBlock::Passthrough]
        );
    }

    #[test]
    fn direct_response_projection_preserves_function_output_cipher_only() {
        let mut payload = json!({
            "output": [
                {
                    "type": "reasoning",
                    "encrypted_content": "rsn_reasoning_cipher"
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "encrypted_content": "rsn_opaque_function_output"
                }
            ]
        });

        apply_v3_direct_response_projection_hooks(&mut payload, false, false);

        assert!(payload["output"][0].get("encrypted_content").is_none());
        assert_eq!(
            payload["output"][1]["encrypted_content"],
            "rsn_opaque_function_output"
        );
    }
}

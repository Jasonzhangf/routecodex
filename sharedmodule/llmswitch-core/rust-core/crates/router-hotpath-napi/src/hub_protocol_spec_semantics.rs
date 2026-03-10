use napi::bindgen_prelude::Result as NapiResult;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveHubProtocolSpecInput {
    protocol: Option<String>,
    allowlists: HubProtocolAllowlists,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HubProtocolAllowlistsOutput {
    openai_chat_allowed_fields: Vec<String>,
    openai_chat_parameters_wrapper_allow_keys: Vec<String>,
    openai_responses_allowed_fields: Vec<String>,
    openai_responses_parameters_wrapper_allow_keys: Vec<String>,
    anthropic_allowed_fields: Vec<String>,
    anthropic_parameters_wrapper_allow_keys: Vec<String>,
    gemini_allowed_fields: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HubProtocolAllowlists {
    openai_chat_allowed_fields: Vec<String>,
    openai_chat_parameters_wrapper_allow_keys: Vec<String>,
    openai_responses_allowed_fields: Vec<String>,
    openai_responses_parameters_wrapper_allow_keys: Vec<String>,
    anthropic_allowed_fields: Vec<String>,
    anthropic_parameters_wrapper_allow_keys: Vec<String>,
    gemini_allowed_fields: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProviderOutboundLayoutRule {
    code: String,
    path: String,
    detail: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProviderOutboundWrapperFlattenRule {
    wrapper_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    allow_keys: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    alias_keys: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    only_if_target_missing: Option<bool>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProviderOutboundPolicySpec {
    enforce_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    allowed_top_level_keys: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    enforce_allowed_top_level_keys: Option<bool>,
    reserved_key_prefixes: Vec<String>,
    forbid_wrappers: Vec<ProviderOutboundLayoutRule>,
    flatten_wrappers: Vec<ProviderOutboundWrapperFlattenRule>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ToolSurfaceSpec {
    expected_tool_format: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_history_carrier: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProtocolSpecOutput {
    id: String,
    provider_outbound: ProviderOutboundPolicySpec,
    tool_surface: ToolSurfaceSpec,
}

fn build_default_spec(allowlists: &HubProtocolAllowlists) -> ProtocolSpecOutput {
    let mut alias_keys = BTreeMap::new();
    alias_keys.insert("max_output_tokens".to_string(), "max_tokens".to_string());

    ProtocolSpecOutput {
        id: "openai-chat".to_string(),
        provider_outbound: ProviderOutboundPolicySpec {
            enforce_enabled: true,
            allowed_top_level_keys: Some(allowlists.openai_chat_allowed_fields.clone()),
            enforce_allowed_top_level_keys: Some(true),
            forbid_wrappers: vec![
                ProviderOutboundLayoutRule {
                    code: "forbid_wrapper".to_string(),
                    path: "parameters".to_string(),
                    detail: "OpenAI Chat provider payload must not contain a top-level parameters wrapper (expects flattened fields).".to_string(),
                },
                ProviderOutboundLayoutRule {
                    code: "forbid_wrapper".to_string(),
                    path: "request".to_string(),
                    detail: "OpenAI Chat provider payload must not contain a nested request wrapper.".to_string(),
                },
            ],
            reserved_key_prefixes: vec!["__".to_string(), "_".to_string()],
            flatten_wrappers: vec![
                ProviderOutboundWrapperFlattenRule {
                    wrapper_key: "request".to_string(),
                    allow_keys: None,
                    alias_keys: None,
                    only_if_target_missing: Some(true),
                },
                ProviderOutboundWrapperFlattenRule {
                    wrapper_key: "parameters".to_string(),
                    allow_keys: Some(allowlists.openai_chat_parameters_wrapper_allow_keys.clone()),
                    alias_keys: Some(alias_keys),
                    only_if_target_missing: Some(true),
                },
            ],
        },
        tool_surface: ToolSurfaceSpec {
            expected_tool_format: "openai".to_string(),
            expected_history_carrier: Some("messages".to_string()),
        },
    }
}

fn build_openai_responses_spec(allowlists: &HubProtocolAllowlists) -> ProtocolSpecOutput {
    let mut alias_keys = BTreeMap::new();
    alias_keys.insert("max_tokens".to_string(), "max_output_tokens".to_string());

    ProtocolSpecOutput {
        id: "openai-responses".to_string(),
        provider_outbound: ProviderOutboundPolicySpec {
            enforce_enabled: true,
            allowed_top_level_keys: Some(allowlists.openai_responses_allowed_fields.clone()),
            enforce_allowed_top_level_keys: Some(true),
            forbid_wrappers: vec![
                ProviderOutboundLayoutRule {
                    code: "forbid_wrapper".to_string(),
                    path: "parameters".to_string(),
                    detail: "Responses provider payload must not contain a top-level parameters wrapper (expects flattened fields).".to_string(),
                },
                ProviderOutboundLayoutRule {
                    code: "forbid_wrapper".to_string(),
                    path: "request".to_string(),
                    detail: "Responses provider payload must not contain a nested request wrapper.".to_string(),
                },
            ],
            reserved_key_prefixes: vec!["__".to_string(), "_".to_string()],
            flatten_wrappers: vec![
                ProviderOutboundWrapperFlattenRule {
                    wrapper_key: "request".to_string(),
                    allow_keys: None,
                    alias_keys: None,
                    only_if_target_missing: Some(true),
                },
                ProviderOutboundWrapperFlattenRule {
                    wrapper_key: "parameters".to_string(),
                    allow_keys: Some(
                        allowlists
                            .openai_responses_parameters_wrapper_allow_keys
                            .clone(),
                    ),
                    alias_keys: Some(alias_keys),
                    only_if_target_missing: Some(true),
                },
            ],
        },
        tool_surface: ToolSurfaceSpec {
            expected_tool_format: "openai".to_string(),
            expected_history_carrier: Some("input".to_string()),
        },
    }
}

fn build_anthropic_spec(allowlists: &HubProtocolAllowlists) -> ProtocolSpecOutput {
    let mut alias_keys = BTreeMap::new();
    alias_keys.insert("max_output_tokens".to_string(), "max_tokens".to_string());

    ProtocolSpecOutput {
        id: "anthropic-messages".to_string(),
        provider_outbound: ProviderOutboundPolicySpec {
            enforce_enabled: true,
            allowed_top_level_keys: Some(allowlists.anthropic_allowed_fields.clone()),
            enforce_allowed_top_level_keys: Some(true),
            forbid_wrappers: vec![
                ProviderOutboundLayoutRule {
                    code: "forbid_wrapper".to_string(),
                    path: "parameters".to_string(),
                    detail: "Anthropic Messages provider payload must not contain a top-level parameters wrapper.".to_string(),
                },
                ProviderOutboundLayoutRule {
                    code: "forbid_wrapper".to_string(),
                    path: "request".to_string(),
                    detail: "Anthropic Messages provider payload must not contain a nested request wrapper.".to_string(),
                },
            ],
            reserved_key_prefixes: vec!["__".to_string(), "_".to_string()],
            flatten_wrappers: vec![
                ProviderOutboundWrapperFlattenRule {
                    wrapper_key: "request".to_string(),
                    allow_keys: None,
                    alias_keys: None,
                    only_if_target_missing: Some(true),
                },
                ProviderOutboundWrapperFlattenRule {
                    wrapper_key: "parameters".to_string(),
                    allow_keys: Some(allowlists.anthropic_parameters_wrapper_allow_keys.clone()),
                    alias_keys: Some(alias_keys),
                    only_if_target_missing: Some(true),
                },
            ],
        },
        tool_surface: ToolSurfaceSpec {
            expected_tool_format: "anthropic".to_string(),
            expected_history_carrier: None,
        },
    }
}

fn build_gemini_spec(allowlists: &HubProtocolAllowlists) -> ProtocolSpecOutput {
    ProtocolSpecOutput {
        id: "gemini-chat".to_string(),
        provider_outbound: ProviderOutboundPolicySpec {
            enforce_enabled: true,
            allowed_top_level_keys: Some(allowlists.gemini_allowed_fields.clone()),
            enforce_allowed_top_level_keys: Some(true),
            forbid_wrappers: vec![
                ProviderOutboundLayoutRule {
                    code: "forbid_wrapper".to_string(),
                    path: "parameters".to_string(),
                    detail:
                        "Gemini provider payload must not contain a top-level parameters wrapper."
                            .to_string(),
                },
                ProviderOutboundLayoutRule {
                    code: "forbid_wrapper".to_string(),
                    path: "request".to_string(),
                    detail: "Gemini provider payload must not contain a nested request wrapper."
                        .to_string(),
                },
            ],
            reserved_key_prefixes: vec!["__".to_string(), "_".to_string()],
            flatten_wrappers: vec![ProviderOutboundWrapperFlattenRule {
                wrapper_key: "request".to_string(),
                allow_keys: None,
                alias_keys: None,
                only_if_target_missing: Some(true),
            }],
        },
        tool_surface: ToolSurfaceSpec {
            expected_tool_format: "gemini".to_string(),
            expected_history_carrier: None,
        },
    }
}

fn resolve_hub_protocol_spec(input: ResolveHubProtocolSpecInput) -> ProtocolSpecOutput {
    let normalized = input
        .protocol
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match normalized.as_str() {
        "openai-responses" => build_openai_responses_spec(&input.allowlists),
        "anthropic-messages" => build_anthropic_spec(&input.allowlists),
        "gemini-chat" => build_gemini_spec(&input.allowlists),
        _ => build_default_spec(&input.allowlists),
    }
}

fn build_default_allowlists() -> HubProtocolAllowlistsOutput {
    HubProtocolAllowlistsOutput {
        openai_chat_allowed_fields: vec![
            "messages".to_string(),
            "tools".to_string(),
            "tool_outputs".to_string(),
            "model".to_string(),
            "temperature".to_string(),
            "top_p".to_string(),
            "top_k".to_string(),
            "max_tokens".to_string(),
            "frequency_penalty".to_string(),
            "presence_penalty".to_string(),
            "logit_bias".to_string(),
            "response_format".to_string(),
            "parallel_tool_calls".to_string(),
            "tool_choice".to_string(),
            "seed".to_string(),
            "user".to_string(),
            "metadata".to_string(),
            "stop".to_string(),
            "stop_sequences".to_string(),
            "stream".to_string(),
            "thinking".to_string(),
            "reasoning".to_string(),
        ],
        anthropic_allowed_fields: vec![
            "model".to_string(),
            "messages".to_string(),
            "tools".to_string(),
            "system".to_string(),
            "stop_sequences".to_string(),
            "temperature".to_string(),
            "top_p".to_string(),
            "top_k".to_string(),
            "max_tokens".to_string(),
            "max_output_tokens".to_string(),
            "metadata".to_string(),
            "stream".to_string(),
            "tool_choice".to_string(),
        ],
        openai_responses_allowed_fields: vec![
            "id".to_string(),
            "object".to_string(),
            "created_at".to_string(),
            "model".to_string(),
            "status".to_string(),
            "input".to_string(),
            "instructions".to_string(),
            "output".to_string(),
            "output_text".to_string(),
            "required_action".to_string(),
            "response_id".to_string(),
            "previous_response_id".to_string(),
            "tool_outputs".to_string(),
            "tools".to_string(),
            "metadata".to_string(),
            "include".to_string(),
            "store".to_string(),
            "user".to_string(),
            "response_format".to_string(),
            "temperature".to_string(),
            "top_p".to_string(),
            "top_k".to_string(),
            "max_tokens".to_string(),
            "max_output_tokens".to_string(),
            "logit_bias".to_string(),
            "seed".to_string(),
            "parallel_tool_calls".to_string(),
            "tool_choice".to_string(),
            "prompt_cache_key".to_string(),
            "reasoning".to_string(),
            "stream".to_string(),
            "instructions_is_raw".to_string(),
        ],
        gemini_allowed_fields: vec![
            "model".to_string(),
            "contents".to_string(),
            "systemInstruction".to_string(),
            "system_instruction".to_string(),
            "generationConfig".to_string(),
            "generation_config".to_string(),
            "safetySettings".to_string(),
            "safety_settings".to_string(),
            "metadata".to_string(),
            "toolConfig".to_string(),
            "tool_config".to_string(),
            "tools".to_string(),
            "tool_choice".to_string(),
            "parallelToolCalls".to_string(),
            "parallel_tool_calls".to_string(),
            "responseMimeType".to_string(),
            "response_mime_type".to_string(),
            "stopSequences".to_string(),
            "stop_sequences".to_string(),
            "cachedContent".to_string(),
            "prompt".to_string(),
            "response".to_string(),
            "candidates".to_string(),
            "usageMetadata".to_string(),
            "responseMetadata".to_string(),
            "promptFeedback".to_string(),
            "modelVersion".to_string(),
            "client".to_string(),
            "user".to_string(),
            "stream".to_string(),
        ],
        openai_responses_parameters_wrapper_allow_keys: vec![
            "temperature".to_string(),
            "top_p".to_string(),
            "max_output_tokens".to_string(),
            "seed".to_string(),
            "logit_bias".to_string(),
            "user".to_string(),
            "parallel_tool_calls".to_string(),
            "tool_choice".to_string(),
            "response_format".to_string(),
            "prompt_cache_key".to_string(),
            "reasoning".to_string(),
            "stream".to_string(),
            "stop".to_string(),
            "stop_sequences".to_string(),
            "modalities".to_string(),
            "top_k".to_string(),
        ],
        openai_chat_parameters_wrapper_allow_keys: vec![
            "temperature".to_string(),
            "top_p".to_string(),
            "top_k".to_string(),
            "max_tokens".to_string(),
            "frequency_penalty".to_string(),
            "presence_penalty".to_string(),
            "logit_bias".to_string(),
            "seed".to_string(),
            "user".to_string(),
            "parallel_tool_calls".to_string(),
            "tool_choice".to_string(),
            "response_format".to_string(),
            "stream".to_string(),
            "stop".to_string(),
            "stop_sequences".to_string(),
            "thinking".to_string(),
            "reasoning".to_string(),
        ],
        anthropic_parameters_wrapper_allow_keys: vec![
            "stop_sequences".to_string(),
            "temperature".to_string(),
            "top_p".to_string(),
            "top_k".to_string(),
            "max_tokens".to_string(),
            "max_output_tokens".to_string(),
            "metadata".to_string(),
            "stream".to_string(),
            "tool_choice".to_string(),
        ],
    }
}

#[napi_derive::napi]
pub fn resolve_hub_protocol_spec_json(input_json: String) -> NapiResult<String> {
    let input: ResolveHubProtocolSpecInput =
        serde_json::from_str(&input_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let output = resolve_hub_protocol_spec(input);
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[napi_derive::napi]
pub fn resolve_hub_protocol_allowlists_json() -> NapiResult<String> {
    let output = build_default_allowlists();
    serde_json::to_string(&output).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_allowlists_include_required_keys() {
        let allowlists = build_default_allowlists();
        assert!(allowlists
            .openai_chat_allowed_fields
            .contains(&"messages".to_string()));
        assert!(allowlists
            .openai_responses_allowed_fields
            .contains(&"input".to_string()));
        assert!(allowlists
            .anthropic_allowed_fields
            .contains(&"messages".to_string()));
        assert!(allowlists
            .gemini_allowed_fields
            .contains(&"contents".to_string()));
    }

    #[test]
    fn resolve_hub_protocol_spec_defaults_to_openai_chat() {
        let allowlists = build_default_allowlists();
        let input = ResolveHubProtocolSpecInput {
            protocol: Some("unknown-protocol".to_string()),
            allowlists: HubProtocolAllowlists {
                openai_chat_allowed_fields: allowlists.openai_chat_allowed_fields,
                openai_chat_parameters_wrapper_allow_keys: allowlists
                    .openai_chat_parameters_wrapper_allow_keys,
                openai_responses_allowed_fields: allowlists.openai_responses_allowed_fields,
                openai_responses_parameters_wrapper_allow_keys: allowlists
                    .openai_responses_parameters_wrapper_allow_keys,
                anthropic_allowed_fields: allowlists.anthropic_allowed_fields,
                anthropic_parameters_wrapper_allow_keys: allowlists
                    .anthropic_parameters_wrapper_allow_keys,
                gemini_allowed_fields: allowlists.gemini_allowed_fields,
            },
        };

        let spec = resolve_hub_protocol_spec(input);
        assert_eq!(spec.id, "openai-chat");
        assert_eq!(spec.tool_surface.expected_tool_format, "openai");
    }
}

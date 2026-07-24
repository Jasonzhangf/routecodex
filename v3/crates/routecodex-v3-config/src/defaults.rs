use crate::{
    V3ContinuationPolicyAuthoringConfig, V3EntryProtocolBindingAuthoringConfig,
    V3EntryProtocolExecutionMode, V3HubFixedNode, V3HubHookAuthoringConfig, V3HubHookPhase,
    V3HubHookProfile, V3HubHookRequirement, V3HubResourceAuthoringConfig, V3HubResourceKind,
    V3HubResourceScope, V3HubV1AuthoringConfig, V3ServerExecutionAuthoringConfig,
};
use std::collections::BTreeMap;

pub(crate) fn default_hub_v1_authoring() -> V3HubV1AuthoringConfig {
    V3HubV1AuthoringConfig {
        skeleton: "hub_v1".to_string(),
        entry_protocols: vec![
            "responses".to_string(),
            "anthropic".to_string(),
            "gemini".to_string(),
            "openai_chat".to_string(),
        ],
        hook_set_id: "hub_v1.default".to_string(),
        entry_protocol_bindings: vec![
            V3EntryProtocolBindingAuthoringConfig {
                entry_protocol: "responses".to_string(),
                endpoint_patterns: vec!["/v1/responses".to_string()],
                execution_mode: V3EntryProtocolExecutionMode::Relay,
                protocol_profile_owner: "v3.entry_protocol_registry_contract".to_string(),
                implemented: true,
                forbidden_reentry_behavior:
                    "Responses endpoint must enter Hub Relay runtime and must not fall through to Direct/P6 or pending runtime."
                        .to_string(),
                runtime_owner_symbol: Some(
                    "execute_v3_responses_relay_runtime_with_default_transport"
                        .to_string(),
                ),
                runtime_owner_path: Some(
                    "v3/crates/routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs"
                        .to_string(),
                ),
                pending_owner_symbol: None,
                pending_owner_path: None,
            },
            V3EntryProtocolBindingAuthoringConfig {
                entry_protocol: "anthropic".to_string(),
                endpoint_patterns: vec!["/v1/messages".to_string()],
                execution_mode: V3EntryProtocolExecutionMode::Relay,
                protocol_profile_owner: "v3.entry_protocol_registry_contract".to_string(),
                implemented: true,
                forbidden_reentry_behavior:
                    "Anthropic Messages endpoint must not fall through to Responses Direct or pending runtime."
                        .to_string(),
                runtime_owner_symbol: Some(
                    "execute_v3_anthropic_relay_runtime_with_default_transport".to_string(),
                ),
                runtime_owner_path: Some(
                    "v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs"
                        .to_string(),
                ),
                pending_owner_symbol: None,
                pending_owner_path: None,
            },
            V3EntryProtocolBindingAuthoringConfig {
                entry_protocol: "openai_chat".to_string(),
                endpoint_patterns: vec!["/v1/chat/completions".to_string()],
                execution_mode: V3EntryProtocolExecutionMode::Relay,
                protocol_profile_owner: "v3.entry_protocol_registry_contract".to_string(),
                implemented: true,
                forbidden_reentry_behavior:
                    "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime."
                        .to_string(),
                runtime_owner_symbol: Some(
                    "execute_v3_openai_chat_relay_runtime_with_default_transport".to_string(),
                ),
                runtime_owner_path: Some(
                    "v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs"
                        .to_string(),
                ),
                pending_owner_symbol: None,
                pending_owner_path: None,
            },
            V3EntryProtocolBindingAuthoringConfig {
                entry_protocol: "gemini".to_string(),
                endpoint_patterns: vec!["/v1beta/models/:model/generateContent".to_string()],
                execution_mode: V3EntryProtocolExecutionMode::Relay,
                protocol_profile_owner: "v3.gemini_relay_runtime_integration".to_string(),
                implemented: true,
                forbidden_reentry_behavior:
                    "Gemini endpoint must not fall through to pending or direct runtime.".to_string(),
                runtime_owner_symbol: Some(
                    "execute_v3_gemini_relay_runtime_with_default_transport".to_string(),
                ),
                runtime_owner_path: Some(
                    "v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs"
                        .to_string(),
                ),
                pending_owner_symbol: None,
                pending_owner_path: None,
            },
        ],
        resources: BTreeMap::from([
            (
                "metadata_center".to_string(),
                V3HubResourceAuthoringConfig {
                    kind: V3HubResourceKind::Control,
                    scope: V3HubResourceScope::Request,
                },
            ),
            (
                "continuation_store".to_string(),
                V3HubResourceAuthoringConfig {
                    kind: V3HubResourceKind::Continuation,
                    scope: V3HubResourceScope::Server,
                },
            ),
            (
                "error_chain".to_string(),
                V3HubResourceAuthoringConfig {
                    kind: V3HubResourceKind::Error,
                    scope: V3HubResourceScope::Request,
                },
            ),
            (
                "debug_artifact".to_string(),
                V3HubResourceAuthoringConfig {
                    kind: V3HubResourceKind::Debug,
                    scope: V3HubResourceScope::Debug,
                },
            ),
            (
                "snapshot_buffer".to_string(),
                V3HubResourceAuthoringConfig {
                    kind: V3HubResourceKind::Snapshot,
                    scope: V3HubResourceScope::Debug,
                },
            ),
            (
                "provider_health".to_string(),
                V3HubResourceAuthoringConfig {
                    kind: V3HubResourceKind::ProviderHealth,
                    scope: V3HubResourceScope::Provider,
                },
            ),
        ]),
        hooks: default_hub_v1_hooks(),
    }
}

fn default_hub_v1_hooks() -> Vec<V3HubHookAuthoringConfig> {
    let mut hooks = Vec::new();
    let mut order = 0_u32;
    for node in V3HubFixedNode::ALL {
        for phase in V3HubHookPhase::ALL {
            let optional_disabled = node == V3HubFixedNode::V3HubReqInbound02Normalized
                && phase == V3HubHookPhase::Exit;
            let servertool_profile = phase == V3HubHookPhase::Entry
                && matches!(
                    node,
                    V3HubFixedNode::V3HubReqChatProcess04Governed
                        | V3HubFixedNode::V3HubRespChatProcess03Governed
                );
            let allowed_resources = match (node, phase) {
                (V3HubFixedNode::V3HubReqInbound02Normalized, V3HubHookPhase::Entry) => {
                    vec!["metadata_center".to_string()]
                }
                (V3HubFixedNode::V3HubReqChatProcess04Governed, V3HubHookPhase::Entry)
                | (V3HubFixedNode::V3HubRespChatProcess03Governed, V3HubHookPhase::Entry) => {
                    vec!["continuation_store".to_string()]
                }
                _ => Vec::new(),
            };
            let forbidden_resources = if optional_disabled {
                vec!["continuation_store".to_string()]
            } else {
                Vec::new()
            };
            hooks.push(V3HubHookAuthoringConfig {
                hook_id: format!(
                    "hub_v1.{}.{}.not_implemented",
                    node.node_id(),
                    phase.as_str()
                ),
                node,
                phase,
                requirement: if optional_disabled {
                    V3HubHookRequirement::Optional
                } else {
                    V3HubHookRequirement::Required
                },
                enabled: !optional_disabled,
                priority: 0,
                order,
                allowed_resources,
                forbidden_resources,
                profile: if servertool_profile {
                    Some(V3HubHookProfile::Servertool)
                } else {
                    None
                },
            });
            order += 1;
        }
    }
    hooks
}

pub(crate) fn default_server_execution() -> V3ServerExecutionAuthoringConfig {
    V3ServerExecutionAuthoringConfig {
        allowed_modes: vec!["direct".to_string(), "relay".to_string()],
        allowed_invocation_sources: vec![
            "client".to_string(),
            "servertool_followup".to_string(),
            "dry_run".to_string(),
        ],
        allowed_transports: vec!["json".to_string(), "sse".to_string()],
        continuation: V3ContinuationPolicyAuthoringConfig {
            allowed_owners: vec![
                "none".to_string(),
                "remote_provider".to_string(),
                "routecodex_local".to_string(),
            ],
            scope_keys: vec![
                "entry_protocol".to_string(),
                "server".to_string(),
                "routing_group".to_string(),
                "session".to_string(),
            ],
        },
    }
}

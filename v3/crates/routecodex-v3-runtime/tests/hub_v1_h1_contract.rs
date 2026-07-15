use routecodex_v3_config::{
    V3Config05ManifestPublished, V3DebugManifest, V3EntryProtocolBindingManifest,
    V3EntryProtocolExecutionMode, V3ErrorManifest, V3HubFixedNode, V3HubHookManifest,
    V3HubHookPhase, V3HubHookRequirement, V3HubResourceKind, V3HubResourceManifest,
    V3HubResourceScope, V3HubV1Manifest,
};
use routecodex_v3_runtime::{
    borrow_v3_hub_current_node, compile_v3_hub_v1_static_registry,
    compile_v3_hub_v1_static_registry_from_config, validate_v3_hub_v1_hook_manifest,
    V3HubHookEvent, V3HubHookImplementation, V3HubStartupError, V3_HUB_V1_NODE_HOOK_COUNT,
};
use std::collections::BTreeMap;

fn published_manifest() -> V3Config05ManifestPublished {
    let resources = BTreeMap::from([(
        "metadata_center".to_string(),
        V3HubResourceManifest {
            resource_id: "metadata_center".to_string(),
            kind: V3HubResourceKind::Control,
            scope: V3HubResourceScope::Request,
            may_enter_provider_body: false,
            may_enter_client_body: false,
        },
    )]);
    let mut order = 0;
    let mut hooks = Vec::with_capacity(V3_HUB_V1_NODE_HOOK_COUNT);
    for node in V3HubFixedNode::ALL {
        for phase in V3HubHookPhase::ALL {
            let optional_disabled =
                node == V3HubFixedNode::V3HubReqInbound01ClientRaw && phase == V3HubHookPhase::Exit;
            hooks.push(V3HubHookManifest {
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
                allowed_resources: vec!["metadata_center".to_string()],
                forbidden_resources: vec![],
                profile: None,
            });
            order += 1;
        }
    }
    V3Config05ManifestPublished {
        version: 3,
        hub_v1: Some(V3HubV1Manifest {
            skeleton: "hub_v1".to_string(),
            entry_protocols: vec![
                "responses".to_string(),
                "anthropic".to_string(),
                "gemini".to_string(),
                "openai_chat".to_string(),
            ],
            entry_protocol_bindings: vec![
                V3EntryProtocolBindingManifest {
                    entry_protocol: "responses".to_string(),
                    endpoint_patterns: vec!["/v1/responses".to_string()],
                    execution_mode: V3EntryProtocolExecutionMode::Direct,
                    protocol_profile_owner: "v3.entry_protocol_registry_contract".to_string(),
                    implemented: true,
                    forbidden_reentry_behavior:
                        "Responses endpoint must not fall through to relay or pending runtime."
                            .to_string(),
                    runtime_owner_symbol: Some(
                        "execute_v3_responses_direct_runtime_kernel_with_default_transport_debug_and_continuation"
                            .to_string(),
                    ),
                    runtime_owner_path: Some("v3/crates/routecodex-v3-runtime/src/kernel.rs".to_string()),
                    pending_owner_symbol: None,
                    pending_owner_path: None,
                },
                V3EntryProtocolBindingManifest {
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
                V3EntryProtocolBindingManifest {
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
                V3EntryProtocolBindingManifest {
                    entry_protocol: "gemini".to_string(),
                    endpoint_patterns: vec!["/v1beta/models/:model/generateContent".to_string()],
                    execution_mode: V3EntryProtocolExecutionMode::Relay,
                    protocol_profile_owner: "v3.gemini_relay_runtime_integration".to_string(),
                    implemented: true,
                    forbidden_reentry_behavior:
                        "Gemini endpoint must not fall through to pending or direct runtime."
                            .to_string(),
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
            hook_set_id: "hub_v1.default".to_string(),
            resources,
            hooks,
        }),
        servers: BTreeMap::new(),
        providers: BTreeMap::new(),
        forwarders: BTreeMap::new(),
        route_groups: BTreeMap::new(),
        features: BTreeMap::new(),
        debug: V3DebugManifest {
            log_console: false,
            log_file: None,
            snapshots: false,
            dry_run: false,
            retention: BTreeMap::new(),
        },
        error: V3ErrorManifest {
            policies: BTreeMap::new(),
        },
    }
}

#[test]
fn static_registry_is_closed_complete_and_deterministic() {
    let first = compile_v3_hub_v1_static_registry().expect("canonical registry");
    let second = compile_v3_hub_v1_static_registry().expect("canonical registry");
    assert_eq!(first.manifest().len(), V3_HUB_V1_NODE_HOOK_COUNT);
    assert_eq!(first.manifest().len(), second.manifest().len());
    for node in V3HubFixedNode::ALL {
        for phase in V3HubHookPhase::ALL {
            assert!(first.hook(node, phase).is_some());
        }
    }
}

#[test]
fn startup_rejects_missing_duplicate_and_unknown_hooks() {
    let mut published = published_manifest();
    let manifest = published.hub_v1.as_mut().unwrap();
    manifest.hooks.pop();
    assert!(matches!(
        validate_v3_hub_v1_hook_manifest(manifest),
        Err(V3HubStartupError::MissingHook { .. })
    ));

    let mut published = published_manifest();
    let manifest = published.hub_v1.as_mut().unwrap();
    manifest.hooks.push(manifest.hooks[0].clone());
    assert!(matches!(
        validate_v3_hub_v1_hook_manifest(manifest),
        Err(V3HubStartupError::DuplicateHook { .. })
    ));

    let mut published = published_manifest();
    let manifest = published.hub_v1.as_mut().unwrap();
    manifest.hooks[0].hook_id = "hub_v1.unknown".to_string();
    assert!(matches!(
        validate_v3_hub_v1_hook_manifest(manifest),
        Err(V3HubStartupError::UnknownHook { .. })
    ));
}

#[test]
fn runtime_consumes_published_manifest_resources_and_typed_optional_noop() {
    let published = published_manifest();
    let registry = compile_v3_hub_v1_static_registry_from_config(&published).unwrap();
    assert_eq!(registry.hook_set_id(), "hub_v1.default");
    assert_eq!(registry.manifest().len(), V3_HUB_V1_NODE_HOOK_COUNT);
    assert!(registry.resource("metadata_center").is_some());

    let required = registry
        .hook(
            V3HubFixedNode::V3HubReqInbound01ClientRaw,
            V3HubHookPhase::Entry,
        )
        .unwrap();
    assert_eq!(
        required.implementation(),
        V3HubHookImplementation::NotImplemented
    );
    assert!(required.invoke().is_err());

    let optional = registry
        .hook(
            V3HubFixedNode::V3HubReqInbound01ClientRaw,
            V3HubHookPhase::Exit,
        )
        .unwrap();
    assert_eq!(
        optional.implementation(),
        V3HubHookImplementation::DisabledNoop
    );
    assert!(matches!(
        optional.invoke(),
        Ok(V3HubHookEvent::DisabledNoop { .. })
    ));
}

#[test]
fn current_node_payload_is_borrowed_without_retention_or_clone() {
    let payload = vec![1_u8, 2, 3];
    let view = borrow_v3_hub_current_node(V3HubFixedNode::V3HubReqChatProcess04Governed, &payload);
    assert_eq!(view.node(), V3HubFixedNode::V3HubReqChatProcess04Governed);
    assert!(std::ptr::eq(view.value(), &payload));
}

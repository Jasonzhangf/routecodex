const HUB_V1_FIXED_NODES: &[&str] = &[
    "V3HubReqInbound01ClientRaw",
    "V3HubReqInbound02Normalized",
    "V3HubReqChatProcess04Governed",
    "V3HubReqExecution05Planned",
    "V3HubReqTarget06Resolved",
    "V3HubReqOutbound07ProviderSemantic",
    "ProviderReqCompat06ProviderCompat",
    "V3ProviderReqOutbound08WirePayload",
    "V3ProviderReqOutbound09TransportRequest",
    "V3ProviderRespInbound01Raw",
    "ProviderRespCompat02ProviderCompat",
    "V3HubRespInbound02Normalized",
    "V3HubRespChatProcess03Governed",
    "V3HubRespOutbound05ClientSemantic",
    "V3ServerRespOutbound06ClientFrame",
];

pub fn hub_v1_test_declaration() -> String {
    let mut order = 0u32;
    let hooks = HUB_V1_FIXED_NODES
        .iter()
        .flat_map(|node| ["entry", "exit"].map(move |phase| (*node, phase)))
        .map(|(node, phase)| {
            let current_order = order;
            order += 1;
            format!(
                r#"{{ hook_id = "hub_v1.{node}.{phase}.not_implemented", node = "{node}", phase = "{phase}", requirement = "required", priority = 0, order = {current_order}, allowed_resources = [], forbidden_resources = [] }}"#
            )
        })
        .collect::<Vec<_>>()
        .join(",\n  ");

    format!(
        r#"
[pipelines.hub_v1]
skeleton = "hub_v1"
entry_protocols = ["responses", "anthropic", "gemini", "openai_chat"]
hook_set_id = "hub_v1.default"
entry_protocol_bindings = [
  {{ entry_protocol = "responses", endpoint_patterns = ["/v1/responses", "/v1/responses/compact"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Responses endpoint must not fall through to relay or pending runtime.", runtime_owner_symbol = "execute_v3_responses_direct_runtime_kernel_with_shared_state_and_default_transport_debug", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/kernel.rs" }},
  {{ entry_protocol = "anthropic", endpoint_patterns = ["/v1/messages"], execution_mode = "relay", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "Anthropic Messages endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_anthropic_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs" }},
  {{ entry_protocol = "openai_chat", endpoint_patterns = ["/v1/chat/completions"], execution_mode = "direct", protocol_profile_owner = "v3.entry_protocol_registry_contract", implemented = true, forbidden_reentry_behavior = "OpenAI Chat endpoint must not fall through to Responses Direct or pending runtime.", runtime_owner_symbol = "execute_v3_openai_chat_direct_server_outcome", runtime_owner_path = "v3/crates/routecodex-v3-server/src/executors.rs" }},
  {{ entry_protocol = "gemini", endpoint_patterns = ["/v1beta/models/:model/generateContent"], execution_mode = "relay", protocol_profile_owner = "v3.gemini_relay_runtime_integration", implemented = true, forbidden_reentry_behavior = "Gemini endpoint must not fall through to pending or direct runtime.", runtime_owner_symbol = "execute_v3_gemini_relay_runtime_with_default_transport", runtime_owner_path = "v3/crates/routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs" }},
]
resources = {{ metadata_center = {{ kind = "control", scope = "request" }}, error_chain = {{ kind = "error", scope = "request" }}, debug_artifact = {{ kind = "debug", scope = "debug" }}, snapshot_buffer = {{ kind = "snapshot", scope = "debug" }}, provider_health = {{ kind = "provider_health", scope = "provider" }} }}
hooks = [
  {hooks}
]
"#
    )
}

pub fn hub_v1_server_execution(server_id: &str) -> String {
    format!(
        r#"
[servers.{server_id}.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
"#
    )
}

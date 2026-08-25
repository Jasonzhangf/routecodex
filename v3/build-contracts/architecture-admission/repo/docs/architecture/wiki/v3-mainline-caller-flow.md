<!-- AUTO-GENERATED: do not edit by hand. Rebuild with `npm run render:v3-mainline-caller-flow`. -->

# V3 Mainline Caller Flow

Source: `docs/architecture/v3-mainline-call-map.yml`

Generated view: 75 functional paths, 439 caller edges.

This page renders the V3 mainline edge truth as top-down caller graphs. Each functional path is grouped by implementation module and each edge shows both the function call and the contract-node transition.

Review rule: a provider/runtime response must not jump directly to client/server projection. It must pass through the response chain (`ProviderRespCompat02ProviderCompat -> V3HubRespInbound02Normalized -> V3HubRespChatProcess03Governed -> V3HubRespContinuation04Committed -> V3HubRespOutbound05ClientSemantic -> V3ServerRespOutbound06ClientFrame`) unless it is an explicitly separate direct lifecycle with its own declared nodes.

## Module caller overview

```mermaid
flowchart TD
  module_docs["docs"]
  module_docs__manifest["docs::manifest"]
  module_pending["pending"]
  module_provider_compat_core["provider-compat-core"]
  module_routecodex_v3_route_classifier["routecodex-v3-route-classifier"]
  module_routecodex_v3_sse["routecodex-v3-sse"]
  module_scripts["scripts"]
  module_v3_cli["v3-cli"]
  module_v3_config["v3-config"]
  module_v3_debug["v3-debug"]
  module_v3_error["v3-error"]
  module_v3_lifecycle["v3-lifecycle"]
  module_v3_provider_responses["v3-provider-responses"]
  module_v3_runtime["v3-runtime"]
  module_v3_runtime__hub_v1["v3-runtime::hub_v1"]
  module_v3_server["v3-server"]
  module_v3_target["v3-target"]
  module_v3_virtual_router["v3-virtual-router"]
  module_v3_scripts["v3/scripts"]
  module_pending -->|8 edges / 1 paths| module_pending
  module_routecodex_v3_route_classifier -->|3 edges / 2 paths| module_routecodex_v3_route_classifier
  module_routecodex_v3_sse -->|2 edges / 1 paths| module_routecodex_v3_sse
  module_scripts -->|2 edges / 1 paths| module_docs
  module_scripts -->|1 edges / 1 paths| module_docs__manifest
  module_v3_cli -->|1 edges / 1 paths| module_v3_lifecycle
  module_v3_config -->|1 edges / 1 paths| module_docs__manifest
  module_v3_config -->|14 edges / 6 paths| module_v3_config
  module_v3_error -->|5 edges / 1 paths| module_v3_error
  module_v3_lifecycle -->|6 edges / 1 paths| module_v3_lifecycle
  module_v3_lifecycle -->|1 edges / 1 paths| module_v3_server
  module_v3_provider_responses -->|1 edges / 1 paths| module_routecodex_v3_sse
  module_v3_provider_responses -->|5 edges / 4 paths| module_v3_provider_responses
  module_v3_runtime__hub_v1 -->|3 edges / 3 paths| module_provider_compat_core
  module_v3_runtime__hub_v1 -->|1 edges / 1 paths| module_routecodex_v3_sse
  module_v3_runtime__hub_v1 -->|2 edges / 2 paths| module_v3_error
  module_v3_runtime__hub_v1 -->|5 edges / 5 paths| module_v3_provider_responses
  module_v3_runtime__hub_v1 -->|28 edges / 4 paths| module_v3_runtime
  module_v3_runtime__hub_v1 -->|143 edges / 25 paths| module_v3_runtime__hub_v1
  module_v3_runtime -->|3 edges / 3 paths| module_routecodex_v3_route_classifier
  module_v3_runtime -->|2 edges / 1 paths| module_routecodex_v3_sse
  module_v3_runtime -->|5 edges / 1 paths| module_v3_debug
  module_v3_runtime -->|7 edges / 4 paths| module_v3_error
  module_v3_runtime -->|12 edges / 8 paths| module_v3_provider_responses
  module_v3_runtime -->|64 edges / 17 paths| module_v3_runtime
  module_v3_runtime -->|45 edges / 11 paths| module_v3_runtime__hub_v1
  module_v3_runtime -->|4 edges / 2 paths| module_v3_target
  module_v3_runtime -->|5 edges / 2 paths| module_v3_virtual_router
  module_v3_server -->|1 edges / 1 paths| module_routecodex_v3_sse
  module_v3_server -->|2 edges / 2 paths| module_v3_config
  module_v3_server -->|3 edges / 2 paths| module_v3_debug
  module_v3_server -->|4 edges / 3 paths| module_v3_error
  module_v3_server -->|5 edges / 4 paths| module_v3_runtime
  module_v3_server -->|6 edges / 5 paths| module_v3_runtime__hub_v1
  module_v3_server -->|32 edges / 18 paths| module_v3_server
  module_v3_target -->|1 edges / 1 paths| module_v3_provider_responses
  module_v3_scripts -->|6 edges / 3 paths| module_v3_scripts
```

| From module | To module | Edges | Functional paths |
| --- | --- | ---: | --- |
| pending | pending | 8 | `v3.web_search_servertool_state_machine` |
| routecodex-v3-route-classifier | routecodex-v3-route-classifier | 3 | `v3.route_policy.condition_evaluation`<br/>`vr.current_turn_typed_route_facts` |
| routecodex-v3-sse | routecodex-v3-sse | 2 | `v3.sse.transport_boundary` |
| scripts | docs | 2 | `v3.live_provider_compat.parity` |
| scripts | docs::manifest | 1 | `v3.live_provider_compat.parity` |
| v3-cli | v3-lifecycle | 1 | `v3.server.managed_lifecycle` |
| v3-config | docs::manifest | 1 | `v3.entry_protocol_endpoint_binding.mainline` |
| v3-config | v3-config | 14 | `v3.config.compact_hub_v1_defaults`<br/>`v3.config.compile`<br/>`v3.config.provider_sse_timeout_projection.mainline`<br/>`v3.config.server_manifest_compile.mainline`<br/>`v3.entry_protocol_endpoint_binding.mainline`<br/>`v3.entry_protocol_registry_contract.mainline` |
| v3-error | v3-error | 5 | `v3.debug_error_foundation.mainline` |
| v3-lifecycle | v3-lifecycle | 6 | `v3.server.managed_lifecycle` |
| v3-lifecycle | v3-server | 1 | `v3.server.managed_lifecycle` |
| v3-provider-responses | routecodex-v3-sse | 1 | `v3.sse.transport_boundary` |
| v3-provider-responses | v3-provider-responses | 5 | `v3.debug_error_foundation.mainline`<br/>`v3.provider_global_cooldown_persistence`<br/>`v3.responses.websocket_v2.transport_hardening`<br/>`v3.responses_direct.required_mainline` |
| v3-runtime::hub_v1 | provider-compat-core | 3 | `v3.provider_compat_profile.request`<br/>`v3.provider_compat_profile.response`<br/>`v3.selected_provider_model_binding` |
| v3-runtime::hub_v1 | routecodex-v3-sse | 1 | `v3.sse.protocol_codec_projection_boundary` |
| v3-runtime::hub_v1 | v3-error | 2 | `v3.provider_global_subscription_probe`<br/>`v3.route_policy.condition_evaluation` |
| v3-runtime::hub_v1 | v3-provider-responses | 5 | `v3.anthropic_relay.controlled_runtime`<br/>`v3.gemini_relay.controlled_runtime`<br/>`v3.hub_relay.runtime_closeout`<br/>`v3.openai_chat_relay.controlled_runtime`<br/>`v3.responses_relay.source_server_entry` |
| v3-runtime::hub_v1 | v3-runtime | 28 | `v3.provider_action_gate.mainline`<br/>`v3.provider_global_subscription_probe`<br/>`v3.runtime_timing_observability.mainline`<br/>`v3.selected_provider_model_binding` |
| v3-runtime::hub_v1 | v3-runtime::hub_v1 | 143 | `v3.anthropic_relay.controlled_runtime`<br/>`v3.anthropic_relay.local_continuation`<br/>`v3.config.provider_sse_timeout_projection.mainline`<br/>`v3.console_human_readable_layering.mainline`<br/>`v3.gemini_relay.controlled_runtime`<br/>`v3.hub_pipeline.v1.relay_request_source_slice`<br/>`v3.hub_pipeline.v1.relay_response_source_slice`<br/>`v3.hub_pipeline.v1.request`<br/>`v3.hub_pipeline.v1.response`<br/>`v3.hub_relay.runtime_closeout`<br/>`v3.openai_chat_relay.controlled_runtime`<br/>`v3.openai_chat_sse_typed_tree`<br/>`v3.protocol_conversion_field_parity`<br/>`v3.protocol_conversion_field_parity.outbound_helper_bindings`<br/>`v3.protocol_normalization_tool_governance_boundary`<br/>`v3.provider_action_gate.mainline`<br/>`v3.provider_compat.request_invalid_error_source`<br/>`v3.resp03_tool_governance_gap_closeout`<br/>`v3.responses_chat_sse_typed_tree`<br/>`v3.responses_provider_event.terminal_merge`<br/>`v3.runtime_timing_observability.mainline`<br/>`v3.servertool_center.skeleton`<br/>`v3.servertool_hook_skeleton_lifecycle`<br/>`v3.sse.protocol_codec_projection_boundary`<br/>`v3.tool_thinking_hook_skeleton.mainline` |
| v3-runtime | routecodex-v3-route-classifier | 3 | `v3.route_classifier.facts_classification`<br/>`v3.route_policy.condition_evaluation`<br/>`vr.current_turn_typed_route_facts` |
| v3-runtime | routecodex-v3-sse | 2 | `v3.sse_error_and_direct_consumer_pre_wiring` |
| v3-runtime | v3-debug | 5 | `v3.debug_error_foundation.mainline` |
| v3-runtime | v3-error | 7 | `v3.debug_error_foundation.mainline`<br/>`v3.hub_relay.response_failure_entry`<br/>`v3.provider_key_health_model_granularity`<br/>`v3.route_policy.condition_evaluation` |
| v3-runtime | v3-provider-responses | 12 | `v3.debug_error_foundation.mainline`<br/>`v3.provider_global_cooldown_persistence`<br/>`v3.provider_global_subscription_probe`<br/>`v3.provider_key_health_model_granularity`<br/>`v3.responses_direct.remote_continuation.integration`<br/>`v3.responses_direct.required_mainline`<br/>`v3.route_policy.condition_evaluation`<br/>`v3.selected_provider_model_binding` |
| v3-runtime | v3-runtime | 64 | `v3.console_human_readable_layering.mainline`<br/>`v3.direct.request_key_hooks`<br/>`v3.direct_sse_accept_skeleton`<br/>`v3.direct_stopless_metadata_center`<br/>`v3.provider_action_gate.mainline`<br/>`v3.provider_global_subscription_probe`<br/>`v3.responses_continuation.remote_contract_store`<br/>`v3.responses_continuation.remote_locator_codec`<br/>`v3.responses_direct.remote_continuation.integration`<br/>`v3.responses_direct.required_mainline`<br/>`v3.responses_direct_full_attempt_commit`<br/>`v3.route_policy.condition_evaluation`<br/>`v3.runtime_timing_observability.mainline`<br/>`v3.selected_provider_model_binding`<br/>`v3.sse_error_and_direct_consumer_pre_wiring`<br/>`v3.target.session_global_selection`<br/>`v3.tool_thinking_hook_skeleton.mainline` |
| v3-runtime | v3-runtime::hub_v1 | 45 | `v3.direct_stopless_metadata_center`<br/>`v3.hub_pipeline.v1.hook_registry_compile`<br/>`v3.hub_pipeline.v1.relay_payload_copy_runtime_probes`<br/>`v3.hub_relay.tool_servertool_multiturn_parity`<br/>`v3.protocol.anthropic.characterization`<br/>`v3.protocol.gemini.characterization`<br/>`v3.protocol.openai_chat.characterization`<br/>`v3.protocol_conversion_field_parity`<br/>`v3.protocol_normalization_tool_governance_boundary`<br/>`v3.runtime_timing_observability.mainline`<br/>`v3.tool_thinking_hook_skeleton.mainline` |
| v3-runtime | v3-target | 4 | `v3.responses_direct.remote_continuation.integration`<br/>`v3.responses_direct.required_mainline` |
| v3-runtime | v3-virtual-router | 5 | `v3.responses_direct.required_mainline`<br/>`v3.route_policy.condition_evaluation` |
| v3-server | routecodex-v3-sse | 1 | `v3.sse.http_keepalive_boundary` |
| v3-server | v3-config | 2 | `v3.entry_protocol_endpoint_binding.mainline`<br/>`v3.models.capability_catalog` |
| v3-server | v3-debug | 3 | `v3.codex_sample_retention_snap_scope`<br/>`v3.server.startup` |
| v3-server | v3-error | 4 | `v3.debug_error_foundation.mainline`<br/>`v3.responses_session_admission`<br/>`v3.server.startup` |
| v3-server | v3-runtime | 5 | `v3.provider_global_subscription_probe`<br/>`v3.responses.inbound_websocket_proxy`<br/>`v3.responses_direct.remote_continuation.integration`<br/>`v3.responses_direct.required_mainline` |
| v3-server | v3-runtime::hub_v1 | 6 | `v3.anthropic_relay.controlled_runtime`<br/>`v3.gemini_relay.controlled_runtime`<br/>`v3.openai_chat_relay.controlled_runtime`<br/>`v3.responses_relay.source_server_entry`<br/>`v3.runtime_timing_observability.mainline` |
| v3-server | v3-server | 32 | `v3.console_human_readable_layering.mainline`<br/>`v3.console_request_count_visibility.mainline`<br/>`v3.direct_sse_accept_skeleton`<br/>`v3.entry_protocol_endpoint_binding.mainline`<br/>`v3.error.raw_wire_evidence`<br/>`v3.gemini_relay.controlled_runtime`<br/>`v3.models.capability_catalog`<br/>`v3.openai_chat_relay.controlled_runtime`<br/>`v3.provider_global_cooldown_persistence`<br/>`v3.responses.inbound_websocket_proxy`<br/>`v3.responses_direct.required_mainline`<br/>`v3.responses_relay.source_server_entry`<br/>`v3.responses_session_admission`<br/>`v3.runtime_restart_handoff_skeleton`<br/>`v3.runtime_timing_observability.mainline`<br/>`v3.server.internal_observability_projection`<br/>`v3.server.startup`<br/>`v3.sse.transport_boundary` |
| v3-target | v3-provider-responses | 1 | `v3.provider_key_health_model_granularity` |
| v3/scripts | v3/scripts | 6 | `v3.build_test_artifact_budget`<br/>`v3.direct.request_key_hooks`<br/>`v3.global_binary_install` |

## Auto audit /补救清单

### Forbidden direct response projection edges

- none

### Forbidden source registered direct response edges

- none

### Binding-pending edges

| chain_id | step_id | from_node | to_node |
| --- | --- | --- | --- |
| v3.web_search_servertool_state_machine | v3-web-search-sm-01 | HubReqChatProcess03Governed | V3WebSearch01RouteEvidenceClassified |
| v3.web_search_servertool_state_machine | v3-web-search-sm-02 | V3WebSearch01RouteEvidenceClassified | VrRoute04SelectedTarget |
| v3.web_search_servertool_state_machine | v3-web-search-sm-03 | HubRespChatProcess03Governed | V3ServerToolState01ControlScope |
| v3.web_search_servertool_state_machine | v3-web-search-sm-04 | V3ServerToolState01ControlScope | V3WebSearch02SearchDispatchPrepared |
| v3.web_search_servertool_state_machine | v3-web-search-sm-05 | V3WebSearch02SearchDispatchPrepared | ProviderReqOutbound06WirePayload |
| v3.web_search_servertool_state_machine | v3-web-search-sm-06 | HubRespChatProcess03Governed | V3WebSearch03SearchResultCaptured |
| v3.web_search_servertool_state_machine | v3-web-search-sm-07 | V3WebSearch03SearchResultCaptured | HubRespOutbound04ClientSemantic |
| v3.web_search_servertool_state_machine | v3-web-search-sm-08 | HubReqChatProcess03Governed | V3WebSearch04ToolResultInjected |
| v3.responses_direct_full_attempt_commit | v3-direct-sse-full-attempt-buffer | V3ProviderResp14Raw | V3DirectResp14ProviderProjectionPrepared |
| v3.responses_direct_full_attempt_commit | v3-direct-sse-full-attempt-terminal-commit | V3DirectResp14ProviderProjectionPrepared | V3DirectSseAccept03ProjectedClientFrame |

### Missing caller/callee fields

- none

## Functional caller paths

## v3.provider_global_cooldown_persistence

Provider cooldown state is loaded before listeners bind, persisted on provider health mutation, and probed once after ready before re-admission.

Owner feature: `v3.provider_global_cooldown_persistence`

```mermaid
flowchart TD
  subgraph c_0_v3_provider_global_cooldown_persistence_m_v3_provider_responses["v3-provider-responses"]
    c_0_v3_provider_global_cooldown_persistence_1["v3-provider-responses<br/>V3ProviderHealthStore::from_manifest<br/><small>routecodex-v3-provider-responses/src/health.rs</small>"]
    c_0_v3_provider_global_cooldown_persistence_2["v3-provider-responses<br/>V3ProviderCooldownCoordinator::load<br/><small>routecodex-v3-provider-responses/src/global_cooldown.rs</small>"]
  end
  subgraph c_0_v3_provider_global_cooldown_persistence_m_v3_runtime["v3-runtime"]
    c_0_v3_provider_global_cooldown_persistence_0["v3-runtime<br/>V3ProviderFailureRuntimeHealth::from_manifest<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small>"]
  end
  subgraph c_0_v3_provider_global_cooldown_persistence_m_v3_server["v3-server"]
    c_0_v3_provider_global_cooldown_persistence_3["v3-server<br/>spawn_v3_server_aggregate<br/><small>routecodex-v3-server/src/lib.rs</small>"]
    c_0_v3_provider_global_cooldown_persistence_4["v3-server<br/>V3ProviderFailureRuntimeHealth::run_due_provider_key_health_probes<br/><small>routecodex-v3-server/src/lib.rs</small>"]
  end
  c_0_v3_provider_global_cooldown_persistence_0 -->|v3-provider-global-cooldown-01<br/>V3Config05ManifestPublished → V3ProviderHealthStore| c_0_v3_provider_global_cooldown_persistence_1
  c_0_v3_provider_global_cooldown_persistence_1 -->|v3-provider-global-cooldown-02<br/>V3ProviderHealthStore → V3ProviderHealthStore| c_0_v3_provider_global_cooldown_persistence_2
  c_0_v3_provider_global_cooldown_persistence_3 -->|v3-provider-global-cooldown-03<br/>V3ServerStartup01ListenerSetPreflight → V3ProviderHealthStore| c_0_v3_provider_global_cooldown_persistence_4
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-provider-global-cooldown-01` | `V3Config05ManifestPublished` → `V3ProviderHealthStore` | source_controlled | V3ProviderFailureRuntimeHealth::from_manifest<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | V3ProviderHealthStore::from_manifest<br/><small>routecodex-v3-provider-responses/src/health.rs</small> | `v3.provider_global_cooldown_persistence` |
| `v3-provider-global-cooldown-02` | `V3ProviderHealthStore` → `V3ProviderHealthStore` | source_controlled | V3ProviderHealthStore::from_manifest<br/><small>routecodex-v3-provider-responses/src/health.rs</small> | V3ProviderCooldownCoordinator::load<br/><small>routecodex-v3-provider-responses/src/global_cooldown.rs</small> | `v3.provider_global_cooldown_persistence` |
| `v3-provider-global-cooldown-03` | `V3ServerStartup01ListenerSetPreflight` → `V3ProviderHealthStore` | source_controlled | spawn_v3_server_aggregate<br/><small>routecodex-v3-server/src/lib.rs</small> | V3ProviderFailureRuntimeHealth::run_due_provider_key_health_probes<br/><small>routecodex-v3-server/src/lib.rs</small> | `v3.provider_global_cooldown_persistence` |

## v3.provider_key_health_model_granularity

Runtime passes the exact provider, auth alias, and model identity to the Provider-owned key health store; Target reads only the resulting per-model scheduling projection.

Owner feature: `v3.provider_key_health_model_granularity`

```mermaid
flowchart TD
  subgraph c_1_v3_provider_key_health_model_granularity_m_v3_error["v3-error"]
    c_1_v3_provider_key_health_model_granularity_1["v3-error<br/>build_v3_provider_failure_action_from_v3_error_02<br/><small>routecodex-v3-error/src/subscription.rs</small>"]
  end
  subgraph c_1_v3_provider_key_health_model_granularity_m_v3_provider_responses["v3-provider-responses"]
    c_1_v3_provider_key_health_model_granularity_3["v3-provider-responses<br/>V3ProviderHealthStore::record_provider_failure_action<br/><small>routecodex-v3-provider-responses/src/health.rs</small>"]
    c_1_v3_provider_key_health_model_granularity_5["v3-provider-responses<br/>V3ProviderSchedulingReader::scheduling_projection<br/><small>routecodex-v3-provider-responses/src/health.rs</small>"]
  end
  subgraph c_1_v3_provider_key_health_model_granularity_m_v3_runtime["v3-runtime"]
    c_1_v3_provider_key_health_model_granularity_0["v3-runtime<br/>V3ProviderFailureRuntimeHealth::record_provider_failure_record_from_source<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small>"]
    c_1_v3_provider_key_health_model_granularity_2["v3-runtime<br/>V3ProviderFailureRuntimeHealth::record_provider_key_failure_action<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small>"]
  end
  subgraph c_1_v3_provider_key_health_model_granularity_m_v3_target["v3-target"]
    c_1_v3_provider_key_health_model_granularity_4["v3-target<br/>V3TargetInterpreter::select_available_with_health<br/><small>routecodex-v3-target/src/lib.rs</small>"]
  end
  c_1_v3_provider_key_health_model_granularity_0 -->|v3-provider-key-health-model-01<br/>V3Error02Classified → V3ProviderFailureAction| c_1_v3_provider_key_health_model_granularity_1
  c_1_v3_provider_key_health_model_granularity_2 -->|v3-provider-key-health-model-02<br/>V3ProviderFailureAction → V3ProviderHealthStore| c_1_v3_provider_key_health_model_granularity_3
  c_1_v3_provider_key_health_model_granularity_4 -->|v3-provider-key-health-model-03<br/>V3Target09CandidateSetExpanded → V3Target10ConcreteProviderSelected| c_1_v3_provider_key_health_model_granularity_5
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-provider-key-health-model-01` | `V3Error02Classified` → `V3ProviderFailureAction` | source_controlled | V3ProviderFailureRuntimeHealth::record_provider_failure_record_from_source<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | build_v3_provider_failure_action_from_v3_error_02<br/><small>routecodex-v3-error/src/subscription.rs</small> | `v3.debug_error_foundation` |
| `v3-provider-key-health-model-02` | `V3ProviderFailureAction` → `V3ProviderHealthStore` | source_controlled | V3ProviderFailureRuntimeHealth::record_provider_key_failure_action<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | V3ProviderHealthStore::record_provider_failure_action<br/><small>routecodex-v3-provider-responses/src/health.rs</small> | `v3.provider_key_health_model_granularity` |
| `v3-provider-key-health-model-03` | `V3Target09CandidateSetExpanded` → `V3Target10ConcreteProviderSelected` | source_controlled | V3TargetInterpreter::select_available_with_health<br/><small>routecodex-v3-target/src/lib.rs</small> | V3ProviderSchedulingReader::scheduling_projection<br/><small>routecodex-v3-provider-responses/src/health.rs</small> | `v3.virtual_router_target_interpreter` |

## v3.global_binary_install

The isolated Cargo build embeds the RouteCodex version, atomically publishes one Rust binary to the user bin directory, then creates same-directory command aliases without release snapshots.

Owner feature: `v3.global_binary_install`

```mermaid
flowchart TD
  subgraph c_2_v3_global_binary_install_m_v3_scripts["v3/scripts"]
    c_2_v3_global_binary_install_0["v3/scripts<br/>buildV3Cli<br/><small>v3/scripts/install-cli.mjs</small>"]
    c_2_v3_global_binary_install_1["v3/scripts<br/>runInterruptibleCommand<br/><small>v3/scripts/install-cli.mjs</small>"]
  end
  c_2_v3_global_binary_install_0 -->|v3-install-01<br/>V3Install01SourceVersionResolved → V3Install02RustBinaryBuilt| c_2_v3_global_binary_install_1
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-install-01` | `V3Install01SourceVersionResolved` → `V3Install02RustBinaryBuilt` | anchored | buildV3Cli<br/><small>v3/scripts/install-cli.mjs</small> | runInterruptibleCommand<br/><small>v3/scripts/install-cli.mjs</small> | `v3.global_binary_install` |

## v3.direct.request_key_hooks

Direct request projection exposes typed mounts for system, developer, and tools keys; Relay JSON remains owned by req_inbound and req_chatprocess governance.

Owner feature: `v3.direct.request_key_hooks`

```mermaid
flowchart TD
  subgraph c_3_v3_direct_request_key_hooks_m_v3_runtime["v3-runtime"]
    c_3_v3_direct_request_key_hooks_0["v3-runtime<br/>responses_direct_request_projection_hook<br/><small>routecodex-v3-runtime/src/hooks.rs</small>"]
    c_3_v3_direct_request_key_hooks_1["v3-runtime<br/>apply_v3_direct_request_key_hook<br/><small>routecodex-v3-runtime/src/kernel/direct_request_key_hooks.rs</small>"]
    c_3_v3_direct_request_key_hooks_2["v3-runtime<br/>responses_direct_request_projection_hook_with_key_catalog<br/><small>routecodex-v3-runtime/src/hooks.rs</small>"]
    c_3_v3_direct_request_key_hooks_3["v3-runtime<br/>apply_v3_direct_request_key_hook_with_catalog<br/><small>routecodex-v3-runtime/src/hooks.rs</small>"]
    c_3_v3_direct_request_key_hooks_4["v3-runtime<br/>chat_direct_request_projection_hook<br/><small>routecodex-v3-runtime/src/hooks.rs</small>"]
    c_3_v3_direct_request_key_hooks_5["v3-runtime<br/>execute_v3_direct_runtime_kernel_core_with_key_catalog<br/><small>routecodex-v3-runtime/src/kernel/v3_direct_core.rs</small>"]
    c_3_v3_direct_request_key_hooks_6["v3-runtime<br/>V3ChatDirectCodec::run_request_projection<br/><small>routecodex-v3-runtime/src/kernel/v3_direct_protocol_codec.rs</small>"]
  end
  subgraph c_3_v3_direct_request_key_hooks_m_v3_scripts["v3/scripts"]
    c_3_v3_direct_request_key_hooks_7["v3/scripts<br/>main<br/><small>v3/scripts/install-cli.mjs</small>"]
    c_3_v3_direct_request_key_hooks_8["v3/scripts<br/>copyExecutableAtomic<br/><small>v3/scripts/install-cli.mjs</small>"]
    c_3_v3_direct_request_key_hooks_9["v3/scripts<br/>installAliasAtomic<br/><small>v3/scripts/install-cli.mjs</small>"]
  end
  c_3_v3_direct_request_key_hooks_0 -->|v3-direct-request-key-01<br/>V3ResponsesDirect11Policy → V3Provider12ResponsesWirePayload| c_3_v3_direct_request_key_hooks_1
  c_3_v3_direct_request_key_hooks_2 -->|v3-direct-request-key-03<br/>V3ResponsesDirect11Policy → V3Provider12ResponsesWirePayload| c_3_v3_direct_request_key_hooks_3
  c_3_v3_direct_request_key_hooks_4 -->|v3-direct-request-key-02<br/>V3ChatDirect11Policy → V3Provider12ResponsesWirePayload| c_3_v3_direct_request_key_hooks_1
  c_3_v3_direct_request_key_hooks_5 -->|v3-direct-request-key-04<br/>V3ChatDirect11Policy → V3Provider12ResponsesWirePayload| c_3_v3_direct_request_key_hooks_6
  c_3_v3_direct_request_key_hooks_7 -->|v3-install-02<br/>V3Install02RustBinaryBuilt → V3Install03DirectBinaryPublished| c_3_v3_direct_request_key_hooks_8
  c_3_v3_direct_request_key_hooks_7 -->|v3-install-03<br/>V3Install03DirectBinaryPublished → V3Install04CommandAliasesPublished| c_3_v3_direct_request_key_hooks_9
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-direct-request-key-01` | `V3ResponsesDirect11Policy` → `V3Provider12ResponsesWirePayload` | active | responses_direct_request_projection_hook<br/><small>routecodex-v3-runtime/src/hooks.rs</small> | apply_v3_direct_request_key_hook<br/><small>routecodex-v3-runtime/src/kernel/direct_request_key_hooks.rs</small> | `v3.direct.request_key_hooks` |
| `v3-direct-request-key-03` | `V3ResponsesDirect11Policy` → `V3Provider12ResponsesWirePayload` | active | responses_direct_request_projection_hook_with_key_catalog<br/><small>routecodex-v3-runtime/src/hooks.rs</small> | apply_v3_direct_request_key_hook_with_catalog<br/><small>routecodex-v3-runtime/src/hooks.rs</small> | `v3.direct.request_key_hooks` |
| `v3-direct-request-key-02` | `V3ChatDirect11Policy` → `V3Provider12ResponsesWirePayload` | active | chat_direct_request_projection_hook<br/><small>routecodex-v3-runtime/src/hooks.rs</small> | apply_v3_direct_request_key_hook<br/><small>routecodex-v3-runtime/src/kernel/direct_request_key_hooks.rs</small> | `v3.direct.request_key_hooks` |
| `v3-direct-request-key-04` | `V3ChatDirect11Policy` → `V3Provider12ResponsesWirePayload` | active | execute_v3_direct_runtime_kernel_core_with_key_catalog<br/><small>routecodex-v3-runtime/src/kernel/v3_direct_core.rs</small> | V3ChatDirectCodec::run_request_projection<br/><small>routecodex-v3-runtime/src/kernel/v3_direct_protocol_codec.rs</small> | `v3.direct.request_key_hooks` |
| `v3-install-02` | `V3Install02RustBinaryBuilt` → `V3Install03DirectBinaryPublished` | anchored | main<br/><small>v3/scripts/install-cli.mjs</small> | copyExecutableAtomic<br/><small>v3/scripts/install-cli.mjs</small> | `v3.global_binary_install` |
| `v3-install-03` | `V3Install03DirectBinaryPublished` → `V3Install04CommandAliasesPublished` | anchored | main<br/><small>v3/scripts/install-cli.mjs</small> | installAliasAtomic<br/><small>v3/scripts/install-cli.mjs</small> | `v3.global_binary_install` |

## v3.provider_compat_profile.request

The request provider-compat node consumes the adjacent provider-semantic payload plus the selected target capability carrier, validates the normal-payload boundary, applies the selected provider-family wire profile, and performs the registered session-preserving image compatibility projection only for a selected target without multimodal/vision capability.

Owner feature: `v3.provider_compat_profile_loading`

```mermaid
flowchart TD
  subgraph c_4_v3_provider_compat_profile_request_m_provider_compat_core["provider-compat-core"]
    c_4_v3_provider_compat_profile_request_1["provider-compat-core<br/>run_req_outbound_stage3_compat<br/><small>provider-compat-core/src/lib.rs</small>"]
  end
  subgraph c_4_v3_provider_compat_profile_request_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_4_v3_provider_compat_profile_request_0["v3-runtime::hub_v1<br/>apply_v3_provider_req_compat_to_provider_payload<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs</small>"]
  end
  c_4_v3_provider_compat_profile_request_0 -->|v3-provider-compat-profile-request-01<br/>V3HubReqOutbound07ProviderSemantic → ProviderReqCompat06ProviderCompat| c_4_v3_provider_compat_profile_request_1
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-provider-compat-profile-request-01` | `V3HubReqOutbound07ProviderSemantic` → `ProviderReqCompat06ProviderCompat` | anchored | apply_v3_provider_req_compat_to_provider_payload<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs</small> | run_req_outbound_stage3_compat<br/><small>provider-compat-core/src/lib.rs</small> | `v3.provider_compat_profile_loading` |

## v3.provider_compat.request_invalid_error_source

Request-shape compatibility failures enter the canonical typed Error01 source chain before relay policy and client projection.

Owner feature: `v3.provider_compat_profile_loading`

```mermaid
flowchart TD
  subgraph c_5_v3_provider_compat_request_invalid_error_source_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_5_v3_provider_compat_request_invalid_error_source_0["v3-runtime::hub_v1<br/>provider_request_relay_failure<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_failures.rs</small>"]
    c_5_v3_provider_compat_request_invalid_error_source_1["v3-runtime::hub_v1<br/>provider_request_payload_source<br/><small>routecodex-v3-runtime/src/hub_v1/provider_compat_error.rs</small>"]
  end
  c_5_v3_provider_compat_request_invalid_error_source_0 -->|v3-provider-compat-profile-request-invalid-source-01<br/>ProviderReqCompat06ProviderCompat → V3Error01SourceRaised| c_5_v3_provider_compat_request_invalid_error_source_1
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-provider-compat-profile-request-invalid-source-01` | `ProviderReqCompat06ProviderCompat` → `V3Error01SourceRaised` | anchored | provider_request_relay_failure<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_failures.rs</small> | provider_request_payload_source<br/><small>routecodex-v3-runtime/src/hub_v1/provider_compat_error.rs</small> | `v3.provider_compat_profile_loading` |

## v3.provider_compat_profile.response

The response provider-compat node consumes only the adjacent provider-raw payload, validates the normal-payload boundary, and applies the selected provider-family response profile before Hub response normalization.

Owner feature: `v3.provider_compat_profile_loading`

```mermaid
flowchart TD
  subgraph c_6_v3_provider_compat_profile_response_m_provider_compat_core["provider-compat-core"]
    c_6_v3_provider_compat_profile_response_1["provider-compat-core<br/>run_resp_inbound_stage3_compat<br/><small>provider-compat-core/src/lib.rs</small>"]
  end
  subgraph c_6_v3_provider_compat_profile_response_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_6_v3_provider_compat_profile_response_0["v3-runtime::hub_v1<br/>apply_v3_provider_resp_compat<br/><small>routecodex-v3-runtime/src/hub_v1/provider_resp_compat_02_provider_compat.rs</small>"]
  end
  c_6_v3_provider_compat_profile_response_0 -->|v3-provider-compat-profile-response-01<br/>V3ProviderRespInbound01Raw → ProviderRespCompat02ProviderCompat| c_6_v3_provider_compat_profile_response_1
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-provider-compat-profile-response-01` | `V3ProviderRespInbound01Raw` → `ProviderRespCompat02ProviderCompat` | anchored | apply_v3_provider_resp_compat<br/><small>routecodex-v3-runtime/src/hub_v1/provider_resp_compat_02_provider_compat.rs</small> | run_resp_inbound_stage3_compat<br/><small>provider-compat-core/src/lib.rs</small> | `v3.provider_compat_profile_loading` |

## v3.target.session_global_selection

Target09 candidate sets become Target10 concrete providers through one session-first selection owner shared by Direct planning, Direct pre-send revalidation, initial Relay resolution, and Relay failure reselection.

Owner feature: `v3.virtual_router_target_interpreter`

```mermaid
flowchart TD
  subgraph c_7_v3_target_session_global_selection_m_v3_runtime["v3-runtime"]
    c_7_v3_target_session_global_selection_0["v3-runtime<br/>plan_v3_responses_protocol_execution_with_provider_health<br/><small>routecodex-v3-runtime/src/kernel/direct_protocol_plan.rs</small>"]
    c_7_v3_target_session_global_selection_1["v3-runtime<br/>select_v3_target_with_session_then_global<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small>"]
    c_7_v3_target_session_global_selection_2["v3-runtime<br/>execute_v3_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel/v3_direct_core.rs</small>"]
    c_7_v3_target_session_global_selection_3["v3-runtime<br/>resolve_v3_relay_target_outcome<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small>"]
    c_7_v3_target_session_global_selection_4["v3-runtime<br/>reselect_from_captured_target_plan<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small>"]
  end
  c_7_v3_target_session_global_selection_0 -->|v3-rd-target-select-direct-plan<br/>V3Target09CandidateSetExpanded → V3Target10ConcreteProviderSelected| c_7_v3_target_session_global_selection_1
  c_7_v3_target_session_global_selection_2 -->|v3-rd-target-select-direct-kernel<br/>V3Target09CandidateSetExpanded → V3Target10ConcreteProviderSelected| c_7_v3_target_session_global_selection_1
  c_7_v3_target_session_global_selection_3 -->|v3-rd-target-select-relay-initial<br/>V3Target09CandidateSetExpanded → V3Target10ConcreteProviderSelected| c_7_v3_target_session_global_selection_1
  c_7_v3_target_session_global_selection_4 -->|v3-rd-target-select-relay-reselection<br/>V3Target09CandidateSetExpanded → V3Target10ConcreteProviderSelected| c_7_v3_target_session_global_selection_1
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-rd-target-select-direct-plan` | `V3Target09CandidateSetExpanded` → `V3Target10ConcreteProviderSelected` | anchored | plan_v3_responses_protocol_execution_with_provider_health<br/><small>routecodex-v3-runtime/src/kernel/direct_protocol_plan.rs</small> | select_v3_target_with_session_then_global<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | `v3.virtual_router_target_interpreter` |
| `v3-rd-target-select-direct-kernel` | `V3Target09CandidateSetExpanded` → `V3Target10ConcreteProviderSelected` | anchored | execute_v3_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel/v3_direct_core.rs</small> | select_v3_target_with_session_then_global<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | `v3.virtual_router_target_interpreter` |
| `v3-rd-target-select-relay-initial` | `V3Target09CandidateSetExpanded` → `V3Target10ConcreteProviderSelected` | anchored | resolve_v3_relay_target_outcome<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | select_v3_target_with_session_then_global<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | `v3.virtual_router_target_interpreter` |
| `v3-rd-target-select-relay-reselection` | `V3Target09CandidateSetExpanded` → `V3Target10ConcreteProviderSelected` | anchored | reselect_from_captured_target_plan<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | select_v3_target_with_session_then_global<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | `v3.virtual_router_target_interpreter` |

## v3.codex_sample_retention_snap_scope

Debug-bounded request and response copies move from explicit manifest authorization to the single V3CodexSampleStore-owned filesystem persistence without entering MetadataCenter or normal payload truth; diagnostic payloads remain verbatim, dev builds sample by default, error evidence force-writes, and each port retains at most 200 request directories.

Owner feature: `v3.codex_sample_retention_snap_scope`

```mermaid
flowchart TD
  subgraph c_8_v3_codex_sample_retention_snap_scope_m_v3_debug["v3-debug"]
    c_8_v3_codex_sample_retention_snap_scope_1["v3-debug<br/>V3DebugRuntime::project_payload_verbatim<br/><small>routecodex-v3-debug/src/lib.rs</small>"]
    c_8_v3_codex_sample_retention_snap_scope_2["v3-debug<br/>V3CodexSampleStore::persist<br/><small>routecodex-v3-debug/src/sample_store.rs</small>"]
  end
  subgraph c_8_v3_codex_sample_retention_snap_scope_m_v3_server["v3-server"]
    c_8_v3_codex_sample_retention_snap_scope_0["v3-server<br/>capture_v3_live_raw_request<br/><small>routecodex-v3-server/src/live_snapshot.rs</small>"]
  end
  c_8_v3_codex_sample_retention_snap_scope_0 -->|v3-codex-sample-01<br/>V3CodexSample02ManifestAuthorizationPublished → V3DebugPayloadBudgetApplied| c_8_v3_codex_sample_retention_snap_scope_1
  c_8_v3_codex_sample_retention_snap_scope_0 -->|v3-codex-sample-02<br/>V3DebugPayloadBudgetApplied → V3CodexSample06RetentionEnforced| c_8_v3_codex_sample_retention_snap_scope_2
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-codex-sample-01` | `V3CodexSample02ManifestAuthorizationPublished` → `V3DebugPayloadBudgetApplied` | anchored | capture_v3_live_raw_request<br/><small>routecodex-v3-server/src/live_snapshot.rs</small> | V3DebugRuntime::project_payload_verbatim<br/><small>routecodex-v3-debug/src/lib.rs</small> | `v3.codex_sample_retention_snap_scope` |
| `v3-codex-sample-02` | `V3DebugPayloadBudgetApplied` → `V3CodexSample06RetentionEnforced` | anchored | capture_v3_live_raw_request<br/><small>routecodex-v3-server/src/live_snapshot.rs</small> | V3CodexSampleStore::persist<br/><small>routecodex-v3-debug/src/sample_store.rs</small> | `v3.codex_sample_retention_snap_scope` |

## v3.server.managed_lifecycle

One Rust owner validates Config, declares aggregate instance identity, locks lifecycle operations, preserves old rcc start takeover for configured listener ports through managed control, foreign managed port-scoped release, and explicit listener PID signals, runs top-level start in the foreground with real Server console, retains hidden detached-child compatibility, publishes PID/control identity, restarts through one in-place exec with a nonce-bound restart plan when executable/snapshot overrides are needed, and gracefully stops the exact instance without broad kill.

Owner feature: `v3.managed_server_lifecycle`
Manifest: `docs/architecture/manifests/v3.managed_server_lifecycle.mainline.yml`

```mermaid
flowchart TD
  subgraph c_9_v3_server_managed_lifecycle_m_v3_cli["v3-cli"]
    c_9_v3_server_managed_lifecycle_10["v3-cli<br/>run_cli<br/><small>routecodex-v3-cli/src/main.rs</small>"]
  end
  subgraph c_9_v3_server_managed_lifecycle_m_v3_lifecycle["v3-lifecycle"]
    c_9_v3_server_managed_lifecycle_0["v3-lifecycle<br/>V3ManagedLifecycle::start<br/><small>routecodex-v3-lifecycle/src/lib.rs</small>"]
    c_9_v3_server_managed_lifecycle_1["v3-lifecycle<br/>V3ManagedLifecycle::declaration<br/><small>routecodex-v3-lifecycle/src/lib.rs</small>"]
    c_9_v3_server_managed_lifecycle_2["v3-lifecycle<br/>acquire_operation_lock<br/><small>routecodex-v3-lifecycle/src/fs_locks.rs</small>"]
    c_9_v3_server_managed_lifecycle_3["v3-lifecycle<br/>Command::spawn<br/><small>routecodex-v3-lifecycle/src/lib.rs</small>"]
    c_9_v3_server_managed_lifecycle_4["v3-lifecycle<br/>V3ManagedLifecycle::run_managed_child<br/><small>routecodex-v3-lifecycle/src/lib.rs</small>"]
    c_9_v3_server_managed_lifecycle_5["v3-lifecycle<br/>write_json_atomic<br/><small>routecodex-v3-lifecycle/src/fs_locks.rs</small>"]
    c_9_v3_server_managed_lifecycle_6["v3-lifecycle<br/>V3ManagedLifecycle::status<br/><small>routecodex-v3-lifecycle/src/lib.rs</small>"]
    c_9_v3_server_managed_lifecycle_7["v3-lifecycle<br/>send_control<br/><small>routecodex-v3-lifecycle/src/control_plane.rs</small>"]
    c_9_v3_server_managed_lifecycle_8["v3-lifecycle<br/>V3ManagedLifecycle::restart<br/><small>routecodex-v3-lifecycle/src/lib.rs</small>"]
    c_9_v3_server_managed_lifecycle_9["v3-lifecycle<br/>send_restart_control<br/><small>routecodex-v3-lifecycle/src/control_plane.rs</small>"]
    c_9_v3_server_managed_lifecycle_11["v3-lifecycle<br/>V3ManagedLifecycle::with_console_enabled<br/><small>routecodex-v3-lifecycle/src/lib.rs</small>"]
    c_9_v3_server_managed_lifecycle_12["v3-lifecycle<br/>V3ManagedLifecycle::stop<br/><small>routecodex-v3-lifecycle/src/lib.rs</small>"]
  end
  subgraph c_9_v3_server_managed_lifecycle_m_v3_server["v3-server"]
    c_9_v3_server_managed_lifecycle_13["v3-server<br/>V3ServerAggregateHandle::shutdown<br/><small>routecodex-v3-server/src/lib.rs</small>"]
  end
  c_9_v3_server_managed_lifecycle_0 -->|v3-life-01<br/>V3Lifecycle01ValidatedConfig → V3Lifecycle02InstanceDeclared| c_9_v3_server_managed_lifecycle_1
  c_9_v3_server_managed_lifecycle_0 -->|v3-life-02<br/>V3Lifecycle02InstanceDeclared → V3Lifecycle03OperationLocked| c_9_v3_server_managed_lifecycle_2
  c_9_v3_server_managed_lifecycle_0 -->|v3-life-03<br/>V3Lifecycle03OperationLocked → V3Lifecycle04ChildSpawned| c_9_v3_server_managed_lifecycle_3
  c_9_v3_server_managed_lifecycle_4 -->|v3-life-04<br/>V3Lifecycle04ChildSpawned → V3Lifecycle05IdentityPublished| c_9_v3_server_managed_lifecycle_5
  c_9_v3_server_managed_lifecycle_6 -->|v3-life-05<br/>V3Lifecycle05IdentityPublished → V3Lifecycle06LiveControlled| c_9_v3_server_managed_lifecycle_7
  c_9_v3_server_managed_lifecycle_8 -->|v3-life-05r<br/>V3Lifecycle06LiveControlled → V3Lifecycle05IdentityPublished| c_9_v3_server_managed_lifecycle_9
  c_9_v3_server_managed_lifecycle_10 -->|v3-life-cli-debug-01<br/>V3Cli01ResolvedDebugIntent → V3Lifecycle06LiveControlled| c_9_v3_server_managed_lifecycle_11
  c_9_v3_server_managed_lifecycle_12 -->|v3-life-06<br/>V3Lifecycle06LiveControlled → V3Lifecycle07GracefullyStopped| c_9_v3_server_managed_lifecycle_13
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-life-01` | `V3Lifecycle01ValidatedConfig` → `V3Lifecycle02InstanceDeclared` | anchored | V3ManagedLifecycle::start<br/><small>routecodex-v3-lifecycle/src/lib.rs</small> | V3ManagedLifecycle::declaration<br/><small>routecodex-v3-lifecycle/src/lib.rs</small> | `v3.managed_server_lifecycle` |
| `v3-life-02` | `V3Lifecycle02InstanceDeclared` → `V3Lifecycle03OperationLocked` | anchored | V3ManagedLifecycle::start<br/><small>routecodex-v3-lifecycle/src/lib.rs</small> | acquire_operation_lock<br/><small>routecodex-v3-lifecycle/src/fs_locks.rs</small> | `v3.managed_server_lifecycle` |
| `v3-life-03` | `V3Lifecycle03OperationLocked` → `V3Lifecycle04ChildSpawned` | anchored | V3ManagedLifecycle::start<br/><small>routecodex-v3-lifecycle/src/lib.rs</small> | Command::spawn<br/><small>routecodex-v3-lifecycle/src/lib.rs</small> | `v3.managed_server_lifecycle` |
| `v3-life-04` | `V3Lifecycle04ChildSpawned` → `V3Lifecycle05IdentityPublished` | anchored | V3ManagedLifecycle::run_managed_child<br/><small>routecodex-v3-lifecycle/src/lib.rs</small> | write_json_atomic<br/><small>routecodex-v3-lifecycle/src/fs_locks.rs</small> | `v3.managed_server_lifecycle` |
| `v3-life-05` | `V3Lifecycle05IdentityPublished` → `V3Lifecycle06LiveControlled` | anchored | V3ManagedLifecycle::status<br/><small>routecodex-v3-lifecycle/src/lib.rs</small> | send_control<br/><small>routecodex-v3-lifecycle/src/control_plane.rs</small> | `v3.managed_server_lifecycle` |
| `v3-life-05r` | `V3Lifecycle06LiveControlled` → `V3Lifecycle05IdentityPublished` | anchored | V3ManagedLifecycle::restart<br/><small>routecodex-v3-lifecycle/src/lib.rs</small> | send_restart_control<br/><small>routecodex-v3-lifecycle/src/control_plane.rs</small> | `v3.managed_server_lifecycle` |
| `v3-life-cli-debug-01` | `V3Cli01ResolvedDebugIntent` → `V3Lifecycle06LiveControlled` | anchored | run_cli<br/><small>routecodex-v3-cli/src/main.rs</small> | V3ManagedLifecycle::with_console_enabled<br/><small>routecodex-v3-lifecycle/src/lib.rs</small> | `v3.managed_server_lifecycle` |
| `v3-life-06` | `V3Lifecycle06LiveControlled` → `V3Lifecycle07GracefullyStopped` | anchored | V3ManagedLifecycle::stop<br/><small>routecodex-v3-lifecycle/src/lib.rs</small> | V3ServerAggregateHandle::shutdown<br/><small>routecodex-v3-server/src/lib.rs</small> | `v3.managed_server_lifecycle` |

## v3.config.compile

Unique config.v3 read/parse/validate/registry/publish chain; provider secretFile authoring is expanded here into named auth handles without publishing secret values.

Owner feature: `v3.config_interpreter_contract`

```mermaid
flowchart TD
  subgraph c_10_v3_config_compile_m_v3_config["v3-config"]
    c_10_v3_config_compile_0["v3-config<br/>V3ConfigStore::read_authoring<br/><small>routecodex-v3-config/src/store.rs</small>"]
    c_10_v3_config_compile_1["v3-config<br/>parse_v3_config_02_authoring<br/><small>routecodex-v3-config/src/lib.rs</small>"]
    c_10_v3_config_compile_2["v3-config<br/>V3ConfigStore::load_snapshot<br/><small>routecodex-v3-config/src/store.rs</small>"]
    c_10_v3_config_compile_3["v3-config<br/>validate_v3_config_03_schema_from_v3_config_02<br/><small>routecodex-v3-config/src/lib.rs</small>"]
    c_10_v3_config_compile_4["v3-config<br/>build_v3_config_04_resource_registry_from_v3_config_03<br/><small>routecodex-v3-config/src/lib.rs</small>"]
    c_10_v3_config_compile_5["v3-config<br/>publish_v3_config_05_manifest_from_v3_config_04<br/><small>routecodex-v3-config/src/lib.rs</small>"]
  end
  c_10_v3_config_compile_0 -->|v3-cfg-01<br/>V3Config01FileSource → V3Config02AuthoringParsed| c_10_v3_config_compile_1
  c_10_v3_config_compile_2 -->|v3-cfg-02<br/>V3Config02AuthoringParsed → V3Config03SchemaValidated| c_10_v3_config_compile_3
  c_10_v3_config_compile_2 -->|v3-cfg-03<br/>V3Config03SchemaValidated → V3Config04ResourceRegistryBuilt| c_10_v3_config_compile_4
  c_10_v3_config_compile_2 -->|v3-cfg-04<br/>V3Config04ResourceRegistryBuilt → V3Config05ManifestPublished| c_10_v3_config_compile_5
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-cfg-01` | `V3Config01FileSource` → `V3Config02AuthoringParsed` | anchored | V3ConfigStore::read_authoring<br/><small>routecodex-v3-config/src/store.rs</small> | parse_v3_config_02_authoring<br/><small>routecodex-v3-config/src/lib.rs</small> | `v3.config_interpreter_contract` |
| `v3-cfg-02` | `V3Config02AuthoringParsed` → `V3Config03SchemaValidated` | anchored | V3ConfigStore::load_snapshot<br/><small>routecodex-v3-config/src/store.rs</small> | validate_v3_config_03_schema_from_v3_config_02<br/><small>routecodex-v3-config/src/lib.rs</small> | `v3.config_interpreter_contract` |
| `v3-cfg-03` | `V3Config03SchemaValidated` → `V3Config04ResourceRegistryBuilt` | anchored | V3ConfigStore::load_snapshot<br/><small>routecodex-v3-config/src/store.rs</small> | build_v3_config_04_resource_registry_from_v3_config_03<br/><small>routecodex-v3-config/src/lib.rs</small> | `v3.config_interpreter_contract` |
| `v3-cfg-04` | `V3Config04ResourceRegistryBuilt` → `V3Config05ManifestPublished` | anchored | V3ConfigStore::load_snapshot<br/><small>routecodex-v3-config/src/store.rs</small> | publish_v3_config_05_manifest_from_v3_config_04<br/><small>routecodex-v3-config/src/lib.rs</small> | `v3.config_interpreter_contract` |

## v3.config.server_manifest_compile.mainline

Config compiles each server authoring entry into the server manifest consumed by publication and startup.

Owner feature: `v3.config_interpreter_contract`

```mermaid
flowchart TD
  subgraph c_11_v3_config_server_manifest_compile_mainline_m_v3_config["v3-config"]
    c_11_v3_config_server_manifest_compile_mainline_0["v3-config<br/>compile_servers<br/><small>routecodex-v3-config/src/validate.rs</small>"]
    c_11_v3_config_server_manifest_compile_mainline_1["v3-config<br/>V3ServerManifest<br/><small>routecodex-v3-config/src/types.rs</small>"]
  end
  c_11_v3_config_server_manifest_compile_mainline_0 -->|v3-config-server-manifest-01<br/>V3ServerAuthoringConfig → V3ServerManifest| c_11_v3_config_server_manifest_compile_mainline_1
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-config-server-manifest-01` | `V3ServerAuthoringConfig` → `V3ServerManifest` | anchored | compile_servers<br/><small>routecodex-v3-config/src/validate.rs</small> | V3ServerManifest<br/><small>routecodex-v3-config/src/types.rs</small> | `v3.config_interpreter_contract` |

## v3.config.provider_sse_timeout_projection.mainline

Config compiles and publishes the validated per-provider SSE first-frame timeout consumed by the shared Relay guard.

Owner feature: `v3.config_interpreter_contract`

```mermaid
flowchart TD
  subgraph c_12_v3_config_provider_sse_timeout_projection_mainline_m_v3_config["v3-config"]
    c_12_v3_config_provider_sse_timeout_projection_mainline_0["v3-config<br/>compile_providers<br/><small>routecodex-v3-config/src/validate.rs</small>"]
    c_12_v3_config_provider_sse_timeout_projection_mainline_1["v3-config<br/>V3ProviderManifest<br/><small>routecodex-v3-config/src/types.rs</small>"]
  end
  subgraph c_12_v3_config_provider_sse_timeout_projection_mainline_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_12_v3_config_provider_sse_timeout_projection_mainline_2["v3-runtime::hub_v1<br/>execute_v3_relay_runtime_core<br/><small>routecodex-v3-runtime/src/hub_v1/relay_runtime_core.rs</small>"]
    c_12_v3_config_provider_sse_timeout_projection_mainline_3["v3-runtime::hub_v1<br/>guard_relay_sse_first_frame<br/><small>routecodex-v3-runtime/src/hub_v1/relay_runtime_core.rs</small>"]
  end
  c_12_v3_config_provider_sse_timeout_projection_mainline_0 -->|v3-config-provider-sse-timeout-01<br/>V3ProviderAuthoringConfig → V3ProviderManifest| c_12_v3_config_provider_sse_timeout_projection_mainline_1
  c_12_v3_config_provider_sse_timeout_projection_mainline_2 -->|v3-config-provider-sse-timeout-02<br/>V3Config05ManifestPublished → V3RelaySseFirstFrameGuard| c_12_v3_config_provider_sse_timeout_projection_mainline_3
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-config-provider-sse-timeout-01` | `V3ProviderAuthoringConfig` → `V3ProviderManifest` | anchored | compile_providers<br/><small>routecodex-v3-config/src/validate.rs</small> | V3ProviderManifest<br/><small>routecodex-v3-config/src/types.rs</small> | `v3.config_interpreter_contract` |
| `v3-config-provider-sse-timeout-02` | `V3Config05ManifestPublished` → `V3RelaySseFirstFrameGuard` | anchored | execute_v3_relay_runtime_core<br/><small>routecodex-v3-runtime/src/hub_v1/relay_runtime_core.rs</small> | guard_relay_sse_first_frame<br/><small>routecodex-v3-runtime/src/hub_v1/relay_runtime_core.rs</small> | `v3.relay_runtime_core` |

## v3.config.compact_hub_v1_defaults

Compact user-facing Hub V1 authoring derives the closed fixed pipeline defaults inside routecodex-v3-config before Manifest publication.

Owner feature: `v3.config_interpreter_contract`

```mermaid
flowchart TD
  subgraph c_13_v3_config_compact_hub_v1_defaults_m_v3_config["v3-config"]
    c_13_v3_config_compact_hub_v1_defaults_0["v3-config<br/>parse_v3_config_02_authoring<br/><small>routecodex-v3-config/src/lib.rs</small>"]
    c_13_v3_config_compact_hub_v1_defaults_1["v3-config<br/>V3HubV1AuthoringConfig<br/><small>routecodex-v3-config/src/types.rs</small>"]
    c_13_v3_config_compact_hub_v1_defaults_2["v3-config<br/>validate_v3_config_03_schema_from_v3_config_02<br/><small>routecodex-v3-config/src/lib.rs</small>"]
    c_13_v3_config_compact_hub_v1_defaults_3["v3-config<br/>default_hub_v1_authoring<br/><small>routecodex-v3-config/src/defaults.rs</small>"]
    c_13_v3_config_compact_hub_v1_defaults_4["v3-config<br/>default_server_execution<br/><small>routecodex-v3-config/src/defaults.rs</small>"]
    c_13_v3_config_compact_hub_v1_defaults_5["v3-config<br/>compact_native_hub_v1_authoring_derives_closed_internal_defaults<br/><small>routecodex-v3-config/tests/config_v3_contract.rs</small>"]
    c_13_v3_config_compact_hub_v1_defaults_6["v3-config<br/>compile_v3_config_05_manifest<br/><small>routecodex-v3-config/src/lib.rs</small>"]
  end
  c_13_v3_config_compact_hub_v1_defaults_0 -->|v3-cfg-compact-01<br/>V3Config02AuthoringParsed → V3HubV1CompactAuthoringAccepted| c_13_v3_config_compact_hub_v1_defaults_1
  c_13_v3_config_compact_hub_v1_defaults_2 -->|v3-cfg-compact-02<br/>V3HubV1CompactAuthoringAccepted → V3Config03SchemaValidated| c_13_v3_config_compact_hub_v1_defaults_3
  c_13_v3_config_compact_hub_v1_defaults_2 -->|v3-cfg-compact-03<br/>V3HubV1CompactAuthoringAccepted → V3Config03SchemaValidated| c_13_v3_config_compact_hub_v1_defaults_4
  c_13_v3_config_compact_hub_v1_defaults_5 -->|v3-cfg-compact-04<br/>V3Config03SchemaValidated → V3Config05ManifestPublished| c_13_v3_config_compact_hub_v1_defaults_6
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-cfg-compact-01` | `V3Config02AuthoringParsed` → `V3HubV1CompactAuthoringAccepted` | anchored | parse_v3_config_02_authoring<br/><small>routecodex-v3-config/src/lib.rs</small> | V3HubV1AuthoringConfig<br/><small>routecodex-v3-config/src/types.rs</small> | `v3.config_interpreter_contract` |
| `v3-cfg-compact-02` | `V3HubV1CompactAuthoringAccepted` → `V3Config03SchemaValidated` | anchored | validate_v3_config_03_schema_from_v3_config_02<br/><small>routecodex-v3-config/src/lib.rs</small> | default_hub_v1_authoring<br/><small>routecodex-v3-config/src/defaults.rs</small> | `v3.config_interpreter_contract` |
| `v3-cfg-compact-03` | `V3HubV1CompactAuthoringAccepted` → `V3Config03SchemaValidated` | anchored | validate_v3_config_03_schema_from_v3_config_02<br/><small>routecodex-v3-config/src/lib.rs</small> | default_server_execution<br/><small>routecodex-v3-config/src/defaults.rs</small> | `v3.config_interpreter_contract` |
| `v3-cfg-compact-04` | `V3Config03SchemaValidated` → `V3Config05ManifestPublished` | anchored | compact_native_hub_v1_authoring_derives_closed_internal_defaults<br/><small>routecodex-v3-config/tests/config_v3_contract.rs</small> | compile_v3_config_05_manifest<br/><small>routecodex-v3-config/src/lib.rs</small> | `v3.config_interpreter_contract` |

## v3.models.capability_catalog

Config expands the current listener route-group model refs; Server projects those refs plus stable built-in Codex ModelInfo metadata through the read-only /v1/models endpoint.

Owner feature: `v3.models_capability_catalog`

```mermaid
flowchart TD
  subgraph c_14_v3_models_capability_catalog_m_v3_config["v3-config"]
    c_14_v3_models_capability_catalog_1["v3-config<br/>collect_v3_route_group_catalog_model_refs<br/><small>routecodex-v3-config/src/lib.rs</small>"]
  end
  subgraph c_14_v3_models_capability_catalog_m_v3_server["v3-server"]
    c_14_v3_models_capability_catalog_0["v3-server<br/>build_v3_models_catalog<br/><small>routecodex-v3-server/src/models_catalog.rs</small>"]
    c_14_v3_models_capability_catalog_2["v3-server<br/>models_endpoint<br/><small>routecodex-v3-server/src/lib.rs</small>"]
    c_14_v3_models_capability_catalog_3["v3-server<br/>json_response<br/><small>routecodex-v3-server/src/frame_builders.rs</small>"]
  end
  c_14_v3_models_capability_catalog_0 -->|v3-models-01<br/>V3Config05ManifestPublished → V3Models01RouteGroupScopedRefs| c_14_v3_models_capability_catalog_1
  c_14_v3_models_capability_catalog_2 -->|v3-models-02<br/>V3Models01RouteGroupScopedRefs → V3Models02CodexCapabilityProjected| c_14_v3_models_capability_catalog_0
  c_14_v3_models_capability_catalog_2 -->|v3-models-03<br/>V3Models02CodexCapabilityProjected → V3Models03HttpResponse| c_14_v3_models_capability_catalog_3
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-models-01` | `V3Config05ManifestPublished` → `V3Models01RouteGroupScopedRefs` | anchored | build_v3_models_catalog<br/><small>routecodex-v3-server/src/models_catalog.rs</small> | collect_v3_route_group_catalog_model_refs<br/><small>routecodex-v3-config/src/lib.rs</small> | `v3.models_capability_catalog` |
| `v3-models-02` | `V3Models01RouteGroupScopedRefs` → `V3Models02CodexCapabilityProjected` | anchored | models_endpoint<br/><small>routecodex-v3-server/src/lib.rs</small> | build_v3_models_catalog<br/><small>routecodex-v3-server/src/models_catalog.rs</small> | `v3.models_capability_catalog` |
| `v3-models-03` | `V3Models02CodexCapabilityProjected` → `V3Models03HttpResponse` | anchored | models_endpoint<br/><small>routecodex-v3-server/src/lib.rs</small> | json_response<br/><small>routecodex-v3-server/src/frame_builders.rs</small> | `v3.models_capability_catalog` |

## v3.entry_protocol_endpoint_binding.mainline

Review/gate chain binding V3 business endpoint exposure to closed entry protocols, execution mode, implementation status, and owner before Server dispatch.

Owner feature: `v3.entry_protocol_endpoint_binding`
Manifest: `docs/architecture/manifests/v3.entry_protocol_endpoint_binding.mainline.yml`

```mermaid
flowchart TD
  subgraph c_15_v3_entry_protocol_endpoint_binding_mainline_m_docs__manifest["docs::manifest"]
    c_15_v3_entry_protocol_endpoint_binding_mainline_1["docs::manifest<br/>v3.entry_protocol_endpoint_binding.mainline<br/><small>docs/architecture/manifests/v3.entry_protocol_endpoint_binding.mainline.yml</small>"]
  end
  subgraph c_15_v3_entry_protocol_endpoint_binding_mainline_m_v3_config["v3-config"]
    c_15_v3_entry_protocol_endpoint_binding_mainline_0["v3-config<br/>compile_entry_protocol_bindings<br/><small>routecodex-v3-config/src/validate.rs</small>"]
    c_15_v3_entry_protocol_endpoint_binding_mainline_2["v3-config<br/>V3HubV1Manifest::entry_protocol_binding_for_endpoint<br/><small>routecodex-v3-config/src/types.rs</small>"]
    c_15_v3_entry_protocol_endpoint_binding_mainline_3["v3-config<br/>V3EntryProtocolBindingManifest<br/><small>routecodex-v3-config/src/types.rs</small>"]
  end
  subgraph c_15_v3_entry_protocol_endpoint_binding_mainline_m_v3_server["v3-server"]
    c_15_v3_entry_protocol_endpoint_binding_mainline_4["v3-server<br/>pending_endpoint<br/><small>routecodex-v3-server/src/lib.rs</small>"]
    c_15_v3_entry_protocol_endpoint_binding_mainline_5["v3-server<br/>pending_endpoint<br/><small>routecodex-v3-server/src/endpoint_handlers.rs</small>"]
    c_15_v3_entry_protocol_endpoint_binding_mainline_6["v3-server<br/>execute_v3_gemini_generate_content_request<br/><small>routecodex-v3-server/src/executors.rs</small>"]
  end
  c_15_v3_entry_protocol_endpoint_binding_mainline_0 -->|v3-entry-bind-01<br/>V3Config05ManifestPublished → V3EntryBind01EndpointPatternDeclared| c_15_v3_entry_protocol_endpoint_binding_mainline_1
  c_15_v3_entry_protocol_endpoint_binding_mainline_2 -->|v3-entry-bind-02<br/>V3EntryBind01EndpointPatternDeclared → V3EntryBind02ProtocolResolved| c_15_v3_entry_protocol_endpoint_binding_mainline_3
  c_15_v3_entry_protocol_endpoint_binding_mainline_4 -->|v3-entry-bind-03<br/>V3EntryBind02ProtocolResolved → V3EntryBind03ServerEnablementChecked| c_15_v3_entry_protocol_endpoint_binding_mainline_2
  c_15_v3_entry_protocol_endpoint_binding_mainline_5 -->|v3-entry-bind-04<br/>V3EntryBind03ServerEnablementChecked → V3EntryBind04ExecutionBindingProjected| c_15_v3_entry_protocol_endpoint_binding_mainline_6
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-entry-bind-01` | `V3Config05ManifestPublished` → `V3EntryBind01EndpointPatternDeclared` | anchored | compile_entry_protocol_bindings<br/><small>routecodex-v3-config/src/validate.rs</small> | v3.entry_protocol_endpoint_binding.mainline<br/><small>docs/architecture/manifests/v3.entry_protocol_endpoint_binding.mainline.yml</small> | `v3.entry_protocol_endpoint_binding` |
| `v3-entry-bind-02` | `V3EntryBind01EndpointPatternDeclared` → `V3EntryBind02ProtocolResolved` | anchored | V3HubV1Manifest::entry_protocol_binding_for_endpoint<br/><small>routecodex-v3-config/src/types.rs</small> | V3EntryProtocolBindingManifest<br/><small>routecodex-v3-config/src/types.rs</small> | `v3.entry_protocol_endpoint_binding` |
| `v3-entry-bind-03` | `V3EntryBind02ProtocolResolved` → `V3EntryBind03ServerEnablementChecked` | anchored | pending_endpoint<br/><small>routecodex-v3-server/src/lib.rs</small> | V3HubV1Manifest::entry_protocol_binding_for_endpoint<br/><small>routecodex-v3-config/src/types.rs</small> | `v3.entry_protocol_endpoint_binding` |
| `v3-entry-bind-04` | `V3EntryBind03ServerEnablementChecked` → `V3EntryBind04ExecutionBindingProjected` | anchored | pending_endpoint<br/><small>routecodex-v3-server/src/endpoint_handlers.rs</small> | execute_v3_gemini_generate_content_request<br/><small>routecodex-v3-server/src/executors.rs</small> | `v3.entry_protocol_endpoint_binding` |

## v3.hub_pipeline.v1.hook_registry_compile

Runtime borrows deterministic resource/hook declarations only from V3Config05ManifestPublished and binds every fixed node entry/exit slot to the closed Rust static catalog.

Owner feature: `v3.hub_relay_runtime_resources_hooks`

```mermaid
flowchart TD
  subgraph c_16_v3_hub_pipeline_v1_hook_registry_compile_m_v3_runtime["v3-runtime"]
    c_16_v3_hub_pipeline_v1_hook_registry_compile_0["v3-runtime<br/>runtime_consumes_published_manifest_resources_and_typed_optional_noop<br/><small>routecodex-v3-runtime/tests/hub_v1_h1_contract.rs</small>"]
  end
  subgraph c_16_v3_hub_pipeline_v1_hook_registry_compile_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_16_v3_hub_pipeline_v1_hook_registry_compile_1["v3-runtime::hub_v1<br/>compile_v3_hub_v1_static_registry_from_config<br/><small>routecodex-v3-runtime/src/hub_v1/resource_hooks.rs</small>"]
  end
  c_16_v3_hub_pipeline_v1_hook_registry_compile_0 -->|v3-hub-hook-compile-01<br/>V3Config05ManifestPublished → V3HubStaticHookRegistry| c_16_v3_hub_pipeline_v1_hook_registry_compile_1
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-hub-hook-compile-01` | `V3Config05ManifestPublished` → `V3HubStaticHookRegistry` | anchored | runtime_consumes_published_manifest_resources_and_typed_optional_noop<br/><small>routecodex-v3-runtime/tests/hub_v1_h1_contract.rs</small> | compile_v3_hub_v1_static_registry_from_config<br/><small>routecodex-v3-runtime/src/hub_v1/resource_hooks.rs</small> | `v3.hub_relay_runtime_resources_hooks` |

## v3.responses_direct.required_mainline

Required no-shortcut lifecycle. P6 is source-bound from Server03 through Server16; protocol execution planning decides initial Direct-or-Relay from the selected Target10, and provider-failure reselection may recompute that decision for the newly selected Target10 without re-entering the Router.

Owner feature: `v3.responses_direct_mvp_architecture`

```mermaid
flowchart TD
  subgraph c_17_v3_responses_direct_required_mainline_m_v3_provider_responses["v3-provider-responses"]
    c_17_v3_responses_direct_required_mainline_15["v3-provider-responses<br/>build_v3_provider_12_responses_wire_payload<br/><small>routecodex-v3-provider-responses/src/wire.rs</small>"]
    c_17_v3_responses_direct_required_mainline_17["v3-provider-responses<br/>build_v3_transport_13_responses_http_request_from_v3_provider_12<br/><small>routecodex-v3-provider-responses/src/transport.rs</small>"]
    c_17_v3_responses_direct_required_mainline_18["v3-provider-responses<br/>ReqwestResponsesTransport::send<br/><small>routecodex-v3-provider-responses/src/transport.rs</small>"]
    c_17_v3_responses_direct_required_mainline_19["v3-provider-responses<br/>V3ProviderResp14Raw::from_json<br/><small>routecodex-v3-provider-responses/src/raw_response.rs</small>"]
  end
  subgraph c_17_v3_responses_direct_required_mainline_m_v3_runtime["v3-runtime"]
    c_17_v3_responses_direct_required_mainline_1["v3-runtime<br/>build_v3_server_03_http_request_raw<br/><small>routecodex-v3-runtime/src/nodes.rs</small>"]
    c_17_v3_responses_direct_required_mainline_2["v3-runtime<br/>execute_v3_p5_routing_runtime<br/><small>routecodex-v3-runtime/src/foundation.rs</small>"]
    c_17_v3_responses_direct_required_mainline_3["v3-runtime<br/>build_v3_req_04_standardized_responses_from_v3_server_03<br/><small>routecodex-v3-runtime/src/nodes.rs</small>"]
    c_17_v3_responses_direct_required_mainline_10["v3-runtime<br/>plan_v3_responses_protocol_execution_with_provider_health<br/><small>routecodex-v3-runtime/src/kernel/direct_protocol_plan.rs</small>"]
    c_17_v3_responses_direct_required_mainline_11["v3-runtime<br/>build_v3_execution_11_protocol_decision_from_v3_target_10<br/><small>routecodex-v3-runtime/src/nodes.rs</small>"]
    c_17_v3_responses_direct_required_mainline_12["v3-runtime<br/>execute_v3_responses_direct_runtime_kernel<br/><small>routecodex-v3-runtime/src/kernel.rs</small>"]
    c_17_v3_responses_direct_required_mainline_13["v3-runtime<br/>responses_direct_route_hook<br/><small>routecodex-v3-runtime/src/hooks.rs</small>"]
    c_17_v3_responses_direct_required_mainline_14["v3-runtime<br/>responses_direct_request_projection_hook<br/><small>routecodex-v3-runtime/src/hooks.rs</small>"]
    c_17_v3_responses_direct_required_mainline_16["v3-runtime<br/>responses_direct_provider_transport_hook<br/><small>routecodex-v3-runtime/src/hooks.rs</small>"]
    c_17_v3_responses_direct_required_mainline_20["v3-runtime<br/>execute_v3_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel/v3_direct_core.rs</small>"]
    c_17_v3_responses_direct_required_mainline_21["v3-runtime<br/>responses_direct_response_projection_hook_with_context<br/><small>routecodex-v3-runtime/src/hooks.rs</small>"]
    c_17_v3_responses_direct_required_mainline_22["v3-runtime<br/>V3ResponsesDirectRuntimeOutput<br/><small>routecodex-v3-runtime/src/kernel.rs</small>"]
  end
  subgraph c_17_v3_responses_direct_required_mainline_m_v3_server["v3-server"]
    c_17_v3_responses_direct_required_mainline_0["v3-server<br/>pending_endpoint<br/><small>routecodex-v3-server/src/endpoint_handlers.rs</small>"]
    c_17_v3_responses_direct_required_mainline_23["v3-server<br/>build_v3_server_16_http_frame_from_v3_resp_15<br/><small>routecodex-v3-server/src/frame_builders.rs</small>"]
  end
  subgraph c_17_v3_responses_direct_required_mainline_m_v3_target["v3-target"]
    c_17_v3_responses_direct_required_mainline_7["v3-target<br/>V3TargetInterpreter::classify_kind<br/><small>routecodex-v3-target/src/lib.rs</small>"]
    c_17_v3_responses_direct_required_mainline_8["v3-target<br/>V3TargetInterpreter::expand_candidates<br/><small>routecodex-v3-target/src/lib.rs</small>"]
    c_17_v3_responses_direct_required_mainline_9["v3-target<br/>V3TargetInterpreter::select_available<br/><small>routecodex-v3-target/src/lib.rs</small>"]
  end
  subgraph c_17_v3_responses_direct_required_mainline_m_v3_virtual_router["v3-virtual-router"]
    c_17_v3_responses_direct_required_mainline_4["v3-virtual-router<br/>V3VirtualRouter::classify_request_with_facts<br/><small>routecodex-v3-virtual-router/src/lib.rs</small>"]
    c_17_v3_responses_direct_required_mainline_5["v3-virtual-router<br/>V3VirtualRouter::resolve_route_pool_plan<br/><small>routecodex-v3-virtual-router/src/lib.rs</small>"]
    c_17_v3_responses_direct_required_mainline_6["v3-virtual-router<br/>V3VirtualRouter::hit_opaque_target_plan_once<br/><small>routecodex-v3-virtual-router/src/lib.rs</small>"]
  end
  c_17_v3_responses_direct_required_mainline_0 -->|v3-rd-01<br/>V3Config05ManifestPublished → V3Server03HttpRequestRaw| c_17_v3_responses_direct_required_mainline_1
  c_17_v3_responses_direct_required_mainline_2 -->|v3-rd-02<br/>V3Server03HttpRequestRaw → V3Req04StandardizedResponses| c_17_v3_responses_direct_required_mainline_3
  c_17_v3_responses_direct_required_mainline_2 -->|v3-rd-03<br/>V3Req04StandardizedResponses → V3Router05RequestClassified| c_17_v3_responses_direct_required_mainline_4
  c_17_v3_responses_direct_required_mainline_2 -->|v3-rd-04<br/>V3Router05RequestClassified → V3Router06RoutePoolResolved| c_17_v3_responses_direct_required_mainline_5
  c_17_v3_responses_direct_required_mainline_2 -->|v3-rd-05<br/>V3Router06RoutePoolResolved → V3Router07OpaqueTargetHitOnce| c_17_v3_responses_direct_required_mainline_6
  c_17_v3_responses_direct_required_mainline_2 -->|v3-rd-06<br/>V3Router07OpaqueTargetHitOnce → V3Target08KindClassified| c_17_v3_responses_direct_required_mainline_7
  c_17_v3_responses_direct_required_mainline_2 -->|v3-rd-07<br/>V3Target08KindClassified → V3Target09CandidateSetExpanded| c_17_v3_responses_direct_required_mainline_8
  c_17_v3_responses_direct_required_mainline_2 -->|v3-rd-08<br/>V3Target09CandidateSetExpanded → V3Target10ConcreteProviderSelected| c_17_v3_responses_direct_required_mainline_9
  c_17_v3_responses_direct_required_mainline_10 -->|v3-rd-09<br/>V3Target10ConcreteProviderSelected → V3Execution11ProtocolDecision| c_17_v3_responses_direct_required_mainline_11
  c_17_v3_responses_direct_required_mainline_12 -->|v3-rd-09-direct-policy<br/>V3Execution11ProtocolDecision → V3ResponsesDirect11Policy| c_17_v3_responses_direct_required_mainline_13
  c_17_v3_responses_direct_required_mainline_14 -->|v3-rd-10<br/>V3ResponsesDirect11Policy → V3Provider12ResponsesWirePayload| c_17_v3_responses_direct_required_mainline_15
  c_17_v3_responses_direct_required_mainline_16 -->|v3-rd-11<br/>V3Provider12ResponsesWirePayload → V3Transport13ResponsesHttpRequest| c_17_v3_responses_direct_required_mainline_17
  c_17_v3_responses_direct_required_mainline_18 -->|v3-rd-12<br/>V3Transport13ResponsesHttpRequest → V3ProviderResp14Raw| c_17_v3_responses_direct_required_mainline_19
  c_17_v3_responses_direct_required_mainline_20 -->|v3-rd-13<br/>V3ProviderResp14Raw → V3DirectResp14ProviderProjectionPrepared| c_17_v3_responses_direct_required_mainline_21
  c_17_v3_responses_direct_required_mainline_12 -->|v3-rd-14<br/>V3DirectResp14ProviderProjectionPrepared → V3DirectResp15ClientPayloadReady| c_17_v3_responses_direct_required_mainline_22
  c_17_v3_responses_direct_required_mainline_12 -->|v3-rd-15<br/>V3DirectResp15ClientPayloadReady → V3Resp15ClientPayload| c_17_v3_responses_direct_required_mainline_22
  c_17_v3_responses_direct_required_mainline_0 -->|v3-rd-16<br/>V3Resp15ClientPayload → V3Server16HttpFrame| c_17_v3_responses_direct_required_mainline_23
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-rd-01` | `V3Config05ManifestPublished` → `V3Server03HttpRequestRaw` | anchored | pending_endpoint<br/><small>routecodex-v3-server/src/endpoint_handlers.rs</small> | build_v3_server_03_http_request_raw<br/><small>routecodex-v3-runtime/src/nodes.rs</small> | `v3.virtual_router_target_interpreter` |
| `v3-rd-02` | `V3Server03HttpRequestRaw` → `V3Req04StandardizedResponses` | anchored | execute_v3_p5_routing_runtime<br/><small>routecodex-v3-runtime/src/foundation.rs</small> | build_v3_req_04_standardized_responses_from_v3_server_03<br/><small>routecodex-v3-runtime/src/nodes.rs</small> | `v3.virtual_router_target_interpreter` |
| `v3-rd-03` | `V3Req04StandardizedResponses` → `V3Router05RequestClassified` | anchored | execute_v3_p5_routing_runtime<br/><small>routecodex-v3-runtime/src/foundation.rs</small> | V3VirtualRouter::classify_request_with_facts<br/><small>routecodex-v3-virtual-router/src/lib.rs</small> | `v3.virtual_router_full_function` |
| `v3-rd-04` | `V3Router05RequestClassified` → `V3Router06RoutePoolResolved` | anchored | execute_v3_p5_routing_runtime<br/><small>routecodex-v3-runtime/src/foundation.rs</small> | V3VirtualRouter::resolve_route_pool_plan<br/><small>routecodex-v3-virtual-router/src/lib.rs</small> | `v3.virtual_router_full_function` |
| `v3-rd-05` | `V3Router06RoutePoolResolved` → `V3Router07OpaqueTargetHitOnce` | anchored | execute_v3_p5_routing_runtime<br/><small>routecodex-v3-runtime/src/foundation.rs</small> | V3VirtualRouter::hit_opaque_target_plan_once<br/><small>routecodex-v3-virtual-router/src/lib.rs</small> | `v3.virtual_router_full_function` |
| `v3-rd-06` | `V3Router07OpaqueTargetHitOnce` → `V3Target08KindClassified` | anchored | execute_v3_p5_routing_runtime<br/><small>routecodex-v3-runtime/src/foundation.rs</small> | V3TargetInterpreter::classify_kind<br/><small>routecodex-v3-target/src/lib.rs</small> | `v3.virtual_router_target_interpreter` |
| `v3-rd-07` | `V3Target08KindClassified` → `V3Target09CandidateSetExpanded` | anchored | execute_v3_p5_routing_runtime<br/><small>routecodex-v3-runtime/src/foundation.rs</small> | V3TargetInterpreter::expand_candidates<br/><small>routecodex-v3-target/src/lib.rs</small> | `v3.virtual_router_target_interpreter` |
| `v3-rd-08` | `V3Target09CandidateSetExpanded` → `V3Target10ConcreteProviderSelected` | anchored | execute_v3_p5_routing_runtime<br/><small>routecodex-v3-runtime/src/foundation.rs</small> | V3TargetInterpreter::select_available<br/><small>routecodex-v3-target/src/lib.rs</small> | `v3.virtual_router_target_interpreter` |
| `v3-rd-09` | `V3Target10ConcreteProviderSelected` → `V3Execution11ProtocolDecision` | anchored | plan_v3_responses_protocol_execution_with_provider_health<br/><small>routecodex-v3-runtime/src/kernel/direct_protocol_plan.rs</small> | build_v3_execution_11_protocol_decision_from_v3_target_10<br/><small>routecodex-v3-runtime/src/nodes.rs</small> | `v3.responses_direct_mvp_architecture` |
| `v3-rd-09-direct-policy` | `V3Execution11ProtocolDecision` → `V3ResponsesDirect11Policy` | anchored | execute_v3_responses_direct_runtime_kernel<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | responses_direct_route_hook<br/><small>routecodex-v3-runtime/src/hooks.rs</small> | `v3.responses_direct_mvp_architecture` |
| `v3-rd-10` | `V3ResponsesDirect11Policy` → `V3Provider12ResponsesWirePayload` | anchored | responses_direct_request_projection_hook<br/><small>routecodex-v3-runtime/src/hooks.rs</small> | build_v3_provider_12_responses_wire_payload<br/><small>routecodex-v3-provider-responses/src/wire.rs</small> | `v3.responses_provider_runtime` |
| `v3-rd-11` | `V3Provider12ResponsesWirePayload` → `V3Transport13ResponsesHttpRequest` | anchored | responses_direct_provider_transport_hook<br/><small>routecodex-v3-runtime/src/hooks.rs</small> | build_v3_transport_13_responses_http_request_from_v3_provider_12<br/><small>routecodex-v3-provider-responses/src/transport.rs</small> | `v3.responses_provider_runtime` |
| `v3-rd-12` | `V3Transport13ResponsesHttpRequest` → `V3ProviderResp14Raw` | anchored | ReqwestResponsesTransport::send<br/><small>routecodex-v3-provider-responses/src/transport.rs</small> | V3ProviderResp14Raw::from_json<br/><small>routecodex-v3-provider-responses/src/raw_response.rs</small> | `v3.responses_provider_runtime` |
| `v3-rd-13` | `V3ProviderResp14Raw` → `V3DirectResp14ProviderProjectionPrepared` | anchored | execute_v3_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel/v3_direct_core.rs</small> | responses_direct_response_projection_hook_with_context<br/><small>routecodex-v3-runtime/src/hooks.rs</small> | `v3.responses_direct_mvp_architecture` |
| `v3-rd-14` | `V3DirectResp14ProviderProjectionPrepared` → `V3DirectResp15ClientPayloadReady` | anchored | execute_v3_responses_direct_runtime_kernel<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | V3ResponsesDirectRuntimeOutput<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | `v3.responses_direct_mvp_architecture` |
| `v3-rd-15` | `V3DirectResp15ClientPayloadReady` → `V3Resp15ClientPayload` | anchored | execute_v3_responses_direct_runtime_kernel<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | V3ResponsesDirectRuntimeOutput<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | `v3.responses_direct_mvp_architecture` |
| `v3-rd-16` | `V3Resp15ClientPayload` → `V3Server16HttpFrame` | anchored | pending_endpoint<br/><small>routecodex-v3-server/src/endpoint_handlers.rs</small> | build_v3_server_16_http_frame_from_v3_resp_15<br/><small>routecodex-v3-server/src/frame_builders.rs</small> | `v3.responses_direct_mvp_architecture` |

## v3.hub_pipeline.v1.request

Fixed Hub v1 request topology. All Direct/Relay/continuation/target/provider-protocol branches traverse every adjacent node and are supplied by static Rust hooks.

Owner feature: `v3.hub_pipeline_static_skeleton`
Manifest: `docs/architecture/manifests/v3.hub_pipeline.v1.request.mainline.yml`

```mermaid
flowchart TD
  subgraph c_18_v3_hub_pipeline_v1_request_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_18_v3_hub_pipeline_v1_request_0["v3-runtime::hub_v1<br/>all_adjacent_builders_form_the_fixed_typed_topology<br/><small>routecodex-v3-runtime/src/hub_v1/tests.rs</small>"]
    c_18_v3_hub_pipeline_v1_request_1["v3-runtime::hub_v1<br/>build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01<br/><small>routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs</small>"]
    c_18_v3_hub_pipeline_v1_request_2["v3-runtime::hub_v1<br/>build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02<br/><small>routecodex-v3-runtime/src/hub_v1/req_continuation_03_classified.rs</small>"]
    c_18_v3_hub_pipeline_v1_request_3["v3-runtime::hub_v1<br/>build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03<br/><small>routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs</small>"]
    c_18_v3_hub_pipeline_v1_request_4["v3-runtime::hub_v1<br/>build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04<br/><small>routecodex-v3-runtime/src/hub_v1/req_execution_05_planned.rs</small>"]
    c_18_v3_hub_pipeline_v1_request_5["v3-runtime::hub_v1<br/>build_v3_hub_req_target_06_from_v3_hub_req_execution_05<br/><small>routecodex-v3-runtime/src/hub_v1/req_target_06_resolved.rs</small>"]
    c_18_v3_hub_pipeline_v1_request_6["v3-runtime::hub_v1<br/>build_v3_hub_req_outbound_07_from_v3_hub_req_target_06<br/><small>routecodex-v3-runtime/src/hub_v1/req_outbound_07_provider_semantic.rs</small>"]
    c_18_v3_hub_pipeline_v1_request_7["v3-runtime::hub_v1<br/>build_provider_req_compat_06_from_v3_hub_req_outbound_07<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs</small>"]
    c_18_v3_hub_pipeline_v1_request_8["v3-runtime::hub_v1<br/>build_v3_provider_req_outbound_08_from_provider_req_compat_06<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_outbound_08_wire_payload.rs</small>"]
    c_18_v3_hub_pipeline_v1_request_9["v3-runtime::hub_v1<br/>build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_outbound_09_transport_request.rs</small>"]
  end
  c_18_v3_hub_pipeline_v1_request_0 -->|v3-hub-req-01<br/>V3HubReqInbound01ClientRaw → V3HubReqInbound02Normalized| c_18_v3_hub_pipeline_v1_request_1
  c_18_v3_hub_pipeline_v1_request_0 -->|v3-hub-req-02<br/>V3HubReqInbound02Normalized → V3HubReqContinuation03Classified| c_18_v3_hub_pipeline_v1_request_2
  c_18_v3_hub_pipeline_v1_request_0 -->|v3-hub-req-03<br/>V3HubReqContinuation03Classified → V3HubReqChatProcess04Governed| c_18_v3_hub_pipeline_v1_request_3
  c_18_v3_hub_pipeline_v1_request_0 -->|v3-hub-req-04<br/>V3HubReqChatProcess04Governed → V3HubReqExecution05Planned| c_18_v3_hub_pipeline_v1_request_4
  c_18_v3_hub_pipeline_v1_request_0 -->|v3-hub-req-05<br/>V3HubReqExecution05Planned → V3HubReqTarget06Resolved| c_18_v3_hub_pipeline_v1_request_5
  c_18_v3_hub_pipeline_v1_request_0 -->|v3-hub-req-06<br/>V3HubReqTarget06Resolved → V3HubReqOutbound07ProviderSemantic| c_18_v3_hub_pipeline_v1_request_6
  c_18_v3_hub_pipeline_v1_request_0 -->|v3-hub-req-07<br/>V3HubReqOutbound07ProviderSemantic → ProviderReqCompat06ProviderCompat| c_18_v3_hub_pipeline_v1_request_7
  c_18_v3_hub_pipeline_v1_request_0 -->|v3-hub-req-08<br/>ProviderReqCompat06ProviderCompat → V3ProviderReqOutbound08WirePayload| c_18_v3_hub_pipeline_v1_request_8
  c_18_v3_hub_pipeline_v1_request_0 -->|v3-hub-req-09<br/>V3ProviderReqOutbound08WirePayload → V3ProviderReqOutbound09TransportRequest| c_18_v3_hub_pipeline_v1_request_9
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-hub-req-01` | `V3HubReqInbound01ClientRaw` → `V3HubReqInbound02Normalized` | anchored | all_adjacent_builders_form_the_fixed_typed_topology<br/><small>routecodex-v3-runtime/src/hub_v1/tests.rs</small> | build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01<br/><small>routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs</small> | `v3.hub_pipeline_static_skeleton` |
| `v3-hub-req-02` | `V3HubReqInbound02Normalized` → `V3HubReqContinuation03Classified` | anchored | all_adjacent_builders_form_the_fixed_typed_topology<br/><small>routecodex-v3-runtime/src/hub_v1/tests.rs</small> | build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02<br/><small>routecodex-v3-runtime/src/hub_v1/req_continuation_03_classified.rs</small> | `v3.hub_pipeline_static_skeleton` |
| `v3-hub-req-03` | `V3HubReqContinuation03Classified` → `V3HubReqChatProcess04Governed` | anchored | all_adjacent_builders_form_the_fixed_typed_topology<br/><small>routecodex-v3-runtime/src/hub_v1/tests.rs</small> | build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03<br/><small>routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs</small> | `v3.hub_pipeline_static_skeleton` |
| `v3-hub-req-04` | `V3HubReqChatProcess04Governed` → `V3HubReqExecution05Planned` | anchored | all_adjacent_builders_form_the_fixed_typed_topology<br/><small>routecodex-v3-runtime/src/hub_v1/tests.rs</small> | build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04<br/><small>routecodex-v3-runtime/src/hub_v1/req_execution_05_planned.rs</small> | `v3.hub_pipeline_static_skeleton` |
| `v3-hub-req-05` | `V3HubReqExecution05Planned` → `V3HubReqTarget06Resolved` | anchored | all_adjacent_builders_form_the_fixed_typed_topology<br/><small>routecodex-v3-runtime/src/hub_v1/tests.rs</small> | build_v3_hub_req_target_06_from_v3_hub_req_execution_05<br/><small>routecodex-v3-runtime/src/hub_v1/req_target_06_resolved.rs</small> | `v3.hub_pipeline_static_skeleton` |
| `v3-hub-req-06` | `V3HubReqTarget06Resolved` → `V3HubReqOutbound07ProviderSemantic` | anchored | all_adjacent_builders_form_the_fixed_typed_topology<br/><small>routecodex-v3-runtime/src/hub_v1/tests.rs</small> | build_v3_hub_req_outbound_07_from_v3_hub_req_target_06<br/><small>routecodex-v3-runtime/src/hub_v1/req_outbound_07_provider_semantic.rs</small> | `v3.hub_pipeline_static_skeleton` |
| `v3-hub-req-07` | `V3HubReqOutbound07ProviderSemantic` → `ProviderReqCompat06ProviderCompat` | anchored | all_adjacent_builders_form_the_fixed_typed_topology<br/><small>routecodex-v3-runtime/src/hub_v1/tests.rs</small> | build_provider_req_compat_06_from_v3_hub_req_outbound_07<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs</small> | `v3.hub_pipeline_static_skeleton` |
| `v3-hub-req-08` | `ProviderReqCompat06ProviderCompat` → `V3ProviderReqOutbound08WirePayload` | anchored | all_adjacent_builders_form_the_fixed_typed_topology<br/><small>routecodex-v3-runtime/src/hub_v1/tests.rs</small> | build_v3_provider_req_outbound_08_from_provider_req_compat_06<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_outbound_08_wire_payload.rs</small> | `v3.hub_pipeline_static_skeleton` |
| `v3-hub-req-09` | `V3ProviderReqOutbound08WirePayload` → `V3ProviderReqOutbound09TransportRequest` | anchored | all_adjacent_builders_form_the_fixed_typed_topology<br/><small>routecodex-v3-runtime/src/hub_v1/tests.rs</small> | build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_outbound_09_transport_request.rs</small> | `v3.hub_pipeline_static_skeleton` |

## v3.protocol_conversion_field_parity.outbound_helper_bindings

Verification bindings for OpenAI outbound helper calls inside the existing Req07 to ProviderCompat06 adjacent codec edge; this chain does not add runtime nodes.

Owner feature: `v3.protocol_conversion_field_parity`

```mermaid
flowchart TD
  subgraph c_19_v3_protocol_conversion_field_parity_outbound_helper_bindings_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_19_v3_protocol_conversion_field_parity_outbound_helper_bindings_0["v3-runtime::hub_v1<br/>apply_outbound_projection_transforms<br/><small>routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs</small>"]
    c_19_v3_protocol_conversion_field_parity_outbound_helper_bindings_1["v3-runtime::hub_v1<br/>project_openai_client_metadata_to_metadata<br/><small>routecodex-v3-runtime/src/hub_v1/request_outbound_metadata.rs</small>"]
    c_19_v3_protocol_conversion_field_parity_outbound_helper_bindings_2["v3-runtime::hub_v1<br/>validate_openai_metadata<br/><small>routecodex-v3-runtime/src/hub_v1/request_outbound_metadata.rs</small>"]
    c_19_v3_protocol_conversion_field_parity_outbound_helper_bindings_3["v3-runtime::hub_v1<br/>project_openai_chat_reasoning_summary_policy<br/><small>routecodex-v3-runtime/src/hub_v1/request_outbound_metadata.rs</small>"]
    c_19_v3_protocol_conversion_field_parity_outbound_helper_bindings_4["v3-runtime::hub_v1<br/>normalize_openai_chat_messages_payload<br/><small>routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs</small>"]
    c_19_v3_protocol_conversion_field_parity_outbound_helper_bindings_5["v3-runtime::hub_v1<br/>project_openai_chat_provider_tools<br/><small>routecodex-v3-runtime/src/hub_v1/request_outbound_builtin_tool_projection.rs</small>"]
    c_19_v3_protocol_conversion_field_parity_outbound_helper_bindings_6["v3-runtime::hub_v1<br/>execute_v3_responses_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs</small>"]
    c_19_v3_protocol_conversion_field_parity_outbound_helper_bindings_7["v3-runtime::hub_v1<br/>project_v3_anthropic_message_as_responses_response_with_context<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs</small>"]
  end
  c_19_v3_protocol_conversion_field_parity_outbound_helper_bindings_0 -->|v3-protocol-field-parity-openai-outbound-metadata-01<br/>V3HubReqOutbound07ProviderSemantic → ProviderReqCompat06ProviderCompat| c_19_v3_protocol_conversion_field_parity_outbound_helper_bindings_1
  c_19_v3_protocol_conversion_field_parity_outbound_helper_bindings_0 -->|v3-protocol-field-parity-openai-outbound-metadata-02<br/>V3HubReqOutbound07ProviderSemantic → ProviderReqCompat06ProviderCompat| c_19_v3_protocol_conversion_field_parity_outbound_helper_bindings_2
  c_19_v3_protocol_conversion_field_parity_outbound_helper_bindings_0 -->|v3-protocol-field-parity-openai-outbound-summary-01<br/>V3HubReqOutbound07ProviderSemantic → ProviderReqCompat06ProviderCompat| c_19_v3_protocol_conversion_field_parity_outbound_helper_bindings_3
  c_19_v3_protocol_conversion_field_parity_outbound_helper_bindings_4 -->|v3-protocol-field-parity-openai-outbound-web-search-01<br/>V3HubReqOutbound07ProviderSemantic → ProviderReqCompat06ProviderCompat| c_19_v3_protocol_conversion_field_parity_outbound_helper_bindings_5
  c_19_v3_protocol_conversion_field_parity_outbound_helper_bindings_6 -->|v3-protocol-field-parity-anthropic-response-context-01<br/>ProviderRespCompat02ProviderCompat → V3HubRespInbound02Normalized| c_19_v3_protocol_conversion_field_parity_outbound_helper_bindings_7
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-protocol-field-parity-openai-outbound-metadata-01` | `V3HubReqOutbound07ProviderSemantic` → `ProviderReqCompat06ProviderCompat` | anchored | apply_outbound_projection_transforms<br/><small>routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs</small> | project_openai_client_metadata_to_metadata<br/><small>routecodex-v3-runtime/src/hub_v1/request_outbound_metadata.rs</small> | `v3.protocol_conversion_field_parity` |
| `v3-protocol-field-parity-openai-outbound-metadata-02` | `V3HubReqOutbound07ProviderSemantic` → `ProviderReqCompat06ProviderCompat` | anchored | apply_outbound_projection_transforms<br/><small>routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs</small> | validate_openai_metadata<br/><small>routecodex-v3-runtime/src/hub_v1/request_outbound_metadata.rs</small> | `v3.protocol_conversion_field_parity` |
| `v3-protocol-field-parity-openai-outbound-summary-01` | `V3HubReqOutbound07ProviderSemantic` → `ProviderReqCompat06ProviderCompat` | anchored | apply_outbound_projection_transforms<br/><small>routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs</small> | project_openai_chat_reasoning_summary_policy<br/><small>routecodex-v3-runtime/src/hub_v1/request_outbound_metadata.rs</small> | `v3.protocol_conversion_field_parity` |
| `v3-protocol-field-parity-openai-outbound-web-search-01` | `V3HubReqOutbound07ProviderSemantic` → `ProviderReqCompat06ProviderCompat` | anchored | normalize_openai_chat_messages_payload<br/><small>routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs</small> | project_openai_chat_provider_tools<br/><small>routecodex-v3-runtime/src/hub_v1/request_outbound_builtin_tool_projection.rs</small> | `v3.protocol_conversion_field_parity` |
| `v3-protocol-field-parity-anthropic-response-context-01` | `ProviderRespCompat02ProviderCompat` → `V3HubRespInbound02Normalized` | anchored | execute_v3_responses_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs</small> | project_v3_anthropic_message_as_responses_response_with_context<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs</small> | `v3.protocol_conversion_field_parity` |

## v3.hub_pipeline.v1.relay_request_source_slice

Relay request-side source slice. Req02 normalizes, Req03 classifies only, and Req04 restores/governs; later fixed nodes remain the standard Hub v1 chain.

Owner feature: `v3.hub_relay_request_semantics`

```mermaid
flowchart TD
  subgraph c_20_v3_hub_pipeline_v1_relay_request_source_slice_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_20_v3_hub_pipeline_v1_relay_request_source_slice_0["v3-runtime::hub_v1<br/>V3HubRelayRequestHooks::run<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small>"]
    c_20_v3_hub_pipeline_v1_relay_request_source_slice_1["v3-runtime::hub_v1<br/>build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01<br/><small>routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs</small>"]
    c_20_v3_hub_pipeline_v1_relay_request_source_slice_2["v3-runtime::hub_v1<br/>V3HubRelayRequestHooks::run_from_normalized_with_events<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small>"]
    c_20_v3_hub_pipeline_v1_relay_request_source_slice_3["v3-runtime::hub_v1<br/>classify_continuation<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small>"]
    c_20_v3_hub_pipeline_v1_relay_request_source_slice_4["v3-runtime::hub_v1<br/>restore_local_context_at_req04<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small>"]
  end
  c_20_v3_hub_pipeline_v1_relay_request_source_slice_0 -->|v3-hub-relay-req-01<br/>V3HubReqInbound01ClientRaw → V3HubReqInbound02Normalized| c_20_v3_hub_pipeline_v1_relay_request_source_slice_1
  c_20_v3_hub_pipeline_v1_relay_request_source_slice_2 -->|v3-hub-relay-req-02<br/>V3HubReqInbound02Normalized → V3HubReqContinuation03Classified| c_20_v3_hub_pipeline_v1_relay_request_source_slice_3
  c_20_v3_hub_pipeline_v1_relay_request_source_slice_0 -->|v3-hub-relay-req-03<br/>V3HubReqContinuation03Classified → V3HubReqChatProcess04Governed| c_20_v3_hub_pipeline_v1_relay_request_source_slice_4
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-hub-relay-req-01` | `V3HubReqInbound01ClientRaw` → `V3HubReqInbound02Normalized` | anchored | V3HubRelayRequestHooks::run<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small> | build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01<br/><small>routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs</small> | `v3.hub_relay_request_semantics` |
| `v3-hub-relay-req-02` | `V3HubReqInbound02Normalized` → `V3HubReqContinuation03Classified` | anchored | V3HubRelayRequestHooks::run_from_normalized_with_events<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small> | classify_continuation<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small> | `v3.hub_relay_request_semantics` |
| `v3-hub-relay-req-03` | `V3HubReqContinuation03Classified` → `V3HubReqChatProcess04Governed` | anchored | V3HubRelayRequestHooks::run<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small> | restore_local_context_at_req04<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small> | `v3.hub_relay_request_semantics` |

## v3.hub_pipeline.v1.response

Fixed Hub v1 response topology. Direct/Relay/JSON/SSE/servertool outcomes merge before the sole client projection and Server frame exit.

Owner feature: `v3.hub_pipeline_static_skeleton`
Manifest: `docs/architecture/manifests/v3.hub_pipeline.v1.response.mainline.yml`

```mermaid
flowchart TD
  subgraph c_21_v3_hub_pipeline_v1_response_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_21_v3_hub_pipeline_v1_response_0["v3-runtime::hub_v1<br/>all_adjacent_builders_form_the_fixed_typed_topology<br/><small>routecodex-v3-runtime/src/hub_v1/tests.rs</small>"]
    c_21_v3_hub_pipeline_v1_response_1["v3-runtime::hub_v1<br/>build_provider_resp_compat_02_from_v3_provider_resp_inbound_01<br/><small>routecodex-v3-runtime/src/hub_v1/provider_resp_compat_02_provider_compat.rs</small>"]
    c_21_v3_hub_pipeline_v1_response_2["v3-runtime::hub_v1<br/>build_v3_hub_resp_inbound_02_from_provider_resp_compat_02<br/><small>routecodex-v3-runtime/src/hub_v1/resp_inbound_02_normalized.rs</small>"]
    c_21_v3_hub_pipeline_v1_response_3["v3-runtime::hub_v1<br/>build_v3_hub_resp_chat_process_03_from_v3_hub_resp_inbound_02<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
    c_21_v3_hub_pipeline_v1_response_4["v3-runtime::hub_v1<br/>build_v3_hub_resp_continuation_04_from_v3_hub_resp_chat_process_03<br/><small>routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs</small>"]
    c_21_v3_hub_pipeline_v1_response_5["v3-runtime::hub_v1<br/>build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04<br/><small>routecodex-v3-runtime/src/hub_v1/resp_outbound_05_client_semantic.rs</small>"]
    c_21_v3_hub_pipeline_v1_response_6["v3-runtime::hub_v1<br/>build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05<br/><small>routecodex-v3-runtime/src/hub_v1/server_resp_outbound_06_client_frame.rs</small>"]
  end
  c_21_v3_hub_pipeline_v1_response_0 -->|v3-hub-resp-01<br/>V3ProviderRespInbound01Raw → ProviderRespCompat02ProviderCompat| c_21_v3_hub_pipeline_v1_response_1
  c_21_v3_hub_pipeline_v1_response_0 -->|v3-hub-resp-02<br/>ProviderRespCompat02ProviderCompat → V3HubRespInbound02Normalized| c_21_v3_hub_pipeline_v1_response_2
  c_21_v3_hub_pipeline_v1_response_0 -->|v3-hub-resp-03<br/>V3HubRespInbound02Normalized → V3HubRespChatProcess03Governed| c_21_v3_hub_pipeline_v1_response_3
  c_21_v3_hub_pipeline_v1_response_0 -->|v3-hub-resp-04<br/>V3HubRespChatProcess03Governed → V3HubRespContinuation04Committed| c_21_v3_hub_pipeline_v1_response_4
  c_21_v3_hub_pipeline_v1_response_0 -->|v3-hub-resp-05<br/>V3HubRespContinuation04Committed → V3HubRespOutbound05ClientSemantic| c_21_v3_hub_pipeline_v1_response_5
  c_21_v3_hub_pipeline_v1_response_0 -->|v3-hub-resp-06<br/>V3HubRespOutbound05ClientSemantic → V3ServerRespOutbound06ClientFrame| c_21_v3_hub_pipeline_v1_response_6
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-hub-resp-01` | `V3ProviderRespInbound01Raw` → `ProviderRespCompat02ProviderCompat` | anchored | all_adjacent_builders_form_the_fixed_typed_topology<br/><small>routecodex-v3-runtime/src/hub_v1/tests.rs</small> | build_provider_resp_compat_02_from_v3_provider_resp_inbound_01<br/><small>routecodex-v3-runtime/src/hub_v1/provider_resp_compat_02_provider_compat.rs</small> | `v3.hub_pipeline_static_skeleton` |
| `v3-hub-resp-02` | `ProviderRespCompat02ProviderCompat` → `V3HubRespInbound02Normalized` | anchored | all_adjacent_builders_form_the_fixed_typed_topology<br/><small>routecodex-v3-runtime/src/hub_v1/tests.rs</small> | build_v3_hub_resp_inbound_02_from_provider_resp_compat_02<br/><small>routecodex-v3-runtime/src/hub_v1/resp_inbound_02_normalized.rs</small> | `v3.hub_pipeline_static_skeleton` |
| `v3-hub-resp-03` | `V3HubRespInbound02Normalized` → `V3HubRespChatProcess03Governed` | anchored | all_adjacent_builders_form_the_fixed_typed_topology<br/><small>routecodex-v3-runtime/src/hub_v1/tests.rs</small> | build_v3_hub_resp_chat_process_03_from_v3_hub_resp_inbound_02<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | `v3.hub_pipeline_static_skeleton` |
| `v3-hub-resp-04` | `V3HubRespChatProcess03Governed` → `V3HubRespContinuation04Committed` | anchored | all_adjacent_builders_form_the_fixed_typed_topology<br/><small>routecodex-v3-runtime/src/hub_v1/tests.rs</small> | build_v3_hub_resp_continuation_04_from_v3_hub_resp_chat_process_03<br/><small>routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs</small> | `v3.hub_pipeline_static_skeleton` |
| `v3-hub-resp-05` | `V3HubRespContinuation04Committed` → `V3HubRespOutbound05ClientSemantic` | anchored | all_adjacent_builders_form_the_fixed_typed_topology<br/><small>routecodex-v3-runtime/src/hub_v1/tests.rs</small> | build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04<br/><small>routecodex-v3-runtime/src/hub_v1/resp_outbound_05_client_semantic.rs</small> | `v3.hub_pipeline_static_skeleton` |
| `v3-hub-resp-06` | `V3HubRespOutbound05ClientSemantic` → `V3ServerRespOutbound06ClientFrame` | anchored | all_adjacent_builders_form_the_fixed_typed_topology<br/><small>routecodex-v3-runtime/src/hub_v1/tests.rs</small> | build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05<br/><small>routecodex-v3-runtime/src/hub_v1/server_resp_outbound_06_client_frame.rs</small> | `v3.hub_pipeline_static_skeleton` |

## v3.hub_pipeline.v1.relay_response_source_slice

Relay response-side source slice. Static callable response hooks implement Resp01->Resp04 only; Resp05/Server/SSE remain pass-through projection/transport and cannot own continuation semantics.

Owner feature: `v3.hub_relay_response_semantics`

```mermaid
flowchart TD
  subgraph c_22_v3_hub_pipeline_v1_relay_response_source_slice_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_22_v3_hub_pipeline_v1_relay_response_source_slice_0["v3-runtime::hub_v1<br/>normalize_v3_hub_relay_response<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
    c_22_v3_hub_pipeline_v1_relay_response_source_slice_1["v3-runtime::hub_v1<br/>build_provider_resp_compat_02_from_v3_provider_resp_inbound_01<br/><small>routecodex-v3-runtime/src/hub_v1/provider_resp_compat_02_provider_compat.rs</small>"]
    c_22_v3_hub_pipeline_v1_relay_response_source_slice_2["v3-runtime::hub_v1<br/>build_v3_hub_resp_inbound_02_from_provider_resp_compat_02<br/><small>routecodex-v3-runtime/src/hub_v1/resp_inbound_02_normalized.rs</small>"]
    c_22_v3_hub_pipeline_v1_relay_response_source_slice_3["v3-runtime::hub_v1<br/>V3HubRelayResponseHookRegistry::govern<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
    c_22_v3_hub_pipeline_v1_relay_response_source_slice_4["v3-runtime::hub_v1<br/>govern_v3_hub_relay_response<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
    c_22_v3_hub_pipeline_v1_relay_response_source_slice_5["v3-runtime::hub_v1<br/>V3HubRelayResponseHookRegistry::commit<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
    c_22_v3_hub_pipeline_v1_relay_response_source_slice_6["v3-runtime::hub_v1<br/>commit_v3_hub_relay_response<br/><small>routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs</small>"]
  end
  c_22_v3_hub_pipeline_v1_relay_response_source_slice_0 -->|v3-hub-relay-resp-01<br/>V3ProviderRespInbound01Raw → ProviderRespCompat02ProviderCompat| c_22_v3_hub_pipeline_v1_relay_response_source_slice_1
  c_22_v3_hub_pipeline_v1_relay_response_source_slice_0 -->|v3-hub-relay-resp-02<br/>ProviderRespCompat02ProviderCompat → V3HubRespInbound02Normalized| c_22_v3_hub_pipeline_v1_relay_response_source_slice_2
  c_22_v3_hub_pipeline_v1_relay_response_source_slice_3 -->|v3-hub-relay-resp-03<br/>V3HubRespInbound02Normalized → V3HubRespChatProcess03Governed| c_22_v3_hub_pipeline_v1_relay_response_source_slice_4
  c_22_v3_hub_pipeline_v1_relay_response_source_slice_5 -->|v3-hub-relay-resp-04<br/>V3HubRespChatProcess03Governed → V3HubRespContinuation04Committed| c_22_v3_hub_pipeline_v1_relay_response_source_slice_6
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-hub-relay-resp-01` | `V3ProviderRespInbound01Raw` → `ProviderRespCompat02ProviderCompat` | anchored | normalize_v3_hub_relay_response<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | build_provider_resp_compat_02_from_v3_provider_resp_inbound_01<br/><small>routecodex-v3-runtime/src/hub_v1/provider_resp_compat_02_provider_compat.rs</small> | `v3.hub_relay_response_semantics` |
| `v3-hub-relay-resp-02` | `ProviderRespCompat02ProviderCompat` → `V3HubRespInbound02Normalized` | anchored | normalize_v3_hub_relay_response<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | build_v3_hub_resp_inbound_02_from_provider_resp_compat_02<br/><small>routecodex-v3-runtime/src/hub_v1/resp_inbound_02_normalized.rs</small> | `v3.hub_relay_response_semantics` |
| `v3-hub-relay-resp-03` | `V3HubRespInbound02Normalized` → `V3HubRespChatProcess03Governed` | anchored | V3HubRelayResponseHookRegistry::govern<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | govern_v3_hub_relay_response<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | `v3.hub_relay_response_semantics` |
| `v3-hub-relay-resp-04` | `V3HubRespChatProcess03Governed` → `V3HubRespContinuation04Committed` | anchored | V3HubRelayResponseHookRegistry::commit<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | commit_v3_hub_relay_response<br/><small>routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs</small> | `v3.hub_relay_response_semantics` |

## v3.protocol.anthropic.characterization

Characterization-only Anthropic request/response codec evidence. These edges do not register Hub hooks or create a second runtime lifecycle.

Owner feature: `v3.protocol_anthropic_codec_characterization`

```mermaid
flowchart TD
  subgraph c_23_v3_protocol_anthropic_characterization_m_v3_runtime["v3-runtime"]
    c_23_v3_protocol_anthropic_characterization_0["v3-runtime<br/>request_characterization_preserves_anthropic_json_tool_result_and_reasoning_shape<br/><small>routecodex-v3-runtime/tests/hub_anthropic_codec_characterization.rs</small>"]
    c_23_v3_protocol_anthropic_characterization_2["v3-runtime<br/>anthropic_image_source_url_maps_only_to_chat_image_url_url<br/><small>routecodex-v3-runtime/tests/hub_anthropic_codec_characterization.rs</small>"]
    c_23_v3_protocol_anthropic_characterization_5["v3-runtime<br/>sse_characterization_preserves_individual_reasoning_and_tool_events_without_materialization<br/><small>routecodex-v3-runtime/tests/hub_anthropic_codec_characterization.rs</small>"]
  end
  subgraph c_23_v3_protocol_anthropic_characterization_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_23_v3_protocol_anthropic_characterization_1["v3-runtime::hub_v1<br/>characterize_v3_anthropic_client_input_to_hub_semantic<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs</small>"]
    c_23_v3_protocol_anthropic_characterization_3["v3-runtime::hub_v1<br/>collect_v3_anthropic_request_shape_branch_semantics<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs</small>"]
    c_23_v3_protocol_anthropic_characterization_4["v3-runtime::hub_v1<br/>characterize_v3_anthropic_hub_semantic_to_provider_wire<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs</small>"]
    c_23_v3_protocol_anthropic_characterization_6["v3-runtime::hub_v1<br/>characterize_v3_anthropic_provider_raw_to_hub_response_semantic<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs</small>"]
    c_23_v3_protocol_anthropic_characterization_7["v3-runtime::hub_v1<br/>characterize_v3_anthropic_hub_response_semantic_to_client_projection<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs</small>"]
  end
  c_23_v3_protocol_anthropic_characterization_0 -->|v3-protocol-anthropic-01<br/>V3AnthropicClientInput01Raw → V3AnthropicHubRequest02Semantic| c_23_v3_protocol_anthropic_characterization_1
  c_23_v3_protocol_anthropic_characterization_2 -->|v3-protocol-anthropic-shape-branch-01<br/>V3AnthropicClientInput01Raw → V3AnthropicHubRequest02Semantic| c_23_v3_protocol_anthropic_characterization_3
  c_23_v3_protocol_anthropic_characterization_0 -->|v3-protocol-anthropic-02<br/>V3AnthropicHubRequest02Semantic → V3AnthropicProviderWire03Payload| c_23_v3_protocol_anthropic_characterization_4
  c_23_v3_protocol_anthropic_characterization_5 -->|v3-protocol-anthropic-03<br/>V3AnthropicProviderRaw04Response → V3AnthropicHubResponse05Semantic| c_23_v3_protocol_anthropic_characterization_6
  c_23_v3_protocol_anthropic_characterization_5 -->|v3-protocol-anthropic-04<br/>V3AnthropicHubResponse05Semantic → V3AnthropicClientProjection06Semantic| c_23_v3_protocol_anthropic_characterization_7
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-protocol-anthropic-01` | `V3AnthropicClientInput01Raw` → `V3AnthropicHubRequest02Semantic` | anchored | request_characterization_preserves_anthropic_json_tool_result_and_reasoning_shape<br/><small>routecodex-v3-runtime/tests/hub_anthropic_codec_characterization.rs</small> | characterize_v3_anthropic_client_input_to_hub_semantic<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs</small> | `v3.protocol_anthropic_codec_characterization` |
| `v3-protocol-anthropic-shape-branch-01` | `V3AnthropicClientInput01Raw` → `V3AnthropicHubRequest02Semantic` | anchored | anthropic_image_source_url_maps_only_to_chat_image_url_url<br/><small>routecodex-v3-runtime/tests/hub_anthropic_codec_characterization.rs</small> | collect_v3_anthropic_request_shape_branch_semantics<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs</small> | `v3.protocol_anthropic_codec_characterization` |
| `v3-protocol-anthropic-02` | `V3AnthropicHubRequest02Semantic` → `V3AnthropicProviderWire03Payload` | anchored | request_characterization_preserves_anthropic_json_tool_result_and_reasoning_shape<br/><small>routecodex-v3-runtime/tests/hub_anthropic_codec_characterization.rs</small> | characterize_v3_anthropic_hub_semantic_to_provider_wire<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs</small> | `v3.protocol_anthropic_codec_characterization` |
| `v3-protocol-anthropic-03` | `V3AnthropicProviderRaw04Response` → `V3AnthropicHubResponse05Semantic` | anchored | sse_characterization_preserves_individual_reasoning_and_tool_events_without_materialization<br/><small>routecodex-v3-runtime/tests/hub_anthropic_codec_characterization.rs</small> | characterize_v3_anthropic_provider_raw_to_hub_response_semantic<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs</small> | `v3.protocol_anthropic_codec_characterization` |
| `v3-protocol-anthropic-04` | `V3AnthropicHubResponse05Semantic` → `V3AnthropicClientProjection06Semantic` | anchored | sse_characterization_preserves_individual_reasoning_and_tool_events_without_materialization<br/><small>routecodex-v3-runtime/tests/hub_anthropic_codec_characterization.rs</small> | characterize_v3_anthropic_hub_response_semantic_to_client_projection<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs</small> | `v3.protocol_anthropic_codec_characterization` |

## v3.protocol.openai_chat.characterization

Characterization-only native OpenAI Chat JSON/event codec evidence; no hook or runtime edge.

Owner feature: `v3.protocol_openai_chat_codec_characterization`

```mermaid
flowchart TD
  subgraph c_24_v3_protocol_openai_chat_characterization_m_v3_runtime["v3-runtime"]
    c_24_v3_protocol_openai_chat_characterization_0["v3-runtime<br/>request_preserves_messages_multiple_tool_calls_and_matching_results<br/><small>routecodex-v3-runtime/tests/hub_openai_chat_codec_characterization.rs</small>"]
    c_24_v3_protocol_openai_chat_characterization_3["v3-runtime<br/>sse_characterization_preserves_individual_delta_events_without_materialization<br/><small>routecodex-v3-runtime/tests/hub_openai_chat_codec_characterization.rs</small>"]
  end
  subgraph c_24_v3_protocol_openai_chat_characterization_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_24_v3_protocol_openai_chat_characterization_1["v3-runtime::hub_v1<br/>characterize_v3_openai_chat_client_input_to_hub_semantic<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_codec.rs</small>"]
    c_24_v3_protocol_openai_chat_characterization_2["v3-runtime::hub_v1<br/>characterize_v3_openai_chat_hub_semantic_to_provider_wire<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_codec.rs</small>"]
    c_24_v3_protocol_openai_chat_characterization_4["v3-runtime::hub_v1<br/>characterize_v3_openai_chat_provider_raw_to_hub_response_semantic<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_codec.rs</small>"]
    c_24_v3_protocol_openai_chat_characterization_5["v3-runtime::hub_v1<br/>characterize_v3_openai_chat_hub_response_semantic_to_client_projection<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_codec.rs</small>"]
  end
  c_24_v3_protocol_openai_chat_characterization_0 -->|v3-protocol-openai-chat-01<br/>V3OpenAiChatClientInput01Raw → V3OpenAiChatHubRequest02Semantic| c_24_v3_protocol_openai_chat_characterization_1
  c_24_v3_protocol_openai_chat_characterization_0 -->|v3-protocol-openai-chat-02<br/>V3OpenAiChatHubRequest02Semantic → V3OpenAiChatProviderWire03Payload| c_24_v3_protocol_openai_chat_characterization_2
  c_24_v3_protocol_openai_chat_characterization_3 -->|v3-protocol-openai-chat-03<br/>V3OpenAiChatProviderRaw04Response → V3OpenAiChatHubResponse05Semantic| c_24_v3_protocol_openai_chat_characterization_4
  c_24_v3_protocol_openai_chat_characterization_3 -->|v3-protocol-openai-chat-04<br/>V3OpenAiChatHubResponse05Semantic → V3OpenAiChatClientProjection06Semantic| c_24_v3_protocol_openai_chat_characterization_5
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-protocol-openai-chat-01` | `V3OpenAiChatClientInput01Raw` → `V3OpenAiChatHubRequest02Semantic` | anchored | request_preserves_messages_multiple_tool_calls_and_matching_results<br/><small>routecodex-v3-runtime/tests/hub_openai_chat_codec_characterization.rs</small> | characterize_v3_openai_chat_client_input_to_hub_semantic<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_codec.rs</small> | `v3.protocol_openai_chat_codec_characterization` |
| `v3-protocol-openai-chat-02` | `V3OpenAiChatHubRequest02Semantic` → `V3OpenAiChatProviderWire03Payload` | anchored | request_preserves_messages_multiple_tool_calls_and_matching_results<br/><small>routecodex-v3-runtime/tests/hub_openai_chat_codec_characterization.rs</small> | characterize_v3_openai_chat_hub_semantic_to_provider_wire<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_codec.rs</small> | `v3.protocol_openai_chat_codec_characterization` |
| `v3-protocol-openai-chat-03` | `V3OpenAiChatProviderRaw04Response` → `V3OpenAiChatHubResponse05Semantic` | anchored | sse_characterization_preserves_individual_delta_events_without_materialization<br/><small>routecodex-v3-runtime/tests/hub_openai_chat_codec_characterization.rs</small> | characterize_v3_openai_chat_provider_raw_to_hub_response_semantic<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_codec.rs</small> | `v3.protocol_openai_chat_codec_characterization` |
| `v3-protocol-openai-chat-04` | `V3OpenAiChatHubResponse05Semantic` → `V3OpenAiChatClientProjection06Semantic` | anchored | sse_characterization_preserves_individual_delta_events_without_materialization<br/><small>routecodex-v3-runtime/tests/hub_openai_chat_codec_characterization.rs</small> | characterize_v3_openai_chat_hub_response_semantic_to_client_projection<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_codec.rs</small> | `v3.protocol_openai_chat_codec_characterization` |

## v3.protocol.gemini.characterization

Characterization-only native Gemini JSON/event codec evidence; no hook, Server endpoint implementation, or runtime edge.

Owner feature: `v3.protocol_gemini_codec_characterization`

```mermaid
flowchart TD
  subgraph c_25_v3_protocol_gemini_characterization_m_v3_runtime["v3-runtime"]
    c_25_v3_protocol_gemini_characterization_0["v3-runtime<br/>request_preserves_contents_tools_and_function_response_pairs<br/><small>routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs</small>"]
    c_25_v3_protocol_gemini_characterization_2["v3-runtime<br/>gemini_inline_data_maps_to_chat_inline_media_data<br/><small>routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs</small>"]
    c_25_v3_protocol_gemini_characterization_4["v3-runtime<br/>gemini_tool_config_mode_maps_to_chat_tool_choice_policy<br/><small>routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs</small>"]
    c_25_v3_protocol_gemini_characterization_6["v3-runtime<br/>gemini_thinking_config_include_thoughts_maps_to_reasoning_visibility_request<br/><small>routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs</small>"]
    c_25_v3_protocol_gemini_characterization_8["v3-runtime<br/>gemini_generation_config_frequency_penalty_maps_to_chat_frequency_penalty<br/><small>routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs</small>"]
    c_25_v3_protocol_gemini_characterization_11["v3-runtime<br/>sse_characterization_preserves_individual_candidate_events_without_materialization<br/><small>routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs</small>"]
  end
  subgraph c_25_v3_protocol_gemini_characterization_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_25_v3_protocol_gemini_characterization_1["v3-runtime::hub_v1<br/>characterize_v3_gemini_client_input_to_hub_semantic<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_codec.rs</small>"]
    c_25_v3_protocol_gemini_characterization_3["v3-runtime::hub_v1<br/>collect_v3_gemini_request_shape_branch_semantics<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_codec.rs</small>"]
    c_25_v3_protocol_gemini_characterization_5["v3-runtime::hub_v1<br/>collect_v3_gemini_request_tool_config_semantics<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_codec.rs</small>"]
    c_25_v3_protocol_gemini_characterization_7["v3-runtime::hub_v1<br/>collect_v3_gemini_request_thinking_config_semantics<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_codec.rs</small>"]
    c_25_v3_protocol_gemini_characterization_9["v3-runtime::hub_v1<br/>collect_v3_gemini_request_generation_config_scalar_semantics<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_codec.rs</small>"]
    c_25_v3_protocol_gemini_characterization_10["v3-runtime::hub_v1<br/>characterize_v3_gemini_hub_semantic_to_provider_wire<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_codec.rs</small>"]
    c_25_v3_protocol_gemini_characterization_12["v3-runtime::hub_v1<br/>characterize_v3_gemini_provider_raw_to_hub_response_semantic<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_codec.rs</small>"]
    c_25_v3_protocol_gemini_characterization_13["v3-runtime::hub_v1<br/>characterize_v3_gemini_hub_response_semantic_to_client_projection<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_codec.rs</small>"]
  end
  c_25_v3_protocol_gemini_characterization_0 -->|v3-protocol-gemini-01<br/>V3GeminiClientInput01Raw → V3GeminiHubRequest02Semantic| c_25_v3_protocol_gemini_characterization_1
  c_25_v3_protocol_gemini_characterization_2 -->|v3-protocol-gemini-shape-branch-01<br/>V3GeminiClientInput01Raw → V3GeminiHubRequest02Semantic| c_25_v3_protocol_gemini_characterization_3
  c_25_v3_protocol_gemini_characterization_4 -->|v3-protocol-gemini-tool-config-01<br/>V3GeminiClientInput01Raw → V3GeminiHubRequest02Semantic| c_25_v3_protocol_gemini_characterization_5
  c_25_v3_protocol_gemini_characterization_6 -->|v3-protocol-gemini-thinking-config-01<br/>V3GeminiClientInput01Raw → V3GeminiHubRequest02Semantic| c_25_v3_protocol_gemini_characterization_7
  c_25_v3_protocol_gemini_characterization_8 -->|v3-protocol-gemini-generation-config-scalar-01<br/>V3GeminiClientInput01Raw → V3GeminiHubRequest02Semantic| c_25_v3_protocol_gemini_characterization_9
  c_25_v3_protocol_gemini_characterization_0 -->|v3-protocol-gemini-02<br/>V3GeminiHubRequest02Semantic → V3GeminiProviderWire03Payload| c_25_v3_protocol_gemini_characterization_10
  c_25_v3_protocol_gemini_characterization_11 -->|v3-protocol-gemini-03<br/>V3GeminiProviderRaw04Response → V3GeminiHubResponse05Semantic| c_25_v3_protocol_gemini_characterization_12
  c_25_v3_protocol_gemini_characterization_11 -->|v3-protocol-gemini-04<br/>V3GeminiHubResponse05Semantic → V3GeminiClientProjection06Semantic| c_25_v3_protocol_gemini_characterization_13
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-protocol-gemini-01` | `V3GeminiClientInput01Raw` → `V3GeminiHubRequest02Semantic` | anchored | request_preserves_contents_tools_and_function_response_pairs<br/><small>routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs</small> | characterize_v3_gemini_client_input_to_hub_semantic<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_codec.rs</small> | `v3.protocol_gemini_codec_characterization` |
| `v3-protocol-gemini-shape-branch-01` | `V3GeminiClientInput01Raw` → `V3GeminiHubRequest02Semantic` | anchored | gemini_inline_data_maps_to_chat_inline_media_data<br/><small>routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs</small> | collect_v3_gemini_request_shape_branch_semantics<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_codec.rs</small> | `v3.protocol_gemini_codec_characterization` |
| `v3-protocol-gemini-tool-config-01` | `V3GeminiClientInput01Raw` → `V3GeminiHubRequest02Semantic` | anchored | gemini_tool_config_mode_maps_to_chat_tool_choice_policy<br/><small>routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs</small> | collect_v3_gemini_request_tool_config_semantics<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_codec.rs</small> | `v3.protocol_gemini_codec_characterization` |
| `v3-protocol-gemini-thinking-config-01` | `V3GeminiClientInput01Raw` → `V3GeminiHubRequest02Semantic` | anchored | gemini_thinking_config_include_thoughts_maps_to_reasoning_visibility_request<br/><small>routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs</small> | collect_v3_gemini_request_thinking_config_semantics<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_codec.rs</small> | `v3.protocol_gemini_codec_characterization` |
| `v3-protocol-gemini-generation-config-scalar-01` | `V3GeminiClientInput01Raw` → `V3GeminiHubRequest02Semantic` | anchored | gemini_generation_config_frequency_penalty_maps_to_chat_frequency_penalty<br/><small>routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs</small> | collect_v3_gemini_request_generation_config_scalar_semantics<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_codec.rs</small> | `v3.protocol_gemini_codec_characterization` |
| `v3-protocol-gemini-02` | `V3GeminiHubRequest02Semantic` → `V3GeminiProviderWire03Payload` | anchored | request_preserves_contents_tools_and_function_response_pairs<br/><small>routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs</small> | characterize_v3_gemini_hub_semantic_to_provider_wire<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_codec.rs</small> | `v3.protocol_gemini_codec_characterization` |
| `v3-protocol-gemini-03` | `V3GeminiProviderRaw04Response` → `V3GeminiHubResponse05Semantic` | anchored | sse_characterization_preserves_individual_candidate_events_without_materialization<br/><small>routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs</small> | characterize_v3_gemini_provider_raw_to_hub_response_semantic<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_codec.rs</small> | `v3.protocol_gemini_codec_characterization` |
| `v3-protocol-gemini-04` | `V3GeminiHubResponse05Semantic` → `V3GeminiClientProjection06Semantic` | anchored | sse_characterization_preserves_individual_candidate_events_without_materialization<br/><small>routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs</small> | characterize_v3_gemini_hub_response_semantic_to_client_projection<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_codec.rs</small> | `v3.protocol_gemini_codec_characterization` |

## v3.hub_pipeline.v1.relay_payload_copy_runtime_probes

Test-only probes bind copy-budget observations to existing Relay nodes without adding a runtime edge or second truth.

Owner feature: `v3.hub_relay_payload_copy_runtime_probes`

```mermaid
flowchart TD
  subgraph c_26_v3_hub_pipeline_v1_relay_payload_copy_runtime_probes_m_v3_runtime["v3-runtime"]
    c_26_v3_hub_pipeline_v1_relay_payload_copy_runtime_probes_0["v3-runtime<br/>relay_json_moves_one_business_payload_through_req04<br/><small>routecodex-v3-runtime/tests/hub_relay_payload_copy_runtime_probes.rs</small>"]
    c_26_v3_hub_pipeline_v1_relay_payload_copy_runtime_probes_2["v3-runtime<br/>relay_sse_keeps_one_canonical_payload_without_materializing_stream<br/><small>routecodex-v3-runtime/tests/hub_relay_payload_copy_runtime_probes.rs</small>"]
    c_26_v3_hub_pipeline_v1_relay_payload_copy_runtime_probes_4["v3-runtime<br/>local_context_is_retained_until_req04_outcome_release<br/><small>routecodex-v3-runtime/tests/hub_relay_payload_copy_runtime_probes.rs</small>"]
    c_26_v3_hub_pipeline_v1_relay_payload_copy_runtime_probes_6["v3-runtime<br/>servertool_roundtrip_uses_one_resp04_context_and_restores_before_req04_hook<br/><small>routecodex-v3-runtime/tests/hub_relay_payload_copy_runtime_probes.rs</small>"]
  end
  subgraph c_26_v3_hub_pipeline_v1_relay_payload_copy_runtime_probes_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_26_v3_hub_pipeline_v1_relay_payload_copy_runtime_probes_1["v3-runtime::hub_v1<br/>V3HubRelayRequestHooks::run<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small>"]
    c_26_v3_hub_pipeline_v1_relay_payload_copy_runtime_probes_3["v3-runtime::hub_v1<br/>V3HubRelayResponseHookRegistry::normalize<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
    c_26_v3_hub_pipeline_v1_relay_payload_copy_runtime_probes_5["v3-runtime::hub_v1<br/>restore_local_context_at_req04<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small>"]
    c_26_v3_hub_pipeline_v1_relay_payload_copy_runtime_probes_7["v3-runtime::hub_v1<br/>V3HubRelayResponseHookRegistry::commit<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
  end
  c_26_v3_hub_pipeline_v1_relay_payload_copy_runtime_probes_0 -->|v3-hub-relay-copy-probe-01<br/>V3HubReqInbound01ClientRaw → V3HubReqInbound02Normalized| c_26_v3_hub_pipeline_v1_relay_payload_copy_runtime_probes_1
  c_26_v3_hub_pipeline_v1_relay_payload_copy_runtime_probes_2 -->|v3-hub-relay-copy-probe-02<br/>V3ProviderRespInbound01Raw → ProviderRespCompat02ProviderCompat| c_26_v3_hub_pipeline_v1_relay_payload_copy_runtime_probes_3
  c_26_v3_hub_pipeline_v1_relay_payload_copy_runtime_probes_2 -->|v3-hub-relay-copy-probe-03<br/>ProviderRespCompat02ProviderCompat → V3HubRespInbound02Normalized| c_26_v3_hub_pipeline_v1_relay_payload_copy_runtime_probes_3
  c_26_v3_hub_pipeline_v1_relay_payload_copy_runtime_probes_4 -->|v3-hub-relay-copy-probe-04<br/>V3HubReqContinuation03Classified → V3HubReqChatProcess04Governed| c_26_v3_hub_pipeline_v1_relay_payload_copy_runtime_probes_5
  c_26_v3_hub_pipeline_v1_relay_payload_copy_runtime_probes_6 -->|v3-hub-relay-copy-probe-05<br/>V3HubRespChatProcess03Governed → V3HubRespContinuation04Committed| c_26_v3_hub_pipeline_v1_relay_payload_copy_runtime_probes_7
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-hub-relay-copy-probe-01` | `V3HubReqInbound01ClientRaw` → `V3HubReqInbound02Normalized` | anchored | relay_json_moves_one_business_payload_through_req04<br/><small>routecodex-v3-runtime/tests/hub_relay_payload_copy_runtime_probes.rs</small> | V3HubRelayRequestHooks::run<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small> | `v3.hub_relay_payload_copy_runtime_probes` |
| `v3-hub-relay-copy-probe-02` | `V3ProviderRespInbound01Raw` → `ProviderRespCompat02ProviderCompat` | anchored | relay_sse_keeps_one_canonical_payload_without_materializing_stream<br/><small>routecodex-v3-runtime/tests/hub_relay_payload_copy_runtime_probes.rs</small> | V3HubRelayResponseHookRegistry::normalize<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | `v3.hub_relay_payload_copy_runtime_probes` |
| `v3-hub-relay-copy-probe-03` | `ProviderRespCompat02ProviderCompat` → `V3HubRespInbound02Normalized` | anchored | relay_sse_keeps_one_canonical_payload_without_materializing_stream<br/><small>routecodex-v3-runtime/tests/hub_relay_payload_copy_runtime_probes.rs</small> | V3HubRelayResponseHookRegistry::normalize<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | `v3.hub_relay_payload_copy_runtime_probes` |
| `v3-hub-relay-copy-probe-04` | `V3HubReqContinuation03Classified` → `V3HubReqChatProcess04Governed` | anchored | local_context_is_retained_until_req04_outcome_release<br/><small>routecodex-v3-runtime/tests/hub_relay_payload_copy_runtime_probes.rs</small> | restore_local_context_at_req04<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small> | `v3.hub_relay_payload_copy_runtime_probes` |
| `v3-hub-relay-copy-probe-05` | `V3HubRespChatProcess03Governed` → `V3HubRespContinuation04Committed` | anchored | servertool_roundtrip_uses_one_resp04_context_and_restores_before_req04_hook<br/><small>routecodex-v3-runtime/tests/hub_relay_payload_copy_runtime_probes.rs</small> | V3HubRelayResponseHookRegistry::commit<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | `v3.hub_relay_payload_copy_runtime_probes` |

## v3.server.startup

Atomic multi-listener startup plus strict HTTP boundary; valid business requests enter Runtime and invalid input enters the global typed Error chain before Runtime.

Owner feature: `v3.foundation_p0_p2`

```mermaid
flowchart TD
  subgraph c_27_v3_server_startup_m_v3_debug["v3-debug"]
    c_27_v3_server_startup_6["v3-debug<br/>register_v3_debug_01_pending_endpoint_event<br/><small>routecodex-v3-debug/src/lib.rs</small>"]
  end
  subgraph c_27_v3_server_startup_m_v3_error["v3-error"]
    c_27_v3_server_startup_5["v3-error<br/>project_v3_http_boundary_error<br/><small>routecodex-v3-error/src/lib.rs</small>"]
    c_27_v3_server_startup_7["v3-error<br/>project_v3_pending_endpoint_error<br/><small>routecodex-v3-error/src/lib.rs</small>"]
  end
  subgraph c_27_v3_server_startup_m_v3_server["v3-server"]
    c_27_v3_server_startup_0["v3-server<br/>spawn_v3_server_aggregate<br/><small>routecodex-v3-server/src/lib.rs</small>"]
    c_27_v3_server_startup_1["v3-server<br/>build_v3_server_startup_01_listener_set_from_config_05<br/><small>routecodex-v3-server/src/lib.rs</small>"]
    c_27_v3_server_startup_2["v3-server<br/>pending_endpoint<br/><small>routecodex-v3-server/src/endpoint_handlers.rs</small>"]
    c_27_v3_server_startup_3["v3-server<br/>build_v3_server_03_http_request_raw<br/><small>routecodex-v3-server/src/lib.rs</small>"]
    c_27_v3_server_startup_4["v3-server<br/>read_json_payload<br/><small>routecodex-v3-server/src/frame_builders.rs</small>"]
    c_27_v3_server_startup_8["v3-server<br/>build_v3_server_16_http_frame_from_v3_error_06<br/><small>routecodex-v3-server/src/frame_builders.rs</small>"]
  end
  c_27_v3_server_startup_0 -->|v3-srv-01<br/>V3Config05ManifestPublished → V3ServerStartup01ListenerSetPreflight| c_27_v3_server_startup_1
  c_27_v3_server_startup_2 -->|v3-srv-02<br/>V3ServerStartup01ListenerSetPreflight → V3Server03HttpRequestRaw| c_27_v3_server_startup_3
  c_27_v3_server_startup_4 -->|v3-srv-http-error-01<br/>V3Server03HttpRequestRaw → V3Error01SourceRaised| c_27_v3_server_startup_5
  c_27_v3_server_startup_2 -->|v3-srv-03<br/>V3Server03HttpRequestRaw → V3Debug01NodeEventRegistered| c_27_v3_server_startup_6
  c_27_v3_server_startup_2 -->|v3-srv-04<br/>V3Debug01NodeEventRegistered → V3Error06ClientProjected| c_27_v3_server_startup_7
  c_27_v3_server_startup_2 -->|v3-srv-05<br/>V3Error06ClientProjected → V3Server16HttpFrame| c_27_v3_server_startup_8
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-srv-01` | `V3Config05ManifestPublished` → `V3ServerStartup01ListenerSetPreflight` | anchored | spawn_v3_server_aggregate<br/><small>routecodex-v3-server/src/lib.rs</small> | build_v3_server_startup_01_listener_set_from_config_05<br/><small>routecodex-v3-server/src/lib.rs</small> | `v3.foundation_p0_p2` |
| `v3-srv-02` | `V3ServerStartup01ListenerSetPreflight` → `V3Server03HttpRequestRaw` | anchored | pending_endpoint<br/><small>routecodex-v3-server/src/endpoint_handlers.rs</small> | build_v3_server_03_http_request_raw<br/><small>routecodex-v3-server/src/lib.rs</small> | `v3.foundation_p0_p2` |
| `v3-srv-http-error-01` | `V3Server03HttpRequestRaw` → `V3Error01SourceRaised` | anchored | read_json_payload<br/><small>routecodex-v3-server/src/frame_builders.rs</small> | project_v3_http_boundary_error<br/><small>routecodex-v3-error/src/lib.rs</small> | `v3.config_server_full_function` |
| `v3-srv-03` | `V3Server03HttpRequestRaw` → `V3Debug01NodeEventRegistered` | anchored | pending_endpoint<br/><small>routecodex-v3-server/src/endpoint_handlers.rs</small> | register_v3_debug_01_pending_endpoint_event<br/><small>routecodex-v3-debug/src/lib.rs</small> | `v3.foundation_p0_p2` |
| `v3-srv-04` | `V3Debug01NodeEventRegistered` → `V3Error06ClientProjected` | anchored | pending_endpoint<br/><small>routecodex-v3-server/src/endpoint_handlers.rs</small> | project_v3_pending_endpoint_error<br/><small>routecodex-v3-error/src/lib.rs</small> | `v3.foundation_p0_p2` |
| `v3-srv-05` | `V3Error06ClientProjected` → `V3Server16HttpFrame` | anchored | pending_endpoint<br/><small>routecodex-v3-server/src/endpoint_handlers.rs</small> | build_v3_server_16_http_frame_from_v3_error_06<br/><small>routecodex-v3-server/src/frame_builders.rs</small> | `v3.foundation_p0_p2` |

## v3.debug_error_foundation.mainline

P3/P4 Runtime foundation: Server enters Runtime, Debug records side-channel evidence, Error traverses six adjacent nodes, Error owns the failure session scope, Provider owns health state.

Owner feature: `v3.debug_error_foundation`

```mermaid
flowchart TD
  subgraph c_28_v3_debug_error_foundation_mainline_m_v3_debug["v3-debug"]
    c_28_v3_debug_error_foundation_mainline_1["v3-debug<br/>V3DebugRuntime::start_trace<br/><small>routecodex-v3-debug/src/lib.rs</small>"]
    c_28_v3_debug_error_foundation_mainline_2["v3-debug<br/>V3DebugRuntime::capture_raw_request<br/><small>routecodex-v3-debug/src/lib.rs</small>"]
    c_28_v3_debug_error_foundation_mainline_3["v3-debug<br/>V3DebugRuntime::record_node_event<br/><small>routecodex-v3-debug/src/lib.rs</small>"]
    c_28_v3_debug_error_foundation_mainline_14["v3-debug<br/>V3DebugRuntime::build_dry_run_execution_plan<br/><small>routecodex-v3-debug/src/lib.rs</small>"]
    c_28_v3_debug_error_foundation_mainline_15["v3-debug<br/>V3DebugRuntime::start_snapshot_session<br/><small>routecodex-v3-debug/src/lib.rs</small>"]
  end
  subgraph c_28_v3_debug_error_foundation_mainline_m_v3_error["v3-error"]
    c_28_v3_debug_error_foundation_mainline_5["v3-error<br/>build_v3_error_01_source_raised<br/><small>routecodex-v3-error/src/lib.rs</small>"]
    c_28_v3_debug_error_foundation_mainline_6["v3-error<br/>V3ErrorHandlingCenter::decide_provider<br/><small>routecodex-v3-error/src/lib.rs</small>"]
    c_28_v3_debug_error_foundation_mainline_7["v3-error<br/>build_v3_error_02_classified_from_v3_error_01<br/><small>routecodex-v3-error/src/lib.rs</small>"]
    c_28_v3_debug_error_foundation_mainline_8["v3-error<br/>build_v3_error_03_target_local_action_from_v3_error_02<br/><small>routecodex-v3-error/src/lib.rs</small>"]
    c_28_v3_debug_error_foundation_mainline_9["v3-error<br/>build_v3_error_04_target_exhaustion_decision_with_provider_availability<br/><small>routecodex-v3-error/src/lib.rs</small>"]
    c_28_v3_debug_error_foundation_mainline_10["v3-error<br/>build_v3_error_05_execution_decision_from_v3_error_04<br/><small>routecodex-v3-error/src/lib.rs</small>"]
    c_28_v3_debug_error_foundation_mainline_11["v3-error<br/>V3ErrorHandlingCenter::handle<br/><small>routecodex-v3-error/src/lib.rs</small>"]
    c_28_v3_debug_error_foundation_mainline_12["v3-error<br/>build_v3_error_06_client_projected_from_v3_error_05<br/><small>routecodex-v3-error/src/lib.rs</small>"]
    c_28_v3_debug_error_foundation_mainline_23["v3-error<br/>build_v3_error_01_source_raised_external<br/><small>routecodex-v3-error/src/lib.rs</small>"]
    c_28_v3_debug_error_foundation_mainline_24["v3-error<br/>build_v3_error_01_source_raised_internal<br/><small>routecodex-v3-error/src/lib.rs</small>"]
    c_28_v3_debug_error_foundation_mainline_26["v3-error<br/>V3ProviderFailureSessionScope::new<br/><small>routecodex-v3-error/src/lib.rs</small>"]
  end
  subgraph c_28_v3_debug_error_foundation_mainline_m_v3_provider_responses["v3-provider-responses"]
    c_28_v3_debug_error_foundation_mainline_17["v3-provider-responses<br/>V3ProviderHealthStore::record_provider_failure_in_session<br/><small>routecodex-v3-provider-responses/src/health.rs</small>"]
    c_28_v3_debug_error_foundation_mainline_18["v3-provider-responses<br/>V3ProviderSessionAvailabilityReader::availability<br/><small>routecodex-v3-provider-responses/src/health.rs</small>"]
    c_28_v3_debug_error_foundation_mainline_19["v3-provider-responses<br/>V3ProviderHealthStore::availability_for_session<br/><small>routecodex-v3-provider-responses/src/health.rs</small>"]
    c_28_v3_debug_error_foundation_mainline_21["v3-provider-responses<br/>V3ProviderHealthStore::record_provider_success_in_session<br/><small>routecodex-v3-provider-responses/src/health.rs</small>"]
  end
  subgraph c_28_v3_debug_error_foundation_mainline_m_v3_runtime["v3-runtime"]
    c_28_v3_debug_error_foundation_mainline_0["v3-runtime<br/>execute_v3_foundation_pending_runtime<br/><small>routecodex-v3-runtime/src/foundation.rs</small>"]
    c_28_v3_debug_error_foundation_mainline_4["v3-runtime<br/>build_pending_projection<br/><small>routecodex-v3-runtime/src/foundation.rs</small>"]
    c_28_v3_debug_error_foundation_mainline_13["v3-runtime<br/>execute_v3_responses_direct_dry_run_runtime<br/><small>routecodex-v3-runtime/src/kernel/direct_protocol_plan.rs</small>"]
    c_28_v3_debug_error_foundation_mainline_16["v3-runtime<br/>V3ProviderFailureRuntimeHealth::record_provider_failure_record<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small>"]
    c_28_v3_debug_error_foundation_mainline_20["v3-runtime<br/>V3ProviderFailureRuntimeHealth::record_provider_success_in_failure_scope<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small>"]
    c_28_v3_debug_error_foundation_mainline_22["v3-runtime<br/>build_v3_provider_error_source<br/><small>routecodex-v3-runtime/src/hooks.rs</small>"]
  end
  subgraph c_28_v3_debug_error_foundation_mainline_m_v3_server["v3-server"]
    c_28_v3_debug_error_foundation_mainline_25["v3-server<br/>build_v3_provider_failure_session_scope_for_request<br/><small>routecodex-v3-server/src/lib.rs</small>"]
  end
  c_28_v3_debug_error_foundation_mainline_0 -->|v3-de-01<br/>V3Server03HttpRequestRaw → V3DebugTraceContextStarted| c_28_v3_debug_error_foundation_mainline_1
  c_28_v3_debug_error_foundation_mainline_0 -->|v3-de-02<br/>V3DebugTraceContextStarted → V3DebugRawCaptureStored| c_28_v3_debug_error_foundation_mainline_2
  c_28_v3_debug_error_foundation_mainline_0 -->|v3-de-03<br/>V3DebugTraceContextStarted → V3DebugEventLedgerRecorded| c_28_v3_debug_error_foundation_mainline_3
  c_28_v3_debug_error_foundation_mainline_4 -->|v3-de-04<br/>V3Server03HttpRequestRaw → V3Error01SourceRaised| c_28_v3_debug_error_foundation_mainline_5
  c_28_v3_debug_error_foundation_mainline_6 -->|v3-de-05<br/>V3Error01SourceRaised → V3Error02Classified| c_28_v3_debug_error_foundation_mainline_7
  c_28_v3_debug_error_foundation_mainline_6 -->|v3-de-06<br/>V3Error02Classified → V3Error03TargetLocalAction| c_28_v3_debug_error_foundation_mainline_8
  c_28_v3_debug_error_foundation_mainline_6 -->|v3-de-07<br/>V3Error03TargetLocalAction → V3Error04TargetExhaustionDecision| c_28_v3_debug_error_foundation_mainline_9
  c_28_v3_debug_error_foundation_mainline_6 -->|v3-de-08<br/>V3Error04TargetExhaustionDecision → V3Error05ExecutionDecision| c_28_v3_debug_error_foundation_mainline_10
  c_28_v3_debug_error_foundation_mainline_11 -->|v3-de-09<br/>V3Error05ExecutionDecision → V3Error06ClientProjected| c_28_v3_debug_error_foundation_mainline_12
  c_28_v3_debug_error_foundation_mainline_13 -->|v3-de-10<br/>V3DryRunFixture → V3DryRunNoNetworkTerminalEffect| c_28_v3_debug_error_foundation_mainline_14
  c_28_v3_debug_error_foundation_mainline_13 -->|v3-de-11<br/>V3DebugTraceContextStarted → V3DebugSnapshotSessionRegistered| c_28_v3_debug_error_foundation_mainline_15
  c_28_v3_debug_error_foundation_mainline_16 -->|v3-de-12<br/>V3Error03TargetLocalAction → V3ProviderHealthStateMutated| c_28_v3_debug_error_foundation_mainline_17
  c_28_v3_debug_error_foundation_mainline_18 -->|v3-de-13<br/>V3ProviderHealthStateMutated → V3ProviderAvailabilityProjected| c_28_v3_debug_error_foundation_mainline_19
  c_28_v3_debug_error_foundation_mainline_16 -->|v3-de-14<br/>V3Transport13ResponsesHttpRequest → V3ProviderHealthStateMutated| c_28_v3_debug_error_foundation_mainline_17
  c_28_v3_debug_error_foundation_mainline_20 -->|v3-de-15<br/>V3ProviderResp14Raw → V3ProviderHealthStateMutated| c_28_v3_debug_error_foundation_mainline_21
  c_28_v3_debug_error_foundation_mainline_22 -->|v3-de-16<br/>V3ProviderError → V3Error01SourceRaised| c_28_v3_debug_error_foundation_mainline_23
  c_28_v3_debug_error_foundation_mainline_22 -->|v3-de-17<br/>V3ProviderError → V3Error01SourceRaised| c_28_v3_debug_error_foundation_mainline_24
  c_28_v3_debug_error_foundation_mainline_25 -->|v3-de-18<br/>V3Server03HttpRequestRaw → V3ProviderFailureSessionScope| c_28_v3_debug_error_foundation_mainline_26
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-de-01` | `V3Server03HttpRequestRaw` → `V3DebugTraceContextStarted` | anchored | execute_v3_foundation_pending_runtime<br/><small>routecodex-v3-runtime/src/foundation.rs</small> | V3DebugRuntime::start_trace<br/><small>routecodex-v3-debug/src/lib.rs</small> | `v3.debug_error_foundation` |
| `v3-de-02` | `V3DebugTraceContextStarted` → `V3DebugRawCaptureStored` | anchored | execute_v3_foundation_pending_runtime<br/><small>routecodex-v3-runtime/src/foundation.rs</small> | V3DebugRuntime::capture_raw_request<br/><small>routecodex-v3-debug/src/lib.rs</small> | `v3.debug_error_foundation` |
| `v3-de-03` | `V3DebugTraceContextStarted` → `V3DebugEventLedgerRecorded` | anchored | execute_v3_foundation_pending_runtime<br/><small>routecodex-v3-runtime/src/foundation.rs</small> | V3DebugRuntime::record_node_event<br/><small>routecodex-v3-debug/src/lib.rs</small> | `v3.debug_error_foundation` |
| `v3-de-04` | `V3Server03HttpRequestRaw` → `V3Error01SourceRaised` | anchored | build_pending_projection<br/><small>routecodex-v3-runtime/src/foundation.rs</small> | build_v3_error_01_source_raised<br/><small>routecodex-v3-error/src/lib.rs</small> | `v3.debug_error_foundation` |
| `v3-de-05` | `V3Error01SourceRaised` → `V3Error02Classified` | anchored | V3ErrorHandlingCenter::decide_provider<br/><small>routecodex-v3-error/src/lib.rs</small> | build_v3_error_02_classified_from_v3_error_01<br/><small>routecodex-v3-error/src/lib.rs</small> | `v3.debug_error_foundation` |
| `v3-de-06` | `V3Error02Classified` → `V3Error03TargetLocalAction` | anchored | V3ErrorHandlingCenter::decide_provider<br/><small>routecodex-v3-error/src/lib.rs</small> | build_v3_error_03_target_local_action_from_v3_error_02<br/><small>routecodex-v3-error/src/lib.rs</small> | `v3.debug_error_foundation` |
| `v3-de-07` | `V3Error03TargetLocalAction` → `V3Error04TargetExhaustionDecision` | anchored | V3ErrorHandlingCenter::decide_provider<br/><small>routecodex-v3-error/src/lib.rs</small> | build_v3_error_04_target_exhaustion_decision_with_provider_availability<br/><small>routecodex-v3-error/src/lib.rs</small> | `v3.debug_error_foundation` |
| `v3-de-08` | `V3Error04TargetExhaustionDecision` → `V3Error05ExecutionDecision` | anchored | V3ErrorHandlingCenter::decide_provider<br/><small>routecodex-v3-error/src/lib.rs</small> | build_v3_error_05_execution_decision_from_v3_error_04<br/><small>routecodex-v3-error/src/lib.rs</small> | `v3.debug_error_foundation` |
| `v3-de-09` | `V3Error05ExecutionDecision` → `V3Error06ClientProjected` | anchored | V3ErrorHandlingCenter::handle<br/><small>routecodex-v3-error/src/lib.rs</small> | build_v3_error_06_client_projected_from_v3_error_05<br/><small>routecodex-v3-error/src/lib.rs</small> | `v3.debug_error_foundation` |
| `v3-de-10` | `V3DryRunFixture` → `V3DryRunNoNetworkTerminalEffect` | anchored | execute_v3_responses_direct_dry_run_runtime<br/><small>routecodex-v3-runtime/src/kernel/direct_protocol_plan.rs</small> | V3DebugRuntime::build_dry_run_execution_plan<br/><small>routecodex-v3-debug/src/lib.rs</small> | `v3.debug_error_foundation` |
| `v3-de-11` | `V3DebugTraceContextStarted` → `V3DebugSnapshotSessionRegistered` | anchored | execute_v3_responses_direct_dry_run_runtime<br/><small>routecodex-v3-runtime/src/kernel/direct_protocol_plan.rs</small> | V3DebugRuntime::start_snapshot_session<br/><small>routecodex-v3-debug/src/lib.rs</small> | `v3.debug_error_foundation` |
| `v3-de-12` | `V3Error03TargetLocalAction` → `V3ProviderHealthStateMutated` | anchored | V3ProviderFailureRuntimeHealth::record_provider_failure_record<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | V3ProviderHealthStore::record_provider_failure_in_session<br/><small>routecodex-v3-provider-responses/src/health.rs</small> | `v3.debug_error_foundation` |
| `v3-de-13` | `V3ProviderHealthStateMutated` → `V3ProviderAvailabilityProjected` | anchored | V3ProviderSessionAvailabilityReader::availability<br/><small>routecodex-v3-provider-responses/src/health.rs</small> | V3ProviderHealthStore::availability_for_session<br/><small>routecodex-v3-provider-responses/src/health.rs</small> | `v3.debug_error_foundation` |
| `v3-de-14` | `V3Transport13ResponsesHttpRequest` → `V3ProviderHealthStateMutated` | anchored | V3ProviderFailureRuntimeHealth::record_provider_failure_record<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | V3ProviderHealthStore::record_provider_failure_in_session<br/><small>routecodex-v3-provider-responses/src/health.rs</small> | `v3.debug_error_foundation` |
| `v3-de-15` | `V3ProviderResp14Raw` → `V3ProviderHealthStateMutated` | anchored | V3ProviderFailureRuntimeHealth::record_provider_success_in_failure_scope<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | V3ProviderHealthStore::record_provider_success_in_session<br/><small>routecodex-v3-provider-responses/src/health.rs</small> | `v3.debug_error_foundation` |
| `v3-de-16` | `V3ProviderError` → `V3Error01SourceRaised` | anchored | build_v3_provider_error_source<br/><small>routecodex-v3-runtime/src/hooks.rs</small> | build_v3_error_01_source_raised_external<br/><small>routecodex-v3-error/src/lib.rs</small> | `v3.debug_error_foundation` |
| `v3-de-17` | `V3ProviderError` → `V3Error01SourceRaised` | anchored | build_v3_provider_error_source<br/><small>routecodex-v3-runtime/src/hooks.rs</small> | build_v3_error_01_source_raised_internal<br/><small>routecodex-v3-error/src/lib.rs</small> | `v3.debug_error_foundation` |
| `v3-de-18` | `V3Server03HttpRequestRaw` → `V3ProviderFailureSessionScope` | anchored | build_v3_provider_failure_session_scope_for_request<br/><small>routecodex-v3-server/src/lib.rs</small> | V3ProviderFailureSessionScope::new<br/><small>routecodex-v3-error/src/lib.rs</small> | `v3.debug_error_foundation` |

## v3.responses_continuation.remote_contract_store

H4 source-only direct-owner remote locator commit/load contract. It stores locator and pin control facts only and is not wired into Hub v1.

Owner feature: `v3.remote_continuation_contract_store`

```mermaid
flowchart TD
  subgraph c_29_v3_responses_continuation_remote_contract_store_m_v3_runtime["v3-runtime"]
    c_29_v3_responses_continuation_remote_contract_store_0["v3-runtime<br/>direct_remote_locator_round_trips_for_same_entry_scope_and_pin<br/><small>routecodex-v3-runtime/tests/h4_remote_continuation_contract.rs</small>"]
    c_29_v3_responses_continuation_remote_contract_store_1["v3-runtime<br/>V3RemoteContinuationStore::commit<br/><small>routecodex-v3-runtime/src/remote_continuation.rs</small>"]
    c_29_v3_responses_continuation_remote_contract_store_2["v3-runtime<br/>V3RemoteContinuationStore::load<br/><small>routecodex-v3-runtime/src/remote_continuation.rs</small>"]
  end
  c_29_v3_responses_continuation_remote_contract_store_0 -->|v3-h4-remote-01<br/>V3RemoteContinuationCommitInput → V3RemoteContinuationLocator| c_29_v3_responses_continuation_remote_contract_store_1
  c_29_v3_responses_continuation_remote_contract_store_0 -->|v3-h4-remote-02<br/>V3RemoteContinuationLoadRequest → V3RemoteContinuationLocator| c_29_v3_responses_continuation_remote_contract_store_2
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-h4-remote-01` | `V3RemoteContinuationCommitInput` → `V3RemoteContinuationLocator` | anchored | direct_remote_locator_round_trips_for_same_entry_scope_and_pin<br/><small>routecodex-v3-runtime/tests/h4_remote_continuation_contract.rs</small> | V3RemoteContinuationStore::commit<br/><small>routecodex-v3-runtime/src/remote_continuation.rs</small> | `v3.remote_continuation_contract_store` |
| `v3-h4-remote-02` | `V3RemoteContinuationLoadRequest` → `V3RemoteContinuationLocator` | anchored | direct_remote_locator_round_trips_for_same_entry_scope_and_pin<br/><small>routecodex-v3-runtime/tests/h4_remote_continuation_contract.rs</small> | V3RemoteContinuationStore::load<br/><small>routecodex-v3-runtime/src/remote_continuation.rs</small> | `v3.remote_continuation_contract_store` |

## v3.responses_continuation.remote_locator_codec

H4 lossless locator-only codec. Unknown local context/history/tool-state fields fail decoding.

Owner feature: `v3.remote_continuation_contract_store`

```mermaid
flowchart TD
  subgraph c_30_v3_responses_continuation_remote_locator_codec_m_v3_runtime["v3-runtime"]
    c_30_v3_responses_continuation_remote_locator_codec_0["v3-runtime<br/>direct_remote_locator_round_trips_for_same_entry_scope_and_pin<br/><small>routecodex-v3-runtime/tests/h4_remote_continuation_contract.rs</small>"]
    c_30_v3_responses_continuation_remote_locator_codec_1["v3-runtime<br/>encode_v3_remote_continuation_locator<br/><small>routecodex-v3-runtime/src/remote_continuation.rs</small>"]
    c_30_v3_responses_continuation_remote_locator_codec_2["v3-runtime<br/>decode_v3_remote_continuation_locator<br/><small>routecodex-v3-runtime/src/remote_continuation.rs</small>"]
  end
  c_30_v3_responses_continuation_remote_locator_codec_0 -->|v3-h4-codec-01<br/>V3RemoteContinuationLocator → V3RemoteContinuationLocatorEncoded| c_30_v3_responses_continuation_remote_locator_codec_1
  c_30_v3_responses_continuation_remote_locator_codec_0 -->|v3-h4-codec-02<br/>V3RemoteContinuationLocatorEncoded → V3RemoteContinuationLocator| c_30_v3_responses_continuation_remote_locator_codec_2
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-h4-codec-01` | `V3RemoteContinuationLocator` → `V3RemoteContinuationLocatorEncoded` | anchored | direct_remote_locator_round_trips_for_same_entry_scope_and_pin<br/><small>routecodex-v3-runtime/tests/h4_remote_continuation_contract.rs</small> | encode_v3_remote_continuation_locator<br/><small>routecodex-v3-runtime/src/remote_continuation.rs</small> | `v3.remote_continuation_contract_store` |
| `v3-h4-codec-02` | `V3RemoteContinuationLocatorEncoded` → `V3RemoteContinuationLocator` | anchored | direct_remote_locator_round_trips_for_same_entry_scope_and_pin<br/><small>routecodex-v3-runtime/tests/h4_remote_continuation_contract.rs</small> | decode_v3_remote_continuation_locator<br/><small>routecodex-v3-runtime/src/remote_continuation.rs</small> | `v3.remote_continuation_contract_store` |

## v3.responses_direct.remote_continuation.integration

Responses Direct remote continuation commits provider-owned identity at Resp04; next Req03 first resolves previous_response_id owner from direct remote vs relay local stores, then direct-owned ids load scope and exact-pin provider/model/auth at Req06. Continuation owner selection is not a Target model capability.

Owner feature: `v3.responses_direct_remote_continuation_integration`

```mermaid
flowchart TD
  subgraph c_31_v3_responses_direct_remote_continuation_integration_m_v3_provider_responses["v3-provider-responses"]
    c_31_v3_responses_direct_remote_continuation_integration_5["v3-provider-responses<br/>build_v3_transport_13_responses_request_from_v3_provider_12<br/><small>routecodex-v3-provider-responses/src/transport.rs</small>"]
  end
  subgraph c_31_v3_responses_direct_remote_continuation_integration_m_v3_runtime["v3-runtime"]
    c_31_v3_responses_direct_remote_continuation_integration_1["v3-runtime<br/>resolve_v3_responses_previous_response_owner_execution_mode_at_req03<br/><small>routecodex-v3-runtime/src/responses_continuation_owner.rs</small>"]
    c_31_v3_responses_direct_remote_continuation_integration_2["v3-runtime<br/>execute_v3_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel/v3_direct_core.rs</small>"]
    c_31_v3_responses_direct_remote_continuation_integration_4["v3-runtime<br/>responses_direct_provider_transport_hook<br/><small>routecodex-v3-runtime/src/hooks.rs</small>"]
    c_31_v3_responses_direct_remote_continuation_integration_6["v3-runtime<br/>responses_direct_response_projection_hook_with_context<br/><small>routecodex-v3-runtime/src/hooks.rs</small>"]
    c_31_v3_responses_direct_remote_continuation_integration_7["v3-runtime<br/>execute_v3_responses_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel.rs</small>"]
    c_31_v3_responses_direct_remote_continuation_integration_8["v3-runtime<br/>V3RemoteContinuationStore::commit<br/><small>routecodex-v3-runtime/src/remote_continuation.rs</small>"]
    c_31_v3_responses_direct_remote_continuation_integration_9["v3-runtime<br/>V3ResponsesDirectRuntimeOutput<br/><small>routecodex-v3-runtime/src/kernel.rs</small>"]
  end
  subgraph c_31_v3_responses_direct_remote_continuation_integration_m_v3_server["v3-server"]
    c_31_v3_responses_direct_remote_continuation_integration_0["v3-server<br/>pending_endpoint<br/><small>routecodex-v3-server/src/endpoint_handlers.rs</small>"]
  end
  subgraph c_31_v3_responses_direct_remote_continuation_integration_m_v3_target["v3-target"]
    c_31_v3_responses_direct_remote_continuation_integration_3["v3-target<br/>V3TargetInterpreter::resolve_exact_provider_model_auth<br/><small>routecodex-v3-target/src/lib.rs</small>"]
  end
  c_31_v3_responses_direct_remote_continuation_integration_0 -->|v3-rci-01<br/>V3Server03HttpRequestRaw → V3HubReqContinuation03Classified| c_31_v3_responses_direct_remote_continuation_integration_1
  c_31_v3_responses_direct_remote_continuation_integration_2 -->|v3-rci-02<br/>V3HubReqContinuation03Classified → V3HubReqTarget06Resolved| c_31_v3_responses_direct_remote_continuation_integration_3
  c_31_v3_responses_direct_remote_continuation_integration_4 -->|v3-rci-ws-01<br/>V3HubReqTarget06Resolved → V3Transport13ResponsesHttpRequest| c_31_v3_responses_direct_remote_continuation_integration_5
  c_31_v3_responses_direct_remote_continuation_integration_2 -->|v3-rci-03<br/>V3ProviderResp14Raw → V3DirectResp14ProviderProjectionPrepared| c_31_v3_responses_direct_remote_continuation_integration_6
  c_31_v3_responses_direct_remote_continuation_integration_7 -->|v3-rci-04<br/>V3DirectResp14ProviderProjectionPrepared → V3HubRespContinuation04Committed| c_31_v3_responses_direct_remote_continuation_integration_8
  c_31_v3_responses_direct_remote_continuation_integration_7 -->|v3-rci-05<br/>V3HubRespContinuation04Committed → V3DirectResp15ClientPayloadReady| c_31_v3_responses_direct_remote_continuation_integration_9
  c_31_v3_responses_direct_remote_continuation_integration_7 -->|v3-rci-06<br/>V3DirectResp15ClientPayloadReady → V3Resp15ClientPayload| c_31_v3_responses_direct_remote_continuation_integration_9
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-rci-01` | `V3Server03HttpRequestRaw` → `V3HubReqContinuation03Classified` | anchored | pending_endpoint<br/><small>routecodex-v3-server/src/endpoint_handlers.rs</small> | resolve_v3_responses_previous_response_owner_execution_mode_at_req03<br/><small>routecodex-v3-runtime/src/responses_continuation_owner.rs</small> | `v3.responses_direct_remote_continuation_integration` |
| `v3-rci-02` | `V3HubReqContinuation03Classified` → `V3HubReqTarget06Resolved` | anchored | execute_v3_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel/v3_direct_core.rs</small> | V3TargetInterpreter::resolve_exact_provider_model_auth<br/><small>routecodex-v3-target/src/lib.rs</small> | `v3.responses_direct_remote_continuation_integration` |
| `v3-rci-ws-01` | `V3HubReqTarget06Resolved` → `V3Transport13ResponsesHttpRequest` | anchored | responses_direct_provider_transport_hook<br/><small>routecodex-v3-runtime/src/hooks.rs</small> | build_v3_transport_13_responses_request_from_v3_provider_12<br/><small>routecodex-v3-provider-responses/src/transport.rs</small> | `v3.responses_direct_remote_continuation_integration` |
| `v3-rci-03` | `V3ProviderResp14Raw` → `V3DirectResp14ProviderProjectionPrepared` | anchored | execute_v3_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel/v3_direct_core.rs</small> | responses_direct_response_projection_hook_with_context<br/><small>routecodex-v3-runtime/src/hooks.rs</small> | `v3.responses_direct_remote_continuation_integration` |
| `v3-rci-04` | `V3DirectResp14ProviderProjectionPrepared` → `V3HubRespContinuation04Committed` | anchored | execute_v3_responses_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | V3RemoteContinuationStore::commit<br/><small>routecodex-v3-runtime/src/remote_continuation.rs</small> | `v3.responses_direct_remote_continuation_integration` |
| `v3-rci-05` | `V3HubRespContinuation04Committed` → `V3DirectResp15ClientPayloadReady` | anchored | execute_v3_responses_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | V3ResponsesDirectRuntimeOutput<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | `v3.responses_direct_remote_continuation_integration` |
| `v3-rci-06` | `V3DirectResp15ClientPayloadReady` → `V3Resp15ClientPayload` | anchored | execute_v3_responses_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | V3ResponsesDirectRuntimeOutput<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | `v3.responses_direct_remote_continuation_integration` |

## v3.anthropic_relay.controlled_runtime

Controlled Anthropic /v1/messages Relay request through the sole Hub v1 lifecycle, generic Responses transport, Error01-06, and the sole Anthropic client projection exit.

Owner feature: `v3.anthropic_relay_runtime_integration`

```mermaid
flowchart TD
  subgraph c_32_v3_anthropic_relay_controlled_runtime_m_v3_provider_responses["v3-provider-responses"]
    c_32_v3_anthropic_relay_controlled_runtime_13["v3-provider-responses<br/>ResponsesTransport::send<br/><small>routecodex-v3-provider-responses/src/transport.rs</small>"]
  end
  subgraph c_32_v3_anthropic_relay_controlled_runtime_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_32_v3_anthropic_relay_controlled_runtime_1["v3-runtime::hub_v1<br/>execute_v3_anthropic_relay_runtime_with_default_transport<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small>"]
    c_32_v3_anthropic_relay_controlled_runtime_2["v3-runtime::hub_v1<br/>execute_v3_anthropic_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small>"]
    c_32_v3_anthropic_relay_controlled_runtime_3["v3-runtime::hub_v1<br/>run_v3_anthropic_relay_runtime_req_inbound<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_hooks.rs</small>"]
    c_32_v3_anthropic_relay_controlled_runtime_4["v3-runtime::hub_v1<br/>V3HubRelayRequestHooks::run_from_normalized_with_events<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small>"]
    c_32_v3_anthropic_relay_controlled_runtime_5["v3-runtime::hub_v1<br/>build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02<br/><small>routecodex-v3-runtime/src/hub_v1/req_continuation_03_classified.rs</small>"]
    c_32_v3_anthropic_relay_controlled_runtime_6["v3-runtime::hub_v1<br/>build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03<br/><small>routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs</small>"]
    c_32_v3_anthropic_relay_controlled_runtime_7["v3-runtime::hub_v1<br/>build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04<br/><small>routecodex-v3-runtime/src/hub_v1/req_execution_05_planned.rs</small>"]
    c_32_v3_anthropic_relay_controlled_runtime_8["v3-runtime::hub_v1<br/>build_v3_hub_req_target_06_from_v3_hub_req_execution_05<br/><small>routecodex-v3-runtime/src/hub_v1/req_target_06_resolved.rs</small>"]
    c_32_v3_anthropic_relay_controlled_runtime_9["v3-runtime::hub_v1<br/>build_v3_hub_req_outbound_07_from_v3_hub_req_target_06<br/><small>routecodex-v3-runtime/src/hub_v1/req_outbound_07_provider_semantic.rs</small>"]
    c_32_v3_anthropic_relay_controlled_runtime_10["v3-runtime::hub_v1<br/>build_provider_req_compat_06_from_v3_hub_req_outbound_07<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs</small>"]
    c_32_v3_anthropic_relay_controlled_runtime_11["v3-runtime::hub_v1<br/>build_v3_provider_req_outbound_08_from_provider_req_compat_06<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_outbound_08_wire_payload.rs</small>"]
    c_32_v3_anthropic_relay_controlled_runtime_12["v3-runtime::hub_v1<br/>build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_outbound_09_transport_request.rs</small>"]
    c_32_v3_anthropic_relay_controlled_runtime_14["v3-runtime::hub_v1<br/>build_provider_resp_compat_02_from_v3_provider_resp_inbound_01<br/><small>routecodex-v3-runtime/src/hub_v1/provider_resp_compat_02_provider_compat.rs</small>"]
    c_32_v3_anthropic_relay_controlled_runtime_15["v3-runtime::hub_v1<br/>build_v3_hub_resp_inbound_02_from_provider_resp_compat_02<br/><small>routecodex-v3-runtime/src/hub_v1/resp_inbound_02_normalized.rs</small>"]
    c_32_v3_anthropic_relay_controlled_runtime_16["v3-runtime::hub_v1<br/>V3HubRelayResponseHookRegistry::govern<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
    c_32_v3_anthropic_relay_controlled_runtime_17["v3-runtime::hub_v1<br/>V3HubRelayResponseHookRegistry::commit<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
    c_32_v3_anthropic_relay_controlled_runtime_18["v3-runtime::hub_v1<br/>build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04<br/><small>routecodex-v3-runtime/src/hub_v1/resp_outbound_05_client_semantic.rs</small>"]
    c_32_v3_anthropic_relay_controlled_runtime_19["v3-runtime::hub_v1<br/>build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05<br/><small>routecodex-v3-runtime/src/hub_v1/server_resp_outbound_06_client_frame.rs</small>"]
  end
  subgraph c_32_v3_anthropic_relay_controlled_runtime_m_v3_server["v3-server"]
    c_32_v3_anthropic_relay_controlled_runtime_0["v3-server<br/>execute_v3_anthropic_messages_request<br/><small>routecodex-v3-server/src/executors.rs</small>"]
  end
  c_32_v3_anthropic_relay_controlled_runtime_0 -->|v3-anthropic-relay-01<br/>V3ServerValidatedMessagesRequest → V3HubReqInbound01ClientRaw| c_32_v3_anthropic_relay_controlled_runtime_1
  c_32_v3_anthropic_relay_controlled_runtime_2 -->|v3-anthropic-relay-02<br/>V3HubReqInbound01ClientRaw → V3HubReqInbound02Normalized| c_32_v3_anthropic_relay_controlled_runtime_3
  c_32_v3_anthropic_relay_controlled_runtime_4 -->|v3-anthropic-relay-03<br/>V3HubReqInbound02Normalized → V3HubReqContinuation03Classified| c_32_v3_anthropic_relay_controlled_runtime_5
  c_32_v3_anthropic_relay_controlled_runtime_4 -->|v3-anthropic-relay-04<br/>V3HubReqContinuation03Classified → V3HubReqChatProcess04Governed| c_32_v3_anthropic_relay_controlled_runtime_6
  c_32_v3_anthropic_relay_controlled_runtime_2 -->|v3-anthropic-relay-05<br/>V3HubReqChatProcess04Governed → V3HubReqExecution05Planned| c_32_v3_anthropic_relay_controlled_runtime_7
  c_32_v3_anthropic_relay_controlled_runtime_2 -->|v3-anthropic-relay-06<br/>V3HubReqExecution05Planned → V3HubReqTarget06Resolved| c_32_v3_anthropic_relay_controlled_runtime_8
  c_32_v3_anthropic_relay_controlled_runtime_2 -->|v3-anthropic-relay-07<br/>V3HubReqTarget06Resolved → V3HubReqOutbound07ProviderSemantic| c_32_v3_anthropic_relay_controlled_runtime_9
  c_32_v3_anthropic_relay_controlled_runtime_2 -->|v3-anthropic-relay-08<br/>V3HubReqOutbound07ProviderSemantic → ProviderReqCompat06ProviderCompat| c_32_v3_anthropic_relay_controlled_runtime_10
  c_32_v3_anthropic_relay_controlled_runtime_2 -->|v3-anthropic-relay-09<br/>ProviderReqCompat06ProviderCompat → V3ProviderReqOutbound08WirePayload| c_32_v3_anthropic_relay_controlled_runtime_11
  c_32_v3_anthropic_relay_controlled_runtime_2 -->|v3-anthropic-relay-10<br/>V3ProviderReqOutbound08WirePayload → V3ProviderReqOutbound09TransportRequest| c_32_v3_anthropic_relay_controlled_runtime_12
  c_32_v3_anthropic_relay_controlled_runtime_2 -->|v3-anthropic-relay-11<br/>V3ProviderReqOutbound09TransportRequest → V3ProviderRespInbound01Raw| c_32_v3_anthropic_relay_controlled_runtime_13
  c_32_v3_anthropic_relay_controlled_runtime_2 -->|v3-anthropic-relay-12<br/>V3ProviderRespInbound01Raw → ProviderRespCompat02ProviderCompat| c_32_v3_anthropic_relay_controlled_runtime_14
  c_32_v3_anthropic_relay_controlled_runtime_2 -->|v3-anthropic-relay-13<br/>ProviderRespCompat02ProviderCompat → V3HubRespInbound02Normalized| c_32_v3_anthropic_relay_controlled_runtime_15
  c_32_v3_anthropic_relay_controlled_runtime_2 -->|v3-anthropic-relay-14<br/>V3HubRespInbound02Normalized → V3HubRespChatProcess03Governed| c_32_v3_anthropic_relay_controlled_runtime_16
  c_32_v3_anthropic_relay_controlled_runtime_2 -->|v3-anthropic-relay-15<br/>V3HubRespChatProcess03Governed → V3HubRespContinuation04Committed| c_32_v3_anthropic_relay_controlled_runtime_17
  c_32_v3_anthropic_relay_controlled_runtime_2 -->|v3-anthropic-relay-16<br/>V3HubRespContinuation04Committed → V3HubRespOutbound05ClientSemantic| c_32_v3_anthropic_relay_controlled_runtime_18
  c_32_v3_anthropic_relay_controlled_runtime_2 -->|v3-anthropic-relay-17<br/>V3HubRespOutbound05ClientSemantic → V3ServerRespOutbound06ClientFrame| c_32_v3_anthropic_relay_controlled_runtime_19
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-anthropic-relay-01` | `V3ServerValidatedMessagesRequest` → `V3HubReqInbound01ClientRaw` | anchored | execute_v3_anthropic_messages_request<br/><small>routecodex-v3-server/src/executors.rs</small> | execute_v3_anthropic_relay_runtime_with_default_transport<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | `v3.anthropic_relay_runtime_integration` |
| `v3-anthropic-relay-02` | `V3HubReqInbound01ClientRaw` → `V3HubReqInbound02Normalized` | anchored | execute_v3_anthropic_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | run_v3_anthropic_relay_runtime_req_inbound<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_hooks.rs</small> | `v3.anthropic_relay_runtime_integration` |
| `v3-anthropic-relay-03` | `V3HubReqInbound02Normalized` → `V3HubReqContinuation03Classified` | anchored | V3HubRelayRequestHooks::run_from_normalized_with_events<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small> | build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02<br/><small>routecodex-v3-runtime/src/hub_v1/req_continuation_03_classified.rs</small> | `v3.anthropic_relay_runtime_integration` |
| `v3-anthropic-relay-04` | `V3HubReqContinuation03Classified` → `V3HubReqChatProcess04Governed` | anchored | V3HubRelayRequestHooks::run_from_normalized_with_events<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small> | build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03<br/><small>routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs</small> | `v3.anthropic_relay_runtime_integration` |
| `v3-anthropic-relay-05` | `V3HubReqChatProcess04Governed` → `V3HubReqExecution05Planned` | anchored | execute_v3_anthropic_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04<br/><small>routecodex-v3-runtime/src/hub_v1/req_execution_05_planned.rs</small> | `v3.anthropic_relay_runtime_integration` |
| `v3-anthropic-relay-06` | `V3HubReqExecution05Planned` → `V3HubReqTarget06Resolved` | anchored | execute_v3_anthropic_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | build_v3_hub_req_target_06_from_v3_hub_req_execution_05<br/><small>routecodex-v3-runtime/src/hub_v1/req_target_06_resolved.rs</small> | `v3.anthropic_relay_runtime_integration` |
| `v3-anthropic-relay-07` | `V3HubReqTarget06Resolved` → `V3HubReqOutbound07ProviderSemantic` | anchored | execute_v3_anthropic_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | build_v3_hub_req_outbound_07_from_v3_hub_req_target_06<br/><small>routecodex-v3-runtime/src/hub_v1/req_outbound_07_provider_semantic.rs</small> | `v3.anthropic_relay_runtime_integration` |
| `v3-anthropic-relay-08` | `V3HubReqOutbound07ProviderSemantic` → `ProviderReqCompat06ProviderCompat` | anchored | execute_v3_anthropic_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | build_provider_req_compat_06_from_v3_hub_req_outbound_07<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs</small> | `v3.anthropic_relay_runtime_integration` |
| `v3-anthropic-relay-09` | `ProviderReqCompat06ProviderCompat` → `V3ProviderReqOutbound08WirePayload` | anchored | execute_v3_anthropic_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | build_v3_provider_req_outbound_08_from_provider_req_compat_06<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_outbound_08_wire_payload.rs</small> | `v3.anthropic_relay_runtime_integration` |
| `v3-anthropic-relay-10` | `V3ProviderReqOutbound08WirePayload` → `V3ProviderReqOutbound09TransportRequest` | anchored | execute_v3_anthropic_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_outbound_09_transport_request.rs</small> | `v3.anthropic_relay_runtime_integration` |
| `v3-anthropic-relay-11` | `V3ProviderReqOutbound09TransportRequest` → `V3ProviderRespInbound01Raw` | anchored | execute_v3_anthropic_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | ResponsesTransport::send<br/><small>routecodex-v3-provider-responses/src/transport.rs</small> | `v3.anthropic_relay_runtime_integration` |
| `v3-anthropic-relay-12` | `V3ProviderRespInbound01Raw` → `ProviderRespCompat02ProviderCompat` | anchored | execute_v3_anthropic_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | build_provider_resp_compat_02_from_v3_provider_resp_inbound_01<br/><small>routecodex-v3-runtime/src/hub_v1/provider_resp_compat_02_provider_compat.rs</small> | `v3.anthropic_relay_runtime_integration` |
| `v3-anthropic-relay-13` | `ProviderRespCompat02ProviderCompat` → `V3HubRespInbound02Normalized` | anchored | execute_v3_anthropic_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | build_v3_hub_resp_inbound_02_from_provider_resp_compat_02<br/><small>routecodex-v3-runtime/src/hub_v1/resp_inbound_02_normalized.rs</small> | `v3.anthropic_relay_runtime_integration` |
| `v3-anthropic-relay-14` | `V3HubRespInbound02Normalized` → `V3HubRespChatProcess03Governed` | anchored | execute_v3_anthropic_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | V3HubRelayResponseHookRegistry::govern<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | `v3.anthropic_relay_runtime_integration` |
| `v3-anthropic-relay-15` | `V3HubRespChatProcess03Governed` → `V3HubRespContinuation04Committed` | anchored | execute_v3_anthropic_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | V3HubRelayResponseHookRegistry::commit<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | `v3.anthropic_relay_runtime_integration` |
| `v3-anthropic-relay-16` | `V3HubRespContinuation04Committed` → `V3HubRespOutbound05ClientSemantic` | anchored | execute_v3_anthropic_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04<br/><small>routecodex-v3-runtime/src/hub_v1/resp_outbound_05_client_semantic.rs</small> | `v3.anthropic_relay_runtime_integration` |
| `v3-anthropic-relay-17` | `V3HubRespOutbound05ClientSemantic` → `V3ServerRespOutbound06ClientFrame` | anchored | execute_v3_anthropic_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05<br/><small>routecodex-v3-runtime/src/hub_v1/server_resp_outbound_06_client_frame.rs</small> | `v3.anthropic_relay_runtime_integration` |

## v3.responses.websocket_v2.transport_hardening

Provider-owned Responses WebSocket mode request/session lifecycle; RouteCodex internal transport name is websocket_v2, handshake sends OpenAI-Beta responses_websockets=2026-02-06, same-stream WebSocket event aggregation is limited to producing V3ProviderResp14Raw, and only terminal drain permits exact-session reuse while early drop, error, disconnect, and protocol failure discard the connection.

Owner feature: `v3.responses_websocket_v2_transport_hardening`

```mermaid
flowchart TD
  subgraph c_33_v3_responses_websocket_v2_transport_hardening_m_v3_provider_responses["v3-provider-responses"]
    c_33_v3_responses_websocket_v2_transport_hardening_0["v3-provider-responses<br/>ResponsesTransport::send<br/><small>routecodex-v3-provider-responses/src/transport.rs</small>"]
    c_33_v3_responses_websocket_v2_transport_hardening_1["v3-provider-responses<br/>ProviderResponsesTransport::send_websocket_v2<br/><small>routecodex-v3-provider-responses/src/transport.rs</small>"]
    c_33_v3_responses_websocket_v2_transport_hardening_2["v3-provider-responses<br/>websocket_sse_stream<br/><small>routecodex-v3-provider-responses/src/transport/websocket.rs</small>"]
  end
  c_33_v3_responses_websocket_v2_transport_hardening_0 -->|v3-ws2-01<br/>V3Transport13ResponsesRequest → V3ProviderResponsesWebSocketSession| c_33_v3_responses_websocket_v2_transport_hardening_1
  c_33_v3_responses_websocket_v2_transport_hardening_1 -->|v3-ws2-02<br/>V3ProviderResponsesWebSocketSession → V3ProviderResp14Raw| c_33_v3_responses_websocket_v2_transport_hardening_2
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-ws2-01` | `V3Transport13ResponsesRequest` → `V3ProviderResponsesWebSocketSession` | anchored | ResponsesTransport::send<br/><small>routecodex-v3-provider-responses/src/transport.rs</small> | ProviderResponsesTransport::send_websocket_v2<br/><small>routecodex-v3-provider-responses/src/transport.rs</small> | `v3.responses_websocket_v2_transport_hardening` |
| `v3-ws2-02` | `V3ProviderResponsesWebSocketSession` → `V3ProviderResp14Raw` | anchored | ProviderResponsesTransport::send_websocket_v2<br/><small>routecodex-v3-provider-responses/src/transport.rs</small> | websocket_sse_stream<br/><small>routecodex-v3-provider-responses/src/transport/websocket.rs</small> | `v3.responses_websocket_v2_transport_hardening` |

## v3.anthropic_relay.local_continuation

Resp04 local canonical save through the immutable interval to next Req04 exact-scope restore and governance.

Owner feature: `v3.anthropic_relay_local_continuation_integration`

```mermaid
flowchart TD
  subgraph c_34_v3_anthropic_relay_local_continuation_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_34_v3_anthropic_relay_local_continuation_0["v3-runtime::hub_v1<br/>execute_v3_anthropic_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small>"]
    c_34_v3_anthropic_relay_local_continuation_1["v3-runtime::hub_v1<br/>commit_or_release_local_continuation<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small>"]
    c_34_v3_anthropic_relay_local_continuation_2["v3-runtime::hub_v1<br/>V3HubContinuationLookup::with_local_context_from_req04_store<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small>"]
    c_34_v3_anthropic_relay_local_continuation_3["v3-runtime::hub_v1<br/>V3HubRelayRequestHooks::run_from_normalized<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small>"]
    c_34_v3_anthropic_relay_local_continuation_4["v3-runtime::hub_v1<br/>merge_v3_relay_restored_local_context_at_req04<br/><small>routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs</small>"]
  end
  c_34_v3_anthropic_relay_local_continuation_0 -->|v3-localcont-01<br/>V3LocalContResp01ChatProcessGoverned → V3LocalContResp02ImmutableSaved| c_34_v3_anthropic_relay_local_continuation_1
  c_34_v3_anthropic_relay_local_continuation_0 -->|v3-localcont-02<br/>V3LocalContResp02ImmutableSaved → V3LocalContReq03ExactScopeLoaded| c_34_v3_anthropic_relay_local_continuation_2
  c_34_v3_anthropic_relay_local_continuation_3 -->|v3-localcont-03<br/>V3LocalContReq03ExactScopeLoaded → V3LocalContReq04RestoredGoverned| c_34_v3_anthropic_relay_local_continuation_4
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-localcont-01` | `V3LocalContResp01ChatProcessGoverned` → `V3LocalContResp02ImmutableSaved` | anchored | execute_v3_anthropic_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | commit_or_release_local_continuation<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | `v3.anthropic_relay_local_continuation_integration` |
| `v3-localcont-02` | `V3LocalContResp02ImmutableSaved` → `V3LocalContReq03ExactScopeLoaded` | anchored | execute_v3_anthropic_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | V3HubContinuationLookup::with_local_context_from_req04_store<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small> | `v3.anthropic_relay_local_continuation_integration` |
| `v3-localcont-03` | `V3LocalContReq03ExactScopeLoaded` → `V3LocalContReq04RestoredGoverned` | anchored | V3HubRelayRequestHooks::run_from_normalized<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small> | merge_v3_relay_restored_local_context_at_req04<br/><small>routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs</small> | `v3.anthropic_relay_local_continuation_integration` |

## v3.openai_chat_relay.controlled_runtime

Controlled /v1/chat/completions Relay through the sole Hub v1 request/response lifecycle; SSE is incrementally projected by Runtime and transported by Server without materialization.

Owner feature: `v3.openai_chat_relay_runtime_integration`
Manifest: `docs/architecture/manifests/v3.openai_chat_relay.controlled_runtime.mainline.yml`

```mermaid
flowchart TD
  subgraph c_35_v3_openai_chat_relay_controlled_runtime_m_v3_provider_responses["v3-provider-responses"]
    c_35_v3_openai_chat_relay_controlled_runtime_13["v3-provider-responses<br/>ResponsesTransport::send<br/><small>routecodex-v3-provider-responses/src/transport.rs</small>"]
  end
  subgraph c_35_v3_openai_chat_relay_controlled_runtime_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_35_v3_openai_chat_relay_controlled_runtime_1["v3-runtime::hub_v1<br/>execute_v3_openai_chat_relay_runtime_with_default_transport<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small>"]
    c_35_v3_openai_chat_relay_controlled_runtime_2["v3-runtime::hub_v1<br/>execute_v3_openai_chat_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small>"]
    c_35_v3_openai_chat_relay_controlled_runtime_3["v3-runtime::hub_v1<br/>build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01<br/><small>routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs</small>"]
    c_35_v3_openai_chat_relay_controlled_runtime_4["v3-runtime::hub_v1<br/>V3HubRelayRequestHooks::run_from_normalized<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small>"]
    c_35_v3_openai_chat_relay_controlled_runtime_5["v3-runtime::hub_v1<br/>build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02<br/><small>routecodex-v3-runtime/src/hub_v1/req_continuation_03_classified.rs</small>"]
    c_35_v3_openai_chat_relay_controlled_runtime_6["v3-runtime::hub_v1<br/>build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03<br/><small>routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs</small>"]
    c_35_v3_openai_chat_relay_controlled_runtime_7["v3-runtime::hub_v1<br/>build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04<br/><small>routecodex-v3-runtime/src/hub_v1/req_execution_05_planned.rs</small>"]
    c_35_v3_openai_chat_relay_controlled_runtime_8["v3-runtime::hub_v1<br/>build_v3_hub_req_target_06_from_v3_hub_req_execution_05<br/><small>routecodex-v3-runtime/src/hub_v1/req_target_06_resolved.rs</small>"]
    c_35_v3_openai_chat_relay_controlled_runtime_9["v3-runtime::hub_v1<br/>build_v3_hub_req_outbound_07_from_v3_hub_req_target_06<br/><small>routecodex-v3-runtime/src/hub_v1/req_outbound_07_provider_semantic.rs</small>"]
    c_35_v3_openai_chat_relay_controlled_runtime_10["v3-runtime::hub_v1<br/>build_provider_req_compat_06_from_v3_hub_req_outbound_07<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs</small>"]
    c_35_v3_openai_chat_relay_controlled_runtime_11["v3-runtime::hub_v1<br/>build_v3_provider_req_outbound_08_from_provider_req_compat_06<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_outbound_08_wire_payload.rs</small>"]
    c_35_v3_openai_chat_relay_controlled_runtime_12["v3-runtime::hub_v1<br/>build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_outbound_09_transport_request.rs</small>"]
    c_35_v3_openai_chat_relay_controlled_runtime_14["v3-runtime::hub_v1<br/>project_json_response<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small>"]
    c_35_v3_openai_chat_relay_controlled_runtime_15["v3-runtime::hub_v1<br/>build_provider_resp_compat_02_from_v3_provider_resp_inbound_01<br/><small>routecodex-v3-runtime/src/hub_v1/provider_resp_compat_02_provider_compat.rs</small>"]
    c_35_v3_openai_chat_relay_controlled_runtime_16["v3-runtime::hub_v1<br/>build_v3_hub_resp_inbound_02_from_provider_resp_compat_02<br/><small>routecodex-v3-runtime/src/hub_v1/resp_inbound_02_normalized.rs</small>"]
    c_35_v3_openai_chat_relay_controlled_runtime_17["v3-runtime::hub_v1<br/>V3HubRelayResponseHookRegistry::govern<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
    c_35_v3_openai_chat_relay_controlled_runtime_18["v3-runtime::hub_v1<br/>V3HubRelayResponseHookRegistry::commit<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
    c_35_v3_openai_chat_relay_controlled_runtime_19["v3-runtime::hub_v1<br/>build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04<br/><small>routecodex-v3-runtime/src/hub_v1/resp_outbound_05_client_semantic.rs</small>"]
  end
  subgraph c_35_v3_openai_chat_relay_controlled_runtime_m_v3_server["v3-server"]
    c_35_v3_openai_chat_relay_controlled_runtime_0["v3-server<br/>execute_v3_openai_chat_completions_request<br/><small>routecodex-v3-server/src/executors.rs</small>"]
    c_35_v3_openai_chat_relay_controlled_runtime_20["v3-server<br/>openai_chat_relay_output_response<br/><small>routecodex-v3-server/src/executors.rs</small>"]
    c_35_v3_openai_chat_relay_controlled_runtime_21["v3-server<br/>Body::from_stream<br/><small>routecodex-v3-server/src/executors.rs</small>"]
  end
  c_35_v3_openai_chat_relay_controlled_runtime_0 -->|v3-openai-chat-relay-01<br/>V3OpenAiChatRelayRuntimeInput → V3HubReqInbound01ClientRaw| c_35_v3_openai_chat_relay_controlled_runtime_1
  c_35_v3_openai_chat_relay_controlled_runtime_2 -->|v3-openai-chat-relay-02<br/>V3HubReqInbound01ClientRaw → V3HubReqInbound02Normalized| c_35_v3_openai_chat_relay_controlled_runtime_3
  c_35_v3_openai_chat_relay_controlled_runtime_4 -->|v3-openai-chat-relay-03<br/>V3HubReqInbound02Normalized → V3HubReqContinuation03Classified| c_35_v3_openai_chat_relay_controlled_runtime_5
  c_35_v3_openai_chat_relay_controlled_runtime_4 -->|v3-openai-chat-relay-04<br/>V3HubReqContinuation03Classified → V3HubReqChatProcess04Governed| c_35_v3_openai_chat_relay_controlled_runtime_6
  c_35_v3_openai_chat_relay_controlled_runtime_2 -->|v3-openai-chat-relay-05<br/>V3HubReqChatProcess04Governed → V3HubReqExecution05Planned| c_35_v3_openai_chat_relay_controlled_runtime_7
  c_35_v3_openai_chat_relay_controlled_runtime_2 -->|v3-openai-chat-relay-06<br/>V3HubReqExecution05Planned → V3HubReqTarget06Resolved| c_35_v3_openai_chat_relay_controlled_runtime_8
  c_35_v3_openai_chat_relay_controlled_runtime_2 -->|v3-openai-chat-relay-07<br/>V3HubReqTarget06Resolved → V3HubReqOutbound07ProviderSemantic| c_35_v3_openai_chat_relay_controlled_runtime_9
  c_35_v3_openai_chat_relay_controlled_runtime_2 -->|v3-openai-chat-relay-08<br/>V3HubReqOutbound07ProviderSemantic → ProviderReqCompat06ProviderCompat| c_35_v3_openai_chat_relay_controlled_runtime_10
  c_35_v3_openai_chat_relay_controlled_runtime_2 -->|v3-openai-chat-relay-09<br/>ProviderReqCompat06ProviderCompat → V3ProviderReqOutbound08WirePayload| c_35_v3_openai_chat_relay_controlled_runtime_11
  c_35_v3_openai_chat_relay_controlled_runtime_2 -->|v3-openai-chat-relay-10<br/>V3ProviderReqOutbound08WirePayload → V3ProviderReqOutbound09TransportRequest| c_35_v3_openai_chat_relay_controlled_runtime_12
  c_35_v3_openai_chat_relay_controlled_runtime_2 -->|v3-openai-chat-relay-11<br/>V3ProviderReqOutbound09TransportRequest → V3ProviderRespInbound01Raw| c_35_v3_openai_chat_relay_controlled_runtime_13
  c_35_v3_openai_chat_relay_controlled_runtime_14 -->|v3-openai-chat-relay-12<br/>V3ProviderRespInbound01Raw → ProviderRespCompat02ProviderCompat| c_35_v3_openai_chat_relay_controlled_runtime_15
  c_35_v3_openai_chat_relay_controlled_runtime_14 -->|v3-openai-chat-relay-13<br/>ProviderRespCompat02ProviderCompat → V3HubRespInbound02Normalized| c_35_v3_openai_chat_relay_controlled_runtime_16
  c_35_v3_openai_chat_relay_controlled_runtime_14 -->|v3-openai-chat-relay-14<br/>V3HubRespInbound02Normalized → V3HubRespChatProcess03Governed| c_35_v3_openai_chat_relay_controlled_runtime_17
  c_35_v3_openai_chat_relay_controlled_runtime_14 -->|v3-openai-chat-relay-15<br/>V3HubRespChatProcess03Governed → V3HubRespContinuation04Committed| c_35_v3_openai_chat_relay_controlled_runtime_18
  c_35_v3_openai_chat_relay_controlled_runtime_14 -->|v3-openai-chat-relay-16<br/>V3HubRespContinuation04Committed → V3HubRespOutbound05ClientSemantic| c_35_v3_openai_chat_relay_controlled_runtime_19
  c_35_v3_openai_chat_relay_controlled_runtime_20 -->|v3-openai-chat-relay-17<br/>V3HubRespOutbound05ClientSemantic → V3ServerRespOutbound06ClientFrame| c_35_v3_openai_chat_relay_controlled_runtime_21
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-openai-chat-relay-01` | `V3OpenAiChatRelayRuntimeInput` → `V3HubReqInbound01ClientRaw` | anchored | execute_v3_openai_chat_completions_request<br/><small>routecodex-v3-server/src/executors.rs</small> | execute_v3_openai_chat_relay_runtime_with_default_transport<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small> | `v3.openai_chat_relay_runtime_integration` |
| `v3-openai-chat-relay-02` | `V3HubReqInbound01ClientRaw` → `V3HubReqInbound02Normalized` | anchored | execute_v3_openai_chat_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small> | build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01<br/><small>routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs</small> | `v3.openai_chat_relay_runtime_integration` |
| `v3-openai-chat-relay-03` | `V3HubReqInbound02Normalized` → `V3HubReqContinuation03Classified` | anchored | V3HubRelayRequestHooks::run_from_normalized<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small> | build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02<br/><small>routecodex-v3-runtime/src/hub_v1/req_continuation_03_classified.rs</small> | `v3.openai_chat_relay_runtime_integration` |
| `v3-openai-chat-relay-04` | `V3HubReqContinuation03Classified` → `V3HubReqChatProcess04Governed` | anchored | V3HubRelayRequestHooks::run_from_normalized<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small> | build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03<br/><small>routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs</small> | `v3.openai_chat_relay_runtime_integration` |
| `v3-openai-chat-relay-05` | `V3HubReqChatProcess04Governed` → `V3HubReqExecution05Planned` | anchored | execute_v3_openai_chat_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small> | build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04<br/><small>routecodex-v3-runtime/src/hub_v1/req_execution_05_planned.rs</small> | `v3.openai_chat_relay_runtime_integration` |
| `v3-openai-chat-relay-06` | `V3HubReqExecution05Planned` → `V3HubReqTarget06Resolved` | anchored | execute_v3_openai_chat_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small> | build_v3_hub_req_target_06_from_v3_hub_req_execution_05<br/><small>routecodex-v3-runtime/src/hub_v1/req_target_06_resolved.rs</small> | `v3.openai_chat_relay_runtime_integration` |
| `v3-openai-chat-relay-07` | `V3HubReqTarget06Resolved` → `V3HubReqOutbound07ProviderSemantic` | anchored | execute_v3_openai_chat_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small> | build_v3_hub_req_outbound_07_from_v3_hub_req_target_06<br/><small>routecodex-v3-runtime/src/hub_v1/req_outbound_07_provider_semantic.rs</small> | `v3.openai_chat_relay_runtime_integration` |
| `v3-openai-chat-relay-08` | `V3HubReqOutbound07ProviderSemantic` → `ProviderReqCompat06ProviderCompat` | anchored | execute_v3_openai_chat_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small> | build_provider_req_compat_06_from_v3_hub_req_outbound_07<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs</small> | `v3.openai_chat_relay_runtime_integration` |
| `v3-openai-chat-relay-09` | `ProviderReqCompat06ProviderCompat` → `V3ProviderReqOutbound08WirePayload` | anchored | execute_v3_openai_chat_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small> | build_v3_provider_req_outbound_08_from_provider_req_compat_06<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_outbound_08_wire_payload.rs</small> | `v3.openai_chat_relay_runtime_integration` |
| `v3-openai-chat-relay-10` | `V3ProviderReqOutbound08WirePayload` → `V3ProviderReqOutbound09TransportRequest` | anchored | execute_v3_openai_chat_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small> | build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_outbound_09_transport_request.rs</small> | `v3.openai_chat_relay_runtime_integration` |
| `v3-openai-chat-relay-11` | `V3ProviderReqOutbound09TransportRequest` → `V3ProviderRespInbound01Raw` | anchored | execute_v3_openai_chat_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small> | ResponsesTransport::send<br/><small>routecodex-v3-provider-responses/src/transport.rs</small> | `v3.openai_chat_relay_runtime_integration` |
| `v3-openai-chat-relay-12` | `V3ProviderRespInbound01Raw` → `ProviderRespCompat02ProviderCompat` | anchored | project_json_response<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small> | build_provider_resp_compat_02_from_v3_provider_resp_inbound_01<br/><small>routecodex-v3-runtime/src/hub_v1/provider_resp_compat_02_provider_compat.rs</small> | `v3.openai_chat_relay_runtime_integration` |
| `v3-openai-chat-relay-13` | `ProviderRespCompat02ProviderCompat` → `V3HubRespInbound02Normalized` | anchored | project_json_response<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small> | build_v3_hub_resp_inbound_02_from_provider_resp_compat_02<br/><small>routecodex-v3-runtime/src/hub_v1/resp_inbound_02_normalized.rs</small> | `v3.openai_chat_relay_runtime_integration` |
| `v3-openai-chat-relay-14` | `V3HubRespInbound02Normalized` → `V3HubRespChatProcess03Governed` | anchored | project_json_response<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small> | V3HubRelayResponseHookRegistry::govern<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | `v3.openai_chat_relay_runtime_integration` |
| `v3-openai-chat-relay-15` | `V3HubRespChatProcess03Governed` → `V3HubRespContinuation04Committed` | anchored | project_json_response<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small> | V3HubRelayResponseHookRegistry::commit<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | `v3.openai_chat_relay_runtime_integration` |
| `v3-openai-chat-relay-16` | `V3HubRespContinuation04Committed` → `V3HubRespOutbound05ClientSemantic` | anchored | project_json_response<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small> | build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04<br/><small>routecodex-v3-runtime/src/hub_v1/resp_outbound_05_client_semantic.rs</small> | `v3.openai_chat_relay_runtime_integration` |
| `v3-openai-chat-relay-17` | `V3HubRespOutbound05ClientSemantic` → `V3ServerRespOutbound06ClientFrame` | anchored | openai_chat_relay_output_response<br/><small>routecodex-v3-server/src/executors.rs</small> | Body::from_stream<br/><small>routecodex-v3-server/src/executors.rs</small> | `v3.openai_chat_relay_runtime_integration` |

## v3.gemini_relay.controlled_runtime

Controlled /v1beta/models/:model/generateContent Relay through the sole Hub v1 request/response lifecycle; Gemini codec and Runtime own protocol semantics while Server only transports typed JSON/SSE output.

Owner feature: `v3.gemini_relay_runtime_integration`
Manifest: `docs/architecture/manifests/v3.gemini_relay.controlled_runtime.mainline.yml`

```mermaid
flowchart TD
  subgraph c_36_v3_gemini_relay_controlled_runtime_m_v3_provider_responses["v3-provider-responses"]
    c_36_v3_gemini_relay_controlled_runtime_13["v3-provider-responses<br/>ResponsesTransport::send<br/><small>routecodex-v3-provider-responses/src/transport.rs</small>"]
  end
  subgraph c_36_v3_gemini_relay_controlled_runtime_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_36_v3_gemini_relay_controlled_runtime_1["v3-runtime::hub_v1<br/>execute_v3_gemini_relay_runtime_with_default_transport<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small>"]
    c_36_v3_gemini_relay_controlled_runtime_2["v3-runtime::hub_v1<br/>execute_v3_gemini_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small>"]
    c_36_v3_gemini_relay_controlled_runtime_3["v3-runtime::hub_v1<br/>build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01<br/><small>routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs</small>"]
    c_36_v3_gemini_relay_controlled_runtime_4["v3-runtime::hub_v1<br/>V3HubRelayRequestHooks::run_from_normalized<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small>"]
    c_36_v3_gemini_relay_controlled_runtime_5["v3-runtime::hub_v1<br/>build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02<br/><small>routecodex-v3-runtime/src/hub_v1/req_continuation_03_classified.rs</small>"]
    c_36_v3_gemini_relay_controlled_runtime_6["v3-runtime::hub_v1<br/>build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03<br/><small>routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs</small>"]
    c_36_v3_gemini_relay_controlled_runtime_7["v3-runtime::hub_v1<br/>build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04<br/><small>routecodex-v3-runtime/src/hub_v1/req_execution_05_planned.rs</small>"]
    c_36_v3_gemini_relay_controlled_runtime_8["v3-runtime::hub_v1<br/>build_v3_hub_req_target_06_from_v3_hub_req_execution_05<br/><small>routecodex-v3-runtime/src/hub_v1/req_target_06_resolved.rs</small>"]
    c_36_v3_gemini_relay_controlled_runtime_9["v3-runtime::hub_v1<br/>build_v3_hub_req_outbound_07_from_v3_hub_req_target_06<br/><small>routecodex-v3-runtime/src/hub_v1/req_outbound_07_provider_semantic.rs</small>"]
    c_36_v3_gemini_relay_controlled_runtime_10["v3-runtime::hub_v1<br/>build_provider_req_compat_06_from_v3_hub_req_outbound_07<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs</small>"]
    c_36_v3_gemini_relay_controlled_runtime_11["v3-runtime::hub_v1<br/>build_v3_provider_req_outbound_08_from_provider_req_compat_06<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_outbound_08_wire_payload.rs</small>"]
    c_36_v3_gemini_relay_controlled_runtime_12["v3-runtime::hub_v1<br/>build_v3_gemini_transport_09<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small>"]
    c_36_v3_gemini_relay_controlled_runtime_14["v3-runtime::hub_v1<br/>project_json_response<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small>"]
    c_36_v3_gemini_relay_controlled_runtime_15["v3-runtime::hub_v1<br/>build_provider_resp_compat_02_from_v3_provider_resp_inbound_01<br/><small>routecodex-v3-runtime/src/hub_v1/provider_resp_compat_02_provider_compat.rs</small>"]
    c_36_v3_gemini_relay_controlled_runtime_16["v3-runtime::hub_v1<br/>build_v3_hub_resp_inbound_02_from_provider_resp_compat_02<br/><small>routecodex-v3-runtime/src/hub_v1/resp_inbound_02_normalized.rs</small>"]
    c_36_v3_gemini_relay_controlled_runtime_17["v3-runtime::hub_v1<br/>V3HubRelayResponseHookRegistry::govern<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
    c_36_v3_gemini_relay_controlled_runtime_18["v3-runtime::hub_v1<br/>V3HubRelayResponseHookRegistry::commit<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
    c_36_v3_gemini_relay_controlled_runtime_19["v3-runtime::hub_v1<br/>build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04<br/><small>routecodex-v3-runtime/src/hub_v1/resp_outbound_05_client_semantic.rs</small>"]
  end
  subgraph c_36_v3_gemini_relay_controlled_runtime_m_v3_server["v3-server"]
    c_36_v3_gemini_relay_controlled_runtime_0["v3-server<br/>execute_v3_gemini_generate_content_request<br/><small>routecodex-v3-server/src/executors.rs</small>"]
    c_36_v3_gemini_relay_controlled_runtime_20["v3-server<br/>gemini_relay_output_response<br/><small>routecodex-v3-server/src/executors.rs</small>"]
    c_36_v3_gemini_relay_controlled_runtime_21["v3-server<br/>Body::from_stream<br/><small>routecodex-v3-server/src/executors.rs</small>"]
  end
  c_36_v3_gemini_relay_controlled_runtime_0 -->|v3-gemini-relay-01<br/>V3GeminiRelayRuntimeInput → V3HubReqInbound01ClientRaw| c_36_v3_gemini_relay_controlled_runtime_1
  c_36_v3_gemini_relay_controlled_runtime_2 -->|v3-gemini-relay-02<br/>V3HubReqInbound01ClientRaw → V3HubReqInbound02Normalized| c_36_v3_gemini_relay_controlled_runtime_3
  c_36_v3_gemini_relay_controlled_runtime_4 -->|v3-gemini-relay-03<br/>V3HubReqInbound02Normalized → V3HubReqContinuation03Classified| c_36_v3_gemini_relay_controlled_runtime_5
  c_36_v3_gemini_relay_controlled_runtime_4 -->|v3-gemini-relay-04<br/>V3HubReqContinuation03Classified → V3HubReqChatProcess04Governed| c_36_v3_gemini_relay_controlled_runtime_6
  c_36_v3_gemini_relay_controlled_runtime_2 -->|v3-gemini-relay-05<br/>V3HubReqChatProcess04Governed → V3HubReqExecution05Planned| c_36_v3_gemini_relay_controlled_runtime_7
  c_36_v3_gemini_relay_controlled_runtime_2 -->|v3-gemini-relay-06<br/>V3HubReqExecution05Planned → V3HubReqTarget06Resolved| c_36_v3_gemini_relay_controlled_runtime_8
  c_36_v3_gemini_relay_controlled_runtime_2 -->|v3-gemini-relay-07<br/>V3HubReqTarget06Resolved → V3HubReqOutbound07ProviderSemantic| c_36_v3_gemini_relay_controlled_runtime_9
  c_36_v3_gemini_relay_controlled_runtime_2 -->|v3-gemini-relay-08<br/>V3HubReqOutbound07ProviderSemantic → ProviderReqCompat06ProviderCompat| c_36_v3_gemini_relay_controlled_runtime_10
  c_36_v3_gemini_relay_controlled_runtime_2 -->|v3-gemini-relay-09<br/>ProviderReqCompat06ProviderCompat → V3ProviderReqOutbound08WirePayload| c_36_v3_gemini_relay_controlled_runtime_11
  c_36_v3_gemini_relay_controlled_runtime_2 -->|v3-gemini-relay-10<br/>V3ProviderReqOutbound08WirePayload → V3ProviderReqOutbound09TransportRequest| c_36_v3_gemini_relay_controlled_runtime_12
  c_36_v3_gemini_relay_controlled_runtime_2 -->|v3-gemini-relay-11<br/>V3ProviderReqOutbound09TransportRequest → V3ProviderRespInbound01Raw| c_36_v3_gemini_relay_controlled_runtime_13
  c_36_v3_gemini_relay_controlled_runtime_14 -->|v3-gemini-relay-12<br/>V3ProviderRespInbound01Raw → ProviderRespCompat02ProviderCompat| c_36_v3_gemini_relay_controlled_runtime_15
  c_36_v3_gemini_relay_controlled_runtime_14 -->|v3-gemini-relay-13<br/>ProviderRespCompat02ProviderCompat → V3HubRespInbound02Normalized| c_36_v3_gemini_relay_controlled_runtime_16
  c_36_v3_gemini_relay_controlled_runtime_14 -->|v3-gemini-relay-14<br/>V3HubRespInbound02Normalized → V3HubRespChatProcess03Governed| c_36_v3_gemini_relay_controlled_runtime_17
  c_36_v3_gemini_relay_controlled_runtime_14 -->|v3-gemini-relay-15<br/>V3HubRespChatProcess03Governed → V3HubRespContinuation04Committed| c_36_v3_gemini_relay_controlled_runtime_18
  c_36_v3_gemini_relay_controlled_runtime_14 -->|v3-gemini-relay-16<br/>V3HubRespContinuation04Committed → V3HubRespOutbound05ClientSemantic| c_36_v3_gemini_relay_controlled_runtime_19
  c_36_v3_gemini_relay_controlled_runtime_20 -->|v3-gemini-relay-17<br/>V3HubRespOutbound05ClientSemantic → V3ServerRespOutbound06ClientFrame| c_36_v3_gemini_relay_controlled_runtime_21
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-gemini-relay-01` | `V3GeminiRelayRuntimeInput` → `V3HubReqInbound01ClientRaw` | anchored | execute_v3_gemini_generate_content_request<br/><small>routecodex-v3-server/src/executors.rs</small> | execute_v3_gemini_relay_runtime_with_default_transport<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small> | `v3.gemini_relay_runtime_integration` |
| `v3-gemini-relay-02` | `V3HubReqInbound01ClientRaw` → `V3HubReqInbound02Normalized` | anchored | execute_v3_gemini_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small> | build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01<br/><small>routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs</small> | `v3.gemini_relay_runtime_integration` |
| `v3-gemini-relay-03` | `V3HubReqInbound02Normalized` → `V3HubReqContinuation03Classified` | anchored | V3HubRelayRequestHooks::run_from_normalized<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small> | build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02<br/><small>routecodex-v3-runtime/src/hub_v1/req_continuation_03_classified.rs</small> | `v3.gemini_relay_runtime_integration` |
| `v3-gemini-relay-04` | `V3HubReqContinuation03Classified` → `V3HubReqChatProcess04Governed` | anchored | V3HubRelayRequestHooks::run_from_normalized<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small> | build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03<br/><small>routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs</small> | `v3.gemini_relay_runtime_integration` |
| `v3-gemini-relay-05` | `V3HubReqChatProcess04Governed` → `V3HubReqExecution05Planned` | anchored | execute_v3_gemini_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small> | build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04<br/><small>routecodex-v3-runtime/src/hub_v1/req_execution_05_planned.rs</small> | `v3.gemini_relay_runtime_integration` |
| `v3-gemini-relay-06` | `V3HubReqExecution05Planned` → `V3HubReqTarget06Resolved` | anchored | execute_v3_gemini_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small> | build_v3_hub_req_target_06_from_v3_hub_req_execution_05<br/><small>routecodex-v3-runtime/src/hub_v1/req_target_06_resolved.rs</small> | `v3.gemini_relay_runtime_integration` |
| `v3-gemini-relay-07` | `V3HubReqTarget06Resolved` → `V3HubReqOutbound07ProviderSemantic` | anchored | execute_v3_gemini_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small> | build_v3_hub_req_outbound_07_from_v3_hub_req_target_06<br/><small>routecodex-v3-runtime/src/hub_v1/req_outbound_07_provider_semantic.rs</small> | `v3.gemini_relay_runtime_integration` |
| `v3-gemini-relay-08` | `V3HubReqOutbound07ProviderSemantic` → `ProviderReqCompat06ProviderCompat` | anchored | execute_v3_gemini_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small> | build_provider_req_compat_06_from_v3_hub_req_outbound_07<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs</small> | `v3.gemini_relay_runtime_integration` |
| `v3-gemini-relay-09` | `ProviderReqCompat06ProviderCompat` → `V3ProviderReqOutbound08WirePayload` | anchored | execute_v3_gemini_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small> | build_v3_provider_req_outbound_08_from_provider_req_compat_06<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_outbound_08_wire_payload.rs</small> | `v3.gemini_relay_runtime_integration` |
| `v3-gemini-relay-10` | `V3ProviderReqOutbound08WirePayload` → `V3ProviderReqOutbound09TransportRequest` | anchored | execute_v3_gemini_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small> | build_v3_gemini_transport_09<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small> | `v3.gemini_relay_runtime_integration` |
| `v3-gemini-relay-11` | `V3ProviderReqOutbound09TransportRequest` → `V3ProviderRespInbound01Raw` | anchored | execute_v3_gemini_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small> | ResponsesTransport::send<br/><small>routecodex-v3-provider-responses/src/transport.rs</small> | `v3.gemini_relay_runtime_integration` |
| `v3-gemini-relay-12` | `V3ProviderRespInbound01Raw` → `ProviderRespCompat02ProviderCompat` | anchored | project_json_response<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small> | build_provider_resp_compat_02_from_v3_provider_resp_inbound_01<br/><small>routecodex-v3-runtime/src/hub_v1/provider_resp_compat_02_provider_compat.rs</small> | `v3.gemini_relay_runtime_integration` |
| `v3-gemini-relay-13` | `ProviderRespCompat02ProviderCompat` → `V3HubRespInbound02Normalized` | anchored | project_json_response<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small> | build_v3_hub_resp_inbound_02_from_provider_resp_compat_02<br/><small>routecodex-v3-runtime/src/hub_v1/resp_inbound_02_normalized.rs</small> | `v3.gemini_relay_runtime_integration` |
| `v3-gemini-relay-14` | `V3HubRespInbound02Normalized` → `V3HubRespChatProcess03Governed` | anchored | project_json_response<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small> | V3HubRelayResponseHookRegistry::govern<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | `v3.gemini_relay_runtime_integration` |
| `v3-gemini-relay-15` | `V3HubRespChatProcess03Governed` → `V3HubRespContinuation04Committed` | anchored | project_json_response<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small> | V3HubRelayResponseHookRegistry::commit<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | `v3.gemini_relay_runtime_integration` |
| `v3-gemini-relay-16` | `V3HubRespContinuation04Committed` → `V3HubRespOutbound05ClientSemantic` | anchored | project_json_response<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small> | build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04<br/><small>routecodex-v3-runtime/src/hub_v1/resp_outbound_05_client_semantic.rs</small> | `v3.gemini_relay_runtime_integration` |
| `v3-gemini-relay-17` | `V3HubRespOutbound05ClientSemantic` → `V3ServerRespOutbound06ClientFrame` | anchored | gemini_relay_output_response<br/><small>routecodex-v3-server/src/executors.rs</small> | Body::from_stream<br/><small>routecodex-v3-server/src/executors.rs</small> | `v3.gemini_relay_runtime_integration` |

## v3.entry_protocol_registry_contract.mainline

Config compiles Hub v1 entry protocol bindings into manifest truth before Server or Runtime execution.

Owner feature: `v3.entry_protocol_registry_contract`

```mermaid
flowchart TD
  subgraph c_37_v3_entry_protocol_registry_contract_mainline_m_v3_config["v3-config"]
    c_37_v3_entry_protocol_registry_contract_mainline_0["v3-config<br/>compile_hub_v1<br/><small>routecodex-v3-config/src/validate.rs</small>"]
    c_37_v3_entry_protocol_registry_contract_mainline_1["v3-config<br/>compile_entry_protocol_bindings<br/><small>routecodex-v3-config/src/validate.rs</small>"]
    c_37_v3_entry_protocol_registry_contract_mainline_2["v3-config<br/>V3EntryProtocolBindingManifest<br/><small>routecodex-v3-config/src/types.rs</small>"]
    c_37_v3_entry_protocol_registry_contract_mainline_3["v3-config<br/>publish_v3_config_05_manifest_from_v3_config_04<br/><small>routecodex-v3-config/src/lib.rs</small>"]
  end
  c_37_v3_entry_protocol_registry_contract_mainline_0 -->|v3-entry-protocol-registry-01<br/>V3HubV1AuthoringConfig → V3EntryProtocolBindingAuthoringConfig| c_37_v3_entry_protocol_registry_contract_mainline_1
  c_37_v3_entry_protocol_registry_contract_mainline_1 -->|v3-entry-protocol-registry-02<br/>V3EntryProtocolBindingAuthoringConfig → V3EntryProtocolBindingManifest| c_37_v3_entry_protocol_registry_contract_mainline_2
  c_37_v3_entry_protocol_registry_contract_mainline_0 -->|v3-entry-protocol-registry-03<br/>V3EntryProtocolBindingManifest → V3Config05ManifestPublished| c_37_v3_entry_protocol_registry_contract_mainline_3
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-entry-protocol-registry-01` | `V3HubV1AuthoringConfig` → `V3EntryProtocolBindingAuthoringConfig` | anchored | compile_hub_v1<br/><small>routecodex-v3-config/src/validate.rs</small> | compile_entry_protocol_bindings<br/><small>routecodex-v3-config/src/validate.rs</small> | `v3.entry_protocol_registry_contract` |
| `v3-entry-protocol-registry-02` | `V3EntryProtocolBindingAuthoringConfig` → `V3EntryProtocolBindingManifest` | anchored | compile_entry_protocol_bindings<br/><small>routecodex-v3-config/src/validate.rs</small> | V3EntryProtocolBindingManifest<br/><small>routecodex-v3-config/src/types.rs</small> | `v3.entry_protocol_registry_contract` |
| `v3-entry-protocol-registry-03` | `V3EntryProtocolBindingManifest` → `V3Config05ManifestPublished` | anchored | compile_hub_v1<br/><small>routecodex-v3-config/src/validate.rs</small> | publish_v3_config_05_manifest_from_v3_config_04<br/><small>routecodex-v3-config/src/lib.rs</small> | `v3.entry_protocol_registry_contract` |

## v3.hub_relay.runtime_closeout

Controlled Hub Relay Runtime closeout over the fixed Req01-Req09 and Resp01-Resp06 topology. It binds JSON/SSE, local continuation, servertool hook profile, Responses Relay source server entry, Error01-06, and one-response-exit evidence without claiming live/P6/global cutover.

Owner feature: `v3.hub_relay_runtime_closeout`
Manifest: `docs/architecture/manifests/v3.hub_relay.runtime_closeout.mainline.yml`

```mermaid
flowchart TD
  subgraph c_38_v3_hub_relay_runtime_closeout_m_v3_provider_responses["v3-provider-responses"]
    c_38_v3_hub_relay_runtime_closeout_11["v3-provider-responses<br/>ResponsesTransport::send<br/><small>routecodex-v3-provider-responses/src/transport.rs</small>"]
  end
  subgraph c_38_v3_hub_relay_runtime_closeout_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_38_v3_hub_relay_runtime_closeout_0["v3-runtime::hub_v1<br/>execute_v3_anthropic_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small>"]
    c_38_v3_hub_relay_runtime_closeout_1["v3-runtime::hub_v1<br/>run_v3_anthropic_relay_runtime_req_inbound<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_hooks.rs</small>"]
    c_38_v3_hub_relay_runtime_closeout_2["v3-runtime::hub_v1<br/>V3HubRelayRequestHooks::run_from_normalized<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small>"]
    c_38_v3_hub_relay_runtime_closeout_3["v3-runtime::hub_v1<br/>build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02<br/><small>routecodex-v3-runtime/src/hub_v1/req_continuation_03_classified.rs</small>"]
    c_38_v3_hub_relay_runtime_closeout_4["v3-runtime::hub_v1<br/>build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03<br/><small>routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs</small>"]
    c_38_v3_hub_relay_runtime_closeout_5["v3-runtime::hub_v1<br/>build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04<br/><small>routecodex-v3-runtime/src/hub_v1/req_execution_05_planned.rs</small>"]
    c_38_v3_hub_relay_runtime_closeout_6["v3-runtime::hub_v1<br/>build_v3_hub_req_target_06_from_v3_hub_req_execution_05<br/><small>routecodex-v3-runtime/src/hub_v1/req_target_06_resolved.rs</small>"]
    c_38_v3_hub_relay_runtime_closeout_7["v3-runtime::hub_v1<br/>build_v3_hub_req_outbound_07_from_v3_hub_req_target_06<br/><small>routecodex-v3-runtime/src/hub_v1/req_outbound_07_provider_semantic.rs</small>"]
    c_38_v3_hub_relay_runtime_closeout_8["v3-runtime::hub_v1<br/>build_provider_req_compat_06_from_v3_hub_req_outbound_07<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs</small>"]
    c_38_v3_hub_relay_runtime_closeout_9["v3-runtime::hub_v1<br/>build_v3_provider_req_outbound_08_from_provider_req_compat_06<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_outbound_08_wire_payload.rs</small>"]
    c_38_v3_hub_relay_runtime_closeout_10["v3-runtime::hub_v1<br/>build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_outbound_09_transport_request.rs</small>"]
    c_38_v3_hub_relay_runtime_closeout_12["v3-runtime::hub_v1<br/>build_provider_resp_compat_02_from_v3_provider_resp_inbound_01<br/><small>routecodex-v3-runtime/src/hub_v1/provider_resp_compat_02_provider_compat.rs</small>"]
    c_38_v3_hub_relay_runtime_closeout_13["v3-runtime::hub_v1<br/>build_v3_hub_resp_inbound_02_from_provider_resp_compat_02<br/><small>routecodex-v3-runtime/src/hub_v1/resp_inbound_02_normalized.rs</small>"]
    c_38_v3_hub_relay_runtime_closeout_14["v3-runtime::hub_v1<br/>V3HubRelayResponseHookRegistry::govern<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
    c_38_v3_hub_relay_runtime_closeout_15["v3-runtime::hub_v1<br/>V3HubRelayResponseHookRegistry::commit<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
    c_38_v3_hub_relay_runtime_closeout_16["v3-runtime::hub_v1<br/>build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04<br/><small>routecodex-v3-runtime/src/hub_v1/resp_outbound_05_client_semantic.rs</small>"]
    c_38_v3_hub_relay_runtime_closeout_17["v3-runtime::hub_v1<br/>build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05<br/><small>routecodex-v3-runtime/src/hub_v1/server_resp_outbound_06_client_frame.rs</small>"]
  end
  c_38_v3_hub_relay_runtime_closeout_0 -->|v3-hub-relay-closeout-01<br/>V3HubReqInbound01ClientRaw → V3HubReqInbound02Normalized| c_38_v3_hub_relay_runtime_closeout_1
  c_38_v3_hub_relay_runtime_closeout_2 -->|v3-hub-relay-closeout-02<br/>V3HubReqInbound02Normalized → V3HubReqContinuation03Classified| c_38_v3_hub_relay_runtime_closeout_3
  c_38_v3_hub_relay_runtime_closeout_2 -->|v3-hub-relay-closeout-03<br/>V3HubReqContinuation03Classified → V3HubReqChatProcess04Governed| c_38_v3_hub_relay_runtime_closeout_4
  c_38_v3_hub_relay_runtime_closeout_0 -->|v3-hub-relay-closeout-04<br/>V3HubReqChatProcess04Governed → V3HubReqExecution05Planned| c_38_v3_hub_relay_runtime_closeout_5
  c_38_v3_hub_relay_runtime_closeout_0 -->|v3-hub-relay-closeout-05<br/>V3HubReqExecution05Planned → V3HubReqTarget06Resolved| c_38_v3_hub_relay_runtime_closeout_6
  c_38_v3_hub_relay_runtime_closeout_0 -->|v3-hub-relay-closeout-06<br/>V3HubReqTarget06Resolved → V3HubReqOutbound07ProviderSemantic| c_38_v3_hub_relay_runtime_closeout_7
  c_38_v3_hub_relay_runtime_closeout_0 -->|v3-hub-relay-closeout-07<br/>V3HubReqOutbound07ProviderSemantic → ProviderReqCompat06ProviderCompat| c_38_v3_hub_relay_runtime_closeout_8
  c_38_v3_hub_relay_runtime_closeout_0 -->|v3-hub-relay-closeout-08<br/>ProviderReqCompat06ProviderCompat → V3ProviderReqOutbound08WirePayload| c_38_v3_hub_relay_runtime_closeout_9
  c_38_v3_hub_relay_runtime_closeout_0 -->|v3-hub-relay-closeout-09<br/>V3ProviderReqOutbound08WirePayload → V3ProviderReqOutbound09TransportRequest| c_38_v3_hub_relay_runtime_closeout_10
  c_38_v3_hub_relay_runtime_closeout_0 -->|v3-hub-relay-closeout-10<br/>V3ProviderReqOutbound09TransportRequest → V3ProviderRespInbound01Raw| c_38_v3_hub_relay_runtime_closeout_11
  c_38_v3_hub_relay_runtime_closeout_0 -->|v3-hub-relay-closeout-11<br/>V3ProviderRespInbound01Raw → ProviderRespCompat02ProviderCompat| c_38_v3_hub_relay_runtime_closeout_12
  c_38_v3_hub_relay_runtime_closeout_0 -->|v3-hub-relay-closeout-12<br/>ProviderRespCompat02ProviderCompat → V3HubRespInbound02Normalized| c_38_v3_hub_relay_runtime_closeout_13
  c_38_v3_hub_relay_runtime_closeout_0 -->|v3-hub-relay-closeout-13<br/>V3HubRespInbound02Normalized → V3HubRespChatProcess03Governed| c_38_v3_hub_relay_runtime_closeout_14
  c_38_v3_hub_relay_runtime_closeout_0 -->|v3-hub-relay-closeout-14<br/>V3HubRespChatProcess03Governed → V3HubRespContinuation04Committed| c_38_v3_hub_relay_runtime_closeout_15
  c_38_v3_hub_relay_runtime_closeout_0 -->|v3-hub-relay-closeout-15<br/>V3HubRespContinuation04Committed → V3HubRespOutbound05ClientSemantic| c_38_v3_hub_relay_runtime_closeout_16
  c_38_v3_hub_relay_runtime_closeout_0 -->|v3-hub-relay-closeout-16<br/>V3HubRespOutbound05ClientSemantic → V3ServerRespOutbound06ClientFrame| c_38_v3_hub_relay_runtime_closeout_17
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-hub-relay-closeout-01` | `V3HubReqInbound01ClientRaw` → `V3HubReqInbound02Normalized` | anchored | execute_v3_anthropic_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | run_v3_anthropic_relay_runtime_req_inbound<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_hooks.rs</small> | `v3.hub_relay_runtime_closeout` |
| `v3-hub-relay-closeout-02` | `V3HubReqInbound02Normalized` → `V3HubReqContinuation03Classified` | anchored | V3HubRelayRequestHooks::run_from_normalized<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small> | build_v3_hub_req_continuation_03_from_v3_hub_req_inbound_02<br/><small>routecodex-v3-runtime/src/hub_v1/req_continuation_03_classified.rs</small> | `v3.hub_relay_runtime_closeout` |
| `v3-hub-relay-closeout-03` | `V3HubReqContinuation03Classified` → `V3HubReqChatProcess04Governed` | anchored | V3HubRelayRequestHooks::run_from_normalized<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small> | build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03<br/><small>routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs</small> | `v3.hub_relay_runtime_closeout` |
| `v3-hub-relay-closeout-04` | `V3HubReqChatProcess04Governed` → `V3HubReqExecution05Planned` | anchored | execute_v3_anthropic_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | build_v3_hub_req_execution_05_from_v3_hub_req_chat_process_04<br/><small>routecodex-v3-runtime/src/hub_v1/req_execution_05_planned.rs</small> | `v3.hub_relay_runtime_closeout` |
| `v3-hub-relay-closeout-05` | `V3HubReqExecution05Planned` → `V3HubReqTarget06Resolved` | anchored | execute_v3_anthropic_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | build_v3_hub_req_target_06_from_v3_hub_req_execution_05<br/><small>routecodex-v3-runtime/src/hub_v1/req_target_06_resolved.rs</small> | `v3.hub_relay_runtime_closeout` |
| `v3-hub-relay-closeout-06` | `V3HubReqTarget06Resolved` → `V3HubReqOutbound07ProviderSemantic` | anchored | execute_v3_anthropic_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | build_v3_hub_req_outbound_07_from_v3_hub_req_target_06<br/><small>routecodex-v3-runtime/src/hub_v1/req_outbound_07_provider_semantic.rs</small> | `v3.hub_relay_runtime_closeout` |
| `v3-hub-relay-closeout-07` | `V3HubReqOutbound07ProviderSemantic` → `ProviderReqCompat06ProviderCompat` | anchored | execute_v3_anthropic_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | build_provider_req_compat_06_from_v3_hub_req_outbound_07<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs</small> | `v3.hub_relay_runtime_closeout` |
| `v3-hub-relay-closeout-08` | `ProviderReqCompat06ProviderCompat` → `V3ProviderReqOutbound08WirePayload` | anchored | execute_v3_anthropic_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | build_v3_provider_req_outbound_08_from_provider_req_compat_06<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_outbound_08_wire_payload.rs</small> | `v3.hub_relay_runtime_closeout` |
| `v3-hub-relay-closeout-09` | `V3ProviderReqOutbound08WirePayload` → `V3ProviderReqOutbound09TransportRequest` | anchored | execute_v3_anthropic_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | build_v3_provider_req_outbound_09_from_v3_provider_req_outbound_08<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_outbound_09_transport_request.rs</small> | `v3.hub_relay_runtime_closeout` |
| `v3-hub-relay-closeout-10` | `V3ProviderReqOutbound09TransportRequest` → `V3ProviderRespInbound01Raw` | anchored | execute_v3_anthropic_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | ResponsesTransport::send<br/><small>routecodex-v3-provider-responses/src/transport.rs</small> | `v3.hub_relay_runtime_closeout` |
| `v3-hub-relay-closeout-11` | `V3ProviderRespInbound01Raw` → `ProviderRespCompat02ProviderCompat` | anchored | execute_v3_anthropic_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | build_provider_resp_compat_02_from_v3_provider_resp_inbound_01<br/><small>routecodex-v3-runtime/src/hub_v1/provider_resp_compat_02_provider_compat.rs</small> | `v3.hub_relay_runtime_closeout` |
| `v3-hub-relay-closeout-12` | `ProviderRespCompat02ProviderCompat` → `V3HubRespInbound02Normalized` | anchored | execute_v3_anthropic_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | build_v3_hub_resp_inbound_02_from_provider_resp_compat_02<br/><small>routecodex-v3-runtime/src/hub_v1/resp_inbound_02_normalized.rs</small> | `v3.hub_relay_runtime_closeout` |
| `v3-hub-relay-closeout-13` | `V3HubRespInbound02Normalized` → `V3HubRespChatProcess03Governed` | anchored | execute_v3_anthropic_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | V3HubRelayResponseHookRegistry::govern<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | `v3.hub_relay_runtime_closeout` |
| `v3-hub-relay-closeout-14` | `V3HubRespChatProcess03Governed` → `V3HubRespContinuation04Committed` | anchored | execute_v3_anthropic_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | V3HubRelayResponseHookRegistry::commit<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | `v3.hub_relay_runtime_closeout` |
| `v3-hub-relay-closeout-15` | `V3HubRespContinuation04Committed` → `V3HubRespOutbound05ClientSemantic` | anchored | execute_v3_anthropic_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04<br/><small>routecodex-v3-runtime/src/hub_v1/resp_outbound_05_client_semantic.rs</small> | `v3.hub_relay_runtime_closeout` |
| `v3-hub-relay-closeout-16` | `V3HubRespOutbound05ClientSemantic` → `V3ServerRespOutbound06ClientFrame` | anchored | execute_v3_anthropic_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05<br/><small>routecodex-v3-runtime/src/hub_v1/server_resp_outbound_06_client_frame.rs</small> | `v3.hub_relay_runtime_closeout` |

## v3.hub_relay.response_failure_entry

Resp03 provider response governance failure enters the typed Error01 source builder before policy classification and client projection.

Owner feature: `v3.hub_relay_runtime_closeout`
Manifest: `docs/architecture/manifests/v3.hub_relay.runtime_closeout.mainline.yml`

```mermaid
flowchart TD
  subgraph c_39_v3_hub_relay_response_failure_entry_m_v3_error["v3-error"]
    c_39_v3_hub_relay_response_failure_entry_1["v3-error<br/>build_v3_error_01_source_raised_external<br/><small>routecodex-v3-error/src/lib.rs</small>"]
  end
  subgraph c_39_v3_hub_relay_response_failure_entry_m_v3_runtime["v3-runtime"]
    c_39_v3_hub_relay_response_failure_entry_0["v3-runtime<br/>build_v3_relay_provider_error_05_decision<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small>"]
  end
  c_39_v3_hub_relay_response_failure_entry_0 -->|v3-hub-relay-response-failure-01<br/>V3HubRespChatProcess03Governed → V3Error01SourceRaised| c_39_v3_hub_relay_response_failure_entry_1
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-hub-relay-response-failure-01` | `V3HubRespChatProcess03Governed` → `V3Error01SourceRaised` | anchored | build_v3_relay_provider_error_05_decision<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | build_v3_error_01_source_raised_external<br/><small>routecodex-v3-error/src/lib.rs</small> | `v3.hub_relay_runtime_closeout` |

## v3.responses_provider_event.terminal_merge

Responses provider-event terminal merge matches call-bearing output by call_id, preserves terminal truth, and backfills only stream fields absent from response.completed.

Owner feature: `v3.hub_relay_runtime_closeout`
Manifest: `docs/architecture/manifests/v3.responses_provider_event_terminal_merge.mainline.yml`

```mermaid
flowchart TD
  subgraph c_40_v3_responses_provider_event_terminal_merge_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_40_v3_responses_provider_event_terminal_merge_0["v3-runtime::hub_v1<br/>observe_v3_runtime_responses_sse_transport_chunk_typed_with_hook<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/responses_provider_event_codec.rs</small>"]
    c_40_v3_responses_provider_event_terminal_merge_1["v3-runtime::hub_v1<br/>build_typed_responses_terminal_response<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/responses_provider_event_codec.rs</small>"]
  end
  c_40_v3_responses_provider_event_terminal_merge_0 -->|v3-responses-provider-event-terminal-merge-01<br/>V3ProviderResponsesEventCodec → V3ProviderResponsesTerminalOrFailureObserved| c_40_v3_responses_provider_event_terminal_merge_1
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-responses-provider-event-terminal-merge-01` | `V3ProviderResponsesEventCodec` → `V3ProviderResponsesTerminalOrFailureObserved` | anchored | observe_v3_runtime_responses_sse_transport_chunk_typed_with_hook<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/responses_provider_event_codec.rs</small> | build_typed_responses_terminal_response<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/responses_provider_event_codec.rs</small> | `v3.hub_relay_runtime_closeout` |

## v3.sse.transport_boundary

V3 SSE is a transport-only edge: provider bytes become opaque validated SSE frames in routecodex-v3-sse, protocol semantics are handled by provider/protocol codecs, and server output only hands finalized client stream bytes to Body::from_stream.

Owner feature: `v3.sse_transport_core_independent`
Manifest: `docs/architecture/manifests/v3.sse.protocol_codec_projection.mainline.yml`

```mermaid
flowchart TD
  subgraph c_41_v3_sse_transport_boundary_m_routecodex_v3_sse["routecodex-v3-sse"]
    c_41_v3_sse_transport_boundary_0["routecodex-v3-sse<br/>SseIncrementalDecoder::push<br/><small>routecodex-v3-sse/src/lib.rs</small>"]
    c_41_v3_sse_transport_boundary_1["routecodex-v3-sse<br/>build_v3_sse_transport_in_02_from_fields<br/><small>routecodex-v3-sse/src/lib.rs</small>"]
    c_41_v3_sse_transport_boundary_2["routecodex-v3-sse<br/>build_v3_sse_transport_in_03_from_v3_sse_transport_in_02<br/><small>routecodex-v3-sse/src/lib.rs</small>"]
    c_41_v3_sse_transport_boundary_4["routecodex-v3-sse<br/>build_v3_sse_transport_out_04_from_v3_sse_transport_in_03<br/><small>routecodex-v3-sse/src/lib.rs</small>"]
  end
  subgraph c_41_v3_sse_transport_boundary_m_v3_provider_responses["v3-provider-responses"]
    c_41_v3_sse_transport_boundary_3["v3-provider-responses<br/>validated_sse_stream<br/><small>routecodex-v3-provider-responses/src/shared.rs</small>"]
  end
  subgraph c_41_v3_sse_transport_boundary_m_v3_server["v3-server"]
    c_41_v3_sse_transport_boundary_5["v3-server<br/>wrap_v3_relay_sse_closeout_stream<br/><small>routecodex-v3-server/src/executors.rs</small>"]
    c_41_v3_sse_transport_boundary_6["v3-server<br/>Body::from_stream<br/><small>routecodex-v3-server/src/executors.rs</small>"]
  end
  c_41_v3_sse_transport_boundary_0 -->|v3-sse-transport-01<br/>V3SseTransportIn01RawChunk → V3SseTransportIn02DecodedFrame| c_41_v3_sse_transport_boundary_1
  c_41_v3_sse_transport_boundary_0 -->|v3-sse-transport-02<br/>V3SseTransportIn02DecodedFrame → V3SseTransportIn03ValidatedFrameStream| c_41_v3_sse_transport_boundary_2
  c_41_v3_sse_transport_boundary_3 -->|v3-sse-transport-03<br/>V3SseTransportIn03ValidatedFrameStream → V3SseTransportOut04EncodedChunk| c_41_v3_sse_transport_boundary_4
  c_41_v3_sse_transport_boundary_5 -->|v3-sse-server-frame-04<br/>V3HubRespOutbound05ClientSemantic → V3ServerRespOutbound06ClientFrame| c_41_v3_sse_transport_boundary_6
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-sse-transport-01` | `V3SseTransportIn01RawChunk` → `V3SseTransportIn02DecodedFrame` | anchored | SseIncrementalDecoder::push<br/><small>routecodex-v3-sse/src/lib.rs</small> | build_v3_sse_transport_in_02_from_fields<br/><small>routecodex-v3-sse/src/lib.rs</small> | `v3.sse_transport_core_independent` |
| `v3-sse-transport-02` | `V3SseTransportIn02DecodedFrame` → `V3SseTransportIn03ValidatedFrameStream` | anchored | SseIncrementalDecoder::push<br/><small>routecodex-v3-sse/src/lib.rs</small> | build_v3_sse_transport_in_03_from_v3_sse_transport_in_02<br/><small>routecodex-v3-sse/src/lib.rs</small> | `v3.sse_transport_core_independent` |
| `v3-sse-transport-03` | `V3SseTransportIn03ValidatedFrameStream` → `V3SseTransportOut04EncodedChunk` | anchored | validated_sse_stream<br/><small>routecodex-v3-provider-responses/src/shared.rs</small> | build_v3_sse_transport_out_04_from_v3_sse_transport_in_03<br/><small>routecodex-v3-sse/src/lib.rs</small> | `v3.sse_transport_core_independent` |
| `v3-sse-server-frame-04` | `V3HubRespOutbound05ClientSemantic` → `V3ServerRespOutbound06ClientFrame` | anchored | wrap_v3_relay_sse_closeout_stream<br/><small>routecodex-v3-server/src/executors.rs</small> | Body::from_stream<br/><small>routecodex-v3-server/src/executors.rs</small> | `v3.sse_transport_core_independent` |

## v3.protocol_conversion_field_parity

Field-parity contract overlay over existing V3 Relay chains. Source wire is decoded to Chat canonical plus registered payload extensions before Chat Process; outbound projection consumes only governed Chat semantics. Arguments, client metadata, reasoning effort/budget/summary/context/mode/include/display, and other payload fields stay in the data plane. Routing/switch/retry/continuation control stays in typed control resources/MetadataCenter, and neither side reconstructs the other. It does not introduce a separate runtime lifecycle or any server/SSE/provider-transport owner.

Owner feature: `v3.protocol_conversion_field_parity`

```mermaid
flowchart TD
  subgraph c_42_v3_protocol_conversion_field_parity_m_v3_runtime["v3-runtime"]
    c_42_v3_protocol_conversion_field_parity_2["v3-runtime<br/>responses_openai_chat_field_parity_request_matrix<br/><small>routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs</small>"]
    c_42_v3_protocol_conversion_field_parity_6["v3-runtime<br/>responses_openai_chat_field_parity_response_matrix<br/><small>routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs</small>"]
    c_42_v3_protocol_conversion_field_parity_8["v3-runtime<br/>responses_relay_reasoning_effort_projects_minimax_adaptive_thinking<br/><small>routecodex-v3-runtime/tests/responses_relay_anthropic_provider_wire_integration.rs</small>"]
    c_42_v3_protocol_conversion_field_parity_10["v3-runtime<br/>anthropic_responses_field_parity_request_matrix<br/><small>routecodex-v3-runtime/tests/anthropic_relay_runtime_integration.rs</small>"]
    c_42_v3_protocol_conversion_field_parity_12["v3-runtime<br/>anthropic_responses_field_parity_response_matrix<br/><small>routecodex-v3-runtime/tests/anthropic_relay_runtime_integration.rs</small>"]
    c_42_v3_protocol_conversion_field_parity_14["v3-runtime<br/>openai_chat_same_protocol_field_parity_request_response_matrix<br/><small>routecodex-v3-runtime/tests/openai_chat_relay_runtime_integration.rs</small>"]
  end
  subgraph c_42_v3_protocol_conversion_field_parity_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_42_v3_protocol_conversion_field_parity_0["v3-runtime::hub_v1<br/>build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01<br/><small>routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs</small>"]
    c_42_v3_protocol_conversion_field_parity_1["v3-runtime::hub_v1<br/>build_v3_chat_canonical_request_from_responses_payload_for_req_inbound_compat<br/><small>routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs</small>"]
    c_42_v3_protocol_conversion_field_parity_3["v3-runtime::hub_v1<br/>build_v3_openai_chat_standard_request_from_chat_canonical<br/><small>routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs</small>"]
    c_42_v3_protocol_conversion_field_parity_4["v3-runtime::hub_v1<br/>build_v3_openai_chat_assistant_tool_call_message<br/><small>routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs</small>"]
    c_42_v3_protocol_conversion_field_parity_5["v3-runtime::hub_v1<br/>project_v3_responses_arguments_to_openai_chat_wire<br/><small>routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs</small>"]
    c_42_v3_protocol_conversion_field_parity_7["v3-runtime::hub_v1<br/>build_v3_responses_provider_response_from_openai_chat_payload<br/><small>routecodex-v3-runtime/src/hub_v1/responses_openai_chat_conversion.rs</small>"]
    c_42_v3_protocol_conversion_field_parity_9["v3-runtime::hub_v1<br/>build_provider_req_compat_06_from_v3_hub_req_outbound_07<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs</small>"]
    c_42_v3_protocol_conversion_field_parity_11["v3-runtime::hub_v1<br/>encode_v3_anthropic_request_as_responses_semantic<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs</small>"]
    c_42_v3_protocol_conversion_field_parity_13["v3-runtime::hub_v1<br/>project_v3_responses_json_as_anthropic_message<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime_codec.rs</small>"]
    c_42_v3_protocol_conversion_field_parity_15["v3-runtime::hub_v1<br/>execute_v3_openai_chat_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small>"]
  end
  c_42_v3_protocol_conversion_field_parity_0 -->|v3-protocol-field-parity-responses-chat-inbound-order-01<br/>V3HubReqInbound01ClientRaw → V3HubReqInbound02Normalized| c_42_v3_protocol_conversion_field_parity_1
  c_42_v3_protocol_conversion_field_parity_2 -->|v3-protocol-field-parity-responses-chat-req-01<br/>V3HubReqOutbound07ProviderSemantic → V3ProviderReqOutbound08WirePayload| c_42_v3_protocol_conversion_field_parity_3
  c_42_v3_protocol_conversion_field_parity_4 -->|v3-protocol-field-parity-responses-chat-malformed-arguments-project-01<br/>ProviderReqCompat06ProviderCompat → V3ProviderReqOutbound08WirePayload| c_42_v3_protocol_conversion_field_parity_5
  c_42_v3_protocol_conversion_field_parity_6 -->|v3-protocol-field-parity-responses-chat-resp-01<br/>V3ProviderRespInbound01Raw → V3HubRespInbound02Normalized| c_42_v3_protocol_conversion_field_parity_7
  c_42_v3_protocol_conversion_field_parity_8 -->|v3-protocol-field-parity-responses-anthropic-req-01<br/>V3HubReqOutbound07ProviderSemantic → ProviderReqCompat06ProviderCompat| c_42_v3_protocol_conversion_field_parity_9
  c_42_v3_protocol_conversion_field_parity_10 -->|v3-protocol-field-parity-anthropic-responses-req-01<br/>V3HubReqInbound02Normalized → V3HubReqOutbound07ProviderSemantic| c_42_v3_protocol_conversion_field_parity_11
  c_42_v3_protocol_conversion_field_parity_12 -->|v3-protocol-field-parity-responses-anthropic-resp-01<br/>V3HubRespOutbound05ClientSemantic → V3ServerRespOutbound06ClientFrame| c_42_v3_protocol_conversion_field_parity_13
  c_42_v3_protocol_conversion_field_parity_14 -->|v3-protocol-field-parity-openai-chat-same-protocol-01<br/>V3OpenAiChatRelayRuntimeInput → V3ServerRespOutbound06ClientFrame| c_42_v3_protocol_conversion_field_parity_15
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-protocol-field-parity-responses-chat-inbound-order-01` | `V3HubReqInbound01ClientRaw` → `V3HubReqInbound02Normalized` | anchored | build_v3_hub_req_inbound_02_result_from_v3_hub_req_inbound_01<br/><small>routecodex-v3-runtime/src/hub_v1/req_inbound_02_normalized.rs</small> | build_v3_chat_canonical_request_from_responses_payload_for_req_inbound_compat<br/><small>routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs</small> | `v3.protocol_conversion_field_parity` |
| `v3-protocol-field-parity-responses-chat-req-01` | `V3HubReqOutbound07ProviderSemantic` → `V3ProviderReqOutbound08WirePayload` | anchored | responses_openai_chat_field_parity_request_matrix<br/><small>routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs</small> | build_v3_openai_chat_standard_request_from_chat_canonical<br/><small>routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs</small> | `v3.protocol_conversion_field_parity` |
| `v3-protocol-field-parity-responses-chat-malformed-arguments-project-01` | `ProviderReqCompat06ProviderCompat` → `V3ProviderReqOutbound08WirePayload` | anchored | build_v3_openai_chat_assistant_tool_call_message<br/><small>routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs</small> | project_v3_responses_arguments_to_openai_chat_wire<br/><small>routecodex-v3-runtime/src/hub_v1/responses_openai_codec.rs</small> | `v3.protocol_conversion_field_parity` |
| `v3-protocol-field-parity-responses-chat-resp-01` | `V3ProviderRespInbound01Raw` → `V3HubRespInbound02Normalized` | anchored | responses_openai_chat_field_parity_response_matrix<br/><small>routecodex-v3-runtime/tests/responses_relay_local_continuation_integration.rs</small> | build_v3_responses_provider_response_from_openai_chat_payload<br/><small>routecodex-v3-runtime/src/hub_v1/responses_openai_chat_conversion.rs</small> | `v3.protocol_conversion_field_parity` |
| `v3-protocol-field-parity-responses-anthropic-req-01` | `V3HubReqOutbound07ProviderSemantic` → `ProviderReqCompat06ProviderCompat` | anchored | responses_relay_reasoning_effort_projects_minimax_adaptive_thinking<br/><small>routecodex-v3-runtime/tests/responses_relay_anthropic_provider_wire_integration.rs</small> | build_provider_req_compat_06_from_v3_hub_req_outbound_07<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs</small> | `v3.protocol_conversion_field_parity` |
| `v3-protocol-field-parity-anthropic-responses-req-01` | `V3HubReqInbound02Normalized` → `V3HubReqOutbound07ProviderSemantic` | anchored | anthropic_responses_field_parity_request_matrix<br/><small>routecodex-v3-runtime/tests/anthropic_relay_runtime_integration.rs</small> | encode_v3_anthropic_request_as_responses_semantic<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs</small> | `v3.protocol_conversion_field_parity` |
| `v3-protocol-field-parity-responses-anthropic-resp-01` | `V3HubRespOutbound05ClientSemantic` → `V3ServerRespOutbound06ClientFrame` | anchored | anthropic_responses_field_parity_response_matrix<br/><small>routecodex-v3-runtime/tests/anthropic_relay_runtime_integration.rs</small> | project_v3_responses_json_as_anthropic_message<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime_codec.rs</small> | `v3.protocol_conversion_field_parity` |
| `v3-protocol-field-parity-openai-chat-same-protocol-01` | `V3OpenAiChatRelayRuntimeInput` → `V3ServerRespOutbound06ClientFrame` | anchored | openai_chat_same_protocol_field_parity_request_response_matrix<br/><small>routecodex-v3-runtime/tests/openai_chat_relay_runtime_integration.rs</small> | execute_v3_openai_chat_relay_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small> | `v3.protocol_conversion_field_parity` |

## v3.responses_relay.source_server_entry

Source-only explicit Responses /v1/responses Relay binding: controlled manifests may bind Relay, while V2/default projection remains Direct; Server dispatch enters the declared Relay runtime only for that explicit binding, and controlled JSON/SSE/dry-run tests prove one fixed Hub Relay lifecycle without default cutover.

Owner feature: `v3.hub_relay_runtime_closeout`

```mermaid
flowchart TD
  subgraph c_43_v3_responses_relay_source_server_entry_m_v3_provider_responses["v3-provider-responses"]
    c_43_v3_responses_relay_source_server_entry_6["v3-provider-responses<br/>V3Transport13ResponsesRequest::provider_request_projection<br/><small>routecodex-v3-provider-responses/src/transport.rs</small>"]
  end
  subgraph c_43_v3_responses_relay_source_server_entry_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_43_v3_responses_relay_source_server_entry_1["v3-runtime::hub_v1<br/>execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_and_stopless_control<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs</small>"]
    c_43_v3_responses_relay_source_server_entry_5["v3-runtime::hub_v1<br/>execute_v3_responses_relay_dry_run_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_dry_run.rs</small>"]
  end
  subgraph c_43_v3_responses_relay_source_server_entry_m_v3_server["v3-server"]
    c_43_v3_responses_relay_source_server_entry_0["v3-server<br/>responses_relay_manifest<br/><small>routecodex-v3-server/tests/multi_listener_server.rs</small>"]
    c_43_v3_responses_relay_source_server_entry_2["v3-server<br/>pending_endpoint<br/><small>routecodex-v3-server/src/endpoint_handlers.rs</small>"]
    c_43_v3_responses_relay_source_server_entry_3["v3-server<br/>finalize_v3_responses_relay_server_output<br/><small>routecodex-v3-server/src/live_snapshot.rs</small>"]
    c_43_v3_responses_relay_source_server_entry_4["v3-server<br/>responses_relay_output_response<br/><small>routecodex-v3-server/src/executors.rs</small>"]
  end
  c_43_v3_responses_relay_source_server_entry_0 -->|v3-responses-relay-server-01<br/>V3Config05ManifestPublished → V3EntryBind04ExecutionBindingProjected| c_43_v3_responses_relay_source_server_entry_1
  c_43_v3_responses_relay_source_server_entry_2 -->|v3-responses-relay-server-02<br/>V3EntryBind04ExecutionBindingProjected → V3HubReqInbound01ClientRaw| c_43_v3_responses_relay_source_server_entry_1
  c_43_v3_responses_relay_source_server_entry_3 -->|v3-responses-relay-server-03<br/>V3HubReqInbound01ClientRaw → V3ServerRespOutbound06ClientFrame| c_43_v3_responses_relay_source_server_entry_4
  c_43_v3_responses_relay_source_server_entry_5 -->|v3-responses-relay-server-04<br/>V3ProviderReqOutbound09TransportRequest → V3DryRunNoNetworkTerminalEffect| c_43_v3_responses_relay_source_server_entry_6
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-responses-relay-server-01` | `V3Config05ManifestPublished` → `V3EntryBind04ExecutionBindingProjected` | anchored | responses_relay_manifest<br/><small>routecodex-v3-server/tests/multi_listener_server.rs</small> | execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_and_stopless_control<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs</small> | `v3.hub_relay_runtime_closeout` |
| `v3-responses-relay-server-02` | `V3EntryBind04ExecutionBindingProjected` → `V3HubReqInbound01ClientRaw` | anchored | pending_endpoint<br/><small>routecodex-v3-server/src/endpoint_handlers.rs</small> | execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_and_stopless_control<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs</small> | `v3.hub_relay_runtime_closeout` |
| `v3-responses-relay-server-03` | `V3HubReqInbound01ClientRaw` → `V3ServerRespOutbound06ClientFrame` | anchored | finalize_v3_responses_relay_server_output<br/><small>routecodex-v3-server/src/live_snapshot.rs</small> | responses_relay_output_response<br/><small>routecodex-v3-server/src/executors.rs</small> | `v3.hub_relay_runtime_closeout` |
| `v3-responses-relay-server-04` | `V3ProviderReqOutbound09TransportRequest` → `V3DryRunNoNetworkTerminalEffect` | anchored | execute_v3_responses_relay_dry_run_runtime<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_dry_run.rs</small> | V3Transport13ResponsesRequest::provider_request_projection<br/><small>routecodex-v3-provider-responses/src/transport.rs</small> | `v3.hub_relay_runtime_closeout` |

## v3.error.raw_wire_evidence

Terminal Responses Relay failure flushes verbatim request, Error chain, and provider wire evidence through the Server-owned failure diagnostic side channel only.

Owner feature: `v3.error.raw_wire_evidence`

```mermaid
flowchart TD
  subgraph c_44_v3_error_raw_wire_evidence_m_v3_server["v3-server"]
    c_44_v3_error_raw_wire_evidence_0["v3-server<br/>finalize_v3_responses_relay_server_output<br/><small>routecodex-v3-server/src/live_snapshot.rs</small>"]
    c_44_v3_error_raw_wire_evidence_1["v3-server<br/>persist_v3_error_evidence_payload<br/><small>routecodex-v3-server/src/live_snapshot.rs</small>"]
  end
  c_44_v3_error_raw_wire_evidence_0 -->|v3-responses-relay-error-evidence-01<br/>V3Error06ClientProjected → V3ErrorEvidenceFlushOnTerminalFailure| c_44_v3_error_raw_wire_evidence_1
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-responses-relay-error-evidence-01` | `V3Error06ClientProjected` → `V3ErrorEvidenceFlushOnTerminalFailure` | anchored | finalize_v3_responses_relay_server_output<br/><small>routecodex-v3-server/src/live_snapshot.rs</small> | persist_v3_error_evidence_payload<br/><small>routecodex-v3-server/src/live_snapshot.rs</small> | `v3.error.raw_wire_evidence` |

## v3.servertool_hook_skeleton_lifecycle

StoplessCenter Metadata Center control-signal state-machine lifecycle inside declared Chat Process stopless SOP only. Server entry and generic relay closeout are aggregate routing edges; StoplessCenter read/write ownership is bound to Req04/Resp03 StoplessCenter nodes; CLI is no-input no-op evidence only.

Owner feature: `v3.servertool_hook_skeleton_lifecycle`
Manifest: `docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml`

```mermaid
flowchart TD
  subgraph c_45_v3_servertool_hook_skeleton_lifecycle_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_45_v3_servertool_hook_skeleton_lifecycle_0["v3-runtime::hub_v1<br/>V3HubRelayRequestHooks::run_from_normalized<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small>"]
    c_45_v3_servertool_hook_skeleton_lifecycle_1["v3-runtime::hub_v1<br/>build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03<br/><small>routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs</small>"]
    c_45_v3_servertool_hook_skeleton_lifecycle_2["v3-runtime::hub_v1<br/>load_v3_responses_relay_stopless_control_state<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_stopless.rs</small>"]
    c_45_v3_servertool_hook_skeleton_lifecycle_3["v3-runtime::hub_v1<br/>V3ResponsesRelayStoplessControlState::load_for_scope<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_types.rs</small>"]
    c_45_v3_servertool_hook_skeleton_lifecycle_4["v3-runtime::hub_v1<br/>apply_v3_stopless_request_hook_at_req04<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small>"]
    c_45_v3_servertool_hook_skeleton_lifecycle_5["v3-runtime::hub_v1<br/>active_stopless_cli_output<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small>"]
    c_45_v3_servertool_hook_skeleton_lifecycle_6["v3-runtime::hub_v1<br/>V3StoplessCenterState::provider_turn_in_flight<br/><small>routecodex-v3-runtime/src/hub_v1/common.rs</small>"]
    c_45_v3_servertool_hook_skeleton_lifecycle_7["v3-runtime::hub_v1<br/>apply_v3_stop_servertool_hook_at_resp03<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small>"]
    c_45_v3_servertool_hook_skeleton_lifecycle_8["v3-runtime::hub_v1<br/>response_has_stopless_stop_trigger<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small>"]
    c_45_v3_servertool_hook_skeleton_lifecycle_9["v3-runtime::hub_v1<br/>apply_v3_responses_relay_stopless_control_transition<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_stopless.rs</small>"]
    c_45_v3_servertool_hook_skeleton_lifecycle_10["v3-runtime::hub_v1<br/>V3ResponsesRelayStoplessControlState::store_for_scope<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_types.rs</small>"]
    c_45_v3_servertool_hook_skeleton_lifecycle_11["v3-runtime::hub_v1<br/>project_stopless_noop_for_stop_candidate<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small>"]
    c_45_v3_servertool_hook_skeleton_lifecycle_12["v3-runtime::hub_v1<br/>commit_v3_hub_relay_response<br/><small>routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs</small>"]
    c_45_v3_servertool_hook_skeleton_lifecycle_13["v3-runtime::hub_v1<br/>build_v3_relay_local_continuation_context_at_resp04<br/><small>routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs</small>"]
  end
  c_45_v3_servertool_hook_skeleton_lifecycle_0 -->|v3-servertool-stopless-req-01<br/>V3HubReqContinuation03Classified → V3HubReqChatProcess04Governed| c_45_v3_servertool_hook_skeleton_lifecycle_1
  c_45_v3_servertool_hook_skeleton_lifecycle_2 -->|v3-servertool-stopless-req-02<br/>V3HubReqChatProcess04Governed → V3StoplessReq01RuntimeControlLoaded| c_45_v3_servertool_hook_skeleton_lifecycle_3
  c_45_v3_servertool_hook_skeleton_lifecycle_4 -->|v3-servertool-stopless-req-03<br/>V3StoplessReq01RuntimeControlLoaded → V3StoplessReq02NoopCliConsumed| c_45_v3_servertool_hook_skeleton_lifecycle_5
  c_45_v3_servertool_hook_skeleton_lifecycle_4 -->|v3-servertool-stopless-req-04<br/>V3StoplessReq02NoopCliConsumed → V3StoplessReq03ControlTransitioned| c_45_v3_servertool_hook_skeleton_lifecycle_6
  c_45_v3_servertool_hook_skeleton_lifecycle_7 -->|v3-servertool-stopless-resp-01<br/>V3HubRespChatProcess03Governed → V3StoplessResp01ReasoningStopInspected| c_45_v3_servertool_hook_skeleton_lifecycle_8
  c_45_v3_servertool_hook_skeleton_lifecycle_9 -->|v3-servertool-stopless-resp-02<br/>V3StoplessResp01ReasoningStopInspected → V3StoplessResp02RuntimeControlUpdated| c_45_v3_servertool_hook_skeleton_lifecycle_10
  c_45_v3_servertool_hook_skeleton_lifecycle_7 -->|v3-servertool-stopless-resp-03<br/>V3StoplessResp02RuntimeControlUpdated → V3StoplessResp03BusinessPayloadPreserved| c_45_v3_servertool_hook_skeleton_lifecycle_11
  c_45_v3_servertool_hook_skeleton_lifecycle_12 -->|v3-servertool-stopless-resp-04<br/>V3StoplessResp03BusinessPayloadPreserved → V3HubRespContinuation04Committed| c_45_v3_servertool_hook_skeleton_lifecycle_13
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-servertool-stopless-req-01` | `V3HubReqContinuation03Classified` → `V3HubReqChatProcess04Governed` | anchored | V3HubRelayRequestHooks::run_from_normalized<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small> | build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03<br/><small>routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs</small> | `v3.servertool_hook_skeleton_lifecycle` |
| `v3-servertool-stopless-req-02` | `V3HubReqChatProcess04Governed` → `V3StoplessReq01RuntimeControlLoaded` | anchored | load_v3_responses_relay_stopless_control_state<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_stopless.rs</small> | V3ResponsesRelayStoplessControlState::load_for_scope<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_types.rs</small> | `v3.servertool_hook_skeleton_lifecycle` |
| `v3-servertool-stopless-req-03` | `V3StoplessReq01RuntimeControlLoaded` → `V3StoplessReq02NoopCliConsumed` | anchored | apply_v3_stopless_request_hook_at_req04<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small> | active_stopless_cli_output<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small> | `v3.servertool_hook_skeleton_lifecycle` |
| `v3-servertool-stopless-req-04` | `V3StoplessReq02NoopCliConsumed` → `V3StoplessReq03ControlTransitioned` | anchored | apply_v3_stopless_request_hook_at_req04<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small> | V3StoplessCenterState::provider_turn_in_flight<br/><small>routecodex-v3-runtime/src/hub_v1/common.rs</small> | `v3.servertool_hook_skeleton_lifecycle` |
| `v3-servertool-stopless-resp-01` | `V3HubRespChatProcess03Governed` → `V3StoplessResp01ReasoningStopInspected` | anchored | apply_v3_stop_servertool_hook_at_resp03<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small> | response_has_stopless_stop_trigger<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small> | `v3.servertool_hook_skeleton_lifecycle` |
| `v3-servertool-stopless-resp-02` | `V3StoplessResp01ReasoningStopInspected` → `V3StoplessResp02RuntimeControlUpdated` | anchored | apply_v3_responses_relay_stopless_control_transition<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_stopless.rs</small> | V3ResponsesRelayStoplessControlState::store_for_scope<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_types.rs</small> | `v3.servertool_hook_skeleton_lifecycle` |
| `v3-servertool-stopless-resp-03` | `V3StoplessResp02RuntimeControlUpdated` → `V3StoplessResp03BusinessPayloadPreserved` | anchored | apply_v3_stop_servertool_hook_at_resp03<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small> | project_stopless_noop_for_stop_candidate<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small> | `v3.servertool_hook_skeleton_lifecycle` |
| `v3-servertool-stopless-resp-04` | `V3StoplessResp03BusinessPayloadPreserved` → `V3HubRespContinuation04Committed` | anchored | commit_v3_hub_relay_response<br/><small>routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs</small> | build_v3_relay_local_continuation_context_at_resp04<br/><small>routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs</small> | `v3.servertool_hook_skeleton_lifecycle` |

## v3.servertool_center.skeleton

Unified ServertoolCenter (MetadataCenter) skeleton. Tools (stopless/web_search/servertool CLI) are identified, state-loaded, and projected only through fixed Req04/Resp03 governance hooks; data plane stays logic-free.

Owner feature: `v3.servertool_center_skeleton`

```mermaid
flowchart TD
  subgraph c_46_v3_servertool_center_skeleton_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_46_v3_servertool_center_skeleton_0["v3-runtime::hub_v1<br/>V3HubRelayRequestHooks::run_from_normalized<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small>"]
    c_46_v3_servertool_center_skeleton_1["v3-runtime::hub_v1<br/>build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03<br/><small>routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs</small>"]
    c_46_v3_servertool_center_skeleton_2["v3-runtime::hub_v1<br/>govern_v3_servertool_request_at_req04<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small>"]
    c_46_v3_servertool_center_skeleton_3["v3-runtime::hub_v1<br/>apply_v3_web_search_request_hook_at_req04<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small>"]
    c_46_v3_servertool_center_skeleton_4["v3-runtime::hub_v1<br/>V3ServerToolCenter::load<br/><small>routecodex-v3-runtime/src/hub_v1/common.rs</small>"]
    c_46_v3_servertool_center_skeleton_5["v3-runtime::hub_v1<br/>V3ServerToolCenterKey<br/><small>routecodex-v3-runtime/src/hub_v1/common.rs</small>"]
    c_46_v3_servertool_center_skeleton_6["v3-runtime::hub_v1<br/>apply_v3_tool_call_servertool_hook_at_resp03<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small>"]
    c_46_v3_servertool_center_skeleton_7["v3-runtime::hub_v1<br/>first_local_websearch_tool_call<br/><small>routecodex-v3-runtime/src/hub_v1/web_search_hop.rs</small>"]
    c_46_v3_servertool_center_skeleton_8["v3-runtime::hub_v1<br/>V3ServerToolCenter::transition<br/><small>routecodex-v3-runtime/src/hub_v1/common.rs</small>"]
    c_46_v3_servertool_center_skeleton_9["v3-runtime::hub_v1<br/>V3ServerToolInstanceState<br/><small>routecodex-v3-runtime/src/hub_v1/common.rs</small>"]
    c_46_v3_servertool_center_skeleton_10["v3-runtime::hub_v1<br/>apply_v3_stop_servertool_hook_at_resp03<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small>"]
    c_46_v3_servertool_center_skeleton_11["v3-runtime::hub_v1<br/>V3StoplessResponseHookOutcome<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small>"]
  end
  c_46_v3_servertool_center_skeleton_0 -->|v3-servertool-center-req-01<br/>V3HubReqContinuation03Classified → V3HubReqChatProcess04Governed| c_46_v3_servertool_center_skeleton_1
  c_46_v3_servertool_center_skeleton_2 -->|v3-servertool-center-req-02<br/>V3HubReqChatProcess04Governed → V3ServertoolReq01ToolIdentified| c_46_v3_servertool_center_skeleton_3
  c_46_v3_servertool_center_skeleton_4 -->|v3-servertool-center-req-03<br/>V3ServertoolReq01ToolIdentified → V3ServertoolReq02StateLoaded| c_46_v3_servertool_center_skeleton_5
  c_46_v3_servertool_center_skeleton_6 -->|v3-servertool-center-resp-01<br/>V3HubRespChatProcess03Governed → V3ServertoolResp01ToolInspected| c_46_v3_servertool_center_skeleton_7
  c_46_v3_servertool_center_skeleton_8 -->|v3-servertool-center-resp-02<br/>V3ServertoolResp01ToolInspected → V3ServertoolResp02StateTransitioned| c_46_v3_servertool_center_skeleton_9
  c_46_v3_servertool_center_skeleton_10 -->|v3-servertool-center-resp-03<br/>V3ServertoolResp02StateTransitioned → V3ServertoolResp03Projected| c_46_v3_servertool_center_skeleton_11
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-servertool-center-req-01` | `V3HubReqContinuation03Classified` → `V3HubReqChatProcess04Governed` | anchored | V3HubRelayRequestHooks::run_from_normalized<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small> | build_v3_hub_req_chat_process_04_from_v3_hub_req_continuation_03<br/><small>routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs</small> | `v3.servertool_center_skeleton` |
| `v3-servertool-center-req-02` | `V3HubReqChatProcess04Governed` → `V3ServertoolReq01ToolIdentified` | anchored | govern_v3_servertool_request_at_req04<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small> | apply_v3_web_search_request_hook_at_req04<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small> | `v3.servertool_center_skeleton` |
| `v3-servertool-center-req-03` | `V3ServertoolReq01ToolIdentified` → `V3ServertoolReq02StateLoaded` | anchored | V3ServerToolCenter::load<br/><small>routecodex-v3-runtime/src/hub_v1/common.rs</small> | V3ServerToolCenterKey<br/><small>routecodex-v3-runtime/src/hub_v1/common.rs</small> | `v3.servertool_center_skeleton` |
| `v3-servertool-center-resp-01` | `V3HubRespChatProcess03Governed` → `V3ServertoolResp01ToolInspected` | anchored | apply_v3_tool_call_servertool_hook_at_resp03<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small> | first_local_websearch_tool_call<br/><small>routecodex-v3-runtime/src/hub_v1/web_search_hop.rs</small> | `v3.servertool_center_skeleton` |
| `v3-servertool-center-resp-02` | `V3ServertoolResp01ToolInspected` → `V3ServertoolResp02StateTransitioned` | anchored | V3ServerToolCenter::transition<br/><small>routecodex-v3-runtime/src/hub_v1/common.rs</small> | V3ServerToolInstanceState<br/><small>routecodex-v3-runtime/src/hub_v1/common.rs</small> | `v3.servertool_center_skeleton` |
| `v3-servertool-center-resp-03` | `V3ServertoolResp02StateTransitioned` → `V3ServertoolResp03Projected` | anchored | apply_v3_stop_servertool_hook_at_resp03<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small> | V3StoplessResponseHookOutcome<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small> | `v3.servertool_center_skeleton` |

## v3.direct_stopless_metadata_center

Direct-scoped StoplessCenter MetadataCenter control lifecycle for same-protocol /v1/responses Direct. Semantic owner remains StoplessCenterMetadataControl; Direct adapter handle is V3ResponsesDirectStoplessControlState. Control starts only after SameProtocolDirect decision; SSE is transport projection only.

Owner feature: `v3.direct_stopless_metadata_center`
Manifest: `docs/architecture/manifests/v3.servertool_hook_skeleton_lifecycle.mainline.yml`

```mermaid
flowchart TD
  subgraph c_47_v3_direct_stopless_metadata_center_m_v3_runtime["v3-runtime"]
    c_47_v3_direct_stopless_metadata_center_0["v3-runtime<br/>execute_v3_responses_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel.rs</small>"]
    c_47_v3_direct_stopless_metadata_center_1["v3-runtime<br/>prepare_v3_responses_direct_stopless_control_request<br/><small>routecodex-v3-runtime/src/kernel.rs</small>"]
    c_47_v3_direct_stopless_metadata_center_2["v3-runtime<br/>prepare_v3_responses_direct_stopless_control_request<br/><small>routecodex-v3-runtime/src/kernel/direct_stopless.rs</small>"]
    c_47_v3_direct_stopless_metadata_center_4["v3-runtime<br/>apply_v3_responses_direct_stopless_control_request_transition<br/><small>routecodex-v3-runtime/src/kernel/direct_stopless.rs</small>"]
    c_47_v3_direct_stopless_metadata_center_5["v3-runtime<br/>apply_v3_responses_direct_stopless_json_response_control<br/><small>routecodex-v3-runtime/src/kernel/direct_stopless.rs</small>"]
    c_47_v3_direct_stopless_metadata_center_6["v3-runtime<br/>run_v3_responses_direct_stopless_response_hooks<br/><small>routecodex-v3-runtime/src/kernel/direct_stopless.rs</small>"]
    c_47_v3_direct_stopless_metadata_center_7["v3-runtime<br/>apply_v3_responses_direct_stopless_control_response_transition<br/><small>routecodex-v3-runtime/src/kernel/direct_stopless.rs</small>"]
  end
  subgraph c_47_v3_direct_stopless_metadata_center_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_47_v3_direct_stopless_metadata_center_3["v3-runtime::hub_v1<br/>apply_v3_stopless_request_hook_at_req04<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small>"]
  end
  c_47_v3_direct_stopless_metadata_center_0 -->|v3-direct-stopless-req-01<br/>V3Execution11ProtocolDecision → V3DirectStoplessReq01RuntimeControlLoaded| c_47_v3_direct_stopless_metadata_center_1
  c_47_v3_direct_stopless_metadata_center_2 -->|v3-direct-stopless-req-02<br/>V3DirectStoplessReq01RuntimeControlLoaded → V3DirectStoplessReq02NoopCliConsumed| c_47_v3_direct_stopless_metadata_center_3
  c_47_v3_direct_stopless_metadata_center_2 -->|v3-direct-stopless-req-03<br/>V3DirectStoplessReq02NoopCliConsumed → V3DirectStoplessReq03GuidanceToolInjected| c_47_v3_direct_stopless_metadata_center_4
  c_47_v3_direct_stopless_metadata_center_5 -->|v3-direct-stopless-resp-01<br/>V3DirectResp14ProviderProjectionPrepared → V3DirectStoplessResp01EvidenceObserved| c_47_v3_direct_stopless_metadata_center_6
  c_47_v3_direct_stopless_metadata_center_5 -->|v3-direct-stopless-resp-02<br/>V3DirectStoplessResp01EvidenceObserved → V3DirectStoplessResp02RuntimeControlUpdated| c_47_v3_direct_stopless_metadata_center_7
  c_47_v3_direct_stopless_metadata_center_5 -->|v3-direct-stopless-resp-03<br/>V3DirectStoplessResp02RuntimeControlUpdated → V3DirectStoplessResp03NoopCliOrTerminalProjected| c_47_v3_direct_stopless_metadata_center_6
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-direct-stopless-req-01` | `V3Execution11ProtocolDecision` → `V3DirectStoplessReq01RuntimeControlLoaded` | anchored | execute_v3_responses_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | prepare_v3_responses_direct_stopless_control_request<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | `v3.direct_stopless_metadata_center` |
| `v3-direct-stopless-req-02` | `V3DirectStoplessReq01RuntimeControlLoaded` → `V3DirectStoplessReq02NoopCliConsumed` | anchored | prepare_v3_responses_direct_stopless_control_request<br/><small>routecodex-v3-runtime/src/kernel/direct_stopless.rs</small> | apply_v3_stopless_request_hook_at_req04<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small> | `v3.direct_stopless_metadata_center` |
| `v3-direct-stopless-req-03` | `V3DirectStoplessReq02NoopCliConsumed` → `V3DirectStoplessReq03GuidanceToolInjected` | anchored | prepare_v3_responses_direct_stopless_control_request<br/><small>routecodex-v3-runtime/src/kernel/direct_stopless.rs</small> | apply_v3_responses_direct_stopless_control_request_transition<br/><small>routecodex-v3-runtime/src/kernel/direct_stopless.rs</small> | `v3.direct_stopless_metadata_center` |
| `v3-direct-stopless-resp-01` | `V3DirectResp14ProviderProjectionPrepared` → `V3DirectStoplessResp01EvidenceObserved` | anchored | apply_v3_responses_direct_stopless_json_response_control<br/><small>routecodex-v3-runtime/src/kernel/direct_stopless.rs</small> | run_v3_responses_direct_stopless_response_hooks<br/><small>routecodex-v3-runtime/src/kernel/direct_stopless.rs</small> | `v3.direct_stopless_metadata_center` |
| `v3-direct-stopless-resp-02` | `V3DirectStoplessResp01EvidenceObserved` → `V3DirectStoplessResp02RuntimeControlUpdated` | anchored | apply_v3_responses_direct_stopless_json_response_control<br/><small>routecodex-v3-runtime/src/kernel/direct_stopless.rs</small> | apply_v3_responses_direct_stopless_control_response_transition<br/><small>routecodex-v3-runtime/src/kernel/direct_stopless.rs</small> | `v3.direct_stopless_metadata_center` |
| `v3-direct-stopless-resp-03` | `V3DirectStoplessResp02RuntimeControlUpdated` → `V3DirectStoplessResp03NoopCliOrTerminalProjected` | anchored | apply_v3_responses_direct_stopless_json_response_control<br/><small>routecodex-v3-runtime/src/kernel/direct_stopless.rs</small> | run_v3_responses_direct_stopless_response_hooks<br/><small>routecodex-v3-runtime/src/kernel/direct_stopless.rs</small> | `v3.direct_stopless_metadata_center` |

## v3.hub_relay.tool_servertool_multiturn_parity

Controlled Hub Relay tool/servertool multiturn parity over Rust Chat Process current-turn tool governance with immutable restored history, Req04 apply_patch feedback normalization, response tool harvest, Resp03 apply_patch freeform client projection, continuation commit, SSE ordering, and single response exit.

Owner feature: `v3.relay_tool_servertool_multiturn_parity_closeout`
Manifest: `docs/architecture/manifests/v3.hub_relay.tool_servertool_multiturn_parity.mainline.yml`

```mermaid
flowchart TD
  subgraph c_48_v3_hub_relay_tool_servertool_multiturn_parity_m_v3_runtime["v3-runtime"]
    c_48_v3_hub_relay_tool_servertool_multiturn_parity_0["v3-runtime<br/>request_governance_matches_function_custom_servertool_and_internal_tool_outputs_to_restored_context<br/><small>routecodex-v3-runtime/tests/hub_relay_tool_servertool_multiturn_parity.rs</small>"]
    c_48_v3_hub_relay_tool_servertool_multiturn_parity_2["v3-runtime<br/>request_governance_rejects_orphan_output_wrong_kind_and_missing_call_id<br/><small>routecodex-v3-runtime/tests/hub_relay_tool_servertool_multiturn_parity.rs</small>"]
    c_48_v3_hub_relay_tool_servertool_multiturn_parity_4["v3-runtime<br/>response_governance_classifies_function_custom_servertool_and_internal_tools_before_commit<br/><small>routecodex-v3-runtime/tests/hub_relay_tool_servertool_multiturn_parity.rs</small>"]
    c_48_v3_hub_relay_tool_servertool_multiturn_parity_7["v3-runtime<br/>responses_sse_arbitrary_chunks_preserve_delta_order_and_terminal_tool_order<br/><small>routecodex-v3-runtime/tests/hub_relay_tool_servertool_multiturn_parity.rs</small>"]
  end
  subgraph c_48_v3_hub_relay_tool_servertool_multiturn_parity_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_48_v3_hub_relay_tool_servertool_multiturn_parity_1["v3-runtime::hub_v1<br/>run_from_normalized<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small>"]
    c_48_v3_hub_relay_tool_servertool_multiturn_parity_3["v3-runtime::hub_v1<br/>govern_tool_outputs_at_req04<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small>"]
    c_48_v3_hub_relay_tool_servertool_multiturn_parity_5["v3-runtime::hub_v1<br/>govern_v3_hub_relay_response<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
    c_48_v3_hub_relay_tool_servertool_multiturn_parity_6["v3-runtime::hub_v1<br/>commit_v3_hub_relay_response<br/><small>routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs</small>"]
    c_48_v3_hub_relay_tool_servertool_multiturn_parity_8["v3-runtime::hub_v1<br/>build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05<br/><small>routecodex-v3-runtime/src/hub_v1/server_resp_outbound_06_client_frame.rs</small>"]
  end
  c_48_v3_hub_relay_tool_servertool_multiturn_parity_0 -->|v3-relay-tool-parity-01<br/>V3HubReqContinuation03Classified → V3HubReqChatProcess04Governed| c_48_v3_hub_relay_tool_servertool_multiturn_parity_1
  c_48_v3_hub_relay_tool_servertool_multiturn_parity_2 -->|v3-relay-tool-parity-02<br/>V3HubReqContinuation03Classified → V3HubReqChatProcess04Governed| c_48_v3_hub_relay_tool_servertool_multiturn_parity_3
  c_48_v3_hub_relay_tool_servertool_multiturn_parity_4 -->|v3-relay-tool-parity-04<br/>V3HubRespInbound02Normalized → V3HubRespChatProcess03Governed| c_48_v3_hub_relay_tool_servertool_multiturn_parity_5
  c_48_v3_hub_relay_tool_servertool_multiturn_parity_4 -->|v3-relay-tool-parity-05<br/>V3HubRespChatProcess03Governed → V3HubRespContinuation04Committed| c_48_v3_hub_relay_tool_servertool_multiturn_parity_6
  c_48_v3_hub_relay_tool_servertool_multiturn_parity_7 -->|v3-relay-tool-parity-06<br/>V3HubRespOutbound05ClientSemantic → V3ServerRespOutbound06ClientFrame| c_48_v3_hub_relay_tool_servertool_multiturn_parity_8
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-relay-tool-parity-01` | `V3HubReqContinuation03Classified` → `V3HubReqChatProcess04Governed` | anchored | request_governance_matches_function_custom_servertool_and_internal_tool_outputs_to_restored_context<br/><small>routecodex-v3-runtime/tests/hub_relay_tool_servertool_multiturn_parity.rs</small> | run_from_normalized<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small> | `v3.relay_tool_servertool_multiturn_parity_closeout` |
| `v3-relay-tool-parity-02` | `V3HubReqContinuation03Classified` → `V3HubReqChatProcess04Governed` | anchored | request_governance_rejects_orphan_output_wrong_kind_and_missing_call_id<br/><small>routecodex-v3-runtime/tests/hub_relay_tool_servertool_multiturn_parity.rs</small> | govern_tool_outputs_at_req04<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small> | `v3.relay_tool_servertool_multiturn_parity_closeout` |
| `v3-relay-tool-parity-04` | `V3HubRespInbound02Normalized` → `V3HubRespChatProcess03Governed` | anchored | response_governance_classifies_function_custom_servertool_and_internal_tools_before_commit<br/><small>routecodex-v3-runtime/tests/hub_relay_tool_servertool_multiturn_parity.rs</small> | govern_v3_hub_relay_response<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | `v3.relay_tool_servertool_multiturn_parity_closeout` |
| `v3-relay-tool-parity-05` | `V3HubRespChatProcess03Governed` → `V3HubRespContinuation04Committed` | anchored | response_governance_classifies_function_custom_servertool_and_internal_tools_before_commit<br/><small>routecodex-v3-runtime/tests/hub_relay_tool_servertool_multiturn_parity.rs</small> | commit_v3_hub_relay_response<br/><small>routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs</small> | `v3.relay_tool_servertool_multiturn_parity_closeout` |
| `v3-relay-tool-parity-06` | `V3HubRespOutbound05ClientSemantic` → `V3ServerRespOutbound06ClientFrame` | anchored | responses_sse_arbitrary_chunks_preserve_delta_order_and_terminal_tool_order<br/><small>routecodex-v3-runtime/tests/hub_relay_tool_servertool_multiturn_parity.rs</small> | build_v3_server_resp_outbound_06_from_v3_hub_resp_outbound_05<br/><small>routecodex-v3-runtime/src/hub_v1/server_resp_outbound_06_client_frame.rs</small> | `v3.relay_tool_servertool_multiturn_parity_closeout` |

## v3.resp03_tool_governance_gap_closeout

Resp03 response small skeleton: provider-neutral text harvest and tool-frame repair occur before finish_reason branch; tool_call branch runs servertool hook before ordinary governance; stop branch runs a distinct stop hook; Resp04 only saves the governed continuation truth.

Owner feature: `v3.resp03_tool_governance_gap_closeout`
Manifest: `docs/architecture/manifests/v3.resp03_tool_governance_gap_closeout.mainline.yml`

```mermaid
flowchart TD
  subgraph c_49_v3_resp03_tool_governance_gap_closeout_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_49_v3_resp03_tool_governance_gap_closeout_0["v3-runtime::hub_v1<br/>govern_v3_hub_relay_response<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
    c_49_v3_resp03_tool_governance_gap_closeout_1["v3-runtime::hub_v1<br/>complete_or_repair_v3_resp03_tool_frames<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
    c_49_v3_resp03_tool_governance_gap_closeout_2["v3-runtime::hub_v1<br/>inspect_v3_resp03_finish_reason<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
    c_49_v3_resp03_tool_governance_gap_closeout_3["v3-runtime::hub_v1<br/>apply_v3_tool_call_servertool_hook_at_resp03<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small>"]
    c_49_v3_resp03_tool_governance_gap_closeout_4["v3-runtime::hub_v1<br/>project_v3_apply_patch_freeform_calls_at_resp03<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
    c_49_v3_resp03_tool_governance_gap_closeout_5["v3-runtime::hub_v1<br/>apply_v3_stop_servertool_hook_at_resp03<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small>"]
    c_49_v3_resp03_tool_governance_gap_closeout_6["v3-runtime::hub_v1<br/>commit_v3_hub_relay_response<br/><small>routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs</small>"]
    c_49_v3_resp03_tool_governance_gap_closeout_7["v3-runtime::hub_v1<br/>V3HubRelayCanonicalResponseContext<br/><small>routecodex-v3-runtime/src/hub_v1/common.rs</small>"]
  end
  c_49_v3_resp03_tool_governance_gap_closeout_0 -->|v3-resp03-tool-governance-01<br/>V3HubRespInbound02Normalized → V3HubRespChatProcess03Governed| c_49_v3_resp03_tool_governance_gap_closeout_1
  c_49_v3_resp03_tool_governance_gap_closeout_0 -->|v3-resp03-tool-governance-02<br/>V3HubRespChatProcess03Governed → V3Resp03FinishReasonBranch| c_49_v3_resp03_tool_governance_gap_closeout_2
  c_49_v3_resp03_tool_governance_gap_closeout_0 -->|v3-resp03-tool-governance-03<br/>V3Resp03FinishReasonBranch → V3Resp03ToolCallServertoolHook| c_49_v3_resp03_tool_governance_gap_closeout_3
  c_49_v3_resp03_tool_governance_gap_closeout_0 -->|v3-resp03-tool-governance-04<br/>V3Resp03ToolCallServertoolHook → V3Resp03OrdinaryToolGovernance| c_49_v3_resp03_tool_governance_gap_closeout_4
  c_49_v3_resp03_tool_governance_gap_closeout_0 -->|v3-resp03-tool-governance-05<br/>V3Resp03FinishReasonBranch → V3Resp03StopServertoolHook| c_49_v3_resp03_tool_governance_gap_closeout_5
  c_49_v3_resp03_tool_governance_gap_closeout_6 -->|v3-resp03-tool-governance-06<br/>V3HubRespChatProcess03Governed → V3HubRespContinuation04Committed| c_49_v3_resp03_tool_governance_gap_closeout_7
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-resp03-tool-governance-01` | `V3HubRespInbound02Normalized` → `V3HubRespChatProcess03Governed` | anchored | govern_v3_hub_relay_response<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | complete_or_repair_v3_resp03_tool_frames<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | `v3.resp03_tool_governance_gap_closeout` |
| `v3-resp03-tool-governance-02` | `V3HubRespChatProcess03Governed` → `V3Resp03FinishReasonBranch` | anchored | govern_v3_hub_relay_response<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | inspect_v3_resp03_finish_reason<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | `v3.resp03_tool_governance_gap_closeout` |
| `v3-resp03-tool-governance-03` | `V3Resp03FinishReasonBranch` → `V3Resp03ToolCallServertoolHook` | anchored | govern_v3_hub_relay_response<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | apply_v3_tool_call_servertool_hook_at_resp03<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small> | `v3.resp03_tool_governance_gap_closeout` |
| `v3-resp03-tool-governance-04` | `V3Resp03ToolCallServertoolHook` → `V3Resp03OrdinaryToolGovernance` | anchored | govern_v3_hub_relay_response<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | project_v3_apply_patch_freeform_calls_at_resp03<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | `v3.resp03_tool_governance_gap_closeout` |
| `v3-resp03-tool-governance-05` | `V3Resp03FinishReasonBranch` → `V3Resp03StopServertoolHook` | anchored | govern_v3_hub_relay_response<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | apply_v3_stop_servertool_hook_at_resp03<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small> | `v3.resp03_tool_governance_gap_closeout` |
| `v3-resp03-tool-governance-06` | `V3HubRespChatProcess03Governed` → `V3HubRespContinuation04Committed` | anchored | commit_v3_hub_relay_response<br/><small>routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs</small> | V3HubRelayCanonicalResponseContext<br/><small>routecodex-v3-runtime/src/hub_v1/common.rs</small> | `v3.resp03_tool_governance_gap_closeout` |

## v3.live_provider_compat.parity

Docs/verifier lifecycle for V3 live provider compatibility parity; it indexes endpoint/transport/provider evidence and projects production blockers without touching runtime or live config.

Owner feature: `v3.live_provider_compat_parity_closeout`
Manifest: `docs/architecture/manifests/v3.live_provider_compat.parity.yml`

```mermaid
flowchart TD
  subgraph c_50_v3_live_provider_compat_parity_m_docs["docs"]
    c_50_v3_live_provider_compat_parity_2["docs<br/>v3.live_provider_compat.parity<br/><small>docs/architecture/wiki/v3-live-provider-compat-parity.md</small>"]
    c_50_v3_live_provider_compat_parity_3["docs<br/>v3.live_provider_compat_parity_closeout<br/><small>docs/architecture/v3-verification-map.yml</small>"]
  end
  subgraph c_50_v3_live_provider_compat_parity_m_docs__manifest["docs::manifest"]
    c_50_v3_live_provider_compat_parity_1["docs::manifest<br/>lifecycle_id<br/><small>docs/architecture/manifests/v3.live_provider_compat.parity.yml</small>"]
  end
  subgraph c_50_v3_live_provider_compat_parity_m_scripts["scripts"]
    c_50_v3_live_provider_compat_parity_0["scripts<br/>verifierName<br/><small>scripts/architecture/verify-v3-live-provider-compat-parity.mjs</small>"]
  end
  c_50_v3_live_provider_compat_parity_0 -->|v3-live-compat-01<br/>V3LiveCompat01MatrixDeclared → V3LiveCompat02ControlledEvidenceBound| c_50_v3_live_provider_compat_parity_1
  c_50_v3_live_provider_compat_parity_0 -->|v3-live-compat-02<br/>V3LiveCompat02ControlledEvidenceBound → V3LiveCompat03LiveEvidenceBound| c_50_v3_live_provider_compat_parity_2
  c_50_v3_live_provider_compat_parity_0 -->|v3-live-compat-03<br/>V3LiveCompat03LiveEvidenceBound → V3LiveCompat04ProductionReadinessProjected| c_50_v3_live_provider_compat_parity_3
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-live-compat-01` | `V3LiveCompat01MatrixDeclared` → `V3LiveCompat02ControlledEvidenceBound` | anchored | verifierName<br/><small>scripts/architecture/verify-v3-live-provider-compat-parity.mjs</small> | lifecycle_id<br/><small>docs/architecture/manifests/v3.live_provider_compat.parity.yml</small> | `v3.live_provider_compat_parity_closeout` |
| `v3-live-compat-02` | `V3LiveCompat02ControlledEvidenceBound` → `V3LiveCompat03LiveEvidenceBound` | anchored | verifierName<br/><small>scripts/architecture/verify-v3-live-provider-compat-parity.mjs</small> | v3.live_provider_compat.parity<br/><small>docs/architecture/wiki/v3-live-provider-compat-parity.md</small> | `v3.live_provider_compat_parity_closeout` |
| `v3-live-compat-03` | `V3LiveCompat03LiveEvidenceBound` → `V3LiveCompat04ProductionReadinessProjected` | anchored | verifierName<br/><small>scripts/architecture/verify-v3-live-provider-compat-parity.mjs</small> | v3.live_provider_compat_parity_closeout<br/><small>docs/architecture/v3-verification-map.yml</small> | `v3.live_provider_compat_parity_closeout` |

## v3.responses.inbound_websocket_proxy

Client-facing Responses WebSocket mode enters RouteCodex through a Server upgrade/framing shell, then dispatches to the configured Responses Direct or Relay Runtime and Provider transport owners.

Owner feature: `v3.responses_inbound_websocket_proxy`
Manifest: `docs/architecture/manifests/v3.responses_inbound_websocket_proxy.mainline.yml`

```mermaid
flowchart TD
  subgraph c_51_v3_responses_inbound_websocket_proxy_m_v3_runtime["v3-runtime"]
    c_51_v3_responses_inbound_websocket_proxy_3["v3-runtime<br/>build_v3_server_03_http_request_raw<br/><small>routecodex-v3-runtime/src/nodes.rs</small>"]
  end
  subgraph c_51_v3_responses_inbound_websocket_proxy_m_v3_server["v3-server"]
    c_51_v3_responses_inbound_websocket_proxy_0["v3-server<br/>responses_websocket_endpoint<br/><small>routecodex-v3-server/src/websocket.rs</small>"]
    c_51_v3_responses_inbound_websocket_proxy_1["v3-server<br/>responses_websocket_session<br/><small>routecodex-v3-server/src/websocket.rs</small>"]
    c_51_v3_responses_inbound_websocket_proxy_2["v3-server<br/>responses_websocket_create_payload<br/><small>routecodex-v3-server/src/websocket.rs</small>"]
    c_51_v3_responses_inbound_websocket_proxy_4["v3-server<br/>handle_responses_websocket_message_with_mode<br/><small>routecodex-v3-server/src/websocket.rs</small>"]
    c_51_v3_responses_inbound_websocket_proxy_5["v3-server<br/>execute_responses_relay_websocket_output<br/><small>routecodex-v3-server/src/websocket.rs</small>"]
    c_51_v3_responses_inbound_websocket_proxy_6["v3-server<br/>send_responses_websocket_frame<br/><small>routecodex-v3-server/src/websocket.rs</small>"]
    c_51_v3_responses_inbound_websocket_proxy_7["v3-server<br/>send_responses_relay_websocket_output<br/><small>routecodex-v3-server/src/websocket.rs</small>"]
  end
  c_51_v3_responses_inbound_websocket_proxy_0 -->|v3-inws-01<br/>V3ResponsesInboundWs01ClientUpgrade → V3ResponsesInboundWs02CreateEventParsed| c_51_v3_responses_inbound_websocket_proxy_1
  c_51_v3_responses_inbound_websocket_proxy_2 -->|v3-inws-02<br/>V3ResponsesInboundWs02CreateEventParsed → V3Server03HttpRequestRaw| c_51_v3_responses_inbound_websocket_proxy_3
  c_51_v3_responses_inbound_websocket_proxy_4 -->|v3-inws-03<br/>V3Server03HttpRequestRaw → V3Resp15ClientPayload| c_51_v3_responses_inbound_websocket_proxy_5
  c_51_v3_responses_inbound_websocket_proxy_6 -->|v3-inws-04<br/>V3Resp15ClientPayload → V3ResponsesInboundWs04ClientEventProjected| c_51_v3_responses_inbound_websocket_proxy_7
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-inws-01` | `V3ResponsesInboundWs01ClientUpgrade` → `V3ResponsesInboundWs02CreateEventParsed` | anchored | responses_websocket_endpoint<br/><small>routecodex-v3-server/src/websocket.rs</small> | responses_websocket_session<br/><small>routecodex-v3-server/src/websocket.rs</small> | `v3.responses_inbound_websocket_proxy` |
| `v3-inws-02` | `V3ResponsesInboundWs02CreateEventParsed` → `V3Server03HttpRequestRaw` | anchored | responses_websocket_create_payload<br/><small>routecodex-v3-server/src/websocket.rs</small> | build_v3_server_03_http_request_raw<br/><small>routecodex-v3-runtime/src/nodes.rs</small> | `v3.responses_inbound_websocket_proxy` |
| `v3-inws-03` | `V3Server03HttpRequestRaw` → `V3Resp15ClientPayload` | anchored | handle_responses_websocket_message_with_mode<br/><small>routecodex-v3-server/src/websocket.rs</small> | execute_responses_relay_websocket_output<br/><small>routecodex-v3-server/src/websocket.rs</small> | `v3.responses_inbound_websocket_proxy` |
| `v3-inws-04` | `V3Resp15ClientPayload` → `V3ResponsesInboundWs04ClientEventProjected` | anchored | send_responses_websocket_frame<br/><small>routecodex-v3-server/src/websocket.rs</small> | send_responses_relay_websocket_output<br/><small>routecodex-v3-server/src/websocket.rs</small> | `v3.responses_inbound_websocket_proxy` |

## v3.protocol_normalization_tool_governance_boundary

V3 protocol normalization boundary: protocol codecs perform mapping and shape checks only; Req04 and Resp Chat Process govern nodes own tool identity pairing and uniqueness; Provider compat nodes are skeleton contracts that forbid tool governance and fallback repair.

Owner feature: `v3.protocol_normalization_tool_governance_boundary`
Manifest: `docs/architecture/manifests/v3.protocol_normalization_tool_governance_boundary.mainline.yml`

```mermaid
flowchart TD
  subgraph c_52_v3_protocol_normalization_tool_governance_boundary_m_v3_runtime["v3-runtime"]
    c_52_v3_protocol_normalization_tool_governance_boundary_0["v3-runtime<br/>request_tool_identity_pairing_is_not_normalization<br/><small>routecodex-v3-runtime/tests/hub_openai_chat_codec_characterization.rs</small>"]
    c_52_v3_protocol_normalization_tool_governance_boundary_2["v3-runtime<br/>function_response_identity_pairing_is_not_normalization<br/><small>routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs</small>"]
    c_52_v3_protocol_normalization_tool_governance_boundary_4["v3-runtime<br/>openai_chat_tool_identity_is_governed_at_req04_after_normalization<br/><small>routecodex-v3-runtime/tests/hub_relay_request_semantics.rs</small>"]
    c_52_v3_protocol_normalization_tool_governance_boundary_6["v3-runtime<br/>gemini_function_response_identity_is_governed_at_req04_after_normalization<br/><small>routecodex-v3-runtime/tests/hub_relay_request_semantics.rs</small>"]
    c_52_v3_protocol_normalization_tool_governance_boundary_7["v3-runtime<br/>response_tool_identity_pairing_is_not_inbound_normalization<br/><small>routecodex-v3-runtime/tests/hub_openai_chat_codec_characterization.rs</small>"]
    c_52_v3_protocol_normalization_tool_governance_boundary_9["v3-runtime<br/>duplicate_response_tool_identity_fails_inside_response_chat_process<br/><small>routecodex-v3-runtime/tests/hub_relay_response_semantics.rs</small>"]
  end
  subgraph c_52_v3_protocol_normalization_tool_governance_boundary_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_52_v3_protocol_normalization_tool_governance_boundary_1["v3-runtime::hub_v1<br/>characterize_v3_openai_chat_client_input_to_hub_semantic<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_codec.rs</small>"]
    c_52_v3_protocol_normalization_tool_governance_boundary_3["v3-runtime::hub_v1<br/>characterize_v3_gemini_client_input_to_hub_semantic<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_codec.rs</small>"]
    c_52_v3_protocol_normalization_tool_governance_boundary_5["v3-runtime::hub_v1<br/>govern_protocol_tool_identity_at_req04<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small>"]
    c_52_v3_protocol_normalization_tool_governance_boundary_8["v3-runtime::hub_v1<br/>characterize_v3_openai_chat_provider_raw_to_hub_response_semantic<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_codec.rs</small>"]
    c_52_v3_protocol_normalization_tool_governance_boundary_10["v3-runtime::hub_v1<br/>govern_v3_hub_relay_response<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
    c_52_v3_protocol_normalization_tool_governance_boundary_11["v3-runtime::hub_v1<br/>all_adjacent_builders_form_the_fixed_typed_topology<br/><small>routecodex-v3-runtime/src/hub_v1/tests.rs</small>"]
    c_52_v3_protocol_normalization_tool_governance_boundary_12["v3-runtime::hub_v1<br/>build_provider_req_compat_06_from_v3_hub_req_outbound_07<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs</small>"]
    c_52_v3_protocol_normalization_tool_governance_boundary_13["v3-runtime::hub_v1<br/>build_provider_resp_compat_02_from_v3_provider_resp_inbound_01<br/><small>routecodex-v3-runtime/src/hub_v1/provider_resp_compat_02_provider_compat.rs</small>"]
  end
  c_52_v3_protocol_normalization_tool_governance_boundary_0 -->|v3-protocol-boundary-req-01<br/>V3OpenAiChatClientInput01Raw → V3OpenAiChatHubRequest02Semantic| c_52_v3_protocol_normalization_tool_governance_boundary_1
  c_52_v3_protocol_normalization_tool_governance_boundary_2 -->|v3-protocol-boundary-req-02<br/>V3GeminiClientInput01Raw → V3GeminiHubRequest02Semantic| c_52_v3_protocol_normalization_tool_governance_boundary_3
  c_52_v3_protocol_normalization_tool_governance_boundary_4 -->|v3-protocol-boundary-req-03<br/>V3HubReqContinuation03Classified → V3HubReqChatProcess04Governed| c_52_v3_protocol_normalization_tool_governance_boundary_5
  c_52_v3_protocol_normalization_tool_governance_boundary_6 -->|v3-protocol-boundary-req-04<br/>V3HubReqContinuation03Classified → V3HubReqChatProcess04Governed| c_52_v3_protocol_normalization_tool_governance_boundary_5
  c_52_v3_protocol_normalization_tool_governance_boundary_7 -->|v3-protocol-boundary-resp-01<br/>V3OpenAiChatProviderRaw04Response → V3OpenAiChatHubResponse05Semantic| c_52_v3_protocol_normalization_tool_governance_boundary_8
  c_52_v3_protocol_normalization_tool_governance_boundary_9 -->|v3-protocol-boundary-resp-02<br/>V3HubRespInbound02Normalized → V3HubRespChatProcess03Governed| c_52_v3_protocol_normalization_tool_governance_boundary_10
  c_52_v3_protocol_normalization_tool_governance_boundary_11 -->|v3-protocol-boundary-compat-01<br/>HubReqOutbound05ProviderSemantic → ProviderReqCompat06ProviderCompat| c_52_v3_protocol_normalization_tool_governance_boundary_12
  c_52_v3_protocol_normalization_tool_governance_boundary_11 -->|v3-protocol-boundary-compat-02<br/>ProviderRespInbound01Raw → ProviderRespCompat02ProviderCompat| c_52_v3_protocol_normalization_tool_governance_boundary_13
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-protocol-boundary-req-01` | `V3OpenAiChatClientInput01Raw` → `V3OpenAiChatHubRequest02Semantic` | anchored | request_tool_identity_pairing_is_not_normalization<br/><small>routecodex-v3-runtime/tests/hub_openai_chat_codec_characterization.rs</small> | characterize_v3_openai_chat_client_input_to_hub_semantic<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_codec.rs</small> | `v3.protocol_normalization_tool_governance_boundary` |
| `v3-protocol-boundary-req-02` | `V3GeminiClientInput01Raw` → `V3GeminiHubRequest02Semantic` | anchored | function_response_identity_pairing_is_not_normalization<br/><small>routecodex-v3-runtime/tests/hub_gemini_codec_characterization.rs</small> | characterize_v3_gemini_client_input_to_hub_semantic<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_codec.rs</small> | `v3.protocol_normalization_tool_governance_boundary` |
| `v3-protocol-boundary-req-03` | `V3HubReqContinuation03Classified` → `V3HubReqChatProcess04Governed` | anchored | openai_chat_tool_identity_is_governed_at_req04_after_normalization<br/><small>routecodex-v3-runtime/tests/hub_relay_request_semantics.rs</small> | govern_protocol_tool_identity_at_req04<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small> | `v3.protocol_normalization_tool_governance_boundary` |
| `v3-protocol-boundary-req-04` | `V3HubReqContinuation03Classified` → `V3HubReqChatProcess04Governed` | anchored | gemini_function_response_identity_is_governed_at_req04_after_normalization<br/><small>routecodex-v3-runtime/tests/hub_relay_request_semantics.rs</small> | govern_protocol_tool_identity_at_req04<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small> | `v3.protocol_normalization_tool_governance_boundary` |
| `v3-protocol-boundary-resp-01` | `V3OpenAiChatProviderRaw04Response` → `V3OpenAiChatHubResponse05Semantic` | anchored | response_tool_identity_pairing_is_not_inbound_normalization<br/><small>routecodex-v3-runtime/tests/hub_openai_chat_codec_characterization.rs</small> | characterize_v3_openai_chat_provider_raw_to_hub_response_semantic<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_codec.rs</small> | `v3.protocol_normalization_tool_governance_boundary` |
| `v3-protocol-boundary-resp-02` | `V3HubRespInbound02Normalized` → `V3HubRespChatProcess03Governed` | anchored | duplicate_response_tool_identity_fails_inside_response_chat_process<br/><small>routecodex-v3-runtime/tests/hub_relay_response_semantics.rs</small> | govern_v3_hub_relay_response<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | `v3.protocol_normalization_tool_governance_boundary` |
| `v3-protocol-boundary-compat-01` | `HubReqOutbound05ProviderSemantic` → `ProviderReqCompat06ProviderCompat` | anchored | all_adjacent_builders_form_the_fixed_typed_topology<br/><small>routecodex-v3-runtime/src/hub_v1/tests.rs</small> | build_provider_req_compat_06_from_v3_hub_req_outbound_07<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs</small> | `v3.protocol_normalization_tool_governance_boundary` |
| `v3-protocol-boundary-compat-02` | `ProviderRespInbound01Raw` → `ProviderRespCompat02ProviderCompat` | anchored | all_adjacent_builders_form_the_fixed_typed_topology<br/><small>routecodex-v3-runtime/src/hub_v1/tests.rs</small> | build_provider_resp_compat_02_from_v3_provider_resp_inbound_01<br/><small>routecodex-v3-runtime/src/hub_v1/provider_resp_compat_02_provider_compat.rs</small> | `v3.protocol_normalization_tool_governance_boundary` |

## v3.selected_provider_model_binding

Target selection freezes provider/model truth; one shared Rust binding block projects selected wire_model for Direct and Relay; Provider12 validates equality and never repairs.

Owner feature: `v3.route_selected_provider_model_binding`
Manifest: `docs/architecture/manifests/v3.selected_provider_model_binding.mainline.yml`

```mermaid
flowchart TD
  subgraph c_53_v3_selected_provider_model_binding_m_provider_compat_core["provider-compat-core"]
    c_53_v3_selected_provider_model_binding_5["provider-compat-core<br/>run_req_outbound_stage3_compat<br/><small>provider-compat-core/src/lib.rs</small>"]
  end
  subgraph c_53_v3_selected_provider_model_binding_m_v3_provider_responses["v3-provider-responses"]
    c_53_v3_selected_provider_model_binding_2["v3-provider-responses<br/>build_v3_provider_12_responses_wire_payload<br/><small>routecodex-v3-provider-responses/src/wire.rs</small>"]
  end
  subgraph c_53_v3_selected_provider_model_binding_m_v3_runtime["v3-runtime"]
    c_53_v3_selected_provider_model_binding_0["v3-runtime<br/>responses_direct_request_projection_hook<br/><small>routecodex-v3-runtime/src/hooks.rs</small>"]
    c_53_v3_selected_provider_model_binding_1["v3-runtime<br/>bind_v3_selected_provider_model<br/><small>routecodex-v3-runtime/src/selected_provider_model_binding.rs</small>"]
  end
  subgraph c_53_v3_selected_provider_model_binding_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_53_v3_selected_provider_model_binding_3["v3-runtime::hub_v1<br/>build_v3_provider_standard_protocol_payload_from_req07<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs</small>"]
    c_53_v3_selected_provider_model_binding_4["v3-runtime::hub_v1<br/>apply_v3_provider_req_compat<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs</small>"]
  end
  c_53_v3_selected_provider_model_binding_0 -->|v3-model-bind-01<br/>V3Target10ConcreteProviderSelected → V3SelectedProviderModelBindingBlock| c_53_v3_selected_provider_model_binding_1
  c_53_v3_selected_provider_model_binding_0 -->|v3-model-bind-02<br/>V3SelectedProviderModelBindingBlock → V3Provider12ResponsesWirePayload| c_53_v3_selected_provider_model_binding_2
  c_53_v3_selected_provider_model_binding_3 -->|v3-model-bind-03<br/>V3HubReqOutbound07ProviderSemantic → V3SelectedProviderModelBindingBlock| c_53_v3_selected_provider_model_binding_1
  c_53_v3_selected_provider_model_binding_4 -->|v3-model-bind-04<br/>V3SelectedProviderModelBindingBlock → ProviderReqCompat06ProviderCompat| c_53_v3_selected_provider_model_binding_5
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-model-bind-01` | `V3Target10ConcreteProviderSelected` → `V3SelectedProviderModelBindingBlock` | anchored | responses_direct_request_projection_hook<br/><small>routecodex-v3-runtime/src/hooks.rs</small> | bind_v3_selected_provider_model<br/><small>routecodex-v3-runtime/src/selected_provider_model_binding.rs</small> | `v3.route_selected_provider_model_binding` |
| `v3-model-bind-02` | `V3SelectedProviderModelBindingBlock` → `V3Provider12ResponsesWirePayload` | anchored | responses_direct_request_projection_hook<br/><small>routecodex-v3-runtime/src/hooks.rs</small> | build_v3_provider_12_responses_wire_payload<br/><small>routecodex-v3-provider-responses/src/wire.rs</small> | `v3.route_selected_provider_model_binding` |
| `v3-model-bind-03` | `V3HubReqOutbound07ProviderSemantic` → `V3SelectedProviderModelBindingBlock` | anchored | build_v3_provider_standard_protocol_payload_from_req07<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs</small> | bind_v3_selected_provider_model<br/><small>routecodex-v3-runtime/src/selected_provider_model_binding.rs</small> | `v3.route_selected_provider_model_binding` |
| `v3-model-bind-04` | `V3SelectedProviderModelBindingBlock` → `ProviderReqCompat06ProviderCompat` | anchored | apply_v3_provider_req_compat<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs</small> | run_req_outbound_stage3_compat<br/><small>provider-compat-core/src/lib.rs</small> | `v3.route_selected_provider_model_binding` |

## v3.web_search_servertool_state_machine

web_search route activates only from current-turn evidence; ServerTool state manager owns search-only dispatch, follow-up marker, and paired tool-result injection; provider compat owns only provider wire shape.

Owner feature: `v3.web_search_servertool_state_machine`
Manifest: `docs/goals/v3-web-search-servertool-state-machine-proposal.md`

```mermaid
flowchart TD
  subgraph c_54_v3_web_search_servertool_state_machine_m_pending["pending"]
    c_54_v3_web_search_servertool_state_machine_0["pending<br/>pending<br/><small>pending</small>"]
  end
  c_54_v3_web_search_servertool_state_machine_0 -->|v3-web-search-sm-01<br/>HubReqChatProcess03Governed → V3WebSearch01RouteEvidenceClassified| c_54_v3_web_search_servertool_state_machine_0
  c_54_v3_web_search_servertool_state_machine_0 -->|v3-web-search-sm-02<br/>V3WebSearch01RouteEvidenceClassified → VrRoute04SelectedTarget| c_54_v3_web_search_servertool_state_machine_0
  c_54_v3_web_search_servertool_state_machine_0 -->|v3-web-search-sm-03<br/>HubRespChatProcess03Governed → V3ServerToolState01ControlScope| c_54_v3_web_search_servertool_state_machine_0
  c_54_v3_web_search_servertool_state_machine_0 -->|v3-web-search-sm-04<br/>V3ServerToolState01ControlScope → V3WebSearch02SearchDispatchPrepared| c_54_v3_web_search_servertool_state_machine_0
  c_54_v3_web_search_servertool_state_machine_0 -->|v3-web-search-sm-05<br/>V3WebSearch02SearchDispatchPrepared → ProviderReqOutbound06WirePayload| c_54_v3_web_search_servertool_state_machine_0
  c_54_v3_web_search_servertool_state_machine_0 -->|v3-web-search-sm-06<br/>HubRespChatProcess03Governed → V3WebSearch03SearchResultCaptured| c_54_v3_web_search_servertool_state_machine_0
  c_54_v3_web_search_servertool_state_machine_0 -->|v3-web-search-sm-07<br/>V3WebSearch03SearchResultCaptured → HubRespOutbound04ClientSemantic| c_54_v3_web_search_servertool_state_machine_0
  c_54_v3_web_search_servertool_state_machine_0 -->|v3-web-search-sm-08<br/>HubReqChatProcess03Governed → V3WebSearch04ToolResultInjected| c_54_v3_web_search_servertool_state_machine_0
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-web-search-sm-01` | `HubReqChatProcess03Governed` → `V3WebSearch01RouteEvidenceClassified` | binding_pending | pending<br/><small>pending</small> | pending<br/><small>pending</small> | `v3.web_search_servertool_state_machine` |
| `v3-web-search-sm-02` | `V3WebSearch01RouteEvidenceClassified` → `VrRoute04SelectedTarget` | binding_pending | pending<br/><small>pending</small> | pending<br/><small>pending</small> | `v3.web_search_servertool_state_machine` |
| `v3-web-search-sm-03` | `HubRespChatProcess03Governed` → `V3ServerToolState01ControlScope` | binding_pending | pending<br/><small>pending</small> | pending<br/><small>pending</small> | `v3.web_search_servertool_state_machine` |
| `v3-web-search-sm-04` | `V3ServerToolState01ControlScope` → `V3WebSearch02SearchDispatchPrepared` | binding_pending | pending<br/><small>pending</small> | pending<br/><small>pending</small> | `v3.web_search_servertool_state_machine` |
| `v3-web-search-sm-05` | `V3WebSearch02SearchDispatchPrepared` → `ProviderReqOutbound06WirePayload` | binding_pending | pending<br/><small>pending</small> | pending<br/><small>pending</small> | `v3.web_search_servertool_state_machine` |
| `v3-web-search-sm-06` | `HubRespChatProcess03Governed` → `V3WebSearch03SearchResultCaptured` | binding_pending | pending<br/><small>pending</small> | pending<br/><small>pending</small> | `v3.web_search_servertool_state_machine` |
| `v3-web-search-sm-07` | `V3WebSearch03SearchResultCaptured` → `HubRespOutbound04ClientSemantic` | binding_pending | pending<br/><small>pending</small> | pending<br/><small>pending</small> | `v3.web_search_servertool_state_machine` |
| `v3-web-search-sm-08` | `HubReqChatProcess03Governed` → `V3WebSearch04ToolResultInjected` | binding_pending | pending<br/><small>pending</small> | pending<br/><small>pending</small> | `v3.web_search_servertool_state_machine` |

## v3.console_request_count_visibility.mainline

One aggregate-owned request counter handle is shared by every listener, and one atomic V3 request identity allocation carries total and local-day counts into both human request and terminal response headlines.

Owner feature: `v3.console_request_count_visibility`
Manifest: `docs/architecture/manifests/v3.console_request_count_visibility.mainline.yml`

```mermaid
flowchart TD
  subgraph c_55_v3_console_request_count_visibility_mainline_m_v3_server["v3-server"]
    c_55_v3_console_request_count_visibility_mainline_0["v3-server<br/>spawn_v3_server_aggregate<br/><small>routecodex-v3-server/src/lib.rs</small>"]
    c_55_v3_console_request_count_visibility_mainline_1["v3-server<br/>V3RequestIdCounter::new<br/><small>routecodex-v3-server/src/lib.rs</small>"]
    c_55_v3_console_request_count_visibility_mainline_2["v3-server<br/>next_v3_console_request_identity<br/><small>routecodex-v3-server/src/endpoint_handlers.rs</small>"]
    c_55_v3_console_request_count_visibility_mainline_3["v3-server<br/>next_request_identity<br/><small>routecodex-v3-server/src/request_id.rs</small>"]
    c_55_v3_console_request_count_visibility_mainline_4["v3-server<br/>render_v3_request_console_block<br/><small>routecodex-v3-server/src/console/impl_bulk.rs</small>"]
    c_55_v3_console_request_count_visibility_mainline_5["v3-server<br/>format_v3_console_request_count<br/><small>routecodex-v3-server/src/console/impl_bulk.rs</small>"]
    c_55_v3_console_request_count_visibility_mainline_6["v3-server<br/>render_v3_response_console_block<br/><small>routecodex-v3-server/src/console/impl_bulk.rs</small>"]
  end
  c_55_v3_console_request_count_visibility_mainline_0 -->|v3-console-count-01<br/>V3RequestCounter01AggregateOwned → V3RequestCounter02ListenerShared| c_55_v3_console_request_count_visibility_mainline_1
  c_55_v3_console_request_count_visibility_mainline_2 -->|v3-console-count-02<br/>V3RequestCounter02ListenerShared → V3RequestIdentity03Allocated| c_55_v3_console_request_count_visibility_mainline_3
  c_55_v3_console_request_count_visibility_mainline_4 -->|v3-console-count-03<br/>V3RequestIdentity03Allocated → V3ConsoleReq02HumanBlock| c_55_v3_console_request_count_visibility_mainline_5
  c_55_v3_console_request_count_visibility_mainline_6 -->|v3-console-count-04<br/>V3RequestIdentity03Allocated → V3ConsoleResp03HumanBlock| c_55_v3_console_request_count_visibility_mainline_5
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-console-count-01` | `V3RequestCounter01AggregateOwned` → `V3RequestCounter02ListenerShared` | anchored | spawn_v3_server_aggregate<br/><small>routecodex-v3-server/src/lib.rs</small> | V3RequestIdCounter::new<br/><small>routecodex-v3-server/src/lib.rs</small> | `v3.console_request_count_visibility` |
| `v3-console-count-02` | `V3RequestCounter02ListenerShared` → `V3RequestIdentity03Allocated` | anchored | next_v3_console_request_identity<br/><small>routecodex-v3-server/src/endpoint_handlers.rs</small> | next_request_identity<br/><small>routecodex-v3-server/src/request_id.rs</small> | `v3.console_request_count_visibility` |
| `v3-console-count-03` | `V3RequestIdentity03Allocated` → `V3ConsoleReq02HumanBlock` | anchored | render_v3_request_console_block<br/><small>routecodex-v3-server/src/console/impl_bulk.rs</small> | format_v3_console_request_count<br/><small>routecodex-v3-server/src/console/impl_bulk.rs</small> | `v3.console_request_count_visibility` |
| `v3-console-count-04` | `V3RequestIdentity03Allocated` → `V3ConsoleResp03HumanBlock` | anchored | render_v3_response_console_block<br/><small>routecodex-v3-server/src/console/impl_bulk.rs</small> | format_v3_console_request_count<br/><small>routecodex-v3-server/src/console/impl_bulk.rs</small> | `v3.console_request_count_visibility` |

## v3.console_human_readable_layering.mainline

Runtime-created route/provider failure observations flow through diagnostic side-channel sinks to Server-owned realtime human console projection; final observability only backfills missing events and terminal closeout.

Owner feature: `v3.console_human_readable_layering`
Manifest: `docs/architecture/manifests/v3.console_human_readable_layering.mainline.yml`

```mermaid
flowchart TD
  subgraph c_56_v3_console_human_readable_layering_mainline_m_v3_runtime["v3-runtime"]
    c_56_v3_console_human_readable_layering_mainline_4["v3-runtime<br/>publish_v3_direct_provider_failure_event<br/><small>routecodex-v3-runtime/src/kernel.rs</small>"]
    c_56_v3_console_human_readable_layering_mainline_5["v3-runtime<br/>V3RuntimeProviderFailureEventSink<br/><small>routecodex-v3-runtime/src/kernel.rs</small>"]
    c_56_v3_console_human_readable_layering_mainline_6["v3-runtime<br/>execute_v3_responses_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel.rs</small>"]
    c_56_v3_console_human_readable_layering_mainline_7["v3-runtime<br/>V3RuntimeRouteSelectionEventSink<br/><small>routecodex-v3-runtime/src/kernel.rs</small>"]
  end
  subgraph c_56_v3_console_human_readable_layering_mainline_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_56_v3_console_human_readable_layering_mainline_0["v3-runtime::hub_v1<br/>handle_v3_responses_relay_provider_failure<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs</small>"]
    c_56_v3_console_human_readable_layering_mainline_1["v3-runtime::hub_v1<br/>V3RuntimeProviderFailureEventSink<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_types.rs</small>"]
    c_56_v3_console_human_readable_layering_mainline_2["v3-runtime::hub_v1<br/>execute_v3_responses_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs</small>"]
    c_56_v3_console_human_readable_layering_mainline_3["v3-runtime::hub_v1<br/>V3RuntimeRouteSelectionEventSink<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_types.rs</small>"]
  end
  subgraph c_56_v3_console_human_readable_layering_mainline_m_v3_server["v3-server"]
    c_56_v3_console_human_readable_layering_mainline_8["v3-server<br/>build_v3_route_selection_event_sink<br/><small>routecodex-v3-server/src/console/impl_bulk.rs</small>"]
    c_56_v3_console_human_readable_layering_mainline_9["v3-server<br/>emit_v3_request_route_hit_console_line_for_observability<br/><small>routecodex-v3-server/src/console/impl_bulk.rs</small>"]
    c_56_v3_console_human_readable_layering_mainline_10["v3-server<br/>build_v3_provider_failure_event_sink<br/><small>routecodex-v3-server/src/console/impl_bulk.rs</small>"]
    c_56_v3_console_human_readable_layering_mainline_11["v3-server<br/>emit_v3_provider_failure_console_event<br/><small>routecodex-v3-server/src/console/impl_bulk.rs</small>"]
  end
  c_56_v3_console_human_readable_layering_mainline_0 -->|v3-console-realtime-01<br/>V3RuntimeProviderFailureObservation → V3RuntimeProviderFailureEventSink| c_56_v3_console_human_readable_layering_mainline_1
  c_56_v3_console_human_readable_layering_mainline_2 -->|v3-console-realtime-02<br/>V3RuntimeRouteSelectionObservation → V3RuntimeRouteSelectionEventSink| c_56_v3_console_human_readable_layering_mainline_3
  c_56_v3_console_human_readable_layering_mainline_4 -->|v3-console-realtime-03<br/>V3RuntimeProviderFailureObservation → V3RuntimeProviderFailureEventSink| c_56_v3_console_human_readable_layering_mainline_5
  c_56_v3_console_human_readable_layering_mainline_6 -->|v3-console-realtime-04<br/>V3RuntimeRouteSelectionObservation → V3RuntimeRouteSelectionEventSink| c_56_v3_console_human_readable_layering_mainline_7
  c_56_v3_console_human_readable_layering_mainline_8 -->|v3-console-realtime-05<br/>V3RuntimeRouteSelectionEventSink → V3ConsoleReq02HumanBlock| c_56_v3_console_human_readable_layering_mainline_9
  c_56_v3_console_human_readable_layering_mainline_10 -->|v3-console-realtime-06<br/>V3RuntimeProviderFailureEventSink → V3ConsoleProvider04ExceptionalBlock| c_56_v3_console_human_readable_layering_mainline_11
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-console-realtime-01` | `V3RuntimeProviderFailureObservation` → `V3RuntimeProviderFailureEventSink` | anchored | handle_v3_responses_relay_provider_failure<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs</small> | V3RuntimeProviderFailureEventSink<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_types.rs</small> | `v3.console_human_readable_layering` |
| `v3-console-realtime-02` | `V3RuntimeRouteSelectionObservation` → `V3RuntimeRouteSelectionEventSink` | anchored | execute_v3_responses_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs</small> | V3RuntimeRouteSelectionEventSink<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_types.rs</small> | `v3.console_human_readable_layering` |
| `v3-console-realtime-03` | `V3RuntimeProviderFailureObservation` → `V3RuntimeProviderFailureEventSink` | anchored | publish_v3_direct_provider_failure_event<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | V3RuntimeProviderFailureEventSink<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | `v3.console_human_readable_layering` |
| `v3-console-realtime-04` | `V3RuntimeRouteSelectionObservation` → `V3RuntimeRouteSelectionEventSink` | anchored | execute_v3_responses_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | V3RuntimeRouteSelectionEventSink<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | `v3.console_human_readable_layering` |
| `v3-console-realtime-05` | `V3RuntimeRouteSelectionEventSink` → `V3ConsoleReq02HumanBlock` | anchored | build_v3_route_selection_event_sink<br/><small>routecodex-v3-server/src/console/impl_bulk.rs</small> | emit_v3_request_route_hit_console_line_for_observability<br/><small>routecodex-v3-server/src/console/impl_bulk.rs</small> | `v3.console_human_readable_layering` |
| `v3-console-realtime-06` | `V3RuntimeProviderFailureEventSink` → `V3ConsoleProvider04ExceptionalBlock` | anchored | build_v3_provider_failure_event_sink<br/><small>routecodex-v3-server/src/console/impl_bulk.rs</small> | emit_v3_provider_failure_console_event<br/><small>routecodex-v3-server/src/console/impl_bulk.rs</small> | `v3.console_human_readable_layering` |

## v3.runtime_timing_observability.mainline

Responses Direct/Relay Runtime starts one monotonic state, accumulates every provider attempt, publishes only at governed terminal or Direct SSE clean EOF, and exposes a read-only Server projection.

Owner feature: `v3.runtime_timing_observability`
Manifest: `docs/architecture/manifests/v3.runtime_timing_observability.mainline.yml`

```mermaid
flowchart TD
  subgraph c_57_v3_runtime_timing_observability_mainline_m_v3_runtime["v3-runtime"]
    c_57_v3_runtime_timing_observability_mainline_1["v3-runtime<br/>start_external<br/><small>routecodex-v3-runtime/src/runtime_timing.rs</small>"]
    c_57_v3_runtime_timing_observability_mainline_2["v3-runtime<br/>finish_external<br/><small>routecodex-v3-runtime/src/runtime_timing.rs</small>"]
    c_57_v3_runtime_timing_observability_mainline_3["v3-runtime<br/>finish_runtime<br/><small>routecodex-v3-runtime/src/runtime_timing.rs</small>"]
    c_57_v3_runtime_timing_observability_mainline_7["v3-runtime<br/>execute_v3_responses_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel.rs</small>"]
    c_57_v3_runtime_timing_observability_mainline_10["v3-runtime<br/>wrap_direct_sse_provider_event_json_observation_stream<br/><small>routecodex-v3-runtime/src/kernel.rs</small>"]
    c_57_v3_runtime_timing_observability_mainline_11["v3-runtime<br/>wrap_direct_sse_provider_outcome_stream<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs</small>"]
    c_57_v3_runtime_timing_observability_mainline_12["v3-runtime<br/>with_additional_attempts<br/><small>routecodex-v3-runtime/src/runtime_timing.rs</small>"]
  end
  subgraph c_57_v3_runtime_timing_observability_mainline_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_57_v3_runtime_timing_observability_mainline_0["v3-runtime::hub_v1<br/>execute_v3_responses_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs</small>"]
    c_57_v3_runtime_timing_observability_mainline_4["v3-runtime::hub_v1<br/>record_timing<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_types.rs</small>"]
    c_57_v3_runtime_timing_observability_mainline_14["v3-runtime::hub_v1<br/>execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_stopless_control_input_and_initial_target<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs</small>"]
  end
  subgraph c_57_v3_runtime_timing_observability_mainline_m_v3_server["v3-server"]
    c_57_v3_runtime_timing_observability_mainline_5["v3-server<br/>complete_relay_sse<br/><small>routecodex-v3-server/src/console/impl_bulk.rs</small>"]
    c_57_v3_runtime_timing_observability_mainline_6["v3-server<br/>merge_v3_runtime_stream_observation<br/><small>routecodex-v3-server/src/console/impl_bulk.rs</small>"]
    c_57_v3_runtime_timing_observability_mainline_8["v3-server<br/>emit_relay_sse_complete_console_lines<br/><small>routecodex-v3-server/src/console/impl_bulk.rs</small>"]
    c_57_v3_runtime_timing_observability_mainline_9["v3-server<br/>emit_v3_request_complete_console_line<br/><small>routecodex-v3-server/src/console/impl_bulk.rs</small>"]
    c_57_v3_runtime_timing_observability_mainline_13["v3-server<br/>execute_responses_direct_server_outcome<br/><small>routecodex-v3-server/src/responses_direct_server_outcome.rs</small>"]
  end
  c_57_v3_runtime_timing_observability_mainline_0 -->|v3-runtime-timing-01<br/>V3RuntimeTimingStart → V3RuntimeTimingExternalAttempt| c_57_v3_runtime_timing_observability_mainline_1
  c_57_v3_runtime_timing_observability_mainline_0 -->|v3-runtime-timing-02<br/>V3RuntimeTimingExternalAttempt → V3RuntimeTimingExternalComplete| c_57_v3_runtime_timing_observability_mainline_2
  c_57_v3_runtime_timing_observability_mainline_0 -->|v3-runtime-timing-03<br/>V3RuntimeTimingExternalComplete → V3RuntimeTimingExternalAttempt| c_57_v3_runtime_timing_observability_mainline_1
  c_57_v3_runtime_timing_observability_mainline_0 -->|v3-runtime-timing-04<br/>V3RuntimeTimingExternalComplete → V3RuntimeTimingTerminal| c_57_v3_runtime_timing_observability_mainline_3
  c_57_v3_runtime_timing_observability_mainline_0 -->|v3-runtime-timing-05<br/>V3RuntimeTimingTerminal → V3RuntimeTimingStreamObservation| c_57_v3_runtime_timing_observability_mainline_4
  c_57_v3_runtime_timing_observability_mainline_5 -->|v3-runtime-timing-06<br/>V3RuntimeTimingStreamObservation → V3RuntimeTimingServerProjection| c_57_v3_runtime_timing_observability_mainline_6
  c_57_v3_runtime_timing_observability_mainline_7 -->|v3-runtime-timing-07<br/>V3RuntimeTimingTerminal → V3RuntimeTimingObservability| c_57_v3_runtime_timing_observability_mainline_3
  c_57_v3_runtime_timing_observability_mainline_8 -->|v3-runtime-timing-08<br/>V3RuntimeTimingObservability → V3RuntimeTimingServerProjection| c_57_v3_runtime_timing_observability_mainline_9
  c_57_v3_runtime_timing_observability_mainline_7 -->|v3-runtime-timing-09<br/>V3RuntimeTimingStart → V3RuntimeTimingExternalAttempt| c_57_v3_runtime_timing_observability_mainline_1
  c_57_v3_runtime_timing_observability_mainline_10 -->|v3-runtime-timing-10<br/>V3RuntimeTimingExternalAttempt → V3RuntimeTimingExternalComplete| c_57_v3_runtime_timing_observability_mainline_2
  c_57_v3_runtime_timing_observability_mainline_11 -->|v3-runtime-timing-11<br/>V3RuntimeTimingExternalComplete → V3RuntimeTimingTerminal| c_57_v3_runtime_timing_observability_mainline_3
  c_57_v3_runtime_timing_observability_mainline_11 -->|v3-runtime-timing-12<br/>V3RuntimeTimingTerminal → V3RuntimeTimingStreamObservation| c_57_v3_runtime_timing_observability_mainline_4
  c_57_v3_runtime_timing_observability_mainline_7 -->|v3-runtime-timing-13<br/>V3RuntimeTimingExternalComplete → V3RuntimeTimingProtocolHandoff| c_57_v3_runtime_timing_observability_mainline_12
  c_57_v3_runtime_timing_observability_mainline_13 -->|v3-runtime-timing-14<br/>V3RuntimeTimingProtocolHandoff → V3RuntimeTimingExternalAttempt| c_57_v3_runtime_timing_observability_mainline_14
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-runtime-timing-01` | `V3RuntimeTimingStart` → `V3RuntimeTimingExternalAttempt` | anchored | execute_v3_responses_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs</small> | start_external<br/><small>routecodex-v3-runtime/src/runtime_timing.rs</small> | `v3.runtime_timing_observability` |
| `v3-runtime-timing-02` | `V3RuntimeTimingExternalAttempt` → `V3RuntimeTimingExternalComplete` | anchored | execute_v3_responses_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs</small> | finish_external<br/><small>routecodex-v3-runtime/src/runtime_timing.rs</small> | `v3.runtime_timing_observability` |
| `v3-runtime-timing-03` | `V3RuntimeTimingExternalComplete` → `V3RuntimeTimingExternalAttempt` | anchored | execute_v3_responses_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs</small> | start_external<br/><small>routecodex-v3-runtime/src/runtime_timing.rs</small> | `v3.runtime_timing_observability` |
| `v3-runtime-timing-04` | `V3RuntimeTimingExternalComplete` → `V3RuntimeTimingTerminal` | anchored | execute_v3_responses_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs</small> | finish_runtime<br/><small>routecodex-v3-runtime/src/runtime_timing.rs</small> | `v3.runtime_timing_observability` |
| `v3-runtime-timing-05` | `V3RuntimeTimingTerminal` → `V3RuntimeTimingStreamObservation` | anchored | execute_v3_responses_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs</small> | record_timing<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_types.rs</small> | `v3.runtime_timing_observability` |
| `v3-runtime-timing-06` | `V3RuntimeTimingStreamObservation` → `V3RuntimeTimingServerProjection` | anchored | complete_relay_sse<br/><small>routecodex-v3-server/src/console/impl_bulk.rs</small> | merge_v3_runtime_stream_observation<br/><small>routecodex-v3-server/src/console/impl_bulk.rs</small> | `v3.runtime_timing_observability` |
| `v3-runtime-timing-07` | `V3RuntimeTimingTerminal` → `V3RuntimeTimingObservability` | anchored | execute_v3_responses_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | finish_runtime<br/><small>routecodex-v3-runtime/src/runtime_timing.rs</small> | `v3.runtime_timing_observability` |
| `v3-runtime-timing-08` | `V3RuntimeTimingObservability` → `V3RuntimeTimingServerProjection` | anchored | emit_relay_sse_complete_console_lines<br/><small>routecodex-v3-server/src/console/impl_bulk.rs</small> | emit_v3_request_complete_console_line<br/><small>routecodex-v3-server/src/console/impl_bulk.rs</small> | `v3.runtime_timing_observability` |
| `v3-runtime-timing-09` | `V3RuntimeTimingStart` → `V3RuntimeTimingExternalAttempt` | anchored | execute_v3_responses_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | start_external<br/><small>routecodex-v3-runtime/src/runtime_timing.rs</small> | `v3.runtime_timing_observability` |
| `v3-runtime-timing-10` | `V3RuntimeTimingExternalAttempt` → `V3RuntimeTimingExternalComplete` | anchored | wrap_direct_sse_provider_event_json_observation_stream<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | finish_external<br/><small>routecodex-v3-runtime/src/runtime_timing.rs</small> | `v3.runtime_timing_observability` |
| `v3-runtime-timing-11` | `V3RuntimeTimingExternalComplete` → `V3RuntimeTimingTerminal` | anchored | wrap_direct_sse_provider_outcome_stream<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs</small> | finish_runtime<br/><small>routecodex-v3-runtime/src/runtime_timing.rs</small> | `v3.runtime_timing_observability` |
| `v3-runtime-timing-12` | `V3RuntimeTimingTerminal` → `V3RuntimeTimingStreamObservation` | anchored | wrap_direct_sse_provider_outcome_stream<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs</small> | record_timing<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_types.rs</small> | `v3.runtime_timing_observability` |
| `v3-runtime-timing-13` | `V3RuntimeTimingExternalComplete` → `V3RuntimeTimingProtocolHandoff` | anchored | execute_v3_responses_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | with_additional_attempts<br/><small>routecodex-v3-runtime/src/runtime_timing.rs</small> | `v3.runtime_timing_observability` |
| `v3-runtime-timing-14` | `V3RuntimeTimingProtocolHandoff` → `V3RuntimeTimingExternalAttempt` | anchored | execute_responses_direct_server_outcome<br/><small>routecodex-v3-server/src/responses_direct_server_outcome.rs</small> | execute_v3_responses_relay_runtime_with_default_transport_health_local_continuation_stopless_control_input_and_initial_target<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs</small> | `v3.runtime_timing_observability` |

## v3.responses_session_admission

The listener-local HTTP boundary admits one active Responses request per explicit session or conversation, rejects overlap through Error01-06 before Runtime/provider send, and holds the exact permit until the client response body reaches EOF, errors, or is dropped.

Owner feature: `v3.responses_session_inflight_admission`
Manifest: `docs/architecture/manifests/v3.responses_session_admission.mainline.yml`

```mermaid
flowchart TD
  subgraph c_58_v3_responses_session_admission_m_v3_error["v3-error"]
    c_58_v3_responses_session_admission_2["v3-error<br/>project_v3_http_boundary_error<br/><small>routecodex-v3-error/src/lib.rs</small>"]
  end
  subgraph c_58_v3_responses_session_admission_m_v3_server["v3-server"]
    c_58_v3_responses_session_admission_0["v3-server<br/>admit_v3_responses_session_after_json_parse<br/><small>routecodex-v3-server/src/lib.rs</small>"]
    c_58_v3_responses_session_admission_1["v3-server<br/>V3ResponsesSessionAdmissionGate::try_admit<br/><small>routecodex-v3-server/src/session_admission.rs</small>"]
    c_58_v3_responses_session_admission_3["v3-server<br/>pending_endpoint<br/><small>routecodex-v3-server/src/endpoint_handlers.rs</small>"]
    c_58_v3_responses_session_admission_4["v3-server<br/>hold_response_body_admission_permit<br/><small>routecodex-v3-server/src/session_admission.rs</small>"]
  end
  c_58_v3_responses_session_admission_0 -->|v3-responses-admission-01<br/>V3Server03HttpRequestRaw → V3Server03ResponsesSessionAdmissionBlock| c_58_v3_responses_session_admission_1
  c_58_v3_responses_session_admission_0 -->|v3-responses-admission-error-02<br/>V3Server03ResponsesSessionAdmissionBlock → V3Error01SourceRaised| c_58_v3_responses_session_admission_2
  c_58_v3_responses_session_admission_3 -->|v3-responses-admission-release-03<br/>V3Server03ResponsesSessionAdmissionBlock → V3ServerRespOutbound06ClientFrame| c_58_v3_responses_session_admission_4
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-responses-admission-01` | `V3Server03HttpRequestRaw` → `V3Server03ResponsesSessionAdmissionBlock` | anchored | admit_v3_responses_session_after_json_parse<br/><small>routecodex-v3-server/src/lib.rs</small> | V3ResponsesSessionAdmissionGate::try_admit<br/><small>routecodex-v3-server/src/session_admission.rs</small> | `v3.responses_session_inflight_admission` |
| `v3-responses-admission-error-02` | `V3Server03ResponsesSessionAdmissionBlock` → `V3Error01SourceRaised` | anchored | admit_v3_responses_session_after_json_parse<br/><small>routecodex-v3-server/src/lib.rs</small> | project_v3_http_boundary_error<br/><small>routecodex-v3-error/src/lib.rs</small> | `v3.responses_session_inflight_admission` |
| `v3-responses-admission-release-03` | `V3Server03ResponsesSessionAdmissionBlock` → `V3ServerRespOutbound06ClientFrame` | anchored | pending_endpoint<br/><small>routecodex-v3-server/src/endpoint_handlers.rs</small> | hold_response_body_admission_permit<br/><small>routecodex-v3-server/src/session_admission.rs</small> | `v3.responses_session_inflight_admission` |

## v3.sse.http_keepalive_boundary

Successful Direct and Relay Responses SSE adds transport-only initial and idle comments after client semantic projection; Error06 keeps event error as its first frame, and EOF/error/drop ends scheduling.

Owner feature: `v3.sse_http_keepalive_boundary`
Manifest: `docs/architecture/manifests/v3.sse.http_keepalive.mainline.yml`

```mermaid
flowchart TD
  subgraph c_59_v3_sse_http_keepalive_boundary_m_routecodex_v3_sse["routecodex-v3-sse"]
    c_59_v3_sse_http_keepalive_boundary_1["routecodex-v3-sse<br/>build_v3_sse_transport_out_04_keepalive_comment<br/><small>routecodex-v3-sse/src/lib.rs</small>"]
  end
  subgraph c_59_v3_sse_http_keepalive_boundary_m_v3_server["v3-server"]
    c_59_v3_sse_http_keepalive_boundary_0["v3-server<br/>v3_io_sse_body<br/><small>routecodex-v3-server/src/frame_builders.rs</small>"]
  end
  c_59_v3_sse_http_keepalive_boundary_0 -->|v3-sse-http-keepalive-01<br/>V3SseTransportOut04EncodedChunk → V3ServerRespOutbound06ClientFrame| c_59_v3_sse_http_keepalive_boundary_1
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-sse-http-keepalive-01` | `V3SseTransportOut04EncodedChunk` → `V3ServerRespOutbound06ClientFrame` | anchored | v3_io_sse_body<br/><small>routecodex-v3-server/src/frame_builders.rs</small> | build_v3_sse_transport_out_04_keepalive_comment<br/><small>routecodex-v3-sse/src/lib.rs</small> | `v3.sse_http_keepalive_boundary` |

## v3.provider_action_gate.mainline

V3 provider action gate serializes provider failure recovery, permit ownership, post-commit SSE success/failure observation, and provider response event-codec terminal evidence; the Server frame owner consumes typed Error01 and performs the sole Error06 client-protocol projection.

Owner feature: `v3.provider_action_gate`
Manifest: `docs/architecture/manifests/v3.provider_action_gate.mainline.yml`

```mermaid
flowchart TD
  subgraph c_60_v3_provider_action_gate_mainline_m_v3_runtime["v3-runtime"]
    c_60_v3_provider_action_gate_mainline_2["v3-runtime<br/>run_v3_relay_provider_failure_policy<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small>"]
    c_60_v3_provider_action_gate_mainline_3["v3-runtime<br/>V3ProviderFailureRuntimeHealth::record_provider_action_failure_in_scope<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small>"]
    c_60_v3_provider_action_gate_mainline_4["v3-runtime<br/>V3ProviderFailureRuntimeHealth::wait_for_error05_recovery<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small>"]
    c_60_v3_provider_action_gate_mainline_5["v3-runtime<br/>V3ProviderActionGate::wait_for_recovery_witness<br/><small>routecodex-v3-runtime/src/provider_action_gate.rs</small>"]
    c_60_v3_provider_action_gate_mainline_6["v3-runtime<br/>V3ProviderFailureRuntimeHealth::wait_for_terminal_provider_projection_in_scope<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small>"]
    c_60_v3_provider_action_gate_mainline_7["v3-runtime<br/>V3ProviderActionGate::record_failure_and_wait_for_terminal_projection<br/><small>routecodex-v3-runtime/src/provider_action_gate.rs</small>"]
    c_60_v3_provider_action_gate_mainline_8["v3-runtime<br/>V3ProviderActionGate::commit_terminal_admission<br/><small>routecodex-v3-runtime/src/provider_action_gate.rs</small>"]
    c_60_v3_provider_action_gate_mainline_9["v3-runtime<br/>V3ProviderFailureRuntimeHealth::wait_for_exact_selected_provider_action<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small>"]
    c_60_v3_provider_action_gate_mainline_10["v3-runtime<br/>V3ProviderActionGate::wait_for_exact_provider_action<br/><small>routecodex-v3-runtime/src/provider_action_gate.rs</small>"]
    c_60_v3_provider_action_gate_mainline_11["v3-runtime<br/>execute_v3_responses_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel.rs</small>"]
    c_60_v3_provider_action_gate_mainline_14["v3-runtime<br/>run_v3_direct_provider_failure_policy<br/><small>routecodex-v3-runtime/src/kernel/direct_runtime_helpers.rs</small>"]
    c_60_v3_provider_action_gate_mainline_16["v3-runtime<br/>V3ProviderActionAdmission::take_permit<br/><small>routecodex-v3-runtime/src/provider_action_gate.rs</small>"]
    c_60_v3_provider_action_gate_mainline_17["v3-runtime<br/>V3ProviderActionPermit::drop<br/><small>routecodex-v3-runtime/src/provider_action_gate.rs</small>"]
    c_60_v3_provider_action_gate_mainline_18["v3-runtime<br/>V3DirectSseProviderOutcome::record_failure<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs</small>"]
    c_60_v3_provider_action_gate_mainline_21["v3-runtime<br/>V3ProviderActionGate::abandon_admission<br/><small>routecodex-v3-runtime/src/provider_action_gate.rs</small>"]
    c_60_v3_provider_action_gate_mainline_22["v3-runtime<br/>wrap_direct_sse_provider_outcome_stream<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs</small>"]
    c_60_v3_provider_action_gate_mainline_23["v3-runtime<br/>V3DirectSseProviderOutcome::record_success<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs</small>"]
    c_60_v3_provider_action_gate_mainline_24["v3-runtime<br/>V3ProviderFailureRuntimeHealth::record_provider_success_in_failure_scope<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small>"]
    c_60_v3_provider_action_gate_mainline_25["v3-runtime<br/>V3ProviderFailureRuntimeHealth::record_post_commit_provider_stream_failure_from_source<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small>"]
    c_60_v3_provider_action_gate_mainline_28["v3-runtime<br/>V3ProviderFailureRuntimeHealth::record_post_commit_provider_stream_failure<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small>"]
    c_60_v3_provider_action_gate_mainline_32["v3-runtime<br/>V3DirectSseProviderOutcome::observe_chunk<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs</small>"]
    c_60_v3_provider_action_gate_mainline_33["v3-runtime<br/>V3DirectSseProviderOutcome::observe_frame<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs</small>"]
  end
  subgraph c_60_v3_provider_action_gate_mainline_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_60_v3_provider_action_gate_mainline_0["v3-runtime::hub_v1<br/>execute_v3_responses_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs</small>"]
    c_60_v3_provider_action_gate_mainline_1["v3-runtime::hub_v1<br/>handle_v3_responses_relay_provider_failure<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs</small>"]
    c_60_v3_provider_action_gate_mainline_12["v3-runtime::hub_v1<br/>execute_v3_anthropic_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small>"]
    c_60_v3_provider_action_gate_mainline_13["v3-runtime::hub_v1<br/>execute_v3_relay_runtime_core<br/><small>routecodex-v3-runtime/src/hub_v1/relay_runtime_core.rs</small>"]
    c_60_v3_provider_action_gate_mainline_15["v3-runtime::hub_v1<br/>handle_provider_failure<br/><small>routecodex-v3-runtime/src/hub_v1/relay_runtime_shared.rs</small>"]
    c_60_v3_provider_action_gate_mainline_19["v3-runtime::hub_v1<br/>V3OpenAiChatSseProviderOutcome::record_failure<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small>"]
    c_60_v3_provider_action_gate_mainline_20["v3-runtime::hub_v1<br/>V3GeminiSseProviderOutcome::record_failure<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small>"]
    c_60_v3_provider_action_gate_mainline_26["v3-runtime::hub_v1<br/>project_sse_stream<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small>"]
    c_60_v3_provider_action_gate_mainline_27["v3-runtime::hub_v1<br/>V3OpenAiChatSseProviderOutcome::record_success<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small>"]
    c_60_v3_provider_action_gate_mainline_29["v3-runtime::hub_v1<br/>project_sse_stream<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small>"]
    c_60_v3_provider_action_gate_mainline_30["v3-runtime::hub_v1<br/>V3GeminiSseProviderOutcome::record_success<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small>"]
    c_60_v3_provider_action_gate_mainline_31["v3-runtime::hub_v1<br/>record_provider_success_after_resp04<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small>"]
    c_60_v3_provider_action_gate_mainline_34["v3-runtime::hub_v1<br/>build_v3_hub_resp_inbound_02_from_responses_provider_stream_events<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/provider_stream_materialization.rs</small>"]
    c_60_v3_provider_action_gate_mainline_35["v3-runtime::hub_v1<br/>observe_v3_runtime_responses_sse_transport_chunk_typed<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/responses_provider_event_codec.rs</small>"]
    c_60_v3_provider_action_gate_mainline_36["v3-runtime::hub_v1<br/>observe_v3_runtime_responses_sse_semantic_frame_typed<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/responses_provider_event_codec.rs</small>"]
    c_60_v3_provider_action_gate_mainline_37["v3-runtime::hub_v1<br/>V3ResponsesSseReducerState::apply_event<br/><small>routecodex-v3-runtime/src/hub_v1/responses_sse_tree.rs</small>"]
  end
  c_60_v3_provider_action_gate_mainline_0 -->|v3-provider-action-gate-01<br/>ProviderReqCompat06ProviderCompat → V3Error05ExecutionDecision| c_60_v3_provider_action_gate_mainline_1
  c_60_v3_provider_action_gate_mainline_0 -->|v3-provider-action-gate-02<br/>V3ProviderReqOutbound08WirePayload → V3Error05ExecutionDecision| c_60_v3_provider_action_gate_mainline_1
  c_60_v3_provider_action_gate_mainline_2 -->|v3-provider-action-gate-03<br/>V3Error05ExecutionDecision → V3Error05RecoveryWitness| c_60_v3_provider_action_gate_mainline_3
  c_60_v3_provider_action_gate_mainline_4 -->|v3-provider-action-gate-04<br/>V3Error05RecoveryWitness → V3ProviderActionGateAdmission| c_60_v3_provider_action_gate_mainline_5
  c_60_v3_provider_action_gate_mainline_2 -->|v3-provider-action-gate-05<br/>V3Error05ExecutionDecision → V3ProviderActionGateTerminalAdmission| c_60_v3_provider_action_gate_mainline_6
  c_60_v3_provider_action_gate_mainline_7 -->|v3-provider-action-gate-06<br/>V3ProviderActionGateTerminalAdmission → V3ProviderActionGateTerminalCommitted| c_60_v3_provider_action_gate_mainline_8
  c_60_v3_provider_action_gate_mainline_9 -->|v3-provider-action-gate-07<br/>V3ProviderActionGateAdmission → V3ExecutionRetryOrReselect| c_60_v3_provider_action_gate_mainline_10
  c_60_v3_provider_action_gate_mainline_11 -->|v3-provider-action-gate-08<br/>V3Error05RecoveryWitness → V3ProviderActionGateAdmission| c_60_v3_provider_action_gate_mainline_4
  c_60_v3_provider_action_gate_mainline_11 -->|v3-provider-action-gate-09<br/>V3ExecutionRetryOrReselect → V3ProviderActionGateAdmission| c_60_v3_provider_action_gate_mainline_9
  c_60_v3_provider_action_gate_mainline_0 -->|v3-provider-action-gate-10<br/>V3Error05RecoveryWitness → V3ProviderActionGateAdmission| c_60_v3_provider_action_gate_mainline_4
  c_60_v3_provider_action_gate_mainline_12 -->|v3-provider-action-gate-11<br/>V3Error05RecoveryWitness → V3ProviderActionGateAdmission| c_60_v3_provider_action_gate_mainline_4
  c_60_v3_provider_action_gate_mainline_13 -->|v3-provider-action-gate-12<br/>V3Error05RecoveryWitness → V3ProviderActionGateAdmission| c_60_v3_provider_action_gate_mainline_4
  c_60_v3_provider_action_gate_mainline_13 -->|v3-provider-action-gate-13<br/>V3Error05RecoveryWitness → V3ProviderActionGateAdmission| c_60_v3_provider_action_gate_mainline_4
  c_60_v3_provider_action_gate_mainline_11 -->|v3-provider-action-gate-14<br/>V3Error01SourceRaised → V3Error05ExecutionDecision| c_60_v3_provider_action_gate_mainline_14
  c_60_v3_provider_action_gate_mainline_1 -->|v3-provider-action-gate-15<br/>V3Error01SourceRaised → V3Error05ExecutionDecision| c_60_v3_provider_action_gate_mainline_2
  c_60_v3_provider_action_gate_mainline_15 -->|v3-provider-action-gate-16<br/>V3Error01SourceRaised → V3Error05ExecutionDecision| c_60_v3_provider_action_gate_mainline_2
  c_60_v3_provider_action_gate_mainline_11 -->|v3-provider-action-gate-19<br/>V3ProviderActionGateAdmission → V3ProviderActionPermitInFlight| c_60_v3_provider_action_gate_mainline_16
  c_60_v3_provider_action_gate_mainline_0 -->|v3-provider-action-gate-20<br/>V3ProviderActionGateAdmission → V3ProviderActionPermitInFlight| c_60_v3_provider_action_gate_mainline_16
  c_60_v3_provider_action_gate_mainline_12 -->|v3-provider-action-gate-21<br/>V3ProviderActionGateAdmission → V3ProviderActionPermitInFlight| c_60_v3_provider_action_gate_mainline_16
  c_60_v3_provider_action_gate_mainline_13 -->|v3-provider-action-gate-22<br/>V3ProviderActionGateAdmission → V3ProviderActionPermitInFlight| c_60_v3_provider_action_gate_mainline_16
  c_60_v3_provider_action_gate_mainline_12 -->|v3-provider-action-gate-23<br/>V3ProviderActionGateAdmission → V3ProviderActionPermitInFlight| c_60_v3_provider_action_gate_mainline_16
  c_60_v3_provider_action_gate_mainline_11 -->|v3-provider-action-gate-24<br/>V3ProviderActionPermitInFlight → V3ProviderActionPermitAbandonRequested| c_60_v3_provider_action_gate_mainline_17
  c_60_v3_provider_action_gate_mainline_0 -->|v3-provider-action-gate-25<br/>V3ProviderActionPermitInFlight → V3ProviderActionPermitAbandonRequested| c_60_v3_provider_action_gate_mainline_17
  c_60_v3_provider_action_gate_mainline_12 -->|v3-provider-action-gate-26<br/>V3ProviderActionPermitInFlight → V3ProviderActionPermitAbandonRequested| c_60_v3_provider_action_gate_mainline_17
  c_60_v3_provider_action_gate_mainline_13 -->|v3-provider-action-gate-27<br/>V3ProviderActionPermitInFlight → V3ProviderActionPermitAbandonRequested| c_60_v3_provider_action_gate_mainline_17
  c_60_v3_provider_action_gate_mainline_12 -->|v3-provider-action-gate-28<br/>V3ProviderActionPermitInFlight → V3ProviderActionPermitAbandonRequested| c_60_v3_provider_action_gate_mainline_17
  c_60_v3_provider_action_gate_mainline_18 -->|v3-provider-action-gate-29<br/>V3ProviderActionPermitInFlight → V3ProviderActionPermitAbandonRequested| c_60_v3_provider_action_gate_mainline_17
  c_60_v3_provider_action_gate_mainline_19 -->|v3-provider-action-gate-30<br/>V3ProviderActionPermitInFlight → V3ProviderActionPermitAbandonRequested| c_60_v3_provider_action_gate_mainline_17
  c_60_v3_provider_action_gate_mainline_20 -->|v3-provider-action-gate-31<br/>V3ProviderActionPermitInFlight → V3ProviderActionPermitAbandonRequested| c_60_v3_provider_action_gate_mainline_17
  c_60_v3_provider_action_gate_mainline_17 -->|v3-provider-action-gate-32<br/>V3ProviderActionPermitAbandonRequested → V3ProviderActionPermitAbandoned| c_60_v3_provider_action_gate_mainline_21
  c_60_v3_provider_action_gate_mainline_22 -->|v3-provider-action-gate-33<br/>V3ProviderActionPermitInFlight → V3ProviderActionSuccessObserved| c_60_v3_provider_action_gate_mainline_23
  c_60_v3_provider_action_gate_mainline_23 -->|v3-provider-action-gate-34<br/>V3ProviderActionSuccessObserved → V3ProviderActionSuccessRecorded| c_60_v3_provider_action_gate_mainline_24
  c_60_v3_provider_action_gate_mainline_22 -->|v3-provider-action-gate-35<br/>V3ProviderActionPermitInFlight → V3ProviderActionFailureObserved| c_60_v3_provider_action_gate_mainline_18
  c_60_v3_provider_action_gate_mainline_18 -->|v3-provider-action-gate-36<br/>V3ProviderActionPermitAbandoned → V3ProviderActionFailureRecorded| c_60_v3_provider_action_gate_mainline_25
  c_60_v3_provider_action_gate_mainline_26 -->|v3-provider-action-gate-37<br/>V3ProviderActionPermitInFlight → V3ProviderActionSuccessObserved| c_60_v3_provider_action_gate_mainline_27
  c_60_v3_provider_action_gate_mainline_27 -->|v3-provider-action-gate-38<br/>V3ProviderActionSuccessObserved → V3ProviderActionSuccessRecorded| c_60_v3_provider_action_gate_mainline_24
  c_60_v3_provider_action_gate_mainline_26 -->|v3-provider-action-gate-39<br/>V3ProviderActionPermitInFlight → V3ProviderActionFailureObserved| c_60_v3_provider_action_gate_mainline_19
  c_60_v3_provider_action_gate_mainline_19 -->|v3-provider-action-gate-40<br/>V3ProviderActionPermitAbandoned → V3ProviderActionFailureRecorded| c_60_v3_provider_action_gate_mainline_28
  c_60_v3_provider_action_gate_mainline_29 -->|v3-provider-action-gate-41<br/>V3ProviderActionPermitInFlight → V3ProviderActionSuccessObserved| c_60_v3_provider_action_gate_mainline_30
  c_60_v3_provider_action_gate_mainline_30 -->|v3-provider-action-gate-42<br/>V3ProviderActionSuccessObserved → V3ProviderActionSuccessRecorded| c_60_v3_provider_action_gate_mainline_24
  c_60_v3_provider_action_gate_mainline_29 -->|v3-provider-action-gate-43<br/>V3ProviderActionPermitInFlight → V3ProviderActionFailureObserved| c_60_v3_provider_action_gate_mainline_20
  c_60_v3_provider_action_gate_mainline_20 -->|v3-provider-action-gate-44<br/>V3ProviderActionPermitAbandoned → V3ProviderActionFailureRecorded| c_60_v3_provider_action_gate_mainline_28
  c_60_v3_provider_action_gate_mainline_0 -->|v3-provider-action-gate-45<br/>V3ProviderActionPermitInFlight → V3ProviderActionSuccessRecorded| c_60_v3_provider_action_gate_mainline_24
  c_60_v3_provider_action_gate_mainline_12 -->|v3-provider-action-gate-46<br/>V3ProviderActionPermitInFlight → V3ProviderActionSuccessFinalize| c_60_v3_provider_action_gate_mainline_31
  c_60_v3_provider_action_gate_mainline_31 -->|v3-provider-action-gate-47<br/>V3ProviderActionSuccessFinalize → V3ProviderActionSuccessRecorded| c_60_v3_provider_action_gate_mainline_24
  c_60_v3_provider_action_gate_mainline_22 -->|v3-provider-action-gate-48<br/>V3ProviderRespInbound01Raw → V3ProviderResponsesEventCodec| c_60_v3_provider_action_gate_mainline_32
  c_60_v3_provider_action_gate_mainline_32 -->|v3-provider-action-gate-49<br/>V3ProviderResponsesEventCodec → V3ProviderResponsesTerminalOrFailureObserved| c_60_v3_provider_action_gate_mainline_33
  c_60_v3_provider_action_gate_mainline_34 -->|v3-provider-action-gate-50<br/>V3ProviderRespInbound01Raw → V3ProviderResponsesEventCodec| c_60_v3_provider_action_gate_mainline_35
  c_60_v3_provider_action_gate_mainline_36 -->|v3-provider-action-gate-51<br/>V3ProviderResponsesEventCodec → V3ProviderResponsesTerminalOrFailureObserved| c_60_v3_provider_action_gate_mainline_37
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-provider-action-gate-01` | `ProviderReqCompat06ProviderCompat` → `V3Error05ExecutionDecision` | anchored | execute_v3_responses_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs</small> | handle_v3_responses_relay_provider_failure<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-02` | `V3ProviderReqOutbound08WirePayload` → `V3Error05ExecutionDecision` | anchored | execute_v3_responses_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs</small> | handle_v3_responses_relay_provider_failure<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-03` | `V3Error05ExecutionDecision` → `V3Error05RecoveryWitness` | anchored | run_v3_relay_provider_failure_policy<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | V3ProviderFailureRuntimeHealth::record_provider_action_failure_in_scope<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-04` | `V3Error05RecoveryWitness` → `V3ProviderActionGateAdmission` | anchored | V3ProviderFailureRuntimeHealth::wait_for_error05_recovery<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | V3ProviderActionGate::wait_for_recovery_witness<br/><small>routecodex-v3-runtime/src/provider_action_gate.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-05` | `V3Error05ExecutionDecision` → `V3ProviderActionGateTerminalAdmission` | anchored | run_v3_relay_provider_failure_policy<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | V3ProviderFailureRuntimeHealth::wait_for_terminal_provider_projection_in_scope<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-06` | `V3ProviderActionGateTerminalAdmission` → `V3ProviderActionGateTerminalCommitted` | anchored | V3ProviderActionGate::record_failure_and_wait_for_terminal_projection<br/><small>routecodex-v3-runtime/src/provider_action_gate.rs</small> | V3ProviderActionGate::commit_terminal_admission<br/><small>routecodex-v3-runtime/src/provider_action_gate.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-07` | `V3ProviderActionGateAdmission` → `V3ExecutionRetryOrReselect` | anchored | V3ProviderFailureRuntimeHealth::wait_for_exact_selected_provider_action<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | V3ProviderActionGate::wait_for_exact_provider_action<br/><small>routecodex-v3-runtime/src/provider_action_gate.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-08` | `V3Error05RecoveryWitness` → `V3ProviderActionGateAdmission` | anchored | execute_v3_responses_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | V3ProviderFailureRuntimeHealth::wait_for_error05_recovery<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-09` | `V3ExecutionRetryOrReselect` → `V3ProviderActionGateAdmission` | anchored | execute_v3_responses_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | V3ProviderFailureRuntimeHealth::wait_for_exact_selected_provider_action<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-10` | `V3Error05RecoveryWitness` → `V3ProviderActionGateAdmission` | anchored | execute_v3_responses_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs</small> | V3ProviderFailureRuntimeHealth::wait_for_error05_recovery<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-11` | `V3Error05RecoveryWitness` → `V3ProviderActionGateAdmission` | anchored | execute_v3_anthropic_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | V3ProviderFailureRuntimeHealth::wait_for_error05_recovery<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-12` | `V3Error05RecoveryWitness` → `V3ProviderActionGateAdmission` | anchored | execute_v3_relay_runtime_core<br/><small>routecodex-v3-runtime/src/hub_v1/relay_runtime_core.rs</small> | V3ProviderFailureRuntimeHealth::wait_for_error05_recovery<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-13` | `V3Error05RecoveryWitness` → `V3ProviderActionGateAdmission` | anchored | execute_v3_relay_runtime_core<br/><small>routecodex-v3-runtime/src/hub_v1/relay_runtime_core.rs</small> | V3ProviderFailureRuntimeHealth::wait_for_error05_recovery<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-14` | `V3Error01SourceRaised` → `V3Error05ExecutionDecision` | anchored | execute_v3_responses_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | run_v3_direct_provider_failure_policy<br/><small>routecodex-v3-runtime/src/kernel/direct_runtime_helpers.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-15` | `V3Error01SourceRaised` → `V3Error05ExecutionDecision` | anchored | handle_v3_responses_relay_provider_failure<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime.rs</small> | run_v3_relay_provider_failure_policy<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-16` | `V3Error01SourceRaised` → `V3Error05ExecutionDecision` | anchored | handle_provider_failure<br/><small>routecodex-v3-runtime/src/hub_v1/relay_runtime_shared.rs</small> | run_v3_relay_provider_failure_policy<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-19` | `V3ProviderActionGateAdmission` → `V3ProviderActionPermitInFlight` | anchored | execute_v3_responses_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | V3ProviderActionAdmission::take_permit<br/><small>routecodex-v3-runtime/src/provider_action_gate.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-20` | `V3ProviderActionGateAdmission` → `V3ProviderActionPermitInFlight` | anchored | execute_v3_responses_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs</small> | V3ProviderActionAdmission::take_permit<br/><small>routecodex-v3-runtime/src/provider_action_gate.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-21` | `V3ProviderActionGateAdmission` → `V3ProviderActionPermitInFlight` | anchored | execute_v3_anthropic_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | V3ProviderActionAdmission::take_permit<br/><small>routecodex-v3-runtime/src/provider_action_gate.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-22` | `V3ProviderActionGateAdmission` → `V3ProviderActionPermitInFlight` | anchored | execute_v3_relay_runtime_core<br/><small>routecodex-v3-runtime/src/hub_v1/relay_runtime_core.rs</small> | V3ProviderActionAdmission::take_permit<br/><small>routecodex-v3-runtime/src/provider_action_gate.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-23` | `V3ProviderActionGateAdmission` → `V3ProviderActionPermitInFlight` | anchored | execute_v3_anthropic_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | V3ProviderActionAdmission::take_permit<br/><small>routecodex-v3-runtime/src/provider_action_gate.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-24` | `V3ProviderActionPermitInFlight` → `V3ProviderActionPermitAbandonRequested` | anchored | execute_v3_responses_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | V3ProviderActionPermit::drop<br/><small>routecodex-v3-runtime/src/provider_action_gate.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-25` | `V3ProviderActionPermitInFlight` → `V3ProviderActionPermitAbandonRequested` | anchored | execute_v3_responses_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs</small> | V3ProviderActionPermit::drop<br/><small>routecodex-v3-runtime/src/provider_action_gate.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-26` | `V3ProviderActionPermitInFlight` → `V3ProviderActionPermitAbandonRequested` | anchored | execute_v3_anthropic_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | V3ProviderActionPermit::drop<br/><small>routecodex-v3-runtime/src/provider_action_gate.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-27` | `V3ProviderActionPermitInFlight` → `V3ProviderActionPermitAbandonRequested` | anchored | execute_v3_relay_runtime_core<br/><small>routecodex-v3-runtime/src/hub_v1/relay_runtime_core.rs</small> | V3ProviderActionPermit::drop<br/><small>routecodex-v3-runtime/src/provider_action_gate.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-28` | `V3ProviderActionPermitInFlight` → `V3ProviderActionPermitAbandonRequested` | anchored | execute_v3_anthropic_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | V3ProviderActionPermit::drop<br/><small>routecodex-v3-runtime/src/provider_action_gate.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-29` | `V3ProviderActionPermitInFlight` → `V3ProviderActionPermitAbandonRequested` | anchored | V3DirectSseProviderOutcome::record_failure<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs</small> | V3ProviderActionPermit::drop<br/><small>routecodex-v3-runtime/src/provider_action_gate.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-30` | `V3ProviderActionPermitInFlight` → `V3ProviderActionPermitAbandonRequested` | anchored | V3OpenAiChatSseProviderOutcome::record_failure<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small> | V3ProviderActionPermit::drop<br/><small>routecodex-v3-runtime/src/provider_action_gate.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-31` | `V3ProviderActionPermitInFlight` → `V3ProviderActionPermitAbandonRequested` | anchored | V3GeminiSseProviderOutcome::record_failure<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small> | V3ProviderActionPermit::drop<br/><small>routecodex-v3-runtime/src/provider_action_gate.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-32` | `V3ProviderActionPermitAbandonRequested` → `V3ProviderActionPermitAbandoned` | anchored | V3ProviderActionPermit::drop<br/><small>routecodex-v3-runtime/src/provider_action_gate.rs</small> | V3ProviderActionGate::abandon_admission<br/><small>routecodex-v3-runtime/src/provider_action_gate.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-33` | `V3ProviderActionPermitInFlight` → `V3ProviderActionSuccessObserved` | anchored | wrap_direct_sse_provider_outcome_stream<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs</small> | V3DirectSseProviderOutcome::record_success<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-34` | `V3ProviderActionSuccessObserved` → `V3ProviderActionSuccessRecorded` | anchored | V3DirectSseProviderOutcome::record_success<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs</small> | V3ProviderFailureRuntimeHealth::record_provider_success_in_failure_scope<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-35` | `V3ProviderActionPermitInFlight` → `V3ProviderActionFailureObserved` | anchored | wrap_direct_sse_provider_outcome_stream<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs</small> | V3DirectSseProviderOutcome::record_failure<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-36` | `V3ProviderActionPermitAbandoned` → `V3ProviderActionFailureRecorded` | anchored | V3DirectSseProviderOutcome::record_failure<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs</small> | V3ProviderFailureRuntimeHealth::record_post_commit_provider_stream_failure_from_source<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-37` | `V3ProviderActionPermitInFlight` → `V3ProviderActionSuccessObserved` | anchored | project_sse_stream<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small> | V3OpenAiChatSseProviderOutcome::record_success<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-38` | `V3ProviderActionSuccessObserved` → `V3ProviderActionSuccessRecorded` | anchored | V3OpenAiChatSseProviderOutcome::record_success<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small> | V3ProviderFailureRuntimeHealth::record_provider_success_in_failure_scope<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-39` | `V3ProviderActionPermitInFlight` → `V3ProviderActionFailureObserved` | anchored | project_sse_stream<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small> | V3OpenAiChatSseProviderOutcome::record_failure<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-40` | `V3ProviderActionPermitAbandoned` → `V3ProviderActionFailureRecorded` | anchored | V3OpenAiChatSseProviderOutcome::record_failure<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small> | V3ProviderFailureRuntimeHealth::record_post_commit_provider_stream_failure<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-41` | `V3ProviderActionPermitInFlight` → `V3ProviderActionSuccessObserved` | anchored | project_sse_stream<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small> | V3GeminiSseProviderOutcome::record_success<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-42` | `V3ProviderActionSuccessObserved` → `V3ProviderActionSuccessRecorded` | anchored | V3GeminiSseProviderOutcome::record_success<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small> | V3ProviderFailureRuntimeHealth::record_provider_success_in_failure_scope<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-43` | `V3ProviderActionPermitInFlight` → `V3ProviderActionFailureObserved` | anchored | project_sse_stream<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small> | V3GeminiSseProviderOutcome::record_failure<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-44` | `V3ProviderActionPermitAbandoned` → `V3ProviderActionFailureRecorded` | anchored | V3GeminiSseProviderOutcome::record_failure<br/><small>routecodex-v3-runtime/src/hub_v1/gemini_relay_runtime.rs</small> | V3ProviderFailureRuntimeHealth::record_post_commit_provider_stream_failure<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-45` | `V3ProviderActionPermitInFlight` → `V3ProviderActionSuccessRecorded` | anchored | execute_v3_responses_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs</small> | V3ProviderFailureRuntimeHealth::record_provider_success_in_failure_scope<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-46` | `V3ProviderActionPermitInFlight` → `V3ProviderActionSuccessFinalize` | anchored | execute_v3_anthropic_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | record_provider_success_after_resp04<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-47` | `V3ProviderActionSuccessFinalize` → `V3ProviderActionSuccessRecorded` | anchored | record_provider_success_after_resp04<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_relay_runtime.rs</small> | V3ProviderFailureRuntimeHealth::record_provider_success_in_failure_scope<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-48` | `V3ProviderRespInbound01Raw` → `V3ProviderResponsesEventCodec` | anchored | wrap_direct_sse_provider_outcome_stream<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs</small> | V3DirectSseProviderOutcome::observe_chunk<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-49` | `V3ProviderResponsesEventCodec` → `V3ProviderResponsesTerminalOrFailureObserved` | anchored | V3DirectSseProviderOutcome::observe_chunk<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs</small> | V3DirectSseProviderOutcome::observe_frame<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-50` | `V3ProviderRespInbound01Raw` → `V3ProviderResponsesEventCodec` | anchored | build_v3_hub_resp_inbound_02_from_responses_provider_stream_events<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/provider_stream_materialization.rs</small> | observe_v3_runtime_responses_sse_transport_chunk_typed<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/responses_provider_event_codec.rs</small> | `v3.provider_action_gate` |
| `v3-provider-action-gate-51` | `V3ProviderResponsesEventCodec` → `V3ProviderResponsesTerminalOrFailureObserved` | anchored | observe_v3_runtime_responses_sse_semantic_frame_typed<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/responses_provider_event_codec.rs</small> | V3ResponsesSseReducerState::apply_event<br/><small>routecodex-v3-runtime/src/hub_v1/responses_sse_tree.rs</small> | `v3.provider_action_gate` |

## v3.build_test_artifact_budget

Canonical V3 Cargo tests emit test-owned artifacts, release them on every terminal outcome, retain reusable dependencies within budget, and fail explicitly above 2 GiB.

Owner feature: `v3.build_test_artifact_budget`
Manifest: `docs/architecture/manifests/v3.build_test_artifact_budget.mainline.yml`

```mermaid
flowchart TD
  subgraph c_61_v3_build_test_artifact_budget_m_v3_scripts["v3/scripts"]
    c_61_v3_build_test_artifact_budget_0["v3/scripts<br/>runV3CargoTest<br/><small>v3/scripts/run-v3-cargo-test.mjs</small>"]
    c_61_v3_build_test_artifact_budget_1["v3/scripts<br/>executeCargo<br/><small>v3/scripts/run-v3-cargo-test.mjs</small>"]
    c_61_v3_build_test_artifact_budget_2["v3/scripts<br/>releaseOwnedTestArtifacts<br/><small>v3/scripts/run-v3-cargo-test.mjs</small>"]
    c_61_v3_build_test_artifact_budget_3["v3/scripts<br/>verifyV3DebugBudget<br/><small>v3/scripts/run-v3-cargo-test.mjs</small>"]
  end
  c_61_v3_build_test_artifact_budget_0 -->|v3-build-test-budget-01<br/>V3BuildTest01CommandAccepted → V3BuildTest02ArtifactsProduced| c_61_v3_build_test_artifact_budget_1
  c_61_v3_build_test_artifact_budget_0 -->|v3-build-test-budget-02<br/>V3BuildTest02ArtifactsProduced → V3BuildTest03OwnedArtifactsReleased| c_61_v3_build_test_artifact_budget_2
  c_61_v3_build_test_artifact_budget_0 -->|v3-build-test-budget-03<br/>V3BuildTest03OwnedArtifactsReleased → V3BuildTest04BudgetVerified| c_61_v3_build_test_artifact_budget_3
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-build-test-budget-01` | `V3BuildTest01CommandAccepted` → `V3BuildTest02ArtifactsProduced` | anchored | runV3CargoTest<br/><small>v3/scripts/run-v3-cargo-test.mjs</small> | executeCargo<br/><small>v3/scripts/run-v3-cargo-test.mjs</small> | `v3.build_test_artifact_budget` |
| `v3-build-test-budget-02` | `V3BuildTest02ArtifactsProduced` → `V3BuildTest03OwnedArtifactsReleased` | anchored | runV3CargoTest<br/><small>v3/scripts/run-v3-cargo-test.mjs</small> | releaseOwnedTestArtifacts<br/><small>v3/scripts/run-v3-cargo-test.mjs</small> | `v3.build_test_artifact_budget` |
| `v3-build-test-budget-03` | `V3BuildTest03OwnedArtifactsReleased` → `V3BuildTest04BudgetVerified` | anchored | runV3CargoTest<br/><small>v3/scripts/run-v3-cargo-test.mjs</small> | verifyV3DebugBudget<br/><small>v3/scripts/run-v3-cargo-test.mjs</small> | `v3.build_test_artifact_budget` |

## v3.route_classifier.facts_classification

Route facts classification stays local to the route-classifier crate; Virtual Router and runtime request-facts builders consume classification decisions, never payload patches.

Owner feature: `v3.route_classifier_local_owner`

```mermaid
flowchart TD
  subgraph c_62_v3_route_classifier_facts_classification_m_routecodex_v3_route_classifier["routecodex-v3-route-classifier"]
    c_62_v3_route_classifier_facts_classification_1["routecodex-v3-route-classifier<br/>classify_route<br/><small>routecodex-v3-route-classifier/src/route.rs</small>"]
  end
  subgraph c_62_v3_route_classifier_facts_classification_m_v3_runtime["v3-runtime"]
    c_62_v3_route_classifier_facts_classification_0["v3-runtime<br/>build_v3_router_request_facts_for_entry_with_control<br/><small>routecodex-v3-runtime/src/nodes.rs</small>"]
  end
  c_62_v3_route_classifier_facts_classification_0 -->|v3-route-classifier-facts-01<br/>V3RouterRequestFacts → V3RouteClassification| c_62_v3_route_classifier_facts_classification_1
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-route-classifier-facts-01` | `V3RouterRequestFacts` → `V3RouteClassification` | anchored | build_v3_router_request_facts_for_entry_with_control<br/><small>routecodex-v3-runtime/src/nodes.rs</small> | classify_route<br/><small>routecodex-v3-route-classifier/src/route.rs</small> | `v3.route_classifier_local_owner` |

## v3.sse.protocol_codec_projection_boundary

Opaque SSE framing feeds adjacent provider/client protocol codecs; runtime and server do not infer semantic terminality or control state.

Owner feature: `v3.sse_protocol_codec_projection_boundary`
Manifest: `docs/architecture/manifests/v3.sse.protocol_codec_projection.mainline.yml`

```mermaid
flowchart TD
  subgraph c_63_v3_sse_protocol_codec_projection_boundary_m_routecodex_v3_sse["routecodex-v3-sse"]
    c_63_v3_sse_protocol_codec_projection_boundary_1["routecodex-v3-sse<br/>SseIncrementalDecoder::push<br/><small>routecodex-v3-sse/src/lib.rs</small>"]
  end
  subgraph c_63_v3_sse_protocol_codec_projection_boundary_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_63_v3_sse_protocol_codec_projection_boundary_0["v3-runtime::hub_v1<br/>project_sse_stream<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small>"]
    c_63_v3_sse_protocol_codec_projection_boundary_2["v3-runtime::hub_v1<br/>project_sse_event_payload<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime_sse.rs</small>"]
    c_63_v3_sse_protocol_codec_projection_boundary_3["v3-runtime::hub_v1<br/>build_v3_hub_resp_inbound_02_from_provider_resp_compat_02<br/><small>routecodex-v3-runtime/src/hub_v1/resp_inbound_02_normalized.rs</small>"]
    c_63_v3_sse_protocol_codec_projection_boundary_4["v3-runtime::hub_v1<br/>build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04_with_client_payload<br/><small>routecodex-v3-runtime/src/hub_v1/resp_outbound_05_client_semantic.rs</small>"]
  end
  c_63_v3_sse_protocol_codec_projection_boundary_0 -->|v3-sse-codec-01<br/>V3ProviderRespInbound01Raw → V3SseTransportIn03ValidatedFrameStream| c_63_v3_sse_protocol_codec_projection_boundary_1
  c_63_v3_sse_protocol_codec_projection_boundary_2 -->|v3-sse-codec-02<br/>V3SseTransportIn03ValidatedFrameStream → V3HubRespInbound02Normalized| c_63_v3_sse_protocol_codec_projection_boundary_3
  c_63_v3_sse_protocol_codec_projection_boundary_0 -->|v3-sse-codec-03<br/>V3HubRespContinuation04Committed → V3HubRespOutbound05ClientSemantic| c_63_v3_sse_protocol_codec_projection_boundary_4
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-sse-codec-01` | `V3ProviderRespInbound01Raw` → `V3SseTransportIn03ValidatedFrameStream` | anchored | project_sse_stream<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small> | SseIncrementalDecoder::push<br/><small>routecodex-v3-sse/src/lib.rs</small> | `v3.sse_protocol_codec_projection_boundary` |
| `v3-sse-codec-02` | `V3SseTransportIn03ValidatedFrameStream` → `V3HubRespInbound02Normalized` | anchored | project_sse_event_payload<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime_sse.rs</small> | build_v3_hub_resp_inbound_02_from_provider_resp_compat_02<br/><small>routecodex-v3-runtime/src/hub_v1/resp_inbound_02_normalized.rs</small> | `v3.sse_protocol_codec_projection_boundary` |
| `v3-sse-codec-03` | `V3HubRespContinuation04Committed` → `V3HubRespOutbound05ClientSemantic` | anchored | project_sse_stream<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small> | build_v3_hub_resp_outbound_05_from_v3_hub_resp_continuation_04_with_client_payload<br/><small>routecodex-v3-runtime/src/hub_v1/resp_outbound_05_client_semantic.rs</small> | `v3.sse_protocol_codec_projection_boundary` |

## vr.current_turn_typed_route_facts

Typed current-turn route facts are produced before VR selection and cannot be reconstructed from request history or business text.

Owner feature: `vr.current_turn_typed_route_facts`
Manifest: `docs/architecture/manifests/vr.route_classifier.mainline.yml`

```mermaid
flowchart TD
  subgraph c_64_vr_current_turn_typed_route_facts_m_routecodex_v3_route_classifier["routecodex-v3-route-classifier"]
    c_64_vr_current_turn_typed_route_facts_0["routecodex-v3-route-classifier<br/>build_v3_current_turn_route_facts<br/><small>routecodex-v3-route-classifier/src/active_turn.rs</small>"]
    c_64_vr_current_turn_typed_route_facts_1["routecodex-v3-route-classifier<br/>classify_route<br/><small>routecodex-v3-route-classifier/src/route.rs</small>"]
  end
  subgraph c_64_vr_current_turn_typed_route_facts_m_v3_runtime["v3-runtime"]
    c_64_vr_current_turn_typed_route_facts_2["v3-runtime<br/>build_v3_router_request_facts_for_entry_with_control<br/><small>routecodex-v3-runtime/src/nodes.rs</small>"]
  end
  c_64_vr_current_turn_typed_route_facts_0 -->|vr-current-turn-01<br/>V3HubReqExecution05Planned → V3CurrentTurnRouteFacts| c_64_vr_current_turn_typed_route_facts_1
  c_64_vr_current_turn_typed_route_facts_2 -->|v3-route-classifier-facts-02<br/>V3RouterRequestFacts → V3CurrentTurnRouteFacts| c_64_vr_current_turn_typed_route_facts_0
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `vr-current-turn-01` | `V3HubReqExecution05Planned` → `V3CurrentTurnRouteFacts` | anchored | build_v3_current_turn_route_facts<br/><small>routecodex-v3-route-classifier/src/active_turn.rs</small> | classify_route<br/><small>routecodex-v3-route-classifier/src/route.rs</small> | `vr.current_turn_typed_route_facts` |
| `v3-route-classifier-facts-02` | `V3RouterRequestFacts` → `V3CurrentTurnRouteFacts` | anchored | build_v3_router_request_facts_for_entry_with_control<br/><small>routecodex-v3-runtime/src/nodes.rs</small> | build_v3_current_turn_route_facts<br/><small>routecodex-v3-route-classifier/src/active_turn.rs</small> | `v3.route_classifier_local_owner` |

## v3.provider_global_subscription_probe

Managed aggregate lifecycle acquires due provider-global probes and completes recovery or process-lifetime suspension through the typed health resource.

Owner feature: `v3.provider_global_subscription_probe`
Manifest: `docs/architecture/manifests/v3.provider_global_subscription_probe.mainline.yml`

```mermaid
flowchart TD
  subgraph c_65_v3_provider_global_subscription_probe_m_v3_error["v3-error"]
    c_65_v3_provider_global_subscription_probe_6["v3-error<br/>build_v3_error_02_classified_from_v3_error_01_with_provider_global_policy<br/><small>routecodex-v3-error/src/lib.rs</small>"]
  end
  subgraph c_65_v3_provider_global_subscription_probe_m_v3_provider_responses["v3-provider-responses"]
    c_65_v3_provider_global_subscription_probe_1["v3-provider-responses<br/>V3ProviderHealthStore::try_acquire_provider_cooldown_probe<br/><small>routecodex-v3-provider-responses/src/health.rs</small>"]
  end
  subgraph c_65_v3_provider_global_subscription_probe_m_v3_runtime["v3-runtime"]
    c_65_v3_provider_global_subscription_probe_0["v3-runtime<br/>V3ProviderFailureRuntimeHealth::run_due_global_subscription_probes<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small>"]
    c_65_v3_provider_global_subscription_probe_3["v3-runtime<br/>probe_v3_provider_global_target<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small>"]
    c_65_v3_provider_global_subscription_probe_5["v3-runtime<br/>V3ProviderFailureRuntimeHealth::record_provider_global_health_for_classified_error<br/><small>routecodex-v3-runtime/src/provider_failure_global_probe.rs</small>"]
  end
  subgraph c_65_v3_provider_global_subscription_probe_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_65_v3_provider_global_subscription_probe_4["v3-runtime::hub_v1<br/>execute_v3_responses_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs</small>"]
  end
  subgraph c_65_v3_provider_global_subscription_probe_m_v3_server["v3-server"]
    c_65_v3_provider_global_subscription_probe_2["v3-server<br/>spawn_v3_server_aggregate<br/><small>routecodex-v3-server/src/lib.rs</small>"]
  end
  c_65_v3_provider_global_subscription_probe_0 -->|v3-provider-global-probe-01<br/>V3ProviderHealthStore → V3ProviderGlobalProbePermit| c_65_v3_provider_global_subscription_probe_1
  c_65_v3_provider_global_subscription_probe_2 -->|v3-provider-global-probe-02<br/>V3ServerAggregateLifecycle → V3ProviderGlobalProbeExecution| c_65_v3_provider_global_subscription_probe_0
  c_65_v3_provider_global_subscription_probe_0 -->|v3-provider-global-probe-02-target<br/>V3ProviderGlobalProbePermit → V3ProviderGlobalProbeExecution| c_65_v3_provider_global_subscription_probe_3
  c_65_v3_provider_global_subscription_probe_2 -->|v3-provider-global-probe-02-persistent<br/>V3ServerAggregateLifecycle → V3ProviderGlobalProbeExecution| c_65_v3_provider_global_subscription_probe_0
  c_65_v3_provider_global_subscription_probe_4 -->|v3-provider-global-probe-03<br/>V3Error02Classified → V3ProviderHealthStore| c_65_v3_provider_global_subscription_probe_5
  c_65_v3_provider_global_subscription_probe_4 -->|v3-provider-global-probe-error-classification<br/>V3Error01SourceRaised → V3Error02Classified| c_65_v3_provider_global_subscription_probe_6
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-provider-global-probe-01` | `V3ProviderHealthStore` → `V3ProviderGlobalProbePermit` | anchored | V3ProviderFailureRuntimeHealth::run_due_global_subscription_probes<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | V3ProviderHealthStore::try_acquire_provider_cooldown_probe<br/><small>routecodex-v3-provider-responses/src/health.rs</small> | `v3.provider_global_subscription_probe` |
| `v3-provider-global-probe-02` | `V3ServerAggregateLifecycle` → `V3ProviderGlobalProbeExecution` | anchored | spawn_v3_server_aggregate<br/><small>routecodex-v3-server/src/lib.rs</small> | V3ProviderFailureRuntimeHealth::run_due_global_subscription_probes<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | `v3.provider_global_subscription_probe` |
| `v3-provider-global-probe-02-target` | `V3ProviderGlobalProbePermit` → `V3ProviderGlobalProbeExecution` | anchored | V3ProviderFailureRuntimeHealth::run_due_global_subscription_probes<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | probe_v3_provider_global_target<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | `v3.provider_global_subscription_probe` |
| `v3-provider-global-probe-02-persistent` | `V3ServerAggregateLifecycle` → `V3ProviderGlobalProbeExecution` | anchored | spawn_v3_server_aggregate<br/><small>routecodex-v3-server/src/lib.rs</small> | V3ProviderFailureRuntimeHealth::run_due_global_subscription_probes<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | `v3.provider_global_subscription_probe` |
| `v3-provider-global-probe-03` | `V3Error02Classified` → `V3ProviderHealthStore` | anchored | execute_v3_responses_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs</small> | V3ProviderFailureRuntimeHealth::record_provider_global_health_for_classified_error<br/><small>routecodex-v3-runtime/src/provider_failure_global_probe.rs</small> | `v3.provider_global_subscription_probe` |
| `v3-provider-global-probe-error-classification` | `V3Error01SourceRaised` → `V3Error02Classified` | anchored | execute_v3_responses_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs</small> | build_v3_error_02_classified_from_v3_error_01_with_provider_global_policy<br/><small>routecodex-v3-error/src/lib.rs</small> | `v3.provider_global_subscription_probe` |

## v3.tool_thinking_hook_skeleton.mainline

Req04 atomically compiles one tool_thinking_json_v2 contract with required reason and optional diagnostics, wraps free-form custom tools, and emits request-local typed custom provenance; protocol projections preserve complete schemas and parameter containers; Resp03 alone classifies, performs all-or-nothing valid-key removal, mechanically restores custom shape, finalizes one typed turn result, and projects one separate normal reasoning item without changing provider-native reasoning.

Owner feature: `v3.tool_thinking_hook_skeleton`

```mermaid
flowchart TD
  subgraph c_66_v3_tool_thinking_hook_skeleton_mainline_m_v3_runtime["v3-runtime"]
    c_66_v3_tool_thinking_hook_skeleton_mainline_2["v3-runtime<br/>execute_v3_direct_runtime_kernel_core_with_key_catalog<br/><small>routecodex-v3-runtime/src/kernel/v3_direct_core.rs</small>"]
    c_66_v3_tool_thinking_hook_skeleton_mainline_3["v3-runtime<br/>V3ChatDirectCodec::run_route<br/><small>routecodex-v3-runtime/src/kernel/v3_direct_protocol_codec.rs</small>"]
    c_66_v3_tool_thinking_hook_skeleton_mainline_12["v3-runtime<br/>responses_direct_response_projection_hook_with_context<br/><small>routecodex-v3-runtime/src/hooks.rs</small>"]
    c_66_v3_tool_thinking_hook_skeleton_mainline_14["v3-runtime<br/>apply_toolreason_to_sse_frame<br/><small>routecodex-v3-runtime/src/shared.rs</small>"]
    c_66_v3_tool_thinking_hook_skeleton_mainline_16["v3-runtime<br/>V3DirectSseContentConsumer::take_toolreason_reasoning_projection<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_consumers.rs</small>"]
  end
  subgraph c_66_v3_tool_thinking_hook_skeleton_mainline_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_66_v3_tool_thinking_hook_skeleton_mainline_0["v3-runtime::hub_v1<br/>V3HubRelayRequestHooks::run_from_normalized_with_events<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small>"]
    c_66_v3_tool_thinking_hook_skeleton_mainline_1["v3-runtime::hub_v1<br/>govern_v3_servertool_request_at_req04<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small>"]
    c_66_v3_tool_thinking_hook_skeleton_mainline_4["v3-runtime::hub_v1<br/>build_v3_provider_standard_protocol_payload_from_req07<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs</small>"]
    c_66_v3_tool_thinking_hook_skeleton_mainline_5["v3-runtime::hub_v1<br/>build_v3_openai_chat_standard_request_for_selected_web_search_mode<br/><small>routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs</small>"]
    c_66_v3_tool_thinking_hook_skeleton_mainline_6["v3-runtime::hub_v1<br/>run_json_response_hooks<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_json_hooks.rs</small>"]
    c_66_v3_tool_thinking_hook_skeleton_mainline_7["v3-runtime::hub_v1<br/>build_v3_responses_provider_response_from_openai_chat_payload_with_manifest<br/><small>routecodex-v3-runtime/src/hub_v1/responses_openai_chat_conversion.rs</small>"]
    c_66_v3_tool_thinking_hook_skeleton_mainline_8["v3-runtime::hub_v1<br/>project_v3_anthropic_message_as_responses_response_with_context<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs</small>"]
    c_66_v3_tool_thinking_hook_skeleton_mainline_9["v3-runtime::hub_v1<br/>anthropic_tool_use_as_responses_call<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_codec_tool_projection.rs</small>"]
    c_66_v3_tool_thinking_hook_skeleton_mainline_10["v3-runtime::hub_v1<br/>V3HubRelayResponseHookRegistry::govern<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
    c_66_v3_tool_thinking_hook_skeleton_mainline_11["v3-runtime::hub_v1<br/>govern_v3_hub_relay_response<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
    c_66_v3_tool_thinking_hook_skeleton_mainline_13["v3-runtime::hub_v1<br/>map_v3_toolreason_to_reasoning_content_at_resp03<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
    c_66_v3_tool_thinking_hook_skeleton_mainline_15["v3-runtime::hub_v1<br/>map_v3_toolreason_stream_event_at_resp03<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
    c_66_v3_tool_thinking_hook_skeleton_mainline_17["v3-runtime::hub_v1<br/>build_v3_toolreason_visible_text_sse_events_at_resp03<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
  end
  c_66_v3_tool_thinking_hook_skeleton_mainline_0 -->|v3-tool-thinking-req04-relay-contract<br/>V3HubReqContinuation03Classified → V3HubReqChatProcess04Governed| c_66_v3_tool_thinking_hook_skeleton_mainline_1
  c_66_v3_tool_thinking_hook_skeleton_mainline_2 -->|v3-tool-thinking-req04-direct-chat<br/>V3Execution11ProtocolDecision → V3ChatDirect11Policy| c_66_v3_tool_thinking_hook_skeleton_mainline_3
  c_66_v3_tool_thinking_hook_skeleton_mainline_4 -->|v3-tool-thinking-provider-schema-preservation<br/>V3HubReqOutbound07ProviderSemantic → ProviderReqCompat06ProviderCompat| c_66_v3_tool_thinking_hook_skeleton_mainline_5
  c_66_v3_tool_thinking_hook_skeleton_mainline_6 -->|v3-tool-thinking-resp02-preserve-custom-arguments<br/>ProviderRespCompat02ProviderCompat → V3HubRespInbound02Normalized| c_66_v3_tool_thinking_hook_skeleton_mainline_7
  c_66_v3_tool_thinking_hook_skeleton_mainline_8 -->|v3-tool-thinking-resp02-preserve-anthropic-input<br/>ProviderRespCompat02ProviderCompat → V3HubRespInbound02Normalized| c_66_v3_tool_thinking_hook_skeleton_mainline_9
  c_66_v3_tool_thinking_hook_skeleton_mainline_10 -->|v3-tool-thinking-resp03-relay<br/>V3HubRespInbound02Normalized → V3HubRespChatProcess03Governed| c_66_v3_tool_thinking_hook_skeleton_mainline_11
  c_66_v3_tool_thinking_hook_skeleton_mainline_12 -->|v3-tool-thinking-resp03-json<br/>V3ProviderResp14Raw → V3DirectResp14ProviderProjectionPrepared| c_66_v3_tool_thinking_hook_skeleton_mainline_13
  c_66_v3_tool_thinking_hook_skeleton_mainline_14 -->|v3-tool-thinking-resp03-sse<br/>V3ProviderResp14Raw → V3DirectResp14ProviderProjectionPrepared| c_66_v3_tool_thinking_hook_skeleton_mainline_15
  c_66_v3_tool_thinking_hook_skeleton_mainline_16 -->|v3-tool-thinking-resp03-direct-sse-client-reasoning<br/>V3DirectResp14ProviderProjectionPrepared → V3DirectResp15ClientPayloadReady| c_66_v3_tool_thinking_hook_skeleton_mainline_17
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-tool-thinking-req04-relay-contract` | `V3HubReqContinuation03Classified` → `V3HubReqChatProcess04Governed` | anchored | V3HubRelayRequestHooks::run_from_normalized_with_events<br/><small>routecodex-v3-runtime/src/hub_v1/relay_request.rs</small> | govern_v3_servertool_request_at_req04<br/><small>routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs</small> | `v3.tool_thinking_hook_skeleton` |
| `v3-tool-thinking-req04-direct-chat` | `V3Execution11ProtocolDecision` → `V3ChatDirect11Policy` | anchored | execute_v3_direct_runtime_kernel_core_with_key_catalog<br/><small>routecodex-v3-runtime/src/kernel/v3_direct_core.rs</small> | V3ChatDirectCodec::run_route<br/><small>routecodex-v3-runtime/src/kernel/v3_direct_protocol_codec.rs</small> | `v3.tool_thinking_hook_skeleton` |
| `v3-tool-thinking-provider-schema-preservation` | `V3HubReqOutbound07ProviderSemantic` → `ProviderReqCompat06ProviderCompat` | anchored | build_v3_provider_standard_protocol_payload_from_req07<br/><small>routecodex-v3-runtime/src/hub_v1/provider_req_compat_06_provider_compat.rs</small> | build_v3_openai_chat_standard_request_for_selected_web_search_mode<br/><small>routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs</small> | `v3.tool_thinking_hook_skeleton` |
| `v3-tool-thinking-resp02-preserve-custom-arguments` | `ProviderRespCompat02ProviderCompat` → `V3HubRespInbound02Normalized` | anchored | run_json_response_hooks<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_json_hooks.rs</small> | build_v3_responses_provider_response_from_openai_chat_payload_with_manifest<br/><small>routecodex-v3-runtime/src/hub_v1/responses_openai_chat_conversion.rs</small> | `v3.tool_thinking_hook_skeleton` |
| `v3-tool-thinking-resp02-preserve-anthropic-input` | `ProviderRespCompat02ProviderCompat` → `V3HubRespInbound02Normalized` | design | project_v3_anthropic_message_as_responses_response_with_context<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs</small> | anthropic_tool_use_as_responses_call<br/><small>routecodex-v3-runtime/src/hub_v1/anthropic_codec_tool_projection.rs</small> | `v3.tool_thinking_hook_skeleton` |
| `v3-tool-thinking-resp03-relay` | `V3HubRespInbound02Normalized` → `V3HubRespChatProcess03Governed` | anchored | V3HubRelayResponseHookRegistry::govern<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | govern_v3_hub_relay_response<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | `v3.tool_thinking_hook_skeleton` |
| `v3-tool-thinking-resp03-json` | `V3ProviderResp14Raw` → `V3DirectResp14ProviderProjectionPrepared` | anchored | responses_direct_response_projection_hook_with_context<br/><small>routecodex-v3-runtime/src/hooks.rs</small> | map_v3_toolreason_to_reasoning_content_at_resp03<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | `v3.tool_thinking_hook_skeleton` |
| `v3-tool-thinking-resp03-sse` | `V3ProviderResp14Raw` → `V3DirectResp14ProviderProjectionPrepared` | anchored | apply_toolreason_to_sse_frame<br/><small>routecodex-v3-runtime/src/shared.rs</small> | map_v3_toolreason_stream_event_at_resp03<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | `v3.tool_thinking_hook_skeleton` |
| `v3-tool-thinking-resp03-direct-sse-client-reasoning` | `V3DirectResp14ProviderProjectionPrepared` → `V3DirectResp15ClientPayloadReady` | anchored | V3DirectSseContentConsumer::take_toolreason_reasoning_projection<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_consumers.rs</small> | build_v3_toolreason_visible_text_sse_events_at_resp03<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | `v3.tool_thinking_hook_skeleton` |

## v3.server.internal_observability_projection

Server-owned typed diagnostic projection records bounded request lifecycle observations; evicted terminal replay reports resync requirement without entering business payload.

Owner feature: `v3.server_internal_observability_projection`

```mermaid
flowchart TD
  subgraph c_67_v3_server_internal_observability_projection_m_v3_server["v3-server"]
    c_67_v3_server_internal_observability_projection_0["v3-server<br/>emit_v3_request_console_observation<br/><small>routecodex-v3-server/src/console/impl_bulk.rs</small>"]
    c_67_v3_server_internal_observability_projection_1["v3-server<br/>V3WebuiObservability::record<br/><small>routecodex-v3-server/src/webui_observability.rs</small>"]
    c_67_v3_server_internal_observability_projection_2["v3-server<br/>V3WebuiObservability::since<br/><small>routecodex-v3-server/src/webui_observability.rs</small>"]
    c_67_v3_server_internal_observability_projection_3["v3-server<br/>V3ObsSinceResult<br/><small>routecodex-v3-server/src/webui_observability.rs</small>"]
  end
  c_67_v3_server_internal_observability_projection_0 -->|v3-server-observability-record<br/>V3ServerConsoleObservation → V3WebuiObservability| c_67_v3_server_internal_observability_projection_1
  c_67_v3_server_internal_observability_projection_2 -->|v3-server-observability-resync<br/>V3WebuiObservability → V3ObsSinceResult| c_67_v3_server_internal_observability_projection_3
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-server-observability-record` | `V3ServerConsoleObservation` → `V3WebuiObservability` | anchored | emit_v3_request_console_observation<br/><small>routecodex-v3-server/src/console/impl_bulk.rs</small> | V3WebuiObservability::record<br/><small>routecodex-v3-server/src/webui_observability.rs</small> | `v3.server_internal_observability_projection` |
| `v3-server-observability-resync` | `V3WebuiObservability` → `V3ObsSinceResult` | anchored | V3WebuiObservability::since<br/><small>routecodex-v3-server/src/webui_observability.rs</small> | V3ObsSinceResult<br/><small>routecodex-v3-server/src/webui_observability.rs</small> | `v3.server_internal_observability_projection` |

## v3.route_policy.condition_evaluation

Typed turn observations are projected into a bounded history window and evaluated into a route-pool-only policy action before Virtual Router selection.

Owner feature: `v3.route_policy_condition_evaluation`

```mermaid
flowchart TD
  subgraph c_68_v3_route_policy_condition_evaluation_m_routecodex_v3_route_classifier["routecodex-v3-route-classifier"]
    c_68_v3_route_policy_condition_evaluation_0["routecodex-v3-route-classifier<br/>V3RouteHistoryWindow::record_turn<br/><small>routecodex-v3-route-classifier/src/policy.rs</small>"]
    c_68_v3_route_policy_condition_evaluation_1["routecodex-v3-route-classifier<br/>V3RouteHistoryWindow::facts<br/><small>routecodex-v3-route-classifier/src/policy.rs</small>"]
    c_68_v3_route_policy_condition_evaluation_2["routecodex-v3-route-classifier<br/>evaluate_v3_route_policies<br/><small>routecodex-v3-route-classifier/src/policy.rs</small>"]
    c_68_v3_route_policy_condition_evaluation_3["routecodex-v3-route-classifier<br/>V3RoutePolicyAction<br/><small>routecodex-v3-route-classifier/src/policy.rs</small>"]
  end
  subgraph c_68_v3_route_policy_condition_evaluation_m_v3_error["v3-error"]
    c_68_v3_route_policy_condition_evaluation_9["v3-error<br/>build_v3_error_01_source_raised_external<br/><small>routecodex-v3-error/src/lib.rs</small>"]
    c_68_v3_route_policy_condition_evaluation_17["v3-error<br/>build_v3_error_02_classified_from_v3_error_01<br/><small>routecodex-v3-error/src/lib.rs</small>"]
  end
  subgraph c_68_v3_route_policy_condition_evaluation_m_v3_provider_responses["v3-provider-responses"]
    c_68_v3_route_policy_condition_evaluation_11["v3-provider-responses<br/>V3ProviderHealthStore::record_provider_failure_in_session_with_policy<br/><small>routecodex-v3-provider-responses/src/health.rs</small>"]
    c_68_v3_route_policy_condition_evaluation_15["v3-provider-responses<br/>V3ProviderHealthStore::record_provider_key_success<br/><small>routecodex-v3-provider-responses/src/health.rs</small>"]
  end
  subgraph c_68_v3_route_policy_condition_evaluation_m_v3_runtime["v3-runtime"]
    c_68_v3_route_policy_condition_evaluation_4["v3-runtime<br/>execute_v3_responses_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel.rs</small>"]
    c_68_v3_route_policy_condition_evaluation_6["v3-runtime<br/>plan_v3_responses_protocol_execution_with_provider_health<br/><small>routecodex-v3-runtime/src/kernel/direct_protocol_plan.rs</small>"]
    c_68_v3_route_policy_condition_evaluation_7["v3-runtime<br/>V3RoutePolicyRuntimeState::commit_request<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs</small>"]
    c_68_v3_route_policy_condition_evaluation_10["v3-runtime<br/>V3ProviderFailureRuntimeHealth::record_provider_global_subscription_failure<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small>"]
    c_68_v3_route_policy_condition_evaluation_12["v3-runtime<br/>V3ProviderFailureRuntimeHealth::record_provider_failure_record_with_policy<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small>"]
    c_68_v3_route_policy_condition_evaluation_13["v3-runtime<br/>V3ProviderFailureRuntimeHealth::record_provider_global_health_for_classified_error<br/><small>routecodex-v3-runtime/src/provider_failure_global_probe.rs</small>"]
    c_68_v3_route_policy_condition_evaluation_14["v3-runtime<br/>V3ProviderFailureRuntimeHealth::record_provider_success_in_failure_scope<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small>"]
    c_68_v3_route_policy_condition_evaluation_16["v3-runtime<br/>record_v3_direct_provider_failure_record<br/><small>routecodex-v3-runtime/src/kernel/direct_runtime_helpers.rs</small>"]
    c_68_v3_route_policy_condition_evaluation_18["v3-runtime<br/>V3ProviderFailureRuntimeHealth::record_post_commit_provider_stream_failure_from_source<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small>"]
  end
  subgraph c_68_v3_route_policy_condition_evaluation_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_68_v3_route_policy_condition_evaluation_8["v3-runtime::hub_v1<br/>execute_v3_responses_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs</small>"]
  end
  subgraph c_68_v3_route_policy_condition_evaluation_m_v3_virtual_router["v3-virtual-router"]
    c_68_v3_route_policy_condition_evaluation_5["v3-virtual-router<br/>V3VirtualRouter::resolve_route_pool_plan<br/><small>routecodex-v3-virtual-router/src/lib.rs</small>"]
  end
  c_68_v3_route_policy_condition_evaluation_0 -->|v3-route-policy-01<br/>V3RouteTurnObservation → V3RouteHistoryWindow| c_68_v3_route_policy_condition_evaluation_1
  c_68_v3_route_policy_condition_evaluation_2 -->|v3-route-policy-02<br/>V3RouteHistoryWindow → V3RoutePolicyAction| c_68_v3_route_policy_condition_evaluation_3
  c_68_v3_route_policy_condition_evaluation_4 -->|v3-route-policy-03<br/>V3RoutePolicyAction → V3Router06RoutePoolResolved| c_68_v3_route_policy_condition_evaluation_5
  c_68_v3_route_policy_condition_evaluation_6 -->|v3-route-policy-04<br/>V3Router05RequestClassified → V3Router06RoutePoolResolved| c_68_v3_route_policy_condition_evaluation_5
  c_68_v3_route_policy_condition_evaluation_7 -->|v3-route-policy-05<br/>V3Router05RequestClassified → V3RouteHistoryWindow| c_68_v3_route_policy_condition_evaluation_0
  c_68_v3_route_policy_condition_evaluation_8 -->|v3-provider-global-probe-relay-error-source<br/>V3HubRespChatProcess03Governed → V3Error01SourceRaised| c_68_v3_route_policy_condition_evaluation_9
  c_68_v3_route_policy_condition_evaluation_10 -->|v3-provider-global-probe-04<br/>V3ProviderGlobalSubscriptionFailureObservation → V3ProviderHealthStore| c_68_v3_route_policy_condition_evaluation_11
  c_68_v3_route_policy_condition_evaluation_12 -->|v3-provider-global-probe-05<br/>V3ProviderFailureRuntimeHealth → V3ProviderGlobalSubscriptionFailureObservation| c_68_v3_route_policy_condition_evaluation_13
  c_68_v3_route_policy_condition_evaluation_13 -->|v3-provider-global-probe-06<br/>V3ProviderGlobalSubscriptionFailureObservation → V3ProviderHealthStore| c_68_v3_route_policy_condition_evaluation_10
  c_68_v3_route_policy_condition_evaluation_14 -->|v3-provider-global-probe-07<br/>V3ProviderFailureRuntimeHealth → V3ProviderHealthStore| c_68_v3_route_policy_condition_evaluation_15
  c_68_v3_route_policy_condition_evaluation_16 -->|v3-provider-global-probe-08<br/>V3ProviderFailureRuntimeHealth → V3ProviderGlobalSubscriptionFailureObservation| c_68_v3_route_policy_condition_evaluation_13
  c_68_v3_route_policy_condition_evaluation_16 -->|v3-provider-global-probe-direct-error-classification<br/>V3Error01SourceRaised → V3Error02Classified| c_68_v3_route_policy_condition_evaluation_17
  c_68_v3_route_policy_condition_evaluation_18 -->|v3-provider-global-probe-09<br/>V3ProviderGlobalSubscriptionFailureObservation → V3ProviderHealthStore| c_68_v3_route_policy_condition_evaluation_13
  c_68_v3_route_policy_condition_evaluation_18 -->|v3-provider-global-probe-post-commit-error-classification<br/>V3Error01SourceRaised → V3Error02Classified| c_68_v3_route_policy_condition_evaluation_17
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-route-policy-01` | `V3RouteTurnObservation` → `V3RouteHistoryWindow` | source_controlled | V3RouteHistoryWindow::record_turn<br/><small>routecodex-v3-route-classifier/src/policy.rs</small> | V3RouteHistoryWindow::facts<br/><small>routecodex-v3-route-classifier/src/policy.rs</small> | `v3.route_policy_condition_evaluation` |
| `v3-route-policy-02` | `V3RouteHistoryWindow` → `V3RoutePolicyAction` | source_controlled | evaluate_v3_route_policies<br/><small>routecodex-v3-route-classifier/src/policy.rs</small> | V3RoutePolicyAction<br/><small>routecodex-v3-route-classifier/src/policy.rs</small> | `v3.route_policy_condition_evaluation` |
| `v3-route-policy-03` | `V3RoutePolicyAction` → `V3Router06RoutePoolResolved` | source_controlled | execute_v3_responses_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | V3VirtualRouter::resolve_route_pool_plan<br/><small>routecodex-v3-virtual-router/src/lib.rs</small> | `v3.route_policy_condition_evaluation` |
| `v3-route-policy-04` | `V3Router05RequestClassified` → `V3Router06RoutePoolResolved` | source_controlled | plan_v3_responses_protocol_execution_with_provider_health<br/><small>routecodex-v3-runtime/src/kernel/direct_protocol_plan.rs</small> | V3VirtualRouter::resolve_route_pool_plan<br/><small>routecodex-v3-virtual-router/src/lib.rs</small> | `v3.route_policy_condition_evaluation` |
| `v3-route-policy-05` | `V3Router05RequestClassified` → `V3RouteHistoryWindow` | source_controlled | V3RoutePolicyRuntimeState::commit_request<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_provider_outcome.rs</small> | V3RouteHistoryWindow::record_turn<br/><small>routecodex-v3-route-classifier/src/policy.rs</small> | `v3.route_policy_condition_evaluation` |
| `v3-provider-global-probe-relay-error-source` | `V3HubRespChatProcess03Governed` → `V3Error01SourceRaised` | anchored | execute_v3_responses_relay_runtime_inner<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime_inner.rs</small> | build_v3_error_01_source_raised_external<br/><small>routecodex-v3-error/src/lib.rs</small> | `v3.provider_global_subscription_probe` |
| `v3-provider-global-probe-04` | `V3ProviderGlobalSubscriptionFailureObservation` → `V3ProviderHealthStore` | anchored | V3ProviderFailureRuntimeHealth::record_provider_global_subscription_failure<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | V3ProviderHealthStore::record_provider_failure_in_session_with_policy<br/><small>routecodex-v3-provider-responses/src/health.rs</small> | `v3.provider_global_subscription_probe` |
| `v3-provider-global-probe-05` | `V3ProviderFailureRuntimeHealth` → `V3ProviderGlobalSubscriptionFailureObservation` | anchored | V3ProviderFailureRuntimeHealth::record_provider_failure_record_with_policy<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | V3ProviderFailureRuntimeHealth::record_provider_global_health_for_classified_error<br/><small>routecodex-v3-runtime/src/provider_failure_global_probe.rs</small> | `v3.provider_global_subscription_probe` |
| `v3-provider-global-probe-06` | `V3ProviderGlobalSubscriptionFailureObservation` → `V3ProviderHealthStore` | anchored | V3ProviderFailureRuntimeHealth::record_provider_global_health_for_classified_error<br/><small>routecodex-v3-runtime/src/provider_failure_global_probe.rs</small> | V3ProviderFailureRuntimeHealth::record_provider_global_subscription_failure<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | `v3.provider_global_subscription_probe` |
| `v3-provider-global-probe-07` | `V3ProviderFailureRuntimeHealth` → `V3ProviderHealthStore` | anchored | V3ProviderFailureRuntimeHealth::record_provider_success_in_failure_scope<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | V3ProviderHealthStore::record_provider_key_success<br/><small>routecodex-v3-provider-responses/src/health.rs</small> | `v3.provider_global_subscription_probe` |
| `v3-provider-global-probe-08` | `V3ProviderFailureRuntimeHealth` → `V3ProviderGlobalSubscriptionFailureObservation` | anchored | record_v3_direct_provider_failure_record<br/><small>routecodex-v3-runtime/src/kernel/direct_runtime_helpers.rs</small> | V3ProviderFailureRuntimeHealth::record_provider_global_health_for_classified_error<br/><small>routecodex-v3-runtime/src/provider_failure_global_probe.rs</small> | `v3.provider_global_subscription_probe` |
| `v3-provider-global-probe-direct-error-classification` | `V3Error01SourceRaised` → `V3Error02Classified` | anchored | record_v3_direct_provider_failure_record<br/><small>routecodex-v3-runtime/src/kernel/direct_runtime_helpers.rs</small> | build_v3_error_02_classified_from_v3_error_01<br/><small>routecodex-v3-error/src/lib.rs</small> | `v3.provider_global_subscription_probe` |
| `v3-provider-global-probe-09` | `V3ProviderGlobalSubscriptionFailureObservation` → `V3ProviderHealthStore` | anchored | V3ProviderFailureRuntimeHealth::record_post_commit_provider_stream_failure_from_source<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | V3ProviderFailureRuntimeHealth::record_provider_global_health_for_classified_error<br/><small>routecodex-v3-runtime/src/provider_failure_global_probe.rs</small> | `v3.provider_global_subscription_probe` |
| `v3-provider-global-probe-post-commit-error-classification` | `V3Error01SourceRaised` → `V3Error02Classified` | anchored | V3ProviderFailureRuntimeHealth::record_post_commit_provider_stream_failure_from_source<br/><small>routecodex-v3-runtime/src/provider_failure_runtime_policy.rs</small> | build_v3_error_02_classified_from_v3_error_01<br/><small>routecodex-v3-error/src/lib.rs</small> | `v3.provider_global_subscription_probe` |

## v3.responses_chat_sse_typed_tree

The selected Responses or Chat protocol codec parses SSE data into transport, protocol metadata, and semantic typed nodes; only typed notification and business-content rewrite hooks may observe or mutate the semantic branch.

Owner feature: `v3.responses_chat_sse_typed_tree_refactor`

```mermaid
flowchart TD
  subgraph c_69_v3_responses_chat_sse_typed_tree_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_69_v3_responses_chat_sse_typed_tree_0["v3-runtime::hub_v1<br/>run_json_response_hooks<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_json_hooks.rs</small>"]
    c_69_v3_responses_chat_sse_typed_tree_1["v3-runtime::hub_v1<br/>V3ResponsesJsonDocument::from_json<br/><small>routecodex-v3-runtime/src/hub_v1/responses_sse_tree.rs</small>"]
    c_69_v3_responses_chat_sse_typed_tree_2["v3-runtime::hub_v1<br/>observe_v3_runtime_responses_sse_semantic_frame_typed_with_hook<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/responses_provider_event_codec.rs</small>"]
    c_69_v3_responses_chat_sse_typed_tree_3["v3-runtime::hub_v1<br/>V3ResponsesSseProtocolMetadata::from_event<br/><small>routecodex-v3-runtime/src/hub_v1/responses_sse_tree.rs</small>"]
    c_69_v3_responses_chat_sse_typed_tree_4["v3-runtime::hub_v1<br/>V3ResponsesSseReducerState::apply_event<br/><small>routecodex-v3-runtime/src/hub_v1/responses_sse_tree.rs</small>"]
    c_69_v3_responses_chat_sse_typed_tree_5["v3-runtime::hub_v1<br/>classify_v3_responses_sse_output_item<br/><small>routecodex-v3-runtime/src/hub_v1/responses_sse_tree.rs</small>"]
    c_69_v3_responses_chat_sse_typed_tree_6["v3-runtime::hub_v1<br/>rewrite_v3_responses_sse_content<br/><small>routecodex-v3-runtime/src/hub_v1/responses_sse_tree.rs</small>"]
    c_69_v3_responses_chat_sse_typed_tree_7["v3-runtime::hub_v1<br/>V3HubRelayResponseHookRegistry::typed_sse_catalog<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
    c_69_v3_responses_chat_sse_typed_tree_8["v3-runtime::hub_v1<br/>V3RelaySseHookCatalog::rewrite_responses<br/><small>routecodex-v3-runtime/src/hub_v1/relay_sse_hooks.rs</small>"]
  end
  c_69_v3_responses_chat_sse_typed_tree_0 -->|v3-responses-json-document-01<br/>ProviderRespInbound01Raw → HubRespInbound02Parsed| c_69_v3_responses_chat_sse_typed_tree_1
  c_69_v3_responses_chat_sse_typed_tree_2 -->|v3-responses-sse-tree-01<br/>ProviderRespInbound01Raw → HubRespInbound02Parsed| c_69_v3_responses_chat_sse_typed_tree_3
  c_69_v3_responses_chat_sse_typed_tree_4 -->|v3-responses-sse-tree-02<br/>HubRespInbound02Parsed → HubRespChatProcess03Governed| c_69_v3_responses_chat_sse_typed_tree_5
  c_69_v3_responses_chat_sse_typed_tree_6 -->|v3-responses-sse-tree-03<br/>HubRespChatProcess03Governed → HubRespOutbound04ClientSemantic| c_69_v3_responses_chat_sse_typed_tree_6
  c_69_v3_responses_chat_sse_typed_tree_7 -->|v3-responses-relay-typed-hook-catalog-01<br/>HubRespInbound02Parsed → HubRespOutbound04ClientSemantic| c_69_v3_responses_chat_sse_typed_tree_8
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-responses-json-document-01` | `ProviderRespInbound01Raw` → `HubRespInbound02Parsed` | active | run_json_response_hooks<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_json_hooks.rs</small> | V3ResponsesJsonDocument::from_json<br/><small>routecodex-v3-runtime/src/hub_v1/responses_sse_tree.rs</small> | `v3.responses_chat_sse_typed_tree_refactor` |
| `v3-responses-sse-tree-01` | `ProviderRespInbound01Raw` → `HubRespInbound02Parsed` | active | observe_v3_runtime_responses_sse_semantic_frame_typed_with_hook<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_runtime/responses_provider_event_codec.rs</small> | V3ResponsesSseProtocolMetadata::from_event<br/><small>routecodex-v3-runtime/src/hub_v1/responses_sse_tree.rs</small> | `v3.responses_chat_sse_typed_tree_refactor` |
| `v3-responses-sse-tree-02` | `HubRespInbound02Parsed` → `HubRespChatProcess03Governed` | active | V3ResponsesSseReducerState::apply_event<br/><small>routecodex-v3-runtime/src/hub_v1/responses_sse_tree.rs</small> | classify_v3_responses_sse_output_item<br/><small>routecodex-v3-runtime/src/hub_v1/responses_sse_tree.rs</small> | `v3.responses_chat_sse_typed_tree_refactor` |
| `v3-responses-sse-tree-03` | `HubRespChatProcess03Governed` → `HubRespOutbound04ClientSemantic` | design | rewrite_v3_responses_sse_content<br/><small>routecodex-v3-runtime/src/hub_v1/responses_sse_tree.rs</small> | rewrite_v3_responses_sse_content<br/><small>routecodex-v3-runtime/src/hub_v1/responses_sse_tree.rs</small> | `v3.responses_chat_sse_typed_tree_refactor` |
| `v3-responses-relay-typed-hook-catalog-01` | `HubRespInbound02Parsed` → `HubRespOutbound04ClientSemantic` | active | V3HubRelayResponseHookRegistry::typed_sse_catalog<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | V3RelaySseHookCatalog::rewrite_responses<br/><small>routecodex-v3-runtime/src/hub_v1/relay_sse_hooks.rs</small> | `v3.responses_chat_sse_typed_tree_refactor` |

## v3.openai_chat_sse_typed_tree

The OpenAI Chat codec keeps chunk transport, protocol metadata, choices, deltas, finish reasons, and tool-call fragments distinct; rewrite hooks can change only business content.

Owner feature: `v3.responses_chat_sse_typed_tree_refactor`

```mermaid
flowchart TD
  subgraph c_70_v3_openai_chat_sse_typed_tree_m_v3_runtime__hub_v1["v3-runtime::hub_v1"]
    c_70_v3_openai_chat_sse_typed_tree_0["v3-runtime::hub_v1<br/>enqueue_sse_client_chunks<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small>"]
    c_70_v3_openai_chat_sse_typed_tree_1["v3-runtime::hub_v1<br/>classify_v3_openai_chat_sse_chunk<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_sse_tree.rs</small>"]
    c_70_v3_openai_chat_sse_typed_tree_2["v3-runtime::hub_v1<br/>rewrite_v3_openai_chat_sse_content<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_sse_tree.rs</small>"]
    c_70_v3_openai_chat_sse_typed_tree_3["v3-runtime::hub_v1<br/>run_json_response_hooks<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_json_hooks.rs</small>"]
    c_70_v3_openai_chat_sse_typed_tree_4["v3-runtime::hub_v1<br/>V3OpenAiChatJsonDocument::from_json<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_sse_tree.rs</small>"]
    c_70_v3_openai_chat_sse_typed_tree_5["v3-runtime::hub_v1<br/>V3HubRelayResponseHookRegistry::typed_sse_catalog<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small>"]
    c_70_v3_openai_chat_sse_typed_tree_6["v3-runtime::hub_v1<br/>V3RelaySseHookCatalog::rewrite_chat<br/><small>routecodex-v3-runtime/src/hub_v1/relay_sse_hooks.rs</small>"]
  end
  c_70_v3_openai_chat_sse_typed_tree_0 -->|v3-chat-sse-tree-01<br/>ProviderRespInbound01Raw → HubRespInbound02Parsed| c_70_v3_openai_chat_sse_typed_tree_1
  c_70_v3_openai_chat_sse_typed_tree_2 -->|v3-chat-sse-tree-02<br/>HubRespChatProcess03Governed → HubRespOutbound04ClientSemantic| c_70_v3_openai_chat_sse_typed_tree_2
  c_70_v3_openai_chat_sse_typed_tree_3 -->|v3-chat-json-document-01<br/>ProviderRespInbound01Raw → HubRespInbound02Parsed| c_70_v3_openai_chat_sse_typed_tree_4
  c_70_v3_openai_chat_sse_typed_tree_5 -->|v3-relay-typed-hook-catalog-01<br/>HubRespInbound02Parsed → HubRespOutbound04ClientSemantic| c_70_v3_openai_chat_sse_typed_tree_6
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-chat-sse-tree-01` | `ProviderRespInbound01Raw` → `HubRespInbound02Parsed` | active | enqueue_sse_client_chunks<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_relay_runtime.rs</small> | classify_v3_openai_chat_sse_chunk<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_sse_tree.rs</small> | `v3.responses_chat_sse_typed_tree_refactor` |
| `v3-chat-sse-tree-02` | `HubRespChatProcess03Governed` → `HubRespOutbound04ClientSemantic` | design | rewrite_v3_openai_chat_sse_content<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_sse_tree.rs</small> | rewrite_v3_openai_chat_sse_content<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_sse_tree.rs</small> | `v3.responses_chat_sse_typed_tree_refactor` |
| `v3-chat-json-document-01` | `ProviderRespInbound01Raw` → `HubRespInbound02Parsed` | active | run_json_response_hooks<br/><small>routecodex-v3-runtime/src/hub_v1/responses_relay_json_hooks.rs</small> | V3OpenAiChatJsonDocument::from_json<br/><small>routecodex-v3-runtime/src/hub_v1/openai_chat_sse_tree.rs</small> | `v3.responses_chat_sse_typed_tree_refactor` |
| `v3-relay-typed-hook-catalog-01` | `HubRespInbound02Parsed` → `HubRespOutbound04ClientSemantic` | active | V3HubRelayResponseHookRegistry::typed_sse_catalog<br/><small>routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs</small> | V3RelaySseHookCatalog::rewrite_chat<br/><small>routecodex-v3-runtime/src/hub_v1/relay_sse_hooks.rs</small> | `v3.responses_chat_sse_typed_tree_refactor` |

## v3.sse_error_and_direct_consumer_pre_wiring

Direct SSE routes decoder failures through the exported transport-error adapter and response compatibility through the independent object consumer; Relay Responses/Chat materialization and projection now consume the same independent transport boundary and Relay-owned typed hook catalog.

Owner feature: `v3.responses_chat_sse_typed_tree_refactor`

```mermaid
flowchart TD
  subgraph c_71_v3_sse_error_and_direct_consumer_pre_wiring_m_routecodex_v3_sse["routecodex-v3-sse"]
    c_71_v3_sse_error_and_direct_consumer_pre_wiring_1["routecodex-v3-sse<br/>SseTransportErrorExport::from<br/><small>routecodex-v3-sse/src/lib.rs</small>"]
    c_71_v3_sse_error_and_direct_consumer_pre_wiring_3["routecodex-v3-sse<br/>process_sse_object_frame<br/><small>routecodex-v3-sse/src/lib.rs</small>"]
  end
  subgraph c_71_v3_sse_error_and_direct_consumer_pre_wiring_m_v3_runtime["v3-runtime"]
    c_71_v3_sse_error_and_direct_consumer_pre_wiring_0["v3-runtime<br/>build_v3_sse_transport_error_source<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_consumers.rs</small>"]
    c_71_v3_sse_error_and_direct_consumer_pre_wiring_2["v3-runtime<br/>V3DirectSseContentConsumer::consume<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_consumers.rs</small>"]
    c_71_v3_sse_error_and_direct_consumer_pre_wiring_4["v3-runtime<br/>project_direct_typed_protocol_data<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_consumers.rs</small>"]
    c_71_v3_sse_error_and_direct_consumer_pre_wiring_5["v3-runtime<br/>V3DirectSseTypedHookCatalog::with_responses<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_consumers.rs</small>"]
  end
  c_71_v3_sse_error_and_direct_consumer_pre_wiring_0 -->|v3-sse-error-export-01<br/>V3ProviderResp14Raw → ErrorErr01SourceRaised| c_71_v3_sse_error_and_direct_consumer_pre_wiring_1
  c_71_v3_sse_error_and_direct_consumer_pre_wiring_2 -->|v3-direct-content-consumer-01<br/>V3ProviderResp14Raw → V3DirectResp14ProviderProjectionPrepared| c_71_v3_sse_error_and_direct_consumer_pre_wiring_3
  c_71_v3_sse_error_and_direct_consumer_pre_wiring_2 -->|v3-direct-typed-projection-01<br/>V3DirectResp14ProviderProjectionPrepared → V3DirectResp14ProviderProjectionPrepared| c_71_v3_sse_error_and_direct_consumer_pre_wiring_4
  c_71_v3_sse_error_and_direct_consumer_pre_wiring_2 -->|v3-direct-typed-hook-catalog-01<br/>V3ProviderResp14Raw → V3DirectResp14ProviderProjectionPrepared| c_71_v3_sse_error_and_direct_consumer_pre_wiring_5
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-sse-error-export-01` | `V3ProviderResp14Raw` → `ErrorErr01SourceRaised` | active | build_v3_sse_transport_error_source<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_consumers.rs</small> | SseTransportErrorExport::from<br/><small>routecodex-v3-sse/src/lib.rs</small> | `v3.responses_chat_sse_typed_tree_refactor` |
| `v3-direct-content-consumer-01` | `V3ProviderResp14Raw` → `V3DirectResp14ProviderProjectionPrepared` | active | V3DirectSseContentConsumer::consume<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_consumers.rs</small> | process_sse_object_frame<br/><small>routecodex-v3-sse/src/lib.rs</small> | `v3.responses_chat_sse_typed_tree_refactor` |
| `v3-direct-typed-projection-01` | `V3DirectResp14ProviderProjectionPrepared` → `V3DirectResp14ProviderProjectionPrepared` | active | V3DirectSseContentConsumer::consume<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_consumers.rs</small> | project_direct_typed_protocol_data<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_consumers.rs</small> | `v3.responses_chat_sse_typed_tree_refactor` |
| `v3-direct-typed-hook-catalog-01` | `V3ProviderResp14Raw` → `V3DirectResp14ProviderProjectionPrepared` | active | V3DirectSseContentConsumer::consume<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_consumers.rs</small> | V3DirectSseTypedHookCatalog::with_responses<br/><small>routecodex-v3-runtime/src/kernel/direct_sse_consumers.rs</small> | `v3.responses_chat_sse_typed_tree_refactor` |

## v3.runtime_restart_handoff_skeleton

Stable server response-body ownership drains or hands off in-flight requests across canonical Runtime Child replacement without changing the frozen execution plan or leaking provider frames.

Owner feature: `v3.runtime_restart_handoff_skeleton`
Manifest: `docs/architecture/manifests/v3.runtime_restart_handoff_skeleton.yml`

```mermaid
flowchart TD
  subgraph c_72_v3_runtime_restart_handoff_skeleton_m_v3_server["v3-server"]
    c_72_v3_runtime_restart_handoff_skeleton_0["v3-server<br/>V3FrontRequestLease<br/><small>routecodex-v3-server/src/restart_handoff.rs</small>"]
    c_72_v3_runtime_restart_handoff_skeleton_1["v3-server<br/>V3FrontRequestLeaseKey<br/><small>routecodex-v3-server/src/restart_handoff.rs</small>"]
    c_72_v3_runtime_restart_handoff_skeleton_2["v3-server<br/>V3ServerAggregateHandle::prepare_for_exec<br/><small>routecodex-v3-server/src/lib.rs</small>"]
    c_72_v3_runtime_restart_handoff_skeleton_3["v3-server<br/>V3ServerRequestActivityGate::wait_for_quiescence<br/><small>routecodex-v3-server/src/session_admission.rs</small>"]
  end
  c_72_v3_runtime_restart_handoff_skeleton_0 -->|v3-runtime-restart-handoff-01<br/>V3Front01StableRequestOwner → V3Front02RequestLeaseBound| c_72_v3_runtime_restart_handoff_skeleton_1
  c_72_v3_runtime_restart_handoff_skeleton_2 -->|v3-runtime-restart-handoff-02<br/>V3Front02RequestLeaseBound → V3Front08ClientTerminalOrError| c_72_v3_runtime_restart_handoff_skeleton_3
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-runtime-restart-handoff-01` | `V3Front01StableRequestOwner` → `V3Front02RequestLeaseBound` | design | V3FrontRequestLease<br/><small>routecodex-v3-server/src/restart_handoff.rs</small> | V3FrontRequestLeaseKey<br/><small>routecodex-v3-server/src/restart_handoff.rs</small> | `v3.runtime_restart_handoff_skeleton` |
| `v3-runtime-restart-handoff-02` | `V3Front02RequestLeaseBound` → `V3Front08ClientTerminalOrError` | source_controlled_runtime_pending_live_replay | V3ServerAggregateHandle::prepare_for_exec<br/><small>routecodex-v3-server/src/lib.rs</small> | V3ServerRequestActivityGate::wait_for_quiescence<br/><small>routecodex-v3-server/src/session_admission.rs</small> | `v3.runtime_restart_handoff_skeleton` |

## v3.direct_sse_accept_skeleton

Responses SSE establishes a shared Front client transport channel and heartbeat before the execution-plan-selected Direct or Relay attempt finishes; only the runtime projected client frame crosses the channel.

Owner feature: `v3.direct_sse_accept_skeleton`
Manifest: `docs/architecture/manifests/v3.direct_sse_accept_skeleton.mainline.yml`

```mermaid
flowchart TD
  subgraph c_73_v3_direct_sse_accept_skeleton_m_v3_runtime["v3-runtime"]
    c_73_v3_direct_sse_accept_skeleton_3["v3-runtime<br/>execute_v3_responses_direct_runtime_kernel<br/><small>routecodex-v3-runtime/src/kernel.rs</small>"]
    c_73_v3_direct_sse_accept_skeleton_4["v3-runtime<br/>V3HookRegistry::direct_sse_typed_hooks<br/><small>routecodex-v3-runtime/src/hooks.rs</small>"]
  end
  subgraph c_73_v3_direct_sse_accept_skeleton_m_v3_server["v3-server"]
    c_73_v3_direct_sse_accept_skeleton_0["v3-server<br/>pending_endpoint_after_responses_admission<br/><small>routecodex-v3-server/src/endpoint_handlers.rs</small>"]
    c_73_v3_direct_sse_accept_skeleton_1["v3-server<br/>pending_endpoint_after_responses_admission_inner<br/><small>routecodex-v3-server/src/endpoint_handlers.rs</small>"]
    c_73_v3_direct_sse_accept_skeleton_2["v3-server<br/>v3_io_sse_body<br/><small>routecodex-v3-server/src/frame_builders.rs</small>"]
  end
  c_73_v3_direct_sse_accept_skeleton_0 -->|v3-direct-sse-accept-skeleton-01<br/>V3DirectSseAccept01ClientChannel → V3DirectSseAccept02RuntimeWorker| c_73_v3_direct_sse_accept_skeleton_1
  c_73_v3_direct_sse_accept_skeleton_1 -->|v3-direct-sse-accept-skeleton-02<br/>V3DirectSseAccept02RuntimeWorker → V3DirectSseAccept03ProjectedClientFrame| c_73_v3_direct_sse_accept_skeleton_2
  c_73_v3_direct_sse_accept_skeleton_3 -->|v3-direct-typed-hook-catalog-02<br/>V3DirectResp14ProviderProjectionPrepared → V3DirectResp14ProviderProjectionPrepared| c_73_v3_direct_sse_accept_skeleton_4
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-direct-sse-accept-skeleton-01` | `V3DirectSseAccept01ClientChannel` → `V3DirectSseAccept02RuntimeWorker` | anchored | pending_endpoint_after_responses_admission<br/><small>routecodex-v3-server/src/endpoint_handlers.rs</small> | pending_endpoint_after_responses_admission_inner<br/><small>routecodex-v3-server/src/endpoint_handlers.rs</small> | `v3.direct_sse_accept_skeleton` |
| `v3-direct-sse-accept-skeleton-02` | `V3DirectSseAccept02RuntimeWorker` → `V3DirectSseAccept03ProjectedClientFrame` | anchored | pending_endpoint_after_responses_admission_inner<br/><small>routecodex-v3-server/src/endpoint_handlers.rs</small> | v3_io_sse_body<br/><small>routecodex-v3-server/src/frame_builders.rs</small> | `v3.direct_sse_accept_skeleton` |
| `v3-direct-typed-hook-catalog-02` | `V3DirectResp14ProviderProjectionPrepared` → `V3DirectResp14ProviderProjectionPrepared` | active | execute_v3_responses_direct_runtime_kernel<br/><small>routecodex-v3-runtime/src/kernel.rs</small> | V3HookRegistry::direct_sse_typed_hooks<br/><small>routecodex-v3-runtime/src/hooks.rs</small> | `v3.responses_chat_sse_typed_tree_refactor` |

## v3.responses_direct_full_attempt_commit

Direct provider SSE attempts remain runtime-buffered until a protocol terminal; failure enters Error01-05 and reselects before any business frame reaches the client.

Owner feature: `v3.responses_direct_full_attempt_commit`
Manifest: `docs/architecture/manifests/v3.direct_sse_accept_skeleton.mainline.yml`

```mermaid
flowchart TD
  subgraph c_74_v3_responses_direct_full_attempt_commit_m_v3_runtime["v3-runtime"]
    c_74_v3_responses_direct_full_attempt_commit_0["v3-runtime<br/>wrap_direct_sse_provider_event_json_observation_stream_with_compat_hook<br/><small>routecodex-v3-runtime/src/kernel/direct_runtime_helpers_stream.rs</small>"]
    c_74_v3_responses_direct_full_attempt_commit_1["v3-runtime<br/>V3DirectSseAttemptBuffer::push<br/><small>routecodex-v3-runtime/src/kernel/direct_runtime_helpers_stream.rs</small>"]
    c_74_v3_responses_direct_full_attempt_commit_2["v3-runtime<br/>execute_v3_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel/v3_direct_core.rs</small>"]
    c_74_v3_responses_direct_full_attempt_commit_3["v3-runtime<br/>commit_direct_sse_attempt_after_terminal<br/><small>routecodex-v3-runtime/src/kernel/direct_runtime_helpers_stream.rs</small>"]
  end
  c_74_v3_responses_direct_full_attempt_commit_0 -->|v3-direct-sse-full-attempt-buffer<br/>V3ProviderResp14Raw → V3DirectResp14ProviderProjectionPrepared| c_74_v3_responses_direct_full_attempt_commit_1
  c_74_v3_responses_direct_full_attempt_commit_2 -->|v3-direct-sse-full-attempt-terminal-commit<br/>V3DirectResp14ProviderProjectionPrepared → V3DirectSseAccept03ProjectedClientFrame| c_74_v3_responses_direct_full_attempt_commit_3
```

| Step | Node edge | Status | Caller | Callee | Owner |
| --- | --- | --- | --- | --- | --- |
| `v3-direct-sse-full-attempt-buffer` | `V3ProviderResp14Raw` → `V3DirectResp14ProviderProjectionPrepared` | binding_pending | wrap_direct_sse_provider_event_json_observation_stream_with_compat_hook<br/><small>routecodex-v3-runtime/src/kernel/direct_runtime_helpers_stream.rs</small> | V3DirectSseAttemptBuffer::push<br/><small>routecodex-v3-runtime/src/kernel/direct_runtime_helpers_stream.rs</small> | `v3.responses_direct_full_attempt_commit` |
| `v3-direct-sse-full-attempt-terminal-commit` | `V3DirectResp14ProviderProjectionPrepared` → `V3DirectSseAccept03ProjectedClientFrame` | binding_pending | execute_v3_direct_runtime_kernel_core<br/><small>routecodex-v3-runtime/src/kernel/v3_direct_core.rs</small> | commit_direct_sse_attempt_after_terminal<br/><small>routecodex-v3-runtime/src/kernel/direct_runtime_helpers_stream.rs</small> | `v3.responses_direct_full_attempt_commit` |

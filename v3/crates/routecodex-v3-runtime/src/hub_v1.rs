mod common;
pub(crate) use common::{
    v3_feature_enabled_for_server, v3_tool_thinking_enabled_for_server,
    v3_toolreason_client_projection_enabled_for_server, V3HubOpaquePayload, V3HubResponsePayload,
    V3HubResponseToolCall,
};
pub use common::{
    V3HubEntryProtocol, V3HubInvocationSource, V3HubRelayToolKind, V3HubRequestSemanticProtocol,
    V3HubResponseNormalizedKind, V3HubResponseTerminality, V3HubServertoolResponseAction,
    V3HubTargetResolution, V3HubTransportIntent, V3ProviderCompatProfileId, V3ServerToolCenter,
    V3ServerToolCenterKey, V3ServerToolCenterPoisoned, V3ServerToolCenterWriteAction,
    V3ServerToolCenterWriteAuditEntry, V3ServerToolCenterWriteOrigin, V3ServerToolInstanceState,
    V3ServerToolName, V3WebSearchCenterPhase, V3WebSearchCenterState,
};
pub use common::{V3HubExecutionMode, V3HubProviderWireProtocol};
mod provider_compat_error;
pub(crate) use provider_compat_error::classify_v3_provider_compat_error;
pub(crate) use provider_compat_error::provider_request_payload_source;
pub use provider_compat_error::{
    extract_v3_provider_compat_boundary_field, provider_compat_boundary_source,
    V3ProviderCompatError, V3ProviderCompatErrorClassification,
};

mod side_channel;
pub(crate) use side_channel::find_v3_hub_side_channel_key;
mod provider_request_dry_run;
pub(crate) use provider_request_dry_run::{
    captured_provider_response_for_dry_run, is_captured_provider_response_for_dry_run,
    V3ProviderRequestDryRunNoNetworkTransport,
};
mod provider_compat_shared;
pub(crate) use provider_compat_shared::{
    build_v3_anthropic_messages_transport_request_from_v3_provider_08_with_provider_headers,
    build_v3_provider_transport_request_for_protocol, is_v3_gpt_canonical_model,
    is_v3_retain_response_cipher, provider_protocol_compat_id,
    provider_wire_protocol_for_provider_type, provider_wire_protocol_for_selected_candidate,
};
mod relay_runtime_shared;
pub(crate) use relay_runtime_shared::{
    build_v3_relay_observability, error_output, extract_error_type_style,
    extract_message_type_style, handle_provider_failure, provider_pool_exhausted_source,
    provider_request_failure, provider_runtime_failure, provider_target,
    push_sse_response_chain_trace, server_routing_group,
    wrap_v3_relay_client_sse_usage_observation, V3RelayCommittedSseStream,
    V3RelayProjectedSseStream, V3RelayProviderFailure,
};
mod relay_runtime_core;
pub(crate) use relay_runtime_core::{
    execute_v3_relay_runtime_core, v3_relay_transport_response_timeout, V3RelayCoreError,
    V3RelayProtocolCodec,
};
mod responses_openai_codec;
pub(crate) use responses_openai_codec::build_v3_chat_canonical_request_from_responses_payload_for_req_inbound;
mod responses_sse_tree;
pub use responses_sse_tree::*;
mod anthropic_sse_tree;
mod openai_chat_sse_tree;
pub use openai_chat_sse_tree::*;
mod client_metadata_projection;
mod history_image_cleanup;
pub(crate) use history_image_cleanup::{
    count_v3_payload_image_refs, normalize_v3_all_images_to_placeholder,
    normalize_v3_history_image_placeholders,
};
mod request_outbound_builtin_tool_projection;
mod request_outbound_format;
mod request_outbound_mcp_names;
mod request_outbound_metadata;
mod request_outbound_tool_id;
pub(crate) use request_outbound_format::{
    build_v3_anthropic_provider_request_source_from_chat_canonical,
    build_v3_openai_chat_standard_request_for_selected_web_search_mode,
    build_v3_openai_chat_standard_request_from_chat_canonical,
    build_v3_openai_responses_standard_request_from_chat_canonical,
    normalize_v3_openai_responses_provider_request_payload,
};
mod anthropic_codec_tool_projection;
mod anthropic_request_field_projection;

mod req_inbound_01_client_raw;
pub use req_inbound_01_client_raw::*;
mod req_inbound_02_normalized;
pub use req_inbound_02_normalized::*;
mod req_chat_process_04_governed;
pub use req_chat_process_04_governed::build_v3_hub_req_chat_process_04_from_v3_hub_req_inbound_02;
pub use req_chat_process_04_governed::V3HubReqChatProcess04Governed;
mod req_execution_05_planned;
pub use req_execution_05_planned::*;
mod req_target_06_resolved;
pub use req_target_06_resolved::*;
mod req_outbound_07_provider_semantic;
pub use req_outbound_07_provider_semantic::*;
mod provider_req_compat_06_provider_compat;
pub use provider_req_compat_06_provider_compat::*;
mod provider_req_outbound_08_wire_payload;
pub use provider_req_outbound_08_wire_payload::*;
mod provider_req_outbound_09_transport_request;
pub use provider_req_outbound_09_transport_request::*;
mod provider_resp_inbound_01_raw;
pub use provider_resp_inbound_01_raw::*;
mod provider_resp_compat_02_provider_compat;
pub use provider_resp_compat_02_provider_compat::*;
mod provider_terminal_response_admission;
pub(crate) use provider_terminal_response_admission::*;
mod provider_sse_json_codec;
pub(crate) use provider_sse_json_codec::*;
#[cfg(test)]
mod provider_sse_json_codec_mcp_namespace_tests;
mod resp_inbound_02_normalized;
pub use resp_inbound_02_normalized::*;
mod resp_chat_process_03_governed;
pub use resp_chat_process_03_governed::*;
pub use responses_relay_runtime::execute_v3_responses_relay_runtime_with_default_transport_health_server_tool_state;
mod resp_outbound_05_client_semantic;
pub use resp_outbound_05_client_semantic::*;
mod server_resp_outbound_06_client_frame;
pub use server_resp_outbound_06_client_frame::*;

mod relay_request;
pub use relay_request::*;
mod servertool_hooks;
pub use servertool_hooks::*;
mod anthropic_codec;
pub use anthropic_codec::*;
mod openai_chat_codec;
pub use openai_chat_codec::*;
mod gemini_codec;
pub use gemini_codec::*;
mod gemini_relay_runtime;
pub use gemini_relay_runtime::*;
mod openai_chat_relay_runtime;
pub use openai_chat_relay_runtime::*;
mod responses_relay_runtime;
pub(crate) mod web_search_hop;
pub use responses_relay_runtime::*;
pub(crate) use web_search_hop::{
    execute_local_web_search_hop, first_local_websearch_tool_call,
    project_web_search_result_into_finalized, resolve_request_web_search_backend_binding,
    resolve_web_search_mode_and_backend,
};
mod anthropic_relay_hooks;
pub use anthropic_relay_hooks::*;
mod anthropic_relay_runtime;
pub use anthropic_relay_runtime::*;
mod anthropic_relay_runtime_codec;
pub use anthropic_relay_runtime_codec::*;
mod relay_sse_hooks;
mod resource_hooks;
pub use resource_hooks::*;

#[cfg(test)]
mod tests;

//! Hub Pipeline topology type skeletons.
//!
//! These types lock phase names without changing the runtime pipeline. They are
//! transparent wrappers until the existing paths are migrated behind adjacent
//! builders, parsers, and projectors.

mod hub_req_chatprocess_03_governed;
mod hub_req_inbound_02_standardized;
mod hub_req_outbound_05_provider_semantic;
mod hub_resp_chatprocess_03_governed;
mod hub_resp_inbound_02_parsed;
mod hub_resp_outbound_04_client_semantic;
mod meta_error_carriers;
mod provider_req_outbound_06_wire_payload;
mod request_typed_entrypoints;
mod response_typed_entrypoints;
mod vr_route_04_selected_target;

pub(crate) use hub_req_chatprocess_03_governed::{
    build_hub_req_chatprocess_03_from_hub_req_inbound_02, HubReqChatProcess03Governed,
};
pub(crate) use hub_req_inbound_02_standardized::{
    build_hub_req_inbound_02_from_payload, HubReqInbound02Standardized,
};
pub(crate) use hub_req_outbound_05_provider_semantic::{
    build_hub_req_outbound_05_from_hub_req_chatprocess_03, HubReqOutbound05ProviderSemantic,
};
pub(crate) use hub_resp_chatprocess_03_governed::{
    build_hub_resp_chatprocess_03_from_hub_resp_inbound_02, HubRespChatProcess03Governed,
};
pub(crate) use hub_resp_inbound_02_parsed::{
    parse_hub_resp_inbound_02_from_provider_resp_inbound_01, HubRespInbound02Parsed,
};
pub(crate) use hub_resp_outbound_04_client_semantic::{
    project_hub_resp_outbound_04_from_hub_resp_chatprocess_03, HubRespOutbound04ClientSemantic,
};
pub(crate) use meta_error_carriers::{
    build_error_err_03_runtime_classified, build_meta_req_02_runtime_carrier,
    build_meta_route_03_from_metadata, ErrorErr03RuntimeClassified, MetaReq02RuntimeCarrier,
    MetaRoute03RouteCarrier,
};
pub(crate) use provider_req_outbound_06_wire_payload::{
    build_provider_req_outbound_06_from_hub_req_outbound_05, ProviderReqOutbound06WirePayload,
};
pub(crate) use request_typed_entrypoints::{
    run_hub_req_chatprocess_03_governed_entrypoint, run_hub_req_inbound_02_standardized_entrypoint,
    run_hub_req_outbound_05_provider_semantic_entrypoint,
};
pub(crate) use response_typed_entrypoints::{
    run_hub_resp_chatprocess_03_governed_entrypoint, run_hub_resp_inbound_02_parsed_entrypoint,
    run_hub_resp_outbound_04_client_semantic_entrypoint,
};
pub(crate) use vr_route_04_selected_target::{
    build_vr_route_04_from_hub_req_chatprocess_03, VrRoute04SelectedTarget,
};

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

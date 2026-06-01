//! Hub Pipeline topology type skeletons.
//!
//! These types lock the request-side phase names without changing the runtime
//! pipeline. They are transparent wrappers until the existing request path is
//! migrated behind adjacent builders.

mod hub_req_chatprocess_03_governed;
mod hub_req_inbound_02_standardized;
mod hub_req_outbound_05_provider_semantic;

pub(crate) use hub_req_chatprocess_03_governed::{
    build_hub_req_chatprocess_03_from_hub_req_inbound_02, HubReqChatProcess03Governed,
};
pub(crate) use hub_req_inbound_02_standardized::{
    build_hub_req_inbound_02_from_payload, HubReqInbound02Standardized,
};
pub(crate) use hub_req_outbound_05_provider_semantic::{
    build_hub_req_outbound_05_from_hub_req_chatprocess_03, HubReqOutbound05ProviderSemantic,
};

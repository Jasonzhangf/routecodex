pub(crate) mod bootstrap;
pub(crate) mod chat_process_session_usage;
mod classifier;
pub(crate) mod config_bootstrap;
mod context_weighted;
mod engine;
mod error;
pub(crate) mod features;
mod forwarder;
mod health;
mod health_weighted;
pub(crate) mod instructions;
mod load_balancer;
mod message_utils;
mod napi_proxy;
mod profile_utils;
pub(crate) mod provider_bootstrap;
mod provider_registry;
pub(crate) mod provider_runtime_ingress;
pub(crate) mod rcc_fence;
pub(crate) mod routing;
pub(crate) mod routing_state_store;
pub(crate) mod runtime_config_materialization;
mod time_utils;
pub(crate) mod virtual_router_host_effects;

pub(crate) use engine::{
    evaluate_singleton_route_pool_exhaustion, SingletonRoutePoolExhaustionDecision,
    SingletonRoutePoolExhaustionInput, VirtualRouterEngineCore,
};
#[allow(unused_imports)]
pub use napi_proxy::VirtualRouterEngineProxy;
pub(crate) use provider_registry::derive_model_id;

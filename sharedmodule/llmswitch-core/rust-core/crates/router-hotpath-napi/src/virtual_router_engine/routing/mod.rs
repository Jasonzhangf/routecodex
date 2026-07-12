mod bootstrap;
mod config;
mod direct_model;
mod error_err05_availability;
mod key_utils;
mod metadata;
mod primary_exhausted_to_default_pool;
mod selection;
mod utils;

#[allow(unused_imports)]
pub(crate) use bootstrap::{bootstrap_virtual_router_routing_json, NormalizedRoutePoolConfig};
#[allow(unused_imports)]
pub(crate) use config::{
    build_route_queue, default_pool_supports_capability, filter_pools_by_capability,
    filter_pools_by_capability_with_forwarders, filter_pools_by_visual_capability,
    filter_pools_by_visual_capability_with_forwarders, parse_routing, route_has_targets,
    RoutePoolTier, RoutingPools,
};
#[allow(unused_imports)]
pub(crate) use direct_model::{
    direct_model_media_requirement_error, parse_direct_provider_model, select_direct_provider_model,
};
pub(crate) use error_err05_availability::{
    resolve_error_err05_route_availability_decision, ErrorErr05RouteAvailabilityDecisionInput,
};
pub(crate) use key_utils::{extract_key_alias, extract_provider_id};
#[allow(unused_imports)]
pub(crate) use metadata::{
    build_scoped_session_key, extract_excluded_provider_keys, extract_runtime_now_ms,
    is_continuation_request, is_server_tool_followup_request, resolve_routing_state_key,
    resolve_session_scope, resolve_stop_message_scope,
};
pub(crate) use selection::{
    filter_candidates_by_state, resolve_instruction_process_mode_for_selection,
    resolve_instruction_target, InstructionTargetMatchMode,
};
pub(crate) use utils::{
    normalize_trimmed_string_values, normalize_unique_trimmed_strings, push_unique_trimmed,
    trim_nonempty_str,
};

#[allow(unused_imports)]
pub(crate) use primary_exhausted_to_default_pool::{
    plan_primary_exhausted_to_default_pool, PrimaryExhaustedPlanInput, PrimaryExhaustedPlanStatus,
    PrimaryExhaustedToDefaultPoolPlan, RoutePoolTierInput,
};

mod antigravity;
mod config;
mod direct_model;
mod metadata;
mod selection;

#[allow(unused_imports)]
pub(crate) use antigravity::{
    alias_prefix_from_alias_key, build_antigravity_alias_key,
    should_avoid_antigravity_after_repeated_error, should_bind_antigravity_session,
};
#[allow(unused_imports)]
pub(crate) use config::{
    build_route_candidates, build_route_queue, default_pool_supports_capability,
    filter_pools_by_capability, parse_routing, route_has_targets, RoutePoolTier, RoutingPools,
};
#[allow(unused_imports)]
pub(crate) use direct_model::{
    parse_direct_provider_model, select_direct_provider_model,
    should_fallback_direct_model_for_media,
};
#[allow(unused_imports)]
pub(crate) use metadata::{
    build_scoped_session_key, extract_excluded_provider_keys, extract_runtime_now_ms,
    is_server_tool_followup_request, resolve_session_scope, resolve_sticky_key,
    resolve_stop_message_scope,
};
#[allow(unused_imports)]
pub(crate) use selection::{
    filter_candidates_by_state, resolve_instruction_process_mode_for_selection,
    resolve_instruction_target, InstructionTargetMatchMode,
};

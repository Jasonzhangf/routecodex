mod core;
mod events;
mod route;
mod selection;
mod status;
mod tier_load_balancing;
mod types;

// feature_id: vr.route_availability_floor
// canonical_builders: build_unavailable_providers_details, collect_recoverable_cooldown_for_key
// Owner implementation lives in selection.rs; this module-level anchor keeps the
// architecture map queryable without restoring the deleted TS runtime shell.
pub(crate) use core::VirtualRouterEngineCore;

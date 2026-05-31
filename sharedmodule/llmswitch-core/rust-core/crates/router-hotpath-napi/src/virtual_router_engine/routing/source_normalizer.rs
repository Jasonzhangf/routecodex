use std::collections::BTreeMap;

use serde_json::{Map, Value};

use super::bootstrap::NormalizedRoutePoolConfig;

/// Normalize raw routing config into normalized route pools.
/// This is a thin wrapper that calls the implementation in bootstrap.rs.
pub(crate) fn normalize_routing(
    source: &Map<String, Value>,
) -> BTreeMap<String, Vec<NormalizedRoutePoolConfig>> {
    super::bootstrap::normalize_routing_impl(source)
}

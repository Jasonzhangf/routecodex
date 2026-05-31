use std::collections::{BTreeMap, HashSet};

use serde_json::Value;

use super::bootstrap::{NormalizedRoutePoolConfig, ModelIndexEntry, ExpandedTargetCandidate, ParsedRouteEntry, PROVIDER_LEVEL_POOL_ALIAS};
use super::config::RoutePoolTier;

/// Expand normalized routing table with provider aliases and model indices.
/// This is a thin wrapper that calls the implementation in bootstrap.rs.
pub(crate) fn expand_routing_table(
    routing_source: &BTreeMap<String, Vec<NormalizedRoutePoolConfig>>,
    alias_index: &BTreeMap<String, Vec<String>>,
    model_index: &BTreeMap<String, ModelIndexEntry>,
) -> Result<(BTreeMap<String, Vec<RoutePoolTier>>, Vec<String>), String> {
    super::bootstrap::expand_routing_table_impl(routing_source, alias_index, model_index)
}

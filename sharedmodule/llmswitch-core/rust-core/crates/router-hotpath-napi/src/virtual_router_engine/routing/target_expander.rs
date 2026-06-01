use std::collections::{BTreeMap, HashSet};

use super::bootstrap::{ModelIndexEntry, NormalizedRoutePoolConfig};
use super::config::RoutePoolTier;

/// Expand normalized routing table with provider aliases and model indices.
/// This is a thin wrapper that calls the implementation in bootstrap.rs.
pub(crate) fn expand_routing_table(
    routing_source: &BTreeMap<String, Vec<NormalizedRoutePoolConfig>>,
    alias_index: &BTreeMap<String, Vec<String>>,
    model_index: &BTreeMap<String, ModelIndexEntry>,
    forwarder_ids: &HashSet<String>,
) -> Result<(BTreeMap<String, Vec<RoutePoolTier>>, Vec<String>), String> {
    super::bootstrap::expand_routing_table_impl(
        routing_source,
        alias_index,
        model_index,
        forwarder_ids,
    )
}

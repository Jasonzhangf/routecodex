//! V4 CLI plugin library — owns every CLI subcommand/handler so the binary
//! entrypoint can stay a thin shim. The build-link `test-consumer` path
//! compiles this crate as `--crate-type lib`, so the dispatcher logic must
//! live behind `pub fn run()` rather than `fn main()`.

use clap::{Parser, Subcommand};
use routecodex_v4_standard_plugins::{
    standard_allowed_reads, standard_allowed_writes, standard_node_allowed_reads,
    standard_node_allowed_writes, standard_plugins, standard_resource_registry, PluginCategory,
    STANDARD_LIBRARY_OWNER, STANDARD_LIBRARY_VERSION,
};
use std::collections::BTreeSet;

const ADDITIONAL_STANDARD_NODE_IDS: &[&str] =
    &["V4Router05RequestClassified", "V4Router06SelectionPlan"];

fn standard_node_ids() -> BTreeSet<String> {
    let mut ids: BTreeSet<String> = standard_plugins()
        .into_iter()
        .map(|plugin| plugin.descriptor.node_selector.node_id)
        .collect();
    ids.extend(
        ADDITIONAL_STANDARD_NODE_IDS
            .iter()
            .map(|id| (*id).to_string()),
    );
    ids
}

fn inspectable_standard_node_ids() -> BTreeSet<String> {
    standard_node_ids()
        .into_iter()
        .filter(|node_id| {
            !standard_node_allowed_reads(node_id).is_empty()
                || !standard_node_allowed_writes(node_id).is_empty()
        })
        .collect()
}

#[derive(Debug, Parser)]
#[command(
    name = "rccv4-plugin",
    version = STANDARD_LIBRARY_VERSION,
    about = "V4 admission baseline CLI plugin dispatcher (read-only)"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Print the standard plugin library version and owner.
    Version,
    /// List every registered standard plugin id (sorted, deterministic).
    ListPlugins,
    /// Print one plugin descriptor by id. Fails fast if unknown.
    #[command(name = "describe-plugin")]
    DescribePlugin {
        /// The plugin id to describe (e.g. `v4.std.protocol.wire_codec_proto`).
        plugin_id: String,
    },
    /// Print the standard resource registry (id + axis only).
    #[command(name = "list-resources")]
    ListResources,
    /// Print node-scoped reads/writes for a given node id. Fails fast if the
    /// node is not part of the standard node permission surface.
    #[command(name = "node-permissions")]
    NodePermissions {
        /// The node id to inspect (e.g. `V4HubRespInbound02Parsed`).
        node_id: String,
    },
    /// Print the union of resources the standard library may read / write.
    Surface,
    /// List registered plugin categories and the count of plugins per category.
    Categories,
}

pub fn run() -> Result<(), String> {
    let cli = Cli::parse();
    match cli.command {
        None | Some(Command::Version) => {
            println!(
                "rccv4-plugin version {version} owner {owner}",
                version = STANDARD_LIBRARY_VERSION,
                owner = STANDARD_LIBRARY_OWNER
            );
        }
        Some(Command::ListPlugins) => {
            let plugins = standard_plugins();
            let mut ids: Vec<&str> = plugins
                .iter()
                .map(|plugin| plugin.plugin_id.as_str())
                .collect();
            ids.sort_unstable();
            let json = serde_json::to_string_pretty(&ids)
                .map_err(|error| format!("failed to encode plugin id list: {error}"))?;
            println!("{json}");
        }
        Some(Command::DescribePlugin { plugin_id }) => {
            let plugin = standard_plugins()
                .into_iter()
                .find(|plugin| plugin.plugin_id == plugin_id)
                .ok_or_else(|| format!("unknown plugin id {plugin_id}"))?;
            let descriptor = plugin.descriptor;
            let json = serde_json::json!({
                "plugin_id": descriptor.plugin_id,
                "owner": descriptor.owner,
                "node_id": descriptor.node_selector.node_id,
                "role_id": descriptor.node_selector.role_id,
                "position": descriptor.node_selector.position,
                "kind": format!("{:?}", descriptor.kind),
                "effect": format!("{:?}", descriptor.effect),
                "phase": format!("{:?}", descriptor.phase),
                "order": descriptor.order,
                "reads": descriptor.reads,
                "writes": descriptor.writes,
                "services_provided": descriptor.services_provided,
                "services_injected": descriptor.inject,
                "artifact_hash": descriptor.artifact_hash,
                "contract_hash": descriptor.contract_hash,
            });
            println!(
                "{}",
                serde_json::to_string_pretty(&json)
                    .map_err(|error| format!("failed to encode descriptor: {error}"))?
            );
        }
        Some(Command::ListResources) => {
            let entries: Vec<serde_json::Value> = standard_resource_registry()
                .resources
                .iter()
                .map(|entry| {
                    serde_json::json!({
                        "resource_id": entry.resource_id,
                        "axis": format!("{:?}", entry.axis),
                    })
                })
                .collect();
            println!(
                "{}",
                serde_json::to_string_pretty(&entries)
                    .map_err(|error| format!("failed to encode resource list: {error}"))?
            );
        }
        Some(Command::NodePermissions { node_id }) => {
            if !inspectable_standard_node_ids().contains(&node_id) {
                return Err(format!(
                    "node {node_id} has no standard permission surface; only registered active nodes are inspectable"
                ));
            }
            let reads = standard_node_allowed_reads(&node_id);
            let writes = standard_node_allowed_writes(&node_id);
            let json = serde_json::json!({
                "node_id": node_id,
                "reads": reads,
                "writes": writes,
            });
            println!(
                "{}",
                serde_json::to_string_pretty(&json)
                    .map_err(|error| format!("failed to encode node permissions: {error}"))?
            );
        }
        Some(Command::Surface) => {
            let json = serde_json::json!({
                "reads": standard_allowed_reads(),
                "writes": standard_allowed_writes(),
            });
            println!(
                "{}",
                serde_json::to_string_pretty(&json)
                    .map_err(|error| format!("failed to encode surface: {error}"))?
            );
        }
        Some(Command::Categories) => {
            let mut counts: Vec<(PluginCategory, usize)> = Vec::new();
            for category in [
                PluginCategory::Contracts,
                PluginCategory::Diagnostic,
                PluginCategory::Control,
                PluginCategory::Error,
                PluginCategory::Protocol,
                PluginCategory::ChatProcess,
                PluginCategory::Routing,
                PluginCategory::Provider,
            ] {
                let count = standard_plugins()
                    .iter()
                    .filter(|plugin| plugin.category == category)
                    .count();
                counts.push((category, count));
            }
            let json: Vec<serde_json::Value> = counts
                .iter()
                .map(|(category, count)| {
                    serde_json::json!({
                        "category": format!("{category:?}"),
                        "count": count,
                    })
                })
                .collect();
            println!(
                "{}",
                serde_json::to_string_pretty(&json)
                    .map_err(|error| format!("failed to encode category counts: {error}"))?
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_owner_match_constants() {
        assert_eq!(STANDARD_LIBRARY_OWNER, "routecodex-v4-standard-plugins");
        assert!(!STANDARD_LIBRARY_VERSION.is_empty());
    }

    #[test]
    fn surface_includes_response_payloads() {
        let reads = standard_allowed_reads();
        let writes = standard_allowed_writes();
        assert!(reads.iter().any(|id| id == "v4.response.normal_payload"));
        assert!(reads.iter().any(|id| id == "v4.response.provider_raw"));
        assert!(writes.iter().any(|id| id == "v4.response.normal_payload"));
        assert!(writes
            .iter()
            .any(|id| id == "v4.response.client_wire_payload"));
    }

    #[test]
    fn node_permission_for_response_inbound_is_locked() {
        let reads = standard_node_allowed_reads("V4HubRespInbound02Parsed");
        let writes = standard_node_allowed_writes("V4HubRespInbound02Parsed");
        assert_eq!(reads, vec!["v4.response.provider_raw".to_string()]);
        assert_eq!(writes, vec!["v4.response.normal_payload".to_string()]);
    }

    #[test]
    fn unknown_node_permission_is_rejected() {
        assert!(run_for_node("V4NotARegisteredNode").is_err());
    }

    #[test]
    fn router_control_only_node_is_inspectable_surface() {
        assert!(run_for_node("V4Router05RequestClassified").is_ok());
        assert!(run_for_node("V4Router06SelectionPlan").is_ok());
    }

    fn run_for_node(node_id: &str) -> Result<(), String> {
        if !inspectable_standard_node_ids().contains(node_id) {
            return Err(format!("node {node_id} has no standard permission surface"));
        }
        let reads = standard_node_allowed_reads(node_id);
        let writes = standard_node_allowed_writes(node_id);
        if reads.is_empty() && writes.is_empty() {
            return Err(format!("node {node_id} has no standard permission surface"));
        }
        Ok(())
    }
}

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;

use super::super::features::RoutingFeatures;
use super::super::load_balancer::LoadBalancingPolicy;
use super::super::provider_registry::ProviderRegistry;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RoutePoolTier {
    pub id: String,
    pub targets: Vec<String>,
    pub priority: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load_balancing: Option<LoadBalancingPolicy>,
    #[serde(rename = "routeParams", skip_serializing_if = "Option::is_none")]
    pub route_params: Option<Map<String, Value>>,
    /// Reasoning effort override for this route pool (low/medium/high/off).
    /// When None, falls back to route-level default logic.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct RoutingPools {
    pub pools: HashMap<String, Vec<RoutePoolTier>>,
}

impl RoutingPools {
    pub(crate) fn get(&self, route: &str) -> Vec<RoutePoolTier> {
        self.pools.get(route).cloned().unwrap_or_default()
    }

    pub(crate) fn has_targets(&self, pools: &[RoutePoolTier]) -> bool {
        pools.iter().any(|tier| !tier.targets.is_empty())
    }

    pub(crate) fn get_opt(&self, route: &str) -> Option<&Vec<RoutePoolTier>> {
        self.pools.get(route)
    }

    pub(crate) fn keys(&self) -> impl Iterator<Item = &String> {
        self.pools.keys()
    }

    pub(crate) fn flatten_targets(&self, pools: &[RoutePoolTier]) -> Vec<String> {
        let mut out = Vec::new();
        for tier in pools {
            for target in &tier.targets {
                if !out.contains(target) {
                    out.push(target.clone());
                }
            }
        }
        out
    }
}

pub(crate) fn parse_routing(routing: &Map<String, Value>) -> RoutingPools {
    let mut pools = HashMap::new();
    for (route, value) in routing.iter() {
        let mut tiers = value
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| serde_json::from_value::<RoutePoolTier>(item.clone()).ok())
                    .collect::<Vec<RoutePoolTier>>()
            })
            .unwrap_or_default();
        tiers.sort_by(|left, right| right.priority.cmp(&left.priority));
        pools.insert(route.clone(), tiers);
    }
    RoutingPools { pools }
}

pub(crate) fn route_has_targets(routing: &RoutingPools, route: &str) -> bool {
    // Check bare route name AND any group-prefixed key ending with ":{route}"
    if routing
        .get(route)
        .iter()
        .any(|tier| !tier.targets.is_empty())
    {
        return true;
    }
    routing.keys().any(|key| {
        key.ends_with(&format!(":{}", route))
            && routing
                .get(key.as_str())
                .iter()
                .any(|tier| !tier.targets.is_empty())
    })
}

pub(crate) fn build_route_queue(
    requested_route: &str,
    candidates: &[String],
    features: &RoutingFeatures,
    routing: &RoutingPools,
) -> Vec<String> {
    let mut queue: Vec<String> = Vec::new();
    let requested_route_trimmed = requested_route.trim();
    let has_multimodal_targets = route_has_targets(routing, "multimodal");
    let has_vision_targets = route_has_targets(routing, "vision");
    let has_video_targets = route_has_targets(routing, "video");
    let has_tools_targets = route_has_targets(routing, "tools");
    let has_remote_video_attachment =
        features.has_video_attachment && features.has_remote_video_attachment;

    if !requested_route.trim().is_empty() {
        queue.push(requested_route.to_string());
    }
    for route in candidates {
        if !queue.contains(route) {
            queue.push(route.clone());
        }
    }

    if has_remote_video_attachment && has_video_targets && !queue.iter().any(|v| v == "video") {
        queue.insert(0, "video".to_string());
    }

    if features.has_image_attachment && has_multimodal_targets {
        if !queue.iter().any(|v| v == "multimodal") {
            queue.insert(0, "multimodal".to_string());
        }
    }

    let should_insert_tools_continuation =
        should_insert_tools_for_current_tool_continuation(requested_route_trimmed, features)
            && has_tools_targets;
    if should_insert_tools_continuation && !queue.iter().any(|v| v == "tools") {
        if let Some(requested_index) = queue
            .iter()
            .position(|route| route == requested_route_trimmed)
        {
            queue.insert(requested_index + 1, "tools".to_string());
        } else if let Some(default_index) = queue
            .iter()
            .position(|route| route == super::super::classifier::DEFAULT_ROUTE)
        {
            queue.insert(default_index, "tools".to_string());
        } else {
            queue.push("tools".to_string());
        }
    }

    let mut deduped: Vec<String> = Vec::new();
    for route in queue {
        if !route.trim().is_empty() && !deduped.contains(&route) {
            deduped.push(route);
        }
    }
    if !deduped.contains(&super::super::classifier::DEFAULT_ROUTE.to_string()) {
        deduped.push(super::super::classifier::DEFAULT_ROUTE.to_string());
    }
    deduped
}

fn should_insert_tools_for_current_tool_continuation(
    route: &str,
    features: &RoutingFeatures,
) -> bool {
    if features.latest_message_from_user || !features.has_tool_call_responses {
        return false;
    }
    matches!(
        route,
        "tools" | "search" | "read" | "write" | "web_search" | "thinking"
    )
}

pub(crate) fn filter_pools_by_capability(
    pools: &[RoutePoolTier],
    provider_registry: &ProviderRegistry,
    capability: &str,
) -> Vec<RoutePoolTier> {
    let mut out = Vec::new();
    for pool in pools {
        if pool.targets.is_empty() {
            continue;
        }
        let targets: Vec<String> = pool
            .targets
            .iter()
            .filter(|key| {
                if capability == "web_search" {
                    return provider_registry.has_capability(key, "web_search")
                        || provider_registry.has_capability(key, "web_search_direct");
                }
                provider_registry.has_capability(key, capability)
            })
            .cloned()
            .collect();
        if targets.is_empty() {
            continue;
        }
        let mut next = pool.clone();
        next.targets = targets;
        out.push(next);
    }
    out
}

pub(crate) fn default_pool_supports_capability(
    routing: &RoutingPools,
    provider_registry: &ProviderRegistry,
    capability: &str,
) -> bool {
    let pools = routing.get(super::super::classifier::DEFAULT_ROUTE);
    !filter_pools_by_capability(&pools, provider_registry, capability).is_empty()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::virtual_router_engine::features::RoutingFeatures;
    use serde_json::{Map, Value};

    #[test]
    fn declared_web_search_tool_does_not_prepend_web_search_route() {
        let routing = parse_routing(&Map::from_iter([(
            "web_search".to_string(),
            Value::Array(vec![serde_json::json!({
                "id": "web-search",
                "priority": 100,
                "targets": ["provider.search"]
            })]),
        )]));
        let features = RoutingFeatures {
            has_web_search_tool_declared: true,
            ..Default::default()
        };

        let queue = build_route_queue("thinking", &["default".to_string()], &features, &routing);

        assert_eq!(queue, vec!["thinking".to_string(), "default".to_string()]);
    }

    #[test]
    fn explicit_web_search_route_is_preserved() {
        let routing = parse_routing(&Map::from_iter([(
            "web_search".to_string(),
            Value::Array(vec![serde_json::json!({
                "id": "web-search",
                "priority": 100,
                "targets": ["provider.search"]
            })]),
        )]));
        let features = RoutingFeatures {
            has_web_search_tool_declared: true,
            ..Default::default()
        };

        let queue = build_route_queue("web_search", &["default".to_string()], &features, &routing);

        assert_eq!(queue, vec!["web_search".to_string(), "default".to_string()]);
    }

    #[test]
    fn thinking_route_with_targets_still_keeps_default_in_queue() {
        let routing = parse_routing(&Map::from_iter([
            (
                "thinking".to_string(),
                Value::Array(vec![serde_json::json!({
                    "id": "thinking",
                    "priority": 100,
                    "targets": ["provider.thinking"]
                })]),
            ),
            (
                "default".to_string(),
                Value::Array(vec![serde_json::json!({
                    "id": "default",
                    "priority": 100,
                    "targets": ["provider.default"]
                })]),
            ),
        ]));
        let queue = build_route_queue(
            "thinking",
            &["thinking".to_string(), "default".to_string()],
            &RoutingFeatures::default(),
            &routing,
        );
        assert_eq!(queue, vec!["thinking".to_string(), "default".to_string()]);
    }

    #[test]
    fn thinking_tool_continuation_inserts_tools_before_default() {
        let routing = parse_routing(&Map::from_iter([
            (
                "thinking".to_string(),
                Value::Array(vec![serde_json::json!({
                    "id": "thinking",
                    "priority": 100,
                    "targets": ["provider.thinking"]
                })]),
            ),
            (
                "tools".to_string(),
                Value::Array(vec![serde_json::json!({
                    "id": "tools",
                    "priority": 100,
                    "targets": ["provider.tools"]
                })]),
            ),
            (
                "default".to_string(),
                Value::Array(vec![serde_json::json!({
                    "id": "default",
                    "priority": 100,
                    "targets": ["provider.default"]
                })]),
            ),
        ]));
        let features = RoutingFeatures {
            latest_message_from_user: false,
            has_tool_call_responses: true,
            ..Default::default()
        };
        let queue = build_route_queue(
            "thinking",
            &[
                "thinking".to_string(),
                "tools".to_string(),
                "default".to_string(),
            ],
            &features,
            &routing,
        );
        assert_eq!(
            queue,
            vec![
                "thinking".to_string(),
                "tools".to_string(),
                "default".to_string()
            ]
        );
    }

    #[test]
    fn coding_route_without_targets_keeps_default_available() {
        let routing = parse_routing(&Map::from_iter([(
            "default".to_string(),
            Value::Array(vec![serde_json::json!({
                "id": "default",
                "priority": 100,
                "targets": ["provider.default"]
            })]),
        )]));
        let queue = build_route_queue(
            "coding",
            &["default".to_string()],
            &RoutingFeatures::default(),
            &routing,
        );
        assert_eq!(queue, vec!["coding".to_string(), "default".to_string()]);
    }

    #[test]
    fn search_route_without_tool_continuation_keeps_default_available() {
        let routing = parse_routing(&Map::from_iter([
            (
                "tools".to_string(),
                Value::Array(vec![serde_json::json!({
                    "id": "tools",
                    "priority": 100,
                    "targets": ["provider.tools"]
                })]),
            ),
            (
                "default".to_string(),
                Value::Array(vec![serde_json::json!({
                    "id": "default",
                    "priority": 100,
                    "targets": ["provider.default"]
                })]),
            ),
        ]));
        let queue = build_route_queue(
            "search",
            &["default".to_string()],
            &RoutingFeatures::default(),
            &routing,
        );
        assert_eq!(queue, vec!["search".to_string(), "default".to_string()]);
    }

    #[test]
    fn search_tool_continuation_inserts_tools_before_default() {
        let routing = parse_routing(&Map::from_iter([
            (
                "tools".to_string(),
                Value::Array(vec![serde_json::json!({
                    "id": "tools",
                    "priority": 100,
                    "targets": ["provider.tools"]
                })]),
            ),
            (
                "default".to_string(),
                Value::Array(vec![serde_json::json!({
                    "id": "default",
                    "priority": 100,
                    "targets": ["provider.default"]
                })]),
            ),
        ]));
        let features = RoutingFeatures {
            latest_message_from_user: false,
            has_tool_call_responses: true,
            ..Default::default()
        };
        let queue = build_route_queue("search", &["default".to_string()], &features, &routing);
        assert_eq!(
            queue,
            vec![
                "search".to_string(),
                "tools".to_string(),
                "default".to_string()
            ]
        );
    }

    #[test]
    fn image_attachment_prefers_multimodal_and_does_not_auto_prepend_vision() {
        let routing = parse_routing(&Map::from_iter([
            (
                "multimodal".to_string(),
                Value::Array(vec![serde_json::json!({
                    "id": "multimodal",
                    "priority": 100,
                    "targets": ["provider.mm"]
                })]),
            ),
            (
                "vision".to_string(),
                Value::Array(vec![serde_json::json!({
                    "id": "vision",
                    "priority": 100,
                    "targets": ["provider.vision"]
                })]),
            ),
            (
                "default".to_string(),
                Value::Array(vec![serde_json::json!({
                    "id": "default",
                    "priority": 100,
                    "targets": ["provider.default"]
                })]),
            ),
        ]));
        let features = RoutingFeatures {
            has_image_attachment: true,
            ..Default::default()
        };

        let queue = build_route_queue("coding", &["default".to_string()], &features, &routing);

        assert_eq!(
            queue,
            vec![
                "multimodal".to_string(),
                "coding".to_string(),
                "default".to_string()
            ]
        );
    }

    #[test]
    fn image_attachment_without_multimodal_targets_does_not_auto_route_to_vision() {
        let routing = parse_routing(&Map::from_iter([
            (
                "vision".to_string(),
                Value::Array(vec![serde_json::json!({
                    "id": "vision",
                    "priority": 100,
                    "targets": ["provider.vision"]
                })]),
            ),
            (
                "default".to_string(),
                Value::Array(vec![serde_json::json!({
                    "id": "default",
                    "priority": 100,
                    "targets": ["provider.default"]
                })]),
            ),
        ]));
        let features = RoutingFeatures {
            has_image_attachment: true,
            ..Default::default()
        };

        let queue = build_route_queue("coding", &["default".to_string()], &features, &routing);

        assert_eq!(queue, vec!["coding".to_string(), "default".to_string()]);
    }

    #[test]
    fn image_attachment_without_multimodal_targets_still_keeps_default_route_available() {
        let routing = parse_routing(&Map::from_iter([(
            "default".to_string(),
            Value::Array(vec![serde_json::json!({
                "id": "default",
                "priority": 100,
                "targets": ["provider.default"]
            })]),
        )]));
        let features = RoutingFeatures {
            has_image_attachment: true,
            ..Default::default()
        };

        let queue = build_route_queue("thinking", &["default".to_string()], &features, &routing);

        assert_eq!(queue, vec!["thinking".to_string(), "default".to_string()]);
    }

    #[test]
    fn parse_routing_orders_pools_by_priority_descending() {
        let routing = parse_routing(&Map::from_iter([(
            "search".to_string(),
            Value::Array(vec![
                serde_json::json!({
                    "id": "backup",
                    "priority": 10,
                    "targets": ["provider.backup"]
                }),
                serde_json::json!({
                    "id": "primary",
                    "priority": 100,
                    "targets": ["provider.primary"]
                }),
            ]),
        )]));

        let pools = routing.get("search");

        assert_eq!(
            pools
                .iter()
                .map(|pool| pool.id.as_str())
                .collect::<Vec<_>>(),
            vec!["primary", "backup"]
        );
    }

    // Red-test: scan provider configs on disk and verify VR/hubpipeline code
    // contains no hardcoded provider IDs. Providers evolve — only config should
    // drive provider identification.
    #[test]
    fn no_provider_ids_are_hardcoded_in_virtual_router_or_hub_pipeline_code() {
        let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE"));
        let Ok(home) = home else {
            eprintln!("WARN: HOME not set, skipping red-test");
            return;
        };
        let provider_dir = std::path::Path::new(&home).join(".rcc").join("provider");
        if !provider_dir.exists() {
            eprintln!("WARN: ~/.rcc/provider not found, skipping red-test");
            return;
        };
        let Ok(entries) = std::fs::read_dir(&provider_dir) else {
            return;
        };
        let mut provider_ids: Vec<String> = Vec::new();
        for entry in entries {
            let Ok(entry) = entry else { continue };
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                if let Some(name) = entry.file_name().to_str() {
                    provider_ids.push(name.to_string());
                }
            }
        }
        if provider_ids.is_empty() {
            return;
        }

        // Source directories to check (relative to this file's location)
        let crate_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let vr_root = crate_root.join("virtual_router_engine");
        let hub_root = crate_root.join("hub_pipeline_blocks");

        let mut checked_dirs: Vec<std::path::PathBuf> = Vec::new();
        if vr_root.exists() {
            checked_dirs.push(vr_root);
        }
        if hub_root.exists() {
            checked_dirs.push(hub_root);
        }

        // Collect all .rs files (excluding test modules and test files,
        // and provider_bootstrap which is config normalization, not VR runtime)
        let mut rs_files: Vec<std::path::PathBuf> = Vec::new();
        for dir in &checked_dirs {
            collect_rs_files(dir, &mut rs_files);
        }
        rs_files.retain(|f| {
            !f.file_stem()
                .and_then(|s| s.to_str())
                .map(|s| s == "provider_bootstrap")
                .unwrap_or(false)
        });

        // Suspicious patterns: provider_id used as a hardcoded string in a
        // comparison context.
        let mut violations: Vec<String> = Vec::new();
        for file in &rs_files {
            let content = std::fs::read_to_string(file).unwrap_or_default();
            for pid in &provider_ids {
                let pid_lower = pid.to_lowercase();
                // Pattern: == "provider_id" or == 'provider_id'
                for pattern in &[
                    format!("== \"{pid_lower}\""),
                    format!("== '{pid_lower}'"),
                    format!("== \"{pid}\""),
                    format!("== '{pid}'"),
                ] {
                    if content.contains(pattern.as_str()) {
                        violations.push(format!(
                            "{}: found `{}`",
                            file.strip_prefix(&crate_root).unwrap_or(file).display(),
                            pattern
                        ));
                    }
                }
            }
        }

        if !violations.is_empty() {
            panic!(
                "Provider IDs hardcoded in VR/hubpipeline code (only config should drive):\n{}",
                violations.join("\n")
            );
        }
    }

    fn collect_rs_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    collect_rs_files(&path, out);
                } else if path.extension().map(|e| e == "rs").unwrap_or(false) {
                    out.push(path);
                }
            }
        }
    }
}

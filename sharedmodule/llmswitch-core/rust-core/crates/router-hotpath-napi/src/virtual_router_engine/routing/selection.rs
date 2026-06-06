use super::super::instructions::{InstructionTarget, RoutingInstructionState};
use super::super::provider_registry::{derive_model_id, ProviderRegistry};
use super::key_utils::{extract_key_alias, extract_key_index, extract_provider_id};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum InstructionTargetMatchMode {
    Exact,
    Filter,
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedInstructionTarget {
    pub mode: InstructionTargetMatchMode,
    pub keys: Vec<String>,
}

pub(crate) fn filter_candidates_by_state(
    candidates: &[String],
    state: &RoutingInstructionState,
    registry: &ProviderRegistry,
) -> Vec<String> {
    let mut output = Vec::new();
    for key in candidates {
        let provider_id = extract_provider_id(key);
        if let Some(provider_id) = provider_id {
            if !state.allowed_providers.is_empty()
                && !state.allowed_providers.contains(&provider_id)
            {
                continue;
            }
            if state.disabled_providers.contains(&provider_id) {
                continue;
            }
            if let Some(disabled_keys) = state.disabled_keys.get(&provider_id) {
                let alias = extract_key_alias(key);
                let index = extract_key_index(key);
                if let Some(alias) = alias {
                    if disabled_keys.contains(&alias) {
                        continue;
                    }
                }
                if let Some(index) = index {
                    if disabled_keys.contains(&index.to_string()) {
                        continue;
                    }
                }
            }
            if let Some(disabled_models) = state.disabled_models.get(&provider_id) {
                if let Some(model_id) = registry.get(key).and_then(|p| p.model_id.clone()) {
                    if disabled_models.contains(&model_id) {
                        continue;
                    }
                }
            }
        }
        output.push(key.clone());
    }
    output
}

pub(crate) fn resolve_instruction_target(
    target: &InstructionTarget,
    registry: &ProviderRegistry,
) -> Option<ResolvedInstructionTarget> {
    let provider = target.provider.clone()?;
    let provider_keys = registry.list_provider_keys(&provider);
    if provider_keys.is_empty() {
        return None;
    }

    let alias = target
        .key_alias
        .as_deref()
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    let alias_explicit = !alias.is_empty() && target.path_length == Some(3);

    if alias_explicit {
        let prefix = format!("{}.{}.", provider, alias);
        let alias_keys: Vec<String> = provider_keys
            .iter()
            .filter(|key| key.starts_with(&prefix))
            .cloned()
            .collect();
        if !alias_keys.is_empty() {
            if let Some(model) = target.model.clone() {
                let matching: Vec<String> = alias_keys
                    .iter()
                    .filter(|key| {
                        registry
                            .get(key)
                            .and_then(|profile| profile.model_id.clone())
                            .as_deref()
                            == Some(model.as_str())
                    })
                    .cloned()
                    .collect();
                if !matching.is_empty() {
                    return Some(ResolvedInstructionTarget {
                        mode: if matching.len() == 1 {
                            InstructionTargetMatchMode::Exact
                        } else {
                            InstructionTargetMatchMode::Filter
                        },
                        keys: matching,
                    });
                }
            }
            return Some(ResolvedInstructionTarget {
                mode: InstructionTargetMatchMode::Filter,
                keys: alias_keys,
            });
        }
    }

    if let Some(key_index) = target.key_index {
        if let Some(runtime_key) = registry.resolve_runtime_key_by_index(&provider, key_index) {
            return Some(ResolvedInstructionTarget {
                mode: InstructionTargetMatchMode::Exact,
                keys: vec![runtime_key],
            });
        }
    }

    if let Some(model) = target.model.clone() {
        let matching: Vec<String> = provider_keys
            .iter()
            .filter(|key| {
                registry
                    .get(key)
                    .and_then(|profile| profile.model_id.clone())
                    .as_deref()
                    == Some(model.as_str())
            })
            .cloned()
            .collect();
        if !matching.is_empty() {
            return Some(ResolvedInstructionTarget {
                mode: InstructionTargetMatchMode::Filter,
                keys: matching,
            });
        }
    }

    if !alias.is_empty() && !alias_explicit {
        let prefix = format!("{}.{}.", provider, alias);
        for key in &provider_keys {
            if key.starts_with(&prefix) {
                return Some(ResolvedInstructionTarget {
                    mode: InstructionTargetMatchMode::Exact,
                    keys: vec![key.clone()],
                });
            }
        }
    }

    Some(ResolvedInstructionTarget {
        mode: InstructionTargetMatchMode::Filter,
        keys: provider_keys,
    })
}

fn instruction_target_matches_provider_key(
    target: &InstructionTarget,
    provider_key: &str,
    registry: &ProviderRegistry,
) -> bool {
    let provider = match &target.provider {
        Some(value) => value,
        None => return false,
    };
    let provider_keys = registry.list_provider_keys(provider);
    if provider_keys.is_empty() {
        return false;
    }
    if let Some(key_alias) = &target.key_alias {
        let prefix = format!("{}.{}.", provider, key_alias);
        if let Some(model) = &target.model {
            for key in provider_keys {
                if key.starts_with(&prefix) {
                    if let Some(profile) = registry.get(&key) {
                        let candidate = profile
                            .model_id
                            .clone()
                            .unwrap_or_else(|| derive_model_id(&profile.provider_key));
                        if candidate == *model && key == provider_key {
                            return true;
                        }
                    }
                }
            }
            return false;
        }
        return provider_key.starts_with(&prefix);
    }
    if let Some(index) = target.key_index {
        if let Some(resolved) = registry.resolve_runtime_key_by_index(provider, index) {
            return resolved == provider_key;
        }
    }
    if let Some(model) = &target.model {
        if let Some(profile) = registry.get(provider_key) {
            let candidate = profile
                .model_id
                .clone()
                .unwrap_or_else(|| derive_model_id(&profile.provider_key));
            if candidate == *model && provider_key.starts_with(&format!("{}.", provider)) {
                return true;
            }
        }
    }
    provider_key.starts_with(&format!("{}.", provider))
}

pub(crate) fn resolve_instruction_process_mode_for_selection(
    provider_key: &str,
    routing_state: &RoutingInstructionState,
    registry: &ProviderRegistry,
) -> Option<String> {
    if let Some(target) = &routing_state.forced_target {
        let process_mode = target.process_mode.clone();
        if process_mode.is_some()
            && instruction_target_matches_provider_key(target, provider_key, registry)
        {
            return process_mode;
        }
    }
    if let Some(target) = &routing_state.prefer_target {
        let process_mode = target.process_mode.clone();
        if process_mode.is_some()
            && instruction_target_matches_provider_key(target, provider_key, registry)
        {
            return process_mode;
        }
    }
    None
}

// ==================== ProviderForwarder selection wrapper ====================
//
// §3.6 字面契约：forwarder 解析 100% 在 select 阶段完成。
// 实际 hook 在 `engine::selection::select_provider` 末尾；本函数暴露独立 API
// 供候选列表做 fwd.* → real provider_key 折叠。

use super::super::forwarder::{ForwarderRegistry, ERR_FORWARDER_NO_AVAILABLE_TARGET};
use super::super::load_balancer::RouteLoadBalancer;

/// 解析 candidate 列表中的 fwd.* 项为 real provider_key。
/// 返回 (real_candidates, errors)。errors 包含全 disabled 等错误。
pub(crate) fn select_with_forwarder_resolution(
    candidates: &[String],
    forwarder_registry: &mut ForwarderRegistry,
    load_balancer: &mut RouteLoadBalancer,
    availability_check: impl Fn(&str) -> bool,
    session_id: Option<&str>,
) -> (Vec<String>, Vec<String>) {
    let mut real = Vec::new();
    let mut errors = Vec::new();
    for candidate in candidates {
        if ForwarderRegistry::is_forwarder_id(candidate) {
            match forwarder_registry.select(
                candidate,
                load_balancer,
                &availability_check,
                session_id,
            ) {
                Ok(provider_key) => real.push(provider_key),
                Err(e) if e == ERR_FORWARDER_NO_AVAILABLE_TARGET => {
                    errors.push(format!("{}: {}", candidate, e));
                }
                Err(e) => errors.push(format!("{}: {}", candidate, e)),
            }
        } else {
            real.push(candidate.clone());
        }
    }
    (real, errors)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::{HashMap, HashSet};

    fn make_registry() -> ProviderRegistry {
        let mut registry = ProviderRegistry::default();
        let mut providers = serde_json::Map::new();
        providers.insert(
            "openai.key1.gpt-4o".to_string(),
            json!({
                "providerKey": "openai.key1.gpt-4o",
                "providerType": "openai",
                "modelId": "gpt-4o",
                "enabled": true
            }),
        );
        providers.insert(
            "openai.key2.gpt-4o".to_string(),
            json!({
                "providerKey": "openai.key2.gpt-4o",
                "providerType": "openai",
                "modelId": "gpt-4o",
                "enabled": true
            }),
        );
        providers.insert(
            "anthropic.key1.claude-sonnet".to_string(),
            json!({
                "providerKey": "anthropic.key1.claude-sonnet",
                "providerType": "anthropic",
                "modelId": "claude-sonnet",
                "enabled": true
            }),
        );
        registry.load(&providers);
        registry
    }

    #[test]
    fn filter_empty_state_passes_all() {
        let registry = make_registry();
        let candidates = vec![
            "openai.key1.gpt-4o".to_string(),
            "anthropic.key1.claude-sonnet".to_string(),
        ];
        let state = RoutingInstructionState::default();
        let result = filter_candidates_by_state(&candidates, &state, &registry);
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn filter_empty_candidates_returns_empty() {
        let registry = make_registry();
        let candidates: Vec<String> = vec![];
        let state = RoutingInstructionState::default();
        let result = filter_candidates_by_state(&candidates, &state, &registry);
        assert!(result.is_empty());
    }

    #[test]
    fn filter_allowed_providers_restricts() {
        let registry = make_registry();
        let candidates = vec![
            "openai.key1.gpt-4o".to_string(),
            "anthropic.key1.claude-sonnet".to_string(),
        ];
        let mut state = RoutingInstructionState::default();
        state.allowed_providers = vec!["openai".to_string()].into_iter().collect();
        let result = filter_candidates_by_state(&candidates, &state, &registry);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0], "openai.key1.gpt-4o");
    }

    #[test]
    fn filter_disabled_providers_removes() {
        let registry = make_registry();
        let candidates = vec![
            "openai.key1.gpt-4o".to_string(),
            "anthropic.key1.claude-sonnet".to_string(),
        ];
        let mut state = RoutingInstructionState::default();
        state.disabled_providers = vec!["openai".to_string()].into_iter().collect();
        let result = filter_candidates_by_state(&candidates, &state, &registry);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0], "anthropic.key1.claude-sonnet");
    }

    #[test]
    fn filter_disabled_keys_removes_specific_key() {
        let registry = make_registry();
        let candidates = vec![
            "openai.key1.gpt-4o".to_string(),
            "openai.key2.gpt-4o".to_string(),
        ];
        let mut state = RoutingInstructionState::default();
        let mut disabled_keys = HashMap::new();
        disabled_keys.insert(
            "openai".to_string(),
            vec!["key1".to_string()].into_iter().collect(),
        );
        state.disabled_keys = disabled_keys;
        let result = filter_candidates_by_state(&candidates, &state, &registry);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0], "openai.key2.gpt-4o");
    }

    #[test]
    fn filter_disabled_models_removes_by_model() {
        let registry = make_registry();
        let candidates = vec![
            "openai.key1.gpt-4o".to_string(),
            "anthropic.key1.claude-sonnet".to_string(),
        ];
        let mut state = RoutingInstructionState::default();
        let mut disabled_models = HashMap::new();
        disabled_models.insert(
            "openai".to_string(),
            vec!["gpt-4o".to_string()].into_iter().collect(),
        );
        state.disabled_models = disabled_models;
        let result = filter_candidates_by_state(&candidates, &state, &registry);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0], "anthropic.key1.claude-sonnet");
    }

    #[test]
    fn resolve_instruction_target_with_explicit_alias() {
        let registry = make_registry();
        let target = InstructionTarget {
            provider: Some("openai".to_string()),
            key_alias: Some("key1".to_string()),
            key_index: None,
            model: None,
            path_length: Some(3),
            process_mode: None,
        };
        let result = resolve_instruction_target(&target, &registry);
        assert!(result.is_some());
        let resolved = result.unwrap();
        assert!(resolved.keys.contains(&"openai.key1.gpt-4o".to_string()));
    }

    #[test]
    fn resolve_instruction_target_unknown_provider_returns_none() {
        let registry = make_registry();
        let target = InstructionTarget {
            provider: Some("nonexistent".to_string()),
            key_alias: None,
            key_index: None,
            model: None,
            path_length: None,
            process_mode: None,
        };
        let result = resolve_instruction_target(&target, &registry);
        assert!(result.is_none());
    }

    #[test]
    fn resolve_instruction_target_none_provider_returns_none() {
        let registry = make_registry();
        let target = InstructionTarget {
            provider: None,
            key_alias: None,
            key_index: None,
            model: None,
            path_length: None,
            process_mode: None,
        };
        let result = resolve_instruction_target(&target, &registry);
        assert!(result.is_none());
    }

    // ==================== select_with_forwarder_resolution tests ====================

    fn make_forwarder_providers() -> std::collections::HashSet<String> {
        let mut s = std::collections::HashSet::new();
        s.insert("real-a.key1".to_string());
        s.insert("real-b.key1".to_string());
        s
    }

    fn load_simple_forwarder(reg: &mut crate::virtual_router_engine::forwarder::ForwarderRegistry) {
        let mut fwd = serde_json::Map::new();
        fwd.insert(
            "fwd.openai.gpt-4o".to_string(),
            serde_json::json!({
                "forwarderId": "fwd.openai.gpt-4o",
                "protocol": "openai",
                "modelId": "gpt-4o",
                "resolutionMode": "model-first",
                "strategy": "round-robin",
                "targets": [
                    {"providerKey": "real-a.key1", "weight": null, "priority": null, "disabled": false},
                    {"providerKey": "real-b.key1", "weight": null, "priority": null, "disabled": false},
                ],
                "stickyKey": "none",
            }),
        );
        reg.load(&fwd, &make_forwarder_providers()).expect("load");
    }

    #[test]
    fn select_with_forwarder_resolution_expands_fwd_to_real() {
        use super::select_with_forwarder_resolution;
        use crate::virtual_router_engine::forwarder::ForwarderRegistry;
        use crate::virtual_router_engine::load_balancer::RouteLoadBalancer;

        let mut reg = ForwarderRegistry::new();
        load_simple_forwarder(&mut reg);
        let mut lb = RouteLoadBalancer::new(None);
        let candidates = vec!["fwd.openai.gpt-4o".to_string(), "real-a.key1".to_string()];
        let (real, errors) =
            select_with_forwarder_resolution(&candidates, &mut reg, &mut lb, |_| true, None);
        assert!(errors.is_empty());
        assert!(real[0].starts_with("real-"));
        assert_eq!(real[1], "real-a.key1");
    }

    #[test]
    fn select_with_forwarder_resolution_records_error_on_no_target() {
        use super::select_with_forwarder_resolution;
        use crate::virtual_router_engine::forwarder::ForwarderRegistry;
        use crate::virtual_router_engine::load_balancer::RouteLoadBalancer;

        let mut reg = ForwarderRegistry::new();
        let mut fwd = serde_json::Map::new();
        fwd.insert(
            "fwd.openai.gpt-4o".to_string(),
            serde_json::json!({
                "forwarderId": "fwd.openai.gpt-4o",
                "protocol": "openai",
                "modelId": "gpt-4o",
                "resolutionMode": "model-first",
                "strategy": "round-robin",
                "targets": [
                    {"providerKey": "real-a.key1", "weight": null, "priority": null, "disabled": true},
                    {"providerKey": "real-b.key1", "weight": null, "priority": null, "disabled": true},
                ],
                "stickyKey": "none",
            }),
        );
        reg.load(&fwd, &make_forwarder_providers()).expect("load");
        let mut lb = RouteLoadBalancer::new(None);
        let candidates = vec!["fwd.openai.gpt-4o".to_string()];
        let (real, errors) =
            select_with_forwarder_resolution(&candidates, &mut reg, &mut lb, |_| true, None);
        assert!(real.is_empty());
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("ERR_FORWARDER_NO_AVAILABLE_TARGET"));
    }
}

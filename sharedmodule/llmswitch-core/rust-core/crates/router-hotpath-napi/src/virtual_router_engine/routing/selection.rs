use super::super::instructions::{InstructionTarget, RoutingInstructionState};
use super::super::provider_registry::{derive_model_id, ProviderRegistry};

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
    let candidates = [
        routing_state.forced_target.as_ref(),
        routing_state.sticky_target.as_ref(),
        routing_state.prefer_target.as_ref(),
    ];
    for candidate in candidates {
        let target = match candidate {
            Some(t) => t,
            None => continue,
        };
        let process_mode = target.process_mode.clone();
        if process_mode.is_none() {
            continue;
        }
        if instruction_target_matches_provider_key(target, provider_key, registry) {
            return process_mode;
        }
    }
    None
}

fn extract_provider_id(provider_key: &str) -> Option<String> {
    let value = provider_key.trim();
    let first_dot = value.find('.')?;
    if first_dot == 0 {
        return None;
    }
    Some(value[..first_dot].to_string())
}

fn extract_key_alias(provider_key: &str) -> Option<String> {
    let value = provider_key.trim();
    let first_dot = value.find('.')?;
    let remainder = &value[first_dot + 1..];
    let second_dot = remainder.find('.')?;
    if second_dot == 0 {
        return None;
    }
    Some(remainder[..second_dot].to_string())
}

fn extract_key_index(provider_key: &str) -> Option<i64> {
    let alias = extract_key_alias(provider_key)?;
    alias.parse::<i64>().ok()
}

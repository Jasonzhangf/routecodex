use napi::Env;
use serde_json::{json, Value};
use std::collections::HashSet;

use super::selection::build_provider_not_available_error;
use super::types::SelectionResult;
use super::VirtualRouterEngineCore;
use crate::virtual_router_engine::classifier::ClassificationResult;
use crate::virtual_router_engine::error::format_virtual_router_error;
use crate::virtual_router_engine::features::build_routing_features;
use crate::virtual_router_engine::instructions::{
    apply_routing_instructions, build_metadata_instructions,
    clean_malformed_routing_instruction_markers, clean_routing_instruction_markers,
    ensure_stop_message_mode_max_repeats, has_client_inject_fields,
    has_routing_instruction_marker_in_messages,
    has_routing_instruction_marker_in_responses_context, parse_routing_instructions_from_request,
    pre_command_state_snapshot, stop_message_state_snapshot, strip_client_inject_fields,
    strip_stop_message_fields, RoutingInstruction, RoutingInstructionState,
};
use crate::virtual_router_engine::provider_registry::ProviderRegistry;
use crate::virtual_router_engine::routing::{
    extract_excluded_provider_keys, extract_key_alias, filter_candidates_by_state,
    is_server_tool_followup_request, parse_direct_provider_model,
    resolve_instruction_process_mode_for_selection, resolve_instruction_target,
    resolve_session_scope, resolve_sticky_key, resolve_stop_message_scope,
    should_fallback_direct_model_for_media,
};
use crate::virtual_router_engine::routing_state_store::{
    is_state_empty, load_routing_instruction_state, persist_routing_instruction_state,
};

fn normalize_instruction_target_against_registry(
    target: &crate::virtual_router_engine::instructions::InstructionTarget,
    registry: &ProviderRegistry,
) -> crate::virtual_router_engine::instructions::InstructionTarget {
    if target.key_alias.is_some() || target.key_index.is_some() {
        return target.clone();
    }
    let Some(provider) = target.provider.clone() else {
        return target.clone();
    };
    let Some(model) = target.model.clone() else {
        return target.clone();
    };
    if registry
        .resolve_runtime_key_by_model(&provider, &model)
        .is_some()
    {
        return target.clone();
    }
    for provider_key in registry.list_provider_keys(&provider) {
        let Some(alias) = extract_key_alias(&provider_key) else {
            continue;
        };
        let Some(profile) = registry.get(&provider_key) else {
            continue;
        };
        let Some(model_id) = profile.model_id.clone() else {
            continue;
        };
        let composite = format!("{}.{}", alias, model_id);
        if composite == model {
            let mut normalized = target.clone();
            normalized.key_alias = Some(alias);
            normalized.model = Some(model_id);
            normalized.path_length = Some(3);
            return normalized;
        }
    }
    target.clone()
}

fn normalize_parsed_instructions_against_registry(
    instructions: Vec<RoutingInstruction>,
    registry: &ProviderRegistry,
) -> Vec<RoutingInstruction> {
    instructions
        .into_iter()
        .map(|mut inst| {
            if let Some(target) = inst.target.as_ref() {
                inst.target = Some(normalize_instruction_target_against_registry(
                    target, registry,
                ));
            }
            inst
        })
        .collect()
}

fn resolve_route_hint(metadata: &Value) -> Option<String> {
    metadata
        .get("routeHint")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn summarize_marker_instructions(
    instructions: &[RoutingInstruction],
    marker_seen: bool,
) -> Option<String> {
    if !marker_seen {
        return None;
    }
    if instructions.is_empty() {
        return Some("marker:invalid-stripped".to_string());
    }
    let mut parts: Vec<String> = Vec::new();
    for inst in instructions {
        let label = match inst.kind.as_str() {
            "clear" => "clear",
            "force" => "force",
            "sticky" => "sticky",
            "prefer" => "prefer",
            "allow" => "allow",
            "disable" => "disable",
            "enable" => "enable",
            "stopMessageSet" => "stop-set",
            "stopMessageClear" => "stop-clear",
            "preCommandSet" => "precommand-set",
            "preCommandClear" => "precommand-clear",
            other => other,
        };
        let label = label.to_string();
        if !parts.contains(&label) {
            parts.push(label);
        }
    }
    Some(format!("marker:{}", parts.join(",")))
}

fn append_reasoning_tag(reasoning: &str, tag: Option<String>) -> String {
    let Some(tag) = tag.filter(|v| !v.trim().is_empty()) else {
        return reasoning.to_string();
    };
    if reasoning.trim().is_empty() {
        return tag;
    }
    if reasoning.split('|').any(|part| part.trim() == tag) {
        return reasoning.to_string();
    }
    format!("{}|{}", reasoning, tag)
}

fn has_only_routing_state_mutation_instructions(instructions: &[RoutingInstruction]) -> bool {
    !instructions.is_empty()
        && instructions
            .iter()
            .all(|inst| matches!(inst.kind.as_str(), "allow" | "disable" | "enable" | "clear"))
}

impl VirtualRouterEngineCore {
    fn should_reload_persisted_routing_state(
        existing: &RoutingInstructionState,
        loaded: &RoutingInstructionState,
        key: &str,
    ) -> bool {
        if is_state_empty(existing) {
            return true;
        }
        if !(key.starts_with("session:") || key.starts_with("conversation:")) {
            return false;
        }
        match (&existing.stopless_goal_state, &loaded.stopless_goal_state) {
            (None, Some(_)) => true,
            (Some(existing_goal), Some(loaded_goal)) => {
                loaded_goal.updated_at > existing_goal.updated_at
            }
            _ => false,
        }
    }

    fn should_auto_clear_prefer_target(
        &mut self,
        env: Env,
        state: &RoutingInstructionState,
    ) -> bool {
        let Some(target) = state.prefer_target.as_ref() else {
            return false;
        };
        let Some(resolved) = resolve_instruction_target(target, &self.provider_registry) else {
            return true;
        };
        let filtered = filter_candidates_by_state(&resolved.keys, state, &self.provider_registry);
        if filtered.is_empty() {
            return true;
        }
        filtered
            .iter()
            .all(|provider_key| !self.is_provider_available(env, provider_key))
    }

    fn load_routing_state_for_scope(&mut self, key: &str) -> RoutingInstructionState {
        if let Some(existing) = self.routing_instruction_state.get(key) {
            if key.starts_with("session:") || key.starts_with("conversation:") {
                if let Some(loaded) = load_routing_instruction_state(key) {
                    if Self::should_reload_persisted_routing_state(existing, &loaded, key) {
                        self.routing_instruction_state
                            .insert(key.to_string(), loaded.clone());
                        return loaded;
                    }
                }
            }
            if is_state_empty(existing) {
                if let Some(loaded) = load_routing_instruction_state(key) {
                    self.routing_instruction_state
                        .insert(key.to_string(), loaded.clone());
                    return loaded;
                }
            }
            return existing.clone();
        }
        if let Some(loaded) = load_routing_instruction_state(key) {
            self.routing_instruction_state
                .insert(key.to_string(), loaded.clone());
            return loaded;
        }
        RoutingInstructionState::default()
    }

    pub(crate) fn route(
        &mut self,
        env: Env,
        request: &Value,
        metadata: &Value,
    ) -> Result<Value, String> {
        // Keep health selection state scoped to the current runtime override context
        // (sessionDir/rccUserDir). This prevents cross-port/session pollution.
        self.refresh_provider_health_from_store();
        let mut request_working = request.clone();
        clean_malformed_routing_instruction_markers(&mut request_working);
        let sticky_key = resolve_sticky_key(metadata);
        let session_scope = resolve_session_scope(metadata);
        let stop_message_scope = resolve_stop_message_scope(metadata);
        let routing_state_key = session_scope.clone().unwrap_or_else(|| sticky_key.clone());
        let base_state = self.load_routing_state_for_scope(&routing_state_key);
        let mut persisted_routing_state = strip_stop_message_fields(&base_state);
        let mut selection_routing_state = strip_stop_message_fields(&base_state);
        let metadata_instructions = build_metadata_instructions(metadata);
        if !metadata_instructions.is_empty() {
            apply_routing_instructions(&metadata_instructions, &mut selection_routing_state)?;
        }
        if metadata
            .get("disableStickyRoutes")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            selection_routing_state.forced_target = None;
            selection_routing_state.sticky_target = None;
            selection_routing_state.prefer_target = None;
        }

        let mut parsed_instructions = normalize_parsed_instructions_against_registry(
            parse_routing_instructions_from_request(&request_working)?,
            &self.provider_registry,
        );
        if crate::virtual_router_engine::routing::is_server_tool_followup_request(metadata)
            && !parsed_instructions.is_empty()
        {
            parsed_instructions = parsed_instructions
                .into_iter()
                .filter(|inst| {
                    !matches!(
                        inst.kind.as_str(),
                        "stopMessageSet"
                            | "stopMessageMode"
                            | "stopMessageClear"
                            | "preCommandSet"
                            | "preCommandClear"
                    )
                })
                .collect();
        }
        if stop_message_scope.is_none() && !parsed_instructions.is_empty() {
            parsed_instructions = parsed_instructions
                .into_iter()
                .filter(|inst| {
                    !matches!(
                        inst.kind.as_str(),
                        "stopMessageSet"
                            | "stopMessageMode"
                            | "stopMessageClear"
                            | "preCommandSet"
                            | "preCommandClear"
                    )
                })
                .collect();
        }

        let messages_has_marker = request_working
            .get("messages")
            .and_then(|v| v.as_array())
            .map(|messages| has_routing_instruction_marker_in_messages(messages))
            .unwrap_or(false);
        let responses_context = request_working
            .get("semantics")
            .and_then(|v| v.get("responses"))
            .and_then(|v| v.get("context"));
        let responses_has_marker =
            has_routing_instruction_marker_in_responses_context(responses_context);
        let marker_seen = messages_has_marker || responses_has_marker;
        let marker_reason = summarize_marker_instructions(&parsed_instructions, marker_seen);
        if marker_seen {
            clean_routing_instruction_markers(&mut request_working);
        }

        let features = build_routing_features(&request_working, metadata);

        let mut core_instructions = Vec::new();
        let mut stop_instructions = Vec::new();
        for inst in parsed_instructions.into_iter() {
            if inst.kind == "clear" {
                core_instructions.push(inst.clone());
                stop_instructions.push(inst);
                continue;
            }
            if matches!(
                inst.kind.as_str(),
                "stopMessageSet"
                    | "stopMessageMode"
                    | "stopMessageClear"
                    | "preCommandSet"
                    | "preCommandClear"
            ) {
                stop_instructions.push(inst);
            } else {
                core_instructions.push(inst);
            }
        }
        let routing_instruction_mutation_only =
            has_only_routing_state_mutation_instructions(&core_instructions)
                && features.user_text_sample.trim().is_empty();
        let mut metadata_for_selection = features.metadata.clone();
        if routing_instruction_mutation_only {
            if let Some(map) = metadata_for_selection.as_object_mut() {
                map.insert(
                    "routingInstructionMutationOnly".to_string(),
                    Value::Bool(true),
                );
            }
        }
        if !core_instructions.is_empty() {
            apply_routing_instructions(&core_instructions, &mut persisted_routing_state)?;
            apply_routing_instructions(&core_instructions, &mut selection_routing_state)?;
        }
        if self.should_auto_clear_prefer_target(env, &persisted_routing_state) {
            persisted_routing_state.prefer_target = None;
        }
        if self.should_auto_clear_prefer_target(env, &selection_routing_state) {
            selection_routing_state.prefer_target = None;
        }
        let persisted_state = if stop_message_scope.is_some() {
            strip_client_inject_fields(&persisted_routing_state)
        } else {
            persisted_routing_state.clone()
        };
        self.routing_instruction_state
            .insert(routing_state_key.clone(), persisted_state.clone());
        persist_routing_instruction_state(&routing_state_key, Some(&persisted_state));
        let routing_state_for_selection = if stop_message_scope.is_some() {
            strip_client_inject_fields(&selection_routing_state)
        } else {
            selection_routing_state
        };

        if let Some(scope) = stop_message_scope.as_ref() {
            if !stop_instructions.is_empty() {
                let session_state = self.load_routing_state_for_scope(scope);
                let mut next_state = session_state;
                apply_routing_instructions(&stop_instructions, &mut next_state)?;
                self.routing_instruction_state
                    .insert(scope.clone(), next_state);
                if let Some(state) = self.routing_instruction_state.get(scope) {
                    persist_routing_instruction_state(scope, Some(state));
                }
            }
        }

        let bound_alias_prefix: Option<String> = None;

        let direct_model =
            parse_direct_provider_model(request_working.get("model"), &self.provider_registry);
        let (classification, requested_route, selection) =
            if let Some((provider_id, model_id)) = direct_model {
                let has_model = self
                    .provider_registry
                    .list_provider_keys(&provider_id)
                    .iter()
                    .any(|key| {
                        self.provider_registry
                            .get(key)
                            .and_then(|profile| profile.model_id.clone())
                            .map(|candidate| candidate == model_id)
                            .unwrap_or(false)
                    });
                if !has_model {
                    return Err(format_virtual_router_error(
                        "CONFIG_ERROR",
                        format!("Unknown model {} for provider {}", model_id, provider_id),
                    ));
                }
                if !should_fallback_direct_model_for_media(
                    &provider_id,
                    &model_id,
                    &features,
                    &self.routing,
                    &self.provider_registry,
                ) {
                    let candidate_keys = self.provider_registry.list_provider_keys(&provider_id);
                    let mut eligible: Vec<String> = Vec::new();
                    for key in candidate_keys {
                        if let Some(profile) = self.provider_registry.get(&key) {
                            if profile.model_id.as_deref() == Some(&model_id) {
                                eligible.push(key);
                            }
                        }
                    }
                    eligible.sort();
                    let eligible = filter_candidates_by_state(
                        &eligible,
                        &routing_state_for_selection,
                        &self.provider_registry,
                    );
                    let cooldown_candidate_keys = eligible.clone();
                    let excluded_keys: HashSet<String> = extract_excluded_provider_keys(metadata)
                        .into_iter()
                        .collect();
                    let available: Vec<String> = self.apply_standard_filters(
                        env,
                        &eligible,
                        &routing_state_for_selection,
                        &excluded_keys,
                    );
                    if available.is_empty() {
                        return Err(build_provider_not_available_error(
                            self,
                            env,
                            &cooldown_candidate_keys,
                            format!(
                                "All providers unavailable for model {}.{}",
                                provider_id, model_id
                            ),
                        ));
                    }
                    let route_key = format!("direct:{}.{}", provider_id, model_id);
                    let direct_key = self
                        .load_balancer
                        .select(
                            &route_key,
                            &available,
                            Some(&sticky_key),
                            None,
                            |_| true,
                            Some("round-robin"),
                        )
                        .ok_or_else(|| {
                            format_virtual_router_error(
                                "PROVIDER_NOT_AVAILABLE",
                                format!(
                                    "All providers unavailable for model {}.{}",
                                    provider_id, model_id
                                ),
                            )
                        })?;
                    let classification = ClassificationResult {
                        route_name: "direct".to_string(),
                        confidence: 1.0,
                        reasoning: append_reasoning_tag(
                            &format!("direct_model:{}.{}", provider_id, model_id),
                            marker_reason.clone(),
                        ),
                        candidates: vec!["direct".to_string()],
                    };
                    let selection = SelectionResult::new(
                        direct_key.clone(),
                        "direct".to_string(),
                        vec![direct_key.clone()],
                        Some("direct".to_string()),
                    );
                    (classification, "direct".to_string(), selection)
                } else {
                    let mut classification = self.classifier.classify(&features);
                    if let Some(route_hint) = resolve_route_hint(metadata) {
                        if !self.routing.get(&route_hint).is_empty()
                            && !is_server_tool_followup_request(metadata)
                        {
                            classification.route_name = route_hint.clone();
                            classification.reasoning = append_reasoning_tag(
                                &classification.reasoning,
                                Some(format!("route_hint:{}", route_hint)),
                            );
                        }
                    }
                    classification.reasoning =
                        append_reasoning_tag(&classification.reasoning, marker_reason.clone());
                    let requested_route = classification.route_name.clone();
                    let selection = self.select_provider(
                        &requested_route,
                        &metadata_for_selection,
                        &classification,
                        &features,
                        &routing_state_for_selection,
                        bound_alias_prefix.as_deref(),
                        env,
                    )?;
                    (classification, requested_route, selection)
                }
            } else {
                let mut classification = self.classifier.classify(&features);
                if let Some(route_hint) = resolve_route_hint(metadata) {
                    if !self.routing.get(&route_hint).is_empty()
                        && !is_server_tool_followup_request(metadata)
                    {
                        classification.route_name = route_hint.clone();
                        classification.reasoning = append_reasoning_tag(
                            &classification.reasoning,
                            Some(format!("route_hint:{}", route_hint)),
                        );
                    }
                }
                classification.reasoning =
                    append_reasoning_tag(&classification.reasoning, marker_reason.clone());
                let requested_route = classification.route_name.clone();
                let selection = self.select_provider(
                    &requested_route,
                    &metadata_for_selection,
                    &classification,
                    &features,
                    &routing_state_for_selection,
                    bound_alias_prefix.as_deref(),
                    env,
                )?;
                (classification, requested_route, selection)
            };

        let target = self
            .provider_registry
            .build_target(&selection.provider_key)
            .ok_or("failed to build target")?;
        let mut target_obj = target;
        if let Value::Object(ref mut map) = target_obj {
            if let Some(route_params) = selection.route_params.clone() {
                map.insert("routeParams".to_string(), Value::Object(route_params));
            }
            if self.web_search_force {
                map.insert("forceWebSearch".to_string(), Value::Bool(true));
            }
            if let Some(mode) = resolve_instruction_process_mode_for_selection(
                &selection.provider_key,
                &routing_state_for_selection,
                &self.provider_registry,
            ) {
                map.insert("processMode".to_string(), Value::String(mode));
            }
        }
        let did_fallback = selection.route_used != requested_route;
        let decision = json!({
            "routeName": selection.route_used,
            "providerKey": selection.provider_key,
            "pool": selection.pool,
            "poolId": selection.pool_id,
            "confidence": classification.confidence,
            "reasoning": classification.reasoning,
            "fallback": did_fallback
        });
        let diagnostics = json!({
            "routeName": selection.route_used,
            "providerKey": selection.provider_key,
            "pool": selection.pool,
            "poolId": selection.pool_id,
            "reasoning": classification.reasoning,
            "fallback": did_fallback,
            "confidence": classification.confidence,
            "unavailableRoutePools": selection.unavailable_providers
        });
        Ok(json!({
            "target": target_obj,
            "decision": decision,
            "diagnostics": diagnostics
        }))
    }

    pub(crate) fn get_stop_message_state(&mut self, metadata: &Value) -> Option<Value> {
        let scope = match resolve_stop_message_scope(metadata) {
            Some(scope) => scope,
            None => {
                if let Some(session_scope) = resolve_session_scope(metadata) {
                    let state = self.load_routing_state_for_scope(&session_scope);
                    if has_client_inject_fields(&state) {
                        let cleared = strip_client_inject_fields(&state);
                        self.routing_instruction_state
                            .insert(session_scope.clone(), cleared.clone());
                        persist_routing_instruction_state(&session_scope, Some(&cleared));
                    }
                }
                return None;
            }
        };
        let mut state = self.load_routing_state_for_scope(&scope);
        let before = state.stop_message_state.stop_message_max_repeats;
        ensure_stop_message_mode_max_repeats(&mut state.stop_message_state);
        if before != state.stop_message_state.stop_message_max_repeats {
            self.routing_instruction_state
                .insert(scope.clone(), state.clone());
            persist_routing_instruction_state(&scope, Some(&state));
        } else {
            self.routing_instruction_state
                .insert(scope.clone(), state.clone());
        }
        let snapshot = stop_message_state_snapshot(&state.stop_message_state)?;
        Some(snapshot)
    }

    pub(crate) fn get_pre_command_state(&mut self, metadata: &Value) -> Option<Value> {
        let scope = resolve_stop_message_scope(metadata)?;
        let state = self.load_routing_state_for_scope(&scope);
        pre_command_state_snapshot(&state.pre_command)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::virtual_router_engine::instructions::{InstructionTarget, RoutingInstructionState};
    use crate::virtual_router_engine::rcc_fence::StoplessGoalState;
    use crate::virtual_router_engine::routing_state_store::{
        persist_routing_instruction_state, with_session_dir_override,
    };
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn disable_sticky_routes_clears_forced_and_sticky_targets_for_selection() {
        let mut state = RoutingInstructionState::default();
        let target = InstructionTarget {
            provider: Some("deepseek-web".to_string()),
            key_alias: Some("3".to_string()),
            key_index: None,
            model: Some("deepseek-r1-search".to_string()),
            path_length: Some(3),
            process_mode: None,
        };
        state.forced_target = Some(target.clone());
        state.sticky_target = Some(target.clone());
        state.prefer_target = Some(target);

        let metadata = json!({ "disableStickyRoutes": true });
        if metadata
            .get("disableStickyRoutes")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            state.forced_target = None;
            state.sticky_target = None;
            state.prefer_target = None;
        }

        assert!(state.forced_target.is_none());
        assert!(state.sticky_target.is_none());
        assert!(state.prefer_target.is_none());
    }

    #[test]
    fn load_routing_state_for_scope_reloads_disk_when_session_cache_is_stale_empty() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_dir = std::env::temp_dir().join(format!("rcc-route-state-reload-{unique}"));
        fs::create_dir_all(&temp_dir).unwrap();

        with_session_dir_override(temp_dir.to_str(), || {
            let key = "session:goal-reload";
            let mut persisted = RoutingInstructionState::default();
            persisted.stopless_goal_state = Some(StoplessGoalState {
                status: "active".to_string(),
                objective: "reload goal from disk".to_string(),
                latest_note: Some("persisted after first turn".to_string()),
                completion_evidence: None,
                next_step: None,
                user_question: None,
                cannot_continue_reason: None,
                blocking_evidence: None,
                attempts_exhausted: None,
                error_class: None,
                completion_summary: None,
                ssot_assessment: None,
                consecutive_irrecoverable_errors: None,
                consecutive_validation_failures: Some(1),
                consecutive_no_progress: None,
                updated_at: 123,
                created_at: 123,
            });
            persist_routing_instruction_state(key, Some(&persisted));

            let mut engine = VirtualRouterEngineCore::new();
            engine
                .routing_instruction_state
                .insert(key.to_string(), RoutingInstructionState::default());

            let loaded = engine.load_routing_state_for_scope(key);
            let goal = loaded
                .stopless_goal_state
                .expect("goal should reload from disk");
            assert_eq!(goal.status, "active");
            assert_eq!(goal.objective, "reload goal from disk");
        });

        let _ = fs::remove_dir_all(PathBuf::from(temp_dir));
    }

    #[test]
    fn load_routing_state_for_scope_reloads_disk_when_session_cache_goal_state_is_stale() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let temp_dir = std::env::temp_dir().join(format!("rcc-route-goal-freshness-{unique}"));
        fs::create_dir_all(&temp_dir).unwrap();

        with_session_dir_override(temp_dir.to_str(), || {
            let key = "session:goal-freshness";
            let mut persisted = RoutingInstructionState::default();
            persisted.stopless_goal_state = Some(StoplessGoalState {
                status: "active".to_string(),
                objective: "reload richer goal state from disk".to_string(),
                latest_note: Some("persisted validation failure".to_string()),
                completion_evidence: None,
                next_step: None,
                user_question: None,
                cannot_continue_reason: None,
                blocking_evidence: None,
                attempts_exhausted: None,
                error_class: None,
                completion_summary: None,
                ssot_assessment: None,
                consecutive_irrecoverable_errors: None,
                consecutive_validation_failures: Some(1),
                consecutive_no_progress: None,
                updated_at: 200,
                created_at: 100,
            });
            persist_routing_instruction_state(key, Some(&persisted));

            let mut cached = RoutingInstructionState::default();
            cached.stopless_goal_state = Some(StoplessGoalState {
                status: "active".to_string(),
                objective: "reload richer goal state from disk".to_string(),
                latest_note: Some("stale cache".to_string()),
                completion_evidence: None,
                next_step: None,
                user_question: None,
                cannot_continue_reason: None,
                blocking_evidence: None,
                attempts_exhausted: None,
                error_class: None,
                completion_summary: None,
                ssot_assessment: None,
                consecutive_irrecoverable_errors: None,
                consecutive_validation_failures: None,
                consecutive_no_progress: None,
                updated_at: 100,
                created_at: 100,
            });

            let mut engine = VirtualRouterEngineCore::new();
            engine
                .routing_instruction_state
                .insert(key.to_string(), cached);

            let loaded = engine.load_routing_state_for_scope(key);
            let goal = loaded
                .stopless_goal_state
                .expect("goal should reload from disk");
            assert_eq!(goal.updated_at, 200);
            assert_eq!(goal.consecutive_validation_failures, Some(1));
        });

        let _ = fs::remove_dir_all(PathBuf::from(temp_dir));
    }
}

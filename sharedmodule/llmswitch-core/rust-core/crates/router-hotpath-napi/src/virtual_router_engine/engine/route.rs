use napi::Env;
use serde_json::{json, Value};

use super::types::{PendingAliasBinding, SelectionResult};
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
    alias_prefix_from_alias_key, build_antigravity_alias_key, extract_excluded_provider_keys,
    filter_candidates_by_state, parse_direct_provider_model,
    resolve_instruction_process_mode_for_selection, resolve_session_scope, resolve_sticky_key,
    resolve_stop_message_scope, should_avoid_antigravity_after_repeated_error,
    should_bind_antigravity_session, should_fallback_direct_model_for_media,
};
use crate::virtual_router_engine::routing_state_store::{
    load_routing_instruction_state, persist_routing_instruction_state,
};

fn extract_key_alias_from_provider_key(provider_key: &str) -> Option<String> {
    let trimmed = provider_key.trim();
    let first_dot = trimmed.find('.')?;
    let remainder = &trimmed[first_dot + 1..];
    let second_dot = remainder.find('.')?;
    if second_dot == 0 {
        return None;
    }
    Some(remainder[..second_dot].to_string())
}

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
        let Some(alias) = extract_key_alias_from_provider_key(&provider_key) else {
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

impl VirtualRouterEngineCore {
    fn load_routing_state_for_scope(&mut self, key: &str) -> RoutingInstructionState {
        if let Some(existing) = self.routing_instruction_state.get(key) {
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
        let mut request_working = request.clone();
        clean_malformed_routing_instruction_markers(&mut request_working);
        let sticky_key = resolve_sticky_key(metadata);
        let session_scope = resolve_session_scope(metadata);
        let stop_message_scope = resolve_stop_message_scope(metadata);
        let routing_state_key = session_scope.clone().unwrap_or_else(|| sticky_key.clone());
        let base_state =
            if let Some(existing) = self.routing_instruction_state.get(&routing_state_key) {
                existing.clone()
            } else if let Some(loaded) = load_routing_instruction_state(&routing_state_key) {
                self.routing_instruction_state
                    .insert(routing_state_key.clone(), loaded.clone());
                loaded
            } else {
                RoutingInstructionState::default()
            };
        let mut routing_state = strip_stop_message_fields(&base_state);

        let metadata_instructions = build_metadata_instructions(metadata);
        if !metadata_instructions.is_empty() {
            apply_routing_instructions(&metadata_instructions, &mut routing_state)?;
        }
        if metadata
            .get("disableStickyRoutes")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            routing_state.sticky_target = None;
            routing_state.prefer_target = None;
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
        if !core_instructions.is_empty() {
            apply_routing_instructions(&core_instructions, &mut routing_state)?;
        }
        let persisted_state = if stop_message_scope.is_some() {
            strip_client_inject_fields(&routing_state)
        } else {
            routing_state.clone()
        };
        self.routing_instruction_state
            .insert(routing_state_key.clone(), persisted_state.clone());
        persist_routing_instruction_state(&routing_state_key, Some(&persisted_state));
        let routing_state_for_selection = persisted_state;

        if let Some(scope) = stop_message_scope.as_ref() {
            if !stop_instructions.is_empty() {
                let session_state =
                    if let Some(existing) = self.routing_instruction_state.get(scope) {
                        existing.clone()
                    } else if let Some(loaded) = load_routing_instruction_state(scope) {
                        self.routing_instruction_state
                            .insert(scope.clone(), loaded.clone());
                        loaded
                    } else {
                        RoutingInstructionState::default()
                    };
                let mut next_state = session_state;
                apply_routing_instructions(&stop_instructions, &mut next_state)?;
                self.routing_instruction_state
                    .insert(scope.clone(), next_state);
                if let Some(state) = self.routing_instruction_state.get(scope) {
                    persist_routing_instruction_state(scope, Some(state));
                }
            }
        }

        let mut bound_alias_prefix: Option<String> = None;
        if let Some(scope) = session_scope.as_ref() {
            let scoped_key = crate::virtual_router_engine::routing::build_scoped_session_key(scope);
            if let Some(alias_key) = self
                .antigravity_session_alias_store
                .get(&scoped_key)
                .cloned()
            {
                if self.alias_blocked_by_quota(env, &alias_key) {
                    self.antigravity_session_alias_store.remove(&scoped_key);
                } else {
                    bound_alias_prefix = alias_prefix_from_alias_key(&alias_key);
                }
            }
        }

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
                    let excluded_keys = extract_excluded_provider_keys(metadata);
                    let mut available: Vec<String> = eligible
                        .into_iter()
                        .filter(|key| self.is_provider_available(env, key))
                        .collect();
                    if !excluded_keys.is_empty() {
                        available.retain(|key| !excluded_keys.contains(key));
                    }
                    if !excluded_keys.is_empty()
                        && should_avoid_antigravity_after_repeated_error(metadata)
                    {
                        let non_antigravity: Vec<String> = available
                            .iter()
                            .filter(|key| !key.starts_with("antigravity."))
                            .cloned()
                            .collect();
                        if !non_antigravity.is_empty() {
                            available = non_antigravity;
                        }
                    }
                    if available.is_empty() {
                        return Err(format_virtual_router_error(
                            "PROVIDER_NOT_AVAILABLE",
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
                        fallback: false,
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
                        if !self.routing.get(&route_hint).is_empty() {
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
                        &features.metadata,
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
                    if !self.routing.get(&route_hint).is_empty() {
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
                    &features.metadata,
                    &classification,
                    &features,
                    &routing_state_for_selection,
                    bound_alias_prefix.as_deref(),
                    env,
                )?;
                (classification, requested_route, selection)
            };

        self.pending_alias = None;
        if should_bind_antigravity_session(metadata) {
            if let Some(scope) = session_scope.as_ref() {
                if let Some(alias_key) =
                    build_antigravity_alias_key(&selection.provider_key, &self.provider_registry)
                {
                    let request_id = metadata
                        .get("requestId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let session_key =
                        crate::virtual_router_engine::routing::build_scoped_session_key(scope);
                    self.pending_alias = Some(PendingAliasBinding {
                        request_id,
                        provider_key: selection.provider_key.clone(),
                        session_scope: session_key,
                        alias_key,
                    });
                }
            }
        }

        let target = self
            .provider_registry
            .build_target(&selection.provider_key)
            .ok_or("failed to build target")?;
        let mut target_obj = target;
        if let Value::Object(ref mut map) = target_obj {
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
            "confidence": classification.confidence
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

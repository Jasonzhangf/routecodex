use napi::Env;
use serde_json::{json, Value};
use std::collections::HashSet;

// feature_id: vr.route_retry_pin_surface
use super::selection::build_provider_not_available_error;
use super::types::SelectionResult;
use super::VirtualRouterEngineCore;
use crate::hub_pipeline_types::{build_meta_route_03_from_metadata, MetaRoute03RouteCarrier};
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
    strip_stop_message_fields, InstructionTarget, RoutingInstruction, RoutingInstructionState,
};
use crate::virtual_router_engine::provider_registry::ProviderRegistry;
use crate::virtual_router_engine::routing::{
    direct_model_media_requirement_error, extract_excluded_provider_keys, extract_key_alias,
    filter_candidates_by_state, is_continuation_request, is_server_tool_followup_request,
    parse_direct_provider_model, resolve_instruction_process_mode_for_selection,
    resolve_instruction_target, resolve_routing_state_key, resolve_session_scope,
    resolve_stop_message_scope,
};
use crate::virtual_router_engine::routing_state_store::{
    is_state_empty, load_routing_instruction_state, persist_routing_instruction_state,
};
use crate::virtual_router_engine::time_utils::now_ms;

fn read_router_direct_inbound_protocol(metadata: &Value) -> Option<String> {
    metadata
        .get("routerDirectInboundProtocol")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn parse_retry_provider_key_target(raw: &str) -> Option<InstructionTarget> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parts: Vec<&str> = trimmed.split('.').collect();
    if parts.len() < 3 {
        return None;
    }
    let provider = parts[0].trim();
    let alias = parts[1].trim();
    let model = parts[2..].join(".");
    if provider.is_empty() || alias.is_empty() || model.trim().is_empty() {
        return None;
    }
    Some(InstructionTarget {
        provider: Some(provider.to_string()),
        key_alias: Some(alias.to_string()),
        key_index: None,
        model: Some(model.trim().to_string()),
        path_length: Some(3),
        process_mode: None,
    })
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
    let Some(canonical_model) = registry.resolve_canonical_model_id(&provider, &model) else {
        return target.clone();
    };
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
        let canonical_composite = format!("{}.{}", alias, model_id);
        if canonical_composite == model || model_id == canonical_model {
            let mut normalized = target.clone();
            normalized.key_alias = Some(alias);
            normalized.model = Some(canonical_model);
            normalized.path_length = Some(3);
            return normalized;
        }
    }
    let mut normalized = target.clone();
    normalized.model = Some(canonical_model);
    normalized
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

fn resolve_route_hint(meta_route_03: &MetaRoute03RouteCarrier) -> Option<String> {
    let hint = meta_route_03.get_string("routeHint")?;
    let hint_trim = hint.trim();
    let stopless_followup = meta_route_03.get_bool("serverToolFollowup")
        && meta_route_03
            .get_string("serverToolFollowupSource")
            .as_deref()
            == Some("servertool.stop_message");
    if stopless_followup || (hint_trim == "tools" && meta_route_03.get_bool("serverToolFollowup")) {
        // Stopless followup must not inherit historical route hints:
        // the classification should fall back to thinking / default instead.
        return None;
    }
    Some(hint)
}

fn route_has_any_pool(
    routing: &crate::virtual_router_engine::routing::RoutingPools,
    route_name: &str,
) -> bool {
    if !routing.get(route_name).is_empty() {
        return true;
    }
    let suffix = format!(":{}", route_name);
    routing.keys().any(|key| key.ends_with(&suffix))
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

fn stop_message_event_ts(state: &RoutingInstructionState) -> Option<i64> {
    let stop = &state.stop_message_state;
    match (stop.stop_message_updated_at, stop.stop_message_last_used_at) {
        (Some(updated), Some(last_used)) => Some(updated.max(last_used)),
        (Some(updated), None) => Some(updated),
        (None, Some(last_used)) => Some(last_used),
        (None, None) => None,
    }
}

fn has_stop_message_text(state: &RoutingInstructionState) -> bool {
    state
        .stop_message_state
        .stop_message_text
        .as_deref()
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

fn is_cleared_stop_message_tombstone(state: &RoutingInstructionState) -> bool {
    let stop = &state.stop_message_state;
    stop.stop_message_updated_at.is_some()
        && stop.stop_message_text.is_none()
        && stop.stop_message_max_repeats.is_none()
        && stop.stop_message_used.is_none()
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
        if !(key.starts_with("session:")
            || key.starts_with("conversation:")
            || key.starts_with("tmux:"))
        {
            return false;
        }
        let stop_message_state_is_newer = {
            let existing_ts = stop_message_event_ts(existing);
            let loaded_ts = stop_message_event_ts(loaded);
            match (existing_ts, loaded_ts) {
                (_, Some(loaded_at)) if existing_ts.map(|v| loaded_at > v).unwrap_or(true) => true,
                (Some(existing_at), Some(loaded_at))
                    if loaded_at == existing_at
                        && is_cleared_stop_message_tombstone(loaded)
                        && has_stop_message_text(existing) =>
                {
                    true
                }
                _ => false,
            }
        };
        stop_message_state_is_newer
    }

    fn load_routing_state_for_scope(&mut self, key: &str) -> RoutingInstructionState {
        if let Some(existing) = self.routing_instruction_state.get(key) {
            if key.starts_with("session:")
                || key.starts_with("conversation:")
                || key.starts_with("tmux:")
            {
                match load_routing_instruction_state(key) {
                    Some(loaded) => {
                        if Self::should_reload_persisted_routing_state(existing, &loaded, key) {
                            self.routing_instruction_state
                                .insert(key.to_string(), loaded.clone());
                            return loaded;
                        }
                    }
                    None => {}
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
        let metadata_center_snapshot = metadata
            .get("metadataCenterSnapshot")
            .and_then(|value| value.as_object())
            .ok_or_else(|| {
                "metadataCenterSnapshot is required for virtual router metadata reads".to_string()
            })?;
        let metadata_center_snapshot_value = Value::Object(metadata_center_snapshot.clone());
        let mut request_working = request.clone();
        clean_malformed_routing_instruction_markers(&mut request_working);
        let is_continuation = is_continuation_request(&metadata_center_snapshot_value);
        let request_routing_state_key = resolve_routing_state_key(&metadata_center_snapshot_value);
        let session_scope = resolve_session_scope(&metadata_center_snapshot_value);
        let stop_message_scope = resolve_stop_message_scope(&metadata_center_snapshot_value);
        let meta_route_03 = build_meta_route_03_from_metadata(&metadata_center_snapshot_value);
        let routing_state_key = session_scope.clone().unwrap_or_else(|| {
            if is_continuation {
                request_routing_state_key.clone()
            } else {
                request_routing_state_key.clone()
            }
        });
        let base_state = self.load_routing_state_for_scope(&routing_state_key);
        let mut persisted_routing_state = strip_stop_message_fields(&base_state);
        let mut selection_routing_state = strip_stop_message_fields(&base_state);
        let metadata_instructions = build_metadata_instructions(&meta_route_03);
        if !metadata_instructions.is_empty() {
            apply_routing_instructions(&metadata_instructions, &mut selection_routing_state)?;
        }
        if !is_continuation {
            selection_routing_state.forced_target = None;
        }
        if let Some(target) = meta_route_03
            .get_string("retryProviderKey")
            .as_deref()
            .and_then(parse_retry_provider_key_target)
        {
            selection_routing_state.forced_target = Some(target);
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
        let mut metadata_for_selection = meta_route_03.to_metadata_value();
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
        let persisted_state = if stop_message_scope.is_some() {
            strip_client_inject_fields(&persisted_routing_state)
        } else {
            persisted_routing_state.clone()
        };
        if !core_instructions.is_empty() || !is_state_empty(&persisted_state) {
            self.routing_instruction_state
                .insert(routing_state_key.clone(), persisted_state.clone());
            persist_routing_instruction_state(&routing_state_key, Some(&persisted_state));
        }
        let routing_state_for_selection = if stop_message_scope.is_some() {
            strip_client_inject_fields(&selection_routing_state)
        } else {
            selection_routing_state
        };

        if let Some(scope) = stop_message_scope.as_ref() {
            if !stop_instructions.is_empty() {
                let session_state = self.load_routing_state_for_scope(scope);
                let mut next_state = session_state;
                let has_global_clear = stop_instructions.iter().any(|inst| inst.kind == "clear");
                apply_routing_instructions(&stop_instructions, &mut next_state)?;
                if has_global_clear {
                    let timestamp = now_ms();
                    next_state.stop_message_state.stop_message_updated_at = Some(timestamp);
                    next_state.stop_message_state.stop_message_last_used_at = Some(timestamp);
                }
                self.routing_instruction_state
                    .insert(scope.clone(), next_state.clone());
                if let Some(state) = self.routing_instruction_state.get(scope) {
                    persist_routing_instruction_state(scope, Some(state));
                }
            }
        }

        let bound_alias_prefix: Option<String> = None;
        let router_direct_inbound_protocol = read_router_direct_inbound_protocol(metadata);

        let direct_model =
            parse_direct_provider_model(request_working.get("model"), &self.provider_registry);
        if let Some((provider_id, model_id)) = direct_model {
            let Some(canonical_model_id) = self
                .provider_registry
                .resolve_canonical_model_id(&provider_id, &model_id)
            else {
                return Err(format_virtual_router_error(
                    "CONFIG_ERROR",
                    format!("Unknown model {} for provider {}", model_id, provider_id),
                ));
            };
            if self
                .provider_registry
                .resolve_runtime_key_by_model(&provider_id, &canonical_model_id)
                .is_none()
            {
                return Err(format_virtual_router_error(
                    "CONFIG_ERROR",
                    format!(
                        "Unknown model {} for provider {}",
                        canonical_model_id, provider_id
                    ),
                ));
            }
            if let Some(error_message) = direct_model_media_requirement_error(
                &provider_id,
                &canonical_model_id,
                &features,
                &self.provider_registry,
            ) {
                return Err(format_virtual_router_error("CONFIG_ERROR", error_message));
            }
            {
                let candidate_keys = self.provider_registry.list_provider_keys(&provider_id);
                let mut eligible: Vec<String> = Vec::new();
                for key in candidate_keys {
                    if let Some(profile) = self.provider_registry.get(&key) {
                        if profile.model_id.as_deref() == Some(&canonical_model_id)
                            && router_direct_inbound_protocol
                                .as_deref()
                                .map(|protocol| {
                                    self.provider_registry
                                        .provider_protocol_matches(&key, protocol)
                                })
                                .unwrap_or(true)
                        {
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
                    false,
                );
                if available.is_empty() {
                    return Err(build_provider_not_available_error(
                        self,
                        env,
                        &cooldown_candidate_keys,
                        format!(
                            "All providers unavailable for model {}.{}",
                            provider_id, canonical_model_id
                        ),
                        None,
                    ));
                }
                let route_key = format!("direct:{}.{}", provider_id, canonical_model_id);
                let direct_key = self
                    .load_balancer
                    .select(&route_key, &available, None, |_| true, Some("round-robin"))
                    .ok_or_else(|| {
                        format_virtual_router_error(
                            "PROVIDER_NOT_AVAILABLE",
                            format!(
                                "All providers unavailable for model {}.{}",
                                provider_id, canonical_model_id
                            ),
                        )
                    })?;
                let reasoning = append_reasoning_tag(
                    &format!("direct_model:{}.{}", provider_id, canonical_model_id),
                    marker_reason.clone(),
                );
                let selection = SelectionResult::new(
                    direct_key.clone(),
                    "direct".to_string(),
                    vec![direct_key.clone()],
                    vec![direct_key.clone()],
                    Some("direct".to_string()),
                );
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
                return Ok(json!({
                    "target": target_obj,
                    "decision": {
                        "routeName": "direct",
                        "providerKey": selection.provider_key,
                        "pool": selection.pool,
                        "routePool": selection.route_pool,
                        "poolId": selection.pool_id,
                        "confidence": 1.0,
                        "reasoning": reasoning,
                        "routeChanged": false
                    },
                    "diagnostics": {
                        "routeName": "direct",
                        "providerKey": selection.provider_key,
                        "pool": selection.pool,
                        "routePool": selection.route_pool,
                        "poolId": selection.pool_id,
                        "reasoning": reasoning,
                        "routeChanged": false,
                        "confidence": 1.0
                    }
                }));
            }
        }

        // RELAY: single shared path
        let mut classification = self.classifier.classify(&features);
        if let Some(route_hint) = resolve_route_hint(&meta_route_03) {
            if route_has_any_pool(&self.routing, &route_hint) {
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
        let route_changed = selection.route_used != requested_route;
        let decision = json!({
            "routeName": selection.route_used,
            "providerKey": selection.provider_key,
            "pool": selection.pool,
            "routePool": selection.route_pool,
            "poolId": selection.pool_id,
            "confidence": classification.confidence,
            "reasoning": classification.reasoning,
            "routeChanged": route_changed
        });
        let diagnostics = json!({
            "routeName": selection.route_used,
            "providerKey": selection.provider_key,
            "pool": selection.pool,
            "routePool": selection.route_pool,
            "poolId": selection.pool_id,
            "reasoning": classification.reasoning,
            "routeChanged": route_changed,
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

    fn build_route_test_core() -> VirtualRouterEngineCore {
        let mut core = VirtualRouterEngineCore::new();
        let config = json!({
            "routing": {
                "default": [{
                    "id": "default-pool",
                    "priority": 100,
                    "targets": ["openai.key1.gpt-4o"]
                }],
                "thinking": [{
                    "id": "thinking-pool",
                    "priority": 100,
                    "targets": ["anthropic.key1.claude-sonnet"]
                }],
                "search": [{
                    "id": "search-pool",
                    "priority": 100,
                    "targets": ["search.key1.model"]
                }]
            },
            "providers": {
                "openai.key1.gpt-4o": {
                    "providerKey": "openai.key1.gpt-4o",
                    "providerType": "openai",
                    "modelId": "gpt-4o",
                    "enabled": true
                },
                "anthropic.key1.claude-sonnet": {
                    "providerKey": "anthropic.key1.claude-sonnet",
                    "providerType": "anthropic",
                    "modelId": "claude-sonnet",
                    "enabled": true
                },
                "search.key1.model": {
                    "providerKey": "search.key1.model",
                    "providerType": "openai",
                    "modelId": "search-model",
                    "enabled": true
                }
            }
        });
        core.initialize(&config).expect("init should succeed");
        core
    }

    #[test]
    fn route_selects_provider_for_default_route() {
        let mut core = build_route_test_core();
        let request = json!({
            "messages": [
                { "role": "user", "content": "hello" }
            ]
        });
        let metadata = json!({
            "metadataCenterSnapshot": {
                "endpoint": "/v1/chat/completions",
                "requestId": "test-123"
            }
        });

        let result = core.route(
            unsafe { Env::from_raw(std::ptr::null_mut()) },
            &request,
            &metadata,
        );
        assert!(result.is_ok(), "route should succeed: {:?}", result.err());
        let output = result.unwrap();
        assert!(output.is_object(), "output should be an object");
        let decision = output.get("decision");
        assert!(decision.is_some(), "output should have decision");
        let provider_key = decision
            .unwrap()
            .get("providerKey")
            .and_then(|v| v.as_str());
        assert!(provider_key.is_some(), "decision should have providerKey");
        assert!(
            provider_key.unwrap() == "openai.key1.gpt-4o"
                || provider_key.unwrap() == "anthropic.key1.claude-sonnet",
            "providerKey should be a configured provider, got: {}",
            provider_key.unwrap()
        );
    }

    #[test]
    fn route_hint_applies_to_servertool_followup_requests() {
        let mut core = build_route_test_core();
        let request = json!({
            "messages": [
                { "role": "user", "content": "继续执行" }
            ]
        });
        let metadata = json!({
            "metadataCenterSnapshot": {
                "endpoint": "/v1/chat/completions",
                "requestId": "test-followup-route-hint:stop_followup",
                "routeHint": "search",
                "runtime_control": { "serverToolFollowup": true }
            }
        });

        let result = core
            .route(
                unsafe { Env::from_raw(std::ptr::null_mut()) },
                &request,
                &metadata,
            )
            .expect("route should succeed");
        let decision = result.get("decision").expect("should have decision");
        assert_eq!(decision["routeName"].as_str(), Some("search"));
        assert_eq!(decision["providerKey"].as_str(), Some("search.key1.model"));
        assert!(decision["reasoning"]
            .as_str()
            .unwrap_or_default()
            .contains("route_hint:search"));
    }

    #[test]
    fn stopless_followup_strips_tools_route_hint_and_falls_back_to_thinking() {
        let mut core = build_route_test_core();
        let request = json!({
            "messages": [
                { "role": "user", "content": "继续做下一步" }
            ]
        });
        let metadata = json!({
            "metadataCenterSnapshot": {
                "endpoint": "/v1/chat/completions",
                "requestId": "test-stopless-strip-tools-hint",
                "routeHint": "tools",
                "runtime_control": {
                    "serverToolFollowup": true,
                    "serverToolFollowupSource": "servertool.stop_message"
                }
            }
        });

        let result = core
            .route(
                unsafe { Env::from_raw(std::ptr::null_mut()) },
                &request,
                &metadata,
            )
            .expect("route should succeed");
        let decision = result.get("decision").expect("should have decision");
        let reasoning = decision["reasoning"].as_str().unwrap_or_default();
        assert!(
            !reasoning.contains("route_hint:tools"),
            "stopless followup must not carry route_hint:tools, got reasoning={reasoning}"
        );
        assert!(
            reasoning.contains("thinking:user-input"),
            "stopless followup fresh user turn should be classified as thinking, got reasoning={reasoning}"
        );
        let provider_key = decision["providerKey"].as_str().unwrap_or_default();
        assert_eq!(
            provider_key, "anthropic.key1.claude-sonnet",
            "stopless followup should land on thinking pool"
        );
    }

    #[test]
    fn stopless_followup_strips_search_route_hint_and_falls_back_to_thinking() {
        let mut core = build_route_test_core();
        let request = json!({
            "messages": [
                { "role": "user", "content": "继续做下一步" }
            ]
        });
        let metadata = json!({
            "metadataCenterSnapshot": {
                "endpoint": "/v1/chat/completions",
                "requestId": "test-stopless-strip-search-hint",
                "routeHint": "search",
                "runtime_control": {
                    "serverToolFollowup": true,
                    "serverToolFollowupSource": "servertool.stop_message"
                }
            }
        });

        let result = core
            .route(
                unsafe { Env::from_raw(std::ptr::null_mut()) },
                &request,
                &metadata,
            )
            .expect("route should succeed");
        let decision = result.get("decision").expect("should have decision");
        let reasoning = decision["reasoning"].as_str().unwrap_or_default();
        assert!(
            !reasoning.contains("route_hint:search"),
            "stopless followup must not carry route_hint:search, got reasoning={reasoning}"
        );
        assert!(
            reasoning.contains("thinking:user-input"),
            "stopless followup fresh user turn should be classified as thinking, got reasoning={reasoning}"
        );
        let provider_key = decision["providerKey"].as_str().unwrap_or_default();
        assert_eq!(
            provider_key, "anthropic.key1.claude-sonnet",
            "stopless followup should land on thinking pool"
        );
    }

    #[test]
    fn router_direct_direct_model_rejects_cross_protocol_target() {
        let mut core = VirtualRouterEngineCore::new();
        let config = json!({
            "routing": {
                "default": [{
                    "id": "default-pool",
                    "priority": 100,
                    "targets": ["mini27.key1.MiniMax-M2.7"]
                }]
            },
            "providers": {
                "mini27.key1.MiniMax-M2.7": {
                    "providerKey": "mini27.key1.MiniMax-M2.7",
                    "providerType": "openai",
                    "providerProtocol": "openai-chat",
                    "modelId": "MiniMax-M2.7",
                    "enabled": true
                }
            }
        });
        core.initialize(&config).expect("init should succeed");
        let request = json!({
            "model": "mini27.MiniMax-M2.7",
            "input": [
                { "role": "user", "content": [{ "type": "input_text", "text": "hello" }] }
            ]
        });
        let metadata = json!({
            "metadataCenterSnapshot": {
                "endpoint": "/v1/responses",
                "routerDirectInboundProtocol": "openai-responses",
                "requestId": "test-router-direct-direct-model-protocol"
            }
        });

        let error = core
            .route(
                unsafe { Env::from_raw(std::ptr::null_mut()) },
                &request,
                &metadata,
            )
            .expect_err("router-direct direct_model must not select cross-protocol target");

        assert!(error.contains("PROVIDER_NOT_AVAILABLE"));
        assert!(error.contains("All providers unavailable for model mini27.MiniMax-M2.7"));
    }

    #[test]
    fn router_direct_direct_model_alias_resolves_to_canonical_target_model() {
        let mut core = VirtualRouterEngineCore::new();
        let config = json!({
            "routing": {
                "default": [{
                    "id": "default-pool",
                    "priority": 100,
                    "targets": ["DF.key1.deepseek-v4-pro"]
                }]
            },
            "providers": {
                "DF.key1.deepseek-v4-pro": {
                    "providerKey": "DF.key1.deepseek-v4-pro",
                    "providerType": "openai",
                    "providerProtocol": "openai-chat",
                    "modelId": "DeepSeek-V4-Pro",
                    "aliasToModel": {
                        "deepseek-v4-pro": "DeepSeek-V4-Pro"
                    },
                    "enabled": true
                }
            }
        });
        core.initialize(&config).expect("init should succeed");
        let request = json!({
            "model": "DF.deepseek-v4-pro",
            "messages": [
                { "role": "user", "content": "hello" }
            ]
        });
        let metadata = json!({
            "metadataCenterSnapshot": {
                "endpoint": "/v1/chat/completions",
                "routerDirectInboundProtocol": "openai-chat",
                "requestId": "test-router-direct-direct-model-alias"
            }
        });

        let result = core
            .route(
                unsafe { Env::from_raw(std::ptr::null_mut()) },
                &request,
                &metadata,
            )
            .expect("router-direct alias request should route");
        let decision = result.get("decision").expect("should have decision");
        let target = result.get("target").expect("should have target");
        assert_eq!(
            decision["providerKey"].as_str(),
            Some("DF.key1.deepseek-v4-pro")
        );
        assert_eq!(target["modelId"].as_str(), Some("DeepSeek-V4-Pro"));
        assert!(decision["reasoning"]
            .as_str()
            .unwrap_or_default()
            .contains("direct_model:DF.DeepSeek-V4-Pro"));
    }

    #[test]
    fn route_returns_error_when_no_providers_configured() {
        let mut core = VirtualRouterEngineCore::new();
        let config = json!({
            "routing": {
                "default": [{
                    "id": "default-pool",
                    "priority": 100,
                    "targets": ["nonexistent.key1.model"]
                }]
            },
            "providers": {}
        });
        core.initialize(&config).expect("init should succeed");

        let request = json!({
            "messages": [
                { "role": "user", "content": "hello" }
            ]
        });
        let metadata = json!({
            "metadataCenterSnapshot": {
                "endpoint": "/v1/chat/completions",
                "requestId": "test-456"
            }
        });

        let result = core.route(
            unsafe { Env::from_raw(std::ptr::null_mut()) },
            &request,
            &metadata,
        );
        assert!(
            result.is_err(),
            "route should fail when no providers available"
        );
    }

    #[test]
    fn route_output_contains_required_fields() {
        let mut core = build_route_test_core();
        let request = json!({
            "messages": [
                { "role": "user", "content": "hello" }
            ]
        });
        let metadata = json!({
            "metadataCenterSnapshot": {
                "endpoint": "/v1/chat/completions",
                "requestId": "test-789"
            }
        });

        let result = core
            .route(
                unsafe { Env::from_raw(std::ptr::null_mut()) },
                &request,
                &metadata,
            )
            .unwrap();

        // Output should have decision with required fields
        let decision = result.get("decision").expect("should have decision");
        assert!(
            decision.get("providerKey").is_some(),
            "decision should have providerKey"
        );
        assert!(
            decision.get("routeName").is_some(),
            "decision should have routeName"
        );
    }
}

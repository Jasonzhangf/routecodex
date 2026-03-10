use serde_json::{Map, Value};

use crate::virtual_router_engine::time_utils::now_ms;

use super::types::{
    InstructionTarget, PreCommandInstruction, PreCommandState, RoutingInstruction,
    RoutingInstructionState, StopMessageInstruction, StopMessagePatchOutput, StopMessageState,
    DEFAULT_STOP_MESSAGE_MAX_REPEATS,
};

pub(crate) fn build_metadata_instructions(metadata: &Value) -> Vec<RoutingInstruction> {
    let mut instructions = Vec::new();
    let forced_field = "__shadowCompareForcedProviderKey";
    if let Some(raw) = metadata.get(forced_field).and_then(|v| v.as_str()) {
        let trimmed = raw.trim();
        if let Some(target) = super::parse::parse_target(trimmed) {
            instructions.push(RoutingInstruction {
                kind: "force".to_string(),
                target: Some(target),
                provider: None,
                stop_message: None,
                pre_command: None,
            });
        }
    }
    if let Some(disabled) = metadata
        .get("disabledProviderKeyAliases")
        .and_then(|v| v.as_array())
    {
        for entry in disabled {
            if let Some(text) = entry.as_str() {
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let parts: Vec<&str> = trimmed.split('.').collect();
                if parts.len() < 2 {
                    continue;
                }
                let provider = parts[0].trim().to_string();
                let alias = parts[1].trim().to_string();
                if provider.is_empty() || alias.is_empty() {
                    continue;
                }
                let mut target = InstructionTarget {
                    provider: Some(provider),
                    key_alias: None,
                    key_index: None,
                    model: None,
                    path_length: Some(2),
                    process_mode: None,
                };
                if regex::Regex::new(r"^\d+$").unwrap().is_match(&alias) {
                    if let Ok(parsed) = alias.parse::<i64>() {
                        target.key_index = Some(parsed);
                    }
                } else {
                    target.key_alias = Some(alias);
                }
                instructions.push(RoutingInstruction {
                    kind: "disable".to_string(),
                    target: Some(target),
                    provider: None,
                    stop_message: None,
                    pre_command: None,
                });
            }
        }
    }
    instructions
}

pub(crate) fn strip_stop_message_fields(
    state: &RoutingInstructionState,
) -> RoutingInstructionState {
    let mut next = state.clone();
    next.stop_message_state = StopMessageState::default();
    next
}

pub(crate) fn strip_client_inject_fields(
    state: &RoutingInstructionState,
) -> RoutingInstructionState {
    let mut next = strip_stop_message_fields(state);
    next.pre_command = PreCommandState::default();
    next
}

pub(crate) fn has_client_inject_fields(state: &RoutingInstructionState) -> bool {
    let stop = &state.stop_message_state;
    let has_stop = stop.stop_message_text.is_some()
        || stop.stop_message_max_repeats.is_some()
        || stop.stop_message_used.is_some()
        || stop.stop_message_stage_mode.is_some()
        || stop.stop_message_ai_mode.is_some()
        || stop.stop_message_ai_seed_prompt.is_some()
        || stop.stop_message_ai_history.is_some()
        || stop.stop_message_updated_at.is_some()
        || stop.stop_message_last_used_at.is_some();
    let pre = &state.pre_command;
    let has_pre = pre.pre_command_script_path.is_some()
        || pre.pre_command_source.is_some()
        || pre.pre_command_updated_at.is_some();
    has_stop || has_pre
}

fn stop_message_state_to_map(state: &StopMessageState) -> Map<String, Value> {
    let mut map = Map::new();
    if let Some(value) = &state.stop_message_source {
        map.insert(
            "stopMessageSource".to_string(),
            Value::String(value.clone()),
        );
    }
    if let Some(value) = &state.stop_message_text {
        map.insert("stopMessageText".to_string(), Value::String(value.clone()));
    }
    if let Some(value) = state.stop_message_max_repeats {
        map.insert(
            "stopMessageMaxRepeats".to_string(),
            Value::Number(value.into()),
        );
    }
    if let Some(value) = state.stop_message_used {
        map.insert("stopMessageUsed".to_string(), Value::Number(value.into()));
    }
    if let Some(value) = state.stop_message_updated_at {
        map.insert(
            "stopMessageUpdatedAt".to_string(),
            Value::Number(value.into()),
        );
    }
    if let Some(value) = state.stop_message_last_used_at {
        map.insert(
            "stopMessageLastUsedAt".to_string(),
            Value::Number(value.into()),
        );
    }
    if let Some(value) = &state.stop_message_stage_mode {
        map.insert(
            "stopMessageStageMode".to_string(),
            Value::String(value.clone()),
        );
    }
    if let Some(value) = &state.stop_message_ai_mode {
        map.insert(
            "stopMessageAiMode".to_string(),
            Value::String(value.clone()),
        );
    }
    if let Some(value) = &state.stop_message_ai_seed_prompt {
        map.insert(
            "stopMessageAiSeedPrompt".to_string(),
            Value::String(value.clone()),
        );
    }
    if let Some(value) = &state.stop_message_ai_history {
        map.insert(
            "stopMessageAiHistory".to_string(),
            Value::Array(value.clone()),
        );
    }
    map
}

fn apply_stop_message_patch(state: &mut StopMessageState, patch: StopMessagePatchOutput) {
    for field in patch.unset {
        match field.as_str() {
            "stopMessageSource" => state.stop_message_source = None,
            "stopMessageText" => state.stop_message_text = None,
            "stopMessageMaxRepeats" => state.stop_message_max_repeats = None,
            "stopMessageUsed" => state.stop_message_used = None,
            "stopMessageUpdatedAt" => state.stop_message_updated_at = None,
            "stopMessageLastUsedAt" => state.stop_message_last_used_at = None,
            "stopMessageStageMode" => state.stop_message_stage_mode = None,
            "stopMessageAiMode" => state.stop_message_ai_mode = None,
            "stopMessageAiSeedPrompt" => state.stop_message_ai_seed_prompt = None,
            "stopMessageAiHistory" => state.stop_message_ai_history = None,
            _ => {}
        }
    }
    for (field, value) in patch.set {
        match field.as_str() {
            "stopMessageSource" => {
                if let Some(text) = value.as_str() {
                    state.stop_message_source = Some(text.to_string());
                }
            }
            "stopMessageText" => {
                if let Some(text) = value.as_str() {
                    state.stop_message_text = Some(text.to_string());
                }
            }
            "stopMessageMaxRepeats" => {
                if let Some(num) = value.as_i64() {
                    state.stop_message_max_repeats = Some(num);
                }
            }
            "stopMessageUsed" => {
                if let Some(num) = value.as_i64() {
                    state.stop_message_used = Some(num);
                }
            }
            "stopMessageUpdatedAt" => {
                if let Some(num) = value.as_i64() {
                    state.stop_message_updated_at = Some(num);
                }
            }
            "stopMessageLastUsedAt" => {
                if let Some(num) = value.as_i64() {
                    state.stop_message_last_used_at = Some(num);
                }
            }
            "stopMessageStageMode" => {
                if let Some(text) = value.as_str() {
                    state.stop_message_stage_mode = Some(text.to_string());
                }
            }
            "stopMessageAiMode" => {
                if let Some(text) = value.as_str() {
                    state.stop_message_ai_mode = Some(text.to_string());
                }
            }
            "stopMessageAiSeedPrompt" => {
                if let Some(text) = value.as_str() {
                    state.stop_message_ai_seed_prompt = Some(text.to_string());
                }
            }
            "stopMessageAiHistory" => {
                if let Some(arr) = value.as_array() {
                    state.stop_message_ai_history = Some(arr.clone());
                }
            }
            _ => {}
        }
    }
}

fn apply_stop_message_instruction_to_state(
    state: &mut StopMessageState,
    instruction: &StopMessageInstruction,
    now_ms: i64,
) -> Result<(), String> {
    let mut instruction_map = Map::new();
    instruction_map.insert(
        "type".to_string(),
        Value::String(match instruction.kind.as_str() {
            "clear" => "stopMessageClear".to_string(),
            _ => "stopMessageSet".to_string(),
        }),
    );
    if let Some(text) = &instruction.text {
        instruction_map.insert("stopMessageText".to_string(), Value::String(text.clone()));
    }
    if let Some(max_repeats) = instruction.max_repeats {
        instruction_map.insert(
            "stopMessageMaxRepeats".to_string(),
            Value::Number(max_repeats.into()),
        );
    }
    if let Some(mode) = &instruction.ai_mode {
        instruction_map.insert("stopMessageAiMode".to_string(), Value::String(mode.clone()));
    }
    if let Some(source) = &instruction.source {
        instruction_map.insert(
            "stopMessageSource".to_string(),
            Value::String(source.clone()),
        );
    }
    if instruction.from_historical {
        instruction_map.insert("fromHistoricalUserMessage".to_string(), Value::Bool(true));
    }
    let instruction_json = serde_json::to_string(&Value::Object(instruction_map))
        .map_err(|e| format!("stopMessage instruction serialize failed: {}", e))?;
    let state_json = serde_json::to_string(&Value::Object(stop_message_state_to_map(state)))
        .map_err(|e| format!("stopMessage state serialize failed: {}", e))?;
    let raw_patch =
        crate::virtual_router_stop_message_actions::apply_stop_message_instruction_json(
            instruction_json,
            state_json,
            now_ms,
        )
        .map_err(|e| e.to_string())?;
    let patch: StopMessagePatchOutput = serde_json::from_str(&raw_patch)
        .map_err(|e| format!("stopMessage patch parse failed: {}", e))?;
    if patch.applied {
        apply_stop_message_patch(state, patch);
    }
    Ok(())
}

fn apply_pre_command_instruction_to_state(
    state: &mut PreCommandState,
    instruction: &PreCommandInstruction,
    now_ms: i64,
) {
    match instruction.kind.as_str() {
        "clear" => {
            state.pre_command_script_path = None;
            state.pre_command_source = None;
            state.pre_command_updated_at = None;
        }
        _ => {
            if let Some(script_path) = &instruction.script_path {
                let trimmed = script_path.trim();
                if !trimmed.is_empty() {
                    state.pre_command_script_path = Some(trimmed.to_string());
                    state.pre_command_source = Some("explicit".to_string());
                    state.pre_command_updated_at = Some(now_ms);
                }
            }
        }
    }
}

pub(crate) fn apply_routing_instructions(
    instructions: &[RoutingInstruction],
    state: &mut RoutingInstructionState,
) -> Result<(), String> {
    let mut allow_reset = false;
    let mut disable_reset = false;
    for instruction in instructions {
        match instruction.kind.as_str() {
            "force" => {
                state.forced_target = instruction.target.clone();
            }
            "sticky" => {
                state.sticky_target = instruction.target.clone();
                state.forced_target = None;
            }
            "prefer" => {
                state.prefer_target = instruction.target.clone();
                state.forced_target = None;
                state.sticky_target = None;
            }
            "allow" => {
                if !allow_reset {
                    state.allowed_providers.clear();
                    allow_reset = true;
                }
                if let Some(provider) = &instruction.provider {
                    state.allowed_providers.insert(provider.clone());
                }
            }
            "disable" => {
                if !disable_reset {
                    state.disabled_providers.clear();
                    state.disabled_keys.clear();
                    state.disabled_models.clear();
                    disable_reset = true;
                }
                if let Some(target) = &instruction.target {
                    if let Some(provider) = &target.provider {
                        let has_key = target.key_alias.is_some() || target.key_index.is_some();
                        let has_model = target.model.is_some();
                        if has_key {
                            let entry = state
                                .disabled_keys
                                .entry(provider.clone())
                                .or_insert_with(std::collections::HashSet::new);
                            if let Some(alias) = &target.key_alias {
                                entry.insert(alias.clone());
                            }
                            if let Some(idx) = target.key_index {
                                entry.insert(idx.to_string());
                            }
                        }
                        if has_model {
                            let entry = state
                                .disabled_models
                                .entry(provider.clone())
                                .or_insert_with(std::collections::HashSet::new);
                            if let Some(model) = &target.model {
                                entry.insert(model.clone());
                            }
                        }
                        if !has_key && !has_model {
                            state.disabled_providers.insert(provider.clone());
                        }
                    }
                }
            }
            "enable" => {
                if let Some(target) = &instruction.target {
                    if let Some(provider) = &target.provider {
                        let has_key = target.key_alias.is_some() || target.key_index.is_some();
                        let has_model = target.model.is_some();
                        if has_key {
                            if let Some(entry) = state.disabled_keys.get_mut(provider) {
                                if let Some(alias) = &target.key_alias {
                                    entry.remove(alias);
                                }
                                if let Some(idx) = target.key_index {
                                    entry.remove(&idx.to_string());
                                }
                                if entry.is_empty() {
                                    state.disabled_keys.remove(provider);
                                }
                            }
                        }
                        if has_model {
                            if let Some(entry) = state.disabled_models.get_mut(provider) {
                                if let Some(model) = &target.model {
                                    entry.remove(model);
                                }
                                if entry.is_empty() {
                                    state.disabled_models.remove(provider);
                                }
                            }
                        }
                        if !has_key && !has_model {
                            state.disabled_providers.remove(provider);
                            state.disabled_keys.remove(provider);
                            state.disabled_models.remove(provider);
                        }
                    }
                }
            }
            "clear" => {
                state.forced_target = None;
                state.sticky_target = None;
                state.prefer_target = None;
                state.allowed_providers.clear();
                state.disabled_providers.clear();
                state.disabled_keys.clear();
                state.disabled_models.clear();
                state.stop_message_state = StopMessageState::default();
                state.pre_command = PreCommandState::default();
            }
            "stopMessageSet" | "stopMessageMode" | "stopMessageClear" => {
                if let Some(stop) = &instruction.stop_message {
                    apply_stop_message_instruction_to_state(
                        &mut state.stop_message_state,
                        stop,
                        now_ms(),
                    )?;
                }
            }
            "preCommandSet" | "preCommandClear" => {
                if let Some(pre) = &instruction.pre_command {
                    apply_pre_command_instruction_to_state(&mut state.pre_command, pre, now_ms());
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn normalize_stage_mode(value: &Option<String>) -> Option<String> {
    let raw = value.as_ref()?.trim().to_ascii_lowercase();
    if raw == "on" || raw == "off" || raw == "auto" {
        return Some(raw);
    }
    None
}

fn normalize_ai_mode(value: &Option<String>) -> Option<String> {
    let raw = value.as_ref()?.trim().to_ascii_lowercase();
    if raw == "on" || raw == "off" {
        return Some(raw);
    }
    None
}

pub(crate) fn ensure_stop_message_mode_max_repeats(state: &mut StopMessageState) {
    let mode = normalize_stage_mode(&state.stop_message_stage_mode);
    if mode.as_deref() != Some("on") && mode.as_deref() != Some("auto") {
        return;
    }
    if let Some(max) = state.stop_message_max_repeats {
        if max > 0 {
            return;
        }
    }
    state.stop_message_max_repeats = Some(DEFAULT_STOP_MESSAGE_MAX_REPEATS);
}

pub(crate) fn stop_message_state_snapshot(state: &StopMessageState) -> Option<Value> {
    let text = state
        .stop_message_text
        .as_ref()
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    let max_repeats = state.stop_message_max_repeats.unwrap_or(0);
    let stage_mode = normalize_stage_mode(&state.stop_message_stage_mode);
    if stage_mode.as_deref() == Some("off") || text.is_empty() || max_repeats <= 0 {
        return None;
    }
    let ai_mode = normalize_ai_mode(&state.stop_message_ai_mode);
    let mut out = Map::new();
    out.insert("stopMessageText".to_string(), Value::String(text));
    out.insert(
        "stopMessageMaxRepeats".to_string(),
        Value::Number(max_repeats.into()),
    );
    if let Some(value) = &state.stop_message_source {
        if !value.trim().is_empty() {
            out.insert(
                "stopMessageSource".to_string(),
                Value::String(value.trim().to_string()),
            );
        }
    }
    if let Some(value) = state.stop_message_used {
        out.insert(
            "stopMessageUsed".to_string(),
            Value::Number(value.max(0).into()),
        );
    }
    if let Some(value) = state.stop_message_updated_at {
        out.insert(
            "stopMessageUpdatedAt".to_string(),
            Value::Number(value.into()),
        );
    }
    if let Some(value) = state.stop_message_last_used_at {
        out.insert(
            "stopMessageLastUsedAt".to_string(),
            Value::Number(value.into()),
        );
    }
    if let Some(mode) = stage_mode {
        out.insert("stopMessageStageMode".to_string(), Value::String(mode));
    }
    if let Some(mode) = ai_mode {
        out.insert("stopMessageAiMode".to_string(), Value::String(mode));
    }
    if let Some(value) = &state.stop_message_ai_seed_prompt {
        if !value.trim().is_empty() {
            out.insert(
                "stopMessageAiSeedPrompt".to_string(),
                Value::String(value.trim().to_string()),
            );
        }
    }
    if let Some(history) = &state.stop_message_ai_history {
        out.insert(
            "stopMessageAiHistory".to_string(),
            Value::Array(history.clone()),
        );
    }
    Some(Value::Object(out))
}

pub(crate) fn pre_command_state_snapshot(state: &PreCommandState) -> Option<Value> {
    let script_path = state
        .pre_command_script_path
        .as_ref()
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    if script_path.is_empty() {
        return None;
    }
    let mut out = Map::new();
    out.insert(
        "preCommandScriptPath".to_string(),
        Value::String(script_path),
    );
    if let Some(source) = &state.pre_command_source {
        if !source.trim().is_empty() {
            out.insert(
                "preCommandSource".to_string(),
                Value::String(source.trim().to_string()),
            );
        }
    }
    if let Some(updated_at) = state.pre_command_updated_at {
        out.insert(
            "preCommandUpdatedAt".to_string(),
            Value::Number(updated_at.into()),
        );
    }
    Some(Value::Object(out))
}

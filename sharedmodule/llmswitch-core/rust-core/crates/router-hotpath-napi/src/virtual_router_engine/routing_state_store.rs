use serde_json::{json, Map, Value};
use std::cell::RefCell;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use super::instructions::{InstructionTarget, RoutingInstructionState};
use super::rcc_fence::StoplessGoalState;

const ROUTECODEX_SESSION_DIR_ENV: &str = "ROUTECODEX_SESSION_DIR";
const RCC_HOME_ENV: &str = "RCC_HOME";
const ROUTECODEX_USER_DIR_ENV: &str = "ROUTECODEX_USER_DIR";
const ROUTECODEX_HOME_ENV: &str = "ROUTECODEX_HOME";

thread_local! {
    static SESSION_DIR_OVERRIDE: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
}

struct SessionDirOverrideGuard {
    previous: Option<PathBuf>,
}

impl Drop for SessionDirOverrideGuard {
    fn drop(&mut self) {
        SESSION_DIR_OVERRIDE.with(|slot| {
            *slot.borrow_mut() = self.previous.take();
        });
    }
}

fn normalize_override_session_dir(raw: Option<&str>) -> Option<PathBuf> {
    let trimmed = raw?.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(PathBuf::from(trimmed))
}

fn read_override_session_dir() -> Option<PathBuf> {
    SESSION_DIR_OVERRIDE.with(|slot| slot.borrow().clone())
}

pub(crate) fn with_session_dir_override<T>(raw: Option<&str>, callback: impl FnOnce() -> T) -> T {
    let next = normalize_override_session_dir(raw);
    let previous = SESSION_DIR_OVERRIDE.with(|slot| {
        let previous = slot.borrow().clone();
        *slot.borrow_mut() = next;
        previous
    });
    let _guard = SessionDirOverrideGuard { previous };
    callback()
}

pub(crate) fn load_routing_instruction_state(key: &str) -> Option<RoutingInstructionState> {
    if !is_persistent_key(key) {
        return None;
    }
    let filepath = resolve_session_filepath(key)?;
    let raw = match fs::read_to_string(&filepath) {
        Ok(content) => content,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!(
                    "[routing_state_store] Failed to read state file {:?}: {}",
                    filepath, e
                );
            }
            return None;
        }
    };
    if raw.trim().is_empty() {
        return None;
    }
    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!(
                "[routing_state_store] Failed to parse JSON from {:?}: {}",
                filepath, e
            );
            return None;
        }
    };
    let payload = match parsed {
        Value::Object(mut obj) => {
            if let Some(state) = obj.remove("state") {
                state
            } else {
                Value::Object(obj)
            }
        }
        _ => return None,
    };
    deserialize_routing_instruction_state(&payload)
}

pub(crate) fn persist_routing_instruction_state(
    key: &str,
    state: Option<&RoutingInstructionState>,
) {
    if !is_persistent_key(key) {
        return;
    }
    let filepath = match resolve_session_filepath(key) {
        Some(path) => path,
        None => return,
    };
    let should_clear = state.map(is_state_empty).unwrap_or(true);
    if should_clear {
        if let Err(e) = fs::remove_file(&filepath) {
            if e.kind() != std::io::ErrorKind::NotFound {
                eprintln!(
                    "[routing_state_store] Failed to remove state file {:?}: {}",
                    filepath, e
                );
            }
        }
        return;
    }
    let payload = match state {
        Some(state) => {
            let mut root = Map::new();
            root.insert("version".to_string(), Value::Number(1.into()));
            root.insert(
                "state".to_string(),
                serialize_routing_instruction_state(state),
            );
            Value::Object(root)
        }
        None => Value::Null,
    };
    if let Some(dir) = filepath.parent() {
        if let Err(e) = fs::create_dir_all(dir) {
            eprintln!(
                "[routing_state_store] Failed to create directory {:?}: {}",
                dir, e
            );
            return;
        }
    }
    let text = match serde_json::to_string(&payload) {
        Ok(t) => t,
        Err(e) => {
            eprintln!(
                "[routing_state_store] Failed to serialize state for {:?}: {}",
                filepath, e
            );
            return;
        }
    };
    if let Err(e) = fs::write(&filepath, text) {
        eprintln!(
            "[routing_state_store] Failed to write state file {:?}: {}",
            filepath, e
        );
    }
}

fn is_persistent_key(key: &str) -> bool {
    key.starts_with("session:") || key.starts_with("conversation:") || key.starts_with("tmux:")
}

fn expand_home(value: &str, home_dir: &Path) -> PathBuf {
    if let Some(stripped) = value.strip_prefix("~/") {
        return home_dir.join(stripped);
    }
    PathBuf::from(value)
}

fn resolve_rcc_user_dir() -> Option<PathBuf> {
    let home = env::var("HOME")
        .ok()
        .or_else(|| env::var("USERPROFILE").ok())
        .unwrap_or_default();
    let home_trimmed = home.trim();
    if home_trimmed.is_empty() {
        return None;
    }
    let home_dir = PathBuf::from(home_trimmed);
    let legacy_dir = home_dir.join(".routecodex");
    for key in [RCC_HOME_ENV, ROUTECODEX_USER_DIR_ENV, ROUTECODEX_HOME_ENV] {
        if let Ok(value) = env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                let candidate = expand_home(trimmed, &home_dir);
                if candidate == legacy_dir {
                    continue;
                }
                return Some(candidate);
            }
        }
    }
    Some(home_dir.join(".rcc"))
}

fn resolve_session_dir() -> Option<PathBuf> {
    if let Some(explicit) = read_override_session_dir() {
        return Some(explicit);
    }
    if let Ok(value) = env::var(ROUTECODEX_SESSION_DIR_ENV) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    resolve_rcc_user_dir().map(|base| base.join("sessions"))
}

fn key_to_filename(key: &str) -> Option<String> {
    let idx = key.find(':')?;
    if idx == 0 || idx + 1 >= key.len() {
        return None;
    }
    let scope = &key[..idx];
    let raw_id = &key[idx + 1..];
    let safe_id: String = raw_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if safe_id.is_empty() {
        return None;
    }
    Some(format!("{}-{}.json", scope, safe_id))
}

fn resolve_session_filepath(key: &str) -> Option<PathBuf> {
    let dir = resolve_session_dir()?;
    let filename = key_to_filename(key)?;
    Some(dir.join(Path::new(&filename)))
}

fn resolve_provider_health_filepath() -> Option<PathBuf> {
    let dir = resolve_session_dir()?;
    Some(dir.join(Path::new("provider-health.json")))
}

pub(crate) fn load_provider_health_state() -> Option<Value> {
    let filepath = resolve_provider_health_filepath()?;
    let raw = fs::read_to_string(&filepath).ok()?;
    if raw.trim().is_empty() {
        return None;
    }
    serde_json::from_str(&raw).ok()
}

pub(crate) fn persist_provider_health_state(state: &Value) {
    let filepath = match resolve_provider_health_filepath() {
        Some(path) => path,
        None => return,
    };
    if let Some(dir) = filepath.parent() {
        if fs::create_dir_all(dir).is_err() {
            return;
        }
    }
    let Ok(text) = serde_json::to_string(state) else {
        return;
    };
    let _ = fs::write(&filepath, text);
}

pub(crate) fn is_state_empty(state: &RoutingInstructionState) -> bool {
    is_stopless_goal_empty(state)
        && state.forced_target.is_none()
        && state.allowed_providers.is_empty()
        && state.disabled_providers.is_empty()
        && state.disabled_keys.is_empty()
        && state.disabled_models.is_empty()
        && is_stop_message_empty(state)
        && is_pre_command_empty(state)
}

fn is_stopless_goal_empty(state: &RoutingInstructionState) -> bool {
    state.stopless_goal_state.is_none()
}

fn is_stop_message_empty(state: &RoutingInstructionState) -> bool {
    state.stop_message_state.stop_message_source.is_none()
        && state.stop_message_state.stop_message_text.is_none()
        && state.stop_message_state.stop_message_max_repeats.is_none()
        && state.stop_message_state.stop_message_used.is_none()
        && state.stop_message_state.stop_message_stage_mode.is_none()
        && state.stop_message_state.stop_message_ai_mode.is_none()
        && state
            .stop_message_state
            .stop_message_ai_seed_prompt
            .is_none()
        && state.stop_message_state.stop_message_ai_history.is_none()
}

fn is_pre_command_empty(state: &RoutingInstructionState) -> bool {
    state.pre_command.pre_command_source.is_none()
        && state.pre_command.pre_command_script_path.is_none()
        && state.pre_command.pre_command_updated_at.is_none()
}

fn serialize_routing_instruction_state(state: &RoutingInstructionState) -> Value {
    let mut out = Map::new();
    serialize_stopless_goal_state(state, &mut out);
    if let Some(target) = &state.forced_target {
        out.insert(
            "forcedTarget".to_string(),
            serialize_instruction_target(target),
        );
    }
    out.insert(
        "allowedProviders".to_string(),
        Value::Array(
            state
                .allowed_providers
                .iter()
                .cloned()
                .map(Value::String)
                .collect(),
        ),
    );
    out.insert(
        "disabledProviders".to_string(),
        Value::Array(
            state
                .disabled_providers
                .iter()
                .cloned()
                .map(Value::String)
                .collect(),
        ),
    );
    let mut disabled_keys = Vec::new();
    for (provider, keys) in &state.disabled_keys {
        let mut entry = Map::new();
        entry.insert("provider".to_string(), Value::String(provider.clone()));
        entry.insert(
            "keys".to_string(),
            Value::Array(keys.iter().cloned().map(Value::String).collect()),
        );
        disabled_keys.push(Value::Object(entry));
    }
    out.insert("disabledKeys".to_string(), Value::Array(disabled_keys));
    let mut disabled_models = Vec::new();
    for (provider, models) in &state.disabled_models {
        let mut entry = Map::new();
        entry.insert("provider".to_string(), Value::String(provider.clone()));
        entry.insert(
            "models".to_string(),
            Value::Array(models.iter().cloned().map(Value::String).collect()),
        );
        disabled_models.push(Value::Object(entry));
    }
    out.insert("disabledModels".to_string(), Value::Array(disabled_models));
    serialize_stop_message_state(state, &mut out);
    serialize_pre_command_state(state, &mut out);
    Value::Object(out)
}

fn serialize_stopless_goal_state(state: &RoutingInstructionState, out: &mut Map<String, Value>) {
    let Some(goal) = &state.stopless_goal_state else {
        return;
    };
    let mut goal_out = Map::new();
    goal_out.insert("status".to_string(), Value::String(goal.status.clone()));
    goal_out.insert(
        "objective".to_string(),
        Value::String(goal.objective.clone()),
    );
    if let Some(value) = &goal.latest_note {
        if !value.trim().is_empty() {
            goal_out.insert(
                "latestNote".to_string(),
                Value::String(value.trim().to_string()),
            );
        }
    }
    if let Some(value) = &goal.completion_evidence {
        if !value.trim().is_empty() {
            goal_out.insert(
                "completionEvidence".to_string(),
                Value::String(value.trim().to_string()),
            );
        }
    }
    if let Some(value) = &goal.next_step {
        if !value.trim().is_empty() {
            goal_out.insert(
                "nextStep".to_string(),
                Value::String(value.trim().to_string()),
            );
        }
    }
    if let Some(value) = &goal.user_question {
        if !value.trim().is_empty() {
            goal_out.insert(
                "userQuestion".to_string(),
                Value::String(value.trim().to_string()),
            );
        }
    }
    if let Some(value) = &goal.cannot_continue_reason {
        if !value.trim().is_empty() {
            goal_out.insert(
                "cannotContinueReason".to_string(),
                Value::String(value.trim().to_string()),
            );
        }
    }
    if let Some(value) = &goal.blocking_evidence {
        if !value.trim().is_empty() {
            goal_out.insert(
                "blockingEvidence".to_string(),
                Value::String(value.trim().to_string()),
            );
        }
    }
    if goal.attempts_exhausted == Some(true) {
        goal_out.insert("attemptsExhausted".to_string(), Value::Bool(true));
    }
    if let Some(value) = &goal.error_class {
        if !value.trim().is_empty() {
            goal_out.insert(
                "errorClass".to_string(),
                Value::String(value.trim().to_string()),
            );
        }
    }
    if let Some(value) = &goal.completion_summary {
        if !value.trim().is_empty() {
            goal_out.insert(
                "completionSummary".to_string(),
                Value::String(value.trim().to_string()),
            );
        }
    }
    if let Some(value) = &goal.ssot_assessment {
        if !value.trim().is_empty() {
            goal_out.insert(
                "ssotAssessment".to_string(),
                Value::String(value.trim().to_string()),
            );
        }
    }
    if let Some(value) = goal.consecutive_irrecoverable_errors {
        goal_out.insert(
            "consecutiveIrrecoverableErrors".to_string(),
            Value::Number(value.max(0).into()),
        );
    }
    if let Some(value) = goal.consecutive_validation_failures {
        goal_out.insert(
            "consecutiveValidationFailures".to_string(),
            Value::Number(value.max(0).into()),
        );
    }
    if let Some(value) = goal.consecutive_no_progress {
        goal_out.insert(
            "consecutiveNoProgress".to_string(),
            Value::Number(value.max(0).into()),
        );
    }
    goal_out.insert(
        "updatedAt".to_string(),
        Value::Number(goal.updated_at.into()),
    );
    goal_out.insert(
        "createdAt".to_string(),
        Value::Number(goal.created_at.into()),
    );
    out.insert("stoplessGoalState".to_string(), Value::Object(goal_out));
}

fn serialize_instruction_target(target: &InstructionTarget) -> Value {
    let mut out = Map::new();
    if let Some(value) = &target.provider {
        out.insert("provider".to_string(), Value::String(value.clone()));
    }
    if let Some(value) = &target.key_alias {
        out.insert("keyAlias".to_string(), Value::String(value.clone()));
    }
    if let Some(value) = target.key_index {
        out.insert("keyIndex".to_string(), Value::Number(value.into()));
    }
    if let Some(value) = &target.model {
        out.insert("model".to_string(), Value::String(value.clone()));
    }
    if let Some(value) = target.path_length {
        out.insert("pathLength".to_string(), Value::Number(value.into()));
    }
    if let Some(value) = &target.process_mode {
        out.insert("processMode".to_string(), Value::String(value.clone()));
    }
    Value::Object(out)
}

fn serialize_stop_message_state(state: &RoutingInstructionState, out: &mut Map<String, Value>) {
    let state = &state.stop_message_state;
    if let Some(value) = &state.stop_message_text {
        out.insert("stopMessageText".to_string(), Value::String(value.clone()));
    }
    if let Some(value) = &state.stop_message_source {
        out.insert(
            "stopMessageSource".to_string(),
            Value::String(value.clone()),
        );
    }
    if let Some(value) = state.stop_message_max_repeats {
        out.insert(
            "stopMessageMaxRepeats".to_string(),
            Value::Number(value.into()),
        );
    }
    if let Some(value) = state.stop_message_used {
        out.insert("stopMessageUsed".to_string(), Value::Number(value.into()));
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
    if let Some(value) = &state.stop_message_stage_mode {
        out.insert(
            "stopMessageStageMode".to_string(),
            Value::String(value.clone()),
        );
    }
    if let Some(value) = &state.stop_message_ai_mode {
        out.insert(
            "stopMessageAiMode".to_string(),
            Value::String(value.clone()),
        );
    }
    if let Some(value) = &state.stop_message_ai_seed_prompt {
        out.insert(
            "stopMessageAiSeedPrompt".to_string(),
            Value::String(value.clone()),
        );
    }
    if let Some(value) = &state.stop_message_ai_history {
        out.insert(
            "stopMessageAiHistory".to_string(),
            Value::Array(value.clone()),
        );
    }
}

fn serialize_pre_command_state(state: &RoutingInstructionState, out: &mut Map<String, Value>) {
    let state = &state.pre_command;
    if let Some(value) = &state.pre_command_source {
        out.insert("preCommandSource".to_string(), Value::String(value.clone()));
    }
    if let Some(value) = &state.pre_command_script_path {
        out.insert(
            "preCommandScriptPath".to_string(),
            Value::String(value.clone()),
        );
    }
    if let Some(value) = state.pre_command_updated_at {
        out.insert(
            "preCommandUpdatedAt".to_string(),
            Value::Number(value.into()),
        );
    }
}

fn deserialize_routing_instruction_state(value: &Value) -> Option<RoutingInstructionState> {
    let obj = value.as_object()?;
    let mut state = RoutingInstructionState::default();
    deserialize_stopless_goal_state(obj, &mut state);
    if let Some(target) = obj.get("forcedTarget") {
        state.forced_target = deserialize_instruction_target(target);
    }
    if let Some(items) = obj.get("allowedProviders").and_then(|v| v.as_array()) {
        for entry in items {
            if let Some(text) = entry.as_str() {
                state.allowed_providers.insert(text.to_string());
            }
        }
    }
    if let Some(items) = obj.get("disabledProviders").and_then(|v| v.as_array()) {
        for entry in items {
            if let Some(text) = entry.as_str() {
                state.disabled_providers.insert(text.to_string());
            }
        }
    }
    if let Some(items) = obj.get("disabledKeys").and_then(|v| v.as_array()) {
        for entry in items {
            let entry_obj = match entry.as_object() {
                Some(o) => o,
                None => continue,
            };
            let provider = entry_obj.get("provider").and_then(|v| v.as_str());
            let keys = entry_obj.get("keys").and_then(|v| v.as_array());
            let Some(provider) = provider else { continue };
            let mut set = std::collections::HashSet::new();
            if let Some(keys) = keys {
                for key in keys {
                    if let Some(text) = key.as_str() {
                        set.insert(text.to_string());
                    }
                }
            }
            if !set.is_empty() {
                state.disabled_keys.insert(provider.to_string(), set);
            }
        }
    }
    if let Some(items) = obj.get("disabledModels").and_then(|v| v.as_array()) {
        for entry in items {
            let entry_obj = match entry.as_object() {
                Some(o) => o,
                None => continue,
            };
            let provider = entry_obj.get("provider").and_then(|v| v.as_str());
            let models = entry_obj.get("models").and_then(|v| v.as_array());
            let Some(provider) = provider else { continue };
            let mut set = std::collections::HashSet::new();
            if let Some(models) = models {
                for model in models {
                    if let Some(text) = model.as_str() {
                        set.insert(text.to_string());
                    }
                }
            }
            if !set.is_empty() {
                state.disabled_models.insert(provider.to_string(), set);
            }
        }
    }
    deserialize_stop_message_state(obj, &mut state);
    deserialize_pre_command_state(obj, &mut state);
    Some(state)
}

fn deserialize_stopless_goal_state(obj: &Map<String, Value>, state: &mut RoutingInstructionState) {
    let Some(goal) = obj.get("stoplessGoalState").and_then(|v| v.as_object()) else {
        return;
    };
    let status = goal
        .get("status")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_ascii_lowercase());
    let objective = goal
        .get("objective")
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string());
    let updated_at = goal.get("updatedAt").and_then(|v| v.as_i64());
    let created_at = goal.get("createdAt").and_then(|v| v.as_i64());
    let Some(status) = status else { return };
    let Some(objective) = objective else { return };
    let Some(updated_at) = updated_at else { return };
    let Some(created_at) = created_at else { return };
    if objective.is_empty() {
        return;
    }
    if !matches!(
        status.as_str(),
        "idle" | "active" | "paused" | "stopped" | "completed"
    ) {
        return;
    }
    state.stopless_goal_state = Some(StoplessGoalState {
        status,
        objective,
        latest_note: goal
            .get("latestNote")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        completion_evidence: goal
            .get("completionEvidence")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        next_step: goal
            .get("nextStep")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        user_question: goal
            .get("userQuestion")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        cannot_continue_reason: goal
            .get("cannotContinueReason")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        blocking_evidence: goal
            .get("blockingEvidence")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        attempts_exhausted: goal.get("attemptsExhausted").and_then(|v| v.as_bool()),
        error_class: goal
            .get("errorClass")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        completion_summary: goal
            .get("completionSummary")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        ssot_assessment: goal
            .get("ssotAssessment")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty()),
        consecutive_irrecoverable_errors: goal
            .get("consecutiveIrrecoverableErrors")
            .and_then(|v| v.as_i64())
            .map(|v| v.max(0)),
        consecutive_validation_failures: goal
            .get("consecutiveValidationFailures")
            .and_then(|v| v.as_i64())
            .map(|v| v.max(0)),
        consecutive_no_progress: goal
            .get("consecutiveNoProgress")
            .and_then(|v| v.as_i64())
            .map(|v| v.max(0)),
        updated_at: updated_at.max(0),
        created_at: created_at.max(0),
    });
}

fn deserialize_instruction_target(value: &Value) -> Option<InstructionTarget> {
    let obj = value.as_object()?;
    Some(InstructionTarget {
        provider: obj
            .get("provider")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        key_alias: obj
            .get("keyAlias")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        key_index: obj.get("keyIndex").and_then(|v| v.as_i64()),
        model: obj
            .get("model")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
        path_length: obj.get("pathLength").and_then(|v| v.as_i64()),
        process_mode: obj
            .get("processMode")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
    })
}

fn deserialize_stop_message_state(obj: &Map<String, Value>, state: &mut RoutingInstructionState) {
    state.stop_message_state.stop_message_text = obj
        .get("stopMessageText")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    state.stop_message_state.stop_message_source = obj
        .get("stopMessageSource")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    state.stop_message_state.stop_message_max_repeats =
        obj.get("stopMessageMaxRepeats").and_then(|v| v.as_i64());
    state.stop_message_state.stop_message_used =
        obj.get("stopMessageUsed").and_then(|v| v.as_i64());
    state.stop_message_state.stop_message_updated_at =
        obj.get("stopMessageUpdatedAt").and_then(|v| v.as_i64());
    state.stop_message_state.stop_message_last_used_at =
        obj.get("stopMessageLastUsedAt").and_then(|v| v.as_i64());
    state.stop_message_state.stop_message_stage_mode = obj
        .get("stopMessageStageMode")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    state.stop_message_state.stop_message_ai_mode = obj
        .get("stopMessageAiMode")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    state.stop_message_state.stop_message_ai_seed_prompt = obj
        .get("stopMessageAiSeedPrompt")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    state.stop_message_state.stop_message_ai_history = obj
        .get("stopMessageAiHistory")
        .and_then(|v| v.as_array())
        .cloned();
}

fn deserialize_pre_command_state(obj: &Map<String, Value>, state: &mut RoutingInstructionState) {
    state.pre_command.pre_command_source = obj
        .get("preCommandSource")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    state.pre_command.pre_command_script_path = obj
        .get("preCommandScriptPath")
        .and_then(|v| v.as_str())
        .map(|v| v.to_string());
    state.pre_command.pre_command_updated_at =
        obj.get("preCommandUpdatedAt").and_then(|v| v.as_i64());
}

// ============================================================
// Port isolation red tests — lock down isolation properties
// ============================================================

#[cfg(test)]
mod isolation_tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp() -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("rcc-iso-{n}"))
    }

    // T1: two different session_dir overrides must not see each other's state
    #[test]
    fn session_dir_override_isolation_keyed_by_dir() {
        let dir_a = unique_temp();
        let dir_b = unique_temp();
        fs::create_dir_all(&dir_a).unwrap();
        fs::create_dir_all(&dir_b).unwrap();

        with_session_dir_override(dir_a.to_str(), || {
            let key = "session:iso-test";
            let state = RoutingInstructionState::default();
            persist_routing_instruction_state(key, Some(&state));

            let path_a = resolve_session_filepath(key);
            assert!(path_a.is_some(), "should resolve path under dir_a");
            let path_a = path_a.unwrap();
            assert!(path_a.starts_with(&dir_a), "path must be under dir_a");

            with_session_dir_override(dir_b.to_str(), || {
                let path_b = resolve_session_filepath(key);
                assert!(path_b.is_some());
                assert!(path_b.as_ref().unwrap().starts_with(&dir_b));
                assert_ne!(
                    path_a,
                    *path_b.as_ref().unwrap(),
                    "different dir = different path"
                );

                let loaded = load_routing_instruction_state(key);
                assert!(loaded.is_none(), "dir_b must not see dir_a's state");
            });
        });

        let _ = fs::remove_dir_all(dir_a);
        let _ = fs::remove_dir_all(dir_b);
    }

    // T2: without override, state must NOT go to any test-specific dir
    #[test]
    fn no_override_uses_default_rcc_user_dir() {
        let dir_a = unique_temp();
        fs::create_dir_all(&dir_a).unwrap();

        with_session_dir_override(dir_a.to_str(), || {
            let key = "session:default-dir-test";
            let state = RoutingInstructionState::default();
            persist_routing_instruction_state(key, Some(&state));
            let path = resolve_session_filepath(key).unwrap();
            assert!(path.starts_with(&dir_a));
        });

        let key = "session:default-dir-test2";
        let state = RoutingInstructionState::default();
        persist_routing_instruction_state(key, Some(&state));
        let path = resolve_session_filepath(key).unwrap();
        assert!(
            !path.starts_with(&dir_a),
            "without override must NOT use dir_a"
        );

        let _ = fs::remove_dir_all(dir_a);
        if let Some(p) = resolve_session_filepath(key) {
            let _ = fs::remove_file(p);
        }
    }

    // T3: provider health state also respects session_dir override
    #[test]
    fn provider_health_respects_session_dir_override() {
        let dir_a = unique_temp();
        let dir_b = unique_temp();
        fs::create_dir_all(&dir_a).unwrap();
        fs::create_dir_all(&dir_b).unwrap();

        with_session_dir_override(dir_a.to_str(), || {
            let health_state = json!({
                "providerCooldowns": [
                    {"provider": "test-p", "expires": 9999999999i64}
                ]
            });
            persist_provider_health_state(&health_state);
            let path_a = resolve_provider_health_filepath().unwrap();
            assert!(path_a.starts_with(&dir_a));

            with_session_dir_override(dir_b.to_str(), || {
                let loaded = load_provider_health_state();
                assert!(
                    loaded.is_none(),
                    "dir_b must not see dir_a's provider health"
                );
            });
        });

        let _ = fs::remove_dir_all(dir_a);
        let _ = fs::remove_dir_all(dir_b);
    }
}

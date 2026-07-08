use chrono::TimeZone;
use serde_json::{Map, Value};
use std::cell::RefCell;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::instructions::{GlobalRequestCounter, InstructionTarget, RoutingInstructionState};

const GLOBAL_COUNTER_KEY: &str = "__global_request_counter__";

const RCC_HOME_ENV: &str = "RCC_HOME";
const ROUTECODEX_USER_DIR_ENV: &str = "ROUTECODEX_USER_DIR";
const ROUTECODEX_HOME_ENV: &str = "ROUTECODEX_HOME";
const NO_SESSION_DIR_OVERRIDE_SENTINEL: &str = "__ROUTECODEX_NO_SESSION_DIR_OVERRIDE__";
const GLOBAL_REQUEST_COUNTER_FILENAME: &str = "global-request-counter.json";

#[derive(Clone)]
enum SessionDirOverride {
    Inherit,
    Disabled,
    Path(PathBuf),
}

thread_local! {
    static SESSION_DIR_OVERRIDE: RefCell<SessionDirOverride> = const { RefCell::new(SessionDirOverride::Inherit) };
}

struct SessionDirOverrideGuard {
    previous: SessionDirOverride,
}

impl Drop for SessionDirOverrideGuard {
    fn drop(&mut self) {
        SESSION_DIR_OVERRIDE.with(|slot| {
            let previous = std::mem::replace(&mut self.previous, SessionDirOverride::Inherit);
            *slot.borrow_mut() = previous;
        });
    }
}

fn parse_session_dir_override(raw: Option<&str>) -> SessionDirOverride {
    match raw {
        Some(value) => {
            let trimmed = value.trim();
            if trimmed.is_empty() || trimmed == NO_SESSION_DIR_OVERRIDE_SENTINEL {
                SessionDirOverride::Disabled
            } else {
                SessionDirOverride::Path(PathBuf::from(trimmed))
            }
        }
        None => SessionDirOverride::Inherit,
    }
}

fn read_override_session_dir() -> SessionDirOverride {
    SESSION_DIR_OVERRIDE.with(|slot| slot.borrow().clone())
}

pub(crate) fn with_session_dir_override<T>(raw: Option<&str>, callback: impl FnOnce() -> T) -> T {
    let next = parse_session_dir_override(raw);
    let previous = SESSION_DIR_OVERRIDE.with(|slot| {
        let previous = slot.borrow().clone();
        *slot.borrow_mut() = next;
        previous
    });
    let _guard = SessionDirOverrideGuard { previous };
    callback()
}

pub(crate) fn with_session_dir_persistence_disabled<T>(callback: impl FnOnce() -> T) -> T {
    let previous = SESSION_DIR_OVERRIDE.with(|slot| {
        let previous = slot.borrow().clone();
        *slot.borrow_mut() = SessionDirOverride::Disabled;
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
    if let Err(e) = atomic_write_file(&filepath, &text) {
        eprintln!(
            "[routing_state_store] Failed to write state file {:?}: {}",
            filepath, e
        );
    }
}

pub(crate) fn load_routing_instruction_state_strict(
    key: &str,
) -> Result<Option<RoutingInstructionState>, String> {
    if !is_persistent_key(key) {
        return Err(format!(
            "routing instruction state key is not persistent: {}",
            key
        ));
    }
    let filepath = resolve_session_filepath(key).ok_or_else(|| {
        format!(
            "failed to resolve routing instruction state path for {}",
            key
        )
    })?;
    let raw = match fs::read_to_string(&filepath) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(format!(
                "failed to read routing instruction state {:?}: {}",
                filepath, e
            ));
        }
    };
    if raw.trim().is_empty() {
        return Err(format!(
            "routing instruction state file is empty: {:?}",
            filepath
        ));
    }
    let parsed: Value = serde_json::from_str(&raw).map_err(|e| {
        format!(
            "failed to parse routing instruction state JSON {:?}: {}",
            filepath, e
        )
    })?;
    let payload = match parsed {
        Value::Object(mut obj) => obj.remove("state").unwrap_or(Value::Object(obj)),
        _ => {
            return Err(format!(
                "routing instruction state root must be object: {:?}",
                filepath
            ));
        }
    };
    deserialize_routing_instruction_state(&payload)
        .map(Some)
        .ok_or_else(|| {
            format!(
                "failed to deserialize routing instruction state payload: {:?}",
                filepath
            )
        })
}

pub(crate) fn persist_routing_instruction_state_strict(
    key: &str,
    state: Option<&RoutingInstructionState>,
) -> Result<(), String> {
    if !is_persistent_key(key) {
        return Err(format!(
            "routing instruction state key is not persistent: {}",
            key
        ));
    }
    let filepath = resolve_session_filepath(key).ok_or_else(|| {
        format!(
            "failed to resolve routing instruction state path for {}",
            key
        )
    })?;
    let should_clear = state.map(is_state_empty).unwrap_or(true);
    if should_clear {
        match fs::remove_file(&filepath) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => {
                return Err(format!(
                    "failed to remove routing instruction state {:?}: {}",
                    filepath, e
                ));
            }
        }
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
        fs::create_dir_all(dir).map_err(|e| {
            format!(
                "failed to create routing instruction state dir {:?}: {}",
                dir, e
            )
        })?;
    }
    let text = serde_json::to_string(&payload).map_err(|e| {
        format!(
            "failed to serialize routing instruction state {:?}: {}",
            filepath, e
        )
    })?;
    atomic_write_file(&filepath, &text).map_err(|e| {
        format!(
            "failed to write routing instruction state {:?}: {}",
            filepath, e
        )
    })
}

pub(crate) fn is_persistent_key(key: &str) -> bool {
    key.starts_with("session:") || key.starts_with("conversation:") || key.starts_with("tmux:")
}

pub(crate) fn should_save_sync(key: &str) -> bool {
    key.starts_with("session:") || key.starts_with("tmux:")
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

fn resolve_override_session_dir() -> Option<PathBuf> {
    match read_override_session_dir() {
        SessionDirOverride::Path(explicit) => return Some(explicit),
        SessionDirOverride::Disabled => return None,
        SessionDirOverride::Inherit => {}
    }
    None
}

fn resolve_session_dir() -> Option<PathBuf> {
    match read_override_session_dir() {
        SessionDirOverride::Path(explicit) => return Some(explicit),
        SessionDirOverride::Disabled => return None,
        SessionDirOverride::Inherit => {}
    }
    resolve_rcc_user_dir().map(|base| base.join("sessions"))
}

fn resolve_routing_state_dir(key: &str) -> Option<PathBuf> {
    if let Some(explicit) = resolve_override_session_dir() {
        return Some(explicit);
    }
    if key.starts_with("tmux:") {
        return resolve_rcc_user_dir().map(|base| base.join("sessions"));
    }
    resolve_rcc_user_dir().map(|base| base.join("state").join("routing"))
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
    let dir = resolve_routing_state_dir(key)?;
    let filename = key_to_filename(key)?;
    Some(dir.join(Path::new(&filename)))
}

fn resolve_global_request_counter_filepath() -> Option<PathBuf> {
    if let SessionDirOverride::Path(explicit) = read_override_session_dir() {
        return Some(explicit.join(Path::new(GLOBAL_REQUEST_COUNTER_FILENAME)));
    }
    resolve_rcc_user_dir().map(|base| {
        base.join("state")
            .join(Path::new(GLOBAL_REQUEST_COUNTER_FILENAME))
    })
}

pub(crate) fn load_global_request_counter() -> Result<GlobalRequestCounter, String> {
    let Some(filepath) = resolve_global_request_counter_filepath() else {
        return Err("failed to resolve global request counter path".to_string());
    };
    let raw = match fs::read_to_string(&filepath) {
        Ok(content) => content,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(GlobalRequestCounter::new());
        }
        Err(e) => {
            return Err(format!(
                "failed to read global request counter {:?}: {}",
                filepath, e
            ));
        }
    };
    if raw.trim().is_empty() {
        return Err(format!(
            "global request counter file is empty: {:?}",
            filepath
        ));
    }
    serde_json::from_str::<GlobalRequestCounter>(&raw).map_err(|e| {
        format!(
            "failed to parse global request counter {:?}: {}",
            filepath, e
        )
    })
}

pub(crate) fn persist_global_request_counter(counter: &GlobalRequestCounter) -> Result<(), String> {
    let Some(filepath) = resolve_global_request_counter_filepath() else {
        return Err("failed to resolve global request counter path".to_string());
    };
    if let Some(dir) = filepath.parent() {
        fs::create_dir_all(dir).map_err(|e| {
            format!(
                "failed to create global request counter dir {:?}: {}",
                dir, e
            )
        })?;
    }
    let text = serde_json::to_string(counter).map_err(|e| {
        format!(
            "failed to serialize global request counter {:?}: {}",
            filepath, e
        )
    })?;
    atomic_write_file(&filepath, &text).map_err(|e| {
        format!(
            "failed to write global request counter {:?}: {}",
            filepath, e
        )
    })
}

fn atomic_write_file(filepath: &Path, content: &str) -> std::io::Result<()> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let filename = filepath
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("routing-state");
    let tmp = filepath.with_file_name(format!("{}.tmp-{}-{}", filename, std::process::id(), now));
    fs::write(&tmp, content)?;
    match fs::rename(&tmp, filepath) {
        Ok(()) => Ok(()),
        Err(first) => {
            let _ = fs::remove_file(filepath);
            match fs::rename(&tmp, filepath) {
                Ok(()) => Ok(()),
                Err(second) => {
                    let _ = fs::remove_file(&tmp);
                    Err(std::io::Error::new(
                        second.kind(),
                        format!("rename failed: {}; retry failed: {}", first, second),
                    ))
                }
            }
        }
    }
}

pub(crate) fn is_state_empty(state: &RoutingInstructionState) -> bool {
    state.forced_target.is_none()
        && state.prefer_target.is_none()
        && state.allowed_providers.is_empty()
        && state.disabled_providers.is_empty()
        && state.disabled_keys.is_empty()
        && state.disabled_models.is_empty()
        && is_stop_message_empty(state)
        && is_pre_command_empty(state)
        && is_chat_process_usage_empty(state)
}

fn is_stop_message_empty(state: &RoutingInstructionState) -> bool {
    state.stop_message_state.stop_message_source.is_none()
        && state.stop_message_state.stop_message_text.is_none()
        && state.stop_message_state.stop_message_max_repeats.is_none()
        && state.stop_message_state.stop_message_used.is_none()
        && state.stop_message_state.stop_message_provider_key.is_none()
        && state.stop_message_state.stop_message_last_used_at.is_none()
        && state.stop_message_state.stop_message_stage_mode.is_none()
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

fn is_chat_process_usage_empty(state: &RoutingInstructionState) -> bool {
    state.chat_process_last_total_tokens.is_none()
        && state.chat_process_last_input_tokens.is_none()
        && state.chat_process_last_message_count.is_none()
        && state.chat_process_last_updated_at.is_none()
}

pub(crate) fn serialize_routing_instruction_state(state: &RoutingInstructionState) -> Value {
    let mut out = Map::new();
    if let Some(target) = &state.forced_target {
        out.insert(
            "forcedTarget".to_string(),
            serialize_instruction_target(target),
        );
    }
    if let Some(target) = &state.prefer_target {
        out.insert(
            "preferTarget".to_string(),
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
    serialize_chat_process_usage_state(state, &mut out);
    Value::Object(out)
}

pub(crate) fn merge_stop_message_from_persisted(
    existing: &RoutingInstructionState,
    persisted: Option<&RoutingInstructionState>,
) -> RoutingInstructionState {
    let Some(persisted) = persisted else {
        return existing.clone();
    };
    let mut out = existing.clone();
    let existing_updated_at = existing.stop_message_state.stop_message_updated_at;
    let persisted_updated_at = persisted.stop_message_state.stop_message_updated_at;
    let existing_is_newer = existing_updated_at
        .map(|existing_at| {
            persisted_updated_at
                .map(|persisted_at| persisted_at < existing_at)
                .unwrap_or(true)
        })
        .unwrap_or(false);

    if existing_is_newer {
        let existing_used = existing.stop_message_state.stop_message_used.unwrap_or(0);
        let persisted_used = persisted.stop_message_state.stop_message_used.unwrap_or(0);
        let persisted_has_usage_progress = persisted_used > existing_used
            && existing
                .stop_message_state
                .stop_message_last_used_at
                .map(|existing_last| {
                    persisted
                        .stop_message_state
                        .stop_message_last_used_at
                        .map(|persisted_last| persisted_last >= existing_last)
                        .unwrap_or(false)
                })
                .unwrap_or(true);
        if persisted_has_usage_progress && same_stop_message_config(existing, persisted) {
            out.stop_message_state.stop_message_used =
                persisted.stop_message_state.stop_message_used;
            out.stop_message_state.stop_message_last_used_at =
                persisted.stop_message_state.stop_message_last_used_at;
            out.stop_message_state.stop_message_ai_seed_prompt = persisted
                .stop_message_state
                .stop_message_ai_seed_prompt
                .clone();
            out.stop_message_state.stop_message_ai_history =
                persisted.stop_message_state.stop_message_ai_history.clone();
        }
        return out;
    }

    out.stop_message_state = persisted.stop_message_state.clone();
    out
}

fn same_stop_message_config(
    existing: &RoutingInstructionState,
    persisted: &RoutingInstructionState,
) -> bool {
    normalize_text(existing.stop_message_state.stop_message_text.as_deref())
        == normalize_text(persisted.stop_message_state.stop_message_text.as_deref())
        && normalize_text(
            existing
                .stop_message_state
                .stop_message_provider_key
                .as_deref(),
        ) == normalize_text(
            persisted
                .stop_message_state
                .stop_message_provider_key
                .as_deref(),
        )
        && existing.stop_message_state.stop_message_max_repeats
            == persisted.stop_message_state.stop_message_max_repeats
        && normalize_text(
            existing
                .stop_message_state
                .stop_message_stage_mode
                .as_deref(),
        ) == normalize_text(
            persisted
                .stop_message_state
                .stop_message_stage_mode
                .as_deref(),
        )
}

fn normalize_text(value: Option<&str>) -> String {
    value.unwrap_or("").trim().to_string()
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
    if let Some(value) = &state.stop_message_provider_key {
        out.insert(
            "stopMessageProviderKey".to_string(),
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

fn serialize_chat_process_usage_state(
    state: &RoutingInstructionState,
    out: &mut Map<String, Value>,
) {
    if let Some(value) = state.chat_process_last_total_tokens {
        out.insert(
            "chatProcessLastTotalTokens".to_string(),
            Value::Number(value.max(0).into()),
        );
    }
    if let Some(value) = state.chat_process_last_input_tokens {
        out.insert(
            "chatProcessLastInputTokens".to_string(),
            Value::Number(value.max(0).into()),
        );
    }
    if let Some(value) = state.chat_process_last_message_count {
        out.insert(
            "chatProcessLastMessageCount".to_string(),
            Value::Number(value.max(0).into()),
        );
    }
    if let Some(value) = state.chat_process_last_updated_at {
        out.insert(
            "chatProcessLastUpdatedAt".to_string(),
            Value::Number(value.max(0).into()),
        );
    }
}

pub(crate) fn deserialize_routing_instruction_state(
    value: &Value,
) -> Option<RoutingInstructionState> {
    let obj = value.as_object()?;
    let mut state = RoutingInstructionState::default();
    if let Some(target) = obj.get("forcedTarget") {
        state.forced_target = deserialize_instruction_target(target);
    }
    if let Some(target) = obj.get("preferTarget") {
        state.prefer_target = deserialize_instruction_target(target);
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
                    } else if let Some(num) = key.as_i64() {
                        set.insert(num.to_string());
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
    deserialize_chat_process_usage_state(obj, &mut state);
    Some(state)
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
    state.stop_message_state.stop_message_provider_key = obj
        .get("stopMessageProviderKey")
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

fn deserialize_chat_process_usage_state(
    obj: &Map<String, Value>,
    state: &mut RoutingInstructionState,
) {
    state.chat_process_last_total_tokens = obj
        .get("chatProcessLastTotalTokens")
        .and_then(|v| v.as_i64())
        .map(|v| v.max(0));
    state.chat_process_last_input_tokens = obj
        .get("chatProcessLastInputTokens")
        .and_then(|v| v.as_i64())
        .map(|v| v.max(0));
    state.chat_process_last_message_count = obj
        .get("chatProcessLastMessageCount")
        .and_then(|v| v.as_i64())
        .map(|v| v.max(0));
    state.chat_process_last_updated_at = obj
        .get("chatProcessLastUpdatedAt")
        .and_then(|v| v.as_i64())
        .map(|v| v.max(0));
}

// ============================================================
// Port isolation red tests — lock down isolation properties
// ============================================================

#[cfg(test)]
mod isolation_tests {
    use super::*;
    use serde_json::json;
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
}

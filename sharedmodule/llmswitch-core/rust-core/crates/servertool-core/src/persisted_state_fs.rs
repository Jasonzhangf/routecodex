//! Minimal `routing_state_store`-shaped reader for the stopless CLI binary.
//!
//! The servertool-core crate has no dependency on the router-hotpath crate, so
//! we cannot call into `virtual_router_engine::routing_state_store` directly.
//! Instead, this module mirrors the file layout that the host side uses to
//! persist `RoutingInstructionState`:
//!
//!   * scope is `session:` / `tmux:` / `conversation:`
//!   * directory resolution prefers the explicit `session_dir` passed by the
//!     caller; if omitted, it falls back to `~/.rcc/state/routing`
//!     (`tmux:` keys live under `~/.rcc/sessions` to match the host).
//!   * filename is `<scope>-<safe_id>.json` where unsafe characters in the id
//!     are replaced with `_`.
//!   * file body is `{"version": 1, "state": { ...routing instruction... }}`.
//!
//! The CLI binary already writes through the same path on the host side
//! (see `save_routing_instruction_state_json` in router-hotpath-napi). Reading
//! here keeps the CLI self-contained without dragging in the full router
//! hotpath crate.
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::persisted_lookup::{
    self,
    RuntimeStopMessageStateSnapshot,
};

const RCC_HOME_ENV: &str = "RCC_HOME";
const ROUTECODEX_USER_DIR_ENV: &str = "ROUTECODEX_USER_DIR";
const ROUTECODEX_HOME_ENV: &str = "ROUTECODEX_HOME";

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

fn resolve_state_dir(scope: &str, session_dir: Option<&str>) -> Option<PathBuf> {
    if let Some(explicit) = session_dir
        .map(str::trim)
        .filter(|trimmed| !trimmed.is_empty())
        .map(PathBuf::from)
    {
        return Some(explicit);
    }
    if scope.starts_with("tmux:") {
        return resolve_rcc_user_dir().map(|base| base.join("sessions"));
    }
    resolve_rcc_user_dir().map(|base| base.join("state").join("routing"))
}

fn safe_id(raw_id: &str) -> Option<String> {
    if raw_id.is_empty() {
        return None;
    }
    let safe: String = raw_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '.' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if safe.is_empty() {
        None
    } else {
        Some(safe)
    }
}

fn resolve_filepath(scope: &str, raw_id: &str, session_dir: Option<&str>) -> Option<PathBuf> {
    let dir = resolve_state_dir(scope, session_dir)?;
    let safe = safe_id(raw_id)?;
    let scope_label = scope.trim_end_matches(':');
    Some(dir.join(format!("{}-{}.json", scope_label, safe)))
}

pub fn resolve_filepath_for_write(
    scope: &str,
    raw_id: &str,
    session_dir: Option<&str>,
) -> Option<PathBuf> {
    resolve_filepath(scope, raw_id, session_dir)
}

fn is_persistent_key(key: &str) -> bool {
    key.starts_with("session:")
        || key.starts_with("conversation:")
        || key.starts_with("tmux:")
}

/// Look up the persisted routing-instruction snapshot for a `session:<id>` key
/// from the on-disk state file written by the host bridge. Returns `None` if
/// the file is missing or the snapshot is empty.
pub fn load_persisted_runtime_stop_message_state(
    session_id: &str,
    session_dir: Option<&str>,
) -> Option<RuntimeStopMessageStateSnapshot> {
    let key = format!("session:{}", session_id.trim());
    if !is_persistent_key(&key) {
        return None;
    }
    let (_scope, raw_id) = key.split_once(':')?;
    let filepath = resolve_filepath("session:", raw_id, session_dir)?;
    let raw = match fs::read_to_string(&filepath) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            eprintln!(
                "[servertool_core::persisted_state_fs] Failed to read state file {:?}: {}",
                filepath, error
            );
            return None;
        }
    };
    if raw.trim().is_empty() {
        return None;
    }
    let parsed: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(error) => {
            eprintln!(
                "[servertool_core::persisted_state_fs] Failed to parse JSON from {:?}: {}",
                filepath, error
            );
            return None;
        }
    };
    let state_value = match parsed {
        Value::Object(mut obj) => obj.remove("state").unwrap_or(Value::Object(obj)),
        _ => return None,
    };
    // Reuse the same parser used by the rest of the persisted_lookup module so
    // the snapshot fields (text, used, max_repeats, stage_mode, ...) stay in
    // lockstep with the host writer.
    let runtime = serde_json::json!({ "stopMessageState": state_value });
    let adapter_context = serde_json::json!({ "sessionId": session_id });
   let input = persisted_lookup::RuntimeStopMessageStateFromAdapterContextInput {
       adapter_context,
       runtime_metadata: Some(runtime),
   };
   persisted_lookup::resolve_runtime_stop_message_state_from_adapter_context(&input)
}

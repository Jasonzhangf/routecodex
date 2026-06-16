//! Synchronous writer for `session:<sessionId>`-keyed stop-message persisted
//! state. Used by the servertool-cli binary to write back the next-used value
//! after a stopless continuation run. Mirrors the host-side envelope written
//! by `save_routing_instruction_state_json` in router-hotpath-napi so the
//! loader in `persisted_state_fs::load_persisted_runtime_stop_message_state`
//! can read the same on-disk shape.
use std::fs;
use std::path::PathBuf;

use serde_json::Value;

use crate::persisted_lookup::StoplessContinuationPersistOutput;
use crate::persisted_state_fs::resolve_filepath_for_write;

/// Atomically persist a `StoplessContinuationPersistOutput` under the
/// `session:<sessionId>` key. Returns the resolved on-disk filepath on success.
///
/// The stopless CLI binary owns this write and always emits the same
/// `{"version":1,"state":{...}}` envelope that the session reader consumes.
pub fn save_persisted_runtime_stop_message_state(
    session_id: &str,
    payload: &StoplessContinuationPersistOutput,
) -> Result<PathBuf, String> {
    let session_id_trim = session_id.trim();
    if session_id_trim.is_empty() {
        return Err(
            "save_persisted_runtime_stop_message_state: session_id is required".to_string(),
        );
    }
    if !session_id_trim
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-' | '.'))
    {
        return Err(
            "save_persisted_runtime_stop_message_state: session_id contains invalid characters"
                .to_string(),
        );
    }
    let key = format!("session:{session_id_trim}");
    let (scope, raw_id) = key.split_once(':').ok_or_else(|| {
        "save_persisted_runtime_stop_message_state: invalid key shape".to_string()
    })?;
    let filepath = resolve_filepath_for_write(scope, raw_id).ok_or_else(|| {
        "save_persisted_runtime_stop_message_state: cannot resolve filepath".to_string()
    })?;
    if let Some(parent) = filepath.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "save_persisted_runtime_stop_message_state: cannot create dir {:?}: {}",
                parent, error
            )
        })?;
    }
    let envelope = match &payload.state {
        Value::Null => serde_json::json!({ "version": 1, "state": Value::Null }),
        state => serde_json::json!({ "version": 1, "state": state }),
    };
    let serialized = serde_json::to_string_pretty(&envelope).map_err(|error| {
        format!(
            "save_persisted_runtime_stop_message_state: serialize: {}",
            error
        )
    })?;
    let tmp_path = filepath.with_extension("json.tmp");
    fs::write(&tmp_path, serialized).map_err(|error| {
        format!(
            "save_persisted_runtime_stop_message_state: write tmp {:?}: {}",
            tmp_path, error
        )
    })?;
    fs::rename(&tmp_path, &filepath).map_err(|error| {
        format!(
            "save_persisted_runtime_stop_message_state: rename tmp {:?} -> {:?}: {}",
            tmp_path, filepath, error
        )
    })?;
    Ok(filepath)
}

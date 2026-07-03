use crate::shared_json_utils::read_trimmed_string;
use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use regex::Regex;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::OnceLock;
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const DEFAULT_SNAPSHOT_QUEUE_CAPACITY: usize = 10;
const DEFAULT_SNAPSHOT_KEEP_RECENT_FILES: usize = 10;
const DEFAULT_SNAPSHOT_KEEP_RECENT_REQUEST_DIRS: usize = 50;
const DEFAULT_ERRORSAMPLE_KEEP_RECENT_FILES: usize = 50;
const SNAPSHOT_DROP_LOG_THROTTLE_MS: i64 = 5_000;
const PAYLOAD_CONTRACT_ERRORSAMPLE_STAGE_PREFIX: &str = "errorsample.payload_contract_error.";
const SNAPSHOT_PROVIDER_REQUEST_BODY_DISABLED: &str =
    "[hub_snapshot_hooks] provider-request body snapshots are disabled";

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SnapshotHookOptions {
    endpoint: String,
    stage: String,
    request_id: String,
    data: Value,
    verbosity: Option<String>,
    channel: Option<String>,
    provider_key: Option<String>,
    group_request_id: Option<String>,
    entry_protocol: Option<String>,
    entry_port: Option<i64>,
    runtime_metadata: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotRecorderWriteOptionsInput {
    endpoint: String,
    stage: String,
    request_id: String,
    data: Value,
    provider_key: Option<String>,
    context: Option<Value>,
    metadata_center_snapshot: Option<Value>,
}

static SNAPSHOT_WRITER_RUNTIME: OnceLock<Option<SnapshotWriterRuntime>> = OnceLock::new();
static SNAPSHOT_DROPPED_JOBS: AtomicU64 = AtomicU64::new(0);
static SNAPSHOT_LAST_DROP_LOG_AT_MS: AtomicI64 = AtomicI64::new(0);

#[derive(Clone)]
struct SnapshotWriterRuntime {
    sender: SyncSender<SnapshotHookOptions>,
}

fn resolve_snapshot_async_enabled() -> bool {
    let raw = env::var("ROUTECODEX_SNAPSHOT_ASYNC")
        .ok()
        .or_else(|| env::var("RCC_SNAPSHOT_ASYNC").ok());
    resolve_bool_from_env(raw, true)
}

fn resolve_snapshot_queue_capacity() -> usize {
    let raw = env::var("ROUTECODEX_SNAPSHOT_QUEUE_CAPACITY")
        .ok()
        .or_else(|| env::var("RCC_SNAPSHOT_QUEUE_CAPACITY").ok());
    let parsed = raw
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0);
    parsed.unwrap_or(DEFAULT_SNAPSHOT_QUEUE_CAPACITY)
}

fn resolve_snapshot_keep_recent_files() -> usize {
    let raw = env::var("ROUTECODEX_SNAPSHOT_KEEP_RECENT_FILES")
        .ok()
        .or_else(|| env::var("RCC_SNAPSHOT_KEEP_RECENT_FILES").ok());
    let parsed = raw
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0);
    parsed.unwrap_or(DEFAULT_SNAPSHOT_KEEP_RECENT_FILES)
}

fn resolve_snapshot_keep_recent_request_dirs() -> usize {
    let raw = env::var("ROUTECODEX_SNAPSHOT_KEEP_RECENT_REQUEST_DIRS")
        .ok()
        .or_else(|| env::var("RCC_SNAPSHOT_KEEP_RECENT_REQUEST_DIRS").ok());
    let parsed = raw
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0);
    parsed.unwrap_or(DEFAULT_SNAPSHOT_KEEP_RECENT_REQUEST_DIRS)
}

fn resolve_errorsample_keep_recent_files() -> usize {
    let raw = env::var("ROUTECODEX_ERRORSAMPLE_MAX_FILES_PER_GROUP")
        .ok()
        .or_else(|| env::var("RCC_ERRORSAMPLE_MAX_FILES_PER_GROUP").ok());
    let parsed = raw
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0);
    parsed.unwrap_or(DEFAULT_ERRORSAMPLE_KEEP_RECENT_FILES)
}

fn snapshot_writer_loop(receiver: Receiver<SnapshotHookOptions>) {
    while let Ok(options) = receiver.recv() {
        write_snapshot_via_hooks_sync(options);
    }
}

fn snapshot_writer_runtime() -> Option<&'static SnapshotWriterRuntime> {
    SNAPSHOT_WRITER_RUNTIME
        .get_or_init(|| {
            if !resolve_snapshot_async_enabled() {
                return None;
            }
            let capacity = resolve_snapshot_queue_capacity();
            let (sender, receiver) = sync_channel::<SnapshotHookOptions>(capacity);
            match thread::Builder::new()
                .name("rcc-snapshot-writer".to_string())
                .spawn(move || snapshot_writer_loop(receiver))
            {
                Ok(_handle) => Some(SnapshotWriterRuntime { sender }),
                Err(error) => {
                    eprintln!(
                        "[hub_snapshot_hooks] Failed to start snapshot writer thread (capacity={}): {}",
                        capacity, error
                    );
                    None
                }
            }
        })
        .as_ref()
}

fn maybe_log_snapshot_drop(stage: &str, request_id: &str, reason: &str) {
    let dropped = SNAPSHOT_DROPPED_JOBS.fetch_add(1, Ordering::Relaxed) + 1;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let mut observed = SNAPSHOT_LAST_DROP_LOG_AT_MS.load(Ordering::Relaxed);
    loop {
        if now_ms - observed < SNAPSHOT_DROP_LOG_THROTTLE_MS {
            return;
        }
        match SNAPSHOT_LAST_DROP_LOG_AT_MS.compare_exchange(
            observed,
            now_ms,
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => break,
            Err(current) => observed = current,
        }
    }
    eprintln!(
        "[hub_snapshot_hooks] snapshot enqueue dropped total={} stage={} requestId={} reason={}",
        dropped, stage, request_id, reason
    );
}

fn enqueue_snapshot_job(options: SnapshotHookOptions) {
    if let Some(runtime) = snapshot_writer_runtime() {
        match runtime.sender.try_send(options.clone()) {
            Ok(()) => return,
            Err(TrySendError::Full(_)) => {
                maybe_log_snapshot_drop(
                    options.stage.as_str(),
                    options.request_id.as_str(),
                    "queue_full",
                );
                return;
            }
            Err(TrySendError::Disconnected(_)) => {
                maybe_log_snapshot_drop(
                    options.stage.as_str(),
                    options.request_id.as_str(),
                    "writer_disconnected",
                );
                return;
            }
        }
    }
    write_snapshot_via_hooks_sync(options);
}

fn resolve_home_dir() -> PathBuf {
    if let Ok(v) = env::var("HOME") {
        if !v.trim().is_empty() {
            return PathBuf::from(v);
        }
    }
    PathBuf::from(".")
}

fn expand_home(value: &str, home_dir: &Path) -> PathBuf {
    if let Some(stripped) = value.strip_prefix("~/") {
        return home_dir.join(stripped);
    }
    PathBuf::from(value)
}

fn resolve_user_dir() -> PathBuf {
    let home_dir = resolve_home_dir();
    let legacy_dir = home_dir.join(".routecodex");
    for key in ["RCC_HOME", "ROUTECODEX_USER_DIR", "ROUTECODEX_HOME"] {
        if let Ok(v) = env::var(key) {
            let trimmed = v.trim();
            if !trimmed.is_empty() {
                let candidate = expand_home(trimmed, &home_dir);
                if candidate == legacy_dir {
                    continue;
                }
                return candidate;
            }
        }
    }
    home_dir.join(".rcc")
}

fn resolve_snapshot_root() -> PathBuf {
    let home_dir = resolve_home_dir();
    let legacy_snapshot_dir = home_dir.join(".routecodex").join("codex-samples");
    for key in ["RCC_SNAPSHOT_DIR", "ROUTECODEX_SNAPSHOT_DIR"] {
        if let Ok(v) = env::var(key) {
            let trimmed = v.trim();
            if !trimmed.is_empty() {
                let candidate = expand_home(trimmed, &home_dir);
                if candidate == legacy_snapshot_dir {
                    continue;
                }
                return candidate;
            }
        }
    }
    resolve_user_dir().join("codex-samples")
}

fn resolve_errorsamples_root() -> PathBuf {
    if let Ok(v) = env::var("ROUTECODEX_ERRORSAMPLES_DIR") {
        if !v.trim().is_empty() {
            return PathBuf::from(v.trim());
        }
    }
    if let Ok(v) = env::var("ROUTECODEX_ERROR_SAMPLES_DIR") {
        if !v.trim().is_empty() {
            return PathBuf::from(v.trim());
        }
    }
    resolve_user_dir().join("errorsamples")
}

fn safe_errorsample_name(name: &str) -> String {
    let re = Regex::new(r"[^\w.-]").unwrap();
    re.replace_all(name, "_").to_string()
}

fn resolve_snapshot_folder(endpoint: &str) -> String {
    let lowered = endpoint.trim().to_lowercase();
    if lowered.contains("/v1/responses") || lowered.contains("/responses.submit") {
        return "openai-responses".to_string();
    }
    if lowered.contains("/v1/messages") {
        return "anthropic-messages".to_string();
    }
    "openai-chat".to_string()
}

fn read_metadata_center_request_truth(snapshot: Option<&Value>) -> Option<&Map<String, Value>> {
    snapshot?
        .as_object()?
        .get("requestTruth")?
        .as_object()
}

fn resolve_snapshot_recorder_entry_port(snapshot: Option<&Value>) -> Option<i64> {
    let request_truth = read_metadata_center_request_truth(snapshot)?;
    request_truth.get("portScope").and_then(read_port_value)
}

fn resolve_snapshot_recorder_group_request_id(context: Option<&Value>) -> Option<String> {
    let row = context?.as_object()?;
    read_trimmed_string(row.get("clientRequestId"))
        .or_else(|| read_trimmed_string(row.get("groupRequestId")))
}

fn resolve_snapshot_recorder_runtime_metadata(context: Option<Value>) -> Option<Value> {
    context?
        .as_object()
        .and_then(|row| row.get("metadata"))
        .filter(|value| value.is_object())
        .cloned()
}

fn resolve_entry_protocol(options: &SnapshotHookOptions, data: &Value) -> String {
    if let Some(protocol) = options.entry_protocol.as_ref() {
        let token = sanitize_token(protocol, "");
        if !token.is_empty() {
            return token;
        }
    }
    let entry = extract_nested_entry_endpoint(data).unwrap_or_else(|| options.endpoint.clone());
    resolve_snapshot_folder(entry.as_str())
}

fn read_port_value(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str()?.trim().parse::<i64>().ok())
        .filter(|port| *port > 0)
}

fn extract_nested_entry_port(value: &Value) -> Option<i64> {
    fn search(value: &Value, depth: usize) -> Option<i64> {
        if depth > 8 {
            return None;
        }
        match value {
            Value::Object(obj) => {
                for key in ["entryPort", "matchedPort", "localPort"] {
                    if let Some(port) = obj.get(key).and_then(read_port_value) {
                        return Some(port);
                    }
                }
                for nested in obj.values() {
                    if let Some(port) = search(nested, depth + 1) {
                        return Some(port);
                    }
                }
                None
            }
            Value::Array(items) => items.iter().find_map(|nested| search(nested, depth + 1)),
            _ => None,
        }
    }
    search(value, 0)
}

fn resolve_entry_port(options: &SnapshotHookOptions, data: &Value) -> Option<i64> {
    options
        .entry_port
        .filter(|value| *value > 0)
        .or_else(|| extract_nested_entry_port(data))
}

fn requires_port_scoped_snapshot_dir(stage: &str) -> bool {
    stage.starts_with("client-") || stage.starts_with("provider-")
}

fn is_disabled_provider_request_body_snapshot(stage: &str) -> bool {
    stage == "provider-request"
}

fn sanitize_token(value: &str, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return fallback.to_string();
    }
    let re = Regex::new(r"[^A-Za-z0-9_.-]").unwrap();
    let sanitized = re.replace_all(trimmed, "_").to_string();
    if sanitized.trim().is_empty() {
        fallback.to_string()
    } else {
        sanitized
    }
}

fn channel_suffix(channel: &Option<String>) -> String {
    if let Some(ch) = channel {
        let token = sanitize_token(ch, "");
        if token.is_empty() {
            return String::new();
        }
        return format!("_{}", token);
    }
    String::new()
}

fn extract_nested_group_request_id(value: &Value) -> Option<String> {
    if let Value::Object(obj) = value {
        if let Some(k) = read_trimmed_string(obj.get("clientRequestId"))
            .or_else(|| read_trimmed_string(obj.get("groupRequestId")))
        {
            return Some(k);
        }
        if let Some(Value::Object(meta)) = obj.get("meta") {
            if let Some(k) = read_trimmed_string(meta.get("clientRequestId"))
                .or_else(|| read_trimmed_string(meta.get("groupRequestId")))
            {
                return Some(k);
            }
            if let Some(Value::Object(ctx)) = meta.get("context") {
                if let Some(k) = read_trimmed_string(ctx.get("clientRequestId"))
                    .or_else(|| read_trimmed_string(ctx.get("groupRequestId")))
                {
                    return Some(k);
                }
            }
        }
    }
    None
}

fn extract_nested_entry_endpoint(value: &Value) -> Option<String> {
    if let Value::Object(obj) = value {
        if let Some(k) = read_trimmed_string(obj.get("entryEndpoint"))
            .or_else(|| read_trimmed_string(obj.get("entry_endpoint")))
        {
            return Some(k);
        }
        if let Some(Value::Object(meta)) = obj.get("meta") {
            if let Some(k) = read_trimmed_string(meta.get("entryEndpoint"))
                .or_else(|| read_trimmed_string(meta.get("entry_endpoint")))
            {
                return Some(k);
            }
            if let Some(Value::Object(ctx)) = meta.get("context") {
                if let Some(k) = read_trimmed_string(ctx.get("entryEndpoint"))
                    .or_else(|| read_trimmed_string(ctx.get("entry_endpoint")))
                {
                    return Some(k);
                }
            }
        }
        if let Some(Value::Object(metadata)) = obj.get("metadata") {
            if let Some(k) = read_trimmed_string(metadata.get("entryEndpoint"))
                .or_else(|| read_trimmed_string(metadata.get("entry_endpoint")))
            {
                return Some(k);
            }
        }
        if let Some(Value::Object(runtime)) = obj.get("runtime") {
            if let Some(k) = read_trimmed_string(runtime.get("entryEndpoint"))
                .or_else(|| read_trimmed_string(runtime.get("entry_endpoint")))
            {
                return Some(k);
            }
        }
    }
    None
}

fn normalize_provider_key(provider_key: &Option<String>) -> Option<String> {
    let mut obj = Map::new();
    if let Some(value) = provider_key {
        obj.insert("providerKey".to_string(), Value::String(value.clone()));
    }
    read_trimmed_string(obj.get("providerKey"))
}

fn is_hub_policy_stage(stage: &str) -> bool {
    stage.starts_with("hub_policy.")
}

fn is_hub_tool_surface_stage(stage: &str) -> bool {
    stage.starts_with("hub_toolsurface.")
}

fn read_number_field(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(|v| v.as_f64())
}

fn has_policy_violations(value: &Value) -> bool {
    if let Value::Object(obj) = value {
        if let Some(Value::Array(arr)) = obj.get("violations") {
            if !arr.is_empty() {
                return true;
            }
        }
        if let Some(Value::Object(summary)) = obj.get("summary") {
            if let Some(total) = summary.get("totalViolations").and_then(|v| v.as_f64()) {
                if total > 0.0 {
                    return true;
                }
            }
        }
    }
    false
}

fn has_tool_surface_diff(value: &Value) -> bool {
    if let Value::Object(obj) = value {
        if let Some(diff) = read_number_field(value, "diffCount") {
            if diff > 0.0 {
                return true;
            }
        }
        let expected = read_trimmed_string(obj.get("expectedProtocol"));
        let detected = read_trimmed_string(obj.get("detectedProtocol"));
        if let (Some(e), Some(d)) = (expected, detected) {
            if e != d {
                return true;
            }
        }
    }
    false
}

fn has_policy_enforcement_changes(value: &Value) -> bool {
    if let Value::Object(obj) = value {
        if let Some(Value::Array(arr)) = obj.get("removedTopLevelKeys") {
            if !arr.is_empty() {
                return true;
            }
        }
        if let Some(Value::Array(arr)) = obj.get("flattenedWrappers") {
            if !arr.is_empty() {
                return true;
            }
        }
    }
    false
}

fn cleanup_zero_byte_json_files(dir: &Path) {
    let entries = match fs::read_dir(dir) {
        Ok(v) => v,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        if let Ok(meta) = fs::metadata(&path) {
            if meta.is_file() && meta.len() == 0 {
                if let Err(e) = fs::remove_file(&path) {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        eprintln!(
                            "[hub_snapshot_hooks] Failed to remove zero-byte file {:?}: {}",
                            path, e
                        );
                    }
                }
            }
        }
    }
}

fn write_unique_errorsample_file(
    dir: &Path,
    base_name: &str,
    contents: &str,
) -> Result<(), std::io::Error> {
    let parsed = Path::new(base_name);
    let stem = parsed
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("sample");
    let ext = parsed
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("json");
    let tmp_dir = dir.join("_tmp");
    if let Err(e) = fs::create_dir_all(&tmp_dir) {
        eprintln!(
            "[hub_snapshot_hooks] Failed to create tmp directory {:?}: {}",
            tmp_dir, e
        );
    }
    for _ in 0..32 {
        let suffix = format!(
            "{}_{}",
            chrono::Utc::now().timestamp_millis(),
            Uuid::new_v4()
                .simple()
                .to_string()
                .get(0..6)
                .unwrap_or("rand")
        );
        let file_name = format!("{}_{}.{}", stem, suffix, ext);
        let dest = dir.join(&file_name);
        let tmp = tmp_dir.join(format!("{}.tmp", file_name));
        if let Ok(mut f) = OpenOptions::new().write(true).create_new(true).open(&tmp) {
            f.write_all(contents.as_bytes())?;
            if let Err(e) = fs::rename(&tmp, &dest) {
                eprintln!(
                    "[hub_snapshot_hooks] Failed to rename tmp file to {:?}: {}",
                    dest, e
                );
                let _ = fs::remove_file(&tmp);
            }
            return Ok(());
        }
    }
    let fallback = format!(
        "{}_{}_{}.{}",
        stem,
        chrono::Utc::now().timestamp_millis(),
        Uuid::new_v4()
            .simple()
            .to_string()
            .get(0..6)
            .unwrap_or("rand"),
        ext
    );
    let dest = dir.join(fallback);
    let mut f = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(dest)?;
    f.write_all(contents.as_bytes())?;
    Ok(())
}

fn write_unique_file(dir: &Path, base_name: &str, contents: &str) -> Result<(), std::io::Error> {
    let parsed = Path::new(base_name);
    let stem = parsed
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("snapshot");
    let ext = parsed
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("json");
    for i in 0..64 {
        let name = if i == 0 {
            format!("{}.{}", stem, ext)
        } else {
            format!("{}_{}.{}", stem, i, ext)
        };
        let dest = dir.join(&name);
        if let Ok(mut f) = OpenOptions::new().write(true).create_new(true).open(&dest) {
            f.write_all(contents.as_bytes())?;
            return Ok(());
        }
    }
    let fallback = format!(
        "{}_{}_{}.{}",
        stem,
        chrono::Utc::now().timestamp_millis(),
        Uuid::new_v4()
            .simple()
            .to_string()
            .get(0..6)
            .unwrap_or("rand"),
        ext
    );
    let dest = dir.join(fallback);
    let mut f = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(dest)?;
    f.write_all(contents.as_bytes())?;
    Ok(())
}

fn write_json_file_if_missing_atomic(target: &Path, contents: &str) -> Result<(), std::io::Error> {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("__runtime.json");
    for _ in 0..16 {
        let tmp_name = format!(
            ".{}.tmp-{}-{}",
            file_name,
            chrono::Utc::now().timestamp_millis(),
            Uuid::new_v4()
                .simple()
                .to_string()
                .get(0..6)
                .unwrap_or("rand")
        );
        let tmp_path = parent.join(tmp_name);
        let mut tmp_file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };

        let write_result = (|| -> Result<(), std::io::Error> {
            tmp_file.write_all(contents.as_bytes())?;
            tmp_file.sync_all()?;
            drop(tmp_file);
            match fs::hard_link(&tmp_path, target) {
                Ok(_) => {
                    let _ = fs::remove_file(&tmp_path);
                    Ok(())
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let _ = fs::remove_file(&tmp_path);
                    Ok(())
                }
                Err(error) => {
                    let _ = fs::remove_file(&tmp_path);
                    Err(error)
                }
            }
        })();

        if write_result.is_ok() {
            return Ok(());
        }
        return write_result;
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "unable to allocate temporary runtime metadata file",
    ))
}

fn merge_json_objects_missing_and_non_null(
    existing: &mut Map<String, Value>,
    incoming: &Map<String, Value>,
) {
    for (key, incoming_value) in incoming {
        match existing.get_mut(key) {
            Some(existing_value) => match (existing_value, incoming_value) {
                (Value::Object(existing_obj), Value::Object(incoming_obj)) => {
                    merge_json_objects_missing_and_non_null(existing_obj, incoming_obj);
                }
                (Value::Null, value) if !value.is_null() => {
                    *existing.get_mut(key).expect("existing key present") = value.clone();
                }
                _ => {}
            },
            None => {
                if !incoming_value.is_null() {
                    existing.insert(key.clone(), incoming_value.clone());
                }
            }
        }
    }
}

fn write_json_file_atomic_replace(target: &Path, contents: &str) -> Result<(), std::io::Error> {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("__runtime.json");
    for _ in 0..16 {
        let tmp_name = format!(
            ".{}.tmp-{}-{}",
            file_name,
            chrono::Utc::now().timestamp_millis(),
            Uuid::new_v4()
                .simple()
                .to_string()
                .get(0..6)
                .unwrap_or("rand")
        );
        let tmp_path = parent.join(tmp_name);
        let mut tmp_file = match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };

        let write_result = (|| -> Result<(), std::io::Error> {
            tmp_file.write_all(contents.as_bytes())?;
            tmp_file.sync_all()?;
            drop(tmp_file);
            fs::rename(&tmp_path, target)?;
            Ok(())
        })();

        if write_result.is_ok() {
            return Ok(());
        }
        let _ = fs::remove_file(&tmp_path);
        return write_result;
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "unable to allocate temporary runtime metadata replace file",
    ))
}

fn upsert_runtime_metadata_file(target: &Path, payload: &Value) -> Result<(), std::io::Error> {
    let payload_str = serde_json::to_string_pretty(payload)?;
    if !target.exists() {
        return write_json_file_if_missing_atomic(target, payload_str.as_str());
    }
    let existing_raw = fs::read_to_string(target)?;
    let existing_parsed: Value = serde_json::from_str(existing_raw.as_str())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error.to_string()))?;

    match (existing_parsed, payload.clone()) {
        (Value::Object(mut existing_obj), Value::Object(incoming_obj)) => {
            merge_json_objects_missing_and_non_null(&mut existing_obj, &incoming_obj);
            let merged = Value::Object(existing_obj);
            let merged_str = serde_json::to_string_pretty(&merged)?;
            if merged_str != existing_raw {
                write_json_file_atomic_replace(target, merged_str.as_str())?;
            }
            Ok(())
        }
        _ => write_json_file_atomic_replace(target, payload_str.as_str()),
    }
}

fn build_runtime_metadata_payload(
    options: &SnapshotHookOptions,
    group_request_token: &str,
    resolved_entry_port: Option<i64>,
) -> Value {
    let provider_key = normalize_provider_key(&options.provider_key);
    let mut payload = serde_json::json!({
      "timestamp": chrono::Utc::now().to_rfc3339(),
      "versions": {
        "routecodex": env::var("ROUTECODEX_VERSION").ok(),
        "routecodexBuildTime": env::var("ROUTECODEX_BUILD_TIME").ok(),
        "llmswitchCore": env::var("ROUTECODEX_LLMSWITCH_CORE_VERSION").ok(),
        "node": env::var("NODE_VERSION").ok()
      },
      "endpoint": options.endpoint.clone(),
      "requestId": options.request_id.clone(),
      "groupRequestId": group_request_token,
      "providerKey": provider_key,
      "entryProtocol": options.entry_protocol.clone(),
      "entryPort": resolved_entry_port
    });
    if let Some(payload_obj) = payload.as_object_mut() {
        if let Some(port) = resolved_entry_port {
            payload_obj.insert("matchedPort".to_string(), Value::from(port));
        }
    }
    if let Some(request_truth) =
        build_runtime_request_truth_summary(options.runtime_metadata.as_ref())
    {
        if let Some(payload_obj) = payload.as_object_mut() {
            payload_obj.insert("requestTruth".to_string(), request_truth);
        }
    }
    payload
}

fn clone_trimmed_string_field(
    source: &Map<String, Value>,
    key: &str,
    out: &mut Map<String, Value>,
) {
    if let Some(value) = read_trimmed_string(source.get(key)) {
        out.insert(key.to_string(), Value::String(value));
    }
}

fn clone_object_field_if_present(
    source: &Map<String, Value>,
    key: &str,
    out: &mut Map<String, Value>,
) {
    if let Some(value) = source.get(key).and_then(Value::as_object) {
        out.insert(key.to_string(), Value::Object(value.clone()));
    }
}

fn build_runtime_request_truth_summary(runtime_metadata: Option<&Value>) -> Option<Value> {
    let metadata = runtime_metadata?.as_object()?;
    let mut summary = Map::<String, Value>::new();

    for key in [
        "sessionId",
        "conversationId",
        "continuationOwner",
        "responseId",
        "previousResponseId",
        "routeHint",
    ] {
        clone_trimmed_string_field(metadata, key, &mut summary);
    }

    for key in ["responsesResume", "continuation", "responsesRequestContext"] {
        clone_object_field_if_present(metadata, key, &mut summary);
    }

    if let Some(runtime_control) = metadata.get("runtime_control").and_then(Value::as_object) {
        let mut runtime_summary = Map::<String, Value>::new();
        for key in ["serverToolFollowup", "serverToolFollowupSource", "stopless"] {
            if let Some(value) = runtime_control.get(key) {
                runtime_summary.insert(key.to_string(), value.clone());
            }
        }
        if !runtime_summary.is_empty() {
            summary.insert("runtimeControl".to_string(), Value::Object(runtime_summary));
        }
    }

    if summary.is_empty() {
        None
    } else {
        Some(Value::Object(summary))
    }
}

fn file_mtime_ms(path: &Path) -> i128 {
    let meta = match fs::metadata(path) {
        Ok(v) => v,
        Err(_) => return 0,
    };
    match meta.modified() {
        Ok(time) => match time.duration_since(UNIX_EPOCH) {
            Ok(duration) => duration.as_millis() as i128,
            Err(_) => 0,
        },
        Err(_) => {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|v| v.as_millis() as i128)
                .unwrap_or(0);
            now
        }
    }
}

fn prune_snapshot_files_keep_recent(dir: &Path, keep_recent: usize) {
    if keep_recent < 1 {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(v) => v,
        Err(_) => return,
    };
    let mut files: Vec<(PathBuf, String, i128)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match entry.file_name().to_str() {
            Some(v) => v.to_string(),
            None => continue,
        };
        if name == "__runtime.json" {
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        files.push((path.clone(), name, file_mtime_ms(&path)));
    }
    if files.len() <= keep_recent {
        return;
    }
    files.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.1.cmp(&b.1)));
    for stale in files.into_iter().skip(keep_recent) {
        if let Err(error) = fs::remove_file(&stale.0) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!(
                    "[hub_snapshot_hooks] Failed to prune stale snapshot {:?}: {}",
                    stale.0, error
                );
            }
        }
    }
}

fn is_request_like_snapshot_dir(path: &Path, name: &str) -> bool {
    if name.starts_with("__") || name == "_tmp" {
        return false;
    }
    if name.starts_with("req_") || name.starts_with("req-") {
        return true;
    }
    path.join("__runtime.json").is_file()
}

fn prune_snapshot_request_dirs_keep_recent(parent_dir: &Path, keep_recent: usize) {
    if keep_recent < 1 {
        return;
    }
    let entries = match fs::read_dir(parent_dir) {
        Ok(v) => v,
        Err(_) => return,
    };
    let mut dirs: Vec<(PathBuf, String, i128)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = match entry.file_name().to_str() {
            Some(v) => v.to_string(),
            None => continue,
        };
        if !is_request_like_snapshot_dir(&path, &name) {
            continue;
        }
        dirs.push((path.clone(), name, file_mtime_ms(&path)));
    }
    if dirs.len() <= keep_recent {
        return;
    }
    dirs.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.1.cmp(&b.1)));
    for stale in dirs.into_iter().skip(keep_recent) {
        if let Err(error) = fs::remove_dir_all(&stale.0) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!(
                    "[hub_snapshot_hooks] Failed to prune stale request dir {:?}: {}",
                    stale.0, error
                );
            }
        }
    }
}

fn prune_errorsample_files_keep_recent(dir: &Path, keep_recent: usize) {
    if keep_recent < 1 {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(v) => v,
        Err(_) => return,
    };
    let mut files: Vec<(PathBuf, String, i128)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match entry.file_name().to_str() {
            Some(v) => v.to_string(),
            None => continue,
        };
        if path.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        files.push((path.clone(), name, file_mtime_ms(&path)));
    }
    if files.len() <= keep_recent {
        return;
    }
    files.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.1.cmp(&b.1)));
    for stale in files.into_iter().skip(keep_recent) {
        if let Err(error) = fs::remove_file(&stale.0) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!(
                    "[hub_snapshot_hooks] Failed to prune stale errorsample {:?}: {}",
                    stale.0, error
                );
            }
        }
    }
}

fn write_snapshot_file(
    options: &SnapshotHookOptions,
    root_override: Option<&Path>,
) -> Result<(), std::io::Error> {
    if is_disabled_provider_request_body_snapshot(options.stage.as_str()) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            SNAPSHOT_PROVIDER_REQUEST_BODY_DISABLED,
        ));
    }
    let root = root_override
        .map(|p| p.to_path_buf())
        .unwrap_or_else(resolve_snapshot_root);
    let folder = resolve_entry_protocol(options, &options.data);
    let entry_port = resolve_entry_port(options, &options.data);
    if entry_port.is_none() && requires_port_scoped_snapshot_dir(options.stage.as_str()) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "[hub_snapshot_hooks] entryPort required for stage={}",
                options.stage
            ),
        ));
    }
    let stage_token = sanitize_token(options.stage.as_str(), "snapshot");
    let group_request_token = sanitize_token(
        options
            .group_request_id
            .clone()
            .or_else(|| extract_nested_group_request_id(&options.data))
            .unwrap_or_else(|| options.request_id.clone())
            .as_str(),
        format!("req_{}", chrono::Utc::now().timestamp_millis()).as_str(),
    );
    let dir = root
        .join(folder)
        .join("ports")
        .join(
            entry_port
                .map(|value| value.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
        )
        .join(&group_request_token);
    if let Err(e) = fs::create_dir_all(&dir) {
        eprintln!(
            "[hub_snapshot_hooks] Failed to create directory {:?}: {}",
            dir, e
        );
    }
    let meta_path = dir.join("__runtime.json");
    let meta_payload =
        build_runtime_metadata_payload(&options, group_request_token.as_str(), entry_port);
    if let Err(e) = upsert_runtime_metadata_file(&meta_path, &meta_payload) {
        let kind = e.kind();
        eprintln!(
            "[hub_snapshot_hooks] runtime metadata write skipped path={:?} kind={:?}",
            meta_path, kind
        );
    }

    let spacing = options.verbosity.as_deref() == Some("minimal");
    let payload = if spacing {
        serde_json::to_string(&options.data).unwrap_or_else(|_| "{}".to_string())
    } else {
        serde_json::to_string_pretty(&options.data).unwrap_or_else(|_| "{}".to_string())
    };
    let file_name = format!("{}{}.json", stage_token, channel_suffix(&options.channel));
    write_unique_file(&dir, file_name.as_str(), payload.as_str())?;
    prune_snapshot_files_keep_recent(&dir, resolve_snapshot_keep_recent_files());
    if let Some(parent_dir) = dir.parent() {
        prune_snapshot_request_dirs_keep_recent(
            parent_dir,
            resolve_snapshot_keep_recent_request_dirs(),
        );
    }
    Ok(())
}

fn write_snapshot_via_hooks_sync(options: SnapshotHookOptions) {
    let stage = sanitize_token(options.stage.as_str(), "snapshot");
    let mut normal = options.clone();
    normal.stage = stage.clone();
    if is_payload_contract_errorsample_stage(stage.as_str()) {
        if let Err(e) = write_payload_contract_errorsample(&normal, stage.as_str()) {
            eprintln!(
                "[hub_snapshot_hooks] Failed to write payload contract errorsample for stage {}: {}",
                normal.stage, e
            );
        }
        return;
    }
    if let Err(e) = write_snapshot_file(&normal, None) {
        if e.kind() == std::io::ErrorKind::InvalidInput
            && e.to_string() == SNAPSHOT_PROVIDER_REQUEST_BODY_DISABLED
        {
            return;
        }
        eprintln!(
            "[hub_snapshot_hooks] Failed to write snapshot for stage {}: {}",
            normal.stage, e
        );
    }

    if is_hub_policy_stage(stage.as_str())
        && (has_policy_violations(&options.data) || has_policy_enforcement_changes(&options.data))
    {
        let base = resolve_snapshot_root();
        let policy_root = base.join("__policy_violations__");
        if let Err(e) = write_snapshot_file(&normal, Some(policy_root.as_path())) {
            eprintln!(
                "[hub_snapshot_hooks] Failed to write policy violation snapshot for stage {}: {}",
                normal.stage, e
            );
        }
    }

    if is_hub_tool_surface_stage(stage.as_str()) && has_tool_surface_diff(&options.data) {
        let root = resolve_errorsamples_root();
        let dir = root.join(safe_errorsample_name("tool-surface"));
        if let Err(e) = fs::create_dir_all(&dir) {
            eprintln!(
                "[hub_snapshot_hooks] Failed to create directory {:?}: {}",
                dir, e
            );
        }
        cleanup_zero_byte_json_files(&dir);
        let payload = serde_json::json!({
          "kind": "hub_toolsurface_diff",
          "timestamp": chrono::Utc::now().to_rfc3339(),
          "endpoint": options.endpoint,
          "stage": stage,
          "requestId": options.request_id,
          "providerKey": options.provider_key,
          "groupRequestId": options.group_request_id,
          "runtime": {
            "routecodexVersion": env::var("ROUTECODEX_VERSION").ok(),
            "routecodexBuildTime": env::var("ROUTECODEX_BUILD_TIME").ok(),
            "llmswitchCore": env::var("ROUTECODEX_LLMSWITCH_CORE_VERSION").ok(),
            "node": env::var("NODE_VERSION").ok()
          },
          "observation": options.data
        });
        if let Ok(payload_str) = serde_json::to_string_pretty(&payload) {
            if let Err(e) = write_unique_errorsample_file(
                &dir,
                format!("{}.json", safe_errorsample_name(stage.as_str())).as_str(),
                payload_str.as_str(),
            ) {
                eprintln!(
                    "[hub_snapshot_hooks] Failed to write error sample for stage {}: {}",
                    stage, e
                );
            }
            prune_errorsample_files_keep_recent(&dir, resolve_errorsample_keep_recent_files());
        }
    }
}

fn write_snapshot_via_hooks(options: SnapshotHookOptions) {
    enqueue_snapshot_job(options);
}

fn is_payload_contract_errorsample_stage(stage: &str) -> bool {
    stage.starts_with(PAYLOAD_CONTRACT_ERRORSAMPLE_STAGE_PREFIX)
}

fn extract_payload_contract_marker(stage: &str) -> String {
    stage
        .strip_prefix(PAYLOAD_CONTRACT_ERRORSAMPLE_STAGE_PREFIX)
        .map(|value| sanitize_token(value, "payload_contract_error"))
        .unwrap_or_else(|| "payload_contract_error".to_string())
}

fn write_payload_contract_errorsample(
    options: &SnapshotHookOptions,
    stage: &str,
) -> Result<(), std::io::Error> {
    let root = resolve_errorsamples_root();
    let dir = root.join(safe_errorsample_name("payload-contract-error"));
    fs::create_dir_all(&dir)?;
    cleanup_zero_byte_json_files(&dir);

    let data_obj = options.data.as_object();
    let phase = data_obj
        .and_then(|obj| obj.get("phase"))
        .and_then(|value| value.as_str())
        .unwrap_or("provider-response");
    let reason = data_obj
        .and_then(|obj| obj.get("reason"))
        .and_then(|value| value.as_str())
        .unwrap_or("payload contract error");
    let observation = data_obj
        .and_then(|obj| obj.get("observation"))
        .cloned()
        .unwrap_or_else(|| options.data.clone());
    let payload = serde_json::json!({
      "kind": "payload_contract_error",
      "timestamp": chrono::Utc::now().to_rfc3339(),
      "phase": phase,
      "marker": extract_payload_contract_marker(stage),
      "reason": reason,
      "requestId": options.request_id,
      "endpoint": options.endpoint,
      "providerKey": options.provider_key,
      "observation": observation
    });
    let payload_str = serde_json::to_string_pretty(&payload)?;
    write_unique_errorsample_file(
        &dir,
        format!("{}.json", safe_errorsample_name(stage)).as_str(),
        payload_str.as_str(),
    )?;
    prune_errorsample_files_keep_recent(&dir, resolve_errorsample_keep_recent_files());
    Ok(())
}

pub(crate) fn enqueue_payload_contract_errorsample(
    endpoint: &str,
    request_id: &str,
    provider_key: Option<&str>,
    phase: &str,
    marker: &str,
    reason: &str,
    observation: Value,
) {
    write_snapshot_via_hooks(SnapshotHookOptions {
        endpoint: endpoint.to_string(),
        stage: format!(
            "{}{}",
            PAYLOAD_CONTRACT_ERRORSAMPLE_STAGE_PREFIX,
            sanitize_token(marker, "payload_contract_error")
        ),
        request_id: request_id.to_string(),
        data: serde_json::json!({
          "phase": phase,
          "reason": reason,
          "observation": observation
        }),
        verbosity: Some("minimal".to_string()),
        channel: Some(phase.to_string()),
        provider_key: provider_key.map(|value| value.to_string()),
        group_request_id: None,
        entry_protocol: None,
        entry_port: None,
        runtime_metadata: None,
    });
}

#[cfg(test)]
mod snapshot_entry_tests {
    use super::*;

    #[test]
    fn runtime_metadata_atomic_create_preserves_existing_file() {
        let dir = std::env::temp_dir().join(format!("hub-snapshot-hooks-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("__runtime.json");

        write_json_file_if_missing_atomic(&target, "{\"first\":true}\n").unwrap();
        write_json_file_if_missing_atomic(&target, "{\"second\":true}\n").unwrap();

        let parsed: Value =
            serde_json::from_str(fs::read_to_string(&target).unwrap().as_str()).unwrap();
        assert_eq!(parsed.get("first").and_then(Value::as_bool), Some(true));
        assert!(parsed.get("second").is_none());

        fs::remove_dir_all(&dir).unwrap();
    }
}

#[derive(Clone, Copy)]
enum SnapshotStageKind {
    RequestInbound,
    RequestOutbound,
    ResponseInbound,
    ResponseOutbound,
}

fn resolve_snapshot_stage_kind(stage: &str) -> Option<SnapshotStageKind> {
    match stage {
        "req_inbound_stage2_semantic_map" | "chat_process.req.stage2.semantic_map" => {
            Some(SnapshotStageKind::RequestInbound)
        }
        "req_outbound_stage1_semantic_map" | "chat_process.req.stage6.outbound.semantic_map" => {
            Some(SnapshotStageKind::RequestOutbound)
        }
        "resp_inbound_stage3_semantic_map" | "chat_process.resp.stage4.semantic_map_to_chat" => {
            Some(SnapshotStageKind::ResponseInbound)
        }
        "resp_outbound_stage1_client_remap" | "chat_process.resp.stage9.client_remap" => {
            Some(SnapshotStageKind::ResponseOutbound)
        }
        _ => None,
    }
}

fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => {
            if let Some(n) = v.as_i64() {
                n != 0
            } else if let Some(n) = v.as_u64() {
                n != 0
            } else if let Some(n) = v.as_f64() {
                n != 0.0 && !n.is_nan()
            } else {
                false
            }
        }
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}

fn is_chat_envelope(payload: &Value) -> bool {
    let obj = match payload.as_object() {
        Some(obj) => obj,
        None => return false,
    };
    let messages = obj.get("messages").and_then(|v| v.as_array());
    let metadata = obj.get("metadata").and_then(|v| v.as_object());
    messages.is_some() && metadata.is_some()
}

fn build_meta_snapshot(metadata: &Map<String, Value>) -> Option<Value> {
    let mut meta = Map::new();
    if let Some(ctx) = metadata.get("context") {
        if is_truthy(ctx) {
            meta.insert("context".to_string(), ctx.clone());
        }
    }
    if let Some(Value::Array(missing)) = metadata.get("missingFields") {
        if !missing.is_empty() {
            meta.insert("missing_fields".to_string(), Value::Array(missing.clone()));
        }
    }
    let mut extras = Map::new();
    for (key, value) in metadata.iter() {
        if key == "context" || key == "missingFields" {
            continue;
        }
        extras.insert(key.clone(), value.clone());
    }
    if !extras.is_empty() {
        meta.insert("extra".to_string(), Value::Object(extras));
    }
    if meta.is_empty() {
        None
    } else {
        Some(Value::Object(meta))
    }
}

fn build_openai_chat_snapshot(payload: &Value) -> Value {
    let mut snapshot = Map::new();
    if let Some(Value::Object(params)) = payload.get("parameters") {
        if !params.is_empty() {
            for (key, value) in params.iter() {
                snapshot.insert(key.clone(), value.clone());
            }
        }
    }
    if let Some(messages) = payload.get("messages") {
        snapshot.insert("messages".to_string(), messages.clone());
    }
    if let Some(Value::Array(tools)) = payload.get("tools") {
        if !tools.is_empty() {
            snapshot.insert("tools".to_string(), Value::Array(tools.clone()));
        }
    }
    if let Some(Value::Array(outputs)) = payload.get("toolOutputs") {
        if !outputs.is_empty() {
            snapshot.insert("tool_outputs".to_string(), Value::Array(outputs.clone()));
        }
    }
    if let Some(Value::Object(metadata)) = payload.get("metadata") {
        if let Some(meta) = build_meta_snapshot(metadata) {
            snapshot.insert("meta".to_string(), meta);
        }
    }
    Value::Object(snapshot)
}

fn normalize_snapshot_stage_payload(stage: &str, payload: Value) -> Value {
    match resolve_snapshot_stage_kind(stage) {
        Some(SnapshotStageKind::RequestInbound) | Some(SnapshotStageKind::RequestOutbound) => {
            if is_chat_envelope(&payload) {
                build_openai_chat_snapshot(&payload)
            } else {
                payload
            }
        }
        Some(SnapshotStageKind::ResponseInbound) | Some(SnapshotStageKind::ResponseOutbound) => {
            payload
        }
        None => payload,
    }
}

fn resolve_bool_from_env(value: Option<String>, fallback: bool) -> bool {
    if let Some(v) = value {
        let normalized = v.trim().to_lowercase();
        if ["1", "true", "yes", "on"].contains(&normalized.as_str()) {
            return true;
        }
        if ["0", "false", "no", "off"].contains(&normalized.as_str()) {
            return false;
        }
    }
    fallback
}

#[napi]
pub fn should_record_snapshots_json() -> NapiResult<String> {
    let hub_flag = env::var("ROUTECODEX_HUB_SNAPSHOTS").ok();
    if let Some(v) = hub_flag.clone() {
        let enabled = resolve_bool_from_env(Some(v), true);
        return serde_json::to_string(&enabled).map_err(|e| {
            napi::Error::from_reason(format!("Failed to serialize snapshot flag: {}", e))
        });
    }
    let shared_flag = env::var("ROUTECODEX_SNAPSHOT")
        .ok()
        .or_else(|| env::var("ROUTECODEX_SNAPSHOTS").ok());
    let enabled = resolve_bool_from_env(shared_flag, false);
    serde_json::to_string(&enabled)
        .map_err(|e| napi::Error::from_reason(format!("Failed to serialize snapshot flag: {}", e)))
}

#[napi]
pub fn write_snapshot_via_hooks_json(input_json: String) -> NapiResult<String> {
    let options: SnapshotHookOptions = serde_json::from_str(&input_json)
        .map_err(|e| napi::Error::from_reason(format!("Failed to parse snapshot input: {}", e)))?;
    write_snapshot_via_hooks(options);
    serde_json::to_string(&true).map_err(|e| {
        napi::Error::from_reason(format!("Failed to serialize snapshot result: {}", e))
    })
}

pub fn build_snapshot_recorder_write_options(input: SnapshotRecorderWriteOptionsInput) -> Value {
    let entry_port = resolve_snapshot_recorder_entry_port(input.metadata_center_snapshot.as_ref());
    let group_request_id = resolve_snapshot_recorder_group_request_id(input.context.as_ref());
    let runtime_metadata = resolve_snapshot_recorder_runtime_metadata(input.context);
    let mut output = Map::new();
    output.insert("endpoint".to_string(), Value::String(input.endpoint.clone()));
    output.insert("stage".to_string(), Value::String(input.stage));
    output.insert("requestId".to_string(), Value::String(input.request_id));
    output.insert("data".to_string(), input.data);
    output.insert("verbosity".to_string(), Value::String("verbose".to_string()));
    if let Some(provider_key) = input.provider_key {
        output.insert("providerKey".to_string(), Value::String(provider_key));
    }
    if let Some(group_request_id) = group_request_id {
        output.insert("groupRequestId".to_string(), Value::String(group_request_id));
    }
    output.insert(
        "entryProtocol".to_string(),
        Value::String(resolve_snapshot_folder(input.endpoint.as_str())),
    );
    if let Some(entry_port) = entry_port {
        output.insert("entryPort".to_string(), Value::from(entry_port));
    }
    if let Some(runtime_metadata) = runtime_metadata {
        output.insert("runtimeMetadata".to_string(), runtime_metadata);
    }
    Value::Object(output)
}

#[napi]
pub fn build_snapshot_recorder_write_options_json(input_json: String) -> NapiResult<String> {
    let input: SnapshotRecorderWriteOptionsInput = serde_json::from_str(&input_json).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to parse snapshot recorder write options input: {}",
            e
        ))
    })?;
    let output = build_snapshot_recorder_write_options(input);
    serde_json::to_string(&output).map_err(|e| {
        napi::Error::from_reason(format!(
            "Failed to serialize snapshot recorder write options: {}",
            e
        ))
    })
}

#[napi]
pub fn normalize_snapshot_stage_payload_json(
    stage: String,
    payload_json: String,
) -> NapiResult<String> {
    let payload: Value =
        serde_json::from_str(&payload_json).map_err(|e| napi::Error::from_reason(e.to_string()))?;
    let normalized = normalize_snapshot_stage_payload(stage.trim(), payload);
    serde_json::to_string(&normalized).map_err(|e| napi::Error::from_reason(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_file_uses_entry_protocol_and_port_not_provider_directory() {
        let root = env::temp_dir().join(format!(
            "rcc-snapshot-entry-port-{}",
            Uuid::new_v4().simple()
        ));
        let options = SnapshotHookOptions {
            endpoint: "/v1/responses".to_string(),
            stage: "provider-response".to_string(),
            request_id: "req_1".to_string(),
            data: serde_json::json!({
                "providerKey": "mimo.key1.mimo-v2.5",
                "meta": { "entryEndpoint": "/v1/responses" }
            }),
            verbosity: Some("minimal".to_string()),
            channel: None,
            provider_key: Some("mimo.key1.mimo-v2.5".to_string()),
            group_request_id: Some("grp_1".to_string()),
            entry_protocol: Some("openai-responses".to_string()),
            entry_port: Some(5555),
            runtime_metadata: None,
        };

        write_snapshot_file(&options, Some(root.as_path())).expect("snapshot write should succeed");

        let entry_dir = root
            .join("openai-responses")
            .join("ports")
            .join("5555")
            .join("grp_1");
        assert!(
            entry_dir.exists(),
            "entry protocol/port directory must exist"
        );
        assert!(
            entry_dir.join("provider-response.json").exists(),
            "stage snapshot must be written under the entry directory"
        );
        assert!(
            !root
                .join("openai-responses")
                .join("mimo.key1.mimo-v2.5")
                .exists(),
            "provider directory must not be created for entry snapshots"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn provider_request_body_snapshot_is_disabled() {
        let root = env::temp_dir().join(format!(
            "rcc-snapshot-provider-request-disabled-{}",
            Uuid::new_v4().simple()
        ));
        let options = SnapshotHookOptions {
            endpoint: "/v1/responses".to_string(),
            stage: "provider-request".to_string(),
            request_id: "req_disabled_provider_request".to_string(),
            data: serde_json::json!({
                "body": { "ok": true }
            }),
            verbosity: Some("minimal".to_string()),
            channel: None,
            provider_key: Some("mimo.key1.mimo-v2.5".to_string()),
            group_request_id: Some("grp_disabled_provider_request".to_string()),
            entry_protocol: Some("openai-responses".to_string()),
            entry_port: Some(5555),
            runtime_metadata: None,
        };

        let error = write_snapshot_file(&options, Some(root.as_path()))
            .expect_err("provider-request body snapshot must be disabled");
        assert!(error
            .to_string()
            .contains("provider-request body snapshots are disabled"));
        assert!(
            !root.join("openai-responses").exists(),
            "disabled provider-request snapshot must not create artifact directories"
        );
    }

    #[test]
    fn runtime_metadata_payload_captures_request_truth_summary() {
        let root = env::temp_dir().join(format!(
            "rcc-snapshot-runtime-truth-{}",
            Uuid::new_v4().simple()
        ));
        let options = SnapshotHookOptions {
            endpoint: "/v1/responses".to_string(),
            stage: "provider-response".to_string(),
            request_id: "req_runtime_truth_1".to_string(),
            data: serde_json::json!({
                "body": { "ok": true }
            }),
            verbosity: Some("minimal".to_string()),
            channel: None,
            provider_key: Some("minimax.key1.MiniMax-M3".to_string()),
            group_request_id: Some("grp_runtime_truth".to_string()),
            entry_protocol: Some("openai-responses".to_string()),
            entry_port: Some(5555),
            runtime_metadata: Some(serde_json::json!({
                "sessionId": "sess-123",
                "conversationId": "conv-456",
                "continuationOwner": "relay",
                "responseId": "resp_789",
                "previousResponseId": "resp_prev_111",
                "routeHint": "thinking",
                "responsesResume": { "previousRequestId": "req_prev_1" },
                "continuation": { "chainId": "req_chain_1", "continuationScope": "request_chain" },
                "responsesRequestContext": { "sessionId": "sess-123", "conversationId": "conv-456" },
                "runtime_control": {
                    "stopless": true,
                    "serverToolFollowup": true
                }
            })),
        };

        write_snapshot_file(&options, Some(root.as_path())).expect("snapshot write should succeed");

        let runtime_path = root
            .join("openai-responses")
            .join("ports")
            .join("5555")
            .join("grp_runtime_truth")
            .join("__runtime.json");
        let parsed: Value =
            serde_json::from_str(fs::read_to_string(runtime_path).unwrap().as_str()).unwrap();

        let truth = parsed
            .get("requestTruth")
            .and_then(Value::as_object)
            .expect("requestTruth object");
        assert_eq!(
            truth.get("sessionId").and_then(Value::as_str),
            Some("sess-123")
        );
        assert_eq!(
            truth.get("conversationId").and_then(Value::as_str),
            Some("conv-456")
        );
        assert_eq!(
            truth.get("continuationOwner").and_then(Value::as_str),
            Some("relay")
        );
        assert_eq!(
            truth.get("responseId").and_then(Value::as_str),
            Some("resp_789")
        );
        assert_eq!(
            truth.get("previousResponseId").and_then(Value::as_str),
            Some("resp_prev_111")
        );
        assert_eq!(
            truth.get("routeHint").and_then(Value::as_str),
            Some("thinking")
        );
        assert_eq!(
            truth
                .get("continuation")
                .and_then(Value::as_object)
                .and_then(|row| row.get("chainId"))
                .and_then(Value::as_str),
            Some("req_chain_1")
        );
        assert_eq!(
            truth
                .get("responsesResume")
                .and_then(Value::as_object)
                .and_then(|row| row.get("previousRequestId"))
                .and_then(Value::as_str),
            Some("req_prev_1")
        );
        assert_eq!(
            truth
                .get("runtimeControl")
                .and_then(Value::as_object)
                .and_then(|row| row.get("stopless"))
                .and_then(Value::as_bool),
            Some(true)
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn snapshot_file_resolves_nested_body_metadata_entry_port() {
        let root = env::temp_dir().join(format!(
            "rcc-snapshot-nested-port-{}",
            Uuid::new_v4().simple()
        ));
        let options = SnapshotHookOptions {
            endpoint: "/v1/responses".to_string(),
            stage: "provider-response".to_string(),
            request_id: "req_nested_port_1".to_string(),
            data: serde_json::json!({
                "body": {
                    "metadata": {
                        "entryPort": 5555,
                        "matchedPort": 5555
                    }
                }
            }),
            verbosity: Some("minimal".to_string()),
            channel: None,
            provider_key: Some("xlc.key1.glm-5.2".to_string()),
            group_request_id: Some("grp_nested_port".to_string()),
            entry_protocol: Some("openai-responses".to_string()),
            entry_port: None,
            runtime_metadata: None,
        };

        write_snapshot_file(&options, Some(root.as_path()))
            .expect("nested entryPort should resolve");

        let entry_dir = root
            .join("openai-responses")
            .join("ports")
            .join("5555")
            .join("grp_nested_port");
        assert!(entry_dir.join("provider-response.json").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn snapshot_file_missing_entry_port_fails_fast_for_boundary_stage() {
        let root = env::temp_dir().join(format!(
            "rcc-snapshot-missing-port-{}",
            Uuid::new_v4().simple()
        ));
        let options = SnapshotHookOptions {
            endpoint: "/v1/responses".to_string(),
            stage: "provider-response".to_string(),
            request_id: "req_missing_port_1".to_string(),
            data: serde_json::json!({
                "body": { "ok": true }
            }),
            verbosity: Some("minimal".to_string()),
            channel: None,
            provider_key: Some("xlc.key1.glm-5.2".to_string()),
            group_request_id: Some("grp_missing_port".to_string()),
            entry_protocol: Some("openai-responses".to_string()),
            entry_port: None,
            runtime_metadata: None,
        };

        let error = write_snapshot_file(&options, Some(root.as_path()))
            .expect_err("missing entryPort must fail-fast");
        assert!(error.to_string().contains("entryPort required"));
        assert!(
            !root.join("openai-responses").exists(),
            "missing entryPort must not create fallback directories"
        );
    }

    #[test]
    fn runtime_metadata_file_is_enriched_by_later_provider_snapshot() {
        let root = env::temp_dir().join(format!(
            "rcc-snapshot-runtime-enrich-{}",
            Uuid::new_v4().simple()
        ));
        let group_request_id = "grp_runtime_enrich";

        let client_options = SnapshotHookOptions {
            endpoint: "/v1/responses".to_string(),
            stage: "client-request".to_string(),
            request_id: "req_runtime_enrich_client".to_string(),
            data: serde_json::json!({
                "body": {
                    "metadata": {
                        "entryPort": 5555,
                        "matchedPort": 5555
                    }
                }
            }),
            verbosity: Some("minimal".to_string()),
            channel: None,
            provider_key: None,
            group_request_id: Some(group_request_id.to_string()),
            entry_protocol: Some("openai-responses".to_string()),
            entry_port: Some(5555),
            runtime_metadata: None,
        };
        write_snapshot_file(&client_options, Some(root.as_path()))
            .expect("client snapshot should seed runtime metadata");

        let provider_options = SnapshotHookOptions {
            endpoint: "/v1/responses".to_string(),
            stage: "provider-response".to_string(),
            request_id: "req_runtime_enrich_provider".to_string(),
            data: serde_json::json!({
                "body": {
                    "ok": true
                }
            }),
            verbosity: Some("minimal".to_string()),
            channel: None,
            provider_key: Some("xlc.key1.glm-5.2".to_string()),
            group_request_id: Some(group_request_id.to_string()),
            entry_protocol: Some("openai-responses".to_string()),
            entry_port: Some(5555),
            runtime_metadata: Some(serde_json::json!({
                "sessionId": "sess-enrich-1",
                "conversationId": "conv-enrich-1",
                "continuationOwner": "relay"
            })),
        };
        write_snapshot_file(&provider_options, Some(root.as_path()))
            .expect("provider snapshot should enrich runtime metadata");

        let runtime_path = root
            .join("openai-responses")
            .join("ports")
            .join("5555")
            .join(group_request_id)
            .join("__runtime.json");
        let parsed: Value =
            serde_json::from_str(fs::read_to_string(runtime_path).unwrap().as_str()).unwrap();
        assert_eq!(
            parsed.get("providerKey").and_then(Value::as_str),
            Some("xlc.key1.glm-5.2")
        );
        let truth = parsed
            .get("requestTruth")
            .and_then(Value::as_object)
            .expect("requestTruth object");
        assert_eq!(
            truth.get("sessionId").and_then(Value::as_str),
            Some("sess-enrich-1")
        );
        assert_eq!(
            truth.get("conversationId").and_then(Value::as_str),
            Some("conv-enrich-1")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn normalize_snapshot_stage_payload_json_echo_req_inbound_semantic_map() {
        // req_inbound_stage2_semantic_map with chat envelope → normalized (messages + meta)
        let input = r#"{"model":"gpt-4","messages":[{"role":"user","content":"hello"}],"metadata":{"context":"test"},"stream":true}"#;
        let stage = "req_inbound_stage2_semantic_map".to_string();
        let result = normalize_snapshot_stage_payload_json(stage, input.to_string()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        let obj = parsed.as_object().unwrap();
        assert!(
            obj.contains_key("messages"),
            "chat envelope should keep messages: {:?}",
            obj
        );
        assert!(
            obj.contains_key("meta"),
            "chat envelope should produce meta snapshot"
        );
        assert_eq!(obj["messages"][0]["content"], "hello");
        // Ensure model/stream were filtered out by normalization
        assert!(
            !obj.contains_key("model"),
            "model should be filtered: {:?}",
            obj
        );
        assert!(
            !obj.contains_key("stream"),
            "stream should be filtered: {:?}",
            obj
        );
    }

    #[test]
    fn normalize_snapshot_stage_payload_json_echo_req_inbound_non_chat_envelope_passthrough() {
        let input =
            r#"{"model":"gpt-4","messages":[{"role":"user","content":"hello"}],"stream":true}"#;
        let stage = "req_inbound_stage2_semantic_map".to_string();
        let result = normalize_snapshot_stage_payload_json(stage, input.to_string()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        // No metadata → not a chat envelope → passthrough
        assert_eq!(parsed["model"], "gpt-4");
        assert_eq!(parsed["messages"][0]["content"], "hello");
    }

    #[test]
    fn normalize_snapshot_stage_payload_json_echo_resp_inbound() {
        let input = r#"{"id":"resp_1","object":"response","status":"completed"}"#;
        let stage = "resp_inbound".to_string();
        let result = normalize_snapshot_stage_payload_json(stage, input.to_string()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["id"], "resp_1");
    }

    #[test]
    fn normalize_snapshot_stage_payload_json_echo_custom_stage() {
        let input = r#"{"foo":"bar"}"#;
        let stage = "custom_stage".to_string();
        let result = normalize_snapshot_stage_payload_json(stage, input.to_string()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["foo"], "bar");
    }

    #[test]
    fn normalize_snapshot_stage_payload_json_echo_non_chat_envelope_req_inbound() {
        let input = r#"{"providerKey":"test.key1","body":{"messages":[]}}"#;
        let stage = "req_inbound".to_string();
        let result = normalize_snapshot_stage_payload_json(stage, input.to_string()).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["providerKey"], "test.key1");
    }

    #[test]
    fn write_snapshot_via_hooks_json_echo_valid_input() {
        let input = r#"{
            "endpoint": "/v1/chat/completions",
            "stage": "req_inbound",
            "requestId": "test_req_echo_1",
            "data": {"messages": [{"role": "user", "content": "hello"}]},
            "verbosity": "minimal",
            "channel": "test",
            "providerKey": "test.key1",
            "groupRequestId": "test_grp_echo_1",
            "entryProtocol": "openai-chat",
            "entryPort": 5555,
            "runtimeMetadata": {"foo": "bar"}
        }"#;
        let result = write_snapshot_via_hooks_json(input.to_string());
        assert!(
            result.is_ok(),
            "write_snapshot_via_hooks_json should succeed: {:?}",
            result.err()
        );
        let parsed: bool = serde_json::from_str(&result.unwrap()).unwrap();
        assert!(parsed, "should return true");
    }

    #[test]
    fn builds_snapshot_recorder_write_options_from_context_and_metadata_center_snapshot() {
        let input = SnapshotRecorderWriteOptionsInput {
            endpoint: "/v1/messages".to_string(),
            stage: "req_inbound".to_string(),
            request_id: "req_snapshot_recorder".to_string(),
            data: serde_json::json!({ "ok": true }),
            provider_key: Some("provider.key1".to_string()),
            context: Some(serde_json::json!({
                "clientRequestId": "client_req_1",
                "groupRequestId": "group_req_1",
                "metadata": { "runtime": "meta" }
            })),
            metadata_center_snapshot: Some(serde_json::json!({
                "requestTruth": { "portScope": "5555" }
            })),
        };

        let output = build_snapshot_recorder_write_options(input);

        assert_eq!(output["endpoint"], serde_json::json!("/v1/messages"));
        assert_eq!(output["entryProtocol"], serde_json::json!("anthropic-messages"));
        assert_eq!(output["entryPort"], serde_json::json!(5555));
        assert_eq!(output["groupRequestId"], serde_json::json!("client_req_1"));
        assert_eq!(output["runtimeMetadata"]["runtime"], serde_json::json!("meta"));
        assert_eq!(output["providerKey"], serde_json::json!("provider.key1"));
    }
}

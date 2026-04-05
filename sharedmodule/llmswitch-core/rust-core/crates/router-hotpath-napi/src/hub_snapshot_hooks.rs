use napi::bindgen_prelude::Result as NapiResult;
use napi_derive::napi;
use regex::Regex;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender, TrySendError};
use std::sync::{Mutex, OnceLock};
use std::thread;
use uuid::Uuid;

const DEFAULT_SNAPSHOT_QUEUE_CAPACITY: usize = 256;
const SNAPSHOT_DROP_LOG_THROTTLE_MS: i64 = 5_000;

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
}

static PROVIDER_INDEX: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
static SNAPSHOT_WRITER_RUNTIME: OnceLock<Option<SnapshotWriterRuntime>> = OnceLock::new();
static SNAPSHOT_DROPPED_JOBS: AtomicU64 = AtomicU64::new(0);
static SNAPSHOT_LAST_DROP_LOG_AT_MS: AtomicI64 = AtomicI64::new(0);

#[derive(Clone)]
struct SnapshotWriterRuntime {
    sender: SyncSender<SnapshotHookOptions>,
}

fn provider_index() -> &'static Mutex<HashMap<String, String>> {
    PROVIDER_INDEX.get_or_init(|| Mutex::new(HashMap::new()))
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

fn read_string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn extract_nested_provider_key(value: &Value) -> Option<String> {
    if let Value::Object(obj) = value {
        if let Some(k) = read_string_field(value, "providerKey")
            .or_else(|| read_string_field(value, "providerId"))
            .or_else(|| read_string_field(value, "profileId"))
        {
            return Some(k);
        }
        if let Some(Value::Object(target)) = obj.get("target") {
            if let Some(k) = read_string_field(&Value::Object(target.clone()), "providerKey") {
                return Some(k);
            }
        }
        if let Some(Value::Object(meta)) = obj.get("meta") {
            let meta_value = Value::Object(meta.clone());
            if let Some(k) = read_string_field(&meta_value, "providerKey")
                .or_else(|| read_string_field(&meta_value, "providerId"))
            {
                return Some(k);
            }
            if let Some(Value::Object(ctx)) = meta.get("context") {
                let ctx_value = Value::Object(ctx.clone());
                if let Some(k) = read_string_field(&ctx_value, "providerKey")
                    .or_else(|| read_string_field(&ctx_value, "providerId"))
                    .or_else(|| read_string_field(&ctx_value, "profileId"))
                {
                    return Some(k);
                }
            }
        }
    }
    None
}

fn extract_nested_group_request_id(value: &Value) -> Option<String> {
    if let Value::Object(obj) = value {
        if let Some(k) = read_string_field(value, "clientRequestId")
            .or_else(|| read_string_field(value, "groupRequestId"))
        {
            return Some(k);
        }
        if let Some(Value::Object(meta)) = obj.get("meta") {
            let meta_value = Value::Object(meta.clone());
            if let Some(k) = read_string_field(&meta_value, "clientRequestId")
                .or_else(|| read_string_field(&meta_value, "groupRequestId"))
            {
                return Some(k);
            }
            if let Some(Value::Object(ctx)) = meta.get("context") {
                let ctx_value = Value::Object(ctx.clone());
                if let Some(k) = read_string_field(&ctx_value, "clientRequestId")
                    .or_else(|| read_string_field(&ctx_value, "groupRequestId"))
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
        if let Some(k) = read_string_field(value, "entryEndpoint")
            .or_else(|| read_string_field(value, "entry_endpoint"))
        {
            return Some(k);
        }
        if let Some(Value::Object(meta)) = obj.get("meta") {
            let meta_value = Value::Object(meta.clone());
            if let Some(k) = read_string_field(&meta_value, "entryEndpoint")
                .or_else(|| read_string_field(&meta_value, "entry_endpoint"))
            {
                return Some(k);
            }
            if let Some(Value::Object(ctx)) = meta.get("context") {
                let ctx_value = Value::Object(ctx.clone());
                if let Some(k) = read_string_field(&ctx_value, "entryEndpoint")
                    .or_else(|| read_string_field(&ctx_value, "entry_endpoint"))
                {
                    return Some(k);
                }
            }
        }
        if let Some(Value::Object(metadata)) = obj.get("metadata") {
            let md_value = Value::Object(metadata.clone());
            if let Some(k) = read_string_field(&md_value, "entryEndpoint")
                .or_else(|| read_string_field(&md_value, "entry_endpoint"))
            {
                return Some(k);
            }
        }
        if let Some(Value::Object(runtime)) = obj.get("runtime") {
            let r_value = Value::Object(runtime.clone());
            if let Some(k) = read_string_field(&r_value, "entryEndpoint")
                .or_else(|| read_string_field(&r_value, "entry_endpoint"))
            {
                return Some(k);
            }
        }
    }
    None
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
        let expected = read_string_field(value, "expectedProtocol");
        let detected = read_string_field(value, "detectedProtocol");
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

fn merge_dirs(src: &Path, dest: &Path) {
    if let Err(e) = fs::create_dir_all(dest) {
        eprintln!(
            "[hub_snapshot_hooks] Failed to create directory {:?}: {}",
            dest, e
        );
        return;
    }
    let entries = match fs::read_dir(src) {
        Ok(v) => v,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let from = entry.path();
        let name = entry.file_name();
        let to = dest.join(&name);
        if let Err(_) = fs::rename(&from, &to) {
            let stem = Path::new(&name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("snapshot");
            let ext = Path::new(&name)
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            let suffix = format!(
                "{}_{}",
                chrono::Utc::now().timestamp_millis(),
                Uuid::new_v4()
                    .simple()
                    .to_string()
                    .get(0..6)
                    .unwrap_or("rand")
            );
            let ext_suffix = if ext.is_empty() {
                String::new()
            } else {
                format!(".{}", ext)
            };
            let alt = dest.join(format!("{}_{}{}", stem, suffix, ext_suffix));
            if let Err(e) = fs::rename(&from, &alt) {
                eprintln!(
                    "[hub_snapshot_hooks] Failed to rename file {:?} to {:?}: {}",
                    from, alt, e
                );
            }
        }
    }
    if let Err(e) = fs::remove_dir(src) {
        eprintln!(
            "[hub_snapshot_hooks] Failed to remove directory {:?}: {}",
            src, e
        );
    }
}

fn promote_pending_dir(root: &Path, folder: &str, group_request_token: &str, provider_token: &str) {
    if group_request_token.is_empty() || provider_token == "__pending__" {
        return;
    }
    let pending = root
        .join(folder)
        .join("__pending__")
        .join(group_request_token);
    let dest = root
        .join(folder)
        .join(provider_token)
        .join(group_request_token);
    if !pending.exists() {
        return;
    }
    if let Err(e) = fs::create_dir_all(dest.parent().unwrap_or(root)) {
        eprintln!(
            "[hub_snapshot_hooks] Failed to create directory for {:?}: {}",
            dest, e
        );
        return;
    }
    if let Err(_) = fs::rename(&pending, &dest) {
        merge_dirs(&pending, &dest);
    }
}

fn write_snapshot_file(
    options: &SnapshotHookOptions,
    root_override: Option<&Path>,
) -> Result<(), std::io::Error> {
    let root = root_override
        .map(|p| p.to_path_buf())
        .unwrap_or_else(resolve_snapshot_root);
    let entry =
        extract_nested_entry_endpoint(&options.data).unwrap_or_else(|| options.endpoint.clone());
    let folder = resolve_snapshot_folder(entry.as_str());
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
    let provider_from_options = options.provider_key.clone();
    let provider_from_data = extract_nested_provider_key(&options.data);
    let mut provider_index = provider_index().lock().unwrap();
    let known_provider = provider_index.get(group_request_token.as_str()).cloned();
    let provider_token = sanitize_token(
        provider_from_options
            .or(provider_from_data)
            .or(known_provider)
            .unwrap_or_else(|| "__pending__".to_string())
            .as_str(),
        "__pending__",
    );
    if !provider_index.contains_key(group_request_token.as_str()) && provider_token != "__pending__"
    {
        provider_index.insert(group_request_token.clone(), provider_token.clone());
        drop(provider_index);
        promote_pending_dir(
            &root,
            folder.as_str(),
            group_request_token.as_str(),
            provider_token.as_str(),
        );
    } else {
        drop(provider_index);
    }

    let dir = root
        .join(folder)
        .join(provider_token)
        .join(group_request_token);
    if let Err(e) = fs::create_dir_all(&dir) {
        eprintln!(
            "[hub_snapshot_hooks] Failed to create directory {:?}: {}",
            dir, e
        );
    }
    let meta_path = dir.join("__runtime.json");
    if !meta_path.exists() {
        let payload = serde_json::json!({
          "timestamp": chrono::Utc::now().to_rfc3339(),
          "versions": {
            "routecodex": env::var("ROUTECODEX_VERSION").ok(),
            "routecodexBuildTime": env::var("ROUTECODEX_BUILD_TIME").ok(),
            "llmswitchCore": env::var("ROUTECODEX_LLMSWITCH_CORE_VERSION").ok(),
            "node": env::var("NODE_VERSION").ok()
          }
        });
        if let Ok(payload_str) = serde_json::to_string_pretty(&payload) {
            if let Err(e) = fs::write(&meta_path, payload_str) {
                eprintln!(
                    "[hub_snapshot_hooks] Failed to write runtime metadata {:?}: {}",
                    meta_path, e
                );
            }
        }
    }

    let spacing = options.verbosity.as_deref() == Some("minimal");
    let payload = if spacing {
        serde_json::to_string(&options.data).unwrap_or_else(|_| "{}".to_string())
    } else {
        serde_json::to_string_pretty(&options.data).unwrap_or_else(|_| "{}".to_string())
    };
    let file_name = format!("{}{}.json", stage_token, channel_suffix(&options.channel));
    write_unique_file(&dir, file_name.as_str(), payload.as_str())
}

fn write_snapshot_via_hooks_sync(options: SnapshotHookOptions) {
    let stage = sanitize_token(options.stage.as_str(), "snapshot");
    let mut normal = options.clone();
    normal.stage = stage.clone();
    if let Err(e) = write_snapshot_file(&normal, None) {
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
        }
    }
}

fn write_snapshot_via_hooks(options: SnapshotHookOptions) {
    enqueue_snapshot_job(options);
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
    let enabled = resolve_bool_from_env(shared_flag, true);
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

// feature_id: v3.admin_api
//! Deployment control plane: environment projection, doctor self-check, runtime lifecycle.
//!
//! Read-only projections derive from the existing typed sources (Config Core authoring +
//! compiled manifest, managed lifecycle instance records, installed binary). Mutating
//! endpoints delegate to the official lifecycle CLI for the served config path.

use crate::AppState;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use routecodex_v3_config_mgmt::{list_provider_ids, read_provider_file};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Managed lifecycle state root rule, owned by `routecodex-v3-lifecycle`:
/// `$ROUTECODEX_V3_STATE_DIR` else `$HOME/.rcc/state/runtime-lifecycle/v3`.
const LIFECYCLE_STATE_DIR_ENV: &str = "ROUTECODEX_V3_STATE_DIR";
/// Hooks sidecar process record inside the managed instance dir, owned by
/// `routecodex-v3-lifecycle::hooks_sidecar::HOOKS_SIDECAR_PROCESS_FILE`.
const HOOKS_SIDECAR_PID_FILE: &str = "hooks-sidecar.pid";
const HOOKS_SIDECAR_SOCKET_FILE: &str = "hooks-sidecar.sock";
/// Per-listener request-records retention threshold, owned by
/// `routecodex-v3-server::webui_observability::V3_WEBUI_HISTORY_MAX_BYTES`.
const REQUEST_RECORDS_HISTORY_LIMIT_BYTES: u64 = 64 * 1024 * 1024;
const HEALTH_PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const OUTPUT_TAIL_LINES: usize = 12;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/environment", get(environment))
        .route("/api/environment/doctor", post(doctor))
        .route("/api/runtime/restart", post(restart_runtime))
        .route("/api/admin/session", get(admin_session))
}

// ---------------------------------------------------------------------------
// GET /api/admin/session
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct AdminSession {
    pub token: String,
}

async fn admin_session(
    State(state): State<AppState>,
) -> Result<Json<AdminSession>, (StatusCode, Json<serde_json::Value>)> {
    match state.admin_token.as_deref() {
        Some(token) => Ok(Json(AdminSession {
            token: token.to_string(),
        })),
        None => Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({
                "error_code": "admin_token_unavailable",
                "error": "local admin token is not provisioned; mutating admin endpoints fail closed",
            })),
        )),
    }
}

// ---------------------------------------------------------------------------
// GET /api/environment
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct EnvironmentProjection {
    pub generated_at_epoch_ms: u64,
    pub admin: AdminProjection,
    pub binary: BinaryProjection,
    pub config: ConfigProjection,
    pub instance: Option<ManagedInstanceProjection>,
    pub instances: Vec<String>,
    pub listeners: Vec<ListenerHealthProjection>,
    pub logs: Vec<LogFileProjection>,
    pub hooks_sidecar: Option<HooksSidecarProjection>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AdminProjection {
    pub enabled: bool,
    pub bind: String,
    pub port: u16,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BinaryProjection {
    pub path: String,
    pub version: Option<String>,
    pub sha256: Option<String>,
    pub size_bytes: Option<u64>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConfigProjection {
    pub path: String,
    pub sha256: Option<String>,
    pub server_count: Option<usize>,
    pub provider_count: Option<usize>,
    pub route_group_count: Option<usize>,
    pub debug_log_file: Option<String>,
    pub servers: Vec<ServerProjection>,
    pub providers: Vec<ProviderProjection>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServerProjection {
    pub id: String,
    pub enabled: bool,
    pub bind: String,
    pub port: u16,
    pub routing_group: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderProjection {
    pub id: String,
    pub enabled: bool,
    pub provider_type: String,
    pub base_url: String,
    pub model_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ListenerHealthProjection {
    pub server_id: String,
    pub bind: String,
    pub port: u16,
    pub url: String,
    pub reachable: bool,
    pub http_status: Option<u16>,
    pub status: Option<String>,
    pub build_version: Option<String>,
    pub manifest_version: Option<u64>,
    pub reported_server_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ManagedInstanceProjection {
    pub state_root: String,
    pub instance_dir: String,
    pub instance_id: String,
    pub config_match: bool,
    pub config_path: Option<String>,
    pub config_digest: Option<String>,
    pub executable_path: Option<String>,
    pub state: Option<String>,
    pub status_updated_at_epoch_ms: Option<u64>,
    pub status_detail: Option<serde_json::Value>,
    pub pid: Option<u32>,
    pub pid_alive: Option<bool>,
    pub start_nonce: Option<String>,
    pub started_at_epoch_ms: Option<u64>,
    pub listeners: Vec<ManagedListenerProjection>,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ManagedListenerProjection {
    pub server_id: String,
    pub bind: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogFileProjection {
    pub path: String,
    pub exists: bool,
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HooksSidecarProjection {
    pub pid_file: String,
    pub pid_file_present: bool,
    pub socket_file: String,
    pub socket_present: bool,
}

async fn environment(State(state): State<AppState>) -> Json<EnvironmentProjection> {
    Json(build_environment(&state).await)
}

async fn build_environment(state: &AppState) -> EnvironmentProjection {
    let binary = read_binary_projection();
    let config = read_config_projection(state);
    let instances = read_instance_records();
    let instance = select_instance(&instances, &state.config_path)
        .map(|record| project_instance(record, &state.config_path));
    let listeners = probe_listeners(&config.servers).await;
    let logs = collect_log_files(&state.config_path, &config);
    let hooks_sidecar = instance.as_ref().map(|instance| HooksSidecarProjection {
        pid_file: Path::new(&instance.instance_dir)
            .join(HOOKS_SIDECAR_PID_FILE)
            .display()
            .to_string(),
        pid_file_present: Path::new(&instance.instance_dir)
            .join(HOOKS_SIDECAR_PID_FILE)
            .is_file(),
        socket_file: Path::new(&instance.instance_dir)
            .join(HOOKS_SIDECAR_SOCKET_FILE)
            .display()
            .to_string(),
        socket_present: Path::new(&instance.instance_dir)
            .join(HOOKS_SIDECAR_SOCKET_FILE)
            .exists(),
    });
    EnvironmentProjection {
        generated_at_epoch_ms: epoch_ms(),
        admin: project_admin(state),
        binary,
        config,
        instance,
        instances: instances
            .iter()
            .map(|record| record.instance_id.clone())
            .collect(),
        listeners,
        logs,
        hooks_sidecar,
    }
}

fn project_admin(state: &AppState) -> AdminProjection {
    // Authoring truth for the admin listener (the published manifest drops this section).
    match state.store.read_authoring() {
        Ok(authoring) => AdminProjection {
            enabled: authoring.admin_webui.enabled,
            bind: authoring.admin_webui.bind.clone(),
            port: authoring.admin_webui.port,
            source: "config.authoring.admin_webui".to_string(),
        },
        Err(error) => AdminProjection {
            enabled: false,
            bind: String::new(),
            port: 0,
            source: format!("unavailable: {error}"),
        },
    }
}

fn read_binary_projection() -> BinaryProjection {
    let executable = match std::env::current_exe() {
        Ok(path) => path,
        Err(error) => {
            return BinaryProjection {
                path: String::new(),
                version: None,
                sha256: None,
                size_bytes: None,
                error: Some(format!("current_exe failed: {error}")),
            }
        }
    };
    let version =
        routecodex_v3_config::resolve_routecodex_package_version_from_executable(&executable);
    match std::fs::read(&executable) {
        Ok(bytes) => BinaryProjection {
            path: executable.display().to_string(),
            version,
            sha256: Some(format!("{:x}", Sha256::digest(&bytes))),
            size_bytes: Some(bytes.len() as u64),
            error: None,
        },
        Err(error) => BinaryProjection {
            path: executable.display().to_string(),
            version,
            sha256: None,
            size_bytes: None,
            error: Some(format!("read {} failed: {error}", executable.display())),
        },
    }
}

fn read_config_projection(state: &AppState) -> ConfigProjection {
    let config_path = state.config_path.display().to_string();
    let sha256 = std::fs::read(&state.config_path)
        .map(|bytes| format!("{:x}", Sha256::digest(&bytes)))
        .ok();
    let authoring = match state.store.read_authoring() {
        Ok(authoring) => authoring,
        Err(error) => {
            return ConfigProjection {
                path: config_path,
                sha256,
                server_count: None,
                provider_count: None,
                route_group_count: None,
                debug_log_file: None,
                servers: Vec::new(),
                providers: Vec::new(),
                error: Some(format!("config authoring read failed: {error}")),
            }
        }
    };
    match state.store.validate(&authoring) {
        Ok(manifest) => ConfigProjection {
            path: config_path,
            sha256,
            server_count: Some(manifest.servers.len()),
            provider_count: Some(manifest.providers.len()),
            route_group_count: Some(manifest.route_groups.len()),
            debug_log_file: manifest.debug.log_file.clone(),
            servers: manifest
                .servers
                .values()
                .map(|server| ServerProjection {
                    id: server.id.clone(),
                    enabled: server.enabled,
                    bind: server.bind.clone(),
                    port: server.port,
                    routing_group: server.routing_group.clone(),
                })
                .collect(),
            providers: manifest
                .providers
                .values()
                .map(|provider| ProviderProjection {
                    id: provider.id.clone(),
                    enabled: provider.enabled,
                    provider_type: provider.provider_type.clone(),
                    base_url: provider.base_url.clone(),
                    model_count: provider.models.len(),
                })
                .collect(),
            error: None,
        },
        Err(error) => ConfigProjection {
            path: config_path,
            sha256,
            server_count: None,
            provider_count: None,
            route_group_count: None,
            debug_log_file: None,
            servers: Vec::new(),
            providers: Vec::new(),
            error: Some(format!("config compile failed: {error}")),
        },
    }
}

async fn probe_listeners(servers: &[ServerProjection]) -> Vec<ListenerHealthProjection> {
    let client = reqwest::Client::builder()
        .timeout(HEALTH_PROBE_TIMEOUT)
        .build();
    let client = match client {
        Ok(client) => client,
        Err(error) => {
            return servers
                .iter()
                .filter(|server| server.enabled)
                .map(|server| ListenerHealthProjection {
                    server_id: server.id.clone(),
                    bind: server.bind.clone(),
                    port: server.port,
                    url: format!("http://127.0.0.1:{}/health", server.port),
                    reachable: false,
                    http_status: None,
                    status: None,
                    build_version: None,
                    manifest_version: None,
                    reported_server_id: None,
                    error: Some(format!("http client build failed: {error}")),
                })
                .collect()
        }
    };
    let mut projections = Vec::new();
    for server in servers.iter().filter(|server| server.enabled) {
        let url = format!("http://127.0.0.1:{}/health", server.port);
        let mut projection = ListenerHealthProjection {
            server_id: server.id.clone(),
            bind: server.bind.clone(),
            port: server.port,
            url: url.clone(),
            reachable: false,
            http_status: None,
            status: None,
            build_version: None,
            manifest_version: None,
            reported_server_id: None,
            error: None,
        };
        match client.get(&url).send().await {
            Ok(response) => {
                let http_status = response.status().as_u16();
                projection.http_status = Some(http_status);
                projection.reachable = response.status().is_success();
                match response.text().await {
                    Ok(text) => match serde_json::from_str::<ListenerHealthBody>(&text) {
                        Ok(body) => {
                            projection.status = body.status;
                            projection.build_version = body.build_version;
                            projection.manifest_version = body.manifest_version;
                            projection.reported_server_id = body.server_id;
                            if !projection.reachable {
                                projection.error =
                                    Some(format!("listener returned HTTP {http_status}"));
                            }
                        }
                        Err(error) => {
                            projection.error = Some(format!(
                                "listener /health body is not the typed health projection: {error}"
                            ));
                        }
                    },
                    Err(error) => {
                        projection.error =
                            Some(format!("listener /health body read failed: {error}"));
                    }
                }
            }
            Err(error) => {
                projection.error = Some(format!("listener /health unreachable: {error}"));
            }
        }
        projections.push(projection);
    }
    projections
}

fn collect_log_files(config_path: &Path, config: &ConfigProjection) -> Vec<LogFileProjection> {
    let config_dir = config_path.parent().unwrap_or_else(|| Path::new("."));
    let mut paths: BTreeSet<PathBuf> = BTreeSet::new();
    match config.debug_log_file.as_deref() {
        Some(log_file) => {
            let path = PathBuf::from(log_file);
            paths.insert(if path.is_absolute() {
                path
            } else {
                config_dir.join(path)
            });
        }
        None => {
            for server in config.servers.iter().filter(|server| server.enabled) {
                paths.insert(
                    config_dir
                        .join("logs")
                        .join(format!("server-v3-{}.log", server.port)),
                );
            }
        }
    }
    paths
        .into_iter()
        .map(|path| {
            let metadata = std::fs::metadata(&path);
            LogFileProjection {
                exists: metadata.is_ok(),
                size_bytes: metadata.ok().map(|metadata| metadata.len()),
                path: path.display().to_string(),
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Managed lifecycle instance records (read-only projection of the lifecycle state root)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct ManagedInstanceDeclaration {
    instance_id: String,
    #[serde(default)]
    config_path: String,
    #[serde(default)]
    config_digest: String,
    #[serde(default)]
    executable_path: String,
    #[serde(default)]
    listeners: Vec<ManagedListenerDeclaration>,
}

#[derive(Debug, Deserialize)]
struct ManagedListenerDeclaration {
    #[serde(default)]
    server_id: String,
    #[serde(default)]
    bind: String,
    port: u16,
}

#[derive(Debug, Deserialize)]
struct ManagedStatusRecord {
    #[serde(default)]
    state: String,
    #[serde(default)]
    updated_at_epoch_ms: u64,
    #[serde(default)]
    detail: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct ManagedPidCache {
    #[serde(default)]
    pid: u32,
    #[serde(default)]
    start_nonce: String,
    #[serde(default)]
    started_at_epoch_ms: u64,
}

#[derive(Debug)]
struct ManagedInstanceRecord {
    instance_id: String,
    dir: PathBuf,
    declaration: Result<ManagedInstanceDeclaration, String>,
    status: Result<ManagedStatusRecord, String>,
    pid_cache: Result<ManagedPidCache, String>,
}

fn managed_state_root() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os(LIFECYCLE_STATE_DIR_ENV) {
        return Some(PathBuf::from(dir));
    }
    std::env::var_os("HOME").map(|home| {
        PathBuf::from(home)
            .join(".rcc")
            .join("state")
            .join("runtime-lifecycle")
            .join("v3")
    })
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|error| format!("{} read failed: {error}", path.display()))?;
    serde_json::from_str(&raw).map_err(|error| format!("{} parse failed: {error}", path.display()))
}

fn read_instance_records() -> Vec<ManagedInstanceRecord> {
    let Some(state_root) = managed_state_root() else {
        return Vec::new();
    };
    let instances_root = state_root.join("instances");
    let Ok(entries) = std::fs::read_dir(&instances_root) else {
        return Vec::new();
    };
    let mut records = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        records.push(ManagedInstanceRecord {
            instance_id: entry.file_name().to_string_lossy().to_string(),
            declaration: read_json(&dir.join("instance.json")),
            status: read_json(&dir.join("status.json")),
            pid_cache: read_json(&dir.join("pid.cache")),
            dir,
        });
    }
    records.sort_by(|left, right| left.instance_id.cmp(&right.instance_id));
    records
}

/// Prefer the instance whose published declaration points at the served config; otherwise
/// fall back to the most recently written instance and say so via `config_match: false`.
fn select_instance<'a>(
    records: &'a [ManagedInstanceRecord],
    served_config_path: &Path,
) -> Option<&'a ManagedInstanceRecord> {
    let served = std::fs::canonicalize(served_config_path).ok();
    if let Some(served) = served.as_deref() {
        if let Some(record) = records.iter().find(|record| {
            record
                .declaration
                .as_ref()
                .ok()
                .and_then(|declaration| std::fs::canonicalize(&declaration.config_path).ok())
                .as_deref()
                == Some(served)
        }) {
            return Some(record);
        }
    }
    records
        .iter()
        .max_by_key(|record| instance_updated_at(record))
}

fn instance_updated_at(record: &ManagedInstanceRecord) -> u64 {
    if let Ok(status) = &record.status {
        if status.updated_at_epoch_ms > 0 {
            return status.updated_at_epoch_ms;
        }
    }
    if let Ok(pid_cache) = &record.pid_cache {
        return pid_cache.started_at_epoch_ms;
    }
    std::fs::metadata(&record.dir)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn project_instance(
    record: &ManagedInstanceRecord,
    served_config_path: &Path,
) -> ManagedInstanceProjection {
    let mut errors = Vec::new();
    let declaration = record.declaration.as_ref().map_err(|error| {
        errors.push(error.clone());
        error
    });
    let status = record.status.as_ref().map_err(|error| {
        errors.push(error.clone());
        error
    });
    let pid_cache = record.pid_cache.as_ref().map_err(|error| {
        errors.push(error.clone());
        error
    });
    let config_match = match declaration {
        Ok(declaration) => {
            if declaration.instance_id != record.instance_id {
                errors.push(format!(
                    "instance.json declares instance_id {} but lives in directory {}",
                    declaration.instance_id, record.instance_id
                ));
            }
            match (
                std::fs::canonicalize(&declaration.config_path).ok(),
                std::fs::canonicalize(served_config_path).ok(),
            ) {
                (Some(declared), Some(served)) => declared == served,
                _ => false,
            }
        }
        Err(_) => false,
    };
    let pid = pid_cache.ok().map(|cache| cache.pid).filter(|pid| *pid > 0);
    ManagedInstanceProjection {
        state_root: managed_state_root()
            .map(|root| root.display().to_string())
            .unwrap_or_default(),
        instance_dir: record.dir.display().to_string(),
        instance_id: record.instance_id.clone(),
        config_match,
        config_path: declaration
            .ok()
            .map(|declaration| declaration.config_path.clone()),
        config_digest: declaration
            .ok()
            .map(|declaration| declaration.config_digest.clone()),
        executable_path: declaration
            .ok()
            .map(|declaration| declaration.executable_path.clone()),
        state: status.ok().map(|status| status.state.clone()),
        status_updated_at_epoch_ms: status
            .ok()
            .map(|status| status.updated_at_epoch_ms)
            .filter(|value| *value > 0),
        status_detail: status.ok().and_then(|status| status.detail.clone()),
        pid,
        pid_alive: pid.map(pid_is_alive),
        start_nonce: pid_cache
            .ok()
            .map(|cache| cache.start_nonce.clone())
            .filter(|value| !value.is_empty()),
        started_at_epoch_ms: pid_cache
            .ok()
            .map(|cache| cache.started_at_epoch_ms)
            .filter(|value| *value > 0),
        listeners: declaration
            .ok()
            .map(|declaration| {
                declaration
                    .listeners
                    .iter()
                    .map(|listener| ManagedListenerProjection {
                        server_id: listener.server_id.clone(),
                        bind: listener.bind.clone(),
                        port: listener.port,
                    })
                    .collect()
            })
            .unwrap_or_default(),
        errors,
    }
}

/// Explicit-PID liveness check (never a pattern kill). Falls back to absolute paths so the
/// projection does not depend on the caller's PATH.
fn pid_is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let pid_text = pid.to_string();
    for program in ["ps", "/bin/ps", "/usr/bin/ps"] {
        match Command::new(program)
            .args(["-p", &pid_text, "-o", "pid="])
            .output()
        {
            Ok(output) => {
                return output.status.success()
                    && !String::from_utf8_lossy(&output.stdout).trim().is_empty();
            }
            Err(_) => continue,
        }
    }
    false
}

// ---------------------------------------------------------------------------
// POST /api/environment/doctor
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct DoctorItem {
    pub id: String,
    pub status: String,
    pub detail: String,
    pub remediation: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DoctorReport {
    pub generated_at_epoch_ms: u64,
    pub status: String,
    pub items: Vec<DoctorItem>,
}

async fn doctor(State(state): State<AppState>) -> Json<DoctorReport> {
    Json(build_doctor(&state).await)
}

async fn build_doctor(state: &AppState) -> DoctorReport {
    let environment = build_environment(state).await;
    let mut items: Vec<DoctorItem> = Vec::new();

    // 1. config compile
    match &environment.config.error {
        None => items.push(item(
            "config.compile",
            "pass",
            format!(
                "config compiled: {} server(s), {} provider(s), {} route group(s)",
                environment.config.server_count.unwrap_or(0),
                environment.config.provider_count.unwrap_or(0),
                environment.config.route_group_count.unwrap_or(0),
            ),
            None,
        )),
        Some(error) => items.push(item(
            "config.compile",
            "fail",
            error.clone(),
            Some("fix the reported compile error and re-run doctor"),
        )),
    }

    // 2. per-listener health + build_version equality with the installed binary
    if environment.listeners.is_empty() && environment.config.error.is_none() {
        items.push(item(
            "listener.inventory",
            "warn",
            "no enabled server listener is declared by the served config".to_string(),
            Some("declare at least one [servers.<id>] block"),
        ));
    }
    for listener in &environment.listeners {
        if listener.reachable {
            items.push(item(
                &format!("listener.{}.reachable", listener.server_id),
                "pass",
                format!(
                    "GET {} returned HTTP {}",
                    listener.url,
                    listener.http_status.unwrap_or(0)
                ),
                None,
            ));
        } else {
            items.push(item(
                &format!("listener.{}.reachable", listener.server_id),
                "fail",
                format!(
                    "GET {} is not reachable: {}",
                    listener.url,
                    listener.error.as_deref().unwrap_or("unknown error")
                ),
                Some("start the runtime with `rccv3 restart -c <served config>`"),
            ));
        }
        let installed = environment.binary.version.as_deref();
        match (listener.build_version.as_deref(), installed) {
            (Some(observed), Some(installed)) if observed == installed => items.push(item(
                &format!("listener.{}.build_version", listener.server_id),
                "pass",
                format!("listener build_version {observed} matches the installed binary"),
                None,
            )),
            (Some(observed), Some(installed)) => items.push(item(
                &format!("listener.{}.build_version", listener.server_id),
                "fail",
                format!(
                    "listener build_version {observed} differs from the installed binary {installed} (install/run drift)"
                ),
                Some("reinstall the CLI and restart the runtime so the listener loads the installed binary"),
            )),
            (Some(observed), None) => items.push(item(
                &format!("listener.{}.build_version", listener.server_id),
                "warn",
                format!("listener reports build_version {observed} but the installed binary version is unknown"),
                None,
            )),
            (None, _) => items.push(item(
                &format!("listener.{}.build_version", listener.server_id),
                "warn",
                "listener /health did not report build_version".to_string(),
                None,
            )),
        }
    }

    // 3. managed instance status.json vs live PID consistency
    match &environment.instance {
        None => items.push(item(
            "instance.pid_consistency",
            "warn",
            format!(
                "no managed lifecycle instance record under {}",
                managed_state_root()
                    .map(|root| root.display().to_string())
                    .unwrap_or_else(|| "<unknown state root>".to_string())
            ),
            Some("start the managed runtime: `rccv3 restart -c <served config>`"),
        )),
        Some(instance) => {
            if !instance.config_match {
                items.push(item(
                    "instance.config_match",
                    "warn",
                    format!(
                        "managed instance {} was not published for the served config; its instance.json points at {}",
                        instance.instance_id,
                        instance.config_path.as_deref().unwrap_or("unknown")
                    ),
                    Some("restart the served config so the instance declaration matches it"),
                ));
            }
            let state_name = instance.state.as_deref().unwrap_or("unknown");
            match (state_name, instance.pid, instance.pid_alive) {
                ("running", Some(pid), Some(true)) => items.push(item(
                    "instance.pid_consistency",
                    "pass",
                    format!(
                        "instance {} is running with live PID {pid}",
                        instance.instance_id
                    ),
                    None,
                )),
                ("running", Some(pid), _) => items.push(item(
                    "instance.pid_consistency",
                    "fail",
                    format!(
                        "instance {} reports state running but PID {pid} is not alive",
                        instance.instance_id
                    ),
                    Some("restart the runtime to republish a live instance record"),
                )),
                ("running", None, _) => items.push(item(
                    "instance.pid_consistency",
                    "fail",
                    format!(
                        "instance {} reports state running but no usable pid.cache exists",
                        instance.instance_id
                    ),
                    Some("restart the runtime to republish a live instance record"),
                )),
                (state_name, Some(pid), Some(true)) => items.push(item(
                    "instance.pid_consistency",
                    "warn",
                    format!(
                        "instance {} reports state {state_name} but PID {pid} is still alive",
                        instance.instance_id
                    ),
                    Some("inspect the managed instance before restarting it"),
                )),
                (state_name, _, _) => items.push(item(
                    "instance.pid_consistency",
                    "pass",
                    format!(
                        "instance {} reports state {state_name} with no live managed PID",
                        instance.instance_id
                    ),
                    None,
                )),
            }
        }
    }

    // 4. default-config-path ambiguity
    items.push(default_config_path_item(state));

    // 5. admin port vs declared server ports
    items.push(admin_port_conflict_item(&environment));

    // 6. provider inventory
    items.extend(provider_inventory_items(state, &environment));

    // 7. per-port request-records JSONL size vs the 64MB halving threshold
    items.extend(request_records_size_items(state, &environment));

    // 8. local admin token provisioning
    match state.admin_token.as_deref() {
        Some(_) => items.push(item(
            "admin.token",
            "pass",
            "local admin token is provisioned; mutating endpoints require it".to_string(),
            None,
        )),
        None => items.push(item(
            "admin.token",
            "fail",
            "local admin token is not provisioned; mutating endpoints fail closed with 503".to_string(),
            Some(
                "make the config directory writable so <config_dir>/state/admin-token (0600) can be created, then restart the admin",
            ),
        )),
    }

    DoctorReport {
        generated_at_epoch_ms: epoch_ms(),
        status: aggregate_status(&items),
        items,
    }
}

fn aggregate_status(items: &[DoctorItem]) -> String {
    if items.iter().any(|item| item.status == "fail") {
        return "fail".to_string();
    }
    if items.iter().any(|item| item.status == "warn") {
        return "warn".to_string();
    }
    "pass".to_string()
}

fn item(
    id: &str,
    status: &str,
    detail: impl Into<String>,
    remediation: Option<&str>,
) -> DoctorItem {
    DoctorItem {
        id: id.to_string(),
        status: status.to_string(),
        detail: detail.into(),
        remediation: remediation.map(str::to_string),
    }
}

fn default_config_path_item(state: &AppState) -> DoctorItem {
    let Some(home) = std::env::var_os("HOME") else {
        return item(
            "config.default_path_ambiguity",
            "warn",
            "HOME is unset, so the default config path cannot be checked".to_string(),
            None,
        );
    };
    let default_path = PathBuf::from(&home).join(".rcc").join("config.toml");
    let legacy_path = PathBuf::from(&home).join(".rcc").join("config.v3.toml");
    let served = std::fs::canonicalize(&state.config_path).ok();
    let default_exists = default_path.is_file();
    let legacy_exists = legacy_path.is_file();
    let served_is_default = served.is_some()
        && std::fs::canonicalize(&default_path).ok().as_deref() == served.as_deref();
    if default_exists && legacy_exists {
        return item(
            "config.default_path_ambiguity",
            "warn",
            format!(
                "both {} and {} exist; the admin serves {}",
                default_path.display(),
                legacy_path.display(),
                state.config_path.display()
            ),
            Some("keep one config path as the single source and remove or rename the other"),
        );
    }
    if !served_is_default && default_exists {
        return item(
            "config.default_path_ambiguity",
            "warn",
            format!(
                "the admin serves {} but the CLI default {} exists",
                state.config_path.display(),
                default_path.display()
            ),
            Some(
                "run CLI commands with `-c <served config>` or point the admin at the default path",
            ),
        );
    }
    item(
        "config.default_path_ambiguity",
        "pass",
        format!(
            "served config {} is the only default-path candidate present",
            state.config_path.display()
        ),
        None,
    )
}

fn admin_port_conflict_item(environment: &EnvironmentProjection) -> DoctorItem {
    if !environment.admin.enabled || environment.admin.port == 0 {
        return item(
            "admin.port_conflict",
            "warn",
            format!(
                "admin listener bind/port is unavailable ({})",
                environment.admin.source
            ),
            None,
        );
    }
    let conflicts: Vec<String> = environment
        .config
        .servers
        .iter()
        .filter(|server| server.enabled && server.port == environment.admin.port)
        .map(|server| format!("{} ({}:{})", server.id, server.bind, server.port))
        .collect();
    if conflicts.is_empty() {
        return item(
            "admin.port_conflict",
            "pass",
            format!(
                "admin listener {}:{} shares no port with an enabled server",
                environment.admin.bind, environment.admin.port
            ),
            None,
        );
    }
    item(
        "admin.port_conflict",
        "fail",
        format!(
            "admin listener port {} collides with enabled server(s): {}",
            environment.admin.port,
            conflicts.join(", ")
        ),
        Some("change the admin_webui port or the colliding server port"),
    )
}

fn provider_inventory_items(
    state: &AppState,
    environment: &EnvironmentProjection,
) -> Vec<DoctorItem> {
    let config_dir = state.config_path.parent().unwrap_or_else(|| Path::new("."));
    let present = match list_provider_ids(config_dir) {
        Ok(ids) => ids,
        Err(error) => {
            return vec![item(
                "provider.inventory",
                "fail",
                error,
                Some("make the provider directory readable"),
            )]
        }
    };
    let mut items = Vec::new();
    let referenced: BTreeSet<String> = environment
        .config
        .providers
        .iter()
        .map(|provider| provider.id.clone())
        .collect();
    let missing: Vec<String> = referenced
        .iter()
        .filter(|id| !present.contains(id))
        .cloned()
        .collect();
    if missing.is_empty() {
        items.push(item(
            "provider.inventory.referenced_missing",
            "pass",
            format!(
                "all {} referenced provider(s) have a config file",
                referenced.len()
            ),
            None,
        ));
    } else {
        items.push(item(
            "provider.inventory.referenced_missing",
            "fail",
            format!(
                "referenced provider(s) without a config file under {}: {}",
                config_dir.join("provider").display(),
                missing.join(", ")
            ),
            Some("create the missing provider file or remove the routing reference"),
        ));
    }
    let unreferenced: Vec<String> = present
        .iter()
        .filter(|id| !referenced.contains(*id))
        .cloned()
        .collect();
    if unreferenced.is_empty() {
        items.push(item(
            "provider.inventory.unreferenced",
            "pass",
            "no provider file is left unreferenced".to_string(),
            None,
        ));
    } else {
        items.push(item(
            "provider.inventory.unreferenced",
            "warn",
            format!(
                "provider file(s) not referenced by any route: {}",
                unreferenced.join(", ")
            ),
            Some("reference them from a route pool or remove them"),
        ));
    }
    for id in &present {
        let entry = match read_provider_file(config_dir, id) {
            Ok(entry) => entry,
            Err(error) => {
                items.push(item(
                    &format!("provider.{id}.parse"),
                    "fail",
                    error,
                    Some("fix the provider file so it parses as a v2 provider config"),
                ));
                continue;
            }
        };
        let is_referenced = referenced.contains(id);
        if entry.config.provider.models.is_empty() {
            items.push(item(
                &format!("provider.{id}.models"),
                if is_referenced { "fail" } else { "warn" },
                format!("provider {id} declares an empty model list"),
                Some("declare at least one [provider.models.<model>] entry"),
            ));
        }
        let auth = &entry.config.provider.auth;
        let has_handle = auth.api_key.is_some()
            || auth.env.is_some()
            || auth.token_file.is_some()
            || auth.secret_file.is_some()
            || auth
                .entries
                .as_ref()
                .is_some_and(|entries| !entries.is_empty());
        if !has_handle {
            items.push(item(
                &format!("provider.{id}.auth"),
                if is_referenced { "fail" } else { "warn" },
                format!("provider {id} declares no auth handle (apiKey/env/tokenFile/secretFile/entries)"),
                Some("declare a provider auth handle so provider requests can authenticate"),
            ));
        }
    }
    items
}

fn request_records_size_items(
    state: &AppState,
    environment: &EnvironmentProjection,
) -> Vec<DoctorItem> {
    let mut items = Vec::new();
    for server in environment
        .config
        .servers
        .iter()
        .filter(|server| server.enabled)
    {
        let path = routecodex_v3_config::v3_webui_observability_store_path(
            &state.config_path,
            environment.config.debug_log_file.as_deref(),
            server.port,
        );
        let size = std::fs::metadata(&path).map(|metadata| metadata.len()).ok();
        match size {
            None => items.push(item(
                &format!("request_records.{}.size", server.port),
                "pass",
                format!("{} is absent (no request records persisted yet)", path.display()),
                None,
            )),
            Some(bytes) if bytes >= REQUEST_RECORDS_HISTORY_LIMIT_BYTES => items.push(item(
                &format!("request_records.{}.size", server.port),
                "warn",
                format!(
                    "{} is {bytes} bytes, at or above the {REQUEST_RECORDS_HISTORY_LIMIT_BYTES} byte retention threshold",
                    path.display()
                ),
                Some("verify the runtime retention owner is running; a live server halves the store when it exceeds the limit"),
            )),
            Some(bytes) => items.push(item(
                &format!("request_records.{}.size", server.port),
                "pass",
                format!(
                    "{} is {bytes} bytes, below the {REQUEST_RECORDS_HISTORY_LIMIT_BYTES} byte retention threshold",
                    path.display()
                ),
                None,
            )),
        }
    }
    items
}

#[derive(Debug, Deserialize)]
struct ListenerHealthBody {
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    build_version: Option<String>,
    #[serde(default)]
    manifest_version: Option<u64>,
    #[serde(default)]
    server_id: Option<String>,
}

// ---------------------------------------------------------------------------
// POST /api/runtime/restart
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct RestartResult {
    pub ok: bool,
    pub exit_code: Option<i32>,
    pub stdout_tail: Option<String>,
    pub stderr_tail: Option<String>,
    pub duration_ms: u64,
    pub executable: Option<String>,
    pub command: Option<String>,
    pub error: Option<String>,
}

async fn restart_runtime(State(state): State<AppState>) -> Json<RestartResult> {
    Json(run_lifecycle_restart(&state.config_path).await)
}

/// Resolve the managed lifecycle CLI: sibling of the running executable first, then PATH.
pub fn resolve_lifecycle_executable() -> Option<PathBuf> {
    let sibling_dir = std::env::current_exe()
        .ok()
        .and_then(|executable| executable.parent().map(Path::to_path_buf));
    let path_env = std::env::var_os("PATH");
    resolve_lifecycle_executable_in(sibling_dir.as_deref(), path_env.as_deref())
}

/// Pure resolution helper (no environment access) so the search rule stays testable.
pub fn resolve_lifecycle_executable_in(
    sibling_dir: Option<&Path>,
    path_env: Option<&OsStr>,
) -> Option<PathBuf> {
    if let Some(dir) = sibling_dir {
        if let Some(candidate) = lifecycle_candidate_in(dir) {
            return Some(candidate);
        }
    }
    for dir in std::env::split_paths(path_env?) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        if let Some(candidate) = lifecycle_candidate_in(&dir) {
            return Some(candidate);
        }
    }
    None
}

fn lifecycle_candidate_in(dir: &Path) -> Option<PathBuf> {
    for name in ["rccv3", "rccv3.exe"] {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

pub(crate) async fn run_lifecycle_restart(config_path: &Path) -> RestartResult {
    let Some(executable) = resolve_lifecycle_executable() else {
        return RestartResult {
            ok: false,
            exit_code: None,
            stdout_tail: None,
            stderr_tail: None,
            duration_ms: 0,
            executable: None,
            command: None,
            error: Some(
                "managed lifecycle CLI `rccv3` was not found next to the running executable or on PATH; restart was not attempted"
                    .to_string(),
            ),
        };
    };
    let command_line = format!(
        "{} restart -c {}",
        executable.display(),
        config_path.display()
    );
    let started = Instant::now();
    let executable_for_task = executable.clone();
    let config_for_task = config_path.to_path_buf();
    let output = tokio::task::spawn_blocking(move || {
        Command::new(&executable_for_task)
            .arg("restart")
            .arg("-c")
            .arg(&config_for_task)
            .output()
    })
    .await;
    let duration_ms = started.elapsed().as_millis() as u64;
    match output {
        Ok(Ok(output)) => {
            let ok = output.status.success();
            RestartResult {
                ok,
                exit_code: output.status.code(),
                stdout_tail: tail_of(&output.stdout),
                stderr_tail: tail_of(&output.stderr),
                duration_ms,
                executable: Some(executable.display().to_string()),
                command: Some(command_line),
                error: if ok {
                    None
                } else {
                    Some(format!(
                        "`rccv3 restart -c {}` exited with {:?}",
                        config_path.display(),
                        output.status.code()
                    ))
                },
            }
        }
        Ok(Err(error)) => RestartResult {
            ok: false,
            exit_code: None,
            stdout_tail: None,
            stderr_tail: None,
            duration_ms,
            executable: Some(executable.display().to_string()),
            command: Some(command_line.clone()),
            error: Some(format!("failed to execute `{command_line}`: {error}")),
        },
        Err(error) => RestartResult {
            ok: false,
            exit_code: None,
            stdout_tail: None,
            stderr_tail: None,
            duration_ms,
            executable: Some(executable.display().to_string()),
            command: Some(command_line),
            error: Some(format!("restart task failed: {error}")),
        },
    }
}

pub(crate) fn tail_of(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let tail: Vec<&str> = text.lines().rev().take(OUTPUT_TAIL_LINES).collect();
    Some(tail.iter().rev().cloned().collect::<Vec<_>>().join("\n"))
}

fn epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

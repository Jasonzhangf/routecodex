// feature_id: v3.admin_providers
// Providers API：provider 列表/详情、路由引用、runtime 冷却健康投影与 ad-hoc 诊断。
//
// 健康真相唯一来源是 runtime 进程内的 provider cooldown 投影
// （每个 listener 的 `/_routecodex/health/cooldown-pool`）。Admin 不维护第二份
// provider health 状态：`POST /api/providers/:id/health-test` 只是一次带 provider
// 真实凭据的 ad-hoc 上游诊断，结果内联返回，绝不并入 provider health。
use crate::AppState;
use axum::extract::{Path as AxumPath, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use routecodex_v3_config::V2ProviderConfigFile;
use routecodex_v3_config_mgmt::provider::compile_provider_candidate_manifest;
use routecodex_v3_config_mgmt::{
    forwarders_from_authoring, list_provider_ids, read_provider_file, route_groups_from_authoring,
};
use routecodex_v3_provider_responses::{discover_v3_provider_models, V3ProviderError};
use routecodex_v3_runtime::build_v3_provider_global_probe_target;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/providers", get(list_providers))
        .route("/api/providers/:id", get(provider_detail))
        .route("/api/providers/:id/health", get(provider_runtime_health))
        .route("/api/providers/:id/health-test", post(health_test))
}

pub fn provider_ids(config_dir: &Path) -> Vec<String> {
    list_provider_ids(config_dir).unwrap_or_default()
}

pub fn provider_enabled(config_dir: &Path, provider_id: &str) -> Option<bool> {
    read_provider_file(config_dir, provider_id)
        .ok()
        .and_then(|entry| entry.config.provider.enabled)
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderListItem {
    pub id: String,
    pub enabled: bool,
    pub provider_type: String,
    pub base_url: String,
    pub default_model: String,
    pub models_count: usize,
    /// 路由引用数（pool tier member + forwarder target）。0 表示该 provider 未被任何路由引用。
    pub reference_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderReference {
    pub group: String,
    pub port: u16,
    pub pool: String,
    pub priority: i32,
    pub model: Option<String>,
    pub key: Option<String>,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderDetail {
    pub id: String,
    pub config: V2ProviderConfigFile,
    pub references: Vec<ProviderReference>,
    pub forwarder_references: Vec<String>,
}

/// 收集引用某 provider 的路由位置（pool tier member）与 forwarder target 名称。
pub fn collect_provider_references(
    authoring: &routecodex_v3_config::V3Config02AuthoringParsed,
    provider_id: &str,
) -> (Vec<ProviderReference>, Vec<String>) {
    let mut references = Vec::new();
    for group in route_groups_from_authoring(authoring) {
        for port in &group.ports {
            for pool in &port.pools {
                for tier in &pool.tiers {
                    for member in &tier.members {
                        if member.provider.as_deref() == Some(provider_id) {
                            references.push(ProviderReference {
                                group: group.group_id.clone(),
                                port: port.port,
                                pool: pool.name.clone(),
                                priority: tier.priority,
                                model: member.model.clone(),
                                key: member.key.clone(),
                                kind: format!("{:?}", member.kind),
                            });
                        }
                    }
                }
            }
        }
    }
    let forwarder_references = forwarders_from_authoring(authoring)
        .into_iter()
        .filter(|(_, forwarder)| {
            forwarder
                .targets
                .iter()
                .any(|target| target.provider.as_deref() == Some(provider_id))
        })
        .map(|(name, _)| name)
        .collect::<Vec<_>>();
    (references, forwarder_references)
}

async fn list_providers(State(state): State<AppState>) -> Json<Vec<ProviderListItem>> {
    let config_dir = config_dir(&state);
    let ids = provider_ids(&config_dir);
    let authoring = state.store.read_authoring().ok();
    let mut items = Vec::new();
    for id in &ids {
        if let Ok(entry) = read_provider_file(&config_dir, id) {
            let reference_count = authoring
                .as_ref()
                .map(|authoring| {
                    let (references, forwarders) = collect_provider_references(authoring, id);
                    references.len() + forwarders.len()
                })
                .unwrap_or(0);
            items.push(ProviderListItem {
                id: id.clone(),
                enabled: entry.config.provider.enabled.unwrap_or(true),
                provider_type: entry.config.provider.provider_type.clone(),
                base_url: entry.config.provider.base_url.clone(),
                default_model: entry.config.provider.default_model.clone(),
                models_count: entry.config.provider.models.len(),
                reference_count,
            });
        }
    }
    Json(items)
}

async fn provider_detail(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<ProviderDetail>, (axum::http::StatusCode, String)> {
    let config_dir = config_dir(&state);
    let entry = read_provider_file(&config_dir, &id)
        .map_err(|error| (axum::http::StatusCode::NOT_FOUND, error))?;
    let authoring = state.store.read_authoring().map_err(|error| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            error.to_string(),
        )
    })?;
    let (references, forwarder_references) = collect_provider_references(&authoring, &id);
    Ok(Json(ProviderDetail {
        id,
        config: entry.config,
        references,
        forwarder_references,
    }))
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderHealthListenerProjection {
    pub port: u16,
    pub server_id: Option<String>,
    pub reachable: bool,
    pub error: Option<String>,
    /// 该 listener 上属于本 provider 的 cooldown 条目（runtime 原样投影）。
    pub entries: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderRuntimeHealth {
    pub provider_id: String,
    /// 唯一真源标识：runtime 进程内 cooldown 投影，不是 admin 侧缓存。
    pub source: &'static str,
    pub observed_at_epoch_ms: u64,
    /// 任一 listener 报告该 provider 处于冷却中。
    pub cooled: bool,
    pub listeners: Vec<ProviderHealthListenerProjection>,
}

/// GET /api/providers/:id/health — runtime cooldown truth。
///
/// 逐个读取已配置 listener 的 loopback cooldown 投影并按 provider 过滤。
/// 任一 listener 不可达即显式失败（502），不回退到任何 admin 侧缓存。
async fn provider_runtime_health(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<ProviderRuntimeHealth>, (axum::http::StatusCode, String)> {
    let config_dir = config_dir(&state);
    read_provider_file(&config_dir, &id)
        .map_err(|error| (axum::http::StatusCode::NOT_FOUND, error))?;
    let ports =
        configured_ports(&state).map_err(|error| (axum::http::StatusCode::BAD_GATEWAY, error))?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|error| {
            (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("health client build failed: {error}"),
            )
        })?;
    let mut listeners = Vec::new();
    for port in ports {
        let url = format!("http://127.0.0.1:{port}/_routecodex/health/cooldown-pool");
        let response = client.get(&url).send().await.map_err(|error| {
            (
                axum::http::StatusCode::BAD_GATEWAY,
                format!("runtime listener {port} unavailable: {error}"),
            )
        })?;
        let status = response.status();
        let body =
            response
                .json::<serde_json::Value>()
                .await
                .map_err(|error| {
                    (
                axum::http::StatusCode::BAD_GATEWAY,
                format!("runtime listener {port} returned an invalid cooldown projection: {error}"),
            )
                })?;
        if !status.is_success() {
            return Err((
                axum::http::StatusCode::BAD_GATEWAY,
                format!(
                    "runtime listener {port} cooldown projection failed with HTTP {}: {body}",
                    status.as_u16()
                ),
            ));
        }
        let entries = body
            .get("entries")
            .and_then(serde_json::Value::as_array)
            .map(|entries| {
                entries
                    .iter()
                    .filter(|entry| {
                        entry.get("provider_id").and_then(serde_json::Value::as_str)
                            == Some(id.as_str())
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        listeners.push(ProviderHealthListenerProjection {
            port,
            server_id: body
                .get("server_id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            reachable: true,
            error: None,
            entries,
        });
    }
    let cooled = listeners
        .iter()
        .any(|listener| !listener.entries.is_empty());
    Ok(Json(ProviderRuntimeHealth {
        provider_id: id,
        source: "runtime_cooldown_pool",
        observed_at_epoch_ms: now_ms(),
        cooled,
        listeners,
    }))
}

#[derive(Debug, Clone, Serialize)]
pub struct AdHocHealthTestResult {
    pub provider_id: String,
    /// 显式声明该结果是 ad-hoc 诊断，不是 provider health 真相。
    pub diagnostic: &'static str,
    /// 该诊断访问的 provider base URL；具体请求路径由 discovery 入口按协议决定。
    pub url: String,
    /// 本次诊断实际使用的鉴权方式：`provider_auth_handle` 或 `no_credential`。
    pub auth_mode: &'static str,
    pub ok: bool,
    /// 上游拒绝本次调用时的真实状态码。成功时上游的 2xx 具体码不在 discovery
    /// 契约内，因此如实为 `None`，不猜一个 200。
    pub status: Option<u16>,
    pub latency_ms: u64,
    pub error: Option<String>,
}

/// 上游拒绝状态码：`discover_v3_provider_models` 把非 2xx 响应编码为
/// `Transport { reason }`，reason 的固定后缀是 `returned HTTP {status}`
/// （唯一生产者见 provider-responses/src/transport.rs）。该变体不携带结构化
/// status，所以按该固定格式提取；提取不到就如实返回 `None`，绝不编造状态码。
fn discovery_upstream_status(error: &V3ProviderError) -> Option<u16> {
    let V3ProviderError::Transport { reason, .. } = error else {
        return None;
    };
    let (_, status) = reason.rsplit_once("returned HTTP ")?;
    status.trim().parse::<u16>().ok()
}

/// POST /api/providers/:id/health-test — 带 provider 真实凭据的 ad-hoc 上游诊断。
///
/// 走与 `POST /api/providers/discover` 完全相同的认证入口
/// (`discover_v3_provider_models`)：凭据解析、协议路径与传输实现都归
/// `routecodex-v3-provider-responses` 所有，本 handler 不实现第二条上游调用，
/// 也不再存在未认证的 `GET {baseURL}/models` 路径。
/// 结果内联返回，绝不写入或并入 provider health；当前 health 的唯一读取入口是
/// `GET /api/providers/:id/health`（runtime cooldown 投影）。
async fn health_test(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<AdHocHealthTestResult>, (axum::http::StatusCode, String)> {
    let config_dir = config_dir(&state);
    let entry = read_provider_file(&config_dir, &id)
        .map_err(|error| (axum::http::StatusCode::NOT_FOUND, error))?;
    let manifest = compile_provider_candidate_manifest(&id, &entry.config)
        .map_err(|error| (axum::http::StatusCode::UNPROCESSABLE_ENTITY, error))?;
    let target = build_v3_provider_global_probe_target(&manifest, &id, None, None)
        .map_err(|error| (axum::http::StatusCode::UNPROCESSABLE_ENTITY, error))?;
    let started = std::time::Instant::now();
    let result =
        discover_v3_provider_models(&id, &target.provider_type, &target.base_url, &target.auth)
            .await;
    let latency_ms = started.elapsed().as_millis() as u64;
    let mut outcome = AdHocHealthTestResult {
        provider_id: id,
        diagnostic: "ad-hoc authenticated upstream call through the provider auth handle; not provider health truth",
        url: target.base_url.clone(),
        auth_mode: "provider_auth_handle",
        ok: false,
        status: None,
        latency_ms,
        error: None,
    };
    match result {
        Ok(_) => outcome.ok = true,
        Err(error) => {
            outcome.status = discovery_upstream_status(&error);
            match &error {
                V3ProviderError::MissingAuthSecret { auth_alias, .. } => {
                    outcome.auth_mode = "no_credential";
                    outcome.error = Some(format!(
                        "provider has no credential for auth handle {auth_alias:?}; configure the credential before testing"
                    ));
                }
                V3ProviderError::AuthSecretRead {
                    auth_alias, reason, ..
                } => {
                    outcome.auth_mode = "no_credential";
                    outcome.error = Some(format!(
                        "credential for auth handle {auth_alias:?} could not be read: {reason}"
                    ));
                }
                other => outcome.error = Some(other.to_string()),
            }
        }
    }
    Ok(Json(outcome))
}

pub(crate) fn configured_ports(state: &AppState) -> Result<Vec<u16>, String> {
    let authoring = state
        .store
        .read_authoring()
        .map_err(|error| format!("provider health config read failed: {error}"))?;
    let mut ports = authoring
        .servers
        .values()
        .filter(|server| server.enabled)
        .map(|server| server.port)
        .collect::<Vec<_>>();
    ports.sort_unstable();
    ports.dedup();
    if ports.is_empty() {
        return Err("no enabled listener to read runtime provider health from".to_string());
    }
    Ok(ports)
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn config_dir(state: &AppState) -> PathBuf {
    state
        .config_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

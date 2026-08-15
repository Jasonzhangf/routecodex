// feature_id: v3.admin_providers
// Providers API：provider 列表/详情/更新/health test 与路由引用。
use crate::{AppState, ProviderHealthEntry};
use axum::extract::{Path as AxumPath, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use routecodex_v3_config::V2ProviderConfigFile;
use routecodex_v3_config_mgmt::{
    list_provider_ids, read_provider_file, route_groups_from_authoring, write_provider_file,
    forwarders_from_authoring,
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/providers", get(list_providers))
        .route("/api/providers/:id", get(provider_detail).put(update_provider))
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
    pub health: Option<ProviderHealthEntry>,
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
    pub health: Option<ProviderHealthEntry>,
}

async fn list_providers(State(state): State<AppState>) -> Json<Vec<ProviderListItem>> {
    let config_dir = config_dir(&state);
    let ids = provider_ids(&config_dir);
    let health_cache = state.health_cache.lock().await;
    let mut items = Vec::new();
    for id in &ids {
        if let Ok(entry) = read_provider_file(&config_dir, id) {
            items.push(ProviderListItem {
                id: id.clone(),
                enabled: entry.config.provider.enabled.unwrap_or(true),
                provider_type: entry.config.provider.provider_type.clone(),
                base_url: entry.config.provider.base_url.clone(),
                default_model: entry.config.provider.default_model.clone(),
                models_count: entry.config.provider.models.len(),
                health: health_cache.get(id).cloned(),
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
    let authoring = state
        .store
        .read_authoring()
        .map_err(|error| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    let mut references = Vec::new();
    for group in route_groups_from_authoring(&authoring) {
        for port in &group.ports {
            for pool in &port.pools {
                for tier in &pool.tiers {
                    for member in &tier.members {
                        if member.provider.as_deref() == Some(id.as_str()) {
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
    let forwarder_references = forwarders_from_authoring(&authoring)
        .into_iter()
        .filter(|(_, forwarder)| {
            forwarder
                .targets
                .iter()
                .any(|target| target.provider.as_deref() == Some(id.as_str()))
        })
        .map(|(name, _)| name)
        .collect::<Vec<_>>();
    let health = state.health_cache.lock().await.get(&id).cloned();
    Ok(Json(ProviderDetail {
        id,
        config: entry.config,
        references,
        forwarder_references,
        health,
    }))
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct UpdateProviderRequest {
    pub config: V2ProviderConfigFile,
    pub reason: Option<String>,
}

async fn update_provider(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<UpdateProviderRequest>,
) -> Result<Json<serde_json::Value>, (axum::http::StatusCode, String)> {
    let config_dir = config_dir(&state);
    if request.config.provider.id != id {
        return Err((
            axum::http::StatusCode::BAD_REQUEST,
            format!("config id {} does not match path {id}", request.config.provider.id),
        ));
    }
    let path = write_provider_file(&config_dir, &id, &request.config)
        .map_err(|error| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, error))?;
    state
        .store
        .revision_store()
        .append(
            "provider.update",
            &format!("provider/{id}/config.v2.toml"),
            request.reason.as_deref().unwrap_or("webui update"),
            Some(&path),
            "provider-file",
            "committed",
        )
        .map_err(|error| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    Ok(Json(serde_json::json!({ "ok": true, "provider": id, "path": path.display().to_string() })))
}

async fn health_test(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<ProviderHealthEntry>, (axum::http::StatusCode, String)> {
    let config_dir = config_dir(&state);
    let entry = read_provider_file(&config_dir, &id)
        .map_err(|error| (axum::http::StatusCode::NOT_FOUND, error))?;
    let base_url = entry.config.provider.base_url.clone();
    let started = std::time::Instant::now();
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        reqwest::Client::builder()
            .build()
            .expect("client")
            .get(&url)
            .send(),
    )
    .await;
    let latency_ms = started.elapsed().as_millis() as u64;
    let health = match result {
        Ok(Ok(response)) => ProviderHealthEntry {
            tested_at_epoch_ms: now_ms(),
            ok: response.status().is_success(),
            latency_ms,
            error: if response.status().is_success() {
                None
            } else {
                Some(format!("HTTP {}", response.status().as_u16()))
            },
        },
        Ok(Err(error)) => ProviderHealthEntry {
            tested_at_epoch_ms: now_ms(),
            ok: false,
            latency_ms,
            error: Some(format!("HTTP 0 ({error})")),
        },
        Err(_) => ProviderHealthEntry {
            tested_at_epoch_ms: now_ms(),
            ok: false,
            latency_ms,
            error: Some("timeout after 5s".to_string()),
        },
    };
    state.health_cache.lock().await.insert(id.clone(), health.clone());
    Ok(Json(health))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn config_dir(state: &AppState) -> PathBuf {
    state
        .config_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

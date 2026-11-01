// feature_id: v3.admin_dashboard
// Dashboard API：runtime/port/provider 状态、流量概览、修订历史。
use crate::{metrics, AppState};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/overview", get(overview))
}

#[derive(Debug, Clone, Serialize)]
pub struct PortStatus {
    pub server_id: String,
    pub port: u16,
    pub endpoints: Vec<String>,
    pub healthy: bool,
    pub http_status: u16,
    pub traffic_received: u64,
    pub traffic_provider_errors: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderSummary {
    pub total: usize,
    pub enabled: usize,
    pub disabled: usize,
    pub configured: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrafficSummary {
    pub total_requests: u64,
    pub daily_requests: u64,
    pub last_request_at_epoch_ms: Option<u64>,
    pub persisted_received: u64,
    pub persisted_provider_errors: u64,
    pub route_targets: BTreeMap<String, u64>,
    pub store_sources: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeStatus {
    pub managed_instance: Option<crate::metrics::ManagedInstanceStatus>,
    pub ports: Vec<PortStatus>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Overview {
    pub runtime: RuntimeStatus,
    pub providers: ProviderSummary,
    pub traffic: TrafficSummary,
    pub revisions: Vec<routecodex_v3_config_mgmt::ConfigRevision>,
}

async fn overview(State(state): State<AppState>) -> Response {
    let config_dir = state
        .config_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    let authoring = match state.store.read_authoring() {
        Ok(authoring) => authoring,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("observability config read failed: {error}") })),
            )
                .into_response();
        }
    };
    let servers: Vec<_> = authoring.servers.iter().collect();

    let mut probes = Vec::new();
    for (server_id, server) in &servers {
        probes.push(probe_port(
            server_id.to_string(),
            server.port,
            server.endpoints.clone(),
        ));
    }
    let port_statuses: Vec<PortStatus> = futures_join_all(probes).await;

    let provider_ids = crate::api::providers::provider_ids(&config_dir);
    let (enabled, disabled) = {
        let mut enabled = 0usize;
        let mut disabled = 0usize;
        for id in &provider_ids {
            match crate::api::providers::provider_enabled(&config_dir, id) {
                Some(true) => enabled += 1,
                Some(false) => disabled += 1,
                None => {}
            }
        }
        (enabled, disabled)
    };

    let counter_path = config_dir.join("state").join("global-request-counter.json");
    let counter = read_request_counter(&counter_path);

    // Store sources keep the authoring map's own order, which is the order this
    // aggregate has always reported them in.
    let debug_log = authoring.debug.log_file.as_deref();
    let mut store_sources = Vec::new();
    for server in authoring.servers.values().filter(|server| server.enabled) {
        store_sources.push(
            routecodex_v3_config::v3_webui_observability_store_path(
                &state.config_path,
                debug_log,
                server.port,
            )
            .display()
            .to_string(),
        );
    }
    let stats_state = state.clone();
    // Shares the incremental store cache with the records and SSE endpoints, and
    // runs on the blocking pool because that cache lock spans file reads.
    let persisted_stats = match tokio::task::spawn_blocking(move || {
        let mut stats = PersistedTrafficStats::default();
        crate::api::observability::visit_v3_obs_stores(&stats_state, |_, rows| {
            // The overview has always counted the latest row per request_key, the
            // folding of `v3_webui_observability_read_rows`, not every lifecycle
            // row.
            let mut latest = BTreeMap::<&str, &crate::api::observability::SourceRow>::new();
            for row in rows {
                latest.insert(row.request_key.as_str(), row);
            }
            for row in latest.into_values() {
                stats.merge(row);
            }
        })
        .map(|()| stats)
    })
    .await
    {
        Ok(Ok(stats)) => stats,
        Ok(Err(error)) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": error })),
            )
                .into_response();
        }
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({
                    "error": format!("observability overview read task failed: {error}")
                })),
            )
                .into_response();
        }
    };

    let revisions = match state.store.revision_store().list() {
        Ok(revisions) => revisions,
        Err(error) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "error": format!("revision list failed: {error}") })),
            )
                .into_response();
        }
    }
    .into_iter()
    .rev()
    .take(10)
    .collect();

    Json(Overview {
        runtime: RuntimeStatus {
            managed_instance: metrics::read_managed_instance_status(&config_dir),
            ports: port_statuses,
        },
        providers: ProviderSummary {
            total: provider_ids.len(),
            enabled,
            disabled,
            configured: provider_ids,
        },
        traffic: TrafficSummary {
            total_requests: counter.total_requests,
            daily_requests: counter.daily_requests,
            last_request_at_epoch_ms: counter.last_request_at_epoch_ms,
            persisted_received: persisted_stats.received,
            persisted_provider_errors: persisted_stats.provider_errors,
            route_targets: persisted_stats.route_targets,
            store_sources,
        },
        revisions,
    })
    .into_response()
}

#[derive(Debug, Clone, Default)]
struct PersistedTrafficStats {
    received: u64,
    provider_errors: u64,
    route_targets: BTreeMap<String, u64>,
}

impl PersistedTrafficStats {
    fn merge(&mut self, row: &crate::api::observability::SourceRow) {
        self.received += 1;
        if row.result.as_deref() == Some("error") || row.failed_attempts > 0 {
            self.provider_errors += 1;
        }
        if let Some(route) = row
            .meta
            .get("route")
            .and_then(serde_json::Value::as_str)
            .filter(|route| !route.trim().is_empty() && *route != "-")
        {
            *self.route_targets.entry(route.to_string()).or_default() += 1;
        }
    }
}

async fn futures_join_all<T>(futures: Vec<impl std::future::Future<Output = T>>) -> Vec<T> {
    let mut results = Vec::with_capacity(futures.len());
    for future in futures {
        results.push(future.await);
    }
    results
}

async fn probe_port(server_id: String, port: u16, endpoints: Vec<String>) -> PortStatus {
    let url = format!("http://127.0.0.1:{port}/health");
    let (healthy, http_status) = match tokio::time::timeout(
        std::time::Duration::from_secs(2),
        reqwest::Client::builder()
            .build()
            .expect("client")
            .get(&url)
            .send(),
    )
    .await
    {
        Ok(Ok(response)) => (response.status().is_success(), response.status().as_u16()),
        _ => (false, 0),
    };
    PortStatus {
        server_id,
        port,
        endpoints,
        healthy,
        http_status,
        traffic_received: 0,
        traffic_provider_errors: 0,
    }
}

#[derive(Debug, Clone, Default)]
struct RequestCounter {
    total_requests: u64,
    daily_requests: u64,
    last_request_at_epoch_ms: Option<u64>,
}

fn read_request_counter(path: &Path) -> RequestCounter {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(_) => return RequestCounter::default(),
    };
    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(parsed) => parsed,
        Err(_) => return RequestCounter::default(),
    };
    RequestCounter {
        total_requests: parsed
            .get("totalRequests")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        daily_requests: parsed
            .get("dailyRequests")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        last_request_at_epoch_ms: parsed.get("lastRequestAtMs").and_then(|v| v.as_u64()),
    }
}

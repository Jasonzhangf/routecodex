// feature_id: v3.admin_dashboard
// Dashboard API：runtime/port/provider 状态、流量概览、修订历史。
use crate::{AppState, metrics};
use axum::extract::State;
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
    pub routing_group: String,
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
    pub log_tail_received: u64,
    pub log_tail_provider_errors: u64,
    pub route_targets: BTreeMap<String, u64>,
    pub log_sources: Vec<String>,
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

async fn overview(State(state): State<AppState>) -> Json<Overview> {
    let config_dir = state
        .config_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));

    let authoring = state.store.read_authoring().ok();
    let servers: Vec<_> = authoring
        .as_ref()
        .map(|authoring| authoring.servers.iter().collect())
        .unwrap_or_default();

    let mut probes = Vec::new();
    for (server_id, server) in &servers {
        probes.push(probe_port(
            server_id.to_string(),
            server.port,
            server.routing_group.clone(),
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

    let mut log_sources = Vec::new();
    let mut log_stats = metrics::LogTrafficStats::default();
    if let Ok(entries) = std::fs::read_dir(&config_dir.join("logs")) {
        for entry in entries.flatten() {
            let path = entry.path();
            let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if name.starts_with("server-v3-") && name.ends_with(".log") {
                log_sources.push(path.clone());
                let stats = metrics::scan_server_log(&path);
                log_stats.received_total += stats.received_total;
                log_stats.provider_errors_total += stats.provider_errors_total;
                for (target, count) in stats.route_targets {
                    *log_stats.route_targets.entry(target).or_default() += count;
                }
            }
        }
    }

    let revisions = state
        .store
        .revision_store()
        .list()
        .unwrap_or_default()
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
            log_tail_received: log_stats.received_total,
            log_tail_provider_errors: log_stats.provider_errors_total,
            route_targets: log_stats.route_targets,
            log_sources: log_sources
                .iter()
                .map(|path| path.display().to_string())
                .collect(),
        },
        revisions,
    })
}

async fn futures_join_all<T>(futures: Vec<impl std::future::Future<Output = T>>) -> Vec<T> {
    let mut results = Vec::with_capacity(futures.len());
    for future in futures {
        results.push(future.await);
    }
    results
}

async fn probe_port(
    server_id: String,
    port: u16,
    routing_group: String,
    endpoints: Vec<String>,
) -> PortStatus {
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
    let _ = routing_group;
    PortStatus {
        server_id,
        port,
        routing_group,
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
        total_requests: parsed.get("totalRequests").and_then(|v| v.as_u64()).unwrap_or(0),
        daily_requests: parsed.get("dailyRequests").and_then(|v| v.as_u64()).unwrap_or(0),
        last_request_at_epoch_ms: parsed.get("lastRequestAtMs").and_then(|v| v.as_u64()),
    }
}

// feature_id: v3.admin_routes
// Routes API：分层树（Port -> Pool -> Tier -> Member）读取、校验与提交。
use crate::AppState;
use axum::extract::{Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use routecodex_v3_config_mgmt::{
    apply_user_route_group_view, user_route_groups_from_selection, UserRouteGroupView,
};
use serde::Serialize;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/routes", get(get_routes).put(put_routes))
        .route("/api/routes/validate", post(validate_routes))
        .route("/api/routes/active-keys", get(active_keys))
        .route("/api/routes/active-keys/release", post(release_active_key))
}

#[derive(serde::Deserialize)]
struct ListenerQuery {
    server_id: String,
}

#[derive(serde::Deserialize)]
struct ReleaseRequest {
    server_id: String,
    routing_group_id: String,
    pool_id: String,
    provider_id: String,
    interface_id: String,
    model_id: String,
    auth_alias: String,
}

type ControlResult =
    Result<(axum::http::StatusCode, Json<serde_json::Value>), (axum::http::StatusCode, String)>;

#[derive(serde::Deserialize)]
struct ActiveKeyControlEndpointRecord {
    schema_version: u8,
    server_id: String,
    business_addr: std::net::SocketAddr,
    control_addr: std::net::SocketAddr,
    owner_pid: u32,
}

fn control_record_path(
    config_path: &std::path::Path,
    server_id: &str,
) -> std::io::Result<routecodex_v3_config::V3ActiveKeyControlPaths> {
    routecodex_v3_config::v3_active_key_control_paths(config_path, server_id)
}

async fn active_keys(
    State(state): State<AppState>,
    Query(query): Query<ListenerQuery>,
) -> ControlResult {
    forward_selection_control(&state, &query.server_id, None).await
}

async fn release_active_key(
    State(state): State<AppState>,
    Json(request): Json<ReleaseRequest>,
) -> ControlResult {
    let body = serde_json::json!({
        "routing_group_id": request.routing_group_id, "pool_id": request.pool_id,
        "provider_id": request.provider_id, "interface_id": request.interface_id,
        "model_id": request.model_id, "auth_alias": request.auth_alias,
    });
    forward_selection_control(&state, &request.server_id, Some(body)).await
}

async fn forward_selection_control(
    state: &AppState,
    server_id: &str,
    body: Option<serde_json::Value>,
) -> ControlResult {
    use axum::http::StatusCode;
    let store = state.store.clone();
    let config_path = state.config_path.clone();
    let selected = server_id.to_owned();
    let (server, record_path) = tokio::task::spawn_blocking(move || {
        let mut selection = store
            .read_user_routing()
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
        let server = selection
            .servers
            .remove(&selected)
            .filter(|server| server.enabled)
            .ok_or_else(|| {
                (
                    StatusCode::BAD_REQUEST,
                    format!("unknown or disabled server {selected:?}"),
                )
            })?;
        let record_path = control_record_path(&config_path, &selected)
            .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
        Ok::<_, (StatusCode, String)>((server, record_path))
    })
    .await
    .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))??;
    let business_addr = format!("{}:{}", server.bind, server.port)
        .parse::<std::net::SocketAddr>()
        .or_else(|_| {
            server
                .bind
                .parse()
                .map(|ip| std::net::SocketAddr::new(ip, server.port))
        })
        .map_err(|error| (StatusCode::BAD_REQUEST, error.to_string()))?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
    let address = match record_path.read_until(deadline).await {
        Ok(bytes) => {
            let record: ActiveKeyControlEndpointRecord =
                serde_json::from_slice(&bytes).map_err(|error| {
                    (
                        StatusCode::BAD_GATEWAY,
                        format!("invalid Server control address record: {error}"),
                    )
                })?;
            if record.schema_version != 1
                || record.server_id != server_id
                || record.business_addr != business_addr
                || record.owner_pid == 0
                || !record.control_addr.ip().is_loopback()
                || record.control_addr.port() == 0
            {
                return Err((
                    StatusCode::BAD_GATEWAY,
                    "Server control address record does not match selected listener".into(),
                ));
            }
            record.control_addr
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => match business_addr.ip() {
            std::net::IpAddr::V4(ip) if ip.is_loopback() => business_addr,
            std::net::IpAddr::V6(ip) if ip.is_loopback() => business_addr,
            std::net::IpAddr::V4(_) | std::net::IpAddr::V6(_) => match business_addr {
                std::net::SocketAddr::V4(addr) if addr.ip().is_unspecified() => {
                    std::net::SocketAddr::new(
                        std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
                        addr.port(),
                    )
                }
                std::net::SocketAddr::V6(addr) if addr.ip().is_unspecified() => {
                    std::net::SocketAddr::new(
                        std::net::IpAddr::V6(std::net::Ipv6Addr::LOCALHOST),
                        addr.port(),
                    )
                }
                _ => {
                    return Err((
                        StatusCode::SERVICE_UNAVAILABLE,
                        "Server-owned loopback control address is unavailable".into(),
                    ))
                }
            },
        },
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
            ) =>
        {
            return Err((
                StatusCode::SERVICE_UNAVAILABLE,
                format!("active-key control storage lock unavailable: {error}"),
            ));
        }
        Err(error) => return Err((StatusCode::INTERNAL_SERVER_ERROR, error.to_string())),
    };
    let suffix = if body.is_some() { "/release" } else { "" };
    let url = format!("http://{address}/_routecodex/selection/active-keys{suffix}");
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|error| (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    let request = match body {
        Some(body) => client.post(url).json(&body),
        None => client.get(url),
    };
    let response = request.send().await.map_err(|error| {
        (
            StatusCode::BAD_GATEWAY,
            format!("selection control unavailable: {error}"),
        )
    })?;
    let status = response.status();
    let body = response.json().await.map_err(|error| {
        (
            StatusCode::BAD_GATEWAY,
            format!("invalid selection control JSON: {error}"),
        )
    })?;
    Ok((status, Json(body)))
}

#[cfg(test)]
mod selection_control_tests {
    use super::*;

    /// Controlled endpoint verifies admin forwarding only; it is not Runtime acceptance.
    #[tokio::test]
    async fn forwards_selected_listener_and_exact_release_without_health_calls() {
        use axum::routing::{get, post};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (sender, mut receiver) = tokio::sync::mpsc::channel(2);
        let get_sender = sender.clone();
        let controlled = Router::new()
            .route(
                "/_routecodex/selection/active-keys",
                get(move || async move {
                    get_sender
                        .send(serde_json::json!({"method": "GET"}))
                        .await
                        .unwrap();
                    Json(serde_json::json!({"pools": []}))
                }),
            )
            .route(
                "/_routecodex/selection/active-keys/release",
                post(move |Json(body): Json<serde_json::Value>| async move {
                    sender.send(body).await.unwrap();
                    (
                        axum::http::StatusCode::CONFLICT,
                        Json(serde_json::json!({"error": "not held"})),
                    )
                }),
            );
        let server_task = tokio::spawn(async move {
            axum::serve(listener, controlled).await.unwrap();
        });
        let dir = std::env::temp_dir().join(format!(
            "rcc-active-ui-control-{}-{port}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.toml");
        std::fs::write(&path, format!("version = 3\n[servers.test]\nbind = \"127.0.0.1\"\nport = {port}\n[servers.test.routes.default]\ntiers = [[{{ use = \"p/m\" }}]]\n")).unwrap();
        let state = AppState::new(path);
        let (status, Json(body)) = forward_selection_control(&state, "test", None)
            .await
            .unwrap();
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(body, serde_json::json!({"pools": []}));
        assert_eq!(receiver.recv().await.unwrap()["method"], "GET");
        let release = serde_json::json!({"routing_group_id":"test", "pool_id":"default", "provider_id":"p", "interface_id":"responses", "model_id":"m", "auth_alias":"key"});
        let (status, Json(body)) = forward_selection_control(&state, "test", Some(release.clone()))
            .await
            .unwrap();
        assert_eq!(status, axum::http::StatusCode::CONFLICT);
        assert_eq!(body["error"], "not held");
        assert_eq!(receiver.recv().await.unwrap(), release);
        assert_eq!(
            forward_selection_control(&state, "missing", None)
                .await
                .unwrap_err()
                .0,
            axum::http::StatusCode::BAD_REQUEST
        );
        server_task.abort();
        let _ = server_task.await;
        assert!(tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .is_ok());
        std::fs::remove_dir_all(dir).unwrap();
    }
}

async fn get_routes(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, (axum::http::StatusCode, String)> {
    let selection = state.store.read_user_routing().map_err(|error| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            error.to_string(),
        )
    })?;
    let servers = user_route_groups_from_selection(&selection);
    Ok(Json(serde_json::json!({ "servers": servers })))
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct RoutesUpdateRequest {
    pub servers: Vec<UserRouteGroupView>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RoutesUpdateResult {
    pub ok: bool,
    pub backup: Option<String>,
    pub revision_seq: u64,
    pub servers: Vec<UserRouteGroupView>,
}

async fn put_routes(
    State(state): State<AppState>,
    Json(request): Json<RoutesUpdateRequest>,
) -> Result<Json<RoutesUpdateResult>, (axum::http::StatusCode, String)> {
    let mut selection = state.store.read_user_routing().map_err(|error| {
        (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            error.to_string(),
        )
    })?;
    for group in &request.servers {
        apply_user_route_group_view(&mut selection, group)
            .map_err(|error| (axum::http::StatusCode::BAD_REQUEST, error))?;
    }
    let outcome = state
        .store
        .commit_user_routing_with_backup(
            &selection,
            "route.update",
            request.reason.as_deref().unwrap_or("webui routes update"),
        )
        .map_err(|error| (axum::http::StatusCode::BAD_REQUEST, error.to_string()))?;
    let servers = user_route_groups_from_selection(&selection);
    Ok(Json(RoutesUpdateResult {
        ok: true,
        backup: outcome
            .backup
            .as_ref()
            .map(|path| path.display().to_string()),
        revision_seq: outcome.revision.seq,
        servers,
    }))
}

#[derive(Debug, Clone, Serialize)]
pub struct RoutesValidateResult {
    pub ok: bool,
    pub error: Option<String>,
    pub servers: Vec<UserRouteGroupView>,
}

async fn validate_routes(
    State(state): State<AppState>,
    Json(request): Json<RoutesUpdateRequest>,
) -> Json<RoutesValidateResult> {
    let mut selection = match state.store.read_user_routing() {
        Ok(selection) => selection,
        Err(error) => {
            return Json(RoutesValidateResult {
                ok: false,
                error: Some(error.to_string()),
                servers: Vec::new(),
            });
        }
    };
    for group in &request.servers {
        if let Err(error) = apply_user_route_group_view(&mut selection, group) {
            return Json(RoutesValidateResult {
                ok: false,
                error: Some(error),
                servers: Vec::new(),
            });
        }
    }
    match state.store.validate_user_routing(selection.clone()) {
        Ok(_) => Json(RoutesValidateResult {
            ok: true,
            error: None,
            servers: user_route_groups_from_selection(&selection),
        }),
        Err(error) => Json(RoutesValidateResult {
            ok: false,
            error: Some(error.to_string()),
            servers: Vec::new(),
        }),
    }
}

// feature_id: v3.admin_routes
// Routes API：分层树（Port -> Pool -> Tier -> Member）读取、校验与提交。
use crate::AppState;
use axum::extract::State;
use axum::routing::{get, post};
use axum::{Json, Router};
use routecodex_v3_config_mgmt::{
    RouteGroupView, apply_route_group_view_to_authoring, route_groups_from_authoring,
};
use serde::Serialize;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/routes", get(get_routes).put(put_routes))
        .route("/api/routes/validate", post(validate_routes))
}

async fn get_routes(State(state): State<AppState>) -> Result<Json<serde_json::Value>, (axum::http::StatusCode, String)> {
    let authoring = state
        .store
        .read_authoring()
        .map_err(|error| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    let groups = route_groups_from_authoring(&authoring);
    Ok(Json(serde_json::json!({ "groups": groups })))
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct RoutesUpdateRequest {
    pub groups: Vec<RouteGroupView>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RoutesUpdateResult {
    pub ok: bool,
    pub backup: Option<String>,
    pub revision_seq: u64,
    pub groups: Vec<RouteGroupView>,
}

async fn put_routes(
    State(state): State<AppState>,
    Json(request): Json<RoutesUpdateRequest>,
) -> Result<Json<RoutesUpdateResult>, (axum::http::StatusCode, String)> {
    let mut authoring = state
        .store
        .read_authoring()
        .map_err(|error| (axum::http::StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    for group in &request.groups {
        apply_route_group_view_to_authoring(&mut authoring, group);
    }
    let outcome = state
        .store
        .commit_with_backup(
            &authoring,
            "route.update",
            request.reason.as_deref().unwrap_or("webui routes update"),
        )
        .map_err(|error| (axum::http::StatusCode::BAD_REQUEST, error.to_string()))?;
    let groups = route_groups_from_authoring(&authoring);
    Ok(Json(RoutesUpdateResult {
        ok: true,
        backup: outcome
            .backup
            .as_ref()
            .map(|path| path.display().to_string()),
        revision_seq: outcome.revision.seq,
        groups,
    }))
}

#[derive(Debug, Clone, Serialize)]
pub struct RoutesValidateResult {
    pub ok: bool,
    pub error: Option<String>,
    pub groups: Vec<RouteGroupView>,
}

async fn validate_routes(
    State(state): State<AppState>,
    Json(request): Json<RoutesUpdateRequest>,
) -> Json<RoutesValidateResult> {
    let mut authoring = match state.store.read_authoring() {
        Ok(authoring) => authoring,
        Err(error) => {
            return Json(RoutesValidateResult {
                ok: false,
                error: Some(error.to_string()),
                groups: Vec::new(),
            });
        }
    };
    for group in &request.groups {
        apply_route_group_view_to_authoring(&mut authoring, group);
    }
    match state.store.validate(&authoring) {
        Ok(_) => Json(RoutesValidateResult {
            ok: true,
            error: None,
            groups: route_groups_from_authoring(&authoring),
        }),
        Err(error) => Json(RoutesValidateResult {
            ok: false,
            error: Some(error.to_string()),
            groups: Vec::new(),
        }),
    }
}

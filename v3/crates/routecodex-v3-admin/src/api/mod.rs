// feature_id: v3.admin_api
pub mod dashboard;
pub mod observability;
pub mod providers;
pub mod reload;
pub mod routes;
pub mod timeseries;

use crate::AppState;
use axum::routing::get;
use axum::Router;

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .merge(dashboard::routes())
        .merge(observability::routes())
        .merge(routes::routes())
        .merge(providers::routes())
        .merge(reload::routes())
        .route("/styles.css", get(static_serve))
        .route("/vendor/ambient.css", get(static_serve))
        .route("/app.js", get(static_serve))
        .route("/app.embedded.txt", get(static_serve))
        .route("/app/core.js", get(static_serve))
        .route("/app/shell.js", get(static_serve))
        .route("/app/charts.js", get(static_serve))
        .route("/app/drawer.js", get(static_serve))
        .route("/app/views/dashboard.js", get(static_serve))
        .route("/app/views/usage.js", get(static_serve))
        .route("/app/views/providers.js", get(static_serve))
        .route("/app/views/routes.js", get(static_serve))
        .route("/app/views/usage-state.js", get(static_serve))
        .route("/app/views/usage-filters.js", get(static_serve))
        .route("/app/views/usage-panels.js", get(static_serve))
        .route("/app/views/usage-panel-views.js", get(static_serve))
        .route("/app/views/usage-export.js", get(static_serve))
        .route("/app/views/usage-summary.js", get(static_serve))
        .route("/index.html", get(static_serve))
        .route("/routes.html", get(static_serve))
        .route("/providers.html", get(static_serve))
        .route("/requests.html", get(static_serve))
        .route("/", get(static_serve))
        .with_state(state)
}

use axum::body::Body;
use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::Response;

async fn static_serve(State(state): State<AppState>, uri: axum::http::Uri) -> Response {
    let path = uri.path();
    let relative = path.trim_start_matches('/');
    if relative.starts_with("api/") {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("not found"))
            .expect("response");
    }
    let (content, content_type) = match relative {
        "" | "index.html" => (crate::STATIC_INDEX_HTML, "text/html; charset=utf-8"),
        "routes.html" => (crate::STATIC_ROUTES_HTML, "text/html; charset=utf-8"),
        "providers.html" => (crate::STATIC_PROVIDERS_HTML, "text/html; charset=utf-8"),
        "requests.html" => (crate::STATIC_REQUESTS_HTML, "text/html; charset=utf-8"),
        "app.js" => (crate::STATIC_APP_JS, "text/javascript; charset=utf-8"),
        "app.embedded.txt" => (crate::STATIC_APP_JS, "text/javascript; charset=utf-8"),
        "styles.css" => (crate::STATIC_STYLE_CSS, "text/css; charset=utf-8"),
        "vendor/ambient.css" => (crate::STATIC_VENDOR_AMBIENT_CSS, "text/css; charset=utf-8"),
        "app/core.js" => (crate::STATIC_APP_CORE_JS, "text/javascript; charset=utf-8"),
        "app/shell.js" => (crate::STATIC_APP_SHELL_JS, "text/javascript; charset=utf-8"),
        "app/charts.js" => (
            crate::STATIC_APP_CHARTS_JS,
            "text/javascript; charset=utf-8",
        ),
        "app/drawer.js" => (
            crate::STATIC_APP_DRAWER_JS,
            "text/javascript; charset=utf-8",
        ),
        "app/views/dashboard.js" => (
            crate::STATIC_VIEW_DASHBOARD_JS,
            "text/javascript; charset=utf-8",
        ),
        "app/views/usage.js" => (
            crate::STATIC_VIEW_USAGE_JS,
            "text/javascript; charset=utf-8",
        ),
        "app/views/providers.js" => (
            crate::STATIC_VIEW_PROVIDERS_JS,
            "text/javascript; charset=utf-8",
        ),
        "app/views/routes.js" => (
            crate::STATIC_VIEW_ROUTES_JS,
            "text/javascript; charset=utf-8",
        ),
        "app/views/usage-state.js" => (
            crate::STATIC_VIEW_USAGE_STATE_JS,
            "text/javascript; charset=utf-8",
        ),
        "app/views/usage-filters.js" => (
            crate::STATIC_VIEW_USAGE_FILTERS_JS,
            "text/javascript; charset=utf-8",
        ),
        "app/views/usage-panels.js" => (
            crate::STATIC_VIEW_USAGE_PANELS_JS,
            "text/javascript; charset=utf-8",
        ),
        "app/views/usage-panel-views.js" => (
            crate::STATIC_VIEW_USAGE_PANEL_VIEWS_JS,
            "text/javascript; charset=utf-8",
        ),
        "app/views/usage-export.js" => (
            crate::STATIC_VIEW_USAGE_EXPORT_JS,
            "text/javascript; charset=utf-8",
        ),
        "app/views/usage-summary.js" => (
            crate::STATIC_VIEW_USAGE_SUMMARY_JS,
            "text/javascript; charset=utf-8",
        ),
        _ => {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::from("not found"))
                .expect("response");
        }
    };
    let _ = &state;
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(content))
        .expect("response")
}

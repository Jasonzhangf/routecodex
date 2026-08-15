// feature_id: v3.admin_api
pub mod dashboard;
pub mod providers;
pub mod reload;
pub mod routes;

use crate::AppState;
use axum::Router;

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .merge(dashboard::routes())
        .merge(routes::routes())
        .merge(providers::routes())
        .merge(reload::routes())
        .fallback(static_serve)
        .with_state(state)
}

use axum::body::Body;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::Response;

async fn static_serve(
    State(state): State<AppState>,
    uri: axum::http::Uri,
) -> Response {
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
        "app.js" => (crate::STATIC_APP_JS, "text/javascript; charset=utf-8"),
        "styles.css" => (crate::STATIC_STYLE_CSS, "text/css; charset=utf-8"),
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
        .body(Body::from(content))
        .expect("response")
}

// feature_id: v3.admin_api
// RCC V3 Config Management WebUI Backend：axum admin server。
// 职责：Dashboard / Routes / Providers 三页面的 REST API 与静态页面服务。
// 所有配置操作经 Config Core（routecodex-v3-config-mgmt）执行，
// 本模块不做任何配置语义判定（解析/校验/原子写/备份/修订全部下沉）。
pub mod api;
pub mod metrics;

use routecodex_v3_config_mgmt::ConfigMgmtStore;
use std::path::PathBuf;
use std::sync::Arc;

pub const STATIC_INDEX_HTML: &str = include_str!("../../../admin-webui/index.html");
pub const STATIC_ROUTES_HTML: &str = include_str!("../../../admin-webui/routes.html");
pub const STATIC_PROVIDERS_HTML: &str = include_str!("../../../admin-webui/providers.html");
pub const STATIC_REQUESTS_HTML: &str = include_str!("../../../admin-webui/requests.html");
pub const STATIC_APP_JS: &str = include_str!("../../../admin-webui/app.embedded.txt");
pub const STATIC_STYLE_CSS: &str = include_str!("../../../admin-webui/styles.css");
pub const STATIC_VENDOR_AMBIENT_CSS: &str =
    include_str!("../../../admin-webui/vendor/ambient.css");
pub const STATIC_APP_CORE_JS: &str = include_str!("../../../admin-webui/app/core.js");
pub const STATIC_APP_SHELL_JS: &str = include_str!("../../../admin-webui/app/shell.js");
pub const STATIC_APP_CHARTS_JS: &str = include_str!("../../../admin-webui/app/charts.js");
pub const STATIC_APP_DRAWER_JS: &str = include_str!("../../../admin-webui/app/drawer.js");
pub const STATIC_VIEW_DASHBOARD_JS: &str =
    include_str!("../../../admin-webui/app/views/dashboard.js");
pub const STATIC_VIEW_USAGE_JS: &str = include_str!("../../../admin-webui/app/views/usage.js");
pub const STATIC_VIEW_PROVIDERS_JS: &str =
    include_str!("../../../admin-webui/app/views/providers.js");
pub const STATIC_VIEW_ROUTES_JS: &str = include_str!("../../../admin-webui/app/views/routes.js");
// The usage view is split across focused modules. Browsers request each module
// as its own URL, so every module needs an embedded asset and a route; a missing
// entry here surfaces as a 404 that breaks the whole page.
pub const STATIC_VIEW_USAGE_STATE_JS: &str =
    include_str!("../../../admin-webui/app/views/usage-state.js");
pub const STATIC_VIEW_USAGE_FILTERS_JS: &str =
    include_str!("../../../admin-webui/app/views/usage-filters.js");
pub const STATIC_VIEW_USAGE_PANELS_JS: &str =
    include_str!("../../../admin-webui/app/views/usage-panels.js");
pub const STATIC_VIEW_USAGE_PANEL_VIEWS_JS: &str =
    include_str!("../../../admin-webui/app/views/usage-panel-views.js");
pub const STATIC_VIEW_USAGE_EXPORT_JS: &str =
    include_str!("../../../admin-webui/app/views/usage-export.js");
pub const STATIC_VIEW_USAGE_SUMMARY_JS: &str =
    include_str!("../../../admin-webui/app/views/usage-summary.js");

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProviderHealthEntry {
    pub tested_at_epoch_ms: u64,
    pub ok: bool,
    pub latency_ms: u64,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct AppState {
    pub config_path: PathBuf,
    pub store: ConfigMgmtStore,
    pub health_cache:
        Arc<tokio::sync::Mutex<std::collections::BTreeMap<String, ProviderHealthEntry>>>,
}

impl AppState {
    pub fn new(config_path: PathBuf) -> Self {
        Self {
            store: ConfigMgmtStore::new(&config_path),
            config_path,
            health_cache: Arc::new(tokio::sync::Mutex::new(std::collections::BTreeMap::new())),
        }
    }
}

pub fn router(state: AppState) -> axum::Router {
    api::build_router(state)
}

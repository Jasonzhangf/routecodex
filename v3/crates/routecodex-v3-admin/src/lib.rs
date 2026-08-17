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
pub const STATIC_APP_JS: &str = include_str!("../../../admin-webui/app.embedded.txt");
pub const STATIC_STYLE_CSS: &str = include_str!("../../../admin-webui/styles.css");

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
    pub health_cache: Arc<tokio::sync::Mutex<std::collections::BTreeMap<String, ProviderHealthEntry>>>,
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

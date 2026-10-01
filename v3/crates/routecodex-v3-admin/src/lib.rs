// feature_id: v3.admin_api
// RCC V3 Config Management WebUI Backend：axum admin server。
// 职责：Dashboard / Usage / Providers / Routes / Deploy 页面的 REST API 与静态页面服务。
// 所有配置操作经 Config Core（routecodex-v3-config-mgmt）执行，
// 本模块不做任何配置语义判定（解析/校验/原子写/备份/修订全部下沉）。
pub mod api;
pub mod auth;
pub mod metrics;
pub mod provider_onboarding;
pub mod provider_patrol;
pub mod provider_probe;

use routecodex_v3_config_mgmt::ConfigMgmtStore;
use std::path::PathBuf;
use std::sync::Arc;

pub const STATIC_INDEX_HTML: &str = include_str!("../../../admin-webui/index.html");
pub const STATIC_ROUTES_HTML: &str = include_str!("../../../admin-webui/routes.html");
pub const STATIC_PROVIDERS_HTML: &str = include_str!("../../../admin-webui/providers.html");
pub const STATIC_REQUESTS_HTML: &str = include_str!("../../../admin-webui/requests.html");
pub const STATIC_DEPLOY_HTML: &str = include_str!("../../../admin-webui/deploy.html");
pub const STATIC_APP_JS: &str = include_str!("../../../admin-webui/app.embedded.txt");
pub const STATIC_STYLE_CSS: &str = include_str!("../../../admin-webui/styles.css");
pub const STATIC_VENDOR_AMBIENT_CSS: &str = include_str!("../../../admin-webui/vendor/ambient.css");
pub const STATIC_APP_CORE_JS: &str = include_str!("../../../admin-webui/app/core.js");
pub const STATIC_APP_SHELL_JS: &str = include_str!("../../../admin-webui/app/shell.js");
pub const STATIC_APP_CHARTS_JS: &str = include_str!("../../../admin-webui/app/charts.js");
pub const STATIC_APP_DRAWER_JS: &str = include_str!("../../../admin-webui/app/drawer.js");
pub const STATIC_APP_FORM_JS: &str = include_str!("../../../admin-webui/app/form.js");
pub const STATIC_APP_PROBE_JS: &str = include_str!("../../../admin-webui/app/probe.js");
pub const STATIC_VIEW_DASHBOARD_JS: &str =
    include_str!("../../../admin-webui/app/views/dashboard.js");
pub const STATIC_VIEW_USAGE_JS: &str = include_str!("../../../admin-webui/app/views/usage.js");
pub const STATIC_VIEW_PROVIDERS_JS: &str =
    include_str!("../../../admin-webui/app/views/providers.js");
pub const STATIC_VIEW_ROUTES_JS: &str = include_str!("../../../admin-webui/app/views/routes.js");
pub const STATIC_VIEW_DEPLOY_JS: &str = include_str!("../../../admin-webui/app/views/deploy.js");

#[derive(Debug, Clone)]
pub struct AppState {
    pub config_path: PathBuf,
    pub store: ConfigMgmtStore,
    /// Local admin token value. `None` means the token file could not be provisioned and
    /// mutating endpoints must fail closed.
    pub admin_token: Option<String>,
    /// Periodic provider patrol runtime (advisory diagnostics only; never runtime health truth).
    pub patrol: Arc<provider_patrol::PatrolRuntime>,
    pub started_at_epoch_ms: u64,
}

impl AppState {
    pub fn new(config_path: PathBuf) -> Self {
        let config_dir = config_path
            .parent()
            .map(std::path::Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        let admin_token = match auth::AdminToken::load_or_create(&config_dir) {
            Ok(token) => Some(token.value),
            Err(error) => {
                eprintln!("[admin] failed to provision local admin token: {error}");
                None
            }
        };
        let patrol = Arc::new(provider_patrol::PatrolRuntime::new(config_path.clone()));
        Self {
            store: ConfigMgmtStore::new(&config_path),
            config_path,
            admin_token,
            patrol,
            started_at_epoch_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        }
    }

    /// Start background work owned by the admin process (provider patrol tick loop).
    ///
    /// Advisory and non-blocking: this returns immediately and can never fail
    /// startup. Idempotent per process — `provider_patrol::spawn_patrol_loop`
    /// claims a single process-wide loop slot, so the standalone `rccv3-admin`
    /// binary and an in-process admin router in the same process cannot tick the
    /// same plan file twice. The in-process admin listener of the aggregate server
    /// calls this as the shipping entry for scheduled patrol.
    pub fn spawn_background(self: &Arc<Self>) {
        provider_patrol::spawn_patrol_loop(Arc::clone(self));
    }
}

pub fn router(state: AppState) -> axum::Router {
    api::build_router(state)
}

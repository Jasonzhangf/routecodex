//! routecodex-v3-config-mgmt：RCC Config Management 的 Config Core（V3 版）。
//!
//! 职责边界：
//! - CLI、WebUI、Runtime 的统一配置操作入口（解析/生成/校验/原子写/备份/修订）。
//! - Provider 文件（config.v2.toml）、Route 配置（config.v3.toml route_groups）、
//!   Forwarder 段（config.v3.toml forwarders）的构建与解析。
//! - 不改变路由算法；runtime 语义真源仍为 routecodex-v3-config 编译链。
pub mod forwarder;
pub mod provider;
pub mod route;
pub mod store;

pub use forwarder::{
    forwarders_from_authoring, new_forwarder_with_target, remove_forwarder,
    upsert_forwarder,
};
pub use provider::{
    list_provider_ids, provider_config_file_path, provider_directory, read_provider_file,
    write_provider_file, ProviderFileEntry, V2_PROVIDER_CONFIG_FILE_NAME,
};
pub use route::{
    apply_route_group_view_to_authoring, new_default_pool_view, pool_view_from_authoring,
    port_view_from_authoring, route_groups_from_authoring, RouteGroupView, RouteMemberView,
    RoutePoolView, RoutePortView, RouteTierView,
};
pub use store::{
    ConfigMgmtStore, ConfigRevision, RevisionStore, V3ConfigMgmtError, default_revision_store_path,
};

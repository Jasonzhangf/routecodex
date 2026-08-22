//! provider 级冷却的复活探针状态（provider-responses crate 内部）。
//!
//! 冷却到期后后台 probe 循环消费 `V3ProviderHealthStore` 的 probe API；
//! 类型与 key 构造保持独立模块，避免 health.rs 超过文件尺寸门限。

/// 首次复活探针间隔。后续失败由 probe_failure_count 推进动态退避。
pub const V3_PROVIDER_COOLDOWN_PROBE_INTERVAL_MS: u64 = 3 * 60_000;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct V3ProviderCooldownProbeKey {
    pub provider_id: String,
    pub auth_alias: Option<String>,
    pub model_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct V3ProviderCooldownProbeState {
    pub blocked_until_ms: Option<u64>,
    pub next_probe_at_ms: Option<u64>,
    pub probe_interval_ms: u64,
    pub probe_failure_count: u8,
    pub probe_in_flight: bool,
    pub probe_model_id: Option<String>,
    pub rescue_probe_attempted: bool,
    pub completion: tokio::sync::watch::Sender<bool>,
}

pub fn provider_cooldown_probe_key(
    provider_id: &str,
    auth_alias: Option<&str>,
    model_id: Option<&str>,
) -> V3ProviderCooldownProbeKey {
    V3ProviderCooldownProbeKey {
        provider_id: provider_id.to_string(),
        auth_alias: auth_alias.map(str::to_string),
        model_id: model_id.map(str::to_string),
    }
}

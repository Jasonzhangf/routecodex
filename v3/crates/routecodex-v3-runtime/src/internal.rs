use serde::Deserialize;
use std::sync::LazyLock;

const INTERNAL_CONFIG_TOML: &str = include_str!("internal.toml");

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InternalConfig {
    provider_action_defaults: ProviderActionDefaults,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProviderActionDefaults {
    pub action_isolated_delay_ms: u64,
    pub action_medium_delay_ms: u64,
    pub action_sustained_delay_ms: u64,
    pub action_idle_ttl_ms: u64,
}

pub(crate) fn provider_action_defaults() -> &'static ProviderActionDefaults {
    static DEFAULTS: LazyLock<ProviderActionDefaults> = LazyLock::new(|| {
        toml::from_str::<InternalConfig>(INTERNAL_CONFIG_TOML)
            .expect("routecodex-v3-runtime internal.toml must be valid")
            .provider_action_defaults
    });
    &DEFAULTS
}

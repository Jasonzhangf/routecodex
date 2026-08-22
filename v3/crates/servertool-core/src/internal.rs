use serde::Deserialize;
use std::sync::LazyLock;

const INTERNAL_CONFIG_TOML: &str = include_str!("internal.toml");

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InternalConfig {
    stopless_defaults: StoplessDefaults,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct StoplessDefaults {
    pub max_repeats: u32,
    pub budget_max_repeats: u32,
    pub text: String,
    pub reasoning_text: String,
}

pub(crate) fn stopless_defaults() -> &'static StoplessDefaults {
    static DEFAULTS: LazyLock<StoplessDefaults> = LazyLock::new(|| {
        toml::from_str::<InternalConfig>(INTERNAL_CONFIG_TOML)
            .expect("servertool-core internal.toml must be valid")
            .stopless_defaults
    });
    &DEFAULTS
}

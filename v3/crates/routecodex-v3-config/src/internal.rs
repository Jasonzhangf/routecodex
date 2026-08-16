//! RouteCodex 内部配置层（internal）：集中承载 RouteCodex 内部控制特判与
//! 内部模型清单（模型家族判定、内置目录模型、隐藏未来模型等）。
//!
//! 分层约束：
//! - 判定数据全部来自编译期嵌入的 `internal.toml`（`INTERNAL_CONFIG_TOML`），
//!   代码本身只查表，不内联具体模型名 / 前缀 / 清单。
//! - 用户配置面（`types` / `validate` / `defaults` / `store`）不承载任何特判；
//!   用户写配置时无需关心 family / builtin / hidden 等内部语义。
//! - 路由层（target）、流水线 compat（runtime）、能力面（server models catalog）
//!   只消费本层判定结果，禁止内联具体模型名或自行实现等价判定。
//! - 本层只持有纯函数判定与静态清单，不持有运行时状态。

use serde::Deserialize;
use std::collections::BTreeMap;
use std::sync::LazyLock;

/// 编译期嵌入的内部配置资产（随包发布，无效即 fail-fast）。
pub const INTERNAL_CONFIG_TOML: &str = include_str!("internal.toml");

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct InternalConfig {
    #[serde(default)]
    model_families: BTreeMap<String, ModelFamily>,
    #[serde(default)]
    builtin_catalog_models: BuiltinCatalogModels,
    #[serde(default)]
    hidden_models: HiddenModels,
    #[serde(default)]
    debug_samples: DebugSamples,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ModelFamily {
    #[serde(default)]
    prefix: Option<String>,
    #[serde(default)]
    exact: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct BuiltinCatalogModels {
    #[serde(default)]
    ids: Vec<String>,
    #[serde(default)]
    defaults: Vec<V3BuiltinModelDefaults>,
}

/// 内置目录模型默认元数据（内部配置真源，来自 `internal.toml`
/// `[builtin_catalog_models.defaults]`）：能力面（/v1/models 目录）用它构建
/// 内置条目的能力 / 上下文窗口 / 描述 / reasoning 级别预设。必填字段缺失
/// 或未知字段漂移一律反序列化失败 fail-fast（禁消费侧缺省补偿）。
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3BuiltinModelDefaults {
    pub model_id: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub context_window: Option<u64>,
    pub description: String,
    pub default_reasoning_level: String,
    #[serde(default)]
    pub reasoning_efforts: Vec<String>,
    pub minimal_client_version: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct DebugSamples {
    #[serde(default = "default_error_samples_only")]
    error_samples_only: bool,
    #[serde(default)]
    error_sample_skip_statuses: Vec<u16>,
}

fn default_error_samples_only() -> bool {
    true
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct HiddenModels {
    #[serde(default)]
    exact: Vec<String>,
    #[serde(default)]
    prefixes: Vec<String>,
}

static INTERNAL_CONFIG: LazyLock<InternalConfig> = LazyLock::new(|| {
    let config: InternalConfig = toml::from_str(INTERNAL_CONFIG_TOML)
        .expect("internal.toml must be valid TOML: compile-time embedded internal config asset");
    validate_internal_config(&config);
    config
});

/// 内部配置资产语义校验：必选 section 缺失、空清单、未归一化（含空白/大写）
/// 条目、重复条目、builtin id 无对应 defaults、defaults 缺关键元数据，一律
/// 视为无效资产 fail-fast panic（编译期资产不可能在运行时被修复，静默降级
/// 违反控制面规则；查找层按 trim+lowercase 归一化匹配，资产值必须已归一化，
/// 否则合法资产会静默 miss 落到消费方降级）。
fn validate_internal_config(config: &InternalConfig) {
    let gpt_family = config
        .model_families
        .get(GPT_FAMILY_KEY)
        .unwrap_or_else(|| panic!("internal.toml must define [model_families.{GPT_FAMILY_KEY}]"));
    assert!(
        gpt_family.prefix.is_some() || !gpt_family.exact.is_empty(),
        "internal.toml [model_families.{GPT_FAMILY_KEY}] must define prefix or exact"
    );
    if let Some(prefix) = &gpt_family.prefix {
        assert!(
            !prefix.trim().is_empty(),
            "internal.toml [model_families.{GPT_FAMILY_KEY}].prefix must be non-empty"
        );
        assert_eq!(
            &normalized_model_id(prefix),
            prefix,
            "internal.toml [model_families.{GPT_FAMILY_KEY}].prefix must be normalized (trimmed lowercase)"
        );
    }
    for id in &gpt_family.exact {
        assert!(
            !id.trim().is_empty(),
            "internal.toml [model_families.{GPT_FAMILY_KEY}].exact entries must be non-empty"
        );
        assert_eq!(
            &normalized_model_id(id),
            id,
            "internal.toml [model_families.{GPT_FAMILY_KEY}].exact entries must be normalized (trimmed lowercase)"
        );
    }

    assert!(
        !config.builtin_catalog_models.ids.is_empty(),
        "internal.toml [builtin_catalog_models].ids must be non-empty"
    );
    assert!(
        !config.builtin_catalog_models.defaults.is_empty(),
        "internal.toml [builtin_catalog_models].defaults must be non-empty"
    );
    for id in &config.builtin_catalog_models.ids {
        assert!(
            !id.trim().is_empty(),
            "internal.toml [builtin_catalog_models].ids entries must be non-empty"
        );
        assert_eq!(
            &normalized_model_id(id),
            id,
            "internal.toml [builtin_catalog_models].ids entries must be normalized (trimmed lowercase)"
        );
        assert!(
            config
                .builtin_catalog_models
                .defaults
                .iter()
                .any(|defaults| &defaults.model_id == id),
            "internal.toml builtin catalog model {id} must have a matching defaults entry"
        );
    }
    let mut seen_ids = std::collections::BTreeSet::new();
    for defaults in &config.builtin_catalog_models.defaults {
        assert!(
            !defaults.model_id.trim().is_empty(),
            "internal.toml builtin defaults model_id must be non-empty"
        );
        assert_eq!(
            &normalized_model_id(&defaults.model_id),
            &defaults.model_id,
            "internal.toml builtin defaults model_id must be normalized (trimmed lowercase)"
        );
        assert!(
            seen_ids.insert(defaults.model_id.clone()),
            "internal.toml builtin defaults model_id must not repeat: {}",
            defaults.model_id
        );
        assert!(
            !defaults.capabilities.is_empty(),
            "internal.toml builtin defaults {} must define capabilities",
            defaults.model_id
        );
        assert!(
            !defaults.reasoning_efforts.is_empty(),
            "internal.toml builtin defaults {} must define reasoning_efforts",
            defaults.model_id
        );
    }

    assert!(
        !config.hidden_models.exact.is_empty() || !config.hidden_models.prefixes.is_empty(),
        "internal.toml [hidden_models] must define exact or prefixes"
    );
    for id in &config.hidden_models.exact {
        assert!(
            !id.trim().is_empty(),
            "internal.toml [hidden_models].exact entries must be non-empty"
        );
        assert_eq!(
            &normalized_model_id(id),
            id,
            "internal.toml [hidden_models].exact entries must be normalized (trimmed lowercase)"
        );
    }
    for prefix in &config.hidden_models.prefixes {
        assert!(
            !prefix.trim().is_empty(),
            "internal.toml [hidden_models].prefixes entries must be non-empty"
        );
        assert_eq!(
            &normalized_model_id(prefix),
            prefix,
            "internal.toml [hidden_models].prefixes entries must be normalized (trimmed lowercase)"
        );
    }
}

/// 家族名 key（对应 `internal.toml` `[model_families]` 的 key）。
const GPT_FAMILY_KEY: &str = "gpt";

/// 模型 id 归一化：trim + 小写（配置资产统一存小写）。
fn normalized_model_id(model_id: &str) -> String {
    model_id.trim().to_ascii_lowercase()
}

/// 内置 Codex 目录模型清单（内部配置真源，来自 `internal.toml`）：路由组内
/// 存在对应模型引用时以 builtin 目录入口暴露（能力面构建内置条目元数据）；
/// 路由候选展开对 builtin 模型跳过 requested-model 过滤。
pub fn v3_builtin_catalog_model_ids() -> &'static [String] {
    &INTERNAL_CONFIG.builtin_catalog_models.ids
}

/// 内置 Codex 目录模型判定（`internal.toml` `[builtin_catalog_models]` 成员判定）。
pub fn is_v3_builtin_catalog_model(model_id: &str) -> bool {
    let normalized = normalized_model_id(model_id);
    v3_builtin_catalog_model_ids().contains(&normalized)
}

/// 内置目录模型的默认元数据查询（按 model_id 精确匹配，命中即内置预设）。
pub fn v3_builtin_model_defaults(model_id: &str) -> Option<&'static V3BuiltinModelDefaults> {
    let normalized = normalized_model_id(model_id);
    INTERNAL_CONFIG
        .builtin_catalog_models
        .defaults
        .iter()
        .find(|defaults| defaults.model_id == normalized)
}

/// 隐藏的 Codex 未来模型判定（`internal.toml` `[hidden_models]`）：不在任何
/// 模型目录 / 能力面暴露。
pub fn is_v3_hidden_codex_future_model(model_id: &str) -> bool {
    let normalized = normalized_model_id(model_id);
    INTERNAL_CONFIG.hidden_models.exact.contains(&normalized)
        || INTERNAL_CONFIG
            .hidden_models
            .prefixes
            .iter()
            .any(|prefix| normalized.starts_with(prefix))
}

/// gpt 家族模型判定（`internal.toml` `[model_families.gpt]`）：路由层特殊场景
/// （requested-model 过滤豁免）与 provider compat 面（hosted web_search 保留、
/// 响应密文保留）与配置校验面（gpt 系列自动补 text 能力）共用。判定数据真源
/// 在本层，路由 / 流水线 / 能力面节点只消费判定结果、不感知具体模型名。
/// Whether ordinary debug samples are suppressed unless explicitly forced by error evidence.
pub fn v3_error_samples_only() -> bool {
    INTERNAL_CONFIG.debug_samples.error_samples_only
}

/// HTTP statuses whose forced error evidence should not be persisted.
pub fn v3_error_sample_skip_statuses() -> &'static [u16] {
    &INTERNAL_CONFIG.debug_samples.error_sample_skip_statuses
}

pub fn is_v3_gpt_family_model(model_id: &str) -> bool {
    let normalized = normalized_model_id(model_id);
    let Some(family) = INTERNAL_CONFIG.model_families.get(GPT_FAMILY_KEY) else {
        return false;
    };
    family.exact.contains(&normalized)
        || family
            .prefix
            .as_deref()
            .is_some_and(|prefix| normalized.starts_with(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_sample_policy_is_internal_and_defaulted() {
        assert!(v3_error_samples_only());
        assert_eq!(v3_error_sample_skip_statuses(), &[401, 402, 403, 429, 503]);
    }

    #[test]
    fn internal_toml_is_valid_and_non_empty() {
        let config: InternalConfig =
            toml::from_str(INTERNAL_CONFIG_TOML).expect("embedded internal.toml must parse");
        validate_internal_config(&config);
        assert!(config.model_families.contains_key(GPT_FAMILY_KEY));
        assert!(!config.builtin_catalog_models.ids.is_empty());
        assert!(
            !config.hidden_models.exact.is_empty() || !config.hidden_models.prefixes.is_empty()
        );
    }

    #[test]
    fn invalid_internal_assets_fail_fast() {
        let missing_family: InternalConfig =
            toml::from_str("[builtin_catalog_models]\nids = [\"gpt-5.5\"]\n[hidden_models]\nexact = [\"gpt-5.6\"]\n")
                .expect("syntactically valid");
        let missing_builtin_defaults: InternalConfig =
            toml::from_str("[model_families.gpt]\nprefix = \"gpt-\"\n[builtin_catalog_models]\nids = [\"gpt-5.5\"]\n[hidden_models]\nexact = [\"gpt-5.6\"]\n")
                .expect("syntactically valid");
        let empty_ids: InternalConfig =
            toml::from_str("[model_families.gpt]\nprefix = \"gpt-\"\n[builtin_catalog_models]\nids = []\n[hidden_models]\nexact = [\"gpt-5.6\"]\n")
                .expect("syntactically valid");
        let missing_hidden: InternalConfig =
            toml::from_str("[model_families.gpt]\nprefix = \"gpt-\"\n[builtin_catalog_models]\nids = [\"gpt-5.5\"]\n")
                .expect("syntactically valid");
        let unnormalized_builtin_id: InternalConfig =
            toml::from_str("[model_families.gpt]\nprefix = \"gpt-\"\n[builtin_catalog_models]\nids = [\" GPT-5.5 \"]\n[[builtin_catalog_models.defaults]]\nmodel_id = \"gpt-5.5\"\ncapabilities = [\"text\"]\ndescription = \"x\"\ndefault_reasoning_level = \"medium\"\nreasoning_efforts = [\"low\"]\nminimal_client_version = \"0.98.0\"\n[hidden_models]\nexact = [\"gpt-5.6\"]\n")
                .expect("syntactically valid");
        let empty_reasoning_defaults: InternalConfig =
            toml::from_str("[model_families.gpt]\nprefix = \"gpt-\"\n[builtin_catalog_models]\nids = [\"gpt-5.5\"]\n[[builtin_catalog_models.defaults]]\nmodel_id = \"gpt-5.5\"\ncapabilities = [\"text\"]\ndescription = \"x\"\ndefault_reasoning_level = \"medium\"\nreasoning_efforts = []\nminimal_client_version = \"0.98.0\"\n[hidden_models]\nexact = [\"gpt-5.6\"]\n")
                .expect("syntactically valid");
        let duplicate_builtin_defaults: InternalConfig =
            toml::from_str("[model_families.gpt]\nprefix = \"gpt-\"\n[builtin_catalog_models]\nids = [\"gpt-5.5\"]\n[[builtin_catalog_models.defaults]]\nmodel_id = \"gpt-5.5\"\ncapabilities = [\"text\"]\ndescription = \"x\"\ndefault_reasoning_level = \"medium\"\nreasoning_efforts = [\"low\"]\nminimal_client_version = \"0.98.0\"\n[[builtin_catalog_models.defaults]]\nmodel_id = \"gpt-5.5\"\ncapabilities = [\"text\"]\ndescription = \"x\"\ndefault_reasoning_level = \"medium\"\nreasoning_efforts = [\"low\"]\nminimal_client_version = \"0.98.0\"\n[hidden_models]\nexact = [\"gpt-5.6\"]\n")
                .expect("syntactically valid");
        let empty_hidden_prefix: InternalConfig =
            toml::from_str("[model_families.gpt]\nprefix = \"gpt-\"\n[builtin_catalog_models]\nids = [\"gpt-5.5\"]\n[[builtin_catalog_models.defaults]]\nmodel_id = \"gpt-5.5\"\ncapabilities = [\"text\"]\ndescription = \"x\"\ndefault_reasoning_level = \"medium\"\nreasoning_efforts = [\"low\"]\nminimal_client_version = \"0.98.0\"\n[hidden_models]\nprefixes = [\"\"]\n")
                .expect("syntactically valid");
        for invalid in [
            missing_family,
            missing_builtin_defaults,
            empty_ids,
            missing_hidden,
            unnormalized_builtin_id,
            empty_reasoning_defaults,
            duplicate_builtin_defaults,
            empty_hidden_prefix,
        ] {
            let result = std::panic::catch_unwind(|| validate_internal_config(&invalid));
            assert!(
                result.is_err(),
                "semantically invalid internal asset must fail fast"
            );
        }
    }

    #[test]
    fn unknown_fields_and_missing_required_metadata_rejected() {
        let unknown_field = "[model_families.gpt]\nprefix = \"gpt-\"\nunknown_section = 1\n";
        assert!(
            toml::from_str::<InternalConfig>(unknown_field).is_err(),
            "unknown fields must be rejected"
        );
        let missing_description = "[model_families.gpt]\nprefix = \"gpt-\"\n[builtin_catalog_models]\nids = [\"gpt-5.5\"]\n[[builtin_catalog_models.defaults]]\nmodel_id = \"gpt-5.5\"\ncapabilities = [\"text\"]\nreasoning_efforts = [\"low\"]\n[hidden_models]\nexact = [\"gpt-5.6\"]\n";
        assert!(
            toml::from_str::<InternalConfig>(missing_description).is_err(),
            "defaults without description must fail deserialization"
        );
        let missing_client_version = "[model_families.gpt]\nprefix = \"gpt-\"\n[builtin_catalog_models]\nids = [\"gpt-5.5\"]\n[[builtin_catalog_models.defaults]]\nmodel_id = \"gpt-5.5\"\ncapabilities = [\"text\"]\ndescription = \"x\"\ndefault_reasoning_level = \"medium\"\nreasoning_efforts = [\"low\"]\n[hidden_models]\nexact = [\"gpt-5.6\"]\n";
        assert!(
            toml::from_str::<InternalConfig>(missing_client_version).is_err(),
            "defaults without minimal_client_version must fail deserialization"
        );
    }

    #[test]
    fn builtin_catalog_model_positive_and_negative() {
        assert!(is_v3_builtin_catalog_model("gpt-5.5"));
        assert!(is_v3_builtin_catalog_model(" gpt-5.5 "));
        assert!(is_v3_builtin_catalog_model("GPT-5.5"));
        assert!(!is_v3_builtin_catalog_model("gpt-5.6-sol"));
        assert!(!is_v3_builtin_catalog_model("gpt-4o"));
        assert!(!is_v3_builtin_catalog_model("deepseek-v4-flash"));
    }

    #[test]
    fn hidden_future_model_positive_and_negative() {
        assert!(is_v3_hidden_codex_future_model("gpt-5.6"));
        assert!(is_v3_hidden_codex_future_model("gpt-5.6-sol"));
        assert!(is_v3_hidden_codex_future_model("GPT-5.6-SOL"));
        assert!(!is_v3_hidden_codex_future_model("gpt-5.5"));
        assert!(!is_v3_hidden_codex_future_model("gpt-5.7"));
        assert!(!is_v3_hidden_codex_future_model("deepseek-v4-flash"));
    }

    #[test]
    fn gpt_family_model_positive_and_negative() {
        assert!(is_v3_gpt_family_model("gpt-5.5"));
        assert!(is_v3_gpt_family_model("gpt-5.6-sol"));
        assert!(is_v3_gpt_family_model(" gpt-4o "));
        assert!(is_v3_gpt_family_model("gpt"));
        assert!(is_v3_gpt_family_model("GPT-5.5"));
        assert!(!is_v3_gpt_family_model("deepseek-v4-flash"));
        assert!(!is_v3_gpt_family_model("minimax-m3"));
    }
}

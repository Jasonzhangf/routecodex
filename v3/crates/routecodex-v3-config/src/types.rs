use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3Config01FileSource {
    pub path: std::path::PathBuf,
    pub raw_toml: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3Config02AuthoringParsed {
    pub version: u16,
    pub servers: BTreeMap<String, V3ServerAuthoringConfig>,
    pub providers: BTreeMap<String, V3ProviderAuthoringConfig>,
    #[serde(default)]
    pub forwarders: BTreeMap<String, V3ForwarderAuthoringConfig>,
    pub route_groups: BTreeMap<String, V3RouteGroupAuthoringConfig>,
    #[serde(default)]
    pub features: BTreeMap<String, bool>,
    #[serde(default)]
    pub debug: V3DebugAuthoringConfig,
    #[serde(default)]
    pub error: V3ErrorAuthoringConfig,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3DebugAuthoringConfig {
    #[serde(default)]
    pub log_console: bool,
    #[serde(default)]
    pub log_file: Option<String>,
    #[serde(default)]
    pub snapshots: bool,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub retention: BTreeMap<String, u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3ErrorAuthoringConfig {
    #[serde(default)]
    pub policies: BTreeMap<String, V3ErrorPolicyAuthoringConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3ErrorPolicyAuthoringConfig {
    pub action: String,
    #[serde(default)]
    pub cooldown_ms: Option<u64>,
    #[serde(default)]
    pub max_attempts: Option<u32>,
}

#[derive(Debug, Clone)]
pub struct V3Config03SchemaValidated {
    pub authoring: V3Config02AuthoringParsed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3ServerAuthoringConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub bind: String,
    pub port: u16,
    pub routing_group: String,
    #[serde(default = "default_responses_endpoint")]
    pub endpoints: Vec<String>,
    #[serde(default)]
    pub features: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3ProviderAuthoringConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(rename = "type")]
    pub provider_type: String,
    pub base_url: String,
    pub default_model: String,
    pub auth: V3ProviderAuthAuthoringConfig,
    pub models: BTreeMap<String, V3ProviderModelAuthoringConfig>,
    #[serde(default)]
    pub responses: Option<V3ProviderResponsesAuthoringConfig>,
    #[serde(default)]
    pub concurrency: Option<V3ProviderConcurrencyAuthoringConfig>,
    #[serde(default)]
    pub features: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3ProviderAuthAuthoringConfig {
    #[serde(rename = "type")]
    pub auth_type: V3ProviderAuthType,
    pub entries: Vec<V3ProviderAuthEntryAuthoringConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum V3ProviderAuthType {
    #[serde(alias = "apikey")]
    ApiKey,
    OAuth,
    TokenFile,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3ProviderAuthEntryAuthoringConfig {
    pub alias: String,
    #[serde(default)]
    pub env: Option<String>,
    #[serde(default)]
    pub token_file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3ProviderModelAuthoringConfig {
    #[serde(default)]
    pub wire_name: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub supports_streaming: bool,
    #[serde(default)]
    pub supports_thinking: bool,
    #[serde(default)]
    pub thinking: Option<String>,
    #[serde(default)]
    pub max_tokens: Option<u64>,
    #[serde(default)]
    pub max_context_tokens: Option<u64>,
    #[serde(default)]
    pub features: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct V3ProviderResponsesAuthoringConfig {
    pub process: String,
    pub streaming: V3StreamingPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum V3StreamingPolicy {
    Always,
    Client,
    Never,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct V3ProviderConcurrencyAuthoringConfig {
    pub max_in_flight: u32,
    pub acquire_timeout_ms: u64,
    pub stale_lease_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3ForwarderAuthoringConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub model: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub selection: V3SelectionPolicy,
    pub targets: Vec<V3ForwarderTargetAuthoringConfig>,
    #[serde(default)]
    pub features: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3ForwarderTargetAuthoringConfig {
    #[serde(default)]
    pub kind: V3RouteTargetKind,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub priority: Option<i32>,
    #[serde(default)]
    pub weight: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3RouteGroupAuthoringConfig {
    pub pools: BTreeMap<String, V3RoutePoolAuthoringConfig>,
    #[serde(default)]
    pub features: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3RoutePoolAuthoringConfig {
    #[serde(default)]
    pub selection: V3SelectionPolicy,
    pub targets: Vec<V3RoutePoolTargetAuthoringConfig>,
    #[serde(default)]
    pub features: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct V3RoutePoolTargetAuthoringConfig {
    pub kind: V3RouteTargetKind,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub priority: Option<i32>,
    #[serde(default)]
    pub weight: Option<u32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum V3RouteTargetKind {
    #[default]
    ProviderModel,
    Forwarder,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct V3SelectionPolicy {
    pub strategy: V3SelectionStrategy,
}

impl Default for V3SelectionPolicy {
    fn default() -> Self {
        Self {
            strategy: V3SelectionStrategy::Priority,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum V3SelectionStrategy {
    Priority,
    Weighted,
    RoundRobin,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3Config04ResourceRegistryBuilt {
    pub version: u16,
    pub servers: BTreeMap<String, V3ServerManifest>,
    pub providers: BTreeMap<String, V3ProviderManifest>,
    pub forwarders: BTreeMap<String, V3ForwarderManifest>,
    pub route_groups: BTreeMap<String, V3RouteGroupManifest>,
    pub features: BTreeMap<String, bool>,
    pub debug: V3DebugManifest,
    pub error: V3ErrorManifest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3Config05ManifestPublished {
    pub version: u16,
    pub servers: BTreeMap<String, V3ServerManifest>,
    pub providers: BTreeMap<String, V3ProviderManifest>,
    pub forwarders: BTreeMap<String, V3ForwarderManifest>,
    pub route_groups: BTreeMap<String, V3RouteGroupManifest>,
    pub features: BTreeMap<String, bool>,
    pub debug: V3DebugManifest,
    pub error: V3ErrorManifest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ServerManifest {
    pub id: String,
    pub enabled: bool,
    pub bind: String,
    pub port: u16,
    pub routing_group: String,
    pub endpoints: Vec<String>,
    pub features: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderManifest {
    pub id: String,
    pub enabled: bool,
    pub provider_type: String,
    pub base_url: String,
    pub default_model: String,
    pub auth: V3ProviderAuthManifest,
    pub models: BTreeMap<String, V3ProviderModelManifest>,
    pub responses: Option<V3ProviderResponsesAuthoringConfig>,
    pub concurrency: Option<V3ProviderConcurrencyAuthoringConfig>,
    pub features: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderAuthManifest {
    pub auth_type: V3ProviderAuthType,
    pub entries: Vec<V3ProviderAuthEntryManifest>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderAuthEntryManifest {
    pub alias: String,
    pub env: Option<String>,
    pub token_file: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ProviderModelManifest {
    pub id: String,
    pub wire_name: String,
    pub aliases: Vec<String>,
    pub capabilities: Vec<String>,
    pub supports_streaming: bool,
    pub supports_thinking: bool,
    pub thinking: Option<String>,
    pub max_tokens: Option<u64>,
    pub max_context_tokens: Option<u64>,
    pub features: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ForwarderManifest {
    pub id: String,
    pub enabled: bool,
    pub model: String,
    pub aliases: Vec<String>,
    pub selection: V3SelectionPolicy,
    pub targets: Vec<V3ForwarderTargetManifest>,
    pub features: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ForwarderTargetManifest {
    pub kind: V3RouteTargetKind,
    pub id: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub key: Option<String>,
    pub priority: Option<i32>,
    pub weight: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3DebugManifest {
    pub log_console: bool,
    pub log_file: Option<String>,
    pub snapshots: bool,
    pub dry_run: bool,
    pub retention: BTreeMap<String, u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ErrorManifest {
    pub policies: BTreeMap<String, V3ErrorPolicyManifest>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3ErrorPolicyManifest {
    pub action: String,
    pub cooldown_ms: Option<u64>,
    pub max_attempts: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3RouteGroupManifest {
    pub id: String,
    pub pools: BTreeMap<String, V3RoutePoolManifest>,
    pub features: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3RoutePoolManifest {
    pub id: String,
    pub selection: V3SelectionPolicy,
    pub targets: Vec<V3RoutePoolTargetManifest>,
    pub features: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3RoutePoolTargetManifest {
    pub kind: V3RouteTargetKind,
    pub id: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub key: Option<String>,
    pub priority: Option<i32>,
    pub weight: Option<u32>,
}

fn default_true() -> bool {
    true
}

fn default_responses_endpoint() -> Vec<String> {
    vec!["responses".to_string()]
}
